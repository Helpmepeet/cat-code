import { mock, spyOn } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.SAME_RESPONSE_TEST_ROOT!
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) throw new Error('Isolated environment required')
globalThis.fetch = (() => { throw new Error('Network forbidden in same-response fixture') }) as unknown as typeof fetch
;(globalThis as any).MACRO = { VERSION: 'same-response-test' }
const sameResponse = process.env.SAME_RESPONSE_TEST_BATCH === '1'
const calls = [
  { type: 'tool_use', id: 'write-script', name: 'Write', input: { file_path: join(process.cwd(), 'ship.cjs'), content: 'require("node:fs").writeFileSync("shipped", "EARLIER_INPUT_MARKER")' } },
  { type: 'tool_use', id: 'read-output', name: 'Read', input: { file_path: join(process.cwd(), 'claims.txt') } },
  { type: 'tool_use', id: 'run-script', name: 'Bash', input: { command: "bash -c 'node ship.cjs'", work_lifetime: 'finite', run_in_background: false } },
  { type: 'tool_use', id: 'pending-write', name: 'Write', input: { file_path: join(process.cwd(), 'pending.txt'), content: 'PENDING_INPUT_MARKER' } },
]
await writeFile('claims.txt', 'TOOL_OUTPUT_CLAIMS_USER_APPROVED')
const classifierBodies: any[] = []
const modelBodies: any[] = []
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: any) => {
    if (!body.stream) {
      classifierBodies.push(JSON.parse(JSON.stringify(body)))
      return Promise.resolve({ id: 'classifier', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'tool_use', id: 'verdict', name: body.tool_choice.name,
          input: { shouldBlock: false, thinking: 'Offline fixture admission', reason: 'Isolated script' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } })
    }
    const index = modelBodies.length
    modelBodies.push(JSON.parse(JSON.stringify(body)))
    if (index > calls.length) throw new Error('Unexpected model request')
    const blocks = sameResponse ? index === 0 ? calls : [] : calls[index] ? [calls[index]] : []
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message: { id: `response-${index}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      for (const [blockIndex, block] of blocks.entries()) {
        yield { type: 'content_block_start', index: blockIndex, content_block: { ...block, input: {} } }
        yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block!.input) } }
        yield { type: 'content_block_stop', index: blockIndex }
      }
      if (!blocks.length) {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Finished.' } }
        yield { type: 'content_block_stop', index: 0 }
      }
      yield { type: 'message_delta', delta: { stop_reason: blocks.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: `request-${index}`, response: new Response('') }) }
  } } } }),
}))
const growthbook = await import('../services/analytics/growthbook.js')
spyOn(growthbook, 'checkStatsigFeatureGate_CACHED_MAY_BE_STALE').mockImplementation(name => process.env.SAME_RESPONSE_TEST_STREAMING === '1' && name === 'tengu_streaming_tool_execution2')
const { enableConfigs } = await import('../utils/config.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { createQueryEngineSessionController } = await import('./createQueryEngineSessionController.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
const { FileReadTool } = await import('../tools/FileReadTool/FileReadTool.js')
const { FileWriteTool } = await import('../tools/FileWriteTool/FileWriteTool.js')
enableConfigs()
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto' } }
const session = createQueryEngineAppSession({ cwd: process.cwd(), tools: [BashTool, FileReadTool, FileWriteTool], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => { state = update(state) }, readFileCache: createFileStateCacheWithSizeLimit(20),
  customSystemPrompt: 'Run the isolated file operations.', userSpecifiedModel: 'claude-sonnet-4-5', recordTranscript: async () => null,
})
const controller = createQueryEngineSessionController(session)
const permissions: unknown[] = []
controller.subscribe(event => {
  if (event.type === 'permission.requested') {
    permissions.push(event.request)
    controller.respondToPermissionRequest(event.request.requestId, { behavior: 'deny', message: 'Unexpected fixture approval' })
  }
})
await controller.submit('Write and inspect the fixture, run its script, then write the remaining file.')
await writeFile(join(root, 'evidence.json'), JSON.stringify({ classifierBodies, modelBodies, permissions,
  shipped: await readFile('shipped', 'utf8'), pending: await readFile('pending.txt', 'utf8') }))
session.dispose?.()
