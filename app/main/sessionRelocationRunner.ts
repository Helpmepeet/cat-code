import { runNdjsonWorker } from './ndjsonWorker.js'
import { MAX_RELOCATION_RECORD_BYTES, parseSessionRelocationRequest, parseSessionRelocationResult, type SessionRelocationRequest } from '../shared/sessionRelocationWorker.js'

export async function runSessionRelocationWorker(options: {
  command: string; args: string[]; cwd: string; request: SessionRelocationRequest; env?: NodeJS.ProcessEnv
}): Promise<void> {
  if (!parseSessionRelocationRequest(options.request)) throw new Error('Invalid move request')
  let accepted = false
  let invalid = false
  let workerError = ''
  const terminal = await runNdjsonWorker({
    ...options,
    simpleMode: false,
    input: `${JSON.stringify(options.request)}\n`,
    timeoutMs: 120_000,
    forceKillOnAbort: true,
    maxRecordBytes: MAX_RELOCATION_RECORD_BYTES,
    log: line => { workerError = line },
    onOversizeRecord: () => { invalid = true },
    onRecord: line => {
      try {
        const result = parseSessionRelocationResult(JSON.parse(line.toString('utf8')))
        if (accepted || !result?.ok) invalid = true
        else accepted = true
      } catch { invalid = true }
      return invalid ? 'stop' : 'continue'
    },
  })
  if (!accepted || invalid || terminal.code !== 0 || terminal.signal !== null || terminal.timedOut || terminal.aborted || terminal.stdinError || terminal.trailingBytes !== 0) {
    throw new Error(workerError || 'Conversation move did not complete')
  }
}
