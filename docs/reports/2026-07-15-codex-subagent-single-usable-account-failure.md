# Codex subagents fail to converge on the only usable account — 2026-07-15

**Status: FIX IMPLEMENTED · AUTOMATED VERIFICATION GREEN · LIVE REPRO NOT RUN.** Five subagents spawned successfully, but four initially received leases for accounts whose access tokens had been invalidated. The Codex backend reported those failures through `x-openai-authorization-error: 401` and `x-openai-ide-error-code: token_invalidated`. Cat Code failed to classify those responses as authentication failures, treated them as transient connection failures, and left the invalid accounts selectable. The adapter now recognizes direct and proxy-wrapped header auth failures, and the retry boundary preserves that classification through the Anthropic SDK wrapper so the existing account-bound recovery path runs.

## Executive conclusion

The root cause was in the Codex HTTP error boundary: `classifyCodexHttpAccountError()` examined the outer HTTP status and response body, but not the authoritative upstream authorization headers. When a proxy wrapped the upstream `401` in another status and the body did not independently identify revoked authentication, the HTTP fallback converted the response into `APIConnectionError`.

The implementation review exposed a second load-bearing boundary: the Anthropic SDK catches exceptions thrown by its custom `fetch` implementation and wraps them in `APIConnectionError.cause`. Header classification in the adapter was therefore necessary but insufficient by itself; `withRetry()` also had to recover the recognized account error from that wrapper before choosing an auth, cap, or transient-connection path.

That wrong type bypasses the existing forced-refresh, dead-mark, and authentication-failover path. The connection-failover path rotates the worker lease without making the invalid account globally non-selectable. Under the default `spread` strategy, lease balancing then repeatedly favors the supposedly less-crowded invalid accounts over the working account.

This is not a failure to spawn subagents, not a limitation of using an account whose alias is not `main`, and not evidence of a real network outage. With one genuinely usable account, all worker leases should be allowed to share it and eventually converge on it.

## Scope and evidence

| Item | Value |
|---|---|
| Parent session | `132aa9f7-4749-45f0-821a-c77d69aaf199` |
| Session transcript | `/Users/pt/.cat-code/projects/-Users-pt-cat-code/132aa9f7-4749-45f0-821a-c77d69aaf199.jsonl` |
| Debug log | `/Users/pt/.cat-code/debug/132aa9f7-4749-45f0-821a-c77d69aaf199.txt` |
| Runtime model | `gpt-5.6-sol` |
| Runtime build source | `3e7aa4ee` as printed in debug attribution metadata |
| Current branch during investigation | `migration` |
| Relevant source drift check | `git diff 3e7aa4ee..HEAD -- src/services/api/{codex-fetch-adapter.ts,withRetry.ts,codexAccountLeaseManager.ts}` produced no diff |

The transcript is the authority for worker lifecycle. The debug log is the authority for request routing, backend response headers, and account IDs. Current source was checked only after confirming that the three relevant files had not changed from the runtime build.

## Expected behavior

Given three persisted accounts but only one account that can successfully serve a request:

1. A worker may initially receive any account still believed healthy.
2. A `401 token_invalidated` response must enter authentication recovery.
3. Cat Code must force-refresh the specific account that made the failed request.
4. If refresh cannot recover it, that account must become non-selectable.
5. The affected worker must retry on another selectable account.
6. After all unusable accounts have been classified, every worker may share the sole remaining usable account.

No exclusivity rule prevents multiple worker leases from using one account. Reduced account diversity may affect throughput or quota consumption, but it must not make worker execution impossible.

## Observed behavior

### Pool state at startup

The runtime loaded five vault profiles:

| Alias | Account prefix | Startup state | Live request state |
|---|---|---:|---|
| `onbi` | `14f2f119` | healthy | usable |
| `main` | `ca889574` | healthy | `401 token_invalidated` |
| `bluesky` | `93ce612e` | healthy | `401 token_invalidated` |
| `hiby` | `9ed41939` | dead | unusable |
| `yoxrent2` | `66608311` | dead | unusable |

Evidence: debug log lines 2–7. The startup `healthy` label was persisted/local pool state, not proof that a live request would succeed.

The main thread was using `onbi`, despite a different saved account having the literal alias `main`. The status line identifies `onbi` at debug line 899. The main request on `14f2f119` succeeded at lines 945–957.

### All five subagents spawned

The five `Agent` tool calls returned successfully, and the transcript recorded five `subagent-spawned` lifecycle events at lines 90–94:

| Worker | Agent ID | Assignment |
|---|---|---|
| Kepler | `a6633bce2464a2451` | eval harness defects |
| Lovelace | `ae9732111de0bbf1d` | account switcher defects |
| Ramanujan | `a3e7762a533ea0f86` | sidebar boundary defects |
| Darwin | `a1d2d6692002039de` | slash catalog defects |
| Faraday | `a5696e891154a673b` | agent map portability |

