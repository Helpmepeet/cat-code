# Multi-session compute and energy audit

Date: 2026-09-12. Scope: the Cat Code desktop application and the engine paths its session processes actually execute. Source baseline at audit start: `38ecd9e83cfb5d95a1be0385cf2cb032e48d3c93`, plus the working tree. This is a report, with no application changes.

**Recommendation: keep each conversation isolated, but make shared housekeeping do less repeated work.** The strongest starting points are account maintenance, overlapping usage-history scans, and processing live output in small batches. Each has a concrete reachable implementation today. Which saves the most electricity still requires profiling.

Your description is substantially right: each desktop session has its own engine process. It also has its own copies of many engine services. The application already shares some global work, however, so opening four sessions does not multiply every cost by four. The current process separation protects process-global working-directory and session identity; combining conversations into one engine is not a suitable first optimization. See the [isolation probe](/Users/pt/cat-code/src/app-runtime/multiSessionIsolation.probe.test.ts) and [runtime initialization](/Users/pt/cat-code/app/sidecar/initializeRuntime.ts:42).

**Evidence and limits.** Findings below are source-verified mechanisms, with a small synthetic timing experiment for transcript processing. No live application power, CPU utilization, account inventory, or MCP configuration was measured. No private conversations were inspected and no provider requests were made. Counts calculated from timer constants are scheduling opportunities, not measured operating-system wakeups. Local CPU, memory, disk/network activity, and remote model computation are separate costs; none is converted into an invented battery-life percentage.

Several files were already being edited by other sessions, including `App.tsx`, account transport, session storage, and maps. Anchors describe the observed working tree; recommendations should be rechecked before implementation. Existing comments contain historical RAM/CPU measurements; this report does not present those as fresh measurements.

| Order | Opportunity | When it matters | Suggested first change |
|---|---|---|---|
| 1 | Account maintenance repeated per session | Idle sessions with Codex vault accounts; active Codex sessions | Schedule recovery only when needed; then share usage observations |
| 2 | Overlapping history analytics scans | Growing transcript history, even with no chat running | Compute both date ranges from one read pass |
| 3 | Repeated work for streamed output | Several active sessions or long transcripts | Batch live delivery; amortize raw-log updates |
| 4 | Global workers repeat unchanged work | App left open for hours | Avoid unchanged publication/writes; measure adaptive refresh |
| 5 | Eager installation diagnostics | Frequent session creation/restoration | Load diagnostics when opened |
| 6 | Eager MCP integrations | Many configured, unused tool servers | Measure each integration, then selectively connect on first use |
| 7 | Auxiliary model/context requests | Long first prompts; repeated context-popover use | Bound title input and cache unchanged context analysis |

The order balances confidence, implementation scope, and useful work preserved. It is not a ranking established by measured energy savings. A heavy MCP server could make item 6 the largest saving on a particular machine.

**1. Account housekeeping still multiplies across sessions**

Desktop startup calls engine initialization, which initializes the Codex account pool without requiring a Codex-selected conversation. When a vault account exists, pool initialization starts a quarantine-recovery timer in that process. The interval is one second. Every tick scans account status, even when every account is healthy; a quarantined account additionally causes a vault read before its retry deadline is checked. Sources: [engine init](/Users/pt/cat-code/src/entrypoints/init.ts:90), [pool initialization](/Users/pt/cat-code/src/services/api/codexAccountPool.ts:264), [timer and recovery scan](/Users/pt/cat-code/src/services/api/codexTokenRefresh.ts:827).

Four such live sidecars imply roughly **14,400 timer callbacks per hour**, assuming uninterrupted timer execution. This is not 14,400 network requests. Existing no-overlap guards, backoff, cleanup, and token-refresh locks already limit actual recovery work. The timer's `unref()` lets the process exit; it does not stop callbacks while the session stays alive.

Start with a narrow improvement: sleep until the earliest recovery deadline, and arm no recovery timer for an all-healthy pool. Wake it on quarantine changes and account changes from other processes. Preserve the existing token locking and recovery backoff. This has a clear idle-work benefit, but each healthy tick is small, so the battery gain could also be small.

