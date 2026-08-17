/**
 * D1b restore probe — a message the user took back must not come back.
 *
 * TEST EVIDENCE
 * - Claim: restore rebuilds the mid-turn queue from the durable
 *   queue-operation log, so a recalled (or otherwise retracted) message is NOT
 *   part of the restored history, while a message that was genuinely still
 *   waiting still is.
 * - Exact pre-fix failure: `dequeueAllMatching` recorded its `dequeue` with no
 *   uuid (`src/utils/messageQueueManager.ts`), and the resume filter consulted
 *   only `enqueue` records (`sessionResume.ts`), so the orphaned enqueue was
 *   replayed as a `type:'user'` row on EVERY later restore of that session,
 *   including a routine idle-park restore.
 * - Production entry point: `resumeEngineSession` →
 *   `projectUndeliveredPrompts`, which `app/sidecar/index.ts:293` appends to
 *   the restored history.
 * - Proof layer: process. Two real Bun processes and the real engine
 *   persistence: one mints the transcript + queue log through the engine's OWN
 *   primitives, the other resumes it cold. No credentials and no model call.
 * - UNVERIFIED here: the renderer's rendering of the restored rows, and the
 *   live socket path (covered by `restoreAntiPotemkin.probe.test.ts`).
 *
 * Run: `bun test app/sidecar/sessionResume.probe.test.ts`
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const minter = join(here, 'mintTranscript.fixture.ts')
const resumeProbe = join(here, 'resumeProbe.fixture.ts')

// Each step boots the full engine graph in a cold Bun process.
const TEST_TIMEOUT_MS = 120_000

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function readMintedValue(stdout: string, key: string): string {
  const line = stdout.split('\n').find(entry => entry.startsWith(`${key}=`))
  if (!line) throw new Error(`mint did not report ${key}: ${stdout}`)
  return line.slice(key.length + 1)
}

async function run(
  command: string[],
  cwd: string,
  configHome: string,
): Promise<string> {
  const child = Bun.spawn(['bun', 'run', ...command], {
    cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configHome,
      // The bun-test runner sets NODE_ENV=test, which makes the engine's
      // persistence a no-op. This is the engine's own escape hatch.
      TEST_ENABLE_SESSION_PERSISTENCE: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) {
    throw new Error(`${command[0]} failed (exit ${code}): ${stderr}`)
  }
  return stdout
}

test('a recalled mid-turn message is absent from restored history while a still-waiting one survives', async () => {
  const configHome = tmp('catcode-recall-restore-cfg-')
  const cwd = tmp('catcode-recall-restore-cwd-')
  const engineSessionId = randomUUID()
  const marker = `recall-${randomUUID()}`

  const minted = await run(
    [minter, engineSessionId, marker, '--recalled-queued'],
    cwd,
    configHome,
  )
  const recalledUuid = readMintedValue(minted, 'MINTED_RECALLED_UUID')
  const waitingUuid = readMintedValue(minted, 'MINTED_WAITING_UUID')
  const imageUuid = readMintedValue(minted, 'MINTED_IMAGE_UUID')

  const resumed = await run([resumeProbe, engineSessionId, marker], cwd, configHome)
  const line = resumed
    .split('\n')
    .find(entry => entry.startsWith('RESUME_RESULT='))
  if (!line) throw new Error(`resume probe reported nothing: ${resumed}`)
  const result = JSON.parse(line.slice('RESUME_RESULT='.length)) as {
    undeliveredHistory: Array<{
      uuid: string
      message: { content: unknown }
    }>
  }

  const restored = result.undeliveredHistory
  // The whole point: the taken-back message is gone, and gone for good — the
  // durable record of the retraction is what every FUTURE restore reads too.
  expect(restored.map(row => row.uuid)).not.toContain(recalledUuid)
  expect(JSON.stringify(restored)).not.toContain(`recalled input ${marker}`)

  // The control. A filter that simply dropped everything would pass the
  // assertion above and lose the input CC-54 exists to recover.
  expect(restored.map(row => row.uuid)).toContain(waitingUuid)
  expect(JSON.stringify(restored)).toContain(`waiting input ${marker}`)

  // An image-bearing message is recovered as the blocks the user actually
  // sent, not as text that quietly drops the attachment.
  const image = restored.find(row => row.uuid === imageUuid)
  expect(image?.message.content).toEqual([
    { type: 'text', text: `image caption ${marker}` },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    },
  ])
}, TEST_TIMEOUT_MS)
