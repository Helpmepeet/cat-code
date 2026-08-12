import { feature } from 'bun:bundle'
import type Anthropic from '@anthropic-ai/sdk'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type { QuerySource } from 'src/constants/querySource.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import {
  CodexAccountAuthError,
  CodexAccountCapError,
  CodexResponseFailedError,
} from './codex-fetch-adapter.js'
import {
  failoverCodexLease,
  getCodexLeaseExhaustedMessage,
  getCodexLeaseForOwner,
  getCurrentCodexLease,
  runWithCodexLeaseOwner,
} from './codexAccountLeaseManager.js'
import {
  appendAccount,
  getActiveAccount,
  getPoolStatus,
  canFailover,
  poolManagesCredentials,
  markPoolAccountCapped,
  markPoolAccountQuarantined,
  markPoolAccountLastError,
  markPoolAccountStatus,
  setActiveAccountPersisted,
  switchToAccount,
} from './codexAccountPool.js'
import { maybeRefreshAccount } from '../../codex-core/accounts.js'
import { CodexCoreError } from '../../codex-core/errors.js'
import type { CodexLease } from './codexAccountLeaseManager.js'

function persistMainLeaseActiveAccount(lease: CodexLease | undefined): void {
  if (lease?.ownerType === 'main') {
    setActiveAccountPersisted(lease.accountId)
  }
}
import { isAwsCredentialsProviderError } from 'src/utils/aws.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from 'src/utils/log.js'
import { createSystemAPIErrorMessage } from 'src/utils/messages.js'
import { getAPIProviderForStatsig } from 'src/utils/model/providers.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
  isClaudeAISubscriber,
  isEnterpriseSubscriber,
} from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import {
  type CooldownReason,
  handleFastModeOverageRejection,
  handleFastModeRejectedByAPI,
  isFastModeCooldown,
  isFastModeEnabled,
  triggerFastModeCooldown,
} from '../../utils/fastMode.js'
import { isNonCustomOpusModel } from '../../utils/model/model.js'
import { disableKeepAlive } from '../../utils/proxy.js'
import { sleep } from '../../utils/sleep.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  checkMockRateLimitError,
  isMockRateLimitError,
} from '../rateLimitMocking.js'
import {
  LONG_CONTEXT_ENTITLEMENT_ERROR_MESSAGE,
  REPEATED_529_ERROR_MESSAGE,
} from './errors.js'
import { extractConnectionErrorDetails } from './errorUtils.js'
import { emitAccountDiagnostic } from './accountDiagnostics.js'
import type { DeferredTerminalFailureV1 } from '../../types/message.js'
import { ReauthenticationRequiredError } from './codexTokenRefresh.js'
import {
  failoverClaudeAccount,
  getActiveClaudeAccount,
  getClaudePoolStatus,
  isClaudePoolActive,
} from './claudeAccountPool.js'

const abortError = () => new APIUserAbortError()

const DEFAULT_MAX_RETRIES = 5
const FLOOR_OUTPUT_TOKENS = 3000
const MAX_529_RETRIES = 3
export const BASE_DELAY_MS = 500
// Network-outage backoff window when ≥2 distinct accounts hit
// APIConnectionError in a single retry budget. Long enough for a flaky
// network to come back; short enough that a recovering user isn't stuck.
let codexNetworkOutageMinDelayMs = 5_000
let codexNetworkOutageMaxDelayMs = 10_000

export function _setCodexNetworkOutageDelaysForTest(
  minMs: number,
  maxMs: number,
): void {
  codexNetworkOutageMinDelayMs = minMs
  codexNetworkOutageMaxDelayMs = maxMs
}

export function _resetCodexNetworkOutageDelaysForTest(): void {
  codexNetworkOutageMinDelayMs = 5_000
  codexNetworkOutageMaxDelayMs = 10_000
}

type AccountStatusCounts = Record<string, number>

function countStatuses(
  accounts: readonly { status: string }[],
): AccountStatusCounts | undefined {
  if (accounts.length === 0) {
    return undefined
  }

  const counts: AccountStatusCounts = { total: accounts.length }
  for (const account of accounts) {
    counts[account.status] = (counts[account.status] ?? 0) + 1
  }
  return counts
}

function emitCodexDiagnostic(
  event: Omit<
    Parameters<typeof emitAccountDiagnostic>[0],
    'provider' | 'pool' | 'requested_model' | 'resolved_provider' | 'resolved_model' | 'counts'
  > & { model: string },
): void {
  emitAccountDiagnostic({
    ...event,
    provider: 'openai',
    pool: 'codex',
    requested_model: event.model,
    resolved_provider: 'openai',
    resolved_model: event.model,
    counts: countStatuses(getPoolStatus().accounts),
  })
}

function emitClaudeDiagnostic(
  event: Omit<
    Parameters<typeof emitAccountDiagnostic>[0],
    'provider' | 'pool' | 'requested_model' | 'resolved_provider' | 'resolved_model' | 'counts'
  > & { model: string },
): void {
  emitAccountDiagnostic({
    ...event,
    provider: 'anthropic',
    pool: 'claude',
    requested_model: event.model,
    resolved_provider: 'anthropic',
    resolved_model: event.model,
    counts: countStatuses(getClaudePoolStatus().accounts),
  })
}

function getCodexExhaustionDiagnosticCode(): 'auth.missing' | 'account.pool.unavailable' | 'quota.exhausted' {
  const counts = countStatuses(getPoolStatus().accounts)
  if (!counts) {
    return 'auth.missing'
  }
  const capped = counts.capped ?? 0
  if (capped === counts.total) {
    return 'quota.exhausted'
  }
  return 'account.pool.unavailable'
}

/**
 * Keep the durable terminal code aligned with the diagnostic the same branch
 * just emitted. Only a fully capped pool means wait-for-reset; a pool that
 * still holds a dead or unconfigured account needs repair, and reporting
 * `quota_exhausted` there sends the caller to wait for a reset that will not
 * fix it. Mirrors `throwNoHealthyCodexAccount` in `client.ts`.
 */
function terminalCodeForCodexExhaustion(
  code: ReturnType<typeof getCodexExhaustionDiagnosticCode>,
): DeferredTerminalFailureV1['code'] {
  return code === 'quota.exhausted' ? 'quota_exhausted' : 'account_recovery'
}

