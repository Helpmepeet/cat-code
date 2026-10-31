import { expect, test } from 'bun:test'
import { localFileUrlPath } from './localFileUrl.js'

test('decodes local absolute URLs once without interpreting source suffixes', () => {
  expect(localFileUrlPath('file:///tmp/a%20b%2520.html:12')).toBe('/tmp/a b%20.html:12')
  expect(localFileUrlPath('FILE://localhost/tmp/a%23b.html')).toBe('/tmp/a#b.html')
})

test('rejects ambiguous, malformed and nonlocal URL spellings', () => {
  for (const value of ['file:/tmp/a', 'file://remote/tmp/a', 'file://user@localhost/tmp/a',
    'file://localhost:80/tmp/a', 'file:////tmp/a', 'file:///tmp/%', 'file:///tmp/%FF',
    'file:///tmp/%00', 'file:///tmp/%2fetc', 'file:///tmp/%5cetc', 'file:///tmp/a?b',
    'file:///tmp/a#b', 'file:///tmp/a\nb', 'https://localhost/tmp/a']) {
    expect(localFileUrlPath(value)).toBeNull()
  }
})
