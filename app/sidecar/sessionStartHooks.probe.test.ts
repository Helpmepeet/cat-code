/**
 * SessionStart-hook acceptance probe (Bun test) — the live-path proof.
 *
 * The terminal fires `processSessionStartHooks('startup')` for every non-resume
 * launch and hands the result to the REPL as `initialMessages`
 * (`src/main.tsx:2471` → `:3874`). The desktop already ran the RESUME half: the
 * engine's own loader fires the 'resume' source and appends its messages to the
 * restored transcript (`src/utils/conversationRecovery.ts:723-726`), which reach
 * the sidecar's session controller as `initialMessages`. The fresh (non-resume)
 * desktop path ran nothing at all, so plugin- and settings-installed SessionStart
 * hooks silently never reached the model in a NEW desktop session.
 *
 * These probes spawn REAL sidecar processes over REAL Unix-domain sockets with an
 * isolated config home holding a real SessionStart command hook, and assert on
 * what that hook actually received — not on a shape.
 *
 *   1. fresh spawn  → the hook runs, source 'startup', this session's id, the
 *      session's real model setting. Fails before the fix (the hook never runs).
 *   2. resume spawn → the hook still runs exactly ONCE, source 'resume'. Passes
 *      before and after: it is the differential that localises the defect to the
 *      fresh path, and it guards the fix against double-firing on resume.
 *   3. an out-of-process fixture runs the REAL hook machinery and the REAL
 *      production construction and reads the served `QueryEngine`'s live turn
 *      context, proving the hook's `additionalContext` is what the model sees.
 *
 * Run: `bun test app/sidecar/sessionStartHooks.probe.test.ts`
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { SidecarSupervisor, type SupervisorEvent } from '../supervisor/supervisor.js'
import type { ServerFrame } from '../shared/protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const sidecarEntry = join(here, 'index.ts')
const minter = join(here, 'mintTranscript.fixture.ts')
const seedProbe = join(here, 'sessionStartSeedProbe.fixture.ts')

// Each sidecar boots the full engine graph on a cold module cache; same headroom
// as the sibling resume probes.
const TEST_TIMEOUT_MS = 120_000

let supervisor: SidecarSupervisor | null = null
const tempDirs: string[] = []

afterEach(() => {
  supervisor?.shutdown()
  supervisor = null
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return realpathSync(dir)
}

type HookRecord = {
  hook_event_name?: string
  source?: string
  session_id?: string
  cwd?: string
  model?: string
  agent_type?: string
}

/**
 * An isolated config home carrying ONE real SessionStart command hook. It runs
 * under `shell: true` (`src/utils/hooks.ts:943`), appends the hook input it was
 * handed on stdin to a JSONL record, and answers with `additionalContext` — the
 * same JSON contract `src/utils/hooks.ts:621` parses.
 *
 * User settings, not project settings: they need no workspace-trust decision, so
 * the probe measures the hook seam rather than the trust seam. `model` is set
 * here because it is the one source a fresh sidecar resolves its session model
 * from (`app/sidecar/sessionController.ts:231`).
 */
function writeHookConfig(opts: {
  configHome: string
  recordPath: string
  marker: string
  model: string
}): void {
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: opts.marker,
    },
  })
  writeFileSync(
    join(opts.configHome, 'settings.json'),
    JSON.stringify(
      {
        model: opts.model,
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume',
              hooks: [
                {
                  type: 'command',
                  command: `cat >> '${opts.recordPath}'; printf '\\n' >> '${opts.recordPath}'; printf '%s' '${payload}'`,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  )
}

function readHookRecords(recordPath: string): HookRecord[] {
  if (!existsSync(recordPath)) return []
  return readFileSync(recordPath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as HookRecord)
}

function waitForFrame(
  sup: SidecarSupervisor,
  predicate: (frame: ServerFrame) => boolean,
  timeoutMs = 60_000,
): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('timed out waiting for frame'))
    }, timeoutMs)
    const unsubscribe = sup.subscribe((event: SupervisorEvent) => {
      if (event.type === 'frame' && predicate(event.frame)) {
        clearTimeout(timer)
        unsubscribe()
        resolve(event.frame)
      }
    })
  })
}

