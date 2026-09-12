# Auth, Accounts, And OAuth Map

Last refreshed: 2026-09-12

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
| 3 | [`../../src/components/ConsoleOAuthFlow.tsx`](../../src/components/ConsoleOAuthFlow.tsx) | Shared login UI. `/login` uses its provider picker for Anthropic subscription, Anthropic Console/API, third-party, and OpenAI/Codex routes. |
| 4 | [`../../src/services/oauth/`](../../src/services/oauth/) | Anthropic OAuth service (`index.ts`, `client.ts`) and the separate OpenAI/Codex client with its fixed callback port (`codex-client.ts`). |
| 5 | [`../../src/services/api/claudeAccountPool.ts`](../../src/services/api/claudeAccountPool.ts) | Claude multi-account vault, active account pointer, keychain/config sync, aliases, deletes. |
| 6 | [`../../src/services/api/codexAccountPool.ts`](../../src/services/api/codexAccountPool.ts) | Codex pool inventory, credential authority, vault/config merge, health/classification, active account, aliases, deletes, usage hints, normalized availability reasons, and config mirror demotion. |
| 7 | [`../../src/codex-core/accounts.ts`](../../src/codex-core/accounts.ts) | Exported `maybeRefreshAccount()` refresh-on-use entry point for pool, core, reset, and image callers. |

The sections below route the remaining surfaces (request-time routing in
`client.ts`/`withRetry.ts`, lease manager, vault refresh state machine, status
observation, structured diagnostics, secure storage).

## Auth Source Selection

| Concern | Inspect first | Then inspect | Notes |
|---|---|---|---|
| Whether Anthropic OAuth is enabled | `src/utils/auth.ts:isAnthropicAuthEnabled()` | `src/utils/model/providers.ts`, `src/bootstrap/state.ts` | Disabled for bare mode, third-party provider env, or external API/auth-token sources unless in managed OAuth contexts. |
| Bearer token source | `src/utils/auth.ts:getAuthTokenSource()` | `src/utils/authFileDescriptor.ts`, `src/services/oauth/client.ts` | Order is bare-mode helper, env token, OAuth token FD or CCR fallback, apiKeyHelper, then stored Claude.ai OAuth. |
| Anthropic API key source | `src/utils/auth.ts:getAnthropicApiKeyWithSource()` | `src/utils/secureStorage/keychainPrefetch.ts`, `src/utils/authPortable.ts` | Order differs for bare/CI/print flows. User-approved env keys, FD keys, apiKeyHelper, and managed Console-login keychain/config keys are separate sources. |
| Provider-specific request routing | `src/services/api/client.ts:getAnthropicClient()` | `src/utils/model/providers.ts`, `src/services/api/codex-fetch-adapter.ts` | OpenAI provider injects Codex fetch with async Codex OAuth token resolution. The adapter gets a resolver callback so every request re-derives lease-aware, refresh-on-use tokens instead of reusing a stale construction-time token. Anthropic/Bedrock/Vertex/Foundry use their own auth branches. |
| Account summary/status | `src/utils/auth.ts:getAccountInformation()` | `src/cli/handlers/auth.ts:authStatus()` | OpenAI summary reads the legacy Codex config token mirror; pooled display lives in `/accounts`. |
| Token freshness | `src/utils/auth.ts:checkAndRefreshOAuthTokenIfNeeded()` | `src/services/oauth/client.ts:refreshOAuthToken()`, `src/services/api/claudeAccountPool.ts:updateClaudeAccountTokens()` | Anthropic refresh uses a config-dir lock and writes refreshed tokens back to secure storage and the Claude vault account that supplied the refresh token. |
| Codex refresh state and retry safety | `src/codex-core/accounts.ts:maybeRefreshAccount()` | `src/services/api/codexTokenRefresh.ts`, `src/services/api/codexAccountPool.ts:getCodexAccountAvailability()`, `src/services/api/withRetry.ts` | Codex callers should use `maybeRefreshAccount()` as the single refresh-on-use entry point. It routes vault-backed accounts through the persisted refresh state machine and raw/no-vault accounts through the cross-process ledger path, so later processes can distinguish retry-safe offline failures from ambiguous or reauth-required states. A persisted terminal verdict is token-scoped: login clears it when the refresh token changes; a missing/malformed correlation is probed rather than trusted healthy. |

## OAuth And Login Flows

