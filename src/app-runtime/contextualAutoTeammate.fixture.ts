import { mock } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'

const root = process.env.TEAMMATE_TEST_ROOT
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) {
  throw new Error('Isolated teammate fixture required')
}
Object.assign(globalThis, { MACRO: { VERSION: 'contextual-teammate-test' } })
globalThis.fetch = Object.assign(async () => { throw new Error('Unexpected network request') }, {
  preconnect: globalThis.fetch.preconnect,
})

const team = 'review-team'
const worker = 'worker'
const approvalMode = process.env.TEAMMATE_TEST_APPROVAL
const brief = 'Write the marker requested by the operator. This is the named teammate fixture.'
const operator = 'Have the named teammate write the fixture marker.'
const parentActions = [
  { name: 'TeamCreate', input: { team_name: team } },
  { name: 'Agent', input: { name: worker, team_name: team, prompt: brief, description: 'Write the fixture marker' } },
]
const workerAction = { name: 'Bash', input: { command: 'printf approved-by-leader > marker.txt' } }
const workerActions = [workerAction]
const parentReady = Promise.withResolvers<void>()
const workerReported = Promise.withResolvers<void>()
let parentCalls = 0
let workerCalls = 0
let assignment: unknown
let workerResult: unknown
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create(body: any) {
    if (!body.stream) {
      const content = JSON.parse(body.messages.at(-1).content)
      if (content.action.tool !== workerAction.name) throw new Error('Unexpected review action')
      assignment = content.assignment
      return Promise.resolve({
        id: 'review', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: JSON.stringify({ decision: 'ask', risk: 'medium', rationale: 'Ask the leader.' }) }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 },
      })
    }

    const isWorker = body.messages.some((message: any) => message.role === 'user' && (
      typeof message.content === 'string'
        ? message.content.includes(brief)
        : message.content.some((block: any) => block.type === 'text' && block.text.includes(brief))
    ))
    const index = isWorker ? workerCalls++ : parentCalls++
    if (isWorker && index === 1) {
      workerResult = body.messages.flatMap((message: any) => message.content).find((block: any) => block.type === 'tool_result' && block.tool_use_id === 'worker-0')
    }
    const action = (isWorker ? workerActions : parentActions)[index]
    const id = `${isWorker ? 'worker' : 'parent'}-${index}`
    const stream = Object.assign((async function* () {
      // Take the first worker decision after the parent has published its launch result.
      if (isWorker && index === 0) await parentReady.promise
      if (isWorker && index === 1) workerReported.resolve()
      if (!isWorker && index === parentActions.length) {
        parentReady.resolve()
        await workerReported.promise
      }
      yield { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      if (action) {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: action.name, input: {} } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(action.input) } }
        yield { type: 'content_block_stop', index: 0 }
      }
      yield { type: 'message_delta', delta: { stop_reason: action ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: id, response: new Response('') }) }
  } } } }),
}))

const { getSessionId, switchSession } = await import('../bootstrap/state.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { AgentTool } = await import('../tools/AgentTool/AgentTool.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
const { TeamCreateTool } = await import('../tools/TeamCreateTool/TeamCreateTool.js')
const { enableConfigs } = await import('../utils/config.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { clearCliTeammateModeOverride } = await import('../utils/swarm/backends/teammateModeSnapshot.js')
const { TEAM_LEAD_NAME } = await import('../utils/swarm/constants.js')
const { registerLeaderToolUseConfirmQueue, unregisterLeaderToolUseConfirmQueue } = await import('../utils/swarm/leaderPermissionBridge.js')
const { sendPermissionResponseViaMailbox } = await import('../utils/swarm/permissionSync.js')
const { readMailbox } = await import('../utils/teammateMailbox.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')

enableConfigs()
switchSession(getSessionId())
clearCliTeammateModeOverride('in-process')
let state = getDefaultAppState()
state = {
  ...state,
  toolPermissionContext: {
    ...state.toolPermissionContext, mode: 'auto', isAutoModeAvailable: true,
    alwaysAllowRules: { session: ['TeamCreate', 'Agent'] },
  },
}
const session = createQueryEngineAppSession({
  cwd: process.cwd(), tools: [TeamCreateTool, AgentTool, BashTool], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20), userSpecifiedModel: 'claude-sonnet-5-5',
  recordTranscript: async () => null,
})

const readEffect = () => readFile(join(process.cwd(), 'marker.txt'), 'utf8').catch(() => null)
let approval: { worker: string | undefined; tool: string; effectBeforeApproval: string | null } | undefined
async function approveMailboxRequest() {
  await parentReady.promise
  while (!approval) {
    const inbox = await readMailbox(TEAM_LEAD_NAME, team)
    const request = inbox.find(message => message.control?.type === 'permission_request')?.control
    if (request?.type === 'permission_request') {
      approval = { worker: request.agent_id, tool: request.tool_name, effectBeforeApproval: await readEffect() }
      const updatedInput = approvalMode === 'mailbox-revised'
        ? { ...request.input, command: 'printf revised-by-leader > marker.txt' }
        : request.input
      if (!await sendPermissionResponseViaMailbox(worker, {
        decision: 'approved', resolvedBy: 'leader', updatedInput,
      }, request.request_id, team)) throw new Error('Failed to send fixture leader approval')
      return
    }
    await Bun.sleep(25)
  }
}

const usingDialog = approvalMode === 'dialog'
const dialog = Promise.withResolvers<ToolUseConfirm>()
if (usingDialog) {
  registerLeaderToolUseConfirmQueue(update => {
    const next = update([])[0]
    if (next) dialog.resolve(next)
  })
}
const watchdog = setTimeout(() => {
  console.error(JSON.stringify({ parentCalls, workerCalls, assignment, approval,
    messages: session.getMessages?.().filter(message => message.type === 'user' && message.toolUseResult).map(message => message.type === 'user' && message.toolUseResult),
    tasks: Object.values(state.tasks).map(task => ({ status: task.status, type: task.type })),
  }))
  process.exit(1)
}, 8000)
try {
  await Promise.all([
    (async () => { for await (const _ of session.submitMessage(operator)) { /* drain the engine */ } })(),
    usingDialog ? dialog.promise.then(async request => {
      approval = { worker: request.workerBadge?.name, tool: request.tool.name, effectBeforeApproval: await readEffect() }
      request.onAllow(request.input, [])
    }) : approveMailboxRequest(),
  ])
  await writeFile(join(root, 'evidence.json'), JSON.stringify({
    operatorId: session.getMessages?.().find(message => message.type === 'user' && message.message.content === operator)?.uuid,
    assignment, approval, workerResult, effect: await readEffect(),
  }))
} finally {
  clearTimeout(watchdog)
  unregisterLeaderToolUseConfirmQueue()
  for (const task of Object.values(state.tasks)) {
    if (task.type === 'in_process_teammate') task.abortController?.abort()
  }
  session.dispose?.()
}
