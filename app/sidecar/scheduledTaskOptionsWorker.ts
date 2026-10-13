process.env.CLAUDE_CODE_SIMPLE = '1'
import { MAX_SCHEDULED_OPTIONS_BYTES, parseScheduledTaskOptionsRequest } from '../shared/scheduledTaskOptions.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import { bootstrapWorkerEngine, emitWorkerRecord, runDisposableWorker } from './workerRuntime.js'

async function main(): Promise<void> {
  const input = await Bun.stdin.text()
  if (Buffer.byteLength(input) > 256 || !parseScheduledTaskOptionsRequest(JSON.parse(input))) throw new Error('Invalid scheduled options request')
  await bootstrapWorkerEngine()
  const { readScheduledTaskOptionsDomain } = await import('./scheduledTaskOptionsDomain.js')
  const result = await readScheduledTaskOptionsDomain()
  if (!scanForSecrets(result).ok) throw new Error('Scheduled options contained forbidden fields')
  await emitWorkerRecord(result, MAX_SCHEDULED_OPTIONS_BYTES, 'scheduled options result')
}
runDisposableWorker('scheduled-options-worker', main)
