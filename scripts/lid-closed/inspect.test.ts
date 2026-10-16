import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const runner = fileURLToPath(new URL('./inspect.ts', import.meta.url))
const macTest = process.platform === 'darwin' ? test : test.skip

// Owns the subprocess observation contract: unreadable authority stays unknown,
// nominal thermal readings never certify hardware, and output stays allowlisted.
// No existing feature test executes the native observation path.
macTest('reads native observations without treating missing authority as support', () => {
  const run = spawnSync(process.execPath, ['run', runner, '/private/tmp/cat-lid-missing-app.bundle'], {
    encoding: 'utf8', timeout: 70_000,
  })
  expect(run.status).toBe(0)
  const observation = JSON.parse(run.stdout)
  expect(observation.assertionAuthority.status).toBe('unavailable')
  expect(observation.assertionAuthority.errorCode).toBeNumber()
  expect(observation.powerControlSupported).toBe(false)
  expect(observation.hardwareQualified).toBe(false)
  expect(observation.thermalMonitoringQualified).toBe(false)
  expect(['nominal', 'fair', 'serious', 'critical', 'unknown']).toContain(observation.thermalCategory)
  expect(Date.parse(observation.observedAt)).toBeGreaterThan(0)
  expect(Object.keys(observation).sort()).toEqual([
    'assertionAuthority', 'battery', 'clamshellCausesSleep', 'hardwareQualified',
    'lidClosed', 'observedAt', 'osVersion', 'powerControlSupported', 'schemaVersion',
    'systemSleepDisabled', 'thermalCategory', 'thermalMonitoringQualified',
  ])
}, 70_000)

macTest('rejects extra arguments before reading an application', () => {
  const run = spawnSync(process.execPath, ['run', runner, 'one', 'two'], { encoding: 'utf8' })
  expect(run.status).toBe(2)
  expect(run.stdout).toBe('')
  expect(run.stderr).toContain('Usage:')
})

// The runner is the unit under test. The harmless native child is a failure
// producer fixture, not a power-control simulation or a release receipt.
macTest('forwards child failure output and preserves a failing exit status', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'cat-lid-forwarding-test-'))
  try {
    const fixtureRunner = join(scratch, 'inspect.ts')
    copyFileSync(runner, fixtureRunner)
    writeFileSync(join(scratch, 'probe-entitlements.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict/></plist>')
    writeFileSync(join(scratch, 'probe-authority.swift'),
      'import Foundation\nFileHandle.standardOutput.write(Data("child-failure-observation\\n".utf8))\nexit(1)\n')
    const run = spawnSync(process.execPath, ['run', fixtureRunner, '--probe-authority'], {
      encoding: 'utf8', timeout: 80_000,
    })
    expect(run.status).toBe(1)
    expect(run.stdout).toBe('child-failure-observation\n')
    expect(run.stderr).toContain('The assertion probe failed.')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}, 80_000)
