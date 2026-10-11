# Analytics And Diagnostics Map

Last refreshed: 2026-10-09

## Purpose

Daily-refreshable routing map for analytics and telemetry compatibility
boundaries, GrowthBook/config gates, diagnostics, doctor/status flows,
debug/error/API logging, stats, cost tracking, and validation.

This map is a routing aid, not a source of truth. Verify behavior in source
before changing code. In this build, product analytics and OpenTelemetry
entrypoints mostly preserve APIs as inert compatibility stubs, while local
diagnostics, debug logs, API request logging, cost, status, and stats remain
active local features.

## First Files To Inspect

| Area | Inspect first | Then inspect | Notes |
|---|---|---|---|
| Analytics API and gates | `src/services/analytics/index.ts`, `src/services/analytics/growthbook.ts` | `src/services/analytics/{sink,config,metadata}.ts`, analytics call sites | Public logging remains a compatibility boundary; metadata retains sanitizers and extraction helpers, not event enrichment. |
| Local telemetry and tracing | `src/utils/telemetry/instrumentation.ts`, `src/utils/telemetry/perfettoTracing.ts` | `src/utils/telemetry/{events,sessionTracing,betaSessionTracing}.ts`, `src/entrypoints/init.ts` | OTEL entrypoints are inert in this build; Perfetto remains the env-enabled local trace writer. |
| Desktop operational diagnostics | `app/main/operationalLogSink.ts` | `app/shared/operationalLog.ts`, `app/main/{deliveryTraceSink,diagnosticsBundle}.ts`, `app/sidecar/operationalLogger.ts` | Main owns bounded private JSONL and allowlisted support export; raw sidecar stderr never persists. Turn lifecycle is priority-preserved and exempt from short rate dedupe; peer-routing records are metadata-only with no message-text field. |
| Desktop analytics dashboard and auto-mode diagnostics | `app/renderer/src/UsagePage.tsx`, `app/renderer/src/UsageWorkPatterns.tsx`, `app/shared/usageDashboard.ts` | `app/main/usageStatsRunner.ts`, `app/sidecar/{usageStatsWorker,usageSummary}.ts`, `app/renderer/src/{UsageDashboardCharts,UsageActivityCharts,UsageValuesTable,UsageAutoMode,usageWorkPatternsState,usageChartHover}.ts*`, `src/utils/{statsUsage,usageWindow,autoModeUsage}.ts`, `src/utils/permissions/autoModeObservation.ts` | The main-supervised worker projects redacted transcript-derived aggregates. Work-pattern panels count distinct active minutes with 1, 2, or 3+ main sessions and attribute request/token totals only to recorded reasoning effort; partial and unavailable states remain explicit. Effort levels are defined by `USAGE_EFFORT_LEVELS` in the shared dashboard contract (currently including `ultra`) and must stay aligned across collection, worker validation, and renderer labels; changing the persisted dimension requires matching snapshot counting and derived-index generation updates. Ten-minute peaks use the snapshot timezone and DST-aware local-day slots. The renderer keeps period and selected-day state, formats freshness in that timezone, and can request a bounded manual refresh; charts preserve partial coverage and recorded cache counts. Auto-mode observations retain only typed decision metadata, so no tool input, rule text, transcript content, or identity reaches the renderer. For historical dashboard-gap candidates and their recorded cut decisions, see `docs/analytics/2026-09-30-dashboard-gap-research.md`; revalidate its captured source revision before relying on details. |
| Doctor, status, and validation | `src/commands/{doctor,status}/` | `src/screens/Doctor.tsx`, `src/components/Settings/Status.tsx`, `src/utils/doctorDiagnostic.ts`, `src/utils/status.tsx`, `src/utils/envValidation.ts` | `/doctor` and `/status` overlap but have distinct owners; settings and environment validation feed their displays. |
| IDE diagnostics and debug/error logs | `src/services/diagnosticTracking.ts`, `src/utils/debug.ts` | `src/utils/{attachments,log,errorLogSink}.ts`, `src/components/DiagnosticsDisplay.tsx` | IDE diagnostics are local edit feedback; debug/error output has separate enablement, filtering, and persistence paths. |
| Cost and terminal stats | `src/cost-tracker.ts`, `src/commands/stats/stats.tsx` | `src/components/Stats.tsx`, `src/utils/{stats,statsCache}.ts`, `src/context/stats.tsx` | Terminal `/stats` and cost tracking remain separate from desktop usage-stat projection. |

