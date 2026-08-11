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
