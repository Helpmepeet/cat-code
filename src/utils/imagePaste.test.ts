import { afterEach, describe, expect, mock, test } from 'bun:test'
import { lstat, mkdtemp, readFile, rm, stat, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const mockExeca = mock(async (command: string) => {
  if (command.includes('POSIX file')) {
    const match = command.match(/POSIX file "([^"]+)"/)
    if (!match?.[1]) throw new Error('private screenshot path missing')
    const file = await stat(match[1])
    if (process.platform !== 'win32') {
      expect(file.mode & 0o777).toBe(0o600)
    }
    await Bun.write(
      match[1],
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
        'base64',
      ),
    )
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  if (command.includes('TARGETS') || command.includes('clipboard as')) {
    return { exitCode: 0, stdout: 'image/png', stderr: '' }
  }
  return { exitCode: 1, stdout: '', stderr: '' }
})

mock.module('execa', () => ({
  execa: mockExeca,
  execaSync: mock(() => ({ exitCode: 0, stdout: '', stderr: '' })),
}))

const { shouldLogNativeClipboardFallbackError, getImageFromClipboard } =
  await import('./imagePaste.js')

let tempRoot = ''
const previousTempDir = process.env.CLAUDE_CODE_TMPDIR

afterEach(async () => {
  if (previousTempDir === undefined) delete process.env.CLAUDE_CODE_TMPDIR
  else process.env.CLAUDE_CODE_TMPDIR = previousTempDir
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  tempRoot = ''
  mockExeca.mockClear()
})

describe('imagePaste native clipboard fallback', () => {
  test('does not report missing optional native clipboard module as an error', () => {
    expect(
      shouldLogNativeClipboardFallbackError(
        new Error("Cannot find package 'image-processor-napi' from '/$bunfs/root/cli.js'"),
      ),
    ).toBe(false)

    expect(
      shouldLogNativeClipboardFallbackError(
        new Error('native clipboard reader unavailable'),
      ),
    ).toBe(false)
  })

  test('reports unexpected native clipboard failures before falling back', () => {
    expect(
      shouldLogNativeClipboardFallbackError(new Error('native clipboard crashed')),
    ).toBe(true)
  })
})

describe('imagePaste private screenshot lifecycle', () => {
  test('uses a private file instead of the preseeded legacy symlink and cleans it', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'image-paste-private-'))
    const outside = join(tempRoot, 'outside.png')
    await Bun.write(outside, 'untouched')
    await symlink(outside, join(tempRoot, 'claude_cli_latest_screenshot.png'))
    process.env.CLAUDE_CODE_TMPDIR = tempRoot

    const image = await getImageFromClipboard()

    expect(mockExeca).toHaveBeenCalledTimes(2)
    expect(image).not.toBeNull()
    expect(await readFile(outside, 'utf8')).toBe('untouched')
    expect(
      (await lstat(join(tempRoot, 'claude_cli_latest_screenshot.png'))).isSymbolicLink(),
    ).toBe(true)
    const saveCommand = mockExeca.mock.calls[1]?.[0]
    const screenshotPath = saveCommand?.match(/POSIX file "([^"]+)"/)?.[1]
    expect(screenshotPath).toBeDefined()
    await expect(lstat(screenshotPath!)).rejects.toThrow()
  })

  test('cleans the private screenshot when subprocess save fails', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'image-paste-failure-'))
    process.env.CLAUDE_CODE_TMPDIR = tempRoot
    mockExeca.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: 'image/png',
      stderr: '',
    }))
    mockExeca.mockImplementationOnce(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'mock save failure',
    }))

    expect(await getImageFromClipboard()).toBeNull()
    expect(mockExeca).toHaveBeenCalledTimes(2)
    expect(await (await import('fs/promises')).readdir(tempRoot)).toEqual([])
  })
})
