import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'restore-admission-'))
const macro = globalThis as typeof globalThis & { MACRO?: { VERSION: string } }
const previousMacro = macro.MACRO
macro.MACRO = { VERSION: 'restore-review-test' }
const previous = { config: process.env.CLAUDE_CONFIG_DIR, persistence: process.env.TEST_ENABLE_SESSION_PERSISTENCE, simple: process.env.CLAUDE_CODE_SIMPLE, key: process.env.ANTHROPIC_API_KEY }
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.ANTHROPIC_API_KEY = 'isolated-synthetic-test-key'
const bootstrap = await import('../bootstrap/state.js')
const oldSession = bootstrap.getSessionId()
const oldProject = bootstrap.getSessionProjectDir()
const { asSessionId } = await import('../types/ids.js')
const storage = await import('./sessionStorage.js')
const { releaseActiveTranscriptLease } = await import('./transcriptLease.js')
const { createUserMessage } = await import('./messages.js')
const { loadConversationForResume } = await import('./conversationRecovery.js')
const { RestoreReviewAdmission, persistTerminalQueuedInput } = await import('./restoreReviewAdmission.js')
const claude = await import('../services/api/claude.js')
const hooks = await import('./hooks.js')
const sessionStart = await import('./sessionStart.js')
const { createAttachmentMessage } = await import('./attachments.js')
function resumeContext(text: string): Awaited<ReturnType<typeof sessionStart.processSessionStartHooks>> {
  // The real additional-context variant is an attachment despite the legacy
  // SessionStart return annotation, which only names hook_result system rows.
  return [createAttachmentMessage({ type: 'hook_additional_context', content: [text],
    hookName: 'SessionStart', toolUseID: 'SessionStart', hookEvent: 'SessionStart' })] as unknown as Awaited<ReturnType<typeof sessionStart.processSessionStartHooks>>
}
const { ask } = await import('../QueryEngine.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('./fileStateCache.js')
const queue = await import('./messageQueueManager.js')
const { processQueueIfReady } = await import('./queueProcessor.js')
const spies: { mockRestore(): void }[] = []
let path: string
let seed: ReturnType<typeof createUserMessage>

beforeEach(async () => {
  await releaseActiveTranscriptLease()
  storage.resetProjectForTesting()
  const directory = join(root, randomUUID())
  mkdirSync(directory, { mode: 0o700 })
  bootstrap.switchSession(asSessionId(randomUUID()), directory)
  seed = createUserMessage({ content: 'saved request before interruption' })
  await storage.recordTranscript([seed])
  await storage.flushCurrentTranscriptDurably()
  path = storage.getTranscriptPathForSession(bootstrap.getSessionId())
})
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  queue.resetCommandQueue()
  await queue.flushQueueOperationsDurably()
  await releaseActiveTranscriptLease()
  storage.resetProjectForTesting()
})
afterAll(() => {
  if (previousMacro === undefined) delete macro.MACRO
  else macro.MACRO = previousMacro
  bootstrap.switchSession(asSessionId(oldSession), oldProject)
  for (const [key, value] of Object.entries({ CLAUDE_CONFIG_DIR: previous.config, TEST_ENABLE_SESSION_PERSISTENCE: previous.persistence, CLAUDE_CODE_SIMPLE: previous.simple, ANTHROPIC_API_KEY: previous.key })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

async function restoreTail() {
  appendFileSync(path, '{"type":"assistant","private":"damaged secret')
  return (await loadConversationForResume(bootstrap.getSessionId(), path, { mutable: true, interruptedTurn: 'ignore' }))!
}

test('ordinary terminal input is durable before admission even without a recovery hold', async () => {
  const gate = new RestoreReviewAdmission(false)
  const input = createUserMessage({ content: 'ordinary input after earlier work' })
  await gate.admitTerminalInput([seed, input], [input])
  const loaded = await storage.loadTranscriptFile(path, { strict: true, keepAllLeaves: true })
  expect(loaded.messages.has(input.uuid as never)).toBe(true)
  const failure = spyOn(storage, 'flushCurrentTranscriptDurably').mockRejectedValue(new Error('ordinary input sync failed'))
  const next = createUserMessage({ content: 'must not enter provider' })
  try { await expect(gate.admitTerminalInput([seed, input, next], [next])).rejects.toThrow('ordinary input sync failed') }
  finally { failure.mockRestore() }
})

test('real headless batching acknowledges every original identity only after the shared input receipt', async () => {
  const { runHeadlessStreaming } = await import('../cli/print.js')
  const { StructuredIO } = await import('../cli/structuredIO.js')
  const lifecycle = await import('./commandLifecycle.js')
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  const firstEntered = Promise.withResolvers<void>(), finishFirst = Promise.withResolvers<void>()
  const batchBarrier = Promise.withResolvers<void>(), releaseBatch = Promise.withResolvers<void>()
  const started: string[] = [], output: { type: string; uuid?: string; isReplay?: boolean }[] = []
  lifecycle.setCommandLifecycleListener((uuid, state) => { if (state === 'started') started.push(uuid) })
  const realFlush = storage.flushCurrentTranscriptDurably
  spies.push(spyOn(storage, 'flushCurrentTranscriptDurably').mockImplementation(async uuid => {
    if (uuid === ids[2]) { batchBarrier.resolve(); await releaseBatch.promise }
    await realFlush(uuid)
  }))
  let calls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    if (++calls === 1) { firstEntered.resolve(); await finishFirst.promise }
    else {
      const receipts = await storage.getSessionQueueOperations(bootstrap.getSessionId())
      expect(receipts.messageUuids.has(ids[1] as never)).toBe(true)
      expect(receipts.messageUuids.has(ids[2] as never)).toBe(true)
    }
    yield { type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), message: {
      id: randomUUID(), role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'accepted batch' }],
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason: 'end_turn', stop_sequence: null,
    } } as never
  }))
  const line = (index: number) => JSON.stringify({ type: 'user', uuid: ids[index], session_id: bootstrap.getSessionId(),
    parent_tool_use_id: null, message: { role: 'user', content: `headless input ${index}` } }) + '\n'
  async function* input() {
    yield line(0)
    await firstEntered.promise
    yield line(1)
    yield line(2)
    finishFirst.resolve()
  }
  const io = new StructuredIO(input(), false)
  let state = getDefaultAppState()
  const options = { systemPrompt: 'isolated batching test', userSpecifiedModel: 'gpt-5.6-terra',
    thinkingConfig: { type: 'disabled' }, verbose: false, replayUserMessages: true } as Parameters<typeof runHeadlessStreaming>[10]
  const consume = (async () => {
    for await (const frame of runHeadlessStreaming(io, [], [], [], [seed], async () => ({ behavior: 'allow', updatedInput: {} }), {},
      () => state, update => { state = update(state) }, [], options, { kind: 'none' }, false)) output.push(frame as never)
  })()
  try {
    await batchBarrier.promise
    expect(started).not.toContain(ids[1]!)
    expect(started).not.toContain(ids[2]!)
    expect(output.some(frame => frame.isReplay && frame.uuid === ids[1])).toBe(false)
    expect(calls).toBe(1)
    releaseBatch.resolve()
    await consume
    expect(calls).toBe(2)
    for (const id of ids) expect(started.filter(uuid => uuid === id)).toHaveLength(1)
    for (const id of ids) expect(output.some(frame => frame.isReplay && frame.uuid === id)).toBe(true)
  } finally {
    finishFirst.resolve(); releaseBatch.resolve()
    await consume
    lifecycle.setCommandLifecycleListener(null)
  }
}, 15_000)

