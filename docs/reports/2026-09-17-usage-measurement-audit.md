# Usage investigation: measurement audit

Date: 2026-09-17. Source inspection of the local checkout starting at
`fd586335`, including existing working-tree changes. No live account calls,
transcript scans, or GUI observations were performed for this audit.

The user authorized starting the revised Usage roadmap, with implementation
delegated to a smaller model. This document defines the measurement foundation
and the requirements for later timing work. It does not claim that the later
instrumentation or timeline has been implemented.

## Immediate scope

Improve the existing day-to-session investigation and expose configured-rate
token cost only where a price can be established. Keep the existing Usage page,
conversation navigation, retained-history scope, and privacy boundary. Timing,
retry relationships, a session timeline, and aggregate performance are subsequent
slices. A generic evaluation system and new top-level observability pages are
outside the current milestone.

The accounting authority remains
[USAGE-DASHBOARD](../migration/decisions/USAGE-DASHBOARD.md). The new measurement
work must also preserve
[OBSERVABILITY-MINIMUM](../migration/decisions/OBSERVABILITY-MINIMUM.md) and
[SECURITY-MINIMUM](../migration/decisions/SECURITY-MINIMUM.md).

## Metric contract

| Metric | Meaning and denominator | Missing-data and interpretation rules |
|---|---|---|
| Tokens | Exclusive fresh input, cache read, cache write, and output categories after canonical usage accounting. | Retained discovered transcripts, not billing or lifetime account usage. Preserve invalid-record and partial-history coverage. |
| Tool requests | Recorded canonical tool occurrences under the existing session/project/subagent identity rules. | Not model calls; fallback identities and unmatched results remain explicit. |
| Recorded tool error rate | Recorded `is_error` results divided by matched tool results. | Missing results are neither successes nor errors. A command's exit status is not inferred from result text. |
| Day contributors | A session's usage attributed to the selected UTC day, including its subagent contribution. | Day totals are not lifetime session totals. A bounded result must disclose omissions and the ranking used to select it. |
| Estimated token cost | Supported fresh-input, cache-read and output categories multiplied by explicitly supported configured rates. | Unknown models and cache-write tokens lacking duration detail remain unpriced. With partial coverage, the amount is a priced subtotal. Standard configured rates do not establish historical bills, subscription spend, actual fast-mode charges, or non-token charges. |
| Token pricing coverage | Priced token count divided by the recorded token count in the same scope. | This is not percentage of financial cost covered. No-token scopes have no meaningful percentage. Partial history remains a separate limitation. |
| Attempt duration, prospective | One instrumented provider attempt from the specified dispatch boundary to its terminal event. | Separate success, error, and cancellation outcomes. Missing terminal events remain incomplete. Record a clock-safe elapsed duration; do not invent it from adjacent transcript rows. |
| Logical-call duration, prospective | One logical model call across linked attempts, including declared retry waits. | Keep separate from single-attempt duration and session wall time. Define whether setup/account waits belong in the interval. |
| First output timing, prospective | Duration from the declared request boundary to a specified content event. | Response start, first content, first text, and first renderer-visible output are distinct. Unsupported/non-streamed cases are unavailable, not zero. |
| Retry rate, prospective | Eligible logical calls containing a replay attempt divided by eligible logical calls. | Needs explicit call/attempt identities and coverage. A transport recovery that keeps the same response is not automatically a replay. |
| Latency quantiles, prospective | Quantiles of individual measured durations in a defined provider/model/outcome population. | Show sample count and timing coverage; do not average precomputed daily or turn quantiles. Failed/incomplete requests must not silently disappear into a success-only claim. |
| Suspected repetition, future | Repeated behavior supported by comparable actions and outcomes. | High counts alone do not establish a loop. Current Usage projection has no tool inputs; argument comparisons require separately designed derived evidence. |

No metric may claim `session duration = model time + tool time + other`:
operations overlap, subagents run concurrently, and conversations can wait for
the user. First-to-last retained activity, if exposed, is a conversation span.

## Available sources and coverage

### Usage accounting

[The index projection](../../src/utils/statsUsageIndex.ts) retains record
envelopes, assistant message IDs/models/token categories, tool IDs/names, and
tool-result IDs/error flags. It intentionally drops prompt/response text and
tool arguments. System record subtypes and timing/retry fields are not projected.
The model message ID used for usage deduplication is not a complete inventory of
attempts that fail before producing an assistant message.

[The accumulator](../../src/utils/statsUsage.ts) owns canonical counting.
[Summary grouping](../../app/sidecar/usageSummary.ts) bounds outbound detail.
At the audit baseline, contributors were selected by token volume and then
sorted locally in [the contributor component](../../app/renderer/src/UsageSessionContributors.tsx).
Reordering that subset cannot identify day-wide error or cost leaders. New
ranking must select from the full day before applying its bounds, or explicitly
continue to describe itself as sorting only the shown sessions.

### Cost

