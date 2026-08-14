# Desktop Application Logging Audit And Implementation Blueprint

**Date:** 2026-08-06
**Scope:** Electron desktop application (`app/`) plus the engine logging surfaces that its Bun sidecars inherit (`src/utils/debug.ts`, `src/utils/log.ts`, and related startup/cleanup code)
**Status:** Review and implementation blueprint only. No runtime code was changed.
**Primary consumer:** The session that implements durable, privacy-safe desktop operational logging and event-delivery tracing.

## Executive verdict

Cat Code has logging, but it does not yet have one coherent desktop application log.

The current system has three distinct artifacts:

1. **Engine debug logs** under `<config-home>/debug/<engineSessionId>.txt`. These are rich and useful when debug logging is enabled, but they are engine-oriented, can contain sensitive local metadata, and are not a substitute for desktop-process lifecycle logging.
2. **Plain stdout/stderr diagnostics** from Electron main, the host, supervisor, workers, and Bun sidecars. These contain useful failure messages, but the desktop app does not own a persistent sink for them. A terminal-launched development run displays them; a packaged launch has no app-controlled retrieval path.
3. **Transcripts, replay caches, renderer raw-message state, and dev debug-state snapshots.** These are product/session state, not operational logs. They must not be treated as a support log or copied into one by default.

The right next step is not to add more isolated `console.error()` or `process.stderr.write()` calls. It is to build a small desktop-owned operational logging layer with strict event schemas, correlation IDs, safe file permissions, redaction, bounded retention, crash coverage, and a user-facing diagnostics export.

A post-audit debugging requirement tightens that conclusion: the app also needs a compact, persistent **event-delivery trace**. The operational log alone can show that an engine or host completed work, but it cannot prove whether the renderer received, reduced, and committed the resulting event. The delivery trace must preserve one event sequence across the engine, sidecar, host, attachment/replay gate, IPC bridge, renderer state projection, and selected UI commits. It is a separate logical record stream because its completeness and retention rules differ from ordinary operational logs.

The implementation should preserve the locked desktop topology:

- Unix-domain socket remains the application protocol transport.
- One engine sidecar process per live session remains unchanged.
- Raw `AppSessionEvent` fidelity over the socket remains unchanged.
- No generic renderer-to-main logging API is allowed.
- No prompt, transcript, tool input/output, credential, or permission-rule content enters either the operational log or delivery trace.

## Scope and method

This audit inspected:

- Desktop process and trust boundaries: `app/main/`, `app/host/`, `app/supervisor/`, `app/sidecar/`, `app/preload/`, `app/renderer/`, and `app/shared/`.
- Engine logging owners: `src/utils/debug.ts`, `src/utils/log.ts`, `src/utils/errorLogSink.ts`, `src/utils/diagLogs.ts`, `src/utils/gracefulShutdown.ts`, and `src/utils/cleanup.ts`.
- Desktop sidecar initialization: `app/sidecar/initializeRuntime.ts` and `app/sidecar/sessionController.ts`.
- The current renderer delivery path: `app/main/attachmentGate.ts`, `app/main/replayBuffer.ts`, `app/preload/preload.ts`, `app/renderer/src/App.tsx`, and `app/renderer/src/serverFrameBatch.ts`.
- Existing logging/observability plans under `docs/plans/2026-06-04-logging-review/` and `docs/reports/2026-04-30-session-observability-*.md`.
- The current on-disk logging state under `~/.cat-code/` without printing credentials or transcript content.

The audit did not launch or drive the GUI, exercise live accounts, or mutate runtime files.

The working tree contained concurrent in-progress changes when reviewed. The findings describe the current source snapshot and are not claims about a clean historical commit.

## Current architecture

### Electron main, host, and supervisor

Electron main constructs the supervisor and host, passing callbacks that write lines to `process.stderr` (`app/main/main.ts:470`, `:515`, `:517`, `:546`, `:548`, `:581`, `:672`, `:677`).

The supervisor and host describe these callbacks as structured loggers, but their actual contract is only:

```ts
log?: (line: string) => void
```

See:

- `app/supervisor/supervisor.ts:67-68`
- `app/host/host.ts:73-74`
- `app/host/registry.ts:162-163`

The supervisor spawns each Bun sidecar with inherited stdout and stderr:

```ts
stdio: ['ignore', 'inherit', 'inherit']
```

See `app/supervisor/supervisor.ts:251-253`. This is convenient for development but gives Electron main no bounded, typed, or redacted sidecar diagnostic stream to persist.

The development launcher also inherits Vite and Electron stdio (`app/scripts/dev.ts:95-100`, `:126-130`). It reports child startup/readiness/exit failures, which is good development ergonomics, but it is not a packaged-application log.

### Bun sidecar

The sidecar uses a mixture of:

- an injected `log?: (line: string) => void` in `app/sidecar/sidecarServer.ts:315-316`;
- direct `process.stderr.write()` calls in `index.ts`, `sessionController.ts`, and several domains;
- a remaining `console.error()` in the context-breakdown failure path (`app/sidecar/sessionController.ts:628-630`);
- engine logging imported indirectly through the real runtime.

The sidecar server has strong outbound frame protection, but that protection does not make stderr safe to persist. `sendError()` strips absolute paths and bounds the user-visible error (`app/sidecar/sidecarServer.ts:3382-3406`), while the adjacent contract explicitly says the full error text still reaches sidecar stderr (`:3420-3424`).

Therefore, changing supervisor stdio from `inherit` to a raw file capture would create a privacy regression. Sidecar operational events need a separate sanitized channel or sink.

### Engine debug logs

`src/utils/debug.ts` owns debug logging:

- Debug is enabled by environment or CLI switches (`src/utils/debug.ts:63-75`).
- Non-ant users normally log only when debug is enabled, except a narrow always-log prefix list (`:108-123`).
- Records include timestamp and level (`:230-253`).
- The default destination is `<config-home>/debug/<engineSessionId>.txt` (`:256-261`).
- `latest` is maintained as a symlink (`:148-163`).

In the audited environment, a debug-related setting exists in `~/.cat-code/settings.json`, so desktop engine sidecars are producing debug files even though the launching shell itself has no `DEBUG`, `DEBUG_SDK`, `CLAUDE_CODE_DEBUG_LOGS_DIR`, or `CLAUDE_CODE_DIAGNOSTICS_FILE` value.

These logs are diagnostically useful, but a representative desktop-associated file included categories such as:

- filesystem paths;
- account aliases and opaque account identifiers;
- permission-rule text;
- plugin and skill names;
- repository URLs and names;
- configuration and environment-key names.

No raw credential was intentionally inspected or reproduced in this report. The observed metadata is already enough to require restrictive permissions and a separate redaction pass before support export.

### Engine error sink

`logError()` records an error in memory and queues it when no sink is attached (`src/utils/log.ts:158-199`). The normal engine sink is attached by `initSinks()` (`src/utils/sinks.ts:13-15`), whose file implementation is in `src/utils/errorLogSink.ts`.

Desktop sidecar initialization calls only the real engine `init()` (`app/sidecar/initializeRuntime.ts:40-43`). No `initSinks()` call exists under `app/sidecar/` or `src/app-runtime/`.

Consequences:

- `logError()` still enters the in-memory ring unless a privacy/provider gate suppresses it.
- QueryEngine can include turn-scoped in-memory errors in an `error_during_execution` result (`src/QueryEngine.ts:782-786`, `:1227-1241`).
- The desktop sidecar does not consistently attach the normal persistent error sink.
- Calling generic `initSinks()` is not automatically the correct fix: the current error sink can include full stacks, URLs, and server messages (`src/utils/errorLogSink.ts:149-173`). A desktop operational sink needs a stricter privacy contract.

### Environment-gated diagnostics

`logForDiagnosticsNoPII()` writes only when `CLAUDE_CODE_DIAGNOSTICS_FILE` is set (`src/utils/diagLogs.ts:27-35`, `:59-61`). It silently returns otherwise.

Engine startup installs `uncaughtException` and `unhandledRejection` handlers that report through this diagnostics function and inert product analytics (`src/utils/gracefulShutdown.ts:314-348`). In an ordinary desktop environment without the diagnostics-file variable:

- no durable diagnostic record is produced by that path;
- the handlers do not explicitly terminate the process after an uncaught exception;
- a sidecar may therefore lose the original fatal evidence and may continue in an uncertain state.

The desktop sidecar's top-level `main().catch(...)` does log startup/resume failure (`app/sidecar/index.ts:388-399`), but it does not cover every later uncaught process error.