function getClaudeUnavailableDiagnosticCode(): 'auth.missing' | 'account.pool.unavailable' {
  return countStatuses(getClaudePoolStatus().accounts) ? 'account.pool.unavailable' : 'auth.missing'
}

function emitCodexFailoverSucceeded(
  model: string,
  accountRef: string,
  reason: string,
): void {
  emitCodexDiagnostic({
    code: 'account.failover.succeeded',
    severity: 'info',
    recoverable: true,
    account_ref: accountRef,
    reason,
    model,
  })
}

// Foreground query sources where the user IS blocking on the result — these
// retry on 529. Everything else (summaries, titles, suggestions, classifiers)
// bails immediately: during a capacity cascade each retry is 3-10× gateway
// amplification, and the user never sees those fail anyway. New sources
// default to no-retry — add here only if the user is waiting on the result.
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  // Security classifiers — must complete for auto-mode correctness.
  // yoloClassifier.ts uses 'auto_mode' (not 'yolo_classifier' — that's
  // type-only). bash_classifier is ant-only; feature-gate so the string
  // tree-shakes out of external builds (excluded-strings.txt).
  'auto_mode',
  ...(feature('BASH_CLASSIFIER') ? (['bash_classifier'] as const) : []),
])

function shouldRetry529(querySource: QuerySource | undefined): boolean {
  // undefined → retry (conservative for untagged call paths)
  return (
    querySource === undefined || FOREGROUND_529_RETRY_SOURCES.has(querySource)
  )
}

// CLAUDE_CODE_UNATTENDED_RETRY: for unattended sessions (ant-only). Retries 429/529
// indefinitely with higher backoff and periodic keep-alive yields so the host
// environment does not mark the session idle mid-wait.
// TODO(ANT-344): the keep-alive via SystemAPIErrorMessage yields is a stopgap
// until there's a dedicated keep-alive channel.
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 30_000

function isPersistentRetryEnabled(): boolean {
  return feature('UNATTENDED_RETRY')
    ? isEnvTruthy(process.env.CLAUDE_CODE_UNATTENDED_RETRY)
    : false
}

function isTransientCapacityError(error: unknown): boolean {
  return (
    is529Error(error) || (error instanceof APIError && error.status === 429)
  )
}

function isStaleConnectionError(error: unknown): boolean {
  if (!(error instanceof APIConnectionError)) {
    return false
  }
  const details = extractConnectionErrorDetails(error)
  return details?.code === 'ECONNRESET' || details?.code === 'EPIPE'
}

function unwrapCodexAccountError(error: unknown): unknown {
  if (!(error instanceof APIConnectionError)) {
    return error
  }
  return error.cause instanceof CodexAccountAuthError ||
    error.cause instanceof CodexAccountCapError ||
    error.cause instanceof CodexResponseFailedError
    ? error.cause
    : error
}

export interface RetryContext {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
}

interface RetryOptions {
  maxRetries?: number
  model: string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  signal?: AbortSignal
  querySource?: QuerySource
  ownerId?: string
  onCodexAccountSwitch?: () => void
  isCodexRequest?: boolean
  isClaudeOAuthRequest?: boolean
  /**
   * Pre-seed the consecutive 529 counter. Used when this retry loop is a
   * non-streaming fallback after a streaming 529 — the streaming 529 should
   * count toward MAX_529_RETRIES so total 529s-before-fallback is consistent
   * regardless of which request mode hit the overload.
   */
  initialConsecutive529Errors?: number
}

export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
    public readonly deferredTerminalFailure?: DeferredTerminalFailureV1,
  ) {
    const message = errorMessage(originalError)
    super(message)
    this.name = 'RetryError'

    // Preserve the original stack trace if available
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

function getLongContextEntitlementError(error: unknown): Error | undefined {
  const originalError =
    error instanceof CannotRetryError ? error.originalError : error
  return originalError instanceof Error &&
    originalError.message.includes(LONG_CONTEXT_ENTITLEMENT_ERROR_MESSAGE)
    ? originalError
    : undefined
}

/**
 * No Codex account could serve the request at all. The credential resolver has
 * already established WHY (and emitted the matching account diagnostic), so the
 * verdict travels with the error instead of being re-inferred downstream: the
 * `APIConnectionError` base class would otherwise be read as `transient_network`
 * and put the durable classification at odds with the emitted diagnostic over
 * the wait-for-reset vs needs-repair decision.
 *
 * Stays an APIConnectionError so existing retry/`instanceof` handling for an
 * unreachable API is unchanged.
 */
export class CodexAccountUnavailableError extends APIConnectionError {
  constructor(
    message: string,
    public readonly terminalCode: DeferredTerminalFailureV1['code'],
  ) {
    super({ message })
    this.name = 'CodexAccountUnavailableError'
  }
}

export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
  }
}

