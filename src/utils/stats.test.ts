import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _forTest } from './stats.js'

const MODEL = 'claude-sonnet-4-5-20250929'

let tempDir: string | null = null

function writeSessionFile(records: unknown[]): string {
  tempDir = mkdtempSync(join(tmpdir(), 'cat-code-stats-'))
  const sessionFile = join(tempDir, 'session-abc.jsonl')
  writeFileSync(sessionFile, records.map(r => JSON.stringify(r)).join('\n'))
  return sessionFile
}

function assistantRecord(
  messageId: string | undefined,
  usage: Record<string, number>,
  index: number,
) {
  return {
    type: 'assistant',
    uuid: `uuid-${index}`,
    parentUuid: index === 0 ? null : `uuid-${index - 1}`,
    isSidechain: false,
    sessionId: 'session-abc',
    cwd: '/tmp',
    userType: 'external',
    version: '1.0.0',
    timestamp: new Date(2026, 0, 5, 10, index).toISOString(),
    message: {
      ...(messageId === undefined ? {} : { id: messageId }),
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text: 'hi' }],
      usage,
    },
  }
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

describe('processSessionFiles token aggregation', () => {
  test('counts provably new sessions while excluding legacy-attributed sessions', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cat-code-stats-legacy-'))
    const legacyFile = join(tempDir, 'legacy-session.jsonl')
    const newFile = join(tempDir, 'new-session.jsonl')
    const legacy = {
      ...assistantRecord('legacy', { input_tokens: 100, output_tokens: 0 }, 0),
      timestamp: '2026-09-12T01:00:00.000Z',
    }
    const recent = {
      ...assistantRecord('new', { input_tokens: 200, output_tokens: 0 }, 0),
      timestamp: '2026-09-12T02:00:00.000Z',
    }
    writeFileSync(legacyFile, `${JSON.stringify(legacy)}\n`)
    writeFileSync(newFile, `${JSON.stringify(recent)}\n`)

    const stats = await _forTest.processSessionFiles(
      [legacyFile, newFile],
      {
        fromDate: '2026-09-12',
        excludeSessionIds: new Set(['legacy-session']),
      },
    )

    expect(stats.totalMessages).toBe(1)
    expect(stats.sessionStats.map(session => session.sessionId)).toEqual([
      'new-session',
    ])
    expect(stats.modelUsage[MODEL]?.inputTokens).toBe(200)
  })

  test('counts input-side tokens once and takes max output across records sharing one message id', async () => {
    // Streaming split: both records carry the message_start input/cache seed,
    // only the last carries the final output total.
    const sessionFile = writeSessionFile([
      assistantRecord(
        'msg_split',
        {
          input_tokens: 1200,
          output_tokens: 1,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 5000,
        },
        0,
      ),
      assistantRecord(
        'msg_split',
        {
          input_tokens: 1200,
          output_tokens: 450,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 5000,
        },
        1,
      ),
    ])

    const stats = await _forTest.processSessionFiles([sessionFile])

    expect(stats.modelUsage[MODEL]).toMatchObject({
      inputTokens: 1200,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 5000,
      outputTokens: 450,
    })
    expect(stats.dailyModelTokens[0]?.tokensByModel[MODEL]).toBe(1200 + 450)
  })

  test('credits late input and cache increases once for a split response', async () => {
    const sessionFile = writeSessionFile([
      assistantRecord(
        'msg_split',
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        0,
      ),
      assistantRecord(
        'msg_split',
        {
          input_tokens: 1200,
          output_tokens: 450,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 5000,
        },
        1,
      ),
      assistantRecord(
        'msg_split',
        {
          input_tokens: 1200,
          output_tokens: 450,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 5000,
        },
        2,
      ),
    ])

    const stats = await _forTest.processSessionFiles([sessionFile])

    expect(stats.modelUsage[MODEL]).toMatchObject({
      inputTokens: 1200,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 5000,
      outputTokens: 450,
    })
    expect(stats.dailyModelTokens[0]?.tokensByModel[MODEL]).toBe(1650)
  })

  test('still sums records with distinct message ids', async () => {
    const sessionFile = writeSessionFile([
      assistantRecord(
        'msg_one',
        {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 40,
        },
        0,
      ),
      assistantRecord(
        'msg_two',
        {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 40,
        },
        1,
      ),
    ])

    const stats = await _forTest.processSessionFiles([sessionFile])

    expect(stats.modelUsage[MODEL]).toMatchObject({
      inputTokens: 200,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 80,
      outputTokens: 40,
    })
  })

  test('sums records that carry no message id', async () => {
    const sessionFile = writeSessionFile([
      assistantRecord(undefined, { input_tokens: 100, output_tokens: 20 }, 0),
      assistantRecord(undefined, { input_tokens: 100, output_tokens: 20 }, 1),
    ])

    const stats = await _forTest.processSessionFiles([sessionFile])

    expect(stats.modelUsage[MODEL]).toMatchObject({
      inputTokens: 200,
      outputTokens: 40,
    })
  })
})

