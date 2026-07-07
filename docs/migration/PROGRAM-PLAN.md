# CatCode migration — program plan (big picture)

**Status: AUTHORITATIVE (2026-06-26).** This supersedes the 2026-06-19 doc set
(`MIGRATION-STRATEGY.md`, `MIGRATION-DOMAINS.md`,
`decisions/SEAM-SPIKE.md`, `decisions/SHELL.md`; the 06-19 `process/HANDOFF.md`
was retired 2026-07-07). Those remain as
historical reference for their spikes; where they disagree with this file, this
file wins. We restarted the planning from zero by interview on 2026-06-26.

This is the **big picture**: the program, the workstreams, the dependency map, the
phase gates, and how the whole thing decomposes into session-sized units. It does
**not** enumerate every session — the per-session backlog is the *next* planning
session's job (see §8). Detail later, on purpose.

---

## 0. The job, stated plainly

Take cat-code from **a terminal tool + a clickable prototype** to **a shipped,
production-grade dedicated desktop app** whose UI/UX matches the prototype, running
on the **real cat-code engine**.

Fixed constraints (decided by interview 2026-06-26):
- **Bar: shippable product.** Production-grade from the start, not a demo.
- **Prototype = UX spec, not code.** The final product must *look and feel like the
  prototype*. No prototype code ships — it's the reference; we build fresh.
- **Shell: a dedicated DESKTOP app, with a React 19 + Vite + TS + Tailwind v4 renderer**
  (carrying `react-markdown`, `remark-gfm`, `shiki`). *Exact shell (Electron vs. Tauri)
  and transport are NOT yet settled — see Decisions; resolved by the P0-1 bake-off.*
- **Code home: a fresh build in `~/cat-code`** *(not the old `web/` scaffold — that's
  treated as empty and gets cleared)*. Same repo as the engine so types version
  together; built on a migration branch, never the default branch.
- **Multi-session is core.** One app window hosting many sessions (sidebar + tabs +
  split panels) is non-negotiable. The engine is one-process-per-session, so the app
  must spawn/manage **N engine processes**. Design for N from the start; walk the
  skeleton single-session first. ⚠️ The engine also carries **process-global session/CWD
  state** (`src/bootstrap/state.ts:434,533`; mutated per-submit at `QueryEngine.ts:215`)
  — so "many sessions in one engine process" is *unsafe* without an engine refactor.
  This makes N-process the likely path and is a P0 risk, not a Phase-3 one (see §4/§7).
- **Conflict rule: case-by-case.** When the prototype's design and the engine's real
  behavior collide, surface it with the trade-off — don't silently resolve it.

