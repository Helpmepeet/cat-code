import type { ChildProcess } from 'child_process'

// Shared lifecycle only: neither the Electron owner nor terminal wrapper loads
// the other's runtime, logging, or cleanup machinery.
const RENEW_MS = 240_000
const SPAWN_TIMEOUT_MS = 10_000
const STABLE_PROCESS_MS = 10_000
const MAX_RETRY_MS = 30_000

type Timer = ReturnType<typeof setTimeout>
type Entry = { child: ChildProcess; state: 'starting' | 'active' | 'retiring'; timer?: Timer }

export interface PreventSleepDependencies {
  enabled: boolean
  spawn: () => ChildProcess
  setTimeout: (callback: () => void, ms: number) => Timer
  clearTimeout: (timer: Timer) => void
  log: (message: string) => void
}

export type SleepAssertionDependencies = PreventSleepDependencies

export class SleepAssertionOwner {
  private readonly owner: ReturnType<typeof createPreventSleepOwner>

  constructor(deps: SleepAssertionDependencies) {
    this.owner = createPreventSleepOwner(deps)
  }

  start(): void { this.owner.start() }
  stop(): void { this.owner.stop() }
  forceStop(): void { this.owner.forceStop() }
  setSuppressed(value: boolean): void { this.owner.setSuppressed(value) }
  read() { return this.owner.snapshot() }
}

/** Process health is not proof that macOS installed a power assertion. */
export function createPreventSleepOwner(deps: PreventSleepDependencies) {
  let references = 0
  let suppressed = false
  let retry: Timer | undefined
  let renewal: Timer | undefined
  let failures = 0
  let recoveries = 0
  let consecutiveFailures = 0
  const children = new Set<Entry>()
  const desired = () => deps.enabled && references > 0 && !suppressed
  const later = (callback: () => void, ms: number) => {
    const timer = deps.setTimeout(callback, ms)
    timer.unref()
    return timer
  }
  function cancelTimers() {
    if (retry) deps.clearTimeout(retry)
    if (renewal) deps.clearTimeout(renewal)
    retry = renewal = undefined
  }
  function failure(message: string) {
    failures++
    consecutiveFailures++
    deps.log(message)
  }
  function retire(entry: Entry) {
    entry.state = 'retiring'
    if (entry.timer) deps.clearTimeout(entry.timer)
    entry.timer = undefined
    try {
      if (!entry.child.kill('SIGKILL')) failure('caffeinate termination was not accepted')
    } catch (error) {
      failure(`caffeinate termination failed: ${String(error)}`)
    }
    // Retain ownership until exit, even when kill reports success.
  }
  function scheduleRetry() {
    if (retry || !desired()) return
    const delay = Math.min(MAX_RETRY_MS, 250 * 2 ** Math.min(consecutiveFailures, 7))
    retry = later(() => {
      retry = undefined
      for (const entry of children) if (entry.state === 'retiring') retire(entry)
      ensure(renewal === undefined && [...children].some(entry => entry.state === 'active'))
    }, delay)
  }
  function ensure(renew = false) {
    if (!desired() || retry !== undefined) return
    if ([...children].some(entry => entry.state === 'starting')) return
    if (!renew && [...children].some(entry => entry.state === 'active')) {
      if ([...children].some(entry => entry.state === 'retiring')) scheduleRetry()
      return
    }
    if (children.size >= 2) { scheduleRetry(); return }
    let child: ChildProcess
    try { child = deps.spawn() } catch (error) {
      failure(`caffeinate spawn failed: ${String(error)}`)
      scheduleRetry()
      return
    }
    const entry: Entry = { child, state: 'starting' }
    children.add(entry)
    child.unref()
    child.once('spawn', () => {
      if (entry.state !== 'starting') return
      if (entry.timer) deps.clearTimeout(entry.timer)
      entry.timer = undefined
      if (!desired()) { retire(entry); return }
      entry.state = 'active'
      // An executable that starts but immediately exits is still failing.
      // Reset backoff only after sustained liveness, not on each spawn event.
      entry.timer = later(() => {
        entry.timer = undefined
        if (consecutiveFailures) { recoveries++; deps.log('caffeinate recovered') }
        consecutiveFailures = 0
      }, STABLE_PROCESS_MS)
      if (retry) deps.clearTimeout(retry)
      retry = undefined
      for (const previous of children) if (previous !== entry) retire(previous)
      if (renewal) deps.clearTimeout(renewal)
      renewal = later(() => { renewal = undefined; ensure(true) }, RENEW_MS)
      if (children.size > 1) scheduleRetry()
    })
    child.on('error', error => {
      failure(`caffeinate process error: ${error.message}`)
      if (child.pid === undefined) {
        if (entry.timer) deps.clearTimeout(entry.timer)
        children.delete(entry)
      } else if (entry.state !== 'retiring') retire(entry)
      scheduleRetry()
    })
    const finished = () => {
      if (!children.delete(entry)) return
      if (entry.timer) deps.clearTimeout(entry.timer)
      const unexpected = entry.state !== 'retiring'
      if (unexpected && desired()) failure('caffeinate exited unexpectedly')
      if (desired()) scheduleRetry()
    }
    child.once('exit', finished)
    child.once('close', finished)
    entry.timer = later(() => {
      entry.timer = undefined
      failure('caffeinate spawn confirmation timed out')
      retire(entry)
      scheduleRetry()
    }, SPAWN_TIMEOUT_MS)
  }
  function reconcile() {
    if (desired()) ensure()
    else {
      cancelTimers()
      for (const entry of children) retire(entry)
    }
  }
  return {
    start() { references++; reconcile() },
    stop() { references = Math.max(0, references - 1); reconcile() },
    forceStop() { references = 0; reconcile() },
    setSuppressed(value: boolean) { suppressed = value; reconcile() },
    snapshot() {
      const entries = [...children]
      return Object.freeze({
        desired: desired(), references, suppressed,
        active: entries.filter(entry => entry.state === 'active').length,
        starting: entries.filter(entry => entry.state === 'starting').length,
        retiring: entries.filter(entry => entry.state === 'retiring').length,
        tracked: entries.length, failures, recoveries,
        retryPending: retry !== undefined,
        health: !desired() ? 'idle' : entries.some(entry => entry.state === 'active') ? 'process-running' : 'recovering',
      })
    },
  }
}
