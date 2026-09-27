import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { SessionBinding } from '../shared/sessionBinding.js'

type RootRecord = { version: 1; storageRootId: string; rootPath: string }
export type ManagedStorageResolution =
  | { ok: true; cwd: string; binding: Extract<SessionBinding, { kind: 'managed' }> }
  | { ok: false; reason: 'missing' | 'invalid' }

/** Owns app-managed chat folders and the durable root identity that names them. */
export class ManagedStorage {
  private readonly appDataBase: string
  private readonly recordPath: string
  private readonly legacyRecordPath: string
  private readonly ownershipDir: string
  private rootRecord: RootRecord | null = null

  constructor(options: { appDataBase: string; ownershipDir: string }) {
    this.appDataBase = resolve(options.appDataBase)
    const profileId = createHash('sha256').update(this.appDataBase).digest('hex')
    this.recordPath = join(options.ownershipDir, `managed-storage-root-${profileId}.json`)
    this.legacyRecordPath = join(options.ownershipDir, 'managed-storage-root.json')
    this.ownershipDir = join(options.ownershipDir, 'managed-storage')
  }

  create(): ManagedStorageResolution {
    try {
      const root = this.getOrCreateRoot()
      const storageId = randomUUID()
      this.writeOwnership(root.storageRootId, storageId)
      const cwd = join(root.rootPath, storageId)
      mkdirSync(cwd, { recursive: false, mode: 0o700 })
      const canonical = this.validatePath(cwd, root)
      if (!canonical) return { ok: false, reason: 'invalid' }
      mkdirSync(join(canonical, 'tmp'), { recursive: false, mode: 0o700 })
      if (realpathSync(join(canonical, 'tmp')) !== join(canonical, 'tmp')) return { ok: false, reason: 'invalid' }
      return {
        ok: true,
        cwd: canonical,
        binding: { kind: 'managed', storageRootId: root.storageRootId, storageId },
      }
    } catch {
      return { ok: false, reason: 'invalid' }
    }
  }

  resolve(binding: SessionBinding): ManagedStorageResolution {
    if (binding.kind !== 'managed' || !validUuid(binding.storageRootId) || !validUuid(binding.storageId)) {
      return { ok: false, reason: 'invalid' }
    }
    try {
      const root = this.readRoot()
      if (!root || root.storageRootId !== binding.storageRootId) return { ok: false, reason: 'invalid' }
      if (!this.hasOwnership(binding.storageRootId, binding.storageId)) return { ok: false, reason: 'invalid' }
      const target = join(root.rootPath, binding.storageId)
      try {
        lstatSync(target)
        const cwd = this.validatePath(target, root)
        return cwd && this.validateTempPath(cwd) ? { ok: true, cwd, binding } : { ok: false, reason: 'invalid' }
      } catch (error) {
        return isNotFound(error) ? { ok: false, reason: 'missing' } : { ok: false, reason: 'invalid' }
      }
    } catch {
      return { ok: false, reason: 'invalid' }
    }
  }

  recordSessionIdentity(
    binding: Extract<SessionBinding, { kind: 'managed' }>,
    appSessionId: string,
    engineSessionId?: string,
  ): boolean {
    if (!validUuid(appSessionId) || (engineSessionId !== undefined && !validUuid(engineSessionId))) return false
    try {
      const root = this.readRoot()
      if (!root || root.storageRootId !== binding.storageRootId || !this.resolve(binding).ok) return false
      if (!this.hasOwnership(binding.storageRootId, binding.storageId)) return false
      const path = this.ownershipPath(binding.storageRootId, binding.storageId)
      const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      const identities = Array.isArray(current.identities) ? current.identities.filter(isIdentity) : []
      const existing = identities.find(identity => identity.appSessionId === appSessionId)
      if (existing?.engineSessionId && engineSessionId && existing.engineSessionId !== engineSessionId) return false
      const next = existing ?? { appSessionId }
      if (engineSessionId !== undefined) next.engineSessionId = engineSessionId
      if (!existing) identities.push(next)
      current.identities = identities
      this.writeOwnershipRecord(path, current)
      return true
    } catch {
      // A ready frame is delivered on a fire-and-forget supervisor callback.
      // Filesystem failures must become a refusal, never an unhandled rejection.
      return false
    }
  }

