# Codex `token_invalidated` bypasses account recovery — root cause + fix design

Date: 2026-07-10
Status: **REVISED after adversarial review (RED).** Scope reduced. See
`docs/reports/2026-07-10-codex-token-invalidated-recovery-adversarial-review.md`.
Fix 0 stands (with corrections F1/F2); Fixes A and B are **deferred** until a
process-identified reproduction proves them necessary. Root-cause section below
survived review; the original Fix A/B design did not and must not be implemented.
Area: engine (`src/services/api/`, `src/codex-core/`) — Codex account pool.

## Review outcome (what changed)

An adversarial review returned RED. Findings verified directly in source before
acceptance:

- **F1 (High, verified):** post-401 recovery binds to the *lease's current*
  account, not the account that made the failed request —
  `withRetry.ts:595` `currentLease?.accountId ?? error.accountId`. After lease
  movement a delayed 401 refreshes/dead-marks the wrong account. Pre-existing;
  Fix 0 makes it more reachable, so it must be fixed *with* Fix 0.
- **F2 (High, verified):** the only `CodexAccountAuthError` construction is the
  HTTP classifier (`codex-fetch-adapter.ts:358`); the `response.failed` path
  only produces `CodexAccountCapError` (`:424`), no auth branch. Fix 0 scoped to
  HTTP is incomplete — classification must be centralized across HTTP,
  `response.failed`, and WebSocket error events.
- **F5 (High, verified):** `appendAccount` resets any non-`capped` status
  (`dead`/`reauth_required`/`quarantined`) to `healthy` and wipes the reason
  (`codexAccountPool.ts` — `preserveCapped` only guards `capped`). The old Fix A
  inventory-reconcile would revive genuinely-dead accounts. Do not do this.
- **F3/F4/F6/F7/F8 (accepted):** the "pooled account with no in-memory refresh
  token" premise is not constructible via normal loaders; there is no
  inventory-wide lock/single-flight (only per-refresh); "no failover" was
  overbroad (one path becomes `APIConnectionError` → generic connection
  failover); Fix B changes intentional spread semantics with no post-Fix-0
  failing case (existing auth failover already excludes the failed account); and
  the secondary causal chain lacks a process-identified reproduction.

## TL;DR

A Codex 401 whose OpenAI error code is `token_invalidated` is **not recognized**
by the account-error classifier, so it is never turned into a
`CodexAccountAuthError`. Because the entire post-401 recovery/failover machinery
in `withRetry` is gated on `error instanceof CodexAccountAuthError`
(`withRetry.ts:591`), a `token_invalidated` response **bypasses forced refresh,
vault recovery, and lease failover** and hard-fails the request. This is the
proximate root cause of both observed symptoms.

The fix is **bounded and additive — not a redesign.** The primary fix is a
classifier gap (one function, mirroring the existing cap-path's structured-code
matching). Two secondary fixes complete the recovery/routing story. No locked
decision changes; every primitive the fix needs already exists.

## Symptoms observed

1. `Explore` / `Agent` subagent fails to start:
   `Tool execution failed` — "its separate worker received a 401
   token_invalidated" (session main loop was GPT/Codex and working).
2. `Agent @Backus failed: Please run /login · API Error: 401 … "code":
   "token_invalidated" … "Your authentication token has been invalidated."`
   User note: session was created **before** a `/login`; the agent spawned
   **after**. At least one account (`main`) is live.

Both occur while the main GPT loop keeps working.

## Root-cause chain (all verified in source)

### Proximate cause — the auth-error classifier misses `token_invalidated`

`codex-fetch-adapter.ts`:

- `classifyCodexHttpAccountError(status, body, accountId)` (:349) maps an HTTP
  error to `CodexAccountCapError` / `CodexAccountAuthError` / `null`.
- Auth detection is `codexErrorTextIndicatesRevokedAuth(status, body)` (:329),
  a **substring match** over the body text: `unauthorized`, `unauthenticated`,
  `authentication failed`, `token_revoked`, `oauth token has been revoked`,
  `invalid_grant`, `invalid token`, `expired token`.

The actual error:

```json
{ "error": { "message": "Your authentication token has been invalidated. Please try signing in again.",
             "type": "invalid_request_error", "code": "token_invalidated", "param": null },
  "status": 401 }
```

