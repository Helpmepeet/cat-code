# Auth, Accounts, And OAuth Map

Last refreshed: 2026-05-21

## Purpose

Daily-refreshable routing map for auth source selection, OAuth login, account
storage, profile switching, secure storage, Codex account pool/lease
touchpoints, and structured account diagnostics. Use this to choose the first
source files to inspect before changing login behavior or diagnosing "not
logged in", wrong-account, token refresh, account switching, structured
account diagnostics, or Codex pool exhaustion.

Verify behavior in source before editing. Older Codex docs are useful incident
history, but the live routing owners are the files below.

## First Files To Inspect

Read in this order for most auth/account work:

| Order | File | Why first |
|---|---|---|
| 1 | [`WORKSPACE_MAP.md`](WORKSPACE_MAP.md) | Broad map index and adjacent persistence/Codex maps. |
| 2 | [`../../src/utils/auth.ts`](../../src/utils/auth.ts) | Central auth source selection, token reads, token refresh, secure-storage writes, Codex config token helpers, and user account summary. |
| 3 | [`../../src/components/ConsoleOAuthFlow.tsx`](../../src/components/ConsoleOAuthFlow.tsx) | Interactive login UI for Anthropic, Console, third-party setup, and OpenAI/Codex. |
| 4 | [`../../src/services/oauth/index.ts`](../../src/services/oauth/index.ts) | Anthropic OAuth service: PKCE, localhost callback, manual code entry, token formatting. |
| 5 | [`../../src/services/oauth/client.ts`](../../src/services/oauth/client.ts) | Anthropic OAuth URLs, token exchange/refresh, profile, roles, Console API-key creation. |
| 6 | [`../../src/services/oauth/codex-client.ts`](../../src/services/oauth/codex-client.ts) | OpenAI/Codex OAuth client, fixed callback server, token exchange/refresh, account ID extraction. |
| 7 | [`../../src/services/api/claudeAccountPool.ts`](../../src/services/api/claudeAccountPool.ts) | Claude multi-account vault, active account pointer, keychain/config sync, aliases, deletes. |
| 8 | [`../../src/services/api/codexAccountPool.ts`](../../src/services/api/codexAccountPool.ts) | Codex pool inventory, vault/config merge, health, active account, aliases, deletes, usage hints. |
| 9 | [`../../src/services/api/codexAccountLeaseManager.ts`](../../src/services/api/codexAccountLeaseManager.ts) | Main-thread/subagent account pinning and lease-local failover. |
| 10 | [`../../src/services/api/client.ts`](../../src/services/api/client.ts) | Request-time provider routing and lease-aware Codex token selection. |
| 11 | [`../../src/services/api/withRetry.ts`](../../src/services/api/withRetry.ts) | Auth retry, Codex cap failover, and connection-error failover. |
| 12 | [`../../src/services/api/accountDiagnostics.ts`](../../src/services/api/accountDiagnostics.ts) | Structured `cat_code_account_diagnostic` emission, sanitization, and stderr fallback. |
| 13 | [`../../src/utils/secureStorage/`](../../src/utils/secureStorage/) | macOS keychain/plaintext storage selection, cache, prefetch, fallback, and delete behavior. |

## Auth Source Selection

| Concern | Inspect first | Then inspect | Notes |
|---|---|---|---|
| Whether Anthropic OAuth is enabled | `src/utils/auth.ts:isAnthropicAuthEnabled()` | `src/utils/model/providers.ts`, `src/bootstrap/state.ts` | Disabled for bare mode, third-party provider env, or external API/auth-token sources unless in managed OAuth contexts. |
| Bearer token source | `src/utils/auth.ts:getAuthTokenSource()` | `src/utils/authFileDescriptor.ts`, `src/services/oauth/client.ts` | Order is bare-mode helper, env token, OAuth token FD or CCR fallback, apiKeyHelper, then stored Claude.ai OAuth. |
| Anthropic API key source | `src/utils/auth.ts:getAnthropicApiKeyWithSource()` | `src/utils/secureStorage/keychainPrefetch.ts`, `src/utils/authPortable.ts` | Order differs for bare/CI/print flows. User-approved env keys, FD keys, apiKeyHelper, and `/login` managed keychain/config keys are separate sources. |
| Provider-specific request routing | `src/services/api/client.ts:getAnthropicClient()` | `src/utils/model/providers.ts`, `src/services/api/codex-fetch-adapter.ts` | OpenAI provider injects Codex fetch with Codex OAuth tokens. Anthropic/Bedrock/Vertex/Foundry use their own auth branches. |
| Account summary/status | `src/utils/auth.ts:getAccountInformation()` | `src/cli/handlers/auth.ts:authStatus()` | OpenAI summary reads the single Codex config token; pooled display lives in `/accounts`. |
| Token freshness | `src/utils/auth.ts:checkAndRefreshOAuthTokenIfNeeded()` | `src/services/oauth/client.ts:refreshOAuthToken()`, `src/services/api/claudeAccountPool.ts:updateActiveClaudeAccountTokens()` | Anthropic refresh uses a config-dir lock and writes refreshed tokens back to secure storage and the active Claude vault account. |

