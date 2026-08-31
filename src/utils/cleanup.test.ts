import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { cleanupOldSessionFiles } from './cleanup.js'
import {
  activateTranscriptLease,
  releaseActiveTranscriptLease,
} from './transcriptLease.js'

const DAY_MS = 24 * 60 * 60 * 1000
/** Comfortably past DEFAULT_CLEANUP_PERIOD_DAYS (30). */
const OLD_MS = Date.now() - 100 * DAY_MS
/** Comfortably inside it. */
const FRESH_MS = Date.now() - DAY_MS

let configDir: string
let projectDir: string
let previousConfigDir: string | undefined

async function writeAged(path: string, ageMs: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, 'x')
  await utimes(path, new Date(ageMs), new Date(ageMs))
}

/**
 * A session directory shaped like the ones the engine actually writes:
 * `subagents/` from sessionStorage plus a `tool-results/` tree.
 */
async function makeSessionDir(
  sessionId: string,
  ageMs: number,
): Promise<string> {
  const sessionDir = join(projectDir, sessionId)
  await writeAged(join(sessionDir, 'subagents', 'agent-1.jsonl'), ageMs)
  await writeAged(join(sessionDir, 'subagents', 'agent-1.metadata.json'), ageMs)
  await writeAged(join(sessionDir, 'tool-results', 'Bash', 'result-1.txt'), ageMs)
  return sessionDir
}

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'cat-code-cleanup-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  projectDir = join(configDir, 'projects', '-tmp-project')
  await mkdir(projectDir, { recursive: true })
})

afterEach(async () => {
  await releaseActiveTranscriptLease().catch(() => {})
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  }
  await rm(configDir, { recursive: true, force: true })
})

describe('cleanupOldSessionFiles orphaned session directories', () => {
  test('removes an orphaned old session directory, subagents included', async () => {
    const sessionId = randomUUID()
    const sessionDir = await makeSessionDir(sessionId, OLD_MS)

    const result = await cleanupOldSessionFiles()

    expect(existsSync(sessionDir)).toBe(false)
    expect(result.messages).toBe(3)
    expect(result.errors).toBe(0)
  })

  test('leaves an orphaned session directory whose newest file is inside the cutoff', async () => {
    const sessionId = randomUUID()
    const sessionDir = await makeSessionDir(sessionId, OLD_MS)
    // One recent write anywhere beneath must protect the whole directory,
    // including the old files sitting next to it.
    await writeAged(join(sessionDir, 'subagents', 'agent-2.jsonl'), FRESH_MS)

    const result = await cleanupOldSessionFiles()

    expect(existsSync(join(sessionDir, 'subagents', 'agent-1.jsonl'))).toBe(true)
    expect(
      existsSync(join(sessionDir, 'subagents', 'agent-1.metadata.json')),
    ).toBe(true)
    expect(existsSync(join(sessionDir, 'subagents', 'agent-2.jsonl'))).toBe(true)
    // Old tool-results still get swept on the fall-through path.
    expect(
      existsSync(join(sessionDir, 'tool-results', 'Bash', 'result-1.txt')),
    ).toBe(false)
    expect(result.messages).toBe(1)
  })

  test('leaves subagents alone while the transcript still exists', async () => {
    const sessionId = randomUUID()
    const sessionDir = await makeSessionDir(sessionId, OLD_MS)
    await writeAged(join(projectDir, `${sessionId}.jsonl`), FRESH_MS)

    const result = await cleanupOldSessionFiles()

    expect(existsSync(join(projectDir, `${sessionId}.jsonl`))).toBe(true)
    expect(existsSync(join(sessionDir, 'subagents', 'agent-1.jsonl'))).toBe(true)
    expect(
      existsSync(join(sessionDir, 'subagents', 'agent-1.metadata.json')),
    ).toBe(true)
    expect(
      existsSync(join(sessionDir, 'tool-results', 'Bash', 'result-1.txt')),
    ).toBe(false)
    expect(result.messages).toBe(1)
  })

  test('does not touch an orphaned old session directory under a held lease', async () => {
    const sessionId = randomUUID()
    const sessionDir = await makeSessionDir(sessionId, OLD_MS)

    await activateTranscriptLease(sessionId)
    let result
    try {
      result = await cleanupOldSessionFiles()
    } finally {
      await releaseActiveTranscriptLease()
    }

    expect(existsSync(join(sessionDir, 'subagents', 'agent-1.jsonl'))).toBe(true)
    expect(
      existsSync(join(sessionDir, 'tool-results', 'Bash', 'result-1.txt')),
    ).toBe(true)
    expect(result.messages).toBe(0)
    expect(result.errors).toBe(0)
  })

  test('removes an orphaned old session directory holding only subagents', async () => {
    const sessionId = randomUUID()
    const sessionDir = join(projectDir, sessionId)
    await writeAged(join(sessionDir, 'subagents', 'agent-1.jsonl'), OLD_MS)

    const result = await cleanupOldSessionFiles()

    expect(existsSync(sessionDir)).toBe(false)
    expect(result.messages).toBe(1)
    expect(result.errors).toBe(0)
  })
})