[modelCost.ts](../../src/utils/modelCost.ts) provides configured Claude tiers and
token arithmetic, but its general calculator is unsuitable as an unqualified
historical dashboard calculator: unknown names fall back to a default model,
fast-mode selection reads live runtime state, and search charges require a
usage field absent from the index. Its cache-write rate also does not distinguish
write durations. Reuse deterministic pricing data/logic with explicit assumptions;
do not import fallback behavior as accounting truth. The first implementation
extracts shared rates into [modelCostRates.ts](../../src/utils/modelCostRates.ts)
and leaves cache-write tokens unpriced because the index lacks write duration.

Calculate priced amounts before model grouping into `Other`, preserving the
subtotal and priced-token count when groups collapse. A rates revision must
invalidate derived price summaries independently of whether source transcripts
changed. Do not silently present an old saved estimate under new rates.

### Shared model-request logging

[logging.ts](../../src/services/api/logging.ts) accepts duration, attempt and
request identity metadata, but
[the public analytics API](../../src/services/analytics/index.ts) and
[OTel event output](../../src/utils/telemetry/events.ts) are inert in this build.
These call sites do not establish persistent request coverage.

[claude.ts](../../src/services/api/claude.ts) records `ttftMs` when the normalized
`message_start` arrives. On the Codex path,
[the adapter](../../src/services/api/codex-fetch-adapter.ts) synthesizes that
message at the beginning of event processing, before consuming the model's
content. Neither fact establishes time to visible text.

`getPreviousRequestIdFromMessages` links consecutive conversation requests, not
retry attempts. Attempt timing resets inside the `withRetry` operation while
the inclusive duration starts earlier. Names and boundaries must remain explicit
when reusing these observations.

### Persisted Codex diagnostics

Some useful timing data already survives outside Usage. In
[sessionStorage.ts](../../src/utils/sessionStorage.ts), `recordCodexRequestStart`,
`recordCodexSendPath`, and `recordCodexStreamSurface` append metadata-only system
records to an owned transcript. They are best effort and do not create a
transcript if no session owns one.

The stream surface records transport, model, first raw/reasoning/text event
durations, completion duration and outcome. However:

- Start/completion records lack a shared unique attempt identity. Their account
  and conversation prefixes are not safe join keys for concurrent requests.
- The adapter's `first_visible_ms` means an adapter frame was emitted, including
  an empty reasoning carrier in some cases. It is not proof of renderer-visible
  content or paint.
- These sources cover the Codex adapter rather than all providers; append
  failures, pre-transcript requests and interrupted operations can be missing.
- They are not currently retained by the Usage index. Their recorded tokens
  must not be added to assistant usage and counted a second time.

These are candidates for a qualified historical diagnostic view, not grounds
for complete historical latency or retry percentages.

### Retries, turn summaries, and traces

[withRetry.ts](../../src/services/api/withRetry.ts) emits API error system
messages with attempt/backoff information on applicable retry paths.
[QueryEngine.ts](../../src/QueryEngine.ts) persists yielded messages when
session persistence is active, then maps both API retry and transport recovery
messages into SDK `api_retry` events. The latter can mean the original response
continued without replay. A dashboard cannot simply count SDK `api_retry` events
as retried logical calls.

[REPL.tsx](../../src/screens/REPL.tsx) has turn-duration messages and an ant-only
API-metrics block that can aggregate request timings into a per-turn median.
The latter block is disabled by its literal external-build condition here;
even where present, a median of per-turn medians would not be the distribution
of request latencies.

[Perfetto tracing](../../src/utils/telemetry/perfettoTracing.ts) requires both
its build feature and runtime environment enablement. It is not an always-on
Usage source or evidence of uniform retained-history coverage.

## Requirements for the next instrumentation slice

1. Mint an engine-owned logical-call ID before execution and an attempt ID for
   each replay. Keep provider response IDs optional. Include session/subagent
   ownership without account secrets or credential paths.
2. Persist bounded start and terminal records with the same identity. Preserve
   an incomplete attempt when no terminal record is observed. Instrumentation
   must not change retry, cancellation, or watchdog behavior.
3. Use declared timing boundaries and elapsed durations. Capture first content
   or text separately from response-start metadata. Renderer paint timing, if
   desired, requires its own explicitly scoped observation.
4. Record transport recovery separately from replay, even if an existing SDK
   display event shares a name. Ensure account failover and streaming fallback
   have understandable ownership in the same logical call.
5. Reuse the metadata-only persistence/index path with closed fields, bounded
   retention and versioned projection. Do not enable raw telemetry exports or
   copy debug logs/tool arguments into the dashboard.
6. Establish an eligible-start population before displaying timing/retry
   coverage. Show provider/path limitations and sample counts. Keep request
   accounting separate from canonical billable-token accounting.
7. Verify success, retry-to-success, terminal failure, cancellation, interruption,
   concurrent subagents, transport continuation, old history and missing data
   with isolated fixtures before adding a timeline or aggregate latency cards.

## Verification and limits

This audit follows source paths rather than sampling the user's private history.
It therefore establishes field semantics and persistence opportunities, not
actual provider coverage percentages. The implementation report for the first
milestone records its own tests and user-visible scope. GUI acceptance remains
separate from source and headless verification.
