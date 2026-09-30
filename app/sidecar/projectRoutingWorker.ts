process.env.CLAUDE_CODE_SIMPLE = ''

import { decideProjectRoute } from '../shared/projectRoutingPolicy.js'
import {
  MAX_PROJECT_ROUTE_RECORD_BYTES,
  parseProjectRouteWorkerRequest,
  type ProjectRouteDecision,
} from '../shared/projectRouting.js'
import { bootstrapWorkerEngine, emitWorkerRecord, runDisposableWorker } from './workerRuntime.js'

async function main(): Promise<void> {
  const raw = await Bun.stdin.text()
  const request = parseProjectRouteWorkerRequest(JSON.parse(raw))
  if (!request) throw new Error('Invalid project routing request')
  await bootstrapWorkerEngine()
  const { isPathTrusted } = await import('../../src/utils/config.js')
  const roots = request.knownProjectRoots.filter(root => isPathTrusted(root))
  const decision: ProjectRouteDecision = decideProjectRoute(request.text, roots, request.suppressedRoots)
  await emitWorkerRecord({ type: 'project-route-result', version: 1, decision }, MAX_PROJECT_ROUTE_RECORD_BYTES, 'project routing result')
}

runDisposableWorker('project-routing-worker', main)
