import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

function install(records: Array<{ sessionId: string }>, legacy = false) {
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
    writeFileSync(join(project, `${sessionId}.jsonl`), `${values.map(JSON.stringify).join('\n')}\n`)
  }
  if (legacy) {
    cpSync(join(import.meta.dir, 'fixtures', 'stats-cache-v3-cross-day.json'), join(config, 'stats-cache.json'))
  }
}

async function run(fakeNow: string) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'statsCache.integration.worker.ts')], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: config!, XDG_CONFIG_HOME: config!,
      STATS_FAKE_NOW: fakeNow, NODE_ENV: 'test', ANTHROPIC_API_KEY: 'fixture-inert' },
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
  test('adopts an actual-base v3 fixture without cross-day inflation', async () => {
    install([
      record('one', '2026-09-11T23:00:00.000Z'),
      record('two', '2026-09-12T01:00:00.000Z'),
    ], true)
    const result = await run('2026-09-12T12:00:00.000Z')
    expect(result).toMatchObject({ totalSessions: 1, totalMessages: 2,
      inputTokens: 200, longestDuration: 7_200_000 })
    expect(result.notice).toContain('pre-migration')
    expect(JSON.parse(readFileSync(join(config!, 'stats-cache.json'), 'utf8')).version).toBe(3)
    expect(JSON.parse(readFileSync(join(config!, 'stats-cache-v4.json'), 'utf8')).version).toBe(4)

    const transcript = join(config!, 'projects', 'fixture', 'cross-day-session.jsonl')
    const existing = readFileSync(transcript, 'utf8')
    writeFileSync(
      transcript,
      `${existing}${JSON.stringify(record('after-migration', '2026-09-12T03:00:00.000Z'))}\n`,
    )
    const afterMigration = await run('2026-09-12T12:30:00.000Z')
    const repeat = await run('2026-09-12T12:45:00.000Z')
    expect(afterMigration).toMatchObject({ totalSessions: 1, totalMessages: 3,
      inputTokens: 300, longestDuration: 14_400_000 })
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
