import type { spawn } from 'node:child_process'
import { runNdjsonWorker, type WorkerProcessLifecycle } from './ndjsonWorker.js'
import { decideProjectRoute } from '../shared/projectRoutingPolicy.js'
import {
  MAX_PROJECT_ROUTE_RECORD_BYTES,
  parseProjectRouteWorkerRequest,
  parseProjectRouteWorkerResult,
  type ProjectRouteDecision,
  type ProjectRouteWorkerRequest,
} from '../shared/projectRouting.js'

export async function runProjectRoutingWorker(options: {
  command: string
  args: string[]
  cwd: string
  request: ProjectRouteWorkerRequest
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  spawnWorker?: typeof spawn
  timeoutMs?: number
  onWorkerLifecycle?: (event: WorkerProcessLifecycle) => void
  log?: (message: string) => void
}): Promise<ProjectRouteDecision> {
  const request = parseProjectRouteWorkerRequest(options.request)
  if (!request) throw new Error('Invalid project routing request')
  const input = `${JSON.stringify(request)}\n`
  if (Buffer.byteLength(input) > MAX_PROJECT_ROUTE_RECORD_BYTES) throw new Error('Project routing request is too large')
  // Ordinary chat needs no engine bootstrap. A potential move still goes
  // through the worker's engine-owned project trust check.
  if (decideProjectRoute(request.text, request.knownProjectRoots, request.suppressedRoots).kind === 'stay') {
    return { kind: 'stay' }
  }
  let decision: ProjectRouteDecision | null = null
  let invalid = false
  const terminal = await runNdjsonWorker({
    ...options,
    input,
    timeoutMs: options.timeoutMs ?? 15_000,
    forceKillOnAbort: true,
    escalateKillAfterMs: 500,
    maxRecordBytes: MAX_PROJECT_ROUTE_RECORD_BYTES,
    onOversizeRecord: () => { invalid = true },
    onRecord: line => {
      if (decision !== null) { invalid = true; return 'stop' }
      try {
        const result = parseProjectRouteWorkerResult(JSON.parse(line.toString('utf8')))
        if (!result) invalid = true
        else decision = result.decision
      } catch { invalid = true }
      return invalid ? 'stop' : 'continue'
    },
  })
  const resolvedDecision = decision as ProjectRouteDecision | null
  if (invalid || resolvedDecision === null || terminal.code !== 0 || terminal.signal !== null ||
      terminal.timedOut || terminal.aborted || terminal.stdinError || terminal.trailingBytes !== 0) {
    throw new Error(terminal.timedOut ? 'Project routing timed out' : 'Project routing did not complete')
  }
  if (resolvedDecision.kind !== 'stay' && (!request.knownProjectRoots.includes(resolvedDecision.cwd) ||
      (resolvedDecision.kind === 'auto' && !resolvedDecision.explicit))) throw new Error('Invalid project routing destination')
  return resolvedDecision
}