test('terminal queued attachment cannot resume consumption before its durable receipt', async () => {
  const attachment = createAttachmentMessage({
    type: 'queued_command', commandMode: 'prompt', prompt: 'terminal mid-turn input', source_uuid: randomUUID(),
  } as never)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const realFlush = storage.flushCurrentTranscriptDurably
  const barrier = spyOn(storage, 'flushCurrentTranscriptDurably').mockImplementation(async uuid => {
    entered.resolve()
    await release.promise
    await realFlush(uuid)
  })
  let consumed = false
  async function* events() { yield attachment; consumed = true }
  const consumer = (async () => {
    for await (const event of events()) await persistTerminalQueuedInput([seed], event)
  })()
  try {
    await entered.promise
    expect(consumed).toBe(false)
    release.resolve()
    await consumer
    expect(consumed).toBe(true)
    const loaded = await storage.loadTranscriptFile(path, { strict: true, keepAllLeaves: true })
    expect(loaded.messages.has(attachment.uuid as never)).toBe(true)
  } finally { release.resolve(); barrier.mockRestore() }
})

test('real mutable loader preflights before hooks and terminal admission accepts only a fresh durable user row', async () => {
  let hookCalls = 0
  spies.push(spyOn(hooks, 'executeSessionStartHooks').mockImplementation(async function* () { hookCalls++ }))
  const loaded = await restoreTail()
  expect(hookCalls).toBe(0)
  expect(loaded.recoveryReviewRequired).toBe(true)
  const gate = new RestoreReviewAdmission(!!loaded.recoveryReviewRequired)
  for (const command of [{ mode: 'task-notification' }, { mode: 'prompt', isMeta: true }, { mode: 'prompt', origin: { kind: 'coordinator' } }]) {
    expect(gate.canProcessCommand(command)).toBe(false)
  }
  expect(gate.canProcessCommand({ mode: 'prompt' }, true)).toBe(false)
  await expect(gate.admitTerminalInput(loaded.messages, [])).rejects.toThrow('new user message')
  await expect(gate.admitTerminalInput([...loaded.messages, seed], [seed])).rejects.toThrow('new user message')
  const fresh = createUserMessage({ content: 'please review the saved progress' })
  await gate.admitTerminalInput([...loaded.messages, fresh], [fresh])
  expect(gate.canStartAutomaticTurn()).toBe(true)
  expect(new RestoreReviewAdmission(false).required).toBe(false)
  expect(readFileSync(path, 'utf8')).not.toContain('damaged secret')
})

