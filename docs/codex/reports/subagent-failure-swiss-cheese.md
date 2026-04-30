# Codex Subagent Failure — Swiss Cheese Root Cause Report

**Date:** 2026-04-21
**Session analysed:** `90293ee9-c447-4581-8a37-3aeb41b03772`
**Severity:** High for agent-heavy workflows; medium for main-thread use.
**Audience:** Implementer session tasked with fixing the defects below.

---

## 1. Incident summary

User spawned 4 parallel Codex-backed Agent-tool subagents for a repo audit. Result: 1 success, 3 failures. Two failed immediately with `"Codex WS error: The usage limit has been reached"`. One failed after 245 s and 27 tool uses with `"WebSocket closed before response.completed"`. No retry / failover ran for any of them.

Evidence (from `~/.cat-code/debug/90293ee9-c447-4581-8a37-3aeb41b03772.txt`):

| Subagent | Description         | Account used | Outcome                    |
|----------|---------------------|--------------|----------------------------|
| a9de28   | P1-4 correctness    | `fb239c99`   | FAIL — "usage limit"       |
| a19196   | P1-4 design         | `902073af`   | SUCCESS                    |
| a8bf14   | P5-7 correctness    | `ca889574`   | FAIL — WS closed mid-run   |
| a61be3   | P5-7 design         | `fb239c99`   | FAIL — "usage limit"       |

Two failures hit the same account (`fb239c99`).

`fb239c99` identity (from `~/codex-vault/accounts/fb239c99-79a9-4246-aea0-d8fdc898ec07.json`):
- **alias:** `backup2`
- **plan:** `plus`
- **`chatgpt_subscription_active_until`:** `2026-04-12T03:30:01+00:00` — expired **9 days before** the failed run
- Vault's `refresh_token` still mints valid JWTs, so token-freshness checks pass.

The `"usage limit has been reached"` text was NOT a real quota event. The Plus plan had lapsed; OpenAI's backend rejects inference on revoked-plan accounts using the same error string as genuine quota caps.

The sibling failure on `ca889574` (a8bf14) is a distinct, legitimate mid-stream WS drop — a separate transport-resilience issue that shares downstream handling bugs.

---

## 2. Root cause: Swiss cheese, 8 layers, 8 aligned holes

Each layer had a reasonable-in-isolation design that silently discarded a signal which would have prevented the outcome. No single layer is "wrong"; the failure is emergent.

| # | Layer                 | Should catch                                        | Hole                                                                                                     |
|---|-----------------------|-----------------------------------------------------|----------------------------------------------------------------------------------------------------------|
| 1 | Vault load            | Expired subscription on `backup2`                   | Never parses `chatgpt_subscription_active_until` from `id_token`                                          |
| 2 | `/usage` polling      | `"Unexpected usage response"` = unhealthy           | Rendered in UI only; not fed back into pool health state                                                  |
| 3 | Pool health filter    | Revoked account should not be `healthy`             | `status` only flips via `markPoolAccountCapped`, which is called from exactly one place                   |
| 4 | Lease selection       | Don't lease unverified account to subagents         | `spread` picks by live-lease count; treats unverified as equal to proven-good                             |
| 5 | WS error classification | `"usage limit"` → `CodexAccountCapError`         | Wraps as plain `Error` — see `src/services/api/codex-websocket-transport.ts:423`, also `:438` for close   |
| 6 | Stream translator     | Re-throw real errors to SDK                         | Catches all errors and emits them as assistant text + `stop_reason: end_turn` — `codex-fetch-adapter.ts:985-1008` |
| 7 | `withRetry` failover  | Retry on another account                            | Never sees typed errors because layer 6 disguises them as successful responses                            |
| 8 | Lease lifecycle       | Don't re-lease a just-failed account                | Lease releases immediately on task end; `spread` reselects the same bad account for the next sibling     |

Closing **any one** of these 8 holes would have prevented the user-visible failure. The fix plan below closes three to get defence in depth against this and adjacent failure classes.

---

## 3. Evidence files

Do not assume, check these before changing code:

