import { mock } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { YOLO_CLASSIFIER_TOOL_NAME } from '../utils/permissions/classifierShared.js'

const root = process.env.INSTRUCTION_REDUCTION_TEST_ROOT!
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) {
  throw new Error('Isolated fixture required')
}
const conditional = process.env.INSTRUCTION_REDUCTION_CONDITIONAL === 'true'
;(globalThis as unknown as { MACRO: unknown }).MACRO = { VERSION: 'instruction-reduction-test' }
globalThis.fetch = (() => { throw new Error('Network forbidden') }) as unknown as typeof fetch
const mainInstructions: string[] = []
const reviews: Array<{ model: string; instructions: string }> = []
const failures: string[] = []

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (value && typeof value === 'object') {
    if ('text' in value) return textOf(value.text)
    if ('content' in value) return textOf(value.content)
  }
  return ''
}

mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: Record<string, unknown>) => {
    const messages = body.messages as unknown[]
    if (!body.stream) {
      const choice = body.tool_choice as { name?: string }
      if (choice?.name !== YOLO_CLASSIFIER_TOOL_NAME) throw new Error('Unexpected non-review side query')
      reviews.push({ model: String(body.model), instructions: textOf(messages.find(message => textOf(message).includes('<instruction_context>'))) })
      return Promise.resolve({ id: `review-${reviews.length}`, type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'tool_use', id: 'verdict', name: choice.name,
          input: { shouldBlock: reviews.length === 1, thinking: 'Offline second-stage admission', reason: 'Synthetic local build' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } })
    }
    const round = mainInstructions.length + 1
    if (round > 2) throw new Error('Unexpected main model request')
    mainInstructions.push(textOf(messages.find(message => textOf(message).includes('# claudeMd'))))
    const tool = round === 1
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message: { id: `response-${round}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      yield { type: 'content_block_start', index: 0, content_block: tool
        ? { type: 'tool_use', id: 'local-build', name: 'Bash', input: {} }
        : { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: tool
        ? { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'bun run build:local', work_lifetime: 'finite', run_in_background: false }) }
        : { type: 'text_delta', text: 'The synthetic local build completed.' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: `request-${round}`, response: new Response('') }) }
  } } } }),
}))

const { enableConfigs } = await import('../utils/config.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
enableConfigs()
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto' } }
const session = createQueryEngineAppSession({
  cwd: process.cwd(), tools: [BashTool], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20), customSystemPrompt: 'Run the requested synthetic local build.',
  userSpecifiedModel: 'claude-sonnet-4-5', recordTranscript: async () => null,
})
const request = conditional
  ? 'Run the local build, but only after all formatting instructions are satisfied.'
  : 'Run the local build.'
for await (const message of session.submitMessage(request, {
  onPermissionRequest: async () => { failures.push('Unexpected manual approval'); return { behavior: 'deny', message: 'Fixture denies fallback' } },
})) {
  if (message.type === 'user' && Array.isArray(message.message.content)) {
    for (const block of message.message.content) if (block.type === 'tool_result' && block.is_error) failures.push(String(block.content))
  }
}
await writeFile(join(root, 'evidence.json'), JSON.stringify({ mainInstructions, reviews, failures }))
session.dispose?.()
process.exit(0)