## Current Build Decisions

| Topic | Routing decision |
|---|---|
| Product analytics | Treat `src/services/analytics/index.ts` as the public compatibility API. Do not chase telemetry behavior from call sites alone; most calls terminate in no-op functions in this build. The first-party exporter and per-sink killswitch are absent. |
| Analytics disable checks | `src/services/analytics/config.ts:isAnalyticsDisabled()` is still used by API helper paths and startup guards. It disables analytics in tests, 3P cloud provider modes, Foundry, and privacy levels that disallow telemetry. |
| GrowthBook initialization | `src/services/analytics/growthbook.ts:isGrowthBookEnabled()` delegates to `is1PEventLoggingEnabled()`, which returns false in this build. Feature getter helpers still exist and usually fall back to env overrides, config overrides, disk cache, or defaults. |
| Config Gates tab | GrowthBook override helpers live in `growthbook.ts`. The Settings Gates tab is ant-only in source and may be compiled out in external builds; inspect `src/components/Settings/Settings.tsx`, `src/components/Settings/Config.tsx`, and `src/commands/config/` before assuming it is visible. |
| OpenTelemetry | `src/utils/telemetry/instrumentation.ts` and `events.ts` are stubs. API logging still calls `logOTelEvent`, but the current implementation returns without export. |
| Perfetto | Perfetto is the local tracing exception. It is env-enabled, writes under `~/.claude/traces/trace-<session-id>.json` by default, and has its own span/event lifecycle. |
| API logging vs cost | `src/services/api/logging.ts` records request analytics metadata and duration; `src/cost-tracker.ts` owns accumulated cost/token state. The successful API path connects them through `src/services/api/claude.ts`. |
| Diagnostics | IDE diagnostics are not part of product telemetry. They are local MCP/IDE feedback routed through `diagnosticTracker`, attachments, and `DiagnosticsDisplay`. |
| Doctor vs Status | `/doctor` is an installation/settings health screen. `/status` is the Settings Status tab and broader runtime summary. They overlap but are not interchangeable owners. |

## Analytics And Telemetry Routes

| Change target | Start here | Follow-up files |
|---|---|---|
| Add or remove a `logEvent` call | Call site, then `src/services/analytics/index.ts` | `src/services/analytics/metadata.ts` for PII-safe fields; `src/services/api/logging.ts` for API-specific events. |
| Change file-operation analytics | `src/utils/fileOperationAnalytics.ts` | `src/tools/FilePatchTool/FilePatchTool.tsx`, `src/services/analytics/index.ts` | Keep file-patch operation labels aligned with emitted result categories; do not infer mutation success from an unvalidated destination. |
| Change event sampling or first-party event behavior | `src/services/analytics/firstPartyEventLogger.ts` | `src/services/analytics/growthbook.ts` |
| Change Datadog behavior | `src/services/analytics/datadog.ts` | `src/services/analytics/sink.ts` |
| Change GrowthBook feature reads | `src/services/analytics/growthbook.ts` | Search for `getFeatureValue_CACHED_MAY_BE_STALE`, `getDynamicConfig_CACHED_MAY_BE_STALE`, `checkGate_CACHED_OR_BLOCKING`, and `checkSecurityRestrictionGate`. |
| Change config overrides | `src/services/analytics/growthbook.ts` | `src/components/Settings/Settings.tsx`, `src/components/Settings/Config.tsx`, `src/commands/config/`, `src/utils/config.ts` |
| Change startup initialization | `src/main.tsx`, `src/entrypoints/init.ts` | `src/utils/sinks.ts`, `src/utils/errorLogSink.ts`, `src/utils/telemetry/instrumentation.ts` |
| Change OTEL event fields | `src/utils/telemetry/events.ts` | `src/services/api/logging.ts`, `src/utils/telemetry/sessionTracing.ts` |
| Change local trace output | `src/utils/telemetry/perfettoTracing.ts` | API/tool tracing call sites and cleanup/exit handlers |

## Diagnostics And Doctor Routes

