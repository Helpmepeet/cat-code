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
  mkdirSync,
  readFileSync,
  realpathSync,
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
import { MAX_HISTORY_REPLAY_BYTES, MAX_TEXT_FIELD_CHARS } from '../shared/limits.js'
import type {
  SessionLocation,
  SessionRelocation,
} from '../../src/utils/sessionRelocationState.js'

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
    compacted?: boolean
    unresolvedToolTail?: boolean
    transcriptPath?: string
  }> = [
    {
      cwd: firstCwd,
      engineSessionId: randomUUID(),
      appSessionId: randomUUID(),
      nonce: `plb-first-${randomUUID()}`,
      compacted: true,
      unresolvedToolTail: true,
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
    const mintArgs = ['bun', 'run', minter, session.engineSessionId, session.nonce]
    if (session.compacted) mintArgs.push('--compacted')
    if (session.unresolvedToolTail) mintArgs.push('--unresolved-tool-tail')
    const mint = await spawnAndCollect(
      mintArgs,
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

  // Legacy auth refreshes could rotate the stamped session identity without
  // moving the transcript file pointer. The filename remains canonical for
  // catalog/backfill addressing; a drifted leaf stamp must not poison the row.
  const mixedPath = sessions[0]!.transcriptPath!
  const mixedEntries = readFileSync(mixedPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
  const mixedLeaf = mixedEntries.findLast(
    entry => entry.type === 'user' || entry.type === 'assistant',
  )
  expect(mixedLeaf).toBeDefined()
  mixedLeaf!.sessionId = randomUUID()
  writeFileSync(
    mixedPath,
    `${mixedEntries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
  )

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
  expect(run.stderr).toContain('transcript identity drift')
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
    if (expected.compacted) {
      expect(JSON.stringify(result)).toContain('compact_boundary')
    }
    if (expected.unresolvedToolTail) {
      expect(JSON.stringify(result)).not.toContain(
        `unresolved-${expected.nonce}`,
      )
    }
    // Nothing in a transcript states the context window, so the worker resolves
    // it from the model through the engine's real `getContextWindowForModel`.
    // Only a real process proves that import is reachable under bare/SIMPLE
    // mode; a fixture test injects a fake and cannot. It was null on every
    // backfilled session before this wiring existed.
    expect(result!.runFacts.model).toBeTruthy()
    expect(result!.runFacts.contextWindow).toBeGreaterThan(0)
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

test('backfill reads a real moved conversation from another launch folder without consuming recovery state, and refuses unsafe relocation records', async () => {
  const configHome = temp('catcode-plb-moved-config-')
  const original: SessionLocation = {
    cwd: realpathSync(temp('catcode-plb-moved-chat-')),
    binding: { kind: 'managed', storageRootId: randomUUID(), storageId: randomUUID() },
  }
  const target: SessionLocation = {
    cwd: realpathSync(temp('catcode-plb-moved-project-')),
    binding: { kind: 'project' },
  }
  const engineSessionId = randomUUID()
  const appSessionId = randomUUID()
  const nonce = `plb-moved-${randomUUID()}`
  const blocker = join(configHome, 'block-network.ts')
  writeFileSync(
    blocker,
    'globalThis.fetch = (async () => { throw new Error("Network disabled") }) as typeof fetch\n',
  )
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configHome,
    NODE_ENV: 'development',
  }
  writeFileSync(
    join(configHome, '.config.json'),
    JSON.stringify({ projects: { [target.cwd]: { hasTrustDialogAccepted: true } } }),
  )
  const mint = await spawnAndCollect(
    ['bun', `--preload=${blocker}`, 'run', minter, engineSessionId, nonce],
    { cwd: original.cwd, env: { ...env, TEST_ENABLE_SESSION_PERSISTENCE: '1' } },
  )
  expect(mint.code).toBe(0)
  const sourcePath = mint.stdout
    .split('\n')
    .find(line => line.startsWith('MINTED_TRANSCRIPT_PATH='))!
    .slice('MINTED_TRANSCRIPT_PATH='.length)
  const rawTranscript = readFileSync(sourcePath, 'utf8')
  const moved = await spawnAndCollect(
    ['bun', `--preload=${blocker}`, 'run', join(here, 'sessionRelocationWorker.ts')],
    { cwd: original.cwd, env },
    `${JSON.stringify({
      type: 'session-relocation',
      version: 1,
      engineSessionId,
      appSessionId,
      source: original,
      target,
      controls: { mode: 'default' },
    })}\n`,
  )
  expect(moved.code).toBe(0)
  const transcriptPath = join(
    dirname(sourcePath),
    '..',
    target.cwd.replace(/[^a-zA-Z0-9]/g, '-'),
    `${engineSessionId}.jsonl`,
  )
  const recordPath = join(configHome, 'session-relocations', `${engineSessionId}.json`)
  const relocationText = readFileSync(recordPath, 'utf8')
  const relocation = JSON.parse(relocationText) as SessionRelocation
  const recoveryPath = join(configHome, 'interrupted-turns', `${engineSessionId}.json`)
  mkdirSync(dirname(recoveryPath), { recursive: true })
  const leaf = rawTranscript
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { type: string; uuid: string })
    .findLast(entry => entry.type === 'assistant' || entry.type === 'user')!
  const recoveryText = JSON.stringify({
    version: 1,
    sessionId: engineSessionId,
    leafUuid: leaf.uuid,
    partialOutput: 'retain interrupted work',
    partialOutputTruncated: false,
    reason: 'user_abort',
    capturedAt: Date.now(),
  })
  writeFileSync(recoveryPath, recoveryText)
  const run = async (itemAppId = appSessionId, path = transcriptPath) => {
    const result = await spawnAndCollect(
      ['bun', `--preload=${blocker}`, 'run', worker, '--bare'],
      { cwd: original.cwd, env },
      JSON.stringify({
        version: TRANSCRIPT_BACKFILL_BOUNDARY_VERSION,
        items: [{ appSessionId: itemAppId, engineSessionId, transcriptPath: path }],
      }),
    )
    expect(result.code).toBe(0)
    const records = result.stdout
      .trim()
      .split('\n')
      .map(line => parseTranscriptBackfillResult(JSON.parse(line)))
    expect(records.every(Boolean)).toBe(true)
    expect(records.at(-1)).toEqual({ type: 'done', attempted: 1 })
    return { result, record: records[0] }
  }
  const preview = await run()
  expect(preview.result.stderr).not.toContain(
    'Open this conversation from its current folder',
  )
  expect(preview.record?.type).toBe('session')
  expect(JSON.stringify(preview.record)).toContain(nonce)
  expect(readFileSync(transcriptPath, 'utf8')).toBe(rawTranscript)
  expect(readFileSync(recordPath, 'utf8')).toBe(relocationText)
  expect(readFileSync(recoveryPath, 'utf8')).toBe(recoveryText)

  expect((await run(randomUUID())).record?.type).toBe('failure')
  // A stale former-project file must not regain the canonical association.
  mkdirSync(dirname(sourcePath), { recursive: true })
  writeFileSync(sourcePath, rawTranscript)
  expect((await run(appSessionId, sourcePath)).record?.type).toBe('failure')
  writeFileSync(recordPath, JSON.stringify({ ...relocation, phase: 'moving' }))
  const unfinished = await run()
  expect(unfinished.record?.type).toBe('failure')
  expect(unfinished.result.stderr).toContain('unfinished move')
  const { controls: _controls, ...withoutControls } = relocation
  writeFileSync(recordPath, JSON.stringify(withoutControls))
  const unreadable = await run()
  expect(unreadable.record?.type).toBe('failure')
  expect(unreadable.result.stderr).toContain('Conversation move record could not be read')
  expect(readFileSync(transcriptPath, 'utf8')).toBe(rawTranscript)
  expect(readFileSync(recoveryPath, 'utf8')).toBe(recoveryText)
}, 120_000)

// The parent events fit the replay ceiling independently. A large omitted-worker
// snapshot must share that same ceiling rather than invalidate the whole cache.
test('worker availability shares the replay byte budget without losing markers for retained Agent cards', async () => {
  const configHome = temp('catcode-plb-availability-config-')
  const cwd = temp('catcode-plb-availability-cwd-')
  const engineSessionId = randomUUID()
  const appSessionId = randomUUID()
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configHome, TEST_ENABLE_SESSION_PERSISTENCE: '1' }
  const minted = await spawnAndCollect(['bun', 'run', minter, engineSessionId, 'availability-budget'], { cwd, env })
  expect(minted.code).toBe(0)
  const transcriptLine = minted.stdout.split('\n').find(line => line.startsWith('MINTED_TRANSCRIPT_PATH='))
  expect(transcriptLine).toBeDefined()
  const transcriptPath = transcriptLine!.slice('MINTED_TRANSCRIPT_PATH='.length)
  const seed = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const assistant = seed.find(entry => entry.type === 'assistant')!
  const user = seed.find(entry => entry.type === 'user')!
  const agentDir = join(dirname(transcriptPath), engineSessionId, 'subagents')
  mkdirSync(agentDir, { recursive: true })
  const records: Record<string, unknown>[] = []
  let parentUuid: string | null = null
  const append = (base: typeof user, content: unknown[]) => {
    const uuid = randomUUID()
    records.push({ ...base, uuid, parentUuid, timestamp: new Date(Date.parse('2026-10-09T00:00:00.000Z') + records.length).toISOString(),
      message: { ...base.message, content, ...(base.type === 'assistant' ? { id: randomUUID() } : {}) } })
    parentUuid = uuid
  }
  append(user, [{ type: 'text', text: 'Investigate all workers' }])
  for (let index = 0; index < 100; index++) {
    const toolId = `long-parent-${index}-`.padEnd(MAX_TEXT_FIELD_CHARS, 'x')
    append(assistant, [{ type: 'tool_use', id: toolId, name: 'Agent', input: { description: 'saved worker' } }])
    append(user, [{ type: 'tool_result', tool_use_id: toolId, content: 'Completed' }])
    writeFileSync(join(agentDir, `agent-worker-${index}.meta.json`), JSON.stringify({
      agentType: 'Explore', parentSessionId: engineSessionId, parentToolUseId: toolId,
      spawnedAt: new Date(Date.parse('2026-10-09T00:00:00.000Z') + index).toISOString(),
    }))
  }
  const recentText = 'recent answer ' + 'x'.repeat(Math.floor(MAX_HISTORY_REPLAY_BYTES * 0.80))
  append(assistant, [{ type: 'text', text: recentText }])
  writeFileSync(transcriptPath, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  // The first reachable sidechain consumes the aggregate source-read budget,
  // leaving all known worker cards with unavailable history, without live runs.
  writeFileSync(join(agentDir, 'agent-worker-0.jsonl'), JSON.stringify({
    ...assistant, uuid: randomUUID(), parentUuid: null, isSidechain: true, agentId: 'worker-0',
    message: { ...assistant.message, content: [{ type: 'text', text: 'x'.repeat(MAX_HISTORY_REPLAY_BYTES + 2048) }] },
  }) + '\n')
  const run = await spawnAndCollect(['bun', 'run', worker, '--bare'], { cwd, env }, JSON.stringify({
    version: TRANSCRIPT_BACKFILL_BOUNDARY_VERSION,
    items: [{ appSessionId, engineSessionId, transcriptPath }],
  }))
  expect(run.code).toBe(0)
  const parsed = run.stdout.trim().split('\n').map(line => parseTranscriptBackfillResult(JSON.parse(line)))
  expect(parsed.every(Boolean)).toBe(true)
  const sessions = parsed.filter((record): record is TranscriptBackfillSessionResult => record?.type === 'session')
  expect(sessions).toHaveLength(1)
  const frames = sessions[0]!.frames
  const availability = frames.find(frame => frame.kind === 'history.availability')!
  expect(availability.kind).toBe('history.availability')
  if (availability.kind !== 'history.availability') throw new Error('missing availability snapshot')
  const retainedParents = frames.flatMap(frame => {
    if (frame.kind !== 'event' || frame.event.type !== 'message') return []
    const message = frame.event.message as { type: string; message?: { content?: unknown[] } }
    if (message.type !== 'assistant') return []
    return (message.message?.content ?? []).flatMap(block => {
      const value = block as { type: string; id?: string }
      return value.type === 'tool_use' ? [value.id!] : []
    })
  })
  expect(retainedParents.length).toBeGreaterThan(0)
  expect(retainedParents.length).toBeLessThan(100)
  expect(new Set(availability.unavailableParentToolUseIds)).toEqual(new Set(retainedParents))
  expect(Buffer.byteLength(JSON.stringify(frames), 'utf8')).toBeLessThanOrEqual(MAX_HISTORY_REPLAY_BYTES)
  expect(frames.some(frame => frame.kind === 'error')).toBe(true)
  const last = frames.findLast(frame => frame.kind === 'event')
  expect(JSON.stringify(last)).toContain(recentText)
}, 120_000)

test('an omitted child event keeps its retained Agent card marked unavailable beside surviving child steps', async () => {
  const configHome = temp('catcode-plb-partial-child-config-')
  const cwd = temp('catcode-plb-partial-child-cwd-')
  const engineSessionId = randomUUID()
  const appSessionId = randomUUID()
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configHome, TEST_ENABLE_SESSION_PERSISTENCE: '1' }
  const minted = await spawnAndCollect(['bun', 'run', minter, engineSessionId, 'partial-child', '--subagent-branch'], { cwd, env })
  expect(minted.code).toBe(0)
  const transcriptPath = minted.stdout.split('\n').find(line => line.startsWith('MINTED_TRANSCRIPT_PATH='))!
    .slice('MINTED_TRANSCRIPT_PATH='.length)
  const parentId = minted.stdout.split('\n').find(line => line.startsWith('MINTED_SUBAGENT_TOOL_USE_ID='))!
    .slice('MINTED_SUBAGENT_TOOL_USE_ID='.length)
  const agentPath = join(dirname(transcriptPath), engineSessionId, 'subagents', 'agent-branch-agent-partial-child.jsonl')
  const child = JSON.parse(readFileSync(agentPath, 'utf8').split('\n').find(Boolean)!)
  const blockedUuid = randomUUID()
  const blocked = { ...child, uuid: blockedUuid, parentUuid: null,
    message: { ...child.message, id: randomUUID(), content: [
      { type: 'tool_use', id: 'child-hidden-tool', name: 'Read', input: { api_key: 'blocked-fixture' } },
    ] },
  }
  const visible = { ...child, uuid: randomUUID(), parentUuid: blockedUuid,
    message: { ...child.message, id: randomUUID(), content: [{ type: 'text', text: 'surviving child step' }] },
  }
  writeFileSync(agentPath, JSON.stringify(blocked) + '\n' + JSON.stringify(visible) + '\n')
  const run = await spawnAndCollect(['bun', 'run', worker, '--bare'], { cwd, env }, JSON.stringify({
    version: TRANSCRIPT_BACKFILL_BOUNDARY_VERSION,
    items: [{ appSessionId, engineSessionId, transcriptPath }],
  }))
  expect(run.code).toBe(0)
  const records = run.stdout.trim().split('\n').map(line => parseTranscriptBackfillResult(JSON.parse(line)))
  expect(records.every(Boolean)).toBe(true)
  const result = records.find((record): record is TranscriptBackfillSessionResult => record?.type === 'session')
  expect(result).toBeDefined()
  expect(JSON.stringify(result)).toContain('surviving child step')
  expect(JSON.stringify(result)).not.toContain('blocked-fixture')
  const availability = result!.frames.find(frame => frame.kind === 'history.availability')
  expect(availability?.kind).toBe('history.availability')
  if (availability?.kind !== 'history.availability') throw new Error('missing availability snapshot')
  expect(availability.unavailableParentToolUseIds).toEqual([parentId])
}, 120_000)
