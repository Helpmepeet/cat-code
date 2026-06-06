# Logging review: Context window, auto-compaction, goal accounting & cache warnings

## Summary

The compaction subsystem is well instrumented for *analytics* (`tengu_compact`,
`tengu_auto_compact_succeeded`, `tengu_compact_failed`, `tengu_prompt_cache_break`
all carry rich token/threshold/cache breakdowns) and has one genuinely durable
production breadcrumb: the **compact boundary message** persisted to the session
JSONL transcript with `trigger` (auto/manual), `preTokens`, and
`messagesSummarized` (`messages.ts:4655`). That answers "when did it compact, why,
and how big was context before." The cache-warning surfaces (#37/#50) are strong:
the #50 server-shrink diagnostic (prefix-prune vs in-place, cascading-eviction
flag) is embedded in `reason`, which is persisted via `recordPromptCacheBreak`
(JSONL) **and** surfaced to the user via the `pendingCacheWarnings` queue drained
by the REPL — so #50 is adequately covered in production. (#37's "caching never
turned on" early-return persistence gap is owned by the codex-transport reviewer;
not re-litigated here.)

The audit found **one real production gap** and one minor one. The boundary marker
records the *pre*-compact size but **not** the resulting *post*-compact size, so
the single most diagnostic compaction failure mode — "compacted but still over
threshold, will immediately re-compact" (autocompact thrash, the exact class of
bug #59 lived in) — has **no production-durable footprint**; it lives only in the
debug-gated `autocompact:` log and the analytics-only `willRetriggerNextTurn`
field. Everything else (recovery-window sizing #56, post-compact reassembly #59,
goal accounting #57) is either reconstructable from existing durable signal or
indirectly caught by the cache-break detector. #58 is prompt-only — not applicable.

## Findings

| Feature | Location | State | Recommendation |
|---|---|---|---|
| #56/#59 compaction event not durable beyond `preTokens` (thrash invisible) | `compact.ts:626` (boundary created), `compact.ts:671` (`truePostCompactTokenCount` computed), `messages.ts:4670` (`compactMetadata`) | **gap** | The boundary's `compactMetadata` carries only `{trigger, preTokens, messagesSummarized}`. `truePostCompactTokenCount` and the active `autoCompactThreshold` are computed a few lines later but go only to the `tengu_compact` analytics event (`compact.ts:684`, field `willRetriggerNextTurn`) and the debug-gated `autocompact:` log (`autoCompact.ts:370`). In production (non-ant, debug off) both are silent, so a user reporting "it keeps compacting / context looks wrong after compaction" leaves no JSONL trace of *why* (post size vs threshold). Add `postTokens` and `autoCompactThreshold` to `compactMetadata` (both already in scope at the boundary's mutation site, mirroring the existing `preCompactDiscoveredTools` mutation at `compact.ts:636`). This makes the resulting size and the headroom decision durable in the transcript at zero new log volume. No always-log prefix needed — the boundary is already persisted. Rationale: closes the thrash/over-threshold blind spot that #56 (recovery-window sizing) and #59 (post-compact assembly) both regress *into*, using the existing durable sink. |
| #56 autocompact decision silent in production | `autoCompact.ts:370` | **gap (low)** | `logForDebugging(`autocompact: tokens=… threshold=… effectiveWindow=…`)` is the only record of the trigger decision and is debug-gated, so it never writes for non-ant users. This is the "why did it compact at this point" signal. If the boundary-metadata change above lands, the *fired* decision becomes durable (preTokens + threshold in the transcript), so this log does **not** need promotion. Only promote if the boundary change is rejected: in that case change to `logForDebugging(`[compaction] fired tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow}`, { level: 'info' })` and add `[compaction]` to `ALWAYS_LOG_PREFIXES`. Prefer the metadata route — it avoids a new always-on prefix and a per-near-threshold-turn log. |
| #59 post-compact request reassembly | `query.ts:567-574, 694-700` | **adequate** | The fix hoists `buildProviderInstructionAssembly` into the API loop so it reads the reassigned `messagesForQuery` (= `postCompactMessages`). A regression (assembly built from stale pre-compact messages) is indirectly observable: it would manifest as a prompt-cache break with a large drop / `systemPromptChanged`, caught by `checkResponseForCacheBreak` (#50) and persisted via `recordPromptCacheBreak`, and/or trigger an immediate re-compaction now made durable by the boundary-metadata finding above. No dedicated breadcrumb warranted — adding one would log on every healthy compaction for a rare regression. |
| #57 goal token accounting drift | `REPL.tsx:1760-1824` (`accountCompletedTurnThreadGoal`), `threadGoal.ts:399-403` (`calculateThreadGoalContextTokenDelta`) | **adequate** | Accounting is `Math.max(0, end - start)` (positive-growth by design) and is frozen once `status === 'complete'` (`threadGoal.ts:378`). Drift is bounded and non-negative; the value is continuously user-visible in the footer label (`formatThreadGoalFooterLabel`, `threadGoal.ts:509`), so a gross miscount is observed directly. Mid-turn compaction silently under-counts (delta clamps to 0), but that is the documented #57 contract, not a fault. No logging needed. |
| #50 server-context-shrink diagnostic | `promptCacheBreakDetection.ts:678-707, 808-810, 821-872` | **adequate** | The prefix-prune-vs-in-place `mode` string, the cascading-eviction `suspicious` flag (ratio ≥ 10×), and the input-delta are all folded into `reason`, which is (a) persisted to JSONL via `recordPromptCacheBreak` (`:836`), and (b) pushed to the user via `pendingCacheWarnings` (`:871`) and drained by the REPL after the turn. Production-durable and user-visible without debug. The `[PROMPT CACHE BREAK]` debug log (`:810`) is a redundant convenience, not the system of record. |
| #58 goal completion evidence requirements | `threadGoal.ts:561-611` (`renderThreadGoalContinuationPrompt`) | **n/a** | Prompt-only, model-facing text injected into the continuation system-reminder. No runtime branch, token accounting, or decision to observe. Nothing to log. |
| Circuit-breaker trip | `autoCompact.ts:494-500` | **adequate** | After `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` the debug-gated `autocompact: circuit breaker tripped…` (`warn`) is silent in production, **but** the user gets an immediate notification (`notifyAutoCompactCircuitBreaker`, `:499`) telling them to run `/compact`. The user-facing surface is the right channel here; the underlying transient-vs-hard failure classification is captured by `tengu_compact_failed` analytics. No change. |

## Notes

- No over-logged / noise findings in this domain. The `autocompact:` and
  `[PROMPT CACHE]` debug logs are correctly `debug`-gated for high-frequency,
  near-threshold-turn paths.
- Recommended change count: **1** primary (add `postTokens` + `autoCompactThreshold`
  to the compact boundary `compactMetadata` — durable, zero new log volume), with a
  fallback `[compaction]` always-log prefix only if the metadata route is rejected.
- The `tengu_*` analytics events are rich but are *not* a production-local sink for
  a non-ant user filing a bug report (they require telemetry/BQ). The transcript
  boundary marker is the only durable local record, which is why expanding its
  metadata is the highest-leverage, lowest-noise fix.