### Decisions (post-interview, dated)
**2026-06-28 (REVISED, same day) — Shell + transport: REOPENED after a cold source review.**
An earlier 2026-06-28 entry decided "Electron, engine in-process." A cold review
(`reviews/2026-06-28-review.md`) **refuted it against source** and it is withdrawn:
- ❌ **REFUTED — "Electron's Node main process can host the engine in-process."** The
  engine is **Bun-targeted**, not Node-runnable: `QueryEngine.ts:1` imports `bun:bundle`,
  the build is `--target bun` (`scripts/build.ts:158`), `package.json:6` declares Bun,
  and a Node import probe throws `ERR_UNSUPPORTED_ESM_URL_SCHEME`. So the engine is a
  **separate Bun process (a sidecar) under *any* shell** — which collapses the original
  Electron-over-Tauri argument (it hinged on cheap in-process hosting that doesn't exist).
- ❌ **REFUTED — "the in-process path depends on fixing the WS mapper."** Raw rich
  `SDKMessage` already exists at the controller seam (`src/app-runtime/sessionEvents.ts:20`);
  the lossy flatten is *introduced* only by the WebSocket server
  (`src/web/AppSessionWebSocketServer.ts:69`). A non-WS / IPC transport doesn't touch
  that mapper at all. The mapper fix is only relevant *if* we choose the loopback-WS path.
- ✅ **STILL TRUE — desktop (not browser).** The N-process + local-FS need still rules
  out a pure browser app. Renderer stack (React/Vite/Tailwind) unchanged.
- **OPEN — shell + transport, now decided by evidence (the new P0-1 = a packaged
  topology bake-off), not by armchair pick.** Candidates: (a) **Electron + Bun
  sidecar** over local IPC/socket; (b) **Tauri + Bun sidecar**; (c) **reuse the engine's
  existing loopback WebSocket** (`src/web/startRuntimeBackedWebMode.ts:35`) behind a thin
  shell. The bake-off must run the *real* `QueryEngine` in a *packaged* build (not a mock
  controller) and measure the seam, multi-process viability, crash isolation, and
  packaging/signing the Bun binary.
- **Folder naming:** the renderer needn't be called `web/`. Final layout decided when
  the skeleton lands — cosmetic, not load-bearing.

### Why this is not a textbook migration
There is **no shared code** between prototype (20k lines, zero TS, 2264 inline styles,
browser-Babel, `window`-glued) and target (TS + Tailwind + ESM + Vite). Every line is
a rewrite regardless. So "migration" here = **rebuild the experience on the real
engine**, using the prototype as the design contract. And it is **not a strangler-fig**:
the TUI keeps living, there's no shared request path, no facade to route traffic
through. Our safety net is not route-shifting — it's **walking-skeleton-first + an
anti-corruption adapter** (below).

---

## 1. How a real company would run this

A serious org doesn't build a migration as one long to-do list. It does five things:

1. **De-risks the spine before the leaves.** Find the 2–3 things that, if they don't
   work, sink the project (here: *can the app drive the real engine?* and *can one app
   host N engine processes?*). Prove those with a thin end-to-end skeleton **before**
   investing in features. You don't decorate a bridge you haven't shown will stand.
2. **Splits into parallel workstreams with a dependency map** so multiple people (or
   agents) work at once without stepping on each other — and so it's explicit what is
   safe to start now vs. what is blocked.
3. **Builds an anti-corruption layer at the boundary.** The prototype invented shapes
   the engine doesn't have (a `tool` message *type*, `escalate:user`, cross-session
   `sessionId`, 14 permission variants). An **adapter** maps real engine data → what the
   UI renders, so those inventions never silently become the production contract. Source
   wins; the adapter absorbs the difference (and is where each case-by-case conflict gets
   decided). ⚠️ Per the review, this is **not one object** — it's three boundaries that
   must not be fused into a god-object: (i) a versioned engine/session protocol, (ii) a
   stateful transcript projector (incl. tool_use↔tool_result correlation), (iii)
   per-domain services/selectors. See §5.
4. **Ships in vertical slices, not horizontal layers.** Each unit of work is *one
   thing, end-to-end real* (UI → engine → back), at near-shipping quality — not "all
   the data models, then all the UI, then all the wiring." A slice proves "can,"
   produces something demoable, and de-risks as it goes.
5. **Gates each phase.** A phase isn't "done" by vibes — it has an exit criterion (a
   thing that runs, a risk retired). You don't open the next phase until the gate passes.

This plan is those five ideas applied to our specifics.

---

## 2. The workstreams (parallel lanes)

A **workstream** = a track of related work that moves on its own, with its own
sequence of session-sized units. Lanes run in parallel where dependencies allow.

| # | Workstream | What it owns | Can parallelize? |
|---|---|---|---|
| **W1** | **Engine seam & transport** | How the app talks to the real engine: the `AppSessionController` driver, the socket/sidecar transport, the message stream in/out, abort, permission round-trip. | Foundational — partly gates everyone. |
| **W2** | **App shell & multi-session** | The frame: window, sidebar switcher, tabs, split panels, routing, and the **N-engine-process** spawn/attach/multiplex model + the on-disk session registry. | After W1 single-session proven; heavy, runs long. |
| **W3** | **Transcript & tool rendering** | The chat spine: render off real `SDKMessage` content blocks → the prototype's rich row + tool-card families, via the derive/adapter layer. | After W1 streams real messages; then highly parallel internally (card families are independent). |
| **W4** | **Feature domains** | Each prototype surface ported real: Permissions, Accounts/Codex pool, Sessions page, Agents config, Orchestrator mode, Tasks, Settings sub-panes, Goal, Startup/trust. | Most parallel lane — once W1+W3 spine exists, domains are largely independent of each other. |
| **W5** | **Foundations & release** | Cross-cutting: design-system port (tokens, theme, the pink accent, DM Sans/Mono → Tailwind), TS types from engine, test setup, build/package/sign/auto-update, CI. | Starts early (design tokens, types) and bookends late (packaging). |

