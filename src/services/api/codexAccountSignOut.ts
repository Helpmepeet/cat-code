import { randomUUID } from 'crypto'
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'fs'
import { basename, dirname, join } from 'path'

import { clearAuthRelatedCaches } from '../../commands/logout/logout.js'
import {
  clearCodexOAuthTokensForAccount,
  clearCodexOAuthTokensForAccountResult,
  replaceCodexOAuthActiveAccountIfCurrent,
  type CodexOAuthTokenClearResult,
} from '../../utils/auth.js'
import { writeFileAtomicDurableSync } from '../../utils/atomicFile.js'
import { getGlobalConfig, type GlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { acquireMutationLockSync, lock } from '../../utils/lockfile.js'
import { invalidateUsageCache } from './codexUsage.js'
import {
  getVaultPath,
  getPoolStatus,
  getCodexProfileInventory,
  isCodexAccountSwitchable,
  reconcileCodexAccountDeletion,
  reconcileCodexAccountSignOut,
  resolveCodexAccountForTargetedSignOut,
  setActiveAccount,
  type CodexAccountSignOutProfile,
  type CodexProfileInventory,
  type CodexTargetedSignOutResolution,
  type PoolAccount,
} from './codexAccountPool.js'
import {
  repairLeasesForUnavailableAccount,
} from './codexAccountLeaseManager.js'
import {
  codexCredentialLifecycle,
  type CodexCredentialLifecycle,
  type CodexCredentialLifecycleReadResult,
  type CodexCredentialLifecycleRecord,
  type CodexCredentialLifecycleState,
} from './codexCredentialLifecycle.js'
import {
  retireCodexWebSocketSessions,
  type CodexWebSocketRetirement,
} from './codex-websocket-transport.js'
import { resetCodexCacheContext } from './codex-fetch-adapter.js'
import type { CodexTokens } from '../oauth/codex-client.js'

export type CodexAccountSignOutInput = Readonly<{
  accountId: string
  expectedCredentialGeneration: number
  operationId: string
}>

export type CodexAccountDeletionInput = CodexAccountSignOutInput

export type CodexAccountSignOutStatus =
  | 'committed'
  | 'already_committed'
  | 'superseded'
  | 'cleanup_pending'
  | 'retryable_unknown'

export type CodexAccountDeletionStatus = CodexAccountSignOutStatus

export type CodexAccountSignOutResult = Readonly<{
  status: CodexAccountSignOutStatus
  accountId: string
  lifecycleGeneration: number | null
  lifecycleState: CodexCredentialLifecycleState | null
  credentialGeneration: number | null
  state: CodexCredentialLifecycleState | null
  operationId: string
  targetWasActive: boolean
  replacementActiveAccountId: string | null
}>

export type CodexAccountDeletionResult = CodexAccountSignOutResult

export type CodexAccountSignOutDependencies = Readonly<{
  lifecycle?: CodexCredentialLifecycle
  getProfileInventory?: () => CodexProfileInventory
  getPoolStatus?: typeof getPoolStatus
  resolveTarget?: typeof resolveCodexAccountForTargetedSignOut
  getVaultPath?: typeof getVaultPath
  readConfig?: typeof getGlobalConfig
  clearConfigMirror?: typeof clearCodexOAuthTokensForAccount
  clearConfigMirrorResult?: typeof clearCodexOAuthTokensForAccountResult
  replaceActiveAccount?: typeof replaceCodexOAuthActiveAccountIfCurrent
  retireWebSockets?: (
    retirement: CodexWebSocketRetirement,
  ) => void
  reconcilePool?: (
    input: Parameters<typeof reconcileCodexAccountSignOut>[0],
  ) => void
  reconcileDeletedPool?: (accountId: string) => void
  repairLeases?: typeof repairLeasesForUnavailableAccount
  resetCodexCacheContext?: typeof resetCodexCacheContext
  invalidateUsageCache?: typeof invalidateUsageCache
  clearAuthCaches?: () => Promise<void>
  beforeCleanup?: (
    record: CodexCredentialLifecycleRecord,
  ) => void | Promise<void>
}>

export type CodexAccountDeletionDependencies = CodexAccountSignOutDependencies

type NormalizedInput = {
  accountId: string
  expectedCredentialGeneration: number
  operationId: string
}

type TargetHint = {
  source?: PoolAccount['source']
  alias?: string
  vaultFilePaths: readonly string[]
}

type VaultObservation = {
  filePath: string
  alias?: string
  credentialGeneration: number | null
  hasCredentialBearingCopy: boolean
}

type VaultScan = {
  observations: VaultObservation[]
  unsafe: boolean
  readFailure: boolean
}

type VaultCleanup = {
  ok: boolean
  profilePaths: string[]
  discoveredPaths: string[]
  alias?: string
}

type PhysicalCleanup = {
  ok: boolean
  profilePaths: string[]
  discoveredPaths: string[]
  alias?: string
}

type TransactionExecution =
  | {
      kind: 'superseded'
      record?: CodexCredentialLifecycleRecord
    }
  | {
      kind: 'ready'
      record: CodexCredentialLifecycleRecord
      alreadyCommitted: boolean
      cleanupComplete: boolean
      cleanup: PhysicalCleanup
      retirementFailed: boolean
      completionFailed: boolean
      preserveLifecycle: boolean
    }
  | {
      kind: 'retryable_unknown'
      record?: CodexCredentialLifecycleRecord
    }

type ActiveReplacement =
  | {
      status: 'unchanged' | 'replaced' | 'none'
      activeAccountId: string | null
    }
  | {
      status: 'retryable_unknown'
      activeAccountId: string | null
    }

const MAX_IDENTIFIER_LENGTH = 128
const CODEX_ALIAS_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/
const VAULT_LOCK_WAIT_MS = 10_000
const ACTIVE_REPLACEMENT_LOCK_WAIT_MS = 30_000

// Active-account cleanup can lock both its target and a replacement candidate.
// Taking this coordination lock first gives every process the same lock order.
async function withActiveReplacementLock<T>(
  lifecycle: Pick<CodexCredentialLifecycle, 'getPaths'>,
  accountId: string,
  callback: () => Promise<T>,
): Promise<T> {
  const directory = lifecycle.getPaths(accountId).directory
  const lockTarget = join(directory, '.active-account-replacement')
  const deadline = Date.now() + ACTIVE_REPLACEMENT_LOCK_WAIT_MS
  let release: (() => Promise<void>) | undefined
  for (;;) {
    try {
      release = await lock(lockTarget, {
        realpath: false,
        retries: 0,
        stale: 120_000,
        update: 30_000,
        onCompromised: error => {
          logForDebugging(
            `[codex-signout] Active replacement lock compromised: ${error.message}`,
            { level: 'error' },
          )
        },
      })
      break
    } catch (error) {
      const locked =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ELOCKED'
      if (!locked || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  try {
    return await callback()
  } finally {
    await release()
  }
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f/\\]/.test(value)
  )
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function normalizeInput(
  input: CodexAccountSignOutInput,
): NormalizedInput | null {
  if (
    !input ||
    typeof input !== 'object' ||
    !isIdentifier(input.accountId) ||
    !isIdentifier(input.operationId) ||
    !isGeneration(input.expectedCredentialGeneration)
  ) {
    return null
  }
  return {
    accountId: input.accountId,
    expectedCredentialGeneration: input.expectedCredentialGeneration,
    operationId: input.operationId,
  }
}

function safeReadLifecycle(
  lifecycle: Pick<CodexCredentialLifecycle, 'read'>,
  accountId: string,
): CodexCredentialLifecycleReadResult {
  try {
    return lifecycle.read(accountId)
  } catch {
    return { status: 'unreadable' }
  }
}

function resultFor(
  input: NormalizedInput,
  status: CodexAccountSignOutStatus,
  record: CodexCredentialLifecycleRecord | undefined,
  targetWasActive: boolean,
  replacementActiveAccountId: string | null = null,
): CodexAccountSignOutResult {
  return {
    status,
    accountId: input.accountId,
    lifecycleGeneration: record?.credentialGeneration ?? null,
    lifecycleState: record?.state ?? null,
    credentialGeneration: record?.credentialGeneration ?? null,
    state: record?.state ?? null,
    operationId: input.operationId,
    targetWasActive,
    replacementActiveAccountId,
  }
}

function safeAlias(alias: string | undefined): string | undefined {
  if (
    typeof alias !== 'string' ||
    alias.trim() !== alias ||
    !CODEX_ALIAS_PATTERN.test(alias)
  ) {
    return undefined
  }
  return alias
}

function targetHintFor(
  resolution: CodexTargetedSignOutResolution,
): TargetHint {
  if (resolution.kind === 'credentialed') {
    return {
      source: resolution.account.source,
      alias: safeAlias(resolution.account.alias),
      vaultFilePaths: resolution.account.vaultFilePath
        ? [resolution.account.vaultFilePath]
        : [],
    }
  }
  if (resolution.kind === 'signed_out') {
    return {
      source: resolution.profile.source,
      alias: safeAlias(resolution.profile.alias),
      vaultFilePaths: [...resolution.profile.vaultFilePaths],
    }
  }
  return { vaultFilePaths: [] }
}

function targetResolution(
  accountId: string,
  dependencies: CodexAccountSignOutDependencies,
  lifecycle: Pick<CodexCredentialLifecycle, 'read'>,
): CodexTargetedSignOutResolution {
  if (dependencies.resolveTarget) {
    return dependencies.resolveTarget(accountId)
  }

  const inventory = (
    dependencies.getProfileInventory ?? getCodexProfileInventory
  )()
  const status = (dependencies.getPoolStatus ?? getPoolStatus)()
  const duplicate = inventory.duplicateVaultIdentities.some(
    identity => identity.accountId === accountId,
  )
  const accounts = status.accounts.filter(
    account => account.accountId === accountId,
  )
  const profiles = inventory.signedOutProfiles.filter(
    profile => profile.accountId === accountId,
  )
  if (duplicate || accounts.length > 1 || profiles.length > 1) {
    return { kind: 'ambiguous' }
  }
  if (accounts.length === 1 && profiles.length === 0) {
    return {
      kind: 'credentialed',
      account: accounts[0]!,
      targetWasActive:
        status.accounts[status.activeIndex]?.accountId === accountId,
    }
  }
  if (accounts.length === 0 && profiles.length === 1) {
    return { kind: 'signed_out', profile: profiles[0]! }
  }
  if (accounts.length > 0 || profiles.length > 0) {
    return { kind: 'ambiguous' }
  }

  if (accounts.length === 0 && profiles.length === 0 && !duplicate) {
    let config: GlobalConfig
    try {
      config = (dependencies.readConfig ?? getGlobalConfig)()
    } catch {
      return { kind: 'none' }
    }
    const mirror = config.codexOAuth
    const lifecycleResult = safeReadLifecycle(lifecycle, accountId)
    const mirrorGeneration = mirror?.credentialGeneration ?? 0
    const lifecycleMatchesMirror =
      lifecycleResult.status === 'valid' &&
      lifecycleResult.record.state === 'credentialed' &&
      lifecycleResult.record.credentialGeneration === mirrorGeneration
    const legacyMirror =
      lifecycleResult.status === 'absent' && mirrorGeneration === 0
    if (
      mirror?.accountId === accountId &&
      typeof mirror.accessToken === 'string' &&
      mirror.accessToken.length > 0 &&
      typeof mirror.refreshToken === 'string' &&
      mirror.refreshToken.length > 0 &&
      typeof mirror.expiresAt === 'number' &&
      Number.isFinite(mirror.expiresAt) &&
      (lifecycleMatchesMirror || legacyMirror)
    ) {
      return {
        kind: 'credentialed',
        account: {
          accountId,
          accessToken: mirror.accessToken,
          refreshToken: mirror.refreshToken,
          expiresAt: mirror.expiresAt,
          source: 'config',
          status: 'healthy',
          lastUsedAt: 0,
          credentialGeneration: mirrorGeneration,
          credentialGenerationState:
            mirrorGeneration === 0
              ? 'legacy_unbound'
              : 'lifecycle_bound',
        },
        targetWasActive:
          config.activeCodexAccountId === accountId ||
          mirror.accountId === accountId,
      }
    }
  }
  return { kind: 'none' }
}

function currentActiveAccountId(
  readConfig: () => GlobalConfig,
): string | null {
  const value = readConfig().activeCodexAccountId
  return typeof value === 'string' ? value : null
}

function mirrorMatches(
  config: GlobalConfig,
  accountId: string,
  generation: number,
): boolean {
  const mirror = config.codexOAuth
  if (!mirror || mirror.accountId !== accountId) return false
  const mirrorGeneration =
    mirror.credentialGeneration === undefined
      ? 0
      : mirror.credentialGeneration
  return mirrorGeneration === generation
}

function isSameCleanupOperation(
  record: CodexCredentialLifecycleRecord,
  input: NormalizedInput,
  operationKind: 'sign_out' | 'delete',
): boolean {
  return (
    record.state === 'signed_out' &&
    record.operationKind === operationKind &&
    record.operationId === input.operationId &&
    record.credentialGeneration ===
      input.expectedCredentialGeneration + 1
  )
}

function isCurrentCleanupRecord(
  current: CodexCredentialLifecycleRecord | undefined,
  expected: CodexCredentialLifecycleRecord,
): boolean {
  return (
    current?.accountId === expected.accountId &&
    current.credentialGeneration === expected.credentialGeneration &&
    current.state === expected.state &&
    (expected.state === 'signed_out' || expected.state === 'reauth_required') &&
    current.operationId === expected.operationId &&
    current.operationKind === expected.operationKind &&
    current.cleanup === expected.cleanup
  )
}

function recordForRead(
  result: CodexCredentialLifecycleReadResult,
): CodexCredentialLifecycleRecord | undefined {
  return result.status === 'valid' ? result.record : undefined
}

function readStoredIdentity(
  data: Record<string, unknown>,
):
  | { kind: 'known'; accountId: string }
  | { kind: 'ambiguous' }
  | { kind: 'unknown' } {
  const topLevel = readIdentityField(data, 'account_id')
  const tokens = asRecord(data.tokens)
  const tokenIdentity = readIdentityField(tokens, 'account_id')
  if (topLevel === null || tokenIdentity === null) {
    return { kind: 'ambiguous' }
  }
  if (topLevel && tokenIdentity && topLevel !== tokenIdentity) {
    return { kind: 'ambiguous' }
  }
  const accountId = topLevel ?? tokenIdentity
  return accountId ? { kind: 'known', accountId } : { kind: 'unknown' }
}

function readIdentityField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined | null {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key)) {
    return undefined
  }
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function mentionsAccount(
  data: Record<string, unknown>,
  accountId: string,
): boolean {
  const tokens = asRecord(data.tokens)
  return (
    data.account_id === accountId ||
    tokens?.account_id === accountId
  )
}

function credentialGenerationFrom(
  tokens: Record<string, unknown> | undefined,
): number | null {
  if (!tokens || !Object.prototype.hasOwnProperty.call(tokens, 'credential_generation')) {
    return 0
  }
  return isGeneration(tokens.credential_generation)
    ? tokens.credential_generation
    : null
}

function hasCredentialBearingCopy(
  data: Record<string, unknown>,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(data, 'tokens')) {
    return false
  }
  const tokens = asRecord(data.tokens)
  if (!tokens) return true
  return Object.keys(tokens).some(key => key !== 'credential_generation')
}

function aliasFromData(
  data: Record<string, unknown>,
): string | undefined {
  return safeAlias(typeof data.alias === 'string' ? data.alias : undefined)
}

function metadataProfile(
  accountId: string,
  alias: string | undefined,
  record: CodexCredentialLifecycleRecord,
): Record<string, unknown> {
  return {
    account_id: accountId,
    ...(safeAlias(alias) ? { alias: safeAlias(alias) } : {}),
    profile_state: 'signed_out',
    credential_generation: record.credentialGeneration,
    lifecycle_generation: record.credentialGeneration,
    lifecycle_state: record.state,
  }
}

function scanVault(
  vaultPath: string | null,
  accountId: string,
  knownPaths: ReadonlySet<string>,
): VaultScan {
  if (!vaultPath) {
    return { observations: [], unsafe: false, readFailure: false }
  }
  const accountsDir = join(vaultPath, 'accounts')
  if (!existsSync(accountsDir)) {
    return { observations: [], unsafe: false, readFailure: false }
  }

  let files: string[]
  try {
    files = readdirSync(accountsDir)
      .filter(file => file.endsWith('.json'))
      .sort()
  } catch {
    return { observations: [], unsafe: false, readFailure: true }
  }

  const observations: VaultObservation[] = []
  let unsafe = false
  let readFailure = false
  for (const file of files) {
    const filePath = join(accountsDir, file)
    let data: Record<string, unknown>
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
      const record = asRecord(parsed)
      if (!record) {
        if (
          knownPaths.has(filePath) ||
          basename(file) === `${accountId}.json`
        ) {
          readFailure = true
        }
        continue
      }
      data = record
    } catch {
      if (
        knownPaths.has(filePath) ||
        basename(file) === `${accountId}.json`
      ) {
        readFailure = true
      }
      continue
    }

    const identity = readStoredIdentity(data)
    if (identity.kind === 'ambiguous') {
      if (
        mentionsAccount(data, accountId) ||
        knownPaths.has(filePath) ||
        basename(file) === `${accountId}.json`
      ) {
        unsafe = true
      }
      continue
    }
    if (identity.kind === 'unknown') {
      if (
        knownPaths.has(filePath) ||
        basename(file) === `${accountId}.json`
      ) {
        unsafe = true
      }
      continue
    }
    if (identity.accountId !== accountId) {
      continue
    }

    const tokens = asRecord(data.tokens)
    observations.push({
      filePath,
      alias: aliasFromData(data),
      credentialGeneration: credentialGenerationFrom(tokens),
      hasCredentialBearingCopy: hasCredentialBearingCopy(data),
    })
    const observation = observations[observations.length - 1]!
    if (
      observation.hasCredentialBearingCopy &&
      (observation.credentialGeneration === null ||
        !isGeneration(observation.credentialGeneration))
    ) {
      unsafe = true
    }
  }

  return { observations, unsafe, readFailure }
}

