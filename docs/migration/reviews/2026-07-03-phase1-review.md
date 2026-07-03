# Phase 1 Whole-Phase Review — 2026-07-03

## Executive verdict

**CLEARED ON OVERSTATED EVIDENCE.**

The functional Phase-1 gate did walk: the renderer connected to the real sidecar-backed
session, a live `tool_use` rendered without flattening, a real prompt completed, and a real
permission request paused and resumed. The automated evidence around framing, raw forwarding,
boundary validation, renderer reduction, and Electron runtime hardening is also substantive.

The phase did not honestly clear every acceptance criterion attached to that gate. The
security-minimum contract made a production-path crafted-Markdown/navigation smoke a P1-0
completion requirement, but the passing hardening smoke re-declares the policy in a surrogate
window and never boots production main or the real transcript renderer. T7 is also described as
implemented, while size and rate enforcement occurs only after Electron main and the supervisor
have accepted and serialized renderer input. Most seriously, an ordinary oversized paste can
drive the real transport into a half-closed state that continues to report `ready`.

Before Phase 2 expands normal dogfooding, fix the oversized-frame/half-close path, surface dead
session state to the renderer, and restrict development navigation to the actual renderer entry
path. Before rich Markdown and large tool-result work lands, add production-path hardening
coverage and byte-budgeted replay/raw retention.

**P2-0 projector work can start now, with constraints.** It should begin with stable source
identity, realistic one-frame-per-content-block fixtures, and snapshot-drift enforcement. P2-1
through P2-4 should not build past the affected boundaries until their prerequisite
carry-forwards below are complete.

## Scope

This review synthesizes and verifies five independent Phase-1 workstreams:

- transport/data flow;
- isolation/session plane;
- projector/adapter fidelity;
- build/test integrity;
- security baseline.

The workstream reports were treated as review input, not as ground truth. Overlapping findings
were merged by root cause, every HIGH finding was re-opened in current source, and broad security
and lifecycle claims were spot-checked before inclusion.

## Findings

### P1-F1 — CONFIRMED · HIGH

- **Source workstream:** transport/data flow + security baseline
- **Anchor:** `app/renderer/src/App.tsx:60-70`;
  `app/main/main.ts:209-217`;
  `app/supervisor/supervisor.ts:207-218`;
  `app/sidecar/sidecarServer.ts:139-148`;
  `app/supervisor/supervisor.ts:316-331`
- **Finding:** An oversized renderer frame can permanently zombify a session while the
  supervisor continues to report it as `ready`. There is no prompt/frame cap in the renderer or
  Electron main; the supervisor serializes and writes without checking the encoded size; the
  sidecar rejects the declared length, sends an error, and calls `socket.end()`; the supervisor
  observes `close` but not `end`.
- **Evidence:** Current source confirms every production link. `MAX_FRAME_BYTES` is 128 KiB and
  `MAX_PROMPT_BYTES` is 96 KiB (`app/shared/limits.ts:19-39`), but the prompt cap runs only after
  successful frame decoding (`app/sidecar/sidecarServer.ts:284-298`). The transport workstream
  reproduced the composed failure twice with real socket behavior: the half-close did not
  produce `close`, status stayed `ready`, and subsequent sends were accepted into the dead
  socket. This is production code, not a fixture-only path.
- **Concrete failure scenario:** A user pastes a log or diff larger than the inbound frame cap.
  One error appears, then submits, aborts, and permission responses are silently lost. A pending
  permission cannot resolve, and no caller exposes `restartSession`.
- **Phase-2 impact:** This directly undermines transcript and permission dogfooding and defeats
  later `session_not_found` handling that assumes `send()` throws. It is the highest-blast-radius
  carry-forward and blocks broad Phase-2 execution.
- **Owner suggestion:** **P2 transport/session addressing**, as a pre-Phase-2 hardening patch:
  reject over-limit input before framing, handle socket `end`, and add an observable recovery
  path.

### P1-F2 — CONFIRMED · MEDIUM

- **Source workstream:** transport/data flow + isolation/session plane
- **Anchor:** `app/main/main.ts:193-198`;
  `app/main/main.ts:258-274`;
  `app/supervisor/supervisor.ts:179-204`;
  `app/supervisor/supervisor.ts:320-331`
