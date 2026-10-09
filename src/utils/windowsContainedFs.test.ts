import { describe, expect, test } from 'bun:test'
import type { Pointer } from 'bun:ffi'
import {
  prepareFileMutationAuthorization,
  prepareFileRead,
} from './fileAuthorization.js'
import {
  buildWindowsObjectAttributes,
  buildWindowsRenameInformation,
  buildWindowsUnicodeString,
  openWindowsContainedFs,
  openWindowsContainedFsWithNativeApiForTest,
  parseWindowsFileInformation,
  WINDOWS_NATIVE_ABI,
  type WindowsNativeApi,
} from './windowsContainedFs.js'

describe('Windows native filesystem ABI layouts', () => {
  test('loads exact case-sensitive DLL export names with HANDLE arguments as u64', () => {
    expect(WINDOWS_NATIVE_ABI.kernel32).toHaveProperty('CreateFileW')
    expect(WINDOWS_NATIVE_ABI.kernel32).not.toHaveProperty('createFileW')
    expect(WINDOWS_NATIVE_ABI.kernel32.CreateFileW.args).toEqual([
      'ptr',
      'u32',
      'u32',
      'ptr',
      'u32',
      'u32',
      'u64',
    ])
    expect(WINDOWS_NATIVE_ABI.kernel32.CloseHandle.args).toEqual(['u64'])
    expect(WINDOWS_NATIVE_ABI.ntdll).toHaveProperty('NtCreateFile')
    expect(WINDOWS_NATIVE_ABI.ntdll).toHaveProperty('NtSetInformationFile')
    expect(WINDOWS_NATIVE_ABI.advapi32).toHaveProperty('GetSecurityInfo')
    expect(WINDOWS_NATIVE_ABI.advapi32).toHaveProperty('SetSecurityInfo')
  })

  test('parses the native volume serial, 64-bit file ID, and mode fields', () => {
    const info = Buffer.alloc(52)
    info.writeUInt32LE(0x1, 0)
    info.writeUInt32LE(0x1234, 28)
    info.writeUInt32LE(0x00000009, 44)
    info.writeUInt32LE(0xabcdef01, 48)
    const basic = Buffer.alloc(40)
    const writeFileTime = (offset: number, unixMs: number, fraction: number) => {
      const ticks =
        116_444_736_000_000_000n + BigInt(unixMs) * 10_000n + BigInt(fraction)
      basic.writeUInt32LE(Number(ticks & 0xffff_ffffn), offset)
      basic.writeUInt32LE(Number(ticks >> 32n), offset + 4)
    }
    writeFileTime(0, 1_000, 0)
    writeFileTime(16, 2_000, 1_234)
    writeFileTime(24, 3_000, 5_678)
    basic.writeUInt32LE(1, 32)
    const parsed = parseWindowsFileInformation(info, basic)
    expect(parsed.device).toBe(0x1234)
    expect(parsed.nativeFileId).toBe('1234:00000009abcdef01')
    expect(parsed.exactInode).toBe(0x9abcdef01n)
    expect(parsed.mode & 0o222).toBe(0)
    expect(parsed.modifiedAtMs).toBeCloseTo(2_000.1234, 4)
    expect(parsed.changedAtMs).toBeCloseTo(3_000.5678, 4)
    expect(parsed.inode).toBe(
      Number((0x9n << 32n) | 0xabcdef01n),
    )
  })

  test('preserves adjacent native file IDs above Number precision', () => {
    const exactInode = (fileIndex: bigint) => {
      const info = Buffer.alloc(52)
      info.writeUInt32LE(Number(fileIndex >> 32n), 44)
      info.writeUInt32LE(Number(fileIndex & 0xffff_ffffn), 48)
      return parseWindowsFileInformation(info).exactInode
    }

    expect(exactInode(0n)).toBe(0n)
    expect(exactInode(9_007_199_254_740_992n)).toBe(9_007_199_254_740_992n)
    expect(exactInode(9_007_199_254_740_993n)).toBe(9_007_199_254_740_993n)
  })

  test('packs Unicode strings and object attributes for 64-bit HANDLE ABI', () => {
    const unicode = buildWindowsUnicodeString(0x1122_3344_5566_7788n, 6)
    expect(unicode.readUInt16LE(0)).toBe(6)
    expect(unicode.readUInt16LE(2)).toBe(8)
    expect(unicode.readBigUInt64LE(8)).toBe(0x1122_3344_5566_7788n)

    const attributes = buildWindowsObjectAttributes(
      0x0102_0304_0506_0708n,
      0x1122_3344_5566_7788n,
    )
    expect(attributes.length).toBe(48)
    expect(attributes.readUInt32LE(0)).toBe(48)
    expect(attributes.readBigUInt64LE(8)).toBe(0x0102_0304_0506_0708n)
    expect(attributes.readBigUInt64LE(16)).toBe(0x1122_3344_5566_7788n)
    expect(attributes.readUInt32LE(24)).toBe(0x40)
  })

  test('packs handle-relative rename information', () => {
    const rename = buildWindowsRenameInformation(0x1234n, 'nested\\new.txt', true)
    expect(rename.readUInt32LE(0)).toBe(0x3)
    expect(rename.readBigUInt64LE(8)).toBe(0x1234n)
    expect(rename.readUInt32LE(16)).toBe(Buffer.byteLength('nested\\new.txt', 'utf16le'))
    expect(rename.toString('utf16le', 20, 20 + rename.readUInt32LE(16))).toBe(
      'nested\\new.txt',
    )

    const noReplace = buildWindowsRenameInformation(0x1234n, 'created.txt', false)
    expect(noReplace.readUInt32LE(0)).toBe(0)
  })
})

