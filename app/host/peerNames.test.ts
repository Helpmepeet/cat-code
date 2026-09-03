/**
 * Peer-name picker tests (PEER-SESSIONS §2/§2a).
 *
 * The pool's SIZE and DISJOINTNESS are the two properties nothing else can
 * catch: an undersized pool degrades silently into `Bear-2` names, and a name
 * shared with a subagent pool makes "send to Turing" ambiguous only once both
 * happen to be live. Both are asserted against their real sources — the
 * registry bound constant, and the engine's own pool arrays read off disk.
 */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { MAX_REGISTRY_SESSIONS } from './registry.js'
import {
  PEER_NAME_POOL,
  peerNameKey,
  pickPeerName,
  randomPeerNameCursor,
} from './peerNames.js'

/**
 * The engine's three subagent pools, read as TEXT rather than imported.
 * `app/tsconfig.json` deliberately cannot resolve `src/*` (that is the whole
 * reason `peerNames.ts` is a copy), so an import here would not typecheck — and
 * a hand-copied list would stop tracking the engine the moment someone appends
 * a name there, which is exactly the regression this test exists to catch.
 */
function engineSubagentNames(): string[] {
  const path = join(import.meta.dir, '../../src/agent-mode/workerNames.ts')
  const source = readFileSync(path, 'utf8')
  const arrays = [
    ...source.matchAll(
      /const (?:CODING_WORKER_NAMES|VERIFIER_NAMES|GENERIC_WORKER_NAMES) = \[([^\]]*)\]/g,
    ),
  ]
  // Fail loudly if the engine file is restructured: a silently-empty match would
  // turn the disjointness assertion below into a no-op that always passes.
  expect(arrays.length).toBe(3)
  const names = arrays.flatMap(match =>
    [...match[1]!.matchAll(/'([^']+)'/g)].map(quoted => quoted[1]!),
  )
  expect(names.length).toBeGreaterThan(40)
  return names
}

test('the pool is at least as large as the registry bound it must uniquely cover', () => {
  // PEER-SESSIONS §2: uniqueness spans the registry, so a pool smaller than the
  // row bound makes suffixed names the normal case rather than the exhaustion
  // fallback. Read off the constant, not a literal, so raising the bound fails
  // here instead of quietly degrading naming.
  expect(PEER_NAME_POOL.length).toBeGreaterThanOrEqual(MAX_REGISTRY_SESSIONS)
})

test('the pool is disjoint from every engine subagent pool and internally unique', () => {
  const engine = new Set(engineSubagentNames().map(peerNameKey))
  const collisions = PEER_NAME_POOL.filter(name => engine.has(peerNameKey(name)))
  expect(collisions).toEqual([])

  const keys = PEER_NAME_POOL.map(peerNameKey)
  expect(new Set(keys).size).toBe(PEER_NAME_POOL.length)
})

test('the pool avoids vocabulary the product itself shows the operator', () => {
  // PEER-SESSIONS R4 puts the session name in the sidebar subtitle slot that
  // used to hold the model label, so a session named Sol would render
  // "2h ago · Sol" exactly where "GPT-5.6 Sol" used to be. Read the model labels
  // out of their real source, so a future model called Garnet fails here.
  const adapter = readFileSync(
    join(import.meta.dir, '../../src/services/api/codex-fetch-adapter.ts'),
    'utf8',
  )
  const labels = [...adapter.matchAll(/label: '([^']+)'/g)].map(match => match[1]!)
  expect(labels.length).toBeGreaterThan(4)
  // Each label's distinguishing word ("GPT-5.6 Sol" → "Sol"), which is what a
  // reader actually tells apart.
  const labelWords = new Set(
    labels.flatMap(label => label.split(/[\s.]+/)).map(peerNameKey).filter(Boolean),
  )
  const collisions = PEER_NAME_POOL.filter(name => labelWords.has(peerNameKey(name)))
  expect(collisions).toEqual([])

  // The other two product nouns found in the same sweep: an accent-theme name
  // the operator picks in Settings, and a provider the product names.
  const pool = new Set(PEER_NAME_POOL.map(peerNameKey))
  expect(pool.has('amber')).toBe(false)
  expect(pool.has('bedrock')).toBe(false)
})

test('the picker starts at the cursor, skips reserved names, and reports where to resume', () => {
  const pool = ['Agate', 'Beryl', 'Coral', 'Diamond']

  const first = pickPeerName([], 0, pool)
  expect(first.name).toBe('Agate')
  expect(first.nextCursor).toBe(1)

  // Reserved comparison is case-insensitive and trims, the `recipientNameKey`
  // rule: a row holding ' beryl ' must still block 'Beryl'.
  const second = pickPeerName([' beryl '], first.nextCursor, pool)
  expect(second.name).toBe('Coral')
  expect(second.nextCursor).toBe(3)

  // The walk wraps rather than stopping at the end of the pool.
  const third = pickPeerName(['Diamond'], second.nextCursor, pool)
  expect(third.name).toBe('Agate')
  expect(third.nextCursor).toBe(1)
})

test('a full pool suffixes the entry at the cursor instead of failing', () => {
  const pool = ['Agate', 'Beryl']
  const taken = ['Agate', 'Beryl', 'beryl-2']

  // Cursor 1 ⇒ base 'Beryl'; '-2' is taken (case-insensitively), so '-3'.
  const picked = pickPeerName(taken, 1, pool)
  expect(picked.name).toBe('Beryl-3')
  expect(picked.nextCursor).toBe(0)

  // And the suffixed name is itself never handed out twice.
  const next = pickPeerName([...taken, picked.name], 1, pool)
  expect(next.name).toBe('Beryl-4')
})

test('a nonsense cursor is tolerated rather than producing an undefined name', () => {
  // The cursor is state a caller kept across calls (the host keeps it in memory
  // across every spawn), so an out-of-range or non-finite value must not index
  // past the pool and return undefined.
  const pool = ['Agate', 'Beryl', 'Coral']
  expect(pickPeerName([], 7, pool).name).toBe('Beryl')
  expect(pickPeerName([], -1, pool).name).toBe('Coral')
  expect(pickPeerName([], Number.NaN, pool).name).toBe('Agate')
})

test('an empty pool throws rather than returning an empty name', () => {
  expect(() => pickPeerName([], 0, [])).toThrow('peer name pool must not be empty')
})

test('the random cursor is always a valid index into the pool', () => {
  for (let i = 0; i < 50; i += 1) {
    const cursor = randomPeerNameCursor()
    expect(cursor).toBeGreaterThanOrEqual(0)
    expect(cursor).toBeLessThan(PEER_NAME_POOL.length)
  }
})
