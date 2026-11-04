import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import type { LidModeView } from '../shared/lidClosed.js'
import type { OperationalEvent, OperationalFields, OperationalLogLevel } from '../shared/operationalLog.js'
import type { LidNativeReply } from './lidClosedNative.js'

// Diagnostics for lid-closed runs. The root helper ends a run when the app's
// heartbeat is quiet for five seconds, and the 2026-11-03 run ended that way
// with nothing in the app logs to say which link went quiet: the app timer,
// main's event loop, the bridge process, or the helper. Every heartbeat goes
// into an in-memory ring that is written only when a run ends abnormally, so
// the log keeps per-second detail around a failure without per-second lines.

export type LidTraceWrite = (event: OperationalEvent, level: OperationalLogLevel, fields: OperationalFields, appSessionId?: string) => void
export type LidTickKind = 'run' | 'skip-ticking' | 'skip-busy'
export type LidBridgePhase = 'spawned' | 'closing' | 'exited' | 'close-confirmed' | 'close-unconfirmed' | 'spawn-failed'
export type LidWorkLoss = { reason: 'stale-session' | 'overflow'; sessionId?: string; ageMs: number; status?: string; awaitingReply: boolean; sessions: number }

const HEARTBEAT_OPS = new Set(['pulse', 'renew-work'])
const NORMAL_ENDINGS = new Set(['stopped', 'work-finished', 'sleep-requested', 'expired', 'no-work'])
const RING_SIZE = 48
const SAMPLE_BYTES = 480
const SUMMARY_MS = 30_000
const SLOW_MS = 500
const COMMAND_LOG_BUDGET = 30
const BUDGET_WINDOW_MS = 60_000

type Beat = { gapMs: number; latencyMs: number; mark: string; firedAt: number }

export class LidTrace {
  private lastFire?: number
  private ring: Beat[] = []
  private pendingBeat?: Beat
  private activeSince?: number
  private dumped = false
  private lastKey = ''
  private phase: LidModeView['phase'] = 'off'
  private mode: LidModeView['mode'] = null
  private sessions = 0
  private summaryTimer?: ReturnType<typeof setInterval>
  private lag?: IntervalHistogram
  private window = { ok: 0, missed: 0, skipped: 0, maxLatency: 0, maxGap: 0 }
  private budget = { since: 0, used: 0, suppressed: 0 }

  constructor(private readonly write: LidTraceWrite, private readonly now: () => number = () => performance.now()) {}

  private get running(): boolean { return this.activeSince !== undefined }
  private age(): number { return this.activeSince === undefined ? 0 : Math.round(this.now() - this.activeSince) }

  view(v: LidModeView): void {
    this.phase = v.phase
    this.mode = v.mode
    this.sessions = v.activeSessions
    if (!this.running && ['starting', 'setup', 'active'].includes(v.phase)) this.begin()
    const abnormal = (v.phase === 'ended' || v.phase === 'unresolved' || v.phase === 'restoring') &&
      (!!v.error || (!!v.reason && !NORMAL_ENDINGS.has(v.reason)))
    const key = [v.phase, v.mode, v.reason, v.error, v.recovering, v.repairRequired].join('|')
    if (key !== this.lastKey) {
      this.lastKey = key
      this.write('lid.mode.changed', abnormal || v.phase === 'unavailable' ? 'warn' : 'info', {
        phase: v.phase, kind: v.mode ?? 'none', reason: v.reason ?? null, error: v.error ?? null,
        outcome: v.repairRequired ? 'repair-required' : v.recovering ? 'recovering' : null,
        count: v.allowance, sessions: v.activeSessions, elapsedMs: this.age(),
      })
    }
    if (abnormal) this.dump(v.reason ?? 'error')
    if (this.running && ['off', 'ended', 'unavailable'].includes(v.phase)) this.finish()
  }

