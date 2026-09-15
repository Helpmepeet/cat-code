/**
 * Mint a transcript whose first turn is replaced through the real QueryEngine
 * rewind API. The caller resumes it in a separate process, so this fixture
 * covers both the durable active-tip transition and the cold-load boundary.
 */
import { randomUUID } from 'node:crypto'
import { init } from '../../src/entrypoints/init.js'
import { QueryEngine } from '../../src/QueryEngine.js'
import { switchSession } from '../../src/bootstrap/state.js'
import { getDefaultAppState, type AppState } from '../../src/state/AppStateStore.js'
import { asSessionId } from '../../src/types/ids.js'
import { createFileStateCacheWithSizeLimit } from '../../src/utils/fileStateCache.js'
import { createAssistantMessage, createUserMessage } from '../../src/utils/messages.js'
import {
  flushSessionStorage,
  markActiveConversationTip,
  recordTranscript,
} from '../../src/utils/sessionStorage.js'
import { releaseActiveTranscriptLease } from '../../src/utils/transcriptLease.js'

async function main(): Promise<void> {
  const sessionId = process.argv[2]
  const marker = process.argv[3]
  if (!sessionId || !marker) {
    throw new Error('usage: rewindResumeSeedMint.fixture.ts <sessionId> <marker>')
  }

  await init()
  switchSession(asSessionId(sessionId))
  const originalUser = createUserMessage({
    uuid: randomUUID(),
    content: 'discarded original root',
  })
  const originalAssistant = createAssistantMessage({
    content: 'discarded original answer',
  })
  await recordTranscript([originalUser, originalAssistant])

  let state: AppState = getDefaultAppState()
  const engine = new QueryEngine({
    cwd: process.cwd(),
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    getAppState: () => state,
    setAppState: update => { state = update(state) },
    initialMessages: [originalUser, originalAssistant],
    readFileCache: createFileStateCacheWithSizeLimit(20),
    markActiveConversationTip,
  })
  const rewind = await engine.rewindBeforeUserMessage(originalUser.uuid)
  if (rewind.retainedMessages.length !== 0 || engine.getMessages().length !== 0) {
    throw new Error('first-message rewind did not empty the live conversation')
  }

  const replacementUser = createUserMessage({
    content: `replacement ${marker}`,
  })
  const replacementAssistant = createAssistantMessage({
    content: `answer ${marker}`,
  })
  await recordTranscript([replacementUser, replacementAssistant])
  await flushSessionStorage()
  await releaseActiveTranscriptLease()
  process.stdout.write(`MINTED=${replacementUser.uuid},${replacementAssistant.uuid}\n`)
}

void main().catch(error => {
  process.stderr.write(
    `rewind seed mint failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
})
