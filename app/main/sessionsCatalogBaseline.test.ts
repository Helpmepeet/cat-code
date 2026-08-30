import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionsCatalogSnapshot } from '../shared/protocol.js'
import { SESSIONS_CATALOG_CACHE_FILENAME } from '../shared/sessionsCatalogCache.js'
import { readSessionsCatalogCache } from './sessionsCatalogBaseline.js'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'catcode-baseline-'))
  dirs.push(dir)
  return dir
}

function writeRaw(dir: string, contents: string): void {
  writeFileSync(join(dir, SESSIONS_CATALOG_CACHE_FILENAME), contents, 'utf8')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const validSnapshot: SessionsCatalogSnapshot = {
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
      tag: null,
      mode: 'agent',
      agentSetting: null,
      prNumber: null,
      prRepository: null,
    },
  ],
  truncated: false,
  capturedAtMs: 1700,
}

describe('readSessionsCatalogCache', () => {
  test('a missing file returns null (no cache yet)', () => {
    expect(readSessionsCatalogCache(tempDir())).toBeNull()
  })

  test('a valid cache round-trips to the snapshot', () => {
    const dir = tempDir()
    writeRaw(dir, JSON.stringify(validSnapshot))
    expect(readSessionsCatalogCache(dir)).toEqual(validSnapshot)
  })

  // `notes` was dropped from the snapshot (nothing rendered it). A cache file
  // written by a build that still carried it must keep reading — dropping a field
  // must not blank the operator's history on the first launch after upgrade.
  test('a cache file carrying the removed notes field still reads', () => {
    const dir = tempDir()
    writeRaw(dir, JSON.stringify({ ...validSnapshot, notes: ['whatever'] }))
    expect(readSessionsCatalogCache(dir)).toEqual(validSnapshot)
  })

  test('a corrupt (non-JSON) file returns null, never throws', () => {
    const dir = tempDir()
    writeRaw(dir, '{ this is not json')
    expect(readSessionsCatalogCache(dir)).toBeNull()
  })

  test('a schema-drifted entry (wrong field type) fails closed to null', () => {
    const dir = tempDir()
    writeRaw(
      dir,
      JSON.stringify({
        entries: [{ ...validSnapshot.entries[0], modifiedAtMs: 'not-a-number' }],
        truncated: false,
        notes: [],
      }),
    )
    expect(readSessionsCatalogCache(dir)).toBeNull()
  })

  test('an unexpected mode value fails closed to null', () => {
    const dir = tempDir()
    writeRaw(
      dir,
      JSON.stringify({
        entries: [{ ...validSnapshot.entries[0], mode: 'bogus' }],
        truncated: false,
        notes: [],
      }),
    )
    expect(readSessionsCatalogCache(dir)).toBeNull()
  })

  test('a top-level shape violation (entries not an array) returns null', () => {
    const dir = tempDir()
    writeRaw(dir, JSON.stringify({ entries: {}, truncated: false, notes: [] }))
    expect(readSessionsCatalogCache(dir)).toBeNull()
  })

  // bug-sweep #1 — cwdExists is additive: an OLD cache file (written before the
  // field existed) must still read, defaulting the flag to true (assume-exists,
  // never wrongly hide an operator's prior history at first launch after upgrade).
  test('an old cache entry lacking cwdExists reads with cwdExists defaulted to true', () => {
    const dir = tempDir()
    const { cwdExists: _drop, ...legacyEntry } = validSnapshot.entries[0]!
    writeRaw(
      dir,
      JSON.stringify({ entries: [legacyEntry], truncated: false, notes: [] }),
    )
    expect(readSessionsCatalogCache(dir)?.entries[0]?.cwdExists).toBe(true)
  })

  test('a present cwdExists:false round-trips (a dead workspace stays hidden after relaunch)', () => {
    const dir = tempDir()
    writeRaw(
      dir,
      JSON.stringify({
        entries: [{ ...validSnapshot.entries[0], cwdExists: false }],
        truncated: false,
        notes: [],
      }),
    )
    expect(readSessionsCatalogCache(dir)?.entries[0]?.cwdExists).toBe(false)
  })

  test('a noninteractive transcript remains unavailable after a cold launch', () => {
    const dir = tempDir()
    writeRaw(
      dir,
      JSON.stringify({
        ...validSnapshot,
        entries: [{ ...validSnapshot.entries[0], isInteractive: false }],
      }),
    )
    expect(readSessionsCatalogCache(dir)?.entries[0]?.isInteractive).toBe(false)
  })

  test('a present non-boolean cwdExists fails closed to null (tamper/drift)', () => {
    const dir = tempDir()
    writeRaw(
      dir,
      JSON.stringify({
        entries: [{ ...validSnapshot.entries[0], cwdExists: 'yes' }],
        truncated: false,
        notes: [],
      }),
    )
    expect(readSessionsCatalogCache(dir)).toBeNull()
  })

  // The title-precedence pair. This cache IS the cold-launch baseline, so its
  // capture age must be the one the worker recorded — stamping it at read time
  // would make a months-old cache look freshly captured and let it outrank a
  // registry title written since.
  test('capturedAtMs + transcriptTitle round-trip through the cache file', () => {
    const dir = tempDir()
    writeRaw(dir, JSON.stringify(validSnapshot))
    const read = readSessionsCatalogCache(dir)
    expect(read?.capturedAtMs).toBe(1700)
    expect(read?.entries[0]?.transcriptTitle).toBe('Fix the parser')
  })

  test('an old cache file lacking them reads with the safe defaults (0 / null)', () => {
    const dir = tempDir()
    const { transcriptTitle: _drop, ...legacyEntry } = validSnapshot.entries[0]!
    writeRaw(dir, JSON.stringify({ entries: [legacyEntry], truncated: false, notes: [] }))
    const read = readSessionsCatalogCache(dir)
    expect(read?.capturedAtMs).toBe(0)
    expect(read?.entries[0]?.transcriptTitle).toBeNull()
  })

  test('a present non-number capturedAtMs fails closed to null (tamper/drift)', () => {
    const dir = tempDir()
    writeRaw(dir, JSON.stringify({ ...validSnapshot, capturedAtMs: 'soon' }))
    expect(readSessionsCatalogCache(dir)).toBeNull()
  })

  test('a present non-string transcriptTitle fails closed to null (tamper/drift)', () => {
    const dir = tempDir()
    writeRaw(
      dir,
      JSON.stringify({
        ...validSnapshot,
        entries: [{ ...validSnapshot.entries[0], transcriptTitle: 7 }],
      }),
    )
    expect(readSessionsCatalogCache(dir)).toBeNull()
  })
})
