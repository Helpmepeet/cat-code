import { spyOn } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'cat-code-side-question-regression-'))
const config = join(root, 'config')
const project = join(root, 'project')
mkdirSync(config)
mkdirSync(project)
const marker = 'SIDE_QUESTION_REPOSITORY_RULE'
writeFileSync(join(config, 'CLAUDE.md'), marker)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config,
  NODE_ENV: 'production',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTO_COMPACT: '1',
  ANTHROPIC_API_KEY: 'isolated-test-key',
  OPENAI_API_KEY: 'isolated-test-key',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
})
globalThis.fetch = Object.assign(
  async () => { throw new Error('Network blocked by regression fixture') },
  { preconnect: () => {} },
)
;(globalThis as any).MACRO = { VERSION: 'test', PACKAGE_URL: 'cat-code', BUILD_TIME: 'test' }

try {
  await import('../../query.js')
  const state = await import('../../bootstrap/state.js')
  state.setOriginalCwd(project)
  state.setProjectRoot(project)
  state.setCwdState(project)
  state.setSessionProvider('firstParty')
  state.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
  const { enableConfigs } = await import('../config.js')
  enableConfigs()
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createUserMessage, createAssistantMessage } = await import('../messages.js')
  const { createFileStateCacheWithSizeLimit } = await import('../fileStateCache.js')
  const { buildSideQuestionFallbackParams } = await import('../queryContext.js')
  const { runForkedAgent } = await import('../forkedAgent.js')
  const { buildProviderInstructionAssembly } = await import('../../services/api/instructionAssembly.js')
  const api = await import('../../services/api/claude.js')
  const appState = getDefaultAppState()
  const rawHistory = [createUserMessage({ content: 'main task' })]
  const params = await buildSideQuestionFallbackParams({
    tools: [], commands: [], mcpClients: [], messages: rawHistory,
    readFileState: createFileStateCacheWithSizeLimit(100),
    getAppState: () => appState, setAppState: () => {},
    customSystemPrompt: 'Side-question regression', appendSystemPrompt: undefined,
    thinkingConfig: { type: 'disabled' }, agents: [],
  })
  let outgoingMessages: unknown
  const spy = spyOn(api, 'queryModelWithStreaming').mockImplementation(async function* (request) {
    outgoingMessages = request.messages
    yield createAssistantMessage({ content: 'local answer' })
  })
  const run = async (history: typeof rawHistory) => {
    await runForkedAgent({
      cacheSafeParams: { ...params, forkContextMessages: history },
      promptMessages: [createUserMessage({ content: 'side question' })],
      canUseTool: async () => ({
        behavior: 'deny', message: 'No tools for this question',
        decisionReason: { type: 'other', reason: 'side_question' },
      }),
      querySource: 'side_question', forkLabel: 'side_question_regression',
      maxTurns: 1, skipTranscript: true,
    })
    return JSON.stringify(outgoingMessages).split(marker).length - 1
  }
  try {
    const fallbackInstructionCount = await run(params.forkContextMessages as typeof rawHistory)
    const savedHistoryInstructionCount = await run(rawHistory)
    const openai = buildProviderInstructionAssembly({
      provider: 'openai', messages: rawHistory, systemPrompt: params.systemPrompt,
      userContext: params.userContext, systemContext: params.systemContext,
    })
    console.log(JSON.stringify({
      rawHistoryLength: rawHistory.length,
      fallbackHistoryLength: params.forkContextMessages.length,
      fallbackInstructionCount, savedHistoryInstructionCount,
      openaiInstructionCount: openai.openAIInstructionAssembly!.instructions.split(marker).length - 1,
    }))
  } finally {
    spy.mockRestore()
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