| Flow | Entry point | Core route | Persistence route |
|---|---|---|---|
| Interactive `/login` | `src/commands/login/login.tsx` | Shared `ConsoleOAuthFlow` provider picker | Anthropic routes use `installOAuthTokens()`; Codex uses `persistCodexLogin()`. |
| Desktop subscription login | `app/renderer/src/StartupSurfaces.tsx`, `app/renderer/src/AccountsPage.tsx` | `account.login {provider}` → strict sidecar schema → provider-specific runner in `app/sidecar/accountsDomain.ts` | Both runners call the engine-owned persistence path; the renderer receives only OAuth progress and redacted pool rows. |
| Anthropic Claude.ai login | `ConsoleOAuthFlow.startOAuth()` | `OAuthService.startOAuthFlow()` -> `exchangeCodeForTokens()` -> `fetchProfileInfo()` | `installOAuthTokens()` stores profile, appends Claude vault account, saves `claudeAiOauth`. |
| Anthropic Console login | `ConsoleOAuthFlow.startOAuth()` with `loginWithClaudeAi=false` | Same OAuth service with Console authorize URL | `installOAuthTokens()` stores profile, creates Console API key through `createAndStoreApiKey()`, and saves managed key. |
| Anthropic `setup-token` | `ConsoleOAuthFlow` mode `setup-token` | `OAuthService.startOAuthFlow({ inferenceOnly, expiresIn })` | Token is displayed for env use and is not saved to keychain. |
| OpenAI/Codex login | `ConsoleOAuthFlow.startCodexOAuth()` | `runCodexOAuthFlow()` in `src/services/oauth/codex-client.ts` | Saves the legacy config token mirror via `saveCodexOAuthTokens()`, saves vault profile via `saveCodexTokenToVault()`, and appends active pool account. Vault-backed pool inventory is authoritative once present. |
| Non-interactive CLI auth | `src/cli/handlers/auth.ts:authLogin()` | `OAuthService.startOAuthFlow()` plus readline manual input or refresh-token env fast path | `installOAuthTokens()` handles shared post-token state. |
| Forced Anthropic login constraints | Shared `ConsoleOAuthFlow` callers, `authLogin()`, desktop `createRealAnthropicOAuthLoginRunner()` | `settings.forceLoginMethod`, `settings.forceLoginOrgUUID` | Every Anthropic OAuth entry point passes the forced method/org into `OAuthService` and calls `validateForceLoginOrg()` before reporting success. |

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
| Codex config token mirror | `src/utils/auth.ts:getCodexOAuthTokens()` | Global config `codexOAuth` | Backward-compatible mirror written by login and raw/no-vault refresh. It is used only when there is no vault-backed pool inventory; a single pool account is enough for pool-managed credentials. |
| Codex account pool | `src/services/api/codexAccountPool.ts` | `~/codex-vault/accounts/<accountId>.json`, optional `.codex-nootp/config.toml` vault path, plus config mirror only when no vault profiles exist | Pool owns credential authority, health/classification, aliases, active account, usage hints, quota observation reconciliation, plan eligibility, config active-account pointer, and stale-config-fallback prevention. `poolManagesCredentials()` is true with one or more accounts; `canFailover()` checks general rotation, while `hasSelectableAccountOtherThan(failedAccountId)` checks recovery from a specific failed request. |
| Codex token refresh | `src/codex-core/accounts.ts:maybeRefreshAccount()` | Codex vault JSON plus persisted `refresh` state, or raw config/vault writes with ledger for no-vault accounts | `maybeRefreshAccount()` is the caller-facing refresh entry point. Vault refresh writes `idle` / `in_flight` / `unknown` / `reauth_required` state into the vault, uses file locking to serialize writers, distinguishes definitely-not-sent transport errors from ambiguous outcomes, and leaves identity-mismatch refreshes marked for reauth on the old vault file. Raw/no-vault refresh uses the ledger path before `saveCodexOAuthTokens()` / vault persistence. |
| Codex usage hints | `src/services/api/codexUsage.ts` | `src/services/api/codexUsageSharedCache.ts`, `src/components/Settings/Usage.tsx`, `src/components/LogoV2/AccountsPanel.tsx`, pool account fields | Usage fetches are best-effort and send provider account-selection headers. Unforced reads share private normalized observations for 60 seconds across engine processes; forced/post-request refreshes remain fresh. Inventory/credential scopes and an invalidation epoch fence cache and routing-hint updates. The pool keeps distinct primary and weekly reset hints, while only the primary reset gates the already-reset escape from a usage block. Treat plan type, quota data, and switchability separately: free accounts can be healthy and displayable even when their quota shape differs from paid accounts. Hard-429, usage-poll, and reset-redemption observations are reconciled by the pool before availability changes. |

