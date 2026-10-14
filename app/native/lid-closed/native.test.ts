import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Runs the real Swift transition and durable-journal owner. Power closures are
// failure producers; this test does not claim pmset, XPC, or hardware evidence.
const macTest = process.platform === 'darwin' ? test : test.skip
macTest('native lifecycle persists before effects and recovers interrupted authority', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'cat-lid-native-test-'))
  const source = fileURLToPath(new URL('.', import.meta.url))
  try {
    const binary = join(scratch, 'lifecycle-tests')
    const compiled = spawnSync('/usr/bin/swiftc', ['-module-cache-path', join(scratch, 'cache'),
      join(source, 'LidCore.swift'), join(source, 'LidCoreTests.swift'), '-o', binary], { encoding: 'utf8', timeout: 60_000 })
    if (compiled.error || compiled.status !== 0) throw new Error(compiled.stderr || 'Native compilation failed')
    expect(compiled.status).toBe(0)
    const run = spawnSync(binary, [join(scratch, 'state')], { encoding: 'utf8', timeout: 10_000 })
    if (run.error || run.status !== 0) throw new Error(run.stderr || `Native lifecycle failed: ${run.signal}`)
    expect(run.status).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toContain('PASS: durable activation')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}, 70_000)
