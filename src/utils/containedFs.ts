import { constants } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { open, readlink, realpath, stat } from 'fs/promises'
import { dirname, isAbsolute, join, parse, relative, sep } from 'path'
import type { Pointer } from 'bun:ffi'

type PosixFfi = {
  symbols: {
    openat: (dirfd: number, path: string, flags: number, mode: number) => number
    close: (fd: number) => number
    fdopendir: (fd: number) => Pointer | null
    readdir: (dir: Pointer) => Pointer | null
    closedir: (dir: Pointer) => number
    readlinkat: (
      dirfd: number,
      path: string,
      buffer: Pointer,
      length: number,
    ) => bigint
    mkdirat: (dirfd: number, path: string, mode: number) => number
    linkat: (
      oldDirfd: number,
      oldPath: string,
      newDirfd: number,
      newPath: string,
      flags: number,
    ) => number
    renameat: (
      oldDirfd: number,
      oldPath: string,
      newDirfd: number,
      newPath: string,
    ) => number
    exchangeat: (
      oldDirfd: number,
      oldPath: string,
      newDirfd: number,
      newPath: string,
    ) => number
    unlinkat: (dirfd: number, path: string, flags: number) => number
    write: (fd: number, buffer: Pointer, length: number) => bigint
    fsync: (fd: number) => number
    fchmod: (fd: number, mode: number) => number
    pread: (
      fd: number,
      buffer: Pointer,
      length: number,
      offset: bigint,
    ) => bigint
  }
  ptr(value: NodeJS.TypedArray): Pointer
  CString(pointer: Pointer, byteOffset: number): string
  close: () => void
}

export type ContainedFile = {
  content: Buffer
  mode: number
}

export type ContainedFs = {
  readonly canonicalRoot: string
  readdir(relativePath?: string): Promise<string[]>
  statDir(relativePath?: string): Promise<Awaited<ReturnType<typeof stat>>>
  lstat(relativePath: string): Promise<ContainedEntryStat>
  readFile(relativePath: string): Promise<ContainedFile>
  openFileCapability(relativePath: string): Promise<ContainedFileCapability>
  openFileCapabilityNoFollow(
    relativePath: string,
  ): Promise<ContainedFileCapability>
  publishFile(
    relativePath: string,
    content: Buffer,
    expected?: ContainedFileCapability['identity'],
    createMode?: number,
    expectedDigest?: string,
  ): Promise<boolean>
  publishFileWithIdentity(
    relativePath: string,
    content: Buffer,
    expected?: ContainedFileCapability['identity'],
    createMode?: number,
    expectedDigest?: string,
  ): Promise<ContainedFileCapability['identity'] & {
    canonicalPath: string
    publicationConflict?: true
  } | null>
  removeFile(
    relativePath: string,
    expected: ContainedFileCapability['identity'],
    expectedDigest?: string,
  ): Promise<boolean>
  close(): Promise<void>
}

export type ContainedFileCapability = {
  readonly path: string
  readonly descriptorPath: string
  readonly identity: {
    device: number
    inode: number
    size: number
    modifiedAtMs: number
    changedAtMs: number
    mode: number
    nativeFileId?: string
  }
  currentIdentity(): Promise<ContainedFileCapability['identity']>
  digest(): Promise<string>
  readFile(): Promise<Buffer>
  copyTo(destinationPath: string): Promise<void>
  close(): Promise<void>
}

export type ContainedFsTestHooks = {
  beforePublishSourceEntryValidation?: (temporaryName: string) => void
  afterPublishSourceEntryValidation?: (temporaryName: string) => void
}

export class ContainedPublicationPartialMutationError extends Error {
  readonly code = 'ERR_CONTAINED_PUBLICATION_PARTIAL_MUTATION'
  readonly recoveryPaths: readonly string[]

  constructor(
    readonly destinationPath: string,
    readonly authoredPath: string | undefined,
    readonly displacedPath: string | undefined,
    readonly displacedExpected: boolean | undefined,
    readonly destinationIdentity:
      | { device: number; inode: number }
      | undefined,
  ) {
    super(
      `The file change could not be completed safely. Target: ${destinationPath}.${authoredPath === undefined ? ' The new content has no verified recovery path.' : ` New content was last observed at: ${authoredPath}.`}${displacedPath === undefined ? '' : ` The previous target was last observed at: ${displacedPath}${displacedExpected ? ' (the expected original).' : '.'}`}`,
    )
    this.name = 'ContainedPublicationPartialMutationError'
    this.recoveryPaths = Object.freeze([
      destinationPath,
      ...(authoredPath === undefined ? [] : [authoredPath]),
      ...(displacedPath === undefined ? [] : [displacedPath]),
    ])
  }
}

export type ContainedEntryStat = {
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
  mode: number
}

const DIRECTORY_FLAGS =
  constants.O_RDONLY |
  (constants.O_DIRECTORY ?? 0) |
  (constants.O_NOFOLLOW ?? 0) |
  (process.platform === 'darwin' ? 0x1000000 : 0x80000)
const FILE_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (process.platform === 'darwin' ? 0x1000000 : 0x80000) |
  (constants.O_NONBLOCK ?? 0)
const MAX_SYMLINKS = 40

async function readHandlePositionally(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<Buffer> {
  const size = (await handle.stat()).size
  const chunks: Buffer[] = []
  let offset = 0
  while (offset < size) {
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, size - offset))
    const result = await handle.read(chunk, 0, chunk.length, offset)
    if (result.bytesRead <= 0) {
      throw new Error('Unable to read prepared filesystem object')
    }
    chunks.push(chunk.subarray(0, result.bytesRead))
    offset += result.bytesRead
  }
  return Buffer.concat(chunks, offset)
}

