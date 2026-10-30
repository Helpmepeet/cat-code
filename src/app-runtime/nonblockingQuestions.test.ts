import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionId, getSessionProjectDir, switchSession } from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import type { Message, AssistantMessage } from '../types/message.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { createQueryEngineAppSession } from './createQueryEngineAppSession.js'
import { createQueryEngineSessionController } from './createQueryEngineSessionController.js'
import { AskUserQuestionTool } from '../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { PendingQuestionRuntime } from '../utils/pendingQuestionRuntime.js'
import { createUserMessage, wrapCommandText } from '../utils/messages.js'
import { dequeue, remove, getCommandQueue, resetCommandQueue, flushQueueOperationsDurably } from '../utils/messageQueueManager.js'
import { clearSessionMessagesCache, flushCurrentTranscriptDurably, getSessionQueueOperations, getTranscriptPathForSession, loadTranscriptFile, markActiveConversationTip, recordTranscript, resetProjectForTesting } from '../utils/sessionStorage.js'
import { createAttachmentMessage } from '../utils/attachments.js'
import { selectUndeliveredPrompts } from '../../app/sidecar/sessionResume.js'
import { releaseActiveTranscriptLease } from '../utils/transcriptLease.js'

const originalSession = getSessionId()
const originalProject = getSessionProjectDir()
const originalPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
let dir: string
let messages: Message[]
const questions = [
  { question: 'Which storage?', options: [{ label: 'Local', description: 'Disk' }, { label: 'Remote', description: 'Server', preview: '<section>Remote storage layout</section>' }], multiSelect: false },
  { question: 'What name?', options: [], multiSelect: false },
]
function assistant(id: string): AssistantMessage {
  return { type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), message: {
    id: `response-${id}`, role: 'assistant', model: 'test', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }], stop_reason: 'tool_use', stop_sequence: null,
  } }
}
function session() {
  let state = getDefaultAppState()
  return createQueryEngineAppSession({ cwd: dir, initialMessages: messages, tools: [AskUserQuestionTool], commands: [], mcpClients: [], agents: [],
    readFileCache: new Map() as never, getAppState: () => state, setAppState: update => { state = update(state) } })
}
const pick = { toolUseId: 'question-call', questionIndex: 0, answer: { optionIndices: [1] } }

