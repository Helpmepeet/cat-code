import { runNdjsonWorker } from './ndjsonWorker.js'
import { MAX_WORKSPACE_LISTING_BYTES, parseWorkspaceListingRequest, parseWorkspaceListingResult, type WorkspaceListingRequest } from '../shared/workspaceListingWorker.js'

/** Disposable saved-trust observation. No session or candidate project bootstrap. */
export async function runWorkspaceListingWorker(options: {
  command: string; args: string[]; cwd: string; request: WorkspaceListingRequest; env?: NodeJS.ProcessEnv; signal?: AbortSignal
}): Promise<string[]> {
  if (!parseWorkspaceListingRequest(options.request)) throw new Error('Invalid workspace listing request')
  let result: string[] | null = null
  let invalid = false
  const terminal = await runNdjsonWorker({ ...options, input: `${JSON.stringify(options.request)}\n`,
    timeoutMs: 15_000, escalateKillAfterMs: 1_000, maxRecordBytes: MAX_WORKSPACE_LISTING_BYTES,
    onOversizeRecord: () => { invalid = true },
    onRecord: line => {
      try {
        const parsed = parseWorkspaceListingResult(JSON.parse(line.toString('utf8')))
        if (result !== null || !parsed || parsed.trustedRoots.some(path => !options.request.roots.includes(path))) invalid = true
        else result = parsed.trustedRoots
      } catch { invalid = true }
      return invalid ? 'stop' : 'continue'
    },
  })
  if (result === null || invalid || terminal.code !== 0 || terminal.signal !== null || terminal.timedOut || terminal.aborted || terminal.stdinError || terminal.trailingBytes !== 0) {
    throw new Error('Saved project trust could not be read')
  }
  return result
}