**Spec note (decided): there is no separate spec workstream.** Per the interview, the
prototype + its ~199 `// SOURCE:` anchors *are* the spec. "Read the prototype surface +
its anchors" is **step 1 of every build session**, not a separate doc track. The *only*
real specs we author are for behaviors the prototype **faked** with mock data — **three
cross-cutting behavior specs** (covering six faked surfaces in INVENTORY; the extra three
are mock session/worker lists that map onto the same three specs). They live inside their
owning workstream:
- **Streaming** (prototype used `setInterval`; real = `message.delta`/`SDKPartialAssistantMessage`) → W1/W3.
- **Permission round-trip** (prototype mock queue; real = `onPermissionRequest ⇒ Promise<response>`) → W1/W4-Permissions.
- **Multi-session process model** (prototype mocked many sessions in one page; real = N processes + registry) → W2.

---

## 3. The dependency map (what gates what)

```
            ┌──────────────────────────────────────────────┐
            │  W5 Foundations (design tokens, TS types)     │  ← start immediately,
            │  …also W5 release/packaging at the very end   │     no dependencies
            └──────────────────────────────────────────────┘
                              │ (tokens/types feed everyone)
                              ▼
   ┌────────────────────────────────────────────────────────────────┐
   │  PHASE 1 GATE: WALKING SKELETON                                 │
   │  W1 single-session seam → renders ONE real SDKMessage →         │
   │  sends ONE real prompt → resolves ONE real permission           │
   └────────────────────────────────────────────────────────────────┘
            │ (seam proven; everything below is now lower-risk)
            ├───────────────────────────┬───────────────────────────┐
            ▼                           ▼                           ▼
   ┌─────────────────┐         ┌─────────────────┐        ┌──────────────────┐
   │ W3 Transcript & │         │ W2 Shell &      │        │ W4 Feature       │
   │ tool rendering  │◄────────│ multi-session   │        │ domains          │
   │ (spine)         │ shell   │ (N processes)   │        │ (Permissions     │
   └─────────────────┘ hosts   └─────────────────┘        │  first, then     │
            │          transcript        │                │  parallel)       │
            │                            │                └──────────────────┘
            └──────────── most W4 domains need the W3 spine + W2 shell ──────┘
```

