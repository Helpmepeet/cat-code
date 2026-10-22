import { randomUUID } from 'node:crypto'
import {
  isWorkStatusFrame,
  isWorkStatusRequest,
  type WorkStatusFrame,
  type WorkStatusRequest,
  type WorkStatusSummary,
} from '../shared/workStatus.js'

export const WORK_POLL_MS = 1000
export const WORK_REQUEST_TIMEOUT_MS = 2000
export const WORK_FRESHNESS_MS = 5000
export const WORK_COMPLETION_GRACE_MS = 2000
export const MAX_TRACKED_WORK_SESSIONS = 256

export type LidWorkAggregate = {
  availability: 'fresh' | 'unknown'
  hasUnfinishedWork: boolean
  activeSessions: number
  activeSubagents: number
  waitingForApproval: boolean
  revision: number
  supervisionLost: boolean
}

export type LidWorkSession = {
  sessionId: string
  generation: string
  status: 'spawning' | 'connecting' | 'ready' | 'disconnected' | 'failed' | 'exited' | 'parked'
  confirmedTerminal?: boolean
  neverStarted?: boolean
}

type Outstanding = { requestId: string; generation: string; sentAt: number; serial: number; activation: number; timer: unknown }
type SessionEvidence = {
  session: LidWorkSession
  introducedAt: number
  summary?: WorkStatusSummary
  receivedAt?: number
  acceptedSerial: number
  sequence: number
  outstanding?: Outstanding
  requiresPostAdmission: number
}
type TimerApi = {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(timer: unknown): void
}
type Dependencies = {
  listSessions(): LidWorkSession[]
  send(sessionId: string, message: WorkStatusRequest): void
  now(): number
  timers: TimerApi
  uuid(): string
}

const realTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: timer => clearInterval(timer as ReturnType<typeof setInterval>),
}

const terminal = (session: LidWorkSession) =>
  session.status === 'exited' || session.status === 'parked' ||
  session.confirmedTerminal === true || session.neverStarted === true

export class LidWorkObserver {
  private active = false
  private activation = 0
  private revision = 0
  private serial = 0
  private lost = false
  private records = new Map<string, SessionEvidence>()
  private listeners = new Set<(value: LidWorkAggregate) => void>()
  private poller: unknown
  private expirationTimers = new Map<string, unknown>()
  private refreshPromise: { activation: number; promise: Promise<LidWorkAggregate> } | null = null
  private verifyPromise: Promise<LidWorkAggregate> | null = null
  private barriers: Array<{ token: number; sessions: Map<string, number>; resolve: (value: LidWorkAggregate) => void }> = []
  private admissionTokens = new Map<string, { sessionId: string; generation: string; serial: number }>()
  private admissionCounter = 0
  private overflow = false
  private overflowSince?: number
  private overflowTimer: unknown
  private enumerationUnavailable = false
  private workspaceTransitions = new Set<string>()
  private supervising = false
  private probePromise?: Promise<LidWorkAggregate>

  constructor(private readonly deps: Partial<Dependencies> & Pick<Dependencies, 'listSessions' | 'send'>) {}

  async start(): Promise<LidWorkAggregate> {
    this.supervising = true
    if (this.active) {
      this.armPolling()
      return this.verify()
    }
    this.activate()
    this.armPolling()
    await this.verify()
    return this.read()
  }

  probe(): Promise<LidWorkAggregate> {
    if (this.probePromise) return this.probePromise
    const owned = !this.active
    if (owned) this.activate()
    const activation = this.activation
    const promise = this.verify().finally(() => {
      if (owned && !this.supervising && this.activation === activation) this.stop()
      if (this.probePromise === promise) this.probePromise = undefined
    })
    this.probePromise = promise
    return promise
  }

  private armPolling(): void {
    if (this.poller === undefined) this.poller = this.timers.setInterval(() => { void this.refresh() }, WORK_POLL_MS)
  }

  private activate(): void {
    this.active = true
    this.activation++
    this.lost = false
    this.records.clear()
    this.admissionTokens.clear()
    this.syncSessions()
    this.scheduleExpirations()
  }

