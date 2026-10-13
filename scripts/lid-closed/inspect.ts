import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Keep compiler artifacts out of the shared checkout and the user's app state.
if (process.platform !== 'darwin') {
  console.error('Lid-closed inspection requires macOS.')
  process.exit(2)
}
if (process.argv.length > 3) {
  console.error('Usage: bun run scripts/lid-closed/inspect.ts [app-bundle | --probe-authority]')
  process.exit(2)
}
// The default path is read-only. This separate probe needs operator approval
// because successful authorization briefly creates a live power assertion.
const probe = process.argv[2] === '--probe-authority'
const scratch = mkdtempSync(join(tmpdir(), 'cat-lid-inspect-'))
try {
  const binary = join(scratch, 'inspect')
  const compiled = spawnSync('/usr/bin/swiftc', [
    '-module-cache-path', join(scratch, 'module-cache'),
    join(dirname(fileURLToPath(import.meta.url)), probe ? 'probe-authority.swift' : 'inspect.swift'),
    '-o', binary,
  ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1_048_576 })
  if (compiled.error || compiled.status !== 0) {
    console.error(compiled.stderr || 'Could not compile the read-only inspection.')
    process.exitCode = 1
  } else {
    if (probe) {
      const signed = spawnSync('/usr/bin/codesign', [
        '--force', '--sign', '-', '--entitlements',
        join(dirname(fileURLToPath(import.meta.url)), 'probe-entitlements.plist'), binary,
      ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536 })
      if (signed.error || signed.status !== 0) throw new Error('Could not sign the authority probe.')
    }
    const inspected = spawnSync(binary, probe ? ['--probe-authority'] : process.argv[2] ? [resolve(process.argv[2])] : [], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536,
    })
    if (inspected.error || inspected.status !== 0) {
      if (probe && inspected.stdout) process.stdout.write(inspected.stdout)
      if (probe && inspected.signal) console.error(`The assertion probe exited on ${inspected.signal}.`)
      console.error(inspected.stderr || (probe
        ? 'The assertion probe failed. Check any reported creation and release results.'
        : 'Could not read power observations.'))
      process.exitCode = 1
    } else process.stdout.write(inspected.stdout)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Power inspection failed.')
  process.exitCode = 1
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
