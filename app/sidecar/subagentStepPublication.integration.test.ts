/**
 * Subagent step publication end to end: the real AgentTool and ResumeAgentTool
 * through a QueryEngine-built context, the desktop runtime session, the sidecar
 * and its framed wire, real sidechain persistence, and restore. Only the model
 * call, input processing and system-prompt assembly are scripted.
 *
 * Unit tests cover each seam; this is the one place that sees the opt-ins in
 * AgentTool and resumeAgent, the QueryEngine context threading, and the
 * foreground progress gate together. Dropping any of them leaves the unit
 * suites green and fails this file.
 */
import { afterAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'desktop-subagent-steps-'))
const previousEnv = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  TEST_ENABLE_SESSION_PERSISTENCE: process.env.TEST_ENABLE_SESSION_PERSISTENCE,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
}
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
// Satisfies the client's startup check; the closed port keeps any request local.
process.env.ANTHROPIC_API_KEY = 'fixture-not-a-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'

type ScriptedModel = (messages: unknown[]) => AsyncGenerator<unknown>
let scriptedModel: ScriptedModel | null = null
const realDeps = await import('../../src/query/deps.js')
// mock.module rewrites this namespace in place and mock.restore() does not undo
// it, so later files in the process call the mock. Reading productionDeps
// through the namespace there would tail-call itself forever.
const realProductionDeps = realDeps.productionDeps
const scriptedDeps = () => ({
  uuid: () => randomUUID(),
  microcompact: async (messages: unknown) => ({ messages }),
  autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
  callModel: ({ messages }: { messages: unknown[] }) => scriptedModel!(messages),
})
mock.module('../../src/query/deps.js', () => ({
  ...realDeps,
  productionDeps: () => scriptedModel ? scriptedDeps() : realProductionDeps(),
}))
const realQueryModule = await import('../../src/query.js')
const realQuery = realQueryModule.query
mock.module('../../src/query.js', () => ({
  ...realQueryModule,
  query: (args: Parameters<typeof realQuery>[0]) =>
    realQuery(scriptedModel ? { ...args, deps: scriptedDeps() } as never : args),
}))
const realUserInput = await import('../../src/utils/processUserInput/processUserInput.js')
mock.module('../../src/utils/processUserInput/processUserInput.js', () => ({
  ...realUserInput,
  processUserInput: async ({ input, uuid }: { input: string; uuid?: string }) => ({
    messages: [createUserMessage({ content: input, ...(uuid ? { uuid } : {}) } as never)],
    shouldQuery: true,
    allowedTools: [],
  }),
}))
const realQueryContext = await import('../../src/utils/queryContext.js')
mock.module('../../src/utils/queryContext.js', () => ({
  ...realQueryContext,
  fetchSystemPromptParts: async () => ({ defaultSystemPrompt: [], userContext: {}, systemContext: {} }),
}))

const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.js')
const { QueryEngine } = await import('../../src/QueryEngine.js')
const { createRuntimeBackedAppSession } = await import('../../src/app-runtime/createRuntimeBackedAppSession.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.js')
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.js')
const { ResumeAgentTool } = await import('../../src/tools/ResumeAgentTool/ResumeAgentTool.js')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.js')
const { GENERAL_PURPOSE_AGENT } = await import('../../src/tools/AgentTool/built-in/generalPurposeAgent.js')
const { resetStateForTests, switchSession, getSessionId } = await import('../../src/bootstrap/state.js')
const { asSessionId } = await import('../../src/types/ids.js')
const storage = await import('../../src/utils/sessionStorage.js')
const { FrameDecoder, encodeFrame } = await import('../shared/framing.js')
const { MAX_OUTBOUND_FRAME_BYTES } = await import('../shared/limits.js')
const { PROTOCOL_VERSION } = await import('../shared/protocol.js')
const { SidecarServer } = await import('./sidecarServer.js')
const { projectBranchFrames, withRestoredSubagentHistory } = await import('./subagentHistory.js')

