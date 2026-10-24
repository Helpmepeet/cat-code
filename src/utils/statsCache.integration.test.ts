import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const model = 'claude-sonnet-4-5-20250929'
let config: string | null = null

function record(id: string, timestamp: string, sessionId = 'cross-day-session') {
  return {
    type: 'assistant', uuid: `uuid-${id}`, parentUuid: null, isSidechain: false,
    sessionId, cwd: '/fixture', userType: 'external', version: '1.0.0', timestamp,
    message: { id, type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text: id }],
      usage: { input_tokens: 100, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }
}

function install(records: Array<{ sessionId: string; timestamp: string }>, legacy = false) {
  config = mkdtempSync(join(tmpdir(), 'cat-code-stats-cache-v4-'))
  const project = join(config, 'projects', 'fixture')
  mkdirSync(project, { recursive: true })
  const bySession = new Map<string, unknown[]>()
  for (const item of records) {
    const values = bySession.get(item.sessionId) ?? []
    values.push(item)
    bySession.set(item.sessionId, values)
  }
  for (const [sessionId, values] of bySession) {
    const path = join(project, `${sessionId}.jsonl`)
    writeFileSync(
      path,
      `${values.map(value => JSON.stringify(value)).join('\n')}\n`,
    )
    // A future simulated clock must not make fixture transcripts look stale.
    const modifiedAt = new Date(Math.max(Date.now(), ...records.map(record => Date.parse(record.timestamp))))
    utimesSync(path, modifiedAt, modifiedAt)
  }
  if (legacy) {
    cpSync(join(import.meta.dir, 'fixtures', 'stats-cache-v3-cross-day.json'), join(config, 'stats-cache.json'))
  }
}

async function run(fakeNow: string, timezone = 'UTC', range = 'all', screen = false) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'statsCache.integration.worker.ts')], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: config!, XDG_CONFIG_HOME: config!,
      STATS_FAKE_NOW: fakeNow, STATS_RANGE: range, TZ: timezone,
      STATS_SCREEN: screen ? '1' : '0',
      FORCE_COLOR: '0', NODE_ENV: 'test', ANTHROPIC_API_KEY: 'fixture-inert' },
    stdout: 'pipe', stderr: 'pipe',
  })
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited, stderr).toBe(0)
  return JSON.parse(stdout.trim())
}

afterEach(() => {
  if (config) rmSync(config, { recursive: true, force: true })
  config = null
})