## OAuth And Login Flows

| Flow | Entry point | Core route | Persistence route |
|---|---|---|---|
| Interactive `/login` | `src/commands/login/login.tsx` | `ConsoleOAuthFlow` | Anthropic: `installOAuthTokens()`; Codex: `ConsoleOAuthFlow.persistCodexLogin()` |
| Anthropic Claude.ai login | `ConsoleOAuthFlow.startOAuth()` | `OAuthService.startOAuthFlow()` -> `exchangeCodeForTokens()` -> `fetchProfileInfo()` | `installOAuthTokens()` stores profile, appends Claude vault account, saves `claudeAiOauth`. |
| Anthropic Console login | `ConsoleOAuthFlow.startOAuth()` with `loginWithClaudeAi=false` | Same OAuth service with Console authorize URL | `installOAuthTokens()` stores profile, creates Console API key through `createAndStoreApiKey()`, and saves managed key. |
| Anthropic `setup-token` | `ConsoleOAuthFlow` mode `setup-token` | `OAuthService.startOAuthFlow({ inferenceOnly, expiresIn })` | Token is displayed for env use and is not saved to keychain. |
| OpenAI/Codex login | `ConsoleOAuthFlow.startCodexOAuth()` | `runCodexOAuthFlow()` in `src/services/oauth/codex-client.ts` | Saves single config token via `saveCodexOAuthTokens()`, saves vault profile via `saveCodexTokenToVault()`, appends active pool account. |
| Non-interactive CLI auth | `src/cli/handlers/auth.ts:authLogin()` | `OAuthService.startOAuthFlow()` plus readline manual input or refresh-token env fast path | `installOAuthTokens()` handles shared post-token state. |
| Forced login constraints | `ConsoleOAuthFlow`, `authLogin()` | `settings.forceLoginMethod`, `settings.forceLoginOrgUUID` | `validateForceLoginOrg()` checks the active OAuth profile after login. |

Anthropic OAuth uses OS-assigned localhost callback ports through
`AuthCodeListener`. OpenAI/Codex uses a fixed `http://localhost:1455/auth/callback`
callback in `codex-client.ts`, because that redirect URI is registered for the
Codex client.

## Storage And Profile Switching

| Storage/profile | Owner | Backing store | Notes |
|---|---|---|---|
| Anthropic OAuth token | `src/utils/auth.ts:getClaudeAIOAuthTokens()` | `SecureStorageData.claudeAiOauth` via keychain or `.credentials.json` | Env/FD inference tokens win before pool/secure-storage reads. Claude pool can shadow keychain when multiple healthy vault accounts exist. |
| Anthropic profile metadata | `src/services/oauth/client.ts:storeOAuthAccountInfo()` | Global config `oauthAccount` | Roles and organization names are filled by `fetchAndStoreUserRoles()` or direct pool sync. |
| Anthropic Console managed API key | `src/utils/auth.ts:saveApiKey()` | macOS legacy keychain entry or global config `primaryApiKey` | API key approval state is tracked in global config `customApiKeyResponses`. |
| Claude account pool | `src/services/api/claudeAccountPool.ts` | `~/claude-vault/accounts/<accountUuid>.json` plus keychain/config fallback | Login appends/migrates accounts. Switch syncs active account back to keychain and `oauthAccount` for existing consumers. |
| Codex single-account fallback | `src/utils/auth.ts:getCodexOAuthTokens()` | Global config `codexOAuth` | Backward-compatible path when Codex pool is not active. |
| Codex account pool | `src/services/api/codexAccountPool.ts` | `~/codex-vault/accounts/<accountId>.json`, optional `.codex-nootp/config.toml` vault path, plus config fallback | Pool owns health, aliases, active account, usage hints, plan eligibility, and config active-account pointer. |
| Codex token refresh | `src/services/api/codexTokenRefresh.ts` | Codex vault JSON | `touchAll()` refreshes unlocked vault accounts. Identity mismatch saves a new profile and marks the old account dead. |
| Codex usage hints | `src/services/api/codexUsage.ts` | In-memory cache and pool account fields | Wham usage is best-effort. Hard truth remains 429/cap handling in request retry. |