describe('rolling range aggregation', () => {
  test('shares discovery and reads while preserving filters, split IDs, and subagent totals', async () => {
    const { mkdirSync, utimesSync } = await import('fs')
    const { spyOn } = await import('bun:test')
    const json = await import('./json.js')
    const { getFsImplementation } = await import('./fsOperations.js')
    const { aggregateClaudeCodeStatsForRange, aggregateClaudeCodeStatsForRanges } = await import('./stats.js')
    tempDir = mkdtempSync(join(tmpdir(), 'cat-code-stats-ranges-'))
    const projects = join(tempDir, 'projects')
    const project = join(projects, 'fixture-project')
    mkdirSync(project, { recursive: true })
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tempDir
    const date = (daysAgo: number) => {
      const value = new Date()
      value.setHours(12, 0, 0, 0)
      value.setDate(value.getDate() - daysAgo)
      return value
    }
    const record = (daysAgo: number, id: string, output: number, sidechain = false) => ({
      ...assistantRecord(id, { input_tokens: 100, output_tokens: output }, 0),
      timestamp: date(daysAgo).toISOString(),
      isSidechain: sidechain,
    })
    const write = (name: string, records: unknown[], modifiedAgo = 0) => {
      const file = join(project, name)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n')
      utimesSync(file, date(modifiedAgo), date(modifiedAgo))
      return file
    }
    const recent = write('recent.jsonl', [record(6, 'split', 5), record(6, 'split', 20)])
    const month = write('month.jsonl', [record(29, 'month', 30)])
    const smallResumed = write('old-resumed.jsonl', [
      record(50, 'old', 40), record(0, 'new', 50),
      { type: 'speculation-accept', timeSavedMs: 11 },
    ])
    const largeResumed = write('old-large-resumed.jsonl', [
      record(50, 'old-large', 40), { type: 'padding', value: 'x'.repeat(70_000) },
      record(0, 'new-large', 50), { type: 'speculation-accept', timeSavedMs: 1000 },
    ])
    const stale = write('stale-mtime.jsonl', [record(1, 'stale', 500)], 50)
    const subagent = write('recent/subagents/agent-child.jsonl', [record(6, 'child', 10, true)])
    // Same basename in another file must not deduplicate across API responses.
    const monthLarge = write('month-large.jsonl', [
      record(15, 'split', 40), { type: 'padding', value: 'x'.repeat(70_000) },
      { type: 'speculation-accept', timeSavedMs: 13 },
    ])
    const fs = getFsImplementation()
    const realRead = json.readJSONLFile
    const reads: string[] = []
    const readSpy = spyOn(json, 'readJSONLFile').mockImplementation(async file => {
      reads.push(file)
      return realRead(file)
    })
    const realReaddir = fs.readdir.bind(fs)
    let discoveries = 0
    const discoverySpy = spyOn(fs, 'readdir').mockImplementation(async path => {
      if (path === projects) discoveries++
      return realReaddir(path)
    })
    try {
      const singleSeven = await aggregateClaudeCodeStatsForRange('7d')
      const singleThirty = await aggregateClaudeCodeStatsForRange('30d')
      const separateReads = reads.length
      expect(singleSeven.totalSessions).toBe(3)
      expect(singleSeven.totalMessages).toBe(4)
      expect(singleSeven.modelUsage[MODEL]).toMatchObject({ inputTokens: 400, outputTokens: 130 })
      expect(singleSeven.totalSpeculationTimeSavedMs).toBe(1024)
      expect(singleThirty.totalSessions).toBe(5)
      expect(singleThirty.modelUsage[MODEL]).toMatchObject({ inputTokens: 600, outputTokens: 200 })
      expect(singleThirty.totalSpeculationTimeSavedMs).toBe(1024)
      expect(discoveries).toBe(2)
      reads.length = 0
      discoveries = 0
      const together = await aggregateClaudeCodeStatsForRanges(['7d', '30d'])
      expect(together).toEqual({ '7d': singleSeven, '30d': singleThirty })
      expect(discoveries).toBe(1)
      expect(reads.sort()).toEqual([recent, month, smallResumed, largeResumed, subagent, monthLarge].sort())
      expect(separateReads).toBe(12)
      expect(reads).not.toContain(stale)
    } finally {
      readSpy.mockRestore()
      discoverySpy.mockRestore()
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
    }
  })

  test('attributes a session to every event day and includes recent events from an old session', async () => {
    const { mkdirSync } = await import('fs')
    const { aggregateClaudeCodeStatsForRange } = await import('./stats.js')
    tempDir = mkdtempSync(join(tmpdir(), 'cat-code-stats-event-dates-'))
    const project = join(tempDir, 'projects', 'fixture-project')
    mkdirSync(project, { recursive: true })
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tempDir
    const at = (daysAgo: number) => {
      const value = new Date()
      value.setHours(12, 0, 0, 0)
      value.setDate(value.getDate() - daysAgo)
      return value
    }
    const old = { ...assistantRecord('old', { input_tokens: 100, output_tokens: 20 }, 0), timestamp: at(8).toISOString() }
    const yesterday = { ...assistantRecord('yesterday', { input_tokens: 100, output_tokens: 20 }, 1), timestamp: at(1).toISOString() }
    const today = { ...assistantRecord('today', { input_tokens: 1200, output_tokens: 450 }, 2), timestamp: at(0).toISOString() }
    writeFileSync(
      join(project, 'resumed.jsonl'),
      [old, yesterday, today].map(record => JSON.stringify(record)).join('\n'),
    )
    try {
      const stats = await aggregateClaudeCodeStatsForRange('7d')
      expect(stats.totalSessions).toBe(1)
      expect(stats.totalMessages).toBe(2)
      expect(stats.dailyActivity.map(day => [day.date, day.sessionCount, day.messageCount])).toEqual([
        [at(1).toISOString().slice(0, 10), 1, 1],
        [at(0).toISOString().slice(0, 10), 1, 1],
      ])
      expect(stats.dailyModelTokens.map(day => [day.date, day.tokensByModel[MODEL]])).toEqual([
        [at(1).toISOString().slice(0, 10), 120],
        [at(0).toISOString().slice(0, 10), 1650],
      ])
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
    }
  })

  test('keeps a recent subagent tool call when its parent was last active yesterday', async () => {
    const { mkdirSync } = await import('fs')
    const { aggregateClaudeCodeStatsForRange } = await import('./stats.js')
    tempDir = mkdtempSync(join(tmpdir(), 'cat-code-stats-subagent-day-'))
    const project = join(tempDir, 'projects', 'fixture-project')
    const subagents = join(project, 'parent-session', 'subagents')
    mkdirSync(subagents, { recursive: true })
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tempDir
    const at = (daysAgo: number) => {
      const value = new Date()
      value.setHours(12, 0, 0, 0)
      value.setDate(value.getDate() - daysAgo)
      return value
    }
    const parent = {
      ...assistantRecord('parent', { input_tokens: 100, output_tokens: 20 }, 0),
      timestamp: at(1).toISOString(),
    }
    const child = {
      ...assistantRecord('child', { input_tokens: 50, output_tokens: 10 }, 0),
      isSidechain: true,
      timestamp: at(0).toISOString(),
      message: {
        ...assistantRecord('child', { input_tokens: 50, output_tokens: 10 }, 0).message,
        content: [{ type: 'tool_use', id: 'tool-child', name: 'Read', input: { file_path: 'fixture.ts' } }],
      },
    }
    writeFileSync(join(project, 'parent.jsonl'), JSON.stringify(parent))
    writeFileSync(join(subagents, 'agent-child.jsonl'), JSON.stringify(child))
    try {
      const stats = await aggregateClaudeCodeStatsForRange('7d')
      expect(stats.dailyActivity).toEqual([
        { date: at(1).toISOString().slice(0, 10), messageCount: 1, sessionCount: 1, toolCallCount: 0 },
        { date: at(0).toISOString().slice(0, 10), messageCount: 0, sessionCount: 0, toolCallCount: 1 },
      ])
      expect(stats.dailyModelTokens[1]?.tokensByModel[MODEL]).toBe(60)
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
    }
  })

  test('distinguishes an absent projects directory from an incomplete project read', async () => {
    const { mkdirSync } = await import('fs')
    const { spyOn } = await import('bun:test')
    const { aggregateClaudeCodeStatsForRange } = await import('./stats.js')
    const { getFsImplementation } = await import('./fsOperations.js')
    tempDir = mkdtempSync(join(tmpdir(), 'cat-code-stats-read-errors-'))
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tempDir
    try {
      expect((await aggregateClaudeCodeStatsForRange('7d')).totalSessions).toBe(0)
      const project = join(tempDir, 'projects', 'fixture-project')
      mkdirSync(project, { recursive: true })
      const fs = getFsImplementation()
      const realReaddir = fs.readdir.bind(fs)
      const spy = spyOn(fs, 'readdir').mockImplementation(async path => {
        if (path === project) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' })
        return realReaddir(path)
      })
      try {
        await expect(aggregateClaudeCodeStatsForRange('7d')).rejects.toThrow('fixture denied')
      } finally {
        spy.mockRestore()
      }
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
    }
  })
})
