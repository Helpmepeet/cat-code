import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionsCatalogSnapshot } from '../shared/protocol.js'
import { SESSIONS_CATALOG_CACHE_FILENAME } from '../shared/sessionsCatalogCache.js'
import { writeSessionsCatalogCache } from './sessionsCatalogCache.js'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'catcode-sessions-catalog-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const snapshot: SessionsCatalogSnapshot = {
  entries: [
    {
      sessionId: 'eng-1',
      forked: false,
      cwd: '/Users/me/proj',
      cwdExists: true,
      title: 'Fix the parser',
      transcriptTitle: 'Fix the parser',
      modifiedAtMs: 1000,
      createdAtMs: 500,
      messageCount: 3,
      gitBranch: 'main',
      tag: 'bug',
      mode: 'normal',
      agentSetting: null,
      prNumber: 42,
      prRepository: 'me/proj',
    },
  ],
  truncated: false,
  capturedAtMs: 1700,
}

describe('writeSessionsCatalogCache', () => {
  test('writes valid JSON that round-trips to the snapshot', () => {
    const dir = tempDir()
    writeSessionsCatalogCache(snapshot, dir)
    const filePath = join(dir, SESSIONS_CATALOG_CACHE_FILENAME)
    expect(existsSync(filePath)).toBe(true)
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(parsed).toEqual(snapshot)
  })

  test('is atomic — leaves no temp file behind after a successful write', () => {
    const dir = tempDir()
    writeSessionsCatalogCache(snapshot, dir)
    const leftovers = readdirSync(dir).filter(name => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  test('last-writer-wins — a second write overwrites with the fresh enumeration', () => {
    const dir = tempDir()
    writeSessionsCatalogCache(snapshot, dir)
    const next: SessionsCatalogSnapshot = {
      ...snapshot,
      entries: [...snapshot.entries, { ...snapshot.entries[0]!, sessionId: 'eng-2' }],
    }
    writeSessionsCatalogCache(next, dir)
    const parsed = JSON.parse(
      readFileSync(join(dir, SESSIONS_CATALOG_CACHE_FILENAME), 'utf8'),
    ) as SessionsCatalogSnapshot
    expect(parsed.entries.map(e => e.sessionId)).toEqual(['eng-1', 'eng-2'])
  })

  test('creates the target dir when it does not exist', () => {
    const dir = join(tempDir(), 'nested', 'desktop')
    writeSessionsCatalogCache(snapshot, dir)
    expect(existsSync(join(dir, SESSIONS_CATALOG_CACHE_FILENAME))).toBe(true)
  })
})
