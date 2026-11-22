import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from '../../node_modules/zod/v4'
import type { AssistantMessage } from '../../src/types/message.js'
import type { AppState } from '../../src/state/AppStateStore.js'
import type { Tool } from '../../src/Tool.js'
import type { LocalAgentTaskState } from '../../src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from '../../src/tasks/LocalShellTask/guards.js'
import type { CodeModeTaskState } from '../../src/tasks/CodeModeTask.js'
import type { ServerFrame, ClientFrame } from '../shared/protocol.js'

// Set isolation before loading engine settings, persistence, hooks, or shell state.
const root = mkdtempSync(join(tmpdir(), 'force-send-background-'))
mkdirSync(join(root, 'workspace'))
const previousConfig = process.env.CLAUDE_CONFIG_DIR
const previousSimple = process.env.CLAUDE_CODE_SIMPLE
const previousPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
const macroGlobal = globalThis as unknown as { MACRO?: { VERSION: string } }
const previousMacro = macroGlobal.MACRO
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
macroGlobal.MACRO = { VERSION: 'force-send-test' }

const { createRuntimeBackedAppSession } = await import('../../src/app-runtime/createRuntimeBackedAppSession.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.js')
const { getTaskOutputPath } = await import('../../src/utils/task/diskOutput.js')
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.js')
const { ResumeAgentTool } = await import('../../src/tools/ResumeAgentTool/ResumeAgentTool.js')
const { REPLTool } = await import('../../src/tools/REPLTool/REPLTool.js')
const { isAgentLifecycleOwned } = await import('../../src/tools/AgentTool/agentLifecycleOwnership.js')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
const { TaskStopTool } = await import('../../src/tools/TaskStopTool/TaskStopTool.js')
const { getInterruptedToolRun } = await import('../../src/services/tools/interruptedToolRun.js')
const { buildTool } = await import('../../src/Tool.js')
const { getBuiltInAgents } = await import('../../src/tools/AgentTool/builtInAgents.js')
const { stopTask } = await import('../../src/tasks/stopTask.js')
const { getCommandQueueSnapshot, resetCommandQueue } = await import('../../src/utils/messageQueueManager.js')
const { flushSessionStorage, flushCurrentTranscriptDurably, getTranscriptPath, resetProjectForTesting } = await import('../../src/utils/sessionStorage.js')
const { releaseActiveTranscriptLease } = await import('../../src/utils/transcriptLease.js')
const bootstrap = await import('../../src/bootstrap/state.js')
const shell = await import('../../src/utils/Shell.js')
const claude = await import('../../src/services/api/claude.js')
const queryConfig = await import('../../src/query/config.js')
const realBuildQueryConfig = queryConfig.buildQueryConfig
const { SidecarServer } = await import('./sidecarServer.js')
const { encodeFrame, FrameDecoder } = await import('../shared/framing.js')
const { PROTOCOL_VERSION } = await import('../shared/protocol.js')
const { MAX_OUTBOUND_FRAME_BYTES } = await import('../shared/limits.js')
const { mergeDisplayHistoryWithSeed, projectResumedHistory } = await import('./historyProjection.js')
const { createTranscriptState, projectServerFrames, selectTranscriptRows } = await import('../renderer/src/transcriptProjector.js')
const originalSession = bootstrap.getSessionId()
const originalProject = bootstrap.getSessionProjectDir()
const originalProvider = bootstrap.getSessionProvider()
const originalCwd = bootstrap.getCwdState()
let cleanup: (() => Promise<void>) | undefined
let providerSpy: { mockRestore(): void } | undefined
let shellSpy: { mockRestore(): void } | undefined
let configSpy: { mockRestore(): void } | undefined
let streamingEnabled = false
const realExec = shell.exec

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean, message: string, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function assistant(content: AssistantMessage['message']['content']): AssistantMessage {
  return {
    type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(),
    message: {
      id: randomUUID(), role: 'assistant', model: 'gpt-5.6-terra', content,
      usage: { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
    },
  } as AssistantMessage
}

function taskReports(messages: readonly unknown[], taskId: string) {
  return messages.filter(message => {
    const row = message as {
      type?: string
      origin?: { kind: string; taskId?: string }
      attachment?: { type: string; origin?: { kind: string; taskId?: string } }
    }
    const origin = row.type === 'user' ? row.origin
      : row.type === 'attachment' && row.attachment?.type === 'queued_command' ? row.attachment.origin
      : undefined
    return origin?.kind === 'task-notification' && origin.taskId === taskId
  })
}

async function expectDeliveredTaskReports(
  h: ReturnType<typeof harness>,
  providerInputs: readonly (readonly unknown[])[],
  expected: { id: string; result: string }[],
) {
  await waitFor(() => expected.every(task => providerInputs.some(messages =>
    taskReports(messages, task.id).length > 0,
  )), 'Completion reports did not reach the parent model')
  await h.controller.waitUntilIdle()
  await waitFor(() => h.getTasks().every(task =>
    task.type !== 'local_agent' || !isAgentLifecycleOwned(task.id),
  ), 'Worker notification producers did not settle')
  await flushCurrentTranscriptDurably()
  const rows = readFileSync(getTranscriptPath(), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  for (const task of expected) {
    // Provider snapshots contain cumulative history. Count within each input,
    // not across requests, where the same accepted report legitimately recurs.
    const inputs = providerInputs.map(messages => taskReports(messages, task.id))
    expect(inputs.some(reports => reports.length === 1 && JSON.stringify(reports).includes(task.result))).toBe(true)
    for (const reports of inputs) expect(reports.length).toBeLessThanOrEqual(1)
    const persisted = taskReports(rows, task.id)
    expect(persisted).toHaveLength(1)
    expect(JSON.stringify(persisted)).toContain(task.result)
  }
  expect(getCommandQueueSnapshot().filter(command => command.mode === 'task-notification')).toHaveLength(0)
}

beforeEach(async () => {
  streamingEnabled = false
  configSpy = spyOn(queryConfig, 'buildQueryConfig').mockImplementation(() => {
    const config = realBuildQueryConfig()
    return { ...config, gates: { ...config.gates, streamingToolExecution: streamingEnabled } }
  })
  await releaseActiveTranscriptLease()
  resetProjectForTesting()
  resetCommandQueue()
  bootstrap.switchSession(randomUUID() as never, join(root, randomUUID()))
  bootstrap.setSessionProvider('openai')
})

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  providerSpy?.mockRestore()
  providerSpy = undefined
  shellSpy?.mockRestore()
  shellSpy = undefined
  configSpy?.mockRestore()
  configSpy = undefined
  await flushSessionStorage()
  await releaseActiveTranscriptLease()
  resetProjectForTesting()
  resetCommandQueue()
  bootstrap.switchSession(originalSession, originalProject)
  bootstrap.setSessionProvider(originalProvider)
  shell.setCwd(originalCwd)
})

