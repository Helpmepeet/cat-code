import { createHash, randomBytes } from 'crypto'
import { open } from 'fs/promises'
import { win32 } from 'path'
import type { Pointer } from 'bun:ffi'
import type { FileIdentity } from './file.js'
import type {
  ContainedEntryStat,
  ContainedFileCapability,
  ContainedFs,
} from './containedFs.js'

type WinHandle = number

export type WindowsNativeApi = {
  symbols: {
    createFileW: (
      path: Pointer,
      access: number,
      share: number,
      security: Pointer | null,
      creation: number,
      flags: number,
      template: number,
    ) => number
    getFinalPathNameByHandleW: (
      handle: number,
      path: Pointer,
      length: number,
      flags: number,
    ) => number
    closeHandle: (handle: number) => number
    getFileInformationByHandle: (handle: number, info: Pointer) => number
    getFileInformationByHandleEx: (
      handle: number,
      infoClass: number,
      info: Pointer,
      length: number,
    ) => number
    setFileInformationByHandle: (
      handle: number,
      infoClass: number,
      info: Pointer,
      length: number,
    ) => number
    getSecurityInfo: (
      handle: number,
      objectType: number,
      securityInfo: number,
      owner: Pointer | null,
      group: Pointer | null,
      dacl: Pointer | null,
      sacl: Pointer | null,
      descriptor: Pointer,
    ) => number
    setSecurityInfo: (
      handle: number,
      objectType: number,
      securityInfo: number,
      owner: number,
      group: number,
      dacl: number,
      sacl: number,
    ) => number
    localFree: (memory: number) => number
    ntCreateFile: (
      handle: Pointer,
      access: number,
      attributes: Pointer,
      status: Pointer,
      allocationSize: Pointer | null,
      fileAttributes: number,
      share: number,
      disposition: number,
      options: number,
      eaBuffer: Pointer | null,
      eaLength: number,
    ) => number
    ntClose: (handle: number) => number
    ntReadFile: (
      handle: number,
      event: number,
      apcRoutine: number,
      apcContext: number,
      status: Pointer,
      buffer: Pointer,
      length: number,
      offset: Pointer,
      key: Pointer | null,
    ) => number
    ntWriteFile: (
      handle: number,
      event: number,
      apcRoutine: number,
      apcContext: number,
      status: Pointer,
      buffer: Pointer,
      length: number,
      offset: Pointer,
      key: Pointer | null,
    ) => number
    ntFlushBuffersFile: (handle: number, status: Pointer) => number
    ntSetInformationFile: (
      handle: number,
      status: Pointer,
      info: Pointer,
      length: number,
      infoClass: number,
    ) => number
    ntQueryDirectoryFile: (
      handle: number,
      event: number,
      apcRoutine: number,
      apcContext: number,
      status: Pointer,
      info: Pointer,
      length: number,
      infoClass: number,
      returnSingleEntry: number,
      fileName: Pointer | null,
      restartScan: number,
    ) => number
  }
  ptr(value: NodeJS.TypedArray): Pointer
  close(): void
}

