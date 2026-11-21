import { EventEmitter } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.HOME
if (!root || process.cwd() !== join(root, 'workspace') ||
    process.env.CLAUDE_CONFIG_DIR !== join(root, 'config')) {
  throw new Error('Isolated Codex output-limit fixture required')
}

const [transport, scenario] = process.argv.slice(2)
const model = 'gpt-6.2-sol'
const accountId = 'output-limit-fixture'
const accessToken = 'synthetic-output-limit-token'
const toolTarget = join(root, 'workspace', 'unexpected-write.txt')
const requests: Array<{ transport: string; body: Record<string, unknown> }> = []
const unexpectedRequests: string[] = []

function respond(requestTransport: string, body: Record<string, unknown>) {
  const index = requests.length
  requests.push({ transport: requestTransport, body })
  const id = `output-limit-response-${index}`
  const item = {
    id: `message-${index}`, type: 'message', role: 'assistant', status: 'incomplete',
    content: [{ type: 'output_text', text: `Delivered paragraph ${index}.` }],
  }
  const usage = { input_tokens: 150, output_tokens: 25, input_tokens_details: { cached_tokens: 5 } }
  const events: Array<Record<string, unknown>> = [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0]!.text },
  ]
  if (index !== 0 && (scenario !== 'limit' || index > 4)) {
    events.push({ type: 'response.completed', response: { id, usage } })
    return events
  }

  if (scenario === 'limit') {
    item.status = 'completed'
    events.push({ type: 'response.output_item.done', output_index: 0, item })
  }

  const output: Array<Record<string, unknown>> = [item]
  if (scenario === 'streamed-tool' || scenario === 'terminal-tool') {
    const call = { type: 'function_call', id: 'tool-item', call_id: 'write-call', name: 'Write', arguments: '' }
    const args = JSON.stringify({ file_path: toolTarget, content: 'An unsealed tool call wrote this.' })
    if (scenario === 'streamed-tool') {
      events.push(
        { type: 'response.output_item.added', output_index: 1, item: call },
        { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 1, delta: args },
      )
    }
    output.push({ ...call, arguments: args, status: 'incomplete' })
  }
  events.push({ type: 'response.incomplete', response: {
    id, usage, output, incomplete_details: { reason: 'max_output_tokens' },
  } })
  return events
}

globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input)
  if (transport !== 'http' || url !== 'https://chatgpt.com/backend-api/codex/responses' ||
      init?.method !== 'POST' || new Headers(init.headers).get('Authorization') !== `Bearer ${accessToken}`) {
    unexpectedRequests.push(url)
    throw new Error('Unexpected HTTP request from fixture')
  }
  const events = respond('http', JSON.parse(String(init.body)))
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}, { preconnect: () => { throw new Error('Network preconnect forbidden') } })

Object.assign(globalThis, { MACRO: { VERSION: 'codex-output-limit-fixture' } })
const { _setWebSocketFactoryForTest } = await import('../services/api/codex-websocket-transport.js')
_setWebSocketFactoryForTest((url, options) => {
  if (transport !== 'websocket' || url !== 'wss://chatgpt.com/backend-api/codex/responses' ||
      new Headers(options.headers).get('Authorization') !== `Bearer ${accessToken}`) {
    unexpectedRequests.push(url)
    throw new Error('Unexpected WebSocket connection from fixture')
  }
  const socket = Object.assign(new EventEmitter(), {
    readyState: 0,
    send(data: string) {
      for (const event of respond('websocket', JSON.parse(data))) {
        queueMicrotask(() => socket.emit('message', JSON.stringify(event)))
      }
    },
    close() { socket.readyState = 3 },
  })
  queueMicrotask(() => {
    socket.readyState = 1
    socket.emit('open')
  })
  return socket
})

const { _getConversationIdForRequestForTest, _markStickyHttpFallbackForTest } = await import('../services/api/codex-fetch-adapter.js')
const { codexCredentialLifecycle } = await import('../services/api/codexCredentialLifecycle.js')
const { getSessionId, switchSession } = await import('../bootstrap/state.js')
const { enableConfigs, saveGlobalConfig } = await import('../utils/config.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { FileWriteTool } = await import('../tools/FileWriteTool/FileWriteTool.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')

enableConfigs()
await codexCredentialLifecycle.withTransaction(accountId, { operationKind: 'legacy_bootstrap' },
  permit => codexCredentialLifecycle.legacyBootstrap(permit, { validatedUntaggedLegacyCredentials: true }))
if (!saveGlobalConfig(config => ({ ...config,
  codexOAuth: { accountId, accessToken, refreshToken: 'synthetic-refresh-token', credentialGeneration: 1,
    expiresAt: Date.now() + 86_400_000 },
}))) throw new Error('Could not seed isolated Codex fixture credentials')
switchSession(getSessionId())
if (transport === 'http') _markStickyHttpFallbackForTest(_getConversationIdForRequestForTest(accountId, model), 'fixture')

const initial = getDefaultAppState()
let state = { ...initial, toolPermissionContext: {
  ...initial.toolPermissionContext, mode: 'bypassPermissions' as const, isBypassPermissionsModeAvailable: true,
} } as typeof initial
const session = createQueryEngineAppSession({
  cwd: process.cwd(), commands: [], agents: [], mcpClients: [], tools: [FileWriteTool],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(10), userSpecifiedModel: model,
  customSystemPrompt: 'Answer the isolated fixture request.', thinkingConfig: { type: 'disabled' },
  recordTranscript: async () => null,
})
try {
  const frames = await Array.fromAsync(session.submitMessage('Write a short prose answer.'))
  if (unexpectedRequests.length) throw new Error(JSON.stringify(unexpectedRequests))
  await writeFile(join(root, 'evidence.json'), JSON.stringify({
    requests, result: frames.at(-1), wroteFile: await Bun.file(toolTarget).exists(),
  }))
} finally {
  session.dispose?.()
}
process.exit(0)
