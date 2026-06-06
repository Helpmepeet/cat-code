# Logging Review — Codex Accounts, Leasing & Rotation

## Summary

The Codex account domain has rich, well-structured debug logging (`[codex-pool]`,
`[codex-profile]`, `[codex-usage]`, `[codex-cache]` prefixes) covering pool load,
manual switch profile-change, token refresh, identity-mismatch, vault load, dead-marking,
and per-request routing. However, the most diagnostically important *terminal* and
*state-mutating* transitions are routed exclusively through `emitAccountDiagnostic`, which
is a **silent no-op in an interactive REPL** (it only emits to a stream-json SDK sink or, with
`allowStderrFallback`, to stderr — neither is present in normal `cat` REPL usage). That means
in production (non-ant, debug OFF) a regression of exactly the bugs these features fixed —
"all accounts capped / failover didn't happen", "stale lease after switch", "account capped
via subagent path", "lease points at a deleted account" — leaves **no signal in the debug log**.
The fix in every case is to add a narrow `[codex-account]` always-log line (mirroring the
existing `[codex-cache]` ALWAYS_LOG_PREFIXES pattern) at the terminal/critical transition,
keeping the diagnostic emit as-is for SDK consumers. Account IDs are already truncated/redacted
elsewhere; reuse `truncId()` / `.slice(0, 12)` to keep these lines safe to ship.

A new prefix `[codex-account]` should be added to `ALWAYS_LOG_PREFIXES` in
`src/utils/debug.ts:110`. Use it ONLY for the terminal/critical transitions below — not for
the high-frequency per-request or selection logs, which are correctly debug-gated.

## Findings

### Gap 1 — Pool/lease exhaustion is production-silent (features #4, #30, #39, #66)
- **File:** `src/services/api/withRetry.ts:349-357` (`throwRetryExhausted`), also reached from
  `:534`, `:572`, `:687` and the lease-budget guard `:366`.
