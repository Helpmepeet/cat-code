import { randomUUID } from 'node:crypto'
import { mock } from 'bun:test'
import { appendFile, mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const root = process.env.CONTEXTUAL_AUTO_TEST_ROOT!
const scenario = process.env.CONTEXTUAL_AUTO_TEST_SCENARIO!
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) throw new Error('Isolated fixture required')
Object.assign(globalThis, { MACRO: { VERSION: 'contextual-auto-test' } })
globalThis.fetch = Object.assign(async () => { throw new Error('Unexpected network request') }, { preconnect: globalThis.fetch.preconnect })
const cwd = process.cwd()
const configuration = join(root, 'config')
const surface = scenario.includes('-sdk-') ? 'sdk' : scenario.includes('-terminal-') ? 'terminal' : 'desktop'
const effect = () => readFile(join(cwd, 'effects.txt'), 'utf8').catch(() => null)
const hookMarker = join(cwd, 'permission-hook-ran')
const reviewUnavailable = scenario.endsWith('-unavailable')
for (const name of ['a', 'b', 'c', 'hooked']) await writeFile(join(cwd, name + '.txt'), 'old')
const action = (name: string) => ({ name: 'Edit', input: { file_path: join(cwd, name + '.txt'), old_string: 'old', new_string: 'new' } })
const command = { name: 'Bash', input: { command: 'printf effect >> effects.txt', work_lifetime: 'finite', run_in_background: false } }
const child = (name: string) => JSON.stringify(action(name))
const call = (name: string) => `tools.call({ ...${child(name)}, nothrow: true })`
const routed = scenario.startsWith('delegated-') || scenario === 'hook-edit'
const candidate = scenario.includes('-bash-') ? command : action('a')
const code = scenario === 'skip-queued'
  ? `const results = await Promise.all([${call('a')}, ${call('b')}, ${call('c')}]); output(results.map(x => x.permission || "done"));`
  : scenario === 'skip-fresh'
    ? `await ${call('a')}; const denied = await ${call('b')}; if (denied.permission === "skipped") await ${call('c')}; output("continued");`
    : scenario.startsWith('timeout') ? 'for (;;) {}'
    : scenario.startsWith('measure-') ? ({
      'measure-read': 'await tools.call({name:"Read",input:{file_path:"a.txt"}});',
      'measure-edit': 'const name = "a" + ".txt"; await tools.call({name:"Edit",input:{file_path:name,old_string:"old",new_string:"new"}});',
      'measure-many': `for (const name of ["a","b","c"]) { await tools.call({name:"Read",input:{file_path:name+".txt"}}); await tools.call(${JSON.stringify(command)}); }`,
      'measure-background': 'output("background fixture");',
    } as Record<string, string>)[scenario]!
    : scenario === 'hook-edit' ? `const name = "a" + ".txt"; await tools.call({name:"Edit",input:{file_path:name,old_string:"old",new_string:"new"}});`
    : routed ? `const pending = ${JSON.stringify(candidate)}; await tools.call(pending); output("helper completed");`
    : `await tools.call(${JSON.stringify(command)}); output("after approval");`
const submitted = routed && scenario.endsWith('-direct') || scenario.startsWith('direct-')
  ? (scenario.startsWith('direct-') ? command : candidate)
  : { name: 'REPL', input: { code, description: 'Run isolated fixture', ...(scenario === 'measure-background' && { run_in_background: true }) } }
