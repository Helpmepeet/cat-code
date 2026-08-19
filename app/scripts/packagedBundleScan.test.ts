import { describe, expect, test, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanPackagedBundle, formatBundleScanFindings } from './packagedBundleScan.js'

const roots: string[] = []

function bundle(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'catcode-scan-'))
  roots.push(root)
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(root, relPath)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('scanPackagedBundle', () => {
  test('a bundle carrying only shipped files is clean', () => {
    const root = bundle({
      'Contents/Resources/app/main/main.js': 'console.log("hi")',
      'Contents/Resources/app/preload/preload.cjs': 'module.exports = {}',
      'Contents/Resources/app/renderer/dist/index.html': '<!doctype html>',
      'Contents/Resources/sidecar/cat-code-sidecar': 'binary-ish bytes',
    })
    expect(scanPackagedBundle(root)).toEqual([])
  })

  test('the development preload is rejected', () => {
    const root = bundle({ 'Contents/Resources/app/preload/preload.dev.cjs': 'x' })
    expect(scanPackagedBundle(root)).toEqual([
      { path: join('Contents', 'Resources', 'app', 'preload', 'preload.dev.cjs'), reason: 'development harness preload' },
    ])
  })

  test.each([
    ['Contents/Resources/app/node_modules/pkg/index.js', 'node_modules tree'],
    ['Contents/Resources/app/main/main.js.map', 'source map'],
    ['Contents/Resources/app/main/mainDecisions.test.js', 'test source'],
    ['Contents/Resources/.env', 'environment file'],
    ['Contents/Resources/app/server.pem', 'key material'],
    ['Contents/Resources/fixtures/session.json', 'test fixture'],
    ['Contents/Resources/default_app.asar', "Electron's placeholder app"],
  ])('%s is rejected as %s', (relPath, reason) => {
    const root = bundle({ [relPath]: 'x' })
    const findings = scanPackagedBundle(root)
    expect(findings.map(f => f.reason)).toContain(reason)
  })

  test('a credential baked into a shipped file is rejected', () => {
    const root = bundle({
      'Contents/Resources/app/main/main.js': `const key = "sk-ant-api03-${'A'.repeat(64)}"`,
    })
    const findings = scanPackagedBundle(root)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.reason).toBe('Anthropic API key')
  })

  test('a credential baked into the compiled sidecar is rejected despite its lack of extension', () => {
    const root = bundle({
      'Contents/Resources/sidecar/cat-code-sidecar':
        '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
    })
    expect(scanPackagedBundle(root).map(f => f.reason)).toEqual(['private key block'])
  })

  test('a bare credential prefix is NOT rejected, so the engine\'s own validation constants do not fail every build', () => {
    const root = bundle({
      'Contents/Resources/app/main/main.js': 'if (token.startsWith("sk-ant-")) reject()',
    })
    expect(scanPackagedBundle(root)).toEqual([])
  })

  test('a symlink to denied content is reported instead of being walked through', () => {
    // The regression this exists for: a Dirent for a symlink is neither a file
    // nor a directory, so the walk skipped it and every rule above could be
    // bypassed by linking to the content instead of copying it.
    const outside = mkdtempSync(join(tmpdir(), 'catcode-scan-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'secret.json'), `{"k":"sk-ant-api03-${'A'.repeat(64)}"}`)

    const root = bundle({ 'Contents/Resources/app/main/main.js': 'ok' })
    symlinkSync(join(outside, 'secret.json'), join(root, 'Contents', 'Resources', 'app', 'creds.json'))

    const findings = scanPackagedBundle(root)
    expect(findings.map(f => f.reason)).toEqual(['symbolic link'])
    expect(findings[0]?.path).toBe(join('Contents', 'Resources', 'app', 'creds.json'))
  })

  test('a symlinked development preload is reported, not skipped', () => {
    const outside = mkdtempSync(join(tmpdir(), 'catcode-scan-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'preload.dev.cjs'), 'harness')

    const root = bundle({ 'Contents/Resources/app/main/main.js': 'ok' })
    mkdirSync(join(root, 'Contents', 'Resources', 'app', 'preload'), { recursive: true })
    symlinkSync(
      join(outside, 'preload.dev.cjs'),
      join(root, 'Contents', 'Resources', 'app', 'preload', 'preload.dev.cjs'),
    )
    expect(scanPackagedBundle(root).map(f => f.reason)).toContain('symbolic link')
  })

  test("the stock framework's own symlinks are allowed, so real bundles stay clean", () => {
    const root = bundle({ 'Contents/Frameworks/Electron Framework.framework/Versions/A/x': 'ok' })
    symlinkSync(
      'Versions/A/x',
      join(root, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Current'),
    )
    expect(scanPackagedBundle(root)).toEqual([])
  })

  test('a JWT, an AWS key id, and a key in a transcript or yaml are all caught', () => {
    const jwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(20)}`
    for (const [file, content, reason] of [
      ['Contents/Resources/app/codex-accounts.json', `{"access_token":"${jwt}"}`, 'JWT'],
      ['Contents/Resources/app/aws.json', '{"id":"AKIAIOSFODNN7EXAMPLE"}', 'AWS access key id'],
      ['Contents/Resources/app/t.jsonl', `{"k":"sk-ant-api03-${'A'.repeat(64)}"}`, 'Anthropic API key'],
      ['Contents/Resources/app/c.yaml', `key: sk-ant-api03-${'A'.repeat(64)}`, 'Anthropic API key'],
    ] as const) {
      const root = bundle({ [file]: content })
      expect(scanPackagedBundle(root).map(f => f.reason)).toContain(reason)
    }
  })

  test('.envrc is rejected alongside .env', () => {
    const root = bundle({ 'Contents/Resources/.envrc': 'export X=1' })
    expect(scanPackagedBundle(root).map(f => f.reason)).toContain('environment file')
  })

  test('findings format one per line for the build log', () => {
    expect(formatBundleScanFindings([{ path: 'a/b.js', reason: 'source map' }])).toBe('  a/b.js: source map')
  })
})