- **Finding:** Supervisor lifecycle events stop in Electron main. `wireRendererBridge` forwards
  only frame events, while `status` and `exit` are discarded; failed forwards are written only
  to stderr.
- **Evidence:** The supervisor emits per-session status and exit events, but the only production
  bridge subscriber filters them out. No renderer frame or state transition represents a dead
  sidecar.
- **Concrete failure scenario:** A sidecar crashes or P1-F1 occurs mid-turn. The transcript
  spinner and any permission prompt remain indefinitely, input remains enabled, and later
  actions disappear without an acknowledgment.
- **Phase-2 impact:** P2-3 activity state and P2-4 permission queues otherwise inherit a
  permanent mystery-hang state.
- **Owner suggestion:** **P2 session/lifecycle**; translate non-ready supervisor state into the
  normal renderer delivery path and disable/dismiss affected UI state.

### P1-F3 — CONFIRMED · MEDIUM

- **Source workstream:** security baseline
- **Anchor:** `app/main/navigationPolicy.ts:33-49`;
  `app/main/main.ts:148-165`;
  `app/scripts/hardening-smoke.ts:23-28`;
  `app/scripts/hardening-smoke.ts:40-53`;
  `app/scripts/hardening-smoke.ts:91-109`
- **Finding:** The security hardening evidence does not exercise the production main/Markdown
  path, and development navigation trusts every path on the Vite origin rather than only the
  renderer entry document.
- **Evidence:** The production handlers are present, but `isAppOrigin` compares only origin in
  development. The hardening smoke explicitly copies CSP and `webPreferences` into a separate
  `BrowserWindow`, serves custom HTML, and does not import production main or render
  `TranscriptView`. This falls short of the crafted-Markdown/navigation verification gate in
  `decisions/SECURITY-MINIMUM.md:191-193`.
- **Concrete failure scenario:** An untrusted rendered link targets another same-origin Vite
  route. Electron accepts the top-level navigation and leaves the preload attached to content
  that is not the intended renderer entry. A production wiring or Markdown-policy regression
  would also remain green in the surrogate smoke.
- **Phase-2 impact:** Phase 2 increases Markdown and tool-output exposure. Restricting the dev
  path is required before routine dev dogfooding; production-path hardening coverage is required
  before P2-1 expands rich rendering.
- **Owner suggestion:** **P2 security/hardening**.

### P1-F4 — CONFIRMED · MEDIUM

- **Source workstream:** transport/data flow + security baseline
- **Anchor:** `app/shared/limits.ts:23-26`;
  `app/main/replayBuffer.ts:25-26`;
  `app/main/replayBuffer.ts:39-66`;
  `app/main/attachmentGate.ts:39-51`;
  `app/renderer/src/rawMessageLog.ts:41-45`
- **Finding:** Replay retention is bounded only by frame count, truncates without a marker, and
  the renderer raw log has no retention bound. The same root cause creates both correctness and
  memory risks.
- **Evidence:** Main retains the last 512 non-ready frames regardless of byte size, although one
  outbound frame may approach 32 MiB. `snapshot()` exposes no truncation state. The renderer
  appends every raw SDK message indefinitely.
- **Concrete failure scenario:** A long multi-tool turn evicts early `tool_use` frames but keeps
  later matching `tool_result` frames; after reload, P2-2 receives orphaned results with no
  truncation boundary. Repeated large tool results can also retain excessive copies across main,
  raw state, and projected state.
- **Phase-2 impact:** P2-0/P2-2 must define lossy-replay semantics and orphan tolerance; byte
  budgets must land before large tool-result rendering becomes routine.
- **Owner suggestion:** **P2-0 projector** with **P2 transport/session addressing**.

### P1-F5 — CONFIRMED · MEDIUM

- **Source workstream:** projector/adapter fidelity
- **Anchor:** `app/renderer/src/transcriptProjector.ts:21-42`;
  `app/renderer/src/transcriptProjector.ts:71-77`;
  `app/renderer/src/transcriptProjector.test.ts:7-45`;
  `app/renderer/src/TranscriptView.tsx:19-30`;
  `src/services/api/claude.ts:2371-2391`
- **Finding:** The Phase-1 projector discards assistant-message identity, and its primary test
  models text plus `tool_use` in one assistant frame even though the producer emits one
  assistant frame per stopped content block.
