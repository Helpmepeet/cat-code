import { runNdjsonWorker } from './ndjsonWorker.js'
import { parseWorkerTimings, type WorkerTiming } from '../shared/workerTiming.js'
import { MAX_WORKSPACE_LISTING_BYTES, parseWorkspaceListingRequest, parseWorkspaceListingResult, type WorkspaceListingRequest, type WorkspaceMetadata } from '../shared/workspaceListingWorker.js'

/** Disposable saved-trust observation. No session or candidate project bootstrap. */
export async function runWorkspaceListingWorker(options: {
  command: string; args: string[]; cwd: string; request: WorkspaceListingRequest; env?: NodeJS.ProcessEnv; signal?: AbortSignal
  onTiming?: (timing: WorkerTiming) => void
  onMetadata?: (metadata: WorkspaceMetadata[]) => void
}): Promise<string[]> {
  if (!parseWorkspaceListingRequest(options.request)) throw new Error('Invalid workspace listing request')
  let result: string[] | null = null
  let invalid = false
  let metadata: WorkspaceMetadata[] | undefined
  const terminal = await runNdjsonWorker({ ...options, input: `${JSON.stringify(options.request)}\n`,
    env: { ...process.env, ...options.env, CAT_CODE_WORKER_TIMING: options.onTiming ? '1' : '0' },
    log: stderr => { for (const timing of parseWorkerTimings(stderr)) { try { options.onTiming?.(timing) } catch { /* Observation only. */ } } },
    timeoutMs: 15_000, escalateKillAfterMs: 1_000, maxRecordBytes: MAX_WORKSPACE_LISTING_BYTES,
    onOversizeRecord: () => { invalid = true },
    onRecord: line => {
      try {
        const parsed = parseWorkspaceListingResult(JSON.parse(line.toString('utf8')))
        if (result !== null || !parsed || parsed.trustedRoots.some(path => !options.request.roots.includes(path))) invalid = true
        else {
          const expected = options.request.metadataOffset === undefined ? undefined
            : options.request.roots.slice(options.request.metadataOffset).filter(path => parsed.trustedRoots.includes(path)).slice(0, 8)
          if (expected === undefined ? parsed.metadata !== undefined
            : !parsed.metadata || parsed.metadata.length !== expected.length || parsed.metadata.some((row, index) => row.path !== expected[index])) invalid = true
          else { result = parsed.trustedRoots; metadata = parsed.metadata }
        }
      } catch { invalid = true }
      return invalid ? 'stop' : 'continue'
    },
  })
  if (result === null || invalid || terminal.code !== 0 || terminal.signal !== null || terminal.timedOut || terminal.aborted || terminal.stdinError || terminal.trailingBytes !== 0) {
    throw new Error('Saved project trust could not be read')
  }
  if (metadata !== undefined) options.onMetadata?.(metadata)
  return result
}
