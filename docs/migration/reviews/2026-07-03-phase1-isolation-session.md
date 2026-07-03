# Phase-1 workstream review — isolation & session plane — 2026-07-03

**Scope:** the process and session plane of Phase 1 as built: `app/supervisor/`, `app/sidecar/`,
and the shared protocol files both sides speak (`app/shared/protocol.ts`, `framing.ts`,
`limits.ts`), plus `app/main/main.ts` where it is the supervisor's client (routing, lifecycle,
replay). Reviewed against STATUS P1-0…P1-4, `decisions/TRANSPORT.md`, PROGRAM-PLAN §5 + the
Phase-1 gate, the 2026-07-02 phase-0 and direction reviews, and the three Phase-3 pre-work
decisions (`PROTOCOL-ENVELOPE.md`, `SESSION-LIFETIME.md`, `REGISTRY.md`). Not a security review;
no adversarial testing. No app code or plan docs changed — this file is the only output.

**Verification ledger (ran, not just read):**
- `bun test app/` → **122 pass / 0 fail** (19 files, 295 assertions) — matches the STATUS claim exactly.
- `bun test src/codex-core/accountRefreshContention.probe.test.ts` → **2 pass / 0 fail** (21 assertions) — the DR-2 two-real-process contention probe is green as claimed.
- `bunx tsc --noEmit -p app/sidecar/tsconfig.json` → **5,642 errors** — the P1-3 "≈5.7k, red independent of this work" disclosure is accurate.
- Grep-verified: zero `electron` imports anywhere in `app/supervisor/` and `app/sidecar/` (comments only); zero `cwd` option on the supervisor's `spawn`.
- Re-verified every line anchor cited below against the working tree; also spot-checked the anchors the three pre-work decision docs cite into `app/` — all matched (`supervisor.ts:81/:128/:154/:207-218/:221/:231/:267-289`, `sidecarServer.ts:182-195/:198-209`, `main.ts:209-248/:258-274/:396-414`, `replayBuffer.ts:33-53`, `attachmentGate.ts:48-52/:60-63`, `sessionController.ts:14`).

---

## 1. Workstream verdict

**Phase 1 honestly cleared its gate on this plane. Not a Potemkin pass.** The claims that
matter were re-verified rather than taken on faith:

- **The supervisor is genuinely Electron-free.** `app/supervisor/supervisor.ts` imports only
  node builtins plus one `import type` from `@cat-code/engine/session-events` — which
  `app/tsconfig.json` aliases to the type-only snapshot (`shared/engine-types.snapshot.d.ts`)
  and `verbatimModuleSyntax` erases at runtime. DR-1 pin 2 held in code, not just in prose.
- **Session ownership is real, not a reserved slot.** Everything is keyed by
  `Map<SessionId, SidecarRecord>` (`supervisor.ts:81`): spawn (`:128`), kill (`:221`),
  restart (`:231`), send-routing (`:207-218`), and every emitted event carries the record's
  sessionId derived from the connection (`:308-313`). The sidecar self-checks its address and
  rejects mis-addressed frames fail-closed (`sidecarServer.ts:198-209`). PHASE0-REVIEW F3's
  "session addressing exists nowhere" is fully retired; `PROTOCOL-ENVELOPE.md`'s
  "live code, not a dead slot" verdict is correct as written.
- **DR-1 (lifetime) held.** Transport is a filesystem socket (`supervisor.ts:136,293`;
  `app/sidecar/index.ts:76-77`); die-with-window is achieved by `supervisor.shutdown()` calls
  from main (`main.ts:396-414`), not by parent-bound pipes. `SESSION-LIFETIME.md`'s semantics
  matrix matches the code at every anchor I checked.
- **DR-2 (cross-process shared state) is fixed and proven** — I re-ran the two-real-process
  refresh-contention probe, 2/2 green. (Caveat: the fix + probe + all three pre-work decision
  docs are **uncommitted worktree state** — finding IS-8.)
- **The sidecar imports the real engine graph as claimed.** `sessionController.ts` builds
  `createRuntimeBackedWebAppSession` over real `src/` modules (incl. `getTools` from the same
  `toolPermissionContext` the runtime enforces — the P1-3 fix); `initializeRuntime.ts` runs the
  real `init()`. This is exercised for real: the roundtrip probe spawns an actual sidecar that
  completes engine init before binding its socket, and `initializeRuntime.test.ts` proves config
  reads work in a real Bun child.
- **STATUS's P1 rows are not overstated.** Where evidence is operator testimony (P1-2/3/4 live
  turns) the rows say so via the 🖐 GUI tag; where something is broken (sidecar tsc, hardcoded
  cwd) the rows disclose it, and the disclosures are numerically accurate.

