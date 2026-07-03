# Phase-1 transport shape & data-flow review — 2026-07-03

**Scope:** the transport shape and data flow across `app/shared/`, `app/sidecar/`,
`app/supervisor/`, `app/main/` (plus the renderer edge where sessionId/data-flow claims required
it). Normal correctness, architecture, Phase-2 readiness. NOT a security review.

**Method:** every file in scope read in full; every line anchor below re-checked against the
working tree this session; `bun test app/` re-run; both app tsconfigs re-run; two runnable
probes written and executed in a session scratchpad (not committed, reproduced inline below)
to settle the one composed failure that code reading alone could not. Orientation set:
STATUS.md P1-0..P1-4, `decisions/TRANSPORT.md`, `decisions/PROTOCOL-ENVELOPE.md`,
PROGRAM-PLAN §4/§5 + the Phase-1 gate, `reviews/2026-07-02-phase0-review.md` (F3),
`reviews/2026-07-02-direction-review.md`, `docs/reviews/2026-07-02-p1-0-desktop-scaffold-review.md`
(the F1–F16 the code comments cite).

---

## 1. Workstream verdict

**Phase 1 honestly cleared its gate.** The gate was "the seam walks": connect → one real
`tool_use` rendered → one real prompt → one real permission round-trip. Every checkable claim
behind that checked out this session:

- `bun test app/` → **122 pass / 0 fail / 295 expects across 19 files** — exactly the number
  STATUS claims (P2-4 note).
- The raw-fidelity contract is real, not aspirational: no `appSessionEventMapper` /
  `AppSessionWebSocketServer` runtime import exists anywhere in `app/` (grep: comments only);
  the outbound path clones (`structuredClone`), canonicalizes `key:undefined`, JSON-safe-asserts,
  and secret-scans every event frame ([sidecarServer.ts:512-560](../../../app/sidecar/sidecarServer.ts),
  `send()` :562-604), matching TRANSPORT §2/§4 and Landmines 1+2.
- The round-trip is proven by a test that spawns a **real Bun sidecar via the real supervisor
  over a real Unix socket** and asserts the `tool_use` block arrives with name + structured
  input intact ([roundtrip.probe.test.ts:85-124](../../../app/sidecar/roundtrip.probe.test.ts)) —
  the P0-1 deleted-spike lesson (PHASE0-REVIEW F6) was absorbed: the evidence is committed,
  re-runnable code this time.
- The one red typecheck (`tsc -p app/sidecar/tsconfig.json`) is disclosed in STATUS P1-3 as a
  carry-forward, and re-running it reproduces exactly the documented failure class (`MACRO`
  unresolved + strict overlay on the engine graph). Not overstated.

