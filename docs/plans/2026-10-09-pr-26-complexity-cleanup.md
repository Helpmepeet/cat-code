# PR #26 complexity cleanup plan

Date: 2026-10-09

## Scope and execution boundary

This is a plan only. No implementation, dependency removal, test modification,
or live-state change is authorized or performed by this document.

The original request was a whole-tree complexity audit focused on
Helpmepeet/cat-code#26. Historical findings were checked against PR head
`a0dfe5a1a3756b15882686e1601a9328534efb04`, using base
`24831bd819155f2fd664963a0a1cb2a6d1a3067c`. The audit includes pre-existing
adjacent debt, not only additions in the PR.

An independent adversarial subagent challenged the proposed cuts. Its material
findings were verified directly before this revision. The shared branch advanced
to `517187e6` during that review, and several files have concurrent uncommitted
changes. Historical source ranges are not instructions to overwrite the current
files. Before implementation, recheck current callers, contracts, ownership,
and the actual diff for each slice.

Complexity reduction is the objective. Preserve requested behavior, security
boundaries, saved state, credentials, and running work. Do not turn this into a
correctness, performance, or architecture redesign pass.

## Corrections from adversarial review

### Retain `strip-ansi`

The proposed replacement with `node:util.stripVTControlCharacters` is withdrawn.
An isolated comparison on Bun 1.4.0 reproduced behavior differences:

| Input, shown with escaped control characters | `strip-ansi` output | `stripVTControlCharacters` output |
|---|---|---|
| `\x1b[38:2::1:2:3mtext` | `text` | `:2::1:2:3mtext` |
| `\x1bPpayload\x1b\\text` | `payload\x1b\\text` | `text` |

This affects live paste and message normalization, including
[`PromptInput.tsx`](../../src/components/PromptInput/PromptInput.tsx),
[`messages/mappers.ts`](../../src/utils/messages/mappers.ts), and
[`QueryEngine.ts`](../../src/QueryEngine.ts). Representative matching examples
were insufficient evidence for a behavior-preserving substitution. Keep the
direct dependency and its callers. An intentional normalization change would be
a separate proposal.

### Preserve restored pinning

`sidebarPinnedSessions.ts` and `PinFilledIcon` were unwired at the PR snapshot.
Current shared-tree edits restore actual pinning callers in
[`Sidebar.tsx`](../../app/renderer/src/Sidebar.tsx). Do not delete that module,
its helpers, or its saved preferences. The previously identified approximately
299-line removal is excluded from this plan.

### Coordinate filesystem work

Another session is modifying
[`containedFs.ts`](../../src/utils/containedFs.ts) and
[`windowsContainedFs.ts`](../../src/utils/windowsContainedFs.ts). Its changes
extend `ContainedFileCapability.copyTo` with `ContainedFileCopyOptions.mode`,
creation/chmod behavior, and the POSIX `afterCopyDestinationOpen` hook. These
changes overlap both capability objects proposed for consolidation and the
portable implementation proposed for deletion.

Do not execute those slices against the historical file snapshot. Coordinate
ownership first, then preserve the current complete copy contract, hook behavior,
validation, and cleanup.

## Ranked proposed cuts

Savings are approximate source lines, excluding tests, documentation prose,
and lockfiles. Tooling/probe code is included but is not shipped application
runtime. These are planning estimates, not a verified net implementation diff.

