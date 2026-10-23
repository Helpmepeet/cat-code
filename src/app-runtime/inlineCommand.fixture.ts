import { mock } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { QueryEngineAppSessionConfig } from './createQueryEngineAppSession.js'
import { YOLO_CLASSIFIER_TOOL_NAME } from '../utils/permissions/classifierShared.js'

const root = process.env.INLINE_TEST_ROOT!
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) throw new Error('Isolated environment required')
const input = JSON.parse(process.env.INLINE_TEST_INPUT!) as { command: string; explain?: boolean; nextTurn?: boolean; autoOrigin?: boolean; classifierDeny?: boolean; secondCommand?: string; artifact?: boolean; queued?: boolean; disk?: boolean; multiBlock?: boolean; provider?: string; deny?: boolean; edit?: boolean; stop?: boolean; agentStop?: boolean; failPersistence?: boolean; sandbox?: boolean; hookEdit?: boolean; hookStop?: 'PreToolUse' | 'PostToolUse'; hookContext?: boolean }
const model = input.provider === 'codex' ? 'gpt-5.6-terra' : 'claude-sonnet-4-5'
const evidence = { requests: [] as unknown[], classifierRequests: [] as any[], codexRequests: [] as unknown[], frames: [] as any[], transcript: [] as any[], runs: [] as any[], restored: [] as any[], permissions: 0, error: undefined as string | undefined, cwd: process.cwd(), counter: '', childAlive: false }
if (input.sandbox || input.hookEdit || input.hookStop || input.hookContext) {
  const hooks: Record<string, unknown[]> = {}
  const hook = (event: string, output: unknown) => {
    hooks[event] = [{ matcher: 'Bash', hooks: [{ type: 'command', command: `printf '%s' '${JSON.stringify(output)}'` }] }]
  }
  if (input.hookEdit) hook('PreToolUse', { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'printf substituted >> counter', work_lifetime: 'finite', run_in_background: false } } })
  if (input.hookStop) hook(input.hookStop, { continue: false, stopReason: 'Fixture hook stopped automatic response' })
  if (input.hookContext) {
    for (const event of ['PreToolUse', 'PostToolUse']) hook(event, { hookSpecificOutput: { hookEventName: event, additionalContext: `${event} isolated additional context` } })
  }
  const settings = {
    sandbox: input.sandbox ? { enabled: true, filesystem: { denyWrite: [join(root, 'forbidden')], denyRead: [join(root, 'secret')] } } : undefined,
    hooks,
  }
  await writeFile(join(root, 'config', 'settings.json'), JSON.stringify(settings))
  await writeFile(join(root, 'secret'), 'private-sandbox-fixture')
}
globalThis.fetch = (() => { throw new Error('Network forbidden in inline fixture') }) as unknown as typeof fetch
;(globalThis as any).MACRO = { VERSION: 'inline-test' }
let convert: ((body: Record<string, unknown>) => { codexBody: unknown }) | undefined
let ordinaryTurn = false
let ordinaryToolSent = false
let requestStarted!: () => void
const firstRequest = new Promise<void>(resolve => { requestStarted = resolve })
let releaseGeneration!: () => void
const generationBoundary = new Promise<void>(resolve => { releaseGeneration = resolve })
const overlap = Boolean((input as typeof input & { overlap?: boolean }).overlap)
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: Record<string, unknown>) => {
    const choice = body.tool_choice as { name?: string } | undefined
    if (choice?.name === YOLO_CLASSIFIER_TOOL_NAME) {
      evidence.classifierRequests.push(JSON.parse(JSON.stringify(body)))
      const stage1 = evidence.classifierRequests.length % 2 === 1
      return Promise.resolve({
        id: 'classifier-response', type: 'message', role: 'assistant', model,
        content: [{ type: 'tool_use', id: 'classifier-verdict', name: choice.name,
          input: stage1 ? { shouldBlock: true } : { thinking: 'Isolated classifier verdict',
            shouldBlock: Boolean(input.classifierDeny), reason: 'Fixture decision' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 12 },
      })
    }
    const producingSource = input.multiBlock && evidence.requests.length === 0
    if (evidence.requests.length >= (input.autoOrigin ? 3 : overlap || input.multiBlock || input.secondCommand || input.queued ? 2 : 1)) throw new Error('Duplicate model request')
    evidence.requests.push(JSON.parse(JSON.stringify(body)))
    requestStarted()
    if (convert) evidence.codexRequests.push(convert(body).codexBody)
    const ordinaryTool = input.autoOrigin && ordinaryTurn && !ordinaryToolSent
    if (ordinaryTool) ordinaryToolSent = true
    const events = [
      { type: 'message_start', message: { id: producingSource ? 'source-response' : 'inline-response', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: ordinaryTool
        ? { type: 'tool_use', id: 'ordinary-tool', name: 'Bash', input: {} }
        : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: ordinaryTool
        ? { type: 'input_json_delta', partial_json: JSON.stringify({ command: "bash -c 'printf ordinary >> counter'", work_lifetime: 'finite', run_in_background: false }) }
        : { type: 'text_delta', text: producingSource ? '```bash\n' + input.command + '\n```' : input.queued ? 'Queued human response.' : 'Here is the command result explanation.' } },
      { type: 'content_block_stop', index: 0 },
      ...(producingSource ? [
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Run this command when ready.' } },
        { type: 'content_block_stop', index: 1 },
      ] : []),
      { type: 'message_delta', delta: { stop_reason: ordinaryTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ]
    const stream = Object.assign((async function* () {
      if (overlap && evidence.requests.length === 1) await generationBoundary
      yield* events
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: 'inline-request', response: new Response('', { status: 200 }) }) }
  } } } }),
}))
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { createQueryEngineSessionController } = await import('./createQueryEngineSessionController.js')
const { createAssistantMessage } = await import('../utils/messages.js')
const { resolveInlineCommandSource } = await import('./inlineCommand.js')
const { getSessionId } = await import('../bootstrap/state.js')
const { enableConfigs } = await import('../utils/config.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
const storage = await import('../utils/sessionStorage.js')
if (input.provider === 'codex') convert = (await import('../services/api/codex-fetch-adapter.js')).translateToCodexBody
enableConfigs()
if (input.sandbox) {
  const { SandboxManager } = await import('../utils/sandbox/sandbox-adapter.js')
  if (!SandboxManager.isSandboxingEnabled()) throw new Error('Fixture sandbox did not enable')
  await SandboxManager.initialize()
}
let state = getDefaultAppState()
if (input.autoOrigin) state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto' } }
let retainedMessages: readonly unknown[] = []
const initial = createAssistantMessage({ content: '```bash\n' + input.command + '\n```' +
  (input.secondCommand ? '\n```sh\n' + input.secondCommand + '\n```' : '') })
initial.message.stop_reason = 'end_turn'
const configuration: QueryEngineAppSessionConfig = {
  initialMessages: input.multiBlock ? [] : [initial], cwd: process.cwd(), tools: [BashTool], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20), customSystemPrompt: 'Explain command results.',
  userSpecifiedModel: model,
  canUseTool: input.autoOrigin ? undefined : async (_tool, toolInput) => {
    evidence.permissions++
    if (input.deny) return { behavior: 'deny', message: 'Fixture denied', decisionReason: { type: 'other', reason: 'Fixture' } }
    return { behavior: 'allow', updatedInput: input.edit ? { ...toolInput, command: 'printf substituted > forbidden' } : toolInput }
  },
  recordTranscript: async messages => {
    if (input.failPersistence) throw new Error('Fixture persistence failure')
    retainedMessages = [...messages]
    evidence.transcript = JSON.parse(JSON.stringify(messages))
    if (input.disk) return storage.recordTranscript(messages)
    return null
  },
}
const session = createQueryEngineAppSession(configuration)
const controller = createQueryEngineSessionController(session)
controller.subscribe(event => { if (event.type === 'message') evidence.frames.push(event.message) })
try {
  let sourceMessage = initial
  if (input.multiBlock) {
    await controller.submit('Suggest a shell command without executing it.')
    const snapshot = JSON.parse(JSON.stringify(retainedMessages))
    sourceMessage = snapshot.find((message: any) => message.type === 'assistant' && message.message.id === 'source-response')
    const source = { engineSessionId: getSessionId(), messageUuid: sourceMessage.uuid, contentBlockIndex: 0, fenceOrdinal: 0 }
    // Fresh session assembly uses deserialized retained provider chunks.
    createQueryEngineAppSession({ ...configuration, initialMessages: snapshot })
    ;(evidence as any).sourceSnapshot = snapshot
    ;(evidence as any).restoredSourceCommand = resolveInlineCommandSource(snapshot, getSessionId(), source)
  }
  const source = { engineSessionId: getSessionId(), messageUuid: sourceMessage.uuid, contentBlockIndex: 0, fenceOrdinal: 0 }
  if (input.queued) {
    const { SidecarServer } = await import('../../app/sidecar/sidecarServer.js')
    const { FrameDecoder, encodeFrame } = await import('../../app/shared/framing.js')
    const { PROTOCOL_VERSION } = await import('../../app/shared/protocol.js')
    const { MAX_OUTBOUND_FRAME_BYTES } = await import('../../app/shared/limits.js')
    const { getCommandQueueSnapshot } = await import('../utils/messageQueueManager.js')
    const received: any[] = []
    const decoder = new FrameDecoder(MAX_OUTBOUND_FRAME_BYTES)
    const server = new SidecarServer({ sessionId: 'inline-fixture', engineSessionId: getSessionId(), controller, resumed: true, log: () => {} })
    const connection = server.addConnection({
      write(data) {
        for (const decoded of decoder.push(Buffer.from(data))) {
          if (decoded.kind === 'frame') received.push(decoded.payload)
        }
      }, end() {},
    })
    const send = (message: unknown) => server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId: 'inline-fixture', message }))
    const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 10_000
      while (!await predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for isolated sidecar: ' + JSON.stringify(received))
        await Bun.sleep(10)
      }
    }
    try {
      const snapshot = received.find(frame => frame.kind === 'inline-command.snapshot')
      if (!snapshot) throw new Error('Missing inline attach snapshot')
      send({ type: 'inline-command.start', requestId: 'deliberate-run', generation: snapshot.generation, source })
      await waitFor(async () => {
        try { return await readFile('counter', 'utf8') === 'executed' && controller.isInlineCommandActive() }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
      })
      send({ type: 'app.submit', requestId: 'queued-human', prompt: 'QUEUED-HUMAN-PROMPT' })
      ;(evidence as any).queueDuringOperation = JSON.parse(JSON.stringify(getCommandQueueSnapshot()))
      ;(evidence as any).requestsWhenQueued = evidence.requests.length
      await waitFor(() => evidence.requests.length === 1 && !controller.isTurnActive() && !controller.isInlineCommandActive() && getCommandQueueSnapshot().length === 0)
      ;(evidence as any).serverFrames = received
      ;(evidence as any).queueAfterOperation = getCommandQueueSnapshot()
    } finally { server.close() }
  } else {
    const generating = overlap ? controller.submit('Continue generating while I run an older block.') : undefined
    if (overlap) await firstRequest
    let commandFinished!: () => void
    const finished = new Promise<void>(resolve => { commandFinished = resolve })
    const executing = controller.submitInlineCommand(source, run => {
      evidence.runs.push(run)
      if (run.status !== 'running') commandFinished()
      if (run.status === 'running' && run.output.includes('BEFORE-STOP')) {
        if (input.agentStop) controller.abort('Agent stopped')
        else if (input.stop) controller.stopInlineCommand(run.runId)
      }
    })
    if (overlap) {
      await finished
      ;(evidence as any).bufferedWhileGenerating = controller.isTurnActive() && controller.isInlineCommandActive()
      ;(evidence as any).resultsBeforeBoundary = evidence.frames.filter(frame =>
        frame.type === 'user' && typeof frame.message.content === 'string' &&
        frame.message.content.startsWith('<cat-code-inline-command-result>')).length
      ;(evidence as any).persistedBeforeBoundary = JSON.stringify(retainedMessages).includes('<cat-code-inline-command-result>')
      let secondExecution: Promise<void> | undefined
      if (input.secondCommand) {
        let secondFinished!: () => void
        const completion = new Promise<void>(resolve => { secondFinished = resolve })
        secondExecution = controller.submitInlineCommand({ ...source, fenceOrdinal: 1 }, run => {
          evidence.runs.push(run)
          if (run.status !== 'running') secondFinished()
        })
        await completion
        ;(evidence as any).secondBufferedWhileGenerating = controller.isTurnActive() && controller.isInlineCommandActive()
      }
      releaseGeneration()
      await generating
      await secondExecution
    }
    await executing
    if (input.secondCommand && !overlap) await controller.submitInlineCommand({ ...source, fenceOrdinal: 1 }, run => evidence.runs.push(run))
    ;(evidence as any).requestsAfterRun = evidence.requests.length
    if (input.explain) {
      const selected = session.getInlineCommandRuns!().at(-1)!
      await controller.submit(`Explain the output of inline command run ${selected.runId}.`)
    } else if (input.nextTurn) await controller.submit('What happened in the previous command?')
    if (input.autoOrigin && !input.classifierDeny) {
      ordinaryTurn = true
      await controller.submit('Run the next ordinary assistant command.')
    }
  }
} catch (error) { evidence.error = String(error) }
let restoreMessages = evidence.transcript
if (input.disk) {
  await storage.flushSessionStorage()
  const loaded = await storage.loadTranscriptFromFile(storage.getTranscriptPath())
  restoreMessages = loaded.messages
  ;(evidence as any).diskMessages = restoreMessages
  ;(evidence as any).diskSourceCommand = resolveInlineCommandSource(restoreMessages, getSessionId(), {
    engineSessionId: getSessionId(), messageUuid: initial.uuid, contentBlockIndex: 0, fenceOrdinal: 0,
  })
}
const restored = createQueryEngineAppSession({ ...configuration, initialMessages: restoreMessages })
evidence.restored = restored.getInlineCommandRuns?.() ?? []
if (input.disk) {
  const restoredController = createQueryEngineSessionController(restored)
  const before = { requests: evidence.requests.length, counter: await readFile('counter', 'utf8') }
  await Bun.sleep(50)
  ;(evidence as any).restoreIdle = {
    active: restoredController.isTurnActive(),
    requestsBefore: before.requests, requestsAfter: evidence.requests.length,
    counterBefore: before.counter, counterAfter: await readFile('counter', 'utf8'),
  }
}
if (input.artifact) {
  const path = evidence.restored[0]?.fullOutputPath
  if (path) {
    const content = await readFile(path, 'utf8')
    ;(evidence as any).artifact = { path, content, isolated: path.startsWith(root + '/') }
  }
}
evidence.cwd = (await import('../utils/cwd.js')).getCwd()
try { evidence.counter = await readFile('counter', 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
try {
  const pid = Number(await readFile('child-pid', 'utf8'))
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned fixture child PID')
  try {
    process.kill(pid, 0)
    evidence.childAlive = true
    process.kill(pid, 'SIGKILL')
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence))
process.exit(0)