  tick(kind: LidTickKind): void {
    const at = this.now()
    const gapMs = this.lastFire === undefined ? 0 : Math.round(at - this.lastFire)
    this.lastFire = at
    if (!this.running || this.phase !== 'active') return
    this.window.maxGap = Math.max(this.window.maxGap, gapMs)
    if (kind !== 'run') {
      this.window.skipped++
      this.push({ gapMs, latencyMs: 0, mark: kind === 'skip-busy' ? 'b' : 'k', firedAt: at })
      return
    }
    // A tick runs only after the previous one returned, so a heartbeat still
    // unanswered here was never sent.
    if (this.pendingBeat?.mark === '?') this.pendingBeat.mark = 'n'
    this.pendingBeat = { gapMs, latencyMs: 0, mark: '?', firedAt: at }
    this.push(this.pendingBeat)
  }

  command(op: string, queueMs: number, durationMs: number, outcome: string, reply?: LidNativeReply, pid?: number): void {
    const heartbeat = HEARTBEAT_OPS.has(op)
    // From the timer firing to the helper's reply, including any wait behind
    // another lid transition, which the bridge's own queue time cannot see.
    let latencyMs = queueMs + durationMs
    if (heartbeat && this.running) {
      if (outcome === 'ok') this.window.ok++
      else this.window.missed++
      const beat = this.pendingBeat
      if (beat) {
        latencyMs = Math.max(latencyMs, this.now() - beat.firedAt)
        beat.latencyMs = Math.round(latencyMs)
        beat.mark = outcome === 'ok' ? 'o' : outcome === 'refused' ? 'r' : outcome === 'timeout' ? 't' : outcome === 'unavailable' ? 'u' : 'i'
        this.pendingBeat = undefined
      }
      this.window.maxLatency = Math.max(this.window.maxLatency, latencyMs)
    }
    if (heartbeat && outcome === 'ok' && latencyMs < SLOW_MS) return
    if (!this.spend()) return
    const record = reply?.snapshot?.record
    const pulses = record as { clientPulse?: unknown; helperPulse?: unknown; began?: unknown } | undefined
    const seconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
    const client = seconds(pulses?.clientPulse); const helper = seconds(pulses?.helperPulse); const began = seconds(pulses?.began)
    this.write('lid.native.command', outcome === 'ok' ? 'info' : 'warn', {
      kind: op, outcome, code: reply?.error ?? reply?.snapshot?.error ?? null,
      durationMs: Math.round(durationMs), queueMs: Math.round(Math.max(queueMs, latencyMs - durationMs)),
      phase: record?.phase ?? null, reason: record?.reason ?? null,
      // The helper's own record of how stale the app's heartbeat was when it
      // last acted, and how long the run had lasted by its clock.
      gapMs: client !== undefined && helper !== undefined ? Math.round((helper - client) * 1000) : null,
      ageMs: began !== undefined && helper !== undefined && began > 0 ? Math.round((helper - began) * 1000) : null,
      pid: pid ?? null,
    })
  }

  bridge(phase: LidBridgePhase, fields: { reason?: string; pid?: number; exitCode?: number | null; signal?: string | null; durationMs?: number } = {}): void {
    if (!this.spend()) return
    const unexpected = phase === 'exited' && this.running || phase === 'close-unconfirmed' || phase === 'spawn-failed' ||
      phase === 'closing' && fields.reason !== 'requested' && fields.reason !== 'shutdown'
    this.write('lid.bridge.changed', unexpected ? 'warn' : 'info', {
      phase, reason: fields.reason ?? null, pid: fields.pid ?? null,
      exitCode: fields.exitCode ?? null, signal: fields.signal ?? null,
      durationMs: fields.durationMs === undefined ? null : Math.round(fields.durationMs),
    })
  }

  failure(site: string, error: unknown): void {
    if (!this.spend()) return
    this.write('lid.failure', 'warn', {
      reason: site, error: error instanceof Error ? error.message : String(error),
      phase: this.phase, kind: this.mode ?? 'none', elapsedMs: this.age(),
    })
  }

