import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export const POWER_OBSERVATION_LIMITATIONS = {
  physicalBacklightPower: 'unavailable', surfaceTemperatures: 'unavailable',
  closedLidCoolingAndHeatTransfer: 'requires-physical-testing', thermal: 'system-pressure-not-surface-temperature',
  assertion: 'process-health-not-os-assertion-verification', lidCloseSleepOverride: false,
} as const

export type PowerObservation = {
  version: 1
  lid: 'open' | 'closed' | 'unknown'
  display: 'not-observed' | 'unknown' | 'software-awake' | 'software-asleep'
  thermal: 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown'
  lidNotifications: boolean
  physicalBacklight: 'unavailable'
  surfaceTemperature: 'unavailable'
}

/** Fixed local native vocabulary, never arbitrary helper JSON in diagnostics. */
export function parsePowerObservation(value: unknown): PowerObservation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const v = value as Record<string, unknown>
  if (Object.keys(v).length !== 7 || v.version !== 1 ||
      typeof v.lid !== 'string' || !['open', 'closed', 'unknown'].includes(v.lid) ||
      typeof v.display !== 'string' || !['not-observed', 'unknown', 'software-awake', 'software-asleep'].includes(v.display) ||
      typeof v.thermal !== 'string' || !['nominal', 'fair', 'serious', 'critical', 'unknown'].includes(v.thermal) ||
      typeof v.lidNotifications !== 'boolean' || v.physicalBacklight !== 'unavailable' || v.surfaceTemperature !== 'unavailable' ||
      (v.lid === 'closed' ? v.display === 'not-observed' : v.display !== 'not-observed')) return
  return { version: 1, lid: v.lid as PowerObservation['lid'], display: v.display as PowerObservation['display'],
    thermal: v.thermal as PowerObservation['thermal'], lidNotifications: v.lidNotifications,
    physicalBacklight: 'unavailable', surfaceTemperature: 'unavailable' }
}

export const unknownPowerObservation = (): PowerObservation => ({ version: 1, lid: 'unknown', display: 'not-observed',
  thermal: 'unknown', lidNotifications: false, physicalBacklight: 'unavailable', surfaceTemperature: 'unavailable' })

// One short-lived, unprivileged instance per app, not one per session or a
// launch service. EOF and its own heartbeat deadline independently clean up.
export class NativePowerObservation {
  private child?: ChildProcessWithoutNullStreams
  private timer?: ReturnType<typeof setTimeout>
  private pulse?: ReturnType<typeof setInterval>
  private wanted = false
  private failures = 0
  private consecutiveFailures = 0
  private buffer = ''
  private observation = unknownPowerObservation()
  private observedAt?: number
  private stopping = false
  private intentionallyStopped = false

  constructor(private readonly helper: string, private readonly changed: (reason: string) => void,
    private readonly launch = () => spawn(helper, ['--observe-power'], { stdio: 'pipe' })) {}

  setActive(active: boolean): void {
    if (this.wanted === active) return
    this.wanted = active
    if (active) this.start()
    else this.stop()
  }
  read() {
    const current = this.wanted && this.observedAt !== undefined && Date.now() - this.observedAt < 150_000
    return { status: !this.wanted ? 'inactive' : current ? 'observing' : 'unavailable',
      observation: current ? { ...this.observation } : unknownPowerObservation(),
      observedAt: current ? this.observedAt! : null, failures: this.failures }
  }
  private start(): void {
    if (!this.wanted || this.child || this.timer) return
    let child: ChildProcessWithoutNullStreams
    try { child = this.launch() } catch { this.failed(); return }
    this.child = child; this.stopping = false; this.intentionallyStopped = false; this.buffer = ''; this.observedAt = undefined
    let healthySince: number | undefined
    child.unref()
    const timeout = setTimeout(() => { if (this.observedAt === undefined) this.retire(child) }, 5000)
    timeout.unref()
    this.pulse = setInterval(() => {
      if (this.stopping) { child.kill('SIGKILL'); return }
      if (this.observedAt !== undefined && Date.now() - this.observedAt >= 150_000) { this.retire(child); return }
      child.stdin.write('\n')
    }, 60_000)
    this.pulse.unref()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.stopping || this.child !== child) return
      this.buffer += chunk
      if (Buffer.byteLength(this.buffer) > 4096) { this.retire(child); return }
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1)
        let observation: PowerObservation | undefined
        try { observation = parsePowerObservation(JSON.parse(line)) } catch { /* Invalid observation retires this generation. */ }
        if (!observation) { this.retire(child); return }
        const different = JSON.stringify(this.observation) !== JSON.stringify(observation)
        const first = this.observedAt === undefined
        this.observation = observation; this.observedAt = Date.now()
        healthySince ??= this.observedAt
        // A startup frame alone does not make an immediately crashing child healthy.
        if (this.observedAt - healthySince >= 60_000) this.consecutiveFailures = 0
        if (different || first) this.changed('hardware-state')
      }
    })
    child.stderr.resume()
    child.stdin.on('error', () => this.retire(child))
    child.on('error', () => { if (child.pid !== undefined) this.retire(child) })
    // close also covers spawn errors that never emit exit.
    child.once('close', () => {
      clearTimeout(timeout)
      if (this.child !== child) return
      if (this.pulse) clearInterval(this.pulse)
      this.pulse = undefined; this.child = undefined; this.observedAt = undefined
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      if (this.wanted) {
        if (this.intentionallyStopped) this.start()
        else this.failed()
      }
    })
  }
  private failed(): void {
    this.failures++
    this.consecutiveFailures++
    this.changed('hardware-observer-unavailable')
    if (!this.wanted || this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; this.start() }, Math.min(60_000, 1000 * 2 ** Math.min(this.consecutiveFailures - 1, 6)))
    this.timer.unref()
  }
  private retire(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child || this.stopping) return
    this.stopping = true; this.observedAt = undefined
    child.stdin.end()
    // Keep the child owned until close, including unsuccessful termination.
    this.timer = setTimeout(() => { this.timer = undefined; if (this.child === child) child.kill('SIGKILL') }, 2000)
    this.timer.unref()
  }
  private stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.child) {
      this.intentionallyStopped = true
      if (this.stopping) this.child.kill('SIGKILL')
      else this.retire(this.child)
    }
    this.observedAt = undefined
  }
}