afterAll(() => {
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  if (previousSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
  else process.env.CLAUDE_CODE_SIMPLE = previousSimple
  if (previousPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousPersistence
  if (previousMacro === undefined) delete macroGlobal.MACRO
  else macroGlobal.MACRO = previousMacro
  rmSync(root, { recursive: true, force: true })
})

function harness(tools: Tool[] = [AgentTool, BashTool], askBash = false) {
  let state: AppState = getDefaultAppState()
  const getAppState = () => state
  const getTasks = () => Object.values(state.tasks as Record<string, LocalAgentTaskState | LocalShellTaskState | CodeModeTaskState>)
  const setAppState = (update: (prev: AppState) => AppState) => { state = update(state) }
  const controller = createRuntimeBackedAppSession({ queryEngineConfig: {
    cwd: join(root, 'workspace'), tools, commands: [], mcpClients: [], agents: getBuiltInAgents(),
    canUseTool: async (tool, input) => askBash && tool.name === 'Bash'
      ? { behavior: 'ask', message: 'Approve fixture command', updatedInput: input }
      : { behavior: 'allow', updatedInput: input },
    getAppState, setAppState, readFileCache: createFileStateCacheWithSizeLimit(20),
    customSystemPrompt: 'Isolated scripted queue handoff test.',
    userSpecifiedModel: 'gpt-5.6-terra', thinkingConfig: { type: 'disabled' },
  } })
  const sessionId = randomUUID()
  const frames: ServerFrame[] = []
  const server = new SidecarServer({ sessionId, engineSessionId: bootstrap.getSessionId(), controller, log: () => {} })
  const decoder = new FrameDecoder(MAX_OUTBOUND_FRAME_BYTES)
  const connection = server.addConnection({
    write(data) {
      for (const result of decoder.push(Buffer.from(data))) {
        if (result.kind === 'frame') frames.push(result.payload as ServerFrame)
      }
    },
    end() {},
  })
  const send = (message: ClientFrame['message']) => server.handleData(connection, encodeFrame({
    protocolVersion: PROTOCOL_VERSION, sessionId, message,
  }))
  cleanup = async () => {
    controller.abort('Test cleanup')
    for (const task of getTasks()) {
      if (task.status === 'running') await stopTask(task.id, { getAppState, setAppState })
    }
    await controller.waitUntilIdle()
    await waitFor(() => getTasks().every(task => task.type !== 'local_agent' || !isAgentLifecycleOwned(task.id)), 'Worker terminal cleanup did not settle')
    server.close()
  }
  async function force() {
    send({ type: 'app.submit', requestId: randomUUID(), prompt: 'new direction' })
    const head = getCommandQueueSnapshot().find(command => command.mode === 'prompt' && !command.isMeta)
    expect(head?.uuid).toBeString()
    send({ type: 'prompt.force', requestId: randomUUID(), promptId: head!.uuid! } as never)
  }
  return { controller, send, force, frames, getAppState, getTasks, setAppState, sessionId }
}

test.each([false, true])('a busy desktop turn displays the same worker finish live and on reopen (resumed=%s)', async resumed => {
  const finishWorker = deferred()
  const workerStarted = deferred()
  let resumedProviderStarted = false
  let mainCalls = 0
  const providerInputs: (readonly unknown[])[] = []
  const h = harness([AgentTool, BashTool, ResumeAgentTool])
  let firstAgentId: string | undefined
  const finishToolUseId = resumed ? 'resume-busy-worker' : 'busy-worker'
  providerSpy = spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* ({ options, messages }) {
    if (options.agentId) {
      if (resumed && firstAgentId === undefined) {
        firstAgentId = options.agentId
        yield assistant([{ type: 'text', text: 'original worker answer' }])
        return
      }
      resumedProviderStarted = true
      workerStarted.resolve()
      await finishWorker.promise
      yield assistant([{ type: 'text', text: 'mid-turn worker answer' }])
      return
    }
    providerInputs.push([...messages])
    if (++mainCalls === 1) {
      yield assistant([{ type: 'tool_use', id: 'busy-worker', name: 'Agent', input: {
        description: 'Busy worker', prompt: 'Give the test answer.', subagent_type: 'general-purpose', run_in_background: !resumed,
      } }])
    } else if (resumed && mainCalls === 2) {
      await flushSessionStorage()
      yield assistant([{ type: 'tool_use', id: finishToolUseId, name: 'ResumeAgent', input: {
        agentId: firstAgentId, prompt: 'Give the updated test answer.',
      } }])
    } else if (mainCalls === (resumed ? 3 : 2)) {
      if (resumed) await waitFor(() => resumedProviderStarted, 'Resume did not enter its provider', 1000)
      else await workerStarted.promise
      finishWorker.resolve()
      await waitFor(() => getCommandQueueSnapshot().some(command => command.origin?.kind === 'task-notification'), 'Worker did not report its result')
      yield assistant([{ type: 'tool_use', id: 'parent-work', name: 'Bash', input: { command: 'printf parent-work' } }])
    } else {
      yield assistant([{ type: 'text', text: 'parent final answer' }])
    }
  })
  try {
    h.send({ type: 'app.submit', requestId: 'start', prompt: 'run the worker while busy' })
    await waitFor(() => h.getTasks().some(task => task.type === 'local_agent'), 'Worker did not start')
    const id = h.getTasks().find(task => task.type === 'local_agent')!.id
    try { await expectDeliveredTaskReports(h, providerInputs, [{ id, result: 'mid-turn worker answer' }]) }
    catch (error) {
      const frames = h.frames.flatMap(frame => frame.kind === 'event' && frame.event.type === 'message' && frame.event.message.type === 'user' ? [frame.event.message] : [])
      throw new Error(JSON.stringify({ mainCalls, firstAgentId, resumedProviderStarted, frames }).slice(0, 6000), { cause: error })
    }
    expect(mainCalls).toBe(resumed ? 4 : 3)
    const history = await (await import('../../src/utils/sessionStorage.js')).loadTranscriptFile(getTranscriptPath())
    const saved = [...history.messages.values()]
    const reopened = projectResumedHistory(saved)
    const backfilled = mergeDisplayHistoryWithSeed(saved, reopened.slice(-1))
    expect(backfilled).toEqual({ history: reopened, truncated: false })
    const live = h.frames.flatMap(frame => frame.kind === 'event' && frame.event.type === 'message' ? [frame.event.message] : [])
    const finishReports = (messages: typeof live) => messages.filter(message =>
      message.type === 'user' && message.origin?.kind === 'task-notification' && message.origin.toolUseId === finishToolUseId)
    expect(finishReports(live)).toHaveLength(1)
    expect(JSON.parse(JSON.stringify(finishReports(reopened)))).toEqual(finishReports(live))
    const render = (frames: ServerFrame[]) => selectTranscriptRows(projectServerFrames(createTranscriptState(), frames), h.sessionId)
    const reopenedFrames: ServerFrame[] = [...h.frames.filter(frame => frame.kind === 'ready'), ...reopened.map((message): ServerFrame => ({
      kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: h.sessionId, event: { type: 'message', message },
    }))]
    for (const rows of [render(h.frames), render(reopenedFrames)]) {
      const finish = rows.findIndex(row => row.kind === 'task-notification' && row.toolUseId === finishToolUseId)
      if (resumed) {
        expect(finish).toBe(-1)
        const card = rows.find(row => row.kind === 'tool-use' && row.toolUseId === finishToolUseId)
        expect(card).toMatchObject({ toolName: 'ResumeAgent', agentCompletion: { result: 'mid-turn worker answer' } })
      } else {
        expect(finish).toBeGreaterThanOrEqual(0)
        expect(rows.slice(finish + 1).some(row => row.kind === 'assistant-text' && row.content === 'parent final answer')).toBe(true)
      }
    }
  } finally { finishWorker.resolve() }
})

test('TaskStop keeps the parent turn alive while the stopped worker saves a running tool result', async () => {
  const started = deferred()
  const complete = deferred()
  const command = 'printf "worker effect settled"'
  shellSpy = spyOn(shell, 'exec').mockImplementation(async (...args) => {
    const run = await realExec(...args)
    if (args[0] !== command) return run
    const result = run.result.then(async outcome => { await complete.promise; return outcome })
    started.resolve()
    return Object.create(run, { result: { value: result } })
  })
  const h = harness([AgentTool, TaskStopTool, BashTool])
  let mainCalls = 0
  let stoppedWorkerReportInTurn = false
  const parentErrors: unknown[] = []
  let parentTurnResults = 0
  let resultsBeforeContinuation = -1
  const unsubscribe = h.controller.subscribe(event => {
    if (event.type !== 'message') return
    if (event.message.type === 'result') parentTurnResults++
    if (event.message.type === 'assistant' && event.message.parent_tool_use_id === null &&
        JSON.stringify(event.message.message.content).includes('Some tool actions have not finished')) parentErrors.push(event.message.message.content)
  })
  providerSpy = spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* ({ options, messages }) {
    if (options.agentId) {
      yield assistant([{ type: 'tool_use', id: 'worker-effect', name: 'Bash', input: { command } }])
    } else if (++mainCalls === 1) {
      yield assistant([{ type: 'tool_use', id: 'stopped-worker', name: 'Agent', input: {
        description: 'Worker with held effect', prompt: 'Run the held effect.', subagent_type: 'general-purpose', run_in_background: true,
      } }])
    } else if (mainCalls === 2) {
      await started.promise
      yield assistant([{ type: 'tool_use', id: 'stop-worker', name: 'TaskStop', input: {
        task_id: h.getTasks().find(task => task.type === 'local_agent')!.id,
      } }])
    } else {
      resultsBeforeContinuation = parentTurnResults
      stoppedWorkerReportInTurn = h.controller.isTurnActive() && taskReports(messages, h.getTasks().find(task => task.type === 'local_agent')!.id).length === 1
      yield assistant([{ type: 'text', text: 'continued after stopping worker' }])
    }
  })
  try {
    h.send({ type: 'app.submit', requestId: 'start', prompt: 'start and stop a worker' })
    await waitFor(() => getInterruptedToolRun(bootstrap.getSessionId()).blocked, 'Worker effect was not retained on cancellation')
    expect(mainCalls).toBe(2)
    expect(h.controller.canStartQueuedTurn()).toBe(false)
    await Bun.sleep(100)
    complete.resolve()
    await waitFor(() => mainCalls >= 3, 'Parent model did not receive the stopped worker report')
    await h.controller.waitUntilIdle()
    expect(parentErrors).toEqual([])
    expect(resultsBeforeContinuation).toBe(0)
    expect(stoppedWorkerReportInTurn).toBe(true)
    expect(mainCalls).toBe(3)
  } finally { started.resolve(); complete.resolve(); unsubscribe() }
})

