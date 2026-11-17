import { mock } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.AUTO_HISTORY_TEST_ROOT!
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) throw new Error('Isolated environment required')
globalThis.fetch = (() => { throw new Error('Network forbidden in history fixture') }) as unknown as typeof fetch
;(globalThis as any).MACRO = { VERSION: 'auto-history-test' }
const scenario = process.env.AUTO_HISTORY_TEST_SCENARIO!
const noise = Array.from({ length: 6 }, (_, index) => ({ type: 'tool_use', id: `noise-${index}`, name: 'Write', input: {
  file_path: join(process.cwd(), 'notes', `archive-${index}.md`), content: `NOISE_HISTORY_MARKER_${index}_${'z'.repeat(6000)}`,
} }))
const copied = 'COPIED_PROVENANCE_MARKER'
const prior = scenario === 'copied'
  ? [{ type: 'tool_use', id: 'source', name: 'Write', input: { file_path: join(process.cwd(), 'notes', 'source.txt'), content: copied } }]
  : scenario === 'import'
    ? [{ type: 'tool_use', id: 'helper', name: 'Write', input: { file_path: join(process.cwd(), 'helper.cjs'), content: 'module.exports = "OLD_HELPER_MARKER"' } }]
    : scenario === 'refusal'
      ? [{ type: 'tool_use', id: 'refused', name: 'Write', input: { file_path: join(root, 'reports', 'denied.txt'), content: 'REFUSAL_HISTORY_MARKER' } }]
      : []
const target = join(root, 'reports', scenario === 'import' ? 'status.cjs' : 'status.txt')
const pending = { type: 'tool_use', id: 'pending', name: 'Write', input: { file_path: target,
  content: scenario === 'copied' ? copied : scenario === 'import' ? `require(${JSON.stringify(join(process.cwd(), 'helper.cjs'))})` : 'REPORT_READY' } }
const classifierBodies: any[] = []
const modelHistory: boolean[] = []
let round = 0
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: any) => {
    if (!body.stream) {
      classifierBodies.push(JSON.parse(JSON.stringify(body)))
      if (scenario === 'fallback' && body.model === 'gpt-6-luna') {
        throw Object.assign(new Error('Fixture reviewer temporarily unavailable'), { status: 503 })
      }
      const shouldBlock = JSON.stringify(body.messages).includes('denied.txt') && !JSON.stringify(body.messages).includes('status.txt')
      return Promise.resolve({ id: 'classifier', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'tool_use', id: 'verdict', name: body.tool_choice.name,
          input: { shouldBlock, thinking: 'Offline history fixture', reason: 'Fixture review' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } })
    }
    const index = round++
    modelHistory.push(JSON.stringify(body.messages).includes('NOISE_HISTORY_MARKER'))
    if (index > 3) throw new Error('Unexpected model request')
    const blocks: any[] = index === 0 ? [...noise, ...prior] : index === 2 ? [pending] : [{ type: 'text', text:
      index === 1 && scenario === 'proposal'
        ? 'Create both reports only after preserving PROPOSAL_SCOPE_MARKER, and keep the earlier report as context.'
        : 'Finished.' }]
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message: { id: `response-${index}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      for (const [blockIndex, block] of blocks.entries()) {
        yield { type: 'content_block_start', index: blockIndex, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } }
        yield { type: 'content_block_delta', index: blockIndex, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }
        yield { type: 'content_block_stop', index: blockIndex }
      }
      yield { type: 'message_delta', delta: { stop_reason: blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
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
const { FileWriteTool } = await import('../tools/FileWriteTool/FileWriteTool.js')
const { collectPermissionDecisionContexts } = await import('../utils/permissions/permissionDecisionContext.js')
enableConfigs()
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: scenario === 'refusal' ? 'acceptEdits' : 'auto' } }
const session = createQueryEngineAppSession({ cwd: process.cwd(), tools: [FileWriteTool], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => { state = update(state) }, readFileCache: createFileStateCacheWithSizeLimit(20),
  customSystemPrompt: 'Write ordinary isolated artifacts.', userSpecifiedModel: 'claude-sonnet-4-5', recordTranscript: async () => null,
})
const controller = createQueryEngineSessionController(session)
const permissions: unknown[] = []
controller.subscribe(event => {
  if (event.type === 'permission.requested') {
    permissions.push(event.request)
    controller.respondToPermissionRequest(event.request.requestId, { behavior: 'deny', message: 'Explicit fixture refusal', decisionClassification: 'user_reject' })
  }
})
await controller.submit('Create disposable fixture artifacts.')
if (scenario === 'local-command') {
  const { createCommandInputMessage, normalizeMessagesForAPI } = await import('../utils/messages.js')
  const { selectAutoModeHistory } = await import('../utils/permissions/autoModeHistory.js')
  const { buildTranscriptForClassifier } = await import('../utils/permissions/yoloClassifier.js')
  const retained = [...session.getMessages!()]
  // Tool owners can return local-command records without a slash-input caveat.
  // Exercise that open engine message contract using actual retained writes.
  const context = [...retained, createCommandInputMessage('<local-command-stdout>SLASH_STDOUT_DEPENDENCY_MARKER notes/archive-0.md</local-command-stdout>')]
  const ordinary = selectAutoModeHistory(retained, pending, [FileWriteTool], process.cwd())
  const selected = selectAutoModeHistory(context, pending, [FileWriteTool], process.cwd())
  const review = buildTranscriptForClassifier(selected.messages, [FileWriteTool], false)
  const fullReview = buildTranscriptForClassifier(context, [FileWriteTool], false)
  const main = JSON.stringify(normalizeMessagesForAPI(context, [FileWriteTool], 'firstParty').map(message => message.message))
  await writeFile(join(root, 'evidence.json'), JSON.stringify({ ordinaryDroppedCalls: ordinary.droppedCalls,
    opaqueDroppedCalls: selected.droppedCalls, reviewMatchesFull: review === fullReview,
    reviewHasNoise: review.includes('NOISE_HISTORY_MARKER'), reviewHasRawOutput: review.includes('SLASH_STDOUT_DEPENDENCY_MARKER'),
    mainHasRawOutput: main.includes('SLASH_STDOUT_DEPENDENCY_MARKER'), noiseContent: await readFile(noise[0]!.input.file_path, 'utf8') }))
  session.dispose?.()
  process.exit(0)
}
const firstReviewCount = classifierBodies.length
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto' } }
await controller.submit(scenario === 'proposal' ? 'Yes.' : 'Produce a completion report.')
await writeFile(join(root, 'evidence.json'), JSON.stringify({ classifierBodies: classifierBodies.slice(firstReviewCount), permissions,
  content: await readFile(target, 'utf8'), decisions: collectPermissionDecisionContexts([...session.getMessages!()]),
  noiseContent: await readFile(noise[0]!.input.file_path, 'utf8'), mainHistoryRetainsNoise: modelHistory.at(-1) }))
session.dispose?.()
