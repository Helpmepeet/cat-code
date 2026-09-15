# Usage dashboard: day-to-session investigation

Date: 2026-09-16. User-directed implementation of the proposed dashboard image,
informed by the supplied harness research. Sol handled accounting and validation;
the primary agent handled renderer integration, navigation, and final verification.

## Result

Selecting a daily token bar reveals the sessions contributing usage on that UTC
day. Rows show tokens, recorded requests/errors, and model details; sorting applies
to the shown rows. Available conversations open through the existing catalog
Open/Restore route. The period and date survive leaving and returning to Usage.
Day selection is explicit by click or keyboard, so hovering does not replace the
session table. Hourly activity selects its containing whole day, as labeled.

The overview now uses compact numbers (1.67B), Sessions used, horizontal model
bars, and a smaller cache composition panel. Supporting panels explicitly describe
7-day or 30-day totals. Tool outcome details, the zoomed cache trend, daily/hourly
activity, and accessible exact-value tables remain available through disclosures.

Design follows the supplied image: one dominant usage plot, the selected-day table
immediately below it, and two supporting panels. Existing theme typography and
model colors are retained. Page/panel surfaces derive from existing theme tokens;
the page has an opaque ground for readable contrast. Purple marks selection,
blue/teal/pink identify models, and coral remains for recorded tool errors.

## Accounting and navigation

- `src/utils/statsUsage.ts` adds day contributors using the existing canonical
  record/API/tool identities. Subagents contribute to their parent; main-session
  and record counting stay unchanged. Metadata and contributor/model maps share
  the existing resource budget.
- `app/shared/usageDashboard.ts` and `usageStatsWorker.ts` define and validate
  contributor bounds, per-bucket reconciliation, IDs, and result/error counts.
- `app/sidecar/usageSummary.ts` retains up to 20 sessions/day, reducing to 10 or 5
  if needed for the 256 KiB envelope. Omitted counts remain explicit; day totals
  include all counted contributors. Up to four named models plus Unknown/Other
  are shown per contributor. Re-grouping preserves prior omission metadata.
- `src/utils/statsUsageIndex.ts` now uses `index-v4.sqlite` and counting version 4.
  It adds recorded cwd to the accounting projection; prompt/response text and
  tool arguments remain excluded. The outbound project is a hash and basename,
  not a filesystem path. The old derived index is left untouched.
- `usageSessionNavigation.ts` joins session ID and project hash against the
  existing catalog. Missing or ambiguous matches have no Open action. Titles
  come from matched catalog rows, otherwise an honest session-ID fallback is used.
  `App.tsx` invokes the existing `openCatalogRow` machinery; no new host verb,
  cwd authority, permission bypass, or raw transcript loading path was added.

## Verification

- Combined focused suite: **46 pass / 0 fail** across nine files, covering UI
  state, keyboard/click selection, catalog joins, numbers, accounting, grouping,
  worker validation, persisted-index behavior, and cold/saved worker probes.
- Existing visual-harness source checks: **4 pass / 0 fail**. Its readiness and
  expanded-activity selectors were updated for the new layout, and a selected-day
  capture scene was added. The capture itself was not run.
- Desktop typecheck, scoped sidecar typecheck, renderer build, and engine
  `build:dev:full`: passed. Sidecar wrapper ignores 5,573 upstream diagnostics.
- Broad `bun test app/`: attempted, then stopped after repeated sandbox socket
  readiness failures. No full-suite pass is claimed. A contributor test observed
  during concurrent edits was corrected and passes in the final focused suite.
- Visual inspection: **unverified**. Browser security policy blocked the isolated
  local HTML preview; no alternate browser or URL workaround was attempted. No
  live Cat Code window, account state, or model session was launched or driven.

## Scope and remaining acceptance

The requested mockup supersedes the older donut/sparkline/expanded-heatmap layout
for this change (adapted). The actual session table exposes bounded top
contributors, with honest truncation instead of the mockup's fictional View all
link. Catalog coverage controls whether a conversation can be opened.

Custom dates, local-time aggregation, direct tool-invocation drilldown, costs,
cache-cause instrumentation, and evaluations remain future work. This pass does
not infer task success from tool results.

Operator check after rebuilding/restarting the app: open Usage, select 30 days,
click a daily bar, open an available session, then return to Usage and confirm the
same date remains selected. Check Clear selection, the narrow layout, and each
supporting disclosure. Compare the page against the supplied mockup. Live visual
acceptance and any installed-app update remain outstanding.