export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (
    client: Anthropic,
    attempt: number,
    context: RetryContext,
  ) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = getMaxRetries(options)
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
    ...(isFastModeEnabled() && { fastMode: options.fastMode }),
  }
  let client: Anthropic | null = null
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0
  let lastError: unknown
  let persistentAttempt = 0
  let codexLeaseFailovers = 0
  // A failover short-circuits the normal retry-delay path with `continue`.
  // Cap those shortcuts to the configured retry budget so a bad 429/auth
  // classification cannot rotate leases indefinitely inside one call.
  const maxCodexLeaseFailovers = Math.max(1, maxRetries)
  // Track distinct accounts that have hit APIConnectionError inside this
  // retry budget. Two distinct accounts failing the same way in quick
  // succession is the signal that the *network* is down, not the accounts.
  const codexConnectionFailureAccounts = new Set<string>()
  let codexNetworkOutageHandled = false

  const throwRetryExhausted = (
    originalError: unknown,
    attemptCount: number,
    accountRef?: string,
    terminalCode?: DeferredTerminalFailureV1['code'],
  ): never => {
    const isCodexTerminal =
      options.isCodexRequest === true ||
      originalError instanceof CodexAccountCapError ||
      originalError instanceof CodexAccountAuthError ||
      originalError instanceof CodexAccountUnavailableError ||
      (options.ownerId !== undefined && poolManagesCredentials())
    const resolvedTerminalCode =
      terminalCode ??
      // Must precede the APIConnectionError arm below: the resolver already
      // decided this verdict, so carry it instead of re-inferring it.
      (originalError instanceof CodexAccountUnavailableError
        ? originalError.terminalCode
        : originalError instanceof CodexAccountCapError
          ? 'quota_exhausted'
          : originalError instanceof CodexAccountAuthError
            ? 'account_recovery'
            : originalError instanceof APIConnectionError
              ? 'transient_network'
              : originalError instanceof APIError && originalError.status === 429
                ? 'ambiguous_rate_limit'
                : undefined)
    const deferredTerminalFailure: DeferredTerminalFailureV1 | undefined =
      isCodexTerminal && resolvedTerminalCode
        ? {
            version: 1,
            provider: 'openai',
            code: resolvedTerminalCode,
            observedAt: Date.now(),
          }
        : undefined
    if (
      options.isCodexRequest === true ||
      originalError instanceof CodexAccountCapError ||
      originalError instanceof CodexAccountAuthError ||
      (options.ownerId !== undefined && poolManagesCredentials())
    ) {
      emitCodexDiagnostic({
        code: 'account.retry.exhausted',
        severity: 'error',
        recoverable: false,
        account_ref: accountRef,
        reason: `retry chain exhausted after attempts=${attemptCount}: ${errorMessage(originalError)}`,
        model: retryContext.model,
      })
    }
    throw new CannotRetryError(
      originalError,
      retryContext,
      deferredTerminalFailure,
    )
  }

  const assertCodexLeaseFailoverBudget = (
    originalError: unknown,
    attemptCount: number,
    accountRef?: string,
  ): void => {
    if (codexLeaseFailovers >= maxCodexLeaseFailovers) {
      throwRetryExhausted(
        originalError instanceof Error
          ? originalError
          : new Error('Codex lease failover limit reached'),
        attemptCount,
        accountRef,
        // Budget exhaustion bails BEFORE capping/failing over the current
        // account, so selectable accounts may remain and pool-wide quota
        // exhaustion was never established. Class-based inference would read
        // `quota_exhausted` off the CodexAccountCapError and authorize an
        // unattended /continue-after-limit resume on evidence we never
        // gathered. Report the 429 we actually saw, not a verdict we didn't.
        originalError instanceof CodexAccountCapError
          ? 'ambiguous_rate_limit'
          : undefined,
      )
    }
  }

  const noteCodexLeaseFailover = (): void => {
    codexLeaseFailovers++
  }

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new APIUserAbortError()
    }

    // Capture whether fast mode is active before this attempt
    // (fallback may change the state mid-loop)
    const wasFastModeActive = isFastModeEnabled()
      ? retryContext.fastMode && !isFastModeCooldown()
      : false

    try {
      // Check for mock rate limits (used by /mock-limits command for Ant employees)
      if (process.env.USER_TYPE === 'ant') {
        const mockError = checkMockRateLimitError(
          retryContext.model,
          wasFastModeActive,
        )
        if (mockError) {
          throw mockError
        }
      }

      // Get a fresh client instance on first attempt or after authentication errors
      // - 401 for first-party API authentication failures
      // - 403 "OAuth token has been revoked" (another process refreshed the token)
      // - Bedrock-specific auth errors (403 or CredentialsProviderError)
      // - Vertex-specific auth errors (credential refresh failures, 401)
      // - ECONNRESET/EPIPE: stale keep-alive socket; disable pooling and reconnect
      const isStaleConnection = isStaleConnectionError(lastError)
      if (
        isStaleConnection &&
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_disable_keepalive_on_econnreset',
          false,
        )
      ) {
        logForDebugging(
          'Stale connection (ECONNRESET/EPIPE) — disabling keep-alive for retry',
        )
        disableKeepAlive()
      }

      return await runWithCodexLeaseOwner(options.ownerId, async () => {
        if (
          client === null ||
          (lastError instanceof APIError && lastError.status === 401) ||
          isOAuthTokenRevokedError(lastError) ||
          isBedrockAuthError(lastError) ||
          isVertexAuthError(lastError) ||
          isStaleConnection
        ) {
          // On 401 "token expired" or 403 "token revoked", force a token refresh
          if (
            options.isClaudeOAuthRequest === true &&
            ((lastError instanceof APIError && lastError.status === 401) ||
              isOAuthTokenRevokedError(lastError))
          ) {
            const failedAccount = getActiveClaudeAccount()
            const failedAccessToken = getClaudeAIOAuthTokens()?.accessToken
            const recovered = failedAccessToken
              ? await handleOAuth401Error(failedAccessToken)
              : false

            if (!recovered && isClaudePoolActive() && failedAccount) {
              emitClaudeDiagnostic({
                code: 'account.token_refresh.failed',
                severity: 'warning',
                recoverable: true,
                account_ref: failedAccount.accountUuid,
                reason: 'active Claude account failed OAuth recovery',
                model: retryContext.model,
              })

              const replacementAccount = failoverClaudeAccount(
                failedAccount.accountUuid,
                'OAuth recovery failed after 401',
              )
              if (replacementAccount) {
                emitClaudeDiagnostic({
                  code: 'account.failover.succeeded',
                  severity: 'info',
                  recoverable: true,
                  account_ref: replacementAccount.accountUuid,
                  reason: 'switched to a healthy Claude account after OAuth failure',
                  model: retryContext.model,
                })
              } else {
                emitClaudeDiagnostic({
                  code: getClaudeUnavailableDiagnosticCode(),
                  severity: 'error',
                  recoverable: false,
                  account_ref: failedAccount.accountUuid,
                  reason: 'no healthy Claude account is available after OAuth failure',
                  model: retryContext.model,
                })
                throw new Error(
                  'No healthy Claude account is available after OAuth failure.',
                )
              }
            }
          }
          client = await getClient()
        }

        return operation(client, attempt, retryContext)
      })
    } catch (caughtError) {
      const error = unwrapCodexAccountError(caughtError)
      lastError = error
      logForDebugging(
        `API error (attempt ${attempt}/${maxRetries + 1}): ${error instanceof APIError ? `${error.status} ${error.message}` : errorMessage(error)}`,
        { level: 'error' },
      )

      const longContextEntitlementError = getLongContextEntitlementError(error)
      if (longContextEntitlementError) {
        throwRetryExhausted(longContextEntitlementError, attempt)
      }

      // `response.failed` is a completed upstream verdict (for example, an
      // invalid request or policy rejection), not a transport outage. The SDK
      // can wrap it in APIConnectionError, so stop before generic retry or
      // account failover resends the same deterministic failure.
      if (error instanceof CodexResponseFailedError) {
        throw new CannotRetryError(error, retryContext)
      }

      // Codex account failover: on 429 from a pool-managed account, cap
      // the failed account. Rotate only when another selectable account exists.
      if (error instanceof CodexAccountCapError) {
        const currentLease =
          getCurrentCodexLease() ??
          (options.ownerId ? getCodexLeaseForOwner(options.ownerId) : undefined)
        const canRotateBeforeCap = canFailover()
        if (currentLease && canRotateBeforeCap) {
          try {
            assertCodexLeaseFailoverBudget(error, attempt, currentLease.accountId)
            const nextLease = failoverCodexLease(
              currentLease.ownerId,
              error.accountId,
              error.message,
            )
            persistMainLeaseActiveAccount(nextLease)
            emitCodexFailoverSucceeded(
              retryContext.model,
              nextLease.accountId,
              'usage cap failover succeeded',
            )
            logForDebugging(
              `[codex-pool] Reassigned lease ${currentLease.ownerId} from ${error.accountId} to ${nextLease.accountId} on 429`,
            )
            options.onCodexAccountSwitch?.()
            client = null
            noteCodexLeaseFailover()
            continue
          } catch (failoverError) {
            if (failoverError instanceof CannotRetryError) {
              throw failoverError
            }
            const exhaustionCode = getCodexExhaustionDiagnosticCode()
            emitCodexDiagnostic({
              code: exhaustionCode,
              severity: 'error',
              recoverable: false,
              account_ref: error.accountId,
              reason: 'no healthy Codex account remained after usage cap failover',
              model: retryContext.model,
            })
            throwRetryExhausted(
              failoverError instanceof Error
                ? failoverError
                : new Error(getCodexLeaseExhaustedMessage()),
              attempt,
              error.accountId,
              terminalCodeForCodexExhaustion(exhaustionCode),
            )
          }
        }

        if (poolManagesCredentials()) {
          markPoolAccountCapped(error.accountId, error.message, {
            rerollActive: false,
          })

          // No active lease — this is a main-session (no subagent) request.
          // Directly rotate the pool's active account and retry when possible.
          if (!currentLease && canRotateBeforeCap) {
            const next = switchToAccount(null)
            if (next) {
              emitCodexFailoverSucceeded(
                retryContext.model,
                next.accountId,
                'usage cap failover succeeded',
              )
              logForDebugging(
                `[codex-pool] Main session rotated from ${error.accountId} to ${next.accountId} on cap error`,
              )
              options.onCodexAccountSwitch?.()
              client = null
              continue
            }
          }

          const exhaustionCode = getCodexExhaustionDiagnosticCode()
          emitCodexDiagnostic({
            code: exhaustionCode,
            severity: 'error',
            recoverable: false,
            account_ref: error.accountId,
            reason: 'no healthy Codex account remained after usage cap failover',
            model: retryContext.model,
          })
          throwRetryExhausted(
            new Error(getCodexLeaseExhaustedMessage()),
            attempt,
            error.accountId,
            terminalCodeForCodexExhaustion(exhaustionCode),
          )
        }
      }

      if (error instanceof CodexAccountAuthError) {
        const currentLease =
          getCurrentCodexLease() ??
          (options.ownerId ? getCodexLeaseForOwner(options.ownerId) : undefined)
        // Recovery targets the account that actually made the failed request,
        // NOT the lease's current account. A delayed 401 can arrive after the
        // owner's lease already moved on (concurrent failover); refreshing or
        // dead-marking whatever the lease now points at would condemn the wrong
        // (possibly healthy) account.
        const accountId = error.accountId
        const leaseStillOnFailedAccount = currentLease?.accountId === accountId
        const currentAccount = getPoolStatus().accounts.find(
          account => account.accountId === accountId,
        )
        const canRotateBeforeAuthBlock = canFailover()

        let refreshRecovered = false
        let refreshFailure: unknown
        if (poolManagesCredentials() && currentAccount?.refreshToken) {
          try {
            // Route post-401 recovery through the single refresh entry point,
            // forced past the local expiry gate (the 401 may be a server-side
            // revoke/rotate on a still-fresh token). maybeRefreshAccount
            // dispatches vault-vs-raw — so a config / no-vault account is
            // refreshed here too (previously skipped for lack of vaultFilePath)
            // — with full DR-2 cross-process safety.
            const refreshed = await maybeRefreshAccount(
              {
                accountId: currentAccount.accountId,
                accessToken: currentAccount.accessToken,
                refreshToken: currentAccount.refreshToken,
                expiresAt: currentAccount.expiresAt,
                profile: currentAccount.alias ?? currentAccount.accountId,
                source: currentAccount.source,
                alias: currentAccount.alias,
                vaultFilePath: currentAccount.vaultFilePath,
              },
              { force: true },
            )
            if (refreshed.accountId === currentAccount.accountId) {
              // Publish the rotation to the in-memory pool so the client rebuild
              // below reads the live token. The vault path already does this via
              // appendAccount; the raw/config path only persists to disk, so
              // without this the resolver would re-serve the stale pool token.
              appendAccount(
                {
                  accessToken: refreshed.accessToken,
                  refreshToken: refreshed.refreshToken,
                  expiresAt: refreshed.expiresAt,
                  accountId: refreshed.accountId,
                  alias: refreshed.alias ?? currentAccount.alias,
                },
                {
                  preserveCapped: true,
                  writer: 'withRetry.codexAuthRecovery',
                  source:
                    refreshed.source === 'config' ? 'config' : currentAccount.source,
                  vaultFilePath: refreshed.vaultFilePath ?? currentAccount.vaultFilePath,
                },
              )
              refreshRecovered = true
            }
            // An identity change is already reconciled inside
            // maybeRefreshAccount (old marked dead, new appended); fall through
            // to the dead-mark + failover path below for the stale lease.
          } catch (err) {
            refreshFailure = err
            // maybeRefreshAccount already records the underlying failure state
            // (vault refresh machine / raw-with-ledger).
          }
        }

        if (refreshRecovered) {
          client = null
          continue
        }

        if (poolManagesCredentials()) {
          // maybeRefreshAccount wraps a definitive re-login verdict as
          // CodexCoreError(code 'auth'); anything else (network/backend) is a
          // transient the quarantine-and-retry branch should own.
          const refreshFailureIsAuth =
            refreshFailure instanceof ReauthenticationRequiredError ||
            (refreshFailure instanceof CodexCoreError && refreshFailure.code === 'auth')
          // Keep the durable classification aligned with the quarantine-vs-dead
          // decision made just below. A non-auth refresh failure is a
          // connection problem, so the credentials were never rejected and
          // `account_recovery` would send the user to repair nothing.
          const authTerminalCode: DeferredTerminalFailureV1['code'] =
            refreshFailure && !refreshFailureIsAuth
              ? 'transient_network'
              : 'account_recovery'
          if (refreshFailure && !refreshFailureIsAuth) {
            markPoolAccountQuarantined(
              accountId,
              'connection problem during token refresh; retrying',
              { rerollActive: false },
            )
          } else {
            markPoolAccountStatus(
              accountId,
              'dead',
              'Codex account authentication failed',
              { rerollActive: false },
            )
          }
          emitCodexDiagnostic({
            code: 'account.token_refresh.failed',
            severity: 'warning',
            recoverable: true,
            account_ref: accountId,
            reason: 'Codex account authentication failed and refresh did not recover it',
            model: retryContext.model,
          })

          // Fail over the lease ONLY if it still points at the failed account.
          if (currentLease && leaseStillOnFailedAccount && canRotateBeforeAuthBlock) {
            try {
              assertCodexLeaseFailoverBudget(error, attempt, currentLease.accountId)
              const nextLease = failoverCodexLease(
                currentLease.ownerId,
                accountId,
                'Codex account authentication failed',
                { markAccountCapped: false },
              )
              persistMainLeaseActiveAccount(nextLease)
              emitCodexFailoverSucceeded(
                retryContext.model,
                nextLease.accountId,
                'authentication failover succeeded',
              )
              options.onCodexAccountSwitch?.()
              client = null
              noteCodexLeaseFailover()
              continue
            } catch (failoverError) {
              if (failoverError instanceof CannotRetryError) {
                throw failoverError
              }
              emitCodexDiagnostic({
                code: 'account.pool.unavailable',
                severity: 'error',
                recoverable: false,
                account_ref: accountId,
                reason: 'no healthy Codex account remained after authentication failure',
                model: retryContext.model,
              })
              throwRetryExhausted(
                failoverError instanceof Error
                  ? failoverError
                  : new Error(getCodexLeaseExhaustedMessage()),
                attempt,
                accountId,
                authTerminalCode,
              )
            }
          }

          // The lease already moved off the failed account before this delayed
          // 401 landed. We dead-marked the failed account above; retry on the
          // lease's current (healthy) account instead of touching it or
          // declaring exhaustion.
          if (currentLease && !leaseStillOnFailedAccount) {
            client = null
            continue
          }

          if (!currentLease && canRotateBeforeAuthBlock) {
            const next = switchToAccount(null)
            if (next) {
              emitCodexFailoverSucceeded(
                retryContext.model,
                next.accountId,
                'authentication failover succeeded',
              )
              options.onCodexAccountSwitch?.()
              client = null
              continue
            }
          }

          emitCodexDiagnostic({
            code: 'account.pool.unavailable',
            severity: 'error',
            recoverable: false,
            account_ref: accountId,
            reason: 'no healthy Codex account remained after authentication failure',
            model: retryContext.model,
          })
          throwRetryExhausted(
            new Error(getCodexLeaseExhaustedMessage()),
            attempt,
            accountId,
            authTerminalCode,
          )
        }
      }

      // Network-outage tracking: record every Codex APIConnectionError, even
      // on attempt 1, so the outage trigger inside the `attempt >= 2`
      // failover block below has the full picture. The repro pattern from
      // the network-recovery bug report (user returns from idle, very first
      // prompt fails) hits this code on attempt 1 — recording attempt-1
      // failures lets a single follow-up attempt on a different account
      // trip the outage detector instead of needing 2+ failovers.
      if (
        error instanceof APIConnectionError &&
        options.isCodexRequest === true &&
        poolManagesCredentials()
      ) {
        const trackingLease =
          getCurrentCodexLease() ??
          (options.ownerId ? getCodexLeaseForOwner(options.ownerId) : undefined)
        const trackingAccountId =
          trackingLease?.accountId ?? getActiveAccount()?.accountId
        if (trackingAccountId) {
          codexConnectionFailureAccounts.add(trackingAccountId)
        }
      }

      // Codex connection-error failover: after two consecutive connection
      // errors on a confirmed Codex request, try a different pooled account
      // without converting the failed account into usage-cap state.
      if (
        error instanceof APIConnectionError &&
        options.isCodexRequest === true &&
        canFailover() &&
        attempt >= 2
      ) {
        const currentLease =
          getCurrentCodexLease() ??
          (options.ownerId ? getCodexLeaseForOwner(options.ownerId) : undefined)
        const accountId = currentLease?.accountId ?? getActiveAccount()?.accountId
        if (accountId) {
          emitCodexDiagnostic({
            code: 'account.transient_failure',
            severity: 'warning',
            recoverable: true,
            account_ref: accountId,
            reason: error.message,
            model: retryContext.model,
          })

          // Network-outage detection: if two distinct accounts have hit
          // APIConnectionError in this retry budget, rotating leases is
          // futile — the network itself is down. Recycle the HTTPS keep-alive
          // pool (the OS may have invalidated the underlying sockets while
          // the connection was down) and take one longer backoff so a
          // recovering network has time to come back without burning the
          // remaining retry budget.
          if (
            codexConnectionFailureAccounts.size >= 2 &&
            !codexNetworkOutageHandled
          ) {
            codexNetworkOutageHandled = true
            disableKeepAlive()
            emitCodexDiagnostic({
              code: 'account.transient_failure',
              severity: 'warning',
              recoverable: true,
              account_ref: accountId,
              reason:
                'suspected network outage — multiple accounts hit connection errors in quick succession',
              model: retryContext.model,
            })
            const outageDelayMs =
              codexNetworkOutageMinDelayMs +
              Math.random() *
                Math.max(
                  0,
                  codexNetworkOutageMaxDelayMs - codexNetworkOutageMinDelayMs,
                )
            logForDebugging(
              `[codex-pool] Suspected network outage after ${codexConnectionFailureAccounts.size} accounts failed with connection errors; recycling keep-alive and waiting ${Math.round(outageDelayMs)}ms`,
            )
            yield createSystemAPIErrorMessage(error, outageDelayMs, attempt, maxRetries)
            await sleep(outageDelayMs, options.signal, { abortError })
            client = null
            continue
          }

          const failoverBackoffMs = getRetryDelay(attempt, null)
          if (currentLease) {
            try {
              assertCodexLeaseFailoverBudget(error, attempt, currentLease.accountId)
              const nextLease = failoverCodexLease(
                currentLease.ownerId,
                accountId,
                error.message,
                { markAccountCapped: false },
              )
              persistMainLeaseActiveAccount(nextLease)
              emitCodexFailoverSucceeded(
                retryContext.model,
                nextLease.accountId,
                'transient connection failover succeeded',
              )
              logForDebugging(
                `[codex-pool] Reassigned lease ${currentLease.ownerId} from ${accountId} to ${nextLease.accountId} on connection error`,
              )
              options.onCodexAccountSwitch?.()
              client = null
              noteCodexLeaseFailover()
              yield createSystemAPIErrorMessage(error, failoverBackoffMs, attempt, maxRetries)
              await sleep(failoverBackoffMs, options.signal, { abortError })
              continue
            } catch (failoverError) {
              if (failoverError instanceof CannotRetryError) {
                throw failoverError
              }
              emitCodexDiagnostic({
                code: 'account.pool.unavailable',
                severity: 'error',
                recoverable: false,
                account_ref: accountId,
                reason: 'no healthy Codex account remained after a transient connection failure',
                model: retryContext.model,
              })
              // Fall through — pool exhausted, let normal retry exhaust too
            }
          } else {
            markPoolAccountLastError(accountId)
            const next = switchToAccount(null)
            if (next) {
              emitCodexFailoverSucceeded(
                retryContext.model,
                next.accountId,
                'transient connection failover succeeded',
              )
              logForDebugging(
                `[codex-pool] Main session rotated from ${accountId} to ${next.accountId} on connection error`,
              )
              options.onCodexAccountSwitch?.()
              client = null
              yield createSystemAPIErrorMessage(error, failoverBackoffMs, attempt, maxRetries)
              await sleep(failoverBackoffMs, options.signal, { abortError })
              continue
            }
            emitCodexDiagnostic({
              code: 'account.pool.unavailable',
              severity: 'error',
              recoverable: false,
              account_ref: accountId,
              reason: 'no healthy Codex account remained after a transient connection failure',
              model: retryContext.model,
            })
          }
        }
      }

      // Fast mode fallback: on 429/529, either wait and retry (short delays)
      // or fall back to standard speed (long delays) to avoid cache thrashing.
      // Skip in persistent mode: the short-retry path below loops with fast
      // mode still active, so its `continue` never reaches the attempt clamp
      // and the for-loop terminates. Persistent sessions want the chunked
      // keep-alive path instead of fast-mode cache-preservation anyway.
      if (
        wasFastModeActive &&
        !isPersistentRetryEnabled() &&
        error instanceof APIError &&
        (error.status === 429 || is529Error(error))
      ) {
        // If the 429 is specifically because extra usage (overage) is not
        // available, permanently disable fast mode with a specific message.
        const overageReason = error.headers?.get(
          'anthropic-ratelimit-unified-overage-disabled-reason',
        )
        if (overageReason !== null && overageReason !== undefined) {
          handleFastModeOverageRejection(overageReason)
          retryContext.fastMode = false
          continue
        }

        const retryAfterMs = getRetryAfterMs(error)
        if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
          // Short retry-after: wait and retry with fast mode still active
          // to preserve prompt cache (same model name on retry).
          await sleep(retryAfterMs, options.signal, { abortError })
          continue
        }
        // Long or unknown retry-after: enter cooldown (switches to standard
        // speed model), with a minimum floor to avoid flip-flopping.
        const cooldownMs = Math.max(
          retryAfterMs ?? DEFAULT_FAST_MODE_FALLBACK_HOLD_MS,
          MIN_COOLDOWN_MS,
        )
        const cooldownReason: CooldownReason = is529Error(error)
          ? 'overloaded'
          : 'rate_limit'
        triggerFastModeCooldown(Date.now() + cooldownMs, cooldownReason)
        if (isFastModeEnabled()) {
          retryContext.fastMode = false
        }
        continue
      }

      // Fast mode fallback: if the API rejects the fast mode parameter
      // (e.g., org doesn't have fast mode enabled), permanently disable fast
      // mode and retry at standard speed.
      if (wasFastModeActive && isFastModeNotEnabledError(error)) {
        handleFastModeRejectedByAPI()
        retryContext.fastMode = false
        continue
      }

      // Non-foreground sources bail immediately on 529 — no retry amplification
      // during capacity cascades. User never sees these fail.
      if (is529Error(error) && !shouldRetry529(options.querySource)) {
        logEvent('tengu_api_529_background_dropped', {
          query_source:
            options.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throwRetryExhausted(error, attempt)
      }

      // Track consecutive 529 errors
      if (
        is529Error(error) &&
        // If FALLBACK_FOR_ALL_PRIMARY_MODELS is not set, fall through only if the primary model is a non-custom Opus model.
        // TODO: Revisit if the isNonCustomOpusModel check should still exist, or if isNonCustomOpusModel is a stale artifact of when Cat Code was hardcoded on Opus.
        (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
          (!isClaudeAISubscriber() && isNonCustomOpusModel(options.model)))
      ) {
        consecutive529Errors++
        if (consecutive529Errors >= MAX_529_RETRIES) {
          // Check if fallback model is specified
          if (options.fallbackModel) {
            logEvent('tengu_api_opus_fallback_triggered', {
              original_model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                options.fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              provider: getAPIProviderForStatsig(),
            })

            // Throw special error to indicate fallback was triggered
            throw new FallbackTriggeredError(
              options.model,
              options.fallbackModel,
            )
          }

          if (
            process.env.USER_TYPE === 'external' &&
            !process.env.IS_SANDBOX &&
            !isPersistentRetryEnabled()
          ) {
            logEvent('tengu_api_custom_529_overloaded_error', {})
            throwRetryExhausted(
              new Error(REPEATED_529_ERROR_MESSAGE),
              attempt,
            )
          }
        }
      }

      // Only retry if the error indicates we should
      const persistent =
        isPersistentRetryEnabled() && isTransientCapacityError(error)
      if (attempt > maxRetries && !persistent) {
        throwRetryExhausted(error, attempt)
      }

      // AWS/GCP errors aren't always APIError, but can be retried
      const handledCloudAuthError =
        handleAwsCredentialError(error) || handleGcpCredentialError(error)
      if (
        !handledCloudAuthError &&
        (!(error instanceof APIError) || !shouldRetry(error))
      ) {
        throwRetryExhausted(error, attempt)
      }

      // Handle max tokens context overflow errors by adjusting max_tokens for the next attempt
      // NOTE: With extended-context-window beta, this 400 error should not occur.
      // The API now returns 'model_context_window_exceeded' stop_reason instead.
      // Keeping for backward compatibility.
      if (error instanceof APIError) {
        const overflowData = parseMaxTokensContextOverflowError(error)
        if (overflowData) {
          const { inputTokens, contextLimit } = overflowData

          const safetyBuffer = 1000
          const availableContext = Math.max(
            0,
            contextLimit - inputTokens - safetyBuffer,
          )
          if (availableContext < FLOOR_OUTPUT_TOKENS) {
            logError(
              new Error(
                `availableContext ${availableContext} is less than FLOOR_OUTPUT_TOKENS ${FLOOR_OUTPUT_TOKENS}`,
              ),
            )
            throw error
          }
          // Ensure we have enough tokens for thinking + at least 1 output token
          const minRequired =
            (retryContext.thinkingConfig.type === 'enabled'
              ? retryContext.thinkingConfig.budgetTokens
              : 0) + 1
          const adjustedMaxTokens = Math.max(
            FLOOR_OUTPUT_TOKENS,
            availableContext,
            minRequired,
          )
          retryContext.maxTokensOverride = adjustedMaxTokens

          logEvent('tengu_max_tokens_context_overflow_adjustment', {
            inputTokens,
            contextLimit,
            adjustedMaxTokens,
            attempt,
          })

          continue
        }
      }

      // For other errors, proceed with normal retry logic
      // Get retry-after header if available
      const retryAfter = getRetryAfter(error)
      let delayMs: number
      if (persistent && error instanceof APIError && error.status === 429) {
        persistentAttempt++
        // Window-based limits (e.g. 5hr Max/Pro) include a reset timestamp.
        // Wait until reset rather than polling every 5 min uselessly.
        const resetDelay = getRateLimitResetDelayMs(error)
        delayMs =
          resetDelay ??
          Math.min(
            getRetryDelay(
              persistentAttempt,
              retryAfter,
              PERSISTENT_MAX_BACKOFF_MS,
            ),
            PERSISTENT_RESET_CAP_MS,
          )
      } else if (persistent) {
        persistentAttempt++
        // Retry-After is a server directive and bypasses maxDelayMs inside
        // getRetryDelay (intentional — honoring it is correct). Cap at the
        // 6hr reset-cap here so a pathological header can't wait unbounded.
        delayMs = Math.min(
          getRetryDelay(
            persistentAttempt,
            retryAfter,
            PERSISTENT_MAX_BACKOFF_MS,
          ),
          PERSISTENT_RESET_CAP_MS,
        )
      } else {
        delayMs = getRetryDelay(attempt, retryAfter)
      }

      // In persistent mode the for-loop `attempt` is clamped at maxRetries+1;
      // use persistentAttempt for telemetry/yields so they show the true count.
      const reportedAttempt = persistent ? persistentAttempt : attempt
      logEvent('tengu_api_retry', {
        attempt: reportedAttempt,
        delayMs: delayMs,
        error: (error as APIError)
          .message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        status: (error as APIError).status,
        provider: getAPIProviderForStatsig(),
      })

      if (persistent) {
        if (delayMs > 60_000) {
          logEvent('tengu_api_persistent_retry_wait', {
            status: (error as APIError).status,
            delayMs,
            attempt: reportedAttempt,
            provider: getAPIProviderForStatsig(),
          })
        }
        // Chunk long sleeps so the host sees periodic stdout activity and
        // does not mark the session idle. Each yield surfaces as
        // {type:'system', subtype:'api_retry'} on stdout via QueryEngine.
        let remaining = delayMs
        while (remaining > 0) {
          if (options.signal?.aborted) throw new APIUserAbortError()
          if (error instanceof APIError) {
            yield createSystemAPIErrorMessage(
              error,
              remaining,
              reportedAttempt,
              maxRetries,
            )
          }
          const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
          await sleep(chunk, options.signal, { abortError })
          remaining -= chunk
        }
        // Clamp so the for-loop never terminates. Backoff uses the separate
        // persistentAttempt counter which keeps growing to the 5-min cap.
        if (attempt >= maxRetries) attempt = maxRetries
      } else {
        if (error instanceof APIError) {
          yield createSystemAPIErrorMessage(error, delayMs, attempt, maxRetries)
        }
        await sleep(delayMs, options.signal, { abortError })
      }
    }
  }

  return throwRetryExhausted(lastError, maxRetries + 1)
}

