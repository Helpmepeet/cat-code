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
  `shutdown == null`: probe enginePid — alive+identity → orphaned sidecar → v1 policy KILL
  (SIGTERM; D6 §2), dead/recycled/identity-mismatch → nothing; either way mark `crashed`
  and retain advisory `enginePid`/`socketPath` so restore can refuse while a prior writer
  still matches identity.
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

> **SPLIT into P3-5a + P3-5b (decided 2026-07-05).** P3-5 was the first Difficulty-8 session and
> its own prompt named a fault line ("land routing+TabBar, land Sidebar separately if it
> overruns"). We split it deliberately along that seam — BY SURFACE, not by layer — so each half
> is a complete, independently GUI-verifiable unit and each is easier to build and review
> (8/10 → 6/10 + 6/10). Both go to the SAME strong model (CLAUDE/visual-design), run IN ORDER
> (5b depends on 5a's shell frame), NOT parallel. The guardrail that makes the split better and
> not worse: **5b must EXTEND 5a's established visual language, not invent a second one** — the
> shell must read as one designed system. Anchors below were re-verified against HEAD on
> 2026-07-05 (the original block's `main.ts:287-294` restart anchor had drifted → now `:56`/`:385`;
> the real `SessionDescriptor` field set is pinned so the fixture-field conflict is exact).
> The original single-session prompt is preserved in git history (this file pre-2026-07-05) if the
> whole-session form is ever wanted.

### P3-5a · 🔴 — Shell frame + TabBar (live sessions, switch, close, dead-tab)

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 6/10 · 🖐 GUI

You are running P3-5a of the CatCode desktop-app migration (~/cat-code, branch `migration`).
This is the FIRST of two halves of the P3-5 shell (split for scope + reviewability): 5a builds
the shell frame + TabBar (live sessions, switching, close, dead-tab); 5b adds the Sidebar +
restore-offer. You establish the shell's visual language; 5b extends it. Dependencies: P3-3
(host API) AND P3-4 (renderer keyed by sessionId) — both green. Echo the header line back to the
operator before starting.

=== CONTEXT (you start cold) ===
Electron + N Bun sidecars over Unix sockets, raw fidelity, die-with-window v1 — all locked. The
plumbing exists and is the surface you build on:
- Typed host API reachable from the renderer via FIXED preload senders (app/preload/preload.ts):
  pickDirectory() → one-time cwd token (HC1: renderer NEVER types a path), createSession(cwdToken,
  title?), closeSession(appSessionId), listSessions() → SessionDescriptor[], subscribeHost(cb) →
  HostEvent stream, restoreSession(id) [that one is 5b's]. All typed; failures are HostError
  values (invalid_cwd / session_not_found / session_limit / spawn_failed / registry_unavailable),
  never thrown strings.
- SessionDescriptor (app/shared/hostApi.ts:68) truthfully has: appSessionId, engineSessionId|null,
  cwd, title|null, status ('spawning'|'ready'|'disconnected'|'exited'), restorable, createdAt,
  lastAttachedAt. That is the ENTIRE truth surface — render only these.
- P3-4 keyed every renderer store by sessionId with a root-owned activeSessionId; background
  frames can't steal focus. You consume that; you don't re-key it.
- Restart channel: app/main/main.ts (CH_RESTART='catcode:restart' :56, host.restartSession :385).
Read first: STATUS.md, decisions/REGISTRY.md §6.1, SECURITY-MINIMUM Addendum (HC1/HC3).
Step 0: INVENTORY §W2 rows TabBar (⚓4) + Root state/routing (AppV2.jsx, ⚓7 — "prototype root is
mock glue").
Step 1 (UX spec, NOT code to port): /Users/pt/catcode_prototype/cat-app/AppV2.jsx + TabBar.jsx
(via "CatCode Web App.html"). Rebuild the look/feel in TS/Tailwind on the P0-2 tokens; port zero
prototype code, no inline style={{}}.

=== BUILD (5a scope) ===
- **Root state / routing:** the app-level frame — which sessions exist, which is active, which
  surface shows — as a real projection of the host API's HostEvent stream + P3-4 stores,
  replacing AppV2's mock glue. The P2 transcript spine renders unchanged inside the active
  session's pane. This is where you set the shell's visual grammar (chrome, spacing, the frame)
  that 5b will inherit — design it as a system, not a one-off.
- **TabBar:** one tab per LIVE session (from the SessionDescriptor/HostEvent stream). New-tab →
  pickDirectory() then createSession(token) (HC1). Switch tabs (must NOT unsubscribe or lose
  in-flight streaming into background sessions — P3-4 guarantees the state, you guarantee no
  UI-driven teardown). Close-tab → closeSession (the row stays restorable — closing must not feel
  destructive; 5b surfaces its return). Per-tab status chip from SessionDescriptor.status +
  P3-4's typed failure states; a dead/exited tab offers restart (CH_RESTART). A permission request
  in a BACKGROUND session must be visibly signaled on its tab (badge/pulse), never silently queued.
- **Keyboard-first switching:** ⌘1..9 jump-to-tab + prototype-consistent bindings; match the
  prototype's shell feel.

=== GROUND RULES ===
Locked decisions + full security baseline; preload only via the HC3 fixed-sender pattern (exists
from P3-3 — a NEW method needs HC1-HC4 + a flag). No prototype idioms. If you hit a host-API gap,
REPORT it — never extend the control plane ad hoc.

=== DELIVERABLE / DONE WHEN ===
Headless (yours): bun test app/ green (routing/store wiring, tab lifecycle state, HostEvent
projection); renderer tsc clean; sidecar tsconfig no NEW errors.
GUI (operator's — STOP, print exact steps, wait; do NOT drive it yourself via cua-driver/
claude-in-chrome/any automation): launch command; create TWO sessions in two different
directories via the picker; run a real turn in each; switch tabs — transcripts stay isolated and
correctly attributed, neither turn's streaming is lost on switch; confirm TWO engine PIDs exist
(print a pgrep check for the operator); close one tab — it leaves the bar (its reappearance in
the sidebar is 5b); kill one sidecar process manually — the dead-tab restart affordance appears.
ALSO (host-plane review A watch-item — the shared settings-write race is first reachable with two
live sessions): have BOTH sessions approve a permission with "always allow", then have the
operator inspect .cat-code/settings.local.json — confirm BOTH rules landed, file not torn / no
rule lost. If a write is lost/torn, FLAG it (do NOT fix — it's an engine-side persistPermissionUpdates
concern) for P3-8.
Update STATUS.md P3-5a row → ✅ + date + one-line note (operator-verified).

Report back: the root state shape + the shell visual grammar you established (so 5b extends it),
the operator's verification transcript, the settings-write observation (both rules, or a flagged
race), and any host-API gap you hit.
```
─── PASTE ───

### P3-5b · 🔴 — Sidebar + restore-offer (live∪restorable, real restore)

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 6/10 · 🖐 GUI

You are running P3-5b of the CatCode desktop-app migration (~/cat-code, branch `migration`).
This is the SECOND half of the P3-5 shell: 5a built the shell frame + TabBar; you add the Sidebar
+ the restore-offer surface. Dependency: P3-5a green (the tabbed shell exists). Echo the header
line back to the operator before starting.

>> DESIGN CONTINUITY (the reason this split must not make the shell worse): 5a established the
>> shell's visual language — chrome, tokens, spacing, the frame's grammar. EXTEND it; the Sidebar
>> must read as one designed system with the TabBar, not a bolted-on second panel. Read 5a's
>> components first and inherit their idioms before designing anything new. If you find yourself
>> inventing a parallel visual language, stop and reuse 5a's.

=== CONTEXT (you start cold) ===
Same locked stack as 5a. The surfaces you consume:
- listSessions() → SessionDescriptor[] and subscribeHost(cb) → HostEvent (app/preload/preload.ts).
- restoreSession(appSessionId) → re-spawns the engine for a restorable row (THIS is your restore
  trigger; it's real now — see below).
- SessionDescriptor (app/shared/hostApi.ts:68): appSessionId, engineSessionId|null, cwd,
  title|null, status, restorable (true when no process is live but the row+transcript can be
  re-spawned), createdAt, lastAttachedAt. That is the ENTIRE truth surface.
Read first: STATUS.md, decisions/REGISTRY.md §4.4 (restore-offer) + §6.1 + §10 (title seeding),
decisions/RESTORE-HISTORY.md.
Step 0: INVENTORY §W2 row Sidebar (⚓4 — "prototype cost/model/tags/workspace are FIXTURE fields").
Step 1 (UX spec): /Users/pt/catcode_prototype/cat-app/Sidebar.jsx — look/feel only, port no code.

>> RESTORE IS REAL (host-plane review A, since the backlog was written): F1 seeds a resumed
>> session's history into the engine, F2 replays it to the renderer as replay:true event frames
>> (decisions/RESTORE-HISTORY.md) — your active pane already renders those unchanged. So selecting
>> a restorable row genuinely brings back its prior transcript; the operator can verify real
>> restored history, not an empty re-spawn. P3-8 gates on this working end to end.

=== BUILD (5b scope) ===
- **Sidebar:** the session list = live ∪ restorable (listSessions), ordered by lastAttachedAt;
  status/crashed state shown (a row with status 'exited'/'disconnected' + restorable:true is the
  restore candidate). Selecting a restorable row → restoreSession(id) → it becomes a live tab in
  5a's TabBar with its restored transcript. This IS the restore-offer surface (REGISTRY §4.4).
  The live/restorable projection updates off the HostEvent stream, not a poll loop.
- **Fixture-field conflict (do this honestly, do NOT mock):** the prototype sidebar shows cost /
  model / tags / workspace. SessionDescriptor has NONE of these — they are fixture fields. Render
  ONLY the real fields (title, cwd, status, recency). For EACH prototype field you drop, FLAG it
  in your report as extend-engine-vs-change-UI (the C3 precedent). Render honestly without it.
- **Title seeding (REGISTRY §10 carry):** a row's title may be null. If the engine's AI-generated
  session title is cheaply readable, wire it READ-ONLY; if not, flag it and fall back to a
  truthful label (e.g. the cwd basename). Do not invent titles.

=== GROUND RULES ===
Locked decisions + security baseline; preload only via HC3 fixed senders. Extend 5a's design, no
new visual language. No prototype idioms / no inline style. Host-API gap → REPORT, don't extend.

=== DELIVERABLE / DONE WHEN ===
Headless (yours): bun test app/ green (sidebar list selectors, live∪restorable projection,
restore-trigger wiring); renderer tsc clean; sidecar tsconfig no NEW errors.
GUI (operator's — STOP, print exact steps, wait; NO automation): with the app running, close one
tab (from 5a's TabBar) → it appears in the Sidebar as a restorable row; select it → it restores
as a live tab AND its prior transcript renders (the pre-close messages are back — this is the
F1+F2 restore proof at the UI); confirm a crashed session (kill its sidecar) shows as restorable/
crashed-flagged in the Sidebar. (Full quit/relaunch restore is P3-8, not here.)
Update STATUS.md P3-5b row → ✅ + date + one-line note (operator-verified). If 5a and 5b together
complete the shell, note in the Phase-3 header that the gate's "switchable shell" half is met
(quit/relaunch restore remains P3-8).

Report back: the Sidebar design (confirm it extends 5a's language), every fixture-field you
flagged (cost/model/tags/workspace + title-seeding disposition), the operator's restore-verification
transcript (did prior history actually render?), and any host-API gap.
```
─── PASTE ───

## P3-H · 🟡 — GUI-verification dev harness (added 2026-07-05; runs BEFORE P3-6)

> **Out-of-backlog addition (2026-07-05).** The P3-5a/5b GUI runs exposed the native folder
> picker (NSOpenPanel) as THE agent-verification blocker; ~15–20 GUI runs remain across
> P3/P4/P5. Requirements: `../2026-07-05-gui-harness-proposal.md`. Design:
> `../2026-07-05-gui-harness-design.md` (rev 2 — pressure-tested same day, all findings
> applied, rulings closed in its §11). The session IMPLEMENTS the decided design.
> P3-6 is the harness's first real GUI consumer — run this first.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 4/10

You are running P3-H of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (repeat of shared state — you start cold) ===
CatCode is a desktop app rebuilt on the real cat-code engine: Electron shell + one headless
Bun engine sidecar PER SESSION over per-session Unix-domain sockets, raw `SDKMessage`
fidelity — all locked. Phase 3 built the multi-session shell (P3-0..P3-5b ✅). GUI acceptance
runs are driven by agents via macOS AX, and every failure so far happened at the app↔OS
boundary — the native folder picker (NSOpenPanel) destroyed a full agent dispatch on
2026-07-05. This session builds the dev/test harness that removes that boundary from what
GUI rows re-test, WITHOUT weakening the security baseline.

THE SPEC IS DECIDED — implement it, do not redesign:
- docs/migration/2026-07-05-gui-harness-design.md (rev 2 — pressure-tested 2026-07-05, all 8
  findings applied; §11 records the closed rulings). Read IN FULL; every decision you need is
  in it: D1–D5 mechanisms, the gating table (§6), export schema (§3), file plan (§8),
  verification plan (§7), docs deliverables (§9).
- docs/migration/2026-07-05-gui-harness-proposal.md — requirements + the NON-NEGOTIABLE §4
  constraints (migration security baseline) and §5 verification-honesty rules.
Read also: decisions/SECURITY-MINIMUM.md (esp. Addendum T8/HC1–HC4), STATUS.md P3-H row.

=== BUILD (summary of the design's §8 file plan — the design doc is authoritative) ===
1. D1 picker bypass: `CATCODE_TEST_CWD_ALLOWLIST` (+ `CATCODE_INITIAL_CWD` sugar) resolved
   ONCE at startup into a frozen DevHarnessConfig (unconditionally disabled when
   `app.isPackaged`); cyclic cursor; fail CLOSED — flag set ⇒ `dialog.showOpenDialog` is
   unreachable; an invalid/vanished entry → null pick + loud log, NEVER the dialog, NEVER
   skip-ahead. The resolved dir still runs `validateCwd` + the one-time token mint
   (main.ts:416-508) — the renderer surface stays byte-identical.
2. D2 defaultPath (unconditional product fix): `pickDirectory(activeSessionId?)` — the hint
   is an HC2-validated id resolved against `host.listSessions()`, NEVER a path; fallback =
   most-recently-attached live cwd, then undefined.
3. D3 debug-state export: ONE new FIXED one-way channel `catcode:debug:shell-state`. Sender
   compiled OUT of the packaged preload (build-electron.ts emits preload.cjs with
   `__CATCODE_DEV_HARNESS__=false` + preload.dev.cjs with true; main selects by
   `!app.isPackaged`); main registers the handler ONLY when dev AND `CATCODE_DEBUG_STATE=1`;
   renderer pushes only under `import.meta.env.DEV`, computed from the SAME selectors the UI
   renders (shellState/sidebarState/tabStatus/permissionState) INCLUDING the visible strings
   (tab title, sidebar title/subtitle, permission prompt title + rendered suggestion labels
   — the full tool input object stays OUT). Main strictly validates every push
   (`parseDebugSnapshot`: exact version, bounded arrays/strings, enum checks, unknown-key
   reject → drop + loud log) before an atomic 0600 write to
   `<claude-config-home>/desktop/debug/state.json` (the registry's config-home derivation +
   temp+fsync+rename idiom, registry.ts:160-170; dir 0700). Dual timestamps
   writtenAt/rendererStateAt.
4. D4 dev app name: `app.setName('Cat Code Dev')` dev-only + a dev-only
   `page-title-updated` preventDefault (index.html's `<title>CatCode</title>` otherwise
   overwrites the window title after load); source-test that nothing depends on
   `app.getPath('userData')`.
5. D5 readiness: a LATCH — first `ready-to-show` AND first renderer-ready (either order) —
   emits exactly one stable stdout line `[main] renderer ready` (prefix is the contract);
   the first export write fires with it. "The state is there" is the export PREDICATE
   (poll until it parses and shows the expected row), never the log line.
6. Docs (§9): NEW docs/migration/process/GUI-VERIFICATION.md (launch recipe, flags,
   readiness latch + export predicate, export schema + rendererStateAt freshness rule, the
   proposal's four §5 honesty rules verbatim); PATCH backlog/phase3.md — P3-8 gains the
   real-picker rider (beside the settings-race rider), P3-6/P3-7 gain the aria-label
   convention line + a GUI-VERIFICATION.md pointer.

=== GROUND RULES ===
Locked decisions + FULL security baseline (standing rules at the top of this file). The §4
constraints are not preferences: the renderer never authors a path in ANY mode; everything
dev-only is double-gated (`!app.isPackaged` AND env), and packaged builds contain NO
reachable debug path (sender stripped from the packaged preload bundle AND handler
unregistered); preload stays default-deny — extend the HC3 pins in preloadSource.test.ts
DELIBERATELY (new counts, new channel constant, the pickDirectory hint arg, no-new-invoke)
and add the bundle-level strip test; ZERO new engine-socket frames; registry is READ-only
here (a read-only row accessor is fine, no new write points). app/ is its own package — use
its scripts, never root build:dev:full. Re-verify every anchor in the design doc before
relying on it; source wins. Deviating from the pressure-tested design requires a stated
reason in your report — never a silent redesign.

=== DELIVERABLE / DONE WHEN (headless — all yours; the design's §7) ===
- `bun test app/` green with the new suites: devHarness (cursor / broken-state fail-closed /
  latch both orders / parseDebugSnapshot strictness / defaultPath hint+fallback),
  debugStateReport (selector parity incl. visible strings), preload pins + the bundle strip
  test (packaged preload.cjs contains no `catcode:debug:` string; preload.dev.cjs does),
  mainSource double-gate test, 0600 writer test.
- `bunx tsc --noEmit -p app/tsconfig.json` clean; `-p app/sidecar/tsconfig.json` no NEW
  errors (pre-existing ≈5.5k red is known).
- `bun run --cwd app test:hardening` — MUST re-run (preload touched): the exact packaged
  bridge-key assertion (hardening-smoke.ts:172) passes UNCHANGED — that untouched assertion
  IS the proof no debug key leaked into packaged builds — plus a new no-export-file
  assertion.
- Scripted demo `app/scripts/harness-demo.ts` — runs the DEV renderer (the scripts/dev.ts
  Vite pattern; the hardening runner's production renderer build would eliminate the DEV
  push path): launch with all three flags against a temp dir → wait for the readiness line
  → poll the export until the initial-cwd session is `ready` (assert file mode 0600) →
  assert the post-load window title is 'Cat Code Dev' → drive the REAL full path via
  `webContents.executeJavaScript` (`window.catcode.pickDirectory()` →
  `createSession(token)`) → assert the export shows TWO same-cwd sessions with two distinct
  pids. Paste its output in your report. This scripted Electron run is YOURS (house
  precedent: the hardening smoke) — it is not an operator-GUI step; no
  cua-driver/claude-in-chrome/browser automation anywhere.
- Docs deliverables landed (GUI-VERIFICATION.md + both backlog patches).
- Update STATUS.md P3-H row → ✅ + date + one-line note.

Report back: the frozen-config surface as landed; proof the bypass path still runs
validateCwd + the token mint (test names); the two-bundle preload mechanics; the parser's
rejection behavior; the demo output; confirmation the hardening exact-keys assertion passed
unchanged; the docs patches; and any anchor drift or (justified) design deviation.
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
Read `docs/migration/process/GUI-VERIFICATION.md` before the GUI section. Any new
status-bearing panel/splitter/session element must carry an aria-label with session identity
+ state so the operator can cite an AX-observed label.
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
Read `docs/migration/process/GUI-VERIFICATION.md` before the GUI section. Any new
status-bearing palette/session result element must carry an aria-label with session identity
+ state so the operator can cite an AX-observed label.
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
Read `docs/migration/process/GUI-VERIFICATION.md` before planning the GUI/operator section.
Use the harness for readiness waits, multi-session state cross-checks, PID correlation, and
debug-export/registry forensics; the real-picker requirement below is the production-path
counterweight, not a substitute for the harness plan.

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
     At least one session must be created through the REAL native picker (not the P3-H
     allowlist bypass) so the production create path is still exercised.
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

=== RIDERS (2026-07-05 lifetime/restore review + postmortem rec 2) ===
- Scratch registry: run the gate under a scratch CLAUDE_CONFIG_DIR so historical rows
  (hardening/smoke runs write into the real registry) don't pollute the two-session Sidebar
  assertions. Verify first that credentialed turns work from a scratch home (Codex tokens are
  vault-held); if they don't, copy the minimal credential files in, or fall back to
  ack-closing stale rows before operator step 1 and say so in the report.
- Evidence for "resume machinery ran": capture/tee Electron main's stderr for the
  `[sidecar] resume-seeded messages=N engineSessionId=…` line (app/sidecar/index.ts) on every
  restore — it is the ONLY durable artifact of anti-Potemkin clause (c/d); file it with the
  report, don't just eyeball it.
- Restart-in-place step (safe only because LR-1 is fixed — host.restartSession now threads
  the row's engineSessionId as the resume id): with a session that has history, use the tab's
  RESTART affordance (not Sidebar restore) and re-run the nonce test. Pre-LR-1 this was the
  documented Potemkin path (renderer keeps rendering history the fresh engine lost); the gate
  must prove it no longer is.
- Regression companion (land headless, so the lifetime line survives after this gate closes):
  (a) the LR-7 chained test — ONE real registry file driven through markLiveCleanSync → fresh
  SessionRegistry → launch() sweep/reap → restorable() → restoreSession → real resume (every
  hop is tested separately today; the chain is not); (b) a descriptor state-machine invariant
  test — random legal event sequences through the host fold + reduceShellState asserting
  "a close eventually removes the tab", "tab ⇒ live record ∨ tombstone", "restorable ⇒
  engineSessionId ≠ null". Derive the legal-transition vocabulary from REAL supervisor/host
  guarantees, NOT from FakeSupervisor's orderings (it emits a synchronous kill-exit the real
  supervisor never can — the exact divergence that hid the P3-5b bug).

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
**Phase 3: 9 sessions + P3-H** (out-of-backlog harness addition 2026-07-05, runs before
P3-6) — P3-0 envelope+smoke, P3-1 spawn/resume ∥ P3-2 registry, P3-3 host
API, P3-4 renderer keying, P3-5 shell (split 5a/5b), P3-H dev harness, P3-6 panels ∥ P3-7
palette ∥ P3-8 gate.
Tranche 1 (P3-0..P3-3) is host/sidecar-plane and may run before/alongside late Phase 2
(except P2-4 — shared sidecar files); tranches 2–3 (P3-4..P3-8) require the Phase-2 gate.