const testWithScript = feature('CODE_MODE') ? test : test.skip
testWithScript('a Script that finishes while idle wakes the model once, without a notification row', async () => {
  const releaseFile = join(root, 'workspace', randomUUID())
  const command = 'while [ ! -f ' + JSON.stringify(releaseFile) + ' ]; do /bin/sleep 0.02; done'
  const resultMarker = 'idle-script-outcome'
  const h = harness([REPLTool, BashTool])
  let mainCalls = 0
  let receiptCount = 0
  providerSpy = spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* ({ messages }) {
    if (++mainCalls === 1) {
      yield assistant([{ type: 'tool_use', id: 'idle-script', name: 'REPL', input: {
        description: 'Wait briefly and report', run_in_background: true,
        code: 'await tools.call({name:"Bash",input:' + JSON.stringify({ command, work_lifetime: 'finite', run_in_background: false }) + '}); output(' + JSON.stringify(resultMarker) + ')',
      } }])
    } else {
      receiptCount = messages.filter(message => message.type === 'user' && typeof message.message.content === 'string' &&
        message.message.content.includes('<background-code-mode-data>') && message.message.content.includes(resultMarker)).length
      yield assistant([{ type: 'text', text: 'idle Script result received' }])
    }
  })
  try {
    h.send({ type: 'app.submit', requestId: 'start', prompt: 'Start an idle background Script' })
    await waitFor(() => h.getTasks().some(task => task.type === 'code_mode'), 'Script did not start')
    await h.controller.waitUntilIdle()
    expect(mainCalls).toBe(2)
    expect(receiptCount).toBe(0)
    writeFileSync(releaseFile, '')
    await waitFor(() => mainCalls >= 3, 'An idle completion did not wake the parent model')
    await h.controller.waitUntilIdle()
    expect(mainCalls).toBe(3)
    expect(receiptCount).toBe(1)
    expect(getCommandQueueSnapshot()).toHaveLength(0)
    const rows = selectTranscriptRows(projectServerFrames(createTranscriptState(), h.frames), h.sessionId)
    expect(rows.filter(row => row.kind === 'task-notification')).toHaveLength(0)
    expect(rows.find(row => row.kind === 'tool-use' && row.toolUseId === 'idle-script')).toMatchObject({
      result: { codeMode: { status: 'completed', output: expect.stringContaining(resultMarker) } },
    })
    await flushCurrentTranscriptDurably()
    const history = await (await import('../../src/utils/sessionStorage.js')).loadTranscriptFile(getTranscriptPath())
    expect(projectResumedHistory([...history.messages.values()]).filter(message => message.type === 'user' &&
      message.origin?.kind === 'task-notification' && message.origin.status !== undefined)).toHaveLength(0)
  } finally { writeFileSync(releaseFile, '') }
})

