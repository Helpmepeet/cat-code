import { chmodSync, existsSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'

import { getCodexOAuthTokens } from '../../utils/auth.js'
import { writeFileAtomicDurableSync } from '../../utils/atomicFile.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { acquireMutationLockSync } from '../../utils/lockfile.js'
import {
  appendAccount,
  LEGACY_CODEX_CREDENTIAL_GENERATION,
} from './codexAccountPool.js'
import {
  codexCredentialLifecycle,
  type CodexCredentialLifecycle,
  type CodexCredentialLifecyclePermit,
  type CodexCredentialLifecycleReadResult,
} from './codexCredentialLifecycle.js'

export type CodexCredentialStore = 'config' | 'vault'

/**
 * A credential handle is an immutable snapshot of the credential installed in
 * one authoritative store. The generation is carried with the token rather
 * than looked up from lifecycle state when the handle is created.
 */
export type CodexCredentialHandle = Readonly<{
  accountId: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  credentialGeneration: number
  credentialSource: CodexCredentialStore
  credentialPath: string
}>

export type CodexStoredCredential = Readonly<{
  accountId: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  credentialGeneration: number
}>

export type CodexCredentialUseErrorCode =
  | 'invalid_binding'
  | 'missing'
  | 'malformed'
  | 'unreadable'
  | 'state_mismatch'
  | 'generation_mismatch'
  | 'profile_mismatch'
  | 'storage_unavailable'
  | 'lock_unavailable'

export class CodexCredentialUseError extends Error {
  readonly code: CodexCredentialUseErrorCode

  constructor(code: CodexCredentialUseErrorCode) {
    super(messageForErrorCode(code))
    this.name = 'CodexCredentialUseError'
    this.code = code
  }
}

export type CodexCredentialUseStorage = Readonly<{
  readConfig: (path: string) => CodexStoredCredential | null
  writeConfig: (path: string, credential: CodexStoredCredential) => boolean
  readVault: (path: string) => CodexStoredCredential | null
  writeVault: (path: string, credential: CodexStoredCredential) => boolean
}>

export type CodexCredentialUseOptions = Readonly<{
  lifecycle?: CodexCredentialLifecycle
  storage?: Partial<CodexCredentialUseStorage>
}>

function messageForErrorCode(code: CodexCredentialUseErrorCode): string {
  switch (code) {
    case 'invalid_binding':
      return 'Codex credential use was denied because its binding is invalid.'
    case 'missing':
      return 'Codex credential use was denied because its lifecycle is missing.'
    case 'malformed':
      return 'Codex credential use was denied because its lifecycle is malformed.'
    case 'unreadable':
      return 'Codex credential use was denied because its lifecycle is unreadable.'
    case 'state_mismatch':
      return 'Codex credential use was denied by the credential lifecycle state.'
    case 'generation_mismatch':
      return 'Codex credential use was denied because its credential generation is stale.'
    case 'profile_mismatch':
      return 'Codex credential use was denied because the stored credential changed.'
    case 'storage_unavailable':
      return 'Codex credential use was denied because its credential store could not be verified.'
    case 'lock_unavailable':
      return 'Codex credential use was denied because its lifecycle lock is unavailable.'
  }
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f/\\]/.test(value)
  )
}

function isCredentialGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isCredentialPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function assertHandle(handle: CodexCredentialHandle): void {
  if (
    !handle ||
    typeof handle !== 'object' ||
    !isIdentifier(handle.accountId) ||
    typeof handle.accessToken !== 'string' ||
    handle.accessToken.length === 0 ||
    typeof handle.refreshToken !== 'string' ||
    handle.refreshToken.length === 0 ||
    typeof handle.expiresAt !== 'number' ||
    !Number.isFinite(handle.expiresAt) ||
    !isCredentialGeneration(handle.credentialGeneration) ||
    (handle.credentialSource !== 'config' && handle.credentialSource !== 'vault') ||
    !isCredentialPath(handle.credentialPath)
  ) {
    throw new CodexCredentialUseError('invalid_binding')
  }
}

export type CodexCredentialHandleInput = Readonly<{
  accountId: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  credentialGeneration: number
  credentialSource: CodexCredentialStore
  credentialPath?: string
}>

/**
 * Construct a frozen handle from an installed credential snapshot.
 *
 * Config storage has one canonical path. Vault storage must provide the exact
 * profile path that supplied the credential; deriving a path from an account
 * id would permit a stale or ambiguous profile to be relabelled.
 */
