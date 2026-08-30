import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGlassPreference, writeGlassPreference } from './glassPreference.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-glass-'))
  roots.push(root)
  return root
}

test('glass preference defaults solid and persists a bounded boolean', () => {
  const root = tempRoot()
  expect(readGlassPreference(root)).toBe(false)
  writeGlassPreference(root, true)
  expect(readGlassPreference(root)).toBe(true)
  writeGlassPreference(root, false)
  expect(readGlassPreference(root)).toBe(false)
})
