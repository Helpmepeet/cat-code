import { afterEach, expect, test } from 'bun:test'
import { readSessionAccountSelection, restoreSessionAccountSelection } from './sessionAccountBootstrap.js'
import {
  assertSessionAccountRouteAvailable,
  blockSessionAccountRoute,
  clearSessionAccountRouteBlock,
  getSessionAccountRouteBlock,
} from '../../src/services/api/sessionAccountRouting.js'

afterEach(() => {
  clearSessionAccountRouteBlock('anthropic')
  clearSessionAccountRouteBlock('openai')
})

test('replacement processes restore distinct chat selections without changing defaults', async () => {
  const defaults = { anthropic: 'default-claude', openai: 'default-codex' }
  for (const chat of ['a', 'b', 'a']) {
    const selected = { ...defaults }
    await restoreSessionAccountSelection({ anthropic: `claude-${chat}`, anthropicLoginGeneration: 3, openai: `codex-${chat}` }, {
      load: async () => {},
      selectAnthropic: (id, options) => {
        expect(options).toEqual({ persistDefault: false, expectedLoginGeneration: 3 })
        selected.anthropic = id
        return { accountUuid: id }
      },
      selectOpenai: (id, options) => {
        expect(options).toEqual({ persistDefault: false })
        selected.openai = id
        return { accountId: id }
      },
    })
    expect(selected).toEqual({ anthropic: `claude-${chat}`, openai: `codex-${chat}` })
    expect(getSessionAccountRouteBlock('anthropic')).toBeNull()
    expect(getSessionAccountRouteBlock('openai')).toBeNull()
  }
  expect(defaults).toEqual({ anthropic: 'default-claude', openai: 'default-codex' })
})

test('unavailable saved account holds only its provider and supports explicit-switch recovery', async () => {
  await restoreSessionAccountSelection({ anthropic: 'missing-id', openai: 'available-id' }, {
    load: async () => {},
    selectAnthropic: () => null,
    selectOpenai: id => ({ accountId: id }),
  })
  expect(getSessionAccountRouteBlock('anthropic')?.requestedAccountId).toBe('missing-id')
  expect(getSessionAccountRouteBlock('anthropic')?.message).not.toContain('missing-id')
  expect(() => assertSessionAccountRouteAvailable('anthropic')).toThrow('Open Accounts')
  expect(() => assertSessionAccountRouteAvailable('openai')).not.toThrow()
  clearSessionAccountRouteBlock('anthropic')
  expect(() => assertSessionAccountRouteAvailable('anthropic')).not.toThrow()
})

test('inventory errors and wrong resolved identities cannot release saved selection holds', async () => {
  await restoreSessionAccountSelection({ openai: 'saved' }, {
    load: async () => { throw new Error('private vault detail') },
    selectAnthropic: () => null,
    selectOpenai: () => null,
  })
  expect(getSessionAccountRouteBlock('openai')?.message).not.toContain('private vault detail')
  await restoreSessionAccountSelection({ anthropic: 'saved' }, {
    load: async () => {},
    selectAnthropic: () => ({ accountUuid: 'different' }),
    selectOpenai: () => null,
  })
  expect(() => assertSessionAccountRouteAvailable('anthropic')).toThrow()
})

test('new chats do not load or switch pools; guard results cannot be mutated externally', async () => {
  let calls = 0
  await restoreSessionAccountSelection(undefined, {
    load: async () => { calls++ },
    selectAnthropic: () => { calls++; return null },
    selectOpenai: () => { calls++; return null },
  })
  expect(calls).toBe(0)
  expect(getSessionAccountRouteBlock('openai')).toBeNull()
  blockSessionAccountRoute('openai', 'saved')
  getSessionAccountRouteBlock('openai')!.requestedAccountId = 'other'
  expect(getSessionAccountRouteBlock('openai')?.requestedAccountId).toBe('saved')
})

test('spawn selection parsing is closed, bounded and backward compatible', () => {
  expect(readSessionAccountSelection(undefined)).toBeUndefined()
  expect(readSessionAccountSelection('{}')).toBeUndefined()
  expect(readSessionAccountSelection('{"openai":"account-a"}')).toEqual({ openai: 'account-a' })
  for (const raw of ['[]', 'null', '{"token":"secret"}', '{"openai":""}', '{"openai":12}']) {
    expect(() => readSessionAccountSelection(raw)).toThrow()
  }
  expect(readSessionAccountSelection('{"anthropic":"account-a","anthropicLoginGeneration":0}'))
    .toEqual({ anthropic: 'account-a', anthropicLoginGeneration: 0 })
  for (const generation of [-1, 1.5, null, '1', Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => readSessionAccountSelection(JSON.stringify({ anthropic: 'account-a', anthropicLoginGeneration: generation }))).toThrow()
  }
  expect(() => readSessionAccountSelection('{"anthropicLoginGeneration":1}')).toThrow()
})

test('unversioned saved Claude identity is held to verified legacy generation zero', async () => {
  const selected: unknown[] = []
  await restoreSessionAccountSelection({ anthropic: 'legacy-account' }, {
    load: async () => {},
    selectAnthropic: (_id, options) => { selected.push(options); return null },
    selectOpenai: () => null,
  })
  expect(selected).toEqual([{ persistDefault: false, expectedLoginGeneration: 0 }])
  expect(getSessionAccountRouteBlock('anthropic')?.requestedAccountId).toBe('legacy-account')
})