| Flow | Owner | Notes |
|---|---|---|
| Before edit baseline | `src/services/diagnosticTracking.ts:beforeFileEdited` | Called from file edit/write tools before mutating files. |
| Query-loop diagnostic reset/init | `src/services/diagnosticTracking.ts:handleQueryStart` | REPL calls it with MCP clients near query start; it finds the connected IDE client or resets tracked state. |
| New diagnostic attachment | `src/utils/attachments.ts` | Calls `diagnosticTracker.getNewDiagnostics()` and creates `type: 'diagnostics'` attachments. |
| Diagnostic rendering | `src/components/DiagnosticsDisplay.tsx` | Compact summary in normal mode, file/line list in verbose mode. |
| Text transcript summary | `src/utils/messages.ts` | Uses `DiagnosticTrackingService.formatDiagnosticsSummary`. |
| Installation checks | `src/utils/doctorDiagnostic.ts` | Installation type, binary path, update permissions, multiple installs, package manager, ripgrep status. |
| Doctor UI | `src/screens/Doctor.tsx` | Aggregates installation, agents, context warnings, settings validation, env validation, keybinding/MCP warnings, sandbox section, and native lock data. |
| Context warnings | `src/utils/doctorContextWarnings.ts` | CLAUDE.md size, agent descriptions, MCP tool tokens, unreachable permission rules. |

## Debug, Error, And API Logging Routes

| Flow | Owner | Notes |
|---|---|---|
| Debug enablement | `src/utils/debug.ts:isDebugMode` | Checks runtime enablement, `DEBUG`, `DEBUG_SDK`, `--debug`, `-d`, `--debug-to-stderr`, `--debug=<pattern>`, and `--debug-file`. |
| Debug destination | `src/utils/debug.ts:getDebugLogPath` | Uses `--debug-file`, `CLAUDE_CODE_DEBUG_LOGS_DIR`, or config debug directory with session ID. |
| Debug filtering | `src/utils/debug.ts:getDebugFilter` | Delegates pattern parsing and matching to `src/utils/debugFilter.ts`. |
| Prompt and optional Git timing | `src/utils/diagLogs.ts:withDiagnosticsTiming` | `src/utils/queryContext.ts`, `src/context.ts`, `src/utils/execFileNoThrow.ts` | Times prompt-part and read-only Git metadata work with metadata-only completion fields; it does not log prompt text, paths, or command output. |
| Runtime debug toggle | `src/utils/debug.ts:enableDebugLogging` | Used for mid-session debug capture without restart. |
| Desktop operational lifecycle | `app/main/operationalLogSink.ts:createOperationalLogSink` | `app/shared/operationalLog.ts`, `app/main/main.ts`, `app/supervisor/supervisor.ts`, `app/sidecar/operationalLogger.ts` | Separate from engine debug logs and product telemetry. The sink uses private permissions, bounded rotation/retention, deduplication, and a synchronous fatal close; records carry no raw diagnostic line or engine stderr. |
| Desktop delivery trace | `app/main/deliveryTraceSink.ts:createDeliveryTraceSink` | `app/shared/deliveryTrace.ts`, `app/main/main.ts`, `app/preload/{preload,deliveryAckQueue}.ts`, `app/renderer/src/App.tsx` | Metadata-only trace records and bounded watermarks identify a frame through main/preload/renderer delivery stages. Renderer acknowledgements are fixed, schema-validated IPC payloads; the preload queue retains rate-limited batches so diagnostics traffic cannot unmount the renderer. |
| Desktop GUI debug snapshot | `app/renderer/src/debugStateReport.ts` | `app/main/devHarness.ts`, `app/shared/debugState.ts` | Producer samples the newest 128 sidebar rows and retains the active row within that cap. The receiver remains closed and bounded; full host session rows remain separate. This diagnostic snapshot does not enter model prompts or the support bundle. |
| Desktop support bundle | `app/main/diagnosticsBundle.ts:buildDiagnosticsBundle` | `app/main/main.ts`, `app/renderer/src/SettingsShell.tsx`, `app/shared/operationalLog.ts` | Exports only parsed operational records and allowlisted delivery-trace objects. Coverage records distinguish rotated/tail-truncated sources, bounded export omission, rejected records, and known producer loss from a clean trace. Transcripts, caches, settings, vaults, raw debug logs, and renderer debug state are excluded. |
| Error recording | `src/utils/log.ts:logError` | Adds to in-memory errors and routes to attached sink unless disabled by provider/privacy/error-reporting gates. |
| Error sink attachment | `src/utils/log.ts:attachErrorLogSink` | Queues pre-sink errors and drains when the sink attaches. |
| API query event | `src/services/api/logging.ts:logAPIQuery` | Records model, message count, temperature, provider, permission/query metadata, thinking/effort/fast mode, and env model/base URL metadata. |
| API error event | `src/services/api/logging.ts:logAPIError` | Records classified error, status, gateway, request IDs, debug connection details, `logError`, OTEL stub event, beta span end, and teleport reliability marker. |
| API success event | `src/services/api/logging.ts:logAPISuccessAndDuration` | Computes durations, updates duration state, logs success metadata, emits OTEL stub event, ends beta span, and logs teleport success marker. |