### Cleanup and retention nuance

An initial source-only check of `debug.ts` suggested no cleanup, but cleanup does exist elsewhere:

- `cleanupOldDebugLogs()` deletes `.txt` files older than the configured cutoff (`src/utils/cleanup.ts:390-429`).
- The default cutoff is 30 days through `cleanupPeriodDays` (`src/utils/cleanup.ts:23-30`).
- It is called from `cleanupOldMessageFilesInBackground()` (`src/utils/cleanup.ts:575-594`).
- That work is scheduled through `startBackgroundHousekeeping()` after a ten-minute delay (`src/utils/backgroundHousekeeping.ts:28-31`, `:43-80`).

However, desktop sidecars call `init()` directly and do not call `startBackgroundHousekeeping()`. The current desktop application therefore does not itself trigger debug-log cleanup. A separate interactive terminal session may eventually clean the shared debug directory, but desktop log retention must not depend on the user also running a long-lived terminal session.

This distinction matters:

- **Retention implementation exists.** It should not be described as wholly absent.
- **Desktop-owned retention does not exist.** The app does not schedule it and does not own a size cap.

### Renderer and product-state artifacts

The renderer has no application-wide React error boundary. The root renders providers and `<App />` directly (`app/renderer/src/main.tsx:23-36`). `MarkdownErrorBoundary` protects only Markdown rendering in `app/renderer/src/TranscriptView.tsx`.

Electron main does not currently register handlers for:

- `webContents` `did-fail-load`;
- `render-process-gone`;
- `unresponsive` / `responsive`;
- Electron `child-process-gone`;
- main-process `uncaughtException` / `unhandledRejection`.

The renderer load promises are intentionally discarded (`app/main/main.ts:840-855`), so a rejected load has no explicit app-owned log event.

`app/renderer/src/rawMessageLog.ts` retains up to 8,000 SDK messages or 8 MiB per session (`:37-43`, `:86-183`). This is live transcript/debug state and may contain user/model/tool content. It is not an operational log and must never be automatically attached to a diagnostics bundle.

The dev-only state export under `<config-home>/desktop/debug/state.json` is similarly not an operational log. It is enabled only by the development harness (`app/main/main.ts:1532-1569`) and may carry UI/session metadata.

### Existing renderer delivery path has no end-to-end acknowledgement

The desktop already protects pre-attach and reload delivery with a replay buffer and attachment gate:

1. `wireRendererBridge()` receives supervisor events, converts them to `ServerFrame`, and passes them through `AttachmentGate` (`app/main/main.ts:875-903`).
2. `AttachmentGate.onFrame()` records every frame and either buffers or returns it for live delivery (`app/main/attachmentGate.ts:73-118`). `onRendererReady()` and `onNavigationStart()` own attach/replay epochs (`:160-171`).
3. Main batches frames into one `webContents.send()` (`app/main/main.ts:586-603`).
4. Preload receives the batch and invokes the renderer subscriber (`app/preload/preload.ts:224-234`).
5. The renderer callback projects the batch through `applyServerFrameBatch()` (`app/renderer/src/App.tsx:847-897`), which dispatches once into each relevant store (`app/renderer/src/serverFrameBatch.ts:77-116`).

This is a sound delivery path, but its current evidence stops at attempted send. `rendererReady` proves attachment and triggers replay; it does not acknowledge each frame. There is no persistent proof that a specific frame reached preload, entered the renderer callback, was applied to state, or caused the important terminal UI state to commit. Batched delivery also means a batch-level log without per-frame trace identities would be ambiguous.

## On-disk evidence snapshot

Read-only measurements on 2026-08-06 found:

| Artifact | Observation |
|---|---|
| Engine debug directory | 5,947 `.txt` files |
| Engine debug total | 125,667,491 bytes, approximately 120 MiB |
| Desktop registry | 74 rows, 61 unique engine session IDs |
| Registry-linked debug files | 61 of 61 IDs had a matching debug file |
| Registry-linked debug volume | 29,889,962 bytes, approximately 28.5 MiB, across 310,210 lines |
| Debug directory mode | `drwxr-xr-x` (`0755`) |
| Representative debug file mode | `-rw-r--r--` (`0644`) |
| Desktop operational-log directory | No `<config-home>/desktop/logs` directory found |
| Standard macOS Cat Code log directories checked | No app-owned Cat Code / Cat Code Dev log directory found |

These counts are a point-in-time snapshot, not a test baseline. The directory is shared by CLI and desktop engine sessions.

The `0755` directory plus `0644` files are too permissive for artifacts containing paths, account metadata, permission rules, and repository/plugin details. Parent-directory permissions may reduce exposure on some machines, but the logging layer should not rely on that accident.

## Findings

### F1. No durable desktop operational log

**Severity:** High

Main, host, supervisor, worker, and sidecar failures mostly go to inherited stderr. There is no app-controlled file that can answer:

- which process failed;
- which app/engine session it belonged to;
- what lifecycle state preceded the failure;
- whether the app recovered;
- how long the failed operation took;
- where a packaged-app user can retrieve the evidence.

This is the central gap.

### F2. Existing debug artifacts need stronger privacy and storage controls

**Severity:** High

Engine debug logs use normal process umask behavior rather than an explicit private-file contract. They can contain sensitive operational metadata, and desktop does not own cleanup scheduling or a total-byte cap.

Age-based cleanup alone is insufficient for a high-volume failure loop. The future desktop log needs both age and total-size limits.

### F3. Crash and renderer-load evidence is missing

**Severity:** High

The hardest failures to reproduce have the least durable signal:

- main-process crash;
- renderer load failure;
- renderer process crash;
- renderer unresponsive event;
- unhandled renderer component exception;
- sidecar uncaught exception or unhandled rejection.

The app can often show a dead/disconnected session afterward, but the original crash cause is not preserved in one app-owned artifact.

### F4. The current logger contracts are strings, not structured records

**Severity:** Medium

The current injected log functions cannot enforce required fields, redaction, severity, or event naming. Prefix parsing is brittle and cannot reliably join multi-process events.

### F5. Sidecar stderr is unsafe to capture wholesale

**Severity:** High

Some sidecar error paths intentionally keep full error text on stderr even when the renderer receives a redacted message. Capturing all stderr into a persistent or exported file would preserve absolute paths and could preserve other sensitive error values.

The implementation needs a separate sanitized operational stream. Raw stderr remains a development/debug channel.

### F6. Desktop error-sink initialization is incomplete

**Severity:** Medium

The sidecar initializes the engine but does not attach the normal error sink. Errors remain available in memory to some query/result paths, but persistence is inconsistent. The fix must not simply turn on a sink that violates the desktop privacy contract.

### F7. There is no diagnostics retrieval workflow

**Severity:** Medium

No renderer action opens the logs folder or creates a bounded, redacted support bundle. Users cannot easily attach the evidence that does exist.

### F8. Important lifecycle and timing transitions are not recorded

**Severity:** Medium

Existing errors are often good one-line diagnostics, but success and transition breadcrumbs are sparse. A failure log without the last successful phase is much harder to diagnose.

### F9. Logging invariants lack dedicated tests

**Severity:** Medium

Tests assert selected log messages and worker stderr behavior, but there is no systemic suite for:

- private permissions;
- record schemas;
- redaction;
- rotation and retention;
- crash flush;
- multi-session correlation;
- event-rate limiting;
- the prohibition on prompt/transcript/tool content.

### F10. No end-to-end event-delivery proof

**Severity:** High

The current bridge is intentionally one-way for server frames. Main can prove that it called `webContents.send()`, but not that a particular event:

- reached preload;
- entered the renderer subscription;
- was reduced into every relevant store;
- committed the resulting terminal state to the UI;
- arrived in order and exactly once.

There is also no shared event sequence, per-process start identity, monotonic stage timestamp, connection/subscription epoch, or per-layer delivery watermark. A stuck-session export therefore cannot identify the first layer that failed to acknowledge the final event. This is a separate high-priority observability gap, not a request to persist event content.

## Relationship to existing observability work

This report does not replace the engine-domain review in `docs/plans/2026-06-04-logging-review/`.

That review audited missing production breadcrumbs for auto mode, provider routing, subagents, Codex accounts, compaction, apply-patch, and transport/cache behavior. Its recurring recommendation was to add narrow always-log prefixes to the existing engine debug system.

The two efforts have different scopes:

| Existing June review | This report |
|---|---|
| Engine-domain decisions and failure breadcrumbs | Desktop application/process observability |
| Existing `logForDebugging` / `logError` machinery | New privacy-safe desktop operational sink |
| Mostly `src/` changes | Primarily `app/`, with optional focused `src/` hardening |
| Per-session engine debug artifact | Per-launch, multi-process desktop artifact |
| No cross-layer event acknowledgements | Per-event delivery trace with renderer receive/apply/commit evidence |
| No desktop support/export workflow | Includes retrieval and diagnostics-bundle design |

The implementation session should re-verify every June plan anchor against current source before using it. Those plans are dated and source has moved.

The session-observability reports under `docs/reports/2026-04-30-session-observability-*.md` concern durable parent/subagent transcript entries and agent-facing forensic recovery. Those transcript entries are also not a substitute for application operational logs.

## Target architecture

### Design goals

The desktop logging system should answer both operational and stuck-delivery questions quickly:

1. What was the last event produced?
2. Which layers received, queued, sent, projected, applied, and committed it?
3. Which layer was the first not to acknowledge it?
4. Was each process instance alive and responsive?
5. What state did each layer believe the session and turn were in?
6. Were events delayed, dropped, duplicated, replayed, or processed out of order?
7. Did the renderer receive, apply, and commit the final state?

It should do so without recording user content.

### Non-goals

- No remote telemetry or analytics re-enablement.
- No Sentry or new third-party logging dependency.
- No raw transcript, prompt, response, tool input, or tool output capture.
- No generic renderer `log(message)` IPC endpoint.
- No generic capture of renderer console output.
- No change to the raw `AppSessionEvent` payload or its fidelity. A bounded desktop-only trace envelope or correlated side channel is allowed and required; it must never rewrite, prune, or inspect event content.
- No verbose per-function tracing. Compact metadata-only stage records for every session-scoped frame are required.
- No high-frequency heartbeat spam. A low-frequency bounded renderer health probe with persisted missed/recovered episodes and coarse healthy samples is required.
- No settings surface in the first implementation tranche.

### Recommended modules

The following is a recommended file decomposition, not a locked naming decision:

| File | Responsibility |
|---|---|
| `app/shared/operationalLog.ts` | Runtime-neutral record types, levels, event allowlist, field bounds, redaction helpers, JSON-safe normalization |
| `app/main/operationalLogSink.ts` | Private directory/file creation, JSONL append, rotation, retention, launch metadata enrichment, fatal synchronous flush |
| `app/main/operationalLogSink.test.ts` | Permissions, rotation, retention, write failures, malformed record rejection |
| `app/shared/deliveryTrace.ts` | Trace identity/stage schema, process and connection epochs, watermarks, bounds, and privacy allowlists |
| `app/main/deliveryTraceSink.ts` | Compact trace persistence, per-layer watermark index, loss accounting, and export snapshot |
| `app/sidecar/operationalLog.ts` | Sidecar event builders and sanitized write to a dedicated supervisor-owned stream |
| `app/sidecar/operationalLog.test.ts` | Sidecar bounds, redaction, and event contract |
| `app/renderer/src/deliveryTrace.ts` | Renderer receive/apply/commit acknowledgements and bounded health responses |
| `app/renderer/src/RendererErrorBoundary.tsx` | User-facing graceful renderer fallback; optional bounded error report through a fixed preload method in a later security-reviewed tranche |

Operational logging is not an app-session frame kind. Delivery tracing may add optional desktop trace metadata to the existing `ServerFrame` delivery envelope or use a parallel correlated side channel, but it must not modify the embedded `AppSessionEvent`. The implementation session must choose one design explicitly, update the transport decision evidence, and prove unchanged event fidelity.

### Main-owned sink

Electron main should own the durable file sink because it:

- already owns application launch and shutdown;
- owns the registry and supervisor composition;
- can enrich records with application version and packaged/dev mode;
- is the one process that can correlate all sidecars;
- can expose fixed, pathless user actions such as “Open logs folder.”

Main should also own the durable delivery-trace files and last-known per-layer watermark index. Renderer acknowledgements are persisted in main as they arrive, so evidence received before a renderer crash survives that crash.

Host and supervisor should remain Electron-free. They should receive a typed logger through dependency injection, just as they receive the current string callback.

### Sidecar operational stream

Do not pipe raw sidecar stderr into the durable log.

Preferred design:

1. Spawn the sidecar with one additional pipe/file descriptor dedicated to operational records.
2. Pass only sanitized, schema-validated JSONL records through that descriptor.
3. Keep stdout/stderr inherited for development and emergency diagnostics.
4. Bound each record and the read buffer in the supervisor.
5. Reject malformed records and emit one rate-limited supervisor warning without copying the malformed payload.
6. Enrich accepted records in main with launch/app version metadata and persist them through the same sink.

This adds no socket frame and does not reopen the locked transport decision.

An extra stdio file descriptor is preferable to stdout because engine/library code may use stdout in ways the desktop sidecar does not fully own. It is preferable to stderr because stderr contains unredacted legacy diagnostics.

### Renderer errors

Main can observe renderer-process failures without any new renderer capability by subscribing to Electron events.

A React component error is different: main cannot know the component stack unless renderer reports it. If a later tranche adds this:

- add one fixed preload method such as `reportRendererFailure(record)`;
- accept a closed, bounded schema with no arbitrary metadata object;
- strip paths and bound stack/message length at preload and main;
- rate-limit the channel;
- add renderer IPC guard and hardening coverage;
- never accept a renderer-authored destination/path or log level.

Because this is a new renderer-to-main channel, it is a security-boundary change and owes the full desktop hardening battery.

## Record contract

Use JSONL with a versioned record schema. A recommended shape:

```ts
type OperationalLogRecord = {
  schemaVersion: 1
  wallTimestamp: string
  monotonicTimestampMs: number
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  event: OperationalEventName
  component:
    | 'engine'
    | 'main'
    | 'host'
    | 'registry'
    | 'supervisor'
    | 'sidecar'
    | 'worker'
    | 'ipc-bridge'
    | 'preload'
    | 'renderer'
  processRole: 'electron-main' | 'bun-sidecar' | 'worker' | 'renderer'
  pid: number
  processInstanceId: string
  processStartedAt: string
  launchId: string
  appVersion?: string
  buildId?: string
  commitId?: string
  packaged?: boolean
  appSessionId?: string
  engineSessionId?: string
  requestId?: string
  turnId?: string
  workerId?: string
  durationMs?: number
  outcome?: 'success' | 'failure' | 'cancelled' | 'timeout' | 'degraded'
  error?: {
    name?: string
    code?: string
    message?: string
    retryable?: boolean
  }
  fields?: OperationalEventFields
}
```

Important constraints:

- `event` is a closed union, not arbitrary text.
- `fields` is a discriminated union keyed by `event`, not `Record<string, unknown>`.
- Every string has a maximum length.
- IDs are validated and bounded.
- Error messages are sanitized before the record reaches the sink.
- Stack traces are debug-only and redacted; they are not part of the always-on contract.
- Unknown keys are rejected or dropped before persistence.
- Serialization failure must never crash the application.

### Correlation model

Generate one `launchId` when Electron main starts. Every record receives it.

Reuse existing identities rather than inventing replacements:

- `appSessionId`: desktop/host address.
- `engineSessionId`: transcript/engine identity.
- `requestId`: existing request-correlated verbs and errors.
- `turnId`: a generated identifier scoped to one accepted submit/turn when no existing engine identifier is suitable.
- `workerId`: opaque local worker identity, bounded and safe.

The first record that knows both app and engine session IDs should emit a join event. Later records should carry both when available.

Never use filesystem paths as correlation identities.

## Event-delivery trace contract

### Separate operational and delivery streams

The operational log records low-volume lifecycle, failures, thresholds, and recovery. The delivery trace records compact metadata for every session-scoped `ServerFrame` at each meaningful boundary. They may share the main-owned writer and export bundle, but they require separate schemas, files, byte budgets, and loss policies.

Operational records may be deduplicated. Delivery records must not be deduplicated or sampled: a duplicate sequence, missing sequence, or missing stage is the diagnostic signal. If the trace writer must shed load to protect application correctness, it must persist a `trace.loss` record with the affected sequence range and mark the export incomplete.

### Trace identity, process identity, and time

A recommended delivery record is:

