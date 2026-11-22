import { mock } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CodeModeTaskState } from '../tasks/CodeModeTask.js'

const root = process.env.CODE_MODE_TEST_ROOT!
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) throw new Error('Isolated fixture required')
const scenario = process.env.CODE_MODE_AUTO_SCENARIO!
;(globalThis as any).MACRO = { VERSION: 'code-mode-auto-test' }
globalThis.fetch = (() => { throw new Error('Unexpected network transport') }) as unknown as typeof fetch
const bash = (command: string) => `await tools.call({name:"Bash",input:${JSON.stringify({ command, work_lifetime: 'finite', run_in_background: false })}})`
const success = `${bash("bash -c 'printf one > first.txt'")}; ${bash("bash -c 'cat first.txt > second.txt; printf two >> second.txt'")}; ${bash("bash -c 'cat second.txt > third.txt; printf three >> third.txt'")}; await tools.call({name:"Write",input:{file_path:${JSON.stringify(join(root, 'workspace', 'written.txt'))},content:"actual-write"}}); var selected = await tools.call({name:"Read",input:{file_path:${JSON.stringify(join(root, 'workspace', 'third.txt'))}}}); output(selected);`
const refused = `try { ${bash("bash -c 'printf original > original.txt'")}; } catch(e) { output("caught"); } try { ${bash("bash -c 'printf later > later.txt'")}; } catch(e) { output("fenced"); }`
const budget = scenario.startsWith('budget')
const wrapper = scenario === 'wrapper' || scenario === 'budget-wrapper'
const queued = scenario === 'queued-policy' || scenario === 'queued-unchanged'
const disabled = scenario === 'background-disabled'
const computed = scenario === 'computed-child'
const sensitive = scenario.startsWith('sensitive-edit-')
const directEdit = scenario === 'sensitive-edit-direct'
const directHookAsk = scenario.startsWith('direct-hook-ask-')
const originalCommand = { command: 'printf fixture > original-write.txt', work_lifetime: 'finite', run_in_background: false }
const hookCommand = { ...originalCommand, command: 'printf fixture > hook-target.txt' }
const sensitiveEdit = { file_path: join(process.cwd(), '.cat-code', 'preview.html'), old_string: '<h1>Before</h1>', new_string: '<h1>After</h1>' }
if (sensitive) {
  await mkdir(join(process.cwd(), '.cat-code'))
  await writeFile(sensitiveEdit.file_path, sensitiveEdit.old_string)
}
const waitInLane = `${bash("bash -c 'while [ ! -f release-lane ]; do /bin/sleep 0.02; done'")}; output("first script finished");`
const computedCommand = `var leaf = "computed" + ".txt"; await tools.call({name:"Bash",input:{command:"bash -c 'printf fixture > " + leaf + "'",work_lifetime:"finite",run_in_background:false}});`
const disabledForeground = `await tools.call({name:"Bash",input:{command:"bash -c 'printf foreground > foreground.txt'",work_lifetime:"finite"}}); output("foreground completed");`
// Large enough to exercise pending-action formatting, still below the runtime
// schema maximum. ASCII avoids conflating source size with encoding expansion.
const large = `/*source-budget-start:${'a'.repeat(48_000)}:distinct-middle:${'b'.repeat(48_000)}:distinct-suffix*/ await tools.call({name:"Write",input:{file_path:${JSON.stringify(join(root, 'workspace', 'budget.txt'))},content:"complete-source-executed"}}); output("budget-selected-output");`
const code = queued ? waitInLane : disabled ? disabledForeground : computed ? computedCommand :
  sensitive ? `await tools.call({name:"Edit",input:${JSON.stringify(sensitiveEdit)}});` :
  budget ? large : scenario === 'admit' || scenario === 'wrapper' ? success : refused
const firstUse = directEdit
  ? { id: 'direct-edit', name: 'Edit', input: sensitiveEdit }
  : directHookAsk ? { id: 'direct-write', name: 'Bash', input: originalCommand }
    : { id: 'submitted-script', name: 'REPL', input: { code: wrapper ? 'output("unmodified-source")' : code, description: 'Isolated Auto script', ...(queued ? { run_in_background: true } : {}) } }
