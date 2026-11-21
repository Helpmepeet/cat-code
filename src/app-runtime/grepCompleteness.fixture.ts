import { mock } from 'bun:test'
import type { MessageParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { join } from 'node:path'

const root = process.env.GREP_COMPLETENESS_TEST_ROOT
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) {
  throw new Error('Isolated Grep fixture required')
}
function refuseNetwork(): never { throw new Error('Network forbidden in Grep fixture') }
globalThis.fetch = Object.assign(refuseNetwork, { preconnect: refuseNetwork })
Object.assign(globalThis, { MACRO: { VERSION: 'grep-completeness-test' } })

const searches = {
  killed: { pattern: 'killed-match', path: 'small' },
  timeout: { pattern: 'timeout-match', path: 'small', output_mode: 'count' },
  emptyTimeout: { pattern: 'timeout-before-match', path: 'small' },
  capped: { pattern: 'over-limit', path: 'large.txt', output_mode: 'content', head_limit: 2 },
  // The first 80,689 complete rows of numbered stdout fit in the 20 MB ceiling.
  laterPage: { pattern: 'over-limit', path: 'large.txt', output_mode: 'content', offset: 80_689 },
  finalLine: { pattern: 'over-limit-final', path: 'large.txt', output_mode: 'content' },
  noMatch: { pattern: 'not-in-fixture', path: 'small' },
}
const receipts: Record<string, string> = {}
let requests = 0
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: refuseNetwork,
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: { messages: MessageParam[] }) => {
    const round = requests++
    if (round > 1) throw new Error('Unexpected provider request')
    for (const message of body.messages) {
      if (!Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          receipts[block.tool_use_id] = block.content
        }
      }
    }
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message: { id: `response-${round}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      if (round === 0) {
        for (const [index, [id, input]] of Object.entries(searches).entries()) {
          yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'Grep', input: {} } }
          yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }
          yield { type: 'content_block_stop', index }
        }
      } else {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Searches finished.' } }
        yield { type: 'content_block_stop', index: 0 }
      }
      yield { type: 'message_delta', delta: { stop_reason: round === 0 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: `request-${round}`, response: new Response('') }) }
  } } } }),
}))

const { enableConfigs } = await import('../utils/config.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { GrepTool } = await import('../tools/GrepTool/GrepTool.js')
enableConfigs()
let state = getDefaultAppState()
const session = createQueryEngineAppSession({
  cwd: process.cwd(), tools: [GrepTool], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20),
  customSystemPrompt: 'Run the isolated file searches.',
  userSpecifiedModel: 'claude-sonnet-4-5', recordTranscript: async () => null,
})
for await (const _ of session.submitMessage('Run the isolated Grep fixture.')) {
  // Consume the real app runtime turn.
}
session.dispose?.()
console.log(JSON.stringify(receipts))
process.exit(0)
