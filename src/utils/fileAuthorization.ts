import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  sep,
  win32,
} from 'path'
import type { ToolUseContext } from '../Tool.js'
import {
  openContainedFs,
  type ContainedFileCapability,
  type ContainedFs,
} from './containedFs.js'
import { expandPath } from './path.js'
import { lstat, open, realpath } from 'fs/promises'
import { isDeepStrictEqual } from 'util'
import { isENOENT } from './errors.js'
import {
  fileIdentitiesEqual,
  getFileIdentity,
  type FileIdentity,
} from './file.js'
import {
  detectLineEndingsForString,
  readFileSyncWithMetadata,
  type LineEndingType,
} from './fileRead.js'

export type PreparedFileRead = {
  originalPath: string
  canonicalPath: string
  readonly actualPath: string
  pathnameLimited?: boolean
  alternate?: PreparedFileRead
  inputSnapshot?: unknown
  inputCanonicalizer?: (input: Record<string, unknown>) => unknown
  readonly descriptorPath: string
  readonly capability?: ContainedFileCapability
  openFile(): Promise<ContainedFileCapability>
  readSiblingNames(): Promise<string[]>
  cleanup(): Promise<void>
}

export type PreparedFileMutation = {
  originalPath: string
  canonicalPath: string
  actualPath?: string
  relativePath: string
  parent?: ContainedFs
  existing?: ContainedFileCapability
  pathnameLimited?: boolean
  inputSnapshot?: unknown
  inputCanonicalizer?: (input: Record<string, unknown>) => unknown
  cleanup(): Promise<void>
}

export type PreparedFileMutationSet = {
  byPath: Map<string, PreparedFileMutation>
  inputSnapshot?: unknown
  inputCanonicalizer?: (input: Record<string, unknown>) => unknown
  cleanup(): Promise<void>
}

export function bindPreparedFileInput<T extends object>(
  state: T,
  input: Record<string, unknown>,
  canonicalize: (input: Record<string, unknown>) => unknown = value => value,
): T & { inputSnapshot: Record<string, unknown> } {
  const snapshot = structuredClone(canonicalize(input))
  freezeDeep(snapshot)
  Object.assign(state, {
    inputSnapshot: snapshot,
    inputCanonicalizer: canonicalize,
  })
  return state as T & { inputSnapshot: Record<string, unknown> }
}

function freezeDeep(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return
  }
  for (const child of Object.values(value)) freezeDeep(child)
  Object.freeze(value)
}

function matchesPreparedInput(
  state: {
    inputSnapshot?: unknown
    inputCanonicalizer?: (input: Record<string, unknown>) => unknown
  },
  input: Record<string, unknown>,
): boolean {
  return (
    state.inputSnapshot !== undefined &&
    isDeepStrictEqual(state.inputSnapshot, (state.inputCanonicalizer ?? (x => x))(input))
  )
}

export function getPreparedFileRead(
  context: ToolUseContext,
  toolName: string,
  input: Record<string, unknown>,
): PreparedFileRead | undefined {
  const prepared = context.preparedExecution
  if (prepared?.toolName !== toolName || !isPreparedFileRead(prepared.state)) {
    return undefined
  }
  if (!matchesPreparedInput(prepared.state, input)) return undefined
  return prepared.state
}

export function getPreparedFileMutation(
  context: ToolUseContext,
  toolName: string,
  input: Record<string, unknown>,
): PreparedFileMutation | undefined {
  const prepared = context.preparedExecution
  if (
    prepared?.toolName !== toolName ||
    !isPreparedFileMutation(prepared.state)
  ) {
    return undefined
  }
  if (!matchesPreparedInput(prepared.state, input)) return undefined
  return prepared.state
}

export function getPreparedFileMutationSet(
  context: ToolUseContext,
  toolName: string,
  input: Record<string, unknown>,
): PreparedFileMutationSet | undefined {
  const prepared = context.preparedExecution
  if (
    prepared?.toolName !== toolName ||
    typeof prepared.state !== 'object' ||
    prepared.state === null ||
    !('byPath' in prepared.state) ||
    !(prepared.state.byPath instanceof Map)
  ) {
    return undefined
  }
  const state = prepared.state as PreparedFileMutationSet
  if (!matchesPreparedInput(state, input)) return undefined
  return state
}