if (scenario === 'hook-edit' || scenario.startsWith('direct-')) {
  const rewrite = scenario === 'hook-edit' ? action('hooked').input : { ...command.input, timeout: 5_000 }
  const event = { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: rewrite } }
  const approve = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
  const hook = (output: unknown) => ({ type: 'command', command: `printf '%s' '${JSON.stringify(output).replaceAll("'", "'\\''")}'` })
  await mkdir(configuration, { recursive: true })
  await writeFile(join(configuration, 'settings.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: scenario === 'hook-edit' ? 'Edit' : 'Bash', hooks: [hook(event)] }],
    PermissionRequest: [{ matcher: 'Bash', hooks: [{ ...hook(approve), command: `touch permission-hook-ran && ${hook(approve).command}` }] }],
  } }))
}
const requests: { tool: string; content: any; startedAt: number; elapsedMs: number }[] = []
let modelCalls = 0
let invalidateParent: (() => Promise<void>) | undefined
let resolveBackground!: () => void
const backgroundFinished = new Promise<void>(resolve => { resolveBackground = resolve })
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create(body: any) {
    if (!body.stream) {
      const start = performance.now()
      const contextual = !body.tool_choice
      const content = contextual ? JSON.parse(body.messages.at(-1).content) : body.messages.at(-1)?.content.at(-1)?.text
      const tool = contextual ? content.action.tool : /<pending_action>\n(\S+)/.exec(content)?.[1] ?? 'unknown'
      const review = { tool, content, startedAt: start, elapsedMs: 0 }
      requests.push(review)
      const verdict = tool === 'REPL' ? 'allow'
        : scenario.includes('withdrawn') || scenario === 'hook-edit' ? 'deny'
        : scenario.startsWith('skip-') ? (String(content?.action?.input?.file_path).endsWith('/b.txt') ? 'ask' : 'allow')
        : scenario.startsWith('wait-') || scenario.startsWith('direct-') ? 'ask' : 'allow'
      return (async () => {
        await Bun.sleep(2)
        if (tool === 'Edit') await invalidateParent?.()
        review.elapsedMs = performance.now() - start
        if (reviewUnavailable) throw new Error('Synthetic provider outage')
        return { id: 'classifier', type: 'message', role: 'assistant', model: body.model,
          content: contextual
            ? [{ type: 'text', text: scenario === 'direct-invalid' ? 'unparseable result' : JSON.stringify({ decision: verdict, risk: 'medium', rationale: 'Isolated review decision.' }) }]
            : [{ type: 'tool_use', id: 'verdict', name: body.tool_choice.name, input: { shouldBlock: false, reason: 'Isolated baseline allowance.' } }],
          stop_reason: contextual ? 'end_turn' : 'tool_use', stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 10 } }
      })()
    }
    const index = modelCalls++
    const invocation = index === 0 || scenario === 'skip-queued' && index === 1
    const main = index === 0 ? submitted
      : { name: 'Read', input: { file_path: join(cwd, 'a.txt') } }
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message: { id: `response-${index}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      if (invocation) {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `action-${index}`, name: main.name, input: {} } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(main.input) } }
        yield { type: 'content_block_stop', index: 0 }
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
const { FileReadTool } = await import('../tools/FileReadTool/FileReadTool.js')
const { FileEditTool } = await import('../tools/FileEditTool/FileEditTool.js')
const { REPLTool } = await import('../tools/REPLTool/REPLTool.js')
const { CodeModeHost } = await import('../tools/REPLTool/codeModeHost.js')
const { createUserMessage } = await import('../utils/messages.js')
enableConfigs()
if (routed && scenario.endsWith('-direct')) {
  const { getSessionId, switchSession } = await import('../bootstrap/state.js')
  switchSession(getSessionId())
}
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto', isAutoModeAvailable: true,
  ...(scenario.startsWith('skip-') && { alwaysAskRules: { session: ['Edit'] } }),
} }
const assignment = candidate.name === 'Edit' ? 'Update a.txt from old to new.' : 'Append one effect marker to effects.txt.'
const initial = routed && !scenario.includes('peer-only') && !scenario.includes('-parent-') ? [
  createUserMessage({ content: assignment }),
  ...(scenario.includes('withdrawn') ? [createUserMessage({ content: 'Stop this job. Leave all files as they are.' })] : []),
  ...(scenario.includes('stopped') ? [createUserMessage({ content: 'Interrupted by user', origin: { kind: 'interruption' } })] : []),
] : []
let parentReference: { parentSessionId: string; userMessageId: string } | undefined
if (scenario.includes('-parent-')) {
  const storage = await import('../utils/sessionStorage.js')
  const parentSessionId = randomUUID()
  const path = storage.getTranscriptPathForSession(parentSessionId)
  const grant = createUserMessage({ content: assignment })
  parentReference = { parentSessionId, userMessageId: grant.uuid }
  await mkdir(dirname(path), { recursive: true })
  const entry = (message: ReturnType<typeof createUserMessage>, parentUuid: string | null) =>
    JSON.stringify({ ...message, parentUuid, sessionId: parentSessionId, cwd, isSidechain: false, userType: 'external' }) + '\n'
  await writeFile(path, entry(grant, null))
  if (scenario.includes('-stale-')) invalidateParent = async () => {
    await appendFile(path, entry(createUserMessage({ content: 'Stop this edit and leave the file in place.' }), grant.uuid))
  }
}
let transcript: readonly any[] = []
const runtimeLimits = scenario.startsWith('wait-') ? { foregroundMs: 900, backgroundMs: 900, runtimeMs: 900 }
  : scenario === 'timeout-host' ? { foregroundMs: 350, backgroundMs: 350, runtimeMs: 1500 }
  : scenario === 'timeout-runtime' ? { foregroundMs: 1500, backgroundMs: 1500, runtimeMs: 350 } : undefined
const config: Omit<import('../QueryEngine.js').QueryEngineConfig, 'canUseTool'> = {
  cwd, tools: [REPLTool, BashTool, FileReadTool, FileEditTool], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => {
    state = update(state)
    if (Object.values(state.tasks).some((task: any) => task.delivery === 'delivered')) resolveBackground()
  }, readFileCache: createFileStateCacheWithSizeLimit(20),
  userSpecifiedModel: 'claude-sonnet-5-5',
  recordTranscript: async messages => {
    transcript = structuredClone(messages)
    return (scenario.startsWith('measure-') || scenario.startsWith('wait-') || surface !== 'desktop') ? (await import('../utils/sessionStorage.js')).recordTranscript(messages) : null
  },
  ...(runtimeLimits && { codeModeHost: new CodeModeHost(runtimeLimits) }),
  initialMessages: initial,
}
const session = createQueryEngineAppSession(config)
const controller = createQueryEngineSessionController(session)
const prompts: unknown[] = []
const reviewEvents: unknown[] = []
const sdkResults: unknown[] = []
const replies: Promise<void>[] = []
let waitMs = 0
let observedBeforeReply: string | null | undefined
controller.subscribe(event => {
  if (event.type === 'tool.review') reviewEvents.push(event)
  if (event.type === 'message' && event.message.type === 'result') sdkResults.push(event.message)
  if (event.type !== 'permission.requested') return
  const { requestId, request } = event.request
  prompts.push(request)
  replies.push((async () => {
    const start = performance.now()
    if (scenario.startsWith('wait-')) await Bun.sleep(1200)
    if (scenario.startsWith('direct-')) await Bun.sleep(200)
    if (request.tool_name === 'Bash') observedBeforeReply = await effect()
    waitMs += performance.now() - start
    if (scenario === 'wait-stop') controller.abort()
    if (scenario === 'wait-correction') {
      const { enqueue } = await import('../utils/messageQueueManager.js')
      enqueue({ mode: 'prompt', value: 'Leave the file untouched. Only inspect it.' })
    }
    if (scenario === 'wait-approve' || scenario === 'wait-correction' || scenario === 'direct-allow' || scenario === 'direct-mutated' || scenario === 'direct-unavailable' || scenario === 'direct-invalid') {
      const response = { behavior: 'allow' as const, updatedInput: scenario === 'direct-mutated' ? { ...request.input, run_in_background: true } : request.input }
      controller.respondToPermissionRequest(requestId, response)
      controller.respondToPermissionRequest(requestId, response)
    } else if (scenario === 'wait-stop') {
      controller.respondToPermissionRequest(requestId, { behavior: 'allow', updatedInput: request.input })
    } else if (scenario.startsWith('skip-') && !String(request.input.file_path).endsWith('/b.txt')) {
      controller.respondToPermissionRequest(requestId, { behavior: 'allow', updatedInput: request.input })
    } else {
      controller.respondToPermissionRequest(requestId, { behavior: 'deny', message: '' })
    }
  })())
})
const start = performance.now()
let hookRanBeforeHuman = false
async function awaitHook() {
  const deadline = performance.now() + 3000
  while (performance.now() < deadline && !await Bun.file(hookMarker).exists()) await Bun.sleep(10)
  hookRanBeforeHuman = await Bun.file(hookMarker).exists()
  await Bun.sleep(50)
  observedBeforeReply = await effect()
}

if (surface === 'desktop') {
  await controller.submit(routed ? assignment : 'Run the isolated action and report the result.', routed ? {
    origin: { kind: 'peer', name: 'Lead', appSessionId: 'fixture-lead', creationPrompt: true, ...(parentReference && { assignment: parentReference }) },
  } : undefined)
} else {
  const { QueryEngine } = await import('../QueryEngine.js')
  let engine: InstanceType<typeof QueryEngine>
  let canUseTool: import('../hooks/useCanUseTool.js').CanUseToolFn
  let closeIo: (() => void) | undefined
  if (surface === 'terminal') {
    const { createPermissionContext } = await import('../hooks/toolPermission/PermissionContext.js')
    const { handleInteractivePermission } = await import('../hooks/toolPermission/handlers/interactiveHandler.js')
    const { hasPermissionsToUseTool } = await import('../utils/permissions/permissions.js')
    canUseTool = async (tool, input, context, assistant, id, forced) => {
      const result = forced ?? await hasPermissionsToUseTool(tool, input, context, assistant, id)
      if (result.behavior !== 'ask') return result
      return new Promise(resolve => {
        const ctx = createPermissionContext(tool, input, context, assistant, id, permission => {
          state = { ...state, toolPermissionContext: permission }
        }, {
          push(item) {
            prompts.push({ human_only: item.permissionResult.behavior === 'ask' && item.permissionResult.humanOnly, input: item.input, tool_name: item.tool.name })
            replies.push((async () => {
              await awaitHook()
              if (scenario.endsWith('-stop')) engine.interrupt()
              if (scenario.endsWith('-deny')) item.onReject()
              else {
                await item.onAllow(item.input, [])
                await item.onAllow(item.input, [])
              }
            })())
          },
          remove() {},
          update() {},
        })
        handleInteractivePermission({ ctx, description: 'Review the isolated shell action', result,
          awaitAutomatedChecksBeforeDialog: false }, resolve)
      })
    }
  } else {
    const { StructuredIO } = await import('../cli/structuredIO.js')
    const { Stream } = await import('../utils/stream.js')
    const incoming = new Stream<string>()
    const io = new StructuredIO(incoming)
    if (!scenario.endsWith('-nohost')) io.enableHumanOnlyPermissionPrompts()
    canUseTool = io.createCanUseTool()
    const read = (async () => { for await (const _ of io.structuredInput) { /* control replies settle inside StructuredIO */ } })()
    const write = (async () => {
      for await (const frame of io.outbound) {
        if (frame.type !== 'control_request' || frame.request.subtype !== 'can_use_tool') continue
        prompts.push(frame.request)
        await awaitHook()
        if (scenario.endsWith('-stop')) {
          engine.interrupt()
          await Bun.sleep(10)
        }
        const deny = scenario.endsWith('-deny')
        const reply = JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
          response: deny ? { behavior: 'deny', message: '', decisionClassification: 'user_reject' } : {
            behavior: 'allow', updatedInput: frame.request.input,
            ...(scenario.endsWith('-automated') ? {} : { decisionClassification: 'user_temporary' }),
          } } }) + '\n'
        incoming.enqueue(reply)
        incoming.enqueue(reply)
      }
    })()
    closeIo = () => { incoming.done(); io.outbound.done() }
    replies.push(read, write)
  }
  engine = new QueryEngine({ ...config, canUseTool })
  for await (const _ of engine.submitMessage('Run the isolated action and report the result.')) { /* retain normal transcript */ }
  closeIo?.()
  engine.dispose()
}
if (scenario === 'measure-background') await backgroundFinished
const scriptWallMs = performance.now() - start
await Promise.all(replies)
let executions: unknown[] = []
if (scenario.startsWith('measure-')) {
  const storage = await import('../utils/sessionStorage.js')
  await storage.flushSessionStorage()
  const data = await readFile(storage.getTranscriptPath(), 'utf8')
  executions = data.trim().split('\n').map(row => JSON.parse(row))
    .filter(row => row.subtype === 'tool_execution_end')
    .map(row => ({ id: row.tool_use_id, durationMs: row.duration_ms }))
}
await writeFile(join(root, 'evidence.json'), JSON.stringify({
  scenarios: scenario, requests, prompts, reviewEvents, transcript, waitMs, observedBeforeReply, hookRanBeforeHuman, sdkResults,
  wallMs: scriptWallMs, executions, effect: await effect(), files:
    Object.fromEntries(await Promise.all(['a', 'b', 'c', 'hooked'].map(async name => [name, await readFile(join(cwd, name + '.txt'), 'utf8')]))),
}))
controller.dispose()