## Command Routing

| Command | Owner | Account surfaces touched |
|---|---|---|
| `/login` | `src/commands/login/` | Opens the provider-neutral login chooser for Anthropic or OpenAI/Codex; post-login refresh clears signature blocks, regenerates session/cost state, refreshes policy/remote settings/GrowthBook, and increments `authVersion`. Codex login writes both the config mirror and pool/vault profile. |
| `/logout` | `src/commands/logout/logout.tsx` | With multiple Claude accounts, removes only active Claude account and switches. Otherwise deletes secure storage, clears Codex config token, clears `oauthAccount`, and leaves Codex vault profiles on disk. |
| `/accounts` | `src/commands/accounts/accounts.ts` | Displays Claude pool, Codex pool, shared Codex availability labels (`Ready`, `Limit reached`, `Connection issue (retrying)`, `Needs re-login`), live usage when available, main lease, subagent strategy, and lease holders. Codex active display is lease-first. |
| `/switch-account` | `src/commands/switch-account/switch-account.ts` | Matches Claude aliases/email/UUID and Codex aliases/account IDs. No arg rotates within current provider. Codex switch reassigns main lease and resets Codex cache context. Free accounts remain selectable when healthy; revoked refresh tokens render as “needs re-login.” User-facing dead/capped reasons should come from normalized pool availability text, not raw stored refresh-state codes such as `http_401`. |
| `/delete-account` | `src/commands/delete-account/delete-account.ts` | Deletes vault-backed Claude or Codex accounts only. Codex delete repairs or releases main lease; config-only Codex accounts are not deletable here. |
| `/rename-account` | `src/commands/rename-account/rename-account.ts` | Renames vault-backed Claude or Codex accounts. Codex aliases are validated by `validateCodexAccountAlias()`. |
| `cat-code codex status --json` | `src/main.tsx`, `src/cli/handlers/codexStatus.ts` | Emits one read-only advisory Codex pool JSON observation. `--refresh never` performs no network I/O; default `--refresh auto` may use the cached refresh-free usage fetch with routing-hint mutation disabled. Valid observations exit 0 even when no account is usable. |

## Structured Diagnostics Boundary

| Concern | Inspect first | Then inspect | Notes |
|---|---|---|---|
| Read-only Codex status observation | `src/services/api/codexStatus.ts` | `src/cli/handlers/codexStatus.ts`, `src/services/api/codexAccountPool.ts`, `src/services/api/codexUsage.ts` | This is for external scheduling/delegation decisions, not in-process routing. It emits opaque `cp_<hash>` profile refs, decision actions (`delegate`, `wait`, `recheck`, `attempt`, `human_recovery`), and pool counts without raw account IDs, aliases, emails, vault paths, or tokens. It is advisory: no reservation and no cross-process cap-state guarantee. |
| SDK/system-event schema | `src/entrypoints/sdk/coreSchemas.ts:SDKAccountDiagnosticMessageSchema` | `src/entrypoints/sdk/coreTypes.generated.ts`, `src/entrypoints/sdk/accountDiagnosticsSchema.test.ts`, `src/app-runtime/sessionEvents.ts` | Durable cross-process contract is `type: "system"`, `subtype: "cat_code_account_diagnostic"`, `version: 1`, plus `code`, `severity`, `provider`, and `recoverable`. Downstream remediation can key off those required fields alone. App/session-event validation must continue to accept this system event without exposing private account identifiers. |
| Sanitized emission and stderr fallback | `src/services/api/accountDiagnostics.ts` | `src/services/api/accountDiagnostics.test.ts` | `buildAccountDiagnosticBody()` redacts aliases, emails, account IDs, tokens, API keys, auth headers, and serialized vault records before emitting stream-json or `CAT_CODE_DIAGNOSTIC ...` stderr fallback lines. |
| Public optional fields | `src/services/api/accountDiagnostics.ts` | `/Users/pt/open-design/apps/daemon/src/claude-diagnostics.ts`, `/Users/pt/open-design/packages/contracts/src/api/connectionTest.ts` | Aggregate `counts` is the stable optional public field Open Design consumes for backend-readiness display. Nonempty pools emit `total` and sparse status buckets (`healthy`, `capped`, `dead`, `quarantined`); omitted buckets mean zero. `locked` is a legacy compatibility placeholder, not a live `PoolAccount` status. Other optional fields are support-log-only unless a future boundary review says otherwise. No public or user-facing diagnostic field may carry identity-bearing account IDs, aliases, emails, or tokens. |
| Route-selection and pre-send diagnostics | `src/services/api/client.ts` | `src/services/api/codexAccountPool.ts`, `src/services/api/claudeAccountPool.ts` | `getAnthropicClient()` emits `account.route.selected`, `model.provider_mismatch`, and unrecoverable pool/auth diagnostics before a doomed request is sent. |
| Retry/failover diagnostics | `src/services/api/withRetry.ts` | `src/codex-core/accounts.ts`, `src/services/api/codexTokenRefresh.ts`, `src/services/api/codexAccountLeaseManager.ts` | Retry paths emit `account.failover.succeeded`, `account.transient_failure`, `account.token_refresh.failed`, `quota.exhausted`, or `account.pool.unavailable` based on the recovery branch taken. |
| Open Design consumer parser/display | `/Users/pt/open-design/apps/daemon/src/claude-stream.ts` | `/Users/pt/open-design/apps/daemon/src/claude-diagnostics.ts`, `/Users/pt/open-design/apps/daemon/src/server.ts`, `/Users/pt/open-design/apps/daemon/src/connectionTest.ts`, `/Users/pt/open-design/apps/web/src/components/SettingsDialog.tsx` | Open Design owns downstream parsing/display only. It should surface unrecoverable account-backend diagnostics, log recoverable diagnostics with sanitized metadata, and never select Cat Code profiles or accounts. The single non-unrecoverable diagnostic allowed in normal run UX is `account.usage.warning`, rendered as the inline FYI `Cat Code is near provider capacity.` at most once per Cat Code `session_id` per Open Design tab. It has no remediation link or account vocabulary. All recoverable routing codes remain support-log-only. |