Therefore, “subagents could not spawn” is not the correct failure description. They spawned, then some failed during their first or subsequent model requests.

### Initial worker account distribution

The connection-failover records establish the starting account for four workers:

- Ramanujan: `bluesky` → `onbi` at debug line 1009.
- Lovelace: `main` → `bluesky` at line 1012.
- Kepler: `bluesky` → `main` at line 1015.
- Darwin: `main` → `bluesky` at line 1018.

Faraday's first completed request was on `onbi` and no earlier reassignment is recorded. This makes its initial `onbi` lease a high-confidence inference rather than a directly logged lease-registration fact.

This distribution matches the configured/default subagent `spread` behavior. It did not inherit or prefer the main thread's working account.

### Backend authentication signal

The invalid accounts' HTTP responses contained:

```text
x-openai-authorization-error=401
x-openai-ide-error-code=token_invalidated
```

Evidence: debug lines 991–998 and subsequent repeated route-header records.

Cat Code reported each as:

```text
API error (attempt N/6): undefined Connection error.
```

It then logged lease reassignment “on connection error,” beginning at lines 1009–1018.

After two distinct invalid accounts produced the same wrongly typed error, the retry layer activated its network-outage heuristic:

```text
Suspected network outage after 2 accounts failed with connection errors
```

Evidence: debug lines 1052, 1063, and 1066.

This diagnosis was false. A request using `onbi` succeeded immediately afterward. Its response reported a valid Plus account with 1% primary-window usage at lines 1067–1070.

### Worker outcomes

| Worker | Outcome | Evidence |
|---|---|---|
| Faraday | completed | transcript terminal event line 300 |
| Darwin | killed at user request after progressing on `onbi` | line 307; successful `onbi` request records include debug line 1278 onward |
| Ramanujan | killed at user request after progressing on `onbi` | line 312; successful `onbi` request records begin at debug line 1102 |
| Lovelace | failed, resumed, failed again with misleading connection error | transcript terminal events lines 114 and 165 |
| Kepler | failed, resumed, failed again with misleading connection error | transcript terminal events lines 117 and 177 |

The successful workers prove that subagents could operate through the same account as the main thread. The failed workers prove that failover did not reliably converge on it before retry exhaustion.

## Root cause

### Root defect: header-blind HTTP authentication classification

Before the fix, `classifyCodexHttpAccountError()` received only:

```ts
status: number
body: string
accountId: string
```

It recognized a Codex authentication failure only when the response body contained a recognized structured auth code or matching text.

The live response's authoritative `token_invalidated` signal was in `x-openai-ide-error-code`, and the body did not satisfy those checks. The adapter therefore returned no account classification.

In the HTTP fallback path that was active after WebSocket connection failure, an unclassified non-OK response became `APIConnectionError`.

There is a second HTTP response path with the same classifier. Both paths require the same header-aware account classification.

### Correct recovery path was bypassed

The existing `CodexAccountAuthError` branch in `withRetry()`:

1. Bound recovery to the account that actually made the failed request.
2. Forced `maybeRefreshAccount()` past the local expiry gate.
3. Published recovered credentials if refresh succeeded.
4. Marked definitive authentication failures dead if refresh failed.
5. Failed over the affected lease without condemning a concurrently moved healthy lease.

The adapter originally produced no typed account error. After the first implementation added one, the Anthropic SDK wrapped it in top-level `APIConnectionError`, so `withRetry()` still missed this branch and entered transient connection handling. The completed fix addresses both boundaries.

That path intentionally does not mark accounts dead or capped. This is correct for genuine transport failures but incorrect for an explicit backend authentication rejection.

## Secondary amplifier: spread ranking retained invalid candidates

Subagent leases default to `spread` unless `codexSubagentAccountStrategy` overrides it:

- `src/services/api/codexAccountLeaseManager.ts:593-598`

Connection failover invokes `failoverCodexLease(..., { markAccountCapped: false })`. That records a recent error and excludes the current account from the immediate replacement selection, but leaves the account globally selectable:

- `src/services/api/codexAccountLeaseManager.ts:298-350`

Candidate ranking compares live lease count before recent-error cooldown:

- `src/services/api/codexAccountLeaseManager.ts:497-525`

Once successful workers accumulated on `onbi`, invalid accounts with fewer live leases could outrank the crowded working account. Workers therefore bounced between `main` and `bluesky`, consumed retry attempts, and triggered the network-outage heuristic.

This ranking behavior amplified the incident, but it is not the root defect. Once explicit authentication failures correctly mark unrecoverable accounts non-selectable, those accounts never reach spread ranking.

## Non-causes and rejected fixes

### Not caused by the usable account alias being different from `main`

“Main agent” and the saved alias `main` are unrelated concepts. The main thread was using alias `onbi`; alias `main` was one of the invalid accounts. Account aliases do not grant special routing authority.

### Not an Agent tool spawn failure

