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
- **PARITY LEDGER (CC-1 — see STATUS.md top).** A whole-prototype coverage ledger
  (`docs/migration/PARITY-LEDGER.md`, element/UX-state + flow granularity) is being built to catch
  silently-dropped prototype elements (the Tranche-A fidelity gap). **Once it exists, your DONE-WHEN
  includes appending/updating your surface's ledger rows** (each tagged built / adapted(why) /
  real-added / deferred(owner) / cut(reason) / ❓missing). Until it lands, keep every §0 cut or
  adaptation as an explicit flagged line so the ledger backfill captures it. NEVER silently drop a
  prototype element — an un-flagged omission is the exact failure the ledger exists to prevent.
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

## P4-7 · 🟡 — Agents config (AgentsPage)

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

## P4-11 · 🟢 — PlanBar / PlanPanel

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
Step 1 (UX spec + VISUAL BAR): ~/catcode_prototype/cat-app/SettingsExtensions.jsx.

=== BUILD ===
- Recon each real domain (MCP config `src/services/mcp*`/config; plugins; skills registry; hooks
  config + outcomes; elicitation flow — cite src:line, re-verify). Render each over real scoped
  state via P4-3's Field/SourceBadge; the prototype's flattened scope + faked hook outcomes →
  render real scope, flag the flattening. Read-seam per the P4-5 recipe.
- `ElicitationDialog` maps to the real elicitation request flow (recon; if it's a control
  request/response, treat it with the permission-round-trip rigor — flag if so).

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

## P4-14 · 🟢 — Diagnostics + WorkspaceTrust sections

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
