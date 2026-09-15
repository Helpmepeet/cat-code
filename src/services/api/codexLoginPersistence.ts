import { randomUUID } from 'crypto'

import {
  appendAccount,
  getCodexProfileInventory,
  saveCodexTokenToVault,
  validateCodexAccountAlias,
  type CodexProfileInventory,
  type PoolAccount,
} from './codexAccountPool.js'
import {
  codexCredentialLifecycle,
  type CodexCredentialLifecycle,
} from './codexCredentialLifecycle.js'
import { saveCodexOAuthTokens } from '../../utils/auth.js'
import type { CodexTokens } from '../oauth/codex-client.js'

export type CodexOAuthLoginPersistenceOptions = Readonly<{
  /**
   * The operation id is minted by the engine before this transaction starts.
   * It is deliberately not derived from renderer or OAuth input.
   */
  operationId: string
  alias?: string
  /**
   * When present, the OAuth identity must be the identity being re-linked.
   * A mismatch is rejected without creating a lifecycle record or moving the
   * original profile's alias.
   */
  expectedAccountId?: string
}>

export type CodexOAuthLoginPersistenceResult = Readonly<{
  accountId: string
  credentialGeneration: number
  source: PoolAccount['source']
  alias?: string
  vaultFilePath?: string
}>

export type CodexOAuthLoginPersistenceErrorCode =
  | 'invalid_account_id'
  | 'identity_mismatch'
  | 'invalid_alias'
  | 'credentials_not_persisted'
  | 'lifecycle_not_prepared'
  | 'lifecycle_not_committed'
  | 'pool_install_failed'

export class CodexOAuthLoginPersistenceError extends Error {
  readonly code: CodexOAuthLoginPersistenceErrorCode

  constructor(code: CodexOAuthLoginPersistenceErrorCode, message?: string) {
    super(message ?? messageForErrorCode(code))
    this.name = 'CodexOAuthLoginPersistenceError'
    this.code = code
  }
}

type VaultSaveResult = ReturnType<typeof saveCodexTokenToVault>

export type CodexOAuthLoginPersistenceDependencies = Readonly<{
  lifecycle?: CodexCredentialLifecycle
  readProfileInventory?: () => CodexProfileInventory
  validateAlias?: typeof validateCodexAccountAlias
  saveConfig?: (tokens: CodexTokens) => boolean | void
  saveVault?: (
    tokens: Parameters<typeof saveCodexTokenToVault>[0],
    options?: Parameters<typeof saveCodexTokenToVault>[1],
  ) => VaultSaveResult
  installPoolAccount?: typeof appendAccount
}>

