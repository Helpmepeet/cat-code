import { mock } from 'bun:test'
import { join } from 'node:path'

const root = process.env.HOME
if (!root || process.cwd() !== join(root, 'workspace') ||
    process.env.CLAUDE_CONFIG_DIR !== join(root, 'config')) {
  throw new Error('Isolated guide fixture required')
}
Object.assign(globalThis, { MACRO: { VERSION: 'guide-request-fixture' } })
mock.module('../utils/settings/managedPath.js', () => ({
  getManagedFilePath: () => join(root, 'config', 'managed'),
  getManagedSettingsDropInDir: () => join(root, 'config', 'managed', 'managed-settings.d'),
}))

const agentInput = {
  description: 'Check a feature in the guide',
  subagent_type: 'claude-code-guide',
  prompt: 'Is auto memory turned on?',
}
const model = 'claude-sonnet-4-5'
const requests: string[] = []
const unexpectedFetches: string[] = []
const workerReply = 'Isolated guide response.'
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.origin !== 'https://guide-request.invalid' || url.pathname !== '/v1/messages') {
    unexpectedFetches.push(url.href)
    throw new Error(`Unexpected fixture URL ${url.href}`)
  }
  const index = requests.length
  if (index > 2) throw new Error('Unexpected extra provider request')
  const body = input instanceof Request ? await input.text() : String(init?.body)
  requests.push(body)
  const id = `msg_guide_fixture_${index}`
  const toolCall = index === 0
  const events: string[] = []
  const emit = (type: string, fields: object = {}) => {
    events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
  }
  emit('message_start', { message: {
    id, type: 'message', role: 'assistant', model: JSON.parse(body).model, content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
  } })
  emit('content_block_start', { index: 0, content_block: toolCall
    ? { type: 'tool_use', id: 'call_guide', name: 'Agent', input: {} }
    : { type: 'text', text: '' } })
  emit('content_block_delta', { index: 0, delta: toolCall
    ? { type: 'input_json_delta', partial_json: JSON.stringify(agentInput) }
    : { type: 'text_delta', text: index === 1 ? workerReply : 'Parent finished.' } })
  emit('content_block_stop', { index: 0 })
  emit('message_delta', { delta: { stop_reason: toolCall ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 } })
  emit('message_stop')
  return new Response(events.join(''), { headers: { 'Content-Type': 'text/event-stream', 'request-id': id } })
}, { preconnect: () => { throw new Error('Network preconnect forbidden') } })

const { setInlinePlugins } = await import('../bootstrap/state.js')
const { getCommands } = await import('../commands.js')
const { enableConfigs } = await import('../utils/config.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { AgentTool } = await import('../tools/AgentTool/AgentTool.js')
const { CLAUDE_CODE_GUIDE_AGENT } = await import('../tools/AgentTool/built-in/claudeCodeGuideAgent.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')

enableConfigs()
const cwd = process.cwd()
setInlinePlugins([join(root, 'fixture-plugin')])
const commands = await getCommands(cwd)
const initialState = getDefaultAppState()
let state: typeof initialState = {
  ...initialState,
  toolPermissionContext: {
    ...initialState.toolPermissionContext,
    mode: 'bypassPermissions',
    isBypassPermissionsModeAvailable: true,
  },
}
const session = createQueryEngineAppSession({
  cwd, commands, agents: [CLAUDE_CODE_GUIDE_AGENT], mcpClients: [],
  tools: [AgentTool],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20),
  customSystemPrompt: 'Launch the isolated guide.', userSpecifiedModel: model,
  thinkingConfig: { type: 'disabled' },
})
try {
  for await (const _frame of session.submitMessage('Ask the product guide about auto memory.')) {
    // Drain the real session until the parent receives the guide result.
  }
  if (unexpectedFetches.length || requests.length !== 3 || !requests[2]?.includes(workerReply)) {
    throw new Error(`Guide did not complete: ${requests.length} provider requests, unexpected URLs ${unexpectedFetches.join(', ')}`)
  }
  process.stdout.write(requests[1]!)
} finally {
  session.dispose?.()
}