function getRetryAfter(error: unknown): string | null {
  return (
    ((error as { headers?: { 'retry-after'?: string } }).headers?.[
      'retry-after'
    ] ||
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      ((error as APIError).headers as Headers)?.get?.('retry-after')) ??
    null
  )
}

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }

  const baseDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}

export function parseMaxTokensContextOverflowError(error: APIError):
  | {
      inputTokens: number
      maxTokens: number
      contextLimit: number
    }
  | undefined {
  if (error.status !== 400 || !error.message) {
    return undefined
  }

  if (
    !error.message.includes(
      'input length and `max_tokens` exceed context limit',
    )
  ) {
    return undefined
  }

  // Example format: "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
  const regex =
    /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
  const match = error.message.match(regex)

  if (!match || match.length !== 4) {
    return undefined
  }

  if (!match[1] || !match[2] || !match[3]) {
    logError(
      new Error(
        'Unable to parse max_tokens from max_tokens exceed context limit error message',
      ),
    )
    return undefined
  }
  const inputTokens = parseInt(match[1], 10)
  const maxTokens = parseInt(match[2], 10)
  const contextLimit = parseInt(match[3], 10)

  if (isNaN(inputTokens) || isNaN(maxTokens) || isNaN(contextLimit)) {
    return undefined
  }

  return { inputTokens, maxTokens, contextLimit }
}