export const WINDOWS_NATIVE_ABI = {
  kernel32: {
    CreateFileW: {
      args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'],
      returns: 'u64',
    },
    GetFinalPathNameByHandleW: {
      args: ['u64', 'ptr', 'u32', 'u32'],
      returns: 'u32',
    },
    CloseHandle: { args: ['u64'], returns: 'i32' },
    GetFileInformationByHandle: { args: ['u64', 'ptr'], returns: 'i32' },
    GetFileInformationByHandleEx: {
      args: ['u64', 'i32', 'ptr', 'u32'],
      returns: 'i32',
    },
    SetFileInformationByHandle: {
      args: ['u64', 'i32', 'ptr', 'u32'],
      returns: 'i32',
    },
    LocalFree: { args: ['u64'], returns: 'u64' },
  },
  ntdll: {
    NtCreateFile: {
      args: ['ptr', 'u32', 'ptr', 'ptr', 'ptr', 'u32', 'u32', 'u32', 'u32', 'ptr', 'u32'],
      returns: 'i32',
    },
    NtClose: { args: ['u64'], returns: 'i32' },
    NtReadFile: {
      args: ['u64', 'u64', 'u64', 'u64', 'ptr', 'ptr', 'u32', 'ptr', 'ptr'],
      returns: 'i32',
    },
    NtWriteFile: {
      args: ['u64', 'u64', 'u64', 'u64', 'ptr', 'ptr', 'u32', 'ptr', 'ptr'],
      returns: 'i32',
    },
    NtFlushBuffersFile: { args: ['u64', 'ptr'], returns: 'i32' },
    NtSetInformationFile: {
      args: ['u64', 'ptr', 'ptr', 'u32', 'u32'],
      returns: 'i32',
    },
    NtQueryDirectoryFile: {
      args: ['u64', 'u64', 'u64', 'u64', 'ptr', 'ptr', 'u32', 'u32', 'u8', 'ptr', 'u8'],
      returns: 'i32',
    },
  },
  advapi32: {
    GetSecurityInfo: {
      args: ['u64', 'u32', 'u32', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'],
      returns: 'u32',
    },
    SetSecurityInfo: {
      args: ['u64', 'u32', 'u32', 'u64', 'u64', 'u64', 'u64'],
      returns: 'u32',
    },
  },
} as const

type WindowsFileInfo = {
  device: number
  inode: number
  exactInode: bigint
  size: number
  modifiedAtMs: number
  changedAtMs: number
  mode: number
  attributes: number
  nativeFileId: string
}

const INVALID_HANDLE = 0xffff_ffff_ffff_ffffn
const FILE_SHARE_ALL = 0x1 | 0x2 | 0x4
const FILE_LIST_DIRECTORY = 0x1
const FILE_READ_DATA = 0x1
const FILE_WRITE_DATA = 0x2
const FILE_READ_ATTRIBUTES = 0x80
const FILE_WRITE_ATTRIBUTES = 0x100
const DELETE_ACCESS = 0x0001_0000
const FILE_TRAVERSE = 0x20
const SYNCHRONIZE = 0x0010_0000
const FILE_ATTRIBUTE_DIRECTORY = 0x10
const FILE_ATTRIBUTE_NORMAL = 0x80
const FILE_ATTRIBUTE_READONLY = 0x1
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400
const READ_CONTROL = 0x0002_0000
const WRITE_DAC = 0x0004_0000
const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000
const FILE_OPEN = 1
const FILE_CREATE = 2
const FILE_DIRECTORY_FILE = 0x1
const FILE_NON_DIRECTORY_FILE = 0x40
const FILE_SYNCHRONOUS_IO_NONALERT = 0x20
const FILE_OPEN_REPARSE_POINT = 0x0020_0000
const OBJ_CASE_INSENSITIVE = 0x40
const IO_FILE_RENAME_INFORMATION_EX_CLASS = 65
const FILE_RENAME_REPLACE_IF_EXISTS = 0x1
const FILE_RENAME_POSIX_SEMANTICS = 0x2
const IO_FILE_DISPOSITION_INFORMATION_CLASS = 13
const IO_FILE_NAMES_INFORMATION_CLASS = 12
const STATUS_NO_MORE_FILES = 0x8000_0006
const STATUS_BUFFER_OVERFLOW = 0x8000_0005
const STATUS_BUFFER_TOO_SMALL = 0xc000_0023

function toHandle(value: number): WinHandle {
  if (value === Number(INVALID_HANDLE) || value === 0) {
    throw new Error('Unable to acquire Windows filesystem handle')
  }
  return value
}

function wideString(value: string): Buffer {
  return Buffer.from(`${value}\0`, 'utf16le')
}

function pointerNumber(pointer: Pointer): bigint {
  return BigInt(pointer as unknown as number)
}

export function buildWindowsUnicodeString(
  textBufferPointer: bigint,
  byteLength: number,
): Buffer {
  const value = Buffer.alloc(16)
  value.writeUInt16LE(byteLength, 0)
  value.writeUInt16LE(byteLength + 2, 2)
  value.writeBigUInt64LE(textBufferPointer, 8)
  return value
}

export function buildWindowsObjectAttributes(
  rootHandle: bigint,
  unicodeStringPointer: bigint,
): Buffer {
  const value = Buffer.alloc(48)
  value.writeUInt32LE(48, 0)
  value.writeBigUInt64LE(rootHandle, 8)
  value.writeBigUInt64LE(unicodeStringPointer, 16)
  value.writeUInt32LE(OBJ_CASE_INSENSITIVE, 24)
  return value
}

export function buildWindowsRenameInformation(
  rootHandle: bigint,
  name: string,
  replaceExisting: boolean,
): Buffer {
  const nameBytes = Buffer.from(name, 'utf16le')
  const value = Buffer.alloc(20 + nameBytes.length)
  value.writeUInt32LE(
    (replaceExisting ? FILE_RENAME_REPLACE_IF_EXISTS : 0) |
      (replaceExisting ? FILE_RENAME_POSIX_SEMANTICS : 0),
    0,
  )
  value.writeBigUInt64LE(rootHandle, 8)
  value.writeUInt32LE(nameBytes.length, 16)
  nameBytes.copy(value, 20)
  return value
}

export async function openWindowsContainedFs(
  requestedRoot: string,
): Promise<ContainedFs> {
  if (process.platform !== 'win32') {
    throw new Error('Windows contained filesystem is only available on Windows')
  }
  return openWindowsContainedFsWithApi(requestedRoot, loadWindowsNativeApi())
}

export async function openWindowsContainedFsWithNativeApiForTest(
  requestedRoot: string,
  api: WindowsNativeApi,
): Promise<ContainedFs> {
  return openWindowsContainedFsWithApi(requestedRoot, api)
}

async function openWindowsContainedFsWithApi(
  requestedRoot: string,
  api: WindowsNativeApi,
): Promise<ContainedFs> {
  let rootHandle: WinHandle
  try {
    rootHandle = createWindowsRootHandle(api, requestedRoot)
  } catch (error) {
    api.close()
    throw error
  }
  let canonicalRoot: string
  try {
    canonicalRoot = finalPathForHandle(api, rootHandle)
    const rootInfo = getWindowsFileInfo(api, rootHandle)
    if ((rootInfo.attributes & FILE_ATTRIBUTE_DIRECTORY) === 0) {
      throw new Error('Contained filesystem root is not a directory')
    }
  } catch (error) {
    api.symbols.closeHandle(rootHandle)
    api.close()
    throw error
  }

  let closed = false
  const assertOpen = () => {
    if (closed) throw new Error('Contained filesystem is closed')
  }
  const resolveSegments = (path: string): string[] => {
    if (path.includes('\0')) throw new Error('NUL is not allowed in contained paths')
    const result: string[] = []
    for (const segment of path.replaceAll('/', '\\').split('\\')) {
      if (!segment || segment === '.') continue
      if (segment === '..') {
        if (result.length === 0) {
          throw new Error('Path escapes contained root')
        }
        result.pop()
      } else {
        result.push(segment)
      }
    }
    return result
  }
  const withinRoot = (candidate: string): boolean => {
    const root = normalizeWindowsPath(canonicalRoot).replace(/\\$/, '')
    const path = normalizeWindowsPath(candidate)
    return (
      path.toLowerCase() === root.toLowerCase() ||
      path.toLowerCase().startsWith(`${root.toLowerCase()}\\`)
    )
  }
  const assertContainedHandle = (handle: WinHandle): string => {
    const resolved = finalPathForHandle(api, handle)
    if (!withinRoot(resolved)) {
      throw new Error('Windows filesystem handle escapes the contained root')
    }
    return resolved
  }
  const openRelative = (
    root: WinHandle,
    relativePath: string,
    options: {
      directory?: boolean
      create?: boolean
      noFollow?: boolean
      write?: boolean
      delete?: boolean
      security?: boolean
      anyType?: boolean
    } = {},
  ): WinHandle => {
    assertOpen()
    const nameBuffer = wideString(relativePath)
    const nameLength = nameBuffer.length - 2
    const unicode = buildWindowsUnicodeString(
      pointerNumber(api.ptr(nameBuffer)),
      nameLength,
    )
    const attributes = buildWindowsObjectAttributes(
      BigInt(root),
      pointerNumber(api.ptr(unicode)),
    )
    const ioStatus = Buffer.alloc(16)
    const outHandle = Buffer.alloc(8)
    const optionsMask =
      FILE_SYNCHRONOUS_IO_NONALERT |
      (options.anyType
        ? 0
        : options.directory
          ? FILE_DIRECTORY_FILE
          : FILE_NON_DIRECTORY_FILE) |
      (options.noFollow ? FILE_OPEN_REPARSE_POINT : 0)
    const status = api.symbols.ntCreateFile(
      api.ptr(outHandle),
      (options.directory ? FILE_LIST_DIRECTORY : FILE_READ_DATA) |
        (options.directory ? FILE_TRAVERSE : 0) |
        FILE_READ_ATTRIBUTES |
        (options.write || options.security ? READ_CONTROL : 0) |
        SYNCHRONIZE |
        (options.write ? FILE_WRITE_DATA | DELETE_ACCESS | WRITE_DAC : 0) |
        (options.write ? FILE_WRITE_ATTRIBUTES : 0) |
        (options.delete ? DELETE_ACCESS : 0),
      api.ptr(attributes),
      api.ptr(ioStatus),
      null,
      options.directory ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_ALL,
      options.create ? FILE_CREATE : FILE_OPEN,
      optionsMask,
      null,
      0,
    )
    if (status < 0) throw windowsStatusError(status)
    return toHandle(Number(outHandle.readBigUInt64LE(0)))
  }

  const openDirectory = (relativePath = ''): WinHandle => {
    let current = rootHandle
    let ownsCurrent = false
    try {
      for (const segment of resolveSegments(relativePath)) {
        const next = openRelative(current, segment, { directory: true })
        try {
          assertContainedHandle(next)
        } catch (error) {
          api.symbols.ntClose(next)
          throw error
        }
        if (ownsCurrent) api.symbols.ntClose(current)
        current = next
        ownsCurrent = true
      }
      if (!ownsCurrent) return rootHandle
      const result = current
      ownsCurrent = false
      return result
    } finally {
      if (ownsCurrent) api.symbols.ntClose(current)
    }
  }

  const openFile = (
    relativePath: string,
    noFollow = false,
  ): { handle: WinHandle; path: string } => {
    const segments = resolveSegments(relativePath)
    const name = segments.pop()
    if (!name) throw new Error('Expected a file path within contained root')
    const parent = openDirectory(segments.join('\\'))
    const ownsParent = parent !== rootHandle
    try {
      const handle = openRelative(parent, name, { noFollow })
      try {
        const path = assertContainedHandle(handle)
        const info = getWindowsFileInfo(api, handle)
        if (
          (info.attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0 ||
          (noFollow && (info.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0)
        ) {
          throw new Error('Contained path is not a regular file')
        }
        return { handle, path }
      } catch (error) {
        api.symbols.ntClose(handle)
        throw error
      }
    } finally {
      if (ownsParent) api.symbols.ntClose(parent)
    }
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    api.symbols.closeHandle(rootHandle)
    api.close()
  }

  return {
    canonicalRoot,
    async readdir(relativePath = '') {
      const directory = openDirectory(relativePath)
      try {
        return queryDirectory(api, directory)
      } finally {
        if (directory !== rootHandle) api.symbols.ntClose(directory)
      }
    },
    async statDir(relativePath = '') {
      const directory = openDirectory(relativePath)
      try {
        return windowsStats(getWindowsFileInfo(api, directory), true) as Awaited<
          ReturnType<ContainedFs['statDir']>
        >
      } finally {
        if (directory !== rootHandle) api.symbols.ntClose(directory)
      }
    },
    async lstat(relativePath) {
      const segments = resolveSegments(relativePath)
      const name = segments.pop()
      if (!name) throw new Error('Expected a path within contained root')
      const parent = openDirectory(segments.join('\\'))
      try {
        const handle = openRelative(parent, name, {
          anyType: true,
          noFollow: true,
        })
        try {
          const info = getWindowsFileInfo(api, handle)
          const isLink = (info.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0
          const isDir = (info.attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0
          const mode = windowsMode(info, isDir)
          return {
            mode,
            isDirectory: () => isDir,
            isFile: () => !isDir && !isLink,
            isSymbolicLink: () => isLink,
          } satisfies ContainedEntryStat
        } finally {
          api.symbols.ntClose(handle)
        }
      } finally {
        if (parent !== rootHandle) api.symbols.ntClose(parent)
      }
    },
    async readFile(relativePath) {
      const capability = await this.openFileCapability(relativePath)
      try {
        return {
          content: await capability.readFile(),
          mode: capability.identity.mode,
        }
      } finally {
        await capability.close()
      }
    },
    async openFileCapability(relativePath) {
      const opened = openFile(relativePath)
      return createWindowsCapability(api, opened.handle, opened.path)
    },
    async openFileCapabilityNoFollow(relativePath) {
      const opened = openFile(relativePath, true)
      return createWindowsCapability(api, opened.handle, opened.path)
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
      const segments = resolveSegments(relativePath)
      const name = segments.pop()
      if (!name) throw new Error('Expected a destination within contained root')
      const parent = await openOrCreateWindowsDirectory(
        api,
        rootHandle,
        canonicalRoot,
        segments,
        withinRoot,
        assertContainedHandle,
        openRelative,
      )
      const ownsParent = parent !== rootHandle
      const temporaryName = `.cat-code-${randomBytes(16).toString('hex')}.tmp`
      let tempHandle: WinHandle | undefined
      let expectedHandle: WinHandle | undefined
      let preRenameHandle: WinHandle | undefined
      let renamed = false
      try {
        if (expected !== undefined) {
          try {
            expectedHandle = openRelative(parent, name, {
              noFollow: true,
              delete: true,
              security: true,
            })
          } catch {
            return null
          }
          if (!fileInfoMatches(getWindowsFileInfo(api, expectedHandle), expected)) {
            return null
          }
          if (
            expectedDigest !== undefined &&
            (await digestWindowsHandle(api, expectedHandle)) !== expectedDigest
          ) {
            return null
          }
        } else {
          try {
            const existing = openRelative(parent, name, { noFollow: true })
            api.symbols.ntClose(existing)
            return null
          } catch (error) {
            if (!isWindowsNotFound(error)) throw error
          }
        }

        tempHandle = openRelative(parent, temporaryName, {
          create: true,
          write: true,
          noFollow: true,
        })
        await writeWindowsHandle(api, tempHandle, content)
        if (expected !== undefined) {
          copyWindowsFileSecurity(api, expectedHandle!, tempHandle)
          setWindowsFileMode(api, tempHandle, expected.mode)
          if ((await getWindowsFileInfo(api, tempHandle)).attributes & FILE_ATTRIBUTE_READONLY) {
            throw new Error('Unable to preserve Windows file attributes')
          }
        } else if (createMode !== undefined && (createMode & 0o222) === 0) {
          setWindowsFileMode(api, tempHandle, 0o444)
        }
        flushWindowsHandle(api, tempHandle)

        if (expected !== undefined) {
          try {
            preRenameHandle = openRelative(parent, name, { noFollow: true })
          } catch {
            return null
          }
          if (!fileInfoMatches(getWindowsFileInfo(api, preRenameHandle), expected)) {
            return null
          }
          if (
            expectedDigest !== undefined &&
            (await digestWindowsHandle(api, preRenameHandle)) !== expectedDigest
          ) {
            return null
          }
        }
        renameWindowsHandle(api, tempHandle, parent, name, expected !== undefined)
        renamed = true
        let publicationConflict = false
        if (preRenameHandle && expected) {
          const preRenameInfo = getWindowsFileInfo(api, preRenameHandle)
          publicationConflict =
            !fileInfoMatches(preRenameInfo, expected) ||
            (expectedDigest !== undefined &&
              (await digestWindowsHandle(api, preRenameHandle)) !== expectedDigest)
        }
        if (expectedHandle && expected) {
          const currentOldInfo = getWindowsFileInfo(api, expectedHandle)
          publicationConflict =
            publicationConflict ||
            !fileInfoMatches(currentOldInfo, expected) ||
            (expectedDigest !== undefined &&
              (await digestWindowsHandle(api, expectedHandle)) !== expectedDigest)
          if (publicationConflict) {
            let targetStillAuthored = false
            try {
              const currentTarget = openRelative(parent, name, { noFollow: true })
              try {
                const targetInfo = getWindowsFileInfo(api, currentTarget)
                const authoredInfo = getWindowsFileInfo(api, tempHandle)
                targetStillAuthored =
                  targetInfo.device === authoredInfo.device &&
                  targetInfo.inode === authoredInfo.inode
              } finally {
                api.symbols.ntClose(currentTarget)
              }
            } catch {
              targetStillAuthored = false
            }
            if (targetStillAuthored) {
              try {
                renameWindowsHandle(api, expectedHandle, parent, name, true)
                renamed = false
                return null
              } catch {
                publicationConflict = true
              }
            }
          }
        }
        const info = getWindowsFileInfo(api, tempHandle)
        return {
          canonicalPath: finalPathForHandle(api, tempHandle),
          device: info.device,
          inode: info.inode,
          size: info.size,
          modifiedAtMs: info.modifiedAtMs,
          changedAtMs: info.changedAtMs,
          mode: info.mode,
          nativeFileId: info.nativeFileId,
          ...(publicationConflict ? { publicationConflict: true as const } : {}),
        }
      } finally {
        try {
          if (tempHandle !== undefined && !renamed) {
            markWindowsHandleForDelete(api, tempHandle)
          }
        } finally {
          if (tempHandle !== undefined) {
            api.symbols.closeHandle(tempHandle)
          }
          if (expectedHandle !== undefined) {
            api.symbols.closeHandle(expectedHandle)
          }
          if (preRenameHandle !== undefined) {
            api.symbols.closeHandle(preRenameHandle)
          }
          if (ownsParent) api.symbols.closeHandle(parent)
        }
      }
    },
    async removeFile(relativePath, expected, expectedDigest) {
      const segments = resolveSegments(relativePath)
      const name = segments.pop()
      if (!name) throw new Error('Expected a file path within contained root')
      const parent = openDirectory(segments.join('\\'))
      let handle: WinHandle | undefined
      try {
        handle = openRelative(parent, name, { noFollow: true, delete: true })
        assertContainedHandle(handle)
        const info = getWindowsFileInfo(api, handle)
        if (!fileInfoMatches(info, expected)) return false
        if (
          expectedDigest !== undefined &&
          (await digestWindowsHandle(api, handle)) !== expectedDigest
        ) {
          return false
        }
        markWindowsHandleForDelete(api, handle)
        return true
      } finally {
        if (handle !== undefined) api.symbols.closeHandle(handle)
        if (parent !== rootHandle) api.symbols.closeHandle(parent)
      }
    },
    async close() {
      await close()
    },
  }
}

function createWindowsCapability(
  api: WindowsNativeApi,
  handle: WinHandle,
  path: string,
): ContainedFileCapability {
  let closed = false
  const identity = () => {
    const info = getWindowsFileInfo(api, handle)
    return {
      device: info.device,
      inode: info.inode,
      size: info.size,
      modifiedAtMs: info.modifiedAtMs,
      changedAtMs: info.changedAtMs,
      mode: info.mode,
      nativeFileId: info.nativeFileId,
    }
  }
  const initialIdentity = identity()
  return {
    path,
    descriptorPath: path,
    identity: initialIdentity,
    async currentIdentity() {
      if (closed) throw new Error('Windows file capability is closed')
      return identity()
    },
    async digest() {
      if (closed) throw new Error('Windows file capability is closed')
      return digestWindowsHandle(api, handle)
    },
    async readFile() {
      if (closed) throw new Error('Windows file capability is closed')
      return readWindowsHandle(api, handle)
    },
    async copyTo(destinationPath, options) {
      if (closed) throw new Error('Windows file capability is closed')
      await copyWindowsHandle(api, handle, destinationPath, options?.mode)
    },
    async close() {
      if (closed) return
      closed = true
      api.symbols.closeHandle(handle)
    },
  }
}

async function copyWindowsHandle(
  api: WindowsNativeApi,
  handle: WinHandle,
  destinationPath: string,
  creationMode?: number,
): Promise<void> {
  const size = getWindowsFileInfo(api, handle).size
  const output = await open(destinationPath, 'w', creationMode)
  try {
    if (creationMode !== undefined) await output.chmod(creationMode)
    let offset = 0
    while (offset < size) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, size - offset))
      const count = readWindowsHandleChunk(api, handle, chunk, offset)
      if (count <= 0) throw new Error('Unable to read Windows file handle')
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

function loadWindowsNativeApi(): WindowsNativeApi {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffi = require('bun:ffi') as typeof import('bun:ffi')
  const kernel = ffi.dlopen('kernel32.dll', WINDOWS_NATIVE_ABI.kernel32)
  let advapi: ReturnType<typeof ffi.dlopen> | undefined
  let ntdll: ReturnType<typeof ffi.dlopen> | undefined
  try {
    advapi = ffi.dlopen('advapi32.dll', WINDOWS_NATIVE_ABI.advapi32)
    ntdll = ffi.dlopen('ntdll.dll', WINDOWS_NATIVE_ABI.ntdll)
    return {
      symbols: {
        createFileW: kernel.symbols.CreateFileW,
        getFinalPathNameByHandleW: kernel.symbols.GetFinalPathNameByHandleW,
        closeHandle: kernel.symbols.CloseHandle,
        getFileInformationByHandle: kernel.symbols.GetFileInformationByHandle,
        getFileInformationByHandleEx:
          kernel.symbols.GetFileInformationByHandleEx,
        ntCreateFile: ntdll.symbols.NtCreateFile,
        ntClose: ntdll.symbols.NtClose,
        ntReadFile: ntdll.symbols.NtReadFile,
        ntWriteFile: ntdll.symbols.NtWriteFile,
        ntFlushBuffersFile: ntdll.symbols.NtFlushBuffersFile,
        ntSetInformationFile: ntdll.symbols.NtSetInformationFile,
        ntQueryDirectoryFile: ntdll.symbols.NtQueryDirectoryFile,
        setFileInformationByHandle: kernel.symbols.SetFileInformationByHandle,
        getSecurityInfo: advapi.symbols.GetSecurityInfo,
        setSecurityInfo: advapi.symbols.SetSecurityInfo,
        localFree: kernel.symbols.LocalFree,
      } as unknown as WindowsNativeApi['symbols'],
      ptr: ffi.ptr,
      close() {
        ntdll!.close()
        advapi!.close()
        kernel.close()
      },
    }
  } catch (error) {
    ntdll?.close()
    advapi?.close()
    kernel.close()
    throw error
  }
}

function normalizeWindowsPath(path: string): string {
  const normalized = path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/i, '')
  return win32.normalize(normalized)
}

function isWindowsNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

function windowsStatusError(status: number): Error {
  const unsigned = status >>> 0
  const error = new Error(`Windows native filesystem call failed (NTSTATUS 0x${unsigned.toString(16)})`)
  const code =
    unsigned === 0xc000_0034 || unsigned === 0xc000_003a
      ? 'ENOENT'
      : unsigned === 0xc000_0035
        ? 'EEXIST'
        : unsigned === 0xc000_0022
          ? 'EACCES'
          : 'EIO'
  Object.assign(error, { code })
  return error
}

function createWindowsRootHandle(
  api: WindowsNativeApi,
  path: string,
): WinHandle {
  const buffer = wideString(path)
  const handle = api.symbols.createFileW(
    api.ptr(buffer),
    FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    FILE_SHARE_ALL,
    null,
    3,
    FILE_FLAG_BACKUP_SEMANTICS,
    0,
  )
  if (BigInt(handle) === INVALID_HANDLE || handle === 0) {
    throw Object.assign(new Error('Unable to open Windows contained root'), {
      code: 'EACCES',
    })
  }
  return handle
}

function finalPathForHandle(
  api: WindowsNativeApi,
  handle: WinHandle,
): string {
  const buffer = Buffer.alloc(32_768 * 2)
  const length = api.symbols.getFinalPathNameByHandleW(
    handle,
    api.ptr(buffer),
    32_768,
    0,
  )
  if (length === 0 || length >= 32_768) {
    throw new Error('Unable to resolve Windows handle path')
  }
  return normalizeWindowsPath(
    buffer.toString('utf16le', 0, length * 2),
  )
}

function getWindowsFileInfo(
  api: WindowsNativeApi,
  handle: WinHandle,
): WindowsFileInfo {
  const info = Buffer.alloc(52)
  if (!api.symbols.getFileInformationByHandle(handle, api.ptr(info))) {
    throw new Error('Unable to stat Windows file handle')
  }
  const basic = Buffer.alloc(40)
  if (
    !api.symbols.getFileInformationByHandleEx(
      handle,
      0,
      api.ptr(basic),
      basic.length,
    )
  ) {
    throw new Error('Unable to read Windows file change time')
  }
  return parseWindowsFileInformation(info, basic)
}

export function parseWindowsFileInformation(
  info: Buffer,
  basic?: Buffer,
): WindowsFileInfo {
  const fileTime = (value: Buffer, offset: number): number => {
    const low = BigInt(value.readUInt32LE(offset))
    const high = BigInt(value.readUInt32LE(offset + 4))
    const unixTicks = ((high << 32n) | low) - 116_444_736_000_000_000n
    return Number(unixTicks / 10_000n) + Number(unixTicks % 10_000n) / 10_000
  }
  const high = BigInt(info.readUInt32LE(44))
  const low = BigInt(info.readUInt32LE(48))
  const size = Number(
    (BigInt(info.readUInt32LE(32)) << 32n) | BigInt(info.readUInt32LE(36)),
  )
  const attributes = basic?.readUInt32LE(32) ?? info.readUInt32LE(0)
  const device = info.readUInt32LE(28)
  const exactInode = (BigInt(high) << 32n) | BigInt(low)
  return {
    device,
    inode: Number(exactInode),
    exactInode,
    size,
    modifiedAtMs: basic ? fileTime(basic, 16) : fileTime(info, 20),
    changedAtMs: basic ? fileTime(basic, 24) : fileTime(info, 4),
    mode: windowsMode({ attributes } as WindowsFileInfo, (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0),
    attributes,
    nativeFileId: `${device.toString(16)}:${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`,
  }
}

export function getWindowsFileIdentityForPath(filePath: string): FileIdentity {
  if (process.platform !== 'win32') {
    throw new Error('Windows file identity is only available on Windows')
  }
  const api = loadWindowsNativeApi()
  const pathBuffer = wideString(filePath)
  const handle = api.symbols.createFileW(
    api.ptr(pathBuffer),
    FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    FILE_SHARE_ALL,
    null,
    3,
    0,
    0,
  )
  if (BigInt(handle) === INVALID_HANDLE || handle === 0) {
    api.close()
    throw new Error('Unable to open Windows file for identity')
  }
  try {
    const info = getWindowsFileInfo(api, handle)
    return {
      canonicalPath: finalPathForHandle(api, handle),
      device: info.device,
      inode: info.inode,
      size: info.size,
      modifiedAtMs: info.modifiedAtMs,
      changedAtMs: info.changedAtMs,
      nativeFileId: info.nativeFileId,
    }
  } finally {
    api.symbols.closeHandle(handle)
    api.close()
  }
}

function windowsMode(
  info: Pick<WindowsFileInfo, 'attributes'>,
  isDirectory: boolean,
): number {
  const readOnly = (info.attributes & FILE_ATTRIBUTE_READONLY) !== 0
  return isDirectory
    ? 0o040000 | 0o555 | (readOnly ? 0 : 0o222)
    : 0o100000 | (readOnly ? 0o444 : 0o666)
}

function fileInfoMatches(
  current: WindowsFileInfo,
  expected: ContainedFileCapability['identity'],
): boolean {
  return (
    current.device === expected.device &&
    current.inode === expected.inode &&
    current.size === expected.size &&
    current.modifiedAtMs === expected.modifiedAtMs &&
    current.changedAtMs === expected.changedAtMs &&
    (expected.nativeFileId === undefined ||
      current.nativeFileId === expected.nativeFileId)
  )
}

function windowsStats(info: WindowsFileInfo, isDirectory: boolean): object {
  const date = new Date(info.modifiedAtMs)
  return {
    dev: info.device,
    ino: info.exactInode,
    mode: windowsMode(info, isDirectory),
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: info.size,
    blksize: 4096,
    blocks: Math.ceil(info.size / 512),
    atimeMs: info.modifiedAtMs,
    mtimeMs: info.modifiedAtMs,
    ctimeMs: info.changedAtMs,
    birthtimeMs: info.changedAtMs,
    atime: date,
    mtime: date,
    ctime: new Date(info.changedAtMs),
    birthtime: new Date(info.changedAtMs),
    isFile: () => !isDirectory,
    isDirectory: () => isDirectory,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => (info.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
    isFIFO: () => false,
    isSocket: () => false,
  }
}

async function openOrCreateWindowsDirectory(
  api: WindowsNativeApi,
  rootHandle: WinHandle,
  canonicalRoot: string,
  segments: string[],
  withinRoot: (path: string) => boolean,
  assertContainedHandle: (handle: WinHandle) => string,
  openRelative: (
    root: WinHandle,
    relativePath: string,
    options?: { directory?: boolean; create?: boolean; noFollow?: boolean; write?: boolean },
  ) => WinHandle,
): Promise<WinHandle> {
  let current = rootHandle
  let ownsCurrent = false
  try {
    for (const segment of segments) {
      let next: WinHandle
      try {
        next = openRelative(current, segment, { directory: true })
      } catch (error) {
        if (!isWindowsNotFound(error)) throw error
        try {
          next = openRelative(current, segment, { directory: true, create: true })
        } catch (createError) {
          if (!isWindowsAlreadyExists(createError)) throw createError
          next = openRelative(current, segment, { directory: true })
        }
      }
      let resolved: string
      try {
        resolved = assertContainedHandle(next)
      } catch (error) {
        api.symbols.ntClose(next)
        throw error
      }
      if (!withinRoot(resolved)) {
        api.symbols.closeHandle(next)
        throw new Error('Windows directory handle escaped the contained root')
      }
      if (ownsCurrent) api.symbols.closeHandle(current)
      current = next
      ownsCurrent = true
    }
    if (!ownsCurrent) return rootHandle
    const result = current
    ownsCurrent = false
    return result
  } finally {
    if (ownsCurrent) api.symbols.closeHandle(current)
  }
}

function isWindowsAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

async function queryDirectory(
  api: WindowsNativeApi,
  handle: WinHandle,
): Promise<string[]> {
  const names: string[] = []
  let restart = true
  let capacity = 64 * 1024
  while (true) {
    const buffer = Buffer.alloc(capacity)
    const statusBlock = Buffer.alloc(16)
    const status = api.symbols.ntQueryDirectoryFile(
      handle,
      0,
      0,
      0,
      api.ptr(statusBlock),
      api.ptr(buffer),
      buffer.length,
      IO_FILE_NAMES_INFORMATION_CLASS,
      0,
      null,
      restart ? 1 : 0,
    ) >>> 0
    restart = false
    if (status === STATUS_NO_MORE_FILES) break
    if (status === STATUS_BUFFER_OVERFLOW || status === STATUS_BUFFER_TOO_SMALL) {
      capacity *= 2
      restart = true
      continue
    }
    if (status >= 0x8000_0000) {
      throw windowsStatusError(status | 0)
    }
    const bytes = Number(statusBlock.readBigUInt64LE(8))
    let offset = 0
    while (offset + 12 <= bytes) {
      const next = buffer.readUInt32LE(offset)
      const nameLength = buffer.readUInt32LE(offset + 8)
      const name = buffer.toString('utf16le', offset + 12, offset + 12 + nameLength)
      if (name !== '.' && name !== '..') names.push(name)
      if (next === 0) break
      offset += next
    }
  }
  return names
}

async function readWindowsHandle(
  api: WindowsNativeApi,
  handle: WinHandle,
): Promise<Buffer> {
  const info = getWindowsFileInfo(api, handle)
  const chunks: Buffer[] = []
  let offset = 0
  while (offset < info.size) {
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, info.size - offset))
    const bytesRead = readWindowsHandleChunk(api, handle, chunk, offset)
    if (bytesRead <= 0) throw new Error('Unable to read Windows file handle')
    chunks.push(chunk.subarray(0, bytesRead))
    offset += bytesRead
  }
  return Buffer.concat(chunks, offset)
}

function readWindowsHandleChunk(
  api: WindowsNativeApi,
  handle: WinHandle,
  buffer: Buffer,
  offset: number,
): number {
  const statusBlock = Buffer.alloc(16)
  const byteOffset = Buffer.alloc(8)
  byteOffset.writeBigInt64LE(BigInt(offset))
  const status = api.symbols.ntReadFile(
    handle,
    0,
    0,
    0,
    api.ptr(statusBlock),
    api.ptr(buffer),
    buffer.length,
    api.ptr(byteOffset),
    null,
  )
  if (status < 0) throw windowsStatusError(status)
  return Number(statusBlock.readBigUInt64LE(8))
}

async function writeWindowsHandle(
  api: WindowsNativeApi,
  handle: WinHandle,
  content: Buffer,
): Promise<void> {
  let offset = 0
  while (offset < content.length) {
    const length = Math.min(1024 * 1024, content.length - offset)
    const chunk = content.subarray(offset, offset + length)
    const statusBlock = Buffer.alloc(16)
    const byteOffset = Buffer.alloc(8)
    byteOffset.writeBigInt64LE(BigInt(offset))
    const status = api.symbols.ntWriteFile(
      handle,
      0,
      0,
      0,
      api.ptr(statusBlock),
      api.ptr(chunk),
      chunk.length,
      api.ptr(byteOffset),
      null,
    )
    if (status < 0) throw windowsStatusError(status)
    const bytesWritten = Number(statusBlock.readBigUInt64LE(8))
    if (bytesWritten <= 0) throw new Error('Unable to write Windows file handle')
    offset += bytesWritten
  }
}

function flushWindowsHandle(api: WindowsNativeApi, handle: WinHandle): void {
  const status = Buffer.alloc(16)
  const result = api.symbols.ntFlushBuffersFile(handle, api.ptr(status))
  if (result < 0) throw windowsStatusError(result)
}

async function digestWindowsHandle(
  api: WindowsNativeApi,
  handle: WinHandle,
): Promise<string> {
  const info = getWindowsFileInfo(api, handle)
  const digest = createHash('sha256')
  let offset = 0
  while (offset < info.size) {
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, info.size - offset))
    const bytes = readWindowsHandleChunk(api, handle, chunk, offset)
    if (bytes <= 0) throw new Error('Unable to read Windows file handle')
    digest.update(chunk.subarray(0, bytes))
    offset += bytes
  }
  return digest.digest('hex')
}

function setWindowsFileMode(
  api: WindowsNativeApi,
  handle: WinHandle,
  mode: number,
): void {
  const info = Buffer.alloc(40)
  info.writeUInt32LE(
    (mode & 0o222) === 0 ? FILE_ATTRIBUTE_READONLY : FILE_ATTRIBUTE_NORMAL,
    32,
  )
  if (!api.symbols.setFileInformationByHandle(handle, 0, api.ptr(info), info.length)) {
    throw new Error('Unable to preserve Windows file attributes')
  }
}

function copyWindowsFileSecurity(
  api: WindowsNativeApi,
  source: WinHandle,
  destination: WinHandle,
): void {
  const dacl = Buffer.alloc(8)
  const descriptor = Buffer.alloc(8)
  const securityInformation = 0x4
  const result = api.symbols.getSecurityInfo(
    source,
    1,
    securityInformation,
    null,
    null,
    api.ptr(dacl),
    null,
    api.ptr(descriptor),
  )
  if (result !== 0) {
    throw new Error(`Unable to read Windows file security descriptor (${result})`)
  }
  try {
    const setResult = api.symbols.setSecurityInfo(
      destination,
      1,
      securityInformation,
      0,
      0,
      Number(dacl.readBigUInt64LE(0)),
      0,
    )
    if (setResult !== 0) {
      throw new Error(
        `Unable to preserve Windows file security descriptor (${setResult})`,
      )
    }
  } finally {
    const pointer = Number(descriptor.readBigUInt64LE(0))
    if (pointer !== 0) api.symbols.localFree(pointer)
  }
}

function renameWindowsHandle(
  api: WindowsNativeApi,
  handle: WinHandle,
  parent: WinHandle,
  name: string,
  replaceExisting: boolean,
): void {
  const info = buildWindowsRenameInformation(BigInt(parent), name, replaceExisting)
  const statusBlock = Buffer.alloc(16)
  const status = api.symbols.ntSetInformationFile(
    handle,
    api.ptr(statusBlock),
    api.ptr(info),
    info.length,
    IO_FILE_RENAME_INFORMATION_EX_CLASS,
  )
  if (status < 0) throw windowsStatusError(status)
}

function markWindowsHandleForDelete(
  api: WindowsNativeApi,
  handle: WinHandle,
): void {
  const disposition = Buffer.from([1])
  const statusBlock = Buffer.alloc(16)
  const status = api.symbols.ntSetInformationFile(
    handle,
    api.ptr(statusBlock),
    api.ptr(disposition),
    disposition.length,
    IO_FILE_DISPOSITION_INFORMATION_CLASS,
  )
  if (status < 0) throw windowsStatusError(status)
}
