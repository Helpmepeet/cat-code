process.env.CLAUDE_CODE_SIMPLE = '1'
import { MAX_WORKSPACE_LISTING_BYTES, parseWorkspaceListingRequest } from '../shared/workspaceListingWorker.js'
import { bootstrapWorkerEngine, emitWorkerRecord, runDisposableWorker } from './workerRuntime.js'
import { workerTimingSync } from '../shared/workerTiming.js'
import { readProjectMetadata } from '../main/projectMetadata.js'

async function main(): Promise<void> {
  const request = parseWorkspaceListingRequest(JSON.parse(await Bun.stdin.text()))
  if (!request) throw new Error('Invalid workspace listing request')
  await bootstrapWorkerEngine()
  const { isPathTrusted } = await import('../../src/utils/config.js')
  const trustedRoots = workerTimingSync('trust_evaluation', () => request.roots.filter(root => isPathTrusted(root)))
  const metadata = request.metadataOffset === undefined ? undefined
    : request.roots.slice(request.metadataOffset).filter(root => trustedRoots.includes(root)).slice(0, 8)
      .map(path => ({ path, ...readProjectMetadata(path) }))
  await emitWorkerRecord({ type: 'workspace-list-result', version: 1,
    trustedRoots, ...(metadata === undefined ? {} : { metadata }) }, MAX_WORKSPACE_LISTING_BYTES, 'workspace listing result')
}
runDisposableWorker('workspace-listing-worker', main)