- **Evidence:** Projected text rows have no source identity; tool rows retain only tool-use id;
  the projector maps bare blocks and the view uses array indices as React keys. The producer
  preserves the shared message object but yields `content: [contentBlock]` once per block.
- **Concrete failure scenario:** One assistant message emits text and two parallel tools. P2
  cannot reconcile streaming previews or group sibling frames; a future dedupe by message id
  can drop the second tool while the current combined-block fixture remains green.
- **Phase-2 impact:** This is the first P2-0 dependency. P2-2 correlation and P2-3 streaming
  must not build on the append-only Phase-1 row shape.
- **Owner suggestion:** **P2-0 projector**.

### P1-F6 — CONFIRMED · MEDIUM

- **Source workstream:** build/test integrity + isolation/session plane + transport/data flow
- **Anchor:** `app/tsconfig.json:16-30`;
  `app/sidecar/tsconfig.json:3-13`;
  `tsconfig.json:19-23`;
  `app/shared/engine-types.snapshot.d.ts:1-15`
- **Finding:** Neither side of the engine-type boundary has an enforceable drift signal. The
  shell/projector graph compiles against a hand-copied snapshot with no automated drift check;
  the sidecar graph compiles against real engine source but its only typecheck is permanently
  red.
- **Evidence:** Fresh verification produced 5,642 TypeScript errors for
  `app/sidecar/tsconfig.json`; a new sidecar error would be hidden in that baseline. The isolated
  app typecheck passes, but no script compares the snapshot with canonical engine types.
- **Concrete failure scenario:** P2-0 exhaustively handles a stale union while a new runtime
  variant falls through, or P2-4 mis-handles a widened permission type while its static check
  remains red.
- **Phase-2 impact:** Add snapshot drift enforcement at P2-0 entry and establish a scoped or
  baselined sidecar check before P2-4 edits the trust boundary.
- **Owner suggestion:** **P2 build/test hygiene**.

### P1-F7 — CONFIRMED · MEDIUM

- **Source workstream:** projector/adapter fidelity + build/test integrity
- **Anchor:** `app/sidecar/sessionController.ts:37-60`;
  `app/sidecar/sessionController.test.ts:8-15`;
  `app/sidecar/roundtrip.probe.test.ts:85-124`
- **Finding:** The real `getTools()` correction is present but has no normal-path regression
  assertion. The round-trip test injects a fixture event under probe mode and bypasses model
  tool configuration.
- **Evidence:** The controller derives 28 tools from the enforced permission context in current
  source, but its test asserts only construction and idle state. All 122 desktop tests can pass
  without proving that the normal model sees any tools.
- **Concrete failure scenario:** A setup refactor restores `tools: []` or uses a different
  permission context. Fixture round-trips stay green while live turns become text-only.
- **Phase-2 impact:** The real multi-tool gate cannot rely on the current suite until this
  already-observed regression class is locked down.
- **Owner suggestion:** **P2-0 projector** with **P2 build/test hygiene**.

### P1-F8 — CONFIRMED · MEDIUM

- **Source workstream:** isolation/session plane
- **Anchor:** `app/sidecar/sessionController.ts:14-45`;
  `app/supervisor/supervisor.ts:148-156`;
  `src/bootstrap/state.ts:264-284`;
  `src/QueryEngine.ts:244-246`;
  `src/utils/config.ts:1625-1638`
- **Finding:** Phase 1 pins only the session-config cwd. The sidecar process inherits Electron
  main's cwd, while engine project identity is initialized and later memoized from the boot cwd
  before `QueryEngine` applies the session cwd.
- **Evidence:** Supervisor spawn has no `cwd` option. `STATE.originalCwd` initializes from
  `process.cwd()`, and `getProjectPathForConfig` memoizes a value derived from it. Passing a cwd
  later into session construction cannot repair this process-boot input.
- **Concrete failure scenario:** A packaged app launched from Finder starts outside the project.
  P2-4 loads permission/trust settings for the wrong project or none, and transcript paths derive
  from the wrong original cwd.
- **Phase-2 impact:** P2-0 is unaffected, but P2-4 must not add project-scoped settings behavior
  until the child process starts in the session cwd.
- **Owner suggestion:** **P2 session/lifecycle**.

### P1-F9 — CONFIRMED · LOW

- **Source workstream:** transport/data flow + isolation/session plane
- **Anchor:** `app/renderer/src/rawMessageLog.ts:25-45`;
  `app/renderer/src/transcriptProjector.ts:37-58`
