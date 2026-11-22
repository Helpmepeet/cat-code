import { mock } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppPermissionRequest } from './sessionEvents.js'

const home = process.env.HOME
if (!home || process.env.CLAUDE_CONFIG_DIR !== join(home, 'config') || process.cwd() !== join(home, 'workspace')) {
  throw new Error('Isolated background agent stop fixture required')
}

const model = 'claude-sonnet-5-5'
const scenario = process.argv[2]
const scriptFirst = scenario === 'script'
const holdEarlierApproval = scenario === 'approval'
const forceSend = scenario === 'force-send'
const unknownTool = scenario === 'unknown-tool' || scenario === 'unknown-tool-close'
const unknownToolName = 'UnknownFixtureTool'
const earlierTurn = 'Launch the earlier fixture worker.'
const currentTurn = 'Launch the current fixture worker.'
const briefs = { earlier: 'Earlier fixture worker.', current: 'Current fixture worker.' }
type Worker = keyof typeof briefs
type Call = { name: string; input: Record<string, unknown> }
const releaseWorkers = { earlier: Promise.withResolvers<void>(), current: Promise.withResolvers<void>() }
const parentWaiting = Promise.withResolvers<void>()
const workersWaiting = { earlier: Promise.withResolvers<void>(), current: Promise.withResolvers<void>() }
const earlierApproval = Promise.withResolvers<AppPermissionRequest>()
const offers = new Set<string>()

globalThis.fetch = Object.assign(async () => { throw new Error('Network forbidden') }, {
  preconnect: () => { throw new Error('Network forbidden') },
})
Object.assign(globalThis, { MACRO: { VERSION: 'background-agent-stop-fixture' } })

mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create(body: {
    stream?: boolean
    messages: Array<{ content: unknown }>
    tools?: Array<{ name: string }>
  }, options: { signal?: AbortSignal }) {
    if (!body.stream) {
      return Promise.resolve({ id: 'review', type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: JSON.stringify({ decision: 'allow', risk: 'low', rationale: 'The operator asked for this fixture action.' }) }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } })
    }

    // Direct Agent calls place the worker brief in its own request. In the parent
    // the launch brief appears within the tool use, alongside the operator turn.
    const request = JSON.stringify(body.messages)
    const worker = request.includes(currentTurn) || request.includes(earlierTurn) ? undefined
      : (Object.keys(briefs) as Worker[]).find(name => request.includes(briefs[name]))
    const binding = worker ?? (request.includes(currentTurn) ? 'current-parent' : 'earlier-parent')
    const first = !offers.has(binding)
    offers.add(binding)
    const name = request.includes(currentTurn) ? 'current' : 'earlier'
    const action: Call | undefined = !first
      ? unknownTool && binding === 'current-parent' ? { name: unknownToolName, input: {} } : undefined
      : worker
      ? { name: 'Bash', input: { command: `printf fixture > ${worker}.txt`, description: `Write the ${worker} fixture marker` } }
      : { name: 'Agent', input: { description: `Launch ${name} worker`, subagent_type: 'general-purpose', prompt: briefs[name], run_in_background: true } }
    const useScript = scriptFirst && (!worker || !body.tools?.some(tool => tool.name === 'Bash'))
    const call: Call | undefined = action && useScript ? { name: 'REPL', input: {
      description: String(action.input.description), code: `await tools.call(${JSON.stringify(action)});`,
    } } : action
    const id = crypto.randomUUID()
    const controller = new AbortController()
    const signal = options.signal ?? controller.signal
    const stream = Object.assign((async function* () {
      if (worker && first) {
        workersWaiting[worker].resolve()
        await releaseWorkers[worker].promise
      }
      if (!worker && !first && binding === 'current-parent') {
        await workersWaiting.current.promise
        parentWaiting.resolve()
        if (!unknownTool) await new Promise<void>(resolve => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      if (signal.aborted) return
      yield { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      yield { type: 'content_block_start', index: 0, content_block: call
        ? { type: 'tool_use', id, name: call.name, input: {} } : { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: call
        ? { type: 'input_json_delta', partial_json: JSON.stringify(call.input) }
        : { type: 'text_delta', text: 'Fixture response.' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller })
    return { withResponse: async () => ({ data: stream, request_id: id, response: new Response('') }) }
  } } } }),
}))

