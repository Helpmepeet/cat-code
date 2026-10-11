import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = await mkdtemp(join(tmpdir(), 'session-memory-mutation-'))
const previousEnv = { ...process.env }
process.env.CLAUDE_CONFIG_DIR = join(fixture, 'config')
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
process.env.DISABLE_TELEMETRY = '1'
const realFetch = globalThis.fetch
globalThis.fetch = (async () => { throw new Error('Network forbidden in session memory regression') }) as unknown as typeof fetch
const state = await import('../../bootstrap/state.js')
state.setCwdState(fixture)
state.setOriginalCwd(fixture)
state.setProjectRoot(fixture)
// Import the real query graph first, then replace only the external model
// response. Tool dispatch, permissions, prepared file mutation and persistence
// are deliberately exercised rather than reimplemented by the fixture.
await import('../../query.js')
const realClaude = await import('../api/claude.js')
const { createAssistantMessage, createUserMessage } = await import('../../utils/messages.js')
let call = 0
let toolCall: { name: string; input: unknown } | undefined
let sawPermissionDenial = false
let enableHookExecution = false
mock.module('../api/claude.js', () => ({
  ...realClaude,
  queryModelWithStreaming: async function* (params: { messages: import('../../types/message.js').Message[] }) {
    call++
    if (enableHookExecution) process.env.CLAUDE_CODE_SIMPLE = '0'
    sawPermissionDenial ||= JSON.stringify(params.messages).includes('only ')
    const message = createAssistantMessage({ content: call === 1 && toolCall
      ? [{ type: 'tool_use', id: 'notes-mutation', name: toolCall.name, input: toolCall.input as Record<string, unknown> }]
      : 'Done' })
    message.message.stop_reason = call === 1 && toolCall ? 'tool_use' : 'end_turn'
    yield message
  },
}))
const { manuallyExtractSessionMemory, createMemoryFileCanUseTool, initSessionMemory, resetLastMemoryMessageUuid } = await import('./sessionMemory.js')
const { DEFAULT_SESSION_MEMORY_TEMPLATE } = await import('./prompts.js')
const { getSessionMemoryDir, getSessionMemoryPath } = await import('../../utils/permissions/filesystem.js')
const { getLastSummarizedMessageId, resetSessionMemoryState } = await import('./sessionMemoryUtils.js')
const { getAllBaseTools } = await import('../../tools.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../../utils/fileStateCache.js')
const { clearPostSamplingHooks, executePostSamplingHooks } = await import('../../utils/hooks/postSamplingHooks.js')
const { getGlobalConfig, saveGlobalConfig } = await import('../../utils/config.js')
const { resetHooksConfigSnapshot } = await import('../../utils/hooks/hooksConfigSnapshot.js')
const { resetSettingsCache } = await import('../../utils/settings/settingsCache.js')
const previousConfig = { ...getGlobalConfig() }

beforeEach(async () => {
  resetSessionMemoryState()
  resetLastMemoryMessageUuid()
  call = 0
  sawPermissionDenial = false
  toolCall = undefined
  await mkdir(getSessionMemoryDir(), { recursive: true })
  await writeFile(getSessionMemoryPath(), DEFAULT_SESSION_MEMORY_TEMPLATE)
  await writeFile(join(fixture, 'other.md'), 'Keep this unchanged\n')
})
afterAll(async () => {
  mock.restore()
  clearPostSamplingHooks()
  saveGlobalConfig(() => previousConfig)
  state.resetStateForTests()
  globalThis.fetch = realFetch
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
  Object.assign(process.env, previousEnv)
  await rm(fixture, { recursive: true, force: true })
})

function createContext(provider: 'openai' | 'firstParty') {
  state.setSessionProvider(provider)
  let app = getDefaultAppState()
  const context = {
    options: { commands: [], debug: false, mainLoopModel: provider === 'openai' ? 'gpt-6.1-sol' : 'claude-sonnet-4-5',
      mainLoopProvider: provider, tools: getAllBaseTools(), thinkingConfig: { type: 'disabled' },
      mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => app, setAppState: (update: (prev: typeof app) => typeof app) => { app = update(app) },
    abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10), messages: [],
    setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
  } as unknown as import('../../Tool.js').ToolUseContext
  return context
}

async function extract(provider: 'openai' | 'firstParty') {
  const context = createContext(provider)
  const lastMessage = createUserMessage({ content: 'The current task is to audit model behavior.' })
  const result = await manuallyExtractSessionMemory([lastMessage], context)
  return { result, lastMessage }
}