- `~/.cat-code/projects/-Users-pt-cat-code/90293ee9-c447-4581-8a37-3aeb41b03772.jsonl` — parent session. Search for `codex_send_path` entries; note `account_id_prefix` is always `null` (field wired in the type at `codex-websocket-transport.ts:37,542` but never populated).
- `~/.cat-code/projects/-Users-pt-cat-code/90293ee9-c447-4581-8a37-3aeb41b03772/subagents/agent-a9de28ca969f410bb.jsonl` — contains an assistant message with `content: [{type: "text", text: "\n\n[Error: Error: Codex WS error: The usage limit has been reached]"}]` and `stop_reason: "end_turn"`. This is the smoking gun for hole #6.
- `~/.cat-code/debug/90293ee9-c447-4581-8a37-3aeb41b03772.txt` — grep for `agentId` prefixes + `account=` to confirm per-subagent routing.
- `~/codex-vault/accounts/fb239c99-79a9-4246-aea0-d8fdc898ec07.json` — decode the `id_token` JWT; `chatgpt_subscription_active_until` is in the `https://api.openai.com/auth` claim.

---

## 4. Fix plan — implement ALL of the following

Priorities reflect blast radius, not sequence. Implement in the listed order because later fixes depend on earlier ones being in place for their tests to make sense.

### FIX 1 — [Layer 5] Classify WS provider errors as `CodexAccountCapError`

**File:** `src/services/api/codex-websocket-transport.ts`
**Primary site:** `onMessage` handler, around line 392-428 (the `if (parsed.type === 'error')` branch ending at `enqueue({ error: new Error(\`Codex WS error: ${msg}\`) })` on line 423).