```ts
type DeliveryTraceRecord = {
  schemaVersion: 1
  recordKind: 'delivery_trace'
  wallTimestamp: string
  monotonicTimestampMs: number

  launchId: string
  component:
    | 'engine'
    | 'sidecar'
    | 'supervisor'
    | 'host'
    | 'attachment-gate'
    | 'ipc-bridge'
    | 'preload'
    | 'renderer'
  processName: 'bun-sidecar' | 'electron-main' | 'electron-renderer'
  pid: number
  processInstanceId: string
  processStartedAt: string

  appSessionId: string
  engineSessionId?: string
  streamEpoch: string
  connectionEpoch: number
  rendererDocumentId?: string
  subscriptionEpoch?: number

  eventSequence: number
  eventTraceId: string
  deliveryAttempt: number
  eventType: DeliveryEventType
  lifecycleState?: DeliveryLifecycleState
  replay: boolean

  stage: DeliveryStage
  batchId?: string
  batchIndex?: number
  batchSize?: number

  previousTurnState?: DeliveryTurnState
  nextTurnState?: DeliveryTurnState
  queueDepth?: number
  queuedBytes?: number
  droppedSinceLast?: number
  duplicate?: boolean
  outOfOrder?: boolean
}
```

Rules:

1. Mint `processInstanceId` once at every process start. A restarted sidecar or renderer process gets a new value even if its PID is reused. A document reload always gets a new `rendererDocumentId`, even when Chromium reuses the same renderer process.
2. Record both wall-clock and monotonic time at every stage. Monotonic values are comparable only within one process instance; never subtract monotonic clocks from different processes.
3. Assign `eventSequence` at the earliest engine-to-sidecar emission boundary and preserve it through every later layer. Do not recompute it from arrival order.
4. Make the tuple `(engineSessionId, streamEpoch, eventSequence)` unique. Increment/change `streamEpoch` when the producing stream is recreated.
5. Replaying a frame preserves its original `eventSequence` and `eventTraceId` but increments `deliveryAttempt` and carries the new connection/document/subscription epoch.
6. Batched IPC preserves per-frame trace identities. `batchId`, `batchIndex`, and `batchSize` describe the optimization; they never replace individual event identity.
7. `eventType`, lifecycle state, and turn states are closed safe enums. They never contain message text, tool data, file paths, or arbitrary state.
8. Every `AppSessionEvent` trace after the ready identity join carries both `appSessionId` and `engineSessionId`. Pre-ready lifecycle records may omit the not-yet-known engine identity and must emit an explicit identity-join record once known.

The trace identity should travel beside the frame, not inside `AppSessionEvent`. The preferred design is additive optional metadata on the desktop `ServerFrame` delivery envelope. A parallel correlated side channel is acceptable only if tests prove it cannot race and associate an identity with the wrong frame.

### Required stage vocabulary

Use a closed stage union. At minimum, trace:

```text
engine.produced
sidecar.received
sidecar.socket.queued
sidecar.socket.sent
supervisor.socket.received
host.received
attachment.buffered
attachment.replayed
main.ipc.queued
main.ipc.sent
preload.received
renderer.subscription.received
renderer.state.queued
renderer.state.applied
renderer.ui.committed
```

Not every event will visit both `attachment.buffered` and `attachment.replayed`; live frames skip those replay stages. A stage record means that stage actually happened, not that code attempted to schedule it.

The engine and sidecar share a Bun process today, but they remain distinct logical stages. They use the same `processInstanceId`, `processName`, and PID while retaining different component values.

### Renderer acknowledgements

`webContents.send()` is not an acknowledgement. Add one fixed renderer-to-main/preload method for delivery acknowledgements with a closed schema. It may carry bounded sequence ranges for an IPC batch, but no arbitrary message, fields object, path, log level, event content, or destination.

Required acknowledgement points:

- **Received:** preload accepted the main IPC batch and the renderer subscription callback was entered.
- **Queued:** `applyServerFrameBatch()` issued the applicable store dispatches.
- **Applied:** every projector/store applicable to that event type confirmed its trace watermark advanced. Returning from a dispatch call alone is not sufficient evidence.
- **Committed:** for important lifecycle events, especially ready, disconnect/crash, turn terminal states, permission terminal states, and restore completion/failure, React committed the derived UI state.

Commit acknowledgement should be driven by a root-level post-commit hook tied to the trace identity that caused the terminal state. Do not acknowledge commit merely because dispatch returned. Streaming token/message events need received/applied proof but do not each require a React commit acknowledgement.

The renderer should send acknowledgements in bounded batches/ranges to avoid one IPC call per frame. Main expands or indexes those ranges logically so the exported timeline can answer acknowledgement status for each sequence. Invalid, oversized, out-of-epoch, or renderer-authored unknown sequence acknowledgements are rejected and logged without echoing their payload.

Because this is a new renderer-to-main capability, it owes fixed-channel preload guards, main-side validation, size/rate bounds, source-guard tests, and the full desktop hardening battery.

### Layer watermarks and state beliefs

Maintain per-session, per-stream-epoch watermarks:

```text
lastProducedSequence
lastSocketSentSequence
lastHostReceivedSequence
lastIpcSentSequence
lastRendererReceivedSequence
lastRendererAppliedSequence
lastRendererCommittedSequence
nextExpectedSequence
```

Each layer also maintains only a bounded categorical state summary: process alive/responsive, connection state, attachment state, replay state, subscription epoch, and previous/current turn state. Persist summaries on change, anomaly, missed health probe, crash, and export. Never dump reducer state or component props.

Watermark updates detect and record:

- gaps;
- duplicates;
- out-of-order arrival;
- acknowledgement of an unknown sequence;
- delivery after a stale process/document/subscription epoch;
- replay of an already-applied event;
- divergence between the layer's expected and actual turn state.

### Connection, replay, subscription, and listener events

Add the following metadata-only lifecycle events:

| Event | Required fields |
|---|---|
| `connection.attached` | app/engine session IDs, process instance, connection epoch |
| `connection.detached` | connection epoch, reason, last sent/received watermarks |
| `connection.reconnect.started` | prior epoch, reason |
| `connection.reconnect.completed` | new epoch, duration, replay start watermark |
| `replay.started` | delivery attempt, sequence range, reason |
| `replay.completed` | sequence range, duration, applied watermark |
| `replay.gap` | missing/evicted sequence range and truncation reason |
| `subscription.registered` | renderer document ID, subscription epoch, listener count |
| `subscription.removed` | renderer document ID, subscription epoch, reason |
| `ipc.listener.registered` | allowlisted channel key, process instance, count |
| `ipc.listener.removed` | allowlisted channel key, process instance, count |

Never log JavaScript callback identity, source text, arbitrary channel strings, or listener arguments. Channel names must come from a fixed allowlist.

### Renderer liveness

Use a main-owned low-frequency health probe, suggested every five seconds, with a fixed renderer response containing:

- renderer `processInstanceId` and document/subscription epoch;
- latest received/applied/committed watermarks;
- categorical turn and connection state;
- measured event-loop lag;
- monotonic response time.

Persist one coarse healthy sample, suggested every 30 seconds, plus every missed, timed-out, degraded, and recovered episode. Missing three consecutive responses should produce `renderer.health.missed`; recovery produces `renderer.health.recovered` with outage duration. Electron `unresponsive`/`responsive` events remain independent evidence.

The health probe must not include DOM, component, transcript, prompt, store, memory, or environment snapshots.

### Stuck-session export answer contract

The bundle generator should compute a short derived summary per session:

1. Last produced sequence and event type.
2. Last acknowledged sequence at every layer.
3. First missing stage for each incomplete event.
4. Last process-health evidence and process instance/exit information.
5. Last categorical state reported by every layer.
6. Gap, duplicate, replay, reordering, trace-loss, and latency anomalies.
7. Whether the final lifecycle/turn event reached renderer receive, state apply, and UI commit.

These answers are derived from trace metadata and watermarks. They must not require reading transcript or event payload content.

## Event catalog

The catalog below is intentionally selective. It records transitions and failures, not every function call.

### Application and startup

| Event | Level | Required fields | Notes |
|---|---|---|---|
| `app.start` | info | version, packaged, platform, arch | No username, home path, cwd, or environment values |
| `app.single_instance.refused` | info | none | Second instance exited normally |
| `app.ready` | info | durationMs | `app.whenReady()` completed |
| `app.shutdown.started` | info | reason | `window-all-closed`, `before-quit`, signal, fatal |
| `app.shutdown.completed` | info | durationMs, outcome | Flush before exit |
| `app.fatal` | fatal | sanitized error | Synchronous emergency write |
| `process.started` | info | process role, PID, processInstanceId, start time | Emit for main, sidecar, worker, preload/renderer |
| `process.exited` | info/error | process role, processInstanceId, code, signal, expected | Preserve restart/termination cause |

