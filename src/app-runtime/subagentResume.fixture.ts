import { mock } from 'bun:test'
import { join } from 'node:path'

const root = process.env.HOME
if (!root || process.cwd() !== join(root, 'workspace') ||
    process.env.CLAUDE_CONFIG_DIR !== join(root, 'config')) {
  throw new Error('Isolated resume fixture required')
}

const scenario = process.argv[2]
const launchBrief = 'Original worker brief: inspect the isolated workspace.'
const resumeBrief = 'Current worker brief: check the new fixture condition.'
const role = 'fixture-worker'
const model = 'claude-sonnet-5-5'
const workerTools: string[][] = []
const reviews: unknown[] = []
let agentId: string | undefined
let launchOffered = false
let resumeOffered = false
let checkOffered = false
globalThis.fetch = Object.assign(async () => { throw new Error('Network forbidden') }, {
  preconnect: () => { throw new Error('Network forbidden') },
})
Object.assign(globalThis, { MACRO: { VERSION: 'subagent-resume-fixture' } })

mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create(body: {
    stream?: boolean
    messages: Array<{ content: unknown }>
    tools?: Array<{ name: string }>
  }) {
    if (!body.stream) {
      reviews.push(JSON.parse(String(body.messages.at(-1)?.content)))
      return Promise.resolve({ id: 'review', type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: JSON.stringify({ decision: 'deny', risk: 'medium', rationale: 'Fixture check held.' }) }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } })
    }

    const request = JSON.stringify(body.messages)
    const worker = request.includes(launchBrief) && !request.includes('Launch the fixture helper.')
    let call: { name: string; input: Record<string, unknown> } | undefined
    if (worker && request.includes(resumeBrief) && !checkOffered) {
      checkOffered = true
      workerTools.push(body.tools?.map(tool => tool.name) ?? [])
      call = { name: 'Bash', input: { command: 'printf fixture >> review-marker.txt', description: 'Check fixture review' } }
    } else if (worker && !request.includes(resumeBrief)) {
      workerTools.push(body.tools?.map(tool => tool.name) ?? [])
    } else if (!worker && !launchOffered) {
      launchOffered = true
      call = { name: 'Agent', input: { description: 'Launch fixture helper', subagent_type: role, prompt: launchBrief } }
    } else if (!worker && agentId && !resumeOffered) {
      resumeOffered = true
      call = { name: 'ResumeAgent', input: { agentId, prompt: resumeBrief } }
    }
    const id = crypto.randomUUID()
    const stream = Object.assign((async function* () {
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
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: id, response: new Response('') }) }
  } } } }),
}))

const { getSessionId, switchSession } = await import('../bootstrap/state.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { enableConfigs } = await import('../utils/config.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { flushSessionStorage, listAgentMetadataForSession, writeAgentMetadata } = await import('../utils/sessionStorage.js')
const { AgentTool } = await import('../tools/AgentTool/AgentTool.js')
const { ResumeAgentTool } = await import('../tools/ResumeAgentTool/ResumeAgentTool.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
const { FileReadTool } = await import('../tools/FileReadTool/FileReadTool.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')

enableConfigs()
switchSession(getSessionId())
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto', isAutoModeAvailable: true } }
const agents: import('../tools/AgentTool/loadAgentsDir.js').AgentDefinition[] = [{
  agentType: role, source: 'projectSettings', whenToUse: 'The isolated fixture', tools: ['Bash'],
  getSystemPrompt: () => 'Complete the fixture brief.',
}]
const session = createQueryEngineAppSession({
  cwd: process.cwd(), tools: [AgentTool, ResumeAgentTool, BashTool, FileReadTool],
  commands: [], mcpClients: [], agents, getAppState: () => state, setAppState: update => { state = update(state) },
  userSpecifiedModel: model, customSystemPrompt: 'Run the worker fixture.',
  readFileCache: createFileStateCacheWithSizeLimit(10),
})

try {
  await Array.fromAsync(session.submitMessage('Launch the fixture helper.'))
  await flushSessionStorage()
  const until = async <T>(read: () => Promise<T | undefined>) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = await read()
      if (found !== undefined) return found
      await Bun.sleep(20)
    }
    throw new Error('Timed out waiting for worker fixture')
  }
  const saved = await until(async () => (await listAgentMetadataForSession(getSessionId()))[0])
  agentId = saved.agentId
  if (scenario === 'denied') {
    state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, alwaysDenyRules: { session: [`Agent(${role})`] } } }
  } else if (scenario === 'missing') {
    agents.length = 0
  } else if (scenario === 'expanded') {
    agents[0] = { ...agents[0]!, tools: ['*'] }
  } else if (scenario === 'legacy') {
    const { originalToolNames: _originalToolNames, ...metadata } = saved.metadata
    await writeAgentMetadata(saved.agentId, metadata)
  }
  await Array.fromAsync(session.submitMessage('Resume the same helper with a new assignment.'))
  const resumeResult = session.getMessages().findLast(message => message.type === 'user' &&
    typeof message.toolUseResult === 'object' && message.toolUseResult !== null && 'success' in message.toolUseResult)
  const result = resumeResult?.type === 'user' ? resumeResult.toolUseResult as { success: boolean; message: string } : undefined
  if (!result) throw new Error('ResumeAgent result missing')
  if (result.success) {
    await until(async () => {
      const task = state.tasks[agentId!]
      return task?.status && task.status !== 'running' ? task.status : undefined
    })
  }
  await flushSessionStorage()
  console.log(JSON.stringify({ result, workerTools, reviews }))
} finally {
  session.dispose?.()
}
process.exit(0)
