import { expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { createFileStateCacheWithSizeLimit } from './fileStateCache.js'
import { SDKAssistantMessageSchema, SDKUserMessageSchema, SDKUserMessageReplaySchema, SDKCodeModeMetadataSchema } from '../entrypoints/sdk/coreSchemas.js'
import { createAssistantMessage, createUserMessage, normalizeMessages, normalizeMessagesForAPI } from './messages.js'
import { cleanMessagesForLogging, loadTranscriptFile } from './sessionStorage.js'
import { normalizeMessage } from './queryHelpers.js'
import { toSDKMessages } from './messages/mappers.js'
import { isEligibleBridgeMessage } from '../bridge/bridgeMessaging.js'
import { collectPermissionDecisionContexts } from './permissions/permissionDecisionContext.js'
import { appendPostCompactRuntimeAttachments, buildPostCompactMessages } from '../services/compact/compact.js'
import type { ToolUseContext } from '../Tool.js'
import type { Message } from '../types/message.js'
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const codeMode = { cellId: 'cell-1', generation: 'generation-1', line: 3 }
const codeModeBuild = feature('CODE_MODE') ? true : false
function fixture() {
  const outer = createAssistantMessage({ content: [{ type: 'tool_use', id: codeMode.cellId, name: 'REPL', input: { code: 'await tools.Read({file_path: "secret"})' } }] })
  const child = createAssistantMessage({ codeMode, content: [{ type: 'tool_use', id: 'child-1', name: 'Read', input: { file_path: 'secret' } }] })
  const result = createUserMessage({ codeMode, sourceToolAssistantUUID: child.uuid as import('node:crypto').UUID, content: [{ type: 'tool_result', tool_use_id: 'child-1', is_error: true, content: 'hidden intermediate payload' }], permissionDecision: { version: 1, toolUseId: 'child-1', assistantUuid: child.uuid, toolName: 'Read', input: { file_path: 'secret' }, outcome: 'rejected-by-user' } })
  const selected = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: codeMode.cellId, content: 'selected output' }] })
  return { child, result, messages: [outer, child, result, selected] }
}

test.skipIf(codeModeBuild)('legacy REPL export transform still promotes legacy virtual records only', () => {
  const legacyOuter = createAssistantMessage({ content: [{ type: 'tool_use', id: 'legacy-repl', name: 'REPL', input: { code: 'legacy' } }] })
  const legacyChild = createAssistantMessage({ isVirtual: true, content: [{ type: 'tool_use', id: 'legacy-read', name: 'Read', input: {} }] })
  const legacyResult = createUserMessage({ isVirtual: true, content: [{ type: 'tool_result', tool_use_id: 'legacy-read', content: 'legacy data' }] })
  const legacySelected = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'legacy-repl', content: 'legacy selected' }] })
  const { child, result } = fixture()
  const logged = cleanMessagesForLogging([legacyOuter, legacyChild, legacyResult, legacySelected, child, result])
  expect(logged.map(message => message.uuid)).toEqual([legacyChild.uuid, legacyResult.uuid, child.uuid, result.uuid])
  expect(logged[0]).not.toHaveProperty('isVirtual')
  expect(logged[1]).not.toHaveProperty('isVirtual')
  expect(logged[2]).toMatchObject({ isVirtual: true, codeMode })
  expect(logged[3]).toMatchObject({ isVirtual: true, codeMode })
})

