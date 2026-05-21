# Network recovery stuck — session can't reconnect without exit + /resume

- **Session:** `6a349888-4d8d-4fae-bc79-e470c2860e02`
- **Log:** `/Users/pt/.cat-code/debug/6a349888-4d8d-4fae-bc79-e470c2860e02.txt`
- **Date observed:** 2026-05-20
- **Severity:** medium — workaround exists (`/resume`), but loses in-process state and surprises long-running sessions

## Symptom

User left the agent running, lost network connectivity, then came back. After the network was restored the agent still refused to connect — every submitted prompt returned `Connection error` immediately. The only way to recover was to exit `cat-code` and run `/resume` (which starts a fresh process binding to the same session id).

## Evidence from the log

Process A pid `26801` ran from `05:50:51` until the user exited around `06:30:57`. Process B pid `65671` started at `06:31:10` (same session id, fresh process) and succeeded on the first request.

User submits during the unreachable window (each `length=8` is likely the word `continue`):

| Line | Time | Pid | Result |
|---|---|---|---|
| 12024 | 06:24:45 | 26801 | 6/6 connection errors |
| 12457 | 06:25:16 | 26801 | 6/6 connection errors |
| 12825 | 06:26:02 | 26801 | 6/6 connection errors |
| 13223 | 06:26:22 | 26801 | 6/6 connection errors |
| 13641 | 06:26:40 | 26801 | 6/6 connection errors |
| 14234 | 06:30:54 | 26801 | 6/6 connection errors |
| 14672 | 06:31:11 | 65671 | succeeds *(after exit + /resume)* |

Each 6-attempt burst completes in roughly **800 ms**:

```
06:19:51.883 attempt 1/6
06:19:52.426 attempt 2/6 — Reassigned lease 2766fbb9 → 9ed41939
06:19:52.516 attempt 3/6 — Reassigned lease 9ed41939 → ca889574
06:19:52.579 attempt 4/6 — Reassigned lease ca889574 → 2766fbb9
06:19:52.642 attempt 5/6 — Reassigned lease 2766fbb9 → 9ed41939
06:19:52.709 attempt 6/6 — Reassigned lease 9ed41939 → ca889574
```

Attempt 1→2 takes ~540 ms (the standard `getRetryDelay` backoff applies on the *first* failure), but attempts 2→6 fire at 60–90 ms intervals with no `sleep` / `tengu_api_retry` event between them — the codex failover `continue` skips the backoff path entirely after that.

## Root cause

`src/services/api/withRetry.ts:599–674` — the "Codex connection-error failover" branch (the two `continue` statements are at lines 636 and 662):

```ts
if (
  error instanceof APIConnectionError &&
  options.isCodexRequest === true &&
  isPoolActive() &&
  attempt >= 2
) {
  // … rotate lease to next pooled account …
  options.onCodexAccountSwitch?.()
  client = null
  continue                              // ← jumps to next attempt with no delay
}
```

Both `continue` paths (lines 636 and 662) skip the backoff path that lives further down (line 877 `getRetryDelay(...)` + line 926 `await sleep(...)`). When the failure is a *network outage* rather than a *bad account*, rotating accounts is futile, and the lack of delay means the whole 6-attempt retry budget burns inside about one second (only the first failure pays a real backoff; attempts 2-6 are essentially instant).

## Secondary contributors

1. **Stale keep-alive sockets.** `configureGlobalAgents` installs pooled HTTPS agents at boot. After a real network drop the OS silently invalidates the underlying TCP connections, but the pooled sockets stay in the agent — subsequent requests reuse a dead socket and get `ECONNREFUSED` immediately. A fresh process (the `/resume` path) re-creates the agents and succeeds.
2. **WS already degraded.** Earlier in the session at line 4620 the websocket fell back to HTTP with `code=1006 zero_events:Connection ended`; the path was already on the HTTP retry track when the outage hit.
3. **No "network is down" detection.** The pool treats every connection failure as a per-account transient failure (`account.transient_failure` diagnostic). After cycling all 5 accounts in <1 s and seeing the same `ConnectionRefused`, the system has enough signal to conclude *the network*, not the accounts, is the problem — but doesn't.

