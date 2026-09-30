/** Persist one output through the real engine storage owner without a model turn. */
import { init } from '../../src/entrypoints/init.js'
import { switchSession } from '../../src/bootstrap/state.js'
import { asSessionId } from '../../src/types/ids.js'
import { releaseActiveTranscriptLease } from '../../src/utils/transcriptLease.js'
import { persistToolResult } from '../../src/utils/toolResultStorage.js'

const [sessionId, marker] = process.argv.slice(2)
if (!sessionId || !marker) throw new Error('usage: <sessionId> <marker>')

await init()
switchSession(asSessionId(sessionId))
const result = await persistToolResult(marker, `relocation-after-${sessionId}`)
if ('error' in result) throw new Error(result.error)
await releaseActiveTranscriptLease()
process.stdout.write(`OUTPUT_PATH=${result.filepath}\n`)
await new Promise<void>(resolve => {
  if (process.stdout.write('')) resolve()
  else process.stdout.once('drain', resolve)
})
process.exit(0)
