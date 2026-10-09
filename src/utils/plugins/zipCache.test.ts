import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'
import { parseZipModes, unzipFile } from '../dxt/zip.js'
import { createZipFromDirectory } from './zipCache.js'

let tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function archiveFiles(sourceDir: string): Promise<{
  files: Record<string, Uint8Array>
  modes: Record<string, number>
}> {
  const zip = await createZipFromDirectory(sourceDir)
  return {
    files: await unzipFile(Buffer.from(zip)),
    modes: parseZipModes(zip),
  }
}

describe('createZipFromDirectory', () => {
  test('excludes file symlinks whose resolved targets are outside the source tree', async () => {
    const source = await makeTempDir('zip-source-')
    const outside = await makeTempDir('zip-outside-')
    await writeFile(join(outside, 'secret.txt'), 'host-secret')
    await symlink(join(outside, 'secret.txt'), join(source, 'plugin-secret.txt'))

    const { files } = await archiveFiles(source)

    expect(files['plugin-secret.txt']).toBeUndefined()
    expect(
      Buffer.concat(Object.values(files).map(value => Buffer.from(value))).toString(),
    ).not.toContain('host-secret')
  })

  test('preserves an internal file symlink as regular file content', async () => {
    const source = await makeTempDir('zip-internal-link-')
    await mkdir(join(source, 'nested'))
    await writeFile(join(source, 'nested', 'data.txt'), 'plugin-data')
    await symlink('nested/data.txt', join(source, 'linked-data.txt'))

    const { files } = await archiveFiles(source)

    expect(Buffer.from(files['linked-data.txt']).toString()).toBe('plugin-data')
  })

  test('rejects a file link retargeted to an outside file before packaging', async () => {
    const source = await makeTempDir('zip-link-swap-')
    const outside = await makeTempDir('zip-link-swap-outside-')
    await writeFile(join(source, 'inside.txt'), 'inside')
    await writeFile(join(outside, 'secret.txt'), 'swapped-secret')
    const link = join(source, 'entry.txt')
    await symlink('inside.txt', link)
    await rm(link)
    await symlink(join(outside, 'secret.txt'), link)

    const { files } = await archiveFiles(source)

    expect(files['entry.txt']).toBeUndefined()
    expect(
      Buffer.concat(Object.values(files).map(value => Buffer.from(value))).toString(),
    ).not.toContain('swapped-secret')
  })

  test('does not import outside bytes while a file link is repeatedly retargeted', async () => {
    const source = await makeTempDir('zip-link-race-')
    const outside = await makeTempDir('zip-link-race-outside-')
    await writeFile(join(source, 'inside.txt'), 'inside')
    await writeFile(join(outside, 'secret.txt'), 'raced-secret')
    const link = join(source, 'entry.txt')
    const internalTarget = join(source, 'inside.txt')
    const externalTarget = join(outside, 'secret.txt')
    await symlink(internalTarget, link)

    const attacker = (async () => {
      for (let i = 0; i < 100; i++) {
        await unlink(link).catch(() => {})
        await symlink(i % 2 ? internalTarget : externalTarget, link).catch(
          () => {},
        )
      }
    })()
    const { files } = await archiveFiles(source)
    await attacker

    expect(Buffer.from(files['inside.txt']).toString()).toBe('inside')
    expect(
      Buffer.concat(Object.values(files).map(value => Buffer.from(value))).toString(),
    ).not.toContain('raced-secret')
  })

  test('does not traverse an ancestor replaced with an outside directory link', async () => {
    const source = await makeTempDir('zip-ancestor-swap-')
    const outside = await makeTempDir('zip-ancestor-outside-')
    await mkdir(join(source, 'nested'))
    await writeFile(join(source, 'nested', 'ordinary.txt'), 'ordinary')
    await writeFile(join(outside, 'secret.txt'), 'ancestor-secret')
    await rm(join(source, 'nested'), { recursive: true })
    await symlink(outside, join(source, 'nested'), 'dir')

    const { files } = await archiveFiles(source)

    expect(files['nested/secret.txt']).toBeUndefined()
    expect(
      Buffer.concat(Object.values(files).map(value => Buffer.from(value))).toString(),
    ).not.toContain('ancestor-secret')
  })

  test('does not import outside bytes during repeated concurrent ancestor swaps', async () => {
    const source = await makeTempDir('zip-ancestor-race-')
    const outside = await makeTempDir('zip-ancestor-race-outside-')
    const nested = join(source, 'nested')
    const parked = join(source, 'parked')
    await writeFile(join(source, 'root.txt'), 'root-content')
    await mkdir(nested)
    await writeFile(join(nested, 'inside.txt'), 'inside')
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        writeFile(join(nested, `file-${index}.txt`), `content-${index}`),
      ),
    )
    await writeFile(join(outside, 'secret.txt'), 'raced-ancestor-secret')

    const attacker = (async () => {
      for (let i = 0; i < 100; i++) {
        await rm(parked, { recursive: true, force: true })
        await rename(nested, parked).catch(() => {})
        await symlink(outside, nested, 'dir').catch(() => {})
        await rm(nested, { recursive: true, force: true })
        await rename(parked, nested).catch(() => {})
      }
    })()
    const { files } = await archiveFiles(source)
    await attacker

    expect(Buffer.from(files['root.txt']).toString()).toBe('root-content')
    expect(
      Buffer.concat(Object.values(files).map(value => Buffer.from(value))).toString(),
    ).not.toContain('raced-ancestor-secret')
  })

  test('round-trips nested ordinary files and executable modes, ignoring broken links', async () => {
    const source = await makeTempDir('zip-roundtrip-')
    await mkdir(join(source, 'nested'))
    await writeFile(join(source, 'nested', 'plain.txt'), 'plain')
    await writeFile(join(source, 'nested', 'run.sh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(source, 'nested', 'run.sh'), 0o755)
    await symlink('missing-target', join(source, 'broken-link'))

    const { files, modes } = await archiveFiles(source)

    expect(Buffer.from(files['nested/plain.txt']).toString()).toBe('plain')
    expect(Buffer.from(files['nested/run.sh']).toString()).toBe('#!/bin/sh\nexit 0\n')
    expect(modes['nested/run.sh']! & 0o111).toBe(0o111)
    expect(files['broken-link']).toBeUndefined()
    expect((await lstat(join(source, 'broken-link'))).isSymbolicLink()).toBe(true)
  })
})