test('a failed real persistence barrier keeps terminal review held across another restore', async () => {
  const loaded = await restoreTail()
  const gate = new RestoreReviewAdmission(true)
  const fresh = createUserMessage({ content: 'review attempt' })
  const barrier = spyOn(storage, 'flushCurrentTranscriptDurably').mockRejectedValue(new Error('isolated admission sync failure'))
  try { await expect(gate.admitTerminalInput([...loaded.messages, fresh], [fresh])).rejects.toThrow('admission sync failure') }
  finally { barrier.mockRestore() }
  expect(gate.required).toBe(true)
  expect(new RestoreReviewAdmission(false).required).toBe(true)
})

test('terminal admission rejects inline-only, synthetic, and command-output user rows', async () => {
  const loaded = await restoreTail()
  const gate = new RestoreReviewAdmission(true)
  const candidates = [
    createUserMessage({ content: 'inline display only', isVisibleInTranscriptOnly: true }),
    createUserMessage({ content: 'hidden instruction', isMeta: true }),
    createUserMessage({ content: '<local-command-stdout>automatic result</local-command-stdout>' }),
    createUserMessage({ content: '<bash-stdout>shell result</bash-stdout>' }),
    createUserMessage({ content: 'old summary', isCompactSummary: true }),
  ]
  for (const input of candidates) {
    await expect(gate.admitTerminalInput([...loaded.messages, input], [input])).rejects.toThrow('new user message')
    expect(gate.required).toBe(true)
  }
})

test('ordinary interrupted restore suppresses hooks and automatic replay without a tail journal', async () => {
  let hooksCalled = 0
  spies.push(spyOn(hooks, 'executeSessionStartHooks').mockImplementation(async function* () { hooksCalled++ }))
  const loaded = (await loadConversationForResume(bootstrap.getSessionId(), path, { mutable: true, interruptedTurn: 'ignore' }))!
  expect(loaded.recoveryReviewRequired).toBe(true)
  expect(hooksCalled).toBe(0)
  const gate = new RestoreReviewAdmission(!!loaded.recoveryReviewRequired)
  expect(gate.canStartAutomaticTurn()).toBe(false)
  const fresh = createUserMessage({ content: 'new explicit user instruction' })
  await gate.admitTerminalInput([...loaded.messages, fresh], [fresh])
  expect(gate.required).toBe(false)
})

test('the real queue processor preserves all input and makes no reservations while review is held', async () => {
  const gate = new RestoreReviewAdmission(true)
  const waiting = { mode: 'prompt' as const, uuid: randomUUID(), value: 'previously queued input' }
  const notification = { mode: 'task-notification' as const, uuid: randomUUID(), value: 'automatic task completion' }
  queue.enqueue(waiting)
  queue.enqueue(notification)
  await queue.flushQueueOperationsDurably()
  const snapshot = [...queue.getCommandQueueSnapshot()]
  const before = (await storage.getSessionQueueOperations(bootstrap.getSessionId())).operations
  let calls = 0
  const executeInput = async () => { calls++ }
  expect(processQueueIfReady({ executeInput, canProcessQueue: () => gate.canStartAutomaticTurn() })).toEqual({ processed: false })
  expect(queue.getCommandQueueSnapshot()).toEqual(snapshot)
  await queue.flushQueueOperationsDurably()
  expect((await storage.getSessionQueueOperations(bootstrap.getSessionId())).operations).toEqual(before)
  expect(calls).toBe(0)
  const input = createUserMessage({ content: 'fresh direct review, not the stored queue' })
  await gate.admitTerminalInput([seed, input], [input])
  expect(processQueueIfReady({ executeInput, canProcessQueue: () => gate.canStartAutomaticTurn() })).toEqual({ processed: true })
  expect(calls).toBe(1)
})

