import { EventEmitter } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import type { UUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

const root = process.env.HOME
const [scenario, phase] = process.argv.slice(2)
if (!root || process.cwd() !== join(root, 'workspace') ||
    process.env.CLAUDE_CONFIG_DIR !== join(root, 'config')) {
  throw new Error('Isolated Codex instruction fixture required')
}

const model = 'gpt-6.2-sol'
const accountId = 'instruction-prefix-fixture'
const accessToken = 'synthetic-prefix-token'
const sessionIdPath = join(root, 'session-id')
const archive = join(root, 'archive')
const stablePrompt = 'Stable parent fixture instructions.'
const memorySummary = 'Isolated Session Memory summary.'
const modelSummary = 'Isolated model-generated compaction summary.'
const requests: Array<Record<string, unknown>> = []
const unexpectedRequests: string[] = []
const useWebSocket = scenario === 'websocket' || scenario === 'worker'

function respond(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const index = requests.length
  if (index >= 6) throw new Error('Unexpected extra fixture request')
  requests.push(body)
  const id = `prefix-response-${index}`
  const usage = { input_tokens: 150, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } }
  if (scenario === 'worker' && index === 0) {
    const call = { type: 'function_call', id: 'worker-item', call_id: 'worker-call', name: 'Agent' }
    const args = JSON.stringify({
      description: 'Run an isolated worker', subagent_type: 'general-purpose',
      prompt: 'Return a short report from this synthetic worker.',
    })
    return [
      { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: call.id, delta: args },
      { type: 'response.function_call_arguments.done', item_id: call.id, arguments: args },
      { type: 'response.output_item.done', item: { ...call, arguments: args, status: 'completed' } },
      { type: 'response.completed', response: { id, usage } },
    ]
  }
  const text = JSON.stringify(body.input).includes('CRITICAL: Respond with TEXT ONLY.')
    ? `<summary>${modelSummary}</summary>`
    : `Finished isolated request ${index}.`
  const item = {
    type: 'message', id: `prefix-message-${index}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  return [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, usage } },
  ]
}

globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (useWebSocket || url.href !== 'https://chatgpt.com/backend-api/codex/responses' ||
      new Headers(init?.headers).get('Authorization') !== `Bearer ${accessToken}`) {
    unexpectedRequests.push(url.href)
    throw new Error('Unexpected HTTP request from fixture')
  }
  const body = JSON.parse(input instanceof Request ? await input.text() : String(init?.body))
  return new Response(respond(body).map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}, { preconnect: () => { throw new Error('Network preconnect forbidden') } })

Object.assign(globalThis, { MACRO: { VERSION: 'instruction-prefix-fixture' } })
const { _setWebSocketFactoryForTest } = await import('../services/api/codex-websocket-transport.js')
_setWebSocketFactoryForTest((url, options) => {
  if (url !== 'wss://chatgpt.com/backend-api/codex/responses' ||
      new Headers(options.headers).get('Authorization') !== `Bearer ${accessToken}`) {
    unexpectedRequests.push(url)
    throw new Error('Unexpected WebSocket connection from fixture')
  }
  const socket = Object.assign(new EventEmitter(), {
    readyState: 0,
    send(data: string) {
      for (const event of respond(JSON.parse(data))) {
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

const { _getConversationIdForRequestForTest, _markStickyHttpFallbackForTest, setCodexPromptCacheKey } = await import('../services/api/codex-fetch-adapter.js')
const { getSessionId, switchSession } = await import('../bootstrap/state.js')
const { asSessionId } = await import('../types/ids.js')
const { setSystemPromptInjection } = await import('../context.js')
const { enableConfigs, saveGlobalConfig } = await import('../utils/config.js')
const { loadConversationForResume } = await import('../utils/conversationRecovery.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { flushSessionStorage } = await import('../utils/sessionStorage.js')
const { releaseActiveTranscriptLease } = await import('../utils/transcriptLease.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { default: compact } = await import('../commands/compact/index.js')
const { AgentTool } = await import('../tools/AgentTool/AgentTool.js')
const { GENERAL_PURPOSE_AGENT } = await import('../tools/AgentTool/built-in/generalPurposeAgent.js')
const { FileReadTool } = await import('../tools/FileReadTool/FileReadTool.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')

enableConfigs()
if (phase !== 'resume') {
  const { codexCredentialLifecycle } = await import('../services/api/codexCredentialLifecycle.js')
  await codexCredentialLifecycle.withTransaction(accountId, { operationKind: 'legacy_bootstrap' },
    permit => codexCredentialLifecycle.legacyBootstrap(permit, { validatedUntaggedLegacyCredentials: true }))
  if (!saveGlobalConfig(config => ({ ...config, codexOAuth: {
    accountId, accessToken, refreshToken: 'synthetic-prefix-refresh', credentialGeneration: 1,
    expiresAt: Date.now() + 86_400_000,
  } }))) throw new Error('Could not seed isolated Codex fixture credentials')
}

const transcript = phase === 'resume' ? await Bun.file(sessionIdPath).text() : undefined
const restored = transcript
  ? await loadConversationForResume(basename(transcript, '.jsonl') as UUID, transcript, { interruptedTurn: 'defer', mutable: false })
  : undefined
if (phase === 'resume' && !restored?.sessionId) throw new Error('Fixture transcript failed to resume')
const sessionId = restored?.sessionId ? asSessionId(restored.sessionId) : getSessionId()
switchSession(sessionId, archive)
setCodexPromptCacheKey(sessionId)
if (!useWebSocket) _markStickyHttpFallbackForTest(_getConversationIdForRequestForTest(accountId, model), 'fixture')
if (phase !== 'resume') await writeFile(sessionIdPath, join(archive, `${sessionId}.jsonl`))

setSystemPromptInjection('volatile-one')
const initial = getDefaultAppState()
let state = {
  ...initial,
  toolPermissionContext: { ...initial.toolPermissionContext, mode: 'bypassPermissions' as const, isBypassPermissionsModeAvailable: true },
} as typeof initial
const session = createQueryEngineAppSession({
  cwd: process.cwd(), initialMessages: restored?.messages, commands: [compact], mcpClients: [],
  agents: scenario === 'worker' ? [GENERAL_PURPOSE_AGENT] : [],
  tools: scenario === 'worker' ? [AgentTool, FileReadTool] : [FileReadTool],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(10), userSpecifiedModel: model,
  ...(scenario === 'estimate'
    ? { customSystemPrompt: `${stablePrompt}\n${'rule '.repeat(24000)}` }
    : { appendSystemPrompt: stablePrompt }),
  thinkingConfig: { type: 'disabled' },
})

async function submit(text: string) {
  const frames = await Array.fromAsync(session.submitMessage(text))
  const result = frames.at(-1)
  if (unexpectedRequests.length || (scenario !== 'estimate' && (result?.type !== 'result' || result.subtype !== 'success'))) {
    throw new Error(JSON.stringify({ unexpectedRequests, text, result }))
  }
}

try {
  if (phase === 'resume') {
    await submit('Continue after reopening.')
  } else if (scenario === 'estimate' || scenario === 'worker') {
    await submit('Run a synthetic fixture task.')
  } else {
    await submit('First fixture turn.')
    await submit('Second fixture turn.')
    if (scenario === 'websocket') {
      setSystemPromptInjection('volatile-two')
      await submit('Continue with updated volatile context.')
    } else {
      if (scenario === 'session-memory') {
        const { getSessionMemoryPath } = await import('../utils/permissions/filesystem.js')
        const memory = getSessionMemoryPath()
        await mkdir(dirname(memory), { recursive: true })
        await writeFile(memory, `# Current State\n${memorySummary}\n`)
      }
      await submit('/compact')
      await submit('Continue after compaction.')
    }
  }
  await flushSessionStorage()
  await writeFile(join(root, 'requests.json'), JSON.stringify(requests))
} finally {
  session.dispose?.()
  await releaseActiveTranscriptLease()
}
process.exit(0)
