import { randomUUID } from 'crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
} from 'fs'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { writeFileAtomicDurableSync } from '../../utils/atomicFile.js'
import { acquireMutationLockSync } from '../../utils/lockfile.js'
import { join, resolve } from 'path'

export const CODEX_CREDENTIAL_LIFECYCLE_VERSION = 1 as const
export const CODEX_CREDENTIAL_LIFECYCLE_DIRECTORY = 'codex-credential-lifecycle'

export type CodexCredentialLifecycleState =
  | 'login_prepared'
  | 'credentialed'
  | 'signed_out'
  | 'reauth_required'

export type CodexCredentialLifecycleOperationKind =
  | 'legacy_bootstrap'
  | 'login'
  | 'sign_out'
  | 'delete'
  | 'refresh'

export type CodexCredentialLifecycleCleanup = 'pending' | 'complete'

export type CodexCredentialLifecycleRecord = Readonly<{
  version: typeof CODEX_CREDENTIAL_LIFECYCLE_VERSION
  accountId: string
  credentialGeneration: number
  state: CodexCredentialLifecycleState
  operationId: string
  operationKind: CodexCredentialLifecycleOperationKind
  cleanup?: CodexCredentialLifecycleCleanup
  changedAt: string
}>

/**
 * This is the value later credential writers should carry beside tokens. The
 * lifecycle store intentionally does not receive or inspect those tokens.
 */
export type CodexCredentialBinding = Readonly<{
  accountId: string
  credentialGeneration: number
}>

export type CodexCredentialLifecycleReadResult =
  | { status: 'absent' }
  | {
      status: 'valid'
      record: CodexCredentialLifecycleRecord
    }
  | { status: 'malformed' }
  | { status: 'unreadable' }

export type CodexCredentialLifecycleSupersededReason =
  | 'missing'
  | 'state_mismatch'
  | 'generation_mismatch'
  | 'operation_mismatch'
  | 'cleanup_mismatch'
  | 'permit_mismatch'

export type CodexCredentialLifecycleTransitionResult =
  | {
      status: 'applied'
      changed: true
      record: CodexCredentialLifecycleRecord
    }
  | {
      status: 'applied'
      changed: false
      record: CodexCredentialLifecycleRecord
    }
  | {
      status: 'superseded'
      reason: CodexCredentialLifecycleSupersededReason
      record?: CodexCredentialLifecycleRecord
    }
  | {
      status: 'no_action'
      record?: CodexCredentialLifecycleRecord
    }

export type CodexCredentialLifecycleErrorCode =
  | 'invalid_account_id'
  | 'invalid_operation_id'
  | 'invalid_transition'
  | 'malformed_state'
  | 'unreadable_state'
  | 'generation_exhausted'
  | 'storage_unavailable'
  | 'lock_unavailable'
  | 'invalid_permit'

export class CodexCredentialLifecycleError extends Error {
  readonly code: CodexCredentialLifecycleErrorCode

  constructor(code: CodexCredentialLifecycleErrorCode) {
    super(messageForErrorCode(code))
    this.name = 'CodexCredentialLifecycleError'
    this.code = code
  }
}

export type CodexCredentialLifecyclePaths = Readonly<{
  directory: string
  recordPath: string
  lockPath: string
}>

export type CodexCredentialLifecycleOptions = Readonly<{
  /**
   * The directory containing lifecycle records. Production defaults to the
   * engine config directory, while tests provide a temporary directory.
   */
  directory?: string
  lockWaitMs?: number
}>

export type CodexCredentialLifecycleTransactionOptions = Readonly<{
  operationKind: CodexCredentialLifecycleOperationKind
  operationId?: string
}>

export type CodexCredentialLegacyBootstrapOptions = Readonly<{
  validatedUntaggedLegacyCredentials: true
}>

export type CodexCredentialGenerationOptions = Readonly<{
  expectedGeneration: number
}>

export type CodexCredentialCleanupOperationKind = 'sign_out' | 'delete'

export type CodexCredentialCleanupExpectation = Readonly<{
  accountId: string
  credentialGeneration: number
  operationId: string
  operationKind: CodexCredentialCleanupOperationKind
}>

export type CodexCredentialLifecycleRecoveryResult =
  | {
      status: 'pending'
      cleanup: CodexCredentialCleanupExpectation
    }
  | {
      status: 'complete'
      cleanup: CodexCredentialCleanupExpectation
      record: CodexCredentialLifecycleRecord
    }
  | {
      status: 'no_action'
      record?: CodexCredentialLifecycleRecord
    }