## Command Routing

| Command | Owner | Account surfaces touched |
|---|---|---|
| `/login` | `src/commands/login/` | Shows `ConsoleOAuthFlow`; post-login refresh clears signature blocks, regenerates session/cost state, refreshes policy/remote settings/GrowthBook, increments `authVersion`. |
| `/logout` | `src/commands/logout/logout.tsx` | With multiple Claude accounts, removes only active Claude account and switches. Otherwise deletes secure storage, clears Codex config token, clears `oauthAccount`, and leaves Codex vault profiles on disk. |
| `/accounts` | `src/commands/accounts/accounts.ts` | Displays Claude pool, Codex pool, live usage when available, main lease, subagent strategy, and lease holders. |
| `/switch-account` | `src/commands/switch-account/switch-account.ts` | Matches Claude aliases/email/UUID and Codex aliases/account IDs. No arg rotates within current provider. Codex switch reassigns main lease and resets Codex cache context. |
| `/delete-account` | `src/commands/delete-account/delete-account.ts` | Deletes vault-backed Claude or Codex accounts only. Codex delete repairs or releases main lease; config-only Codex accounts are not deletable here. |
| `/rename-account` | `src/commands/rename-account/rename-account.ts` | Renames vault-backed Claude or Codex accounts. Codex aliases are validated by `validateCodexAccountAlias()`. |


## Structured Diagnostics Boundary

| Concern | Inspect first | Then inspect | Notes |
|---|---|---|---|
| SDK/system-event schema | `src/entrypoints/sdk/coreSchemas.ts:SDKAccountDiagnosticMessageSchema` | `src/entrypoints/sdk/coreTypes.generated.ts`, `src/entrypoints/sdk/accountDiagnosticsSchema.test.ts` | Durable cross-process contract is `type: "system"`, `subtype: "cat_code_account_diagnostic"`, `version: 1`, plus `code`, `severity`, `provider`, and `recoverable`. Downstream remediation can key off those required fields alone. |
| Sanitized emission and stderr fallback | `src/services/api/accountDiagnostics.ts` | `src/services/api/accountDiagnostics.test.ts` | `buildAccountDiagnosticBody()` redacts aliases, emails, account IDs, tokens, API keys, auth headers, and serialized vault records before emitting stream-json or `CAT_CODE_DIAGNOSTIC ...` stderr fallback lines. |
| Route-selection and pre-send diagnostics | `src/services/api/client.ts` | `src/services/api/codexAccountPool.ts`, `src/services/api/claudeAccountPool.ts` | `getAnthropicClient()` emits `account.route.selected`, `model.provider_mismatch`, and unrecoverable pool/auth diagnostics before a doomed request is sent. |
| Retry/failover diagnostics | `src/services/api/withRetry.ts` | `src/services/api/codexTokenRefresh.ts`, `src/services/api/codexAccountLeaseManager.ts` | Retry paths emit `account.failover.succeeded`, `account.transient_failure`, `account.token_refresh.failed`, `quota.exhausted`, or `account.pool.unavailable` based on the recovery branch taken. |

## Codex Pool And Lease Touchpoints

