import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserPanePolicy } from './browserPanePolicy.js'
import { parseBrowserArgs } from '../shared/browserPane.js'

test('navigation rejects internet, dev origin and raw file URLs', async () => {
  const policy = new BrowserPanePolicy({ folders: () => [], devOrigin: 'http://localhost:5173' })
  for (const url of ['https://localhost:3000', 'http://example.com', 'http://localhost:5173/a', 'file:///tmp/a.html']) {
    await expect(policy.navigate('a', url)).rejects.toThrow()
  }
  expect(await policy.navigate('a', 'http://127.0.0.1:3000/a')).toBe('http://127.0.0.1:3000/a')
  expect(await policy.navigate('a', 'http://[::1]:3000')).toBe('http://[::1]:3000/')
})

test('local origin is per canonical directory and reads cannot escape or reach network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-policy-'))
  try {
    await mkdir(join(root, 'doc')); await mkdir(join(root, 'other'))
    await writeFile(join(root, 'doc', 'index.html'), 'hello')
    await writeFile(join(root, 'other', 'secret.txt'), 'secret')
    await symlink(join(root, 'other', 'secret.txt'), join(root, 'doc', 'escape.txt'))
    await symlink('/etc/hosts', join(root, 'doc', 'outside.html'))
    const policy = new BrowserPanePolicy({ folders: () => [root], devOrigin: null })
    const url = await policy.navigate('a', join(root, 'doc', 'index.html'))
    expect(await (await policy.respond('a', url)).text()).toBe('hello')
    expect((await policy.respond('a', new URL('escape.txt', url).href)).status).toBe(403)
    expect(policy.allowRequest('a', 'http://localhost:3000', url)).toBe(false)
    expect(policy.allowRequest('a', 'http://localhost:3000/', url, 'http://localhost:3000/')).toBe(true)
    expect(policy.allowRequest('a', 'http://localhost:3000/redirected', url, 'http://localhost:3000/')).toBe(true)
    expect(policy.allowRequest('a', 'http://localhost:3000/', url, url)).toBe(false)
    expect(policy.allowRequest('a', 'https://example.com/', url, 'http://localhost:3000/')).toBe(false)
    expect(policy.allowRequest('a', 'https://example.com/image.png', url)).toBe(false)
    const other = await policy.navigate('a', join(root, 'other', 'secret.txt'))
    expect(new URL(other).host).not.toBe(new URL(url).host)
    expect(policy.allowRequest('a', other, url)).toBe(false)
    expect(policy.allowRequest('b', url, url)).toBe(false)
    const missing = new BrowserPanePolicy({ folders: () => null, devOrigin: null })
    await expect(missing.navigate('a', join(root, 'doc', 'index.html'))).rejects.toThrow()
    await expect(policy.navigate('a', '/etc/hosts')).rejects.toThrow()
    await expect(policy.navigate('a', join(root, 'doc', 'outside.html'))).rejects.toThrow()
    expect((await policy.respond('a', url.replace('index.html', '%2e%2e%2fother%2fsecret.txt'))).status).toBe(403)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('closed browser argument schemas reject unknown fields and invalid shapes', () => {
  expect(parseBrowserArgs('browser.navigate', { action: 'navigate', target: 'http://localhost' })).toEqual({ action: 'navigate', target: 'http://localhost' })
  for (const value of [{ action: 'reload', extra: true }, { action: 'navigate' }, { action: 'back', target: 'x' }]) {
    expect(() => parseBrowserArgs('browser.navigate', value)).toThrow()
  }
  expect(() => parseBrowserArgs('browser.read', { extra: true })).toThrow()
  expect(() => parseBrowserArgs('browser.act', { action: 'click', x: Infinity, y: 2 })).toThrow()
})
