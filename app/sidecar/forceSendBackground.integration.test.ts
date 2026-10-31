import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage } from '../../src/types/message.js'
import type { AppState } from '../../src/state/AppStateStore.js'
import type { Tool } from '../../src/Tool.js'
import type { LocalAgentTaskState } from '../../src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from '../../src/tasks/LocalShellTask/guards.js'
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
const { isAgentLifecycleOwned } = await import('../../src/tools/AgentTool/agentLifecycleOwnership.js')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
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
  const getTasks = () => Object.values(state.tasks as Record<string, LocalAgentTaskState | LocalShellTaskState>)
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
  return { controller, send, force, frames, getAppState, getTasks, setAppState }
}

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
