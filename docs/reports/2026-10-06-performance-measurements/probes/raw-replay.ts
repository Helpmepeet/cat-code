/**
 * Raw-message log admission for one replayed history burst, folded the way a
 * restore is: one `batch(...)` through `withBatch(reduceServerFrame)`.
 */
import { createRawMessageLogState, reduceServerFrame } from '../../../../app/renderer/src/rawMessageLog.js'
import { batch, withBatch } from '../../../../app/renderer/src/serverFrameBatch.js'
import { messageFrames, readyFrame } from '../fixtures.js'
import { emit, probeConfig, repeat, summarize, type CaseResult } from '../timing.js'

const config = probeConfig()
const cases: CaseResult[] = []
const reduce = withBatch(reduceServerFrame)

// 4,000 is the sidecar's single-attach history frame cap; 8,000 is the raw
// log's retention cap and a stress case only.
const COUNTS = config.smoke ? [200] : [500, 1_000, 2_000, 3_000, 4_000, 8_000]
// Two text sizes: the report's small fixture, and roughly the historical p50
// finished-message size quoted in `replayBuffer.ts`.
const TEXT_SIZES = config.smoke ? [300] : [300, 1_300]

for (const textCharacters of TEXT_SIZES) {
  for (const count of COUNTS) {
    const frames = messageFrames(count, textCharacters, { replay: true })
    const seeded = reduce(createRawMessageLogState(), readyFrame() as never)
    let retained = 0
    cases.push(summarize(`fresh-replay/${textCharacters}-chars/${count}`, { count, textCharacters }, repeat(config, () => {
      const start = performance.now()
      const state = reduce(seeded, batch(frames) as never)
      const ms = performance.now() - start
      retained = Object.values(state.sessions)[0]?.messages.length ?? 0
      return ms
    }), { retainedMessages: retained }))

    const filled = reduce(seeded, batch(frames) as never)
    cases.push(summarize(`duplicate-replay/${textCharacters}-chars/${count}`, { count, textCharacters }, repeat(config, () => {
      const start = performance.now()
      reduce(filled, batch(frames) as never)
      return performance.now() - start
    })))
  }
}

emit('raw-replay', cases, [
  'Reducer work only; transcript projection, React commits and IPC are not included.',
])