  read(): LidWorkAggregate {
    if (!this.active) return this.aggregate('unknown', false)
    this.checkDeadlines()
    this.syncSessions()
    this.scheduleExpirations()
    const candidates = [...this.records.values()]
    const fresh = !this.lost && !this.overflow && !this.enumerationUnavailable &&
      this.workspaceTransitions.size === 0 &&
      this.admissionTokens.size === 0 && candidates.every(record =>
      record.session.status === 'ready' &&
      record.summary !== undefined &&
      this.now() < (record.receivedAt ?? record.introducedAt) + WORK_FRESHNESS_MS &&
      record.acceptedSerial >= record.requiresPostAdmission)
    const unfinished = candidates.filter(record => record.summary?.hasUnfinishedWork)
    return {
      availability: fresh ? 'fresh' : 'unknown',
      hasUnfinishedWork: unfinished.length > 0,
      activeSessions: unfinished.length,
      activeSubagents: unfinished.reduce((sum, record) => sum + (record.summary?.activeSubagents ?? 0), 0),
      waitingForApproval: unfinished.some(record => record.summary?.waitingForApproval === true),
      revision: this.revision,
      supervisionLost: this.lost,
    }
  }

  async refresh(): Promise<LidWorkAggregate> {
    if (!this.active) return this.read()
    if (this.refreshPromise?.activation === this.activation) return this.refreshPromise.promise
    const activation = this.activation
    const promise = (async () => {
      this.checkDeadlines()
      const revision = this.revision
      this.syncSessions()
      this.scheduleExpirations()
      if (revision !== this.revision) this.notify()
      for (const record of this.records.values()) this.issue(record, activation)
      return this.read()
    })().finally(() => {
      if (this.refreshPromise?.promise === promise) this.refreshPromise = null
    })
    this.refreshPromise = { activation, promise }
    return promise
  }

  async verify(): Promise<LidWorkAggregate> {
    if (!this.active) return this.read()
    if (this.verifyPromise) return this.verifyPromise
    const activation = this.activation
    this.checkDeadlines()
    const revision = this.revision
    this.syncSessions()
    if (revision !== this.revision) this.notify()
    const token = ++this.serial
    const candidates = new Map([...this.records.keys()].map(sessionId => [sessionId, token]))
    let timeout: unknown
    const result = new Promise<LidWorkAggregate>(resolve => {
      this.barriers.push({ token, sessions: candidates, resolve })
      for (const record of this.records.values()) {
        if (!record.outstanding) this.issue(record, activation, token)
      }
      if (candidates.size === 0) resolve(this.read())
      timeout = this.timers.setTimeout(() => {
        const barrier = this.barriers.find(item => item.token === token)
        if (barrier) {
          this.barriers = this.barriers.filter(item => item !== barrier)
          resolve({ ...this.read(), availability: 'unknown' })
        }
      }, WORK_REQUEST_TIMEOUT_MS * 2)
    })
    let wrapped: Promise<LidWorkAggregate>
    wrapped = result.finally(() => {
      if (timeout !== undefined) this.timers.clearTimeout(timeout)
      if (this.verifyPromise === wrapped) this.verifyPromise = null
    })
    this.verifyPromise = wrapped
    return wrapped
  }

  handleFrame(frame: unknown, routedSessionId?: string): void {
    this.checkDeadlines()
    if (!this.active || !isWorkStatusFrame(frame)) return
    const value = frame as WorkStatusFrame
    const record = this.records.get(value.sessionId)
    const outstanding = record?.outstanding
    if (!record || !outstanding || outstanding.activation !== this.activation || value.sessionId !== routedSessionId ||
        value.requestId !== outstanding.requestId || value.generation !== outstanding.generation ||
        value.generation !== record.session.generation || value.sequence <= record.sequence) return
    this.timers.clearTimeout(outstanding.timer)
    record.outstanding = undefined
    if (this.lost) {
      record.sequence = value.sequence
      record.summary = value.work
      record.receivedAt = this.now()
      this.notify()
      return
    }
    if (!value.work.available) {
      if (record.summary !== undefined) this.revision++
      record.summary = undefined
      this.notify()
      this.resolveBarriers()
      this.scheduleExpirations()
      return
    }
    const serial = outstanding.serial
    for (const barrier of this.barriers) {
      const minimumSerial = barrier.sessions.get(value.sessionId)
      if (minimumSerial !== undefined && serial < minimumSerial) {
        this.issue(record, this.activation, barrier.token)
      }
    }
    if (!value.work.hasUnfinishedWork && serial <= record.requiresPostAdmission) {
      record.summary = undefined
      this.notify()
      return
    }
    const changed = !record.summary || JSON.stringify(record.summary) !== JSON.stringify(value.work)
    record.summary = value.work
    record.sequence = value.sequence
    record.receivedAt = this.now()
    record.acceptedSerial = serial
    if (changed) this.revision++
    this.scheduleExpirations()
    this.notify()
    this.resolveBarriers()
  }

