# Migration backlog — Phase 3 (shell + multi-session build-out)

**Generated 2026-07-04** (Scenario 2, per PROGRAM-PLAN §8), from the INVENTORY W2 rows +
the four Phase-3 pre-work decisions — **D1** `decisions/REGISTRY.md`, **D6**
`decisions/SESSION-LIFETIME.md`, **F3** `decisions/PROTOCOL-ENVELOPE.md`, and the
SECURITY-MINIMUM **Addendum 2026-07-04** (T8, HC1–HC4) — all pressure-tested with review
findings applied (see STATUS Phase-3 pre-work note). DR-2 (cross-process refresh clobber) is
**already fixed in-engine** — do not re-plan it; its *same-class NOT solved* flags
(`persistPermissionUpdates` settings writes; `GenerateImageTool.ts:496` raw refresh) appear
below as observe-and-flag notes only.

**9 sessions** in three tranches:
protocol/host plumbing (P3-0..P3-3) → renderer/shell (P3-4..P3-7) → lifetime gate (P3-8).

> ⚠️ **Topology guard (do not regress):** `decisions/SHELL.md` and `SEAM-SPIKE.md` predate P0-1
> and pick **Tauri** — that is SUPERSEDED. The locked topology is **Electron + Bun sidecar over a
> Unix-domain (filesystem) socket, raw `AppSessionEvent`/`SDKMessage` fidelity, N engine
> processes** (`decisions/TRANSPORT.md`; P0-1). From SHELL.md take only the seam finding
> (`AppSessionController` is headless-safe; forward the full `SDKMessage`) — never Tauri, Rust,
> or `AppSessionWebSocketServer`. The shell is the React renderer already scaffolded in `app/`.

## How to use
Paste **one** block into a fresh agent session, in order. Each is self-contained. Respect the
dependency note — don't start a session whose deps aren't green. When done, flip the session's
row in `STATUS.md` (✅ + date + one-line note) as the last step.

## Standing rules (apply to every session below)
- **Step 0 — read your surface's row in `docs/migration/INVENTORY.md` (§W2)**: disposition,
  ⚓ grounding, `Faked?` spec ID. The row is your marching orders; don't re-derive the approach.
- **Step 1 — read the named prototype file(s)** under `/Users/pt/catcode_prototype/cat-app/` —
  the UX spec, never code to port. **Source wins**: real shapes live in `~/cat-code/src` and
  `~/cat-code/app`; re-verify every `…:line` anchor before building on it (they drift — the
  line numbers in this file were re-verified 2026-07-04 and already differ from the decision
  docs in places). Surface real engine-vs-UX conflicts to the operator; don't silently resolve.
- **Locked decisions — do not reopen:** Electron + Bun sidecar; filesystem Unix-domain socket
  transport (never stdio/child-IPC); N-process (one engine process per session — feasibility
  settled by P0-4, do not re-litigate); raw `AppSessionEvent` fidelity (no lossy mapper);
  die-with-window v1 (D6 — behavior, NOT welding); v1 restore = re-spawn + engine resume
  (D1 R3; DR-1 re-attach explicitly waived for v1).
- **Security baseline is a hard gate** (`decisions/SECURITY-MINIMUM.md`): T4 goalSnapshot
  validated; T5a permission responses must match an engine-minted pending request; T6
  `updatedInput` echo-only (+T6b `updatedPermissions` stripped; C1 suggestion-SELECTION is the
  only sanctioned always-allow path); T7 inbound size/rate caps; directional frame limits
  (`MAX_FRAME_BYTES` inbound vs `MAX_OUTBOUND_FRAME_BYTES` outbound — never swap); engine-only
  secrets + `secretGuard` on outbound frames; preload stays default-deny (no generic `invoke`).
  Phase-3 adds **T8/HC1–HC4** (Addendum 2026-07-04): renderer never authors a cwd (HC1),
  session ids validated not trusted (HC2), control-plane preload methods are fixed structured
  senders (HC3), spawning bounded — registry cap + rate cap (HC4). Every session preserves ALL
  of this.
- **Verification commands (headless — the worker's job):** `bun test app/` (must be green);
  `bunx tsc --noEmit -p app/tsconfig.json` (renderer must stay clean);
  `bunx tsc --noEmit -p app/sidecar/tsconfig.json` — ⚠️ **pre-existing red** (≈5.5k errors,
  include-override drops root `env.d.ts`; known since P1-3): require **no NEW errors from your
  change**, not green. Boundary changes also run `bun run --cwd app test:hardening`.
- **The HUMAN operator drives the GUI — the worker never does.** Any verification needing a
  click, keypress, or app launch: the worker **STOPS and prints exact operator instructions**
  (command to run, what to click, what to look for) and waits for the operator's report. The
  worker must **NOT** use `cua-driver`, `claude-in-chrome`/`mcp__claude-in-chrome__*`, or any
  computer/browser automation. Headless checks (`bun test`, typecheck, build, file inspection)
  remain the worker's job.
- **One sitting.** If a block feels too big mid-session, stop and split — don't degrade.
- Branch `migration`; never main. `app/` is its own package (`@cat-code/desktop`) — use its
  scripts, not root `build:dev:full`. Keep `app/supervisor/` (and the new host modules)
  Electron-free — zero `electron` imports.
- **N-process shared-state discipline (the DR-2 lesson):** never add a new cross-process
  read-modify-write file without single-writer + lockfile + atomic-write discipline. Known
  same-class engine-side risks that are NOT solved (flag if observed, do not fix here):
  `persistPermissionUpdates` settings writes; `GenerateImageTool.ts:496` raw refresh.

**Dependency chain / parallelism:**
```
P3-0 (envelope N-hardening + two-sidecar smoke)
  ├─▶ P3-1 (spawn-config: cwd + engine resume)  ┐
  └─▶ P3-2 (registry module)                    ├─▶ P3-3 (host API / control plane)
        [P3-1 ∥ P3-2]                           ┘         │
P3-4 (renderer keyed by sessionId; needs Phase-2 gate) ───┤
                                                          ▼
                                              P3-5 (shell: routing + TabBar + Sidebar)
                                                ├─▶ P3-6 (WorkspaceLayout split panels)
                                                ├─▶ P3-7 (CommandPalette + SlashCommandPicker)
                                                └─▶ P3-8 (GATE: lifetime/restore, D6 §4)
```
- **P3-0 first** — F3's additive gaps are small, gate everything (the registry cannot exist
  without `ReadyFrame.engineSessionId`), and its two-sidecar smoke is the first time two real
  engines run under one supervisor (F3 §8-A5 names this the mandatory first step before UI
  stacks on the claim).