## Why `/resume` "fixes" it

`/resume` exits the current process and starts a new one that re-reads the saved session history (`Messages deferred by 138 (0→138)` at 06:31:10.639). The new process:

- Builds a fresh HTTPS agent (no dead sockets in the keep-alive pool).
- Reloads accounts from disk with clean health state.
- Re-runs OAuth token refresh as needed.

None of this is recovery logic — it's just side effects of a cold start.

## Proposed fix

In `src/services/api/withRetry.ts`, in the Codex connection-error failover block (around lines 599–673):

1. **Add a backoff before each `continue`.** Use the same `getRetryDelay(attempt, retryAfter)` as the standard path so attempt N waits ~`BASE_DELAY_MS * 2^(N-1)` plus jitter.
2. **Detect "network down" vs. "account bad".** Track the count of consecutive `APIConnectionError`s across leases inside one retry budget. If ≥2 distinct accounts fail with the same connection-error class within e.g. 500 ms, treat it as a network outage: do a single longer backoff (5–10 s) instead of burning the budget, and recycle the global HTTPS agent so the next attempt doesn't reuse a dead socket.
3. **Surface "waiting for network" in the UI.** Today the user sees a generic `Connection error.` then nothing — they don't know whether to wait or to exit. A `system / api_retry` yield (the same path persistent-retry uses at line 924) would keep them oriented.

A minimum viable fix is just #1 — it makes the 6-attempt budget span ~30 s instead of ~300 ms, which gives a recovering network enough time to come back without a process restart.

## Repro

1. Start a normal `cat-code` session and send a prompt so the websocket / HTTPS pool warms up.
2. Drop network (Wi-Fi off, or `pfctl` block) for >30 s while the agent is idle.
3. Restore network.
4. Submit a new prompt.
5. Expected: brief stall, then success. Observed: instant `Connection error.` and the session stays broken until exit + `/resume`.

## Status / Follow-up

**Do not patch this directly yet.** The account-switching implementation plan at `docs/plans/2026-05-20-account-switching-fixes-implementation-plan.md` already owns `src/services/api/withRetry.ts` under two of its patches:

- **Patch 2** (lease invariant / persistence) edits `withRetry.ts` for main-thread/global failover handling.
- **Patch 5** (retry & error-classification hardening) explicitly aims to "bound pathological retry/failover loops" — the same surface as this bug. Its §16.2 test mapping even says "repeated connection errors across multiple healthy accounts; assert bounded failovers and clear terminal error", which is exactly this scenario.

Patches 2 and 5 are gated behind earlier patches in the wave diagram, so they are likely still in flight when this report was written.

### Action when Patches 2 and 5 land

1. Re-read `withRetry.ts` lines 599-674 (or wherever the codex connection-error failover block ends up after the edits).
2. Verify the three proposed fixes above against the new code:
   - [ ] Does each `continue` in the failover block now sleep with backoff before retrying?
   - [ ] Is the 6-attempt budget actually bounded in wall-clock time (target: ≥10 s, not ~1 s)?
   - [ ] Is "network is down" distinguishable from "account is bad" — e.g. does the code stop rotating leases when N consecutive failovers all fail with `APIConnectionError`?
   - [ ] Is the user shown a "waiting for network" indicator instead of a bare `Connection error.`?
3. If all four are satisfied: re-run the repro above to confirm in practice, then close this report.
4. If any are unsatisfied: file the delta as a follow-up patch on top of Patch 5 rather than reopening Patch 5.

### Re-verification subagent prompt

When ready, spawn a verification subagent with roughly:

> Re-verify the bug at `docs/reports/2026-05-20-network-recovery-stuck-bug-report.md` against current `src/services/api/withRetry.ts`. Specifically check the four bullets in the "Action when Patches 2 and 5 land" section. Report which still hold and which were fixed by Patches 2/5.

The original verification of this report (timing burst ~800 ms, 6 failed submits on pid 26801, source claim about `continue` at 636/662 skipping `await sleep`) was done by a subagent on 2026-05-20 and is captured in the body of this report. A second verification pass is required after Patch 5 lands.
