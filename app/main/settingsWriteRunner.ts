/** Main-side transport for one sessionless settings write. */
import type { spawn } from 'node:child_process'
import { scanForSecrets } from '../shared/secretGuard.js'
import {
  MAX_SETTINGS_WRITE_WORKER_RECORD_BYTES,
  parseSettingsWriteWorkerRequest,
  parseSettingsWriteWorkerResult,
  type SettingsWriteWorkerRequest,
  type SettingsWriteWorkerResult,
} from '../shared/settingsWriteWorker.js'
import { runNdjsonWorker, type WorkerProcessLifecycle } from './ndjsonWorker.js'

export const SETTINGS_WRITE_WORKER_TIMEOUT_MS = 30_000

export type SettingsWriteRunOptions = {
  command: string
  args: string[]
  cwd: string
  request: SettingsWriteWorkerRequest
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  spawnWorker?: typeof spawn
  onWorkerLifecycle?: (event: WorkerProcessLifecycle) => void
  log?: (line: string) => void
}

export async function runSettingsWriteWorker(
  options: SettingsWriteRunOptions,
): Promise<SettingsWriteWorkerResult> {
  const request = parseSettingsWriteWorkerRequest(options.request)
  if (!request) throw new Error('settings write request failed validation')
  const input = `${JSON.stringify(request)}\n`
  if (Buffer.byteLength(input) > MAX_SETTINGS_WRITE_WORKER_RECORD_BYTES) {
    throw new Error('settings write request exceeds record limit')
  }
  let result: SettingsWriteWorkerResult | null = null
  let error: string | null = null
  let seen = false
  const terminal = await runNdjsonWorker({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? SETTINGS_WRITE_WORKER_TIMEOUT_MS,
    spawnWorker: options.spawnWorker,
    simpleMode: false,
    input,
    forceKillOnAbort: true,
    maxRecordBytes: MAX_SETTINGS_WRITE_WORKER_RECORD_BYTES,
    onWorkerLifecycle: options.onWorkerLifecycle,
    log: options.log,
    onOversizeRecord: () => { error = 'settings write result exceeds record limit' },
    onRecord: line => {
      if (seen) {
        error = 'settings write worker emitted more than one record'
        return 'stop'
      }
      seen = true
      let raw: unknown
      try {
        raw = JSON.parse(line.toString('utf8'))
      } catch {
        error = 'settings write result is not valid JSON'
        return 'stop'
      }
      const parsed = parseSettingsWriteWorkerResult(raw)
      if (!parsed || parsed.requestId !== request.verb.requestId || !scanForSecrets(parsed).ok) {
        error = 'settings write result failed validation'
        return 'stop'
      }
      result = parsed
      return 'continue'
    },
  })
  if (terminal.aborted) throw new Error('settings write worker aborted')
  if (terminal.timedOut) throw new Error('settings write worker timed out')
  if (terminal.stdinError !== null) throw new Error('settings write worker stdin failed', { cause: terminal.stdinError })
  if (error !== null) throw new Error(error)
  if (terminal.code !== 0 || terminal.signal !== null) {
    throw new Error('settings write worker failed')
  }
  if (terminal.trailingBytes !== 0 || !seen || result === null) {
    throw new Error('settings write worker ended without a valid result')
  }
  return result
}
