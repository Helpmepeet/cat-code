# Migration backlog — Phase 0 + Phase 1 (the first batch)

> ✅ **REGENERATED 2026-07-02 against the P0-1 decision.** The earlier version was stale (it
> assumed Electron-in-process + a WS-mapper fix). **P0-1 is now DECIDED** (`decisions/TRANSPORT.md`,
> verified against source): topology = **Electron + Bun sidecar, raw `SDKMessage` over local IPC**.
> Phase 1 below is rewritten for that topology. **Key change: there is NO mapper fix** — the
> IPC path *bypasses* `appSessionEventMapper` entirely (the raw stream already exists at the
> controller seam). The old "fix the mapper before P1-3" line is void.

**Created 2026-06-26; regenerated 2026-07-02.** The concrete, pasteable session list, generated
from `INVENTORY.md` + `decisions/TRANSPORT.md` per `PROGRAM-PLAN.md` §8. Phase 0 (inventory +
P0-1 done) and Phase 1 (walking skeleton on Electron+sidecar). **7 sessions** (3 + 4).

> **Two carry-forward landmines from P0-1's review — every Phase-1 IPC session must honor them:**
> 1. **JSON-safe payloads.** Assert outbound sidecar payloads are POJO at the serializer; reject/
>    log a Buffer/`Date`/`Map`/`bigint`/cyclic value rather than let `JSON.stringify` corrupt it.
>    (No current producer emits these; cheap insurance.)
> 2. **Event immutability.** `AppSessionController.emit()` (`AppSessionController.ts:192`) hands the
>    *same* mutable `event` reference to every listener — clone-on-serialize / never mutate once
>    there is >1 subscriber.

## How to use
Paste **one** block into a fresh agent session, in order. Each is self-contained. Respect
the dependency note — don't start a session whose deps aren't green. Mark `[x]` when done
and update the surface's row in `INVENTORY.md`.

## Standing rules (apply to every session below)
- **Step 0 — read your surface's row in `INVENTORY.md`**: disposition (`port`/`adapt`/
  `build-new`), `⚓ ❌` (recon source first — no anchors), `Faked? yes` (a behavioral spec
  must exist before wiring). The row is your marching order; don't re-derive it.
- **Step 1 — read the prototype surface + its `// SOURCE:` anchors** (the UX + shape spec).
- **Source wins.** Where prototype and `~/cat-code/src` disagree, source is the contract;
  the adapter absorbs the gap. **Surface real engine-vs-UX conflicts to the user** — don't
  silently resolve (case-by-case rule).
- **Production-grade** (TypeScript, Tailwind, real tests via `bun test`). No prototype idioms
  (no inline `style={{}}`, no `window`-glue, no browser-Babel).
- **Code home:** a fresh renderer build in `~/cat-code` (PROGRAM-PLAN §0 wins: the old `web/`
  scaffold is **treated as empty / deprecated**, NOT reused in place). P1-0 owns the final folder
  name/location; the P0-2 theme (`~/cat-code/renderer-theme/`) + P0-3 type aliases
  (`~/cat-code/scripts/typecheck/renderer-engine-types/`) get installed into whatever P1-0 picks.
- **One sitting.** If a block feels too big mid-session, stop and split it — don't degrade.
- **Verify before "done."** State what runs and what you checked.
- **The HUMAN operator drives the GUI — the worker never does.** Any verification that needs a
  click, a keystroke in the running app, launching/screenshotting the Electron app, or browser
  interaction: the worker **STOPS and prints exact instructions** for the operator (the command to
  run, what to click, what to look for) and waits for the operator's report back. The worker must
  **NOT** use `cua-driver`, `claude-in-chrome`/`mcp__claude-in-chrome__*`, or any computer/browser
  automation to do it itself — the operator does it faster. Automated checks the worker CAN run
  headless (`bun test`, typecheck, build) are still the worker's job; this rule is only about
  live GUI/browser steps.

Tier: 🟢 mechanical · 🟡 extend-pattern · 🔴 net-new state/architecture. `❓ spec-first` = confirm behavior before building.

