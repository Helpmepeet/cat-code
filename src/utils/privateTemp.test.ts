import { afterEach, describe, expect, test } from 'bun:test'
import { lstat, mkdtemp, readFile, rm, stat, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  createPrivateTempFile,
  removePrivateTempFile,
  writePrivateTempFile,
} from './privateTemp.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('private temporary files', () => {
  test('creates private directories and exclusive private files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'private-temp-test-'))
    roots.push(root)
    const filePath = await writePrivateTempFile('sensitive', 'copy-', '.md', root)
    const directory = await stat(dirname(filePath))
    const file = await lstat(filePath)

    expect(file.isFile()).toBe(true)
    expect(file.isSymbolicLink()).toBe(false)
    expect(await readFile(filePath, 'utf8')).toBe('sensitive')
    if (process.platform !== 'win32') {
      expect(directory.mode & 0o777).toBe(0o700)
      expect(file.mode & 0o777).toBe(0o600)
    }
  })

  test('isolates concurrent files and ignores preseeded legacy symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'private-temp-links-'))
    roots.push(root)
    const outside = join(root, 'outside.txt')
    await Bun.write(outside, 'untouched')
    await symlink(outside, join(root, 'response.md'))
    await symlink(outside, join(root, 'claude_cli_latest_screenshot.png'))
    const [first, second] = await Promise.all([
      writePrivateTempFile('one', 'copy-', '.md', root),
      writePrivateTempFile('two', 'copy-', '.md', root),
    ])

    expect(first).not.toBe(second)
    expect(await readFile(first, 'utf8')).toBe('one')
    expect(await readFile(second, 'utf8')).toBe('two')
    expect(await readFile(outside, 'utf8')).toBe('untouched')
    expect((await lstat(join(root, 'response.md'))).isSymbolicLink()).toBe(true)
    expect(
      (await lstat(join(root, 'claude_cli_latest_screenshot.png'))).isSymbolicLink(),
    ).toBe(true)
  })

  test('cleans only the private file directory when requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'private-temp-cleanup-'))
    roots.push(root)
    const filePath = await createPrivateTempFile('transient-', '.png', root)
    await removePrivateTempFile(filePath)

    await expect(lstat(filePath)).rejects.toThrow()
  })
})
