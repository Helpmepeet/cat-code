/** One validated settings write in the selected project's disposable engine process. */
import { scanForSecrets } from '../shared/secretGuard.js'
import {
  MAX_SETTINGS_WRITE_WORKER_RECORD_BYTES,
  parseSettingsWriteWorkerRequest,
  SETTINGS_WRITE_WORKER_VERSION,
  type SettingsWriteWorkerRequest,
  type SettingsWriteWorkerResult,
} from '../shared/settingsWriteWorker.js'
import {
  bootstrapWorkerEngine,
  emitWorkerRecord,
  runDisposableWorker,
} from './workerRuntime.js'

// Match the settings inventory read: project output styles need the full config graph.
process.env.CLAUDE_CODE_SIMPLE = ''

async function readRequest(): Promise<SettingsWriteWorkerRequest> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_SETTINGS_WRITE_WORKER_RECORD_BYTES) {
      throw new Error('settings write request exceeds record limit')
    }
    chunks.push(bytes)
  }
  const input = Buffer.concat(chunks).toString('utf8')
  if (!input.endsWith('\n') || input.slice(0, -1).includes('\n')) {
    throw new Error('settings write worker requires one request record')
  }
  let raw: unknown
  try {
    raw = JSON.parse(input.slice(0, -1))
  } catch {
    throw new Error('settings write request is not valid JSON')
  }
  const request = parseSettingsWriteWorkerRequest(raw)
  if (!request) throw new Error('settings write request failed validation')
  return request
}

async function main(): Promise<void> {
  const request = await readRequest()
  const { createSidecarSettingsDomain, loadAvailableSettingOptions } =
    await import('./settingsDomain.js')
  await bootstrapWorkerEngine()
  const domain = createSidecarSettingsDomain(
    await loadAvailableSettingOptions(process.cwd()),
    { userScope: request.verb.source === 'userSettings' },
  )
  // A failed source read cannot establish the settings/policy floor. In that
  // state, refuse the write even though the engine writer could open a file.
  const outcome = domain.getSnapshot()
    ? domain.runVerb(request.verb)
    : { ok: false, changed: false }
  // Domain errors can include disk parser details. The receipt never echoes
  // a value or engine error; main can safely show this fixed message.
  const result: SettingsWriteWorkerResult = {
    type: 'settings-write-result',
    version: SETTINGS_WRITE_WORKER_VERSION,
    requestId: request.verb.requestId,
    ok: outcome.ok,
    changed: outcome.changed,
    message: outcome.ok ? 'Setting saved.' : 'Could not save setting.',
  }
  if (!scanForSecrets(result).ok) throw new Error('settings write result failed secret scan')
  await emitWorkerRecord(result, MAX_SETTINGS_WRITE_WORKER_RECORD_BYTES, 'settings write result')
  process.exit(0)
}

runDisposableWorker('settings-write-worker', main)
