import { randomUUID } from 'node:crypto'
import { mock } from 'bun:test'
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostResultMessage, PeerDeliverMessage } from '../../app/shared/protocol.js'
import type { PeerHostRequester } from '../../app/sidecar/peerHostRequester.js'

const root = process.env.CONTEXTUAL_AUTO_PEER_ROOT
const cwd = process.cwd()
if (!root || process.env.HOME !== root || cwd !== join(root, 'workspace')) throw new Error('Isolated fixture required')
Object.assign(globalThis, { MACRO: { VERSION: 'contextual-auto-peer-test' } })
globalThis.fetch = Object.assign(async () => { throw new Error('Unexpected network request') }, { preconnect: globalThis.fetch.preconnect })

const restriction = 'Leave status.txt unchanged until I approve the peer edit.'
const approval = 'I approve the peer changing status.txt to new.'
const withdrawal = 'I withdraw approval for the peer edit. Leave status.txt unchanged.'
const file = join(cwd, 'status.txt')
const openingBrief = 'Update status.txt to new.'
const editScript = `await tools.call({name:"Read",input:{file_path:"status.txt"}});
await tools.call({name:"Edit",input:{file_path:"status.txt",old_string:"old",new_string:"new"}});`
const bashScript = `await tools.call({name:"Bash",input:{command:"printf new > status.txt",work_lifetime:"finite",run_in_background:false}});`
let nextAction: { name: string; input: Record<string, string> } | undefined = {
  name: 'CreatePeer', input: { prompt: openingBrief },
}
let calls = 0
const host: { delivery?: PeerDeliverMessage; result?: HostResultMessage } = {}
const reviews: { tool: string; anchored: boolean; latestCreatorInstruction: string | undefined }[] = []
const principals: { actor: string; assignment: unknown; correspondence: unknown[] }[] = []
let workingLaunchContext: string | undefined

mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create(body: { stream: boolean; model: string; messages: { content: string }[] }) {
    if (!body.stream) {
      const packet = JSON.parse(body.messages.at(-1)!.content) as import('../utils/permissions/contextualReviewPrompt.js').ContextualEvidence
      const latestCreatorInstruction = packet.assignment?.parent?.findLast(entry => entry.origin === 'operator')?.text
      if (packet.action.tool === 'Bash' || packet.action.tool === 'Edit') reviews.push({
        tool: packet.action.tool,
        anchored: packet.assignment?.parentAnchor === launchUserMessageId,
        latestCreatorInstruction,
      })
      if (packet.action.tool === 'Bash') {
        const { parent, parentAnchor, ...assignment } = packet.assignment ?? {}
        principals.push({ actor: packet.action.actor, assignment: packet.assignment && assignment,
          correspondence: packet.conversation.filter(entry => entry.origin === 'peer').map(({ actor, text }) => ({ actor, text })) })
      }
      const decision = packet.action.tool === 'CreatePeer' || latestCreatorInstruction === approval ? 'allow' : 'deny'
      return Promise.resolve({ id: 'fixture-review', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: JSON.stringify({ decision, risk: 'medium', rationale: 'Fixture creator scope.' }) }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } })
    }
    const action = nextAction
    if (action?.name === 'REPL') workingLaunchContext ??= JSON.stringify(body.messages)
    nextAction = undefined
    const id = `response-${++calls}`
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      if (action) {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tool-${id}`, name: action.name, input: {} } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(action.input) } }
        yield { type: 'content_block_stop', index: 0 }
      }
      yield { type: 'message_delta', delta: { stop_reason: action ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: id, response: new Response('') }) }
  } } } }),
}))

const { enableConfigs } = await import('../utils/config.js')
const { asSessionId } = await import('../types/ids.js')
const { getSessionId, switchSession } = await import('../bootstrap/state.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { createQueryEngineSessionController } = await import('./createQueryEngineSessionController.js')
const { getTranscriptPath, loadTranscriptFile, resetSessionFilePointer, selectActiveConversation } = await import('../utils/sessionStorage.js')
const { activateTranscriptLease } = await import('../utils/transcriptLease.js')
const { createUserMessage } = await import('../utils/messages.js')
const { FileReadTool } = await import('../tools/FileReadTool/FileReadTool.js')
const { FileEditTool } = await import('../tools/FileEditTool/FileEditTool.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
const { REPLTool } = await import('../tools/REPLTool/REPLTool.js')
const { createCreatePeerTool } = await import('../../app/sidecar/createPeerTool.js')
const { createPeerRequestPlane } = await import('../../app/main/peerRequestPlane.js')
const { PROTOCOL_VERSION } = await import('../../app/shared/protocol.js')

enableConfigs()
const creatorEngineId = getSessionId()
switchSession(creatorEngineId)
const creatorPath = getTranscriptPath()
const creatorAppId = randomUUID()
const peerAppId = randomUUID()
const peerEngineId = asSessionId(randomUUID())
const launchUserMessageId = randomUUID()
const rows = [
  { appSessionId: creatorAppId, engineSessionId: creatorEngineId, name: 'Creator' },
  { appSessionId: peerAppId, engineSessionId: peerEngineId, name: 'Peer' },
].map(row => ({ ...row, cwd, lastAttachedAt: 0, lastMessageSentAt: null, shutdown: null }))
const plane: ReturnType<typeof createPeerRequestPlane> = createPeerRequestPlane({
  rows: () => rows, setPeerNotice: async () => null, isLive: () => true, isReady: () => true, canResume: () => false,
  createSessionInWorkspace: async () => {
    plane.onReady(peerAppId)
    return { ok: true, value: { appSessionId: peerAppId, name: 'Peer' } }
  },
  restoreSession: async () => { throw new Error('Fixture peers are live') },
  forward: (_id, message) => {
    if (message.type === 'peer.deliver') host.delivery = message
    if (message.type === 'host.result') host.result = message
    return null
  },
  logRouted: () => {},
})
const requestHost: PeerHostRequester = async (verb, args) => {
  await plane.handleRequest(creatorAppId, {
    kind: 'host.request', protocolVersion: PROTOCOL_VERSION, sessionId: creatorAppId,
    requestId: randomUUID(), verb, args,
  })
  if (!host.result?.ok) throw new Error(JSON.stringify(host.result))
  return { ok: true, value: host.result.value as never }
}
let prompts = 0
function controllerFor(tools: import('../Tool.js').Tools, peerCreatorAppSessionId: string | null,
  initialMessages?: import('../types/message.js').Message[]) {
  let state = getDefaultAppState()
  state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto', isAutoModeAvailable: true } }
  const controller = createQueryEngineSessionController(createQueryEngineAppSession({
    cwd, tools, commands: [], mcpClients: [], agents: [], getAppState: () => state,
    setAppState: update => { state = update(state) }, readFileCache: createFileStateCacheWithSizeLimit(20),
    userSpecifiedModel: 'claude-sonnet-5-5', peerCreatorAppSessionId, initialMessages,
  }))
  controller.subscribe(event => {
    if (event.type !== 'permission.requested') return
    prompts++
    controller.respondToPermissionRequest(event.request.requestId, { behavior: 'deny', message: 'Unexpected fixture permission prompt.' })
  })
  return controller
}

const creator = controllerFor([createCreatePeerTool(requestHost), BashTool], null)
await creator.submit(`Create the peer for this experiment. ${restriction}`, { uuid: launchUserMessageId })
const { delivery } = host
if (!delivery?.assignment) throw new Error('Launch did not deliver a verified creator reference')
const statusUpdate = 'The fixture investigation is still in progress.'
const statusOrigin = { kind: 'peer' as const, name: 'Other chat', appSessionId: randomUUID() }
const shellAction = { name: 'Bash', input: { command: 'printf new > status.txt' } }
nextAction = shellAction
await creator.submit(statusUpdate, { origin: statusOrigin })
const loaded = await loadTranscriptFile(creatorPath, { strict: true, keepAllLeaves: true })
const active = selectActiveConversation(loaded.messages, loaded.leafUuids, loaded.activeConversationTip)
creator.dispose()
const resumedCreator = controllerFor([BashTool], null, active.messages)
nextAction = shellAction
await resumedCreator.submit('The fixture investigation is finished.', { origin: statusOrigin })
resumedCreator.dispose()
const mainPrincipals = principals.splice(0)
reviews.length = 0
let parentUuid = active.tip?.uuid
async function addCreatorInstruction(text: string) {
  const message = createUserMessage({ content: text })
  const row = { ...message, parentUuid, cwd, sessionId: creatorEngineId, isSidechain: false, userType: 'external' }
  const tip = { type: 'active-conversation-tip', sessionId: creatorEngineId, tipUuid: message.uuid }
  await appendFile(creatorPath, JSON.stringify(row) + '\n' + JSON.stringify(tip) + '\n')
  parentUuid = message.uuid
}

await activateTranscriptLease(peerEngineId)
switchSession(peerEngineId, null, { fresh: true })
await resetSessionFilePointer()
const peer = controllerFor([REPLTool, FileReadTool, FileEditTool, BashTool], creatorAppId)
const origin = { kind: 'peer' as const, name: delivery.from, appSessionId: delivery.fromSessionId }
const effects: string[] = []
for (const [index, instruction] of [null, approval, withdrawal].entries()) {
  if (instruction) await addCreatorInstruction(instruction)
  await writeFile(file, 'old')
  nextAction = { name: 'REPL', input: { code: bashScript, description: 'Update fixture status' } }
  await peer.submit(index === 0 ? delivery.text : statusUpdate, {
    origin: index === 0 ? { ...origin, creationPrompt: true, assignment: delivery.assignment } : statusOrigin,
  })
  effects.push(await readFile(file, 'utf8'))
}
nextAction = { name: 'REPL', input: { code: editScript, description: 'Update fixture status with Edit' } }
await peer.submit(openingBrief, { origin })
effects.push(await readFile(file, 'utf8'))
await rename(creatorPath, `${creatorPath}.unavailable`)
nextAction = { name: 'REPL', input: { code: bashScript, description: 'Update fixture status without creator transcript' } }
await peer.submit(statusUpdate, { origin: statusOrigin })
const withoutCreator = { principal: principals.pop(), review: reviews.pop(), file: await readFile(file, 'utf8') }
console.log(JSON.stringify({ effects, reviews, prompts, workingLaunchContext, mainPrincipals, principals, withoutCreator, launchBrief: delivery.text }))
process.exit(0)
