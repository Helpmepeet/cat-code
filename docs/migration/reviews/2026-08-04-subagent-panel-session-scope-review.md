# Subagent panel session scope and identity — cold review

**Date:** 2026-08-04  
**Scope:** exact-session worker snapshots, worker display names, compact worker type labels  
**Verdict:** **YELLOW — accept the session/data fix; correct the compact-row chrome and produce the required fidelity evidence before surface acceptance**

## Contract

The operator reported two related defects in the desktop subagent panel:

1. workers spawned by session A must never appear in session B merely because the
   sessions share a project;
2. compact rows must show a genuine worker name instead of an internal id, replace
   the visible `Resumable` lifecycle word with the normalized subagent type, and
   retain lifecycle meaning through the existing pip/count/attention/accessibility
   vocabulary.

The engine's cross-session resume discovery was explicitly out of scope and had to
remain available to engine tools. The change applied to the docked roster, Workers
dialog, and worker detail header, without inventing names for unnamed workers.

## Conformance

| Contract item | Result | Evidence |
|---|---|---|
| Sidecar reads only its current engine session | **Implemented** | `app/sidecar/agentModeDomain.ts:153-161` calls `readSessionState(getSessionId())`; the production sidecar creates the domain only after resume has adopted the engine id (`app/sidecar/index.ts:134-178`). |
| Engine continuity behavior remains intact | **Implemented** | `src/tools/ListWorkersTool/ListWorkersTool.ts:44` still uses `readSessionStateWithContinuity`; `src/tools/AgentTool/resumeAgent.ts` remains unchanged; the focused engine preservation suite is green. |
| Same-project A/B regression | **Implemented** | `app/sidecar/agentModeDomain.fixture.ts:1-47` writes A state, switches from A to B in one isolated process, and proves B empty; `agentModeDomain.test.ts` runs the fixture. The attach-level sidecar test now requires exactly one current worker. |
| Hide legacy id-as-handle values everywhere | **Implemented** | `selectWorkerDisplayName` is shared by roster, Workers dialog, and detail (`app/renderer/src/orchestratorState.ts:271-282`); SSR tests cover null, `@name`, and `handle === agentId`. |
| Put normalized type on compact rows, keep lifecycle semantics | **Partial** | Type text and accessible lifecycle are wired, but the visible dot grammar regressed; see F1. |
| Migration bookkeeping reflects exact-session ownership | **Implemented** | `docs/migration/STATUS.md` and `docs/migration/PARITY-LEDGER.md` record that continuity stays engine-only and GUI acceptance remains pending. |

## Findings

| ID | Severity | Finding | Failure scenario | Owner / disposition |
|---|---|---|---|---|
| **F1** | **Medium** | Compact rows render two adjacent status-like markers on the right — `AgentPip` plus the new ring embedded in `AgentTypeLabel` — and remove the original leading role marker, instead of replacing only the `Resumable` word with the type. | Every roster row now reads visually as `description · lifecycle-dot · type-dot · type`; the two rings compete for meaning and the left edge loses the stable worker/type marker shown in the operator's reference. This affects both the hover roster and Workers dialog (`OrchestratorRoster.tsx:209-219`, `TasksDialog.tsx:474-479`, `AgentChrome.tsx:68-81`). | **Implementation session — react now.** Preserve one clear leading or trailing marker per semantic axis. The most literal operator-requested layout is the existing leading role/type dot plus one right-side lifecycle pip followed by type text with no second ring. Pin DOM order/count in the renderer tests, then confirm in the app. |
| **F2** | **Medium** | The handoff's “Fidelity artifact: PASS via focused renderer assertions” claim is unsupported; SSR string assertions are not a state-by-state prototype/actual artifact. | The tests prove text presence and id absence but cannot show the F1 marker collision, hover roster placement, focus styling, truncation, or painted token colors (`OrchestratorRoster.test.tsx:148-208`, `TasksDialog.test.tsx:324-383`). A visually wrong panel can therefore retain a green test suite. | **Implementation session + operator — required before surface acceptance.** Capture prototype/actual pairs for single worker, multi-worker resting, promoted/attention, hover roster, Workers list, and detail; record open deviations and obtain operator approval. |

## Correctness and security review

- The production read seam is correct: `readSessionState` adds only workers from
  the requested state file, while `readSessionStateWithContinuity` is the separate
  union at `src/agent-mode/sessionState.ts:662-719`.