## Codex Pool And Lease Touchpoints

| Concern | Inspect first | Then inspect | Notes |
|---|---|---|---|
| Pool initialization | `src/entrypoints/init.ts` | `src/services/api/codexAccountPool.ts`, `src/services/api/claudeAccountPool.ts` | Startup initializes Codex pool fire-and-forget and Claude pool synchronously after OAuth profile population. Codex pool merge demotes the legacy config mirror when vault profiles exist. Vault accounts start periodic refresh and quarantine probes; startup `touchAll()` runs only outside non-interactive print mode and only refreshes accounts inside the shared refresh skew. |
| Main-thread lease | `src/query.ts` | `src/services/api/codexAccountLeaseManager.ts`, `src/services/api/codexAccountPool.ts` | Main OpenAI turns register `ownerId: "main-thread"` when `poolManagesCredentials()` is true and release it on query exit. |
| Subagent leases | `src/tools/AgentTool/AgentTool.tsx` | `src/tasks/LocalAgentTask/LocalAgentTask.tsx` | AgentTool registers leases for async and foreground subagents; task cleanup/kill paths release them. |
| Lease-aware token lookup | `src/services/api/client.ts:resolveCodexOAuthTokensForLeaseOwner()` | `src/services/api/codexAccountLeaseManager.ts`, `src/services/api/codexAccountPool.ts`, `src/codex-core/accounts.ts` | Pooled requests use subagent lease, main lease, repaired lease, active pool account, or any selectable pool account. The async resolver is pool-authoritative, calls `maybeRefreshAccount()`, and refuses raw config fallback whenever `poolManagesCredentials()` is true, including a single-account pool. `createCodexFetch()` uses a resolver callback for per-request token derivation. |
| Cap failover | `src/services/api/withRetry.ts` | `src/services/api/codex-fetch-adapter.ts:CodexAccountCapError`, `src/services/api/codexAccountPool.ts:hasSelectableAccountOtherThan()` | A delayed 429 is attributed to its failed request account. Retry preserves an already-moved healthy lease or reassigns the owner when needed; unleased calls rotate pool active account. Recovery checks alternatives relative to the failed account, so one healthy replacement suffices even after another owner capped the failed account. |
| Connection-error failover | `src/services/api/withRetry.ts` | `src/services/api/codexAccountLeaseManager.ts`, `src/services/api/codexAccountPool.ts` | Repeated Codex connection errors can move to another account without marking the failed account capped. |
| Standalone Codex core profile selection | `src/codex-core/accounts.ts` | `src/codex-core/client.ts` | `runCodexLLM()` requires explicit account alias or account ID prefix; it does not silently rotate. |
| Image-generation auth | `src/tools/GenerateImageTool/GenerateImageTool.ts` | `src/services/api/withRetry.ts`, `src/services/api/client.ts`, `src/codex-core/accounts.ts` | Subscription image requests use the shared async resolver and owner-local 401/429 retry transitions, so main/subagent lease selection and failover match text requests. API-key image requests remain direct and never mutate the Codex pool. |

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
| Codex pool merge, credential authority, aliases, deletes, health, plan eligibility, config mirror demotion, and startup touch-all gating | `bun test src/services/api/codexAccountPool.test.ts` |
| Codex lease selection, failover, retry integration | `bun test src/services/api/codexAccountLeaseManager.test.ts` |
| Codex refresh-on-use and raw/vault paths | `bun test src/codex-core/accounts.test.ts` |
| Codex vault refresh and identity mismatch | `bun test src/services/api/codexTokenRefresh.test.ts` |
| Codex usage display and usage hint behavior | `bun test src/services/api/codexUsage.test.ts` |
| Shared Codex usage observations, freshness and private-file failure paths | `bun test src/services/api/codexUsageSharedCache.test.ts` (separate process suite; temporary homes and loopback HTTP) |
| Read-only Codex status observation | `bun test src/services/api/codexStatus.test.ts` |
| Codex adapter auth/cap errors and transport bridge | `bun test src/services/api/codex-fetch-adapter.test.ts` |
| Image-generation Codex auth resolver/refresh | `bun test src/tools/GenerateImageTool/GenerateImageTool.test.ts` |
| Structured account diagnostics envelope + redaction | `bun test src/services/api/accountDiagnostics.test.ts` |
| SDK/app account-diagnostic validation | `bun test src/entrypoints/sdk/accountDiagnosticsSchema.test.ts src/app-runtime/sessionEvents.test.ts` |
| `/accounts` behavior and availability vocabulary | `bun test src/commands/accounts/accounts.test.ts` |
| `/switch-account` behavior | `bun test src/commands/switch-account/switch-account.test.ts` |
| `/rename-account` behavior | `bun test src/commands/rename-account/rename-account.test.ts` |
| `/delete-account` behavior | `bun test src/commands/delete-account/delete-account.test.ts` |
| Full documented build | `bun run build:dev:full` |
| Docs-only changes | `git diff --check -- docs/maps/auth-accounts-oauth.md docs/maps/codex-core.md` |