| Order | Cut | Replacement and retained boundary | Approximate lines |
|---|---|---|---:|
| 1 | `delete:` Orphaned telemetry exporter, enrichment tail, serializers, and unused telemetry adapters. | Nothing. Preserve no-op public logging APIs, active sanitizers, feature getters, and local diagnostics. | 2,820 |
| 2 | `delete:` Uncalled legacy permission-file producers, resolution-management helpers, and exclusive pending-directory helpers. | Keep live mailbox sending, schemas, and resolved-file polling for outstanding work. | 330 |
| 3 | `delete:` Unreachable portable contained-filesystem implementation and exclusive reader/error helper. | Keep live POSIX/Windows implementations and unsupported-platform rejection. Coordinate current ownership. | 287 |
| 4 | `native:` JavaScript terminal-width fallback. | Use the already-selected supported-runtime path: `str => Bun.stringWidth(str, { ambiguousIsNarrow: true })`. | 220 |
| 5 | `delete:` Orphaned alternative Codex adapter under `src/utils/`. | Nothing. Keep the separate live adapter under `src/services/api/`. | 157 |
| 6 | `shrink:` Duplicate POSIX capability objects. | One local capability constructor after each opener's distinct checks. Preserve positional reads, identity, lifetime, copy options, and hooks. | 90 |
| 7 | `delete:` Superseded dashboard projectors and chart helpers. | Keep mounted charts and current projections. Transfer tests of live contracts before removing test-only wrappers. | 85 |
| 8 | `shrink:` Mirrored SSH-first/HTTPS-first marketplace clone branches. | One ordered attempt loop with unchanged policy checks, guarded cleanup, progress/logging, and final-error selection. | 80 |
| 9 | `delete:` Unmounted `ChipStrip`/`Separator` and `ResolutionOrderLegend`. | Nothing. Keep mounted chips and settings fields. | 65 |
| 10 | `delete:` Obsolete notification aliases, `getMergedTools`, and delivery-report wrapper. | Keep canonical queue operations, `assembleToolPool`, and delivery-record formatting. | 59 |
| 11 | `delete:` Unused `getSnippetForPatch` and its exclusive constant. | Nothing. Keep adjacent snippet utilities with live callers. | 50 |
| 12 | `delete:` Unused Windows link/object-attribute scaffolding, root-opening wrapper, and unused local. | Call the existing root opener directly. Preserve live HANDLE operations and current copy behavior. Coordinate ownership. | 35 |
| 13 | `delete:` Duplicate test-only engine command-rate derivation and unread reducer fields/helpers. | Keep the renderer's live headline derivation and reducer behavior; transfer integration coverage. | 35 |
| 14 | `delete:` Unused alternate study status parser and interceptor leftovers. | Keep the reliable full-tree status parser and active per-thread output tracking. | 20 |
| 15 | `shrink:` Singleton transformation-path bookkeeping in measurement probes. | Return timing directly; derive `updatesByPath: { unattributed: times.length }`. Preserve output shape and unavailable-attribution notes. | 14 |
| 16 | `shrink:` Equal text-read limit fields/arguments and measurement wrapper. | One limit argument, but retain distinct `targetCount` and `hardCount` measurements. | 12 |
| 17 | `delete:` App ESLint plugins registered without enabled rules and their inert disable directives. | Keep the active React Refresh plugin/rule. Do not reduce current lint enforcement. | 12 |
| 18 | `delete:` Unused external `ink` declaration. | Nothing. Keep the local Ink fork and its directly consumed dependencies. | 1 |

### Source anchors and exact removal boundaries

1. Telemetry:
   - [`firstPartyEventLoggingExporter.ts`](../../src/services/analytics/firstPartyEventLoggingExporter.ts): the entire unreferenced exporter.
   - [`metadata.ts`](../../src/services/analytics/metadata.ts): enrichment from `EnvContext` onward, including `getEventMetadata` and `to1PEventFormat`, plus exclusive imports. Preserve the earlier live sanitizers and extraction helpers.
   - The event serializers under [`events_mono/`](../../src/types/generated/events_mono/) and [`google/protobuf/timestamp.ts`](../../src/types/generated/google/protobuf/timestamp.ts), after confirming no remaining consumers.
   - Unused [`sinkKillswitch.ts`](../../src/services/analytics/sinkKillswitch.ts), [`bigqueryExporter.ts`](../../src/utils/telemetry/bigqueryExporter.ts), and [`telemetry/logger.ts`](../../src/utils/telemetry/logger.ts).
2. [`swarm/permissionSync.ts`](../../src/utils/swarm/permissionSync.ts): `writePermissionRequest`, `readPendingPermissions`, `resolvePermission`, `cleanupOldResolutions`, `submitPermissionRequest`, `getLeaderName`, and their exclusive helpers/imports. Do not delete retained resolved files or polling.
3. [`containedFs.ts`](../../src/utils/containedFs.ts): private `openPortableContainedFs`, `isPortableENOENT`, and exclusive `readHandlePositionally`. The live entrypoint rejects unsupported platforms rather than calling the portable implementation.
4. [`ink/stringWidth.ts`](../../src/ink/stringWidth.ts): JavaScript fallback and its exclusive helpers/imports. Bun 1.4 is already the required runtime; this is removal of an unselected fallback, not a claim that both algorithms agree under every input.
5. [`utils/codex-fetch-adapter.ts`](../../src/utils/codex-fetch-adapter.ts): entire unused module. Do not confuse it with [`services/api/codex-fetch-adapter.ts`](../../src/services/api/codex-fetch-adapter.ts).
6. [`containedFs.ts`](../../src/utils/containedFs.ts): object construction inside `openFileCapability` and `openFileCapabilityNoFollow`. Keep both opening/validation paths distinct; share only capability construction after checks succeed.
7. Dashboard:
   - [`usageDashboardState.ts`](../../app/renderer/src/usageDashboardState.ts): `usageColors`, `usageCacheBounds`.
   - [`usageAutoModeState.ts`](../../app/renderer/src/usageAutoModeState.ts): `autoModeDisplayCounts`, `autoModeOutcomeSeries`, `AUTO_MODE_ROUTE_EDGES`, `autoModeRouteEdges`.
   - [`UsageOverviewDetails.tsx`](../../app/renderer/src/UsageOverviewDetails.tsx): unmounted `UsageToolActivity`.
   - [`usageGraphState.ts`](../../app/renderer/src/usageGraphState.ts): `usageHourLabel`.
   - [`usageStackedAreaState.ts`](../../app/renderer/src/usageStackedAreaState.ts): `usageSmoothCurve`, not the live curve internals.
   - [`usageTrendState.ts`](../../app/renderer/src/usageTrendState.ts): `usageHasCacheWrites`.