Read it as:
- **W5 (tokens + types) starts now** — zero dependencies, feeds everyone. W5 (packaging) is the last thing.
- **W1 skeleton is the universal gate.** Until the seam walks, nothing else is real.
- After the gate, **W3 (transcript spine)** and **W2 (shell)** open. They overlap: the shell hosts the transcript.
- **W4 domains** open once the spine + shell exist. **Permissions goes first** among domains (highest value, strongest source-anchoring, the round-trip is core engine behavior). After Permissions proves the domain recipe, the rest of W4 is the most parallel lane in the program.
- **Multi-session (W2's hard half)** splits in two: its **feasibility** (can two isolated sessions run at once given the engine's process-global state?) is proven **early in Phase 0** (P0-4 isolation probe — it's an existential risk, §1.1/§7), while the **production build-out** (N-process spawn/multiplex/registry) stays in Phase 3, once there's something worth multiplexing.

---

## 4. Phases (sequenced by risk retired, not by feature)

Coarse on purpose — each phase's session list is fleshed out only when we open it.

**Phase 0 — Inventory, topology bake-off & stand up foundations.** *(W1 spike + W5 start)*
- **Surface inventory — DONE 2026-06-26 → `INVENTORY.md`.** One row per real
  surface, grouped by workstream, with source-anchor coverage / faked-runtime flag /
  disposition. It's the backbone the §8 backlog is generated from, and it exposed the
  blind spots up front: **5 surfaces have ZERO source anchors** (Sidebar, TabBar,
  SlashCommandPicker, SessionActions, the whole Orchestrator domain) → those open with
  source-recon, not "just read the prototype." Build this *before* sequencing the backlog.
> **⚠️ Phase-0 IDs (canonical, unique across all docs as of 2026-07-02):** P0-1 topology ·
> P0-2 tokens · P0-3 types · P0-4 isolation · P0-5 security. Earlier drafts of this section used
> "P0-2/P0-3" for isolation/security — those are now **P0-4/P0-5**. See `STATUS.md` for
> live status.
- **P0-1 = packaged TOPOLOGY BAKE-OFF — ✅ DONE 2026-07-02 (`decisions/TRANSPORT.md`).**
  The 2026-06-28 Electron-in-process call was refuted (§0 Decisions); the engine is a Bun sidecar
  under any shell. P0-1 spiked the three candidates against the real `QueryEngine` in packaged
  probes and **chose (a) Electron + Bun sidecar, raw `SDKMessage` over IPC**; (c) loopback-WS
  eliminated (it drops `tool_use`). Backlog regenerated for the chosen topology (§8).
- **P0-2 = design tokens → Tailwind — ✅ DONE 2026-07-02.** Portable Tailwind-v4 `@theme` layer
  (`~/cat-code/renderer-theme/`), `--accent` kept themeable; build-verified.
- **P0-3 = engine TS types importable — ✅ DONE 2026-07-02.** Type-only renderer aliases + fixture
  (`~/cat-code/scripts/typecheck/renderer-engine-types/`), strict typecheck passes; commit-`234da9e`
  snapshot fallback that P1-0 must re-sync.
- **P0-4 = multi-session ISOLATION probe (pulled forward from Phase 3) — ⬜ NOT RUN.** The engine
  has process-global session/CWD state (`src/bootstrap/state.ts:69` cwd / `:105` sessionId,
  mutated per-submit at `QueryEngine.ts:245` `setCwd`), so the "N sessions, one window"
  requirement is an *existential* risk, not a late one (§1.1 names it a project-killer). Headless
  test: **two concurrent engine sessions, distinct CWDs, simultaneous tools + permission requests;
  assert zero cross-session leakage; crash one and confirm the other survives + restarts.** This
  decides N-process (almost certainly) vs. an engine refactor *before* we build fidelity on top of
  the wrong assumption. **Make-or-break #2 — still open.**
- **P0-5 = boundary-security minimum — ⬜ NOT RUN.** Before any feature work, write the renderer
  **threat model + IPC allowlist + credential/secret handling owner**. The renderer shows
  untrusted model/tool/Markdown next to an engine that runs commands and touches the FS; Electron's
  security checklist (sandbox, context isolation, restrictive IPC/navigation) is mandatory, not
  Phase-5 polish. (Narrow scope — a11y/telemetry/soak stay in Phase 5.)
- **Mapper note (resolved):** P0-1 chose the IPC path (a), which bypasses `appSessionEventMapper`
  entirely (raw rich stream at `sessionEvents.ts:20`). No mapper fix needed. (It would only have
  mattered had (c) loopback-WS won.)
- **Gate (NOT yet cleared):** topology chosen ✅; tokens ✅; types ✅; **multi-session isolation
  outcome known (P0-4) ⬜**; **security minimum drafted (P0-5) ⬜**. P0-4 + P0-5 remain.

**Phase 1 — Walking skeleton.** *(W1)*
- Thinnest real path on the chosen topology: app shell → real engine session → render ONE
  real *rich* `SDKMessage` (a `tool_use`, not just text — so the gate can't pass while the
  flatten hides) → send ONE real prompt → resolve ONE real permission. Single session, no
  fidelity.
- **Gate:** the seam *walks* on the packaged build. Make-or-break #1 (§1.1). (Make-or-break
  #2, multi-session isolation, is retired by **P0-4** — the isolation probe, still ⬜ as of
  2026-07-02 — so both existential risks are meant to fall in Phase 0, before features.)

**Phase 2 — Transcript spine + first domain.** *(W3 + W4-Permissions)*
- Build the derive/adapter layer + the core transcript rows + the first few tool-card
  families off real `SDKMessage`. Then **Permissions** as the first full domain (proves
  the domain recipe + the real permission round-trip).
- **Gate:** a real session renders a real multi-tool transcript; a real permission is
  approved/denied through the UI. The "domain recipe" is now templated.

**Phase 3 — The shell + multi-session (build-out).** *(W2)*
- Real app frame (sidebar, tabs, split panels) hosting the transcript. Then the
  **N-engine-process** machinery: spawn/attach/multiplex + lifecycle. (The *feasibility*
  of concurrent isolated sessions is settled by **P0-4** — the isolation probe; Phase 3 is the
  production build-out, not the risk discovery.)
- ⚠️ **`concurrentSessions.ts` is NOT a durable app registry** — per the review it only
  writes ephemeral PID files and sweeps dead processes (`src/utils/concurrentSessions.ts:48,163`).
  It can't restore tabs or provide attach/multiplex semantics. The app needs its **own**
  session registry/persistence; treat `concurrentSessions.ts` as at most a liveness check.
