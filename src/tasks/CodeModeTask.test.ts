import { afterEach, expect, test } from 'bun:test'
import type { AppState } from '../state/AppState.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { applyTaskEvictions, evictTerminalTask, generateTaskAttachments } from '../utils/task/framework.js'
import type { CodeModeTaskState } from './CodeModeTask.js'
import type { ToolUseContext } from '../Tool.js'
const { registerCodeModeTask: registerOwnedCodeModeTask, CodeModeTask, drainCodeModeTasks, assertCodeModeTaskAccess } = await import('./CodeModeTask.js')
import type { CodeModeResult } from '../tools/REPLTool/codeModeHost.js'
import { cleanupTaskOutput, getTaskOutput } from '../utils/task/diskOutput.js'
const artifacts = new Set<string>()
function registerCodeModeTask<T>(options: Parameters<typeof registerOwnedCodeModeTask<T>>[0]) {
  const handle = registerOwnedCodeModeTask(options)
  artifacts.add(handle.taskId)
  return handle
}
afterEach(async () => {
  await Promise.all([...artifacts].map(id => cleanupTaskOutput(id)))
  artifacts.clear()
})

function fixture(agentId?: string) {
  let state = getDefaultAppState()
  const owner = { sessionId: crypto.randomUUID(), agentId, workerRunId: agentId ? crypto.randomUUID() : undefined }
  let resolve!: (value: { result: CodeModeResult; value: number }) => void
  const completion = new Promise<{ result: CodeModeResult; value: number }>(r => { resolve = r })
  let cancelled = 0
  const setAppState = (update: (prev: typeof state) => typeof state) => { state = update(state) }
  const handle = registerCodeModeTask({ owner, cellId: 'cell', generation: 'gen', description: 'test', setAppState, completion, cancel: () => { cancelled++ } })
  const result: CodeModeResult = { kind: 'code-mode', cellId: 'cell', generation: 'gen', description: 'test', code: 'write()', status: 'completed', output: 'selected', calls: [], changedFiles: [] }
  return { owner, handle, result, resolve, setAppState, state: () => state.tasks[handle.taskId] as CodeModeTaskState, cancelled: () => cancelled }
}

test('launch is running; cancellation does not claim host effects settled', async () => {
  const f = fixture()
  expect(f.state().status).toBe('running')
  await CodeModeTask.kill(f.handle.taskId, f.setAppState)
  await f.handle.cancel()
  expect(f.cancelled()).toBe(1)
  expect(f.state().cancellationRequested).toBe(true)
  expect(f.state().settled).toBe(false)
  expect(f.state().status).toBe('running')
  f.resolve({ result: { ...f.result, status: 'cancelled' }, value: 1 })
  await f.handle.settled
  expect(f.state().status).toBe('killed')
  await f.handle.deliver(async () => {})
})

test('failed durable delivery retains exact outcome and retry never reruns effects', async () => {
  const f = fixture()
  f.handle.updateReceipt({ ...f.result, status: 'running', output: 'partial' })
  expect(f.state().receipt?.output).toBe('partial')
  f.resolve({ result: f.result, value: 42 })
  await f.handle.settled
  await expect(f.handle.deliver(async () => { throw new Error('disk failed') })).rejects.toThrow('disk failed')
  expect(f.state().delivery).toBe('failed')
  expect(f.handle.getOutcome()?.value).toBe(42)
  let received = 0
  await f.handle.deliver(async outcome => { received = outcome.value })
  expect(received).toBe(42)
  expect(f.state().delivery).toBe('delivered')
  expect(f.cancelled()).toBe(0)
})

test('owner drain closes only its incarnation and waits for settlement and delivery', async () => {
  const f = fixture('worker')
  const other = fixture('worker')
  let delivered = false
  const drain = drainCodeModeTasks(f.owner, async (_, outcome) => { expect(outcome.result.output).toBe('selected'); delivered = true }, true)
  await Promise.resolve()
  expect(delivered).toBe(false)
  expect(other.cancelled()).toBe(0)
  f.resolve({ result: f.result, value: 1 })
  await drain
  expect(delivered).toBe(true)
  expect(f.state().delivery).toBe('delivered')
  other.resolve({ result: other.result, value: 2 })
  await other.handle.deliver(async () => {})
})