export async function prepareFileRead(
  filePath: string,
): Promise<PreparedFileRead> {
  const originalPath = expandPath(filePath)
  if (
    process.platform === 'win32' &&
    (originalPath.startsWith('\\\\') || originalPath.startsWith('//'))
  ) {
    return prepareDeferredUncFileRead(originalPath)
  }
  const mutation = await prepareFileMutationAuthorization(originalPath)
  let capability = mutation.existing
  return {
    originalPath: mutation.originalPath,
    canonicalPath: mutation.canonicalPath,
    get actualPath() {
      return capability?.path ?? mutation.canonicalPath
    },
    get descriptorPath() {
      if (!capability) throw new Error('Prepared file has not been opened')
      return capability.descriptorPath
    },
    get capability() {
      return capability
    },
    async openFile() {
      if (capability) return capability
      try {
        capability = await mutation.parent.openFileCapabilityNoFollow(
          mutation.relativePath,
        )
        return capability
      } catch {
        const error = new Error('File does not exist at the prepared path')
        Object.assign(error, { code: 'ENOENT' })
        throw error
      }
    },
    async readSiblingNames() {
      const parentPath = dirname(mutation.relativePath)
      return mutation.parent.readdir(parentPath === '.' ? '' : parentPath)
    },
    async cleanup() {
      try {
        if (capability && capability !== mutation.existing) {
          await capability.close()
        }
      } finally {
        await mutation.cleanup()
      }
    },
  }
}

function prepareDeferredUncFileRead(originalPath: string): PreparedFileRead {
  let capability: ContainedFileCapability | undefined
  let contained: ContainedFs | undefined
  return {
    originalPath,
    canonicalPath: originalPath,
    pathnameLimited: true,
    get actualPath() {
      return capability?.path ?? originalPath
    },
    get descriptorPath() {
      if (!capability) throw new Error('Prepared file has not been opened')
      return capability.descriptorPath
    },
    get capability() {
      return capability
    },
    async openFile() {
      if (capability) return capability
      const openedRoot = await openContainedFs(win32.dirname(originalPath))
      try {
        capability = await openedRoot.openFileCapability(
          win32.basename(originalPath),
        )
        contained = openedRoot
      } catch (error) {
        await openedRoot.close()
        throw error
      }
      return capability
    },
    async readSiblingNames() {
      return []
    },
    async cleanup() {
      await capability?.close()
      await contained?.close()
    },
  }
}

