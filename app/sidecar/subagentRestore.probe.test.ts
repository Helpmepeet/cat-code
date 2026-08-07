/**
 * Restored subagent nesting probe (real processes, real persisted files).
 *
 * A subagent's turns are persisted to its OWN sidechain transcript, never to
 * the parent session file (`appendEntry`'s sidechain branch,
 * `src/utils/sessionStorage.ts:1676`). Restore reads only the parent file, so
 * before this fix a restored Agent card came back with no child rows at all.
 * The join key is the meta sidecar's `parentToolUseId`
 * (`src/tools/AgentTool/runAgent.ts:820`), which is what the renderer's
 * `selectNestedTranscriptRows` groups on.
 *
 * This has to be a process proof: the branch only exists once production
 * persistence has written three separate artifacts (parent transcript,
 * sidechain transcript, meta sidecar) and a real sidecar has resumed against
 * them. A unit test over hand-built frames cannot establish that.
 *
 * TEST EVIDENCE
 * - Claim: a subagent persisted to its own sidechain replays as a NESTED frame
 *   stamped with the spawning Agent tool_use id, under a fresh sidecar.
 * - Exact pre-fix failure: no replayed frame carries the tool_use id at all —
 *   the sidechain file is never opened, so the card restores empty.
 * - Production entry point: sidecar `index.ts` → `withRestoredSubagentHistory`
 *   → `listAgentMetadataForSession` / `getAgentTranscriptForSession`.
 * - Test path: `app/sidecar/subagentRestore.probe.test.ts`.
 * - Proof layer: process.
 * - UNVERIFIED: GUI operator acceptance that the restored card renders its
 *   child rows and tool count.
 *
 * Run: `bun test app/sidecar/subagentRestore.probe.test.ts`
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SidecarSupervisor, type SupervisorEvent } from '../supervisor/supervisor.js'
import type { ServerFrame } from '../shared/protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const sidecarEntry = join(here, 'index.ts')
const minter = join(here, 'mintTranscript.fixture.ts')
const TEST_TIMEOUT_MS = 120_000

const supervisors: SidecarSupervisor[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const supervisor of supervisors.splice(0)) supervisor.shutdown()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function mintSubagentBranch(opts: {
  configHome: string
  cwd: string
  engineSessionId: string
  marker: string
}): Promise<{ parentToolUseId: string; agentName: string }> {
  const child = Bun.spawn(
    // `--realistic-tail` supplies the same resumable base shape the F2 probe
    // mints; the branch rides on top of it.
    ['bun', 'run', minter, opts.engineSessionId, opts.marker, '--realistic-tail', '--subagent-branch'],
    {
      cwd: opts.cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: opts.configHome,
        TEST_ENABLE_SESSION_PERSISTENCE: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`mint failed (exit ${code}): ${stderr}`)
  const lines = stdout.split('\n')
  const toolUseLine = lines.find(line => line.startsWith('MINTED_SUBAGENT_TOOL_USE_ID='))
  const nameLine = lines.find(line => line.startsWith('MINTED_SUBAGENT_NAME='))
  if (!toolUseLine || !nameLine) {
    throw new Error(`mint produced no subagent branch: ${stdout}`)
  }
  return {
    parentToolUseId: toolUseLine.slice('MINTED_SUBAGENT_TOOL_USE_ID='.length),
    agentName: nameLine.slice('MINTED_SUBAGENT_NAME='.length),
  }
}

function collectFrames(
  supervisor: SidecarSupervisor,
  sink: ServerFrame[],
): void {
  supervisor.subscribe((event: SupervisorEvent) => {
    if (event.type === 'frame') sink.push(event.frame)
  })
}

function waitForFrame(
  supervisor: SidecarSupervisor,
  predicate: (frame: ServerFrame) => boolean,
  timeoutMs = 45_000,
): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('timed out waiting for sidecar frame'))
    }, timeoutMs)
    const unsubscribe = supervisor.subscribe((event: SupervisorEvent) => {
      if (event.type === 'frame' && predicate(event.frame)) {
        clearTimeout(timer)
        unsubscribe()
        resolve(event.frame)
      }
    })
  })
}

test(
  'a subagent persisted to its own sidechain replays nested under its Agent tool_use',
  async () => {
    const configHome = tmp('catcode-subagent-restore-config-')
    const cwd = tmp('catcode-subagent-restore-cwd-')
    const engineSessionId = randomUUID()
    const marker = `nest-${randomUUID().slice(0, 8)}`

    const { parentToolUseId, agentName } = await mintSubagentBranch({
      configHome,
      cwd,
      engineSessionId,
      marker,
    })

    const appSessionId = 'subagent-restore'
    const supervisor = new SidecarSupervisor({
      sidecarCommand: 'bun',
      sidecarArgs: ['run', sidecarEntry],
      sidecarEnv: { CLAUDE_CONFIG_DIR: configHome },
    })
    supervisors.push(supervisor)

    const frames: ServerFrame[] = []
    collectFrames(supervisor, frames)
    const ready = waitForFrame(
      supervisor,
      frame => frame.kind === 'ready' && frame.sessionId === appSessionId,
    )
    const nested = waitForFrame(
      supervisor,
      frame =>
        frame.kind === 'event' &&
        frame.sessionId === appSessionId &&
        frame.replay === true &&
        JSON.stringify(frame).includes(parentToolUseId) &&
        JSON.stringify(frame).includes(`subagent turn for ${marker}`),
    )
    supervisor.spawnSession(appSessionId, { cwd, resumeEngineSessionId: engineSessionId })
    await ready
    const nestedFrame = await nested

    // The claim is the CORRELATION, not merely that the text arrived: the
    // subagent's turn must carry the spawning tool_use id, which is what the
    // renderer groups children by.
    const payload = JSON.parse(JSON.stringify(nestedFrame))
    expect(payload.event?.message?.parent_tool_use_id).toBe(parentToolUseId)
    // The meta sidecar's name rides along so a restored worker is named the
    // same way a live one is.
    expect(payload.event?.message?.agent_name).toBe(agentName)

    // The parent's own Agent tool_use frame must still be present and must NOT
    // have been rewritten into a child of itself.
    const parentFrame = frames.find(
      frame =>
        frame.kind === 'event' &&
        frame.replay === true &&
        JSON.stringify(frame).includes(`delegate ${marker}`),
    )
    expect(parentFrame).toBeDefined()
    const parentPayload = JSON.parse(JSON.stringify(parentFrame))
    expect(parentPayload.event?.message?.parent_tool_use_id ?? null).toBeNull()
  },
  TEST_TIMEOUT_MS,
)
