/**
 * PL-B real-process proof: engine persistence → one bare serialized worker →
 * bounded boundary result → the existing main cache codec. The positive
 * control executes a configured SessionStart shell hook; the worker reads the
 * same config/transcript without creating the marker and exits promptly.
 */

import { afterEach, expect, test } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
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
  type TranscriptBackfillFailureResult,
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

test('serialized bare worker switches two sessions, suppresses a real SessionStart hook, exits, and produces readable caches', async () => {
  const configHome = temp('catcode-plb-config-')
  const firstCwd = temp('catcode-plb-cwd-first-')
  const secondCwd = temp('catcode-plb-cwd-second-')
  const cacheDir = temp('catcode-plb-cache-')
  const markerPath = join(temp('catcode-plb-marker-'), 'HOOK_EXECUTED')
  const sessions: Array<{
    cwd: string
    engineSessionId: string
    appSessionId: string
    nonce: string
    transcriptPath?: string
  }> = [
    {
      cwd: firstCwd,
      engineSessionId: randomUUID(),
      appSessionId: randomUUID(),
      nonce: `plb-first-${randomUUID()}`,
    },
    {
      cwd: secondCwd,
      engineSessionId: randomUUID(),
      appSessionId: randomUUID(),
      nonce: `plb-second-${randomUUID()}`,
    },
  ]

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

  for (const session of sessions) {
    const mint = await spawnAndCollect(
      ['bun', 'run', minter, session.engineSessionId, session.nonce],
      {
        cwd: session.cwd,
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
    session.transcriptPath = transcriptLine!.slice(
      'MINTED_TRANSCRIPT_PATH='.length,
    )
  }

  const control = await spawnAndCollect(
    ['bun', 'run', hookControl, sessions[0]!.engineSessionId],
    {
      cwd: firstCwd,
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
    items: sessions.map(session => ({
      appSessionId: session.appSessionId,
      engineSessionId: session.engineSessionId,
      transcriptPath: session.transcriptPath!,
    })),
  })
  const run = await spawnAndCollect(
    ['bun', 'run', worker, '--bare'],
    {
      cwd: firstCwd,
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
  // NOTE: this run shares its config home with the two `init()`-running
  // fixtures above, so it cannot also assert the worker's observation-only
  // bootstrap. `sessionsCatalogWorker.probe.test.ts` proves that on a clean
  // home; what this asserts is that the transcript read still works without
  // the full bootstrap.

  const records = run.stdout
    .trim()
    .split('\n')
    .map(line => parseTranscriptBackfillResult(JSON.parse(line)))
  expect(records.every(Boolean)).toBe(true)
  const results = records.filter(
    (record): record is TranscriptBackfillSessionResult => record?.type === 'session',
  )
  expect(results).toHaveLength(2)
  for (const expected of sessions) {
    const result = results.find(item => item.appSessionId === expected.appSessionId)
    expect(result).toBeDefined()
    expect(result!.engineSessionId).toBe(expected.engineSessionId)
    expect(JSON.stringify(result)).toContain(expected.nonce)
    for (const frame of result!.frames) {
      if (frame.kind === 'event' && frame.event.type === 'message') {
        expect((frame.event.message as { session_id?: string }).session_id).toBe(
          expected.engineSessionId,
        )
      }
    }
  }

  // Backfill and on-close use the same envelope+frame semantics. Normalize only
  // writtenAt, whose wall-clock stamp necessarily differs between constructions.
  const first = results.find(
    result => result.appSessionId === sessions[0]!.appSessionId,
  )!
  const ready: ServerFrame = {
    kind: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: sessions[0]!.appSessionId,
    engineSessionId: sessions[0]!.engineSessionId,
    payload: { type: 'app.ready' } as never,
  }
  const onClose = distill([ready, ...first.frames])
  const backfilled = createTranscriptCache(
    sessions[0]!.appSessionId,
    sessions[0]!.engineSessionId,
    first.frames,
  )
  expect({ ...backfilled, header: { ...backfilled.header, writtenAt: 0 } }).toEqual({
    ...onClose,
    header: { ...onClose.header, writtenAt: 0 },
  })
  writeCache(cacheDir, backfilled)
  expect(readCache(cacheDir, sessions[0]!.appSessionId)?.frames).toEqual(
    first.frames,
  )
}, 120_000)

test('a session the shared parser rejects becomes a failure record instead of an unvalidatable session record', async () => {
  const configHome = temp('catcode-plb-drift-config-')
  const cwd = temp('catcode-plb-drift-cwd-')
  const engineSessionId = randomUUID()
  const appSessionId = randomUUID()

  const mint = await spawnAndCollect(
    ['bun', 'run', minter, engineSessionId, `plb-drift-${randomUUID()}`],
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

  // Stand in for engine drift: a content block whose type the shared parser's
  // vocabulary does not know. That is the exact shape that cost 30 of 32
  // sessions their run facts (2026-07-28) — main terminates the whole run on a
  // record it cannot validate, so the worker must never emit one.
  const records = readFileSync(transcriptPath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
  const tail = records[records.length - 1]!
  appendFileSync(
    transcriptPath,
    `${JSON.stringify({
      ...tail,
      parentUuid: tail.uuid,
      uuid: randomUUID(),
      message: {
        ...(tail.message as Record<string, unknown>),
        id: randomUUID(),
        content: [{ type: 'catcode_unknown_block', payload: 'drifted' }],
      },
    })}\n`,
  )

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
    JSON.stringify({
      version: TRANSCRIPT_BACKFILL_BOUNDARY_VERSION,
      items: [{ appSessionId, engineSessionId, transcriptPath }],
    }),
  )
  expect(run.code).toBe(0)

  const emitted = run.stdout
    .trim()
    .split('\n')
    .map(line => parseTranscriptBackfillResult(JSON.parse(line)))
  // Every line the worker wrote must itself survive main's parser, or main
  // aborts the batch and abandons every session still queued behind this one.
  expect(emitted.every(Boolean)).toBe(true)
  expect(emitted.some(record => record?.type === 'session')).toBe(false)
  const failures = emitted.filter(
    (record): record is TranscriptBackfillFailureResult =>
      record?.type === 'failure',
  )
  expect(failures).toHaveLength(1)
  expect(failures[0]!.appSessionId).toBe(appSessionId)
  expect(failures[0]!.reason).toBe('invalid')
  expect(emitted[emitted.length - 1]).toEqual({ type: 'done', attempted: 1 })
}, 120_000)
