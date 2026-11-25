import { mock } from 'bun:test'
import { join } from 'node:path'
import type { ContextualEvidence } from '../utils/permissions/contextualReviewPrompt.js'

const root = process.env.CONTEXTUAL_TRIM_ROOT
const cwd = process.cwd()
if (!root || process.env.HOME !== root || cwd !== join(root, 'workspace')) throw new Error('Isolated fixture required')
Object.assign(globalThis, { MACRO: { VERSION: 'contextual-trim-test' } })
globalThis.fetch = Object.assign(async () => { throw new Error('Unexpected network request') }, {
  preconnect: globalThis.fetch.preconnect,
})

const restriction = process.env.CONTEXTUAL_TRIM_RESTRICTION
const withdrawn = restriction === 'operator'
const grant = 'Should I append the two markers to effects.txt when you tell me to proceed?'
const withdrawal = 'Should I leave effects.txt unchanged after all?'
const teammateHold = 'Keep effects.txt unchanged while I am checking the fixture.'
const script = 'const next = "printf second >> effects.txt"; await tools.call({name:"Bash",input:{command:"printf first >> effects.txt"}}); await tools.call({name:"Bash",input:{command:next}});'
const marker = 'Unrelated observatory correspondence'
const reviews: { bytes: number; omittedCorrespondence: boolean; wholeScript: boolean; evidence: ContextualEvidence }[] = []
let nextResponse: string | { code: string; description: string } | undefined
let calls = 0

mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('Unexpected OAuth request') },
  getAnthropicClient: async () => ({ beta: { messages: { create(body: {
    stream: boolean; model: string; system: { text: string }[]; messages: { content: string }[]
  }) {
    const id = `fixture-response-${++calls}`
    const message = { id, type: 'message', role: 'assistant', model: body.model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } }
    if (!body.stream) {
      const content = body.messages.at(-1)!.content
      const evidence = JSON.parse(content) as ContextualEvidence
      const system = body.system.map(block => block.text).join('')
      reviews.push({ bytes: Buffer.byteLength(content) + Buffer.byteLength(system),
        omittedCorrespondence: evidence.conversation.filter(row => row.text.startsWith(marker)).length < 4,
        wholeScript: system.includes('Script review:'), evidence })
      const confirmed = evidence.conversation.filter(row => row.origin === 'operator' && row.text === 'Yes, do that.')
      const allowed = confirmed.some(row => row.proposal?.text === grant) &&
        !confirmed.some(row => row.proposal?.text === withdrawal) &&
        !evidence.conversation.some(row => row.origin === 'peer' && row.text === teammateHold)
      return Promise.resolve({ ...message, content: [{ type: 'text', text: JSON.stringify({
        decision: allowed ? 'allow' : 'deny', risk: 'medium', rationale: 'Fixture decision based on the linked replies.',
      }) }], stop_reason: 'end_turn' })
    }
    const response = nextResponse
    nextResponse = undefined
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message }
      if (typeof response === 'string') {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: response } }
        yield { type: 'content_block_stop', index: 0 }
      } else if (response) {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tool-${id}`, name: 'REPL', input: {} } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(response) } }
        yield { type: 'content_block_stop', index: 0 }
      }
      yield { type: 'message_delta', delta: { stop_reason: response && typeof response !== 'string' ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: id, response: new Response('') }) }
  } } } }),
}))

const { enableConfigs } = await import('../utils/config.js')
const { createUserMessage } = await import('../utils/messages.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
const { REPLTool } = await import('../tools/REPLTool/REPLTool.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { createQueryEngineSessionController } = await import('./createQueryEngineSessionController.js')

enableConfigs()
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: {
  ...state.toolPermissionContext, mode: 'auto', isAutoModeAvailable: true,
} }
const session = createQueryEngineSessionController(createQueryEngineAppSession({
  cwd, tools: [REPLTool, BashTool], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20), userSpecifiedModel: 'claude-sonnet-5-5',
  recordTranscript: async () => null,
  initialMessages: [
    ...Array.from({ length: 4 }, (_, index) => createUserMessage({
      content: `${marker} ${index}. ` + 'é'.repeat(280_000), origin: { kind: 'coordinator' },
    })),
    ...(restriction === 'teammate' ? [createUserMessage({ content: teammateHold,
      origin: { kind: 'teammate', messages: [{ kind: 'teammate', from: 'Fixture teammate', text: teammateHold }] },
    })] : []),
  ],
}))
let prompts = 0
session.subscribe(event => {
  if (event.type !== 'permission.requested') return
  prompts++
  session.respondToPermissionRequest(event.request.requestId, { behavior: 'deny', message: 'Unexpected fixture prompt.' })
})

nextResponse = grant
await session.submit('Propose how to write the fixture markers.')
nextResponse = withdrawn ? withdrawal : 'I will wait for the fixture run.'
await session.submit('Yes, do that.')
if (withdrawn) await session.submit('Yes, do that.')
nextResponse = { code: script, description: 'Write fixture markers' }
await session.submit('Run the fixture now, respecting my earlier decisions.')
session.dispose()

const effects = await Bun.file(join(cwd, 'effects.txt')).text().catch(() => null)
await Bun.write(join(root, 'evidence.json'), JSON.stringify({ reviews, effects, prompts, script, grant, withdrawal, teammateHold }))
