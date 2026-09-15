/**
 * The RAM probes SIGKILL processes, so they are the one place in the repo where
 * a stale pid is dangerous: fleet victims are designed to exit early, freeing
 * their number for the OS to hand to anything else on the machine (including
 * the operator's dev app) for the rest of a multi-minute run. Cleanup must
 * therefore use an ownership record established at spawn: Bun child handles in
 * the fleet, and a verified detached process group in the packaged-turn probe.
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
const trajectory = read('renderer-memory-trajectory.ts')

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

test('ram-probe owns a detached process group and skips a self-exited one', () => {
  expect(probe).not.toContain('killTree')
  expect(probe).not.toContain("execFileSync('pgrep'")
  expect(probe).toContain('detached: true')
  expect(probe).toContain('function killSidecar(proc: ChildProcess): boolean')
  expect(probe).toContain('if (hasExited(proc)) return false')
  expect(probe).toContain('const processGroupId = readProcessGroupId(pid)')
  expect(probe).toContain('if (processGroupId !== pid)')
  expect(probe).toContain("process.kill(-processGroupId, 'SIGKILL')")
  expect(probe).toContain('processGroupOwnershipVerified = killSidecar(proc)')
  expect(probe).toContain('if (proc && hasExited(proc))')
})

test('raw pid SIGKILL remains confined to the legacy fleet helper', () => {
  expect(fleet.match(/execFileSync\('kill'/g)).toHaveLength(1)
  expect(fleet).toContain('function killPid(pid: number): void')
  expect(fleet).toContain('for (const kid of descendantPids(pid)) killPid(kid)')
  expect(probe).not.toContain("execFileSync('kill'")
  expect(probe).not.toContain('function killPid(')
  expect(probe).toContain('ownedPids = [...new Set([parentPid, ...lastOwnedProcessGroupPids])]')
})

test('probe scratch output defaults inside the gitignored app package', () => {
  for (const name of ['ram-fleet.ts', 'ram-probe.ts', 'ram-measure.ts']) {
    const source = read(name)
    expect(source).not.toContain("join(process.cwd(), '.ram-scratch'")
    expect(source).toContain("join(here, '..', '.ram-scratch'")
  }
  expect(read('../.gitignore')).toContain('.ram-scratch/')
})

test('ram-probe real-turn acceptance is packaged, attached, and never the probe fixture', () => {
  expect(probe).toContain("const realTurn = args['real-turn'] === 'true'")
  expect(probe).toContain("args.mode !== 'real' || !attached || !packagedApp")
  expect(probe).toContain(
    "'ram-probe: --real-turn requires --mode real --attach --packaged-app <path>'",
  )
  expect(probe).toContain("import { resolveSidecarLaunch } from '../main/mainDecisions.js'")
  expect(probe).toContain('resolveSidecarLaunch({')
  expect(probe).toContain('packaged: true')
  expect(probe).toContain("launch?.argsFor('session')")
  expect(probe).toContain("if (mode === 'probe') env.CATCODE_SIDECAR_PROBE = '1'")
  expect(probe).toContain('else delete env.CATCODE_SIDECAR_PROBE')
  expect(probe).toContain("probeFixture: mode === 'probe'")
})

test('ram-probe owns real-turn state and routes synthetic auth only to localhost', () => {
  expect(probe).toContain("'ram-probe: --real-turn owns its config home; do not pass --config-dir'")
  expect(probe).toContain("mkdtempSync(join(tmpdir(), 'ram0-config-'))")
  expect(probe).toContain("const CLOSED_ANTHROPIC_ENDPOINT = 'http://127.0.0.1:1'")
  expect(probe).toContain("env.ANTHROPIC_API_KEY = SYNTHETIC_API_KEY")
  expect(probe).toContain("env.ANTHROPIC_BASE_URL = CLOSED_ANTHROPIC_ENDPOINT")
  expect(probe).toContain("API_TIMEOUT_MS: '3000'")
  expect(probe).toContain("CLAUDE_STREAM_IDLE_TIMEOUT_MS: '3000'")
  expect(probe.indexOf('delete env[key]')).toBeLessThan(
    probe.indexOf('env.ANTHROPIC_API_KEY = SYNTHETIC_API_KEY'),
  )
})

test('ram-probe proves a normal submitted turn in frame order', () => {
  expect(probe).toContain('new FrameDecoder(MAX_OUTBOUND_FRAME_BYTES)')
  expect(probe).toContain("payload.kind === 'sidecar.delivery-envelope'")
  expect(probe).toContain("const trustedCwd = realpathSync(cwdDir)")
  expect(probe).toContain("[trustedCwd]: { hasTrustDialogAccepted: true }")
  expect(probe).toContain(
    "'packaged sidecar did not read the isolated trusted-workspace fixture'",
  )
  expect(probe).not.toContain("sendMessage({ type: 'workspace.trust'")
  expect(probe).toContain("type: 'app.submit'")
  expect(probe).toContain('options: { submitId }')
  expect(probe).toContain("frame.kind === 'submit.result'")
  expect(probe).toContain("frame.event.type !== 'turn.status'")
  expect(probe).toContain('frame.event.activeTurn === true && submitSent')
  expect(probe).toContain('Math.max(submitAcceptedAt, activeTurnAt) < terminalTurnAt')
  expect(probe).not.toContain("mode !== 'probe'")
  expect(probe).not.toContain('syntheticTurnCompleted')
})

test('ram-probe bounds evidence and verifies exact cleanup ownership', () => {
  expect(probe).toContain('const MAX_SAMPLES = 256')
  expect(probe).toContain('const MAX_FRAME_SUMMARIES = 256')
  expect(probe).toContain('const MAX_STDERR_BYTES = 256 * 1024')
  expect(probe).toContain('const MAX_VMMAP_RAW_BYTES_PER_SAMPLE = 128 * 1024')
  expect(probe).toContain('await waitForExit(proc)')
  expect(probe).toContain('...ownedPids.filter(isAlive)')
  expect(probe).toContain('...groupSurvivors')
  expect(probe).toContain('processGroupOwnershipVerified &&')
  expect(probe).toContain('socketDirRemoved = removeOwnedTempDir(socketDir)')
  expect(probe).toContain('configDirRemoved = removeOwnedTempDir(ownedConfigDir)')
  expect(probe).toContain('if (!processCleanupComplete || !tempCleanupComplete) process.exitCode = 3')
})

test('renderer trajectories can require an isolated packaged launch record', () => {
  expect(trajectory).toContain('--require-packaged')
  expect(trajectory).toContain("record.event === 'app.start' && record.fields.packaged === true")
  expect(trajectory).toContain("args['require-packaged'] === 'true' && !packagedObserved")
  expect(trajectory).toContain(
    'Run this against a freshly launched packaged artifact and its isolated CLAUDE_CONFIG_DIR.',
  )
})
