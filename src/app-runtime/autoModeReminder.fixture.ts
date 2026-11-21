import { join } from 'node:path'

const root = process.env.HOME
if (!root || process.cwd() !== join(root, 'workspace') ||
    process.env.CLAUDE_CONFIG_DIR !== join(root, 'config')) {
  throw new Error('Isolated Auto reminder fixture required')
}

const scriptFirst = process.argv[2] === 'script'
const model = 'claude-sonnet-4-5'
const requests: Record<string, unknown>[] = []
const unexpectedRequests: string[] = []
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.origin !== 'https://auto-reminder.invalid' || url.pathname !== '/v1/messages') {
    unexpectedRequests.push(url.href)
    throw new Error('Unexpected Auto reminder fixture request')
  }
  requests.push(JSON.parse(input instanceof Request ? await input.text() : String(init?.body)))
  if (requests.length > 7) throw new Error('Unexpected extra model request')
  const id = `auto-fixture-${requests.length}`
  const events = [
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
const { enableConfigs } = await import('../utils/config.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')

enableConfigs()
const sessionId = getSessionId()
switchSession(sessionId, null, { fresh: scriptFirst })
const initialState = getDefaultAppState()
let state: typeof initialState = {
  ...initialState,
  ...(scriptFirst ? { codeModeFirstSessionId: sessionId } : {}),
  toolPermissionContext: { ...initialState.toolPermissionContext, mode: 'auto' },
}
const session = createQueryEngineAppSession({
  cwd: process.cwd(), tools: [REPLTool, BashTool, FileEditTool, FileWriteTool],
  commands: [], agents: [], mcpClients: [],
  getAppState: () => state, setAppState: update => { state = update(state) },
  customSystemPrompt: 'Inspect the isolated fixture.', userSpecifiedModel: model,
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