test('headless ask uses its real durable input callback before one synthetic provider entry', async () => {
  let hookCalls = 0
  spies.push(spyOn(sessionStart, 'processSessionStartHooks').mockImplementation(async source => {
    expect(source).toBe('resume')
    hookCalls++
    return resumeContext('required deferred resume policy')
  }))
  const loaded = await restoreTail()
  expect(hookCalls).toBe(0)
  const gate = new RestoreReviewAdmission(!!loaded.recoveryReviewRequired)
  let calls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* (params) {
    calls++
    expect(gate.required).toBe(false)
    expect(hookCalls).toBe(1)
    expect(JSON.stringify(params.messages)).toContain('required deferred resume policy')
    yield { type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), message: {
      id: randomUUID(), role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'review response' }],
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason: 'end_turn', stop_sequence: null,
    } } as never
  }))
  let state = getDefaultAppState()
  const cache = createFileStateCacheWithSizeLimit(20)
  expect(gate.canProcessCommand({ mode: 'prompt', isMeta: true })).toBe(false)
  expect(calls).toBe(0)
  for await (const _message of ask({ commands: [], tools: [], mcpClients: [], agents: [], prompt: 'fresh headless user review', promptUuid: randomUUID(),
    cwd: root, mutableMessages: loaded.messages, customSystemPrompt: 'isolated synthetic test', userSpecifiedModel: 'gpt-5.6-terra',
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }), getAppState: () => state, setAppState: update => { state = update(state) },
    getReadFileCache: () => cache, setReadFileCache: () => {}, onInputPersisted: () => gate.inputPersisted(),
  })) {}
  expect(calls).toBe(1)
})

test('terminal admission defers configured resume context until fresh input is durable', async () => {
  let hookCalls = 0
  spies.push(spyOn(sessionStart, 'processSessionStartHooks').mockImplementation(async () => {
    hookCalls++
    return resumeContext('terminal resume constraint')
  }))
  const loaded = await restoreTail()
  const gate = new RestoreReviewAdmission(true)
  expect(hookCalls).toBe(0)
  const input = createUserMessage({ content: 'fresh terminal review' })
  const context = await gate.admitTerminalInput([...loaded.messages, input], [input])
  expect(hookCalls).toBe(1)
  expect(JSON.stringify(context)).toContain('terminal resume constraint')
  expect(readFileSync(path, 'utf8')).toContain('terminal resume constraint')
  expect(gate.required).toBe(false)
})

test('real headless consumer makes no request on recovered EOF and admits one fresh stdin prompt', async () => {
  const loaded = await restoreTail()
  const { runHeadlessStreaming } = await import('../cli/print.js')
  const { StructuredIO } = await import('../cli/structuredIO.js')
  let hookCalls = 0
  spies.push(spyOn(sessionStart, 'processSessionStartHooks').mockImplementation(async () => {
    hookCalls++
    return resumeContext('journal-discovered deferred resume context')
  }))
  let calls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* (params) {
    calls++
    expect(JSON.stringify(params.messages)).toContain('journal-discovered deferred resume context')
    expect(new RestoreReviewAdmission(false).required).toBe(false)
    yield { type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), message: {
      id: randomUUID(), role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'headless reviewed once' }],
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason: 'end_turn', stop_sequence: null,
    } } as never
  }))
  const run = async (lines: string[]) => {
    async function* input() { yield* lines }
    const io = new StructuredIO(input(), false)
    let state = getDefaultAppState()
    const options = { systemPrompt: 'isolated synthetic test', userSpecifiedModel: 'gpt-5.6-terra',
      thinkingConfig: { type: 'disabled' }, verbose: false } as Parameters<typeof runHeadlessStreaming>[10]
    const frames = []
    for await (const frame of runHeadlessStreaming(io, [], [], [], [...loaded.messages],
      async () => ({ behavior: 'allow', updatedInput: {} }), {}, () => state, update => { state = update(state) }, [],
      options, loaded.turnInterruptionState, false)) frames.push(frame)
    return frames
  }
  await run([])
  expect(calls).toBe(0)
  expect(hookCalls).toBe(0)
  expect(new RestoreReviewAdmission(false).required).toBe(true)
  for (const extra of [
    { isMeta: true },
    { isVisibleInTranscriptOnly: true },
    { isReplay: true },
    { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'uncertain-tool', content: 'old output' }] } },
  ]) {
    await run([JSON.stringify({ type: 'user', uuid: randomUUID(), session_id: bootstrap.getSessionId(),
      parent_tool_use_id: null, message: { role: 'user', content: 'not a fresh review turn' }, ...extra }) + '\n'])
    expect(calls).toBe(0)
    expect(hookCalls).toBe(0)
    expect(new RestoreReviewAdmission(false).required).toBe(true)
    // These inputs must remain queued rather than reaching the provider.
    expect(queue.getCommandQueueSnapshot().length).toBeGreaterThan(0)
    queue.resetCommandQueue()
    await queue.flushQueueOperationsDurably()
  }
  await run([JSON.stringify({ type: 'user', uuid: randomUUID(), session_id: bootstrap.getSessionId(),
    parent_tool_use_id: null, message: { role: 'user', content: 'fresh explicit headless review' } }) + '\n'])
  expect(calls).toBe(1)
  expect(hookCalls).toBe(1)
}, 20_000)
