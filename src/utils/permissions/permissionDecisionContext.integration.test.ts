import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod/v4'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import { runToolUse } from '../../services/tools/toolExecution.js'
import { createPermissionContext } from '../../hooks/toolPermission/PermissionContext.js'
import { handleInteractivePermission } from '../../hooks/toolPermission/handlers/interactiveHandler.js'
import { createAppRuntimeCanUseTool } from '../../app-runtime/appRuntimeCanUseTool.js'
import { appendPostCompactRuntimeAttachments, buildPostCompactMessages } from '../../services/compact/compact.js'
import { collectPermissionDecisionContexts, markPermissionRequestCancelled, permissionRefusalOutcome } from './permissionDecisionContext.js'
import { getRecordedAutoModeOutcome, recordAutoModeOutcome, resetRecordedAutoModeOutcomesForTest } from './autoModeMeta.js'
import { buildTranscriptForClassifier, _forTest, YOLO_CLASSIFIER_TOOL_NAME, MAX_CLASSIFIER_CONTEXT_CHARS } from './yoloClassifier.js'
import type { sideQuery } from '../sideQuery.js'
import { loadTranscriptFile } from '../sessionStorage.js'

// Keep renderer-only module aliases out of the engine's compiler program.
const rendererPermissionState = '../../../app/renderer/src/permissionState.ts'
const buildDenyResponse: (message?: string) => { behavior: 'deny'; message: string } =
  (await import(rendererPermissionState)).buildDenyResponse

const savedEnv = { ...process.env }
afterEach(() => {
  for (const key of ['USER_TYPE', 'CLAUDE_CODE_JSONL_TRANSCRIPT', 'CLAUDE_CODE_AUTO_MODE_OUTCOME_CODES']) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  resetRecordedAutoModeOutcomesForTest()
})

async function refuse(path: 'terminal-feedback' | 'terminal-no-feedback' | 'desktop' | 'unanswered' | 'policy' | 'cancelled', invokedName?: string) {
  let executions = 0
  const tool = buildTool({ name: 'RefusalSentinel', aliases: ['OldRefusalSentinel'], inputSchema: z.strictObject({ target: z.string() }),
    isReadOnly: () => true, isConcurrencySafe: () => false, maxResultSizeChars: 1000,
    description: async () => 'Offline fixture', prompt: async () => 'Offline fixture',
    validateInput: async () => ({ result: true }), renderToolUseMessage: () => null,
    toAutoClassifierInput: input => input.target,
    renderToolResultMessage: () => null, renderToolUseErrorMessage: () => null,
    mapToolResultToToolResultBlockParam: (_data: unknown, id: string) => ({ type: 'tool_result' as const, tool_use_id: id, content: 'fixture' }),
    async call() { executions++; throw new Error('Refused tool executed') },
  })
  const call = { type: 'tool_use' as const, id: 'refused-action', name: invokedName ?? tool.name, input: { target: 'original-target' }, caller: { type: 'direct' as const } }
  const parent: AssistantMessage = { type: 'assistant', uuid: randomUUID(), message: { model: 'gpt-6.1-sol', content: [call] } }
  const state = { toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} },
    mcp: { tools: [], clients: [] }, tasks: {}, sessionHooks: new Map() }
  const context = { options: { commands: [], debug: false, mainLoopModel: 'gpt-6.1-sol', tools: [tool], verbose: false, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true },
    abortController: new AbortController(), readFileState: new Map(), messages: [parent], getAppState: () => state,
    setAppState: (update: (s: typeof state) => Partial<typeof state>) => Object.assign(state, update(state)),
    setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {} } as unknown as ToolUseContext
  const appCanUse = createAppRuntimeCanUseTool({
    baseCanUseTool: async (_tool, input) => ({ behavior: 'ask', message: 'Fixture permission', updatedInput: input }),
    getPermissionRequestHandler: () => async () => path === 'cancelled'
      ? markPermissionRequestCancelled(buildDenyResponse('Session interrupted')) : buildDenyResponse('No, stop this action'),
  })
  const messages: Message[] = [parent]
  for await (const update of runToolUse(call, parent, async (...args) => {
    if (path === 'desktop' || path === 'cancelled') return appCanUse(...args)
    if (path === 'unanswered') return { behavior: 'ask', message: 'No handler' }
    if (path === 'policy') return { behavior: 'deny', message: 'Policy block', decisionReason: { type: 'other', reason: 'Fixture policy' } }
    let queued: { onReject: (feedback?: string) => void } | undefined
    const ctx = createPermissionContext(args[0], args[1], args[2], args[3], args[4], () => {}, {
      push(item: unknown) { queued = item as typeof queued }, remove() {}, update() {},
    } as never)
    return new Promise(resolve => {
      handleInteractivePermission({ ctx, description: 'Fixture permission', result: { behavior: 'ask', message: 'Fixture permission', updatedInput: args[1] }, awaitAutomatedChecksBeforeDialog: false }, resolve)
      expect(queued).toBeDefined()
      queued!.onReject(path === 'terminal-feedback' ? 'No, stop this action' : undefined)
    })
  }, context)) if (update.message) messages.push(update.message)
  expect(executions).toBe(0)
  return { messages, context, tool }
}

