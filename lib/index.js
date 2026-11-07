/**
 * dsh-compaction-counter — host half.
 *
 * Registers a client-visible `compactionStats` session projection that reports
 * how many times context compaction was triggered in a Session.
 *
 * Why this is not a plain event fold: a projection unit registered after a
 * Session's checkpoint was written starts from `init` and only sees events
 * that reach it afterwards. For an older Session that is already attached (or
 * restored from a partial window), the compaction events that happened before
 * the plugin existed are not in that fold, so the unit would report 0.
 *
 * This plugin therefore keeps a process-wide backfill table keyed by Session
 * id. On activation it scans the durable Session logs once (and later only
 * files whose size/mtime changed), counting compaction events directly from
 * the complete log. The projection's wire view merges that backfill with the
 * live fold via `max`, so:
 * - old Sessions show their historical counts immediately;
 * - a live Session that only sees a tail window never reports less than the
 *   historical count;
 * - new compactions are still counted live by `apply`.
 *
 * Counted event vocabulary (see @deepseek-ai/dsh-compaction):
 * - `compaction/start`   one per triggered compaction transaction (automatic
 *                        or manual `/compact`); the trigger authority.
 * - `compaction/summary` the replacement summary landed (records its size).
 * - `compaction/end`     the transaction closed; `data.error` marks failure.
 * - `compaction/prune`   individual shadowed tool results, counted separately
 *                        and never shown as a "context compacted" event.
 *
 * @module dsh-compaction-counter
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name. */
export const name = 'compaction-counter'

/** The projection registry is the whole purpose of this plugin. */
export const inject = ['sessionProjections']

/** Projection key read by the browser half through `useProjection`. */
export const PROJECTION_KEY = 'compactionStats'

/** Bump when the state fields or the fold semantics change. */
const STATE_VERSION = 3

/** Fold-state counters. */
const STATE_COUNTERS = Object.freeze(['triggers', 'completed', 'failed', 'manual', 'prunes', 'warm', 'seenRev'])
const STATE_TIMES = Object.freeze(['lastStartAt', 'lastEndAt'])

/** Wire-view counters and timestamps. */
const VIEW_COUNTERS = Object.freeze(['count', 'completed', 'failed', 'manual', 'warm'])
const VIEW_TIMES = Object.freeze(['lastAt', 'lastFinishedAt'])

/** Longest failure chain echoed through the wire view. */
const MAX_ERROR_LENGTH = 300

/** Delay before the first backfill, letting boot settle. */
const BACKFILL_DELAY_MS = 750

/** Bump when the log-scan semantics change, forcing existing tables to rescan. */
const SCAN_VERSION = 4

/**
 * Process-wide backfill table. It survives client-plugin HMR reloads of this
 * module because the host module instance may be replaced while the process
 * keeps running.
 */
const BACKFILL_KEY = Symbol.for('dsh-compaction-counter.backfill')
const backfill = (globalThis[BACKFILL_KEY] ??= {
	/** @type {Map<string, ReturnType<typeof blankStats>>} */
	stats: new Map(),
	/** @type {Map<string, { mtimeMs: number, size: number }>} */
	files: new Map(),
	/** Monotonic revision: a live cell that sees a newer one republishes. */
	rev: 0,
	scanning: false,
	scanVersion: 0,
})

// A reloaded module may find a table produced by older scan semantics; drop it
// rather than trusting zeroed tallies that were cached with stale file stats.
if (backfill.scanVersion !== SCAN_VERSION) {
	backfill.stats.clear()
	backfill.files.clear()
	backfill.rev = 0
	backfill.scanning = false
	backfill.scanVersion = SCAN_VERSION
}

/**
 * Create one strict-but-minimal schema object. The projection registry only
 * calls `parse`, so a hand-written validator keeps this plugin dependency-free
 * (no zod in the profile) while still validating checkpoints and wire views.
 *
 * @param {readonly string[]} counters - non-negative integer fields.
 * @param {readonly string[]} times - non-negative finite number fields.
 * @param {readonly string[]} strings - string fields.
 * @param {boolean} withTokens - whether `lastTokens` is part of the shape.
 * @returns {{ parse: (value: unknown) => any }} schema facade.
 */
