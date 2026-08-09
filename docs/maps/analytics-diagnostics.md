# Analytics And Diagnostics Map

Last refreshed: 2026-08-06

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
| Analytics public API | `src/services/analytics/index.ts` | `src/services/analytics/sink.ts`, `src/services/analytics/config.ts` | `logEvent`, `logEventAsync`, and sink attachment are no-ops in this build. Keep call sites unchanged unless the task is to change the compatibility boundary. |
| GrowthBook gates/config | `src/services/analytics/growthbook.ts` | `src/components/Settings/Settings.tsx`, `src/commands/config/`, `src/hooks/useMainLoopModel.ts`, `src/hooks/useSkillsChange.ts` | Feature reads, config overrides, cache fallback, refresh listeners, and security gate helpers live here. Initialization is gated by 1P event logging. |
| Analytics sinks | `src/services/analytics/sink.ts` | `src/services/analytics/datadog.ts`, `src/services/analytics/firstPartyEventLogger.ts`, `src/services/analytics/firstPartyEventLoggingExporter.ts`, `src/services/analytics/sinkKillswitch.ts` | Sink startup and Datadog/1P logger are inert; exporter code remains as an implementation surface for tests or future re-enable work. |
| Metadata and PII gates | `src/services/analytics/metadata.ts` | Analytics call sites with `logEvent(...)`, MCP/plugin/skill telemetry helpers | Owns metadata marker types, MCP tool-name redaction, official/built-in MCP detail gates, and helper field builders. |
| OSS/OTEL telemetry stubs | `src/utils/telemetry/instrumentation.ts`, `src/utils/telemetry/events.ts` | `src/entrypoints/init.ts`, `src/utils/telemetry/sessionTracing.ts`, `src/utils/telemetry/betaSessionTracing.ts` | `initializeTelemetryAfterTrust`, `initializeTelemetry`, `flushTelemetry`, `logOTelEvent`, and tracing spans are inert unless a specific tracing file says otherwise. |
| Perfetto tracing | `src/utils/telemetry/perfettoTracing.ts` | API/tool span call sites, cleanup registry, env var gates | Perfetto writes Chrome trace JSON when enabled by env; separate from disabled product telemetry. |
| Plugin/skill telemetry helpers | `src/utils/telemetry/pluginTelemetry.ts`, `src/utils/telemetry/skillLoadedEvent.ts` | `src/main.tsx`, plugin load/command code | Helpers still call `logEvent`, so in this build they preserve routing without emitting product analytics. |
| IDE diagnostics tracking | `src/services/diagnosticTracking.ts` | `src/tools/FileEditTool/shared.ts`, `src/tools/FileWriteTool/FileWriteTool.ts`, `src/utils/attachments.ts`, `src/components/DiagnosticsDisplay.tsx` | Captures baseline diagnostics before edits, fetches new IDE diagnostics after changes, and renders them as attachments. |
| Doctor command | `src/commands/doctor/index.ts`, `src/commands/doctor/doctor.tsx` | `src/screens/Doctor.tsx`, `src/utils/doctorDiagnostic.ts`, `src/utils/doctorContextWarnings.ts` | `/doctor` lazy-loads the Doctor screen; it is disabled only by `DISABLE_DOCTOR_COMMAND`. |
| Status command/dialog | `src/commands/status/index.ts`, `src/commands/status/status.tsx` | `src/components/Settings/Settings.tsx`, `src/components/Settings/Status.tsx`, `src/utils/status.tsx` | `/status` opens Settings on the Status tab. Status aggregates account, provider, IDE, MCP, settings, install, memory, sandbox, and diagnostics. |
| Codex pool status JSON | `src/cli/handlers/codexStatus.ts`, `src/services/api/codexStatus.ts` | `src/main.tsx`, `src/services/api/codexAccountPool.ts`, `src/services/api/codexUsage.ts`, [`codex-core.md`](codex-core.md) | `cat-code codex status --json` is a read-only advisory observation for external delegation/scheduling. It emits opaque profile refs, pool counts, usage freshness, and a decision action without raw account identity or token material. |
| Debug logging | `src/utils/debug.ts` | `src/utils/debugFilter.ts`, `/debug` command surfaces, call sites using `logForDebugging` | Controls debug mode, file path, stderr/file output, filters, level threshold, runtime enablement, and latest symlink. |
| Desktop operational logs | `app/main/operationalLogSink.ts` | `app/shared/operationalLog.ts`, `app/main/main.ts`, `app/supervisor/supervisor.ts`, `app/sidecar/operationalLogger.ts` | Main owns the private, bounded JSONL sink. Producers may emit only the closed metadata schema; sidecar diagnostics cross a dedicated FD 3 descriptor and raw stderr is never persisted. |
| Desktop delivery trace and support export | `app/main/deliveryTraceSink.ts`, `app/main/diagnosticsBundle.ts` | `app/shared/deliveryTrace.ts`, `app/main/main.ts`, `app/preload/preload.ts`, `app/renderer/src/App.tsx`, `app/renderer/src/RendererErrorBoundary.tsx`, `app/renderer/src/SettingsShell.tsx` | Per-frame metadata tracks the desktop handoff and validated renderer acknowledgements. Settings exposes fixed actions to reveal private logs or save an allowlisted local support bundle; neither action gives the renderer a filesystem destination. |
| Error logging | `src/utils/log.ts` | `src/utils/errorLogSink.ts`, `src/utils/sinks.ts`, MCP log call sites | Owns `logError`, in-memory recent errors, queued sink attachment, and persistent error/MCP logging boundary. |
| API request logging | `src/services/api/logging.ts` | `src/services/api/claude.ts`, `src/utils/telemetry/sessionTracing.ts`, `src/utils/telemetry/perfettoTracing.ts`, `src/cost-tracker.ts` | Logs API query/success/error metadata, gateway detection, request IDs, OTEL event stubs, beta spans, duration state, and teleport first-message events. |
| Cost tracking | `src/cost-tracker.ts` | `src/commands/cost/`, `src/costHook.ts`, `src/screens/REPL.tsx`, `src/bootstrap/state.ts` | Tracks session cost, token usage, API/tool duration, code-change counts, persistence on exit/session switch, and `/cost` display. |
| Stats UI and aggregation | `src/commands/stats/stats.tsx`, `src/components/Stats.tsx` | `src/utils/stats.ts`, `src/context/stats.tsx`, `src/utils/statsCache.ts` | `/stats` renders transcript-derived usage/activity; `StatsProvider` persists in-session metrics to project config on exit. |
| Validation display | `src/components/ValidationErrorsList.tsx` | `src/hooks/notifs/useSettingsErrors.tsx`, `src/utils/settings/allErrors.ts`, `src/utils/settings/validation.ts`, `src/utils/envValidation.ts` | Settings validation feeds Doctor and Status. Environment bounded-int validation is currently Doctor-specific. |

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
| Desktop delivery trace | `app/main/deliveryTraceSink.ts:createDeliveryTraceSink` | `app/shared/deliveryTrace.ts`, `app/main/main.ts`, `app/preload/preload.ts`, `app/renderer/src/App.tsx` | Metadata-only trace records and bounded watermarks identify a frame through main/preload/renderer delivery stages. Renderer acknowledgements are fixed, schema-validated IPC payloads. |
| Desktop support bundle | `app/main/diagnosticsBundle.ts:buildDiagnosticsBundle` | `app/main/main.ts`, `app/renderer/src/SettingsShell.tsx`, `app/shared/operationalLog.ts` | Exports only parsed operational records and allowlisted delivery-trace objects. Transcripts, caches, settings, vaults, raw debug logs, and renderer debug state are excluded. |
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