describe('all-time stats cache integration', () => {
  test('does not recount a cached UTC day when advancing across spring-forward', async () => {
    install([
      record('spring-before', '2026-03-08T10:00:00.000Z'),
      record('spring-after', '2026-03-09T10:00:00.000Z'),
    ])
    expect(await run('2026-03-09T12:00:00.000Z', 'America/Los_Angeles')).toMatchObject({
      totalMessages: 2, inputTokens: 200,
    })
    const updated = await run('2026-03-10T12:00:00.000Z', 'America/Los_Angeles')
    expect(updated).toMatchObject({ totalMessages: 2, inputTokens: 200 })
    expect(updated.dailyActivity.map(day => day.messageCount)).toEqual([1, 1])
    expect(await run('2026-03-10T12:30:00.000Z', 'America/Los_Angeles')).toEqual(updated)
  })

  test('includes yesterday between historical and live UTC buckets across fall-back', async () => {
    install([
      record('fall-before', '2026-10-31T10:00:00.000Z'),
      record('fall-transition', '2026-11-01T10:00:00.000Z'),
      record('fall-today', '2026-11-02T00:10:00.000Z'),
    ])
    const stats = await run('2026-11-02T00:30:00.000Z', 'America/Los_Angeles')
    expect(stats).toMatchObject({ totalMessages: 3, inputTokens: 300 })
    expect(stats.dailyActivity.map(day => day.date)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02'])
  })

  test('shows the current UTC activity streak in Bangkok', async () => {
    install([record('today', '2026-10-24T01:00:00.000Z')])
    const stats = await run('2026-10-24T05:00:00.000Z', 'Asia/Bangkok', 'all', true)
    expect(stats.screen).toMatch(/Current streak:\s+1 day/)
  })

  test('labels a UTC activity date without shifting it to the previous local day', async () => {
    install([record('today', '2026-10-24T01:00:00.000Z')])
    const stats = await run('2026-10-24T12:00:00.000Z', 'America/Los_Angeles', 'all', true)
    expect(stats.screen).toContain('Most active day: Oct 24')
  })

  test('renders Friday and Saturday activity in their UTC weekday rows in Bangkok', async () => {
    install([
      record('friday', '2026-10-23T10:00:00.000Z'),
      record('saturday', '2026-10-24T01:00:00.000Z'),
    ])
    const stats = await run('2026-10-24T05:00:00.000Z', 'Asia/Bangkok')
    expect(stats.heatmap[5]).toBe('Fri ·········█')
    expect(stats.heatmap[6]).toBe('    ·········█')
  })

  test.each(['7d', '30d'])('keeps the %s UTC window stable across daylight saving', async range => {
    // At 00:30 UTC the local-date subtraction crosses fall-back and moves
    // the UTC cutoff back an extra day.
    const oldestDate = range === '7d' ? '2026-10-27' : '2026-10-04'
    const excludedDate = range === '7d' ? '2026-10-26' : '2026-10-03'
    install([
      record('outside-window', `${excludedDate}T12:00:00.000Z`),
      record('window-start', `${oldestDate}T12:00:00.000Z`),
      record('window-end', '2026-11-02T00:10:00.000Z'),
    ])
    const stats = await run('2026-11-02T00:30:00.000Z', 'America/Los_Angeles', range)
    expect(stats).toMatchObject({ totalMessages: 2, inputTokens: 200 })
    expect(stats.dailyActivity.map(day => day.date)).toEqual([oldestDate, '2026-11-02'])
  })

  test('checkpoints parent and worker transcripts independently', async () => {
    install([
      record('parent-one', '2026-09-11T10:00:00.000Z'),
      record('parent-two', '2026-09-11T11:00:00.000Z'),
    ])
    const workerDir = join(
      config!, 'projects', 'fixture', 'cross-day-session', 'subagents',
    )
    mkdirSync(workerDir, { recursive: true })
    const workerFile = join(workerDir, 'agent-worker.jsonl')
    const workerRecords = Array.from({ length: 6 }, (_, index) => ({
      ...record(`worker-${index}`, `2026-09-11T10:0${index}:00.000Z`),
      isSidechain: true,
    }))
    writeFileSync(
      workerFile,
      `${workerRecords.map(value => JSON.stringify(value)).join('\n')}\n`,
    )
    cpSync(
      join(import.meta.dir, 'fixtures', 'stats-cache-v3-subagent.json'),
      join(config!, 'stats-cache.json'),
    )

    const migrated = await run('2026-09-12T12:00:00.000Z')
    expect(migrated).toMatchObject({
      totalSessions: 1,
      totalMessages: 2,
      inputTokens: 800,
    })
    const cache = JSON.parse(
      readFileSync(join(config!, 'stats-cache-v4.json'), 'utf8'),
    )
    expect(cache.legacyMigration.legacySessionCheckpoints).toMatchObject({
      'cross-day-session': { observedMessageCount: 2 },
      'cross-day-session/subagents/agent-worker': { observedMessageCount: 6 },
    })

    const appended = {
      ...record('worker-new', '2026-09-12T01:00:00.000Z'),
      isSidechain: true,
    }
    writeFileSync(
      workerFile,
      `${readFileSync(workerFile, 'utf8')}${JSON.stringify(appended)}\n`,
    )
    const updated = await run('2026-09-12T12:30:00.000Z')
    expect(updated).toMatchObject({
      totalSessions: 1,
      totalMessages: 2,
      inputTokens: 900,
    })
    expect(await run('2026-09-12T12:45:00.000Z')).toEqual(updated)
  })

  test('adopts an actual-base v3 fixture without cross-day inflation', async () => {
    install([
      record('one', '2026-09-11T23:00:00.000Z'),
      record('two', '2026-09-12T01:00:00.000Z'),
    ], true)
    const result = await run('2026-09-12T12:00:00.000Z')
    expect(result).toMatchObject({ totalSessions: 1, totalMessages: 2,
      inputTokens: 200, longestDuration: 7_200_000 })
    expect(result.notice).toBe('Some older activity may be estimated.')
    expect(JSON.parse(readFileSync(join(config!, 'stats-cache.json'), 'utf8')).version).toBe(3)
    expect(JSON.parse(readFileSync(join(config!, 'stats-cache-v4.json'), 'utf8')).version).toBe(4)

    const transcript = join(config!, 'projects', 'fixture', 'cross-day-session.jsonl')
    const existing = readFileSync(transcript, 'utf8')
    writeFileSync(
      transcript,
      `${existing}${JSON.stringify(record('two', '2026-09-12T01:00:00.000Z'))}\n${JSON.stringify(record('after-migration', '2026-09-12T01:00:00.000Z'))}\n`,
    )
    const afterMigration = await run('2026-09-12T12:30:00.000Z')
    const repeat = await run('2026-09-12T12:45:00.000Z')
    expect(afterMigration).toMatchObject({ totalSessions: 1, totalMessages: 3,
      inputTokens: 300, longestDuration: 7_200_000 })
    expect(repeat).toEqual(afterMigration)
  })

  test('serializes competing processes and keeps one session across rollovers', async () => {
    install([
      record('ten', '2026-09-10T23:00:00.000Z'),
      record('eleven', '2026-09-11T01:00:00.000Z'),
      record('twelve', '2026-09-12T01:00:00.000Z'),
    ])
    const competing = await Promise.all([
      run('2026-09-10T12:00:00.000Z'),
      run('2026-09-10T12:00:00.000Z'),
    ])
    expect(competing.map(value => value.totalSessions)).toEqual([1, 1])
    expect((await run('2026-09-11T12:00:00.000Z')).totalSessions).toBe(1)
    const final = await run('2026-09-12T12:00:00.000Z')
    expect(final).toMatchObject({ totalSessions: 1, totalMessages: 3,
      inputTokens: 300, longestDuration: 93_600_000 })
  })
})
