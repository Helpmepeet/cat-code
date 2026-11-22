import { join } from 'node:path'

const root = process.env.HOME
if (!root || process.cwd() !== join(root, 'workspace') ||
    process.env.CLAUDE_CONFIG_DIR !== join(root, 'config')) {
  throw new Error('Isolated Auto reminder fixture required')
}

const scriptFirst = process.argv[2] === 'script'
const gpt = process.env.CLAUDE_CODE_USE_OPENAI === '1'
const model = gpt ? 'gpt-6.2-astra' : 'claude-sonnet-4-5'
const endpoint = gpt ? 'https://chatgpt.com/backend-api/codex/responses' : 'https://auto-reminder.invalid/v1/messages'
const requests: Record<string, unknown>[] = []
const unexpectedRequests: string[] = []
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (`${url.origin}${url.pathname}` !== endpoint) {
    unexpectedRequests.push(url.href)
    throw new Error('Unexpected Auto reminder fixture request')
  }
  requests.push(JSON.parse(input instanceof Request ? await input.text() : String(init?.body)))
  if (requests.length > 7) throw new Error('Unexpected extra model request')
  const id = `auto-fixture-${requests.length}`
  const events = gpt ? [
    { type: 'response.output_text.delta', delta: 'Fixture finished.' },
    { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 2 } } },
  ] : [
    { type: 'message_start', message: {
      type: 'message', id, model, role: 'assistant', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 },
    } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fixture finished.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream', 'request-id': id },
  })
}, { preconnect: () => { throw new Error('Network preconnect forbidden') } })

Object.assign(globalThis, { MACRO: { VERSION: 'auto-reminder-fixture' } })
const { getSessionId, switchSession } = await import('../bootstrap/state.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
const { FileEditTool } = await import('../tools/FileEditTool/FileEditTool.js')
const { FileWriteTool } = await import('../tools/FileWriteTool/FileWriteTool.js')
const { REPLTool } = await import('../tools/REPLTool/REPLTool.js')
const { enableConfigs, saveGlobalConfig } = await import('../utils/config.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { initialPermissionModeFromCLI } = await import('../utils/permissions/permissionSetup.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')

enableConfigs()
if (gpt) {
  const accountId = 'fixture-account'
  const { _setWebSocketFactoryForTest } = await import('../services/api/codex-websocket-transport.js')
  const { _getConversationIdForRequestForTest, _markStickyHttpFallbackForTest } = await import('../services/api/codex-fetch-adapter.js')
  _setWebSocketFactoryForTest(() => {
    unexpectedRequests.push('WebSocket')
    throw new Error('Fixture uses intercepted HTTP transport only')
  })
  _markStickyHttpFallbackForTest(_getConversationIdForRequestForTest(accountId, model), 'fixture')
  if (!saveGlobalConfig(config => ({ ...config, codexOAuth: {
    accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token',
    accountId, credentialGeneration: 0, expiresAt: Date.now() + 86_400_000,
  } }))) throw new Error('Could not seed the synthetic Codex credential')
}
const sessionId = getSessionId()
switchSession(sessionId, null, { fresh: scriptFirst })
const { mode } = initialPermissionModeFromCLI({
  permissionModeCli: gpt ? undefined : 'auto', dangerouslySkipPermissions: undefined,
})
if (mode !== 'auto') throw new Error(`Expected Auto Mode, got ${mode}`)
const initialState = getDefaultAppState()
let state: typeof initialState = {
  ...initialState,
  ...(scriptFirst ? { codeModeFirstSessionId: sessionId } : {}),
  toolPermissionContext: { ...initialState.toolPermissionContext, mode },
}
const session = createQueryEngineAppSession({
  cwd: process.cwd(), tools: [REPLTool, BashTool, FileEditTool, FileWriteTool],
  commands: [], agents: [], mcpClients: [],
  getAppState: () => state, setAppState: update => { state = update(state) },
  userSpecifiedModel: model,
  readFileCache: createFileStateCacheWithSizeLimit(10), recordTranscript: async () => null,
})

try {
  // The real producer emits the full reminder first and a sparse one after
  // five user turns. A text-only response keeps the permission reviewer idle.
  for (let turn = 0; turn < 7; turn++) {
    const frames = await Array.fromAsync(session.submitMessage(`Diagnose fixture issue ${turn + 1}.`))
    const result = frames.at(-1)
    if (result?.type !== 'result' || result.subtype !== 'success' || unexpectedRequests.length) {
      throw new Error(JSON.stringify({ unexpectedRequests, result }))
    }
  }
  if (requests.length !== 7) throw new Error(`Expected seven requests, got ${requests.length}`)
  console.log(JSON.stringify([requests[0], requests.at(-1)]))
} finally {
  session.dispose?.()
}
