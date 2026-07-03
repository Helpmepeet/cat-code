import { expect, test } from 'bun:test'
import { checkJsonSafe } from './jsonSafe.js'

test('accepts POJOs, arrays, and JSON scalars', () => {
  expect(checkJsonSafe({ a: 1, b: 'x', c: [true, null, { d: 2.5 }] }).ok).toBe(true)
  expect(checkJsonSafe([]).ok).toBe(true)
  expect(checkJsonSafe('str').ok).toBe(true)
  expect(checkJsonSafe(0).ok).toBe(true)
  expect(checkJsonSafe(null).ok).toBe(true)
})

test('rejects the exact values JSON.stringify silently corrupts or throws on', () => {
  expect(checkJsonSafe(new Date()).ok).toBe(false)
  expect(checkJsonSafe(Buffer.from('x')).ok).toBe(false)
  expect(checkJsonSafe(new Uint8Array([1, 2])).ok).toBe(false)
  expect(checkJsonSafe(new Map()).ok).toBe(false)
  expect(checkJsonSafe(new Set()).ok).toBe(false)
  expect(checkJsonSafe(10n).ok).toBe(false)
  expect(checkJsonSafe(NaN).ok).toBe(false)
  expect(checkJsonSafe(Infinity).ok).toBe(false)
  expect(checkJsonSafe(() => {}).ok).toBe(false)
  expect(checkJsonSafe(Symbol('s')).ok).toBe(false)
})

test('rejects a nested corrupt value and reports its path', () => {
  const result = checkJsonSafe({ message: { content: [{ blob: Buffer.from('x') }] } })
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.path).toBe('$.message.content[0].blob')
  }
})

test('rejects cyclic references', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  expect(checkJsonSafe(cyclic).ok).toBe(false)
})

test('rejects a present undefined (dropped/nulled by JSON)', () => {
  expect(checkJsonSafe({ a: undefined }).ok).toBe(false)
  expect(checkJsonSafe([undefined]).ok).toBe(false)
})

test('rejects a sparse array (holes become null)', () => {
  const sparse: number[] = []
  sparse[3] = 1
  expect(checkJsonSafe(sparse).ok).toBe(false)
})

test('F15 — rejects negative zero (round-trips to +0)', () => {
  expect(checkJsonSafe(-0).ok).toBe(false)
  expect(checkJsonSafe({ x: -0 }).ok).toBe(false)
  expect(checkJsonSafe(0).ok).toBe(true)
})

test('F15 — rejects a symbol-keyed property (dropped by JSON)', () => {
  const withSymbol: Record<string | symbol, unknown> = { a: 1 }
  withSymbol[Symbol('s')] = 2
  expect(checkJsonSafe(withSymbol).ok).toBe(false)
})