Every `Agent` call succeeded and emitted a worker lifecycle record. The failures occurred in worker model requests after spawn.

### Not account exhaustion

No hard 429 or quota-exhaustion path caused these worker failures. The working `onbi` response showed 1% primary-window usage. The terminal message was a connection error because of misclassification, not a quota diagnostic.

### Not a real network outage

The backend returned structured authorization headers, and requests through `onbi` succeeded during the same interval. WebSocket availability was imperfect and caused HTTP fallback, but the terminal worker failures came from invalid account credentials, not loss of general connectivity.

### `follow-main` is a workaround, not the root fix

Changing subagents to `follow-main` would have routed these workers to `onbi` in this session, but it would hide invalid accounts rather than classify them. It would also sacrifice intentional multi-account spreading when several accounts are genuinely usable. The pool must remain correct under `spread`.

## Implemented fix

The HTTP account-error classifier now inspects response headers in addition to status and body.

It derives the authentication status from a direct outer `401`/`403` or from:

```text
x-openai-authorization-error: 401
```

It then requires a recognized authoritative error code such as:

```text
x-openai-ide-error-code: token_invalidated
```

before producing:

```ts
new CodexAccountAuthError(accountId, status)
```

The recognized header vocabulary remains closed and aligned with the existing body/WebSocket auth codes:

- `token_invalidated`
- `token_expired`
- `token_revoked`
- `invalid_token`

Both HTTP non-OK paths pass their response headers through the shared classifier. Partial header combinations and unknown IDE error codes remain ordinary HTTP/backend failures rather than account authentication failures.

The adapter performs classification only. At the retry boundary, `withRetry()` unwraps only an immediate `CodexAccountAuthError` or `CodexAccountCapError` cause from the SDK's `APIConnectionError`; unrelated connection causes remain connection errors. The existing account-error branches remain the sole owners of refresh, dead/capped state, and lease failover.

## Verification coverage

`src/services/api/codex-fetch-adapter.test.ts` now covers:

- an outer `502` carrying upstream authorization `401` plus `token_invalidated`;
- a direct `403` carrying `token_revoked`;
- the direct HTTP non-OK path;
- the deferred WebSocket-to-HTTP fallback path;
- account ID and auth status preservation;
- incomplete header pairs and unknown IDE error codes remaining unclassified.

`src/services/api/accountRecoveryDiagnostics.test.ts` now crosses the real mocked runtime seam:

```text
createCodexFetch
→ Anthropic SDK
→ APIConnectionError.cause
→ withRetry
→ forced refresh / dead mark / lease failover
```

It verifies that a header-only invalidation is still bound to the failed request account after SDK wrapping, forces refresh, marks the unrecoverable account dead, moves the subagent lease to the usable account, succeeds on retry, and emits neither quota exhaustion nor transient-connection diagnostics. It also covers an SDK-wrapped `CodexAccountCapError`.

`src/services/api/codexAccountLeaseManager.test.ts` verifies the existing lease selection, dead-account exclusion, and single-account behavior that the recovery path relies on.

No fresh-process live reproduction was run against the user's real account pool. That would exercise credentials and consume subscription usage; automated boundary and recovery tests are the completion gate for this fix.

## Acceptance criteria

The automated fix bar is satisfied:

- Header-only `401 token_invalidated` is typed as `CodexAccountAuthError`.
- The failed request's account, not merely the lease's current account, is refreshed or dead-marked.
- Dead accounts are no longer candidates for new or failed-over leases.
- Multiple subagents can share the sole remaining usable account.
- No false network-outage event is emitted for explicit auth rejections.
- Existing body-based HTTP and WebSocket auth classification remains green.
- Existing genuine connection-error behavior remains transient and does not dead-mark accounts.
- Focused adapter, account-recovery, lease-manager, and retry tests pass.
- `bun run build:dev:full` passes.

Actual results:

- `bun test src/services/api/codex-fetch-adapter.test.ts` — 66 pass / 0 fail.
- `bun test src/services/api/accountRecoveryDiagnostics.test.ts` — 13 pass / 0 fail.
- `bun test src/services/api/codexAccountLeaseManager.test.ts` — 49 pass / 0 fail.
- `bun test src/services/api/codex-websocket-transport.test.ts src/services/api/codex-continuation-e2e.test.ts` — 36 pass / 0 fail.
- `bun run build:dev:full` — passed; `cli-dev` built and printed `2.1.87-dev.20260715.t153947.shae48bac50`.

## Final assessment

**Confirmed root cause:** header-only Codex authentication rejection was converted to a connection error at the HTTP adapter boundary.

**Secondary effect:** spread lease ranking continued selecting the invalid accounts because connection failures leave accounts selectable.

**Implemented resolution:** HTTP authentication classification is header-aware, recognized account errors survive the SDK wrapper at the retry boundary, and the existing recovery path owns refresh, dead marking, and failover. Subagents remain on the `spread` strategy; no alias pinning or lease-ranking workaround was added.
