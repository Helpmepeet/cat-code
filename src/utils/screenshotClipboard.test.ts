import { afterEach, describe, expect, mock, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const invokeClipboard = mock(
  async (_command: string, args: string[], _options?: unknown) => {
    const path = args.at(-1)
    if (!path) throw new Error('clipboard command did not include an image path')
    const file = await lstat(path)
    expect(file.isFile()).toBe(true)
    expect(file.isSymbolicLink()).toBe(false)
    expect((await readFile(path)).length).toBeGreaterThan(0)
    return { code: 0, stderr: '' }
  },
)

mock.module('./execFileNoThrow.js', () => ({
  execFileNoThrowWithCwd: invokeClipboard,
}))
mock.module('./platform.js', () => ({
  getPlatform: () => 'linux',
}))

const { copyAnsiToClipboard } = await import('./screenshotClipboard.js')
let tempRoot = ''
const previousTmpDir = process.env.TMPDIR

afterEach(async () => {
  if (previousTmpDir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTmpDir
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  tempRoot = ''
  invokeClipboard.mockClear()
})

describe('copyAnsiToClipboard private image lifecycle', () => {
  test('uses an independent private image and removes it after clipboard success', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'screenshot-copy-private-'))
    process.env.TMPDIR = tempRoot
    const legacyDirectory = join(tempRoot, 'claude-code-screenshots')
    await mkdir(legacyDirectory)
    const outside = join(tempRoot, 'outside.png')
    const legacyPath = join(legacyDirectory, `screenshot-${Date.now()}.png`)
    await Bun.write(outside, 'untouched')
    await symlink(outside, legacyPath)

    const result = await copyAnsiToClipboard('private screenshot')

    expect(result.success).toBe(true)
    expect(invokeClipboard).toHaveBeenCalledTimes(1)
    expect(await readFile(outside, 'utf8')).toBe('untouched')
    expect((await lstat(legacyPath)).isSymbolicLink()).toBe(true)
    const path = invokeClipboard.mock.calls[0]?.[1].at(-1)
    expect(path).toBeDefined()
    await expect(lstat(path!)).rejects.toThrow()
  })

  test('removes the private image after clipboard failure', async () => {
    invokeClipboard.mockImplementationOnce(async (_command, args) => {
      return { code: 1, stderr: 'mock clipboard failure' }
    })
    invokeClipboard.mockImplementationOnce(async (_command, args) => {
      return { code: 1, stderr: 'mock fallback failure' }
    })

    const result = await copyAnsiToClipboard('private screenshot')

    expect(result.success).toBe(false)
    expect(invokeClipboard).toHaveBeenCalledTimes(2)
    const path = invokeClipboard.mock.calls[0]?.[1].at(-1)
    expect(path).toBeDefined()
    await expect(lstat(path!)).rejects.toThrow()
  })
})
