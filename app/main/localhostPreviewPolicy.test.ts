import { expect, test } from 'bun:test'
import { normalizeLocalhostPreviewUrl, localhostPreviewHostPort } from '../shared/filePreview.js'
import { createLocalhostPreviewService, localhostPreviewInnerFrameAllowed } from './localhostPreview.js'

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

test('inner frames require the preview origin and the existing localhost admission check', () => {
  const service = createLocalhostPreviewService({ sessions: () => [], devOrigin: 'http://localhost:5173', publish: () => {} })
  const check = (page: string, target: string) => localhostPreviewInnerFrameAllowed(page, target, service.allowed)
  try {
    expect(check('http://localhost:6006/?path=/story/button', 'http://localhost:6006/iframe.html?id=button')).toBe(true)
    for (const target of [
      'http://localhost:6007/iframe.html', 'http://127.0.0.1:6006/iframe.html',
      'https://localhost:6006/', 'https://example.invalid/', 'about:blank', 'data:text/html,hello',
      'cat-preview://unrelated/r1/index.html', 'http://localhost:5173/', 'http://localhost:5173/redirected',
    ]) expect(check('http://localhost:6006/', target)).toBe(false)
    // Same-origin alone cannot admit the app, even after a redirect.
    expect(check('http://localhost:5173/start', 'http://localhost:5173/end')).toBe(false)
    expect(check('http://localhost:5173/', 'http://localhost:6006/')).toBe(false)
  } finally { service.dispose() }
})
