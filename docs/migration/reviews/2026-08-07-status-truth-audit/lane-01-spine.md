# Lane 01 — The original spine

**Auditor verdict:** YELLOW
**Rows audited:** 9 · TRUE 7 · OVERSTATED 0 · FALSE 0 · STALE 2 · UNVERIFIABLE-HEADLESS 0

Headline: every P0/P1 row's *load-bearing* claim survives re-derivation from
today's source. The topology, the socket, the Electron-free supervisor, the raw
`AppSessionEvent` seam, the real-engine controller, the security baseline and the
permission round-trip are all live and reachable. Nothing in this lane is a
Potemkin. What has rotted is the **bookkeeping around two Phase-0 artifacts**:
P0-2's `renderer-theme/` is a dead, silently diverging fork of the live token
layer, and P0-4 still advertises a Phase-3 carry-forward that was fixed six weeks
ago plus two drifted anchors. Both would mislead an orchestrator reading STATUS
today.

---

## Row verdicts

### P0-1 — Transport/topology bake-off
**Verdict:** TRUE

**Claims checked:**
1. Chosen topology = Electron + Bun sidecar over local IPC carrying raw `SDKMessage`.
2. Raw-forwarding preserves `tool_use`; the current mapper drops it.
3. N-sidecar spawn + crash-restart proven.
4. `bun --compile` binary (real engine ~159 MB) runs + codesigns.
5. Candidate (c) loopback-WS eliminated.
6. Engine = Bun-only, re-confirmed.
7. Transport contract tightened to JSON-safe payloads.

**Evidence:**
- (1)(6) `app/sidecar/index.ts:266-281` — `Bun.listen({ unix: args.socketPath })`
  with an explicit `throw new Error('sidecar must run under Bun (Bun.listen unavailable)')`
  at `:268-270`. The doc comment at `:7` names D6 pin 1. `app/shared/framing.ts:1-13`
  is the length-prefixed JSON framing over that socket.
- (2)(5) `rg appSessionEventMapper app/` returns **four hits, zero call sites**:
  `app/shared/protocol.ts:19` and `app/sidecar/sidecarServer.ts:13` are doc
  comments saying the mapper is deliberately bypassed, and
  `app/renderer/src/sdkMessageFixtures.ts:423,429` cite it only as a mint-site
  anchor. No WS server or listening TCP port anywhere in `app/`.
- (3) `app/supervisor/supervisor.ts:213` `spawnSession`, `:239` per-session socket
  file, keyed map, restart path present.
- (7) `app/sidecar/sidecarServer.ts:706,720` — `prepareOutboundPayload` (clone +
  JSON-safe) then `send` (secretGuard + size cap), exactly the §6 tightening.

**Reachable-path trace:** operator launches the app → `app/main/main.ts` →
`SessionSupervisor.spawnSession` spawns a Bun child and connects to its UDS →
`app/sidecar/index.ts` binds → `sidecarServer` forwards raw controller events →
preload `CH_SERVER_FRAME` → `app/renderer/src/bridge.ts` → `App.tsx`. This is the
only session path the app has; there is no second transport.

**Anchor drift:** none. TRANSPORT.md's own anchors were re-verified by its author
and I found no stale ones in the sections this row cites.

**Caveat (F4):** claim 4's packaged evidence is **unreproducible**. TRANSPORT.md §2
states the spike lived in `~/cat-code/.spike-p0-1/` and was "throwaway, **not
committed**". That directory does not exist. The compile/codesign leg of the
Phase-0 gate therefore rests entirely on a 2026-07-02 narrative with no artifact.
It does not change the verdict (the topology decision does not hinge on it, and
packaging is a Phase-5 row), but that gate leg cannot be re-checked by anyone.

---

### P0-2 — Design tokens → Tailwind
**Verdict:** STALE — superseded by **P1-0** (adoption), **P1-3** (the Tailwind
import fix), **P4-1/P4-34** (tone + accent tokens) and the **2026-07-13 UI-drift
fix** (tone hexes resolved).

**Claims checked:**
1. Portable Tailwind-v4 `@theme` layer in `renderer-theme/`.
2. Vite smoke harness in `renderer-theme/`; build verified.
3. Accent remains themeable via `--accent`.
4. Unresolved tone hexes are explicit TODOs for P1-0.