// TODO: Replace with a response header check once the API adds a dedicated
// header for fast-mode rejection (e.g., x-fast-mode-rejected). String-matching
// the error message is fragile and will break if the API wording changes.
function isFastModeNotEnabledError(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }
  return (
    error.status === 400 &&
    (error.message?.includes('Fast mode is not enabled') ?? false)
  )
}

export function is529Error(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }

  // Check for 529 status code or overloaded error in message
  return (
    error.status === 529 ||
    // See below: the SDK sometimes fails to properly pass the 529 status code during streaming
    (error.message?.includes('"type":"overloaded_error"') ?? false)
  )
}

function isOAuthTokenRevokedError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 403 &&
    (error.message?.includes('OAuth token has been revoked') ?? false)
  )
}

function isBedrockAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    // AWS libs reject without an API call if .aws holds a past Expiration value
    // otherwise, API calls that receive expired tokens give generic 403
    // "The security token included in the request is invalid"
    if (
      isAwsCredentialsProviderError(error) ||
      (error instanceof APIError && error.status === 403)
    ) {
      return true
    }
  }
  return false
}

/**
 * Clear AWS auth caches if appropriate.
 * @returns true if action was taken.
 */
function handleAwsCredentialError(error: unknown): boolean {
  if (isBedrockAuthError(error)) {
    clearAwsCredentialsCache()
    return true
  }
  return false
}

