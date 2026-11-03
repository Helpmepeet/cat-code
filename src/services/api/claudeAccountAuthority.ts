import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createHash, randomUUID } from 'crypto'
import { writeFileAtomicDurableSync } from '../../utils/atomicFile.js'
import { acquireMutationLockSync } from '../../utils/lockfile.js'
import { logForDebugging } from '../../utils/debug.js'

export type ClaudeCredentialHandle = Readonly<{ accountId: string; generation: number; revision: number }>
export type ClaudeAuthorityCredentials = {
  accessToken: string; refreshToken: string; expiresAt: number
  scopes?: string[]; subscriptionType?: string | null; rateLimitTier?: string | null
}
export type ClaudeAuthorityOutcome = 'committed' | 'persistence_pending' | 'uncertain' | 'rejected'
export type ClaudeAuthorityResult = {
  outcome: ClaudeAuthorityOutcome; operationId: string; restartRecoverable: boolean
  handle?: ClaudeCredentialHandle; reason?: string
  credentialCommitted?: boolean; selectionCommitted?: boolean; mirrorRepairPending?: boolean
}
/** Carries a persistence receipt only, never the issued credential payload. */
export class ClaudeLoginInstallationError extends Error {
  readonly result: Readonly<ClaudeAuthorityResult>
  constructor(result: ClaudeAuthorityResult) {
    super('Failed to save Claude sign-in. Restore vault access and retry saving.')
    this.name = 'ClaudeLoginInstallationError'
    this.result = Object.freeze({ ...result, handle: result.handle && Object.freeze({ ...result.handle }) })
  }
}
export type ClaudeRefreshClaim = Readonly<{
  handle: ClaudeCredentialHandle; operationId: string; ownerNonce: string
}>
export type ClaudeAuthorityRecord = {
  formatVersion: 1; accountId: string; stateSequence: number
  loginGeneration: number; credentialRevision: number
  state: 'active' | 'deleted' | 'migration_conflict'
  credentialDisposition: 'usable' | 'rejected' | 'uncertain'
  rejection?: 'access_rejected' | 'refresh_rejected'
  credentials?: ClaudeAuthorityCredentials; profile?: Record<string, unknown>
  operations: Record<string, { kind: string; generation: number; revision: number; fingerprint: string }>
  pendingLogin?: { operationId: string; generation: number; credentials: ClaudeAuthorityCredentials; profile: Record<string, unknown> }
  migration?: { legacyHash: string; lifecycleHash: string; complete: boolean }
  refreshIntent?: { operationId: string; ownerNonce: string; phase: 'prepared' | 'dispatched' | 'uncertain'; generation: number; revision: number }
}
export type ClaudeAuthorityRead =
  | { status: 'ready' | 'persistence_pending' | 'rejected' | 'uncertain' | 'deleted' | 'migration_conflict'; record: ClaudeAuthorityRecord; handle: ClaudeCredentialHandle }
  | { status: 'missing' | 'unsupported' | 'unavailable' | 'incompatible_writer' }