### Window and renderer

| Event | Level | Required fields | Notes |
|---|---|---|---|
| `window.created` | info | window ordinal | No native handle |
| `renderer.load.started` | info | source kind | `dev-url` or `packaged-file`, never the full URL/path |
| `renderer.load.ready` | info | durationMs | `ready-to-show` plus renderer-ready latch should be distinct if useful |
| `renderer.load.failed` | error | error code, sanitized description | From promise rejection / `did-fail-load` |
| `renderer.navigation.started` | info | document ID, navigation kind | No URL; distinguishes initial load/reload/navigation |
| `renderer.navigation.completed` | info | document ID, durationMs, outcome | New document means new subscription epoch |
| `renderer.reload` | warn/info | prior/new document IDs, reason | User/dev/crash recovery category only |
| `renderer.process.gone` | error | reason, exitCode | Electron-provided reason only |
| `renderer.unresponsive` | warn | elapsedMs | Log once per episode |
| `renderer.responsive` | info | durationMs | Recovery evidence |
| `renderer.javascript.error` | error | sanitized error, document ID | Global JavaScript error handler |
| `renderer.promise.unhandled` | error | sanitized reason category, document ID | Never serialize rejected value raw |
| `renderer.component.failed` | error | boundary name, sanitized error | Later fixed-IPC tranche only |
| `renderer.health.sample` | debug/info | event-loop lag, watermarks | Coarse bounded cadence only |
| `renderer.health.missed` | warn | missed count, last watermarks | Main-owned watchdog evidence |
| `renderer.health.recovered` | info | outage duration, watermarks | |

### Registry and cache

| Event | Level | Required fields | Notes |
|---|---|---|---|
| `registry.load.started` | debug | none | Optional debug event |
| `registry.load.completed` | info | rowCount, durationMs | Counts only |
| `registry.load.recovered` | warn | recovery kind | Do not persist the registry path |
| `registry.write.failed` | error | operation, sanitized error | Replaces string-only failures |
| `registry.orphan.swept` | warn | pid, appSessionId | Existing useful event, now structured |
| `registry.rows.reaped` | info | count, reason | Counts only |
| `transcript_cache.write.failed` | error | appSessionId, bytes, error | No cache content |
| `transcript_cache.read.rejected` | warn | reason, bytes | No filename/path |
| `transcript_cache.gc.completed` | info | removedCount, errorCount, durationMs | Aggregate, not one line per healthy file |

### Session and sidecar lifecycle

| Event | Level | Required fields | Notes |
|---|---|---|---|
| `session.create.requested` | info | appSessionId | Cwd excluded; optional non-reversible workspace hash if proven necessary |
| `sidecar.spawn.started` | info | appSessionId | Include child PID after spawn |
| `sidecar.spawn.failed` | error | appSessionId, sanitized error | Existing failure, structured |
| `sidecar.socket.waiting` | debug | appSessionId | Do not log socket path |
| `sidecar.socket.connected` | info | appSessionId, pid, durationMs | |
| `sidecar.ready` | info | both session IDs, pid, durationMs | Identity join point |
| `sidecar.disconnected` | warn | appSessionId, reason | Distinguish living-child disconnect from exit |
| `sidecar.exit` | info/error | code, signal, expected | Severity based on expected park/close vs crash |
| `sidecar.restart.requested` | info | appSessionId, reason | |
| `sidecar.restart.completed` | info | appSessionId, durationMs | New PID, same identity contract |
| `sidecar.park.requested` | info | appSessionId, reason | TTL/cap only, no workspace |
| `sidecar.park.refused` | debug | reason category | Aggregate if repeated |
| `sidecar.idle_exit` | info | appSessionId, idleMs | Existing useful event |
| `session.restore.started` | info | both IDs | |
| `session.restore.completed` | info | messageCount, durationMs | Count only |
| `session.restore.failed` | error | failure code, sanitized error | Preserve the dedicated resume-failed class |

### Turn and provider lifecycle

| Event | Level | Required fields | Notes |
|---|---|---|---|
| `turn.accepted` | info | appSessionId, turnId, promptBytes | Byte count only |
| `turn.queued` | info | turnId, queueDepth | Only when mid-turn queuing occurs |
| `turn.started` | info | turnId, provider, model family | Do not log prompt |
| `turn.first_output` | info | turnId, durationMs | Time-to-first-output |
| `turn.completed` | info | turnId, durationMs, token counts | Aggregate usage only |
| `turn.aborted` | info | turnId, reason category | User abort is normal, not error |
| `turn.failed` | error | turnId, classified error, retryable | Sanitized error only |
| `turn.state.changed` | info | turnId, previous state, next state, triggering sequence | Closed state enums only |
| `provider.route.selected` | info | turnId, provider, model, source | No account alias/email/token |
| `provider.fallback` | warn | from, to, reason category | Only actual fallback |
| `provider.retry` | warn/debug | attempt, classification, delayMs | Aggregate repetitive attempts |
| `provider.exhausted` | error | classification, attempts | Quota/auth/network categories |

The engine already has structured account diagnostics and the June logging review proposes targeted always-log breadcrumbs. Reuse or bridge the real engine decision owner rather than re-deriving provider routing in `app/`.

### Permissions and tools

| Event | Level | Required fields | Notes |
|---|---|---|---|
| `permission.requested` | info | requestId, tool family | Tool family or built-in tool name only |
| `permission.resolved` | info | requestId, decision, waitMs | No updated input, feedback, or permission rules |
| `permission.expired` | warn | requestId, reason | |
| `tool.started` | debug | turnId, tool family | Always-on only if volume proves acceptable |
| `tool.completed` | debug | durationMs, outcome, outputBytes | No input/output content |
| `tool.failed` | warn/error | durationMs, classified error | Error class/code only |

Third-party MCP tool names can disclose installed services. Keep them out of default support bundles or replace them with a stable local hash plus `source: 'mcp'`.

### Workers and background jobs

| Event | Level | Required fields | Notes |
|---|---|---|---|
| `worker.started` | info/debug | worker kind, pid | Catalog/accounts/backfill/task worker |
| `worker.completed` | info | worker kind, durationMs, result counts | |
| `worker.failed` | error | worker kind, classification | Bounded stderr summary only after sanitization |
| `worker.timeout` | error | worker kind, timeoutMs | |
| `worker.stale_result.retained` | warn | worker kind, snapshot age | Explains degraded-but-working UI |
| `subagent.started` | info | opaque workerId, agent type | No task description/prompt |
| `subagent.completed` | info | durationMs, outcome | No result content |
| `subagent.failed` | error | classified error | Complements durable transcript terminal entries |

### Transport, limits, and security

| Event | Level | Required fields | Notes |
|---|---|---|---|
| `transport.frame.rejected` | warn | reason category, direction | Never include payload |
| `transport.frame.oversized` | warn | bytes, limit, direction | |
| `transport.frame.decode_failed` | error | reason category | No raw frame |
| `transport.backpressure` | warn | queuedBytes, durationMs | Threshold-crossing only |
| `transport.frame.dropped` | warn | kind, reason category | Kind must be allowlisted |
| `trace.sequence.gap` | error | stream epoch, missing range, first observed sequence | No payload |
| `trace.sequence.duplicate` | warn | stream epoch, sequence, stage | Never deduplicate this trace record |
| `trace.sequence.out_of_order` | warn | expected/observed sequence, stage | |
| `trace.ack.missing` | warn/error | sequence/range, expected stage, elapsedMs | Severity based on lifecycle importance |
| `trace.ack.invalid` | warn | reason category, process/document epoch | Do not echo renderer payload |
| `trace.loss` | error | stage, sequence range, dropped count, reason | Marks the diagnostic timeline incomplete |
| `security.outbound_secret_blocked` | error | key category, path category | Existing key/path detail should be further bounded for support export |
| `security.rate_limit` | warn | channel, suppressedCount | Aggregate to prevent log flooding |

### Performance thresholds

Outside the fixed coarse renderer health sample, do not log a periodic metric stream. Emit other performance records only when a threshold is crossed and when it recovers:

- slow application ready;
- slow renderer ready;
- slow sidecar ready;
- slow session switch/restore;
- slow first output;
- event-loop stall;
- high process RSS/footprint;
- large transcript/replay/cache;
- sustained queue/backpressure;
- excessive per-hop event-delivery or acknowledgement latency;
- repeated restart/crash loop.

