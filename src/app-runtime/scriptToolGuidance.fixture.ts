import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppState } from '../state/AppStateStore.js'
import type { SessionId } from '../types/ids.js'
import type { Message } from '../types/message.js'

const root = process.env.HOME
if (!root || process.cwd() !== join(root, 'workspace') ||
    process.env.CLAUDE_CONFIG_DIR !== join(root, 'config')) {
  throw new Error('Isolated Script guidance fixture required')
}

const phase = process.argv[2]
const gpt = process.env.CLAUDE_CODE_USE_OPENAI === '1'
const probeScriptAgent = !gpt && phase === 'fresh'
const model = gpt ? 'gpt-6.2-astra' : 'claude-sonnet-4-5'
const accessToken = 'fixture-access-token'
const accountId = 'fixture-account'
const endpoint = gpt
  ? 'https://chatgpt.com/backend-api/codex/responses'
  : 'https://script-guidance.invalid/v1/messages'
const requests: Array<{
  tools: Array<{ name: string; description?: string; defer_loading?: boolean }>
  system?: Array<{ text: string }>
  input?: Array<{ role?: string; content?: Array<{ text?: string }> }>
  messages?: unknown[]
}> = []
const unexpectedFetches: string[] = []

globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (`${url.origin}${url.pathname}` !== endpoint || requests.length >= (probeScriptAgent ? 2 : 1)) {
    unexpectedFetches.push(`${url.origin}${url.pathname}`)
    throw new Error('Unexpected Script guidance fixture request')
  }
  requests.push(JSON.parse(input instanceof Request ? await input.text() : String(init?.body)))
  const invokeScript = probeScriptAgent && requests.length === 1
  const events = gpt ? [
    { type: 'response.output_text.delta', delta: 'Fixture finished.' },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 1 } } },
  ] : [
    { type: 'message_start', message: {
      id: `fixture-message-${requests.length}`, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
    } },
    { type: 'content_block_start', index: 0, content_block: invokeScript
      ? { type: 'tool_use', id: 'script-agent', name: 'REPL', input: {} }
      : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: invokeScript
      ? { type: 'input_json_delta', partial_json: JSON.stringify({
        description: 'Check Script launch routing',
        code: `for (const name of ['Agent', 'Task']) {
          const input = { description: 'Fixture canary', subagent_type: 'general-purpose', prompt: 'Never launch this worker.' };
          try { await tools.call({ name, input }); }
          catch (error) { output(name + ': ' + error.message); }
        }`,
      }) }
      : { type: 'text_delta', text: 'Fixture finished.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: invokeScript ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream', 'request-id': 'fixture-request' },
  })
}, { preconnect: () => { throw new Error('Network preconnect forbidden') } })

Object.assign(globalThis, { MACRO: { VERSION: 'script-guidance-fixture' } })
const { getSessionId, switchSession } = await import('../bootstrap/state.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { AgentTool } = await import('../tools/AgentTool/AgentTool.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
const { FilePatchTool } = await import('../tools/FilePatchTool/FilePatchTool.js')
const { FileReadTool } = await import('../tools/FileReadTool/FileReadTool.js')
const { REPLTool } = await import('../tools/REPLTool/REPLTool.js')
const { ResumeAgentTool } = await import('../tools/ResumeAgentTool/ResumeAgentTool.js')
const { enableConfigs, saveGlobalConfig } = await import('../utils/config.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')

enableConfigs()
const historyPath = join(root, 'history.json')
const history = phase === 'reopened'
  ? JSON.parse(await readFile(historyPath, 'utf8')) as { sessionId: SessionId; messages: Message[] }
  : undefined
if (phase !== 'fresh') switchSession(history?.sessionId ?? getSessionId())
const sessionId = getSessionId()

if (gpt) {
  const { _setWebSocketFactoryForTest } = await import('../services/api/codex-websocket-transport.js')
  const { _getConversationIdForRequestForTest, _markStickyHttpFallbackForTest } = await import('../services/api/codex-fetch-adapter.js')
  _setWebSocketFactoryForTest(() => {
    unexpectedFetches.push('WebSocket')
    throw new Error('Fixture uses intercepted HTTP transport only')
  })
  _markStickyHttpFallbackForTest(_getConversationIdForRequestForTest(accountId, model), 'fixture')
  if (phase === 'fresh' && !saveGlobalConfig(config => ({ ...config, codexOAuth: {
    accessToken, refreshToken: 'fixture-refresh-token', accountId, credentialGeneration: 0,
    expiresAt: Date.now() + 86_400_000,
  } }))) throw new Error('Could not seed the synthetic Codex credential')
}

// The in-memory mode selector is the valid configuration on revisions that
// predate the persisted session preference.
const mode = { codeModeFirstSessionId: phase === 'legacy' ? undefined : sessionId }
let state: AppState = { ...getDefaultAppState(), ...mode }
const session = createQueryEngineAppSession({
  cwd: process.cwd(), initialMessages: history?.messages, userSpecifiedModel: model,
  tools: [REPLTool, FileReadTool, BashTool, FilePatchTool, AgentTool, ResumeAgentTool], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(10), recordTranscript: async () => null,
})
try {
  const frames = await Array.fromAsync(session.submitMessage('Look at the isolated workspace.'))
  const result = frames.at(-1)
  if (unexpectedFetches.length || requests.length !== (probeScriptAgent ? 2 : 1) ||
      result?.type !== 'result' || result.subtype !== 'success') {
    throw new Error(JSON.stringify({ unexpectedFetches, requests: requests.length, result }))
  }
  if (phase === 'fresh') {
    await writeFile(historyPath, JSON.stringify({ sessionId, messages: session.getMessages() }))
  }
  const body = requests[0]!
  const prompt = gpt
    ? body.input?.[0]?.content?.map(block => block.text).join('\n') ?? ''
    : body.system?.map(block => block.text).join('\n') ?? ''
  console.log(JSON.stringify({
    tools: body.tools.filter(tool => !tool.defer_loading).map(tool => tool.name),
    scriptGuidance: prompt.split('\n').find(line => line.includes('REPL runs JavaScript')),
    prompt,
    scriptDescription: body.tools.find(tool => tool.name === 'REPL')?.description,
    resumePrompt: body.tools.find(tool => tool.name === 'ResumeAgent')?.description,
    ...(probeScriptAgent && { scriptAgentResult: requests[1]?.messages }),
  }))
} finally {
  session.dispose?.()
}
process.exit(0)