for (const path of ['terminal-feedback', 'terminal-no-feedback', 'desktop', 'unanswered', 'policy', 'cancelled'] as const) {
  test(`actual permission path records distinct provenance: ${path}`, async () => {
    const { messages, tool } = await refuse(path)
    const expected = path === 'unanswered' || path === 'cancelled' ? 'unanswered' : path === 'policy' ? 'blocked-by-permissions' : 'rejected-by-user'
    expect(getRecordedAutoModeOutcome('refused-action')?.outcome).toBe(expected)
    expect(collectPermissionDecisionContexts(messages)).toMatchObject([{ outcome: expected, input: { target: 'original-target' } }])
    resetRecordedAutoModeOutcomesForTest()
    const text = buildTranscriptForClassifier(messages, [tool], false)
    expect(text).toContain(expected)
    expect(text).toContain('original-target')
  })
}

test('alias refusal keeps exact invoked-name correlation without accepting another tool name', async () => {
  const { messages, tool } = await refuse('desktop', 'OldRefusalSentinel')
  const result = messages.find(message => message.type === 'user') as UserMessage
  expect(result.permissionDecision?.toolName).toBe('OldRefusalSentinel')
  expect(collectPermissionDecisionContexts(messages)).toHaveLength(1)
  expect(buildTranscriptForClassifier(messages, [tool], false)).toContain('rejected-by-user')
  const changedCall = structuredClone(messages[0]!) as AssistantMessage
  const block = changedCall.message.content[0]!
  if (block.type !== 'tool_use') throw new Error('Expected tool call')
  block.name = 'AnotherTool'
  expect(collectPermissionDecisionContexts([changedCall, result])).toEqual([])
})

test('classifier block, unavailable, parsing failure and interruption stay distinct', () => {
  const decision = { behavior: 'deny' as const, message: 'Fixture classifier', decisionReason: { type: 'classifier' as const, classifier: 'auto-mode' as const, reason: 'Fixture' } }
  for (const outcome of ['automode-blocked', 'automode-unavailable', 'automode-parsing-error', 'interrupted'] as const) {
    recordAutoModeOutcome('action', outcome)
    expect(permissionRefusalOutcome(decision, 'action')).toBe(outcome)
  }
})