declare const credentialLifecyclePermitBrand: unique symbol

/**
 * A permit can only be obtained from `withTransaction`. Its fields are kept
 * private so an operation cannot be called without the lock held by that
 * transaction.
 */
export type CodexCredentialLifecyclePermit = {
  readonly [credentialLifecyclePermitBrand]: 'CodexCredentialLifecyclePermit'
}

export interface CodexCredentialLifecycle {
  read(accountId: string): CodexCredentialLifecycleReadResult
  getPaths(accountId: string): CodexCredentialLifecyclePaths
  withTransaction<T>(
    accountId: string,
    options: CodexCredentialLifecycleTransactionOptions,
    callback: (
      permit: CodexCredentialLifecyclePermit,
    ) => T | Promise<T>,
  ): Promise<T>
  legacyBootstrap(
    permit: CodexCredentialLifecyclePermit,
    options: CodexCredentialLegacyBootstrapOptions,
  ): CodexCredentialLifecycleTransitionResult
  prepareLogin(
    permit: CodexCredentialLifecyclePermit,
  ): CodexCredentialLifecycleTransitionResult
  commitLogin(
    permit: CodexCredentialLifecyclePermit,
    options: CodexCredentialGenerationOptions,
  ): CodexCredentialLifecycleTransitionResult
  signOut(
    permit: CodexCredentialLifecyclePermit,
    options: CodexCredentialGenerationOptions,
  ): CodexCredentialLifecycleTransitionResult
  completeCleanup(
    permit: CodexCredentialLifecyclePermit,
    expected: CodexCredentialCleanupExpectation,
  ): CodexCredentialLifecycleTransitionResult
  markReauthRequired(
    permit: CodexCredentialLifecyclePermit,
    options: CodexCredentialGenerationOptions,
  ): CodexCredentialLifecycleTransitionResult
  deleteAccount(
    permit: CodexCredentialLifecyclePermit,
    options: CodexCredentialGenerationOptions,
  ): CodexCredentialLifecycleTransitionResult
  recover(
    permit: CodexCredentialLifecyclePermit,
  ): CodexCredentialLifecycleRecoveryResult
}

type PermitDetails = {
  readonly accountId: string
  readonly operationId: string
  readonly operationKind: CodexCredentialLifecycleOperationKind
}

const MAX_IDENTIFIER_LENGTH = 128
const DEFAULT_LOCK_WAIT_MS = 30_000
const ALLOWED_RECORD_KEYS = new Set([
  'version',
  'accountId',
  'credentialGeneration',
  'state',
  'operationId',
  'operationKind',
  'cleanup',
  'changedAt',
])
const LIFECYCLE_STATES = new Set<CodexCredentialLifecycleState>([
  'login_prepared',
  'credentialed',
  'signed_out',
  'reauth_required',
])
const OPERATION_KINDS = new Set<CodexCredentialLifecycleOperationKind>([
  'legacy_bootstrap',
  'login',
  'sign_out',
  'delete',
  'refresh',
])

function messageForErrorCode(code: CodexCredentialLifecycleErrorCode): string {
  switch (code) {
    case 'invalid_account_id':
      return 'Codex credential lifecycle account identifier is invalid.'
    case 'invalid_operation_id':
      return 'Codex credential lifecycle operation identifier is invalid.'
    case 'invalid_transition':
      return 'Codex credential lifecycle transition is invalid.'
    case 'malformed_state':
      return 'Codex credential lifecycle state is malformed.'
    case 'unreadable_state':
      return 'Codex credential lifecycle state is unreadable.'
    case 'generation_exhausted':
      return 'Codex credential lifecycle generation cannot advance.'
    case 'storage_unavailable':
      return 'Codex credential lifecycle storage is unavailable.'
    case 'lock_unavailable':
      return 'Codex credential lifecycle lock is unavailable.'
    case 'invalid_permit':
      return 'Codex credential lifecycle permit is invalid or expired.'
  }
}