test('mocked native transport keeps the borrowed root handle open across root-level calls', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffi = require('bun:ffi') as typeof import('bun:ffi')
  const rootPath = 'C:\\workspace'
  const files = new Map<string, Buffer>()
  const handlePaths = new Map<number, string>([[1, rootPath]])
  let nextHandle = 2
  let rootCloseCount = 0
  let fileId = 1
  let failRename = false
  let failDelete = false
  let mutateRetainedContentsOnRename = false
  let ordinaryReplaceBlocked = false
  const stringAt = (pointer: bigint, bytes: number): string =>
    Buffer.from(ffi.toArrayBuffer(Number(pointer), 0, bytes))
      .toString('utf16le')
      .replace(/\0+$/, '')
  const pathAt = (pointer: Pointer): string => {
    const buffer = Buffer.from(ffi.toArrayBuffer(pointer, 0, 512))
    let end = 0
    while (end + 1 < buffer.length && buffer.readUInt16LE(end) !== 0) {
      end += 2
    }
    return buffer.toString('utf16le', 0, end)
  }
  const putFileInformation = (pointer: Pointer, handle: number): void => {
    const buffer = Buffer.from(ffi.toArrayBuffer(pointer, 0, 52))
    const content = files.get(handlePaths.get(handle)!) ?? Buffer.alloc(0)
    buffer.writeUInt32LE(handle === 1 ? 0x10 : 0x80, 0)
    buffer.writeUInt32LE(0x1234, 28)
    buffer.writeUInt32LE(0, 32)
    buffer.writeUInt32LE(content.length, 36)
    buffer.writeUInt32LE(0, 44)
    buffer.writeUInt32LE(fileId, 48)
  }
  const api = {
    symbols: {
      createFileW: (pointer: Pointer) => {
        expect(pathAt(pointer)).toBe(rootPath)
        return 1
      },
      getFinalPathNameByHandleW: (
        handle: number,
        pointer: Pointer,
      ) => {
        const path = handlePaths.get(handle)
        if (!path) return 0
        const output = Buffer.from(ffi.toArrayBuffer(pointer, 0, 32768 * 2))
        const encoded = Buffer.from(`${path}\0`, 'utf16le')
        encoded.copy(output)
        return encoded.length / 2 - 1
      },
      closeHandle: (handle: number) => {
        if (handle === 1) rootCloseCount++
        handlePaths.delete(handle)
        return 1
      },
      getFileInformationByHandle: (handle: number, pointer: Pointer) => {
        putFileInformation(pointer, handle)
        return 1
      },
      getFileInformationByHandleEx: (
        handle: number,
        _class: number,
        pointer: Pointer,
      ) => {
        const basic = Buffer.from(ffi.toArrayBuffer(pointer, 0, 40))
        basic.writeUInt32LE(handle === 1 ? 0x10 : 0x80, 32)
        return 1
      },
      setFileInformationByHandle: () => 1,
      ntCreateFile: (
        handlePointer: Pointer,
        access: number,
        attributesPointer: Pointer,
        _statusPointer: Pointer,
        _allocation: Pointer | null,
        _attributes: number,
        _share: number,
        disposition: number,
        _options: number,
        _ea: Pointer | null,
        _eaLength: number,
      ) => {
        if ((_options & 0x1) === 0) {
          expect(access & 0x20).toBe(0)
        }
        if (disposition === 2 && (_options & 0x1) === 0) {
          expect(access & 0x100).not.toBe(0)
        }
        const attributes = Buffer.from(ffi.toArrayBuffer(attributesPointer, 0, 48))
        const parent = Number(attributes.readBigUInt64LE(8))
        const unicodePointer = attributes.readBigUInt64LE(16)
        const unicode = Buffer.from(
          ffi.toArrayBuffer(Number(unicodePointer), 0, 16),
        )
        const name = stringAt(unicode.readBigUInt64LE(8), unicode.readUInt16LE(0))
        const parentPath = handlePaths.get(parent)
        if (!parentPath) return 0xc000_0034 | 0
        const targetPath = `${parentPath}\\${name}`
        const exists = files.has(targetPath) || [...handlePaths.values()].includes(targetPath)
        if (disposition === 1 && !exists) return 0xc000_0034 | 0
        if (disposition === 2 && exists) return 0xc000_0035 | 0
        const handle = nextHandle++
        handlePaths.set(handle, targetPath)
        if (disposition === 2) files.set(targetPath, Buffer.alloc(0))
        const handleBuffer = Buffer.from(ffi.toArrayBuffer(handlePointer, 0, 8))
        handleBuffer.writeBigUInt64LE(BigInt(handle), 0)
        return 0
      },
      ntClose: (handle: number) => {
        handlePaths.delete(handle)
        return 0
      },
      ntReadFile: (
        handle: number,
        _event: number,
        _apc: number,
        _apcContext: number,
        statusPointer: Pointer,
        bufferPointer: Pointer,
        length: number,
        offsetPointer: Pointer,
      ) => {
        const source = files.get(handlePaths.get(handle)!) ?? Buffer.alloc(0)
        const offset = Number(
          Buffer.from(ffi.toArrayBuffer(offsetPointer, 0, 8)).readBigInt64LE(0),
        )
        const count = Math.max(0, Math.min(length, source.length - offset))
        Buffer.from(ffi.toArrayBuffer(bufferPointer, 0, length)).set(
          source.subarray(offset, offset + count),
        )
        Buffer.from(ffi.toArrayBuffer(statusPointer, 0, 16)).writeBigUInt64LE(
          BigInt(count),
          8,
        )
        return 0
      },
      ntWriteFile: (
        handle: number,
        _event: number,
        _apc: number,
        _apcContext: number,
        statusPointer: Pointer,
        bufferPointer: Pointer,
        length: number,
        offsetPointer: Pointer,
      ) => {
        const targetPath = handlePaths.get(handle)!
        const offset = Number(
          Buffer.from(ffi.toArrayBuffer(offsetPointer, 0, 8)).readBigInt64LE(0),
        )
        const destination = files.get(targetPath) ?? Buffer.alloc(0)
        const input = Buffer.from(ffi.toArrayBuffer(bufferPointer, 0, length))
        const next = Buffer.alloc(Math.max(destination.length, offset + length))
        destination.copy(next)
        input.copy(next, offset)
        files.set(targetPath, next)
        Buffer.from(ffi.toArrayBuffer(statusPointer, 0, 16)).writeBigUInt64LE(
          BigInt(length),
          8,
        )
        return 0
      },
      ntFlushBuffersFile: () => 0,
      ntSetInformationFile: (
        handle: number,
        _statusPointer: Pointer,
        infoPointer: Pointer,
        length: number,
        infoClass: number,
      ) => {
        if (infoClass === 13 && failDelete) return 0xc000_0022 | 0
        if (infoClass === 65 && failRename) return 0xc000_0022 | 0
        if (infoClass !== 10 && infoClass !== 65) return 0
        const info = Buffer.from(ffi.toArrayBuffer(infoPointer, 0, length))
        const flags = info.readUInt32LE(0)
        const root = Number(info.readBigUInt64LE(8))
        const nameLength = info.readUInt32LE(16)
        const name = info.toString('utf16le', 20, 20 + nameLength)
        const oldPath = handlePaths.get(handle)!
        const newPath = `${handlePaths.get(root)}\\${name}`
        const destinationExists = files.has(newPath)
        const retainedDestinationHandles = [...handlePaths.entries()].filter(
          ([openHandle, path]) => openHandle !== handle && path === newPath,
        )
        if (infoClass === 10 && destinationExists && retainedDestinationHandles.length) {
          ordinaryReplaceBlocked = true
          return 0xc000_0056 | 0
        }
        if (
          destinationExists &&
          ((flags & 0x1) === 0 ||
            (infoClass !== 65 && (flags & 0x2) !== 0))
        ) {
          return 0xc000_0035 | 0
        }
        const content = files.get(oldPath) ?? Buffer.alloc(0)
        files.delete(oldPath)
        if (destinationExists && retainedDestinationHandles.length) {
          const retainedPath = `${newPath}.retained-${handle}`
          files.set(retainedPath, files.get(newPath)!)
          if (mutateRetainedContentsOnRename) {
            files.set(retainedPath, Buffer.from('externally updated target'))
            mutateRetainedContentsOnRename = false
          }
          for (const [openHandle] of retainedDestinationHandles) {
            handlePaths.set(openHandle, retainedPath)
          }
        } else {
          files.delete(newPath)
        }
        files.set(newPath, content)
        handlePaths.set(handle, newPath)
        return 0
      },
      ntQueryDirectoryFile: () => 0x8000_0006 | 0,
      getSecurityInfo: () => 0,
      setSecurityInfo: () => 0,
      localFree: () => 0,
    },
    ptr: ffi.ptr,
    close() {},
  } as unknown as WindowsNativeApi

  const contained = await openWindowsContainedFsWithNativeApiForTest(
    rootPath,
    api,
  )
  try {
    expect(
      await contained.publishFileWithIdentity(
        'first.txt',
        Buffer.from('first root file'),
      ),
    ).not.toBeNull()
    expect(
      await contained.publishFileWithIdentity(
        'second.txt',
        Buffer.from('second root file'),
      ),
    ).not.toBeNull()
    const retainedTarget = await contained.openFileCapability('first.txt')
    const retainedIdentity = retainedTarget.identity
    const retainedDigest = await retainedTarget.digest()
    const legacySource = `${rootPath}\\.legacy-replacement.tmp`
    const legacyName = Buffer.from('first.txt', 'utf16le')
    const legacyInfo = Buffer.alloc(20 + legacyName.length)
    legacyInfo.writeUInt8(1, 0)
    legacyInfo.writeBigUInt64LE(1n, 8)
    legacyInfo.writeUInt32LE(legacyName.length, 16)
    legacyName.copy(legacyInfo, 20)
    files.set(legacySource, Buffer.from('legacy replacement'))
    handlePaths.set(99, legacySource)
    const legacyStatus = Buffer.alloc(16)
    expect(
      api.symbols.ntSetInformationFile(
        99,
        api.ptr(legacyStatus),
        api.ptr(legacyInfo),
        legacyInfo.length,
        10,
      ),
    ).toBeLessThan(0)
    expect(ordinaryReplaceBlocked).toBe(true)
    files.delete(legacySource)
    handlePaths.delete(99)
    const replacement = await contained.publishFileWithIdentity(
      'first.txt',
      Buffer.from('replacement with retained handle'),
      retainedIdentity,
      undefined,
      retainedDigest,
    )
    expect(replacement).not.toBeNull()
    expect((await retainedTarget.readFile()).toString()).toBe('first root file')
    expect(
      (await contained.readFile('first.txt')).content.toString(),
    ).toBe('replacement with retained handle')
    await retainedTarget.close()
    expect(ordinaryReplaceBlocked).toBe(true)
    const conflictTarget = await contained.openFileCapability('first.txt')
    try {
      mutateRetainedContentsOnRename = true
      expect(
        await contained.publishFileWithIdentity(
          'first.txt',
          Buffer.from('must roll back'),
          conflictTarget.identity,
          undefined,
          await conflictTarget.digest(),
        ),
      ).toBeNull()
      expect(
        (await contained.readFile('first.txt')).content.toString(),
      ).toBe('externally updated target')
    } finally {
      await conflictTarget.close()
    }
    expect((await contained.readFile('first.txt')).content.toString()).toBe(
      'externally updated target',
    )
    const capability = await contained.openFileCapability('first.txt')
    expect(capability.path).toBe(`${rootPath}\\first.txt`)
    expect(capability.descriptorPath).toBe(capability.path)
    const approvedIdentity = capability.identity
    expect(approvedIdentity.nativeFileId).toMatch(/^1234:/)
    fileId++
    expect(capability.identity).toEqual(approvedIdentity)
    expect(await capability.currentIdentity()).not.toEqual(approvedIdentity)
    await capability.close()
    const current = await contained.openFileCapability('first.txt')
    const expected = current.identity
    await current.close()
    failRename = true
    failDelete = true
    await expect(
      contained.publishFileWithIdentity(
        'first.txt',
        Buffer.from('replacement'),
        expected,
      ),
    ).rejects.toThrow('NTSTATUS')
    expect(handlePaths.size).toBe(1)
    expect(rootCloseCount).toBe(0)
  } finally {
    await contained.close()
  }
  expect(rootCloseCount).toBe(1)
})