test.skipIf(!codeModeBuild).each([
  { name: 'no-child success', code: 'console.log(\"exact selected output\")', content: 'exact selected output', error: false },
  { name: 'parse error before execution', code: 'const broken = (', content: 'SyntaxError: Unexpected end of input', error: true },
  { name: 'blocked before tool.call', code: 'await tools.Bash({command:\"blocked\"})', content: 'Permission denied before execution', error: true },
])('modern REPL first-save and no-child $name survive restore', async ({ code, content, error }) => {
  const outer = createAssistantMessage({ content: [{ type: 'tool_use', id: 'outer-no-children', name: 'REPL', input: { code } }] })
  const result = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'outer-no-children', content, is_error: error }] })
  // The first write has neither a result nor future child metadata available.
  const firstWrite = cleanMessagesForLogging([outer])
  expect(firstWrite).toEqual([outer])
  expect(outer.isVirtual).toBeUndefined()
  const resultWrite = cleanMessagesForLogging([result], [outer, result])
  expect(resultWrite).toEqual([result])
  expect(result.isVirtual).toBeUndefined()
  const directory = await mkdtemp(join(tmpdir(), 'code-mode-incremental-'))
  try {
    const path = join(directory, 'history.jsonl')
    let parentUuid: string | null = null
    const serialize = (messages: typeof firstWrite) => messages.map(message => {
      const row = { ...message, parentUuid, sessionId: 'fixture-session', cwd: directory, version: 'fixture', isSidechain: false }
      parentUuid = message.uuid
      return JSON.stringify(row)
    }).join('\n') + '\n'
    await writeFile(path, serialize(firstWrite))
    const firstRestore = [...(await loadTranscriptFile(path, { strict: true })).messages.values()] as Message[]
    expect(firstRestore).toHaveLength(1)
    expect(firstRestore[0]).toMatchObject({ message: outer.message })
    await appendFile(path, serialize(resultWrite))
    const restored = [...(await loadTranscriptFile(path, { strict: true })).messages.values()] as Message[]
    expect(restored.filter(message => message.type === 'assistant' || message.type === 'user').map(message => message.message)).toEqual([outer.message, result.message])
    for (const provider of ['firstParty', 'openai'] as const) {
      const text = JSON.stringify(normalizeMessagesForAPI(restored, [], provider))
      expect(text).toContain(JSON.stringify(code).slice(1, -1))
      expect(text).toContain(content)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test.skipIf(!codeModeBuild).each(['invalid-input', 'validation-denied', 'permission-denied'] as const)(
  'actual REPL lifecycle persists %s before tool.call',
  async outcome => {
    const { REPLTool } = await import('../tools/REPLTool/REPLTool.js')
    const { runToolUse } = await import('../services/tools/toolExecution.js')
    let executions = 0
    const input = outcome === 'invalid-input'
      ? { code: 'exact rejected source' }
      : { code: 'exact rejected source', description: 'Offline fixture' }
    const call = { type: 'tool_use' as const, id: `pre-call-${outcome}`, name: 'REPL', input, caller: { type: 'direct' as const } }
    const parent = createAssistantMessage({ content: [call] })
    const state = { toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} },
      mcp: { tools: [], clients: [] }, tasks: {}, sessionHooks: new Map() }
    const context = {
      options: { commands: [], debug: false, mainLoopModel: 'gpt-6.1-sol', tools: [REPLTool], verbose: false, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true },
      abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10), messages: [parent],
      getAppState: () => state,
      setAppState: (update: (s: typeof state) => Partial<typeof state>) => Object.assign(state, update(state)),
      setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
      ...(outcome === 'permission-denied' ? { codeModeHost: { async run() { executions++; throw new Error('Denied REPL executed') } } } : {}),
    } as unknown as ToolUseContext
    const recorded = [...cleanMessagesForLogging([parent])]
    for await (const update of runToolUse(call, parent, async () => ({
      behavior: 'deny', message: 'Offline permission denial',
      decisionReason: { type: 'other', reason: 'Offline fixture denial' },
    }), context)) {
      if (update.message) recorded.push(...cleanMessagesForLogging([update.message], [parent, update.message]))
    }
    expect(executions).toBe(0)
    expect(recorded[0]).toEqual(parent)
    expect(recorded.some(message => message.type === 'user' && Array.isArray(message.message.content) &&
      message.message.content.some(block => block.type === 'tool_result' && block.tool_use_id === call.id && block.is_error))).toBe(true)
    expect(JSON.stringify(recorded)).toContain('exact rejected source')
  },
)

test.skipIf(!codeModeBuild)('modern build never promotes hidden intermediates even with runtime REPL disabled', () => {
  const previous = process.env.CLAUDE_CODE_REPL
  process.env.CLAUDE_CODE_REPL = '0'
  try {
    const { messages } = fixture()
    const untaggedVirtual = createUserMessage({ isVirtual: true, content: 'hidden legacy intermediate' })
    const logged = cleanMessagesForLogging([...messages, untaggedVirtual])
    expect(logged).toEqual([...messages, untaggedVirtual])
    expect(JSON.stringify(normalizeMessagesForAPI(logged as Message[]))).not.toContain('hidden')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_REPL
    else process.env.CLAUDE_CODE_REPL = previous
  }
})