8. [`marketplaceManager.ts`](../../src/utils/plugins/marketplaceManager.ts): GitHub SSH/HTTPS clone selection. Choose `sshConfigured ? [sshUrl, httpsUrl] : [httpsUrl, sshUrl]`, then retain behavior in one loop.
9. [`Chip.tsx`](../../app/renderer/src/Chip.tsx): `ChipStrip` and exclusive `Separator`; [`SettingsField.tsx`](../../app/renderer/src/SettingsField.tsx): `ResolutionOrderLegend` and exclusive imports.
10. [`messageQueueManager.ts`](../../src/utils/messageQueueManager.ts): deprecated pending-notification alias block; [`tools.ts`](../../src/tools.ts): `getMergedTools`; [`LocalAgentTask.tsx`](../../src/tasks/LocalAgentTask/LocalAgentTask.tsx): `formatAgentMessageDeliveryReport` only.
11. [`FileEditTool/utils.ts`](../../src/tools/FileEditTool/utils.ts): `getSnippetForPatch` and exclusive `CONTEXT_LINES`.
12. [`windowsContainedFs.ts`](../../src/utils/windowsContainedFs.ts): `buildWindowsLinkInformation`, `createObjectAttributes`, delegating `openRootHandle`, unused `fileIndex`. Keep live rename/publication helpers and ABI machinery.
13. [`autoModeUsage.ts`](../../src/utils/autoModeUsage.ts): `autoModeCommandRate`, exclusive `AutoModeCommandRate`/`OUTCOMES`, unused `cloneCoverage`, and unread `Attempt.scope`/`attemptId` stored fields. Preserve the actual join key.
14. [`outputs.ts`](../../scripts/workspace-map-eval/prep/outputs.ts): unused `statusBlocks`/exclusive regex; [`interceptor.ts`](../../scripts/workspace-map-eval/prep/harness/interceptor.ts): unused `hasOutput` and `realFetch`/`void realFetch` pair. Preserve network blocking and scripted response behavior.
15. [`probes/markdown.ts`](../reports/2026-10-06-performance-measurements/probes/markdown.ts) and [`probes/real-data.ts`](../reports/2026-10-06-performance-measurements/probes/real-data.ts): singleton `Path`, counters/maps, and timing-result wrappers. Do not rewrite historical result artifacts.
16. [`textReadBudget.ts`](../../src/tools/FileReadTool/textReadBudget.ts) and [`FileReadTool.ts`](../../src/tools/FileReadTool/FileReadTool.ts): equal `prefixTargetTokens`/`hardTokenLimit` plumbing and delegating `measureRenderedTokens`. Conservative byte-based admission and prefix-sizing estimates are distinct and must remain so.
17. [`app/eslint.config.js`](../../app/eslint.config.js), [`app/package.json`](../../app/package.json), and six inert directives in AccountsPage, SessionPane, and StartupSurfaces. Remove plugin registration, declarations, and directives together; leave Fast Refresh enforcement unchanged.
18. [`package.json`](../../package.json): external `ink` declaration only. Runtime imports use the local fork.

## Dependency scope

The potential saving is **18 direct dependency declarations**, not 18 packages
removed from the installed graph:

- Telemetry: 13 declarations, comprising `@opentelemetry/core`, the ten
  `@opentelemetry/exporter-*` packages currently declared, `resources`, and
  `semantic-conventions`. Retain `api`, `api-logs`, `sdk-logs`, `sdk-metrics`, and
  `sdk-trace-base`, which still have type consumers.
- Width fallback: `emoji-regex` and `get-east-asian-width`, only after removing
  their exclusive direct consumers and rechecking the tree.
- App lint: app declarations of `eslint-plugin-jsx-a11y` and
  `eslint-plugin-react-hooks`.
- External Ink: the root `ink` declaration.

Retained OTEL SDKs still require `core`, `resources`, and
`semantic-conventions` transitively. Retained `wrap-ansi`/`string-width` require
`strip-ansi` and `get-east-asian-width`. `scheduler` remains required by
`react-reconciler`. Preserve those transitive requirements; do not claim bundle
or installation savings from declaration counts alone. Do not remove or
downgrade dependencies unrelated to the proposed cuts.

