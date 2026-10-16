import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LidModeCommand, LidModeView, LidPreset } from '../shared/lidClosed.js'
import { LID_HELPER, LidSetupCancelled, lidRestored, type LidNativeClient, type LidNativeSnapshot, type LidHardware } from './lidClosedNative.js'

type Dependencies = {
  native: Pick<LidNativeClient, 'command' | 'close'>
  hardware(): Promise<LidHardware>
  install(recoveryOnly: boolean): Promise<void>
  installed(): boolean
  marker: string
  changed(view: LidModeView): void
}
const empty = (): LidModeView => ({ phase: 'off', allowance: 15, remainingSeconds: 0, installed: false, sleepRequested: false })

// One owner per Electron process, outside window/session lifetime. The root
// helper remains the deadline and restoration authority if this owner stalls.
export class LidClosedMode {
  private view = empty()
  private snapshot?: LidNativeSnapshot
  private identity?: string
  private chain: Promise<unknown> = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>
  private ticking = false
  private stopped = false
  private epoch = 0
  private busy = false
  private needsRecovery = false
  private ending?: { reason: string; sleep: boolean }

  constructor(private readonly deps: Dependencies) {}
  read(): LidModeView { return structuredClone(this.view) }
  async initialize(): Promise<void> {
    try {
      if (existsSync(this.deps.marker)) {
        const marker = JSON.parse(readFileSync(this.deps.marker, 'utf8'))
        if (typeof marker.pending !== 'boolean') throw new Error('Invalid recovery state')
        this.needsRecovery = marker.pending
      }
    } catch { this.needsRecovery = true }
    this.view.installed = this.deps.installed()
    // Without a helper nothing can still hold the override, so a leftover
    // note is cleared once normal sleep is observed. Any other reading stays red.
    if (this.needsRecovery && !this.view.installed) {
      const sleepDisabled = await this.deps.hardware().then(h => h.safety.sleepDisabled).catch(() => undefined)
      if (sleepDisabled === false) try { this.mark(false) } catch { /* Unwritable intent remains unresolved. */ }
    }
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
        else if (lidRestored(reply.snapshot)) {
          this.mark(false)
          this.set({ phase: 'off' })
        }
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
    if (['cancel', 'stop', 'sleep'].includes(command.action)) {
      this.epoch++
      if (this.needsRecovery) this.ending = { reason: command.action === 'sleep' ? 'sleep-requested' : 'stopped', sleep: command.action === 'sleep' }
    }
    return this.enqueue(async () => {
      if (this.stopped) return this.read()
      this.busy = true
      try {
        switch (command.action) {
          case 'start': await this.start(command.minutes); break
          case 'setup':
            if (this.view.phase === 'unavailable') {
              await this.install(false)
              const reply = await this.deps.native.command({ op: 'status' })
              this.accept(reply.snapshot)
            }
            break
          case 'adjust':
            if (this.view.phase === 'active') this.accept((await this.deps.native.command({ op: 'adjust', identity: this.identity, allowance: command.minutes * 60 })).snapshot)
            break
          case 'stop': case 'cancel':
            if (this.needsRecovery) await this.end('stopped')
            else this.set({ phase: 'off', error: undefined })
            break
          case 'sleep': if (this.needsRecovery) await this.end('sleep-requested', true); break
          case 'retry':
            if (this.view.phase !== 'unresolved') break
            this.set({ recovering: true })
            if (!this.deps.installed() || this.view.repairRequired) {
              this.deps.native.close(); await this.install(true)
            }
            await this.end('recovered')
            break
          case 'dismiss':
            if (!this.needsRecovery && !['starting','active','restoring','setup'].includes(this.view.phase)) {
              if (this.deps.installed()) await this.deps.native.command({ op: 'dismiss' })
              this.identity = undefined; this.set({ phase: 'off', error: undefined, reason: undefined })
            }
        }
      } catch (error) {
        if (this.needsRecovery) { this.set({ error: message(error) }); await this.end('monitoring-unavailable') }
        else if (error instanceof LidSetupCancelled) this.set({ phase: 'off', error: undefined })
        else this.set({ phase: 'unavailable', error: message(error) })
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
  private async install(recoveryOnly: boolean): Promise<void> {
    // Replacement invalidates the old Mach-service connection, even when its
    // bridge process is still alive. Admission must use the new generation.
    this.deps.native.close()
    try { await this.deps.install(recoveryOnly); this.view.installed = true }
    catch (error) {
      // An installer can fail after publishing authority. Do not turn that
      // partial result into a dismissible error merely because Start has not
      // written local intent yet. Normal sleep must be observed again.
      const sleepDisabled = await this.deps.hardware().then(h => h.safety.sleepDisabled).catch(() => undefined)
      if (this.deps.installed() || sleepDisabled !== false) {
        this.needsRecovery = true
        try { this.mark(true) } catch { /* Unwritable intent remains unresolved in memory. */ }
        this.set({ phase: 'unresolved', repairRequired: true })
      }
      throw error
    }
  }
  private async start(minutes: LidPreset): Promise<void> {
    if (this.needsRecovery || ['active','starting','restoring','unresolved'].includes(this.view.phase)) return
    const epoch = this.epoch
    this.checkHardware(await this.deps.hardware())
    if (epoch !== this.epoch || this.stopped) return
    this.view.allowance = minutes
    // First use goes straight to the macOS administrator dialog.
    if (!this.deps.installed()) {
      this.set({ phase: 'setup', error: undefined }); await this.install(false)
    }
    if (epoch !== this.epoch || this.stopped) { this.set({ phase: 'off' }); return }
    this.checkHardware(await this.deps.hardware())
    if (epoch !== this.epoch || this.stopped) { this.set({ phase: 'off' }); return }
    this.identity = randomUUID()
    this.set({ phase: 'starting', error: undefined, reason: undefined })
    this.mark(true)
    const reply = await this.deps.native.command({ op: 'start', identity: this.identity, allowance: minutes * 60 })
    if (epoch !== this.epoch || this.stopped) { this.snapshot = reply.snapshot; await this.end('stopped'); return }
    this.accept(reply.snapshot)
    if (!reply.ok) throw new Error(reply.error ?? 'Lid-closed mode could not start.')
  }
  private accept(snapshot: LidNativeSnapshot | undefined): void {
    if (!snapshot || snapshot.error) throw new Error('The sleep helper could not confirm the power state.')
    this.snapshot = snapshot
    this.view.allowance = snapshot.record.allowance ? snapshot.record.allowance / 60 : this.view.allowance
    this.view.remainingSeconds = snapshot.remainingSeconds
    this.view.sleepRequested = snapshot.record.sleepRequested || this.ending?.sleep === true
    if (!this.ending && snapshot.record.phase === 'active' && snapshot.record.identity === this.identity && snapshot.record.needsRestore && snapshot.safety.sleepDisabled === true) {
      this.set({ phase: 'active', error: undefined }); return
    }
    this.set({ phase: this.view.recovering ? 'unresolved' : 'restoring', reason: this.ending?.reason ?? snapshot.record.reason })
    if (!lidRestored(snapshot)) {
      this.set({ phase: 'unresolved', ...(this.ending ? { error: 'Normal sleep has not been restored. Retry recovery.' } : {}) }); return
    }
    this.mark(false)
    let reason = this.ending?.reason ?? snapshot.record.reason
    // Restoring the override does not prove the separate Sleep call completed.
    if (reason === 'sleep-requested' && (!snapshot.record.sleepRequestAttempted || snapshot.record.sleepRequestSucceeded !== true)) reason = 'sleep-unconfirmed'
    this.ending = undefined
    this.view.sleepRequested = snapshot.record.sleepRequested
    this.set({ phase: snapshot.record.phase === 'off' ? 'off' : 'ended',
      error: snapshot.record.error, repairRequired: false, reason })
  }
  private async end(reason: string, sleep = false): Promise<void> {
    this.ending ??= { reason, sleep }
    reason = this.ending.reason
    sleep = this.ending.sleep
    this.set({ phase: this.view.recovering ? 'unresolved' : 'restoring', reason })
    try {
      const op = sleep && this.identity ? 'sleep' : this.identity && this.snapshot?.record.phase === 'active' ? 'stop' : 'retry'
      const reply = await this.deps.native.command({ op, ...(['stop','sleep'].includes(op) ? { identity: this.identity } : {}) })
      this.accept(reply.snapshot)
    } catch { this.set({ phase: 'unresolved', repairRequired: true }) }
  }
  private async tick(): Promise<void> {
    if (!['active','unresolved','restoring'].includes(this.view.phase)) return
    try {
      if (this.view.phase === 'active' && !this.ending) {
        this.accept((await this.deps.native.command({ op: 'pulse', identity: this.identity })).snapshot)
      } else {
        this.accept((await this.deps.native.command({ op: 'status' })).snapshot)
      }
    } catch {
      if (this.needsRecovery) await this.end('monitoring-unavailable')
      else this.set({ phase: 'ended', error: 'Sleep monitoring is unavailable.' })
    }
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message.slice(0, 240) : 'Lid-closed mode is unavailable.' }
export function lidHelperInstalled(): boolean { return existsSync(LID_HELPER) }