What keeps this from being a clean bill: the review found **one real containment gap in the
P1-1 cwd story (IS-1** — the documented hardcode pins only one of *two* cwd inputs; the second
is memoized process state that the planned Phase-3 fix as written would not repair**)**, and
**a lifecycle observability hole (IS-2/IS-3)** that will bite the first time a sidecar dies
during Phase-2 dogfooding and that quietly contradicts one wiring assumption in `REGISTRY.md`
§6. Nothing blocks Phase 2; two findings reshape items Phase 2/3 already own.

---

## 2. Findings

### IS-1 — The P1-1 hardcoded cwd is only HALF the cwd story; the other half is unpinned, memoized process state — **CONFIRMED · MEDIUM**

- **Anchors:** `app/sidecar/sessionController.ts:14,45` (`P1_1_CWD` → session config);
  `app/supervisor/supervisor.ts:148-156` (spawn passes env but **no `cwd` option** — the
  sidecar inherits Electron main's working directory); `src/bootstrap/state.ts:274-283`
  (`STATE.cwd` **and** `STATE.originalCwd` initialize from `process.cwd()` at module load);
  `src/QueryEngine.ts:245` (`setCwd(cwd)` runs only per-submit — nothing corrects the globals
  before the first turn); `src/utils/config.ts:1626-1638` (`getProjectPathForConfig` is
  **memoized** and derives from `getOriginalCwd()` — so `setCwd` can never fix it) and
  `:751-758` (trust acceptance is looked up by that key); `src/bootstrap/state.ts:452,469`
  (transcript paths also derive from `originalCwd`).
- **What's actually true:** the flagged hardcode pins the *session config* cwd (what tools run
  against once a turn starts). But the engine has a second cwd input — the process's boot cwd —
  which keys project identity: trust-dialog state, project-scope config, and the default
  transcript directory. In every Phase-1 evidence run, Electron was dev-launched from the repo
  root, so both inputs happened to equal `/Users/pt/cat-code` and the split was invisible.
- **Concrete Phase-2 failure scenario:** P2-4 is chartered to fix "sidecar session loads NO
  settings rules" (PERMISSION-BOUNDARY §8). The moment it loads real project-scope settings or
  consults trust, those reads key off the memoized boot cwd. Launch the packaged app from
  Finder (cwd `/`) and the session gets the wrong project's rules — or none — plus transcripts
  filed under a `/`-derived project dir that the TUI's session tooling will never find. Worse,
  `REGISTRY.md` §7.2's planned retirement of `P1_1_CWD` ("hand cwd to the sidecar via env →
  session construction") **would not fix this**: by the time session construction reads an env
  var, the engine module graph has already loaded and memoized project identity off
  `process.cwd()`.
- **Why it matters for Phase 2/3:** the fix is one line *if made in the right place* — the
  supervisor's `spawn` should set the child's `cwd` to the session cwd (or the sidecar must
  `process.chdir()` before any engine import). Made in the wrong place (env → config plumbing
  only), the bug survives the "fix" and resurfaces as wrong-project permission rules during the
  first packaged-app dogfood. Verdict on the brief's question: the hardcode is **documented but
  not fully contained** — the containment story misses one of the two inputs.

### IS-2 — Supervisor lifecycle events terminate at Electron main; a dead session is invisible to the renderer — **CONFIRMED · MEDIUM**

- **Anchors:** `app/main/main.ts:193-198` (`wireRendererBridge` forwards only
  `event.type === 'frame'`; `status` and `exit` events are dropped on the floor);
  `app/supervisor/supervisor.ts:75-78` (the events exist and are per-session);
  `app/sidecar/index.ts:170-175` (a fatal engine error exits the process — producing exactly
  an `exit` event nobody consumes).
- **Concrete Phase-2 failure scenario:** during P2-x dogfooding, the sidecar crashes mid-turn
  (engine bug, OOM on a huge tool result). The renderer is awaiting a stream that will never
  produce `result`; the permission prompt or spinner sits forever. No error frame is produced
  (the sidecar is dead; error frames come *from* it), no status reaches the UI, and the silent
  `forward()` drop (`main.ts:258-274`, documented as PROTOCOL-ENVELOPE gap §3) means subsequent
  submits also vanish quietly. The user's only signal is a frozen UI.
