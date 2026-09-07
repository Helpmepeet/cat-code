# Analytics And Diagnostics Map

Last refreshed: 2026-09-06

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
| Analytics API and gates | `src/services/analytics/index.ts`, `src/services/analytics/growthbook.ts` | `src/services/analytics/{sink,config,metadata}.ts`, analytics call sites | Public logging remains a compatibility boundary; inspect metadata redaction and gate/config fallbacks before changing a call site. |
| Local telemetry and tracing | `src/utils/telemetry/instrumentation.ts`, `src/utils/telemetry/perfettoTracing.ts` | `src/utils/telemetry/{events,sessionTracing,betaSessionTracing}.ts`, `src/entrypoints/init.ts` | OTEL entrypoints are inert in this build; Perfetto remains the env-enabled local trace writer. |
| Desktop operational diagnostics | `app/main/operationalLogSink.ts` | `app/shared/operationalLog.ts`, `app/main/{deliveryTraceSink,diagnosticsBundle}.ts`, `app/sidecar/operationalLogger.ts` | Main owns bounded private JSONL and allowlisted support export; raw sidecar stderr never persists. Turn lifecycle is priority-preserved and exempt from short rate dedupe; peer-routing records are metadata-only with no message-text field. |
| Desktop usage statistics | `app/sidecar/statsDomain.ts`, `app/shared/protocol.ts` | `app/sidecar/sidecarServer.ts`, `app/renderer/src/{App,AccountsPage,AccountsUsageSection}.tsx`, `app/renderer/src/statsState.ts`, `src/utils/stats.ts` | The sidecar projects real transcript-derived aggregates into a redacted `stats.usage.snapshot`; renderer range changes are a closed `stats.query` verb for 7d or 30d. |
| Doctor, status, and validation | `src/commands/{doctor,status}/` | `src/screens/Doctor.tsx`, `src/components/Settings/Status.tsx`, `src/utils/doctorDiagnostic.ts`, `src/utils/status.tsx`, `src/utils/envValidation.ts` | `/doctor` and `/status` overlap but have distinct owners; settings and environment validation feed their displays. |
| IDE diagnostics and debug/error logs | `src/services/diagnosticTracking.ts`, `src/utils/debug.ts` | `src/utils/{attachments,log,errorLogSink}.ts`, `src/components/DiagnosticsDisplay.tsx` | IDE diagnostics are local edit feedback; debug/error output has separate enablement, filtering, and persistence paths. |
| Cost and terminal stats | `src/cost-tracker.ts`, `src/commands/stats/stats.tsx` | `src/components/Stats.tsx`, `src/utils/{stats,statsCache}.ts`, `src/context/stats.tsx` | Terminal `/stats` and cost tracking remain separate from desktop usage-stat projection. |

## Current Build Decisions