  handleError(frame: unknown, routedSessionId: string): boolean {
    this.checkDeadlines()
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return false
    const value = frame as { kind?: unknown; sessionId?: unknown; requestId?: unknown }
    if (value.kind !== 'error' || value.sessionId !== routedSessionId ||
        typeof value.requestId !== 'string') return false
    const record = this.records.get(routedSessionId)
    const outstanding = record?.outstanding
    if (!record || !outstanding || outstanding.activation !== this.activation ||
        outstanding.requestId !== value.requestId) return false
    this.timers.clearTimeout(outstanding.timer)
    record.outstanding = undefined
    if (record.summary !== undefined) this.revision++
    record.summary = undefined
    this.notify()
    this.resolveBarriers()
    return true
  }

  onSessionsChanged(): void {
    this.checkDeadlines()
    if (!this.active) return
    this.syncSessions()
    this.scheduleExpirations()
    for (const barrier of this.barriers) {
      for (const sessionId of this.records.keys()) {
        if (!barrier.sessions.has(sessionId)) barrier.sessions.set(sessionId, barrier.token)
      }
      for (const sessionId of [...barrier.sessions.keys()]) {
        if (!this.records.has(sessionId)) barrier.sessions.delete(sessionId)
      }
      for (const record of this.records.values()) this.issue(record, this.activation, barrier.token)
    }
    this.notify()
    this.resolveBarriers()
  }

  loseSupervision(): void {
    this.checkDeadlines()
    if (!this.active || this.lost) return
    this.lost = true
    this.revision++
    this.notify()
  }

  onFrame = (frame: unknown, sessionId?: string) => this.handleFrame(frame, sessionId)

  onLifecycle(session: LidWorkSession): void {
    this.checkDeadlines()
    if (terminal(session)) {
      const removed = this.records.get(session.sessionId)
      if (removed?.outstanding) this.timers.clearTimeout(removed.outstanding.timer)
      const recordRemoved = this.records.delete(session.sessionId)
      if (recordRemoved) this.revision++
    }
    else {
      const current = this.records.get(session.sessionId)
      if (!current || current.session.generation !== session.generation) {
        if (current?.outstanding) this.timers.clearTimeout(current.outstanding.timer)
        this.records.set(session.sessionId, {
          session, introducedAt: this.now(), acceptedSerial: 0, sequence: 0,
          requiresPostAdmission: 0,
        })
        this.revision++
      } else {
        if (current.session.status !== session.status) {
          current.summary = undefined
          this.revision++
        }
        current.session = session
      }
    }
    if (this.records.size > MAX_TRACKED_WORK_SESSIONS) {
      for (const record of this.records.values()) {
        if (record.outstanding) this.timers.clearTimeout(record.outstanding.timer)
      }
      this.records.clear()
      this.overflow = true
      this.revision++
    }
    this.scheduleExpirations()
    this.notify()
    this.resolveBarriers()
    void this.refresh()
  }

  onWorkChanged(sessionId?: string): void {
    this.checkDeadlines()
    if (!this.active) return
    if (sessionId) {
      const record = this.records.get(sessionId)
      if (record && !record.summary?.hasUnfinishedWork) record.summary = undefined
    }
    this.revision++
    this.notify()
    void this.refresh()
  }

  beginWorkspaceTransition(sessionId: string, transitionId = 'default'): void {
    this.checkDeadlines()
    const key = `${sessionId}\u0000${transitionId}`
    if (this.workspaceTransitions.has(key)) return
    this.workspaceTransitions.add(key)
    const record = this.records.get(sessionId)
    if (record) record.summary = undefined
    this.revision++
    this.notify()
  }

