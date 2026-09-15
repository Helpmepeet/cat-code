import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  deleteFileWithVerifiedIdentity,
  getFileIdentity,
  writeTextContentWithVerifiedIdentity,
} from './file.js'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'file-write-safety-'))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('verified whole-file writes', () => {
  test('replaces the authorized target with the requested line endings', () => {
    const filePath = join(tmpDir, 'authorized-replacement.txt')
    writeFileSync(filePath, 'original\n')

    expect(
      writeTextContentWithVerifiedIdentity(
        filePath,
        'first\nsecond',
        'utf8',
        'CRLF',
        getFileIdentity(filePath),
      ),
    ).toBe(true)
    expect(readFileSync(filePath, 'utf8')).toBe('first\r\nsecond')
  })

  test('refuses a retargeted symlink instead of replacing its unread target', () => {
    const authorizedTarget = join(tmpDir, 'authorized.txt')
    const unreadTarget = join(tmpDir, 'unread.txt')
    const link = join(tmpDir, 'link.txt')
    writeFileSync(authorizedTarget, 'authorized original\n')
    writeFileSync(unreadTarget, 'unread original\n')
    symlinkSync(authorizedTarget, link)

    const identity = getFileIdentity(link)
    unlinkSync(link)
    symlinkSync(unreadTarget, link)

    expect(
      writeTextContentWithVerifiedIdentity(
        link,
        'replacement\n',
        'utf8',
        'LF',
        identity,
      ),
    ).toBe(false)
    expect(readFileSync(authorizedTarget, 'utf8')).toBe('authorized original\n')
    expect(readFileSync(unreadTarget, 'utf8')).toBe('unread original\n')
  })

  test('uses exclusive creation when a file appeared after the missing-file check', () => {
    const filePath = join(tmpDir, 'appeared-after-check.txt')
    writeFileSync(filePath, 'unread content\n')

    expect(
      writeTextContentWithVerifiedIdentity(
        filePath,
        'replacement\n',
        'utf8',
        'LF',
        undefined,
      ),
    ).toBe(false)
    expect(readFileSync(filePath, 'utf8')).toBe('unread content\n')
  })

  test('refuses to delete a replacement with the old identity', async () => {
    const filePath = join(tmpDir, 'replacement-before-delete.txt')
    writeFileSync(filePath, 'authorized original\n')
    const identity = getFileIdentity(filePath)
    writeFileSync(filePath, 'replacement\n')

    expect(await deleteFileWithVerifiedIdentity(filePath, identity)).toBe(false)
    expect(readFileSync(filePath, 'utf8')).toBe('replacement\n')
  })

  test('deletes the exact identity that was authorized', async () => {
    const filePath = join(tmpDir, 'authorized-delete.txt')
    writeFileSync(filePath, 'authorized original\n')
    const identity = getFileIdentity(filePath)

    expect(await deleteFileWithVerifiedIdentity(filePath, identity)).toBe(true)
    expect(() => readFileSync(filePath, 'utf8')).toThrow()
  })
})
