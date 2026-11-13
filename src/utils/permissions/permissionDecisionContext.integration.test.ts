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
import { buildTranscriptForClassifier, _forTest, YOLO_CLASSIFIER_TOOL_NAME } from './yoloClassifier.js'
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

async function refuse(path: 'terminal-feedback' | 'terminal-no-feedback' | 'desktop' | 'unanswered' | 'policy' | 'cancelled') {
  let executions = 0
  const tool = buildTool({ name: 'RefusalSentinel', inputSchema: z.strictObject({ target: z.string() }),
    isReadOnly: () => true, isConcurrencySafe: () => false, maxResultSizeChars: 1000,
    description: async () => 'Offline fixture', prompt: async () => 'Offline fixture',
    validateInput: async () => ({ result: true }), renderToolUseMessage: () => null,
    toAutoClassifierInput: input => input.target,
    renderToolResultMessage: () => null, renderToolUseErrorMessage: () => null,
    mapToolResultToToolResultBlockParam: (_data: unknown, id: string) => ({ type: 'tool_result' as const, tool_use_id: id, content: 'fixture' }),
    async call() { executions++; throw new Error('Refused tool executed') },
  })
  const call = { type: 'tool_use' as const, id: 'refused-action', name: tool.name, input: { target: 'original-target' }, caller: { type: 'direct' as const } }
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
    expect(requests.length).toBeGreaterThanOrEqual(1)
    for (const request of requests) {
      expect(request).toContain('rejected-by-user')
      expect(request).toContain('original-target')
      expect(request).toContain('changed-target')
    }
  })
}
