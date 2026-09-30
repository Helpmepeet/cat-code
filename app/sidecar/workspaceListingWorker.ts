process.env.CLAUDE_CODE_SIMPLE = '1'
import { MAX_WORKSPACE_LISTING_BYTES, parseWorkspaceListingRequest } from '../shared/workspaceListingWorker.js'
import { bootstrapWorkerEngine, emitWorkerRecord, runDisposableWorker } from './workerRuntime.js'

async function main(): Promise<void> {
  const request = parseWorkspaceListingRequest(JSON.parse(await Bun.stdin.text()))
  if (!request) throw new Error('Invalid workspace listing request')
  await bootstrapWorkerEngine()
  const { isPathTrusted } = await import('../../src/utils/config.js')
  await emitWorkerRecord({ type: 'workspace-list-result', version: 1,
    trustedRoots: request.roots.filter(root => isPathTrusted(root)) }, MAX_WORKSPACE_LISTING_BYTES, 'workspace listing result')
}
runDisposableWorker('workspace-listing-worker', main)
