# Usage summary period deltas

## Scope

Operator approved real changes beside the summary-card sparklines and requested
Terra for implementation. Terra owns retained-history aggregation, validation,
and index/cache compatibility; the parent owns rendering and final integration.
No new dependency, account operation, or raw transcript field crosses to the UI.

## Comparison semantics

- Seven-day and 30-day cards compare their current observed UTC interval with
  that interval shifted back seven or 30 days, including the same ending time.
  For example, Sep 7 00:00 through Sep 13 12:30 compares with Aug 31 00:00 through
  Sep 6 12:30. This avoids comparing an incomplete current day with a full prior day.
- Total tokens, tokens per active day, unique sessions and tool requests use
  `(current - previous) / previous * 100`. Each interval has its own exact count
  of active days and unique sessions; neither is inferred from grouped All data.
- Cached input uses percentage-point change, preserving the ratio of summed input
  tokens. A change from 90% to 95% displays `▲ 5 pp`, not a relative 5.6% increase.
- All has no previous-period delta. Incomplete coverage or retained history that
  begins after the baseline start suppresses the baseline. Earliest retained
  history is conservative evidence, not a claim that no older history was deleted.
- Count baselines of zero and missing cache ratios omit their indicators. A
  measured zero cache share still permits a percentage-point comparison. Changes
  round to one decimal place, and values rounding to zero use a neutral `0%`/`0 pp`.
- Indicators provide the baseline dates and UTC cutoff in their tooltip and
  accessible description. The unchanged sparkline stays on the other side of the
  card footer; wrapping prevents long deltas from overlapping it.

## Data flow

`UsageRangeSummary.previousPeriod` is a bounded optional summary with tokens,
records, unique sessions, requests, active days and cached-input share, plus
inclusive start/end bounds. The collector computes it through the same token
normalization and identity handling as current usage. No baseline day series,
contributors, model list or additional transcript reads are sent to the renderer.

The counting version advances to 5 so old derived snapshots rebuild from indexed
records. The stored source-record format stays unchanged. Same-day warm reuse
must account for both current and shifted baseline eligibility cutoffs; a newly
eligible baseline record requires recomputation even when source files did not
change. The existing 256 KiB response cap remains in force.

## Verification

- Renderer and dashboard regression checks: **51 passed, 0 failed**, 272 assertions.
- Worker boundary and integration checks: **21 passed, 0 failed**, 111 assertions.
- Terra's backend, validator and index checks: **40 passed, 0 failed**, 219 assertions.
  These overlap the boundary checks above and are not an additional unique total.
- App typecheck, scoped sidecar typecheck, renderer build, isolated usage-worker
  probe, maps lint and diff whitespace checks passed.
- Engine `build:dev:full` passed after production changes; subsequent additions
  were tests only. Build output: `2.1.87-dev.20260916.t104406.shac426fa2b`.
- Coverage includes exact 7D/30D cutoffs, distinct sessions, subagent-only active
  days, missing/partial/zero baselines, percentage-point changes, advancing warm
  cutoffs without source rereads, and rebuilding old v4 snapshots.

No live GUI acceptance or installed-app update is claimed. The running Dev main
process needs a restart to load the updated shared validator; renderer hot reload
alone cannot do that.