- **Finding:** Renderer transcript state is not keyed or filtered by the `sessionId` already
  present on every frame.
- **Evidence:** Ready handling overwrites one session id; any event frame appends to one message
  array; `TranscriptState` has no session dimension.
- **Concrete failure scenario:** When Phase 3 attaches a second sidecar, frames can interleave
  into the first session's transcript rather than merely appearing under the wrong tab.
- **Phase-2 impact:** P2-0 should make session identity part of the state boundary now to avoid
  re-plumbing every Phase-2 reducer later.
- **Owner suggestion:** **P2-0 projector**, coordinated with future Phase-3 shell ownership.

## Gate assessment

### Evidence that supports the gate

- The recorded live operator run exercised the defining sequence: connect, real tool emission
  and rendering, real prompt, real permission pause/allow/resume, and successful result.
- Fresh `bun test app/` verification passes **122/122 tests with 295 assertions across 19
  files**. The suite substantively covers framing, a real sidecar process and Unix socket,
  sidecar boundary validation, replay/reducer behavior, and fixture-based raw `tool_use`
  fidelity.
- The isolated desktop graph typechecks, the renderer builds, and the Electron hardening smoke
  proves its focused claims about Node globals, CSP execution blocking, preload keys, and raw
  `ipcRenderer` exposure.
- Current source confirms that the normal sidecar uses the real engine graph and derives tools
  from the same permission context the runtime enforces.

### Evidence that is overstated

- P1-0's security acceptance gate required a crafted Markdown payload through the production
  renderer/navigation path. The 9/9 smoke uses copied policy and custom HTML instead.
- T7 is enforced at the sidecar decoder/read loop, not at the first privileged Electron
  boundary. It does not prevent main/supervisor allocation and serialization and composes into
  P1-F1.
- The test named as a real-socket forged-session rejection sends a valid ping
  (`app/sidecar/roundtrip.probe.test.ts:126-147`). Rejection is genuinely tested, but only in
  the in-memory sidecar test.
- The desktop suite's injected tool event does not prove normal model tool availability; live
  operator evidence currently carries that claim.

### Evidence that is missing

- A production-main, production-renderer Markdown/navigation hardening test.
- A real preload-to-main oversized/rate-limited call and half-close recovery regression.
- Normal-path non-empty tool configuration coverage.
- A usable sidecar typecheck and automated engine-snapshot drift check.
- Byte-budget and truncation semantics for replay/raw retention.

### Findings that affect the gate

P1-F1 and P1-F3 directly affect claimed P1-0 security/boundary acceptance. P1-F2 makes the
failure non-recoverable from the renderer. P1-F5 is a Phase-2 model limitation rather than a
Phase-1 functional-gate failure. P1-F4 and P1-F6 through P1-F9 are carry-forwards that constrain
how Phase 2 may proceed.

## Phase 2 must carry forward

| Carry-forward item | Why it matters | Owner Phase-2 session | Source finding |
| ------------------ | -------------- | --------------------- | -------------- |
| Reject oversized input before framing; handle half-close; expose recovery | Prevents a normal paste from permanently zombifying a ready session | P2 transport/session addressing, before broad P2 work | P1-F1 |
| Deliver non-ready session status to renderer state | Prevents permanent transcript/activity/permission hangs | P2 session/lifecycle | P1-F2 |
| Restrict dev navigation to the renderer entry path | Same-origin non-entry content must not inherit the preload bridge | P2 security/hardening, before dev dogfooding | P1-F3 |
| Add production-main + real-renderer Markdown/navigation hardening coverage | The current surrogate cannot support the P1 security gate claim | P2 security/hardening, before P2-1 rich Markdown | P1-F3 |
| Add byte budgets and an explicit replay-truncation boundary | Prevents excessive retention and makes orphaned correlation inputs honest | P2-0 projector + P2 transport/session addressing, before P2-2 | P1-F4 |
| Retain stable message/block identity and use realistic ordered fixtures | Required for grouping, streaming reconciliation, and multi-tool correctness | P2-0 projector, first task | P1-F5 |
| Automate snapshot drift and create a usable sidecar static check | P2-0 and P2-4 otherwise edit against silent or permanently red type evidence | P2 build/test hygiene; P2-0 then before P2-4 | P1-F6 |
| Assert normal-path model tool exposure | Prevents recurrence of the live `tools: []` failure | P2-0 projector / P2 build-test hygiene | P1-F7 |
| Start the sidecar process in the session cwd | Project settings, trust, and transcript identity derive from boot cwd | P2 session/lifecycle, before P2-4 project settings | P1-F8 |
| Key/filter transcript state by session id | Avoids a Phase-3 rewrite and wrong-session content interleaving | P2-0 projector | P1-F9 |