**Evidence:**
- (3) **still true, in the live file:** `app/renderer/src/theme.css:44` declares
  `--accent: #f472b6`; `app/renderer/src/main.tsx:24` wraps the whole app in
  `AccentThemeProvider`, which stamps `data-accent` so every `bg-accent` /
  `text-accent` consumer repaints. Themeability survived.
- (1)(2)(4) **the artifact the row points at is dead and has diverged.**
  `rg renderer-theme` across the repo returns **only** docs (`CLAUDE.md`,
  `PROGRAM-PLAN.md`, `STATUS.md`, `backlog/phase0-1.md`, two maps/reviews) plus
  `renderer-theme/`'s own `package.json`/`README`/`bun.lock`. **Zero references
  from any build, test or typecheck script** — I read both `package.json` script
  blocks (root: build/build:dev/build:dev:full/lint/maps:lint/typecheck/compile/dev;
  `app/`: dev/sidecar:dev/renderer:dev/renderer:build/lint:fast-refresh/typecheck/
  test/typecheck:sidecar/test:hardening/reap:orphans/preview:transcript). Nothing
  builds it. `renderer-theme/dist/` is frozen at 2026-07-02 and carries its own
  `node_modules/` + `bun.lock`.
- The two files have materially diverged with no sync mechanism. Token diff
  (`renderer-theme/theme.css` vs `app/renderer/src/theme.css`): the live theme
  **added** `--color-accent-soft`, `--color-shell-{chrome,seam,hover,active}`,
  `--color-source-{user,project,local,policy,flag}`, `--color-surface-{raised,panel}`,
  `--color-text-{faint,ghost}`, `--accent-rgb`, four self-hosted `@font-face`
  blocks and the whole `data-accent` palette set; and **dropped**
  `--color-tone-default` / `--color-tone-accent`, which `renderer-theme/theme.css`
  still exports.
- Claim (4) is resolved **only in the live file**: `app/renderer/src/theme.css:70-73`
  assigns `--tone-good #4ade80 · --tone-warn #fbbf24 · --tone-danger #f87171 ·
  --tone-info #60a5fa`. `renderer-theme/theme.css:6-16` still carries the literal
  `TODO(P1-0)` comment block with all four tones unassigned. A reader who follows
  P0-2's pointer lands on the version where the accent picker's tone system does
  not exist.

**Reachable-path trace:** none for `renderer-theme/` — that is the finding. The
live path is `main.tsx:9 import './theme.css'` → Vite Tailwind plugin → renderer.

**Anchor drift:** the row's only anchor is the directory itself, and it is now a
dead harness that CLAUDE.md §1 already classifies "Do not extend."

---

### P0-3 — Engine TS types importable
**Verdict:** TRUE

**Claims checked:**
1. Portable type-only renderer aliases + fixture in `scripts/typecheck/renderer-engine-types/`.
2. Strict typecheck verified.
3. Direct source aliases pull in the non-isolated engine graph.
4. The commit-`234da9e` snapshot fallback requires P1-0 re-sync.

**Evidence:**
- (1) `scripts/typecheck/renderer-engine-types/tsconfig.json` maps
  `@cat-code/engine/sdk` and `@cat-code/engine/session-events` to the snapshot;
  `fixture.ts:1-2` consumes both with `import type`, under `strict: true` +
  `verbatimModuleSyntax: true`.
- (2) **I ran it:** `bunx tsc --project scripts/typecheck/renderer-engine-types/tsconfig.json --noEmit`
  → **exit 0, no output**. Still green.
- (4) **P1-0 did re-sync, and I checked for hand-edit evidence — found none.**
  `app/shared/engine-types.snapshot.d.ts:73-94` lists all six `AppSessionEvent`
  members (`message`, `goal.snapshot`, `permission.requested`,
  `permission.resolved`, `abort.status`, `turn.status`) matching
  `src/app-runtime/sessionEvents.ts:21,26,31,36,42,53` one-for-one. Its
  `AppPermissionResponse` (`:44-64`) matches the real inferred
  `PermissionToolOutput` field-for-field against
  `src/utils/permissions/PermissionPromptToolResultSchema.ts:42-71` — same two
  branches, same optional `updatedPermissions` / `toolUseID` /
  `decisionClassification` enum. The header at `:11-16` correctly records the
  2026-08-02 `turn.status` re-sync. **This snapshot is honestly maintained.**

