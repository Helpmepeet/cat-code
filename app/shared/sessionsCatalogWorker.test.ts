import { describe, expect, test } from 'bun:test'
import type { SessionCatalogEntry } from './protocol.js'
import {
  SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
  parseSessionsCatalogSnapshot,
  parseSessionsCatalogWorkerResult,
} from './sessionsCatalogWorker.js'

function entry(partial: Partial<SessionCatalogEntry> & { sessionId: string }): SessionCatalogEntry {
  return {
    cwd: '/w/proj',
    cwdExists: true,
    title: null,
    transcriptTitle: null,
    modifiedAtMs: 1000,
    createdAtMs: 500,
    messageCount: 0,
    gitBranch: null,
    tag: null,
    mode: null,
    agentSetting: null,
    prNumber: null,
    prRepository: null,
    ...partial,
  }
}

function catalogResult(entries: SessionCatalogEntry[]) {
  return {
    type: 'catalog' as const,
    version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
    catalog: { entries, truncated: false, notes: ['ok'] },
  }
}

describe('parseSessionsCatalogWorkerResult — accept valid', () => {
  test('a well-formed catalog record round-trips', () => {
    const record = catalogResult([entry({ sessionId: 'a', title: 'Refactor', tag: 'wip' })])
    const parsed = parseSessionsCatalogWorkerResult(record)
    expect(parsed).not.toBeNull()
    expect(parsed?.type).toBe('catalog')
    if (parsed?.type === 'catalog') {
      expect(parsed.catalog.entries).toHaveLength(1)
      expect(parsed.catalog.entries[0]!.sessionId).toBe('a')
    }
  })

  test('an empty catalog is valid (empty corpus)', () => {
    const parsed = parseSessionsCatalogWorkerResult(catalogResult([]))
    expect(parsed?.type).toBe('catalog')
  })

  test('a failure record is valid', () => {
    const parsed = parseSessionsCatalogWorkerResult({
      type: 'failure',
      version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
      reason: 'internal',
    })
    expect(parsed).toEqual({
      type: 'failure',
      version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
      reason: 'internal',
    })
  })

  test('round-trips through JSON (the real NDJSON path)', () => {
    const record = catalogResult([entry({ sessionId: 'a' })])
    const parsed = parseSessionsCatalogWorkerResult(JSON.parse(JSON.stringify(record)))
    expect(parsed?.type).toBe('catalog')
  })
})

describe('parseSessionsCatalogWorkerResult — reject invalid (fail closed)', () => {
  test('rejects a non-object', () => {
    expect(parseSessionsCatalogWorkerResult(null)).toBeNull()
    expect(parseSessionsCatalogWorkerResult('catalog')).toBeNull()
    expect(parseSessionsCatalogWorkerResult(42)).toBeNull()
  })

  test('rejects a wrong boundary version', () => {
    expect(
      parseSessionsCatalogWorkerResult({
        ...catalogResult([]),
        version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION + 1,
      }),
    ).toBeNull()
  })

  test('rejects an unknown discriminant', () => {
    expect(
      parseSessionsCatalogWorkerResult({
        type: 'partial',
        version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
        catalog: { entries: [], truncated: false, notes: [] },
      }),
    ).toBeNull()
  })

  test('rejects an unknown failure reason', () => {
    expect(
      parseSessionsCatalogWorkerResult({
        type: 'failure',
        version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
        reason: 'quota',
      }),
    ).toBeNull()
  })

  test('rejects extra keys on a catalog record', () => {
    expect(
      parseSessionsCatalogWorkerResult({ ...catalogResult([]), extra: true }),
    ).toBeNull()
  })

  test('rejects a catalog with a malformed entry (single bad entry fails the whole record)', () => {
    const record = catalogResult([entry({ sessionId: 'ok' })])
    ;(record.catalog.entries as unknown[]).push({ sessionId: 'bad', cwd: 123 })
    expect(parseSessionsCatalogWorkerResult(record)).toBeNull()
  })

  test('rejects a catalog missing required snapshot fields', () => {
    expect(
      parseSessionsCatalogWorkerResult({
        type: 'catalog',
        version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
        catalog: { entries: [] },
      }),
    ).toBeNull()
  })

  test('rejects an invalid mode enum on an entry', () => {
    const parsed = parseSessionsCatalogSnapshot({
      entries: [{ ...entry({ sessionId: 'a' }), mode: 'boss' }],
      truncated: false,
      notes: [],
    })
    expect(parsed).toBeNull()
  })
})

