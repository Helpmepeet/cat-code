import { expect, test } from 'bun:test'
import { basename, commonDirPrefix, dirname } from './pathUtils.js'

test('dirname and basename round-trip a path that names a file', () => {
  for (const path of ['/a/b/c.ts', 'a.ts', '/a.ts', 'C:\\x\\y.ts']) {
    expect(dirname(path) + basename(path)).toBe(path)
  }
})

test('dirname is empty when there is no directory', () => {
  expect(dirname('a.ts')).toBe('')
  expect(dirname('')).toBe('')
})

test('commonDirPrefix hoists the deepest shared directory', () => {
  expect(
    commonDirPrefix(['/repo/app/shared/protocol.ts', '/repo/app/sidecar/server.ts']),
  ).toBe('/repo/app/')
  expect(
    commonDirPrefix(['/repo/app/src/a.ts', '/repo/app/src/b.ts', '/repo/app/src/c.ts']),
  ).toBe('/repo/app/src/')
})

test('commonDirPrefix compares whole segments, never characters', () => {
  // '/app/render' must not be reported as a shared prefix of '/app/renderer'.
  expect(commonDirPrefix(['/app/renderer/a.ts', '/app/render/b.ts'])).toBe('/app/')
})

test('commonDirPrefix refuses to hoist a bare root', () => {
  expect(commonDirPrefix(['/a.ts', '/b.ts'])).toBe('')
  expect(commonDirPrefix(['/etc/hosts', '/var/log/app.log'])).toBe('')
})

test('commonDirPrefix needs at least two paths', () => {
  expect(commonDirPrefix(['/repo/app/a.ts'])).toBe('')
  expect(commonDirPrefix([])).toBe('')
})

test('commonDirPrefix returns nothing when a member has no directory', () => {
  expect(commonDirPrefix(['/repo/app/a.ts', 'bare.ts'])).toBe('')
})

test('commonDirPrefix keeps the original separators', () => {
  // Rejoining segments with '/' would yield 'C:/x/', which then prefixes nothing.
  const prefix = commonDirPrefix(['C:\\x\\y.ts', 'C:\\x\\z.ts'])
  expect(prefix).toBe('C:\\x\\')
  expect('C:\\x\\y.ts'.startsWith(prefix)).toBe(true)
})

test('a hoisted prefix always prefixes every member it was computed from', () => {
  const runs = [
    ['/repo/app/shared/protocol.ts', '/repo/app/sidecar/server.ts'],
    ['/repo/app/src/a.ts', '/repo/app/src/b.ts'],
    ['/a/b/c/d.ts', '/a/b/e.ts', '/a/b/c/f.ts'],
    ['C:\\x\\y.ts', 'C:\\x\\z.ts'],
  ]
  for (const paths of runs) {
    const prefix = commonDirPrefix(paths)
    expect(prefix.length).toBeGreaterThan(0)
    for (const path of paths) expect(path.startsWith(prefix)).toBe(true)
  }
})

test('commonDirPrefix refuses an answer that does not prefix every input', () => {
  // Segments compare separator-agnostically, so a mixed run could otherwise yield
  // '/a/b/' — which '\\a\\b\\d.ts' does not start with.
  expect(commonDirPrefix(['/a/b/c.ts', '\\a\\b\\d.ts'])).toBe('')
})
