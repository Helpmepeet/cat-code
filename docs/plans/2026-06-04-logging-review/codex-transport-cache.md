# Logging review: Codex transport & prompt cache

## Summary

The Codex transport and prompt-cache subsystem is, on the whole, exceptionally
well instrumented for production diagnosis. The WebSocket transport
(`codex-websocket-transport.ts`), the fetch adapter (`codex-fetch-adapter.ts`),
instruction assembly, and the network-recovery path in `withRetry.ts` all carry
rich, leveled diagnostics, and the cache-critical signal correctly uses the
always-on `[codex-cache]` prefix (set-key, request, route headers, WARM/COLD/PARTIAL
hit rate, stale-response-id retry, reasoning replay). Confirmed cache **breaks**
are additionally persisted to session JSONL (`recordPromptCacheBreak`) and BQ
(`tengu_prompt_cache_break`), so they survive a production bug report even with
debug off. The audit found **one real gap**: the "caching never turned on at all"
signal — the single most likely shape of a user "cache stopped working" report —
is the one cache path that is NOT durably recorded in production. Everything else
is adequate; a few `[provider]`/`[cost]` missing-usage logs are gated off but are
backed by other durable records, so they are left as-is.

## Findings

| Feature | Location | State | Recommendation |
|---|---|---|---|
| #37 user-visible cache warnings | `promptCacheBreakDetection.ts:545-558` | **gap** | The zero-cache-tokens-on-call-#2+ branch pushes a UI warning and logs `[PROMPT CACHE] zero cache tokens…` at `warn`, then `return`s early — it never reaches `recordPromptCacheBreak` (JSONL) or `logEvent` (BQ). For a non-ant user with debug off, `[PROMPT CACHE]` is gated, so there is **no durable record** that caching was never active — exactly the "cache stopped working from turn 1" report. Change the existing log to the always-on prefix and level it as a warning: `logForDebugging(`[codex-cache] zero cache tokens on call #${state.callCount} model=${state.model} querySource=${querySource} — caching may be inactive`, { level: 'warn' })`. Does NOT need a new framework; just adopt the `[codex-cache]` ALWAYS_LOG prefix already used elsewhere in the domain. Rationale: this is the single cache-regression shape with no other production footprint. |
| #16 header underscore fix / cache 0% | `codex-fetch-adapter.ts:2806-2807`, `finishStream` `2398-2422` | **adequate** | Headers are emitted with correct underscores inline; a regression would manifest as `[codex-cache] COLD cached=0/…` (always-on, `warn`) on every turn. No assertion log on header form is needed — the hit-rate log is the regression signal. |
| #15 context window / #46 sticky HTTP fallback | `codex-fetch-adapter.ts:89-103`, `2511-2545`, `2957-2962` | **adequate** | `sticky_http_fallback` set/expire and every classification (`idle_timeout`, `closed_before_completed`, `stream_transport_error`) log at `warn`. Transport choice and fallback are also persisted via `recordCodexStreamSurface` JSONL. |
| #33 resume cold-start rebind | `setup.ts:90-97`, `codex-fetch-adapter.ts:76-79` | **adequate** | `setCodexPromptCacheKey` logs `[codex-cache] prompt_cache_key set…` (always-on) on initial set AND on every `onSessionSwitch` rebind, so a missed-resume cold miss is diagnosable. |
| #34 reasoning round-trip | `codex-fetch-adapter.ts:797-799`, `1740-1743` | **adequate** | Replay and stream reasoning items log `[codex-cache] replay reasoning…` / `[codex-cache] stream reasoning item encrypted=…` (always-on), including the `ABSENT` case that would pin the cache ceiling. |
| #35/#36 WS chaining, stale id, 60-min, premature close | `codex-websocket-transport.ts:299-323, 416-435, 728-741, 925-936, 998-1036, 1050-1058` | **adequate** | Reconnect reason, continuation-preserved, prewarm result, stale-id retry (both `[codex-ws]` and always-on `[codex-cache] stale_response_id_retry`), idle timeout, and onclose/onerror all carry a full `buildDiagContext()` at `warn`. Strong. |
| #38 WS cache cold-miss / prewarm / lastInstructionsHash | `codex-websocket-transport.ts:1108-1112`, `1126-1139` | **adequate** | Recorded response_id logs `instructions_hash` + `output_items`; `CODEX_CACHE_COLD_DIAG=1` gives an opt-in always-on cold-turn dump. Per-turn `recordCodexSendPath` JSONL carries `instructions_hash`, mode, cached/input tokens. |
| #42/#44 stream recovery & non-destructive partial failure | `codex-fetch-adapter.ts:1847-1898`, `2564-2585` | **adequate** | HTTP-fallback switch and `replay_skipped_visible_output=true` (with tool-call/open-block context) both log at `warn` and record stream surface to JSONL. |
| #43 missing-usage crash surface | `claude.ts:3016-3022`, `modelCost.ts:159`, `cost-tracker.ts:295`, `tokenEstimation.ts:327` | **adequate** | Each absent-usage reader emits an explicit `missing_usage` diagnostic instead of crashing. These use `[provider]`/`[cost]`/`[cost-tracker]`/`[token-estimation]` (gated off in prod), but the crash is now prevented and usage is reconstructed via `EMPTY_USAGE`; the value is the no-crash behavior, not the log. Leaving gated is acceptable — promoting to always-on would be noise for a non-fatal, self-healing path. |
| #47 developer role / session_context leak | `instructionAssembly.ts:52-54` | **adequate** | Always-on `[codex-cache] instructions=…B developer_context=…B volatile_keys=[…]` confirms the volatile-vs-stable split on every assembly; a regression that pushes gitStatus back into cached instructions would show `volatile_keys=[]` plus a cache COLD turn. |
| #70 network-recovery stuck state | `withRetry.ts:695-776` | **adequate** | Suspected-outage detection logs `[codex-pool] Suspected network outage… waiting Nms` and emits `account.transient_failure` diagnostics; failover reassignment logs the lease move. (Minor: the *recovery* (outage cleared, `codexNetworkOutageHandled` reset / keep-alive re-enabled) is not explicitly logged, so logs show the wait but not the all-clear. Low value — a successful subsequent turn implies recovery — not worth a change on its own.) |

## Notes

- No over-logged / noise findings in this domain; the verbose `[codex-ws]`/
  `[codex-fetch]` logs are appropriately leveled (`warn` for failures, `debug`
  for the per-turn incremental/full-send accounting which is `debug`-gated).
- Recommended change count: **1** (the #37 zero-token early-return prefix swap).
  All other features are adequately observable in production.
