import { MAX_RELOCATION_RECORD_BYTES, parseSessionRelocationRequest } from '../shared/sessionRelocationWorker.js'
import { bootstrapWorkerEngine, emitWorkerRecord, runDisposableWorker } from './workerRuntime.js'
import { workerTiming } from '../shared/workerTiming.js'

runDisposableWorker('session-relocation', async () => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_RELOCATION_RECORD_BYTES) throw new Error('Move request too large')
    chunks.push(buffer)
  }
  const input = Buffer.concat(chunks).toString('utf8')
  if (!input.endsWith('\n') || input.slice(0, -1).includes('\n')) throw new Error('Expected one move request')
  const request = parseSessionRelocationRequest(JSON.parse(input))
  if (!request) throw new Error('Invalid move request')
  await bootstrapWorkerEngine()
  const { relocateSession } = await workerTiming('relocation_module_load', () => import('../../src/utils/sessionRelocation.js'))
  await workerTiming('relocation_work', () => relocateSession(request))
  await emitWorkerRecord({ type: 'session-relocation-result', version: 1, ok: true }, MAX_RELOCATION_RECORD_BYTES, 'move result')
  process.exit(0)
})
