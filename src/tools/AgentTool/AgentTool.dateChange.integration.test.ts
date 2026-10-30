import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import type { QueryDeps } from '../../query/deps.js'

// Only the model and compaction I/O are replaced. AgentTool, runAgent, query,
// tools, attachment construction, and provider message projection stay real.
let queryDeps: QueryDeps | undefined
const realDeps = await import('../../query/deps.js')
const realProductionDeps = realDeps.productionDeps
mock.module('../../query/deps.js', () => ({
  ...realDeps,
  productionDeps: () => queryDeps ?? realProductionDeps(),
}))
const { resetStateForTests, switchSession } = await import('../../bootstrap/state.js')
const { asSessionId } = await import('../../types/ids.js')
const { getEmptyToolPermissionContext } = await import('../../Tool.js')
const { getUserContext, clearUserContextCache } = await import('../../context.js')
const { enableConfigs } = await import('../../utils/config.js')
const { clearSessionCaches } = await import('../../commands/clear/caches.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { getAttachmentMessages, createAttachmentMessage } = await import('../../utils/attachments.js')
const { createAssistantMessage, createUserMessage, createCompactBoundaryMessage, normalizeMessagesForAPI } = await import('../../utils/messages.js')
const { translateToCodexBody } = await import('../../services/api/codex-fetch-adapter.js')
const { asSystemPrompt } = await import('../../utils/systemPromptType.js')
const { query } = await import('../../query.js')
const { AgentTool } = await import('./AgentTool.js')
const { FileReadTool } = await import('../FileReadTool/FileReadTool.js')

const envKeys = [
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OVERRIDE_DATE', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  'CLAUDE_CODE_DISABLE_ATTACHMENTS', 'CLAUDE_CODE_SIMPLE',
] as const
let savedEnv: Array<string | undefined>
let directory: string

beforeEach(() => {
  savedEnv = envKeys.map(key => process.env[key])
  directory = mkdtempSync(join(tmpdir(), 'agent-date-change-'))
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CLAUDE_CODE_OVERRIDE_DATE = '2026-10-26'
  process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
  delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
  delete process.env.CLAUDE_CODE_SIMPLE
  resetStateForTests()
  switchSession(asSessionId('date-change-integration'), directory)
  clearUserContextCache()
  // prependUserContext deliberately skips test mode, and it carries the date.
  // Outside test mode, reading settings also needs the startup gate opened.
  enableConfigs()
  process.env.NODE_ENV = 'development'
})

afterEach(() => {
  process.env.NODE_ENV = 'test'
  queryDeps = undefined
  clearUserContextCache()
  resetStateForTests()
  envKeys.forEach((key, index) => {
    if (savedEnv[index] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[index]
  })
  rmSync(directory, { recursive: true, force: true })
})

function harness() {
  const agent = {
    agentType: 'date-fixture', source: 'built-in' as const, baseDir: 'built-in',
    whenToUse: 'fixture', tools: [FileReadTool.name], getSystemPrompt: () => 'Read the fixture.',
  }
  let state = {
    ...getDefaultAppState(),
    toolPermissionContext: getEmptyToolPermissionContext(),
    agentDefinitions: { activeAgents: [agent], allAgents: [agent] },
  }
  const context = {
    options: {
      commands: [], debug: false, verbose: false,
      mainLoopModel: 'gpt-6.1-sol', mainLoopProvider: 'openai',
      tools: [AgentTool], thinkingConfig: { type: 'disabled' },
      mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
      agentDefinitions: state.agentDefinitions,
    },
    abortController: new AbortController(), readFileState: new Map(), messages: [],
    nestedMemoryAttachmentTriggers: new Set(), dynamicSkillDirTriggers: new Set(),
    getAppState: () => state,
    setAppState(update: (previous: typeof state) => typeof state) { state = update(state) },
    setInProgressToolUseIDs() {}, setResponseLength() {},
    updateFileHistoryState() {}, updateAttributionState() {},
    toolUseId: 'date-parent',
  } as unknown as ToolUseContext
  return { context, agent }
}

async function attachments(context: ToolUseContext, messages: Message[]) {
  const result = []
  for await (const message of getAttachmentMessages(null, context, null, [], messages)) {
    const attachment = message.attachment
    if (typeof attachment === 'object' && attachment !== null &&
        'type' in attachment && attachment.type === 'date_change') {
      result.push(message)
    }
  }
  return result
}

function toolCall(name: string, input: Record<string, unknown>, id: string) {
  const message = createAssistantMessage({ content: 'Run the requested tool.' })
  message.message.content = [{ type: 'tool_use', name, input, id }]
  message.message.stop_reason = 'tool_use'
  return message
}

function capture(params: Parameters<QueryDeps['callModel']>[0]) {
  const assembly = params.openAIInstructionAssembly!
  return translateToCodexBody({
    model: params.options.model,
    _openaiInstructionAssembly: {
      instructions: assembly.instructions,
      inputMessages: normalizeMessagesForAPI(assembly.inputMessages, params.tools, 'openai').map(message => message.message),
    },
  }).codexBody
}

// This is the real Agent tool lifecycle, rather than two detector calls under
// fabricated agent contexts. The child consumes the first post-midnight tool
// continuation, then the parent resumes with its independent message history.
test('a child cannot consume its parent date correction, and a fresh child gets it on request one', async () => {
  const { context, agent } = harness()
  const fixture = join(directory, 'fixture.txt')
  writeFileSync(fixture, 'isolated date fixture')
  const userContext = await getUserContext()
  const messages = [createUserMessage({ content: 'Read the fixture through a worker.' })]
  messages.push(...await attachments(context, messages))
  const parentRequests: ReturnType<typeof capture>[] = []
  const childRequests: ReturnType<typeof capture>[] = []
  let parentCalls = 0
  let childCalls = 0
  queryDeps = {
    uuid: () => `date-query-${parentCalls}-${childCalls}`,
    microcompact: async messages => ({ messages }),
    autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
    callModel: async function* (params) {
      if (params.options.querySource === 'repl_main_thread') {
        parentRequests.push(capture(params))
        if (++parentCalls === 1) {
          process.env.CLAUDE_CODE_OVERRIDE_DATE = '2026-10-27'
          yield toolCall(AgentTool.name, {
            subagent_type: agent.agentType, prompt: `Read ${fixture}.`,
            description: 'Read isolated fixture', run_in_background: false,
          }, 'date-child')
        } else {
          yield createAssistantMessage({ content: 'Parent complete.' })
        }
      } else {
        childRequests.push(capture(params))
        if (++childCalls === 1) {
          yield toolCall(FileReadTool.name, { file_path: fixture }, 'date-read')
        } else {
          yield createAssistantMessage({ content: 'Child complete.' })
        }
      }
    },
  }
  const yielded: Message[] = []
  for await (const message of query({
    messages, toolUseContext: context,
    systemPrompt: asSystemPrompt(['Complete the task.']), userContext, systemContext: {},
    querySource: 'repl_main_thread',
    canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
  })) yielded.push(message as Message)

  expect(parentRequests).toHaveLength(2)
  expect(childRequests).toHaveLength(2)
  expect(JSON.stringify(yielded)).toContain('Parent complete.')
  for (const request of [childRequests[0]!, parentRequests[1]!]) {
    expect(JSON.stringify(request.input)).toContain("Today's date is 2026-10-26.")
    expect(JSON.stringify(request.input)).toContain("Today's date is now 2026-10-27.")
  }
  expect(parentRequests[1]!.instructions).toBe(parentRequests[0]!.instructions)
  expect((JSON.stringify(childRequests[1]!.input).match(/Today's date is now 2026-10-27\./g) ?? [])).toHaveLength(1)
  expect(await getUserContext()).toBe(userContext)
})

test('ordinary midnight correction survives discarded preparation, replay, and compaction without changing the prefix', async () => {
  const { context } = harness()
  const prefix = await getUserContext()
  const messages = [createUserMessage({ content: 'Continue.' })]
  expect(await attachments(context, messages)).toEqual([])
  process.env.CLAUDE_CODE_OVERRIDE_DATE = '2026-10-27'
  const discarded = await attachments(context, messages)
  expect(discarded.map(message => message.attachment)).toEqual([{ type: 'date_change', newDate: '2026-10-27' }])
  // Preparing a request that is aborted before publication cannot acknowledge it.
  const delivered = await attachments(context, messages)
  expect(delivered.map(message => message.attachment)).toEqual([{ type: 'date_change', newDate: '2026-10-27' }])
  messages.push(...delivered)
  expect(await attachments(context, messages)).toEqual([])
  const replayed = normalizeMessagesForAPI(messages, [], 'openai')
  expect(JSON.stringify(replayed)).toContain("Today's date is now 2026-10-27.")
  expect(await attachments(context, replayed)).toEqual([])
  const replayedUser = replayed.find(message => message.type === 'user')
  if (!replayedUser) throw new Error('Date replay must contain a user message')
  const quoted = [createUserMessage({ content: replayedUser.message.content })]
  expect((await attachments(context, quoted)).map(message => message.attachment)).toEqual([{ type: 'date_change', newDate: '2026-10-27' }])
  // When compaction removes the receipt, restore the current date at the tail.
  const compacted = [createUserMessage({ content: 'Earlier work was summarized.', isMeta: true })]
  expect((await attachments(context, compacted)).map(message => message.attachment)).toEqual([{ type: 'date_change', newDate: '2026-10-27' }])
  // A later day must still produce a fresh correction after normalized replay.
  process.env.CLAUDE_CODE_OVERRIDE_DATE = '2026-10-28'
  expect((await attachments(context, replayed)).map(message => message.attachment)).toEqual([{ type: 'date_change', newDate: '2026-10-28' }])
  expect(await getUserContext()).toBe(prefix)
  expect(prefix.currentDate).toBe("Today's date is 2026-10-26.")
  // /clear resets the prefix and starts a fresh transcript without a receipt.
  clearSessionCaches()
  expect((await getUserContext()).currentDate).toBe("Today's date is 2026-10-28.")
  expect(await attachments(context, [createUserMessage({ content: 'A new conversation.' })])).toEqual([])
})


test('the first post-compaction provider request restores a correction removed from its transcript', async () => {
  const { context } = harness()
  const userContext = await getUserContext()
  process.env.CLAUDE_CODE_OVERRIDE_DATE = '2026-10-27'
  const messages = [
    createUserMessage({ content: 'Continue after compaction.' }),
    createAttachmentMessage({ type: 'date_change', newDate: '2026-10-27' }),
  ]
  const requests: ReturnType<typeof capture>[] = []
  queryDeps = {
    uuid: () => 'date-compaction-query',
    microcompact: async messages => ({ messages }),
    autocompact: async () => ({
      wasCompacted: true, consecutiveFailures: 0,
      compactionResult: {
        boundaryMarker: createCompactBoundaryMessage('auto', 1000),
        summaryMessages: [createUserMessage({ content: 'Earlier work was summarized.', isMeta: true })],
        attachments: [], hookResults: [],
      },
    }),
    callModel: async function* (params) {
      requests.push(capture(params))
      yield createAssistantMessage({ content: 'Compacted task complete.' })
    },
  }
  for await (const _message of query({
    messages, toolUseContext: context,
    systemPrompt: asSystemPrompt(['Complete the task.']), userContext, systemContext: {},
    querySource: 'repl_main_thread',
    canUseTool: async () => ({
      behavior: 'deny', message: 'No tools expected.',
      decisionReason: { type: 'other', reason: 'The fixture does not use tools.' },
    }),
  })) { /* Drain the real post-compaction request path. */ }
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0]!.input)).toContain("Today's date is 2026-10-26.")
  expect(JSON.stringify(requests[0]!.input)).toContain('Earlier work was summarized.')
  expect((JSON.stringify(requests[0]!.input).match(/Today's date is now 2026-10-27\./g) ?? [])).toHaveLength(1)
  expect(await getUserContext()).toBe(userContext)
})
