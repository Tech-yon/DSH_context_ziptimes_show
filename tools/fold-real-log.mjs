/**
 * Fold a real (already decompressed) Session v4 JSONL log through the
 * `compactionStats` unit and compare its view with direct event tallies.
 *
 *   electron-as-node tools/fold-real-log.mjs <session.jsonl> <result.json>
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { compactionStatsProjection } from '../lib/index.js'

const input = process.argv[2]
const output = process.argv[3]
const definition = compactionStatsProjection

let state = definition.init({}, 0)
const direct = { start: 0, end: 0, failedEnd: 0, summary: 0, prune: 0 }
let lines = 0
let parsed = 0

for (const line of readFileSync(input, 'utf8').split('\n')) {
  lines += 1
  if (line.trim() === '') continue
  const event = JSON.parse(line)
  parsed += 1
  if (event.type === 'compaction/start') direct.start += 1
  else if (event.type === 'compaction/end') {
    direct.end += 1
    if (event.data && event.data.error !== undefined && event.data.error !== null) direct.failedEnd += 1
  } else if (event.type === 'compaction/summary') direct.summary += 1
  else if (event.type === 'compaction/prune') direct.prune += 1
  state = definition.apply(state, event)
}

const view = definition.wire.view(state)
definition.stateSchema.parse(state)
definition.wire.viewSchema.parse(view)

writeFileSync(
  output,
  JSON.stringify(
    {
      lines,
      parsed,
      direct,
      view,
      consistent:
        view.count === direct.start &&
        view.completed === direct.end - direct.failedEnd &&
        view.failed === direct.failedEnd &&
        direct.prune === state.prunes &&
        direct.summary > 0 === (view.lastTokens > 0),
    },
    null,
    2,
  ),
)
process.exitCode = 0