Threshold values should be constants with tests. A threshold event should include the measured value and threshold, not a dump of surrounding state.

## Privacy and redaction contract

### Never persist in the operational log

- User prompts or model responses.
- Transcript messages or renderer raw-message state.
- Tool inputs or outputs.
- Bash commands or command output.
- File contents, diffs, patches, or attachment contents.
- OAuth callback URLs/codes.
- Tokens, cookies, API keys, authorization headers, or vault records.
- Account emails or aliases.
- Raw permission rules or permission-request input.
- Environment-variable values.
- Full filesystem paths, usernames, workspace names, or repository remotes.
- Raw worker stderr/stdout.
- Arbitrary renderer-authored metadata.
- Any event payload, event message, renderer store snapshot, DOM snapshot, or React props captured under the guise of delivery tracing.

### Safe by default

- App version, runtime version, platform, architecture.
- Packaged/dev mode.
- PID, exit code, signal, and Electron reason enums.
- Existing opaque session/request IDs.
- Process instance IDs, stream/connection/document/subscription epochs, and event sequences.
- Counts, byte sizes, durations, queue depths, and booleans.
- Provider name and model identifier.
- Error name and stable classification/code.
- Built-in component/event names.

### Conditional or transformed

- Absolute paths: remove or replace with a category/basename only when required.
- URLs: retain origin/host only if necessary; remove userinfo, path, query, and fragment.
- Third-party plugin/MCP/tool names: hash or exclude from support export.
- Error messages: pass through centralized sanitization and length bounds.
- Stack traces: local debug-only, path-redacted, excluded from default support bundles.

### Redaction implementation rules

1. Prefer event-specific field allowlists over regex redaction.
2. Run a secondary secret/path/URL sanitizer on every string.
3. Reuse `scanForSecrets` only as defense in depth. It scans key names, not arbitrary secret values (`app/shared/secretGuard.ts` and the warning in `docs/migration/STATUS.md` P4-31).
4. Never persist raw `String(error)` before sanitization.
5. Bound every string before and after redaction.
6. Redact again when constructing a support bundle; do not assume the source log is sufficient for sharing.
7. On redaction failure, write a fixed placeholder and event code, not the original value.
8. Delivery trace fields use closed enums and numeric/opaque identifiers only; the trace layer must never call `JSON.stringify()` on `ServerFrame`, `AppSessionEvent`, reducer state, or an acknowledgement payload for persistence.

## Storage and retention contract

Recommended default location:

```text
<config-home>/desktop/logs/
```

Recommended file model:

```text
operational-<UTC timestamp>-<launchId>.jsonl
delivery-<UTC timestamp>-<launchId>.jsonl
latest-operational -> current operational file
latest-delivery -> current delivery-trace file
```

Required controls:

- directory mode `0700`;
- file mode `0600` on creation;
- correct existing mode with `chmod` because `mode` on open does not repair an existing permissive file;
- append-only JSONL;
- operational maximum record size, suggested 16 KiB;
- operational maximum file size, suggested 10 MiB;
- operational total cap, suggested 50 MiB;
- operational age retention, suggested 14 days;
- operational maximum file count as an additional guard, suggested 10 files;
- delivery-trace maximum record size, suggested 2 KiB;
- delivery-trace maximum file size, suggested 20 MiB;
- delivery-trace total cap, suggested 100 MiB;
- delivery-trace age retention, suggested 72 hours;
- delivery-trace maximum file count, suggested 6 files;
- cleanup on app launch after the first paint and at most once per day during a long-running app;
- cleanup failure logged once but never fatal;
- never tie operational-log retention to `cleanupPeriodDays`, which is transcript retention and can be `0`.

The exact values can be adjusted after measuring real volume, but the first implementation must ship with per-record, per-file, total-byte, age, and file-count bounds for both streams. The bundle manifest records the active limits so support can tell whether relevant history may have rotated.

The existing engine debug directory should be hardened separately:

- ensure debug directory/file permissions are private in `src/utils/debug.ts`;
- preserve the existing `latest` behavior;
- decide how desktop triggers the existing cleanup without importing the full engine graph into Electron main;
- add a total-size cap in addition to the current 30-day cutoff;
- do not silently delete logs outside the configured retention contract.

Avoid duplicating the engine cleanup machinery in `app/`. Either extract a small runtime-neutral retention helper or run one lightweight observation/cleanup worker. Verify the dependency graph before choosing.

## Crash handling

### Electron main

Add bounded handlers for:

- `process.on('uncaughtException')`;
- `process.on('unhandledRejection')`;
- `app.on('child-process-gone')` where supported;
- `webContents.on('render-process-gone')`;
- `webContents.on('did-fail-load')`;
- `BrowserWindow` `unresponsive` / `responsive`;
- rejected `loadURL()` / `loadFile()` promises.

Fatal-path rules:

- use a synchronous, minimal emergency append;
- avoid allocation-heavy serialization;
- include only already-sanitized bounded fields;
- prevent recursive fatal logging;
- flush/close the normal writer best-effort;
- preserve the expected Electron exit behavior rather than continuing after an unknown fatal state.

### Sidecar

The sidecar should record a sanitized fatal event on its dedicated operational descriptor and exit nonzero after an uncaught exception. The supervisor already converts child exit into session state; the log should preserve the cause and correlate it with that exit.

Unhandled rejection policy needs an explicit decision: fatal unless the rejection is known and handled by a narrower owner. Continuing silently is not acceptable.

### Renderer

Add a root error boundary that:

- presents a safe recovery/reload UI;
- never renders a stack trace;
- can report a bounded component-error record through a fixed IPC method if the security-reviewed tranche is implemented;
- rate-limits repeated render loops;
- does not replace the existing narrow Markdown fallback.

## Crash breadcrumbs

Maintain a bounded in-memory operational ring, suggested 100-200 records, of sanitized state transitions. Maintain a separate compact delivery ring, suggested 10,000 records or 8 MiB, whichever binds first. On a fatal event, flush both rings before the fatal record when possible.

Breadcrumbs should contain the same operational records already being written, not a second verbose state snapshot. They are valuable when filesystem writes were temporarily failing or when the fatal event follows a short rapid sequence.

The delivery ring contains trace metadata only. It preserves recent stage/watermark evidence if the asynchronous trace writer is temporarily unavailable and can be included in a crash export with an explicit source marker.

Do not include renderer state, transcript rows, or arbitrary object snapshots in this ring.

## Rate limiting and deduplication

The logger must defend itself against failure loops.

Recommended policy:

- write the first occurrence of a repeated event immediately;
- suppress identical event signatures for a bounded window;
- emit one aggregate record with `suppressedCount` when the window closes;
- keep fatal/error events subject to a higher cap but not unlimited;
- rate-limit renderer-originated reports independently;
- never let log traffic contend with the socket frame path or turn execution.

Event signature should use event name plus safe categorical fields, never raw error text.

This deduplication policy applies only to operational events. Delivery-stage records are never deduplicated or sampled. Renderer acknowledgement transport may coalesce contiguous sequence ranges, but the stored/indexed semantics must retain exactly which stages acknowledged every sequence. Load shedding emits `trace.loss` and advances an explicit lost-range watermark; it must never silently create a gap.

## Diagnostics retrieval and support bundle

### Open logs folder

Add a fixed main-owned action with no renderer-authored path. Main knows the log directory and opens it. This requires a fixed preload method and hardening coverage but does not require a socket frame or host API method.

### Copy/export diagnostics

A later tranche should create one bounded, redacted diagnostics bundle containing:

- manifest with app version, build/commit identity, runtime versions, operating-system version, platform, architecture, packaged/dev mode, schema versions, creation time, and active log/trace limits;
- the most recent desktop operational log files under the size/age budget;
- the most recent delivery-trace files under their separate size/age budget;
- process-instance table with start/exit metadata and last health evidence;
- per-session, per-layer watermarks and the derived stuck-session answer summary;
- an allowlisted relevant-configuration summary containing only delivery/replay limits, tracing mode, safe feature booleans/enums, provider/model identifiers, and configuration schema/version identities;
- a redaction summary and omitted-artifact list;
- optional registry/session counts, never registry titles/cwds;
- checksums for included files.

Excluded by default:

- transcripts and transcript caches;
- raw renderer message logs;
- `desktop/debug/state.json`;
- raw engine debug logs;
- account/vault files;
- settings files;
- environment dumps.