// google-auth-library throws plain Error (no typed name like AWS's
// CredentialsProviderError). Match common SDK-level credential-failure messages.
function isGoogleAuthLibraryCredentialError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message
  return (
    msg.includes('Could not load the default credentials') ||
    msg.includes('Could not refresh access token') ||
    msg.includes('invalid_grant')
  )
}

function isVertexAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    // SDK-level: google-auth-library fails in prepareOptions() before the HTTP call
    if (isGoogleAuthLibraryCredentialError(error)) {
      return true
    }
    // Server-side: Vertex returns 401 for expired/invalid tokens
    if (error instanceof APIError && error.status === 401) {
      return true
    }
  }
  return false
}

/**
 * Clear GCP auth caches if appropriate.
 * @returns true if action was taken.
 */
function handleGcpCredentialError(error: unknown): boolean {
  if (isVertexAuthError(error)) {
    clearGcpCredentialsCache()
    return true
  }
  return false
}

function shouldRetry(error: APIError): boolean {
  // Never retry mock errors - they're from /mock-limits command for testing
  if (isMockRateLimitError(error)) {
    return false
  }

  // Persistent mode: 429/529 always retryable, bypass subscriber gates and
  // x-should-retry header.
  if (isPersistentRetryEnabled() && isTransientCapacityError(error)) {
    return true
  }

  // CCR mode: auth is via infrastructure-provided JWTs, so a 401/403 is a
  // transient blip (auth service flap, network hiccup) rather than bad
  // credentials. Bypass x-should-retry:false — the server assumes we'd retry
  // the same bad key, but our key is fine.
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    (error.status === 401 || error.status === 403)
  ) {
    return true
  }

  // Check for overloaded errors first by examining the message content
  // The SDK sometimes fails to properly pass the 529 status code during streaming,
  // so we need to check the error message directly
  if (error.message?.includes('"type":"overloaded_error"')) {
    return true
  }

  // Check for max tokens context overflow errors that we can handle
  if (parseMaxTokensContextOverflowError(error)) {
    return true
  }

  // Note this is not a standard header.
  const shouldRetryHeader = error.headers?.get('x-should-retry')

  // If the server explicitly says whether or not to retry, obey.
  // For Max and Pro users, should-retry is true, but in several hours, so we shouldn't.
  // Enterprise users can retry because they typically use PAYG instead of rate limits.
  if (
    shouldRetryHeader === 'true' &&
    (!isClaudeAISubscriber() || isEnterpriseSubscriber())
  ) {
    return true
  }

  // Ants can ignore x-should-retry: false for 5xx server errors only.
  // For other status codes (401, 403, 400, 429, etc.), respect the header.
  if (shouldRetryHeader === 'false') {
    const is5xxError = error.status !== undefined && error.status >= 500
    if (!(process.env.USER_TYPE === 'ant' && is5xxError)) {
      return false
    }
  }

  if (error instanceof APIConnectionError) {
    return true
  }

  if (!error.status) return false

  // Retry on request timeouts.
  if (error.status === 408) return true

  // Retry on lock timeouts.
  if (error.status === 409) return true

  // Retry on rate limits, but not for ClaudeAI Subscription users
  // Enterprise users can retry because they typically use PAYG instead of rate limits
  if (error.status === 429) {
    return !isClaudeAISubscriber() || isEnterpriseSubscriber()
  }

  // Clear API key cache on 401 and allow retry.
  // OAuth token handling is done in the main retry loop via handleOAuth401Error.
  if (error.status === 401) {
    clearApiKeyHelperCache()
    return true
  }

  // Retry on 403 "token revoked" (same refresh logic as 401, see above)
  if (isOAuthTokenRevokedError(error)) {
    return true
  }

  // Retry internal errors.
  if (error.status && error.status >= 500) return true

  return false
}

export function getDefaultMaxRetries(): number {
  if (process.env.CLAUDE_CODE_MAX_RETRIES) {
    return parseInt(process.env.CLAUDE_CODE_MAX_RETRIES, 10)
  }
  return DEFAULT_MAX_RETRIES
}
function getMaxRetries(options: RetryOptions): number {
  return options.maxRetries ?? getDefaultMaxRetries()
}

const DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30 * 60 * 1000 // 30 minutes
const SHORT_RETRY_THRESHOLD_MS = 20 * 1000 // 20 seconds
const MIN_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

function getRetryAfterMs(error: APIError): number | null {
  const retryAfter = getRetryAfter(error)
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }
  return null
}

function getRateLimitResetDelayMs(error: APIError): number | null {
  const resetHeader = error.headers?.get?.('anthropic-ratelimit-unified-reset')
  if (!resetHeader) return null
  const resetUnixSec = Number(resetHeader)
  if (!Number.isFinite(resetUnixSec)) return null
  const delayMs = resetUnixSec * 1000 - Date.now()
  if (delayMs <= 0) return null
  return Math.min(delayMs, PERSISTENT_RESET_CAP_MS)
}
