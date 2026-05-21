# Account Switching — Full Investigation Report

**Date:** 2026-05-20
**Scope (final):** Codex multi-account pool, lease manager, terminal (Ink) UI for account state, and all automatic account-switch triggers in cat-code. Claude-side findings included as a secondary section.
**Method:** Read-only static investigation. Four breadth audits, three focused deep-dives, and one independent verification review — all via parallel subagents. No code was changed.
**Status:** Investigation complete and independently reviewed. No fixes applied.

> **Verification pass (added 2026-05-20):** A separate review pass independently re-checked each of the 10 top bugs against current source. Results: **0 bugs disproved; 2 fully confirmed; 8 partially confirmed** with stale details or overstated impact. See §15 ("Verification Pass — Corrections & Refinements") and §16 ("Revised Patch Plan & Open Product Questions") for the corrected claims. Inline bug entries in §4 have been annotated with `[CORRECTION]` markers where the original text was wrong; the original wording is retained for audit trail.

---

## Table of Contents

1. [Verdict](#1-verdict)
2. [Investigation Methodology](#2-investigation-methodology)
3. [System Model — How Account Switching Actually Works](#3-system-model--how-account-switching-actually-works)
4. [Top Bugs — Forensic Detail](#4-top-bugs--forensic-detail)
   - [Bug #1 — Subagent leases keep routing to the old Codex account](#bug-1--subagent-leases-keep-routing-to-the-old-codex-account-after-switch-account)
   - [Bug #2 — LogoV2 / AccountsPanel does not update after switch](#bug-2--logov2--accountspanel-does-not-update-after-switch-account)
   - [Bug #3 — `failoverCodexLease` silently mutates global `activeIndex`](#bug-3--failovercodexlease-silently-mutates-global-activeindex)
   - [Bug #4 — Auto-failover paths do not persist `activeCodexAccountId`](#bug-4--auto-failover-paths-do-not-persist-activecodexaccountid)
   - [Bug #5 — Identity-mismatch on `codex-core/accounts.maybeRefreshAccount` is silent](#bug-5--identity-mismatch-on-codex-coreaccountsmayberefreshaccount-is-silent)
   - [Bug #6 — `appendAccount` writes `expiresAt: Date.now()` → re-refresh loop](#bug-6--appendaccount-writes-expiresat-datenow--re-refresh-loop)
   - [Bug #7 — Identity-mismatch on auto-refresh is non-activating](#bug-7--identity-mismatch-on-auto-refresh-is-non-activating)
   - [Bug #8 — `selectAccountForTurn` is dead code; its setting does nothing](#bug-8--selectaccountforturn-is-dead-code-its-setting-does-nothing)
   - [Bug #9 — Misleading "Switched from X to X" message on no-op](#bug-9--misleading-switched-from-x-to-x-message-on-no-op)
   - [Bug #10 — Intra-pool prefix ambiguity silently picks the first match](#bug-10--intra-pool-prefix-ambiguity-silently-picks-the-first-match)
5. [Additional Edge Findings](#5-additional-edge-findings)
6. [Auto-Switch Trigger Catalog](#6-auto-switch-trigger-catalog)
7. [Persistence Consistency Matrix](#7-persistence-consistency-matrix)
8. [User-Visible vs. Actual State Matrix](#8-user-visible-vs-actual-state-matrix)
9. [Diagnostic Coverage Audit](#9-diagnostic-coverage-audit)
10. [Recursion / Loop Risk](#10-recursion--loop-risk)
11. [Suggested Test Cases](#11-suggested-test-cases)
12. [Combined Fix Priority](#12-combined-fix-priority)
13. [Claude-Pool Findings (Secondary Scope)](#13-claude-pool-findings-secondary-scope)
14. [Unverified Claims / Open Questions](#14-unverified-claims--open-questions)
15. [Verification Pass — Corrections & Refinements](#15-verification-pass--corrections--refinements)
16. [Revised Patch Plan & Open Product Questions](#16-revised-patch-plan--open-product-questions)
17. [Appendix A — Audit Methodology Detail](#appendix-a--audit-methodology-detail)
18. [Appendix B — Raw Subagent Findings (Index)](#appendix-b--raw-subagent-findings-index)
19. [File Index](#file-index)

---

## 1. Verdict

Account / "profile" switching in cat-code is **partially working**.

The common, single-user, manually-driven `/switch-account` path completes, persists the new active account, and the next main-thread request uses it. Under the hood, however, there are real correctness gaps in four clusters:

| Cluster | Verdict |
|---|---|
| Manual `/switch-account` — happy path | Works |
| Subagent lease invalidation on switch / delete | Broken (silent wrong-routing) |
| Terminal (Ink) UI re-render after switch | Broken (UI lies until restart) |
| Automatic failover persistence & lease isolation | Broken (subagent 429 hijacks main + spring-back on restart) |
| Identity-mismatch handling on token refresh | Inconsistent (two divergent code paths, one silent) |
| Diagnostic coverage for implicit account changes | Incomplete (~7 silent triggers) |

The user-facing report of *"why did my account change?"* and *"why did it spring back after restart?"* are not single bugs — they are the conjunction of Bugs #3 + #4 + #2.

---

## 2. Investigation Methodology

### Phase 1 — Orientation

- Read `docs/maps/WORKSPACE_MAP.md` to identify the relevant subsystem.
- Read `docs/maps/auth-accounts-oauth.md` ("Auth, Accounts, And OAuth Map", last refreshed 2026-05-12) — this established that "profile switching" maps to Codex/Claude account pools, with `src/commands/switch-account/` as the user-facing surface.
- Confirmed scope: account = profile (no other "profile" abstraction exists in this repo apart from `userProfile` metadata).

### Phase 2 — Breadth Audits (4 parallel subagents)

Each subagent received self-contained prompts; none could see this conversation. They ran in parallel:

| # | Subagent | Focus |
|---|---|---|
| 1 | Switch-account command flow audit | End-to-end `/switch-account` for both providers |
| 2 | Codex pool & lease audit | `codexAccountPool`, `codexAccountLeaseManager`, identity mismatch, cap/failover |
| 3 | Claude account pool audit | `claudeAccountPool`, keychain sync, token refresh write-back |
| 4 | Diagnostics & UI for switching | `accountDiagnostics`, REPL `activeProfile`, `AccountsPanel`, `LogoV2` |

### Phase 3 — Deep Dives (3 parallel subagents)

After narrowing scope to Codex + terminal UI per user direction:

| # | Subagent | Focus |
|---|---|---|
| 5 | Subagent lease on switch | Exhaustive trace of `registerCodexLease`, `reassignCodexLeaseToActiveAccount`, lease lifecycle, fix designs |
| 6 | LogoV2 memo / UI staleness | Root cause of frozen banner, compiler-output analysis, fix options |
| 7 | Auto failover & cap rotation | Every implicit account-change trigger, persistence, lease isolation, recursion |

### Phase 4 — Synthesis

This document. All findings here have been cross-checked against at least one deep-dive's evidence; where conflict existed, the deep-dive trumped the breadth audit. Items I could not cross-verify are explicitly listed in §14.

### Scope Adjustments

The user narrowed scope twice during the investigation:
- After breadth audits: drop Claude-side, keep Codex + Ink UI.
- After deep-dives #5 and #6: add "auto-switch when one account is exhausted, plus any other implicit-switch mechanic."

Claude-side findings are kept as §13 for completeness; the rest of the document treats Codex as primary.

---

## 3. System Model — How Account Switching Actually Works

### 3.1 The four state surfaces

Codex account state lives in **four independent layers**:

1. **In-memory pool** (`src/services/api/codexAccountPool.ts`) — `pool.accounts[]`, `pool.activeIndex`, per-account status (`healthy | capped | dead`), usage hints, alias map.
2. **In-memory lease map** (`src/services/api/codexAccountLeaseManager.ts`) — `codexLeasesByOwnerId: Map<string, CodexLease>`. Each lease pins `{ownerId, ownerType, accountId, strategy, state, selectionReason, updatedAt}`.
3. **Vault on disk** — `~/codex-vault/accounts/<accountId>.json` and optional `.codex-nootp/config.toml`.
4. **Global config on disk** — `~/.claude.json`:
   - `activeCodexAccountId` — pool's persisted active pointer
   - `codexOAuth` — legacy single-token entry (used as fallback when pool is inactive)

The bugs are mostly about **these four layers drifting out of sync**.

### 3.2 Lease ownership IDs and strategies

`CodexLeaseStrategy = 'spread' | 'follow-main'` (`codexAccountLeaseManager.ts:16`).

| Strategy | Behavior in `selectAccountForLease` |
|---|---|
| `'follow-main'` | If `resolveMainAccountId()` returns a healthy account, lease pins to main. Else falls through to "least crowded healthy". |
| `'spread'` | Ranks healthy candidates by live lease count, then **deprioritizes the main account**, then by recent usage. Explicitly designed to keep subagents off the main account. |

Defaults (`src/utils/settings/types.ts:341`): main = `'follow-main'`; subagent = `getInitialSettings().codexSubagentAccountStrategy ?? 'spread'`.

**`registerCodexLease` is idempotent**: if a lease for `ownerId` already exists, it early-returns (`codexAccountLeaseManager.ts:129-132`). Once registered, a lease's `accountId` only changes via `failoverCodexLease` or `reassignCodexLeaseToActiveAccount`.

### 3.3 Every `registerCodexLease` call site

| Site | `ownerId` source | `ownerType` | Default `strategy` |
|---|---|---|---|
| `src/query.ts:325` | literal `'main-thread'` | `'main'` | `'follow-main'` |
| `src/tools/AgentTool/AgentTool.tsx:1065` (async spawn) | `asyncAgentId` (agent UUID) | `'subagent'` | settings (`'spread'`) |
| `src/tools/AgentTool/AgentTool.tsx:1191` (sync spawn / foreground) | `syncAgentId` | `'subagent'` | settings |
| `src/services/api/claude.ts:1135` (per-request fallback) | `options.agentId` | `'subagent'` | settings |

**Resume path** (`src/tools/AgentTool/resumeAgent.ts`) does **not** register a lease. It depends on the per-request fallback at `claude.ts:1128` for resumed subagents on their first post-resume request.

### 3.4 Every lease-release site

- `releaseCodexLease(ownerId)` called from:
  - `src/tasks/LocalAgentTask/LocalAgentTask.tsx:470` (`completeAgentTask`)
  - `src/tasks/LocalAgentTask/LocalAgentTask.tsx:497` (`failAgentTask`)
  - `src/tasks/LocalAgentTask/LocalAgentTask.tsx:340` (`killAsyncAgent`)
  - `src/tasks/LocalAgentTask/LocalAgentTask.tsx:727` (`unregisterAgentForeground`)
  - `src/query.ts` (main-thread, on REPL shutdown — implicit)

**Implication:** Subagent leases outlive a single turn. Async ("background") subagents — by design after commit `33880cb` — outlive many turns and many `/switch-account` calls.

### 3.5 The `selectAccountForLease` ranking algorithm

When `registerCodexLease` is called for a new owner, `selectAccountForLease(strategy)` runs:

1. Filter to `status === 'healthy'` accounts.
2. For `'follow-main'`: try `resolveMainAccountId()` first; if healthy, return it. Otherwise step 4.
3. For `'spread'`: skip the main account from candidates.
4. Rank remaining candidates by:
   - `liveLeaseCounts.get(accountId)` ascending (least crowded first)
   - Error cooldown (accounts with recent errors deprioritized; `process.env.CODEX_POOL_ERROR_COOLDOWN_MS` default 60s — undocumented)
   - Usage-score ascending (lower usage hint = better)
   - `lastUsedAt` ascending (LRU)
5. Return the first.

`resolveMainAccountId` precedence (`codexAccountLeaseManager.ts`):
1. The main lease's current `accountId` if a main lease exists.
2. The account aliased `main` if any.
3. `pool.activeIndex`.

This ordering matters for fix design — see Bug #1.

### 3.6 The `/switch-account` flow

`src/commands/switch-account/switch-account.ts:performCodexSwitch` (line 51-84) does:

1. Resolve prefix → account (`switchToAccount(idPrefix)` in `codexAccountPool.ts`).
2. Update `pool.activeIndex` and persist `activeCodexAccountId` to config.
3. Call `reassignCodexLeaseToActiveAccount('main-thread')` — **only main**.
4. `resetCodexCacheContext()` — clears Codex cache-context metadata.
5. `clearAuthRelatedCaches()` — invalidates GrowthBook / betas / tool schema / policy / user.
6. Bump `authVersion` and `statusLineRefreshKey` in AppState.

`reassignCodexLeaseToActiveAccount` itself (`codexAccountLeaseManager.ts:213-231`):

```ts
function reassignCodexLeaseToActiveAccount(ownerId: string) {
  const existing = codexLeasesByOwnerId.get(ownerId)
  if (!existing) return
  if (pool.activeIndex < 0) return
  const active = pool.accounts[pool.activeIndex]
  if (existing.accountId === active.accountId) return // no-op
  existing.accountId = active.accountId
  existing.state = 'active'
  existing.selectionReason = 'manual /switch-account'
  existing.updatedAt = Date.now()
  touchPoolAccountUsage(active.accountId)
}
```

It is **single-owner**. There is no bulk variant.

### 3.7 The `failoverCodexLease` flow

Called from `withRetry.ts:417, :490, :599` and elsewhere:

```ts
function failoverCodexLease(ownerId, {markAccountCapped = true, failedAccountId}) {
  // ... select next account via selectAccountForLease(existing.strategy)
  //     excluding failedAccountId only when markAccountCapped is false
  // ... update lease.accountId
  // ... also: setActiveAccount(selection.accountId)   ← KEY POINT
  //     this mutates pool.activeIndex
}
```

**Mutating `pool.activeIndex` from a lease-scoped failover is the root cause of Bug #3.**

`setActiveAccount` in the lease manager **does not** call `persistActiveCodexAccountId`. That asymmetry is the root cause of Bug #4.

### 3.8 The request-time resolution path

For each Codex request:

1. `getAnthropicClient()` (`src/services/api/client.ts:217`) for Codex provider.
2. `resolveCodexOAuthTokensForLeaseOwner(codexLeaseOwnerId)` (`client.ts:234`) — reads `getCodexLeaseForOwner(ownerId).accountId`.
3. `poolAccountById.get(leasedAccountId).accessToken` → token used.
4. Returns `null` if the leased accountId is not in the pool (e.g. deleted).
5. The fetch adapter (`codex-fetch-adapter.ts:2503-2507`) re-reads the current lease per request, so the lease's `accountId` is authoritative even mid-stream.
6. Per-request `chatgpt-account-id`, `conversation-id`, and `prompt_cache_key` headers are all derived from the lease's `accountId`, **not** from `pool.activeIndex` directly.

This is why a stale lease is so silently load-bearing: the user sees the right "active" in `/accounts` (which reads `pool.activeIndex`) but the actual request goes to whatever the lease pinned.

### 3.9 Cap detection

| Error class | HTTP signal | WS signal | Outcome |
|---|---|---|---|
| `CodexAccountCapError` | `status === 429` | `CodexWebSocketUsageLimitError` | `failoverCodexLease({markAccountCapped: true})` or `switchToAccount(null)` |
| `CodexAccountAuthError` | `status === 401 \|\| 403` | (subsumed) | refresh token; on fail mark dead + failover |
| `APIConnectionError` | network errors | non-usage-limit errors | retry; on attempt ≥ 2 failover |
| `Claude OAuth revoked` | 403 + body `"OAuth token has been revoked"` | n/a | Claude-only (`isOAuthTokenRevokedError`) |

**Body parsing is absent for Codex.** Any non-cap 429 (e.g. per-request throttling) is treated as a permanent cap. Any Codex 403 (revoked, scoped, etc.) is funnelled through refresh-then-fail.

`markPoolAccountCapped` is **reversible**: `fetchPoolUsage` (`codexUsage.ts:249`) calls `markPoolAccountStatus(id, 'healthy')` when wham reports `allowed && !limitReached`. Default TTL ~60s. No other auto-recovery from `capped`.

`markAccountDead` is **permanent in-memory** until process restart or `appendAccount`. The `preserveCapped` guard means a successful refresh of a dead account does not auto-revive it.

---

## 4. Top Bugs — Forensic Detail

### Bug #1 — Subagent leases keep routing to the old Codex account after `/switch-account`

**Severity:** High. Silent wrong-routing.

**Root cause — three properties combine:**

1. `registerCodexLease` stores `accountId` at creation and is idempotent (`codexAccountLeaseManager.ts:129-132`).
2. `reassignCodexLeaseToActiveAccount` is single-owner (`codexAccountLeaseManager.ts:213-231`); `/switch-account` calls it only for `'main-thread'`.
3. Async subagents hold leases across many turns. Commit `33880cb` ("split subagent resume from `SendMessage`") makes long-lived subagents the norm.

**Wrong-routing code path (verbatim trace):**

```
User: /switch-account B

src/commands/switch-account/switch-account.ts:performCodexSwitch
  → switchToAccount(idPrefix)                        [codexAccountPool.ts]
       pool.activeIndex = index_of_B
       persistActiveCodexAccountId(B.accountId)      [writes ~/.claude.json]
  → reassignCodexLeaseToActiveAccount('main-thread') [codexAccountLeaseManager.ts:213]
       codexLeasesByOwnerId.get('main-thread').accountId = B.accountId
       ← all other leases UNTOUCHED
  → resetCodexCacheContext()
  → clearAuthRelatedCaches()
  → bump authVersion + statusLineRefreshKey

Later: async subagent fires a tool call
  src/services/api/claude.ts: sets codexLeaseOwnerId = options.agentId
  → getAnthropicClient()                              [client.ts:217]
  → resolveCodexOAuthTokensForLeaseOwner(agentId)    [client.ts:234]
       getCodexLeaseForOwner(agentId).accountId      ← STILL "A" (stale)
       poolAccountById.get('A').accessToken          ← A's token used
  → request goes to A.
```

**Verification of staleness:**

- `getCodexLeaseForOwner` is a plain map lookup; no re-resolution.
- `codex-fetch-adapter.ts:2503-2507` re-reads the lease per request — but the lease itself is what's stale.
- Per-request `chatgpt-account-id` header (`codex-fetch-adapter.ts:2552`) derives from the lease's `accountId`.
- Conversation-ID and prompt-cache key are per-account (`codexAccountPool.ts:62-64`), so the entire request envelope routes to A.

**Reproduction (5 steps):**

1. Configure ≥ 2 healthy Codex accounts (A active, B available). Set `codexSubagentAccountStrategy = 'follow-main'` for an unambiguous repro.
2. Send a prompt that spawns an async subagent (Agent tool with `async: true`). The subagent's `LocalAgentTask` calls `registerCodexLease({ownerId: asyncAgentId, ownerType: 'subagent', strategy: 'follow-main'})`. Since main-thread is on A, the subagent's lease pins to A.
3. While the subagent is still `running` (not `completed`/`failed`), run `/switch-account B`.
4. Trigger another tool call by the same subagent (e.g. via `SendMessage` or its own autonomy).
5. Inspect logs — `[codex-cache] request account=A …` in `codex-fetch-adapter.ts:2535` — confirms the subagent's request hit A, not B. `/accounts` shows B active. `taskStatusUtils.tsx:87` shows the subagent's lease holder still on A.

**`/delete-account` has the same single-owner bug.** `src/commands/delete-account/delete-account.ts:134-138`:

```ts
if (getPoolStatus().activeIndex >= 0) {
  reassignCodexLeaseToActiveAccount('main-thread')
} else {
  releaseCodexLease('main-thread')
}
```

A subagent that holds a lease referencing the just-deleted account will, on its next request, hit `poolAccountById.get(leasedAccountId) === undefined`, then `return null` at `client.ts:261`. The caller then throws `throwNoHealthyCodexAccount()` — surfacing as "No healthy Codex account available" for that subagent only, while the rest of the system is fine.

**Recommended fix — Option A (iterate all leases):**

Add a bulk variant `reassignFollowMainLeasesToActiveAccount()`:

```ts
function reassignFollowMainLeasesToActiveAccount() {
  if (pool.activeIndex < 0) return
  const active = pool.accounts[pool.activeIndex]
  for (const [ownerId, lease] of codexLeasesByOwnerId) {
    if (ownerId === 'main-thread') {
      reassignCodexLeaseToActiveAccount('main-thread')
      continue
    }
    if (lease.ownerType === 'subagent' && lease.strategy === 'follow-main') {
      if (lease.accountId === active.accountId) continue
      lease.accountId = active.accountId
      lease.state = 'active'
      lease.selectionReason = 'switch-account propagation'
      lease.updatedAt = Date.now()
      touchPoolAccountUsage(active.accountId)
      resetCodexCacheContextForOwner(ownerId) // new helper
    }
    // strategy === 'spread' → leave alone
  }
}
```

For `/delete-account`: any lease whose `accountId` equals the deleted account must be re-resolved (`selectAccountForLease(lease.strategy)`) or released, regardless of strategy. A spread subagent pinned to a deleted account is just as broken as a follow-main one.

**Rejected fix — Option B (invalidate-and-relazy-resolve):**

On switch, delete all non-main leases. Next request from each subagent hits the per-request fallback at `claude.ts:1128` and re-registers cleanly. Rejected because it loses spread stickiness (a spread subagent happily running on C gets dragged off C unnecessarily when the user switches main A → B). Useful only for `/delete-account`.

**Files / functions to change:**

- `src/services/api/codexAccountLeaseManager.ts` — add bulk reassign helper; `reassignCodexLeaseToActiveAccount` can stay for explicit single-owner use.
- `src/commands/switch-account/switch-account.ts` — call the bulk variant.
- `src/commands/delete-account/delete-account.ts` — Codex branch: iterate all leases pointing at deleted accountId.
- `src/tools/AgentTool/resumeAgent.ts` — verify resume path interacts cleanly (it depends on the per-request fallback, which already re-resolves).

**Second-order effects:**

- **Cache context churn.** Reassigning a follow-main subagent invalidates its prompt-cache (account-scoped). Mirror `resetCodexCacheContext()` per affected owner.
- **Spread subagents on `/switch-account`.** Option A intentionally leaves them. If users expect `/switch-account` to fully evict the old account from the session (e.g. because it's rate-limited and they're escaping it), spread subagents will keep hitting it. Worth a UX note.
- **Concurrency.** `failoverCodexLease` and the new bulk reassign are both unlocked map mutations. Existing code already has this race for `'main-thread'`; extending to N leases enlarges the window. Tolerable in single-process JS but worth a comment.
- **`resolveMainAccountId` ordering.** Since `resolveMainAccountId` reads the main lease's `accountId` first, the bulk reassign must reassign main **before** iterating follow-main subagents — otherwise follow-main subagents could briefly pick up the old main accountId during the iteration.

**Unverified:**

- Whether the dedicated-app surface (`src/app-runtime/`, `src/dedicated-app/`) has its own switch-account path that bypasses this code.
- Whether a `LocalAgentTask` that crashes without calling `failAgentTask` leaks a lease into the next process invocation (probably not — lease map is in-memory only).

---

### Bug #2 — LogoV2 / AccountsPanel does not update after `/switch-account`

**Severity:** High. UI lies about which account is active until restart.

**Confirmed root cause — two compounding freezes.**

#### Freeze A — React Compiler `react.memo_cache_sentinel`

`src/components/Messages.tsx:55-76`:

```ts
const LogoHeader = React.memo(function LogoHeader(t0) {
  const $ = _c(3);
  const { agentDefinitions } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <LogoV2 />;          // slot 0: no-deps, computed exactly once
    $[0] = t1;
  } else { t1 = $[0]; }
  let t2;
  if ($[1] !== agentDefinitions) {    // slots 1+2 keyed only on agentDefinitions
    t2 = <OffscreenFreeze>…{t1}…<StatusNotices …/></OffscreenFreeze>;
    $[1] = agentDefinitions; $[2] = t2;
  } else { t2 = $[2]; }
  return t2;
});
```

**Mechanism:**

- `_c(3)` is `useMemoCache(3)` from `node_modules/react/cjs/react-compiler-runtime.production.js:14` — a per-fiber slot array.
- Slot 0 holds `<LogoV2 />` behind the `react.memo_cache_sentinel` check, computed exactly once per fiber lifetime.
- Outer `React.memo` is keyed on `agentDefinitions`, which `/switch-account` never mutates. (Only `authVersion` and `statusLineRefreshKey` are bumped — see `switch-account.ts:21-25`.)
- `key={conversationId}` on `<LogoHeader />` (`Messages.tsx:679`) does not help — `conversationId` doesn't bump on switch.
- Result: `LogoHeader` never re-runs, `LogoV2`'s function body never re-executes, and the `<LogoV2 />` element reused is the original. `getGlobalConfig().oauthAccount?.displayName` read at `LogoV2.tsx:68` and `formatWelcomeMessage(username)` at lines 155 + 213 are frozen at first render.

#### Freeze B — `AccountsPanel` has no subscription

`src/components/LogoV2/AccountsPanel.tsx`:

- Reads `getPoolStatus()` (line 211, 275), `getClaudePoolStatus()` (line 98, 276), `isClaudePoolActive()` (line 95) as plain module functions.
- Usage fetches in `useEffect(…, [])` (lines 303-309) and `useEffect(…, [hasCodexAccounts])` (lines 311-318). Neither depends on `authVersion` or any account-change signal.
- Neither pool exposes any subscribe/emit API. `grep -rE 'subscribe|emit|EventEmitter' src/services/api/codexAccountPool.ts src/services/api/claudeAccountPool.ts` returns zero matches.

#### Signals fired on `/switch-account` vs. what UI consumes

| Signal | Bumped? | Where | Consumed by LogoV2 / AccountsPanel? |
|---|---|---|---|
| `authVersion` (AppState) | Yes | `clearAuthRelatedCaches` | **No** (used by `useApiKeyVerification`, `useVoiceEnabled`, MCP, login) |
| `statusLineRefreshKey` (AppState) | Yes | switch-account.ts:21-25 | **No** (StatusLine only — `StatusLine.tsx:183, 291`) |
| `config.oauthAccount` (disk + memory) | Yes (Claude only) | `syncClaudeAccountToStorage` | Read non-reactively |
| `webUIBus.activeProfile` | Indirectly | Next `emitWebStatus` call in `REPL.tsx:1378-1413` | Web client only, not terminal |
| Pool `activeIndex` | Yes | `switchToAccount` | Read non-reactively in `AccountsPanel` |
| Custom account-change emitter | — | **Does not exist** | — |

#### Stale UI surfaces (full list)

- Active bullet `●/○` for both Anthropic and Codex sections of `AccountsPanel`.
- 5h / 7d usage bars + reset times for both providers.
- Account email (Anthropic) / label (Codex).
- Compact-layout `welcomeMessage` (`LogoV2.tsx:155, 213`). Derived from `config.oauthAccount.displayName`.
- Full-layout `welcomeMessage` (`LogoV2.tsx:283`).
- For **Codex switches in particular**: `welcomeMessage` is doubly broken — even if Freeze A were fixed, Codex account info doesn't live in `config.oauthAccount`, so the compact welcome would still show whatever Claude name was last cached.

`Workspace`, `Agent`, `Model` lines in LogoV2 are unaffected — they read from other state.

#### Untracked `LogoV2.test.tsx`

The new untracked test file (`src/components/LogoV2/LogoV2.test.tsx`) only tests that switching `stdout.columns` from 100 → 60 (full → compact) doesn't trip Rules-of-Hooks errors. It catches a hook-shape bug fixed by hoisting `useState`/`useMainLoopModel`/`useAppState` above the early `if (layoutMode === 'compact')` branch. **It is unrelated to the staleness bug** and would not regress under any of the proposed fixes.

#### Reproduction

1. Start cat-code with ≥ 2 healthy Anthropic (or Codex) accounts in the pool, terminal ≥ 70 cols.
2. Observe LogoV2 banner: bullet on A, 5h bar shows A's usage.
3. Run `/switch-account <alias-of-B>`. Confirmation text says "Switched to B".
4. Re-renders triggered by `statusLineText` / `statusLineRefreshKey` bumps and the assistant reply — but the LogoV2 box does not change.
5. Restart the binary. Banner now shows B.

#### Recommended fix — minimal, surgical

In `src/components/Messages.tsx`, inside the `Messages` function, add:

```ts
const authVersion = useAppState(s => s.authVersion)
```

…and change the `<LogoHeader />` key from `key={conversationId}` to:

```ts
key={`${conversationId}:${authVersion}`}
```

`authVersion` is bumped by `clearAuthRelatedCaches()`, which `/switch-account`, `/login`, `/logout`, and `/delete-account` all call. This forces a fresh `LogoHeader` fiber on switch and preserves the load-bearing memo for per-keystroke renders.

**Belt-and-braces (optional)** — also have `AccountsPanelContent` consume `authVersion` and re-key its usage-fetch effects:

```ts
useEffect(() => { /* fetchUtilization */ }, [authVersion])
useEffect(() => { /* fetchPoolUsage */ }, [hasCodexAccounts, authVersion])
```

A remount from Freeze A's fix already discards local state, so this is redundant in steady state — useful only to eliminate a brief "active bullet flips but bars stay loading…" interim.

#### Rejected alternatives

- **`'use no memo'` directive or removing `React.memo`.** Directly contradicts the load-bearing comment at `Messages.tsx:47-54`. Dirtying LogoHeader on every Messages re-render cascades through Ink's `renderChildren` and pegs CPU on long sessions. High regression risk.
- **Subscribe API on the pools.** Over-engineered for one consumer.
- **Per-pool external-store hook.** Invasive — adds subscribe primitives to two pool modules that are bare mutable singletons today.

#### Second-order risks

- **Perf:** none steady-state. `authVersion` changes only on `/login`, `/logout`, `/switch-account`, `/delete-account`. A LogoHeader remount allocates one new `<LogoV2 />` subtree per switch — well under 16ms.
- **Mascot re-rolls on switch.** `LogoV2.tsx:96` uses `useState(() => Math.random())`. On remount the mascot art changes. Minor visual surprise, arguably a feature. If undesired, lift the seed to a module-scope const.
- **Tests:** the existing `LogoV2.test.tsx` doesn't touch `Messages.tsx`. Unaffected.
- **`OffscreenFreeze`:** wraps the new subtree; no change in semantics.

#### Unverified

- Whether `bun run build:dev:full` regenerates the compiled `Messages.tsx` from source or whether the patch must land in the committed compiled form. The file currently in repo is post-compiler output. This matters for the fix path — check before patching.
- Whether the dedicated-app surface has its own LogoV2 component (likely not, but worth a check).

---

### Bug #3 — `failoverCodexLease` silently mutates global `activeIndex`

**Severity:** High. Subagent 429 hijacks the main thread's account selection mid-session.

> **[CORRECTION — verification pass]** Impact is **pool / UI drift**, not immediate main-thread routing takeover. The main thread's request routing prefers its **own lease** over `pool.activeIndex` via `resolveCodexOAuthTokensForLeaseOwner` (`client.ts:221-247`) and the status line resolves from the main lease (`StatusLine.tsx:130-146`). So a subagent's failover flips global `pool.activeIndex` and `/accounts` / `AccountsPanel` displays, but the main thread keeps using its own lease until its own failover. The bug is real; the "hijacks main-thread routing" framing is overstated.

**Code:**

`src/services/api/codexAccountLeaseManager.ts:266-281`:

```ts
function failoverCodexLease(ownerId, opts = {}) {
  const { markAccountCapped = true, failedAccountId } = opts
  const existing = codexLeasesByOwnerId.get(ownerId)
  if (!existing) return
  if (markAccountCapped && existing.accountId) {
    markPoolAccountCapped(existing.accountId)
  }
  const exclude = !markAccountCapped ? failedAccountId : undefined
  const next = selectAccountForLease(existing.strategy, { exclude })
  if (!next) return
  existing.accountId = next.accountId
  existing.state = 'active'
  existing.selectionReason = 'failover'
  existing.updatedAt = Date.now()
  touchPoolAccountUsage(next.accountId)
  setActiveAccount(next.accountId)  // ← key line: mutates pool.activeIndex
}
```

**Why this is a bug:**

- The lease-isolation contract used by `/accounts`, `taskStatusUtils.tsx:87`, the status line, and `resolveCodexOAuthTokensForLeaseOwner`'s main-thread branch assumes that **only the main lease changes `activeIndex`**.
- A subagent that 429s flips the global `activeIndex` to whatever its strategy selects. The user, watching `/accounts`, sees a different "active" account from before — for reasons unrelated to the main thread.
- `follow-main` subagents that registered earlier keep their old `accountId` (Bug #1's mechanism) and drift out of sync with the new global "active".
- The status line refresh shows the new account; mid-flight main-thread requests keep using the old (now-not-active) account via the unchanged main lease, until main itself fails over too.

**Concurrent multi-subagent burst:**

- N subagents each 429 simultaneously.
- N independent `failoverCodexLease` calls compute `selectAccountForLease` against the live pool.
- Each reads `liveLeaseCounts` racy snapshots; they largely converge on the same lowest-count candidate.
- Each calls `setActiveAccount` in rapid succession; the **main thread's active account flips multiple times** during the burst.
- In single-process JS no torn writes — but `pool.activeIndex` is observably noisy.

**Recommended fix — two options:**

- **(Preferred) Drop the `setActiveAccount` call.** Keep `failoverCodexLease` strictly lease-local. Main-thread cap recovery has its own `switchToAccount(null)` path in `withRetry.ts` that handles the global active legitimately.
- **(Alternative) Keep the global mutation but persist it** (`persistActiveCodexAccountId`) and emit a `account.active.changed` diagnostic, plus notify the UI. This makes the existing behavior at least observable.

The first option is cleaner and matches the stated lease-isolation intent.

---

### Bug #4 — Auto-failover paths do not persist `activeCodexAccountId`

**Severity:** High. User "springs back" to the capped account on restart.

> **[CORRECTION — verification pass]**
> - `markAccountDead` **does** persist replacement state (`codexAccountPool.ts:474-484`); my original claim that it doesn't persist is stale.
> - The right invariant is **not** "persist every `setActiveAccount` call." That would entrench the bad coupling from Bug #3. The correct invariant is: **lease-local failover must not mutate global active state at all; only intentional global active changes (manual switch, main-thread cap exhaustion) should persist.** Pair Bug #3 fix (remove the `setActiveAccount` call from `failoverCodexLease`) with persistence on the legitimate main-session paths in `withRetry.ts` only.
> - Affected paths that still need attention: `failoverCodexLease` (drop the mutation entirely), `markPoolAccountStatus` re-roll via `codexUsage.ts:242-250` (decide: usage-driven active reroll should be either explicit-and-persisted, or removed).
>
> **[CONFIRMED — second verification pass]** Full mutation table verified — see §15.5.3. Six non-persistent paths total: five implicit (lazy reslot, `setActiveAccount` helper, lease self-heal, `failoverCodexLease`, `markPoolAccountStatus`, `markPoolAccountCapped`), one intentional-but-broken (`failoverCodexLease`). **Also confirmed:** simply running `/accounts` can switch the active account because `fetchPoolUsage` mutates state on cache miss (§15.5.4). Spring-back-on-restart is reproducible from source.

**Three offending paths:**

1. **`failoverCodexLease → setActiveAccount`** (`codexAccountLeaseManager.ts:281`). No `persistActiveCodexAccountId`. Affected callers: `withRetry.ts:436, :547, :634`.
2. **`markPoolAccountStatus` re-rolling `activeIndex`** (`codexAccountPool.ts:385-387`). When `fetchPoolUsage` flips an account from `healthy` → `capped` via `codexUsage.ts:249`, if that account was active, `activeIndex` shifts to LRU healthy — without persistence.
3. **`markAccountDead` rolling active** (`codexAccountPool.ts:480`). Called from token-refresh hard fail. Same lack of persistence.

**Legacy `codexOAuth` config token never updated:**

`~/.claude.json:codexOAuth` is written only by:

- Login (`saveCodexOAuthTokens` in `src/services/oauth/codex-client.ts`)
- `removeCodexAccount` (`codexAccountPool.ts:658-663`)
- `codex-core.maybeRefreshAccount` (`src/codex-core/accounts.ts:65-75` — only when matching the same profile)

None of the auto-failover paths update it. The fallbacks at `client.ts:226` (`getCodexOAuthTokens` when pool inactive), `codex-core/accounts.ts:64`, and `codex-fetch-adapter.ts:22` can point at a capped or dead account indefinitely.

**Restart behavior:**

- Process boots. `initCodexAccountPool` reads `~/.claude.json:activeCodexAccountId` and elects that account.
- If the user's last manual action was `/switch-account B`, that's persisted; user is on B. ✓
- If the user's session ended after an auto-failover from A → B (lease path), `activeCodexAccountId` still says A. User springs back to A. ✗
- The wham/usage cap on A might still be in effect → immediate auto-failover again → another lease-path mutation → still not persisted. Loop.

**Recommended fix:**

- Either persist from every code path that mutates `activeIndex` (call `persistActiveCodexAccountId` after each), or
- Pair the Bug #3 fix (drop `setActiveAccount` from lease failover) with explicit persistence on the legitimate main-session failover paths in `withRetry.ts` only.

The second is cleaner: lease failovers stay lease-local and in-memory; only `switchToAccount(null)` mutates and persists.

---

### Bug #5 — Identity-mismatch on `codex-core/accounts.maybeRefreshAccount` is silent

**Severity:** Medium. Pool keeps routing to a ghost account.

> **[CORRECTION — verification pass]** The replacement token **is** persisted — `maybeRefreshAccount` calls `saveCodexTokenToVault` at `codex-core/accounts.ts:133-146` regardless of mismatch. My original "saving the vault file" item in the fix list is unnecessary. The real missing pieces are:
> 1. Marking the old pool account dead.
> 2. Appending replacement to the **live in-memory pool** (vault write alone doesn't update `pool.accounts`).
> 3. Emitting a structured diagnostic (the `account.identity_mismatch` code doesn't exist yet).
>
> Also: the current `log.debug(...)` is not user-visible unless debug mode is on (`src/utils/debug.ts:230-253`), so today the only signal is silence.
>
> **[CONFIRMED — second verification pass]** Worse than expected: even **emitting** a structured diagnostic from this path wouldn't help in terminal mode — the diagnostic sink isn't installed in interactive TUI / bridge / dedicated-app modes (§15.5.1). Any "add `account.identity_mismatch` diagnostic" fix must be **preceded** by installing a default sink for these modes. Without that pre-requisite, Patch 3's diagnostic additions are noop for terminal users.

`src/codex-core/accounts.ts:148-153`:

```ts
if (refreshed.accountId !== account.accountId) {
  log.debug(
    `[codex-profile] identity-mismatch writer=codex-core.maybeRefreshAccount ` +
    `profile=${account.profile} before_account=${account.accountId} ` +
    `after_account=${refreshed.accountId} action=do-not-transfer-alias`,
  )
}
log.debug(
  `[codex-profile] core-refresh-done writer=codex-core.maybeRefreshAccount ` +
  `profile=${account.profile} before_account=${account.accountId} ` +
  `after_account=${refreshed.accountId} result=${sameAccount ? 'same-account' : 'changed-account'}`,
)
return refreshed
```

**Compared to the parallel path in `src/services/api/codexTokenRefresh.ts:138-178`:**

```ts
if (refreshed.accountId !== oldAccountId) {
  markPoolAccountDead(oldAccountId, ...)
  await saveCodexTokenToVault(refreshed)
  appendAccount(refreshed, { preserveCapped: true, activate: false })
  return { status: 'identity_mismatch', newAccountId: refreshed.accountId }
}
```

`codex-core/accounts.maybeRefreshAccount` **only logs**. It does not:

- Mark the old account dead in the pool.
- Append the new account.
- Save the new token to vault.
- Emit a diagnostic.

Consequence: the pool still sees the old `accountId` as healthy; `pool.activeIndex` still points at it; subsequent requests round-trip through the dead account until the next periodic `touchAll` (default 4h) catches it via the `codexTokenRefresh` path.

`vaultFilePath = undefined` set at `accounts.ts:131` also prevents recovery if `saveCodexTokenToVault` was the only persistence and it silently failed at `accounts.ts:136`.

**Recommended fix:**

- Mirror `codexTokenRefresh.ts:138-178` in `codex-core/accounts.ts`: mark dead, append, save vault.
- Add `account.identity_mismatch` to `ACCOUNT_DIAGNOSTIC_CODES` (`accountDiagnostics.ts:13-22`).
- Emit it from both paths.

---

### Bug #6 — `appendAccount` writes `expiresAt: Date.now()` → re-refresh loop

**Severity:** Medium (re-graded to High by reviewer). Wasted refresh storm; widens race windows; persists across restart via reload path.

> **[CORRECTION — verification pass]**
> - Not an infinite loop inside a single function call — it's **repeated re-refresh on every subsequent request** while the bad `expiresAt` sits in the pool entry.
> - **Restart behavior is also broken.** Vault persists only `last_refresh`; the pool reload path reconstructs `expiresAt` from it at `codexAccountPool.ts:541-548, 765-778`. If the reconstruction follows the same skew rule, post-restart accounts can immediately re-refresh too.
> - Also affects the identity-mismatch branch at `codexTokenRefresh.ts:158-170`, not just the same-account refresh.
>
> **[CONFIRMED — second verification pass]** Restart reconstructs bad expiry from `last_refresh` (`codexAccountPool.ts:765-778` assigns `expiresAt: new Date(last_refresh).getTime()`). With `TOKEN_REFRESH_SKEW_MS = 60_000`, any expiry ≤ now+60s triggers refresh. Codex-core path is hit hardest because `maybeRefreshAccount` runs per request; normal chat path is less affected (only refreshes on auth failure). Vault never stores `expiresAt` — only `last_refresh`. See §15.5.2.

`src/services/api/codexTokenRefresh.ts:210`:

```ts
appendAccount({
  ...
  expiresAt: Date.now(),  // ← wrong: should be future timestamp
  lastRefreshIso: new Date().toISOString(),
  ...
})
```

The skew check at `src/codex-core/accounts.ts:112`:

```ts
if (account.expiresAt - Date.now() > TOKEN_REFRESH_SKEW_MS) {
  return account // no refresh needed
}
// else refresh
```

Since `expiresAt === Date.now()`, `expiresAt - Date.now() === 0`, which is **not** greater than `TOKEN_REFRESH_SKEW_MS`. So `maybeRefreshAccount` re-refreshes on every subsequent request after `touchAll` writes this value.

Under steady load, every Codex request triggers a refresh:

- Wasted network calls.
- Enlarged race window for Bug #5 (more chances for an identity mismatch).
- More opportunities for the `appendAccount` write to race with `switchToAccount` or `removeCodexAccount`.

**Recommended fix:** Compute `expiresAt` from the refresh response's `expires_in` field. The vault file's `lastRefreshIso` already exists; `expiresAt` should be `Date.now() + (response.expires_in * 1000)`.

**Unverified:** I read the code path but did not trace a runtime production call to confirm the symptom. The vault file may carry the correct `expiresAt` from `saveCodexTokenToVault`; only the in-memory pool entry is wrong. Still worth fixing.

---

### Bug #7 — Identity-mismatch on auto-refresh is non-activating

**Severity:** Medium. User stares at the dead account as active.

> **[CORRECTION — verification pass]** Fix must be **gated**: only activate the replacement when the mismatched account was the active or main-thread-lease account. A background refresh of some other account in the pool should not steal focus. Snapshot `wasActive = (account === pool.accounts[pool.activeIndex])` and `wasMain = (mainLease?.accountId === account.accountId)` before `markAccountDead`; pass `activate: wasActive || wasMain` into `appendAccount`.

`src/services/api/codexTokenRefresh.ts:137-178` handles identity mismatch by:

```ts
appendAccount(refreshed, { preserveCapped: true, activate: false })
```

`appendAccount` only auto-activates if no healthy account is currently active (`codexAccountPool.ts:342-348`). Since the old account is just being marked dead, and there may be other healthy accounts, the replacement is not promoted.

User experience:

- Status line still shows the old account (now dead) as active.
- `/accounts` lists the old account as dead and the new account as healthy but not active.
- Main-thread requests hit `getActiveAccount` → lazy reslot to LRU healthy → may end up on the wrong account.

**Compare to manual login:** `ConsoleOAuthFlow.persistCodexLogin` → `appendAccount(account, { activate: true })`. Always activates.

**Recommended fix:** When the identity-mismatch path detects the old account was the active, pass `activate: true` to `appendAccount`. Emit `account.identity_mismatch` diagnostic.

---

### Bug #8 — `selectAccountForTurn` is dead code; its setting does nothing

**Severity:** Low (re-graded to Medium by reviewer — UI + schema leak the dead concept to users).

> **[CORRECTION — verification pass]**
> - Startup does **not** call `setTurnThreshold()`. It reads `getInitialSettings().codexAccountRotationThreshold` **directly** at `codexAccountPool.ts:121-125` and writes `pool.turnThreshold`. My description of the wiring was stale.
> - `setTurnThreshold` exists at `codexAccountPool.ts:416-418` but has no callers.
> - The setting is still visible in `src/utils/settings/types.ts:333-340` and is displayed in `/accounts` (`src/commands/accounts/accounts.ts:29-40, 75-80`). Deleting the function alone is **incomplete**; the cleanup must also remove the schema entry, the `pool.turnThreshold` read at init, and the `/accounts` display.
> - Alternative: actually wire `selectAccountForTurn` into the turn boundary at `src/query.ts:324-330`. The setting then becomes meaningful. Either path is fine; partial cleanup is not.

`src/services/api/codexAccountPool.ts:212` defines `selectAccountForTurn`. `grep -r 'selectAccountForTurn' src/` returns only the definition. The default `DEFAULT_TURN_THRESHOLD = Infinity`. The function would only rotate if some caller invoked it after threshold turns — no caller exists.

But `setTurnThreshold` is exported and called from settings load:

```ts
// somewhere in init
setTurnThreshold(getSettings().codexAccountRotationThreshold ?? Infinity)
```

So users can set `codexAccountRotationThreshold` in their settings and it does **nothing**.

**Recommended fix:** Delete `selectAccountForTurn`, `setTurnThreshold`, the `turnThreshold` field on the pool, and the `codexAccountRotationThreshold` settings key (and any docs that reference it). Or, if turn-rotation is wanted, wire it up at request time.

---

### Bug #9 — Misleading no-op switch (success message + side effects)

**Severity:** Low–medium.

> **[CORRECTION — verification pass]** The exact reported message form was stale. Current code:
> - Prefix-form switch returns `Switched to ${label}` (`switch-account.ts:75-77`).
> - No-arg rotate returns `Switched from ${fromLabel} to ${toLabel}` (`switch-account.ts:80-83`). Verified: `grep "Switched from" switch-account.ts` returns only line 83.
> - The no-arg path uses `findLRUHealthy(pool.activeIndex)` (`codexAccountPool.ts:995-1037`) which **excludes the current active**, so no-arg cannot literally produce "Switched from X to X".
> - The real bug: `/switch-account <current-prefix>` (explicit prefix that resolves to the already-active account) reports "Switched to X" **and still runs all the side effects** (`resetCodexCacheContext`, `clearAuthRelatedCaches`, sessionId regeneration, prompt-cache burst). Should detect the no-op via `result.accountId === captured.accountId` and return "Already on X" **before** side effects fire.

`src/commands/switch-account/switch-account.ts:75-83`:

```ts
const activeIndex = pool.activeIndex
const captured = pool.accounts[activeIndex]
// ... switchToAccount(prefix) ...
const result = ...
const toLabel = result.alias ?? result.accountId.slice(0, 12)
const fromLabel = captured?.alias ?? captured?.accountId.slice(0, 12) ?? '?'
return `Switched from ${fromLabel} to ${toLabel}`
```

`switchToAccount` returns the current account on no-op (`codexAccountPool.ts:450-455` — when `targetIdx === pool.activeIndex`). The callsite still emits a "switched" message: `"Switched from B to B"`.

The Claude branch is symmetrical but the no-op message form differs slightly.

**Recommended fix:** Detect `result.accountId === captured.accountId` and emit `"Already on B"` instead.

---

### Bug #10 — Intra-pool prefix ambiguity silently picks the first match

**Severity:** Low (re-graded to Medium-high by reviewer — silent wrong-account selection is a stronger correctness risk than I assigned).

> **[CORRECTION — verification pass]**
> - Same-pool ambiguity is confirmed in both pools.
> - **Cross-pool ambiguity detection is conditional, not universal.** It only kicks in under specific healthy-count gates at `switch-account.ts:99-129`. My claim "cross-pool ambiguity IS detected" was too broad.
> - `/rename-account` also uses first-match prefix lookup (`src/commands/rename-account/rename-account.ts:21-25, 46-51`) — same ambiguity risk on renames.
> - Load order is not sorted in either pool (`claudeAccountPool.ts:72-99`, `codexAccountPool.ts:818-840`), so "first match" is non-deterministic across runs.
> - Fix scope must include `/rename-account` and should reject ambiguous-same-specificity prefixes while keeping exact-match precedence.

`claudeAccountPool.ts:189-214` and `codexAccountPool.ts:424-444`. If two aliases share a prefix (e.g. `alice-work` and `alice-personal`), `/switch-account alice` quietly switches to the array's first match. Cross-pool ambiguity IS detected in `switch-account.ts:122-129`, but intra-pool is not.

**Recommended fix:** In each pool's prefix-matcher, count exact matches and prefix matches; if > 1 prefix match and no exact match, reject and list candidates.

---

## 5. Additional Edge Findings

These are smaller findings the deep-dives surfaced that didn't justify their own top-level bug entry but are worth recording.

### 5.1 `validateCodexAccountAlias` doesn't reject config-only accounts for rename

`/rename-account` ultimately calls `setAccountAlias` (`codexAccountPool.ts:592`), which requires `vaultFilePath`. Config-only accounts have no vault file, so the rename silently no-ops (`return false`). `validateCodexAccountAlias` doesn't pre-check this; the UI reports "renamed" while nothing happened.

**Fix:** Add a check; either reject with a clear error or migrate the account into the vault first.

### 5.2 `removeCodexAccount` can leave stale config-only ghosts

After `removeCodexAccount`, `saveCodexOAuthTokens(active)` writes the new active vault account's tokens into `codexOAuth` (`codexAccountPool.ts:658-663`). On next process boot, `loadConfigAccount` reads `codexOAuth` and merges it into the pool. `mergePoolAccounts` dedupes by accountId, so this is idempotent in the common case — but if the corresponding vault file is later removed externally (manual cleanup), the merged config entry survives as a config-only ghost the user cannot delete via `/delete-account`.

### 5.3 `pendingRefreshesByAccountId` doesn't guard vs. switch

`codexTokenRefresh.ts:47` dedupes concurrent refreshes per accountId. It does **not** synchronise with an in-progress `switchToAccount` or `removeCodexAccount`. A refresh that started before a switch can complete after, writing tokens into `pool.accounts[idx]` while another routine is reading or mutating that slot. In single-process JS the writes don't tear, but the resulting state can be surprising.

### 5.4 `releaseCodexLease` silent self-heal failure

`codexAccountLeaseManager.ts:237` — if `activeIndex < 0` when a lease is released, it calls `setActiveAccount(releasedLease.accountId)`. But `setActiveAccount` requires the target account to be `status === 'healthy'`; if all accounts are dead, the assignment silently fails. The lease release succeeds, but `activeIndex` remains `-1`. Functional, but the codepath signals confused intent.

### 5.5 `selectMainAccountForLease` vs. `pool.activeIndex` ordering

`selectMainAccountForLease` pins to `pool.activeIndex`. `/switch-account` writes `activeIndex` **before** running `reassignCodexLeaseToActiveAccount`. There's a brief window during which `getCurrentCodexLease()` returns `undefined` (the main lease hasn't been reassigned yet), but `pool.activeIndex` already moved. Any subagent registered with `'follow-main'` during that micro-window resolves to the new account via `pool.activeIndex` fallback — different ordering than `resolveMainAccountId` prefers when the main lease exists. Minor; rarely observable in single-threaded code.

### 5.6 529 retry vs. cap-failover interaction

`withRetry` increments `consecutive529Errors` toward `MAX_529_RETRIES = 3` and triggers a fallback model. This is independent of the Codex pool, but in `UNATTENDED_RETRY` mode (`withRetry.ts:921`, clamps `attempt = maxRetries`), a 529 storm interleaved with cap-failovers can cause many failovers in quick succession with no per-account cooldown gate.

### 5.7 `regenerateSessionId` post-switch may invalidate cache too aggressively

`applyPostCodexAccountSwitchRefresh` calls `regenerateSessionId`. Since `conversation-id` derives from session ID and prompt-cache key derives from account+conversation, regenerating session ID on a Claude switch (the function is called even for Claude switches — see Bug 5.8) bursts the Anthropic prompt cache unnecessarily. Possibly intentional, but worth confirming with the cache-investigation memo (see [memory: project_codex_cache_investigation.md]).

### 5.8 `applyPostCodexAccountSwitchRefresh` is misnamed

`src/commands/switch-account/switch-account.ts:20` — the function is called for Claude switches too. The behavior (regenerate sessionId, reset cost, reset user cache) is in fact correct for both providers, but the name implies Codex-only. Smell, not bug.

### 5.9 `getAPIProvider() !== 'firstParty'` overbroad

`src/commands/switch-account/switch-account.ts:147, 155`. Anything not `'firstParty'` is treated as Codex provider, including `bedrock`, `vertex`, `foundry`. No-arg `/switch-account` on Bedrock would attempt to rotate the Codex pool. Edge case; these providers don't typically coexist with Codex pools, but the check should be `provider === 'openai'`.

### 5.10 In-flight request behavior during auto-failover

When 429 fires mid-flight in `withRetry`:

- `client = null; continue` resets the loop.
- Next iteration calls `getAnthropicClient()` again, which constructs a new `createCodexFetch(accessToken)`.
- **But:** the per-request lease lookup inside `createCodexFetch` re-derives `currentToken` and `currentAccountId` from `getCurrentCodexLease()` every call (`codex-fetch-adapter.ts:2503-2507`). So even if the closed-over `accessToken` is stale, the lease's live token wins.
- The same logical request body is re-serialized. `chatgpt-account-id`, `conversation-id`, `prompt_cache_key` all rebuilt per request → correctly swapped.
- **Prompt cache burst:** `conversation-id` is per-account (`codexAccountPool.ts:62-64`), so failover ⇒ cold cache turn on the new account. Confirmed by the comment at that location.

### 5.11 `appendClaudeAccount` (Claude side) implicit-active without sync — see §13.

---

## 6. Auto-Switch Trigger Catalog

For each implicit account-change trigger, current state:

| # | Trigger | Detection site | Switch site | Scope | Persists `activeCodexAccountId`? | Updates legacy `codexOAuth`? | Diagnostic? | UI notify? |
|---|---|---|---|---|---|---|---|---|
| 1 | 429 cap (HTTP) | `codex-fetch-adapter.ts:2725, :2642` → `CodexAccountCapError` | `withRetry.ts:417` → `failoverCodexLease` OR `switchToAccount(null)` | lease + active (lease branch calls `setActiveAccount`; main branch calls `switchToAccount`) | only main branch (line 271, 469); **lease branch NO** | **No** | `account.failover.succeeded` | `onCodexAccountSwitch → reverify()` (token only — does NOT re-render AccountsPanel) |
| 2 | 429 cap (WS) | `codex-fetch-adapter.ts:2305, :2421` | same as #1 | same | same | No | same | same |
| 3 | 401/403 auth | `codex-fetch-adapter.ts:2645, :2728` → `CodexAccountAuthError` | `withRetry.ts:490` — in-place refresh; on fail mark `dead`, `failoverCodexLease({markAccountCapped:false})` or `switchToAccount(null)` | same | same | No | `account.token_refresh.failed` + `account.failover.succeeded` | same |
| 4 | Connection error (≥ attempt 2) | `withRetry.ts:599` | `failoverCodexLease({markAccountCapped:false})` or `switchToAccount(null)` | same | lease NO; main YES | No | `account.transient_failure` + `account.failover.succeeded` | same |
| 5 | Pre-flight lease selection | `registerCodexLease` → `selectAccountForLease` | sets lease's `accountId`; **also calls `setActiveAccount`** for the picked account | lease + active | No | No | none on register; failover emits | none on register |
| 6 | Identity-mismatch on refresh (codexTokenRefresh) | `codexTokenRefresh.ts:137` | mark old dead, append new (`activate:false`) | adds entry; activeIndex rarely changes | rarely | No | **none** (only debug log) | **none** |
| 7 | Identity-mismatch on refresh (codex-core) | `codex-core/accounts.ts:148` | **nothing** (logs only) | none | No | No | **none** | **none** |
| 8 | Periodic `touchAll` | `codexTokenRefresh.ts:317` | refresh; on hard fail → `markAccountDead` may shift `activeIndex` | active (on dead-shift) | yes (via `markPoolAccountStatus`? **needs verification**) | No | **none** | **none** |
| 9 | `fetchPoolUsage` cap signal | `codexUsage.ts:243` (`!allowed \|\| limitReached`) | `markPoolAccountCapped` → if it's active, `markPoolAccountStatus` reshuffles `activeIndex` via `findLRUHealthy` | active | **No** — does NOT call `persistActiveCodexAccountId` | No | **none** | **none** |
| 10 | Vault plan-type expiry on init | `codexAccountPool.ts:768` (`getVaultPlanHealthFromIdToken`) | accounts loaded as `capped` if `chatgpt_plan_type=free` or subscription expired | active selection on init | — (chosen at init) | No | **none** | **none** |
| 11 | `getActiveAccount` lazy reslot | called on every Codex request | if `activeIndex` points at non-healthy, silently picks LRU healthy and mutates `pool.activeIndex` | active | **No** — purely in-memory | No | **none** | **none** |

**Loud triggers:** cap failover (429/auth/connection) and `auth.missing` / `quota.exhausted` exhaustion.
**Silent triggers:** 7 of 11.

**Single biggest correctness risk in this surface:** Combination of Bug #3 (lease failover mutates global) + Bug #4 (no persistence). Produces the canonical "why did my account change, and why did it spring back?" user complaint.

---

## 7. Persistence Consistency Matrix

For each Codex state surface, which switch paths update it?

| Switch path | Pool `activeIndex` (memory) | Lease map (memory) | Vault file (disk) | `activeCodexAccountId` (config) | `codexOAuth` (config) |
|---|---|---|---|---|---|
| `/switch-account` | ✓ | only `main-thread` | — | ✓ | ✗ (Bug #4) |
| `/delete-account` | ✓ (if active deleted) | only `main-thread` | vault file deleted | ✓ | ✓ (writes new active's tokens) |
| `/rename-account` | — | — | ✓ | — | — |
| Login (new Codex account) | ✓ | — | ✓ | ✓ | ✓ |
| `failoverCodexLease` (lease 429) | ✓ (silently, Bug #3) | the failing lease | — | **✗** (Bug #4) | **✗** |
| `switchToAccount(null)` (main 429) | ✓ | only via subsequent reassign | — | ✓ | **✗** |
| `markPoolAccountStatus → re-roll` (usage hint) | ✓ | — | — | **✗** | **✗** |
| `markAccountDead → re-roll` | ✓ | — | — | **✗** | **✗** |
| `getActiveAccount` lazy reslot | ✓ | — | — | **✗** | **✗** |
| `appendAccount` from identity-mismatch | sometimes (only if no healthy active) | — | ✓ | sometimes | ✗ |
| `codex-core.maybeRefreshAccount` identity-mismatch | — | — | possibly | — | possibly |
| `touchAll` periodic refresh | — | — | ✓ | — | — |

The most-stale layer is `codexOAuth` — only login and `removeCodexAccount` ever write it.

---

## 8. User-Visible vs. Actual State Matrix

What the user sees vs. what's actually true, after various events.

| Event | What `/accounts` shows | What status line shows | What banner / LogoV2 shows | What requests actually use |
|---|---|---|---|---|
| `/switch-account B` (fresh start, no subagents) | B ✓ | B ✓ (next render) | **A** (Bug #2) until restart | B (main); B (any subagent registered after switch) |
| `/switch-account B` with running async subagent on A | B ✓ | B ✓ | **A** (Bug #2) | B (main); **A** (Bug #1, subagent still pinned) |
| Main 429 → `switchToAccount(null)` | new active C ✓ | C ✓ (next render) | **A** (Bug #2) | C (main); subagents per their leases |
| Subagent 429 → `failoverCodexLease` | new C ✓ (Bug #3 mutates global) | C ✓ | **A** (Bug #2) | C (failed-over subagent); **A** (main lease still pinned until its own failover) |
| `fetchPoolUsage` flips A to capped, reshuffles to C | C ✓ | A still ✓ until next render | **A** (Bug #2) | C (next request) |
| Restart after lease-path failover (last session: lease moved A→C) | A (from config) | A | A | A — but A is still capped → immediate failover loop |
| `touchAll` identity-mismatch on A → new A' | A still listed; A' added | A still | A still | A (broken — A is dead, A' inert; Bug #5/#7) |
| `codex-core.maybeRefreshAccount` identity-mismatch | A | A | A | Inconsistent: refresh path returns A' token; pool still thinks A active |

The truth surface (request routing) is the lease map. The display surfaces (`/accounts`, banner) lag, are stale, or are wrong.

---

## 9. Diagnostic Coverage Audit

### 9.1 Defined codes (`accountDiagnostics.ts:13-22`)

- `account.route.selected`
- `account.failover.succeeded`
- `account.transient_failure`
- `account.token_refresh.failed`
- `account.pool.unavailable`
- `quota.exhausted`
- `auth.missing`
- `model.provider_mismatch`

SDK schema (`src/entrypoints/sdk/coreSchemas.ts:1565`) matches emitter shape. Required fields: `type: "system"`, `subtype: "cat_code_account_diagnostic"`, `version: 1`, `code`, `severity`, `provider`, `recoverable`. Downstream remediation can key off those alone.

### 9.2 Sanitization

`buildAccountDiagnosticBody` (`accountDiagnostics.ts:314-340`):

- Every string field (pool, requested_model, resolved_model, reason, user_message) → `sanitizeText`.
- `account_ref` → `stableRedaction('account-ref', …)` (hashed, per-account stable).
- Patterns: emails, UUIDs, JWTs, `sk-…` API keys, JSON-shaped `email`, `account_id`, `alias`, `access_token`, `refresh_token`, `id_token`, `api_key`, `authorization`.
- Verified: no plaintext leaks of aliases, emails, account IDs, tokens.

### 9.3 Missing emits (silent triggers)

- `/switch-account` user-initiated switch — no event on start, success, failure, or ambiguous match.
- Identity-mismatch in `codexTokenRefresh.ts` and in `codex-core/accounts.ts`.
- `rotateOnFailure`, `selectAccountForTurn` (dead anyway).
- `markPoolAccountStatus` shifting `activeIndex` via usage hint.
- `markAccountDead` rolling active.
- `fetchPoolUsage` auto-capping.
- `getActiveAccount` lazy reslot.
- `registerCodexLease` selection (only failover emits).

### 9.4 Missing codes

- `account.identity_mismatch` — not defined; identity-mismatch failures currently surface only as the downstream `account.token_refresh.failed`, losing root cause.
- `account.switch.{started, succeeded, failed}` — user-initiated switches are invisible to consumers.
- `account.active.changed` — would be useful if Bug #3's "lease failover mutates global active" is intentionally kept.

---

## 10. Recursion / Loop Risk

- `withRetry` is capped at `getMaxRetries() + 1` (default 6).
- Each cap-failover hits `continue` without incrementing the loop counter manually — so **a cap-failover consumes one attempt**. With 10 accounts and constant 429s you fail over up to 5 times before `CannotRetryError`.
- `CodexAccountAuthError` first tries `refreshAccountTokens`; if refresh succeeds, `continue`. If the refreshed token then 429s, it's a different error type; no recursion.
- 529 path increments `consecutive529Errors` toward `MAX_529_RETRIES = 3` and triggers fallback model — independent of the Codex pool.

**Real risk — `UNATTENDED_RETRY`:**

`withRetry.ts:921` clamps `attempt = maxRetries` so the for-loop never terminates on 429/529. Combined with cap-failover that does its own `continue`, a perpetual-429 scenario across all accounts could **loop forever**: each attempt does a fresh failover, succeeds momentarily, 429s again. There is no per-account cooldown gate in this path.

**Recommended fix:** Per-account error cooldown (`process.env.CODEX_POOL_ERROR_COOLDOWN_MS` exists but is only used in selection ranking, not as a retry gate). Or a global watchdog that bails after N total failovers in a window.

---

## 11. Suggested Test Cases

### Bug #1 — Subagent lease invalidation

- **Unit:** Mock pool with accounts {A, B}, register main lease (A) and one subagent lease (A, follow-main). Call `reassignCodexLeaseToActiveAccount` after switching active to B. Assert: in current code, only main lease's `accountId` updates. After fix: both update.
- **Unit:** Same setup with subagent strategy `'spread'`. After fix, subagent lease stays on A.
- **Integration:** Spawn async subagent → /switch-account → trigger subagent tool call → assert outbound request used new account's token (mock the fetch adapter).

### Bug #2 — UI re-render

- **Component test:** Render `<Messages>` with a fixture pool. Bump `authVersion`. Assert `<LogoHeader>` re-renders with new pool data.
- **Integration:** Drive `/switch-account` in a test REPL; assert `AccountsPanel` content (active bullet) updates without restart.

### Bug #3 — Lease failover global mutation

- **Unit:** Register two leases (main, subagent). Trigger `failoverCodexLease(subagent.ownerId)`. After fix: `pool.activeIndex` unchanged; subagent lease's `accountId` changed.

### Bug #4 — Persistence

- **Integration:** Force a lease-path failover; restart pool (re-`initCodexAccountPool`); assert `activeIndex` reflects the post-failover account, not the pre-failover one. (Requires Bug #4 fix.)

### Bug #5 + #7 — Identity-mismatch coverage

- **Unit:** Mock `refreshAccessToken` to return a different `accountId`. Run `codex-core.maybeRefreshAccount`. Assert: old account marked dead, new account appended, diagnostic emitted.
- **Same for `codexTokenRefresh.touchAll`.** Assert `activate: true` when the old account was active.

### Bug #6 — `expiresAt`

- **Unit:** Refresh an account; check `pool.accounts[idx].expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS`.

### Recursion

- **Stress test:** Configure 3 accounts, all returning 429. Trigger an unattended-retry session. Assert it bails after a bounded number of failovers, not infinite.

---

## 12. Combined Fix Priority

| # | Fix | Files | Effort | Impact | Risk |
|---|---|---|---|---|---|
| 1 | Add bulk reassign helper; iterate all leases on switch + delete (Option A) | `codexAccountLeaseManager.ts`, `switch-account.ts`, `delete-account.ts` | M | High — fixes silent wrong-account routing (Bug #1) | Low — additive |
| 2 | Drop `setActiveAccount` from `failoverCodexLease` | `codexAccountLeaseManager.ts` | S | High — fixes subagent-hijacks-main (Bug #3) | Low — restores stated invariant |
| 3 | Key `LogoHeader` on `authVersion` | `src/components/Messages.tsx` (one line) | XS | High — UI tells the truth (Bug #2) | Low — bounded re-render |
| 4 | Persist `activeCodexAccountId` from `markPoolAccountStatus` rolls and main-path failover | `codexAccountPool.ts`, `withRetry.ts` | S | Medium — fixes spring-back (Bug #4) | Low |
| 5 | Mirror identity-mismatch handling in `codex-core/accounts.ts`; emit diagnostic; activate replacement | `codex-core/accounts.ts`, `codexTokenRefresh.ts`, `accountDiagnostics.ts` | S | Medium (Bugs #5, #7) | Low |
| 6 | Fix `appendAccount` `expiresAt` to future timestamp | `codexTokenRefresh.ts` | XS | Medium (Bug #6) | Low |
| 7 | Inspect 429/403 body before classifying as cap/revoke | `withRetry.ts`, `codex-fetch-adapter.ts` | M | Medium — fewer false-positive caps | Medium — error-classification changes |
| 8 | Detect prefix ambiguity within a pool | `claudeAccountPool.ts`, `codexAccountPool.ts` | S | Low (Bug #10) | Low |
| 9 | Detect no-op switch and emit "Already on X" | `switch-account.ts` | XS | Low (Bug #9) | None |
| 10 | Delete `selectAccountForTurn` + unused setting | `codexAccountPool.ts`, settings types | XS | None — housekeeping (Bug #8) | None |
| 11 | Add identity-mismatch + switch.* diagnostic codes | `accountDiagnostics.ts`, SDK schema | S | Medium — observability | Low |
| 12 | Per-account error cooldown in unattended-retry loop | `withRetry.ts` | M | Medium — bounds the worst case | Medium |

**Suggested patch sequence:**

1. **#3 alone** — one-line patch, immediate UX win, surfaces the other bugs visibly (now the user can see the consequences of #1 and #4).
2. **#1 + #2 + #4** together — coherent lease-invariant + persistence change; one commit.
3. **#5 + #7 + #11** together — identity-mismatch hardening, parallel paths converged, diagnostic added.
4. **#6, #8, #9, #10** — small wins, can land independently.
5. **#7 (error-classification) + #12** — broader retry/error work, scope it carefully.

---

## 13. Claude-Pool Findings (Secondary Scope)

The user de-scoped Claude from the deep-dives, but the breadth audit found real issues:

### 13.1 Token refresh vs. account switch race

`src/utils/auth.ts:1626-1638`. Between `refreshOAuthToken(lockedTokens.refreshToken)` (line 1626) and `updateActiveClaudeAccountTokens(refreshedTokens)` (line 1638), the active account can change. `updateActiveClaudeAccountTokens` writes to `pool.accounts[pool.activeIndex]` blindly — so a refresh for account A can overwrite B's vault file with A's tokens. Lock is on the config dir (per `getClaudeConfigHomeDir()`), not per-account.

**Fix:** Per-account refresh lock, or capture `accountUuid` at refresh start and verify before write.

### 13.2 Single-account `/logout` leaves a dangling pointer

`src/commands/logout/logout.tsx:34-52` + `src/services/api/claudeAccountPool.ts:103`. `performLogout` clears `oauthAccount` and wipes the keychain but does NOT clear `activeClaudeAccountUuid`, and the vault directory `~/claude-vault/accounts/` is never touched. On next launch, `initClaudeAccountPool` re-loads the account from vault and re-elects it active. User effectively "un-logs-out" silently.

**Fix:** On single-account logout, also clear `activeClaudeAccountUuid` and delete the vault file (or move to `~/claude-vault/trash/`).

### 13.3 Refresh write order — keychain before vault

`auth.ts:1634 → 1638`. `saveOAuthTokensIfNeeded` writes the keychain first, then `updateActiveClaudeAccountTokens` writes the vault. If the process crashes between, the keychain is fresh but the vault file is stale; `loadVaultAccounts` then serves outdated tokens until next refresh.

**Fix:** Write vault first, then keychain. The keychain is the shadow surface when the pool is active.

### 13.4 `syncClaudeAccountToStorage` is not atomic

`claudeAccountPool.ts:362-401`. Keychain `update` then `saveGlobalConfig`. A crash between produces a keychain whose tokens belong to account X paired with `config.oauthAccount` describing account Y. `loadConfigAccount` (line 616) then surfaces a fabricated "account" mixing X's tokens with Y's profile/UUID into the pool migration step.

**Fix:** Either order to make crashes recoverable (vault then keychain then config), or add a transaction marker that lets the next boot detect torn writes.

### 13.5 `failoverClaudeAccount` doesn't sync keychain

`claudeAccountPool.ts:257`. After an internal Claude failover, the keychain still holds the dead account's tokens. Any code path that bypasses the pool and reads keychain directly (legacy `secureStorage.read()` callers) will get the wrong account.

**Fix:** Call `syncClaudeAccountToStorage` after failover.

### 13.6 Multi-account shadowing rules

`shouldUseClaudePoolTokenSource` requires `accounts.length > 1`. Single-account pools fall back to the keychain. Token reads stay consistent, but invariants like "active pool account = keychain contents" depend entirely on `syncClaudeAccountToStorage` being called everywhere a switch happens. Inconsistencies surface when the pool's active account drifts from the keychain (Bugs 13.1, 13.3, 13.4, 13.5 all contribute).

### 13.7 `loadConfigAccount` phantom account

`claudeAccountPool.ts:616`. On migration, blindly pairs keychain tokens with `config.oauthAccount` profile. Divergence here (after any partial write above) produces a phantom account in the migration step.

### 13.8 `appendClaudeAccount` implicit-active

`claudeAccountPool.ts:285`. Implicitly sets the new account as active without going through `switchToClaudeAccount`. Calls `syncClaudeAccountToStorage` at the end (line 349). The login caller must invoke `clearAuthRelatedCaches` — verify all login flows do.

### 13.9 `pendingRefreshCheck` / `pending401Handlers` across switches

`auth.ts:1422, 1520`. In-process maps not cleared on switch. A 401 handler for account A in-flight could resolve against account B's tokens after a switch. Unverified whether observable — depends on call-site coupling.

---

## 14. Unverified Claims / Open Questions

> Several items resolved by the second verification pass (§15.5). Strikethrough = resolved; arrow points to the resolution.

- ~~Whether `bun run build:dev:full` regenerates compiled `Messages.tsx` from source~~ → **§15.5.5 Resolved.** `Messages.tsx` is source-of-truth; direct edit survives the build.
- Whether the dedicated-app surface (`src/app-runtime/`, `src/dedicated-app/`) has its own switch-account path bypassing the TUI command.
- ~~Whether Bug #6's symptom (re-refresh loop) is observable at runtime~~ → **§15.5.2 Resolved.** Yes for codex-core path; less for chat path. Restart reconstructs bad expiry from `last_refresh`.
- ~~Whether `getActiveAccount` lazy reslot (`codexAccountPool.ts`) actually fires in production~~ → **§15.5.3 / §15.5.4 Resolved.** Real, unpersisted, fires whenever current active is missing/unhealthy.
- Whether `codex-fetch-adapter.ts`'s WebSocket transport re-derives the auth token per reconnect or holds the original closure.
- Concurrent multi-subagent 429 burst — reasoned from code; no test exercises N concurrent `failoverCodexLease` calls.
- Whether `regenerateSessionId()` inside `applyPostCodexAccountSwitchRefresh` invalidates the prompt cache on the new account aggressively enough to matter (possibly intentional, cross-ref with the cache-investigation memo in memory).
- Whether `pendingRefreshCheck` / `pending401Handlers` carrying over across switches produces observable wrong-account writes (Claude side, §13.9).
- Whether `process.env.CODEX_POOL_ERROR_COOLDOWN_MS` is documented anywhere user-facing.
- Whether `LogoV2.test.tsx` (currently untracked) was about to be committed or is staging in-progress work — likely the latter given the modified-files list.

---

## 15. Verification Pass — Corrections & Refinements

> **Second verification pass (added 2026-05-20):** Five targeted investigations confirmed the open questions raised by the first verification pass. Results folded into §15.5 below; affected §4 bug entries got a second `[CONFIRMED]` block where claims are now hard-verified.

An independent read-only review pass was run after the initial report. It re-checked each top bug against current source. No bugs were disproved; eight had stale details or overstated impact that have been corrected in §4 inline.

### 15.1 Summary verdict per bug

| Bug | Confirmed? | Severity after review | Priority | Main files to touch |
|---|---|---|---|---|
| #1 Subagent leases stale after switch | **Confirmed** | High | P1 | `switch-account.ts`, `codexAccountLeaseManager.ts` |
| #2 LogoV2 / AccountsPanel stale | Partially confirmed | Medium-high | P1 | `Messages.tsx`, `LogoV2.tsx`, `AccountsPanel.tsx` |
| #3 `failoverCodexLease` mutates global active | Partially confirmed | High | P2 | `codexAccountLeaseManager.ts`, `withRetry.ts`, `codexAccountPool.ts` |
| #4 Auto-failover persistence drift | Partially confirmed | High | P2 | `codexAccountLeaseManager.ts`, `codexAccountPool.ts`, `withRetry.ts`, `codexUsage.ts` |
| #5 codex-core identity-mismatch silent | Partially confirmed | Medium-high | P3 | `codex-core/accounts.ts`, `accountDiagnostics.ts`, `codexAccountPool.ts` |
| #6 `expiresAt: Date.now()` re-refresh loop | Partially confirmed | High | P3 | `codexTokenRefresh.ts`, `codexAccountPool.ts`, `codex-core/accounts.ts` |
| #7 Identity-mismatch non-activating | Partially confirmed | Medium-high | P3 | `codexTokenRefresh.ts`, `codexAccountPool.ts`, `codexAccountLeaseManager.ts` |
| #8 `selectAccountForTurn` dead code | Partially confirmed | Medium | P4 | `codexAccountPool.ts`, `query.ts`, `settings/types.ts`, `commands/accounts/accounts.ts` |
| #9 No-op switch success + side effects | Partially confirmed | Low-medium | P4 | `switch-account.ts` |
| #10 Prefix ambiguity silent pick | Partially confirmed | Medium-high | P4 | `codexAccountPool.ts`, `claudeAccountPool.ts`, `switch-account.ts`, `rename-account.ts` |

"Partially confirmed" means the underlying bug exists but original phrasing was inaccurate in one or more details (stale code references, overstated impact, missing scope). See inline `[CORRECTION]` blocks in §4 for specifics.

### 15.2 New finding from review — diagnostic sink wiring

`emitAccountDiagnostic` (`accountDiagnostics.ts:365-381`) **drops events unless a sink is installed** or stderr fallback is explicitly requested. The review could not find production sink installation. **If this is correct, every diagnostic listed in §9 may already be silently dropped in normal runtime, regardless of whether the emitter is called.** This needs verification before any "add diagnostic X" fix is judged sufficient.

### 15.3 New finding from review — `GenerateImageTool` is lease-unaware

`src/tools/GenerateImageTool/GenerateImageTool.ts:520-529` uses `getActiveAccount()` / `getCodexOAuthTokens()` rather than going through the lease layer. When `pool.activeIndex` diverges from chat leases (every scenario discussed above), this tool sends image-generation requests against `pool.activeIndex` while concurrent chat requests use lease accounts. Worth deciding intentionally: lease-aware or globally-active by design?

### 15.4 Reviewer's corrected impact framing for Bug #3

The "subagent hijacks main-thread routing" framing was overstated. Routing actually prefers leases:

- Main-thread request routing reads its own lease first (`client.ts:221-247`).
- StatusLine resolves from the main lease (`StatusLine.tsx:130-146`).
- `resolveMainAccountId` ordering in `codexAccountLeaseManager.ts:427-445` favors the main lease over `pool.activeIndex`.

So Bug #3's real impact is **pool-level + display-level drift**: `/accounts` shows the new account; `AccountsPanel` shows the new account (once Bug #2 is fixed); but the main thread keeps using its own lease until its own failover. This still matters — it confuses users, makes UI and routing disagree, and feeds Bug #4's "spring-back" problem — but it's not the "main-thread takeover" I claimed.

---

### 15.5 Second verification pass — hard-verified findings

#### 15.5.1 Diagnostic sink wiring — CONFIRMED DROPPED in most modes

Per-mode verdict from source inspection (no runtime):

| Mode | Sink installed? | Where events go |
|---|---|---|
| **Terminal / interactive TUI** | **No** | Dropped silently. `init()` (`src/entrypoints/init.ts:86-97`) installs no sink; `launchRepl()` (`src/main.tsx:3916-3924`) installs no sink. Production emitters in `client.ts:158-211` and `withRetry.ts:107-132` call without `allowStderrFallback`. **No `CAT_CODE_DIAGNOSTIC` lines reach the user.** |
| **SDK / `--print --output-format=stream-json`** | Yes | `runHeadless()` installs the hook only when `outputFormat === 'stream-json'` (`src/cli/print.ts:597-603`), writes via `structuredIO.write()` (`src/cli/structuredIO.ts:465-467`). `--sdk-url` auto-enables (`src/main.tsx:1342-1358`). Reaches observers as NDJSON system messages. |
| **Bridge / remote-control from REPL** | **No** for local diagnostics | `initReplBridge()` (`src/bridge/initReplBridge.ts:490-544`) installs no account diagnostic hook. Bridge only forwards eligible REPL `Message[]` (`bridgeMessaging.ts:72-88` allows user/assistant/local-command only). A direct-connect client forwards SDK messages it receives (`directConnectManager.ts:102-112`), but nothing is emitted into that stream locally. |
| **Dedicated app** | **No** | `createQueryEngineAppSession()` (`src/app-runtime/createQueryEngineAppSession.ts:21-52`) installs no hook. `AppSessionController.submit()` only emits messages yielded by its adapter (`AppSessionController.ts:143-156`). Global diagnostics never enter app events. |

**Test evidence:** `accountDiagnostics.test.ts:240-254` confirms no-sink emission writes nothing; `:256-270` confirms fallback is opt-in only; `accountRecoveryDiagnostics.test.ts:119-125` manually installs a sink in `beforeEach`. The behavior is by-design — tests assert it.

**Implication for Patch 3:** Adding `account.identity_mismatch` is **noop** for terminal users without first installing a default sink. Smallest patches per mode:

- Terminal: install a sink during interactive startup. Prefer debug log / UI event over raw stderr (raw stderr would pollute terminal output).
- Bridge: install a sink after `initBridgeCore()` returns and forward via `handle.writeSdkMessages([message])`.
- Dedicated app: install a per-turn sink in `AppSessionController.submit()` that emits `createMessageEvent(message)`.

#### 15.5.2 Bug #6 restart behavior — CONFIRMED bad on reload

- **In-memory bug confirmed** at `codexTokenRefresh.ts:205-216` (same-account refresh) and `:158-170` (identity-mismatch). `appendAccount` copies the bad value at `codexAccountPool.ts:303-311`.
- **NOT persisted as `expiresAt` directly.** `saveCodexTokenToVault` writes only `access_token`, `refresh_token`, `account_id`, optional `id_token`, and `last_refresh = new Date().toISOString()` (`codexAccountPool.ts:541-548`). No `expiresAt` field on disk.
- **Reload is what's broken.** `loadVaultAccounts` reads `data.last_refresh` (`codexAccountPool.ts:765-767`) and assigns `expiresAt: lastRefresh ? new Date(lastRefresh).getTime() : 0` (`codexAccountPool.ts:773-778`). So in-memory `expiresAt` becomes **"time of last refresh"**, not "token expiry".
- `TOKEN_REFRESH_SKEW_MS = 60_000` (`codex-core/accounts.ts:23`). Check at `:112-114` returns "no refresh needed" only when `expiresAt - Date.now() > 60_000`. Any `expiresAt <= now + 60s` — including `Date.now()`, `last_refresh`, or `0` — triggers a refresh.
- **Frequency:** for `codex-core` profile-based requests, every request after a refresh or restart can re-refresh. Startup `initAccountPool` calls `touchAll()` for vault accounts (`codexAccountPool.ts:135-143`), but the refresh overwrites memory with the same bad `Date.now()` — does not repair the symptom.
- **Normal Codex chat is less affected** because `client.ts:339-361` and `:516-537` pass the access token to `createCodexFetch` without checking `expiresAt`; refresh only happens on auth failure (`withRetry.ts:490-518`). So the bug bites the codex-core path harder than the chat path.

#### 15.5.3 `pool.activeIndex` mutation table — full enumeration (Bug #4)

Verified by direct file inspection:

| Mutation path | Persists? | Classification |
|---|---|---|
| `initAccountPool()` (`codexAccountPool.ts:111-119`) | reads persisted config | Boot init |
| `getActiveAccount()` lazy reslot (`:181-191`) | **No** | Implicit lazy reslot |
| `setActiveAccount()` (`:195-205`) | **No** | Helper; call-site dependent |
| `releaseCodexLease()` self-heal (`codexAccountLeaseManager.ts:233-239`) | **No** | Lease cleanup |
| `failoverCodexLease() → setActiveAccount` (`codexAccountLeaseManager.ts:259-282`) | **No** | Intentional but non-persistent |
| `selectAccountForTurn()` (`codexAccountPool.ts:212-245`) | Yes (`:231, :241`) | Intentional turn rotation (but dead code — see Bug #8) |
| `rotateOnFailure()` (`:251-283`) | Yes (`:271`) | Intentional main failover |
| `appendAccount()` activates (`:337-350`) | Yes (`:350`) | Login/update |
| `markPoolAccountStatus()` when active marked non-healthy (`:374-388`) | **No** | Implicit (usage polling) |
| `markPoolAccountCapped()` (`:390-397`) | **No** | Implicit cap marking |
| `switchToAccount()` (`:424-470`) | Yes (`:469`) | User-initiated |
| `markAccountDead()` (`:473-484`) | Yes (`:483`) | Token refresh failure |
| `removeCodexAccount()` (`:617-668`) | Yes (`:640, :664, :667`) | User-initiated deletion |

**Six non-persistent mutation paths.** Five are implicit (no user intent); one (`failoverCodexLease`) is intentional-but-broken.

#### 15.5.4 `/accounts` can switch accounts as a side effect — CONFIRMED

- `/accounts` command awaits `fetchPoolUsage()` (`src/commands/accounts/accounts.ts:34-35`).
- `fetchPoolUsage()` marks exhausted accounts capped (`codexUsage.ts:242-247`); if that account is active, `markPoolAccountStatus()` rerolls `pool.activeIndex` without persistence (`codexAccountPool.ts:385-387`).
- Cache miss only — cached snapshots return before mutation (`codexUsage.ts:203-208`).
- **`AccountsPanel` can also switch**, but in `useEffect` after mount (`AccountsPanel.tsx:311-318`) — not during pure render. Same pattern in `src/components/Settings/Usage.tsx:386-390`.
- **`getActiveAccount()` lazy reslot is real and unpersisted.** Fires whenever a caller asks for active in a bad-current state.
- **Spring-back on restart confirmed in source.** After a non-persisted mutation, `initAccountPool()` rereads `getGlobalConfig().activeCodexAccountId` and elects that — ignoring the in-memory move.

**Product implication (gates Bug #4 fix):** "opening /accounts switches accounts" is a hard-confirmed unintended side effect. This makes question §16.3.2 (usage polling: observational or mutating?) urgent.

#### 15.5.5 Bug #2 build pipeline — CONFIRMED safe to edit source directly

- `bun run build:dev:full` = `lint && bun run ./scripts/build.ts --dev --feature-set=dev-full && ./cli-dev --version` (`package.json:18`).
- `scripts/build.ts:158-187` runs `bun build ./src/entrypoints/cli.tsx --compile ... --outfile ./cli-dev`. Bundles **from** `src/`; does not rewrite `Messages.tsx`.
- No `babel.config.*`. Only `web/vite.config.ts` for `@vitejs/plugin-react` (web only).
- No `babel-plugin-react-compiler` or `react-compiler-runtime` in any config. The committed compiler-output shape is normal across many TSX files in this snapshot.
- No `Messages.source.tsx` / `.original.tsx` / similar pre-compilation source.
- Git history for `Messages.tsx` shows manual source-level edits in compiled-shape code (e.g. adding `key={conversationId}`), not recompiled output churn.

**Conclusion:** `src/components/Messages.tsx` **is** the source of truth. Direct edit at line 679 will survive the build. Patch 1 path is clear.

#### 15.5.6 `GenerateImageTool` is genuinely lease-unaware — CONFIRMED

- Request path (`src/tools/GenerateImageTool/GenerateImageTool.ts:512-545`): uses `getActiveAccount()` when pool is active, falls back to `getCodexOAuthTokens()`. **Does not consult the lease layer.**
- Tool is globally registered (`src/tools.ts:217-233`).
- **Async/background subagents cannot use it** — `ASYNC_AGENT_ALLOWED_TOOLS` omits it (`src/constants/tools.ts:69-104`).
- **Foreground/sync wildcard subagents CAN get it** via `resolveAgentTools()` (`src/tools/AgentTool/agentToolUtils.ts:175-185`).

**User-visible effect** when a sync subagent's lease ≠ `pool.activeIndex`:
- Image request billed/routed to the wrong account.
- Fails if the active account is capped/dead while the leased one is healthy.
- Failover and diagnostics will not be lease-local for image generation.

**Other call sites checked (read-only sweep, all classified):**

| Site | Verdict |
|---|---|
| `src/tools/GenerateImageTool/GenerateImageTool.ts:512-545` | **Accidental** — request path bypasses leases. |
| `src/services/api/withRetry.ts:605-662` | Intentional — uses lease first, falls back to active only when no lease exists. |
| `src/codex-core/accounts.ts:64-73` | Intentional — standalone Codex core with explicit profile, no lease-owner model. |
| `src/services/api/codexAccountPool.ts:803-815` | Intentional — bootstrap from legacy config token. |
| `src/utils/auth.ts:1678-1690` (`hasCodexTokens`) | Intentional — status/login check, not request routing. |
| `src/utils/auth.ts:1995-2008` (`getAccountInformation`) | Display/summary only. Possibly stale for pooled Codex — not a request bug. |
| `src/services/api/codex-fetch-adapter.ts:2461-2507` | Not a bypass — re-derives via `getCurrentCodexLease()` when a lease exists. |
| `src/services/api/client.ts:221-261` | Intended lease bridge, not bypass. |

**Recommendation:** Make lease-aware resolution universal for actual Codex request-time auth (image generation included). Keep exceptions only for bootstrap / explicit-profile commands / login-status surfaces / unleased fallback.

---

## 16. Revised Patch Plan & Open Product Questions

The original §12 patch table stands, but the reviewer's pass surfaced a cleaner sequencing and four open product questions that should be answered before code lands.

### 16.1 Revised patch sequence

**Patch 1 — Smallest UX/state visibility fix (low risk)**

Goal: make user-visible state reflect actual account state on manual switches. No routing changes.

- `src/components/Messages.tsx` — key `LogoHeader` on `authVersion` as well as `conversationId`.
- `src/components/LogoV2/LogoV2.tsx` — stop using `getGlobalConfig().oauthAccount?.displayName` as the Codex account label source. Use the active Codex pool identity.
- `src/components/LogoV2/AccountsPanel.tsx` — re-key the usage/active-account fetch effects on `authVersion`.
- `src/commands/switch-account/switch-account.ts` — detect no-op switch (`result.accountId === captured.accountId`) and return "Already on X" **before** any side effects (cache invalidation, sessionId regen).

Covers Bugs #2 and #9. Belt-and-braces for downstream debugging once Patches 2/3 land.

**Patch 2 — Lease invariant + persistence (core correctness)**

Goal: separate lease-local routing from global active account state.

- `src/services/api/codexAccountLeaseManager.ts` — remove the `setActiveAccount` call from `failoverCodexLease`. Lease-local failovers stay lease-local.
- `src/services/api/withRetry.ts` — for failures that should change global active (main-thread cap exhaustion), use an explicit dedicated path that persists.
- `src/services/api/codexAccountLeaseManager.ts` — add a bulk reassign helper used by `/switch-account` and `/delete-account` that touches main + follow-main subagent leases. Spread leases left alone on switch; on delete, any lease (any strategy) pointing at the deleted account must be re-resolved or released.
- `src/services/api/codexAccountPool.ts` — `markPoolAccountStatus` reroll path: either make it explicit-and-persisted, or stop `fetchPoolUsage` from mutating active state. Needs §16.3 product call.
- Persist `activeCodexAccountId` only for **intentional** global active changes.

Covers Bugs #1, #3, #4.

**Patch 3 — Identity-mismatch hardening**

Goal: make identity changes explicit, reconciled, and diagnosable.

- `src/codex-core/accounts.ts` — on mismatch: mark old pool entry dead, append replacement to live pool, emit diagnostic. Vault persistence already happens; don't redundantly write.
- `src/services/api/codexTokenRefresh.ts` — snapshot `wasActive` and `wasMain` before `markAccountDead`; pass `activate: wasActive || wasMain` to `appendAccount`. Reassign main lease in the same case.
- `src/services/api/codexTokenRefresh.ts` — fix `expiresAt` to use real OAuth expiry instead of `Date.now()`. Affects both the same-account refresh path (~line 205-216) and the identity-mismatch path (~line 158-170).
- `src/services/api/codexAccountPool.ts` — persist real expiry; reload path should read it rather than reconstructing from `last_refresh`.
- `src/services/api/accountDiagnostics.ts` — add `account.identity_mismatch` code.
- **Pre-requisite for diagnostics:** verify §15.2 (sink wiring) — otherwise the diagnostic addition is noop.

Covers Bugs #5, #6, #7.

**Patch 4 — Small cleanups**

- Bug #8: either delete `selectAccountForTurn`, `setTurnThreshold`, `pool.turnThreshold`, the settings schema entry, and the `/accounts` display together — or wire it into `query.ts:324-330` as a real feature. Pick one; partial cleanup is not acceptable.
- Bug #10: replace first-match prefix selectors with ambiguity-aware resolvers in both pools, in `/switch-account` cross-pool resolution, and in `/rename-account`. Keep exact-match precedence; reject ambiguous-same-specificity prefixes.

**Patch 5 — Retry/error-classification hardening**

- Bound connection-error failover loops in `withRetry.ts` for `UNATTENDED_RETRY` mode (per-account error cooldown gate).
- Inspect 429/403 body before classifying as cap/revoke.
- Add diagnostics for: manual switch start/success/no-op/failure, usage-driven cap/uncap, active rerolls, lease failover, identity mismatch.

**Patch 6 — Diagnostic sink wiring (pre-requisite for any diagnostic-adding fix)**

Per §15.5.1, diagnostics are silently dropped in terminal, bridge, and dedicated-app modes today. Without this patch, every "add diagnostic X" elsewhere in the plan is noop for users in those modes.

- Terminal: install a sink during interactive startup that emits to debug log or a UI event (not raw stderr — would pollute terminal). Likely site: `src/main.tsx:3916-3924` near `launchRepl()`, or `src/entrypoints/init.ts:86-97`.
- Bridge: install a sink after `initBridgeCore()` in `src/bridge/initReplBridge.ts:490-544`; forward via `handle.writeSdkMessages([message])`.
- Dedicated app: install a per-turn sink in `AppSessionController.submit()` (`src/app-runtime/AppSessionController.ts:143-156`); emit via `createMessageEvent(message)`.
- SDK / `--print --output-format=stream-json` already wires this correctly (`src/cli/print.ts:597-603`); leave alone.

**Should land before Patch 3.** Otherwise the new `account.identity_mismatch` event is invisible to the same users who would benefit most.

**Patch 7 — `GenerateImageTool` lease awareness (per §15.5.6)**

- `src/tools/GenerateImageTool/GenerateImageTool.ts:512-545` — replace `getActiveAccount()` / `getCodexOAuthTokens()` with the lease-aware resolution via `getCurrentCodexLease()` or `resolveCodexOAuthTokensForLeaseOwner`.
- Audit the other intentional bypass sites (§15.5.6 table) to confirm they remain correct.
- Add a comment / doc note explaining the lease-vs-active distinction so future tools don't re-introduce the bypass.

Independent of Patches 1-3; can land any time.

### 16.2 Test plan (consolidated)

**Unit tests:**

- `codexAccountLeaseManager`: manual switch propagation rebinds main + follow-main only; subagent `failoverCodexLease` changes only that lease; global `activeIndex` unchanged for lease-local failover; main-thread failover updates lease + active + persistence atomically.
- `codexAccountPool`: `markPoolAccountStatus` reroll behavior matches chosen invariant (explicit-and-persisted, or non-mutating); `switchToAccount` rejects ambiguous prefixes; `selectAccountForTurn` covered as real behavior or removed.
- `codexTokenRefresh`: refreshed accounts get future `expiresAt`; no immediate second refresh; identity mismatch activates replacement only when old was active/main; inactive account mismatch doesn't steal active slot.
- `codex-core/accounts`: mismatch persists, emits diagnostic, reconciles live pool, doesn't keep selecting stale alias indefinitely.
- `/switch-account`: explicit no-op returns "Already on X" and skips side effects; bare switch rotates to a different healthy account; ambiguous prefix returns ambiguity error.

**Integration tests:**

- Manual `/switch-account` with a running async subagent: follow-main subagent's outbound request uses new account; spread subagent unchanged (if that's the chosen behavior).
- UI/state surfaces after switch: StatusLine, LogoV2, AccountsPanel, web status if applicable.
- Restart persistence: after global failover or usage-driven reroll, restart and verify restored active matches intended state.
- Identity mismatch: active mismatch updates active bullet, main lease, and routed account consistently; inactive mismatch doesn't change active session.
- `GenerateImageTool` (§15.3): define intended behavior when lease account and `pool.activeIndex` disagree.

**Stress / race tests:**

- Manual switch while subagent request is in flight.
- Concurrent subagent failovers.
- Periodic `touchAll` identity mismatch racing with manual switch.
- Usage polling cap/uncap racing with retry failover.
- Repeated connection errors across multiple healthy accounts; assert bounded failovers and clear terminal error.
- Cap exhaustion across all accounts; assert failover count bounded by healthy-account count.

### 16.3 Open product questions

These are decisions for a product owner, not implementation details. Each fix above gates on the answer.

1. **Manual `/switch-account` propagation scope.** Should it rebind: (a) only `main-thread`; (b) main + follow-main subagents; (c) all subagents regardless of strategy; (d) only future subagents? My Patch 2 recommends (b), but this is product policy, not a code-can-decide question.
2. **Usage polling state mutation.** Should `fetchPoolUsage` be **observational only** (display-only), or should it be allowed to mutate account health and active selection? Current behavior mutates; current `/accounts` and `AccountsPanel` invocations trigger that mutation as a side effect.
3. **Turn-based rotation.** Bug #8 — keep the feature and wire it up, or delete it entirely? Partial cleanup leaves confusing UI/config.
4. ~~`GenerateImageTool` lease awareness.~~ → **§15.5.6 answered.** Confirmed accidental bypass. Recommendation: make lease-aware request-time resolution universal. Implementation in Patch 7.
5. ~~Diagnostic sink installation in production.~~ → **§15.5.1 answered.** Confirmed dropped in terminal / bridge / dedicated-app modes. Recommendation: install per-mode default sinks. Implementation in Patch 6.
6. **(New)** `/accounts` mutating state as a side effect (§15.5.4) — is it acceptable that running `/accounts` can silently change the active account? Most users would not expect a read-only "show me my accounts" command to have side effects. This is part of the bigger §16.3.2 question but worth calling out specifically.

---

## Appendix A — Audit Methodology Detail

### A.1 Why parallel subagents

The investigation used parallel subagents because:
- The four breadth audits cover non-overlapping code surfaces; they're embarrassingly parallel.
- Each subagent runs cold (no shared context with this conversation), forcing self-contained briefs — which surfaces ambiguous claims early.
- Cost is comparable to one serial pass but wall time is 4-5× faster.
- Cross-checking the same area across two subagents (e.g. lease behavior was hit by breadth audit #2 and deep dive #5) provides natural redundancy.

### A.2 Subagent briefs (summary)

Full briefs were self-contained per subagent. Each included:
- Read-only directive (no edits).
- Explicit file lists ordered by importance.
- Numbered questions to answer (not just "investigate").
- Output format and word limit.
- Honesty requirement ("be explicit about what you couldn't verify").
- Recent commits to `git show` (so they could catch regressions tied to the active branch).

### A.3 Cross-validation

Findings appearing in both a breadth audit and a deep-dive were treated as high-confidence. Findings appearing in only one were retained but tagged. Conflicts (none arose in practice) would have been resolved by reading the cited code directly.

### A.4 Limitations of the approach

- No runtime traces. Several "Unverified" items in §14 require actually running the binary.
- No browser-driver / TUI snapshot testing for Bug #2's repro — confirmed from code only.
- No multi-account concurrent load test. The thundering-herd analysis (§5.10, §10) is from reading.
- Subagents may collapse claims; this synthesis pulled findings forward but may still have minor compressions.

---

## Appendix B — Raw Subagent Findings (Index)

The seven subagent transcripts are stored in the tasks subsystem (not included here for context economy). Their key outputs were:

1. **Breadth #1 — Switch-account command flow.** Confirmed Claude works; Codex works with caveats; surfaced Bug #10 (intra-pool ambiguity), Bug #9 (no-op message), Bug 5.9 (provider check).
2. **Breadth #2 — Codex pool & lease.** Surfaced Bug #1 (subagent lease invalidation), Bug #5 (identity-mismatch in codex-core), Bug #6 (`expiresAt`), and edges §5.2, §5.3, §5.4.
3. **Breadth #3 — Claude pool.** All findings in §13.
4. **Breadth #4 — Diagnostics & UI.** Surfaced Bug #2 (LogoV2 memo) and the diagnostic gaps in §9.
5. **Deep #5 — Subagent lease.** Forensic trace of Bug #1; full call-site list (§3.3, §3.4); fix design options; identified `/delete-account` parallel bug.
6. **Deep #6 — LogoV2 memo.** Confirmed Freeze A + Freeze B mechanism (§4 Bug #2); identified all stale UI surfaces; rejected three alternative fixes with reasoning.
7. **Deep #7 — Auto failover.** Produced the trigger catalog (§6); identified Bugs #3, #4; flagged unattended-retry loop risk (§10); confirmed in-flight request behavior (§5.10).
8. **Verification pass (post-report).** Independent read-only re-check of all 10 top bugs against current source. No bugs disproved; eight had stale or overstated details. Surfaced new findings: diagnostic sink wiring (§15.2), `GenerateImageTool` lease-unawareness (§15.3). Corrections folded inline as `[CORRECTION]` blocks in §4; new sections §15 and §16 added.

---

## File Index

Primary files referenced in this report:

### Codex pool / lease / failover
- `src/services/api/codexAccountLeaseManager.ts`
- `src/services/api/codexAccountPool.ts`
- `src/services/api/codexTokenRefresh.ts`
- `src/services/api/codexUsage.ts`
- `src/services/api/withRetry.ts`
- `src/services/api/client.ts`
- `src/services/api/codex-fetch-adapter.ts`
- `src/services/api/accountDiagnostics.ts`
- `src/codex-core/accounts.ts`
- `src/codex-core/client.ts`

### Commands
- `src/commands/switch-account/switch-account.ts`
- `src/commands/delete-account/delete-account.ts`
- `src/commands/rename-account/rename-account.ts`
- `src/commands/accounts/accounts.ts`
- `src/commands/login/login.tsx`
- `src/commands/logout/logout.tsx`

### Terminal UI
- `src/components/Messages.tsx` ← Bug #2 fix site
- `src/components/LogoV2/LogoV2.tsx`
- `src/components/LogoV2/AccountsPanel.tsx`
- `src/components/LogoV2/LogoV2.test.tsx` (untracked)
- `src/screens/REPL.tsx`
- `src/components/StatusLine.tsx`

### Agent / subagent runtime
- `src/tools/AgentTool/AgentTool.tsx`
- `src/tools/AgentTool/resumeAgent.ts`
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- `src/query.ts`

### Auth / Claude pool
- `src/utils/auth.ts`
- `src/services/api/claudeAccountPool.ts`
- `src/services/oauth/client.ts`
- `src/services/oauth/codex-client.ts`
- `src/utils/secureStorage/*`

### SDK
- `src/entrypoints/sdk/coreSchemas.ts`

### Tests / docs touched
- `src/codex-core/request.test.ts`
- `src/services/api/accountDiagnostics.test.ts`
- `docs/maps/auth-accounts-oauth.md` (last refreshed 2026-05-12)

### Recent commits referenced
- `1d9c08b` — chore: prune account diagnostics lint suppression
- `1e93172` — feat: add account routing diagnostics
- `857ae20` — Support friendly subagent targeting
- `33880cb` — feat: split subagent resume from SendMessage
- `6d8bcf1` — docs: plan separating subagent resume from SendMessage