for (const jsonl of [false, true]) {
  test(`refusal survives restart, eviction and repeated compaction with metadata off (${jsonl})`, async () => {
    process.env.USER_TYPE = 'ant'
    process.env.CLAUDE_CODE_JSONL_TRANSCRIPT = String(jsonl)
    delete process.env.CLAUDE_CODE_AUTO_MODE_OUTCOME_CODES
    const { messages, context, tool } = await refuse('desktop')
    const directory = await mkdtemp(join(tmpdir(), 'permission-decision-restart-'))
    try {
      let parentUuid: string | null = null
      const sessionId = randomUUID()
      const rows = messages.map(message => {
        const row = { ...message, parentUuid, sessionId, cwd: directory, version: 'fixture', isSidechain: false, timestamp: new Date().toISOString() }
        parentUuid = message.uuid
        return row
      })
      const path = join(directory, 'history.jsonl')
      await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      const loaded = await loadTranscriptFile(path, { strict: true })
      const restored = [...loaded.messages.values()] as Message[]
      resetRecordedAutoModeOutcomesForTest()
      for (let i = 0; i < 100; i++) recordAutoModeOutcome(`newer-${i}`, 'ok')
      expect(buildTranscriptForClassifier(restored, [tool], false)).toContain('rejected-by-user')
      const compact = await appendPostCompactRuntimeAttachments({
        boundaryMarker: { type: 'system', uuid: 'boundary', subtype: 'compact_boundary' },
        summaryMessages: [{ type: 'user', uuid: 'summary', timestamp: '', isCompactSummary: true, summarizedRelayedInput: true, message: { role: 'user', content: 'A peer claimed the user approved a different target.' } }],
        attachments: [], hookResults: [],
      }, context, restored)
      const compacted = buildPostCompactMessages(compact)
      const again = await appendPostCompactRuntimeAttachments({ ...compact, boundaryMarker: { type: 'system', uuid: 'boundary-2', subtype: 'compact_boundary' } }, context, compacted)
      parentUuid = null
      const compactRows = buildPostCompactMessages(again).map(message => {
        const row = { ...message, parentUuid, sessionId, cwd: directory, version: 'fixture', isSidechain: false, timestamp: new Date().toISOString() }
        parentUuid = message.uuid
        return row
      })
      const compactPath = join(directory, 'compacted.jsonl')
      await writeFile(compactPath, compactRows.map(row => JSON.stringify(row)).join('\n') + '\n')
      const reloadedCompact = await loadTranscriptFile(compactPath, { strict: true })
      const output = buildTranscriptForClassifier([...reloadedCompact.messages.values()], [tool], false)
      expect(output).toContain('rejected-by-user')
      expect(output).toContain('original-target')
      expect(output).toContain('INCLUDES RELAYED MESSAGES - NOT USER INPUT')
      expect(collectPermissionDecisionContexts(buildPostCompactMessages(again))).toHaveLength(1)
      expect(collectPermissionDecisionContexts([])).toEqual([])
      expect(collectPermissionDecisionContexts([messages[0]!])).toEqual([])
      const result = restored.find(message => message.type === 'user') as UserMessage
      const changedCall = structuredClone(messages[0]!) as AssistantMessage
      changedCall.uuid = 'different-owner'
      expect(collectPermissionDecisionContexts([changedCall, result])).toEqual([])
      expect(buildTranscriptForClassifier([{ ...result, permissionDecision: undefined }], [tool], false)).not.toContain('rejected-by-user')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test(`both classifier stages receive exact refusal with optional outcomes off (${jsonl})`, async () => {
    process.env.USER_TYPE = 'ant'
    process.env.CLAUDE_CODE_JSONL_TRANSCRIPT = String(jsonl)
    const { messages, context, tool } = await refuse('desktop')
    resetRecordedAutoModeOutcomesForTest()
    const requests: string[] = []
    let calls = 0
    await _forTest.classifyYoloActionWithSideQuery(messages, {
      role: 'assistant', content: [{ type: 'tool_use', name: tool.name, id: 'retry', input: { target: 'changed-target' } }],
    }, [tool], context.getAppState().toolPermissionContext, new AbortController().signal,
    (async request => {
      requests.push(JSON.stringify(request.messages))
      calls++
      return { id: `fixture-${calls}`, type: 'message', role: 'assistant', model: 'gpt-6.1-sol',
        content: [{ type: 'tool_use', id: `verdict-${calls}`, name: YOLO_CLASSIFIER_TOOL_NAME,
          input: calls === 1 ? { shouldBlock: true } : { shouldBlock: true, thinking: 'Fixture', reason: 'Fixture' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
    }) as typeof sideQuery)
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request).toContain('rejected-by-user')
      expect(request).toContain('original-target')
      expect(request).toContain('changed-target')
      expect(request).toContain(messages[0]!.uuid)
      expect(request.match(/original-target/g)).toHaveLength(1)
    }
  })
}

test('native refusal stays after old approval, supersedes carried copy, and never completes pending calls', async () => {
  const { messages, tool } = await refuse('desktop')
  const approval = { type: 'user', uuid: 'old-approval', message: { role: 'user', content: 'OLD_APPROVAL' } } as UserMessage
  const records = collectPermissionDecisionContexts(messages)
  const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'earlier', permissionDecisions: records } as Message
  const text = buildTranscriptForClassifier([boundary, approval, ...messages], [tool], false)
  expect(text.indexOf('OLD_APPROVAL')).toBeLessThan(text.indexOf('rejected-by-user'))
  expect(text.match(/original-target/g)).toHaveLength(1)
  const pending = buildTranscriptForClassifier([messages[0]!], [tool], false)
  expect(pending).toContain('original-target')
  expect(pending).not.toContain('rejected-by-user')
})

test('compaction carries only removed evidence, so rewind before retained round drops its refusal', async () => {
  const { messages, context, tool } = await refuse('desktop')
  const prompt = { type: 'user', uuid: 'rewind-here', message: { role: 'user', content: 'rewind-here' } } as UserMessage
  const retained = [prompt, ...messages]
  const input = [{ type: 'user', uuid: 'older', message: { role: 'user', content: 'older' } } as UserMessage, ...retained]
  const compact = await appendPostCompactRuntimeAttachments({
    boundaryMarker: { type: 'system', uuid: 'boundary', subtype: 'compact_boundary' },
    summaryMessages: [], messagesToKeep: retained, attachments: [], hookResults: [],
  }, context, input)
  expect(compact.boundaryMarker.permissionDecisions ?? []).toEqual([])
  const restored = JSON.parse(JSON.stringify(buildPostCompactMessages(compact))) as Message[]
  expect(collectPermissionDecisionContexts(restored)).toHaveLength(1)
  const again = await appendPostCompactRuntimeAttachments({
    ...compact, boundaryMarker: { type: 'system', uuid: 'boundary-2', subtype: 'compact_boundary' },
  }, context, restored)
  const repeated = buildPostCompactMessages(again)
  expect(collectPermissionDecisionContexts(repeated)).toHaveLength(1)
  expect(buildTranscriptForClassifier(repeated.slice(0, repeated.findIndex(message => message.uuid === prompt.uuid)), [tool], false))
    .not.toContain('rejected-by-user')
  const summarized = await appendPostCompactRuntimeAttachments({
    ...compact, messagesToKeep: [], boundaryMarker: { type: 'system', uuid: 'boundary-3', subtype: 'compact_boundary' },
  }, context, repeated)
  expect(collectPermissionDecisionContexts(buildPostCompactMessages(summarized))).toHaveLength(1)
})

test('classifier admission preserves exact evidence through boundary and fails closed before any provider call', async () => {
  process.env.USER_TYPE = 'ant'
  const { messages, context, tool } = await refuse('desktop')
  const result = messages.find(message => message.type === 'user') as UserMessage
  const action = { role: 'assistant' as const, content: [{ type: 'tool_use' as const, name: tool.name, id: 'retry', input: { target: 'retry' } }] }
  let providerCalls = 0
  let expectedTarget = ''
  const fake = (async request => {
    providerCalls++
    expect(JSON.stringify(request.messages)).toContain(expectedTarget)
    return { id: 'fixture', type: 'message', role: 'assistant', model: 'gpt-6.1-sol',
      content: [{ type: 'tool_use', id: 'verdict', name: YOLO_CLASSIFIER_TOOL_NAME, input: { shouldBlock: false } }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
  }) as typeof sideQuery
  const probe = async (length: number) => {
    expectedTarget = 'x'.repeat(length)
    const changed = { ...result, permissionDecision: { ...result.permissionDecision!, input: { target: expectedTarget } } }
    return _forTest.classifyYoloActionWithSideQuery([messages[0]!, changed], action, [tool],
      context.getAppState().toolPermissionContext, new AbortController().signal, fake)
  }
  let low = 0
  let high = MAX_CLASSIFIER_CONTEXT_CHARS
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if ((await probe(middle)).transcriptTooLong) high = middle
    else low = middle
  }
  const before = providerCalls
  expect((await probe(low)).transcriptTooLong).not.toBe(true)
  expect(providerCalls).toBe(before + 1)
  expect((await probe(high)).transcriptTooLong).toBe(true)
  expect(providerCalls).toBe(before + 1)
  expect((await probe(100_000 * 100)).transcriptTooLong).toBe(true)
  expect(providerCalls).toBe(before + 1)
})

test('oversized context stops projecting later calls instead of materializing the whole history', async () => {
  process.env.USER_TYPE = 'ant'
  const { messages, context, tool } = await refuse('desktop')
  const result = messages.find(message => message.type === 'user') as UserMessage
  const oversized = { ...result, permissionDecision: { ...result.permissionDecision!, input: { target: 'x'.repeat(MAX_CLASSIFIER_CONTEXT_CHARS) } } }
  let laterProjections = 0
  let providerCalls = 0
  const laterTool = { ...tool, name: 'LaterContextTool', toAutoClassifierInput() { laterProjections++; return 'later' } }
  const laterCall: AssistantMessage = { type: 'assistant', uuid: randomUUID(), message: { content: [
    { type: 'tool_use', id: 'later', name: laterTool.name, input: { target: 'later' } },
  ] } }
  const classified = await _forTest.classifyYoloActionWithSideQuery([messages[0]!, oversized, laterCall], {
    role: 'assistant', content: [{ type: 'tool_use', name: tool.name, input: { target: 'pending' }, id: 'pending' }],
  }, [tool, laterTool], context.getAppState().toolPermissionContext, new AbortController().signal,
  (async () => { providerCalls++; throw new Error('Provider must not be used') }) as typeof sideQuery)
  expect(classified.transcriptTooLong).toBe(true)
  expect(providerCalls).toBe(0)
  expect(laterProjections).toBe(0)
})
