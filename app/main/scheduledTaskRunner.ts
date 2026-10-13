import type { Host } from '../host/host.js'
import type { SidecarSupervisor } from '../supervisor/supervisor.js'
import type { ScheduledTask } from '../shared/scheduledTasks.js'
import type { SessionRegistry } from '../host/registry.js'

/** Subscribe before spawn: readiness can arrive before createSession resolves. No new engine runner or permission path. */
export async function launchScheduledSession(host: Host, supervisor: SidecarSupervisor, task: ScheduledTask, appSessionId: string, registry: SessionRegistry): Promise<void | false> {
  let unsubscribe = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectReady: (error: Error) => void = () => {}
  const ready = new Promise<string>((resolve, reject) => {
    rejectReady = reject
    unsubscribe = supervisor.subscribe(event => {
      if (event.sessionId !== appSessionId) return
      if (event.type === 'frame' && event.frame.kind === 'ready') resolve(event.frame.engineSessionId)
      if (event.type === 'status' && ['exited', 'failed', 'disconnected'].includes(event.status)) reject(new Error('The scheduled chat disconnected before it was ready'))
    })
    timer = setTimeout(() => reject(new Error('The scheduled chat did not become ready. Open it to review.')), 30_000)
  })
  // Observe a readiness rejection even while createSession is pending.
  void ready.catch(() => {})
  try {
    const created = await host.createSession({ cwd: task.cwd, title: task.name, appSessionId,
      ...(task.model ? { model: task.model } : {}), ...(task.effort !== 'default' ? { effort: task.effort } : {}), permissionMode: task.permissionMode })
    if (!created.ok) {
      rejectReady(new Error(created.error.message))
      if (created.error.code === 'session_limit' || created.error.code === 'branch_unavailable') return false
      throw new Error(created.error.message)
    }
    const engineSessionId = await ready
    // Ready reaches listeners before Host's asynchronous, nonthrowing registry write settles.
    await registry.fillEngineSessionId(appSessionId, engineSessionId)
    const row = registry.findSession(appSessionId)
    if (registry.lastWriteFailed || row?.engineSessionId !== engineSessionId || row.cwd !== created.value.cwd) throw new Error('The scheduled chat could not be saved. No scheduled prompt was sent.')
  } finally { if (timer) clearTimeout(timer); unsubscribe() }
}