test.each([false, true])('force-send preserves three foreground agents and their results (streaming=%s)', async streaming => {
  streamingEnabled = streaming
  const gate = deferred()
  const workerSignals = new Map<string, AbortSignal>()
  let mainCalls = 0
  let newInputSeen = 0
  let forcedMessages = ''
  const providerInputs: (readonly unknown[])[] = []
  providerSpy = spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* ({ options, signal, messages }) {
    if (options.agentId) {
      workerSignals.set(options.agentId, signal)
      await Promise.race([gate.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))])
      if (!signal.aborted) yield assistant([{ type: 'text', text: `finished ${options.agentId}` }])
      return
    }
    providerInputs.push([...messages])
    mainCalls++
    if (mainCalls === 1) {
      yield assistant(Array.from({ length: 3 }, (_, i) => ({
        type: 'tool_use' as const, id: `worker-${i}`, name: 'Agent',
        input: { description: `worker ${i}`, prompt: `Do task ${i}`, subagent_type: 'general-purpose' },
      })))
    } else {
      if (JSON.stringify(messages).includes('new direction')) {
        newInputSeen++
        forcedMessages = JSON.stringify(messages)
      }
      yield assistant([{ type: 'text', text: 'handling new direction' }])
    }
  })
  const h = harness()
  try {
    h.send({ type: 'app.submit', requestId: 'start', prompt: 'start workers' })
    await waitFor(() => workerSignals.size === 3, 'Three workers did not start')
    const before = h.getTasks().filter(task => task.type === 'local_agent')
    expect(before).toHaveLength(3)
    await h.force()
    await waitFor(() => newInputSeen === 1, 'Forced input did not reach the main model')
    expect([...workerSignals.values()].map(signal => signal.aborted)).toEqual([false, false, false])
    for (const task of before) {
      expect(h.getAppState().tasks[task.id]).toMatchObject({ status: 'running', isBackgrounded: true, runId: task.runId })
      expect(forcedMessages).toContain(task.id)
    }
    gate.resolve()
    await waitFor(() => before.every(task => h.getAppState().tasks[task.id]?.status === 'completed'), 'Workers did not complete')
    await expectDeliveredTaskReports(h, providerInputs, before.map(task => ({
      id: task.id, result: `finished ${task.id}`,
    })))
  } finally {
    gate.resolve()
  }
})

