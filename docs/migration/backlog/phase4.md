# Migration backlog — Phase 4 (remaining domains, fanned out)

**Generated 2026-07-07** (Scenario 2, per PROGRAM-PLAN §8), from the INVENTORY **W4** (feature
domains) + **W4 Settings** + **W5** (shared primitives / startup / resume / welcome) rows, the
four Phase-4 pre-work decisions — **D2** `decisions/AGENT-CHROME.md`, **D3**
`decisions/PAIRED-DEVICES.md`, **D4** `decisions/STARTUP-GATES.md`, **D5**
`decisions/WELCOME-LAUNCHER.md` — all now with operator rulings, and the **P3 shell-fidelity
carry-forward** (STATUS Phase-4 header). Phase 3's gate cleared 2026-07-06; this is the volume
phase (§4 "most parallel"). **18 sessions.**

> **Operator rulings baked in (do not re-open):**
> - **D2 (agent-chrome):** all 8 Orchestrator surfaces adapt over real shapes; inline
>   `AgentToolCard`/`DelegateGroup` KEPT (real idiom); `AgentEventRow`/`AttachmentCard`/
>   `GroupedToolGroup`-as-type CUT; subagent frames **NEST** under the owning card, never interleave.
> - **D3 (paired-devices):** RemoteSettings **cut to the real surface** — bridge toggle/status +
>   read-only command-filter truth + direct-connect form. No device identity/authz model (v2).
> - **D4 (startup-gates):** trust gate + first-run OAuth = adapt; `WorkspaceSwitchPrompt` CUT;
>   **Q1 = TUI parity** (no read-only mode; `ReadOnlyModeGate` CUT); **Q2 = non-blocking reauth
>   banner + action** (block submit only when zero healthy accounts remain).
> - **D5 (welcome-launcher):** recents = **derived** (registry ∪ engine history via host API, no
>   new store); **worktree-at-launch deferred** past v1; branch chooser cut.

## How to use
Paste **one** block into a fresh agent session, in order within its tranche. Each is
self-contained. Respect the dependency note. When done, flip the session's row in `STATUS.md`
(✅ + date + one-line note) as the last step.

## Standing rules (apply to every session below)
- **Step 0 — read your surface's row in `docs/migration/INVENTORY.md` (§W4 / §W4-Settings /
  §W5)**: disposition (`port`/`adapt`/`build-new`), ⚓ grounding, `Faked?` spec ID. The row is
  your marching orders; don't re-derive the approach. **⚓❌ / low-⚓ = do source-recon FIRST**
  (don't invent shapes); **Faked? yes** = pin the real behavior in-session (recon + cite
  `src/…:line`) before wiring — no separate spec doc is required (the recon-in-session pattern
  P2-4/P3-5b used; the three faked behaviors that DID get spec docs are S1/S2 only).
- **Step 1 — read the named prototype file(s)** under `~/catcode_prototype/cat-app/` (via
  "CatCode Web App.html"): the **UX spec AND the visual acceptance bar** (PROGRAM-PLAN §6, added
  2026-07-07). Rebuild the look/feel in TS/Tailwind on the P0-2 tokens; **port zero prototype
  code, no inline `style={{}}`**. **Source wins**: real shapes live in `~/cat-code/src` /
  `~/cat-code/app`; re-verify every `…:line` anchor before building (they drift). Surface real
  engine-vs-UX conflicts to the operator; don't silently resolve.
- **VISUAL-FIDELITY ACCEPTANCE (REQUIRED — PROGRAM-PLAN §6/§8).** A surface is done only when it
  **reads as the prototype** (layout, chrome, spacing, states), not merely when its data is
  wired. Your DONE-WHEN MUST include a **side-by-side visual check against the named prototype
  surface**. The prototype IS the visual grammar — do NOT invent a parallel one; where a
  Phase-3 shell surface established real chrome (post-P4-4 true-up), extend THAT. Every
  intentional divergence is a **§0 case-by-case conflict**: flag it with the trade-off
  (extend-engine vs change-UI), never silently drop or restyle.
- **PARITY LEDGER (CC-1 — ✅ landed 2026-07-07, `docs/migration/PARITY-LEDGER.md`).** The
  whole-prototype element/UX-state + flow coverage ledger now exists (1,894 rows; 126 ❓
  missing-no-owner). **Read your surface's section in Part A before building** — it already
  enumerates the elements + current dispositions. **Your DONE-WHEN includes updating your surface's
  ledger rows**: flip each built element to ✅ with its `app/…:line`, and tag every divergence
  built / adapted(why) / real-added / deferred(owner) / cut(reason). **Clear or explicitly own every
  ❓ row for your surface** — an un-flagged omission is the exact failure the ledger exists to
  prevent, and each phase gate audits Part C (❓ must be empty or waived). **Your prompt names your
  Part A § + ❓-to-clear count (see the `Ledger anchors` table above); if your section is bigger
  than one sitting, STOP and split into sub-sessions and flag the sub-scoping in your report — don't
  cram** (the P4-18 → 18a/18b/18c precedent).