  endWorkspaceTransition(sessionId: string, transitionId = 'default'): void {
    this.checkDeadlines()
    const key = `${sessionId}\u0000${transitionId}`
    if (!this.workspaceTransitions.delete(key)) return
    const record = this.records.get(sessionId)
    if (record) record.summary = undefined
    this.revision++
    this.notify()
    void this.refresh()
  }

  endPeerWorkspaceTransitions(sessionId: string): void {
    this.checkDeadlines()
    const prefix = `${sessionId}\u0000peer:`
    let changed = false
    for (const key of this.workspaceTransitions) {
      if (key.startsWith(prefix)) changed = this.workspaceTransitions.delete(key) || changed
    }
    if (!changed) return
    const record = this.records.get(sessionId)
    if (record) record.summary = undefined
    this.revision++
    this.notify()
    void this.refresh()
  }

  beginAdmission(sessionId: string): string {
    this.checkDeadlines()
    const record = this.records.get(sessionId)
    const token = `${this.activation}:${++this.admissionCounter}`
    this.revision++
    if (record) record.summary = undefined
    this.admissionTokens.set(token, {
      sessionId,
      generation: record?.session.generation ?? '',
      serial: this.serial,
    })
    this.notify()
    return token
  }

  finishAdmission(token: string, sent: boolean): void {
    this.checkDeadlines()
    const admission = this.admissionTokens.get(token)
    if (!admission) return
    this.admissionTokens.delete(token)
    const record = this.records.get(admission.sessionId)
    if (sent && record && record.session.generation === admission.generation) {
      record.requiresPostAdmission = Math.max(record.requiresPostAdmission, this.serial)
      record.summary = undefined
    } else if (sent) {
      this.onSessionsChanged()
    }
    this.notify()
    void this.refresh()
  }