🧠 **Per-session tag** = `Model: CLAUDE (visual-design|system-architecture) | ANY · Difficulty: N/10`.
**Model = CLAUDE** only when the task's core is visual-design or system-architecture *judgment*
(topology, boundaries, data-model/protocol decisions); everything else = **ANY** (model doesn't
matter). **Difficulty** is just a 1–10 score — the operator picks reasoning effort from it.
Implementing an already-decided architecture is mechanical (ANY); designing it is CLAUDE.
Append **`· 🖐 GUI`** to the header only when the session needs the operator to drive a live
GUI/browser step; a headless-verifiable session carries no GUI tag (presence-only).

---

## PHASE 0 — transport decided + foundations stand up
*Gate to clear before Phase 1: P0-1 topology ✅ · P0-2 tokens ✅ · P0-3 types ✅ · **P0-4 isolation probe ⬜** · **P0-5 security minimum ⬜**. The isolation + security spikes (canonical IDs P0-4/P0-5 — see STATUS.md / PROGRAM-PLAN §4; they were briefly mislabeled P0-2/P0-3) are separate sessions, not in this file's numbered blocks yet.*

### P0-1 · ✅ DONE 2026-07-02 — Transport & shell decided
🧠 **Model: CLAUDE (system-architecture) · Difficulty: 9/10**
**Decision:** **Electron + Bun sidecar, raw `SDKMessage` over local IPC.** (c) loopback-WS
eliminated on evidence (it's the only candidate that drops `tool_use` today). Packaged probes
proved: raw-forwarding preserves `tool_use`; N-sidecar spawn + crash-restart; a `bun --compile`
engine binary (~159MB) runs with no Bun on PATH and codesigns. Bun-only re-confirmed at source.
Adversarial review passed. **Full record + verified anchors: `decisions/TRANSPORT.md`.**
**Downstream effect:** no mapper fix (IPC bypasses `appSessionEventMapper`); Phase 1 rewritten below.

### P0-2 · 🟡 — Design tokens → Tailwind config
🧠 **Model: ANY · Difficulty: 3/10**
**Dependency:** none (parallel with P0-1).
**Goal:** Port the prototype's theme into `web/`'s Tailwind v4 so every later session styles against real tokens.
- Source tokens (from `CatCode Web App.html` `<style>` + CLAUDE.md): bg `#09090b`, text
  `#f4f4f5`/`#a1a1aa`/`#71717a`, **pink accent `#f472b6`** (as `--accent`, overridable),
  fonts DM Sans (UI) / DM Mono (code).
- Put them in the Tailwind theme + a global CSS layer in `web/src/index.css`. Keep the
  `--accent` CSS-var indirection so the accent stays themeable.
**Done when:** `bun run build` (in `web/`) succeeds; a throwaway test element shows the bg, accent, and fonts.

### P0-3 · 🟡 — Engine TS types available to the UI
🧠 **Model: ANY · Difficulty: 4/10**
**Dependency:** none (parallel).
**Goal:** Make the real engine types (`SDKMessage` + the `app-runtime`/`appProtocol` shapes) importable from the UI, so the adapter and rows are typed against truth.
- Confirm `web/src/appProtocol.ts` vs. the real `src/app-runtime/sessionEvents.ts` +
  the `SDKMessage` re-export at `src/entrypoints/agentSdkTypes.ts` (it re-exports from
  `sdk/coreTypes.generated.ts` — import the entrypoint, not the generated file). Decide:
  import from the engine package, or vendor a typed mirror. Prefer importing real types.
- ⚠️ **Real work, not a checkbox:** `web/` is a separate package (`cat-code-web`) whose
  `tsconfig` only includes `src` — so an `import type { SDKMessage }` from `~/cat-code/src`
  needs a tsconfig path / project-reference (or a vendored mirror). That's the actual fork
  this session resolves.
- **Deliverable:** UI code can `import type { SDKMessage }` and typecheck.
**Done when:** `bun run typecheck` passes with a sample type reference to `SDKMessage`.

---

## PHASE 1 — the walking skeleton (the make-or-break gate)
*One real session, one real message in/out (incl. a tool_use), one real permission, on the
Electron + Bun-sidecar topology. No fidelity. Proves the RICH seam walks over IPC — not a lossy
text chat.*
**Dependency for all of Phase 1:** P0-1 ✅ (topology decided). P0-2 (tokens) + P0-3 (types) land
before P1-3 (rendering). **No mapper fix exists or is needed** — the IPC path bypasses
`appSessionEventMapper`; the raw stream is taken straight from the controller seam.
**Every IPC session honors the two P0-1 landmines** (JSON-safe payloads; immutable emitted event).

**Dependency chain / parallelism:**
```
P1-0 ──▶ P1-1 ──▶ P1-2 ──┬──▶ P1-3   (render text + tool_use)
                          └──▶ P1-4   (permission round-trip)
```
- **Strictly serial:** P1-0 → P1-1 → P1-2 (each needs the prior). This is the spine — don't parallelize it.
- **P1-3 ∥ P1-4 CAN run in parallel** — both depend only on P1-2, not on each other (different
  surfaces: transcript projector vs. permission UI; neither consumes the other's output). One
  operator could spawn them as two concurrent sessions. Both do touch renderer + IPC plumbing, so
  if run truly concurrently expect a small merge at the end; sequential is also fine.

> **These five blocks are pasteable verbatim.** Each block between the `─── PASTE ───` markers is
> a complete cold-agent prompt (tag, context, anchors, rules, deliverable, done-when).
> Respect the dependency chain above. Re-verify anchors against `~/cat-code/src` (fork drifts).

### P1-0 · 🔴 — Scaffold: Electron shell + headless Bun sidecar + IPC frame

─── PASTE ───
```
🧠 Model: CLAUDE (system-architecture) · Difficulty: 7/10

You are running P1-0 (the walking-skeleton scaffold) of the CatCode desktop-app migration, inside
the ~/cat-code repo. This is the FIRST real app-code session. Read this whole brief first.

=== CONTEXT ===
CatCode is a shipped desktop app rebuilt on the real cat-code engine. Phase 0 is DONE and decided
the architecture (authoritative: /Users/pt/catcode_prototype/PROGRAM-PLAN.md;
topology in decisions/TRANSPORT.md; security contract in decisions/SECURITY-MINIMUM.md; live status in
STATUS.md — read all four). The decision: **Electron shell + a headless Bun engine sidecar, with
the raw `SDKMessage` stream forwarded over local IPC.** The engine is Bun-only, so it is a
separate process under any shell. You build the EMPTY topology here — the pipe, no engine turn yet.

=== GOAL ===
An Electron app whose main process spawns one headless Bun sidecar, with a raw-`SDKMessage` IPC
frame between them, and a renderer that confirms the channel is open. No prompt/turn yet (that's P1-2).

=== BUILD ===
- **Code home:** a FRESH renderer build in ~/cat-code (PROGRAM-PLAN §0: the old `web/` scaffold is
  DEPRECATED / treated as empty — do NOT reuse it in place). You choose the final folder name/layout
  and state it. Install the P0-2 theme (`~/cat-code/renderer-theme/`) and P0-3 type aliases
  (`~/cat-code/scripts/typecheck/renderer-engine-types/`) into it.
- **Sidecar entrypoint (net-new, small):** a headless Bun process that constructs the real
  `AppSessionController` via the SAME builders the CLI uses — `createRuntimeBackedWebAppSession`
  (`src/app-runtime/createRuntimeBackedWebAppSession.ts:11`) / `createQueryEngineAppSession`
  (`src/app-runtime/createQueryEngineAppSession.ts:22`). It must NOT import
  `AppSessionWebSocketServer` or `appSessionEventMapper` (those flatten the stream — we route around them).
- **Outbound framing = raw-forwarding:** subscribe to the controller (`AppSessionController.ts:63`
  `subscribe(listener)`) and ship the whole `AppSessionEvent` (incl. `event.message: SDKMessage`),
  one JSON frame per event, over the IPC channel (a filesystem socket — pinned below, see D6/DR-1;
  NOT stdio/child-IPC/MessagePort).
  ⚠️ **Landmine 1 (JSON-safe):** assert each payload is a POJO at the sidecar boundary; reject/log a
  Buffer/Date/Map/bigint/cyclic value rather than let JSON.stringify corrupt it. ⚠️ **Landmine 2
  (immutability):** `AppSessionController.emit()` (`AppSessionController.ts:192`) hands the SAME
  mutable event ref to every listener — clone-on-serialize / never mutate.
- **Electron main = supervisor:** spawn/kill/restart the sidecar; ONE sidecar now, but structure it
  so N-sidecar (P0-4's N-process verdict) is a map, not a rewrite.
- **Security is an ACCEPTANCE CRITERION, not optional (implement decisions/SECURITY-MINIMUM.md):** Electron
  sandbox + contextIsolation + no nodeIntegration; CSP for any rendered content; restricted
  navigation/`window.open`. Preload exposes ONLY the default-deny allowlist (the 4 channel types,
  `.strict()`, everything else rejected). Close the source-holes P0-5 handed you: **T4** re-type
  `app.submit.options.goalSnapshot` from `z.unknown()` to the real schema + `safeParse` before it
  touches session identity; **T6** treat renderer `updatedInput` as echo-only (reject a rewrite of
  the gated input); **T6b** reject/strip `updatedPermissions` on an allow
  (`PermissionPromptToolResultSchema.ts:96-105` persists it via `persistPermissionUpdates` — a forged
  allow else installs durable always-allow rules); **T7** enforce max frame size + rate cap.
- ⚠️ **Design the frame with a `sessionId` slot NOW.** The P0-5 allowlist has no session-addressing
  yet, but P0-4 mandates N processes — bake `sessionId` into protocol v1 so Phase 3 needn't break it
  (PHASE0-REVIEW F3).
- ⚠️ **Unfuse the host from the window (D6 / DIRECTION-REVIEW DR-1). The channel choice is NOT
  "your call" — it is pinned, for a product reason.** Cat Code's identity is an **always-on** agent
  that outlives its control surface (`README.md:7-10`, `GOAL_PLAN.md:16-22`); if the sidecar is a
  parent-bound pipe, sessions die with the window and every Phase-5 auto-update kills live agent
  work. So:
  1. **IPC channel = a filesystem (Unix-domain) socket** — NOT stdio and NOT a child-IPC pipe
     (both are parent-bound). Note: an Electron `MessagePort` **cannot be handed to a non-Electron
     Bun child at all**, so that option in the raw-forwarding bullet above is not feasible — the
     socket is the choice, not a menu. A socket *file* (not a listening TCP port) adds no network
     surface, so P0-5's allowlist applies unchanged.
  2. **Supervisor = an Electron-free module** (own folder/package, zero `electron` imports) that
     Electron main *calls*. Its spawn/attach/restart/registry API is the host API; the window is
     client #1 of it. This is what lets the server-Mac milestone (`GOAL_PLAN.md:75`) attach a
     daemon to the same supervisor instead of rebuilding Phase 3.
  3. **Session lifetime — D6 is DECIDED: die-with-window for v1** (owner ruling 2026-07-02). So
     v1 does NOT need reattach-after-quit, detached-daemon lifecycle, or survive-the-window
     behavior — build the simplest thing. BUT the ruling was explicitly "accept die-with-window
     *behavior*, do NOT weld the sidecars to the window": pins 1 (socket) and 2 (Electron-free
     supervisor) above are **still required**, because they keep the always-on flip a future
     attach rather than a Phase-3 rewrite. Do not "simplify" by collapsing the supervisor into the
     Electron main process or switching to a stdio pipe — that would trade a reversible v1 default
     for an irreversible one.

=== GROUND RULES ===
- Work on the single long-lived branch `migration` (already exists; never commit to main).
- Production-grade TS/Tailwind — no prototype idioms. Source wins; re-verify anchors before relying on them.

=== DELIVERABLE / DONE WHEN ===
`electron .` (or the dev launch) starts, spawns a REAL Bun sidecar that loads engine code, the
Electron security baseline is on, and a hand-injected raw `SDKMessage` frame (incl. a `tool_use`
block) round-trips sidecar→main→renderer INTACT. Update STATUS.md P1-0 → ✅ + date + note.

Report back: the folder layout you chose, **the IPC mechanism (must be a filesystem socket per
D6 — confirm it, not stdio/child-IPC), whether the supervisor module is Electron-free (no
`electron` imports),** that the tool_use frame survived intact, and whether the security baseline
+ T4/T6/T6b/T7 are in place.
```
─── PASTE ───

### P1-1 · 🔴 — Connection: sidecar attaches, renderer gets `app.ready`

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 5/10

You are running P1-1 (connection handshake) of the CatCode desktop-app migration, inside ~/cat-code.
Dependency: P1-0 (the Electron + Bun-sidecar + IPC scaffold) must be green. Read STATUS.md +
decisions/TRANSPORT.md first.

=== GOAL ===
The sidecar's real `AppSessionController` emits the real ready handshake over IPC, and the renderer
shows "ready" built from real data. Single session, hardcoded cwd is fine. No prompt yet.

=== BUILD ===
- On attach, the sidecar emits `app.ready` with the SAME payload the WS server sends
  (`src/web/AppSessionWebSocketServer.ts:79-86`): `{type:'app.ready', protocolVersion:1,
  inputEnabled, activeTurn, abort: controller.getAbortState(), goalSnapshot:
  controller.getGoalSnapshot(), pendingPermissionRequests: controller.getPendingPermissionRequests()}`
  — just over IPC, not `ws`. Reuse the shape; don't invent one.
- Renderer renders NOTHING but connection state: connecting → ready (from the real payload).

=== GROUND RULES ===
- Branch `migration`; never main. Re-verify the `app.ready` anchor against source (fork drifts).
- No mocks — the "ready" must be built from the real handshake.

=== DELIVERABLE / DONE WHEN ===
Launching the app connects to a real engine session and shows "ready" derived from the real
`app.ready` payload. Update STATUS.md P1-1 → ✅ + date + note.

Report back: that app.ready arrived from the real controller (not faked), and the payload fields you observed.
```
─── PASTE ───

### P1-2 · 🔴 — Submit one real prompt, receive the real stream over IPC

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 4/10

You are running P1-2 (first live engine turn) of the CatCode desktop-app migration, inside
~/cat-code. Dependency: P1-1 green. ⚠️ **This needs a real Codex/ChatGPT account** — it is the
FIRST live, credentialed engine turn (P0-1 proved the seam with a fixture; this proves it
end-to-end for real, closing that gap). Read STATUS.md + decisions/TRANSPORT.md first.

=== GOAL ===
Send a prompt to the real engine and receive the real `SDKMessage` stream back over IPC (incl.
streaming deltas). No pretty rendering yet — a raw dump is the deliverable.

=== BUILD ===
- Wire a bare text input → an `app.submit` frame (schema `src/web/appSessionProtocol.ts:13`,
  transport-agnostic, reused over IPC) → `controller.submit` (`AppSessionController.ts:127`). The
  controller emits each message via `createMessageEvent` (`:149`, `:166`); your P1-0 raw-forwarding
  serializer ships them to the renderer.
- Renderer shows a `<pre>` dump of the raw `SDKMessage` events it receives (assistant,
  partial-assistant deltas, result). Confirm deltas stream (not one final blob).
- ⚠️ The `app.submit.options.goalSnapshot` must go through the T4 `safeParse` from P1-0 — don't
  regress it to `z.unknown()`.

=== GROUND RULES ===
- Branch `migration`; never main. Re-verify anchors (fork drifts). No mocks — a real model turn.

=== DELIVERABLE / DONE WHEN ===
Typing a prompt produces a real assistant response STREAMED from the engine over IPC, visible raw
in the renderer (deltas included). Update STATUS.md P1-2 → ✅ + date + note.

Report back: that a live credentialed turn streamed real SDKMessages over IPC, the variant types
you saw (assistant / stream_event / result), and any JSON-safe-payload issue that surfaced.
```
─── PASTE ───

### P1-3 · 🔴 — Render a real message AND a real tool_use through the adapter

─── PASTE ───
```
🧠 Model: CLAUDE (system-architecture) · Difficulty: 7/10 · 🖐 GUI

You are running P1-3 (first adapter slice) of the CatCode desktop-app migration, inside ~/cat-code.
Dependency: P1-2 green, plus P0-2 (tokens) + P0-3 (types) installed. This is the SEED of the whole
anti-corruption adapter (PROGRAM-PLAN §5, layer 2 — the transcript projector). Read PROGRAM-PLAN §5
+ decisions/TRANSPORT.md first. (No "mapper fix" needed — the IPC path already delivers raw
`SDKMessage`; that's what P0-1 settled.)

=== GOAL ===
Stand up the first slice of the projector against the RICH message: map one real assistant **text**
message AND one real **`tool_use`** content block → rendered rows.

=== WHY tool_use, NOT just text (do not skip) ===
A text-only P1-3 would pass even if the transport secretly dropped structured content — the gap
would then detonate in Phase 2 as an empty tool card. Rendering a REAL `tool_use` here is the cheap
insurance that the rich IPC seam carries structured content end-to-end through the RENDERED path
(P0-1 proved it at the seam with a fixture; this proves it live, rendered).

=== BUILD ===
- Adapter input: the `AppSessionEvent` stream (`src/app-runtime/sessionEvents.ts` — the `message`
  member carries `SDKMessage`). Map to view models: `{role, content}` for a text block; a minimal
  tool-card view `{toolName, input}` derived from a `tool_use` content block. Read block
  discriminants without casts (assistant content is typed `unknown[]` — see TRANSPORT-DECISION §6:
  ~19 union members / ~25 runtime variants; you handle only text + tool_use here, but structure the
  projector so the other variants are a `switch` to extend, not a rewrite).
- Render text via `react-markdown`; render the tool card as a bare styled box using the P0-2 tokens
  (bg, `--accent`, DM Sans/Mono). NO fidelity yet — structure over polish.
- Mark this file/module as the projector entry point (later W3 domains plug in through their own
  selectors, never by extending the projector — §5 layer 3).

=== GROUND RULES ===
- Branch `migration`; never main. TS/Tailwind, no prototype idioms. Re-verify anchors (fork drifts).
- **GUI verification = operator drives, you don't.** To confirm the live render, STOP and print the
  exact steps for the human (command to launch the app, what to click, what to look for), then wait
  for their report. Do NOT use cua-driver, claude-in-chrome, or any computer/browser automation to
  drive the app yourself. Headless checks (bun test / typecheck / build) are still yours to run.

=== DELIVERABLE / DONE WHEN ===
A real assistant reply renders as a styled text row AND a real `tool_use` renders as a tool card —
via the adapter, from a live turn — proving rich content survives the transport through to the UI.
Update STATUS.md P1-3 → ✅ + date + note.

Report back: the projector's shape (how variants extend), that a real tool_use rendered from a live
turn (not a fixture), and any SDKMessage variant that didn't map cleanly.
```
─── PASTE ───

### P1-4 · 🔴 — Resolve ONE real permission round-trip
<!-- was ❓ spec-first; behavior is now fully confirmed (schema anchors below + P0-5), so it's build-ready, not spec-first -->


─── PASTE ───
```
🧠 Model: ANY · Difficulty: 6/10 · 🖐 GUI

You are running P1-4 (one real permission round-trip) of the CatCode desktop-app migration, inside
~/cat-code. Dependency: P1-2 green. This is the last walking-skeleton session — it drives the real
`onPermissionRequest ⇒ Promise<response>` seam end to end. Read STATUS.md + decisions/SECURITY-MINIMUM.md first.

=== GOAL ===
Trigger a tool that requires permission, catch the real `permission.requested`, show a bare
allow/deny prompt, send the real `permission.response`, and confirm it un-pauses the real engine.

=== BUILD ===
- The controller wires `onPermissionRequest` (`AppSessionController.ts:34`) →
  `waitForPermissionResponse` (`:162`); pending requests are exposed via
  `getPendingPermissionRequests` (`:78`) and resolved via `respondToPermissionRequest` (`:87`).
- The renderer sends a `permission.response` frame (schema `appSessionProtocol.ts:33`, over IPC);
  the sidecar calls `respondToPermissionRequest` to un-pause the engine.
- ⚠️ **Exact payload (verified — a bare allow is REJECTED):**
  allow = `{ behavior: "allow", updatedInput: request.request.input }` — `updatedInput` is REQUIRED
  (`PermissionPromptToolResultSchema.ts:47`, `updatedInput: z.record(z.string(), z.unknown())`);
  deny = `{ behavior: "deny", message: "<reason>" }` (`:66-68`). Never send `{behavior:"allow"}` alone.
- ⚠️ **Honor the P1-0 security constraints:** `updatedInput` is ECHO-ONLY — the renderer confirms/
  denies, it may NOT author a different command (T6); reject/strip any `updatedPermissions` (T6b).
- **Keyboard-first** (the reference interaction for the whole permission domain): `Enter` = allow,
  `N`/`⌫` = deny, `Esc` = dismiss. Show the key-hint inline. NO "resolving" flash — resolve
  synchronously on keypress (see the prototype's permission center + CLAUDE.md design system).

=== GROUND RULES ===
- Branch `migration`; never main. Re-verify anchors (fork drifts). Real round-trip, no mock queue.
- **GUI verification = operator drives, you don't.** The permission round-trip needs a live keypress
  in the running app — STOP and print the exact steps for the human (command to launch, what to
  press, what to look for), then wait for their report. Do NOT use cua-driver, claude-in-chrome, or
  any computer/browser automation to drive it yourself. Headless checks (bun test / typecheck /
  build) are still yours to run.

=== DELIVERABLE / DONE WHEN ===
A real tool pauses on a permission; your allow/deny (via keyboard) actually un-pauses the real
engine and the turn continues. Update STATUS.md P1-4 → ✅ + date + note. If P1-0..4 are all ✅,
note in the Phase-1 header that the gate is CLEARED and Phase 2 opens.

Report back: that a real tool paused + resumed on your decision, that allow used the required
`updatedInput` echo shape, and that T6/T6b were honored.
```
─── PASTE ───

---

## PHASE 1 GATE ✅ when P1-0..4 all pass
The Electron app drives a real cat-code session over the Bun sidecar: scaffold stands (P1-0),
connects (P1-1), prompts + streams over IPC (P1-2), renders a real message **incl. a real
`tool_use` card** (P1-3, proving rich content survives IPC end-to-end — the fixture-only gap
from P0-1 now closed with a live turn), and resolves a real permission (P1-4). **The seam is
proven on the packaged topology — make-or-break #1 retired.** Phase 2 (transcript spine +
Permissions) opens next; write its backlog then.

---

## Count
**Phase 0: 3 sessions** — P0-1 transport ✅ DONE, P0-2 tokens, P0-3 types (P0-2/3 independent, parallel).
**Phase 1: 5 sessions** — P1-0 scaffold (**new**, from P0-1's topology), P1-1 connect, P1-2 stream,
P1-3 render, P1-4 permission.
**Batch total: 8 sessions** to a proven walking skeleton (was 7; P0-1's Electron+sidecar choice
adds the P1-0 scaffold the old reused-`web/` plan didn't need).

Remaining to the Phase-1 gate: **P0-2, P0-3, P1-0..4** (7 sessions).
