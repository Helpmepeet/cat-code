import type { ServerFrame, TaskSnapshotItem } from '../shared/protocol.js'
import type { HostEvent } from '../shared/hostApi.js'
import { SleepAssertionOwner } from '../shared/sleepAssertion.js'
import type { NativePowerObservation } from './powerObservation.js'
import { POWER_OBSERVATION_LIMITATIONS } from './powerObservation.js'

type Work = { turn: boolean; tasks: boolean; operational?: boolean }
const computing = (work: Work) => work.operational ?? (work.turn || work.tasks)

function taskComputing(task: TaskSnapshotItem): boolean {
  if (task.status !== 'running' && task.status !== 'pending') return false
  if (task.handoffStatus === 'blocked' || task.awaitingPlanApproval || task.isIdle ||
      task.ultraplanPhase === 'needs_input' || task.ultraplanPhase === 'plan_ready') return false
  // Persistent watchers are services, not finite operational work.
  return task.kind !== 'monitor' && task.type !== 'monitor_mcp'
}

/** The main process owns one idle assertion across all desktop engine sessions. */
export class DesktopPower {
  private readonly sessions = new Map<string, Work>()
  private active = false
  private disposed = false
  constructor(private readonly assertion: SleepAssertionOwner,
    private readonly observation: Pick<NativePowerObservation, 'setActive' | 'read'>,
    private readonly changed: (reason: 'work-started' | 'work-stopped') => void = () => {}) {}

  receive(sessionId: string, frame: ServerFrame): void {
    if (this.disposed) return
    if (frame.kind === 'lifecycle') {
      // Losing a socket does not prove that its engine stopped computing.
      if (frame.status !== 'disconnected') this.forget(sessionId)
      return
    }
    let turn: boolean | undefined
    let tasks: boolean | undefined
    if (frame.kind === 'ready') turn = frame.payload.activeTurn && frame.payload.pendingPermissionRequests.length === 0
    else if (frame.kind === 'activity') turn = frame.presence === 'running'
    else if (frame.kind === 'tasks.snapshot') tasks = frame.tasks.items.some(taskComputing)
    else if (frame.kind === 'event' && !frame.replay && frame.event.type === 'turn.status') turn = frame.event.activeTurn
    else return
    const current: Work = this.sessions.get(sessionId) ?? { turn: false, tasks: false }
    if (frame.kind === 'tasks.snapshot' && typeof frame.tasks.hasOperationalWork === 'boolean') current.operational = frame.tasks.hasOperationalWork
    if (turn !== undefined) current.turn = turn
    if (tasks !== undefined) current.tasks = tasks
    if (computing(current) || current.operational !== undefined) this.sessions.set(sessionId, current)
    else this.sessions.delete(sessionId)
    this.reconcile()
  }
  receiveHostEvent(event: HostEvent): void {
    if (this.disposed) return
    if (event.type === 'session-removed') this.forget(event.appSessionId)
    else if (event.type === 'session-status' && (event.session.status === 'exited' || event.session.status === 'spawning' || event.session.parked)) {
      this.forget(event.session.appSessionId)
    }
  }
  forget(sessionId: string): void { this.sessions.delete(sessionId); this.reconcile() }
  dispose(): void {
    this.disposed = true
    this.sessions.clear(); this.active = false
    this.assertion.forceStop(); this.observation.setActive(false)
  }
  read() {
    return { sessions: this.workCount(), assertion: this.assertion.read(), hardware: this.observation.read(),
      limitations: { ...POWER_OBSERVATION_LIMITATIONS } }
  }
  private reconcile(): void {
    const active = this.workCount() > 0
    if (active === this.active) return
    this.active = active
    if (active) this.assertion.start()
    else this.assertion.stop()
    this.observation.setActive(active)
    this.changed(active ? 'work-started' : 'work-stopped')
  }
  private workCount(): number { return [...this.sessions.values()].filter(computing).length }
}