  subscribe(listener: (value: LidWorkAggregate) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  stop(): void {
    this.supervising = false
    if (!this.active) return
    this.active = false
    this.activation++
    if (this.poller !== undefined) this.timers.clearInterval(this.poller)
    this.poller = undefined
    for (const record of this.records.values()) {
      if (record.outstanding) this.timers.clearTimeout(record.outstanding.timer)
    }
    for (const timer of this.expirationTimers.values()) this.timers.clearTimeout(timer)
    this.expirationTimers.clear()
    if (this.overflowTimer !== undefined) this.timers.clearTimeout(this.overflowTimer)
    this.overflowTimer = undefined
    this.records.clear()
    this.overflow = false
    this.overflowSince = undefined
    this.refreshPromise = null
    this.verifyPromise = null
    this.admissionTokens.clear()
    const pending = this.barriers
    this.barriers = []
    for (const barrier of pending) barrier.resolve(this.read())
  }

  private get timers(): TimerApi { return this.deps.timers ?? realTimers }
  private now(): number { return this.deps.now?.() ?? performance.now() }
  private uuid(): string { return this.deps.uuid?.() ?? randomUUID() }

  private syncSessions(): void {
    let current: LidWorkSession[]
    try {
      current = this.deps.listSessions().filter(session => !terminal(session))
      if (this.enumerationUnavailable) this.revision++
      this.enumerationUnavailable = false
    } catch {
      if (!this.enumerationUnavailable) this.revision++
      this.enumerationUnavailable = true
      return
    }
    if (current.length > MAX_TRACKED_WORK_SESSIONS) {
      const changed = !this.overflow || this.records.size > 0
      if (!this.overflow) this.overflowSince = this.now()
      for (const record of this.records.values()) {
        if (record.outstanding) this.timers.clearTimeout(record.outstanding.timer)
      }
      this.records.clear()
      this.overflow = true
      if (changed) this.revision++
      return
    }
    if (this.overflow) {
      this.overflowSince = undefined
      this.revision++
    }
    this.overflow = false
    const next = new Map<string, SessionEvidence>()
    const timestamp = this.now()
    for (const session of current) {
      const key = session.sessionId
      const prior = this.records.get(key)
      if (prior?.session.generation === session.generation) {
        if (prior.session.status !== session.status) {
          prior.summary = undefined
          this.revision++
        }
        prior.session = session
        next.set(key, prior)
      } else {
        if (prior?.outstanding) this.timers.clearTimeout(prior.outstanding.timer)
        next.set(key, {
          session, introducedAt: timestamp, acceptedSerial: 0, sequence: 0, requiresPostAdmission: 0,
        })
        this.revision++
      }
    }
    if (next.size !== this.records.size ||
        [...this.records.keys()].some(key => !next.has(key))) this.revision++
    for (const [key, record] of this.records) {
      if (!next.has(key) && record.outstanding) this.timers.clearTimeout(record.outstanding.timer)
    }
    this.records = next
  }

  private issue(record: SessionEvidence, activation: number, barrierToken?: number): void {
    if (!this.active || activation !== this.activation || record.session.status !== 'ready' || record.outstanding) return
    const requestId = this.uuid()
    const request: WorkStatusRequest = {
      type: 'work.status', requestId, forGeneration: record.session.generation,
    }
    if (!isWorkStatusRequest(request)) {
      if (record.summary !== undefined) {
        record.summary = undefined
        this.revision++
      }
      this.notify()
      return
    }
    const serial = ++this.serial
    const outstanding: Outstanding = {
      requestId, generation: record.session.generation, sentAt: this.now(),
      serial, activation, timer: undefined,
    }
    outstanding.timer = this.timers.setTimeout(() => {
      if (record.outstanding !== outstanding || activation !== this.activation) return
      record.outstanding = undefined
      if (record.summary !== undefined) this.revision++
      record.summary = undefined
      this.notify()
      this.resolveBarriers()
    }, WORK_REQUEST_TIMEOUT_MS)
    record.outstanding = outstanding
    try {
      this.deps.send(record.session.sessionId, request)
    } catch {
      this.timers.clearTimeout(outstanding.timer)
      record.outstanding = undefined
      if (record.summary !== undefined) this.revision++
      record.summary = undefined
    }
    if (barrierToken !== undefined) {
      const barrier = this.barriers.find(item => item.token === barrierToken)
      if (barrier) barrier.sessions.set(record.session.sessionId, barrier.token)
    }
  }

  private checkDeadlines(): void {
    if (!this.active || this.lost) return
    const now = this.now()
    if (this.overflow && this.overflowSince !== undefined &&
        now >= this.overflowSince + WORK_FRESHNESS_MS) {
      this.lost = true
      this.revision++
      this.notify()
      return
    }
    for (const record of this.records.values()) {
      if (now >= (record.receivedAt ?? record.introducedAt) + WORK_FRESHNESS_MS) {
        this.lost = true
        this.revision++
        this.notify()
        return
      }
    }
  }

  private scheduleExpirations(): void {
    for (const timer of this.expirationTimers.values()) this.timers.clearTimeout(timer)
    this.expirationTimers.clear()
    if (this.overflowTimer !== undefined) this.timers.clearTimeout(this.overflowTimer)
    this.overflowTimer = undefined
    if (!this.active || this.lost) return
    if (this.overflow && this.overflowSince !== undefined) {
      this.overflowTimer = this.timers.setTimeout(() => {
        this.overflowTimer = undefined
        this.checkDeadlines()
      }, Math.max(0, this.overflowSince + WORK_FRESHNESS_MS - this.now()))
    }
    for (const [key, record] of this.records) {
      const deadline = (record.receivedAt ?? record.introducedAt) + WORK_FRESHNESS_MS
      this.expirationTimers.set(key, this.timers.setTimeout(() => {
        this.expirationTimers.delete(key)
        this.checkDeadlines()
      }, Math.max(0, deadline - this.now())))
    }
  }

  private resolveBarriers(): void {
    for (const barrier of [...this.barriers]) {
      const done = !this.overflow && !this.enumerationUnavailable &&
        this.workspaceTransitions.size === 0 &&
        [...this.records.entries()].every(([sessionId, record]) =>
        record.acceptedSerial >= (barrier.sessions.get(sessionId) ?? barrier.token) &&
        record.summary !== undefined && record.session.status === 'ready')
      if (done) {
        this.barriers = this.barriers.filter(item => item !== barrier)
        barrier.resolve(this.read())
      }
    }
  }

  private aggregate(availability: 'fresh' | 'unknown', hasUnfinishedWork: boolean): LidWorkAggregate {
    return {
      availability, hasUnfinishedWork,
      activeSessions: 0, activeSubagents: 0, waitingForApproval: false,
      revision: this.revision, supervisionLost: this.lost,
    }
  }

  private notify(): void {
    const value = this.read()
    for (const listener of this.listeners) listener(value)
  }
}