export async function prepareFileMutationAuthorization(
  filePath: string,
): Promise<PreparedFileMutation> {
  const originalPath = expandPath(filePath)
  if (!isAbsolute(originalPath)) {
    throw new Error('File authorization requires an absolute path')
  }
  if (originalPath.includes('\0')) {
    throw new Error('NUL is not allowed in file paths')
  }
  if (
    process.platform === 'win32' &&
    (originalPath.startsWith('\\\\') || originalPath.startsWith('//'))
  ) {
    return {
      originalPath,
      canonicalPath: originalPath,
      relativePath: originalPath,
      pathnameLimited: true,
      async cleanup() {},
    }
  }

  let canonicalPath: string
  let targetExists = true
  try {
    canonicalPath = await realpath(originalPath)
  } catch (error) {
    if (!isENOENT(error)) throw error
    targetExists = false
    try {
      await lstat(originalPath)
      throw new Error('Cannot safely authorize a dangling file symlink')
    } catch (lstatError) {
      if (!isENOENT(lstatError)) throw lstatError
    }
    let ancestor = dirname(originalPath)
    while (true) {
      try {
        const canonicalAncestor = await realpath(ancestor)
        canonicalPath = join(
          canonicalAncestor,
          relative(ancestor, dirname(originalPath)),
          basename(originalPath),
        )
        break
      } catch (ancestorError) {
        if (!isENOENT(ancestorError)) throw ancestorError
        const parent = dirname(ancestor)
        if (parent === ancestor) throw ancestorError
        ancestor = parent
      }
    }
  }

  let ancestor = dirname(canonicalPath)
  while (true) {
    try {
      ancestor = await realpath(ancestor)
      break
    } catch (error) {
      if (!isENOENT(error)) throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }

  const parent = await openContainedFs(ancestor)
  if (parent.canonicalRoot !== ancestor) {
    await parent.close()
    throw new Error('Prepared parent identity changed while opening')
  }
  canonicalPath = join(
    parent.canonicalRoot,
    relative(ancestor, dirname(canonicalPath)),
    basename(canonicalPath),
  )
  const relativePath = join(
    relative(parent.canonicalRoot, dirname(canonicalPath)),
    basename(canonicalPath),
  )
    .split(sep)
    .join('/')
  let existing: ContainedFileCapability | undefined
  try {
    if (targetExists) {
      existing = await parent.openFileCapability(relativePath)
    }
    let closed = false
    return {
      originalPath,
      canonicalPath,
      ...(existing === undefined ? {} : { actualPath: existing.path }),
      relativePath,
      parent,
      ...(existing === undefined ? {} : { existing }),
      async cleanup() {
        if (closed) return
        closed = true
        try {
          await existing?.close()
        } finally {
          await parent.close()
        }
      },
    }
  } catch (error) {
    await parent.close()
    throw error
  }
}

export async function prepareApprovedUncFileMutation(
  filePath: string,
): Promise<PreparedFileMutation> {
  if (process.platform !== 'win32') {
    throw new Error('UNC mutation capabilities are Windows-only')
  }
  const originalPath = expandPath(filePath)
  if (!originalPath.startsWith('\\\\') && !originalPath.startsWith('//')) {
    throw new Error('Expected an approved UNC path')
  }
  const rootPath = win32.parse(originalPath).root
  if (!rootPath) throw new Error('UNC path is missing its share root')
  const parent = await openContainedFs(rootPath)
  const relativePath = win32.relative(rootPath, originalPath)
  const safeRelative = relativePath.split(/[\\/]/).filter(Boolean)
  if (safeRelative.some(segment => segment === '..')) {
    await parent.close()
    throw new Error('UNC path escapes its share root')
  }
  const canonicalPath = win32.join(parent.canonicalRoot, ...safeRelative)
  try {
    let existing: ContainedFileCapability | undefined
    try {
      existing = await parent.openFileCapability(relativePath)
    } catch (error) {
      if (!isENOENT(error)) throw error
    }
    let cleaned = false
    return {
      originalPath,
      canonicalPath: existing?.path ?? canonicalPath,
      ...(existing ? { actualPath: existing.path } : {}),
      relativePath: safeRelative.join('/'),
      parent,
      ...(existing ? { existing } : {}),
      async cleanup() {
        if (cleaned) return
        cleaned = true
        try {
          await existing?.close()
        } finally {
          await parent.close()
        }
      },
    }
  } catch (error) {
    await parent.close()
    throw error
  }
}

export async function readPreparedFileMetadata(
  prepared: PreparedFileMutation,
): Promise<{
  content: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  identity: FileIdentity
}> {
  if (prepared.pathnameLimited) {
    const metadata = readFileSyncWithMetadata(prepared.originalPath)
    return {
      ...metadata,
      identity: getFileIdentity(prepared.originalPath),
    }
  }
  const capability = prepared.existing
  if (!capability) throw new Error('Prepared file does not exist')
  const before = await capability.currentIdentity()
  const buffer = await capability.readFile()
  const after = await capability.currentIdentity()
  const asFileIdentity = (identity: typeof before): FileIdentity => ({
    canonicalPath: prepared.canonicalPath,
    device: identity.device,
    inode: identity.inode,
    size: identity.size,
    modifiedAtMs: identity.modifiedAtMs,
    changedAtMs: identity.changedAtMs,
    ...(identity.nativeFileId === undefined
      ? {}
      : { nativeFileId: identity.nativeFileId }),
  })
  if (!fileIdentitiesEqual(asFileIdentity(before), asFileIdentity(after))) {
    throw new Error('File has been unexpectedly modified. Read it again before attempting to write it.')
  }
  const encoding: BufferEncoding =
    buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
      ? 'utf16le'
      : 'utf8'
  const raw = buffer.toString(encoding)
  return {
    content: raw.replaceAll('\r\n', '\n'),
    encoding,
    lineEndings: detectLineEndingsForString(raw.slice(0, 4096)),
    identity: asFileIdentity(after),
  }
}

export async function preparedFileIdentity(
  prepared: PreparedFileRead,
): Promise<{
  canonicalPath: string
  device: number
  inode: number
  size: number
  modifiedAtMs: number
  changedAtMs: number
  nativeFileId?: string
}> {
  const capability = prepared.capability
  if (!capability) throw new Error('Prepared file has not been opened')
  const identity = await capability.currentIdentity()
  return {
    canonicalPath: prepared.pathnameLimited
      ? capability.path
      : prepared.canonicalPath,
    device: identity.device,
    inode: identity.inode,
    size: identity.size,
    modifiedAtMs: identity.modifiedAtMs,
    changedAtMs: identity.changedAtMs,
    ...(identity.nativeFileId === undefined
      ? {}
      : { nativeFileId: identity.nativeFileId }),
  }
}

function isPreparedFileRead(value: unknown): value is PreparedFileRead {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<PreparedFileRead>
  return (
    typeof candidate.originalPath === 'string' &&
    typeof candidate.canonicalPath === 'string' &&
    typeof candidate.cleanup === 'function' &&
    typeof candidate.openFile === 'function' &&
    typeof candidate.readSiblingNames === 'function'
  )
}

function isPreparedFileMutation(
  value: unknown,
): value is PreparedFileMutation {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<PreparedFileMutation>
  return (
    typeof candidate.originalPath === 'string' &&
    typeof candidate.canonicalPath === 'string' &&
    typeof candidate.relativePath === 'string' &&
    typeof candidate.cleanup === 'function' &&
    (candidate.pathnameLimited === true ||
      (typeof candidate.parent === 'object' && candidate.parent !== null))
  )
}