afterAll(() => {
  scriptedModel = null
  mock.restore()
  storage.resetProjectForTesting()
  resetStateForTests()
  rmSync(root, { recursive: true, force: true })
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

type Frame = { kind: string; event?: { type: string; message?: Record<string, unknown> & { parent_tool_use_id?: string | null } } }
type WireMessage = Record<string, unknown> & { type: string; uuid?: string; parent_tool_use_id?: string | null; message?: { content?: unknown } }

async function waitFor(check: () => boolean, label: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out: ${label}`)
}

const textOf = (value: unknown) => JSON.stringify(value)
const readTarget = join(process.cwd(), 'package.json')
const blocksOf = (frames: WireMessage[]) => frames.flatMap(frame =>
  Array.isArray(frame.message?.content) ? (frame.message.content as Array<{ type: string }>).map(block => block.type) : [])

function assistant(content: unknown, stop: 'tool_use' | 'end_turn') {
  const message = createAssistantMessage({ content: 'x' })
  message.message.content = content as never
  message.message.stop_reason = stop
  return message
}

function startSession(options: { stallMs?: number; lifecycle?: unknown[]; continued?: { count: number } } = {}) {
  storage.resetProjectForTesting()
  switchSession(asSessionId(randomUUID()), join(root, 'sessions'))
  storage.clearSessionMessagesCache()
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'fixture-version' }
  let state = getDefaultAppState()
  const controller = createRuntimeBackedAppSession({
    queryEngineConfig: {
      cwd: process.cwd(), tools: [AgentTool, ResumeAgentTool, FileReadTool], commands: [], mcpClients: [],
      agents: [GENERAL_PURPOSE_AGENT],
      canUseTool: async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
      getAppState: () => state,
      setAppState: (update: (previous: typeof state) => typeof state) => { state = update(state) },
      initialMessages: [], readFileCache: createFileStateCacheWithSizeLimit(20),
      customSystemPrompt: '', userSpecifiedModel: 'gpt-5.6-terra',
      createEngine: (config: ConstructorParameters<typeof QueryEngine>[0]) => new QueryEngine(config),
    } as never,
  })
  const received: Frame[] = []
  const decoder = new FrameDecoder(MAX_OUTBOUND_FRAME_BYTES)
  const server = new SidecarServer({
    sessionId: 'fixture-session', engineSessionId: 'fixture-engine', controller, log: () => {},
    ...(options.stallMs ? { turnStallMs: options.stallMs } : {}),
    ...(options.lifecycle ? { onTurnLifecycle: (event: unknown) => options.lifecycle!.push(event) } : {}),
    ...(options.continued ? { workspaceObserver: {
      getSnapshot: () => ({ cwd: process.cwd(), lastWorkingBranch: null }),
      conversationContinued: async () => { options.continued!.count++ },
    } } : {}),
  } as never)
  const connection = server.addConnection({ write(data: Uint8Array | string) {
    for (const frame of decoder.push(Buffer.from(data))) if (frame.kind === 'frame') received.push(frame.payload as Frame)
  }, end() {} })
  const submit = (requestId: string, prompt: string) => server.handleData(connection, encodeFrame({
    protocolVersion: PROTOCOL_VERSION, sessionId: 'fixture-session', message: { type: 'app.submit', requestId, prompt },
  } as never))
  const messages = () => received.filter(frame => frame.kind === 'event' && frame.event?.type === 'message')
    .map(frame => frame.event!.message as WireMessage)
  const nested = (toolUseId: string) => messages().filter(message => message.parent_tool_use_id === toolUseId)
  const tasks = () => state.tasks as Record<string, { status?: string }>
  return { controller, server, received, submit, messages, nested, tasks }
}

test('background, resumed and foreground runs publish every step live, identically to restore, each under its own card', async () => {
  const workerGate = Promise.withResolvers<void>()
  let mode: 'bg' | 'fg' = 'bg'
  let resumeTarget = ''
  scriptedModel = async function* (messages) {
    const all = textOf(messages)
    const last = textOf(messages.slice(-1))
    if (textOf(messages.slice(0, 1)).includes('WORKER-TASK')) {
      if (mode === 'bg' && !all.includes('RESUME-')) await workerGate.promise
      if (last.includes('tool_result')) {
        yield assistant([{ type: 'text', text: `worker done ${mode}` }], 'end_turn')
        return
      }
      const resume = all.includes('RESUME-2') ? 'r2' : all.includes('RESUME-1') ? 'r1' : null
      if (resume) {
        yield assistant([{ type: 'text', text: `resumed answer ${resume}` }], 'end_turn')
        return
      }
      yield assistant([
        { type: 'thinking', thinking: `thinking-${mode}`, signature: 'sig' },
        { type: 'text', text: `prose-${mode}` },
        { type: 'tool_use', id: `tu-read-${mode}`, name: 'Read', input: { file_path: readTarget } },
      ], 'tool_use')
      return
    }
    if (last.includes('LAUNCH-BG') || last.includes('LAUNCH-FG')) {
      const background = last.includes('LAUNCH-BG')
      yield assistant([{ type: 'tool_use', id: background ? 'tu-agent-bg' : 'tu-agent-fg', name: 'Agent', input: {
        description: background ? 'bg work' : 'fg work', prompt: 'WORKER-TASK do it', subagent_type: 'general-purpose',
        ...(background ? { run_in_background: true } : {}),
      } }], 'tool_use')
      return
    }
    const resume = last.match(/DO-RESUME-(\d)/)
    if (resume && !last.includes('tool_result')) {
      yield assistant([{ type: 'tool_use', id: `tu-resume-${resume[1]}`, name: 'ResumeAgent',
        input: { agentId: resumeTarget, prompt: `RESUME-${resume[1]} continue` } }], 'tool_use')
      return
    }
    yield assistant([{ type: 'text', text: 'parent ok' }], 'end_turn')
  }
  const session = startSession()
  const { controller, submit, messages, nested, tasks } = session
  const idle = () => !controller.isTurnActive()
  try {
    // A background launch: its whole run publishes after the launching turn ended.
    submit('launch-bg', 'LAUNCH-BG')
    await waitFor(() => messages().some(message => message.type === 'result'), 'background launch result')
    await waitFor(idle, 'background launch idle')
    // Only the prompt can precede the launch turn's end; the worker's model
    // output is held until after it.
    expect(nested('tu-agent-bg').map(frame => frame.type)).not.toContain('assistant')
    const idleAt = session.received.length
    workerGate.resolve()
    await waitFor(() => textOf(nested('tu-agent-bg')).includes('worker done bg'), 'background worker steps')
    const background = nested('tu-agent-bg')
    expect(blocksOf(background)).toEqual(expect.arrayContaining(['thinking', 'text', 'tool_use', 'tool_result']))
    const afterIdle = session.received.slice(idleAt).filter(frame => frame.event?.message?.parent_tool_use_id === 'tu-agent-bg')
    expect(blocksOf(afterIdle.map(frame => frame.event!.message as WireMessage))).toContain('thinking')
    const ack = messages().find(message => message.type === 'user' && textOf(message.message?.content).includes('tu-agent-bg'))
    const agentId = (ack?.tool_use_result as { agentId?: string } | undefined)?.agentId
    expect(agentId).toBeDefined()
    resumeTarget = agentId!
    await waitFor(() => tasks()[agentId!]?.status !== 'running', 'background run settled')
    await waitFor(idle, 'idle after notification')
    await storage.flushSessionStorage()

    // Live frames are the frames a restore reads back.
    const saved = await storage.getDisplayAgentTranscriptForSession(getSessionId(), agentId as never, { maxBytes: 10_000_000, maxMessages: 10_000 })
    const withoutSession = ({ session_id: _session, ...rest }: Record<string, unknown>) => rest
    const restored = projectBranchFrames(saved!.messages, 'tu-agent-bg', background[0]?.agent_name as string | undefined)
    expect(restored.map(frame => withoutSession(frame as never))).toEqual(background.map(frame => withoutSession(frame)))

    // Two resumes publish under their own ResumeAgent cards.
    for (const n of ['1', '2']) {
      submit(`resume-${n}`, `DO-RESUME-${n}`)
      await waitFor(() => textOf(nested(`tu-resume-${n}`)).includes(`resumed answer r${n}`), `resume ${n} steps`)
      await waitFor(() => tasks()[agentId!]?.status !== 'running', `resume ${n} settled`)
      await waitFor(idle, `idle after resume ${n}`)
      await storage.flushSessionStorage()
    }

    // A restore puts every run back under the card that ran it. The run record
    // is written after a read, off the run's critical path.
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await storage.readAgentMetadata(agentId as never))?.runs?.length === 3) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const parentHistory = messages().filter(message =>
      (message.type === 'assistant' || message.type === 'user') && !message.parent_tool_use_id)
    const restoredAll = await withRestoredSubagentHistory(getSessionId(), parentHistory as never)
    for (const card of ['tu-agent-bg', 'tu-resume-1', 'tu-resume-2']) {
      const restoredUuids = restoredAll.history.filter(frame => 'parent_tool_use_id' in frame && frame.parent_tool_use_id === card).map(frame => frame.uuid)
      expect(restoredUuids).toEqual(nested(card).map(frame => frame.uuid))
    }

    // A foreground run now publishes reasoning and prose live, each step once.
    mode = 'fg'
    const start = session.received.length
    submit('launch-fg', 'LAUNCH-FG')
    await waitFor(() => session.received.slice(start).some(frame => frame.event?.message?.type === 'result'), 'foreground result')
    await waitFor(idle, 'foreground idle')
    const foreground = nested('tu-agent-fg')
    expect(blocksOf(foreground)).toEqual(expect.arrayContaining(['thinking', 'text', 'tool_use', 'tool_result']))
    const uuids = foreground.map(frame => frame.uuid)
    expect(new Set(uuids).size).toBe(uuids.length)
  } finally {
    session.server.close()
    scriptedModel = null
  }
}, 90_000)

test('a foreground worker keeps its own turn alive while it works', async () => {
  const stallMs = 300
  let workerCalls = 0
  scriptedModel = async function* (messages) {
    if (textOf(messages.slice(0, 1)).includes('WORKER-TASK')) {
      workerCalls++
      await new Promise(resolve => setTimeout(resolve, stallMs * 0.4))
      yield workerCalls <= 6
        ? assistant([{ type: 'tool_use', id: `tu-read-${workerCalls}`, name: 'Read', input: { file_path: readTarget } }], 'tool_use')
        : assistant([{ type: 'text', text: 'worker done' }], 'end_turn')
      return
    }
    yield textOf(messages.slice(-1)).includes('LAUNCH-FG')
      ? assistant([{ type: 'tool_use', id: 'tu-agent-fg', name: 'Agent', input: { description: 'fg', prompt: 'WORKER-TASK go', subagent_type: 'general-purpose' } }], 'tool_use')
      : assistant([{ type: 'text', text: 'parent ok' }], 'end_turn')
  }
  const lifecycle: Array<{ kind: string }> = []
  const session = startSession({ stallMs, lifecycle: lifecycle as unknown[] })
  try {
    const started = Date.now()
    session.submit('fg', 'LAUNCH-FG')
    await waitFor(() => session.messages().some(message => message.type === 'result'), 'foreground result', 20_000)
    await waitFor(() => !session.controller.isTurnActive(), 'idle', 20_000)
    // The run outlasted several stall windows with only nested frames in between.
    expect(Date.now() - started).toBeGreaterThan(stallMs * 2)
    expect(lifecycle.map(event => event.kind)).toEqual(['started', 'completed'])
  } finally {
    session.server.close()
    scriptedModel = null
  }
}, 60_000)