test('normal task controls reject cross-session and sibling-worker access', async () => {
  const f = fixture('worker')
  expect(() => assertCodeModeTaskAccess(f.state(), f.owner.sessionId, 'other')).toThrow('another owner')
  expect(() => assertCodeModeTaskAccess(f.state(), 'other')).toThrow('another owner')
  expect(() => assertCodeModeTaskAccess(f.state(), f.owner.sessionId)).not.toThrow()
  expect(() => assertCodeModeTaskAccess(f.state(), f.owner.sessionId, 'worker')).not.toThrow()
  f.resolve({ result: f.result, value: 1 })
  await f.handle.deliver(async () => {})
})

test('owner drain delivery failure retains ownership and can retry', async () => {
  const f = fixture('worker')
  f.resolve({ result: { ...f.result, status: 'failed', error: 'command failed' }, value: 7 })
  await expect(drainCodeModeTasks(f.owner, async () => { throw new Error('not durable') })).rejects.toThrow('not durable')
  expect(f.state().receipt?.error).toBe('command failed')
  expect(f.state().delivery).toBe('failed')
  await drainCodeModeTasks(f.owner, async (_, outcome) => { expect(outcome.value).toBe(7) })
  expect(f.state().delivery).toBe('delivered')
})

test('background adapter adopts real host promise and preserves messages/context on delivery', async () => {
  const { backgroundCodeModeCell } = await import('../tools/REPLTool/codeModeBackground.js')
  let state = getDefaultAppState()
  const context = { setAppState: (update: (s: AppState) => AppState) => { state = update(state) } } as ToolUseContext
  let resolve!: (value: import('../tools/REPLTool/codeModeBackground.js').CodeModeHostCompletion) => void
  const completion = new Promise<import('../tools/REPLTool/codeModeBackground.js').CodeModeHostCompletion>(r => { resolve = r })
  const handle = backgroundCodeModeCell({ owner: { sessionId: crypto.randomUUID() }, cellId: 'c', generation: 'g', description: 'adopt', context, completion, cancel: () => {} })
  artifacts.add(handle.taskId)
  expect(handle.receipt.status).toBe('running')
  expect(state.tasks[handle.taskId]?.status).toBe('running')
  const result: CodeModeResult = { kind: 'code-mode', cellId: 'c', generation: 'g', description: 'adopt', code: 'effect()', status: 'completed', output: 'done', calls: [], changedFiles: [] }
  const messages: import('../types/message.js').Message[] = []
  resolve({ result, messages, context })
  await handle.deliver(async value => {
    expect(value.messages).toBe(messages)
    expect(value.context).toBe(context)
    expect(value.result.output).toBe('done')
  })
})

test('host rejection requires durable failure delivery and never fabricates a receipt', async () => {
  let state = getDefaultAppState()
  const failure = new Error('host transport lost')
  const handle = registerCodeModeTask({ owner: { sessionId: crypto.randomUUID() }, cellId: 'c', generation: 'g', description: 'rejected', setAppState: update => { state = update(state) }, completion: Promise.reject(failure), cancel: () => {} })
  await handle.settled
  expect(handle.getOutcome()).toBeUndefined()
  expect(handle.getFailure()).toBe(failure)
  await expect(handle.deliver(async () => {})).rejects.toThrow('durable failure sink')
  expect((state.tasks[handle.taskId] as CodeModeTaskState).delivery).toBe('failed')
  await handle.deliver(async () => { throw new Error('unexpected success') }, async error => { expect(error).toBe(failure) })
  expect((state.tasks[handle.taskId] as CodeModeTaskState).delivery).toBe('delivered')
})

test('normal task garbage collection cannot drop a Code Mode receipt or its owner', async () => {
  const f = fixture()
  f.resolve({ result: f.result, value: 1 })
  await f.handle.settled
  f.setAppState(prev => ({ ...prev, tasks: { ...prev.tasks, [f.handle.taskId]: { ...prev.tasks[f.handle.taskId]!, notified: true } } }))
  let state = getDefaultAppState()
  state = { ...state, tasks: { [f.handle.taskId]: f.state() } }
  expect(generateTaskAttachments(state).evictedTaskIds).not.toContain(f.handle.taskId)
  const set = (update: (s: AppState) => AppState) => { state = update(state) }
  evictTerminalTask(f.handle.taskId, set)
  applyTaskEvictions(set, [f.handle.taskId])
  expect(state.tasks[f.handle.taskId]).toBeDefined()
  await f.handle.deliver(async () => {})
})

