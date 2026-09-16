# Usage: All retained history and visible trends

Implemented the operator's five changes with a backend subagent and renderer work
in parallel. The other task's committed dashboard copy cleanup and uncommitted
main/packaging changes were preserved.

## Result

- All beside 7/30 days, with exact retained-history totals through the UTC cutoff.
- Model donut with color key, count/share details, and optional model highlight.
- Cache trend always visible. Matching shaded tool-request trend shows requests
  per day, hover preview and explicit click/keyboard selection.
- Prompt cache and tool activity occupy equal supporting columns; narrow layouts
  stack them. Unreported cache writes disappear from the summary and values table,
  and the cache summary reflows to two columns. Reported zero remains visible.
- All histories with over 180 recorded dates group into explicit N-day buckets.
  Calendar positioning keeps gaps truthful; missing requests are zero in complete
  history and missing cache percentages break the curve. Totals are never sampled.
  Long-period session counts are unique per bucket. All omits contributor tables
  and the hourly grid; 7/30-day drilldown remains available.

## Source owners

- `src/utils/statsUsage.ts`: full-history collection and bounded grouping.
- `app/shared/usageDashboard.ts`, `usageStatsWorker.ts`: All contract and validation.
- `app/sidecar/statsDomain.ts`: bounded complete worker envelope.
- `app/renderer/src/UsagePage.tsx`, `UsageOverviewDetails.tsx`: period and layout.
- `UsageAreaTrend.tsx`, `usageTrendState.ts`, `UsageDashboardCharts.tsx`: shared
  trends, correct time positions and date-range readouts.
- `app/renderer/src/usageDashboard.css`: donut, chart and cache-column layout.

The existing SQLite format remains unchanged. Old two-range saved snapshots are
rejected and rebuilt using indexed records; unchanged transcripts are not reread.
The 256 KiB worker cap remains enforced. A last-resort fallback may omit recent
contributors with explicit omitted counts. No raw transcript text, account probes,
new dependencies, engine sessions or installed-app changes were introduced.

## Verification

- 74 tests / 742 assertions across 14 affected renderer, main-runner, shared,
  sidecar, accounting, index, UTC-window and user-visible-copy suites passed.
- Separate real worker cold/cache probe: 1 test / 6 assertions passed, with isolated
  account storage deliberately unusable. Total: **75 tests, 0 failures**.
- Desktop typecheck / Fast Refresh lint passed.
- Scoped sidecar typecheck passed; 5,573 existing upstream diagnostics ignored.
- Engine `build:dev:full` and renderer build passed. Existing map recommendations
  and renderer chunk-size warnings remain.
- All regression fixtures cover older history, cutoff/future exclusion, exact
  grouped totals and distinct sessions, sparse ancient dates, old-cache rebuild,
  and a 1,100-day / 33,000-call snapshot fitting the worker cap.
- DOM checks cover All selection, visible trends, absence of unreported writes,
  hover without navigation, selected-day counts, and clearing chart selection.

Logs: `/tmp/cat-usage-all-tests.log`, `/tmp/cat-usage-all-worker-probe.log`,
`/tmp/cat-usage-all-types.log`, `/tmp/cat-usage-all-sidecar-types.log`,
`/tmp/cat-usage-all-engine-build.log`, `/tmp/cat-usage-all-renderer-build.log`.
The full desktop suite previously hit repeated sandbox socket-readiness failures;
this pass used the affected suites, not a claimed full-suite pass.

## Visual acceptance and operator check

**UNVERIFIED:** live desktop/narrow-layout appearance. The previous isolated local
preview was denied by browser URL policy; no alternate route was used to bypass it.
This is engineering completion, not a visual-fidelity acceptance claim.

When launching Cat Code Dev for an operator check from the repository root:

```bash
CATCODE_TEST_CWD_ALLOWLIST=/Users/pt/cat-code \
CATCODE_INITIAL_CWD=/Users/pt/cat-code \
CATCODE_DEBUG_STATE=1 bun run --cwd app dev
```

Wait for `[main] renderer ready`, then open Usage without creating a chat session.
Check 7 days, 30 days and All; compare the shown date span and totals. Confirm the
donut and both trends are visible, hover previews do not open a day, and click or
Enter does. Check that Clear selection clears the tool point. With unreported
writes, confirm two evenly sized cache values. Resize below 820 px to verify stacked
panels. For long histories, confirm N-day labels and date-range tooltips. Native
hover and visual checks remain operator-driven.

## Scope flags

- 🔁 Adapted at user request: donut, visible trends, absent write-cell reflow.
- 🔁 Adapted for bounded All history: explicit multi-day buckets and recent-only
  session/hourly detail.
- ⬜ Deferred: live visual acceptance; installed app has not been updated.
