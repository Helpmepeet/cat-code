# Usage dashboard implementation evidence

Implementation is present, with rollout gated. `CATCODE_USAGE_DASHBOARD=1` opts
into the new worker; absent/disabled shows Usage as Unavailable. The full desktop
suite is not green, so this is not a release-complete claim. No commit, push,
installation over the user's app, credential change, or transcript migration.

## Implementation

- `src/utils/statsReader.ts`: bounded byte-zero streaming, captured per-file size,
  UTF-8 framing, valid final records, explicit parse/pending-tail/oversize/short-read
  and detected replacement/truncation counters. One JSON parser path replaces the
  analytics dependency on both silent-recovery paths of the shared JSONL reader.
- `src/utils/statsUsage.ts`, `usageWindow.ts`, `usageCategory.ts`, and `stats.ts`:
  one captured UTC cutoff; pre-window cumulative and request identity state;
  exclusive token categories; main/subagent and copied-source identity; safe count
  arithmetic; bounded state with explicit failure; complete date grids. Desktop
  recomputes retained history; legacy terminal cache definitions remain intact.
- `app/shared/usageDashboard.ts`, `usageStatsWorker.ts`: independent v1 result,
  exact-key validation, category/ratio/count reconciliation and envelope limits.
  `protocol.ts` documents the legacy session-query distinction. No existing wire
  shape was broken; the new version belongs to the independent host result.
- `app/sidecar/statsDomain.ts`, `usageSummary.ts`, `usageStatsWorker.ts` and
  `app/main/usageStatsRunner.ts`, `main.ts`: shared worker machinery, independent
  startup and five-minute refresh, 125-second process timeout, cancellation,
  generation guard, last-good replay and refresh/failure status. Worker-side
  collection deadline is 120 seconds. Account-worker usage collection is disabled.
  Intentional account-worker shutdown cancellation no longer logs as refresh failure.
- `UsagePage.tsx`, `UsageDashboardCharts.tsx`, `usageDashboardState.ts`, CSS,
  `Sidebar.tsx`, `App.tsx`, `AccountsPage.tsx`: dedicated destination, four cards,
  five panels, keyboard day inspection, values tables, honest partial/stale/error/
  zero-denominator states. Accounts no longer hosts the legacy overview.
- Visual harness accepts a usage fixture scene and port override, and isolates its
  Electron profile so it does not share a running dev app's single-instance lock.

The short plan's suggested filenames were adapted to preserve the existing legacy
session-query/cache contract and its consumers. The new overview has one publisher
and one accounting definition; it does not consume old account/session snapshots.

LUNA implemented the initial validator plus its tests, runner regression tests,
and focused accounting acceptance fixtures. Primary reviewed every diff, corrected
validator and fixture issues, reran tests, and implemented all accounting, reader,
contract decisions, delivery integration, UI, UI tests, and visual work. No UI work
was delegated.

## Limits and measurements

| Resource | Enforced policy / observed measurement |
|---|---|
| Worker record | 256 KiB for both ranges and envelope; account cap unchanged |
| Label | 160 UTF-8 bytes; truncated labels include an identity suffix |
| Named detail | Eight models and ten tools per window, plus structured Unknown/Other |
| Read buffers | 64 KiB chunks, 4 MiB record, one transcript at a time |
| Discovery | 25,000 entries/sources per bounded traversal collection; 16 MiB retained path text |
| Accounting | 250,000 identity/category entries; 64 MiB conservative retained-payload estimate; overflow fails without eviction |
| Time | 120-second collection budget, 125-second worker timeout; forced cancellation/reaping |
| Large history | Generated 101 MiB transcript; eligible token records at both ends counted with complete coverage |
| Envelope fixture | Roughly 44 KiB for 24 models/tools across all 30 days, long multibyte labels and both ranges; exact 256 KiB and one-byte-over line checks |
| Worker cost | Empty retained corpus: 0.70 seconds wall time, 214,728,704 bytes peak RSS (~205 MiB), measured with macOS `time -l` |