- **P3-1 ∥ P3-2** — spawn-config plumbing and the registry file module touch disjoint files.
- **Plumbing before shell** — a tab manager needs a registry to manage: P3-5's TabBar/Sidebar
  consume the P3-3 host API (`SessionDescriptor` stream), so the shell waits for the control
  plane. The renderer foundation (P3-4) needs only the per-frame `sessionId` slot (already
  live), so it runs parallel to P3-0..P3-3.
- **Cross-phase concurrency:** P3-0 and P3-1 touch `app/sidecar/sidecarServer.ts` /
  `app/sidecar/sessionController.ts`, which **P2-4** also modifies (C2/C3 frames +
  settings-rules fix) — do not run them concurrently with P2-4. P3-2 (new files) is safe
  anytime. **P3-4 onward hard-depend on the Phase-2 gate** (same renderer modules).
- P3-6 ∥ P3-7 ∥ P3-8 after P3-5. P3-8 is the gate session; P3-6/P3-7 are W2 scope but not
  gate-blocking.

🧠 **Per-session tag** = `Model: CLAUDE (visual-design|system-architecture) | ANY ·
Difficulty: N/10`, `· 🖐 GUI` appended only when the operator must drive a live GUI step
(presence-only). CLAUDE only where the core is design/architecture *judgment*; implementing an
already-decided design is ANY. Difficulty is a bare 1–10; the operator picks reasoning effort.
Every executing session **echoes its header back before starting**.

---

## P3-0 · 🔴 — Envelope N-hardening (F3 additive gaps) + the first two-sidecar smoke

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 6/10

You are running P3-0 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (repeat of shared state — you start cold) ===
CatCode is a desktop app being rebuilt on the real cat-code engine: Electron shell + one
headless Bun engine sidecar PER SESSION (N-process, locked), talking over per-session
Unix-domain sockets with raw `AppSessionEvent`/`SDKMessage` frames (locked; no lossy mapper).
Phases 0–2 built a single-session walking skeleton + transcript spine. Phase 3 makes it
multi-session. Read first: docs/migration/STATUS.md (Phase-3 header),
docs/migration/decisions/PROTOCOL-ENVELOPE.md (F3 — THE spec for this session),
docs/migration/decisions/REGISTRY.md §2 (why engineSessionId), decisions/SECURITY-MINIMUM.md.
Step 0: read INVENTORY.md §W2 row "N-process spawn/attach/multiplex + app registry"
(build-new + S3; ⚓0 — the one truly source-empty row; concurrentSessions.ts is liveness only).

F3's verdict: the shipped v1 envelope is SUFFICIENT for multiplexing — inbound sessionId
routing is live code, not a dead slot. Your job is its consolidated additive-gap list (F3 §6):
five small changes, no version bump, then PROVE the N-path with two real sidecars (F3 §8-A5:
"no two-sidecar process has ever run under one supervisor" — the N-claims are code-shape
facts until you run this).

⚠️ Do NOT run concurrently with P2-4 (it edits app/sidecar/sidecarServer.ts too).

=== BUILD (in this order) ===
1. **`ReadyFrame.engineSessionId` — FIRST; it unblocks the registry (D1).**
   Add `engineSessionId: string` to the app-owned `ReadyFrame` (app/shared/protocol.ts:74-80).
   The sidecar fills it after `initializeSidecarRuntime()` runs engine `init()`
   (app/sidecar/initializeRuntime.ts:8-30) from the engine's `getSessionId()`
   (src/bootstrap/state.ts:437), stamping it into the ready-frame construction at
   app/sidecar/sidecarServer.ts:118-135. Do NOT widen the engine-owned `AppReadyPayload`
   (src/web/appSessionProtocol.ts:157) — app-owned frame is the sanctioned change site
   (F3 E-5 / R2; PERMISSION-BOUNDARY R6 precedent).