- **Why it matters for Phase 2:** the Phase-1 gate didn't require crash UX, so this is not gate
  dishonesty — but Phase 2 is the first phase where a human *lives* on this seam for hours.
  PROTOCOL-ENVELOPE §3/§6 schedules `session_not_found` (inbound half) for Phase 3; nothing
  anywhere owns the **outbound** half (status/exit → renderer). At minimum, main should
  synthesize an error/status frame into the normal delivery path when a session leaves `ready`.
  Cheap, additive, and the difference between "session crashed, restart?" and a mystery hang.

### IS-3 — `killSession` deregisters before killing, so deliberate kills emit NO events — and `REGISTRY.md` §6's wiring assumption can't observe them — **CONFIRMED · MEDIUM (Phase-3 design consistency)**

- **Anchors:** `app/supervisor/supervisor.ts:221-228` (`killSession` destroys the socket,
  SIGTERMs the child, then **immediately deletes the registry entry**); `:179-190` (the child's
  later `exit` fires the F11 stale-record guard — `registry.get(sessionId) !== record` — and
  returns without emitting); `:198-204` (`setStatus` has the same guard, so the socket-close
  path emits nothing either). Net: `subscribe()` listeners receive **zero** events for any
  session that was deliberately killed or shut down.
- **Concrete failure scenario:** `REGISTRY.md` §6 specifies the Phase-3 host layer "subscribes
  to supervisor events (`status`/`exit` → row updates)". Built as specified, every row for a
  deliberately closed session stays `shutdown: null` forever — indistinguishable from a host
  crash — so every clean quit is followed, on next launch, by the liveness sweep treating all
  sessions as crash orphans (probing dead PIDs, marking rows `crashed`, offering "recover?" for
  sessions the user closed on purpose).
- **Why it matters for Phase 2/3:** this is a P1-frozen behavior colliding with a Phase-3
  decision written the same week. Two consistent resolutions exist: (a) make `killSession` emit
  a final `status:'exited'`/`exit` event before deregistering, or (b) amend REGISTRY §6 to do
  row bookkeeping at the *call sites* (`killSession`/`shutdown` callers), which §4.5's write-point
  list already half-implies. Either is small; deciding neither means the registry session
  discovers it mid-build. (The F11 guard itself is correct for restarts — this is about the
  deliberate-kill path, not a bug in the guard.)

### IS-4 — The trust-boundary module has no working static typecheck (disclosed, but under-owned) — **CONFIRMED · MEDIUM**

- **Anchors:** `app/sidecar/tsconfig.json` (strict overlay over the real engine graph);
  verified **5,642 errors** at review time. STATUS P1-3 discloses this accurately
  ("red independent of this work… ≈5.7k") and parks it at "Phase-5 CI".
- **Concrete Phase-2 failure scenario:** `sidecarServer.ts` is the *security* boundary
  (T4/T5a/T6/T6b/C1 all live there), and P2-4 adds two new inbound frame types (C2
  `permission.setMode`, C3 `permission.context`) to exactly this file. With the typecheck red,
  the only net under any boundary refactor is `bun test` — a type-level regression (e.g. a
  field becoming optional upstream, an engine type widening under snapshot drift) lands
  silently unless a test happens to assert the exact behavior.
- **Why it matters for Phase 2:** "Phase-5 CI" is the wrong owner for a check that guards code
  Phase 2 actively edits. It doesn't need the full 5.7k fixed — a scoped config that
  typechecks `app/sidecar/*.ts` against its direct imports (or even isolating the boundary
  functions into a checkable module) would restore a static net before P2-4 builds on it.

### IS-5 — 'ready' means socket-connected; a slow engine init has a hard 10s cliff and no retry owner — **CONFIRMED (code shape) / PLAUSIBLE (timing) · LOW**

