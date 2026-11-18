import { mock } from 'bun:test'
import { writeFile, readFile, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { YOLO_CLASSIFIER_TOOL_NAME } from '../utils/permissions/classifierShared.js'
const root = process.env.CODE_MODE_TEST_ROOT!
const workerArchive = process.env.CODE_MODE_TEST_SCENARIO === 'worker-background-archive'
const workerAncestry = process.env.CODE_MODE_TEST_SCENARIO === 'worker-background-ancestry'
const workerBackground = process.env.CODE_MODE_TEST_SCENARIO?.startsWith('worker-background')
const workerEquivalentPolicy = process.env.CODE_MODE_TEST_SCENARIO === 'worker-equivalent-policy'
let workerSettled!: () => void
const workerSettlement = new Promise<void>(resolve => { workerSettled = resolve })
let archiveDelivered!: () => void
const archiveDelivery = new Promise<void>(resolve => { archiveDelivered = resolve })
let archivePath: string | undefined
let selectedDeliveries = 0
let onArchiveFailure: (() => void) | undefined
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
    if (index > (worker ? workerBackground && !workerAncestry ? 1 : 2 : 1)) throw new Error(`Unexpected ${worker ? 'worker' : 'parent'} request ${index}`)
    const code = `var agentResult = await tools.call({name:"Agent",input:{description:"Read and test isolated worker",prompt:"Worker fixture: read worker-source.txt with Read, then run the ordinary worker command, and report.",subagent_type:"general-purpose"}}); output("worker completed");`
    const workerCommand = workerArchive || workerAncestry ? 'printf x >> worker-effects.txt; /bin/sleep 0.1' : 'printf worker-start > worker-start.txt; /bin/sleep 30; printf forbidden > worker-forbidden.txt'
    const workerCode = `await tools.call({name:"Bash",input:{command:${JSON.stringify(workerCommand)},work_lifetime:"finite",run_in_background:false}}); output("worker background finished");`
    const tool = worker && workerEquivalentPolicy ? index < 2
      ? { name: 'REPL', input: { code: `output("worker-policy-cell-${index}");`, description: 'Test stable permission policy' } } : undefined
      : worker ? workerBackground
      ? index === 0 ? { name: 'REPL', input: { code: workerCode, description: 'Owned worker background script', run_in_background: true } } :
        workerAncestry && index === 1 ? { name: 'Read', input: { file_path: join(root, 'workspace', 'worker-source.txt') } } : undefined
      : index === 0 ? { name: 'Read', input: { file_path: join(root, 'workspace', 'worker-source.txt') } } : index === 1 ? { name: 'Bash', input: { command: 'printf ordinary-worker > worker.txt', work_lifetime: 'finite', run_in_background: false } } : undefined
      : index === 0 ? { name: 'REPL', input: { code, description: 'Launch a real worker from a script' } } : undefined
    const id = `${worker ? 'worker' : 'parent'}-${index}`
    const stream = Object.assign((async function* () {
      if ((workerArchive || workerAncestry) && worker && index === 1) await workerSettlement
      else if (workerBackground && worker && index === 1) {
        const started = join(process.cwd(), 'worker-start.txt')
        while (!await Bun.file(started).exists()) await Bun.sleep(20)
      }
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
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext,
  mode: workerEquivalentPolicy ? 'default' : 'auto', isAutoModeAvailable: true,
  ...(workerEquivalentPolicy ? { alwaysAllowRules: { session: ['Agent'] } } : {}),
} }
const workerDefinition = workerEquivalentPolicy ? { ...GENERAL_PURPOSE_AGENT, permissionMode: 'default' as const } : GENERAL_PURPOSE_AGENT
const session = createQueryEngineAppSession({
  cwd: process.cwd(), tools: [REPLTool, BashTool, FileReadTool, AgentTool], commands: [], mcpClients: [], agents: [workerDefinition],
  getAppState: () => state, setAppState: update => {
    state = update(state)
    if (Object.values(state.tasks).some((task: any) => task.type === 'code_mode' && task.settled)) workerSettled()
    if (Object.values(state.tasks).some((task: any) => task.type === 'code_mode' && task.delivery === 'failed')) onArchiveFailure?.()
    if (Object.values(state.tasks).some((task: any) => task.type === 'code_mode' && task.delivery === 'delivered')) archiveDelivered()
  },
  publishSubagentFrame: frame => {
    if (workerArchive && frame.type === 'user' && (frame.tool_use_result as any)?.kind === 'code-mode' &&
        (frame.tool_use_result as any)?.status === 'completed') {
      selectedDeliveries++
      if (!archivePath) {
        archivePath = (Object.values(state.tasks).find((task: any) => task.type === 'code_mode') as any).outputFile
        mkdirSync(archivePath!, { recursive: true })
      }
    }
    if ('code_mode' in frame && frame.code_mode && Object.values(state.tasks).some((task: any) => task.type === 'code_mode' && !task.settled)) evidence.workerActivityWasLive = true
  },
  readFileCache: createFileStateCacheWithSizeLimit(20), customSystemPrompt: 'Run the isolated parent script.', userSpecifiedModel: 'claude-sonnet-4-5',
  recordTranscript: async messages => { evidence.transcript = JSON.parse(JSON.stringify(messages)); return null },
})
const controller = createQueryEngineSessionController(session)
await controller.submit('Run the parent script.')
let failedWorkerArchive: unknown
if (workerArchive) {
  await new Promise<void>(resolve => {
    onArchiveFailure = resolve
    if (Object.values(state.tasks).some((task: any) => task.type === 'code_mode' && task.delivery === 'failed')) resolve()
  })
  await new Promise<void>(resolve => setImmediate(resolve))
  failedWorkerArchive = structuredClone(Object.values(state.tasks).find((task: any) => task.type === 'code_mode'))
  await rmdir(archivePath!)
  session.retryInterruptedToolReceipts()
  await archiveDelivery
  await new Promise<void>(resolve => setImmediate(resolve))
}
evidence.workerOutput = await readFile(join(root, 'workspace', 'worker.txt'), 'utf8').catch(() => '')
evidence.tasks = state.tasks
evidence.workerForbidden = await readFile(join(root, 'workspace', 'worker-forbidden.txt'), 'utf8').catch(() => null)
let workerDuplicateRows: number | undefined
let workerChainHitCycle: boolean | undefined
let recoveredLegacyWorkerLaunch: boolean | undefined
if (workerBackground) {
  const task = Object.values(state.tasks).find((task: any) => task.type === 'code_mode') as any
  const storage = await import('../utils/sessionStorage.js')
  const path = storage.getAgentTranscriptPath(task.owner.agentId)
  const archived = await readFile(path, 'utf8')
  const rows = archived.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.uuid)
  const byId = new Map<string, any>(rows.map(row => [row.uuid, row] as [string, any]))
  workerDuplicateRows = rows.length - byId.size
  let cursor = rows.at(-1)?.uuid
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const row = byId.get(cursor)
    if (!row) break
    evidence.workerAuditChain.push(row)
    cursor = row.parentUuid
  }
  workerChainHitCycle = Boolean(cursor && seen.has(cursor))
  if (workerAncestry && !workerChainHitCycle) {
    const tip = rows.at(-1)!.uuid
    const duplicate = rows.find(row => row.type === 'assistant' && row.codeMode)
    const legacy = join(root, 'legacy-worker.jsonl')
    await writeFile(legacy, archived + JSON.stringify({ ...duplicate, parentUuid: tip }) + '\n')
    const loaded = await storage.loadTranscriptFile(legacy, { keepAllLeaves: true, strict: true })
    const chain = storage.buildConversationChain(loaded.messages, loaded.messages.get(tip)!)
    recoveredLegacyWorkerLaunch = chain.some(row => row.type === 'assistant' &&
      row.message.content.some(block => block.type === 'tool_use' && block.id === 'worker-0'))
  }
}
await writeFile(join(root, 'evidence.json'), JSON.stringify({
  ...evidence, failedWorkerArchive, selectedDeliveries, workerDuplicateRows, workerChainHitCycle, recoveredLegacyWorkerLaunch,
  workerEffects: await readFile(join(root, 'workspace', 'worker-effects.txt'), 'utf8').catch(() => null),
}))
session.dispose?.()