export function createCodexCredentialHandle(
  input: CodexCredentialHandleInput,
): CodexCredentialHandle {
  const credentialPath =
    input.credentialPath ??
    (input.credentialSource === 'config' ? getGlobalClaudeFile() : undefined)
  const handle = Object.freeze({
    accountId: input.accountId,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    credentialGeneration: input.credentialGeneration,
    credentialSource: input.credentialSource,
    credentialPath,
  })
  assertHandle(handle)
  return handle
}

function storedCredentialFromHandle(
  handle: CodexCredentialHandle,
  generation = handle.credentialGeneration,
): CodexStoredCredential {
  return Object.freeze({
    accountId: handle.accountId,
    accessToken: handle.accessToken,
    refreshToken: handle.refreshToken,
    expiresAt: handle.expiresAt,
    credentialGeneration: generation,
  })
}

function lifecycleReadFailureCode(
  result: CodexCredentialLifecycleReadResult,
): 'missing' | 'malformed' | 'unreadable' {
  if (result.status === 'absent') return 'missing'
  if (result.status === 'malformed') return 'malformed'
  return 'unreadable'
}

function readLifecycle(
  lifecycle: Pick<CodexCredentialLifecycle, 'read'>,
  accountId: string,
): CodexCredentialLifecycleReadResult {
  try {
    return lifecycle.read(accountId)
  } catch {
    return { status: 'unreadable' }
  }
}

function throwForLifecycleRead(
  result: CodexCredentialLifecycleReadResult,
): never {
  if (result.status === 'valid') {
    throw new CodexCredentialUseError('state_mismatch')
  }
  throw new CodexCredentialUseError(lifecycleReadFailureCode(result))
}

function requirePositiveLifecycle(
  lifecycle: Pick<CodexCredentialLifecycle, 'read'>,
  handle: CodexCredentialHandle,
): void {
  const result = readLifecycle(lifecycle, handle.accountId)
  if (result.status !== 'valid') {
    throwForLifecycleRead(result)
  }
  if (result.record.state !== 'credentialed') {
    throw new CodexCredentialUseError('state_mismatch')
  }
  if (result.record.credentialGeneration !== handle.credentialGeneration) {
    throw new CodexCredentialUseError('generation_mismatch')
  }
}

function requireLegacyLifecycleAbsent(
  lifecycle: Pick<CodexCredentialLifecycle, 'read'>,
  accountId: string,
): void {
  const result = readLifecycle(lifecycle, accountId)
  if (result.status !== 'absent') {
    if (result.status === 'valid') {
      throw new CodexCredentialUseError('state_mismatch')
    }
    throw new CodexCredentialUseError(lifecycleReadFailureCode(result))
  }
}

function parseCredentialGeneration(value: unknown): number | null {
  if (value === undefined) return LEGACY_CODEX_CREDENTIAL_GENERATION
  return isCredentialGeneration(value) ? value : null
}

function parseStoredCredential(
  value: unknown,
  shape: 'config' | 'vault',
): CodexStoredCredential | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const data = value as Record<string, unknown>
  const tokenData =
    shape === 'config'
      ? data.codexOAuth
      : data.tokens
  if (!tokenData || typeof tokenData !== 'object' || Array.isArray(tokenData)) {
    return null
  }
  const tokens = tokenData as Record<string, unknown>
  const accessToken =
    shape === 'config' ? tokens.accessToken : tokens.access_token
  const refreshToken =
    shape === 'config' ? tokens.refreshToken : tokens.refresh_token
  const accountId =
    shape === 'config' ? tokens.accountId : tokens.account_id
  const expiresAt =
    shape === 'config' ? tokens.expiresAt : tokens.expires_at
  const generation =
    shape === 'config'
      ? tokens.credentialGeneration
      : tokens.credential_generation
  if (
    typeof accessToken !== 'string' ||
    accessToken.length === 0 ||
    typeof refreshToken !== 'string' ||
    refreshToken.length === 0 ||
    !isIdentifier(accountId) ||
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt)
  ) {
    return null
  }
  const credentialGeneration = parseCredentialGeneration(generation)
  if (credentialGeneration === null) return null
  if (shape === 'vault') {
    const profileState = data.profile_state
    if (profileState === 'signed_out' || profileState === 'recovery_required') {
      return null
    }
  }
  return Object.freeze({
    accountId,
    accessToken,
    refreshToken,
    expiresAt,
    credentialGeneration,
  })
}