## Stats, Cost, And Status Routes

| Flow | Owner | Notes |
|---|---|---|
| `/cost` exposure | `src/commands/cost/index.ts` | Hidden for Claude AI subscribers except ants; supports non-interactive command use. |
| `/cost` display | `src/commands/cost/cost.ts` | Subscriber message or `formatTotalCost()`, with ant-only breakdown for subscribers. |
| Cost accumulation and rates | `src/cost-tracker.ts`, `src/utils/{modelCost,modelCostRates}.ts` | Live cost tracking aggregates usage through the shared rate table. Retained-history analytics uses configured model identities and leaves unknown models unpriced; rate changes used by retained history require its pricing-version bump. |
| Cost persistence | `src/cost-tracker.ts:saveCurrentSessionCosts` | Writes last-session cost and model usage into project config; REPL calls it during session switching and exit summary. |
| Cost threshold UI | `src/screens/REPL.tsx`, `src/components/CostThresholdDialog.tsx` | REPL owns focus gating and acknowledgement persistence. |
| `/status` command | `src/commands/status/` | Opens Settings with `defaultTab="Status"`. |
| Status tab composition | `src/components/Settings/Status.tsx` | Builds sections from `src/utils/status.tsx` plus async diagnostics. |
| Status property builders | `src/utils/status.tsx` | Account, provider, proxy/mTLS, IDE, MCP summary, sandbox, memory, installation, settings sources, model label. |
| `cat-code codex status --json` | `src/cli/handlers/codexStatus.ts`, `src/services/api/codexStatus.ts` | Emits a single advisory JSON observation and exits. Valid observations exit 0 even for no-account or all-blocked pools; nonzero is reserved for internal command failure. |
| `/stats` command | `src/commands/stats/stats.tsx` | Lazy-renders `Stats` dialog. |
| Stats aggregation | `src/utils/stats.ts` | Reads transcript JSONL files and aggregates sessions/messages/model usage/activity/streaks/speculation time by event date, crediting usage increases once across streaming splits. The paired 7d/30d API shares discovery, modification-time checks and JSONL reads with independent range accumulators; a session's opening date does not exclude later activity. This terminal aggregation is separate from the desktop dashboard entry point `aggregateUsageDashboard()`; route dashboard persistence through `src/utils/statsUsageIndex.ts` and metric semantics through `src/utils/statsUsage.ts`. |
| Stats UI | `src/components/Stats.tsx` | Overview/models tabs, date-range switching, heatmap/charts, screenshot copy, async cache for range loads. |
| In-session metrics | `src/context/stats.tsx` | `StatsProvider` exposes counters/gauges/timers/sets and persists `lastSessionMetrics` on process exit. |
| Desktop retained-history analytics | `app/main/usageStatsRunner.ts`, `app/sidecar/usageStatsWorker.ts` | The independent worker calls `collectUsageDashboard()` in `app/sidecar/statsDomain.ts`. `src/utils/statsUsageIndex.ts` owns the derived index and saved snapshot; `src/utils/statsUsage.ts` owns metric semantics and timezone-based day buckets. The runner retains the last good renderer result on collection failure. Account quota polling remains in the accounts worker. |
| Tool-error diagnostics | `app/sidecar/usageSummary.ts`, `app/renderer/src/UsageToolErrorTrend.tsx` | Named error leaders precede request-volume leaders during grouping; the chart defaults to three named error leaders rather than grouped Other. All history uses at most 60 calendar buckets and envelope fallback reduces its detail independently of recent windows. Rates include error/result sample counts and omitted build observations remain explicit. Counting version 21 rebuilds saved grouping from unchanged index-v11 records. |
| Auto-mode diagnostic accounting | `src/utils/permissions/autoModeObservation.ts` | The initial automatic permission occurrence emits a closed metadata-only start/stage/end record. `src/utils/autoModeUsage.ts` joins and reduces one source at a time, then finalizes coverage and category grouping globally. `src/utils/statsUsage.ts` releases completed-source record reservations while retaining charges for merged aggregates; the source and collection budgets remain enforced. Malformed or unmatched records never become completed decisions, and unavailable or partial coverage stays explicit. `app/shared/usageAutoMode.ts` is the renderer-safe aggregate contract. |