test('SDK schemas retain bounded Code Mode metadata on live, restored and replay frames', () => {
  const { child, result } = fixture()
  for (const message of [child, result]) {
    const schema = message.type === 'assistant' ? SDKAssistantMessageSchema() : SDKUserMessageSchema()
    for (const frame of [...normalizeMessage(message), ...toSDKMessages([message])]) {
      expect(schema.parse(frame)).toMatchObject({ code_mode: codeMode, isVirtual: true, parent_tool_use_id: null })
      expect(schema.safeParse({ ...frame, isVirtual: false }).success).toBe(false)
    }
  }
  const user = toSDKMessages([result])[0]!
  expect(SDKUserMessageReplaySchema().parse({ ...user, isReplay: true })).toMatchObject({ code_mode: codeMode, isVirtual: true })
  for (const invalid of [
    { ...codeMode, cellId: '' }, { ...codeMode, cellId: 'x'.repeat(257) },
    { ...codeMode, generation: '' }, { ...codeMode, generation: 'x'.repeat(257) },
    { ...codeMode, generation: 'bad\0generation' }, { ...codeMode, line: 0 },
    { ...codeMode, line: 1.5 }, { ...codeMode, line: 1_000_001 },
    { ...codeMode, extra: 'untrusted' },
  ]) expect(SDKCodeModeMetadataSchema().safeParse(invalid).success).toBe(false)
})

test('Code Mode audit survives external logging, restore, provider filtering and SDK projection', async () => {
  const { messages, child, result } = fixture()
  const logged = cleanMessagesForLogging(messages)
  expect(logged).toEqual(messages)
  expect(cleanMessagesForLogging([result], messages)).toEqual([result])
  for (const provider of ['firstParty', 'openai'] as const) {
    const text = JSON.stringify(normalizeMessagesForAPI(logged as Message[], [], provider))
    expect(text).toContain('selected output')
    expect(text).toContain('await tools.Read')
    expect(text).not.toContain('hidden intermediate payload')
    expect(text).not.toContain('child-1')
  }
  for (const message of [child, result]) {
    expect(message.isVirtual).toBe(true)
    expect(isEligibleBridgeMessage(message)).toBe(false)
    for (const frame of [...normalizeMessage(message), ...toSDKMessages([message])]) {
      expect(frame).toMatchObject({ code_mode: codeMode, isVirtual: true, parent_tool_use_id: null })
    }
    for (const normalized of normalizeMessages([message])) expect(normalized).toMatchObject({ codeMode, isVirtual: true })
  }
  const directory = await mkdtemp(join(tmpdir(), 'code-mode-audit-'))
  try {
    const path = join(directory, 'transcript.jsonl')
    let parentUuid: string | null = null
    await writeFile(path, logged.map(message => {
      const row = { ...message, parentUuid, sessionId: 'fixture-session', cwd: directory, version: 'fixture', isSidechain: false }
      parentUuid = message.uuid
      return JSON.stringify(row)
    }).join('\n') + '\n')
    const restored = [...(await loadTranscriptFile(path, { strict: true })).messages.values()] as Message[]
    expect(collectPermissionDecisionContexts(restored)).toHaveLength(1)
    expect(JSON.stringify(normalizeMessagesForAPI(restored))).not.toContain('hidden intermediate payload')
    expect(toSDKMessages(restored).filter(frame => 'code_mode' in frame)).toHaveLength(2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('hidden linked refusals survive repeated compaction without promoting payloads', async () => {
  const { messages, result } = fixture()
  expect(collectPermissionDecisionContexts(messages)).toEqual([result.permissionDecision!])
  const context = { messages, options: {}, getAppState: () => ({ tasks: {} }) } as unknown as ToolUseContext
  let current = messages as Message[]
  for (let i = 0; i < 2; i++) {
    const compact = await appendPostCompactRuntimeAttachments({
      boundaryMarker: { type: 'system', uuid: `boundary-${i}`, subtype: 'compact_boundary' },
      summaryMessages: [createUserMessage({ content: 'summary', isCompactSummary: true })],
      attachments: [], hookResults: [],
    }, context, current)
    current = buildPostCompactMessages(compact)
    expect(collectPermissionDecisionContexts(current)).toEqual([result.permissionDecision!])
    expect(JSON.stringify(normalizeMessagesForAPI(current))).not.toContain('hidden intermediate payload')
  }
  expect(collectPermissionDecisionContexts([messages[0]!, messages[3]!])).toEqual([])
})
