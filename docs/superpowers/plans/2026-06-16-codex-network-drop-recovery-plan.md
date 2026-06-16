# Codex Network-Drop Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Converged after four adversarial design passes. The spine is fixed; the open work is verification-gated implementation. Source citations below were verified against the dirty checkout at HEAD on 2026-06-16.

**How to read this plan:** Each phase is independently testable and ordered by safety dependency (Phase 1's status enum must exist before anything routes to it). Code blocks are illustrative targets, not literal patches — match the surrounding style and verify line numbers before editing, since the checkout is dirty and may have drifted. Every `[ ]` step names its test file explicitly. Run the test command at the end of each phase before moving on. **Do not proceed past a phase whose tests are red.**

**Key facts an executor must not get wrong (verified):**
- **There is no `src/services/api/withRetry.test.ts`.** The EP2 recovery path is tested in **`src/services/api/accountRecoveryDiagnostics.test.ts`**, which already imports `withRetry` + `CodexAccountAuthError` and drives this exact path (see its tests at lines 357 "recovers from transient Codex connection failover without capping" and 522 "ambiguous … transient instead of quota exhaustion" — your new EP2 tests extend these).
- `CodexAccountAuthError` is defined in **`src/services/api/codex-fetch-adapter.ts:254`** (`new CodexAccountAuthError(accountId, status)`), not in withRetry.
- `countStatuses` is **duplicated**: `client.ts:144` and `withRetry.ts:113`. Both take `readonly { status: string }[]` and bucket by `status`. Both feed a `capped === total → quota.exhausted` decision. Both must change.
- Each test file has its **own local `buildPoolAccount` helper** that copies a fixed field list — if you add a field to `PoolAccount` you must add it to each helper you seed through, or the field is silently dropped. The `codexTokenRefresh.test.ts` helper (lines 25–50) currently copies `statusReason`, usage fields, `planType`, `planExpiresAt`, etc.; `accountRecoveryDiagnostics.test.ts` has its own. Confirm before seeding.
- `createIdToken` / `createAccessToken` JWT builders exist in `codexTokenRefresh.test.ts` (lines 52–72); copy them into any test file that lacks them.

---

## Goal

A transient network drop must never convert a usable Codex credential into a dead/revoked one, on **any** of the three enforcement points where that conversion currently happens. Credential death may come **only** from an explicit server verdict (`invalid_grant` in the body, HTTP 401/403, identity mismatch). Network/transport uncertainty routes accounts to a new **`quarantined`** state that is excluded from routing but self-heals via a bounded background probe when connectivity returns. The user is never silently locked out, and offline is never reported as "quota exhausted."

## The spine (unchanged across all four passes)

> Credential validity and reachability are **different axes**. Only an explicit **server verdict** may write `reauth_required` / mark an account `dead`. No server contact ⇒ no credential verdict.

## Why a distinct `quarantined` status (decision reversed in pass 4)

An earlier draft modeled quarantine as `capped` + `statusReason: 'probe_pending'` on the "touches zero sites" argument. **That was wrong.** Four existing sites treat `capped` as a synonym for *quota exhausted*, so quarantine-as-`capped` silently misbehaves there:

1. **Successful probe can't clear** — `appendAccount(..., preserveCapped: true)` preserves `capped` ([codexAccountPool.ts:349](../../src/services/api/codexAccountPool.ts#L349)), and the normal refresh-success path uses it ([codexTokenRefresh.ts:557](../../src/services/api/codexTokenRefresh.ts#L557)). A probe that *succeeds* would stay quarantined forever.
2. **Diagnostics misreport** — `counts.capped === counts.total → 'quota.exhausted'` in both `client.ts` ([emitCodexUnavailableDiagnostic:205](../../src/services/api/client.ts#L205)) and `withRetry.ts` ([getCodexExhaustionDiagnosticCode:166](../../src/services/api/withRetry.ts#L166)). All-quarantined would report as quota — the opposite of the connectivity signal this work exists to produce.
3. **Copy misleads** — lease exhaustion maps to "usage limit reached" ([errors.ts:927](../../src/services/api/errors.ts#L927)).
4. **Standalone core** treats any `capped` as quota/429 ([codex-core/accounts.ts:44](../../src/codex-core/accounts.ts#L44)).

A distinct enum value turns each of these into a **compile error** (non-exhaustive narrowing / type mismatch), forcing correct handling instead of relying on memory. The ~17 raw `status === 'healthy'` selectability sites continue to exclude `quarantined` correctly (it is `!== 'healthy'`); only the four quota-equating sites must change, which they should.

## The three enforcement points (a classifier-only fix is insufficient)

The network-drop → death conversion happens in **three independent places**. Fixing only the first leaves the other two bricking accounts:

| # | Where | Current behavior | Citation |
|---|---|---|---|
| EP1 | Disk persistence (refresh classifier) | unrecognized transport → `fatal` → writes `reauth_required`; blanket `!response.ok` kills before body parse | [codexTokenRefresh.ts:365](../../src/services/api/codexTokenRefresh.ts#L365), [:382](../../src/services/api/codexTokenRefresh.ts#L382) |
| EP2 | Request-time recovery (`withRetry`) | catches **any** `refreshAccountTokens` failure, ignores reason, marks account `dead` | [withRetry.ts:610](../../src/services/api/withRetry.ts#L610) |
| EP3 | In-memory pool on live `touchAll` | writing `refresh.state='unknown'` to disk does **not** mark the in-memory account; same process keeps routing to it until reload | [codexTokenRefresh.ts:351](../../src/services/api/codexTokenRefresh.ts#L351), [:647](../../src/services/api/codexTokenRefresh.ts#L647) |

Plus two coverage gaps:

- **EP4 — single-account bypass.** `isPoolActive()` requires `> 1` account ([codexAccountPool.ts:219](../../src/services/api/codexAccountPool.ts#L219)); below that, `resolveCodexOAuthTokensForLeaseOwner` returns the config token ignoring pool state ([client.ts:234](../../src/services/api/client.ts#L234)). Login writes both config and vault ([ConsoleOAuthFlow.tsx:185](../../src/components/ConsoleOAuthFlow.tsx#L185)), so a single quarantined vault account still sends via the config copy. Quarantine is a no-op for the common one-account setup unless this path checks it.
- **EP5 — standalone core.** `codex-core/accounts.ts` wraps **any** refresh failure as `auth`/401 "Please re-login" ([accounts.ts:225](../../src/codex-core/accounts.ts#L225)) and treats any `capped` as quota ([:44](../../src/codex-core/accounts.ts#L44)).

## Established findings carried in (verified)

- **E1** `AbortSignal.timeout()` → `DOMException{name:"TimeoutError"}` → `ambiguous` (recoverable, not the bug). The dangerous input is `TypeError("fetch failed")` → `fatal` default. ([codexTokenRefresh.ts:168](../../src/services/api/codexTokenRefresh.ts#L168))
- **E2** Same-hash `unknown` and `reauth_required` share one terminal branch → `markAccountDead` + throw. Must become a re-probe. ([codexTokenRefresh.ts:267](../../src/services/api/codexTokenRefresh.ts#L267))
- **E4** No-healthy-account **does** render on the foreground path via `APIConnectionError` → generic query catch → `getAssistantMessageFromError` ([client.ts:223](../../src/services/api/client.ts#L223), [query.ts:1008](../../src/query.ts#L1008), [errors.ts:939](../../src/services/api/errors.ts#L939)). UX work is copy + prompt fate + non-foreground surfaces, **not** "add a missing render."
- **E7** The newer-token guard (not the lockfile) prevents double-spend; the re-probe must run **after** it. ([codexTokenRefresh.ts:236](../../src/services/api/codexTokenRefresh.ts#L236))
- `invalid_grant` is body-borne; current code kills before parsing the body, so the HTTP split must move the kill **after** a body read. ([codexTokenRefresh.ts:382](../../src/services/api/codexTokenRefresh.ts#L382))
- `countStatuses` is **duplicated** in `client.ts:144` and `withRetry.ts:113` — both must learn about `quarantined`.

## Out of scope

- Claude pool (`claudeAccountPool.ts`) behavior changes — only the shared `PoolAccount['status']` type widening forces a compile-driven audit there; no new Claude semantics.
- The connectivity status-line indicator + `codexConnectivity` flag (depends on `RefreshResult` carrying structured transport classification — deferred to a follow-up; this plan adds the classification field but not the UI).
- Auto-expiring usage caps via `usageResetAt`.

## Tech stack

TypeScript, Bun tests. Existing Codex account-pool, token-refresh, lease-manager, and withRetry modules.

Do not create new source files. Tests may be added only to the existing test files listed per task. Do not commit during execution unless the user explicitly asks.

---

## File Structure

- `src/services/api/codexAccountPool.ts` — add `'quarantined'` to `PoolAccount['status']`; add `'probe_pending_transport'` to `PoolAccountStatusReason`; classifier returns `blocked` for quarantined; `loadVaultAccounts` reads `refresh.state`; helper `markPoolAccountQuarantined`; `preserveCapped` must not preserve across a successful refresh of a quarantined account.
- `src/services/api/codexTokenRefresh.ts` — EP1 classifier inversion + HTTP body-aware split + `stale_in_flight → unknown`; EP3 mark in-memory quarantined on transport-failed writes; surface a classified reason on `RefreshResult`; re-probe branch for same-hash `unknown` (after the E7 guard); startup revalidation entry point.
- `src/services/api/withRetry.ts` — EP2: inspect refresh outcome; transport/unknown → quarantine + failover, never `dead`; teach both `countStatuses` and exhaustion-code to treat `quarantined` as connectivity, not quota.
- `src/services/api/client.ts` — EP4: single-account path consults quarantine; `countStatuses` + `emitCodexUnavailableDiagnostic` distinguish quarantine from quota.
- `src/services/api/errors.ts` — copy: distinguish "all rate-limited" from "connection problem / retrying" from "needs re-login."
- `src/codex-core/accounts.ts` — EP5: refresh-failure wrapping is reason-aware; `capped`-as-quota branch distinguishes quarantine.
- `src/screens/REPL.tsx` — UX: separately-keyed prompt-restore outcome for the no-healthy/connection case (prove-then-fix gated).
- Background probe scheduler — a fast, `unref`'d, backoff-keyed loop with cadence persisted in the vault (lives alongside `startPeriodicRefresh` in `codexTokenRefresh.ts`).

Tests (all exist; **no new test files** — EP2/withRetry behavior goes in `accountRecoveryDiagnostics.test.ts`):
- `src/services/api/codexAccountPool.test.ts` — status enum, classifier, load-time quarantine, preserveCapped clearing.
- `src/services/api/codexTokenRefresh.test.ts` — EP1 classifier/HTTP split, re-probe, startup revalidation.
- `src/services/api/accountRecoveryDiagnostics.test.ts` — EP2 (withRetry recovery), EP3 (live touchAll), exhaustion-code-vs-connectivity.
- `src/services/api/codexUsage.test.ts` — `/accounts` display of quarantine vs cap.
- `src/codex-core/accounts.test.ts` — EP5 standalone-core reason-awareness (verify this file exists; if not, the nearest codex-core test home).
- `src/commands/switch-account/switch-account.test.ts` — switch messaging for a quarantined account.

---

## Phase 0 — Prove-then-fix baselines (gate; do first)

Per the standing rule from review, pin **current** behavior at each enforcement point before changing it, so each fix has a red→green baseline. **No source changes in this phase** — these tests assert today's (buggy) behavior and are inverted in later phases. Mark each with a comment `// BASELINE: documents pre-fix behavior; inverted in Phase N`.

- [ ] **Step 1: Pin EP2 (withRetry marks dead regardless of reason).** In `src/services/api/accountRecoveryDiagnostics.test.ts`. Study the test at line 357 (`recovers from transient … without capping`) and 267 (`handles pooled Codex auth failure …`) for the exact harness shape (how `withRetry` is driven, how `refreshAccountTokens` is stubbed, the `Parameters<typeof withRetry>[2]` options cast). Then add a test that throws `CodexAccountAuthError(accountId, 401)` from the inner call so recovery runs, stubs the account's refresh to **fail with a transport error** (`TypeError('fetch failed')`), and asserts the **current** outcome:

```ts
// BASELINE: today withRetry marks the account dead on ANY refresh failure,
// including transport. Phase 2 inverts this to 'quarantined'.
expect(getPoolStatus().accounts.find(a => a.accountId === accountId)?.status).toBe('dead')
```

  Note in a comment that the stub must make `refreshAccountTokens` reject (not return `{status:'refreshed'}`), so `refreshRecovered` stays false and execution reaches the `markPoolAccountStatus(..., 'dead', ...)` at withRetry.ts:610.

- [ ] **Step 2: Pin EP3 (live `touchAll` leaves in-memory account selectable).** In `src/services/api/codexTokenRefresh.test.ts` (it has the temp-vault + `fetch`-stub conventions; see the identity-handling describe at line 74). Write a real vault file via `mkdtempSync`+`writeFileSync`, `seedCodexAccountPoolForTest` with that `vaultFilePath`, stub `globalThis.fetch` to throw `TypeError('fetch failed')`, run `touchAll()`, then assert:

```ts
// BASELINE: touchAll writes refresh.state='unknown' to DISK but does not
// touch the in-memory pool, so the running process keeps routing here.
// Phase 4 Step 1 adds the in-memory markPoolAccountQuarantined call.
const onDisk = JSON.parse(readFileSync(filePath, 'utf-8'))
expect(onDisk.refresh.state).toBe('unknown')
expect(isCodexAccountSwitchable(getPoolStatus().accounts[0]!)).toBe(true) // still selectable today
```

  Import `isCodexAccountSwitchable` and `touchAll`. Restore `globalThis.fetch` and `rmSync` the temp dir in a `finally`.

- [ ] **Step 3: Pin EP4 (single-account config bypass).** In `accountRecoveryDiagnostics.test.ts` or `codexAccountLeaseManager.test.ts` (whichever already has a `resolveCodexOAuthTokensForLeaseOwner` import — check; the lease test file is the likely home). Seed **exactly one** vault account marked `quarantined` *(use `status:'capped'` for the baseline since `quarantined` doesn't exist yet — the point is `isPoolActive()` is false with one account)*, ensure a config token is present (`saveCodexOAuthTokens`/the auth getter the neighboring tests use), and assert `resolveCodexOAuthTokensForLeaseOwner({ codexLeaseOwnerType: 'main' })` returns the **config** token today. Comment: `// BASELINE: !isPoolActive() (1 account) bypasses pool state; Phase 6 Step 3 adds the quarantine check.`

- [ ] **Step 4: Pin foreground UX (E4).** In the test home for `getAssistantMessageFromError` (grep for an existing `errors.test.ts` or where `getCodexLeaseExhaustedMessage` is asserted; if none, add a focused test next to the lease-exhausted logic). Capture the **current** lease-exhausted copy verbatim:

```ts
// BASELINE: current copy says "usage limit reached" for lease exhaustion,
// which is wrong when the cause is connectivity. Phase 6 Step 1 splits this.
expect(msg.content).toContain('usage limit reached')
```

```bash
cd /Users/pt/cat-code && bun test src/services/api/codexTokenRefresh.test.ts src/services/api/accountRecoveryDiagnostics.test.ts src/services/api/codexAccountLeaseManager.test.ts
```

Expected: all PASS, documenting today's behavior. If any baseline does **not** pass, the design's premise about that enforcement point is wrong — STOP and reconcile before continuing.

---

## Phase 1 — The `quarantined` status (must land before EP1/EP2/EP3 fixes)

**Files:** `src/services/api/codexAccountPool.ts`, `src/services/api/codexAccountPool.test.ts` (+ compile-driven edits to `client.ts`, `withRetry.ts` stubs as flagged)

This phase only *introduces* the state and its routing exclusion. The behavior that *produces* quarantine (EP1/2/3) comes in later phases. After this phase, no production code writes `quarantined` yet — but a seeded quarantined account is correctly non-selectable and correctly distinguished from a cap.

- [ ] **Step 1: Widen the union and enumerate the fallout.**
  In `src/services/api/codexAccountPool.ts`:
  - `PoolAccount['status']`: `'healthy' | 'dead' | 'capped' | 'quarantined'`.
  - `PoolAccountStatusReason`: add `'probe_pending_transport'` (keep existing members).

  Then run the build and **capture the complete list of narrowing failures** — this list IS the work surface for Phases 2/6:
  ```bash
  cd /Users/pt/cat-code && bun run build:dev:full 2>&1 | rg -n "quarantined|is not assignable|not comparable|exhaustive" | tee /tmp/quarantine-fallout.txt
  ```
  Expected hits (verify against the file; do **not** fix yet unless trivial/local): `getCodexAccountAvailability` (codexAccountPool.ts ~1191 — Step 2 here), the two `countStatuses` copies (client.ts:144, withRetry.ts:113), `emitCodexUnavailableDiagnostic`/`getCodexExhaustionDiagnosticCode` (client.ts:205, withRetry.ts:166), `errors.ts:927` lease-exhausted copy, `codex-core/accounts.ts:44`. Each non-local site is owned by a later phase; add a `// TODO(quarantine Phase N)` marker so nothing is missed. **Note:** the union is shared with the Claude pool only structurally; `claudeAccountPool.ts` never produces `quarantined`, so its `=== 'healthy'` sites stay correct (quarantined is `!== 'healthy'`). Confirm no Claude site does `=== 'capped'`-as-usable.

- [ ] **Step 2: Classifier returns `blocked` for quarantined.**
  In `getCodexAccountAvailability` (codexAccountPool.ts:1191), add **before** the `capped` branch (line 1198):
  ```ts
  if (account.status === 'quarantined') {
    return {
      kind: 'blocked',
      reason: normalizeCodexAccountBlockReason(account.lastError) ?? 'connection problem; retrying',
    }
  }
  ```
  In `codexAccountPool.test.ts` (use its local `buildPoolAccount`, lines ~? — find it), add:
  ```ts
  test('quarantined accounts are blocked and non-selectable', () => {
    const account = buildPoolAccount({
      accountId: 'q1',
      status: 'quarantined',
      statusReason: 'probe_pending_transport',
      lastError: 'connection problem; retrying',
    })
    expect(getCodexAccountAvailability(account)).toEqual({
      kind: 'blocked',
      reason: 'connection problem; retrying',
    })
    expect(isCodexAccountSwitchable(account)).toBe(false)
    expect(isCodexAccountLeaseSelectable(account)).toBe(false)
  })
  ```
  Add `'quarantined'` to that test file's `buildPoolAccount` if its `status` field is typed narrowly, and ensure the helper copies `statusReason`/`lastError` (most do).

- [ ] **Step 3: `markPoolAccountQuarantined(accountId, reason)` helper.**
  In `codexAccountPool.ts`, near `markAccountDead` (line 604). Mirror its reroll-away logic (it IS the active account → `findLRUHealthy(-1)` + persist), but the status is recoverable:
  ```ts
  export function markPoolAccountQuarantined(accountId: string, reason: string): void {
    const acct = pool.accounts.find(a => a.accountId === accountId)
    if (!acct) return
    acct.status = 'quarantined'
    acct.statusReason = 'probe_pending_transport'
    acct.lastError = reason
    if (pool.accounts[pool.activeIndex]?.accountId === accountId) {
      const next = findLRUHealthy(-1)
      pool.activeIndex = next
      persistActiveCodexAccountId(pool.accounts[next]?.accountId)
      emitActiveRerollDiagnostic(accountId, pool.accounts[next]?.accountId, `quarantined: ${reason}`)
    }
    logForDebugging(`[codex-pool] Account ${truncId(accountId)} quarantined: ${reason}`)
  }
  ```
  Emit a diagnostic code distinct from `account.usage.cap` (e.g. reuse `emitAccountDiagnostic` with a `account.quarantined`-style code; match the existing diagnostic code vocabulary in `accountDiagnostics`). Test: quarantining the active account moves `activeIndex` to a healthy peer.

- [ ] **Step 4: `loadVaultAccounts` reads `refresh.state`.**
  In `loadVaultAccounts` (codexAccountPool.ts:873), after the existing `const status = checkAccountHealth(lastRefresh)` (line 931) and before `results.push`:
  ```ts
  const refreshState = (data.refresh as { state?: string } | undefined)?.state
  const isTransportQuarantine =
    status !== 'dead' && (refreshState === 'unknown' || refreshState === 'stale_in_flight')
  const effectiveStatus: PoolAccount['status'] = isTransportQuarantine ? 'quarantined' : status
  ```
  Use `effectiveStatus` in the pushed object's `status`, and when `isTransportQuarantine`, also set `statusReason: 'probe_pending_transport'` and `lastError: 'connection problem; retrying (pending probe)'`. Leave the existing `status === 'dead'` spread as-is. **`reauth_required` is deliberately NOT quarantined here** — Phase 5 handles it (it may be a real server verdict). Test: a vault file with `refresh.state:'unknown'` loads `quarantined`; one with `refresh.state:'reauth_required'` still loads per the 7-day rule (not auto-quarantined).

- [ ] **Step 5: `preserveCapped` must not trap a recovering account.**
  In `appendAccount` (codexAccountPool.ts:349), `preserveCapped` already gates on `acct.status === 'capped'`, so a `quarantined` account is **not** preserved — a successful refresh's `appendAccount(..., preserveCapped:true)` will set it `healthy`. Add a regression test proving this (it's the failure mode that killed the `capped`-reuse design):
  ```ts
  test('a successful refresh clears quarantine to healthy even with preserveCapped', () => {
    seedCodexAccountPoolForTest({ accounts: [buildPoolAccount({ accountId: 'q1', status: 'quarantined', statusReason: 'probe_pending_transport' })] })
    appendAccount(
      { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60_000, accountId: 'q1' },
      { preserveCapped: true, writer: 'test' },
    )
    expect(getPoolStatus().accounts[0]!.status).toBe('healthy')
  })
  ```

```bash
cd /Users/pt/cat-code && bun test src/services/api/codexAccountPool.test.ts
```
Expected: PASS. The build may still have un-narrowed `quarantined` sites flagged in Step 1 — those are resolved in Phases 2/6; the **unit tests** for the pool pass now.

---

## Phase 2 — EP2: request-time recovery must not condemn on transport failure (hot path; highest impact)

**Files:** `src/services/api/withRetry.ts`, `src/services/api/accountRecoveryDiagnostics.test.ts`

This is the live path that bricks accounts mid-session, so it lands first among the producers. The current code (withRetry.ts:589–615) is:
```ts
let refreshRecovered = false
if (currentAccount?.refreshToken && currentAccount.vaultFilePath) {
  try {
    const refreshed = await refreshAccountTokens(currentAccount.accountId, currentAccount.refreshToken, currentAccount.vaultFilePath)
    if (refreshed.status === 'refreshed') refreshRecovered = true
  } catch {
    // refreshAccountTokens already records the underlying failure state  ← swallows the reason
  }
}
if (refreshRecovered) { client = null; continue }
markPoolAccountStatus(accountId, 'dead', 'Codex account authentication failed', { rerollActive: false })  ← unconditional dead
```

- [ ] **Step 1: Capture the refresh-failure reason and branch on it.**
  Import `ReauthenticationRequiredError` from `./codexTokenRefresh.js` and `markPoolAccountQuarantined` from `./codexAccountPool.js`. Replace the swallowing `catch {}` and the unconditional `markPoolAccountStatus(..., 'dead', ...)`:
  ```ts
  let refreshRecovered = false
  let refreshFailureWasServerVerdict = false
  if (currentAccount?.refreshToken && currentAccount.vaultFilePath) {
    try {
      const refreshed = await refreshAccountTokens(currentAccount.accountId, currentAccount.refreshToken, currentAccount.vaultFilePath)
      if (refreshed.status === 'refreshed') refreshRecovered = true
    } catch (refreshErr) {
      // Only a server verdict (reauth required) condemns the credential.
      // Transport / unknown failures are reachability, not revocation.
      refreshFailureWasServerVerdict = refreshErr instanceof ReauthenticationRequiredError
    }
  }
  if (refreshRecovered) { client = null; continue }

  if (refreshFailureWasServerVerdict) {
    markPoolAccountStatus(accountId, 'dead', 'Codex account authentication failed', { rerollActive: false })
  } else {
    markPoolAccountQuarantined(accountId, 'connection problem during token refresh; retrying')
  }
  ```
  The original `CodexAccountAuthError` that triggered this block (a real 401 from the request itself, codex-fetch-adapter.ts:254) is still a server verdict — but the *recovery refresh's* outcome is what decides dead-vs-quarantine here. Keep the subsequent `emitCodexDiagnostic` and failover (`failoverCodexLease` / `switchToAccount`) intact so the turn still completes on another account.

- [ ] **Step 2: `countStatuses` + exhaustion code must not treat quarantine as quota.**
  `countStatuses` (withRetry.ts:113) already buckets generically, so `counts.quarantined` will exist. The decision in `getCodexExhaustionDiagnosticCode` (withRetry.ts:161) currently:
  ```ts
  if (counts.capped === counts.total) return 'quota.exhausted'
  return 'account.pool.unavailable'
  ```
  Change so quarantine is connectivity, not quota:
  ```ts
  const capped = counts['capped'] ?? 0
  const quarantined = counts['quarantined'] ?? 0
  if (quarantined > 0 && capped + quarantined === counts['total']) {
    // at least one account is only blocked by connectivity → not a quota problem
    return 'account.pool.unavailable'   // (or a dedicated connectivity code if one exists in the diagnostic vocab)
  }
  if (capped === counts['total']) return 'quota.exhausted'
  return 'account.pool.unavailable'
  ```
  Apply the **same** change to `client.ts`'s `emitCodexUnavailableDiagnostic` (client.ts:205) — it is a second copy of this decision. Verify the diagnostic code vocabulary in `accountDiagnostics` before inventing a new code; prefer an existing one if a connectivity/transient code exists.

- [ ] **Step 3: Invert the Phase 0 Step 1 baseline.**
  Change the EP2 baseline test's assertion from `'dead'` to `'quarantined'`, and add that a healthy peer was failed-over to (the turn proceeds). Add a sibling test: when the recovery refresh fails with `ReauthenticationRequiredError`, the account is still `'dead'` (server verdict preserved). Also add: all-quarantined pool emits `account.pool.unavailable`, **not** `quota.exhausted` (extends the existing line-194 "emits quota.exhausted when every pooled account is capped" test — your new test seeds quarantined instead of capped).

```bash
cd /Users/pt/cat-code && bun test src/services/api/accountRecoveryDiagnostics.test.ts
```

---

## Phase 3 — EP1: classifier inversion + HTTP body-aware split

**Files:** `src/services/api/codexTokenRefresh.ts`, `src/services/api/codexTokenRefresh.test.ts`

- [ ] **Step 1: Default `fatal → unknown`.**
  The `fetchErr` handler has three branches (codexTokenRefresh.ts:343–379): `definitely_not_sent` → `idle` (keep), `ambiguous` → `unknown` (keep), and the `else` "fatal" branch (line 365–378) which writes `reauth_required`/`network_or_timeout` + `markAccountDead`. **Collapse the fatal branch into the ambiguous one** — an unrecognized transport error is reachability, not a credential verdict:
  ```ts
  } else {
    // ambiguous OR unrecognized transport — outcome unknown, never a credential verdict
    if (stillOwner) {
      latest.refresh = {
        state: 'unknown',
        attempt_id: attemptId,
        refresh_token_hash: refreshTokenHash,
        failed_at: new Date().toISOString(),
        reason: fetchErr instanceof Error ? fetchErr.message : 'transport_unknown',
      }
      latest.version = (latest.version ?? 0) + 1
      atomicWriteJson(vaultFilePath, latest)
    }
    throw new Error(`Token refresh transport error (outcome unknown): ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`)
  }
  ```
  Effectively the `transport === 'ambiguous'` and the former `fatal` branches become one. `markAccountDead` is **removed** from this path entirely. (You may keep `classifyRefreshTransportError` returning three values for the `definitely_not_sent → idle` distinction; only the `fatal` *consequence* changes.)

- [ ] **Step 2: Body-aware HTTP split.**
  The `!response.ok` block (lines 382–397) currently kills for **every** non-2xx. Replace with a body read that condemns only explicit credential verdicts:
  ```ts
  if (!response.ok) {
    if (lockCompromised) throw new Error('Lock compromised; refusing to write vault')
    const bodyText = await response.text().catch(() => '')
    const isCredentialVerdict =
      response.status === 401 ||
      response.status === 403 ||
      /invalid_grant|invalid_token|expired_token/i.test(bodyText)
    const latest = readVault(vaultFilePath)
    if (latest.refresh?.attempt_id === attemptId) {
      latest.refresh = isCredentialVerdict
        ? { state: 'reauth_required', refresh_token_hash: refreshTokenHash, marked_at: new Date().toISOString(), reason: `http_${response.status}` }
        : { state: 'unknown', attempt_id: attemptId, refresh_token_hash: refreshTokenHash, failed_at: new Date().toISOString(), reason: `http_${response.status}` }
      latest.version = (latest.version ?? 0) + 1
      atomicWriteJson(vaultFilePath, latest)
    }
    if (isCredentialVerdict) {
      const reason = `Token refresh failed: HTTP ${response.status}`
      markAccountDead(accountId, reason)
      throw new ReauthenticationRequiredError(reason)
    }
    throw new Error(`Token refresh failed (transient): HTTP ${response.status}`)
  }
  ```
  Now 429/5xx and a bare 400 without an `invalid_grant`-family body → `unknown`, no `markAccountDead`. (This is why the body must be read **before** deciding — confirmed: current code kills before parsing the body.)

- [ ] **Step 3: `stale_in_flight → unknown`.**
  In the stale-in-flight branch (lines 286–299), change the write from `reauth_required`/`stale_in_flight` to `unknown`, and remove `markAccountDead` + the `ReauthenticationRequiredError` throw — throw a transient error instead:
  ```ts
  vault.refresh = { state: 'unknown', attempt_id: vault.refresh.attempt_id, refresh_token_hash: refreshTokenHash, failed_at: new Date().toISOString(), reason: 'stale_in_flight' }
  atomicWriteJson(vaultFilePath, vault)
  throw new Error('Previous token refresh stalled; outcome unknown (will re-probe).')
  ```
  Loop-bounding for a genuinely wedged process is Phase 4 Step 3's cadence.

- [ ] **Step 4: Carry a classified reason on `RefreshResult`.**
  Extend the `RefreshAccountTokensResult` and/or `RefreshResult` types (codexTokenRefresh.ts:76–89) with `transportClass?: 'offline' | 'ambiguous' | 'server_transient' | 'server_fatal'`. Set it where these branches throw/return so `touchAll` (and the deferred connectivity flag) can distinguish offline from auth/lock/malformed (E5). Since these branches `throw`, the classification primarily needs to reach `touchAll`'s per-file `catch` (codexTokenRefresh.ts:647) — thread it via the thrown error (e.g. a typed `CodexRefreshTransportError` carrying `transportClass`) rather than the success-only return. Keep it optional; UI consumption is deferred.

- [ ] **Step 5: Update/rewrite the EP1 tests.**
  In `codexTokenRefresh.test.ts`: the existing test that asserts a fetch failure → `reauth_required` encodes the bug — **rewrite it**. Using the file's `mkdtempSync` + `globalThis.fetch` stub conventions and `createAccessToken`, assert the new contract:
  - `globalThis.fetch` throws `TypeError('fetch failed')` → on-disk `refresh.state === 'unknown'`, account **not** dead.
  - `fetch` resolves `new Response('{"error":"invalid_grant"}', { status: 400 })` → `refresh.state === 'reauth_required'`, account dead.
  - status 429 → `refresh.state === 'unknown'`, not dead.
  - status 401 → `refresh.state === 'reauth_required'`, dead.
  - stale `in_flight` (write `refresh:{state:'in_flight', started_at: <2min ago>, refresh_token_hash:<hash>}` then call refresh with the matching token) → `refresh.state === 'unknown'`, not dead.

```bash
cd /Users/pt/cat-code && bun test src/services/api/codexTokenRefresh.test.ts
```

---

## Phase 4 — EP3 + adjudicatable `unknown` + bounded background probe

**Files:** `src/services/api/codexTokenRefresh.ts`, `src/services/api/codexTokenRefresh.test.ts`

- [ ] **Step 1: EP3 — mark in-memory quarantined on transport-failed disk writes.**
  In each EP1 branch that writes `state:'unknown'` to disk (the merged ambiguous/fatal branch from Phase 3 Step 1, the transient-HTTP branch from Step 2, the stale-in-flight branch from Step 3), add right after the `atomicWriteJson`:
  ```ts
  markPoolAccountQuarantined(accountId, /* same human reason string */)
  ```
  Import it from `./codexAccountPool.js`. This is what stops the **running** process from routing to the account without a reload (the EP3 gap). Also in `touchAll`'s per-file `catch` (codexTokenRefresh.ts:647): if the thrown error is a transport class (Phase 3 Step 4's typed error), call `markPoolAccountQuarantined` there too, so a periodic `touchAll` quarantines in-memory even for non-active accounts.
  Invert the Phase 0 Step 2 baseline: after `touchAll()` with a throwing `fetch`, assert `isCodexAccountSwitchable(...) === false` and `status === 'quarantined'`.

- [ ] **Step 2: Re-probe replaces the terminal `unknown` branch (E2).**
  The guard at codexTokenRefresh.ts:267–276 treats `unknown` and `reauth_required` identically (both → `markAccountDead` + throw). **Delete `unknown` from the line-269 condition** so only `reauth_required` stays terminal:
  ```ts
  // reauth_required with matching hash stays terminal (server verdict already rendered).
  if (vault.refresh?.state === 'reauth_required' && vault.refresh.refresh_token_hash === refreshTokenHash) {
    const reason = vault.refresh.reason || 'reauthentication required'
    const displayReason = normalizeCodexAccountBlockReason(reason) ?? reason
    markAccountDead(accountId, displayReason)
    throw new ReauthenticationRequiredError(`Reauthentication required: ${displayReason}`)
  }
  // unknown with matching hash: do NOT condemn. Fall through to the normal
  // intent-write (line 304) + network send (line 325) — i.e. a real re-probe.
  ```
  **Order is already correct:** this block sits *after* the E7 newer-token guard at line 236, so reaching the send means no sibling rotated the token. The send's own outcome (Phase 3 rules) re-adjudicates: 200 → `healthy` (success `appendAccount`; preserveCapped won't trap it per Phase 1 Step 5); 401/403/invalid_grant → `dead`; transport → re-writes `unknown` + re-quarantines (Step 1).

- [ ] **Step 3: Bounded probe scheduler (cadence persisted in vault).**
  Add a timer beside `startPeriodicRefresh` (codexTokenRefresh.ts:675), e.g. `startQuarantineProbe()`:
  - Iterate pool accounts with `status === 'quarantined'` and a `vaultFilePath`.
  - Probe an account only if `now >= vault.refresh.next_probe_at` (a new field you write). On each probe set `next_probe_at = now + backoff`, backoff growing per consecutive failure (5s → 10s → 30s → 60s → cap 300s) and **resetting on success**. Persisting `next_probe_at` in the vault is what bounds the `stale_in_flight` wedged-process loop and prevents N tabs probing at once.
  - `unref()` the timer (mirror line 691) and `registerCleanup` (line 695) so it never keeps the process alive.
  - Start it from `initAccountPool` beside `startPeriodicRefresh` (codexAccountPool.ts:191); starting always and no-op'ing when nothing is quarantined is fine.

- [ ] **Step 4: Tests** (`codexTokenRefresh.test.ts`):
  - `unknown` same-hash re-probe: seed `refresh.state:'unknown'` + matching hash, `fetch` → 200 fresh token → call succeeds, account `healthy`.
  - same but `fetch` → 401 → account `dead`.
  - same but `fetch` throws transport → stays `quarantined`, `refresh.state` stays `unknown`.
  - cross-tab newer-token: vault `tokens.refresh_token` differs from the passed token + `refresh.state:'unknown'` → call returns the vault's newer token and **does not** call `fetch` (assert via a call counter on the stub).
  - cadence: two probe ticks in quick succession with failing `fetch` → second skipped (`next_probe_at` in future); assert `fetch` called once.

---

## Phase 5 — Startup revalidation of persisted `reauth_required` (non-server reasons only)

**Files:** `src/services/api/codexAccountPool.ts` (load decision), `src/services/api/codexTokenRefresh.ts` (probe reuse), `src/services/api/codexAccountPool.test.ts`

- [ ] **Step 1: At load, quarantine-not-dead only the historically-non-server `reauth_required`.**
  Extend Phase 1 Step 4's `loadVaultAccounts` logic. When `refreshState === 'reauth_required'`, inspect `data.refresh.reason`:
  ```ts
  const reauthReason = (data.refresh as { reason?: string } | undefined)?.reason ?? ''
  const isHistoricalNonServerReauth =
    refreshState === 'reauth_required' &&
    (reauthReason === 'network_or_timeout' || reauthReason === 'stale_in_flight')
  ```
  Fold `isHistoricalNonServerReauth` into the `isTransportQuarantine` predicate from Phase 1 Step 4 (so these load `quarantined`). Reasons `identity_mismatch` (codexTokenRefresh.ts:524 writes it deliberately), `http_401`, `http_403`, or any matching `invalid_grant` are genuine server verdicts → keep existing behavior (7-day-rule status), do **not** quarantine, do **not** probe.

- [ ] **Step 2: The probe is just Phase 4's re-probe — no separate machinery.**
  A startup-quarantined account is picked up by `startQuarantineProbe`. Success → `healthy`; server verdict → `dead`; transport → stays `quarantined`. (This is why Phase 4's probe must run on startup, not only on demand.)

- [ ] **Step 3: Tests** (`codexAccountPool.test.ts`, with a temp vault file):
  - `refresh:{state:'reauth_required', reason:'network_or_timeout', refresh_token_hash:H}` → loads `quarantined`; after a successful probe → `healthy`; after a transport-failing probe → stays `quarantined`.
  - `refresh:{state:'reauth_required', reason:'identity_mismatch'}` → **not** quarantined, not probed.
  - `refresh:{state:'reauth_required', reason:'http_401'}` → **not** quarantined.

---

## Phase 6 — UX: copy, non-foreground surfaces, prompt restore (prove-then-fix)

**Files:** `src/services/api/errors.ts`, `src/services/api/client.ts`, `src/codex-core/accounts.ts`, `src/screens/REPL.tsx`, tests

- [ ] **Step 1: Three-way copy in `getAssistantMessageFromError` (errors.ts:927).**
  The lease-exhausted branch always says "usage limit reached." Branch on pool composition (a small helper over `getPoolStatus()` returning `'all_capped' | 'any_quarantined' | 'any_dead'`):
  - any `quarantined` and none usable → `"Can't reach the server right now — retrying automatically. Your account is fine; this is a connection problem."` (`error: 'unknown'`).
  - all blocked are real `capped`/`usage_cap` → keep existing "usage limit reached … switch accounts or wait" (`error: 'rate_limit'`).
  - a blocking account is `dead`/server-revoked → `"Account needs re-authentication (server rejected the token). Run /login. Other accounts are unaffected."`
  Update the Phase 0 Step 4 baseline assertion to the new connectivity copy **deliberately**.

- [ ] **Step 2: EP5 — standalone-core reason-awareness (codex-core/accounts.ts).**
  - The `match.status === 'capped'` branch (line 44) gets a sibling `match.status === 'quarantined'` case that throws a **retryable connectivity** `CodexCoreError` (not `quota`/429).
  - The refresh-failure catch (line 225) currently always wraps as `auth`/401 "Please re-login." Make it reason-aware: underlying `ReauthenticationRequiredError` → keep `auth`/401; otherwise (transport/unknown) → throw a retryable connectivity `CodexCoreError` (non-401), not "re-login."
  - Confirm `src/codex-core/accounts.test.ts` exists; add both cases there (else nearest codex-core test home, noted).

- [ ] **Step 3: EP4 — single-account path consults quarantine (client.ts:234).**
  `resolveCodexOAuthTokensForLeaseOwner` returns `getCodexOAuthTokens()` when `!isPoolActive()`. Guard it:
  ```ts
  if (!isPoolActive()) {
    const sole = getPoolStatus().accounts[0]
    if (sole && !isCodexAccountLeaseSelectable(sole)) return null
    return getCodexOAuthTokens()
  }
  ```
  Import `isCodexAccountLeaseSelectable`. Invert the Phase 0 Step 3 baseline: the single quarantined account now yields `null`, not the config token.

- [ ] **Step 4: Prompt restore (separately keyed) in REPL.tsx.**
  Do **not** widen the existing auto-restore (REPL.tsx:3363, gated on `signal.reason === 'user-cancel'`). Instead, where `onQueryImpl`'s error handling renders the connectivity/no-account assistant message (catch near REPL.tsx:3259), trigger the same `removeLastFromHistory()` + restore-last-user-message sequence under a **new** condition keyed on that outcome, keeping the `inputValueRef.current === ''` and `getCommandQueueLength() === 0` guards so typed/queued input is not clobbered. Ship a test asserting the prompt returns to the input on a simulated no-healthy outcome.
  *(If a REPL-level test is disproportionate, factor the restore decision into a pure helper and unit-test that; note the manual-verification step in the final report.)*

---

## Phase 7 — Full verification

- [ ] **Step 1: Focused suites** (note: `withRetry.test.ts` does **not** exist — its coverage lives in `accountRecoveryDiagnostics.test.ts`):
```bash
cd /Users/pt/cat-code && bun test \
  src/services/api/codexAccountPool.test.ts \
  src/services/api/codexTokenRefresh.test.ts \
  src/services/api/accountRecoveryDiagnostics.test.ts \
  src/services/api/codexAccountLeaseManager.test.ts \
  src/services/api/codexUsage.test.ts \
  src/commands/switch-account/switch-account.test.ts \
  src/codex-core/accounts.test.ts
```
- [ ] **Step 2: Build (type-checks the enum widening across both pools).**
```bash
cd /Users/pt/cat-code && bun run build:dev:full
```
Expected: PASS, prints a `cli-dev` Cat Code version, and **zero** remaining `quarantine Phase N` TODO markers / un-narrowed `quarantined` sites (cross-check against `/tmp/quarantine-fallout.txt` from Phase 1 Step 1).
- [ ] **Step 3: Stale-reference + completeness sweep.**
```bash
cd /Users/pt/cat-code && rg -n "counts.capped === counts.total|capped === counts\['total'\]|preserveCapped|quarantine Phase" src/services/api src/codex-core
```
Confirm: every `capped === total` decision also handles `quarantined`; `preserveCapped` never touches quarantine; no leftover TODO markers.
- [ ] **Step 4: Manual smoke (recommended).** With a dev build, simulate offline (cut the network, or point the `TOKEN_REFRESH_URL` host at a black hole) and confirm: a turn shows the **connectivity** message (not "usage limit reached"), no vault file gains `reauth_required`, the prompt returns to the input, and restoring the network clears quarantine within one probe-backoff window.
- [ ] **Step 5: Report honestly** — Implemented / Verified (exact commands + results) / Not verified. Do not claim full-repo green unless full `bun test` exits 0 in this worktree.

---

## Self-Review

**Spine coverage — all three enforcement points + two gaps:**
- EP1 disk persistence: Phase 3.
- EP2 request-time recovery: Phase 2 (highest impact; hot path).
- EP3 in-memory on live touchAll: Phase 4 Step 1.
- EP4 single-account bypass: Phase 6 Step 3.
- EP5 standalone core: Phase 6 Step 2.

**Why a distinct status (not `capped`+reason):** the four quota-equating sites (preserveCapped, two `countStatuses`/exhaustion-code copies, errors.ts copy, codex-core) become compile-enforced rather than memory-dependent. Phase 1 Step 1 uses the build to enumerate them.

**Quarantine drains (not a one-way trip to stuck):** Phase 1 Step 5 (successful refresh clears via fixed preserveCapped) + Phase 4 (background probe with reset-on-success backoff). A quarantined account is non-selectable but always being retried while connectivity is down.

**Loop/double-spend traps routed around:**
- `stale_in_flight → unknown` infinite loop → bounded by Phase 4 Step 3 persisted cadence.
- Re-probe double-spend → Phase 4 Step 2 keeps it after the E7 newer-token guard.
- N-tabs thundering herd → vault-persisted cadence.

**Deliberately deferred:** the `codexConnectivity` status-line indicator (needs only the `transportClass` field this plan adds; UI is a clean follow-up).

**Known test traps:** the existing `fetch timeout marks token as reauth_required` test encodes the bug and is rewritten (Phase 3 Step 5); `withRetry` may lack a dedicated test file (Phase 0 Step 1 resolves the home); copy assertions are pinned in Phase 0 and changed deliberately in Phase 6.