2. **Typed forward-failure outcomes (F3 §3).** Extend the `ErrorFrame` code union
   (app/shared/protocol.ts:114-120) with `session_not_found` (terminal, retryable:false),
   `session_not_ready` (retryable:true), `session_disconnected` (retryable:false — restart is
   the affordance). Today `SidecarSupervisor.send()` throws ONE undifferentiated error for
   every failure flavor (app/supervisor/supervisor.ts:217-221) and main's `forward()` swallows
   it to stderr — a silent drop (app/main/main.ts:304-330). Make main synthesize the right
   typed `ErrorFrame` back through the normal delivery path, chosen from the supervisor
   record's status (typed supervisor error or a status lookup — your call; the wire contract
   is the three codes). The sidecar never emits these (it can't know about other sessions).
   Do NOT merge this union with the control-plane `HostErrorCode` (REGISTRY §6.1) — same
   underlying state, different planes (F3 §3 explicitly forbids merging).
3. **Outbound sessionId tripwire (F3 §2).** In the supervisor's decode loop
   (app/supervisor/supervisor.ts:323-336, the `emit` at :330-335): if the decoded frame's
   inner `sessionId !== record.sessionId`, DROP the frame and log. Never rewrite the slot
   (F3 R3 — rewriting masks the bug this exists to catch). Bug-containment, not a security
   boundary.
4. **Ready-frame SCHEMA check at attach (F3 §5).** When a sidecar's ready frame arrives,
   the supervisor validates it carries every host-required field — well-formed `sessionId`
   matching the record AND (after item 1) `engineSessionId` — and marks the session `failed`
   otherwise. A `protocolVersion === 1` number-compare alone is INSUFFICIENT: additive-field
   skew (an old sidecar predating engineSessionId) sails through it. Fail closed, no
   negotiation (deferred to v2-remote, F3 §5).
5. **Per-session replay eviction — VERIFY + close the kill path.** ⚠️ Source has drifted past
   F3 here (source wins): the mechanism already exists — `FrameReplayBuffer.clearSession`
   (app/main/replayBuffer.ts:104), `AttachmentGate.clearSession` (app/main/attachmentGate.ts:60-62),
   wired on the restart channel (app/main/main.ts:292). What F3 §4 still wants proven: session
   CHURN must not ghost-replay dead sessions' ready-frames into a reloaded renderer. Add tests
   for the kill path; add any missing eviction call sites you find (note: `closeSession` doesn't
   exist yet — P3-3 wires it and MUST call clearSession; leave that as a named carry, don't
   build the host API here).
6. **Two-sidecar smoke (F3 §8-A5).** Extend app/scripts/f2-attach-smoke.ts (extend, don't
   duplicate — F3 §9): TWO real sidecars under ONE supervisor. Prove: concurrent frames route
   to the right sidecar (each self-check passes, app/sidecar/sidecarServer.ts:202-209);
   events come back correctly addressed; kill one → the other unaffected (crash isolation)
   AND a send to the dead one yields your new typed code; no ghost replay after eviction.
   Flag-only (do NOT fix): both engines share settings files — the `persistPermissionUpdates`
   same-class DR-2 risk; note anything you observe.

=== GROUND RULES ===
Everything additive under PROTOCOL_VERSION = 1 (app/shared/protocol.ts:40) — no version bump,
no frame reshape. Preserve the security baseline (T4/T5a/T6/T7, directional frame caps,
secretGuard) and the sidecar's per-frame version + self-check rejections
(sidecarServer.ts:186-209). Keep app/supervisor/ Electron-free. Re-verify every anchor above
before relying on it.

=== DELIVERABLE / DONE WHEN (headless — all yours) ===
- `bun test app/` green with new boundary tests: mis-stamped outbound frame dropped+logged;
  sends to unknown/spawning/dead sessions produce exactly the three typed codes; ready frame
  missing engineSessionId → session `failed`; kill-path eviction (no ghost replay).
- `bunx tsc --noEmit -p app/tsconfig.json` clean; `-p app/sidecar/tsconfig.json` no NEW errors
  (pre-existing ≈5.5k red is known); `bun run --cwd app test:hardening` passes.
- Two-sidecar smoke runs and its output is pasted in your report.
- Update STATUS.md P3-0 row → ✅ + date + one-line note.

Report back: the engineSessionId now visible in a real ready frame, the three typed codes
firing (which supervisor states map to which), the tripwire + schema check in place, what the
two-sidecar smoke proved (and any cross-engine shared-state observation), and any anchor drift
you found.
```
─── PASTE ───

## P3-1 · 🔴 — Session spawn-config: per-session cwd + engine-session resume plumbing

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 6/10

You are running P3-1 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Dependency: P3-0 green (`ReadyFrame.engineSessionId` exists — you assert against it).
Echo the header line above back to the operator before starting.

=== CONTEXT (repeat of shared state — you start cold) ===
Electron + N Bun engine sidecars (one per session) over per-session Unix-domain sockets, raw
`SDKMessage` fidelity — all locked. D1 (decisions/REGISTRY.md) decided the restore model:
v1 restore = re-SPAWN a fresh engine process + resume the engine session through the ENGINE'S
REAL resume machinery, keyed by `engineSessionId`. This session builds the spawn-config half:
the supervisor must be able to start a sidecar with (a) a caller-chosen working directory and
(b) an optional engine session to resume — REGISTRY §7 item 2. Read first: STATUS.md,
decisions/REGISTRY.md (§2, §4 step 4, §6.1 CreateSessionRequest), decisions/SESSION-LIFETIME.md
§1 (re-attach ≠ re-spawn), decisions/SECURITY-MINIMUM.md Addendum (T8/HC1).
Step 0: read INVENTORY.md §W2 row "N-process spawn/attach/multiplex + app registry" (S3,
build-new) — this is a slice of it.

⚠️ Do NOT run concurrently with P2-4 (it edits app/sidecar/sessionController.ts too — the
settings-rules fix).

=== BUILD ===
- **Supervisor spawn config.** `spawnSession` (app/supervisor/supervisor.ts:137) takes an
  optional config `{cwd: string; resumeEngineSessionId?: string}` and hands it to the sidecar
  via env — `CATCODE_SIDECAR_CWD`, `CATCODE_SIDECAR_RESUME_SESSION_ID` — exactly like
  `CATCODE_SIDECAR_SESSION_ID` today (supervisor.ts:164). Also set the child process's actual
  spawn cwd: the engine derives project identity from `process.cwd()` (see the comment in
  app/shared/sessionConfig.ts). Env is main/host-owned input, never renderer input (T8/HC1 —
  nothing in this session may add a renderer-authored path; validation-at-API is P3-3's job,
  but the sidecar still fails loudly on a missing/non-directory cwd — defense in depth).
- **Retire the P1-1 hardcode.** The sidecar currently pins `cwd: P1_1_CWD`
  (app/shared/sessionConfig.ts, consumed at app/sidecar/sessionController.ts:22; env read at
  app/sidecar/index.ts:32-37). Replace with the env-supplied cwd. Delete `P1_1_CWD` and every
  reference — this is the flagged carry-forward D1 §4 retires; do an exhaustive search.
- **Resume path (the real machinery — recon before wiring).** When
  `CATCODE_SIDECAR_RESUME_SESSION_ID` is present, session construction must resume that engine
  session, not mint a fresh one: `loadConversationForResume`
  (src/utils/conversationRecovery.ts:465) deserializes messages/interruption-state/metadata and
  `processResumedConversation` (src/utils/sessionRestore.ts:493) rebuilds session state around
  them. ⚠️ `switchSession` (src/bootstrap/state.ts:474) alone only ADOPTS the id — it is NOT a
  resume (D1 R3 is explicit). Recon how the TUI's own resume flow composes these before you
  wire anything (recon-before-invent; cite the composing call sites you found in your report).
  After resume, the ready frame's `engineSessionId` (P3-0) must equal the requested resume id.
- **Failure posture:** unresumable id (transcript missing/corrupt) → sidecar exits loudly with
  a distinguishable error on stderr + non-zero exit (the supervisor already surfaces exits,
  supervisor.ts:279 lists status) — never a silent fresh session (that would fake a restore;
  the D6 anti-Potemkin clause exists to catch exactly this).

=== GROUND RULES ===
Locked: Unix socket, N-process, raw fidelity, die-with-window v1. Security baseline preserved
(T4/T5a/T6/T7 + T8/HC1 posture). No new wire frames — spawn config rides env + host API only
(F3 E-3/R4: control plane stays off the wire in v1). Re-verify anchors; source wins.

=== DELIVERABLE / DONE WHEN (headless — all yours) ===
- Probe-style tests (pattern: app/sidecar/roundtrip.probe.test.ts): (a) sidecar spawned with a
  distinct cwd boots the engine rooted there (assert engine-side cwd, and that two sidecars
  with different cwds don't cross — the P0-4 stomp is the ancestral bug here); (b) sidecar
  spawned with `resumeEngineSessionId` of a transcript you mint in-test reports the SAME
  engineSessionId in its ready frame AND the resumed session's state actually contains the
  prior messages (assert via engine-side state, not by re-reading the JSONL yourself); (c)
  bogus resume id → loud failure, no silent fresh session. Mint the fixture transcript through
  the engine's own persistence (drive a controller, or reuse an existing probe recipe) — do
  not hand-write JSONL. No live credentialed turn is required here (the anti-Potemkin live
  proof is P3-8's job).
- `bun test app/` green; renderer tsc clean; sidecar tsconfig no NEW errors;
  `bun run --cwd app test:hardening` passes; grep shows zero remaining `P1_1_CWD` references.
- Update STATUS.md P3-1 row → ✅ + date + one-line note.

Report back: the env/config surface you added, the exact engine call sites the resume composes
(with src/…:line), proof the ready frame echoes the resumed engineSessionId, the failure
behavior for a bad resume id, and confirmation P1_1_CWD is fully gone.
```
─── PASTE ───

## P3-2 · 🔴 — The app-owned session registry (durable index, host plane)

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 6/10

You are running P3-2 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Dependency: P3-0 green (engineSessionId exists on ready frames — the registry bridges it).
Parallel-safe with P3-1 (disjoint files). Echo the header line above back to the operator
before starting.

=== CONTEXT (repeat of shared state — you start cold) ===
Electron + N Bun sidecars over Unix sockets (locked). D1 is DECIDED and pressure-tested:
decisions/REGISTRY.md is THE spec for this session — read it in full and implement it; do not
redesign it. The registry is an app-owned durable INDEX over engine-owned transcripts
(registry loss ≠ data loss): it remembers which engine sessions the desktop had open,
addressed how (two-id model: supervisor-minted `appSessionId` ↔ engine-minted
`engineSessionId`), rooted where. Session CONTENT stays engine-owned
(`getTranscriptPathForSession`, src/utils/sessionStorage.ts:240). Read also: STATUS.md,
decisions/SESSION-LIFETIME.md §2-§3 (the sweep's kill-don't-attach v1 policy),
decisions/SECURITY-MINIMUM.md (no secrets, ever).
Step 0: read INVENTORY.md §W2 row "N-process spawn/attach/multiplex + app registry"
(build-new + S3; ⚓0) and the D1 summary block (INVENTORY §Human-decision list).

=== BUILD (implement REGISTRY.md §3–§5 as written) ===
- **Module home:** a sibling of the supervisor in the host plane (app/supervisor/registry.ts
  or app/host/ — your call, state it). Electron-free (zero `electron` imports), does NOT talk
  to sockets, does NOT parse frames, does NOT import the engine graph (R1, §6 non-goals).
  Storage dir INJECTED at construction (tests stay hermetic); canonical default
  `<claude-config-home>/desktop/registry.json` — match the engine's config-home rules (recon
  how src derives it; re-implement host-side without importing engine code).