- The A/B fixture exercises the real domain entry point and global engine session
  switch. The sidecar attach test exercises the production send path, so this is
  not helper-only proof.
- The pre-fix failure is exact: replacing the new read with
  `readSessionStateWithContinuity` would import session A's worker while session B
  is active in the same project.
- The engine preservation suite proves ListWorkers/resume continuity still works;
  no engine production file changed.
- The boundary vocabulary did not grow. Focused T4/T5a/T6/T6b/T7, framing,
  `secretGuard`, preload fixed-channel/default-deny, and renderer IPC cap tests all
  passed. The snapshot itself crossed the real sidecar `send` guard successfully.
- No protocol runtime shape changed; `app/shared/protocol.ts` and
  `app/sidecar/sidecarServer.ts` contain comment-only corrections.

## Broad-suite classification

`bun test app/` is not green in this environment: **2,505 pass / 29 fail / 6
errors**. The failures are not introduced by this patch:

- A clean clone of `HEAD` reproduces all three account snapshot failures in
  `sidecarServer.test.ts` (**185 pass / 3 fail**), all four credential-dependent
  `accountsDomain.test.ts` failures (**34 pass / 4 fail**), and both PID identity
  `registry.test.ts` failures (**35 pass / 2 fail**).
- The remaining real-process failures report `EPERM` / `Failed to listen` on Bun
  Unix sockets and then time out. None of their runtime files changed.
- Patch-owned focused suites, typechecks, the renderer build, and engine
  continuity tests are green. Repository-wide green is therefore not established,
  but the red tests are baseline/environmental rather than regressions in the
  reviewed change.

## Verification

```text
VERIFICATION
- bun test app/renderer/src/OrchestratorRoster.test.tsx app/renderer/src/TasksDialog.test.tsx app/renderer/src/orchestratorState.test.ts app/renderer/src/workerInspection.test.ts
  -> 54 pass / 0 fail / 270 assertions
- bun test app/sidecar/agentModeDomain.test.ts
  -> 11 pass / 0 fail / 34 assertions (includes isolated same-project A/B live path)
- bun test app/sidecar/sidecarServer.test.ts -t 'T4|T5a|T6|T6b|T7|closed inbound allowlist|P4-8 — emits a joined agent-mode.snapshot'
  -> 11 pass / 0 fail
- bun test app/shared/secretGuard.test.ts app/shared/framing.test.ts app/preload/preloadSource.test.ts app/preload/rendererIpcGuard.test.ts
  -> 38 pass / 0 fail
- bun test src/agent-mode/sessionState.test.ts src/tools/ListWorkersTool/ListWorkersTool.test.ts src/tools/AgentTool/resumeAgent.test.ts
  -> 20 pass / 0 fail
- bun run --cwd app typecheck
  -> pass
- bun run --cwd app typecheck:sidecar
  -> scoped pass; 5,560 upstream diagnostics ignored, 0 owned diagnostics
- bun run --cwd app renderer:build
  -> pass; 630 modules transformed (existing chunk-size warning)
- bun test app/
  -> 2,505 pass / 29 fail / 6 errors across 175 files; failures classified above
- git diff --check
  -> clean before adding this archival review
Stale-reference sweep: exact-session desktop comments are updated; remaining
readSessionStateWithContinuity uses are the intentionally preserved engine tools and historical superseded ledger text.
Not run: bun run --cwd app test:hardening (no boundary/preload runtime change and it launches Electron; no explicit GUI-launch authorization); live app/prototype comparison (operator action required).
```

## Fidelity

```text
FIDELITY
- Surfaces touched:      docked Orchestrator roster; hover roster; Workers dialog; worker detail header
- States compared:       source/SSR only; no valid prototype|actual screenshot pairs were produced
- Prototype anchors:     ~/catcode_prototype/cat-app/OrchestratorMode.jsx:237-372 and :713-808
- Comparison artifacts:  none satisfying the state-by-state requirement
- Open mismatches:       F1 double right-side marker / missing leading role marker
- Operator-approved deviations: none
- Live GUI acceptance:   PENDING

SURFACE ACCEPTANCE
- Engineering:       PASS for the patch-owned paths; repository-wide suite remains baseline-red
- Security:          N/A (boundary unchanged; focused baseline checks PASS)
- Fidelity artifact: FAIL
- Live fidelity:     PENDING
- Overall surface acceptance: FAIL
```

STATUS and PARITY-LEDGER were not edited by this review; review work is report-only
unless the operator asks for fixes or bookkeeping changes.