async function copyHandlePositionally(
  handle: Awaited<ReturnType<typeof open>>,
  destinationPath: string,
  readAt?: (buffer: Buffer, offset: number) => Promise<number>,
): Promise<void> {
  const size = (await handle.stat()).size
  const output = await open(destinationPath, 'w')
  try {
    let offset = 0
    while (offset < size) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, size - offset))
      const count = readAt
        ? await readAt(chunk, offset)
        : (await handle.read(chunk, 0, chunk.length, offset)).bytesRead
      if (count <= 0) throw new Error('Unable to read prepared filesystem object')
      let written = 0
      while (written < count) {
        const result = await output.write(
          chunk,
          written,
          count - written,
          offset + written,
        )
        if (result.bytesWritten <= 0) {
          throw new Error('Unable to write private file snapshot')
        }
        written += result.bytesWritten
      }
      offset += count
    }
    await output.sync()
  } finally {
    await output.close()
  }
}

async function digestHandlePositionally(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<string> {
  const size = (await handle.stat()).size
  const digest = createHash('sha256')
  let offset = 0
  while (offset < size) {
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, size - offset))
    const result = await handle.read(chunk, 0, chunk.length, offset)
    if (result.bytesRead <= 0) {
      throw new Error('Unable to read prepared filesystem object')
    }
    digest.update(chunk.subarray(0, result.bytesRead))
    offset += result.bytesRead
  }
  return digest.digest('hex')
}

async function getPathForDescriptor(fd: number): Promise<string> {
  const path =
    process.platform === 'linux'
      ? await readlink(`/proc/self/fd/${fd}`)
      : await realpath(`/dev/fd/${fd}`)
  if (path.endsWith(' (deleted)')) {
    throw new Error('Contained filesystem object was unlinked while opening')
  }
  return path
}

async function digestPosixDescriptor(
  fd: number,
  size: number,
  ffi: PosixFfi,
): Promise<string> {
  const digest = createHash('sha256')
  let offset = 0
  while (offset < size) {
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, size - offset))
    const count = ffi.symbols.pread(fd, ffi.ptr(chunk), chunk.length, BigInt(offset))
    if (count <= 0n) {
      throw new Error('Unable to read prepared filesystem object')
    }
    const bytesRead = Number(count)
    digest.update(chunk.subarray(0, bytesRead))
    offset += bytesRead
  }
  return digest.digest('hex')
}

/**
 * Opens a filesystem view rooted at one retained directory descriptor.
 * POSIX operations below use openat relative to retained directory handles.
 */
