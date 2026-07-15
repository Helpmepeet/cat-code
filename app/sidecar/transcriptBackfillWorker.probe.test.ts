/**
 * PL-B real-process proof: engine persistence → one bare serialized worker →
 * bounded boundary result → the existing main cache codec. The positive
 * control executes a configured SessionStart shell hook; the worker reads the
 * same config/transcript without creating the marker and exits promptly.
 */

import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import {
  createTranscriptCache,
  distill,
  readCache,
  writeCache,
} from '../main/transcriptCache.js'
import {
  TRANSCRIPT_BACKFILL_BOUNDARY_VERSION,
  parseTranscriptBackfillResult,
  type TranscriptBackfillSessionResult,
} from '../shared/transcriptBackfill.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const minter = join(here, 'mintTranscript.fixture.ts')
const worker = join(here, 'transcriptBackfillWorker.ts')
const hookControl = join(here, 'sessionStartHookControl.fixture.ts')
const dirs: string[] = []
const children = new Set<ReturnType<typeof Bun.spawn>>()

afterEach(async () => {
  for (const child of children) {
    try {
      child.kill()
    } catch {
      // already exited
    }
    await child.exited.catch(() => undefined)
  }
  children.clear()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function spawnAndCollect(
  command: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string; elapsedMs: number }> {
  const started = Date.now()
  const proc = Bun.spawn(command, {
    ...options,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  children.add(proc)
  if (stdin !== undefined) {
    proc.stdin.write(stdin)
  }
  proc.stdin.end()
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  children.delete(proc)
  return { code, stdout, stderr, elapsedMs: Date.now() - started }
}

test('serialized bare worker suppresses a real SessionStart shell hook, exits, and produces an on-close-equivalent readable cache', async () => {
  const configHome = temp('catcode-plb-config-')
  const cwd = temp('catcode-plb-cwd-')
  const cacheDir = temp('catcode-plb-cache-')
  const markerPath = join(temp('catcode-plb-marker-'), 'HOOK_EXECUTED')
  const engineSessionId = randomUUID()
  const appSessionId = randomUUID()
  const nonce = `plb-${randomUUID()}`

  // A real user hook: the positive control below proves this exact config would
  // execute shell code on SessionStart:resume if bare mode did not stop it.
  writeFileSync(
    join(configHome, 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: 'resume',
            hooks: [{ type: 'command', command: `/usr/bin/touch ${markerPath}` }],
          },
        ],
      },
    }),
  )

  const mint = await spawnAndCollect(
    ['bun', 'run', minter, engineSessionId, nonce],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configHome,
        TEST_ENABLE_SESSION_PERSISTENCE: '1',
      },
    },
  )
  expect(mint.code).toBe(0)
  const transcriptLine = mint.stdout
    .split('\n')
    .find(line => line.startsWith('MINTED_TRANSCRIPT_PATH='))
  expect(transcriptLine).toBeDefined()
  const transcriptPath = transcriptLine!.slice('MINTED_TRANSCRIPT_PATH='.length)

  const control = await spawnAndCollect(
    ['bun', 'run', hookControl, engineSessionId],
    {
      cwd,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        CLAUDE_CODE_SIMPLE: undefined,
        CLAUDE_CONFIG_DIR: configHome,
      },
    },
  )
  expect(control.code).toBe(0)
  expect(existsSync(markerPath)).toBe(true)
  unlinkSync(markerPath)

  const request = JSON.stringify({
    version: TRANSCRIPT_BACKFILL_BOUNDARY_VERSION,
    items: [{ appSessionId, engineSessionId, transcriptPath }],
  })
  const run = await spawnAndCollect(
    ['bun', 'run', worker, '--bare'],
    {
      cwd,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        CLAUDE_CONFIG_DIR: configHome,
      },
    },
    request,
  )
  expect(run.code).toBe(0)
  expect(run.elapsedMs).toBeLessThan(30_000)
  expect(existsSync(markerPath)).toBe(false)

  const records = run.stdout
    .trim()
    .split('\n')
    .map(line => parseTranscriptBackfillResult(JSON.parse(line)))
  expect(records.every(Boolean)).toBe(true)
  const session = records.find(
    (record): record is TranscriptBackfillSessionResult => record?.type === 'session',
  )
  expect(session).toBeDefined()
  expect(JSON.stringify(session)).toContain(nonce)

  // Backfill and on-close use the same envelope+frame semantics. Normalize only
  // writtenAt, whose wall-clock stamp necessarily differs between constructions.
  const ready: ServerFrame = {
    kind: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: appSessionId,
    engineSessionId,
    payload: { type: 'app.ready' } as never,
  }
  const onClose = distill([ready, ...session!.frames])
  const backfilled = createTranscriptCache(
    appSessionId,
    engineSessionId,
    session!.frames,
  )
  expect({ ...backfilled, header: { ...backfilled.header, writtenAt: 0 } }).toEqual({
    ...onClose,
    header: { ...onClose.header, writtenAt: 0 },
  })
  writeCache(cacheDir, backfilled)
  expect(readCache(cacheDir, appSessionId)?.frames).toEqual(session!.frames)
}, 120_000)
