import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import z from 'zod/v4'

let queryDeps: any
let fixtureRoot: string
const realDeps = await import('../../query/deps.js')
mock.module('../../query/deps.js', () => ({
  ...realDeps,
  productionDeps: () => queryDeps ?? realDeps.productionDeps(),
}))
const realConfig = await import('../../query/config.js')
const realBuildQueryConfig = realConfig.buildQueryConfig
mock.module('../../query/config.js', () => ({
  ...realConfig,
  buildQueryConfig: () => ({
    ...realBuildQueryConfig(),
    gates: {
      ...realBuildQueryConfig().gates,
      streamingToolExecution: true,
      emitToolUseSummaries: false,
    },
  }),
}))

const { resetStateForTests, switchSession } = await import('../../bootstrap/state.js')
const { asSessionId } = await import('../../types/ids.js')
const { buildTool, getEmptyToolPermissionContext } = await import('../../Tool.js')
const { createAssistantMessage } = await import('../../utils/messages.js')
const { AskParentSessionTool } = await import('../AskParentSessionTool/AskParentSessionTool.js')
const { runAgent } = await import('./runAgent.js')
const { finalizeAgentTool } = await import('./agentToolUtils.js')

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function harness(effectTool: ReturnType<typeof buildTool>, canUseTool: any) {
  let state: any = {
    toolPermissionContext: getEmptyToolPermissionContext(),
    sessionHooks: new Map(), tasks: {}, todos: {}, mcp: { tools: [], clients: [] },
  }
  const tools = [AskParentSessionTool, effectTool]
  const parentContext: any = {
    options: {
      commands: [], debug: false, verbose: false,
      mainLoopModel: 'gpt-5.6-terra', mainLoopProvider: 'openai',
      tools, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
    },
    abortController: new AbortController(), readFileState: new Map(), messages: [],
    getAppState: () => state,
    setAppState: (update: any) => { state = update(state) },
    setInProgressToolUseIDs() {}, setResponseLength() {},
    updateFileHistoryState() {}, updateAttributionState() {},
    toolUseId: 'terminal-parent',
  }
  const yielded: any[] = []
  const run = (async () => {
    for await (const message of runAgent({
      agentDefinition: {
        agentType: 'terminal-fixture', source: 'built-in', baseDir: 'built-in',
        whenToUse: 'fixture', tools: tools.map(tool => tool.name),
        getSystemPrompt: () => 'fixture',
      },
      promptMessages: [], toolUseContext: parentContext, canUseTool,
      availableTools: tools, useExactTools: true, isAsync: true,
      querySource: 'agent',
      override: { systemPrompt: ['fixture'] as never, userContext: {}, systemContext: {} },
    })) yielded.push(message)
    return finalizeAgentTool(yielded, 'terminal-integration', {
      prompt: 'fixture', resolvedAgentModel: 'gpt-5.6-terra',
      isBuiltInAgent: true, startTime: Date.now(),
      agentType: 'terminal-fixture', isAsync: true,
    })
  })()
  return { run, yielded }
}

function scriptModel(effectName: string) {
  let calls = 0
  queryDeps = {
    uuid: () => `terminal-query-${calls}`,
    microcompact: async (messages: any) => ({ messages }),
    autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
    callModel: async function* () {
      calls++
      if (calls > 1) throw new Error('terminal handoff requested another model turn')
      const assistant = createAssistantMessage({ content: 'terminal batch' })
      assistant.message.content = [
        {
          type: 'tool_use', id: 'ask-first', name: AskParentSessionTool.name,
          input: { kind: 'blocked', message: 'Need parent input', evidence: ['fixture'] },
        },
        { type: 'tool_use', id: 'effect-second', name: effectName, input: {} },
      ]
      assistant.message.stop_reason = 'tool_use'
      yield assistant
      // A second model item makes query poll getCompletedResults while the
      // response stream is still active, covering the early synchronous path.
      await Promise.resolve()
      yield createAssistantMessage({ content: 'stream tail' })
    },
  }
}

beforeEach(async () => {
  resetStateForTests()
  fixtureRoot = await mkdtemp(join(tmpdir(), 'run-agent-terminal-'))
  switchSession(asSessionId('terminal-integration'), fixtureRoot)
})
afterEach(async () => {
  queryDeps = undefined
  resetStateForTests()
  await rm(fixtureRoot, { recursive: true, force: true })
})

test('real runAgent/query waits for an already-started effect before blocked handoff', async () => {
  const effectGate = gate()
  let started = false
  let finished = false
  const effect = buildTool({
    name: 'StartedEffect', inputSchema: z.strictObject({}),
    isReadOnly: () => true, isConcurrencySafe: () => true,
    async description() { return 'fixture' }, async prompt() { return 'fixture' },
    async validateInput() { return { result: true as const } },
    renderToolUseMessage: () => null, renderToolResultMessage: () => null,
    renderToolUseErrorMessage: () => null,
    mapToolResultToToolResultBlockParam(_output: unknown, id: string) {
      return { type: 'tool_result' as const, tool_use_id: id, content: 'effect done' }
    },
    async call() {
      started = true
      await effectGate.promise
      finished = true
      return { data: 'done' }
    },
  } as never)
  scriptModel(effect.name)
  const execution = harness(effect, async (_tool: unknown, input: unknown) => ({
    behavior: 'allow' as const, updatedInput: input,
  }))
  for (let i = 0; i < 100 && !started; i++) await new Promise(resolve => setTimeout(resolve, 2))
  expect(started).toBe(true)
  expect(execution.yielded.some(message => JSON.stringify(message).includes('status: blocked'))).toBe(false)
  effectGate.release()
  const result = await execution.run
  expect(finished).toBe(true)
  expect(result.content.map((block: any) => block.text).join('\n')).toContain('status: blocked')
})

test('real runAgent/query publishes blocked without waiting forever and rejects a later permission release', async () => {
  const permissionGate = gate()
  let calls = 0
  const effect = buildTool({
    name: 'PermissionEffect', inputSchema: z.strictObject({}),
    isReadOnly: () => true, isConcurrencySafe: () => true,
    async description() { return 'fixture' }, async prompt() { return 'fixture' },
    async validateInput() { return { result: true as const } },
    renderToolUseMessage: () => null, renderToolResultMessage: () => null,
    renderToolUseErrorMessage: () => null,
    mapToolResultToToolResultBlockParam(_output: unknown, id: string) {
      return { type: 'tool_result' as const, tool_use_id: id, content: 'effect done' }
    },
    async call() { calls++; return { data: 'done' } },
  } as never)
  scriptModel(effect.name)
  const execution = harness(effect, async (tool: any, input: unknown) => {
    if (tool.name === effect.name) await permissionGate.promise
    return { behavior: 'allow' as const, updatedInput: input }
  })
  const result = await Promise.race([
    execution.run,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('blocked handoff waited on unresolved permission')), 2000),
    ),
  ])
  expect(result.content.map((block: any) => block.text).join('\n')).toContain('status: blocked')
  expect(calls).toBe(0)
  permissionGate.release()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(calls).toBe(0)
})