test('TaskOutput and TaskStop dispatch real Code Mode tasks without claiming cancellation settled', async () => {
  const { getSessionId } = await import('../bootstrap/state.js')
  const { TaskOutputTool } = await import('../tools/TaskOutputTool/TaskOutputTool.js')
  const { TaskStopTool } = await import('../tools/TaskStopTool/TaskStopTool.js')
  let state = getDefaultAppState()
  const context = {
    getAppState: () => state,
    setAppState: (update: (s: AppState) => AppState) => { state = update(state) },
    abortController: new AbortController(),
  }
  let resolve!: (value: { result: CodeModeResult; value: null }) => void
  const completion = new Promise<{ result: CodeModeResult; value: null }>(r => { resolve = r })
  const handle = registerCodeModeTask({ owner: { sessionId: getSessionId() }, cellId: 'control', generation: 'gen', description: 'controlled cell', completion, cancel: () => {}, setAppState: context.setAppState })
  const read = () => TaskOutputTool.call({ task_id: handle.taskId, block: false, timeout: 0 }, context as never, undefined as never, undefined as never)
  expect((await read()).data.retrieval_status).toBe('not_ready')
  const stop = await TaskStopTool.call({ task_id: handle.taskId }, context as never)
  expect(stop.data.message).toContain('Cancellation requested')
  expect((await read()).data.task?.status).toBe('running')
  resolve({ result: { kind: 'code-mode', cellId: 'control', generation: 'gen', description: 'controlled cell', code: 'effect()', status: 'cancelled', output: 'partial effect receipt', calls: [], changedFiles: [] }, value: null })
  await handle.settled
  const output = (await read()).data
  expect(output.retrieval_status).toBe('success')
  expect(output.task?.output).toContain('partial effect receipt')
  expect(output.task?.output).toContain('\"settled\":true')
  await handle.deliver(async () => {})
})

test('published running audit is a snapshot; yielded is genuinely terminal evidence', async () => {
  const f = fixture()
  const running = { ...f.result, status: 'running' as const }
  f.handle.updateReceipt(running)
  const published = f.state().receipt!
  running.output = 'mutated later'
  running.changedFiles.push({ path: 'later.ts' })
  expect(published.output).toBe('selected')
  expect(published.changedFiles).toEqual([])
  f.resolve({ result: { ...f.result, status: 'yielded' }, value: 1 })
  await f.handle.settled
  expect(f.state().status).toBe('completed')
  expect(f.state().receipt?.status).toBe('yielded')
  expect(published.status).toBe('running')
  expect(f.state().receipt).not.toBe(published)
  await f.handle.deliver(async () => {})
})

test('many delivered cells across worker incarnations retain zero large payloads and old selected output stays addressable', async () => {
  const { getSessionId } = await import('../bootstrap/state.js')
  const { TaskOutputTool } = await import('../tools/TaskOutputTool/TaskOutputTool.js')
  let state = getDefaultAppState()
  const setAppState = (update: (s: AppState) => AppState) => { state = update(state) }
  const sessionId = getSessionId()
  const bigAudit = 'PRIVATE_AUDIT_'.repeat(10_000)
  const selected = 'Selected result '.repeat(1000)
  const result: CodeModeResult = {
    kind: 'code-mode', cellId: 'cell', generation: 'generation', description: 'test',
    code: bigAudit, status: 'completed', output: selected,
    calls: [{ toolUseId: 'private-child', name: 'Read', input: bigAudit, result: bigAudit, status: 'completed' }],
    changedFiles: [{ path: 'selected.txt', additions: 1 }],
  }
  let finishRunning!: (value: { result: CodeModeResult; value: null }) => void
  const running = registerCodeModeTask({
    owner: { sessionId, agentId: 'live-worker', workerRunId: 'live-run' },
    cellId: 'cell', generation: 'generation', description: 'live', setAppState,
    completion: new Promise<{ result: CodeModeResult; value: null }>(resolve => { finishRunning = resolve }),
    cancel: () => {},
  })
  running.updateReceipt({ ...result, status: 'running' })
  const failedDelivery = registerCodeModeTask({
    owner: { sessionId, agentId: 'retry-worker', workerRunId: 'retry-run' },
    cellId: 'cell', generation: 'generation', description: 'retry', setAppState,
    completion: Promise.resolve({ result, value: null }), cancel: () => {},
  })
  await expect(failedDelivery.deliver(async () => { throw new Error('history unavailable') })).rejects.toThrow('history unavailable')
  const deliveredIds: string[] = []
  for (let i = 0; i < 48; i++) {
    const handle = registerCodeModeTask({
      owner: { sessionId, agentId: `worker-${i % 4}`, workerRunId: `incarnation-${i}` },
      cellId: 'cell', generation: 'generation', description: 'archived', setAppState,
      completion: Promise.resolve({ result, value: bigAudit }), cancel: () => {},
    })
    await handle.deliver(async outcome => { expect(outcome.result.calls[0]!.result).toBe(bigAudit) })
    deliveredIds.push(handle.taskId)
    expect(handle.getOutcome()).toBeUndefined()
    const tasks = Object.values(state.tasks) as CodeModeTaskState[]
    expect(tasks.filter(task => task.receipt !== undefined)).toHaveLength(2)
    const row = state.tasks[handle.taskId] as CodeModeTaskState
    expect(row.outputArchived).toBe(true)
    expect(JSON.stringify(row).length).toBeLessThan(1000)
  }
  expect((state.tasks[running.taskId] as CodeModeTaskState).settled).toBe(false)
  expect((state.tasks[failedDelivery.taskId] as CodeModeTaskState).receipt?.code).toBe(bigAudit)
  expect(failedDelivery.getOutcome()?.result.calls[0]!.result).toBe(bigAudit)
  const context = { getAppState: () => state, setAppState, abortController: new AbortController() }
  for (const block of [false, true]) {
    const read = await TaskOutputTool.call({ task_id: deliveredIds[0]!, block, timeout: 0 }, context as never, undefined as never, undefined as never)
    expect(read.data.retrieval_status).toBe('success')
    expect(JSON.parse(read.data.task!.output)).toMatchObject({
      output: selected, status: 'completed', delivery: 'delivered', partial: false,
      changedFiles: [{ path: 'selected.txt', additions: 1 }],
    })
    expect(read.data.task!.output).not.toContain('PRIVATE_AUDIT_')
  }
  finishRunning({ result, value: null })
  await running.deliver(async () => {})
  await failedDelivery.deliver(async () => {})
  expect((Object.values(state.tasks) as CodeModeTaskState[]).filter(task => task.receipt)).toHaveLength(0)
})