**Reachable-path trace:** `app/renderer/src/bridge.ts:7` type-only-imports
`CatCodeBridge` from `app/shared/protocol.js`, which is typed off the snapshot;
`bun run --cwd app typecheck` (lead-measured clean) is the live gate. The P0-3
mechanism is what makes that gate possible in a renderer that cannot see the
engine graph.

**Anchor drift:** none in the row itself.

**Sub-finding (F3):** the P0-3 harness is **half-maintained**.
`scripts/generate-sdk-types.ts:11` still writes the sibling
`sdk-types.snapshot.d.ts` into that dead directory on every regeneration (it was
rewritten today, commit `d85f770`), while the hand-maintained
`engine-types.snapshot.d.ts` beside it has rotted to 83 lines vs `app/shared`'s
142 — missing `turn.status` and the entire `AppClientMessage`/`AppReadyPayload`
section. No script typechecks it (I had to invoke `bunx tsc` by hand). So a
generator keeps a dead harness's file fresh while its neighbour silently drifts.
Already known: CC-25 flags it as "known stale, deliberately untouched". Low.

---

### P0-4 — Multi-session isolation probe
**Verdict:** STALE — the **N-process verdict itself stands and I reproduced it**,
but three of the row's stated open items are superseded.

**Claims checked:**
1. Verdict N-process; single-process needs an out-of-scope engine refactor.
2. The 1-proc stomp is real (A saw B's cwd).
3. Forcing state: `STATE` singleton `state.ts:435`.
4. `STATE.cwd`/`STATE.sessionId` mutated per-submit via `setCwd` `QueryEngine.ts:245`.
5. Permission round-trip is instance state (isolated even 1-proc).
6. ⚠ "2-proc isolates" rows are sequential in-process emulation; two real engines
   never ran concurrent work; N-process sufficiency over shared external state is
   **assumed, not proven**.
7. Carry-forward: Codex token refresh rotates the refresh token with **no
   cross-process lock** (`codex-core/accounts.ts:150-180`) — Phase-3 item.
8. Probe re-run 4 pass / 17 assertions.

**Evidence:**
- (1)(2)(8) **I re-ran the probe** (single focused file, permitted):
  `bun test src/app-runtime/multiSessionIsolation.probe.test.ts` →
  **4 pass / 0 fail / 17 expect() calls**, exactly the claimed numbers, and the
  stomp still reproduces live in stdout: `[P0-4 1-proc] A wanted …/p0-4-A-RtrOK9
  saw …/p0-4-B-dmvIO6`. Claim (5) is exercised in the same file.
- (3) **ANCHOR DRIFT:** `const STATE: State = getInitialState()` is at
  `src/bootstrap/state.ts:445`, not `:435`. `:435` is now inside the
  `getInitialState()` body (`afkModeHeaderLatched`). CC-4 already noticed this
  drift; the P0-4 row was never corrected.
- (4) **ANCHOR DRIFT:** `setCwd` is imported at `src/QueryEngine.ts:74` and
  **called at `:271`**. `src/QueryEngine.ts:245` is now mid-destructuring
  (`isMeta?`/`origin?`/`onInputPersisted?`). `setCwd` itself is
  `src/utils/Shell.ts:447` — the one anchor the row does *not* cite is the only
  one CC-4 got right. The underlying claim (process-global cwd mutated per-submit)
  is still true.
- (6) **RETIRED**, and STATUS itself says so 100 lines further down: the DR-2 block
  at `docs/migration/STATUS.md:177` states the vault path "is now **proven with two
  real processes** (retires P0-4's 'sufficiency assumed, not proven' caveat for
  this file)". The P0-4 row still presents it as open.
- (7) **FIXED, and the anchor now points at unrelated code.**
  `src/codex-core/accounts.ts:398` is `refreshRawUnderCrossProcessLock`, using
  `proper-lockfile` on `join(configHome, 'codex-raw-refresh')` (`:403,:416`) with a
  `lockCompromised` latch and an `assertLockIntact()` guard fired at `:490,:511,
  :553,:588` that **refuses to touch any token store once exclusivity is in
  doubt** (`:410`). Landed in commit `641f8eb`
  ("migration(pre-P3): D1/D6/F3 decisions + DR-2 cross-process refresh fix").
  The cited range `:150-180` is now the redeem-path pool writeback
  (`refreshPoolAccountForRedeem`), which has nothing to do with the claimed hole.

**Reachable-path trace:** the N-process decision is enforced by
`app/supervisor/supervisor.ts:213` `spawnSession` — one Bun child per sessionId,
keyed map — which is the only way a session is created. The verdict is live, not
just recorded.

**Anchor drift:** two (claims 3 and 4), plus one anchor pointing at code that no
longer contains the defect it names (claim 7).

---

### P1-0 — Scaffold: Electron + Bun sidecar + IPC frame
**Verdict:** TRUE

**Claims checked:**
1. Fresh renderer in `app/` (React 19 + Vite + Tailwind v4, P0-2 theme + P0-3 snapshot re-synced).
2. IPC = Unix-domain socket, length-prefixed JSON framing (NOT stdio/child-IPC).
3. Supervisor is Electron-free; spawn/kill/restart keyed by sessionId.
4. Sidecar builds the real `AppSessionController` via `createQueryEngineSessionController`.
5. Raw-forwards `AppSessionEvent`, NOT `appSessionEventMapper`.
6. `tool_use` frame round-trips sidecar → supervisor → main intact.
7. Protocol v1 has a `sessionId` slot (F3).
8. Security baseline: sandbox / contextIsolation / nodeIntegration-off, CSP, nav + `window.open` lockdown, default-deny 4-channel preload.
9. T4, T6, T6b, T7 all implemented + unit-tested.
10. macOS `sun_path` 104-byte limit forced a short socket dir.

**Evidence:**
- (2) `app/shared/framing.ts:1-13` (doc: "Unix-domain socket between the Electron
  supervisor and a Bun sidecar"), `:20-26` `encodeFrame` writes a 4-byte
  big-endian length prefix, `:41` `FrameDecoder(maxFrameBytes)`.
- (3) **`rg "from 'electron'" app/supervisor/` returns zero hits.** Still clean
  after 5 phases. `supervisor.ts:213` spawn keyed by sessionId, `:150` monotonic
  socket sequence.
- (4) `app/sidecar/sessionController.ts:3` imports `createQueryEngineSessionController`
  from `src/app-runtime/`, used at `:528`; the normal path also uses
  `createRuntimeBackedWebAppSession` (`:4`, `:586`). Real engine, no stub.
- (5) verified as in P0-1: four doc-comment/fixture mentions, zero call sites.
- (7) `app/shared/protocol.ts:75` `export const PROTOCOL_VERSION = 1 as const` —
  still v1 after ~40 documented additive changes (`:385`, `:462`, `:539` each
  record "additive under v1, NO `PROTOCOL_VERSION` bump"). The versioning
  discipline P1-0 set up is actually being followed.
- (8) `app/main/main.ts:697` CSP header; `:756-760`
  `sandbox: true, contextIsolation: true, nodeIntegration: false,
  nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false`;
  `:802` `will-navigate` guard; `:812` `setWindowOpenHandler`.
- (9) **T7** `sidecarServer.ts:1418` prompt cap in UTF-8 bytes (not JS chars),
  `:1477` depth bound, per-frame + per-window caps. **T4**
  `:1433-1455` — `goalSnapshot` arrives as `z.unknown()` and goes through
  `parseThreadGoal` with a fail-closed diagnostic. **T6** `:2350-2368,:2397` —
  renderer `updatedInput` accepted only if it CONFIRMS the gated input. **T6b**
  `:2390-2397` — `updatedPermissions` stripped on allow with a logged
  `stripped updatedPermissions … (T6b)`, and `:2337-2343` is the ONLY path that
  puts `updatedPermissions` on a boundary response, re-attaching the engine's own
  `structuredClone(selection.updates)`. **Directional caps not swapped:**
  `MAX_FRAME_BYTES` is used inbound at `:580` (`new FrameDecoder(MAX_FRAME_BYTES)`)
  and `MAX_OUTBOUND_FRAME_BYTES` outbound at `:2084`. `secretGuard` imported at
  `:69` and applied on the outbound send path (`:706`).
- (10) `supervisor.ts:182-199` documents the `sun_path` bound and derives
  `/tmp/catcode-<pid>`; `:236-239` uses a short `s<N>.sock` name, not the UUID,
  and fails loudly rather than letting the sidecar throw a cryptic listen error.

**Reachable-path trace:** every later row in the program rides this seam; the
trace is the one given under P0-1 and it is the app's only session path.

**Anchor drift:** none — the row cites files, not lines.

**Superseded detail (nit, not a finding):** "default-deny **4-channel** preload"
is now ~35 channels (`app/preload/preload.ts:91-361`). The *posture* the row
claims (contextBridge allowlist, no raw command/FS passthrough) is intact and
`preloadSource.test.ts` still enforces it; the count is ordinary phase growth.

---

### P1-1 — Connect, get `app.ready`
**Verdict:** TRUE

**Claims checked:**
1. Normal Electron startup launches `createRuntimeBackedWebAppSession` → `createQueryEngineAppSession` → real `QueryEngine`.
2. IPC ready payload carries canonical `type: 'app.ready'`.
3. Renderer shows only `connecting` → `ready`, from both discriminants.
4. Probe remains opt-in via `CATCODE_SIDECAR_PROBE=1`; no credentials/turn used.
5. ⚠ Temporarily hardcodes cwd `/Users/pt/cat-code`; replace in a later phase.

**Evidence:**
- (1) `app/sidecar/sessionController.ts:4` imports `createRuntimeBackedWebAppSession`
  from `src/app-runtime/`, used at `:586`; the config is built by
  `createQueryEngineAppSessionConfigFromSetup` (`:2`, `:372`). Real engine path,
  not a fixture.
- (2)(3) `app/renderer/src/connectionState.ts:11-13` — the status union's only
  entries relevant here are `'connecting'` and `'ready'`; `:316-322` is the
  both-discriminants guard: `candidate.kind === 'ready' && candidate.payload.type
  === 'app.ready'`. `:221` is where status flips to `ready`.
- (4) `app/sidecar/index.ts:98` `const probeOnAttach = process.env.CATCODE_SIDECAR_PROBE === '1'`
  — still opt-in, still off by default.
- (5) **RESOLVED by P3-1** (which STATUS records separately): cwd now comes from
  `app/sidecar/index.ts:104` `process.env.CATCODE_SIDECAR_CWD`, with fail-loud
  guards at `:107` (missing) and `:116` (not a directory). `P1_1_CWD` and
  `app/shared/sessionConfig.ts` are gone.

**Reachable-path trace:** app launch → supervisor spawn → sidecar attach → ready
frame → `connectionState` reducer → the connection chip / session pane gate in
`App.tsx`. This is what the user sees the instant the window opens.

**Anchor drift:** none.

**Finding (F5, Low):** the row's ⚠ reads as an **open** defect but has been closed
for a month. An orchestrator scanning P0/P1 for carry-forwards would re-dispatch
work that is already done.

---

### P1-2 — Submit prompt, raw stream
**Verdict:** TRUE

**Claims checked:**
1. A real credentialed Codex turn completed end-to-end through renderer → Electron IPC → UDS sidecar → `AppSessionController.submit`, no fixture/probe.
2. Raw `<pre>` received 17 SDK messages of the enumerated kinds.
3. First-turn bootstrap runs engine `init()` + dev `MACRO`.
4. Serializer omits undefined optional object fields on its clone while retaining fail-closed JSON/secret guards.

**Evidence:**
- (1)(2) are a **2026-07-03 operator observation**; not re-derivable headless and
  not worth burning a credentialed turn to re-witness, because the same path is
  re-proven continuously by later live probes
  (`app/sidecar/roundtrip.probe.test.ts` crosses a real UDS). The *surface* the
  row observed on still exists: `app/renderer/src/rawMessageLog.ts`, consumed at
  `App.tsx:433` (store init), `:2042`/`:2360`/`:2368` (`selectRawMessageLog`) and
  mounted at `:3164`. So the observation was made against a real, still-present
  view, not a scratch page.
- (3) **true but relocated:** `app/sidecar/initializeRuntime.ts:42` `await init()`,
  with the `MACRO` define fallback at `:13-26`. It is no longer "first-turn" —
  `app/sidecar/index.ts:38` imports `initializeSidecarRuntime` and runs it at
  sidecar startup, and three workers (`accountsPoolWorker.ts:88`,
  `sessionsCatalogWorker.ts:48`, `transcriptBackfillWorker.ts:74`) dynamic-import
  it too. Same effect, earlier and broader. Nit-level drift.
- (4) `app/sidecar/sidecarServer.ts:706` — "prepareOutboundPayload (clone +
  JSON-safe) and send (secretGuard + size cap)", called at `:596` for the ready
  payload and `:720` on the general path. `scanForSecrets` imported at `:69`.
  Fail-closed guards intact.

**Reachable-path trace:** composer submit → preload `CH_SUBMIT`
(`preload.ts:91`) → main → supervisor → UDS → `sidecarServer` inbound validation
(`:1418` T7 cap) → `controller.submit` → engine → events back through
`prepareOutboundPayload` → `CH_SERVER_FRAME` → projector → transcript.

**Anchor drift:** none (row cites no line numbers).

---

### P1-3 — First adapter slice (text + tool_use)
**Verdict:** TRUE

**Claims checked:**
1. Live-verified by operator, 2 runs: real `tool_use` rendered as tool cards with full structured input, plus markdown text rows.
2. Projector entry point = `app/renderer/src/transcriptProjector.ts`; reducer over raw `AppSessionEvent`; blocks narrowed at runtime, **zero casts**.
3. Defect 1 fixed: sidecar session had `tools: []`; now `getTools()` from the SAME `toolPermissionContext` the runtime enforces → 28 tools.
4. Defect 2 fixed: `theme.css` never imported Tailwind — every utility class silently no-opped since P1-0.
5. Carry-forward: `tsc -p app/sidecar/tsconfig.json` red independent of this work.

**Evidence:**
- (2) `app/renderer/src/transcriptProjector.ts` exists and is imported by
  `App.tsx:83`. **Zero-casts claim holds:** `rg " as [A-Z][A-Za-z]"` over the file
  returns exactly one hit, `:699`, and it is the English word "as" inside a prose
  comment ("as ONE grouped card"). No type assertions in projector code.
- (3) **verified at HEAD, not just the dirty tree** (`sessionController.ts` is
  modified by a concurrent session):
  `git show HEAD:app/sidecar/sessionController.ts` → `:301`
  `const tools = getTools(appStateStore.getState().toolPermissionContext)`.
  `getTools` is imported from `src/tools.js` at `:24`, and the comment at `:563`
  states the same store the runtime enforces
  (`QueryEngine reads getAppState().toolPermissionContext`). This is the
  CLAUDE.md §8 rule-1 pattern done correctly — real engine source, not a stub.
- (4) `app/renderer/src/theme.css:1-5` — the `@import 'tailwindcss'` is present
  **with the original defect preserved in the comment above it**: "Without this
  import … every className in the renderer silently no-ops (found in P1-3;
  P1-0/P1-2 shipped without it)." The fix is load-bearing and self-documenting.
- (5) still the known-red baseline CLAUDE.md §3 documents; not a finding.

**Reachable-path trace:** engine `tool_use` block → raw `AppSessionEvent` over UDS
→ `CH_SERVER_FRAME` → `transcriptProjector` reducer (`App.tsx:83`) → tool row →
transcript view. The `getTools` fix is what makes the model *able* to emit the
block in the first place, so the path is proven from producer to pixel.

**Anchor drift:** none.

---

### P1-4 — One permission round-trip
**Verdict:** TRUE (headline), with one behavioural sub-claim superseded — see F2.

**Claims checked:**
1. Live-verified: real `Bash({command:"date"})` paused for the renderer prompt; `Enter` sent allow with the required `updatedInput` echo; the tool returned real output; the turn resumed to `result:success` with zero denials.
2. Permission state is separate from the transcript projector.
3. `Enter` allow, `N`/`⌫` deny, `Esc` **dismiss**.
4. No resolving flash.
5. T6 echo-only and T6b `updatedPermissions` rejection/strip remain covered by sidecar boundary tests.
6. Canonical `can_use_tool` mapped cleanly; no unmatched permission variant.

**Evidence:**
- (2) confirmed: `app/renderer/src/permissionState.ts` is its own module, distinct
  from `transcriptProjector.ts`; the prompt renders from it via
  `App.tsx:4299-4300` (`onAllow={allowPermission} onDeny={denyPermission}`),
  handlers defined at `:2608` and `:2620`.
- (5) confirmed live at the boundary, not just in tests:
  `app/sidecar/sidecarServer.ts:2350-2368` documents and enforces T6
  (`updatedInput` may only CONFIRM the gated input), `:2390-2397` strips
  renderer-authored `updatedPermissions` on allow, and `:2312`/`:2337-2343`
  re-attach the ENGINE's own update objects for the always-allow path. The
  renderer genuinely cannot author a permission rule.
- (1)(4)(6) are operator observations from 2026-07-03; the machinery they observed
  is present and reachable, and P2-4 later re-verified the same path 8/8 through
  the real stack.
- (3) **SUPERSEDED — see F2.** `app/renderer/src/PermissionPrompt.tsx:278-282`:
  `case 'deny': // Escape and n/⌫ refuse without touching the cursor`, calling
  `onDeny()`. Escape now **denies**, it does not dismiss. And `Enter` is now
  `case 'confirm'` at `:274-276`, resolving the **cursor-selected option**
  (`pickAt(Math.min(cursor, count - 1))`) in a multi-option list, not an
  unconditional allow.

**Reachable-path trace:** engine `can_use_tool` → `permission.requested` event →
UDS → `CH_SERVER_FRAME` → `permissionState` → `PermissionPrompt` mounted from
`App.tsx:4299` → user keystroke → `allowPermission`/`denyPermission` →
`CH_PERMISSION` (`preload.ts:105`) → sidecar T5a/T6/T6b validation → engine
resumes. Full loop, both directions, all anchors confirmed.

**Anchor drift:** none (row cites no line numbers), but one behavioural claim is
stale.

---

## Findings

| # | Severity | Row | Defect | Evidence | Failure scenario |
|---|---|---|---|---|---|
| F1 | Medium | P0-2 | `renderer-theme/` is a dead, silently diverging fork of the live token layer. Zero references from any build/test/typecheck script (both `package.json` script blocks read); its `theme.css` still carries the unassigned `TODO(P1-0)` tone block and still exports `--color-tone-default`/`--color-tone-accent` that the live theme dropped, while lacking `--accent-rgb`, `--accent-soft`, all `--color-shell-*`/`--color-source-*`/`--color-surface-*` tokens, the self-hosted `@font-face` set and the whole `data-accent` palette. Frozen `dist/` + own `node_modules/` + `bun.lock` from 2026-07-02. | `renderer-theme/theme.css:6-16` vs `app/renderer/src/theme.css:44-73`; `rg renderer-theme` → docs + its own package files only | An agent told "P0-2 owns the token pipeline" edits `renderer-theme/theme.css`, sees `bun run --cwd app renderer:build` stay green, and ships a change that reaches no pixel. This is the built-but-never-rendered class applied to CSS. |
| F2 | Medium | P1-4 | STATUS advertises permission keys that were reversed by later work: the row says "`Esc` dismiss", but Escape now **denies** the request. `Enter` is likewise no longer a bare allow — it confirms the cursor-selected row of a multi-option list. | `app/renderer/src/PermissionPrompt.tsx:278-282` (`case 'deny': // Escape and n/⌫ refuse`), `:274-276` (`case 'confirm': pickAt(...)`) | Anyone writing GUI acceptance steps or docs from the P1-4 row will instruct an operator to "press Esc to dismiss the prompt" — which **denies the tool call** and can abort a real turn. Wrong in the destructive direction. |
| F3 | Low | P0-3 | The P0-3 harness is half-maintained: `scripts/generate-sdk-types.ts:11` still regenerates `sdk-types.snapshot.d.ts` into the dead directory (rewritten today in `d85f770`), while the hand-maintained `engine-types.snapshot.d.ts` beside it has rotted to 83 lines vs `app/shared`'s 142 — missing `turn.status` and the whole `AppClientMessage`/`AppReadyPayload` section. No script runs its typecheck. | `scripts/typecheck/renderer-engine-types/engine-types.snapshot.d.ts` (83 lines, ends at `abort.status`) vs `app/shared/engine-types.snapshot.d.ts:73-94`; `scripts/generate-sdk-types.ts:11` | A future session re-reads the harness as a reference for the event union and writes renderer code against a union missing `turn.status`. Already known (CC-25 flags it), so the cost is confusion, not breakage. |
| F4 | Low | P0-1 | One leg of the Phase-0 gate is unreproducible: the `bun --compile` / codesign evidence lived in `~/cat-code/.spike-p0-1/`, which TRANSPORT.md §2 states was "throwaway, **not committed**" and no longer exists. | `docs/migration/decisions/TRANSPORT.md` §2; no `.spike-p0-1/` in the tree | Nobody can re-check that the real engine compiles and codesigns until Phase-5 packaging actually does it. The topology decision does not depend on it, so this is a record-keeping gap, not a defect. |
| F5 | Low | P1-1 | The row's ⚠ "temporarily hardcodes cwd `/Users/pt/cat-code`; replace with session-owned cwd in the later shell/session phase" reads as open but was closed by P3-1. | `app/sidecar/index.ts:104-116` (`CATCODE_SIDECAR_CWD` + fail-loud guards); `P1_1_CWD` and `app/shared/sessionConfig.ts` gone | An orchestrator sweeping P0/P1 for carry-forwards re-dispatches finished work. |
| F6 | Low | P0-4 | Two drifted anchors plus one anchor naming a defect that no longer exists there. `state.ts:435` → actual `src/bootstrap/state.ts:445`. `QueryEngine.ts:245` → `setCwd` called at `src/QueryEngine.ts:271` (imported `:74`; the real definition is `src/utils/Shell.ts:447`, which the row does not cite). The Phase-3 carry-forward "`codex-core/accounts.ts:150-180` … no cross-process lock" was fixed in `641f8eb`; that range is now unrelated redeem-path code. The "sufficiency assumed, not proven" caveat is retired by the DR-2 block at `STATUS.md:177`. | `src/bootstrap/state.ts:445`; `src/QueryEngine.ts:271`; `src/codex-core/accounts.ts:398-416,490` (`refreshRawUnderCrossProcessLock`, proper-lockfile + `assertLockIntact`) | The oldest surviving open-risk note in the program describes a hole that was plugged six weeks ago. A session dispatched against it finds nothing to fix and burns a turn deciding whether STATUS or source is right. |

---

## Operator steps required (UNVERIFIABLE-HEADLESS rows only)

None. Every row in this lane was settled from source, one focused test run
(`src/app-runtime/multiSessionIsolation.probe.test.ts`, 4 pass / 17 assertions)
and one focused typecheck
(`bunx tsc -p scripts/typecheck/renderer-engine-types/tsconfig.json --noEmit`,
exit 0). The 2026-07-03 credentialed-turn observations behind P1-2/P1-3/P1-4 are
historical, but each is re-proven continuously by machinery I confirmed present
and reachable, so none of them needs a fresh GUI sitting to hold its ✅.

---

## Nits

- P1-0's "default-deny **4-channel** preload" is now ~35 channels
  (`app/preload/preload.ts:91-361`). The default-deny posture and its enforcing
  test (`preloadSource.test.ts:124-145`) are intact; only the count is stale.
- P1-2's "**first-turn** bootstrap runs engine `init()` + dev `MACRO`" now runs at
  **sidecar startup** (`app/sidecar/index.ts:38` → `initializeRuntime.ts:42`), and
  three workers dynamic-import it as well. Same effect, earlier.
- User-visible text rules: clean on this lane's surfaces. `rg '—'` over
  `PermissionPrompt.tsx`, `PermissionQueue.tsx`, `connectionState.ts` returns four
  hits, all inside JSX `{/* … */}` comments (`PermissionPrompt.tsx:317,337,400,429`).
  No em dash in any rendered string, no engineering notes on screen.
- Concurrent edits in flight during this audit (context, not findings):
  `app/main/main.ts`, `app/sidecar/sessionController.ts`,
  `app/sidecar/permissionDomain.ts`, `app/renderer/src/PermissionRulesEditor.tsx`
  and others are dirty from other sessions. The P1-3 `getTools` claim was
  therefore verified against `git show HEAD:` rather than the working tree.
