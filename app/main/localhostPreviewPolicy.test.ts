import { expect, test } from 'bun:test'
import { normalizeLocalhostPreviewUrl, localhostPreviewHostPort } from '../shared/filePreview.js'

test('accepts only literal HTTP loopback authorities before URL canonicalization', () => {
  for (const [input, expected] of [
    ['http://localhost:4000', 'http://localhost:4000/'],
    ['HTTP://LOCALHOST:4000/a?q=1#part', 'http://localhost:4000/a?q=1#part'],
    ['http://127.0.0.1:4000/path', 'http://127.0.0.1:4000/path'],
    ['http://[::1]:4000/path', 'http://[::1]:4000/path'],
    ['http://localhost:80/', 'http://localhost/'],
  ]) expect(normalizeLocalhostPreviewUrl(input)).toBe(expected)
  for (const input of [
    'https://localhost:4000/', 'ftp://localhost/', 'http://localhost.evil/', 'http://localhost@evil/',
    'http://user:pass@localhost/', 'http://localhost./', 'http://127.1/', 'http://2130706433/',
    'http://0177.0.0.1/', 'http://0x7f000001/', 'http://127.000.000.001/', 'http://[0:0:0:0:0:0:0:1]/',
    'http://%6cocalhost/', 'http://localhost:0/', 'http://localhost:65536/', 'http://localhost:/',
    'http:\\localhost', 'http://localhost\\@evil/', 'http://localhost:4000/a\nb',
  ]) expect(normalizeLocalhostPreviewUrl(input)).toBeNull()
  expect(localhostPreviewHostPort('http://localhost/')).toBe('localhost:80')
  expect(localhostPreviewHostPort('http://[::1]:4000/route')).toBe('[::1]:4000')
})