  workLost(loss: LidWorkLoss): void {
    if (!this.running) return
    this.write('lid.work.lost', 'warn', {
      reason: loss.reason, ageMs: Math.round(loss.ageMs), phase: loss.status ?? null,
      outcome: loss.awaitingReply ? 'awaiting-reply' : 'no-request', sessions: loss.sessions,
    }, loss.sessionId)
  }

  power(reason: string): void {
    this.write('lid.power.event', 'info', { reason, phase: this.phase, elapsedMs: this.age() })
  }

  private begin(): void {
    this.activeSince = this.now()
    this.dumped = false
    this.ring = []
    this.pendingBeat = undefined
    this.window = { ok: 0, missed: 0, skipped: 0, maxLatency: 0, maxGap: 0 }
    try {
      this.lag = monitorEventLoopDelay({ resolution: 20 })
      this.lag.enable()
    } catch { this.lag = undefined }
    this.summaryTimer = setInterval(() => this.summary(), SUMMARY_MS)
    this.summaryTimer.unref?.()
  }

  private finish(): void {
    this.summary()
    if (this.summaryTimer) clearInterval(this.summaryTimer)
    this.summaryTimer = undefined
    this.lag?.disable()
    this.lag = undefined
    this.activeSince = undefined
    this.pendingBeat = undefined
  }

  private lagMs(): number | null {
    if (!this.lag) return null
    const max = this.lag.max
    return Number.isFinite(max) && max > 0 ? Math.round(max / 1e6) : 0
  }

  private summary(): void {
    if (!this.running) return
    const w = this.window
    const quiet = w.missed === 0 && w.skipped === 0 && w.maxGap < 1500 && w.maxLatency < SLOW_MS
    this.write('lid.heartbeat.summary', quiet ? 'info' : 'warn', {
      kind: this.mode ?? 'none', phase: this.phase, count: w.ok, missed: w.missed, skipped: w.skipped,
      maxMs: Math.round(w.maxLatency), gapMs: w.maxGap, eventLoopLagMs: this.lagMs(),
      sessions: this.sessions, elapsedMs: this.age(), suppressed: this.budget.suppressed,
    })
    this.window = { ok: 0, missed: 0, skipped: 0, maxLatency: 0, maxGap: 0 }
    this.budget.suppressed = 0
    this.lag?.reset()
  }

  private push(beat: Beat): void {
    this.ring.push(beat)
    if (this.ring.length > RING_SIZE) this.ring.shift()
  }

  // Entries run oldest to newest as `gap+latency` plus a mark: o ok, r refused
  // by the helper, t no reply in time, u bridge unavailable, i unreadable reply,
  // n tick sent no heartbeat, b skipped while a command ran, k skipped while the
  // previous tick was still waiting.
  private dump(reason: string): void {
    if (this.dumped || !this.running) return
    this.dumped = true
    if (this.pendingBeat?.mark === '?') this.pendingBeat.mark = 'n'
    const entries = this.ring.map(beat => beat.mark === 'b' || beat.mark === 'k' ? `${beat.gapMs}${beat.mark}` : `${beat.gapMs}+${beat.latencyMs}${beat.mark}`)
    while (entries.length > 1 && entries.join(' ').length > SAMPLE_BYTES) entries.shift()
    this.write('lid.flight_recorder', 'warn', {
      reason, count: entries.length, samples: entries.join(' '),
      elapsedMs: this.lastFire === undefined ? null : Math.round(this.now() - this.lastFire),
      eventLoopLagMs: this.lagMs(), ageMs: this.age(),
    })
  }

  private spend(): boolean {
    const at = this.now()
    if (at - this.budget.since > BUDGET_WINDOW_MS) this.budget = { since: at, used: 0, suppressed: this.budget.suppressed }
    if (this.budget.used >= COMMAND_LOG_BUDGET) { this.budget.suppressed++; return false }
    this.budget.used++
    return true
  }
}
