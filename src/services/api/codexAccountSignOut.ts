import { randomUUID } from 'crypto'
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
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
import { acquireMutationLockSync } from '../../utils/lockfile.js'
import { invalidateUsageCache } from './codexUsage.js'
import {
  getVaultPath,
  getPoolStatus,
  getCodexProfileInventory,
  isCodexAccountSwitchable,
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

export type CodexAccountSignOutStatus =
  | 'committed'
  | 'already_committed'
  | 'superseded'
  | 'cleanup_pending'
  | 'retryable_unknown'

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
  repairLeases?: typeof repairLeasesForUnavailableAccount
  resetCodexCacheContext?: typeof resetCodexCacheContext
  invalidateUsageCache?: typeof invalidateUsageCache
  clearAuthCaches?: () => Promise<void>
  beforeCleanup?: (
    record: CodexCredentialLifecycleRecord,
  ) => void | Promise<void>
}>

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

function isSameSignedOutOperation(
  record: CodexCredentialLifecycleRecord,
  input: NormalizedInput,
): boolean {
  return (
    record.state === 'signed_out' &&
    record.operationKind === 'sign_out' &&
    record.operationId === input.operationId &&
    record.credentialGeneration ===
      input.expectedCredentialGeneration + 1
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
        readFailure = true
        continue
      }
      data = record
    } catch {
      readFailure = true
      continue
    }

    const identity = readStoredIdentity(data)
    if (identity.kind === 'ambiguous') {
      unsafe = true
      continue
    }
    if (identity.kind === 'unknown') {
      unsafe = true
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
  let last: VaultCleanup = {
    ok: true,
    profilePaths: [],
    discoveredPaths: [],
  }

  for (let pass = 0; pass < 2; pass += 1) {
    const scan = scanVault(vaultPath, accountId)
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
    if (!cleaned.ok) return last
  }

  const finalScan = scanVault(vaultPath, accountId)
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
    return result.status !== 'failed'
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

async function cleanupPhysicalStores(
  input: NormalizedInput,
  record: CodexCredentialLifecycleRecord,
  hint: TargetHint,
  dependencies: CodexAccountSignOutDependencies,
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
    const cleaned = cleanupVault(
      root,
      input.accountId,
      input.expectedCredentialGeneration,
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
  const configOk = cleanupConfigMirror(
    dependencies.readConfig ?? getGlobalConfig,
    clearMirror,
    clearMirrorResult,
    input.accountId,
    input.expectedCredentialGeneration,
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
): string | null {
  if (!accountId) return null
  return switchablePoolAccount(accountId, dependencies) ? accountId : null
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
            !latest.accessToken ||
            !latest.refreshToken ||
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
              status: 'pointer_changed' as const,
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
        )
        if (activeAccountId) setActiveAccount(activeAccountId)
        return {
          status: 'unchanged',
          activeAccountId,
        }
      }
      if (attempt.status === 'failed') {
        return {
          status: 'retryable_unknown',
          activeAccountId: activeIdAfterPointerChange(
            attempt.activeAccountId,
            dependencies,
          ),
        }
      }
      if (attempt.activeAccountId) setActiveAccount(attempt.activeAccountId)
      return {
        status: 'replaced',
        activeAccountId: activeIdAfterPointerChange(
          attempt.activeAccountId,
          dependencies,
        ),
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
    )
    if (validActive) setActiveAccount(validActive)
    return { status: 'none', activeAccountId: validActive }
  }

  try {
    const replacement = replace(activeAccountId, null)
    if (replacement.status === 'failed') {
      return {
        status: 'retryable_unknown',
        activeAccountId: activeIdAfterPointerChange(
          replacement.activeAccountId,
          dependencies,
        ),
      }
    }
    const replacedActiveId = activeIdAfterPointerChange(
      replacement.activeAccountId,
      dependencies,
    )
    if (replacedActiveId) setActiveAccount(replacedActiveId)
    return {
      status: replacement.status === 'pointer_changed' ? 'unchanged' : 'none',
      activeAccountId: replacedActiveId,
    }
  } catch {
    return { status: 'retryable_unknown', activeAccountId: null }
  }
}

