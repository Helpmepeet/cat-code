# Codex Backend Slowness — Current Code Review

**Date:** 2026-04-24
**Scope:** Current source-code investigation only
**Status:** Code-level conclusion; needs fresh runtime repro after fixes

## TL;DR

The current code has real reasons to be slower than upstream `openai/codex`, even without relying on old JSONL timing data.

Most likely causes, in order:

1. Fast mode is not mapped to Codex `service_tier: "priority"`.
2. Sticky HTTP fallback can disable WebSocket continuation for the rest of a conversation.
3. The OpenAI/Codex path is still an Anthropic compatibility adapter, not a native Codex request/history pipeline.
4. Full sends are still possible and expensive when continuation falls back.
5. There is no obvious local request-compression path.

Old JSONL sessions are useful history, but they should not be used as proof of current behavior because the WebSocket continuation code has changed.

## Current Evidence

Targeted current tests pass:

```bash
bun test src/services/api/codex-continuation-e2e.test.ts \
  src/services/api/codex-websocket-transport.test.ts \
  src/services/api/codex-fetch-adapter.test.ts
```

Result during this investigation: `37 pass, 0 fail`.

This means the older strict-prefix continuation bug is at least partly fixed in current source. In particular, the current WebSocket code has canonical reconciliation that tolerates omitted reasoning items.

## Finding 1: Fast Mode Is Not Mapped To Codex Priority Tier

`src/services/api/claude.ts` computes `speed = 'fast'` for supported fast-mode turns.

Current Codex adapter behavior:

- `src/services/api/codex-fetch-adapter.ts` builds `codexBody` in `translateToCodexBody(...)`.
- It sets `model`, `store`, `stream`, `instructions`, `input`, `tool_choice`, and `parallel_tool_calls`.
- It maps effort to `reasoning.effort`.
- It does not set `service_tier`.

Upstream `openai/codex` behavior:

- `codex-rs/core/src/client.rs` maps `ServiceTier::Fast` to `service_tier: "priority"`.

Conclusion:

If upstream Codex is running with fast/priority tier and this fork is not, this is the cleanest explanation for a consistent speed gap that is not caused by reasoning effort.

## Finding 2: Sticky HTTP Fallback Can Disable WebSocket Continuation

`src/services/api/codex-fetch-adapter.ts` keeps a module-level `stickyHttpFallbackConversations` set.

When some WebSocket stream failures occur, the conversation is marked sticky HTTP fallback. Later turns check `hasStickyHttpFallback(conversationId)` and skip the WebSocket path entirely.

Impact:

- WebSocket supports `previous_response_id` continuation.
- HTTP fallback does not use that continuation path.
- A temporary WebSocket failure can make the rest of the conversation behave unlike upstream Codex.

This is likely a real current-code latency risk. It prevents repeated broken WebSocket attempts, but it can also make a session permanently slower after one transient transport problem.

## Finding 3: The Codex Path Is Still An Anthropic Compatibility Adapter

The current OpenAI/Codex path is:

```text
Anthropic Messages request
  -> _openaiInstructionAssembly
  -> normalizeMessagesForAPI(...)
  -> translateToCodexBody(...)
  -> ChatGPT Codex Responses backend
  -> translate Codex stream back into Anthropic SSE
```

Important files:

- `src/services/api/claude.ts`
- `src/services/api/codex-fetch-adapter.ts`
- `src/services/api/codex-websocket-transport.ts`
- `src/services/api/instructionAssembly.ts`

This is structurally different from upstream Codex, which owns its native Responses request, WebSocket session, request metadata, and response item history directly.

Reasoning state is no longer surfaced as visible text in the current adapter, but encrypted reasoning continuity is still carried through synthetic Anthropic `thinking.signature` blocks and translated back into Codex `reasoning` input items. That is more fragile than native Codex response item history.

## Finding 4: Full Sends Are Still Possible

The current WebSocket continuation code is more robust than older logs suggest, but it can still fall back to a full send.

Current full-send causes include:

- no prior `response_id`
- non-input request fields changed
- stale `previous_response_id`
- current input shorter than canonical baseline
- output item mismatch
- message content drift
- tool input drift

When a full send happens on a large session, latency can jump even with good TTFB because the backend has to ingest and process a much larger request.

## Finding 5: No Obvious Local Request Compression

Upstream Codex has a request-compression path for Codex backend requests.

In the local adapter, there is no obvious `zstd`, `Content-Encoding`, or equivalent compression path in:

- `src/services/api/codex-fetch-adapter.ts`
- `src/services/api/codex-websocket-transport.ts`

This matters most on full sends and large-history turns.

## What Not To Conclude

Do not conclude from old JSONL alone that current builds are still dominated by the old strict-prefix reasoning mismatch.

Current source has:

- canonical WebSocket reconciliation
- tests for normalization drift
- tests for omitted reasoning around assistant message/tool output

So the current question is not "does the old bug still exist exactly as logged?" The current question is whether slow turns are coming from:

- standard tier instead of priority tier
- sticky HTTP fallback
- fresh full-send fallback reasons
- no compression on large sends
- adapter overhead

## Recommended Next Steps

1. Add Codex `service_tier` support. Fast mode should produce `service_tier: "priority"` when the active provider is OpenAI/Codex and the account/backend supports it.
2. Add `continuation_reason`, `transport_path`, and sticky-HTTP state to `codex_send_path` JSONL entries.
3. Reconsider sticky HTTP fallback lifetime. Permanent per-conversation fallback is conservative but can hide recovery and make transient WebSocket failure look like persistent backend slowness.
4. Add a fresh current-build repro after the above diagnostics. Compare:
   - WebSocket + standard tier
   - WebSocket + priority tier
   - sticky HTTP fallback
   - full-send fallback
   - incremental continuation

