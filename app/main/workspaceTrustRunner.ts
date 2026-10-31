import { isAbsolute } from 'node:path'
import { runNdjsonWorker } from './ndjsonWorker.js'
import { MAX_WORKSPACE_TRUST_BYTES, parseWorkspaceTrustWorkerRequest, parseWorkspaceTrustWorkerResult, type WorkspaceTrustWorkerRequest, type WorkspaceTrustWorkerResult } from '../shared/workspaceTrustWorker.js'

/** Resolve or accept trust without starting a chat or loading project code. */
export async function runWorkspaceTrustWorker(options: {
  command: string; args: string[]; cwd: string; request: WorkspaceTrustWorkerRequest; env?: NodeJS.ProcessEnv; signal?: AbortSignal
  log?: (line: string) => void
}): Promise<WorkspaceTrustWorkerResult> {
  if (!parseWorkspaceTrustWorkerRequest(options.request)) throw new Error('Invalid workspace trust request')
  let result: WorkspaceTrustWorkerResult | null = null
  let invalid = false
  const terminal = await runNdjsonWorker({ ...options, input: `${JSON.stringify(options.request)}\n`,
    timeoutMs: 15_000, escalateKillAfterMs: 1_000, forceKillOnAbort: true, maxRecordBytes: MAX_WORKSPACE_TRUST_BYTES,
    onOversizeRecord: () => { invalid = true },
    onRecord: line => {
      try {
        const parsed = parseWorkspaceTrustWorkerResult(JSON.parse(line.toString('utf8')))
        if (result !== null || !parsed || !isAbsolute(parsed.trustRoot)
          || (options.request.type === 'workspace.trust' && (!parsed.trusted || parsed.trustRoot !== options.request.expectedTrustRoot))) invalid = true
        else result = parsed
      } catch { invalid = true }
      return invalid ? 'stop' : 'continue'
    },
  })
  if (result === null || invalid || terminal.code !== 0 || terminal.signal !== null || terminal.timedOut || terminal.aborted || terminal.stdinError || terminal.trailingBytes !== 0) {
    throw new Error('Folder trust could not be resolved or saved')
  }
  return result
}
