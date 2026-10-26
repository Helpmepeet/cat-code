import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyGlassWindowBackground, readGlassPreference, writeGlassPreference } from './glassPreference.js'

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

test('each glass toggle repaints after changing the native background without a resize', () => {
  const calls: string[] = []
  const window = {
    setBackgroundColor: (color: string) => { calls.push(color) },
    webContents: { invalidate: () => { calls.push('repaint') } },
  }

  applyGlassWindowBackground(window, true)
  applyGlassWindowBackground(window, false)
  applyGlassWindowBackground(window, true)

  expect(calls).toEqual([
    '#00000000', 'repaint',
    '#09090b', 'repaint',
    '#00000000', 'repaint',
  ])
})

test('glass synchronization before window creation is harmless', () => {
  expect(() => applyGlassWindowBackground(null, true)).not.toThrow()
})