describe('cwdExists field (bug-sweep #1 — additive, fail-closed)', () => {
  test('a present cwdExists:false round-trips (a dead workspace stays dead)', () => {
    const parsed = parseSessionsCatalogSnapshot({
      entries: [{ ...entry({ sessionId: 'a' }), cwdExists: false }],
      truncated: false,
      notes: [],
    })
    expect(parsed?.entries[0]?.cwdExists).toBe(false)
  })

  test('a MISSING cwdExists defaults to true (a record from a worker build predating the field)', () => {
    // Strip the field the factory adds, mimicking an older worker's output.
    const { cwdExists: _drop, ...withoutFlag } = entry({ sessionId: 'a' })
    const parsed = parseSessionsCatalogSnapshot({
      entries: [withoutFlag],
      truncated: false,
      notes: [],
    })
    expect(parsed?.entries[0]?.cwdExists).toBe(true)
  })

  test('a PRESENT non-boolean cwdExists fails the whole record (tamper/drift)', () => {
    const parsed = parseSessionsCatalogSnapshot({
      entries: [{ ...entry({ sessionId: 'a' }), cwdExists: 'yes' }],
      truncated: false,
      notes: [],
    })
    expect(parsed).toBeNull()
  })
})

describe('title-precedence fields (transcriptTitle + capturedAtMs — additive, fail-closed)', () => {
  test('both round-trip through the boundary', () => {
    const parsed = parseSessionsCatalogSnapshot({
      entries: [{ ...entry({ sessionId: 'a' }), transcriptTitle: 'Renamed in the terminal' }],
      truncated: false,
      notes: [],
      capturedAtMs: 1234,
    })
    expect(parsed?.capturedAtMs).toBe(1234)
    expect(parsed?.entries[0]?.transcriptTitle).toBe('Renamed in the terminal')
  })

  test('a record predating the fields parses with the SAFE defaults (0 / null)', () => {
    // 0 = unknown capture age and null = no recorded title, so such a record can
    // never outrank a registry title — i.e. exactly the pre-fix behavior.
    const { transcriptTitle: _drop, ...legacyEntry } = entry({ sessionId: 'a' })
    const parsed = parseSessionsCatalogSnapshot({
      entries: [legacyEntry],
      truncated: false,
      notes: [],
    })
    expect(parsed?.capturedAtMs).toBe(0)
    expect(parsed?.entries[0]?.transcriptTitle).toBeNull()
  })

  test('a PRESENT non-number capturedAtMs fails the whole record', () => {
    expect(
      parseSessionsCatalogSnapshot({
        entries: [entry({ sessionId: 'a' })],
        truncated: false,
        notes: [],
        capturedAtMs: 'soon',
      }),
    ).toBeNull()
  })

  test('a PRESENT non-string/non-null transcriptTitle fails the whole record', () => {
    expect(
      parseSessionsCatalogSnapshot({
        entries: [{ ...entry({ sessionId: 'a' }), transcriptTitle: 7 }],
        truncated: false,
        notes: [],
      }),
    ).toBeNull()
  })

  test('the closed-vocabulary gate still rejects an UNKNOWN snapshot key', () => {
    expect(
      parseSessionsCatalogSnapshot({
        entries: [entry({ sessionId: 'a' })],
        truncated: false,
        notes: [],
        capturedAtMs: 1,
        smuggled: 'x',
      }),
    ).toBeNull()
  })
})