| Concern | Inspect first | Then inspect | Notes |
|---|---|---|---|
| Pool initialization | `src/entrypoints/init.ts` | `src/services/api/codexAccountPool.ts`, `src/services/api/claudeAccountPool.ts` | Startup initializes Codex pool fire-and-forget and Claude pool synchronously after OAuth profile population. |
| Main-thread lease | `src/query.ts` | `src/services/api/codexAccountLeaseManager.ts` | Main OpenAI turns register `ownerId: "main-thread"` when the pool is active and release it on query exit. |
| Subagent leases | `src/tools/AgentTool/AgentTool.tsx` | `src/tasks/LocalAgentTask/LocalAgentTask.tsx` | AgentTool registers leases for async and foreground subagents; task cleanup/kill paths release them. |
| Lease-aware token lookup | `src/services/api/client.ts:resolveCodexOAuthTokensForLeaseOwner()` | `src/services/api/codexAccountLeaseManager.ts`, `src/services/api/codexAccountPool.ts` | Pooled requests use subagent lease, main lease, or active pool account. When pool is active and no healthy account exists, do not fall through to raw config tokens. |
| Cap failover | `src/services/api/withRetry.ts` | `src/services/api/codex-fetch-adapter.ts:CodexAccountCapError` | 429 from Codex reassigns only the current lease when one exists; unleased calls rotate pool active account. |
| Connection-error failover | `src/services/api/withRetry.ts` | `src/services/api/codexAccountLeaseManager.ts` | Repeated Codex connection errors can move to another account without marking the failed account capped. |
| Standalone Codex core profile selection | `src/codex-core/accounts.ts` | `src/codex-core/client.ts` | `runCodexLLM()` requires explicit account alias or account ID prefix; it does not silently rotate. |

## Secure Storage Route

| Need | Inspect first | Then inspect |
|---|---|---|
| Storage backend selection | `src/utils/secureStorage/index.ts` | macOS uses keychain with plaintext fallback; other platforms use plaintext. |
| macOS OAuth credentials entry | `src/utils/secureStorage/macOsKeychainStorage.ts` | `src/utils/secureStorage/macOsKeychainHelpers.ts` |
| Keychain startup latency/cache | `src/utils/secureStorage/keychainPrefetch.ts` | `src/entrypoints/init.ts`, `src/utils/auth.ts:getApiKeyFromConfigOrMacOSKeychain()` |
| Plaintext fallback file | `src/utils/secureStorage/plainTextStorage.ts` | Uses `${CLAUDE_CONFIG_DIR:-~/.cat-code}/.credentials.json` with mode `0600`. |
| Primary/fallback migration | `src/utils/secureStorage/fallbackStorage.ts` | Primary success deletes secondary on migration; fallback success deletes stale primary when needed. |
| Legacy managed API key | `src/utils/auth.ts:saveApiKey()` | Uses legacy macOS keychain service without the `-credentials` suffix; do not confuse it with OAuth credential storage. |

## Tests And Validation

Use the closest test first:

| Area | Entry point |
|---|---|
| Codex OAuth callback and token parsing | `bun test src/services/oauth/codex-client.test.ts` |
| Codex pool merge, aliases, deletes, health, plan eligibility | `bun test src/services/api/codexAccountPool.test.ts` |
| Codex lease selection, failover, retry integration | `bun test src/services/api/codexAccountLeaseManager.test.ts` |
| Codex vault refresh and identity mismatch | `bun test src/services/api/codexTokenRefresh.test.ts` |
| Codex usage display and usage hint behavior | `bun test src/services/api/codexUsage.test.ts` |
| Codex adapter auth/cap errors and transport bridge | `bun test src/services/api/codex-fetch-adapter.test.ts` |
| Structured account diagnostics envelope + redaction | `bun test src/services/api/accountDiagnostics.test.ts` |
| `/accounts` behavior | `bun test src/commands/accounts/accounts.test.ts` |
| `/switch-account` behavior | `bun test src/commands/switch-account/switch-account.test.ts` |
| `/rename-account` behavior | `bun test src/commands/rename-account/rename-account.test.ts` |
| `/delete-account` behavior | `bun test src/commands/delete-account/delete-account.test.ts` |
| Full documented build | `bun run build:dev:full` |
| Docs-only changes | `git diff --check -- docs/maps/auth-accounts-oauth.md` |

There are focused tests for `/switch-account` and `/rename-account`. There are
also focused tests for `/accounts` and `/delete-account`. There are still no
focused tests for `/login` or `/logout`; for changes there, pair source
inspection with a focused manual or integration check.

## Common Failure Routes

