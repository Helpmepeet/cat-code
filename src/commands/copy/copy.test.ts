import { afterEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { copyOrWriteToFile } from './copy.js'
const paths: string[] = []
let tempRoot = ''
const previousTmpDir = process.env.TMPDIR

afterEach(async () => {
  if (previousTmpDir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTmpDir
  await Promise.all(
    paths.splice(0).map(path => rm(dirname(path), { recursive: true, force: true })),
  )
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

describe('copy fallback file', () => {
  test('retains a private response file for clipboard fallback', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copy-fallback-private-'))
    process.env.TMPDIR = tempRoot
    const legacyDirectory = join(tempRoot, 'claude')
    await Bun.write(join(tempRoot, 'outside.md'), 'untouched')
    await mkdir(legacyDirectory)
    const legacyPath = join(legacyDirectory, 'response.md')
    await symlink(join(tempRoot, 'outside.md'), legacyPath)

    const result = await copyOrWriteToFile(
      'sensitive response',
      'response.md',
      async () => '',
    )
    const path = result.match(/Also written to (.+)$/)?.[1]
    expect(path).toBeDefined()
    paths.push(path!)
    expect(await readFile(join(tempRoot, 'outside.md'), 'utf8')).toBe('untouched')
    expect((await lstat(legacyPath)).isSymbolicLink()).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('sensitive response')
    expect((await lstat(path)).isFile()).toBe(true)
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
    }
  })
})
