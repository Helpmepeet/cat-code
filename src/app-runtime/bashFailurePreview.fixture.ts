import { mock } from 'bun:test'
import type { MessageParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { join } from 'node:path'

const root = process.env.BASH_PREVIEW_TEST_ROOT
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) {
  throw new Error('Isolated Bash fixture required')
}
function refuseNetwork(): never { throw new Error('Network forbidden in Bash fixture') }
globalThis.fetch = Object.assign(refuseNetwork, { preconnect: refuseNetwork })
Object.assign(globalThis, { MACRO: { VERSION: 'bash-failure-preview-test' } })

const script = process.env.BASH_PREVIEW_TEST_MODE === 'script'
const commands = [
  ['bun', 'bun test ./mixed.test.ts'],
  ['unittest', 'python3 -m unittest suite'],
  ['setup', 'bun test ./setup.test.ts'],
  ['passing', 'bun test ./passing.test.ts'],
  ['unknown', 'python3 -m unittest unknown'],
  ['replay', 'cat unittest.log; exit 7'],
] as const
const receipts: Record<string, string> = {}
let requests = 0
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: refuseNetwork,
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: { messages: MessageParam[] }) => {
    const round = requests++
    if (round > commands.length) throw new Error('Unexpected provider request')
    const precedingId = commands[round - 1]?.[0]
    if (precedingId) {
      for (const message of body.messages) {
        if (!Array.isArray(message.content)) continue
        for (const block of message.content) {
          if (block.type === 'tool_result' && block.tool_use_id === precedingId && typeof block.content === 'string') {
            receipts[precedingId] = block.content
          }
        }
      }
    }
    const stream = Object.assign((async function* () {
      const model = 'claude-sonnet-4-5'
      const command = commands[round]
      yield { type: 'message_start', message: { id: `response-${round}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      if (command) {
        const [id, shellCommand] = command
        const input = { command: shellCommand, work_lifetime: 'finite', run_in_background: false }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: script ? 'REPL' : 'Bash', input: {} } }
        const toolInput = script ? {
          code: `const result = await tools.call({name:'Bash',input:${JSON.stringify(input)},nothrow:true}); output(result.content);`,
          description: 'Run isolated Bash preview fixture',
        } : input
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) } }
      } else {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Finished.' } }
      }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_delta', delta: { stop_reason: command ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: `request-${round}`, response: new Response('') }) }
  } } } }),
}))

const { enableConfigs } = await import('../utils/config.js')
const { getSessionId, switchSession } = await import('../bootstrap/state.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
const { REPLTool } = await import('../tools/REPLTool/REPLTool.js')
enableConfigs()
if (!script) switchSession(getSessionId())
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'bypassPermissions', isBypassPermissionsModeAvailable: true } }
const session = createQueryEngineAppSession({
  cwd: process.cwd(), tools: [BashTool, REPLTool], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20),
  customSystemPrompt: 'Run the isolated Bash checks.', userSpecifiedModel: 'claude-sonnet-4-5',
  recordTranscript: async () => null,
})
for await (const _ of session.submitMessage('Run the isolated Bash checks.')) {
  // Consume the real app-runtime turn.
}
session.dispose?.()
console.log(JSON.stringify(receipts))
process.exit(0)