export async function openContainedFs(
  rootPath: string,
  testHooks?: ContainedFsTestHooks,
): Promise<ContainedFs> {
  if (process.platform === 'win32') {
    const windows = await import('./windowsContainedFs.js')
    return windows.openWindowsContainedFs(rootPath)
  }
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('Contained filesystem is unsupported on this platform')
  }
  const requestedCanonicalRoot = await realpath(rootPath)

  const ffi = loadPosixFfi()
  let rootHandle
  let canonicalRoot: string
  try {
    rootHandle = await open(requestedCanonicalRoot, DIRECTORY_FLAGS)
    const rootFd = rootHandle.fd
    canonicalRoot = await getPathForDescriptor(rootFd)
    if (canonicalRoot !== requestedCanonicalRoot) {
      throw new Error('Contained filesystem root changed while opening')
    }
    const rootInfo = await rootHandle.stat({ bigint: true })
    const rootPathInfo = await stat(canonicalRoot, { bigint: true })
    if (
      !rootInfo.isDirectory() ||
      rootInfo.dev !== rootPathInfo.dev ||
      rootInfo.ino !== rootPathInfo.ino
    ) {
      throw new Error('Contained filesystem root changed while opening')
    }
  } catch (error) {
    await rootHandle?.close()
    ffi.close()
    throw error
  }

  const rootFd = rootHandle.fd
  const fdPath = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'
  const pathForFd = (fd: number, name?: string): string =>
    name === undefined
      ? `${fdPath}/${fd}`
      : `${fdPath}/${fd}/${name}`
  const readDirectory = (fd: number): string[] => {
    const copyFd = ffi.symbols.openat(fd, '.', DIRECTORY_FLAGS, 0)
    if (copyFd < 0) throw new Error('Unable to duplicate contained directory')
    const directory = ffi.symbols.fdopendir(copyFd)
    if (!directory) {
      ffi.symbols.close(copyFd)
      throw new Error('Unable to list contained directory')
    }
    try {
      const names: string[] = []
      const nameOffset = process.platform === 'darwin' ? 21 : 19
      while (true) {
        const entry = ffi.symbols.readdir(directory)
        if (!entry) break
        const name = ffi.CString(entry, nameOffset)
        if (name !== '.' && name !== '..') names.push(name)
      }
      return names
    } finally {
      ffi.symbols.closedir(directory)
    }
  }
  const readLinkAt = (fd: number, name: string): string | null => {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    const length = ffi.symbols.readlinkat(
      fd,
      name,
      ffi.ptr(buffer),
      buffer.length,
    )
    if (length < 0n) return null
    if (length >= BigInt(buffer.length)) {
      throw new Error('Contained symlink target is too long')
    }
    return buffer.toString('utf8', 0, Number(length))
  }
  let closed = false

  const assertOpen = (): void => {
    if (closed) throw new Error('Contained filesystem is closed')
  }

  const openDirectory = (parts: string[]): number => {
    assertOpen()
    let fd = rootFd
    let ownsFd = false
    try {
      for (const part of parts) {
        if (!part || part === '.') continue
        if (part === '..') throw new Error('Path escapes contained root')
        const nextFd = ffi.symbols.openat(fd, part, DIRECTORY_FLAGS, 0)
        if (nextFd < 0) throw new Error(`Unable to open contained directory`)
        if (ownsFd) ffi.symbols.close(fd)
        fd = nextFd
        ownsFd = true
      }
      if (!ownsFd) return rootFd
      const result = fd
      ownsFd = false
      return result
    } finally {
      if (ownsFd) ffi.symbols.close(fd)
    }
  }

  const openOrCreateDirectory = (parts: string[]): number => {
    assertOpen()
    let fd = rootFd
    let ownsFd = false
    try {
      for (const part of parts) {
        if (!part || part === '.') continue
        if (part === '..') throw new Error('Path escapes contained root')
        let nextFd = ffi.symbols.openat(fd, part, DIRECTORY_FLAGS, 0)
        if (nextFd < 0) {
          if (ffi.symbols.mkdirat(fd, part, 0o777) < 0) {
            nextFd = ffi.symbols.openat(fd, part, DIRECTORY_FLAGS, 0)
            if (nextFd < 0) {
              throw new Error('Unable to create contained directory')
            }
          } else {
            nextFd = ffi.symbols.openat(fd, part, DIRECTORY_FLAGS, 0)
            if (nextFd < 0) {
              throw new Error('Unable to open created contained directory')
            }
          }
        }
        if (ownsFd) ffi.symbols.close(fd)
        fd = nextFd
        ownsFd = true
      }
      if (!ownsFd) return rootFd
      const result = fd
      ownsFd = false
      return result
    } finally {
      if (ownsFd) ffi.symbols.close(fd)
    }
  }

  const normalizedParts = (raw: string[]): string[] => {
    const result: string[] = []
    for (const part of raw) {
      if (part.includes('\0')) {
        throw new Error('NUL is not allowed in contained filesystem paths')
      }
      if (!part || part === '.') continue
      if (part === '..') {
        if (result.length === 0) throw new Error('Path escapes contained root')
        result.pop()
      } else {
        result.push(part)
      }
    }
    return result
  }

  const resolveLinkTarget = (
    parentParts: string[],
    linkTarget: string,
    remaining: string[],
  ): string[] => {
    let targetParts: string[]
    if (isAbsolute(linkTarget)) {
      const fromRoot = relative(canonicalRoot, linkTarget)
      if (
        fromRoot === '..' ||
        fromRoot.startsWith(`..${sep}`) ||
        isAbsolute(fromRoot)
      ) {
        throw new Error('Symlink target escapes contained root')
      }
      targetParts = fromRoot.split(sep)
    } else {
      targetParts = [...parentParts, ...linkTarget.split('/')]
    }
    return normalizedParts([...targetParts, ...remaining])
  }

  const openFile = async (
    inputPath: string,
  ): Promise<{ fd: number; path: string }> => {
    assertOpen()
    let parts = normalizedParts(inputPath.split('/'))
    if (parts.length === 0) throw new Error('Expected a file path')
    for (let restart = 0; restart <= MAX_SYMLINKS; restart++) {
      let parentFd = rootFd
      let ownsParent = false
      let restartWith: string[] | undefined
      try {
        for (let index = 0; index < parts.length; index++) {
          const name = parts[index]!
          const prefix = parts.slice(0, index)
          const isFinal = index === parts.length - 1
          const linkTarget = readLinkAt(parentFd, name)
          if (linkTarget !== null) {
            restartWith = resolveLinkTarget(
              prefix,
              linkTarget,
              parts.slice(index + 1),
            )
            break
          }
          const nextFd = ffi.symbols.openat(
            parentFd,
            name,
            isFinal ? FILE_FLAGS : DIRECTORY_FLAGS,
            0,
          )
          if (nextFd < 0) throw new Error('Unable to open contained file path')
          if (isFinal) {
            try {
              const canonicalOpenedPath = await getPathForDescriptor(nextFd)
              const relativeOpenedPath = relative(
                canonicalRoot,
                canonicalOpenedPath,
              )
              if (
                relativeOpenedPath === '..' ||
                relativeOpenedPath.startsWith(`..${sep}`) ||
                isAbsolute(relativeOpenedPath)
              ) {
                throw new Error('Contained file descriptor escaped its root')
              }
              const openedPathStat = await stat(pathForFd(nextFd), {
                bigint: true,
              })
              if (
                !openedPathStat.isFile() &&
                !(
                  canonicalOpenedPath === '/dev/null' &&
                  openedPathStat.isCharacterDevice()
                )
              ) {
                throw new Error('Contained path is not a regular file')
              }
              return {
                fd: nextFd,
                path: canonicalOpenedPath,
              }
            } catch (error) {
              ffi.symbols.close(nextFd)
              throw error
            }
          }
          if (ownsParent) ffi.symbols.close(parentFd)
          parentFd = nextFd
          ownsParent = true
        }
      } finally {
        if (ownsParent) ffi.symbols.close(parentFd)
      }
      if (!restartWith) throw new Error('Unable to resolve contained file')
      parts = restartWith
    }
    throw new Error('Too many contained symlinks')
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await rootHandle.close()
    ffi.close()
  }

  return {
    canonicalRoot,
    async readdir(relativePath = '') {
      const parts = normalizedParts(relativePath.split('/'))
      const dirFd = openDirectory(parts)
      try {
        return readDirectory(dirFd)
      } finally {
        if (dirFd !== rootFd) ffi.symbols.close(dirFd)
      }
    },
    async statDir(relativePath = '') {
      const parts = normalizedParts(relativePath.split('/'))
      const dirFd = openDirectory(parts)
      try {
        const handle = await open(pathForFd(dirFd))
        try {
          return await handle.stat({ bigint: true })
        } finally {
          await handle.close()
        }
      } finally {
        if (dirFd !== rootFd) ffi.symbols.close(dirFd)
      }
    },
    async lstat(relativePath) {
      const parts = normalizedParts(relativePath.split('/'))
      const name = parts.pop()
      if (!name) throw new Error('Expected a path within contained root')
      const dirFd = openDirectory(parts)
      try {
        if (readLinkAt(dirFd, name) !== null) {
          return {
            mode: 0o120000,
            isDirectory: () => false,
            isFile: () => false,
            isSymbolicLink: () => true,
          }
        }
        const entryFd = ffi.symbols.openat(dirFd, name, FILE_FLAGS, 0)
        if (entryFd < 0) throw new Error('Unable to stat contained entry')
        try {
          const handle = await open(pathForFd(entryFd))
          let info
          try {
            info = await handle.stat()
          } finally {
            await handle.close()
          }
          return {
            mode: info.mode,
            isDirectory: () => info.isDirectory(),
            isFile: () => info.isFile(),
            isSymbolicLink: () => false,
          }
        } finally {
          ffi.symbols.close(entryFd)
        }
      } finally {
        if (dirFd !== rootFd) ffi.symbols.close(dirFd)
      }
    },
    async readFile(relativePath) {
      const { fd } = await openFile(relativePath)
      let fileHandle
      try {
        fileHandle = await open(pathForFd(fd))
        const info = await fileHandle.stat()
        if (!info.isFile()) throw new Error('Contained path is not a regular file')
        return { content: await fileHandle.readFile(), mode: info.mode }
      } finally {
        await fileHandle?.close()
        ffi.symbols.close(fd)
      }
    },
    async openFileCapability(relativePath) {
      if (process.platform === 'win32') {
        throw new Error(
          'Descriptor-bound file capabilities are unsupported on Windows',
        )
      }
      const opened = await openFile(relativePath)
      let handle
      try {
        handle = await open(pathForFd(opened.fd))
        const info = await handle.stat()
        if (
          !info.isFile() &&
          !(opened.path === '/dev/null' && info.isCharacterDevice())
        ) {
          throw new Error('Contained path is not a regular file')
        }
        let capabilityClosed = false
        return {
          path: opened.path,
          async digest() {
            if (capabilityClosed) {
              throw new Error('Contained file capability is closed')
            }
            return digestHandlePositionally(handle!)
          },
          descriptorPath: pathForFd(opened.fd),
          get identity() {
            return {
              device: info.dev,
              inode: info.ino,
              size: info.size,
              modifiedAtMs: info.mtimeMs,
              changedAtMs: info.ctimeMs,
              mode: info.mode,
            }
          },
          async currentIdentity() {
            if (capabilityClosed) {
              throw new Error('Contained file capability is closed')
            }
            const current = await handle!.stat()
            return {
              device: current.dev,
              inode: current.ino,
              size: current.size,
              modifiedAtMs: current.mtimeMs,
              changedAtMs: current.ctimeMs,
              mode: current.mode,
            }
          },
          async readFile() {
            if (capabilityClosed) {
              throw new Error('Contained file capability is closed')
            }
            const size = (await handle!.stat()).size
            const chunks: Buffer[] = []
            let offset = 0
            while (offset < size) {
              const chunk = Buffer.allocUnsafe(
                Math.min(1024 * 1024, size - offset),
              )
              const count = ffi.symbols.pread(
                opened.fd,
                ffi.ptr(chunk),
                chunk.length,
                BigInt(offset),
              )
              if (count <= 0n) {
                throw new Error('Unable to read prepared filesystem object')
              }
              const bytesRead = Number(count)
              chunks.push(chunk.subarray(0, bytesRead))
              offset += bytesRead
            }
            return Buffer.concat(chunks, offset)
          },
          async copyTo(destinationPath) {
            if (capabilityClosed) {
              throw new Error('Contained file capability is closed')
            }
            await copyHandlePositionally(
              handle!,
              destinationPath,
              async (chunk, offset) => {
                const count = ffi.symbols.pread(
                  opened.fd,
                  ffi.ptr(chunk),
                  chunk.length,
                  BigInt(offset),
                )
                return Number(count)
              },
            )
          },
          async close() {
            if (capabilityClosed) return
            capabilityClosed = true
            await handle!.close()
            ffi.symbols.close(opened.fd)
          },
        }
      } catch (error) {
        await handle?.close()
        ffi.symbols.close(opened.fd)
        throw error
      }
    },
    async openFileCapabilityNoFollow(relativePath) {
      const parts = normalizedParts(relativePath.split('/'))
      const name = parts.pop()
      if (!name) throw new Error('Expected a file path within contained root')
      const parentFd = openDirectory(parts)
      let fd = -1
      try {
        fd = ffi.symbols.openat(parentFd, name, FILE_FLAGS, 0)
        if (fd < 0) throw new Error('Unable to open contained file path')
        const handle = await open(pathForFd(fd))
        try {
          const info = await handle.stat()
          if (!info.isFile()) {
            throw new Error('Contained path is not a regular file')
          }
          const canonicalPath = await getPathForDescriptor(fd)
          const relativePath = relative(canonicalRoot, canonicalPath)
          if (
            relativePath === '..' ||
            relativePath.startsWith(`..${sep}`) ||
            isAbsolute(relativePath)
          ) {
            throw new Error('Contained file descriptor escaped its root')
          }
          let capabilityClosed = false
          return {
            path: canonicalPath,
            async digest() {
              if (capabilityClosed) {
                throw new Error('Contained file capability is closed')
              }
              return digestHandlePositionally(handle)
            },
            descriptorPath: pathForFd(fd),
            get identity() {
              return {
                device: info.dev,
                inode: info.ino,
                size: info.size,
                modifiedAtMs: info.mtimeMs,
                changedAtMs: info.ctimeMs,
                mode: info.mode,
              }
            },
            async currentIdentity() {
              if (capabilityClosed) {
                throw new Error('Contained file capability is closed')
              }
              const current = await handle.stat()
              return {
                device: current.dev,
                inode: current.ino,
                size: current.size,
                modifiedAtMs: current.mtimeMs,
                changedAtMs: current.ctimeMs,
                mode: current.mode,
              }
            },
            async readFile() {
              if (capabilityClosed) {
                throw new Error('Contained file capability is closed')
              }
              const size = (await handle.stat()).size
              const chunks: Buffer[] = []
              let offset = 0
              while (offset < size) {
                const chunk = Buffer.allocUnsafe(
                  Math.min(1024 * 1024, size - offset),
                )
                const count = ffi.symbols.pread(
                  fd!,
                  ffi.ptr(chunk),
                  chunk.length,
                  BigInt(offset),
                )
                if (count <= 0n) {
                  throw new Error('Unable to read prepared filesystem object')
                }
                const bytesRead = Number(count)
                chunks.push(chunk.subarray(0, bytesRead))
                offset += bytesRead
              }
              return Buffer.concat(chunks, offset)
            },
            async copyTo(destinationPath) {
              if (capabilityClosed) {
                throw new Error('Contained file capability is closed')
              }
              await copyHandlePositionally(
                handle,
                destinationPath,
                async (chunk, offset) =>
                  Number(
                    ffi.symbols.pread(
                      fd!,
                      ffi.ptr(chunk),
                      chunk.length,
                      BigInt(offset),
                    ),
                  ),
              )
            },
            async close() {
              if (capabilityClosed) return
              capabilityClosed = true
              await handle.close()
              ffi.symbols.close(fd!)
            },
          }
        } catch (error) {
          await handle.close()
          throw error
        }
      } catch (error) {
        if (fd >= 0) ffi.symbols.close(fd)
        throw error
      } finally {
        if (parentFd !== rootFd) ffi.symbols.close(parentFd)
      }
    },
    async publishFile(relativePath, content, expected, createMode, expectedDigest) {
      return (
        (await this.publishFileWithIdentity(
          relativePath,
          content,
          expected,
          createMode,
          expectedDigest,
        )) !== null
      )
    },
    async publishFileWithIdentity(
      relativePath,
      content,
      expected,
      createMode,
      expectedDigest,
    ) {
      if (process.platform === 'win32') {
        throw new Error(
          'Descriptor-relative file publication is unsupported on Windows',
        )
      }
      const parts = normalizedParts(relativePath.split('/'))
      const name = parts.pop()
      if (!name) throw new Error('Expected a file path within contained root')
      const parentFd = openOrCreateDirectory(parts)
      const canonicalTargetPath = `${canonicalRoot.replace(/\/$/, '')}/${parts
        .concat(name)
        .join('/')}`
      const temporaryName = `.${name}.tmp.${process.pid}.${randomBytes(12).toString('hex')}`
      let tempFd = -1
      let exchangeDone = false
      let tempIdentityHandle: Awaited<ReturnType<typeof open>> | undefined
      let temporaryIdentity: { device: number; inode: number } | undefined
      const entryMatches = async (
        entryName: string,
        identity: { device: number; inode: number },
      ): Promise<boolean> => {
        const entryFd = ffi.symbols.openat(
          parentFd,
          entryName,
          FILE_FLAGS | (constants.O_NOFOLLOW ?? 0),
          0,
        )
        if (entryFd < 0) return false
        try {
          const entry = await open(pathForFd(entryFd))
          try {
            const current = await entry.stat()
            return current.dev === identity.device && current.ino === identity.inode
          } finally {
            await entry.close()
          }
        } finally {
          ffi.symbols.close(entryFd)
        }
      }
      const authoredIdentity = async (
        publicationConflict = false,
      ): Promise<ContainedFileCapability['identity'] & {
        canonicalPath: string
        publicationConflict?: true
      }> => {
        const published = await tempIdentityHandle!.stat()
        const canonicalPath = await getPathForDescriptor(
          tempIdentityHandle!.fd,
        ).catch(() => canonicalTargetPath)
        return {
          canonicalPath,
          device: published.dev,
          inode: published.ino,
          size: published.size,
          modifiedAtMs: published.mtimeMs,
          changedAtMs: published.ctimeMs,
          mode: published.mode,
          ...(publicationConflict ? { publicationConflict: true as const } : {}),
        }
      }
      const describeEntry = async (
        entryName: string,
      ): Promise<{
        path: string
        device: number
        inode: number
      } | null> => {
        const entryFd = ffi.symbols.openat(
          parentFd,
          entryName,
          FILE_FLAGS | (constants.O_NOFOLLOW ?? 0),
          0,
        )
        if (entryFd < 0) return null
        try {
          const entry = await open(pathForFd(entryFd))
          try {
            const info = await entry.stat()
            return {
              path: await getPathForDescriptor(entryFd).catch(() => undefined),
              device: info.dev,
              inode: info.ino,
            }
          } finally {
            await entry.close()
          }
        } finally {
          ffi.symbols.close(entryFd)
        }
      }
      const partialMutationError = async (): Promise<ContainedPublicationPartialMutationError> => {
        const [destination, displaced] = await Promise.all([
          describeEntry(name),
          expected === undefined ? Promise.resolve(null) : describeEntry(temporaryName),
        ])
        let authoredPath = await getPathForDescriptor(
          tempIdentityHandle!.fd,
        ).catch(() => undefined)
        if (authoredPath !== undefined) {
          const observed = await stat(authoredPath).catch(() => undefined)
          if (
            observed?.dev !== temporaryIdentity!.device ||
            observed?.ino !== temporaryIdentity!.inode
          ) {
            authoredPath = undefined
          }
        }
        const displacedExpected =
          displaced === null
            ? undefined
            : displaced.device === expected!.device &&
              displaced.inode === expected!.inode
        return new ContainedPublicationPartialMutationError(
          destination?.path ?? canonicalTargetPath,
          authoredPath,
          displaced?.path,
          displacedExpected,
          destination === null
            ? undefined
            : { device: destination.device, inode: destination.inode },
        )
      }
      try {
        const existingFd = ffi.symbols.openat(parentFd, name, FILE_FLAGS, 0)
        if (expected === undefined) {
          if (existingFd >= 0) {
            ffi.symbols.close(existingFd)
            return null
          }
        } else {
          if (existingFd < 0) return null
          try {
            const existingHandle = await open(pathForFd(existingFd))
            try {
              const current = await existingHandle.stat()
              if (
                current.dev !== expected.device ||
                current.ino !== expected.inode ||
                current.size !== expected.size ||
                current.mtimeMs !== expected.modifiedAtMs ||
                current.ctimeMs !== expected.changedAtMs
              ) {
                return null
              }
            } finally {
              await existingHandle.close()
            }
          } finally {
            ffi.symbols.close(existingFd)
          }
        }

        tempFd = ffi.symbols.openat(
          parentFd,
          temporaryName,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            (constants.O_NOFOLLOW ?? 0) |
            (process.platform === 'darwin' ? 0x1000000 : 0x80000),
          expected?.mode ?? createMode ?? 0o666,
        )
        if (tempFd < 0) throw new Error('Unable to create contained temp file')
        let written = 0
        while (written < content.length) {
          const chunk = content.subarray(written)
          const count = ffi.symbols.write(tempFd, ffi.ptr(chunk), chunk.length)
          if (count <= 0n) throw new Error('Unable to write contained temp file')
          written += Number(count)
        }
        if (ffi.symbols.fsync(tempFd) < 0) {
          throw new Error('Unable to sync contained temp file')
        }
        if (
          ffi.symbols.fchmod(
            tempFd,
            expected === undefined
              ? (createMode ?? 0o666) & ~process.umask()
              : expected.mode,
          ) < 0
        ) {
          throw new Error('Unable to preserve contained file mode')
        }
        // Observe the object we authored, not its replaceable directory entry.
        tempIdentityHandle = await open(pathForFd(tempFd))
        const tempInfo = await tempIdentityHandle.stat()
        temporaryIdentity = { device: tempInfo.dev, inode: tempInfo.ino }

        if (expected === undefined) {
          testHooks?.beforePublishSourceEntryValidation?.(temporaryName)
          if (!(await entryMatches(temporaryName, temporaryIdentity))) {
            return null
          }
          testHooks?.afterPublishSourceEntryValidation?.(temporaryName)
          if (
            ffi.symbols.linkat(parentFd, temporaryName, parentFd, name, 0) < 0
          ) {
            return null
          }
          if (!(await entryMatches(name, temporaryIdentity))) {
            throw await partialMutationError()
          }
          if (ffi.symbols.unlinkat(parentFd, temporaryName, 0) < 0) {
            throw new Error('Unable to remove contained temporary file')
          }
          return await authoredIdentity()
        }
        testHooks?.beforePublishSourceEntryValidation?.(temporaryName)
        if (!(await entryMatches(temporaryName, temporaryIdentity))) return null
        testHooks?.afterPublishSourceEntryValidation?.(temporaryName)
        if (
          ffi.symbols.exchangeat(parentFd, temporaryName, parentFd, name) < 0
        ) {
          throw new Error('Unable to exchange contained file')
        }
        exchangeDone = true
        if (!(await entryMatches(name, temporaryIdentity))) {
          throw await partialMutationError()
        }
        const displacedFd = ffi.symbols.openat(
          parentFd,
          temporaryName,
          FILE_FLAGS,
          0,
        )
        if (displacedFd < 0) {
          const publishedFd = ffi.symbols.openat(parentFd, name, FILE_FLAGS, 0)
          if (publishedFd >= 0) {
            try {
              const publishedHandle = await open(pathForFd(publishedFd))
              try {
                const current = await publishedHandle.stat()
                if (
                  current.dev === temporaryIdentity.device &&
                  current.ino === temporaryIdentity.inode
                ) {
                  return await authoredIdentity(true)
                }
              } finally {
                await publishedHandle.close()
              }
            } finally {
              ffi.symbols.close(publishedFd)
            }
          }
          throw new Error('Unable to verify displaced contained file')
        }
        try {
          const displaced = await open(pathForFd(displacedFd))
          try {
            const current = await displaced.stat()
            let contentMismatch = false
            if (expectedDigest !== undefined) {
              try {
                contentMismatch =
                  (await digestPosixDescriptor(
                    displacedFd,
                    current.size,
                    ffi,
                  )) !== expectedDigest
              } catch {
                contentMismatch = true
              }
            }
            if (
              current.dev !== expected!.device ||
              current.ino !== expected!.inode ||
              current.size !== expected!.size ||
              current.mtimeMs !== expected!.modifiedAtMs ||
              contentMismatch
            ) {
              let rolledBack = false
              const publishedFd = ffi.symbols.openat(
                parentFd,
                name,
                FILE_FLAGS,
                0,
              )
              if (publishedFd >= 0) {
                try {
                  const published = await open(pathForFd(publishedFd))
                  try {
                    const publishedInfo = await published.stat()
                    if (
                      publishedInfo.dev === temporaryIdentity.device &&
                      publishedInfo.ino === temporaryIdentity.inode &&
                      ffi.symbols.exchangeat(
                        parentFd,
                        temporaryName,
                        parentFd,
                        name,
                      ) === 0
                    ) {
                      exchangeDone = false
                      rolledBack = true
                    }
                  } finally {
                    await published.close()
                  }
                } finally {
                  ffi.symbols.close(publishedFd)
                }
              }
              if (!rolledBack) return await authoredIdentity(true)
              throw new Error('Contained file changed before publication')
            }
          } finally {
            await displaced.close()
          }
        } finally {
          ffi.symbols.close(displacedFd)
        }
        if (ffi.symbols.unlinkat(parentFd, temporaryName, 0) < 0) {
          throw new Error('Unable to remove displaced contained file')
        }
        return await authoredIdentity()
      } finally {
        if (tempFd >= 0) ffi.symbols.close(tempFd)
        await tempIdentityHandle?.close()
        if (
          !exchangeDone &&
          temporaryIdentity &&
          (await entryMatches(temporaryName, temporaryIdentity))
        ) {
          ffi.symbols.unlinkat(parentFd, temporaryName, 0)
        }
        if (parentFd !== rootFd) ffi.symbols.close(parentFd)
      }
    },
    async removeFile(relativePath, expected, expectedDigest) {
      if (process.platform === 'win32') {
        throw new Error(
          'Descriptor-relative file removal is unsupported on Windows',
        )
      }
      const parts = normalizedParts(relativePath.split('/'))
      const name = parts.pop()
      if (!name) throw new Error('Expected a file path within contained root')
      const parentFd = openDirectory(parts)
      const quarantineName = `.${name}.delete.${process.pid}.${randomBytes(12).toString('hex')}`
      try {
        const fd = ffi.symbols.openat(parentFd, name, FILE_FLAGS, 0)
        if (fd < 0) return false
        try {
          const handle = await open(pathForFd(fd))
          try {
            const current = await handle.stat()
            if (
              current.dev !== expected.device ||
              current.ino !== expected.inode ||
              current.size !== expected.size ||
              current.mtimeMs !== expected.modifiedAtMs ||
              current.ctimeMs !== expected.changedAtMs
            ) {
              return false
            }
          } finally {
            await handle.close()
          }
        } finally {
          ffi.symbols.close(fd)
        }
        if (
          ffi.symbols.renameat(
            parentFd,
            name,
            parentFd,
            quarantineName,
          ) < 0
        ) {
          return false
        }
        let shouldRestore = false
        try {
          const movedFd = ffi.symbols.openat(
            parentFd,
            quarantineName,
            FILE_FLAGS,
            0,
          )
          if (movedFd < 0) {
            shouldRestore = true
            return false
          }
          try {
            const movedHandle = await open(pathForFd(movedFd))
            try {
              const moved = await movedHandle.stat()
              let contentMismatch = false
              if (expectedDigest !== undefined) {
                try {
                  contentMismatch =
                    (await digestPosixDescriptor(
                      movedFd,
                      moved.size,
                      ffi,
                    )) !== expectedDigest
                } catch {
                  contentMismatch = true
                }
              }
              if (
                moved.dev !== expected.device ||
                moved.ino !== expected.inode ||
                moved.size !== expected.size ||
                moved.mtimeMs !== expected.modifiedAtMs ||
                contentMismatch
              ) {
                shouldRestore = true
                return false
              }
            } finally {
              await movedHandle.close()
            }
          } finally {
            ffi.symbols.close(movedFd)
          }
          return ffi.symbols.unlinkat(parentFd, quarantineName, 0) === 0
        } finally {
          if (shouldRestore) {
            if (ffi.symbols.linkat(parentFd, quarantineName, parentFd, name, 0) === 0) {
              ffi.symbols.unlinkat(parentFd, quarantineName, 0)
            }
          }
        }
      } finally {
        if (parentFd !== rootFd) ffi.symbols.close(parentFd)
      }
    },
    close,
  }
}