function throwLifecycleError(code: CodexCredentialLifecycleErrorCode): never {
  throw new CodexCredentialLifecycleError(code)
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function assertAccountId(accountId: string): void {
  if (!isIdentifier(accountId)) {
    throwLifecycleError('invalid_account_id')
  }
}

function assertOperationId(operationId: string): void {
  if (!isIdentifier(operationId)) {
    throwLifecycleError('invalid_operation_id')
  }
}

function isCleanupOperationKind(
  operationKind: unknown,
): operationKind is CodexCredentialCleanupOperationKind {
  return operationKind === 'sign_out' || operationKind === 'delete'
}

function assertGeneration(generation: number): void {
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0
  ) {
    throwLifecycleError('invalid_transition')
  }
}

function getExpectedGeneration(
  options: CodexCredentialGenerationOptions,
): number {
  if (!options || typeof options !== 'object') {
    throwLifecycleError('invalid_transition')
  }
  assertGeneration(options.expectedGeneration)
  return options.expectedGeneration
}

function nextGeneration(
  current: CodexCredentialLifecycleRecord | undefined,
): number {
  const generation = current?.credentialGeneration ?? 0
  if (generation >= Number.MAX_SAFE_INTEGER) {
    throwLifecycleError('generation_exhausted')
  }
  return generation + 1
}

function encodeAccountId(accountId: string): string {
  return Buffer.from(accountId, 'utf8').toString('base64url')
}

function makeRecord(input: {
  accountId: string
  credentialGeneration: number
  state: CodexCredentialLifecycleState
  operationId: string
  operationKind: CodexCredentialLifecycleOperationKind
  cleanup?: CodexCredentialLifecycleCleanup
}): CodexCredentialLifecycleRecord {
  const record = {
    version: CODEX_CREDENTIAL_LIFECYCLE_VERSION,
    accountId: input.accountId,
    credentialGeneration: input.credentialGeneration,
    state: input.state,
    operationId: input.operationId,
    operationKind: input.operationKind,
    ...(input.cleanup === undefined ? {} : { cleanup: input.cleanup }),
    changedAt: new Date().toISOString(),
  }
  return Object.freeze(record)
}

function isValidRecord(
  value: unknown,
  accountId: string,
): value is CodexCredentialLifecycleRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const data = value as Record<string, unknown>
  for (const key of Object.keys(data)) {
    if (!ALLOWED_RECORD_KEYS.has(key)) return false
  }
  if (
    data.version !== CODEX_CREDENTIAL_LIFECYCLE_VERSION ||
    data.accountId !== accountId ||
    !isIdentifier(data.accountId) ||
    !Number.isSafeInteger(data.credentialGeneration) ||
    (data.credentialGeneration as number) < 0 ||
    typeof data.state !== 'string' ||
    !LIFECYCLE_STATES.has(data.state as CodexCredentialLifecycleState) ||
    typeof data.operationId !== 'string' ||
    !isIdentifier(data.operationId) ||
    typeof data.operationKind !== 'string' ||
    !OPERATION_KINDS.has(
      data.operationKind as CodexCredentialLifecycleOperationKind,
    ) ||
    typeof data.changedAt !== 'string' ||
    !Number.isFinite(Date.parse(data.changedAt))
  ) {
    return false
  }

  const state = data.state as CodexCredentialLifecycleState
  const operationKind =
    data.operationKind as CodexCredentialLifecycleOperationKind
  const cleanup = data.cleanup as CodexCredentialLifecycleCleanup | undefined
  if (
    data.cleanup !== undefined &&
    cleanup !== 'pending' &&
    cleanup !== 'complete'
  ) {
    return false
  }
  if (state !== 'signed_out' && data.cleanup !== undefined) {
    return false
  }
  if (
    (state === 'login_prepared' && operationKind !== 'login') ||
    (state === 'signed_out' &&
      operationKind !== 'sign_out' &&
      operationKind !== 'delete') ||
    (state === 'reauth_required' && operationKind !== 'refresh') ||
    (state === 'credentialed' &&
      (operationKind === 'sign_out' || operationKind === 'delete'))
  ) {
    return false
  }
  return true
}