let vaultRoot = join(homedir(), 'claude-vault')
const pendingMutations = new Map<string, ClaudeAuthorityRecord>()
export function setClaudeAuthorityVaultPathForTest(path: string | undefined): void {
  const next = path ?? join(homedir(), 'claude-vault')
  if (next !== vaultRoot) pendingMutations.clear()
  vaultRoot = next
}
function diagnostic(id: string, kind: string, outcome: string, r?: ClaudeAuthorityRecord, operationId?: string): void {
  const safeKind = ['login', 'refresh', 'delete', 'migration', 'read', 'lock'].includes(kind) ? kind : 'mutation'
  logForDebugging(`[claude-authority] provider=anthropic accountRef=${fingerprint(id).slice(0, 16)} kind=${safeKind} outcome=${outcome} generation=${r?.loginGeneration ?? 'none'} revision=${r?.credentialRevision ?? 'none'} operationRef=${operationId ? fingerprint(operationId).slice(0, 16) : 'none'}`)
}
function paths(id: string) {
  if (!id || id.length > 128 || /[\\/\x00-\x1f]/.test(id)) throw new Error('Invalid Claude account identity')
  return { legacy: join(vaultRoot, 'accounts', `${id}.json`), authority: join(vaultRoot, 'authority-v1', `${id}.json`) }
}
/** Shared across config directories, and redirected with the authority in tests. */
export function getClaudeRefreshLockPath(accountId: string): string {
  return `${paths(accountId).authority}.refresh`
}
function handle(record: ClaudeAuthorityRecord): ClaudeCredentialHandle {
  return Object.freeze({ accountId: record.accountId, generation: record.loginGeneration, revision: record.credentialRevision })
}
function parse(path: string): any { return JSON.parse(readFileSync(path, 'utf8')) }
function fingerprint(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
  })
  return createHash('sha256').update(serialized).digest('hex')
}
function validCounter(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function validCredentials(c: ClaudeAuthorityCredentials | undefined): boolean {
  return !!c && typeof c.accessToken === 'string' && c.accessToken.length > 0 &&
    typeof c.refreshToken === 'string' && c.refreshToken.length > 0 && Number.isFinite(c.expiresAt) &&
    (c.subscriptionType === undefined || c.subscriptionType === null || typeof c.subscriptionType === 'string') &&
    (c.rateLimitTier === undefined || c.rateLimitTier === null || typeof c.rateLimitTier === 'string') &&
    (c.scopes === undefined || (Array.isArray(c.scopes) && c.scopes.every(s => typeof s === 'string')))
}
function validRecord(r: ClaudeAuthorityRecord, id: string): boolean {
  if (!r || r.accountId !== id || !validCounter(r.stateSequence) || !validCounter(r.loginGeneration) ||
      !validCounter(r.credentialRevision) || !r.operations || typeof r.operations !== 'object' || Array.isArray(r.operations) ||
      !['active', 'deleted', 'migration_conflict'].includes(r.state) ||
      !['usable', 'rejected', 'uncertain'].includes(r.credentialDisposition)) return false
  if (r.state === 'active' && !validCredentials(r.credentials)) return false
  if (r.state !== 'active' && r.credentials) return false
  if (r.rejection !== undefined && !['access_rejected', 'refresh_rejected'].includes(r.rejection)) return false
  if (r.state === 'active' && r.credentialDisposition === 'rejected' && !r.rejection) return false
  if (r.profile !== undefined && (!r.profile || typeof r.profile !== 'object' || Array.isArray(r.profile))) return false
  if (r.profile?.account_uuid !== undefined && r.profile.account_uuid !== id) return false
  if (r.profile?.email_address !== undefined && typeof r.profile.email_address !== 'string') return false
  for (const op of Object.values(r.operations)) {
    if (!op || typeof op.kind !== 'string' || typeof op.fingerprint !== 'string' ||
        !['migration', 'login_pending', 'login', 'refresh', 'delete', 'rejection'].includes(op.kind) ||
        !validCounter(op.generation) || !validCounter(op.revision)) return false
  }
  const intent = r.refreshIntent
  if (intent !== undefined && (!intent || typeof intent !== 'object' || typeof intent.operationId !== 'string' || !intent.operationId ||
      typeof intent.ownerNonce !== 'string' || !intent.ownerNonce ||
      !['prepared', 'dispatched', 'uncertain'].includes(intent.phase) ||
      intent.generation !== r.loginGeneration || intent.revision !== r.credentialRevision)) return false
  const pending = r.pendingLogin
  if (pending !== undefined && (!pending || typeof pending !== 'object' || typeof pending.operationId !== 'string' || !pending.operationId ||
      pending.generation !== r.loginGeneration + 1 || !validCredentials(pending.credentials) ||
      !pending.profile || typeof pending.profile !== 'object' || Array.isArray(pending.profile))) return false
  if (r.migration !== undefined && (!r.migration || typeof r.migration !== 'object' || typeof r.migration.legacyHash !== 'string' || typeof r.migration.lifecycleHash !== 'string' ||
      typeof r.migration.complete !== 'boolean')) return false
  return true
}
function readUnlocked(id: string): ClaudeAuthorityRead {
  const p = paths(id)
  if (!existsSync(p.authority)) {
    if (existsSync(p.legacy) && parse(p.legacy)?.claude_authority_version !== undefined) return { status: 'unavailable' }
    if (existsSync(`${p.legacy}.lifecycle`) && parse(`${p.legacy}.lifecycle`)?.authorityVersion !== undefined) return { status: 'unavailable' }
    return { status: 'missing' }
  }
  try {
    const r = parse(p.authority) as ClaudeAuthorityRecord
    if (r.formatVersion !== 1) return { status: 'unsupported' }
    if (!validRecord(r, id)) return { status: 'unavailable' }
    if (r.migration?.complete && (!existsSync(p.legacy) || !existsSync(`${p.legacy}.lifecycle`))) return { status: 'incompatible_writer' }
    // No legacy credential is ever imported once authority exists. A changed
    // barrier is evidence of an incompatible writer, not a newer login.
    if (existsSync(p.legacy)) {
      const legacy = parse(p.legacy)
      if (legacy.claude_authority_version !== 1 || legacy.tokens) return { status: 'incompatible_writer' }
    }
    if (existsSync(`${p.legacy}.lifecycle`)) {
      const fence = parse(`${p.legacy}.lifecycle`)
      if (fence.authorityVersion !== 1 || fence.deleted !== true || fence.generation !== Number.MAX_SAFE_INTEGER) return { status: 'incompatible_writer' }
    }
    const status = r.pendingLogin ? 'persistence_pending' : r.state !== 'active' ? r.state : r.credentialDisposition === 'usable' ? 'ready' : r.credentialDisposition
    return { status, record: r, handle: handle(r) }
  } catch { return { status: 'unavailable' } }
}
/** Read-only: never migrates, repairs, or creates directories. */
export function readClaudeAccountAuthority(accountId: string): ClaudeAuthorityRead {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return { status: 'unavailable' }
  try {
    const read = readUnlocked(accountId)
    if (!['ready', 'missing'].includes(read.status)) diagnostic(accountId, 'read', read.status)
    return read
  } catch { diagnostic(accountId, 'read', 'unavailable'); return { status: 'unavailable' } }
}
let tryKernelGuard: ((fd: number) => boolean) | undefined
/** The persistent guard inode is never unlinked. Suspension cannot expire flock. */
export function acquireClaudeAccountMutationLock(id: string, waitMs = 10_000): () => void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Claude account authority requires macOS or Linux kernel locking')
  if (!tryKernelGuard) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffi = require('bun:ffi') as typeof import('bun:ffi')
    const errnoName = process.platform === 'darwin' ? '__error' : '__errno_location'
    const library = ffi.dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
      flock: { args: ['i32', 'i32'], returns: 'i32' },
      [errnoName]: { args: [], returns: 'ptr' },
    } as const)
    tryKernelGuard = fd => {
      if (library.symbols.flock(fd, 2 | 4) === 0) return true
      const ptr = library.symbols[errnoName]()
      const errno = ptr ? ffi.read.i32(ptr) : undefined
      if (errno === (process.platform === 'darwin' ? 35 : 11) || errno === 4) return false
      throw new Error(`Claude account guard failed (errno ${errno})`)
    }
  }
  const p = paths(id)
  mkdirSync(join(vaultRoot, 'accounts'), { recursive: true, mode: 0o700 })
  chmodSync(join(vaultRoot, 'accounts'), 0o700)
  const fd = openSync(`${p.legacy}.authority.guard`, 'a', 0o600)
  const deadline = Date.now() + waitMs
  try {
    while (!tryKernelGuard(fd)) {
      if (Date.now() >= deadline) throw Object.assign(new Error('Claude account authority is locked'), { code: 'ELOCKED' })
      Bun.sleepSync(20)
    }
    // Keep coordinating with legacy vault writers during migration. The kernel
    // guard, not this time-based compatibility lease, owns publication safety.
    const release = acquireMutationLockSync(p.legacy, { label: '[claude-authority]', waitMs })
    return () => {
      try { release() } catch { diagnostic(id, 'lock', 'cleanup_failed') }
      finally { closeSync(fd) }
    }
  } catch (error) { closeSync(fd); throw error }
}
function locked<T>(id: string, fn: () => T): T {
  const release = acquireClaudeAccountMutationLock(id)
  try { return fn() } finally {
    // Unlock failure cannot undo a durably committed operation.
    try { release() } catch { diagnostic(id, 'lock', 'cleanup_failed') }
  }
}
function write(record: ClaudeAuthorityRecord): void {
  mkdirSync(join(vaultRoot, 'authority-v1'), { recursive: true, mode: 0o700 })
  chmodSync(join(vaultRoot, 'authority-v1'), 0o700)
  writeFileAtomicDurableSync(paths(record.accountId).authority, JSON.stringify(record) + '\n', { mode: 0o600 })
}
function barrier(id: string): void {
  const p = paths(id)
  writeFileAtomicDurableSync(p.legacy, JSON.stringify({ claude_authority_version: 1 }) + '\n', { mode: 0o600 })
  writeFileAtomicDurableSync(`${p.legacy}.lifecycle`, JSON.stringify({ generation: Number.MAX_SAFE_INTEGER, deleted: true, authorityVersion: 1 }) + '\n', { mode: 0o600 })
}
function blank(id: string, generation = 0): ClaudeAuthorityRecord {
  return { formatVersion: 1, accountId: id, stateSequence: 0, loginGeneration: generation, credentialRevision: 0,
    state: 'deleted', credentialDisposition: 'rejected', operations: {} }
}
/** Rollout requires old writers stopped. Resume cleanup only for a known migration. */
export function migrateClaudeAccountAuthority(accountId: string, configOnly?: { credentials: ClaudeAuthorityCredentials; profile: Record<string, unknown> }): ClaudeAuthorityRead {
  return locked(accountId, () => {
    const p = paths(accountId)
    if (existsSync(p.authority)) {
      const r = parse(p.authority) as ClaudeAuthorityRecord
      if (r.formatVersion === 1 && validRecord(r, accountId) && r.migration && !r.migration.complete) {
        const legacy = existsSync(p.legacy) ? parse(p.legacy) : null
        const lifecycle = existsSync(`${p.legacy}.lifecycle`) ? parse(`${p.legacy}.lifecycle`) : null
        const legacyOkay = fingerprint(legacy) === r.migration.legacyHash ||
          (legacy?.claude_authority_version === 1 && !legacy.tokens)
        const lifecycleOkay = fingerprint(lifecycle) === r.migration.lifecycleHash ||
          (lifecycle?.authorityVersion === 1 && lifecycle.deleted === true && lifecycle.generation === Number.MAX_SAFE_INTEGER)
        if (legacyOkay && lifecycleOkay) {
          barrier(accountId); r.migration.complete = true; write(r)
        }
      }
      return readUnlocked(accountId)
    }
    const prior = readUnlocked(accountId)
    if (prior.status !== 'missing') return prior
    const legacy = existsSync(p.legacy) ? parse(p.legacy) : null
    const lifecycle = existsSync(`${p.legacy}.lifecycle`) ? parse(`${p.legacy}.lifecycle`) : { generation: 0, deleted: false }
    if (!validCounter(lifecycle.generation) || typeof lifecycle.deleted !== 'boolean') throw new Error('Invalid legacy lifecycle')
    const r = blank(accountId, lifecycle.generation)
    if (!legacy && !existsSync(`${p.legacy}.lifecycle`) && configOnly) {
      r.state = 'active'; r.credentialDisposition = 'usable'
      r.credentials = configOnly.credentials; r.profile = configOnly.profile
    }
    if (!lifecycle.deleted && legacy) {
      if (legacy.profile?.account_uuid === accountId && typeof legacy.profile?.email_address === 'string') r.profile = {
        ...legacy.profile, ...(typeof legacy.alias === 'string' ? { alias: legacy.alias } : {}),
      }
      if ((legacy.lifecycle_generation ?? 0) !== lifecycle.generation || legacy.profile?.account_uuid !== accountId ||
          typeof legacy.tokens?.access_token !== 'string' || typeof legacy.tokens?.refresh_token !== 'string') r.state = 'migration_conflict'
      else {
        r.state = 'active'; r.credentialDisposition = 'usable'
        r.credentials = { accessToken: legacy.tokens.access_token, refreshToken: legacy.tokens.refresh_token,
          expiresAt: legacy.tokens.expires_at ?? 0, scopes: legacy.tokens.scopes,
          subscriptionType: legacy.tokens.subscription_type, rateLimitTier: legacy.tokens.rate_limit_tier }
      }
    }
    r.migration = { legacyHash: fingerprint(legacy),
      lifecycleHash: fingerprint(existsSync(`${p.legacy}.lifecycle`) ? lifecycle : null), complete: false }
    r.operations.migration = { kind: 'migration', generation: r.loginGeneration, revision: 0, fingerprint: '' }
    if (!validRecord(r, accountId)) throw new Error('Invalid legacy Claude account state')
    write(r); barrier(accountId); r.migration.complete = true; write(r)
    diagnostic(accountId, 'migration', r.state, r)
    return readUnlocked(accountId)
  })
}
function result(operationId: string, outcome: ClaudeAuthorityOutcome, r?: ClaudeAuthorityRecord, reason?: string): ClaudeAuthorityResult {
  return { operationId, outcome, restartRecoverable: outcome === 'committed', handle: r && handle(r), reason }
}
function matches(r: ClaudeAuthorityRecord, h: ClaudeCredentialHandle): boolean {
  return r.accountId === h.accountId && r.loginGeneration === h.generation && r.credentialRevision === h.revision
}
function mutate(id: string, operationId: string, fn: (r: ClaudeAuthorityRecord) => string | void): ClaudeAuthorityResult {
  try {
    return locked(id, () => {
      const read = readUnlocked(id)
      if (!('record' in read)) return result(operationId, 'rejected', undefined, read.status)
      const r = structuredClone(read.record)
      const reason = fn(r)
      if (reason) {
        diagnostic(id, 'mutation', 'rejected', r, operationId)
        return result(operationId, 'rejected', r, reason)
      }
      if (!validRecord(r, id)) return result(operationId, 'rejected', undefined, 'invalid_state')
      // Retire known in-memory login reservations durably when a newer
      // generation wins. A restart must not turn their operation IDs into new
      // logins simply because their initial staging write never reached disk.
      for (const [key, pending] of pendingMutations) {
        if (pending.accountId !== id || key === `${id}:${operationId}`) continue
        const oldOperationId = key.slice(id.length + 1)
        const old = pending.operations[oldOperationId]
        if (old && (old.kind === 'login_pending' || old.kind === 'login') &&
            old.generation <= r.loginGeneration && !r.operations[oldOperationId]) {
          r.operations[oldOperationId] = { ...old, kind: 'login_pending' }
        }
      }
      r.stateSequence++
      try {
        write(r)
        pendingMutations.delete(`${id}:${operationId}`)
        for (const [key, pending] of pendingMutations) {
          const pendingKind = pending.operations[key.slice(id.length + 1)]?.kind
          if (pendingKind === 'login_pending' || pendingKind === 'login') continue
          if (pending.accountId === id && (pending.loginGeneration < r.loginGeneration ||
              (pending.loginGeneration === r.loginGeneration && pending.credentialRevision < r.credentialRevision))) pendingMutations.delete(key)
        }
        diagnostic(id, r.operations[operationId]?.kind ?? (r.refreshIntent ? 'refresh' : r.pendingLogin ? 'login' : 'mutation'), 'committed', r, operationId)
        return result(operationId, 'committed', r)
      }
      catch {
        pendingMutations.set(`${id}:${operationId}`, r)
        diagnostic(id, 'mutation', 'persistence_pending', r, operationId)
        return result(operationId, 'persistence_pending', r)
      }
    })
  } catch { return result(operationId, 'persistence_pending') }
}
export function isClaudeCredentialReady(h: ClaudeCredentialHandle): boolean {
  const r = readClaudeAccountAuthority(h.accountId)
  return r.status === 'ready' && matches(r.record, h)
}
export function captureClaudeCredentialHandle(accountId: string, accessToken: string): ClaudeCredentialHandle | null {
  const r = readClaudeAccountAuthority(accountId)
  return r.status === 'ready' && r.record.credentials?.accessToken === accessToken ? r.handle : null
}
export function withClaudeCredentialSend<T>(h: ClaudeCredentialHandle, initiate: () => T): T | null {
  return locked(h.accountId, () => isClaudeCredentialReady(h) ? initiate() : null)
}
export function rejectClaudeCredential(h: ClaudeCredentialHandle, operationId: string = randomUUID(), reason = 'credential_rejected'): ClaudeAuthorityResult {
  return mutate(h.accountId, operationId, r => {
    if (!matches(r, h)) return 'superseded'
    r.credentialDisposition = 'rejected'
    r.rejection = reason === 'invalid_grant' || reason === 'refresh_rejected' ? 'refresh_rejected' : 'access_rejected'
    r.operations[operationId] = { kind: 'rejection', generation: h.generation, revision: h.revision, fingerprint: '' }
  })
}
export function claimClaudeRefresh(h: ClaudeCredentialHandle, operationId: string, ownerNonce: string): ClaudeAuthorityResult & { claim?: ClaudeRefreshClaim } {
  const out = mutate(h.accountId, operationId, r => {
    if (!matches(r, h) || r.state !== 'active' || r.pendingLogin ||
        (r.credentialDisposition !== 'usable' && !(r.credentialDisposition === 'rejected' && r.rejection === 'access_rejected'))) return 'unavailable'
    if (r.refreshIntent && (r.refreshIntent.operationId !== operationId || r.refreshIntent.ownerNonce !== ownerNonce)) return 'owned'
    r.refreshIntent ??= { operationId, ownerNonce, phase: 'prepared', generation: h.generation, revision: h.revision }
  })
  return { ...out, claim: out.outcome === 'committed' ? Object.freeze({ handle: Object.freeze({ ...h }), operationId, ownerNonce }) : undefined }
}
function checkClaim(r: ClaudeAuthorityRecord, c: ClaudeRefreshClaim): boolean {
  return matches(r, c.handle) && r.refreshIntent?.operationId === c.operationId && r.refreshIntent.ownerNonce === c.ownerNonce
}
/** Persist dispatched BEFORE calling network; failure means do not send. */
export function markClaudeRefreshDispatched(c: ClaudeRefreshClaim): ClaudeAuthorityResult {
  return mutate(c.handle.accountId, c.operationId, r => {
    if (!checkClaim(r, c) || r.refreshIntent!.phase !== 'prepared' || r.rejection === 'refresh_rejected') return 'unavailable'
    r.refreshIntent!.phase = 'dispatched'
  })
}
/** The network callback starts synchronously under the exact account lock. */
export function startClaudeRefreshDispatch<T>(c: ClaudeRefreshClaim, initiate: () => T): { result: ClaudeAuthorityResult; started?: T } {
  return locked(c.handle.accountId, () => {
    const read = readUnlocked(c.handle.accountId)
    if (!('record' in read) || !checkClaim(read.record, c) || read.record.refreshIntent!.phase !== 'prepared' ||
        read.record.rejection === 'refresh_rejected') {
      return { result: result(c.operationId, 'rejected', undefined, 'unavailable') }
    }
    const r = structuredClone(read.record)
    r.refreshIntent!.phase = 'dispatched'; r.stateSequence++
    try { write(r) } catch { return { result: result(c.operationId, 'persistence_pending', r) } }
    return { result: result(c.operationId, 'committed', r), started: initiate() }
  })
}
export function completeClaudeRefresh(c: ClaudeRefreshClaim, credentials: ClaudeAuthorityCredentials): ClaudeAuthorityResult {
  return publishRefresh(c, credentials, false)
}
function publishRefresh(c: ClaudeRefreshClaim, credentials: ClaudeAuthorityCredentials, reconciliation: boolean): ClaudeAuthorityResult {
  return mutate(c.handle.accountId, c.operationId, r => {
    const receipt = r.operations[c.operationId]
    if (receipt) return receipt.kind === 'refresh' && receipt.generation === r.loginGeneration &&
      receipt.revision === r.credentialRevision && receipt.fingerprint === fingerprint(credentials) ? undefined : 'operation_conflict'
    if (!checkClaim(r, c) || r.state !== 'active' || r.rejection === 'refresh_rejected') return 'superseded'
    if (!validCredentials(credentials)) return 'invalid_credentials'
    if (!reconciliation && (r.refreshIntent!.phase !== 'dispatched' || r.credentialDisposition === 'uncertain')) return 'reconciliation_required'
    r.credentials = credentials; r.credentialRevision++; r.credentialDisposition = 'usable'; delete r.refreshIntent; delete r.rejection
    r.operations[c.operationId] = { kind: 'refresh', generation: r.loginGeneration, revision: r.credentialRevision, fingerprint: fingerprint(credentials) }
  })
}
export function finishClaudeRefreshNotSent(c: ClaudeRefreshClaim): ClaudeAuthorityResult {
  return mutate(c.handle.accountId, c.operationId, r => {
    if (!checkClaim(r, c)) return 'superseded'
    delete r.refreshIntent
  })
}
export function markClaudeRefreshUncertain(c: ClaudeRefreshClaim, _reason?: string): ClaudeAuthorityResult {
  return mutate(c.handle.accountId, c.operationId, r => {
    if (!checkClaim(r, c)) return 'superseded'
    r.refreshIntent!.phase = 'uncertain'; r.credentialDisposition = 'uncertain'
  })
}
export function reconcileClaudeRefresh(accountId: string, operationId: string,
  issued?: { claim: ClaudeRefreshClaim; credentials: ClaudeAuthorityCredentials }): ClaudeAuthorityResult {
  if (issued) {
    if (issued.claim.handle.accountId !== accountId || issued.claim.operationId !== operationId) {
      return result(operationId, 'rejected', undefined, 'identity_mismatch')
    }
    return publishRefresh(issued.claim, issued.credentials, true)
  }
  const read = readClaudeAccountAuthority(accountId)
  if (!('record' in read)) return result(operationId, 'rejected', undefined, read.status)
  const receipt = read.record.operations[operationId]
  if (receipt) return mutate(accountId, operationId, r => {
    const current = r.operations[operationId]
    if (!current || current.kind !== 'refresh' || current.generation !== r.loginGeneration ||
        current.revision !== r.credentialRevision) return 'superseded'
  })
  return result(operationId, 'uncertain', read.record, 'No committed refresh receipt')
}
export function commitClaudeLogin(accountId: string, operationId: string, credentials: ClaudeAuthorityCredentials, profile: Record<string, unknown>): ClaudeAuthorityResult {
  if (!operationId || !validCredentials(credentials)) return result(operationId, 'rejected', undefined, 'invalid_input')
  const pending = pendingMutations.get(`${accountId}:${operationId}`)
  if (pending) {
    const receipt = pending.operations[operationId]
    if (!receipt || !['login', 'login_pending'].includes(receipt.kind) ||
        receipt.fingerprint !== fingerprint({ credentials, profile })) {
      return result(operationId, 'rejected', undefined, 'operation_conflict')
    }
    return retryClaudeAuthorityPersistence(accountId, operationId)
  }
  try { migrateClaudeAccountAuthority(accountId) } catch { return result(operationId, 'persistence_pending') }
  const staged = mutate(accountId, operationId, r => {
    const digest = fingerprint({ credentials, profile })
    const prior = r.operations[operationId]
    if (prior) {
      if (prior.fingerprint !== digest) return 'operation_conflict'
      if (prior.kind === 'login') return prior.generation === r.loginGeneration ? undefined : 'superseded'
      if (prior.kind !== 'login_pending' || prior.generation !== r.loginGeneration + 1 ||
          r.pendingLogin?.operationId !== operationId) return 'superseded'
    }
    if (r.pendingLogin && r.pendingLogin.operationId === operationId) {
      if (fingerprint({ credentials: r.pendingLogin.credentials, profile: r.pendingLogin.profile }) !== digest) return 'operation_conflict'
      return
    }
    r.pendingLogin = { operationId, generation: r.loginGeneration + 1, credentials, profile }
    r.operations[operationId] = { kind: 'login_pending', generation: r.loginGeneration + 1, revision: 0, fingerprint: digest }
  })
  if (staged.outcome !== 'committed') return staged
  return retryClaudeAuthorityPersistence(accountId, operationId)
}
export function retryClaudeAuthorityPersistence(accountId: string, operationId: string): ClaudeAuthorityResult {
  const pending = pendingMutations.get(`${accountId}:${operationId}`)
  if (pending) {
    const receipt = pending.operations[operationId]
    const login = pending.pendingLogin?.operationId === operationId ? pending.pendingLogin :
      receipt?.kind === 'login' && pending.credentials && pending.profile
        ? { operationId, generation: receipt.generation, credentials: pending.credentials, profile: pending.profile }
        : undefined
    try {
      const replay = locked(accountId, () => {
        const read = readUnlocked(accountId)
        if (login) {
          if (!('record' in read)) return result(operationId, 'rejected', undefined, 'superseded')
          const current = structuredClone(read.record)
          const existing = current.operations[operationId]
          if (existing?.kind === 'login' && existing.generation === current.loginGeneration &&
              existing.generation === login.generation && existing.fingerprint === receipt?.fingerprint) {
            write(current)
            return result(operationId, 'committed', current)
          }
          if (current.loginGeneration !== login.generation - 1 ||
              (current.pendingLogin && current.pendingLogin.operationId !== operationId)) {
            return result(operationId, 'rejected', undefined, 'superseded')
          }
          if (existing && (existing.kind !== 'login_pending' || existing.generation !== login.generation ||
              existing.fingerprint !== receipt?.fingerprint)) return result(operationId, 'rejected', undefined, 'operation_conflict')
          // Refresh and metadata changes do not supersede a login reservation.
          // Merge only that reservation, preserving the current credential and
          // operation ledger until the subsequent atomic login commit.
          current.pendingLogin = structuredClone(login)
          current.operations[operationId] = { kind: 'login_pending', generation: login.generation,
            revision: 0, fingerprint: receipt!.fingerprint }
          current.stateSequence++
          if (!validRecord(current, accountId)) return result(operationId, 'rejected', undefined, 'invalid_state')
          write(current)
          return result(operationId, 'committed', current)
        }
        if (!('record' in read) || (read.record.stateSequence !== pending.stateSequence - 1 &&
            JSON.stringify(read.record) !== JSON.stringify(pending))) return result(operationId, 'rejected', undefined, 'superseded')
        write(pending)
        return result(operationId, 'committed', pending)
      })
      if (replay.outcome === 'rejected') return replay
      pendingMutations.delete(`${accountId}:${operationId}`)
      if (!login) return replay
    } catch { return result(operationId, 'persistence_pending', pending) }
  }
  const out = mutate(accountId, operationId, r => {
    const receipt = r.operations[operationId]
    if (receipt && receipt.kind !== 'login_pending') return receipt.generation === r.loginGeneration &&
      (receipt.kind === 'login' || receipt.revision === r.credentialRevision) ? undefined : 'superseded'
    const pending = r.pendingLogin
    if (!pending || pending.operationId !== operationId || pending.generation !== r.loginGeneration + 1) return 'superseded'
    r.loginGeneration = pending.generation; r.credentialRevision = 0; r.state = 'active'; r.credentialDisposition = 'usable'
    r.credentials = pending.credentials; r.profile = pending.profile; delete r.refreshIntent; delete r.pendingLogin; delete r.rejection
    r.operations[operationId] = { kind: 'login', generation: r.loginGeneration, revision: 0,
      fingerprint: fingerprint({ credentials: pending.credentials, profile: pending.profile }) }
  })
  if (out.outcome === 'persistence_pending') {
    const read = readClaudeAccountAuthority(accountId)
    out.restartRecoverable = 'record' in read && (read.record.pendingLogin?.operationId === operationId || !!read.record.operations[operationId])
  }
  return out
}
export function deleteClaudeAccountAuthority(h: ClaudeCredentialHandle, operationId: string = randomUUID()): ClaudeAuthorityResult {
  return mutate(h.accountId, operationId, r => {
    if (r.operations[operationId]?.kind === 'delete') return r.operations[operationId]!.generation === r.loginGeneration ? undefined : 'superseded'
    if (!matches(r, h)) return 'superseded'
    r.loginGeneration++; r.credentialRevision = 0; r.state = 'deleted'; r.credentialDisposition = 'rejected'
    delete r.credentials; delete r.profile; delete r.refreshIntent; delete r.pendingLogin; delete r.rejection
    r.operations[operationId] = { kind: 'delete', generation: r.loginGeneration, revision: 0, fingerprint: '' }
  })
}
export function updateClaudeAuthorityProfile(h: ClaudeCredentialHandle, updates: Record<string, unknown>): ClaudeAuthorityResult {
  return mutate(h.accountId, randomUUID(), r => {
    if (!matches(r, h) || r.state !== 'active') return 'superseded'
    r.profile = { ...r.profile, ...updates }
  })
}
/** Safe to project to account UI; never exposes tokens or refresh ownership. */
export function getClaudeAuthorityAvailability(accountId: string): {
  accountId: string; status: ClaudeAuthorityRead['status']; loginGeneration?: number; credentialRevision?: number
} {
  const read = readClaudeAccountAuthority(accountId)
  return { accountId, status: read.status, ...('handle' in read
    ? { loginGeneration: read.handle.generation, credentialRevision: read.handle.revision } : {}) }
}