## Preserve regression coverage

An unused wrapper can be removed without discarding the contracts its tests
exercise. Before removing it:

- Transfer endpoint-tangent, exact curve-construction, and repeated-x assertions
  from `usageSmoothCurve` to the live `usageStackedAreaGeometry` path in
  [`usageStackedAreaState.test.ts`](../../app/renderer/src/usageStackedAreaState.test.ts).
  Do not delete the mixed test wholesale.
- Keep the Lord Howe half-hour DST assertion in
  [`usageWindow.test.ts`](../../src/utils/usageWindow.test.ts). Replace the removed
  display-helper call with direct assertions of the produced slot's `startAt`,
  local minute, hour, and offset. Merely retaining the existing hour/offset
  assertion would lose the `02:30` check.
- Preserve mixed-source coverage suppression and unequal daily denominator
  scenarios in [`autoModeUsage.test.ts`](../../src/utils/autoModeUsage.test.ts).
  Keep reducer assertions there and exercise resulting summaries through the live
  `autoModeCommandRateHeadline` in
  [`usageAutoModeState.test.ts`](../../app/renderer/src/usageAutoModeState.test.ts).
  The canonical headline test alone does not replace those integration cases.
- Keep tests of retained shared helpers and boundary behavior. Remove only tests
  that exclusively prove deliberately removed, unused functionality. Never
  weaken expectations to obtain a passing check.

## Implementation sequence and verification

When implementation is explicitly requested:

1. Recheck current status and callers, coordinate known ownership overlap, and
   read the current files before constructing each change. Do not delete saved
   data, untracked fixtures, or another session's edits.
2. Implement separate coherent slices. Within each area, prefer confirmed dead
   implementation removal before consolidation. Update affected callers, tests,
   and maintained maps; avoid unrelated stale-reference sweeps.
3. For marketplace consolidation, establish the transport matrix before editing:
   configured and unconfigured SSH, first-attempt success, first failure followed
   by fallback success, and both attempts failing. Verify success stops retries,
   cleanup occurs only between failed attempts with the same live-policy/cache
   guards, and the final error belongs to the final failed attempt. Existing
   policy/publication tests do not establish this complete matrix.
4. For filesystem slices, retain both opener validation paths and exercise
   descriptor identity, positional reads, closed/error paths, copy creation mode,
   destination permissions, destination-open hooks, and handle cleanup. Include
   applicable isolated Windows ABI/capability tests. Do not replace bound I/O with
   path-based convenience operations.
5. Run relevant engine tests with isolated state and
   `cd /Users/pt/cat-code && bun run build:dev:full`.
   Do not introduce new root typecheck diagnostics or repair unrelated engine
   diagnostics.
6. Run applicable desktop tests and the affected package checks:
   `cd /Users/pt/cat-code && bun test app/`,
   `cd /Users/pt/cat-code && bun run --cwd app typecheck`, and
   `cd /Users/pt/cat-code && bun run --cwd app typecheck:sidecar`. Run
   `cd /Users/pt/cat-code && bun run --cwd app renderer:build` for affected
   renderer build inputs.
   Report existing failures with evidence rather than rewriting expectations.
7. Verify tooling simplifications with synthetic isolated fixtures. Preserve
   study status reliability, private attempt directories, reconstruction
   evidence, network blocking, and measurement output fields. Do not run live
   transcript reconstruction or credentialed/provider probes for this cleanup.
8. Check changed links, `cd /Users/pt/cat-code && git diff --check`, and
   `cd /Users/pt/cat-code && bun run maps:lint` for docs/maps updates. Inspect
   dependency/lockfile changes independently in their package boundaries.
   Recalculate savings from the actual completed diff.

GUI launches, hardening runs that launch Electron, live account probes, and
shared-system actions are not part of this planning request. Existing relevant
project authorization must cover any such later check; do not infer it from this
document. No new dependency or architecture abstraction is proposed.

## Expected outcome and evidence limits

The revised opportunity remains approximately **4,300 source lines** and
**18 direct dependency declarations**, excluding the restored pinning feature
and the rejected ANSI replacement. This is an approximate source-reduction
opportunity, not measured installed-package, bundle-size, performance, or verified
net-diff evidence. Transferred tests and current concurrent edits can change the
final totals.

Audit evidence comprises source/caller searches, historical Git inspection,
current-diff inspection, dependency-graph inspection, and isolated runtime
comparisons. Native width examples confirmed the existing supported Bun path;
they did not prove fallback/native equivalence. The adversarial ANSI objection
was independently reproduced. No implementation tests, application build, or GUI
acceptance was performed for the proposed changes. Validating this Markdown
plan is separate from validating a future implementation.
