import { spawn } from 'child_process'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { logForDebugging } from '../utils/debug.js'
import { SleepAssertionOwner } from '../../app/shared/sleepAssertion.js'

const owner = new SleepAssertionOwner({
  enabled: process.platform === 'darwin',
  // Only idle sleep is inhibited. Timeout and parent monitoring bound orphan lifetime.
  spawn: () => spawn('/usr/bin/caffeinate', ['-i', '-t', '300', '-w', String(process.pid)], { stdio: 'ignore' }),
  setTimeout,
  clearTimeout,
  log: logForDebugging,
})
let cleanupRegistered = false

export function startPreventSleep(): void {
  if (!cleanupRegistered && process.platform === 'darwin') {
    cleanupRegistered = true
    registerCleanup(async () => { owner.forceStop() })
  }
  owner.start()
}

export function stopPreventSleep(): void { owner.stop() }
export function forceStopPreventSleep(): void { owner.forceStop() }
export function setPreventSleepSuppressed(value: boolean): void { owner.setSuppressed(value) }

/** Bounded process lifecycle diagnostics, not an observation of OS assertion state. */
export function getPreventSleepDiagnostics() { return owner.read() }
