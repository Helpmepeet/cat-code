import { randomUUID, type UUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { init } from '../../src/entrypoints/init.js'
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import { getSessionId, switchSession } from '../../src/bootstrap/state.js'
import { asSessionId } from '../../src/types/ids.js'
import { createAssistantMessage, createUserMessage } from '../../src/utils/messages.js'
import {
  flushSessionStorage,
  getTranscriptPath,
  getTranscriptPathForSession,
  markActiveConversationTip,
  recordTranscript,
} from '../../src/utils/sessionStorage.js'
import { releaseActiveTranscriptLease } from '../../src/utils/transcriptLease.js'
import { resolveBranchOpenHistorySeed, resolveOpenHistorySession } from '../main/openHistorySession.js'
import { sessionDescriptorFixture } from '../shared/sessionDescriptor.fixture.js'
import { encodeFrame, FrameDecoder } from '../shared/framing.js'
import { MAX_OUTBOUND_FRAME_BYTES } from '../shared/limits.js'
import {
  PROTOCOL_VERSION,
  type ServerFrame,
  type SessionActionResultFrame,
} from '../shared/protocol.js'
import { createSidecarSessionActionsDomain } from './sessionActionsDomain.js'
import { resumeEngineSession } from './sessionResume.js'
import { enumerateSessionsCatalog } from './sessionsCatalogDomain.js'
import { SidecarServer, type SidecarSocketLike } from './sidecarServer.js'

async function main(): Promise<void> {
  const [operation, engineSessionId] = process.argv.slice(2)
  if (!engineSessionId || !['fork', 'empty', 'resume'].includes(operation!)) {
    throw new Error('Expected fork, empty, or resume and an engine session id')
  }
  await init()
  if (operation === 'resume') {
    const resumed = await resumeEngineSession(engineSessionId, process.cwd(), {
      activeAgents: [],
      allAgents: [],
    })
    process.stdout.write(`SESSION_BRANCH_RESULT=${JSON.stringify({
      engineSessionId: resumed.engineSessionId,
      messages: resumed.messages,
      undeliveredPrompts: resumed.undeliveredPrompts,
    })}\n`)
    await releaseActiveTranscriptLease()
    return
  }

  switchSession(asSessionId(engineSessionId))
  const user = createUserMessage({ content: 'Fork fixture prompt' })
  const assistant = createAssistantMessage({ content: 'Fork fixture answer' })
  if (operation === 'fork') {
    // The file contains a discarded continuation; HEAD means the active tip,
    // not the final message in file order.
    await recordTranscript([
      user,
      assistant,
      createUserMessage({ content: 'Discarded fixture prompt' }),
      createAssistantMessage({ content: 'Discarded fixture answer' }),
    ])
    await markActiveConversationTip(assistant.uuid as UUID)
    await flushSessionStorage()
  }
  const sourcePath = getTranscriptPath()
  const sourceBefore = operation === 'fork' ? await readFile(sourcePath, 'utf8') : null
  const catalogBefore = await enumerateSessionsCatalog()

  // Whole-conversation branch uses the engine disk owner, not a turn adapter.
  // A turn or a message-targeted fork would be a fixture failure.
  const controller = new AppSessionController({
    async *runTurn() {
      throw new Error('Fork must not run a model turn')
    },
  })
  const appSessionId = randomUUID()
  const server = new SidecarServer({
    sessionId: appSessionId,
    engineSessionId,
    controller,
    sessionActions: createSidecarSessionActionsDomain({ controller }),
    log: () => {},
  })
  const requesterFrames: ServerFrame[] = []
  const observerFrames: ServerFrame[] = []
  let complete!: (result: SessionActionResultFrame) => void
  const completed = new Promise<SessionActionResultFrame>(resolve => { complete = resolve })
  function socket(frames: ServerFrame[], requester = false): SidecarSocketLike {
    const decoder = new FrameDecoder(MAX_OUTBOUND_FRAME_BYTES)
    return {
      write(data) {
        for (const decoded of decoder.push(Buffer.from(data))) {
          if (decoded.kind !== 'frame') continue
          const frame = decoded.payload as ServerFrame
          frames.push(frame)
          if (requester && frame.kind === 'session-action.result') complete(frame)
        }
      },
      end() {},
    }
  }
  const requester = server.addConnection(socket(requesterFrames, true))
  server.addConnection(socket(observerFrames))
  const requestId = randomUUID()
  try {
    server.handleData(requester, encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: appSessionId,
      message: { type: 'session.branch', requestId },
    }))
    const result = await completed
    const sourceUnchanged = operation === 'fork'
      ? sourceBefore === await readFile(sourcePath, 'utf8')
      : true
    const catalogAfter = await enumerateSessionsCatalog()
    const forkEngineSessionId = result.branchEngineSessionId
    const forkEntries = forkEngineSessionId
      ? (await readFile(getTranscriptPathForSession(forkEngineSessionId), 'utf8'))
          .trim().split('\n').map(line => JSON.parse(line))
      : []
    process.stdout.write(`SESSION_BRANCH_RESULT=${JSON.stringify({
      appSessionId,
      requestId,
      result,
      requesterResultCount: requesterFrames.filter(frame => frame.kind === 'session-action.result').length,
      observerResultCount: observerFrames.filter(frame => frame.kind === 'session-action.result').length,
      sourceUnchanged,
      activeEngineSessionId: getSessionId(),
      sourceMessageUuids: [user.uuid, assistant.uuid],
      forkEntries,
      staleOpen: forkEngineSessionId
        ? resolveOpenHistorySession(forkEngineSessionId, [], catalogBefore)
        : null,
      seededOpen: forkEngineSessionId
        ? resolveOpenHistorySession(
            forkEngineSessionId,
            [],
            catalogBefore,
            resolveBranchOpenHistorySeed(result, sessionDescriptorFixture({
              appSessionId,
              engineSessionId,
              cwd: process.cwd(),
              binding: { kind: 'project' },
            })),
          )
        : null,
      freshOpen: forkEngineSessionId
        ? resolveOpenHistorySession(forkEngineSessionId, [], catalogAfter)
        : null,
    })}\n`)
  } finally {
    server.close()
    await releaseActiveTranscriptLease()
  }
}

void main().then(
  () => process.exit(0),
  error => {
    process.stderr.write(`session-branch fixture failed: ${error instanceof Error ? error.stack : String(error)}\n`)
    process.exit(1)
  },
)