- **Gate:** two real sessions live in one window at once, each its own engine process,
  switchable, with the app's own registry persisting/restoring them.

**Phase 4 — Remaining domains, in parallel.** *(W4, fanned out)*
- Accounts/Codex pool, Sessions page, Agents config, Orchestrator mode, Tasks, Settings
  sub-panes, Goal, Startup/trust — slice by slice, reusing the Phase-2 recipe. Most
  parallel phase; multiple agents/sessions at once.
- **Gate:** prototype feature parity (the ~80% that's wireable), each surface real.

**Phase 5 — Production hardening & release.** *(W5)*
- Packaging/signing/auto-update for the dedicated app, perf, error handling, telemetry,
  accessibility, the full test suite. Whatever "shippable" demands that a feature slice
  doesn't.
- **Gate:** installable, signed, updating, tested build. Shippable.

Front-loading rationale: the two things that kill migrations like this are **an
unproven seam** (no facade → prove it in Phase 1) and **wrong decomposition** (→ the
workstream/domain modeling is done up front, here). Volume work (Phase 4) comes only
after both are retired.

---

## 5. The anti-corruption boundary (three layers, NOT one adapter)

The boundary maps **real engine `SDKMessage` / events → what the UI renders** — but the
review's god-object warning is taken: this is **three distinct layers**, kept separate so
no single "adapter" swallows transcript projection + session control + domain services.

1. **Versioned engine/session protocol** — the typed seam to the engine (raw `SDKMessage`,
   subscribe, abort, the permission promise). Verified real at
   `src/app-runtime/AppSessionController.ts:24`. Pin it to an engine commit; version it.
2. **Stateful transcript projector** — derives the prototype's rich rows/cards from the
   raw stream (incl. `tool_use`↔`tool_result` correlation and derived tool status). This
   is the piece that "derives, never expects the engine to emit cards."
3. **Per-domain services/selectors** — Accounts/Settings/Agents/etc. read their own slices;
   they are *not* the transcript projector and must not be fused into it.

> ⚠️ **Rich-content precondition (corrected 2026-06-28):** the projector needs the **rich**
> `SDKMessage` (tool_use / tool_result / thinking / image blocks). That stream is **already
> real** at the controller seam (`src/app-runtime/sessionEvents.ts:20`). The lossy flatten
> is introduced *only* by the WebSocket server (`src/web/AppSessionWebSocketServer.ts:69`) —
> so it blocks the projector **only if P0-1 picks the loopback-WS topology**. An IPC
> transport bypasses it. (Earlier drafts wrongly listed the mapper fix as a universal
> blocker; it is not.)

- **Don't trust the "few real types" framing — enumerate.** The review found `SDKMessage`
  has **~19 union members / 15 top-level discriminants** (`src/entrypoints/sdk/coreTypes.generated.ts:760`;
  the runtime schema lists ~25 variants), and assistant content / stream events are typed
  `unknown[]`/`unknown` (`coreTypes.generated.ts:90`) — so the projector must read block
  discriminants without casts. The prototype's ~27 UI rows are *display groupings* over
  these, but the mapping is **not** "27 → 5"; require an **exhaustive adapter fixture**
  covering every real variant before declaring the projector done.
- This boundary is also the **case-by-case conflict checkpoint**: when a prototype surface
  wants data the engine doesn't have, that surfaces here as a flagged decision (extend the
  engine vs. change the UI), not a silent workaround.

The projector (layer 2) is the most reused piece — built in Phase 2, every later domain
plugs into it *through its own selectors* (layer 3), never by extending the projector.

---

## 6. The session-unit (the decomposition grain)

Calibrated against `visual-build-prompts.md` (39 sessions built the prototype; each
block is ~15–40 lines, one coherent surface, self-contained, pasteable into a cold
agent). A **migration** session-unit matches that grain:

- **One surface or one tight capability**, built real and **verified**, per session.
  (e.g. "Bash tool card, wired to real `tool_use`/`tool_result`"; "Permission queue,
  wired to the real round-trip"; "session tab spawn/attach for one extra process".)
- **Self-contained / cold-agent-safe**: repeats the shared context, names its inputs
  (which prototype file is the UX spec, which `src/…:line` is the source anchor), and
  states its **done-criteria** (what runs, what's verified).
- **Step 0 is always "read this surface's row in `INVENTORY.md`."** The row hands the
  cold agent its marching orders before it touches code: the **disposition**
  (`port`/`adapt`/`build-new`) = *how* to approach it; **⚓ ❌** = do source-recon first
  (this surface has no anchors, don't invent shapes); **Faked? yes** = a behavioral spec
  must exist before wiring. The row exists so the agent doesn't re-derive its approach.
- **Step 1 is then "read the prototype surface + its `// SOURCE:` anchors"** — no
  separate spec doc (§2). (For ⚓ ❌ rows, step 1 includes the recon the row flagged.)
- **Visual-fidelity acceptance (REQUIRED for any surface that renders UI).** The Step-1
  prototype surface is the *acceptance bar for how it looks* — not merely a data/behavior
  reference. The session's done-criteria MUST include a **side-by-side visual check against that
  prototype surface** (layout, chrome, spacing, states); a surface is done only when it *reads as*
  the prototype, not merely when its data is wired. The prototype IS the visual grammar — a
  session must **not** invent a parallel one. Every intentional divergence is a **§0 case-by-case
  conflict**: flag it with the trade-off (extend-engine vs change-UI), never silently drop or
  restyle. (Phases 0–3 gated on function only; that under-enforcement let the shell chrome drift
  from the prototype — this closes it.)
- **Prototype parity is the DEFAULT disposition — deviate only when *blocked* or *needs redesign*,
  and FLAG rather than stop-and-ask.** Build the surface to match the prototype unless: **(a)
  blocked** — no source backing to build on (an invention; e.g. read-only mode has no engine
  state) → render truth, defer the invention, flag the make-it-real path (spec-first); or **(b)
  needs redesign** — the prototype collides with real engine behavior (e.g. a blocking reauth
  modal vs. the pool's multi-account failover) → adapt to reality, flag the trade-off. Both are
  §0 case-by-case flags **resolved in the prompt**, not operator questions. Reserve an actual
  operator question for a genuine *investment* fork the principle can't settle (fund a net-new
  feature now?) — and even those default to defer.
- **Tiered** like the prototype backlog (🟢 mechanical / 🟡 extend-pattern / 🔴 net-new
  state+architecture) so the model is picked per session.
- **🧠 Model/Difficulty header (REQUIRED on every session).** Each session block starts with
  `🧠 Model: CLAUDE (visual-design|system-architecture) | ANY · Difficulty: N/10`.
  **Append `· 🖐 GUI` ONLY when** the session's verification needs the operator to drive a live
  GUI/browser step (launch/screenshot the Electron app, click, keypress). Presence-only — a
  headless-verifiable session carries NO GUI tag (don't stamp a "none").
  **CLAUDE** only when the task's core is visual-design or system-architecture *judgment*
  (topology, boundaries, data-model/protocol decisions); everything else is **ANY** (model
  doesn't matter). Difficulty is a bare 1–10 score — the operator picks reasoning effort from
  it; do **not** append effort advice. Model and difficulty are independent (a CLAUDE task can
  be low-difficulty; an ANY task can be high). *Implementing* a decided architecture is
  mechanical (ANY); *designing* it is CLAUDE. The prompt should also instruct the executing
  session to echo this header back to the operator before starting.
- **Tagged** when behavior must be confirmed first (`❓ spec-first`) — the three faked
  behaviors (streaming, permissions, multi-session) and anything ambiguous.
- **Bounded to one sitting.** Per your rule: one agent, one session, one chunk — long
  tasks crammed into one run degrade quality. Heavy units get split and labeled.
- **GUI/browser verification is the operator's job — bake it into every prompt.** Any session
  whose DONE-WHEN needs a click, a keystroke in the running app, launching/screenshotting the
  Electron app, or browser interaction must instruct the worker to **STOP and print exact operator
  instructions** (command to run, what to click, what to look for) and wait for the operator's
  report — the worker must **NOT** drive it with `cua-driver`, `claude-in-chrome`, or any
  computer/browser automation. Headless checks the worker can run itself (`bun test`, typecheck,
  build) stay the worker's job. Every generated prompt with a live GUI step carries this line.
  Every generated `🖐 GUI` prompt must also say: read
  `docs/migration/process/GUI-VERIFICATION.md` before the GUI section and build the
  verification plan around the harness's launch/readiness/debug-export/registry guidance.
  If a separate Codex GUI-driving verifier is spawned, paste that doc's "For The Driving Agent"
  section into the verifier prompt.

The per-session backlog (the actual pasteable prompts, in dependency order, per
workstream) is the **next planning session's** deliverable, not this one.

---

## 7. Risks & how each is retired

| Risk | Retired by |
|---|---|
| Seam doesn't work (no facade fallback) | Phase 1 walking skeleton on the chosen topology — make-or-break #1. |
| **Engine can't be hosted as assumed** (it's Bun, not Node — refuted in-process; see §0) | P0-1 packaged bake-off picks the real topology (Electron+sidecar / Tauri+sidecar / loopback-WS) with evidence, not an armchair pick. |
| **Multi-session breaks on process-global engine state** (`state.ts:69,105`, mutated at `QueryEngine.ts:245`) | **P0-4 isolation probe — pulled forward to Phase 0** (was Phase 3). Two concurrent sessions, distinct CWDs, crash-one; decides N-process vs. engine refactor *before* fidelity work. Make-or-break #2. Still ⬜. |
| Prototype inventions leak into production | The §5 three-layer boundary — source wins; conflicts flagged at the projector/protocol seam. |
| Boundary becomes a god-object | §5 split into protocol / transcript-projector / per-domain selectors — enforced, not one adapter. |
| Rich content gets flattened | **Only a risk on the loopback-WS path** (`AppSessionWebSocketServer.ts:69`); IPC bypasses it (raw stream at `sessionEvents.ts:20`). P1 renders a real `tool_use` so a flatten can't hide behind the gate. |
| `concurrentSessions.ts` mistaken for a durable registry | §Phase-3 note: it's ephemeral PID files only (`concurrentSessions.ts:48,163`); the app builds its own registry. |
| **Security: untrusted content next to a command-executing engine** | P0-5 boundary-security minimum (threat model + IPC allowlist + secret-handling owner) before feature work — not Phase-5 polish. |
| **Anchors are routing hints, not a spec** (sampled 83% exact / 8% stale; "199" = 141 literal `// SOURCE:`) | Pin anchors to an engine commit; re-verify each against `src/` before building on it; back every surface with behavioral/visual/keyboard acceptance tests, not just the anchor. |
| Gates are demos, not falsifiable | Add objective thresholds per gate (packaged-build, event-loss, crash, memory, latency, a11y) — see §4 gate lines + Phase 5. |
| Missing cross-cutting concerns (secrets, state migration/versioning, crash recovery, rollback, TUI↔desktop coexistence, update channels) | Tracked as explicit Phase-0 (security/ownership) + Phase-5 (release) line items; flagged here so they aren't silently dropped. |
| Sessions too big → quality drops | §6 grain + one-session-one-chunk rule; heavy units split. |

---

## 8. What this session produced / what's next

### Progress tracking + how the backlog grows (READ FIRST when asked "what's the progress?")
- **`STATUS.md` is the single source of truth for what's done.** A session asked to
  report migration progress reads STATUS.md first (not git archaeology). Each finishing session
  flips its row (⬜→🟡→✅ + date + note) there as its last step.
- **Backlog is generated phase-by-phase, on demand.** Only Phase 0 + Phase 1 are split into
  concrete sessions (`backlog/phase0-1.md`). Phases 2–5 are coarse rows in STATUS until opened.
- **When a phase's sessions are all ✅ (gate cleared), generate the NEXT phase's backlog** from
  the relevant `INVENTORY.md` rows (its workstream slice) — in dependency order, one
  surface/capability per session, at the §6 grain.
- **Enumerate the joins** (2026-07-05 postmortem, rec 1): while generating a phase's backlog,
  list the cross-session contracts (who produces X, who consumes it) and assign each join
  *by name* to a session or to that layer's integration review. Every Critical/High so far
  was an unowned join (restore amnesia, restart Potemkin, shell RED, zombie socket). This
  shrinks the unowned-join class; it does NOT replace the by-layer reviews — emergent paths
  invisible to the plan (LR-1's restart-in-place) remain the reviews' job.
- **Every generated session MUST carry the §6 🧠 Model/Difficulty header** (`Model: CLAUDE
  (visual-design|system-architecture) | ANY · Difficulty: N/10`, plus `· 🖐 GUI` only when the
  session needs the operator to drive a live GUI step) and instruct its reader to
  echo it back. For every generated `🖐 GUI` session, include the
  `docs/migration/process/GUI-VERIFICATION.md` read-first pointer from §6 so the
  session uses the P3-H harness rather than rediscovering launch/readiness/PID
  forensics. Add the new sessions to STATUS.md as rows, tags included.
- **Every surface-rendering session MUST also carry the §6 visual-fidelity acceptance
  criterion**: name the exact prototype surface (file + component under
  `~/catcode_prototype/cat-app/`), require a **side-by-side visual check as a done-criterion**,
  and route every divergence through the §0 case-by-case flag. Do **not** instruct a session to
  establish its own visual grammar — that phrasing (P3-5's "set the shell's visual grammar") is
  what let the Phase-3 shell chrome drift from the prototype while passing its function-only gate.
- **Whole-prototype coverage lives in `PARITY-LEDGER.md` (CC-1 — STATUS.md top, in progress).**
  The function-only gates through Phase 3 let elements/flows drop silently (the Phase-4 Tranche-A
  fidelity gap: a ✅/review-GREEN sidebar still missed 4 chrome items + a whole feature). `INVENTORY.md`
  is surface-level; the ledger is the **element/UX-state + flow** instrument that makes the Phase-4
  "feature parity" gate measurable. Once built, every surface session updates its ledger rows as a
  DONE-criterion, and each phase gate audits it — the **❓missing-no-owner** column must be empty or
  explicitly waived. This is where "did we silently drop a prototype element?" gets answered.
- **Resolve prototype-vs-reality collisions IN the prompt, not by asking.** Parity is the default
  (§6); a collision is either *blocked* (invention, no source backing → defer + flag, spec-first)
  or *needs-redesign* (adapt to real behavior + flag) — write it as a §0 flag in the session, not
  an operator question. Only a genuine *investment* fork (fund a net-new feature now?) goes to the
  operator, and it defaults to defer.

**This session (2026-06-26):** the big picture above — job, workstreams, dependency
map, phases+gates, adapter boundary, session grain — plus two concrete artifacts the
interview pulled forward (inventory, then the first backlog). No production *code* yet;
that starts tomorrow at P0-1.

**Also produced this session:** `INVENTORY.md` — the per-surface ledger (the
backbone the backlog is generated from), added after the "inventory first?" call.

**Phase 0 + Phase 1 backlog (`backlog/phase0-1.md`) — ⚠️ STALE, DO NOT EXECUTE.**
It was written against the withdrawn Electron/in-process decision and still says reuse
`web/`, "choose transport," fix the WS mapper, and considers Tauri — i.e. it would have a
cold agent build the **refuted** architecture. It must be **regenerated after P0-1's
bake-off picks the topology** (§0 Decisions, §7). Until then it's reference only.

**Anchor reality (from the 2026-06-28 review):** the "~199 anchors" figure is imprecise —
there are 199 `SOURCE:` tokens but only **141 literal `// SOURCE:` comments**, and a
12-anchor sample ran **83% exact / 8% stale**. They're solid *routing hints*, not a spec;
re-verify each against `src/` before building on it (§7).

**Whole-program estimate:** ~50 build sessions (±10) is a *plausible order of magnitude,
not a derived forecast* — it isn't backed by a row→session mapping yet, and INVENTORY rows
bundle 5–11 components each. Treat as a guess until each phase's backlog pins it.

**Progress as of 2026-07-02:** P0-1 (topology ✅), P0-2 (tokens ✅), P0-3 (types ✅) done;
`backlog/phase0-1.md` regenerated for the Electron+sidecar topology. **Remaining in Phase 0:**
**P0-4** (multi-session isolation probe — the make-or-break #2 existential risk, still ⬜) and
**P0-5** (boundary-security minimum, still ⬜). Live status: `STATUS.md`.

**Next session:** run **P0-4** and **P0-5** (independent, parallelizable). Then the Phase-0 gate
clears and **Phase 1** (walking skeleton, P1-0..4 in the regenerated backlog) opens.

**Do not** start feature building before Phase 0's gate (topology ✅ + tokens ✅ + types ✅ +
**isolation outcome known (P0-4)** + **security minimum drafted (P0-5)**). The last two are the
open ones — the multi-session existential risk is NOT yet retired.
