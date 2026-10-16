import { init } from '../../src/entrypoints/init.js'
import { getCwdState, setCwdState, switchSession } from '../../src/bootstrap/state.js'
import { asSessionId } from '../../src/types/ids.js'
import { createAssistantMessage, createUserMessage } from '../../src/utils/messages.js'
import { flushSessionStorage, recordTranscript, saveWorktreeState } from '../../src/utils/sessionStorage.js'
import { releaseActiveTranscriptLease } from '../../src/utils/transcriptLease.js'
import { loadAgentDefinitionsForRuntime } from './sessionController.js'
import { resumeEngineSession } from './sessionResume.js'
import { createWorkspaceObserver } from './workspaceObservation.js'

const [mode, sessionId, worktreePath] = process.argv.slice(2)
if (!sessionId || !worktreePath) throw new Error('Missing isolated fixture arguments')
await init()
const openingCwd = process.cwd()
if (mode === 'mint') {
  switchSession(asSessionId(sessionId))
  setCwdState(worktreePath)
  saveWorktreeState({
    originalCwd: openingCwd,
    worktreePath,
    worktreeName: 'entered',
    worktreeBranch: 'entered',
    originalBranch: 'main',
    sessionId,
  })
  await recordTranscript([
    createUserMessage({ content: 'Work in the entered worktree' }),
    createAssistantMessage({ content: 'Recorded in the entered worktree' }),
  ])
  await flushSessionStorage()
} else if (mode === 'resume') {
  const resumed = await resumeEngineSession(sessionId, openingCwd, await loadAgentDefinitionsForRuntime(openingCwd))
  const observer = await createWorkspaceObserver(resumed)
  const restored = observer.getSnapshot()
  const observedAgain = observer.getSnapshot()
  await observer.conversationContinued()
  process.stdout.write(`OBSERVATION=${JSON.stringify({
    actualCwd: getCwdState(),
    recordedBranch: resumed.lastWorkingBranch,
    restored,
    observedAgain,
    continued: observer.getSnapshot(),
  })}\n`)
} else {
  throw new Error(`Unknown fixture mode: ${mode}`)
}
await releaseActiveTranscriptLease()
process.exit(0)