There are focused tests for `/login`, `/switch-account`, `/rename-account`,
`/accounts`, and `/delete-account`. There are still no focused tests for
`/logout`; for changes there, pair source inspection with a focused manual or
integration check.

## Common Failure Routes

| Symptom | Inspect in this order | Why |
|---|---|---|
| "Not logged in" for Anthropic despite prior login | `src/utils/auth.ts:getAuthTokenSource()` -> `src/utils/auth.ts:getClaudeAIOAuthTokens()` -> `src/utils/secureStorage/` -> `src/services/api/claudeAccountPool.ts` | Env/FD/bare-mode guards, pool shadowing, keychain cache, and plaintext fallback can each change what token is visible. |
| Console API key path uses wrong key | `src/utils/auth.ts:getAnthropicApiKeyWithSource()` -> `src/utils/auth.ts:saveApiKey()` -> `src/utils/authPortable.ts` | Env approval, FD keys, apiKeyHelper, and managed Console-login keys have distinct precedence and storage. |
| OAuth browser callback stalls | Anthropic: `src/services/oauth/auth-code-listener.ts`, `src/services/oauth/index.ts`; Codex: `src/services/oauth/codex-client.ts` | Anthropic uses dynamic localhost ports and manual fallback; Codex requires fixed port 1455 and has its own completion page. |
| Wrong Anthropic profile after switching | `src/commands/switch-account/switch-account.ts` -> `src/services/api/claudeAccountPool.ts:syncClaudeAccountToStorage()` -> `src/utils/auth.ts:clearOAuthTokenCache()` | Active Claude account must be copied back to keychain/config for legacy consumers. |
| Wrong Codex account after `/switch-account` | `src/commands/switch-account/switch-account.ts` -> `src/services/api/codexAccountLeaseManager.ts` -> `src/services/api/codex-fetch-adapter.ts` | Pool activeIndex alone is not enough; main lease and Codex cache context must be updated. |
| Codex pool appears exhausted | `src/services/api/client.ts` -> `src/services/api/withRetry.ts` -> `src/services/api/codexAccountLeaseManager.ts` -> `src/services/api/codexAccountPool.ts` -> `src/services/api/codexUsage.ts` | Distinguish `auth.missing` (no account), `account.pool.unavailable` (accounts exist but none are healthy), `quota.exhausted` (every configured account is quota-blocked), dead refresh tokens, recent connection errors, and usage-hint premarking. A mixed capped-plus-dead pool requires credential recovery rather than `/continue-after-limit`. Single-account pool inventory still manages credentials and prevents stale config fallback. |
| External agent needs to know whether GPT work is worth delegating | `src/cli/handlers/codexStatus.ts` -> `src/services/api/codexStatus.ts` -> `src/services/api/codexAccountPool.ts` -> `src/services/api/codexUsage.ts` | Use the `cat-code codex status --json` observation as advisory scheduling input only. It can say `delegate`, `wait`, `recheck`, `attempt`, or `human_recovery`, but it does not reserve an account and does not share in-memory cap state with the next process. |
| Open Design or SDK consumer received `cat_code_account_diagnostic` | `src/services/api/accountDiagnostics.ts` -> `src/services/api/client.ts` -> `src/services/api/withRetry.ts` -> `src/commands/accounts/accounts.ts` | Check the diagnostic code before reading optional fields: the required envelope drives remediation, while optional fields are sanitized hints only. Recovery stays on Cat Code login and `/accounts`, not downstream profile selection. |
| Codex refresh changes account identity | `src/codex-core/accounts.ts` -> `src/services/api/codexTokenRefresh.ts` -> `src/services/api/codexAccountPool.ts` | Identity mismatch intentionally saves a new profile and does not transfer alias metadata to the new account. |
| `/logout` did not delete Codex vault accounts | `src/commands/logout/logout.tsx` -> `src/commands/delete-account/delete-account.ts` | Full logout clears session/config credentials but intentionally leaves Codex vault profiles for `/delete-account`. |
| Image generation uses the wrong Codex account or stale token | `src/tools/GenerateImageTool/GenerateImageTool.ts` -> `src/services/api/client.ts` -> `src/services/api/codexAccountLeaseManager.ts` -> `src/codex-core/accounts.ts` | Image auth should use the same async lease-aware resolver and refresh-on-use path as text requests. |