function schemaOf(counters, times, strings, withTokens) {
	return {
		parse(value) {
			if (value === null || typeof value !== 'object' || Array.isArray(value)) {
				throw new TypeError(`${PROJECTION_KEY}: projected value must be an object`)
			}
			for (const field of counters) {
				const count = value[field]
				if (!Number.isSafeInteger(count) || count < 0) {
					throw new TypeError(`${PROJECTION_KEY}.${field} must be a non-negative integer`)
				}
			}
			for (const field of times) {
				const time = value[field]
				if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
					throw new TypeError(`${PROJECTION_KEY}.${field} must be a non-negative finite number`)
				}
			}
			if (withTokens) {
				const tokens = value.lastTokens
				if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) {
					throw new TypeError(`${PROJECTION_KEY}.lastTokens must be a non-negative finite number`)
				}
			}
			for (const field of strings) {
				if (typeof value[field] !== 'string') {
					throw new TypeError(`${PROJECTION_KEY}.${field} must be a string`)
				}
			}
			return value
		},
	}
}

/** Fold-state schema (checkpoint input boundary). */
const stateSchema = schemaOf(STATE_COUNTERS, STATE_TIMES, ['lastError', 'sessionId'], true)

/** Client view schema (wire output boundary). */
const viewSchema = schemaOf(VIEW_COUNTERS, VIEW_TIMES, ['lastError'], true)

/**
 * Turn an optional projection timestamp into a safe non-negative number.
 * @param {unknown} value - candidate event timestamp.
 * @param {number} fallback - previous value.
 * @returns {number} the accepted timestamp or the previous one.
 */
function timeOf(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Normalize a compaction failure payload (the engine records a rendered error
 * chain string) into a short, JSON-safe tooltip fragment.
 * @param {unknown} error - `compaction/end` error payload.
 * @returns {string} at most {@link MAX_ERROR_LENGTH} characters.
 */
function errorText(error) {
	if (typeof error === 'string') return error.slice(0, MAX_ERROR_LENGTH)
	if (error !== null && typeof error === 'object') {
		const message = error.message
		if (typeof message === 'string' && message !== '') return message.slice(0, MAX_ERROR_LENGTH)
		const label = error.name
		if (typeof label === 'string' && label !== '') return label.slice(0, MAX_ERROR_LENGTH)
	}
	return 'compaction failed'
}

/** Blank tally shared by the live fold and the log backfill. */
function blankStats() {
	return {
		triggers: 0,
		completed: 0,
		failed: 0,
		manual: 0,
		prunes: 0,
		lastStartAt: 0,
		lastEndAt: 0,
		lastTokens: 0,
		lastError: '',
	}
}

/** Initial fold state. `init` receives the Session header, which names it. */
function initialState(header) {
	return {
		...blankStats(),
		sessionId: typeof header?.id === 'string' ? header.id : '',
		warm: 0,
		seenRev: 0,
	}
}

/**
 * Fold one compaction event into a tally. Returns the same tally reference for
 * events that do not concern this unit.
 * @param {ReturnType<typeof blankStats>} state - previous tally.
 * @param {{ type: string, time?: number, data?: any }} event - committed event.
 * @returns {ReturnType<typeof blankStats>} the next tally.
 */
function foldCompaction(state, event) {
	switch (event.type) {
		case 'compaction/start': {
			const data = event.data ?? {}
			const manual = typeof data.sourceCommandId === 'string' && data.sourceCommandId !== ''
			return {
				...state,
				triggers: state.triggers + 1,
				manual: state.manual + (manual ? 1 : 0),
				lastStartAt: timeOf(event.time, state.lastStartAt),
				lastError: '',
			}
		}
		case 'compaction/summary': {
			const data = event.data ?? {}
			const tokens = data.shadowedTokenCount
			if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return state
			if (tokens === state.lastTokens) return state
			return { ...state, lastTokens: tokens }
		}
		case 'compaction/end': {
			const data = event.data ?? {}
			const failed = data.error !== undefined && data.error !== null
			return {
				...state,
				completed: state.completed + (failed ? 0 : 1),
				failed: state.failed + (failed ? 1 : 0),
				lastEndAt: timeOf(event.time, state.lastEndAt),
				lastError: failed ? errorText(data.error) : '',
			}
		}
		case 'compaction/prune':
			return { ...state, prunes: state.prunes + 1 }
		default:
			return state
	}
}

/**
 * Apply one parsed compaction event to a backfill tally.
 * @param {ReturnType<typeof blankStats>} stats - mutable tally.
 * @param {{ type: string, time?: number, data?: any }} event - log event.
 */
function applyBackfillEvent(stats, event) {
	switch (event.type) {
		case 'compaction/start': {
			const data = event.data ?? {}
			stats.triggers += 1
			if (typeof data.sourceCommandId === 'string' && data.sourceCommandId !== '') stats.manual += 1
			stats.lastStartAt = timeOf(event.time, stats.lastStartAt)
			stats.lastError = ''
			break
		}
		case 'compaction/summary': {
			const data = event.data ?? {}
			const tokens = data.shadowedTokenCount
			if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) stats.lastTokens = tokens
			break
		}
		case 'compaction/end': {
			const data = event.data ?? {}
			const failed = data.error !== undefined && data.error !== null
			if (failed) stats.failed += 1
			else stats.completed += 1
			stats.lastEndAt = timeOf(event.time, stats.lastEndAt)
			stats.lastError = failed ? errorText(data.error) : ''
			break
		}
		case 'compaction/prune':
			stats.prunes += 1
			break
		default:
			break
	}
}