  hasSessionIdentity(
    binding: Extract<SessionBinding, { kind: 'managed' }>,
    appSessionId: string,
    engineSessionId: string,
  ): boolean {
    if (!validUuid(engineSessionId) || !this.hasOwnership(binding.storageRootId, binding.storageId)) return false
    try {
      const owner = JSON.parse(readFileSync(this.ownershipPath(binding.storageRootId, binding.storageId), 'utf8')) as Record<string, unknown>
      return Array.isArray(owner.identities) && owner.identities.some((identity: unknown) =>
        isIdentity(identity) && identity.appSessionId === appSessionId && identity.engineSessionId === engineSessionId,
      )
    } catch {
      return false
    }
  }

  findByEngineSession(engineSessionId: string): { appSessionId: string; cwd: string; binding: Extract<SessionBinding, { kind: 'managed' }> } | undefined {
    if (!validUuid(engineSessionId)) return undefined
    const root = this.readRoot()
    if (!root) return undefined
    const dir = join(this.ownershipDir, root.storageRootId)
    let files: string[]
    try { files = readdirSync(dir) } catch { return undefined }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const storageId = file.slice(0, -5)
      if (!validUuid(storageId)) continue
      const path = this.ownershipPath(root.storageRootId, storageId)
      try {
        const st = lstatSync(path)
        if (!st.isFile() || st.isSymbolicLink()) continue
        const owner = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        if (owner.version !== 1 || owner.storageRootId !== root.storageRootId || owner.storageId !== storageId || !Array.isArray(owner.identities)) continue
        const identity = owner.identities.find((item: unknown) => isIdentity(item) && item.engineSessionId === engineSessionId)
        if (!identity) continue
        const binding = { kind: 'managed' as const, storageRootId: root.storageRootId, storageId }
        const expectedCwd = join(root.rootPath, storageId)
        try {
          const resolved = this.resolve(binding)
          if (resolved.ok) return { appSessionId: identity.appSessionId, cwd: resolved.cwd, binding }
          if (resolved.reason === 'missing') return { appSessionId: identity.appSessionId, cwd: expectedCwd, binding }
        } catch { continue }
      } catch { continue }
    }
    return undefined
  }

  recreate(binding: SessionBinding): ManagedStorageResolution {
    if (binding.kind !== 'managed' || !validUuid(binding.storageRootId) || !validUuid(binding.storageId)) {
      return { ok: false, reason: 'invalid' }
    }
    try {
      const root = this.readRoot()
      if (!root || root.storageRootId !== binding.storageRootId) return { ok: false, reason: 'invalid' }
      if (!this.hasOwnership(binding.storageRootId, binding.storageId)) return { ok: false, reason: 'invalid' }
      const target = join(root.rootPath, binding.storageId)
      try { lstatSync(target); return { ok: false, reason: 'invalid' } } catch (error) {
        if (!isNotFound(error)) return { ok: false, reason: 'invalid' }
      }
      mkdirSync(target, { recursive: false, mode: 0o700 })
      let cwd: string | null
      try { cwd = this.validatePath(target, root) } catch { cwd = null }
      if (cwd) {
        mkdirSync(join(cwd, 'tmp'), { recursive: false, mode: 0o700 })
        if (realpathSync(join(cwd, 'tmp')) !== join(cwd, 'tmp')) return { ok: false, reason: 'invalid' }
      }
      return cwd ? { ok: true, cwd, binding } : { ok: false, reason: 'invalid' }
    } catch {
      return { ok: false, reason: 'invalid' }
    }
  }

  private getOrCreateRoot(): RootRecord {
    mkdirSync(this.appDataBase, { recursive: true, mode: 0o700 })
    const existing = this.readRoot()
    if (existing) return existing
    const canonicalBase = realpathSync(this.appDataBase)
    const storageRootId = randomUUID()
    const rootPath = join(canonicalBase, 'Chat Files', storageRootId)
    mkdirSync(rootPath, { recursive: true, mode: 0o700 })
    const canonicalRoot = realpathSync(rootPath)
    if (!isContained(canonicalBase, canonicalRoot)) throw new Error('managed root escaped app data')
    const record = { version: 1 as const, storageRootId, rootPath: canonicalRoot }
    this.writeRoot(record, this.recordPath)
    this.rootRecord = record
    return record
  }

  private readRoot(): RootRecord | null {
    this.rootRecord = null
    let recordPath = this.recordPath
    try {
      lstatSync(recordPath)
    } catch (error) {
      if (!isNotFound(error)) throw error
      recordPath = this.legacyRecordPath
    }
    try {
      const st = lstatSync(recordPath)
      if (!st.isFile() || st.isSymbolicLink()) throw new Error('managed root record is not a regular file')
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
    const parsed: unknown = JSON.parse(readFileSync(recordPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid managed root record')
    const row = parsed as Record<string, unknown>
    if (row.version !== 1 || !validUuid(row.storageRootId) || typeof row.rootPath !== 'string') {
      throw new Error('invalid managed root record')
    }
    const canonicalBase = realpathSync(this.appDataBase)
    const expectedRoot = join(canonicalBase, 'Chat Files', row.storageRootId)
    // The original shared record belongs to whichever app profile created it.
    if (recordPath === this.legacyRecordPath && row.rootPath !== expectedRoot) return null
    const canonicalRoot = realpathSync(row.rootPath)
    if (!isContained(canonicalBase, canonicalRoot) || canonicalRoot !== row.rootPath || canonicalRoot !== expectedRoot) {
      throw new Error('managed root is outside app data or noncanonical')
    }
    const record: RootRecord = { version: 1, storageRootId: row.storageRootId, rootPath: canonicalRoot }
    this.rootRecord = record
    return record
  }

  private validatePath(path: string, root: RootRecord): string | null {
    const canonical = realpathSync(path)
    const canonicalRoot = realpathSync(root.rootPath)
    if (canonicalRoot !== root.rootPath || !isContained(canonicalRoot, canonical)) return null
    const expected = join(canonicalRoot, basenameUuid(path))
    if (canonical !== expected) return null
    if (!statSync(canonical).isDirectory()) return null
    return canonical
  }

  private validateTempPath(cwd: string): boolean {
    const tempPath = join(cwd, 'tmp')
    try {
      const st = lstatSync(tempPath)
      return st.isDirectory() && !st.isSymbolicLink() && realpathSync(tempPath) === tempPath
    } catch (error) {
      return isNotFound(error)
    }
  }

  private writeRoot(record: RootRecord, path: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 })
    const fileFd = openSync(temp, 'r')
    try { fsyncSync(fileFd) } finally { closeSync(fileFd) }
    renameSync(temp, path)
    const dirFd = openSync(dirname(path), 'r')
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
  }

  private hasOwnership(storageRootId: string, storageId: string): boolean {
    const path = this.ownershipPath(storageRootId, storageId)
    try {
      const st = lstatSync(path)
      if (!st.isFile() || st.isSymbolicLink()) return false
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return false
      const row = parsed as Record<string, unknown>
      return row.version === 1 && row.storageRootId === storageRootId && row.storageId === storageId
    } catch {
      return false
    }
  }

  private writeOwnership(storageRootId: string, storageId: string): void {
    const path = this.ownershipPath(storageRootId, storageId)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.writeOwnershipRecord(path, { version: 1, storageRootId, storageId, identities: [] })
  }

  private writeOwnershipRecord(path: string, record: Record<string, unknown>): void {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 })
    const fileFd = openSync(temp, 'r')
    try { fsyncSync(fileFd) } finally { closeSync(fileFd) }
    renameSync(temp, path)
    const dirFd = openSync(dirname(path), 'r')
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
  }

  private ownershipPath(storageRootId: string, storageId: string): string {
    if (!validUuid(storageRootId) || !validUuid(storageId)) throw new Error('invalid managed identity')
    return join(this.ownershipDir, storageRootId, `${storageId}.json`)
  }
}

function basenameUuid(path: string): string {
  const id = path.slice(path.lastIndexOf('/') + 1)
  if (!validUuid(id)) throw new Error('invalid storage id')
  return id
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isIdentity(value: unknown): value is { appSessionId: string; engineSessionId?: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    validUuid(String((value as Record<string, unknown>).appSessionId)) &&
    ((value as Record<string, unknown>).engineSessionId === undefined || validUuid(String((value as Record<string, unknown>).engineSessionId)))
}

function isContained(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
}
