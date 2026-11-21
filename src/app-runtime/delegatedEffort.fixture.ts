import { EventEmitter } from 'node:events'
import { join } from 'node:path'

const root = process.env.DELEGATED_EFFORT_TEST_ROOT
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace') ||
    process.env.CLAUDE_CONFIG_DIR !== join(root, 'config')) {
  throw new Error('Isolated delegated effort fixture required')
}
Object.assign(globalThis, { MACRO: { VERSION: 'delegated-effort-test' } })

const scenario = process.env.DELEGATED_EFFORT_SCENARIO
const claude = scenario === 'claude'
const fork = scenario === 'fork'
const model = claude ? 'claude-opus-5-5' : 'gpt-6.2-sol'
const accessToken = 'fixture-access-token'
const workerReply = 'Isolated worker finished.'
const agentInput = {
  description: 'Verify worker effort',
  prompt: 'Return the worker marker.',
  ...(!fork && { subagent_type: 'general-purpose' }),
  ...(scenario === 'explicit' || fork ? { effort: 'xhigh' } : {}),
  ...(scenario === 'low' && { effort: 'low' }),
}

const requests: unknown[] = []
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
  const index = requests.length
  const body = JSON.parse(String(init.body))
  requests.push({ model: body.model, reasoning: body.reasoning, thinking: body.thinking })
  if (index > 2) throw new Error('Unexpected extra provider request')

  const toolCall = index === 0
  const reply = index === 1 ? workerReply : 'Isolated parent finished.'
  const events: string[] = []
  const emit = (type: string, fields: object) => {
    events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
  }
  if (claude) {
    emit('message_start', { message: {
      id: `msg_${index}`, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
    } })
    const contentBlock = toolCall
      ? { type: 'tool_use', id: 'call_worker', name: 'Agent', input: {} }
      : { type: 'text', text: '' }
    const delta = toolCall
      ? { type: 'input_json_delta', partial_json: JSON.stringify(agentInput) }
      : { type: 'text_delta', text: reply }
    emit('content_block_start', { index: 0, content_block: contentBlock })
    emit('content_block_delta', { index: 0, delta })
    emit('content_block_stop', { index: 0 })
    emit('message_delta', { delta: { stop_reason: toolCall ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 } })
    emit('message_stop', {})
  } else {
    if (toolCall) {
      const item = { id: 'item_worker', type: 'function_call', call_id: 'call_worker', name: 'Agent' }
      const args = JSON.stringify(agentInput)
      emit('response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } })
      emit('response.function_call_arguments.delta', { item_id: item.id, delta: args })
      emit('response.function_call_arguments.done', { item_id: item.id, arguments: args })
      emit('response.output_item.done', { item: { ...item, arguments: args } })
    } else {
      emit('response.output_text.delta', { delta: reply })
    }
    emit('response.completed', { response: { usage: { input_tokens: 1, output_tokens: 1 } } })
  }
  return new Response(events.join(''), { headers: { 'Content-Type': 'text/event-stream' } })
}, { preconnect: () => { throw new Error('Network preconnect forbidden') } })

const { _setWebSocketFactoryForTest } = await import('../services/api/codex-websocket-transport.js')
_setWebSocketFactoryForTest(() => {
  const socket = Object.assign(new EventEmitter(), {
    readyState: 0,
    close() {},
    send() { throw new Error('Fixture uses HTTP transport only') },
  })
  queueMicrotask(() => socket.emit('error', new Error('Fixture uses HTTP transport only')))
  return socket
})
const { enableConfigs, saveGlobalConfig } = await import('../utils/config.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { AgentTool } = await import('../tools/AgentTool/AgentTool.js')
const { GENERAL_PURPOSE_AGENT } = await import('../tools/AgentTool/built-in/generalPurposeAgent.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')

enableConfigs()
if (!claude) {
  const { codexCredentialLifecycle } = await import('../services/api/codexCredentialLifecycle.js')
  const accountId = 'fixture-account'
  await codexCredentialLifecycle.withTransaction(accountId, { operationKind: 'legacy_bootstrap' },
    permit => codexCredentialLifecycle.legacyBootstrap(permit, { validatedUntaggedLegacyCredentials: true }))
  if (!saveGlobalConfig(config => ({
    ...config,
    codexOAuth: {
      accessToken, refreshToken: 'fixture-refresh-token', accountId,
      credentialGeneration: 1, expiresAt: Date.now() + 86_400_000,
    },
  }))) throw new Error('Could not seed the isolated fixture credential')
}
if (fork) {
  // Enable Agent's fork routing without loading the optional slash command.
  const { mock } = await import('bun:test')
  const forkModule = await import('../tools/AgentTool/forkSubagent.js')
  mock.module('../tools/AgentTool/forkSubagent.js', () => ({
    ...forkModule,
    isForkSubagentEnabled: () => true,
  }))
}

const initialState = getDefaultAppState()
let state: typeof initialState = {
  ...initialState,
  effortValue: scenario === 'explicit' ? 'medium' : 'high',
  toolPermissionContext: {
    ...initialState.toolPermissionContext,
    mode: 'bypassPermissions',
    isBypassPermissionsModeAvailable: true,
  },
}
const session = createQueryEngineAppSession({
  cwd: process.cwd(), commands: [], agents: [GENERAL_PURPOSE_AGENT], mcpClients: [],
  tools: [AgentTool],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20),
  customSystemPrompt: 'Run the isolated worker fixture.', userSpecifiedModel: model,
  thinkingConfig: { type: fork || claude ? 'disabled' : 'adaptive' },
})
const frames = []
for await (const frame of session.submitMessage('Launch the isolated worker.')) frames.push(frame)
const result = frames.at(-1)
if (unexpectedFetches.length || result?.type !== 'result' || result.subtype !== 'success' ||
    !session.getMessages?.().some(message =>
      message.type === 'user' && Array.isArray(message.message.content) &&
      message.message.content.some(block =>
        block.type === 'tool_result' && !block.is_error && JSON.stringify(block.content).includes(workerReply)))) {
  throw new Error(JSON.stringify({ unexpectedFetches, requests, frames: frames.slice(-4) }))
}
process.stdout.write(JSON.stringify(requests))
session.dispose?.()
