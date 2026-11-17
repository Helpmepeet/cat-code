import { mock } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.EDIT_EVIDENCE_TEST_ROOT!
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) throw new Error('Isolated environment required')
const edits = JSON.parse(process.env.EDIT_EVIDENCE_TEST_INPUT!) as Array<{
  file_path: string; old_string: string; new_string: string; replace_all?: boolean
}>
globalThis.fetch = (() => { throw new Error('Network forbidden in Edit evidence fixture') }) as unknown as typeof fetch
;(globalThis as unknown as { MACRO: unknown }).MACRO = { VERSION: 'edit-evidence-test' }
for (const input of edits) await writeFile(input.file_path,
  input.replace_all ? `${input.old_string}\n${input.old_string}\n` : `${input.old_string}\n`)

const classifierBodies: unknown[] = []
let round = 0
// Only provider responses are fixtures. The actual app runtime, tools,
// filesystem capabilities, Auto permission checks, and classifier assembly run.
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: any) => {
    if (!body.stream) {
      classifierBodies.push(JSON.parse(JSON.stringify(body)))
      return Promise.resolve({ id: 'classifier', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'tool_use', id: 'verdict', name: body.tool_choice.name,
          input: body.max_tokens === 64 ? { shouldBlock: true } :
            { shouldBlock: false, thinking: 'Offline evidence fixture', reason: 'Fixture allows isolated edits' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } })
    }
    const index = round++
    if (index > edits.length + 1) throw new Error('Unexpected model request')
    const input = edits[index]
    const block = input ? { type: 'tool_use', id: `edit-${index}`, name: 'Edit', input } :
      index === edits.length ? { type: 'tool_use', id: 'receipt', name: 'Write',
        input: { file_path: join(root, 'reports', 'receipt.txt'), content: 'EVIDENCE_RECEIPT_PENDING' } } : null
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message: { id: `response-${index}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      yield { type: 'content_block_start', index: 0, content_block: block ? { ...block, input: {} } : { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: block ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: 'Finished.' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_delta', delta: { stop_reason: block ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: `request-${index}`, response: new Response('') }) }
  } } } }),
}))

const { enableConfigs } = await import('../utils/config.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { createQueryEngineSessionController } = await import('./createQueryEngineSessionController.js')
const { FileEditTool } = await import('../tools/FileEditTool/FileEditTool.js')
const { FileWriteTool } = await import('../tools/FileWriteTool/FileWriteTool.js')
enableConfigs()
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto' } }
const session = createQueryEngineAppSession({ cwd: process.cwd(), tools: [FileEditTool, FileWriteTool], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => { state = update(state) }, readFileCache: createFileStateCacheWithSizeLimit(20),
  customSystemPrompt: 'Perform the specified isolated edits and write a receipt.', userSpecifiedModel: 'claude-sonnet-4-5', recordTranscript: async () => null,
})
const controller = createQueryEngineSessionController(session)
const permissions: unknown[] = []
controller.subscribe(event => {
  if (event.type === 'permission.requested') {
    permissions.push(event.request)
    controller.respondToPermissionRequest(event.request.requestId, { behavior: 'deny', message: 'Unexpected fixture approval' })
  }
})
await controller.submit('Apply the exact isolated file edits, then write their receipt.')
await writeFile(join(root, 'evidence.json'), JSON.stringify({ classifierBodies, permissions,
  contents: await Promise.all(edits.map(input => readFile(input.file_path, 'utf8'))),
  receipt: await readFile(join(root, 'reports', 'receipt.txt'), 'utf8') }))
session.dispose?.()