test('failed selected-output archival keeps the exact outcome owned and retryable', async () => {
  const { mkdir, rmdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  const f = fixture()
  f.resolve({ result: f.result, value: 9 })
  await f.handle.settled
  const path = f.state().outputFile
  await mkdir(dirname(path), { recursive: true })
  await mkdir(path)
  let accepted = 0
  try {
    await expect(f.handle.deliver(async () => { accepted++ })).rejects.toThrow()
    expect(f.state().delivery).toBe('failed')
    expect(f.state().outputArchived).not.toBe(true)
    expect(f.state().receipt?.output).toBe('selected')
    expect(f.handle.getOutcome()?.value).toBe(9)
    expect(accepted).toBe(1)
  } finally {
    await rmdir(path)
  }
  await f.handle.deliver(async () => { accepted++ })
  expect(accepted).toBe(1)
  expect(f.state().receipt).toBeUndefined()
  expect(f.handle.getOutcome()).toBeUndefined()
  expect(JSON.parse(await getTaskOutput(f.handle.taskId)).output).toBe('selected')
  await f.handle.deliver(async () => { throw new Error('must not redeliver') })
})

for (const kind of ['hardlink', 'symlink'] as const) {
  test(`archiving replaces a substituted ${kind} without modifying its unrelated target`, async () => {
    const { link, symlink, mkdir, mkdtemp, writeFile, readFile, stat, lstat, unlink, rmdir } = await import('node:fs/promises')
    const { dirname, join } = await import('node:path')
    const f = fixture()
    f.resolve({ result: f.result, value: 11 })
    await f.handle.settled
    const destination = f.state().outputFile
    await mkdir(dirname(destination), { recursive: true })
    const dir = await mkdtemp(join(dirname(destination), 'code-mode-archive-link-test-'))
    const target = join(dir, 'unrelated.txt')
    const original = 'Unrelated target must survive archive publication.\n'
    try {
      await writeFile(target, original, { flag: 'wx', mode: 0o600 })
      if (kind === 'hardlink') await link(target, destination)
      else await symlink(target, destination)
      expect(await readFile(destination, 'utf8')).toBe(original)
      await f.handle.deliver(async outcome => { expect(outcome.value).toBe(11) })
      expect(await readFile(target, 'utf8')).toBe(original)
      expect((await lstat(destination)).isSymbolicLink()).toBe(false)
      expect((await stat(destination)).ino).not.toBe((await stat(target)).ino)
      expect(JSON.parse(await getTaskOutput(f.handle.taskId)).output).toBe('selected')
      expect(f.state().delivery).toBe('delivered')
      expect(f.state().receipt).toBeUndefined()
    } finally {
      await unlink(target)
      await rmdir(dir)
    }
  })
}