Never include raw configuration objects. The relevant-configuration summary is constructed field by field from a closed allowlist and excludes paths, account identity, credentials, permission rules, prompts, tool configuration, plugin configuration, and arbitrary feature values.

If a user explicitly opts to include an engine debug excerpt, the app must show that it can contain paths, account metadata, permission rules, plugins, and repository information, then apply a second redaction pass.

Do not upload anything automatically. This report proposes local collection only.

## Implementation phases

### Phase 1: Logging foundation and main/host/supervisor conversion

**Goal:** Ship a private, bounded, structured desktop log before adding more events.

Work:

1. Add the shared event/field schema and sanitizer.
2. Add the main file sink with `0700`/`0600`, rotation, retention, and failure-safe writes.
3. Generate `launchId` and enrich records in main.
4. Convert current main, host, registry, supervisor, background-worker, and idle-park string logs to event builders.
5. Record startup, renderer load, registry, session spawn/connect/ready/exit, and shutdown events.
6. Keep current stderr output in development through a tee/console sink if useful, but persist only the structured record.

Expected files:

- new `app/shared/operationalLog.ts` plus test;
- new `app/main/operationalLogSink.ts` plus test;
- `app/main/main.ts`;
- `app/main/*Runner.ts`, `idleParkDriver.ts`, and cache/backfill owners where logging is injected;
- `app/host/host.ts`;
- `app/host/registry.ts`;
- `app/supervisor/supervisor.ts`;
- existing tests that inject logger callbacks.

No renderer/preload/protocol change is needed in this phase.

### Phase 2: Sanitized sidecar stream and fatal coverage

**Goal:** Correlate sidecar failures without persisting raw stderr.

Work:

1. Add a dedicated operational descriptor/pipe at sidecar spawn.
2. Add bounded decoding in supervisor.
3. Route `SidecarServer` and direct sidecar domain diagnostics through the typed sidecar logger.
4. Keep legacy engine stderr/debug separate.
5. Add sidecar uncaught/unhandled fatal policy.
6. Record sidecar startup milestones, ready identity join, restore, turn lifecycle, transport rejections, and exit cause.

No trace metadata or renderer acknowledgement channel is added in this phase; that boundary change belongs to Phase 3.

### Phase 3: End-to-end event delivery trace

**Goal:** Prove exactly how far every session-scoped frame progressed and preserve the proof across renderer crashes.

Work:

1. Add the delivery-trace schema, process instance identity, wall/monotonic timestamps, stream/connection/document/subscription epochs, sequence identity, and stage allowlist.
2. Assign one sequence at the engine-to-sidecar emission boundary and carry desktop trace metadata beside the unchanged event/frame payload through sidecar socket, supervisor, host, attachment gate, replay buffer, main IPC batch, preload, and renderer.
3. Instrument the current owners: `app/shared/protocol.ts`, `app/main/attachmentGate.ts`, `app/main/replayBuffer.ts`, `app/main/main.ts`, `app/preload/preload.ts`, `app/renderer/src/App.tsx`, and `app/renderer/src/serverFrameBatch.ts`.
4. Add one fixed, bounded renderer acknowledgement method for received/applied/committed sequence ranges.
5. Add UI-commit acknowledgement for important lifecycle/turn terminal events only.
6. Persist attach/detach/reconnect/replay/subscription/listener events and per-layer watermarks.
7. Detect gaps, duplicates, reordering, stale-epoch delivery, unknown acknowledgements, and trace loss.
8. Add the bounded renderer health probe and missed/recovered evidence.
9. Add the separate private rotating delivery-trace file and compact in-memory ring.
10. Add derived stuck-session summary generation from trace metadata alone.

This phase changes the renderer/preload boundary and the desktop delivery envelope. It must preserve raw `AppSessionEvent` byte/field fidelity, use no generic logging IPC, and pass the full desktop typecheck, renderer build, hardening, source-guard, replay, batching, and isolation suites. If sequence assignment requires a change under `src/`, it also owes the engine battery.

### Phase 4: Renderer/process crash observability

**Goal:** Preserve renderer load/crash/unresponsive evidence and degrade gracefully.

Work:

1. Add Electron load/process/unresponsive handlers.
2. Observe load promise rejection.
3. Add a root React error boundary.
4. If component error reporting is implemented, add one fixed bounded preload channel with sidecar-independent validation and rate limiting.
5. Re-run hardening and source-guard tests.

### Phase 5: Engine error integration and debug-log hardening

**Goal:** Close the gap between engine `logError()` and desktop operational evidence without copying sensitive debug content.

Work:

1. Choose a desktop-specific `ErrorLogSink` or harden the normal sink before attachment.
2. Emit error name/code/classification and a sanitized message only.
3. Harden engine debug directory/file permissions.
4. Make debug cleanup reachable from desktop without importing the whole engine graph into Electron main.
5. Add a total-size cap.
6. Re-evaluate the dated June logging-review recommendations against current source.

This phase touches both `src/` and `app/` and therefore owes both verification batteries.

### Phase 6: Diagnostics UI and export

**Goal:** Let a user retrieve useful evidence safely.

Work:

1. Add “Open logs folder.”
2. Add local “Save diagnostics bundle.”
3. Add manifest, operational logs, delivery traces, process table, watermarks, derived stuck-session summary, and second-pass redaction.
4. Document excluded artifacts.
5. Add boundary/hardening tests for the fixed preload actions.
6. Run operator GUI acceptance for the new settings/help surface.

### Phase 7: Performance and high-value domain events

**Goal:** Add threshold events and the narrow engine-domain breadcrumbs that real incidents justify.

Work:

1. Measure log volume first.
2. Add slow-start, slow-renderer, slow-sidecar, slow-first-output, memory, backpressure, and per-hop delivery/acknowledgement thresholds.
3. Implement current, still-valid items from the June logging review.
4. Avoid promoting high-volume debug traces to always-on events.

## Tests and acceptance criteria

### Shared schema and redaction

- Accept every declared event with its exact field schema.
- Reject unknown event names and keys.
- Bound every string and record.
- Strip absolute POSIX and Windows paths.
- Strip URL userinfo/query/fragment.
- Strip bearer/API-key/token-shaped strings.
- Reject secret-keyed nested objects.
- Prove redaction failure emits a placeholder, not the original text.
- Prove prompt, response, tool input/output, permission rules, and environment values have no representable field in the schema.

### File sink

- Creates directory as `0700` and file as `0600` under a temporary config home.
- Repairs an existing permissive file/directory mode.
- Writes one valid JSON object per line.
- Survives malformed record input without crashing the app.
- Rotates at the per-file cap.
- Enforces age, total-byte, and file-count caps.
- Preserves the current launch files and both `latest` targets.
- Handles full disk, permission denied, and missing directory without recursion.
- Performs a bounded synchronous fatal append.
- Deduplicates/rate-limits repeated events and reports suppression count.

### Correlation

- Every main record has one `launchId`.
- Host/supervisor records preserve the same `launchId`.
- Sidecar records join to the correct `appSessionId` under multiple concurrent sessions.
- Ready joins the correct `engineSessionId`.
- Restart changes PID/process instance while preserving session identity as designed.
- An old child's late exit cannot be attributed to its replacement.

### Delivery-trace identity and ordering

- Every session-scoped frame receives exactly one sequence at the production boundary.
- The same event trace ID and sequence survive socket transport, host projection, attachment buffering, replay, IPC batching, preload, renderer application, and selected UI commit.
- Replayed delivery preserves event identity while changing delivery attempt and connection/document/subscription epoch.
- A process restart always changes `processInstanceId`; PID reuse cannot merge timelines.
- Wall timestamps are valid ISO values and monotonic timestamps never decrease within one process instance.
- Batch index/size reconstruct the exact frame order inside each IPC batch.
- Injected missing, duplicate, reversed, stale-epoch, and unknown-ack sequences produce the correct anomaly records and watermarks.
- Trace records contain no serialized frame, event, reducer, component, DOM, or acknowledgement payload.
- Trace writer overload emits an explicit lost sequence range and never silently samples or deduplicates.

### Renderer acknowledgement and liveness