## Tests And Validation

| Validation target | Inspect first | Then inspect |
|---|---|---|
| Settings schema errors | `src/utils/settings/validation.ts` | `src/utils/settings/allErrors.ts`, `src/utils/settings/settings.ts`, `src/utils/settings/mdm/settings.ts` |
| Settings error display | `src/components/ValidationErrorsList.tsx` | `src/hooks/notifs/useSettingsErrors.tsx`, `src/screens/Doctor.tsx`, `src/utils/status.tsx` |
| Permission rule validation | `src/utils/settings/permissionValidation.ts` | `src/utils/settings/toolValidationConfig.ts`, `src/utils/settings/validationTips.ts` |
| Edit-time settings validation | `src/utils/settings/validateEditTool.ts` | File edit/write tool validation call sites |
| Environment bounded ints | `src/utils/envValidation.ts` | `src/screens/Doctor.tsx` for `BASH_MAX_OUTPUT_LENGTH`, `TASK_MAX_OUTPUT_LENGTH`, and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` |
| Doctor context warnings | `src/utils/doctorContextWarnings.ts` | `src/utils/analyzeContext.ts`, `src/utils/statusNoticeHelpers.ts`, permission shadow detection |
| Desktop retained-history analytics and tool-error diagnostics | `bun test app/main/usageStatsRunner.test.ts app/sidecar/usageSummary.test.ts app/sidecar/usageSummary.integration.test.ts app/shared/usageStatsWorker.test.ts src/utils/statsUsage.test.ts src/utils/statsUsageIndex.test.ts app/renderer/src/UsagePage.test.tsx app/renderer/src/usageToolErrorTrend.test.ts app/renderer/src/UsageToolErrorTrend.diagnostics.dom.test.tsx` | `app/sidecar/statsDomain.ts`, `app/renderer/src/{UsagePage,UsageWorkPatterns,UsageToolErrorTrend}.tsx`, `app/shared/usageDashboard.ts` |
| Auto-mode observation and usage reduction | `bun test src/utils/permissions/autoModeObservation.test.ts src/utils/autoModeUsage.test.ts app/renderer/src/usageAutoModeState.test.ts app/renderer/src/usageAutoModeFlowState.test.ts` | `src/utils/permissions/autoModeObservation.ts`, `src/utils/autoModeUsage.ts`, `app/shared/usageAutoMode.ts` |

## Traps And Stale Assumptions

- Desktop usage statistics are an app-local, sidecar-validated read seam, not a
  shared engine protocol expansion. Do not accept renderer-authored file paths,
  dates, or arbitrary ranges.
- The desktop snapshot contains aggregates and model names only. It must not
  grow into a route for transcript content, prompts, credentials, or account
  tokens.
- `renderer.health.sample` distinguishes JS heap from renderer working set and
  committed renders. Do not restore the ambiguous `heapUsedBytes` field name.

## Refresh Checklist

`src/utils/usageWindow.ts` owns bounded timezone formatter caches (16 keys per
formatter kind) and calendar-boundary caches (512 keys each). Dates, timezones,
and rolling cutoff inputs participate in their keys; aggregation, source-prefix
verification, identity deduplication, and privacy projection keep their existing
owners. The reproducible conversion probe is
`scripts/benchmarks/resourceWasteBackground.ts`.

1. Re-read `CLAUDE.md` and `docs/maps/WORKSPACE_MAP.md`.
2. Check whether telemetry stubs changed in `src/services/analytics/` and `src/utils/telemetry/`.
3. Re-check GrowthBook enablement, config override paths, and Settings Gates visibility.
4. Re-check `/doctor`, `/status`, `/stats`, `/cost`, and `cat-code codex status --json` command routing through `src/commands.ts` or `src/main.tsx`.
5. Re-check API logging fields in `src/services/api/logging.ts` against `src/services/api/claude.ts`.
6. Re-check diagnostics call sites from file edit/write tools through attachments and displays.
7. For docs-only edits, run `git diff --check` and a path/link sanity check.