test.each((['startup', 'explicit-startup', 'early', 'registered'] as const).flatMap(phase => [false, true].map(streaming => [phase, streaming] as const)))('force-send backgrounds quiet Bash during %s and delivers its result once (streaming=%s)', async (phase, streaming) => {
  streamingEnabled = streaming
  const readyPath = join(root, `${randomUUID()}.ready`)
  const releasePath = join(root, `${randomUUID()}.release`)
  const code = `import{existsSync,writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(readyPath)},String(process.pid));const timer=setInterval(()=>{if(existsSync(${JSON.stringify(releasePath)})){clearInterval(timer);console.log("preserved shell result")}},5)`
  const command = `${JSON.stringify(process.execPath)} --eval '${code}'`
  let mainCalls = 0
  let newInputSeen = 0
  const providerInputs: (readonly unknown[])[] = []
  providerSpy = spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* ({ messages }) {
    providerInputs.push([...messages])
    if (++mainCalls === 1) {
      yield assistant([{ type: 'tool_use', id: 'shell-work', name: 'Bash', input: {
        command, timeout: 20_000, ...(phase === 'explicit-startup' ? { run_in_background: true } : {}),
      } }])
    } else {
      if (JSON.stringify(messages).includes('new direction')) newInputSeen++
      yield assistant([{ type: 'text', text: 'handling new direction' }])
    }
  })
  const h = harness()
  let spawned: Awaited<ReturnType<typeof realExec>> | undefined
  if (phase === 'startup' || phase === 'explicit-startup') {
    shellSpy = spyOn(shell, 'exec').mockImplementation(async (...args) => {
      const result = await realExec(...args)
      if (args[0] === command) {
        spawned = result
        await h.force()
      }
      return result
    })
  }
  try {
    h.send({ type: 'app.submit', requestId: 'start', prompt: 'run a command' })
    await waitFor(() => existsSync(readyPath), 'Shell process did not start')
    if (phase !== 'startup' && phase !== 'explicit-startup') {
      if (phase === 'registered') {
        await waitFor(() => h.getTasks().some(task => task.type === 'local_bash' && !task.isBackgrounded), 'Shell foreground task was not registered')
      } else {
        expect(h.getTasks().filter(task => task.type === 'local_bash')).toHaveLength(0)
      }
      await h.force()
    }
    await waitFor(() => newInputSeen === 1, 'Forced input waited for the quiet shell')
    const tasks = h.getTasks().filter(task => task.type === 'local_bash')
    expect(tasks).toHaveLength(1)
    const task = tasks[0]!
    expect(task).toMatchObject({ status: 'running', isBackgrounded: true })
    writeFileSync(releasePath, '')
    await waitFor(() => h.getAppState().tasks[task.id]?.status === 'completed', 'Shell task did not complete')
    await expectDeliveredTaskReports(h, providerInputs, [{ id: task.id, result: 'preserved shell result' }])
    expect(h.getAppState().tasks[task.id]).toMatchObject({ result: { code: 0, interrupted: false } })
    expect(readFileSync(getTaskOutputPath(task.id), 'utf8')).toContain('preserved shell result')
  } finally {
    writeFileSync(releasePath, '')
    if (spawned?.status === 'running') spawned.kill()
  }
}, 15_000)