async function runChild(opts: {
  entry: string
  args: string[]
  cwd: string
  configHome: string
  extraEnv?: Record<string, string>
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', opts.entry, ...opts.args], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      // Same isolation the sibling restore probes use: an inert key so engine
      // startup does not reach for the machine's real credentials, and a config
      // home holding only this probe's settings.
      ANTHROPIC_API_KEY: 'sk-ant-session-start-probe',
      CLAUDE_CONFIG_DIR: opts.configHome,
      NODE_ENV: 'development',
      ...opts.extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test('a FRESH desktop session runs SessionStart hooks (source=startup) for the session it is about to serve', async () => {
  const configHome = tmp('catcode-ssh-fresh-cfg-')
  const cwd = tmp('catcode-ssh-fresh-wd-')
  const recordPath = join(configHome, 'sessionstart.jsonl')
  const marker = `nonce-${randomUUID()}`
  writeHookConfig({ configHome, recordPath, marker, model: 'sonnet' })

  supervisor = new SidecarSupervisor({
    sidecarCommand: 'bun',
    sidecarArgs: ['run', sidecarEntry],
    sidecarCwd: cwd,
    sidecarEnv: {
      ANTHROPIC_API_KEY: 'sk-ant-session-start-probe',
      CLAUDE_CONFIG_DIR: configHome,
      CATCODE_SIDECAR_RESUME_SESSION_ID: '',
    },
  })
  supervisor.spawnSession(`ssh-fresh-${randomUUID()}`)

  const ready = await waitForFrame(supervisor, frame => frame.kind === 'ready')
  if (ready.kind !== 'ready') throw new Error('expected a ready frame')

  const records = readHookRecords(recordPath)
  // The fresh path fired the hook, exactly once…
  expect(records.length).toBe(1)
  const record = records[0]!
  expect(record.hook_event_name).toBe('SessionStart')
  // …with the CLI's own source for a non-resume launch (`src/main.tsx:2471`)…
  expect(record.source).toBe('startup')
  // …inside THIS live session, not some other engine process…
  expect(record.session_id).toBe(ready.engineSessionId)
  expect(record.cwd).toBe(cwd)
  // …and carrying the session's real model setting, the same value
  // `initializeSidecarModelProvider` selects moments later
  // (`app/sidecar/sessionController.ts:231`) — never a placeholder.
  expect(record.model).toBe('sonnet')
  // Nothing in the desktop sets a main-thread agent, so the CLI's own fallback
  // (`src/utils/sessionStart.ts:131`) resolves to no agent type at all.
  expect(record.agent_type).toBeUndefined()
}, TEST_TIMEOUT_MS)

test('a RESUMED desktop session still runs them exactly once, with source=resume', async () => {
  const configHome = tmp('catcode-ssh-resume-cfg-')
  const cwd = tmp('catcode-ssh-resume-wd-')
  const recordPath = join(configHome, 'sessionstart.jsonl')
  const marker = `nonce-${randomUUID()}`
  const engineSessionId = randomUUID()

  const mint = await runChild({
    entry: minter,
    args: [engineSessionId, marker],
    cwd,
    configHome,
    // bun test sets NODE_ENV=test, which no-ops transcript persistence; opt the
    // mint child back in (the engine's purpose-built test escape hatch).
    extraEnv: { TEST_ENABLE_SESSION_PERSISTENCE: '1' },
  })
  if (mint.code !== 0) {
    throw new Error(`mint failed (exit ${mint.code}): ${mint.stderr}`)
  }
  // The minter must not have run the hook — write the config only now, so the
  // records below can only have come from the resuming sidecar.
  writeHookConfig({ configHome, recordPath, marker, model: 'sonnet' })

  supervisor = new SidecarSupervisor({
    sidecarCommand: 'bun',
    sidecarArgs: ['run', sidecarEntry],
    sidecarCwd: cwd,
    sidecarEnv: {
      ANTHROPIC_API_KEY: 'sk-ant-session-start-probe',
      CLAUDE_CONFIG_DIR: configHome,
    },
  })
  supervisor.spawnSession(`ssh-resume-${randomUUID()}`, {
    cwd,
    resumeEngineSessionId: engineSessionId,
  })

  const ready = await waitForFrame(supervisor, frame => frame.kind === 'ready')
  if (ready.kind !== 'ready') throw new Error('expected a ready frame')
  expect(ready.engineSessionId).toBe(engineSessionId)

  const records = readHookRecords(recordPath)
  // Exactly one: the engine's resume loader owns this call, and the fresh-path
  // fix must not fire a second 'startup' round on top of it.
  expect(records.length).toBe(1)
  expect(records[0]!.source).toBe('resume')
}, TEST_TIMEOUT_MS)

test("the hook's additionalContext becomes the served engine's live turn context", async () => {
  const configHome = tmp('catcode-ssh-seed-cfg-')
  const cwd = tmp('catcode-ssh-seed-wd-')
  const recordPath = join(configHome, 'sessionstart.jsonl')
  const marker = `nonce-${randomUUID()}`
  writeHookConfig({ configHome, recordPath, marker, model: 'sonnet' })

  const probe = await runChild({
    entry: seedProbe,
    args: [marker],
    cwd,
    configHome,
  })
  if (probe.code !== 0) {
    throw new Error(
      `seed probe failed (exit ${probe.code}): ${probe.stderr}\nstdout: ${probe.stdout}`,
    )
  }
  const line = probe.stdout
    .split('\n')
    .find(l => l.startsWith('START_SEED_RESULT='))
  if (!line) {
    throw new Error(
      `seed probe produced no result line.\nstdout: ${probe.stdout}\nstderr: ${probe.stderr}`,
    )
  }
  const result = JSON.parse(line.slice('START_SEED_RESULT='.length)) as {
    hookMessageCount: number
    controllerBuilt: boolean
    engineHeldCount: number
    engineHasMarker: boolean
    providerBoundHistory: boolean
    messageTypes: string[]
  }

  expect(result.hookMessageCount).toBeGreaterThan(0)
  expect(result.controllerBuilt).toBe(true)
  expect(result.engineHeldCount).toBe(result.hookMessageCount)
  // The real assertion: the marker the hook emitted is inside the message state
  // `submit` copies into the model context, not merely a loader return value.
  expect(result.engineHasMarker).toBe(true)
  // The seed must stay inert for the two other readers of `initialMessages`: a
  // fresh session has no prior turn, so it may not adopt a model or lock the
  // provider picker the way a resumed transcript does.
  expect(result.providerBoundHistory).toBe(false)
  expect(result.messageTypes).not.toContain('assistant')
  expect(result.messageTypes).not.toContain('user')
}, TEST_TIMEOUT_MS)

test('index.ts seeds the fresh session from the startup hooks and nothing else', () => {
  // House idiom (`resumeSeed.probe.test.ts`): the live probes above prove the
  // hooks run and that hook output reaches a real engine's turn context; this
  // pins the one wiring line in between to a single assignment site, so a later
  // edit cannot quietly seed the fresh session from something else.
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  expect(source).toContain("processSessionStartHooks('startup'")
  expect(source).toContain('initialMessages: startupHookMessages')
  const assignments = source.match(/startupHookMessages =/g) ?? []
  expect(assignments.length).toBe(1)
})
