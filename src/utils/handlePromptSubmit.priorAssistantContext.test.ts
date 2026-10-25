import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { Message } from '../types/message.js'
import { createAssistantMessage, createUserMessage } from './messages.js'
import { capturePriorAssistantContext } from './permissions/priorAssistantContext.js'

// Run in its own Bun process: these stubs isolate submission from hooks/providers.
let afterAcceptance = () => {}
let active = false
beforeEach(() => { active = true })
afterEach(() => { active = false })
const deferred = await import('../services/deferredContinuation.js')
const realPrepare = deferred.prepareHumanPromptAgainstDeferredContinuation
const realTake = deferred.takeDeferredContinuationNotice
mock.module('../services/deferredContinuation.js', () => ({
  ...deferred,
  prepareHumanPromptAgainstDeferredContinuation: async (...args: Parameters<typeof realPrepare>) => {
    if (!active) return realPrepare(...args)
    afterAcceptance()
    return { action: 'allow' }
  },
  takeDeferredContinuationNotice: async (...args: Parameters<typeof realTake>) => active ? null : realTake(...args),
}))
const processor = await import('./processUserInput/processUserInput.js')
const realProcess = processor.processUserInput
mock.module('./processUserInput/processUserInput.js', () => ({
  ...processor,
  processUserInput: async (params: Parameters<typeof realProcess>[0]) => active ? ({
    messages: [
      createUserMessage({ content: params.input, uuid: params.uuid }),
      createUserMessage({ content: 'hook output', isMeta: true }),
    ],
    shouldQuery: true,
  }) : realProcess(params),
}))
const history = await import('./fileHistory.js')
const realEnabled = history.fileHistoryEnabled
mock.module('./fileHistory.js', () => ({
  ...history, fileHistoryEnabled: () => active ? false : realEnabled(),
}))
const { handlePromptSubmit } = await import('./handlePromptSubmit.js')
const { dequeueAll, resetCommandQueue } = await import('./messageQueueManager.js')
afterEach(() => { resetCommandQueue(); afterAcceptance = () => {} })

function proposal(text: string) {
  const message = createAssistantMessage({ content: text })
  message.message.model = 'test-model'
  return message
}

function params(messages: Message[], active = false) {
  const delivered: Message[] = []
  return {
    delivered,
    input: 'Sure', messages, commands: [],
    queryGuard: { isActive: active, reserve() {}, cancelReservation() {} },
    helpers: { setCursorOffset() {}, clearBuffer() {}, resetHistory() {} },
    onInputChange() {}, setPastedContents() {}, setAbortController() {},
    setUserInputOnProcessing() {},
    setToolJSX() {}, getToolUseContext: () => ({}),
    onQuery: async (next: Message[]) => { delivered.push(...next) },
  }
}

test('direct submission binds A before awaits, not later B or hook output', async () => {
  const messages: Message[] = [proposal('May I read the file?')]
  const binding = capturePriorAssistantContext(messages)
  const input = params(messages)
  afterAcceptance = () => { messages.push(proposal('May I delete the directory too?')) }
  await handlePromptSubmit(input as never)
  expect(input.delivered[0]?.type).toBe('user')
  expect((input.delivered[0] as ReturnType<typeof createUserMessage>).priorAssistantContext).toEqual(binding)
  expect((input.delivered[1] as ReturnType<typeof createUserMessage>).priorAssistantContext).toBeUndefined()
})

test('submission queued after acceptance preserves A through later B and drain', async () => {
  const messages: Message[] = [proposal('May I read the file?')]
  const binding = capturePriorAssistantContext(messages)
  const input = params(messages)
  afterAcceptance = () => {
    messages.push(proposal('May I delete the directory too?'))
    input.queryGuard.isActive = true
  }
  await handlePromptSubmit(input as never)
  const queuedCommands = dequeueAll()
  expect(queuedCommands[0]?.priorAssistantContext).toEqual(binding)
  await handlePromptSubmit({ ...input, queuedCommands } as never)
  expect((input.delivered[0] as ReturnType<typeof createUserMessage>).priorAssistantContext).toEqual(binding)
})

test('in-flight prose absent from visible messages cannot bind a stale proposal', async () => {
  const input = params([proposal('Old proposal')], true)
  await handlePromptSubmit({ ...input, streamMode: 'responding' } as never)
  expect(dequeueAll()[0]?.priorAssistantContext).toBeNull()
})

test('busy submission binds the trusted visible A snapshot, never later B at drain', async () => {
  const a = proposal('May I read the file?')
  const b = proposal('May I delete the directory too?')
  const visiblePriorAssistantContext = capturePriorAssistantContext([a])
  expect(visiblePriorAssistantContext).not.toBeNull()
  // The live array can already be ahead of the deferred visible transcript.
  const input = params([a, b], true)
  await handlePromptSubmit({ ...input, visiblePriorAssistantContext } as never)
  const queuedCommands = dequeueAll()
  expect(queuedCommands[0]?.priorAssistantContext).toEqual(visiblePriorAssistantContext)
  await handlePromptSubmit({ ...input, queuedCommands } as never)
  expect((input.delivered[0] as ReturnType<typeof createUserMessage>).priorAssistantContext)
    .toEqual(visiblePriorAssistantContext)
})

test('explicit null visible snapshot overrides otherwise eligible idle messages', async () => {
  const input = params([proposal('May I read the file?')])
  await handlePromptSubmit({ ...input, visiblePriorAssistantContext: null } as never)
  expect((input.delivered[0] as ReturnType<typeof createUserMessage>).priorAssistantContext).toBeNull()
})

test('legacy queued input does not recapture the proposal at delivery', async () => {
  const input = params([proposal('Later proposal')])
  await handlePromptSubmit({ ...input, queuedCommands: [{ value: 'Sure', mode: 'prompt' }] } as never)
  expect((input.delivered[0] as ReturnType<typeof createUserMessage>).priorAssistantContext).toBeNull()
})