| Topic | Routing decision |
|---|---|
| Product analytics | Treat `src/services/analytics/index.ts` as the public compatibility API. Do not chase telemetry behavior from call sites alone; most calls terminate in no-op functions in this build. |
| Analytics disable checks | `src/services/analytics/config.ts:isAnalyticsDisabled()` is still used by API helper paths and startup guards. It disables analytics in tests, 3P cloud provider modes, Foundry, and privacy levels that disallow telemetry. |
| GrowthBook initialization | `src/services/analytics/growthbook.ts:isGrowthBookEnabled()` delegates to `is1PEventLoggingEnabled()`, which returns false in this build. Feature getter helpers still exist and usually fall back to env overrides, config overrides, disk cache, or defaults. |
| Config Gates tab | GrowthBook override helpers live in `growthbook.ts`. The Settings Gates tab is ant-only in source and may be compiled out in external builds; inspect `src/components/Settings/Settings.tsx`, `src/components/Settings/Config.tsx`, and `src/commands/config/` before assuming it is visible. |
| Sink killswitch | `src/services/analytics/sinkKillswitch.ts` reads GrowthBook dynamic config `tengu_frond_boric` for per-sink kills. It is only meaningful if sink dispatch is enabled. |
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
| Change event sampling or first-party event behavior | `src/services/analytics/firstPartyEventLogger.ts` | `src/services/analytics/firstPartyEventLoggingExporter.ts`, `src/services/analytics/growthbook.ts`, `src/services/analytics/sinkKillswitch.ts` |
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
| Runtime debug toggle | `src/utils/debug.ts:enableDebugLogging` | Used for mid-session debug capture without restart. |
| Desktop operational lifecycle | `app/main/operationalLogSink.ts:createOperationalLogSink` | `app/shared/operationalLog.ts`, `app/main/main.ts`, `app/supervisor/supervisor.ts`, `app/sidecar/operationalLogger.ts` | Separate from engine debug logs and product telemetry. The sink uses private permissions, bounded rotation/retention, deduplication, and a synchronous fatal close; records carry no raw diagnostic line or engine stderr. |
| Desktop delivery trace | `app/main/deliveryTraceSink.ts:createDeliveryTraceSink` | `app/shared/deliveryTrace.ts`, `app/main/main.ts`, `app/preload/{preload,deliveryAckQueue}.ts`, `app/renderer/src/App.tsx` | Metadata-only trace records and bounded watermarks identify a frame through main/preload/renderer delivery stages. Renderer acknowledgements are fixed, schema-validated IPC payloads; the preload queue retains rate-limited batches so diagnostics traffic cannot unmount the renderer. |
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
| Cost accumulation | `src/cost-tracker.ts` | Normalizes usage, calculates USD, aggregates per-model tokens/cost, tracks unknown model cost, lines changed, web search requests, and durations. |
| Cost persistence | `src/cost-tracker.ts:saveCurrentSessionCosts` | Writes last-session cost and model usage into project config; REPL calls it during session switching and exit summary. |
| Cost threshold UI | `src/screens/REPL.tsx`, `src/components/CostThresholdDialog.tsx` | REPL owns focus gating and acknowledgement persistence. |
| `/status` command | `src/commands/status/` | Opens Settings with `defaultTab="Status"`. |
| Status tab composition | `src/components/Settings/Status.tsx` | Builds sections from `src/utils/status.tsx` plus async diagnostics. |
| Status property builders | `src/utils/status.tsx` | Account, provider, proxy/mTLS, IDE, MCP summary, sandbox, memory, installation, settings sources, model label. |
| `cat-code codex status --json` | `src/cli/handlers/codexStatus.ts`, `src/services/api/codexStatus.ts` | Emits a single advisory JSON observation and exits. Valid observations exit 0 even for no-account or all-blocked pools; nonzero is reserved for internal command failure. |
| `/stats` command | `src/commands/stats/stats.tsx` | Lazy-renders `Stats` dialog. |
| Stats aggregation | `src/utils/stats.ts` | Reads transcript JSONL files, aggregates sessions/messages/model usage/activity/streaks/speculation time, and uses stats cache helpers. |
| Stats UI | `src/components/Stats.tsx` | Overview/models tabs, date-range switching, heatmap/charts, screenshot copy, async cache for range loads. |
| In-session metrics | `src/context/stats.tsx` | `StatsProvider` exposes counters/gauges/timers/sets and persists `lastSessionMetrics` on process exit. |
| Desktop usage statistics | `app/sidecar/statsDomain.ts` | The sidecar reads `aggregateClaudeCodeStatsForRange()` and sends redacted totals, daily model/activity data, cache metrics, and model names to the Accounts surface; no transcript text or credentials cross the boundary. |

## Tests And Validation

| Validation target | Inspect first | Then inspect |
|---|---|---|
| Settings schema errors | `src/utils/settings/validation.ts` | `src/utils/settings/allErrors.ts`, `src/utils/settings/settings.ts`, `src/utils/settings/mdm/settings.ts` |
| Settings error display | `src/components/ValidationErrorsList.tsx` | `src/hooks/notifs/useSettingsErrors.tsx`, `src/screens/Doctor.tsx`, `src/utils/status.tsx` |
| Permission rule validation | `src/utils/settings/permissionValidation.ts` | `src/utils/settings/toolValidationConfig.ts`, `src/utils/settings/validationTips.ts` |
| Edit-time settings validation | `src/utils/settings/validateEditTool.ts` | File edit/write tool validation call sites |
| Environment bounded ints | `src/utils/envValidation.ts` | `src/screens/Doctor.tsx` for `BASH_MAX_OUTPUT_LENGTH`, `TASK_MAX_OUTPUT_LENGTH`, and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` |
| Doctor context warnings | `src/utils/doctorContextWarnings.ts` | `src/utils/analyzeContext.ts`, `src/utils/statusNoticeHelpers.ts`, permission shadow detection |
| Desktop usage stats | `bun test app/sidecar/statsDomain.test.ts app/renderer/src/statsState.test.ts app/renderer/src/AccountsPage.test.tsx app/sidecar/sidecarServer.test.ts` | `app/sidecar/statsDomain.ts`, `app/renderer/src/statsState.ts` |

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

1. Re-read `CLAUDE.md` and `docs/maps/WORKSPACE_MAP.md`.
2. Check whether telemetry stubs changed in `src/services/analytics/` and `src/utils/telemetry/`.
3. Re-check GrowthBook enablement, config override paths, and Settings Gates visibility.
4. Re-check `/doctor`, `/status`, `/stats`, `/cost`, and `cat-code codex status --json` command routing through `src/commands.ts` or `src/main.tsx`.
5. Re-check API logging fields in `src/services/api/logging.ts` against `src/services/api/claude.ts`.
6. Re-check diagnostics call sites from file edit/write tools through attachments and displays.
7. For docs-only edits, run `git diff --check` and a path/link sanity check.