/**
 * Resolve the durable Session log root. The launcher provides `dshHomePath`;
 * the environment is the fallback for assemblies that do not.
 * @param {any} ctx - host plugin context.
 * @returns {string} absolute sessions root.
 */
function sessionsRoot(ctx) {
	try {
		const fn = typeof ctx?.dshHomePath === 'function' ? ctx.dshHomePath : ctx?.get?.('dshHomePath')
		if (typeof fn === 'function') return fn('sessions')
	} catch {}
	const home = process.env.DSH_HOME || join(homedir(), '.dsh')
	return join(home, 'sessions')
}

/**
 * Enumerate durable Session logs below the sessions root.
 * @param {string} root - sessions root.
 * @returns {Promise<Array<{ id: string, file: string, mtimeMs: number, size: number }>>} logs, newest first.
 */
async function findLogs(root) {
	const logs = []
	let workspaces
	try {
		workspaces = await readdir(root, { withFileTypes: true })
	} catch {
		return logs
	}
	for (const workspace of workspaces) {
		if (!workspace.isDirectory() || workspace.name.startsWith('.')) continue
		const workspaceDir = join(root, workspace.name)
		let sessions
		try {
			sessions = await readdir(workspaceDir, { withFileTypes: true })
		} catch {
			continue
		}
		for (const session of sessions) {
			if (!session.isDirectory()) continue
			const sessionDir = join(workspaceDir, session.name)
			let files
			try {
				files = await readdir(sessionDir, { withFileTypes: true })
			} catch {
				continue
			}
			for (const file of files) {
				if (!file.isFile() || !/^session\..*\.jsonl(\.zstd)?$/.test(file.name)) continue
				const path = join(sessionDir, file.name)
				try {
					const info = await stat(path)
					logs.push({ id: session.name, file: path, mtimeMs: info.mtimeMs, size: info.size })
				} catch {}
			}
		}
	}
	logs.sort((left, right) => right.mtimeMs - left.mtimeMs)
	return logs
}

/**
 * Incrementally backfill the process-wide tally table from complete Session
 * logs. `sessionQuery.readSession` owns the multi-frame zstd log format, so
 * this plugin never decodes storage internals itself. Files already seen with
 * the same size and mtime are skipped, so later passes are cheap.
 * @param {any} scope - context carrying `sessionQuery` (and optionally a logger).
 */