| Symptom | Inspect in this order | Why |
|---|---|---|
| "Not logged in" for Anthropic despite prior login | `src/utils/auth.ts:getAuthTokenSource()` -> `src/utils/auth.ts:getClaudeAIOAuthTokens()` -> `src/utils/secureStorage/` -> `src/services/api/claudeAccountPool.ts` | Env/FD/bare-mode guards, pool shadowing, keychain cache, and plaintext fallback can each change what token is visible. |
| Console API key path uses wrong key | `src/utils/auth.ts:getAnthropicApiKeyWithSource()` -> `src/utils/auth.ts:saveApiKey()` -> `src/utils/authPortable.ts` | Env approval, FD keys, apiKeyHelper, and `/login` managed keys have distinct precedence and storage. |
| OAuth browser callback stalls | Anthropic: `src/services/oauth/auth-code-listener.ts`, `src/services/oauth/index.ts`; Codex: `src/services/oauth/codex-client.ts` | Anthropic uses dynamic localhost ports and manual fallback; Codex requires fixed port 1455 and has its own completion page. |
| Wrong Anthropic profile after switching | `src/commands/switch-account/switch-account.ts` -> `src/services/api/claudeAccountPool.ts:syncClaudeAccountToStorage()` -> `src/utils/auth.ts:clearOAuthTokenCache()` | Active Claude account must be copied back to keychain/config for legacy consumers. |
| Wrong Codex account after `/switch-account` | `src/commands/switch-account/switch-account.ts` -> `src/services/api/codexAccountLeaseManager.ts` -> `src/services/api/codex-fetch-adapter.ts` | Pool activeIndex alone is not enough; main lease and Codex cache context must be updated. |
| Codex pool appears exhausted | `src/services/api/client.ts` -> `src/services/api/withRetry.ts` -> `src/services/api/codexAccountLeaseManager.ts` -> `src/services/api/codexAccountPool.ts` -> `src/services/api/codexUsage.ts` | Distinguish `auth.missing` (no account), `account.pool.unavailable` (accounts exist but none are healthy), `quota.exhausted` (all known accounts are capped), dead refresh tokens, recent connection errors, and usage-hint premarking. |
| Open Design or SDK consumer received `cat_code_account_diagnostic` | `src/services/api/accountDiagnostics.ts` -> `src/services/api/client.ts` -> `src/services/api/withRetry.ts` -> `src/commands/accounts/accounts.ts` | Check the diagnostic code before reading optional fields: the required envelope drives remediation, while optional fields are sanitized hints only. Recovery stays on Cat Code login and `/accounts`, not downstream profile selection. |
| Codex refresh changes account identity | `src/services/api/codexTokenRefresh.ts` -> `src/services/api/codexAccountPool.ts` -> `src/codex-core/accounts.ts` | Identity mismatch intentionally saves a new profile and does not transfer alias metadata to the new account. |
| `/logout` did not delete Codex vault accounts | `src/commands/logout/logout.tsx` -> `src/commands/delete-account/delete-account.ts` | Full logout clears session/config credentials but intentionally leaves Codex vault profiles for `/delete-account`. |

## Traps And Stale Assumptions

- Do not assume `/login` is Anthropic-only. `ConsoleOAuthFlow` also owns the
  OpenAI/Codex login option.
- Do not assume Codex OAuth uses `OAuthService`. It has a separate
  `src/services/oauth/codex-client.ts` implementation and a fixed callback
  port.
- Do not assume all Anthropic auth is OAuth. API keys, apiKeyHelper, file
  descriptors, managed OAuth env tokens, third-party providers, and bare mode
  each alter selection.
- Do not assume keychain and global config hold the same data. Anthropic OAuth
  tokens live in secure storage; Anthropic profile metadata and Codex fallback
  tokens live in global config; vault accounts live under `~/claude-vault` or
  `~/codex-vault`.
- Do not assume pool active account and request account are always identical.
  Codex leases can pin main-thread or subagent requests independently.
- Do not mark Codex accounts capped for generic connection errors. The retry
  path has a separate non-capping failover branch.
- Do not bypass `accountDiagnostics.ts` when crossing process boundaries.
  Structured diagnostics must be sanitized before they reach SDK or Open Design
  consumers.
- Do not tell downstream clients to choose Cat Code profiles or accounts.
  Recovery stays inside Cat Code: downstream surfaces can prompt for Cat Code
  login or Cat Code `/accounts`, but they do not select profiles themselves.
- Do not use old Codex design docs as the source of truth without checking the
  current pool, lease, retry, and client files above.
