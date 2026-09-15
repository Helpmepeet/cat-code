import { describe, expect, test } from 'bun:test'

import {
  isBoolean,
  isNumber,
  isString,
  narrowExact,
  narrowOpen,
  oneOf,
  optional,
} from './narrow.js'

const spec = {
  id: isString,
  count: isNumber,
  flag: optional(isBoolean),
}

describe('narrowExact — the closed-vocabulary gate', () => {
  test('a well-formed record round-trips into a fresh object', () => {
    const input = { id: 'a', count: 1, flag: true }
    const out = narrowExact(input, spec)
    expect(out).toEqual(input)
    expect(out).not.toBe(input)
  })

  test('an unnamed key fails the whole record', () => {
    expect(narrowExact({ id: 'a', count: 1, extra: 0 }, spec)).toBeNull()
  })

  test('a missing required key fails the whole record', () => {
    expect(narrowExact({ count: 1 }, spec)).toBeNull()
  })

  test('non-records are rejected', () => {
    expect(narrowExact(null, spec)).toBeNull()
    expect(narrowExact([], spec)).toBeNull()
    expect(narrowExact('a', spec)).toBeNull()
  })
})

describe('optional fields', () => {
  test('an absent key is absent in the result, not defaulted', () => {
    const out = narrowExact({ id: 'a', count: 1 }, spec)
    expect(out).not.toBeNull()
    expect('flag' in (out ?? {})).toBe(false)
  })

  test('a key PRESENT with undefined reads as absent (the IPC clone case)', () => {
    const out = narrowExact({ id: 'a', count: 1, flag: undefined }, spec)
    expect(out).not.toBeNull()
    expect('flag' in (out ?? {})).toBe(false)
  })

  test('a present wrong-typed value fails the whole record', () => {
    expect(narrowExact({ id: 'a', count: 1, flag: 'yes' }, spec)).toBeNull()
  })
})

describe('narrowOpen — tolerates unnamed keys', () => {
  test('an unnamed key is accepted and dropped from the result', () => {
    expect(narrowOpen({ id: 'a', count: 1, extra: 0 }, spec)).toEqual({
      id: 'a',
      count: 1,
    })
  })

  test('a missing required key still fails the whole record', () => {
    expect(narrowOpen({ count: 1 }, spec)).toBeNull()
  })
})

describe('oneOf', () => {
  test('accepts only listed values, comparing by identity', () => {
    const check = oneOf(['a', 'b', null] as const)
    expect(check('a')).toBe(true)
    expect(check(null)).toBe(true)
    expect(check('c')).toBe(false)
    expect(check(undefined)).toBe(false)
  })
})
