/**
 * Self-test for dsh-compaction-counter.
 *
 * Runs the host projection fold over synthetic compaction events and
 * materializes the browser bundle against stub loader/React/context objects.
 * Designed to run under the bundled Electron-as-Node binary, whose stdout is
 * not captured on Windows: the summary is written to the path in argv[2].
 *
 *   electron-as-node tools/selftest.mjs <result.json>
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const results = { ok: false, checks: [], error: null }

function check(name, fn) {
  try {
    fn()
    results.checks.push({ name, ok: true })
  } catch (error) {
    results.checks.push({ name, ok: false, message: String(error && error.message ? error.message : error) })
    throw error
  }
}

try {
  const host = await import(new URL('../lib/index.js', import.meta.url).href)

  check('host exports plugin metadata', () => {
    assert.equal(host.name, 'compaction-counter')
    assert.deepEqual([...host.inject], ['sessionProjections'])
    assert.equal(host.compactionStatsProjection.key, 'compactionStats')
    assert.equal(host.compactionStatsProjection.stateVersion, 3)
  })

  check('host registers exactly one projection unit', () => {
    const registered = []
    host.apply({
      sessionProjections: { register: (definition) => registered.push(definition) },
      dshHomePath: () => 'C:\\dsh-compaction-counter-selftest-no-sessions',
      logger: { info: () => {}, warn: () => {} },
    })
    assert.equal(registered.length, 1)
    assert.equal(registered[0], host.compactionStatsProjection)
  })

  const definition = host.compactionStatsProjection
  const at = (ms) => 1_700_000_000_000 + ms

  const events = [
    { type: 'session/title', time: at(0) },
    { type: 'compaction/prune', time: at(10), data: { shadowedTokenCount: 1200 } },
    { type: 'compaction/start', time: at(100), data: { compactionId: 'a', turn: 1 } },
    { type: 'compaction/summary', time: at(200), data: { compactionId: 'a', shadowedTokenCount: 12_345 } },
    { type: 'compaction/end', time: at(210), data: { compactionId: 'a', turn: 1 } },
    { type: 'compaction/start', time: at(300), data: { compactionId: 'b', turn: 2, sourceCommandId: 'cmd-1' } },
    { type: 'compaction/end', time: at(310), data: { compactionId: 'b', turn: 2, error: 'summary model failed' } },
    { type: 'tool/call', time: at(400), data: {} },
  ]

  const folded = events.reduce((state, event) => definition.apply(state, event), definition.init({ id: 'session-test' }, 0))
  const view = definition.wire.view(folded)

  check('fold counts automatic + manual triggers and outcomes', () => {
    assert.deepEqual(view, {
      count: 2,
      completed: 1,
      failed: 1,
      manual: 1,
      warm: 1,
      lastAt: at(300),
      lastFinishedAt: at(310),
      lastTokens: 12_345,
      lastError: 'summary model failed',
    })
  })

  check('backfilled history merges into a live view for older sessions', () => {
    host.backfillDiagnostics.state.stats.set('session-old', {
      triggers: 19,
      completed: 19,
      failed: 0,
      manual: 0,
      prunes: 6,
      lastStartAt: at(900),
      lastEndAt: at(950),
      lastTokens: 5000,
      lastError: '',
    })
    const merged = definition.wire.view(definition.init({ id: 'session-old' }, 0))
    assert.equal(merged.count, 19)
    assert.equal(merged.completed, 19)
    assert.equal(merged.warm, 0)
    host.backfillDiagnostics.state.stats.delete('session-old')
  })

  check('the first unrelated event warms the value once, then state is stable', () => {
    const initial = definition.init({}, 0)
    const warmed = definition.apply(initial, { type: 'assistant/message', time: at(1), data: {} })
    assert.notEqual(warmed, initial)
    assert.equal(warmed.warm, 1)
    assert.equal(warmed.triggers, 0)
    assert.equal(definition.apply(warmed, { type: 'tool/result', time: at(2), data: { message: { source: { callId: 'x' } } } }), warmed)
  })

  check('state and view schemas accept the folded shapes and reject corruption', () => {
    assert.equal(definition.stateSchema.parse(folded), folded)
    assert.equal(definition.wire.viewSchema.parse(view), view)
    assert.throws(() => definition.stateSchema.parse({ ...folded, triggers: -1 }))
    assert.throws(() => definition.wire.viewSchema.parse({ ...view, count: 1.5 }))
    assert.throws(() => definition.wire.viewSchema.parse({ ...view, lastAt: Number.NaN }))
    assert.throws(() => definition.stateSchema.parse({ ...folded, lastError: 42 }))
  })

  // ── Browser half ──────────────────────────────────────────────────────────
  const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  let loaderRequest = null

  const documentStub = {
    head: { appendChild: () => {} },
    createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
  }
  const windowStub = {
    __ModuleLoader__: {
      load: (request) => {
        loaderRequest = request
      },
    },
  }

  // eslint-disable-next-line no-new-func
  new Function('window', 'document', clientSource)(windowStub, documentStub)

  check('client bundle registers the package id', () => {
    assert.ok(loaderRequest, 'loader.load was not called')
    assert.equal(loaderRequest.id, 'dsh-compaction-counter')
    assert.equal(typeof loaderRequest.factory, 'function')
  })

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  }
  const client = loaderRequest.factory((request) => {
    assert.equal(request, 'react')
    return React
  })

  check('client exports a Cordis plugin', () => {
    assert.equal(client.name, 'compaction-counter')
    assert.deepEqual([...client.inject], ['slots', 'locale'])
    assert.equal(typeof client.apply, 'function')
  })

  const dictionaries = {}
  const registrations = []
  const styles = []
  const disposers = []

  const locale = {
    register: (namespace, dict) => {
      dictionaries[namespace] = dict
      return () => {}
    },
    bind: () => null,
  }
  const slots = {
    inject: (slotName, contribute) => {
      assert.equal(slotName, 'conversation.composer.dock')
      disposers.push(contribute())
      return () => {}
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  }

  const ctx = {
    effect: (factory) => {
      const iterator = factory()
      let step = iterator.next()
      while (!step.done) {
        if (typeof step.value === 'function') disposers.push(step.value)
        step = iterator.next()
      }
    },
    locale,
    slots,
  }

  documentStub.createElement = () => {
    const style = { dataset: {}, textContent: '', remove: () => {} }
    styles.push(style)
    return style
  }

  check('client registers locale, style, and one dock entry', () => {
    client.apply(ctx)
    assert.ok(dictionaries['dsh-compaction-counter'], 'locale dictionary missing')
    assert.ok(dictionaries['dsh-compaction-counter'].zh.label, 'zh dictionary missing')
    assert.ok(dictionaries['dsh-compaction-counter'].en.label, 'en dictionary missing')
    assert.equal(styles.length, 1, 'style tag missing')
    assert.equal(registrations.length, 1, 'dock entry missing')
    const [{ options, component }] = registrations
    assert.equal(options.name, 'conversation.composer.dock')
    assert.equal(options.id, 'compaction-counter')
    assert.equal(options.order, 2)
    assert.equal(options.locale, 'dsh-compaction-counter')
    assert.equal(typeof component, 'function')
    assert.match(styles[0].textContent, /order:1/)
  })

  const t = (key, params) => {
    let text = dictionaries['dsh-compaction-counter'].zh[key]
    if (text === undefined) return key
    for (const [name, value] of Object.entries(params ?? {})) {
      text = text.split('{' + name + '}').join(String(value))
    }
    return text
  }

  const Component = registrations[0].component

  check('component renders the localized count and a detailed title', () => {
    const element = Component({ useProjection: (key) => (key === 'compactionStats' ? view : undefined), t })
    assert.equal(element.type, 'span')
    assert.equal(element.props['data-compaction-count'], '2')
    assert.equal(element.props.title.split('\n')[0], '本会话上下文压缩：共触发 2 次（成功 1，失败 1，手动 1）')
    assert.match(element.props.title, /上次压缩约 12\.3k tokens/)
    assert.match(element.props.title, /上次失败：summary model failed/)
    assert.equal(element.children[0], '压缩 2 次')
  })

  check('component hides itself until the projection arrives', () => {
    assert.equal(Component({ useProjection: () => undefined, t }), null)
  })

  check('component shows the empty hint before the first compaction', () => {
    const zero = { ...view, count: 0, completed: 0, failed: 0, manual: 0, lastAt: 0, lastTokens: 0, lastError: '' }
    const element = Component({ useProjection: () => zero, t })
    assert.equal(element.children[0], '压缩 0 次')
    assert.equal(element.props.title, '本会话尚未触发上下文压缩')
  })

  results.ok = true
} catch (error) {
  results.error = String(error && error.stack ? error.stack : error)
}

const output = process.argv[2]
const text = JSON.stringify(results, null, 2)
if (output) writeFileSync(output, text)
process.exitCode = results.ok ? 0 : 1
void text