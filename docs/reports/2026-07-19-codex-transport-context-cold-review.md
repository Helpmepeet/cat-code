# Codex transport, caching, and context-efficiency cold review

Date: 2026-07-19  
Scope: DONE.md item 100 and its Item 1/2/3 implementation  
Cold-review verdict: **RED — rework before relying on this as a complete production system**  
Post-remediation status: **YELLOW — deterministic defects fixed; live and persistence gates remain**

## Executive summary

The core work is real: record/replay canonicalization, Codex-only tool-output truncation, gpt-to-Claude usage-anchor invalidation, prewarm removal, account-scoped session state, stale-chain reset, and response-failure socket handling are implemented and covered by deterministic tests. The focused suite passes (135 tests, 0 failures), and `bun run build:dev:full` passes.

However, three integrated production paths defeat the intended safety or efficiency guarantees:

1. A WebSocket stream that fails after visible output is correctly refused an internal replay, but the outer query layer then replays the turn through its default non-streaming fallback. This can duplicate visible output or execute a tool twice.
2. The request abort signal and response-body cancellation are not connected to the WebSocket iterator. Esc/cancel can therefore leave a live socket and a locked turn until another server event or idle timeout.
3. Continuation reconciliation trusts the previously sent input prefix by item count only. Same-count context replacements are silently omitted from the wire, so aggregate tool-result replacement and time-based microcompaction may claim local savings while the server continues carrying the old content.

These are production-entry or cross-subsystem failures, not isolated helper defects, and the current tests either stop below the affected seam or explicitly encode the unsafe behavior.

## Remediation completed

All F1-F6 defects were fixed in the same review session:

- the outer query fallback now propagates the partial-stream replay guard;
- request abort and response-body cancellation close the WebSocket, release the conversation lock, and also interrupt queued turns and cold connection setup;
- pre-visible abort no longer marks the conversation for sticky HTTP fallback;
- same-call tool-result replacement forces a clean full send, while structurally unchanged multimodal results remain incremental;
- generic terminal server errors reset the chain and close the physical socket;
- structured Apply_patch JSON and malformed/null/falsy function arguments now record in the same canonical form replay emits.

An independent implementation review found three follow-up defects in the first repair pass (queued/connect-time abort, pre-visible sticky fallback, and reference comparison of multimodal outputs). All three were fixed and re-reviewed as resolved. No additional deterministic runtime finding remains.

## Findings

### F1 — HIGH: partial visible WebSocket output can still be replayed by the outer fallback

`processCodexEvents` detects a recoverable WebSocket failure after visible output and raises `CodexPartialStreamReplaySkippedError` specifically to avoid duplicate output or tool calls (`src/services/api/codex-fetch-adapter.ts:2294-2311`, `:3004-3016`). The outer streaming catch in `src/services/api/claude.ts:2656-2772` does not recognize that error. Unless a feature flag or environment variable disables the general fallback, it calls `executeNonStreamingRequest` and replays the same turn.

Impact: duplicate user-visible text and, when a tool call was already surfaced, possible duplicate tool execution.

Recommended action: always propagate `CodexPartialStreamReplaySkippedError` without non-streaming fallback, and add a production-entry integration test that starts a visible Codex stream, fails it, and proves no second request is dispatched.

### F2 — HIGH: Esc/cancel is not wired to WebSocket transport teardown

The HTTP path forwards `init.signal` to `fetch` (`src/services/api/codex-fetch-adapter.ts:3293-3305`). The WebSocket path calls `streamTurnViaWebSocketLocked` without a signal (`:3406-3423`), and its `ReadableStream` wrapper has no `cancel` handler (`:2513-2534`). The transport closes an abandoned turn only when the async generator's `finally` runs (`src/services/api/codex-websocket-transport.ts:1274-1292`). The current abort test manually calls `gen.return()` (`src/services/api/codex-websocket-transport.test.ts:1221-1275`), which does not verify the real request-abort path.

Impact: Esc or body cancellation can leave the WebSocket open and the per-conversation turn lock occupied until a server event or the 90-second idle timeout, delaying the next prompt and allowing late-event bleed.

Recommended action: pass the abort signal into the WebSocket stream, terminate the iterator on abort, implement response-body cancellation, and test both `AbortController.abort()` and `response.body.cancel()` through `createCodexFetch`.

### F3 — HIGH: length-only continuation reconciliation discards same-count context changes

`reconcileCanonicalDelta` deliberately trusts the entire previously sent input prefix by length and only validates prior output items (`src/services/api/codex-websocket-transport.ts:553-633`). A local probe with a prior full tool result and a current cleared marker returned only the new user message as the delta, with no mismatch. The tests require this behavior for arbitrary prefix drift (`src/services/api/codex-websocket-transport.test.ts:599-647`, `src/services/api/codex-continuation-e2e.test.ts:224-243`).

This collides with real same-count transformations before the request:

- the aggregate tool-result budget replaces content in place (`src/query.ts:397-422`, `src/utils/toolResultStorage.ts:924-935`);
- time-based microcompaction replaces old tool results with a cleared marker without removing the item (`src/services/compact/microCompact.ts:446-529`).