The retained-payload limit is not a hard process RSS cap. The worker imports the
existing engine graph, which dominates the measured empty-corpus memory. A shared
cutoff is not an atomic filesystem snapshot; coverage refers to observed retained
source boundaries, not lifetime account usage. Grouping is distinct from source loss.

## Verification actually run

Commands ran from the repository root. Tests touching cache state were rerun with
an isolated `CLAUDE_CONFIG_DIR`; the initial cache-lock test timed out without it.

- Initial focused baseline: `bun test app/sidecar/statsDomain.test.ts app/shared/accountsPoolWorker.test.ts src/utils/stats.test.ts`: **57 pass**.
- Engine acceptance: `bun test src/utils/statsReader.test.ts src/utils/stats.test.ts src/utils/statsCache.test.ts src/utils/statsCache.integration.test.ts src/utils/statsUsage.test.ts src/utils/statsUsage.acceptance.test.ts src/utils/usageWindow.test.ts`: **28 pass**, including actual >100 MiB aggregation and 40 timezone/window scenarios.
- Combined delivery/contract/UI integration: `bun test app/main/usageStatsRunner.test.ts app/shared/usageStatsWorker.test.ts app/sidecar/usageSummary.test.ts app/sidecar/usageSummary.integration.test.ts app/sidecar/usageStatsWorker.probe.test.ts app/renderer/src/UsagePage.test.tsx app/renderer/src/UsagePage.dom.test.tsx app/renderer/src/AccountsPage.test.tsx app/renderer/src/App.test.tsx app/main/mainDecisions.test.ts`: **226 pass** on the final source.
- Related existing boundaries: `bun test app/renderer/src/App.test.tsx app/renderer/src/Sidebar.test.tsx app/renderer/src/sidebarState.test.ts app/main/mainDecisions.test.ts app/sidecar/statsDomain.test.ts app/shared/accountsPoolWorker.test.ts`: **325 pass**.
- `bun test app/renderer/src/userVisibleText.test.ts`: **5 pass**.
- `bun run --cwd app typecheck`, `typecheck:sidecar`, `renderer:build`: passed. Raw sidecar diagnostics inspected: none in new usage modules; existing engine diagnostics remain outside the scoped gate.
- `bun run build:dev:full`: passed, including undefined-name gate and maps lint.
- `bun run --cwd app test:hardening`: **19/19 passed**.
- `bun run --cwd app package`: passed outside sandbox (sandboxed macOS icon conversion failed).
- `bun run --cwd app smoke:packaged`: passed initially; subsequent runs exposed the intentional-shutdown logging race. After correcting that log, all assertions passed again. No test assertion was weakened.
- `CATCODE_CAPTURE_PORT=5187 CATCODE_CAPTURE_SCENE=usage CATCODE_CAPTURE_OUT=/tmp/usage-dashboard-final bun run --cwd app visual:capture`: three hidden Chromium captures, 1200px/520px widths and 7d/30d. Inspected normal, narrow, and 30-day images; fixed SVG aspect-ratio scaling. No visible window, cursor movement, or live account state.
- `git diff --check`: passed.

## Open gates

`bun test app/` was run twice. The sandboxed baseline had **4,871 pass, 37 fail,
10 errors**; socket/process restrictions prevented many probes. The outside-sandbox
run with an isolated home had **4,903 pass, 18 fail, 1 error** (4,921 tests, 307 files).
The latter failures are auth/profile-dependent boot/peer/run-control assertions;
the module error is a retained `tmp/pr22-merged-2026-09-12-evidence/.../leaseState.test.ts`
copy missing `accountsState.js`. These were not repaired or removed. No usage test
failed in that run. The required full-suite gate remains open.

Headless Chromium and mounted DOM checks establish layout and interaction evidence,
not operator acceptance or a live accessibility-tree audit. The existing packaged
operator smoke (real sessions, permission prompt, and session switching) remains
unperformed because it would exercise live provider work outside this usage fixture.
Pagination B4, cost/timing/outcome charts, filters, and detail views remain deferred
as requested. Rollout stays opt-in until the outstanding applicable gates are resolved.