There is a second, larger scaling opportunity during Codex use. Each sidecar has its own usage cache and in-flight request tracking. Completed OpenAI requests schedule a pool refresh, floored to once per 30 seconds per process. A refresh visits every account. The global accounts worker independently refreshes usage every minute, and session startup can initiate another observation. Sources: [completion trigger](/Users/pt/cat-code/src/services/api/claude.ts:3192), [cache and scheduling](/Users/pt/cat-code/src/services/api/codexUsage.ts:290), [per-account fanout](/Users/pt/cat-code/src/services/api/codexUsage.ts:383), [global worker](/Users/pt/cat-code/app/sidecar/accountsPoolWorker.ts:130).

A later improvement is one credential-owning engine observer with a shared observation cache, distributing redacted facts to sessions. Keep selection and routing authority correct for each conversation. Account reset, switch, deletion, and external vault changes must invalidate shared observations; stale results must not reinstall old state. Actual HTTP counts depend on account eligibility, errors, and activity. These are usage-status reads, not model inference calls. This is an ownership change requiring explicit design of the existing worker boundary, not merely increasing an in-memory TTL.

**2. The usage dashboard independently rereads overlapping history**

Every fifth accounts-worker run requests analytics. At the normal one-minute cadence, that is about 12 analytics runs per hour, plus startup and mutation-triggered variation. Each analytics run asks for 7-day and 30-day totals separately and concurrently. Each range enumerates session files and processes eligible transcripts directly. The durable cache used by the `all` range is bypassed. Sources: [cadence](/Users/pt/cat-code/app/main/accountsPoolRunner.ts:42), [two calls](/Users/pt/cat-code/app/sidecar/accountsPoolWorker.ts:245), [range aggregator](/Users/pt/cat-code/src/utils/stats.ts:755).

The newest files can therefore be parsed twice in one refresh, and parsed again during later refreshes when unchanged. Existing mtime and large-file start-date checks skip ineligible files, so this is not a claim that every transcript is fully read every time. See [filter and JSONL read](/Users/pt/cat-code/src/utils/stats.ts:137). The five-second memory cache is per range and dies with the disposable worker; it does not solve repeated runs. See [stats domain](/Users/pt/cat-code/app/sidecar/statsDomain.ts:135).

First compute both ranges from one discovery/read pass. Then consider a versioned cache of per-file aggregates, invalidated by file identity, size, modification, truncation, or replacement. Preserve current counting rules for resumed sessions, repeated message IDs, subagents, and date boundaries. Appending-only assumptions are insufficient because histories can be edited or replaced. Cache failure must retain the last good display rather than publishing false zero totals.

Validation should count directory scans, bytes read, and JSONL parses for an unchanged corpus, one appended message, a rewritten transcript, and midnight rollover. This is a promising saving that grows with history, independent of the number of currently open chats.

**3. Stream delivery has batch machinery, but ordinary live traffic rarely benefits**

The main process already sends arrays of frames, and replay uses coalescing. Ordinary attached live traffic returns a one-frame array and is sent immediately. Each received batch runs the renderer's store reducers, including those for background sessions. Most unrelated reducers can no-op; they are not all doing expensive work. Sources: [live attachment path](/Users/pt/cat-code/app/main/attachmentGate.ts:74), [main delivery](/Users/pt/cat-code/app/main/main.ts:1163), [store dispatch](/Users/pt/cat-code/app/renderer/src/serverFrameBatch.ts:98).

A streaming text/thinking update copies the retained row array and builds a row index within its projection transaction. A new singleton transaction repeats that work. Longer retained transcripts and a higher combined output-chunk rate increase this overhead. The current transaction already amortizes it when several frames arrive together. Sources: [transaction](/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:1295), [row ownership](/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:1481), [index construction](/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:1543), [stream update](/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:1639).

A synthetic experiment used 2,000 retained user rows followed by 1,000 one-character deltas, calling the actual projector under Bun. After one warmup per mode, the author repeated each mode three times:

| Projection grouping | Measured wall time per repetition |
|---|---|
| One delta per transaction | 33.30, 34.34, 33.18 ms |
| Ten deltas per transaction | 3.12, 4.66, 2.97 ms |

Both modes produced 2,001 rows and a 1,000-character streaming row. Those are narrow output checks, not full structural-equivalence proof. Timing includes the loop's array slicing; it excludes history construction, Electron IPC, React, painting, realistic arrival delays, and power. The result supports investigating batching, not claiming an application-wide speedup.

