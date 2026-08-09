import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { plainTextStorage } from './plainTextStorage.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'plaintext-storage-'))
  process.env.CLAUDE_CONFIG_DIR = tempDir
})

afterEach(() => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  rmSync(tempDir, { recursive: true, force: true })
})

test('writes the plaintext credential fallback atomically with owner-only permissions', () => {
  const result = plainTextStorage.update({} as never)

  expect(result.success).toBe(true)
  expect(statSync(tempDir).mode & 0o777).toBe(0o700)
  expect(statSync(join(tempDir, '.credentials.json')).mode & 0o777).toBe(
    0o600,
  )
})
