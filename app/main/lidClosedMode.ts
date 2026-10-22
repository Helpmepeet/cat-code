import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LidModeCommand, LidModeView, LidTarget, LidPreset } from '../shared/lidClosed.js'
import { LID_HELPER, LidSetupCancelled, lidRestored, type LidNativeClient, type LidNativeSnapshot, type LidNativeReply, type LidHardware } from './lidClosedNative.js'
import { WORK_COMPLETION_GRACE_MS, type LidWorkAggregate } from './lidWorkObserver.js'

type Dependencies = {
  native: Pick<LidNativeClient, 'command' | 'close'>
  hardware(): Promise<LidHardware>
  install(recoveryOnly: boolean): Promise<void>
  installed(): boolean
  current(): Promise<boolean>
  marker: string
  changed(view: LidModeView): void
  work: Pick<import('./lidWorkObserver.js').LidWorkObserver, 'start' | 'read' | 'refresh' | 'verify' | 'subscribe' | 'stop' | 'probe'>
}
const empty = (): LidModeView => ({ phase: 'off', mode: null, allowance: 0, remainingSeconds: 0, workAvailable: false, activeSessions: 0, activeSubagents: 0, waitingForApproval: false, installed: false, sleepRequested: false })

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
  private workUnsubscribe?: () => void
  private renewalSequence = 0
  private graceTimer?: ReturnType<typeof setTimeout>
  private finalizing = false
  private activationWorkRevision = 0
  private admissionRevision = 0
  private switching = false

  constructor(private readonly deps: Dependencies) {}
  read(): LidModeView { return structuredClone(this.view) }
  readPresence(): Promise<LidModeView> {
    return this.enqueue(async () => {
      if (!this.stopped) {
        try { this.updatePresence(await this.deps.work.probe()) }
        catch { this.view.workAvailable = false }
        this.emit()
      }
      return this.read()
    })
  }
  private updatePresence(work: LidWorkAggregate): void {
    const fresh = work.availability === 'fresh' && !work.supervisionLost
    this.view.workAvailable = fresh && work.hasUnfinishedWork
    if (fresh || this.view.phase !== 'active' || this.view.mode !== 'work') {
      this.view.activeSessions = fresh ? work.activeSessions : 0
      this.view.activeSubagents = fresh ? work.activeSubagents : 0
      this.view.waitingForApproval = fresh && work.waitingForApproval
    }
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
    if (command.action === 'set') {
      this.epoch++
      this.disarmWork()
    }
    const requestedEpoch = this.epoch
    // Cancel can invalidate an administrator dialog or native request before
    // the serialized mutation returns. Its late result must restore, not start.
    if (['cancel', 'stop', 'sleep'].includes(command.action)) {
      this.epoch++
      this.disarmWork()
      if (this.needsRecovery) this.ending = { reason: command.action === 'sleep' ? 'sleep-requested' : 'stopped', sleep: command.action === 'sleep' }
    }
    return this.enqueue(async () => {
      if (this.stopped) return this.read()
      this.busy = true
      try {
        switch (command.action) {
          case 'set':
            if (requestedEpoch === this.epoch) await this.reconcile(command.target, requestedEpoch)
            break
          case 'start': await this.start(); break
          case 'setup':
            if (this.view.phase === 'unavailable') {
              await this.install(false)
              const reply = await this.deps.native.command({ op: 'status' })
              this.accept(reply.snapshot)
            }
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
        if (this.view.phase !== 'active') this.disarmWork()
        if (this.needsRecovery) { this.set({ error: message(error) }); await this.end('monitoring-unavailable') }
        else if (error instanceof LidSetupCancelled) this.set({ phase: 'off', error: undefined })
        else this.set({ phase: 'unavailable', error: message(error) })
      } finally { this.busy = false; this.view.recovering = false; this.emit() }
      return this.read()
    })
  }
  async shutdown(): Promise<void> {
    this.stopped = true; this.epoch++; this.disarmWork(); this.deps.work.stop()
    if (this.timer) clearInterval(this.timer)
    await this.enqueue(async () => { if (this.needsRecovery) await this.end('stopped') })
    this.deps.native.close()
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => {}).then(action); this.chain = next; return next
  }
  private set(patch: Partial<LidModeView>): void {
    if (patch.phase && !['setup', 'starting', 'active'].includes(patch.phase)) this.disarmWork()
    Object.assign(this.view, patch)
    this.emit()
  }
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
  private checkRefusedAdmission(reply: LidNativeReply, hardware: LidHardware): void {
    if (reply.ok || !lidRestored(reply.snapshot)) return
    // A refusal before admission can return the prior activation's restored record.
    this.snapshot = reply.snapshot
    this.mark(false)
    this.identity = undefined
    this.checkHardware({ ...hardware, safety: reply.snapshot!.safety })
    throw new Error('Lid-closed mode could not start.')
  }
  private async install(recoveryOnly: boolean): Promise<void> {
    // Replacement invalidates the old Mach-service connection, even when its
    // bridge process is still alive. Admission must use the new generation.
    this.deps.native.close()
    try { await this.deps.install(recoveryOnly); this.view.installed = true }
    catch (error) {
      // Cancellation occurs before the root installer runs, so an existing
      // helper does not by itself turn a declined upgrade into recovery.
      if (error instanceof LidSetupCancelled) throw error
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
  private workChanged(aggregate: LidWorkAggregate): void {
    this.view.workAvailable = aggregate.availability === 'fresh' && !aggregate.supervisionLost && aggregate.hasUnfinishedWork
    if (aggregate.availability === 'fresh' || this.view.phase !== 'active') {
      this.view.activeSessions = aggregate.activeSessions
      this.view.activeSubagents = aggregate.activeSubagents
      this.view.waitingForApproval = aggregate.waitingForApproval
    }
    if (this.view.phase !== 'active' || this.view.mode !== 'work') { this.emit(); return }
    if (aggregate.supervisionLost) {
      this.disarmWork()
      void this.enqueue(async () => {
        if (this.view.phase === 'active' && this.needsRecovery) await this.end('supervision-lost')
      })
      return
    }
    if (aggregate.revision !== this.activationWorkRevision) {
      this.activationWorkRevision = aggregate.revision
      this.clearGrace()
      this.finalizing = false
    }
    if (aggregate.availability === 'unknown') {
      this.clearGrace()
      this.finalizing = false
    } else if (aggregate.hasUnfinishedWork) {
      this.clearGrace()
      this.finalizing = false
    } else if (!this.graceTimer && !this.finalizing) {
      const epoch = this.epoch
      const revision = aggregate.revision
      this.graceTimer = setTimeout(() => {
        this.graceTimer = undefined
        void this.verifyEmpty(epoch, revision)
      }, WORK_COMPLETION_GRACE_MS)
      this.graceTimer.unref()
    }
    this.emit()
  }
  onAdmissionStarted(): void {
    if (this.view.phase !== 'active') return
    this.admissionRevision++
    this.clearGrace()
    this.finalizing = false
  }
  private disarmWork(): void {
    this.clearGrace()
    this.finalizing = false
    this.workUnsubscribe?.()
    this.workUnsubscribe = undefined
    this.deps.work.stop()
  }
  private clearGrace(): void { if (this.graceTimer) clearTimeout(this.graceTimer); this.graceTimer = undefined }
  private async verifyEmpty(epoch: number, revision: number): Promise<void> {
    const activation = this.epoch
    if (epoch !== activation || this.view.phase !== 'active' || this.view.mode !== 'work') return
    const admissionRevision = this.admissionRevision
    this.finalizing = true
    try {
      const aggregate = await this.deps.work.verify()
      await this.enqueue(async () => {
        const current = this.deps.work.read()
        if (this.epoch !== activation || this.view.phase !== 'active' || this.view.mode !== 'work') return
        if (aggregate.availability !== 'fresh' || aggregate.hasUnfinishedWork ||
            aggregate.revision !== revision || current.availability !== 'fresh' ||
            current.hasUnfinishedWork || current.revision !== revision ||
            current.supervisionLost || admissionRevision !== this.admissionRevision) {
          this.finalizing = false
          this.workChanged(current)
          return
        }
        // Disarm synchronously before the helper sees finish-work; admissions and
        // generation changes can no longer race a committed empty observation.
        this.disarmWork()
        await this.finishWork('work-finished')
      })
    } catch {
      this.finalizing = false
      this.workChanged(this.deps.work.read())
    }
  }
  private async finishWork(reason: string): Promise<void> {
    const identity = this.identity
    if (!identity) throw new Error('The sleep helper identity is unavailable.')
    this.ending = { reason, sleep: false }
    this.set({ phase: 'restoring', reason })
    try {
      const reply = await this.deps.native.command({ op: 'finish-work', identity })
      const snapshot = reply.snapshot
      if (reply.ok && this.isWorkReceipt(snapshot, 'work', this.renewalSequence, false) &&
          snapshot?.record.reason === 'work-finished') {
        this.ending = { reason: 'work-finished', sleep: false }
        this.accept(snapshot)
        return
      }
      if (snapshot?.record.phase !== 'active' && !snapshot?.record.needsRestore &&
          snapshot?.safety.sleepDisabled === false && snapshot?.record.reason &&
          snapshot.record.reason !== 'work-finished') {
        this.snapshot = snapshot
        this.ending = { reason: snapshot.record.reason, sleep: false }
        this.accept(snapshot)
        return
      }
      this.snapshot = snapshot
      throw new Error(reply.error ?? 'The sleep helper could not confirm work completion.')
    } catch {
      this.ending = { reason: 'monitoring-unavailable', sleep: false }
      await this.end('monitoring-unavailable')
    }
  }
  private async start(fallback = false): Promise<void> {
    if (this.needsRecovery || ['active','starting','restoring','unresolved'].includes(this.view.phase)) return
    const epoch = this.epoch
    this.set({ phase: 'starting', mode: 'work', allowance: 0, remainingSeconds: 0, error: undefined, reason: undefined })
    const initialWork = await this.deps.work.start()
    if (epoch !== this.epoch || this.stopped) { this.deps.work.stop(); return }
    this.updatePresence(initialWork)
    if (initialWork.availability === 'unknown' || initialWork.supervisionLost) {
      this.deps.work.stop()
      this.set({ phase: 'unavailable', reason: 'work-status-unavailable', error: 'Work status is unavailable. Try again when sessions are connected.' })
      return
    }
    if (!initialWork.hasUnfinishedWork) {
      this.deps.work.stop()
      if (fallback) { await this.startTimed(15, epoch); return }
      this.set({ phase: 'off', reason: 'no-work', error: undefined })
      return
    }
    const firstHardware = await this.deps.hardware()
    if (epoch !== this.epoch || this.stopped) { this.deps.work.stop(); return }
    this.checkHardware(firstHardware)
    if (!this.checkAdmissionWork(epoch)) return
    // App replacement leaves the root-owned helper outside the bundle.
    const current = await this.deps.current()
    if (epoch !== this.epoch || this.stopped) { this.deps.work.stop(); return }
    if (!this.checkAdmissionWork(epoch)) return
    if (!current) {
      this.set({ phase: 'setup', error: undefined }); await this.install(false)
      if (epoch !== this.epoch || this.stopped) { this.deps.work.stop(); this.set({ phase: 'off' }); return }
      if (!this.checkAdmissionWork(epoch)) return
    }
    if (epoch !== this.epoch || this.stopped) { this.deps.work.stop(); this.set({ phase: 'off' }); return }
    const finalHardware = await this.deps.hardware()
    if (epoch !== this.epoch || this.stopped) { this.deps.work.stop(); this.set({ phase: 'off' }); return }
    this.checkHardware(finalHardware)
    if (!this.checkAdmissionWork(epoch)) return
    this.identity = randomUUID()
    this.renewalSequence = 0
    this.activationWorkRevision = initialWork.revision
    this.mark(true)
    const reply = await this.deps.native.command({ op: 'start-work', identity: this.identity })
    this.checkRefusedAdmission(reply, finalHardware)
    if (epoch !== this.epoch || this.stopped) {
      this.snapshot = reply.snapshot
      if (reply.snapshot?.record.needsRestore) await this.end('stopped')
      else if (lidRestored(reply.snapshot)) this.mark(false)
      return
    }
    this.snapshot = reply.snapshot
    if (!reply.ok || !this.isWorkReceipt(reply.snapshot, 'work', 0, true)) {
      if (reply.snapshot?.record.reason === 'supervision-lost' || reply.snapshot?.record.error === 'supervision-lost') {
        this.accept(reply.snapshot)
        await this.end('supervision-lost')
        return
      }
      throw new Error(reply.error ?? 'The sleep helper could not confirm work supervision.')
    }
    const currentWork = this.deps.work.read()
    if (currentWork.availability !== 'fresh' || currentWork.supervisionLost) {
      await this.end('monitoring-unavailable')
      return
    }
    if (!currentWork.hasUnfinishedWork) {
      this.view.activeSessions = currentWork.activeSessions
      this.view.activeSubagents = currentWork.activeSubagents
      this.view.waitingForApproval = currentWork.waitingForApproval
      await this.finishWork('work-finished')
      return
    }
    this.activationWorkRevision = currentWork.revision
    this.view.activeSessions = currentWork.activeSessions
    this.view.activeSubagents = currentWork.activeSubagents
    this.view.waitingForApproval = currentWork.waitingForApproval
    this.accept(reply.snapshot)
    this.workUnsubscribe = this.deps.work.subscribe(value => this.workChanged(value))
    this.workChanged(currentWork)
  }
  private async reconcile(target: LidTarget, epoch: number): Promise<void> {
    if (target === 'off') {
      if (this.needsRecovery) await this.end('stopped')
      else this.set({ phase: 'off', mode: null, allowance: 0, remainingSeconds: 0, error: undefined })
      return
    }
    if (this.view.phase === 'unresolved') return
    // A superseded pre-admission target can leave a starting view without a lease.
    if (!this.needsRecovery && ['starting', 'setup'].includes(this.view.phase)) this.view.phase = 'off'
    if (this.view.phase === 'active' && this.view.mode === 'timed' && typeof target === 'number') {
      const began = this.snapshot?.record.began
      const reply = await this.deps.native.command({ op: 'adjust', identity: this.identity!, allowance: target * 60 })
      if (this.restoredReceipt(reply.snapshot)) { this.accept(reply.snapshot); return }
      if (reply.snapshot?.record.began !== began) throw new Error('The sleep helper changed the timer start.')
      if (!reply.ok || !this.timedReceipt(reply.snapshot, target)) throw new Error('The sleep helper could not confirm the timer.')
      this.snapshot = reply.snapshot
      if (epoch !== this.epoch) return
      this.accept(reply.snapshot)
      return
    }
    if (this.view.phase === 'active' && this.view.mode === 'work' && target === 'work') {
      this.workUnsubscribe = this.deps.work.subscribe(value => this.workChanged(value))
      this.workChanged(await this.deps.work.start())
      return
    }
    if (this.needsRecovery) {
      this.switching = true
      this.set({ phase: 'starting', mode: target === 'work' ? 'work' : 'timed', allowance: typeof target === 'number' ? target : 0 })
      try { await this.end('stopped') } finally { this.switching = false }
      if (this.needsRecovery || epoch !== this.epoch || this.stopped) return
      this.view.phase = 'off'
    }
    if (epoch !== this.epoch || this.stopped) return
    if (target === 'work') {
      await this.start(true)
      if (epoch === this.epoch && !this.stopped && !this.needsRecovery &&
          this.view.phase === 'off' && this.view.reason === 'no-work') await this.startTimed(15, epoch)
    }
    else await this.startTimed(target, epoch)
  }
  private timedReceipt(snapshot: LidNativeSnapshot | undefined, allowance: number): boolean {
    return !!snapshot && !snapshot.error && snapshot.record.version === 2 && snapshot.record.mode === 'timed' &&
      snapshot.record.identity === this.identity && snapshot.record.allowance === allowance * 60 &&
      snapshot.record.phase === 'active' && snapshot.record.needsRestore && snapshot.safety.sleepDisabled === true
  }
  private restoredReceipt(snapshot: LidNativeSnapshot | undefined): boolean {
    return !!snapshot && lidRestored(snapshot) && snapshot.record.identity === this.identity &&
      snapshot.record.mode === this.snapshot?.record.mode
  }
  private async startTimed(allowance: LidPreset, epoch: number): Promise<void> {
    this.disarmWork()
    this.set({ phase: 'starting', mode: 'timed', allowance, remainingSeconds: 0, error: undefined, reason: undefined })
    const cancelled = () => epoch !== this.epoch || this.stopped
    const hardware = await this.deps.hardware()
    if (cancelled()) return
    this.checkHardware(hardware)
    const current = await this.deps.current()
    if (cancelled()) return
    if (!current) {
      this.set({ phase: 'setup' }); await this.install(false)
      if (cancelled()) return
    }
    const finalHardware = await this.deps.hardware()
    if (cancelled()) return
    this.checkHardware(finalHardware)
    this.set({ phase: 'starting' })
    this.identity = randomUUID()
    this.mark(true)
    const reply = await this.deps.native.command({ op: 'start', identity: this.identity, allowance: allowance * 60 })
    this.checkRefusedAdmission(reply, finalHardware)
    this.snapshot = reply.snapshot
    if (cancelled()) { await this.end('stopped'); return }
    if (!reply.ok || !this.timedReceipt(reply.snapshot, allowance)) throw new Error('The sleep helper could not confirm the timer.')
    this.accept(reply.snapshot)
  }
  private checkAdmissionWork(epoch: number): boolean {
    if (epoch !== this.epoch || this.stopped) return false
    const aggregate = this.deps.work.read()
    if (aggregate.availability === 'unknown' || aggregate.supervisionLost) {
      this.deps.work.stop()
      this.set({ phase: 'unavailable', reason: 'work-status-unavailable', error: 'Work status is unavailable. Try again when sessions are connected.' })
      return false
    }
    if (!aggregate.hasUnfinishedWork) {
      this.deps.work.stop()
      this.set({ phase: 'off', reason: 'no-work', error: undefined, activeSessions: 0, activeSubagents: 0, waitingForApproval: false })
      return false
    }
    return true
  }
  private isWorkReceipt(snapshot: LidNativeSnapshot | undefined, mode: 'work', sequence: number, needsRestore: boolean): boolean {
    return !!snapshot && snapshot.record.version === 2 && snapshot.record.mode === mode &&
      snapshot.record.identity === this.identity && snapshot.record.renewalSequence === sequence &&
      snapshot.record.phase === (needsRestore ? 'active' : 'ended') &&
      snapshot.record.needsRestore === needsRestore && snapshot.safety.sleepDisabled === needsRestore
  }
  private accept(snapshot: LidNativeSnapshot | undefined): void {
    if (!snapshot || snapshot.error) throw new Error('The sleep helper could not confirm the power state.')
    this.snapshot = snapshot
    if (!this.switching) {
      this.view.mode = snapshot.record.mode ?? null
      this.view.allowance = snapshot.record.mode === 'timed' ? snapshot.record.allowance / 60 : 0
      this.view.remainingSeconds = snapshot.remainingSeconds
    }
    const nativeReason = snapshot.record.reason
    const nativeSafetyReason = nativeReason &&
      !['stopped', 'work-finished', 'sleep-requested'].includes(nativeReason)
    const terminalReason = nativeSafetyReason ? nativeReason : this.ending?.reason ?? nativeReason
    this.view.sleepRequested = snapshot.record.sleepRequested || this.ending?.sleep === true
    if (!this.ending && snapshot.record.phase === 'active' && snapshot.record.identity === this.identity && snapshot.record.needsRestore && snapshot.safety.sleepDisabled === true) {
      this.set({ phase: 'active', error: undefined }); return
    }
    if (!this.switching) this.set({ phase: this.view.recovering ? 'unresolved' : 'restoring', reason: terminalReason })
    if (!lidRestored(snapshot)) {
      this.set({ phase: 'unresolved', ...(this.ending ? { error: 'Normal sleep has not been restored. Retry recovery.' } : {}) }); return
    }
    this.mark(false)
    if (this.switching) { this.ending = undefined; return }
    let reason = terminalReason
    // Restoring the override does not prove the separate Sleep call completed.
    if (reason === 'sleep-requested' && (!snapshot.record.sleepRequestAttempted || snapshot.record.sleepRequestSucceeded !== true)) reason = 'sleep-unconfirmed'
    this.ending = undefined
    this.view.sleepRequested = snapshot.record.sleepRequested
    this.view.activeSessions = 0
    this.view.activeSubagents = 0
    this.view.waitingForApproval = false
    this.set({ phase: snapshot.record.phase === 'off' ? 'off' : 'ended',
      error: snapshot.record.error, repairRequired: false, reason })
  }
  private async end(reason: string, sleep = false): Promise<void> {
    this.ending ??= { reason, sleep }
    reason = this.ending.reason
    if (!this.switching) this.set({ phase: this.view.recovering ? 'unresolved' : 'restoring', reason })
    try {
      const identity = this.identity
      const reply = sleep && identity
        ? await this.deps.native.command({ op: 'sleep', identity })
        : reason === 'recovered' || this.view.recovering
          ? await this.deps.native.command({ op: 'retry' })
          : identity && this.snapshot?.record.phase === 'active'
            ? await this.deps.native.command({ op: 'stop', identity })
            : await this.deps.native.command({ op: 'retry' })
      if (identity && (reply.snapshot?.record.identity !== identity ||
          (this.snapshot?.record.mode && reply.snapshot?.record.mode !== this.snapshot.record.mode))) {
        throw new Error('The sleep helper could not confirm the activation.')
      }
      this.accept(reply.snapshot)
    } catch { this.set({ phase: 'unresolved', repairRequired: true }) }
  }
  private async tick(): Promise<void> {
    if (!['active','unresolved','restoring'].includes(this.view.phase)) return
    try {
      if (this.view.phase === 'active' && !this.ending) {
        if (this.view.mode === 'timed') {
          const epoch = this.epoch
          const reply = await this.deps.native.command({ op: 'pulse', identity: this.identity! })
          if (this.restoredReceipt(reply.snapshot)) { this.accept(reply.snapshot); return }
          this.snapshot = reply.snapshot
          if (!reply.ok || !this.timedReceipt(reply.snapshot, this.view.allowance)) throw new Error('The sleep helper could not confirm the timer.')
          if (epoch !== this.epoch) return
          this.accept(reply.snapshot)
          return
        }
        const work = this.deps.work.read()
        if (work.supervisionLost) {
          this.disarmWork()
          await this.end('supervision-lost')
          return
        }
        this.workChanged(work)
        const nextSequence = this.renewalSequence + 1
        const identity = this.identity
        if (!identity) throw new Error('The sleep helper identity is unavailable.')
        const epoch = this.epoch
        const reply = await this.deps.native.command({ op: 'renew-work', identity, sequence: nextSequence })
        this.snapshot = reply.snapshot
        if (reply.snapshot?.record.reason === 'supervision-lost' || reply.snapshot?.record.error === 'supervision-lost') {
          this.accept(reply.snapshot)
          await this.end('supervision-lost')
          return
        }
        if (!reply.ok || !this.isWorkReceipt(reply.snapshot, 'work', nextSequence, true)) throw new Error(reply.error ?? 'Work supervision could not be renewed.')
        this.renewalSequence = nextSequence
        if (epoch !== this.epoch || this.ending || this.view.mode !== 'work') return
        this.accept(reply.snapshot)
      } else {
        this.accept((await this.deps.native.command({ op: 'status' })).snapshot)
      }
    } catch {
      this.disarmWork()
      const snapshot = this.snapshot
      if (snapshot?.record.mode === 'work' && snapshot.record.identity === this.identity &&
          snapshot.record.phase === 'ended' && !snapshot.record.needsRestore && snapshot.safety.sleepDisabled === false) {
        this.accept(snapshot)
        return
      }
      await this.end('monitoring-unavailable')
    }
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message.slice(0, 240) : 'Lid-closed mode is unavailable.' }
export function lidHelperInstalled(): boolean { return existsSync(LID_HELPER) }
