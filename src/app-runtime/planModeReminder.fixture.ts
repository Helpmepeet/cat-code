import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.PLAN_MODE_TEST_ROOT
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace') ||
    process.env.CLAUDE_CONFIG_DIR !== join(root, 'config')) {
  throw new Error('Isolated plan-mode fixture required')
}
Object.assign(globalThis, { MACRO: { VERSION: 'plan-mode-reminder-test' } })

const scenario = process.env.PLAN_MODE_TEST_SCENARIO
const planWorker = scenario === 'plan-worker'
const scriptFirst = scenario === 'script' || scenario === 'script-specialists' || planWorker
const claude = scenario === 'specialists' || scenario === 'restricted' || scenario === 'cached'
const model = claude ? 'claude-opus-5-5' : 'gpt-6.2-sol'
const accessToken = 'fixture-access-token'
const planText = '# Isolated fixture plan\n'
type Request = { input?: Array<{ type: string; output?: string }> }
const requests: Request[] = []
const unexpectedFetches: string[] = []

globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input)
  const expectedUrl = claude
    ? 'https://api.anthropic.com/v1/messages?beta=true'
    : 'https://chatgpt.com/backend-api/codex/responses'
  if (url !== expectedUrl || init?.method !== 'POST' ||
      (!claude && new Headers(init.headers).get('Authorization') !== `Bearer ${accessToken}`)) {
    unexpectedFetches.push(url)
    throw new Error(`Unexpected fetch: ${url}`)
  }
  requests.push(JSON.parse(String(init.body)))
  const events: string[] = []
  const emit = (type: string, fields: object) => {
    events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
  }
  if (claude) {
    emit('message_start', { message: {
      id: `msg_plan_${requests.length}`, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
    } })
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Fixture complete.' } })
    emit('content_block_stop', { index: 0 })
    emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    emit('message_stop', {})
  } else {
    let toolCall: { name: string; input: object } | undefined
    if (requests.length === 1 && planWorker) {
      toolCall = { name: 'Agent', input: {
        description: 'Plan an update', subagent_type: 'Plan', prompt: 'Read sample.txt and return your findings.',
      } }
    } else if (requests.length === 2 && planWorker) {
      toolCall = { name: 'Read', input: { file_path: join(process.cwd(), 'sample.txt') } }
    } else if (requests.length === 1 && scenario === 'script') {
      const input = { file_path: planPath, content: planText }
      toolCall = { name: 'REPL', input: {
        description: 'Write the isolated plan',
        code: `await tools.call({ name: 'Write', input: ${JSON.stringify(input)} })`,
      } }
    }
    if (toolCall) {
      const call = { id: `item_plan_${requests.length}`, type: 'function_call', call_id: `call_plan_${requests.length}`, name: toolCall.name }
      const args = JSON.stringify(toolCall.input)
      emit('response.output_item.added', { output_index: 0, item: { ...call, arguments: '' } })
      emit('response.function_call_arguments.delta', { item_id: call.id, delta: args })
      emit('response.function_call_arguments.done', { item_id: call.id, arguments: args })
      emit('response.output_item.done', { item: { ...call, arguments: args } })
    } else {
      const reply = planWorker && requests.length === 3 ? 'Planner returned the example findings.' : 'Fixture complete.'
      emit('response.output_text.delta', { delta: reply })
    }
    emit('response.completed', { response: { usage: { input_tokens: 1, output_tokens: 1 } } })
  }
  return new Response(events.join(''), { headers: { 'Content-Type': 'text/event-stream' } })
}, { preconnect: () => { throw new Error('Network preconnect forbidden') } })

const { _setWebSocketFactoryForTest } = await import('../services/api/codex-websocket-transport.js')
_setWebSocketFactoryForTest(() => {
  if (!planWorker) unexpectedFetches.push('WebSocket')
  throw new Error('Fixture uses HTTP transport only')
})
const { _getConversationIdForRequestForTest, _markStickyHttpFallbackForTest } = await import('../services/api/codex-fetch-adapter.js')
const { enableConfigs, saveGlobalConfig } = await import('../utils/config.js')
const { getSessionId, setHasExitedPlanMode, setSessionPersistenceDisabled, switchSession } = await import('../bootstrap/state.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { getBuiltInAgents } = await import('../tools/AgentTool/builtInAgents.js')
const { getTools } = await import('../tools.js')
const { getPlanFilePath } = await import('../utils/plans.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')

enableConfigs()
if (!claude) {
  const accountId = 'fixture-account'
  if (!saveGlobalConfig(config => ({ ...config, codexOAuth: {
    accessToken, refreshToken: 'fixture-refresh-token', accountId, credentialGeneration: 0,
    expiresAt: Date.now() + 86_400_000,
  } }))) throw new Error('Could not seed the isolated Codex credential')
  _markStickyHttpFallbackForTest(_getConversationIdForRequestForTest(accountId, model), 'fixture')
}
setSessionPersistenceDisabled(true)
switchSession(getSessionId(), null, { fresh: scriptFirst })
const planPath = getPlanFilePath()
if (planWorker) await writeFile('sample.txt', 'Plan worker read marker.')
if (scenario === 'reentry') {
  await writeFile(planPath, '# Existing synthetic plan\n')
  setHasExitedPlanMode(true)
}

const initialState = getDefaultAppState()
let state: typeof initialState = {
  ...initialState,
  ...(scriptFirst ? { codeModeFirstSessionId: getSessionId() } : {}),
  toolPermissionContext: {
    ...initialState.toolPermissionContext,
    mode: 'plan',
    ...(scenario === 'restricted' || scenario === 'cached'
      ? { alwaysDenyRules: { session: ['Agent(Explore)', 'AskUserQuestion'] } }
      : {}),
  },
}
const session = createQueryEngineAppSession({
  cwd: process.cwd(), commands: [], agents: getBuiltInAgents(), mcpClients: [],
  tools: getTools(state.toolPermissionContext),
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20),
  customSystemPrompt: 'Plan the isolated fixture.', userSpecifiedModel: model,
  recordTranscript: async () => null,
})
let result
for await (const frame of session.submitMessage('Plan an update to the example.')) result = frame
if (scenario === 'cached') {
  state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, alwaysDenyRules: { session: ['AskUserQuestion'] } } }
  for await (const frame of session.submitMessage('Continue planning the same update.')) result = frame
}
if (unexpectedFetches.length || requests.length !== (planWorker ? 4 : scenario === 'script' || scenario === 'cached' ? 2 : 1) ||
    result?.type !== 'result' || result.subtype !== 'success') {
  throw new Error(JSON.stringify({ unexpectedFetches, requestCount: requests.length, result }))
}
if (scenario === 'script' && await readFile(planPath, 'utf8') !== planText) {
  throw new Error('Script could not write the designated plan file')
}
const parentReceipt = planWorker ? requests[3]?.input?.find(item => item.type === 'function_call_output')?.output : undefined
process.stdout.write(JSON.stringify({ parentReceipt, request: planWorker ? requests[2] : scenario === 'cached' ? requests[1] : requests[0], planPath }))
session.dispose?.()