function messageForErrorCode(
  code: CodexOAuthLoginPersistenceErrorCode,
): string {
  switch (code) {
    case 'invalid_account_id':
      return 'The Codex login returned an invalid account.'
    case 'identity_mismatch':
      return 'The Codex login returned a different account than the one being re-linked.'
    case 'invalid_alias':
      return 'The Codex account name is invalid.'
    case 'credentials_not_persisted':
      return 'Could not save the Codex login credentials.'
    case 'lifecycle_not_prepared':
      return 'Could not authorize the Codex login credentials.'
    case 'lifecycle_not_committed':
      return 'Could not authorize the saved Codex login credentials.'
    case 'pool_install_failed':
      return 'Could not activate the saved Codex login credentials.'
  }
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function findExistingProfile(
  inventory: CodexProfileInventory,
  accountId: string,
): {
  accountId: string
  alias?: string
  vaultFilePath?: string
  vaultFilePaths?: readonly string[]
} | undefined {
  return (
    inventory.accounts.find(account => account.accountId === accountId) ??
    inventory.signedOutProfiles.find(profile => profile.accountId === accountId)
  )
}

function throwLifecycleResultError(
  code: 'lifecycle_not_prepared' | 'lifecycle_not_committed',
): never {
  throw new CodexOAuthLoginPersistenceError(code)
}

/**
 * Authorize and install one fresh Codex OAuth login.
 *
 * The lifecycle account lock stays held across preparation, both durable
 * credential stores, lifecycle commit, and the in-memory pool installation.
 * Tagged credentials written before commit are therefore denied by the
 * existing loaders if this process stops before commit.
 */
export async function persistCodexOAuthLogin(
  tokens: CodexTokens,
  options: CodexOAuthLoginPersistenceOptions,
  dependencies: CodexOAuthLoginPersistenceDependencies = {},
): Promise<CodexOAuthLoginPersistenceResult> {
  if (!isIdentifier(tokens.accountId)) {
    throw new CodexOAuthLoginPersistenceError('invalid_account_id')
  }

  const expectedAccountId = options.expectedAccountId
  if (expectedAccountId !== undefined && !isIdentifier(expectedAccountId)) {
    throw new CodexOAuthLoginPersistenceError('invalid_account_id')
  }
  if (
    expectedAccountId !== undefined &&
    expectedAccountId !== tokens.accountId
  ) {
    throw new CodexOAuthLoginPersistenceError('identity_mismatch')
  }

  const inventory = (
    dependencies.readProfileInventory ?? getCodexProfileInventory
  )()
  const existing = findExistingProfile(inventory, tokens.accountId)
  const trimmedAlias = options.alias?.trim() || undefined
  if (trimmedAlias) {
    const validation = (
      dependencies.validateAlias ?? validateCodexAccountAlias
    )(trimmedAlias, tokens.accountId)
    if (!validation.ok) {
      throw new CodexOAuthLoginPersistenceError(
        'invalid_alias',
        validation.message,
      )
    }
  }
  const alias = trimmedAlias ?? existing?.alias
  const existingVaultFilePath =
    existing?.vaultFilePath &&
    (!existing.vaultFilePaths || existing.vaultFilePaths.length === 1)
      ? existing.vaultFilePath
      : undefined
  const lifecycle =
    dependencies.lifecycle ?? codexCredentialLifecycle
  const saveConfig = dependencies.saveConfig ?? saveCodexOAuthTokens
  const saveVault = dependencies.saveVault ?? saveCodexTokenToVault
  const installPoolAccount =
    dependencies.installPoolAccount ?? appendAccount

  return lifecycle.withTransaction(
    tokens.accountId,
    {
      operationKind: 'login',
      operationId: options.operationId,
    },
    permit => {
      const prepared = lifecycle.prepareLogin(permit)
      if (prepared.status !== 'applied') {
        throwLifecycleResultError('lifecycle_not_prepared')
      }
      const credentialGeneration = prepared.record.credentialGeneration
      const taggedTokens: CodexTokens = {
        ...tokens,
        credentialGeneration,
      }

      let savedVault: VaultSaveResult = null
      try {
        savedVault = saveVault(
          {
            ...taggedTokens,
            alias,
          },
          {
            writer: 'codexLoginPersistence',
            expectedPreviousAccountId: tokens.accountId,
            ...(existingVaultFilePath
              ? { filePath: existingVaultFilePath }
              : {}),
          },
        )
      } catch {
        savedVault = null
      }

      let configSaved = false
      try {
        configSaved = saveConfig(taggedTokens) !== false
      } catch {
        configSaved = false
      }

      if (!savedVault && !configSaved) {
        throw new CodexOAuthLoginPersistenceError('credentials_not_persisted')
      }

      const committed = lifecycle.commitLogin(permit, {
        expectedGeneration: credentialGeneration,
      })
      if (committed.status !== 'applied') {
        throwLifecycleResultError('lifecycle_not_committed')
      }

      try {
        installPoolAccount(
          {
            ...taggedTokens,
            alias,
          },
          {
            writer: 'codexLoginPersistence',
            source: savedVault ? 'vault' : 'config',
            vaultFilePath: savedVault?.filePath,
            activate: true,
          },
        )
      } catch {
        throw new CodexOAuthLoginPersistenceError('pool_install_failed')
      }

      return {
        accountId: tokens.accountId,
        credentialGeneration,
        source: savedVault ? 'vault' : 'config',
        ...(alias ? { alias } : {}),
        ...(savedVault?.filePath
          ? { vaultFilePath: savedVault.filePath }
          : {}),
      }
    },
  )
}

/**
 * Mint an operation id for a login caller that does not otherwise carry one.
 */
export function createCodexOAuthLoginOperationId(): string {
  return randomUUID()
}