async function scanLogs(scope) {
	if (backfill.scanning) return
	const query = scope?.sessionQuery ?? scope?.get?.('sessionQuery')
	if (query === undefined || typeof query.readSession !== 'function') return
	backfill.scanning = true
	let scanned = 0
	let changed = 0
	try {
		const logs = await findLogs(sessionsRoot(scope))
		for (const log of logs) {
			const known = backfill.files.get(log.id)
			if (known !== undefined && known.mtimeMs === log.mtimeMs && known.size === log.size) continue
			scanned += 1
			let loaded
			try {
				loaded = await query.readSession(log.id)
			} catch {
				await new Promise((resolve) => setImmediate(resolve))
				continue
			}
			const stats = blankStats()
			const inherited = typeof loaded?.inheritedEventCount === 'number' ? loaded.inheritedEventCount : 0
			for (const event of loaded?.events ?? []) {
				if (event === null || typeof event !== 'object' || typeof event.type !== 'string' || !event.type.startsWith('compaction/')) continue
				// A forked Session counts its own compactions, not the inherited prefix.
				if (inherited > 0 && typeof event.seq === 'number' && event.seq < inherited) continue
				applyBackfillEvent(stats, event)
			}
			backfill.stats.set(log.id, stats)
			backfill.files.set(log.id, { mtimeMs: log.mtimeMs, size: log.size })
			backfill.rev += 1
			changed += 1
			await new Promise((resolve) => setImmediate(resolve))
		}
		if (changed > 0) {
			try {
				scope.logger?.info?.(`compaction-counter: backfilled ${changed}/${scanned} session logs (${backfill.stats.size} known)`)
			} catch {}
		}
	} catch (error) {
		try {
			scope.logger?.warn?.(`compaction-counter: backfill failed: ${String(error)}`)
		} catch {}
	} finally {
		backfill.scanning = false
	}
}

/**
 * Merge the live fold with the backfilled tally for the same Session. Both
 * sides count from the start of the log, so `max` is the correct combination:
 * it never double-counts and never reports less than the complete log.
 * @param {ReturnType<typeof initialState>} state - live fold state.
 * @returns {object} client view.
 */
function viewOf(state) {
	const base = backfill.stats.get(state.sessionId)
	const baseLast = base?.lastStartAt ?? 0
	const newer = base !== undefined && baseLast > state.lastStartAt ? base : state
	return {
		count: Math.max(state.triggers, base?.triggers ?? 0),
		completed: Math.max(state.completed, base?.completed ?? 0),
		failed: Math.max(state.failed, base?.failed ?? 0),
		manual: Math.max(state.manual, base?.manual ?? 0),
		warm: state.warm,
		lastAt: Math.max(state.lastStartAt, baseLast),
		lastFinishedAt: Math.max(state.lastEndAt, base?.lastEndAt ?? 0),
		lastTokens: newer.lastTokens ?? 0,
		lastError: newer.lastError ?? '',
	}
}

/**
 * The `compactionStats` projection unit.
 *
 * Unrelated events normally return the same state reference, so the registry's
 * `Object.is` gate keeps the change feed quiet. Two exceptions publish:
 * - `warm` flips once after registration, so an already-open page learns the
 *   key without a reload;
 * - `seenRev` follows the backfill revision, so a live Session republishes
 *   once the log scan has produced its historical count.
 */
export const compactionStatsProjection = {
	key: PROJECTION_KEY,
	stateVersion: STATE_VERSION,
	stateSchema,
	init: (header) => initialState(header),
	apply: (state, event) => {
		const folded = foldCompaction(state, event)
		if (folded !== state) return folded
		if (state.seenRev !== backfill.rev) return { ...state, seenRev: backfill.rev }
		return state.warm === 0 ? { ...state, warm: 1 } : state
	},
	wire: {
		viewSchema,
		view: viewOf,
	},
}

/**
 * Register the unit and start the background backfill.
 * @param {any} ctx - host plugin context.
 */
export function apply(ctx) {
	ctx.sessionProjections.register(compactionStatsProjection)
	const schedule = (scope) => {
		const timer = setTimeout(() => {
			void scanLogs(scope)
		}, BACKFILL_DELAY_MS)
		timer.unref?.()
		return timer
	}
	if (typeof ctx.inject === 'function') {
		ctx.inject(['sessionQuery'], (child) => {
			const timer = schedule(child)
			return () => clearTimeout(timer)
		})
	} else {
		schedule(ctx)
	}
}

/**
 * Diagnostics for tests and troubleshooting: a read-only view of the backfill
 * table and a way to run the scan on demand.
 */
export const backfillDiagnostics = {
	state: backfill,
	scan: scanLogs,
}