describe.skipIf(feature('NONBLOCKING_ASK_USER_QUESTION') ? false : true)('real app-runtime nonblocking question lifecycle without provider calls', () => {
  beforeEach(async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    await releaseActiveTranscriptLease()
    resetProjectForTesting()
    resetCommandQueue()
    dir = mkdtempSync(join(tmpdir(), 'nonblocking-question-'))
    switchSession(asSessionId(randomUUID()), dir)
    messages = [createUserMessage({ content: 'Help choose storage' }), assistant('question-call')]
    await recordTranscript(messages)
    await flushCurrentTranscriptDurably()
  })
  afterEach(async () => {
    await flushQueueOperationsDurably()
    resetCommandQueue()
    clearSessionMessagesCache()
    resetProjectForTesting()
    await releaseActiveTranscriptLease()
    switchSession(asSessionId(originalSession), originalProject)
    if (originalPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalPersistence
    rmSync(dir, { recursive: true, force: true })
  })
  async function shown() {
    const realSession = session()
    const controller = createQueryEngineSessionController(realSession)
    await controller.waitForInitialization()
    const registry = realSession.getQuestionRegistry!()!
    const context = { pendingQuestions: registry, toolUseId: 'question-call' } as never
    expect(AskUserQuestionTool.requiresUserInteraction?.()).toBe(false)
    expect((await AskUserQuestionTool.checkPermissions!({ questions }, context)).behavior).toBe('allow')
    const result = await AskUserQuestionTool.call({ questions }, context, undefined as never, messages[1] as AssistantMessage)
    expect(result.data).toMatchObject({ shown: true, answers: {} })
    expect(AskUserQuestionTool.mapToolResultToToolResultBlockParam(result.data, 'question-call').content).toBe('Question shown to the user. No answer yet; it will arrive as a separate message.')
    return { realSession, controller, registry }
  }
  test('shown never opens a permission request and accepted partial answers enqueue one durable batch', async () => {
    const { controller } = await shown()
    expect(controller.getPendingPermissionRequests()).toEqual([])
    expect(controller.canStartAutomaticTurn()).toBe(false)
    expect(controller.canStartQueuedTurn()).toBe(true)
    await controller.replyToQuestions({ requestId: 'close-card', replies: [pick] })
    expect(controller.getQuestionSnapshot().pending.map(q => q.question)).toEqual(['What name?'])
    expect(getCommandQueue()).toHaveLength(1)
    const command = getCommandQueue()[0]!
    expect(command.origin).toMatchObject({ kind: 'question-reply', batchId: 'close-card' })
    const text = wrapCommandText(command.value as string, command.origin)
    expect(text).toContain('Which storage?')
    expect(text).toContain('Remote')
    await controller.replyToQuestions({ requestId: 'close-card', replies: [pick] })
    expect(getCommandQueue()).toHaveLength(1)
    const loaded = await loadTranscriptFile(getTranscriptPathForSession(getSessionId()), { keepCompactedHistory: true })
    expect(loaded.questionLifecycles.map(entry => entry.operation)).toEqual(['asked', 'resolved'])
    expect([...loaded.messages.values()].some(message => JSON.stringify(message).includes('question-lifecycle'))).toBe(false)
  })
  test('resolved controller snapshots omit option payloads while durable recovery retains preview delivery', async () => {
    const { controller } = await shown()
    const batch = { requestId: 'preview-answer', replies: [pick] }
    await controller.replyToQuestions(batch)
    const resolved = controller.getQuestionSnapshot().resolved[0]!
    expect(resolved).toMatchObject({ question: 'Which storage?', answer: 'Remote', state: 'answered' })
    for (const key of ['options', 'multiSelect', 'selectedPreview']) expect(resolved).not.toHaveProperty(key)
    const first = dequeue()!
    const preview = questions[0]!.options[1]!.preview!
    expect(JSON.parse(first.value as string)[0].selectedPreview).toBe(preview)
    await flushQueueOperationsDurably()
    const loaded = await loadTranscriptFile(getTranscriptPathForSession(getSessionId()), { keepCompactedHistory: true })
    const entry = loaded.questionLifecycles.find(entry => entry.operation === 'resolved')
    if (!entry || entry.operation !== 'resolved') throw new Error('Missing durable resolution')
    expect(entry.resolutions[0]).toMatchObject({ selectedPreview: preview, options: questions[0]!.options })
    const restarted = new PendingQuestionRuntime(() => messages)
    await restarted.initialize()
    const retry = await restarted.registry.reply(batch)
    expect(retry.uuid).toBe(first.uuid)
    expect(JSON.parse(retry.content)[0].selectedPreview).toBe(preview)
    expect(restarted.registry.getSnapshot().resolved).toEqual([resolved])
    restarted.deliver()
    expect(getCommandQueue().map(command => command.uuid)).toEqual([first.uuid])
    expect(JSON.parse(getCommandQueue()[0]!.value as string)[0].selectedPreview).toBe(preview)
  })

  test('restart after acceptance but before drain restores the same outbox UUID, not the question', async () => {
    const { controller } = await shown()
    await controller.replyToQuestions({ requestId: 'close-card', replies: [pick] })
    const reserved = dequeue()!
    await flushQueueOperationsDurably()
    const runtime = new PendingQuestionRuntime(() => messages)
    await runtime.initialize()
    runtime.deliver()
    expect(getCommandQueue().map(command => command.uuid)).toEqual([reserved.uuid])
    expect(runtime.registry.getSnapshot().pending.map(q => q.questionIndex)).toEqual([1])
    const accepted = createUserMessage({ content: reserved.value, uuid: reserved.uuid, origin: reserved.origin })
    messages.push(accepted)
    await recordTranscript(messages)
    await flushCurrentTranscriptDurably()
    dequeue()
    const afterAccepted = new PendingQuestionRuntime(() => messages)
    await afterAccepted.initialize()
    afterAccepted.deliver()
    expect(getCommandQueue()).toHaveLength(0)
  })
  test('consumption reservations survive a crash without being mistaken for explicit cancellation or a recovered draft', async () => {
    const { controller } = await shown()
    await controller.replyToQuestions({ requestId: 'close-card', replies: [pick] })
    const queued = getCommandQueue()[0]!
    remove([queued], 'reserve')
    await flushQueueOperationsDurably()
    const ledger = await getSessionQueueOperations(getSessionId())
    expect(ledger.operations.at(-1)?.operation).toBe('reserve')
    expect(ledger.operations.find(operation => operation.operation === 'enqueue')?.origin?.kind).toBe('question-reply')
    expect(selectUndeliveredPrompts(ledger).prompts).toEqual([])
    const restarted = new PendingQuestionRuntime(() => messages)
    await restarted.initialize()
    restarted.deliver()
    expect(getCommandQueue().map(command => command.uuid)).toEqual([queued.uuid])
  })

  test('a durable mid-turn attachment is a consumption receipt, and explicit queue cancellation stays cancelled', async () => {
    const { controller } = await shown()
    await controller.replyToQuestions({ requestId: 'close-card', replies: [pick] })
    const queued = getCommandQueue()[0]!
    remove([queued], 'reserve')
    messages.push(createAttachmentMessage({ type: 'queued_command', prompt: queued.value, source_uuid: queued.uuid, commandMode: 'prompt', origin: queued.origin } as never))
    await recordTranscript(messages)
    await flushCurrentTranscriptDurably()
    const restarted = new PendingQuestionRuntime(() => messages)
    await restarted.initialize()
    restarted.deliver()
    expect(getCommandQueue()).toHaveLength(0)
    await controller.replyToQuestions({ requestId: 'close-second', replies: [{ toolUseId: 'question-call', questionIndex: 1, answer: { optionIndices: [], other: 'Name' } }] })
    const second = getCommandQueue()[0]!
    remove([second])
    await flushQueueOperationsDurably()
    const afterCancellation = new PendingQuestionRuntime(() => messages)
    await afterCancellation.initialize()
    afterCancellation.deliver()
    expect(getCommandQueue()).toHaveLength(0)
    expect(afterCancellation.registry.getSnapshot().resolved).toHaveLength(2)
  })

  test('rewinding past a delivered reply never replays its old outbox UUID', async () => {
    const { controller } = await shown()
    await controller.replyToQuestions({ requestId: 'close-card', replies: [pick] })
    const command = dequeue()!
    const answer = createUserMessage({ content: command.value, uuid: command.uuid, origin: command.origin })
    messages.push(answer)
    await recordTranscript(messages)
    await flushCurrentTranscriptDurably()
    await markActiveConversationTip(messages[1]!.uuid as never)
    const restarted = new PendingQuestionRuntime(() => messages.slice(0, 2))
    await restarted.initialize()
    restarted.deliver()
    expect(getCommandQueue()).toHaveLength(0)
    expect(restarted.registry.getSnapshot().resolved[0]?.answer).toBe('Remote')
  })

  test('compact then answer restores questions from full ancestry, not the mutable model seed', async () => {
    await shown()
    const path = getTranscriptPathForSession(getSessionId())
    const boundary = randomUUID()
    const summary = createUserMessage({ content: 'Compacted context', isMeta: true })
    const base = { sessionId: getSessionId(), cwd: dir, version: 'test', isSidechain: false, userType: 'external', timestamp: new Date().toISOString() }
    appendFileSync(path, JSON.stringify({ ...base, type: 'system', subtype: 'compact_boundary', uuid: boundary, parentUuid: null, logicalParentUuid: messages[1]!.uuid, content: 'Conversation compacted', level: 'info', compactMetadata: { trigger: 'manual', preTokens: 200000 } }) + '\n' + JSON.stringify({ ...summary, ...base, parentUuid: boundary }) + '\n')
    await markActiveConversationTip(summary.uuid as never)
    const runtime = new PendingQuestionRuntime(() => [summary])
    await runtime.initialize()
    expect(runtime.registry.getSnapshot().pending).toHaveLength(2)
    const delivery = await runtime.registry.reply({ requestId: 'after-compact', replies: [pick] })
    expect(delivery.content).toContain('Which storage?')
  })
  test('rewind/clear drops calls no longer active and dismissal survives restart silently', async () => {
    const { controller } = await shown()
    await controller.dismissQuestion({ requestId: 'dismiss-one', toolUseId: 'question-call', questionIndex: 0 })
    const restarted = new PendingQuestionRuntime(() => messages)
    await restarted.initialize()
    expect(restarted.registry.getSnapshot().resolved[0]?.state).toBe('dismissed')
    expect(restarted.registry.undelivered(new Set())).toEqual([])
    await markActiveConversationTip(messages[0]!.uuid as never)
    await restarted.restore()
    expect(restarted.registry.getSnapshot()).toEqual({ pending: [], resolved: [] })
  })
  test('a new engine session clears the previous owner registry and never retargets its queued answers', async () => {
    const { controller } = await shown()
    await controller.replyToQuestions({ requestId: 'old-close', replies: [pick] })
    await flushQueueOperationsDurably()
    const runtime = new PendingQuestionRuntime(() => messages)
    await runtime.initialize()
    await releaseActiveTranscriptLease()
    resetProjectForTesting()
    switchSession(asSessionId(randomUUID()), dir)
    messages = []
    await runtime.initialize()
    runtime.deliver()
    expect(runtime.registry.getSnapshot()).toEqual({ pending: [], resolved: [] })
    expect(getCommandQueue()).toEqual([])
  })
})
