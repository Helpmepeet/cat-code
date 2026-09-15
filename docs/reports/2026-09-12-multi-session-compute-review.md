# Independent review of the multi-session compute audit

Date: 2026-09-12. Verdict: **GREEN — accept the corrected report.** No open correctness or conformance findings. This is acceptance of an investigation and its recommendations, not proof of implemented savings.

Reviewed [the audit](/Users/pt/cat-code/docs/reports/2026-09-12-multi-session-compute-audit.md) after its completed draft, as the user requested. The reviewed report includes correction commit `921f1cc3089c3f6f7ede832683089a790b9fcc7d`. Source was the shared working tree at review time; unrelated concurrent changes were neither reverted nor incorporated as review work. No application source was edited.

## Contract and conformance

The contract was to identify remaining energy/compute optimization opportunities in the desktop application with many independent Claude sessions, write a report, and then obtain an independent subagent review. The report supplies seven prioritized opportunities, present safeguards, source anchors, a bounded synthetic experiment, and a measurement plan. It distinguishes session-multiplied costs from application-wide costs and distinguishes local work from model inference. This conforms to the requested report-only scope.

I re-derived the load-bearing mechanisms from current production source, including the callers and gates, rather than accepting historical performance comments. Recommendations are explicitly future work. No application build, GUI proof, implementation regression tests, or measured battery saving is being claimed.

## Findings and disposition

| Finding | Severity | Evidence and consequence | Disposition |
|---|---|---|---|
| F1: The initial context-popover recommendation did not distinguish the existing local estimator from the remaining opportunity to invoke it earlier. | Low | [analyzeContext.ts:133](/Users/pt/cat-code/src/utils/analyzeContext.ts:133) already invokes the local estimate after remote attempts; describing estimation as new work could send implementation toward duplicating a helper while retaining the expensive generation fallback. | **Closed by report author.** The corrected paragraph explicitly proposes reusing the existing estimator earlier under a display policy, marking estimates, and preserving shared engine counting contracts. Verified in commit `921f1cc3`. |

No other actionable findings. No second-strike finding was identified.

## Source checks

| Claim family | Independently verified production evidence |
|---|---|
| Separate engines and process-global state | The supervisor actually [spawns a child with session cwd](/Users/pt/cat-code/app/supervisor/supervisor.ts:372). Query execution [sets cwd](/Users/pt/cat-code/src/QueryEngine.ts:371), while [bootstrap state](/Users/pt/cat-code/src/bootstrap/state.ts:445) retains process-global identity. The cited isolation probe is only caller/wiring evidence; the report does not claim it is a fresh OS-process test. |
| Account work per process | Normal [sidecar initialization](/Users/pt/cat-code/app/sidecar/index.ts:258) reaches engine init and [vault-conditioned timer startup](/Users/pt/cat-code/src/services/api/codexAccountPool.ts:275). The [one-second recovery scan](/Users/pt/cat-code/src/services/api/codexTokenRefresh.ts:827) and [process-local usage scheduling](/Users/pt/cat-code/src/services/api/codexUsage.ts:353) remain present. The 14,400/hour figure is callback arithmetic for four live processes, correctly not asserted as HTTP requests or OS wakeups. |
| Repeated analytics | Main [requests analytics every fifth run](/Users/pt/cat-code/app/main/main.ts:993); the worker [requests two ranges](/Users/pt/cat-code/app/sidecar/accountsPoolWorker.ts:245). Each range [enumerates and processes directly](/Users/pt/cat-code/src/utils/stats.ts:755), subject to [mtime/start-date filtering](/Users/pt/cat-code/src/utils/stats.ts:144). The report does not claim every file is fully parsed on every run. |
| Live stream work | Main [immediately delivers the gate result](/Users/pt/cat-code/app/main/main.ts:1892); ordinary attached traffic [returns a singleton](/Users/pt/cat-code/app/main/attachmentGate.ts:74). The live renderer [reaches store dispatch](/Users/pt/cat-code/app/renderer/src/App.tsx:1033), and the [live reducer reaches the transaction projector](/Users/pt/cat-code/app/renderer/src/previewTranscriptState.ts:95). [Streaming upsert](/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:1639) copies rows and constructs a draft index. Raw-log array copies and synchronous trace-directory/stat/write work are also present at the cited owners. |
| Shared workers | [First-paint startup](/Users/pt/cat-code/app/main/main.ts:1635) arms global catalog and accounts drivers without a session requirement. Current constants are 120 and 60 seconds. The 90/hour total is correctly nominal, subject to overruns and extra runs. The catalog worker writes after successful enumeration and main republishes; [title precedence uses capture time](/Users/pt/cat-code/app/renderer/src/sessionsCatalogState.ts:342), which the proposal explicitly preserves. |
| Eager diagnostics | [Session construction awaits diagnostics](/Users/pt/cat-code/app/sidecar/sessionController.ts:763); [diagnostic fanout](/Users/pt/cat-code/app/sidecar/diagnosticsDomain.ts:103) reaches installation health, [doctor diagnostics](/Users/pt/cat-code/src/utils/status.tsx:179), and the npm subprocess. This is correctly described as startup work, not recurring polling. |
| MCP lifecycle | The production sidecar [wires the lifecycle gate](/Users/pt/cat-code/app/sidecar/index.ts:390); [socket/trust guards](/Users/pt/cat-code/app/sidecar/mcpLifecycleStartGate.ts:17) precede discovery. Enabled ordinary stdio configurations [construct a transport](/Users/pt/cat-code/src/services/mcp/client.ts:1216), and the connection memoization is process-local. The report appropriately qualifies the N×M scaling and preserves integration-specific state and notifications. |
| Auxiliary requests and parking | Title generation passes the full trimmed prompt to the separate request and has fresh-session/existing-title/one-attempt guards. Context requests have a 15-second floor, in-flight coalescing, and a reachable generation-count fallback. Parking has the current 120-minute TTL, four-engine soft target, visible-session protection, and [sidecar live-work guards](/Users/pt/cat-code/app/sidecar/sidecarServer.ts:2840). The report correctly refuses to treat four as a hard ceiling. |

