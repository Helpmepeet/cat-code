import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdtemp,
  mkdir,
  link,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  bindPreparedFileInput,
  getPreparedFileMutation,
  getPreparedFileRead,
  getPreparedFileMutationSet,
  prepareFileMutationAuthorization,
  prepareFileRead,
  preparedFileIdentity,
  type PreparedFileMutation,
  type PreparedFileRead,
} from './fileAuthorization.js'

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(tempDirs.map(path => rm(path, { recursive: true, force: true })))
  tempDirs.length = 0
})

describe('prepared file authorization', () => {
  test('only schema-equivalent input copies reuse the original bound path', async () => {
    const base = await makeTempDir('file-auth-input-')
    const path = join(base, 'bound.txt')
    await writeFile(path, 'bound')
    const input = { file_path: path, offset: undefined }
    const prepared = await prepareFileRead(path)
    bindPreparedFileInput(prepared, input, value => ({
      file_path: value.file_path,
    }))
    const context = {
      preparedExecution: {
        toolName: 'FileRead',
        input,
        state: prepared,
      },
    }
    try {
      expect(
        getPreparedFileRead(
          context as never,
          'FileRead',
          { file_path: path },
        ),
      ).toBe(prepared)
      expect(
        getPreparedFileRead(
          context as never,
          'FileRead',
          { file_path: join(base, 'other.txt') },
        ),
      ).toBeUndefined()
      input.file_path = join(base, 'mutated-same-reference.txt')
      expect(
        getPreparedFileRead(context as never, 'FileRead', input),
      ).toBeUndefined()
    } finally {
      await prepared.cleanup()
    }
  })

  test('mutation and compound capabilities reject same-reference input mutation', async () => {
    const base = await makeTempDir('file-auth-mutation-input-')
    const path = join(base, 'bound.txt')
    await writeFile(path, 'bound')
    const mutationInput = { file_path: path, content: 'replacement' }
    const mutation = await prepareFileMutationAuthorization(path)
    bindPreparedFileInput(mutation, mutationInput, value => ({
      file_path: value.file_path,
      content: value.content,
    }))
    const mutationContext = {
      preparedExecution: {
        toolName: 'FileWrite',
        input: mutationInput,
        state: mutation,
      },
    }
    const setInput = { input: '*** Begin Patch\n*** End Patch' }
    const setState = bindPreparedFileInput(
      { byPath: new Map<string, PreparedFileMutation>(), async cleanup() {} },
      setInput,
    )
    const setContext = {
      preparedExecution: {
        toolName: 'FilePatch',
        input: setInput,
        state: setState,
      },
    }
    try {
      expect(
        getPreparedFileMutation(
          mutationContext as never,
          'FileWrite',
          mutationInput,
        ),
      ).toBe(mutation)
      mutationInput.file_path = join(base, 'other.txt')
      expect(
        getPreparedFileMutation(
          mutationContext as never,
          'FileWrite',
          mutationInput,
        ),
      ).toBeUndefined()

      expect(
        getPreparedFileMutationSet(setContext as never, 'FilePatch', setInput),
      ).toBe(setState)
      setInput.input = '*** Begin Patch\n*** Add File: other.txt\n*** End Patch'
      expect(
        getPreparedFileMutationSet(setContext as never, 'FilePatch', setInput),
      ).toBeUndefined()
    } finally {
      await mutation.cleanup()
    }
  })

  test('rejects NUL path components before native path traversal', async () => {
    const base = await makeTempDir('file-auth-nul-')
    await expect(
      prepareFileRead(`${base}/allowed\0name/outside`),
    ).rejects.toThrow(/NUL|null/)
    await expect(
      prepareFileMutationAuthorization(`${base}/allowed\0name/outside`),
    ).rejects.toThrow(/NUL|null/)
  })

  test('does not follow a file symlink installed after a missing-path preparation', async () => {
    const base = await makeTempDir('file-auth-late-link-')
    const outside = join(base, 'outside.txt')
    const missing = join(base, 'missing.txt')
    await writeFile(outside, 'outside-marker')
    const prepared = await prepareFileRead(missing)
    try {
      await symlink(outside, missing)
      await expect(prepared.openFile()).rejects.toThrow()
      expect((await readFile(outside, 'utf8')).toString()).toBe(
        'outside-marker',
      )
    } finally {
      await prepared.cleanup()
    }
  })

  test('repeated target and ancestor symlink swaps cannot redirect an opened read', async () => {
    const base = await makeTempDir('file-auth-read-')
    const allowed = join(base, 'allowed')
    const outside = join(base, 'outside')
    const parent = join(base, 'parent')
    await mkdir(allowed)
    await mkdir(outside)
    await writeFile(join(allowed, 'target'), 'authorized-bytes')
    await writeFile(join(outside, 'target'), 'outside-marker')
    await symlink(allowed, parent)

    for (let index = 0; index < 32; index++) {
      const prepared = await prepareFileRead(join(parent, 'target'))
      try {
        const capability = await prepared.openFile()
        await rm(parent)
        await symlink(outside, parent)
        expect((await capability.readFile()).toString()).toBe(
          'authorized-bytes',
        )
        expect((await preparedFileIdentity(prepared)).canonicalPath).toBe(
          await realpath(join(allowed, 'target')),
        )
      } finally {
        await prepared.cleanup()
      }
      await rm(parent)
      await symlink(allowed, parent)
    }
    expect((await readFile(join(outside, 'target'))).toString()).toBe(
      'outside-marker',
    )
  })

  test('preparation-window ancestor swaps never mislabel the opened directory object', async () => {
    const base = await makeTempDir('file-auth-prepare-race-')
    const allowed = join(base, 'allowed')
    const outside = join(base, 'outside')
    const alias = join(base, 'parent-link')
    await mkdir(allowed)
    await mkdir(outside)
    await writeFile(join(allowed, 'target.txt'), 'allowed-object')
    await writeFile(join(outside, 'target.txt'), 'outside-object')
    await symlink(allowed, alias)
    const canonicalAllowed = await realpath(allowed)
    const canonicalOutside = await realpath(outside)

    let swapping = true
    let acquired = 0
    const swapParents = (async () => {
      let outsideNext = true
      while (swapping) {
        await rm(alias, { force: true })
        await symlink(outsideNext ? outside : allowed, alias)
        outsideNext = !outsideNext
        await Promise.resolve()
      }
    })()
    try {
      const preparations = await Promise.all(
        Array.from({ length: 48 }, async () => {
          let prepared: Awaited<ReturnType<typeof prepareFileRead>> | undefined
          let capability: Awaited<
            ReturnType<PreparedFileRead['openFile']>
          > | undefined
          try {
            prepared = await prepareFileRead(join(alias, 'target.txt'))
            capability = await prepared.openFile()
          } catch {
            // A path legitimately disappeared while the symlink entry changed.
            await prepared?.cleanup()
            return
          }
          try {
            const content = (await capability.readFile()).toString()
            acquired++
            expect(prepared.canonicalPath).toBe(capability.path)
            if (prepared.canonicalPath.startsWith(canonicalAllowed)) {
              expect(content).toBe('allowed-object')
            } else if (prepared.canonicalPath.startsWith(canonicalOutside)) {
              expect(content).toBe('outside-object')
            } else {
              throw new Error(`Unexpected opened path ${prepared.canonicalPath}`)
            }
          } finally {
            await prepared.cleanup()
          }
        }),
      )
      expect(preparations).toHaveLength(48)
      expect(acquired).toBeGreaterThan(0)
      const creations = await Promise.all(
        Array.from({ length: 12 }, async (_, index) => {
          const path = join(alias, `nested-${index}`, 'new.txt')
          let prepared: Awaited<
            ReturnType<typeof prepareFileMutationAuthorization>
          >
          try {
            prepared = await prepareFileMutationAuthorization(path)
          } catch {
            return
          }
          try {
            if (!prepared.canonicalPath.startsWith(canonicalAllowed)) return
            const published = await prepared.parent!.publishFileWithIdentity(
              prepared.relativePath,
              Buffer.from(`created-${index}`),
            )
            expect(published).not.toBeNull()
            if (!published) throw new Error('Expected descriptor-relative create')
            expect(published.canonicalPath).toBe(prepared.canonicalPath)
            expect(await readFile(published.canonicalPath, 'utf8')).toBe(
              `created-${index}`,
            )
          } finally {
            await prepared.cleanup()
          }
        }),
      )
      expect(creations).toHaveLength(12)
    } finally {
      swapping = false
      await swapParents
    }
  })

  test('new nested directories publish through the retained parent after symlink swap', async () => {
    const base = await makeTempDir('file-auth-write-')
    const allowed = join(base, 'allowed')
    const outside = join(base, 'outside')
    const alias = join(base, 'parent')
    await mkdir(allowed)
    await mkdir(outside)
    await symlink(allowed, alias)

    const prepared = await prepareFileMutationAuthorization(
      join(alias, 'new', 'nested', 'created.txt'),
    )
    try {
      await rm(alias)
      await symlink(outside, alias)
      expect(
        await prepared.parent.publishFile(
          prepared.relativePath,
          Buffer.from('created-through-capability'),
        ),
      ).toBe(true)
      expect((await stat(join(allowed, 'new', 'nested', 'created.txt'))).mode & 0o777).toBe(
        0o644,
      )
      expect((await stat(join(allowed, 'new'))).mode & 0o777).toBe(0o755)
      expect(
        (
          await readFile(
            join(allowed, 'new', 'nested', 'created.txt'),
            'utf8',
          )
        ).toString(),
      ).toBe('created-through-capability')
      await expect(readFile(join(outside, 'new', 'nested', 'created.txt'))).rejects.toThrow()
    } finally {
      await prepared.cleanup()
    }
  })

  test('a retained parent follows its directory object after namespace relocation', async () => {
    const base = await makeTempDir('file-auth-parent-move-')
    const approvedParent = join(base, 'approved')
    const movedParent = join(base, 'moved-outside-approved-path')
    const replacementParent = join(base, 'replacement')
    await mkdir(approvedParent)
    await mkdir(replacementParent)

    const prepared = await prepareFileMutationAuthorization(
      join(approvedParent, 'nested', 'created.txt'),
    )
    try {
      await rename(approvedParent, movedParent)
      await symlink(replacementParent, approvedParent)
      const publication = await prepared.parent!.publishFileWithIdentity(
        prepared.relativePath,
        Buffer.from('created-in-retained-directory-object'),
      )
      expect(publication).not.toBeNull()
      expect(
        await readFile(join(movedParent, 'nested', 'created.txt'), 'utf8'),
      ).toBe('created-in-retained-directory-object')
      const moved = await stat(join(movedParent, 'nested', 'created.txt'))
      expect(publication).toMatchObject({
        device: moved.dev,
        inode: moved.ino,
      })
      await expect(
        readFile(join(replacementParent, 'nested', 'created.txt')),
      ).rejects.toThrow()
    } finally {
      await prepared.cleanup()
    }
  })

  test('existing file publication preserves mode and rejects a changed snapshot', async () => {
    const base = await makeTempDir('file-auth-existing-')
    const filePath = join(base, 'existing.txt')
    await writeFile(filePath, 'before', { mode: 0o640 })
    const prepared = await prepareFileMutationAuthorization(filePath)
    try {
      expect(prepared.existing).toBeDefined()
      expect(prepared.canonicalPath).toBe(await realpath(filePath))
      expect(prepared.existing!.path).toBe(prepared.canonicalPath)
      expect(prepared.parent!.canonicalRoot).toBe(await realpath(base))
      await writeFile(filePath, 'changed')
      expect(
        await prepared.parent.publishFile(
          prepared.relativePath,
          Buffer.from('after'),
          prepared.existing!.identity,
        ),
      ).toBe(false)
      expect(await readFile(filePath, 'utf8')).toBe('changed')
    } finally {
      await prepared.cleanup()
    }
  })

  test('retains both the requested hard-link route and descriptor path', async () => {
    const base = await makeTempDir('file-auth-hardlink-')
    const first = join(base, 'first.txt')
    const second = join(base, 'second.txt')
    await writeFile(first, 'shared object')
    await link(first, second)
    const prepared = await prepareFileMutationAuthorization(second)
    try {
      expect(prepared.canonicalPath).toBe(await realpath(second))
      expect(prepared.actualPath).toBe(prepared.existing!.path)
      expect(prepared.existing!.identity.inode).toBe((await stat(first)).ino)
    } finally {
      await prepared.cleanup()
    }
  })

  test('replaces an unchanged file atomically and preserves its mode', async () => {
    const base = await makeTempDir('file-auth-mode-')
    const filePath = join(base, 'mode.txt')
    await writeFile(filePath, 'before', { mode: 0o640 })
    const prepared = await prepareFileMutationAuthorization(filePath)
    try {
      expect(
        await prepared.parent.publishFile(
          prepared.relativePath,
          Buffer.from('after'),
          prepared.existing!.identity,
        ),
      ).toBe(true)
      const info = await stat(filePath)
      expect((info.mode & 0o777).toString(8)).toBe('640')
      expect(await readFile(filePath, 'utf8')).toBe('after')
    } finally {
      await prepared.cleanup()
    }
  })

  test('publication returns the authored object identity before path observers run', async () => {
    const base = await makeTempDir('file-auth-publication-id-')
    const filePath = join(base, 'authored.txt')
    const movedPath = join(base, 'authored-object.txt')
    await writeFile(filePath, 'before')
    const prepared = await prepareFileMutationAuthorization(filePath)
    try {
      const identity = await prepared.parent!.publishFileWithIdentity(
        prepared.relativePath,
        Buffer.from('published'),
        prepared.existing!.identity,
      )
      expect(identity).not.toBeNull()
      if (!identity) throw new Error('Expected an authored file identity')
      await (await import('fs/promises')).rename(filePath, movedPath)
      await writeFile(filePath, 'replacement')
      const authored = await stat(movedPath)
      expect(identity).toMatchObject({
        device: authored.dev,
        inode: authored.ino,
      })
      expect(await readFile(filePath, 'utf8')).toBe('replacement')
    } finally {
      await prepared.cleanup()
    }
  })
})
