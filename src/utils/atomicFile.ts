import { randomUUID } from 'crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { link, mkdir, open, readFile, rename, unlink } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { lock } from './lockfile.js'

export type AtomicWriteOptions = {
  encoding?: BufferEncoding
  mode?: number
  /**
   * Directory for the temporary file. It must be on the same filesystem as
   * the destination because publication uses rename().
   */
  tempDirectory?: string
}

export async function acquireFileMutationLock(
  targetPath: string,
): Promise<() => Promise<void>> {
  await mkdir(dirname(targetPath), { recursive: true })
  return lock(targetPath, {
    realpath: false,
    retries: {
      // A real extraction can hold this lock for several model turns. Keep
      // waiting asynchronously instead of treating that normal span as a
      // failed mutation.
      retries: 120,
      factor: 1.2,
      minTimeout: 50,
      maxTimeout: 1_000,
      randomize: true,
    },
    stale: 120_000,
    update: 30_000,
  })
}

function tempPathFor(
  filePath: string,
  tempDirectory = dirname(filePath),
): string {
  return join(
    tempDirectory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  )
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch {
    // Directory fsync is unavailable on some supported filesystems.
  } finally {
    await handle?.close().catch(() => {})
  }
}

function syncDirectoryBestEffortSync(directory: string): void {
  let descriptor: number | undefined
  try {
    descriptor = openSync(directory, 'r')
    fsyncSync(descriptor)
  } catch {
    // Directory fsync is unavailable on some supported filesystems.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

export async function writeFileAtomicDurable(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const tempDirectory = options.tempDirectory ?? dirname(filePath)
  await mkdir(tempDirectory, { recursive: true })
  const tempPath = tempPathFor(filePath, tempDirectory)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tempPath, 'wx', options.mode ?? 0o600)
    await handle.writeFile(content, {
      encoding: options.encoding,
    })
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tempPath, filePath)
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(tempPath).catch(() => {})
    throw error
  }
  await syncDirectoryBestEffort(dirname(filePath))
}

export async function writeFileAtomicDurableIfAbsent(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<boolean> {
  const tempDirectory = options.tempDirectory ?? dirname(filePath)
  await mkdir(tempDirectory, { recursive: true })
  const tempPath = tempPathFor(filePath, tempDirectory)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tempPath, 'wx', options.mode ?? 0o600)
    await handle.writeFile(content, {
      encoding: options.encoding,
    })
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await link(tempPath, filePath)
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        return false
      }
      throw error
    }
    await syncDirectoryBestEffort(dirname(filePath))
    return true
  } finally {
    await handle?.close().catch(() => {})
    await unlink(tempPath).catch(() => {})
  }
}

/**
 * Publish content only if the destination still matches expectedContent.
 *
 * This is not a general filesystem compare-and-swap: the comparison and
 * rename are separate filesystem operations. Callers that share writers must
 * hold their mutation lock across the snapshot and this publication.
 */
export async function writeFileAtomicDurableIfContentMatches(
  filePath: string,
  expectedContent: string | null,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<'written' | 'conflict'> {
  const tempDirectory = options.tempDirectory ?? dirname(filePath)
  await mkdir(tempDirectory, { recursive: true })
  const tempPath = tempPathFor(filePath, tempDirectory)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tempPath, 'wx', options.mode ?? 0o600)
    await handle.writeFile(content, { encoding: options.encoding })
    await handle.sync()
    await handle.close()
    handle = undefined

    // This is a compare-then-rename operation, not a general filesystem CAS.
    // Callers must hold the shared mutation lock when they need to serialize
    // against other engine writers. The comparison still preserves a local
    // edit observed before publication by returning a conflict.
    let currentContent: string | null
    try {
      currentContent = await readFile(filePath, 'utf8')
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        currentContent = null
      } else {
        throw error
      }
    }
    if (currentContent !== expectedContent) return 'conflict'

    await rename(tempPath, filePath)
    await syncDirectoryBestEffort(dirname(filePath))
    return 'written'
  } finally {
    await handle?.close().catch(() => {})
    await unlink(tempPath).catch(() => {})
  }
}

export function writeFileAtomicDurableSync(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  const tempDirectory = options.tempDirectory ?? dirname(filePath)
  mkdirSync(tempDirectory, { recursive: true })
  const tempPath = tempPathFor(filePath, tempDirectory)
  let descriptor: number | undefined
  try {
    descriptor = openSync(tempPath, 'wx', options.mode ?? 0o600)
    writeFileSync(descriptor, content, {
      encoding: options.encoding,
    })
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(tempPath, filePath)
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {}
    }
    try {
      unlinkSync(tempPath)
    } catch {}
    throw error
  }
  syncDirectoryBestEffortSync(dirname(filePath))
}