Trial a short, bounded live-delivery queue that preserves every original frame and order. Flush promptly around permission, control, completion, and reset boundaries; impose byte/count/time limits. Measure responsiveness before choosing its delay. The locked raw-event transport can remain intact. Existing replay batching, memoized rows, and windowed long content should be retained.

Two adjacent costs deserve separate measurements after that first change:

- **Raw-log arrays:** each message is serialized for byte accounting, then retained message/size arrays are copied and sometimes sliced for eviction. The generic batch wrapper still folds this reducer per frame, so IPC batching alone does not remove those copies. Use a batch-aware or bounded chunk/ring representation while preserving chronological replay, deduplication, and byte caps. The log also supports usage/context information; it is not disposable debug-only data. [Raw-log owner](/Users/pt/cat-code/app/renderer/src/rawMessageLog.ts:178), [generic batch fold](/Users/pt/cat-code/app/renderer/src/serverFrameBatch.ts:34).
- **Trace writes:** each append prepares the private directory before checking its open descriptor, then performs synchronous stat/write operations on main. Directory preparation itself performs synchronous mkdir/chmod. Consider preparing on open/reopen and tracking writer-owned byte counts first. Any later write batching needs a defined crash-tail-loss policy; retain private permissions, rotation, bounds, and useful diagnostic evidence. [Trace writer](/Users/pt/cat-code/app/main/deliveryTraceSink.ts:257), [directory preparation](/Users/pt/cat-code/app/main/jsonlRetention.ts:23).

**4. Shared background workers still run when their data has not changed**

Catalog and account observation are already centralized, so their scheduled cost is per application rather than per chat. But they still launch disposable engine workers throughout the app's lifetime: catalog every 120 seconds, accounts every 60 seconds. That is a nominal **90 worker launches per hour**, or 2,160 over 24 continuously awake hours, before extra refreshes or overruns. Both start after first paint, even without a chat. Sources: [catalog cadence](/Users/pt/cat-code/app/main/sessionsCatalogRunner.ts:60), [accounts cadence](/Users/pt/cat-code/app/main/accountsPoolRunner.ts:42), [launch wiring](/Users/pt/cat-code/app/main/main.ts:1635).

The catalog worker always enumerates and attempts to rewrite its cache after a successful read, then main republishes the snapshot. The write uses durable atomic replacement. Sources: [worker](/Users/pt/cat-code/app/sidecar/sessionsCatalogWorker.ts:54), [cache writer](/Users/pt/cat-code/app/sidecar/sessionsCatalogCache.ts:47), [publication](/Users/pt/cat-code/app/main/main.ts:953).

Begin by detecting meaningful content changes before rewriting/publishing large payloads. Preserve freshness metadata separately: `capturedAtMs` participates in title precedence, so ignoring timestamp-only changes blindly would alter behavior. See [title arbitration](/Users/pt/cat-code/app/renderer/src/sessionsCatalogState.ts:342). This reduces writes and downstream work; it does not by itself avoid enumeration or process startup.

Next measure activity-aware cadence or coarse file-change invalidation with a fallback sweep. External terminal sessions can create or rename histories, so app-local events alone are insufficient. Retain immediate startup population, mutation-triggered account refreshes, bounded freshness, single-flight execution, and last-good snapshots. Poll suspension changes the freshness contract and should be an explicit policy choice. A persistent worker might amortize imports, but exchanges CPU savings for retained memory and changes the ratified disposable-worker design; measure and revisit that decision before adopting it.

**5. Installation diagnostics are paid at every session startup**

Session construction awaits the diagnostics domain, which immediately runs installation, installation-health, memory, and branch checks. Installation detection includes an npm configuration subprocess. The work occurs even if Diagnostics is never opened. Sources: [construction](/Users/pt/cat-code/app/sidecar/sessionController.ts:763), [diagnostics fanout](/Users/pt/cat-code/app/sidecar/diagnosticsDomain.ts:88), [installation check](/Users/pt/cat-code/src/utils/doctorDiagnostic.ts:222).