**But the transport ships with two operational holes the gate did not claim to cover and no doc
currently names** (findings 1 and 2): a normal-use oversized paste **permanently zombifies the
session while it still reports `ready`** (live-reproduced this session), and **sidecar death is
completely invisible to the renderer** (supervisor status/exit events are dropped at main's
bridge). Neither invalidates the Phase-1 gate — a walking skeleton walked — but both sit exactly
on the path Phase-2 dogfooding exercises daily, and finding 1 quietly falsifies one premise of
the F3 envelope audit (E-2's "a dead-session send throws at the supervisor" — in the zombie
state it doesn't throw; it silently succeeds).

**F3 carry-forward (PHASE0-REVIEW → P1): RESOLVED at the addressing level, by construction —
verified live code, not a dead slot; the control-plane half remains open and tracked.**
- Every frame in both directions carries `sessionId` ([protocol.ts:59-122](../../../app/shared/protocol.ts)).
- Inbound addressing **executes on every renderer action today**: renderer supplies the id from
  the ready frame on every bridge call ([App.tsx:63-98](../../../app/renderer/src/App.tsx),
  [rawMessageLog.ts:25-32](../../../app/renderer/src/rawMessageLog.ts)) → main forwards by id
  ([main.ts:209-248](../../../app/main/main.ts)) → supervisor routes via
  `Map<SessionId, SidecarRecord>` ([supervisor.ts:81, :207-218](../../../app/supervisor/supervisor.ts))
  → sidecar self-checks the address and rejects a mismatch fail-closed
  ([sidecarServer.ts:198-209](../../../app/sidecar/sidecarServer.ts)).
- The outbound slot is stamped but unread (identity rides the connection) — accurately
  documented as a Phase-3 tripwire in PROTOCOL-ENVELOPE §2.
- The remaining F3 halves — supervisor/control-plane trust zone (DR-4) and the engine-session-id
  bridge (E-5) — are **documented-open with owners** in PROTOCOL-ENVELOPE §6/§9, not silently
  dropped. I independently re-verified the envelope audit's E-1..E-7 anchors and verdicts; all
  hold **except the E-2 premise amended by finding 1 below**.

---

## 2. Findings

### F-1 — An oversized inbound frame permanently zombifies the session, which keeps reporting `ready`
**CONFIRMED (live-reproduced) · HIGH**
- **Anchors:** [app/renderer/src/App.tsx:60-70](../../../app/renderer/src/App.tsx) (no prompt cap),
  [app/main/main.ts:209-217](../../../app/main/main.ts) (type-checks only),
  [app/supervisor/supervisor.ts:207-218](../../../app/supervisor/supervisor.ts) (encodes without a size check),
  [app/sidecar/sidecarServer.ts:143-149](../../../app/sidecar/sidecarServer.ts) (decode error → error frame + `socket.end()`),
  [app/supervisor/supervisor.ts:320-331](../../../app/supervisor/supervisor.ts) (`close` is the ONLY disconnect signal; no `end` handler).
- **What happens (all four links verified, then composed live):** nothing above the sidecar
  enforces the 128 KiB inbound frame cap, and the sidecar's graceful 96 KiB `MAX_PROMPT_BYTES`
  check ([sidecarServer.ts:288-297](../../../app/sidecar/sidecarServer.ts)) sits *below* the
  frame decoder, so it never fires for this case. A prompt > ~128 KiB reaches the sidecar's
  `FrameDecoder`, which rejects the declared length ([framing.ts:50-57](../../../app/shared/framing.ts));
  the sidecar sends one `bad_request` ("frame length … exceeds max 131072") and half-closes.
  Because the client (supervisor) still has most of the oversized write in flight, Node's
  `close` event **never fires** — the socket hangs half-open. Reproduced twice this session:
  once end-to-end (real supervisor + real sidecar: after the oversized submit, status stayed
  `ready` for 10s+, a subsequent `send()` was **accepted** and silently written into the dead
  socket, `listSessions()` reported `ready` at exit) and once in isolation (a Bun
  `Bun.listen`/unix server calling `end()` mid-inbound-stream leaves the `node:net` client with
  `end` received but no `close`, indefinitely). Contrast case verified in the same probe: a
  100 KiB prompt (over the prompt cap, under the frame cap) is rejected gracefully and the
  connection stays live — the design intent works for that band only.
- **Concrete Phase-2 failure scenario:** operator pastes a large log/diff (> 128 KiB) into the
  prompt box during normal dogfooding. One error line flashes; from then on every submit,
  abort, and **permission response** is silently swallowed. No status change, no error, no
  recovery path — `restartSession` exists but has zero callers ([supervisor.ts:231-243](../../../app/supervisor/supervisor.ts));
  only an app restart recovers. A pending permission prompt at that moment is undismissable.
- **Why it matters for Phase 2:** this is the transport Phase 2 builds the transcript spine and
  the Permissions domain on. It also breaks the planned Phase-3 fix as spec'd: PROTOCOL-ENVELOPE
  §3's `session_not_found` synthesis triggers on a **thrown** forward — in the zombie state
  `record.status === 'ready'`, so `send()` doesn't throw and the synthesized error never fires.
  The fix needs three small parts: (a) a prompt/frame size check at or above main (graceful
  reject before framing), (b) an `end` handler in the supervisor marking `disconnected` on
  half-close, (c) any recovery policy at all (even "offer restart").

### F-2 — Sidecar death/disconnect is invisible to the renderer
**CONFIRMED · MEDIUM**
- **Anchors:** [app/main/main.ts:193-198](../../../app/main/main.ts) — `wireRendererBridge`
  filters `event.type !== 'frame'`, so the supervisor's `status` and `exit` events
  ([supervisor.ts:75-78](../../../app/supervisor/supervisor.ts)) are consumed nowhere (the only
  other subscriber is the smoke hook). [main.ts:258-274](../../../app/main/main.ts) — a failed
  forward logs to stderr; the renderer receives nothing.
- **Failure scenario:** the sidecar crashes (or F-1 fires). The renderer keeps `inputEnabled`,
  keeps any pending permission prompt on screen forever (`permission.resolved` can never
  arrive), and every subsequent action disappears without acknowledgment. The user cannot
  distinguish "engine is thinking" from "engine has been dead for ten minutes."
- **Phase-2 impact:** P2-4's `PermissionQueue` inherits an unavoidable hang state; P2-3's
  activity engine can show a permanent spinner. PROTOCOL-ENVELOPE §3 owns the wire-level fix
  (`session_not_found`) for Phase 3, but crash reachability is *now*, and the minimal Phase-2
  mitigation (forward `status`/`exit` to the renderer, or at least dismiss pendings + disable
  input on non-`ready` status) is a few lines of main/bridge plumbing. Note the interaction
  with F-1: the envelope's planned fix assumes the throw path, so the status-event route is the
  one that covers both.

### F-3 — The replay ring truncates silently; a reload can rebuild an incomplete transcript with no marker
**CONFIRMED (behavior unit-tested; scenario projected) · MEDIUM**
- **Anchors:** [app/main/replayBuffer.ts:49-52](../../../app/main/replayBuffer.ts) (oldest
  non-ready frames evicted at 512), [replayBuffer.ts:60-67](../../../app/main/replayBuffer.ts)
  (`snapshot()` carries no truncation indicator),
  [attachmentGate.ts:48-52](../../../app/main/attachmentGate.ts) (replay is the ONLY renderer
  catch-up path).
- **Failure scenario:** P1-2 measured 13 `stream_event` partials for one short reply; a long
  multi-tool turn is thousands of frames. Renderer reload (or window reopen mid-session) →
  replay = stale ready head + last ≤512 frames. Early `assistant` frames carrying `tool_use`
  blocks are evicted while later `user` frames carrying the matching `tool_result` survive.
- **Phase-2 impact:** P2-2's `tool_use`↔`tool_result` correlation will see **orphaned
  tool_results** and must treat them as a normal input, not an invariant violation; the
  transcript is silently shorter than reality with no "history truncated" row. Either the
  buffer gets a truncation marker (cheap) or P2-0's projector contract explicitly documents
  replay-after-eviction as lossy and renders a boundary row. (Full fidelity after restart is
  Phase-3 registry/resume territory — `REGISTRY.md` — not Phase 2's problem; in-window reload
  IS Phase 2's problem.)

### F-4 — The supervisor's lifecycle edges are fix-by-code-review: zero direct tests, and `restartSession` has zero callers
**CONFIRMED · MEDIUM**
- **Anchors:** no `app/supervisor/*.test.ts` exists. The P1-0 review's F7 (spawn error), F11
  (stale exit), F12 (connect timeout), F13 (socket-close status) fixes are all present in
  [supervisor.ts:174-190, :267-331](../../../app/supervisor/supervisor.ts) but exercised by no
  test; `bun test app/` touches the supervisor only via the roundtrip probe's happy path
  (spawn → connect → send → shutdown). `restartSession` ([supervisor.ts:231-243](../../../app/supervisor/supervisor.ts))
  is called by nothing in `app/` (grep: definition only).
- **Failure scenario:** any refactor of the supervisor (Phase-3 will refactor it heavily —
  registry, eviction, engineSessionId) can silently regress F11/F12/F13; the F13 gap that F-1
  exposed (no `end` handler) is exactly the class a lifecycle test suite would have caught.
- **Phase-2 impact:** low direct impact (Phase 2 doesn't touch the supervisor), but Phase-3
  backlog generation should inherit "supervisor lifecycle tests before lifecycle UI" as a
  named session item, and F-1's fix needs a regression test here anyway. The P1-0 review's
  §6.2 coverage-gap list remains open almost verbatim.

### F-5 — The ready frame bypasses the outbound clone/canonicalize/JSON-safe pipeline events go through
**CONFIRMED · LOW**
- **Anchors:** [app/sidecar/sidecarServer.ts:118-131](../../../app/sidecar/sidecarServer.ts) —
  `addConnection` builds the ready frame from live controller state (`getGoalSnapshot()`,
  `getPendingPermissionRequests()` — aliased engine objects, not clones) and hands it straight
  to `send()`; only the secret guard applies. `broadcastEvent`
  ([:512-560](../../../app/sidecar/sidecarServer.ts)) applies `structuredClone` +
  `omitUndefinedObjectProperties` + `checkJsonSafe` first.
- **Failure scenario:** none live today — the embedded state is engine-minted POJOs, and
  `encodeFrame` stringifies synchronously so aliasing can't tear. The defect is contract
  inconsistency: TRANSPORT §4.1's "JSON-safe assertion at the sidecar serializer" is
  implemented for one of the two outbound paths.
- **Phase-2 impact:** precedent. P2-4 adds a third sidecar-authored outbound frame
  (`permission.context`, PERMISSION-BOUNDARY C3) that embeds exactly this kind of live engine
  state; if it copies the ready-frame pattern the guard hole widens. Cheapest fix: route all
  outbound payload-bearing frames through one guarded serialize function.

### F-6 — The replayed ready head is point-in-time state served as if current
**CONFIRMED · LOW**
- **Anchors:** [app/main/replayBuffer.ts:39-53](../../../app/main/replayBuffer.ts) — the ready
  frame recorded at *sidecar attach* is kept as a permanent head and replayed on every renderer
  attach; the supervisor↔sidecar socket persists across renderer reloads, so no fresh ready is
  ever minted. [rawMessageLog.ts:25-32](../../../app/renderer/src/rawMessageLog.ts) — the
  renderer derives `inputEnabled` from it and nothing ever updates that flag afterward.
- **Failure scenario:** reload mid-turn → replayed ready says `inputEnabled:true,
  activeTurn:false`; the user submits, gets a `turn_already_running` error frame. Recoverable
  and cosmetic today. (`pendingPermissionRequests` staleness is compensated: the
  requested/resolved *events* in the ring reconstruct queue state,
  [permissionState.ts:49-83](../../../app/renderer/src/permissionState.ts).)
- **Phase-2 impact:** P2-3 must derive turn/activity state from the stream (`result` as the
  only turn-end marker, per the S1 spec) and treat the ready payload as attach-time bootstrap
  only. It already plans to; this finding pins *why* the ready payload must not be trusted as
  live state. A cleaner later fix is sidecar-side: re-emit a fresh ready per attach *of a
  client*, but with a persistent supervisor connection that hook doesn't exist — fine to defer.

### F-7 — Renderer state is keyed by nothing: `frame.sessionId` is verified inbound, ignored outbound-to-renderer
**CONFIRMED · LOW (documented as ENVELOPE E-6; restated here because Phase 2 deepens it)**
- **Anchors:** [rawMessageLog.ts:41-46](../../../app/renderer/src/rawMessageLog.ts) appends any
  event frame's message regardless of `frame.sessionId`; ready handling is last-writer-wins on
  `sessionId`; [transcriptProjector.ts:50-69](../../../app/renderer/src/transcriptProjector.ts)
  and `permissionState.ts` have no session dimension at all.
- **Failure scenario:** none at N=1 (main's `attachmentGate.reset()` on window-all-closed,
  [main.ts:396-410](../../../app/main/main.ts), prevents dead-session replay into a fresh
  window). The risk is structural: every Phase-2 session builds more single-session renderer
  state, and Phase 3 then pays a projector/store refactor the envelope already paid to avoid.
- **Phase-2 impact:** P2-0 should key `TranscriptState` (and the permission queue) by
  `frame.sessionId` from the start — the field is delivered on every frame; the cost now is a
  Map wrapper, the cost later is re-plumbing every reducer Phase 2 wrote.

### F-8 — One test name still overstates (carried unfixed from the P1-0 review)
**CONFIRMED · LOW**
- **Anchor:** [roundtrip.probe.test.ts:126-147](../../../app/sidecar/roundtrip.probe.test.ts)
  — "a forged sessionId frame is rejected at the sidecar boundary" actually sends a *valid*
  ping and asserts the happy-path pong (its own comment admits it). The real forged-envelope
  rejection is covered, but only at unit level
  ([sidecarServer.test.ts:134](../../../app/sidecar/sidecarServer.test.ts)).
- **Phase-2 impact:** none functionally; test-suite honesty. The P1-0 review §6.2 flagged this
  exact name and it survived four sessions. Rename it or make it actually write a forged frame
  to the socket.

### F-9 — Hygiene (no behavior change today)
**CONFIRMED · LOW**
- `primarySessionId` is write-only dead state ([main.ts:46, :353, :402](../../../app/main/main.ts)) —
  the renderer learns its id from the ready frame instead. Delete or use it.
- `sanitizePermissionResponse`'s `toolUseID` passthrough ([sidecarServer.ts:504](../../../app/sidecar/sidecarServer.ts))
  is unreachable: `checkStrictKeys` rejects the key upstream ([:678-683](../../../app/sidecar/sidecarServer.ts)).
  Dead branch; will confuse the P2-4 implementer about what the wire actually allows.
- `cryptoRandomId` ([main.ts:339-341](../../../app/main/main.ts)) is `Math.random` — fine for a
  correlation id, misleading name.

### F-10 — Snapshot-type drift is still unenforced, and the one typecheck that could catch it is the red one
**CONFIRMED · MEDIUM (pre-existing DR-6, sharpened)**
- **Anchors:** `@cat-code/engine/*` resolves to hand-copied snapshots for every non-sidecar
  process ([app/tsconfig.json paths](../../../app/tsconfig.json) →
  `shared/engine-types.snapshot.d.ts`); no drift-check script exists anywhere (grep of
  `app/scripts/`, `scripts/`); the snapshots are untouched since the P1-0 commit (`3decd20`).
  The sidecar is the only process typed against the *real* engine graph — and
  `tsc -p app/sidecar/tsconfig.json` is red with ~5.7k pre-existing errors (verified this
  session), so a genuine protocol/shape drift error would drown invisibly.
- **Phase-2 failure scenario:** P2-0's whole deliverable is an *exhaustive* fixture over the
  `SDKMessage` union "typed against truth." A new engine variant added after the pin doesn't
  exist in the snapshot; the exhaustive switch stays green while being incomplete — precisely
  the failure §5 exists to prevent.
- **Phase-2 impact:** the drift check (diff snapshot vs `coreTypes.generated.ts` at the pin;
  fail on mismatch) should be P2-0's step 0, per DR-6's ten-minute estimate.

---

## 3. Carry-forward table

| # | Item | Reason | Suggested owner | Source |
|---|---|---|---|---|
| 1 | Inbound size cap above the sidecar (graceful reject at renderer or main, under `MAX_FRAME_BYTES`) | Oversized paste must degrade to an error, not a dead session | **Pre-P2 hardening fix** (small; touches main/renderer only) | F-1 |
| 2 | Supervisor `end`/half-close handler → `disconnected`; regression test | `close`-only detection misses the reproduced zombie state | Pre-P2 hardening fix (same patch as #1) | F-1 |
| 3 | Any session recovery path (surface `restartSession`, or offer restart on non-`ready`) | `restartSession` has zero callers; only app restart recovers today | Phase-3 lifecycle (unless #1/#2 land without it — then a stopgap "session dead, restart app" notice) | F-1 |
| 4 | Forward supervisor `status`/`exit` to the renderer (or synthesize an error frame); dismiss pendings + disable input on non-`ready` | Dead engine is indistinguishable from a thinking engine; P2-4 queue hangs | **P2-4** (minimal renderer handling) + Phase-3 (`session_not_found`, ENVELOPE §3 — amended: must also cover the non-throwing zombie path) | F-2, F-1 |
| 5 | Replay truncation marker, or documented-lossy replay contract + orphan-`tool_result` tolerance in correlation | Silent transcript truncation on reload | **P2-0 / P2-2** | F-3 |
| 6 | Supervisor lifecycle unit tests (spawn-error, stale exit, timeout, disconnect, restart) | F7/F11/F12/F13 fixes are code-review-verified only | Phase-3 backlog item, named | F-4 |
| 7 | One guarded outbound serialize path (ready + events + future `permission.context`) | Ready frame bypasses clone/JSON-safe today; C3 will copy the pattern | **P2-4** (when C3 lands) | F-5 |
| 8 | Turn/activity state derived from the stream only; ready payload = bootstrap | Replayed ready head is stale point-in-time state | **P2-3** (already its plan; pin it in the session brief) | F-6 |
| 9 | Key renderer stores by `frame.sessionId` from P2-0 onward | Every Phase-2 reducer written single-session is Phase-3 rework | **P2-0** | F-7, ENVELOPE E-6 |
| 10 | Snapshot drift-check script (fail on snapshot vs `coreTypes.generated.ts` mismatch) | P2-0 exhaustiveness is only as true as the snapshot; no enforcement exists | **P2-0 step 0** | F-10, DR-6 |
| 11 | ENVELOPE §6 additive items (`engineSessionId`, `session_not_found`, outbound tripwire, ready-version check, buffer eviction, spawn-config/`P1_1_CWD`) | Already decided + owned; listed for completeness | Phase-3 (per PROTOCOL-ENVELOPE) | ENVELOPE §6 |
| 12 | Rename or realize the "forged sessionId" probe test | Test-suite honesty; flagged twice now | Any P2 session touching `app/sidecar` | F-8 |

---

## 4. Test evidence

**Ran this session:**
- `bun test app/` → **122 pass / 0 fail / 295 expect() across 19 files** (matches STATUS's P2-4
  count exactly; the P1-0-era "25 pass" and P1-3-era "107 pass" figures are consistent history,
  not conflicting claims).
- `bunx tsc --noEmit -p app/tsconfig.json` → clean.
  `bunx tsc --noEmit -p app/sidecar/tsconfig.json` → red with the documented pre-existing
  failure class (`MACRO` unresolved, strict overlay on the engine graph) — STATUS P1-3's
  disclosure is accurate.
- **Scratchpad probe 1** (real `SidecarSupervisor` + real Bun sidecar, fixture controller):
  100 KiB prompt → graceful `bad_request "prompt exceeds 98304 bytes"`, connection stays live
  (pong verified). 200 KiB prompt → `bad_request "frame length 204914 exceeds max 131072"`,
  then **no `disconnected` within 10s, post-failure `send()` accepted, `listSessions()` reports
  `ready`** — the F-1 zombie.
- **Scratchpad probe 2** (isolation): Bun `Bun.listen`-unix server calling `socket.end()` while
  a `node:net` client still has ~190 KiB in flight → client receives `end` but **`close` never
  fires**; the plain small-write control case closes normally. This isolates F-1's mechanism to
  the half-close-with-inbound-backlog case, i.e. exactly the oversized-frame rejection path.

**Read (what the committed tests actually prove):**
- `sidecarServer.test.ts` (28 tests) — the strongest suite in scope: drives a **real
  `AppSessionController`** (the exact class the live sidecar wraps) with fixture adapters
  through the real server. Proves: envelope version/address rejection, strict-key allowlist
  (incl. prototype-name types, host-only escalations `deny.interrupt`/`updatedPermissions`),
  T4 goalSnapshot validation, T5a unknown-requestId, T6 echo-only incl. the F1
  gated-input-forwarding semantics, T6b strip + C1 suggestion-selection (8 cases incl.
  cross-request resolution), F6 secret blocking on events AND ready, and undefined-field
  canonicalization on the raw-forward path.
- `roundtrip.probe.test.ts` (3 tests) — real supervisor, real spawned Bun sidecar, real Unix
  socket. Two of the three run the **real engine bootstrap** (`initializeSidecarRuntime` →
  `init()`) headlessly and prove a real runtime-backed session constructs and emits a canonical
  ready with no fixture event. The `tool_use` round-trip test is the committed replacement for
  the deleted P0-1 spike evidence. Caveat: F-8 (one test name overstates).
- `framing.test.ts` / `jsonSafe.test.ts` / `secretGuard.test.ts` — the codec + both outbound
  guards, including the fail-closed edges (fatal UTF-8, −0, symbol keys, depth-limit
  fail-closed).
- `attachmentGate.test.ts` / `replayBuffer.test.ts` — the F2 replay machinery in isolation,
  including StrictMode double-signal, reload re-arm, ring-cap eviction, per-session buffers.
- `mainSource.test.ts` — a source-text grep (probe flag absent from `createSupervisor`), not
  behavior.
- `scripts/f2-attach-smoke.ts` — a real-Electron harness for the main→preload→renderer hop
  using the production `AttachmentGate`; exists and is well-constructed, but it is **not part
  of `bun test app/`** and its last run is not verifiable from the tree.

**What the evidence does NOT prove:**
- **No live Electron/renderer hop runs in CI-style verification** — the renderer↔main leg
  rests on the f2 smoke script (run status unverifiable) and the operator's live P1-3/P1-4 runs
  (which I cannot re-verify headlessly; the 🖐 GUI stamps in STATUS are the honest record of
  that).
- **The supervisor's failure modes are untested** (F-4): nothing exercises spawn error, connect
  timeout, socket loss, stale exits, or restart.
- **`main.ts`'s logic is effectively untested**: `coercePermissionResponse` (pure, easily
  testable, security-adjacent) and the IPC handler shape-checks have no unit tests;
  `mainSource.test.ts` greps text.
- **No two-sidecar run has ever happened** (ENVELOPE §8-A5's own admission stands): every
  N-shaped claim (registry map, per-session buffers, zero-line Nth-session addition) is
  code-shape fact, not runtime-proven. Phase 3's first session should still be the two-sidecar
  smoke the envelope doc prescribes.
- **No live credentialed turn runs in the committed suite** — P1-2/P1-3/P1-4's live turns were
  operator-verified one-offs; the suite's engine coverage stops at bootstrap + session
  construction. Acceptable for a walking skeleton; worth converting the cheapest live check
  into a gated script during Phase 2 (same lesson as F6/P0-1).

---

*Reviewed cold against the `migration` working tree on 2026-07-03 (HEAD `f5ab1e6` + uncommitted
doc changes; `app/` itself has no uncommitted changes). No file outside this review was
modified. Scratchpad probes were run from the session scratchpad and are reproduced inline
above; they are not committed.*