## Traps And Stale Assumptions

- `/login` is provider-neutral. Do not reintroduce `openAIOnly` at that command:
  Anthropic subscription, Console/API, third-party, and OpenAI/Codex are all
  reachable through the shared picker.
- Do not assume Codex OAuth uses `OAuthService`. It has a separate
  `src/services/oauth/codex-client.ts` implementation and a fixed callback
  port.
- Do not assume all Anthropic auth is OAuth. API keys, apiKeyHelper, file
  descriptors, managed OAuth env tokens, third-party providers, and bare mode
  each alter selection.
- Do not assume keychain and global config hold the same data. Anthropic OAuth
  tokens live in secure storage; Anthropic profile metadata and the Codex config
  token mirror live in global config; vault accounts live under `~/claude-vault`
  or `~/codex-vault`.
- Do not assume the Codex config token mirror is the source of truth once vault
  pool inventory exists. A single pool account is enough for pool-managed
  credentials, classification, and refresh recovery.
- Do not use `isPoolActive()` for Codex credential routing. Use
  `poolManagesCredentials()` for token/classification authority and
  `canFailover()` for general rotation; cap recovery from a known failed account uses
  `hasSelectableAccountOtherThan(failedAccountId)` so a sole healthy replacement
  remains usable. `isPoolActive()` is the legacy failover alias.
- Do not assume pool active account and request account are always identical.
  Codex leases can pin main-thread or subagent requests independently, and UI
  should prefer lease-first display.
- Do not mark Codex accounts capped for generic connection errors. The retry
  path has a separate non-capping failover branch.
- Do not bypass `accountDiagnostics.ts` when crossing process boundaries.
  Structured diagnostics must be sanitized before they reach SDK, app/sidecar,
  or Open Design consumers.
- Do not tell downstream clients to choose Cat Code profiles or accounts.
  Recovery stays inside Cat Code: downstream surfaces can prompt for Cat Code
  login or Cat Code `/accounts`, but they do not select profiles themselves.
- Do not use old Codex design docs as the source of truth without checking the
  current pool, lease, retry, client, and refresh files above.
