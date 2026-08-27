import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFileSyncAndFlush_DEPRECATED } from './file.js'
import {
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
} from './fsOperations.js'

const scratchDirs: string[] = []

afterEach(() => {
  setOriginalFsImplementation()
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('durable file replacement', () => {
  test('an atomic rename failure preserves the old file instead of truncating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-'))
    scratchDirs.push(dir)
    const path = join(dir, 'state.json')
    writeFileSync(path, 'original')

    const originalFs = getFsImplementation()
    setFsImplementation({
      ...originalFs,
      renameSync() {
        throw new Error('synthetic rename failure')
      },
    })

    expect(() =>
      writeFileSyncAndFlush_DEPRECATED(path, 'replacement', {
        encoding: 'utf8',
      }),
    ).toThrow('synthetic rename failure')
    expect(readFileSync(path, 'utf8')).toBe('original')
    expect(readdirSync(dir)).toEqual(['state.json'])
  })
})
