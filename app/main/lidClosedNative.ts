import { spawn, execFile } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'

const run = promisify(execFile)
declare const __CATCODE_LID_ASSET_SHA256__: Record<string, string> | undefined
export const LID_HELPER = '/Library/PrivilegedHelperTools/com.catcode.lid-closed'
async function verifiedLidAssets(assets: string): Promise<Record<string, Buffer>> {
  if (typeof __CATCODE_LID_ASSET_SHA256__ === 'undefined') throw new Error('Rebuild the packaged app before setting up lid-closed mode.')
  const result: Record<string, Buffer> = {}
  for (const name of ['helper', 'install.sh', 'uninstall.sh']) {
    const bytes = await readFile(join(assets, name))
    if (createHash('sha256').update(bytes).digest('hex') !== __CATCODE_LID_ASSET_SHA256__[name]) throw new Error('Lid-closed setup files changed. Rebuild Cat Code before setting up again.')
    result[name] = bytes
  }
  return result
}
export async function lidHelperCurrent(assets: string, helper = LID_HELPER): Promise<boolean> {
  const verified = await verifiedLidAssets(assets)
  try { return (await readFile(helper)).equals(verified.helper!) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
export type LidNativeSnapshot = {
  record: { phase: string; identity?: string; began: number; deadline: number; allowance: number;
    reason?: string; error?: string; needsRestore: boolean; sleepRequested: boolean;
    sleepRequestAttempted: boolean; sleepRequestSucceeded?: boolean; thermalRestart?: boolean }
  safety: { sleepDisabled?: boolean; lidClosed?: boolean; batteryPercent?: number; onBattery?: boolean; thermal: string }
  remainingSeconds: number
  hardwareQualified: boolean
  error?: string
}
export type LidNativeReply = { ok: boolean; snapshot?: LidNativeSnapshot; error?: string }
export function parseLidNativeReply(value: unknown): LidNativeReply {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid helper response')
  const r = value as Record<string, unknown>
  if (Object.keys(r).some(key => !['ok','snapshot','error'].includes(key)) || typeof r.ok !== 'boolean' ||
      r.error !== undefined && (typeof r.error !== 'string' || r.error.length > 512)) throw new Error('Invalid helper response')
  if (r.snapshot !== undefined) {
    const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
    const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
    const optionalText = (value: unknown, max: number) => value === undefined || typeof value === 'string' && value.length <= max
    const s = r.snapshot
    if (!object(s) || Object.keys(s).some(key => !['record','safety','remainingSeconds','hardwareQualified','error'].includes(key)) ||
        !object(s.record) || !object(s.safety) || !finite(s.remainingSeconds) || (s.remainingSeconds as number) > 7200 ||
        typeof s.hardwareQualified !== 'boolean' || !optionalText(s.error, 512)) throw new Error('The sleep helper returned unreadable status')
    const record = s.record; const safety = s.safety
    if (!['off','starting','active','restoring','unresolved','lid-open','ended'].includes(String(record.phase)) ||
        !['began','deadline','allowance'].every(key => finite(record[key])) || (record.allowance as number) > 7200 ||
        !['needsRestore','sleepRequested','sleepRequestAttempted'].every(key => typeof record[key] === 'boolean') ||
        record.sleepRequestSucceeded !== undefined && typeof record.sleepRequestSucceeded !== 'boolean' ||
        !optionalText(record.reason, 80) || !optionalText(record.error, 512) ||
        record.identity !== undefined && (typeof record.identity !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(record.identity)) ||
        record.needsRestore && record.identity === undefined ||
        !['sleepDisabled','lidClosed','onBattery'].every(key => safety[key] === undefined || typeof safety[key] === 'boolean') ||
        safety.batteryPercent !== undefined && (!finite(safety.batteryPercent) || (safety.batteryPercent as number) > 100) ||
        typeof safety.thermal !== 'string' || !['nominal','fair','serious','critical','unknown'].includes(safety.thermal)) throw new Error('The sleep helper returned unreadable status')
  }
  return r as LidNativeReply
}
export function lidRestored(s: LidNativeSnapshot | undefined): boolean {
  return !!s && !s.error && ['off','ended','lid-open'].includes(s.record.phase) && !s.record.needsRestore && s.safety.sleepDisabled === false
}

export class LidNativeClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private pending: { resolve(value: LidNativeReply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined
  private buffer = ''
  private chain: Promise<unknown> = Promise.resolve()
  command(value: { op: 'status' | 'pulse' | 'start' | 'adjust' | 'stop' | 'sleep' | 'retry' | 'dismiss'; identity?: string; allowance?: number }): Promise<LidNativeReply> {
    const call = this.chain.catch(() => {}).then(() => this.request(value))
    this.chain = call
    return call
  }
  close(): void {
    const child = this.child; this.child = undefined; this.buffer = ''
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('Helper unavailable')); this.pending = undefined }
    if (child) { child.stdin.end(); if (child.exitCode === null && child.signalCode === null) child.kill() }
  }
  private request(value: object): Promise<LidNativeReply> {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        const child = spawn(LID_HELPER, ['--client'], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: 'pipe' })
        this.child = child
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          if (this.child !== child) return
          this.buffer += chunk
          if (Buffer.byteLength(this.buffer) > 16_384) { this.close(); return }
          const end = this.buffer.indexOf('\n')
          if (end < 0) return
          const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1)
          const pending = this.pending
          if (!pending || this.buffer.length) { this.close(); return }
          this.pending = undefined; clearTimeout(pending.timer)
          try {
            const reply = parseLidNativeReply(JSON.parse(line))
            pending.resolve(reply)
            // An invalidated XPC connection cannot recover in the same bridge.
            if (!reply.snapshot) this.close()
          }
          catch { pending.reject(new Error('Invalid helper response')); this.close() }
        })
        child.stderr.resume()
        child.on('error', () => { if (this.child === child) this.close() })
        child.on('exit', () => { if (this.child === child) this.close() })
        child.stdin.on('error', () => { if (this.child === child) this.close() })
      }
      const timer = setTimeout(() => this.close(), 2000)
      this.pending = { resolve, reject, timer }
      try { this.child.stdin.write(JSON.stringify(value) + '\n') }
      catch { this.close() }
    })
  }
}

