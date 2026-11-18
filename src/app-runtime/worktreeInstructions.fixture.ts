import { mock } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.WORKTREE_INSTRUCTIONS_TEST_ROOT!
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) {
  throw new Error('Isolated fixture required')
}
;(globalThis as unknown as { MACRO: unknown }).MACRO = { VERSION: 'worktree-instructions-test' }
globalThis.fetch = (() => { throw new Error('Network forbidden') }) as unknown as typeof fetch
type RequestEvidence = { modelRound: number; prefix: string; cwd: string }
const models: RequestEvidence[] = []
const reviews: RequestEvidence[] = []
const failures: string[] = []
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: Record<string, unknown>) => {
    const messages = body.messages as unknown[]
    if (!body.stream) {
      reviews.push({ modelRound: models.length, prefix: JSON.stringify(messages[0]), cwd: process.cwd() })
      const choice = body.tool_choice as { name: string }
      return Promise.resolve({ id: 'review', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'tool_use', id: 'verdict', name: choice.name,
          input: { shouldBlock: false, thinking: 'Offline fixture admission', reason: 'Synthetic fixture' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } })
    }
    const round = models.length + 1
    if (round > 5) throw new Error('Unexpected model request')
    models.push({ modelRound: round, prefix: JSON.stringify(messages.find(message => JSON.stringify(message).includes('# claudeMd'))), cwd: process.cwd() })
    const bash = (name: string) => ({ name: 'Bash', input: {
      command: `bash -c 'printf fixture > ${name}.txt'`, work_lifetime: 'finite', run_in_background: false,
    } })
    const calls = round === 1
      ? [{ name: 'EnterWorktree', input: { name: 'instructions' } }, bash('stale-first')]
      : round === 2
        ? [bash('fresh-first')]
        : round === 3
          ? [{ name: 'ExitWorktree', input: { action: 'keep' } }, bash('stale-second')]
          : round === 4 ? [bash('fresh-second')] : []
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message: { id: `response-${round}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      if (calls.length) for (const [index, call] of calls.entries()) {
        yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call-${round}-${index}`, name: call.name, input: {} } }
        yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }
        yield { type: 'content_block_stop', index }
      }
      else {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Finished synthetic transitions.' } }
        yield { type: 'content_block_stop', index: 0 }
      }
      yield { type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: `request-${round}`, response: new Response('') }) }
  } } } }),
}))
const { enableConfigs } = await import('../utils/config.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { EnterWorktreeTool } = await import('../tools/EnterWorktreeTool/EnterWorktreeTool.js')
const { ExitWorktreeTool } = await import('../tools/ExitWorktreeTool/ExitWorktreeTool.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
enableConfigs()
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto' } }
const session = createQueryEngineAppSession({
  cwd: process.cwd(), tools: [EnterWorktreeTool, ExitWorktreeTool, BashTool], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20), customSystemPrompt: 'Perform the synthetic transitions.',
  userSpecifiedModel: 'claude-sonnet-4-5',
  recordTranscript: async () => null,
})
for await (const message of session.submitMessage('Enter the fixture worktree, return, and report.', {
  onPermissionRequest: async () => { failures.push('Unexpected manual approval'); return { behavior: 'deny', message: 'Fixture denies fallback' } },
})) {
  if (message.type === 'user' && Array.isArray(message.message.content)) {
    for (const block of message.message.content) if (block.type === 'tool_result' && block.is_error) failures.push(String(block.content))
  }
}
await writeFile(join(root, 'evidence.json'), JSON.stringify({ models, reviews, failures }))
session.dispose?.()
process.exit(0)
