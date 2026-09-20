# Codex Prompt Cache — Debugging Report

**Date:** 2026-04 (updated during the investigation)
**Author:** Debug session after Phase 1–4 fix was shipped and tested
**Intended audience:** A future Claude Code session picking this investigation up cold. Read top-to-bottom; everything you need is here.

**Update log:**
- Initial: Documented 1.7% hit rate, identified the debug-log gate bug and Phase 3 prepend bug, and enumerated hypotheses A–F.
- Revision 2: Bugs 4.1 and 4.2 **fixed and built**. Added new hypotheses G/H/I from a deeper read of the request-construction code.
- Revision 3: **First controlled test ran.** Result: 0% cache reads across 5 consecutive short-message turns with all inputs byte-stable. See Section 2.5. Hypotheses C, D, E, G ruled out. A and B became primary. New findings: `x-cache=DYNAMIC route=none` on every response, and `session-id` resets on resume while `conversation-id` persists.
- Revision 4: **Hypothesis F (`previous_response_id`) definitively ruled out.** Prototype sent the field; server returned `400 {"detail":"Unsupported parameter: previous_response_id"}`. Prototype reverted. See Section 6 Hypothesis F update and Section 2.6.
- Revision 5: **FIX FOUND.** Read openai/codex upstream source (`codex-rs/core/src/client.rs`), found wrong header names, wrong header values, wrong originator, and fragmented identity across 3+ different UUIDs. Aligned all of them onto a single `conversation_id` per CLI session. Hit rate went from **0% → 47.5%** on an identical test protocol. See Section 2.7.
- Revision 6 (this version): **Resume cold-start fixed (Plan B).** Registered `onSessionSwitch(id => setCodexPromptCacheKey(id))` in `src/setup.ts` so `--resume`'s late `switchSession(oldSid)` also re-pins the Codex `conversation_id`. The first post-resume request then hit the server-side cache immediately; synthetic debug-log names are omitted here.

---

## 0. How to use this document

If you are a future session continuing this work:

1. Read Section 1 (TL;DR) and Section 10 (Recommended Next Steps) first.
2. Section 2 (Hard Data) is the ground truth from the test session. Don't re-derive it — use the numbers.
3. Section 4 (Bugs found) — go fix these first. Especially the debug-log gate, because nothing else can be verified until it's fixed.
4. Section 6 (Possible Root Causes) is a ranked hypothesis list. Do not commit to one without the verification step that follows each hypothesis.
5. Section 11 (What I'm NOT sure about) is honest about what's speculation. Don't treat any of it as fact.

**Working directory:** `$HOME/project`
**Build to use:** `bun run build:dev:full` produces `./cli-dev`
**Config dir:** `$HOME/project/config/`

---

## 1. TL;DR

The Phase 1–4 cache fix **did not materially improve** cache performance on the ChatGPT Codex endpoint.

- **Baseline session (before fix, `session-baseline`):** ~13% hit rate, described in `docs/codex/2026-04-30-cache-fix-plan.md` line 5
- **Test session (after fix, `session-test`):** **1.7% hit rate**
- Only 3 out of 22 API calls got any cache read at all; the 19 others were 0-read misses.

The fix mechanically works (stable `prompt_cache_key`, persistent routing map, volatile context split), but the **server-side cache behavior** appears not to respect any of these levers in the way the plan assumed.

The root cause is **not yet confirmed**. We have strong pattern evidence but no direct verification because our debug logging was silently suppressed during the test.

---

## 2. Hard Data from the Test Session

### 2.1 Session metadata

- **Session ID:** `session-test`
- **JSONL path:** `$HOME/project/transcripts/session-test.jsonl`
- **Model used:** `gpt-5.4` (Codex path, all 22 calls)
- **Started via:** a synthetic resume of `session-baseline` (continuation of a prior session context via the pickup skill)

### 2.2 Per-request cache usage

The controlled session contained 22 real API calls, defined as assistant-message
records with `input_tokens > 0` (tool-use wrappers are excluded). Three calls
reported a cache read; the remaining 19 reported zero cached tokens. The first
call read about 16.9k tokens, a later partial hit read about 16.9k, and the final
partial hit read about 14.8k. The other calls grew from roughly 44k to 162k
input tokens but reported no conversation-history cache read.

Totals:
- **input=2,848,790**
- **read=48,640**
- **create=0**
- **overall hit rate=1.7%**

### 2.3 Key observations from the data

1. **Cache reads, when they appear, are always ~14,848–16,896 tokens.** This size matches the static `instructions` portion (system prompt + tool definitions + stable context). The **conversation history itself is never cached** — even though it grows monotonically from ~18k to ~162k tokens across the session.

2. **`cache_creation_input_tokens` is always 0 by design.** `codex-fetch-adapter.ts:1114` hardcodes this to 0 because OpenAI's Responses API doesn't separately report cache-write tokens. **It is not a usable signal — do not draw conclusions from it.**

3. **Hits are time-independent and appear random.** Short and long gaps both
   preceded hits and misses; time-since-last-request does NOT predict either
   outcome.

4. **Routing map persistence works.** `$HOME/project/config/codex-cache-routing.json` contains stable account+model → conversation-id entries. Phase 2 is mechanically functional.

5. **Total prompt size grows monotonically.** The test grew from roughly 19k to 163k total tokens (input + read). The conversation content IS consistent across turns. So the "cache invalidation" is NOT coming from content churn on our side.

### 2.5 Second controlled test (after fixes applied)

Session: `session-controlled-a` (turns 1-3) + `session-controlled-b` (resumed turns 4-5)

Debug log: `$HOME/project/debug/synthetic-controlled-session.log`

**Protocol:** three short synthetic prompts → `/exit` → resume → one short prompt → one longer-response prompt. No tool use. No `/pickup`. Clean test.

**Result — every single call was 0% cache:**

All five calls reported 0% cache reads. The instructions hash was byte-stable
(`synthetic-stable-hash`), the account remained `account-a`, and the conversation
identifier (`conversation-a`) persisted across resume.

Responses were successful but reported `x-cache=DYNAMIC` and `route=none`; no
request ID or routing header was returned.

**What this confirms:**

1. **Fixes 4.1 and 4.2 are mechanically correct** — logs now work, the instructions hash is byte-stable across all turns, and Phase 3 is no longer contaminating the prefix.
2. **Hypothesis C (prepend bug) is ruled out** — hash was stable anyway, fix had no effect on hit rate.
3. **Hypothesis D (body per-turn variation) is ruled out** — hash byte-identical across 5 turns proves the body prefix is deterministic.
4. **Hypothesis G (account rotation) is ruled out** — `account-a` was used on every turn, with no rotation.
5. **Hypothesis E (conversation-id format) is ruled out** — `conversation-a` persisted across exit+resume, with no change.
6. **Hypothesis A (prompt_cache_key ignored) is much stronger** — with everything stable, the server still returns zero cached. The only thing that could cause this and hasn't been ruled out is the server simply not caching.
7. **Hypothesis B (node affinity) is also stronger** — the `x-cache=DYNAMIC` value and absence of routing headers suggests the endpoint is not integrated with any CDN/edge cache. It's hitting origin every time.

**New finding not previously considered:**
- `session-id` header changes on `--resume` from one synthetic session value to another while
  `conversation-id` stays `conversation-a`. But we got 0% even while both were stable,
  so this isn't the blocker.

### 2.6 `previous_response_id` experiment

Prototype: captured the SSE `response.completed` identifier, stored by
`${accountId}:${model}`, and set it on the next request as
`codexBody.previous_response_id`.

**Test result:** the first chained request was rejected by the server:

```
API Error: 400 {"detail":"Unsupported parameter: previous_response_id"}
```

The unchained control request succeeded. Every subsequent request with
`previous_response_id` attached returned 400.

**Conclusion:** `https://chatgpt.com/backend-api/codex/responses` does not accept `previous_response_id`. This is different from OpenAI's public Responses API (`api.openai.com/v1/responses`), which does support it. The ChatGPT backend is a stripped-down variant that explicitly rejects the parameter.

**Implication:** Hypothesis F is **definitively ruled out**. It cannot be "the fix" — it breaks the request outright.

Prototype code reverted in the same session. No lingering changes.

### 2.7 Fix test (upstream-aligned)

After reading `openai/codex` upstream source (`codex-rs/core/src/client.rs`, `codex-rs/codex-api/src/requests/headers.rs`, `codex-rs/login/src/auth/default_client.rs`), the real discrepancies were found and fixed. See Section 6 Hypothesis L for details on what was wrong.

**Changes applied to `src/services/api/codex-fetch-adapter.ts`:**
1. One `conversation_id` per CLI session (derived from `codexPromptCacheKey` / `CODEX_SESSION_ID`). Dropped the persisted per-account routing map entirely.
2. Headers: `session_id` (underscore!) and `x-client-request-id` both carry `conversation_id`. Dropped `conversation-id` (hyphen) and `session-id` (hyphen).
3. `prompt_cache_key` body field set to `conversation_id`.
4. `originator: 'pi'` → `'codex_cli_rs'` (upstream value).

**Test session:** `session-aligned-a` plus resumed `session-aligned-b`.

The first request was cold, the next two were partial hits with about 13.8k
cached tokens, the first request after resume was cold, and the following request
was a partial hit with the same ceiling.

**Hit rate: 47.5%** overall (41,472 cached / 87,336 input+read). In-session (turns 1-3) hit rate: **52.9%**.

**Known remaining issues:**
1. **Resume cold-start.** The conversation identifier changed across `--resume` because
   `codexPromptCacheKey` was set from the new CLI process's session UUID, not the
   resumed session's original UUID. One cold turn per resume. Fixable: persist the
   original conversation_id with the resumed session record.
2. **13,824-token cache ceiling.** Partial hits plateau at exactly 13,824 cached
   tokens, approximately the server's internal tokenization of the stable
   `instructions` block. Conversation history growth does not cache. Whether this
   is a server-side characteristic or something we can influence is unknown.

### 2.4 The smoking-gun pattern

- **First call:** the static instructions prefix was partially cached.
- **Next larger call:** a synthetic tool-result expansion produced no cache read.

If prefix caching worked as the plan assumed, the next call should have reused
the earlier prompt prefix and paid only for the new content. Instead it read
**zero**.

This pattern repeats throughout the session. The stable `instructions` prefix is
the ONLY thing that ever reads from cache. Conversation-history portions are
NEVER read from cache.

---

## 3. What We Verified Works

- **Phase 1 (stable `prompt_cache_key`)**: `setCodexPromptCacheKey(getSessionId())` is called in `src/setup.ts:89` after `switchSession`. The session UUID is reused on `--resume` and across restarts. Mechanically correct.

- **Phase 2 (persistent routing)**: `$HOME/project/config/codex-cache-routing.json` exists and is updated on new-conversation allocation. A sanitized shape is:
  ```json
  {
    "account-a:gpt-5.3-codex": "<conversation-a>",
    "account-b:gpt-5.3-codex": "<conversation-b>",
    "account-c:gpt-5.3-codex": "<conversation-c>",
    "account-a:gpt-5.4": "<conversation-d>",
    "...": "..."
  }
  ```

- **Phase 4 (observability)**: `/cache-stats` command registered (`src/commands.ts`). `recordCacheStat` fires on each `finishStream`. The new log lines added in this session (pre-request, post-response, finishStream COLD/WARM/PARTIAL) are all in place in `src/services/api/codex-fetch-adapter.ts` but never emitted — see Section 4.

---

## 4. Bugs Found In The Fix Itself

### 4.0 Status summary

| # | Bug | Status |
|---|-----|--------|
| 4.1 | Debug logs silently suppressed for non-ant users | **FIXED** (see below) |
| 4.2 | Phase 3 volatile context prepended instead of appended | **FIXED** (see below) |
| 4.3 | `cache_creation_input_tokens` always 0 | Documented, not a bug |

Both fixes landed in a local build (`./cli-dev`) but **have not yet been tested against the live endpoint**. Next test session will be the first real measurement.

### 4.1 Debug logging is silently suppressed for non-ant users (HIGH IMPACT) — FIXED

**File:** `src/utils/debug.ts:104-125`

```typescript
function shouldLogDebugMessage(message: string): boolean {
  if (process.env.NODE_ENV === 'test' && !isDebugToStdErr()) {
    return false
  }

  // Non-ants only write debug logs when debug mode is active
  if (process.env.USER_TYPE !== 'ant' && !isDebugMode()) {
    return false
  }
  // ...
}
```

`isDebugMode()` returns true only when any of these are set:
- `--debug` / `-d` CLI arg
- `--debug=pattern` CLI arg
- `--debug-file=PATH` CLI arg
- `--debug-to-stderr` / `-D`
- `DEBUG=1` or `DEBUG_SDK=1` env var
- `/debug` slash command mid-session

For `USER_TYPE !== 'ant'` without any of the above, **`logForDebugging` returns immediately without writing anything.**

**Impact:** Every `[codex-cache]` log line added in the new code is silently discarded unless debug mode is explicitly enabled. The test session ran without `--debug`, so we have **zero** debug output to analyze.

**Fix applied:** Added an allowlist at the top of `shouldLogDebugMessage`:

```typescript
const ALWAYS_LOG_PREFIXES = ['[codex-cache]']

function shouldLogDebugMessage(message: string): boolean {
  if (process.env.NODE_ENV === 'test' && !isDebugToStdErr()) return false
  const isAlwaysLog = ALWAYS_LOG_PREFIXES.some(p => message.startsWith(p))
  if (process.env.USER_TYPE !== 'ant' && !isDebugMode() && !isAlwaysLog) {
    return false
  }
  // ... rest unchanged
}
```

`[codex-cache]`-prefixed messages now bypass the non-ant gate while still respecting `NODE_ENV === 'test'` and the `--debug=<pattern>` filter. All other debug lines behave as before. Shipped in `./cli-dev`.

### 4.2 Phase 3 volatile context is prepended, not appended (MEDIUM IMPACT) — FIXED

**File:** `src/services/api/instructionAssembly.ts:115-123`

The plan (`docs/codex/2026-04-30-cache-fix-plan.md` line 101) specifies:

> "Volatile context becomes a user message appended **after** the conversation history, not prepended. Rationale: the Responses API caches prefixes; appending to the end doesn't invalidate earlier cached segments."

The implementation does the opposite:

```typescript
return [
  createUserMessage({
    content: `Context for this session:\n...${allEntries...}`,
    isMeta: true,
  }),
  ...messages,  // <-- volatile context is FIRST, messages come after
]
```

**Impact:** The volatile preamble sits at position 1 in the input array (position 0 is `instructions`). Because prompt caches cache **prefixes**, any byte-change in the preamble invalidates everything after it. `gitStatus` and `cacheBreaker` are memoized within a session, so within one run the bytes are stable — but across sessions or after a cache-clear (e.g., after `/compact`), this still defeats the purpose of the split.

**Severity:** This alone cannot explain 1.7% hit rate in a single session (memoization keeps bytes stable within the run), but it makes the Phase 3 split ineffective across boundaries.

**Fix applied:** Volatile context is now appended at the tail of the messages array (per plan line 100):

```typescript
return [...messages, contextMessage]
```

**Caveat — a detour that didn't pan out:** an earlier iteration of this fix inserted the context at `length - 1` (second-to-last) to keep the user's actual prompt as the final message. On reflection that's worse — in the tool-use sub-loop the "last" message is often a `tool_result`, not a user prompt, so `length - 1` is not a semantically stable position either. The plain tail append matches the plan and is what shipped.

**Open question for the next session:** the plan's "cache earlier segments, only the tail misses" rationale assumes the cached prefix doesn't include the tail. This is probably true for prefix caching, but has NOT been verified against this specific endpoint. If the test shows conversation-history still never caches, that assumption may be wrong and the split isn't buying anything regardless of placement.

### 4.3 `cache_creation_input_tokens` always 0 (DOCUMENTED, NOT A BUG)

`codex-fetch-adapter.ts:1114` hardcodes this. It's not a bug but it IS a diagnostic blindspot — we cannot tell from our own logs whether the server created a cache entry or not. We only see reads.

---

## 5. The 1.7% Hit Rate: Pattern Analysis

### 5.1 What the data actually shows

- 22 requests total
- 3 requests got any cache read
- All 3 cache reads are in the 14.8k–16.9k range (matches size of stable `instructions`)
- 0 requests got any conversation-history cache read

If the conversation-history prefix were being cached, we'd expect successive turns to show `read ≈ total_prompt - delta_from_previous_turn`. For example, L20 prompt is ~44,256 tokens and L7 prompt was ~43,675 — so L20 SHOULD read ~43,675 and pay for only ~600 new tokens. Instead L20 reads 0.

### 5.2 What this implies

The ChatGPT endpoint is caching **only the static `instructions` segment**, not the evolving conversation prefix. The 14.8k–16.9k reads correspond exactly to the size of the system prompt + tool definitions.

Either:

1. `prompt_cache_key` is ignored by the endpoint (hypothesis A below)
2. `prompt_cache_key` is honored but node affinity is lost between turns (hypothesis B)
3. The conversation-history segment has something in it that changes byte-by-byte between turns that we haven't identified (hypothesis D)
4. Something else entirely (hypothesis E)

We cannot distinguish between these without debug-log data, which we don't have (see Section 4.1).

---

## 6. Hypotheses, Ranked

Each hypothesis includes: what it predicts, how to verify, and evidence for/against.

### Hypothesis A: `prompt_cache_key` is silently ignored by `chatgpt.com/backend-api/codex/responses`

**Endpoint:** `https://chatgpt.com/backend-api/codex/responses` — ChatGPT's internal Codex endpoint, NOT OpenAI's public Responses API at `api.openai.com`.

**Prediction:** Sending or not sending `prompt_cache_key` would make zero difference to hit rate.

**For:**
- The plan references `openai/codex#5556` as a known ChatGPT backend degradation
- The baseline (13% without our fix) vs after (1.7% with our fix) is within noise — neither works well
- The endpoint is undocumented for third-party use

**Against:**
- L5, L119, L168 DO get cache reads — something is being cached
- Upstream `openai/codex` (according to the plan) does get better hit rates on the same endpoint, which suggests SOMETHING works

**Verification:** Run with `--debug` (after fixing 4.1), capture the outgoing body (we already log `instructionsHash` and `prompt_cache_key` prefix, confirm they're stable), and try a request with `prompt_cache_key` REMOVED from the body. If hit rate unchanged, A is confirmed.

**Confidence:** MEDIUM

### Hypothesis B: Cache is node-affinity based; our routing hints don't stick

**Prediction:** The `session-id` and `conversation-id` headers pin node affinity only probabilistically. Load-balancer reshuffles most of the time, landing us on a fresh node with no cached prefix.

**For:**
- The "sometimes hit ~16896, mostly miss" pattern is exactly what you'd see with imperfect node affinity and a node-local cache
- Random-looking hit distribution over time
- Upstream codex may just be getting lucky more often due to request patterns

**Against:**
- If it were purely random, we'd expect SOME hits at various sizes, not just 14.8-16.9k — unless every node that happens to have anything cached for us has cached exactly the static instructions and nothing more

**Verification:** Capture `x-served-by`, `x-codex-node`, `cf-ray`, or any routing-related response header. Phase 4 already logs these IF debug mode is on. Compare headers between hits and misses.

**Confidence:** MEDIUM

### Hypothesis C: Phase 3 prepend bug is the main cause

**Prediction:** Because the volatile user message is at position 1 (right after stable instructions), even within-session it may produce byte-different content if ANY key in `userContext` or `volatileSystemContext` varies, invalidating the cache after position ~16,896.

**For:**
- Would explain why exactly the first ~16,896 tokens are the only thing ever cached: anything past that position is in the prepended message, which is volatile
- Simple, local, testable

**Against:**
- Both `getUserContext` and `getSystemContext` are `memoize`'d, so within one session the bytes should be identical
- But memoization ≠ deterministic serialization. JavaScript object iteration order is insertion-preserving, but if keys are added conditionally, the ORDER could differ between turns (e.g., `cacheBreaker` only present on some runs)

**Verification:** Capture the exact bytes of the prepended user message on L5 vs L7 and diff. If they differ, C is confirmed. If they're byte-identical, C is ruled out.

**Confidence:** LOW-MEDIUM. Worth ruling out quickly because the fix is trivial.

### Hypothesis D: Request body has per-turn varying content we haven't noticed

**Prediction:** Something in `codexBody` changes byte-by-byte across turns in a way that invalidates the prefix. Candidates:
- Tool order in `tools` array (if `translateTools` is non-deterministic)
- `store: false` interacting oddly
- Reasoning effort parameter varying per request

**For:**
- Would explain hit/miss randomness if, say, tool order depended on some mutable iteration
- `codexBody.reasoning.effort` is computed per-request and could differ

**Against:**
- Tool definitions come from a stable registry
- Effort is based on user's `/effort` setting which doesn't change turn-to-turn
- Doesn't explain why instructions DO cache but nothing else does

**Verification:** Capture two consecutive request bodies and diff everything except the last N messages.

**Confidence:** LOW

### Hypothesis E: Conversation-id allocation format is wrong

**Prediction:** The server expects conversation-ids in a specific format (e.g., prefixed) and rejects/ignores ones that don't match.

**For:**
- We use `randomUUID()` (RFC 4122 v4). Upstream codex may use a different format.

**Against:**
- The 10 conversation-ids in our routing file are all standard UUIDs and we've been using this format for a while
- The occasional L5/L119/L168 hits suggest SOMETHING is working with these IDs

**Confidence:** LOW

### Hypothesis L: Client identity disagrees with upstream openai/codex (CONFIRMED — THIS WAS THE BUG)

**Status:** **CONFIRMED** by upstream code read + fix test. Hit rate went from 0% → 47.5% after alignment.

**What was wrong:** we fragmented the cache-routing identity across 3+ different values while upstream uses ONE.

| Field | openai/codex (works) | Cat Code before fix (0%) | Cat Code after fix (47.5%) |
|---|---|---|---|
| `prompt_cache_key` body | `conversation_id` | Cat Code session UUID | `conversation_id` |
| `session_id` header name | underscore | **hyphen** (`session-id`) | underscore |
| `session_id` header value | `conversation_id` | Cat Code session UUID | `conversation_id` |
| `conversation-id` header | not sent | per-account UUID (hyphen) | not sent |
| `x-client-request-id` header | `conversation_id` | not sent | `conversation_id` |
| `originator` header | `codex_cli_rs` | `pi` | `codex_cli_rs` |
| `conversation_id` lifecycle | per CLI session | persisted per-account | per CLI session |

**Upstream references:**
- `codex-rs/core/src/client.rs:853` — `let prompt_cache_key = Some(self.client.state.conversation_id.to_string());`
- `codex-rs/core/src/client.rs:773` — `headers.insert("x-client-request-id", header_value);` (value = conversation_id)
- `codex-rs/core/src/client.rs:775` — `headers.extend(build_conversation_headers(Some(conversation_id)));`
- `codex-rs/codex-api/src/requests/headers.rs:6` — `insert_header(&mut headers, "session_id", &id);` (underscore, and the only header that function sets)
- `codex-rs/login/src/auth/default_client.rs:34` — `pub const DEFAULT_ORIGINATOR: &str = "codex_cli_rs";`

**Why this was the bug:** the ChatGPT backend presumably uses the `session_id` header + `prompt_cache_key` body value to route + cache. With them disagreeing (different UUIDs, and hyphenated header names possibly not matching the router's expected field), no caching was possible. Originator `pi` may have additionally routed us onto a non-Codex code path.

### Hypothesis G: Account-rotation cache fragmentation (RULED OUT)

**Prediction:** When the account pool rotates (429 failover or lease rotation), the `currentAccountId` changes → `cacheContextKey = ${accountId}:${model}` changes → a different `conversation-id` is used → that account's cache starts cold. In a 22-call session, even one rotation halves effective cache depth because two cold accounts each have to warm separately.

**For:**
- `codex-fetch-adapter.ts:1228` derives `cacheContextKey` from `currentAccountId`. The routing map has 10 distinct `accountId:model` entries — meaning at least 10 distinct conversation-ids have been allocated in this workspace's history, one per account.
- The test session used the pool (see `codexAccountPool.ts` + `codexAccountLeaseManager.ts`) so rotation is plausible.
- Persisted routing means rotating back to account A later reuses A's conversation-id, which is good — but A's cache may have evicted by then.

**Against:**
- Would not explain the L5 → L7 miss because those are adjacent in time; rotation within ~17s between two calls is unlikely.
- If rotation were the main cause, we'd see cache reads at 14.8-16.9k on BOTH "halves" of the session as each account warms its prefix. We only see 3 such reads across 22 calls.

**Verification:** After fixing 4.1, the `[codex-cache] request account=...` log will reveal whether `account=` changes across the 22 turns. If it stays constant, G is ruled out. If it changes at hit/miss boundaries, G is confirmed.

**Confidence:** MEDIUM. Can be verified passively from the next test's debug log, no extra code needed.

### Hypothesis H: `session-id` / `conversation-id` pairing is semantically inconsistent (NEW)

**Prediction:** The ChatGPT backend router uses `session-id` and `conversation-id` together. We send a global Cat-Code session-id but a per-account conversation-id. After account rotation, the pair `(same session-id, different conversation-id)` is unusual — if the router expects a 1:1 mapping, it may refuse to pin node affinity.

**For:**
- `codex-fetch-adapter.ts:1272-1273` sends `session-id = codexPromptCacheKey` (shared across accounts) and `conversation-id = cacheContextKey-derived` (per-account). These co-vary inconsistently.
- Upstream codex CLI presumably sends a consistent pair; we haven't verified their exact semantics.

**Against:**
- Within a single account with no rotation, both headers are stable — yet we still miss. So H cannot be the sole cause.
- `session-id` may only be a trace/log field, not a routing field.

**Verification:** Temporarily set `session-id = conversation-id` (same value) for one test. If hit rate improves, H is contributing.

**Confidence:** LOW-MEDIUM. Cheap to test after G is assessed.

### Hypothesis I: `originator: 'pi'` routes us to a non-cached code path (NEW)

**Prediction:** The ChatGPT backend uses the `originator` header to gate caching or other features. `'pi'` is not a standard codex client value; real Codex CLI sends something like `'codex_cli_rs'`. We could be on a path where caching is disabled or degraded.

**For:**
- `codex-fetch-adapter.ts:1274` hardcodes `originator: 'pi'` since file creation (April 2026). Never revisited.
- Would explain why NO amount of our local tuning moves the needle.

**Against:**
- If `originator` killed caching entirely, we wouldn't see the 14.8-16.9k reads at all.
- May just be a telemetry/attribution field with no cache behavior attached.

**Verification:** Change `originator` to `'codex_cli_rs'` (or whatever upstream uses — requires checking openai/codex source) and re-run the test. If hit rate changes, I is confirmed.

**Confidence:** LOW. Worth trying only after G and H are cleared.

### Hypothesis F: `previous_response_id` chaining is the only thing that works

The plan explicitly skipped this, noting "upstream doesn't use it either." But the plan also said "revisit if only 40-50% hit rate" — we got 1.7%.

**Prediction:** Adding `previous_response_id` (the id of the previous response) to each request body would dramatically improve hit rate.

**For:**
- It's the documented mechanism for cache continuity on OpenAI's Responses API
- `openai/codex#5556` suggests ChatGPT backend is degraded; `previous_response_id` may be the workaround

**Against:**
- Plan says upstream doesn't use it
- Would require capturing `response.id` from each SSE stream and threading it through

**Verification:** Prototype it. Capture `response.id` from `response.completed` events, store it, send it on the next request as `previous_response_id`. If hit rate jumps, F is confirmed.

**Confidence:** ~~UNKNOWN → HIGH PRIORITY~~ → **RULED OUT in revision 4.** Prototype tested: server rejects the parameter with 400 "Unsupported parameter: previous_response_id". See Section 2.6. This endpoint is not the same as `api.openai.com/v1/responses`; it's a stripped variant that does not expose this field.

---

## 7. Code Locations Cheat Sheet

Key files and line numbers for anyone picking this up:

| Concern | File | Lines |
|---------|------|-------|
| Stable cache key setter | `src/services/api/codex-fetch-adapter.ts` | 41-44 |
| Stable cache key used in body | `src/services/api/codex-fetch-adapter.ts` | 447-457 |
| `session-id` header | `src/services/api/codex-fetch-adapter.ts` | 1232-1250 |
| `conversation-id` header | `src/services/api/codex-fetch-adapter.ts` | 1218-1230 |
| Routing map load/save | `src/services/api/codex-fetch-adapter.ts` | 50-83 |
| Cache key set at bootstrap | `src/setup.ts` | 89 |
| Volatile context split | `src/services/api/instructionAssembly.ts` | 23, 38-84 |
| Volatile context prepend bug | `src/services/api/instructionAssembly.ts` | 115-123 |
| `recordCacheStat` + stats window | `src/services/api/codex-fetch-adapter.ts` | 103-141 |
| `getCodexCacheStats` (for `/cache-stats`) | `src/services/api/codex-fetch-adapter.ts` | 124-141 |
| Pre-request log (Phase 4 addition) | `src/services/api/codex-fetch-adapter.ts` | ~1253 |
| Post-response log (Phase 4 addition) | `src/services/api/codex-fetch-adapter.ts` | ~1295 |
| `finishStream` COLD/WARM/PARTIAL log | `src/services/api/codex-fetch-adapter.ts` | ~1070-1095 |
| `shouldLogDebugMessage` (the gate that ate all our logs) | `src/utils/debug.ts` | 104-125 |
| `getSystemContext` (has `gitStatus`, `cacheBreaker`) | `src/context.ts` | 116-149 |
| `getUserContext` (has `currentDate`, `claudeMd`) | `src/context.ts` | 155-189 |
| Endpoint URL | `src/services/api/codex-fetch-adapter.ts` | 1171 |

---

## 8. How The Codex Path Works (Quick Map)

1. User sends a message → `src/query.ts:485` → `buildProviderInstructionAssembly({ provider: 'openai', ... })`
2. That returns `{ openAIInstructionAssembly: { instructions, inputMessages } }` where `instructions` is the stable system prompt and `inputMessages` has the volatile preamble prepended (BUG, see 4.2)
3. `src/services/api/claude.ts:1608-1619` builds `_openaiInstructionAssembly` payload, attaches to request body
4. Anthropic SDK's `fetch` is intercepted by `codex-fetch-adapter.ts`
5. `translateToCodexBody(anthropicBody)` extracts the payload, builds `codexBody` with `prompt_cache_key`, calls `https://chatgpt.com/backend-api/codex/responses`
6. Response (SSE stream) is translated back to Anthropic format by `translateCodexStreamToAnthropic`
7. On `response.completed`, `finishStream` extracts `input_tokens`, `cached_tokens`, records stats, emits Anthropic-style `message_delta` with `cache_read_input_tokens` set

The key thing to understand: the adapter's `anthropicBody._openaiInstructionAssembly` IS the Phase 3 split. What gets sent as `instructions` to the server is the stable-only version. What gets sent as `input` messages is the volatile-preamble-prepended (BUGGY) version.

---

## 9. Reading A Session File For Cache Data

This is the Python snippet used to extract cache data from a JSONL session file. Use this for post-hoc analysis until Section 4.1 is fixed.

```python
import json, sys

path = '$HOME/project/transcripts/<session-id>.jsonl'
with open(path) as f:
    lines = [(i, json.loads(l)) for i, l in enumerate(f, 1) if l.strip()]

# Real API calls = assistant messages with input_tokens > 0
api_calls = []
for lineno, d in lines:
    if d.get('type') == 'assistant':
        u = d.get('message', {}).get('usage', {})
        if u.get('input_tokens', 0) > 0:
            api_calls.append({
                'L': lineno,
                'model': d.get('message',{}).get('model',''),
                'input': u['input_tokens'],
                'read': u.get('cache_read_input_tokens', 0),
                'create': u.get('cache_creation_input_tokens', 0),
                'output': u.get('output_tokens', 0),
            })

total_read = sum(c['read'] for c in api_calls)
total_input = sum(c['input'] for c in api_calls)
total = total_input + total_read
hit_rate = total_read / total * 100 if total else 0
print(f'Hit rate: {hit_rate:.1f}%')
for c in api_calls:
    tot = c['input'] + c['read']
    pct = c['read']/tot*100 if tot else 0
    label = 'HIT' if pct > 50 else 'MISS'
    print(f'L{c["L"]:<5} {label} read={c["read"]} input={c["input"]} ({pct:.0f}%)')
```

Note: `cache_creation_input_tokens` is always 0 on the Codex path — ignore it.

---

## 10. Recommended Next Steps (In Order)

**Already done:**
- ✅ Step 1: Debug-log gate fixed (`src/utils/debug.ts`, `ALWAYS_LOG_PREFIXES` allowlist)
- ✅ Step 2: Phase 3 prepend bug fixed (`src/services/api/instructionAssembly.ts`, plain tail append)
- ✅ Step 3: Controlled tests ran (5 short turns). First pass: 0%. Post-fix: **47.5%** (Section 2.7).
- ✅ Step 4 / 4b: Hypotheses C, D, E, G ruled out by the test data.
- ✅ Step 6: Hypothesis F (`previous_response_id`) ruled out — server returns 400 (Section 2.6).
- ✅ Step 7c: Hypothesis I (originator value) fixed as part of the upstream-alignment patch.
- ✅ **Hypothesis L (client identity fragmentation) CONFIRMED and FIXED.** Upstream openai/codex uses one `conversation_id` per CLI session, injected into three places: body `prompt_cache_key`, header `session_id` (underscore), header `x-client-request-id`. Originator is `codex_cli_rs`. Our code had wrong names, wrong values, and three different UUIDs. Now aligned. See Section 2.7 and Section 6 Hypothesis L.

**Current state:** Hit rate is **47.5% on repeated identical protocol**, up from 0% / 1.7%. The remaining gap is explained by two known structural issues below.

**Still to do:**

### Step A: Fix resume cold-start (Plan B) — ✅ DONE

**Symptom:** Each `--resume` starts a fresh CLI process with a new session UUID. `setup.ts` called `setCodexPromptCacheKey(getSessionId())` before `sessionRestore.ts:523`'s `switchSession(oldSid)` ran, so `conversation_id` stayed pinned to the fresh UUID and turn 1 missed.

**Fix:** Register an `onSessionSwitch` listener in `setup.ts` that re-calls `setCodexPromptCacheKey` whenever the active session ID changes. The `--resume` flow already calls `switchSession(oldSid)` after `setup()`, so this listener catches it automatically without touching the resume path itself.

**Verification:** A synthetic pre-resume session ran several turns, then was
resumed with debug logging enabled. The first post-resume request was a partial
hit rather than a cold turn. Expected: hit rate on resume-heavy flows should now
stay close to the same-session baseline.

### Step B: Understand the 13,824-token cache ceiling

**Symptom:** PARTIAL hits cap at exactly 13,824 cached tokens regardless of how much conversation history has accumulated. That number corresponds roughly to the 30,539-byte `instructions` block (the stable prefix). Nothing past the instructions block is being cached server-side.

**Hypotheses to test (cheap, passive):**
- Does adding a second, larger stable prefix (e.g., system tools summary) lift the ceiling? → tells us whether it's a size cap on what gets cached vs a prefix-only cache.
- Does the first user message get cached if it's byte-identical and comes early enough? → tells us whether history caches at all, or only the initial `instructions`.

No code change required to measure — just inspect `cached_tokens` vs cumulative input across turns in an existing debug log. Any turn where `cached_tokens > 13,824` would falsify the ceiling hypothesis.

### Step C: Only if A+B don't close the gap

Revisit Hypothesis B (node affinity) — the server may be pinning cache entries to a specific edge node, and even with a stable `conversation_id` we might be hitting different nodes on some turns. Check `req_id` / `x-cache` / `cf-ray` headers in the debug log for patterns across hit vs miss turns.

---

## 11. What I'm NOT Sure About

Honest enumeration of speculation vs fact (updated revision 5):

- **SURE:** Baseline 1.7% hit rate pre-fix. Post-fix 47.5% hit rate on identical protocol. Data in JSONL + debug logs.
- **SURE:** `cache_creation_input_tokens` is always 0 by adapter design.
- **SURE:** Phase 3 prepended volatile context before the fix (now fixed).
- **SURE:** Debug logging was gated and suppressed pre-fix (now fixed).
- **SURE:** Upstream openai/codex uses one `conversation_id` per CLI session, wired into body `prompt_cache_key` + header `session_id` (underscore) + header `x-client-request-id`; originator is `codex_cli_rs`. Source: `codex-rs/core/src/client.rs`, `codex-rs/codex-api/src/requests/headers.rs`, `codex-rs/login/src/auth/default_client.rs`.
- **SURE:** Our pre-fix code had three different UUIDs across these fields and the wrong originator (`pi`). After alignment, cache hits returned.
- **SURE:** `previous_response_id` is rejected by this endpoint with 400.

- **HYPOTHESIS (LIKELY):** Resume cold-start is caused by new CLI process generating a fresh `CODEX_SESSION_ID`. Not yet verified by code walkthrough of the resume path.
- **HYPOTHESIS:** The 13,824-token cache ceiling corresponds to the stable `instructions` prefix and nothing else is cached. Not falsified; not yet tested at larger prefix sizes.
- **UNVERIFIED:** Whether Hypothesis B (node affinity) also contributes alongside the fixed identity bug.
- **UNVERIFIED:** Whether the 13% baseline from the fix-plan doc was measured under the same pre-fix conditions.
- **UNVERIFIED:** Whether `store: false` affects caching — untouched in this investigation.

Do not treat the hypotheses section as conclusions. Run the verification steps before committing to any fix.

---

## 12. Environment Notes For The Picking-Up Session

- Working dir: `$HOME/project`
- Config dir: `$HOME/project/config/`
- Sessions jsonl: `$HOME/project/transcripts/<session-id>.jsonl`
- Debug logs: `$HOME/project/debug/<synthetic-id>.txt` (only written when `--debug` is on)
- Cache routing file: `$HOME/project/config/codex-cache-routing.json`
- Build: `bun run build:dev:full` → `./cli-dev`
- Do NOT use `bun run build` — that produces `./cli` (standard build) which omits experimental features
- Read the repository `CLAUDE.md` file for project conventions.

Referenced documents:
- `docs/codex/2026-04-30-cache-fix-plan.md` — the original fix plan (Phases 1–4)
- `docs/codex/2026-04-30-cache-fix-plan.md` line 23 — explicit non-goal of `previous_response_id`
- `docs/codex/2026-04-30-cache-fix-plan.md` line 147 — "revisit if only 40-50%"
- `openai/codex#5556` — upstream-acknowledged ChatGPT backend cache degradation
- `src/services/api/codex-fetch-adapter.ts` — the main file you'll be editing
- `src/services/api/instructionAssembly.ts` — where the Phase 3 prepend bug lives
- `src/utils/debug.ts` — where the log gate lives