- **Current state:** On terminal failover failure ("no healthy Codex account remained after
  usage cap failover", failover-budget exceeded, retry chain exhausted) the only structured
  signal is `emitCodexDiagnostic({ code: 'account.retry.exhausted' / 'quota.exhausted' / ... })`.
  In a REPL there is no diagnostic sink, so nothing is written. The generic `API error (attempt …)`
  line at `:490` is `level: 'error'` but still debug-gated for non-ants.
- **Recommended change:** In `throwRetryExhausted`, immediately before the `emitCodexDiagnostic`
  call, add:
  ```ts
  logForDebugging(
    `[codex-account] retry exhausted account=${accountRef ?? '?'} attempts=${attemptCount} ` +
    `code=${/* exhaustion code */} reason=${errorMessage(originalError)}`,
    { level: 'error' },
  )
  ```
  (prefix `[codex-account]` → always-log). Same prefix is not needed at the per-call sites since
  they all funnel through `throwRetryExhausted`.
- **Rationale:** "Failover didn't happen / all accounts capped" is the #1 user-visible failure of
  this subsystem (#39, #66) and currently produces zero durable diagnostic signal in production.

### Gap 2 — Account capping via the lease/subagent path is production-silent (features #30, #31, #39)
- **File:** `src/services/api/codexAccountPool.ts:406-451` (`markPoolAccountStatus` /
  `markPoolAccountCapped`).
- **Current state:** These mutate `acct.status = 'capped'` and reroll the active index, but log
  only via `emitUsageStatusDiagnostic` + `emitActiveRerollDiagnostic` (both diagnostic-only/silent
  in REPL). Compare `rotateOnFailure` (`:277`) and `markAccountDead` (`:589`), which DO call
  `logForDebugging`. The lease failover path (`failoverCodexLease` → `markPoolAccountCapped`) and
  any classifier-driven cap therefore leave no debug trace.
- **Recommended change:** In `markPoolAccountStatus`, after `acct.status = status`, add a
  transition log gated on actual change:
  ```ts
  if (previousStatus !== status) {
    logForDebugging(
      `[codex-account] ${truncId(accountId)} ${previousStatus}->${status}` +
      (reason ? ` reason=${reason}` : ''),
      { level: status === 'healthy' ? 'debug' : 'warn' },
    )
  }
  ```
  (prefix `[codex-account]` → always-log). This subsumes the cap/uncap case and the
  cap-via-lease case in one place.
- **Rationale:** "Account shows capped / usage unavailable" and "wrong account used after a cap"
  must be diagnosable; today the cap transition that drives the status line is invisible unless it
  happened to go through `rotateOnFailure`.

### Gap 3 — `reassignCodexLeasesToActiveAccount` (the stale-lease-after-switch fix) has no log (features #10, #11, #66)
- **File:** `src/services/api/codexAccountLeaseManager.ts:214-251`
  (`reassignCodexLeaseToActiveAccount` / `reassignCodexLeasesToActiveAccount`).
- **Current state:** No logging at all. This is the exact code that fixes "stale active account
  after switch+clear" (#11) and "lease stays on old account after /switch-account" (#10). A
  regression (e.g. the no-op early-return at `:221` firing incorrectly, or the main-thread lease
  not being found) would be silent; the caller `switch-account.ts:138` also only emits a
  diagnostic.
- **Recommended change:** In `reassignCodexLeaseToActiveAccount`, on the branch that actually
  rewrites the lease (after the early-returns, before/after the `codexLeasesByOwnerId.set`), add:
  ```ts
  logForDebugging(
    `[codex-account] lease ${ownerId} reassigned ${truncId(existing.accountId)}->${truncId(account.accountId)} (switch-account)`,
  )
  ```
  Use a local `truncId` or `.slice(0, 12)` to match the pool file. `[codex-account]` always-log.
- **Rationale:** This is the precise transition the #10/#11/#66 fixes guard; "did the lease
  actually move to the new account?" is unanswerable in production logs today.

### Gap 4 — Orphaned-lease silent fallback in request routing (features #30, #31, #66)
- **File:** `src/services/api/codex-fetch-adapter.ts:2696-2707` (`getPoolAccountForCurrentLease`)
  consumed at `:2738-2742`.
- **Current state:** When a lease's `accountId` is no longer present in the pool (deleted/repaired
  account, identity reconcile race), `find(...) ?? null` returns null and the caller silently
  falls back to the ambient `accessToken` (`:2741`) — i.e. routes the request to a *different*
  account than the lease claims, with no log. This is the "wrong account used" failure class.
- **Recommended change:** In `getPoolAccountForCurrentLease`, on the null branch (lease present
  but account not found), add:
  ```ts
  logForDebugging(
    `[codex-account] lease ${currentLease.ownerId} references missing account ` +
    `${currentLease.accountId.slice(0, 12)}; falling back to ambient token`,
    { level: 'warn' },
  )
  ```
  `[codex-account]` always-log.
- **Rationale:** Directly diagnoses "wrong account used" and "lease not released/repaired" — the
  request goes out on an unexpected identity and today nothing records it.

## Already adequate (no change recommended)
- **Token refresh / identity reconciliation (#9, #51, #66):**
  `codexTokenRefresh.ts` logs `[codex-profile] refresh-start`, `identity-mismatch`,
  and `markAccountDead` reasons on every refresh outcome — strong coverage. Keep as-is
  (these are debug-gated but the volume + ant `/share` capture is appropriate; the identity
  *mismatch* line at `:181` could optionally adopt `[codex-account]` always-log, but it is
  paired with a `markAccountDead` that already logs, so it is borderline rather than a gap).
- **Manual switch profile-change (#10, #66):** `codexAccountPool.ts:545-555` logs the
  `active-profile-change` (including no-op) at debug. Adequate for the pool side; the lease side
  is Gap 3.
- **Per-request routing & cache (#31):** `[codex-cache] request account=… conv=…`
  (`codex-fetch-adapter.ts:2769`) already uses the always-log prefix and captures the routed
  account per request — excellent for "wrong account used" *when the account resolves*. Gap 4
  covers only the unresolved-lease branch.
- **Vault load / alias / append / remove (#4, #6):** all paths in `codexAccountPool.ts` carry
  `[codex-profile]` / `[codex-pool]` debug lines (load, skip-locked, mismatch warn, rename,
  add/update memory, remove). Adequate.
- **Near-cap usage warning (#51):** `codexUsage.ts:376-417` correctly gates the warning behind
  `hasAccountDiagnosticSink()` — it is purely an SDK/Open-Design product signal, not a debug
  diagnostic, so its REPL silence is by design. No change.
