import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = await mkdtemp(join(tmpdir(), 'worker-skill-hooks-'))
const previousEnv = { ...process.env }
process.env.CLAUDE_CONFIG_DIR = join(fixture, 'config')
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
process.env.DISABLE_TELEMETRY = '1'
const realFetch = globalThis.fetch
globalThis.fetch = (async () => { throw new Error('Network forbidden in worker hook regression') }) as unknown as typeof fetch
const state = await import('../../bootstrap/state.js')
state.setCwdState(fixture)
state.setOriginalCwd(fixture)
state.setProjectRoot(fixture)
const realQuery = await import('../../query.js')
let queryScript: (worker: import('../../Tool.js').ToolUseContext) => AsyncGenerator<import('../../types/message.js').Message> = async function* () {}
mock.module('../../query.js', () => ({
  ...realQuery,
  query: ({ toolUseContext }: { toolUseContext: import('../../Tool.js').ToolUseContext }) => queryScript(toolUseContext),
}))
const { runAgent } = await import('./runAgent.js')
const { processPromptSlashCommand } = await import('../../utils/processUserInput/processSlashCommand.js')
const { getMatchingHooks } = await import('../../utils/hooks.js')
const { registerSkillHooks } = await import('../../utils/hooks/registerSkillHooks.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../../utils/fileStateCache.js')
const { createAssistantMessage } = await import('../../utils/messages.js')
const { resetWorkerNamesForTests } = await import('../../utils/workerNames.js')

afterEach(() => { resetWorkerNamesForTests() })
afterAll(async () => {
  mock.restore()
  state.resetStateForTests()
  globalThis.fetch = realFetch
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
  Object.assign(process.env, previousEnv)
  await rm(fixture, { recursive: true, force: true })
})

for (const isAsync of [false, true]) {
  for (const fails of [false, true]) {
    test(`inline skill hooks stay in the ${isAsync ? 'background' : 'foreground'} worker and clear on ${fails ? 'failure' : 'completion'}`, async () => {
      let app = getDefaultAppState()
      const setAppState = (update: (prev: typeof app) => typeof app) => { app = update(app) }
      const parent = {
        getAppState: () => app, setAppState, setAppStateForTasks: setAppState,
        options: { commands: [], mainLoopModel: 'claude-sonnet-4-5', mainLoopProvider: 'firstParty', tools: [],
          thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
          agentDefinitions: { activeAgents: [], allAgents: [] } },
        readFileState: createFileStateCacheWithSizeLimit(10), messages: [], abortController: new AbortController(),
        setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
      } as unknown as import('../../Tool.js').ToolUseContext
      const skill = {
        type: 'prompt' as const, name: 'inline-guard', source: 'plugin' as const, loadedFrom: 'plugin' as const,
        description: 'Guard worker actions', progressMessage: 'loading', contentLength: 20,
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' as const, command: 'echo worker-guard' }] }] },
        getPromptForCommand: async () => [{ type: 'text' as const, text: 'Inspect source only' }],
      }
      registerSkillHooks(setAppState, 'unrelated-worker', skill.hooks, skill.name)
      const input = { hook_event_name: 'PreToolUse' as const, session_id: state.getSessionId(), cwd: fixture,
        transcript_path: '', tool_name: 'Bash', tool_input: {}, tool_use_id: 'guarded-tool' }
      queryScript = async function* (worker) {
        await processPromptSlashCommand(skill.name, '', [skill], worker)
        expect(await getMatchingHooks(worker.getAppState(), worker.agentId!, 'PreToolUse', input)).toHaveLength(1)
        expect(await getMatchingHooks(worker.getAppState(), state.getSessionId(), 'PreToolUse', input)).toHaveLength(0)
        if (fails) throw new Error('worker failed after skill invocation')
        yield createAssistantMessage({ content: 'done' })
      }
      const run = async () => {
        for await (const _message of runAgent({
          agentDefinition: { agentType: 'fixture', source: 'built-in', baseDir: 'built-in', whenToUse: 'Fixture worker', getSystemPrompt: () => 'Inspect source' },
          promptMessages: [], toolUseContext: parent, isAsync, querySource: 'agent:custom',
          canUseTool: async () => ({ behavior: 'deny', message: 'Unexpected nested tool', decisionReason: { type: 'other', reason: 'Unexpected nested tool' } }),
          availableTools: [], useExactTools: true, override: { systemPrompt: ['Inspect source'] as never, userContext: {}, systemContext: {} },
        })) {}
      }
      if (fails) await expect(run()).rejects.toThrow('worker failed after skill invocation')
      else await run()
      expect([...app.sessionHooks.keys()]).toEqual(['unrelated-worker'])
    })
  }
}
