import { realpath, stat } from 'node:fs/promises'
import { MAX_WORKSPACE_OBSERVATION_BYTES, parseWorkspaceObservationRequest } from '../shared/workspaceObservation.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import { bootstrapWorkerEngine, emitWorkerRecord, runDisposableWorker } from './workerRuntime.js'

process.env.CLAUDE_CODE_SIMPLE = '1'

async function main(): Promise<void> {
  const input = await Bun.stdin.text()
  if (Buffer.byteLength(input) > MAX_WORKSPACE_OBSERVATION_BYTES) throw new Error('Workspace request exceeds limit')
  const request = parseWorkspaceObservationRequest(JSON.parse(input))
  if (!request) throw new Error('Invalid workspace observation request')
  await bootstrapWorkerEngine()
  const { getLastSessionLog } = await import('../../src/utils/sessionStorage.js')
  const log = await getLastSessionLog(request.engineSessionId as `${string}-${string}-${string}-${string}-${string}`)
  if (!log) throw new Error('Conversation metadata is unavailable')
  let cwd = await realpath(process.cwd())
  // Match restoreWorktreeForResume's missing-directory fallback without restoring
  // a session, running hooks, or rewriting transcript metadata.
  const worktree = log.worktreeSession?.worktreePath
  if (worktree) {
    try {
      if ((await stat(worktree)).isDirectory()) cwd = await realpath(worktree)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const branch = log.gitBranch === 'HEAD' ? null : log.gitBranch
  const observation = { cwd, ...(branch !== undefined ? { lastWorkingBranch: branch } : {}) }
  if (!scanForSecrets(observation).ok) throw new Error('Workspace observation failed secret screening')
  await emitWorkerRecord(observation, MAX_WORKSPACE_OBSERVATION_BYTES, 'workspace observation')
  process.exit(0)
}

runDisposableWorker('workspace-observation-worker', main)