export type LidHardware = { qualified: boolean; evidence: string; model: string; osBuild: string;
  safety: LidNativeSnapshot['safety'] }
export async function inspectLidHardware(assets: string): Promise<LidHardware> {
  await verifiedLidAssets(assets)
  const result = await run(join(assets, 'helper'), ['--hardware'], { timeout: 5000, maxBuffer: 16_384, env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
  const data = JSON.parse(result.stdout) as LidHardware
  if (typeof data.qualified !== 'boolean' || typeof data.evidence !== 'string' || !data.safety || typeof data.model !== 'string' || typeof data.osBuild !== 'string') throw new Error('Safety monitoring unavailable')
  return data
}
function quote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'" }
async function requirement(path: string): Promise<string> {
  await run('/usr/bin/codesign', ['--verify','--strict',path], { timeout: 10_000, maxBuffer: 16_384 })
  const r = await run('/usr/bin/codesign', ['-d','--verbose=4',path], { timeout: 5000, maxBuffer: 16_384 })
  const cdhash = r.stderr.match(/^CDHash=([0-9a-f]+)$/m)?.[1]
  if (!cdhash) throw new Error('App signature unavailable')
  return `cdhash H"${cdhash}"`
}
export class LidSetupCancelled extends Error {}
// The administrator executes only the protected, digest-verified installer.
// Renderer input never supplies a command, path, caller identity or signature.
export async function installLidHelper(assets: string, recoveryOnly = false): Promise<void> {
  const verified = await verifiedLidAssets(assets)
  const hardware = await inspectLidHardware(assets)
  if (!hardware.qualified && !recoveryOnly) throw new Error('This Mac and macOS version are not qualified')
  const prepared = await mkdtemp('/private/tmp/cat-lid-install-')
  await chmod(prepared, 0o700)
  const payload: Record<string, Buffer> = { helper: verified.helper!, 'uninstall.sh': verified['uninstall.sh']! }
  await writeFile(join(prepared, 'helper'), payload.helper!, { mode: 0o700 })
  payload['configuration.json'] = Buffer.from(JSON.stringify({ version: 3, uid: process.getuid!(),
    access: 'account', bridgeRequirement: await requirement(join(prepared,'helper')),
    experimentUntil: 0,
    // Qualification only restricts authority: normal preset/caller/hardware
    // validation remains, while root admits one lease capped at 60 seconds.
    ...(process.env.CATCODE_LID_CLOSED_TRIAL === '1' ? { applicationTrialUntil: Date.now() / 1000 + 180 } : {}),
    qualificationEvidence: hardware.evidence }) + '\n')
  for (const [name,label,arg,mach] of [
    ['daemon.plist','com.catcode.lid-closed','--daemon',true],
    ['recovery.plist','com.catcode.lid-closed.recovery','--watch',false],
  ] as const) {
    payload[name] = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${LID_HELPER}</string><string>${arg}</string></array><key>UserName</key><string>root</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>1</integer>${mach ? '<key>MachServices</key><dict><key>com.catcode.lid-closed</key><true/></dict>' : ''}</dict></plist>\n`)
  }
  // Approve immutable verified/generated bytes, never mutable account-owned
  // staging. Substitution after this point must fail the root installer pins.
  const names = ['helper','configuration.json','daemon.plist','recovery.plist','uninstall.sh']
  const sums = names.map(name => `${createHash('sha256').update(payload[name]!).digest('hex')}  ${name}`)
  for (const name of names.filter(name => name !== 'helper')) await writeFile(join(prepared, name), payload[name]!, { mode: 0o600 })
  const installer = verified['install.sh']!.toString('utf8').replace('__EXPECTED_PAYLOAD__',sums.join('\n'))
  await writeFile(join(prepared,'install.sh'),installer,{ mode: 0o700 })
  const hash = createHash('sha256').update(installer).digest('hex')
  const script = `set -euo pipefail
lid_root_stage=$(/usr/bin/mktemp -d /private/tmp/cat-lid-root.XXXXXX)
trap '/bin/rm -rf "$lid_root_stage"' EXIT
/usr/bin/install -o root -g wheel -m 0600 ${quote(join(prepared,'install.sh'))} "$lid_root_stage/install.sh"
/bin/echo '${hash}  '"$lid_root_stage/install.sh" | /usr/bin/shasum -a 256 -c -
/bin/bash "$lid_root_stage/install.sh" ${quote(prepared)}`
  const appleScript = `do shell script ${JSON.stringify('/bin/bash -c ' + quote(script))} with administrator privileges`
  try {
    await run('/usr/bin/osascript', ['-e',appleScript], { timeout: 120_000, maxBuffer: 32_768, env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
  } catch (error) {
    const failure = error as { stderr?: string; killed?: boolean; signal?: string }
    if (failure.stderr?.includes('(-128)')) throw new LidSetupCancelled('Administrator setup was cancelled.')
    if (failure.killed || failure.signal) throw new Error('Administrator setup timed out. Try again when you are ready.')
    throw new Error('Lid-closed setup failed. Check normal sleep before trying again.')
  }
}