function loadPosixFfi(): PosixFfi {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffi = require('bun:ffi') as typeof import('bun:ffi')
  const library =
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6'
  const exchangeName = process.platform === 'darwin' ? 'renameatx_np' : 'renameat2'
  const loaded = ffi.dlopen(library, {
    openat: { args: ['i32', 'cstring', 'i32', 'i32'], returns: 'i32' },
    close: { args: ['i32'], returns: 'i32' },
    fdopendir: { args: ['i32'], returns: 'ptr' },
    readdir: { args: ['ptr'], returns: 'ptr' },
    closedir: { args: ['ptr'], returns: 'i32' },
    readlinkat: {
      args: ['i32', 'cstring', 'ptr', 'usize'],
      returns: 'i64',
    },
    mkdirat: { args: ['i32', 'cstring', 'i32'], returns: 'i32' },
    linkat: {
      args: ['i32', 'cstring', 'i32', 'cstring', 'i32'],
      returns: 'i32',
    },
    renameat: {
      args: ['i32', 'cstring', 'i32', 'cstring'],
      returns: 'i32',
    },
    [exchangeName]: {
      args: ['i32', 'cstring', 'i32', 'cstring', 'u32'],
      returns: 'i32',
    },
    unlinkat: { args: ['i32', 'cstring', 'i32'], returns: 'i32' },
    write: { args: ['i32', 'ptr', 'usize'], returns: 'i64' },
    fsync: { args: ['i32'], returns: 'i32' },
    fchmod: { args: ['i32', 'i32'], returns: 'i32' },
    pread: { args: ['i32', 'ptr', 'usize', 'i64'], returns: 'i64' },
  } as const)
  const loadedSymbols = loaded.symbols as unknown as Record<
    string,
    (...args: number[] | [number, string, number, string]) => number
  >
  return {
    symbols: {
      ...loaded.symbols,
      exchangeat: (oldDirfd, oldPath, newDirfd, newPath) =>
        loadedSymbols[exchangeName](
          oldDirfd,
          oldPath,
          newDirfd,
          newPath,
          2,
        ),
    } as unknown as PosixFfi['symbols'],
    ptr: ffi.ptr,
    CString: ffi.CString,
    close: loaded.close,
  }
}

