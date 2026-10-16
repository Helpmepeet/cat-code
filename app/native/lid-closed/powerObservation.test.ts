import { expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildLidHelper } from '../../scripts/build-lid-helper.js'
import { parsePowerObservation } from '../../main/powerObservation.js'

const macTest = process.platform === 'darwin' ? test : test.skip
macTest('native display checks run only for confirmed closure and never imply physical backlight safety', () => {
  const scratch = mkdtempSync('/private/tmp/cat-power-policy-')
  try {
    const source = new URL('./PowerObservation.swift', import.meta.url).pathname
    const tests = join(scratch, 'tests.swift')
    writeFileSync(tests, `import Foundation
import IOKit
func lidBoolean(_ entry: io_registry_entry_t, _ key: String) -> Bool? { nil }
@main struct Tests {
 static func main() {
  var reads = 0
  for closed: Bool? in [false, nil, true] {
   let value = powerObservation(lidClosed: closed, notifications: false, readDisplay: { reads += 1; return "software-awake" })
   precondition(value["display"] as? String == (closed == true ? "software-awake" : "not-observed"))
   precondition(value["physicalBacklight"] as? String == "unavailable")
   precondition(value["surfaceTemperature"] as? String == "unavailable")
  }
  precondition(reads == 1)
  print("PASS: closed-only display observation")
 }
}`)
    const binary = join(scratch, 'tests')
    const compiled = spawnSync('/usr/bin/swiftc', ['-module-cache-path', join(scratch, 'cache'), source, tests, '-o', binary], { encoding: 'utf8', timeout: 60_000 })
    if (compiled.error || compiled.status !== 0) throw new Error(compiled.stderr || String(compiled.error))
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 5000 })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('PASS: closed-only display observation')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}, 70_000)

macTest('bundled unprivileged observer reads native state, reconciles on heartbeat, and exits on EOF', async () => {
  buildLidHelper()
  const helper = new URL('./dist/helper', import.meta.url).pathname
  const once = spawnSync(helper, ['--observe-power', '--once'], { encoding: 'utf8', timeout: 5000 })
  expect(once.status).toBe(0)
  expect(parsePowerObservation(JSON.parse(once.stdout))).toBeDefined()
  const child = spawn(helper, ['--observe-power'], { stdio: 'pipe' })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
  const untilLines = async (count: number) => {
    for (let i = 0; i < 200 && output.trim().split('\n').filter(Boolean).length < count; i++) await Bun.sleep(10)
    expect(output.trim().split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(count)
  }
  try {
    await untilLines(1)
    expect(parsePowerObservation(JSON.parse(output.trim().split('\n')[0]!))?.lidNotifications).toBe(true)
    child.stdin.write('\n')
    await untilLines(2)
    child.stdin.end()
    expect(await Promise.race([exited, Bun.sleep(3000).then(() => 'timeout')])).toEqual({ code: 0, signal: null })
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited }
}, 70_000)
