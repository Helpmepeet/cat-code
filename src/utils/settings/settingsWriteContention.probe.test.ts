/**
 * Settings-write cross-process contention probe (desktop-app migration,
 * Phase-3 rider — docs/migration/STATUS.md P3-5a/P3-8: "the engine-side
 * settings-write LOST-UPDATE is proven real").
 *
 * BACKGROUND: N-process (one engine process per session) means two engine
 * processes with the SAME cwd share one `settings.local.json`. A live GUI
 * run (P3-5a, 2026-07-05) proved that two "always allow" approvals ~1.4s
 * apart lost a rule: `updateSettingsForSource` (settings.ts) did an
 * uncached read, merged in-memory, then wrote — with no cross-process lock.
 * The write itself was atomic (no torn JSON), but the read-modify-write was
 * not serialized, so the second writer's file-read missed the first
 * writer's not-yet-flushed change and overwrote it on write-back.
 *
 * FIX (two parts, both required):
 *  1. updateSettingsForSource takes a proper-lockfile lock around the
 *     read-merge-write critical section, the same idiom already used by
 *     saveConfigWithLock (config.ts) and the host registry
 *     (app/host/registry.ts).
 *  2. The final rule array is computed UNDER that lock via the
 *     SettingsUpdater form of updateSettingsForSource. The lock alone was
 *     proven insufficient (~1/3 of probe runs still lost a rule): callers
 *     used to pre-compute the full array from a pre-lock read, and the
 *     merge customizer replaces arrays wholesale, so the stale array
 *     clobbered the other process's just-landed rule despite fully
 *     serialized file access.
 *
 * WHAT THIS PROBE DOES: spawns TWO real Bun child processes
 * (settingsWriteContention.probe.child.ts) that both call the real
 * `persistPermissionUpdate` (the exact production call the P3-5a run hit)
 * against ONE shared localSettings file, released at once via a file
 * barrier. PASS CRITERIA: both rules are present on disk afterward — no
 * lost update.
 *
 * Reproduce:  bun test src/utils/settings/settingsWriteContention.probe.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'

const CHILD_ENTRY = join(
  import.meta.dir,
  'settingsWriteContention.probe.child.ts',
)

const scratch = mkdtempSync(join(tmpdir(), 'settings-write-race-'))

type ChildResult = { ok: boolean; error?: string }

function spawnChild(
  cwd: string,
  env: Record<string, string>,
): { result: Promise<ChildResult> } {
  const proc = Bun.spawn({
    cmd: [process.execPath, 'run', CHILD_ENTRY],
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'development',
      CLAUDE_CONFIG_DIR: join(cwd, 'probe-config'),
      PROBE_CWD: cwd,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const result = (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    const line = stdout.split('\n').find(l => l.startsWith('RESULT:'))
    if (!line) {
      throw new Error(
        `child printed no RESULT line.\nstdout: ${stdout}\nstderr: ${stderr}`,
      )
    }
    return JSON.parse(line.slice('RESULT:'.length)) as ChildResult
  })()
  return { result }
}

function readyMarkers(goFile: string): number {
  const base = basename(goFile)
  try {
    return readdirSync(dirname(goFile)).filter(f => f.startsWith(`${base}.ready.`))
      .length
  } catch {
    return 0
  }
}

/** Release `count` contenders at once: wait for their ready markers, then GO. */
async function releaseBarrier(goFile: string, count = 2): Promise<void> {
  const start = Date.now()
  while (readyMarkers(goFile) < count) {
    if (Date.now() - start > 30_000) {
      throw new Error('timed out waiting for contenders to become ready')
    }
    await Bun.sleep(20)
  }
  writeFileSync(goFile, 'go')
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('settings-write contention (two real processes, one localSettings file)', () => {
  test('processes saving through different symlinks serialize updates to their shared target', async () => {
    const targetPath = join(scratch, 'shared-target.json')
    const cwdA = join(scratch, 'alias-a')
    const cwdB = join(scratch, 'alias-b')
    const goFile = join(scratch, 'go-settings-alias-write')
    const holdLockFile = join(scratch, 'alias-target-locked')
    writeFileSync(targetPath, '{}\n')
    for (const cwd of [cwdA, cwdB]) {
      mkdirSync(join(cwd, '.cat-code'), { recursive: true })
      symlinkSync(targetPath, join(cwd, '.cat-code', 'settings.local.json'))
    }

    const a = spawnChild(cwdA, {
      PROBE_RULE: 'echo alias-a',
      PROBE_GO_FILE: goFile,
      PROBE_HOLD_LOCK_FILE: holdLockFile,
    })
    const b = spawnChild(cwdB, {
      PROBE_RULE: 'echo alias-b',
      PROBE_GO_FILE: goFile,
      PROBE_WAIT_FOR_LOCK_FILE: holdLockFile,
    })
    await releaseBarrier(goFile)
    const [resultA, resultB] = await Promise.all([a.result, b.result])

    expect(resultA.ok).toBe(true)
    expect(resultB.ok).toBe(true)
    const written = JSON.parse(readFileSync(targetPath, 'utf8'))
    expect(written.permissions.allow).toEqual([
      'Bash(echo alias-a)',
      'Bash(echo alias-b)',
    ])
    for (const cwd of [cwdA, cwdB]) {
      expect(
        lstatSync(join(cwd, '.cat-code', 'settings.local.json')).isSymbolicLink(),
      ).toBe(true)
    }
  })

  test('two processes adding different always-allow rules to the same cwd both land', async () => {
    const cwd = join(scratch, 'shared-cwd')
    const settingsPath = join(cwd, '.cat-code', 'settings.local.json')
    const goFile = join(scratch, 'go-settings-write')

    const a = spawnChild(cwd, {
      PROBE_RULE: 'curl -s https://example.com/a',
      PROBE_GO_FILE: goFile,
    })
    const b = spawnChild(cwd, {
      PROBE_RULE: 'curl -s https://example.com/b',
      PROBE_GO_FILE: goFile,
    })
    await releaseBarrier(goFile)
    const [resultA, resultB] = await Promise.all([a.result, b.result])

    expect(resultA.ok).toBe(true)
    expect(resultB.ok).toBe(true)

    expect(existsSync(settingsPath)).toBe(true)
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      permissions?: { allow?: string[] }
    }
    const rules = written.permissions?.allow ?? []

    // The lost-update this probe exists to catch: only one contender's rule
    // survives because the other's read-merge-write raced the first's.
    expect(rules).toContain('Bash(curl -s https://example.com/a)')
    expect(rules).toContain('Bash(curl -s https://example.com/b)')
  })
})