## Build and test summary

| Check | Result | Meaning |
| ----- | ------ | ------- |
| `bun test app/` | **PASS — 122 tests, 0 failures, 295 assertions, 19 files** | Strong coverage of framing, sidecar boundary behavior, pure main logic, reducers, components, and an injected raw event over a real sidecar/socket. It does not run a credentialed model turn. |
| `bunx tsc --noEmit -p app/tsconfig.json` | **PASS** | Electron main/preload/supervisor/shared/renderer compile against the isolated engine snapshot. It does not cover sidecar runtime source or snapshot freshness. |
| `bun run --cwd app renderer:build` | **PASS — 197 modules, CSS 8.25 kB** | The renderer and Tailwind pipeline build successfully. |
| `bun run --cwd app test:hardening` | **PASS — 9/9** | Focused Electron checks for Node-global isolation, copied CSP behavior, exact preload exposure, and no raw `ipcRenderer`; not production-main/Markdown coverage. |
| `bunx tsc --noEmit -p app/sidecar/tsconfig.json` | **FAIL — 5,642 errors** | Known and accurately disclosed, but not a usable static gate for the trust-boundary code P2-4 will edit. |
| `bun run --cwd app test` | **FAIL — filter matches no tests** | The package-local script resolves `app/` from the `app` cwd. The proven command remains repo-root `bun test app/`; this is a loud hygiene defect, not a hidden false green. |
| Root ESLint coverage for `app/**` | **Not covered by configuration** | Known/scoped to later CI work; clean root lint cannot be used as desktop evidence. |
| Live P1-2/P1-3/P1-4 GUI sequence | **Recorded operator pass; not re-run in this synthesis** | Supplies the real credentialed turn, normal model tool emission, rendered tool card, and permission round-trip that fixture tests cannot prove. |

## Workstream summary

| Workstream | Verdict | Main risk |
| ---------- | ------- | --------- |
| Transport/data flow | Functional seam cleared; pre-P2 hardening required | Oversized inbound frames can leave a dead session reporting ready; lifecycle failures are invisible |
| Isolation/session plane | Phase-1 N-process shape is real; carry-forwards required | Boot cwd and session cwd diverge; lifecycle events do not reach the UI |
| Projector/adapter fidelity | Phase-1 slice cleared; Phase-2 row model is not ready | Source identity is discarded and fixtures do not match real per-block assistant frames |
| Build/test integrity | Functional evidence is mostly accurate | Sidecar has no effective typecheck; normal tools and snapshot freshness are not regression-locked |
| Security baseline | **Did not honestly clear its full P1-0 acceptance evidence** | Limits are late, dev navigation is too broad, and the passing smoke is a surrogate |

## Final recommendation

Phase 2 may start only in a constrained sense:

- **Proceed with P2-0 now.** Its first work must be stable source/session identity, realistic
  ordered event fixtures, snapshot-drift enforcement, and the normal tool-list regression.
- **Fix P1-F1 first, before broad Phase-2 dogfooding or dependent feature work.** Pair it with
  P1-F2 so failure becomes visible and recoverable.
- **Fix the dev navigation portion of P1-F3 before routine dev rendering work.** Add the
  production-path hardening test before P2-1 lands rich Markdown/tool-output behavior.
- **Carry P1-F4, P1-F6, and P1-F8 to their named entry points rather than blocking P2-0:**
  byte retention before P2-2, usable sidecar checking and correct process cwd before P2-4.
- **Do not treat the existing Phase-1 status rows as false functional evidence.** The walking
  skeleton ran. The correction is narrower and important: its security/boundary acceptance was
  certified more broadly than the evidence supports.

The only whole-Phase-2 blocker is P1-F1. P1-F3 blocks development dogfooding and P2-1 rich
rendering until its relevant parts land. P2-0 projector work should proceed with the constraints
above.