test.each([false, true])('force-send resumes only after a retained effect receipt settles (streaming=%s)', async streaming => {
  streamingEnabled = streaming
  const started = deferred()
  const complete = deferred()
  let effects = 0
  let mainCalls = 0
  let forcedMessages = ''
  const tool = buildTool({
    name: 'HeldEffect',
    inputSchema: z.object({}),
    description: async () => 'Isolated held effect',
    prompt: async () => 'Isolated held effect',
    maxResultSizeChars: 1000,
    renderToolUseMessage: () => null,
    async call() {
      effects++
      started.resolve()
      await complete.promise
      return { data: 'retained effect receipt' }
    },
    mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: data }),
  })
  providerSpy = spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* ({ messages }) {
    if (++mainCalls === 1) {
      yield assistant([{ type: 'tool_use', id: 'held-effect', name: 'HeldEffect', input: {} }])
    } else {
      forcedMessages = JSON.stringify(messages)
      yield assistant([{ type: 'text', text: 'handling new direction' }])
    }
  })
  const h = harness([tool])
  try {
    h.send({ type: 'app.submit', requestId: 'start', prompt: 'start held effect' })
    await started.promise
    await h.force()
    await waitFor(() => !h.controller.isTurnActive(), 'Interrupted foreground turn did not return')
    expect(mainCalls).toBe(1)
    expect(h.controller.canStartQueuedTurn()).toBe(false)
    expect(getCommandQueueSnapshot().filter(command => command.mode === 'prompt')).toHaveLength(1)
    complete.resolve()
    await waitFor(() => mainCalls === 2 && !h.controller.isTurnActive(), 'Settled receipt did not wake the queued prompt')
    expect(effects).toBe(1)
    expect(forcedMessages).toContain('retained effect receipt')
    expect(forcedMessages).toContain('new direction')
    await flushCurrentTranscriptDurably()
    const rows = readFileSync(getTranscriptPath(), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rows.filter(row => row.type === 'user' && Array.isArray(row.message.content) &&
      row.message.content.some((block: { type: string; tool_use_id?: string }) =>
        block.type === 'tool_result' && block.tool_use_id === 'held-effect'))).toHaveLength(1)
    expect(getCommandQueueSnapshot().filter(command => command.mode === 'prompt')).toHaveLength(0)
  } finally {
    complete.resolve()
  }
})

