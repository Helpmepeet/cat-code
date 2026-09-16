# Usage graphs from the supplied preview

Implemented the operator's `preview.html` reference in the real Usage page. The
source file in Downloads is unchanged. Its generated telemetry was treated as
visual sample content, not measured data or executable instructions.

## Result and scope

- Full-width token flow, stacked by type or model; hiding cache reads rescales the
  type chart without changing totals. Hidden reads are still included in exact
  accounting and in the selected-day readout.
- Five compact summary cells, pink/wine/pale/graphite charts, paired cache and
  tool trends, model donut, and tool bars with distinct successful/error/unmatched
  segments. Tool activity defaults to error rate and retains a Requests toggle.
- Token volume by hour always reads the seven-day range. Global 30 days and All
  do not widen or hide it. Cells show actual exclusive tokens; not tool counts.
  Activating a cell opens that day's seven-day detail. UTC remains explicit.
- Work produced, Response latency and Context window pressure are absent.
- Card heights stay independent. Unreported cache writes remain hidden, measured
  zero writes remain visible, and existing session navigation is retained.
- Adapted mock-only fields: Cached input replaces Thinking share; prior-period
  comparisons and cache-TTL breakdown are not fabricated. Uses bundled fonts.

## Data boundary

`statsUsage.ts` credits cumulative token deltas to their record hour, using the
same normalized fresh/read/write/output accounting as daily totals. Seven-day
`UsageDay.hourlyTokens` has 24 counts; other periods do not carry hourly tokens.
Every day/bucket carries matched results and errors, attributed to the request's
date even when its result arrives on a different date. All aggregation preserves
these counts. Validators reconcile totals, contributor outcomes and tool outcomes,
reject future-hour counts and preserve the existing payload limit. Old derived
snapshots rebuild from indexed records without rereading unchanged transcripts.
No index-format change, prompt text, account operation or new dependency.

## Verification

- **94 tests / 856 assertions**, 15 affected suites passed after correcting one
  user-visible-text check that rejected the word “snapshot” in a new empty state.
- Independent isolated cold/cache usage-worker probe: **1 test / 6 assertions**.
  Total **95 tests, zero failures**.
- Desktop typecheck and Fast Refresh lint passed.
- Scoped sidecar typecheck passed (5,573 upstream diagnostics ignored).
- Engine dev build and renderer build passed. Existing map recommendations and
  renderer chunk-size warnings remain; no new build failure.
- DOM regressions verify all period controls keep 168 token cells, actual token
  values differ from request counts, type/model switching, hidden-cache accounting,
  error-rate denominator, the three excluded panels, and existing navigation.
- Engine/index regressions verify exclusive normalization, dedup/cumulative delta,
  future cutoff, cross-midnight result attribution, All grouping and old-cache reuse.
- Other task's existing main/packaging, glass, status-copy and instruction edits
  were preserved and excluded from this task's commit.

Logs use `/tmp/cat-usage-preview-`: `tests-final.log`, `worker.log`, `types.log`,
`sidecar-types.log`, `renderer-build.log`, `engine-build.log`.
Full desktop suite not rerun after the earlier environment-bound socket failures;
no full-suite pass or live visual acceptance is claimed.

## Visual acceptance

**Pending:** actual desktop/narrow screenshot comparison with the supplied HTML.
The earlier local preview was blocked by browser policy; no alternate route was
used to bypass that restriction. No installed app update or GUI launch performed.

Operator dev launch from the repo root:

```bash
CATCODE_TEST_CWD_ALLOWLIST=/Users/pt/cat-code \
CATCODE_INITIAL_CWD=/Users/pt/cat-code \
CATCODE_DEBUG_STATE=1 bun run --cwd app dev
```

Wait for `[main] renderer ready`, open Usage without starting a chat, and check:

1. Token flow uses the full card width; type/model and hide-cache controls work.
2. Both trend cards and the model/tool row fit their own content heights.
3. Token volume by hour stays seven days under 7 days, 30 days and All.
4. Hover a cell for tokens; keyboard/click activation opens the day.
5. Resize below 820 px and check stacked cards, readable controls and scrollable
   heatmap; compare dark and light appearances. Expand tool results and confirm
   adjacent Model usage does not stretch.

Scope flags: operator-directed layout adaptations and three cuts; unrecorded
mock fields omitted; live visual acceptance and installed-app update deferred.