- **Schema (§3, registryVersion 1):** one JSON document; per-session rows with [D]urable
  fields (appSessionId, engineSessionId|null, cwd, title?, createdAt, lastAttachedAt,
  shutdown: "clean"|"crashed"|null) and [A]dvisory fields (enginePid, socketPath,
  restartCount — rewritten every run, verified before use, NEVER trusted). NO secrets, no
  transcript content, no window/tab layout, no permission state (§3 exclusions — layout is
  renderer-owned; a registry rewrite must never destroy it). `MAX_REGISTRY_SESSIONS = 32`;
  oldest `shutdown != null` rows reaped on write; rows whose transcript is gone dropped in the
  sweep (never offer a restore you can't perform).
- **Write discipline (§5 — the DR-2 lesson applied to our own new shared file):** advisory
  lockfile (house pattern: proper-lockfile via src/utils/lockfile.ts, as
  src/services/api/codexTokenRefresh.ts:290 does) + atomic temp-file-rename writes (the
  `atomicWriteJson` idiom, codexTokenRefresh.ts:913). Writers retry briefly on a held lock,
  then fail the WRITE (never the session) and log. The Electron single-instance lock is P3-3's
  layer; your module must not depend on client politeness.
- **Launch sequence (§4):** (1) read+validate — unknown version/unparseable → move aside as
  `registry.json.corrupt-<ts>`, start empty, log loudly; (2) liveness sweep for rows with
  `shutdown == null`: probe enginePid — alive → orphaned sidecar → v1 policy KILL (SIGTERM;
  D6 §2), dead → nothing; either way mark `crashed`; best-effort unlink stale socketPath.
  ⚠️ §9-A3: never kill on pid-match alone — require identity too (row's socketPath still
  exists AND the process cmdline is the sidecar binary; both cheap on darwin); (3) reap
  over-bound + missing-transcript rows AND `shutdown:"clean"` rows with
  `engineSessionId: null` (§9-A5 — an address that never got content isn't restorable);
  (4) restore-offer data = rows by lastAttachedAt, crashed flagged (the UI consuming it is
  P3-5); (5) write points: upsert on spawn, engineSessionId fill on ready, title on rename,
  lastAttachedAt on attach, `shutdown:"clean"` in close — full-file atomic, never on frame
  traffic (the registry is not a log).
- `src/utils/concurrentSessions.ts` (:64,:77 per-PID writes; :186-201 sweep) is prior art for
  the liveness CHECK only — not reused, not extended (R7).

=== GROUND RULES ===
Locked decisions + security baseline as in the standing rules. This module is pure host-plane
state — no wire changes, no renderer surface. Re-verify anchors; source wins.

=== DELIVERABLE / DONE WHEN (headless — all yours) ===
- `bun test app/` green with tests covering: corrupt file → moved aside + empty start + loud
  log; sweep kills a real orphaned dummy process ONLY when pid+identity both match (and spares
  a recycled-pid impostor); bound-reaping; missing-transcript drop; null-engineSessionId
  reaping; atomic write under a simulated concurrent writer (no torn JSON — last writer wins a
  consistent snapshot); every write point updates the right fields.
- Renderer tsc clean; sidecar tsconfig no NEW errors. Grep proves zero `electron` imports in
  the module.
- Update STATUS.md P3-2 row → ✅ + date + one-line note.

Report back: module home chosen, the schema as landed (any deviation from §3 justified), how
the pid+identity check works, sweep/reap test evidence, and confirmation the module imports
neither electron nor the engine graph.
```
─── PASTE ───

## P3-3 · 🔴 — Host API: the typed control plane (D1 §6.1 / DR-4) + Electron wiring

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 7/10

You are running P3-3 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Dependencies: P3-1 (spawn-config) AND P3-2 (registry) green. Echo the header line above back
to the operator before starting.

=== CONTEXT (repeat of shared state — you start cold) ===
Electron + N Bun sidecars over Unix sockets (locked). The control plane is DECIDED — you are
implementing, not designing: decisions/REGISTRY.md §6/§6.1 defines the typed contract
(`CreateSessionRequest`, `SessionDescriptor`, `HostErrorCode`, `HostEvent`, five methods) and
decisions/SECURITY-MINIMUM.md Addendum 2026-07-04 defines its trust zone (threat T8, rules
HC1–HC4) — read both in full, plus decisions/SESSION-LIFETIME.md §2 (die-with-window mechanics
as built) and PROTOCOL-ENVELOPE.md E-3 (control plane stays OFF the wire in v1 — host-API
calls, window = client #1; wire frames only when a remote client exists, DR-4 watch-item).
Step 0: read INVENTORY.md §W2 rows "N-process spawn/attach/multiplex + app registry" and
"Root state / routing (AppV2.jsx)" — this session is their host-side half.

=== BUILD ===
- **Host composition layer (Electron-free):** wires supervisor
  (app/supervisor/supervisor.ts — spawn :137 / kill :242 / restart :252 / listSessions :279 /
  events) + registry (P3-2) + spawn-config (P3-1) into the five methods:
  `createSession(req) → SessionDescriptor`, `restoreSession(appSessionId)` (sugar over create
  with the row's cwd + resumeEngineSessionId; `session_not_found` if row or transcript gone),
  `closeSession(appSessionId)` (graceful sidecar shutdown; row kept restorable, marked
  `shutdown:"clean"`; MUST evict replay state — `AttachmentGate.clearSession`,
  app/main/attachmentGate.ts:60-62 — the named carry from P3-0), `listSessions()` (live ∪
  restorable), `subscribe(cb)` (`HostEvent` row-change stream derived from supervisor events —
  the renderer's session list is a projection of this stream, never a poll loop). All results
  typed; failures are typed `HostErrorCode`s, never bare thrown strings. It also relays each
  ready frame's `engineSessionId` (P3-0) into the registry row, and flips rows on
  status/exit events.
- **Types live in app/shared/** beside the wire protocol (they cross main↔renderer via
  preload). Keep `HostErrorCode` and the transport-plane ErrorFrame codes (P3-0) SEPARATE
  unions (F3 §3 forbids merging).
- **Security rules (normative — implement all four):** HC1 — the renderer NEVER authors a
  filesystem path: cwd originates from main's native `dialog.showOpenDialog` (renderer may
  request the picker, not answer it) or an existing registry row; host re-validates
  (realpath, exists, isDirectory) regardless of origin → `invalid_cwd`. HC2 — appSessionIds
  from the renderer validated (UUID shape + live∪registry membership) → `session_not_found`;
  no throw-through into main. HC3 — preload exposes the five methods as FIXED structured
  senders only (extend the existing default-deny pattern in app/preload/preload.ts +
  rendererIpcGuard; no generic invoke, no renderer-controlled channel names, no method
  returning filesystem contents). HC4 — `MAX_REGISTRY_SESSIONS` + a spawn rate cap →
  `session_limit` (extends T7's flood posture to process creation).
- **Electron main becomes a caller:** refactor `ensureHost()` (app/main/main.ts:404) to
  construct host = supervisor + registry + composition; take the OS single-instance lock
  (`app.requestSingleInstanceLock()`) BEFORE constructing the host (REGISTRY §5) — second
  instance defers. Preserve die-with-window exactly as built: `window-all-closed` →
  `supervisor.shutdown()` (main.ts:451-455), `before-quit` (main.ts:466-467), macOS `activate`
  re-creates (main.ts:444-446) — but now the fresh-session-per-activate flows through
  `createSession` so registry hygiene applies (D1 §9-A5).
- Keep the existing per-session frame path untouched — this session adds control-plane calls,
  zero new socket frame types.

=== GROUND RULES ===
Locked decisions + full security baseline (standing rules). Supervisor + registry + host
composition all stay Electron-free; only main touches `electron`. Re-verify anchors; source
wins.

=== DELIVERABLE / DONE WHEN (headless — all yours) ===
- `bun test app/` green with: unit tests for all five methods incl. every `HostErrorCode`
  path (invalid_cwd / session_not_found / session_limit / spawn_failed /
  registry_unavailable — registry write failure degrades persistence, never kills the
  session); HC2 fuzz (malformed ids → typed error, no crash); HC4 (rate cap + row cap);
  closeSession evicts replay + marks the row clean+restorable; HostEvent stream fires on
  status/exit/add/remove; preload guard tests prove the five senders are fixed-shape and
  nothing else was added (extend app/preload/preloadSource.test.ts / rendererIpcGuard.test.ts
  patterns).
- Renderer tsc clean; sidecar tsconfig no NEW errors; `bun run --cwd app test:hardening`
  passes.
- Update STATUS.md P3-3 row → ✅ + date + one-line note.

Report back: the host API surface as landed, how each HC rule is enforced (with file:line),
the single-instance lock placement, the closeSession→eviction wiring, and confirmation zero
new wire frame types exist.
```
─── PASTE ───

## P3-4 · 🔴 — Renderer multiplex foundation: every store keyed by `sessionId`

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 6/10

You are running P3-4 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Dependency: the PHASE-2 GATE (P2-1..P2-4 all ✅) — this session refactors the same renderer
modules Phase 2 builds; do not start while any P2 session is open. Runs parallel-safe with
P3-0..P3-3 (host/sidecar plane). Echo the header line above back to the operator before
starting.

=== CONTEXT (repeat of shared state — you start cold) ===
Electron + N Bun sidecars (locked). Every frame in both directions already carries
`sessionId` (app/shared/protocol.ts — F3 E-1 verified the routing spine live), and the bridge
API takes `sessionId` on every call (protocol.ts:163-175). But the renderer keys NOTHING by it
— single-session assumptions are baked into the P1/P2 state modules (F3 E-6). This session is
the pure state refactor that makes N sessions representable; the visible shell chrome is P3-5.
Read first: STATUS.md, PROTOCOL-ENVELOPE.md E-6/§2, the P2-0 fixture
(app/renderer/src/sdkMessageFixtures.ts — the reference artifact for projector behavior).
Step 0: read INVENTORY.md §W2 row "Root state / routing (AppV2.jsx)" (⚓7, S3/S6,
adapt/build-new — "prototype root is mock glue"); this session is its state half.

=== BUILD ===
- Key every renderer store by `frame.sessionId`: app/renderer/src/connectionState.ts,
  permissionState.ts, rawMessageLog.ts, and the transcript projector state
  (transcriptProjector.ts — per-session projector instances or a keyed reducer; preserve the
  §5 layer-2 discipline: variants stay switch cases, domains plug in via selectors, zero
  casts). App.tsx / TranscriptView.tsx consume via an explicit `activeSessionId`.
- **Isolation invariant (the point of this session):** frames for session B arriving while A
  is active must mutate ONLY B's slice — no bleed into A's transcript, connection state, or
  permission queue. The F3 §2 scenario (a mis-stamped frame corrupting a DIFFERENT session's
  renderer state) is exactly what keyed stores must contain.
- **Replay/attachment demux:** `rendererReady` replays ALL sessions' buffers interleaved
  (app/main/attachmentGate.ts:48; per-session ready-head-first ordering is guaranteed by
  `FrameReplayBuffer.snapshot`, app/main/replayBuffer.ts:93) — the renderer must demux by
  sessionId and rebuild N sessions' state from one replay stream.
- Handle the P3-0 typed forward-failure codes (`session_not_found` / `session_not_ready` /
  `session_disconnected`) as per-session state (dead/starting/disconnected) so P3-5 can render
  dead-tab UX — state only, no chrome yet.
- Single-session UX must remain pixel-identical (one session = today's behavior). A minimal
  dev-only session switcher is acceptable for manual sanity; the real UI is P3-5 — don't build
  chrome here.
- ⚠️ Session addressing here is renderer STATE, not security: the sidecar self-check + T5a
  per-controller pendings remain the enforcement (F3 §8-A1). Don't invent renderer-side
  "security" checks; keep the trust model.

=== GROUND RULES ===
Locked decisions + security baseline (standing rules). No protocol changes. Preserve all P2
row/card/streaming behavior — this is a re-keying, not a redesign; if a P2 module resists
keying without redesign, STOP and report rather than quietly rewriting it.

=== DELIVERABLE / DONE WHEN (headless — all yours) ===
- `bun test app/` green with new tests: interleaved fixture streams for two sessionIds (mint
  from sdkMessageFixtures.ts) project into two independent transcripts; permission request for
  B while A active queues under B only; replay stream containing two sessions' buffers
  rebuilds both; typed failure codes land in the right session's state; existing P2 projector
  tests still pass unmodified (or with mechanical-only updates, explained).
- Renderer tsc clean; sidecar tsconfig no NEW errors.
- Update STATUS.md P3-4 row → ✅ + date + one-line note.

Report back: the keying pattern chosen (per-session instances vs keyed reducers, and why),
the activeSessionId flow, proof of the isolation invariant, and any P2 module that needed
more than mechanical re-keying.
```
─── PASTE ───

## P3-5 · 🔴 — The shell: root routing + TabBar + Sidebar hosting real sessions

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 8/10 · 🖐 GUI

You are running P3-5 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Dependencies: P3-3 (host API) AND P3-4 (renderer keyed by sessionId) green. Echo the header
line above back to the operator before starting.

=== CONTEXT (repeat of shared state — you start cold) ===
Electron + N Bun sidecars over Unix sockets, raw fidelity, die-with-window v1 — all locked.
The plumbing exists: typed host API (createSession/restoreSession/closeSession/listSessions/
subscribe → SessionDescriptor/HostEvent, REGISTRY.md §6.1), durable registry, per-session
renderer state. This session builds the visible frame: one window hosting N real sessions,
switchable. Read first: STATUS.md, decisions/REGISTRY.md §6.1 + §10 (title seeding
carry-forward), SECURITY-MINIMUM Addendum (HC1 — cwd via native picker ONLY).
Step 0: read INVENTORY.md §W2 rows: `TabBar` (⚓4, S3, adapt — "durable desktop tab manager is
app-owned", D1 now decided), `Sidebar` (⚓4, S3/S4, adapt — "prototype cost/model/tags/
workspace are FIXTURE fields"), `Root state / routing` (AppV2.jsx, ⚓7, S3/S6, adapt/build-new
— "prototype root is mock glue").
Step 1 (UX spec, not code): /Users/pt/catcode_prototype/cat-app/TabBar.jsx, Sidebar.jsx,
AppV2.jsx (loaded via "CatCode Web App.html"). Rebuild the look/feel in TS/Tailwind on real
data; port zero prototype code.

=== BUILD ===
- **Root state/routing:** the app-level frame — which sessions exist, which is active, which
  page/surface is showing — replacing AppV2's mock glue with a real projection of the host
  API's `HostEvent` stream + P3-4 stores. The transcript spine (P2) renders inside the active
  session's pane unchanged.
- **TabBar:** one tab per LIVE session (SessionDescriptor stream). New-tab → `createSession`;
  cwd comes from the native directory picker requested via the HC3 preload method (HC1: the
  renderer never types a path). Close-tab → `closeSession` (row stays restorable — closing a
  tab must not feel destructive). Per-tab status chips from `SessionDescriptor.status` +
  P3-4's typed failure states; a dead tab offers restart (the existing restart channel,
  app/main/main.ts:287-294).
- **Sidebar:** the session list = live ∪ restorable (`listSessions`), ordered by
  lastAttachedAt; `crashed` rows flagged; selecting a restorable row → `restoreSession` (this
  IS the restore-offer surface REGISTRY §4.4 names — P3-8 gates on it working for real).
  ⚠️ Conflict checkpoint (INVENTORY row): the prototype sidebar shows cost/model/tags/
  workspace — fixture fields. v1 renders what `SessionDescriptor` truthfully has (title, cwd,
  status, recency). For each prototype field you can't back with real data: FLAG it in your
  report (extend-engine vs change-UI), render honestly without it — do NOT mock. Title
  seeding from engine AI-generated titles is a flagged carry (REGISTRY §10): wire read-only if
  cheap, else flag.
- **Keyboard-first switching** (house interaction standard): ⌘1..9 jump-to-tab, plus
  prototype-consistent bindings — match the prototype's shell feel.
- Multi-session UX truths to honor: switching tabs must not lose in-flight streaming (frames
  keep flowing into background sessions' stores — P3-4 guarantees state, you guarantee no
  UI-driven unsubscribe); a permission request in a background session must be visibly
  signaled on its tab (badge/pulse), not silently queued.

=== GROUND RULES ===
Locked decisions + full security baseline; preload changes only via the HC3 fixed-sender
pattern (should already exist from P3-3 — if you need a NEW preload method, apply HC1-HC4 and
say so). TS/Tailwind on the P0-2 tokens; no prototype idioms (no inline style={{}}, no
window-glue). One sitting — if TabBar+Sidebar+routing overruns, land routing+TabBar complete
and STOP, reporting the split.

=== DELIVERABLE / DONE WHEN ===
Headless (yours): `bun test app/` green (routing/store wiring, tab lifecycle state,
restore-offer selectors); renderer tsc clean; sidecar tsconfig no NEW errors.
GUI (operator's — STOP and print exact steps, then wait; do NOT drive it yourself with
cua-driver/claude-in-chrome/any automation): launch command; create TWO sessions in two
different directories via the picker; run a real turn in each; switch tabs — transcripts stay
isolated and correctly attributed; verify two engine PIDs exist (e.g. `pgrep`-based check you
print for the operator, or the sidebar's status data); close one tab and see it reappear in
the sidebar as restorable; kill one sidecar process manually and see the dead-tab affordance.
That checklist IS most of the Phase-3 gate line ("two real sessions in one window, each its
own engine process, switchable") — quit/relaunch restore is P3-8's half.
Update STATUS.md P3-5 row → ✅ + date + one-line note (note operator-verified).

Report back: the root state shape, every prototype-vs-real conflict you flagged (fixture
fields, title seeding), the operator's verification transcript, and any host-API gap you hit
(report it — don't extend the control plane ad hoc).
```
─── PASTE ───

## P3-6 · 🟡 — WorkspaceLayout: 1–3 split panels, resize, drag

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 5/10 · 🖐 GUI

You are running P3-6 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Dependency: P3-5 green (tabbed shell exists). Parallel-safe with P3-7/P3-8. Echo the header
line above back to the operator before starting.

=== CONTEXT (repeat of shared state — you start cold) ===
Electron + N Bun sidecars (locked); the shell (P3-5) hosts N real sessions in tabs; renderer
state is keyed by sessionId (P3-4). This session adds the split-panel layer. Read first:
STATUS.md; decisions/REGISTRY.md §3 exclusions (window/tab LAYOUT is renderer-owned state —
it may reference appSessionIds but lives with the UI; a registry rewrite must never destroy
layout, and vice versa).
Step 0: read INVENTORY.md §W2 row `WorkspaceLayout` (⚓4, adapt — "source backs panel/session
routing; splitter resize chrome is prototype-only").
Step 1 (UX spec): /Users/pt/catcode_prototype/cat-app/WorkspaceLayout.jsx.

=== BUILD ===
- 1–3 side-by-side panels, each hosting any open session's transcript pane; drag a tab to a
  panel edge to split; drag the divider to resize; collapsing back to one panel. Panel
  assignment + widths persist as RENDERER-owned state (registry must not know about layout —
  D1 §3); persistence keyed by appSessionId references that tolerate missing sessions
  (a restored workspace with a reaped session degrades gracefully).
- Two panels showing two different sessions stream concurrently (P3-4 already guarantees the
  state side — you guarantee the render side doesn't assume a single active session).
- Same session in two panels: pick the cheap honest behavior (either allow read-only mirror or
  prevent with a clear affordance) and state which you chose and why — don't build sync
  machinery.

=== GROUND RULES ===
Locked decisions + security baseline; no protocol or host-API changes (pure renderer). Match
the prototype's feel with TS/Tailwind on the P0-2 tokens.

=== DELIVERABLE / DONE WHEN ===
Headless (yours): `bun test app/` green (layout state: split/assign/resize/persist/degrade);
renderer tsc clean; sidecar tsconfig no NEW errors.
GUI (operator's — STOP and print exact steps; never drive it yourself): split to two panels
with two live sessions streaming simultaneously; resize; drag a third; close a panel's session
and watch the layout degrade gracefully; relaunch to confirm layout persistence.
Update STATUS.md P3-6 row → ✅ + date + one-line note.

Report back: where layout state lives, the same-session-twice choice you made, and the
operator's verification result.
```
─── PASTE ───

## P3-7 · 🟡 — CommandPalette + SlashCommandPicker (recon-first)

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 6/10 · 🖐 GUI

You are running P3-7 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Dependency: P3-5 green. Parallel-safe with P3-6/P3-8. Echo the header line above back to the
operator before starting.

=== CONTEXT (repeat of shared state — you start cold) ===
Electron + N Bun sidecars (locked); tabbed multi-session shell exists (P3-5) on the typed
host API (P3-3). The IPC boundary is default-deny with a fixed frame vocabulary
(SECURITY-MINIMUM §2; inbound: app.submit/app.abort/permission.response/app.ping +
P2-4's permission.setMode) — there is NO command-execution channel and you will not add one.
Read first: STATUS.md, decisions/SECURITY-MINIMUM.md, PROTOCOL-ENVELOPE.md E-7 (the additive
pattern P2-4's C2/C3 followed — sidecar-local allowlist + checkStrictKeys — is the ONLY
sanctioned way new vocabulary lands, and only with a decision behind it).
Step 0: read INVENTORY.md §W2 rows: `CommandPalette` (⚓6, adapt — "real command registry,
bridge filtering, and session search are split across source") and `SlashCommandPicker`
(⚓5, adapt — "real CommandBase / typeahead behavior; standalone picker is presentation
split").
Step 1 (UX spec): /Users/pt/catcode_prototype/cat-app/CommandPalette.jsx,
SlashCommandPicker.jsx. Recon the REAL shapes before building: src/commands.ts +
src/commands/ (`CommandBase`), and how the app-runtime session consumes commands — note the
sidecar currently constructs its session with `commands: []`
(app/sidecar/sessionController.ts, createNormalSidecarQueryEngineConfig) — the P1-3
`tools:[]` defect class; verify what P2-4 changed before assuming.

=== BUILD ===
- **CommandPalette (⌘K)** over what is REAL today, all riding existing surfaces: session
  actions (create/switch/close/restore — host API), panel/layout actions (P3-6 if landed,
  else omit), page/surface navigation, and session SEARCH over live ∪ restorable rows
  (SessionDescriptor fields). Fuzzy filter, keyboard-first, prototype look.
- **SlashCommandPicker**: typeahead over the engine's real command catalog attached to the
  composer. ⚠️ CONFLICT CHECKPOINT (this is the judgment part — handle it exactly like this):
  first establish from source how the desktop session can know the command list.
  If the catalog is (or can be) already present in session construction (the `commands`
  config) and surfaced through EXISTING outbound data, wire it. If it genuinely requires new
  wire vocabulary (e.g. a read-only catalog snapshot frame), do NOT invent the frame in this
  session: write the ≤1-page proposal (following the C3 `permission.context` precedent),
  flag it in your report as an extend-engine-vs-change-UI decision for the operator, and ship
  the palette WITHOUT the picker half (typeahead degrades to plain text — the composer still
  submits slash text verbatim through app.submit; W4-Composer owns richer behavior later).
  An honest missing feature beats an undecided protocol addition.
- Insertion/execution path: selecting a slash command inserts/submits text through the
  EXISTING app.submit — command parsing stays engine-side; the renderer never gains a
  command-execution capability (T2/§2 posture).

=== GROUND RULES ===
Locked decisions + security baseline. Zero new frame types without the flagged decision
(above). Palette actions must all be real — no mocked entries, no dead menu items.

=== DELIVERABLE / DONE WHEN ===
Headless (yours): `bun test app/` green (filtering, action dispatch, catalog wiring or its
absence); renderer tsc clean; sidecar tsconfig no NEW errors; hardening tests if you touched
the boundary.
GUI (operator's — STOP and print exact steps; never drive it yourself): ⌘K opens the palette;
session search finds a restorable session; a session action executes; slash typeahead (if
wired) completes a real command against a live session.
Update STATUS.md P3-7 row → ✅ + date + one-line note.

Report back: the real command-catalog path you found (src/…:line), whether the picker shipped
wired or degraded+flagged (and the proposal if so), the palette's action inventory (all real),
and the operator's verification result.
```
─── PASTE ───

## P3-8 · 🔴 — PHASE-3 GATE: lifetime/restore — quit/relaunch + crash-sim (anti-Potemkin)

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 6/10 · 🖐 GUI

You are running P3-8, the Phase-3 GATE session of the CatCode desktop-app migration
(~/cat-code, branch `migration`). Dependency: P3-5 green (P3-1/P3-2/P3-3 transitively).
P3-6/P3-7 are NOT prerequisites. Echo the header line above back to the operator before
starting.

=== CONTEXT (repeat of shared state — you start cold) ===
Electron + N Bun sidecars over Unix sockets; die-with-window v1 (D6 — chosen, not defaulted);
v1 restore = re-spawn + engine-session resume through the engine's real machinery; DR-1
re-attach explicitly WAIVED for v1. This session executes the SUBSTITUTE gate line of
decisions/SESSION-LIFETIME.md §4 — read it verbatim, plus decisions/REGISTRY.md §4 (launch
sequence) and STATUS.md. Your job: prove the lifetime story end to end, fix what breaks, and
certify the gate. The engine-side resume anchors: loadConversationForResume
(src/utils/conversationRecovery.ts:465), processResumedConversation
(src/utils/sessionRestore.ts:493); switchSession (src/bootstrap/state.ts:474) alone is NOT a
resume.

=== THE GATE LINE (D6 §4 — execute as written) ===
With two live sessions (each its own engine process), quit the app and relaunch. Both sessions
are offered for restore from the app-owned registry and, on accept, reopen with their
transcript history intact in fresh engine processes. A host CRASH (SIGKILL Electron) followed
by relaunch must additionally reap the orphaned sidecars and still offer the same restore. An
in-flight turn at quit time is EXPECTED to be lost — the gate asserts the sessions come back,
not the turn.

ANTI-POTEMKIN CLAUSE — "history intact" is proven, not eyeballed: after restore, submit a
prompt whose answer depends on a unique fact stated BEFORE the quit (a nonce the operator
tells the session), and assert (a) the engine answers from restored context, (b) the
transcript file for the SAME engineSessionId now has post-restore entries appended by a NEW
engine PID, and (c) the restore ran through the engine-side resume machinery (the anchors
above). A renderer that merely re-renders old JSONL, or a fresh engine session with pasted-in
history, fails all three.

=== BUILD / VERIFY SPLIT ===
- Worker (you): pre-flight headless checks — full `bun test app/`, both tsc configs (renderer
  clean; sidecar no NEW errors), `bun run --cwd app test:hardening`, and the P3-0 two-sidecar
  smoke still passing. Then write the operator script (below), wait for the report, and
  perform the HEADLESS halves of the anti-Potemkin assertions yourself after each operator
  run: locate the transcript file for each engineSessionId
  (getTranscriptPathForSession, src/utils/sessionStorage.ts:240), verify post-restore entries
  appended under the same engineSessionId, verify the writing engine PID changed, verify via
  logs/registry that the resume path ran (add temporary structured logging if P3-1 didn't
  leave enough evidence — remove or gate it before finishing). Fix any defect found and
  re-run the loop.
- Operator (STOP and print these exact steps; never drive the GUI yourself — no cua-driver,
  no claude-in-chrome, no automation):
  1. Launch; create session A (cwd X) and session B (cwd Y); run one real turn in each; state
     a unique nonce to each session ("the magic word for this session is …A / …B").
  2. Clean quit (⌘Q). Relaunch. Confirm BOTH sessions offered for restore; accept both;
     submit "what was the magic word?" in each — each must answer ITS OWN nonce.
  3. Report engine PIDs (you print the pgrep command) before quit and after restore.
  4. Crash-sim: with both sessions live again, `kill -9` the Electron host PID (you print the
     command); confirm sidecars survived (orphans — die-with-window is behavior, not welding);
     relaunch; confirm the sweep reaped the orphans (processes gone, rows marked crashed) and
     restore is STILL offered and passes the same nonce test.
- **Structural riders (yours, headless — pin against regression):** grep proves
  app/supervisor/ + registry/host modules have zero `electron` imports; the channel is still
  a filesystem socket (no stdio/child-IPC regression); no Phase-3 code path derives session
  lifetime from the WINDOW process's exit (D6 §4 riders).

=== GROUND RULES ===
Locked decisions + full security baseline. This session may fix bugs anywhere in the Phase-3
stack it exposes, but no new features and no scope beyond the gate line. If the gate cannot
pass without reopening a locked decision, STOP and report — do not improvise architecture.

=== DELIVERABLE / DONE WHEN ===
Both operator runs (clean-quit + crash-sim) pass with all three anti-Potemkin assertions
verified by YOU on disk; structural riders green; all headless suites green.
Update STATUS.md: P3-8 row → ✅ + date + note, AND the PHASE 3 header → gate CLEARED (+ date),
noting Phase 4's backlog gets generated next in a separate session per PROGRAM-PLAN §8.

Report back: the full evidence chain per assertion (nonce answers, transcript paths +
appended-entry proof, PID before/after, resume-machinery evidence), what broke and was fixed
en route, rider confirmation, and explicit confirmation nothing re-introduced Tauri/stdio or
reopened a locked decision.
```
─── PASTE ───

---

## PHASE 3 GATE ✅ when P3-0..P3-8 all pass
Two real sessions live in one window, each its own engine process, switchable (P3-5), on an
app-owned durable registry (P3-2/P3-3), with quit/relaunch restore + crash-sweep proven
anti-Potemkin (P3-8, the D6 §4 substitute line). The W2 surface set (tabs, sidebar, routing,
panels, palette) is real. Phase 4 (remaining domains, the most parallel phase) opens next;
generate its backlog then per PROGRAM-PLAN §8.

## Count
**Phase 3: 9 sessions** — P3-0 envelope+smoke, P3-1 spawn/resume ∥ P3-2 registry, P3-3 host
API, P3-4 renderer keying, P3-5 shell, P3-6 panels ∥ P3-7 palette ∥ P3-8 gate.
Tranche 1 (P3-0..P3-3) is host/sidecar-plane and may run before/alongside late Phase 2
(except P2-4 — shared sidecar files); tranches 2–3 (P3-4..P3-8) require the Phase-2 gate.