const windowsOnly = process.platform === 'win32' ? test : test.skip

windowsOnly('UNC capabilities defer all filesystem access until execution', async () => {
  const read = await prepareFileRead('\\\\server\\share\\deferred.txt')
  const mutation = await prepareFileMutationAuthorization(
    '\\\\server\\share\\deferred.txt',
  )
  try {
    expect(read.pathnameLimited).toBe(true)
    expect(read.capability).toBeUndefined()
    expect(mutation.pathnameLimited).toBe(true)
    expect(mutation.parent).toBeUndefined()
  } finally {
    await read.cleanup()
    await mutation.cleanup()
  }
})

windowsOnly('Windows native capabilities survive target and parent reparse swaps', async () => {
  const { mkdtemp, mkdir, readFile, rm, symlink, writeFile } = await import(
    'fs/promises'
  )
  const { tmpdir } = await import('os')
  const { join } = await import('path')
  const root = await mkdtemp(join(tmpdir(), 'windows-contained-fs-'))
  const allowed = join(root, 'allowed')
  const outside = join(root, 'outside')
  const alias = join(root, 'parent-junction')
  const writeAlias = join(root, 'write-junction')
  const lateLink = join(root, 'late-file-link.txt')
  await mkdir(allowed)
  await mkdir(outside)
  await writeFile(join(allowed, 'source.txt'), 'allowed-object')
  await writeFile(join(outside, 'source.txt'), 'outside-marker')
  await symlink(allowed, alias, 'junction')
  await symlink(allowed, writeAlias, 'junction')
  const contained = await openWindowsContainedFs(root)
  try {
    const source = await contained.openFileCapability(
      'parent-junction\\source.txt',
    )
    try {
      await rm(alias, { recursive: true })
      await symlink(outside, alias, 'junction')
      expect((await source.readFile()).toString()).toBe('allowed-object')
      await symlink(join(outside, 'source.txt'), lateLink, 'file')
      await expect(
        contained.openFileCapabilityNoFollow('late-file-link.txt'),
      ).rejects.toThrow()
    } finally {
      await source.close()
    }

    const retainedParent = await openWindowsContainedFs(writeAlias)
    try {
      await rm(writeAlias, { recursive: true })
      await symlink(outside, writeAlias, 'junction')
      const published = await retainedParent.publishFileWithIdentity(
        'nested\\created.txt',
        Buffer.from('created-through-parent-handle'),
      )
      expect(published).not.toBeNull()
      expect(
        await readFile(join(allowed, 'nested', 'created.txt'), 'utf8'),
      ).toBe('created-through-parent-handle')
      await expect(
        readFile(join(outside, 'nested', 'created.txt')),
      ).rejects.toThrow()
    } finally {
      await retainedParent.close()
    }

    const rootCapabilities = await openWindowsContainedFs(allowed)
    try {
      await writeFile(join(allowed, 'retained.txt'), 'old target contents')
      const retained = await rootCapabilities.openFileCapability('retained.txt')
      try {
        const identity = retained.identity
        const digest = await retained.digest()
        expect(
          await rootCapabilities.publishFileWithIdentity(
            'retained.txt',
            Buffer.from('new published contents'),
            identity,
            undefined,
            digest,
          ),
        ).not.toBeNull()
        expect((await retained.readFile()).toString()).toBe('old target contents')
        expect(
          (await readFile(join(allowed, 'retained.txt'), 'utf8')),
        ).toBe('new published contents')
      } finally {
        await retained.close()
      }
      expect(
        await rootCapabilities.publishFileWithIdentity(
          'root-created.txt',
          Buffer.from('first root publication'),
        ),
      ).not.toBeNull()
      expect(
        await rootCapabilities.publishFileWithIdentity(
          'second-root-created.txt',
          Buffer.from('second root publication'),
        ),
      ).not.toBeNull()
      expect(
        (await rootCapabilities.readFile('root-created.txt')).content.toString(),
      ).toBe('first root publication')
    } finally {
      await rootCapabilities.close()
    }
    const reopenedRoot = await openWindowsContainedFs(allowed)
    try {
      expect(
        (await reopenedRoot.readFile('second-root-created.txt')).content.toString(),
      ).toBe('second root publication')
    } finally {
      await reopenedRoot.close()
    }
  } finally {
    await contained.close()
    await rm(root, { recursive: true, force: true })
  }
})