const { getSessionId, switchSession } = await import('../bootstrap/state.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { AgentTool } = await import('../tools/AgentTool/AgentTool.js')
const { GENERAL_PURPOSE_AGENT } = await import('../tools/AgentTool/built-in/generalPurposeAgent.js')
const { isLocalAgentTask } = await import('../tasks/LocalAgentTask/LocalAgentTask.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
const { REPLTool } = await import('../tools/REPLTool/REPLTool.js')
const { enableConfigs } = await import('../utils/config.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { createQueryEngineSessionController } = await import('./createQueryEngineSessionController.js')

enableConfigs()
if (!scriptFirst) switchSession(getSessionId())
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: {
  ...state.toolPermissionContext, mode: 'auto', isAutoModeAvailable: true,
  ...(holdEarlierApproval && { alwaysAskRules: { session: ['Bash'] } }),
} }

const session = createQueryEngineAppSession({
  cwd: process.cwd(), tools: [AgentTool, BashTool, ...(scriptFirst ? [REPLTool] : [])], commands: [], mcpClients: [],
  agents: [holdEarlierApproval ? { ...GENERAL_PURPOSE_AGENT, permissionMode: 'bubble' } : GENERAL_PURPOSE_AGENT],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(10), customSystemPrompt: 'Run the isolated stop fixture.', userSpecifiedModel: model,
})
const controller = createQueryEngineSessionController(session)
controller.subscribe(event => {
  if (event.type === 'permission.requested' && event.request.request.tool_name === 'Bash') {
    earlierApproval.resolve(event.request)
  }
})

const getStatus = (name: Worker) => Object.values(state.tasks).filter(isLocalAgentTask)
  .find(task => task.prompt === briefs[name])?.status
const readMarker = (name: Worker) => readFile(`${name}.txt`, 'utf8').catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return null
  throw error
})

try {
  await controller.submit(earlierTurn)
  await workersWaiting.earlier.promise
  let pendingEarlierApproval: AppPermissionRequest | undefined
  if (holdEarlierApproval) {
    releaseWorkers.earlier.resolve()
    pendingEarlierApproval = await earlierApproval.promise
  }
  const turn = controller.submit(currentTurn)
  await Promise.all([workersWaiting.current.promise, parentWaiting.promise])
  const statusesBefore = { earlier: getStatus('earlier'), current: getStatus('current') }
  if (forceSend) controller.abort('Force-send the fixture turn', 'interrupt')
  else if (!unknownTool) controller.abort('Stop the current fixture turn')
  await turn
  const statusesAfterStop = { earlier: getStatus('earlier'), current: getStatus('current') }
  const unknownToolReported = session.getMessages?.().some(message => message.type === 'user' &&
    message.toolUseResult === `Error: No such tool available: ${unknownToolName}`)
  if (scenario === 'unknown-tool-close') {
    const { createSidecarCleanup } = await import('../../app/sidecar/sidecarCleanup.js')
    await createSidecarCleanup({
      closeSocket: () => controller.dispose(),
      disposeMcpLifecycle: async () => {},
      releaseTranscriptLease: async () => {},
      onDiagnostic: diagnostic => { throw new Error(JSON.stringify(diagnostic)) },
      exit: () => {},
    }).exit(0)
  }
  const pendingId = pendingEarlierApproval?.requestId
  const earlierApprovalSurvived = controller.getPendingPermissionRequests().some(request => request.requestId === pendingId)
  let earlierApprovalAccepted = false
  if (pendingEarlierApproval && earlierApprovalSurvived) {
    earlierApprovalAccepted = controller.respondToPermissionRequest(pendingEarlierApproval.requestId,
      { behavior: 'allow', updatedInput: pendingEarlierApproval.request.input })
  }
  releaseWorkers.earlier.resolve()
  releaseWorkers.current.resolve()
  for (let attempt = 0; attempt < 150 && (getStatus('earlier') === 'running' || getStatus('current') === 'running'); attempt++) {
    await Bun.sleep(20)
  }
  console.log(JSON.stringify({ statusesBefore, statusesAfterStop,
    finalEarlierStatus: getStatus('earlier'), finalCurrentStatus: getStatus('current'),
    earlierMarker: await readMarker('earlier'), currentMarker: await readMarker('current'),
    earlierApprovalSurvived, earlierApprovalAccepted, unknownToolReported }))
} finally {
  releaseWorkers.earlier.resolve()
  releaseWorkers.current.resolve()
  session.dispose?.()
}
process.exit(0)
