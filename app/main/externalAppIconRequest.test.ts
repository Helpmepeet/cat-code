import { expect, test } from 'bun:test'
import { createExternalAppIconHandler } from './externalAppIconRequest.js'

const icon = { dataUrl: 'data:image/png;base64,aWNvbg==' }

test('fixed icon targets reject untrusted senders and arbitrary application paths', async () => {
  const reads: unknown[] = []
  const handler = createExternalAppIconHandler({
    isTrustedSender: (trusted: boolean) => trusted,
    resolveFile: async () => { throw new Error('unexpected file read') },
    read: async (...args) => { reads.push(args); return icon },
  })
  for (const input of [null, [], { target: 'unknown' }, { target: 'finder', path: '/private' }, { target: 'default' }]) {
    expect(await handler(true, input)).toEqual({ dataUrl: null })
  }
  expect(await handler(false, { target: 'finder' })).toEqual({ dataUrl: null })
  expect(await handler(true, { target: 'finder' }, 'extra')).toEqual({ dataUrl: null })
  expect(reads).toEqual([])
  expect(await handler(true, { target: 'finder' })).toEqual(icon)
  expect(reads).toEqual([['finder']])
})

test('default file icons only use the canonical accepted workspace path', async () => {
  const reads: unknown[] = []
  const resolved: unknown[] = []
  const handler = createExternalAppIconHandler({
    isTrustedSender: () => true,
    resolveFile: async (...args) => { resolved.push(args); return args[1] === 'safe.ts:7' ? '/canonical/safe.ts' : null },
    read: async (...args) => { reads.push(args); return icon },
  })
  expect(await handler(null, { target: 'default', appSessionId: 'session', path: '../secret' })).toEqual({ dataUrl: null })
  expect(reads).toEqual([])
  expect(await handler(null, { target: 'default', appSessionId: 'session', path: 'safe.ts:7' })).toEqual(icon)
  expect(resolved).toEqual([['session', '../secret'], ['session', 'safe.ts:7']])
  expect(reads).toEqual([['default', '/canonical/safe.ts']])
})

test('icon reads are concurrency bounded and failures release admission', async () => {
  const finish: Array<() => void> = []
  const handler = createExternalAppIconHandler({
    isTrustedSender: () => true,
    resolveFile: async () => null,
    read: async () => new Promise(resolve => { finish.push(() => resolve(icon)) }),
  })
  const pending = Array.from({ length: 8 }, () => handler(null, { target: 'browser' }))
  expect(await handler(null, { target: 'browser' })).toEqual({ dataUrl: null })
  finish.forEach(resolve => resolve())
  await Promise.all(pending)
  const next = handler(null, { target: 'browser' })
  finish.at(-1)!()
  expect(await next).toEqual(icon)
  const broken = createExternalAppIconHandler({ isTrustedSender: () => true, resolveFile: async () => { throw new Error('unavailable') }, read: async () => { throw new Error('unavailable') } })
  expect(await broken(null, { target: 'finder' })).toEqual({ dataUrl: null })
  expect(await broken(null, { target: 'default', appSessionId: 'session', path: 'file' })).toEqual({ dataUrl: null })
})
