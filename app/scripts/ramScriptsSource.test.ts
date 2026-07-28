/**
 * The RAM probes SIGKILL processes, so they are the one place in the repo where
 * a stale pid is dangerous: fleet victims are designed to exit early, freeing
 * their number for the OS to hand to anything else on the machine (including
 * the operator's dev app) for the rest of a multi-minute run. Every kill must
 * therefore go through the Bun child handle, and raw pids may only be signalled
 * when they were captured from a parent that was alive at the time.
 *
 * Source-shape assertions: these scripts spawn real sidecars and kill process
 * trees, so exercising them from a test is not an option.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (name: string): string =>
  readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

const fleet = read('ram-fleet.ts')
const probe = read('ram-probe.ts')

test('ram-fleet kills fleet members by handle, never by a recycled pid', () => {
  expect(fleet).not.toContain('killTree')
  // The one guarded entry point: exited members are skipped, and the parent is
  // signalled through Bun rather than by number.
  expect(fleet).toContain('function killSidecar(sc: Sidecar): void')
  expect(fleet).toContain('if (hasExited(sc.proc)) return')
  expect(fleet).toContain('sc.proc.kill(9)')
  // Both cleanup paths (signal handler and the run's finally) use it.
  expect(fleet.match(/for \(const sc of fleet\) killSidecar\(sc\)/g)).toHaveLength(2)
  // Parked victims are neither inspected nor watched: their pid is not theirs.
  expect(fleet).toContain('if (!pid || hasExited(sc.proc)) continue')
})

test('ram-probe kills its sidecar by handle and skips a self-exited one', () => {
  expect(probe).not.toContain('killTree')
  expect(probe).toContain('function killSidecar(proc: ReturnType<typeof bunSpawn>): void')
  expect(probe).toContain('if (hasExited(proc)) return')
  expect(probe).toContain('proc.kill(9)')
  expect(probe).toContain('if (activeProc) killSidecar(activeProc)')
  expect(probe).toContain('if (proc && hasExited(proc))')
})

test('raw pid SIGKILL exists in exactly one guarded helper per probe', () => {
  for (const source of [fleet, probe]) {
    expect(source.match(/execFileSync\('kill'/g)).toHaveLength(1)
    expect(source).toContain('function killPid(pid: number): void')
    // killPid is only reached for descendants gathered from a live parent.
    expect(source).toContain('for (const kid of descendantPids(pid)) killPid(kid)')
  }
})

test('probe scratch output defaults inside the gitignored app package', () => {
  for (const name of ['ram-fleet.ts', 'ram-probe.ts', 'ram-measure.ts']) {
    const source = read(name)
    expect(source).not.toContain("join(process.cwd(), '.ram-scratch'")
    expect(source).toContain("join(here, '..', '.ram-scratch'")
  }
  expect(read('../.gitignore')).toContain('.ram-scratch/')
})
