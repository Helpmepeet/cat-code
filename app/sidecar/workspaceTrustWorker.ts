process.env.CLAUDE_CODE_SIMPLE = '1'
import { MAX_WORKSPACE_TRUST_BYTES, parseWorkspaceTrustWorkerRequest } from '../shared/workspaceTrustWorker.js'
import { bootstrapWorkerEngine, emitWorkerRecord, runDisposableWorker } from './workerRuntime.js'

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_WORKSPACE_TRUST_BYTES) throw new Error('Workspace trust request exceeds limit')
    chunks.push(bytes)
  }
  const request = parseWorkspaceTrustWorkerRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  if (!request) throw new Error('Invalid workspace trust request')
  await bootstrapWorkerEngine()
  const { createRealWorkspaceTrustExecutor, createSidecarWorkspaceTrustDomain } = await import('./workspaceTrustDomain.js')
  const executor = createRealWorkspaceTrustExecutor(process.cwd())
  const trustRoot = executor.getTrustRoot()
  if (!trustRoot) throw new Error('Folder trust scope is unavailable')
  if (request.type === 'workspace.trust') {
    // Refuse a new/wider repository scope that was not shown in the dialog.
    if (trustRoot !== request.expectedTrustRoot) throw new Error('Folder trust scope changed; choose the folder again')
    const domain = await createSidecarWorkspaceTrustDomain(process.cwd(), { executor })
    const outcome = domain.acceptTrust()
    if (!outcome.ok) throw new Error(outcome.message)
  }
  await emitWorkerRecord({ type: 'workspace-trust-result', version: 1, trustRoot, trusted: executor.isTrusted() }, MAX_WORKSPACE_TRUST_BYTES, 'workspace trust result')
  process.exit(0)
}
runDisposableWorker('workspace-trust-worker', main)