export function createCodexCredentialLifecycle(
  options: CodexCredentialLifecycleOptions = {},
): CodexCredentialLifecycle {
  if (!options || typeof options !== 'object') {
    throwLifecycleError('invalid_transition')
  }
  const directory = resolve(
    options.directory ??
      join(getClaudeConfigHomeDir(), CODEX_CREDENTIAL_LIFECYCLE_DIRECTORY),
  )
  const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS
  if (!Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0) {
    throwLifecycleError('invalid_transition')
  }

  const permitDetails = new WeakMap<object, PermitDetails>()
  const preparedLoginGenerations = new WeakMap<object, number>()

  function getPaths(accountId: string): CodexCredentialLifecyclePaths {
    assertAccountId(accountId)
    const recordPath = join(
      directory,
      `account-${encodeAccountId(accountId)}.json`,
    )
    return Object.freeze({
      directory,
      recordPath,
      lockPath: `${recordPath}.lock`,
    })
  }

  function read(accountId: string): CodexCredentialLifecycleReadResult {
    const { recordPath } = getPaths(accountId)
    let raw: string
    try {
      raw = readFileSync(recordPath, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { status: 'absent' }
      return { status: 'unreadable' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { status: 'malformed' }
    }
    if (!isValidRecord(parsed, accountId)) {
      return { status: 'malformed' }
    }
    return {
      status: 'valid',
      record: Object.freeze({ ...parsed }),
    }
  }

  function readForMutation(
    accountId: string,
  ): CodexCredentialLifecycleRecord | undefined {
    const result = read(accountId)
    if (result.status === 'absent') return undefined
    if (result.status === 'malformed') {
      throwLifecycleError('malformed_state')
    }
    if (result.status === 'unreadable') {
      throwLifecycleError('unreadable_state')
    }
    return result.record
  }

  function ensureDirectory(): void {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
    } catch {
      throwLifecycleError('storage_unavailable')
    }
  }

  function writeRecord(record: CodexCredentialLifecycleRecord): void {
    const { recordPath } = getPaths(record.accountId)
    ensureDirectory()
    try {
      writeFileAtomicDurableSync(
        recordPath,
        `${JSON.stringify(record, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
      chmodSync(recordPath, 0o600)
    } catch {
      throwLifecycleError('storage_unavailable')
    }
  }

  function acquireLock(recordPath: string): () => void {
    try {
      return acquireMutationLockSync(recordPath, {
        label: '[codex-lifecycle] Account',
        waitMs: lockWaitMs,
      })
    } catch {
      throwLifecycleError('lock_unavailable')
    }
  }

  function getPermit(
    permit: CodexCredentialLifecyclePermit,
    expectedOperationKind?: CodexCredentialLifecycleOperationKind,
  ): { object: object; details: PermitDetails } {
    if (
      !permit ||
      (typeof permit !== 'object' && typeof permit !== 'function')
    ) {
      throwLifecycleError('invalid_permit')
    }
    const details = permitDetails.get(permit as object)
    if (!details || details.accountId.length === 0) {
      throwLifecycleError('invalid_permit')
    }
    if (
      expectedOperationKind !== undefined &&
      details.operationKind !== expectedOperationKind
    ) {
      throwLifecycleError('invalid_transition')
    }
    return { object: permit as object, details }
  }

  function superseded(
    reason: CodexCredentialLifecycleSupersededReason,
    record?: CodexCredentialLifecycleRecord,
  ): CodexCredentialLifecycleTransitionResult {
    return record === undefined
      ? { status: 'superseded', reason }
      : { status: 'superseded', reason, record }
  }

  function applied(
    record: CodexCredentialLifecycleRecord,
    changed: boolean,
  ): CodexCredentialLifecycleTransitionResult {
    return changed
      ? { status: 'applied', changed: true, record }
      : { status: 'applied', changed: false, record }
  }

  async function withTransaction<T>(
    accountId: string,
    transactionOptions: CodexCredentialLifecycleTransactionOptions,
    callback: (
      permit: CodexCredentialLifecyclePermit,
    ) => T | Promise<T>,
  ): Promise<T> {
    assertAccountId(accountId)
    if (
      !transactionOptions ||
      typeof transactionOptions !== 'object' ||
      !OPERATION_KINDS.has(transactionOptions.operationKind)
    ) {
      throwLifecycleError('invalid_transition')
    }
    if (typeof callback !== 'function') {
      throwLifecycleError('invalid_transition')
    }
    const operationId = transactionOptions.operationId ?? randomUUID()
    assertOperationId(operationId)
    const { recordPath } = getPaths(accountId)

    ensureDirectory()
    const release = acquireLock(recordPath)
    const permit = Object.freeze({})
    const details: PermitDetails = {
      accountId,
      operationId,
      operationKind: transactionOptions.operationKind,
    }
    permitDetails.set(permit, details)

    let callbackError: unknown
    try {
      return await callback(
        permit as CodexCredentialLifecyclePermit,
      )
    } catch (error) {
      callbackError = error
      throw error
    } finally {
      permitDetails.delete(permit)
      preparedLoginGenerations.delete(permit)
      try {
        release()
      } catch {
        if (callbackError === undefined) {
          throwLifecycleError('lock_unavailable')
        }
      }
    }
  }

  function legacyBootstrap(
    permit: CodexCredentialLifecyclePermit,
    bootstrapOptions: CodexCredentialLegacyBootstrapOptions,
  ): CodexCredentialLifecycleTransitionResult {
    const { details } = getPermit(permit, 'legacy_bootstrap')
    if (
      !bootstrapOptions ||
      typeof bootstrapOptions !== 'object' ||
      bootstrapOptions.validatedUntaggedLegacyCredentials !== true
    ) {
      throwLifecycleError('invalid_transition')
    }
    const current = readForMutation(details.accountId)
    if (current !== undefined) {
      return superseded('state_mismatch', current)
    }
    const record = makeRecord({
      accountId: details.accountId,
      credentialGeneration: 1,
      state: 'credentialed',
      operationId: details.operationId,
      operationKind: 'legacy_bootstrap',
    })
    writeRecord(record)
    return applied(record, true)
  }

  function prepareLogin(
    permit: CodexCredentialLifecyclePermit,
  ): CodexCredentialLifecycleTransitionResult {
    const { object, details } = getPermit(permit, 'login')
    const current = readForMutation(details.accountId)
    const record = makeRecord({
      accountId: details.accountId,
      credentialGeneration: nextGeneration(current),
      state: 'login_prepared',
      operationId: details.operationId,
      operationKind: 'login',
    })
    writeRecord(record)
    preparedLoginGenerations.set(object, record.credentialGeneration)
    return applied(record, true)
  }

  function commitLogin(
    permit: CodexCredentialLifecyclePermit,
    generationOptions: CodexCredentialGenerationOptions,
  ): CodexCredentialLifecycleTransitionResult {
    const { object, details } = getPermit(permit, 'login')
    const expectedGeneration = getExpectedGeneration(generationOptions)
    const current = readForMutation(details.accountId)
    const preparedGeneration = preparedLoginGenerations.get(object)
    if (preparedGeneration !== expectedGeneration) {
      return superseded('permit_mismatch', current)
    }
    if (current === undefined) return superseded('missing')
    if (
      current.state !== 'login_prepared' ||
      current.credentialGeneration !== expectedGeneration
    ) {
      return superseded('generation_mismatch', current)
    }
    if (current.operationId !== details.operationId) {
      return superseded('operation_mismatch', current)
    }
    const record = makeRecord({
      accountId: details.accountId,
      credentialGeneration: current.credentialGeneration,
      state: 'credentialed',
      operationId: details.operationId,
      operationKind: 'login',
    })
    writeRecord(record)
    preparedLoginGenerations.delete(object)
    return applied(record, true)
  }

  function signOut(
    permit: CodexCredentialLifecyclePermit,
    generationOptions: CodexCredentialGenerationOptions,
  ): CodexCredentialLifecycleTransitionResult {
    const { details } = getPermit(permit, 'sign_out')
    const expectedGeneration = getExpectedGeneration(generationOptions)
    const current = readForMutation(details.accountId)
    if (current === undefined) return superseded('missing')
    if (current.credentialGeneration !== expectedGeneration) {
      return superseded('generation_mismatch', current)
    }
    if (current.state !== 'credentialed') {
      return superseded('state_mismatch', current)
    }
    const record = makeRecord({
      accountId: details.accountId,
      credentialGeneration: nextGeneration(current),
      state: 'signed_out',
      operationId: details.operationId,
      operationKind: 'sign_out',
      cleanup: 'pending',
    })
    writeRecord(record)
    return applied(record, true)
  }

  function completeCleanup(
    permit: CodexCredentialLifecyclePermit,
    expected: CodexCredentialCleanupExpectation,
  ): CodexCredentialLifecycleTransitionResult {
    const { details } = getPermit(permit)
    if (
      details.operationKind !== 'sign_out' &&
      details.operationKind !== 'delete'
    ) {
      throwLifecycleError('invalid_transition')
    }
    if (!expected || typeof expected !== 'object') {
      throwLifecycleError('invalid_transition')
    }
    if (!isCleanupOperationKind(expected.operationKind)) {
      throwLifecycleError('invalid_transition')
    }
    assertAccountId(expected.accountId)
    assertOperationId(expected.operationId)
    assertGeneration(expected.credentialGeneration)
    const current = readForMutation(details.accountId)
    if (expected.accountId !== details.accountId) {
      return superseded('permit_mismatch', current)
    }
    if (current === undefined) return superseded('missing')
    if (
      current.accountId !== expected.accountId ||
      current.credentialGeneration !== expected.credentialGeneration
    ) {
      return superseded('generation_mismatch', current)
    }
    if (current.state !== 'signed_out') {
      return superseded('state_mismatch', current)
    }
    if (
      current.operationId !== expected.operationId ||
      details.operationId !== expected.operationId ||
      current.operationKind !== expected.operationKind ||
      details.operationKind !== expected.operationKind
    ) {
      return superseded('operation_mismatch', current)
    }
    if (current.cleanup === 'complete') {
      return applied(current, false)
    }
    if (current.cleanup !== 'pending') {
      return superseded('cleanup_mismatch', current)
    }
    const record = makeRecord({
      accountId: current.accountId,
      credentialGeneration: current.credentialGeneration,
      state: 'signed_out',
      operationId: current.operationId,
      operationKind: current.operationKind,
      cleanup: 'complete',
    })
    writeRecord(record)
    return applied(record, true)
  }

  function markReauthRequired(
    permit: CodexCredentialLifecyclePermit,
    generationOptions: CodexCredentialGenerationOptions,
  ): CodexCredentialLifecycleTransitionResult {
    const { details } = getPermit(permit, 'refresh')
    const expectedGeneration = getExpectedGeneration(generationOptions)
    const current = readForMutation(details.accountId)
    if (current === undefined) return superseded('missing')
    if (current.credentialGeneration !== expectedGeneration) {
      return superseded('generation_mismatch', current)
    }
    if (current.state !== 'credentialed') {
      return superseded('state_mismatch', current)
    }
    const record = makeRecord({
      accountId: details.accountId,
      credentialGeneration: nextGeneration(current),
      state: 'reauth_required',
      operationId: details.operationId,
      operationKind: 'refresh',
    })
    writeRecord(record)
    return applied(record, true)
  }

  function deleteAccount(
    permit: CodexCredentialLifecyclePermit,
    generationOptions: CodexCredentialGenerationOptions,
  ): CodexCredentialLifecycleTransitionResult {
    const { details } = getPermit(permit, 'delete')
    const expectedGeneration = getExpectedGeneration(generationOptions)
    const current = readForMutation(details.accountId)
    if (current === undefined) return { status: 'no_action' }
    if (current.credentialGeneration !== expectedGeneration) {
      return superseded('generation_mismatch', current)
    }
    if (current.state === 'signed_out' || current.state === 'reauth_required') {
      // A denial record is the durable tombstone. Deleting a vault profile must
      // not remove or rewrite it once the credential is already invalid.
      return { status: 'no_action', record: current }
    }
    const record = makeRecord({
      accountId: details.accountId,
      credentialGeneration: nextGeneration(current),
      state: 'signed_out',
      operationId: details.operationId,
      operationKind: 'delete',
      cleanup: 'pending',
    })
    writeRecord(record)
    return applied(record, true)
  }

  function recover(
    permit: CodexCredentialLifecyclePermit,
  ): CodexCredentialLifecycleRecoveryResult {
    const { details } = getPermit(permit, 'refresh')
    const current = readForMutation(details.accountId)
    if (current === undefined) {
      return { status: 'no_action' }
    }
    if (current.state !== 'signed_out') {
      return { status: 'no_action', record: current }
    }
    if (!isCleanupOperationKind(current.operationKind)) {
      return { status: 'no_action', record: current }
    }
    const cleanup = Object.freeze({
      accountId: current.accountId,
      credentialGeneration: current.credentialGeneration,
      operationId: current.operationId,
      operationKind: current.operationKind,
    })
    if (current.cleanup === 'complete') {
      return { status: 'complete', cleanup, record: current }
    }
    if (current.cleanup !== 'pending') {
      return { status: 'no_action', record: current }
    }
    return { status: 'pending', cleanup }
  }

  return Object.freeze({
    read,
    getPaths,
    withTransaction,
    legacyBootstrap,
    prepareLogin,
    commitLogin,
    signOut,
    completeCleanup,
    markReauthRequired,
    deleteAccount,
    recover,
  })
}

export const codexCredentialLifecycle = createCodexCredentialLifecycle()