if (wrapper || scenario === 'deny' || scenario === 'ask' || directHookAsk) {
  const matcher = wrapper ? 'REPL' : 'Bash'
  const updatedInput = directHookAsk ? hookCommand : wrapper ? { code, description: 'Hook replacement' } : { command: "bash -c 'printf forbidden > forbidden.txt'", work_lifetime: 'finite', run_in_background: false }
  const output = JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', updatedInput,
    ...(directHookAsk && { permissionDecision: 'ask', permissionDecisionReason: 'Confirm the fixture write.' }),
  } })
  await writeFile(join(root, 'config', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: `printf '%s' '${output.replaceAll("'", "'\\''")}'` }] }] } }))
}
const classifierBodies: any[] = []
const modelBodies: any[] = []
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: any) => {
    if (!body.stream) {
      classifierBodies.push(JSON.parse(JSON.stringify(body)))
      const action = body.messages.at(-1)?.content.at(-1)?.text
      return Promise.resolve({ id: 'classifier', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'tool_use', id: 'verdict', name: body.tool_choice.name,
          input: { shouldBlock: classifierBodies.length % 2 === 1 || (computed && action?.includes('\nBash ')) || (scenario === 'sensitive-edit-block' && action?.startsWith('<pending_action>\nEdit ')), thinking: 'Offline fixture second-stage verdict', reason: 'Isolated workspace action' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } })
    }
    modelBodies.push(JSON.parse(JSON.stringify(body)))
    const index = modelBodies.length - 1
    if (index > 1) throw new Error('Unexpected model request')
    const invocation = index === 0
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message: { id: `response-${index}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      yield { type: 'content_block_start', index: 0, content_block: invocation ? { type: 'tool_use', id: firstUse.id, name: firstUse.name, input: {} } : { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: invocation ? { type: 'input_json_delta', partial_json: JSON.stringify(firstUse.input) } : { type: 'text_delta', text: 'Finished.' } }
      yield { type: 'content_block_stop', index: 0 }
      if (invocation && (queued || disabled)) {
        yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'second-script', name: 'REPL', input: {} } }
        yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ code: 'output("second script finished");', description: 'Second isolated script', run_in_background: true }) } }
        yield { type: 'content_block_stop', index: 1 }
      }
      yield { type: 'message_delta', delta: { stop_reason: invocation ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
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
const { BashTool } = await import('../tools/BashTool/BashTool.js')
const { FileEditTool } = await import('../tools/FileEditTool/FileEditTool.js')
const { FileReadTool } = await import('../tools/FileReadTool/FileReadTool.js')
const { FileWriteTool } = await import('../tools/FileWriteTool/FileWriteTool.js')
const { REPLTool } = await import('../tools/REPLTool/REPLTool.js')
const { collectPermissionDecisionContexts, positionPermissionDecisionContexts } = await import('../utils/permissions/permissionDecisionContext.js')
const { normalizeMessagesForAPI } = await import('../utils/messages.js')
const { cleanMessagesForLogging, recordTranscript } = await import('../utils/sessionStorage.js')
type Message = import('../types/message.js').Message
enableConfigs()
if (directHookAsk) {
  const { getSessionId, switchSession } = await import('../bootstrap/state.js')
  switchSession(getSessionId())
}
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: queued || disabled ? 'default' : 'auto',
  alwaysAllowRules: queued || disabled ? { session: ['Bash(bash:*)'] } : {},
  alwaysDenyRules: scenario === 'direct-hook-ask-denied' ? { session: [`Bash(${hookCommand.command})`] }
    : scenario === 'deny' ? { session: ['Bash(*forbidden*)'] } : {},
  alwaysAskRules: scenario === 'ask' ? { session: ["Bash(*forbidden*)"] } : {} } }
const scriptTasks = () => Object.values(state.tasks).filter((task): task is CodeModeTaskState =>
  task !== null && typeof task === 'object' && 'type' in task && task.type === 'code_mode')
let transcript: any[] = []
let retained: Message[] = []
let resolveDeliveries!: () => void
const delivered = new Promise<void>(resolve => { resolveDeliveries = resolve })
const tools = [REPLTool, BashTool, FileReadTool, FileWriteTool, ...(sensitive ? [FileEditTool] : [])]
const session = createQueryEngineAppSession({ cwd: process.cwd(), tools, commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => {
    state = update(state)
    if (queued && scriptTasks().filter(task => task.delivery === 'delivered').length === 2) resolveDeliveries()
  }, readFileCache: createFileStateCacheWithSizeLimit(20),
  customSystemPrompt: 'Run the isolated script.', userSpecifiedModel: 'claude-sonnet-4-5',
  recordTranscript: async messages => {
    retained = [...messages]
    transcript = JSON.parse(JSON.stringify(messages))
    return queued ? recordTranscript(messages) : null
  },
})
const controller = createQueryEngineSessionController(session)
const permissions: unknown[] = []
const reviews: unknown[] = []
controller.subscribe(event => {
  if (event.type === 'tool.review') reviews.push(event)
  if (event.type === 'permission.requested') {
    permissions.push(event.request)
    controller.respondToPermissionRequest(event.request.requestId, directHookAsk
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: 'Isolated explicit refusal', decisionClassification: 'user_reject' })
  }
})
await controller.submit(directHookAsk ? 'Write a fixture file.' : 'Run the script and report selected output.')
if (queued) {
  // Both launches have returned running receipts. The first cell still holds the
  // interpreter lane until we create the release marker.
  if (scriptTasks().filter(task => !task.settled).length !== 2) {
    throw new Error('Expected two in-flight script tasks before changing policy')
  }
  state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: scenario === 'queued-policy' ? 'auto' : 'default' } }
  await writeFile(join(root, 'workspace', 'release-lane'), 'release')
  await delivered
}
// Exercise authentication before and after the same logging/JSON boundary that
// retains hidden audit. Never synthesize permission-decision metadata.
const restored = JSON.parse(JSON.stringify(cleanMessagesForLogging(retained))) as Message[]
const authentication = [retained, restored].map(messages => ({
  records: collectPermissionDecisionContexts(messages),
  positioned: [...positionPermissionDecisionContexts(messages)].map(([owner, records]) => ({ ownerUuid: owner.uuid, index: messages.indexOf(owner), records })),
  // Normalization keeps host metadata on envelope objects. Provider serialization
  // sends their message bodies, not toolUseResult's structured UI/audit receipts.
  normalized: normalizeMessagesForAPI(messages, tools, 'firstParty').map(message => message.message),
  normalizedChildren: normalizeMessagesForAPI(messages.filter(message => (message.type === 'assistant' || message.type === 'user') && message.codeMode), [BashTool], 'firstParty'),
}))
await writeFile(join(root, 'evidence.json'), JSON.stringify({ transcript, classifierBodies, modelBodies, permissions, reviews, code, authentication,
  ...(disabled ? { scriptPrompt: await REPLTool.prompt() } : {}),
}))
session.dispose?.()
