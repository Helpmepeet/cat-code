import { afterEach, describe, expect, test } from 'bun:test'

import {
  _forTestResetImmediateOwner,
  claimImmediateOwner,
  clearSerializedLocalJsxPending,
  isCurrentImmediateOwner,
  isSerializedLocalJsxPending,
  markSerializedLocalJsxPending,
  resolveToolJsxUpdate,
} from './immediateCommand.js'

afterEach(() => {
  _forTestResetImmediateOwner()
})

describe('immediate owner tokens', () => {
  test('a newer claim invalidates earlier owners', () => {
    const first = claimImmediateOwner()
    expect(isCurrentImmediateOwner(first)).toBe(true)

    const second = claimImmediateOwner()
    expect(isCurrentImmediateOwner(first)).toBe(false)
    expect(isCurrentImmediateOwner(second)).toBe(true)
  })
})

describe('resolveToolJsxUpdate', () => {
  test('install always wins the slot', () => {
    expect(
      resolveToolJsxUpdate(undefined, false, { isLocalJSXCommand: true }),
    ).toBe('install')
    expect(
      resolveToolJsxUpdate(1, true, {
        isLocalJSXCommand: true,
        localJsxOwner: 2,
      }),
    ).toBe('install')
  })

  test("a stale command's clear does not evict a newer panel", () => {
    // /context (owner 1) finishes its analysis after /usage (owner 2)
    // installed its panel — the late clearLocalJSX must be ignored.
    expect(
      resolveToolJsxUpdate(2, true, { clearLocalJSX: true, localJsxOwner: 1 }),
    ).toBe('ignore')
  })

  test('an owner clearing its own panel clears', () => {
    expect(
      resolveToolJsxUpdate(2, true, { clearLocalJSX: true, localJsxOwner: 2 }),
    ).toBe('clear')
  })

  test('ownerless clear keeps the historical clear-anything behavior', () => {
    expect(resolveToolJsxUpdate(2, true, { clearLocalJSX: true })).toBe(
      'clear',
    )
    expect(resolveToolJsxUpdate(undefined, false, { clearLocalJSX: true })).toBe(
      'clear',
    )
  })

  test('an owned clear with no active panel never touches tool JSX', () => {
    // /context alone never installs a panel; its late clear must not null
    // unrelated toolJSX from the running turn.
    expect(
      resolveToolJsxUpdate(undefined, false, {
        clearLocalJSX: true,
        localJsxOwner: 1,
      }),
    ).toBe('ignore')
  })

  test('tool updates while a panel is active are ignored', () => {
    expect(
      resolveToolJsxUpdate(2, true, { isLocalJSXCommand: false }),
    ).toBe('ignore')
    expect(resolveToolJsxUpdate(2, true, null)).toBe('ignore')
  })

  test('updates apply normally when no panel is active', () => {
    expect(resolveToolJsxUpdate(undefined, false, {})).toBe('apply')
    expect(resolveToolJsxUpdate(undefined, false, null)).toBe('apply')
  })
})

describe('serialized local-jsx pending window', () => {
  test('marks and clears the pre-install dispatch window', () => {
    expect(isSerializedLocalJsxPending()).toBe(false)
    markSerializedLocalJsxPending()
    expect(isSerializedLocalJsxPending()).toBe(true)
    clearSerializedLocalJsxPending()
    expect(isSerializedLocalJsxPending()).toBe(false)
  })

  test('clearing is idempotent and reset clears a stuck window', () => {
    clearSerializedLocalJsxPending()
    expect(isSerializedLocalJsxPending()).toBe(false)

    markSerializedLocalJsxPending()
    _forTestResetImmediateOwner()
    expect(isSerializedLocalJsxPending()).toBe(false)
  })
})

describe('immediate display command flags', () => {
  test('read-only display panels are flagged immediate', async () => {
    const { context } = await import('../commands/context/index.js')
    const stats = (await import('../commands/stats/index.js')).default
    const help = (await import('../commands/help/index.js')).default
    const usage = (await import('../commands/usage/index.js')).default

    for (const command of [context, stats, help, usage]) {
      expect(command.immediate).toBe(true)
    }
  })
})