test('the enabled terminal post-sampling hook persists an OpenAI update and advances its cursor', async () => {
  process.env.USER_TYPE = 'ant'
  saveGlobalConfig(config => ({ ...config, autoCompactEnabled: true, growthBookOverrides: {
    tengu_session_memory: true,
    tengu_sm_config: { minimumMessageTokensToInit: 1, minimumTokensBetweenUpdate: 1, toolCallsBetweenUpdates: 1 },
  } }))
  clearPostSamplingHooks()
  initSessionMemory()
  toolCall = { name: 'apply_patch', input: { input: patch() } }
  const message = createAssistantMessage({ content: 'The model behavior audit is in progress.' })
  await executePostSamplingHooks([message], [] as never, {}, {}, createContext('openai'), 'repl_main_thread')
  expect(await readFile(getSessionMemoryPath(), 'utf8')).toContain('Audit model behavior.')
  expect(getLastSummarizedMessageId()).toBe(message.uuid)
  clearPostSamplingHooks()
  saveGlobalConfig(() => previousConfig)
  if (previousEnv.USER_TYPE === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = previousEnv.USER_TYPE
})

test('the notes permission boundary rejects destructive, malformed, and extra-target patch operations', async () => {
  const context = createContext('openai')
  const tool = context.options.tools.find(tool => tool.name === 'apply_patch')!
  const gate = createMemoryFileCanUseTool(getSessionMemoryPath())
  const allow = await gate(tool, { input: patch() }, context, createAssistantMessage({ content: 'Update notes' }), 'policy-gate')
  expect(allow.behavior).toBe('allow')
  const denied = [
    patch().replace('@@', `*** Move to: ${join(fixture, 'moved.md')}\n@@`),
    `*** Begin Patch\n*** Delete File: ${getSessionMemoryPath()}\n*** End Patch`,
    `*** Begin Patch\n*** Add File: ${getSessionMemoryPath()}\n+Replacement\n*** End Patch`,
    patch(join(fixture, 'other.md')),
    'malformed patch',
    '*** Begin Patch\n*** End Patch',
  ]
  for (const input of denied) {
    expect((await gate(tool, { input }, context, createAssistantMessage({ content: 'Update notes' }), 'policy-gate')).behavior).toBe('deny')
  }
})

function patch(path = getSessionMemoryPath()): string {
  return `*** Begin Patch\n*** Update File: ${path}\n@@\n # Current State\n _What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\n+Audit model behavior.\n*** End Patch`
}

for (const provider of ['openai', 'firstParty'] as const) {
  test(`${provider} extraction persists a notes update before advancing the summary cursor`, async () => {
    toolCall = provider === 'openai'
      ? { name: 'apply_patch', input: { input: patch() } }
      : { name: 'Edit', input: { file_path: getSessionMemoryPath(), old_string: '_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._',
        new_string: '_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nAudit model behavior.', replace_all: false } }
    const { result, lastMessage } = await extract(provider)
    expect(await readFile(getSessionMemoryPath(), 'utf8')).toContain('Audit model behavior.')
    expect(result).toMatchObject({ success: true, memoryPath: getSessionMemoryPath() })
    expect(getLastSummarizedMessageId()).toBe(lastMessage.uuid)
  })
}

test('text-only extraction does not claim to summarize without a persisted notes update', async () => {
  const { result } = await extract('openai')
  expect(result.success).toBe(false)
  expect(getLastSummarizedMessageId()).toBeUndefined()
  expect(await readFile(getSessionMemoryPath(), 'utf8')).toBe(DEFAULT_SESSION_MEMORY_TEMPLATE)
})

test('a configured hook approval cannot authorize notes extraction to mutate another file', async () => {
  const wasInteractive = state.getIsInteractive()
  state.setIsInteractive(false)
  enableHookExecution = true
  const marker = join(fixture, 'hook-ran')
  const response = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
  await writeFile(join(fixture, 'config/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{
    matcher: 'apply_patch', hooks: [{ type: 'command', command: `printf ran > '${marker}'; printf '%s' '${response}'` }],
  }] } }))
  resetSettingsCache()
  resetHooksConfigSnapshot()
  try {
    toolCall = { name: 'apply_patch', input: { input: `*** Begin Patch\n*** Update File: ${join(fixture, 'other.md')}\n@@\n-Keep this unchanged\n+Unauthorized overwrite\n*** End Patch` } }
    const { result } = await extract('openai')
    expect(await readFile(marker, 'utf8')).toBe('ran')
    expect(sawPermissionDenial).toBe(true)
    expect(await readFile(join(fixture, 'other.md'), 'utf8')).toBe('Keep this unchanged\n')
    expect(result.success).toBe(false)
    expect(getLastSummarizedMessageId()).toBeUndefined()
  } finally {
    enableHookExecution = false
    state.setIsInteractive(wasInteractive)
    process.env.CLAUDE_CODE_SIMPLE = '1'
    await writeFile(join(fixture, 'config/settings.json'), '{}')
    resetSettingsCache()
    resetHooksConfigSnapshot()
  }
})

const deniedInputs = [
  ['wrong target', () => ({ name: 'apply_patch', input: { input: patch(join(fixture, 'other.md')) } })],
  ['mixed targets', () => ({ name: 'apply_patch', input: { input: patch().replace('*** End Patch', `*** Update File: ${join(fixture, 'other.md')}\n@@\n-Keep this unchanged\n+changed\n*** End Patch`) } })],
] as const
for (const [name, input] of deniedInputs) {
  test(`OpenAI extraction denies ${name} without changing files or the cursor`, async () => {
    toolCall = input()
    const { result } = await extract('openai')
    expect(sawPermissionDenial).toBe(true)
    expect(result.success).toBe(false)
    expect(getLastSummarizedMessageId()).toBeUndefined()
    expect(await readFile(getSessionMemoryPath(), 'utf8')).toBe(DEFAULT_SESSION_MEMORY_TEMPLATE)
    expect(await readFile(join(fixture, 'other.md'), 'utf8')).toBe('Keep this unchanged\n')
  })
}