- Preload receive, renderer subscription receive, state applied, and important UI committed stages acknowledge the correct sequence.
- Returning from `applyServerFrameBatch()` proves only queued dispatch; a test prevents it from satisfying state-applied acknowledgement by itself.
- Dispatch return cannot satisfy the UI-commit stage; a test proves commit acknowledgement happens only after the relevant React commit.
- Streaming message events do not cause one commit acknowledgement per token/frame.
- Bounded acknowledgement batches/ranges reconstruct per-event stage coverage exactly.
- The fixed acknowledgement method rejects unknown keys, unknown sequences, stale document/subscription epochs, oversized ranges, and rate floods.
- Subscription registration/removal and renderer navigation/reload increment the correct epochs and are persisted once.
- The health watchdog records coarse healthy evidence, missed probes, event-loop lag threshold crossings, and recovery.
- A frozen renderer, disconnected renderer, crashed renderer, and healthy renderer with a stalled event stream produce distinguishable timelines.
- The last received/applied/committed watermarks remain exportable after renderer termination.

### Sidecar stream

- Uses a dedicated descriptor, not stdout/stderr/socket frames.
- Rejects oversized and malformed records without echoing payload.
- Handles pipe close without affecting session transport.
- Does not block turn execution under backpressure.
- Fatal sidecar error is logged before nonzero exit when possible.
- Raw stderr strings do not enter the operational file.

### Electron and renderer failures

- `did-fail-load` produces one sanitized record.
- rejected `loadURL`/`loadFile` produces one record without duplication.
- `render-process-gone` records reason/exit code.
- unresponsive/responsive records one episode and duration.
- root React boundary renders recovery UI.
- renderer error report channel rejects extra keys, oversize fields, and rate floods.
- no generic channel name or arbitrary path crosses preload.

### Event semantics

- User abort logs `info`, not `error`.
- Expected park/clean close logs normal outcome.
- Crash exit logs error with code/signal.
- Worker stale-result retention is a warning and names the retained behavior.
- Turn events contain byte/token counts but no content.
- Permission events contain decision and wait duration but no rule/input.
- Tool events contain family/outcome/duration but no input/output.

### Support bundle

- Includes only allowlisted files.
- Enforces a total bundle size and age window.
- Runs second-pass redaction.
- Includes build/commit identity, OS information, process instances, delivery traces, watermarks, trace-loss status, and the seven-question stuck-session summary.
- Includes only the closed relevant-configuration summary, never raw settings or environment objects.
- Excludes transcripts, caches, settings, vaults, raw engine logs, and debug state by default.
- Requires no user-authored path crossing except the native save dialog result owned by main.
- Does not upload or transmit the bundle.

## Verification matrix for implementation sessions

### App-only phases

Run from the repository root:

```bash
bun test app/
bun run --cwd app typecheck
bun run --cwd app typecheck:sidecar
bun run --cwd app test:hardening
bun run --cwd app renderer:build   # when renderer build inputs changed
```

`test:hardening` launches Electron. If the implementing session lacks authorization for that run, it must report the command as not run rather than claiming security acceptance.

### Engine-touching Phase 5 or Phase 7

Also run:

```bash
bun run build:dev:full
bun test <focused engine logging/error/cleanup test paths>
```

Do not run bare root `bun test` or root `bun run typecheck`.

### Docs and maps

For a report-only or other docs-only change, run both repository docs checks:

```bash
git diff --check
bun run maps:lint
```

If implementation changes ownership/routing, also update `docs/maps/analytics-diagnostics.md` and `docs/maps/web-app-runtime.md` in place before running the same checks.

### Security acceptance

Any new renderer/preload IPC method requires:

- closed schema at main/preload boundary;
- fixed method/channel only;
- size and rate bounds;
- no renderer-authored path;
- source-guard tests;
- hardening smoke all-pass.

### GUI acceptance

Only phases that add visible recovery or diagnostics UI need operator GUI verification. Follow `docs/migration/process/GUI-VERIFICATION.md`; do not infer visual acceptance from SSR or class-name tests.

## Definition of done

The desktop logging program is complete when:

1. A packaged launch writes a private, bounded operational log without a terminal.
2. Every session-scoped frame has one preserved stream epoch, sequence, and trace identity across engine/sidecar, supervisor/host, attachment/replay, IPC/preload, renderer apply, and selected UI commit stages.
3. Main, host, supervisor, sidecar, worker, preload, and renderer process instances correlate under one launch/session model with wall and monotonic timestamps.
4. A renderer crash, sidecar crash, restore failure, worker timeout, provider exhaustion, sequence gap, missing acknowledgement, and stale-epoch delivery each leave a useful record.
5. Renderer receive/apply acknowledgements exist for every delivered sequence, and important lifecycle/turn terminal events have a real post-commit acknowledgement.
6. Attach/detach/reconnect/replay/subscription/listener changes and layer watermarks survive renderer termination.
7. Renderer heartbeat/event-loop evidence distinguishes a frozen renderer from a disconnected or stalled event stream.
8. No operational or delivery record can contain prompts, model text, event payloads, tool input/output, credentials, raw permission rules, store/DOM snapshots, or full filesystem paths.
9. Files are `0600`, directory is `0700`, and both streams enforce record, file, directory-byte, age, and count bounds.
10. Raw stderr is never blindly persisted, and delivery trace loss is never silent.
11. A user can open the log folder and save one local redacted diagnostics bundle containing process metadata, correlated timelines, build/OS identity, safe configuration, watermarks, and derived stuck-session answers.
12. The bundle answers all seven stuck-session questions from trace metadata without reading event content.
13. Tests prove privacy, permissions, retention, sequence preservation, ordering anomaly detection, acknowledgements, commit timing, liveness, crash survival, and rate/loss handling.
14. All relevant Cat Code verification batteries pass with actual results reported.
15. The routing maps describe the final owner files and no dated plan is treated as current source truth.

## Recommended first implementation tranche

The safest, highest-value first tranche is Phase 1 only:

- add structured record schema and sanitizer;
- add the main private rotating sink;
- convert existing main/host/registry/supervisor logs;
- record startup, renderer load, registry load/write, sidecar spawn/connect/ready/exit, and shutdown;
- add the full privacy/permissions/retention/correlation test set;
- make no preload, renderer, protocol, or engine change yet.

This tranche immediately makes packaged-process failures retrievable while avoiding the two highest-risk expansions: persisting raw sidecar stderr and adding renderer-authored log input.

The second tranche should add the dedicated sanitized sidecar descriptor and fatal coverage. The third tranche must implement the end-to-end delivery trace and renderer acknowledgements before the logging program is considered sufficient for stuck-session debugging. Diagnostics export follows once both streams and their redaction contracts are proven.

## Unresolved implementation decisions

These are implementation-level choices, not blockers to starting Phase 1:

1. Exact module/file names for the shared record schema and main sink.
2. Whether the writer uses synchronous low-volume append throughout or buffered normal writes plus synchronous fatal writes.
3. Exact rotation thresholds after measuring Phase 1 volume; suggested defaults are supplied above.
4. Extra file descriptor number and framing for sidecar operational records.
5. Whether trace identity uses additive optional `ServerFrame` envelope metadata or a parallel correlated side channel. The former is preferred unless compatibility evidence rejects it.
6. Exact engine-to-sidecar owner that mints `streamEpoch`, `eventSequence`, and `eventTraceId` before the first trace stage.
7. Renderer acknowledgement batch/range representation and maximum IPC rate/size.
8. Exact lifecycle/turn events that require a post-commit acknowledgement.
9. Renderer health cadence, timeout, coarse persistence interval, and event-loop lag threshold after measurement.
10. Final delivery-trace rotation limits after measuring real event volume.
11. Authoritative build/commit identity source for dev and packaged builds.
12. Whether a desktop-specific engine `ErrorLogSink` is attached or the shared sink is hardened first.
13. How the existing engine debug cleanup is made desktop-reachable without pulling the engine dependency graph into main.
14. Which visible surface owns “Open logs folder” and “Save diagnostics bundle.”

These decisions may add bounded desktop trace metadata and fixed acknowledgements, but they must not change the one-sidecar-per-session topology, raw `AppSessionEvent` content/fidelity, or the Unix-socket application transport.

## Report verification

Verification completed against the source snapshot described by this report.

```text
VERIFICATION
- git diff --check  → PASS
- git diff --no-index --check -- /dev/null <report>  → CLEAN (no whitespace diagnostics; status 1 is expected because the new file differs from `/dev/null`)
- bun run maps:lint  → PASS (18 maps; 8 warnings in map files not changed by this report)
- cited-path existence check  → PASS (45/45 current paths; proposed new files are labeled as recommendations)
- cited source-anchor range check  → PASS (24/24 file-anchor maxima within bounds)
- cited package-script check  → PASS (6/6 scripts present)
Stale-reference sweep: N/A; no rename, removal, or interface change
Not run: runtime build/test batteries; report-only documentation change
```