function acquireProfileLock(filePath: string): () => void {
  return acquireMutationLockSync(filePath, {
    label: '[codex-signout] Vault',
    waitMs: VAULT_LOCK_WAIT_MS,
  })
}

function cleanVaultPass(
  scan: VaultScan,
  accountId: string,
  expectedGeneration: number,
  record: CodexCredentialLifecycleRecord,
  aliasHint: string | undefined,
): VaultCleanup {
  const observations = [...scan.observations].sort(
    (left, right) => left.filePath.localeCompare(right.filePath),
  )
  const alias =
    observations.map(observation => observation.alias).find(Boolean) ??
    safeAlias(aliasHint)
  let failed = false

  for (const observation of observations) {
    let release: (() => void) | undefined
    try {
      release = acquireProfileLock(observation.filePath)
      if (!existsSync(observation.filePath)) continue

      const parsed = JSON.parse(
        readFileSync(observation.filePath, 'utf8'),
      ) as unknown
      const data = asRecord(parsed)
      if (!data) {
        failed = true
        continue
      }
      const identity = readStoredIdentity(data)
      if (identity.kind === 'ambiguous') {
        if (mentionsAccount(data, accountId)) failed = true
        continue
      }
      if (identity.kind !== 'known' || identity.accountId !== accountId) {
        continue
      }

      const tokens = asRecord(data.tokens)
      const generation = credentialGenerationFrom(tokens)
      const hasCredentials = hasCredentialBearingCopy(data)
      if (
        hasCredentials &&
        (generation === null || generation !== expectedGeneration)
      ) {
        failed = true
        continue
      }

      writeFileAtomicDurableSync(
        observation.filePath,
        `${JSON.stringify(metadataProfile(accountId, alias, record), null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
      chmodSync(observation.filePath, 0o600)
    } catch {
      failed = true
    } finally {
      release?.()
    }
  }

  return {
    ok: !failed,
    profilePaths: observations
      .map(observation => observation.filePath)
      .filter(existsSync),
    discoveredPaths: observations.map(observation => observation.filePath),
    ...(alias ? { alias } : {}),
  }
}

function cleanupVault(
  vaultPath: string | null,
  accountId: string,
  expectedGeneration: number,
  record: CodexCredentialLifecycleRecord,
  hint: TargetHint,
): VaultCleanup {
  const knownPaths = new Set(hint.vaultFilePaths)
  let last: VaultCleanup = {
    ok: true,
    profilePaths: [],
    discoveredPaths: [],
  }

  for (let pass = 0; pass < 2; pass += 1) {
    const scan = scanVault(vaultPath, accountId, knownPaths)
    if (scan.unsafe || scan.readFailure) {
      return {
        ok: false,
        profilePaths: last.profilePaths,
        discoveredPaths: [
          ...last.discoveredPaths,
          ...scan.observations.map(observation => observation.filePath),
        ],
        ...(last.alias ? { alias: last.alias } : {}),
      }
    }
    if (scan.observations.length === 0) {
      return last
    }

    const cleaned = cleanVaultPass(
      scan,
      accountId,
      expectedGeneration,
      record,
      hint.alias,
    )
    last = {
      ok: cleaned.ok,
      profilePaths: cleaned.profilePaths,
      discoveredPaths: [
        ...new Set([
          ...last.discoveredPaths,
          ...cleaned.discoveredPaths,
        ]),
      ],
      ...(cleaned.alias ? { alias: cleaned.alias } : {}),
    }
    knownPaths.clear()
    for (const path of last.discoveredPaths) knownPaths.add(path)
    if (!cleaned.ok) return last
  }

  const finalScan = scanVault(vaultPath, accountId, knownPaths)
  if (finalScan.unsafe || finalScan.readFailure) {
    return {
      ok: false,
      profilePaths: last.profilePaths,
      discoveredPaths: [
        ...new Set([
          ...last.discoveredPaths,
          ...finalScan.observations.map(observation => observation.filePath),
        ]),
      ],
      ...(last.alias ? { alias: last.alias } : {}),
    }
  }
  let finalVerificationFailed = false
  for (const observation of finalScan.observations) {
    let release: (() => void) | undefined
    try {
      release = acquireProfileLock(observation.filePath)
      if (!existsSync(observation.filePath)) continue
      const parsed = JSON.parse(
        readFileSync(observation.filePath, 'utf8'),
      ) as unknown
      const data = asRecord(parsed)
      if (!data) {
        finalVerificationFailed = true
        continue
      }
      const identity = readStoredIdentity(data)
      if (identity.kind === 'ambiguous') {
        if (mentionsAccount(data, accountId)) finalVerificationFailed = true
        continue
      }
      if (
        identity.kind === 'known' &&
        identity.accountId === accountId &&
        hasCredentialBearingCopy(data)
      ) {
        finalVerificationFailed = true
      }
    } catch {
      finalVerificationFailed = true
    } finally {
      release?.()
    }
  }
  if (finalVerificationFailed) {
    return {
      ok: false,
      profilePaths: last.profilePaths,
      discoveredPaths: [
        ...new Set([
          ...last.discoveredPaths,
          ...finalScan.observations.map(observation => observation.filePath),
        ]),
      ],
      ...(last.alias ? { alias: last.alias } : {}),
    }
  }
  return {
    ok: true,
    profilePaths: finalScan.observations
      .map(observation => observation.filePath)
      .filter(existsSync),
    discoveredPaths: [
      ...new Set([
        ...last.discoveredPaths,
        ...finalScan.observations.map(observation => observation.filePath),
      ]),
    ],
    ...(last.alias ? { alias: last.alias } : {}),
  }
}

function deleteVaultPass(
  scan: VaultScan,
  accountId: string,
  expectedGeneration: number,
): VaultCleanup {
  const observations = [...scan.observations].sort(
    (left, right) => left.filePath.localeCompare(right.filePath),
  )
  const alias =
    observations.map(observation => observation.alias).find(Boolean)
  let failed = false

  for (const observation of observations) {
    let release: (() => void) | undefined
    try {
      release = acquireProfileLock(observation.filePath)
      if (!existsSync(observation.filePath)) continue

      const parsed = JSON.parse(
        readFileSync(observation.filePath, 'utf8'),
      ) as unknown
      const data = asRecord(parsed)
      if (!data) {
        failed = true
        continue
      }
      const identity = readStoredIdentity(data)
      if (identity.kind === 'ambiguous') {
        if (mentionsAccount(data, accountId)) failed = true
        continue
      }
      if (identity.kind !== 'known' || identity.accountId !== accountId) {
        continue
      }

      const tokens = asRecord(data.tokens)
      const generation = credentialGenerationFrom(tokens)
      if (
        hasCredentialBearingCopy(data) &&
        (generation === null || generation !== expectedGeneration)
      ) {
        failed = true
        continue
      }

      try {
        unlinkSync(observation.filePath)
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error &&
          error.code === 'ENOENT')) {
          failed = true
          continue
        }
      }
      if (existsSync(observation.filePath)) failed = true
    } catch {
      failed = true
    } finally {
      release?.()
    }
  }

  return {
    ok: !failed,
    profilePaths: [],
    discoveredPaths: observations.map(observation => observation.filePath),
    ...(alias ? { alias } : {}),
  }
}

function deleteVault(
  vaultPath: string | null,
  accountId: string,
  expectedGeneration: number,
  hint: TargetHint,
): VaultCleanup {
  const knownPaths = new Set(hint.vaultFilePaths)
  let last: VaultCleanup = {
    ok: true,
    profilePaths: [],
    discoveredPaths: [],
  }

  for (let pass = 0; pass < 2; pass += 1) {
    const scan = scanVault(vaultPath, accountId, knownPaths)
    if (scan.unsafe || scan.readFailure) {
      return {
        ok: false,
        profilePaths: [],
        discoveredPaths: [
          ...new Set([
            ...last.discoveredPaths,
            ...scan.observations.map(observation => observation.filePath),
          ]),
        ],
        ...(last.alias ? { alias: last.alias } : {}),
      }
    }
    if (scan.observations.length === 0) return last

    const deleted = deleteVaultPass(
      scan,
      accountId,
      expectedGeneration,
    )
    last = {
      ok: deleted.ok,
      profilePaths: [],
      discoveredPaths: [
        ...new Set([
          ...last.discoveredPaths,
          ...deleted.discoveredPaths,
        ]),
      ],
      ...(deleted.alias ?? last.alias
        ? { alias: deleted.alias ?? last.alias }
        : {}),
    }
    knownPaths.clear()
    for (const path of last.discoveredPaths) knownPaths.add(path)
    if (!deleted.ok) return last
  }

  const finalScan = scanVault(vaultPath, accountId, knownPaths)
  if (finalScan.unsafe || finalScan.readFailure || finalScan.observations.length > 0) {
    return {
      ok: false,
      profilePaths: [],
      discoveredPaths: [
        ...new Set([
          ...last.discoveredPaths,
          ...finalScan.observations.map(observation => observation.filePath),
        ]),
      ],
      ...(last.alias ? { alias: last.alias } : {}),
    }
  }
  return last
}

function vaultRootForProfilePath(filePath: string): string | undefined {
  const accountsDir = dirname(filePath)
  if (basename(accountsDir) !== 'accounts') return undefined
  return dirname(accountsDir)
}

function cleanupConfigMirror(
  readConfig: () => GlobalConfig,
  clearMirror: typeof clearCodexOAuthTokensForAccount,
  clearMirrorResult:
    | typeof clearCodexOAuthTokensForAccountResult
    | undefined,
  accountId: string,
  expectedGeneration: number,
): boolean {
  if (clearMirrorResult) {
    let result: CodexOAuthTokenClearResult
    try {
      result = clearMirrorResult(accountId, expectedGeneration)
    } catch {
      return false
    }
    if (result.status === 'failed') return false
    if (
      result.status === 'not_matched' &&
      result.accountId === accountId &&
      result.credentialGeneration !== expectedGeneration
    ) {
      return false
    }
    return true
  }

  let before: GlobalConfig
  try {
    before = readConfig()
  } catch {
    return false
  }
  if (!mirrorMatches(before, accountId, expectedGeneration)) {
    return true
  }

  try {
    clearMirror(accountId, expectedGeneration)
  } catch {
    return false
  }

  let after: GlobalConfig
  try {
    after = readConfig()
  } catch {
    return false
  }
  return !mirrorMatches(after, accountId, expectedGeneration)
}

function cleanupConfigMirrorGenerations(
  readConfig: () => GlobalConfig,
  clearMirror: typeof clearCodexOAuthTokensForAccount,
  clearMirrorResult:
    | typeof clearCodexOAuthTokensForAccountResult
    | undefined,
  accountId: string,
  expectedGenerations: readonly number[],
): boolean {
  const generations = [...new Set(expectedGenerations)]
  for (const generation of generations) {
    let result: CodexOAuthTokenClearResult
    try {
      result = clearMirrorResult
        ? clearMirrorResult(accountId, generation)
        : (() => {
            let before: GlobalConfig
            try {
              before = readConfig()
            } catch {
              return { status: 'failed' as const }
            }
            if (!mirrorMatches(before, accountId, generation)) {
              return { status: 'not_matched' as const }
            }
            try {
              clearMirror(accountId, generation)
            } catch {
              return { status: 'failed' as const }
            }
            let after: GlobalConfig
            try {
              after = readConfig()
            } catch {
              return { status: 'failed' as const }
            }
            return mirrorMatches(after, accountId, generation)
              ? { status: 'failed' as const }
              : { status: 'cleared' as const }
          })()
    } catch {
      return false
    }
    if (result.status === 'failed') return false
    if (
      result.status === 'not_matched' &&
      result.accountId === accountId &&
      result.credentialGeneration !== undefined &&
      !generations.includes(result.credentialGeneration ?? -1)
    ) {
      return false
    }
  }
  return true
}

async function cleanupPhysicalStores(
  input: NormalizedInput,
  record: CodexCredentialLifecycleRecord,
  hint: TargetHint,
  dependencies: CodexAccountSignOutDependencies,
  options: {
    deleteProfiles: boolean
    credentialGeneration: number
    configGenerations: readonly number[]
  },
): Promise<PhysicalCleanup> {
  const configuredVaultPath = (dependencies.getVaultPath ?? getVaultPath)()
  const roots = [
    configuredVaultPath,
    ...hint.vaultFilePaths.map(vaultRootForProfilePath),
  ].filter((path, index, all): path is string =>
    Boolean(path) && all.indexOf(path) === index,
  )
  let vault: VaultCleanup = {
    ok: true,
    profilePaths: [],
    discoveredPaths: [],
  }
  for (const root of roots) {
    const scopedHint = {
      ...hint,
      vaultFilePaths: hint.vaultFilePaths.filter(
        path => vaultRootForProfilePath(path) === root,
      ),
    }
    const cleaned = options.deleteProfiles
      ? deleteVault(
          root,
          input.accountId,
          options.credentialGeneration,
          scopedHint,
        )
      : cleanupVault(
          root,
          input.accountId,
          options.credentialGeneration,
          record,
          scopedHint,
        )
    vault = {
      ok: vault.ok && cleaned.ok,
      profilePaths: [...new Set([...vault.profilePaths, ...cleaned.profilePaths])],
      discoveredPaths: [
        ...new Set([...vault.discoveredPaths, ...cleaned.discoveredPaths]),
      ],
      ...(cleaned.alias ?? vault.alias
        ? { alias: cleaned.alias ?? vault.alias }
        : {}),
    }
  }
  const alias = vault.alias ?? hint.alias
  const clearMirror = dependencies.clearConfigMirror ??
    clearCodexOAuthTokensForAccount
  const clearMirrorResult = dependencies.clearConfigMirrorResult ??
    (dependencies.clearConfigMirror
      ? undefined
      : clearCodexOAuthTokensForAccountResult)
  const configOk = options.configGenerations.length === 1
    ? cleanupConfigMirror(
        dependencies.readConfig ?? getGlobalConfig,
        clearMirror,
        clearMirrorResult,
        input.accountId,
        options.configGenerations[0]!,
      )
    : cleanupConfigMirrorGenerations(
        dependencies.readConfig ?? getGlobalConfig,
        clearMirror,
        clearMirrorResult,
        input.accountId,
        options.configGenerations,
      )
  return {
    ok: vault.ok && configOk,
    profilePaths: vault.profilePaths,
    discoveredPaths: vault.discoveredPaths,
    ...(alias ? { alias } : {}),
  }
}

function codexTokensForAccount(account: PoolAccount): CodexTokens {
  return {
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    expiresAt: account.expiresAt,
    accountId: account.accountId,
    credentialGeneration: account.credentialGeneration,
  }
}

function switchablePoolAccount(
  accountId: string,
  dependencies: CodexAccountSignOutDependencies,
): PoolAccount | undefined {
  const status = (dependencies.getPoolStatus ?? getPoolStatus)()
  const account = status.accounts.find(candidate => candidate.accountId === accountId)
  return account && isCodexAccountSwitchable(account) ? account : undefined
}

function activeIdAfterPointerChange(
  accountId: string | null,
  dependencies: CodexAccountSignOutDependencies,
  lifecycle: Pick<CodexCredentialLifecycle, 'read'>,
): string | null {
  if (!accountId) return null
  const account = switchablePoolAccount(accountId, dependencies)
  if (
    !account ||
    typeof account.accessToken !== 'string' ||
    account.accessToken.length === 0 ||
    typeof account.refreshToken !== 'string' ||
    account.refreshToken.length === 0 ||
    !Number.isFinite(account.expiresAt)
  ) {
    return null
  }
  const lifecycleResult = safeReadLifecycle(lifecycle, accountId)
  return lifecycleResult.status === 'valid' &&
    lifecycleResult.record.state === 'credentialed' &&
    lifecycleResult.record.credentialGeneration ===
      account.credentialGeneration
    ? accountId
    : null
}

async function replaceActiveAccount(
  input: NormalizedInput,
  targetWasActive: boolean,
  dependencies: CodexAccountSignOutDependencies,
): Promise<ActiveReplacement> {
  if (!targetWasActive) {
    return { status: 'unchanged', activeAccountId: null }
  }

  const lifecycle = dependencies.lifecycle ?? codexCredentialLifecycle
  const readConfig = dependencies.readConfig ?? getGlobalConfig
  const replace =
    dependencies.replaceActiveAccount ??
    replaceCodexOAuthActiveAccountIfCurrent
  const getPool = dependencies.getPoolStatus ?? getPoolStatus
  let candidates: readonly PoolAccount[]
  try {
    candidates = getPool().accounts.filter(
      account =>
        account.accountId !== input.accountId &&
        isCodexAccountSwitchable(account),
    )
  } catch {
    return { status: 'retryable_unknown', activeAccountId: null }
  }

  for (const candidate of candidates) {
    try {
      const attempt = await lifecycle.withTransaction(
        candidate.accountId,
        { operationKind: 'refresh', operationId: input.operationId },
        async () => {
          const latest = switchablePoolAccount(candidate.accountId, dependencies)
          if (
            !latest ||
            typeof latest.accessToken !== 'string' ||
            latest.accessToken.length === 0 ||
            typeof latest.refreshToken !== 'string' ||
            latest.refreshToken.length === 0 ||
            !Number.isFinite(latest.expiresAt)
          ) {
            return { status: 'unavailable' as const }
          }

          const lifecycleResult = safeReadLifecycle(
            lifecycle,
            candidate.accountId,
          )
          if (
            lifecycleResult.status !== 'valid' ||
            lifecycleResult.record.state !== 'credentialed' ||
            lifecycleResult.record.credentialGeneration !==
              latest.credentialGeneration
          ) {
            return { status: 'unavailable' as const }
          }

          const activeAccountId = currentActiveAccountId(readConfig)
          if (
            activeAccountId !== input.accountId &&
            activeAccountId !== null
          ) {
            return {
              status: activeIdAfterPointerChange(
                activeAccountId,
                dependencies,
                lifecycle,
              )
                ? ('pointer_changed' as const)
                : ('pointer_invalid' as const),
              activeAccountId,
            }
          }

          const replacement = replace(
            activeAccountId,
            codexTokensForAccount(latest),
          )
          if (replacement.status === 'pointer_changed') {
            return {
              status: 'pointer_changed' as const,
              activeAccountId: replacement.activeAccountId,
            }
          }
          if (replacement.status === 'failed') {
            return {
              status: 'failed' as const,
              activeAccountId: replacement.activeAccountId,
            }
          }
          return {
            status: 'replaced' as const,
            activeAccountId: replacement.activeAccountId,
          }
        },
      )
      if (attempt.status === 'unavailable') continue
      if (attempt.status === 'pointer_changed') {
        const activeAccountId = activeIdAfterPointerChange(
          attempt.activeAccountId,
          dependencies,
          lifecycle,
        )
        if (activeAccountId) setActiveAccount(activeAccountId)
        return {
          status: 'unchanged',
          activeAccountId,
        }
      }
      if (attempt.status === 'pointer_invalid') {
        return { status: 'retryable_unknown', activeAccountId: null }
      }
      if (attempt.status === 'failed') {
        return {
          status: 'retryable_unknown',
          activeAccountId: null,
        }
      }
      const replacedActiveId = activeIdAfterPointerChange(
        attempt.activeAccountId,
        dependencies,
        lifecycle,
      )
      if (replacedActiveId) setActiveAccount(replacedActiveId)
      return {
        status: 'replaced',
        activeAccountId: replacedActiveId,
      }
    } catch {
      return { status: 'retryable_unknown', activeAccountId: null }
    }
  }

  let activeAccountId: string | null
  try {
    activeAccountId = currentActiveAccountId(readConfig)
  } catch {
    return { status: 'retryable_unknown', activeAccountId: null }
  }
  if (activeAccountId !== input.accountId && activeAccountId !== null) {
    const validActive = activeIdAfterPointerChange(
      activeAccountId,
      dependencies,
      lifecycle,
    )
    if (!validActive) {
      return { status: 'retryable_unknown', activeAccountId: null }
    }
    setActiveAccount(validActive)
    return { status: 'none', activeAccountId: validActive }
  }

  try {
    const replacement = replace(activeAccountId, null)
    if (replacement.status === 'failed') {
      return {
        status: 'retryable_unknown',
        activeAccountId: null,
      }
    }
    const replacedActiveId = activeIdAfterPointerChange(
      replacement.activeAccountId,
      dependencies,
      lifecycle,
    )
    if (
      replacement.status === 'pointer_changed' &&
      replacement.activeAccountId !== null &&
      !replacedActiveId
    ) {
      return { status: 'retryable_unknown', activeAccountId: null }
    }
    if (replacedActiveId) setActiveAccount(replacedActiveId)
    return {
      status: replacement.status === 'pointer_changed' ? 'unchanged' : 'none',
      activeAccountId: replacedActiveId,
    }
  } catch {
    return { status: 'retryable_unknown', activeAccountId: null }
  }
}

type PostCleanupExecution =
  | {
      kind: 'applied'
      sideEffectFailed: boolean
      activeReplacement: ActiveReplacement
    }
  | {
      kind: 'superseded'
      record?: CodexCredentialLifecycleRecord
    }
  | {
      kind: 'retryable_unknown'
      record?: CodexCredentialLifecycleRecord
    }

async function applyPostCleanupEffects(
  normalized: NormalizedInput,
  operationKind: 'sign_out' | 'delete',
  execution: Extract<TransactionExecution, { kind: 'ready' }>,
  hint: TargetHint,
  targetWasActive: boolean,
  dependencies: CodexAccountSignOutDependencies,
): Promise<PostCleanupExecution> {
  const lifecycle = dependencies.lifecycle ?? codexCredentialLifecycle
  try {
    return await lifecycle.withTransaction(
      normalized.accountId,
      {
        operationKind,
        operationId: normalized.operationId,
      },
      async () => {
        const currentResult = safeReadLifecycle(
          lifecycle,
          normalized.accountId,
        )
        if (currentResult.status !== 'valid') {
          return {
            kind:
              currentResult.status === 'absent'
                ? ('superseded' as const)
                : ('retryable_unknown' as const),
          }
        }
        if (!isCurrentCleanupRecord(currentResult.record, execution.record)) {
          return {
            kind: 'superseded' as const,
            record: currentResult.record,
          }
        }

        let sideEffectFailed =
          execution.retirementFailed || execution.completionFailed
        const source =
          hint.source === 'vault' || execution.cleanup.profilePaths.length > 0
            ? 'vault'
            : 'config'
        try {
          if (operationKind === 'delete') {
            ;(
              dependencies.reconcileDeletedPool ??
              reconcileCodexAccountDeletion
            )(normalized.accountId)
          } else {
            const reconcile =
              dependencies.reconcilePool ?? reconcileCodexAccountSignOut
            if (source === 'vault') {
              const paths =
                execution.cleanupComplete &&
                execution.cleanup.profilePaths.length > 0
                  ? execution.cleanup.profilePaths
                  : execution.cleanup.discoveredPaths.length > 0
                    ? execution.cleanup.discoveredPaths
                    : hint.vaultFilePaths
              const profile: CodexAccountSignOutProfile = {
                accountId: normalized.accountId,
                ...(safeAlias(execution.cleanup.alias ?? hint.alias)
                  ? {
                      alias: safeAlias(
                        execution.cleanup.alias ?? hint.alias,
                      ),
                    }
                  : {}),
                vaultFilePaths: paths,
                credentialGeneration: execution.record.credentialGeneration,
              }
              reconcile(profile)
            } else {
              reconcile({ accountId: normalized.accountId, source: 'config' })
            }
          }
        } catch {
          sideEffectFailed = true
        }

        const activeReplacement = targetWasActive
          ? await replaceActiveAccount(normalized, targetWasActive, dependencies)
          : { status: 'unchanged' as const, activeAccountId: null }
        if (activeReplacement.status === 'retryable_unknown') {
          sideEffectFailed = true
        }

        try {
          if (dependencies.repairLeases) {
            dependencies.repairLeases(normalized.accountId)
          } else {
            repairLeasesForUnavailableAccount(normalized.accountId, {
              touchReplacementUsage: false,
              persistMainActive: false,
              reason: operationKind === 'delete' ? 'deletion' : 'unavailable',
            })
          }
        } catch {
          sideEffectFailed = true
        }

        try {
          ;(dependencies.resetCodexCacheContext ?? resetCodexCacheContext)()
          ;(dependencies.invalidateUsageCache ?? invalidateUsageCache)()
          await (
            dependencies.clearAuthCaches ??
            (() => clearAuthRelatedCaches({ refreshGrowthBook: false }))
          )()
        } catch {
          sideEffectFailed = true
        }

        return {
          kind: 'applied' as const,
          sideEffectFailed,
          activeReplacement,
        }
      },
    )
  } catch {
    return {
      kind: 'retryable_unknown',
      record: execution.record,
    }
  }
}

async function executeAccountLifecycleCleanup(
  input: CodexAccountSignOutInput,
  dependencies: CodexAccountSignOutDependencies,
  recovery: boolean,
  operationKind: 'sign_out' | 'delete',
): Promise<CodexAccountSignOutResult> {
  const normalized = normalizeInput(input)
  if (!normalized) {
    return {
      status: 'retryable_unknown',
      accountId:
        typeof input?.accountId === 'string' ? input.accountId : '',
      lifecycleGeneration: null,
      lifecycleState: null,
      credentialGeneration: null,
      state: null,
      operationId:
        typeof input?.operationId === 'string' ? input.operationId : '',
      targetWasActive: false,
      replacementActiveAccountId: null,
    }
  }
  if (normalized.expectedCredentialGeneration >= Number.MAX_SAFE_INTEGER) {
    return resultFor(normalized, 'retryable_unknown', undefined, false)
  }

  const lifecycle = dependencies.lifecycle ?? codexCredentialLifecycle
  let resolution: CodexTargetedSignOutResolution
  try {
    resolution = targetResolution(normalized.accountId, dependencies, lifecycle)
  } catch {
    const lifecycleResult = safeReadLifecycle(
      lifecycle,
      normalized.accountId,
    )
    return resultFor(
      normalized,
      'retryable_unknown',
      recordForRead(lifecycleResult),
      false,
    )
  }
  const hint = targetHintFor(resolution)
  const lifecycleBefore = safeReadLifecycle(lifecycle, normalized.accountId)
  const recordBefore = recordForRead(lifecycleBefore)
  let targetWasActive =
    resolution.kind === 'credentialed' && resolution.targetWasActive
  const readConfig = dependencies.readConfig ?? getGlobalConfig
  try {
    const config = readConfig()
    targetWasActive =
      targetWasActive ||
      currentActiveAccountId(() => config) === normalized.accountId ||
      mirrorMatches(
        config,
        normalized.accountId,
        normalized.expectedCredentialGeneration,
      )
  } catch {}

  const matchingCommitted =
    recordBefore !== undefined &&
    isSameCleanupOperation(recordBefore, normalized, operationKind)
  const deletionOfDeniedState =
    operationKind === 'delete' &&
    recordBefore !== undefined &&
    (recordBefore.state === 'signed_out' ||
      recordBefore.state === 'reauth_required') &&
    recordBefore.credentialGeneration === normalized.expectedCredentialGeneration
  if (
    !recovery &&
    (resolution.kind === 'none' || resolution.kind === 'ambiguous') &&
    !matchingCommitted
  ) {
    return resultFor(
      normalized,
      lifecycleBefore.status === 'unreadable' ||
        lifecycleBefore.status === 'malformed'
        ? 'retryable_unknown'
        : 'superseded',
      recordBefore,
      targetWasActive,
    )
  }
  if (
    !recovery &&
    resolution.kind === 'signed_out' &&
    !(matchingCommitted || deletionOfDeniedState)
  ) {
    return resultFor(
      normalized,
      lifecycleBefore.status === 'unreadable' ||
        lifecycleBefore.status === 'malformed'
        ? 'retryable_unknown'
        : 'superseded',
      recordBefore,
      targetWasActive,
    )
  }

  let execution: TransactionExecution
  try {
    execution = await lifecycle.withTransaction(
      normalized.accountId,
      {
        operationKind,
        operationId: normalized.operationId,
      },
      async permit => {
        const currentResult = safeReadLifecycle(
          lifecycle,
          normalized.accountId,
        )
        if (currentResult.status === 'absent') {
          if (
            operationKind !== 'delete' ||
            recovery ||
            normalized.expectedCredentialGeneration !== 0
          ) {
            return { kind: 'superseded' as const }
          }
        } else if (currentResult.status !== 'valid') {
          return { kind: 'retryable_unknown' as const }
        }
        let record: CodexCredentialLifecycleRecord
        let alreadyCommitted = false
        let preserveLifecycle = false
        if (
          currentResult.status === 'valid' &&
          isSameCleanupOperation(currentResult.record, normalized, operationKind)
        ) {
          record = currentResult.record
          alreadyCommitted = true
        } else if (
          operationKind === 'delete' &&
          !recovery &&
          currentResult.status === 'valid' &&
          (currentResult.record.state === 'signed_out' ||
            currentResult.record.state === 'reauth_required') &&
          currentResult.record.credentialGeneration ===
            normalized.expectedCredentialGeneration
        ) {
          record = currentResult.record
          preserveLifecycle = true
        } else if (
          !recovery &&
          (currentResult.status === 'absent' ||
            (currentResult.status === 'valid' &&
              currentResult.record.state === 'credentialed' &&
              currentResult.record.credentialGeneration ===
                normalized.expectedCredentialGeneration))
        ) {
          const signedOut =
            operationKind === 'delete'
              ? lifecycle.deleteAccount(permit, {
                  expectedGeneration: normalized.expectedCredentialGeneration,
                })
              : lifecycle.signOut(permit, {
                  expectedGeneration: normalized.expectedCredentialGeneration,
                })
          if (
            signedOut.status !== 'applied' ||
            signedOut.record.state !== 'signed_out' ||
            signedOut.record.credentialGeneration !==
              normalized.expectedCredentialGeneration + 1
          ) {
            return {
              kind:
                signedOut.status === 'superseded'
                  ? 'superseded'
                  : 'retryable_unknown',
              ...(signedOut.status === 'superseded' && signedOut.record
                ? { record: signedOut.record }
                : {}),
            }
          }
          record = signedOut.record
        } else {
          return {
            kind: 'superseded' as const,
            ...(currentResult.status === 'valid'
              ? { record: currentResult.record }
              : {}),
          }
        }

        const cleanupGeneration =
          operationKind === 'delete' && preserveLifecycle
            ? Math.max(0, record.credentialGeneration - 1)
            : normalized.expectedCredentialGeneration
        let retirementFailed = false
        try {
          (
            dependencies.retireWebSockets ??
            retireCodexWebSocketSessions
          )({
            accountId: normalized.accountId,
            credentialGeneration: cleanupGeneration,
          })
        } catch {
          retirementFailed = true
        }

        let cleanup: PhysicalCleanup
        try {
          await dependencies.beforeCleanup?.(record)
          cleanup = await cleanupPhysicalStores(
            normalized,
            record,
            hint,
            dependencies,
            {
              deleteProfiles: operationKind === 'delete',
              credentialGeneration: cleanupGeneration,
              configGenerations:
                operationKind === 'delete' && preserveLifecycle
                  ? [record.credentialGeneration, cleanupGeneration]
                  : [normalized.expectedCredentialGeneration],
            },
          )
        } catch {
          cleanup = {
            ok: false,
            profilePaths: [],
            discoveredPaths: [],
          }
        }
        if (!cleanup.ok) {
          return {
            kind: 'ready' as const,
            record,
            alreadyCommitted,
            cleanupComplete: false,
            cleanup,
            retirementFailed,
            completionFailed: false,
            preserveLifecycle,
          }
        }

        if (preserveLifecycle) {
          return {
            kind: 'ready' as const,
            record,
            alreadyCommitted,
            cleanupComplete: true,
            cleanup,
            retirementFailed,
            completionFailed: false,
            preserveLifecycle,
          }
        }

        try {
          const completed = lifecycle.completeCleanup(permit, {
            accountId: normalized.accountId,
            credentialGeneration: record.credentialGeneration,
            operationId: record.operationId,
            operationKind,
          })
          if (completed.status === 'applied') {
            return {
              kind: 'ready' as const,
              record: completed.record,
              alreadyCommitted,
              cleanupComplete: true,
              cleanup,
              retirementFailed,
              completionFailed: false,
              preserveLifecycle,
            }
          }
          if (completed.status === 'superseded') {
            return {
              kind: 'superseded' as const,
              ...(completed.record ? { record: completed.record } : {}),
            }
          }
          return {
            kind: 'ready' as const,
            record,
            alreadyCommitted,
            cleanupComplete: false,
            cleanup,
            retirementFailed,
            completionFailed: true,
            preserveLifecycle,
          }
        } catch {
          return {
            kind: 'ready' as const,
            record,
            alreadyCommitted,
            cleanupComplete: false,
            cleanup,
            retirementFailed,
            completionFailed: true,
            preserveLifecycle,
          }
        }
      },
    )
  } catch {
    return resultFor(normalized, 'retryable_unknown', recordBefore, targetWasActive)
  }

  if (execution.kind === 'superseded') {
    return resultFor(
      normalized,
      'superseded',
      execution.record,
      targetWasActive,
    )
  }
  if (execution.kind === 'retryable_unknown') {
    return resultFor(
      normalized,
      'retryable_unknown',
      execution.record,
      targetWasActive,
    )
  }

  const applyEffects = () => applyPostCleanupEffects(
    normalized,
    operationKind,
    execution,
    hint,
    targetWasActive,
    dependencies,
  )
  let postCleanup: PostCleanupExecution
  try {
    postCleanup = targetWasActive
      ? await withActiveReplacementLock(
          lifecycle,
          normalized.accountId,
          applyEffects,
        )
      : await applyEffects()
  } catch {
    postCleanup = { kind: 'retryable_unknown', record: execution.record }
  }
  if (postCleanup.kind === 'superseded') {
    return resultFor(
      normalized,
      'superseded',
      postCleanup.record,
      targetWasActive,
    )
  }
  if (postCleanup.kind === 'retryable_unknown') {
    return resultFor(
      normalized,
      'retryable_unknown',
      postCleanup.record,
      targetWasActive,
    )
  }

  let status: CodexAccountSignOutStatus
  if (postCleanup.sideEffectFailed) {
    status = 'retryable_unknown'
  } else if (!execution.cleanupComplete) {
    status = recovery ? 'retryable_unknown' : 'cleanup_pending'
  } else {
    status = execution.alreadyCommitted
      ? 'already_committed'
      : 'committed'
  }
  return resultFor(
    normalized,
    status,
    execution.record,
    targetWasActive,
    postCleanup.activeReplacement.activeAccountId,
  )
}

export async function signOutCodexAccount(
  input: CodexAccountSignOutInput,
  dependencies: CodexAccountSignOutDependencies = {},
): Promise<CodexAccountSignOutResult> {
  return executeAccountLifecycleCleanup(input, dependencies, false, 'sign_out')
}

export async function recoverCodexAccountSignOut(
  input: CodexAccountSignOutInput,
  dependencies: CodexAccountSignOutDependencies = {},
): Promise<CodexAccountSignOutResult> {
  return executeAccountLifecycleCleanup(input, dependencies, true, 'sign_out')
}

export async function deleteCodexAccount(
  input: CodexAccountDeletionInput,
  dependencies: CodexAccountSignOutDependencies = {},
): Promise<CodexAccountDeletionResult> {
  return executeAccountLifecycleCleanup(input, dependencies, false, 'delete')
}

export async function recoverCodexAccountDeletion(
  input: CodexAccountDeletionInput,
  dependencies: CodexAccountSignOutDependencies = {},
): Promise<CodexAccountDeletionResult> {
  return executeAccountLifecycleCleanup(input, dependencies, true, 'delete')
}

export const performCodexAccountSignOut = signOutCodexAccount
export const recoverLostCodexAccountSignOut = recoverCodexAccountSignOut
export const performCodexAccountDeletion = deleteCodexAccount
export const recoverLostCodexAccountDeletion = recoverCodexAccountDeletion

export function createCodexAccountSignOutOperationId(): string {
  return randomUUID()
}

export function createCodexAccountDeletionOperationId(): string {
  return randomUUID()
}
