# Cat Code Codex Usage & Accounts Reconnaissance Dossier

This document outlines how Cat Code currently manages OpenAI Codex usage tracking, multi-account routing/pools, and command availability gating. All facts are cited directly from the codebase source files.

---

## 1. Command Availability & Session Gating

### Union Definition & Gating
* **`CommandAvailability` Union:** Defined in [src/types/command.ts:172-179](file:///Users/pt/cat-code/src/types/command.ts#L172-179) as:
  ```typescript
  export type CommandAvailability =
    | 'claude-ai'
    | 'console'
    | 'openai'
  ```
* **Availability Filtering:** Implemented in `meetsAvailabilityRequirement(cmd)` in [src/commands.ts:437-468](file:///Users/pt/cat-code/src/commands.ts#L437-468).
* **OpenAI Gating Match:** A Codex or OpenAI-authenticated session matches `'openai'`. If a command specifies `'openai'` in its `availability` array, `meetsAvailabilityRequirement` returns `true` if `provider === 'openai'` ([src/commands.ts:457-459](file:///Users/pt/cat-code/src/commands.ts#L457-459)).

### Session Type Detection
* **Computed State:** `getAPIProvider()` in [src/utils/model/providers.ts:14-20](file:///Users/pt/cat-code/src/utils/model/providers.ts#L14-20) resolves the provider using computed session state:
  1. Checks the active session provider override: `getSessionProvider()` in [src/bootstrap/state.ts:874-876](file:///Users/pt/cat-code/src/bootstrap/state.ts#L874-876).
  2. Falls back to environment variables: `getEnvAPIProvider()` in [src/utils/model/providers.ts:23-35](file:///Users/pt/cat-code/src/utils/model/providers.ts#L23-35).
* **Codex Subscription Check:** `isCodexSubscriber()` in [src/utils/auth.ts:1693-1700](file:///Users/pt/cat-code/src/utils/auth.ts#L1693-1700) determines if a session is Codex-active by verifying `getAPIProvider() === 'openai'` and that Codex tokens exist in the pool or config via `hasCodexTokens()`.

### The Gating Drift Trap
* **Verification:** Command availability gating (`meetsAvailabilityRequirement`) retrieves the provider using `getAPIProvider()` ([src/commands.ts:439](file:///Users/pt/cat-code/src/commands.ts#L439)) which queries computed session state.
* **Gating Trap Check:** Unlike the API client initialization (`getAnthropicClient`) which resolves the provider from the requested model string using `resolveRequestProvider(model, provider)` ([src/services/api/client.ts:356](file:///Users/pt/cat-code/src/services/api/client.ts#L356)), command availability gating **does not inspect or re-derive the provider from the active model string**. 
* **Implication:** If the session provider (computed state) drifts from the active model string, the command availability check will restrict slash commands based on the session provider, not the active model.

---

## 2. /usage Command & UI Rendering

### Command Definition
* **Metadata & Gating:** Defined in [src/commands/usage/index.ts](file:///Users/pt/cat-code/src/commands/usage/index.ts) with `availability: ['claude-ai']` ([line 7](file:///Users/pt/cat-code/src/commands/usage/index.ts#L7)) and lazy-loads the command module using `load: () => import('./usage.js')` ([line 8](file:///Users/pt/cat-code/src/commands/usage/index.ts#L8)).
* **Entry Point:** The command call in [src/commands/usage/usage.tsx:4-6](file:///Users/pt/cat-code/src/commands/usage/usage.tsx#L4-6) returns the settings screen prepopulated to the usage tab:
  ```tsx
  return <Settings onClose={onDone} context={context} defaultTab="Usage" />;
  ```

### Render Behavior (Codex vs. Claude)
* **Settings Component:** The UI is rendered in [src/components/Settings/Usage.tsx](file:///Users/pt/cat-code/src/components/Settings/Usage.tsx).
* **Claude Account View:** Displays weekly and session limits using `LimitBar` components: `five_hour` ("Current session"), `seven_day` ("Current week (all models)"), and `seven_day_sonnet` ("Current week (Sonnet only)") ([src/components/Settings/Usage.tsx:239-257](file:///Users/pt/cat-code/src/components/Settings/Usage.tsx#L239-257)).
* **Codex Account View:** If the pool is active (`isPoolActive()`), it mounts `<CodexPoolUsageSection />` ([src/components/Settings/Usage.tsx:263](file:///Users/pt/cat-code/src/components/Settings/Usage.tsx#L263)).
  * **Free Plans:** Renders the text `"Upgrade to a paid plan to use Codex."` ([src/components/Settings/Usage.tsx:456](file:///Users/pt/cat-code/src/components/Settings/Usage.tsx#L456)).
  * **Paid Plans:** Renders a list of account cards showing separate `LimitBar` widgets for the `"5h"` primary and `"7d"` secondary windows ([src/components/Settings/Usage.tsx:461-473](file:///Users/pt/cat-code/src/components/Settings/Usage.tsx#L461-473)).
  * **Capped/Dead Status:** Renders status-specific warning labels (e.g., `"Usage cap reached. Switch accounts or wait for reset."` or `"Account unavailable. Re-login may be required."`) ([src/components/Settings/Usage.tsx:440-446](file:///Users/pt/cat-code/src/components/Settings/Usage.tsx#L440-446)).

---

## 3. Codex Usage Client (`codexUsage.ts`)

* **Target File:** [src/services/api/codexUsage.ts](file:///Users/pt/cat-code/src/services/api/codexUsage.ts)
* **HTTP Request Details:**
  * **Endpoint:** `https://chatgpt.com/backend-api/wham/usage` ([line 74](file:///Users/pt/cat-code/src/services/api/codexUsage.ts#L74))
  * **Method:** `GET` ([line 116](file:///Users/pt/cat-code/src/services/api/codexUsage.ts#L116))
  * **Headers:** ([lines 118-123](file:///Users/pt/cat-code/src/services/api/codexUsage.ts#L118-123))
    * `Authorization`: `Bearer ${accessToken}`
    * `Accept`: `application/json`
    * `chatgpt-account-id`: `accountId`
    * `originator`: `codex_cli_rs`
* **Response Parsing:** Performed in `parseUsageResponse(accountId, data)` ([lines 503-546](file:///Users/pt/cat-code/src/services/api/codexUsage.ts#L503-546)). It maps properties into a strict `AccountUsage` object containing account/user identifiers, limits, primary/secondary windows, and credits.
* **Dropped Payload Fields:** Any fields not mapped by `parseUsageResponse` (e.g., potential upstream fields like `rate_limit_reset_credits`) are dropped from the return value.
* **Caching & TTL:** Cache is stored in `cachedSnapshot` ([line 81](file:///Users/pt/cat-code/src/services/api/codexUsage.ts#L81)) and expires after 1 minute (`CACHE_TTL_MS = 60_000` at [line 82](file:///Users/pt/cat-code/src/services/api/codexUsage.ts#L82)). Calling `fetchPoolUsage({ forceRefresh: true })` bypasses the cache ([lines 163-164](file:///Users/pt/cat-code/src/services/api/codexUsage.ts#L163-164)).
* **Cache Invalidation:** Calling `invalidateUsageCache()` sets `cachedSnapshot = null` ([lines 429-431](file:///Users/pt/cat-code/src/services/api/codexUsage.ts#L429-431)).

### Consumers
* **`fetchAccountUsage` Consumers:**
  * [src/commands/switch-account/switch-account.ts:407](file:///Users/pt/cat-code/src/commands/switch-account/switch-account.ts#L407)
* **`fetchPoolUsage` Consumers:**
  * [src/commands/accounts/accounts.ts:35](file:///Users/pt/cat-code/src/commands/accounts/accounts.ts#L35)
  * [src/components/LogoV2/AccountsPanel.tsx:326](file:///Users/pt/cat-code/src/components/LogoV2/AccountsPanel.tsx#L326)
  * [src/components/Settings/Usage.tsx:389](file:///Users/pt/cat-code/src/components/Settings/Usage.tsx#L389)
  * [src/services/api/codexAccountPool.ts:202](file:///Users/pt/cat-code/src/services/api/codexAccountPool.ts#L202) (initial load)
  * [src/services/api/codexAccountPool.ts:323](file:///Users/pt/cat-code/src/services/api/codexAccountPool.ts#L323) (failover rotate)

---

## 4. Account Pool Management (`codexAccountPool.ts`)

* **Target File:** [src/services/api/codexAccountPool.ts](file:///Users/pt/cat-code/src/services/api/codexAccountPool.ts)
* **`PoolAccount` Record Structure:** Defined in [lines 27-52](file:///Users/pt/cat-code/src/services/api/codexAccountPool.ts#L27-52):
  ```typescript
  export interface PoolAccount {
    accountId: string
    accessToken: string
    refreshToken: string
    expiresAt: number
    source: 'vault' | 'config'
    status: 'healthy' | 'dead' | 'capped' | 'quarantined'
    statusReason?: PoolAccountStatusReason
    lastUsedAt: number
    lastError?: string
    lastRefreshIso?: string
    vaultFilePath?: string
    alias?: string
    usagePrimary?: number
    usageWeekly?: number
    usageAllowed?: boolean
    usageLimitReached?: boolean
    usageFetchedAt?: number
    usageResetAt?: number
    cappedAt?: number
    planType?: string
    planExpiresAt?: string
    lastErrorAt?: number
  }
  ```

### Status Lifecycle Functions
* **`markPoolAccountCapped`:** Sets status to `'capped'`, statusReason to `'usage_cap'`, sets `usagePrimary = 100`, `usageAllowed = false`, `usageLimitReached = true`, and sets `cappedAt = Date.now()` ([lines 474-491](file:///Users/pt/cat-code/src/services/api/codexAccountPool.ts#L474-491)).
* **`markPoolAccountStatus`:** Updates the status and reason, clearing `cappedAt` if status becomes `'healthy'` ([lines 435-472](file:///Users/pt/cat-code/src/services/api/codexAccountPool.ts#L435-472)).
* **`rotateOnFailure`:** Triggered on 429 errors. Caps the active account (sets `status = 'capped'`, `statusReason = 'usage_cap'`, `usagePrimary = 100`, `usageAllowed = false`, `usageLimitReached = true`, `cappedAt = Date.now()`, `lastError = 'Usage cap hit (429)'`) and activates the next healthy LRU account ([lines 287-327](file:///Users/pt/cat-code/src/services/api/codexAccountPool.ts#L287-327)).

### Persistence & Storage
* **Where Capped/Usage State Lives:** Capped timestamps and usage hints are **kept entirely in-memory** inside the singleton `pool` state ([lines 86-90](file:///Users/pt/cat-code/src/services/api/codexAccountPool.ts#L86-90)).
* **Disk Writing Limitations:** The vault save function `saveCodexTokenToVault` ([lines 693-779](file:///Users/pt/cat-code/src/services/api/codexAccountPool.ts#L693-779)) only persists credentials (`access_token`, `refresh_token`, `expires_at`), email, and alias to vault JSON files. Usage metrics and capped status are **never** saved to disk.

### Immediate Uncapping Requirements
To restore a capped account to a usable state instantly in memory, the following values must be modified on its `PoolAccount` record:
1. `status` must be set to `'healthy'`.
2. `statusReason` must be set to `undefined`.
3. `lastError` must be set to `undefined`.
4. `cappedAt` must be set to `undefined`.
5. **Usage hints must be updated or invalidated:** If `usageFetchedAt` is newer than 5 minutes (`hasFreshPoolAccountUsageHint` is true), the account will still be blocked by `getCodexAccountAvailability` ([lines 1311-1341](file:///Users/pt/cat-code/src/services/api/codexAccountPool.ts#L1311-1341)) unless `usageAllowed` is set to `true` and `usageLimitReached` is set to `false`, or `usageFetchedAt` is reset/cleared.

---

## 5. Token Management & Refreshes

### Resolving Specific Pool Account Tokens
* **Main/Subagent Routing:** `resolveCodexOAuthTokensForLeaseOwner` in [src/services/api/client.ts:231-295](file:///Users/pt/cat-code/src/services/api/client.ts#L231-295) retrieves the tokens of a specific account in the pool mapped to a lease owner ID.
* **Lease Fallbacks:** If the requested account is blocked by a usage cap, it attempts to repair the lease via `repairCodexLeaseIfNonSelectable` to route to a healthy alternative.

### Core Refresh Operations
* **Vault Refresh Client:** `refreshAccountTokens` in [src/services/api/codexTokenRefresh.ts:259-640](file:///Users/pt/cat-code/src/services/api/codexTokenRefresh.ts#L259-640) handles the rotation:
  * Performs a `POST` request to `https://auth.openai.com/oauth/token` ([line 34](file:///Users/pt/cat-code/src/services/api/codexTokenRefresh.ts#L34)) with body fields: `client_id: 'app_EMoamEEZ73f0CkXaXp7hrann'` ([line 35](file:///Users/pt/cat-code/src/services/api/codexTokenRefresh.ts#L35)) and `grant_type: 'refresh_token'`.
  * Writes the new tokens to the vault profile file atomically on success ([line 607](file:///Users/pt/cat-code/src/services/api/codexTokenRefresh.ts#L607)) and updates the active pool via `appendAccount` ([line 609](file:///Users/pt/cat-code/src/services/api/codexTokenRefresh.ts#L609)).

### Refresh-on-401 Retry Behavior
* **Error Gating:** The ChatGPT fetch adapter identifies auth failures using `codexErrorTextIndicatesRevokedAuth` ([src/services/api/codex-fetch-adapter.ts:319-337](file:///Users/pt/cat-code/src/services/api/codex-fetch-adapter.ts#L319-337)) and throws a `CodexAccountAuthError`.
* **Retry Loop:** Handled in `src/services/api/withRetry.ts:582-700` ([src/services/api/withRetry.ts#L582-700]):
  * Catches `CodexAccountAuthError` and triggers `await refreshAccountTokens(...)` using the account's credentials.
  * If refresh recovers (`status === 'refreshed'`), it clears the client cache (`client = null`) and retries the API request immediately.
  * If refresh fails with a credentials error (e.g. `ReauthenticationRequiredError`), the account is marked `'dead'`, lease failover rotates the request to a different account, and a retry is attempted.

---

## 6. Accounts UX & Interaction Patterns

### `/accounts` Command
* **Interaction Model:** Defined in [src/commands/accounts/accounts.ts](file:///Users/pt/cat-code/src/commands/accounts/accounts.ts). It is a text-only command of type `local` returning a plain string under `{ type: 'text', value: string }` ([line 108](file:///Users/pt/cat-code/src/commands/accounts/accounts.ts#L108)). It is non-interactive.

### Closest Interactive Selection Patterns
* **Usage Component Pattern:** The best precedent for a component that runs asynchronous fetches and displays results is the `Usage` tab view in [src/components/Settings/Usage.tsx:382-481](file:///Users/pt/cat-code/src/components/Settings/Usage.tsx#L382-481):
  * Mounts a best-effort asynchronous fetch (`fetchPoolUsage`) in a React `useEffect` callback.
  * Updates React state (`useState`) to show dynamic loading text, errors, or populated lists.
  * Captures shortcuts (like retry or cancel) using the `useKeybinding` hook.
* **OAuth Form Flow:** The `Login` component in [src/commands/login/login.tsx](file:///Users/pt/cat-code/src/commands/login/login.tsx) mounts a `ConsoleOAuthFlow` inside a `Dialog` container, executing browser hooks and handling manual text entries for token verification.

---

## 7. The Dead Stub `/reset-limits`

* **Stub Location:** [src/commands/reset-limits/index.js](file:///Users/pt/cat-code/src/commands/reset-limits/index.js)
* **Stub Definition:**
  ```javascript
  const stub = { isEnabled: () => false, isHidden: true, name: 'stub' };
  export default stub;
  export const resetLimits = stub;
  export const resetLimitsNonInteractive = stub;
  ```
* **Git History Origin:** Added during initial merge cycles in `f66f3ab7b5d918b9f3b999bd1be3fefd3330ea41` ("Merge pull request #11 from paoloanzn/fix/codex-provider-sticking").
* **Reason for Disablement:** The `/reset-limits` command is an upstream Claude Code feature designed specifically for Anthropic internal developers (`process.env.USER_TYPE === 'ant'`) to reset rate limits on internal environments ([src/services/rateLimitMessages.ts:340](file:///Users/pt/cat-code/src/services/rateLimitMessages.ts#L340)). Because Cat Code is a client-side fork running outside Anthropic's private infrastructure, it is permanently disabled via this static `isEnabled: () => false` stub.

---

## 8. Conventions

### Local-JSX Command Rendering
* **Implementation Signature:** JSX commands implement `LocalJSXCommandCall` ([src/types/command.ts:133-137](file:///Users/pt/cat-code/src/types/command.ts#L133-137)), taking a completion callback (`onDone: LocalJSXCommandOnDone`), a command execution context (`context: LocalJSXCommandContext`), and string arguments.
* **Components:** Renders interface components from `src/components/design-system/` (such as `Dialog`) built on Ink text layouts.
* **Completion Trigger:** Async operations are reported to the REPL by invoking `onDone(resultText, options)`.

### UUID Generation
* **Precedent:** Standard practice across the codebase is to utilize the Node.js built-in `crypto` module.
* **Usage:** `import { randomUUID } from 'crypto'` ([src/services/api/codexTokenRefresh.ts:11](file:///Users/pt/cat-code/src/services/api/codexTokenRefresh.ts#L11)) and invoking `randomUUID()` to generate task/session identifiers.

### Test Architecture
* **Test Runner:** Driven by Bun's native test suite runner via `bun test` (e.g. `bun test <file-path>`).
* **Nearest Test Specifications:**
  * **Usage Tracking:** [src/services/api/codexUsage.test.ts](file:///Users/pt/cat-code/src/services/api/codexUsage.test.ts) (validates usage sorting, cap parsing, and warning triggers).
  * **Account Pools:** [src/services/api/codexAccountPool.test.ts](file:///Users/pt/cat-code/src/services/api/codexAccountPool.test.ts) and [src/services/api/codexAccountLeaseManager.test.ts](file:///Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts) (validates LRU rotation, lease repairs, and status updates).
  * **Command Gating:** [src/utils/fastMode.test.ts](file:///Users/pt/cat-code/src/utils/fastMode.test.ts) (includes direct assertions on `meetsAvailabilityRequirement`).

---

## 9. Gotchas

* **Observational 401 Gating:** In `codexUsage.ts` and `codexUsage.test.ts`, HTTP 401 errors received during usage checks are treated as purely observational; the client does NOT attempt to trigger token refreshes on usage polling failure ([src/services/api/codexUsage.test.ts:587](file:///Users/pt/cat-code/src/services/api/codexUsage.test.ts#L587)).
* **Usage Cache Age Lockout:** Usage results are cached for 60 seconds (`CACHE_TTL_MS = 60_000`, [src/services/api/codexUsage.ts:82](file:///Users/pt/cat-code/src/services/api/codexUsage.ts#L82)), blocking subsequent fetches unless forced.
* **Uncapping Lag Grace Period:** The account pool enforces a 2-minute grace period (`USAGE_UNCAP_GRACE_MS = 120_000`, [src/services/api/codexAccountPool.ts:1247](file:///Users/pt/cat-code/src/services/api/codexAccountPool.ts#L1247)) after a hard 429 cap occurs to prevent stale usage cache data from prematurely uncapping the account.
* **Capped State Ephemerality:** Capped account timestamps and usage metrics exist solely in memory; a CLI restart resets the status of all accounts back to `'healthy'` (subject to new 429 failures or live usage checks).
* **Lease Owner Token Gating:** Token resolution for subagents is partitioned based on lease ownership. Modifying active pool state (such as switching accounts manually) does not propagate to active subagent leases unless `repairCodexLeaseIfNonSelectable` is triggered or the lease is explicitly reassigned/released.
