import { expect, test } from 'bun:test'
import { createExternalUrlHandler } from './externalUrl.js'

test('only the trusted app frame can open bounded HTTP(S) links through the external browser boundary', async () => {
  const opened: string[] = []
  const handler = createExternalUrlHandler<boolean>({ isTrustedSender: event => event, open: async url => { opened.push(url) } })
  expect(await handler(false, { url: 'https://example.com/' })).toBe(false)
  for (const input of [null, [], {}, { url: 2 }, { url: 'https://example.com', extra: true },
    { url: 'file:///etc/passwd' }, { url: 'javascript:alert(1)' }, { url: 'data:text/html,x' },
    { url: 'mailto:person@example.com' }, { url: '/relative' }, { url: 'https://example.com/\0' }, { url: 'https://example.com/' + 'a'.repeat(4096) },
  ]) expect(await handler(true, input)).toBe(false)
  expect(opened).toEqual([])
  expect(await handler(true, { url: 'http://example.com/path?q=1#section' })).toBe(true)
  expect(await handler(true, { url: 'https://example.com' })).toBe(true)
  expect(opened).toEqual(['http://example.com/path?q=1#section', 'https://example.com/'])
})

test('external opening bounds in-flight OS requests and releases admission after failures', async () => {
  const pending: Array<() => void> = []
  const handler = createExternalUrlHandler<boolean>({ isTrustedSender: event => event, open: () => new Promise<void>(resolve => pending.push(resolve)) })
  const requests = Array.from({ length: 4 }, () => handler(true, { url: 'https://example.com' }))
  expect(await handler(true, { url: 'https://example.com' })).toBe(false)
  expect(pending).toHaveLength(4)
  pending.splice(0).forEach(resolve => resolve())
  expect(await Promise.all(requests)).toEqual([true, true, true, true])
  let fail = true
  const retry = createExternalUrlHandler<boolean>({ isTrustedSender: event => event, open: async () => { if (fail) throw new Error('OS refused') } })
  expect(await retry(true, { url: 'https://example.com' })).toBe(false)
  fail = false
  expect(await retry(true, { url: 'https://example.com' })).toBe(true)
})