For an operator check, restart Cat Code Dev with `CATCODE_USAGE_DASHBOARD=1` and
open Usage. Inspect 7/30 days, Tab/Enter day selection and the values disclosure,
then Accounts. Unset the switch and restart to roll back to Unavailable. This does
not change accounts or retained transcripts.

## Follow-up: real-history scale and startup persistence

The operator's initial application run returned `resource-limit` because the
original global identity maps exceeded the 64 MiB estimated state budget. The
follow-up replaces transcript-wide rescans with a versioned SQLite accounting
index and saved grouped snapshot, and moves the large identity maps to disk.
Main restores saved usage before refreshing. Unchanged files are stat-checked,
changed files reindex from byte zero, and accounting replays the compact index
only when source changes, a UTC rollover or newly eligible future records require
it. This is not append-offset aggregation; a changed transcript is reread in full.
Specific timeout/resource/validation messages now explain refresh failures while
retaining saved values. See the amended usage decision for locking, recovery,
privacy, and storage limits.

Final follow-up verification:
- 141 focused tests passed, 0 failed, 1,112 assertions across 14 files, including
  an oversized historical identity fixture, zero-source-read warm refresh,
  copied records, replacement, deletion, incomplete tails, UTC/future eligibility,
  concurrent writer exclusion, rollback, corrupt database rebuild, saved worker
  restore with transcripts removed, and retained values on failure.
- App typecheck, scoped sidecar typecheck, engine build, renderer build and desktop
  package passed. Raw sidecar diagnostics contain no errors in statsUsage.ts or
  statsUsageIndex.ts. Maps lint passed with 7 existing warnings; diff check passed.
- The compiled packaged worker passed initial index and saved restore probes with
  isolated fixture state. No Electron window was launched for this follow-up.
- Final real-history run used an isolated index under /tmp, leaving original
  transcripts/configuration unchanged: 2,314 sources, complete coverage, validated
  20,129-byte snapshot; 13,019 ms cold and 107 ms warm. Fixture saved worker restore
  took 21 ms. Temporary real-history indexes were removed after verification.
- The broad app suite was attempted in an isolated home and stopped after repeated
  sandbox `Failed to listen` Unix-socket failures with long probe timeouts. It is
  not a full-suite pass. Prior rollout/operator gates remain open.

Evidence logs: /tmp/usage-index-final-tests.log, /tmp/usage-index-types.log,
/tmp/usage-index-sidecar-final.log, /tmp/usage-index-raw-types.log,
/tmp/usage-index-build.log, /tmp/usage-index-renderer.log,
/tmp/usage-index-package.log, /tmp/usage-index-packaged-probe.log,
/tmp/usage-real-history-final.log, /tmp/usage-index-app-suite.log.

No application restart, installation, commit or push was performed. Main changes
require a full application restart; the first successful refresh creates the
persistent index, and subsequent starts restore the saved result.

## Sizing-only correction after operator rejection

The operator explicitly rejected the visual design and requested the oversized
layout be fixed first. Design approval remains open. The page now caps content
width at 1,180 px; daily and cache SVGs cap at 180 and 100 px; activity SVG rows
are 44 px high. Card padding, header spacing and the selected-day readout were
reduced. Axis text was compensated for the smaller SVGs. Accounting and metrics
are unchanged. The capture harness now covers 1,200×900 and 1,920×1,056 desktop
viewports as well as 520×1,900 narrow layout.

Six existing UI tests passed; renderer build and diff check passed. Final hidden
isolated Chromium captures were inspected at desktop and narrow widths under
/tmp/usage-compact-final. These validate sizing with fixture data, not operator
design acceptance. No live app restart or session interruption was performed.

## Frontend-design pass requested by the operator