- **Anchors:** `app/supervisor/supervisor.ts:267-289` (`connectWhenReady`: 200 × 50ms poll for
  the socket file, then mark `failed` + SIGTERM, no retry); `app/sidecar/index.ts:46-76` (the
  sidecar deliberately binds its socket only **after** full engine init — good ordering, but it
  means the whole `init()` cost counts against the 10s window); `main.ts` has no policy that
  reacts to `failed` (see IS-2 — the status wouldn't reach anyone anyway).
- **Concrete failure scenario:** cold start on a slow disk/network (init touches config
  migration, OAuth account population, policy fetch) exceeds 10s → session is permanently
  `failed`, child SIGTERMed, renderer sits at `connecting` forever. Not observed in P1 dev runs
  (init ≈ 1–2s); plausible on a packaged first-run.
- **Phase-2/3 impact:** restart policy is explicitly "caller policy" (`supervisor.ts:188-190`)
  and no caller implements one. Fine for P1; Phase 3's registry/restore work is the natural
  owner — it should also revisit the fixed 10s constant.

### IS-6 — An integration test's name promises coverage its body doesn't deliver — **CONFIRMED · LOW**

- **Anchors:** `app/sidecar/roundtrip.probe.test.ts:126-147` — titled *"a forged sessionId
  frame is rejected at the sidecar boundary"*, but the body (per its own comment) sends a valid
  ping and asserts a pong; no forged frame ever crosses the real socket. The rejection IS
  covered — but at unit level (`sidecarServer.test.ts:134`), not over the wire.
- **Failure scenario:** an auditor (or a future session deciding what integration coverage
  exists) reads test names and credits the socket path with a forged-frame test it doesn't
  have. This is exactly the class of quiet inflation the phase-0 review dinged STATUS for.
- **Impact:** rename it (it's a liveness/pong test), or make it do what it says — sending a
  raw mis-addressed frame over the real socket is ~10 lines with the existing harness.

### IS-7 — Single-active-session residue: confined to main + renderer, accurately documented, with one detail worth pinning — **CONFIRMED · LOW**

- **Inventory (verified):** supervisor — none (fully Map-keyed). Sidecar — `activeTurn` is a
  single flag, correct *by design* (one session per process). Main — `primarySessionId`
  (`main.ts:46,353,402`) is **write-only dead code** (never read; the renderer learns its id
  from the ready frame); the `AttachmentGate`'s single `attached` boolean is per-window, which
  is correct; the replay buffer is genuinely per-session (`replayBuffer.ts:33-53`). Renderer —
  single-session by construction: `rawMessageLog.ts:25-31` adopts the first ready frame's
  sessionId, and `:41-46` appends **any** session's `event` frames to the one message array
  with **no sessionId filter**.
- **Failure scenario:** none in Phase 1/2 (one session exists). In Phase 3, the renderer detail
  is the sharp edge: the moment a second sidecar exists, its frames interleave into the first
  session's transcript — a wrong-*content* bug, worse than a missing-feature bug.
- **Impact:** PROTOCOL-ENVELOPE E-6 already owns this as Phase-3 W2 work and describes it
  accurately. Pinned here so the W2 session knows it must add *filtering*, not just
  *keying* — and can delete `primarySessionId` while it's there.

### IS-8 — Evidence for landed work lives uncommitted in the worktree (the F6 lesson, repeating gently) — **CONFIRMED · LOW**

- **Anchors:** `git status` — the DR-2 engine fix (`src/codex-core/accounts.ts` modified) and
  its two-process probe (`accountRefreshContention.probe.test.ts` + `.probe.child.ts`,
  untracked), all three Phase-3 pre-work decisions (`REGISTRY.md`, `SESSION-LIFETIME.md`,
  `PROTOCOL-ENVELOPE.md`, untracked), and the P1-0 scaffold review that defines the F1–F16
  numbering cited throughout `app/` code comments (untracked, and in the stray location
  `docs/reviews/` rather than `docs/migration/reviews/`).
- **Failure scenario:** STATUS's Phase-3 pre-work block says DR-2 "**LANDED IN ENGINE**" —
  true today, but one `git checkout`/hard reset away from being testimony about deleted
  evidence, which is precisely how P0-1's spike evidence was lost (PHASE0-REVIEW F6). Code
  comments referencing "F1"…"F16" would dangle with their source document gone.
- **Impact:** commit them. Also worth one decision on where P1 review docs live — two review
  directories now exist.

---

## 3. Carry-forward table

| # | Item | Reason | Suggested owner | Source |
|---|---|---|---|---|
| 1 | Per-session cwd must be set at **process spawn** (supervisor `spawn` `cwd:` option or sidecar `chdir` before engine import), not only via env→session-config; P2-4 must not read project-scope settings/trust before process cwd is correct | Project identity (trust, project config, transcript dir) memoizes off boot cwd; REGISTRY §7.2's fix as written doesn't repair it | Phase-3 spawn-config item (amend REGISTRY §7.2) + a guard note in P2-4's brief | IS-1 |
| 2 | Surface `status`/`exit` to the renderer (synthesized status or error frame through the normal delivery path) | A crashed sidecar is currently invisible; Phase-2 dogfooding will hit it as a mystery hang | Phase-2 if cheap (one mapping in `wireRendererBridge`), else first Phase-3 shell session — pair with PROTOCOL-ENVELOPE §3 `session_not_found` | IS-2 |
| 3 | Reconcile `killSession`'s silent deregistration with REGISTRY §6's event-driven row updates (emit-on-kill, or bookkeeping at call sites) | Clean quits would register as crash orphans; restore UX misfires on every launch | Phase-3 registry session (flag in its brief before build) | IS-3 |
| 4 | A working typecheck over `app/sidecar/*.ts` (scoped config or module isolation) | Trust-boundary code that P2-4 edits has no static net; 5,642 errors verified | Before/with P2-4 — do not park at Phase-5 CI | IS-4 |
| 5 | Two-sidecar runtime smoke under one supervisor | N-shape is code-verified, never runtime-proven (PROTOCOL-ENVELOPE §8-A5's own admission — endorsed) | First Phase-3 session, before UI stacks on routing | (existing, endorsed) |
| 6 | Connect-timeout (10s) + restart policy | Hard cliff on slow cold init; `failed` has no consumer and no retry | Phase-3 lifecycle/registry work | IS-5 |
| 7 | Commit the DR-2 fix + probe, the three pre-work decisions, and the P1-0 scaffold review; settle the review-doc home | "LANDED" claims should not be one reset away from testimony (F6 lesson) | Operator/orchestrator, now | IS-8 |
| 8 | Renderer must **filter** frames by `sessionId`, not just key state; delete dead `primarySessionId` | Second session's frames currently interleave into the first transcript | Phase-3 W2 shell (already owned by E-6; sharpened) | IS-7 |

---

## 4. Test evidence

**Ran this session:**
- `bun test app/` — 122 pass / 0 fail / 295 assertions across 19 files (matches STATUS).
- `bun test src/codex-core/accountRefreshContention.probe.test.ts` — 2 pass / 0 fail; two REAL
  processes contend on one account; exactly-one-rotation + convergence assertions green.
- `bunx tsc --noEmit -p app/sidecar/tsconfig.json` — 5,642 errors (disclosure verified).

**Read (what they actually prove):**
- `roundtrip.probe.test.ts` — the strongest lifecycle evidence: spawns a REAL Bun sidecar via
  the real supervisor over a real Unix socket, twice with the real engine runtime (init runs;
  ready payload asserted field-for-field) and once in probe mode (raw `tool_use` intact over
  the wire, correct sessionId stamped). Proves spawn → init → bind → connect → ready → frame →
  send/pong → shutdown for ONE session at a time.
- `sidecarServer.test.ts` — 28 behavioral boundary tests against real `AppSessionController`
  instances (fixture adapters, real pending-permission machinery): envelope version + address
  rejection, strict-key rejection incl. prototype-name and host-only-escalation cases, T4/T5a/
  T6/T6b, the full C1 suggestion-selection matrix including the cross-request isolation case,
  F6 secret-guard on events AND ready, JSON-safety/undefined-normalization. These are real
  lifecycle-adjacent behavior tests, not shape checks.
- `attachmentGate.test.ts` / `replayBuffer.test.ts` — behavioral: pre-attach buffering, replay
  exactly-once, StrictMode double-signal, reload re-arm, per-session buffers, ready-head
  retention/eviction, cap behavior.
- `initializeRuntime.test.ts` — spawns a real Bun child; proves engine bootstrap + config reads
  succeed in a sidecar-shaped process.
- `sessionController.test.ts` — constructs the real runtime-backed controller (proves the real
  builder graph loads); the rest is static assertions on initial state.
- `mainSource.test.ts` — a string-content check on `main.ts` source (weak by design; fine for
  what it guards).
- `app/scripts/f2-attach-smoke.ts` / `run-hardening-smoke.ts` — real-Electron harnesses for
  attach/replay and renderer hardening; NOT part of `bun test app/` (opt-in scripts).

**What the suite does NOT prove:**
- **No supervisor unit tests exist at all** (`app/supervisor/` contains only `supervisor.ts`).
  `killSession`, `restartSession`, `shutdown`, and the F7 (spawn-error), F11 (stale-exit),
  F12 (connect-timeout), F13 (disconnect-status) guards have zero direct coverage — they are
  exercised only incidentally (shutdown via `afterEach`) or not at all (restart, kill,
  timeout, spawn-error). The F-guards were code-reviewed in and look correct, but nothing
  pins them against regression.
- **No two-sidecar process has ever run under one supervisor** — N-session claims are
  code-shape facts (honestly admitted in PROTOCOL-ENVELOPE §8-A5).
- **No crash-mid-turn test** — the IS-2 hole is unobserved by any harness.
- The live credentialed turns (P1-2), live tool-card render (P1-3), and live permission
  round-trip (P1-4) are operator testimony per the 🖐 GUI design — legitimate under the gate's
  own rules, but not re-runnable from the repo.

---

*Reviewed against the `migration` worktree (app/ fully committed at `f5ab1e6`; pre-work
artifacts uncommitted as noted in IS-8) on 2026-07-03. No file other than this review was
created or modified.*
