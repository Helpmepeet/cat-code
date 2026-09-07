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
import { basename, dirname, join, normalize } from 'path'
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
  const unlock = await lock(targetPath, {
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
  let released = false
  return async () => {
    if (released) return
    released = true
    try {
      await unlock()
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ERELEASED'
      ) {
        throw error
      }
    }
  }
}

/**
 * Acquire the same per-path locks used by individual file mutation tools.
 *
 * Lexical ordering prevents two multi-file mutations from deadlocking while
 * they wait on the same set of cooperative locks. This protects cooperating
 * writers only; it does not make unrelated filesystem writers transactional.
 */
export async function acquireFileMutationLocks(
  targetPaths: readonly string[],
): Promise<() => Promise<void>> {
  const paths = [...new Set(targetPaths.map(path => normalize(path)))].sort()
  const releases: Array<() => Promise<void>> = []

  try {
    for (const path of paths) {
      releases.push(await acquireFileMutationLock(path))
    }
  } catch (error) {
    for (const release of releases.reverse()) {
      await release().catch(() => {})
    }
    throw error
  }

  let released = false
  return async () => {
    if (released) return
    released = true
    let firstError: unknown
    for (const release of releases.reverse()) {
      try {
        await release()
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError !== undefined) throw firstError
  }
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

/**
 * Write `content` to a fresh temp file beside (or in `options.tempDirectory`
 * next to) the destination and fsync it, returning the staged path for the
 * caller to publish.
 *
 * Every durable writer below shares this half: the data must be on disk before
 * the name is published, or a crash between the two leaves the destination
 * pointing at a partial file. On failure nothing is left behind, so a caller
 * that never reaches publication has nothing to clean up.
 */
async function stageTempFile(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions,
): Promise<string> {
  const tempDirectory = options.tempDirectory ?? dirname(filePath)
  await mkdir(tempDirectory, { recursive: true })
  const tempPath = tempPathFor(filePath, tempDirectory)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tempPath, 'wx', options.mode ?? 0o600)
    await handle.writeFile(content, { encoding: options.encoding })
    await handle.sync()
    await handle.close()
    return tempPath
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(tempPath).catch(() => {})
    throw error
  }
}

export async function writeFileAtomicDurable(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const tempPath = await stageTempFile(filePath, content, options)
  try {
    await rename(tempPath, filePath)
  } catch (error) {
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
  const tempPath = await stageTempFile(filePath, content, options)
  try {
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
    // link() leaves the temp under a second name, so it always needs removing.
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
  const tempPath = await stageTempFile(filePath, content, options)
  try {
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
    // A no-op after a successful rename; removes the staged file on conflict.
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
