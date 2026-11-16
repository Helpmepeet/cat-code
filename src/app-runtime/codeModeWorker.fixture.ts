import { mock } from 'bun:test'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { watch } from 'node:fs'
import { YOLO_CLASSIFIER_TOOL_NAME } from '../utils/permissions/classifierShared.js'
const root = process.env.CODE_MODE_TEST_ROOT!
const workerBackground = process.env.CODE_MODE_TEST_SCENARIO === 'worker-background'
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) throw new Error('Isolated worker fixture required')
globalThis.fetch = (() => { throw new Error('Network forbidden') }) as unknown as typeof fetch
;(globalThis as any).MACRO = { VERSION: 'code-mode-worker-test' }
await writeFile(join(root, 'workspace', 'worker-source.txt'), 'model-visible-worker-read-marker\n')
const evidence = { classifiers: [] as any[], workerRequests: [] as any[], apiRequests: [] as any[], parentRequests: 0, transcript: [] as any[], workerOutput: '', tasks: {} as any, workerForbidden: null as string | null, workerAuditChain: [] as any[], workerActivityWasLive: false }
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: any) => {
    if (body.tool_choice?.name === YOLO_CLASSIFIER_TOOL_NAME) {
      evidence.classifiers.push(JSON.parse(JSON.stringify(body)))
      const first = evidence.classifiers.length % 2 === 1
      return Promise.resolve({ id: 'classifier-response', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'verdict', name: YOLO_CLASSIFIER_TOOL_NAME, input: first ? { shouldBlock: true } : { thinking: 'Isolated approved coding fixture', shouldBlock: false, reason: 'Allowed fixture' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 12 } })
    }
    evidence.apiRequests.push({ system: JSON.stringify(body.system).slice(0, 256), messages: body.messages.map((message: any) => ({ role: message.role, content: JSON.stringify(message.content).slice(0, 1024) })) })
    const worker = body.messages.some((message: any) => message.role === 'user' && (typeof message.content === 'string'
      ? message.content.includes('Worker fixture:')
      : message.content.some((block: any) => block.type === 'text' && block.text.includes('Worker fixture:'))))
    const index = worker ? evidence.workerRequests.length : evidence.parentRequests++
    if (worker) evidence.workerRequests.push(JSON.parse(JSON.stringify(body)))
    if (index > (worker ? workerBackground ? 1 : 2 : 1)) throw new Error(`Unexpected ${worker ? 'worker' : 'parent'} request ${index}`)
    const code = `var agentResult = await tools.call({name:"Agent",input:{description:"Read and test isolated worker",prompt:"Worker fixture: read worker-source.txt with Read, then run the ordinary worker command, and report.",subagent_type:"general-purpose"}}); output("worker completed");`
    const workerCode = `await tools.call({name:"Bash",input:{command:"printf worker-start > worker-start.txt; /bin/sleep 30; printf forbidden > worker-forbidden.txt",work_lifetime:"finite",run_in_background:false}}); output("worker background finished");`
    const tool = worker ? workerBackground
      ? index === 0 ? { name: 'REPL', input: { code: workerCode, description: 'Owned worker background script', run_in_background: true } } : undefined
      : index === 0 ? { name: 'Read', input: { file_path: join(root, 'workspace', 'worker-source.txt') } } : index === 1 ? { name: 'Bash', input: { command: 'printf ordinary-worker > worker.txt', work_lifetime: 'finite', run_in_background: false } } : undefined
      : index === 0 ? { name: 'REPL', input: { code, description: 'Launch a real worker from a script' } } : undefined
    const id = `${worker ? 'worker' : 'parent'}-${index}`
    const stream = Object.assign((async function* () {
      if (workerBackground && worker && index === 1) await new Promise<void>(resolve => {
        const watcher = watch(process.cwd(), (_event, name) => { if (name === 'worker-start.txt') { watcher.close(); resolve() } })
        void readFile(join(process.cwd(), 'worker-start.txt')).then(() => { watcher.close(); resolve() }, () => {})
      })
      yield { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      yield { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id, name: tool.name, input: {} } : { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: 'Worker fixture finished.' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: id, response: new Response('', { status: 200 }) }) }
  } } } }),
}))
const { enableConfigs } = await import('../utils/config.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { createQueryEngineSessionController } = await import('./createQueryEngineSessionController.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
const { FileReadTool } = await import('../tools/FileReadTool/FileReadTool.js')
const { AgentTool } = await import('../tools/AgentTool/AgentTool.js')
const { GENERAL_PURPOSE_AGENT } = await import('../tools/AgentTool/built-in/generalPurposeAgent.js')
const { REPLTool } = await import('../tools/REPLTool/REPLTool.js')
enableConfigs()
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto', isAutoModeAvailable: true } }
const session = createQueryEngineAppSession({
  cwd: process.cwd(), tools: [REPLTool, BashTool, FileReadTool, AgentTool], commands: [], mcpClients: [], agents: [GENERAL_PURPOSE_AGENT],
  getAppState: () => state, setAppState: update => { state = update(state) },
  publishSubagentFrame: frame => {
    if ('code_mode' in frame && frame.code_mode && Object.values(state.tasks).some((task: any) => task.type === 'code_mode' && !task.settled)) evidence.workerActivityWasLive = true
  },
  readFileCache: createFileStateCacheWithSizeLimit(20), customSystemPrompt: 'Run the isolated parent script.', userSpecifiedModel: 'claude-sonnet-4-5',
  recordTranscript: async messages => { evidence.transcript = JSON.parse(JSON.stringify(messages)); return null },
})
const controller = createQueryEngineSessionController(session)
await controller.submit('Run the parent script.')
evidence.workerOutput = await readFile(join(root, 'workspace', 'worker.txt'), 'utf8').catch(() => '')
evidence.tasks = state.tasks
evidence.workerForbidden = await readFile(join(root, 'workspace', 'worker-forbidden.txt'), 'utf8').catch(() => null)
if (workerBackground) {
  const task = Object.values(state.tasks).find((task: any) => task.type === 'code_mode') as any
  const path = (await import('../utils/sessionStorage.js')).getAgentTranscriptPath(task.owner.agentId)
  const rows = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.uuid)
  const byId = new Map<string, any>(rows.map(row => [row.uuid, row] as [string, any]))
  let cursor = rows.at(-1)?.uuid
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const row = byId.get(cursor)
    if (!row) break
    evidence.workerAuditChain.push(row)
    cursor = row.parentUuid
  }
}
await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence))
session.dispose?.()