Load and coalesce this work when the panel is requested. Optionally cache machine-wide installation facts separately from session/workspace facts, with explicit refresh after environment changes. This saves startup work for each new/restored process; it is already a once-per-startup snapshot, not a recurring poll. Validate time-to-ready, diagnostic child-process counts, fresh workspace facts, and honest loading/error states.

**6. Unused MCP integrations can multiply server processes**

Each session owns an MCP lifecycle. Once its socket is ready and workspace trusted, the lifecycle connects prepared enabled servers and discovers capabilities. Ordinary stdio configurations create their own transport/child in that process; memoization is local to the engine process. Sources: [startup gate](/Users/pt/cat-code/app/sidecar/mcpLifecycleStartGate.ts:17), [configuration dispatch](/Users/pt/cat-code/src/app-runtime/createAppRuntimeMcpLifecycle.ts:294), [stdio transport](/Users/pt/cat-code/src/services/mcp/client.ts:1216), [connection loop](/Users/pt/cat-code/src/services/mcp/client.ts:2417).

With N sessions and M applicable stdio integrations, this can approach N×M server processes/connections. Real counts depend on configuration, failed/auth-needed connections, and special in-process implementations. Existing trust/approval gates, disabled-server skips, connection concurrency limits, and disposal handling are valuable.

Measure which integrations remain unused and what each costs before changing the policy. Prefer selective first-use connection with bounded cached discovery metadata. Preserve eager startup where subscriptions or notifications require it. Arbitrary MCP servers can hold working-directory, credential, subscription, or mutable conversation state; sharing them across sessions requires integration-specific proof. Test first-use latency, tool discovery, cancellation, elicitation, notifications, and disposal.

**7. Smaller opportunities directly affect auxiliary model computation**

**Titles:** a new untitled session sends its complete trimmed first prompt to a separate title request. Desktop input permits up to 96 KiB, while the title instruction asks for 3–7 words. Supply a bounded title-oriented excerpt, keeping the real conversation unchanged. Preserve enough of the request and any useful ending to keep titles recognizable. Existing safeguards already make this one attempt per fresh session, skip resumes/existing titles, and use a small model with thinking disabled. This is modest, workload-dependent savings, not a request on every turn. Sources: [title trigger/input](/Users/pt/cat-code/app/sidecar/sessionTitleGen.ts:74), [request construction](/Users/pt/cat-code/src/utils/sessionTitle.ts:89), [input limit](/Users/pt/cat-code/app/shared/limits.ts:53).

**Context popover:** detailed analysis is already on demand, coalesced, and cached for 15 seconds. Reopening after that age can recompute unchanged context. The analyzer makes token-count requests; when counting fails, its fallback can make an actual model-generation request to obtain usage. A local display estimator already exists, but it runs after those remote attempts fail. Cache by relevant content/revisions; under an explicit display policy, reuse that estimator earlier to skip generation-based counting and label the result as estimated. Invalidate on transcript, model, tools, permission, prompt, and memory changes. Keep shared engine counting contracts intact. Sources: [age check](/Users/pt/cat-code/app/sidecar/sidecarServer.ts:4315), [analysis](/Users/pt/cat-code/app/sidecar/contextBreakdownDomain.ts:93), [fallback and existing display estimator](/Users/pt/cat-code/src/utils/analyzeContext.ts:80), [generation request](/Users/pt/cat-code/src/services/tokenEstimation.ts:632). This is an interaction-dependent opportunity, not background inference in every idle session.

**What should stay**

Idle parking already has a 120-minute TTL and a soft target of four live engines. Visible sessions are protected, and the sidecar refuses parking during active turns, pending permissions/tasks, queued work, durable writes, or OAuth. Four is not a hard memory ceiling. A shorter TTL can cause repeated restore/startup work and disrupt the user's switching pattern; tune only after measuring that tradeoff. Sources: [policy](/Users/pt/cat-code/app/main/idleParkDriver.ts:42), [gate](/Users/pt/cat-code/app/sidecar/sidecarServer.ts:2840).

Keep process isolation, trust and permission boundaries, token locks, raw event fidelity, redaction, diagnostic retention, replay recovery, and already-shared catalog/account ownership. None of the proposed savings requires weakening these. Merely keeping a session open is not evidence that it continuously calls a model.

**How to decide what to implement**

