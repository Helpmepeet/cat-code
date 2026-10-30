// Real question producer and runtime, without provider traffic or live account state.
import { randomUUID } from 'node:crypto'
import { spyOn } from 'bun:test'
import * as claude from '../../src/services/api/claude.js'
import { getSessionId, switchSession } from '../../src/bootstrap/state.js'
import { asSessionId } from '../../src/types/ids.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { createQueryEngineAppSession } from '../../src/app-runtime/createQueryEngineAppSession.js'
import { createQueryEngineSessionController } from '../../src/app-runtime/createQueryEngineSessionController.js'
import { recordTranscript, flushCurrentTranscriptDurably } from '../../src/utils/sessionStorage.js'
import { createAssistantMessage, createUserMessage } from '../../src/utils/messages.js'
import { AskUserQuestionTool } from '../../src/tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { createBackpressuredSocket } from './backpressuredSocket.js'
import { SidecarServer } from './sidecarServer.js'

globalThis.fetch = (async () => { throw new Error('question transport fixture forbids network') }) as unknown as typeof fetch
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = { VERSION: 'question-transport-test' }
spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
  yield createAssistantMessage({ content: 'Recorded the storage decisions.' })
})
switchSession(asSessionId(randomUUID()), process.cwd())
const questions = [{ question: 'Which storage?', multiSelect: true, options: Array.from({ length: 4 }, (_, index) => ({ label: `Storage ${index}`, description: `Choice ${index}` })) }]
const assistants = Array.from({ length: 9 }, (_, index) => ({
  type: 'assistant' as const, uuid: randomUUID(), timestamp: new Date().toISOString(),
  message: { id: `source-${index}`, role: 'assistant', model: 'test', content: [{ type: 'tool_use', id: `actual-call-${index}`, name: 'AskUserQuestion', input: { questions } }], stop_reason: 'tool_use', stop_sequence: null },
}))
const messages = [createUserMessage({ content: 'Choose storage for each component' }), ...assistants] as Parameters<typeof recordTranscript>[0]
await recordTranscript(messages)
await flushCurrentTranscriptDurably()
let state = getDefaultAppState()
const session = createQueryEngineAppSession({ cwd: process.cwd(), initialMessages: messages, tools: [AskUserQuestionTool], commands: [], mcpClients: [], agents: [], readFileCache: new Map() as never, getAppState: () => state, setAppState: update => { state = update(state) } })
const controller = createQueryEngineSessionController(session)
await controller.waitForInitialization()
const registry = session.getQuestionRegistry!()!
for (const [index, assistant] of assistants.entries()) {
  await AskUserQuestionTool.call({ questions }, { pendingQuestions: registry, toolUseId: `actual-call-${index}` } as never, undefined as never, assistant as never)
}
const server = new SidecarServer({ sessionId: process.env.CATCODE_SIDECAR_SESSION_ID!, engineSessionId: getSessionId(), controller, log: console.log, wrapOutboundFrame: (frame, deliveryTrace) => ({ kind: 'sidecar.delivery-envelope', frame, deliveryTrace }) })
const connections = new WeakMap<object, { connection: ReturnType<typeof server.addConnection>; drain: () => void }>()
Bun.listen({ unix: process.env.CATCODE_SIDECAR_SOCKET!, socket: {
  open(socket) { const adapter = createBackpressuredSocket(socket); connections.set(socket, { connection: server.addConnection(adapter.wrapper), drain: adapter.drain }) },
  data(socket, data) { server.handleData(connections.get(socket)!.connection, data) },
  close(socket) { const entry = connections.get(socket); if (entry) server.removeConnection(entry.connection) },
  drain(socket) { connections.get(socket)?.drain() },
} })
