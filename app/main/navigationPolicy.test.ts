/**
 * F16 / F8 / T3 — navigation and window-open policy.
 *
 * The renderer must be unable to navigate the app frame anywhere but the app
 * itself, and unable to spawn a new Electron window; only https: links reach the
 * OS browser. These are the pure decisions behind `will-navigate`,
 * `will-redirect`, and `setWindowOpenHandler`. Testing them here covers the
 * security POLICY without an Electron process (the live-renderer behaviors —
 * Node globals undefined, CSP blocking inline script — are covered by the
 * Electron smoke test, gated on Electron availability).
 */

import { expect, test } from 'bun:test'
import { pathToFileURL } from 'node:url'

import {
  decideWindowOpen,
  isAppOrigin,
  isSafeExternalUrl,
  type NavigationConfig,
} from './navigationPolicy.js'

const DEV: NavigationConfig = { isDev: true, devOrigin: 'http://localhost:5173' }
const PACKAGED_INDEX = '/Applications/CatCode.app/Contents/Resources/renderer/dist/index.html'
const PROD: NavigationConfig = { isDev: false, packagedIndexPath: PACKAGED_INDEX }

test('dev — only the configured Vite renderer entry document is the app origin', () => {
  expect(isAppOrigin('http://localhost:5173/', DEV)).toBe(true)
  expect(isAppOrigin('http://localhost:5173/#transcript', DEV)).toBe(true)
})

test('dev — another path on the Vite origin is blocked', () => {
  expect(isAppOrigin('http://localhost:5173/index.html', DEV)).toBe(false)
  expect(isAppOrigin('http://localhost:5173/attack.html', DEV)).toBe(false)
  expect(isAppOrigin('http://localhost:5173/@vite/client', DEV)).toBe(false)
})

test('dev — a different origin is blocked', () => {
  expect(isAppOrigin('http://evil.example/', DEV)).toBe(false)
  expect(isAppOrigin('http://localhost:6006/', DEV)).toBe(false)
  expect(isAppOrigin('https://localhost:5173/', DEV)).toBe(false) // scheme differs
})

test('a javascript: URL is never the app origin (T3 — no script navigation)', () => {
  expect(isAppOrigin('javascript:alert(1)', DEV)).toBe(false)
  expect(isAppOrigin('javascript:alert(1)', PROD)).toBe(false)
})

test('a data: URL is never the app origin', () => {
  expect(isAppOrigin('data:text/html,<script>alert(1)</script>', DEV)).toBe(false)
  expect(isAppOrigin('data:text/html,x', PROD)).toBe(false)
})

test('dev — a non-http(s) devOrigin does not admit opaque targets (F16 origin="null")', () => {
  // Regression: opaque schemes all serialize origin to "null". A misconfigured
  // `file:` devOrigin is ALSO "null", so a bare origin compare let file:/data:/
  // javascript: navigations through. A non-http dev origin must admit NOTHING.
  const fileDev: NavigationConfig = { isDev: true, devOrigin: 'file:///tmp/index.html' }
  expect(isAppOrigin('file:///etc/passwd', fileDev)).toBe(false)
  expect(isAppOrigin('file:///tmp/index.html', fileDev)).toBe(false)
  expect(isAppOrigin('data:text/html,x', fileDev)).toBe(false)
  expect(isAppOrigin('javascript:alert(1)', fileDev)).toBe(false)
})

test('dev — a garbage devOrigin admits nothing', () => {
  const badDev: NavigationConfig = { isDev: true, devOrigin: 'not a url' }
  expect(isAppOrigin('http://localhost:5173/', badDev)).toBe(false)
  expect(isAppOrigin('file:///etc/passwd', badDev)).toBe(false)
})

test('a relative/opaque/garbage target does not parse to the app origin', () => {
  expect(isAppOrigin('../secret', DEV)).toBe(false)
  expect(isAppOrigin('not a url', PROD)).toBe(false)
  expect(isAppOrigin('', PROD)).toBe(false)
})

test('prod (F8) — ONLY the exact packaged index file is the app origin', () => {
  const indexUrl = pathToFileURL(PACKAGED_INDEX).href
  expect(isAppOrigin(indexUrl, PROD)).toBe(true)
})

test('prod (F8) — a different local file is blocked, not every file: URL', () => {
  const evilFile = pathToFileURL('/Applications/CatCode.app/Contents/Resources/renderer/dist/evil.html').href
  const homeFile = pathToFileURL('/Users/victim/Downloads/attack.html').href
  expect(isAppOrigin(evilFile, PROD)).toBe(false)
  expect(isAppOrigin(homeFile, PROD)).toBe(false)
})

test('prod — an http(s) URL is blocked (packaged renderer is file:)', () => {
  expect(isAppOrigin('https://evil.example/', PROD)).toBe(false)
  expect(isAppOrigin('http://localhost:5173/', PROD)).toBe(false)
})

test('window.open / target=_blank is ALWAYS denied (no new Electron window)', () => {
  for (const url of [
    'https://example.com',
    'http://example.com',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'about:blank',
  ]) {
    expect(decideWindowOpen(url).action).toBe('deny')
  }
})

test('only an https: link is handed to the OS browser', () => {
  const https = decideWindowOpen('https://example.com/docs')
  expect(https).toEqual({ action: 'deny', openExternal: 'https://example.com/docs' })
})

test('non-https window.open targets are denied WITHOUT an external hand-off', () => {
  for (const url of [
    'http://example.com',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,x',
  ]) {
    expect(decideWindowOpen(url)).toEqual({ action: 'deny' })
  }
})

test('isSafeExternalUrl only accepts https:', () => {
  expect(isSafeExternalUrl('https://x.example')).toBe(true)
  expect(isSafeExternalUrl('http://x.example')).toBe(false)
  expect(isSafeExternalUrl('javascript:1')).toBe(false)
  expect(isSafeExternalUrl('garbage')).toBe(false)
})
