import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test.each([0, 1])('installer retires an older helper with the verified replacement (restore exit %i)', restoreStatus => {
  const scratch = mkdtempSync(join(tmpdir(), 'cat-lid-upgrade-test-'))
  try {
    const helper = join(scratch, 'old-helper')
    const stage = join(scratch, 'verified payload')
    const events = join(scratch, 'events')
    mkdirSync(stage)
    writeFileSync(helper, '#!/bin/bash\necho journal-invalid >&2\nexit 1\n', { mode: 0o700 })
    writeFileSync(join(stage, 'helper'), `#!/bin/bash
set -euo pipefail
[[ $1 = --restore-for-uninstall ]]
printf 'restored-by-replacement\\n' >> "$events"
exit "$restore_status"
`, { mode: 0o700 })
    const installer = readFileSync(new URL('./install.sh', import.meta.url), 'utf8')
    // Exercise the upgrade handoff without administrator privileges or system jobs.
    const upgrade = installer.match(/^if \[\[ -e \$helper \]\]; then\n[\s\S]*?^fi$/m)?.[0]
    expect(upgrade).toBeDefined()
    const run = spawnSync('/bin/bash', ['-c', `set -euo pipefail
helper=$1
lid_payload_stage=$2
export events=$3 restore_status=$4
launchctl() { printf '%s\\n' "$*" >> "$events"; }
${upgrade!.replaceAll('/bin/launchctl', 'launchctl')}
`, '--', helper, stage, events, String(restoreStatus)], { encoding: 'utf8', timeout: 5000 })
    expect(run.error).toBeUndefined()
    expect(run.status).toBe(restoreStatus)
    expect(run.stderr).toBe('')
    expect(readFileSync(events, 'utf8').trim().split('\n')).toEqual(restoreStatus === 0
      ? ['restored-by-replacement', 'bootout system/com.catcode.lid-closed', 'bootout system/com.catcode.lid-closed.recovery']
      : ['restored-by-replacement'])
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