The ownership proposals preserve the engine-free main boundary in [ACCOUNTS-OWNERSHIP](/Users/pt/cat-code/docs/migration/decisions/ACCOUNTS-OWNERSHIP.md:44) and flag the ratified disposable-worker choice in [CATALOG-OWNERSHIP](/Users/pt/cat-code/docs/migration/decisions/CATALOG-OWNERSHIP.md:3). They do not authorize an ownership rewrite as a small cache change. Process isolation and raw event transport remain requirements.

I also checked the source boundary relevant to the proposals: closed inbound keys and dispatch, T4 goal validation, T5a pending-request correlation, T6 input confirmation, T6b durable-permission restrictions, T7 limits, directional frame caps, outbound secret scanning, and the fixed-method preload. No recommendation calls for removing these. This was a source conformance check, not a fresh full security audit or hardening execution.

## Independent verification

The exact synthetic probe now appears in the audit appendix. I ran it under Bun with 2,000 retained user rows and 1,000 one-character deltas, after one warmup per mode:

| Mode | Reviewer wall times |
|---|---|
| Singleton transactions | 31.57, 36.10, 35.13 ms |
| Ten deltas per transaction | 3.09, 3.33, 3.40 ms |

Both modes returned 2,001 rows and 1,000 characters. These reproduce the direction of the reported result. The check is limited to those outputs; it is not full structural equivalence, real-time IPC/React responsiveness, process CPU profiling, or energy measurement. The audit states those limits correctly.

```text
VERIFICATION
- bun test app/main/singleFlightDriver.test.ts app/main/idleParkDriver.test.ts
  → 26 pass / 0 fail; 44 assertions, independently rerun.
- Exact in-memory Bun projector probe from the audit appendix
  → three repetitions per mode; output checks and timings above.
- git -c core.fsmonitor=false diff --check
  → clean for the shared working tree.
- git -c core.fsmonitor=false diff --cached --check -- docs/reports/2026-09-12-multi-session-compute-review.md
  → clean for the staged review document.
- bun run maps:lint
  → passed: 17 maps, 7 warnings in existing map sections.
Stale-reference sweep: no renamed/removed interfaces; 48 audit and 29 review local
file/line references validated.
Not run: app build, GUI/security battery, live model/account calls, private transcript reads,
         MCP configuration/process measurement, or power profiling.
Reason: report-only review; no application changes or measured-energy acceptance claim.
```

Actual savings and relative priority remain **UNVERIFIED** until an implementation owner runs the report's 1/4/8-session measurement protocol. That is an explicit limitation of a source audit, not a missing acceptance condition for this requested report. No percentage battery or provider-energy claim is justified by the present evidence.