function readConfigCredential(path: string): CodexStoredCredential | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parseStoredCredential(parsed, 'config')
  } catch {
    // Test-mode config persistence is intentionally in memory. The normal
    // path always reads the authoritative file above.
    if (path === getGlobalClaudeFile() && process.env.NODE_ENV === 'test') {
      const tokens = getCodexOAuthTokens()
      return tokens
        ? Object.freeze({
            accountId: tokens.accountId,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            credentialGeneration: tokens.credentialGeneration ?? 0,
          })
        : null
    }
    return null
  }
}

function readVaultCredential(path: string): CodexStoredCredential | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parseStoredCredential(parsed, 'vault')
  } catch {
    return null
  }
}

function writeConfigCredential(
  path: string,
  credential: CodexStoredCredential,
): boolean {
  if (
    path !== getGlobalClaudeFile() ||
    credential.credentialGeneration !== 1
  ) {
    return false
  }
  try {
    let matchedLegacy = false
    const saved = saveGlobalConfig(current => {
      const stored = parseStoredCredential(
        { codexOAuth: current.codexOAuth },
        'config',
      )
      const expectedLegacy = {
        ...credential,
        credentialGeneration: 0,
      }
      if (!storedCredentialMatches(stored, expectedLegacy)) {
        return current
      }
      matchedLegacy = true
      return {
        ...current,
        codexOAuth: {
          ...current.codexOAuth!,
          credentialGeneration: credential.credentialGeneration,
        },
      }
    })
    return matchedLegacy && saved
  } catch {
    return false
  }
}

function writeVaultCredential(
  path: string,
  credential: CodexStoredCredential,
): boolean {
  if (credential.credentialGeneration !== 1) return false
  let release: (() => void) | undefined
  try {
    release = acquireMutationLockSync(path, {
      label: '[codex-credential-use] Vault',
      waitMs: 10_000,
    })
    const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const stored = parseStoredCredential(data, 'vault')
    const expectedLegacy = {
      ...credential,
      credentialGeneration: 0,
    }
    if (!storedCredentialMatches(stored, expectedLegacy)) {
      return false
    }
    const tokens = data.tokens
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
      return false
    }
    data.tokens = {
      ...tokens,
      credential_generation: credential.credentialGeneration,
    }
    writeFileAtomicDurableSync(path, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    chmodSync(path, 0o600)
    return true
  } catch {
    return false
  } finally {
    release?.()
  }
}

function resolveStorage(
  options: CodexCredentialUseOptions,
): CodexCredentialUseStorage {
  return {
    readConfig: options.storage?.readConfig ?? readConfigCredential,
    writeConfig: options.storage?.writeConfig ?? writeConfigCredential,
    readVault: options.storage?.readVault ?? readVaultCredential,
    writeVault: options.storage?.writeVault ?? writeVaultCredential,
  }
}

function readStoredCredential(
  handle: CodexCredentialHandle,
  storage: CodexCredentialUseStorage,
): CodexStoredCredential | null {
  return handle.credentialSource === 'config'
    ? storage.readConfig(handle.credentialPath)
    : storage.readVault(handle.credentialPath)
}

function storedCredentialMatches(
  stored: CodexStoredCredential | null,
  expected: CodexStoredCredential,
): boolean {
  return (
    stored?.accountId === expected.accountId &&
    stored.accessToken === expected.accessToken &&
    stored.refreshToken === expected.refreshToken &&
    stored.expiresAt === expected.expiresAt &&
    stored.credentialGeneration === expected.credentialGeneration
  )
}

function bootstrapLegacyHandle(
  handle: CodexCredentialHandle,
  lifecycle: CodexCredentialLifecycle,
  permit: CodexCredentialLifecyclePermit,
  storage: CodexCredentialUseStorage,
): CodexCredentialHandle {
  requireLegacyLifecycleAbsent(lifecycle, handle.accountId)

  const stored = readStoredCredential(handle, storage)
  const expectedLegacy = storedCredentialFromHandle(handle, 0)
  if (!storedCredentialMatches(stored, expectedLegacy)) {
    throw new CodexCredentialUseError('profile_mismatch')
  }

  const tagged = Object.freeze({
    ...stored,
    credentialGeneration: 1,
  })
  const saved =
    handle.credentialSource === 'config'
      ? storage.writeConfig(handle.credentialPath, tagged)
      : storage.writeVault(handle.credentialPath, tagged)
  if (!saved) {
    throw new CodexCredentialUseError('storage_unavailable')
  }

  const persisted = readStoredCredential(handle, storage)
  if (!storedCredentialMatches(persisted, tagged)) {
    throw new CodexCredentialUseError('storage_unavailable')
  }

  const committed = lifecycle.legacyBootstrap(permit, {
    validatedUntaggedLegacyCredentials: true,
  })
  if (
    committed.status !== 'applied' ||
    committed.record.credentialGeneration !== 1
  ) {
    throw new CodexCredentialUseError(
      committed.status === 'superseded' &&
        committed.reason === 'generation_mismatch'
        ? 'generation_mismatch'
        : 'state_mismatch',
    )
  }

  const taggedStored = readStoredCredential(handle, storage)
  if (!storedCredentialMatches(taggedStored, tagged)) {
    throw new CodexCredentialUseError('storage_unavailable')
  }

  const authorizedHandle = createCodexCredentialHandle({
    ...taggedStored,
    credentialSource: handle.credentialSource,
    credentialPath: handle.credentialPath,
  })
  appendAccount(
    taggedStored,
    {
      preserveCapped: true,
      writer: 'codexCredentialUse.legacyBootstrap',
      source: handle.credentialSource,
      ...(handle.credentialSource === 'vault'
        ? { vaultFilePath: handle.credentialPath }
        : {}),
    },
  )
  return authorizedHandle
}