async function executeSignOut(
  input: CodexAccountSignOutInput,
  dependencies: CodexAccountSignOutDependencies,
  recovery: boolean,
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
    resolution = targetResolution(normalized.accountId, dependencies)
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

  if (!recovery && (resolution.kind === 'none' || resolution.kind === 'ambiguous')) {
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
    !(
      recordBefore &&
      isSameSignedOutOperation(recordBefore, normalized)
    )
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
        operationKind: 'sign_out',
        operationId: normalized.operationId,
      },
      async permit => {
        const currentResult = safeReadLifecycle(
          lifecycle,
          normalized.accountId,
        )
        if (currentResult.status !== 'valid') {
          return currentResult.status === 'absent'
            ? { kind: 'superseded' as const }
            : { kind: 'retryable_unknown' as const }
        }
        let record: CodexCredentialLifecycleRecord
        let alreadyCommitted = false
        if (isSameSignedOutOperation(currentResult.record, normalized)) {
          record = currentResult.record
          alreadyCommitted = true
        } else if (
          !recovery &&
          currentResult.record.state === 'credentialed' &&
          currentResult.record.credentialGeneration ===
            normalized.expectedCredentialGeneration
        ) {
          const signedOut = lifecycle.signOut(permit, {
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
          return { kind: 'superseded' as const, record: currentResult.record }
        }

        let retirementFailed = false
        try {
          (
            dependencies.retireWebSockets ??
            retireCodexWebSocketSessions
          )({
            accountId: normalized.accountId,
            credentialGeneration: normalized.expectedCredentialGeneration,
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
          }
        }

        try {
          const completed = lifecycle.completeCleanup(permit, {
            accountId: normalized.accountId,
            credentialGeneration: record.credentialGeneration,
            operationId: record.operationId,
            operationKind: 'sign_out',
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

  let sideEffectFailed =
    execution.retirementFailed || execution.completionFailed
  const source =
    hint.source === 'vault' || execution.cleanup.profilePaths.length > 0
      ? 'vault'
      : 'config'
  try {
    const reconcile =
      dependencies.reconcilePool ?? reconcileCodexAccountSignOut
    if (source === 'vault') {
      const paths =
        execution.cleanupComplete && execution.cleanup.profilePaths.length > 0
          ? execution.cleanup.profilePaths
          : execution.cleanup.discoveredPaths.length > 0
            ? execution.cleanup.discoveredPaths
            : hint.vaultFilePaths
      const profile: CodexAccountSignOutProfile = {
        accountId: normalized.accountId,
        ...(safeAlias(execution.cleanup.alias ?? hint.alias)
          ? { alias: safeAlias(execution.cleanup.alias ?? hint.alias) }
          : {}),
        vaultFilePaths: paths,
        credentialGeneration: execution.record.credentialGeneration,
      }
      reconcile(profile)
    } else {
      reconcile({ accountId: normalized.accountId, source: 'config' })
    }
  } catch {
    sideEffectFailed = true
  }

  try {
    (
      dependencies.repairLeases ?? repairLeasesForUnavailableAccount
    )(normalized.accountId)
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
    ;(dependencies.resetCodexCacheContext ?? resetCodexCacheContext)()
    ;(dependencies.invalidateUsageCache ?? invalidateUsageCache)()
    await (
      dependencies.clearAuthCaches ??
      (() => clearAuthRelatedCaches({ refreshGrowthBook: false }))
    )()
  } catch {
    sideEffectFailed = true
  }

  let status: CodexAccountSignOutStatus
  if (sideEffectFailed) {
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
    activeReplacement.activeAccountId,
  )
}

export async function signOutCodexAccount(
  input: CodexAccountSignOutInput,
  dependencies: CodexAccountSignOutDependencies = {},
): Promise<CodexAccountSignOutResult> {
  return executeSignOut(input, dependencies, false)
}

export async function recoverCodexAccountSignOut(
  input: CodexAccountSignOutInput,
  dependencies: CodexAccountSignOutDependencies = {},
): Promise<CodexAccountSignOutResult> {
  return executeSignOut(input, dependencies, true)
}

export const performCodexAccountSignOut = signOutCodexAccount
export const recoverLostCodexAccountSignOut = recoverCodexAccountSignOut

export function createCodexAccountSignOutOperationId(): string {
  return randomUUID()
}
