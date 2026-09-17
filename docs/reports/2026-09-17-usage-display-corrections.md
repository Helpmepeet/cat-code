# Usage display corrections

The user reported excessive Execution timing explanation and a regression where
four models and thirty tools appeared only as Other.

## Cause and correction

The summary-size fallback coupled named-category limits with session-contributor
limits. After trying twenty and ten contributors, it jumped directly to zero
named categories while keeping five contributors. That could erase every model
and tool name from the graphs even though their underlying records remained
available. This was a display-summary regression, not missing source data.

The correction separates category retention from session detail reduction and
keeps the existing 256 KiB output limit. Tests exercise the production finalizer
with ordinary legacy history and busy measured history, rather than duplicating
its fallback loop. Exact totals, error denominators, range-wide category grouping,
and explicit omission counts remain required.

Previously grouped saved snapshots must also be invalidated: unchanged-history
reuse otherwise skips finalization. Counting version 9 rejects version 8 summaries
and rebuilds them from unchanged index-v5 records, preserving transcript files.

Execution timing keeps three compact metrics with p50/p95 values and nonzero
sample counts. Empty values remain unavailable. Repeated zero-sample labels,
unavailable paragraphs, and explanatory prose are removed from the default view.
The measurements themselves and session timeline behavior are unchanged.

## Verification

- Broader focused renderer/accounting/worker checks: **88 passed, zero failed**.
- Final envelope, index-recovery, validator, grouping, and timing/page checks:
  **52 passed, zero failed** (overlaps the broader focused run).
- Ordinary untimed fixture: four named models and ten named tools remain visible
  under the existing byte limit. Busy measured history retains session timelines.
- A persisted v8 Other-only snapshot rebuilds named models/tools without reading
  unchanged transcript files; subsequent v9 warm reuse preserves that result.
- App and scoped sidecar typechecks, renderer production build, and engine dev
  build pass. Map lint and diff whitespace checks pass.
- Full desktop socket/process suites were not rerun for this narrow correction;
  the earlier broad failures remain documented in the original implementation
  report. No full-suite pass is claimed.

No live account calls, GUI launch, installation, or app restart were performed.
Source/headless evidence does not establish installed-app visual acceptance.
After running the updated app, check Usage: the timing panel has three compact
cards, Model usage has individual model names, and Tools offers named selections.