Use reproducible 1/4/8-session workloads, with eight active sessions exercising the soft-cap case. Measure separately: idle healthy accounts; fixed-rate synthetic streams; new/resumed session startup; unchanged versus growing history; and configured-but-unused integrations. For streaming, compare both equal total output and equal output per session. Keep corpus, power state, foreground visibility, and build mode fixed; randomize before/after order and repeat.

Record process CPU seconds, allocations/GC, child counts and memory, callback and usage-HTTP counts, disk bytes/operations, event-loop blocking, display latency, and auxiliary request input/output tokens. Direct energy measurement is needed before promising battery gains; even local measurements cannot establish provider-side energy use. Metadata-only counters suffice, without collecting conversation bodies or credentials.

Start with deadline-driven quarantine scheduling and one-pass date-range analytics, then test bounded live delivery. Measure each change separately so regressions and savings are attributable. Prioritize MCP laziness sooner if actual server measurements dominate the machine's idle workload.

**Verification and review**

```text
VERIFICATION
- bun test app/main/singleFlightDriver.test.ts app/main/idleParkDriver.test.ts
  → 26 pass / 0 fail; 44 assertions. Existing cadence/parking unit behavior only.
- In-memory Bun transcript projection probe
  → three measured repetitions per mode; timings and limited output checks above.
- git -c core.fsmonitor=false diff --check
  → clean (the default invocation also exited 0, with an fsmonitor diagnostic).
- bun run maps:lint
  → passed: 17 maps, 7 recommended-section warnings in untouched maps.
- Report source-link check
  → 48 local source links exist; all cited line numbers are within their files.
Stale-reference sweep: no renamed/removed interfaces; cited source paths checked.
Not run: application build/GUI/security battery, live provider calls, or power profiling.
Reason: documentation-only audit; no application implementation or measured-energy claim.
```

Independent subagent review completed after the draft: **GREEN, no open findings**. The reviewer rechecked the production paths, independently reran the 26 passing tests, and reproduced the synthetic timing result. One low-severity clarification was incorporated: context analysis already has a local estimator, and the opportunity is to use it before generation-based counting. See the [independent review and evidence](/Users/pt/cat-code/docs/reports/2026-09-12-multi-session-compute-review.md). This accepts the report's findings, not unmeasured energy savings.

**Reproduce the narrow transcript experiment**

Run from `/Users/pt/cat-code`. This uses generated messages only and makes no provider request. It reproduces the workload, not guaranteed timings; inspect full state equality and real frame lifecycle cases separately before implementing batching.

```sh
bun --eval '
import { createTranscriptState, projectServerFrames } from "./app/renderer/src/transcriptProjector.ts";
const sid="synthetic-audit";
const ready={kind:"ready",protocolVersion:1,sessionId:sid,engineSessionId:"engine-synthetic",payload:{type:"app.ready",protocolVersion:1,inputEnabled:true,activeTurn:false,abort:{status:"idle"},goalSnapshot:null,pendingPermissionRequests:[]}};
const mf=(message)=>({kind:"event",protocolVersion:1,sessionId:sid,event:{type:"message",message}});
const hist=Array.from({length:2000},(_,i)=>mf({type:"user",uuid:"u"+i,session_id:"engine-synthetic",parent_tool_use_id:null,message:{role:"user",content:"synthetic "+i}}));
const stream=(event)=>mf({type:"stream_event",uuid:"stream",session_id:"engine-synthetic",parent_tool_use_id:null,event});
const base=projectServerFrames(createTranscriptState(),[ready,...hist,stream({type:"message_start",message:{id:"m-stream"}}),stream({type:"content_block_start",index:0,content_block:{type:"text",text:""}})]);
const deltas=Array.from({length:1000},()=>stream({type:"content_block_delta",index:0,delta:{type:"text_delta",text:"x"}}));
function run(batchSize){let state=base;const t=performance.now();for(let i=0;i<deltas.length;i+=batchSize)state=projectServerFrames(state,deltas.slice(i,i+batchSize));return {ms:performance.now()-t,rows:state.sessions[sid].rows.length,text:state.sessions[sid].rows.at(-1).content.length};}
run(1); run(10);
for(let i=0;i<3;i++)console.log(JSON.stringify({repeat:i+1,single:run(1),batch10:run(10)}));
'
```
