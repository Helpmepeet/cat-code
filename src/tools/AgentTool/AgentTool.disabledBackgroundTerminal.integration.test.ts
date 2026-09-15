import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'agent-tool-disabled-background-'))
const sourceRoot = process.env.CAT_CODE_TEST_ROOT ?? join(import.meta.dir, '../../..')

let queryDeps: any
const realDeps = await import(sourceRoot + '/src/query/deps.js')
mock.module(sourceRoot + '/src/query/deps.js', () => ({
  ...realDeps,
  productionDeps: () => queryDeps ?? realDeps.productionDeps(),
}))
const realConfig = await import(sourceRoot + '/src/query/config.js')
const realBuildQueryConfig = realConfig.buildQueryConfig
mock.module(sourceRoot + '/src/query/config.js', () => ({
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

const { resetStateForTests, switchSession } = await import(sourceRoot + '/src/bootstrap/state.js')
const { asSessionId } = await import(sourceRoot + '/src/types/ids.js')
const { getEmptyToolPermissionContext } = await import(sourceRoot + '/src/Tool.js')
const { createAssistantMessage } = await import(sourceRoot + '/src/utils/messages.js')
const { AskParentSessionTool } = await import(sourceRoot + '/src/tools/AskParentSessionTool/AskParentSessionTool.js')
const { AgentTool } = await import(sourceRoot + '/src/tools/AgentTool/AgentTool.js')
const { getDefaultAppState } = await import(sourceRoot + '/src/state/AppStateStore.js')

afterAll(async () => {
  mock.restore()
  resetStateForTests()
  await rm(process.env.CLAUDE_CONFIG_DIR!, { recursive: true, force: true })
})

test('disabled-background AgentTool handoff leaves its parent able to continue', async () => {
  resetStateForTests()
  switchSession(asSessionId('disabled-background-terminal'), process.env.CLAUDE_CONFIG_DIR!)
  const fixtureAgent = {
    agentType: 'terminal-fixture',
    source: 'built-in',
    baseDir: 'built-in',
    whenToUse: 'fixture',
    tools: [AskParentSessionTool.name],
    getSystemPrompt: () => 'fixture',
  }
  let state: any = {
    ...getDefaultAppState(),
    toolPermissionContext: getEmptyToolPermissionContext(),
    agentDefinitions: { activeAgents: [fixtureAgent], allAgents: [fixtureAgent] },
  }
  const setAppState = (update: any) => { state = update(state) }
  const parentContext: any = {
    options: {
      commands: [], debug: false, verbose: false,
      mainLoopModel: 'gpt-5.6-terra', mainLoopProvider: 'openai',
      tools: [AskParentSessionTool], thinkingConfig: { type: 'disabled' },
      mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
      agentDefinitions: state.agentDefinitions,
    },
    abortController: new AbortController(), readFileState: new Map(), messages: [],
    getAppState: () => state, setAppState, setAppStateForTasks: setAppState,
    setInProgressToolUseIDs() {}, setResponseLength() {},
    updateFileHistoryState() {}, updateAttributionState() {},
    toolUseId: 'disabled-background-parent',
  }

  let modelCalls = 0
  queryDeps = {
    uuid: () => `disabled-background-query-${modelCalls}`,
    microcompact: async (messages: any) => ({ messages }),
    autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
    callModel: async function* () {
      modelCalls++
      const assistant = createAssistantMessage({ content: modelCalls === 1 ? 'handoff' : 'continued' })
      if (modelCalls === 1) {
        assistant.message.content = [{
          type: 'tool_use', id: 'ask-parent', name: AskParentSessionTool.name,
          input: { kind: 'blocked', message: 'Need parent input', evidence: ['fixture'] },
        }]
        assistant.message.stop_reason = 'tool_use'
      }
      yield assistant
    },
  }

  const first = await AgentTool.call(
    { subagent_type: fixtureAgent.agentType, prompt: 'Request parent input.', description: 'Terminal fixture' },
    parentContext,
    (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never,
    undefined as never,
  )
  expect(JSON.stringify(first)).toContain('status: blocked')
  expect(parentContext.abortController.signal.aborted).toBe(false)

  const second = await AgentTool.call(
    { subagent_type: fixtureAgent.agentType, prompt: 'Continue after the handoff.', description: 'Continuation fixture' },
    parentContext,
    (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never,
    undefined as never,
  )
  expect(JSON.stringify(second)).toContain('continued')
  expect(modelCalls).toBe(2)
  expect(parentContext.abortController.signal.aborted).toBe(false)
})
