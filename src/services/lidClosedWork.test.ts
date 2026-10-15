import { expect, test } from 'bun:test'
import { AppSessionController } from '../app-runtime/AppSessionController.js'
import type { TaskState } from '../tasks/types.js'
import { createTaskStateBase } from '../Task.js'
import { execFileSync } from 'node:child_process'
import { startPreventSleep, stopPreventSleep, forceStopPreventSleep, setPreventSleepSuppressed } from './preventSleep.js'
import {
  installLidWorkRuntime, lidWorkContext,
  registerLidShellTool, registerLidWorkTask, withLidWorkRun,
} from './lidClosedWork.js'

function gate() {
  let open!: () => void
  const wait = new Promise<void>(resolve => { open = resolve })
  return { wait, open }
}

test('real controller turns retain asynchronous descendants without enrolling a later turn', async () => {
  const tasks: Record<string, TaskState> = {}
  const runtime = installLidWorkRuntime(() => tasks)
  const finish = gate(); const createChild = gate(); const readEnded = gate()
  let descendant!: Promise<[string | undefined, string | undefined]>
  let unrelatedContext: string | undefined
  const controller = new AppSessionController({
    async *runTurn() {
      descendant = (async () => {
        await createChild.wait
        registerLidShellTool('build', true)
        const child = { ...createTaskStateBase('build-1', 'local_bash', 'Build', 'build'),
          type: 'local_bash' as const, status: 'running' as const, command: 'build',
          shellCommand: null, completionStatusSentInAttachment: false, lastReportedTotalLines: 0,
          isBackgrounded: true }
        tasks[child.id] = child
        registerLidWorkTask(child)
        const active = lidWorkContext()
        await readEnded.wait
        return [active, lidWorkContext()]
      })()
      await finish.wait
      yield { type: 'assistant' as const, message: { content: [] } }
    },
  })
  try {
    const turn = controller.submit('Build')
    await Promise.resolve()
    const original = runtime.snapshot().runs[0]!
    expect(original.status).toBe('running')
    runtime.update({ identity: 'lease', roots: [original.id], active: true,
      deadline: Date.now() + 60_000, lidClosed: false, block: false, suppressIdleSleep: false })
    finish.open(); await turn
    await withLidWorkRun(async () => { unrelatedContext = lidWorkContext(); createChild.open(); await Promise.resolve() })
    expect(unrelatedContext).toBeUndefined()
    const scope = runtime.snapshot().runs.find(run => run.id === original.id)!
    expect(scope.status).toBe('running')
    expect(scope.children.map(child => child.id)).toEqual(['build-1'])
    runtime.update({ identity: 'lease', roots: [original.id], active: false,
      deadline: Date.now() + 60_000, lidClosed: false, block: false, suppressIdleSleep: false })
    readEnded.open()
    const [active, ended] = await descendant
    expect(active).toContain('existing instructions and permissions')
    expect(ended).toContain('no longer applies')
    expect(runtime.snapshot().runs.filter(run => run.id !== original.id).every(run => run.children.length === 0)).toBe(true)
  } finally { finish.open(); createChild.open(); readEnded.open(); runtime.dispose() }
})

test('mode ending leaves a real pending permission unanswered and service tasks do not keep a finished run alive', async () => {
  const tasks: Record<string, TaskState> = {}
  const runtime = installLidWorkRuntime(() => tasks)
  let reachedPermission = false
  const controller = new AppSessionController({ async *runTurn({ onPermissionRequest }) {
    registerLidShellTool('server', false)
    const service = { ...createTaskStateBase('server-1', 'local_bash', 'Server', 'server'),
      type: 'local_bash' as const, status: 'running' as const, command: 'server', shellCommand: null,
      completionStatusSentInAttachment: false, lastReportedTotalLines: 0, isBackgrounded: true }
    tasks[service.id] = service; registerLidWorkTask(service)
    reachedPermission = true
    await onPermissionRequest({ requestId: 'approval-1', request: {
      subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'build' }, tool_use_id: 'tool-1',
    } })
    yield { type: 'assistant' as const, message: { content: [] } }
  } })
  try {
    const turn = controller.submit('Build')
    for (let i = 0; !reachedPermission && i < 10; i++) await Promise.resolve()
    const run = runtime.snapshot().runs[0]!
    expect(run.status).toBe('approval')
    runtime.update({ identity: 'lease', roots: [run.id], active: false,
      deadline: Date.now(), lidClosed: true, block: true, suppressIdleSleep: false })
    expect(controller.getPendingPermissionRequests().map(request => request.requestId)).toEqual(['approval-1'])
    controller.respondToPermissionRequest('approval-1', { behavior: 'deny', message: 'User declined' })
    await turn
    expect(runtime.snapshot().runs[0]!.status).toBe('completed')
    expect(runtime.snapshot().runs[0]!.children).toEqual([])
  } finally { controller.respondToPermissionRequest('approval-1', { behavior: 'deny', message: 'Test cleanup' }); runtime.dispose() }
})

// The process boundary matters: a retained refcount must not recreate an idle
// assertion after a protective ending, or suppress a later explicit user run.
;(process.platform === 'darwin' ? test : test.skip)('protective ending retires its caffeinate child and a new user turn restores ordinary idle policy', async () => {
  const runtime = installLidWorkRuntime(() => ({}))
  const children = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .split('\n').filter(line => {
      const row = line.trim().split(/\s+/)
      return Number(row[1]) === process.pid && row.slice(2).join(' ').split('/').at(-1) === 'caffeinate'
    })
  const until = async (count: number) => {
    for (let i = 0; i < 50; i++) { if (children().length === count) break; await Bun.sleep(20) }
    expect(children()).toHaveLength(count)
  }
  try {
    startPreventSleep(); await until(1)
    await withLidWorkRun(async () => {
      const original = runtime.snapshot().runs[0]!
      runtime.update({ identity: 'protective-end', roots: [original.id], active: false,
        deadline: Date.now(), lidClosed: true, block: true, suppressIdleSleep: true })
      await until(0)
    })
    await withLidWorkRun(async () => { await until(1); stopPreventSleep(); await until(0) })
  } finally { forceStopPreventSleep(); setPreventSleepSuppressed(false); runtime.dispose() }
})