test('Bash completion racing force-send returns its output without a duplicate task notification', async () => {
  const command = 'printf "completed-at-cut"'
  let mainCalls = 0
  let forcedUserContent = ''
  providerSpy = spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* ({ messages }) {
    if (++mainCalls === 1) {
      yield assistant([{ type: 'tool_use', id: 'completed-shell', name: 'Bash', input: { command } }])
    } else {
      forcedUserContent = JSON.stringify(messages.filter(message => message.type === 'user').map(message => message.message.content))
      yield assistant([{ type: 'text', text: 'handling new direction' }])
    }
  })
  const h = harness()
  shellSpy = spyOn(shell, 'exec').mockImplementation(async (...args) => {
    const result = await realExec(...args)
    if (args[0] === command) {
      await result.result
      await h.force()
    }
    return result
  })
  h.send({ type: 'app.submit', requestId: 'start', prompt: 'run a command' })
  await waitFor(() => mainCalls === 2 && !h.controller.isTurnActive(), 'Completed command held up force-send')
  expect(forcedUserContent.match(/completed-at-cut/g)).toHaveLength(1)
  expect(getCommandQueueSnapshot().filter(command => command.mode === 'task-notification')).toHaveLength(0)
})

test('worker approvals survive force-send and a later approval remains answerable between parent turns', async () => {
  let mainCalls = 0
  let workerCalls = 0
  providerSpy = spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* ({ options }) {
    if (options.agentId) {
      if (++workerCalls <= 2) {
        yield assistant([{ type: 'tool_use', id: `approval-${workerCalls}`, name: 'Bash', input: { command: `printf "approved ${workerCalls}"` } }])
      } else {
        yield assistant([{ type: 'text', text: 'approved worker complete' }])
      }
    } else if (++mainCalls === 1) {
      yield assistant([{ type: 'tool_use', id: 'approval-worker', name: 'Agent', input: {
        description: 'approval worker', prompt: 'Run approved commands', subagent_type: 'general-purpose',
      } }])
    } else {
      yield assistant([{ type: 'text', text: 'handling new direction' }])
    }
  })
  const h = harness(undefined, true)
  h.send({ type: 'app.submit', requestId: 'start', prompt: 'start worker' })
  await waitFor(() => h.controller.getPendingPermissionRequests().length === 1, 'Worker did not request approval')
  const first = h.controller.getPendingPermissionRequests()[0]!
  expect(first.request.agent_id).toBeString()
  await h.force()
  await waitFor(() => mainCalls === 2 && !h.controller.isTurnActive(), 'Forced turn did not complete')
  expect(h.controller.getPendingPermissionRequests().map(request => request.requestId)).toEqual([first.requestId])
  h.send({ type: 'permission.response', requestId: first.requestId, response: { behavior: 'allow', updatedInput: first.request.input } })
  await waitFor(() => h.controller.getPendingPermissionRequests().some(request => request.request.tool_use_id === 'approval-2'), 'Second approval did not reach the idle session')
  const second = h.controller.getPendingPermissionRequests()[0]!
  h.send({ type: 'permission.response', requestId: second.requestId, response: { behavior: 'allow', updatedInput: second.request.input } })
  await waitFor(() => h.getTasks().some(task => task.type === 'local_agent' && task.status === 'completed'), 'Approved background worker did not complete')
  expect(h.controller.getPendingPermissionRequests()).toHaveLength(0)
  expect(workerCalls).toBe(3)
  // The worker's report starts one more parent turn. Left running, it takes the next test's scripted reply.
  await waitFor(() => mainCalls === 3 && !h.controller.isTurnActive(), 'Worker report did not reach the parent')
}, 15_000)

