import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LidModeCommand, LidModeView, LidModeRun, LidWorkControl, LidWorkSnapshot, LidWorkWindow, LidPreset } from '../shared/lidClosed.js'
import { isLidWorkSnapshot } from '../shared/lidClosed.js'
import { LID_HELPER, lidRestored, type LidNativeClient, type LidNativeSnapshot, type LidHardware } from './lidClosedNative.js'

type Session = { id: string; title: string; generation: string }
type Dependencies = {
  native: Pick<LidNativeClient, 'command' | 'close'>
  sessions(): Session[]
  send(id: string, message: LidWorkControl): void
  hardware(): Promise<LidHardware>
  install(recoveryOnly: boolean): Promise<void>
  installed(): boolean
  marker: string
  changed(view: LidModeView): void
}
const empty = (): LidModeView => ({ phase: 'off', allowance: 15, remainingSeconds: 0, included: [], currentRuns: {}, canContinue: false, installed: false, sleepRequested: false })

// One owner per Electron process, outside window/session lifetime. The root
// helper remains the deadline and restoration authority if this owner stalls.
export class LidClosedMode {
  private view = empty()
  private snapshot?: LidNativeSnapshot
  private identity?: string
  private deadline = 0
  private generations = new Map<string, string>()
  private pending = new Map<string, { session: Session; resolve(work: LidWorkSnapshot): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private sequences = new Map<string, number>()
  private chain: Promise<unknown> = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>
  private ticking = false
  private stopped = false
  private epoch = 0
  private busy = false
  private awaitingSetup = false
  private needsRecovery = false
  private suppress = false
  private block = false
  private stalledAt = 0
  private stalledKind = ''

  constructor(private readonly deps: Dependencies) {}
  read(): LidModeView { return structuredClone(this.view) }
  receive(sessionId: string, requestId: string, work: unknown): void {
    const pending = this.pending.get(requestId)
    if (!pending || pending.session.id !== sessionId) return
    if (!isLidWorkSnapshot(work) || work.generation !== pending.session.generation ||
        this.deps.sessions().find(row => row.id === sessionId)?.generation !== work.generation ||
        work.sequence <= (this.sequences.get(work.generation) ?? -1)) return
    this.sequences.set(work.generation, work.sequence)
    this.pending.delete(requestId); clearTimeout(pending.timer); pending.resolve(work)
  }
  async initialize(): Promise<void> {
    try {
      if (existsSync(this.deps.marker)) {
        const marker = JSON.parse(readFileSync(this.deps.marker, 'utf8'))
        if (typeof marker.pending !== 'boolean') throw new Error('Invalid recovery state')
        this.needsRecovery = marker.pending
      }
    } catch { this.needsRecovery = true }
    this.view.installed = this.deps.installed()
    if (this.needsRecovery) this.set({ phase: 'unresolved' })
    if (this.view.installed) {
      try {
        const reply = await this.deps.native.command({ op: 'status' })
        this.snapshot = reply.snapshot
        if (!reply.snapshot) throw new Error('Helper unavailable')
        if (reply.snapshot.error || reply.snapshot.record.phase === 'unresolved') {
          this.mark(true); this.set({ phase: 'unresolved', error: 'The sleep recovery record could not be confirmed.' })
        }
        // A restarted app never adopts or supervises an old active lease.
        else if (reply.snapshot.record.needsRestore) { this.needsRecovery = true; await this.end('recovered') }
        else if (lidRestored(reply.snapshot)) { this.mark(false); this.set({ phase: 'off' }) }
        else this.set({ phase: this.needsRecovery ? 'unresolved' : 'unavailable', error: 'Normal sleep could not be confirmed.' })
      } catch {
        this.needsRecovery = true
        try { this.mark(true) } catch { /* Unwritable intent remains unresolved in memory. */ }
        this.set({ phase: 'unresolved', repairRequired: true, error: 'The sleep helper needs administrator repair.' })
      }
    } else if (!this.needsRecovery) {
      try { const hardware = await this.deps.hardware(); this.checkHardware(hardware); this.set({ phase: 'off' }) }
      catch (error) { this.set({ phase: 'unavailable', error: message(error) }) }
    }
    this.timer = setInterval(() => {
      if (this.ticking || this.busy || this.stopped) return
      this.ticking = true
      void this.enqueue(() => this.tick()).finally(() => { this.ticking = false })
    }, 1000)
    this.timer.unref()
    this.emit()
  }
  command(command: LidModeCommand): Promise<LidModeView> {
    // Cancel can invalidate an administrator dialog or native request before
    // the serialized mutation returns. Its late result must restore, not start.
    if (['cancel', 'stop', 'sleep'].includes(command.action)) this.epoch++
    return this.enqueue(async () => {
      if (this.stopped) return this.read()
      this.busy = true
      try {
        switch (command.action) {
          case 'start': await this.start(command.minutes); break
          case 'setup':
            if (this.awaitingSetup) await this.start(this.view.allowance as LidPreset, true)
            else if (this.view.phase === 'unavailable') {
              await this.deps.install(false); this.view.installed = true
              this.accept((await this.deps.native.command({ op: 'status' })).snapshot)
            }
            break
          case 'adjust':
            if (this.view.phase === 'active') this.accept((await this.deps.native.command({ op: 'adjust', identity: this.identity, allowance: command.minutes * 60 })).snapshot)
            break
          case 'continue': await this.resume(); break
          case 'stop': case 'cancel':
            this.awaitingSetup = false
            if (this.needsRecovery) await this.end('stopped')
            else this.set({ phase: 'off', canContinue: false, error: undefined })
            break
          case 'sleep': if (this.needsRecovery || this.view.canContinue) await this.end('sleep-requested', true); break
          case 'retry':
            if (this.view.phase !== 'unresolved') break
            this.set({ recovering: true })
            if (!this.deps.installed() || this.view.repairRequired) {
              this.deps.native.close(); await this.deps.install(true); this.view.installed = true
            }
            await this.end('recovered')
            break
          case 'dismiss':
            if (!this.needsRecovery && !['starting','active','restoring','setup'].includes(this.view.phase)) {
              if (this.deps.installed()) await this.deps.native.command({ op: 'dismiss' })
              this.identity = undefined; this.set({ phase: 'off', canContinue: false, error: undefined, reason: undefined, included: [] })
            }
        }
      } catch (error) {
        if (this.needsRecovery) { this.set({ error: message(error) }); await this.end('monitoring-unavailable') }
        else this.set({ phase: 'unavailable', error: message(error), canContinue: false })
      } finally { this.busy = false; this.view.recovering = false; this.emit() }
      return this.read()
    })
  }
  async shutdown(): Promise<void> {
    this.stopped = true; this.epoch++
    if (this.timer) clearInterval(this.timer)
    await this.enqueue(async () => { if (this.needsRecovery) await this.end('stopped') })
    this.deps.native.close()
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => {}).then(action); this.chain = next; return next
  }
  private set(patch: Partial<LidModeView>): void { Object.assign(this.view, patch); this.emit() }
  private emit(): void { this.deps.changed(this.read()) }
  private mark(pending: boolean): void {
    // fsync the local intent before admission, as well as the helper's root
    // journal. An unreadable marker is recovery, never a default Off state.
    const directory = dirname(this.deps.marker)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temp = this.deps.marker + '.' + randomUUID()
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify({ pending }) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, this.deps.marker)
    const dir = openSync(directory, 'r'); try { fsyncSync(dir) } finally { closeSync(dir) }
    this.needsRecovery = pending
  }
  private checkHardware(h: LidHardware): void {
    if (!h.qualified) throw new Error('This Mac and macOS version have not been qualified for lid-closed work.')
    if (h.safety.sleepDisabled !== false) throw new Error('Sleep is already disabled or its setting is unavailable. End other keep-awake modes first.')
    if (h.safety.lidClosed !== false) throw new Error('Open the lid before starting.')
    if (!['nominal','fair'].includes(h.safety.thermal) || h.safety.onBattery === undefined || h.safety.batteryPercent === undefined) throw new Error('Safety monitoring is unavailable or your Mac needs to cool down.')
    if (h.safety.onBattery && h.safety.batteryPercent <= 20) throw new Error('Charge above 20% before starting.')
  }
  private async start(minutes: LidPreset, setup = false): Promise<void> {
    if (this.needsRecovery || ['active','starting','restoring','unresolved'].includes(this.view.phase)) return
    const epoch = this.epoch
    const work = await this.work(false)
    const included = work.filter(run => run.status !== 'completed')
    if (!included.length) { this.set({ phase: 'unavailable', error: 'No running work to keep awake.' }); return }
    this.checkHardware(await this.deps.hardware())
    this.view.allowance = minutes
    if (!this.deps.installed() && !setup) { this.awaitingSetup = true; this.set({ phase: 'setup', error: undefined }); return }
    if (!this.deps.installed()) {
      this.set({ phase: 'setup' }); await this.deps.install(false); this.view.installed = true
    }
    this.awaitingSetup = false
    if (epoch !== this.epoch || this.stopped) { this.set({ phase: 'off' }); return }
    // Recheck after authorization, then freeze the observed roots. A new turn
    // arriving during the native start cannot silently join this set.
    const fresh = await this.work(false)
    const scope = fresh.filter(run => run.status !== 'completed')
    if (epoch !== this.epoch || this.stopped) { this.set({ phase: 'off' }); return }
    if (!scope.length) throw new Error('No running work to keep awake.')
    this.identity = randomUUID(); this.suppress = false; this.block = false
    this.stalledKind = ''; this.stalledAt = 0
    this.generations = new Map(this.deps.sessions().map(row => [row.id, row.generation]))
    this.set({ phase: 'starting', included: scope, error: undefined, reason: undefined, canContinue: false })
    this.mark(true)
    const reply = await this.deps.native.command({ op: 'start', identity: this.identity, allowance: minutes * 60 })
    if (epoch !== this.epoch || this.stopped) { this.snapshot = reply.snapshot; await this.end('stopped'); return }
    this.accept(reply.snapshot)
    if (!reply.ok) throw new Error(reply.error ?? 'Lid-closed mode could not start.')
    else if (this.read().phase === 'active') await this.work(true)
  }
  private async resume(): Promise<void> {
    if (!this.view.canContinue || this.view.phase !== 'lid-open') return
    const epoch = this.epoch
    const work = await this.work(false)
    if (!this.updateScope(work)) { this.set({ canContinue: false, phase: 'ended' }); return }
    this.checkHardware(await this.deps.hardware())
    if (epoch !== this.epoch || this.stopped) return
    this.mark(true); this.set({ phase: 'starting', canContinue: false })
    const reply = await this.deps.native.command({ op: 'continue', identity: this.identity })
    if (epoch !== this.epoch || this.stopped) { this.snapshot = reply.snapshot; await this.end('stopped'); return }
    this.accept(reply.snapshot)
    if (this.read().phase === 'active') await this.work(true)
  }
  private accept(snapshot: LidNativeSnapshot | undefined): void {
    if (!snapshot || snapshot.error) throw new Error('The sleep helper could not confirm the power state.')
    this.snapshot = snapshot
    this.view.allowance = snapshot.record.allowance ? snapshot.record.allowance / 60 : this.view.allowance
    this.view.remainingSeconds = snapshot.remainingSeconds
    this.deadline = Date.now() + snapshot.remainingSeconds * 1000
    this.view.sleepRequested = snapshot.record.sleepRequested
    if (snapshot.record.phase === 'active' && snapshot.record.identity === this.identity && snapshot.record.needsRestore && snapshot.safety.sleepDisabled === true) {
      this.set({ phase: 'active', error: undefined, canContinue: false }); return
    }
    this.set({ phase: this.view.recovering ? 'unresolved' : 'restoring', canContinue: false, reason: snapshot.record.reason })
    if (!lidRestored(snapshot)) { this.set({ phase: 'unresolved' }); return }
    this.mark(false)
    const thermalEnd = snapshot.record.reason === 'thermal' || snapshot.record.thermalRestart === true
    this.suppress ||= snapshot.record.sleepRequested || thermalEnd || ['serious','critical'].includes(snapshot.safety.thermal)
    this.block ||= snapshot.safety.lidClosed === true || thermalEnd || ['serious','critical'].includes(snapshot.safety.thermal)
    const canContinue = snapshot.record.phase === 'lid-open' && snapshot.record.identity === this.identity && snapshot.remainingSeconds > 0 && this.view.included.some(run => run.status !== 'completed')
    this.set({ phase: canContinue ? 'lid-open' : snapshot.record.phase === 'off' ? 'off' : 'ended', canContinue,
      error: snapshot.record.error, repairRequired: false, reason: snapshot.record.reason })
  }
  private async end(reason: string, sleep = false): Promise<void> {
    this.set({ phase: this.view.recovering ? 'unresolved' : 'restoring', reason, canContinue: false })
    this.suppress ||= sleep || this.snapshot?.safety.lidClosed === true
    this.block ||= this.snapshot?.safety.lidClosed === true || ['serious','critical'].includes(this.snapshot?.safety.thermal ?? '')
    // Withdraw instructions and ordinary idle assertions before requesting
    // Sleep. Missing engines cannot postpone restoration indefinitely.
    await this.work(true).catch(() => {})
    try {
      const op = sleep && this.identity ? 'sleep' : this.identity && this.snapshot?.record.phase === 'active' ? 'stop' : 'retry'
      const reply = await this.deps.native.command({ op, ...(['stop','sleep'].includes(op) ? { identity: this.identity } : {}) })
      this.accept(reply.snapshot)
      if (!this.needsRecovery) this.set({ reason, canContinue: false })
    } catch { this.set({ phase: 'unresolved', canContinue: false, repairRequired: true }) }
    await this.work(true).catch(() => {})
  }
  private async tick(): Promise<void> {
    if (!['active','lid-open','unresolved','restoring'].includes(this.view.phase)) return
    try {
      if (this.view.phase === 'active') {
        const work = await this.work(true)
        if (!this.updateScope(work)) { await this.end('completed'); return }
        const waiting = this.view.included.filter(run => run.status !== 'completed')
        const kind = waiting.every(run => run.status === 'approval') ? 'approval' : waiting.every(run => run.status !== 'running') ? 'provider' : ''
        if (kind !== this.stalledKind) { this.stalledKind = kind; this.stalledAt = performance.now() }
        if (kind && performance.now() - this.stalledAt >= (kind === 'approval' ? 60_000 : 120_000)) { await this.end(kind); return }
        this.accept((await this.deps.native.command({ op: 'pulse', identity: this.identity })).snapshot)
        if (this.view.phase !== 'active') await this.work(true).catch(() => {})
      } else {
        this.accept((await this.deps.native.command({ op: 'status' })).snapshot)
        if (this.view.canContinue) this.updateScope(await this.work(false))
      }
    } catch {
      if (this.needsRecovery) await this.end('monitoring-unavailable')
      else this.set({ canContinue: false, phase: 'ended', error: 'Work monitoring is unavailable.' })
    }
  }
  private updateScope(work: LidModeRun[]): boolean {
    this.view.included = this.view.included.map(old => {
      if (this.deps.sessions().find(row => row.id === old.sessionId)?.generation !== this.generations.get(old.sessionId)) return { ...old, status: 'completed', activeTurn: false }
      return work.find(run => run.id === old.id && run.sessionId === old.sessionId) ?? { ...old, status: 'completed', activeTurn: false }
    })
    const live = this.view.included.some(run => run.status !== 'completed')
    if (!live) this.view.canContinue = false
    this.emit(); return live
  }
  private async work(update: boolean): Promise<LidModeRun[]> {
    const sessions = this.deps.sessions()
    if (sessions.length > 128) throw new Error('Too many active chats to monitor lid-closed work.')
    const results = await Promise.all(sessions.map(async session => {
      const roots = this.view.included.filter(run => run.sessionId === session.id && this.generations.get(session.id) === session.generation).map(run => run.id)
      const window: LidWorkWindow | undefined = update && this.identity ? { identity: this.identity, roots,
        active: this.view.phase === 'active', deadline: this.deadline, lidClosed: this.snapshot?.safety.lidClosed === true,
        block: this.block, suppressIdleSleep: this.suppress } : undefined
      const requestId = randomUUID()
      const work = await new Promise<LidWorkSnapshot>((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Work monitoring is unavailable.')) }, 1000)
        this.pending.set(requestId, { session, resolve, reject, timer })
        try { this.deps.send(session.id, { type: 'lid.work', requestId, ...(window ? { window } : {}) }) }
        catch { clearTimeout(timer); this.pending.delete(requestId); reject(new Error('Work monitoring is unavailable.')) }
      })
      if (!work.available) throw new Error('Work monitoring is unavailable.')
      return work.runs.map(run => ({ ...run, sessionId: session.id, title: session.title }))
    }))
    const runs = results.flat()
    this.view.currentRuns = Object.fromEntries(runs.filter(run => run.activeTurn).map(run => [run.sessionId, run.id]))
    return runs
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message.slice(0, 240) : 'Lid-closed mode is unavailable.' }
export function lidHelperInstalled(): boolean { return existsSync(LID_HELPER) }
