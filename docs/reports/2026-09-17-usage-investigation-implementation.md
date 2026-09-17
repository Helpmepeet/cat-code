# Usage investigation and token estimates

Date: 2026-09-17. User-authorized first implementation slice of the revised
Usage roadmap. GPT-5.6 Sol implemented code and tests; the primary agent owned
the measurement audit, integration checks, and documentation.

## Result

The selected-day session table now includes leaders by tokens, tool requests,
and recorded errors. A low-token session with many failures can appear even
when it would have fallen outside the previous top-by-tokens list. Selection
remains bounded, and the table identifies omissions and limits sorting to the
shown sessions. Existing conversation Open/Restore navigation is retained.

Session rows and their expanded model details show estimated token costs using
configured standard API rates. Unknown models and cache-write tokens without
write-duration detail remain unpriced. A partial amount is labeled a priced
subtotal with token coverage; tiny positive amounts and nearly complete coverage
do not round into misleading zero-cost or fully-covered claims.

These estimates currently cover recognized configured Claude IDs for fresh
input, cache reads, and output. GPT models have no configured rates in this
catalog and remain unpriced. The feature does not report actual billing,
subscription spend, historical price schedules, speed premiums, or non-token
service charges.

## Implementation

- [statsUsage.ts](../../src/utils/statsUsage.ts) calculates costs from canonical
  usage deltas before grouping and assigns day-wide ordinal ranks. Existing
  token, deduplication, cache-reporting and matched-error semantics are retained.
- [usageSummary.ts](../../app/sidecar/usageSummary.ts) selects leaders across
  three metrics before filling remaining slots by token rank. Existing
  20/10/5/0 row fallback tiers and the 256 KiB envelope remain. Grouped models
  preserve priced subtotals and priced-token counts.
- [modelCostRates.ts](../../src/utils/modelCostRates.ts) shares existing rate
  data with the live-query calculator through an exact-ID lookup that does not
  use settings, unknown-model fallback or live fast-mode state. Primitive model
  catalog types stay local to [configs.ts](../../src/utils/model/configs.ts),
  preventing the desktop type graph from importing auth/settings code.
- [The snapshot contract](../../app/shared/usageDashboard.ts) and
  [validator](../../app/shared/usageStatsWorker.ts) require counting v6/pricing
  v1 and validate amount bounds, reconciliation, and contributor ranks.
  Old summaries rebuild from index-v4 without rereading unchanged transcripts.
- [UsageSessionContributors.tsx](../../app/renderer/src/UsageSessionContributors.tsx)
  adds the cost column, model subtotals, shown-row cost sorting, and accurate
  omission messages. No new top-level page or inbound operation is added.

## Verification

- Focused pricing/accounting/grouping/validation and user-visible-text checks:
  **58 passed**.
- Separate Usage renderer/navigation checks: **21 passed**.
- Real disposable cached-worker probe: passed. The final local fixture measured
  about 591 ms cold and 21 ms cached; this is not a performance guarantee.
- Desktop typecheck: passed after correcting a type-import dependency leak
  introduced by the first pricing extraction. No typecheck exclusions or
  diagnostic suppressions were added.
- Scoped sidecar typecheck, renderer build, engine `build:dev:full`, undefined-name
  gate, and diff whitespace check: passed.
- Maps lint: passed with seven existing recommended-section warnings.
- Broad desktop suite: **4,995 passed, 36 failed, 10 errors** across 315 files
  (5,031 tests, 29,008 assertions, about 878 seconds). The run encountered Unix
  socket permission/listen/readiness failures, missing Anthropic credentials,
  process-identity probe failures, and an archived temporary-test import error.
  Usage tests passed within that run. This is not a full-suite pass; no broad
  failure was suppressed or repaired as part of this slice.

All test state was isolated. No provider request, live account refresh, GUI
launch, installation over the active app, or push was performed for this slice.

## Scope and acceptance

This is an authorized extension to the existing Usage flow, not a new prototype
redesign. Existing dirty Usage page, styling, packaging, and unrelated task edits
were preserved. Visual acceptance remains unverified.

Operator check after launching an updated Cat Code Dev: open Usage, select a
day in 7 days or 30 days, sort the shown sessions by recorded errors, and confirm
the omission note explains which leaders are included. Inspect a supported
Claude session's cost and expanded model details; mixed/unknown pricing should
show subtotals or Unpriced. Open an available conversation and return to Usage
to verify the selected range/day remain. Check the added column at narrow width.

Timing persistence, retry relationships, the session timeline and aggregate
latency remain subsequent slices. The
[measurement audit](2026-09-17-usage-measurement-audit.md) records the existing
Codex diagnostic opportunities, missing joins, and implementation requirements.
