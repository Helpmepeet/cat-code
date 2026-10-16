import { stat } from 'node:fs/promises'
import { runNdjsonWorker } from './ndjsonWorker.js'
import { MAX_WORKSPACE_OBSERVATION_BYTES, parseWorkspaceObservation, parseWorkspaceObservationRequest } from '../shared/workspaceObservation.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import type { WorkspaceObservation } from '../shared/protocol.js'

export async function runWorkspaceObservationWorker(options: {
  command: string; args: string[]; cwd: string; engineSessionId: string; env?: NodeJS.ProcessEnv
}): Promise<WorkspaceObservation> {
  const request = parseWorkspaceObservationRequest({ engineSessionId: options.engineSessionId })
  if (!request) throw new Error('Invalid conversation identity')
  let observation: WorkspaceObservation | null = null
  let invalid = false
  const terminal = await runNdjsonWorker({ ...options, input: `${JSON.stringify(request)}\n`,
    timeoutMs: 15_000, escalateKillAfterMs: 1_000, maxRecordBytes: MAX_WORKSPACE_OBSERVATION_BYTES,
    onOversizeRecord: () => { invalid = true },
    onRecord: line => {
      try {
        const value = JSON.parse(line.toString('utf8'))
        const parsed = parseWorkspaceObservation(value)
        if (observation || !parsed || !scanForSecrets(value).ok) invalid = true
        else observation = parsed
      } catch { invalid = true }
      return invalid ? 'stop' : 'continue'
    },
  })
  if (!observation || invalid || terminal.code !== 0 || terminal.signal !== null || terminal.timedOut || terminal.aborted || terminal.stdinError || terminal.trailingBytes !== 0) {
    throw new Error('Could not read the conversation workspace')
  }
  return observation
}

/** Repeated readout polls reuse metadata until the owned transcript changes. */
export function createSavedWorkspaceObservationReader(
  read: (cwd: string, engineSessionId: string) => Promise<WorkspaceObservation>,
) {
  const cache = new Map<string, { stamp: string; value: WorkspaceObservation }>()
  let pending: { stamp: string; promise: Promise<WorkspaceObservation> } | null = null
  return async (cwd: string, engineSessionId: string, transcriptPath: string): Promise<WorkspaceObservation> => {
    const file = await stat(transcriptPath)
    const stamp = JSON.stringify([cwd, engineSessionId, file.size, file.mtimeMs, file.ctimeMs])
    const previous = cache.get(transcriptPath)
    if (previous?.stamp === stamp) return previous.value
    if (pending) {
      if (pending.stamp === stamp) return pending.promise
      throw new Error('Another conversation workspace is being read')
    }
    const promise = read(cwd, engineSessionId)
    pending = { stamp, promise }
    try {
      const value = await promise
      if (cache.size >= 32) cache.delete(cache.keys().next().value!)
      cache.set(transcriptPath, { stamp, value })
      return value
    } finally {
      pending = null
    }
  }
}