- **PARITY IS THE DEFAULT — deviate only when *blocked* or *needs-redesign*, and FLAG in-session.**
  Build every surface to match the prototype unless: **(a) blocked** — an invention with no source
  backing (e.g. read-only mode) → render truth, defer the invention, flag the spec-first path; or
  **(b) needs redesign** — it collides with real engine behavior (e.g. a blocking reauth modal vs.
  the pool's multi-account failover → banner) → adapt + flag. Resolve these as §0 flags in your
  report; do NOT block on an operator question (the operator rulings already baked into this
  backlog cover the known ones).
- **The domain recipe (P2-4 templated it — copy it).** A W4 domain = (1) a **domain service**
  module (`permissionDomain.ts` is the template) that reads its slice over the SAME engine state
  the engine uses; (2) **per-domain selectors** (layer 3 — never fuse into the transcript
  projector, PROGRAM-PLAN §5); (3) UI. Status/derived state is computed at READ time, never
  stored. Prototype fixture fields with no real backing → render truth, **flag each dropped
  field** as extend-engine-vs-change-UI (the C3 precedent), don't mock.
- **Domain read-seam (the new-data boundary — read P2-4's C2/C3 in `decisions/PERMISSION-BOUNDARY.md`).**
  Most domains need data that doesn't cross the sidecar socket yet. Add it as a **read-only
  outbound snapshot frame** (C3 precedent: `permission.context`) or a host-API read — NEVER a
  renderer-authored write of engine state. **`secretGuard` on every outbound frame** (critical
  for Accounts — credentials never leave the engine; renderer sees redacted status only). No new
  inbound vocabulary unless a decided control action needs it (then it carries T5a/T6/T7 + a
  flag). **P4-5 (Accounts) builds the FIRST domain read-seam and sets the recipe; later domains
  copy it** — the by-layer review checks conformance.
- **Security baseline is a hard gate** (`decisions/SECURITY-MINIMUM.md`, incl. the Phase-3
  Addendum T8/HC1–HC4): T4 goalSnapshot validated; T5a responses match an engine-minted request;
  T6 `updatedInput` echo-only; T7 inbound size/rate caps; directional frame limits
  (`MAX_FRAME_BYTES` inbound vs `MAX_OUTBOUND_FRAME_BYTES` outbound — never swap); engine-only
  secrets + `secretGuard` outbound; preload stays **default-deny** (a new preload method needs
  the HC3 fixed-sender pattern + HC1–HC4 + a test-pin). Renderer never authors a cwd (HC1). Every
  session preserves ALL of this.
- **Verification commands (headless — the worker's job):** `bun test app/` (green);
  `bunx tsc --noEmit -p app/tsconfig.json` (renderer clean);
  `bunx tsc --noEmit -p app/sidecar/tsconfig.json` — ⚠️ **pre-existing red** (~5.5k, include-override
  drops root `env.d.ts`): require **no NEW errors from your change**, not green. Boundary/preload
  changes also run `bun run --cwd app test:hardening`.
- **The HUMAN operator drives the GUI — the worker never does.** Any `🖐 GUI` verification: the
  worker **STOPS and prints exact operator instructions** (command, what to click, what to look
  for) and waits. The worker must **NOT** use `cua-driver`, `claude-in-chrome`/
  `mcp__claude-in-chrome__*`, or any computer/browser automation. Every `🖐 GUI` prompt reads
  `docs/migration/process/GUI-VERIFICATION.md` before its GUI section and uses the **P3-H harness**
  (picker allowlist, debug-state export, readiness latch) for launch/readiness/cross-checks.
- **One sitting.** If a block feels too big mid-session, stop and split — don't degrade.
- Branch `migration`; never main. `app/` is its own package (`@cat-code/desktop`) — use its
  scripts, not root `build:dev:full`. Keep `app/supervisor/` + `app/host/` Electron-free.
- **N-process shared-state discipline (the DR-2 lesson):** never add a new cross-process
  read-modify-write file without single-writer + lockfile + atomic-write (P3-5a fixed
  `updateSettingsForSource` this way — settings-touching sessions must preserve the
  `SettingsUpdater`-under-lock form, `src/utils/settings/settings.ts`).
- **Kill what you spawn (the CC-3 orphan-leak lesson).** Any session or harness that launches
  the app or spawns engine sidecars MUST verify it left none running before finishing:
  `ps -axo pid,command | grep "sidecar/index.ts"` count unchanged from before your work (or
  explicitly reconciled). Sidecars deliberately survive parent death (die-with-window is
  supervisor behavior, not welding — `decisions/SESSION-LIFETIME.md`), so a killed dev/GUI
  harness leaks a ~60 MB orphan that no relaunch can reap once its registry row is evicted. If
  the count grew, run `bun run --cwd app reap:orphans` (dry run) then `--confirm`. The sidecar's
  idle-TTL (`CATCODE_SIDECAR_IDLE_TTL_MS`, default 15 min) is a backstop, not a licence to skip
  the check.

🧠 **Per-session tag** = `Model: CLAUDE (visual-design|system-architecture) | ANY · Difficulty:
N/10`, `· 🖐 GUI` appended only when the operator must drive a live GUI step. CLAUDE only where
the core is design/architecture *judgment* (a new data seam, secret-owner boundary, or the
visual system); implementing a decided design is ANY. Every executing session **echoes its
header back before starting**.

## Dependency chain / parallelism
```
TRANCHE A — foundations (build first; C reuses them)
  P4-1 Shared primitive kit ─┬─▶ (banners/toasts/chips/inspector used by every C domain)
  P4-0 Composer enrichment ──┘   (uses MentionPicker from P4-1)
  P4-2 AgentIdentity ────────▶ P4-8 Orchestrator, P4-9 Tasks
  P4-3 Settings shell ───────▶ P4-12 Settings extensions

TRANCHE B — the P3 shell-fidelity true-up (STATUS carry-forward)
  P4-4 Shell true-up (Sidebar/TabBar/shell/WorkspaceLayout)   [run early; C domains render inside it]

TRANCHE C — domains (parallel after A; each copies the domain recipe)
  P4-5 Accounts ─────────────▶ P4-15 Startup (reauth banner read-path), P4-17 Welcome (account table)
  P4-6 Sessions page/actions      P4-7 Agents      P4-8 Orchestrator      P4-9 Tasks
  P4-10 Goals+Memory   P4-11 PlanBar   P4-12 Settings ext (dep P4-3)   P4-13 RemoteSettings   P4-14 Diagnostics+Trust

TRANCHE D — startup / launch
  P4-15 Startup+trust+OAuth+reauth (dep P4-5) ─▶ P4-17 Welcome launcher (dep P4-5, P4-15)
  P4-16 Resume dialogs   [standalone]
```
**Enumerated joins (§8 rec 1 — owner named):** domain-read-seam recipe → **produced by P4-5**,
consumed by every C/D domain (review checks conformance); shared primitives → **P4-1** → all C;
`AgentIdentity` → **P4-2** → P4-8/P4-9; Settings shell primitives → **P4-3** → P4-12; Accounts
pool status → **P4-5** → P4-15 banner + P4-17 table; trust gate → **P4-15** → P4-17 picker; the
trued-up shell grammar → **P4-4** → every C domain's visual-fidelity check inherits it.

---

## Ledger anchors — CC-1 sections per session

`PARITY-LEDGER.md` enumerated every prototype element into disposition-tagged rows. **A session's
Part A section IS its element checklist + visual-acceptance bar, and its ❓ rows are its danger-list
scope** (Standing rule: read it before building). The coordinate per session:

| Session | Surface(s) | Part A § | ❓ to clear |
|---|---|---|---:|
| P4-0 | Chat.jsx (composer) | §6 | 3 (attach + slash-footer) |
| P4-5 | Pages.jsx Accounts · AccountLifecycle.jsx | §14 · §15 | 0 |
| P4-6 | SessionsPage · SessionActions · MetadataInspector | §16 · §17 · §18 | 0 |
| P4-8 | OrchestratorMode.jsx | §20 | 0 |
| P4-9 | TasksPage.jsx | §21 | 0 |
| P4-11 | PlanPanel.jsx | §24 | 0 |
| P4-12 | SettingsExtensions.jsx | §25 | 0 |
| P4-13 | RemoteSettings.jsx | §26 | 0 |
| P4-14 | Pages.jsx Diagnostics/Trust | §14 | 0 |
| P4-15 | Startup.jsx | §27 | 0 |
| P4-16 | ResumeStates.jsx | §28 | 0 |
| P4-17 | Welcome.jsx | §29 | 0 |
| **P4-18** | Messages.jsx · Chat activity | §5 · §6 | **64** |
| **P4-19** | Settings.jsx core editors | §11 | **45** |
| **P4-29** | SessionsPage.jsx | §16 | **22** |
| **P4-30** | SessionActions.jsx (dialog layer) | §17 | **18** |
| **P4-31** | MetadataInspector.jsx | §18 | **10** |
| **P4-32** | OrchestratorMode.jsx · AgentIdentity.jsx · orchestrator flow | §20 · §13 · FLOW-5 | **52** |
| **P4-33** | Chat.jsx · Surfaces.jsx · Messages.jsx · AppV2 · Sidebar · WorkspaceLayout | §6 · §12 · §5 · §1 · §2 · §4 | **12** |
| **P4-34** | PermissionRules · CommandPalette · Settings · MemoryPage · Permissions · Welcome | §8 · §9 · §11 · §23 · §7 · §29 | **13** |

Done sessions own their sections too (P4-1 §12 · P4-2 §13 · P4-3 §11-shell · P4-4 §2/§3/§4 · P4-7 §19 ·
P4-10 §22/§23); their residual ❓ = 0. **Danger-list ownership (126 ❓ → 0 silent):** 64 → P4-18,
45 → P4-19, 3 → P4-0, 1 → CC-2 (restore-reorder), 5 waived (mock/cosmetic), **8 → recommended P4-20
(AskUserQuestion renderer, §7 — not yet drafted; operator greenlight).** Full row-level resolution:
`PARITY-LEDGER.md` Part C.

**⚠ That 2026-07-07 resolution is SPENT — re-derived 2026-07-26.** All those owners ran. A nine-range
re-audit re-verified every ⬜/❓ row against current source (❓ 10 → 45), and the 82 rows tagged
`⬜ deferred — ORPHANED` (owner session ran, never covered the row, never §0-flagged it) were
**promoted to ❓ rather than waived**, per the operator: *"i dont mind working it all. Just added it
as a task in phase4 then."* Danger list **45 → 127**; realized parity **unchanged at 79%** (⬜ and ❓
are both in-scope — the promotion cannot move the ratio). The six **TRANCHE G** rows above own all
127. Per-row map + the owning session per row: `PARITY-LEDGER.md` Part C, itemized parts 1 and 2.

---

## TRANCHE A — foundations

## P4-0 · 🟡 — Composer / ChatView enrichment (@-mention, paste-collapse, history)

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 7/10 · 🖐 GUI

You are running P4-0 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
Electron + N Bun engine sidecars over Unix sockets, raw SDKMessage fidelity — locked. The app
already has a minimal composer that submits real turns (P1-2) and a SlashCommandPicker typeahead
(P3-7, `app/renderer/src/SlashCommandPicker.tsx`). This session brings the composer to prototype
parity: @-mention (file/agent), paste-collapse (large paste → a collapsed attachment chip),
and input history (↑/↓ recall). Submit still rides the EXISTING `app.submit` — the renderer
gains NO new execution capability.
Step 0: INVENTORY §W4 row "Composer `ChatView`" (⚓9, S1/S2 partial, adapt/build-new).
Ledger (CC-1): `PARITY-LEDGER.md` Part A §6 (Chat.jsx) = your element checklist + visual-acceptance
bar. NOTE §6's activity/streaming/scroll rows are P4-18's scope — you own the composer rows + 3 ❓
(add-attachment button + slash-picker footer §10). DONE-WHEN flips/clears your rows to ✅ with `app/…:line`.
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/Chat.jsx.

=== BUILD ===
- **@-mention:** a MentionPicker over the real mention sources — file paths (recon the engine's
  file/@-mention resolution; cite src:line) and agents (`AgentIdentity` if P4-2 landed, else the
  raw agent list). Reuse the P4-1 MentionPicker primitive if available; otherwise build it and
  note the join. Inserted mentions are plain text in the prompt — no new wire vocabulary.
- **Paste-collapse:** a large paste collapses to an attachment chip (expand/remove); on submit it
  expands back into the prompt text. Recon whether the engine already models pasted attachments;
  if not, this is renderer-local text handling (flag if the prototype implies an engine feature).
- **Input history:** ↑/↓ recalls prior submitted prompts for the ACTIVE session (renderer-local,
  per-session, keyed by activeSessionId — P3-4 keying; do not bleed across sessions).
- Keyboard-first, matches the prototype's composer feel; SlashCommandPicker + this must coexist
  (slash at line-start opens the picker; @ opens mentions).

=== GROUND RULES ===
Locked decisions + full security baseline. Submit rides existing `app.submit` only. No inline
style; extend the shell's visual language. Re-verify anchors; source wins.

=== DELIVERABLE / DONE WHEN ===
Headless (yours): `bun test app/` green (mention filter, paste-collapse model, history recall,
per-session isolation); renderer tsc clean; sidecar tsc no NEW errors.
Visual-fidelity (yours): side-by-side vs Chat.jsx — composer chrome, mention popover, attachment
chip, and states read as the prototype; list any intentional divergence as a §0 flag.
GUI (operator's — STOP, print steps, wait; NO automation): type `@`, pick a file → mention
inserts; paste a large block → collapses to a chip → submit → engine receives the full text;
↑ recalls the last prompt; `/` still opens the slash picker.
Report back: the mention sources you wired (with src:line), the paste/history models, the
visual-fidelity comparison result, and any prototype-implies-engine-feature flag.
```
─── PASTE ───

## P4-1 · 🟡 — Shared primitive kit (Chip / ChipStrip / BannerStack / ToastHost / MentionPicker / ToolInspector) + ConnectionChip

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 6/10

You are running P4-1 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
This is the reusable product-primitive layer every W4 domain renders with (toasts, banners,
chips, the mention popover, the tool inspector) plus the real connection chip. It is
presentation + tiny local state only — NO engine data of its own. Building it first means the C
domains reuse it instead of each reinventing a toast.
Step 0: INVENTORY §W5 rows "Shared primitives" (⚓5, S7 partial, adapt) + "Connection UI" (⚓2 —
**cut `ConnectionDemoBar` simulator**; keep `ConnectionChip`/`CONN_STATES` over REAL connection
state, `app/renderer/src/connectionState.ts`).
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/Surfaces.jsx.

=== BUILD ===
- `Chip` / `ChipStrip` (tone-aware, on the P0-2 `--tone-*` tokens), `BannerStack` (dismissable,
  stacked notices — the reauth banner in P4-15 mounts here), `ToastHost` (transient toasts, a
  real API the domains call — the prototype's `window.toast` becomes a real provider),
  `MentionPicker` (the popover P4-0 consumes; keep data-source-agnostic — caller supplies items),
  `ToolInspector` (read-only inspector over a transcript tool row's real input/result — reuse the
  projector's row shape, `app/renderer/src/transcriptProjector.ts`, zero casts).
- `ConnectionChip` renders the real per-session connection state (`connectionState.ts` —
  connecting/ready/disconnected + P3-0 typed failures), NOT a demo simulator. `ConnectionDemoBar`
  is CUT (INVENTORY CUT list).

=== GROUND RULES ===
Security baseline (these render untrusted tool/model content — no HTML injection; ToolInspector
shows structured data, never eval). Pure presentation; no new frames. No inline style.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (ToastHost queue/dismiss, BannerStack stacking, Chip tone
mapping, MentionPicker filter, ToolInspector narrows real row shapes tolerantly); renderer tsc
clean. Visual-fidelity: side-by-side vs Surfaces.jsx for each primitive; flag divergences.
Report back: the primitive API surface (esp. the ToastHost/BannerStack provider the domains
call), and confirmation ConnectionChip reads real state (no demo simulator).
```
─── PASTE ───

## P4-2 · 🟢 — AgentIdentity (shared agent/worker vocabulary)

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 3/10

You are running P4-2 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
A small shared vocabulary (agent name/role/state → label/tone/icon) that P4-8 (Orchestrator) and
P4-9 (Tasks) both consume, so worker chrome is consistent. Per D2 (`decisions/AGENT-CHROME.md`)
it must compress REAL worker/task/agent state, not the prototype's fixture vocabulary.
Step 0: INVENTORY §W5 row "AgentIdentity" (⚓4, S5 partial, adapt — "compresses real worker/task/
agent state"). Read `decisions/AGENT-CHROME.md`.
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/AgentIdentity.jsx.

=== BUILD ===
- A pure module mapping real agent/worker fields → display vocabulary. Recon the real shapes
  first (D2 anchors: `src/agent-mode/sessionState.ts`, worker derivations
  `workerUxSummary.ts:72-112`, `BackgroundTaskStatus.tsx:25` — re-verify). Keep it data-only;
  no engine reads here (P4-8/P4-9 own the read-seam). Fixture-only fields → dropped + flagged.

=== GROUND RULES ===
Security baseline. Pure module, no frames, no engine imports beyond types.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (vocabulary mapping over real-shape fixtures); renderer tsc clean.
Visual-fidelity: the label/tone/icon set matches AgentIdentity.jsx; flag any compression.
Report back: the real fields you mapped (src:line) and what prototype vocabulary you dropped.
```
─── PASTE ───

## P4-3 · 🟡 — Settings shell + `Field` / `SourceBadge` / `ManagedBadge` primitives

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 5/10

You are running P4-3 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
The Settings frame + its field primitives, which P4-12 (extensions) plugs panels into. The real
settings model is broader than the prototype: values have a SOURCE (default/user/project/local/
managed) and an editable-vs-managed status. Build the shell + primitives over the real model;
panels come later.
Step 0: INVENTORY §W4-Settings row "Settings shell + Field/SourceBadge/ManagedBadge" (⚓1, S7
partial, adapt — "real source/editable/managed model is broader").
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/Settings.jsx.

=== BUILD ===
- Recon the real settings source/precedence model (`src/utils/settings/settings.ts` — the same
  file P3-5a hardened; `updateSettingsForSource` + the source layers; cite src:line, re-verify).
  `SourceBadge` renders the real source; `ManagedBadge` marks managed/non-editable values.
- **Read-seam:** a read-only settings snapshot (C3 precedent — read-only outbound, secretGuard;
  no renderer-authored writes here — writes are a later, decided action). Follow the domain
  read-seam recipe (Standing rules); if P4-5 already established it, copy that.
- `Field` = the labeled, source-badged, editable-or-managed row primitive the panels reuse.

=== GROUND RULES ===
Locked decisions + security baseline. Settings writes (if any) go through the
`SettingsUpdater`-under-lock form (P3-5a) — but v1 here is READ + the shell; flag write scope.
No inline style.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (source precedence rendering, managed/editable states, snapshot
selector); renderer/sidecar tsc no NEW errors; hardening if the read frame is added.
Visual-fidelity: shell + Field/badges vs Settings.jsx; flag divergences.
Report back: the real settings model (src:line), the read-seam you added, and the Field API P4-12
consumes.
```
─── PASTE ───

---

## TRANCHE B — the P3 shell-fidelity true-up (STATUS carry-forward)

## P4-4 · 🔴 — Shell-fidelity true-up: Sidebar / TabBar / root shell / WorkspaceLayout vs the prototype

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 7/10 · 🖐 GUI

You are running P4-4 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
The Phase-3 shell (P3-5a/5b root shell + TabBar + Sidebar; P3-6 WorkspaceLayout) passed on
FUNCTION but was built to a provisional in-house "shell grammar" and DIVERGES from the prototype
(STATUS Phase-4 header). Design TOKENS/accent are already faithful (`app/renderer/src/theme.css`
— pink `--accent` #f472b6, dark palette match); the drift is LAYOUT / CHROME / FEATURES. This
session trues the shell up to the prototype WITHOUT regressing the functional gate (multi-session
switch, close/restore, crash tabs, split panels, keyboard). This is the fix the operator folded
into Phase 4 — and it sets the corrected shell grammar every later C-domain renders inside.
Step 0: INVENTORY §W2 rows Sidebar (⚓4), TabBar (⚓4), Root state/routing `AppV2.jsx` (⚓7),
WorkspaceLayout (⚓4). (W2 was Phase-3 scope; this is its fidelity pass, not a re-architecture.)
Step 1 (UX spec + VISUAL BAR — the whole point): ~/catcode_prototype/cat-app/Sidebar.jsx,
TabBar.jsx, AppV2.jsx, WorkspaceLayout.jsx.

=== BUILD (true up the CHROME, keep the wiring) ===
- **Sidebar:** the known drift — the prototype is a hover-expanding rail (48px→240px, pin,
  shadow, easing), a paw logo (PawLogo SVG), a nav destination rail (Chat/Sessions/Goals/Accounts/
  Settings — wire the ones whose pages exist, no-op/hide the not-yet-built ones and FLAG them),
  session search, and workspace grouping. The built Sidebar (`app/renderer/src/Sidebar.tsx`) is a
  static 240px roster with tone chips + restore. Reconcile toward the prototype: keep the REAL
  live∪restorable data (SessionDescriptor truth — no cost/model/tags fixtures, that C3 call
  stands), but adopt the prototype's STRUCTURE (rail/expand, logo, search, grouping-by-cwd since
  workspace is derivable from cwd). Every field the prototype shows that has no real backing →
  keep flagged, don't mock.
- **TabBar / root shell:** align spacing, chrome, tab visual grammar, keyboard affordances to
  AppV2.jsx/TabBar.jsx while preserving P3-4/P3-5 wiring (HostEvent projection, background
  streaming, dead-tab restart, ⌘1-9).
- **WorkspaceLayout:** align the splitter/panel chrome to WorkspaceLayout.jsx; keep P3-6's
  renderer-owned persistence + the re-apply-on-restore fix intact (do not regress).
- Do NOT invent a third grammar — this session REPLACES the provisional one with the prototype's.

=== GROUND RULES ===
Locked decisions + full security baseline; HC1 (renderer never authors a cwd) unchanged. Preserve
ALL Phase-3 functional behavior — this is chrome, not re-wiring; if a fidelity change forces a
wiring change, STOP and report. No inline style. Nav items pointing at unbuilt pages are
hidden/disabled + flagged, never mocked.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (all Phase-3 shell tests still pass unmodified or with
mechanical-only edits, explained); renderer tsc clean; sidecar tsc no NEW errors; hardening 19/19.
Visual-fidelity (the gate): side-by-side vs the four prototype files — the shell now READS AS the
prototype (rail/expand, logo, search, grouping, tab + splitter chrome). Produce a per-surface
before/after note; every remaining divergence is a §0 flag.
GUI (operator's — STOP, print steps, wait; NO automation): launch; confirm the sidebar rail
hover-expands, search filters, sessions group by workspace, the nav rail shows built destinations;
two sessions still switch with isolated transcripts; close→restore still works; split panels +
relaunch-restore still work (P3-6 parity).
Report back: the per-surface fidelity delta closed, anything still divergent (flagged), and
confirmation zero functional Phase-3 behavior regressed.
```
─── PASTE ───

---

## TRANCHE C — domains (each copies the domain recipe)

## P4-5 · 🔴 — Accounts domain: AccountsPage + Codex pool/lease + AccountLifecycle (establishes the domain read-seam)

─── PASTE ───
```
🧠 Model: CLAUDE (system-architecture) · Difficulty: 8/10 · 🖐 GUI

You are running P4-5 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
The Accounts domain surfaces the real Codex account pool: per-account health/lease/refresh state,
add/remove/login lifecycle. It is the FIRST W4 domain to cross new data over the boundary, so it
ALSO sets the domain read-seam recipe every later domain copies. **Secrets are the hard part:**
tokens/credentials are engine-owned and must NEVER leave the sidecar — the renderer sees redacted
status only (`secretGuard` on every outbound frame; SECURITY-MINIMUM secret-owner rule).
Step 0: INVENTORY §W4 rows "Accounts `AccountsPage`, Codex pool, leases" (⚓10, S8 partial, adapt)
+ "`AccountLifecycle` dialogs" (⚓2). Read `decisions/PERMISSION-BOUNDARY.md` (C3 read-only
snapshot precedent) + `decisions/SECURITY-MINIMUM.md` (secret owner).
Ledger (CC-1): `PARITY-LEDGER.md` Part A §14 (Pages→AccountsPage) + §15 (AccountLifecycle) = your
pre-enumerated element checklist + visual-acceptance bar (0 ❓ — all rows ⬜ deferred to you; §14 also
holds Diagnostics/Trust = P4-14, take only the Accounts rows). DONE-WHEN flips them to ✅ with `app/…:line`.
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/Pages.jsx (AccountsPage) +
AccountLifecycle.jsx.

=== BUILD ===
- **Recon the real pool** (cite src:line, re-verify): `src/services/api/codexAccountPool.ts`
  (health states `:68,:620,:1128`), refresh/reauth signal `src/services/api/codexTokenRefresh.ts`
  (`reauth_required :449`, identity-mismatch `:574`), lease model. Determine the redacted status
  shape the renderer needs (account id/alias, health, last-refresh, reason) — NO tokens.
- **Read-seam (THE recipe — build it cleanly, later domains copy):** a read-only outbound
  `accounts.snapshot`-style frame (C3 precedent) carrying ONLY redacted status; `secretGuard`
  enforced + a hardening test proving no credential material serializes. A `accountsDomain.ts`
  service + selectors (layer 3). Reactive off the same store the pool updates, not a poll.
- **Lifecycle actions:** add / remove / login (OAuth) / switch. Login re-uses the real OAuth
  machinery (`src/components/ConsoleOAuthFlow.tsx:35-55` states) — the renderer drives navigation,
  the engine owns the token write (mirror how P4-15 does first-run auth; coordinate the shared
  OAuth surface). Any inbound action frame carries T5a/T6/T7 + is a decided, minimal verb.
- **Expose pool status for P4-15 (reauth banner) + P4-17 (welcome account table)** — this snapshot
  is the producer for both; name the join in your report.

=== GROUND RULES ===
Locked decisions + FULL security baseline; secret-owner is non-negotiable (renderer NEVER sees a
token). Preload additions via HC3 fixed senders only. No inline style. Re-verify anchors.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (snapshot redaction, secretGuard no-leak test, lifecycle action
round-trips, selectors); renderer tsc clean; sidecar tsc no NEW errors; `test:hardening` proves
no credential serializes on any outbound frame.
Visual-fidelity: AccountsPage table + lifecycle dialogs vs Pages.jsx/AccountLifecycle.jsx; flag
fixture-only columns.
GUI (operator's — STOP, print steps, wait; NO automation): with a real credentialed pool, the
Accounts page shows real accounts + health; trigger a login/re-auth flow; confirm NO token text
ever appears in the renderer/debug export.
Report back: the read-seam contract (the recipe later domains copy), the redaction proof, the
OAuth coordination with P4-15, and the pool-status producer join.
```
─── PASTE ───

## P4-6 · 🟡 — Sessions page + SessionActionsMenu + Branch/Export/Rewind dialogs + MetadataInspector

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 7/10 · 🖐 GUI

You are running P4-6 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
The Sessions catalog: a page over real session/transcript metadata (much richer than the
prototype's MOCK_SESSIONS_EXTENDED), the per-session actions menu (branch/export/rewind/rename/
copy/delete), and a read-only MetadataInspector. Real branch/export/rewind commands exist
separately in the engine — wire to them, don't reinvent.
Step 0: INVENTORY §W4 rows "Sessions page" (⚓1, S4), "SessionActionsMenu + dialogs" (⚓6, S4
partial), "MetadataInspector" (⚓1, S4). S4 = real file-backed LogOption/transcript metadata.
Ledger (CC-1): `PARITY-LEDGER.md` Part A §16 (SessionsPage) + §17 (SessionActions) + §18
(MetadataInspector) = your element checklist + visual-acceptance bar (0 ❓ — all rows ⬜ deferred to
you; the session-titles gap in §2 Sidebar is your rider, below). DONE-WHEN flips them to ✅ with `app/…:line`.
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/SessionsPage.jsx, SessionActions.jsx,
MetadataInspector.jsx.

=== BUILD ===
- **Recon real session metadata** (`src/utils/sessionStorage.ts` — `LogOption`, transcript dirs
  `getProjectDir`/`getTranscriptPathForSession :240`; the D1 registry rows via the host API carry
  cwd/lastAttachedAt/title). The catalog = registry rows ∪ engine transcript history (same derive
  approach D5 blessed for Welcome — coordinate the shared selector; don't build a second store).
- **Actions** wire to the real branch/export/rewind commands (recon their call sites, cite
  src:line). Rename/copy/delete map to real operations; anything with no backing → flag, don't
  mock. The menu/dialog shell is GUI-owned chrome over real verbs.
- **MetadataInspector** = read-only over real log/message fields (no per-message account field —
  the prototype invents that; flag it).
- Read-seam per the recipe (P4-5) for any metadata not already on the host API.

=== GROUND RULES ===
Locked decisions + security baseline. Actions that mutate transcripts/state go through real engine
verbs, not renderer-authored writes. No inline style.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (catalog selector over registry∪history, action wiring,
inspector narrows real fields); renderer/sidecar tsc no NEW errors.
Visual-fidelity: SessionsPage/actions/inspector vs the three prototype files; flag fixtures.
GUI (operator's — STOP, print, wait; NO automation): open Sessions → real sessions listed;
export one → real output; branch/rewind reach the real command; inspector shows real metadata.
Report back: the real metadata + command call-sites (src:line), fixture fields flagged, and the
shared catalog-selector join with P4-17.
```
─── PASTE ───

## P4-7 · ✅ — Agents config (AgentsPage)

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 5/10

You are running P4-7 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
The agent-definition config editor (agent defs live under Settings → Extensions → Agents per the
prototype's own nav note). The real agent/runtime model is broader than the prototype editor.
Step 0: INVENTORY §W4 row "Agents config `AgentsPage`" (⚓3, S5, adapt).
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/AgentsPage.jsx.

=== BUILD ===
- Recon the real agent/subagent definition model (`src/agent-mode/`, agent registry/config; cite
  src:line, re-verify) — the source of truth for defined agents, their roles/tools/model. Render
  a real read view; editing (if in scope) goes through real config writes with the
  settings-write discipline. Fixture-only fields → flag.
- Read-seam per the P4-5 recipe for the agent-config snapshot.

=== GROUND RULES ===
Locked decisions + security baseline; config writes use the SettingsUpdater-under-lock form. No
inline style.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (agent-config read/selectors; write path if in scope); tsc clean.
Visual-fidelity: AgentsPage vs the prototype; flag divergences.
Report back: the real agent model (src:line), read/write scope, fixture fields flagged.
```
─── PASTE ───

## P4-8 · 🔴 — Orchestrator: roster / detail / focus (8 surfaces, D2)

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 8/10 · 🖐 GUI

You are running P4-8 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
Orchestrator/Agent-Mode UI: the worker roster, worker detail, focus (teammate) view, and the
inline agent cards. D2 is DECIDED (`decisions/AGENT-CHROME.md`) — implement it, don't redesign:
ALL EIGHT surfaces adapt over REAL shapes; inline `AgentToolCard`/`DelegateGroup` are KEPT (the
real inline idiom, `AgentTool/UI.tsx:458,740`); their fixture data feeds are CUT; `AgentEventRow`
+ `AttachmentCard` CUT (no seam frame); `GroupedToolGroup`-as-a-type CUT (grouping stays a
projector derivation). **Binding: subagent frames NEST under the owning agent card, never
interleave** (resolves P2-0's open finding; P2-2's `selectNestedTranscriptRows` is the seam).
Step 0: INVENTORY §W4 row "Orchestrator …" (⚓8, S5). Read `decisions/AGENT-CHROME.md` IN FULL.
Ledger (CC-1): `PARITY-LEDGER.md` Part A §20 (OrchestratorMode — the 8 D2 sub-surfaces) = your
element checklist + visual-acceptance bar (0 ❓ — all rows ⬜ deferred to you). DONE-WHEN flips them to ✅ with `app/…:line`.
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/OrchestratorMode.jsx (IGNORE the
`OrchestratorDemoSwitch` A/B/C scaffold — INVENTORY CUT list).

=== BUILD ===
- Real shapes (D2 anchors — re-verify): roster `AgentModeWorkerRoster.tsx:30`, panel
  `BackgroundTasksDialog.tsx:131`, focus = teammate view, pill `BackgroundTaskStatus.tsx:25`,
  derivations `workerUxSummary.ts:72-112`, agent mode `src/agent-mode/agentMode.ts`, state
  `src/agent-mode/sessionState.ts`, handoff/blocked `LocalAgentTask.tsx`.
- `accountsDomain`-style read-seam (P4-5 recipe) for worker/roster status; `AgentIdentity` (P4-2)
  for vocabulary. Inline agent cards render via the projector's nested rows (never interleave).
- Roster / detail / focus views over real worker state; fixture feeds cut; no demo switch.

=== GROUND RULES ===
Locked decisions + security baseline; D2 bindings are law. No inline style; extend the trued-up
shell grammar (post-P4-4). Re-verify anchors.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (roster/detail/focus selectors over real-shape fixtures, nested
inline-card rendering, no-interleave assertion); renderer/sidecar tsc no NEW errors.
Visual-fidelity: the three views + inline cards vs OrchestratorMode.jsx; flag divergences.
GUI (operator's — STOP, print, wait; NO automation): run a turn that spawns a subagent → its
frames nest under the owning agent card (do not interleave into the parent transcript); roster
shows real workers; focus view opens.
Report back: the real worker shapes wired (src:line), the nesting proof, and D2 conformance.
```
─── PASTE ───

## P4-9 · 🟡 — Tasks (BgTasksDialog / TasksPanel)

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 5/10

You are running P4-9 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
Background-tasks surfaces: `BgTasksDialog` (grounded) and the in-session `TasksPanel` (unanchored
GUI). Per the prototype nav, tasks attach to the session (a strip below the transcript / ⌘K →
/tasks), not a top-level page. Reuse D2/`AgentIdentity` (P4-2) vocabulary and the P4-5 read-seam.
Step 0: INVENTORY §W4 row "Tasks `BgTasksDialog` / `TasksPanel`" (⚓4 / ⚓0, S5).
Ledger (CC-1): `PARITY-LEDGER.md` Part A §21 (TasksPage) = your element checklist + visual-acceptance
bar (0 ❓ — all rows ⬜ deferred to you). DONE-WHEN flips them to ✅ with `app/…:line`.
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/TasksPage.jsx + OrchestratorMode.jsx
(TasksPanel).

=== BUILD ===
- Recon the real background-task model (`BackgroundTasksDialog.tsx:131`, task/worker state; cite
  src:line). `BgTasksDialog` renders real tasks; `TasksPanel` is the in-session strip over the
  same data (flag its unanchored parts). Read-seam via the P4-5 recipe (or reuse P4-8's if shared).

=== GROUND RULES ===
Locked decisions + security baseline. No inline style.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (task selectors over real shapes); tsc clean.
Visual-fidelity: BgTasksDialog/TasksPanel vs the prototype; flag the unanchored TasksPanel parts.
Report back: the real task model (src:line), shared read-seam with P4-8, fixtures flagged.
```
─── PASTE ───

## P4-10 · 🟢 — Goals + Memory panels

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 4/10

You are running P4-10 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
Two small read-mostly panels over real per-thread/config state: Goals (per-thread persisted goal)
and Memory (`/memory`). Both are S8; both compress real state behind GUI wrappers.
Step 0: INVENTORY §W4 rows "GoalsPage + GoalDetail + dialogs" (⚓1/⚓0, S8) + "MemoryPanel `/memory`"
(⚓1, S8 — real memory types `src/memdir/memoryTypes.ts:14-21`).
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/GoalsPage.jsx + Surfaces.jsx (GoalDetail)
+ MemoryPage.jsx.

=== BUILD ===
- **Goals:** the real thread goal is per-thread persisted state (recon; the goalSnapshot/
  parseThreadGoal path is T4-validated — cite src:line). Render real goal + create/replace via the
  real verb; roster/dialogs are GUI wrappers. Read-seam per the P4-5 recipe.
- **Memory:** real types `src/memdir/memoryTypes.ts:14-21` (re-verify). Render the memory list/panel
  over real memdir state; edits (if in scope) through real writes.

=== GROUND RULES ===
Locked decisions + security baseline; T4 goalSnapshot validation preserved. No inline style.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (goal + memory selectors over real shapes); tsc clean.
Visual-fidelity: Goals + Memory panels vs the prototype files; flag GUI-wrapper fixtures.
Report back: the real goal + memory shapes (src:line) and read/write scope.
```
─── PASTE ───

## P4-11 · 🟡 — PlanBar / PlanPanel

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 4/10

You are running P4-11 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
The plan surface. Real "plan" = file/tool approval state (plan mode); the prototype's live
checklist/progress drawer is GUI-owned storytelling over it. Adapt to the real approval state,
flag the invented progress chrome.
Step 0: INVENTORY §W4 row "`PlanBar` / `PlanPanel`" (⚓3, S6, adapt/build-new).
Ledger (CC-1): `PARITY-LEDGER.md` Part A §24 (PlanPanel) = your element checklist + visual-acceptance
bar (0 ❓ — all rows ⬜ deferred to you). DONE-WHEN flips them to ✅ with `app/…:line`.
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/PlanPanel.jsx.

=== BUILD ===
- Recon the real plan-mode / approval state (permission mode `plan`, plan approval; the P2-4
  permission context already surfaces mode — reuse it; cite src:line). Render the real plan/
  approval; the checklist/progress drawer with no real backing → flag, don't fabricate progress.

=== GROUND RULES ===
Locked decisions + security baseline (plan mode is a permission-plane concept — reuse P2-4's
context read, don't invent a parallel one). No inline style.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (plan/approval selectors); tsc clean.
Visual-fidelity: PlanBar/PlanPanel vs PlanPanel.jsx; flag the GUI-owned progress drawer.
Report back: the real plan/approval state reused (src:line) and what chrome you flagged as invented.
```
─── PASTE ───

## P4-12 · 🟡 — Settings extensions (MCP / Plugins / Skills / Hooks / Elicitation)

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 7/10

You are running P4-12 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Dependency: P4-3 (Settings shell + Field/badges) green. Echo the header line above back first.

=== CONTEXT (you start cold) ===
The settings sub-panels: MCP servers, Plugins, Skills, Hooks, and the Elicitation dialog. Real
domains exist; the prototype flattens scoped state and hook outcomes. Plug panels into P4-3's
Settings shell + Field primitives.
Step 0: INVENTORY §W4-Settings row "`MCPPanel`, `PluginsPanel`, `SkillsPanel`, `HooksPanel`,
`ElicitationDialog`" (⚓5, S7, adapt).
Ledger (CC-1): `PARITY-LEDGER.md` Part A §25 (SettingsExtensions) = your element checklist +
visual-acceptance bar (0 ❓ — all rows ⬜ deferred to you). NOTE the CORE settings editors (§11) are
P4-19's scope, NOT yours — you own only the extension panels. DONE-WHEN flips your §25 rows to ✅ with `app/…:line`.
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/SettingsExtensions.jsx.

=== BUILD ===
- Recon each real domain (MCP config `src/services/mcp*`/config; plugins; skills registry; hooks
  config + outcomes; elicitation flow — cite src:line, re-verify). Render each over real scoped
  state via P4-3's Field/SourceBadge; the prototype's flattened scope + faked hook outcomes →
  render real scope, flag the flattening. Read-seam per the P4-5 recipe.
- `ElicitationDialog` maps to the real elicitation request flow (recon; if it's a control
  request/response, treat it with the permission-round-trip rigor — flag if so).
- **MCP runtime wiring guardrail (two-strikes owner — this session):** desktop MCP startup is
  EMPTY today: `app/sidecar/sessionController.ts:172-187` feeds
  `createQueryEngineAppSessionConfigFromSetup` hardcoded empty `mcpClients`/`mcpTools`/
  `mcpCommands`/`mcpResources`. Flagged twice (P4-7 §0 flag in STATUS +
  `docs/reports/2026-07-08-app-engine-duplication-review.md`), so per the two-strikes rule this
  session is the named owner. If you (or a rider you propose) wire LIVE MCP runtime state, do NOT
  hand-wire it in the sidecar: extract the engine's own runtime setup — `src/main.tsx:3159-3198`
  awaits `mcpPromise`, writes real clients/tools/commands/resources into app state, then combines —
  into a `src/app-runtime/` entry point and have `sessionController.ts` consume it. A hand-wired
  sidecar copy would be the FOURTH instance of the §8.1 stub-context defect class (P1-3/P2-4/P3-7).
  If this session ships config panels only and defers live wiring, keep the deferral tagged with
  this same owner note in your report + STATUS row.

=== GROUND RULES ===
Locked decisions + security baseline. Writes via SettingsUpdater-under-lock. No inline style.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (each panel's real-state selectors; elicitation flow); tsc clean.
Visual-fidelity: each panel vs SettingsExtensions.jsx; flag flattened/ faked parts.
Report back: each real domain (src:line), what scope the prototype flattened, and elicitation's
real shape.
```
─── PASTE ───

## P4-13 · 🟡 — RemoteSettings (cut scope, D3)

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 5/10

You are running P4-13 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
RemoteSettings, at the OPERATOR-RULED cut scope (D3, `decisions/PAIRED-DEVICES.md` §4): NO
paired-device roster/wizard, NO device identity/authz model (deferred to v2). v1 = bridge
toggle/status + read-only command-filter TRUTH + a direct-connect form over the real primitives.
Step 0: INVENTORY §W4-Settings row "`RemoteSettingsPanel`, `RemoteRolePill`" (⚓9, S7, **D3 CUT**).
Read `decisions/PAIRED-DEVICES.md` §3 (the cut-down buildable surface).
Ledger (CC-1): `PARITY-LEDGER.md` Part A §26 (RemoteSettings) = your element checklist +
visual-acceptance bar (0 ❓ — the D3 cut/deferred split is already tagged per row). DONE-WHEN flips your kept rows to ✅ with `app/…:line`.
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/RemoteSettings.jsx — but build ONLY the
cut-scope surface; the roster/wizard is CUT, do not port it.

=== BUILD (cut scope only) ===
- **Bridge toggle + status** over the real flag (`AppState.replBridgeEnabled`; hooks
  `src/hooks/useReplBridge.tsx`, `src/bridge/initReplBridge.ts` — re-verify).
- **Command-filter truth** rendered read-only from `BRIDGE_SAFE_COMMANDS` / `isBridgeSafeCommand`
  (`src/commands.ts:676-700`) — render the REAL list, never a copied array.
- **Direct-connect form** calling the real `createDirectConnectSession`
  (`src/server/createDirectConnectSession.ts:26`; hook `src/hooks/useDirectConnect.ts:39`).
- `RemoteRolePill` survives ONLY as a label where a real role exists (remote-session
  viewer/controller, `src/remote/RemoteSessionManager.ts`) — not as a per-device control.

=== GROUND RULES ===
Locked decisions + FULL security baseline (this is inbound-control-adjacent; render honest state,
add NO new trust surface — D3 forbids a device model). No inline style.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (bridge toggle state, filter rendered from the real constant,
direct-connect form wiring); tsc clean.
Visual-fidelity: the CUT surface vs the real parts of RemoteSettings.jsx; confirm no roster/wizard.
Report back: the three real primitives wired (src:line), confirmation the device roster is CUT
(no new identity/authz), and where RemoteRolePill survives as a label.
```
─── PASTE ───

## P4-14 · 🟡 — Diagnostics + WorkspaceTrust sections

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 4/10

You are running P4-14 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
Two settings sections with no surface-local anchors but real backing: a Diagnostics readout and a
Workspace-Trust section. Recon-first (⚓0).
Step 0: INVENTORY §W4-Settings row "`DiagnosticsSection`, `WorkspaceTrustSection`" (⚓0, S6/S7,
adapt/recon).
Ledger (CC-1): `PARITY-LEDGER.md` Part A §14 (Pages→Diagnostics/WorkspaceTrust sections) = your
element checklist + visual-acceptance bar (0 ❓; §14 also holds AccountsPage = P4-5, take only the
Diagnostics/Trust rows). DONE-WHEN flips them to ✅ with `app/…:line`.
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/Pages.jsx (the two sections).

=== BUILD ===
- **Diagnostics:** recon the real status/diagnostics helpers (connection, engine, pool health;
  cite src:line). Render real status, no demo/prototype-controls stub (INVENTORY CUT list forbids
  `PrototypeControlsSection`/`ConnectionDemoSection`).
- **WorkspaceTrust:** render per-path trust state from the real store (`config.ts:111,735-788` —
  same store as D4/G1; re-verify). Read-only view of trusted paths; wiring the trust action is
  P4-15's gate — here it's the settings-section VIEW.

=== GROUND RULES ===
Locked decisions + security baseline. No demo stubs. No inline style.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (diagnostics + trust selectors over real state); tsc clean.
Visual-fidelity: both sections vs Pages.jsx; flag anything with no backing.
Report back: the real status/trust helpers (src:line) and confirmation no demo stub shipped.
```
─── PASTE ───

---

## TRANCHE D — startup / launch

## P4-15 · 🔴 — Startup + trust gate + first-run OAuth + reauth banner (D4)

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 7/10 · 🖐 GUI

You are running P4-15 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Dependency: P4-5 (Accounts) green — the reauth banner reads its pool status. Echo the header first.

=== CONTEXT (you start cold) ===
The startup gates, at the OPERATOR-RULED scope (D4, `decisions/STARTUP-GATES.md`):
- Trust gate = ADAPT, **per-session-create** (not per-launch): when a session is created in a cwd
  (native picker or registry row, HC1), check per-path trust; if untrusted, show the trust dialog
  for that session before spawn. Trust persists in the SAME config the engine reads (never fork a
  trust store).
- First-run OAuth = ADAPT: if no credentialed account exists, surface the OAuth flow (states incl.
  the Codex `waiting_for_alias` step). Coordinate the OAuth surface with P4-5 (shared).
- **Q1 RULED = TUI parity:** NO read-only mode — `ReadOnlyModeGate` + "Open read-only" are CUT
  (decline trust = exit). Do NOT build a restricted mode.
- **Q2 RULED = non-blocking reauth banner:** token death surfaces as a persistent banner/badge
  (P4-1 `BannerStack`) driven by P4-5 pool status, with a "re-authenticate" action launching the
  OAuth flow scoped to that account; block submit ONLY when zero healthy accounts remain. The
  prototype's blocking `ReauthGate` modal is CUT.
- `WorkspaceSwitchPrompt` = CUT (D4/G4 — one-cwd-per-session dissolves it).
Step 0: INVENTORY §W5 row "Startup/trust `StartupFlow`, `ReauthGate`, `WorkspaceSwitchPrompt`"
(⚓11, S6, **D4**). Read `decisions/STARTUP-GATES.md` §1-§4 IN FULL.
Ledger (CC-1): `PARITY-LEDGER.md` Part A §27 (Startup) = your element checklist + visual-acceptance
bar (0 ❓ — the D4 cut/deferred split is already tagged per row). DONE-WHEN flips your kept rows to ✅ with `app/…:line`.
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/Startup.jsx — build ONLY the ruled
surfaces (trust gate, first-run OAuth, reauth banner); ReadOnlyModeGate + WorkspaceSwitchPrompt +
blocking ReauthGate are CUT.

=== BUILD ===
- Trust gate at session-create: `config.ts:111,188,735-788` (`checkHasTrustDialogAccepted`,
  `isPathTrusted`) + real `TrustDialog` (`src/components/TrustDialog/TrustDialog.tsx`); per-session,
  gates spawn; decline = don't open (no read-only). Re-verify anchors.
- First-run OAuth via `src/components/ConsoleOAuthFlow.tsx:35-55` states; renderer drives
  navigation, engine owns the token (SECURITY-MINIMUM). Reuse/coordinate P4-5's OAuth surface.
- Reauth banner via `BannerStack`, reading P4-5's pool snapshot (`reauth_required`/`auth_dead`
  reason surfaced honestly); submit-block only at zero-healthy.

=== GROUND RULES ===
Locked decisions + FULL security baseline; HC1 (renderer never authors a path); secret owner
engine-side. No read-only mode, no blocking modal, no workspace-switch prompt (all CUT). No
inline style. Re-verify anchors.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (per-session trust gate logic, OAuth state machine, reauth-banner
threshold = zero-healthy-blocks-submit); renderer/sidecar tsc no NEW errors; hardening (token
never in renderer).
Visual-fidelity: trust dialog + OAuth + banner vs Startup.jsx (ruled surfaces only); confirm the
CUT surfaces are absent; flag divergences.
GUI (operator's — STOP, print, wait; NO automation): create a session in an untrusted dir → trust
dialog → trust → spawns (decline → exits, no read-only); with a dead account, the banner shows +
re-auth launches OAuth; window stays usable while another account is healthy.
Report back: the trust/OAuth/banner wiring (src:line), the OAuth coordination with P4-5, and
confirmation ReadOnlyModeGate/WorkspaceSwitchPrompt/blocking-modal are CUT.
```
─── PASTE ───

## P4-16 · 🟢 — Resume dialogs (CrossProjectResumeDialog / HydrationOverlay)

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 4/10

You are running P4-16 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
Resume UI. Real resume is the synchronous restore/recovery already built (P3-1/P3-8, RESTORE-
HISTORY) — the prototype's overlay + cross-project diff list is VISUALIZATION over it. Adapt to
real resume; the diff/hydration animation is presentation.
Step 0: INVENTORY §W5 row "Resume `CrossProjectResumeDialog`, `HydrationOverlay`" (⚓2, S6, adapt).
Ledger (CC-1): `PARITY-LEDGER.md` Part A §28 (ResumeStates) = your element checklist +
visual-acceptance bar (0 ❓ — all rows ⬜ deferred to you). DONE-WHEN flips them to ✅ with `app/…:line`.
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/ResumeStates.jsx.

=== BUILD ===
- Wire to the real restore path (host API `restoreSession`; `RESTORE-HISTORY.md` replay). The
  cross-project resume dialog picks a restorable session (registry rows via host API — same
  data the Sidebar/Welcome use); the hydration overlay visualizes the real replay (P3-5b already
  renders replay:true frames). No new resume machinery — this is the picker + overlay.

=== GROUND RULES ===
Locked decisions + security baseline. No new resume path — reuse P3's. No inline style.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (resume-picker selectors over restorable rows; overlay state);
tsc clean.
Visual-fidelity: dialog + overlay vs ResumeStates.jsx; flag pure-visualization parts.
Report back: the real restore path reused (host API), and what is presentation-only.
```
─── PASTE ───

## P4-17 · 🟡 — Welcome / launcher (derived recents, D5)

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 6/10 · 🖐 GUI

You are running P4-17 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Dependencies: P4-5 (Accounts, for the account table) + P4-15 (trust gate, for the picker) green.
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
The launcher, at the OPERATOR-RULED scope (D5, `decisions/WELCOME-LAUNCHER.md`):
- Recents = **DERIVED**, no new store: registry rows (via host API `listSessions` — cwd/
  lastAttachedAt) ∪ engine project history (`GlobalConfig.projects` `config.ts:188` ∪ transcript
  dirs `sessionStorage.ts:229`), most-recent-first, trust-badged (`config.ts:111`). Reuse the
  same catalog selector P4-6 built (don't build a second).
- "Open folder…" = HC1 native picker. Per-path trust prompt in the picker = P4-15's gate.
- "Start in: locally" = spawn-config cwd (P3-1). **Worktree-at-launch = DEFERRED** (D5/Q2) — do
  NOT build it; branch chooser CUT.
- Account table = P4-5's pool status (read-only); orchestrator toggle = real Agent Mode
  (`src/agent-mode/agentMode.ts`). The welcome screen must NOT grow its own data feeds — it reads
  the domains' seams.
Step 0: INVENTORY §W5 row "`WelcomeScreen`" (⚓1, S6/S8, **D5**). Read `decisions/WELCOME-LAUNCHER.md`
§3 (keep/cut) IN FULL.
Ledger (CC-1): `PARITY-LEDGER.md` Part A §29 (Welcome) = your element checklist + visual-acceptance
bar (0 ❓ — all rows ⬜ deferred to you). DONE-WHEN flips them to ✅ with `app/…:line`.
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/Welcome.jsx — build the derived-recents
scope; worktree + branch chooser are CUT/deferred.

=== BUILD ===
- Derived recents list (the shared selector); open-folder via HC1 picker; start-locally via
  spawn-config; trust badge per path. Account table reads P4-5; orchestrator toggle reads Agent
  Mode. No persisted recents store, no worktree launch, no branch chooser.

=== GROUND RULES ===
Locked decisions + FULL security baseline; HC1 (renderer authors no path — picker or registry row
only). No new store (D5). No inline style. Re-verify anchors.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (derived-recents selector over registry∪history, trust badging,
open/start wiring); renderer/sidecar tsc no NEW errors.
Visual-fidelity: the launcher vs Welcome.jsx (derived scope); confirm worktree/branch-chooser are
absent; flag divergences.
GUI (operator's — STOP, print, wait; NO automation): launch to the welcome screen → recents show
real recent projects (from registry + history), trust-badged; open a folder → trust gate →
session; the account table shows real pool status.
Report back: the derived-recents selector (shared with P4-6), confirmation no new store / no
worktree / no branch chooser, and the domain seams it reads (P4-5 accounts, Agent Mode).
```
─── PASTE ───

---

# TRANCHE E — CC-1 parity backfill

*Surfaced by the CC-1 Parity Ledger (2026-07-07): the two ❓-clusters the A–D tranches never reached.
Not new prototype surfaces — render/wire gaps under already-"built" surfaces.*

## P4-18 · 🔴 — Transcript rendering: user turns + core/boundary rows + tool-card families + activity (CC-1 §5/§6)

*Oversized — run as 18a → 18b → 18c (one sitting each). 18a is the functional fix; do it first.*

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 9/10 · 🖐 GUI

You are running P4-18 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
The desktop transcript renders almost nothing. P2-0..P2-3 built the PROJECTOR (data layer) — every
row type is derived — but `TranscriptView.tsx` only draws `assistant-text` + `tool-use`; line 63
`if (row.kind !== 'tool-use') return null` DROPS user turns, thinking, boundaries, and every rich
tool card. This session builds the RENDER layer. **This is not polish — user messages are invisible.**
Ledger: `PARITY-LEDGER.md` Part A §5 (Messages, 49 ❓) + §6 (Chat activity/scroll, 15 ❓) = your
64-row scope + acceptance bar. Honor D2 (`decisions/AGENT-CHROME.md`): AgentMsgCard adapt; subagent
frames NEST under the owning card; AgentEventRow/AttachmentCard stay CUT.
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/Messages.jsx (the row zoo) + Chat.jsx
(activity indicator + scroll UX). Real row shapes: `app/renderer/src/transcriptProjector.ts`.

=== BUILD (three sub-sessions — one sitting each) ===
18a — CORE ROWS (the functional fix, do FIRST): render every projected NestedTranscriptRow kind —
  user-text (role=user bubble), thinking + redacted-thinking, session-init, result, compact/turn-
  duration/interrupted boundaries, system-notice, command-echo, user-image. Extend the
  `TranscriptView` switch (replace the `return null` fall-through with a tolerant unknown-row
  fallback, never a throw). Every projected kind gets a visible row; exhaustiveness tripwire stays green.
18b — TOOL-CARD FAMILIES: per-family cards off the derived `toolFamily` — Bash (stdout/stderr,
  tail-peek, truncation), FileRead/FileWrite, DiffView (word-level, dual gutters), Grep/Glob, Web,
  Mcp (server›tool), Notebook, Lsp, Skill, GenerateImage (inline image + save actions). Reuse the
  projector's row shape (zero casts). A shared quiet-panel card frame (mark/word/target/state-dot/collapse).
18c — PROSE + ACTIVITY: markdown GFM tables (remark-gfm) + fenced-code syntax highlighting (the
  approved highlighter) + per-block copy; long-content collapse; render-error boundary. Live activity
  indicator (verb + elapsed + per-turn token byline off real SpinnerMode phases) + pulse dots;
  auto-scroll stick-to-bottom + jump-to-bottom control; Stop/interrupt control wired to the real
  `app.abort` boundary capability (+ a keybinding).

=== GROUND RULES ===
Locked decisions + security baseline. RENDER layer only — do NOT change the projector's data contract
(P2 is ✅). Runtime-narrow every block, zero `as` casts, tolerant fallback (display = degrade
gracefully, never throw). No inline style; P0-2 tokens + the trued-up shell grammar. Re-verify anchors.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (a render test per row kind + per tool family; a user-turn render
regression; the exhaustiveness tripwire fires if a kind is unhandled); renderer/sidecar tsc no NEW errors.
Visual-fidelity: transcript vs Messages.jsx per family; activity vs Chat.jsx; flag divergences.
GUI (operator's — STOP, print steps, wait; NO automation): run a real turn with a user message,
thinking, a Bash + an Edit + a web tool, and an interrupt → every row renders, the user turn is
visible, the activity indicator + stop button work, jump-to-bottom works.
LEDGER: flip §5 + §6 rows from ❓/⬜ to ✅ with `app/…:line`; report any residual left ❓ (with reason).
Report back which sub-sessions (18a/18b/18c) landed.
```
─── PASTE ───

## P4-19 · 🟡 — Settings core value-editors: General/Model/Privacy/Theme/Keybindings/IDE/LSP (CC-1 §11)

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 7/10 · 🖐 GUI

You are running P4-19 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Dependencies: P4-3 (Settings shell + Field/SourceBadge/ManagedBadge) green; P4-5 (write-seam recipe)
green. Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
P4-3 built the Settings SHELL + field/source/managed primitives over the real `settings.snapshot`
read-seam, but every core value-editor is a stub. P4-12 covers ONLY the extension panels (MCP/Plugins/
Skills/Hooks) — the core settings fall in the gap. This session wires them.
Ledger: `PARITY-LEDGER.md` Part A §11 (Settings, 40 ❓) = your scope + acceptance bar. Also absorbs
the settings-edit flow ❓ (Part B FLOW-8) and the PermissionRules classifier + managed-rules-only
toggles (§8) — both are real settings controls.
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/Settings.jsx (the General/Model/Privacy/
Theme/Keybindings/IDE/LSP panes). Real shapes: `src/utils/settings/` + `app/sidecar/settingsDomain.ts`
(the P4-3 read-seam).

=== BUILD ===
- **Value editors** reusing P4-3's `Field`/`SourceBadge`/`ManagedBadge`/`PaneSection`: toggle/select/
  text controls bound to real settings keys. Managed keys render disabled with ManagedBadge; flag-
  sourced keys non-resettable (the `editable` gate P4-3 built).
- **Write path (P4-3 deferred it):** edits go through `SettingsUpdater`-under-lock
  (`src/utils/settings/settings.ts`, the P3-5a/DR-2 single-writer form) via a minimal decided inbound
  verb (T5a/T6/T7). Renderer NEVER writes engine state directly. Live re-emit the snapshot on write.
- **Per-pane:** General (display/editor/startup/update-channel[flag]/max-tokens[validate]/telemetry
  [managed]/co-author), Model (default/effort/thinking/fast/summaries/autocompact), Privacy (retention/
  share/crash[managed]), Theme (accent swatch→`--accent`/syntax/code-theme/font/output-style over real
  `src/constants/outputStyles.ts`), Keybindings (vim + shortcuts ref), IDE/LSP (status + connect/diagnose
  over real `useIdeConnectionStatus`/`LSPServerInstance`). Fixture-only fields with no real backing →
  flag (render truth, don't mock).
- **Classifier + managed-rules-only toggles** (from §8 PermissionRules): real settings, surface here.

=== GROUND RULES ===
Locked decisions + FULL security baseline; the write verb is the FIRST renderer→engine settings write —
it MUST use the SettingsUpdater-under-lock form (no lost-update), be a minimal decided verb, and carry
T5a/T6/T7. `secretGuard` on the re-emitted snapshot. No inline style. Re-verify anchors.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (per-editor read/write round-trip, validation, managed-disabled, flag-
non-resettable, under-lock no-lost-update, secretGuard on re-emit); renderer/sidecar tsc no NEW errors;
`test:hardening` if a new inbound verb was added.
Visual-fidelity: each pane vs Settings.jsx; flag fixture-only fields.
GUI (operator's — STOP, print steps, wait; NO automation): edit a value (e.g. accent, effort) →
persists + re-reads; a managed key is disabled; an invalid max-tokens is rejected.
LEDGER: flip §11 rows (+ FLOW-8 + §8 toggles) ❓/⬜ → ✅ with `app/…:line`; report any residual.
Report back: the settings WRITE-seam contract (the first one), the under-lock proof, the redaction proof.
```
─── PASTE ───

## P4-21 · 🟢 — Engine-vocabulary parity fixtures (drift-risk sweep)

(P4-20 remains reserved for AskUserQuestion per the CC-1 follow-ons — not yet drafted.)

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 5/10

You are running P4-21 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
No hard dependency (the owning surfaces P4-3/P4-7/P4-10 are landed). Echo the header line above
back to the operator before starting.

=== CONTEXT (you start cold) ===
Source: `docs/reports/2026-07-08-app-engine-duplication-review.md` (module-level app↔engine
duplication review). Verdict there: zero unowned true duplication, but 15 drift-risk surfaces —
engine-free planes mirror engine vocabulary (labels, unions, orderings) with NOTHING forcing
agreement as `src/` evolves. Displays rot silently: no test fails today when the engine adds a
`PermissionUpdate` variant or renames a settings source. This session is one batched insurance
sweep: parity fixtures / sync tests per vocabulary family so engine drift fails `bun test app/`
loudly instead. TEST-ONLY session: no behavior changes, no new wire vocabulary; if a fixture
exposes vocabulary that has ALREADY drifted, report it — don't silently fix it.

=== BUILD (one family each; the report's §Drift-risk reasoning is the spec) ===
- **Settings sources** (`app/sidecar/settingsDomain.ts`, `app/renderer/src/SettingsField.tsx`):
  snapshot source list/order/labels/editability vs `src/utils/settings/constants.ts` + effective
  precedence in `src/utils/settings/settings.ts`.
- **Agent/tool/MCP taxonomy** (`app/sidecar/agentConfigDomain.ts`,
  `app/renderer/src/agentConfigState.ts`, `AgentsPage.tsx`, `agentIdentity.ts`): fixtures from real
  `AgentDefinitionsResult` cases (`src/tools/AgentTool/loadAgentsDir.ts`) — built-ins,
  user/project/local, overrides, MCP-required; worker role/status vocabulary vs `src/agent-mode/`
  + `src/tools/AgentTool/UI.tsx`.
- **Goals** (`app/sidecar/goalDomain.ts`, `goalMemoryState.ts`, `GoalsPage.tsx`): compile-time
  shape checks vs the engine goal type (`src/utils/threadGoal.ts`) + fixtures for every
  status/progress/budget display case.
- **Memory** (`app/sidecar/memoryDomain.ts`, `MemoryPage.tsx`): fixtures for every memory type +
  instruction-file metadata from the engine scanners (`src/utils/claudemd.ts`,
  `src/services/SessionMemory/sessionMemoryUtils.ts`).
- **Permissions display** (`app/renderer/src/PermissionPrompt.tsx`): one fixture per
  `PermissionUpdate` variant (`src/utils/permissions/PermissionUpdate.ts`) with a tripwire so a
  NEW variant fails visibly (P2-0 exhaustiveness pattern).
- **Tool-input summaries** (`app/renderer/src/ToolInspector.tsx`): fixtures from representative
  real built-in tool inputs (`src/Tool.ts` shapes).
- **Protocol mirrored unions** (`app/shared/protocol.ts`): type-level parity checks for the
  mirrored snapshot vocabulary (settings/agents/goals/memory) against engine definitions — follow
  the existing `engine-types.snapshot.d.ts` discipline in `app/shared/`; additive only, NO wire
  change, no version bump.
- **Host transcript-path codec** (`app/host/registry.ts`): parity tests vs engine transcript
  layout (`src/utils/sessionStorage.ts`, `sessionStoragePortable.ts`): normal paths, long-path
  hash fallback, Unicode normalization, `CLAUDE_CONFIG_DIR`.

Import discipline: sidecar-side families may import `src/` directly (sidecar tsconfig).
Renderer/shared/host families stay engine-free at RUNTIME — type-only imports / generated
fixtures per the snapshot discipline, never a runtime engine import outside the sidecar.

=== GROUND RULES ===
Locked decisions + security baseline untouched (test-only; no new inbound vocabulary). Known-red
sidecar tsc baseline: zero NEW owned diagnostics is the bar. Prefer `_forTest` helpers; fixtures
colocated per CLAUDE.md §7 conventions.

=== DELIVERABLE / DONE WHEN ===
Headless ONLY (no GUI): `bun test app/` green with the new families; renderer tsc clean; sidecar
wrapper no new owned diagnostics. Each family demonstrably FAILS on drift — prove one per family
by temporarily perturbing the mirrored value/union and restoring (P2-0 tripwire discipline).
Report back: per-family fixture location + the engine anchor (`src/…:line`) it syncs against, and
any already-drifted vocabulary the fixtures exposed. No PARITY-LEDGER changes (adds no surface).
```
─── PASTE ───

## P4-23 · ⬜ — Remove the ✦ "Session started" transcript banner (prototype port, unwanted)

Operator ruled (2026-07-09, during the P4 GUI-acceptance pass) that the `✦ Session started`
card is unwanted — a straight port of the prototype's session-start banner. Delete it. Same
class as P4-22 (remove a prototype-ported artifact per operator), renderer-only.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 2/10

You are running P4-23 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
No dependency, but you MUST NOT regress P3-7's slash-command catalog. Echo the header line above
back to the operator before starting.

=== CONTEXT (you start cold) ===
The transcript renders a `✦ Session started` banner at the top of every session — cwd, model,
tool count, and permission mode. The operator ruled it unwanted (2026-07-09 GUI-acceptance pass):
it was a straight port of the prototype's session-start card, and Claude/ChatGPT show no such
banner. Remove it. This is a REMOVAL, same class as P4-22 (frictionless-restore) — renderer-only,
zero wire/preload/security/engine surface.

Owner files (verify each in source before editing):
- `app/renderer/src/TranscriptView.tsx` — `SessionInitBanner` component (~:352) + the
  `case 'session-init'` render arm (~:117).
- `app/renderer/src/transcriptProjector.ts` — `SessionInitRow` type (~:197), its membership in the
  `TranscriptRow` closed union (~:234), and the row it emits from `case 'init'` (~:714-730).

=== ⚠ THE ONE TRAP — do NOT drop catalog capture ===
The `init` frame does DOUBLE DUTY: besides the visible banner row, it captures the P3-7
slash-command catalog (`slash_commands` → `selectSlashCommands`, same `case 'init'`). The
`case 'init'` must STILL run and STILL capture the catalog — you are deleting only the visible
`session-init` ROW it pushes, not the frame handler. If you delete the whole `case 'init'`, the
slash picker silently goes empty (a P3-7 regression that headless tests for the banner won't
catch). Prove the catalog survives with a test.

=== BUILD ===
- Delete `SessionInitBanner` and its `case 'session-init'` arm in `TranscriptView.tsx`.
- Stop emitting the `session-init` row in the projector's `case 'init'`; keep the catalog capture.
- Remove `SessionInitRow` from the `TranscriptRow` union and its type decl. Because the union is a
  closed exhaustiveness-tripwire union (CLAUDE.md §7), removing a member means fixing BOTH switch
  `default: never` arms (projector + TranscriptView) AND `app/renderer/src/sdkMessageFixtures.ts`
  so `bunx tsc -p app/tsconfig.json` stays clean — verify by confirming no `never`-assignment error.
- Drop/adjust the banner assertions in `TranscriptView.test.tsx` and `transcriptProjector.test.ts`.
- ADD a projector test: an `init` frame now yields NO `session-init` row BUT `selectSlashCommands`
  still returns the frame's catalog (proves P3-7 intact).
- Re-tag the session-init banner rows in `docs/migration/PARITY-LEDGER.md` from their current
  disposition to ✂️ CUT (operator, 2026-07-09) — mirror how P4-22 re-tagged `ResumeStates.jsx`.

=== GROUND RULES ===
Locked decisions + security baseline untouched (renderer-only; no inbound/outbound frame change,
no preload change). Known-red sidecar tsc baseline: zero NEW owned diagnostics. No new deps.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (banner tests removed, new catalog-survives test passing) · `bunx tsc
--noEmit -p app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar` no new owned · `bun
run --cwd app test:hardening` 19/19 · `bun run --cwd app renderer:build` clean. Report: the exact
lines deleted per file, the catalog-survives test location, the PARITY-LEDGER rows re-tagged, and
a one-line confirmation that `case 'init'` still captures `slash_commands`. Kill any sidecar you
spawn (`ps -axo pid,command | grep sidecar/index.ts` count unchanged). Update this session's
STATUS row (⬜→✅ + date + note) as the last step.
```
─── PASTE ───

## TRANCHE F — P4-REVIEW gate-blocker fixes (generated 2026-07-12)

The whole-phase pre-gate review (`reviews/2026-07-12-phase4-review.md`) found the Phase-4 gate NOT
met: 2 confirmed code blockers + a parity-ledger that can't serve as the gate instrument until
corrected. These three sessions clear the must-fix list. (Should-fix items B3/M1/B6 are riders on
P4-18 / P4-8b, not standalone sessions — see their STATUS rows.) After all three land + the pending
GUI acceptances, RE-RUN P4-REVIEW to certify the gate.

## P4-25 · ⬜ — Trust-gate fail-closed fix (P4-REVIEW B1, security blocker)

Read `reviews/2026-07-12-phase4-review.md` finding B1 + `decisions/SECURITY-MINIMUM.md` (T8) + the
P4-15 STATUS row (the original trust fix this bug reopens) before editing.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 4/10

You are running P4-25 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting. This is a SECURITY fix — the
security baseline is a hard gate; run the hardening suite.

=== CONTEXT (you start cold) ===
The whole-phase review (`docs/migration/reviews/2026-07-12-phase4-review.md`, finding B1),
independently reproduced by its security sweep and re-verified at source, found the workspace-trust
gate FAILS OPEN. The gate exists so no renderer path can run a turn (tools + HOOKS) at an untrusted
cwd (T8; hooks do NOT self-gate on the non-interactive sidecar path — the `handleSubmit` block is
what makes trust real). The hole, verified at source:
- Consumer `app/sidecar/sidecarServer.ts:734`: `if (this.workspaceTrust?.getSnapshot()?.trusted === false)`
  — blocks ONLY on an explicit `false`. A `null` snapshot yields `undefined === false` = false → the
  gate is skipped → the turn runs at an unvetted cwd.
- Producer `app/sidecar/workspaceTrustDomain.ts:152-163` (`readWorkspaceTrustSnapshotOnce`): computes
  `trusted = executor.isTrusted()` then `await getGithubRepo()` under ONE try/catch, and `return null`
  on ANY throw. `getGithubRepo()` (`src/utils/git.ts:504`) has no try/catch and throws on a git-spawn
  failure; `isPathTrusted → getGlobalConfig` can throw on a corrupt `~/.cat-code`. So a purely COSMETIC
  repo-detection failure discards an already-computed (possibly `false`) trust fact into `null`.
- Double failure: `sendWorkspaceTrustSnapshot` also skips on a null read, so NO trust prompt is shown
  either — silent untrusted execution. A single corrupt config or transient git failure disarms trust
  for EVERY session. `sessionController.ts:410` `await`s the domain but it can't rethrow (read swallowed),
  so a real session gets a live domain whose `getSnapshot()` is `null`.
Verify all three anchors in source before changing anything; source wins.

=== BUILD ===
- **Producer (root cause):** never return a bare `null` when the trust fact is knowable. Compute
  `trusted` in its OWN try (default `false` on throw — fail closed) and `detectedRepo` in a SEPARATE
  try (default `null` on throw — cosmetic). Return `{ trusted, detectedRepo }` always. A `getGithubRepo()`
  failure must NOT null out `trusted`. (This alone also fixes the missing-prompt: a non-null snapshot
  emits normally, so the renderer shows the trust dialog on a read failure.)
- **Consumer (defense-in-depth):** invert `handleSubmit`'s gate to fail closed — when
  `this.workspaceTrust` is present, require `getSnapshot()?.trusted === true` to proceed; a `null`/
  absent snapshot ⇒ deny with the SAME typed `unauthorized` error. KEEP the domain-absent (probe) path
  permissive — i.e. gate only when `this.workspaceTrust` exists and its snapshot is not explicitly
  trusted. Do not block the P1-0 startup self-probe (`index.ts` submit is not renderer-reachable, but
  keep the domain-absent path open).
- **Test the exact hole (the review's "missing test"):** add `handleSubmit` boundary tests in
  `app/sidecar/sidecarServer.test.ts` — a `null` snapshot rejects with `unauthorized` + runs NO turn;
  an explicit `{trusted:false}` rejects; `{trusted:true}` proceeds. Use `fakeWorkspaceTrust(null)`
  (the existing helper's null case is only display-tested today). Prove it's a real tripwire: the null
  test must FAIL against the pre-fix consumer and PASS after.

=== GROUND RULES ===
Security baseline is a hard gate. No new inbound/outbound vocabulary, no preload change (this is a
fix to existing seams). Locked decisions untouched. Known-red sidecar tsc: zero NEW owned diagnostics.
Re-verify every `src/…:line` and `app/…:line` anchor; source wins.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green incl. the new boundary tests (null-denies tripwire proven) · `bunx tsc --noEmit
-p app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar` no new owned · `bun run --cwd app
test:hardening` 19/19. Headless-verifiable — no 🖐 GUI gate (optional operator smoke: open a session
in an untrusted cwd whose git is broken → the trust prompt still appears and a turn is blocked until
accepted). Report: the exact producer + consumer change (file:line), the new tests, and a one-line
confirmation that a null/failed snapshot now DENIES + emits a prompt. Kill any sidecar you spawn.
Update this session's STATUS row (⬜→✅ + date + note) AND the P4-REVIEW row (mark B1 resolved) as
the last step.
```
─── PASTE ───

## P4-26 · ⬜ — Sessions-nav reachability fix + REAL P4-6a re-acceptance (P4-REVIEW B2)

Read `reviews/2026-07-12-phase4-review.md` finding B2 first. The fix is one line; the value is the
HONEST GUI re-acceptance (the prior "✅ GUI-VERIFIED 2026-07-10" claim is not reproducible from
committed source).

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 2/10 · 🖐 GUI

You are running P4-26 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
The whole-phase review (`docs/migration/reviews/2026-07-12-phase4-review.md`, finding B2), git-traced
by its integration sweep and re-verified at source, found the Sessions page (P4-6a) is UNREACHABLE by
any committed UI affordance:
- `app/renderer/src/Sidebar.tsx:51` — the NAV item is `{ id:'sessions', enabled:true }`, so it renders
  as a normal CLICKABLE button.
- But BOTH onClick guards — `NavItemExpanded` (`:463`) and `NavItemRail` (`:515`) — wrap
  `onSelectView(item.id)` in `if (item.id === 'chat' || 'orchestrator' || 'goals' || 'accounts' ||
  'settings')`, OMITTING `'sessions'`. Clicking Sessions never fires the callback → `activeView` never
  becomes `'sessions'` → the `SessionsPage` mount (`App.tsx:1378`) never runs. No other path reaches
  `activeView='sessions'` (the ⌘K palette has no view-switch; every static `setActiveView` is `'chat'`).
- Git history: `'sessions'` was in the guard at NO commit (f6101d3 P4-6a / 3e34ccf + 5f34fe4 P4-8a) —
  it NEVER worked from committed source, so STATUS's P4-6a "✅ GUI-VERIFIED 2026-07-10 — 69 sessions"
  is not reproducible (verified against an uncommitted patch, or overstated).
Verify the anchors in source before editing; source wins.

=== BUILD ===
- **Fix (robust):** the per-id allowlist is now a DEAD guard — every NAV item is `enabled:true` and
  `App.tsx` already forwards `onSelectView` faithfully (`:1298-1303`). DELETE the `if (item.id === …)`
  guard in BOTH `NavItemExpanded` and `NavItemRail` and call `onSelectView(item.id)` directly (the
  `!item.enabled` early-return already handles disabled items). This won't recur when the next nav
  destination is added. (If you prefer minimal, add `'sessions'` to both — but the delete is better.)
- **Regression test that would have caught this:** add a Sidebar test asserting that for each ENABLED
  NAV item, activating its rendered button routes `onSelectView` to that id. NOTE the repo has no
  jsdom/testing-library (documented constraint) — if a true click test isn't possible, assert the
  structural fact that no per-id allowlist gates `onSelectView` (the guard is gone) and flag the
  coverage limit honestly. Do not claim a live-click test you didn't run.
- **Fix the stale comment** `Sidebar.tsx:46-47` ("All five are built" — there are six NAV items and one
  was inert).

=== GROUND RULES ===
Renderer-only; ZERO wire/preload/security/engine surface. Locked decisions untouched. Known-red sidecar
tsc: zero NEW owned diagnostics. No new deps.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green incl. the new nav-routing test (fails before the guard fix, passes
after) · renderer tsc clean · `bun run --cwd app test:hardening` 19/19 · `renderer:build` clean.
GUI (operator's — STOP, print exact steps per `process/GUI-VERIFICATION.md`, wait; NO automation):
click Sessions in BOTH the collapsed rail AND the expanded sidebar → the Sessions catalog page mounts
and shows real sessions / search / sort / workspace grouping. Then correct the STATUS P4-6a row to the
honest result (note the prior claim was not reproducible from committed source). Report: the exact
guard change, the test + its coverage limit, and the GUI re-acceptance result. Update this session's
STATUS row + the P4-6a row + the P4-REVIEW row (mark B2 resolved) as the last step.
```
─── PASTE ───

## P4-27 · ⬜ — Parity-ledger correction + re-measure (P4-REVIEW B4/B5/M3)

Read `reviews/2026-07-12-phase4-review.md` findings B4/B5/M3 + the P2 STATUS-overclaim pattern. This
makes the ledger + STATUS honest so the gate metric is real. Docs-only (+ optional consistency check).
This is the parity slice of the paused STATUS-truthfulness audit — coordinate, don't fork it.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 3/10

You are running P4-27 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
The whole-phase review found `docs/migration/PARITY-LEDGER.md` cannot serve as the Phase-4 gate
instrument until corrected (`reviews/2026-07-12-phase4-review.md`, B4/B5/M3):
- **B4 §28 ResumeStates:** ~26 rows still tagged ✅ built / 🔁 adapted citing `app/renderer/src/
  ResumeDialog.tsx:*` / `resumeDialogState.ts:*` — files DELETED by P4-22 (commit 407dafd; `rg
  ResumeDialog app/` = 0 hits). Both P4-22's STATUS row and P4-23's prompt asserted the re-tag; it
  never happened. Dead file:line citations count a removed feature as built.
- **B5 Part D rollup stale in BOTH directions:** the per-surface table + Totals (~:2409-2463) were last
  hand-computed at ledger landing (36% @ 2026-07-07) and never re-derived, though ~10 sessions since
  flipped their DETAIL rows. THREE inconsistent "built" totals coexist: detail rows 595, per-surface
  rollup 370, Totals row 312. The phase gate reads Part D, so it currently reads ~25 points too low.
- **M3 §5/§6 ❓:** ~41 rows still tagged ❓ missing-no-owner although P4-18 owns §5/§6 (the residuals
  are legit dep-gated deferrals — remark-gfm / syntax-highlighter / word-diff). Part C requires ❓
  empty-or-waived, so this would block the gate on a technicality.

=== BUILD (docs) ===
- **§28 + FLOW-7 resume rows → ✂️ cut.** Delete the dead `ResumeDialog.tsx:line` citations; mirror how
  P4-23 re-tagged its own removal (`PARITY-LEDGER.md:372`). Cross-ref P4-22 (407dafd).
- **Re-derive Part D from the DETAIL rows** across all 30 surfaces + 8 flows — every rollup row = the
  sum of its detail rows; reconcile the 595/370/312 split to ONE number. Publish the realized-parity
  number (built+adapted ÷ in-scope) as the gate metric of record. The review's recompute put it ≈62%
  (CI 60–65%) — verify or correct from the detail rows yourself.
- **Reclassify §5/§6 owned ❓ → ⬜ deferred (owner P4-18).**
- **Correct the overclaimed STATUS notes the review named** (do NOT rewrite other content in those
  rows): STATUS.md P4-8 `:271` — "deriveTaskAgentState … now reachable" is FALSE (that arm is dead; the
  reachable path is the duplicate `orchestratorState.ts` `orchestratorWorkerState`); reword to the truth
  and note the wire-or-delete is P4-8b/rider scope. STATUS.md P4-6a `:269` — the "GUI-VERIFIED
  2026-07-10" claim is not reproducible; correct it ONLY once P4-26 has landed a real re-acceptance,
  else mark it "pending re-verification (P4-26)".
- **Optional (recommended):** a small Part-D consistency check (a test or script that sums the detail
  rows and compares to the rollup) so this can't silently rot again — there is no generator today.

=== GROUND RULES ===
Docs-only (+ optional test). `git diff --check` clean; every cited path must exist; canonical files
(PARITY-LEDGER, STATUS) updated IN PLACE, never forked. No silent parity edits — every disposition
change is traceable to a review finding or a source fact. Coordinate with the STATUS-truthfulness audit.

=== DELIVERABLE / DONE WHEN ===
The corrected ledger (§28 cut, Part D re-derived + the single realized-parity number, §5/§6
reclassified) + the corrected STATUS notes. Report: the before/after parity number, the three "built"
totals reconciled to one, and the list of STATUS notes corrected (file:line each). Update this
session's STATUS row + the P4-REVIEW row (B4/B5/M3 resolved) as the last step.
```
─── PASTE ───

---

# TRANCHE G — the ORPHANED-row backfill (generated 2026-07-26)

The 2026-07-26 nine-range parity re-audit (commit `60abc0f`) found **82 rows** whose owner session
**ran, finished, never covered the row, and never §0-flagged it** — tagged `⬜ deferred — ORPHANED`.
A ⬜ requires a *named* owner; a spent owner is no owner, so those rows were ❓ wearing a ⬜ tag.
**Operator ruling 2026-07-26: own them, do not waive them** — *"i dont mind working it all. Just
added it as a task in phase4 then."* All 82 were promoted to ❓ and joined the 45 already there:
**Part C is now 127, and these six sessions own every one of them.**

**Realized parity did not move** (79% before and after). ⬜ and ❓ are both in-scope for the
Realized% denominator, so a ⬜→❓ promotion is invisible to the ratio. Part C grew because it became
honest. Nobody should read TRANCHE G as a regression, and no session here should "fix" the number.

## The acceptance bar for every session in this tranche — read this before your prompt

**Operator instruction, verbatim: *"you are underestimate the goal of prototype. What we build
should be rendered exact to prototype."*** Closing a ledger row is a **coverage** measure and
coverage is NOT the goal. A session could flip all 22 of its rows and render nothing like the
prototype — which is the exact failure that created this instrument (the 2026-07-07 Sidebar was ✅
and review-GREEN while having silently dropped 4 chrome items and a whole feature class). So:

- **PROGRAM-PLAN §6 / §8 visual-fidelity acceptance is REQUIRED, not optional, for every session
  below** — all six render UI, so none is exempt. Verbatim (`PROGRAM-PLAN.md:323`): *"The Step-1
  prototype surface is the acceptance bar for how it looks — not merely a data/behavior reference.
  The session's done-criteria MUST include a side-by-side visual check against that prototype
  surface (layout, chrome, spacing, states); a surface is done only when it reads as the prototype,
  not merely when its data is wired. The prototype IS the visual grammar — a session must not invent
  a parallel one."* And (`PROGRAM-PLAN.md:430`): *"Do not instruct a session to establish its own
  visual grammar — that phrasing is what let the Phase-3 shell chrome drift while passing its
  function-only gate."*
- **Invoke the `verifying-cat-code-changes` skill.** Its **FIDELITY** block
  (`.claude/skills/verifying-cat-code-changes/SKILL.md:89`, template `:106`) is *required, not
  optional* for prototype-affecting renderer changes, and the **SURFACE ACCEPTANCE** tiered verdict
  (`:175`) must appear in the final report. Hard rule from that skill: **an open, unapproved
  mismatch stops a fidelity-pass claim** — a §0 `adapted/deferred/cut` self-flag records a
  *proposed* deviation, it does NOT close the mismatch. Only the operator can move an item from
  "Open mismatches" to "Operator-approved deviations".
- **Render-and-diff is buildable — use it.** The prototype runner is
  **`~/catcode_prototype/CatCode Web App.html`** (note: repo root, NOT inside `cat-app/`) — a
  Babel-standalone SPA that loads `cat-app/*.jsx`. Open the real prototype surface beside the real
  app instead of reasoning about fidelity from JSX source. This is the single highest-value thing
  in this tranche; state in your report whether you used it.
- **READ your prototype surface before writing code.** Ledger row text is a *summary*; the
  prototype is the *spec*. Each prompt names its file + line count + the components it must match.
- **Standing constraints are unchanged and this tranche is not a licence against them:** port
  **ZERO** prototype code; **no inline `style={{}}`** (tokens + the Tailwind idiom, and beware the
  dynamic-class trap — interpolated arbitrary values like `` text-[${hex}] `` silently no-op; use a
  static map); the prototype's **mock fixture data is never the contract** — real engine shapes win
  and a dropped mock field is ✂️/🔁 **with a flag**, never ❓. Prototype parity is the **DEFAULT**;
  a deviation is a §0 flag (adapted/deferred/cut + reason) raised as a **PROPOSAL to the operator**,
  never a silent drop and never a call the session makes alone.

Everything in **Standing rules** at the top of this file still applies (Step-0 INVENTORY row, the
domain recipe, the security baseline, the GUI protocol, kill-what-you-spawn, `bun test app/` +
both tscs + `test:hardening`).

## Dependency / ordering

```
P4-30 (SAModal + dialog layer) ─▶ P4-29 (its bulk-bar Export + row actions reuse the dialogs)
P4-32 (decision FIRST, then 32a/32b) ─▶ P4-33 (§6 orchestrator rows share P4-32's chrome seam)
P4-31, P4-34  [standalone — run any time]
```
**Run P4-30 before P4-29** (P4-29's bulk Export and row Branch/Export actions want the dialogs
P4-30 builds; doing it the other way means building the invocation twice). **P4-32 must reach an
operator ruling before P4-33 builds §6's four orchestrator rows** — they render the same chrome.


## P4-30 · ⬜ — Branch/Rewind/Export dialog layer: the `SAModal` family (CC-1 §17, 18 ❓)

Run this **before P4-29**. Read `PARITY-LEDGER.md` §17 (`:1232`-`:1305`) and the P4-6/P4-6b STATUS
rows first — this session exists because a whole dialog layer was dropped with no §0 flag, so the
*first* thing to internalize is that "P4-6b said it wired the actions end-to-end" is not evidence.

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 7/10 · 🖐 GUI

You are running P4-30 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
CC-1 §17 (`docs/migration/PARITY-LEDGER.md:1232-1305`) owns `SessionActions.jsx`: the per-session
actions menu PLUS the Branch / Rewind / Export dialogs it opens. The menu half shipped. **The
entire dialog layer did not, and no §0 flag was ever raised** — it was a silent parity cut, which
is the exact failure mode this ledger exists to catch. Verified in source 2026-07-26:

- `rg -n 'BranchDialog|RewindDialog|ExportDialog|SAModal' app/renderer/src/` → **zero matches.**
  The only `*Dialog` component in the renderer is `TasksDialog.tsx`, unrelated.
- **Branch fires with NO confirmation.** `app/renderer/src/App.tsx:2195-2199` — a menu row click
  goes `MenuRow onAction` (`SessionActionsMenu.tsx:69-72`) → `sendSessionActionVerb(targetId,
  {type:'session.branch', requestId})` → a real fork on disk (`createFork`, see
  `app/shared/protocol.ts:1283-1290`). No intermediate state, no gate. `rg 'confirm|Are you sure'`
  over `app/renderer/src`, `app/preload`, `app/main` finds no confirmation UI anywhere.
- **Export has no Download and no filename — the clipboard is the ONLY sink.** Dispatch at
  `App.tsx:2190-2194`; result handler `App.tsx:1174-1180` does exactly
  `navigator.clipboard.writeText(result.exportText)` + a toast. There is no `showSaveDialog`, no
  `createObjectURL`, no `<a download>`, no renderer-reachable `writeFile`. **Saving a transcript to
  a file is unreachable from the desktop.** A filename is not even expressible: `SessionExportMessage`
  is `{type, requestId}` only (`app/shared/protocol.ts:1317-1321`), same for branch (`:1323-1327`).
- Doc drift to fix in passing: `app/shared/protocol.ts:1282` claims *"the renderer offers a
  download/clipboard."* Only clipboard exists.

Your 18 ❓ rows are every row in §17 whose disposition reads `❓ missing-no-owner — promoted from ⬜
ORPHANED 2026-07-26` — ledger lines `:1239 :1243 :1246 :1258 :1264 :1265 :1266 :1267 :1268 :1269
:1270 :1279 :1282 :1283 :1293 :1295 :1296 :1298`. They are, grouped: the `SA_IC` icon vocabulary,
`sa-pop` entry animation, `SectionLabel`, the copy-flyout hover behavior, the **`SAModal` shell**
(scrim + centered card + click-scrim-close + stopPropagation + header with tinted icon chip +
scrollable body + footer slot + Escape + the `saBtn` primary/danger/disabled variants), the
**BranchDialog** (modal + preview callout + Cancel), and the **ExportDialog** (modal + live content
preview `<pre>` + derived filename + Download button). Re-verify every anchor before building.

=== PROTOTYPE — THIS IS THE ACCEPTANCE BAR, NOT A REFERENCE ===
Operator, verbatim: *"you are underestimate the goal of prototype. What we build should be rendered
exact to prototype."* Closing 18 rows is COVERAGE. The bar is **renders exact to the prototype.**

- **Read `~/catcode_prototype/cat-app/SessionActions.jsx` (389 lines) before you write any code.**
  Ledger row text is a summary; the prototype is the spec. Match: `SA_IC`, `SAModal`, `saBtn`,
  `SectionLabel`, the copy flyout, `BranchDialog`, `RewindDialog`, `ExportDialog`, and the
  `sa-pop` animation. Do not work from the row titles.
- **Run it side-by-side.** The prototype runner is `~/catcode_prototype/CatCode Web App.html`
  (repo root, NOT inside `cat-app/`) — a Babel-standalone SPA that loads `cat-app/*.jsx`. Open the
  real prototype dialogs beside the real app rather than reasoning about fidelity from JSX.
- **Enumerate STATES, not one screenshot.** Per dialog at minimum: closed, open-default,
  open-with-a-long-title (ellipsis/wrap), the disabled/invalid button state, and mid-Escape/
  scrim-click dismissal. A surface can match in one state and be wrong in another — that mount-gate
  class of miss is what "0 High" reviews have repeatedly missed here.
- PROGRAM-PLAN §6 (`:323`) applies in full: a surface is done only when it **reads as** the
  prototype, not when its data is wired; the prototype IS the visual grammar — do not invent a
  parallel one; every intentional divergence is a §0 case-by-case conflict.
- Port **ZERO** prototype code. No inline `style={{}}` — P0-2 tokens + the Tailwind idiom, and
  beware the dynamic-class trap (interpolated arbitrary values silently no-op; use a static map).
  Prototype mock data is never the contract — real engine shapes win.

=== BUILD ===
- **`SAModal` + `saBtn` first** — they are shared primitives; the three dialogs are their consumers.
  Follow the house component idiom, not the prototype's. Escape-to-close and scrim-click-to-close
  are two of your rows; `stopPropagation` on the card is a third — test them, don't eyeball them.
- **BranchDialog** — this is the one that closes a live defect: branch must not fire until the
  operator confirms. The preview callout ("keeps 1–N / drops M after", new name `"title (branch)"`)
  is a derived string; derive it from what actually crosses the wire, and if a field is missing,
  **flag it — do not invent it and do not mock it.**
- **ExportDialog** — live content preview pane + derived filename (slugified title + `.md`/`.json`)
  + a **Download** primary button. Download is a real capability gap, not just chrome: today no
  renderer-reachable file-write path exists. **Adding one is a boundary change — treat it as such.**
  Renderer never authors a path (HC1). If the honest shape is a main-process `showSaveDialog` behind
  an HC3 fixed-sender preload channel, that needs the full security tax (sidecar/main validation,
  boundary test, hardening smoke) and a decision reference — or, if you judge it out of one sitting,
  build the dialog + filename + preview and **§0-flag Download as a proposal to the operator with
  the exact seam you'd add.** Do not silently ship clipboard-only again.
- **RewindDialog** — §17 rows for it are `⬜ owner-flagged`, not yours; build it only if it falls
  out of `SAModal` for free, and say which rows you touched either way.
- **Fix `protocol.ts:1282`'s "download/clipboard" comment** to match whatever ships.

=== GROUND RULES ===
Renderer-first. If you add ANY inbound vocabulary or preload channel it needs sidecar-side
validation + a boundary test + a decision reference (`decisions/SECURITY-MINIMUM.md` T4/T5a/T6/T7,
HC1–HC4) — repo mistake #5 is widening the desktop inbound surface. Locked decisions untouched.
`app/` is strict — keep it that way; known-red sidecar tsc means **zero NEW owned** diagnostics.
No new deps. Branch `migration`, commit your own explicit paths, never `git add -A`.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (report the pass count against the newest ✅ STATUS row — a DROP is
a regression) · `bunx tsc --noEmit -p app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar`
zero new owned · `bun run --cwd app test:hardening` 19/19 · `bun run --cwd app renderer:build` ok.

**Invoke the `verifying-cat-code-changes` skill** and paste BOTH artifacts in your report:
1. the filled **FIDELITY** block (Surfaces touched / States compared / Prototype anchors —
   `SessionActions.jsx:line` per dialog / Comparison artifacts per state / Open mismatches /
   Operator-approved deviations / Live GUI acceptance). **An open, unapproved mismatch stops a
   fidelity-pass claim** — a §0 flag is a proposal, not a closure.
2. the **SURFACE ACCEPTANCE** tiered verdict (Engineering / Security / Fidelity artifact / Live
   fidelity / Overall). Never collapse these into one ✅.

GUI (operator's — STOP and print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use
the P3-H harness, then WAIT; NO cua-driver / claude-in-chrome / any automation): open a session's ⋯
menu → Branch → the confirmation dialog appears and Cancel leaves the transcript untouched → Export
→ preview + filename render and Download writes a real file. Migration test turns use `gpt-5.6-luna`
at low effort on a healthy account — never burn frontier quota on a dev-loop turn.

Ledger: flip your 18 rows in `PARITY-LEDGER.md` §17 from ❓ to ✅/🔁 **directly** (do NOT demote to
⬜ — a spent-owner ⬜ is what created this session) with a real `app/…:line` each, and record any
row you could not close as a §0 proposal naming what it needs. Kill any sidecar you spawn. Update
your STATUS row (⬜→✅/🟡 + date + note) as the last step; `STATUS.md` is multi-writer, so **re-read
it immediately before writing and touch only your own row.**
```
─── PASTE ───

## P4-29 · ⬜ — Sessions-page row actions, rename, tags, bulk bar (CC-1 §16, 22 ❓)

Run **after P4-30**. Read `PARITY-LEDGER.md` §16 (`:1163`-`:1231`) plus the P4-6a / P4-6b / P4-26 /
P4-6a-FIX STATUS rows. The headline is that P4-6b closed as "wired end-to-end" having wired only
TabBar + Sidebar, and left four imports in `SessionsPage.tsx` that nothing uses.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 6/10 · 🖐 GUI

You are running P4-29 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
CC-1 §16 (`docs/migration/PARITY-LEDGER.md:1163-1231`) owns `SessionsPage.jsx` — the cross-workspace
Sessions MANAGER (browse/search/filter/sort, multi-select bulk ops, per-row actions), which is a
different surface from the sidebar switcher. Browse/search/sort shipped. **Every action affordance
did not.** Verified in source 2026-07-26:

- **`app/renderer/src/SessionsPage.tsx:23-30` imports `resolveSessionActions`, `SessionActionKind`,
  `SessionActionsMenu`, `SessionActionsAnchor` and uses NONE of them.** All 594 lines read: those
  four identifiers appear only in the import statement and in a doc-comment at `:7` that says the
  row menu / inline rename / tag popover "are P4-6b". Rows render as a plain
  `<button onClick={() => onOpen(row)}>` (`:415`) with no actions affordance at all.
- **Nothing catches it.** `app/tsconfig.json` has no `noUnusedLocals`/`noUnusedParameters`, and
  `eslint.config.js:54` scopes lint to `src/**` so `app/` is not linted at all. The abandoned
  wiring has been invisible to every gate.
- **`SessionActionsMenu` is rendered in exactly ONE production place** — `App.tsx:2175` — opened by
  `TabBar.tsx:309-322` (active tab ⋯) and `Sidebar.tsx:612-634` (hover kebab). SessionsPage is the
  one surface that imports it and never opens it.
- **Related live defect, and it is yours to judge (see BUILD): the ⋯ menu's "Restore" row does not
  restore.** `app/renderer/src/sessionActions.ts:104` sets `label: openable ? (row.live ? 'Open' :
  'Restore') : 'Open'` with `enabled: openable`, so a non-live row gets an ENABLED row labelled
  "Restore" — but `App.tsx:2183` handles it with `else if (kind === 'open') selectTab(targetId)`,
  and `selectTab` is documented at `App.tsx:1026-1034` as *pure UI focus* that never touches the
  frame stream. Every OTHER open path branches on `live` and routes restorable rows through
  `performRestore` (`App.tsx:1387-1426`): SessionsPage row click `:2341-2342`, Sidebar restore-offer
  `:2133`, command palette `:2004-2005`, WelcomeScreen recent `:2395-2396`, open-from-history
  `:1451-1452`. `App.tsx:2183` is the sole outlier, and it is reachable: the Sidebar kebab shows for
  **any** registry row, live or restorable (`Sidebar.tsx:513`). Clicking "Restore" focuses a stale
  pane.

Your 22 ❓ rows are every §16 row reading `❓ missing-no-owner — promoted from ⬜ ORPHANED
2026-07-26` — ledger lines `:1192 :1194 :1196 :1207 :1208 :1209 :1210 :1211 :1212 :1213 :1214 :1215
:1216 :1217 :1218 :1219 :1220 :1223 :1225 :1226 :1228 :1229`. Grouped: row right-click context menu
at cursor · row checkbox select · inline rename input (autofocus, Enter commit / Escape cancel /
blur commit) · `+ tag` add button · row overflow ⋯ button · the whole **TagPopover** (panel + scrim
with above/below auto-placement and viewport clamp, header incl. the bulk "Tag N sessions" form,
filter/create input, matching-tag list with active check, "Create #tag", empty hint, "Remove tag") ·
the **floating bulk-action bar** (appears at selection > 0, `left:48` offset for the sidebar rail,
"N selected" label, Select-all/Deselect-all toggle, Tag, Export, Clear-selection ×) ·
`SessionActionsMenu` invocation (row ⋯ + right-click, `hide=['metadata']`) · BranchDialog and
ExportDialog invocation · Copy-as-Markdown / Copy-as-text row actions. Re-verify before building.

=== PROTOTYPE — THIS IS THE ACCEPTANCE BAR, NOT A REFERENCE ===
Operator, verbatim: *"you are underestimate the goal of prototype. What we build should be rendered
exact to prototype."* Flipping 22 rows is COVERAGE. The bar is **renders exact to the prototype.**

- **Read `~/catcode_prototype/cat-app/SessionsPage.jsx` (670 lines) before you write any code** —
  especially the TagPopover placement math and the bulk-bar geometry, which are the two things a
  row-title summary cannot convey. Ledger row text is a summary; the prototype is the spec.
- **Run it side-by-side:** `~/catcode_prototype/CatCode Web App.html` (repo root, NOT inside
  `cat-app/`) is a Babel-standalone SPA that loads `cat-app/*.jsx`. Open the prototype Sessions page
  beside the real one. Say in your report whether you did.
- **Enumerate STATES:** zero rows / rows-no-selection / one selected / many selected / select-all ·
  popover placed above vs below vs viewport-clamped · rename mid-edit · a row with no tag vs tagged ·
  hover-only affordances (the ⋯ button and `+ tag` are hover-revealed — **hover/focus-only states are
  operator-driven ALWAYS**, never warp the cursor; mark them PENDING per GUI-VERIFICATION.md).
- PROGRAM-PLAN §6 (`:323`) in full: done only when it **reads as** the prototype; the prototype IS
  the visual grammar — do not invent a parallel one; every divergence is a §0 case-by-case conflict.
- Port **ZERO** prototype code; no inline `style={{}}`; beware the dynamic-class trap. **Prototype
  mock data is never the contract** — this matters unusually much here: if session **tags** have no
  engine backing, tags are NOT a ❓ to satisfy with a mock store. Render truth, §0-flag the
  extend-engine-vs-change-UI trade-off as a PROPOSAL, and do not fake a tag model.

=== BUILD ===
- **Consume the four abandoned imports or delete them** — do not leave `SessionsPage.tsx:23-30`
  half-wired a second time. Wire the ⋯ button and right-click to the existing App-owned
  `SessionActionsMenu` (`App.tsx:2175`) with `hide=['metadata']`, following how `TabBar.tsx:309-322`
  and `Sidebar.tsx:612-634` open it — reuse that path, do not build a second menu (repo mistake #10).
- **The "Restore" bug — your call which session takes it, but SAY which.** It is a one-line class of
  fix at `App.tsx:2183` (branch on `live` and route restorable rows through `performRestore`, like
  every other open path). If you take it, add a test that fails before and passes after. If you
  judge it P4-31's or a CC-row's, state that explicitly in your report — do not leave it unclaimed.
- **Branch/Export invocation** rides P4-30's dialogs. If P4-30 has not landed, STOP and say so
  rather than building a second dialog layer.
- Selection, tags, and rename are renderer state: follow the house `create<X>State` /
  `reduce<X>State` / `select<X>` idiom (`app/renderer/src/agentConfigState.ts` is the template) and
  derive status at read time — never mutate stored rows.

=== GROUND RULES ===
Renderer-first. Any new inbound vocabulary or preload channel needs sidecar validation + a boundary
test + a decision reference (SECURITY-MINIMUM T4/T5a/T6/T7, HC1–HC4). Renderer never authors a cwd
(HC1) and never authors permission rules. Locked decisions untouched. `app/` is strict; sidecar tsc
is known-red — zero NEW owned diagnostics. No new deps. Commit your own explicit paths to `migration`.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (report the count vs the newest ✅ STATUS row) · app tsc clean ·
`typecheck:sidecar` zero new owned · `test:hardening` 19/19 · `renderer:build` ok.

**Invoke the `verifying-cat-code-changes` skill** and paste BOTH the filled **FIDELITY** block
(with `SessionsPage.jsx:line` prototype anchors and per-state comparison artifacts) and the
**SURFACE ACCEPTANCE** tiered verdict. **An open, unapproved mismatch stops a fidelity-pass claim.**

GUI (operator's — STOP, print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use the
P3-H harness, WAIT; NO automation): open Sessions → right-click a row and click its ⋯ → the menu
appears at the cursor → rename inline and press Enter, then a second row and press Escape →
select 2 rows → the bulk bar appears clear of the sidebar rail → Tag opens the popover both above
and below the fold. Migration test turns use `gpt-5.6-luna` at low effort on a healthy account.

Ledger: flip your 22 §16 rows ❓ → ✅/🔁 **directly** (never back to ⬜) with a real `app/…:line`
each; anything you cannot close is a §0 proposal naming what it needs. Kill any sidecar you spawn.
Update your STATUS row last — **re-read `STATUS.md` immediately before writing, touch only your row.**
```
─── PASTE ───

## P4-31 · ⬜ — MetadataInspector residue: drawer chrome + subagent/compaction sections (CC-1 §18, 10 ❓)

Standalone — run any time. Read `PARITY-LEDGER.md` §18 (`:1306`-`:1374`) and the P4-6b STATUS row.
The 17 `owner-flagged` rows in §18 are NOT yours; only the 10 promoted-ORPHANED ones are.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 5/10 · 🖐 GUI

You are running P4-31 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
CC-1 §18 (`docs/migration/PARITY-LEDGER.md:1306-1374`) owns `MetadataInspector.jsx` — the read-only
right drawer exposing raw metadata for a transcript message and its session. The drawer shipped;
ten elements did not, and their owner session (P4-6b) ran without covering or flagging them. They
were tagged `⬜ deferred — ORPHANED` in the 2026-07-26 re-audit and promoted to ❓ on the operator's
ruling *"i dont mind working it all"* — so they are real work, not bookkeeping.

Your 10 ❓ rows are the §18 rows reading `❓ missing-no-owner — promoted from ⬜ ORPHANED
2026-07-26` — ledger lines `:1315 :1316 :1347 :1352 :1353 :1354 :1356 :1357 :1370 :1372`:
- **Drawer chrome:** slide-in animation (toast-in 0.18s ease) `:1315`; Escape-key closes the drawer
  via a window keydown handler `:1316`.
- **Surface row → MIPill** (cli / ide / …) `:1347`.
- **Subagent section** (conditional on `mm.subagent`) `:1352` with its Agent row (agentName ·
  agentType) `:1353`, Agent ID row (mono) `:1354`, Sidechain yes/no `:1356`, Spawned-at (mono) `:1357`.
- **Compaction rows:** Messages-summarized (mono) `:1370`; Preserved-segment (mono, head → tail,
  conditional) `:1372`.
Re-verify each anchor against source before building — anchors drift, and the ledger's own header
warns that a Notes cell may describe a pre-audit state while the Evidence cell is current.
**Evidence wins over Notes.**

**Recon before inventing (repo mistake #1 — three times so far).** Every one of these rows is a
*data* row: it exists only if the field really crosses the wire. Before rendering any of them, find
the real shape in the engine and cite `src/…:line` or `app/shared/protocol.ts:line`. If a field is
not carried (subagent identity, sidechain flag, spawned-at, compaction head/tail), that is a
**read-seam gap**, not a rendering gap: either add it as a read-only outbound snapshot field
following the C3 precedent in `decisions/PERMISSION-BOUNDARY.md`, or §0-flag it as a proposal with
the exact seam you'd add. **Do not mock a field to close a row** — a dropped mock fixture field is
✂️/🔁 with a flag, never a satisfied ❓.

**A defect you may find is yours (coordinate with P4-29 — one of you takes it, and BOTH of you must
say which):** the ⋯ menu's "Restore" row does not restore. `app/renderer/src/sessionActions.ts:104`
labels a non-live row 'Restore' and enables it, but `App.tsx:2183` handles it with `selectTab`
(pure UI focus, documented `App.tsx:1026-1034`) while every other open path routes restorable rows
through `performRestore` (`App.tsx:1387-1426`). Reachable via the Sidebar kebab, which shows for any
registry row (`Sidebar.tsx:513`). If P4-29 has already taken it, skip it and note that.

=== PROTOTYPE — THIS IS THE ACCEPTANCE BAR, NOT A REFERENCE ===
Operator, verbatim: *"you are underestimate the goal of prototype. What we build should be rendered
exact to prototype."* Ten closed rows is COVERAGE. The bar is **renders exact to the prototype.**

- **Read `~/catcode_prototype/cat-app/MetadataInspector.jsx` (191 lines) before writing code** —
  it is short, so there is no excuse for working from row titles. Match the section grammar
  (uppercase labels, mono value rows, `MIPill`), the drawer's slide-in, and the conditional
  sections' empty behavior.
- **Run it side-by-side:** `~/catcode_prototype/CatCode Web App.html` (repo root, NOT inside
  `cat-app/`). Report whether you used it.
- **Enumerate STATES:** drawer closed / opening (the animation is one of your rows — a static
  screenshot cannot prove it) / open on a plain assistant message / open on a **subagent** message
  (the conditional section) / open on a **compacted** session (the compaction rows) / open on a
  message whose optional fields are absent. The conditional sections are precisely the mount-gate
  class of miss: they render in one state and are invisible in the state a reviewer looks at.
- PROGRAM-PLAN §6 (`:323`) in full: done only when it **reads as** the prototype; the prototype IS
  the visual grammar — do not invent a parallel one; every divergence is a §0 conflict flag.
- Port **ZERO** prototype code; no inline `style={{}}`; beware the dynamic-class trap; prototype
  mock data is never the contract.

=== BUILD ===
- Escape-to-close is a **window** keydown handler — mind the interaction with other Escape consumers
  (permission prompts, pickers, dialogs). Test the precedence, don't assume it.
- Display degrades gracefully (house rule): an unknown or absent metadata variant renders a tolerant
  fallback row and **never throws**. Runtime-narrow unknown shapes; **zero `as` casts** in
  projector-style code. Inbound stays fail-closed.
- Reuse existing projection/selectors rather than adding a parallel derivation (repo mistake #10) —
  search `app/renderer/src/transcriptProjector.ts` and the relevant map first.

=== GROUND RULES ===
Read-only drawer: prefer **no** new inbound vocabulary. If a read seam must grow, it is an outbound
read-only snapshot field with `secretGuard` on the outbound frame, plus a boundary test — cite
`decisions/PERMISSION-BOUNDARY.md` C3 and `decisions/SECURITY-MINIMUM.md`. Locked decisions
untouched. `app/` strict; sidecar tsc known-red — zero NEW owned diagnostics. No new deps.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (count vs the newest ✅ STATUS row) · app tsc clean ·
`typecheck:sidecar` zero new owned · `test:hardening` 19/19 · `renderer:build` ok.

**Invoke the `verifying-cat-code-changes` skill**; paste the filled **FIDELITY** block (prototype
anchors as `MetadataInspector.jsx:line`, one comparison artifact per state above, incl. the subagent
and compaction states) and the **SURFACE ACCEPTANCE** tiered verdict. **An open, unapproved mismatch
stops a fidelity-pass claim** — a §0 flag is a proposal, not a closure.

GUI (operator's — STOP, print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use the
P3-H harness, WAIT; NO automation): open the inspector on a message from a subagent run → the
Subagent section renders agent name/type/id/sidechain/spawned-at → press Escape → the drawer closes.
Migration test turns use `gpt-5.6-luna` at low effort on a healthy account.

Ledger: flip your 10 §18 rows ❓ → ✅/🔁 **directly** (never back to ⬜) with a real `app/…:line`
each; a row you cannot close is a §0 proposal naming the missing seam. Kill any sidecar you spawn.
Update your STATUS row last — **re-read `STATUS.md` immediately before writing, touch only your row.**
```
─── PASTE ───

## P4-32 · ⬜ — Orchestrator in-session chrome: **DECISION FIRST**, then split 32a/32b (CC-1 §20 + §13 + FLOW-5, 52 ❓)

**This is the important one, and it is not a build session yet.** Read, in order:
`PARITY-LEDGER.md` §20 (`:1431`-`:1505`), §13 (`:956`-`:1021`), FLOW-5 (`:2182`-`:2209`);
`decisions/AGENT-MODE-TOGGLE.md` (P4-8b's ruling — the per-session toggle already ships);
`decisions/AGENT-CHROME.md` (D2); `reviews/2026-07-13-ui-drift/orchestrator.md`; and the P4-8/P4-8b
STATUS rows. **A previous build of this surface was created and then deleted by the operator
(`f626b5d`, 2026-07-14) — rebuilding it under a different name without a ruling would repeat that
exactly.** Hence: the first deliverable is a decision doc, and the session STOPS for approval.

─── PASTE ───
```
🧠 Model: CLAUDE (system-architecture) · Difficulty: 7/10 · 🖐 GUI

You are running P4-32 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

**YOUR FIRST DELIVERABLE IS A DECISION DOC, NOT CODE. You will STOP and wait for operator approval
before implementing anything.** Read the whole prompt before doing anything at all.

=== CONTEXT (you start cold) — and the correction that defines this session ===
On 2026-07-14 the operator said *"we dont have 'orchestrator' page. remove it"*, and
`OrchestratorPage.tsx` (383 lines), `OrchestratorRoster.tsx` (136), `WorkerFocusView.tsx` (154) and
`LeaseRoster.tsx` (118) were deleted in `f626b5d`. On 2026-07-26 they clarified what that ruling
meant: **they removed the icon/page, which was OUR invention. The prototype has no orchestrator nav
destination at all.** That is confirmed by the prototype itself.

`~/catcode_prototype/cat-app/OrchestratorMode.jsx:1-15`, verbatim:
> "Orchestrator Mode is NOT a separate product — it's a mode of a normal Cat Code session. When it's
> on, the assistant (the orchestrator on this same thread) delegates to workers via the Agent tool.
> Those workers surface as INLINE Agent-tool cards in the ordinary transcript, and an on-demand
> /tasks panel lists them. The user only ever talks to the orchestrator here — never to a worker
> directly."
> "note — we never surface a worker's output/conclusion here — the main agent narrates the outcome
> in its own message"

**So do NOT frame this as "re-home the page into a per-session mode view." There is no view.** It is
**in-session chrome hung off the ordinary chat surface**, delivered three ways: (a) inline
Agent-tool cards in the transcript, (b) an on-demand /tasks panel, (c) small chrome — a roster strip
above the composer, a title-adjacent mode badge, a footer task pill, and worker detail / focus
drilldowns. **Two of the three already ship here**, which is why your row count is smaller than it
looks. Recon done 2026-07-26 (re-verify everything; source wins):

**ALREADY SERVED — do not rebuild:**
- Inline `AgentToolCard` `app/renderer/src/TranscriptView.tsx:1072` and `DelegateGroup` `:1126`
  (dispatch `:961`/`:370`; grouping `transcriptProjector.ts:477`). P4-8c; survived `f626b5d`.
- `WDot`/`LifeDot` → `AgentPip` (`AgentChrome.tsx:63`); `WStatusText` → `AgentStateLabel` (`:121`).
- Footer pill **slot** → `TasksStrip` (defined `App.tsx:2453`, rendered `:2420`). CC-5 rule #10
  already says do not add a second pill there. What is unserved is the *semantics*
  (`orchestratorPill`'s amber "N needs you"), not the slot.
- `OrchestratorDemoSwitch`, `ODEMO_STATES`, `MOCK_CODEX_LEASES`, `w.progress`, `w.files`,
  `w.up|down|cost|account` are ✂️ **cut** in the ledger. Do not resurrect them.

**PARTIAL:**
- `/tasks` panel → `TasksDialog.tsx:30` serves the *tasks* plane, not a worker roster: no role
  grouping, no handle/agentType display (the field is carried at `tasksState.ts:133` and never
  rendered), no drilldown, no Leases tab — and `tasksDomain.ts:67` **excludes the foregrounded
  `local_agent`**, so it is structurally not a worker roster.
- `deriveWorker` / `workerStateKey` / `summarizeWorkers` / `workerEventPriority` exist in
  `app/renderer/src/orchestratorState.ts` but are **TEST-ONLY**. Only `reduceOrchestratorState` and
  `selectAgentModeSnapshot` have production importers (`App.tsx:235-237`, used at `:1737`/`:2391`
  purely to read `.active`). Test-only exports: `orchestratorWorkerState` (:77),
  `deriveWorkerOwner` (:101), `summarizeOrchestratorWorkers` (:124), `orchestratorPill` (:154),
  `workerEventPriority` (:175), `selectPromotedWorker` (:188), `displayHandle` (:203),
  `selectWorkerById` (:215). The whole two-axis model is dead code with a green test file.
- `Baton` is **built but unreachable**: `AgentChrome.tsx:142` renders correctly, and its sole caller
  hard-codes `owner="none"` (`TranscriptView.tsx:1102`), so it never renders in production.
- `AgentTypeChip` (`AgentChrome.tsx:98`) and `AgentHandle` (`:112`) have **no production importer at
  all** — these are two of your §13 rows.

**GENUINELY MISSING:** `OrchestratorModeWorkerRoster` (the block above the composer),
`OrchestratorBadge` (title-adjacent pill), `TasksButton` (top-bar with running/blocked counts),
`WorkerDetail`, worker focus mode (`WorkerFocusView`), `LeaseRoster`/`LEASE_STATE`/
`leaseAccountRollup`/`LeaseRow`, and the `WMeta`/`WLabel`/`WBtn` primitives.
Name greps under `app/` all return **0**: `OrchestratorBadge` · `OrchestratorIcon` ·
`WorkerFocusView` · `LeaseRoster` · `OrchestratorPage` · `OrchestratorRoster` · `TasksButton` ·
`bgTaskPill` · `BackgroundTaskStatus`. The Sidebar nav (`Sidebar.tsx:92-96`) has
chat/sessions/goals/accounts/settings — **no orchestrator destination, and none is wanted.**

**What crosses the wire today** — `AgentModeWorkerItem`, `app/shared/protocol.ts:959`: `agentId` ·
`handle` · `role` · `status` · `description` · `synthesisStatus?` · `origin?` · `resumable?` ·
`handoffStatus?` · `blockReason?` · `verdict?` · `isBackgrounded?` · `outputSummary?`; wrapper
`AgentModeSnapshot` (`:991`): `active` · `objective` · `phase` · `workers[]`. **`blockReason`,
`verdict`, `outputSummary`, `handle`, `isBackgrounded`, `objective`, `phase` have ZERO production
readers** — most of what `WorkerDetail` needs is already on the wire and simply unread. The
`agent-mode.set` verb (`protocol.ts:1032`, ruling in `decisions/AGENT-MODE-TOGGLE.md`) ships:
`App.tsx:1835` `onToggleOrchestrator` → `SessionPane` (`:3006`) → `TranscriptView` (`:3005`).

**An extra gap worth a ruling of its own:** that toggle and the `active` reflect are reachable
**only when the transcript is EMPTY** (`TranscriptView.tsx:206` → `WelcomeScreen.tsx:139`
`OrchestratorReflect`). In a session that has messages there is currently **no way to see or change
orchestrator mode** — which directly contradicts the prototype's "it's a mode of a normal session"
premise. Include this in your proposal.

**Where in-session chrome would hang** (all inside `SessionPane`, props `App.tsx:2504`, render `:2967`):
- **Above the composer:** the docked column `App.tsx:3062`
  (`mx-auto flex w-full max-w-[740px] shrink-0 flex-col gap-4`), which today stacks
  `AskQuestionFlow` (`:3068`), `PermissionQueue` (`:3078`), the pastes strip, then the composer
  `<form>` (`:3155`). That is the roster-strip slot.
- **Session title:** there is deliberately **no chat header row** — `App.tsx:2969-2973` says so
  explicitly ("the session title lives in the TabBar"). The title renders at `TabBar.tsx:289`. A
  title-adjacent badge therefore has to go in the TabBar tab row, **or** a new header must be
  introduced — that is a design decision, not a placement, and it belongs in your proposal.
- **Footer:** the floating `TasksStrip` (`App.tsx:2420`/`:2453`) and the chip strip under the
  composer, `ComposerActionsBar` (`App.tsx:3252`).

Your 52 ❓ rows: §20's 40 (ledger `:1441`-`:1493`), §13's 6 (`:964 :994 :997 :998 :1002 :1009`), and
FLOW-5's 6 (`:2195 :2196 :2197 :2201 :2202 :2203`).

=== PHASE 1 — THE DECISION DOC (your only deliverable before you stop) ===
Write `docs/migration/decisions/ORCHESTRATOR-IN-SESSION.md` proposing the target shape. It must:

1. **Restate the premise in the prototype's own words** and state plainly that there is no page and
   none is proposed. Anchor to `OrchestratorMode.jsx:1-15`.
2. **Read the prototype surface first-hand and inventory it** — `~/catcode_prototype/cat-app/
   OrchestratorMode.jsx` is **903 lines**. Cover at minimum: `WDot` (:36), `WStatusText` (:43),
   `WMeta` (:53), `WLabel` (:90), `WBtn` (:93), `OWNER` (:125), `deriveWorker` (:131),
   `workerStateKey` (:161), `summarizeWorkers` (:171), `LifeDot` (:187), `Baton` (:194),
   `workerEventPriority` (:216), `CountTail` (:224), **`OrchestratorModeWorkerRoster` (:237 — its
   own comment says "block above PromptInput"; single-worker row :251, multi-worker whisper line
   :275-367, hover popover :302-335, `compact` while generating)**, `bgTaskPill` (:376),
   `BackgroundTaskStatus` (:385), `OrchestratorBadge` (:410), `TasksButton` (:420),
   `WorkerDetail` (:436), `WorkerFocusView` (:491), `AgentToolCard` (:562), `DelegateGroup` (:581),
   the lease family (:598-711), `TasksPanel` (:713). `ODEMO_*` (:827-901) is demo scaffolding whose
   own header says delete on migration.
3. **Per prototype piece, give a verdict: already-served (cite `app/…:line`) · partially-served
   (name exactly what is missing) · genuinely-missing (propose where it hangs) · cut (cite the
   ruling).** Where a row is already served, **flag it for a follow-up ledger pass — do NOT silently
   re-tag it yourself.** Several §20 rows may prove to be honest ✅/🔁; say which and let the
   operator decide.
4. **Answer the four placement questions explicitly**, each with a recommendation and its cost:
   (a) the roster strip above the composer — into the `App.tsx:3062` docked column?
   (b) the mode badge — into the TabBar tab row, or introduce a chat header (and what that costs)?
   (c) the footer pill — **`TasksStrip` already owns that slot (CC-5 rule #10)**; is the answer to
   extend `TasksStrip`'s semantics with the amber "N needs you" case rather than add a pill?
   (d) worker detail / focus — a drilldown inside `TasksDialog`, a main-column swap, or neither?
   Note that the prototype's own header says a worker's output is never surfaced in the main thread,
   which constrains (d) more than the row titles suggest.
5. **Rule on the dead two-axis model:** wire `orchestratorState.ts`'s eight test-only exports into
   the chrome, or delete them. A green test file over dead code is not a third option.
6. **Rule on the unreachable `Baton`** (`TranscriptView.tsx:1102` hard-codes `owner="none"`) and on
   the empty-transcript-only mode toggle.
7. **Rule on leases.** `rg -i lease app/renderer app/sidecar app/shared/protocol.ts` finds **no**
   lease vocabulary, frame or UI, and the prior LeaseRoster had degraded into the P4-5 account pool.
   Building it means a new read seam. Recommend build-with-seam, fold-into-Accounts, or cut — and
   say which, with the cost.
8. **Propose the 32a/32b split** along component seams (NOT by row count), per the P4-18a/b/c
   precedent, with a `🧠 Model/Difficulty` tag suggestion for each half. Say which ledger rows each
   half owns.
9. **Name every row you propose to CUT or WAIVE, with its reason.** A waive is an operator decision;
   propose it, never take it.

**THEN STOP.** Print the proposal's summary and the open questions, and WAIT for the operator's
ruling. **Do not write a single line of `app/` code in this phase.** The last build of this surface
was deleted; a second unratified build is the one outcome this session exists to prevent.

=== PHASE 2 — ONLY AFTER OPERATOR APPROVAL ===
Split into 32a/32b as ruled and run them as separate sessions. Each half then carries the full
TRANCHE G acceptance bar below.

=== PROTOTYPE — THE ACCEPTANCE BAR FOR PHASE 2 ===
Operator, verbatim: *"you are underestimate the goal of prototype. What we build should be rendered
exact to prototype."* Closing 52 rows is COVERAGE. The bar is **renders exact to the prototype.**
- Read `~/catcode_prototype/cat-app/OrchestratorMode.jsx` (903 lines) — the inventory above is a
  map, not a substitute. Also `~/catcode_prototype/cat-app/AgentIdentity.jsx` (248 lines) for §13.
- **Run it side-by-side:** `~/catcode_prototype/CatCode Web App.html` (repo root, NOT inside
  `cat-app/`) — a Babel-standalone SPA loading `cat-app/*.jsx`.
- **Enumerate STATES:** orchestrator off · on with zero workers · one worker running · many workers
  with a promoted lead · a **blocked** worker (the amber "you" baton — the prototype's only strong
  case) · orchestrator generating (`compact` roster) · all settled. The roster's hover popover is
  hover-only → **operator-driven ALWAYS**, never warp the cursor; mark it PENDING.
- PROGRAM-PLAN §6 (`:323`) in full; the prototype IS the visual grammar — do not invent a parallel
  one. Port **ZERO** prototype code; no inline `style={{}}`; beware the dynamic-class trap (a
  per-worker interpolated color silently no-ops — use a static map, the `AGENT_DOT_CLASS` idiom).
  **Prototype mock data is never the contract** — `WMeta`'s elapsed/tools/tokens/cost/account have
  no wire fields and are ledger-✂️/❓; render truth and flag, never mock.

=== GROUND RULES ===
**Locked decisions — if your shape seems to need transport / N-process / raw-event-fidelity /
die-with-window / two-id changes, STOP and report instead (repo mistake #6).** Any new inbound verb
carries the full security tax: sidecar-local schema, boundary test accepting valid AND rejecting
invalid, doc-comment citing its decision, `test:hardening` green (T4/T5a/T6/T6b/T7, HC1–HC4).
Prefer read-only outbound snapshot fields (C3, `decisions/PERMISSION-BOUNDARY.md`) with
`secretGuard`. **Reuse the engine's real machinery — do not duplicate it in `app/` (mistake #10);**
construct anything the engine also builds from the SAME source the engine runtime uses and cite that
`src/…:line`. `app/` strict; sidecar tsc known-red — zero NEW owned diagnostics. No new deps.

=== DELIVERABLE / DONE WHEN (PHASE 1) ===
`docs/migration/decisions/ORCHESTRATOR-IN-SESSION.md` exists with all nine sections above, every
claim citing `app/…:line` / `src/…:line` / a prototype `OrchestratorMode.jsx:line`; the proposed
32a/32b split with tags; the already-served rows flagged for a follow-up ledger pass; and the
explicit STOP. Docs-only: `git diff --check` clean, `bun run maps:lint` passes (8 pre-existing
warnings on `docs/maps/*` are expected). **Do not flip any ledger row in Phase 1** — the rows close
when 32a/32b build, not when the shape is agreed. Update your STATUS row to 🟡 with "decision doc
delivered, awaiting operator ruling" — **re-read `STATUS.md` immediately before writing and touch
only your own row.** No GUI step in Phase 1; the 🖐 GUI tag is for Phase 2.
```
─── PASTE ───

## P4-33 · ⬜ — Composer rail + transcript + shell residue (CC-1 §6 · §12 · §5 · §1 · §2 · §4, 12 ❓)

Depends on **P4-32 reaching an operator ruling** — four of its twelve rows are the same orchestrator
chrome P4-32 is deciding the shape of. Read `PARITY-LEDGER.md` §6 (`:441`-`:528`), §12 (`:862`-`:955`),
§5, §1, §2, §4, plus the P4-0 / P4-24 / P4-11 STATUS rows. Two of these rows were dropped by **both**
of their owner sessions with no flag; that pattern is the point of the session.

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 6/10 · 🖐 GUI

You are running P4-33 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
Twelve elements across six prototype surfaces were tagged `⬜ deferred — ORPHANED` in the 2026-07-26
re-audit — their owner sessions ran, never covered them, never §0-flagged them — and were promoted
to ❓ on the operator ruling *"i dont mind working it all. Just added it as a task in phase4 then."*
Your rows, by ledger line:

**§6 Chat.jsx (7)** — `:450` `OrchestratorBadge` in header · `:451` transcript-mode 'Hidden' reveal
toggle (eye icon, only when meta rows exist) · `:452` meta-row dimmed rendering when revealed
(opacity 0.55) · `:461` focus-mode header (back-to-orchestrator, "Viewing @worker", AgentHandle,
TypeChip, "Esc to return") · `:462` `WorkerFocusView` · `:494` `onCommandRoute` (`/agents`→Settings
etc. map to app surfaces) · `:519` `OrchestratorModeWorkerRoster` strip above composer.
**⚠ `:450`, `:461`, `:462`, `:519` are the same chrome P4-32 is deciding.** Do NOT build them until
P4-32's decision doc is approved; build them to that ruling, or defer them to 32a/32b and say so.

**§12 Surfaces.jsx (1)** — `:928` **`TokenWarning`**, the amber auto-compact glyph + popover.
Verified 2026-07-26: prototype `Surfaces.jsx:415` defines it, `:779` renders it in the composer rail
between `<Sep/>` and `<ContextChip/>`. It renders **nothing** until `tokens > threshold - 20_000`
(`:422-424`; `AUTOCOMPACT_BUFFER_TOKENS = 13000` `:413`, `WARNING_THRESHOLD_BUFFER_TOKENS = 20000`
`:414`, both source-cited to `autoCompact.ts:69`); above it, a 22×22 amber `#fbbf24` warning-triangle
button with a `tokenWarnIn` animation, title `${pctLeft}% until auto-compact` (or `Context low ·
${pctLeft}% remaining` when auto-compact is off), click-opening a 252px popover (`:443-461`). `rg -c
'TokenWarning' app/` → **0**; `rg -i 'auto-compact|autocompact|until auto' app/renderer/src` → **0**.
The prototype rail has TWO elements; the app built only the chip: `ContextGauge.tsx:28` (16×16 donut
+ `NN%`, tone at `:20-27`), fed by `contextUsage.ts:52` `selectContextUsage`, mounted
`ComposerActionsBar.tsx:684` ← `App.tsx:2786`. **Both composer owners (P4-0 2026-07-09; P4-24/24c
2026-07-12/13) shipped without it and neither flagged it.** It is **not blocked on a seam** —
`contextUsage.ts` already carries used/window; only the auto-compact threshold needs mirroring from
the engine. Mirror it from the engine's real constant and cite `src/…:line`; do not hard-code a
number you invented (repo mistake #1).

**§5 Messages.jsx (1)** — `:372` UserBubble hover-reveal copy chip.
**§1 AppV2.jsx (1)** — `:181` `workersBySession` derivation (orchestrator-adjacent; coordinate with P4-32).
**§2 Sidebar.jsx (1)** — `:246` menu-active keeps the sidebar pinned open + backdrop-close re-collapse guard.
**§4 WorkspaceLayout.jsx (1)** — `:348` compact ChatView layout when split (`compact: panels>1`).

**Also in scope, and it is a real hole rather than chrome: plan-mode ENTRY.** Verified 2026-07-26:
`rg -c 'EnterPlanMode' app/` → **0 files**, while `ExitPlanMode` has 14 hits — the exit half is fully
built and the entry half is entirely absent, so this is not a naming miss. Engine side exists:
`src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:36` (transition at `:75-93`), name constant
`constants.ts:1`, TUI render `UI.tsx:12`, registered `src/constants/tools.ts:5`, and it is
`shouldDefer: true` (`EnterPlanModeTool.ts:57`) — i.e. it raises an approval request the GUI must
render. App side: `PlanPanel.tsx:13` states real "plan" = a pending **ExitPlanMode**, so entry is out
of scope *by construction*; `permissionState.ts:235` hard-codes `EXIT_PLAN_MODE_TOOL_NAME` with no
`ENTER_` counterpart. The only way into plan mode today is the permission-mode chip
(`PermissionModeChip.tsx:58,94` → `App.tsx:3267` → `:1863`/`:1940` `setPermissionMode`). Program truth
already admits this — `PARITY-LEDGER.md:586` "Plan-enter card ('Enter plan mode?', Yes/No,
planEnterDesc) … ⬜ deferred — owner-flagged", quoting `STATUS.md:284`: *"plan-mode ENTRY is
undiscoverable (only the buried ▸ Permissions toggle; the 'Enter plan mode?' card is deferred)"*.
**P4-11 is closed and no successor owns it.** That row is `owner-flagged`, so it is not one of your
12 — but you are the right session to close it or to give it a named owner. Do one; do not leave it.

=== PROTOTYPE — THIS IS THE ACCEPTANCE BAR, NOT A REFERENCE ===
Operator, verbatim: *"you are underestimate the goal of prototype. What we build should be rendered
exact to prototype."* Twelve closed rows is COVERAGE. The bar is **renders exact to the prototype.**
- **Read the prototype surfaces before writing code:** `Chat.jsx` (1485 lines — the composer rail and
  header), `Surfaces.jsx` (1263 — `TokenWarning` at `:415`, rail composition at `:779`),
  `Messages.jsx` (2175 — UserBubble), `AppV2.jsx` (624), `Sidebar.jsx` (338),
  `WorkspaceLayout.jsx` (288). Row titles are summaries; the prototype is the spec.
- **Run it side-by-side:** `~/catcode_prototype/CatCode Web App.html` (repo root, NOT inside
  `cat-app/`). The composer rail is exactly the kind of dense chrome where reading JSX misleads and
  a live diff does not. Say in your report whether you used it.
- **Enumerate STATES.** `TokenWarning` is invisible below threshold — a "looks fine" screenshot of a
  fresh session proves nothing. Compare at minimum: below threshold (absent) · above threshold
  (glyph present) · popover open · auto-compact ON vs OFF (different copy). Sidebar: menu open vs
  closed vs backdrop-dismissed. WorkspaceLayout: 1 panel vs 2 vs 3. UserBubble copy chip is
  **hover-only → operator-driven ALWAYS**, never warp the cursor; mark it PENDING.
- PROGRAM-PLAN §6 (`:323`) in full: done only when it **reads as** the prototype; the prototype IS
  the visual grammar — do not invent a parallel one; every divergence is a §0 case-by-case conflict.
- Port **ZERO** prototype code; no inline `style={{}}` (the amber `#fbbf24` goes through a token or a
  static class map — an interpolated arbitrary value silently no-ops); prototype mock data is never
  the contract.

=== BUILD ===
- **Sequence:** do §12/§5/§2/§4 and plan-entry first (independent), and hold §6's four orchestrator
  rows until P4-32 is ruled. If P4-32 has not landed its decision when you reach them, **defer those
  four to 32a/32b and say so in your report** — do not guess the shape.
- `TokenWarning` extends the existing rail; extend `ComposerActionsBar`/`contextUsage`, do not fork a
  parallel context derivation (repo mistake #10). Derive the threshold from the engine's constant.
- Status/derived state is computed at **read time**, never stored. House idiom for renderer state:
  `create<X>State` / `reduce<X>State` / `select<X>`.
- Display degrades gracefully; runtime-narrow unknown shapes; **zero `as` casts** in projector-style
  code. If you touch `SDKMessage` handling, extend BOTH the projector switch and
  `app/renderer/src/sdkMessageFixtures.ts` and prove both exhaustiveness tripwires still fire by
  deliberately removing a case and seeing the error, then restoring byte-identical.

=== GROUND RULES ===
Renderer-first. Any new inbound vocabulary or preload channel needs sidecar validation + boundary
test + decision reference (SECURITY-MINIMUM T4/T5a/T6/T7, HC1–HC4). Plan-entry touches the
permission plane — T5a (responses match an engine-minted request id) and T6 (renderer `updatedInput`
is echo-only) are hard constraints; the renderer never authors permission rules. Locked decisions
untouched. `app/` strict; sidecar tsc known-red — zero NEW owned diagnostics. No new deps.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (count vs the newest ✅ STATUS row — a DROP is a regression) · app
tsc clean · `typecheck:sidecar` zero new owned · `test:hardening` 19/19 · `renderer:build` ok.

**Invoke the `verifying-cat-code-changes` skill**; paste the filled **FIDELITY** block (prototype
anchors per surface, one comparison artifact per state above — including the below-threshold and
above-threshold `TokenWarning` pair) and the **SURFACE ACCEPTANCE** tiered verdict. **An open,
unapproved mismatch stops a fidelity-pass claim** — a §0 flag is a proposal, not a closure.

GUI (operator's — STOP, print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use the
P3-H harness, WAIT; NO automation): drive a session near the auto-compact threshold → the amber glyph
appears in the composer rail and its popover reads the remaining percentage · split the workspace to
2 panels → ChatView goes compact · open a sidebar row menu → the sidebar stays pinned open and a
backdrop click re-collapses it. Migration test turns use `gpt-5.6-luna` at low effort on a healthy
account — never burn frontier quota on a dev-loop turn.

Ledger: flip your 12 rows ❓ → ✅/🔁 **directly** (never back to ⬜) with a real `app/…:line` each;
state the disposition you gave the plan-entry row (`PARITY-LEDGER.md:586`) and its owner if you did
not close it. Kill any sidecar you spawn. Update your STATUS row last — **re-read `STATUS.md`
immediately before writing and touch only your own row.**
```
─── PASTE ───

## P4-34 · ⬜ — Scattered danger-list sweep (CC-1 §8 · §9 · §11 · §23 · §7 · §29, 13 ❓)

Standalone — run any time. Read `PARITY-LEDGER.md` §8 (`:597`-`:643`), §9 (`:644`-`:710`), §11,
§23, §7, §29, plus the P4-19 / P4-12 / P4-15 / P4-17 STATUS rows. Thirteen rows across six surfaces
means **six separate fidelity comparisons**, not one — budget for that.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 6/10 · 🖐 GUI

You are running P4-34 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== CONTEXT (you start cold) ===
Thirteen ❓ rows scattered across six prototype surfaces: three were already on the danger list, ten
were promoted from `⬜ deferred — ORPHANED` on 2026-07-26 (owner ran, never covered, never flagged)
per the operator ruling *"i dont mind working it all. Just added it as a task in phase4 then."*

**§8 PermissionRules.jsx (3 — the original danger list)** — ledger `:611` match-type label per rule
row (exact/prefix/wildcard) · `:627` managed-rules-only enforcement toggle (disabled, policy-managed)
· `:635` permission-classifier toggle. All three are **real engine capabilities dropped from the
read-only rules viewer**, and none is on the C3 wire type: `PermissionContextSnapshot`
(`app/shared/protocol.ts:556-563`) is mode + `alwaysAllow/Deny/AskRules: Record<string,string[]>` +
`additionalWorkingDirectories` + `isBypassPermissionsModeAvailable` — no match-type field.
`PermissionRulesEditor.tsx:123` renders a whole row as `{rule} <span>({source})</span>`, nothing
more. `rg -c "classifier" docs/migration/STATUS.md` → **0**: the word appears nowhere in program
truth, so no session has ever owned or waived it. **Trap flagged by the auditors — do not fall in:**
`protocol.ts:645` `managed: boolean` is P4-19's PER-SETTING managed/locked flag, a *different*
concept; it is not evidence for `:613`.

**§9 CommandPalette.jsx (3)** — `:665` 'Recent' commands section (label + rows) · `:666` its divider
rule · `:704` `PAGE_NAV` routing (slash command → navigate to a page). For recents:
`rg -n "Recent|recent|RECENT" app/renderer/src/CommandPalette.tsx app/renderer/src/commandPaletteModel.ts`
→ 0 hits; `buildPaletteItems` (`commandPaletteModel.ts:69-166`) emits exactly two groups, `'Actions'`
and `'Sessions'`; `CommandPalette.tsx:146-151` renders a `GroupHeader` per `item.group`. There is no
recents store, no owner, no cut ruling. **P4-17's derived recents are WORKSPACES on the welcome
launcher (`selectRecentWorkspaces`), not palette commands — do not conflate them.**

**§11 Settings.jsx (3)** — `:812` Model ▸ Default-model select · `:822` Theme ▸ OutputPreview live
code canvas · `:823` Theme ▸ Accent-colour swatch picker. **P4-19's STATUS row claims a batch landed
these and its own caveat admits the coverage was never audited** (*"I merged it, did not audit each
editor"*); the in-source `DeferredEditorsNote`s in `SettingsShell.tsx` still declare default-model
and accent/code-theme deferred. Verify against source, not against the STATUS note — and if the
STATUS claim is wrong, correct that row too (say so in your report).

**§23 MemoryPage.jsx (2)** — `:1672` "Agent memory" section (per-agent memory dirs, "N agent(s)") ·
`:1673` per-agent rows (`AgentTypeChip` + dir + "N file(s)", plain-text fallback). Note
`AgentTypeChip` (`AgentChrome.tsx:98`) currently has **no production importer** — this is one of the
two places that would give it one (P4-32 owns the other); coordinate rather than duplicating.

**§7 Permissions.jsx (1)** — `:578` worker-relay chrome ("worker" badge + "Relayed from worker X"
subtitle). Orchestrator-adjacent — check P4-32's ruling before inventing the vocabulary.

**§29 Welcome.jsx (1)** — `:1996` `openSignal`: the `/workspace` slash command opens the picker from
the composer.

**Plus one built-but-unreachable component to re-home or delete — verified 2026-07-26.**
`ReauthOAuthProgress` (`app/renderer/src/StartupSurfaces.tsx:493`, imported `App.tsx:249`, rendered
`App.tsx:2261`) is gated on `reauthOAuthView`, derived at `App.tsx:2066-2079` from
`oauthContext === 'reauth'`. `oauthContext` (`App.tsx:489`) has five setters — `:1056`, `:1070`,
`:2092`, `:2103`, `:2117` — and **four of them set `null`**; the only one that can set `'reauth'` is
`beginOAuth` (`App.tsx:1054-1056`), whose **sole `'reauth'` caller is the card's own Retry prop at
`App.tsx:2265`**. The component is gated on a state only its own button can set: **structurally
unreachable.** Its real launcher was the reauth banner deleted by ruling #12 — see the §0 comment at
`App.tsx:2247-2249` and its mirror at `StartupSurfaces.tsx:11-15`, citing `STARTUP-GATES.md`.
`rg 'reauthBannerState' app/` → 0. **Re-home it (give it a real launcher) or delete it — flip a coin
is not an option; state which and why.** Fingerprint of the orphaning to fix either way:
`App.tsx:1048` still describes `beginOAuth` as *"the reauth banner's 'Re-authenticate' action"*,
naming a deleted caller.

**Two stale doc references to fix in passing (both verified):** the §0 comments at `App.tsx:2247-2249`
and `StartupSurfaces.tsx:11-15` cite `decisions/STARTUP-GATES.md`, a repo-root-relative path that
does not resolve — the file is `docs/migration/decisions/STARTUP-GATES.md`. And
`docs/migration/reviews/2026-07-14-fidelity-workflow-forensics.md:56` still cites
`reauthBannerState.ts:101` as live evidence for a module that no longer exists.

=== PROTOTYPE — THIS IS THE ACCEPTANCE BAR, NOT A REFERENCE ===
Operator, verbatim: *"you are underestimate the goal of prototype. What we build should be rendered
exact to prototype."* Thirteen closed rows is COVERAGE. The bar is **renders exact to the prototype.**
- **Read each prototype surface before touching its rows:** `PermissionRules.jsx` (318 lines),
  `CommandPalette.jsx` (275), `Settings.jsx` (758), `MemoryPage.jsx` (215), `Permissions.jsx` (601),
  `Welcome.jsx` (522). Six surfaces = **six fidelity comparisons**; do not collapse them into one.
- **Run them side-by-side:** `~/catcode_prototype/CatCode Web App.html` (repo root, NOT inside
  `cat-app/`) — a Babel-standalone SPA loading `cat-app/*.jsx`.
- **Enumerate STATES per surface:** palette with recents vs empty-recents (the divider is a row —
  it only exists when there is something to divide) · rules viewer with each match type present ·
  a managed/policy-locked rule vs an unmanaged one (the toggle is *disabled* in that state — a
  screenshot of the enabled state proves nothing) · Settings Theme with the preview canvas live and
  a swatch selected · MemoryPage with zero agents / one / many, plus the plain-text fallback.
- PROGRAM-PLAN §6 (`:323`) in full: done only when it **reads as** the prototype; the prototype IS
  the visual grammar — do not invent a parallel one; every divergence is a §0 case-by-case conflict.
- Port **ZERO** prototype code; no inline `style={{}}`; beware the dynamic-class trap (the accent
  swatch picker is exactly where an interpolated colour class silently no-ops — use a static map).
  Prototype mock data is never the contract — real engine shapes win.

=== BUILD ===
- **The §8 rows need a read seam, not just a renderer change.** Match-type, managed-enforcement and
  the classifier toggle are engine facts that do not cross the wire. Add them as **read-only outbound
  snapshot fields** on the existing `permission.context` frame (the C3 precedent,
  `decisions/PERMISSION-BOUNDARY.md`) — additive only, `secretGuard` on the outbound frame, and a
  boundary test. **The renderer never authors permission rules (T6b) and never sees raw credentials.**
  If a fact genuinely has no engine source, §0-flag it as a proposal; do not mock it.
- `PermissionRulesEditor` currently ships read-only behind Settings → Permissions (CC-5 #6). Keep it
  read-only; these three rows are *display* of engine truth, not authoring.
- Palette recents need a store that does not exist. Decide honestly: derive from something real, or
  §0-flag as an operator proposal. **Do not invent a persistence layer for a cosmetic list.**
- `openSignal` and `PAGE_NAV` are routing wiring — reuse the existing command/route plumbing rather
  than adding a second dispatcher (repo mistake #10).

=== GROUND RULES ===
Any new outbound field is additive to `app/shared/protocol.ts` (version bump ONLY on a breaking shape
change) with a doc-comment citing its decision. Any new INBOUND frame kind needs a sidecar-local
schema + a boundary test that accepts valid and rejects invalid + `test:hardening` green — repo
mistake #5. Directional limits are never swapped (`MAX_FRAME_BYTES` inbound vs
`MAX_OUTBOUND_FRAME_BYTES` outbound). Locked decisions untouched. `app/` strict; sidecar tsc
known-red — zero NEW owned diagnostics. No new deps. Commit your own explicit paths to `migration`.

=== DELIVERABLE / DONE WHEN ===
Headless: `bun test app/` green (count vs the newest ✅ STATUS row) · app tsc clean ·
`typecheck:sidecar` zero new owned · `test:hardening` 19/19 (mandatory — you may touch the
permission plane) · `renderer:build` ok.

**Invoke the `verifying-cat-code-changes` skill**; paste the filled **FIDELITY** block with **a
separate States-compared list per surface** (six surfaces, six sets of artifacts) and the **SURFACE
ACCEPTANCE** tiered verdict. **An open, unapproved mismatch stops a fidelity-pass claim** — a §0
flag is a proposal, not a closure.

GUI (operator's — STOP, print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use the
P3-H harness, WAIT; NO automation): Settings → Permissions shows a match-type label per rule and a
disabled managed toggle where policy applies · ⌘K shows a Recent section with its divider (or,
if flagged, does not and the flag is in the report) · Settings → Theme renders the live preview and
the accent swatch applies · `/workspace` in the composer opens the picker. Migration test turns use
`gpt-5.6-luna` at low effort on a healthy account.

Ledger: flip your 13 rows ❓ → ✅/🔁 **directly** (never back to ⬜) with a real `app/…:line` each;
record the `ReauthOAuthProgress` decision (re-homed with its launcher, or deleted) and the two stale
doc refs fixed. Kill any sidecar you spawn. Update your STATUS row last — **re-read `STATUS.md`
immediately before writing and touch only your own row.**
```
─── PASTE ───

---

# TRANCHE H — the UX-gap audit's startable wave (generated 2026-07-31)

Source: `docs/migration/reviews/2026-07-31-app-ux-gap-audit.md` (rev 6) and its companion
`docs/migration/reviews/2026-07-31-app-ux-gap-prototype-coverage.md` (rev 3). The audit ranks by
hypothesized user pain rather than prototype fidelity, so it surfaced work the ledger classes as
low-priority deferrals or, in four cases, does not see at all.

**Seven sessions, six findings.** Finding 6 splits in two: its inline half and its inspector half
are different surfaces with different costs, and bundling them risks the cheap half being degraded
when the expensive half runs long.

| Session | Finding | What it is |
|---|---|---|
| **P4-35** | 24a | `starting` renders as a red failure in `ConnectionRecovery` |
| **P4-36** | 6 (inline half) | Read/Write output truncates silently; no reveal band |
| **P4-37** | 6 (inspector half) | The full-output inspector cannot be copied or searched |
| **P4-38** | 7 | Assistant messages have no copy affordance |
| **P4-39** | 19 | Session actions menu has no bottom-flip |
| **P4-40** | 20 | Welcome recents are inert for terminal-only projects |
| **P4-41** | 15 | No reset-to-default for any editable engine setting |

## The rule that governs every session in this tranche

**The audit's defects are reliable. Its proposed fixes are not.** Six adversarial review rounds
withdrew or corrected **seven** of the "Improvement" lines — including two that were wrong in the
dangerous direction — while almost no defect was withdrawn. Findings 5a, 7, 10, 11, 12, 19, and 20
all shipped a fix recommendation that a later round retracted.

So each dispatched prompt below carries the finding's **evidence** and forbids it from carrying the
finding's **conclusion** as settled. Every session must:

1. **Re-verify every anchor in current source before building.** The tree is shared and moves.
2. **Name, in its report, the contract or call path the fix satisfies** — the existing function,
   type, or invariant that makes the change correct. One line. "The audit said so" is not a
   justification, and neither is "the prototype does it": the prototype's mock data is never the
   contract (finding 5a's retention enum is the standing example of a prototype design that would
   have deleted legitimate values).
3. **Report a deviation as a §0 proposal**, never a silent narrowing, per the standing rules above.

## Disposition reconciliation (read before questioning a session's scope)

The coverage document's bucket table classes **6, 7, 15, 19, 20** as bucket **A** (port now) and
**24a** as bucket **C** (no prototype design). Its headline "only 5 are startable today" counts
bucket A alone. **24a is startable regardless**: the same document's bucket-C row for it reads
"Question: none for the one-line guard, which is unambiguous", and the audit lists it in
Highest-confidence work as source-verified, self-contained, and reversing no ruling. Bucket C means
"invent the design", not "blocked" — and 24a needs no design. The tone-grammar question that *does*
need design is **24b**, which is a separate item and needs an operator ruling.

## Parked — recorded so they do not become invisible

Neither group is a session. Both are listed here because the audit's own findings for them are
source-verified and would otherwise be lost between an audit doc and nobody's backlog.

**Seam-blocked — a boundary/seam owner is needed before any renderer work (3):**

| # | What is blocked | The missing seam |
|---|---|---|
| 9 | Interrupting renders as a `UserBubble` the user never wrote | Engine-authored provenance on the interrupt carrier. `createUserInterruptionMessage` (`src/utils/messages.ts:557-572`) calls plain `createUserMessage` and sets no synthetic/meta flag, so the literal lands as an ordinary `user-text` row. String-matching the engine's literal in the renderer is forbidden (repo mistake #10), so this is a protocol question. **Note:** ledger §05's claim that the carrier is "suppressed at the projector via `isSynthetic`" is false; do not size the work from it. **Finding 11's `↑`-history seed is coupled to this** — an unfiltered `user-text` seed would import `[Request interrupted by user]` into recall as though typed. |
| 10a | No file completion in `@` mentions | A cross-plane file-list read seam. `composerState.ts:60-70` records that the engine's `@`-file index is not on the wire; `MentionPicker` is already source-agnostic, so the renderer half is not the gap. Needs a host/sidecar owner + boundary review. |
| 16a | Goals is a read-only page for a writable engine object | No inbound goal-mutation verb exists. All 25 §22 rows are Part C ❓ with owner **UNASSIGNED** and P4-10 is spent. The prototype has a full design (`GoalsPage.jsx:63,110-115,226-260`: per-row Resume/Pause/Replace/Clear + a Create dialog), so this is the largest un-owned cluster in the ledger: design-complete, wire-blocked. |

The **open-the-file** capability belongs in this group too (three pages list files the user cannot
reach). Both prototype actions are stubs, and `SECURITY-MINIMUM.md` HC1 forbids the renderer
authoring a filesystem path, so it needs a host-API verb taking a registry-resolved identifier.
Building it from the prototype alone yields either another dead button or an unsafe IPC.

**~~Awaiting an operator ruling~~ — ALL FIVE RESOLVED 2026-07-31, and every one is now a TRANCHE I
session. Nothing in this register awaits a ruling.** The table is kept because the *bounds* each
resolution carries are what a session must respect; it is no longer a parking lot.

| # | The ask | Resolution (2026-07-31) | Owner |
|---|---|---|---|
| 2a | App-level trust and OAuth gate before any session exists | **RULED — fix discoverability only.** `STARTUP-GATES.md` §1.2 clarification: §1.1 stands, trust stays per-session-create, account writes stay session-scoped, no host-plane account-write path is authorized, and moving the `user` settings scope to a host-plane read is explicitly NOT ruled in. (Finding **2b**, the session-free *user-settings* read, remains a separate bucket-C design question with no owner.) | **P4-48** |
| 24b | A connection tone grammar to replace the four-state one | **RULED — minimal two-tone, no chip.** Transient reads neutral or warn, terminal reads danger; no dot, no chip, no restored `ConnectionChip.tsx`. CC-5 #6 is not reopened: the deleted component stays deleted. | **P4-49** |
| 26d | An SSH connect mode behind the Remote rail's description | **NOT A RULING QUESTION — mis-filed.** Aligning the rail's copy with a cut feature does not reopen the cut; `decisions/PAIRED-DEVICES.md` §1-§3 stands as written. The one-line copy fix was always actionable, and this register wrongly parked it. | **P4-47** |
| O1 | Sidebar per-row session state for the closed-session case | **RULED — live-only dot, no text.** A single small unlabeled dot on live rows, absent otherwise; no chip, no status word, no per-state colour vocabulary. The minimum exception to the 2026-07-20 bare-row ruling. | **P4-44** |
| O2a | A blocking reauth gate | **RULED — pinned, dismissable, non-blocking `BannerStack` above the transcript, account health ONLY.** `STARTUP-GATES.md` #12 is unchanged rather than reversed: never blocks submit, always dismissable, no re-auth wall semantics, does not resurrect `ReauthWall.tsx` / `reauthBannerState.ts`. Shell lifecycle errors (finding 8) stay a separate surface. **O2b** remains a bucket-C design question. | **P4-50** |

> **Why this correction exists.** As written before 2026-07-31 this register told a reader that five
> available items were blocked on the operator. Four had been ruled on the same day and the fifth was
> never a ruling question at all. A parked register that has gone stale costs more than no register:
> the next session reads it and walks past work that is ready.

## Known ledger drift — note it, do not fix it here

`PARITY-LEDGER.md` has four rows that overstate what shipped, plus a headline count that disagrees
with its own Part D totals; both are recorded at the end of the coverage document. Two further rows
were found while scoping this tranche and are recorded here for the same reason:

- **§12 `:912`** ("ConnectionChip: hidden when healthy", ✅ built) cites the very guard that omits
  `starting`, and its `App.tsx:3483-3489` anchor has drifted to `:4024`.
- **§05 `:387`** (inline truncation reveal band) defers head+tail windowing, progressive reveal and
  the capped-bytes footer together as needing "projector byte metadata". Only the byte footer needs
  it. **A P4-36 that reads this row and stops would build nothing.**

Reconciling the ledger is not part of any session below. Each session updates only the rows it
actually changed.

## Dependency / ordering

```
P4-36 (inline reveal band) ─▶ P4-37 (its note points at the inspector this session makes usable)
P4-41 boundary half ────────▶ P4-41 renderer half   [same session, sequenced — see its entry]
P4-35, P4-38, P4-39, P4-40  [standalone — run any time]
```
Everything in **Standing rules** at the top of this file still applies.


## P4-35 · ⬜ — A benign transient renders as a red failure (`ConnectionRecovery` guard, audit 24a)

The smallest session in the tranche, and the work is the derivation rather than the edit. `starting`
is not a spawn-lifecycle state: it is produced by an **error frame**, and something else already
classifies it as transient. Say which, or the fix is a guess that happens to look right.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 2/10

You are running P4-35 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== THE AUDIT PROPOSES; YOU DERIVE ===
This session comes from a UX audit (`docs/migration/reviews/2026-07-31-app-ux-gap-audit.md`,
finding 24a) whose "what is missing" findings survived six adversarial review rounds, and whose
proposed FIXES did not: seven were withdrawn or corrected, two of them wrong in the dangerous
direction. Treat the evidence below as reliable and the suggested fix as an untested hypothesis.
Re-verify every anchor in current source before you touch anything (the tree is shared and moves).
**Your report MUST name, in one line, the contract or call path your fix satisfies** — the existing
function, type, or invariant that makes it correct. "The audit said so" is not a justification.

=== THE DEFECT (source-verified 2026-07-31, re-verify) ===
`ConnectionRecovery` (`app/renderer/src/App.tsx:4016`) returns null for exactly three conditions:

    if (!sessionId || connection.status === 'connecting' || connection.status === 'ready')

Everything else renders `<span>Session {connection.status}.</span>` in `text-tone-danger` beside a
Restart button (`:4032-4050`). The status union is `'connecting' | 'starting' | 'ready' | 'dead' |
LifecycleFrame['status']` (`app/renderer/src/connectionState.ts:8-16`, lifecycle statuses
`'disconnected' | 'failed' | 'exited'` at `app/shared/protocol.ts:2050-2054`). So a session that is
merely `starting` gets a red failure bar and an invitation to restart it.

=== WHAT YOU MUST ESTABLISH BEFORE EDITING ===
Do not add a string to a condition and call it done. Answer these in your report, from source:

1. **Who produces `starting`, and what does it mean?** `connectionState.ts:66-85` is the place to
   look. Note what KIND of frame it comes from before you assume it is a spawn state.
2. **Is there an existing classifier that already partitions this union into transient vs terminal?**
   If one exists, your guard should agree with it rather than invent a second, divergent list. Name
   it in your report and state whether your fix aligns or deviates.
3. **Can a session sit in this status indefinitely?** If suppressing the bar can hide a stuck spawn,
   say so and say what bounds it. Silently hiding a real failure is a worse bug than the one you
   are fixing.

=== SCOPE — READ THE FENCE ===
IN: the guard, plus a test in `app/renderer/src/App.test.tsx` (`ConnectionRecovery` is already
rendered directly there at `:1062,:1068`, so this needs no new harness) that fails before your fix
and passes after, covering every member of the status union rather than just the one you added.

OUT, and each for a recorded reason:
- **The raw status word in the copy.** `Session dead.` / `Session exited.` prints an engine
  discriminant at the user (CLAUDE.md §7). Real, and NOT yours: it is audit finding 26c's class.
- **Any connection tone grammar** (dot, pulse, ring, four-state vocabulary). That is audit finding
  **24b**, which reverses CC-5 ruling #6 (`ConnectionChip.tsx` was deleted by that ruling) and is
  **blocked on an operator ruling**. Restoring any part of it here reopens a locked decision.

=== GROUND RULES ===
Renderer-only. No new inbound vocabulary, no preload channel, no protocol change — if you think you
need one, you have left the scope. Security baseline untouched (`decisions/SECURITY-MINIMUM.md`
T4/T5a/T6/T7 + HC1-HC4). `app/` is strict TypeScript; keep it that way. No new deps. Branch
`migration`, commit your own explicit paths, never `git add -A`.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (baseline 2026-07-31: **1994 pass / 0 fail** — a DROP is a regression) ·
`bunx tsc --noEmit -p app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar` zero new
owned · `bun run --cwd app test:hardening` 19/19.

Report: the one-line contract statement (required), the three answers above, commands with actual
outcomes.

Ledger: `PARITY-LEDGER.md` §12 row `:912` claims "ConnectionChip: hidden when healthy ✅ built" and
cites this guard at a stale `App.tsx:3483-3489`. Correct THAT ROW's anchor and its claim to match
what ships. Do not touch any other ledger row and do not touch the Part D totals. Update your
STATUS row last: `STATUS.md` is multi-writer, so **re-read it immediately before writing and touch
only your own row.**
```
─── PASTE ───


## P4-36 · ⬜ — Read and Write output truncates silently (inline reveal band, audit 6 first half)

Read your ledger row `:387` and then read the note above it in this tranche: that row defers three
things together and only one of them is actually blocked. If you build nothing because the row says
deferred, this session has failed.

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 4/10 · 🖐 GUI

You are running P4-36 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== THE AUDIT PROPOSES; YOU DERIVE ===
This session comes from a UX audit (`docs/migration/reviews/2026-07-31-app-ux-gap-audit.md`,
finding 6) whose defect claims survived six adversarial review rounds and whose proposed fixes
often did not. Treat the evidence below as reliable and the suggested fix as an untested
hypothesis. Re-verify every anchor in current source before building. **Your report MUST name, in
one line, the contract or call path your fix satisfies.** "The audit said so" and "the prototype
does it" are both insufficient: the prototype's mock data is never the contract.

=== THE DEFECT (source-verified 2026-07-31, re-verify) ===
`MAX_INLINE_TOOL_LINES = 400` (`app/renderer/src/TranscriptView.tsx:1194`). Four body renderers cap
at it; only two say so.

- `BashBody` (`:1196-1211`) slices and calls `<ToolOverflowNote …/>` at `:1208`. ✅
- `PlainLinesBody` (`:1260-1275`) slices and calls it at `:1272`. ✅
- `NumberedBody` (`:1229-1243`) — the **file-read** body — slices at `:1230` and renders **nothing**.
- `AdditionsBody` (`:1246-1258`) — the **file-write** body — slices at `:1247` and renders nothing.

So a 900-line file read shows 400 lines that simply stop. The last visible line looks like the end
of the file, and nothing cues the user to doubt it. Silent truncation is worse than visible
truncation: the user forms a wrong belief with no signal.

`ToolOverflowNote` (`:1302-1317`) already exists and renders `{N} more {unit}. Open the full-output
inspector to view all`. The escape hatch it points at is real: the projector does not truncate, and
the inspector reads the full `row.result.content` (`app/renderer/src/toolInspectorModel.ts:57`).

=== THE OTHER HALF: THE REVEAL BAND ===
The prototype does more than confess (`~/catcode_prototype/cat-app/Messages.jsx:438-457`): a strip
reading `{N} lines hidden`, then **Show {min(100, remaining)} more** and **Open full output ↗**. Its
window is head+tail (`HEAD0 = 30`, `TAIL = 6`), so the last 6 lines stay visible no matter how long
the output is. The app collapses all of that into one sentence with no progressive reveal and no
tail.

**The composition question is real and is yours to raise, not to silently resolve.** The app's
bodies are a 400-line slice inside a `max-h-[340px] overflow-auto` scroll box; the prototype's band
sits under a head+tail window with no inner scroller. Those are different models. If they cannot be
reconciled to read as the prototype, that is a §0 flag with the trade-off stated (extend-engine vs
change-UI), raised as a PROPOSAL to the operator, never a silent drop.

=== SCOPE — READ THE FENCE ===
IN: the missing note on both bodies; the head+tail window; the progressive reveal; the
`Open full output` route into the inspector.

OUT, with the reason:
- **The `capped at {bytes}` footer.** The projector carries no byte metadata. This is the ONE part
  of ledger row `:387` that is genuinely blocked.
- **Stdout/stderr stream tabs.** The fold does not preserve the split. Belongs with P4-37 if the
  seam ever lands.
- **Inspector copy / search / wrap.** That is **P4-37**, running after this one. Your note points at
  a drawer that is not yet copyable; that is expected and is not your gap to close.

**Ledger warning.** Your row is `PARITY-LEDGER.md` §05 `:387`, which reads "Head+tail windowing +
progressive reveal + capped-bytes need projector byte metadata → §0 deferral". That is **wrong for
two of the three**: head+tail and progressive reveal operate on the content string already in hand.
Only the byte footer needs metadata. Verify this yourself before accepting either reading, and
correct the row to match what ships.

=== PROTOTYPE — THE ACCEPTANCE BAR, NOT A REFERENCE ===
Read `~/catcode_prototype/cat-app/Messages.jsx:255-352,406-457` before writing code. Run it
side-by-side: the runner is `~/catcode_prototype/CatCode Web App.html` (repo root, NOT inside
`cat-app/`). PROGRAM-PLAN §6 applies in full: a surface is done when it READS as the prototype, not
when its data is wired. Port ZERO prototype code. No inline `style={{}}` — P0-2 tokens and the
Tailwind idiom, and beware the dynamic-class trap (interpolated arbitrary values silently no-op).

Enumerate STATES, not one screenshot: under the cap, one line over, far over, a body whose tail is
shorter than TAIL, and an empty result. A surface can match in one state and be wrong in another.

**User-visible text (CLAUDE.md §7):** no em dash anywhere a user can read it, including
`aria-label`s and titles. Check with `rg -n '—' app/renderer/src --glob '!*.test.*'` and confirm
every remaining hit is a code comment.

=== GROUND RULES ===
Renderer-only. No new inbound vocabulary, no preload channel, no protocol change. Security baseline
untouched (T4/T5a/T6/T7 + HC1-HC4). This surface renders untrusted tool output: everything stays a
text node, never `dangerouslySetInnerHTML`. `app/` is strict. No new deps. Branch `migration`,
commit your own explicit paths, never `git add -A`.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (baseline 2026-07-31: **1994 pass / 0 fail**) · `bunx tsc --noEmit -p
app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar` zero new owned ·
`bun run --cwd app test:hardening` 19/19 · `bun run --cwd app renderer:build` ok.

**Invoke the `verifying-cat-code-changes` skill** and paste BOTH artifacts: the filled **FIDELITY**
block (surfaces, states compared, prototype anchors, artifacts per state, open mismatches,
operator-approved deviations) and the **SURFACE ACCEPTANCE** tiered verdict. An open, unapproved
mismatch stops a fidelity-pass claim; a §0 flag is a proposal, not a closure.

GUI (operator's — STOP and print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use
the P3-H harness, then WAIT; NO cua-driver / claude-in-chrome / any automation): have the agent read
a file well over 400 lines and write one, then confirm both cards state what was hidden, the reveal
extends the body, and the tail is still visible. Migration test turns use `gpt-5.6-luna` at low
effort on a healthy account.

Report: the one-line contract statement (required). Ledger: correct §05 `:387` to what actually
ships, including which of its three deferrals was real. Touch no other ledger row and not the Part D
totals. Kill any sidecar you spawn. Update your STATUS row last — re-read `STATUS.md` immediately
before writing and touch only your own row.
```
─── PASTE ───


## P4-37 · ⬜ — The full-output inspector cannot be copied or searched (audit 6 second half)

Run after P4-36. `ToolInspector.tsx` is 137 lines with zero copy, search or wrap: the ledger's
"🔁 adapted (Esc, search+match-step, wrap, copy, capped footer)" tag is one of the four rows the
coverage document recorded as overstating what shipped.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 5/10 · 🖐 GUI

You are running P4-37 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== THE AUDIT PROPOSES; YOU DERIVE ===
This session comes from a UX audit (`docs/migration/reviews/2026-07-31-app-ux-gap-audit.md`,
finding 6) whose defect claims survived six adversarial review rounds and whose proposed fixes
often did not. Treat the evidence below as reliable and the suggested fix as an untested
hypothesis. Re-verify every anchor before building. **Your report MUST name, in one line, the
contract or call path your fix satisfies.**

=== THE DEFECT (source-verified 2026-07-31, re-verify) ===
`app/renderer/src/ToolInspector.tsx` is **137 lines**. It renders Tool / Summary / Status / Input /
Diff / Output sections and nothing else. `rg -n 'copy|search|wrap' app/renderer/src/ToolInspector.tsx`
returns only `whitespace-pre-wrap` CSS classes. This is the drawer that every truncated tool card
tells the user to open (`ToolOverflowNote`, `TranscriptView.tsx:1302-1317`), so it is the app's only
route to a full 900-line output, and it can be neither copied nor searched.

**The data is not the constraint.** `describeToolForInspector` takes `output` straight from
`row.result?.content` (`app/renderer/src/toolInspectorModel.ts:57`) and the projector does not
truncate. The full text is already in hand.

**Ledger drift, verified:** §05 row `:391` tags this "🔁 adapted (Esc, search+match-step, wrap,
copy, capped footer)". Three of those do not exist. Do not size the work from that row.

=== WHAT THE PROTOTYPE CARRIES ===
`~/catcode_prototype/cat-app/Messages.jsx:255-352`:

- **Copy** writing the active stream's text, toast `Copied output` (`:337-340`).
- **Search** computing matching line numbers, showing `k/N`, with `‹ ›` steppers that **wrap
  around**, scroll the active line to vertical center, and highlight it (`:271-284,325-335`).
- **Wrap** toggle.
- Stdout/stderr **tab pills** with per-stream line counts, when both exist.

The app already has two copy idioms to follow rather than invent: `CodeBlock`
(`TranscriptView.tsx:665`) and `BubbleCopyChip` (`:1329`). Follow the house pattern.

**Updated 2026-07-31 after P4-38 landed:** `BubbleCopyChip` no longer hardcodes "message" — it takes
a `subject` prop resolved through a `COPY_CHIP_TEXT` map (`TranscriptView.tsx:1341-1352`). It is
still a pattern to imitate rather than a component to mount here: it is a corner chip on a
positioned bubble, and the inspector's copy control belongs in the drawer's own header. But if you
add a third subject, extend that map rather than starting a new one.

=== SCOPE — READ THE FENCE ===
IN: copy, search with match-stepping and scroll-to-center, wrap. None of these is blocked by
anything.

OUT, with the reason:
- **Stdout/stderr tab pills.** The fold does not preserve the stream split; there is one `output`
  string. Building tabs over a single stream is a fake.
- **The `capped at {bytes}` footer.** The projector carries no byte metadata.
Flag both as §0 deferrals naming the seam each needs. Do not mock either.

**Search is pure interaction, and the `app/` renderer suite is SSR-only** — no headless test in this
repo can press a key, fire focus, or run a scroll effect. So put the searchable logic in a pure,
exported, unit-tested helper (match-line computation, `k/N`, wrap-around stepping) and keep the DOM
layer thin. A component-only implementation is structurally unverifiable here, which is exactly how
past interaction bugs reached the operator through green batteries.

=== PROTOTYPE — THE ACCEPTANCE BAR ===
Read `Messages.jsx:255-352` before writing code, and run it side-by-side via
`~/catcode_prototype/CatCode Web App.html` (repo root, NOT inside `cat-app/`). PROGRAM-PLAN §6:
done means it READS as the prototype. Port ZERO prototype code; no inline `style={{}}`; beware the
dynamic-class trap. States to compare: no query, a query with zero matches, one match, many matches
mid-stepping, wrap on and off, and copy in its confirmed state.

**User-visible text (CLAUDE.md §7):** no em dash anywhere a user can read it, including the
no-value placeholder (write `none`) and `aria-label`s. This file's doc comment currently says the
drawer degrades to `—`; if that reaches the screen, it is a §7 violation you are now touching.

=== GROUND RULES ===
Renderer-only. This surface renders untrusted tool input and model output: everything stays a text
node, never `dangerouslySetInnerHTML`, never a live control. Zero `as` casts in the tolerant-narrowing
code. No new inbound vocabulary or preload channel; security baseline untouched (T4/T5a/T6/T7 +
HC1-HC4). `app/` is strict. No new deps. Branch `migration`, commit your own explicit paths.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (baseline 2026-07-31: **1994 pass / 0 fail**) · `bunx tsc --noEmit -p
app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar` zero new owned ·
`bun run --cwd app test:hardening` 19/19 · `bun run --cwd app renderer:build` ok.

**Invoke the `verifying-cat-code-changes` skill**; paste the filled **FIDELITY** block and the
**SURFACE ACCEPTANCE** tiered verdict. An open, unapproved mismatch stops a fidelity-pass claim.

GUI (operator's — STOP and print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use
the P3-H harness, then WAIT; NO automation): open a long tool result, open the inspector, copy it
and paste elsewhere to confirm the full text landed, then search for a term appearing several times
and step past the last match to confirm it wraps to the first and the line is centered. Migration
test turns use `gpt-5.6-luna` at low effort on a healthy account.

Report: the one-line contract statement (required). Ledger: correct §05 `:391` to state what
actually ships and what stayed deferred with its seam. Touch no other ledger row and not the Part D
totals. Kill any sidecar you spawn. Update your STATUS row last — re-read `STATUS.md` immediately
before writing and touch only your own row.
```
─── PASTE ───


## P4-38 · ⬜ — Assistant messages have no copy affordance (audit 7)

The design exists and the gates are specified. **The mount does not.** Rev 2 of the audit called
this a drop-in and rev 3 withdrew that; the withdrawal is the important part of this prompt.

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 4/10 · 🖐 GUI

You are running P4-38 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== THE AUDIT PROPOSES; YOU DERIVE ===
This session comes from a UX audit (`docs/migration/reviews/2026-07-31-app-ux-gap-audit.md`,
finding 7) whose defect claims survived six adversarial review rounds and whose proposed fixes
often did not — **this finding's own fix was withdrawn once already**. Treat the evidence below as
reliable and any suggested shape as an untested hypothesis. Re-verify every anchor before building.
**Your report MUST name, in one line, the contract or call path your fix satisfies.**

=== THE DEFECT (source-verified 2026-07-31, re-verify) ===
The user's own message has a hover copy chip; fenced code blocks have one; the assistant's prose has
neither. The only whole-message export paths dump the entire session as raw JSON behind a
sensitive-content warning. Hand-selecting rendered markdown loses formatting and picks up
interleaved tool cards.

- `AssistantProse` — `app/renderer/src/TranscriptView.tsx:518-564`, mounted at `:387`.
- `BubbleCopyChip` — `:1329-1391`.
- `UserBubble` — `:1398-1410`, the only mount.

=== THE TRAP: THIS IS NOT A DROP-IN MOUNT ===
`BubbleCopyChip` is `absolute bottom-1.5 right-2 opacity-0` and reveals through `group-hover` /
`group-focus-within` (`:1353`). Its host supplies what makes that work: `UserBubble`'s inner div is
`group relative` **and reserves the corner with `pr-8`** (`:1404`). `AssistantProse` returns a bare
`<div>` (`:533`) that is neither `relative` nor `group` and reserves nothing. Mounted as-is, the
chip positions against a distant ancestor and stays invisible to pointer users. **The work is the
positioned wrapper, and it has to behave in two states the user bubble never sees:**

1. **Streaming.** `AssistantProse` renders a pulsing caret while `streaming` (`:545-550`). The
   prototype's gate is `showCopy = !msg.streaming && content.trim().length > 0`
   (`~/catcode_prototype/cat-app/Messages.jsx:2064-2091`) — no chip mid-stream, none on an empty turn.
2. **The collapsed-prose branch.** Over `PROSE_COLLAPSE_LINES` (60) the body renders a truncated
   `shown` plus a "Show N more lines" button (`:527-531,551-561`). Decide what the chip copies and
   where it sits relative to that button, and say why.

**The payload is the raw markdown source** (`content`), not the rendered DOM and **not** `shown`.
Copying the truncated view when the body is collapsed is the failure mode to avoid.

**Copy that must differ from the twin.** The prototype's assistant toast is `Copied response`; the
user twin says `Copied message`. `BubbleCopyChip` hardcodes "message" in its `aria-label`, `title`
and toast (`:1343,1351,1352`). Parameterize or fork — state which and why. Keep the app's
`group-focus-within` keyboard reach, which is a deliberate real-added a11y improvement over the
prototype's hover-only reveal.

=== SCOPE — READ THE FENCE ===
IN: the positioned wrapper, the chip mount, the streaming and empty gates, the collapsed-branch
behavior, the assistant-specific copy.

OUT: the **"Assistant" eyebrow label** (ledger §05 `:368`, a separate deferred row) and any bubble
shape or framing for the assistant side (`:367`). Adding either turns a copy affordance into a
transcript reskin.

=== PROTOTYPE — THE ACCEPTANCE BAR ===
`~/catcode_prototype/cat-app/Messages.jsx:2064-2091`. Read it before writing code; run it
side-by-side via `~/catcode_prototype/CatCode Web App.html` (repo root, NOT inside `cat-app/`).
Colors are specified there: idle `#71717a`, hover `#d4d4d8`, copied `#86efac`, reverting after
1300ms. PROGRAM-PLAN §6 in full: done means it READS as the prototype; the prototype IS the visual
grammar, do not invent a parallel one. Port ZERO prototype code; no inline `style={{}}` — tokens and
the Tailwind idiom, and beware the dynamic-class trap (interpolated arbitrary values silently
no-op; use a static map).

Enumerate STATES: streaming, just-finished, empty turn, short body, collapsed body, expanded body,
hover, keyboard focus, and the copied confirmation.

**User-visible text (CLAUDE.md §7):** no em dash anywhere a user can read it, `aria-label`s
included.

=== GROUND RULES ===
Renderer-only. No new inbound vocabulary, no preload channel, no protocol change; security baseline
untouched (T4/T5a/T6/T7 + HC1-HC4). `app/` is strict. No new deps. Branch `migration`, commit your
own explicit paths, never `git add -A`.

Note the Fast Refresh boundary: production `app/renderer/src/**/*.tsx` modules export React
components only at runtime. Helpers and constants move to an adjacent `.ts` file
(`lint:fast-refresh` enforces this).

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (baseline 2026-07-31: **1994 pass / 0 fail**) · `bunx tsc --noEmit -p
app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar` zero new owned ·
`bun run --cwd app test:hardening` 19/19 · `bun run --cwd app renderer:build` ok.

**The `app/` renderer suite is SSR-only**, so hover reveal and the copy round-trip are structurally
invisible to it. Test what is testable headlessly (the gates: streaming, empty, collapsed payload)
and state plainly in your report which behaviors only the GUI step can confirm. Do not report a
green battery as evidence that the chip appears.

**Invoke the `verifying-cat-code-changes` skill**; paste the filled **FIDELITY** block and the
**SURFACE ACCEPTANCE** tiered verdict. An open, unapproved mismatch stops a fidelity-pass claim.

GUI (operator's — STOP and print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use
the P3-H harness, then WAIT; NO cua-driver / claude-in-chrome / any automation): send a turn and
watch a full reply stream in — no chip while streaming, chip on hover once it settles; copy it and
paste into an editor to confirm raw markdown, not rendered text; then do the same on a reply long
enough to collapse and confirm the clipboard holds the WHOLE reply, not the visible part; then
reach the chip by keyboard alone. Migration test turns use `gpt-5.6-luna` at low effort on a healthy
account.

Report: the one-line contract statement (required). Ledger: flip §05 `:369` (AssistantBubble
hover-reveal copy chip, currently ⬜ deferred owner-flagged) with a real `app/…:line`, and leave
`:367`/`:368` alone. Touch no other ledger row and not the Part D totals. Kill any sidecar you
spawn. Update your STATUS row last — re-read `STATUS.md` immediately before writing and touch only
your own row.
```
─── PASTE ───


## P4-39 · ⬜ — The session actions menu runs off the bottom of the window (audit 19)

**This session ships with its UNVERIFIED tag intact and must not claim the finding closed.** Whether
the app's menu clips today is unconfirmed, and the prototype's constant threshold suits the
prototype's menu, not necessarily this one.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 3/10 · 🖐 GUI

You are running P4-39 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== THE AUDIT PROPOSES; YOU DERIVE ===
This session comes from a UX audit (`docs/migration/reviews/2026-07-31-app-ux-gap-audit.md`,
finding 19) whose defect claims survived six adversarial review rounds and whose proposed fixes
often did not. Re-verify every anchor before building. **Your report MUST name, in one line, the
contract or call path your fix satisfies.**

=== THE DEFECT (source-verified 2026-07-31, re-verify) ===
`SessionActionsMenu` applies the anchor raw: `style={{ top: anchor.top, left: anchor.left }}`
(`app/renderer/src/SessionActionsMenu.tsx:74`), on a `fixed` `w-[232px]` panel (`:70-75`). Its own
doc comment concedes the gap: "The remaining §17 menu gap is the anchor's bottom-flip (`placeAbove`),
which stays owned by the anchor call sites" (`:15-16`). **No call site implements it.** Three
produce anchors and all three clamp horizontally only:

- `TabBar.tsx:312-321` — `{ top: rect.bottom + 4, left: Math.max(8, rect.right - 232) }`.
- `Sidebar.tsx` — the kebab path is identical; the **right-click path passes raw pointer coordinates
  with no clamp at all**.
- `SessionsPage.tsx` — rects at `:676,:744,:900` routed through `onOpenRowActions` to App.

The menu is roughly 300px tall, so opening it from a bottom row puts the lower rows out of reach
with no scroll.

**A tested precedent exists in this repo.** `placeTagPopover`
(`app/renderer/src/sessionsPageState.ts:237-253`) is a pure function returning a discriminated
placement (`{placeAbove: true, bottom, left} | {placeAbove: false, top, left}`), flipping on
`rect.bottom > viewport.height / 2` and clamping left against width and margin constants. It is the
same idea, already unit-tested, and its shape is compatible.

The prototype does it in two lines (`~/catcode_prototype/cat-app/SessionActions.jsx:112-113`):
`placeAbove = anchor.top > window.innerHeight - 320`, anchoring the flipped menu to `bottom` so it
grows upward with the same 4px offset either way. **The threshold is a constant, not a measurement.**

=== THE CARRY CONDITION — DO NOT DROP IT ===
Audit rev 4 retired this finding's UNVERIFIED caveat and **rev 5 restored it**. Two separate things
are still unknown:

1. **Whether the app's menu clips today.** The ~300px height is inferred from row count, never
   measured.
2. **What threshold suits THIS menu.** A constant that suits the prototype's rows, fonts, zoom and
   viewport says nothing about the app's, whose row set is different.

Therefore: **port the mechanism, unit-test the placement helper, and leave live confirmation as an
operator step.** Your report must state explicitly that the finding stays UNVERIFIED until the
operator confirms clipping and the flip in the running app. **Do not write "finding 19 closed" in
STATUS or the ledger.** If you find a way to derive the height rather than assume it, say so and say
what it costs; do not silently substitute one guess for another.

=== SCOPE ===
IN: move placement into the component (or into one shared pure helper the component calls), covering
all three call sites including the unclamped right-click path; unit tests over the helper for
near-top, near-bottom, exact-threshold, viewport-narrower-than-the-menu, and the raw-pointer case.

OUT: the menu's contents, its verbs, and the dialog layer P4-30 built. This is placement only.

=== GROUND RULES ===
Renderer-only, pure geometry. No new inbound vocabulary, no preload channel, no protocol change;
security baseline untouched (T4/T5a/T6/T7 + HC1-HC4). `app/` is strict. No new deps. Follow the
house convention: pure placement logic in a `.ts` module (the `sessionsPageState.ts` precedent), not
inside the `.tsx` — the Fast Refresh boundary is lint-enforced. The existing `§0 EXCEPTION` comment
at `SessionActionsMenu.tsx:68-69` explains why this one geometry style attribute is allowed; keep
that justification accurate if the shape changes. Branch `migration`, commit your own explicit paths.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (baseline 2026-07-31: **1994 pass / 0 fail**) · `bunx tsc --noEmit -p
app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar` zero new owned ·
`bun run --cwd app test:hardening` 19/19.

GUI (operator's — STOP and print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use
the P3-H harness, then WAIT; NO cua-driver / claude-in-chrome / any automation). The operator step is
the verification this session cannot do: open the ⋯ menu from the **bottom-most** session row in the
sidebar, from the bottom-most Sessions-page row, and by right-clicking near the bottom edge; in each
case every row must be reachable. Ask them to note whether the menu clipped BEFORE the fix if they
still have a pre-fix build, since that is the open question. Migration test turns use `gpt-5.6-luna`
at low effort on a healthy account.

Report: the one-line contract statement (required), and an explicit UNVERIFIED line naming what the
operator step is expected to settle. Ledger: §17 row `:1242` records the missing `placeAbove`
accurately; update it to what ships and keep the unverified qualifier. Touch no other ledger row and
not the Part D totals. Update your STATUS row last — re-read `STATUS.md` immediately before writing
and touch only your own row.
```
─── PASTE ───


## P4-40 · ⬜ — Welcome recents are inert for terminal-only projects (audit 20)

**This is not a deletion.** Removing the disabled rendering alone ships a clickable no-op, because
two separate early-returns discard the click. An earlier revision of the coverage document said
"delete the invented disabled row" and was corrected; that correction is the point of this prompt.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 5/10 · 🖐 GUI

You are running P4-40 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== THE AUDIT PROPOSES; YOU DERIVE ===
This session comes from a UX audit (`docs/migration/reviews/2026-07-31-app-ux-gap-audit.md`,
finding 20) whose defect claims survived six adversarial review rounds and whose proposed fixes
often did not — **this finding's fix was restated twice before it was right**. Re-verify every
anchor before building. **Your report MUST name, in one line, the contract or call path your fix
satisfies.**

=== THE DEFECT (source-verified 2026-07-31, re-verify) ===
A recent workspace whose sessions were all created in the terminal renders disabled, with the title
"Open this project from the terminal. The desktop cannot restore it yet."
(`app/renderer/src/WelcomeScreen.tsx:328-335`). **That statement is no longer true.**
`openHistorySession` shipped, and both the sidebar and the Sessions page already open exactly those
rows by engine id.

=== THE TRAP — READ THIS BEFORE YOU TOUCH THE DISABLED BRANCH ===
The disabled state is not decoration. A history-only workspace is deliberately given
`appSessionId: null` (`app/renderer/src/sessionsCatalogState.ts:577-607`, and the doc comment at
`:586-594` already names the fix), and **two** independent guards discard the click:

- the picker handler — `WelcomeScreen.tsx:245-249`, `if (recent.appSessionId == null) return`
- the App callback — `App.tsx:2890-2894`, the same test again

**Delete the disabled rendering and nothing else, and you ship a row that looks live while every
click is silently swallowed.** The disabled state is the honest consequence of the launcher opening
by app id; it is not an invention to remove.

=== THE SHAPE, AND WHY IT IS THE ONLY SAFE ONE ===
The route already exists and is decided (SESSIONS-UNIFICATION, operator ruling 2026-07-20):

- `resolveSessionOpenRoute` (`sessionsCatalogState.ts:415-430`) is **the single open decision** and
  already returns `{ kind: 'history', engineSessionId }` for a row that is not in the registry and
  has a cwd. Its parameter is a `Pick<MergedSessionRow, …>`, so it is reusable by shape.
- `openCatalogRow` (`App.tsx:1751-1759`) routes that verdict.
- `openHistorySession` (`App.tsx:1721-1743`) calls `bridge.openHistorySession(engineSessionId)`.

**That last hop is the security-relevant one.** Main resolves the workspace from the engine-written
baseline rather than from a renderer-supplied string, which is what keeps it inside
`SECURITY-MINIMUM.md` **HC1: the renderer never authors a filesystem path.** Any design where the
recent row hands a `cwd` across the boundary is a baseline violation, not a shortcut. So the work is:
carry a representative history engine id on `RecentWorkspace`, and route null-app-id recents through
the existing path — not a new IPC, not a path-authored one.

Note that `selectRecentWorkspaces` currently drops empty-cwd rows outright (`:644`) and adopts only
the first openable **app** id (`:662-667`); it never carries an engine id. Work out for yourself
which rows remain genuinely unopenable after your change and whether the disabled branch still has a
reachable case at all. If it does not, say so rather than leaving dead UI behind.

=== SCOPE ===
IN: the selector change, the two early-returns, the routing, and the copy. Tests: a selector test
(a history-only workspace yields an openable identity) **and** a wiring test (the null-app-id path
reaches the history route rather than returning). Both, not one.

OUT: the prototype's in-picker trust modal (ledgered adapted — the real gate fires post-spawn) and
its `Open read-only` action (a recorded cut). Port the openability, not the modal.

=== PROTOTYPE ===
`~/catcode_prototype/cat-app/Welcome.jsx:216,238-260`: every recent row is a live button and
`choose(path)` has exactly one branch, untrusted to the trust prompt, otherwise open. There is no
disabled state and no "cannot be restored" copy anywhere. That is the target state; the mechanism is
ours, because the prototype has no session concept.

**User-visible text (CLAUDE.md §7):** whatever replaces the stale title must tell the user what to
DO, not what we have not built. No em dash. No engineering vocabulary (no "history row", no "engine
id").

=== GROUND RULES ===
Renderer-side routing over an EXISTING host verb. If you find yourself adding a preload channel or a
new inbound frame kind, stop: that is a boundary change needing sidecar validation, a boundary test
and a decision reference (repo mistake #5), and it is almost certainly a sign you have left the
`openHistorySession` path. Security baseline untouched (T4/T5a/T6/T7 + HC1-HC4). `app/` is strict.
No new deps. Branch `migration`, commit your own explicit paths, never `git add -A`.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (baseline 2026-07-31: **1994 pass / 0 fail**) · `bunx tsc --noEmit -p
app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar` zero new owned ·
`bun run --cwd app test:hardening` 19/19 · `bun run --cwd app renderer:build` ok.

**Invoke the `verifying-cat-code-changes` skill**; paste the filled **FIDELITY** block and the
**SURFACE ACCEPTANCE** tiered verdict.

GUI (operator's — STOP and print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use
the P3-H harness, then WAIT; NO cua-driver / claude-in-chrome / any automation): with a project whose
sessions were all created in the terminal, open the Welcome project picker, confirm the row is live
rather than greyed, click it, and confirm a real session opens showing that transcript. The failure
this guards against is a row that looks live and does nothing, so a click that produces no visible
result is a FAIL, not an inconclusive. Migration test turns use `gpt-5.6-luna` at low effort on a
healthy account.

Report: the one-line contract statement (required), and state explicitly whether the disabled branch
still has a reachable case. Ledger: §29 rows `:1989-:1992` cover the recent-item rows; update the
ones you changed with a real `app/…:line`, tagging per the ledger's vocabulary. §29 is recorded
CLOSED in Part C — do not reopen its count. Touch no other ledger row and not the Part D totals.
Kill any sidecar you spawn. Update your STATUS row last — re-read `STATUS.md` immediately before
writing and touch only your own row.
```
─── PASTE ───


## P4-41 · ⬜ — No reset-to-default for any editable engine setting (audit 15)

**Both halves in one session, sequenced boundary-first, with a stop condition.** The renderer half
is meaningless without the sidecar half: wiring `onReset` today produces a button whose write the
sidecar rejects, which is worse than no button. They are also one change, roughly a validator branch
plus a wiring pass, so splitting them costs two sittings and an interface negotiation between them.
**But the boundary half is a real inbound-surface decision**, so the prompt below forbids building
the renderer half until it is settled, and orders a STOP-and-report if the shape turns out to need a
new frame kind or a protocol version bump.

─── PASTE ───
```
🧠 Model: CLAUDE (system-architecture) · Difficulty: 6/10 · 🖐 GUI

You are running P4-41 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== THE AUDIT PROPOSES; YOU DERIVE ===
This session comes from a UX audit (`docs/migration/reviews/2026-07-31-app-ux-gap-audit.md`,
finding 15) whose defect claims survived six adversarial review rounds and whose proposed fixes
often did not — that finding's own numbers were wrong in rev 1 and corrected in rev 2. Treat the
evidence below as reliable and any suggested shape as an untested hypothesis. Re-verify every anchor
before building. **Your report MUST name, in one line, the contract or call path your fix
satisfies.**

=== THE DEFECT (source-verified 2026-07-31, re-verify) ===
Setting a value back to its default **pins** it rather than removing it. There is no way to
un-write an engine settings key from the desktop.

- The primitive works. `Field` renders a "Reset to default" button gated on
  `modified && !managed && editable && onReset` (`app/renderer/src/SettingsField.tsx:184-192`).
- The editor never supplies it. `SettingsEditors.tsx:189-197` passes `desc` / `editable` / `label` /
  `managed` / `origin` / `source` and **never** `modified` or `onReset` — `rg -n 'modified|onReset'`
  over that file returns nothing.
- The only two call sites in the shell are app-local view preferences, not engine keys
  (`SettingsShell.tsx:788-789,864-865`: accent and code theme).
- So **all 14 registry keys** (`app/shared/settingsEditable.ts:123`, `EDITABLE_SETTINGS`) ship
  without the control.

The consequence is scope-dependent and worth stating precisely, because precedence is
policy ▸ flag ▸ local ▸ project ▸ user (`app/renderer/src/settingsState.ts:140-145`): a pinned
**user** value is overridden by every layer above it, so it mostly harms machine-wide defaults; a
pinned **local** value genuinely shadows project settings.

=== THE GATE — WHY THE SIDECAR HALF COMES FIRST ===
The clear mechanism already exists and is control-kind-agnostic. `app/sidecar/settingsDomain.ts:314-325`:

    const clearsKey = value === SETTINGS_ENGINE_DEFAULT
    ... if (clearsKey) delete next[verb.key]; else next[verb.key] = value

written through `updateSettingsForSource`'s under-lock SettingsUpdater FUNCTION form, which is the
P3-5a/DR-2 no-lost-update fix. **Do not simplify or bypass that form** — this is a cross-process
read-modify-write and the locking is load-bearing.

**The blocker is upstream of it.** `validateEditableSettingValue`
(`app/shared/settingsEditable.ts:289-350`) types the value per control kind:
`boolean` requires `typeof value === 'boolean'`; `enum` requires membership in a static list;
`int` requires an integer in range; only `dynamic-enum` accepts a bounded string. So the
`SETTINGS_ENGINE_DEFAULT` sentinel (`:94`) can only survive validation for `dynamic-enum`, and the
sidecar then additionally requires it to be one of the captured live options
(`settingsDomain.ts:293-307`). That is why reset exists for two keys and no others.

The wire shape today is `SettingsSetValueMessage { type, requestId, source, key, value }`
(`app/shared/protocol.ts:388-397`) with `EditableSettingValue = boolean | string | number`
(`settingsEditable.ts:50`).

**Order of work, and the stop condition:**

1. **Decide and land the clear path at the sidecar first**, with boundary tests: a valid clear
   accepted for **each** control kind, and invalid frames still rejected. The sidecar is the trust
   boundary; validation there is not optional and is not satisfied by validating in the preload.
2. **Only then** wire `modified` / `onReset` in `SettingsEditors.tsx`.
3. **STOP and report before building the renderer half** if the shape you derive needs a **new
   inbound frame kind** or a **protocol version bump**. `app/shared/protocol.ts` is a versioned
   contract: additive changes only, version bump only on a breaking shape change, and every new
   inbound frame kind needs a sidecar-local schema, a boundary test, and a doc comment citing its
   decision. A half-wired reset button that produces a rejected write is a worse outcome than
   shipping nothing.

Whatever you choose, state in your report which contract makes a "remove this key" request
distinguishable from a "write this value" request, and how the sidecar can never confuse the two.
A sentinel that could collide with a legitimate user value is a bug, not a design.

=== THE TRAP — LEAVE TRANSCRIPT RETENTION ALONE ===
`cleanupPeriodDays` (`settingsEditable.ts:235-241`, `{ kind: 'int', min: 0, max: 3650, default: 30 }`)
participates in your generic reset exactly like every other int key. **Do not do anything else to
it.** Specifically:

- Do **not** narrow its domain. A previously proposed 30/60/90/Forever enum was **rejected**: it
  would delete every legitimate value in between (7, 45, 365) and `Forever` has no wire
  representation at all.
- Do **not** add the destructive-value confirmation. `0` deletes existing transcripts at startup
  retroactively (`src/utils/settings/types.ts:331`, `src/utils/cleanup.ts:25-30`) and that is
  **audit finding 5a**, a separate item with its own owner. Two sessions editing the same field
  with different mental models is how contradictory behavior lands.

=== SCOPE ===
IN: the sidecar clear path for all control kinds with boundary tests; `modified` / `onReset` for the
14 registry keys; the `managed` and flag-override cases staying correctly non-resettable (the
primitive's gate already encodes this, so prove it still holds).

OUT: any new settings key, any change to precedence, any editor redesign, and the retention field
beyond generic reset.

Prototype reference (`~/catcode_prototype/cat-app/Settings.jsx:98-122`): the idiom is uniform,
`modified={g.key !== DEF.key} onReset={() => reset('key')}` on every engine-settings field, with the
button reading exactly **"Reset to default"** and shown only when modified. Note two things the
prototype gets differently: its reset **writes the default value back** while ours must **remove the
key**, and its IDE-pane fields (`:510`) deliberately pass neither, being local connection toggles
rather than settings-file keys. Its one deliberate exception (`:181`) is a flag-sourced field that
passes `modified` unconditionally with an `onReset` raising a warn toast. The prototype's mock data
is never the contract; real engine shapes win.

=== GROUND RULES ===
Security baseline is a hard gate (`decisions/SECURITY-MINIMUM.md` T4/T5a/T6/T7 + HC1-HC4): inbound
vocabulary is a **closed allowlist validated at the sidecar**, never only at the preload; directional
frame limits stay unswapped; secrets stay engine-side. Preserve the `SettingsUpdater`-under-lock form.
`app/` is strict. No new deps. Branch `migration`, commit your own explicit paths, never `git add -A`.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (baseline 2026-07-31: **1994 pass / 0 fail**) · `bunx tsc --noEmit -p
app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar` zero new owned ·
`bun run --cwd app test:hardening` 19/19 · `bun run --cwd app renderer:build` ok. Boundary tests for
the clear path are part of DONE, not a nice-to-have.

**Invoke the `verifying-cat-code-changes` skill**; paste the filled **FIDELITY** block and the
**SURFACE ACCEPTANCE** tiered verdict.

GUI (operator's — STOP and print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use
the P3-H harness, then WAIT; NO cua-driver / claude-in-chrome / any automation): change a boolean
key and an int key at the User scope, confirm "Reset to default" appears on each, press it, and
confirm the row returns to its default **and its source badge stops naming the user layer** (the
point is that the key was removed, not re-written). Then confirm a policy-managed row still offers
no reset. Migration test turns use `gpt-5.6-luna` at low effort on a healthy account.

Report: the one-line contract statement (required), plus the sentinel-vs-value distinguishability
argument. Ledger: §11 row `:796` and Part B row `:2277` both record the primitive as built but
DORMANT; update them to what actually ships. Touch no other ledger row and not the Part D totals.
Kill any sidecar you spawn. Update your STATUS row last — re-read `STATUS.md` immediately before
writing and touch only your own row.
```
─── PASTE ───


# TRANCHE I — the UX-gap audit's second wave (generated 2026-07-31)

Same two sources as TRANCHE H — `docs/migration/reviews/2026-07-31-app-ux-gap-audit.md` (rev 6) and
`docs/migration/reviews/2026-07-31-app-ux-gap-prototype-coverage.md` (rev 3) — plus the **four
operator rulings of 2026-07-31**, recorded in `decisions/STARTUP-GATES.md` (2a §1.2, O2a #12
revision) and in the coverage document's *Operator rulings* section (O1 and 24b, which have no
decision doc of their own and are canonical there).

**Nine sessions, ten items, plus one open defect TRANCHE H left behind.**

| Session | Item | What it is |
|---|---|---|
| **P4-42** | audit 3 | Permission prompts show raw JSON instead of the command or the diff |
| **P4-43** | audit 12 | The permission card's advertised keyboard shortcuts are dead |
| **P4-44** | O1 (ruled) | Sidebar rows cannot be told live from not-live |
| **P4-45** | audit 26c **+ TRANCHE H's open defect** | Three rendered engineering notes, and two buttons sharing one label |
| **P4-46** | audit 26a | The window has no minimum size |
| **P4-47** | audit 5a **+** 26d (ruled) | Retention `0` destroys history silently; the Remote rail advertises a cut SSH mode |
| **P4-48** | 2a (ruled) | The launcher never tells a first-run user what to do first |
| **P4-49** | 24b (ruled) | No connection tone grammar, and the bar prints a raw status word |
| **P4-50** | O2a (ruled) | Account health surfaces only inside the scrolling transcript |

## The rule that governs every session in this tranche

Unchanged from TRANCHE H, because it has not stopped being true. **The audit's defects are reliable.
Its proposed fixes are not.** Six adversarial review rounds withdrew or corrected **seven** of the
"Improvement" lines — two of them wrong in the dangerous direction — while almost no defect was
withdrawn. So every prompt below carries the finding's **evidence** and forbids it from carrying the
finding's **conclusion** as settled. Every session must:

1. **Re-verify every anchor in current source before building.** Everything below was verified at tip
   `39351bd` on 2026-07-31; the tree is shared and moves.
2. **Name, in its report, the contract or call path the fix satisfies** — the existing function, type,
   or invariant that makes the change correct. One line. "The audit said so" is not a justification,
   and neither is "the prototype does it": the prototype's mock data is never the contract.
3. **Report a deviation as a §0 proposal**, never a silent narrowing.

TRANCHE H proved the rule earns its keep. P4-36 found the prompt's own premise wrong (it claimed the
prototype's reveal band and the app's inner scroller were different composition models; they are the
same) and P4-40 found that the fix as first written would have offered ~40 dead temp-dir workspaces.
Both were caught because the prompt told them to derive rather than to implement.

## The four rulings carry BOUNDS, not just choices

A ruling is a permission to build one specific thing, not a licence to solve the underlying problem
well. Each prompt quotes its bound **verbatim** rather than paraphrasing it. **A session that exceeds
its bound is wrong even if the result looks better** — the standing precedent is the sidebar status
chips, which no one asked for and the operator reversed on sight. If a session believes its bound
prevents a correct result, that is a §0 proposal to the operator, not a decision it may take.

| Session | Bound in one line |
|---|---|
| P4-44 (O1) | A dot. No chip, no status word, no per-state colour vocabulary. |
| P4-49 (24b) | Two tones. No dot, no chip, no restored `ConnectionChip.tsx`. |
| P4-48 (2a) | Discoverability copy. No host-plane account writes, no session-free settings read. |
| P4-50 (O2a) | Account health only, never blocks submit, always dismissable, no resurrected wall files. |

## Sequencing is by FILE OWNERSHIP. This is not advisory.

TRANCHE H ran sessions in parallel that shared files, and two of them reported each other's work as a
failure: **P4-38** recorded eleven `tsc` errors that were entirely P4-39's uncommitted
`sessionActions.ts` change, and **P4-41** recorded a failing `sessionsCatalogState.ts` suite that was
P4-40 mid-edit. Both were false alarms. Both cost real time, and both sessions were correct to report
them as not-theirs — the process failed, not the workers.

Four files in this wave carry more than one item. The rule for this tranche is **at most one live
session per file**, and the waves below are the parallel-safe partition.

| Contended file | Wants it | Resolution |
|---|---|---|
| `PermissionPrompt.tsx` | P4-42 (audit 3), P4-43 (audit 12) | **Sequenced, 42 first.** 42 rewrites the card body; 43's focus-and-keys mechanism has to be designed against the card that actually ships, including any disclosure control 42 adds. Reversing the order makes 43 design against a body that is about to be replaced. |
| `App.tsx` | P4-43 (audit 12), P4-49 (24b), P4-50 (O2a) | **Sequenced, 49 → 50 → 43.** Three disjoint regions, but one uncommitted edit anywhere in this 4,243-line file is what produced TRANCHE H's false reds. 49 is smallest and unblocks 50's placement decision; 43 runs last because it is also gated on 42. |
| `TranscriptView.tsx` | P4-45 (26c + the label defect), P4-42 **only if** it reuses `DiffView` | **45 first.** 45 is small and lands quickly; 42 may then extract or export what it reuses. 42 may not make behavioural changes there. |
| `settingsScope.ts` | audit 5a's inline warning, 26d's rail copy | **Merged into P4-47.** 26d is one line of copy; splitting it into its own session would put two writers in one file to save nothing. |

```
Wave 1  (parallel-safe, disjoint files)
  P4-44  Sidebar.tsx
  P4-45  TranscriptView.tsx · SettingsExtensions.tsx
  P4-46  app/main/main.ts
  P4-47  SettingsEditors.tsx · settingsScope.ts
  P4-48  WelcomeScreen.tsx
  P4-49  App.tsx · connectionState.ts

Wave 2  (after wave 1 lands)
  P4-42  PermissionPrompt.tsx   [needs P4-45 out of TranscriptView.tsx]
  P4-50  App.tsx                [needs P4-49 out of App.tsx]

Wave 3
  P4-43  PermissionPrompt.tsx · App.tsx   [needs P4-42 and P4-50]
```

**Every session states its file fence in its own prompt and must honour it.** If a session concludes
it needs a file another session owns this wave, that is a STOP-and-report, not a small edit. And the
TRANCHE H habit that worked stays: before debugging a red, run `git status` on the failing file; if it
is dirty and you did not edit it, report it as not-yours-and-unfixed.

## The defect TRANCHE H left open, and its owner

**Two differently-scoped buttons now carry the identical label `Open full output ↗`:** the tool
card's footer (`ToolInspectorLaunch`, `TranscriptView.tsx:988-999`) and the inline reveal band
P4-36 built (`InlineRevealBand`, `:1457-1497`). P4-36 raised it as an OPEN, UNAPPROVED §0 with a
proposed fix — relabel the FOOTER to the prototype's `Inspector` (`Messages.jsx:563`) — and assigned
it to P4-37. **P4-37 finished without taking it**, correctly: P4-36 was still live in that file. Its
report handed the fix to "whoever next owns `TranscriptView.tsx`". That is **P4-45**, which owns the
file in wave 1. The proposal remains a proposal; P4-45 verifies it and decides.

## Parked — unchanged from TRANCHE H, restated so it does not go missing

**Seam-blocked (3)** — a boundary/seam owner is needed before any renderer work: **9** (engine-authored
provenance on the interrupt carrier), **10a** (a cross-plane file-list read seam), **16a Goals** (no
inbound goal-mutation verb; all 25 §22 rows are Part C ❓ with owner UNASSIGNED). The **open-the-file**
capability belongs here too: `SECURITY-MINIMUM.md` HC1 forbids the renderer authoring a filesystem
path, so it needs a host-API verb over a registry-resolved identifier. Full statements are in TRANCHE
H's parked register above; nothing about them changed.

**Bucket C (design first)** — the 21 items enumerated with their design questions in the coverage
document. Not blocked, not scoped: each needs a design decision before a session can be written.
Finding **2b** (the session-free user-settings read) sits here and is explicitly NOT covered by the 2a
ruling.

## Known ledger drift — note it, do not fix it here

The four rows recorded at the end of the coverage document plus the two found while scoping TRANCHE H
still stand, minus whatever TRANCHE H's sessions corrected in passing. Reconciling the ledger is not
part of any session below; each session updates only the rows it actually changed.


## P4-42 · ⬜ — Permission prompts show raw JSON instead of the command or the diff (audit 3)

The largest and highest-value item in the wave, and the one whose "port the prototype's variant
table" framing is most likely to mislead. The prototype's table is keyed on a field the real request
does not have, and half its columns are mock fixture fields the ledger already cut. What ports is the
**shape** (per family: a label, and the one field worth promoting), not the table.

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 7/10 · 🖐 GUI

You are running P4-42 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== THE AUDIT PROPOSES; YOU DERIVE ===
This session comes from a UX audit (`docs/migration/reviews/2026-07-31-app-ux-gap-audit.md`,
finding 3) whose "what is missing" claims survived six adversarial review rounds, and whose proposed
FIXES did not: seven were withdrawn or corrected, two of them wrong in the dangerous direction.
Treat the evidence below as reliable and every suggested shape as an untested hypothesis. Re-verify
every anchor in current source before you touch anything (verified at tip `39351bd`, 2026-07-31; the
tree is shared and moves). **Your report MUST name, in one line, the contract or call path your fix
satisfies** — the existing function, type or invariant that makes it correct. "The audit said so" is
not a justification, and neither is "the prototype does it".

=== THE DEFECT (source-verified 2026-07-31, re-verify) ===
`app/renderer/src/PermissionPrompt.tsx:109-111` renders, for EVERY tool:

    <pre className="mt-3 max-h-36 overflow-auto …">
      {JSON.stringify(request.request.input, null, 2)}
    </pre>

So approving a shell command means reading `{"command": "…", "timeout": 120000}`, and approving an
edit means reading `old_string`/`new_string` as escaped JSON with literal `\n`. This is the app's
only safety gate and its least legible surface. The terminal engine has fifteen per-family renderers
(`src/components/permissions/`), routed at `src/components/permissions/PermissionRequest.tsx:47-80`.

=== WHAT YOU ACTUALLY HAVE TO WORK WITH ===
`PermissionRequest` is the wire's `permission.requested` payload (`permissionState.ts:27-30`, an
`Extract` over `AppSessionEvent`). Establish its real field set from the type, not from this prompt.
Today it carries `tool_name`, `display_name`, `title`, `input`, `decision_reason`, `blocked_path`,
`permission_suggestions`, `agent_id`. `input` is unstructured: runtime-narrow it with ZERO `as`
casts, house rule, and fall back rather than throw on a shape you do not recognise.

**Trap 1 — the engine routes by TOOL OBJECT IDENTITY, not by name.** That switch is
`case FileEditTool:` / `case BashTool:` / `case GlobTool: case GrepTool: case FileReadTool:` and so
on. The desktop only has `tool_name` on the wire, so your family map keys on strings. Derive each
string from the tool definition the engine switch names, cite the `src/…:line` you took it from, and
say what happens for a tool that is not in your map (the engine's answer is
`FallbackPermissionRequest`; yours should be the raw-input fallback, not a crash and not a guess).

**Trap 2 — there is no diff on a permission request, and you cannot compute the real one.**
`DiffView` (`TranscriptView.tsx:2445`) consumes a `ToolDiffProjection`, which the projector builds
from the engine's POST-execution `structuredPatch` (`transcriptProjector.ts:1138`
`extractDiffProjection`). A permission request is PRE-execution: no `structuredPatch`, no file
contents. The engine's own edit card computes its diff by reading the file from disk
(`src/components/FileEditToolDiff.tsx:129,143` → `getPatchForDisplay`), which the renderer must never
do (HC1: the renderer authors no filesystem path and has no filesystem). The `diff` package IS
already an app dependency (`app/package.json:26`; already imported at `TranscriptView.tsx:39`), so a
patch computed over `old_string` vs `new_string` alone is available with no new dep — **but a patch
over two snippets is not the file's patch, and its line numbers are not the file's line numbers.**
Presenting snippet line numbers as file line numbers is the failure mode here. Decide, and say in
your report which of these you shipped and why: a before/after presentation with no line numbers, a
computed snippet patch with its numbering suppressed, or something else. Do not silently invent
numbering.

**Trap 3 — half the prototype's table is mock.** `~/catcode_prototype/cat-app/Permissions.jsx:58-73`
is a 15-entry `PV` map keyed on `item.variant`, a field of the prototype's mock queue. Its
`head.preview` / `head.diff` / `head.cwd` / `head.method` / `head.skillDesc` / `head.classifier` are
fixture fields with no wire counterpart — `PARITY-LEDGER.md` §07 already records `classifier-routed`
and the lane colours as ✂️ cut, and `head.warn` as a cut MOCK string. What ports is the SHAPE: per
family, an uppercase preview label plus the one field worth promoting into a legible preview. What
does not port is any field the request does not carry.

=== SCOPE — READ THE FENCE ===
IN: a per-family preview inside the existing card. At minimum the families the audit names — a shell
command in mono, a file edit/write, a fetched URL — plus a labelled generic preview for the rest and
a collapsed "show raw input" fallback for anything unrecognised. The family map and its field
extraction belong in a pure, exported, unit-tested module (`permissionPromptModel.ts` is the existing
home, or an adjacent `.ts`), not inside the `.tsx`: the renderer suite is SSR-only, so a decision
table living in a component is barely testable, and `lint:fast-refresh` forbids non-component exports
from a production `.tsx` anyway.

OUT, each for a recorded reason:
- **`AskUserQuestion` and `ExitPlanMode`.** They have their own renderers (`AskQuestionFlow`,
  `PlanPanel`) and never reach this card except through the `denyOnly` unreadable-question fallback.
  Leave both alone, and leave the `denyOnly` path's behaviour unchanged.
- **Client-side rule synthesis** (`ruleImplication`, `scopeFromRule`, `dirOf`). A recorded cut:
  `decisions/PERMISSION-BOUNDARY.md §2` — rendering a guessed rule that differs from what persists is
  a correctness bug. Always-allow stays engine-minted suggestion selection by index (C1/T6b).
- **Lane priority, lane accents, lane tags, the classifier badge, the warn banner.** All ✂️ cut in
  ledger §07 as mock-only vocabulary.
- **The keyboard.** The advertised shortcuts are dead and that is **P4-43**, running after you. Do
  not fix them, and do not make them worse: if your preview adds a focusable control (a disclosure
  button is the obvious one), say so plainly in your report, because it changes the surface P4-43 has
  to make work.

**File fence.** You own `PermissionPrompt.tsx` and any new model module. `App.tsx` belongs to other
sessions this wave — you should not need it, since `PermissionQueue` already hands you the whole
request. `TranscriptView.tsx`: touch it ONLY to export or extract a renderer you reuse (P4-45 lands
there first and must be finished before you start); no behavioural change there is in your scope. If
you conclude you need a file you do not own, STOP and report.

=== PROTOTYPE — THE ACCEPTANCE BAR, NOT A REFERENCE ===
Read `~/catcode_prototype/cat-app/Permissions.jsx:58-73` (the variant table) and `:530-570` (how a
preview, a diff and a network detail actually render) before writing code, and run it side by side:
the runner is `~/catcode_prototype/CatCode Web App.html` (prototype repo root, NOT inside
`cat-app/`). PROGRAM-PLAN §6 applies in full — a surface is done when it READS as the prototype, not
when its data is wired. Port ZERO prototype code. No inline `style={{}}`: P0-2 tokens and the
Tailwind idiom, and beware the dynamic-class trap (interpolated arbitrary values silently no-op; use
a static map).

Enumerate STATES, not one screenshot: a Bash request, an Edit, a Write, a WebFetch, a tool with no
recognised family, a request with `decision_reason` and `blocked_path` set, a worker-relayed request
(`agent_id`), a request with several always-allow suggestions, the `denyOnly` card, and an in-flight
`submitted` card.

**User-visible text (CLAUDE.md §7):** no em dash anywhere a user can read it, `aria-label`s and
`title`s included; no engineering vocabulary; no file:line citations. Check with
`rg -n '—' app/renderer/src --glob '!*.test.*'` and confirm every remaining hit is a code comment.

=== GROUND RULES ===
Renderer-only. No new inbound vocabulary, no preload channel, no protocol change — if you think you
need one you have left the scope. Security baseline untouched (`decisions/SECURITY-MINIMUM.md`
T4/T5a/T6/T7 + HC1-HC4), and note that this surface renders untrusted model-authored tool input:
everything stays a text node, never `dangerouslySetInnerHTML`, never a live control, never a
clickable URL. `app/` is strict TypeScript. No new deps. Branch `migration`, commit your own explicit
paths, never `git add -A`.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (baseline 2026-07-31 at tip `39351bd`: **2087 pass / 0 fail** — a DROP is a
regression) · `bunx tsc --noEmit -p app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar`
zero new owned · `bun run --cwd app test:hardening` 19/19 · `bun run --cwd app renderer:build` ok.

**Invoke the `verifying-cat-code-changes` skill** and paste BOTH artifacts: the filled **FIDELITY**
block and the **SURFACE ACCEPTANCE** tiered verdict. An open, unapproved mismatch stops a
fidelity-pass claim; a §0 flag is a proposal, not a closure.

GUI (operator's — STOP and print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use
the P3-H harness, then WAIT; NO cua-driver / claude-in-chrome / any automation): drive a turn that
asks to run a shell command and one that asks to edit a file, and confirm each card shows the thing
being approved rather than JSON, that the raw input is still reachable, and that Allow / Deny /
Always-allow still answer correctly. Migration test turns use `gpt-5.6-luna` at low effort on a
healthy account.

Report: the one-line contract statement (required); the tool-name derivation with its `src/…:line`;
your Edit-preview decision and why; and whether you added a focusable control (P4-43 needs to know).
Ledger: `PARITY-LEDGER.md` §07 has roughly ten rows whose evidence all points at the JSON `<pre>` at
a stale `PermissionPrompt.tsx:129-131` (generic payload preview, file-edit diff preview, inline
command title, web-fetch method badge, skill description, cwd line, sandbox network detail,
computer-use preview). Update exactly the rows your change makes wrong, with real anchors and the
ledger's own tags. Touch no other ledger row and not the Part D totals. Kill any sidecar you spawn.
Update your STATUS row last — `STATUS.md` is multi-writer, so re-read it immediately before writing
and touch only your own row.
```
─── PASTE ───


## P4-43 · ⬜ — The permission card's advertised keyboard shortcuts are dead (audit 12)

The coverage document calls this a straight revert of an adaptation, and the prototype does supply
the mechanism verbatim. **It still does not work here**, for a reason neither document caught: the
card's own `role="alertdialog"` is in the selector the guard tests. Ported literally, the fix leaves
all four keys as dead as it found them.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 4/10 · 🖐 GUI

You are running P4-43 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.
Run AFTER P4-42 (it rewrites this card's body) and AFTER P4-50 (it is live in `App.tsx`).

=== THE AUDIT PROPOSES; YOU DERIVE ===
This session comes from a UX audit (`docs/migration/reviews/2026-07-31-app-ux-gap-audit.md`,
finding 12) whose defect claims survived six adversarial review rounds and whose proposed fixes often
did not — **this finding's first fix was withdrawn as insufficient**, and the replacement it names is
also not sufficient (see the trap below). Re-verify every anchor before building. **Your report MUST
name, in one line, the contract or call path your fix satisfies.**

=== THE DEFECT (source-verified 2026-07-31, re-verify) ===
The card prints `Enter allow · N / ⌫ deny · Esc snooze` (`app/renderer/src/PermissionPrompt.tsx:141-145`).
The handler that would honour those keys is a `document` keydown listener in App
(`App.tsx:1988-2024`), and it bails on its first condition:

    if (target instanceof Element && target.closest(FOCUSED_KEY_OWNER_SELECTOR)) return

`FOCUSED_KEY_OWNER_SELECTOR` is `App.tsx:371-375`. The normal flow leaves focus in the composer
textarea after sending, so on most permission requests all four advertised keys do nothing, with no
signal why. The guard is correct — it exists so the deny-feedback field and every button keep their
own Enter. Nothing moves focus when a card appears.

=== THE TRAP THE DOCUMENTS MISS — VERIFY IT FIRST, IT DECIDES THE DESIGN ===
The audit's surviving proposal, and the prototype's mechanism, is: blur the active element and focus
a `tabIndex={-1}` card container on mount (`~/catcode_prototype/cat-app/Permissions.jsx:360-365`
focus effect, `:437` the `tabIndex={-1}` card), keys bound on a window listener.

**`FOCUSED_KEY_OWNER_SELECTOR` contains `[role="alertdialog"]`, and the card's own `<section>` is
`role="alertdialog"` (`PermissionPrompt.tsx:42-46`.)** `target.closest()` matches the element itself,
not only its ancestors. So focusing the card container makes `event.target` the section, `.closest()`
matches it, and the handler returns — the ported mechanism is exactly as dead as what it replaced,
and a session that ships it and tests only that focus moved would close this finding falsely.

Confirm that yourself before choosing a design. Then note the two constraints any working design must
satisfy:

1. **The deny-feedback `<input>` lives INSIDE the card** (`PermissionPrompt.tsx:130-137`). Typing `n`
   there must never deny. Whatever you build, that field keeps its keys.
2. **A `document` listener fires before a `window` listener, and two dedicated flows own the keyboard
   when they are up.** `dedicatedFlowOwnsKeyboard` (`App.tsx:1978-1981`) exists because
   `AskQuestionFlow` and `PlanPanel` register `window` listeners, and a single Enter must never
   resolve two unrelated requests. If you move this listener, say what the new ordering is and prove
   the double-resolve cannot come back.

Also note which card the keys act on: `selectVisiblePermission` picks the first un-answered,
un-snoozed request, and `AskUserQuestion` requests are excluded from it. If several cards are
stacked, focus must land on THAT card, not on the last one rendered.

=== SCOPE — READ THE FENCE ===
IN: making the four advertised keys work when a card appears, from the state the user is actually in
(focus in the composer); and making the hint tell the truth in whatever states remain. If a key
cannot be live in some state, the hint must not advertise it in that state (CLAUDE.md §7: never
advertise a dead affordance).

OUT, with the reason:
- **The keyset.** Enter / N / ⌫ / Esc is the shipped vocabulary (`permissionActionForKey`,
  `permissionPromptModel.ts:12-20`). No cursor navigation, no 1-9 direct pick — ledger §07 records
  both as ✂️ cut.
- **The composer's autofocus.** The audit says decide both together. Deciding is in scope; CHANGING
  the composer is not, because it is a different surface with different owners. If you conclude the
  composer must change, STOP and report with the argument.
- **Card layout, copy and previews.** P4-42 owns the body. You are adding focus and key behaviour to
  the card it ships.

**File fence.** You own `PermissionPrompt.tsx` and the permission keyboard region of `App.tsx`. Both
had another owner earlier in this wave (P4-42, P4-50) — confirm both have landed and the tree is
clean for those files before you start, and `git status` any red before debugging it.

**Interaction is structurally invisible to this repo's test suite** (the `app/` renderer suite is
SSR-only: no keypress, no focus, no effects). So put every decision you can into pure exported
helpers with unit tests — which element should own the keys, whether a given event target should be
ignored, which card is the target — and keep the DOM layer thin. State plainly which behaviours only
the operator's GUI run can confirm. A green battery is not evidence that a key works.

=== GROUND RULES ===
Renderer-only. No new inbound vocabulary, no preload channel, no protocol change; security baseline
untouched (T4/T5a/T6/T7 + HC1-HC4) — note that the permission round-trip is itself a security
surface: a keyboard path must answer the SAME engine-minted request id the buttons do (T5a), never a
renderer-chosen one. `app/` is strict. No new deps. Branch `migration`, commit your own explicit
paths, never `git add -A`.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (baseline 2026-07-31 at tip `39351bd`: **2087 pass / 0 fail**, plus whatever
earlier wave-I sessions added) · `bunx tsc --noEmit -p app/tsconfig.json` clean ·
`bun run --cwd app typecheck:sidecar` zero new owned · `bun run --cwd app test:hardening` 19/19 ·
`bun run --cwd app renderer:build` ok.

GUI (operator's — STOP and print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use
the P3-H harness, then WAIT; NO automation): send a turn that triggers a permission request without
touching the mouse, then press Enter to allow. Repeat for N, Backspace and Esc on later requests.
Then click into the deny-feedback field, type a sentence containing the letter n, and confirm nothing
is denied. Then, with a question card up (`AskUserQuestion`), confirm one Enter answers only the
question. Migration test turns use `gpt-5.6-luna` at low effort on a healthy account.

Report: the one-line contract statement (required); confirmation or refutation of the
`role="alertdialog"` trap with the source you checked; the listener-ordering argument; and an explicit
list of what only the GUI step can settle. Ledger: §07's `Composer-focus steal (blur composer, focus
card, 200ms debounce)` row is currently 🔁 adapted with the stale evidence `App.tsx:669-702`, and the
`Footer key-hint strip` row records the hint. Update both to what ships. Touch no other ledger row and
not the Part D totals. Update your STATUS row last — re-read `STATUS.md` immediately before writing
and touch only your own row.
```
─── PASTE ───


## P4-44 · ⬜ — Sidebar rows cannot be told live from not-live (O1, ruled 2026-07-31)

The smallest ruled item. The whole risk is scope: the last time a session decided a sidebar row
needed more state than it was given, the operator reversed it on sight.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 2/10 · 🖐 GUI

You are running P4-44 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== THE RULING AND ITS BOUND (quoted verbatim — do not paraphrase, do not exceed) ===
From the Operator rulings section of
`docs/migration/reviews/2026-07-31-app-ux-gap-prototype-coverage.md`, which is the canonical record
for this ruling (it has no decision doc of its own):

> **O1 sidebar session state — Live-only dot, no text.** A single small unlabeled dot on live rows,
> absent otherwise. The minimum exception to the 2026-07-20 bare-row ruling, matching the standing
> operator target of live-vs-not-live with no text. No chip, no status word, no per-state colour
> vocabulary. The data already exists at `Sidebar.tsx:839`.

Read that as four prohibitions: **no chip, no status word, no per-state colour vocabulary, and
nothing at all on a row that is not live.** One dot, one tone, present or absent. If you believe the
bound produces a worse result, that is a §0 proposal in your report, not a decision you may take. The
standing precedent is the per-session status chips a previous session added unasked; the operator
reversed them on sight.

=== THE DEFECT (source-verified 2026-07-31, re-verify) ===
A cleanly-closed session leaves the tab bar entirely (`shellState.ts`), so for that session the
sidebar is the only surface it appears on — and the sidebar row carries its state in `aria-label`
only (`Sidebar.tsx:886`, `aria-label={`session ${title}, ${visual.label}…`}`). Sighted users cannot
tell a running session from a closed one.

The data is already on the row and already derived. `MergedSessionRow.live` is
`sessionsCatalogState.ts:117` ("A live registry row with a running process"), and the row component
already computes `deriveMergedRowVisual(row)` (`sidebarState.ts:205`) for its openable/intent
decisions. **Re-verify which of those two is the honest source for "live"** and use it; do not
introduce a third derivation, and do not re-key liveness off connection state, which the sidebar does
not read.

=== THE §0 COMMENT THAT WILL CONTRADICT YOUR CODE ===
`Sidebar.tsx:26-29` records the opposite of what you are about to ship:

> No per-row status dot: the prototype's sidebar rows carry none (title + `time · model` only), so
> the earlier real-added health dot was removed 2026-07-14 to match the prototype (operator
> decision). Live/dead/busy state still surfaces on the TabBar.

Update it to record the 2026-07-31 ruling and its bound, so the next reader does not "fix" your dot
back out. That paragraph is the reason this session exists at all.

=== SCOPE — READ THE FENCE ===
IN: the dot on live rows in the sidebar roster, the comment above, and a unit test over whichever
pure derivation decides it (a live row shows it; restorable, history and browse-only rows do not).

OUT: the collapsed rail, the workspace group headers, the Sessions page, the TabBar, and any
`sessionStatusVisual.ts` / `tabStatus.ts` change. Audit finding 4 (a working indicator on the TAB
bar) is a different finding with no owner, and P4-49 is live in the connection-tone surface this
wave. Also out: the row's `aria-label`, which already carries the state — the dot is decorative, so
mark it `aria-hidden` and do not add a second announcement of the same fact.

**File fence.** You own `Sidebar.tsx` and, if the derivation belongs there, `sidebarState.ts`. Do not
edit `App.tsx`, `sessionsCatalogState.ts`, `TabBar.tsx` or `sessionStatusVisual.ts`.

=== PROTOTYPE ===
`~/catcode_prototype/cat-app/Sidebar.jsx` rows are title + `time · model` with no dot at all, so this
element is a deliberate, operator-ruled departure from the prototype rather than parity work. Tag it
that way in your report and in the ledger (➕ real-added, under the 2026-07-31 ruling). Everything
else about the row stays exactly as the prototype has it: no reflow, no new spacing grammar, and the
dot must not push the title or the `time · model` line around when it appears.

**User-visible text (CLAUDE.md §7):** there is none to add, and that is the point — a dot with a
label is a chip, and a chip is out of bounds.

=== GROUND RULES ===
Renderer-only. No new inbound vocabulary, no preload channel, no protocol change; security baseline
untouched (T4/T5a/T6/T7 + HC1-HC4). `app/` is strict. No new deps. Use a static Tailwind class, never
an interpolated arbitrary value (the dynamic-class trap silently no-ops and headless tests cannot see
it). Branch `migration`, commit your own explicit paths, never `git add -A`.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (baseline 2026-07-31 at tip `39351bd`: **2087 pass / 0 fail**) ·
`bunx tsc --noEmit -p app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar` zero new owned
· `bun run --cwd app test:hardening` 19/19 · `bun run --cwd app renderer:build` ok.

GUI (operator's — STOP and print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use
the P3-H harness, then WAIT; NO automation): with one session open and at least one closed or
terminal-created session in the roster, confirm exactly one row carries the dot; close the live
session and confirm the dot goes with it; confirm no row gained text and no row moved. Migration test
turns use `gpt-5.6-luna` at low effort on a healthy account.

Report: the one-line contract statement (required), and which field you took liveness from. Ledger:
§02 has two adjacent ✂️ cut rows, `Runtime status dot per row` and `Runtime status chip per row
(live/starting/crashed/closed)`. Flip **only the dot row**, tagging it as real-added under the ruling;
**the chip row stays ✂️ cut** — that is the bare-row ruling, still in force. Touch no other ledger row
and not the Part D totals. Update your STATUS row last — re-read `STATUS.md` immediately before
writing and touch only your own row.
```
─── PASTE ───


## P4-45 · ⬜ — Three rendered engineering notes, and two buttons sharing one label (audit 26c + the TRANCHE H carry-forward)

A copy session with a real trap: one of the three notes is recorded in `CLAUDE.md` as having been
deleted on 2026-07-27 after the operator rejected the page. It is alive and rendering. Runs FIRST in
this wave because two other sessions want this file later.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 2/10

You are running P4-45 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== WHAT THIS SESSION IS ===
Four user-visible-text defects, three from the UX audit
(`docs/migration/reviews/2026-07-31-app-ux-gap-audit.md`, finding 26c) and one left open by TRANCHE
H. No behaviour changes. Re-verify every anchor before editing (verified at tip `39351bd`,
2026-07-31). **Your report MUST name, in one line, the contract or rule each change satisfies** — for
this session that is CLAUDE.md §7, quoted below, and you should be able to say which clause each edit
answers.

=== THE RULE YOU ARE ENFORCING (CLAUDE.md §7, verbatim) ===
Anything a user can read on screen: JSX text, `desc`/`title`/`placeholder`, `aria-label`, toasts,
disabled-reasons, empty states, console warnings.

> - **No em dash (—) in any of it. Ever.** Rewrite the sentence: split it in two, or use a comma or
>   colon. This includes the `'—'` no-value placeholder (write `none`) and ` — ` as an aria-label
>   separator (write `, `).
> - **Never render engineering notes.** No `file.ts:123` citations, no session ids (`P4-6b`,
>   `CC-19`), no internal vocabulary (read seam, write allowlist, sidecar review, registry row,
>   host-API gap, `MAX_*` constant names). A deviation belongs in your report and the STATUS row,
>   which is what §9 asks for; a component that exists to print your to-do list on the page is the
>   bug (`DeferredNote`, deleted 2026-07-27 after the operator rejected the page).
> - **Say only what is surprising.** Restating the state the user just chose is noise; spend prose on
>   what contradicts it.
> - Tell the user what to DO ("Change it from the CLI"), not why we have not built it ("needs a
>   recorded permission-boundary review").

=== THE FOUR DEFECTS (source-verified 2026-07-31, re-verify) ===

**1. `DeferredNote` is alive.** `app/renderer/src/SettingsExtensions.tsx:104` defines it; two call
sites render it: `:137-140` on the MCP panel ("Shown from configuration only. Connection status, and
connect / authenticate / remove, are not available here yet.") and `:219-222` on Plugins ("Browsing
and installing are not available here. Install plugins from the terminal."). **CLAUDE.md §7 names
this component as deleted on 2026-07-27 after the operator rejected the page, and it is rendering.**
Either the deletion never landed or it came back; establish which if it is cheap, and say so. Both
strings explain what we have not built; one of them also tells the user what to do instead, which is
the half worth keeping. If both call sites lose their prose, delete the component too — a helper that
exists to print roadmap notes should not survive to be reused.

**2. `SystemNoticeBox` prints its discriminant.** `TranscriptView.tsx:1972-1992` renders, on every
projected notice row, a trailing `<span>{noticeType}</span>` — literally `api_retry`,
`local_command_output` or `account_diagnostic` on the app's most-read surface. It is a debug tag. The
glyph and tone already distinguish the three (`NOTICE_STYLE`, `:1996-2003`). Decide between removing
it and replacing it with something a user would recognise, and say which and why.

**3. `ImageResultBody` renders a roadmap note.** `TranscriptView.tsx:1429-1447` prints
`inline image tile pending a projector image-payload seam` beneath every successful image result.
"Seam" is internal vocabulary and the sentence is a to-do item. The result text above it already says
what happened.

**4. Two buttons, one label — TRANCHE H's open §0.** `ToolInspectorLaunch` (`:988-999`, the tool
card's footer) and `InlineRevealBand` (`:1457-1497`, the truncation band P4-36 added) both render
`Open full output ↗`, in the same card, with the same styling. P4-36 raised this as OPEN and
UNAPPROVED and proposed relabelling the FOOTER to the prototype's `Inspector`
(`~/catcode_prototype/cat-app/Messages.jsx:563` footer vs `:566` band). It assigned the fix to P4-37,
which finished without taking it (P4-36 was still live in the file) and handed it to whoever next
owns this file. **That is you, and the proposal is still a proposal:** verify the prototype
distinction yourself, decide, and state what you chose. Note that `TranscriptView.test.tsx:1189` and
`:1394` both assert `'Open full output'` — work out which button each covers before you touch either
label, or you will make one of them pass for the wrong reason.

=== SCOPE — READ THE FENCE ===
IN: the four above, in `TranscriptView.tsx` and `SettingsExtensions.tsx` only. If removing a note
leaves an empty wrapper, remove the wrapper. Extend the existing user-visible-text tests
(`userVisibleText.test.ts` is the enforcement point for the em-dash rule) or the surface's own SSR
tests so each removal is pinned — a note nobody tests is a note that comes back.

OUT: any behavioural change, any restyle, any new component, and every other §7 offender in the app.
In particular `ConnectionRecovery`'s `Session {status}.` copy is the same class and is **P4-49's**
this wave, not yours.

**File fence.** You own `TranscriptView.tsx` and `SettingsExtensions.tsx`. Nothing else. If your §7
sweep finds more of this class in files you do not own, **list them in your report with anchors and
do not fix them** — an unowned finding recorded is a finding that gets a session; an unowned finding
fixed inside someone else's live file is TRANCHE H's false-red story repeating.

=== GROUND RULES ===
Renderer-only, copy-only. No new inbound vocabulary, no preload channel, no protocol change; security
baseline untouched (T4/T5a/T6/T7 + HC1-HC4). This surface renders untrusted tool output: everything
stays a text node. `app/` is strict. No new deps. Branch `migration`, commit your own explicit paths,
never `git add -A`.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (baseline 2026-07-31 at tip `39351bd`: **2087 pass / 0 fail**) ·
`bunx tsc --noEmit -p app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar` zero new owned
· `bun run --cwd app test:hardening` 19/19 · `bun run --cwd app renderer:build` ok. Also run
`rg -n '—' app/renderer/src --glob '!*.test.*'` and confirm every remaining hit is a code comment.

Report: the one-line rule statement per change (required); your decision on the duplicate label with
the prototype evidence you checked; whatever you established about `DeferredNote`'s supposed 2026-07-27
deletion; and any further §7 offenders you found but did not touch. Ledger: update only the rows your
change makes wrong — §05 for the notice and image rows, §25 for the extensions panels. Touch no other
ledger row and not the Part D totals. Update your STATUS row last — re-read `STATUS.md` immediately
before writing and touch only your own row.
```
─── PASTE ───


## P4-46 · ⬜ — The window has no minimum size (audit 26a)

One line in the main process, and one number that must be derived rather than chosen by feel. The
audit's own claim that things clip is explicitly UNVERIFIED, so the operator step is the evidence.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 2/10 · 🖐 GUI

You are running P4-46 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== THE AUDIT PROPOSES; YOU DERIVE ===
From `docs/migration/reviews/2026-07-31-app-ux-gap-audit.md`, finding 26a. Its defect claims survived
six adversarial review rounds; its fixes often did not. **This one ships with its UNVERIFIED tag
intact:** the audit states plainly that "actual clipping behavior at narrow widths was not observed".
Re-verify every anchor before building. **Your report MUST name, in one line, the contract or
constraint your number satisfies.**

=== THE DEFECT (source-verified 2026-07-31, re-verify) ===
`app/main/main.ts:684-690` constructs the one `BrowserWindow` with `width: 1100, height: 720` and no
`minWidth` / `minHeight`. The window can therefore be dragged to any size the platform allows, over a
renderer that is largely non-responsive: responsive prefixes appear in only six files (all
`sm:grid-cols-*`), and several columns do not shrink.

=== DERIVE THE NUMBER, DO NOT PICK IT ===
A minimum window size is a claim about the widest thing that must stay usable. Find the real
constraints in source and name the binding one in your report. Known non-shrinking chrome to check,
and re-verify each: the Settings rail is `w-[240px] shrink-0` (`SettingsShell.tsx:294`), the session
actions menu is a fixed `w-[232px]` panel (`SessionActionsMenu.tsx`), the sidebar has an expanded
width, and the transcript column is centre-constrained (P4-24). Height has its own floor: the
composer, the tab bar and at least a few transcript rows have to coexist.

A number derived from the layout is defensible and re-derivable when the layout changes. A number
chosen because it looks about right is neither, and this is the kind of constant that survives
untouched for years.

=== SCOPE — READ THE FENCE ===
IN: `minWidth` / `minHeight` on the window, and a test if the construction is reachable by one
(check how `app/main` is tested today before promising one; if it is not testable, say so plainly
rather than inventing a harness).

OUT: the default `width`/`height`, window position or state persistence, any responsive CSS work
(that neighbours audit 26b, the light-theme and responsiveness item, which is bucket-C and unowned),
and every `webPreferences` key.

**File fence.** You own `app/main/main.ts`. Nothing in `app/renderer/` is yours this wave.

**This file is the BrowserWindow security surface** (`decisions/SECURITY-MINIMUM.md` §3: sandbox,
contextIsolation, nodeIntegration off, webviewTag off, webSecurity on, the preload path, the CSP
header). Touch none of it, and prove it with `test:hardening` all-pass.

=== GROUND RULES ===
Main-process only. No new inbound vocabulary, no preload channel, no protocol change. `app/` is
strict. No new deps. Branch `migration`, commit your own explicit paths, never `git add -A`.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (baseline 2026-07-31 at tip `39351bd`: **2087 pass / 0 fail**) ·
`bunx tsc --noEmit -p app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar` zero new owned
· `bun run --cwd app test:hardening` 19/19.

GUI (operator's — STOP and print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use
the P3-H harness, then WAIT; NO automation): drag the window to its new floor and confirm it stops
there; at that size, open Settings, open the sidebar, open a session actions menu and read a
transcript row, and confirm nothing is clipped or unreachable. **Ask the operator to say what DID
clip before the change if they still have a pre-fix build** — that is the audit's open question and
this session cannot answer it. Migration test turns use `gpt-5.6-luna` at low effort on a healthy
account.

Report: the one-line constraint statement (required), the binding constraint with its `app/…:line`,
and an explicit UNVERIFIED line naming what the operator step is expected to settle. Ledger: if no row
covers window sizing, say so rather than inventing one. Touch no ledger row you did not make wrong and
not the Part D totals. Update your STATUS row last — re-read `STATUS.md` immediately before writing
and touch only your own row.
```
─── PASTE ───


## P4-47 · ⬜ — Retention `0` destroys history silently (audit 5a) **+** the Remote rail advertises a cut SSH mode (26d)

The most destructive unbuilt item in the wave. P4-41 correctly excluded it from its scope, which left
it unowned. It carries a second, unrelated one-line copy fix **only** because both write
`settingsScope.ts` and this tranche allows one live session per file.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 5/10 · 🖐 GUI

You are running P4-47 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

Two items, one session. **They are unrelated**; they share this session only because both touch
`app/renderer/src/settingsScope.ts` and this tranche permits one live session per file. Item B is one
line. Do not let it ride along unfinished behind item A.

=== THE AUDIT PROPOSES; YOU DERIVE ===
From `docs/migration/reviews/2026-07-31-app-ux-gap-audit.md`, findings 5a and 26d. Defect claims
survived six adversarial review rounds; proposed fixes often did not — **finding 5a's own history is
the cautionary tale of this whole audit**: rev 1 called it a copy mismatch, rev 2 "corrected" that in
the dangerous direction by declaring existing rows unaffected, rev 3 reversed rev 2 with engine
citations, rev 4 proposed a bounded enum, and rev 5 withdrew the enum. Re-verify every anchor before
building (verified at tip `39351bd`, 2026-07-31). **Your report MUST name, in one line, the contract
or call path your fix satisfies.**

=== ITEM A — THE DEFECT (source-verified 2026-07-31 against the ENGINE, re-verify) ===
`cleanupPeriodDays = 0` does not merely stop future writes. The engine's own schema says so:

> "Number of days to retain chat transcripts (default: 30). Setting to 0 disables session persistence
> entirely: no transcripts are written and existing transcripts are deleted at startup."
> — `src/utils/settings/types.ts:325-332`

and `getCutoffDate()` multiplies the period by a day in ms (`src/utils/cleanup.ts:24-31`), so `0`
yields a cutoff of *now* and startup cleanup sweeps everything.

The desktop makes that reachable by typing a digit and clicking away. `IntField`
(`app/renderer/src/SettingsEditors.tsx:452-519`) commits on `onBlur` and on Enter, with no
confirmation of any kind. The consequence lands on the NEXT launch, far from the action that caused
it, and it is not recoverable.

**What changed since the audit was written:** P4-41 landed, so an engine settings key can now be
cleared from the UI (`value: null` is the clear request; `selectSettingsReset` decides the
affordance). Check what that means for this field before designing: the choice is now reversible
BEFORE the next launch, which is exactly the pairing the audit's finding 15 asked for, and it may
change what your confirmation needs to say.

=== ITEM A — THE FENCES, WHICH ARE THE POINT ===
- **Do NOT narrow the domain.** A 30 / 60 / 90 / Forever enum was proposed and **rejected twice**
  (audit rev 5; coverage document bucket B-rejected). The registry declares
  `{ kind: 'int', min: 0, max: 3650, default: 30 }` (`app/shared/settingsEditable.ts:235-241`), so an
  enum deletes every legitimate value in between (7, 45, 365) and `Forever` has **no wire
  representation at all**. Do not resurrect it in any form.
- **Do NOT touch P4-41's generic reset.** It landed days ago and every key uses it.
- **Do NOT add a second sentinel.** `null` already means "clear this key" (P4-41). `0` is a
  legitimate value that means "keep nothing". Those must stay distinguishable end to end; say how in
  your report.
- **`IntField` is generic over every int key.** A hardcoded `keyName === 'cleanupPeriodDays'` branch
  in a shared control is the cheap answer; a declared property of the key is the honest one. If you
  put it in `app/shared/settingsEditable.ts`, that file is **shared with the sidecar and is part of
  the validation boundary** — the addition must be display-only, must not change what
  `validateEditableSettingValue` accepts or rejects, and you must prove that with the existing
  boundary tests. State which home you chose and why.

Questions your report must answer, from source: does the confirmation fire on the blur path, the
Enter path, or both? What does Cancel leave in the field (leaving `0` visible after a cancelled
confirm is its own bug)? Does the persistent warning the audit asks for belong in `settingsRowNote`
(`settingsScope.ts:900`), which already exists to say only what is surprising, or on the control?
`SAModal` (`app/renderer/src/SAModal.tsx`, P4-30) is the app's shared modal — use it rather than
inventing a dialog.

**User-visible text (CLAUDE.md §7)** applies to every string here: no em dash; no key names, no
"engine", no internal vocabulary; tell the user what will happen and what to do. The audit's sentence
("Past sessions will be deleted the next time the app starts, and cannot be restored") is a starting
point, not approved copy — it has to name a consequence the user recognises, in this app's voice.

=== ITEM B — THE REMOTE RAIL ADVERTISES A CUT FEATURE (26d) ===
`app/renderer/src/settingsScope.ts:333-336` describes the Remote category as
`'Saved SSH environments and the Remote Control bridge'`. There are no saved SSH environments:
`decisions/PAIRED-DEVICES.md` §1-§3 cut the SSH connect mode and the device roster, and
`RemoteSettingsSnapshot` carries only `bridge` and `commandFilter`, so nothing of the sort crosses the
wire. The rail promises a pane that cannot exist.

**This is copy only, and it does not reopen the cut.** It was mis-filed in TRANCHE H's register as
awaiting an operator ruling; aligning a description with a decided cut is not a reversal of it. Do not
build an SSH surface, do not touch the wire, do not touch `RemoteSettingsPage.tsx`. Describe what the
pane actually offers.

=== SCOPE — READ THE FENCE ===
IN: item A's confirmation, its persistent warning, and its tests; item B's one description string.

OUT: any other settings key, any change to precedence or to the write path, the editor's layout, and
anything in the Remote pane beyond the rail description.

**File fence.** You own `SettingsEditors.tsx`, `settingsScope.ts`, and `app/shared/settingsEditable.ts`
if you choose that home for the destructive-value declaration. You do NOT own `App.tsx`,
`SettingsShell.tsx` beyond a mount you cannot avoid (say so if you need it), or anything in the
transcript.

**The confirmation is an interaction, and the `app/` renderer suite is SSR-only** — it cannot click a
button or fire a blur. Put the decisions in pure exported helpers (is this key's value destructive;
what does the confirm say; what does cancel restore) with unit tests, and keep the DOM layer thin.
Green tests are not evidence that the dialog appears.

=== GROUND RULES ===
Renderer-side over the EXISTING settings write path. No new inbound vocabulary, no preload channel, no
protocol change; the sidecar remains the trust boundary and its validation is unchanged. Security
baseline untouched (T4/T5a/T6/T7 + HC1-HC4). Preserve the `SettingsUpdater`-under-lock FUNCTION form
(the P3-5a/DR-2 no-lost-update fix) — you should not be near it, and if you are, stop. `app/` is
strict. No new deps. Branch `migration`, commit your own explicit paths, never `git add -A`.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (baseline 2026-07-31 at tip `39351bd`: **2087 pass / 0 fail**) ·
`bunx tsc --noEmit -p app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar` zero new owned
· `bun run --cwd app test:hardening` 19/19 · `bun run --cwd app renderer:build` ok.

**Invoke the `verifying-cat-code-changes` skill**; paste the filled **FIDELITY** block and the
**SURFACE ACCEPTANCE** tiered verdict.

GUI (operator's — STOP and print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use the
P3-H harness, then WAIT; NO automation): in Settings, type `0` into transcript retention and click
away; confirm a dialog names the consequence, that cancelling leaves the previous value in the field,
and that confirming leaves a visible warning while the value is `0`. Then confirm the value can be
undone from the UI. **Do not ask the operator to leave `0` committed and relaunch** — that would
delete their real transcripts. Also confirm the Remote rail description matches the pane. Migration
test turns use `gpt-5.6-luna` at low effort on a healthy account.

Report: the one-line contract statement per item (required); where the destructive-value rule lives
and why; the `0`-versus-`null` distinguishability argument; and the exact copy you shipped. Ledger:
§11's retention row (`Privacy ▸ Conversation retention select`, currently 🔁 adapted over `IntField`)
and whichever row records the Remote rail description — if none does, say so rather than inventing
one. Touch no other ledger row and not the Part D totals. Update your STATUS row last — re-read
`STATUS.md` immediately before writing and touch only your own row.
```
─── PASTE ───


## P4-48 · ⬜ — The launcher never tells a first-run user what to do first (2a, ruled 2026-07-31)

Copy on the launcher, and nothing else. The ruling is unusually explicit about what it does NOT
authorize, because the audit's own proposal here was withdrawn for manufacturing a dead end.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 3/10 · 🖐 GUI

You are running P4-48 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== THE RULING AND ITS BOUND (quoted verbatim — do not paraphrase, do not exceed) ===
`decisions/STARTUP-GATES.md` §1.2, the 2026-07-31 clarification:

> **Ruled: fix discoverability, not architecture.** The launcher tells the user what to do first so
> the sequence is visible rather than guessed. Per-session-create trust is unchanged; account writes
> stay session-scoped; no host-plane account-write path is authorized by this ruling. Explicitly NOT
> ruled in: moving the `user` settings scope to a host-plane read. That is architecturally clean (the
> user layer is session-invariant by design, `settingsScope.ts:33`) and is untouched by this ruling,
> but it was not selected and needs its own decision.

The same section records WHY the obvious fix was withdrawn:

> The audit initially proposed reading the global pool instead; that was withdrawn, because account
> **verbs** need an engine process to carry them (`App.tsx:1178` answers with a real `ok:false`
> outcome when there is no session), so exposing sign-in earlier would surface a control with nothing
> behind it.

So: **copy, not a gate.** No sign-in control on the launcher, no host-plane account write, no
session-free settings read.

=== THE DEFECT (source-verified 2026-07-31, re-verify) ===
On a genuine first launch there is no session, so `selectAccountsSnapshot(accounts, activeSessionId)`
returns null (`accountsState.ts:106`), so `shouldShowFirstRunOAuth` (`appModel.ts:14-27`) is
structurally unreachable — it requires a non-null snapshot. The user's only path to signing in is to
guess the sequence: pick a folder, native picker, session spawns, trust gate, and only then does the
sign-in card appear. Nothing on screen suggests any of that. The flow does not hang and the paste-code
and error phases both exist; the gap is that the sequence is invisible.

**You need no new data path, and must not add one.** The launcher already receives a session-free
accounts snapshot: `App.tsx:2907` passes
`accounts={activeAccountsSnapshot ?? selectGlobalAccountsSnapshot(accounts)}` into `WelcomeScreen`.
Whether your copy should be conditional on that snapshot, or unconditional, is yours to derive and
state. If you conclude you need data the launcher is not already given, STOP and report — that is
architecture, which this ruling does not authorize.

=== SCOPE — READ THE FENCE ===
IN: copy on the launcher that makes the first-run sequence visible, in `WelcomeScreen.tsx`.

OUT, each because the ruling says so:
- **Switching `shouldShowFirstRunOAuth` to the global snapshot.** That is precisely the withdrawn
  proposal: a sign-in surface with no process to execute it.
- **Any host-plane account write**, any new verb, any new preload method.
- **The session-free `user` settings read**, and the Settings empty state
  ("No session is open, so your settings files have not been read yet.", `settingsReadState.ts:45`).
  That is finding 2b, a separate bucket-C item explicitly NOT ruled in.
- **The trust gate.** Per-session-create trust is unchanged.

**File fence.** You own `WelcomeScreen.tsx`. Not `App.tsx` (two other sessions are in it this wave),
not `appModel.ts`, not `accountsState.ts`, not `StartupSurfaces.tsx`.

=== USER-VISIBLE TEXT — THIS IS THE DELIVERABLE (CLAUDE.md §7, verbatim) ===
> - **No em dash (—) in any of it. Ever.** Rewrite the sentence: split it in two, or use a comma or
>   colon. This includes the `'—'` no-value placeholder (write `none`) and ` — ` as an aria-label
>   separator (write `, `).
> - **Never render engineering notes.** No `file.ts:123` citations, no session ids, no internal
>   vocabulary (read seam, write allowlist, sidecar review, registry row, host-API gap, `MAX_*`
>   constant names).
> - **Say only what is surprising.** Restating the state the user just chose is noise.
> - Tell the user what to DO ("Change it from the CLI"), not why we have not built it.

A previous session shipped roadmap prose on a settings page and the operator rejected the page on
sight. Write what the user does next, in the order they do it. Do not explain the session model, do
not mention sessions spawning, and do not apologise for the sequence.

=== PROTOTYPE ===
`~/catcode_prototype/cat-app/Startup.jsx:461-489` gates trust and OAuth at app level before any
session exists. **That is the design the ruling declined** — do not port it, do not port its wording,
and do not treat its existence as backing for a control. The prototype has no session concept, so it
cannot inform this at all: your copy is net-new under a ruling. Tag it ➕ real-added (ruled) in your
report and the ledger, not as parity work. The launcher's existing visual grammar
(`WelcomeScreen.tsx`, P4-17, `decisions/WELCOME-LAUNCHER.md`) is the bar: your text lives inside it,
it does not restyle it.

=== GROUND RULES ===
Renderer-only, copy-only. No new inbound vocabulary, no preload channel, no protocol change; security
baseline untouched (T4/T5a/T6/T7 + HC1-HC4) — HC1 in particular: the renderer authors no path, and
"Open folder…" through the native picker stays the only way a cwd is chosen. `app/` is strict. No new
deps. Branch `migration`, commit your own explicit paths, never `git add -A`.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (baseline 2026-07-31 at tip `39351bd`: **2087 pass / 0 fail**) ·
`bunx tsc --noEmit -p app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar` zero new owned
· `bun run --cwd app test:hardening` 19/19 · `bun run --cwd app renderer:build` ok. Also run
`rg -n '—' app/renderer/src --glob '!*.test.*'` and confirm every remaining hit is a code comment.

**Invoke the `verifying-cat-code-changes` skill**; paste the filled **FIDELITY** block and the
**SURFACE ACCEPTANCE** tiered verdict.

GUI (operator's — STOP and print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use the
P3-H harness, then WAIT; NO automation): open the app with no session and read the launcher as a
first-time user would. The question to answer is whether the next action is now obvious without
prior knowledge. If the operator can stage a no-account state safely, ask whether the copy still reads
correctly there; **do not ask them to remove a real account to test it.** Migration test turns use
`gpt-5.6-luna` at low effort on a healthy account.

Report: the one-line contract statement (required); the exact copy you shipped; whether it is
conditional on the accounts snapshot and why; and an explicit statement that no account verb, no new
data path and no settings read were added. Ledger: §29 Welcome rows — add or update only what your
change makes wrong, tagged ➕ real-added (ruled). §29 is recorded CLOSED in Part C; do not reopen its
count. Touch no other ledger row and not the Part D totals. Update your STATUS row last — re-read
`STATUS.md` immediately before writing and touch only your own row.
```
─── PASTE ───


## P4-49 · ⬜ — No connection tone grammar, and the bar prints a raw status word (24b, ruled 2026-07-31)

Builds directly on P4-35, which landed the terminal-vs-transient partition this session should
consume rather than re-derive. It also picks up the one §7 offender P4-35 fenced out as not-its-own.

─── PASTE ───
```
🧠 Model: ANY · Difficulty: 3/10 · 🖐 GUI

You are running P4-49 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.

=== THE RULING AND ITS BOUND (quoted verbatim — do not paraphrase, do not exceed) ===
From the Operator rulings section of
`docs/migration/reviews/2026-07-31-app-ux-gap-prototype-coverage.md`, canonical for this ruling:

> **24b connection tone — Minimal two-tone, no chip.** Transient states read neutral or warn;
> terminal states read danger. No dot, no chip, no restored `ConnectionChip.tsx`. Enough grammar that
> the next transient cannot present as a failure, and no more.

`ConnectionChip.tsx` was deleted by CC-5 ruling #6 and **stays deleted**. "Enough grammar and no
more" is the whole bound: a partition and two tones, not a vocabulary.

=== THE STATE OF PLAY (source-verified 2026-07-31, re-verify) ===
P4-35 landed hours ago and changed the ground under this finding. `ConnectionRecovery`
(`app/renderer/src/App.tsx:4034-4068`) now returns null unless
`isTerminalConnectionStatus(connection.status)` (`connectionState.ts:55-73`), a shared partition with
its own exhaustiveness tripwire whose agreement with `resolvePendingSubmit` is pinned by
`connectionState.test.ts`. So a `starting` session no longer paints a red failure bar.

**What is still missing is what 24b is about:** the app has no tone grammar for a connection state at
all. The next transient state anyone adds inherits whatever its author picks, which is how `starting`
became a red failure in the first place. Consume P4-35's partition — do not re-derive the
classification, do not create a second list that can drift from it, and keep its tripwire and its
pinned agreement green.

=== YOUR SECOND, FENCED-IN ITEM: THE COPY ===
`ConnectionRecovery` renders `<span>Session {connection.status}.</span>`, so a user reads
`Session dead.` or `Session exited.` — the engine's own discriminant, printed at them. P4-35 fenced
this out explicitly and correctly ("Real, and NOT yours: it is audit finding 26c's class"). **It is
yours**, because you are already rewriting this component's presentation and no other session owns
this string: P4-45 owns three different instances of the same class in files you do not touch. Map
each terminal status to a sentence the user can act on, next to a Restart button that already exists.

**User-visible text (CLAUDE.md §7):** no em dash; no engineering vocabulary or discriminants; say only
what is surprising; tell the user what to DO. Check with
`rg -n '—' app/renderer/src --glob '!*.test.*'` and confirm every remaining hit is a code comment.

=== SCOPE — READ THE FENCE ===
IN: a two-tone derivation over the connection status union, consumed by the connection surface; the
per-status copy above; unit tests over the derivation covering every member of the union (the union is
`'connecting' | 'starting' | 'ready' | 'dead' | 'disconnected' | 'failed' | 'exited'`,
`connectionState.ts:8-16` over `protocol.ts`).

OUT, each with its reason:
- **Any dot, chip, pulse, ring, or four-state vocabulary**, and any restoration of
  `ConnectionChip.tsx`. The ruling names all of them.
- **`sessionStatusVisual.ts`, `tabStatus.ts`, the TabBar and the Sidebar.** Audit finding 4 (a working
  indicator on tabs) is unowned, and the sidebar's live dot is **P4-44's** this same wave. Two
  sessions editing one tone vocabulary is how a two-tone bound becomes a four-state one by accident.
- **The composer gate and the parked-prompt path.** `resolvePendingSubmit` already partitions this
  union for a different purpose; agree with it, do not touch it.

**File fence.** You own `App.tsx`'s `ConnectionRecovery` region and `connectionState.ts`. Two other
sessions want `App.tsx` after you (P4-50, then P4-43), so commit promptly and keep your diff inside
that region.

=== GROUND RULES ===
Renderer-only. No new inbound vocabulary, no preload channel, no protocol change; security baseline
untouched (T4/T5a/T6/T7 + HC1-HC4). `app/` is strict — a closed union gets a compile-time
exhaustiveness tripwire (`default` case assigning to `never`), which is how P4-35 built its partition
and how yours should agree with it. No new deps. Use static Tailwind classes, never interpolated
arbitrary values. Branch `migration`, commit your own explicit paths, never `git add -A`.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (baseline 2026-07-31 at tip `39351bd`: **2087 pass / 0 fail**) ·
`bunx tsc --noEmit -p app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar` zero new owned
· `bun run --cwd app test:hardening` 19/19 · `bun run --cwd app renderer:build` ok.

GUI (operator's — STOP and print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use the
P3-H harness, then WAIT; NO automation): stage a terminal connection state (the harness's own kill
path is the honest way; the operator should not be asked to kill processes by pattern) and confirm the
bar reads as a failure with a sentence rather than a status word, and that Restart still works. If a
transient state can be observed at all, confirm it does not read as a failure. **Say plainly in your
report which states the operator can realistically stage and which cannot be exercised**; an
unstageable state is UNVERIFIED, not passed. Migration test turns use `gpt-5.6-luna` at low effort on
a healthy account.

Report: the one-line contract statement (required); the exact copy per terminal status; and how your
derivation is pinned to P4-35's partition so the two cannot drift. Ledger: §01's
`Connection→banner injection effect` row (🔁 adapted, evidence `App.tsx:1059`) and §12's
`ConnectionChip: hidden when healthy` row, which P4-35 re-anchored. Update only what your change makes
wrong. Touch no other ledger row and not the Part D totals. Update your STATUS row last — re-read
`STATUS.md` immediately before writing and touch only your own row.
```
─── PASTE ───


## P4-50 · ⬜ — Account health surfaces only inside the scrolling transcript (O2a, ruled 2026-07-31)

The ruling turns a two-year-old built-and-unused primitive into its first production mount. Its bounds
exist because the previous version of this surface was a wall the operator removed; every clause of
the quote below is a thing that made it a wall.

─── PASTE ───
```
🧠 Model: CLAUDE (visual-design) · Difficulty: 5/10 · 🖐 GUI

You are running P4-50 of the CatCode desktop-app migration (~/cat-code, branch `migration`).
Echo the header line above back to the operator before starting.
Run AFTER P4-49 (it is live in `App.tsx`).

=== THE RULING AND ITS BOUND (quoted verbatim — do not paraphrase, do not exceed) ===
`decisions/STARTUP-GATES.md`, the 2026-07-31 revision of ruling #12:

> **Ruled:** account/quota diagnostics get a **pinned, dismissable, non-blocking** surface above the
> transcript, mounting the already-built `BannerStack` (`app/renderer/src/BannerStack.tsx`, currently
> zero production importers). Constraints that make this compatible with #12 rather than a reversal
> of it: it never blocks submit, it is always dismissable, it carries no re-auth wall semantics, and
> it does not reintroduce `ReauthWall.tsx` or `reauthBannerState.ts`. Scope is **account health
> only** — shell lifecycle errors are a separate surface and a separate finding (audit finding 8); do
> not merge the two error classes into one banner plane.

#12 itself is unchanged and still binding: no wall, no submit block, a send at zero-healthy proceeds
and fails naturally at request time with the engine's own typed pool error.

=== THE DEFECT (source-verified 2026-07-31, re-verify) ===
Quota exhaustion surfaces only as a grey `account_diagnostic` notice INSIDE the scrolling transcript
(`TranscriptView.tsx`, `SystemNoticeBox`), so it scrolls out of view while subsequent turns keep
failing at request time. The user sees repeated failures with the explanation somewhere above.

=== WHAT ALREADY EXISTS — REUSE IT, DO NOT REBUILD IT ===
- **The primitive.** `BannerStack.tsx` (P4-1) with tones, actions, and a dismiss that hides when
  `dismissable === false`. `bannerStackModel.ts` is its pure, tested stacking model
  (`upsertBanner` / `dismissBanner` / `useBannerStack`). Ledger §05 records `BannerStack` as ⬜
  deferred with **zero production importers** — this session is that importer.
- **The derivation, with real copy and real actions.** The Accounts page already derives a usage-cap
  banner from the same domain: `AccountsPage.tsx:896-935` renders `{alias}: usage limit reached` with
  Switch / Resets / Dismiss, over `selectCapAccount` (`accountsState.ts:184`). **Reuse that
  derivation.** Two disagreeing account-health models on two surfaces is worse than one surface.
- **The data, session-free.** `AccountsSnapshot` (`app/shared/protocol.ts:1705-1733`) carries
  `readyCount`, `poolCount`, and the Anthropic-pool equivalents; `selectGlobalAccountsSnapshot`
  (`accountsState.ts:152`) already gives a session-free read. **No new seam, no new frame, no new
  preload method** — if you think you need one, you have left the scope.

=== THE DECISIONS THAT ARE ACTUALLY YOURS ===
State each in your report, with its reasoning:

1. **Which account-health states earn a pinned banner at all.** Not every degradation is worth
   interrupting for. "Say only what is surprising" (CLAUDE.md §7) applies to a banner more than to any
   other surface in this app.
2. **What dismissal means.** The deleted implementation used
   `localStorage['catcode:dismissedReauth']` keys; #12 deleted them and you must not reintroduce
   them. Decide the lifetime: a banner that returns on the next frame is nagware, and one that never
   returns after the state changes is a silent failure. Say which failure you chose to avoid and how.
3. **What happens to the transcript notice.** It stays where it is — another session (P4-45) is
   editing that file this wave. If the same fact now appears in two places, that is a design choice
   you state explicitly, not one you stumble into.
4. **What the actions do.** Switch and Resets already exist on the Accounts page; a banner action that
   navigates rather than acts is a legitimate answer. An action that needs an account verb needs a
   session, and account writes stay session-scoped (`decisions/STARTUP-GATES.md` §1.2) — so a banner
   with no session must not offer one.

=== SCOPE — READ THE FENCE ===
IN: the derivation from the accounts domain, the mount above the transcript, dismissal, and unit tests
over the derivation (which snapshot yields which banner, and which yields none).

OUT, each with its reason:
- **Shell lifecycle errors.** The transport-error bar (`App.tsx:2722`) has seven writers and is audit
  finding 8, unowned. The ruling names it as a separate surface. Do not route it here, and do not
  "improve" it in passing.
- **`ReauthWall.tsx` / `reauthBannerState.ts` / `selectReauthWall` / `selectVisibleReauthBanners` /
  `selectAuthSubmitBlocked`.** Deleted by #12. Do not recreate any of them under a new name.
- **Any submit gate.** The composer send is never disabled by account health. If your change can
  disable a send, it is wrong.
- **The Accounts page itself.** You read its derivation; you do not restyle it.

**File fence.** You own the banner region of `App.tsx` and whatever new derivation module you add.
P4-49 is in `App.tsx` before you and P4-43 after you: confirm P4-49 has landed and the file is clean
before starting, and commit promptly. You do not own `TranscriptView.tsx` (P4-45),
`AccountsPage.tsx`, or `accountsState.ts` beyond adding a selector if the existing ones do not fit.

=== PROTOTYPE ===
There is **no prototype design for a non-blocking quota surface** — the prototype's answer was the
blocking `ReauthGate` that #12 removed, and its `MOCK_BANNERS` fixture is empty
(`~/catcode_prototype/cat-app/data.js:3439`). The visual grammar you follow is `BannerStack`'s own,
already built to the prototype's banner rows (`Surfaces.jsx:786-833`). Tag the surface ➕ real-added
(ruled) rather than claiming parity. Port ZERO prototype code; no inline `style={{}}`; beware the
dynamic-class trap.

**User-visible text (CLAUDE.md §7):** the banner's title, detail and action labels are all deliverables
here. No em dash. No engineering vocabulary, no discriminants, no `MAX_*` names, no session ids. Tell
the user what to DO, not why the state exists. Say only what is surprising: a banner restating that
they are signed in is noise.

=== GROUND RULES ===
Renderer-only over existing seams. No new inbound vocabulary, no preload channel, no protocol change.
Security baseline is a hard gate (T4/T5a/T6/T7 + HC1-HC4): account status reaching the renderer is
redacted by `secretGuard` on outbound frames and **no credential material may appear in a banner** —
not an alias-plus-token, not an error body echoed verbatim. Banner text is untrusted status text and
renders as text nodes, which `BannerStack.tsx:10` already documents. `app/` is strict. No new deps.
Branch `migration`, commit your own explicit paths, never `git add -A`.

=== DELIVERABLE / DONE WHEN ===
`bun test app/` green (baseline 2026-07-31 at tip `39351bd`: **2087 pass / 0 fail**) ·
`bunx tsc --noEmit -p app/tsconfig.json` clean · `bun run --cwd app typecheck:sidecar` zero new owned
· `bun run --cwd app test:hardening` 19/19 · `bun run --cwd app renderer:build` ok.

**Invoke the `verifying-cat-code-changes` skill**; paste the filled **FIDELITY** block and the
**SURFACE ACCEPTANCE** tiered verdict.

GUI (operator's — STOP and print exact steps per `docs/migration/process/GUI-VERIFICATION.md`, use the
P3-H harness, then WAIT; NO automation): the honest step is to confirm the banner does NOT appear on a
healthy pool, that it does not move or block the composer, and that dismissing it leaves the app
usable. **A capped account is expensive to stage on purpose; do not ask the operator to burn quota.**
If the harness can inject a snapshot, that is the route; otherwise state plainly that the capped-state
render is UNVERIFIED and covered only by unit tests over the derivation. Migration test turns use
`gpt-5.6-luna` at low effort on a healthy account.

Report: the one-line contract statement (required); the four decisions above with their reasoning; the
exact banner copy; and an explicit statement that submit is never gated and that no wall file was
recreated. Ledger: §05's `BannerStack (session banners with action/dismiss)` row (⬜ deferred, zero
production importers) and §12's BannerStack rows. Update only what your change makes wrong. Touch no
other ledger row and not the Part D totals. Kill any sidecar you spawn. Update your STATUS row last —
re-read `STATUS.md` immediately before writing and touch only your own row.
```
─── PASTE ───