Impact: when either feature changes an already-sent prefix, `previous_response_id` keeps the old server context and the replacement is never transmitted. Local token estimates and compaction state can report savings that did not occur on the server, potentially ending in unexpected context overflow.

Recommended action: distinguish harmless normalization drift from semantic content replacement. At minimum, force a full send and clear/reseed continuation when a content-replacement or microcompact pass changes an item in the trusted prefix. Add integration tests for both transformations.

### F4 — MEDIUM: generic server errors leave the socket open

For a generic `type:error`, the handler resets the continuation baseline and queues an error (`src/services/api/codex-websocket-transport.ts:992-1012`). Dequeuing any queued error sets `reachedTerminalDisposition = true` (`:1172-1181`), so the generator's cleanup does not close the socket (`:1279-1292`). The existing test explicitly expects that bare server errors leave it open (`src/services/api/codex-websocket-transport.test.ts:1151-1215`). By contrast, `response.failed` closes the socket while preserving the prior good baseline (`src/services/api/codex-websocket-transport.ts:1256-1267`).

Impact: late events from the failed turn can reach a reused socket whose messages are not correlated to a response id.

Recommended action: close the socket on generic terminal server errors after applying the correct baseline-reset policy, and change the test to require a fresh socket on the next turn.

### F5 — MEDIUM: valid structured Apply_patch input is not byte-canonical across record/replay

The record-side canonicalizer preserves `custom_tool_call.input` verbatim (`src/services/api/codex-fetch-adapter.ts:849-855`). Decode parses a valid JSON string into an object (`src/utils/messages.ts:2748-2769`), and replay serializes that object compactly (`src/services/api/codex-fetch-adapter.ts:887-899`, `:1200-1211`). Whitespace or key-order differences in a server-provided valid `{ "ops": [...] }` string therefore cause strict output-item mismatch and a safe but unnecessary full send.

Impact: continuation/cache efficiency loss on this valid Apply_patch arm; no data corruption was found.

Recommended action: canonicalize valid structured custom-tool input on the record side using the same deterministic serializer, while preserving the raw non-JSON Apply_patch envelope path.

### F6 — LOW: malformed or null function-call arguments also drift across record/replay

The record canonicalizer can emit `"null"` or preserve malformed argument text (`src/services/api/codex-fetch-adapter.ts:773-805`), while decode maps null/malformed non-Apply_patch input to `{}` (`src/utils/messages.ts:2748-2769`) and replay serializes `block.input || {}` (`src/services/api/codex-fetch-adapter.ts:1213-1221`).

Impact: conservative full-send fallback after malformed provider output. This is mainly a robustness/performance gap.

## Contract conformance

| Contract item | At cold review | After remediation |
|---|---|---|
| Item 1: canonical record/replay | Partial | Common and reviewed edge shapes are byte-stable. Adapter-registration and serialized-resume seam tests remain absent. |
| Item 2: Codex-only truncation and gpt-to-Claude anchor invalidation | Mostly conforming | Unchanged. The wire-only behavior is covered, but the claimed `--resume` byte-identity gate is not directly tested by serializing, loading, and retranslating a transcript. |
| Item 3: remove prewarm and harden WebSocket lifecycle | Non-conforming | Deterministic lifecycle behavior now conforms for replay refusal, active/queued/connect-time abort, body cancellation, context replacement, generic error, stale chain, account rotation, and response failure. Live multi-hour evidence remains unverified. |

## Verification evidence

- `bun test src/services/api/codex-websocket-transport.test.ts src/services/api/codex-fetch-adapter.test.ts src/services/api/codex-continuation-e2e.test.ts src/services/api/codex-item-canonicalization.test.ts src/utils/tokens.test.ts src/services/compact/autoCompact.test.ts` — **135 pass, 0 fail, 346 assertions**.
- `bun run build:dev:full` — **PASS**; map lint completed with advisory warnings and the development CLI was produced.
- Read-only reconciliation probe — replacing a prior full tool result with `[Old tool result content cleared]` at the same item count produced `delta=[new user item]` and `mismatchReason=null`, confirming F3.
- Post-remediation focused battery (the six suites above plus `src/services/api/claude-streaming-fallback.test.ts`) — **147 pass, 0 fail, 389 assertions**.
- Post-remediation `bun run build:dev:full` — **PASS**; CLI `2.1.87-dev.20260718.t201415.shac2eb9be5` produced. Map lint passed with eight pre-existing advisory warnings; lint reported zero errors (the repository-wide app-file ignore warnings remain).
- Independent implementation review — all three first-pass follow-up findings rechecked as resolved; no additional scoped regression found.

## Confidence gaps / not run

No live account, credentials, quota, or GUI flow was used. The following remain unverified in this cold review:

- the documented multi-hour warm-bust/prewarm trend;
- live Esc behavior and late server events;
- a real `--resume` wire-dump byte comparison;
- live gpt-to-Claude context-limit/autocompact behavior;
- live server output-item taxonomy and unknown-field behavior.

The original deterministic evidence was strong enough for the RED verdict because F1-F4 were visible in integrated control flow and F3 had a direct local reproduction. After remediation, deterministic evidence supports YELLOW rather than GREEN until the live, serialized-resume, and remaining registration-seam gates above are exercised.
