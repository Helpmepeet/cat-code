import { renameSync, unlinkSync, writeFileSync } from 'fs'
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  ContainedPublicationPartialMutationError,
  openContainedFs,
} from './containedFs.js'

const tempDirs: string[] = []
const posixOnly = process.platform === 'win32' ? test.skip : test

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

describe('openContainedFs', () => {
  test('reports the retained directory identity and remains bound after its alias swaps', async () => {
    const allowed = await makeTempDir('contained-fs-allowed-')
    const outside = await makeTempDir('contained-fs-outside-')
    const alias = join(allowed, 'parent-link')
    await writeFile(join(allowed, 'data.txt'), 'allowed-data')
    await writeFile(join(outside, 'data.txt'), 'outside-marker')
    await symlink(allowed, alias)

    const contained = await openContainedFs(alias)
    try {
      expect(contained.canonicalRoot).toBe(await realpath(allowed))
      await rm(alias)
      await symlink(outside, alias)
      expect((await contained.readFile('data.txt')).content.toString()).toBe(
        'allowed-data',
      )
      expect((await readFile(join(outside, 'data.txt'), 'utf8')).toString()).toBe(
        'outside-marker',
      )
    } finally {
      await contained.close()
    }
  })

  test('reads regular files and safe internal links relative to the opened root', async () => {
    const root = await makeTempDir('contained-fs-root-')
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'data.txt'), 'root-data')
    await symlink('nested/data.txt', join(root, 'alias.txt'))
    const contained = await openContainedFs(root)

    try {
      expect(await contained.readdir('nested')).toContain('data.txt')
      expect(await contained.readdir('nested')).toContain('data.txt')
      expect((await contained.readFile('nested/data.txt')).content.toString()).toBe(
        'root-data',
      )
      expect((await contained.readFile('alias.txt')).content.toString()).toBe(
        'root-data',
      )
    } finally {
      await contained.close()
    }
  })

  test('keeps concurrent nested reads independent of directory descriptor ownership', async () => {
    const root = await makeTempDir('contained-fs-concurrent-')
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'data.txt'), 'stable-data')
    const contained = await openContainedFs(root)

    try {
      const results = await Promise.all(
        Array.from({ length: 64 }, () => contained.readFile('nested/data.txt')),
      )
      expect(results).toHaveLength(64)
      expect(results.every(result => result.content.toString() === 'stable-data')).toBe(
        true,
      )
    } finally {
      await contained.close()
    }
  })

  test('captures publication identity before closing its retained descriptor', async () => {
    const root = await makeTempDir('contained-fs-publication-')
    const original = join(root, 'original')
    const moved = join(root, 'moved')
    await mkdir(original)
    const contained = await openContainedFs(original)
    try {
      await rename(original, moved)
      const published = await contained.publishFileWithIdentity(
        'created.txt',
        Buffer.from('authored-content'),
      )
      expect(published).not.toBeNull()
      expect(published?.canonicalPath).toBe(await realpath(join(moved, 'created.txt')))
      expect(await readFile(join(moved, 'created.txt'), 'utf8')).toBe('authored-content')
    } finally {
      await contained.close()
    }
  })

  posixOnly(
    'rejects substituted source entries before and after validation without deleting rival bytes',
    async () => {
      for (const stage of ['before', 'after'] as const) {
        const root = await makeTempDir(`contained-fs-source-swap-${stage}-`)
        let substitutedName = ''
        const substitute = (temporaryName: string) => {
          substitutedName = temporaryName
          const temporaryPath = join(root, temporaryName)
          renameSync(temporaryPath, `${temporaryPath}.authored`)
          writeFileSync(temporaryPath, 'rival-bytes')
        }
        const contained = await openContainedFs(root, {
          ...(stage === 'before'
            ? { beforePublishSourceEntryValidation: substitute }
            : { afterPublishSourceEntryValidation: substitute }),
        })

        try {
          const publication = contained.publishFileWithIdentity(
            'target.txt',
            Buffer.from('authored-bytes'),
          )
          if (stage === 'before') {
            expect(await publication).toBeNull()
          } else {
            await expect(publication).rejects.toMatchObject({
              code: 'ERR_CONTAINED_PUBLICATION_PARTIAL_MUTATION',
              displacedPath: undefined,
            })
          }
          const targetPath = join(root, 'target.txt')
          if (stage === 'before') {
            await expect(readFile(targetPath)).rejects.toThrow()
          } else {
            expect(await readFile(targetPath, 'utf8')).toBe('rival-bytes')
          }
          expect(await readFile(join(root, substitutedName), 'utf8')).toBe(
            'rival-bytes',
          )
          expect(
            await readFile(join(root, `${substitutedName}.authored`), 'utf8'),
          ).toBe('authored-bytes')
        } finally {
          await contained.close()
        }
      }
    },
  )

  posixOnly(
    'reports partial replacement and recovery objects when the temp entry is substituted',
    async () => {
      const root = await makeTempDir('contained-fs-replace-source-swap-')
      await writeFile(join(root, 'target.txt'), 'original-bytes')
      let substitutedName = ''
      const contained = await openContainedFs(root, {
        afterPublishSourceEntryValidation(temporaryName) {
          substitutedName = temporaryName
          const temporaryPath = join(root, temporaryName)
          renameSync(temporaryPath, `${temporaryPath}.authored`)
          writeFileSync(temporaryPath, 'rival-bytes')
        },
      })
      const original = await contained.openFileCapability('target.txt')
      const expected = original.identity
      const expectedDigest = await original.digest()
      await original.close()

      try {
        let failure: unknown
        try {
          await contained.publishFileWithIdentity(
            'target.txt',
            Buffer.from('authored-bytes'),
            expected,
            undefined,
            expectedDigest,
          )
        } catch (error) {
          failure = error
        }

        expect(failure).toBeInstanceOf(ContainedPublicationPartialMutationError)
        const partial = failure as ContainedPublicationPartialMutationError
        expect(partial.code).toBe('ERR_CONTAINED_PUBLICATION_PARTIAL_MUTATION')
        expect(partial.displacedExpected).toBe(true)
        expect(partial.recoveryPaths).toContain(partial.destinationPath)
        expect(partial.recoveryPaths).toContain(partial.authoredPath)
        expect(partial.recoveryPaths).toContain(partial.displacedPath)
        expect(await readFile(partial.destinationPath, 'utf8')).toBe('rival-bytes')
        expect(await readFile(partial.authoredPath, 'utf8')).toBe('authored-bytes')
        expect(await readFile(partial.displacedPath!, 'utf8')).toBe(
          'original-bytes',
        )
      } finally {
        await contained.close()
      }
    },
  )

  posixOnly('does not invent a recovery path for an unlinked authored object', async () => {
    const root = await makeTempDir('contained-fs-unlinked-source-')
    await writeFile(join(root, 'target.txt'), 'original-bytes')
    let temporaryPath = ''
    const contained = await openContainedFs(root, {
      afterPublishSourceEntryValidation(temporaryName) {
        temporaryPath = join(root, temporaryName)
        unlinkSync(temporaryPath)
        writeFileSync(temporaryPath, 'rival-bytes')
      },
    })
    const original = await contained.openFileCapability('target.txt')
    const expected = original.identity
    await original.close()
    try {
      await expect(
        contained.publishFileWithIdentity(
          'target.txt',
          Buffer.from('authored-bytes'),
          expected,
        ),
      ).rejects.toMatchObject({
        code: 'ERR_CONTAINED_PUBLICATION_PARTIAL_MUTATION',
        authoredPath: undefined,
        displacedExpected: true,
      })
      expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('rival-bytes')
      expect(await readFile(temporaryPath, 'utf8')).toBe('original-bytes')
    } finally {
      await contained.close()
    }
  })

  test('rejects a file symlink whose target is outside the retained root', async () => {
    const root = await makeTempDir('contained-fs-root-')
    const outside = await makeTempDir('contained-fs-outside-')
    await writeFile(join(outside, 'secret.txt'), 'outside-secret')
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'))
    const contained = await openContainedFs(root)

    try {
      await expect(contained.readFile('escape.txt')).rejects.toThrow()
    } finally {
      await contained.close()
    }
  })
})