## Tests And Validation

| Validation target | Inspect first | Then inspect |
|---|---|---|
| Settings schema errors | `src/utils/settings/validation.ts` | `src/utils/settings/allErrors.ts`, `src/utils/settings/settings.ts`, `src/utils/settings/mdm/settings.ts` |
| Settings error display | `src/components/ValidationErrorsList.tsx` | `src/hooks/notifs/useSettingsErrors.tsx`, `src/screens/Doctor.tsx`, `src/utils/status.tsx` |
| Permission rule validation | `src/utils/settings/permissionValidation.ts` | `src/utils/settings/toolValidationConfig.ts`, `src/utils/settings/validationTips.ts` |
| Edit-time settings validation | `src/utils/settings/validateEditTool.ts` | File edit/write tool validation call sites |
| Environment bounded ints | `src/utils/envValidation.ts` | `src/screens/Doctor.tsx` for `BASH_MAX_OUTPUT_LENGTH`, `TASK_MAX_OUTPUT_LENGTH`, and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` |
| Doctor context warnings | `src/utils/doctorContextWarnings.ts` | `src/utils/analyzeContext.ts`, `src/utils/statusNoticeHelpers.ts`, permission shadow detection |

## Refresh Checklist

1. Re-read `CLAUDE.md` and `docs/maps/WORKSPACE_MAP.md`.
2. Check whether telemetry stubs changed in `src/services/analytics/` and `src/utils/telemetry/`.
3. Re-check GrowthBook enablement, config override paths, and Settings Gates visibility.
4. Re-check `/doctor`, `/status`, `/stats`, `/cost`, and `cat-code codex status --json` command routing through `src/commands.ts` or `src/main.tsx`.
5. Re-check API logging fields in `src/services/api/logging.ts` against `src/services/api/claude.ts`.
6. Re-check diagnostics call sites from file edit/write tools through attachments and displays.
7. For docs-only edits, run `git diff --check` and a path/link sanity check.