function authorizeUnderPermit(
  handle: CodexCredentialHandle,
  lifecycle: CodexCredentialLifecycle,
  permit: CodexCredentialLifecyclePermit,
  storage: CodexCredentialUseStorage,
): CodexCredentialHandle {
  assertHandle(handle)
  if (handle.credentialGeneration === LEGACY_CODEX_CREDENTIAL_GENERATION) {
    return bootstrapLegacyHandle(handle, lifecycle, permit, storage)
  }
  requirePositiveLifecycle(lifecycle, handle)
  return handle
}

function lifecycleForOptions(
  options: CodexCredentialUseOptions,
): CodexCredentialLifecycle {
  return options.lifecycle ?? codexCredentialLifecycle
}

function mapLifecycleError(error: unknown): CodexCredentialUseError {
  if (error instanceof CodexCredentialUseError) return error
  if (
    error &&
    typeof error === 'object' &&
    'code' in error
  ) {
    const code = error.code
    if (
      code === 'lock_unavailable'
    ) {
      return new CodexCredentialUseError('lock_unavailable')
    }
    if (
      code === 'malformed_state'
    ) {
      return new CodexCredentialUseError('malformed')
    }
    if (
      code === 'unreadable_state'
    ) {
      return new CodexCredentialUseError('unreadable')
    }
  }
  return new CodexCredentialUseError('lock_unavailable')
}

/**
 * Validate a handle while holding the account lifecycle lock. Legacy handles
 * are atomically tagged and returned as a new generation-one handle.
 */
export async function authorizeCodexCredentialUse(
  handle: CodexCredentialHandle,
  options: CodexCredentialUseOptions = {},
): Promise<CodexCredentialHandle> {
  assertHandle(handle)
  const lifecycle = lifecycleForOptions(options)
  const storage = resolveStorage(options)
  try {
    return await lifecycle.withTransaction(
      handle.accountId,
      {
        operationKind: 'refresh',
        operationId: randomUUID(),
      },
      permit => authorizeUnderPermit(handle, lifecycle, permit, storage),
    )
  } catch (error) {
    if (error instanceof CodexCredentialUseError) throw error
    throw mapLifecycleError(error)
  }
}

/**
 * Start one network operation under the credential lock.
 *
 * The callback is invoked synchronously inside the transaction. Its returned
 * promise is captured but is never awaited by the transaction, so the lock
 * covers send initiation rather than response consumption.
 */
export async function startCodexCredentialSend<T>(
  handle: CodexCredentialHandle,
  start: (authorizedHandle: CodexCredentialHandle) => PromiseLike<T> | T,
  options: CodexCredentialUseOptions = {},
): Promise<T> {
  assertHandle(handle)
  const lifecycle = lifecycleForOptions(options)
  const storage = resolveStorage(options)
  let responsePromise: Promise<T> | undefined
  try {
    await lifecycle.withTransaction(
      handle.accountId,
      {
        operationKind: 'refresh',
        operationId: randomUUID(),
      },
      permit => {
        const authorizedHandle = authorizeUnderPermit(
          handle,
          lifecycle,
          permit,
          storage,
        )
        responsePromise = Promise.resolve(start(authorizedHandle))
      },
    )
  } catch (error) {
    if (error instanceof CodexCredentialUseError) throw error
    throw mapLifecycleError(error)
  }
  if (!responsePromise) {
    throw new CodexCredentialUseError('lock_unavailable')
  }
  return responsePromise
}