function isPortableENOENT(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

function openPortableContainedFs(
  rootPath: string,
  canonicalRoot: string,
): Promise<ContainedFs> {
  return (async () => {
    const { lstat, readFile, readdir, realpath, stat } = await import(
      'fs/promises'
    )
    const withinRoot = (path: string): boolean => {
      const rel = relative(canonicalRoot, path)
      return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    }
    return {
      canonicalRoot,
      async readdir(relativePath = '') {
        const fullPath = relativePath
          ? `${rootPath}${sep}${relativePath}`
          : rootPath
        const resolved = await realpath(fullPath)
        if (!withinRoot(resolved)) throw new Error('Path escapes contained root')
        return readdir(resolved)
      },
      async statDir(relativePath = '') {
        const fullPath = relativePath
          ? `${rootPath}${sep}${relativePath}`
          : rootPath
        const resolved = await realpath(fullPath)
        if (!withinRoot(resolved)) throw new Error('Path escapes contained root')
        return stat(resolved, { bigint: true })
      },
      async lstat(relativePath) {
        const fullPath = `${rootPath}${sep}${relativePath}`
        const resolved = await realpath(fullPath)
        if (!withinRoot(resolved)) {
          return lstat(fullPath)
        }
        return lstat(fullPath)
      },
      async readFile(relativePath) {
        const fullPath = `${rootPath}${sep}${relativePath}`
        const resolved = await realpath(fullPath)
        if (!withinRoot(resolved)) throw new Error('Path escapes contained root')
        const info = await stat(resolved)
        return { content: await readFile(resolved), mode: info.mode }
      },
      async openFileCapability(relativePath) {
        const fullPath = join(rootPath, relativePath)
        const resolved = await realpath(fullPath)
        if (!withinRoot(resolved)) throw new Error('Path escapes contained root')
        const handle = await open(resolved, 'r')
        const opened = await handle.stat()
        const now = await stat(resolved)
        if (
          !opened.isFile() ||
          opened.dev !== now.dev ||
          opened.ino !== now.ino
        ) {
          await handle.close()
          throw new Error('Contained file changed while opening')
        }
        let capabilityClosed = false
        const identity = () => ({
          device: opened.dev,
          inode: opened.ino,
          size: opened.size,
          modifiedAtMs: opened.mtimeMs,
          changedAtMs: opened.ctimeMs,
          mode: opened.mode,
        })
        return {
          path: resolved,
          async digest() {
            if (capabilityClosed) throw new Error('Contained file capability is closed')
            return digestHandlePositionally(handle)
          },
          descriptorPath: resolved,
          get identity() {
            return identity()
          },
          async currentIdentity() {
            if (capabilityClosed) throw new Error('Contained file capability is closed')
            const current = await handle.stat()
            return {
              device: current.dev,
              inode: current.ino,
              size: current.size,
              modifiedAtMs: current.mtimeMs,
              changedAtMs: current.ctimeMs,
              mode: current.mode,
            }
          },
          async readFile() {
            if (capabilityClosed) throw new Error('Contained file capability is closed')
            return readHandlePositionally(handle)
          },
          async copyTo(destinationPath) {
            if (capabilityClosed) throw new Error('Contained file capability is closed')
            await copyHandlePositionally(handle, destinationPath)
          },
          async close() {
            if (capabilityClosed) return
            capabilityClosed = true
            await handle.close()
          },
        }
      },
      async openFileCapabilityNoFollow(relativePath) {
        const fullPath = join(rootPath, relativePath)
        const entry = await lstat(fullPath)
        if (entry.isSymbolicLink()) {
          throw new Error('Contained file path cannot be a symbolic link')
        }
        const resolved = await realpath(fullPath)
        if (!withinRoot(resolved)) throw new Error('Path escapes contained root')
        const handle = await open(resolved, 'r')
        const opened = await handle.stat()
        let capabilityClosed = false
        const identity = () => ({
          device: opened.dev,
          inode: opened.ino,
          size: opened.size,
          modifiedAtMs: opened.mtimeMs,
          changedAtMs: opened.ctimeMs,
          mode: opened.mode,
        })
        return {
          path: resolved,
          async digest() {
            if (capabilityClosed) throw new Error('Contained file capability is closed')
            return digestHandlePositionally(handle)
          },
          descriptorPath: resolved,
          get identity() {
            return identity()
          },
          async currentIdentity() {
            if (capabilityClosed) throw new Error('Contained file capability is closed')
            const current = await handle.stat()
            return {
              device: current.dev,
              inode: current.ino,
              size: current.size,
              modifiedAtMs: current.mtimeMs,
              changedAtMs: current.ctimeMs,
              mode: current.mode,
            }
          },
          async readFile() {
            if (capabilityClosed) throw new Error('Contained file capability is closed')
            return readHandlePositionally(handle)
          },
          async copyTo(destinationPath) {
            if (capabilityClosed) throw new Error('Contained file capability is closed')
            await copyHandlePositionally(handle, destinationPath)
          },
          async close() {
            if (capabilityClosed) return
            capabilityClosed = true
            await handle.close()
          },
        }
      },
      async publishFile(relativePath, content, expected, createMode, expectedDigest) {
        return (
          (await this.publishFileWithIdentity(
            relativePath,
            content,
            expected,
            createMode,
            expectedDigest,
          )) !== null
        )
      },
      async publishFileWithIdentity(relativePath, content, expected, createMode, expectedDigest) {
        const targetPath = join(rootPath, relativePath)
        const parentPath = dirname(targetPath)
        await (await import('fs/promises')).mkdir(parentPath, { recursive: true })
        const resolvedParent = await realpath(parentPath)
        if (!withinRoot(resolvedParent)) {
          throw new Error('Path escapes contained root')
        }
        const boundTargetPath = join(resolvedParent, parse(targetPath).base)
        const tempPath = join(
          resolvedParent,
          `.${parse(targetPath).base}.tmp.${process.pid}.${randomBytes(12).toString('hex')}`,
        )
        let tempHandle: Awaited<ReturnType<typeof open>> | undefined
        try {
          if (expected !== undefined) {
            const current = await stat(boundTargetPath).catch(() => undefined)
            if (
              !current ||
              current.dev !== expected.device ||
              current.ino !== expected.inode ||
              current.size !== expected.size ||
              current.mtimeMs !== expected.modifiedAtMs ||
              current.ctimeMs !== expected.changedAtMs
            ) {
              return null
            }
          } else {
            try {
              await lstat(boundTargetPath)
              return null
            } catch (error) {
              if (!isPortableENOENT(error)) throw error
            }
          }
          tempHandle = await open(
            tempPath,
            'wx',
            createMode ?? expected?.mode ?? 0o666,
          )
          await tempHandle.writeFile(content)
          await tempHandle.sync()
          if (expected !== undefined) await tempHandle.chmod(expected.mode)
          if (expected === undefined) {
            const { link, unlink } = await import('fs/promises')
            await link(tempPath, boundTargetPath)
            await unlink(tempPath)
          } else {
            const { rename } = await import('fs/promises')
            await rename(tempPath, boundTargetPath)
          }
          const published = await tempHandle.stat()
          return {
            canonicalPath: boundTargetPath,
            device: published.dev,
            inode: published.ino,
            size: published.size,
            modifiedAtMs: published.mtimeMs,
            changedAtMs: published.ctimeMs,
            mode: published.mode,
          }
        } finally {
          await tempHandle?.close()
          const { unlink } = await import('fs/promises')
          await unlink(tempPath).catch(() => {})
        }
      },
      async removeFile(relativePath, expected, expectedDigest) {
        const fullPath = join(rootPath, relativePath)
        const resolved = await realpath(fullPath)
        if (!withinRoot(resolved)) throw new Error('Path escapes contained root')
        const current = await stat(resolved).catch(() => undefined)
        if (
          !current ||
          current.dev !== expected.device ||
          current.ino !== expected.inode ||
          current.size !== expected.size ||
          current.mtimeMs !== expected.modifiedAtMs ||
          current.ctimeMs !== expected.changedAtMs
        ) {
          return false
        }
        await (await import('fs/promises')).unlink(resolved)
        return true
      },
      async close() {},
    }
  })()
}