`token_invalidated` matches **none** of the patterns (`token_revoked` ≠
`token_invalidated`; the message contains "invalidated", not the substring
"invalid token"). So `classifyCodexHttpAccountError` returns `null`.

Consequence: the 401 is a generic error, not a `CodexAccountAuthError`, so
`withRetry`'s auth-recovery branch — `if (error instanceof
CodexAccountAuthError)` (`withRetry.ts:591`) — is **never entered**. No forced
refresh, no vault recovery, no lease failover. The raw 401 surfaces as the
hard failure the user saw.

Note the asymmetry inside the same file: the **cap** path already matches the
**structured** `error.code` against a set — `extractCodexResponseFailure` (:363)
+ `codexResponseFailureIndicatesAccountCap` + `CODEX_ACCOUNT_LIMIT_ERROR_CODES`.
The auth path was left on fragile substring matching. That asymmetry is the bug.

### Contributing cause A — recovery is scoped to the leased account + gated on an in-memory refresh token

Even once a 401 *is* classified as auth, recovery is narrow
(`withRetry.ts:604`):

```js
if (poolManagesCredentials() && currentAccount?.refreshToken) {
  // forced maybeRefreshAccount(..., {force:true}) → refreshAccountTokens
  //   → re-reads THIS account's vault entry, adopts a newer refresh_token
}
```

- The forced refresh re-reads the vault entry for the **leased account only**
  (`refreshAccountTokens` → `readVault(vaultFilePath)` → adopt-newer,
  `codexTokenRefresh.ts:439-456`). A `/login` on a **different** account leaves
  the leased account's entry unchanged → recovery finds nothing → mark dead +
  failover (`withRetry.ts:665-682`). This is `@Backus`: spread leased it to a
  non-main account; the user logged into `main`.
- The whole block is **skipped** when the in-memory account has no
  `refreshToken` (`&& currentAccount?.refreshToken`). A session created before
  login can hold such an entry → `refreshFailure` stays `undefined` → the `else`
  marks the account **dead without ever re-reading the vault**
  (`withRetry.ts:665-682`), even though the vault now has fresh post-login
  credentials.

### Contributing cause B — `spread` routes subagents onto stale-health accounts

Subagents resolve tokens under a distinct `'subagent'` lease
(`claude.ts:1918-1919, 2747, 2858` set `codexLeaseOwnerType:'subagent'`), which
defaults to the `spread` strategy (`settings/types.ts:333-337`, default
"spread"; `resolveDefaultLeaseStrategy`). `spread` penalizes the main account in
selection ranking (`codexAccountLeaseManager.ts:509-517`), so a subagent is
steered onto a non-main account. Account health at selection time is judged from
in-memory pool state (`isCodexAccountSwitchable` / `availability.kind ===
'available'`), which still reads "available" for an account whose token is
actually dead until a real call exercises it. So `spread` hands the subagent a
dead-but-healthy-looking account, whose first call returns `token_invalidated`.

### Why it presents as "main works, subagent fails" / "session predates login"

`token_invalidated` is the server-side signal that a token was superseded (e.g.
a `/login` elsewhere invalidates the old token). The main loop is pinned to the
live `main` account and never emits it. Subagents get `spread` onto a stale
account, emit `token_invalidated`, and — because of the classifier gap — get
none of the recovery that would otherwise re-read the vault and fail over to
`main`.

## Minimal defensible design (the only scope to implement now)

Adopted from the adversarial review. Two changes, shipped together with race
tests. Nothing else.

### Step 1 — centralize structured auth classification

Match the **structured `error.code`** against an auth-code set (mirroring the
cap path's `CODEX_ACCOUNT_LIMIT_ERROR_CODES`), and apply it uniformly across
**all three** Codex error surfaces, not just HTTP:

- HTTP errors — `classifyCodexHttpAccountError` (`codex-fetch-adapter.ts:349`),
  both call sites (`:3227`, `:3340`).
- Streaming `response.failed` — currently only classifies caps
  (`codexResponseFailureIndicatesAccountCap`, `:390`; produces
  `CodexAccountCapError` at `:424`); add the auth analog so it can produce
  `CodexAccountAuthError`.
- WebSocket error events — confirm and route through the same classifier.

Include `token_invalidated` in the auth-code set (candidates to verify against
OpenAI's current taxonomy: `token_expired`, `invalid_token`). Keep the existing
text heuristics as a fallback, but structured-code match is authoritative.

Effect: `token_invalidated` on any transport → `CodexAccountAuthError` →
`withRetry.ts:591` entered → existing forced-refresh + vault-recovery + lease
failover run. Once classified, the *existing* failover already excludes the
failed account, so a healthy account (incl. `main`) is reached without any
routing change.

### Step 2 — bind recovery to the account that made the failed request (fixes F1)

In the auth-recovery branch (`withRetry.ts:591-682`):

- Drive recovery from **`error.accountId`** and the credential generation that
  actually made the request — not `currentLease?.accountId`.
- Mutate a lease **only if it still points to the failed account.** If the lease
  has moved, do not refresh/dead-mark the account it now points to.

This closes the account-movement race that Step 1 would otherwise make more
frequent.

### Deferred — do NOT implement without a process-identified reproduction

- **Inventory reconciliation (old Fix A):** premise ("pooled account with no
  in-memory refresh token") not constructible via normal loaders (F3); no
  inventory-wide lock exists (F4); `appendAccount` would revive dead/reauth
  accounts (F5). For the constructible cross-process case, the leased account
  still holds a (stale) in-memory refresh token, so the *existing* forced-refresh
  → `refreshAccountTokens` vault-recovery already heals it once Step 1 classifies
  the error. Reconciliation buys nothing proven and carries real revival hazard.
- **Spread ranking change (old Fix B):** existing auth failover already excludes
  the failed account (F7); no post-Step-1 failing case exists. Changing
  intentional spread semantics is unjustified until a repro shows failover cannot
  reach a live account.
- **`codexSubagentAccountStrategy: "follow-main"` config lever:** acceptable as a
  temporary operator mitigation, but it only *masks* the classifier gap and is
  not part of the fix.

## Invariants / locked decisions touched

| Step | Touches | Why it is safe |
|---|---|---|
| 1 | Error classification only | Additive structured-code matching; mirrors the existing cap-code set across all three surfaces. No credential, lock, or lifetime change. |
| 2 | Recovery/lease targeting in `withRetry` | Narrows an existing action to the correct account; removes a wrong-account mutation. No new inbound surface, no protocol/schema change, no new lock. |

Corrections to the original doc's claims (per review): there is **no**
inventory-wide lock/single-flight to lean on (F4); `appendAccount` is **not**
status-preserving except for `capped` (F5); "no failover at all" was overbroad
(F6). The N-process model and steady-state read cadence are untouched — this is
classification + correct targeting, not a recovery-architecture change.

## Test plan (failing-first)

1. **Classifier (proximate-cause proof):** `token_invalidated` body → expect
   `CodexAccountAuthError` on each of HTTP, `response.failed`, and WebSocket
   surfaces. Fails before, passes after.
2. **Account-movement race (F1):** lease moves off the request account before a
   delayed 401 arrives → recovery must refresh/dead-mark **`error.accountId`**,
   not the lease's new account; lease mutated only if still on the failed account.
3. **Token-rotation:** classified `token_invalidated` with a newer refresh token
   in the *same* account's vault entry → existing forced refresh recovers, retry
   succeeds (no hard fail).
4. **Transport parity:** the same `token_invalidated` delivered via HTTP vs
   `response.failed` vs WebSocket all classify identically.
5. **Visible-output replay:** a `token_invalidated` after visible output emitted
   must not corrupt WebSocket session/baseline handling (guard the
   `emittedVisibleOutput` interaction).

## Evidence still required before touching the secondary chain (F8)

A process-identified reproduction: session ID, PID boundary (same-process vs
cross-process login), the account actually selected, the transport, and the pool
snapshot at failure — plus an authoritative basis for reading `token_invalidated`
as login supersession. Until then, the spread/staleness chain stays a hypothesis
and the deferred fixes stay deferred.

## Verification battery (per CLAUDE.md §3, engine)

Reduced scope → touched files are `codex-fetch-adapter.ts` and `withRetry.ts`
only (`codexAccountPool`/`codexAccountLeaseManager` are NOT touched — Fix A/B
deferred).

- `bun test` on the touched suites: `codex-fetch-adapter`, `withRetry`,
  `accountRecoveryDiagnostics`, `codexTokenRefresh` (file-isolated — Codex suites
  only pass isolated).
- `bun run build:dev:full` green.
- Stale-reference sweep for the auth-code set + any docs citing the classifier.