Applied the explicitly invoked frontend-design skill to the compact overview.
The design uses the native application typeface with tabular figures, an unboxed
four-metric strip, one shared chart surface, muted orchid/blue/teal/ochre data
colors, and shorter labels. Removed redundant model numbering; retained all
metric semantics, accessible tables, error states and compact chart dimensions.
No external fonts or dependencies were added. This is a new design candidate,
not operator approval of the previously rejected design.

Renderer build and 11 existing UI/wording tests passed. Desktop and narrow hidden
Chromium fixture captures inspected: /tmp/usage-design/usage-30d.png and
/tmp/usage-design/usage-narrow.png; the 1200×900 capture is also available.

Operator-requested copy reduction: removed header subtitle, panel descriptions,
card explanations and repeated activity commentary; shortened freshness to the
range and update time, retained the precise timestamp in its title. Per-day
readouts now appear on selection. Kept chart keys, numbers, scales, essential
warnings and expandable table definitions. Renderer build and 11 UI/wording
tests passed; diff check clean. No new GUI capture for this copy-only pass.

Further operator-directed visual amendments: stronger blue/teal/amber/rose chart
colors; cache trend now fits observed percentages with labeled padded bounds;
model mix now uses a compact donut with exact proportional segments and a
name/count/percentage key, replacing horizontal bars. Zero totals retain an empty
track. Seven UI tests and renderer build passed; desktop fixture capture inspected
at /tmp/usage-donut/usage-30d.png. This explicitly supersedes the original model-bar
presentation requirement; accounting remains unchanged.

## Operator-supplied image reference pass

Rebuilt the usage page around the supplied navy dashboard reference: local navy
surfaces, distinct tinted metric cards with small icons and daily-data sparklines,
stronger heading/value hierarchy, individual chart panels and aligned tool rows.
Kept the operator-requested model donut, adaptive cache bounds, compact heights,
and minimal copy. Sparklines derive only from the selected range's recorded days;
no comparative growth percentages, search or unrelated navigation were invented.

Daily/cache plots now measure their SVG container and use pixel-sized viewboxes,
so they fill the panel width without enlarging text or chart height. Renderer build,
app typecheck and seven UI tests passed. Hidden desktop/narrow captures use the
existing isolated fixture harness at /tmp/usage-reference. Operator acceptance of
the new visual design remains open.

Latest operator-directed layout/style corrections: restored native neutral/black
surfaces, kept independent vertical stacks, and gave freed horizontal width to
the left charts with a 300–360 px right column. Prompt cache now follows the new
image reference with a violet line, outlined data points, gradient area fill,
dashed grid and three prominent totals separated by dividers. The continuous
spectrum below the plot is decorative (aria-hidden); the three exact category
counts remain the breakdown. Adaptive bounds remain labeled, and missing days
split both the line and area rather than being interpolated. Renderer build and
seven UI tests passed; desktop capture inspected at
/tmp/usage-cache-style/usage-30d.png. The background remains the normal app theme.

## Metric sparkline positioning and cache-write reporting

Moved the four metric sparklines into their own right-hand grid column, vertically
centered beside the metric copy, with a larger 48 px plotting height. Narrow cards
retain a 40 px plot. Desktop and narrow isolated captures inspected at
/tmp/usage-sparkline-position/usage-30d.png and usage-narrow.png.

GPT-5.6 Sol traced cache-write zero to the OpenAI adapter's normalized placeholder:
upstream reports cached reads but no write count. Added per-day and per-range
reporting availability; the UI displays Not reported for that scope, measured
counts normally, and a reported-count qualifier for partial coverage. Positive
recorded writes remain authoritative. Counting version 2 and index-v2.sqlite
invalidate the derived cache without changing retained transcripts.

Combined verification: 32 focused tests passed across eight accounting, index,
contract, summary, and UI files; the UI/text sweep separately passed 13 tests.
Renderer build and app typecheck passed. Sol also verified the development build,
scoped sidecar typecheck, and a fresh isolated scan of all 2,314 real sources;
current 7-day and 30-day GPT scopes are unreported with numeric totals unchanged.
A running desktop process needs a full restart to load the updated validator.