**Change:**
1. Import `CodexAccountCapError` from `./codex-fetch-adapter.js` (watch for circular import — may need to move the class to a shared `codex-errors.ts`; if the circular breaks the build, do that move first as a mechanical refactor).
2. Thread the current `accountId` into `streamTurnViaWebSocket` and its helpers. It's already in `authHeaders['chatgpt-account-id']`; pass it explicitly as a parameter so the transport doesn't parse headers at error time.
3. In the error branch, inspect `code` and `msg` (case-insensitive). If the message contains `"usage limit"` or `code` matches `usage_limit_reached` / any other provider cap code — throw `new CodexAccountCapError(accountId)` (via `enqueue({ error: ... })`). Otherwise fall through to the generic error.
4. Also classify the WS-closed-before-completion case at line 438. A pre-completion close on an account that has a history of recent errors OR with zero bytes received is almost certainly an account-side rejection disguised as a transport close. Wrap as `CodexAccountCapError` when zero events were yielded before close; otherwise keep the current transport-error shape (that's a separate retry concern — see FIX 4).

**Test:** add a unit test that feeds a mock WS server emitting `{type: "error", error: {message: "The usage limit has been reached"}}` to `streamTurnViaWebSocket` and asserts the generator throws `CodexAccountCapError` with the correct `accountId`.

### FIX 2 — [Layer 6] Stop swallowing stream errors as assistant text

**File:** `src/services/api/codex-fetch-adapter.ts`
**Primary site:** `processCodexEvents` catch block, lines 985-1008.

**Current behaviour (bug):** any error thrown by the async event iterator is caught, formatted as `[Error: ...]`, emitted as a `text_delta`, and the stream then closes cleanly with `finishStream` → `stop_reason: end_turn`. The SDK sees HTTP 200 + a normal-looking assistant turn.

**Required behaviour:**
- If the caught error is a `CodexAccountCapError` or any typed provider error: **do not** emit as text. Re-throw so the ReadableStream errors out and the SDK surfaces it to `withRetry`.
- If the caught error is untyped but no tokens have been emitted yet: also re-throw. Emitting garbage is worse than surfacing a failure.
- Only use the current "emit as text" behaviour when partial meaningful output exists AND the error is mid-stream (i.e. at least one `response.output_text.delta` was already yielded). In that case, emit a clearly-marked error notice AND set an error flag so `finishStream` writes `stop_reason: "error"` (or closest SDK equivalent) rather than `end_turn` — the current `end_turn` is actively lying to callers.

Also inspect `buildAnthropicStreamResponse` (line 1088) — if a typed error is re-thrown, it must propagate out of the ReadableStream's `start` function as an SDK-visible rejection, not a silent `controller.close()`. Error the controller with `controller.error(err)` on the re-throw path.

**Test:**
- Mock a WS iterator that throws `CodexAccountCapError` on the first iteration. Assert the returned `Response` body, when consumed, yields an error to the SDK caller (not a clean `end_turn` message).
- Mock one that throws mid-stream after emitting text. Assert partial text is preserved, `stop_reason` is NOT `end_turn`, and the error is attached somewhere callers can inspect.

### FIX 3 — [Layer 1] Mark expired-plan accounts capped at vault load

**File:** `src/services/api/codexAccountPool.ts`
**Primary site:** the vault-load / account-registration path. Check around line 663 and the `readVaultPath` callers near line 99, 482. The construction of each `PoolAccount` from `tokens` is the insertion point.

**Change:**
1. After building the `PoolAccount` from vault JSON, decode the `id_token` (it's a JWT; base64-decode the middle segment, JSON-parse). Be defensive — if the token is missing, malformed, or not a JWT, skip the check and leave the account healthy.
2. Read `payload['https://api.openai.com/auth']?.chatgpt_subscription_active_until`. It's an ISO-8601 string.
3. If present AND in the past (`Date.parse(value) < Date.now()`): set the account's `status` to `capped`, with `reason` = `subscription expired YYYY-MM-DD`. Log a warning via `logForDebugging`. The account remains visible in `/accounts` with status shown so the user knows why it's not being used.
4. Optionally also read `chatgpt_plan_type`; a downgrade from `plus`/`pro` to `free` should mark the account capped too (no Codex access on free tier).

**Do not** delete vault entries — marking capped is enough. The user may re-subscribe.

**Test:** unit test with a vault entry carrying a JWT whose `chatgpt_subscription_active_until` is in the past. Assert the constructed `PoolAccount.status === 'capped'`. Also test the "malformed JWT" case leaves the account healthy (don't let a parse error take down the pool).

### FIX 4 — [Layer 8] Cool-down on recently-failed accounts

**File:** `src/services/api/codexAccountPool.ts` + `src/services/api/codexAccountLeaseManager.ts`

**Problem:** even with FIX 1+2, there's a window between a sibling's failure and `markPoolAccountCapped` running. The lease manager can reselect the bad account in that window. Also, not every failure class will be classified as cap-worthy (e.g. transient transport drops) — those shouldn't permanently cap but should deprioritise.

**Change:**
1. Add `lastErrorAt: number | undefined` to `PoolAccount`. Update it whenever a turn on that account ends in error (any error, typed or not).
2. In `selectAccountForLease` (`codexAccountLeaseManager.ts:325`), after the existing live-lease-count sort, add a tiebreaker / filter: accounts with a `lastErrorAt` within the last 60 s are deprioritised below accounts without one. Implement as an additional sort key ranked *after* live-lease count but *before* fresh-usage. Do not remove the accounts entirely — if only one account is available and it recently errored, it should still be selected (last-resort).
3. The 60 s window should be configurable via an env var with a sensible default (e.g. `CODEX_POOL_ERROR_COOLDOWN_MS=60000`).

**Test:** a scenario where one account errors on subagent 1, then a cold sibling 2 picks — assert sibling 2 lands on a different account.

### FIX 5 — [Layer 2 + observability] Populate `account_id_prefix` in the session JSONL

**File:** `src/services/api/codex-fetch-adapter.ts` — the `registerSendPathLogger` callback wiring around line 540-548.

Currently `account_id_prefix` is always written as `null`. The value is already available in the fetch adapter's scope (`currentAccountId`). Wrap the logger registration so the adapter fills it in before forwarding to the session JSONL writer. This costs one line of code and makes every future bug of this family diagnosable without reading the debug txt.

Also populate `prompt_cache_key_prefix` and `session_id_prefix` from the already-available `codexPromptCacheKey` and `CODEX_SESSION_ID` in the same pass.

**Test:** integration test that exercises a WS turn and asserts the resulting JSONL entry has non-null `account_id_prefix`.

---

## 5. Do NOT do these

- Do not try to "retry" the stream-as-text behaviour by parsing assistant text for `[Error:` markers at the caller level. That's fragile and papers over FIX 2.
- Do not auto-delete vault entries when marking them capped. User may re-subscribe; a "show and skip" model is correct.
- Do not change the `spread` lease strategy itself — it is not broken. The inputs it receives are broken. FIX 3 + FIX 4 fix the inputs.
- Do not widen `CodexAccountCapError` to cover *every* WS error. Only provider-side rejection-shaped errors. Transport drops are a different category (FIX 4 handles those) and should remain retryable on the same account.
- Do not attempt to probe `/usage` as a pre-lease health check. It's the endpoint that's returning the unreliable shape for `backup2`; making it gating would make the pool more fragile, not less. FIX 3 is the more reliable signal.

---

## 6. Acceptance criteria

Before marking this work done, verify ALL of these:

1. **Expired-plan account is filtered at startup.** Keep `backup2` in the vault temporarily; start the CLI; confirm `/accounts` shows it with a capped status and reason referencing subscription expiry. No WS turn is ever dispatched to `fb239c99`.
2. **Forced WS "usage limit" triggers failover.** With a mock or a known-capped account, confirm that a WS turn returning `"usage limit has been reached"` causes `withRetry` to reassign the lease and retry on a healthy account — end-to-end, no user-visible garbage text.
3. **Mid-stream transport drop is either retried or surfaces as a real error.** Confirm the subagent's final message is NOT `[Error: ...]` text with `stop_reason: end_turn`. Either it successfully retries, or the Agent tool's return value reflects a real failure the parent agent can react to.
4. **`account_id_prefix` is populated** in new session JSONL entries.
5. **Cool-down works.** Simulate fast-failing account, spawn 2 sibling subagents in succession. Second sibling picks a different account.
6. **Existing passing tests still pass.** Especially `src/services/api/codexAccountLeaseManager.test.ts` — the new cool-down logic must be additive.
7. **User-facing check:** after the fix, re-running the original 4-subagent review with `backup2` still in the vault (capped) should produce 4/4 successes, routed across the 3 healthy accounts.

---

## 7. Files almost certainly touched

Primary:
- `src/services/api/codex-websocket-transport.ts`
- `src/services/api/codex-fetch-adapter.ts`
- `src/services/api/codexAccountPool.ts`
- `src/services/api/codexAccountLeaseManager.ts`

Possibly:
- New `src/services/api/codex-errors.ts` if circular import forces moving `CodexAccountCapError`
- `src/utils/sessionStorage.ts` (the `SendPathEntry` type at line 352 if the logger shape changes)
- Tests alongside each primary file

Do NOT touch:
- `src/services/api/withRetry.ts` — its logic is correct; the bug is that it's not being called. Verify no change needed by running its existing tests after FIX 1+2.
- Agent tool runtime / `LocalAgentTask.tsx` — the subagent spawn path is correct. The lease lifecycle logic at line 449-467 that releases on failure is fine once FIX 4 is in place.

---

## 8. Context the implementer should load before coding

Read these in order, don't skip:

1. This report.
2. `src/services/api/codex-websocket-transport.ts` in full — it's ~570 lines and the transport mental model matters for FIX 1.
3. `processCodexEvents` and `buildAnthropicStreamResponse` in `src/services/api/codex-fetch-adapter.ts` — understand how events become an HTTP Response before changing the error path for FIX 2.
4. `src/services/api/codexAccountPool.ts` vault-load path (lines ~99, 482, 663) — understand current account construction before inserting FIX 3.
5. `docs/codex/subagent-account-leasing/design.md` if it exists — background on lease design assumptions.
6. The four subagent JSONL files referenced in §3 — seeing the literal assistant-text-with-error grounds the abstract description of FIX 2.

---

## 9. Addendum — context and correct-but-wrong hypotheses

Everything in this section is information developed during the investigation that did not fit cleanly above but will save the implementer time.

### 9.1 The pool currently has 4 vault accounts

From `ls ~/codex-vault/accounts/`:

- `0c9b1d6d-f4e4-4673-9aca-79da8dd91165.json`
- `902073af-1c05-49e8-ba5f-3edc457829d8.json`
- `ca889574-256c-4f04-8d5f-f80004f1a8e1.json`
- `fb239c99-79a9-4246-aea0-d8fdc898ec07.json` ← the expired one (`backup2`)

Aliases seen in logs / config: `main`, `backup1`, `backup2`, plus one or more unnamed. The user's usage panel showed three with usage numbers (main 9%, backup1 18%, `0c9b1d6d-f4e` 22%) and `backup2 · usage unavailable (Unexpected usage response)`. Match by prefix, not by alias — aliases can be stale.

### 9.2 `fb239c99` JWT — full useful claims (for FIX 3 test fixtures)

Decoded from the `id_token` in the vault JSON. Use these exact field paths in the implementation:

```
payload['https://api.openai.com/auth'] = {
  chatgpt_account_id: "fb239c99-79a9-4246-aea0-d8fdc898ec07",
  chatgpt_plan_type: "plus",
  chatgpt_subscription_active_start: "2026-03-12T03:30:01+00:00",
  chatgpt_subscription_active_until: "2026-04-12T03:30:01+00:00",   // ← check THIS
  chatgpt_subscription_last_checked: "2026-03-30T09:08:50.037500+00:00",
  chatgpt_user_id: "...",
}
```

The `chatgpt_subscription_active_until` field is also present in the `access_token`'s `https://api.openai.com/auth` claim but the id_token is the conventional place to read it from. Either works — prefer id_token because it's not rotated on every refresh.

`iat` was 2026-04-16 — confirming the refresh flow happily mints tokens on revoked-plan accounts. Do not rely on token freshness as a plan-health signal.

### 9.3 Hypothesis that was investigated and rejected — do not waste time re-checking

A different session investigated and rejected the hypothesis that **`registerCodexLease` has a read-compute-write race** under parallel fan-out. Conclusions (all load-bearing for this report):

- `registerCodexLease` (`codexAccountLeaseManager.ts:113-151`) is synchronous end-to-end, no `await` between read and write.
- `selectAccountForLease` (`:325-395`) and `getLiveLeaseCountsByAccountId` (`:419-433`) are synchronous map walks.
- `AgentTool` does declare concurrency-safe (`src/tools/AgentTool/AgentTool.tsx:1391-1392`) and siblings run concurrently via `toolOrchestration.ts:26-41,152-176`, but the lease is registered inline & synchronously before any async work — background path `AgentTool.tsx:724-741`, foreground path `AgentTool.tsx:863-877`. No race possible in a single-threaded JS runtime.
- Main-thread lease IS registered in fresh sessions — `query.ts:315-325` registers `main-thread`, released at `:1768-1771`. `synthesizeMainLease` is snapshot-only.

The **actual mechanism** by which multiple siblings hit `fb239c99` is NOT selection race. It is: `spread` correctly picked different accounts for each sibling; of those, two happened to be `fb239c99`; the first one's failure never marked `fb239c99` capped (holes #5/#6/#7); lease released immediately on task end (hole #8); next sibling's `spread` pick counted `fb239c99` as zero-live-lease and therefore eligible again.

Spread itself is behaving correctly. The inputs to spread (pool health, lease-retention-on-failure) are the problem.

### 9.4 The WS path is the default; HTTP is the fallback

`codex-fetch-adapter.ts:1344-1375` eagerly opens a WS session and only falls through to HTTP on connect failure. The `CodexAccountCapError` thrown at `:1447` on 429/401 is therefore on a path that rarely executes in practice. This is why the bug went unnoticed: most real traffic takes the WS path where classification is broken, and the HTTP fallback (which handles classification correctly) only runs when the WS handshake itself fails. Fixing FIX 1 + FIX 2 brings the WS path up to parity with the HTTP path.

### 9.5 Prewarm swallows errors — intentional, leave alone

`prewarmWebSocket` (`codex-websocket-transport.ts:233-269`) wraps its iteration in a try/catch that logs and returns. This is correct behaviour: prewarm failures are advisory (cache-seeding optimisation), not request failures. Do NOT change this when implementing FIX 1 — only the real-turn path should propagate typed errors.

However, note an interaction: if prewarm hits a "usage limit" error on an expired account, it silently returns and the real turn then also hits the same error. The real turn's error IS the one that matters for classification. No change needed, but be aware during testing that two identical errors may log back-to-back (prewarm + real turn) — don't mistake that for a retry loop.

### 9.6 Existing retry loop inside `streamTurnViaWebSocket`

The transport already has a 3-attempt loop (`codex-websocket-transport.ts:197-220`) that handles two sentinel errors:

- `StaleResponseIdError` — server forgot the `previous_response_id`, retry as full send on same connection
- `ConnectionLimitError` — server-side 60-min WS connection limit (`websocket_connection_limit_reached`), reconnect + retry

`CodexAccountCapError` should NOT be added to this inner retry loop — it's an account-level failure that requires failover, which happens at `withRetry` (outer layer). The inner loop is for same-account transport self-healing only. Throw `CodexAccountCapError` out of the generator and let `withRetry`'s existing failover branch (`withRetry.ts:276-321`) do the work.

### 9.7 Mid-stream WS close handling (FIX 1.4 nuance)

The `ca889574` (a8bf14) failure was a pre-completion close after 27 tool uses over 245 s. Distinguishing categories at close time:

- **Close before any event yielded** → almost certainly account-side rejection (classify as `CodexAccountCapError` per FIX 1).
- **Close after `response.completed`** → already handled; returns normally.
- **Close mid-stream with events already yielded** → transport drop, legitimate retryable error. Current behaviour converts to text via hole #6 — FIX 2 must preserve the partial output while signalling the error. The inner retry loop does not currently handle this case; consider adding a `TransportDropError` sentinel that the outer `withRetry` can treat as retryable-on-same-account (distinct from `CodexAccountCapError` which forces failover).

For the 27-tool-uses case specifically: the user loses all that work. A "retry on same connection with the same context" path exists in upstream codex-rs as `ApiError::Retryable` — worth a follow-up but out of scope for this fix batch. Minimum for this batch: don't silently discard the 27 tool results; surface the error so the caller (Agent tool) can decide.

### 9.8 `account_id_prefix` is wired but never filled — the investigator's trap

When this bug recurs, the first instinct will be to grep session JSONL for `account_id_prefix` to determine which account each subagent used. That field is declared in `SendPathEntry` at `codex-websocket-transport.ts:37`, passed through as `null` at `:542`, and the comment at `codex-fetch-adapter.ts:78` literally says "account_id_prefix filled as null from transport; not resolvable here" — even though the account IS available in the adapter's scope. This is a passive diagnostic hole; FIX 5 closes it. Until FIX 5 ships, use `~/.cat-code/debug/<session-id>.txt` and grep for `agentId` + `account=` lines to reconstruct routing.

### 9.9 Useful one-liners for verification

```bash
# Which accounts did each subagent land on? (requires debug.txt for the session)
for id in <agentId1> <agentId2> <agentId3> <agentId4>; do
  echo "=== $id ==="
  grep "$id" ~/.cat-code/debug/<session-id>.txt | grep -oE "account=[a-z0-9-]+" | sort -u
done

# What's the alias of an account by prefix?
for f in ~/codex-vault/accounts/<prefix>*.json; do
  grep -oE '"alias":"[^"]*"' "$f"
done

# Is an account's subscription expired? (requires jq + base64)
cat ~/codex-vault/accounts/<accountId>.json \
  | python3 -c 'import json,sys,base64; t=json.load(sys.stdin)["tokens"]["id_token"]; p=t.split(".")[1]; p+="="*(-len(p)%4); print(json.loads(base64.urlsafe_b64decode(p))["https://api.openai.com/auth"]["chatgpt_subscription_active_until"])'
```

### 9.10 What "good" looks like for the user after all fixes land

User re-runs the original 4-subagent review with `backup2` still in the vault:
1. At startup, `/accounts` shows `backup2` with status `capped` and reason `subscription expired 2026-04-12`. User is not surprised.
2. `spread` distributes 4 subagents across the 3 healthy accounts (likely 2+1+1).
3. All 4 subagents return real findings. No `[Error: ...]` assistant text anywhere.
4. If a mid-stream WS drop happens on `ca889574` again, the Agent tool result either reflects a real failure the parent agent can retry, OR the transport layer retries transparently — never silent 27-tool-uses loss.

If any of these are not true after implementation, re-read §4 and check which fix regressed or was skipped.

---

End of report.