test('force-send cancels a main-tool approval and never starts its denied command', async () => {
  const marker = join(root, `${randomUUID()}.must-not-exist`)
  let mainCalls = 0
  providerSpy = spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    if (++mainCalls === 1) {
      yield assistant([{ type: 'tool_use', id: 'main-approval', name: 'Bash', input: { command: `touch ${marker}` } }])
    } else {
      yield assistant([{ type: 'text', text: 'handling new direction' }])
    }
  })
  const h = harness(undefined, true)
  h.send({ type: 'app.submit', requestId: 'start', prompt: 'ask before a command' })
  await waitFor(() => h.controller.getPendingPermissionRequests().length === 1, 'Main tool did not request approval')
  await h.force()
  await waitFor(() => mainCalls === 2 && !h.controller.isTurnActive(), 'Main approval held up force-send')
  expect(h.controller.getPendingPermissionRequests()).toHaveLength(0)
  expect(existsSync(marker)).toBe(false)
}, 15_000)

test.each(['ordinary', 'task'] as const)('%s Stop still cancels an agent rather than detaching it', async kind => {
  let workerSignal: AbortSignal | undefined
  let mainCalls = 0
  providerSpy = spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* ({ options, signal }) {
    if (options.agentId) {
      workerSignal = signal
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), { once: true })
        if (signal.aborted) resolve()
      })
    } else if (++mainCalls === 1) {
      yield assistant([{ type: 'tool_use', id: 'stoppable-worker', name: 'Agent', input: {
        description: 'stoppable worker', prompt: 'Wait for cancellation', subagent_type: 'general-purpose',
      } }])
    } else {
      yield assistant([{ type: 'text', text: 'handling new direction' }])
    }
  })
  const h = harness()
  h.send({ type: 'app.submit', requestId: 'start', prompt: 'start worker' })
  await waitFor(() => workerSignal !== undefined, 'Worker did not start')
  if (kind === 'task') {
    await h.force()
    await waitFor(() => mainCalls === 2 && !h.controller.isTurnActive(), 'Forced turn did not settle')
    const task = h.getTasks().find(task => task.type === 'local_agent')!
    await stopTask(task.id, h)
    expect(h.getAppState().tasks[task.id]?.status).toBe('killed')
  } else {
    h.send({ type: 'app.abort', requestId: 'stop', reason: 'Stop fixture work' })
    await h.controller.waitUntilIdle()
    expect(mainCalls).toBe(1)
    expect(h.getTasks().some(task => task.status === 'running')).toBe(false)
  }
  expect(workerSignal!.aborted).toBe(true)
})

test('disabled backgrounding uses cancellation without hanging', async () => {
  const child = Bun.spawn([process.execPath, 'test', import.meta.path, '-t', '^disabled backgrounding fixture '], {
    env: { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 })
}, 15_000)

test.skipIf(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS !== '1').each(['Agent', 'Bash'] as const)('disabled backgrounding fixture %s', async tool => {
  let mainCalls = 0
  let workerSignal: AbortSignal | undefined
  let spawned: Awaited<ReturnType<typeof realExec>> | undefined
  shellSpy = spyOn(shell, 'exec').mockImplementation(async (...args) => {
    const result = await realExec(...args)
    if (args[0].includes('disabled-background-fixture')) spawned = result
    return result
  })
  providerSpy = spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* ({ options, signal }) {
    if (options.agentId) {
      workerSignal = signal
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), { once: true })
        if (signal.aborted) resolve()
      })
    } else if (++mainCalls === 1) {
      yield assistant([{ type: 'tool_use', id: 'disabled-work', name: tool, input: tool === 'Agent'
        ? { description: 'disabled backgrounding', prompt: 'Wait', subagent_type: 'general-purpose' }
        : { command: `${JSON.stringify(process.execPath)} --eval '/*disabled-background-fixture*/setInterval(()=>{},1000)'`, timeout: 10_000 },
      }])
    } else {
      yield assistant([{ type: 'text', text: 'handling new direction' }])
    }
  })
  const h = harness()
  try {
    h.send({ type: 'app.submit', requestId: 'start', prompt: 'start foreground work' })
    await waitFor(() => tool === 'Agent' ? !!workerSignal : !!spawned, 'Disabled foreground work did not start')
    await h.force()
    await waitFor(() => mainCalls === 2 && !h.controller.isTurnActive(), 'Disabled backgrounding blocked force-send')
    if (tool === 'Agent') expect(workerSignal!.aborted).toBe(true)
    else expect((await spawned!.result).interrupted).toBe(true)
    expect(h.getTasks().some(task => task.status === 'running')).toBe(false)
  } finally {
    if (spawned?.status === 'running') spawned.kill()
  }
}, 15_000)
