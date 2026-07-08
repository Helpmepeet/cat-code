# CatCode migration — PARITY LEDGER (CC-1)

**Landed 2026-07-07.** Element/UX-state + cross-surface-flow coverage over **all 30 prototype
surfaces** (`~/catcode_prototype/cat-app/*.jsx`, ~15.5k lines) and **8 user flows**. Built by a
2-stage adversarial fan-out (one analyst per surface/flow enumerates every element with an
evidence-backed disposition; an **independent auditor** then re-opens every cited `app/…:line` to
confirm each ✅, re-hunts every ❓ for a backlog owner, and sweeps for missed elements). Every
disposition cites real source or a decision doc — **none is guessed**. Provenance:
`scratchpad/parity` workflow run `wf_6d157474-84b`; ~1,900 rows, 68 verified agents.

## Why this exists

Surface-level tracking (`INVENTORY.md`) counts *surfaces*, not *elements*. On 2026-07-07 the Sidebar
was marked ✅ and passed a GREEN review, yet a live compare found it had silently dropped 4 chrome
items and a whole feature class (session titles). The function-only gates through Phase 3 let
elements and flows fall through invisibly. **This ledger is the element-granularity instrument that
makes "did we silently drop a prototype element?" answerable, and makes the Phase-4 "feature parity"
gate measurable.** Its load-bearing output is **Part C — the ❓ missing-no-owner danger list**: every
prototype element that is neither built, nor owned by a backlog session, nor consciously cut. That
column must be driven to empty or explicitly waived before the Phase-4 gate.

## How to read a row

Each surface/flow is a table of elements. **Disposition** is exactly one of:

| Tag | Meaning | Evidence required |
|---|---|---|
| ✅ **built** | implemented in the real app | a real `app/…:line` that renders/handles it |
| 🔁 **adapted** | built, but real shape/behavior differs from the prototype (source wins) | `app/…` + the `src/…` real shape, with the *why* |
| ➕ **real-added** | exists in the real app/engine, **not** in this prototype surface | the real `app/…`/`src/…` capability |
| ⬜ **deferred** | not built yet, but a **named owner** exists | a `phase4.md` P4-N session (or STATUS row) |
| ✂️ **cut** | decided **not** to migrate | a `decisions/*.md`, an INVENTORY CUT row, or a §0 flag |
| ❓ **missing-no-owner** | neither built, owned, nor cut — **the danger list** | — (this is the finding) |

A dropped **mock fixture field** (a prototype `cost`/`model`/`tags` value with no engine backing) is
✂️ cut or 🔁 adapted **with a flag** — *not* ❓; ❓ is reserved for a dropped **visual/UX element or
capability**. Over-flagging ❓ is safe by design; a false ✅ is the failure mode this ledger prevents.

## Headline — parity snapshot

**1,894 rows** (1,724 surface + 170 flow). In-scope prototype-parity elements (built + adapted +
deferred + ❓; excludes ✂️ cut and ➕ real-added) currently sit at the realization level computed in
**Part D**. The Phase-4 gate target is ~80%.

**The ❓ danger list = 126 items** (120 surface + 6 flow). It concentrates in the two layers the
Phase-4 backlog does **not** reach:

- **Transcript / tool rendering — `Messages.jsx`: 49 ❓.** The projector derives the data but the
  renderer doesn't draw it. Worst: `UserTextRow` is projected (`transcriptProjector.ts:162`) yet
  **dropped at `TranscriptView.tsx:61` — user turns are invisible**. The entire rich tool-card family
  (Bash/FileRead/FileWrite/Diff word-level/Grep/Web/Mcp/Notebook/Lsp/Skill/GenerateImage), thinking
  blocks, and every boundary/seam row are projected-but-not-rendered with no P4/P5 owner.
- **Settings core value-editors — `Settings.jsx`: 40 ❓.** The shell + field/source/managed
  primitives are ✅ built over the live snapshot seam, but every actual control (General/Model/Privacy/
  Theme/Keybindings/IDE/LSP) is stubbed, and **P4-12 owns only the extension panels (MCP/Plugins/
  Skills/Hooks), not the core settings fields.**
- Then: **Chat.jsx activity/streaming visuals (15)**, **Permissions AskUserQuestion flow (7)**,
  PermissionRules (3), CommandPalette/SlashCommandPicker (2 each), MemoryPage (2), and 6 flow-level
  gaps (Part C).

These are not bugs to fix here — they are **ownership decisions to force**: assign each ❓ to a
session (a new transcript-rendering session and a settings-editors session are the two obvious ones)
or waive it explicitly.

**Ownership resolution (2026-07-07 — 126 ❓ → 0 silently unowned).** The two clusters got new owners:
**§5 Messages + §6 Chat activity (64) → P4-18**; **§11 Settings + FLOW-8 + §8 toggles (45) → P4-19**
(both drafted in `backlog/phase4.md` Tranche E). Of the scattered rest: **3 → P4-0** (composer attach
+ slash-picker footer chrome), **1 → CC-2** (restore-reorder), **5 waived** (mock/cosmetic: palette
mock-recents, per-agent-memory invention, match-type label), and **8 → recommended P4-20** — the
AskUserQuestion renderer, a real reachable tool that today degrades to a raw JSON dump; **not yet
drafted, operator greenlight**. Per-cluster map: the Part C ownership table.

## How this ledger is maintained (done-criterion + gate)

- **Every surface/flow session's DONE-WHEN now includes updating its ledger rows here** (add/flip
  dispositions; a built element moves ⬜/❓ → ✅ with its `app/…:line`). Never silently drop a
  prototype element — an un-flagged omission is exactly what this instrument exists to catch.
- **Each phase gate audits Part C.** The ❓ count for the phase's surfaces must be **empty or
  explicitly waived** (with a reason) before the gate clears. Part D is the parity measure the gate
  reads.
- Dispositions cite `file:line` and decision docs; a stale citation is a bug in the ledger — re-verify
  against source before acting on a row (per the dated-doc rule).

---

## Part A — Surfaces (30)

One section per prototype surface, in prototype-load order. Each row is one element/UX-state.

### 01. AppV2.jsx — root App shell: sidebar + tabbar + workspace, 3-view router, app-wide state, keyboard chords, permission/connection wiring, startup/resume overlays, and prototype-only demo scaffolding

**Migration target:** `app/renderer/src/App.tsx` + `shellState.ts`/`workspaceLayout.ts`/`connectionState.ts`/`permissionState.ts`/`goalMemoryState.ts` (shell + Goals/Settings views built; Sessions/Accounts + domain state deferred P4-5..P4-16) · **Overall:** 🔁 adapted · **Prototype:** `~/catcode_prototype/cat-app/AppV2.jsx` (624 lines) · **INVENTORY:** W2 root state/routing (adapt/build-new, S3/S6)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Root shell container (full-height flex, app bg, `--accent` var) | chrome | 🔁 adapted | `app/renderer/src/App.tsx:853` | Built; real uses fixed `bg-app-bg`/`text-accent` token, not the prototype's runtime `--accent` from the Tweaks picker (cut). |
| Sidebar mount (left rail) | sub-component | ✅ built | `app/renderer/src/App.tsx:856` | P4-4 true-up; renders live∪restorable roster. Takes `activeView`/`onSelectView` (not the prototype's `onPageChange`/`runningAgentCount`). |
| Main content column (flex-1, min-w-0) | chrome | ✅ built | `app/renderer/src/App.tsx:865` | Structural column holding TabBar + shellError + workspace. |
| TabBar mount | sub-component | 🔁 adapted | `app/renderer/src/App.tsx:866` | Built but always mounted (no `activePage==='chat'` gate); a background view (goals/settings) still renders the TabBar above it. |
| WorkspaceLayout mount (1–3 split panels) | sub-component | ✅ built | `app/renderer/src/App.tsx:907` | Via `workspaceLayout.ts`; drag-tab-to-edge split, resize, up to `MAX_WORKSPACE_PANELS`. |
| Central page router (`activePage`/`navigatePage`) | routing | 🔁 adapted | `app/renderer/src/App.tsx:177` | CORRECTION vs draft: real DOES route — `activeView: 'chat'\|'goals'\|'settings'` (analyst wrongly said "no router"). 3 views vs the prototype's 5 pages + deep-links; Sessions/Accounts unbuilt. |
| Nav destination rail (Chat/Sessions/Goals/Accounts/Settings) | chrome | 🔁 adapted | `app/renderer/src/Sidebar.tsx:50` | Chat, Goals, Accounts (P4-5) AND Settings are `enabled:true`; only Sessions `enabled:false` (disabled + flagged, not faked — P4-6). |
| Goals view render (`activePage==='goals'`) | routing | 🔁 adapted | `app/renderer/src/App.tsx:895` | CORRECTION: BUILT — `<GoalsPage snapshot={selectThreadGoalSnapshot(...)}>` read-only engine snapshot; not deferred. The in-chat goal DRAWER + lifecycle writers stay deferred (P4-10). |
| Settings view render (`activePage==='settings'`) | routing | 🔁 adapted | `app/renderer/src/App.tsx:888` | CORRECTION: BUILT (shell) — `<SettingsShell agentsSnapshot/memorySnapshot/snapshot>` (P4-3); not deferred. Extensions/panels + category selector deferred (P4-12). |
| Sessions view render (`activePage==='sessions'`) | routing | ⬜ deferred | `phase4.md:427` P4-6 | Sessions nav `enabled:false` (`Sidebar.tsx:52`); no SessionsPage in `app/renderer/src`. |
| Accounts view render (`activePage==='accounts'`) | routing | ✅ built | `app/renderer/src/App.tsx` (`activeView==='accounts'` → `<AccountsPage>`) | P4-5: Accounts nav `enabled:true` (`Sidebar.tsx:54`); AccountsPage wired to the redacted read-seam. Establishes the domain read-seam recipe. |
| Settings deep-link category (`settingsCategory`: agents/ide/memory) | routing | ⬜ deferred | `phase4.md:649` P4-12 | Partial: `SettingsShell initialCategory="agents"` hardcoded + `memorySnapshot` passed (`App.tsx:891`); the agents/ide/memory selector routing deferred to P4-12 (Memory to P4-10). |
| Open-tabs set (`openTabs`) | data-binding | ✅ built | `app/renderer/src/App.tsx:307` | `tabs`/`liveSessionIds` = HostEvent-driven `selectLiveSessions(shell)` projection, not a static array. |
| Panels + active idx (multi-panel split state) | data-binding | ✅ built | `app/renderer/src/App.tsx:142` | `workspaceLayout` via `createWorkspaceLayout`/`reconcileWorkspaceLayout`; reducers in `workspaceLayout.ts`. |
| Dragging session id (drag-to-panel) | control | 🔁 adapted | `app/renderer/src/App.tsx:470` | Real drag model is tab→edge split (`splitWorkspacePanelWithSession`, P3-6), not session-row drag; sidebar row-drag omitted (`Sidebar.tsx:24` §0). |
| `messagesBySession` store | data-binding | ✅ built | `app/renderer/src/App.tsx:120` | Per-session raw log (`reduceServerFrame`) + transcript (`projectServerFrame`), keyed by sessionId (P3-4). |
| sessions list incl synthetic DRAFT "New chat" row | data-binding | 🔁 adapted | `app/renderer/src/App.tsx:904` | Real roster = live host descriptors; no synthetic DRAFT row — zero-session state is `EmptyShell` (`App.tsx:932`), new session via native picker (HC1). |
| handleTabClick / Close / AddTab | control | ✅ built | `app/renderer/src/App.tsx:429` | `selectTab` (429), `closeTab` non-destructive (530), `newSession` native-picker→createSession (393). |
| handleAddPanel / handleRemovePanel | control | 🔁 adapted | `app/renderer/src/App.tsx:511` | `addWorkspacePanel` opens a DIFFERENT un-panelled session (layout forbids same session twice); `removeWorkspacePanel` (525). Prototype duplicates active (§0 `App.tsx:506`). |
| handleSessionSelect (sidebar/palette) | control | ✅ built | `app/renderer/src/App.tsx:429` | `selectTab` (`focusOrAssignWorkspaceSession`) + palette `selectLiveSession` (`App.tsx:846`). |
| handleMessagesChange (draft→tab promotion) | control | 🔁 adapted | `app/renderer/src/App.tsx:579` | `submitSession` transports via `bridge.submit` to an already-created session; no client-side draft-promotion path. |
| activePanelSessionId (active-tab highlight) | data-binding | ✅ built | `app/renderer/src/App.tsx:140` | `activeSessionId` state; never stolen by background frames (`App.tsx:207`, `shellState.ts`). |
| ⌘K command palette chord | shortcut | ✅ built | `app/renderer/src/App.tsx:713` | `event.key==='k'` → toggle `paletteOpen`. |
| ⌘T new tab chord | shortcut | ✅ built | `app/renderer/src/App.tsx:720` | `event.key==='t'` → `newSession()` (native dir picker). |
| ⌘W close tab/panel chord | shortcut | ✅ built | `app/renderer/src/App.tsx:725` | `event.key==='w'` → `closeTab(activeSessionId)` (non-destructive). |
| ⌘1–9 jump-to-tab | shortcut | ➕ real-added | `app/renderer/src/App.tsx:731` | Real-only: `sessionAtSlot(shell,n)`→`selectTab`; the prototype keydown handler (`AppV2.jsx:112`) has no numeric jump. |
| Command palette mount (⌘K overlay) | sub-component | ✅ built | `app/renderer/src/App.tsx:922` | `<CommandPalette items={paletteItems}>`; `buildPaletteItems` (828). Every row a real wired action; no page-nav rows (Sessions/Accounts unbuilt). |
| PermissionQueue mount (global overlay, minimizable) | sub-component | 🔁 adapted | `app/renderer/src/App.tsx:1101` | Real queue is per-session inside `SessionPane`, not one app-level fixed overlay + `permMinimized` chip; snooze is per-card Esc. |
| Permission mode + handlePermModeChange | control | ✅ built | `app/renderer/src/App.tsx:803` | `setPermissionMode`→`bridge.setPermissionMode`; mode shown in the Permissions `<details>` summary (`App.tsx:1108`), edited via `PermissionRulesEditor` (1118). |
| handlePermResolve (allow / deny / always) | control | ✅ built | `app/renderer/src/App.tsx:643` | `allowPermission` (`buildAllowResponse` w/ applySuggestions) + `denyPermission` (`buildDenyResponse`, 660). "always" = allow with rule suggestions. |
| Keep-pending / minimize (Esc snooze) | control | 🔁 adapted | `app/renderer/src/App.tsx:689` | `dispatchPermission({type:'dismissed'})` on Esc = per-card snooze (`permissionState.ts:12`), still pending engine-side; not an app modal-hide + chip counter. |
| Stale-request dismiss (`permission_not_found`) | control | 🔁 adapted | `app/renderer/src/permissionState.ts:13` | Staleness handled by the engine-driven `permission.resolved` universal-dismiss fold, not an app-local `handleStaleDismiss`. |
| Abort-all (Ctrl+C discard + pause agent) | control | 🔁 adapted | `app/renderer/src/permissionState.ts:13` | Abort is engine-owned (mass-deny → resolved events the renderer folds), not an App handler mutating a local queue. |
| onManageRules → navigate to Settings | control | 🔁 adapted | `app/renderer/src/App.tsx:1118` | Rule editing is inline `PermissionRulesEditor` in the pane `<details>`; the Settings-page destination for it is deferred (P4-12). |
| Connection state (connected/reconnecting/disconnected) | state | ✅ built | `app/renderer/src/App.tsx:157` | `reduceConnectionState` per-session; `selectConnection` (301) from the frame stream (`connectionState.ts`). |
| Connection→banner injection effect | state | 🔁 adapted | `app/renderer/src/App.tsx:1059` | `<ConnectionRecovery>` renders an inline per-pane "Session {status}." row + Restart, not injected `BannerStack` bars. |
| Conn chip click → retry/reconnect | control | 🔁 adapted | `app/renderer/src/App.tsx:1182` | Restart button → `getBridge().restart(sessionId)` (real engine restart), not the prototype's scripted 1.8s mock timer. |
| Chip click router (goal/perm-rules/account/ide/conn) | control | ⬜ deferred | `phase4.md` P4-0 | Composer `ChipStrip` + chip→page routing is P4-0 (Chat.jsx); no ChipStrip in `App.tsx`. |
| Composer status state (model/effort/thinking/fast) + `MOCK_STATUS` | data-binding | ⬜ deferred | `phase4.md` P4-0 | Composer controls belong to P4-0; `MOCK_STATUS` is fixture (correct to drop — real values from engine). |
| handleStatusChange (effort/thinking/fast) | control | ⬜ deferred | `phase4.md` P4-0 | Composer control handlers; P4-0. Absent in `App.tsx`. |
| IDE state (`MOCK_IDE`) + ide chip | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | IDE & LSP is a Settings section (P4-12); `MOCK_IDE` is fixture. |
| Sidebar running-task attention badge (`runningTaskCount`/`MOCK_TASKS`) | data-binding | ⬜ deferred | `phase4.md:551` P4-9 | Real Sidebar takes no count prop (`Sidebar.tsx:60`); Tasks runtime = P4-9. `MOCK_TASKS` fixture. |
| Goal state (`goal`/`MOCK_GOAL`) | state | 🔁 adapted | `app/renderer/src/App.tsx:172` | CORRECTION: real `goalMemoryState` reducer produces a read-only `ThreadGoalSnapshot` (`selectThreadGoalSnapshot`) rendered in GoalsPage; not deferred. `MOCK_GOAL` fixture dropped. |
| Goal detail drawer (`goalDetailOpen` + GoalDetail inspector) | sub-component | ⬜ deferred | `phase4.md:583` P4-10 | The in-chat right-inspector drawer is P4-10; real Goals surface is the full-page read-only `GoalsPage`, not an inline drawer. |
| handleGoalAction (pause/resume/replace/clear) | control | ⬜ deferred | `app/renderer/src/GoalsPage.tsx:34` | No desktop writer boundary — GoalsPage states these stay on the engine `/goal` command path; lifecycle UI owned by P4-10. |
| Banners state (`banners`/`MOCK_BANNERS`) + action/dismiss | state | ⬜ deferred | `phase4.md:764` P4-15 | `BannerStack.tsx` primitive BUILT (P4-1) but NOT mounted in `App.tsx`; consumers (reauth/handoff banner) are P4-15. `MOCK_BANNERS` fixture. |
| Toast system (`window.toast` + ToastHost mount) | sub-component | ⬜ deferred | `phase4.md` P4-1 | `ToastHost.tsx` exists (P4-1) but is NOT mounted in `App.tsx`; no `window.toast` bus — the prototype's ~30 toast calls have no real sink yet. |
| Accounts state (`accounts`/`activeProvider`/`MOCK_ACCOUNTS`) | state | ✅ built | `app/renderer/src/accountsState.ts`; `app/sidecar/accountsDomain.ts` | P4-5: real redacted pool via the `accounts.snapshot` read-seam (no `MOCK_ACCOUNTS`); `create/reduce/select` state module. |
| Per-session active-account resolver (`resolveActiveAccountId` etc.) | data-binding | ⬜ deferred | `phase4.md:372` P4-5 | Models real per-process `pool.activeIndex` + persisted global default; P4-5 builds it over the real snapshot. |
| handleAccountSwitch (/switch-account persistence) | control | ⬜ deferred | `phase4.md:372` P4-5 | Account switch = P4-5; engine owns the persistence write. |
| Orchestrator mode state (`orchestratorModeBySession`/inspect/newChat) | state | ⬜ deferred | `phase4.md:506` P4-8 | Orchestrator roster/detail/focus (8 surfaces, D2) = P4-8; no orchestrator state in `App.tsx`. |
| workersBySession derivation (`MOCK_WORKERS`) | data-binding | ⬜ deferred | `phase4.md:506` P4-8 | Worker roster = P4-8 over the real read-seam; `MOCK_WORKERS` fixture. |
| OrchestratorDemoSwitch (A/B/C control) + demo state/handlers | control | ✂️ cut | `INVENTORY.md:109` | Pure demo scaffold flipping mock snapshots; AppV2 comment (`AppV2.jsx:612`) says "DEMO-ONLY: delete on migration". |
| Startup gate (`startupDone` + StartupFlow branch) | state | ⬜ deferred | `phase4.md:764` P4-15 | Trust gate + first-run OAuth = adapt per D4 (per-session-create); owner P4-15 (`INVENTORY.md:99`). |
| Reauth blocking modal (`reauthDemo` + ReauthGate) | sub-component | ✂️ cut | `decisions/STARTUP-GATES.md:67` | D4 Q2 ruling: blocking `ReauthGate` modal CUT; token death → non-blocking banner (P4-15). AppV2 comment (`:587`) admits "GUI-ONLY blocking surface". |
| Startup-handoff banner injection (`triggerStartupHandoff`/`MOCK_STARTUP_HANDOFFS`) | state | ⬜ deferred | `phase4.md:764` P4-15 | Non-blocking startup-handoff banner is part of the D4 surface (P4-15); the `window.triggerStartupHandoff` bridge itself is a cut demo trigger. |
| Cross-project resume confirm dialog (`CrossProjectResumeDialog`) | sub-component | 🔁 adapted | `app/renderer/src/ResumeDialog.tsx:40-125`; `app/renderer/src/App.tsx:609-616,1024-1031` | P4-16 reframes it as a restorable-row confirm dialog; cross-project copy/badges render only for a real cwd difference. |
| Hydration overlay (`hydrationDemo` + HydrationOverlay loading/failed) | sub-component | ✅ built | `app/renderer/src/ResumeDialog.tsx:135-211`; `app/renderer/src/App.tsx:235-240,629-638,1003-1010` | P4-16 overlay visualizes the real ready/replay restore window and failed restore errors. |
| Slash-command router (`handleSlashCommand`: page/chip/action routing) | control | 🔁 adapted | `app/renderer/src/App.tsx:998` | Real slash = typeahead-insert-verbatim (`SlashCommandPicker`, `selectSlashCommands` over the real per-session catalog); no renderer command-exec / page-nav. Prototype's /accounts→page, /model→chip, /clear·/compact toast routing not ported (targets deferred). |
| Tweaks panel (tools/reasoning defaults, activity copy, accent) | sub-component | ✂️ cut | `AppV2.jsx:13` | Prototype-only design-authoring tool; no upstream counterpart. Its two behavioral prefs (`toolsExpandedByDefault`/`thinkingExpandedByDefault`) are P4-0 composer/transcript prefs. |
| Edit-mode host protocol (`postMessage __activate/__deactivate/set_keys`) | control | ✂️ cut | `AppV2.jsx:129` | Design-tool iframe bridge with no product analogue. |
| Accent theming (`accentMap` + `--accent` var) | chrome | ✂️ cut | `app/renderer/src/App.tsx:853` | Runtime accent-picker is part of the cut Tweaks tool; real accent is the fixed `text-accent`/`bg-accent` token (P0-2). |
| DEMO-ONLY `window.*` trigger bridges (setMockConnection/triggerPermQueue/catcodeRequestPermission/etc.) | control | ✂️ cut | `INVENTORY.md:104` | Settings▸Diagnostics demo triggers driving the prototype's mock state machines; real states are engine-driven, not `window` globals. |
| EmptyShell (no-live-session state) | state | ➕ real-added | `app/renderer/src/App.tsx:932` | Real-only genuine zero-session shell ("No sessions open" + New session + ⌘T); the prototype always seeds a synthetic DRAFT welcome tab instead. |
| Shell error bar (host control-plane errors) | state | ➕ real-added | `app/renderer/src/App.tsx:879` | Real-only: surfaces create/close/restore failures; no prototype counterpart. |
| Layout notice (duplicate-in-panel / max-panels feedback) | state | ➕ real-added | `app/renderer/src/App.tsx:138` | Real-only: layout model forbids same session in two panels + caps at 3; set at 461/478. Prototype silently duplicates. |
| Workspace layout persistence + relaunch restore (localStorage + `pendingRestore`) | state | ➕ real-added | `app/renderer/src/App.tsx:142` | Real-only durability (P3-6): `readWorkspaceLayoutFromStorage` + `pendingRestore` re-apply (371) + write effect (386). Prototype layout is in-memory only. |
| HostEvent roster stream (`subscribeHost` + `listSessions` hydrate) | data-binding | 🔁 adapted | `app/renderer/src/App.tsx:244` | Real roster = live projection of the host control plane (subscribe-before-snapshot F3, `reduceShell` 1277); the prototype's roster is static `MOCK_SESSIONS`. Core of the W2 build-new. |

### 02. Sidebar.jsx — hover-expanding left rail: paw logo, session search, workspace-grouped roster, nav destination rail

**Migration target:** `app/renderer/src/Sidebar.tsx` + `sidebarState.ts` (+ `TabBar.tsx` tabLabel, `hostApi.ts` descriptor) · **Overall:** 🔁 adapted · **Prototype:** `~/catcode_prototype/cat-app/Sidebar.jsx` (338 lines) · **INVENTORY:** W2 Sidebar adapt (S3/S4)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| PawLogo (pink paw SVG glyph) | chrome | ✅ built | `app/renderer/src/Sidebar.tsx:603` def, rendered `:140` | SVG ported attribute-for-attribute; `text-accent` (pink). |
| Rail geometry: 48px collapsed → 240px expanded | chrome | ✅ built | `app/renderer/src/Sidebar.tsx:121` `w-12` spacer, `:129` `open?'w-60':'w-12'` | RAIL_W/FULL_W → Tailwind `w-12`/`w-60`. |
| Hover-expand timing (120ms show / 200ms hide) | ux-state | ✅ built | `app/renderer/src/Sidebar.tsx:36` `HOVER_DELAY`/`HIDE_DELAY`; timers `:86-93` | |
| Spacer div reserving rail footprint in flex flow | chrome | ✅ built | `app/renderer/src/Sidebar.tsx:121` `<div className="w-12 shrink-0" aria-hidden>` | |
| Floating fixed rail: bg, border-right, shadow-when-open, width easing | chrome | ✅ built | `app/renderer/src/Sidebar.tsx:123-130` `fixed inset-y-0 z-40 bg-shell-chrome border-r border-shell-seam shadow[…] transition-[width,box-shadow]` | Raw `#0a0a0c`/rgba tokens → `shell-chrome`/`shell-seam` design tokens (P3-5a grammar). |
| Logo + pin header row (height 50) | chrome | ✅ built | `app/renderer/src/Sidebar.tsx:133-137` `h-[50px]`, justify-between when open else center | |
| "Cat Code" wordmark (shown only when open) | chrome | ✅ built | `app/renderer/src/Sidebar.tsx:143-147` `truncate text-[13px] font-semibold`, gated on `open` | |
| Pin button (toggle pinned-open) + pin icon + active pink bg | control | ✅ built | `app/renderer/src/Sidebar.tsx:149-165`; `PinIcon` `:709` | Pinned → `bg-accent/15 text-accent`; real adds `aria-pressed`+`aria-label`. |
| Pinned-open state (pin overrides hover collapse) | ux-state | ✅ built | `app/renderer/src/Sidebar.tsx:76` `pinned`; `:84` `open = pinned \|\| hovering` | |
| Collapsed rail nav (icons only, anchored bottom) | chrome | ✅ built | `app/renderer/src/Sidebar.tsx:233-245` rail nav `mt-auto`; `NavItemRail` `:485` | |
| Rail nav item hover color change | ux-state | ✅ built | `app/renderer/src/Sidebar.tsx:524` `hover:text-text-muted`; disabled items no hover | |
| Rail nav active state (pink bg + accent-soft) | ux-state | 🔁 adapted | `app/renderer/src/Sidebar.tsx:494` `active = enabled && id===activeView`; `:522-523` | Active follows `activeView` over chat/goals/settings (wired); Sessions/Accounts disabled. Prototype's `activePage` spanned all 5. |
| Rail nav badge (runningAgentCount pink dot) | chrome | ✂️ cut | `Sidebar.jsx:176,193` badge keyed to `id==='tasks'`, removed from NAV by proto's own comment `Sidebar.jsx:19` | Dead path even in the mock (tasks not in NAV); real takes no `runningAgentCount`. |
| NAV destination set: Chat/Sessions/Goals/Accounts/Settings (+icons) | chrome | ✅ built | `app/renderer/src/Sidebar.tsx:50-56` `NAV`; icon SVGs `:615-707` | Proto comments already dropped Tasks/Agents from rail; real matches. |
| Search input + magnifier icon, focus pink border | control | ✅ built | `app/renderer/src/Sidebar.tsx:176-183`; `SearchIcon` `:727` | `focus:border-accent/40`; real adds `aria-label`. |
| Search filters session roster | ux-state | 🔁 adapted | `app/renderer/src/Sidebar.tsx:106-115` filters by `tabLabel(descriptor)` AND `descriptor.cwd` | Real broadens filter to include cwd — superset of prototype (title-only). |
| Session list scroll container (no-scrollbar) | chrome | ✅ built | `app/renderer/src/Sidebar.tsx:188-191` `overflow-y-auto min-h-0 flex-1`, scrollbar hidden | |
| Workspace grouping (current-first, then alpha, 'other' last) | data-binding | 🔁 adapted | `app/renderer/src/Sidebar.tsx:268-293` `groupByWorkspace`: active session's cwd group first, then alpha by label | Group key from real `descriptor.cwd` (basename label), not proto's `s.workspace` fixture; no 'other' bucket (every session has a cwd). Source-wins. |
| Group header: chevron toggle + uppercase workspace label | control | ✅ built | `app/renderer/src/Sidebar.tsx:312-330`; `ChevronIcon` `:744` rotates `-90` collapsed | Label = cwd basename; real adds `aria-expanded`+`title=cwd`. |
| Group collapse/expand state | ux-state | ✅ built | `app/renderer/src/Sidebar.tsx:78` `collapsedGroups`; toggle `:202-208`; hides rows `:332` | |
| Per-workspace "+" (new session in this workspace) button | control | ✂️ cut | `app/renderer/src/Sidebar.tsx:21-23` §0 doc + `STATUS.md` P4-4: HC1 forbids renderer authoring a cwd | New sessions go via native picker (⌘T / TabBar "+"). Not a silent drop. |
| Session row: clickable → select session (+ navigate to chat) | control | ✅ built | `app/renderer/src/Sidebar.tsx:369` `SidebarRowItem`, `activate` `:367` (`onClick :382`) | Adapted split: live → `onSelectLive` (reuse `selectTab`); restorable → `onRestore`. |
| Active row styling (pink bg + border) | ux-state | ✅ built | `app/renderer/src/Sidebar.tsx:373-374` `border-accent/[0.18] bg-accent/[0.09]` | |
| Selected-row pink outline (Tranche-A fidelity fix #1) | ux-state | ✅ built | `app/renderer/src/Sidebar.tsx:374` border + left accent bar `:390-395` (`absolute inset-y-1 left-0 w-[2px] bg-accent`) | The #1 chrome miss caught in the 2026-07-07 live compare (`STATUS.md` P4-4). |
| Row hover styling (visible pink bg/border) (fidelity fix #2) | ux-state | ✅ built | `app/renderer/src/Sidebar.tsx:375` `hover:border-accent/[0.22] hover:bg-accent/[0.07]` | Original was ~6%-alpha invisible (`STATUS.md` P4-4 miss #2). |
| Row title text (ellipsis, color by state, identity-first weight) (fidelity fix #3) | chrome | ✅ built | `app/renderer/src/Sidebar.tsx:400-407` `truncate text-xs font-medium`; active→`text-accent-soft` else `text-text-muted` | Identity-first IA rebalance; runtime chip subordinated. |
| Row title binding (session title) | data-binding | 🔁 adapted | `tabLabel` `app/renderer/src/TabBar.tsx:352-357` (title → cwd basename → 'New session'); `hostApi.ts:73` `title: string\|null` | Real `descriptor.title` is null for desktop sessions → rows fall back to cwd basename. Rendering built; population gap below. |
| Session-title population (real generated titles) | data-binding | ⬜ deferred | `STATUS.md` P4-6 RIDER + `docs/migration/backlog/phase4.md:427`: TUI `saveAiGeneratedTitle` not wired for app sessions | THE flagged feature-class gap from the 2026-07-07 review; owner **P4-6**. |
| Row subtitle: relative time | data-binding | 🔁 adapted | `app/renderer/src/Sidebar.tsx:408-410` + `formatRecency :564-573` from `descriptor.lastAttachedAt` | Proto `s.time` is a fixture string; real derives from real `lastAttachedAt` (`hostApi.ts:86`). |
| Row subtitle: model tag | data-binding | ✂️ cut | `app/renderer/src/Sidebar.tsx:563` doc + `INVENTORY.md:42`: no `model` field; C3 reduced-metadata | Dropped MOCK fixture field (`s.model`), not a visual gap. |
| Per-row 3-dot actions button (reveal on hover) | control | ⬜ deferred | `app/renderer/src/Sidebar.tsx:18-20` §0 doc; `docs/migration/backlog/phase4.md:427` P4-6 owns `SessionActionsMenu` | Owner: P4-6. |
| Right-click context menu → SessionActionsMenu | control | ⬜ deferred | `docs/migration/backlog/phase4.md:427` P4-6 (branch/export/rewind/rename/copy/delete) | Proto hides `['open','tag','archive','metadata']` for sidebar variant. Owner: P4-6. |
| Inline rename input (renamingId/renameValue/commitRename) | control | ⬜ deferred | `docs/migration/backlog/phase4.md:427` P4-6 rename verb (real op); no rename UI in real Sidebar | Proto `titleOverrides` is mock local state; real rename needs an engine verb. Owner: P4-6. |
| Branch action + BranchDialog | control | ⬜ deferred | `docs/migration/backlog/phase4.md:427` P4-6 "real branch/export/rewind verbs" | Owner: P4-6. |
| Rewind action + RewindDialog | control | ⬜ deferred | `docs/migration/backlog/phase4.md:427` P4-6 rewind verb | Owner: P4-6. |
| Export action + ExportDialog | control | ⬜ deferred | `docs/migration/backlog/phase4.md:427` P4-6 export verb | Owner: P4-6. |
| Copy-as-Markdown / Copy-as-text actions | control | ⬜ deferred | `docs/migration/backlog/phase4.md:427` P4-6 (proto `window.saCopy`/`saToMarkdown` are mock globals) | Owner: P4-6. |
| Delete action (hides row + danger toast) | control | ⬜ deferred | `docs/migration/backlog/phase4.md:427` P4-6 delete verb (proto `hiddenSb` is a mock hide) | Owner: P4-6. |
| Menu-active keeps sidebar pinned open + backdrop-close re-collapse guard | ux-state | ⬜ deferred | Guards exist only to protect the floating actions menu/dialogs (P4-6); real `open = pinned\|\|hovering` `Sidebar.tsx:84`, no `menuActive` term | Re-add alongside P4-6 actions menu. Owner: P4-6. |
| Page-change collapses expanded session list | ux-state | 🔁 adapted | Real Sidebar takes `activeView`/`onSelectView` router (`Sidebar.tsx:60-74`, App `:859-860`) but has no collapse-on-view-change effect | Router now exists (chat/goals/settings); proto's snap-shut effect not replicated (list stays visible across views). |
| Row drag-to-panel (onPointerDown → onSessionDragStart) | control | ✂️ cut | `app/renderer/src/Sidebar.tsx:24-25` §0 doc + `STATUS.md` P4-4: built split model is drag-tab-to-edge (P3-6) | Different, built DnD affordance covers the intent. |
| Expanded nav destinations (icon + label rows) | chrome | ✅ built | `app/renderer/src/Sidebar.tsx:221-229`; `NavItemExpanded :433` — 32px icon box + label | |
| Expanded nav active state (pink + hover color) | ux-state | ✅ built | `app/renderer/src/Sidebar.tsx:459-481` active→`bg-accent/10 text-accent-soft font-medium`; `hover:text-text-muted` | Chat/Goals/Settings can be active (all wired pages); follows `activeView`. |
| Disabled/unbuilt nav destination (Sessions) softened (fidelity fix #4) | ux-state | 🔁 adapted | `app/renderer/src/Sidebar.tsx:443-458` (expanded) + `:495-508` (rail): `disabled aria-disabled title '… — not yet migrated' text-text-subtle/55` | Goals(P4-10 ✅)/Settings(P4-3 ✅)/Accounts(P4-5 ✅) are WIRED. Only Sessions(P4-6) remains disabled+flagged. `/55` = softening fidelity fix #4. |
| Runtime status dot per row | chrome | ➕ real-added | `app/renderer/src/Sidebar.tsx:397` `StatusDot`; `deriveSidebarRowVisual` `sidebarState.ts:85-123` | Proto row has no runtime health indicator (shows time·model). Real surfaces live/busy/warn/dead tone. |
| Runtime status chip per row (live/starting/crashed/closed) | chrome | ➕ real-added | `app/renderer/src/Sidebar.tsx:428` `StatusChip` (suppressed when live); labels `sidebarState.ts:95-120` | Subordinated (opacity `/75`) per fidelity fix #3. No prototype equivalent. |
| Restore-offer button on restorable rows | control | ➕ real-added | `app/renderer/src/Sidebar.tsx:413-426` restore button (`group-hover:opacity-100`) → `onRestore`; `kind='restorable'` `sidebarState.ts:91` | Proto has no live/restorable distinction (fixtures always present). P3-5b live∪restorable roster. |
| Empty / no-match states | ux-state | ➕ real-added | `app/renderer/src/Sidebar.tsx:192-195` 'No sessions yet.' / 'No matches.' | Proto never renders an empty roster. |
| Keyboard row activation + full ARIA labeling | ux-state | ➕ real-added | `app/renderer/src/Sidebar.tsx:377-388` `tabIndex=0`+Enter/Space; region labels `:126,:189,:218,:234`; aria-current/pressed/expanded/disabled throughout | Proto rows are `role='button'` with no keyboard handler, no aria. |
| Roster data source / props | data-binding | 🔁 adapted | `app/renderer/src/Sidebar.tsx:60-74` props (`rows`,`activeSessionId`,`activeView`,`onSelectView`,`onSelectLive`,`onRestore`); `selectSidebarRows` `sidebarState.ts:64-72` | Event-driven over live∪restorable registry roster in stable arrival order, not fixture sessions/recency sort. Proto's `runningAgentCount`/`onSessionDragStart` dropped. |

### 03. TabBar.jsx — horizontal session tab strip (title + close per live session, New-tab +, Split/Unsplit cluster)

**Migration target:** `app/renderer/src/TabBar.tsx` · `tabStatus.ts` · `shellState.ts` (wired in `App.tsx`) · **Overall:** 🔁 adapted · **Prototype:** `~/catcode_prototype/cat-app/TabBar.jsx` (165 lines) · **INVENTORY:** W2 TabBar adapt (S3), D1 registry

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Outer TabBar container (40px height, chrome bg, bottom seam, overflow hidden) | chrome | 🔁 adapted | `app/renderer/src/TabBar.tsx:102-106` | Prototype hard-coded `#070709`/rgba border → `shell-chrome`/`shell-seam` tokens; `role="tablist"` added. |
| Scrollable tab list (flex-1, horizontal scroll, hidden scrollbar) | chrome | ✅ built | `app/renderer/src/TabBar.tsx:107` | Direct port incl. `[scrollbar-width:none]` no-scrollbar treatment. |
| Per-tab container (90/176px clamp, right seam, draggable, cursor-pointer, select-none) | chrome | ✅ built | `app/renderer/src/TabBar.tsx:229-251` | Same `min-w-[90px] max-w-[176px]` clamp, `pl-3 pr-1.5` grammar. |
| Active-tab background fill | state | ✅ built | `app/renderer/src/TabBar.tsx:234` | Prototype `rgba(255,255,255,0.05)` → `bg-shell-active`. |
| Non-active hover background | state | ✅ built | `app/renderer/src/TabBar.tsx:234` | Imperative onMouseEnter/Leave rgba swap → `hover:bg-shell-hover` CSS token (equivalent UX). |
| Active-tab bottom accent underline (1.5px pink, rounded top) | chrome | ✅ built | `app/renderer/src/TabBar.tsx:252-257` | Prototype `#f472b6` → `bg-accent`; same 1.5px + `rounded-t-sm`. |
| Tab title text (flex-1, truncate/ellipsis, active vs inactive color) | data-binding | ✅ built | `app/renderer/src/TabBar.tsx:265-272` | Source = `tabLabel(descriptor)` (`TabBar.tsx:352-358`); active `text-text-primary` else `text-text-subtle`. |
| Tab title fallback label (prototype flat "New chat") | data-binding | 🔁 adapted | `app/renderer/src/TabBar.tsx:352-358` | Real chain: `title` → cwd basename → `"New session"`; sessions have no title today so basename shows. |
| Session-title FEATURE (real generated/persisted per-session title) | data-binding | ⬜ deferred | `docs/migration/STATUS.md:220` (P4-6 rider); `phase4.md:427` P4-6 | Prototype `session.title` is a MOCK field; authoring/generating a real title owned by P4-6; correct to defer, not a silent drop. |
| Tab tooltip (title attribute) | control | 🔁 adapted | `app/renderer/src/TabBar.tsx:242` | Prototype tooltip = `session.title`; real = full `cwd` + `⌘n` hint (more informative given no title). |
| Per-tab close button (× glyph, stopPropagation) | control | ✅ built | `app/renderer/src/TabBar.tsx:291-302` | Same 18×18 button; onClick stops propagation → `onClose(id)`. Prototype title "Close tab" → real "Close session" (vocab). |
| Close-button visibility (prototype always-visible vs hover-revealed) | state | 🔁 adapted | `app/renderer/src/TabBar.tsx:292` | Prototype shows × always (dim); real reveals only on `group-hover:opacity-100` — quieter bar. |
| Close-button hover styling (brighten glyph + subtle bg) | state | ✅ built | `app/renderer/src/TabBar.tsx:292` | `hover:bg-white/10 hover:text-text-primary` — equivalent treatment. |
| Tab click → select/activate session | control | ✅ built | `app/renderer/src/TabBar.tsx:245` → `App.tsx:869` (`selectTab` def `App.tsx:429`) | `onSelect(id)`; host activation in App. |
| Tab drag start (set dataTransfer `text/sessionId`) | drag | 🔁 adapted | `app/renderer/src/TabBar.tsx:246-249`; `WorkspacePanels.tsx:110` | Prototype `effectAllowed='move'`+reorder callback; real `'copyMove'` consumed as tab→edge SPLIT (P3-6). Same key. |
| Tab drag end callback (onDragEnd) | drag | 🔁 adapted | `app/renderer/src/WorkspacePanels.tsx:68-80` | Prototype raises `onDragEnd` to parent; real tracks drag lifecycle centrally via window `dragstart`/`dragend` driving `dragActive`. No lost behavior. |
| In-bar tab REORDER via drag | drag | 🔁 adapted | `app/renderer/src/shellState.ts:22-31` (arrival-order only) | Prototype draggable implies reorder; migrated drag is tab→edge SPLIT only; tab order = arrival order, deliberately stable. |
| New-tab (+) button | control | ✅ built | `app/renderer/src/TabBar.tsx:125-133` → `App.tsx:872` (`newSession` def `App.tsx:393`) | Same 40px + at end of list; `onClick={onNewTab}`. |
| New-tab button hover accent color | state | ✅ built | `app/renderer/src/TabBar.tsx:126` | Prototype `#f472b6` hover → `hover:text-accent`. |
| New-tab button tooltip ("New chat ⌘T") | control | 🔁 adapted | `app/renderer/src/TabBar.tsx:128-129` | Wording "chat"→"session"; same `⌘T` hint; `aria-label` added. |
| Split-controls cluster container (right side, left seam) | chrome | ✅ built | `app/renderer/src/TabBar.tsx:136-137` | Additive-optional (renders only when `onAddPanel` wired, `TabBar.tsx:136`); App always wires it (`App.tsx:875`). |
| Split button (shown while panelCount < max) | control | ✅ built | `app/renderer/src/TabBar.tsx:138-149`; `workspaceLayout.ts:4` | Prototype `panelCount<3` → `MAX_WORKSPACE_PANELS` (=3). |
| SplitIcon custom SVG (1-col and 2-col variants by panelCount) | chrome | ✅ built | `app/renderer/src/TabBar.tsx:170-188` | Pixel-identical rects/opacities for `panelCount===1`/`===2`; `aria-hidden` added. |
| Split button label text ("Split") | chrome | ✅ built | `app/renderer/src/TabBar.tsx:148` | Direct port. |
| Split button hover styling (accent border + brighten) | state | ✅ built | `app/renderer/src/TabBar.tsx:145` | Prototype `rgba(244,114,182,0.35)` → `hover:border-accent/35`. |
| Split button tooltip ("Split view") | control | 🔁 adapted | `app/renderer/src/TabBar.tsx:143` | Context-sensitive: `'Split view'` \| `'No other session to split'`; `aria-label` added. |
| Split button DISABLED state (no un-panelled session) | state | ➕ real-added | `app/renderer/src/TabBar.tsx:145` (`disabled={!canAddPanel}`); `App.tsx:874` | Prototype has no disabled Split (dup always possible); real forbids dup panels → disabled when none un-panelled. |
| Split action semantics (which session enters the new panel) | behavior | 🔁 adapted | `app/renderer/src/App.tsx:511-521`; `docs/migration/STATUS.md:220` §0 flag | Prototype duplicates active session; real opens next un-panelled live session (layout forbids dup panels). |
| Unsplit button (shown while panelCount > 1) | control | ✅ built | `app/renderer/src/TabBar.tsx:151-162` → `App.tsx:876` (`removeWorkspacePanel` def `App.tsx:525-527`) | Same `panelCount>1` gate; drops last panel. |
| UnsplitIcon custom SVG (merged panel + divider line) | chrome | ✅ built | `app/renderer/src/TabBar.tsx:191-198` | Pixel-identical rect+line (stroke `#09090b`); `aria-hidden` added. |
| Unsplit button label text ("Unsplit") | chrome | ✅ built | `app/renderer/src/TabBar.tsx:160` | Direct port. |
| Unsplit button hover styling (neutral brighten border) | state | ✅ built | `app/renderer/src/TabBar.tsx:157` | Neutral `hover:border-white/20`, matching prototype rgba white 0.18. |
| Unsplit button tooltip ("Close last panel") | control | ✅ built | `app/renderer/src/TabBar.tsx:155` | Same tooltip; `aria-label="Unsplit"` added. |
| Tab-roster data binding (tabs prop = live sessions; active highlight) | data-binding | 🔁 adapted | `app/renderer/src/TabBar.tsx:18-21,108-123`; `shellState.ts:170-174` | Prototype `(tabs, sessions, activePanelSessionId)`+inline `find`; real passes pre-projected `TabModel[]` via `selectLiveSessions`. Source wins. |
| Tab arrival ordering — must NOT reorder on restore/open (only on message-send) | behavior | 🔁 adapted | `app/renderer/src/shellState.ts:141-152`; `docs/migration/STATUS.md:25` (CC-2) | KNOWN PARKED BUG (CC-2, owner TBD, do-not-fix-now): restore/open still moves the row. Fix 1 (append-at-end) kept; full spec unbuilt pending a last-activity field. Flagged, not dropped. |
| Empty tab-list state (no live sessions) | state | ✅ built | `app/renderer/src/TabBar.tsx:108`; `App.tsx:905` (`EmptyShell`) | Zero-tab bar still shows +; Split cluster hides at panelCount 1. Prototype has no explicit empty state either. |
| Per-tab StatusDot — tone health dot on nominal tab (live/busy/warn/dead) | chrome | ➕ real-added | `app/renderer/src/TabBar.tsx:259-263,324-331`; `tabStatus.ts:48-105` | Not in prototype (tabs carry no runtime status); real-only quiet health dot fusing host status + P3-4 connection. |
| Per-tab StatusChip — tone text label for non-nominal states | state | ➕ real-added | `app/renderer/src/TabBar.tsx:274,312-321`; `tabStatus.ts:66-95` | Suppressed for healthy `ready`; shown otherwise. Prototype has no status vocabulary. |
| Per-tab restart affordance (dead-tab "restart" button) | control | ➕ real-added | `app/renderer/src/TabBar.tsx:276-289`; `App.tsx:871,548`; `tabStatus.ts:83,88` | Real-only CH_RESTART affordance shown when `visual.restartable`; no prototype analog. |
| Per-tab AttentionBadge — pulsing accent dot for background-session permission request | state | ➕ real-added | `app/renderer/src/TabBar.tsx:259-260,338-349`; `tabStatus.ts:103` | `needsAttention = pendingPermissionCount>0 && !isActive`. "Never silently queued" signal. |
| ARIA tab widget — role=tablist/tab, aria-selected, per-tab aria-label with state | a11y | ➕ real-added | `app/renderer/src/TabBar.tsx:104-105,236-243` | Real-only accessibility layer; prototype has none. |
| Keyboard nav — roving tabindex + Arrow/Home/End move focus+selection, Enter/Space activate | shortcut | ➕ real-added | `app/renderer/src/TabBar.tsx:62-99,241` | Unmodified-key handler scoped to a focused tab; no collision with global ⌘1..9. |
| ⌘1..9 jump-key hint appended to first nine tabs' tooltip | shortcut | ➕ real-added | `app/renderer/src/TabBar.tsx:227,242`; `shellState.ts:221-227` (`sessionAtSlot`) | Real-only; S3 note (`TabBar.tsx:224-227`): ⌘ shown though chord accepts ⌘ or Ctrl (no clean platform signal). |
| Durable desktop tab manager / session registry backing the roster | data-binding | 🔁 adapted | `docs/migration/INVENTORY.md:43,134` (D1 decided 2026-07-03); `shellState.ts:47-98` | Prototype passes tabs/sessions from mock glue; real roster is a HostEvent projection (D6 sessions die with window). Registry itself is the separate N-process INVENTORY row — out of surface scope. |

### 04. WorkspaceLayout.jsx — the multi-session container: 1–3 side-by-side resizable chat panels with per-panel header, splitter, and drag-to-split

**Migration target:** `app/renderer/src/WorkspacePanels.tsx` + `workspaceLayout.ts` + `App.tsx` · **Overall:** 🔁 adapted (BUILT, per INVENTORY W2) · **Prototype:** `~/catcode_prototype/cat-app/WorkspaceLayout.jsx` (288 lines) · **INVENTORY:** W2 WorkspaceLayout adapt

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| WorkspaceLayout container (flex row, 1–N panels, overflow hidden) | chrome/layout | ✅ built | `app/renderer/src/WorkspacePanels.tsx:122-138` | Real wraps in a flex-col to host the notice bar above the panel row. |
| Container col-resize cursor while resizing | ux-state | ✅ built | `app/renderer/src/WorkspacePanels.tsx:124-127` | Appends `cursor-col-resize` when `resize!==null`. |
| Container userSelect:none while resizing | ux-state | ✅ built | `app/renderer/src/WorkspacePanels.tsx:126` | Appends `select-none` while resizing. |
| 1–3 panel maximum bound | behavior | ✅ built | `app/renderer/src/workspaceLayout.ts:4` + `:215-221` | `MAX_WORKSPACE_PANELS=3`; `splitWorkspacePanel` hard-guards, returns `blocked:'max-panels'`. |
| Panel column (flexBasis width %, min-w-0, flex-col, overflow hidden) | chrome/layout | ✅ built | `app/renderer/src/WorkspacePanels.tsx:145-148` | `style={{flexBasis:\`${width}%\`}}`. |
| Per-panel width binding (widths[idx] fallback equal) | data-binding | ✅ built | `app/renderer/src/WorkspacePanels.tsx:140` | `layout.widths[index] ?? 100/panels.length`. |
| Click panel to focus | control | ✅ built | `app/renderer/src/WorkspacePanels.tsx:157` → `App.tsx:439-441` | Section `onMouseDown`→`onFocusPanel`; header `onClick` also focuses (`:268`). |
| Active panel visual highlight | ux-state | 🔁 adapted | `app/renderer/src/WorkspacePanels.tsx:152-154` | Prototype signals active only via header bottom-border color; real uses a full inset `ring-accent/35` on the panel section — richer, same intent. |
| Panel header shown only in split mode (panels>1) | ux-state | ✅ built | `app/renderer/src/WorkspacePanels.tsx:159` | `panels.length>1 ? <PanelHeader/> : null`. |
| Panel header bar (dark chrome, active/subtle bottom border) | chrome | ✅ built | `app/renderer/src/WorkspacePanels.tsx:266-267` | `h-9` vs proto 38px; uses `shell-chrome`/`shell-seam` tokens (P4-4) not hardcoded `#080809`. |
| Active-panel indicator dot (pink when active else subtle) | chrome | ✅ built | `app/renderer/src/WorkspacePanels.tsx:270-276` | `h-1.5 w-1.5 rounded-full` `bg-accent` vs `bg-text-subtle/40`. |
| Project pill (folder icon + workspace name, blue) | chrome | ✅ built | `app/renderer/src/WorkspacePanels.tsx:282-288` + `FolderIcon` `:437-453` + `workspaceLabel` `:427-434` | P4-4 true-up; label = real `descriptor.cwd` basename, not a mock `session.workspace` field. |
| Project pill cross-project AMBER state + warning-triangle icon | ux-state | ⬜ deferred | `docs/migration/STATUS.md:220` (P4-4 §0 flag) · `app/renderer/src/WorkspacePanels.tsx:277-281` | HC1 one-cwd-per-session has no single "current workspace" to diff; pill always renders neutral blue. Documented §0 deferral, not a silent drop. |
| Project pill tooltip (cross vs same-project text) | data-binding | 🔁 adapted | `app/renderer/src/WorkspacePanels.tsx:284` | Real always shows the same-project form (`title=Project: cwd`), consistent with the deferred amber state. |
| Session selector button (title text + hover bg) | control | 🔁 adapted | `app/renderer/src/WorkspacePanels.tsx:289-311` | Custom button replaced by native `<select>` value=`panel.sessionId`; label from `tabLabel`. Deliberate — free keyboard/a11y. |
| Selector chevron icon (rotates on open) | chrome | 🔁 adapted | `app/renderer/src/WorkspacePanels.tsx:289` | Native `<select>` renders the platform disclosure arrow; custom rotating SVG dropped. |
| Session-switch dropdown popover (230px card, shadow) | chrome | 🔁 adapted | `app/renderer/src/WorkspacePanels.tsx:295-310` | Custom popover replaced by the native select dropdown. |
| Dropdown 'SWITCH SESSION' section header | chrome | 🔁 adapted | `app/renderer/src/WorkspacePanels.tsx:295-310` | Native `<select>` has no group header; label folded away, not a data loss. |
| Dropdown session rows (title + 'time·model' subtitle, selected highlight) | data-binding | 🔁 adapted | `app/renderer/src/WorkspacePanels.tsx:301-308` | Title→`tabLabel`; `s.time`/`s.model` (proto:100) are MOCK fixture fields with no real descriptor equivalent — dropped under "source wins". |
| Dropdown duplicate-session marking / prevention | control | ➕ real-added | `app/renderer/src/WorkspacePanels.tsx:296-307` | Real disables the `<option>` with ` — open in panel N`; prototype allowed selecting an already-open session. |
| onSessionChange (selector picks a session into panel) | control | ✅ built | `app/renderer/src/WorkspacePanels.tsx:293` → `App.tsx:447-467` → `workspaceLayout.ts:184` | `onChange`→`onSelectSession`→`assignWorkspacePanelSession`. |
| Close panel button (×, hover color/bg) | control | ✅ built | `app/renderer/src/WorkspacePanels.tsx:312-323` → `App.tsx:489-500` → `workspaceLayout.ts:249` | P3-6 HIGH fix keeps it clickable in splits (DropEdge pointer-events gating). |
| onClosePanel active-index recompute after removal | behavior | 🔁 adapted | `app/renderer/src/workspaceLayout.ts:249-265` | Prototype hard-reset `activePanelIdx=0`; real keeps focus stable (decrements only if removed ≤ active). |
| Drop-onto-panel replaces that panel's session | behavior | 🔁 adapted | `app/renderer/src/WorkspacePanels.tsx:172-201` → `App.tsx:470-487` → `workspaceLayout.ts:201` | P3-6 model change: proto dropped a tab to REPLACE a panel's session; real drops to a panel EDGE to SPLIT. Duplicate drop focuses existing (`blocked:'duplicate'`, `ts:207-214`). |
| Full-panel drop overlay (pink wash + 2px border) while dragging | ux-state | 🔁 adapted | `app/renderer/src/WorkspacePanels.tsx:328-366` | Real shows narrow `w-8` edge strips (`bg-accent/20`) at each edge instead of a full-panel replace overlay. Consequence of replace→split adaptation. |
| 'Open here' drop pill label | chrome | 🔁 adapted | `app/renderer/src/WorkspacePanels.tsx:349-365` | Absent — DropEdge renders no text, only the accent wash; label dropped with the replace-overlay it belonged to. §0 drop-model adaptation. |
| Drop-edge pointer-events gating (only while a drag is in flight) | ux-state | ➕ real-added | `app/renderer/src/WorkspacePanels.tsx:68-80` + `:352-353` | P3-6 review HIGH fix: `pointer-events-auto` only when a drag is active, else strips would swallow ×/selector clicks. No prototype analog. |
| Resizer/divider between panels (col-resize, accent on hover/active) | control | ✅ built | `app/renderer/src/WorkspacePanels.tsx:368-397` | `w-1 cursor-col-resize` `bg-shell-seam hover:bg-accent/45`, resizing→`bg-accent/70`; only between panels (`next?`, `:209`). |
| Resizer drag logic (mousemove delta %, 20% min per panel) | behavior | ✅ built | `app/renderer/src/WorkspacePanels.tsx:82-102` + `workspaceLayout.ts:277-293` | Clamps each side to `MIN_WORKSPACE_PANEL_WIDTH=20` (`ts:5`), matching proto `Math.max(20,…)`. |
| Reset widths to equal on panel-count change | behavior | 🔁 adapted | `app/renderer/src/workspaceLayout.ts:339-358` + `:230-234` | Prototype reset ALL panels equal on count change; real preserves relative widths, only halves the split panel. `equalWidths` fallback only on invalid/sub-min widths. |
| Panel renders ChatView with session/messages/status (panel content) | sub-component | ✅ built | `app/renderer/src/WorkspacePanels.tsx:203-205` → `App.tsx:750-816` | Real builds `content=<SessionPane/>` per panel from session-keyed stores; proto's large prop bag = Chat.jsx (P4-0) elements, one delegation binding here. |
| Panel hover/active transition styling (smooth border/bg) | ux-state | ✅ built | `app/renderer/src/WorkspacePanels.tsx:313,352,386-387` | Real uses `transition-colors` on close button / DropEdge / Divider; proto used per-property inline `transition`. |
| compact ChatView layout when split (`compact: panels>1`) | ux-state | ⬜ deferred | `phase4.md` P4-0 (ChatView enrichment) | A Chat-surface density concern, not a WorkspaceLayout element; `SessionPane` takes no compact prop. |
| Per-panel account resolution (`resolveActiveAccountId` per session) | data-binding | ⬜ deferred | `phase4.md` P4-0 / P4-5 | Prop passed through to ChatView in the prototype; belongs to the chat/account surfaces, not the layout container. |
| Layout persistence across relaunch (localStorage) | real-added | ➕ real-added | `app/renderer/src/workspaceLayout.ts:45-92` + `App.tsx:145,390` | Key `catcode.workspaceLayout.v1`; renderer-owned, registry-unaware. Prototype held widths/panels in ephemeral React state only. |
| Restore-on-relaunch atomic snap (`readyToRestoreLayout`/pendingRestore) | real-added | ➕ real-added | `app/renderer/src/workspaceLayout.ts:143-152` + `App.tsx:152,372-384` | P3-6 relaunch fix: saved split re-forms only once every referenced session is live again. No prototype analog. |
| Graceful degradation on reaped/dead sessions (reconcile) | real-added | ➕ real-added | `app/renderer/src/workspaceLayout.ts:94-131` + `App.tsx:346,819` | `reconcileWorkspaceLayout` filters non-live sessions; panels also `.filter(panel.descriptor)` at `App.tsx:819`. Proto assumed all `sessionId` resolve. |
| Max-panels / duplicate notice bar | real-added | ➕ real-added | `app/renderer/src/WorkspacePanels.tsx:117-121` + `App.tsx:138,482` | `'Workspace layout supports up to three panels.'`; proto silently no-oped past 3. |
| Keyboard resize on divider (ArrowLeft/Right ±5%, role=separator, tabIndex) | real-added | ➕ real-added | `app/renderer/src/WorkspacePanels.tsx:215-227` + `:389-392` | Accessibility addition; prototype resize was mouse-only. |
| Panel/divider/dropedge/selector aria-labels (identity + state) | real-added | ➕ real-added | `app/renderer/src/WorkspacePanels.tsx:156,292,314,358,391` + `:407-424` | Honesty-rule labeling (P3-6/P4-4); prototype had no aria. |

### 05. Messages.jsx — Scrolling transcript: bubbles, prose/markdown, per-family tool cards, diffs, thinking, boundary/lifecycle seams, and the TUI-tag-derived row zoo

> **⛳ OWNER (assigned 2026-07-07): P4-18 — Transcript rendering** (`backlog/phase4.md` Tranche E), split 18a→18b→18c. The ❓ rows below are P4-18's build scope, not silent gaps — P2-0..P2-3 built the projector/data; nothing rendered it beyond assistant-text + tool-use. **P4-18a landed 2026-07-08:** the user-turn + core/boundary row cluster (UserBubble, CommandEcho, UserImage, Thinking, RedactedThinking, SessionInit, Result, CompactBoundary, SystemNotice — 9 rows ❓→✅) plus render-ready Snip/Tombstone seams. Residual ❓ split: **18b** owns tool-card FAMILIES (Bash/FileRead/FileWrite/Grep/Web/Mcp/Notebook/Lsp/Skill/GenerateImage/Agent chrome + FrameEShell); **18c** owns prose/markdown depth (GFM tables, code highlighting, streaming caret, copy chips, long-content collapse, render-error boundary) + activity/scroll. Rows not projected at all (TurnDuration, Interrupted, other SystemNotice subtypes, MemorySaved, MemoryInput, ResourceUpdate, Advisor, TaskAssign, HookProgress) stay ❓ — they need a projector data-contract change, out of the P2-locked render layer.

**Migration target:** `app/renderer/src/TranscriptView.tsx` + `transcriptProjector.ts` (+ `ToolInspector.tsx`, `sdkMessageFixtures.ts`) · **Overall:** 🔁 adapted — PARTIAL (data layer thorough; 18a renders the full non-tool-card row zoo via an exhaustive switch; per-family tool cards = 18b, prose/activity polish = 18c) · **Prototype:** `~/catcode_prototype/cat-app/Messages.jsx` (2175 lines) · **INVENTORY:** W3 transcript rows / tool-cards / boundaries / errors (adapt)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Transcript container (rows list, gap-3 flex column) | chrome | ✅ built | `app/renderer/src/TranscriptView.tsx:42-48` | `TranscriptRowsView` maps rows; prototype has no single container component (host renders `MessageRow`), so parity is at row level. |
| Empty state ("No transcript rows yet.") | ux-state | ➕ real-added | `app/renderer/src/TranscriptView.tsx:36-40` | Explicit empty-transcript state in the real app; prototype is always fixture-loaded. Real-only, recorded. |
| AssistantBubble — assistant text body | subcomponent | 🔁 adapted | `app/renderer/src/TranscriptView.tsx:52-57` | Body built via react-markdown; adapted — bare markdown div, no bubble shape/framing/eyebrow/copy chip. |
| AssistantBubble — "Assistant" eyebrow label | chrome | ❓ missing-no-owner | — | Uppercase role label not rendered; no P4/P5 owner for transcript row chrome. |
| AssistantBubble — hover-reveal copy chip | control | ❓ missing-no-owner | `app/renderer/src/TranscriptView.tsx:52-57` | Icon copy button (hover opacity + copied-check) not built. |
| Streaming caret on assistant text | ux-state | ❓ missing-no-owner | `app/renderer/src/transcriptProjector.ts:69` (isStreaming, P2-3) | Streaming DATA built (live delta rows); the blinking caret VISUAL not rendered at `TranscriptView.tsx:52-57`. |
| UserBubble — user message (right-aligned bubble) | subcomponent | ✅ built | `app/renderer/src/TranscriptView.tsx:215` (`UserBubble`); dispatched at `:76` | P4-18a functional fix: the pre-18a `if kind!=='tool-use' return null` drop is replaced by an exhaustive switch. User turns render as a right-aligned, accent-tinted, bottom-right-notched bubble. Hover copy chip is 18c polish. |
| UserBubble — hover-reveal copy chip | control | ❓ missing-no-owner | `app/renderer/src/TranscriptView.tsx:61` | Moot until UserBubble renders; still unowned. |
| Prose — core markdown (headings/bold/italic/inline-code/lists/links/hr/blockquote) | subcomponent | 🔁 adapted | `app/renderer/src/TranscriptView.tsx:11,54-55` | react-markdown replaces prototype's hand-rolled `renderProse`; basic set via className, blockquote/hr on defaults. |
| Prose — GFM tables (`ProseTable`, `splitTableRow`) | subcomponent | ❓ missing-no-owner | — (no `remark-gfm` in `app/renderer/src`) | Pipe tables won't parse; react-markdown alone drops them. No owner. |
| ProseCode — fenced code block + syntax highlighting (`FELines`/`ProseCode`) | subcomponent | ❓ missing-no-owner | — (no shiki/prism/rehype-highlight imported) | INVENTORY W3 target implies shiki but it is unwired; code renders as plain `<code>`. No owner. |
| ProseCode — 5 code themes + Settings-synced picker | data-binding | ❓ missing-no-owner | `app/renderer/src/SettingsShell.tsx` (label only) | `CODE_THEMES` + `catcode.codeTheme` localStorage/sync-event not built; settings label exists, no binding. |
| ProseCode — per-block Copy button + language label | control | ❓ missing-no-owner | — | GUI-only affordance (prototype notes source TUI lacks it). Unbuilt, unowned. |
| ProseTextBlock — ```text/```prose block + copy-as-md/text menu | subcomponent | ✂️ cut | `Messages.jsx:1834-1840` (prototype WARNING: not wired to model, mock-only) | Model never emits ```text fences; renderer-only until an upstream system-prompt change. Source wins — correct not to migrate. |
| Prose — long-content collapse (>60 lines, Show N more/Collapse) | control | ❓ missing-no-owner | — | GUI-only addition (source never truncates bodies). Minor; unbuilt, unowned. |
| Prose — render-error try/catch → plain-text fallback | ux-state | ❓ missing-no-owner | `app/renderer/src/TranscriptView.tsx:54-55` | No error boundary around `<Markdown>`; a throw surfaces as a React error instead of degrading. |
| ToolCard — generic tool card (family + name + status + input + result) | subcomponent | 🔁 adapted | `app/renderer/src/TranscriptView.tsx:63-98` | ONE generic card: uppercase family + toolName + status badge + `JSON.stringify(input)` + result/diff. Replaces per-family dispatch. |
| toolFamily derivation (12 families incl. server-tool vocab) | data-binding | ✅ built | `app/renderer/src/transcriptProjector.ts:983-1025` (`deriveToolFamily`) | Derived from real wire names (client `*_TOOL_NAME` + Anthropic `server_tool_use`). Data built; per-family VISUALS missing (rows below). |
| Tool status badge (state word + tone) | chrome | 🔁 adapted | `app/renderer/src/TranscriptView.tsx:101-113` (`ToolStatusBadge`) | Adapted to 3 states (pending/success/error); fuller prototype vocab (queued/running/needs-permission/cancelled/denied/truncated) not represented; `--tone-warn` unset (P1-0 TODO). |
| FrameEShell — expand/collapse card shell (mark · WORD · target · state-dot) | chrome | ❓ missing-no-owner | `app/renderer/src/TranscriptView.tsx:63-98` | Shared quiet-panel shell (family mark, uppercase word, target ellipsis, pulsing dot, click-to-collapse) not built; card is always-open JSON. |
| BashOutputCard — tail-peek collapsed preview | ux-state | ❓ missing-no-owner | — (no `BashOutputCard` in `app/renderer`) | Collapsed tail-of-output peek + mask gradient not built. |
| BashOutputCard — stdout/stderr stream tabs | control | ❓ missing-no-owner | `app/renderer/src/transcriptProjector.ts:915` (flattens result to one string) | stdout/stderr toggle + line counts not built; stderr identity not separated at the projector. |
| BashOutputCard — inline truncation reveal band (N hidden / Show N more / Open full) | control | ❓ missing-no-owner | — | Head+tail windowing + progressive reveal + capped-bytes note not built. |
| BashOutputCard — tiny-output inline variant | ux-state | ❓ missing-no-owner | — | "≤4 clean lines, no chrome" special case not built. |
| BashOutputCard — denied / cancelled / queued / running visual states | ux-state | ❓ missing-no-owner | `app/renderer/src/TranscriptView.tsx:101-113` (3 states only) | Blocked-by-rule struck command, SIGINT-killed, queued, running-italic states not built. |
| BashOutputCard — inline permission prompt (Allow once/Always/Deny) | control | 🔁 adapted | `app/renderer/src/PermissionQueue.tsx` + `PermissionPrompt.tsx` (P2-4) | Real app routes permission to the dedicated queue (D2/P2-4 domain separation), not folded into the bash card. Adapted, not a gap. |
| OutputInspector — full-output drawer (Esc, search+match-step, wrap, copy, capped footer) | subcomponent | 🔁 adapted | `app/renderer/src/ToolInspector.tsx` (P4-1) | ADAPTED but UNWIRED: `ToolInspector` exists yet is referenced only by its own test — nothing in `TranscriptView`/`App` opens it from a tool card. Flag: build the open-from-card affordance. |
| FileReadCard — numbered file contents / grouped read rows | subcomponent | ❓ missing-no-owner | — (no `FileReadCard` in `app/renderer`) | Line-numbered read body + grouped multi-file list not built; Read renders as generic card. |
| FileWriteCard — created/overwritten + additions view | subcomponent | ❓ missing-no-owner | — (no `FileWriteCard`) | +prefixed new-file body with byte/line sub not built. |
| DiffView — single-file diff render | subcomponent | 🔁 adapted | `app/renderer/src/TranscriptView.tsx:121-150`; `transcriptProjector.ts:938-962` | filePath header + +/- colored hunks; data (structuredPatch narrowing) real. Polish gaps in sub-rows below. |
| DiffView — word-level intra-line diff (`Diff.diffWordsWithSpace`) | subcomponent | ❓ missing-no-owner | `app/renderer/src/TranscriptView.tsx:132-145` | Raw +/- lines only; no intra-line word highlighting. |
| DiffView — dual old/new gutter line numbers + +/- count header | chrome | ❓ missing-no-owner | `app/renderer/src/TranscriptView.tsx:124-146` | Paired gutters + +adds/-dels file-header counts not built. |
| MultiDiffCard / FileEditCard multi-file switcher | control | 🔁 adapted | `transcriptProjector.ts:123-148`; `TranscriptView.tsx:127` | Per source, `FileEditTool` returns ONE file's patch, so a many-FILES switcher has no real shape — reinterpreted as one-file-many-hunks (many-files switcher cut w/ flag). |
| GrepCard — results list / grouped patterns | subcomponent | ❓ missing-no-owner | — (no `GrepCard`) | Grep/Glob renders as generic card; results-count + grouped-pattern list not built. |
| WebCard — WebFetch/WebSearch (status·content-type·size) | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts:1002-1006` (family derived only) | web-specific sub-header not built. |
| McpCard — server › tool call/resource | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts:1022` (family derived only) | server›tool framing + result coloring not built. |
| NotebookCard — cell index + cell diff | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts:1007-1008` (family derived only) | cell[n]+diff view not built. |
| LspCard — diagnostics list with severity dots (`FEDiag`) | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts:1009-1010` (family derived only) | severity-dot diagnostics list not built. |
| SkillCard — skill source badge + activity | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts:1011-1013` (family derived only) | source/plugin sub not built. |
| GenerateImageCard — inline image + spec chips + saved-path/Open/Copy | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts:1017-1018` (family derived only) | The core GUI-over-TUI win (real inline image): image tile, size/quality chips, saved-path, Open/Copy actions unbuilt. Result fields (filePath/model/size) are real source but nothing renders them. |
| AgentMsgCard / AgentTranscriptCard — delegate card (task/prompt/activity/result/stats) | subcomponent | 🔁 adapted | `transcriptProjector.ts:1014-1016`; renders via generic card; D2 (`decisions/AGENT-CHROME.md`) | Adapted per D2 (Agent = P2-2 tool-card family member). Rich activity ticker/verdict/stats chrome not built; agentStats cost/tokens are mock fixtures (source wins). |
| Subagent nesting — child frames nest under owning agent card | data-binding | ✅ built | `transcriptProjector.ts:344-375` (`selectNestedTranscriptRows`); `TranscriptView.tsx:90-96` | D2/C4 nesting built: child rows nest by `parentToolUseId`, never interleave; orphans degrade to top level. Inline DelegateGroup chrome is `phase4.md P4-8` scope. |
| ThinkingBlock — reasoning block (expand/collapse, eyebrow, prose) | subcomponent | ✅ built | `app/renderer/src/TranscriptView.tsx:288` (`ThinkingBlock`); dispatched at `:87` | P4-18a: accent-tinted card, uppercase "Thinking" eyebrow + Codex reasoningKind tag, italic subtle prose body. §0 flag: rendered EXPANDED — the prototype's collapse/caret is interactive polish deferred to 18c. |
| RedactedThinkingBlock — encrypted-thinking placeholder | subcomponent | ✅ built | `app/renderer/src/TranscriptView.tsx:316` (`RedactedThinkingBlock`); dispatched at `:93` | P4-18a: quiet neutral lock row ("redacted by the model provider"); the encrypted `data` payload is never printed. |
| SessionInitRow — session-start banner (cwd/model/tools/version) | subcomponent | ✅ built | `app/renderer/src/TranscriptView.tsx:336` (`SessionInitBanner`); dispatched at `:96` | P4-18a: ✦ "Session started" banner — cwd (mono, truncated) + model/tools-count/permission-mode meta pairs. (Row carries permissionMode, not version — projector shape wins.) |
| ResultRow — turn/session-end seam (subtype + duration) | subcomponent | ✅ built | `app/renderer/src/TranscriptView.tsx:419` (`ResultSeam`); dispatched at `:112` | P4-18a: centered seam, success/danger tone, "Completed"/"Errored" label + `· {duration}s · ${cost}` detail. |
| CompactBoundaryRow — ✻ conversation-compacted seam | subcomponent | ✅ built | `app/renderer/src/TranscriptView.tsx:452` (`CompactBoundarySeam`); dispatched at `:122` | P4-18a: ✻ accent "memory" seam, "Conversation compacted" + `· {trigger} · {preTokens} tokens`. |
| SnipBoundaryRow — ✂ stale-output-snipped seam | subcomponent | ✂️ cut | `transcriptProjector.ts:222` (typed); `STATUS.md:84` P2-1: typed but UNMINTED at SDK seam | No mint site emits `snip_boundary` today → disposition stays cut. P4-18a adds a render-ready ✂ neutral seam (`TranscriptView.tsx:129`) so a future engine seam degrades gracefully instead of hitting the fallback; not flipped ✅ because it never arrives today. |
| TombstoneRow — message-removed dashed seam | subcomponent | ✂️ cut | `transcriptProjector.ts:223` (typed); `STATUS.md:84` P2-1: typed but UNMINTED | Same as SnipBoundary: no mint site. P4-18a adds a render-ready dashed neutral seam ("message removed", `TranscriptView.tsx:136`); disposition stays cut pending an engine seam. |
| MicrocompactBoundaryRow — ❉ microcompacted seam | subcomponent | ✂️ cut | `STATUS.md:83` P2-0 (uninhabitable in the type); `INVENTORY.md:58` CUT | The seam can never carry this discriminant (base-subtype intersection collapses it). INVENTORY marks it stale/cut. |
| TurnDurationRow — ◷ worked-for duration seam | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts:696-783` (`turn_duration` falls to default no-op) | `turn_duration` system subtype is neither projected nor rendered — dropped. No owner. |
| InterruptedRow — "Interrupted · what should Claude do instead?" | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts:609` (`isSynthetic` frames dropped) | The synthetic INTERRUPT carrier is suppressed at the projector; no interrupted seam renders. Real interruption identity lost at the seam. Unowned. |
| SystemNoticeRow — api_retry / local_command_output / account_diagnostic | subcomponent | ✅ built | `app/renderer/src/TranscriptView.tsx:383` (`SystemNoticeBox`); dispatched at `:105` | P4-18a: notice box with per-type glyph+tone (api_retry ↻ warn · local_command_output › muted · account_diagnostic ! warn) + message body + trailing mono debug tag. Covers the LocalCommandRow render (§5 below) too, though that row's identity degradation is an upstream projector concern. |
| SystemNoticeRow — other subtypes (memory_saved/agents_killed/bridge_status/scheduled_task_fire/permission_retry/stop_hook_summary/api_error/away_summary) | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts:696-783` (none of these subtypes projected) | 8 prototype SystemNotice subtypes neither projected nor rendered; real source subtypes exist but unmapped at the seam. Unowned. |
| MemorySavedRow — ✦ saved-to-memory row | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts:696-783` (`memory_saved` not projected) | Not projected/rendered. Memory PAGE is `phase4.md P4-10` but that owns the page, not this transcript seam — no confirmed owner for the row. |
| AwaySummaryRow — ※ recap seam | subcomponent | ✂️ cut | `Messages.jsx:1409-1416` (gated behind `feature('AWAY_SUMMARY')` + GrowthBook, default false) | Gated OFF upstream; prototype invented the /recap trigger. Cut pending the flag (source wins). |
| CommandEchoRow — /command echo (user-side) | subcomponent | ✅ built | `app/renderer/src/TranscriptView.tsx:231` (`CommandEchoBubble`); dispatched at `:80` | P4-18a: user-side mono bubble — accent `/name` + subtle args, or `Skill(name)` for skill-format. Prototype's `❯` prompt glyph deliberately dropped (GUI-native signal). |
| LocalCommandRow — ! local-command output | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts:759-768` (projected as system-notice); `STATUS.md:84` (live identity degraded) | Data partially projected, not rendered; live identity degraded per P2-1. Unowned. |
| MemoryInputRow — # user-memory-input echo | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts:1400-1425` (`parseCommandEcho` handles only `<command-message>`) | Real ungated source tag but `<user-memory-input>` not parsed → degrades to plain user-text (itself unrendered). Unowned. |
| ResourceUpdateRow — ↻ MCP resource/polling update | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts:1400-1425` (only command-message parsed) | `<mcp-resource-update>`/`<mcp-polling-update>` not parsed, not rendered. Niche; unowned. |
| ChannelMessageRow — ↳ channel notification | subcomponent | ✂️ cut | `Messages.jsx:1294-1301` (gated behind `feature('KAIROS')`/`KAIROS_CHANNELS`) | Feature-gated upstream; tag not at the app seam. Cut pending flag. |
| CrossSessionMessageRow — ⇄ cross-session message | subcomponent | ✂️ cut | `Messages.jsx:1315-1321` (gated `feature('UDS_INBOX')`; renderer unverified in source) | Feature-gated + prototype could not verify a source renderer. Cut pending flag; presentation unverifiable. |
| ForkMessageRow — ⑂ fork directive | subcomponent | ✂️ cut | `Messages.jsx:1335-1342` (gated `feature('FORK_SUBAGENT')`; renderer unverified) | Feature-gated + unverified renderer. Cut pending flag. |
| AdvisorRow — advisor `server_tool_use` + `advisor_tool_result` (folded) | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts:1019-1023` ('advisor'→'other'); `:880-894` (advisor_tool_result not in result-block types) | Degrades to a generic 'other' card with no correlated result; advisor advising/done/redacted/error states missing. Unowned. |
| TaskAssignRow — ◆ task-notification assignment | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts` `projectUserFrame` (no origin handling) | Not projected/rendered. Tasks is `phase4.md P4-9` but that owns the panel, not this transcript notice row — no confirmed owner for the row. |
| HookProgressRow — live Hook progress leg | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts:448-451` (`tool_progress` documented no-op) | Live ProgressMessage (excluded from persistence upstream); no app-seam projection/render. Would need a live-status seam. Unowned. |
| UserImageRow — pasted image content block | subcomponent | ✅ built | `app/renderer/src/TranscriptView.tsx:261` (`UserImageRowView`); dispatched at `:83` | P4-18a: right-aligned user-side tile — `<img>` from the base64 data-URI / url source (max-w 220px). Caption-less by design; empty source degrades to `[Image]`. |
| ToolResultRow — ⎿ tool_result fed back into conversation | subcomponent | 🔁 adapted | `transcriptProjector.ts:853-869` (`foldToolResultBlocks`); `TranscriptView.tsx:75-89` | Adapted per INVENTORY W3 (status derived, not stored): result folds into its tool card's result region (is_error red) rather than a standalone row. Correct adaptation. |
| ApiErrorRow — API error banner + Retry + raw-details expand | subcomponent | ❓ missing-no-owner | `transcriptProjector.ts:747-757` (api_retry→system-notice, unrendered); `:464-468` (assistant_error no-op) | Real API-error identity partially reaches the seam but nothing renders it, and there is no Retry affordance. BannerStack (P4-1) not wired to transcript API errors. Unowned. |
| RateLimitRow — rate-limited banner + Switch account | subcomponent | ✂️ cut | `transcriptProjector.ts:483-487` (`rate_limit_event` SDK-stdout-only no-op); `INVENTORY.md:59` (standalone RateLimitRow stale) | Source folds rate limiting into API-error/retry handling; no standalone row. Confirmed cut/stale. |
| SystemMsg — plain centered divider | chrome | ❓ missing-no-owner | — | Minor generic hairline+label divider not built; low value, unowned. |
| AgentEventRow — one-line agent lifecycle notice | subcomponent | ✂️ cut | `INVENTORY.md:60` + `decisions/AGENT-CHROME.md` (D2): CUT — no agent-event seam frame | Decision-cut; lifecycle surfaces via the agent tool-card state instead. |
| AttachmentCard — attachment dispatch (diagnostics/mcp/read) | subcomponent | ✂️ cut | `INVENTORY.md:60` + `decisions/AGENT-CHROME.md` (D2): CUT — engine-internal, never reaches the seam | Decision-cut (extend-engine flag); attachments don't cross the seam as a distinct type. |
| GroupedToolGroup — grouped read/search message type | subcomponent | ✂️ cut | `INVENTORY.md:60` + `decisions/AGENT-CHROME.md` (D2): message type CUT, grouping kept as projector derivation | Message-type cut per D2. NOTE: the promised grouping-as-projector-derivation is NOT yet implemented (`selectNestedTranscriptRows` does subagent nesting only) and has no named owner — a residual sub-gap. |
| ReadGroupRow — expand-to-content read row (3rd disclosure level) | control | ❓ missing-no-owner | — (no `FileReadCard`/`ReadGroupRow` in `app/renderer`) | GUI-native 3rd disclosure level beyond source (source Read renders 'Read N lines' only). Unbuilt, unowned. |

### 06. Chat.jsx — session transcript pane + composer + live activity/streaming indicator

**Migration target:** `app/renderer/src/App.tsx` (`SessionPane`) + `TranscriptView.tsx` / `transcriptProjector.ts` (built base + streaming DATA); enrichment `deferred → P4-0`; header/actions `→ P4-6`; activity VISUAL unowned · **Overall:** 🔁 adapted (base composer + streaming-DATA built; enrichment/header/activity-visual not) · **Prototype:** `~/catcode_prototype/cat-app/Chat.jsx` (1485 lines) · **INVENTORY:** W3 streaming engine + W4 Composer (build-new + spec S1/S2)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Session header bar (44px, bottom hairline, cwd/title zone) | chrome | 🔁 adapted | `app/renderer/src/App.tsx:1040` | Real analog is a status text line (cwd + conn status + msg count + partial frames), not a chrome bar. |
| Session title display in header ('New chat' / `session.title`) | data-binding | ⬜ deferred | `phase4.md P4-6` · `STATUS.md:220` | Real `SessionDescriptor` has no generated title → cwd basename (`App.tsx:1042`); titles = P4-6 rider. |
| Inline rename input (autofocus, Enter/Escape/blur commit) | control | ⬜ deferred | `phase4.md P4-6` | Rename verb belongs to `SessionActionsMenu` (P4-6); no rename UI in `SessionPane`. |
| `OrchestratorBadge` in header | chrome | ⬜ deferred | `phase4.md P4-8` | Orchestrator-mode chrome; `window.OrchestratorBadge` unbuilt. |
| Transcript-mode 'Hidden' reveal toggle (eye icon, only when meta rows exist) | control | ❓ missing-no-owner | — | Real engine hides `isMeta`/`isVisibleInTranscriptOnly` rows; no reveal toggle built and no P4 owner. DANGER. |
| Meta-row dimmed rendering when revealed (opacity 0.55) | ux-state | ❓ missing-no-owner | — | Tied to the unowned Hidden toggle; no meta-reveal styling in `TranscriptView.tsx`. DANGER. |
| Session-actions overflow button (⋯) | control | ⬜ deferred | `phase4.md P4-6` | Trigger for the P4-6 actions menu; absent in `SessionPane`. |
| `SessionActionsMenu` (anchored popover) | dialog | ⬜ deferred | `phase4.md P4-6` | — |
| `BranchDialog` | dialog | ⬜ deferred | `phase4.md P4-6` | Real branch/export/rewind verbs owned by P4-6. |
| `RewindDialog` | dialog | ⬜ deferred | `phase4.md P4-6` | — |
| `ExportDialog` | dialog | ⬜ deferred | `phase4.md P4-6` | — |
| `MetadataInspector` | dialog | ⬜ deferred | `phase4.md P4-6` | INVENTORY W4 row. |
| Header action: Copy as Markdown / Copy as text | control | 🔁 adapted | `app/renderer/src/App.tsx:1050` · `App.tsx:742` | Real ships one "Copy for LLM" action (`copyForLlm`) + palette copy; the md-vs-text menu split is P4-6 chrome. |
| Header actions: tag / archive / delete / open (toast stubs) | control | ⬜ deferred | `phase4.md P4-6` | Prototype implements as toast stubs; real verbs = P4-6. |
| Focus-mode header (back-to-orchestrator, 'Viewing @worker', AgentHandle, TypeChip, 'Esc to return') | ux-state | ⬜ deferred | `phase4.md P4-8` | `setFocusWorker`/`WorkerFocusView` unbuilt in renderer. |
| `WorkerFocusView` (main column swaps to worker thread) | subcomponent | ⬜ deferred | `phase4.md P4-8` | — |
| Escape leaves focus mode / closes tasks modal | keyboard | ⬜ deferred | `phase4.md P4-8` | Depends on focus/tasks modes (P4-8/P4-9). |
| `BgTasksDialog` ('N running' / `/tasks` in-session list) | dialog | ⬜ deferred | `phase4.md P4-9` | — |
| `TasksPanel` (orchestrator workers modal + lease snapshot) | dialog | ⬜ deferred | `phase4.md P4-9` | `leaseSnapshot` (`MOCK_CODEX_LEASES`) is mock data — source wins. |
| `PlanPanel` (editable plan + live checklist drawer) | subcomponent | ⬜ deferred | `phase4.md P4-11` | INVENTORY W4 row. |
| `PlanBar` 'View plan' reopen bar | chrome | ⬜ deferred | `phase4.md P4-11` | Demo driver `window.PLAN_DEMO`; real key = per-session plan file + plan mode. |
| `BannerStack` (session banners with action/dismiss) | subcomponent | ✅ built | `app/renderer/src/BannerStack.tsx` · `App.tsx:1059` | Primitive built P4-1; the concrete Chat-level banner is `ConnectionRecovery` (`App.tsx:1159`). |
| Transcript scroll container + message list | subcomponent | 🔁 adapted | `app/renderer/src/App.tsx:1141` · `transcriptProjector.ts` | Rows derive from real `SDKMessage` via the projector, not a flat message array. |
| `selectReadGroups` tool grouping | data-binding | 🔁 adapted | `decisions/AGENT-CHROME.md` (D2) · `transcriptProjector.ts` | `GroupedToolGroup` type CUT; grouping survives only as a projector derivation. |
| `MessageRow` rendering (per-message row zoo) | subcomponent | 🔁 adapted | `app/renderer/src/TranscriptView.tsx` · `transcriptProjector.ts` | W3 surface; adapted to real nested SDK content-block shape. |
| Empty state = `WelcomeScreen` (recents, prompt suggestions, orchestrator toggle) | ux-state | ⬜ deferred | `phase4.md P4-17` · `decisions/WELCOME-LAUNCHER.md` (D5) | Real app has a minimal empty shell ('New session / ⌘T', `App.tsx:940`); rich welcome = P4-17, recents DERIVED. |
| Jump-to-bottom '↓ Latest' button | control | ❓ missing-no-owner | — | No jump/scroll control in `TranscriptView.tsx` and no P4 owner. DANGER. |
| Jump button running-cue variant (verb/elapsed/paused while generating) | ux-state | ❓ missing-no-owner | — | Off-screen running cue; tied to the missing jump button + missing activity state. DANGER. |
| Auto-scroll stick-to-bottom + reveal-jump on scroll-up (`onScroll`/`stickRef`) | ux-state | ❓ missing-no-owner | — | No scroll-stick logic in the renderer transcript. DANGER. |
| Instant-jump on session open vs smooth-scroll on live turn | ux-state | ❓ missing-no-owner | — | Part of the unowned scroll UX. DANGER. |
| Composer container + gradient backdrop (absolute bottom) | chrome | 🔁 adapted | `app/renderer/src/App.tsx:1064` | Real composer is a plain flex form — no gradient/absolute overlay; polish → P4-0. |
| Base text input field | control | 🔁 adapted | `app/renderer/src/App.tsx:1073` | Real is a single-line `<input>`; prototype is multiline contentEditable → multiline is P4-0. |
| Placeholder text (context/orchestrator/focus variants) | data-binding | 🔁 adapted | `app/renderer/src/App.tsx:1083` | Single static placeholder; orchestrator/focus variants deferred (P4-8). |
| Send button | control | ✅ built | `app/renderer/src/App.tsx:1087` | Disabled on no-session/`!inputEnabled`/`!connection`/empty prompt; prototype icon vs text-button is a visual adapt. |
| Enter to submit | keyboard | ✅ built | `app/renderer/src/App.tsx:1064` · `App.tsx:1021` | Form `onSubmit={submit}`; `onComposerKeyDown` completes slash on Enter when picker open, else form submits. |
| Cmd+K open command palette from composer | keyboard | ✅ built | `app/renderer/src/CommandPalette.tsx` · `STATUS.md:162` | Palette is global ⌘K (P3-7), works from the composer; not composer-local. |
| Shift/Alt/Meta+Enter inserts newline (multiline) | keyboard | ⬜ deferred | `phase4.md P4-0` | Real single-line `<input>` can't insert a newline; needs P4-0 multiline composer. |
| Composer auto-resize to 38vh with overflow | ux-state | ⬜ deferred | `phase4.md P4-0` | No autosize on the single-line input. |
| IME composition guard (`onCompositionStart/End`, `isComposingRef`) | keyboard | ⬜ deferred | `phase4.md P4-0` | Prototype guards Enter during IME composition; part of the P4-0 contentEditable composer. |
| Focus-rule gradient underline | chrome | ⬜ deferred | `phase4.md P4-0` | Composer visual polish; not present in real composer. |
| `SlashCommandPicker` (typeahead popover) | subcomponent | ✅ built | `app/renderer/src/App.tsx:1066` · `SlashCommandPicker.tsx` | Real catalog rides `system/init` `slash_commands` (P3-7). |
| Slash keyboard nav (ArrowUp/Down/Tab/Enter/Escape) | keyboard | ✅ built | `app/renderer/src/App.tsx:1004` | `onComposerKeyDown` handles all five keys for the slash picker. |
| Slash prefix-then-substring filtering | data-binding | ✅ built | `app/renderer/src/SlashCommandPicker.tsx` · `STATUS.md:162` | `filterSlashCommands` prefix-then-substring (P3-7). |
| `/tasks` · `/bashes` → in-session background-task dialog | control | ⬜ deferred | `phase4.md P4-9` | — |
| `/workspace` → launcher project picker | control | ⬜ deferred | `phase4.md P4-17` · `STATUS.md:220` (HC1) | Renderer can't author a cwd (HC1); live-session `/workspace` is a no-op toast in the prototype. |
| `/context` → open context gauge popover | control | ⬜ deferred | `phase4.md P4-0` · `STATUS.md:217` | Composer ChipStrip scope → P4-0 (P4-1 §0 flag 'composer ChipStrip→P4-0'). |
| `/recap` → inject Away Summary sys-notice | control | ✂️ cut | `Chat.jsx:691-701` (DEMO-ONLY) | Prototype invention: upstream away-summary is flag-gated auto-fire, NOT a command — source wins. |
| `onCommandRoute` (`/agents`→Settings etc. map to app surfaces) | control | ⬜ deferred | `phase4.md P4-6` | Destination pages (P4-3/P4-6/P4-7) not yet built; slash→page routing unwired. |
| `MentionPicker` (@ popover, files/agents tabs) | subcomponent | ✅ built | `app/renderer/src/App.tsx:1290` (`<MentionPicker>`) | P4-1 primitive wired into the composer; flat single-source list (agents), tabs omitted. |
| @ trigger detection (last @token in field) | data-binding | ✅ built | `app/renderer/src/composerState.ts:42` (`parseMentionQuery`) · `App.tsx:1102` | Trailing `@token` at line-start/after-space; end-of-draft only (single-line input — §0 flag). |
| Mention file/agent tabs + `handlePickMention` insert | control | 🔁 adapted | `app/renderer/src/composerState.ts:67` (`selectAgentMentionItems`) · `App.tsx:1117` (`pickMention`) | AGENTS wired from the `agent-config.snapshot` (P4-7), keyed by `agentType` (available-only). FILES deferred: the engine `@`-file index is engine-side (`src/hooks/unifiedSuggestions.ts:121` over `git ls-files`), not on the wire — surfacing it needs a read-seam this session must not invent (rule 3). Free-typed `@path` still submits as plain text. No source tabs (flat list). |
| Paste-collapse: large paste → `[Pasted text #N]` token | control | ✅ built | `app/renderer/src/composerState.ts:106,141` (`shouldCollapsePaste`/`reducePasteAdded`) · `App.tsx:1135` (`handlePaste`) | Threshold verbatim from source: >800 chars (`src/utils/imagePaste.ts:30`) OR newlines > `min(rows-10,2)`=2 (`src/components/PromptInput/PromptInput.tsx:1236-1240`); token `formatPastedTextRef` (`src/history.ts:51-55`). |
| Inline paste pill DOM node (icon/label/count/× remove) | subcomponent | 🔁 adapted | `app/renderer/src/App.tsx:1250-1275` | Plain single-line `<input>` can't host inline DOM pills; adapted to an out-of-band collapsed-paste chip strip (`<details>` per paste) above the composer. §0 flag. |
| Paste preview popover (hover/caret-driven) | ux-state | 🔁 adapted | `app/renderer/src/App.tsx:1250` (`<details>` expand) | Hover/caret-driven popover replaced by a click-to-expand `<details>` on the chip; no caret tracking in the plain input. §0 flag. |
| `removePaste` + Backspace-deletes-whole-pill | keyboard | 🔁 adapted | `App.tsx:1263` (× remove) · `composerState.ts:176` (`reducePastesPruned`) | × on the chip removes; deleting the token text from the draft prunes the entry. No whole-pill Backspace (no contentEditable). |
| `expandPasteRefs` on submit (refs → full text inline) | data-binding | ✅ built | `app/renderer/src/composerState.ts:210` (`expandPasteRefs`) · `App.tsx:627` (`submitSession`) | Tokens expand back to full content before `app.submit`; engine receives plain text (parity `src/history.ts:81` / `src/utils/handlePromptSubmit.ts:217`). |
| Prompt history ↑/↓ recall (per-session, 50-cap, draft preserve) | keyboard | ✅ built | `app/renderer/src/composerState.ts:247,266` (`reduceHistoryPushed`/`navigateHistory`) · `App.tsx:1206` | Per-session (keyed by activeSessionId, P3-4), 50-cap, dedup newest, draft preserved on ↑ and restored on ↓ past newest (parity `src/hooks/useArrowKeyHistory.tsx`). |
| `SpinnerWithVerb` live activity row (verb + elapsed + token byline above composer) | subcomponent | ❓ missing-no-owner | — | P2-3 (✅, `STATUS.md:86`) shipped streaming DATA only; the activity-VISUAL half of INVENTORY W3 (`INVENTORY.md:62`) was never built or re-owned. DANGER — top of list. |
| `ActivityIndicator` (tail-of-transcript variant) | subcomponent | ✂️ cut | `Chat.jsx:49` (defined, never rendered) | Superseded by `SpinnerWithVerb` (`Chat.jsx:1370`); dead prototype code, not a parity target. |
| `WaveDots` pulse animation + phase tone colors | chrome | ❓ missing-no-owner | — | Part of the missing activity indicator; tool-color map is cosmetic fixture. DANGER. |
| Activity phase mapping (connecting/thinking/tool/responding/idle) | ux-state | ❓ missing-no-owner | — | Real `SpinnerMode` phases exist engine-side but no renderer maps them to a visible indicator. DANGER. |
| Elapsed timer + verb (playful/plain) | data-binding | ❓ missing-no-owner | — | No elapsed timer in renderer; playful verbs are cosmetic fixture, the elapsed indicator is the real gap. DANGER. |
| Live per-turn token byline '(Ns · ↕ N tokens)' | data-binding | ❓ missing-no-owner | — | Real per-turn output estimate exists engine-side (SOURCE `SpinnerAnimationRow.tsx:160`) but nothing surfaces it. DANGER. |
| Run tally (files changed / +added / −removed) | data-binding | ❓ missing-no-owner | — | Prototype values are demo; the diff-stat run-tally indicator itself is unowned. DANGER. |
| Paused-on-permission activity state ('Waiting for your approval') | ux-state | ❓ missing-no-owner | — | Permission round-trip is real (P2-4) but this paused-activity cue is part of the unbuilt spinner. DANGER. |
| Stop button / interrupt affordance while generating | control | ❓ missing-no-owner | `app/preload/preload.cjs:67` (`abort` exists, unwired) | `bridge.abort`/`app.abort` capability exists at the boundary but NO renderer UI control or keybinding calls it (rg empty in `App.tsx`). Genuine interrupt gap. DANGER. |
| `ContextGauge` donut + % pill (inline with composer) | subcomponent | ⬜ deferred | `phase4.md P4-0` · `STATUS.md:217` | Composer ChipStrip scope → P4-0; real `contextTokens`/`contextMax` exist, gauge visual is P4-0. |
| `ContextGauge` expanded Session-Info popup (context arc + Model/Effort/Profile rows) | subcomponent | ⬜ deferred | `phase4.md P4-0` · `STATUS.md:217` | model/effort color maps are cosmetic fixture (source wins); model/effort/profile are real status fields. |
| Composer ChipStrip byline (status/perm/account/provider/ide/lsp/tasks chips) | subcomponent | ⬜ deferred | `phase4.md P4-0` · `app/renderer/src/Chip.tsx:11` | P4-1 built a GENERIC ChipStrip container but flags the composer-specific rail → P4-0. |
| Composer action: Add-attachment button | control | 🔁 adapted | `app/renderer/src/App.tsx:1316` | Rendered as a parity STUB, matching the prototype's own stub (`Chat.jsx:1435` fires a placeholder toast). A real file picker needs an engine attachment capability that is NOT on the wire — inventing one is out of scope (rule 3, no new vocabulary). The working attach path today is a large paste (title spells it out). §0 flag. |
| Composer action: Recap button (manual away-summary trigger) | control | ✂️ cut | `Chat.jsx:1436-1437` (invented manual trigger) | Prototype 'we add a manual trigger' for the flag-gated away-summary; invented control, source wins. |
| Running-tasks 'N running' chip → open bg tasks | control | ⬜ deferred | `phase4.md P4-9` | `MOCK_TASKS` fixture is mock data. |
| `OrchestratorModeWorkerRoster` strip above composer (real + transcript-derived) | subcomponent | ⬜ deferred | `phase4.md P4-8` | Both live-workers and transcript-derived roster feed one component (D2). |
| Scripted run timeline (`streamReply`/`FINAL_REPLY`/at-timers) | demo | ✂️ cut | `INVENTORY.md:62` · `STATUS.md:86` (P2-3) | Demo scaffolding replaced by the REAL streaming engine (`transcriptProjector.ts`). |
| Permission playground (`buildPermReq`/`runPlaygroundTurn`, s-perm session) | demo | ✂️ cut | `INVENTORY.md` CUT (demo `s-perm`) · `PermissionQueue.tsx` | Real permission round-trip is P2-4/S2. |
| Microcompact-on-send + auto-compact warning threshold injection | demo | ✂️ cut | `Chat.jsx:640-646` (DEMO-ONLY) | Real autocompact is engine-driven, not a composer boundary injection. |
| Real streaming text deltas → live in-progress assistant rows | data-binding | ✅ built | `app/renderer/src/transcriptProjector.ts` · `STATUS.md:86` (P2-3 ✅) | `stream_event`/`streamingTextBlocks` reconcile to authoritative full frames; real replacement for demo `streamReply`. |
| Partial-frame progress readout | data-binding | ➕ real-added | `app/renderer/src/App.tsx:1047` | Real-only 'N partial frames' count; no prototype analog (stands in for the unbuilt spinner byline). |
| `handleSend` submit path (dedup history, clear input, stick) | control | 🔁 adapted | `app/renderer/src/App.tsx:1064` (`submit` prop) | Real submit rides `app.submit`; demo playground/compaction branches cut. |
| Per-session composer draft persistence | data-binding | ✅ built | `app/renderer/src/App.tsx:135` · `App.tsx:599` · `App.tsx:1217` | `promptDrafts` + `reducePromptDrafts`/`selectPromptDraft` key drafts per session (P3-4). |
| Composer disabled/gated on session + inputEnabled + connection | ux-state | ➕ real-added | `app/renderer/src/App.tsx:1076` · `App.tsx:1089` | Real engine input-enabled + connection gating; prototype had no such gating. |

### 07. Permissions.jsx — inline keyboard-driven permission-request queue, adapted to the real protocol round-trip

**Migration target:** `app/renderer/src/PermissionQueue.tsx` + `PermissionPrompt.tsx` + `PermissionRulesEditor.tsx` + `permissionState.ts` (P2-4) · **Overall:** 🔁 adapted · **Prototype:** `~/catcode_prototype/cat-app/Permissions.jsx` (601 lines) · **INVENTORY:** W4 Permissions PermissionQueue adapt + spec S2

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Permission queue container (holds N simultaneously-pending cards) | subcomponent | ✅ built | `app/renderer/src/PermissionQueue.tsx:29-30` | `aria-label="Permission requests"` flex-col over `items[]`; queue = S2 §2 arrival-ordered pending set (`permissionState.ts:214-225`). |
| Multiple-pending badge / count ("N pending") | chrome | 🔁 adapted | `app/renderer/src/PermissionQueue.tsx:31-35` | Real shows "N permission requests pending" text line vs. prototype's right-aligned header pill. |
| Background-session pending-attention count (TabBar badge) | data-binding | ✅ built | `app/renderer/src/permissionState.ts:250-259` | `selectPendingPermissionCount` fed into per-session connection view at `App.tsx:314`, drives P3-5a TabBar badge. |
| One-at-a-time head-of-queue framing (resolve-then-next) | ux-state | 🔁 adapted | `app/renderer/src/PermissionQueue.tsx:37-47` | Real maps ALL active items to stacked cards at once (S2 §2: unordered set); keyboard acts on `selectVisiblePermission` (`App.tsx:615-617`). |
| Strict lane-priority ordering (sandbox›tool›prompt›worker›elicit) | control | ✂️ cut | `specs/2026-07-03-S2-permission-update.md §7` | Lane priority was UI policy mirroring REPL; dropped for arrival order (`permissionState.ts:220`). |
| Per-lane accent colors + lane tags | chrome | ✂️ cut | `specs/2026-07-03-S2-permission-update.md §7` | MOCK-only lane vocabulary; real card uses one themeable accent (`PermissionPrompt.tsx:83`). |
| Per-variant icon set (shield/edit/folder/globe/sparkle/monitor/…) | chrome | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:83` | Single accent left-border stands in; visual simplification within the INVENTORY "adapt" mandate. |
| Per-variant uppercase kicker (Permission/Filesystem/Web access/…) | chrome | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:88-97` | Real derives header from engine `request.title`/`display_name`, not a client variant map. |
| Card title "Allow &lt;tool&gt;?" | chrome | ✅ built | `app/renderer/src/PermissionPrompt.tsx:88-97` | h2 = `request.title`, then "Allow &lt;display_name ?? tool_name&gt;?" (S2 §4). |
| Inline-command title form (bash/powershell/worker preview in title) | chrome | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:129-131` | Command still visible via generic JSON input block; specialized inline title styling dropped. |
| Contextual subtitle line (relayed/plan/elicit descriptions) | chrome | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:98-102` | Real "Why:" line from engine `decision_reason`; prototype subtitles are variant-specific fixtures. |
| `decision_reason` / "why you're being asked" binding | data-binding | ✅ built | `app/renderer/src/PermissionPrompt.tsx:98-102` | Engine-backed by `SDKControlPermissionRequest.decision_reason` (S2 §1). |
| `blocked_path` / filesystem-scope hint | data-binding | ✅ built | `app/renderer/src/PermissionPrompt.tsx:103-107` | Engine-backed "Path:" mono line from `request.blocked_path` (S2 §4). |
| Generic payload preview block (previewLabel + code) | subcomponent | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:129-131` | Raw `JSON.stringify(request.input)` `<pre>`; per-variant labeled previews collapse to one JSON view. |
| "classifier-routed" badge on preview | chrome | ✂️ cut | `specs/2026-07-03-S2-permission-update.md §7` | MOCK fixture field (`head.classifier`); no classifier field on the real request. |
| web-fetch method badge (GET/POST) | chrome | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:129-131` | MOCK `head.method`; real method rides inside the JSON input block. |
| skill description line (`skillDesc`) | chrome | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:129-131` | MOCK `head.skillDesc`; not a distinct real field, rides the generic JSON. |
| cwd "in &lt;path&gt;" line | chrome | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:129-131` | MOCK `head.cwd`; not separately surfaced. |
| File-edit diff preview (PQDiff hunks, showDiff variant) | subcomponent | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:129-131` | Permission card shows raw JSON only; real diff rendering lives in the transcript tool card (P2-2), not the prompt. |
| Sandbox network detail (host / proto pill / :port / session-scoped) | subcomponent | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:80-131` | Renders through generic card + JSON; host/proto/port pills are MOCK fixture fields. |
| "Open network access?" network title variant | chrome | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:88-97` | No dedicated network title; folds into generic `request.title`/"Allow &lt;tool&gt;?". |
| computer-use screenshot/action preview | subcomponent | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:129-131` | MOCK variant preview; renders through generic JSON, no dedicated screenshot UI. |
| "Yes" allow-once option | control | ✅ built | `app/renderer/src/PermissionPrompt.tsx:118-125` | Allow button → `onAllow([])`; `buildAllowResponse` empty `applySuggestions` (S2 §5). |
| "Yes, and don't ask again for &lt;scope&gt;" rule option | control | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:133-148` | One "Always allow: &lt;describeSuggestion&gt;" button PER engine-minted suggestion → `onAllow([index])` (C1 selection-by-index). |
| `ruleImplication` client-side rule synthesis (scopeFromRule/dirOf) | data-binding | ✂️ cut | `decisions/PERMISSION-BOUNDARY.md §2` | Rendering a guessed rule that differs from what persists is a correctness bug; replaced by engine suggestions (`PermissionPrompt.tsx:24-31`). |
| "No, and tell Cat Code what to do differently" deny option + free-text | control | ✅ built | `app/renderer/src/PermissionPrompt.tsx:110-117` | Deny button + deny-feedback input (`:150-157`); `buildDenyResponse` model-visible refusal (S2 §5). |
| Numbered select-list OptionRow (1-9, ↵ hint, esc chip, active highlight) | subcomponent | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:109-148` | Discrete Allow/Deny + N "Always allow" buttons instead of a cursor-navigable numbered list. |
| Keyboard: ↑/↓ · j/k · ⌃P/⌃N cursor move + 1-9 direct pick | keyboard | ✂️ cut | `app/renderer/src/PermissionPrompt.tsx:14-22` | `permissionActionForKey` maps only Enter/N/Backspace/Escape; no cursor or numeric selection (`App.tsx:669-702` handler). |
| Keyboard: Enter = confirm highlighted option | keyboard | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:18` | Enter → 'allow'; `App.tsx:685` `allowPermission([])` allow-once (no cursor concept). |
| Keyboard: Esc = reject the current request | keyboard | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:21` | Escape → 'dismiss'; `App.tsx:689-692` dispatches 'dismissed' (local snooze, stays pending) — NOT a reject. |
| Keyboard: N / ⌫ = deny (real-added key) | keyboard | ➕ real-added | `app/renderer/src/PermissionPrompt.tsx:19` | 'n'/Backspace → 'deny'; footer hint `:159-161`. Real app adds explicit deny keys the prototype routed only through Esc. |
| Esc-snooze "Keep pending" / snoozed-cards lane | control | 🔁 adapted | `app/renderer/src/PermissionQueue.tsx:49-67` | Prototype's `onKeepPending` was a no-op; real form is a per-card local snooze that keeps the engine request live. |
| Snooze restore ("review →" / Answer) | control | ✅ built | `app/renderer/src/PermissionQueue.tsx:59-65` | Answer button → `onRestore`; `permissionState.ts:89-98` 'restored' clears the dismissed flag (`App.tsx:1105`). |
| "Reject all" footer action (mass-deny queue) | control | 🔁 adapted | `decisions/PERMISSION-BOUNDARY.md §5` | Maps to existing `app.abort` frame (mass-denies pendings), not a new verb; no dedicated in-card button. |
| "Manage rules →" footer link | control | 🔁 adapted | `app/renderer/src/App.tsx:1108-1123` | `<details>` "Permissions" disclosure hosting `PermissionRulesEditor`, not a card footer link. |
| Footer key-hint strip ("↑↓ · 1–9 · ↵ · esc") | chrome | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:159-161` | Hint updated to the real reduced keyset: "Enter allow · N / ⌫ deny · Esc snooze". |
| Portal overlay positioning (fixed, aligned to composer box) | chrome | 🔁 adapted | `app/renderer/src/App.tsx:1101-1106` | Rendered inline in the chat column flow, not a fixed portal overlay / composer-rect measurement. |
| Composer-focus steal (blur composer, focus card, 200ms debounce) | control | 🔁 adapted | `app/renderer/src/App.tsx:669-702` | Window keydown ignores INPUT/TEXTAREA targets; double-submit guarded by `submittedRequestIds`, not a timer. |
| In-flight double-submit guard (buttons disabled while answering) | ux-state | ➕ real-added | `app/renderer/src/PermissionPrompt.tsx:112` | Disabled on `submitted`; `permissionState.ts:41,53` `submittedRequestIds` + `submissionFailed` rollback — an explicit in-flight state the prototype only faked. |
| `permission.resolved` = universal cross-surface dismiss | ux-state | ✅ built | `app/renderer/src/permissionState.ts:193-199` | Removes the card on `permission.resolved` regardless of who answered (S2 §2 rule 2). |
| Stale / "Resolved while you were offline" card state (line-through) | ux-state | ✂️ cut | `specs/2026-07-03-S2-permission-update.md §7` | Modeled as resolved-elsewhere + benign `permission_not_found` race, not a separate queue-entry kind. |
| Safety-check / bypass-immune state (lock icon, drops don't-ask) | ux-state | 🔁 adapted | `app/renderer/src/PermissionPrompt.tsx:133-148` | `bypassImmune`/`safetyReason` are MOCK flags; real behavior = engine mints no suggestions, so "Always allow" is simply absent. |
| Warn banner (`head.warn` ⚠) | chrome | ✂️ cut | `specs/2026-07-03-S2-permission-update.md §4` | MOCK `head.warn` fixture string; the "why" channel is `decision_reason` (`PermissionPrompt.tsx:98-102`). |
| Worker-relay chrome ("worker" badge + "Relayed from worker X" subtitle) | chrome | ⬜ deferred | `docs/migration/backlog/phase4.md P4-8` | MOCK `head.relayed`/`workerName` today; worker→parent relay (if ever real) lands with the orchestrator surface. May prove invention (D6). |
| AskUserQuestion — header chip + question text + multi-question stepper dots | subcomponent | ❓ missing-no-owner | — | DANGER. `AskQuestionFlow` wraps a REAL engine tool (`AskUserQuestionTool`); zero hits for it in `docs/migration/` (INVENTORY/STATUS/phase4). |
| AskUserQuestion — option rows (label + description, 1-9 pick, active/checked) | subcomponent | ❓ missing-no-owner | — | DANGER. No AskUserQuestion renderer in `app/renderer/src`; not owned in `phase4.md`. |
| AskUserQuestion — multi-select toggle (checkbox, space-toggle, joined answer) | control | ❓ missing-no-owner | — | DANGER. Real tool `outputSchema` joins multi answers; interaction seam not migrated. |
| AskUserQuestion — built-in "Other…" freeform answer row | control | ❓ missing-no-owner | — | DANGER. No freeform answer input for this flow; unowned. |
| AskUserQuestion — per-option preview badge + preview pane | subcomponent | ❓ missing-no-owner | — | DANGER. No preview pane implementation; unowned. |
| AskUserQuestion — footer rail (Next question / Submit, key hints, Cancel/esc) | control | ❓ missing-no-owner | — | DANGER. The answer-submission action that would send the tool result is unbuilt. |
| AskUserQuestion — dedicated keyboard handler (space toggle, advance, Esc reject) | keyboard | ❓ missing-no-owner | — | DANGER. `App.tsx` permission keydown has no AskUserQuestion mode; unowned. |
| Plan-enter card ("Enter plan mode?", Yes/No, planEnterDesc) | ux-state | ⬜ deferred | `docs/migration/backlog/phase4.md P4-11` | Plan MODE exists (C2 `setMode('plan')` built); the plan-ENTER approval CARD is the P4-11 plan surface. |
| Plan-exit card — approval-as-mode-choice (auto-accept / bypass / manual / keep planning) | ux-state | ⬜ deferred | `docs/migration/backlog/phase4.md P4-11` | Mode choice maps to C2 `setMode`; the ExitPlanMode CARD flow is not built. `bypassPermissions` rejected at boundary. |
| Plan-exit — plan file header + numbered plan steps render | subcomponent | ⬜ deferred | `docs/migration/backlog/phase4.md P4-11` | Real plan lives in a file read on review (ExitPlanMode); PlanPanel owns it. |
| Plan-exit — "Plan requests permission to" allowedPrompts chips | subcomponent | ✂️ cut | `decisions/PERMISSION-BOUNDARY.md §2` | plan-exit `allowedPrompts addRules` = renderer-authored rule content, stays out of the boundary. |
| Elicitation card (field label + placeholder, "Submit answers"/Cancel) | ux-state | ⬜ deferred | `docs/migration/backlog/phase4.md P4-12` | Elicitation fields are MOCK today; P4-12 (`ElicitationDialog`) wires the real flow (control-request vs tool, to recon). |
| Elicitation keyboard (Enter submit / Esc reject, footer "enter · esc") | keyboard | ⬜ deferred | `docs/migration/backlog/phase4.md P4-12` | Part of the deferred elicitation surface. |
| C2 mode switcher (default / acceptEdits / plan / dontAsk) | control | ✅ built | `app/renderer/src/PermissionRulesEditor.tsx:41-65` | `PERMISSION_SET_MODE_MODES` buttons → `onSetMode`; wire allowlist `protocol.ts:77-84`; `App.tsx:803,1120`. `bypassPermissions` rejected (PERMISSION-BOUNDARY §3). |
| C3 read-only rules view (allow/deny/ask groups by source) + mode pill | subcomponent | ✅ built | `app/renderer/src/PermissionRulesEditor.tsx:67-119` | `RuleGroup` over `context.always{Allow,Deny,Ask}Rules`; mode pill `App.tsx:1111-1115`; snapshot = engine live context (PERMISSION-BOUNDARY §4). |
| C3 additional working directories list | data-binding | ✅ built | `app/renderer/src/PermissionRulesEditor.tsx:71-83` | Renders `context.additionalWorkingDirectories` with source, from the C3 snapshot. |
| Accessibility: role=alertdialog + aria-labelledby / aria-label / focus-visible outlines | chrome | ➕ real-added | `app/renderer/src/PermissionPrompt.tsx:81-85` | `role="alertdialog"` + `aria-labelledby`; queue `aria-label` (`PermissionQueue.tsx:30`); focus-visible outlines — a11y the prototype (`tabIndex=-1` div) lacked. |

### 08. PermissionRules.jsx — Settings→Permissions rules editor, narrowed to a read-only permission-context viewer + mode switch

**Migration target:** `app/renderer/src/PermissionRulesEditor.tsx` (mounted `app/renderer/src/App.tsx:1118`) · **Overall:** 🔁 adapted (read-only; inline CRUD/denial/debug ✂️ cut) · **Prototype:** `~/catcode_prototype/cat-app/PermissionRules.jsx` (318 lines) · **INVENTORY:** W4 PermissionRulesEditor adapt (S2)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Rule serialization (`ToolName` / `ToolName(content)`, paren-escaped) | data-binding | 🔁 adapted | `PermissionRulesEditor.tsx:112`; `protocol.ts:211-213` | Serialization is ENGINE-side; C3 snapshot delivers already-serialized strings; prototype's client `serializeRule` is a source-mirror only, renderer never re-derives. |
| Serialized rule text (mono code) | data-binding | ✅ built | `PermissionRulesEditor.tsx:112` | Core read element: rule string rendered in `font-mono`. |
| Behavior pill (colored ALLOW/DENY/ASK badge per rule) | chrome | 🔁 adapted | `PermissionRulesEditor.tsx:67-69` | Behavior conveyed by group heading ("Always allow/deny/ask"), not a colored per-row pill; color chrome dropped, info preserved. |
| Per-rule source badge (`RuleSrcBadge`/`SourceBadge`) | chrome | 🔁 adapted | `PermissionRulesEditor.tsx:112-113`; `protocol.ts:210-213` | Styled badge replaced by plain `(source)` text; keyed by PermissionRuleSource from snapshot. |
| Per-tool grouping (tool-name header + count + divider) | subcomponent | 🔁 adapted | `PermissionRulesEditor.tsx:88-119` | Grouping AXIS changed: prototype groups by tool name; real app groups by BEHAVIOR then flattens by source (snapshot is `Record<source,string[]>` per behavior). |
| Allow/ask/deny count chips (aggregate summary) | chrome | 🔁 adapted | `PermissionRulesEditor.tsx:67-69` | Cosmetic aggregate of already-rendered rules; count badges dropped, individual rules fully shown. |
| PaneSection section headers (5 titled sections) | chrome | 🔁 adapted | `PermissionRulesEditor.tsx:40-84`; `App.tsx:1107-1121` | 5 Settings `PaneSection` titles collapse to one `<details>` "Permissions" + flat `<h3>` group labels; titled-section scaffolding not reused. |
| Rule row hover highlight | ux-state | ✂️ cut | `PermissionRulesEditor.tsx:106-119` (static `<ul>`); `INVENTORY.md:69` read-only | Read-only static list has no per-row hover/edit affordance to reveal. |
| Match-type label per row (exact/prefix/wildcard) | chrome | ❓ missing-no-owner | not in `PermissionRulesEditor.tsx`; not on `protocol.ts:208-215`; no P4 owner; no cut ruling | Derived annotation, renderer-computable; silently dropped, unowned, uncut — minor but flagged. |
| Lock icon on managed/non-editable rules | ux-state | ✂️ cut | `decisions/PERMISSION-BOUNDARY.md:286-289` (read-only, no CRUD) | Editable/locked distinction moot in a fully read-only list; source still shown for all rules. |
| Edit-rule button (per row) | control | ✂️ cut | `decisions/PERMISSION-BOUNDARY.md:288` | Editing a rule = renderer authoring durable policy (T6b escalation). |
| Remove-rule button (per row) | control | ✂️ cut | `decisions/PERMISSION-BOUNDARY.md:288-291` | Removing a deny rule = T6b escalation; sanctioned future shape = select-to-remove over C3, not built. |
| Rules section "Add rule" header button | control | ✂️ cut | `decisions/PERMISSION-BOUNDARY.md:288` | Entry point to the cut inline editor. |
| Inline RuleEditor — "New rule"/"Edit rule" header + frame | subcomponent | ✂️ cut | `decisions/PERMISSION-BOUNDARY.md:288`; `STATUS.md:87` (ruleImplication guesser CUT) | Entire inline add/edit editor did not migrate; the read path replaces it. |
| Editor: behavior segmented control (allow/ask/deny) | control | ✂️ cut | `decisions/PERMISSION-BOUNDARY.md:288` | Renderer choosing a rule behavior = authorship, rejected fail-closed. |
| Editor: tool select dropdown | control | ✂️ cut | `decisions/PERMISSION-BOUNDARY.md:288` | Rule scope authorship not permitted at the boundary. |
| Editor: content text input | control | ✂️ cut | `decisions/PERMISSION-BOUNDARY.md:44-48` (no renderer byte becomes rule content) | The invariant C1 selection-not-authorship preserves. |
| Editor: match-type resolution hint | chrome | ✂️ cut | `decisions/PERMISSION-BOUNDARY.md:288`; `STATUS.md:87` | Part of the cut editor; client-side match guessing was flagged a correctness bug. |
| Editor: "Save to" destination select | control | ✂️ cut | `decisions/PERMISSION-BOUNDARY.md:44-48` | Renderer cannot express a destination; destinations ride engine-minted objects — persistence-escalation vector. |
| Editor: implication preview ("Will write to <path>" + JSON) | subcomponent | ✂️ cut | `STATUS.md:87` (ruleImplication guesser CUT, correctness bug); `decisions/PERMISSION-BOUNDARY.md` §2 | Client-side disk-write guesser replaced by engine `permission_suggestions` (C1); not restyled. |
| Editor: Cancel button | control | ✂️ cut | `decisions/PERMISSION-BOUNDARY.md:288` | No editor to cancel. |
| Editor: "Add rule"/"Save" submit button | control | ✂️ cut | `decisions/PERMISSION-BOUNDARY.md:288`; always-allow served via C1 on QUEUE cards (`App.tsx:803`, `PermissionPrompt.tsx`) | Adding an allow rule = T6b escalation; only engine-suggested always-allow on a pending request survives, on the permission card not here. |
| Permission mode selector (Default mode) | control | 🔁 adapted | `PermissionRulesEditor.tsx:43-57`; `App.tsx:803`+`App.tsx:1120` onSetMode→`setPermissionMode`; `protocol.ts:77-84` | Real, wired via C2 `permission.setMode` (session dest). Dropdown → aria-pressed buttons; restricted to 4 wire-allowlisted modes; `bypassPermissions`/`auto` excluded at boundary. |
| Mode Field wrapper (desc + source badge + modified + reset) | chrome | 🔁 adapted | `PermissionRulesEditor.tsx:41-65` (bare mode row) | Minimal surface omits the Settings `Field` scaffolding (desc text, source badge, modified indicator, reset) around the mode control. |
| Managed-rules-only enforcement toggle (disabled, policy-managed) | control | ❓ missing-no-owner | not in `PermissionRulesEditor.tsx`; not on `protocol.ts:208-215`; `phase4.md` P4-12 covers MCP/Plugins/Skills/Hooks/Elicitation only; no cut ruling | Real engine concept (managed-policy enforcement) not on C3 wire and unowned — genuine silent drop of a real capability. |
| Recent denials — consecutive-denials progress bar + cap | subcomponent | ✂️ cut | `INVENTORY.md:69` ("...denial UI is prototype chrome"); not on `protocol.ts:208-215` | Cap is a real engine mechanism but counters are session-only + `PERMISSION_DENIAL_TRACKING` is mock fixture; tracker not migrated. |
| Recent denials — total-this-session progress bar + cap | subcomponent | ✂️ cut | `INVENTORY.md:69` ("denial UI is prototype chrome") | Same as consecutive bar; "stops auto-classifier denial" cap is real engine state, not on the C3 wire. |
| Recent denials — "session-only, resets on restart" note | chrome | ✂️ cut | `INVENTORY.md:69` | Explanatory footnote for the cut denial tracker. |
| Additional working directories — row (folder icon + path + source) | subcomponent | 🔁 adapted | `PermissionRulesEditor.tsx:71-83`; `protocol.ts:214` | BUILT read display; folder icon dropped, source rendered as plain `(source)` text. |
| Additional working directories — per-dir Remove button | control | ✂️ cut | `decisions/PERMISSION-BOUNDARY.md:286-291` (read-only, no CRUD) | Removing an additional directory = renderer-authored policy change. |
| Additional working directories — per-dir lock icon (policy dirs) | chrome | ✂️ cut | `decisions/PERMISSION-BOUNDARY.md:286-289` | Editability/lock distinction moot in a read-only list; source still shown. |
| Additional working directories — empty state ("No additional directories") | ux-state | 🔁 adapted | `PermissionRulesEditor.tsx:71` (block rendered only when length > 0) | Empty state = whole section omitted rather than an italic placeholder row. |
| Classifier & debugging — Permission classifier toggle | control | ❓ missing-no-owner | not in `PermissionRulesEditor.tsx`; not on `protocol.ts:208-215`; P2-4 closed, `phase4.md` P4-3/P4-12 don't cover it; no cut ruling | Real setting (`TRANSCRIPT_CLASSIFIER`) — genuine dropped control, not editor/debug/denial chrome, unowned + uncut — flagged. |
| Classifier & debugging — "Explain decisions" (debug) toggle | control | ✂️ cut | `INVENTORY.md:69` ("...debug ... UI is prototype chrome") | Debug/explain toggle is prototype chrome; not migrated. |
| Classifier & debugging — debug decision panel (last request/decision/reason.type/matched) | subcomponent | ✂️ cut | `INVENTORY.md:69`; panel values scripted mock (`PermissionRules.jsx:306-309`) | Decision-reason vocabulary is a real engine concept but panel content is mock fixture (source wins); panel not built. |
| Loading state — "Waiting for the engine's permission context…" | ux-state | ➕ real-added | `PermissionRulesEditor.tsx:31-37` | Real-only: prototype always has mock data; real surface gates render on the first C3 snapshot. |
| Empty rule-group state — "No rules." per behavior | ux-state | ➕ real-added | `PermissionRulesEditor.tsx:98-104` | Real-only: prototype fixtures always contain rules, so no prototype analogue. |
| Non-allowlisted current-mode fallback ("current: <mode>") | ux-state | ➕ real-added | `PermissionRulesEditor.tsx:58-64` | Real-only honesty affordance: surfaces `bypassPermissions`/`auto` if the engine is actually in one, though the renderer can't switch to it. |
| `isBypassPermissionsModeAvailable` (snapshot datum) | data-binding | ➕ real-added | `protocol.ts:215` | Real-only gate datum on the C3 snapshot (no prototype field); informs bypass availability without offering a switch. |
| Host container: collapsible Permissions `<details>` + mode chip | chrome | 🔁 adapted | `App.tsx:1107-1121` | Prototype mounts body inside a Settings `PaneSection`; real app mounts a plain `<details>` summary "Permissions" with a `font-mono` mode chip, no PaneSection/Field reuse. |

### 09. CommandPalette.jsx — ⌘K launcher, re-scoped from a mock slash-command registry into a real action + session-search palette

**Migration target:** `app/renderer/src/CommandPalette.tsx` + `app/renderer/src/commandPaletteModel.ts` (wired `App.tsx:38-39,139,717,828-849,922-925`) · **Overall:** 🔁 adapted · **Prototype:** `~/catcode_prototype/cat-app/CommandPalette.jsx` (275 lines) · **INVENTORY:** W2 CommandPalette adapt

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Backdrop overlay (fixed inset-0, dim scrim, blur) | chrome | ✅ built | `app/renderer/src/CommandPalette.tsx:103` | `bg-black/55 … pt-[12vh] backdrop-blur-sm`; real z-40 vs proto z-100 (token scale). |
| Backdrop click-to-dismiss | control | 🔁 adapted | `app/renderer/src/CommandPalette.tsx:104,111,203` | `onClick`→`onMouseDown` so a row click lands before backdrop close (documented `:202`). |
| Dialog container (rounded card, seam border, shadow) | chrome | 🔁 adapted | `app/renderer/src/CommandPalette.tsx:106-112` | `max-w-xl` (576px) vs proto 640; `shell-chrome`/`shell-seam` tokens (P3-5 grammar) not hex. |
| Dialog a11y (role=dialog, aria-modal, aria-label) | chrome | ➕ real-added | `app/renderer/src/CommandPalette.tsx:108-110` | Prototype has no ARIA; GUI-verified AXGroup "Command palette" (`STATUS.md:162`). |
| Search header row (input + icon + ESC pill, seam divider) | chrome | ✅ built | `app/renderer/src/CommandPalette.tsx:113-127` | Layout parity, `border-b border-shell-seam`. |
| Search icon (magnifier svg) | chrome | ✅ built | `app/renderer/src/CommandPalette.tsx:114,262-279` | Same 24×24 circle+line path; `currentColor`/`text-text-subtle` vs hex stroke. |
| Search input field | input | ✅ built | `app/renderer/src/CommandPalette.tsx:115-123` | Controlled `value={query}`; GUI-verified AXTextField "Command palette search". |
| Search input placeholder copy | chrome | 🔁 adapted | `app/renderer/src/CommandPalette.tsx:121` | "sessions and commands…"→"sessions and actions…" (slash commands aren't palette rows). |
| ESC kbd pill (header) | chrome | ✅ built | `app/renderer/src/CommandPalette.tsx:124-126` | Parity; `shell-hover` token bg. |
| Results scroll container (max-height, overflow, hidden scrollbar) | chrome | 🔁 adapted | `app/renderer/src/CommandPalette.tsx:129-134` | Single `max-h-[52vh]` vs proto per-mode 420/460px; adds `role=listbox` (real-added a11y). |
| Footer hint bar (↑↓ / ↵ / esc legend, seam top border) | chrome | ✅ built | `app/renderer/src/CommandPalette.tsx:164-177` | Label "select"→"run". |
| Footer kbd pills | chrome | ✅ built | `app/renderer/src/CommandPalette.tsx:171-173` | Per-hint `<kbd>`. |
| Empty / no-results state | state | ✅ built | `app/renderer/src/CommandPalette.tsx:135-139` | `filtered.length===0` → "No matches for …"; copy "No results"→"No matches". |
| Grouped default (no-query) view with section headers | state | 🔁 adapted | `app/renderer/src/CommandPalette.tsx:146-159` | Real groups Actions/Sessions (2), not proto's 11 slash groups (mock registry replaced). |
| Group header component (uppercase, tracked, subtle) | chrome | ✅ built | `app/renderer/src/CommandPalette.tsx:254-260` | Same visual grammar as proto `GrpLabel`. |
| 'Recent' commands section (label + recent rows) | state | ❓ missing-no-owner | — | DANGER: proto recents fed by mock `window.RECENT_COMMANDS` (`CommandPalette.jsx:122`); no recents render/store in real app; D5/P4-17 recents = welcome-launcher PROJECTS, not palette commands. |
| Recent-section divider rule | chrome | ❓ missing-no-owner | — | Sub-element of the missing Recent section (`CommandPalette.jsx:261`). |
| Command row (name + desc + meta + source) | subcomponent | 🔁 adapted | `app/renderer/src/CommandPalette.tsx:183-252` | `PaletteRow` renders REAL action/session payload, not mock slash cmd; structure preserved. |
| Real shell action inventory (New session ⌘T / Close / Restart / Copy transcript / Close panel) | subcomponent | ➕ real-added | `app/renderer/src/commandPaletteModel.ts:69-121` | Real host-wired actions with no prototype counterpart; each omitted when it can't run. |
| Command name (mono accent token) | chrome | 🔁 adapted | `app/renderer/src/CommandPalette.tsx:221-229` | Real action label (e.g. "New session"), not a `/cmd` mono token; accent reserved for active row. |
| Command alias (secondary token beside name) | chrome | ⬜ deferred | `docs/migration/specs/2026-07-07-slash-catalog-enrichment-proposal.md` | Slash-catalog metadata, names-only on wire (`STATUS.md:162`); adjacent owner P4-0. |
| Command description column | chrome | 🔁 adapted | `app/renderer/src/CommandPalette.tsx:231-249` | Sessions show cwd; actions show a shortcut kbd; per-cmd desc is slash metadata (deferred). |
| argHint pill (arg placeholder hint) | chrome | ⬜ deferred | `docs/migration/specs/2026-07-07-slash-catalog-enrichment-proposal.md` | Slash-catalog enrichment metadata, C3-flagged extend-engine; not required functionally. |
| requiresPermission 'perm' badge | chrome | ⬜ deferred | `docs/migration/specs/2026-07-07-slash-catalog-enrichment-proposal.md` | Per-command permission hint = slash metadata, names-only on wire. |
| Source badge (built-in/skill/workflow/plugin/mcp/dynamic, 6 types) | chrome | ⬜ deferred | `docs/migration/specs/2026-07-07-slash-catalog-enrichment-proposal.md` | Source classification not on the wire (`STATUS.md:162`); real rows have no source concept. |
| Active-row styling (accent left-border + tinted bg) | chrome | ✅ built | `app/renderer/src/CommandPalette.tsx:207-212` | `isActive`→`border-accent bg-shell-active` (token parity). |
| Hover sets cursor/active row | control | ✅ built | `app/renderer/src/CommandPalette.tsx:155,201` | `onMouseEnter={onHover}` → `setCursor(index)`. |
| Disabled-row styling (opacity, not-allowed, muted) | state | ✂️ cut | `app/renderer/src/commandPaletteModel.ts:59-64` | Omit-not-disable design rule: unavailable actions are OMITTED; "No mocked/dead entries" (`STATUS.md:162`). |
| Disabled tooltip (disabledReason popover) | state | ✂️ cut | `app/renderer/src/commandPaletteModel.ts:59-64` | Cut with the disabled-row concept; no tooltip code exists. |
| Row invoke click handler | control | ✅ built | `app/renderer/src/CommandPalette.tsx:69-74,203-206` | `onMouseDown`→`runAt` → `item.run()` then `onClose`. |
| Session row (SessRow) | subcomponent | ✅ built | `app/renderer/src/CommandPalette.tsx:214-249` | Built from live ∪ restorable roster (`commandPaletteModel.ts:123-147`), not a mock list. |
| Session row icon (blue chat-bubble svg) | chrome | 🔁 adapted | `app/renderer/src/CommandPalette.tsx:214-219,281` | Status-bearing tone DOT (color by session tone) replaces the decorative chat icon. |
| Session title | chrome | ✅ built | `app/renderer/src/CommandPalette.tsx:221-229` | Real derived `tabLabel(descriptor)` (`commandPaletteModel.ts:126`), not a mock title. |
| Session time (relative timestamp) | chrome | 🔁 adapted | `app/renderer/src/CommandPalette.tsx:231-234` | Source wins: proto `s.time` mock → real shows session cwd (`commandPaletteModel.ts:130`). |
| Session 'session' tag pill | chrome | 🔁 adapted | `app/renderer/src/CommandPalette.tsx:239-243` | Real live-state chip (live/crashed/restorable), toned, replaces the static "session" tag. |
| Session click → open (select + go to chat) | control | 🔁 adapted | `app/renderer/src/commandPaletteModel.ts:142-146` | Richer: restorable rows RE-SPAWN a closed session, live rows focus tab; GUI-verified (`STATUS.md:162`). |
| 'Sessions' group label in results | chrome | ✅ built | `app/renderer/src/commandPaletteModel.ts:127`, `CommandPalette.tsx:151` | Header in no-query grouped view; flat when searching (proto parity). |
| Open focuses input | behavior | ✅ built | `app/renderer/src/CommandPalette.tsx:47-53` | `requestAnimationFrame(()=>inputRef.focus())` instead of `setTimeout(40)`. |
| Reset query + cursor on open | behavior | ✅ built | `app/renderer/src/CommandPalette.tsx:47-53` | `setQuery('')`; `setCursor(0)`. |
| Reset cursor on query change | behavior | ✅ built | `app/renderer/src/CommandPalette.tsx:56-58` | `useEffect [query]` → `setCursor(0)`. |
| Escape closes palette | shortcut | ✅ built | `app/renderer/src/CommandPalette.tsx:92-95` | `case 'Escape' → onClose()`. |
| ArrowDown navigate | shortcut | ✅ built | `app/renderer/src/CommandPalette.tsx:79-82` | Modulo-wrap increment. |
| ArrowUp navigate | shortcut | ✅ built | `app/renderer/src/CommandPalette.tsx:83-87` | Modulo-wrap decrement. |
| Enter runs active item | shortcut | ✅ built | `app/renderer/src/CommandPalette.tsx:88-91` | `Enter → runAt(activeIndex)`. |
| Cursor wrap-around (modulo) | behavior | ✅ built | `app/renderer/src/CommandPalette.tsx:81,86` | Modulo wrap both directions. |
| Skip-disabled rows during arrow nav | behavior | ✂️ cut | `app/renderer/src/commandPaletteModel.ts:59-64` | No disabled/null-run rows exist (omit-not-disable), so nav is plain modulo. |
| scrollIntoView active row | behavior | ✅ built | `app/renderer/src/CommandPalette.tsx:61-65,200` | `querySelector('[data-palette-active="true"]').scrollIntoView({block:'nearest'})`. |
| Keyboard handler binding | behavior | 🔁 adapted | `app/renderer/src/CommandPalette.tsx:76-99,120` | Scoped to the focused input's `onKeyDown`, not a global `window` listener (avoids leak). |
| ⌘K open/toggle chord | shortcut | ✅ built | `app/renderer/src/App.tsx:711-718` | `meta/ctrl+k → setPaletteOpen(o=>!o)`; GUI-verified open/dismiss (`STATUS.md:162`). |
| Command match filter (label/keyword ranked) | behavior | 🔁 adapted | `app/renderer/src/commandPaletteModel.ts:158-180` | Ranked fuzzy (prefix→substring→keyword) over real actions incl. synonyms, not flat includes. |
| Session match filter (title substring) | behavior | 🔁 adapted | `app/renderer/src/commandPaletteModel.ts:139,172` | Real-added: also matches cwd + engineSessionId + state, not just title. |
| Search result caps (13 cmds / 4 sessions) | behavior | 🔁 adapted | `app/renderer/src/commandPaletteModel.ts:158-180` | Source wins: roster is bounded (one process/session); arbitrary mock caps dropped. |
| Per-group cap (5 rows/group, default view) | behavior | 🔁 adapted | `app/renderer/src/CommandPalette.tsx:141-160` | No cap needed; Actions group is small and fully shown. |
| Flat-search vs grouped-default rendering split | behavior | ✅ built | `app/renderer/src/CommandPalette.tsx:143-148` | `showHeader` only when query empty (avoids repeated headers) — proto parity. |
| PAGE_NAV routing (slash cmd → navigate to a page) | behavior | ⬜ deferred | `docs/migration/backlog/phase4.md` P4-5/6/7/10/12 | No page router in the shell yet; Accounts/Sessions/Goals/Agents/Settings pages are P4 backlog. |
| invoke() toast fallback for non-nav commands | behavior | 🔁 adapted | `app/renderer/src/CommandPalette.tsx:69-74` | Proto only toasted the cmd name (mock no-op); real rows invoke real App handlers. |
| Bridge-filter disabled rows (BRIDGE_BLOCKED → disabled+reason) | behavior | ✂️ cut | `docs/migration/decisions/PAIRED-DEVICES.md` | Demo-only (`CommandPalette.jsx:116` "DEMO-ONLY"); D3 cuts command-filter to read-only. |
| bridgeActive demo flag (`window.__BRIDGE_ACTIVE`) | data | ✂️ cut | `docs/migration/decisions/PAIRED-DEVICES.md`, INVENTORY CUT | Mock demo toggle; no real equivalent. |
| Mock command registry (`SLASH_COMMANDS_FULL`, ~43 cmds/11 groups) | data | 🔁 adapted | `STATUS.md:162` | Replaced by real shell actions (palette) + real slash catalog names-only in `SlashCommandPicker`. |
| `window.RECENT_COMMANDS` mock data | data | ✂️ cut | `CommandPalette.jsx:122` | Mock fixture; no recent-commands persistence (source-wins on mock data). |

### 10. SlashCommandPicker.jsx — floating keyboard-navigable slash-command typeahead over the composer

**Migration target:** `app/renderer/src/SlashCommandPicker.tsx` + wiring in `app/renderer/src/App.tsx` (SessionPane) · **Overall:** 🔁 adapted (built, name-only; rich metadata deferred) · **Prototype:** `~/catcode_prototype/cat-app/SlashCommandPicker.jsx` (191 lines) · **INVENTORY:** W2 SlashCommandPicker adapt

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Floating panel container (absolute, bottom-anchored, rounded, elevated) | chrome | ✅ built | `app/renderer/src/SlashCommandPicker.tsx:102-106` | `absolute bottom-full left-0 z-30 mb-2 ... rounded-lg border ... overflow-hidden` — equivalent shape. |
| Panel positioning via `anchor` prop (bottom/left/right override) | data-binding | 🔁 adapted | `app/renderer/src/SlashCommandPicker.tsx:77-89`, render `App.tsx:1064-1072` | No `anchor` prop; hardcoded `bottom-full left-0 max-w-md`; parent `<div className="relative">` (`App.tsx:1065`) supplies anchor. Prototype flexibility was mock/unused. |
| Dark surface + accent-pink shadow ring styling | chrome | 🔁 adapted | `app/renderer/src/SlashCommandPicker.tsx:103` | Tokenized `bg-shell-chrome border-shell-seam shadow-[...]`; prototype's `rgba(244,114,182,0.06)` pink accent ring not reproduced (token system, not a dropped feature). |
| Header bar container (space-between, bottom border) | chrome | ✅ built | `app/renderer/src/SlashCommandPicker.tsx:107` | `flex items-center justify-between border-b border-shell-seam px-3 py-1.5`. |
| "/" pink pill badge | chrome | ✅ built | `app/renderer/src/SlashCommandPicker.tsx:109-111` | `rounded bg-accent/15 px-1.5 font-mono text-[11px] font-semibold text-accent`. |
| "Commands" uppercase tracked label | chrome | ✅ built | `app/renderer/src/SlashCommandPicker.tsx:112-114` | `text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle`. |
| Live query echo in header | chrome | 🔁 adapted | `app/renderer/src/SlashCommandPicker.tsx:115-117` | Renders bare `{query}` in mono; drops the prototype's leading `·` separator and two-tone `#52525b`/`#a1a1aa` coloring. |
| Match-count badge (`commands.length`) | chrome | ✅ built | `app/renderer/src/SlashCommandPicker.tsx:119-121` | `font-mono text-[10px] tabular-nums text-text-subtle` — tabular-nums preserved. |
| Scrollable command list (maxHeight, hidden scrollbar) | chrome | 🔁 adapted | `app/renderer/src/SlashCommandPicker.tsx:124-129` | Semantic `<ul role=listbox>` vs prototype `<div>`; `max-h-56` (224px) vs 256px; scrollbar hidden preserved. |
| Command row button | subcomponent | ✅ built | `app/renderer/src/SlashCommandPicker.tsx:133-159` | `<li role=option><button type=button>` per command. |
| Active-row highlight (accent bg + left accent border) | chrome | ✅ built | `app/renderer/src/SlashCommandPicker.tsx:144-149` | Active branch → `border-accent bg-shell-active`. |
| Left accent border rail (2px) on every row | chrome | ✅ built | `app/renderer/src/SlashCommandPicker.tsx:145-148` | `border-l-2`, accent-when-active / transparent otherwise. |
| Hover highlight (non-active rows) | chrome | 🔁 adapted | `app/renderer/src/SlashCommandPicker.tsx:148` | CSS `hover:bg-shell-hover` vs prototype JS `onMouseEnter/Leave` toggle; suppressed on active by class branch. |
| Command name span (monospace, accent when active) | chrome | ✅ built | `app/renderer/src/SlashCommandPicker.tsx:151-158` | `font-mono text-[12.5px]` accent/primary, renders `/{name}` (prototype `c.cmd` already carries slash — same text). |
| Fixed 148px name column (aligns to description) | chrome | 🔁 adapted | `app/renderer/src/SlashCommandPicker.tsx:151-158` | No `min-width`; the column existed only to align the (now-deferred) description, so it is correctly gone. |
| `argHint` span (e.g. `<file>`) | data-binding | ⬜ deferred | `specs/2026-07-07-slash-catalog-enrichment-proposal.md` ("The gap") | `argumentHint` lives on engine `Command` (`src/types/command.ts:180-208`), not on names-only `slash_commands` wire. Owner is the enrichment proposal. |
| Separator dot "·" between name and description | chrome | ⬜ deferred | `specs/2026-07-07-slash-catalog-enrichment-proposal.md` | Meaningful only once the description column returns; deferred with it. |
| Description text (`c.desc`) | data-binding | ⬜ deferred | `specs/2026-07-07-slash-catalog-enrichment-proposal.md` ("The gap") | Source wins: engine `slash_commands` frame has no description field today. Deferred, not missing. |
| Disabled row state (disabled attr, opacity 0.45, not-allowed cursor) | ux-state | ⬜ deferred | `specs/2026-07-07-slash-catalog-enrichment-proposal.md` (disabled-with-reason rows) | `disabled`/`disabledReason` are S12 grounded-registry metadata, not on the names-only wire. Renderer would filter via `isBridgeSafeCommand` (`src/commands.ts:697`) once surfaced. |
| `disabledReason` tooltip (title attr on disabled row) | ux-state | ⬜ deferred | `specs/2026-07-07-slash-catalog-enrichment-proposal.md` | Depends on the deferred disabled metadata. |
| `disabledReason` substituted into the description slot | ux-state | ⬜ deferred | `specs/2026-07-07-slash-catalog-enrichment-proposal.md` | Depends on deferred description + disabled metadata. |
| `onMouseDown` preventDefault (pick without blurring composer) | control | ✅ built | `app/renderer/src/SlashCommandPicker.tsx:140-143` | `onMouseDown={e => { e.preventDefault(); onPick(name) }}` — intentionally mouseDown to preserve composer focus. |
| `onPick(cmd)` selection callback | control | ✅ built | `app/renderer/src/App.tsx:1071` → `pickSlashCommand` (`App.tsx:998-1002`) sets draft to `completeSlashDraft(name)` = `/name ` | Insertion rides existing `app.submit`; no command-execution capability added (SECURITY T2/§2). |
| Footer keyboard-hint bar container | chrome | ✅ built | `app/renderer/src/SlashCommandPicker.tsx:168` | Seam-top-bordered hint bar rendered below the `<ul>` (P4-0). |
| Footer kbd chips (↑↓ navigate / ↵ select / esc dismiss) | chrome | ✅ built | `app/renderer/src/SlashCommandPicker.tsx:182` (`SLASH_FOOTER_HINTS`) | Three `<kbd>` hint chips: ↑↓ navigate · ↵ select · esc dismiss. |
| Scroll active row into view on keyboard nav | control | ✅ built | `app/renderer/src/SlashCommandPicker.tsx:93-97` | useEffect scrolls `[data-slash-active="true"]` via `scrollIntoView({ block: 'nearest' })` keyed on `[open, activeIndex]`. |
| Empty state — no matches → renders null | ux-state | ✅ built | `app/renderer/src/SlashCommandPicker.tsx:99`; `App.tsx:983-984` | `if (!open || commands.length === 0) return null`; `slashOpen` also gated on `slashMatches.length > 0`. |
| Closed state — open=false → renders null | ux-state | ✅ built | `app/renderer/src/SlashCommandPicker.tsx:99`; `App.tsx:983` | Same guard; `slashOpen` computed at `App.tsx:983`. |
| Filter ranking: prefix matches then description-contains | data-binding | 🔁 adapted | `app/renderer/src/SlashCommandPicker.tsx:45-59` | `filterSlashCommands` does prefix-first then SUBSTRING over NAMES only; prototype's `desc.includes(q)` fallback not reproducible until enrichment lands. |
| Catalog source (`window.SLASH_COMMANDS_FULL \|\| SLASH_COMMANDS`) | data-binding | 🔁 adapted | `App.tsx:979` `selectSlashCommands`; `transcriptProjector.ts:318-323,704-707`; real `getCommands(cwd)` (`src/commands.ts:501`) | Source wins: prototype mock global registry replaced by the engine's real per-session `slash_commands` catalog. Intended adaptation, not a gap. |
| `query` prop — in-progress text after the slash | data-binding | ✅ built | `parseSlashDraft` (`SlashCommandPicker.tsx:33-36`); `App.tsx:980` `slashQuery`, passed `App.tsx:1068` | Extracts token after `/`; drives header echo + filtering. |
| `activeIdx` prop — selection cursor | data-binding | ✅ built | `App.tsx:977` `slashActiveIndex`, clamped `App.tsx:985-988`, passed as `activeIndex` `App.tsx:1070` | Clamped to length so a shrinking list can't strand the cursor. |
| Keyboard ↑↓ navigate (with wrap) | shortcut | ✅ built | `App.tsx:1009-1019`; `nextSlashIndex` (`SlashCommandPicker.tsx:62-69`) wraps via modulo | Wrap is real behavior; prototype footer just labels 'navigate'. |
| Keyboard ↵ select / complete command | shortcut | ✅ built | `App.tsx:1021-1027` Enter → preventDefault + `pickSlashCommand(slashMatches[slashIndex])` | Enter completes into the draft (does not submit) so args can be added. |
| Keyboard esc dismiss | shortcut | ✅ built | `App.tsx:1029-1032` Escape → `setSlashDismissed(true)` | Present. |
| `onClose` prop (parent-driven close) | control | 🔁 adapted | `app/renderer/src/SlashCommandPicker.tsx:77-89` (no `onClose`); dismissal owned by parent `slashDismissed` (`App.tsx:978`, toggled `App.tsx:1029-1032`) | Close is parent state, not a child callback; prototype declared `onClose` but never invoked it either. |
| Open trigger — leading `/token`, close on whitespace | ux-state | ✅ built | `parseSlashDraft` regex `^\/(\S*)$` (`SlashCommandPicker.tsx:33-36`); `slashOpen` `App.tsx:983-984` | Opens on `/`, `/he`, `/help`; closes at `/help ` (editing args). |
| Tab key accepts the highlighted command | shortcut | ➕ real-added | `App.tsx:1021-1027` `case 'Tab':` shares the Enter branch | Real-added typeahead-accept key; prototype footer lists only ↵. |
| ARIA semantics (role dialog/listbox/option, aria-selected, aria-label) | chrome | ➕ real-added | `app/renderer/src/SlashCommandPicker.tsx:104-105,127-128,133,137` | `role=dialog/listbox/option`, `aria-selected`, per-item `aria-label`; prototype has none. |
| Escape dismiss-latch that re-opens on next keystroke | ux-state | ➕ real-added | `App.tsx:993-996` useEffect keyed on `slashQuery` resets `slashDismissed=false` when the draft text changes | Real-added UX: Escape stays dismissed until the query changes; no equivalent in the stateless prototype. |

### 11. Settings.jsx — two-pane settings shell (category rail + source-badge field system over the real settings.snapshot seam)

> **⛳ OWNER (assigned 2026-07-07): P4-19 — Settings core value-editors** (`backlog/phase4.md` Tranche E). The 40 ❓ rows below are the value editors P4-3 stubbed (P4-12 is extensions-only); P4-19's scope. ❓ here until P4-19 flips them ✅.

**Migration target:** `app/renderer/src/SettingsShell.tsx` · `SettingsField.tsx` · `settingsState.ts` · `app/shared/protocol.ts` — mounted `App.tsx:888` · **Overall:** 🔁 adapted (shell/primitives built, mounted & live over real snapshot; core value-editor bodies unowned) · **Prototype:** `~/catcode_prototype/cat-app/Settings.jsx` (758 lines) · **INVENTORY:** W4-Settings shell + Field/SourceBadge/ManagedBadge adapt (S7)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Two-pane Settings layout container | chrome-layout | ✅ built | `app/renderer/src/SettingsShell.tsx:155` | `flex min-w-0 flex-1 overflow-hidden`, `aria-label="Settings"`. |
| Left category rail (224px, bordered, scroll) | chrome-rail | ✅ built | `app/renderer/src/SettingsShell.tsx:157` | Inline styles → `shell-chrome`/`shell-seam` tokens; same structure. |
| "Settings" rail h1 title | chrome-header | ✅ built | `app/renderer/src/SettingsShell.tsx:159` | |
| Search settings input | control-input | ✅ built | `app/renderer/src/SettingsShell.tsx:163` | `aria-label="Search settings"`, bound to `query`. |
| Search magnifier icon (leading SVG) | chrome-icon | 🔁 adapted | `app/renderer/src/SettingsShell.tsx:163` | Real input has no leading glyph; prototype `Settings.jsx:710` SVG dropped — small chrome delta. |
| Nav search filter (substring, hides empty groups) | behavior-filter | ✅ built | `app/renderer/src/SettingsShell.tsx:143` | `filteredNav` map+filter, identical to `Settings.jsx:695`. |
| Grouped nav section headers | chrome-nav | ✅ built | `app/renderer/src/SettingsShell.tsx:170` | `SETTINGS_NAV` groups `:45`; all ported minus CUT 'Prototype' group. |
| Nav item button | control-button | ✅ built | `app/renderer/src/SettingsShell.tsx:181` | `onClick={() => setActive(item.id)}`. |
| Nav item active state (accent bg/text, bold) | ux-state-selected | ✅ built | `app/renderer/src/SettingsShell.tsx:182` | Adds `aria-current='page'` (a11y improvement over prototype). |
| Nav item hover state | ux-state-hover | ✅ built | `app/renderer/src/SettingsShell.tsx:186` | JS mouse handlers → `hover:bg-shell-hover`. |
| Nav locked lock icon (Managed) | chrome-icon | ✅ built | `app/renderer/src/SettingsShell.tsx:193` | `item.locked` on managed item `:84`. |
| Nav item count badge (MCP 6 / Plugins 4 / …) | chrome-badge | 🔁 adapted | `app/renderer/src/SettingsShell.tsx:37` | `NavItem` type omits `count`; per-category counts are MOCK (`Settings.jsx:620`), decoration dropped — could return with real P4-12 counts. |
| "No matches" empty search state | ux-state-empty | ✅ built | `app/renderer/src/SettingsShell.tsx:204` | |
| Right pane container (scroll, centered max-w 660) | chrome-layout | ✅ built | `app/renderer/src/SettingsShell.tsx:210` | |
| Active category h2 title | chrome-header | ✅ built | `app/renderer/src/SettingsShell.tsx:213` | `activeItem?.label ?? 'Settings'`. |
| Category description subhead (CAT_DESC) | chrome-header | ✅ built | `app/renderer/src/SettingsShell.tsx:216` | `CAT_DESC` `:88`; 'remote' desc trims 'paired devices' (D3 cut). |
| CategoryBody category dispatch | behavior-routing | ✅ built | `app/renderer/src/SettingsShell.tsx:218` | `CategoryBody:230`: agents/memory→embed, managed→panel, general→legend+stub, else→stub. |
| `initialCategory` prop | api-prop | ✅ built | `app/renderer/src/SettingsShell.tsx:132` | Shell default 'general'; app mounts with `initialCategory="agents"` (`App.tsx:891`). |
| SourceBadge (provenance pill) | primitive | ✅ built | `app/renderer/src/SettingsField.tsx:88` | Returns null with no source (`:110`) — refuses to fabricate 'User'. |
| SETTING_SOURCES 5-source taxonomy + precedence | data-model | 🔁 adapted | `app/renderer/src/SettingsField.tsx:20` · `settingsState.ts:88` · `app/shared/protocol.ts:276` | Real keys are engine layer ids (`userSettings…policySettings`); origins from live snapshot; policy label 'Managed' not 'Policy'. |
| SourceBadge `meta` escape hatch (foreign taxonomy) | api-prop | ✅ built | `app/renderer/src/SettingsField.tsx:97` | `{label,className,origin}` branch for AgentsPage (P4-7) reuse. |
| ManagedBadge (lock + 'Managed', read-only tooltip) | primitive | ✅ built | `app/renderer/src/SettingsField.tsx:124` | |
| LockIcon | primitive | ✅ built | `app/renderer/src/SettingsField.tsx:45` | |
| Field row (label + badge + desc + control + reset) | primitive | ✅ built | `app/renderer/src/SettingsField.tsx:142` | Central primitive; adds `editable` prop to gate reset for flag overrides. |
| Field label | chrome-text | ✅ built | `app/renderer/src/SettingsField.tsx:169` | |
| Field managed/source badge slot | chrome-badge | ✅ built | `app/renderer/src/SettingsField.tsx:172` | `managed?ManagedBadge:source?SourceBadge:null`. |
| Field description text | chrome-text | ✅ built | `app/renderer/src/SettingsField.tsx:178` | |
| Field inline error (icon + message) | ux-state-error | ✅ built | `app/renderer/src/SettingsField.tsx:183` | Slot + `ErrorIcon` built; validation logic lives in the unbuilt value editors. |
| Field control slot (children) | api-prop | ✅ built | `app/renderer/src/SettingsField.tsx:191` | |
| Field "Reset to default" (shown when modified) | control-button | ✅ built | `app/renderer/src/SettingsField.tsx:192` | Gates `modified && !managed && editable && onReset` — flag override can't reset. |
| PaneSection (titled subsection) | primitive | ✅ built | `app/renderer/src/SettingsField.tsx:207` | |
| StubPanel (honest empty-state) | primitive | 🔁 adapted | `app/renderer/src/SettingsShell.tsx:360` | Drops prototype `icon`+`summary` stat-cluster props (mock stats); fixed LockIcon glyph. |
| Resolution-order legend (policy▸…▸user, highest wins) | chrome-legend | ✅ built | `app/renderer/src/SettingsField.tsx:231` | Over real `SETTING_SOURCE_PRECEDENCE`; hoisted into general's 'Configuration sources' (`SettingsShell.tsx:255`). |
| LayerSummary (per-source origin + key count) | data-binding | ➕ real-added | `app/renderer/src/SettingsShell.tsx:266` | No prototype equivalent; renders live `snapshot.layers` incl. waiting/empty states. |
| settings.snapshot read-seam + reducer + selectors | infra | ➕ real-added | `app/shared/protocol.ts:276` · `app/renderer/src/settingsState.ts:32` | Source/editable/managed model over the wire, secretGuard-clean (no values). Prototype is mock-only. |
| SwToggle control primitive | control-toggle | ❓ missing-no-owner | — | Value-editor control; not in real files; used only by unbuilt panels; no named P4-N owns core value editors. |
| SwSelect control primitive | control-select | ❓ missing-no-owner | — | Same danger cluster as SwToggle. |
| SwText control primitive (+ mono/error variants) | control-input | ❓ missing-no-owner | — | Same danger cluster as SwToggle. |
| General ▸ Display name field | control-input | ❓ missing-no-owner | `SettingsShell.tsx:259` stub; `CAT_OWNER general` = unnamed (`:110`) | Stubbed, unowned; verify cat-code exposes display-name as a GUI setting. |
| General ▸ Default editor select | control-select | ❓ missing-no-owner | `SettingsShell.tsx:259` stub; `Settings.jsx:171` | Value editor, unowned. |
| General ▸ On startup select | control-select | ❓ missing-no-owner | `SettingsShell.tsx:259` stub; `Settings.jsx:176` | Value editor, unowned. |
| General ▸ Update channel select (flag-source, non-resettable) | control-select | ❓ missing-no-owner | `SettingsShell.tsx:259` stub; `Settings.jsx:181` | Flag-override + reset toast; `editable` gating exists but field unbuilt/unowned. |
| General ▸ Max output tokens + ceiling/number validation | control-input | ❓ missing-no-owner | `SettingsShell.tsx:259` stub; `Settings.jsx:186` | `maxErr` validation logic (`Settings.jsx:165`) is unbuilt value-editor code; unowned. |
| General ▸ Anonymous telemetry (managed toggle, disabled) | control-toggle | ❓ missing-no-owner | `SettingsShell.tsx:259` stub; `Settings.jsx:189` | Managed pattern proven in ManagedPanel; this in-general field unbuilt/unowned. |
| General ▸ Co-author attribution toggle | control-toggle | ❓ missing-no-owner | `SettingsShell.tsx:259` stub; `Settings.jsx:192` | Value editor, unowned. |
| Model ▸ Default model select | control-select | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `CAT_OWNER model` = unnamed (`:111`) | Value editor (mock model list), unowned. |
| Model ▸ Reasoning effort select | control-select | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:222` | Value editor, unowned. |
| Model ▸ Always-on thinking toggle | control-toggle | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:227` | Value editor, unowned. |
| Model ▸ Fast mode toggle | control-toggle | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:230` | Value editor, unowned. |
| Model ▸ Show thinking summaries toggle | control-toggle | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:233` | Value editor, unowned. |
| Model ▸ Auto-compact context toggle | control-toggle | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:236` | Real engine has autocompact but no GUI editor; unowned. |
| Permissions ▸ rules editor embed | panel-embed | ⬜ deferred | `SettingsShell.tsx:263` stub; `CAT_OWNER permissions` = 'P2-4 rules editor' (`:112`) | `PermissionRulesEditor` exists (P2-4) but isn't plugged into the pane — the embed is the deferred gap. |
| Privacy ▸ Conversation retention select | control-select | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `CAT_OWNER privacy` = unnamed (`:115`) | Value editor, unowned. |
| Privacy ▸ Share session data toggle | control-toggle | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:262` | Value editor, unowned. |
| Privacy ▸ Crash reporting (managed toggle) | control-toggle | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:265` | Managed rendering proven in ManagedPanel; this field unbuilt/unowned. |
| Theme ▸ OutputPreview live code canvas | preview | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `CAT_OWNER theme` = unnamed (`:117`) | Live-preview reusing Messages CODE_THEMES/highlightWithPrism; unowned, likely adapt/cut once real theming source found. |
| Theme ▸ Accent color swatch picker | control-swatch | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:332` | Value editor (drives `--accent`), unowned. |
| Theme ▸ Syntax highlighting toggle | control-toggle | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:342` | Value editor, unowned. |
| Theme ▸ Code theme select | control-select | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:345` | Value editor (localStorage-backed in prototype), unowned. |
| Theme ▸ Code font select | control-select | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:348` | Value editor, unowned. |
| Theme ▸ Output style select + description | control-select | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:362` | Over a REAL engine feature (`src/constants/outputStyles.ts`), no GUI editor; strong candidate for a named owner. |
| Keybindings ▸ Vim mode toggle | control-toggle | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `CAT_OWNER keybindings` = unnamed (`:116`) | Value editor, unowned. |
| Keybindings ▸ Shortcuts reference list (6 bindings) | chrome-list | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:391` | Mock display list; real `~/.claude/keybindings.json` exists but no GUI; unowned. |
| Keybindings ▸ 'Custom keymap not available yet' note | ux-state-stub | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:401` | Even prototype stubs it; unowned in migration. |
| Managed ▸ org banner (lock + title + policy path) | chrome-banner | ✅ built | `app/renderer/src/SettingsShell.tsx:310` | Adapted: policy path is `snapshot.policyOrigin` (`:322`), not hardcoded — real data. |
| Managed ▸ Enforced settings rows | data-binding | ✅ built | `app/renderer/src/SettingsShell.tsx:336` | Dynamic from `selectManagedFields(snapshot)`, each labeled by key with 'enforced'. |
| Managed ▸ 5 hardcoded enforced rows (Bypass/Telemetry/…) | data-fixture | 🔁 adapted | `app/renderer/src/SettingsShell.tsx:336` | Prototype's 5 fixed rows (`Settings.jsx:408`) are MOCK — replaced by live snapshot fields, not a dropped element. |
| Managed ▸ empty-state ('No managed settings…') | ux-state-empty | ➕ real-added | `app/renderer/src/SettingsShell.tsx:331` | Prototype always shows mock rows; real handles zero-managed honestly. |
| IDE & LSP nav entry + description | chrome-nav | ✅ built | `app/renderer/src/SettingsShell.tsx:77` | Nav+header/desc built (`CAT_DESC:102`); the panel BODY is unbuilt (rows below). |
| IDE ▸ Editor connection card (icon/name/status/url) | chrome-card | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `CAT_OWNER ide` = unnamed (`:123`); not in `phase4.md:659` P4-12 scope | Real shapes exist (`useIdeConnectionStatus.ts`) but MOCK data; no named owner. |
| IDE ▸ status pill (connected/pending/connecting/disconnected) | ux-state | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:441` | IdeStatusPill states unowned. |
| IDE ▸ Connect / Disconnect button | control-button | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:500` | Action buttons (toast-only in prototype); unowned. |
| IDE ▸ Open file button (disabled unless connected) | control-button | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:505` | Unowned. |
| IDE ▸ Diagnose button | control-button | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:506` | Unowned. |
| IDE ▸ Auto-connect toggle | control-toggle | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:510` | Unowned. |
| IDE ▸ Auto-install extension toggle | control-toggle | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:513` | Unowned. |
| IDE ▸ Editor extension field (Up-to-date / Install) | control-mixed | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:516` | Unowned. |
| IDE ▸ 'Also detected' inactive-IDE list | chrome-list | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:526` | Backed by `detectIDEs`/DetectedIDEInfo; unbuilt/unowned. |
| LSP ▸ section status pill + error/warning counts | data-binding | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:543` | MOCK_LSP data; unowned. |
| LSP ▸ per-server rows (dot/name/langs/state/restart/…) | chrome-list | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:549` | Backed by `LSPServerInstance.ts`; one row covers per-server sub-elements; unowned. |
| LSP ▸ Recent diagnostics list (severity/message/uri:line/source) | chrome-list | ❓ missing-no-owner | `SettingsShell.tsx:263` stub; `Settings.jsx:571` | DIAG_SEV taxonomy; unowned. |
| Remote category body | panel-body | ⬜ deferred | `phase4.md P4-13`; `SettingsShell.tsx:124` | D3 cut-scope: bridge toggle/status + read-only command-filter + direct-connect form; roster/wizard CUT (`decisions/PAIRED-DEVICES.md` §4, INVENTORY:89). |
| Diagnostics category body | panel-body | ⬜ deferred | `phase4.md P4-14`; `SettingsShell.tsx:125` | Real status/diagnostics helpers; PrototypeControls/ConnectionDemo CUT (INVENTORY:110). |
| Workspace category body | panel-body | ⬜ deferred | `phase4.md P4-14`; `SettingsShell.tsx:113` | Read-only trust view; trust ACTION is P4-15's gate. |
| Memory category body (embedded MemoryPage) | panel-body | ✅ built | `app/renderer/src/SettingsShell.tsx:244` | Embeds `<MemoryPage embedded>` wired live (`App.tsx:892`); internal completeness owned by P4-10 (🟢). |
| Agents category body (embedded AgentsPage) | panel-body | ✅ built | `app/renderer/src/SettingsShell.tsx:241` | Embeds `<AgentsPage embedded>` wired live (`App.tsx:890`); P4-7 ✅ (481-line real component). |
| MCP category body | panel-body | ⬜ deferred | `phase4.md P4-12`; `SettingsShell.tsx:119` | Real MCP server config; prototype flattens scoped state. |
| Plugins category body | panel-body | ⬜ deferred | `phase4.md P4-12`; `SettingsShell.tsx:120` | Installed plugins + marketplace. |
| Skills category body | panel-body | ⬜ deferred | `phase4.md P4-12`; `SettingsShell.tsx:121` | Prompt-command skills by source. |
| Hooks category body | panel-body | ⬜ deferred | `phase4.md P4-12`; `SettingsShell.tsx:122` | Event hooks; prototype fakes run outcomes (INVENTORY:88). |
| ElicitationDialog | panel-dialog | ⬜ deferred | `phase4.md:659` P4-12; INVENTORY:88 | Not in Settings.jsx itself but same S7 sub-domain; treat as control round-trip if it requests input. |
| Prototype-controls category (protocontrols) | cut-category | ✂️ cut | `SettingsShell.tsx:41` comment; INVENTORY CUT:110 | Demo triggers; correctly cut. |
| Native category (Chrome/Desktop/Mobile/Voice) | cut-category | ✂️ cut | `Settings.jsx:628` S11-skip note; real `SETTINGS_NAV` omits it | Anthropic-account/desktop deps; cut upstream and in migration. |
| Settings surface mounted / reachable in the running app | integration | ✅ built | `app/renderer/src/App.tsx:888` · `Sidebar.tsx:55` | `<SettingsShell>` rendered on `activeView==='settings'`, fed live `selectSettingsSnapshot(settings, activeSessionId)` (`:893`); Sidebar Settings `enabled: true`. Analyst's "unreachable / enabled:false" was STALE — corrected. |

### 12. Surfaces.jsx — shared-primitive grab-bag: chips/banners/toasts, mention & tool inspector, connection UI, composer byline rail, goal drawer

**Migration target:** `app/renderer/src/{Chip,BannerStack,ToastHost,MentionPicker,ToolInspector,ConnectionChip,tone}.tsx` (kit BUILT P4-1) · composer rail → `deferred P4-0`, accounts → `P4-5`, tasks → `P4-9`, goals → `P4-10`; `ConnectionDemoBar` CUT · **Overall:** 🔁 adapted (PARTIAL — mixed) · **Prototype:** `~/catcode_prototype/cat-app/Surfaces.jsx` (1263 lines) · **INVENTORY:** W5 shared primitives + connection UI (adapt); also Goal dialogs

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| `Chip` — tone-aware pill button primitive | primitive | ✅ built | `app/renderer/src/Chip.tsx:22` | icon/label/value/badge slots over the P0-2 `--tone-*` tokens (`tone.ts`). |
| Chip: leading icon slot | chip | ✅ built | `app/renderer/src/Chip.tsx:53` | |
| Chip: label + brighter trailing value | chip | ✅ built | `app/renderer/src/Chip.tsx:54` | value in `font-semibold text-text-primary`. |
| Chip: count badge (inverse tone fill, `0` shown) | chip | ✅ built | `app/renderer/src/Chip.tsx:58` | |
| Chip: 5 tones (default/accent/warn/danger/good) | chip | 🔁 adapted | `app/renderer/src/tone.ts:19` | prototype inlines RGBA; real uses shared `tone.ts`, adds a distinct `info` tone. |
| Chip: `danger` boolean shorthand prop | chip | 🔁 adapted | `app/renderer/src/Chip.tsx:26` | prototype `danger` shorthand folded into `tone='danger'`. |
| Chip: hover tint + active pinned styling | chip | ✅ built | `app/renderer/src/Chip.tsx:48` | active `softBg/softBorder` vs `hoverTint`. |
| Chip a11y: render `<span>` when no `onClick` | a11y | ➕ real-added | `app/renderer/src/Chip.tsx:72` | inert display chips stay out of tab order (prototype always a `<button>`). |
| `ChipStrip` — horizontal layout container | primitive | 🔁 adapted | `app/renderer/src/Chip.tsx:90` | real = GENERIC separator row; the prototype's rail (Run/Perm/Account…) is deferred to P4-0 (`Chip.tsx:9-14`). |
| ChipStrip: faint `·` separator divider | chip | ✅ built | `app/renderer/src/Chip.tsx:121` | `Separator`, `aria-hidden`. |
| `BannerStack` — anchored stacked notices | primitive | ✅ built | `app/renderer/src/BannerStack.tsx:86` | P4-15 reauth banner mounts here (derived, not pushed). |
| Banner row: tone bg/border bar | banner | ✅ built | `app/renderer/src/BannerStack.tsx:122` | `BannerRow`. |
| Banner: leading alert/info icon by tone | banner | ✅ built | `app/renderer/src/BannerStack.tsx:126` | icons rebuilt inline (`AlertIcon`/`InfoIcon`). |
| Banner: title + optional detail | banner | ✅ built | `app/renderer/src/BannerStack.tsx:134` | text nodes (untrusted status text, sec note `:10`). |
| Banner: action buttons (primary filled / outline) | banner | ✅ built | `app/renderer/src/BannerStack.tsx:139` | |
| Banner: dismiss × (hidden when `dismissable===false`) | banner | ✅ built | `app/renderer/src/BannerStack.tsx:154` | |
| Banner tones: danger/warn/info/accent | banner | ✅ built | `app/renderer/src/BannerStack.tsx:79` | `BANNER_TONE` map. |
| Banner stacking model (upsert-by-id / dismiss / `useBannerStack`) | banner | ➕ real-added | `app/renderer/src/BannerStack.tsx:46` | pure/tested identity-stable dedupe (prototype just maps an array). |
| `ToastHost` + `window.toast()` global | primitive | 🔁 adapted | `app/renderer/src/ToastHost.tsx:98` | global side-channel became a React provider + `useToast()` hook (`:85`); mounted at `main.tsx` root. |
| Toast viewport: bottom-right fixed stack | toast | ✅ built | `app/renderer/src/ToastHost.tsx:171` | `aria-live` polite. |
| Toast row: dot + message | toast | ✅ built | `app/renderer/src/ToastHost.tsx:186` | |
| Toast tones (default/success/danger/warn/info) | toast | ✅ built | `app/renderer/src/ToastHost.tsx:163` | `TOAST_TONE`; success→good. |
| Toast auto-expire (default 3200ms) | toast | ✅ built | `app/renderer/src/ToastHost.tsx:116` | timers cleared on unmount. |
| Toast slide-in animation | toast | ✅ built | `app/renderer/src/ToastHost.tsx:194` | `animate-toast-in` keyframe (theme.css). |
| Toast `MAX_TOASTS` cap + click-to-dismiss | toast | ➕ real-added | `app/renderer/src/ToastHost.tsx:52` | newest-wins cap + click dismiss (prototype has neither). |
| `MentionPicker` — @-mention popover | primitive | 🔁 adapted | `app/renderer/src/MentionPicker.tsx:45` | data-source-agnostic; caller supplies items, owns pick semantics. P4-0 wires real sources. |
| MentionPicker: source tabs (Files/IDE/Channels) | mention | 🔁 adapted | `app/renderer/src/MentionPicker.tsx:79` | tab chrome kept as optional caller-supplied prop; hardcoded 3 tabs are fixture-driven. |
| MentionPicker: case-insensitive substring filter | mention | ✅ built | `app/renderer/src/MentionPicker.tsx:36` | `filterMentionItems`, tested. |
| MentionPicker: item row (mono label + sub line) | mention | ✅ built | `app/renderer/src/MentionPicker.tsx:118` | `item.mono` flag replaces per-tab font logic. |
| MentionPicker: empty 'No matches' state | mention | ✅ built | `app/renderer/src/MentionPicker.tsx:113` | |
| MentionPicker: active/hover row highlight + close × | mention | ✅ built | `app/renderer/src/MentionPicker.tsx:125` | `activeIndex` added for keyboard nav (owned by consumer P4-0). |
| `MENTION_ITEMS` fixtures (files/ide/channels sample rows) | fixture | ✂️ cut | `app/renderer/src/MentionPicker.tsx:6` ('do NOT migrate') | mock data, source wins; real sources wired by P4-0. |
| IDE-tab live-selection / open-file attachment semantics | mention | ⬜ deferred | `phase4.md P4-0` (`:158`) | GUI convenience over real `selected_lines_in_ide`/`opened_file_in_ide` feed; rewire at P4-0. |
| `ToolInspector` — read-only tool-call side drawer | primitive | 🔁 adapted | `app/renderer/src/ToolInspector.tsx:104` | over real `ToolUseRow`, zero casts; fixture `toolSummary` → derived summary + real input. |
| ToolInspector: header tool-name badge + title | tool-inspector | ✅ built | `app/renderer/src/ToolInspector.tsx:115` | family badge. |
| ToolInspector: Summary section | tool-inspector | 🔁 adapted | `app/renderer/src/ToolInspector.tsx:142` | derived from real input (`deriveSummary` `:89`), tolerant. |
| ToolInspector: Status section (tone-colored) | tool-inspector | ✅ built | `app/renderer/src/ToolInspector.tsx:147` | `STATUS_TONE`/`STATUS_LABEL`. |
| ToolInspector: Diff section (add/remove/context hunks) | tool-inspector | 🔁 adapted | `app/renderer/src/ToolInspector.tsx:159` | real narrowed `ToolDiffProjection` vs prototype fixture. |
| ToolInspector: Output `<pre>` | tool-inspector | ✅ built | `app/renderer/src/ToolInspector.tsx:182` | real result content, text node. |
| ToolInspector: structured Input (JSON) section | tool-inspector | ➕ real-added | `app/renderer/src/ToolInspector.tsx:154` | renders real structured tool input as read-only JSON (prototype had only a summary string). |
| ToolInspector: 'Open diff in IDE ↗' button | tool-inspector | ✂️ cut | `app/renderer/src/ToolInspector.tsx:12` ('no real verb'); `STATUS.md P4-1` §0 flag | no engine verb backs it; cut + flagged. |
| ToolInspector: close × | tool-inspector | ✅ built | `app/renderer/src/ToolInspector.tsx:124` | |
| `ConnectionChip` — quiet-until-wrong connection status | primitive | 🔁 adapted | `app/renderer/src/ConnectionChip.tsx:87` | reads real `ConnectionSnapshot` via `mapConnectionToChip` (`:58`), NOT a simulator. |
| ConnectionChip: hidden when healthy | connection | ✅ built | `app/renderer/src/ConnectionChip.tsx:62` | `ready`→null. |
| ConnDot: solid/pulse/ring dot styles | connection | ✅ built | `app/renderer/src/ConnectionChip.tsx:124` | pulse→`animate-pulse`, ring→border. |
| `CONN_STATES` visual vocabulary (4 states) | connection | 🔁 adapted | `app/renderer/src/ConnectionChip.tsx:36` | visual grammar kept; real status set mapped onto it. |
| ConnectionChip: reconnecting backoff `Ns` countdown | connection | ✂️ cut | `app/renderer/src/ConnectionChip.tsx:15` ('no Ns backoff to show'); `STATUS.md P4-1` §0 flag | real transport has no auto-reconnect/backoff; mock-only field. |
| ConnectionChip: retry affordance (reconnect_failed) | connection | 🔁 adapted | `app/renderer/src/ConnectionChip.tsx:111` | 'retry' = restart the sidecar (`onRetry`→`bridge.restart`), all terminal states. |
| `ConnectionDemoBar` — floating prototype toggle bar | connection | ✂️ cut | `INVENTORY.md:108` CUT list | loaded demo simulator, not a product feature. |
| `window.MOCK_CONNECTION` state machine + cycle buttons/backoff timer | connection | ✂️ cut | `INVENTORY.md:108` | scripted demo simulator; cut with `ConnectionDemoBar`. |
| `ChipStrip` composer rail assembly (columnar left + margin-auto right + separators + showTasks mutual-exclusion) | composer-rail | ⬜ deferred | `phase4.md P4-0` (`:138`); `STATUS.md P4-1` §0 flag | actual composer byline rail, distinct from the built generic `ChipStrip`. Not built. |
| `RunChip` — model selector chip + popover | composer-rail | ⬜ deferred | `phase4.md P4-0` (`:138`) | maps to real `/model` run setting. |
| `MODELS` fixture list (gpt-5.5/5.4/5.3-codex/5.4-mini + tint/tag) | fixture | 🔁 adapted | `phase4.md P4-0` (`:138`); source wins | fixture; real model catalog from engine at P4-0. |
| `ReasoningChip` — reasoning-effort selector (max hidden for mini) | composer-rail | ⬜ deferred | `phase4.md P4-0` (`:138`) | maps to real effort setting; mini drops 'max'. |
| `REASONING` fixture (low/medium/high/max) | fixture | 🔁 adapted | `phase4.md P4-0` (`:138`); source wins | fixture; real effort levels wired at P4-0. |
| `PermChip` — permission-mode selector + pending-count badge + 'review →' link | composer-rail | ⬜ deferred | `phase4.md P4-0` (`:138`) | data exists (`permissionState.ts`/`PermissionQueue.tsx`); byline chip control is P4-0. |
| `PERM_MODES` (plan/ask/accept-edits/auto/bypass) | composer-rail | ⬜ deferred | `phase4.md P4-0` (`:138`) | real perm modes are a live engine concept; the byline chip is P4-0. |
| `FastChip` — lightning-bolt fast-mode toggle | composer-rail | ⬜ deferred | `phase4.md P4-0` (`:138`) | maps to real fast/priority-tier run setting. |
| `TasksChip` — 'N running' background-task byline summary | composer-rail | ⬜ deferred | `phase4.md P4-9` (`:551`) | tasks data/behavior is P4-9; byline placement rides P4-0 rail. |
| TasksChip mutual-exclusion with orchestrator worker roster | composer-rail | ⬜ deferred | `phase4.md P4-9` (`:551`) | `showTasks` suppressed when workers present; depends on P4-8 roster + P4-9 tasks. |
| `TokenWarning` — amber auto-compact glyph + popover | composer-rail | ⬜ deferred | `phase4.md P4-0` (`:138`) | real `TokenWarning.tsx`/`autoCompact.ts` in TUI; GUI donut-riding glyph deferred. |
| `ContextChip` — usage donut + Plan-usage + context-breakdown popover | composer-rail | ⬜ deferred | `phase4.md P4-0` (`:138`) | context% maps to real `/context`; Plan-usage rows depend on P4-5 pool status. |
| ContextChip: `openSignal` `/context` integration | composer-rail | ⬜ deferred | `phase4.md P4-0` (`:138`) | `/context` bumps `openSignal` to open the popover; wire at P4-0. |
| `AccountChip` — 'Active account' chip + switcher table popover | composer-rail | ⬜ deferred | `phase4.md P4-5` (`:372`) | byline account switcher over real Codex pool; account data/lease is P4-5's read-seam. |
| AccountChip: account table rows (health dot, 5h/weekly `UsedMetric`, switch-on-click, capped/dead) | composer-rail | ⬜ deferred | `phase4.md P4-5` (`:372`) | per-session active account, healthy-count header, capped rows non-clickable. |
| AccountChip: footer '+ Add account' / 'Manage →' | composer-rail | ⬜ deferred | `phase4.md P4-5` (`:372`) | prototype '+ Add' is a toast stub; real add-account is P4-5/P4-15 OAuth. |
| `ColumnChipFace` — shared chip face for the rail | popover | ⬜ deferred | `phase4.md P4-0` (`:138`) | composer-rail sub-primitive, distinct from the built pill `Chip`. |
| `usePopover` hook (Esc + outside-click dismiss) | popover | ⬜ deferred | `phase4.md P4-0` (`:138`) | rail popover dismissal primitive; no built equivalent yet. |
| `PopoverHost` — dismissable popover wrapper | popover | ⬜ deferred | `phase4.md P4-0` (`:138`) | anchored above-composer popover shell for Run/Reasoning/Perm chips. |
| `MenuHeader` — uppercase section label | popover | ⬜ deferred | `phase4.md P4-0` (`:138`) | style-B menu primitive. |
| `RadioRow` — radio + title + tag + description row | popover | ⬜ deferred | `phase4.md P4-0` (`:138`) | selection row for model/reasoning/perm popovers. |
| `ToggleRow` — switch row (icon/label/detail/toggle) | popover | ⬜ deferred | `phase4.md P4-0` (`:138`) | defined but unrendered in prototype (latent); carry to P4-0 if a toggle run setting needs it. |
| `UsageBar` — small horizontal usage progress bar | popover | ⬜ deferred | `phase4.md P4-0` (`:138`) | defined but appears unused (ContextChip uses `PlanUsageRow`); latent. |
| `PlanUsageRow` — labelled plan-limit bar (%/reset) | popover | ⬜ deferred | `phase4.md P4-0` (`:138`); data dep P4-5 | ContextChip Plan-usage; 5h/weekly values come from P4-5 pool status. |
| `AcctUsageBar` — account usage bar with 'N% free' pill | popover | ⬜ deferred | `phase4.md P4-5` (`:372`) | defined but unused in AccountChip (uses `UsedMetric`); latent P4-5 primitive. |
| `UsedMetric` — compact account 5h/weekly metric bar | popover | ⬜ deferred | `phase4.md P4-5` (`:372`) | account-table metric bar; carries with the AccountChip switcher. |
| `GoalDetail` — goal status side drawer | goal | ⬜ deferred | `phase4.md P4-10` (`:597` names `Surfaces.jsx (GoalDetail)`); `INVENTORY.md:80` | mirrors `formatThreadGoalSummary` (`threadGoal.ts`) over T4-validated `goalSnapshot`. |
| GoalDetail: header (icon + 'Goal' + status pill) + `GOAL_STATUS_LABEL` | goal | ⬜ deferred | `phase4.md P4-10` (`:583`) | status labels active/paused/limited-by-budget/complete. |
| GoalDetail: objective text + close × | goal | ⬜ deferred | `phase4.md P4-10` (`:583`) | |
| GoalDetail: usage KV (token budget / tokens used / time used) | goal | ⬜ deferred | `phase4.md P4-10` (`:583`) | plain text, no bars; token budget row only when set. |
| GoalDetail: controls Resume/Pause (status-conditional) | goal | ⬜ deferred | `phase4.md P4-10` (`:601`) | map to `/goal pause\|resume`. |
| GoalDetail: Replace / Clear buttons | goal | ⬜ deferred | `phase4.md P4-10` (`:602`); `INVENTORY.md:80` ('create/replace dialogs') | Replace triggers the goal create/replace dialog (W5 'Goal dialogs'). |
| GoalDetail: footer note (update_goal / idle continuation) | goal | ⬜ deferred | `phase4.md P4-10` (`:583`) | verbatim intent from `formatThreadGoalSummary`. |
| `GoalChip` — goal status chip (documented, NOT implemented) | goal | ⬜ deferred | prototype header `:7` names it but export list has ONLY `GoalDetail` — `phase4.md P4-10` | phantom: named in header, never coded/exported; any real goal chip belongs to Goals domain. |
| `I` / `I_ICONS` — shared inline SVG icon set (~24 glyphs) | icon | 🔁 adapted | `app/renderer/src/BannerStack.tsx:169` | rebuilt per-component inline; no shared `I_ICONS` export. Rail-specific glyphs carry with their chips to P4-0. |
| `btnStyles` — shared inline button style object | fixture | ✂️ cut | phase4.md standing rules ('no inline `style={{}}`') | inline-style fixture; real app uses Tailwind on P0-2 tokens. Not a UX element. |
| `PermissionQueue` (explicitly removed from this file 2026-06-24) | note | ✅ built | `app/renderer/src/PermissionQueue.tsx` | informational; canonical `PermissionQueue` is built + owned by the Permissions surface. |

### 13. AgentIdentity.jsx — shared web-native vocabulary (agent type/state/identity) + real-engine derivations; visual primitives deferred to consumers

**Migration target:** `app/renderer/src/agentIdentity.ts` (data BUILT) · visual primitives deferred → `phase4.md P4-8`/`P4-9` · **Overall:** 🔁 adapted · **Prototype:** `~/catcode_prototype/cat-app/AgentIdentity.jsx` (248 lines) · **INVENTORY:** W5 AgentIdentity adapt (S5)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Module purpose: single source of truth for identity + agent types + lifecycle vocabulary | design-principle | ✅ built | `app/renderer/src/agentIdentity.ts:1-70` | Ported as a pure TS vocab module (P4-2); prototype's pip/chip/badge VISUAL half deferred to P4-8/P4-9 (component rows below). |
| Module export mechanism (`Object.assign(window,…)` global dump) | dependency | 🔁 adapted | `app/renderer/src/agentIdentity.ts:71-377` (named `export const`/`export function`) | Prototype attaches all symbols to `window`; real module uses named ES exports consumed via `import` (`agentIdentity.test.ts:2-12`). |
| MONO_FF token (handles/chips in DM Mono) | style-token | ⬜ deferred | `phase4.md P4-8`/`P4-9` | Data-only module encodes no fontFamily (grep: no MONO in `agentIdentity.ts`); mono-@handle is a render convention owned by the deferred visual primitives. |
| AGENT_TYPE table (type→label/color/soft/line) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:71-121` | Full table ported; keys match real `agentType` strings verbatim. |
| Type `verification` chip (Verification, #5eead4) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:72-79` | label/color/soft/line identical. |
| Type `general-purpose` chip (General-purpose, #93c5fd) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:80-87` | Identical. |
| Type `implementor` chip (Implementor, #c4b5fd) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:88-95` | Identical. |
| Type `Explore` chip (Explore, #7dd3fc, capitalized key) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:96-103` | Capitalized `Explore` key preserved (real `exploreAgent.ts:98`). |
| Type `coding-worker` chip (Coding worker, #a78bfa) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:104-111` | Short orchestrator-role label kept. |
| Type `agent-mode-coding-worker` (real engine agentType) | data-vocabulary | ➕ real-added | `app/renderer/src/agentIdentity.ts:112-120` | Not keyed in prototype AGENT_TYPE; real agent-mode `agentType` (`rolePrompts.ts:137`) resolves to 'Coding worker' w/ `compressedFrom` (`agentIdentity.test.ts:49-53`). |
| Neutral fallback chip for unknown/custom agentType (#a1a1aa, raw label) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:257-265` | Custom-agent fall-through preserved; `agentIdentity.test.ts:54-57` ('Plan'→neutral). |
| `agentTypeMeta(type)` resolver (null on empty) | function | ✅ built | `app/renderer/src/agentIdentity.ts:255-267` | Behaviorally identical; `agentIdentity.test.ts:58` (undefined→null). |
| AGENT_STATE table (state→label/color/pip) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:123-244` | All 15 states ported; fill/ring/pulse booleans re-encoded as one `icon` enum + added `tone` (see those rows). |
| State `running` (Running, #60a5fa, fill+pulse) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:124-131` | pulse→`icon:'pip-pulse'`; `agentIdentity.test.ts:14-19`. |
| State `background` (In background, #60a5fa, ring) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:132-139` | Identical. |
| State `completed` (Completed, #4ade80, fill) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:140-147` | Identical; completed≠pass/fail (no verdict mapping). |
| State `failed` (Failed, #f87171, fill) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:148-155` | Identical. |
| State `stopped` (Stopped, #fbbf24, ring) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:156-163` | Identical; default fall-through of `stateFromTaskStatus`. |
| State `blocked` (Needs input, NEUTRAL #a8a29e, ring) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:164-171` | Neutral-not-amber preserved (`tone:'neutral'`, `attention:false`); `agentIdentity.test.ts:20-25`. |
| State `waiting` (Waiting on orchestrator, #c084fc, ring) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:172-179` | Token BUILT but UNREACHABLE (no derivation returns it); two-strikes rider owned by `STATUS.md P4-8` (wire-or-delete) — flagged, not a silent gap. |
| State `needs-you` (Needs you, #fbbf24, fill, attention — solo only) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:180-187` | `attention:true`; reached by `deriveTaskAgentState` blocked/user path (`:323-325`); `agentIdentity.test.ts:26-31`. |
| State `paused` (Paused, #a8a29e, ring) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:188-195` | Reached via teammate isIdle path (`:338`). |
| State `result-ready` (Result ready, #4ade80, ring, attention) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:196-203` | Reached via synthesisStatus pending (`:311`); `agentIdentity.test.ts:32-37`. |
| State `reviewed` (Reviewed, #a1a1aa, ring) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:204-211` | Reached via synthesisStatus synthesized (`:312`). |
| State `attention` (Attention, #fbbf24, fill, attention) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:212-219` | Reached via worker status failed/killed (`:313`). |
| State `resumable` (Resumable, #a1a1aa, ring) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:220-227` | Reached via origin prior + resumable true (`:309`). |
| State `stale` (Stale, #71717a, ring) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:228-235` | `tone:'muted'`; reached via origin prior + resumable false (`:310`). |
| State `resumed` (Resumed, #60a5fa, ring) | data-vocabulary | ✅ built | `app/renderer/src/agentIdentity.ts:236-243` | Reached via resumedAt + running (`:329`). |
| Pip shape encoding (fill / ring / pulse) | data-vocabulary | 🔁 adapted | `app/renderer/src/agentIdentity.ts:10` (`AgentPipIcon`) + per-state `icon` | Three independent booleans collapsed into one exhaustive mutually-exclusive `icon` enum; same visual intent, consumer maps enum→dot styling. |
| `tone` semantic field on type + state | data-vocabulary | ➕ real-added | `app/renderer/src/agentIdentity.ts:1-9` (`AgentTypeTone`/`AgentStateTone`) | Real-added token tying into the `--tone-*`/`tone.ts` system so chips theme via tokens; prototype hard-coded hex only. |
| `agentStateMeta(state)` resolver | function | 🔁 adapted | `app/renderer/src/agentIdentity.ts:269-271` | Strongly typed (`AgentStateKey`), indexes directly; prototype's `\|\| AGENT_STATE.stopped` runtime fallback dropped (type guarantees a valid key). |
| `resolveAgentIdentity(d)` — transcript+worker dual shape | function | 🔁 adapted | `app/renderer/src/agentIdentity.ts:273-300` | Superset: adds explicit `handle` output, nested `identity{}` unwrap, `subagent_type`, more description/id sources; same @-strip + friendly-name-wins; `agentIdentity.test.ts:61-126`. |
| `agentTranscriptStateWord(state)` — compressed card-header word | function | ⬜ deferred | `phase4.md P4-8` | Absent from all renderer source (grep); belongs to the inline transcript card (below), deferred with it. |
| AgentPip component (dot: fill/ring/pulsing), size prop | visual-component | ⬜ deferred | `phase4.md P4-8`/`P4-9` | Data (icon enum) built; React dot renderer is a consumer concern (grep: no AgentPip in renderer). P4-2 was data-only scope. |
| pulse-dot CSS keyframe for running pip | visual-state | ⬜ deferred | `phase4.md P4-8`/`P4-9` | grep: no `pulse-dot` in renderer; consumer provides keyframe, `icon:'pip-pulse'` carries intent. |
| AgentTypeChip component (uppercase mono chip, sm/md) | visual-component | ⬜ deferred | `phase4.md P4-8`/`P4-9` | All chip DATA built in AGENT_TYPE_META; chip element rendered by consumers (grep: none). P4-1 `Chip.tsx` exists but agent chip is P4-8/P4-9. |
| AgentHandle component (@name in mono) | visual-component | ⬜ deferred | `phase4.md P4-8`/`P4-9` | resolveAgentIdentity supplies name/handle; the mono @name span is a consumer render (grep: none). |
| AgentStateLabel component (pip + state word inline) | visual-component | ⬜ deferred | `phase4.md P4-8`/`P4-9` | Composition of AgentPip + label; deferred with its parts (grep: none). |
| AgentIdentityLine component (@name · Type, or type-led fallback) | visual-component | ⬜ deferred | `phase4.md P4-8`/`P4-9` | `deriveAgentDisplayVocabulary` (`agentIdentity.ts:367-377`) returns `{identity,type,state}` to drive it; the line render is deferred (grep: none). |
| Anonymous fallback label 'Subagent' (no friendly name) | visual-state | ⬜ deferred | `phase4.md P4-8`/`P4-9` | `hasName=false` computed in vocab; the 'Subagent' display string is a render-time consumer decision (grep: literal only in prototype). |
| AgentTranscriptLabel helper (uppercase section caption) | visual-component | ⬜ deferred | `phase4.md P4-8` | Sub-part of the inline transcript card; deferred with it (grep: none). |
| AgentTranscriptCard — inline transcript agent tool card (collapsible) | visual-component | ⬜ deferred | `decisions/AGENT-CHROME.md` D2 · `phase4.md P4-8:533` | The one CHAT-transcript element; data lands via `transcriptProjector` nested rows (D2/C4), styled card is P4-8; `TranscriptView.tsx` renders agent rows plainly for now. |
| Card header row: pip + name + → + task + state-word + chevron | visual-state | ⬜ deferred | `phase4.md P4-8` | Part of AgentTranscriptCard (deferred); mono → separator + rotating ▾ chevron. |
| Card collapsed↔expanded toggle (controlled + uncontrolled) | interaction | ⬜ deferred | `phase4.md P4-8` | `defaultExpanded`/`expanded`/`onToggle` API; nested subagent frames collapsed-by-default is the D2/C4 binding P4-8 must honor. |
| Card 'Task' section (prompt/task via Prose) | visual-state | ⬜ deferred | `phase4.md P4-8` | Deferred; real-backed (task/prompt on Agent tool input, `resolveAgentIdentity` description sources). |
| Card 'Activity · N' section (list of activity rows) | visual-state | ⬜ deferred | `phase4.md P4-8` · `agentIdentity.ts:250` | SECTION deferred to P4-8, but fixture `activity[]` CUT (source wins); real activity DERIVES from nested subagent frames (P2-2), never a mock array. |
| Card blocked-note panel ('returned to orchestrator' + copy) | visual-state | ⬜ deferred | `phase4.md P4-8` · `agentIdentity.ts:323-325` | Real-backed (`handoffStatus:'blocked'` is a real terminal orchestrator state, `AGENT-CHROME.md` C1); panel render deferred. |
| Card 'Result' section (resultLabel/result via Prose) | visual-state | ⬜ deferred | `phase4.md P4-8` | Deferred; renders only when a real result field is present (prototype already gates on `result`). |
| Card stats footer (· -separated stat bits) | visual-state | ⬜ deferred | `phase4.md P4-8` · `agentIdentity.ts:251` | Section deferred to P4-8 but fixture `stats[]` CUT; render only stats backed by a real field (outputSummary/result/lease per D2 §3). |
| `window.Prose` dependency for card prose | dependency | 🔁 adapted | `app/renderer/src/TranscriptView.tsx:11` (react-markdown) | Real app renders prose via react-markdown, not a global `window.Prose`; P4-8 card reuses that. |
| `deriveAgentModeWorkerState(worker)` — Agent-Mode session → state | derivation | ➕ real-added | `app/renderer/src/agentIdentity.ts:306-316` | Real-added engine bridge (W5 mandate); mirrors `getWorkerStatusLabel` guard/fall-through (B3 fix e663b42); `agentIdentity.test.ts:128-185`. |
| `deriveTaskAgentState(task,{blockedOwner})` — local/teammate/remote → state | derivation | ➕ real-added | `app/renderer/src/agentIdentity.ts:318-350` | Real-added; encodes blocked→(orchestrator\|user), backgrounded, resumed, plan-approval, idle, ultraplan over real Task shapes; `agentIdentity.test.ts:187-297`. |
| `deriveAgentToolState(tool)` — Agent/Task tool correlation → state | derivation | ➕ real-added | `app/renderer/src/agentIdentity.ts:352-356` | Real-added; error/success/pending + run_in_background → state; DERIVED from tool_use↔tool_result (D2/C4); `agentIdentity.test.ts:299-333`. |
| `deriveAgentState` + `deriveAgentDisplayVocabulary` — unified entry points | derivation | ➕ real-added | `app/renderer/src/agentIdentity.ts:358-377` | Real-added dispatcher returning `{identity,type,state}` — the bundle P4-8/P4-9 consume; `agentIdentity.test.ts:335-362`. |
| DROPPED_PROTOTYPE_AGENT_IDENTITY_FIELDS manifest | documentation | ➕ real-added | `app/renderer/src/agentIdentity.ts:246-253` | Test-enforced record of 'source wins' drops (`agentIdentity.test.ts:364-388`) — the anti-silent-drop instrument. |
| MOCK fixture field `w.progress[]` timelines | mock-data | ✂️ cut | `decisions/AGENT-CHROME.md` D2 §3 · `agentIdentity.ts:247` | Dropped MOCK data, not a UX element; real progress derives from nested frame re-emits (`agentIdentity.test.ts:382-387`). |
| MOCK fixture field `w.files[]` file lists | mock-data | ✂️ cut | `agentIdentity.ts:248` (`agentIdentity.test.ts:383`) | Fixture-only; render files only where a real field exists (outputSummary). |
| MOCK fixture fields `w.up`/`w.down` traffic counters | mock-data | ✂️ cut | `agentIdentity.ts:249` (`agentIdentity.test.ts:384`) | No real traffic-counter field; cut with flag. |
| MOCK_CODEX_LEASES account fixtures | mock-data | ✂️ cut | `agentIdentity.ts:252` · `decisions/AGENT-CHROME.md` | Real per-session leases come from the engine snapshot (P4-8/P4-9 read-seam), not the mock roster. |

### 14. Pages.jsx — three deferred product surfaces (Accounts/Codex-pool, WorkspaceTrust, Diagnostics) + cut demo scaffolding

**Migration target:** `P4-5` (AccountsPage + Codex pool/lease + AccountLifecycle) DONE ✅; `P4-14` (Diagnostics + WorkspaceTrust) still deferred; demo scaffolding CUT · **Overall:** 🔁 Accounts rows built (P4-5, `app/renderer/src/AccountsPage.tsx`); Diagnostics/WorkspaceTrust rows still ⬜ deferred (P4-14). The usage-analytics charts/breakdowns are DEFERRED as fixture-only (no real per-account/per-model token backing; §0). · **Prototype:** `~/catcode_prototype/cat-app/Pages.jsx` (991 lines) · **INVENTORY:** W4 Accounts (adapt S8) + W4-Settings Diagnostics/Trust (adapt/recon S6/S7)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| AccountsPage — page container / scroll region | page-shell | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` (`:372`), `STATUS.md:221` ⬜ | Whole page deferred to P4-5; grep `AccountsPage` in `app/renderer` = empty. INVENTORY Accounts adapt/S8 (real pool richer than prototype). |
| Page header — title "Accounts" (h1) | chrome-header | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:515`. Static title. |
| Header subtitle "…what it's burning" + "{readyCount} of {poolCount} ready" | chrome-header | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:516`. ready/pool counts REAL-derivable from `PoolAccount.status` (`codexAccountPool.ts:33`). |
| Active-account headroom hero card (shown when default acct healthy) | data-card | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:525`. Bound to persisted `activeCodexAccountId`, not a live session account. |
| Hero card — dot + alias (mono) + "active" badge + "used" label | chrome-badge | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:527`. alias real; "active" = isDefault marker. |
| Hero card — 5h + Weekly mini-stat pair (big % color-by-pressure, bar, "↺ resets") | data-viz | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:534`. 5h/weekly %+reset REAL (`codexUsage.ts`). Pressure thresholds 65/90%. |
| Usage-cap banner (pulse dot + "{alias}: usage limit reached") | banner | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:559`. Real trigger = status `capped` (`codexAccountPool.ts:33`); demo `showCapBanner=true` default is demo-only, banner itself real. |
| Cap banner — "Switch" action button | button | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:567`. Maps to real /switch-account; inbound needs T5a/T6/T7. |
| Cap banner — "Resets {reset}" (wait) button | button | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:568`. Informational; reset real from codexUsage. |
| Cap banner — "Dismiss" button (UI-only) | button | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:569`. Renderer-local dismiss, no engine effect. |
| CodexPool section (component) — primary pool roster | sub-component | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` (`:390` recon `codexAccountPool.ts`) | `Pages.jsx:374`. Spine of the page; reactive off the pool store, not a poll. |
| CodexPool header — "Codex Pool" + "{ready} of {N} ready" | chrome-header | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:440`. ready = healthy && !usageLimitReached. |
| CodexPool — "Refresh all" button (TouchAllDialog) | button | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5`; INVENTORY AccountLifecycle | `Pages.jsx:444`. Real touch-all pool op. |
| CodexPool — "+ Add account" button (AddAccountDialog) | button | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:450`. Real OAuth add lifecycle (`ConsoleOAuthFlow.tsx:35-55`). |
| CodexPool — hero Row for active account (elevated border/glow) | list-row | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:456`. Active account pulled out as hero above the roster. |
| CodexPool — roster Rows for remaining accounts | list-row | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:457`. One row per non-default account. |
| Pool Row — status dot (color by status/pressured/default; pulse on quarantined) | status-indicator | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:408`. Real `PoolAccount.status`; quarantined → transient "Reconnecting" pulse. |
| Pool Row — alias + "active" badge (isDefault) | chrome-badge | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:414`. active = id===defaultAccountId. |
| Pool Row — status label (POOL_STATUS copy) + lastError suffix | status-indicator | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:417`. `POOL_STATUS` (`:347`) maps internal statuses to user copy (TUI leaks internal terms, GUI must not). |
| Pool Row — 5h HeadroomBar (usable accounts) | data-viz | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:423`. Real 5h window+reset. |
| Pool Row — weekly HeadroomBar (usable accounts) | data-viz | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:424`. Real weekly window+reset (`codexUsage.ts`). |
| Pool Row — non-usable state: "Resets in {reset}" (capped) | ux-state | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:427`. Shown instead of bars when not healthy. |
| Pool Row — dead-account dimming (opacity 0.55) | ux-state | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:406`. status==='dead' → dimmed (re-login required). |
| Pool Row — AccountRowMenu (per-row actions menu) | menu | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5`; INVENTORY AccountLifecycle ⚓2 | `Pages.jsx:431`. onRowAction(switch\|rename\|delete\|logout) from AccountLifecycle.jsx. |
| Row action: "switch" (synchronous toast, no dialog) | action | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:382`. Switch synchronous upstream; real /switch-account. |
| Lifecycle dialog: AddAccountDialog | dialog | 🔁 adapted | `app/renderer/src/AccountsPage.tsx`; `app/sidecar/accountsDomain.ts` (`account.login`) | §0: connect phase + explainer built; the "Open browser to sign in" dispatches the real `account.login` verb, but the live OAuth callback/alias back-channel is DEFERRED to P4-15 (shared first-run OAuth surface). The scripted timer + alias phase are not faked. |
| Lifecycle dialog: TouchAllDialog (refresh all) | dialog | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:463`. AccountLifecycle.jsx. |
| Lifecycle dialog: RenameAccountDialog (takenAliases uniqueness) | dialog | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:464`. Alias rename = real pool op. |
| Lifecycle dialog: DeleteAccountDialog (hasOtherSwitchable guard) | dialog | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:465`. Guard prevents deleting last usable account. |
| Lifecycle dialog: LogoutAccountDialog | dialog | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:468`. Logout = engine clears token (secret-owner rule). |
| Usage section header — "Usage" + "Today 284k · week 1.84M · month 6.2M" | chrome-header | ⬜ deferred (fixture-only §0) | `phase4.md P4-14`? / future usage-logging session | §0 DEFERRED: the entire usage-analytics section below (this header + stat cards + Trends charts + Breakdown + chart primitives, rows through 1041) is prototype demo data with NO real per-account/per-model token series backing (prototype's own comments). Not built, not faked. P4-5 ships the real spine only. |
| Summary stat card: "Tokens Today" + MiniSparkline | stat-tile | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:591`. Value + "+12% vs avg" mock; today total derivable from real per-day tokens. |
| Summary stat card: "This Week" + MiniSparkline | stat-tile | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:592`. 7-day total derivable from real DailyModelTokens. |
| Summary stat card: "Cache Hit Rate" (% + reads) | stat-tile | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:593`. REAL-derived from `ModelUsage` cache token counts (`coreTypes.generated.ts:49`). |
| Summary stat card: "Accounts Ready" (readyCount/poolCount) | stat-tile | 🔁 adapted | `app/renderer/src/AccountsPage.tsx` (header subtitle) + `accountsState.ts` `selectReadyLabel` | The real datum (readyCount/poolCount from `PoolAccount.status`) IS shown — in the page header subtitle + the Codex Pool section header, not as a separate analytics stat-tile (that grid is the deferred fixture-only zone). |
| Trends sub-header + 7d/30d range toggle buttons | toggle | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:620`. 7d/30d only — no hourly token series upstream (`stats.ts:127` hourCounts = sessions/msgs). |
| "Tokens by Account" card — ProfileLineChart (stacked per-account daily + total) | data-viz | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:632`. FLAG: per-account token series DERIVABLE-IF-LOGGED, not stored (only per-model, `stats.ts:33`) — owner renders truth or adds logging, do NOT ship mock split. |
| "Tokens by Account" — per-account legend + dashed Total legend | legend | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:639`. Legend chrome deferred with chart; same derivable-if-logged data. |
| "Daily Tokens by Model" card — DailyTokenChart (per-model daily lines + total) | data-viz | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:665`. REAL shape: mirrors `DailyModelTokens` (`stats.ts:33`) — the one real time series. Tokens only. |
| "Daily Tokens by Model" — per-model legend (color/name) | legend | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:671`. Model names real (`MODEL_USAGE` keyed by model). |
| Breakdown section header | chrome-header | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:689`. Groups the no-time-axis aggregate cards. |
| "By Account" breakdown card — AccountBars | data-viz | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:691`. FLAG: per-account totals derivable-if-logged, not stored. Owner renders truth or flags. |
| "By Model" breakdown card — ModelBars + "All models / {N}k" footer | data-viz | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:695`. REAL: per-model tokens from `ModelUsage` (`coreTypes.generated.ts:49`). No costUSD (Codex subscription-billed). |
| "Main Thread vs Subagents" card — StackedBar + two stat tiles | data-viz | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:705`. FLAG: split DERIVABLE from transcript isSidechain/agentId (`logs.ts:236-245`) but aggregated today (`stats.ts:269`). |
| "Cache Usage" card — hit-rate % + StackedBar (read/fresh/write) | data-viz | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:720`. REAL-derived raw cache token counts; NOT a time series (no historical cache-rate trend upstream). |
| Chart primitive: HeadroomBar (label/bar/%/reset, pressure color) | data-viz | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:356`. Reusable pool-headroom bar; thresholds 65/90%. |
| Chart primitive: MiniSparkline | data-viz | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:68`. Used by summary stat cards. |
| Chart primitive: StackedBar (segments + legend rows) | data-viz | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:81`. Used by Main-vs-Subagents + Cache Usage. |
| Chart primitive: ProfileLineChart (multi-series area+line) | data-viz | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:100`. Renders per-account (derivable-if-logged) trend. |
| Chart primitive: AccountBars | data-viz | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:177`. By-Account breakdown bars. |
| Chart primitive: DailyTokenChart (per-model daily lines) | data-viz | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:292`. Renders real DailyModelTokens series. |
| Chart primitive: ModelBars (per-model token bars) | data-viz | ⬜ deferred | `phase4.md P4-5` | `Pages.jsx:320`. By-Model; real ModelUsage tokens. |
| Card / CardTitle layout primitives (AccountsPage-local) | layout-primitive | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5` | `Pages.jsx:496`. Rebuild on P0-2 tokens (no inline style, backlog Step-1). |
| MOCK-DATA: per-token costUSD / $ cost series | mock-data | ✂️ cut | `Pages.jsx:252-255` (Codex subscription-billed, no per-token pricing) | Dropped MOCK field, not a dropped element; already removed from prototype render. |
| MOCK-DATA: hourly / 24h token series (HourlyBars data) | mock-data | ✂️ cut | `Pages.jsx:236-248`,`:476` (only per-day series upstream, `stats.ts:33`) | Dropped MOCK field. 7d/30d only. |
| MOCK-DATA: historical cache-rate trend chart | mock-data | ✂️ cut | `Pages.jsx:243-248`,`:717-719` (cache not a time series) | Dropped MOCK field; replaced by single derived Cache Usage stat (kept). |
| Dead helper: LineChart (defined, rendered 0×) | dead-code | ✂️ cut | `Pages.jsx:5`; grep `<LineChart` = 0 (superseded by ProfileLineChart) | Never-rendered legacy helper; not a shipped element. |
| Dead helper: HourlyBars (defined, rendered 0×) | dead-code | ✂️ cut | `Pages.jsx:39`; grep `<HourlyBars` = 0 (superseded by DailyTokenChart) | Never-rendered legacy helper; not a shipped element. |
| WorkspaceTrustSection (Settings section) | page-shell | ⬜ deferred | `phase4.md P4-14` (`:726`,`:746`), `STATUS.md:230` ⬜ | `Pages.jsx:789`. Renders settings VIEW; trust ACTION wiring is P4-15. Real store `config.ts:111,735-788`. |
| Trust — "Trust state" row + Trusted/Untrusted badge + Untrust/Trust button | toggle | ⬜ deferred | `phase4.md P4-14` (view); `phase4.md P4-15` (mutate gate) | `Pages.jsx:795`. P4-14 read-only view (`isPathTrusted`); the mutate button is P4-15's session-create gate — split flagged. |
| Trust — "Working directory" row (~/cat-code mono) | data-row | ⬜ deferred | `phase4.md P4-14` | `Pages.jsx:801`. Real cwd of active workspace. |
| Trust — "Detected repo" row (git remote origin) | data-row | ⬜ deferred | `phase4.md P4-14` | `Pages.jsx:804`. "github.com/acme/cat-code" is MOCK; owner renders real remote or flags. |
| Trust — "Additional trusted directories" block (+Add / × remove / "None added") | list-editor | ⬜ deferred | `phase4.md P4-14` | `Pages.jsx:807`. Real backing = additional-trusted-dirs store; prototype +Add/× mutate locally — P4-14 is read-only VIEW, write scope flagged. |
| DiagnosticsSection (Settings section) | page-shell | ⬜ deferred | `phase4.md P4-14` (`:743` recon, no demo stub), `STATUS.md:230` ⬜ | `Pages.jsx:831`. Adapt/recon (⚓0); mirrors /doctor + /status. |
| Diagnostics — kv() + sub() row primitives | layout-primitive | ⬜ deferred | `phase4.md P4-14` | `Pages.jsx:835`. Key-value + subheader (warn tone) primitives. |
| Diagnostics — Installation subsection (Running/Path/Invoked/Config/Search) | data-block | ⬜ deferred | `phase4.md P4-14` | `Pages.jsx:852`. ADAPT: values are MOCK Claude-Code npm-global literals; owner maps to cat-code /doctor reality. |
| Diagnostics — Updates subsection (Auto-updates/Channel/Stable/Latest + "Up to date") | data-block | ⬜ deferred | `phase4.md P4-14` | `Pages.jsx:860`. ADAPT: mock version literals; owner maps to real update state or flags if none. |
| Diagnostics — Sandbox subsection (warn "Missing dependencies" card) | data-block | ⬜ deferred | `phase4.md P4-14` | `Pages.jsx:871`. Optional; real /doctor sandbox check. Adapt/flag if unmodeled. |
| Diagnostics — Context Usage Warnings subsection (warn: large CLAUDE.md) | data-block | ⬜ deferred | `phase4.md P4-14` | `Pages.jsx:879`. Optional; real /doctor context-size warning. |
| Diagnostics — Status section (Version/Session/cwd/Account/Login/Model/IDE/MCP/Sources kv) | data-block | ⬜ deferred | `phase4.md P4-14` (real /status `status.tsx`) | `Pages.jsx:888`. ADAPT: mirrors real /status; values mock literals, owner binds to real helpers. |
| SettingRow / Section shared layout primitives | layout-primitive | ⬜ deferred | `phase4.md P4-14` | `Pages.jsx:750`. Plug into P4-3 SettingsShell (built); the removed Toggle → Settings.jsx SwToggle. |
| ConnectionDemoSection (4 state buttons: connected/reconnecting/disconnected/failed) | demo-control | ✂️ cut | `INVENTORY.md:110`; `phase4.md:744` (no demo stub) | `Pages.jsx:758`. Demo simulator (`window.setMockConnection`). Real state = ConnectionChip/`connectionState.ts` (P4-1, built). |
| PrototypeControlsSection (whole demo panel) | demo-control | ✂️ cut | `INVENTORY.md:110`; `Pages.jsx:904-907` self-labels "PROTOTYPE ONLY … Delete" | `Pages.jsx:908`. Dashed-border demo triggers panel; its buttons demo surfaces owned elsewhere. |
| Demo trigger: "Trigger permission queue" button | demo-control | ✂️ cut | `INVENTORY.md:110` (PrototypeControlsSection) | `Pages.jsx:919`. Real permission center already BUILT (`PermissionQueue.tsx`, P4-1) from runtime events. |
| Demo trigger: "Plan mode (plan panel)" Open/Clear buttons | demo-control | ✂️ cut | `INVENTORY.md:110`; real surface → `phase4.md P4-11` | `Pages.jsx:925`. Demo trigger cut; real PlanBar/PlanPanel owned by P4-11. |
| Demo trigger: "Simulate workspace switch" + WorkspaceSwitchPrompt render | demo-control | ✂️ cut | `STARTUP-GATES.md` G4 (`:15`), `INVENTORY.md:99` (WorkspaceSwitchPrompt CUT) | `Pages.jsx:936`,`:974`. Modal + "Open read-only" decline also CUT (Q1, `STARTUP-GATES.md:83`). One-cwd-per-session dissolves it. |
| Demo trigger: "Cross-project resume dialog" button | demo-control | ✂️ cut | `INVENTORY.md:110`; real surface → `phase4.md P4-16` | `Pages.jsx:944`. Real CrossProjectResumeDialog owned by P4-16. |
| Demo trigger: "Resume hydration overlay" Loading/Failed buttons | demo-control | ✂️ cut | `INVENTORY.md:110`; real surface → `phase4.md P4-16` | `Pages.jsx:947`. Real HydrationOverlay owned by P4-16. |
| Demo trigger: "Startup handoff banner" (resume/remote/connect/prefill/deep-link) | demo-control | ✂️ cut | `INVENTORY.md:110`; real surface → `phase4.md P4-15` | `Pages.jsx:954`. Real non-blocking startup banners owned by P4-15. |
| Demo trigger: "Forced re-authenticate" (Expired/Revoked) blocking dialog | demo-control | ✂️ cut | `INVENTORY.md:110`; blocking modal CUT `STARTUP-GATES.md` Q2 (`:84`) | `Pages.jsx:962`. Real reauth signal (`codexTokenRefresh.ts:449`) → non-blocking banner in P4-15. |
| Demo trigger: "Re-run onboarding" (reset startup) button | demo-control | ✂️ cut | `INVENTORY.md:110`; real flow → `phase4.md P4-15` | `Pages.jsx:969`. Real first-run flow (Trust gate → Codex OAuth) owned by P4-15; no user-facing reset verb. |

### 15. AccountLifecycle.jsx — GUI-native lifecycle dialogs + per-account ⋯ menu for the Codex account pool (add/login/switch/rename/delete/logout/touch-all)

**Migration target:** P4-5 (Accounts domain: AccountsPage + Codex pool/lease + AccountLifecycle) DONE ✅ · **Overall:** ✅ built (`app/renderer/src/AccountsPage.tsx` — dialogs + `AccountRowMenu` colocated; verbs via the app-owned `account.*` inbound seam, `app/sidecar/accountsDomain.ts`). §0: the Add/login OAuth back-channel is adapted/deferred to P4-15 (shared first-run OAuth surface). · **Prototype:** `~/catcode_prototype/cat-app/AccountLifecycle.jsx` (282 lines) · **INVENTORY:** W4 AccountLifecycle dialogs adapt/build-new (S8)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| `ALDialog` — modal shell (centered card, dark bg, border, radius, drop shadow) | chrome | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `phase4.md P4-5`; no renderer dialog (`ls app/renderer/src` has no account file) | Reusable frame all 6 dialogs share; inline styles → tokens (GROUND RULES: no inline style). |
| `ALDialog` — Escape key closes dialog | shortcut | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:38-42`; `phase4.md P4-5` | `window` keydown Escape → `onClose`; standard dismiss. |
| `ALDialog` — backdrop click-to-close + inner `stopPropagation` | control | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:43-45`; `phase4.md P4-5` | Click-outside dismiss. |
| `ALDialog` — blur backdrop + `toast-in` entrance animation | chrome | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:44-46`; `phase4.md P4-5` | `backdropFilter blur(3px)` + 0.18s anim; reuse existing app anim tokens. |
| `ALDialog` — header title + optional sub caption + optional footer slot + `width` prop | chrome | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:47-53`; `phase4.md P4-5` | Structural slots reused by every dialog. |
| `alBtn` — shared button variants (primary pink / ghost outline / danger red) | chrome | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:29-33`; `phase4.md P4-5` | Auditor-added: shared button token trio across all dialogs; inline → tokens in P4-5. |
| `AddAccountDialog` — 'connect' phase: title 'Add Codex account' + OAuth explainer (`127.0.0.1:1455`, no API key) | state | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:103-108`; `src/commands/login`; `src/components/ConsoleOAuthFlow.tsx` | Real `/login` OAuth; renderer drives nav, engine owns token (SECURITY-MINIMUM). |
| `AddAccountDialog` — 'Open browser to sign in' primary button (triggers `authorize`) | control | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:100-101`; `phase4.md P4-5` | Launch real OAuth via engine; coordinate shared surface with P4-15. |
| `AddAccountDialog` — Cancel button (connect + authorizing phases) | control | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:100,102`; `phase4.md P4-5` | Dismiss during add flow. |
| `AddAccountDialog` — 'authorizing' phase: spinner + 'Waiting for authorization in your browser…' | state | 🔁 adapted (§0 OAuth back-channel → P4-15; not built, not faked) | `AccountLifecycle.jsx:111-114`; `ConsoleOAuthFlow.tsx` | Real state = pending `localhost:1455` callback; P4-5 awaits real callback, not a timer. |
| `AddAccountDialog` — scripted 1400ms `setTimeout` simulating authorization completing | state | ✂️ cut | `AccountLifecycle.jsx:70-73` ('Simulated here'); "source wins" mock | DEMO-only; real completion is the OAuth callback resolving (`codex-client.ts:555-610`). |
| `AddAccountDialog` — manual fallback: 'Copy the sign-in link' button | control | 🔁 adapted (§0 OAuth back-channel → P4-15; not built, not faked) | `AccountLifecycle.jsx:117-121`; `ConsoleOAuthFlow.tsx:413,660` | Copies real authorization URL from engine when browser didn't open. |
| `AddAccountDialog` — manual fallback: 'Paste authorization code' input (Enter advances to alias) | control | 🔁 adapted (§0 OAuth back-channel → P4-15; not built, not faked) | `AccountLifecycle.jsx:122-126`; `ConsoleOAuthFlow.tsx:413,660` | Engine consumes pasted code; renderer never retains token (secretGuard). |
| `AddAccountDialog` — 'alias' phase: title 'Name this account' + optional-skip sub | state | 🔁 adapted (§0 OAuth back-channel → P4-15; not built, not faked) | `AccountLifecycle.jsx:81-83`; `phase4.md P4-5` | Post-login optional alias → `PoolAccount.alias`; re-login keep/new variant OUT of Add scope. |
| `AddAccountDialog` — alias text input (autoFocus, Enter=save) | control | 🔁 adapted (§0 OAuth back-channel → P4-15; not built, not faked) | `AccountLifecycle.jsx:87-92`; `phase4.md P4-5` | Feeds real alias write. |
| `AddAccountDialog` — alias validation error (regex `/^[a-zA-Z0-9_-]{1,32}$/`) | state | 🔁 adapted (§0 OAuth back-channel → P4-15; not built, not faked) | `AccountLifecycle.jsx:64,93`; `codexAccountPool.ts:870-895` | REAL validation rule, not mock; P4-5 must enforce identically. |
| `AddAccountDialog` — Skip + Save buttons (Save disabled on alias error) | control | 🔁 adapted (§0 OAuth back-channel → P4-15; not built, not faked) | `AccountLifecycle.jsx:84-86`; `phase4.md P4-5` | Skip = anonymous; Save = named; disabled styling on invalid alias. |
| `AddAccountDialog` — success toast ('Added account · alias' / 'Account added') | state | 🔁 adapted (§0 OAuth back-channel → P4-15; not built, not faked) | `AccountLifecycle.jsx:76`; real `app/renderer/src/ToastHost.tsx` (P4-1) | Wire to real ToastHost on command success (replaces `window.toast`). |
| `RenameAccountDialog` — title + sub ('Currently "alias". Aliases are unique, 1–32 chars.') | chrome | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:139-140`; `src/commands/rename-account` | Edits `PoolAccount.alias`. |
| `RenameAccountDialog` — alias input (autoFocus, Enter=save), prefilled with current alias | control | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:145-148`; `phase4.md P4-5` | Prefilled from `account.alias`. |
| `RenameAccountDialog` — validation: required / regex / already-in-use | state | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:135-138`; `codexAccountPool.ts` | Uniqueness check is REAL; `takenAliases` must come from real pool snapshot. |
| `RenameAccountDialog` — Cancel + Rename button (disabled on error) | control | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:143-144`; `phase4.md P4-5` | Rename fires real command. |
| `RenameAccountDialog` — 'Renamed to X' info toast | state | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:132`; real `ToastHost.tsx` | On command success. |
| `DeleteAccountDialog` — title 'Delete "alias"?' + destructive sub (removes profile, releases leases, irreversible) | chrome | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:159-161`; `src/commands/delete-account` | `/delete-account --confirm`; lease release is real. |
| `DeleteAccountDialog` — body copy naming alias whose token+alias are erased | chrome | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:167-168`; `phase4.md P4-5` | No token VALUE shown — only the alias; secretGuard-safe. |
| `DeleteAccountDialog` — active-account warning A: 'another will be activated' (`hasOtherSwitchable`) | state | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:169-170`; `phase4.md P4-5` | Real failover to another healthy account; `hasOtherSwitchable` derives from real pool. |
| `DeleteAccountDialog` — active-account warning B: 'no other usable account remains… none active' | state | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:171`; `phase4.md P4-5` | Zero-healthy terminal state = same condition P4-15 reauth banner blocks on; coordinate. |
| `DeleteAccountDialog` — Cancel + 'Delete account' danger button | control | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:163-164`; `phase4.md P4-5` | Danger styling; fires real delete command (`--confirm`). |
| `DeleteAccountDialog` — 'Deleted alias' default toast | state | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:164`; real `ToastHost.tsx` | On success. |
| `LogoutAccountDialog` — title 'Sign out "alias"?' + sub (clears session creds, profile stays) | chrome | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:178-180`; `src/commands/logout` | Clears `codexOAuth` token; vault profiles REMAIN. |
| `LogoutAccountDialog` — body copy pointing to `/delete-account` for full removal | chrome | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:186-187`; `phase4.md P4-5` | Distinguishes logout (token) vs delete (profile). |
| `LogoutAccountDialog` — Cancel + 'Sign out' button + 'Signed out X' warn toast | control | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:182-184`; `phase4.md P4-5` | Targets the ACTIVE account (source guard). |
| `TouchAllDialog` — title 'Refresh all accounts' + sub | chrome | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:206-207`; `src/commands/touch-all` | Refreshes OAuth tokens for every unlocked vault account. |
| `TouchAllDialog` — per-account result row list (alias + status pill) | state | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:209-217`; `touch-all.ts:21-27` / `codexTokenRefresh.ts:648-716` | Only vault-file accounts appear (config-only skipped) — REAL; P4-5 renders real OK/LOCKED/FAILED. |
| `TouchAllDialog` — result derivation from mock fields (`vaultLocked→LOCKED`, `dead→FAILED`, else OK) | data-binding | ✂️ cut | `AccountLifecycle.jsx:196-201` ('Mock:' l.200); "source wins" | Mock derivation dropped — real touch-all RETURNS the per-account result; display element is deferred above. |
| `TouchAllDialog` — in-flight running/loading UX + per-row spinner while running | state | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:202,214-216`; `touch-all.ts` runs over vault files | Real loading state; P4-5 drives spinner off real command progress (scripted 1100ms timer is dropped mock). |
| `TouchAllDialog` — footer button label 'Cancel' (running) / 'Done' (finished) | control | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:208`; `phase4.md P4-5` | Label swaps on completion. |
| `TouchAllDialog` — status color tokens (OK green / LOCKED gray / FAILED red) | chrome | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:205`; `phase4.md P4-5` | Map to real tone tokens (`tone.ts`) in P4-5. |
| `AccountRowMenu` — ⋯ overflow trigger button (hover/open bg states, title 'Account actions') | control | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:257-264`; INVENTORY W4 ('dialog surface is GUI-owned') | GUI-native invention (no upstream account-MENU); actions map to real commands. |
| `AccountRowMenu` — popover (positioned right/top, elevated card) | chrome | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:265-266`; `phase4.md P4-5` | Anchored menu container. |
| `AccountRowMenu` — outside-click + Escape close | shortcut | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:248-256`; `phase4.md P4-5` | Standard popover dismissal. |
| `AccountRowMenu` — 'Switch to this account' item (shown only when `switchable`) | control | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:275,279`; `codexAccountPool.ts:1288-1325` | REAL guard: `!isDflt && status==='healthy' && !usageLimitReached`; maps to `/switch-account` (synchronous). |
| `AccountRowMenu` — 'Rename' item (shown only for vault accounts) | control | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:276,280`; rename `*.ts:102-114` | `isVault=!!vaultFilePath` gate; config-only accounts can't rename. |
| `AccountRowMenu` — 'Sign out' item (shown only for the default/active account) | control | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:277,281`; `phase4.md P4-5` | `isDflt` gate; logout targets active account. |
| `AccountRowMenu` — 'Delete' item (danger styling, shown only for vault accounts) | control | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:278,282`; `phase4.md P4-5` | `isVault` gate + danger color; maps to `/delete-account`. |
| `AccountRowMenu` — `isDefault` binding (`activeCodexAccountId`, legacy `account.active` fallback) | data-binding | ✅ built (P4-5, `app/renderer/src/AccountsPage.tsx`) | `AccountLifecycle.jsx:242-245`; `phase4.md P4-5` | P4-5 read-seam exposes redacted `{id, alias, status, isDefault, usageLimitReached, vaultFilePath-presence}` — NO tokens (secretGuard). |

### 16. SessionsPage.jsx — the cross-workspace Sessions MANAGER (browse/search/filter/sort, multi-select bulk ops, per-row actions), distinct from the sidebar switcher

**Migration target:** deferred → P4-6 (`SessionsPage` + `SessionActionsMenu` + Branch/Export/Rewind dialogs + `MetadataInspector`; `SessionActions.jsx`/`MetadataInspector.jsx` same owner; shared catalog selector w/ P4-17) · **Overall:** ⬜ deferred · **Prototype:** `~/catcode_prototype/cat-app/SessionsPage.jsx` (670 lines) · **INVENTORY:** W4 SessionsPage adapt (S4)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Page scroll container (no-scrollbar, overflowY auto, 28px pad, relative for overlays) | chrome | ⬜ deferred | `phase4.md:427` P4-6 | 820px max-width centered column (`:464`); nothing built (only `rendererSessionIsolation.test.ts` in app/renderer/src). |
| Header 'Sessions' h1 title | chrome | ⬜ deferred | `phase4.md:427` P4-6 | Static page title (`:469`). |
| Session-count subtitle ('N sessions · M workspaces') | data-binding | ⬜ deferred | `phase4.md:427` P4-6 | Adapt: workspace count keys on real cwd not mock workspace name; shown only when `allProjects && >1` cwd (`:470`). |
| 'New session' button (→ onSessionSelect('new') → chat) | control | ⬜ deferred | `phase4.md:427` P4-6 | Must route through real create-session verb (`hostApi.ts` CreateSessionInput picker-token+title; HC1 renderer can't author cwd). `:475` |
| Two-row toolbar container (row1 search+sort+toggles · row2 tag tabs) | layout | ⬜ deferred | `phase4.md:427` P4-6 | Auditor-added: distinct toolbar region wrapping the filter/sort controls (`:485`). |
| Search input ('Search sessions…', focus pink border) | control | ⬜ deferred | `phase4.md:427` P4-6 | Filters over title/branch/tag/prNumber/remote (`:146-153`) — all real-backed except 'remote' literal. |
| Search magnifier icon (absolute-positioned) | chrome | ⬜ deferred | `phase4.md:427` P4-6 | Decorative (`:488`). |
| Sort menu trigger button (icon + label + chevron rotate) | control | ⬜ deferred | `phase4.md:427` P4-6 | Open/closed border+bg; chevron rotates 180° when open (`:500`). |
| Sort dropdown popover + full-screen scrim | control | ⬜ deferred | `phase4.md:427` P4-6 | Scrim click closes (`:511`); options list with active-check. |
| Sort option: 'Recent activity' (default) | control | ⬜ deferred | `phase4.md:427` P4-6 | Adapt: sort on real mtime, not the mock 'Nm ago' string parser `spRecency` (`:38-52`). |
| Sort option: 'Most active' (by message count) | control | ⬜ deferred | `sessionStorage.ts:2829` countVisibleMessages | Prototype already derives from real transcript, not stale field (`:59`). Real-backed. |
| Sort option: 'Name (A–Z)' | control | ⬜ deferred | `hostApi.ts:73` title (nullable) | Depends on real title populated — see P4-6 title rider (`STATUS.md:222`). |
| 'All workspaces' toggle (blue active, home icon) | control | ⬜ deferred | `phase4.md:427` P4-6 | Adapt: real = all cwds vs active session cwd (mock workspace name / `CURRENT_WORKSPACE` hardcode both source-wins). `:530` |
| 'Remote' filter toggle (shown only when remote sessions in scope) | control | ⬜ deferred | `src/remote/RemoteSessionManager.ts` (real) | FLAG: chrome is P4-6-owned but remote-CCR-in-app capability unowned; D3 cut paired-devices + D6 sessions-die-with-window → may become CUT. `:546` |
| Tag filter tabs ('All' + one per tag) | control | ⬜ deferred | `sessionStorage.ts:1085` currentSessionTag | allTags derived from real tags; single-tag model matches real (`:566`). |
| Empty state (icon + headline + subtext) | ux-state | ⬜ deferred | `phase4.md:427` P4-6 | 4 headline variants (search/remote/tagged/none) + 2 subtext variants (`:581-589`). |
| Flat list layout (non-recent sorts, single workspace) | layout | ⬜ deferred | `phase4.md:427` P4-6 | No date groups when sort ≠ 'recent' (`:600`). |
| Workspace-grouped layout (spGroupByWorkspace, current-first then alpha) | layout | ⬜ deferred | `phase4.md:427` P4-6 | Adapt: group by real cwd basename (`Sidebar.tsx` P4-4 already does cwd grouping); shown only when >1 workspace (`:594`). |
| Date-bucket grouping (Today/Yesterday/This week/Older + per-bucket count) | layout | ⬜ deferred | `phase4.md:427` P4-6 | Adapt: derive buckets from real mtime, not mock 'Nm ago' `spDateBucket` (`:15-29`). |
| GroupHeader (folder icon, workspace name, 'current' badge, count, divider) | chrome | ⬜ deferred | `phase4.md:427` P4-6 | Adapt: name = cwd basename; 'current' = active session cwd (`:362`). |
| DateGroups sub-header (label, divider, count) | chrome | ⬜ deferred | `phase4.md:427` P4-6 | Nested inside workspace groups for recent sort (`:176`, `:606`). |
| Session row (SRow) — hover/selected/cross-project/menu-open border+bg states | ux-state | ⬜ deferred | `phase4.md:427` P4-6 | 4 visual states via border/bg maps (`:241-247`). |
| Row click → open session + switch to chat page | control | ⬜ deferred | `phase4.md:427` P4-6 | Suppressed while renaming (`:253`); real resume/open verb. |
| Row right-click → context (actions) menu at cursor | control | ⬜ deferred | `phase4.md:443` SessionActions.jsx | Opens same menu as ⋯, anchored to cursor (`:254`). |
| Row leading icon/checkbox — msg / bot(agent) / blank(hover) / check(selected) | chrome | ⬜ deferred | `sessionStorage.ts:1113` mode | 4-way icon swap; click toggles selection (`:266`). |
| Row checkbox select toggle | control | ⬜ deferred | `phase4.md:427` P4-6 | stopPropagation; feeds multi-select Set (`:267`). |
| Row title text (ellipsis, nowrap) | data-binding | ⬜ deferred | `hostApi.ts:73` + `sessionTitle.ts:89` | FLAG (P4-6 rider `STATUS.md:222`): desktop sessions have NO populated title today → falls back to cwd basename; P4-6 must wire AI-title/rename. `:304` |
| Inline rename input (autofocus, Enter commit / Escape cancel / blur commit) | control | ⬜ deferred | `phase4.md:439` P4-6 rename | Adapt: rename must persist via real registry-title / saveAiGeneratedTitle, not renderer-local titleOverrides Set (`:293`). |
| 'orchestrating' badge (agent-mode rows) | chrome | ⬜ deferred | `sessionStorage.ts:1113` mode==='agent' | Pink uppercase pill (`:308`). |
| 'cross-project' badge (session outside current workspace, flat view) | chrome | ⬜ deferred | `phase4.md:427` P4-6 | Adapt: real = session cwd ≠ active cwd; shown only when NOT grouped (`:311`). |
| Meta chip: project path (folder icon, mono) | data-binding | ⬜ deferred | `sessionStorage.ts:2843` firstMessage.cwd | Hidden when workspace-grouped (`:224`). |
| Meta chip: last activity (clock icon) | data-binding | ⬜ deferred | registry lastAttachedAt / transcript mtime | Adapt: format a real timestamp; mock 'Nm ago' string source-wins (`:225`). |
| Meta chip: git branch (branch icon, mono) | data-binding | ⬜ deferred | `sessionStorage.ts:1327` branch | Real-backed (`:226`). |
| Meta chip: message count (msg icon) | data-binding | ⬜ deferred | `sessionStorage.ts:2829` countVisibleMessages | Prototype prefers DERIVED count over stale field (`:230-231`) — carry forward. |
| Meta chip: agent setting (mono, purple) | data-binding | ⬜ deferred | `sessionStorage.ts:1106` agentSetting | Text only, no icon (`:233`). |
| Meta chip: PR number / repo#num (pr icon, mono) | data-binding | ⬜ deferred | `types/logs.ts:50` + `format.ts:230` | owner/repo#N format matches `format.ts:231` (`:234`). |
| Meta chip: 'Remote' (globe icon) | data-binding | ⬜ deferred | `src/remote/RemoteSessionManager.ts` (real) | FLAG: same caveat as remote filter — capability unowned, may be CUT (D6); viewer/controller role intentionally not labeled (D3-cut, `:237`). |
| Tag pill button (existing tag, click → edit) | control | ⬜ deferred | `sessionStorage.ts:1085` tag | Opens TagPopover; adapt write to real op not tagOverrides Set (`:327`). |
| '+ tag' add button (dashed, hover-only) | control | ⬜ deferred | `phase4.md:427` P4-6 | Appears on row hover when no tag (`:331`). |
| Row overflow ⋯ button (hover/menu-open opacity+bg) | control | ⬜ deferred | `phase4.md:443` SessionActions.jsx | Opacity 0 until hover/open; anchors menu bottom-right (`:343`). |
| TagPopover panel + scrim (above/below auto-placement, viewport clamp) | chrome | ⬜ deferred | `phase4.md:427` P4-6 | placeAbove logic, left-clamped to viewport (`:383-388`). |
| TagPopover header ('Set tag' / 'Tag N sessions' bulk) | chrome | ⬜ deferred | `phase4.md:427` P4-6 | Single vs bulk copy (`:392`). |
| TagPopover filter/create input (autofocus, Enter apply-or-create, Escape close) | control | ⬜ deferred | `phase4.md:427` P4-6 | Enter resolves exact / create / first match (`:396-399`). |
| TagPopover matching-tag list (active-check on current) | control | ⬜ deferred | `phase4.md:427` P4-6 | Scrollable no-scrollbar; check on active (`:405`). |
| TagPopover 'Create #tag' option | control | ⬜ deferred | `phase4.md:427` P4-6 | Shown when query novel (canCreate) (`:418`). |
| TagPopover empty hint ('Type to create a tag') | ux-state | ⬜ deferred | `phase4.md:427` P4-6 | No matches + no create (`:427`). |
| TagPopover 'Remove tag' option (single, when tagged) | control | ⬜ deferred | `phase4.md:427` P4-6 | applyTag(null); hidden for bulk (`:434`). |
| Floating bulk-action bar (selection > 0, offset left:48 for sidebar rail) | ux-state | ⬜ deferred | `phase4.md:427` P4-6 | toast-in animation; pointer-events gated (`:617`). |
| Bulk bar 'N selected' label | data-binding | ⬜ deferred | `phase4.md:427` P4-6 | Live selection Set size (`:620`). |
| Bulk 'Select all / Deselect all N' toggle | control | ⬜ deferred | `phase4.md:427` P4-6 | Over visibleIds; label flips on allSelected (`:621`). |
| Bulk action: Tag | control | ⬜ deferred | `phase4.md:439` P4-6 tag | Opens TagPopover in bulk mode (`:625`). |
| Bulk action: Export | control | ⬜ deferred | `phase4.md:439` P4-6 export | Must reach real export verb, not a mock toast (`:626`). |
| Bulk action: Archive | control | ⬜ deferred | `phase4.md:427` P4-6 | FLAG: 'archive' has NO obvious real engine verb (grep found none); prototype = hidden Set only (`:196`) — P4-6 must define a real op or merge with delete. `:627` |
| Bulk action: Delete | control | ⬜ deferred | `phase4.md:439` P4-6 delete | Adapt: real transcript/registry delete verb, not local hidden Set (`:628`). |
| Bulk bar 'Clear selection' X button | control | ⬜ deferred | `phase4.md:427` P4-6 | Resets selection Set (`:629`). |
| Toast host (transient success, offset left:48, hidden while bulk bar shown) | ux-state | ⬜ deferred | `app/renderer/src/ToastHost.tsx` (P4-1 built) | Wire prototype window.toast → real P4-1 ToastHost provider; 2.3s auto-dismiss (`:137`, `:640`). |
| SessionActionsMenu invocation (row ⋯ + right-click; hide=['metadata']) | sub-component | ⬜ deferred | `phase4.md:443` SessionActions.jsx | Verbs open/rename/tag/branch/rewind/export/copy-md/copy-text/archive/delete (`:117-127`); metadata deliberately hidden here (`:656`). |
| BranchDialog invocation | sub-component | ⬜ deferred | `phase4.md:439` P4-6 branch | Separate surface; real branch verb (`:663`). |
| RewindDialog invocation | sub-component | ⬜ deferred | `phase4.md:439` P4-6 rewind | Separate surface; real rewind/checkpoint (`:664`). |
| ExportDialog invocation | sub-component | ⬜ deferred | `phase4.md:439` P4-6 export | Separate surface; real export verb (`:665`). |
| Copy-as-Markdown / Copy-as-text row actions (saToMarkdown/saToText) | control | ⬜ deferred | `phase4.md:439` P4-6 copy | Prototype uses window.sa* globals over mock messages; real = shared selector + transcript (`:123`). |
| MOCK_SESSIONS_EXTENDED data source | data-binding | ⬜ deferred | `phase4.md:441` catalog selector | Source-wins: replace whole mock fixture with real D1 registry ∪ transcript-history selector (shared w/ P4-17) (`:107`). |

### 17. SessionActions.jsx — per-session actions menu + Branch/Rewind/Export dialogs shared by Sessions-page and Chat-header entry points

**Migration target:** deferred → P4-6 · **Overall:** ⬜ deferred · **Prototype:** `~/catcode_prototype/cat-app/SessionActions.jsx` (389 lines) · **INVENTORY:** W4 SessionActionsMenu + Branch/Export/Rewind dialogs adapt (S4)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| `SessionActionsMenu` dropdown popover (fixed, anchored to button rect / right-click point) | chrome/container | ⬜ deferred | `phase4.md P4-6` | Unbuilt; grep of `app/renderer/src` finds no menu, only pointer `Sidebar.tsx:17-19`. GUI-owned chrome per `INVENTORY.md` W4. |
| SA_IC action-icon vocabulary (open/rename/tag/branch/rewind/export/copy/archive/trash/meta/md/json/file/warn/close) | chrome | ⬜ deferred | `phase4.md P4-6` | Auditor-added: 15 stroke glyphs `SessionActions.jsx:13-30` shared across menu+dialogs; P4-6 supplies the real icon set. |
| Menu anchor positioning: clamp left into viewport; flip above when near bottom (`placeAbove`) | ux-state | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:110-113`; `placeAbove = anchor.top > innerHeight-320`. |
| Full-screen backdrop scrim: left-click closes, right-click (`onContextMenu`) also closes | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:190`; right-click-dismiss supports the Sessions-page context-menu entry point. |
| Escape-to-close keyboard handler (menu) | keyboard | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:104-107`. |
| `sa-pop` entry animation (menu + modals) | chrome/anim | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:191` (0.12s) / `:214` (0.14s). Visual polish. |
| Menu `Row`: leading icon + label + optional monospace sub-hint + optional flyout chevron | chrome/subcomponent | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:115-143`; reusable row grammar. |
| Menu Row hover/focus styling (pink tint normal, red tint danger; icon color shift) | ux-state | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:125-136`; danger rows use red hover. |
| `SectionLabel` (uppercase letter-spaced header, e.g. "HISTORY") | chrome | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:144-146`. |
| `Divider` between menu sections | chrome | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:147`. |
| "Open" menu row (`kind=open`) | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:151`; NOT in P4-6's explicit verb list — P4-6 confirms real reopen/resume wiring (`src/commands/resume`). |
| "Rename" menu row with ⏎ sub-hint (`kind=rename`) | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:152`; real verb `src/commands/rename/rename.ts`. |
| "Add tag" / "Edit tag" menu row (label toggles on `hasTag`) (`kind=tag`) | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:153`; real verb `src/commands/tag/tag.tsx`; `hasTag` drives Add\|Edit label. |
| "History" section grouping (Branch/Rewind/Metadata under one label) | chrome | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:155-169`. |
| "Branch from message…" row (`kind=branch`) → opens `BranchDialog` | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:156`; wire to real `src/commands/branch/index.ts`. |
| "Rewind to message…" row (`kind=rewind`) → opens `RewindDialog` | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:157`; wire to real `src/commands/rewind/index.ts`. |
| "Inspect metadata…" row (`kind=metadata`) → opens `MetadataInspector` | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:158`; MetadataInspector is a separate `INVENTORY.md` W4 row also P4-6. |
| "Copy" menu row with side flyout submenu (`hasFlyout`, chevron) | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:172-182`; Copy is in P4-6's verb list, flyout is chrome. |
| Copy flyout: "Copy as Markdown" (`kind=copy-md`) | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:177`; P4-6 reuses real `/export` markdown output. |
| Copy flyout: "Copy as text" (`kind=copy-text`) | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:178`; Copy=md+text vs Export=md+JSON (asymmetric) — P4-6 reconcile. |
| Copy flyout hover-open / mouse-leave-close (`copyOpen` state) | ux-state | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:101,173-174`. |
| "Export…" menu row (`kind=export`) → opens `ExportDialog` | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:183`; real verb `src/commands/export/export.tsx`. |
| "Archive" menu row (`kind=archive`) | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:163`; no confirmed engine archive verb; D6 sessions die-with-window v1 → P4-6 flag-or-back per its "no backing → flag" rule. |
| "Delete" menu row, danger styling (`kind=delete`) | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:164`; no confirmed persisted-session delete verb (`src/commands` has delete-account) — P4-6 confirm backing (D6) or flag. |
| `hide`/`skip` per-entry-point row filtering (Sessions-page vs Chat-header show different subsets) | data-binding | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:102`; single menu serves two entry points (`:4-6`). |
| Empty-section collapse: section + its divider drop when all rows hidden | ux-state | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:149-197` (`.filter(Boolean)` + length checks). Prevents orphan dividers. |
| `SAModal` shell: blurred scrim + centered card, click-scrim-to-close, `stopPropagation` on card | chrome/container | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:206-232`; shared by Branch/Rewind/Export. |
| `SAModal` header: tinted icon chip + title + optional subtitle + close (×) | chrome | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:215-226`; `iconTint` blue\|amber\|pink per dialog. |
| `SAModal` close button hover state | ux-state | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:222-223`. |
| `SAModal` scrollable body (no-scrollbar, maxHeight 86vh) | chrome | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:227`. |
| `SAModal` footer slot (right-aligned action bar) | chrome | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:228`. |
| `SAModal` Escape-to-close handler | keyboard | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:207-211`. |
| `saBtn` primitive: primary / danger / disabled button variants | chrome/subcomponent | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:233-241`; P4-1 shared kit exists (`app/renderer/src`) — P4-6 may reuse rather than re-add. |
| `SAMessagePicker`: radio-select transcript list (shared Branch + Rewind) | subcomponent | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:244-277`; P4-6 feeds real transcript. |
| Message-picker role badge (You / Cat Code / Thinking / Tool) with role tint | chrome | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:53-58,267`; role vocab overlaps AgentIdentity (P4-2, `app/renderer/src/agentIdentity.ts`) — P4-6 source there. |
| Message-picker per-row index (`#N`) | chrome | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:268`. |
| Message-picker preview text (`saPreview`: content, or `toolName · summary`) | data-binding | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:59-63,270`; P4-6 binds real message content/tool summary. |
| Message-picker radio indicator (ring, filled dot when selected) | chrome | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:262-264`. |
| Message-picker selected-row accent styling (accent border/background) | ux-state | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:249,256`; accent per dialog (blue branch / amber rewind). |
| Message-picker dimmed rows past selection (`fromTop`, rewind only) | ux-state | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:252,257`; hint that rows after rewind point are discarded. |
| Message-picker row hover state | ux-state | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:259-260`. |
| `BranchDialog` modal (blue accent, branch icon, "Branch session" + subtitle) | subcomponent | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:280-303`; shell over real `src/commands/branch`. |
| BranchDialog default selection = last message | ux-state | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:282`. |
| BranchDialog "Branch from message" label + `SAMessagePicker` | chrome | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:290-291`. |
| BranchDialog preview callout: new-name `"title (branch)"` + "keeps 1–N \| drops M after" | data-binding | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:283,292-300`; P4-6 derives from real branch point. |
| BranchDialog Cancel button | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:287`. |
| BranchDialog "Create branch" primary action (fires mock success toast) | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:288`; toast is mock (source wins) → P4-6 replaces with real `/branch` invocation. |
| `RewindDialog` modal (amber accent, rewind icon, "Rewind session" + subtitle) | subcomponent | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:312-348`; shell over real `src/commands/rewind`. |
| RewindDialog default selection = second-to-last message | ux-state | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:314`. |
| RewindDialog "Rewind to message" label + `SAMessagePicker` (`fromTop` dim) | chrome | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:324-325`. |
| RewindDialog "Files that will revert" section + per-file rows (file icon, path, diff counts) | data-binding | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:328-338`; REAL backing `src/utils/fileHistory.ts:414` (`fileHistoryGetDiffStats`), `DiffStats:55`, `fileHistoryRewind:347` — wire to real diff stats; add/del labels visually swapped in prototype, fix during wiring. |
| `SA_FILE_HISTORY` mock file-history fixture (3 hardcoded files w/ add/del counts) | mock-fixture | ✂️ cut | `SessionActions.jsx:307-311` | "Source wins": drop the fake array, keep the element (row above) wired to real `fileHistory.ts:414`. |
| RewindDialog warning callout ("N messages + edits undone, can't be reversed") | chrome | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:315,340-345`; destructive warning bound to real rewind scope. |
| RewindDialog Cancel button | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:321`. |
| RewindDialog "Rewind to #N" primary+danger action (mock warn toast) | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:322`; P4-6 replaces mock toast with real `/rewind` invocation. |
| `ExportDialog` modal (pink accent, export icon, "N messages · title", width 580) | subcomponent | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:351-387`; shell over real `src/commands/export`. |
| ExportDialog format segmented control (Markdown / JSON) with selected state | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:358-369,378-381`; reconcile formats vs real `/export` capabilities. |
| ExportDialog live content preview pane (`<pre>`, scrollable, monospace) | chrome | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:382-384`; P4-6 renders real `/export` serialized output. |
| ExportDialog derived filename (slugified title + `.md`/`.json`) shown in footer | data-binding | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:356,374`. |
| ExportDialog "Copy" button (clipboard + toast) | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:375`; maps to `/export` clipboard mode. |
| ExportDialog "Download" primary button (file write + mock toast) | interactive | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:376`; P4-6 wires real `/export` file write, mock toast dropped. |
| `saGetMessages`: pull real transcript for the session | data-binding | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:43-51` reads `window.MOCK_MESSAGES`; P4-6 binds real transcript via `src/utils/sessionStorage.ts` (`getTranscriptPathForSession`). |
| `saGetMessages` hardcoded 4-message fallback transcript (auth/JWT demo) | mock-fixture | ✂️ cut | `SessionActions.jsx:45-50` | "Source wins": cut the fake fallback; P4-6 shows real transcript or a real empty state. |
| `saToMarkdown` / `saToText` / `saToJSON` transcript serializers | data-binding | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:66-91`; P4-6 reuses real `src/commands/export/export.tsx` serializer, not re-implement. |
| `saCopy` helper (clipboard write + success toast) | data-binding | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:92-95`; toast maps to `app/renderer/src/ToastHost.tsx` (P4-1, built). |
| `window.toast` integration (success/warn tones on action completion) | integration | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:94,288,322,376`; real toast host BUILT `app/renderer/src/ToastHost.tsx` (P4-1) — P4-6 routes real results through it. |
| Two entry-point integration: Sessions-page row ⋯ + right-click, and Chat-header overflow ⋯ | integration | ⬜ deferred | `phase4.md P4-6` | `SessionActions.jsx:4-6`; P4-6 owns Sessions-page + shared menu/dialogs; Chat-header entry depends on Chat surface (P4-0) mounting the same menu. |

### 18. MetadataInspector.jsx — read-only right drawer exposing raw metadata for a transcript message + its session

**Migration target:** deferred → P4-6 (`SessionsPage`/`SessionActions`/`MetadataInspector`) · **Overall:** ⬜ deferred · **Prototype:** `~/catcode_prototype/cat-app/MetadataInspector.jsx` (191 lines) · **INVENTORY:** W4 MetadataInspector adapt (S4)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Backdrop scrim (fixed inset, z-index 80, rgba(0,0,0,0.5)) | chrome | ⬜ deferred | `MetadataInspector.jsx:70` · `phase4.md P4-6` | Not built (grep 0 hits in `app/renderer/src`); owner P4-6 `STATUS.md:222` ⬜. GUI chrome. |
| Backdrop click-to-close (onClick=onClose on scrim) | interaction | ⬜ deferred | `MetadataInspector.jsx:70` · `phase4.md P4-6` | Dismiss gesture; wire to drawer close state in P4-6. |
| Right-drawer panel container (min(520px,92vw), borderLeft, -20px shadow) | chrome | ⬜ deferred | `MetadataInspector.jsx:71` · `phase4.md P4-6` | Fixed full-height right drawer; no inline style in real build. |
| Drawer slide-in animation (toast-in 0.18s ease) | chrome | ⬜ deferred | `MetadataInspector.jsx:71` · `phase4.md P4-6` | Reuses shared toast-in keyframe; port as CSS class. |
| Escape-key closes drawer (window keydown) | shortcut | ⬜ deferred | `MetadataInspector.jsx:53` · `phase4.md P4-6` | Also advertised in close-button title 'Close (Esc)'. |
| Header bar (title/subtitle/badge/close, borderBottom, flexShrink:0) | chrome | ⬜ deferred | `MetadataInspector.jsx:74` · `phase4.md P4-6` | Fixed header row. |
| Header title 'Metadata' | chrome | ⬜ deferred | `MetadataInspector.jsx:76` · `phase4.md P4-6` | Static label. |
| Header subtitle: messageId · session title (mono, ellipsis) | data-binding | ⬜ deferred | `MetadataInspector.jsx:77` · `phase4.md P4-6` | session.title EMPTY for desktop sessions → cwd-basename fallback (P4-4 rider `STATUS.md:222`, `TabBar.tsx:353`). |
| 'read-only' badge/pill in header | chrome | ⬜ deferred | `MetadataInspector.jsx:79` · `phase4.md P4-6` | Static uppercase badge; matches INVENTORY 'read-only metadata inspector'. |
| Close (X) button + hover states + title 'Close (Esc)' | interaction | ⬜ deferred | `MetadataInspector.jsx:80` · `phase4.md P4-6` | 30x30 icon button; hover bg/color transition, port to class. |
| Close-icon SVG (miCloseIcon) | chrome | ⬜ deferred | `MetadataInspector.jsx:21` · `phase4.md P4-6` | Inline 16x16 X stroke icon. |
| Scrollable body container (no-scrollbar, overflow-y auto) | chrome | ⬜ deferred | `MetadataInspector.jsx:87` · `phase4.md P4-6` | flex:1 scroll region holding all sections. |
| MIRow primitive (128px label / 1fr value grid, optional mono) | subcomponent | ⬜ deferred | `MetadataInspector.jsx:26` · `phase4.md P4-6` | Reusable key/value row grammar; no real-app equivalent yet. |
| MISection primitive (uppercase title + optional count + divider) | subcomponent | ⬜ deferred | `MetadataInspector.jsx:35` · `phase4.md P4-6` | Count slot used by Content replacements + File history. |
| MIPill primitive (colored text+bg+border chip, mono) | subcomponent | ⬜ deferred | `MetadataInspector.jsx:48` · `phase4.md P4-6` | P4-6 could adapt existing `app/renderer/src/Chip.tsx` (P4-1) vs new pill. |
| Session section (header 'Session') | chrome | ⬜ deferred | `MetadataInspector.jsx:90` · `phase4.md P4-6` | Section wrapper. |
| Session ID row (mono) | data-binding | ⬜ deferred | `MetadataInspector.jsx:91` · `src/types/logs.ts:13` | Source-backed sessionId; direct render of real uuid. |
| Mode row → MIPill via MI_MODE (agent/coordinator/normal) | data-binding | ⬜ deferred | `MetadataInspector.jsx:92` · `phase4.md P4-6` | FLAG: verify a single per-session 'mode' field exists (`src/agent-mode/`); adapt if not. MI_MODE (10-13) is presentation. |
| Permission mode row (mono) | data-binding | ⬜ deferred | `MetadataInspector.jsx:93` · `phase4.md P4-6` | Real engine permission-mode enum; render current mode. |
| Tag row → #tag pink pill, or 'none' fallback | data-binding | ⬜ deferred | `MetadataInspector.jsx:94` · `phase4.md P4-6` | FLAG: prototype models a SINGULAR tag; verify real backing before render. Includes empty 'none' state. |
| Worktree section (header 'Worktree') | chrome | ⬜ deferred | `MetadataInspector.jsx:98` · `phase4.md P4-6` | Section wrapper; body conditional on worktreeSession. |
| Worktree Path row (mono) | data-binding | ⬜ deferred | `MetadataInspector.jsx:101` · `src/types/logs.ts:52` | Source-backed worktreePath (PersistedWorktreeSession). |
| Worktree Branch row (mono) | data-binding | ⬜ deferred | `MetadataInspector.jsx:102` · `src/types/logs.ts:52` | Source-backed worktreeBranch. |
| Worktree Original branch row (mono) | data-binding | ⬜ deferred | `MetadataInspector.jsx:103` · `src/types/logs.ts:52` | Source-backed originalBranch. |
| Worktree Original cwd row (mono) | data-binding | ⬜ deferred | `MetadataInspector.jsx:104` · `src/types/logs.ts:52` | Source-backed originalCwd. |
| Worktree HEAD-at-entry row (mono, conditional) | data-binding | ⬜ deferred | `MetadataInspector.jsx:105` · `phase4.md P4-6` | FLAG: confirm originalHeadCommit is on the real worktree record. |
| Worktree empty state 'Not in a worktree.' | ux-state | ⬜ deferred | `MetadataInspector.jsx:107` · `phase4.md P4-6` | Explicit empty state (worktreeSession null=exited/undefined=never). |
| Thread goal section (header 'Thread goal') | chrome | ⬜ deferred | `MetadataInspector.jsx:111` · `phase4.md P4-6` | Section wrapper; body conditional on threadGoal. |
| Goal Objective row | data-binding | ⬜ deferred | `MetadataInspector.jsx:114` · `src/types/logs.ts:53` | Source-backed (ThreadGoal); goalSnapshot validated per SECURITY-MINIMUM T4. |
| Goal Status row → MIPill via MI_GOAL (active/paused/budget_limited/complete) | data-binding | ⬜ deferred | `MetadataInspector.jsx:115` · `phase4.md P4-6` | Verify real status enum matches. MI_GOAL map (14-19) is presentation. |
| Goal Budget row (mono): 'Xk / Yk tokens' or 'unbounded' | data-binding | ⬜ deferred | `MetadataInspector.jsx:116` · `phase4.md P4-6` | Source-backed tokenBudget/tokensUsed; 'unbounded' branch + ÷1000 formatting. |
| Goal Time-used row (mono): 'Xm Ys' | data-binding | ⬜ deferred | `MetadataInspector.jsx:117` · `phase4.md P4-6` | Source-backed timeUsedSeconds; min/sec formatting. |
| Goal ID row (mono) | data-binding | ⬜ deferred | `MetadataInspector.jsx:118` · `phase4.md P4-6` | Source-backed goalId (mock g_8841 is fixture). |
| Thread-goal empty state 'No goal on this thread.' | ux-state | ⬜ deferred | `MetadataInspector.jsx:120` · `phase4.md P4-6` | Explicit empty state when threadGoal absent. |
| Attribution section (header 'Attribution') | chrome | ⬜ deferred | `MetadataInspector.jsx:124` · `phase4.md P4-6` | Section wrapper. |
| Surface row → MIPill blue (cli\|ide\|web\|api) | data-binding | ⬜ deferred | `MetadataInspector.jsx:125` · `phase4.md P4-6` | FLAG: verify per-message surface-origin backing; substitute for the invented account field. |
| Model row (mono) | data-binding | ⬜ deferred | `MetadataInspector.jsx:126` · `phase4.md P4-6` | Source-backed per-message model (mock claude-opus-4-6 is fixture). |
| Request ID row (mono, conditional) | data-binding | ⬜ deferred | `MetadataInspector.jsx:127` · `phase4.md P4-6` | FLAG: confirm requestId persisted on LOCAL transcript msgs, not only `src/remote/`; adapt if remote-only. |
| Account-absence note ('No per-message account is recorded upstream…') | chrome | ⬜ deferred | `MetadataInspector.jsx:129` · `INVENTORY.md:76` | KEEP — prototype's own correct acknowledgement that account attribution doesn't exist upstream. |
| Per-message ACCOUNT field (conceptual — never rendered) | data-binding | ✂️ cut | `phase4.md:454` · `INVENTORY.md:76` | Invented field; prototype itself refuses to render it and substitutes surface+model. Dropped INVENTED data, not a lost UX element. |
| Subagent section (conditional on mm.subagent) | ux-state | ⬜ deferred | `MetadataInspector.jsx:133` · `src/types/logs.ts:30` | Whole section omitted when not a subagent msg (isSidechain, no empty copy). |
| Subagent Agent row: agentName · agentType | data-binding | ⬜ deferred | `MetadataInspector.jsx:135` · `phase4.md P4-6` | Could reuse `app/renderer/src/agentIdentity.ts` vocabulary (P4-2 built). |
| Subagent Agent ID row (mono) | data-binding | ⬜ deferred | `MetadataInspector.jsx:136` · `phase4.md P4-6` | Source-backed agentId. |
| Subagent Tool use ID row (mono) | data-binding | ⬜ deferred | `MetadataInspector.jsx:137` · `src/types/logs.ts:320` | Source-backed toolUseId that spawned the subagent. |
| Subagent Sidechain row: yes/no | data-binding | ⬜ deferred | `MetadataInspector.jsx:138` · `src/types/logs.ts:30` | Source-backed isSidechain rendered as yes/no. |
| Subagent Spawned-at row (mono) | data-binding | ⬜ deferred | `MetadataInspector.jsx:139` · `phase4.md P4-6` | FLAG: verify a spawn timestamp is recorded; mock '12:04:18' is fixture. |
| Content replacements section (conditional, count badge) | ux-state | ⬜ deferred | `MetadataInspector.jsx:144` · `src/types/logs.ts:54` | Omitted when no replacements; count in MISection header (ContentReplacementRecord). |
| Content-replacement card (bordered box, per item) | subcomponent | ⬜ deferred | `MetadataInspector.jsx:147` · `phase4.md P4-6` | Repeated card grammar over contentReplacements array. |
| Replacement kind pill (amber) | data-binding | ⬜ deferred | `MetadataInspector.jsx:149` · `phase4.md P4-6` | Source-backed r.kind. |
| Replacement toolUseId (mono) | data-binding | ⬜ deferred | `MetadataInspector.jsx:150` · `src/types/logs.ts:320` | Source-backed. |
| Replacement text (italic) | data-binding | ⬜ deferred | `MetadataInspector.jsx:152` · `phase4.md P4-6` | Source-backed r.replacement stub string. |
| File history section (conditional, count = 'N tracked · timestamp') | ux-state | ⬜ deferred | `MetadataInspector.jsx:159` · `src/types/logs.ts:42` | Omitted when no tracked files; count+timestamp in header (FileHistorySnapshot). |
| File-history per-file row | subcomponent | ⬜ deferred | `MetadataInspector.jsx:165` · `src/utils/fileHistory.ts` | Repeated over Object.keys(trackedFileBackups). |
| File tracked/untracked status dot (green/gray) | data-binding | ⬜ deferred | `MetadataInspector.jsx:166` · `phase4.md P4-6` | Source-backed dot: tracked = backupFileName != null. |
| File path row (mono, ellipsis) | data-binding | ⬜ deferred | `MetadataInspector.jsx:167` · `phase4.md P4-6` | Source-backed backup-map key. |
| File version label ('vN' or 'untracked') | data-binding | ⬜ deferred | `MetadataInspector.jsx:168` · `src/utils/fileHistory.ts` | Source-backed version/backupFileName; 'untracked' when null. |
| Context collapse / Compaction section (conditional on mm.compact) | ux-state | ⬜ deferred | `MetadataInspector.jsx:176` · `src/services/compact/compact.ts` | Omitted when no compaction boundary precedes the message. |
| Compaction Trigger pill (purple) | data-binding | ⬜ deferred | `MetadataInspector.jsx:178` · `phase4.md P4-6` | Source-backed compact.trigger (auto\|manual). |
| Compaction Messages-summarized row (mono) | data-binding | ⬜ deferred | `MetadataInspector.jsx:179` · `phase4.md P4-6` | Source-backed messagesSummarized. |
| Compaction Tokens-at-boundary row (mono, 'Xk') | data-binding | ⬜ deferred | `MetadataInspector.jsx:180` · `phase4.md P4-6` | Source-backed preTokens; ÷1000 formatting. |
| Compaction Preserved-segment row (mono, head → tail, conditional) | data-binding | ⬜ deferred | `MetadataInspector.jsx:181` · `phase4.md P4-6` | FLAG: verify preservedSegment head/tail uuids on the real boundary; adapt if only anchor stored. |
| Drawer invocation / entry-point (opened from a transcript message) | interaction | ⬜ deferred | `MetadataInspector.jsx:52` · `app/renderer/src/TranscriptView.tsx` | P4-6 must add the trigger (transcript-row action / SessionActionsMenu) passing real log entry + session descriptor. |

### 19. AgentsPage.jsx — read-only agent-DEFINITION config manager (the GUI face of `/agents`, grouped by settings-source precedence)

**Migration target:** `app/renderer/src/AgentsPage.tsx` + `app/renderer/src/agentConfigState.ts` + `app/sidecar/agentConfigDomain.ts` (frame `agent-config.snapshot`), embedded at `SettingsShell.tsx:242` · **Overall:** 🔁 adapted · **Prototype:** `~/catcode_prototype/cat-app/AgentsPage.jsx` (324 lines) · **INVENTORY:** W4 AgentsPage adapt (S5)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Standalone page scroll container (padding, pb) | chrome/layout | ✅ built | `app/renderer/src/AgentsPage.tsx:154` | Tailwind classes not inline style; prototype `no-scrollbar` scrollbar-hide dropped |
| Centered content column (max-w 820) | chrome/layout | ✅ built | `AgentsPage.tsx:155` | `mx-auto max-w-[820px]` |
| Embedded vs standalone mode split | state/mode | ✅ built | `AgentsPage.tsx:152` + `SettingsShell.tsx:242` | Mounted embedded under Settings → Agents; standalone path also present |
| Header row (title block left / control right, space-between) | chrome | ✅ built | `AgentsPage.tsx:83` | `flex items-start justify-between` |
| Standalone h1 'Agents' | chrome | ✅ built | `AgentsPage.tsx:90` | Standalone-only, embedded hides it |
| Definition-count subtitle 'N agent definition(s)' | data-binding | ✅ built | `AgentsPage.tsx:93` · `agentConfigState.ts:76` | Real count from snapshot; adapted — appends `· N active` |
| Explainer paragraph (`.cat-code/agents/*.md`, running agents elsewhere) | chrome/copy | ✅ built | `AgentsPage.tsx:104` | Adapted copy: points to Orchestrator + Tasks, not just Tasks |
| Empty state 'No agent definitions' | state/empty | ✅ built | `AgentsPage.tsx:133,171` | Definitions-array-empty branch |
| Loading/waiting state (null snapshot before frame) | state/loading | ➕ real-added | `AgentsPage.tsx:131` | Not in prototype; 'Waiting for the engine's agent config snapshot' |
| Group-by-source ordering (precedence high→low) | data-binding/derivation | ✅ built | `agentConfigState.ts:51,66` · sidecar rank `agentConfigDomain.ts:160` | Real `AGENT_CONFIG_SOURCE_ORDER` matches prototype `AG_GROUP_ORDER` |
| Source taxonomy — 7 sources (label/origin/color) | chrome/data | ✅ built | `AgentsPage.tsx:20` (`SOURCE_META`) | Real `AgentConfigSourceId` (`protocol.ts:329`); adapted — Policy→'Managed', origin copy differs |
| Group header — shared `SourceBadge` w/ agent meta | chrome/sub-component | ✅ built | `AgentsPage.tsx:195` → `SettingsField.tsx:85` | Reuses P4-3 `SourceBadge` meta escape-hatch as designed |
| Group header — origin sub-label + divider + per-group count | chrome | ✅ built | `AgentsPage.tsx:196-198` | |
| Agent row container + hover styling | control/chrome | ✅ built | `AgentsPage.tsx:217` | Adapted — `<button>` (a11y) not `<div>`; hover via CSS not JS state |
| Row hover state | state/hover | 🔁 adapted | `AgentsPage.tsx:221` | CSS `hover:` classes replace prototype's `hoveredId` JS tracking |
| Row click → open inspect drawer | interaction | ✅ built | `AgentsPage.tsx:224` | `onSelect` → `setSelectedId` |
| Row dimming when shadowed/unavailable | state/disabled | 🔁 adapted | `AgentsPage.tsx:220` | Keyed on real `available` (active && mcp-ok); prototype keyed on `overridden\|\|mcpMissing` |
| Color dot — 8 named colors + neutral fallback | chrome | ✅ built | `AgentsPage.tsx:58,461` (`AGENT_DOT_CLASS`/`dotClass`) | Real `color` field; 8-color palette preserved |
| agentType name — mono, ellipsis | data-binding | ✅ built | `AgentsPage.tsx:233` | Real `agentType` |
| Read-only lock icon | chrome/state | 🔁 adapted | `AgentsPage.tsx:236` | Keyed on `editable:false` — ALL P4-7 defs are read-only, not just built-in/policy |
| 'overridden' badge | chrome/state | ✅ built | `AgentsPage.tsx:244` · `resolveAgentOverrides` `src/tools/AgentTool/agentDisplay.ts:46,66` | Real `overriddenBy`; prototype's hover tooltip dropped |
| 'mcp missing' badge (yellow) | chrome/state | ✅ built | `AgentsPage.tsx:245` · `hasRequiredMcpServers` `src/tools/AgentTool/loadAgentsDir.ts:229` | Real `missingMcpServers`; tooltip server-list moved into drawer grid |
| whenToUse description line | data-binding | ✅ built | `AgentsPage.tsx:247` | Real `whenToUse` |
| Meta chip — model ('inherit' unset) | data-binding | ✅ built | `AgentsPage.tsx:251` | Adapted — no pink-when-set color, no model glyph |
| Meta chip — tools tri-state (All/No/N tools) | data-binding/derivation | ✅ built | `AgentsPage.tsx:252,455` · `agentConfigDomain.ts:123` | undefined→all, []→none distinction preserved |
| Meta chip — effort | data-binding | ✅ built | `AgentsPage.tsx:253` | Real `effort` |
| Meta chip — permissionMode | data-binding | ✅ built | `AgentsPage.tsx:254` | Real `permissionMode` |
| Meta chip — 'background' | data-binding | ✅ built | `AgentsPage.tsx:255` | Real `background` |
| Meta chip glyphs (model svg + tool svg) | chrome | 🔁 adapted | `AgentsPage.tsx:451` (`Meta`) | Chips built without the prototype's inline icons |
| Inspect drawer — backdrop, click-outside close | control/sub-component | ✅ built | `AgentsPage.tsx:279` | |
| Inspect drawer — right slide-in (min 560/92vw) | chrome/sub-component | ✅ built | `AgentsPage.tsx:285` | `w-[min(560px,92vw)]` |
| Inspect drawer — Escape-key close | shortcut | ✅ built | `AgentsPage.tsx:269-275` | keydown Escape listener |
| Drawer header (dot + agentType + whenToUse + close) | chrome/control | ✅ built | `AgentsPage.tsx:286-307` | 'Close (Esc)' title preserved |
| Drawer 'Configuration' section + label/value grid | chrome/sub-component | ✅ built | `AgentsPage.tsx:310,345` (`DetailGrid`) | |
| Config rows (Source/Plugin/File/Model/Tools/Disallowed/Effort/Permission/Background/Requires MCP) | data-binding | ✅ built | `AgentsPage.tsx:347-388` | All real fields; prototype 'Color' row dropped |
| Extended config rows (Provider/Active/Available/Max turns/Memory/Isolation/Missing MCP/Skills/Initial prompt/Hooks/Agent MCP) | data-binding | ➕ real-added | `AgentsPage.tsx:352-387` · `agentConfigDomain.ts:71-96` | Real-engine fields beyond prototype editor (INVENTORY 'model broader') |
| Drawer 'Allowed tools' chip list (explicit non-empty) | data-binding | ✅ built | `AgentsPage.tsx:314` | Only for `tools.mode==='list'` |
| Drawer 'Disallowed tools' chip section | data-binding | ➕ real-added | `AgentsPage.tsx:320` | Prototype showed disallowed only as a grid row, not a chip section |
| Drawer 'System prompt' section body | data-binding | 🔁 adapted | `AgentsPage.tsx:326` · `agentConfigDomain.ts:92` | Body withheld (secret-boundary) — replaced by notice; §0 flag `STATUS.md:223` |
| Drawer footer — read-only notice | control/state | ✅ built | `AgentsPage.tsx:334` | Adapted — always shown ('Editing intentionally deferred for P4-7') |
| 'active'/'inactive' status pill on row | state/derivation | ➕ real-added | `AgentsPage.tsx:241` · `agentConfigDomain.ts:85` | Not in prototype; derived from real `activeAgents` |
| Header 'Read-only snapshot' badge | chrome | ➕ real-added | `AgentsPage.tsx:99` | Replaces prototype 'New agent' pill |
| Summary cards (Active / Unavailable / Overridden) | chrome/data | ➕ real-added | `AgentsPage.tsx:110,160` · `agentConfigState.ts:76` | Not in prototype |
| 'Scope flags' info box | chrome/copy | ➕ real-added | `AgentsPage.tsx:116` | Documents deferred write actions + withheld fields |
| failedFiles parse-warning banner | state/error | ➕ real-added | `AgentsPage.tsx:125` · `agentConfigDomain.ts:107` | Real `failedFiles` from loader; not in prototype |
| 'New agent' button + create action | control | ✂️ cut | `STATUS.md:223` §0 flag · `AgentsPage.tsx:119` (scope-flags note) | Write action deferred until a safe full-fidelity writer; no owner session |
| Drawer 'Edit definition' button + edit action | control | ✂️ cut | `STATUS.md:223` §0 flag · `AgentsPage.tsx:337` | Editing intentionally deferred; footer shows notice instead |
| Drawer 'Duplicate' button + duplicate action | control | ✂️ cut | `STATUS.md:223` §0 flag | Write action deferred |
| Toast host + '(demo)' action toasts | chrome/feedback | ✂️ cut | `STATUS.md:223` §0 'no toast/demo actions' | Demo-only mechanism; no write actions to signal |

### 20. OrchestratorMode.jsx — orchestrator-mode worker roster/detail/focus + /tasks panel + session-scoped Codex lease roster (user talks only to the orchestrator)

**Migration target:** deferred → `phase4.md P4-8` (8 sub-surfaces, D2-decided); real shapes = `src/agent-mode/AgentModeWorkerRoster.tsx`, `workerUxSummary.ts`, `sessionState.ts`, `BackgroundTasksDialog.tsx`, `BackgroundTaskStatus.tsx`, `teammateViewHelpers.ts`, `codexAccountLeaseManager.ts`, `AgentTool/UI.tsx`; vocab substrate BUILT in `app/renderer/src/agentIdentity.ts` · **Overall:** ⬜ deferred · **Prototype:** `~/catcode_prototype/cat-app/OrchestratorMode.jsx` (903 lines) · **INVENTORY:** W4 Orchestrator roster/detail/focus adapt (S5)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| `W_STATUS` vocab map (running/completed/failed/killed→stopped/blocked→needs-input; color+glyph+pulse) | vocabulary | 🔁 adapted | `app/renderer/src/agentIdentity.ts:124,148,156,164`; `src/agent-mode/sessionState.ts:18-23` | Vocab DATA built (P4-2) in `AGENT_STATE_META`; `killed`→`stopped`, `blocked`→neutral relabels preserved. Rendering deferred → `P4-8`. |
| `W_ROLE` vocab map (coding-worker→"coding worker", verification→"verifier"; color/soft/line) | vocabulary | 🔁 adapted | `app/renderer/src/agentIdentity.ts:72,104,112` | `AGENT_TYPE_META` built (P4-2); real app adds `agent-mode-coding-worker`+`general-purpose`, prototype's 2 roles are a subset. Roster grouping deferred → `P4-8`. |
| `WDot` status indicator (pulse/solid/ring by status) | chrome | ⬜ deferred | `phase4.md P4-8`; adapt over `AgentModeWorkerRoster.tsx:30` | Maps to `agentIdentity.ts` `AgentPipIcon` (pip-fill/ring/pulse); no renderer component built. |
| `WStatusText` (status label + dot; "done" shorthand in list mode) | chrome | ⬜ deferred | `phase4.md P4-8`; `workerUxSummary.ts:72-94` `getWorkerStatusLabel` | Label derivation real in engine; UI text row deferred. |
| `WMeta` line (model · acct N · elapsed · N tools · failover ×N · ↑up ↓down) | data-binding | ⬜ deferred | `phase4.md P4-8`; lease acct via `codexAccountLeaseManager.ts` | MIXED: model/acct/elapsed render only where a real field exists; `up`/`down`/failover-×N from `MOCK_CODEX_LEASES` are CUT fixture (`decisions/AGENT-CHROME.md:76`). |
| `workerCardStats` array (tools/tokens/elapsed/model/acct/resumable/failover/cost) | data-binding | ✂️ cut | `decisions/AGENT-CHROME.md:76` | Mostly MOCK stats; real render only where a field exists (`outputSummary`, result frames, lease snapshot). Card structure owned by `P4-8` via `AgentToolCard`. |
| `WLabel` (uppercase 9.5px section label) | chrome | ⬜ deferred | `phase4.md P4-8` (:537 shell grammar) | Presentational label primitive; extends trued-up shell grammar, no inline style. |
| `WBtn` action button (accent/danger/neutral tones, hover fill) | control | ⬜ deferred | `phase4.md P4-8` (:537) | Used for Stop in WorkerDetail; must extend shell grammar. |
| `OWNER` attention map (none / orchestrator / user→"you" amber baton) | vocabulary | ⬜ deferred | `decisions/AGENT-CHROME.md:61`; `LocalAgentTask.tsx:184,473-530`+`AskOrchestratorTool.ts:83` | Two-axis owner is source-grounded; derive at read time, never store. Deferred → `P4-8`. |
| `deriveWorker()` lifecycle+owner derivation (needsinput/working/result/reviewed/failed/stopped) | derivation | ⬜ deferred | `INVENTORY.md:78` (W4 adapt S5); `decisions/AGENT-CHROME.md:61`; `workerUxSummary.ts:72-94` | Core two-axis derivation over real state; derive owner, never store. |
| `workerStateKey()` → AgentStateLabel/Pip key (blocked→"waiting" neutral) | derivation | ⬜ deferred | `agentIdentity.ts:172` (`waiting` present but UNREACHABLE); `STATUS.md:224` | TWO-STRIKES RIDER: wire `waiting` here (blocked→"waiting") or delete it; named owner `P4-8`, no third silent repeat. |
| `summarizeWorkers()` tally (working/orchestrator/user/done) | derivation | ⬜ deferred | `INVENTORY.md:78`; `decisions/AGENT-CHROME.md:61` | Feeds footer pill + roster counts. |
| `LifeDot` (pulse/ring/solid lifecycle dot) | chrome | ⬜ deferred | `phase4.md P4-8`; maps to `agentIdentity.ts` `AgentPipIcon` | Roster/single-row lifecycle dot. |
| `Baton` owner chip (→orchestrator neutral / →you amber, strong bg for user) | chrome | ⬜ deferred | `decisions/AGENT-CHROME.md:61,67` | Attention-baton chip; amber ONLY for `owner==='user'` (solo case), matching source warning states. |
| `workerEventPriority()` news promotion (user=3/failed=2/result=1/else 0) | derivation | ⬜ deferred | `phase4.md P4-8` | Determines which worker is promoted to the roster one-liner. |
| `CountTail` (neutral count list, strong/color per item) | chrome | ⬜ deferred | `phase4.md P4-8` | Roster count tail. |
| `OrchestratorModeWorkerRoster` — shell container above composer | component | ⬜ deferred | `decisions/AGENT-CHROME.md:60`; `AgentModeWorkerRoster.tsx:30`+`workerUxSummary.ts:96-112` | Compact roster block above PromptInput; reads persisted agent-mode state (C5). |
| Roster empty state (renders null when no workers) | ux-state | ⬜ deferred | `phase4.md P4-8` | Empty/hidden state. |
| Roster single-worker row (role dot, handle, task ellipsis, elapsed, life chip, baton) | ux-state | ⬜ deferred | `phase4.md P4-8` | Distinct quiet "one worker" layout (named, smaller than multi). |
| Roster compact mode (dimmer header while orchestrator generating) | ux-state | ⬜ deferred | `phase4.md P4-8` | `compact=true` while orchestrator streams. |
| Roster multi-worker resting line (pulse/idle dot, "N subagents", neutral counts, "idle") | ux-state | ⬜ deferred | `phase4.md P4-8` | At-rest state names nobody — neutral counts only. |
| Roster promoted-lead line (news-bearing worker: LifeDot, handle, label, count tail, baton) | ux-state | ⬜ deferred | `phase4.md P4-8` | On event, promotes the news worker (amber label for prio===3). |
| Roster hover popover ("N SUBAGENTS" header + full worker rows) | ux-state | ⬜ deferred | `phase4.md P4-8` | Hover reveals full roster above the line. |
| Roster chevron affordance (›) + `onOpen` click (opens /tasks; promoted handle opens its thread) | control | ⬜ deferred | `phase4.md P4-8` | Row click opens /tasks; promoted-handle click opens that worker's thread. |
| `bgTaskPill()` logic (N needs-you amber / N subagents accent / null when settled) | derivation | ⬜ deferred | `decisions/AGENT-CHROME.md:67`; `BackgroundTaskStatus.tsx:25`+`pillLabel.ts` | Footer pill label; amber ONLY when user owns next action. |
| `BackgroundTaskStatus` footer pill (hover invert, click opens /tasks) | component | ⬜ deferred | `decisions/AGENT-CHROME.md:39,67`; `src/components/tasks/BackgroundTaskStatus.tsx:25` | Real same-named engine component; renderer port deferred → `P4-8`. |
| `OrchestratorBadge` pill (orchestrator icon + "Orchestrator" next to session title) | chrome | ⬜ deferred | `phase4.md P4-8` | Mode indicator pill; agent-mode-active is real session state. |
| `TasksButton` (/tasks top-bar button, active-count + blocked-attn badges) | control | ⬜ deferred | `phase4.md P4-8` (shares `P4-9`) | Top-bar /tasks entry; amber border when blocked; counts from real worker state. |
| `WorkerDetail` body container | component | ⬜ deferred | `decisions/AGENT-CHROME.md:63`; detail dialogs + `describeTeammateActivity` `taskStatusUtils.tsx:79` | Per-worker detail body in /tasks drilldown. |
| `WorkerDetail` Prompt section (task text) | data-binding | ⬜ deferred | `phase4.md P4-8` | Task/prompt is a real worker field (delegated prompt). |
| `WorkerDetail` Activity timeline (running-only, reveal slice, live AgentPip on last) | ux-state | ⬜ deferred | `decisions/AGENT-CHROME.md:76` (C5) | Structure deferred; `w.progress`/`w.reveal` fixture arrays CUT — activity derives from nested seam frames (C4). |
| `WorkerDetail` blocked "Waiting on orchestrator" note (◉, blockReason, "you don't act here") | ux-state | ⬜ deferred | `LocalAgentTask.tsx:184,473-530`+`AskOrchestratorTool.ts:83` | Blocked state source-grounded (`handoffStatus:'blocked'`). |
| `WorkerDetail` Changed files list (non-verifier, count header) | data-binding | ✂️ cut | `decisions/AGENT-CHROME.md:76` | `w.files` is a MOCK fixture with no real field — CUT; container owned by `P4-8` if a real files source lands. |
| `WorkerDetail` Stop button (running-only, danger tone) | control | ⬜ deferred | `phase4.md P4-8`; `sessionState.ts:18-23` (`killed`) | Stop/kill a running worker; real action. |
| `WorkerFocusView` container (main column swaps to worker thread; 720px) | component | ⬜ deferred | `decisions/AGENT-CHROME.md:64`; `teammateViewHelpers.ts:46,88` | Teammate/focus view; viewing is real, claim-reduced. |
| `WorkerFocusView` context banner ("messages you send go to @handle, not main chat") | chrome | 🔁 adapted | `decisions/AGENT-CHROME.md:64`; `resumeAgent.ts` | CLAIM REDUCED (D2): gate composer per task type; resume only for terminal resumable workers. Don't promise universally. |
| `WorkerFocusView` "Task from orchestrator" card | data-binding | ⬜ deferred | `phase4.md P4-8` | Task is a real worker field. |
| `WorkerFocusView` activity timeline (role-colored rail, live AgentPip) | ux-state | ⬜ deferred | `decisions/AGENT-CHROME.md:76` | Structure deferred; `w.progress` fixture CUT (derive from frames). |
| `WorkerFocusView` blocked/waiting card | ux-state | ⬜ deferred | `LocalAgentTask.tsx:184,473-530` | Reuses two-axis blocked treatment in focus view. |
| `WorkerFocusView` Result/Verdict card (verification→Verdict, else Result) | ux-state | ⬜ deferred | `decisions/AGENT-CHROME.md:76` (`outputSummary` real) | Renders from real `outputSummary`/result frame; verdict for verification role. |
| `WorkerFocusView` Changed files (non-verifier) | data-binding | ✂️ cut | `decisions/AGENT-CHROME.md:76` | `w.files` MOCK fixture, CUT (same as WorkerDetail). Container owned by `P4-8` if a real source lands. |
| `AgentToolCard` (inline transcript agent-tool card wrapping AgentTranscriptCard) | component | ⬜ deferred | `decisions/AGENT-CHROME.md:65`; `AgentTool/UI.tsx:458,319,513` | KEPT (not cut) — inline agent cards are the real idiom; status DERIVED (C4), never stored; nesting via `selectNestedTranscriptRows` (P2-2, built). Render deferred. |
| `DelegateGroup` (stack of parallel inline Agent cards) | component | ⬜ deferred | `decisions/AGENT-CHROME.md:66`; `renderGroupedAgentToolUse` `UI.tsx:740` | KEPT; parallel-agent grouping; subagent frames NEST, never interleave (`phase4.md` :521). |
| Inline-card status derivation (`workerCardStateKey` blocked/running/completed/failed/stopped) | derivation | ⬜ deferred | `decisions/AGENT-CHROME.md:65` (C4) | Feeds `AgentToolCard` state; derived at read time via P2-2 machinery, never stored. |
| `TasksPanel` container (/tasks right drawer, 460px) | component | ⬜ deferred | `decisions/AGENT-CHROME.md:62`; `BackgroundTasksDialog.tsx:131`; shares `P4-9` (`phase4.md` :571) | On-demand /tasks drawer; `INVENTORY.md:79` flags TasksPanel as unanchored GUI over BgTasksDialog data. |
| `TasksPanel` header (/tasks label · "Background tasks" · count · close ×) | chrome | ⬜ deferred | `phase4.md P4-8`/`P4-9` | — |
| `TasksPanel` Workers\|Leases tab switcher (counts, teal underline for Leases) | control | ⬜ deferred | `phase4.md P4-8`/`P4-9` | Two-tab switcher; hidden during worker-detail drilldown. |
| `TasksPanel` worker-list counts strip (N working / N on orchestrator / N done / empty) | ux-state | ⬜ deferred | `phase4.md P4-8`/`P4-9` | Includes empty "No workers yet. They appear as the orchestrator delegates." |
| `TasksPanel` role-grouped worker list (coding-worker/verification order, unknown roles kept) | ux-state | ⬜ deferred | `phase4.md P4-8`/`P4-9` | `roleOrder` known-first then any; must not drop unknown agent types. |
| `TasksPanel` worker row (dot, handle, task ellipsis, WStatusText; click selects) | control | ⬜ deferred | `phase4.md P4-8`/`P4-9` | — |
| `TasksPanel` worker-detail drilldown (back "All workers", AgentHandle/TypeChip/StateLabel, "Open thread") | ux-state | ⬜ deferred | `phase4.md P4-8`; Open-thread → `teammateViewHelpers.ts:46` | Drilldown detail; primitives' vocab in `agentIdentity.ts`, components unbuilt. |
| `TasksPanel` footer hint line (contextual: leases / stop-a-worker / click-to-inspect) | chrome | ⬜ deferred | `phase4.md P4-8`/`P4-9` | — |
| `LEASE_STATE` vocab (active/released/failed color+label) | vocabulary | ⬜ deferred | `decisions/AGENT-CHROME.md:62`; `codexAccountLeaseManager.ts:163,194` | Real snapshot via `getCodexLeaseSnapshot`; session-scoped, read-only. |
| `leaseAccountRollup()` — per-account holders derivation (proof of non-exclusivity) | derivation | ⬜ deferred | `decisions/AGENT-CHROME.md:62`; `codexAccountLeaseManager.ts:163` | Derives accountId→holders rollup; real snapshot may expose `accounts[]`. |
| `LeaseRow` (owner label, main/subagent badge, failover badge, account, strategy·state·held, selectionReason) | component | ⬜ deferred | `decisions/AGENT-CHROME.md:62`; `codexAccountLeaseManager.ts:163,194` | Real fields render from snapshot; `MOCK_CODEX_LEASES` fixture CUT. |
| `LeaseRoster` (strategy note, accounts-in-use rollup, owners main+subs, empty, failover&rotation strip) | component | ⬜ deferred | `decisions/AGENT-CHROME.md:62`; `codexAccountLeaseManager.ts:163,194` | Session-panel placement (not global Accounts page) is source-correct per D2. |
| `LeaseRoster` empty state ("No active leases. Agents lease an account when they run.") | ux-state | ⬜ deferred | `phase4.md P4-8` | — |
| `AgentTranscriptCard` external primitive (`window.AgentTranscriptCard`) | component | ⬜ deferred | `phase4.md P4-8`; `AgentTool/UI.tsx:458` family | Shared inline agent-card renderer AgentToolCard delegates to; vocab in `agentIdentity.ts`, React card unbuilt. |
| `AgentPip` external primitive (`window.AgentPip` — running spinner in timelines) | chrome | ⬜ deferred | `agentIdentity.ts:10` (`AgentPipIcon` vocab), no React `AgentPip` built | Pip data type built (P4-2); component deferred. |
| `AgentHandle` / `AgentTypeChip` / `AgentStateLabel` external primitives | component | ⬜ deferred | `agentIdentity.ts` `AGENT_TYPE_META`/`AGENT_STATE_META` (vocab only, no chips built) | Vocab DATA built (P4-2); React chip components deferred → `P4-8` (or shared `P4-1` `Chip.tsx`). |
| `w.progress` fixture arrays (activity timelines) | fixture | ✂️ cut | `decisions/AGENT-CHROME.md:76` | MOCK feed CUT (correct drop); real activity derives from nested seam frames (C4) + progress re-emits. |
| `w.up` / `w.down` token counters | fixture | ✂️ cut | `decisions/AGENT-CHROME.md:76` | MOCK feed CUT; no real per-worker token counter. |
| `w.cost` fixture field | fixture | ✂️ cut | `decisions/AGENT-CHROME.md:76` | MOCK feed CUT ("source wins" — no real per-worker cost field). |
| `w.account` mock lease label (acct N) | fixture | ✂️ cut | `decisions/AGENT-CHROME.md:76`; `codexAccountLeaseManager.ts` | MOCK string CUT; real account label comes from lease snapshot in Leases tab. |
| `MOCK_CODEX_LEASES` window global (lease/failover fixture feed) | fixture | ✂️ cut | `decisions/AGENT-CHROME.md:76`; `codexAccountLeaseManager.ts:163` | Fixture global CUT; replaced by real read-only session lease snapshot; failover-×N reads only from real snapshot. |
| `OrchestratorDemoSwitch` (A/B/C demo control, keyboard 1/2/3, collapsed dot-pill) | demo | ✂️ cut | `INVENTORY.md:109` CUT table; `decisions/AGENT-CHROME.md:77`; header L814 "DEMO-ONLY: delete on migration" | Pure prototype scaffold; no upstream demo-state concept. `phase4.md` :525 tells P4-8 to IGNORE it. |
| `ODEMO_STATES` demo state list (delegating/working/inspecting) | demo | ✂️ cut | `INVENTORY.md:109`; `decisions/AGENT-CHROME.md:77` | Demo scaffolding data; CUT with OrchestratorDemoSwitch. |
| `OrchestratorDemoSwitch` keyboard shortcuts (1/2/3 → A/B/C, guarded when typing) | shortcut | ✂️ cut | `INVENTORY.md:109`; `decisions/AGENT-CHROME.md:77` | Demo-only keybindings; CUT. |

### 21. TasksPage.jsx — background-task manager modal (BgTasksDialog): active/completed list, per-type rows, scope toggle, keyboard select/open/stop

**Migration target:** deferred → P4-9 (`app/renderer/src` BgTasksDialog+TasksPanel, not yet built; adapt from `src/components/tasks/BackgroundTasksDialog.tsx`) · **Overall:** ⬜ deferred · **Prototype:** `~/catcode_prototype/cat-app/TasksPage.jsx` (242 lines) · **INVENTORY:** W4 Tasks BgTasksDialog/TasksPanel adapt (S5)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Overlay backdrop (inset:0, blur, click-to-close, z-50) | chrome / UX-state | ⬜ deferred | `phase4.md:551` P4-9 | Not built; real dialog is Ink overlay, P4-9 adapts to Electron modal. |
| Dialog panel container (640px, maxHeight 74vh, rounded, toast-in anim) | chrome | ⬜ deferred | `phase4.md:551` P4-9 | Fixed 640px is a prototype visual choice; adapt sizing to real content. |
| Header block (flex row, bottom border) | chrome | ⬜ deferred | `phase4.md:551` P4-9 | Not built. |
| Header title "Tasks" | chrome | ⬜ deferred | `phase4.md:551` P4-9 | Real title from `BackgroundTasksDialog.tsx` header. |
| Header subtitle count "{active} active · {done} completed" | data-binding | ⬜ deferred | `src/tasks.ts:22` `getAllTasks` | Bind to real active/terminal partition (`src/Task.ts:27` `isTerminalTaskStatus`). |
| Scope toggle segmented (This session / All sessions) | control | ⬜ deferred | `phase4.md:551` P4-9 | FLAG: real dialog has NO session-scope toggle; "all"=one-instance roster — P4-9 confirms reachability in N-process app or cuts. |
| "This session" toggle + disabled when no activeSessionId | control / UX-state | ⬜ deferred | `phase4.md:551` P4-9 | Disabled styling (`#3f3f46`, default cursor) when no active session. |
| "All sessions" toggle + active pink styling | control | ⬜ deferred | `phase4.md:551` P4-9 | Active pink accent `rgba(244,114,182,.12)`/`#f9a8d4`. |
| Close button (×, title "Close (Esc)", hover bg/color) | control | ⬜ deferred | `phase4.md:551` P4-9 | Esc also closes (keyboard row). |
| Body scroll area (no-scrollbar, overflowY auto) | chrome | ⬜ deferred | `phase4.md:551` P4-9 | Not built. |
| Empty state — scope-dependent title | UX-state | ⬜ deferred | `TasksPage.jsx:211` | "No tasks in this session" / "No background tasks"; branches on scope. |
| Empty state — subtitle "Run a background bash, agent, or dream…" | UX-state | ⬜ deferred | `TasksPage.jsx:213` | Not built. |
| Active/Completed two-section grouping | chrome / data-binding | ⬜ deferred | `phase4.md:551` P4-9 | FLAG: real dialog groups by TASK TYPE (`BackgroundTasksDialog.tsx`), not Active/Completed — P4-9 records the divergence. |
| Group component — header label | chrome | ⬜ deferred | `TasksPage.jsx:167` | Uppercase section label; hidden when empty. |
| Group component — divider line + item count | chrome | ⬜ deferred | `TasksPage.jsx:168` | Trailing count of items in group. |
| Row — selection highlight (click/hover) | UX-state | ⬜ deferred | `TasksPage.jsx:143` | Selected index drives bg `rgba(255,255,255,.04)`. |
| Row — terminal-task opacity dimming (0.72) | UX-state | ⬜ deferred | `src/Task.ts:27` isTerminal | Done/stopped/failed rows dimmed. |
| Row status marker — spinner ring (working, no phase) | UX-state | ⬜ deferred | `src/Task.ts:15` running/pending | Neutral spinning ring; no green (deliberate quiet design). |
| Row status marker — amber dot (needs input / phase set) | UX-state | ⬜ deferred | `TasksPage.jsx:128` | phase is agent-enrichment (not on `TaskStateBase`) — P4-9 sources real teammate/agent state or drops. |
| Row status marker — red dot (failed) | UX-state | ⬜ deferred | `src/Task.ts:15` failed | Not built. |
| Row status marker — grey dot (done/stopped) | UX-state | ⬜ deferred | `src/Task.ts:15` completed/killed | "Stopped" label === killed status. |
| Row — kind badge (label + per-type accent + border) | chrome / data-binding | ⬜ deferred | `src/Task.ts:6` TaskType | TP_KINDS 7 types match real TaskType; oklch accents are visual tokens — reuse P4-2 AgentIdentity vocabulary. |
| Row — "gated" badge (dashed, tooltip "Feature-gated: {gate}") | chrome | ⬜ deferred | `phase4.md:551` P4-9 | FLAG: gate labels are a prototype concept; `getAllTasks()` doesn't gate by type — map to real feature-gate or drop. |
| Row — title/description text (mono for bash/workflow/monitor) | data-binding | 🔁 adapted | `src/Task.ts:49` description | ADAPT/FLAG: prototype uses `t.title\|\|t.description`; real tasks only have `description` (no title field). Command kinds render mono. |
| Row — tail text (phase > lastActivity > tool·token counts) | data-binding | 🔁 adapted | `src/Task.ts:43-56` (no progress) | ADAPT/FLAG: mock progress-enrichment fields; P4-9 sources real per-type progress (`renderToolActivity.tsx`) or drops the tail. |
| Footer keyboard-hints strip (↑↓ select · ↵ open · K stop · esc close) | chrome | ⬜ deferred | `TasksPage.jsx:224` | Mono hint bar mirroring keyboard handlers. |
| Keyboard: Escape → close | shortcut | ⬜ deferred | `TasksPage.jsx:105` | Not built. |
| Keyboard: ArrowDown/ArrowUp → move selection (clamped) | shortcut | ⬜ deferred | `TasksPage.jsx:106` | Selection order is running-first flat list. |
| Keyboard: Enter → open/inspect selected | shortcut | ⬜ deferred | `TasksPage.jsx:108` | Prototype toasts "demo"; real action opens per-type detail view. |
| Keyboard: K → stop selected (non-terminal only) | shortcut | ⬜ deferred | `src/Task.ts:71`-style kill | Guarded to non-terminal; real kill via `Task.kill`. |
| Interaction: row click → inspect; mouseEnter → select | control | ⬜ deferred | `TasksPage.jsx:141` | Hover-to-select mirrors keyboard selection. |
| Toast on stop/inspect (auto-dismiss 2s) | UX-state | 🔁 adapted | `TasksPage.jsx:94` demo copy | ADAPT: demo toast strings are placeholders; real inspect opens detail dialog, stop invokes kill. Reuse P4-1 ToastHost. |
| Running-first sort / flat selection order | data-binding | ⬜ deferred | `BackgroundTasksDialog.tsx` (running-first then newest) | Real dialog sorts running-first then newest — P4-9 reuses. |
| tpElapsed helper (end/now − start − totalPausedMs) | data-binding | ⬜ deferred | `src/Task.ts:51-53` startTime/endTime/totalPausedMs | Grounded — real fields present; defined but not rendered in this prototype. |
| tpTokens helper (token count → "1.2k") | data-binding | 🔁 adapted | `src/Task.ts:43-56` (no tokenCount) | ADAPT/FLAG: formats a mock enrichment field; keep formatter, source real tokens or drop. |
| TP_IC icon set (clock/tool/token/stop/inspect SVGs) | chrome | ⬜ deferred | `TasksPage.jsx:56` | Defined but largely unused in THIS render (rows use dots+text); P4-9 decides real icon set. |
| sessTitle lookup (session id → title) | data-binding | ✂️ cut | `TasksPage.jsx:79` (dead helper) | Never rendered in component; session-title display belongs to Sidebar/Sessions, not this dialog. |
| window.MOCK_TASKS fixture feed | data-binding | ✂️ cut | `INVENTORY.md:79` S5 (source-wins) | Mock roster is not a parity target; P4-9 wires real `getAllTasks()` (`src/tasks.ts:22`). |
| window.MOCK_TASKS_NOW fixture (frozen clock) | data-binding | ✂️ cut | `INVENTORY.md:79` S5 | Scripted timer not a parity target; real app uses live `Date.now()`. |
| TP_PHASE map (needs_input / plan_ready / awaiting_plan_approval) | data-binding | ⬜ deferred | `src/Task.ts:43-56` (phase not on base) | P4-9 sources phase from real teammate/agent state (P4-8 read-seam) or drops needs-input marker. |
| Per-type detail dialogs (Shell/Dream/Teammate/RemoteSession/AsyncAgent) | sub-component | ➕ real-added | `src/components/tasks/ShellDetailDialog.tsx` +4 siblings | Real capability the prototype lacks (it only toasts "inspect demo"); P4-9 preserves detail views. |
| List/detail view modes + auto-skip-to-detail for 1 task | UX-state | ➕ real-added | `src/components/tasks/BackgroundTasksDialog.tsx` | Prototype has no detail mode; P4-9 preserves real two-mode navigation. |
| ctrl+x ctrl+k kill-agents shortcut | shortcut | ➕ real-added | `src/components/tasks/BackgroundTasksDialog.tsx` (killAgents) | Real bulk-kill affordance absent from prototype; P4-9 carries over. |
| Foregrounded-task exclusion from background list | data-binding | ➕ real-added | `src/components/tasks/BackgroundTasksDialog.tsx` (foregroundedTaskId) | Real correctness rule; prototype's mock roster has no such concept. |

### 22. GoalsPage.jsx — cross-session goal roster, shipped as a read-only per-thread goal snapshot panel

**Migration target:** `app/renderer/src/GoalsPage.tsx` + `goalMemoryState.ts` + `app/sidecar/goalDomain.ts` (P4-10, live-wired at `App.tsx:896`) · **Overall:** 🔁 adapted · **Prototype:** `~/catcode_prototype/cat-app/GoalsPage.jsx` (324 lines) · **INVENTORY:** W4 GoalsPage + GoalDetail + dialogs adapt (S8)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Page container + independent scroll region | layout-chrome | ✅ built | `app/renderer/src/GoalsPage.tsx:11` | `flex min-h-0 flex-1 overflow-auto`; padding adapted to `px-8 py-7`. |
| Centered max-width content column | layout-chrome | ✅ built | `app/renderer/src/GoalsPage.tsx:12` | `mx-auto max-w-[760px]` (proto was 720). |
| Header row (space-between title vs actions) | layout-chrome | ✅ built | `app/renderer/src/GoalsPage.tsx:13` | `flex items-start justify-between`. |
| Page title 'Goals' (h1) | chrome-text | ✅ built | `app/renderer/src/GoalsPage.tsx:15-17` | Static header label. |
| Subtitle 'One goal per session … N ongoing · N complete' | chrome-text | 🔁 adapted | `app/renderer/src/GoalsPage.tsx:18-20` | Single-goal copy 'Current thread goal from the live engine session'; no roster counts (W4). |
| '+ Create goal' primary button (header) | control | ⬜ deferred | `STATUS.md P4-10 §0` | Writer verbs deferred to a safe writer boundary; card notice cites it (`GoalsPage.tsx:34-38`). |
| Empty-state card (dashed border, centered) | ux-state-empty | ✅ built | `app/renderer/src/GoalsPage.tsx:44-56` | `EmptyGoal`, dashed border, centered. |
| Empty-state goal icon (2x scale, pink) | chrome-icon | 🔁 adapted | `app/renderer/src/GoalsPage.tsx:44-56` | Empty state redesigned without the decorative icon (whole component adapted, not a silent drop). |
| Empty-state heading | ux-state-empty | 🔁 adapted | `app/renderer/src/GoalsPage.tsx:47-49` | 'No active thread goal' (proto 'No goals yet'). |
| Empty-state explanatory copy | ux-state-empty | 🔁 adapted | `app/renderer/src/GoalsPage.tsx:50-53` | Source-accurate 'engine creates one through its real goal machinery'. |
| Empty-state '+ Create goal' button (in-card) | control | ⬜ deferred | `STATUS.md P4-10 §0` | Writer boundary; not built. |
| Ongoing/Complete split (terminal partition) | data-binding | 🔁 adapted | `INVENTORY.md:80 (W4)` | No roster → single-goal panel, no partition. |
| Section band component (label + count) | chrome-structure | 🔁 adapted | `INVENTORY.md:80 (W4)` | No roster → no status sections. |
| Cross-session roster aggregation (many→one list) | architecture-divergence | 🔁 adapted | `app/sidecar/goalDomain.ts:27` · `goalMemoryState.ts:49` | W4 adapt: real = per-thread `threadGoal` snapshot keyed by `SessionId`, not a roster. |
| Per-workspace grouping (alpha groups) | data-binding | 🔁 adapted | `INVENTORY.md:80 (W4)` | No roster → no workspace grouping (workspace was joined via mock `sessionId`). |
| Workspace group header (name + divider + count) | chrome-structure | 🔁 adapted | `INVENTORY.md:80 (W4)` | Subsumed by single-goal panel. |
| Goal row container (clickable card) | control | 🔁 adapted | `app/renderer/src/GoalsPage.tsx:58-86` | `GoalCard` is a static read-only card, not a clickable list row. |
| Row hover state (bg/border lift + reveal 'open') | ux-state-hover | 🔁 adapted | `app/renderer/src/GoalsPage.tsx:58` | Static card; not a nav target, no hover affordance. |
| Terminal-goal dimming (opacity 0.8) | ux-state-styling | 🔁 adapted | `app/renderer/src/GoalsPage.tsx:58` | Single card, no list-item dimming. |
| Status marker — spinning ring (active) | ux-state-styling | 🔁 adapted | `app/renderer/src/GoalsPage.tsx:99-115` | Status rendered as `StatusBadge` pill, not a spinner dot. |
| Status marker — solid dot (paused/limited/complete) | ux-state-styling | 🔁 adapted | `app/renderer/src/GoalsPage.tsx:99-115` | Folded into `StatusBadge`. |
| Status label pill (uppercase, per-status color) | chrome-badge | ✅ built | `app/renderer/src/GoalsPage.tsx:99-115` | `StatusBadge` uppercase + per-status tone tokens. |
| status active — 'Active', pink | data-binding | 🔁 adapted | `app/renderer/src/GoalsPage.tsx:102-103` | Real label 'active', `tone-good` (not pink); enum source-accurate (`protocol.ts:404`). |
| status paused — 'Paused', amber | data-binding | 🔁 adapted | `app/renderer/src/GoalsPage.tsx:108` | Fallback `text-subtle` tone; label 'paused'. |
| status budget_limited — 'Limited by budget', red | data-binding | 🔁 adapted | `app/renderer/src/GoalsPage.tsx:100,106` | Badge shows 'budget limited', `tone-warn` (STATUS_LABELS `threadGoal.ts:77` = 'limited by budget'). |
| status complete — 'Complete', gray, terminal | data-binding | 🔁 adapted | `app/renderer/src/GoalsPage.tsx:104-105` | Label 'complete', `accent` tone. |
| Session title label on row | data-binding | 🔁 adapted | `app/renderer/src/App.tsx:897-900` · `GoalsPage.tsx:21-25` | Header shows session cwd/`SessionId` label, not a per-row title join (mock `sessionId` bridge cut). |
| Objective text (2-line clamp) | data-binding | ✅ built | `app/renderer/src/GoalsPage.tsx:68-70` | Real `objective`; shown full (no 2-line clamp). |
| Token usage text | data-binding | ✅ built | `app/renderer/src/GoalsPage.tsx:73` | Metric tile 'Tokens used' from real `tokensUsed`. |
| Token budget | data-binding | ✅ built | `app/renderer/src/GoalsPage.tsx:74-77` | Metric tile; 'unbounded' when `tokenBudget` undefined. |
| Elapsed time text | data-binding | ✅ built | `app/renderer/src/GoalsPage.tsx:78` | Metric 'Time used' from real `timeUsedSeconds` (proto mock string dropped, source wins). |
| Row action button row (contextual) | control-group | ⬜ deferred | `STATUS.md P4-10 §0` | All write verbs deferred to writer boundary. |
| Action: Resume (paused) | control | ⬜ deferred | `STATUS.md P4-10 §0` | Real `/goal resume` (`src/utils/threadGoal.ts`). |
| Action: Pause (active) | control | ⬜ deferred | `STATUS.md P4-10 §0` | Real `/goal pause`. |
| Action: Replace (non-terminal) | control | ⬜ deferred | `STATUS.md P4-10 §0` | Real replace = destroy+recreate (`src/utils/threadGoalActions.ts`). |
| Action: Clear (danger, non-terminal) | control | ⬜ deferred | `STATUS.md P4-10 §0` | Real `/goal clear` (`clearThreadGoal`). |
| No user 'Complete' action (agent-only) | ux-state-omission | ✅ built | `app/renderer/src/GoalsPage.tsx:58-86` | Card exposes no complete control — omission correctly preserved. |
| ActBtn hover styling (danger variant) | ux-state-hover | ⬜ deferred | `STATUS.md P4-10 §0` | Part of deferred action buttons. |
| 'open ›' hover-revealed affordance | chrome-affordance | 🔁 adapted | `app/renderer/src/GoalsPage.tsx:58` | No row-open nav; panel is already the active session. |
| Row click → open owning session | navigation | 🔁 adapted | `app/renderer/src/App.tsx:895-903` | Panel scoped to `activeSessionId`; no per-row session navigation. |
| CreateGoalDialog — modal overlay | control-modal | ⬜ deferred | `STATUS.md P4-10 §0` | Writer boundary; also lives in Surfaces.jsx. |
| CreateGoalDialog — header (icon + title) | chrome-text | ⬜ deferred | `STATUS.md P4-10 §0` | Not built. |
| CreateGoalDialog — Objective textarea | input | ⬜ deferred | `STATUS.md P4-10 §0` | Real validation ≤4000 (`threadGoal.ts:84`). |
| CreateGoalDialog — Token budget input (default 500000) | input | ⬜ deferred | `STATUS.md P4-10 §0` | Writer boundary; mock default is not a target. |
| CreateGoalDialog — Cancel button (Esc) | control | ⬜ deferred | `STATUS.md P4-10 §0` | Not built. |
| CreateGoalDialog — Create button (disabled-when-empty, ⌘↵) | control | ⬜ deferred | `STATUS.md P4-10 §0` | Not built. |
| CreateGoalDialog — keyboard Esc = cancel | keyboard | ⬜ deferred | `STATUS.md P4-10 §0` | Not built. |
| CreateGoalDialog — keyboard ⌘/Ctrl+Enter = submit | keyboard | ⬜ deferred | `STATUS.md P4-10 §0` | Not built. |
| CreateGoalDialog — submit feedback (toast) | ux-state-feedback | ⬜ deferred | `STATUS.md P4-10 §0` | Mock toast; real = `createThreadGoalAction`. |
| ReplaceGoalDialog — modal overlay | control-modal | ⬜ deferred | `STATUS.md P4-10 §0` | Not built. |
| ReplaceGoalDialog — header + session title | chrome-text | ⬜ deferred | `STATUS.md P4-10 §0` | Not built. |
| ReplaceGoalDialog — 'creates a new goal' notice | chrome-text | ⬜ deferred | `STATUS.md P4-10 §0` | Source-accurate replace semantics. |
| ReplaceGoalDialog — New objective textarea (prefilled) | input | ⬜ deferred | `STATUS.md P4-10 §0` | Not built. |
| ReplaceGoalDialog — Token budget input (prefilled) | input | ⬜ deferred | `STATUS.md P4-10 §0` | Not built. |
| ReplaceGoalDialog — Cancel + Replace buttons | control | ⬜ deferred | `STATUS.md P4-10 §0` | Not built. |
| ReplaceGoalDialog — keyboard (Esc / ⌘↵) | keyboard | ⬜ deferred | `STATUS.md P4-10 §0` | Not built. |
| ReplaceGoalDialog — submit feedback (toast) | ux-state-feedback | ⬜ deferred | `STATUS.md P4-10 §0` | Mock toast; real replace path. |
| 'spin' + 'toast-in' animations | chrome-animation | ⬜ deferred | `STATUS.md P4-10 §0` | Only the deferred spinner + dialogs consume them. |
| window.MOCK_GOALS data source | mock-fixture | ✂️ cut | `app/sidecar/goalDomain.ts:19` | Source wins: live `threadGoal` snapshot over the engine app-state store. |
| g.sessionId prototype bridge field | mock-fixture | ✂️ cut | `app/sidecar/goalDomain.ts:31` · `goalMemoryState.ts:10` | Real keys on `threadId`; session addressed by `SessionId`. |
| g.timeElapsed mock preformatted string | mock-fixture | ✂️ cut | `app/renderer/src/GoalsPage.tsx:78` | Source wins: real `timeUsedSeconds:number` formatted as `Ns`. |
| Create-dialog default budget 500000 | mock-fixture | ✂️ cut | `GoalsPage.jsx:207` | Mock prefill; real budget optional (empty = unbounded). |
| goalId displayed on card | real-only-capability | ➕ real-added | `app/renderer/src/GoalsPage.tsx:63-65` | Prototype never surfaces the real goalId. |
| Goal summary block (formatThreadGoalSummary) | real-only-capability | ➕ real-added | `app/renderer/src/GoalsPage.tsx:81-83` · `goalDomain.ts:39` | Real completion/budget summary text; no prototype element. |
| 'Read-only snapshot' pill (header) | real-only-capability | ➕ real-added | `app/renderer/src/GoalsPage.tsx:27-29` | Signals no desktop writer boundary. |
| Writer-boundary notice banner | real-only-capability | ➕ real-added | `app/renderer/src/GoalsPage.tsx:34-38` | Explains verbs remain on the engine `/goal` path. |
| remainingTokens (surfaced via summary) | real-only-capability | ➕ real-added | `app/sidecar/goalDomain.ts:39` · `src/utils/threadGoal.ts` | Real budget field folded into the summary; not in the mock. |
| Budget-wrap-up continuation (behind budget_limited) | real-only-capability | ➕ real-added | `src/utils/threadGoal.ts` | Real wrap-up flow behind `budget_limited`; prototype shows only a static pill. |

### 23. MemoryPage.jsx — GUI home for `/memory`: read-only manager over the CLAUDE.md hierarchy + auto/team/agent memory

**Migration target:** `app/renderer/src/MemoryPage.tsx` + `goalMemoryState.ts` + sidecar `memoryDomain.ts` + `MemorySnapshot` frame · **Overall:** 🔁 adapted · **Prototype:** `~/catcode_prototype/cat-app/MemoryPage.jsx` (215 lines) · **INVENTORY:** W4 MemoryPanel adapt (S8)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Whole-surface data source — real `MemorySnapshot` frame replaces prototype `window.MOCK_MEMORY` | data-binding/architecture | ✅ built | `app/shared/protocol.ts:455-469`, `app/sidecar/memoryDomain.ts:67-93` | AUDITOR CORRECTION: analyst marked whole surface ⬜ deferred — WRONG. P4-10 ✅ done (`STATUS.md:226`); live memdir+CLAUDE.md scan, no mock. Wired `sessionController.ts:295`→`sidecarServer.ts:239`→`App.tsx:892`→`SettingsShell.tsx:245`. |
| Aggregated cross-scope manager (GUI reframe of upstream `MemoryFileSelector` picker) | architecture/adapt | ✅ built | `app/renderer/src/MemoryPage.tsx:14-39` | Read-only aggregated manager built as intended; in-app content editing out of scope (upstream $EDITOR picker superseded). |
| Intro paragraph — names `/memory`, "files that shape how Cat Code behaves" | chrome/copy | 🔁 adapted | `MemoryPage.tsx:41-56` | Real `MemoryHeader` = title + subtitle "Real CLAUDE.md instruction files and auto-memory metadata"; `/memory`-command mention dropped (GUI-native). |
| Precedence hierarchy note — "project ▸ local ▸ user ▸ managed" | chrome/copy | 🔁 adapted | `MemoryPage.tsx:120-163`, `goalMemoryState.ts:110-121` | Explicit precedence sentence dropped; conveyed via type-grouped instruction files + per-scope counts. |
| `/init` CTA card — empty-state when no project CLAUDE.md (`hasProjectMd` gate) | ux-state/empty | ⬜ deferred | `STATUS.md:226` §0 (safe writer boundary) | `/init` writes CLAUDE.md → excluded by read-only scope; no empty-state CTA in real build. |
| `/init` CTA title/body copy | chrome/copy | ⬜ deferred | `STATUS.md:226` §0 | Copy inside the deferred CTA. |
| "Run /init" button + toast | control/button | ⬜ deferred | `STATUS.md:226` §0 (writer boundary) | Command-invoking control deferred; real surface has no action controls. |
| `MemSection` subhead — uppercase title + count pill (×4) | sub-component/chrome | ✅ built | `MemoryPage.tsx:73-107,120-163` | Realized as `<section>` headers with title + count (Memory sources / Instruction files / Auto memories). |
| "Instruction files (CLAUDE.md)" section + "N files" count | section | ✅ built | `MemoryPage.tsx:120-163`, `goalMemoryState.ts:65-108` | Real section groups instruction files by type; `counts.total` = "N instruction files" (`MemoryPage.tsx:87-93`). |
| `ClaudeMdRow` — hierarchy row (mono path + badge + meta + open btn) | sub-component/row | 🔁 adapted | `MemoryPage.tsx:139-155` | Rebuilt as a type-grouped card row (path + pills); no per-row open button (read-only), no lines/bytes meta. |
| SourceBadge (scope) per row — reused `window.SourceBadge` | badge/data-binding | 🔁 adapted | `MemoryPage.tsx:133-137`, `protocol.ts:429` | Scope shown as per-type group heading + count grid, not a per-row badge; real types = `MemoryInstructionType`. |
| @-imported children rows — indented, left-border, "imported" tag | sub-component/row | 🔁 adapted | `MemoryPage.tsx:148`, `protocol.ts:442` | Real `parent` field → flat row with "included" vs "direct" pill; no indented-tree nesting. |
| "imported" uppercase badge on child rows | badge | 🔁 adapted | `MemoryPage.tsx:148` | Reproduced as an "included" pill (paired with "direct"). |
| Path-rule / glob metadata | data-binding | ➕ real-added | `MemoryPage.tsx:149-151`, `protocol.ts:443` | Real `globs` → "N path rule(s)" pill; not in prototype. |
| `MemMeta` — "N lines · N KB" (`memFmtBytes`) | sub-component/data-binding | ✂️ cut | `memoryDomain.ts:60` (content withheld) | Bodies stay engine-side ("paths, types, include metadata only"); no line/byte counts — source-wins mock drop. |
| `MemOpenBtn` — "Open to edit" ($EDITOR) | control/button | ⬜ deferred | `STATUS.md:226` §0 (open-to-editor deferred) | Explicitly deferred to safe writer boundary; whole surface read-only. |
| `MemOpenBtn` disabled "Read-only" (managed) state | ux-state/disabled | 🔁 adapted | `MemoryPage.tsx:96`, `goalMemoryState.ts:87-89` | No open buttons at all (all read-only); managed distinction survives as "Managed" type group + `counts.managed`. |
| `MemOpenBtn` hover styling | ux-state/hover | ✂️ cut | `STATUS.md:226` §0 | No open button exists to hover. |
| memOpen toast "Opening {path} in your editor" | behavior/feedback | ⬜ deferred | `STATUS.md:226` §0 | Visual-only stand-in for the deferred $EDITOR open. |
| "Auto memory" section + "N memories" count | section/ux-state | ✅ built | `MemoryPage.tsx:165-175` | Real `AutoMemories` section; count = `snapshot.autoMemories.length` "N rows". |
| Auto-memory directory path line (mono) | chrome/data-binding | ✅ built | `MemoryPage.tsx:104`, `memoryDomain.ts:70` | Real `autoMemoryDir` "dir: …"; bound to `getAutoMemPath()`. |
| MEMORY.md index row + "index" badge + open btn | sub-component/row | 🔁 adapted | `MemoryPage.tsx:105`, `memoryDomain.ts:71` | Real `autoMemoryEntrypoint` shown as "entrypoint: …" text line, not a dedicated row-with-open-button. |
| "index" uppercase badge | badge | ✂️ cut | `STATUS.md:226` §0 | No dedicated index row; entrypoint is a plain metadata line. |
| Oversize warning banner — MEMORY.md large (>200 lines / 25 KB) | ux-state/warning | 🔁 adapted | `MemoryPage.tsx:152`, `protocol.ts:444` | "Part loaded into context" maps to real `contentDiffersFromDisk` → "truncated" pill on instruction files; mock line/KB-threshold banner not reproduced (source-wins). |
| Amber warning-triangle SVG icon | chrome/icon | ✂️ cut | `STATUS.md:226` §0 | Belongs to the un-reproduced mock-threshold banner. |
| Individual topic-memory rows — name.md + type chip + description | sub-component/row | ✅ built | `MemoryPage.tsx:182-204` | Real rows over `snapshot.autoMemories` (frontmatter headers from memdir scan). |
| `MemTypeChip` — type chip (user/feedback/project/reference) | badge/data-binding | ✅ built | `MemoryPage.tsx:188`, `protocol.ts:437`, `src/memdir/memoryTypes.ts:14-21` | Real `Pill(memory.type)`; 4 types match `MEMORY_TYPES`/`AutoMemoryType` exactly; untyped → "untyped" pill (graceful). |
| Topic-memory description binding | data-binding | ✅ built | `MemoryPage.tsx:193-197`, `protocol.ts:451` | Real `memory.description` from frontmatter; null → omitted. |
| Auto-memory mtime line | data-binding | ➕ real-added | `MemoryPage.tsx:198-200`, `protocol.ts:450` | Real ISO `mtimeMs` per row; not in prototype. |
| "Team memory" section — gated on `team.enabled` | section/ux-state | 🔁 adapted | `MemoryPage.tsx:100-101`, `goalMemoryState.ts:101-104` | Team memory surfaced as `TeamMem` instruction-type group + `counts.teamMem`, not a dedicated section. |
| Team memory directory path line | chrome/data-binding | ✂️ cut | `STATUS.md:226` §0 | No dedicated team section; mock `team.dir` has no real analog in `MemorySnapshot`. |
| Team MEMORY.md index row + "shared" (teal) badge | sub-component/row | 🔁 adapted | `MemoryPage.tsx:100` | TeamMem files fold into the type-grouped list; no separate shared-index row. |
| "shared" uppercase badge (teal) | badge | ✂️ cut | `STATUS.md:226` §0 | Distinct team badge not reproduced; TeamMem is a type-group label. |
| "Agent memory" section — per-agent memory dirs, "N agent(s)" | section/ux-state | ❓ missing-no-owner | — | No per-agent memory in real `MemorySnapshot` (types = Managed/User/Project/Local/AutoMem/TeamMem only, `protocol.ts:429-434`); not covered by P4-10 §0 flags. Likely `MOCK_MEMORY.agentMemory` invention — needs human ruling (cut-as-mock vs real gap). |
| Per-agent rows — `AgentTypeChip` + dir + "N file(s)" (+ plain-text fallback) | sub-component/row | ❓ missing-no-owner | — | Sub-elements of the unowned Agent-memory feature above; no real per-agent memdir state to bind to. |
| `memFmtBytes` B/KB formatter | util | ✂️ cut | `memoryDomain.ts:60` | Depends on withheld byte sizes; no byte data crosses the boundary. |
| Memory-sources count grid (Managed/User/Project/Local/AutoMem/TeamMem) | summary | ➕ real-added | `MemoryPage.tsx:95-102`, `goalMemoryState.ts:65-108` | Real per-scope roll-up; not in prototype. |
| "Read-only snapshot" header pill | chrome/badge | ➕ real-added | `MemoryPage.tsx:52-54` | Signals the deliberate read-only scope; no prototype equivalent. |
| Waiting/empty state (null snapshot) | ux-state/loading | ➕ real-added | `MemoryPage.tsx:59-71` | "Waiting for the engine's memory snapshot…"; prototype always has mock so has none. |
| "Scope" notes list | chrome/notes | ➕ real-added | `MemoryPage.tsx:209-223`, `memoryDomain.ts:59-63` | Renders engine `notes` documenting withheld-content + deferred-writes scope. |
| `autoMemoryEnabled` state line ("Auto-memory is enabled/disabled") | ux-state/data-binding | ➕ real-added | `MemoryPage.tsx:82-84`, `protocol.ts:456` | Real toggle state surfaced; not in prototype. |

### 24. PlanPanel.jsx — reopenable plan-mode review drawer (PlanBar + PlanPanel) with file path, editable/checklist steps, requested permissions, and mode-based approve/revise

**Migration target:** deferred → `P4-11` (no `PlanPanel`/`PlanBar` exists in `app/renderer/src`, grep empty) · **Overall:** ⬜ deferred · **Prototype:** `~/catcode_prototype/cat-app/PlanPanel.jsx` (327 lines) · **INVENTORY:** W4 PlanBar/PlanPanel adapt/build-new (S6)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| PlanBar container — blue-tinted bar above composer (reopen affordance) | chrome | ⬜ deferred | `phase4.md P4-11:617` | Source-backed shell: shows only in plan mode; reuse P2-4 permission-mode context. |
| PlanBar checklist icon (SVG) | chrome | ⬜ deferred | `phase4.md P4-11:617` | Decorative; carries over as-is. |
| PlanBar title `Plan mode` / `Plan mode · executing` | chrome | ⬜ deferred | `phase4.md P4-11:617` | planning vs executing sub-state is GUI progress framing — flag per `phase4.md:636`. |
| PlanBar subtitle `N-step plan ready` / `N of M steps done` | chrome | ⬜ deferred | `phase4.md P4-11:617` | Step count from plan file is real; `N of M done` progress is GUI-invented — flag. |
| PlanBar `View plan` button (opens panel) + hover | control | ⬜ deferred | `phase4.md P4-11:617` | Reopenable-drawer affordance is a GUI addition over the one-shot approve modal. |
| PlanBar visibility rule (hidden while panel open; hidden if no plan) | ux-state | ⬜ deferred | `PlanPanel.jsx:306` | `open[sessionId]` toggle in demo store; back with real per-session plan-mode state. |
| Modal overlay backdrop (dim + blur) + click-outside-to-close | chrome | ⬜ deferred | `PlanPanel.jsx:202` | Prototype note: mirrors `/tasks` panel docking; match `WorkspacePanels` right-drawer grammar. |
| Panel card container (520w drawer, blue-tinted border) | chrome | ⬜ deferred | `phase4.md P4-11:617` | No inline `style={{}}` allowed — port to tokens/CSS. |
| Scrollable steps body (`no-scrollbar` overflow-y region) | chrome | ⬜ deferred | `PlanPanel.jsx:232` | Hidden-scrollbar scroll container between header and footer. |
| Header checklist icon (SVG) | chrome | ⬜ deferred | `phase4.md P4-11:617` | Decorative. |
| Header `Plan` title | chrome | ⬜ deferred | `phase4.md P4-11:617` | Static label. |
| Header status pill `planning` / `executing · N/M` | chrome | ⬜ deferred | `attachments.ts` mode==='plan' gate | planning/executing source-backed via permission mode; `· N/M` progress fragment invented — flag. |
| Header close (×) button + hover, title `Close (Esc)` | control | ⬜ deferred | `PlanPanel.jsx:216` | Standard dismiss. |
| `plan.file` path (green mono code) | data-binding | ⬜ deferred | `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` (planFilePath) | SOURCE-BACKED — plan is a real file injected on plan exit. Build faithfully. |
| Edit / `Done editing` toggle (planning only) | control | ⬜ deferred | `PlanPanel.jsx:222` | GUI-INVENTED: upstream you revise by telling the agent to rewrite the FILE. Flag; P4-11 adapts vs drops. |
| `plan.objective` summary line (optional) | data-binding | ⬜ deferred | `PlanPanel.jsx:228` | Derivable from plan file content, not a discrete engine field — flag if fabricated. |
| Body section label `N steps` / `Steps` | chrome | ⬜ deferred | `phase4.md P4-11:617` | Step count derived from plan-file parse. |
| StepRow read/checklist row (per-step) | subcomponent | ⬜ deferred | `PlanPanel.jsx:99` | Steps parsed from plan file are real; per-step live state is invented (StepDot rows). |
| StepDot — pending (hollow ring) | ux-state | ⬜ deferred | `PlanPanel.jsx:54` | MOCK per-step execution state; `phase4.md:636` says flag, don't fabricate progress. |
| StepDot — running (pulse dot) | ux-state | ⬜ deferred | `PlanPanel.jsx:52` | GUI-INVENTED live-execution state — flag. |
| StepDot — done (green check, strikethrough) | ux-state | ⬜ deferred | `PlanPanel.jsx:53` | GUI-INVENTED progress state — flag. |
| StepDot — blocked (amber dot) | ux-state | ⬜ deferred | `PlanPanel.jsx:47` | GUI-INVENTED progress state — flag. |
| Step text (strikethrough when done) | data-binding | ⬜ deferred | `PlanPanel.jsx:121` | Text real (from file); strikethrough depends on invented done state — flag styling trigger. |
| Per-step files chips (`step.files`) | data-binding | ⬜ deferred | `PlanPanel.jsx:124` | MOCK field — engine has no per-step file mapping. Flag; P4-11 may derive from allowedPrompts. |
| `view diff →` button per step | control | ⬜ deferred | `PlanPanel.jsx:125` (toast-stub) | GUI-INVENTED, toast-only; real diff view is out of this surface's scope. |
| Per-step state label (running/done/blocked, right-aligned) | chrome | ⬜ deferred | `PlanPanel.jsx:129` | GUI-INVENTED progress label — flag. |
| StepRow EDITING — auto-growing textarea | control | ⬜ deferred | `PlanPanel.jsx:104` | GUI-INVENTED inline step editing (no engine structured-edit write-path) — flag. |
| Step `Move up` ▲ (disabled when isFirst) | control | ⬜ deferred | `PlanPanel.jsx:108` | GUI-INVENTED reorder — flag. |
| Step `Move down` ▼ (disabled when isLast) | control | ⬜ deferred | `PlanPanel.jsx:109` | GUI-INVENTED reorder — flag. |
| Step `Remove` × (red) | control | ⬜ deferred | `PlanPanel.jsx:111` | GUI-INVENTED step deletion — flag. |
| Step number `n.` (mono, blue) | chrome | ⬜ deferred | `PlanPanel.jsx:103` | Ordinal shown only in edit mode. |
| `+ Add step` button (editing, planning only) | control | ⬜ deferred | `PlanPanel.jsx:243` | GUI-INVENTED — no engine append-step path. Flag. |
| allowedPrompts header `Plan requests permission to` | chrome | ⬜ deferred | `ExitPlanModeV2Tool.ts` (allowedPrompts) | SOURCE-BACKED section; `prompt.ts` marks it Ant-only in the external stub — confirm availability in build. |
| allowedPrompts chips (tool + prompt pairs) | data-binding | ⬜ deferred | `ExitPlanModeV2Tool.ts` (allowedPrompts) | SOURCE-BACKED — render the real requested permissions; ties into P2-4 permission context. |
| Footer EXECUTING — pulse dot + `Executing: N of M steps done` | ux-state | ⬜ deferred | `PlanPanel.jsx:268` | GUI-INVENTED progress line — the exact chrome `phase4.md:636` says flag, don't fabricate. |
| Footer EXECUTING — approvalMode label (right-aligned) | data-binding | ⬜ deferred | `ExitPlanModeV2Tool.ts` (approval modes) | SOURCE-BACKED — chosen approval mode is a real permission-mode transition. |
| Footer REVISING — revision textarea (`Tell the agent what to change…`) | control | ⬜ deferred | `PlanPanel.jsx:273` (toast-stub) | GUI-INVENTED structured-revise (real revise = type in chat). Flag; P4-11 routes-to-composer vs drops. |
| Footer REVISING — `Send revision` (disabled when empty) | control | ⬜ deferred | `PlanPanel.jsx:277` (stub) | Part of invented revise flow — flag. |
| Footer REVISING — `Cancel` | control | ⬜ deferred | `PlanPanel.jsx:278` | Dismisses revise box. |
| Footer REVISING — `⌘↵ send · esc cancel` hint + keybinds | shortcut | ⬜ deferred | `PlanPanel.jsx:274` | Cmd/Ctrl+Enter sends, Esc cancels; port with revise flow. |
| Footer PLANNING — `Approve plan` button + caret rotate | control | ⬜ deferred | `PlanPanel.jsx:287` | SOURCE-BACKED action (ExitPlanMode approval). Opens the mode menu. |
| ApproveMenu popover (mode picker) | subcomponent | ⬜ deferred | `ExitPlanModeV2Tool.ts` (mode set) | SOURCE-BACKED — reuse P2-4 permission-mode transition, don't invent a parallel one. |
| ApproveMenu option — `Approve & auto-accept edits` (acceptEdits) | control | ⬜ deferred | `getNextPermissionMode` acceptEdits | SOURCE-BACKED. |
| ApproveMenu option — `Approve & bypass permissions` (bypassPermissions) | control | ⬜ deferred | `getNextPermissionMode` bypassPermissions | SOURCE-BACKED; P2-4 rejected bypass at the permission boundary — P4-11 must reconcile offering it here. |
| ApproveMenu option — `Approve & ask per edit` (default) | control | ⬜ deferred | `ExitPlanModeV2Tool.ts` (restore prePlanMode/default) | SOURCE-BACKED. |
| ApproveMenu — MISSING `keep-planning` option | correctness | ➕ real-added | `src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx` ("No, keep planning") | Real approval set has a 4th keep-planning/reject outcome the prototype's 3-item menu drops; P4-11 should add it. |
| ApproveMenu — number badges 1/2/3 + cursor highlight | chrome | ⬜ deferred | `PlanPanel.jsx:87` | Selected-state styling for the digit/arrow-driveable menu. |
| ApproveMenu — keyboard nav (↑/↓, Enter, 1-3, Esc, outside-click) | shortcut | ⬜ deferred | `PlanPanel.jsx:69` | Arrow+Enter driveable, digits pick a mode, Esc/outside-click close. |
| Footer PLANNING — `Revise…` button | control | ⬜ deferred | `PlanPanel.jsx:291` | Opens invented revise box — flag with the revise flow. |
| Footer PLANNING — `read-only until you approve` hint | chrome | ⬜ deferred | `PlanPanel.jsx:294` | Communicates plan-mode read-only gating — source-backed (mode==='plan' blocks edits). |
| Approve toast `Plan approved · <mode>` | ux-state | ⬜ deferred | `ToastHost.tsx` (P4-1) | Success feedback; wire to real ToastHost + real mode transition result. |
| Revision toast `Sent. The agent will revise the plan.` | ux-state | ⬜ deferred | `PlanPanel.jsx:198` (stub) | Part of invented revise flow — flag. |
| Session-keyed plan store (per-session scoping, no cross-session leak) | data-binding | ⬜ deferred | `PlanPanel.jsx:24` (window.PLAN_DEMO) | Back with real per-session plan file + permissionMode; scope to owning session. |
| Focus lifecycle — focus into panel on open, restore on close | ux-state | ⬜ deferred | `PlanPanel.jsx:151` | Accessibility; carry over. |
| Esc closes panel (unless sub-surface owns it) | shortcut | ⬜ deferred | `PlanPanel.jsx:162` | Esc guarded so approve menu / revise box own it first. |
| Tab focus-trap within panel | shortcut | ⬜ deferred | `PlanPanel.jsx:163` | Cyclic Tab/Shift-Tab within the modal. |
| Empty state — no plan / panel closed → renders null | ux-state | ⬜ deferred | `PlanPanel.jsx:175` | Both PlanBar and PlanPanel hide entirely when there is no plan. |
| Status transition planning → executing (on approve) | ux-state | ⬜ deferred | `ExitPlanModeV2Tool.ts` (plan exit restores prePlanMode) | SOURCE-BACKED transition; the persistent executing drawer afterward is GUI progress framing — flag. |

### 25. SettingsExtensions.jsx — Settings → Extensions: MCP / Plugins / Skills / Hooks panels + the MCP ElicitationDialog modal

**Migration target:** deferred → P4-12 (`phase4.md:649`; dep P4-3 ✅) · **Overall:** ⬜ deferred · **Prototype:** `~/catcode_prototype/cat-app/SettingsExtensions.jsx` (507 lines) · **INVENTORY:** W4-Settings MCP/Plugins/Skills/Hooks/Elicitation adapt (S7)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| `StatusPill` — tone-driven status dot + label (good/danger/warn/info/muted/accent) | chrome | ⬜ deferred | `phase4.md:649` P4-12 | Shared status primitive reused by all 4 panels; tones map to `tone.ts` semantics. |
| `StatusPill` pulse animation (`pulse-dot` for pending/connecting) | state | ⬜ deferred | `phase4.md:649` P4-12 | Connecting UX-state; used for MCP `pending`. |
| `RowBtn` — compact secondary row-action button + hover in/out | control | ⬜ deferred | `phase4.md:649` P4-12 | Tone variants default/danger/accent/good; P4-12 must use no inline style. |
| `KeyHint` — monospace keycap chip (`Esc` / `⌘↵` / `↵`) | chrome | ⬜ deferred | `phase4.md:649` P4-12 | Keycap on RowBtn + elicitation dialog buttons. |
| `ExtCard` — generic list-row card shell + `dim`/opacity variant | chrome | ⬜ deferred | `phase4.md:649` P4-12 | Uniform 1px border, no status-color left bar (deliberate); `dim` for disabled/off rows. |
| MCP summary bar — connected / tools / resources counts | data-binding | ⬜ deferred | `phase4.md:649` P4-12; real `src/services/mcp/config.ts` | tools/resources are per-server MOCK counts — render from real MCP state or flag. |
| "Form elicitation" trigger button | control | ✂️ cut | prototype `SettingsExtensions.jsx:8,97` `// DEMO-ONLY` | Demo scaffolding; real dialog is triggered by an actual MCP request, not a settings button. |
| "URL elicitation" trigger button | control | ✂️ cut | prototype `SettingsExtensions.jsx:8,97` `// DEMO-ONLY` | Demo scaffolding, same as Form trigger. |
| `McpAddMenu` — "+ Add server" button + popover | control | ⬜ deferred | `phase4.md:649` P4-12 | Actions are toast stubs; P4-12 wires add via SettingsUpdater-under-lock (writes deferred). |
| `McpAddMenu` overlay — fixed inset click-catcher dismiss | state | ⬜ deferred | `phase4.md:649` P4-12 | Popover-open UX-state; click-outside closes (`SettingsExtensions.jsx:164`). |
| `McpAddMenu` options — stdio / sse / http / json entries | subcomponent | ⬜ deferred | `phase4.md:649` P4-12 | Transports source-anchored (`utils.ts:313-323`); `json` is a paste-config affordance. |
| MCP server card — server name (mono) | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | Per-server row identity. |
| MCP server status pill — connected/failed/needs-auth/pending/disabled | state | ⬜ deferred | `phase4.md:649` P4-12 | Five states from `MCPServerConnection.type`; render real connection status. |
| MCP transport badge (uppercase) | chrome | ⬜ deferred | `phase4.md:649` P4-12 | Transport label per server. |
| MCP `SourceBadge` (scope → source via `scopeToSource`) | data-binding | ⬜ deferred | `phase4.md:649` P4-12; consumes P4-3 `SettingsField.tsx` | FLAG: `scopeToSource` (`:153`) flattens `ConfigScope` (`types.ts:10-18`) into 5 sources — render real scope, flag the collapse. |
| MCP `pluginSource` "via X" tag | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | Shown when server is plugin-contributed. |
| MCP command/url subtitle line (ellipsized) | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | url for remote, command+args for stdio. |
| MCP connected detail — toolCount · resourceCount · serverInfo name/version | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | MOCK values — render from real MCP client capabilities or flag unavailable. |
| MCP failed-state error message | state | ⬜ deferred | `phase4.md:649` P4-12 | Error UX-state for failed servers. |
| MCP pending-state reconnect line (attempt N/M) | state | ⬜ deferred | `phase4.md:649` P4-12 | `reconnectAttempt`/`maxReconnectAttempts` MOCK — render real or flag. |
| MCP "Authenticate" button (needs-auth) | control | ⬜ deferred | `phase4.md:649` P4-12; real `src/services/mcp/auth.ts` | Prototype opens url elicitation; P4-12 wires real MCP OAuth. |
| MCP "Reconnect" button | control | ⬜ deferred | `phase4.md:649` P4-12 | Toast stub in prototype. |
| MCP "Enable" button (disabled-server) | control | ⬜ deferred | `phase4.md:649` P4-12 | Write action — deferred to write path. |
| MCP "Remove" button (danger) | control | ⬜ deferred | `phase4.md:649` P4-12 | Destructive write action — deferred to write path. |
| `ElicitationDialog` — modal overlay + card (backdrop blur, click-out dismiss) | subcomponent | ⬜ deferred | `phase4.md:649` P4-12; real `src/components/mcp/ElicitationDialog.tsx` | Maps to control request/response flow (`elicitationHandler.ts:49-51`) — permission-round-trip rigor. |
| `ElicitationDialog` header — "MCP request" + serverName + req# id | chrome | ⬜ deferred | `phase4.md:649` P4-12 | requestId binds to a real minted request id in the live flow. |
| `ElicitationDialog` message body | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | Server-provided prompt message. |
| `ElicitationDialog` form variant — per-property field (label + required marker) | subcomponent | ⬜ deferred | `phase4.md:649` P4-12 | Renders `requestedSchema.properties`; required fields marked `*`. |
| `ElicitationDialog` boolean field — toggle switch | control | ⬜ deferred | `phase4.md:649` P4-12 | Schema type=boolean control. |
| `ElicitationDialog` enum field — select dropdown | control | ⬜ deferred | `phase4.md:649` P4-12 | Schema enum control with "Select…" placeholder. |
| `ElicitationDialog` text/number field — input | control | ⬜ deferred | `phase4.md:649` P4-12 | type=number for numeric schema, text otherwise. |
| `ElicitationDialog` url variant — "Opens in browser" + url block | subcomponent | ⬜ deferred | `phase4.md:649` P4-12 | `getElicitationMode` picks variant (`elicitationHandler.ts:49-51`). |
| `ElicitationDialog` Cancel button + Esc hint | control | ⬜ deferred | `phase4.md:649` P4-12 | Sends decline/cancel response in real flow. |
| `ElicitationDialog` Submit button — "Send response"/"Open browser" + disabled state + ⌘↵/↵ hint | control | ⬜ deferred | `phase4.md:649` P4-12 | Label + hint switch by variant; disabled until required fields filled (form). |
| `ElicitationDialog` keyboard handling — Esc closes, Enter (url)/⌘Enter (form) submits | keyboard | ⬜ deferred | `phase4.md:649` P4-12 | Keyboard-first modal per house rules (`:212`). |
| `ElicitationDialog` required-field validation (missing → canSubmit gating) | state | ⬜ deferred | `phase4.md:649` P4-12 | `missing` = required minus filled; gates submit for form variant (`:202`). |
| Plugins panel tabs — "Installed · N" / "Marketplace" | control | ⬜ deferred | `phase4.md:649` P4-12 | Tab switcher with active underline. |
| Installed plugin card — plugin name | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | Plugin identity. |
| Plugin version label (vX.Y.Z) | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | Version string. |
| Plugin `SourceBadge` (scope) | data-binding | ⬜ deferred | `phase4.md:649` P4-12; consumes P4-3 SourceBadge | Same scope-flattening flag as MCP (`scopeToSource`). |
| Plugin update-available pill ("Update → vX") | state | ⬜ deferred | `phase4.md:649` P4-12 | `newVersion` MOCK — render from real update-check or flag. |
| Plugin load-error pill | state | ⬜ deferred | `phase4.md:649` P4-12 | Error UX-state. |
| Plugin id · source line | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | Plugin id + origin source string. |
| Plugin provides-summary (N cmds · N agents · N skills · N hooks · N MCP) | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | `provideSummary` helper (`:362`) over `plugin.provides` counts. |
| Plugin error message line | state | ⬜ deferred | `phase4.md:649` P4-12 | Load-error detail. |
| `PluginToggle` — enable/disable switch | control | ⬜ deferred | `phase4.md:649` P4-12 | Write action — deferred to write path (`:366`). |
| Plugin "Update" button | control | ⬜ deferred | `phase4.md:649` P4-12 | Toast stub in prototype. |
| Plugin "Options" button | control | ⬜ deferred | `phase4.md:649` P4-12 | Shown when plugin has no `provides.options`; toast stub. |
| Marketplace search input | control | ⬜ deferred | `phase4.md:649` P4-12 | Filters list by name/description/tags. |
| Marketplace card — name | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | FLAG: P4-12 must verify a real marketplace domain backs this tab; if none → adapt/cut with flag. |
| Marketplace sourceType badge | chrome | ⬜ deferred | `phase4.md:649` P4-12 | Source-type label; marketplace-domain-verification flag applies. |
| Marketplace tags (#tag) | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | Tag chips; marketplace-domain flag applies. |
| Marketplace description | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | Marketplace-domain flag applies. |
| Marketplace "Installed" pill / "Install" button | control | ⬜ deferred | `phase4.md:649` P4-12 | Install = toast stub; write deferred; marketplace-domain flag applies. |
| Skills panel summary line (N skills across M sources + flag explanation) | chrome | ⬜ deferred | `phase4.md:649` P4-12 | Explains user-invocable / disable-model-invocation flags. |
| Skills source group header + label (Policy/User/Project/Local/Flag/Plugin/MCP) | chrome | ⬜ deferred | `phase4.md:649` P4-12 | `SKILL_GROUPS` order (`:379`) source-anchored; re-verify real skills registry. |
| Skills group `SourceBadge` | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | `SKILL_SOURCE_BADGE` maps settings sources → P4-3 SourceBadge; plugin/mcp have no badge. |
| Skills group count | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | Per-group item count. |
| Skill card — /name (mono) | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | Slash-command name. |
| Skill fork badge ("fork · agent") | chrome | ⬜ deferred | `phase4.md:649` P4-12 | `context==='fork'` with optional agent name. |
| Skill `pluginName` "via X" tag | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | Shown for plugin-provided skills. |
| Skill "Manual only" pill (disableModelInvocation) | state | ⬜ deferred | `phase4.md:649` P4-12 | Real skill flag. |
| Skill "Not user-invocable" pill (userInvocable===false) | state | ⬜ deferred | `phase4.md:649` P4-12 | Real skill flag. |
| Skill description | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | Skill description text. |
| Skill whenToUse line | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | "When:" hint line. |
| `SkillToggle` — enable/disable switch | control | ⬜ deferred | `phase4.md:649` P4-12 | Write action — deferred to write path (`:432`). |
| Skill gated lock-note (plugin/mcp: "toggled via MCP server"/"plugin") | state | ⬜ deferred | `phase4.md:649` P4-12 | Plugin/MCP skills gated by provider, not individually toggleable. |
| Hooks panel summary line (N hooks across M events + no-persist note) | chrome | ⬜ deferred | `phase4.md:649` P4-12 | States cat-code does not persist per-hook history (`:467`) — anchors the reconstructed-lastRun flag. |
| Hooks event group header (grouped by event, canonical order) | chrome | ⬜ deferred | `phase4.md:649` P4-12 | Ordered by canonical HOOK_EVENTS order. |
| Hook card — `config.type` badge | chrome | ⬜ deferred | `phase4.md:649` P4-12; real `src/utils/hooks.ts` | command/webhook/prompt type. |
| Hook matcher tag | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | Tool/event matcher pattern. |
| Hook `SourceBadge` | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | Uses `SKILL_SOURCE_BADGE` map, fallback "user". |
| Hook `pluginName` "via X" tag | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | Plugin-provided hooks. |
| Hook async tag | chrome | ⬜ deferred | `phase4.md:649` P4-12 | `config.async` flag. |
| Hook command/url/prompt line | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | Whichever of command/url/prompt the config carries. |
| Hook last-run outcome pill (OK/Blocked/Error(non-blocking)/Cancelled) | state | ⬜ deferred | `phase4.md:649` P4-12; `src/utils/hooks.ts:338-357` | FLAG: outcomes reconstructed from in-memory events, NOT persisted (`:467`) — render real HookResult or drop column, flag the fake. |
| Hook last-run metadata (at · exit N · Nms) | data-binding | ⬜ deferred | `phase4.md:649` P4-12 | MOCK timings — reconstructed-not-persisted; same flag as outcome pill. |
| Hook "Not yet run" pill (no lastRun) | state | ⬜ deferred | `phase4.md:649` P4-12 | Empty/never-run UX-state for a configured hook. |

### 26. RemoteSettings.jsx — Settings → Remote: bridge toggle/status, inbound command-filter, and remote-session connect paths

**Migration target:** deferred → `P4-13` (cut scope, D3) · **Overall:** ⬜ deferred · **Prototype:** `~/catcode_prototype/cat-app/RemoteSettings.jsx` (251 lines) · **INVENTORY:** W4-Settings RemoteSettings D3

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Page container / `RemoteSettingsPanel` root (Bridge→Paired→Filter→Wizard stack) | subcomponent | ⬜ deferred | `phase4.md P4-13` (build list `:703-712`); no `app/renderer/src` file (only nav label `SettingsShell.tsx:124`); `STATUS.md:229` = ⬜ | Whole page unbuilt; P4-13 builds a reduced stack (bridge + filter + direct-connect form), no Paired section. |
| `PaneSectionR` recursion-guard section wrapper | subcomponent | ⬜ deferred | `phase4.md P4-13`; real section chrome = `app/renderer/src/SettingsShell.tsx` (P4-3) | Prototype scope-collision guard; real app reuses the built SettingsShell section primitive, not a bare wrapper. |
| Bridge panel card container (active-tinted pink when publishing) | chrome | ⬜ deferred | `phase4.md P4-13` ("bridge toggle + status"); real flag `src/hooks/useReplBridge.tsx:79-124` | In-scope; active tint must reflect real `replBridgeEnabled`, not the demo flag. |
| 'Remote Control bridge' title | chrome | ⬜ deferred | `phase4.md P4-13`; `decisions/PAIRED-DEVICES.md` §3 (bridge on/off+status is the real surface) | Header label for the bridge status block. |
| Status pill 'Publishing' (green) — bridge active | state | ⬜ deferred | real active state = `replBridgeEnabled` true, `src/hooks/useReplBridge.tsx:79-81` | Honest binding: publish=on. |
| Status pill 'Offline' (grey) — bridge inactive | state | ⬜ deferred | `replBridgeEnabled` false / auto-cleared on fuse, `src/hooks/useReplBridge.tsx:115-124` | Bridge off by default. |
| Bridge description + inline `/remote-control` mono command ref | chrome | ⬜ deferred | `/remote-control` toggles `replBridgeEnabled` in-REPL, `src/hooks/useReplBridge.tsx:48` | Explains in-session toggle; behavior confirmed. |
| Active meta chip: 'v2 · env-less transport' | data-binding | ⬜ deferred | v1/v2 transport branch real, `src/bridge/initReplBridge.ts` (gate + branch, cited `RemoteSettings.jsx:10`) | Bind to the actual branch chosen; don't hardcode 'v2'. |
| Active meta chip: 'worker JWT refreshes in 54m' countdown | data-binding | ⬜ deferred | `phase4.md P4-13` "render honest state, add NO new trust surface"; header marks mock (`RemoteSettings.jsx:3`) | MOCK value (source-wins): render real refresh time or DROP; never ship '54m'. |
| Active meta chip: 'N clients attached' count | data-binding | ⬜ deferred | `decisions/PAIRED-DEVICES.md` §1 (no persisted list of who attached, no revocation) | MOCK '2' (source-wins); aggregate count may be derivable, per-client IDENTITY stays cut. |
| 'Start bridge' / 'Stop bridge' toggle button (color flips) | control | ⬜ deferred | `phase4.md P4-13` "bridge toggle over the real flag"; `src/hooks/useReplBridge.tsx:79-81` | Core in-scope control; drives `replBridgeEnabled` (= `/remote-control`). |
| Bridge toggle handler → sets `window.__BRIDGE_ACTIVE` + toast | data-binding | 🔁 adapted | header `:20-21` marks `__BRIDGE_ACTIVE` DEMO-ONLY; real toast `app/renderer/src/ToastHost.tsx` (P4-1) | Demo palette-sync flag cut; real derives from `replBridgeEnabled`; toast feedback survives. |
| 'Paired devices' `PaneSection` + header | subcomponent | ✂️ cut | `decisions/PAIRED-DEVICES.md` §3 (roster = invention), §4 operator ruling; `INVENTORY.md:89` D3 CLOSED CUT | Entire section cut for v1; no device-identity store upstream (only unrelated Chrome-ext pairing `config.ts:530-533`). |
| `MOCK_PAIRED_DEVICES` fixture (3 devices; kind/role/connected/addr) | data-binding | ✂️ cut | prototype self-admits invention `RemoteSettings.jsx:36-38`; `PAIRED-DEVICES.md` §1 | MOCK roster; nothing to bind to. |
| Device row (icon + name + role pill + addr/status + revoke) | chrome | ✂️ cut | `PAIRED-DEVICES.md` §3, §4 ruling | Per-device row has no backing data model. |
| `DeviceIcon` glyphs (mobile / tablet / web SVG variants) | chrome | ✂️ cut | belongs to cut roster, `PAIRED-DEVICES.md` §3 | Device-kind iconography is invention (no device kind in source). |
| Device connected/disconnected icon color state | state | ✂️ cut | `PAIRED-DEVICES.md` §1 (no per-client connection state persisted) | Per-device connection state has no store. |
| Device name + addr + 'connected'/'last seen {t}' meta line | data-binding | ✂️ cut | MOCK fields `RemoteSettings.jsx:40-42`; `PAIRED-DEVICES.md` §3 | Mock addr/last-seen strings; no source. |
| Revoke button (+ hover state) per device | control | ✂️ cut | `PAIRED-DEVICES.md` §1 ("no revocation primitive — turning the bridge off is the only revoke"), §2 | No revocation primitive; building one = new trust model, v2. |
| Revoke handler (removes device + warn toast) | data-binding | ✂️ cut | `PAIRED-DEVICES.md` §1 no revoke primitive | Cut with the roster/revoke feature. |
| Empty state: 'No paired devices.' | state | ✂️ cut | cut roster, `PAIRED-DEVICES.md` §4 | Empty state of a cut section. |
| `RemoteRolePill` — Control variant (pink, play-triangle) | subcomponent | ⬜ deferred | `phase4.md P4-13` ("survives ONLY as a label"); `src/remote/RemoteSessionManager.ts` | Survives as session controller LABEL; per-DEVICE use (`:112`) is cut. |
| `RemoteRolePill` — Viewer variant (blue, eye) | subcomponent | ⬜ deferred | `phase4.md P4-13`; viewer/controller `src/remote/RemoteSessionManager.ts` | Read-only viewer label; deferred as session-level label only. |
| `RemoteRolePill` title tooltip (drive / read-only) | chrome | ⬜ deferred | survives with the label, `phase4.md P4-13` | Tooltip travels with the surviving label. |
| `RemoteRolePill` size variants (sm / xs) | chrome | 🔁 adapted | `phase4.md P4-13` "no inline style"; primitive kit `app/renderer/src/Chip.tsx` (P4-1) | Real app forbids inline style; two-size inline impl adapts to the primitive kit. |
| `RemoteRolePill` used as PER-DEVICE role on roster rows | data-binding | ✂️ cut | `PAIRED-DEVICES.md` §3 (roles not modeled per connection), §6 (not a per-device control) | This USE is cut; the pill survives as a session label (rows above). |
| 'Inbound command filter' `PaneSection` + header | subcomponent | ⬜ deferred | `phase4.md P4-13` (command-filter truth read-only); `src/commands.ts:676-700` | Core in-scope element: render the REAL filter truth read-only. |
| Filter explanatory text (skill=safe / local=opt-in / Ink-UI=blocked) | chrome | ⬜ deferred | matches real `isBridgeSafeCommand`, `src/commands.ts:697-700` | Copy accurately describes real filter semantics. |
| `FilterCard` 'Allowed: skills' (green) — prompt-type commands | chrome | ⬜ deferred | prompt/skill safe by type, `src/commands.ts:697-700` | Items are ILLUSTRATIVE mock (source-wins); express 'all prompt-type' from the type check. |
| `FilterCard` 'Allowed: opt-in' (amber) — `BRIDGE_SAFE_COMMANDS` | data-binding | ⬜ deferred | real Set `src/commands.ts:676`; `phase4.md P4-13` "render the REAL list" | MUST bind live `BRIDGE_SAFE_COMMANDS`, not the prototype copy. |
| Hardcoded `BRIDGE_SAFE_COMMANDS` copy array in prototype | data-binding | 🔁 adapted | real Set `src/commands.ts:676-684`; `phase4.md P4-13` forbids the copied array | Real must import/derive from the engine constant (drift is the anti-pattern P4-13 calls out). |
| `FilterCard` 'Blocked: Ink UI' (red, full-width) — local-jsx | chrome | ⬜ deferred | local-jsx blocked, `src/commands.ts:695` + `isBridgeSafeCommand` | Items illustrative mock; derive 'blocked = local-jsx type', not a fixed list. |
| `FilterCard` styling (tone dot + note + chip tags) | chrome | ⬜ deferred | `phase4.md P4-13` no inline style; `app/renderer/src/Chip.tsx` (P4-1) | Card chrome deferred; reuse built Chip primitive. |
| 'Connect a remote session' `PaneSection` (wizard shell) | subcomponent | 🔁 adapted | `phase4.md P4-13` reduces to a direct-connect FORM; `PAIRED-DEVICES.md` §3 names only direct-connect | Survives as a single direct-connect form; multi-mode wizard framing cut. |
| Connect-mode tab switcher (3 buttons: Direct / SSH / Proxy) | control | ✂️ cut | `phase4.md P4-13` done-when "confirm no roster/wizard"; `PAIRED-DEVICES.md` §3 (single direct-connect form) | v1 is a single form, not a mode-switching wizard. |
| Direct-connect: description + 'Ready' status pill | state | ⬜ deferred | `phase4.md P4-13` (direct-connect form); `src/server/createDirectConnectSession.ts:26` | Direct-connect content is the surviving in-scope form. |
| Direct-connect Server URL input (`cc://host:8200`, mono) | control | ⬜ deferred | `createDirectConnectSession({serverUrl…})` `src/server/createDirectConnectSession.ts:26`; hook `src/hooks/useDirectConnect.ts:39` | serverUrl maps to the real direct-connect POST + WS. |
| 'Connect' submit button | control | ⬜ deferred | `phase4.md P4-13`; wire to `useDirectConnect.ts:39` | In-scope: submit calls the real direct-connect primitive. |
| SSH mode (Host + Identity-file fields, 'Not configured') | control | ✂️ cut | `PAIRED-DEVICES.md` §1 (SSH/proxy = config surfaces, not pairing); wizard cut `phase4.md P4-13`; §3 names only direct-connect | Substrate real (bridge-remote-cli SSH) but OUT of v1 scope; not owned. |
| Upstream-proxy mode (Proxy URL field, 'Fail-open') | control | ✂️ cut | `PAIRED-DEVICES.md` §1 (config-surface-not-pairing); substrate `src/upstreamproxy/upstreamproxy.ts`; wizard cut | Substrate real (CCR egress proxy) but OUT of v1 scope; not owned by P4-13. |
| Wizard field input styling (mono/regular) | chrome | ⬜ deferred | `phase4.md P4-13` no inline style; `app/renderer/src/SettingsField.tsx` (P4-3) | Field chrome deferred; reuse built SettingsField primitive. |
| `statusPill()` helper (dot + label + tinted border) | chrome | ⬜ deferred | used by bridge status + wizard status (both in-scope); `app/renderer/src/Chip.tsx` (P4-1) | Reused status primitive; likely satisfied by the built Chip kit. |
| `dot()` colored-dot helper | chrome | ⬜ deferred | used by `statusPill` + `FilterCard` (in-scope elements) | Small shared visual primitive; travels with surviving elements. |
| `window.__BRIDGE_ACTIVE` demo flag → palette 'Filtered on bridge' cross-wiring | data-binding | ✂️ cut | header `:20-21` "DEMO-ONLY … cat-code derives this from `replBridgeEnabled`" | Prototype-only global flag; real derivation is `replBridgeEnabled` (bridge-toggle binding). |

### 27. Startup.jsx — First-launch trust→OAuth gate + mid-session reauth (deferred; read-only/switch-prompt/blocking-modal cut)

**Migration target:** deferred → P4-15 (D4) · **Overall:** ⬜ deferred · **Prototype:** `~/catcode_prototype/cat-app/Startup.jsx` (489 lines) · **INVENTORY:** W5 Startup/trust adapt (S6)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Full-screen fixed overlay backdrop, radial-pink gradient (`StartupShell`) | chrome | ⬜ deferred | `phase4.md P4-15` (unbuilt, `STATUS.md:231` ⬜) | App-level mount while startup incomplete; adapt to per-session-create. |
| Header brand: paw-logo SVG + `cat code` wordmark | chrome | ⬜ deferred | `phase4.md P4-15` | Startup chrome. |
| Step indicator: Trust dot → connector → Sign-in dot, active on `step==='auth'` | chrome | ⬜ deferred | `phase4.md P4-15`; real order `init.ts` (trust→auth) | Two-step progress; adapt survives (`STARTUP-GATES.md §1`). |
| Centered card container (500px, border, shadow) | chrome | ⬜ deferred | `phase4.md P4-15` | Shared card frame; no inline style (P4-15 ground rule). |
| Primary button style (pink fill) | chrome | ⬜ deferred | `phase4.md P4-15` | Tokenize at build. |
| Secondary button style (ghost/outline) | chrome | ⬜ deferred | `phase4.md P4-15` | Tokenize at build. |
| `spin` spinner CSS animation (auth + reauth waits) | chrome | ⬜ deferred | `phase4.md P4-15` | OAuth loading affordance. |
| TrustGate: `Trust required` amber uppercase pill | chrome | ⬜ deferred | `phase4.md P4-15`; `config.ts:111` (`hasTrustDialogAccepted`) | Trust-gate header badge. |
| TrustGate: title `Trust this workspace?` | chrome | ⬜ deferred | `phase4.md P4-15`; `TrustDialog.tsx` | Adapt of real TrustDialog copy. |
| TrustGate: explainer body (loads files/plugins/LSP; commands gated) | chrome | ⬜ deferred | `phase4.md P4-15` | Deferred. |
| TrustGate: workspace path panel (`Workspace` label + code path) | data-binding | ⬜ deferred | `phase4.md P4-15`; HC1 (`STARTUP-GATES.md §1.1`) | Binds host-provided session cwd, not hardcoded `~/cat-code`. |
| TrustGate: `Trust workspace` primary button → trust action | control | ⬜ deferred | `phase4.md P4-15`; `config.ts:735-788`, `TrustDialog.tsx:231` | Persist per-path in engine config, then spawn. |
| TrustGate: `Open read-only` secondary button → readonly phase | control | ✂️ cut | `decisions/STARTUP-GATES.md §5-Q1` (TUI parity); `TrustDialog.tsx:231-240` | Decline = exit, not a restricted mode. Not a gap. |
| TrustGate: read-only footnote paragraph | chrome | ✂️ cut | `decisions/STARTUP-GATES.md §5-Q1` | Describes a non-existent read-only state. Not a gap. |
| AuthGate ready_to_start: `Sign in` blue pill | chrome | ⬜ deferred | `phase4.md P4-15`; `ConsoleOAuthFlow.tsx:35-55` | First-run OAuth surface (shared with P4-5). |
| AuthGate ready_to_start: title `Sign in with Codex` | chrome | ⬜ deferred | `phase4.md P4-15` | Deferred. |
| AuthGate ready_to_start: explainer body (routes turns via ChatGPT/Codex) | chrome | ⬜ deferred | `phase4.md P4-15` | Deferred. |
| AuthGate ready_to_start: provider card (C icon + Codex·ChatGPT + OAuth subtitle) | subcomponent | ⬜ deferred | `phase4.md P4-15`; Codex-only (`Startup.jsx:63-67`) | Single-provider card (no Anthropic/API-key/Bedrock). |
| AuthGate ready_to_start: `Open browser to sign in` primary button (autoFocus) | control | ⬜ deferred | `phase4.md P4-15`; `ConsoleOAuthFlow.tsx:353,357` | Launches browser handoff; engine owns token (SECURITY-MINIMUM). |
| AuthGate waiting/success: title toggle `Continue in your browser`/`Signed in` | state | ⬜ deferred | `phase4.md P4-15`; `ConsoleOAuthFlow.tsx:38` | OAuth waiting + success states. |
| AuthGate waiting/success: body-text toggle (`Opening browser…`/`Account linked…`) | state | ⬜ deferred | `phase4.md P4-15` | Deferred. |
| AuthGate waiting/success: spinner→checkmark status row + label | state | ⬜ deferred | `phase4.md P4-15` | Loading/success visual state. |
| AuthGate waiting: paste-code fallback block (`Visit <AUTH_URL> and paste the code`) | subcomponent | ⬜ deferred | `phase4.md P4-15`; `ConsoleOAuthFlow.tsx:672` | Real fallback path exists; adapt. |
| AuthGate waiting: `Cancel` secondary button → ready_to_start | control | ⬜ deferred | `phase4.md P4-15` | Deferred. |
| AuthGate waiting: `Simulate failure` button → error | control | ✂️ cut | demo affordance; real errors `ConsoleOAuthFlow.tsx:364` | DEMO-ONLY control (source wins). Not a gap. |
| AuthGate alias: `Authorized` green pill | chrome | ⬜ deferred | `phase4.md P4-15`; `ConsoleOAuthFlow.tsx:48` | Codex-specific alias step (real). |
| AuthGate alias: title `Name this account` | chrome | ⬜ deferred | `phase4.md P4-15` | Deferred. |
| AuthGate alias: body (optional alias / blank = email) | chrome | ⬜ deferred | `phase4.md P4-15` | Deferred. |
| AuthGate alias: text input (placeholder, Enter→success, focus border) | control | ⬜ deferred | `phase4.md P4-15`; `ConsoleOAuthFlow.tsx:48` | Alias input + Enter shortcut. |
| AuthGate alias: `Continue ↵` primary button → success | control | ⬜ deferred | `phase4.md P4-15` | Deferred. |
| AuthGate error: `OAuth error` red pill | state | ⬜ deferred | `phase4.md P4-15`; `ConsoleOAuthFlow.tsx:55,364` | OAuth error state (retryable). |
| AuthGate error: title `Sign-in didn't complete` | state | ⬜ deferred | `phase4.md P4-15` | Deferred. |
| AuthGate error: body (browser flow cancelled/timed out) | state | ⬜ deferred | `phase4.md P4-15` | Deferred. |
| AuthGate error: error-code panel `authorization_request_timed_out` | data-binding | ⬜ deferred | `phase4.md P4-15`; `ConsoleOAuthFlow.tsx:55,364` | Bind real `error.message`; hardcoded string is mock. |
| AuthGate error: `Retry ↵` primary button (autoFocus) → waiting_for_login | control | ⬜ deferred | `phase4.md P4-15`; `ConsoleOAuthFlow.tsx:745,364` | Maps to real `toRetry:{state:'idle'}`. |
| AuthGate error: `Back` secondary button → ready_to_start | control | ⬜ deferred | `phase4.md P4-15` | Deferred. |
| AuthGate: DEMO setTimeout waiting_for_login → waiting_for_alias (2.2s) | behavior | ✂️ cut | `Startup.jsx:86` (self-labeled DEMO-ONLY) | Real flow blocks on browser callback. Not a gap. |
| AuthGate: DEMO setTimeout success → onComplete (0.8s) | behavior | ✂️ cut | `Startup.jsx:86` (DEMO scripting) | Real completion fires on token write. Not a gap. |
| AuthGate: hardcoded `AUTH_URL` constant | data-binding | 🔁 adapted | `ConsoleOAuthFlow.tsx:38` (`waiting_for_login {url}`) | Mock value → real engine-minted URL; renderer never fabricates. Owner P4-15. |
| ReadOnlyModeGate: full component (pill, GATED/ALLOWED lists, 2 buttons) | subcomponent | ✂️ cut | `decisions/STARTUP-GATES.md §4,§5-Q1`; `phase4.md P4-15` | Restricted mode has no source state; security-semantics feature. Not a gap. |
| WorkspaceSwitchPrompt: full component (blur modal, path panels, 3 buttons) | subcomponent | ✂️ cut | `decisions/STARTUP-GATES.md G4,§4`; HC1 | One-cwd-per-session dissolves it; folds into per-session trust gate. Not a gap. |
| ReauthGate: blocking modal wrapper (fixed inset, z-210, blur) | subcomponent | ✂️ cut | `decisions/STARTUP-GATES.md §5-Q2,G5`; `Startup.jsx:370-388` | Blocking modal CUT; capability survives as non-blocking banner (rows below). |
| ReauthGate reauth_required: red pill + title + body (can't refresh; turns fail) | state | ⬜ deferred | `phase4.md P4-15`; `codexTokenRefresh.ts:449`, `codexAccountPool.ts:620,1128` | Content re-homes into non-blocking banner (`BannerStack.tsx`, P4-1) via P4-5 pool status. |
| ReauthGate reauth_required: dead-account panel (`[Dead]` badge + label + reason) | data-binding | ⬜ deferred | `phase4.md P4-15`; `codexAccountPool.ts:1141`, `accounts.ts:53,63` | Binds P4-5 pool snapshot (`status:'dead'`/`auth_dead`). |
| ReauthGate: REASONS map (expired/invalid_grant/invalid_token/revoked strings) | data-binding | ⬜ deferred | `phase4.md P4-15`; `codexTokenRefresh.ts:211,438` | Reason strings map to real refresh reason (banner copy). |
| ReauthGate: `Re-authenticate` primary button (autoFocus) → waiting_for_login | control | ⬜ deferred | `phase4.md P4-15`; `decisions/STARTUP-GATES.md §3,§5-Q2` | Becomes the banner's re-authenticate action (scoped OAuth). |
| ReauthGate: `Switch to another account` secondary button | control | ⬜ deferred | `phase4.md P4-15`; `codexAccountPool.ts` (`STARTUP-GATES.md §3`) | Failover is pool's job; may fold in (banner non-blocking). |
| ReauthGate: `Dismiss` secondary button | control | ✂️ cut | `decisions/STARTUP-GATES.md §3` (banner persists until acted on) | Modal affordance; banner has no dismiss. Not a gap. |
| ReauthGate waiting_for_login state (spinner + `Continue in your browser` + acct) | state | ⬜ deferred | `phase4.md P4-15`; `ConsoleOAuthFlow.tsx:38` | Reuses shared OAuth waiting UX. |
| ReauthGate success state (`Re-authenticated` pill + `You're back in`) | state | ⬜ deferred | `phase4.md P4-15` | Surfaces as banner clear/toast, not a modal. |
| ReauthGate: DEMO setTimeout timers (login→success 2.2s; success→onReauthed 0.9s) | behavior | ✂️ cut | scripted demo timers; real completes engine-side | Source wins. Not a gap. |
| StartupFlow: phase state machine (trust → auth → done, `setTimeout(onDone,100)`) | behavior | ⬜ deferred | `phase4.md P4-15`; `init.ts` two-phase order | Runs per-session-create, not per-launch (`STARTUP-GATES.md §1.1`). |
| StartupFlow: readonly-info branch (`finishTrust` readOnly + ReadOnlyModeGate mount) | behavior | ✂️ cut | `decisions/STARTUP-GATES.md §5-Q1`; decline=exit | Cut with read-only mode. Not a gap. |
| StartupFlow: localStorage persistence (`readStartupState`/`STARTUP_KEY`) | data-binding | 🔁 adapted | `config.ts:111,188,735-788` (`hasTrustDialogAccepted`); `STARTUP-GATES.md §1.1` | Mock store → engine config (trust) + Accounts domain (auth); no fork. Owner P4-15. |
| Reauth threshold: block submit only when ZERO healthy accounts remain | behavior | ➕ real-added | `decisions/STARTUP-GATES.md §5-Q2,G5`; `client.ts:200,224` | Real-only threshold absent from prototype (which blocks on any death). Owner P4-15, reads P4-5. |
| window global exports + `resetStartup` dev helper | behavior | ✂️ cut | `INVENTORY.md:114` (helper, not a migration surface) | Prototype harness plumbing. Not a gap. |

### 28. ResumeStates.jsx — Resume-flow presentation: HydrationOverlay (load/failed) + CrossProjectResumeDialog over the real synchronous restore machinery

**Migration target:** `app/renderer/src/ResumeDialog.tsx` + `app/renderer/src/resumeDialogState.ts` wired by `app/renderer/src/App.tsx`; built machinery = `app/host/host.ts`, `app/supervisor/supervisor.ts`, `app/sidecar/sessionResume.ts`, `app/sidecar/index.ts`, `app/sidecar/sidecarServer.ts` · **Overall:** 🔁 adapted · **Prototype:** `~/catcode_prototype/cat-app/ResumeStates.jsx` (150 lines) · **INVENTORY:** W5 Resume CrossProjectResumeDialog/HydrationOverlay adapt (S6)

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| HydrationOverlay — overlay backdrop (absolute inset-0, z-30, rgba(9,9,11,0.72) + blur) | chrome | ✅ built | `app/renderer/src/ResumeDialog.tsx:151` | Pure visualization over the real restore round-trip; no engine hydration enum added. |
| HydrationOverlay — centered card (bordered #121214, shadow, max-w 340, border reddens on failed) | chrome | ✅ built | `app/renderer/src/ResumeDialog.tsx:152-157` | Card border keys off the presentation `failed` state only. |
| State gate / 3-state hydration ENUM (loading \| hydrated \| failed) | ux-state | 🔁 adapted | `app/renderer/src/resumeDialogState.ts:12-32`; `app/renderer/src/App.tsx:235-240,629-638,1003-1010` | GUI-only enum collapsed to `confirm`/`hydrating`/`failed`; overlay clears from real restored-session `ready`/`replay:true` frames, with a post-ready no-replay fallback. |
| Loading — pulse-dot spinner (spin 0.8s) | ux-state | ✅ built | `app/renderer/src/ResumeDialog.tsx:192-196` | Tailwind spinner equivalent; presentation-only. |
| Loading — 'Resuming <sessionTitle>…' text | data-binding | ✅ built | `app/renderer/src/ResumeDialog.tsx:197-202`; `app/renderer/src/App.tsx:907-909` | Session title comes from the same live∪restorable registry row projection the Sidebar/palette read. |
| Loading — 'Hydrating transcript from log' subtext | chrome | ✅ built | `app/renderer/src/ResumeDialog.tsx:203-205` | Describes RESTORE-HISTORY replay; no separate transcript reader. |
| Failed — error icon (red circle, alert-circle svg) | chrome | ✅ built | `app/renderer/src/ResumeDialog.tsx:161-164` | Failed-state visualization only. |
| Failed — title 'Couldn't resume session' | chrome | ✅ built | `app/renderer/src/ResumeDialog.tsx:165-168` | Error title retained. |
| Failed — description 'The transcript log failed to deserialize…' | chrome | 🔁 adapted | `app/renderer/src/ResumeDialog.tsx:169-171`; `app/renderer/src/App.tsx:591-599` | Uses real host/sidecar error text when available; prototype corrupt-log copy remains fallback. |
| Failed — 'Retry' button (pink), onRetry | control | ✅ built | `app/renderer/src/ResumeDialog.tsx:174-181`; `app/renderer/src/App.tsx:992` | Retry re-invokes the same real restore path for the same session. |
| Failed — 'Start fresh' button, onDismiss | control | 🔁 adapted | `app/renderer/src/ResumeDialog.tsx:182-188`; `app/renderer/src/App.tsx:621-623` | Dismisses/abandons the failed restore; creating a fresh session remains the existing HC1 native-picker path, not an automatic renderer-authored cwd. |
| Dialog — Escape key → onClose | shortcut | ✅ built | `app/renderer/src/ResumeDialog.tsx:54-62`; `app/renderer/src/ResumeDialog.test.tsx:59-64` | Keyboard action maps to close. |
| Dialog — Enter key → onConfirm | shortcut | ✅ built | `app/renderer/src/ResumeDialog.tsx:54-62`; `app/renderer/src/ResumeDialog.test.tsx:59-64` | Keyboard action maps to confirm. |
| Dialog — backdrop overlay (fixed inset-0, z-90, click → onClose) | chrome | ✅ built | `app/renderer/src/ResumeDialog.tsx:66-70` | z-index adapted to app shell stack; dismiss-on-scrim preserved. |
| Dialog — modal container (role=dialog, aria-modal, sa-pop anim) | chrome | ✅ built | `app/renderer/src/ResumeDialog.tsx:71-76` | Role/aria preserved; animation not separately added. |
| Header — amber warning triangle icon | chrome | ✅ built | `app/renderer/src/ResumeDialog.tsx:78-81`; `app/renderer/src/ResumeDialog.tsx:227-243` | Warning glyph retained for confirm. |
| Header — title 'Resume from a different project?' | chrome | 🔁 adapted | `app/renderer/src/ResumeDialog.tsx:82-85` | Shows the cross-project warning only when the selected row cwd differs from the active tab cwd; otherwise truthful "Resume session?". |
| Header — body copy w/ session.title + 'started in another directory…' | data-binding | 🔁 adapted | `app/renderer/src/ResumeDialog.tsx:86-90`; `app/renderer/src/App.tsx:907-915` | Binds real registry title/cwd; copy says desktop re-spawns the row in its own project, not current cwd. |
| from→to — source ProjBadge (warn tone, source name + path) | sub-component | ✅ built | `app/renderer/src/ResumeDialog.tsx:95-99`; `app/renderer/src/ResumeDialog.tsx:214-228` | Source path is the selected registry row cwd; only renders for a real cwd difference. |
| from→to — arrow icon (source → current) | chrome | ✅ built | `app/renderer/src/ResumeDialog.tsx:97-99`; `app/renderer/src/ResumeDialog.tsx:265-283` | Connector glyph retained. |
| from→to — current ProjBadge (ok tone, 'cat-code' + current path) | sub-component | 🔁 adapted | `app/renderer/src/App.tsx:910-915`; `app/renderer/src/ResumeDialog.tsx:95-99` | Current side is the active tab cwd, because desktop has per-session cwd rather than one global `getOriginalCwd()` UI context. |
| 'What will differ' section label | chrome | ✂️ cut | `app/renderer/src/ResumeDialog.tsx:16-20`; `app/renderer/src/ResumeDialog.test.tsx:24-28` | Cut: engine resume computes no MCP/plugin/permission diff; the prototype section is invented enrichment. |
| Diff row — Working directory (from → to) | data-binding | 🔁 adapted | `app/renderer/src/ResumeDialog.tsx:95-103`; `app/renderer/src/App.tsx:910-915` | Kept as the from→to badge only; no separate diff-list row. |
| Diff row — MCP servers ('project .mcp.json differs') | data-binding | ✂️ cut | `app/renderer/src/ResumeDialog.tsx:16-17`; `app/renderer/src/ResumeDialog.test.tsx:24-28` | Cut: no source-backed MCP diff exists on resume. |
| Diff row — Plugins & agents ('.cat-code/agents + plugin set differ') | data-binding | ✂️ cut | `app/renderer/src/ResumeDialog.tsx:16-17`; `app/renderer/src/ResumeDialog.test.tsx:24-28` | Cut: no source-backed plugin/agent diff exists on resume. |
| Diff row — Permission rules ('project .cat-code/settings.json differs') | data-binding | ✂️ cut | `app/renderer/src/ResumeDialog.tsx:16-17`; `app/renderer/src/ResumeDialog.test.tsx:24-28` | Cut: no source-backed permission-rule diff exists on resume. |
| Diff row template — bullet dot + label(132px) + note/from→to (mono) | chrome | ✂️ cut | `app/renderer/src/ResumeDialog.tsx:16-17`; `app/renderer/src/ResumeDialog.test.tsx:24-28` | Cut with the invented diff list. |
| Copy-command button — `cd <sourcePath> && claude --resume <id>` | control | ✂️ cut | `app/renderer/src/ResumeDialog.tsx:18-20`; `app/renderer/src/ResumeDialog.test.tsx:24-28` | Cut: desktop restore is in-app `host.restoreSession`; TUI escape-hatch command is not a desktop control. |
| Copy-command button — copy icon svg | chrome | ✂️ cut | `app/renderer/src/ResumeDialog.tsx:18-20`; `app/renderer/src/ResumeDialog.test.tsx:24-28` | Cut with the TUI-only copy command. |
| Copy action — clipboard.writeText + toast 'Copied resume command' | control | ✂️ cut | `app/renderer/src/ResumeDialog.tsx:18-20`; `app/renderer/src/ResumeDialog.test.tsx:24-28` | Cut with the TUI-only copy command; no clipboard/toast action added. |
| Copy helper text — 'Open it in its own project… cat-code copies this cd … && --resume' | chrome | ✂️ cut | `app/renderer/src/ResumeDialog.tsx:18-20`; `app/renderer/src/ResumeDialog.test.tsx:24-28` | Cut: desktop already restores via the host plane. |
| Actions — 'Cancel' button (+ 'Esc' hint), onClose | control | ✅ built | `app/renderer/src/ResumeDialog.tsx:107-114`; `app/renderer/src/App.tsx:617-619` | Cancel closes the confirm without attempting restore. |
| Actions — 'Resume here' button (pink, + '⏎' hint), onConfirm | control | ✅ built | `app/renderer/src/ResumeDialog.tsx:115-121`; `app/renderer/src/App.tsx:609-615` | Confirm invokes `performRestore`, the single real `bridge.restoreSession` caller. |
| ProjBadge — folder icon svg | sub-component | ✅ built | `app/renderer/src/ResumeDialog.tsx:219-223`; `app/renderer/src/ResumeDialog.tsx:285-302` | Folder glyph retained. |
| ProjBadge — label (project name, mono, tone-colored) | sub-component | ✅ built | `app/renderer/src/ResumeDialog.tsx:214-224`; `app/renderer/src/pathUtils.ts:7` | Label derives from the real cwd basename. |
| ProjBadge — path (mono, muted, ellipsized) | sub-component | ✅ built | `app/renderer/src/ResumeDialog.tsx:225-227` | Full real cwd path shown on the second line. |
| [BUILT MACHINERY] restore host API — bridge.restoreSession re-spawns engine, transcript replays | behavior | ➕ real-added | `app/renderer/src/App.tsx:576-590`; `app/renderer/src/App.tsx:235-240`; `app/preload/preload.ts:122-128`; `app/main/main.ts:528-534`; `app/host/host.ts:240-305`; `app/sidecar/index.ts:96-141`; `app/sidecar/sidecarServer.ts:282-315` | Reused unchanged: host API validates row/cwd, supervisor passes resume id, sidecar seeds engine and replays `replay:true` history; renderer overlay completion is keyed to the real ready/replay frames, not the host promise alone. |
| [BUILT MACHINERY] restorable-session catalog — registry.restorable() rows the picker draws from | data-binding | ➕ real-added | `app/renderer/src/App.tsx:349-354`; `app/renderer/src/App.tsx:898-909`; `app/renderer/src/sidebarState.ts:64-71` | P4-16 picker reads the same live∪restorable roster as Sidebar/palette; no new read seam. |
| [BUILT MACHINERY] crash vs disconnect surfacing — restorable row tones already in Sidebar | ux-state | ➕ real-added | `app/renderer/src/sidebarState.ts:85-123`; `app/renderer/src/sidebarState.test.ts:93-128` | Existing restore-offer status remains the entry point into the confirm dialog. |

### 29. Welcome.jsx — First-run / empty-session launcher: neon hero + interactive meta strip (Project·Start-in·Branch·Orchestrator) + read-only Codex pool table

**Migration target:** deferred → `P4-17` (Welcome/launcher, D5), sub-owners `P4-15` (trust gate) + `P4-5` (pool data) · **Overall:** ⬜ deferred · **Prototype:** `~/catcode_prototype/cat-app/Welcome.jsx` (522 lines) · **INVENTORY:** W5 WelcomeScreen D5 adapt

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| NeonCat hero image (cat.png) w/ pink glow drop-shadow, size 268 | chrome/visual-asset | ⬜ deferred | `phase4.md P4-17` · `STATUS.md:233` ⬜ | Real app ships cat.png + glow; VISUAL bar. No app file (`grep` empty). |
| NeonCatSVG hand-drawn fallback (renders on img `onError`) | state/asset-missing-fallback | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:7-30,34` | onError fallback UX-state — enumerate so it isn't silently dropped. |
| 'cat code' wordmark H1 (two-tone, `clamp(72px,11vw,140px)`) | chrome | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:459-468` | Responsive hero wordmark. |
| 'Welcome back, pim' greeting (two-tone, username accent) | chrome/data-binding | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:470-473` | ELEMENT deferred; literal 'pim' is a mock (own row) — real binds to engine user. |
| Responsive hero grid (cat col \| content), max-width 1180, top-bordered meta strip w/ vertical dividers | chrome/layout | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:447-489` | Page frame + meta-strip container + 3 dividers. |
| MetaCol subcomponent (icon+label+value) ×4: Project/Start-in/Branch/Orchestrator | subcomponent | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:177-187,482-488` | Four labelled meta columns; Branch column control is CUT (rows below). |
| ProjectValue trigger button (mono path + chevron rotates 180° on open) | control | ⬜ deferred | `phase4.md P4-17` · `WELCOME-LAUNCHER.md:50` | Project picker entry; recents DERIVED (D5). |
| Project dropdown panel w/ 'Recent' section header | chrome | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:236-237` | Dropdown container; no new store (`WELCOME-LAUNCHER.md:72-75`). |
| Recent-project item rows (folder icon + mono path) | control/data-binding | ⬜ deferred | `phase4.md P4-17` · `WELCOME-LAUNCHER.md:16,50` | Derived: registry ∪ `config.ts:188` ∪ `sessionStorage.ts:229`; mock array is own row. |
| Recent-item SELECTED state (pink bg + check icon) | state/selected | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:241,247` | Selected/active project styling. |
| Recent-item HOVER state (subtle white bg) | state/hover | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:242-243` | Hover affordance. |
| 'untrusted' amber badge on untrusted recents | chrome/state | ⬜ deferred | `phase4.md P4-17` · `WELCOME-LAUNCHER.md:50` | Binds to `ProjectConfig.hasTrustDialogAccepted` (`config.ts:111`). |
| Dropdown divider (Recent list / Open-folder) | chrome | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:251` | Visual separator. |
| 'Open folder…' item (plus icon + label + ⌘O hint) | control | ⬜ deferred | `phase4.md P4-17` · `WELCOME-LAUNCHER.md:51` | = HC1 native picker (`phase4.md:871`). |
| ⌘O keyboard shortcut (open folder) | keyboard | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:257` | Shown as hint; wiring is P4-17's. |
| Native folder-picker input (`webkitdirectory`) — real OS dialog | control | 🔁 adapted | `phase4.md P4-17` · `WELCOME-LAUNCHER.md:51` | ADAPTED: browser webkitdirectory/'~/'-hack (`Welcome.jsx:224`) → HC1 Electron native picker returning validated abs path host-side. |
| Click-outside-to-close on Project dropdown | state/behavior | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:200-205` | Dismiss UX. |
| openSignal — /workspace slash cmd opens picker from composer | data-binding/integration | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:207-208` | Cross-surface seam: composer (P4-0) ↔ launcher (P4-17). |
| Recents reorder-on-choose (picked path moves to front) | behavior | 🔁 adapted | `phase4.md P4-17` · `WELCOME-LAUNCHER.md:16` | ADAPTED: local `setRecent` reorder → recency DERIVED from `lastAttachedAt`, no client-held list. |
| Trust modal overlay (fixed inset, blur backdrop, click-out cancels) | chrome/state | ⬜ deferred | `phase4.md P4-15` · `STATUS.md:231` ⬜ | Per-path trust prompt = STARTUP-GATES G1; owned by P4-15 (`WELCOME-LAUNCHER.md:52`). |
| Trust modal close button (X icon, hover style) | control | ⬜ deferred | `phase4.md P4-15` · `Welcome.jsx:295-297` | Modal dismiss. |
| Trust modal shield-icon badge | chrome | ⬜ deferred | `phase4.md P4-15` · `Welcome.jsx:299` | Gate iconography. |
| Trust modal title 'Trust this project?' | chrome | ⬜ deferred | `phase4.md P4-15` · `Welcome.jsx:301` | Mirrors real `TrustDialog.tsx`. |
| Trust modal path chip (folder icon + mono path) | chrome/data-binding | ⬜ deferred | `phase4.md P4-15` · `Welcome.jsx:302-305` | Displays path being trusted. |
| Trust modal description copy | chrome | ⬜ deferred | `phase4.md P4-15` · `Welcome.jsx:306` | Explanatory text. |
| 'Trust project' primary button (↵ kbd) — persists per-path trust | control | ⬜ deferred | `phase4.md P4-15` · `config.ts:111` | Persists to `ProjectConfig.hasTrustDialogAccepted`. |
| 'Open read-only' secondary button (R kbd) — decline/browse-only | control | 🔁 adapted | `phase4.md P4-15` · `WELCOME-LAUNCHER.md:52` | ADAPTED: decline choice survives; ReadOnlyModeGate CUT (D4 Q1, `STATUS.md:231`). Verify P4-15 keeps decline w/o read-only runtime. |
| Read-only footnote copy ('browsing: no edits, tools, or workers until trusted') | chrome/copy | ✂️ cut | `STATUS.md:231` 'read-only mode CUT' · `decisions/STARTUP-GATES.md` D4-Q1 | AUDITOR-ADDED. Describes browse-only mode = CUT (TUI parity); copy has no target. |
| Trust modal keyboard: Enter=trust, Esc=cancel, R=read-only | keyboard | ⬜ deferred | `phase4.md P4-15` · `Welcome.jsx:281-289` | Three-key gate shortcuts (R subject to read-only adaptation). |
| StartInSeg trigger button (current label + rotating chevron) | control | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:342-345` | Start-in selector entry. |
| Start-in option 'Locally / Work in this checkout' | control | ⬜ deferred | `phase4.md P4-17` · `WELCOME-LAUNCHER.md:53` | Only v1-scope option → spawn-config cwd (P3-1). |
| Start-in option 'New worktree / Isolated branch copy' | control | ⬜ deferred | `WELCOME-LAUNCHER.md:54,74` (defer-past-v1, D5/Q2) · `worktree.ts:703` | DEFERRED-past-v1, no P4-N owner; real capability, explicitly ruled — not cut, not missing. |
| Start-in dropdown SELECTED styling (pink bg + check) | state/selected | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:351,357` | Selected-option indicator (for surviving 'Locally'). |
| OrchestratorModeSeg toggle (track + animated thumb, purple glow, On/Off label) | control | ⬜ deferred | `phase4.md P4-17` · `WELCOME-LAUNCHER.md:15` | Binds to real Agent Mode (`src/agent-mode/agentMode.ts`); no own feed. |
| Orchestrator toggle a11y (`role=switch`, `aria-checked`) | a11y/state | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:369` | Accessibility semantics to preserve. |
| BranchValue display + chevron (main / feat/cat-launcher, standalone branch chooser) | control | ✂️ cut | `WELCOME-LAUNCHER.md:55` (W4:14) · `STATUS.md:233` 'branch chooser cut' | CUT: no general branch-start primitive; survives only as worktree name/base input if worktree ships. |
| BranchValue 'NEW' badge (shown on worktree start) | chrome/state | ✂️ cut | `WELCOME-LAUNCHER.md:55` · `Welcome.jsx:405-407` | CUT with branch chooser; reappears only inside a future worktree-launch flow. |
| Codex account-table container (top-bordered, open, no card chrome) | chrome | ⬜ deferred | `phase4.md P4-17` · `WELCOME-LAUNCHER.md:15` | Table frame owned by P4-17; data by P4-5. |
| Account-table header: cube icon + 'Codex' label | chrome | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:502-505` | Section header. |
| Account-table header stats: 'N accounts · M healthy' + green status dot | chrome/data-binding | ⬜ deferred | `phase4.md P4-5` · `STATUS.md:221` (⬜) | Counts derive from real pool status feed (P4-5 read-seam). |
| CodexRow 7-column grid (radio · alias · CAPPED · 5h bar/pct/reset · weekly bar/pct/reset) | subcomponent/chrome | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:147-174` | Per-account row layout; data feed = P4-5. |
| Radio active-account indicator (pink filled dot when active) | chrome/state | ⬜ deferred | `phase4.md P4-5` · `STATUS.md:221` (⬜) | 'active' from P4-5 pool/lease selection. |
| Account alias label | data-binding | ⬜ deferred | `phase4.md P4-5` · `Welcome.jsx:162` | Real alias from pool; FRIENDLY array is a mock (own row). |
| 'CAPPED' badge on capped accounts | chrome/state | ⬜ deferred | `phase4.md P4-5` · `Welcome.jsx:163-165` | Real status from pool, not mock fixture. |
| MiniUsageBar gradient fill (5-hour + weekly usage bars) | chrome | ⬜ deferred | `phase4.md P4-17` · `Welcome.jsx:121-132` | Dual bars; renamed from UsageBar to avoid Surfaces.jsx collision. |
| Usage percent labels (threshold-colored, tabular-nums) 5h + weekly | chrome/data-binding | ⬜ deferred | `phase4.md P4-5` · `Welcome.jsx:168,171` | Color >=100 pink; real values from pool snapshot. |
| Usage reset-time labels (mono) 5h + weekly | data-binding | ⬜ deferred | `phase4.md P4-5` · `Welcome.jsx:169,172` | Real reset windows from pool; mock reset5/reset7 are source-wins. |
| MOCK: WS_RECENT / WS_TRUSTED sets (fixture recents + trust) | mock-data | 🔁 adapted | `WELCOME-LAUNCHER.md:11,16` · `Welcome.jsx:116-117` | SOURCE-WINS: no persisted list upstream; derived — mock correctly dropped, picker ELEMENT carries parity. |
| MOCK: FILL / FRIENDLY codex roster (fixture aliases + usage/reset/status) | mock-data | 🔁 adapted | `STATUS.md:221` (P4-5 pool read-seam, C3) · `Welcome.jsx:416-433` | SOURCE-WINS: mock roster dropped; real table binds to P4-5 snapshot. Not a gap. |
| MOCK: 'pim' username literal in greeting | mock-data | 🔁 adapted | `phase4.md P4-17` · `Welcome.jsx:472` | SOURCE-WINS: greeting ELEMENT deferred (row above); literal replaced with real user. |
| MOCK: 'feat/cat-launcher' / 'main' branch literals | mock-data | ✂️ cut | `WELCOME-LAUNCHER.md:55` (W4:14) · `Welcome.jsx:403` | SOURCE-WINS + CUT: hardcoded strings tied to the cut branch chooser. |
| Ico.doc icon definition (unused on this surface) | dead-code | ✂️ cut | `Welcome.jsx:64-69` (only in own def) | Dead-in-surface icon def — no rendered element; nothing to port. |

### 30. ConnectionDemo.jsx — 18-line demo-harness IIFE that auto-mounts the `ConnectionDemoBar` connection-state simulator; whole surface CUT.

**Migration target:** CUT (survivor: `app/renderer/src/ConnectionChip.tsx`, `app/renderer/src/connectionState.ts`) · **Overall:** ✂️ cut · **Prototype:** `~/catcode_prototype/cat-app/ConnectionDemo.jsx` (18 lines) · **INVENTORY:** INVENTORY CUT: "Exists on disk but is not loaded"

| Element / UX-state | Cat | Disposition | Evidence | Notes |
|---|---|---|---|---|
| Whole surface: `mountConnectionDemo()` auto-mount bootstrap IIFE | surface / bootstrap machinery | ✂️ cut | `INVENTORY.md` CUT row: `ConnectionDemo.jsx` "Exists on disk but is not loaded by `CatCode Web App.html`" | Demo harness that self-mounts `ConnectionDemoBar`; not a product surface. |
| `tryMount()` guard `if (!window.ConnectionDemoBar) return;` | bootstrap machinery | ✂️ cut | `INVENTORY.md` CUT row `ConnectionDemoBar` / connection demo state machine "Loaded demo simulator" | Wiring keyed off the cut `ConnectionDemoBar` global; nothing to migrate. |
| Injected DOM root `<div id="__conn-demo-root">` appended to `document.body` | DOM injection | ✂️ cut | `INVENTORY.md` CUT (`ConnectionDemo.jsx` not loaded) | Prototype-only floating overlay mount point; no `__conn-demo-root` in `app/renderer/src`. |
| `ReactDOM.createRoot(...).render(ConnectionDemoBar)` — mounts the simulator | bootstrap / render call | ✂️ cut | `app/renderer/src/ConnectionChip.tsx:6` "`ConnectionDemoBar` ... are CUT (INVENTORY CUT list)"; `INVENTORY.md` "cut `ConnectionDemoBar` simulator" | Renders the cut simulator; real app has no floating connection panel. |
| Deferred-mount timing: `readyState==='complete' ? setTimeout(200) : 'load' listener + setTimeout(200)` | bootstrap / timing | ✂️ cut | `INVENTORY.md` CUT (not loaded); header comment "Loaded last in v6.html so all window exports are available" | Load-order hack for the demo page's global exports; no product equivalent. |
| Mounted panel: `ConnectionDemoBar` floating fixed bar (bottom-left, z-190) | rendered sub-component | ✂️ cut | `INVENTORY.md` CUT row `ConnectionDemoBar`; `ConnectionChip.tsx:6` documents it CUT; body `Surfaces.jsx:1197-1258` | Floating simulator chrome is a prototype dev tool, not product UI. |
| Simulator control: 4-state cycle buttons \[connected / reconnecting / disconnected / reconnect_failed\] | interactive control | ✂️ cut | `Surfaces.jsx:1198` CYCLE + `:1237-1256`; `INVENTORY.md` CUT "connection demo state machine" | MOCK state-scrubber; "source wins" — real state driven by `connectionState.ts`, not buttons. |
| Simulator data: `MOCK_CONNECTION` global + fake backoff countdown (8→0 via 1s timer) + green-dot indicator | mock data / scripted timer | ✂️ cut | `Surfaces.jsx:1205-1210` backoff, `:1216` `MOCK_CONNECTION`; `ConnectionChip.tsx:6` names `MOCK_CONNECTION` CUT | MOCK fixture + scripted timer; real transport has no backoff global (`ConnectionChip.tsx` divergence note). |
| Simulator control: collapse/expand toggle (× → "conn demo" pill and back) | interactive control | ✂️ cut | `Surfaces.jsx:1221-1223` collapsed pill, `:1257` × close; panel cut per `INVENTORY.md` | Show/hide affordance for the demo overlay; no product overlay to collapse. |
| Real connection UX (survivor): `ConnectionChip` rendering real per-session `ConnectionSnapshot` with `CONN_STATES` vocabulary | real-only capability | ➕ real-added | `app/renderer/src/ConnectionChip.tsx:1-14`; backed by `app/renderer/src/connectionState.ts` | Recorded so ledger shows connection UX was NOT lost — engine-driven chip inline in TabBar/SessionPane, only the simulator wrapper dropped. |

---

## Part B — Cross-surface flows (8)

Each flow is traced step-by-step through the prototype and the real app (renderer → host →
sidecar → engine). A flow-level ❓ is a transition the prototype performs that the real app
drops with no owner.

### FLOW-1. First run: trust → OAuth → welcome

**Surfaces:** `Startup.jsx` + `Welcome.jsx` (prototype) → P4-15 (`Startup`) / P4-17 (`Welcome`) deferred; real machinery: `src/utils/config.ts` trust, `src/components/ConsoleOAuthFlow.tsx` OAuth union, `app/host` registry (HC1 picker), `app/renderer/src/BannerStack.tsx`; rulings D4 (`STARTUP-GATES.md`) / D5 (`WELCOME-LAUNCHER.md`) · **Overall:** ⬜ deferred

| Step / transition | Prototype | Real app | Disposition | Evidence | Notes |
|---|---|---|---|---|---|
| Real first-run path (what happens today) | no analog — prototype always gates | launch → `host.createSession` (HC1 cwd token) → `EmptyShell`; no trust/OAuth/welcome gate | ➕ real-added | `app/renderer/src/App.tsx:905` (`EmptyShell`); grep of `app/renderer/host/main/sidecar/preload` finds zero `TrustGate/OAuthStatus/WelcomeScreen` refs | The real first run has NO gate stack; per-session-create trust + first-run OAuth are the design (D4), not yet wired. Die-with-window (D6) → no persisted startup state to replay. |
| Launch reads `localStorage` `catcode.startup.v1`, picks phase trust/auth/done (one-time per app-launch) | `Startup.jsx:461-489` `StartupFlow` + `STARTUP_KEY` | not built; no per-launch gate | 🔁 adapted | Ruling: trust is per-SESSION-CREATE not per-app-launch — `docs/migration/decisions/STARTUP-GATES.md` §1.1; owner P4-15 (`STATUS.md:231`) | Prototype gates once per launch via localStorage; real design gates per session-create against the engine's own trust store (no forked desktop store, no persisted startup state given D6). |
| TrustGate screen — "Trust this workspace?", path code block, "Trust workspace" / "Open read-only" buttons, Trust·Sign-in step dots | `Startup.jsx:27-61` | engine trust machinery real; GUI gate unbuilt | ⬜ deferred | `src/utils/config.ts:111` `hasTrustDialogAccepted`, `:735` `checkHasTrustDialogAccepted`, `:788` `isPathTrusted`; owner P4-15 (`STATUS.md:231`); ruled adapt `STARTUP-GATES.md` G1 | Real machinery adapt, desktop GUI surface unbuilt. Deferred P4-15. |
| Trust accepted → `writeStartupState(trusted)` → advance to auth phase | `Startup.jsx:468-472` `finishTrust` | no transition yet | ⬜ deferred | Owner P4-15 (`STATUS.md:231`) | Part of the unbuilt P4-15 gate sequence. |
| Trust declined → ReadOnlyModeGate — gated list, still-available list, "Continue in read-only" / "Trust instead" | `Startup.jsx:288-336` | none — decline = exit (TUI parity) | ✂️ cut | `STARTUP-GATES.md` G3 / §5-Q1 (TUI parity); `STATUS.md:231` "read-only mode CUT (Q1 TUI parity)" | Read-only-but-open is invention on the permission plane; cut v1. Its "Open read-only" button is dead in the real flow. |
| AuthGate `ready_to_start` — "Sign in with Codex" card, provider row, "Open browser to sign in" | `Startup.jsx:98-127` | real OAuth union; no GUI login surface | ⬜ deferred | `src/components/ConsoleOAuthFlow.tsx:35` (`ready_to_start`); ruled adapt `STARTUP-GATES.md` G2; owner P4-15 (`STATUS.md:231`) | First-run OAuth entry; real state machine, unbuilt desktop surface. |
| AuthGate `waiting_for_login {url}` — spinner, paste-code fallback with auth URL, "Cancel" | `Startup.jsx:187-227` + demo timer `:86-91` | real callback-blocking state | ⬜ deferred | `src/components/ConsoleOAuthFlow.tsx:38` (`waiting_for_login{url}`); owner P4-15 (`STATUS.md:231`) | Prototype's `setTimeout` OAuth dance is mock; real flow blocks on the browser callback. Mechanism real, surface deferred. |
| AuthGate `waiting_for_alias` — Codex "Name this account" alias input, Enter/Continue | `Startup.jsx:129-159` | real Codex alias step | ⬜ deferred | `src/components/ConsoleOAuthFlow.tsx:48` (`waiting_for_alias{codexTokens}`); owner P4-15 (`STATUS.md:231`) | Codex-only union member; GUI deferred P4-15. |
| AuthGate `error` — "Sign-in didn't complete", error code, "Retry" / "Back" | `Startup.jsx:161-185` | real retryable error state | ⬜ deferred | `src/components/ConsoleOAuthFlow.tsx:55` (`error{message,toRetry}`); owner P4-15 (`STATUS.md:231`) | Retryable OAuth failure state; real, deferred. |
| AuthGate `success` → checkmark → phase done → main app mounts | `Startup.jsx:92-96,477-481` `finishAuth` | real success state | ⬜ deferred | `src/components/ConsoleOAuthFlow.tsx:51` (`success`); owner P4-15; after first-run auth moves to Accounts P4-5 (`STARTUP-GATES.md` §1.2) | Adapted transition: prototype auths every first-run; real is first-run-only, then P4-5 Accounts owns credentials. |
| StartupShell chrome — cat-code logo header, Trust·Sign-in step-dot indicator, centered card | `Startup.jsx:233-271` | unbuilt | ⬜ deferred | Owner P4-15 (`STATUS.md:231`); visual bar `phase4.md:790` | Shared gate chrome; deferred P4-15 (visual-fidelity bar Step 1). |
| Startup complete → WelcomeScreen mounts — neon-cat hero, "cat code" wordmark, "Welcome back" | `Welcome.jsx:413-491` | `EmptyShell`, no Welcome surface | ⬜ deferred | Owner P4-17 (`STATUS.md:233`); real app `app/renderer/src/App.tsx:905` | Whole Welcome launcher unbuilt; deferred P4-17 (dep P4-5, P4-15). |
| Welcome meta-strip Project picker — recents dropdown, per-path untrusted badges, "Open folder…" + ⌘O | `Welcome.jsx:192-275` `ProjectValue` | unbuilt | ⬜ deferred | Recents ruled DERIVED (registry ∪ engine history, no store) `WELCOME-LAUNCHER.md` W2/W6; owner P4-17 (`STATUS.md:233`) | Prototype `WS_RECENT`/`WS_TRUSTED` are mock; recents are derived per D5. |
| TrustProjectPrompt — in-picker per-path trust modal, "Trust this project?", Trust/Open read-only/Cancel, Enter/Esc/R | `Welcome.jsx:280-322` | unbuilt | ⬜ deferred | Same gate as `STARTUP-GATES.md` G1 (`config.ts:111`); `phase4.md:871` "trust prompt in picker = P4-15's gate"; owner P4-17 | Reuses P4-15's per-path trust gate inside the launcher; its "Open read-only" branch still follows the D4 Q1 read-only CUT. |
| "Open folder…" native folder picker (`webkitdirectory`) | `Welcome.jsx:218-226` `onFolderPicked` | real `host.pickDirectory` → one-time realpath token | ⬜ deferred | HC1 native picker `STATUS.md:155` (P3-3 B1/B2); `WELCOME-LAUNCHER.md` §3; owner P4-17 | Real-added divergence: real picker returns a token bound to a main-validated realpath (never a path string), stronger than `webkitRelativePath`. Surface deferred. |
| "Start in" segment — Locally / New worktree dropdown | `Welcome.jsx:324-365` `StartInSeg` | unbuilt | ⬜ deferred | "Locally" = spawn cwd `WELCOME-LAUNCHER.md` §3 (adapt); "New worktree" DEFERRED pending operator W3/§4-Q2; owner P4-17 | "Start locally" deferred P4-17; "New worktree" is real (`worktree.ts`) but new desktop scope, deferred by D5 Q2. |
| "Branch" value — main / feat branch with "new" badge | `Welcome.jsx:398-411` `BranchValue` | none | ✂️ cut | `WELCOME-LAUNCHER.md` W4/§3 (no general branch-start primitive); `STATUS.md:233` "branch chooser deferred/cut" | Cut as standalone; survives only as worktree name/base input if the deferred worktree launch ships. |
| Orchestrator mode toggle in meta strip | `Welcome.jsx:367-396` `OrchestratorModeSeg` | real Agent Mode; launcher toggle unbuilt | ⬜ deferred | Backed by `src/agent-mode/agentMode.ts`; `WELCOME-LAUNCHER.md` W5; owner P4-17 (`STATUS.md:233`) | Real Agent Mode toggle; launcher surface deferred. |
| Codex account table header — N accounts · M healthy · green status dot | `Welcome.jsx:493-512` | unbuilt | ⬜ deferred | Pool status produced by P4-5 (`STATUS.md:221` "Produces pool status for P4-15/P4-17"); table owner P4-17 (`STATUS.md:233`, dep P4-5) | Depends on unstarted P4-5 pool-status producer; deferred P4-17. |
| CodexRow — active radio, alias, CAPPED badge, 5h usage bar+%+reset, weekly bar+%+reset | `Welcome.jsx:147-175` `CodexRow` | unbuilt | ⬜ deferred | Real usage/health from Codex pool (`codex-core/codexAccountPool.ts`, via P4-5 snapshot); owner P4-17 (`STATUS.md:233`) | Prototype FILL usage values are MOCK ("source wins"); real bars bind to P4-5 pool snapshot. Deferred P4-17. |
| WorkspaceSwitchPrompt — mid-session "workspace changed, trust?" modal | `Startup.jsx:339-368` | none — one-cwd-per-session dissolves it | ✂️ cut | `STARTUP-GATES.md` G4; `STATUS.md:231` "`WorkspaceSwitchPrompt` CUT" | No mid-session workspace switch in the N-process model; a new-cwd session runs G1 at its own create time. |
| ReauthGate — blocking mid-session modal on Codex token death (`reauth_required`/`dead`) | `Startup.jsx:389-458` (GUI-ONLY `:386`) | signal real; blocking modal redesigned to non-blocking banner | ✂️ cut | `STARTUP-GATES.md` G5/§3/Q2; `STATUS.md:231` "non-blocking reauth banner (Q2, block submit only at zero-healthy)"; `BannerStack.tsx:5-7` built-but-unwired | Signal real (`reauth_required`→`dead`/`auth_dead`), blocking gate invented. Non-blocking banner: host primitive built (P4-1), derivation from P4-5 pool status deferred to P4-15. |
| `resetStartup()` dev helper (localStorage clear + reload) on `window` | `Startup.jsx:489` | none | ✂️ cut | Dev/demo-only harness; die-with-window (D6) leaves no startup state to reset | Dev-only escape hatch tied to the mock localStorage gate; no parity target. |

### FLOW-2. Session lifecycle: create → run → close → restore → crash

**Surfaces:** prototype `AppV2.jsx` / `TabBar.jsx` / `Sidebar.jsx` / `ResumeStates.jsx` · real `App.tsx`, `shellState.ts`, `tabStatus.ts`, `sidebarState.ts`, `app/host/host.ts`, `app/host/registry.ts`, `app/sidecar/sessionController.ts`, `app/sidecar/sessionResume.ts` · **Overall:** ➕ real-added (a durable two-plane persistence/restore/crash spine over a prototype that only mocks tabs; one parked bug CC-2)

| Step / transition | Prototype | Real app | Disposition | Evidence | Notes |
|---|---|---|---|---|---|
| CREATE · invoke new session (⌘T / TabBar "+" / EmptyShell button / palette) | `handleAddTab` mints `new-${Date.now()}`, pushes to `openTabs`; ⌘T chord | `newSession()` async; ⌘T; TabBar `onNewTab`; EmptyShell button; palette handler | ✅ built | `App.tsx:393` · ⌘T `App.tsx:720-724` · TabBar `App.tsx:872` · EmptyShell `App.tsx:905,938` · palette `App.tsx:834` | Same ⌘T/"+" affordances (proto `AppV2.jsx:154,115`). |
| CREATE · pick working directory (HC1 cwd one-time token) before spawn | absent — proto ids carry no cwd | `bridge.pickDirectory` → `cwdToken` → `createSession({cwdToken})`; host re-validates cwd | ➕ real-added | `App.tsx:396-399` · host revalidate `host.ts:199-215` | Real-only HC1 boundary: renderer never authors a path; proto sessions have no cwd at all. |
| CREATE · draft "New chat" tab + promote-to-real on first message | persistent `DRAFT_ID` row; `handleMessagesChange` promotes draft→real | no draft tab (an un-cwd'd session can't exist); EmptyShell invites create instead | ⬜ deferred | proto `AppV2.jsx:92,107,188-195` · real `App.tsx:905,932` | Owner: **P4-17** Welcome/launcher (`backlog/phase4.md:855`, D5). |
| CREATE · spawn engine, registry row, emit `session-added` → tab appends at end | `openTabs` push (in-memory string array) | `upsertOnSpawn` mints live row → emit `session-added`; `reduceShellState` appends id + grants tab | ➕ real-added | `registry.ts:574` · `host.ts:373` · `shellState.ts:52-62,109-117,148` | Durable registry index + HostEvent-driven roster; proto just pushes a string. |
| CREATE · fill `engineSessionId` on the ready frame (two-id model) | absent — single opaque id | `fillEngineSessionId` on ready frame; controller mints/echoes engine id | ➕ real-added | `registry.ts:633` · `sessionController.ts` (createRuntimeBacked…) | Locked two-id model: `appSessionId` address ↔ `engineSessionId` transcript key. |
| RUN · submit prompt to the live engine | `handleMessagesChange` appends mock messages | `submitSession` → `bridge.submit`, guarded by `inputEnabled` + connection | ✅ built | `App.tsx:579-604` · guard `App.tsx:588-592` | Proto is mock append; real app drives the actual engine turn. |
| RUN · stream `AppSessionEvent` frames → transcript / raw / connection / permission / settings / goals | absent (mock) | `bridge.subscribe` fan-out to 7 dispatchers; `projectServerFrame` | ✅ built | `App.tsx:216-222` | Raw `AppSessionEvent` over the wire (locked no-lossy-mapper), read-time projection. |
| RUN · background tab keeps streaming without stealing focus; pending-permission badge on inactive tab | absent (single-panel focus mock) | frame path refuses to steal focus off a live tab; per-tab attention badge | ➕ real-added | focus guard `App.tsx:207-215` · badge `tabStatus.ts:97-104` wired `App.tsx:307-322` | N-process — each tab a live session slice; proto has no concurrent live sessions. |
| CLOSE · invoke (tab × / ⌘W / palette Close) | `handleTabClose` filters `openTabs`; ⌘W is `handleRemovePanel` (panel-remove, not tab-close) | `closeTab` → `closeSession`; ⌘W closes active tab; palette `closeActiveSession` | ✅ built | `App.tsx:530-546` · ⌘W `App.tsx:725-730` · palette `App.tsx:835` | Proto ⌘W removes a workspace PANEL (`AppV2.jsx:116`); real ⌘W closes the tab — minor chord-semantics divergence. |
| CLOSE · non-destructive: `markClean`, row KEPT restorable, `session-status(exited,restorable)` revokes tab membership | destructive: filters `openTabs`, session gone | `closeSession` → `markClean` (row kept) + status exited/restorable; reducer drops tab | 🔁 adapted | `host.ts:382-399` · `registry.ts:690` · `shellState.ts:118-123,170-174` | Behavior DIFFERS: proto close destroys the session (`AppV2.jsx:145-152`); real close = restore-offer. Per D6/REGISTRY (close ≠ delete). |
| CLOSE · focus moves to neighbour live tab, or EmptyShell when none remain | repoints panel to `remaining[0]` or DRAFT "New chat" welcome | `activeAfterLiveChange` → first live tab or null; null → EmptyShell | 🔁 adapted | `shellState.ts:183-190` · effect `App.tsx:291-299` · EmptyShell `App.tsx:905,932` | Proto falls to a draft-welcome (`AppV2.jsx:149-151`); real app falls to a bare EmptyShell (draft deferred, P4-17). |
| CLOSE · closed row surfaces in the Sidebar as a restorable restore-offer (label "closed") | absent — static `MOCK_SESSIONS` (title/time/preview only) | `selectSidebarRows` renders full roster; exited→kind:restorable/label:"closed"/tone:dead | ➕ real-added | `sidebarState.ts:64-72,112-115` · wired `App.tsx:856-862` | Proto Sidebar has no live/closed/restorable status concept. |
| RESTORE · invoke from Sidebar restore-offer / palette | re-opens a static mock id (`handleSessionSelect` re-adds to `openTabs`) | `restoreSession` → `bridge.restoreSession`; Sidebar `onRestore`; palette `restoreSession` | ✅ built | `App.tsx:558-577` · Sidebar `App.tsx:862` · palette `App.tsx:847` | Proto "restore" is a mock re-add (`AppV2.jsx:181-186`); no engine involvement. |
| RESTORE · re-spawn through the engine's REAL resume machinery (transcript deserialize + id adoption + `initialMessages` seed) | demo overlay only (scripted timer) | `host.restoreSession` = create with row cwd + engineSessionId; sidecar `resumeEngineSession` runs `loadConversationForResume` + `processResumedConversation` w/ `sessionIdOverride` | ✅ built | `host.ts:233-268` · `sessionResume.ts:64-113` | Reuses the engine's actual --resume path (CLAUDE.md rule 1/10). Anti-Potemkin: unresumable id THROWS (`sessionResume.ts:72-78,102-110`). |
| RESTORE · prior transcript replays into the pane (replay F1 seed + F2 replay frames) | absent (mock messages are static) | restore path emits replay frames consumed by `transcriptProjector` | ✅ built | `App.tsx:558-563` (doc-comment RESTORE-HISTORY F1/F2) · projector wired `App.tsx:222` | Real-only history rehydration into the projected transcript. |
| RESTORE · restored row rejoins the TabBar — ORDERING (row moves to END on restore) | `openTabs` append on open (`AppV2.jsx:183`) | `reorderOnArrival` moves a row that regains tab membership to END of `order` | 🔁 adapted | `shellState.ts:141-152` · CC-2 `STATUS.md:25` | **KNOWN BUG CC-2:** operator spec = a row must NEVER move on restore/open, only on message-send — needs a last-activity signal absent from `SessionDescriptor` today. Two 2026-07-07 fixes insufficient; parked, owner TBD. Neither world matches the target spec. |
| RESTORE · hydration loading / failed overlay | `HydrationOverlay` loading/failed — DEMO-only GUI states | `HydrationOverlay` over real restore attach/replay frames; failed state shows real host/sidecar error text | ✅ built | `ResumeDialog.tsx:135-211` · frame gate `App.tsx:235-240,629-638,1003-1010` | P4-16 built the overlay as presentation only: no engine hydration enum, no transcript reader, no new wire vocabulary. |
| RESTORE · cross-project resume confirm dialog (resume from a different directory) | `CrossProjectResumeDialog` — DEMO-only, fired from Diagnostics | `ResumeConfirmDialog` confirms a restorable row before `host.restoreSession`; cross-project warning only for a real cwd difference | 🔁 adapted | `ResumeDialog.tsx:40-125` · invoke path `App.tsx:609-616,1024-1031` · real in-cwd restore `host.ts:240-305` | Desktop restores in the row's own cwd (D1 one-cwd-per-session); invented diff list remains cut. |
| SESSION-IDENTITY · row/tab shows a human title | `MOCK_SESSIONS` carry mock titles | app sessions have no generated title → cwd-basename fallback across close/restore | ⬜ deferred | proto `Sidebar.jsx` mock rows · real fallback (P4-4 note) | Owner: **P4-6 rider** — titles gap parked explicitly in `STATUS.md:220` (P4-4 note). Not a dropped element, a deferred capability. |
| CRASH · sidecar death detected at runtime → `markCrashed` → `session-status(disconnected,restorable)` | absent — no process/crash concept | crash path `markCrashed` on supervisor exit/failed; transitions only live rows | ➕ real-added | `host.ts:167-187` · `registry.ts:674` · `sidebarState.ts:104-111` | Proto's connection state-machine is a scripted demo (see cut row); real app has genuine crash detection. |
| CRASH · dead tab is KEPT for restart-in-place (not removed from the bar) | absent | `foldTabMembership` keeps membership for restorable+disconnected; tab renders dead+restartable | ➕ real-added | `shellState.ts:118` · `selectLiveSessions` `shellState.ts:170-174` · `tabStatus.ts:81-85` | The crashed row is BOTH a live-bar dead tab AND a Sidebar "crashed" offer (P3-5b parity descriptor). |
| CRASH · restart-in-place (CH_RESTART) from the dead tab / ConnectionRecovery button / palette | demo "Retry" banner only | `restartTab` → `bridge.restart`; `host.restartSession` bumps `restartCount`, refreshes advisory fields | ➕ real-added | `App.tsx:548-556` · `host.ts:447-478` · palette `App.tsx:838` | Real re-spawn over the existing restart channel; refresh keeps the D6 crash-reap identity match valid. |
| CRASH · same crashed row also shown as a Sidebar "crashed" restore-offer | absent | `deriveSidebarRowVisual` disconnected+restorable→label "crashed"/tone dead | ➕ real-added | `sidebarState.ts:104-111` | Distinct from a live socket-drop (restorable:false → "disconnected", not "crashed"). |
| CRASH · launch-time orphan sweep for a prior-run crash (shutdown==null rows → crashed, kill orphan sidecar) | absent — no persistence across reloads | `launch` → `sweepOrphans` marks unmarked live rows crashed + kills identity-matched orphans; reap drops dead rows | ➕ real-added | `registry.ts:388,455-497,498-541` | Cross-launch crash recovery; restore-offer rows returned by `restorable()` (`registry.ts:552-556`). |
| CRASH · connection transport demo (reconnecting / disconnected / reconnect_failed banners) | `setMockConnection` scripted state-machine | replaced by genuine transport states in `connectionState.ts` (surfaced via ConnectionRecovery) | ✂️ cut | INVENTORY CUT `INVENTORY.md:108,113` · proto `AppV2.jsx:220,207-253` | Scripted banners are cut demo scaffold; the real diagnostics/chips migrate, the simulator does not. |
| LIFETIME · die-with-window on quit (D6): `shutdownAll` marks every live row clean synchronously | browser mock — closing the tab loses nothing durable | `host.shutdownAll` → `markLiveCleanSync` (one sync write on window-all-closed/before-quit), rows kept restorable | ➕ real-added | `host.ts:482-491` · `registry.ts:715-734` | Locked decision D6 v1 (via supervisor.shutdown, not process welding). |
| LAUNCH · hydrate the roster from the registry (`listSessions`) + fold restore-offer rows; subscribe-before-snapshot | boots from static `MOCK_SESSIONS` + hardcoded `openTabs` | subscribe FIRST (F3) then `listSessions`; hydrate folds baseline without clobbering live events | ➕ real-added | `App.tsx:237-278` · restorable order `registry.ts:552-556` | Shell reconstructs its tab/offer roster from durable state on launch; proto has none. |

### FLOW-3. Permission round-trip

**Surfaces:** Permissions.jsx (PermissionQueue/AskQuestionFlow) + Chat.jsx composer → `app/renderer/src/PermissionQueue.tsx` · `PermissionPrompt.tsx` · `permissionState.ts` · `PermissionRulesEditor.tsx` · `App.tsx` → `app/sidecar/sidecarServer.ts` · `permissionDomain.ts` → `src/app-runtime/AppSessionController.ts` · `appRuntimeCanUseTool.ts` · decisions/PERMISSION-BOUNDARY.md (C1–C4) · S2 spec · T5a/T6/T6b · **Overall:** 🔁 adapted

| Step / transition | Prototype | Real app | Disposition | Evidence | Notes |
|---|---|---|---|---|---|
| Engine gates a tool → `permission.requested` minted with engine requestId + `permission_suggestions` | queue insert (mock item) | controller mints request, copies engine suggestions, raw frame over socket | ✅ built | `src/app-runtime/appRuntimeCanUseTool.ts:62-74`; PERMISSION-BOUNDARY.md:35 | Suggestions come from the engine, not client guessing; no lossy mapper (P1-0). |
| Frame reduced into per-session pending queue (keyed by requestId, arrival order, dedupe on insert, NO timeout) | client queue | `reducePermissionState` inserts into `pending[]` | ✅ built | `app/renderer/src/permissionState.ts:174-191`; selector :214-225 | S2 §1–§2: parallel tool calls → multiple simultaneous pendings; "keep pending" = do nothing. |
| Queue ORDERING: strict lane-priority head-of-queue vs arrival-order | one head card by lane (sandbox›tool›prompt›worker›elicit) | all active cards, arrival order | 🔁 adapted | proto `Permissions.jsx:49-58,349-352`; real `permissionState.ts:214-225`, doc `PermissionQueue.tsx:4-12` | Deliberate per S2 §2 (arrival-ordered, no timeout). Not a silent drop. |
| Queue PRESENTATION: inline portal modal pinned to composer box vs inline stacked cards | `createPortal` + composer-rect alignment | plain flex column mounted after the composer form | 🔁 adapted | proto `Permissions.jsx:434-441`; real `PermissionQueue.tsx:29-47`, `App.tsx:1101` | Same information, flatter presentation; no floating modal / rect measuring. |
| Pending-count indicator ("N pending") | header count pill | text line above the stack (only when >1) | ✅ built | `PermissionQueue.tsx:31-35` | Prototype shows it in the card header (:452-456). |
| Per-tab background attention badge for pendings in non-active sessions | — | `selectPendingPermissionCount` → TabBar pulse | ➕ real-added | `permissionState.ts:250-259`; consumed `App.tsx:306-320` | Single-window prototype has no equivalent (P3-5a). |
| Generic card render (title / display_name, decision_reason, blocked_path, JSON input dump) | — | one tolerant card off the engine request shape | ✅ built | `PermissionPrompt.tsx:80-131` | Renders any variant from the engine's own request shape. |
| Rich per-variant card chrome (bash inline-cmd, file-edit diff, sandbox network card, worker relay, classifier/warn badges) | PV table + PQDiff / network / inlineCmd branches | single generic `JSON.stringify(input)` pre-block | 🔁 adapted | proto `Permissions.jsx:60-76`; real `PermissionPrompt.tsx:129-131` | Source-justified down-scope; client `ruleImplication` guesser CUT (S2 §7). Diff/network/inline visuals not reproduced — a real VISUAL simplification, flagged. |
| Allow-once (Enter / Allow button) → allow with empty selection | "Yes" option | `onAllow([])` → `buildAllowResponse` | ✅ built | `PermissionPrompt.tsx:118-125`, `App.tsx:643-658`, `permissionState.ts:277-288` | TUI-parity allow-once = `applySuggestions []`. |
| Always-allow (C1 suggestion SELECTION by index, engine-minted rule rendered) | "Yes, don't ask again for &lt;scope&gt;" (client-guessed) | `describeSuggestion` + `onAllow([index])`; sidecar validates + re-attaches engine update | ✅ built | `PermissionPrompt.tsx:133-148`; sidecar `sidecarServer.ts:672,1282` | Renderer never authors rule content (T6b intact, PERMISSION-BOUNDARY §2). |
| Deny with model-visible feedback (N/⌫ / Deny button + input) | reject option | `onDeny(denyMessage)` → `buildDenyResponse` (message required) | ✅ built | `PermissionPrompt.tsx:110-117,150-157`, `App.tsx:660-666`, `permissionState.ts:294-302` | Maps prototype's "No, tell Cat Code what to do differently". |
| Esc → LOCAL snooze + "Snoozed … (still pending) [Answer]" restore row | Esc = reject current request | Esc = local snooze; card stays pending engine-side, re-openable | 🔁 adapted | `App.tsx:688-694` dispatch `dismissed`; `permissionState.ts:75-98`; `PermissionQueue.tsx:49-67` | Semantic shift: prototype Esc rejects; real Esc snoozes (non-destructive). |
| Keyboard interaction model overall | ↑↓ / j/k / ⌃P⌃N / 1-9 / Enter / Esc select-list | Enter=allow, N/⌫=deny, Esc=snooze on first visible pending | 🔁 adapted | real `PermissionPrompt.tsx:14-22` + `App.tsx:640-704`; proto `Permissions.jsx:382-402` | No multi-option cursor list (discrete buttons instead), so arrow/number nav + ⌃P/⌃N chords not reproduced. |
| "Keep pending →" hide-modal + composer "N pending · review →" reopen badge | Keep pending → + composer chip | no modal to hide; snooze + tab count badge cover the intent | 🔁 adapted | proto `Permissions.jsx:591-592`; real snooze (`PermissionQueue.tsx:49-67`) + `selectPendingPermissionCount` | Modal-level keep-pending N/A: real cards are inline and always visible. |
| "Reject all" / abort-the-turn mass-deny button | "Reject all" (pending&gt;1) | — (no renderer caller; `app.abort` preload channel exists, unused) | ❓ missing-no-owner | proto `Permissions.jsx:593`; channel `app/preload/preload.ts:63`; PERMISSION-BOUNDARY §5:299-301 (C4) | C4 rules `app.abort` AS the mass-deny mechanism, but no UI button is wired and no P4-N owns a Stop/Reject-all control. Mechanism is one line from working. |
| Send response transport: renderer → `bridge.respondPermission` → preload → main coerce → sidecar | — | IPC round-trip with fail-closed coercion | ✅ built | `App.tsx:1197-1209` `sendPermissionResponse`; `sendPermissionResponse` export `App.tsx` bottom; preload `preload.ts` | Main drops a malformed `applySuggestions` whole rather than downgrade always→once. |
| Sidecar boundary: T5a pending lookup → C1 `validateSuggestionSelection` → T6/T6b sanitize → re-attach engine updates → resolve | — (no boundary in mock) | `handlePermissionResponse` full validation spine | ✅ built | `sidecarServer.ts:642-703`; `checkStrictKeys:1133-1147`; `validateSuggestionSelection:1282` | Renderer bytes never become rule content; `updatedPermissions` attached only from the engine's own pending suggestions (`structuredClone`). Boundary tests in `sidecarServer.test.ts`. |
| Engine applies + persists updates → `permission.resolved` echo → card removed UNIVERSALLY | local queue shift | `respondToPermissionRequest` → reducer `removeRequest` on any window/surface/abort | ✅ built | `sidecarServer.ts:703` → `src/app-runtime/AppSessionController.ts:87-100`; `permissionState.ts:193-199` | Universal dismiss — real-added robustness over single-window prototype. |
| Session lifecycle / restart empties the pending queue | — (no lifecycle reset) | `lifecycle` frame resets session permission state; `ready` rebuilds from engine snapshot | ➕ real-added | `permissionState.ts:112-138` (ready), `:154-160` (lifecycle) | Queue reconciles to the engine's authoritative pending snapshot; local flags survive only for still-pending ids. |
| Mode switch (C2 `permission.setMode`: default/acceptEdits/plan/dontAsk; bypassPermissions rejected) | plan-exit mode radios | explicit rules-editor mode buttons → `permission.setMode` frame | ✅ built | `PermissionRulesEditor.tsx:39-65`; `App.tsx:800-810` `setPermissionMode`; `sidecarServer.ts:567-630`; `permissionDomain.ts:48-59` | `bypassPermissions`/auto excluded (PERMISSION-BOUNDARY §3). |
| Rules-editor READ path (C3 `permission.context` snapshot: allow/deny/ask rules + dirs) | "Manage rules →" card link | read-only `<details>Permissions</details>` disclosure | ✅ built | `PermissionRulesEditor.tsx:67-83`; snapshot `permissionState.ts:142-149`; `App.tsx:1108-1123`; `permissionDomain.ts:30-40` | Read-only; general CRUD deliberately NOT enabled (T6b, PERMISSION-BOUNDARY §4). |
| Stale / "No longer pending" reconnect tombstone card (permission_not_found) | stale card + Dismiss | silent reconcile — `ready` rebuilds queue from engine pending snapshot | ✂️ cut | proto `Permissions.jsx:415,488-496`; real `permissionState.ts:112-138` | Reconciles to engine truth silently (S2 §2 rule 1); dropped request just disappears. Source-justified. |
| Plan-enter / plan-exit MODE-CHOICE card + allowedPrompts chips | plan-exit rich card | generic card (interim); mode reachable via C2 buttons | ⬜ deferred | proto `Permissions.jsx:90-105,502-531`; owner `phase4.md:617-645` (P4-11) | P4-11 owns plan mode reusing P2-4's boundary. `allowedPrompts` addRules explicitly CUT (PERMISSION-BOUNDARY §2:143). |
| Elicitation request form (field + submit) on the queue rail | elicitation card | — (deferred) | ⬜ deferred | proto `Permissions.jsx:74,497-501,569-573`; owner `phase4.md:649-680` (P4-12) | P4-12 maps `ElicitationDialog` to the real elicitation flow (recon: confirm it routes through this queue vs a control message). |
| AskUserQuestion rich flow (1-4 questions, multiSelect, built-in "Other" freeform, preview-on-focus, Next/Submit) | AskQuestionFlow | — (none; no renderer equivalent, no owner) | ❓ missing-no-owner | proto `Permissions.jsx:177-325`; no hit in `app/renderer`/`app/sidecar`/`app/shared`; no P4-N in `phase4.md` | UNCERTAIN whether AskUserQuestion routes through `permission.requested` (it is its own tool, `src/tools/…AskUserQuestionTool`). If it does, it degrades to a raw JSON dump; if it routes elsewhere it has no surface. Needs recon + owner. |
| In-flight double-submit lock + submissionFailed rollback + engine error-frame handling | 200ms `lastRef` debounce | `submitted`/`submissionFailed` state machine; error-frame clears submitted | ➕ real-added | `permissionState.ts:75-87,100-109,162-170`; buttons disabled `PermissionPrompt.tsx:112,120,138` | Real-only correctness: transport/error failures re-enable the card. Prototype only debounces (`Permissions.jsx:369-371`). |

### FLOW-4. Multi-session switch / split

**Surfaces:** `AppV2.jsx` / `TabBar.jsx` / `WorkspaceLayout.jsx` → real `App.tsx`, `shellState.ts`, `tabStatus.ts`, `workspaceLayout.ts`, `WorkspacePanels.tsx`, `TabBar.tsx` (+ `app/host/host.ts` N-process spawn, P0-4) · **Overall:** 🔁 adapted (strong parity; every deviation is a flagged §0/HC1 adaptation or a real-added robustness, none silent)

| Step / transition | Prototype | Real app | Disposition | Evidence | Notes |
|---|---|---|---|---|---|
| Tab roster / open-tabs list (one tab per open session, arrival order) | `AppV2.jsx:95` `openTabs` useState over MOCK_SESSIONS; TabBar maps tabs→`sessions.find` | `App.tsx:307-322` builds tabs from `selectLiveSessions(shell)`; roster is a live `HostEvent` projection | 🔁 adapted | `app/renderer/src/shellState.ts:47-98`, `170-174`; `App.tsx:244-278` | Plain local array → live control-plane event projection (not a poll). Arrival order preserved; a status change never reorders (`shellState.ts:141` `reorderOnArrival`). Same grammar, different data source (source wins). |
| Click a tab → focus that session | `AppV2.jsx:139` sets `panels[activePanelIdx].sessionId` + `setActivePage('chat')` | `App.tsx:429-437` `selectTab` → `focusOrAssignWorkspaceSession` + `setActiveSessionId` + `setActiveView('chat')` | 🔁 adapted | `app/renderer/src/App.tsx:429-437`; `workspaceLayout.ts:164-182` | Real app separates `activeSessionId` (App UI) from `workspaceLayout.activeIndex`. Pure UI focus — never touches the frame stream, so background streaming is not lost (`App.tsx:430-431`). |
| New tab / new session (+ button, ⌘T) | `AppV2.jsx:154` mints `new-`+ts, appends locally, no backend | `App.tsx:393-410` `newSession`: `pickDirectory` → `createSession({cwdToken})`; tab appears off the resulting `session-added` | 🔁 adapted | `app/renderer/src/App.tsx:393-410`, `720-724`; `app/host/host.ts:194` `createSession` (HC1 token, HC4 caps) | HC1: renderer can't author a cwd, so New requires a directory pick + one-time token before an N-process engine spawns. Prototype's DRAFT_ID "promote on first message" (`AppV2.jsx:188`) NOT replicated — session created up-front. |
| Close tab (× on tab, ⌘W) | `AppV2.jsx:145` removes id from `openTabs`; panel falls back to `remaining[0]`/DRAFT — destructive | `App.tsx:530-546` `closeTab` → `bridge.closeSession` (non-destructive: row kept, emits `exited`+restorable); shell revokes tab membership → Sidebar restore-offer | 🔁 adapted | `app/renderer/src/App.tsx:530-546`, `725-729`; `shellState.ts:109-123` `foldTabMembership` | Real close is non-destructive + reversible vs hard delete. ⌘W SEMANTIC DIVERGENCE: prototype ⌘W (`AppV2.jsx:116`) removes a split panel; real ⌘W (`App.tsx:725-729`) closes the active session. Same chord, different action. |
| Select a session from Sidebar / Command palette → open+focus | `AppV2.jsx:181` adds to `openTabs` if absent then navigates active panel | `App.tsx:846` palette `selectLiveSession: selectTab`; `App.tsx:861` Sidebar `onSelectLive={selectTab}`; restore path `App.tsx:847` | ✅ built | `app/renderer/src/App.tsx:828-849`, `856-863` | Palette + Sidebar route through the same `selectTab`/`restoreSession` handlers; the live∪restorable roster IS the search corpus — no mocked rows. |
| Split view — add a panel (Split button) | `AppV2.jsx:165` picks first un-panelled tab, else `openTabs[0]` (CAN duplicate active); up to 3 | `App.tsx:511-522` `addWorkspacePanel`: first live session NOT shown, else notice; splits active panel's right edge | 🔁 adapted | `app/renderer/src/App.tsx:511-522`; `workspaceLayout.ts:201-247` (rejects dup, caps `MAX_WORKSPACE_PANELS=3`); `TabBar.tsx:136-164` | §0 (STATUS P4-4): layout model forbids the same session in two panels, so Split opens a DIFFERENT session; prototype duplicates the active one. Flagged adaptation. |
| Unsplit — remove a panel (Unsplit button) | `AppV2.jsx:174` slices last panel, clamps `activePanelIdx` | `App.tsx:525-528` `removeWorkspacePanel` → `closeWorkspacePanelAt(last)` | ✅ built | `app/renderer/src/workspaceLayout.ts:249-265` (min 1 panel, re-normalises widths+activeIndex); `TabBar.tsx:151-162` | Reuses the same close-panel reducer the panel × uses. (Chord divergence noted under Close-tab.) |
| Focus a panel in split mode (click / mousedown a column) | `WorkspaceLayout.jsx` column `onMouseDown`→`setActivePanelIdx`; PanelHeader onFocus | `App.tsx:439-445` `focusWorkspacePanelSession`; `WorkspacePanels.tsx:157` `onMouseDown`, `:268` header onClick | ✅ built | `app/renderer/src/WorkspacePanels.tsx:157`, `268`; `App.tsx:913` `onFocusPanel` | Active panel gets accent ring (`WorkspacePanels.tsx:150-155` `ring-accent/35`) + dot (`:270-276`), matching the prototype's pink border + indicator dot. |
| Per-panel session selector dropdown (PanelHeader picker) | `WorkspaceLayout.jsx` styled popover listing all sessions with time·model; rewrites panel's sessionId | `WorkspacePanels.tsx:289-311` native `<select>`, duplicates disabled ("open in panel N"); `App.tsx:447-468` `selectWorkspacePanelSession` | 🔁 adapted | `app/renderer/src/WorkspacePanels.tsx:289-311`; `workspaceLayout.ts:184-199` `assignWorkspacePanelSession` | Native `<select>` vs styled popover; real model DISABLES duplicates where prototype allows them. Prototype's time·model sublabels are mock fixture fields — correctly dropped (source wins). |
| Close a single panel (× in PanelHeader) | `WorkspaceLayout.jsx` PanelHeader `onClosePanel` → filter out, `activePanelIdx=0` | `App.tsx:489-500` `closeWorkspacePanelAt` → `closeWorkspacePanel`; `WorkspacePanels.tsx:312-323` × button | ✅ built | `app/renderer/src/WorkspacePanels.tsx:312-323`; `workspaceLayout.ts:249-265` | Real app clamps `activeIndex` smartly (`activeIndex-1` if closing before it, `workspaceLayout.ts:260-263`) rather than snapping to 0. |
| Resize split panels (drag divider between columns) | `WorkspaceLayout.jsx` startResize/onMove: percentage widths, min 20% | `WorkspacePanels.tsx:82-102` mouse-drag + `:210-236` Divider; `App.tsx:502-504` `updateWorkspaceWidths`; `workspaceLayout.ts:277-293` (MIN 20) | ✅ built | `app/renderer/src/WorkspacePanels.tsx:210-236`; `workspaceLayout.ts:5`, `277-293` | Built + real-added keyboard resize (±5% via ArrowLeft/Right, `WorkspacePanels.tsx:215-227`) the prototype lacks. Same 20% min-width floor. |
| Drag a tab into the workspace to place a session in a panel | `TabBar.jsx` onDragStart sets sessionId; `WorkspaceLayout.jsx` handleDrop REPLACES the whole target panel | `TabBar.tsx:244-249` draggable tab; `WorkspacePanels.tsx:172-201` left/right DropEdge → `splitFromDrop` → `onSplitPanel` (SPLITS off that edge) | 🔁 adapted | `app/renderer/src/WorkspacePanels.tsx:104-113`, `328-366`; `App.tsx:470-487` `splitWorkspacePanelWithSession` | Prototype drop = replace-whole-panel; real drop = edge-based SPLIT. Whole-panel replace instead covered by the `<select>`. DropEdge only captures pointer events mid-drag (`WorkspacePanels.tsx:68`, `172-201`) so it doesn't swallow clicks at rest. |
| Keyboard: ⌘K palette / ⌘T new / ⌘W / ⌘1–9 jump-to-tab | `AppV2.jsx:112-120` only ⌘K, ⌘T, ⌘W (remove panel) | `App.tsx:710-740`: ⌘K toggle, ⌘T new, ⌘W close active, ⌘1–9 `sessionAtSlot`→`selectTab` | 🔁 adapted | `app/renderer/src/App.tsx:731-736`; `shellState.ts:221-227` `sessionAtSlot` (1-based into live tab order) | ⌘1–9 jump-to-tab is real-added (prototype has no numeric jump). ⌘W rebound (panel-remove → session-close). ⌘K/⌘T match. |
| Active-tab visual state (underline / streaming / attention badge) | `TabBar.jsx` isActive pink bottom bar + title color; no real status (mock) | `App.tsx:307-322` `deriveTabVisualState` fuses descriptor + per-session connection + pending-permission count | 🔁 adapted | `app/renderer/src/tabStatus.ts:48-105`; `TabBar.tsx:252-289` (underline, StatusChip, AttentionBadge, restart) | Real derives a genuine per-session status + background pending-permission attention badge; prototype's is cosmetic. Each tab computed from its OWN sessionId slice so a background tab's badge is correct without being active. |
| Panel header project pill (workspace name; cross-project amber) | `WorkspaceLayout.jsx` pill keys off `session.workspace`; amber when ws ≠ current (cross-project) | `WorkspacePanels.tsx:282-288` pill shows cwd basename, always neutral blue | 🔁 adapted | `app/renderer/src/WorkspacePanels.tsx:277-288`, `427-434` `workspaceLabel` | §0 (STATUS P4-4): cross-project AMBER DEFERRED — HC1's one-cwd-per-session has no single "current workspace" to diff, so every pill is neutral. Pill element itself is built. |
| Per-session state isolation while switching (transcript/permission/connection stay resident) | `AppV2.jsx` `messagesBySession`/`activeAccountBySession` keyed maps; switching re-points a panel | `App.tsx:750-818` each panel's `SessionPane` reads its OWN sessionId slice of the P3-4 keyed stores; `selectTab` is pure UI focus | ✅ built | `app/renderer/src/rendererSessionIsolation.test.ts:69`, `118`, `162`; `App.tsx:207-215` (background frame never steals focus) | Built + test-guarded. P0-4 N-process guarantee surfaced in the renderer: each session is a separate spawned engine (`app/host/host.ts:194`, `309`) and the renderer keeps per-session keyed stores, never a single active-session blob. |
| Layout persistence + relaunch restore of a split (survive app restart) | none — panels/openTabs are ephemeral React state, lost on reload | `App.tsx:142-156` read layout from localStorage at boot; `:386-391` persist; `:363-384` `pendingRestore` snaps a saved multi-panel split back atomically once every referenced session is live | ➕ real-added | `app/renderer/src/workspaceLayout.ts:45-92`, `143-152` `readyToRestoreLayout`; `App.tsx:152-156`, `371-384` | Real-only. Saved split is HELD (`pendingRestore`) and re-formed order-independently after restore (P3-6), overriding operator clicks while sessions come back; abandoned if a referenced session is unrecoverable. |
| Focus-follows-roster correctness (auto-move focus off a closed active tab; never steal from background) | none — closing the active session falls back to `remaining[0]`/DRAFT synchronously | `App.tsx:291-299` post-commit effect moves focus off a non-live active tab to the first live tab (or null); `:207-215` background frame never steals the pane | ➕ real-added | `app/renderer/src/shellState.ts:183-190` `activeAfterLiveChange`; `App.tsx:291-299` | Robustness the prototype's synchronous local model doesn't need. Restorable-only rows never auto-focus (Sidebar offers, not tabs). |
| Layout notice banner (duplicate / max-panels / "no other session to split") | none — prototype allows dup panels + silent behaviour, so no notice surface | `WorkspacePanels.tsx:117-121` renders `notice`; set by `App.tsx:461-465`, `478-484`, `516-519` on `blocked==='duplicate'`/`'max-panels'`/no-target | ➕ real-added | `app/renderer/src/App.tsx:461-465`, `478-484`, `511-521`; `WorkspacePanels.tsx:117-121` | Real-only UX-state: surfaces the forbid-duplicate / three-panel-cap adaptations to the user instead of silently no-op'ing. |
| Empty-shell state (no live sessions) | none — prototype always has MOCK_SESSIONS; no empty state | `App.tsx:904-905`, `931-946` `EmptyShell` — "No sessions open." + New-session button + ⌘T hint | ➕ real-added | `app/renderer/src/App.tsx:904-905`, `931-946` | Real-only. A genuinely empty roster (all closed) is reachable in the real N-process model (die-with-window, non-destructive close) but not in the prototype's static fixture set. |
| Restore/open must NOT reorder a tab/row (reorder only on message-send) | `openTabs` preserves insertion order; `handleSessionSelect` appends only if absent — no reorder-on-activity model | `shellState.ts:141-152` `reorderOnArrival` moves a re-added/restored tab to the END | ⬜ deferred | Owner: **CC-2** (`docs/migration/STATUS.md:25`, 🟡 tracked · ⬜ not-fixed, parked by operator; owner field = TBD); `shellState.ts:125-152` | KNOWN BUG. Operator spec (2026-07-07): a tab/row NEVER moves on restore/open — only when the session SENDS A MESSAGE. Needs a last-activity signal absent from `SessionDescriptor` + shell state. Two fixes attempted, both insufficient; parked (do-not-fix-now). Tracked as CC-2 with NO P4-N owner assigned. |

### FLOW-5. Orchestrator / subagent nesting

**Surfaces:** `OrchestratorMode.jsx` + `Messages.jsx` agent cards → `app/renderer/src/transcriptProjector.ts`, `app/renderer/src/TranscriptView.tsx`, engine `src/utils/queryHelpers.ts`; session-plane chrome owned by P4-8 (roster/detail/focus) + P4-9 (tasks/leases) · **Overall:** 🔁 adapted

| Step / transition | Prototype | Real app | Disposition | Evidence | Notes |
|---|---|---|---|---|---|
| Engine re-emits subagent full frames with non-null `parent_tool_use_id` | Single fixture worker array feeds cards + roster | assistant/user/tool_progress frames carry `parent_tool_use_id: message.parentToolUseID` | ✅ built | `src/utils/queryHelpers.ts:135,145,194` | S1: only full frames arrive for subagents; deltas dropped engine-side (P2-0). Verified. |
| Projector preserves `parentToolUseId` on every row | — | Row shape carries `parentToolUseId` through projection | ✅ built | `app/renderer/src/transcriptProjector.ts:340-366` | Preserved so subagent rows nest instead of interleaving. |
| D2/C4 CORE: subagent frames NEST under owning Agent card, never interleave at top level | AgentToolCard renders in transcript | `selectNestedTranscriptRows` trees rows by `parentToolUseId`→`toolUseId`; TranscriptView renders `row.children` | ✅ built | `app/renderer/src/transcriptProjector.ts:344-375`; `app/renderer/src/TranscriptView.tsx:90-96`; test `transcriptProjector.test.ts:1337` | The ONLY fully-built, GUI-wired piece. Structural render, test-proven. Resolves P2-0 interleave finding. Verified. |
| Inline Agent-tool card (owning card children nest under) | `AgentToolCard` w/ handle/type-chip/toggle/stats/activity/verdict | Generic tool-use card, `toolFamily === 'agent'` via `deriveToolFamily` (Agent/Task) | 🔁 adapted | `app/renderer/src/TranscriptView.tsx:63-99`; `transcriptProjector.ts:1014-1016`; proto `OrchestratorMode.jsx:562-578` | D2/C2: adapt as Agent member of tool-card family. Rendered structurally; rich agent-card chrome not built → visual adaptation deferred P4-8. |
| Orphaned subagent child (parent frame missing) surfaces at top level, not dropped | Fixture model never needs this | Child whose parent isn't in `byToolUseId` pushed to top level | ➕ real-added | `app/renderer/src/transcriptProjector.ts:356-366` + doc `:331-338` | Degraded-placement robustness the prototype never needed. Verified. |
| Parallel delegation grouping (DelegateGroup co-spawned cards) | `DelegateGroup` stacks parallel AgentToolCards | Siblings render independently at top level; nesting is parent→child only, not sibling grouping | ⬜ deferred | proto `OrchestratorMode.jsx:581-589`; real `src/tools/AgentTool/UI.tsx:740` | SOFT SPOT: D2 §6 called grouping P2-2 scope but P2-2 shipped only nesting. Now leans on P4-8 — needs explicit P4-8 line item. |
| Subagent progress / activity timeline inside card | `w.progress` timeline animates | `tool_progress` no-op in projector; activity = nested child rows | 🔁 adapted | proto `OrchestratorMode.jsx:444-456`; real `transcriptProjector.ts:448-451` | D2 §4: content updates frame-by-frame, deltas never arrive; `w.progress` fixture CUT. Richer chrome P4-8. |
| Orchestrator-mode badge by session title | Badge next to session title | Not built | ⬜ deferred | proto `OrchestratorMode.jsx:410-417`; none in `app/renderer/src` | Session-plane chrome. Owner P4-8. |
| Worker roster block above composer (whisper line + counts + lead promotion + hover popover) | `OrchestratorModeWorkerRoster` | Not built; real shape `AgentModeWorkerRoster.tsx:30`, `workerUxSummary.ts:96-112` | ⬜ deferred | proto `OrchestratorMode.jsx:237-370` | D2/C2 adapt over persisted agent-mode state. Owner P4-8 (phase4.md:506,528). |
| Baton owner chip (orchestrator / you), two-axis lifecycle-vs-owner | `deriveWorker`/`Baton` | Not built; real `handoffStatus` `LocalAgentTask.tsx:184`, `AskOrchestratorTool.ts:83` | ⬜ deferred | proto `OrchestratorMode.jsx:131-209` | Source-correct (no `escalate:user` field; blocked = orchestrator-owned neutral). Owner P4-8. |
| Footer BackgroundTaskStatus pill | Amber pill summarizing activity | Not built; real `BackgroundTaskStatus.tsx:25` + `pillLabel.ts` | ⬜ deferred | proto `OrchestratorMode.jsx:376-407` | Amber only on user-owned attention. Owner P4-8. |
| /tasks button + panel (Workers tab, role-grouped list) | `TasksButton` → `TasksPanel` | Not built; real `BackgroundTasksDialog.tsx:131` | ⬜ deferred | proto `OrchestratorMode.jsx:420-433,713-812` | Tasks drawer split to P4-9 (phase4.md:551); roster/detail/focus to P4-8. |
| Worker detail drilldown (prompt / activity / blocked / files / Stop) | `WorkerDetail` | Not built; real detail dialogs + `describeTeammateActivity` `taskStatusUtils.tsx:79` | ⬜ deferred | proto `OrchestratorMode.jsx:436-482` | Stop = real stop-while-running. Owner P4-8 (named roster/detail/focus, phase4.md:506). |
| Leases tab — per-session Codex LeaseRoster | `LeaseRoster` + Leases tab | Not built; real `getCodexLeaseSnapshot` `codexAccountLeaseManager.ts:163,194` | ⬜ deferred | proto `OrchestratorMode.jsx:645-711,744-760` | Read-only session-scoped. `MOCK_CODEX_LEASES`/`w.account`/`w.up`/`w.down` fixture → CUT (D2 §3). Tab on P4-9 panel; data overlaps P4-5. |
| Worker focus view (Open thread swaps main column to worker sub-thread) | `WorkerFocusView` | Not built; real teammate view `teammateViewHelpers.ts:46,88` | ⬜ deferred | proto `OrchestratorMode.jsx:491-559` | D2 claim-reduced: viewing real; typing-to-worker conditionally real (`resumeAgent.ts`, gate per task type). Owner P4-8. |
| Blocked / needs-input worker state (neutral, orchestrator-owned, reason note) | Blocked worker card w/ reason | Not built; real `handoffStatus` blocked `LocalAgentTask.tsx:184,473-530` + `AskOrchestratorTool.ts:83` | ⬜ deferred | proto `OrchestratorMode.jsx:137-139,458-464` | Model decided / source-correct; only UI deferred. Owner P4-8. |
| OrchestratorDemoSwitch A/B/C scaffold | Demo toggle cycling scripted states | Not built; no upstream demo-state | ✂️ cut | `OrchestratorMode.jsx:814-901`; INVENTORY CUT list; D2 §3; phase4.md:525 says IGNORE | Pure prototype scaffolding. Correctly dropped. |
| Mock worker feeds (`w.progress`/`w.files`/`w.up`/`w.down`/`w.cost`/`w.account`/`MOCK_CODEX_LEASES`) | Scripted fixture fields | Real feeds = `AgentModeWorkerSession.outputSummary` / result frames / lease snapshot | ✂️ cut | D2 §3 CUT row; `OrchestratorMode.jsx:53-89` | Dropped MOCK DATA, not a UX element. Source wins. |
| AgentEventRow (`msg.type === 'agent-event'`) standalone lifecycle row | Lifecycle event row in transcript | No `agent-event` member in seam union; lifecycle → badges on agent card (C4) | ✂️ cut | D2/C3 §3; `coreTypes.generated.ts:760`; real 'finished' = task-notification user msg `message.ts:13` | Invented type. Real finish moment = W3 TaskAssignRow. |
| AttachmentCard (`msg.type === 'attachment'`) | Attachment message card | `AttachmentMessage` engine-internal, not in seam union | ✂️ cut | D2/C3 §3; `message.ts:92-97` | Flagged extend-engine-vs-change-UI, not silent invention. |
| GroupedToolGroup (`msg.type === 'grouped'`) as a message type | Grouped tool frame type | No `grouped` frame; collapse is render-time `collapseReadSearch.ts` | ✂️ cut | D2/C3 §3 | Cut the invented FRAME TYPE; keep grouping as derivation (the deferred DelegateGroup step above). |

### FLOW-6. Accounts reauth

**Surfaces:** prototype `Startup.jsx`(ReauthGate) + `AccountLifecycle.jsx` + `Pages.jsx`(Accounts) · real engine `src/services/api/codexTokenRefresh.ts` / `codexAccountPool.ts` / `src/codex-core/accounts.ts` · real app `app/renderer/src/BannerStack.tsx` + `app/shared/secretGuard.ts` · owners P4-5 (Accounts read-seam) + P4-15 (reauth banner), both ⬜ · **Overall:** ⬜ deferred

| Step / transition | Prototype | Real app | Disposition | Evidence | Notes |
|---|---|---|---|---|---|
| 1. Engine detects refresh failure (401/403 or `invalid_grant`\|`invalid_token`\|`expired_token`) → marks `refresh.state='reauth_required'` | ReauthGate takes a simulated `reason` prop; no real detection | Vault refresh record set `reauth_required` with reason + `marked_at` | ✅ built | `src/services/api/codexTokenRefresh.ts:187` (auth-error regex), `:213-215` (reason class), `:460` (`state:'reauth_required'`), `:328` (skip when already reauth_required) | The flow's real trigger; engine-side, not a prototype-owned UI step. Verified. |
| 2. Pool flips the account `status:'dead'` / `statusReason:'auth_dead'` | Hard-codes a `Dead` chip (`Startup.jsx:443`) | Real PoolAccount health transition | ✅ built | `codexAccountPool.ts:602` (`statusReason='auth_dead'`), `:1107-1110` + `:1130` (reauth_required → dead/auth_dead), health union `:37`, reason union `:73` | Real state transition is source of truth; the chip is static mock. Verified. |
| 3. Redacted pool status surfaced to GUI via domain read-seam (C3 outbound snapshot, secretGuard-scanned — no token text over IPC) | — | Not built: no `account.snapshot`/`accountsDomain` frame exists | ⬜ deferred | grep of `app/sidecar` + `app/shared/protocol.ts` + `app/renderer` = EMPTY; `backlog/phase4.md:406` (expose pool status for P4-15/P4-17); `STATUS.md:221` P4-5 ⬜; primitive `secretGuard.ts:53` `scanForSecrets` exists | **Owner P4-5.** THE load-bearing gap: until this seam exists no dead-account status can reach the renderer. Recipe = `settings.snapshot` C3 precedent P4-3 front-ran (STATUS.md:221 RIDER B4). |
| 4. Non-blocking reauth banner appears, derived from pool status (replaces the blocking modal) | Blocking full-screen `ReauthGate` modal (`Startup.jsx:389-457`, zIndex 210) | Not wired: ruled to mount in BannerStack, re-derived idempotently by id | ⬜ deferred | `BannerStack.tsx:6-8` doc-comment names it but no derivation; `App.tsx` grep for reauth/pool/BannerStack = EMPTY; `STATUS.md:231` P4-15 ⬜; `decisions/STARTUP-GATES.md:84-86` | **Owner P4-15** (dep P4-5). Adapt-to-banner; the modal is gone (see step 9). |
| 5. Banner chrome: full-width danger bar, alert icon, title + muted detail, action button(s), dismiss × | `Surfaces.jsx:786-833` grammar, re-implemented inline in ReauthGate (`Startup.jsx:434-452`) | Presentation primitive built + unit-tested (P4-1); only the reauth instance is missing | ✅ built | `BannerStack.tsx:99-164` (BannerRow: tone classes, primary vs outline `:146`, dismiss × `:154-164`); types `:20-37` | Presentation done, MEANING deferred — caller owns semantics (`BannerStack.tsx:6-8`). |
| 6. "Re-authenticate" action launches OAuth scoped to the dead account | ReauthGate button `setOauthState('waiting_for_login')` (`Startup.jsx:449`) | Not built as a desktop surface; BannerAction primary CTA exists but no handler | ⬜ deferred | `backlog/phase4.md:783-786,799-800`; `decisions/STARTUP-GATES.md:56`; real OAuth machine `src/components/ConsoleOAuthFlow.tsx:35-55`; CTA type `BannerStack.tsx:20-26` | **Owner P4-15** (coordinated with P4-5 add-account). Underlying TUI OAuth state machine is real; desktop re-skins it. |
| 7. Browser OAuth dance — open browser → `127.0.0.1:1455` callback → engine writes rotated token | DEMO-ONLY `setTimeout` simulation (`Startup.jsx:392-396`) | Not built; renderer drives navigation, engine owns the token | ⬜ deferred | `backlog/phase4.md:799` (renderer drives, engine owns token); `decisions/STARTUP-GATES.md:124`; engine OAuth `src/services/oauth/codex-client.ts` (1455 callback) | **Owner P4-15** / P4-5 share. Token write must go THROUGH codex-core locking (step 14); secretGuard runs outbound. |
| 8. `waiting_for_alias` — optional Codex alias step after authorization | `Startup.jsx:130-158`; alias regex `^[a-zA-Z0-9_-]{1,32}$` (`AccountLifecycle.jsx:26`) | Not built; real engine state, re-login shows a keep-vs-new-name variant the prototype omits | ⬜ deferred | real state `src/components/ConsoleOAuthFlow.tsx:48` (waiting_for_alias) + `:68-78` (relogin variant); `decisions/STARTUP-GATES.md:13`; `backlog/phase4.md:780,799` | **Owners P4-5 + P4-15** share the OAuth surface — coordinate. |
| 9. "You're back in" / "Resuming where you left off" celebratory success modal | ReauthGate `oauthState==='success'` green card (`Startup.jsx:415-421`) | No equivalent by design: account returns healthy, seam re-emits, banner removed (`dismissBanner` by id) | ✂️ cut | `decisions/STARTUP-GATES.md:84-86` (Q2 blocking modal CUT); banner model has no success state (`BannerStack.tsx:58-63`) | Correct CUT of storytelling UX, not a lost capability. "Resume-on-heal" is the deferred step-4 re-derivation. |
| 10. "Switch to another account" manual failover (`onUseOther`) | ReauthGate `onUseOther` (`Startup.jsx:450`); AccountLifecycle menu 'switch' → `/switch-account` guarded (switchable = healthy && !capped, `AccountLifecycle.jsx:247`) | Not built; real `/switch-account` is synchronous, blocked for non-healthy/capped | ⬜ deferred | `Startup.jsx:450`; `AccountLifecycle.jsx:11-12,242-247`; `STATUS.md:221` P4-5 ⬜ | **Owner P4-5.** Often redundant — the engine usually does this automatically (step 11). |
| 11. Automatic pool failover to a healthy account (engine, no user action) | No equivalent — modal assumes single-active-account death blocks the app | Pool silently continues on another healthy account; dead one just flagged | ➕ real-added | `decisions/STARTUP-GATES.md:52-53,80` (failover is the pool's job); per-request healthy selection `src/services/api/client.ts`; health union `codexAccountPool.ts:37` | Real-only capability; this is WHY the blocking modal was cut — the banner surfaces the dead account WITHOUT halting. |
| 12. Submit blocked ONLY when zero healthy accounts remain | Always blocks on ANY active-account death (modal unconditional) | Not built; ruled block-condition = zero-healthy, else banner + continue | ⬜ deferred | `decisions/STARTUP-GATES.md:85` (submit blocked only when zero healthy); `backlog/phase4.md:784-786`; real zero-healthy error in `client.ts` (STARTUP-GATES.md:16 G5) | **Owner P4-15.** Adapts the prototype's unconditional wall to the pool's multi-account model. |
| 13. Dismiss the banner (×) | Optional tertiary 'Dismiss' button (`Startup.jsx:451`) | Primitive supports it; dismiss-vs-persist policy needs P4-15 (ruled persistent-until-acted-on) | ⬜ deferred | primitive `BannerStack.tsx:36,120,154-164` + `dismissBanner :58-63`; no reauth instance yet (App.tsx grep empty); policy `decisions/STARTUP-GATES.md:56,106` | **Owner P4-15** (wiring); primitive built P4-1. |
| 14. Cross-process refresh locking + durable attempt-ledger during token rotation/reauth | No representation — single in-page timer simulation | Multiple engine processes share the vault; refresh is lock-guarded + ledgered so concurrent sessions don't double-rotate | ➕ real-added | `src/codex-core/accounts.ts:111-118` (RedeemRefreshOutcome: ok=rotated token \| 'reauth' degrades), imports `:18-23`; CLAUDE.md §6 ("never simplify away locking") | Real-only safety machinery invisible to any surface; the desktop OAuth write (step 7) must go THROUGH it. |
| 15. `identity_mismatch` reason — a refresh returning a DIFFERENT identity marks the old vault reauth_required | Static 4-entry REASONS map (`expired_token`/`invalid_grant`/`invalid_token`/`revoked`, `Startup.jsx:403-408`) | Real reason enum differs; banner detail must use the real set (`auth_dead` + real refresh reasons), prototype's `revoked` is invented | ➕ real-added | `codexTokenRefresh.ts:551-556` (mark old vault reauth_required, `reason:'identity_mismatch'`), `:567,:681-684` | When P4-15 wires banner detail, use real reason vocabulary, NOT the prototype's `revoked`. Adapt-with-flag for P4-15. |

### FLOW-7. Resume / cross-project

**Surfaces:** `Welcome.jsx` (launcher) + `ResumeStates.jsx` (HydrationOverlay / CrossProjectResumeDialog) → real modules `app/host/registry.ts`, `app/host/host.ts`, `app/sidecar/sessionResume.ts`, `app/sidecar/index.ts`, `app/renderer/src/Sidebar.tsx` + `sidebarState.ts`, `app/renderer/src/App.tsx` (EmptyShell), `app/shared/protocol.ts`, engine `src/utils/conversationRecovery.ts` / `src/utils/sessionRestore.ts` · **Overall:** 🔁 adapted

| Step / transition | Prototype | Real app | Disposition | Evidence | Notes |
|---|---|---|---|---|---|
| Launcher / Welcome entry screen (neon cat, wordmark, Welcome-back, meta strip) | `Welcome.jsx` WelcomeScreen | EmptyShell placeholder only | ⬜ deferred | `app/renderer/src/App.tsx:932` EmptyShell; owner `docs/migration/backlog/phase4.md:855` P4-17 | No launcher exists; EmptyShell ("No sessions open." + New session + ⌘T, App.tsx:905/935) stands in. P4-17 CLAUDE/visual-design, D5-scoped. |
| Project picker + recents dropdown (Recent list, selected/hover, Open folder… ⌘O) | `Welcome.jsx` ProjectValue | not built | ⬜ deferred | `phase4.md:855` P4-17; recents DERIVED per `decisions/WELCOME-LAUNCHER.md` (registry ∪ GlobalConfig.projects, no store) | Real recents are derived (D5); prototype's `WS_RECENT`/`WS_TRUSTED` mock is source-drop-correct, not a gap. |
| Per-path trust gate on untrusted project (Trust / Open read-only / Cancel; ↵/R/Esc) | `Welcome.jsx` TrustProjectPrompt | not built (real primitive engine-side) | ⬜ deferred | `phase4.md:764` P4-15 "Startup + trust gate + first-run OAuth + reauth banner (D4)"; data binding `src/utils/config.ts` `hasTrustDialogAccepted` | Prototype nests it in launcher; real owner is the startup/trust-gate session (P4-15). D4: trust gate adapts per-session-create. |
| Start-in selector: Locally vs New worktree; Branch chooser | `Welcome.jsx` StartInSeg + BranchValue | local start = P3-1 spawn cwd; worktree/branch not built | ✂️ cut | `decisions/WELCOME-LAUNCHER.md` W3/W4: local=built, worktree=DEFER, branch chooser=CUT; `phase4.md:855` P4-17 | Local start IS the real path. Worktree-at-launch deferred, branch chooser cut — both D5, cited; correct drops, flagged. |
| Codex account table on welcome (pool status, 5h/weekly bars, CAPPED) | `Welcome.jsx` CodexRow/MiniUsageBar | not built | ⬜ deferred | `phase4.md:406/469` "pool status for … P4-17 (welcome account table)"; feed = P4-5 pool | Real feed is P4-5 accounts pool; prototype's `FILL`/`FRIENDLY` mock rosters are source-drop-correct. Table UI → P4-17. |
| HydrationOverlay — loading state ("Resuming <title>… / Hydrating transcript from log", spinner) | `ResumeStates.jsx` HydrationOverlay (loading) | overlay chrome built over real ready/replay restore frames | ✅ built | `ResumeDialog.tsx:191-207`; frame gate `App.tsx:235-240,629-638,1003-1010`; replay `app/sidecar/index.ts:129`, `app/shared/protocol.ts:152` `replay?:true` | Animation is pure visualization over a real synchronous replay. Prototype SOURCE: cat-code has NO hydration-state enum. |
| HydrationOverlay — failed state (error card "Couldn't resume", Retry / Start fresh) | `ResumeStates.jsx` HydrationOverlay (failed) | failed overlay shows real host/sidecar error, with Retry reusing `host.restoreSession` | 🔁 adapted | `ResumeDialog.tsx:160-189`; retry path `App.tsx:613-618,1003-1009`; `app/sidecar/sessionResume.ts:33`; `app/host/host.ts:242-264` | Real posture remains fail-loud (anti-Potemkin, D6) + host pre-validation; UI is a presentation wrapper over those failures. |
| CrossProjectResumeDialog — "Resume from a different project?" warning + from→to badges | `ResumeStates.jsx` CrossProjectResumeDialog | confirm dialog built; cross-project warning/badges render only for a real cwd difference | 🔁 adapted | `ResumeDialog.tsx:64-103`; invoke path `App.tsx:609-616,1024-1031`; row cwd `registry.ts:80`, host re-validates `host.ts:283` and spawns rooted there | Desktop restores in the row's own cwd (D1 one-cwd-per-session); P4-16 reframes the dialog as a restorable-row confirm step. |
| CrossProjectResumeDialog — "What will differ" list (working dir / MCP / plugins+agents / permission rules) | `ResumeStates.jsx` diffs[] | none | ✂️ cut | Prototype SOURCE labels it a "GUI-ONLY enrichment"; real check is directory-only (`crossProjectResume.ts`), does not diff plugins/MCP/permissions; `diffs[]` are hardcoded mock notes; absence asserted in `ResumeDialog.test.tsx:24-28` | Correct drop: a fabricated diff list with no real data source. A dropped mock, not a missing element; the P4-16 picker does not resurrect it. |
| CrossProjectResumeDialog — copy `cd <path> && claude --resume <id>` escape hatch | `ResumeStates.jsx` copyCmd/cmd | none | ✂️ cut | TUI escape hatch (`ResumeConversation.tsx` per surface SOURCE) targets the terminal `--resume` flow; desktop restores in-app via `host.restoreSession` | Terminal-flow affordance, N/A to the desktop restore path; correct to drop, not a gap. |
| Cross-project amber project pill on workspace panel header | `Welcome`/WorkspaceLayout amber pill | always neutral blue | ⬜ deferred | `app/renderer/src/WorkspacePanels.tsx:277-281` comment: amber deferred, HC1 has no single current workspace to diff → neutral blue; §0 flag `STATUS.md:220` (P4-4) | Deferred with a recorded P4-4 §0 flag, tied to the same D1 constraint that neutralizes the cross-project warning. |
| Launch sequence: registry read+validate → sweep orphans → reap → restorable rows (lastAttachedAt desc) | (none) | full durable-registry launch pipeline | ➕ real-added | `app/host/registry.ts:384` launch() (readOrRecover→sweepOrphans→reap→restorable); `:552-554` restorable() sorts lastAttachedAt desc; `:403` readOrRecover moves corrupt registry aside | Durable-registry machinery (D1 two-id model) the prototype has no notion of; feeds the restore-offer roster the Sidebar renders. |
| Sidebar restorable roster + inline "restore" affordance + crashed/disconnected tone | `Welcome`/`ResumeStates` session-select → overlay | inline sidebar-row action, live ∪ restorable union | 🔁 adapted | `app/renderer/src/Sidebar.tsx:362` restorable, `:367` activate routes onRestore, `:413-424` "restore" button; `sidebarState.ts:91` restorable kind, `:104` disconnected tone | Real app surfaces restore as an inline sidebar row action, not the prototype's modal overlay. Per-row actions menu omitted → P4-6 (`STATUS.md:220`). |
| host.restoreSession guardrails (HC2 id shape, transcript re-check SF6, live-advisory refusal, terminal-record, cwd re-validate, spawn limits) | (none) | full validation chain before spawn | ➕ real-added | `app/host/host.ts:238` isUuid HC2, `:243-252` row+engineSessionId, `:254` hasTranscript SF6, `:260` hasLiveAdvisorySidecar refusal, `:271` terminal record, `:283` validateCwd, `:288` checkSpawnLimits | Safety machinery with no prototype analogue; enforces "never offer a restore we cannot perform" (§9-A4) so the sidecar never fails Potemkin-style. |
| Sidecar resume via engine's REAL machinery (loadConversationForResume → processResumedConversation → switchSession id-adoption) + fail-loud | (prototype only animates "hydrating") | composes the TUI `--resume` path, fails loud | ➕ real-added | `app/sidecar/sessionResume.ts:9-14,27-28` engine imports; `app/sidecar/index.ts:105-106` resumes before reading id, `:129` toSDKMessages; null loaded → SidecarResumeError | Reuses the SAME resume path as TUI `--resume` (Mistake-#1/#10 compliant). The real substrate the prototype's overlay merely visualizes. |
| Restored history → `replay:true` frames → projector dedupe/fold into visible transcript | (none — single "hydrating" animation) | replay frames deduped at read time | ➕ real-added | `app/shared/protocol.ts:145-152` `replay?:true` on restored-history frames; `app/renderer/src/transcriptProjector.ts:527` dedupes replayed frames before folding results | The genuine hydration mechanism: history is replayed as tagged frames the projector folds, not an opaque loading bar. |
| Lossy-replay truncation guard (restored transcript over replay caps → truncation error frame) | (none) | `catcode.replay-truncated` marker frame | ➕ real-added | `app/shared/protocol.ts:157-162` F2: capped replay (MAX_HISTORY_REPLAY_FRAMES) emits a well-known ErrorFrame so a consumer can never mistake a capped replay for complete history | Anti-Potemkin safeguard with no prototype analogue — the prototype assumes hydration is always complete. |
| Stable row order on restore/open (row must NOT move when a session is restored or opened) | prototype `groupByWorkspace` never re-sorts within a group | restore/open moves the tab/sidebar row (violated) | ❓ missing-no-owner | `STATUS.md:25` CC-2 "🟡 tracked · ⬜ not-fixed (parked)", Owner: TBD; two attempted fixes (`shellState.ts`, `sidebarState.ts`) both insufficient | THE DANGER ROW. A real prototype UX invariant is violated with no fix owner. Correct spec: reorder ONLY on message-sent — needs a last-activity signal absent from `SessionDescriptor` + shell state today. |

### FLOW-8. Settings edit

**Surfaces:** `Settings.jsx` + `SettingsExtensions.jsx` (prototype) → `SettingsShell.tsx` / `SettingsField.tsx` / `settingsState.ts` (renderer) · `app/sidecar/settingsDomain.ts` (read-seam) · `src/utils/settings/settings.ts` (engine write, `SettingsUpdater`-under-lock / DR-2) · wire `app/shared/protocol.ts` · **Overall:** 🔁 adapted (read/provenance half built end-to-end; edit+persist half unbuilt, part unowned)

| Step / transition | Prototype | Real app | Disposition | Evidence | Notes |
|---|---|---|---|---|---|
| Open Settings surface (two-pane rail + right pane) | `SettingsPage` two-pane (rail + dense right pane) | `SettingsShell` same left nav + right pane frame | ✅ built | `app/renderer/src/SettingsShell.tsx:128` | Structural chrome parity. |
| Category navigation via left rail | Nav buttons per category (`Settings.jsx:684` router) | Rail buttons w/ `aria-current` + accent-active styling | ✅ built | `app/renderer/src/SettingsShell.tsx:180` | `aria-current` at `:182`; active = accent bg. |
| Category rail — CUT groups (Prototype demo controls, `native`) | Prototype had demo group + native category | `SETTINGS_NAV` omits both | ✂️ cut | `app/renderer/src/SettingsShell.tsx:41` | PrototypeControlsSection on INVENTORY CUT list; comment cites it. |
| Search-settings box (filter rail by label + no-match) | "Search settings" filters rail | `filteredNav` filter + input; "No matches" empty state | ✅ built | `app/renderer/src/SettingsShell.tsx:164` | `filteredNav` `:143`; no-match `:204`. |
| Category description header | Per-category subtitle | Header renders `CAT_DESC[active]` | ✅ built | `app/renderer/src/SettingsShell.tsx:212` | Parity. |
| Field row + SourceBadge provenance chip | Hardcoded mock source per field (`source="user"`, `Settings.jsx:186`) | `Field`/`SourceBadge` bind engine-resolved winning source from `settings.snapshot` | 🔁 adapted | `app/renderer/src/SettingsField.tsx:88` · `settingsState.ts:75` | Source wins: real provenance from on-disk layers, not a fixture string. Policy badge reads "Managed" (real engine name, `SettingsField.tsx:25`) vs prototype "Policy" — flagged STATUS.md:219. |
| ManagedBadge / policy-locked field + Managed panel | `ManagedBadge` (`Settings.jsx:51`); mock `ManagedPanel` ROWS list | `ManagedBadge` + real Managed panel over `selectManagedFields` snapshot data | ✅ built | `app/renderer/src/SettingsField.tsx:124` · `SettingsShell.tsx:304` · `settingsState.ts:97` | Renders REAL managed keys + `policyOrigin`, an upgrade over the prototype's hardcoded ROWS. |
| Resolution-order legend (policy ▸ flag ▸ local ▸ project ▸ user) | Static legend (`Settings.jsx:197`) | `ResolutionOrderLegend` over `SETTING_SOURCE_PRECEDENCE` | ✅ built | `app/renderer/src/SettingsField.tsx:231` · `settingsState.ts:88` | Precedence constant source-anchored to engine `SETTING_SOURCES`. |
| Layer summary (which files on disk + key counts) | — (no equivalent) | `LayerSummary` per-layer origin + key count from real snapshot | ➕ real-added | `app/renderer/src/SettingsShell.tsx:266` | Real-only: surfaces the actual config sources on the session's disk. |
| Read-state chrome (waiting / no-files) | — | "Waiting for the engine's settings snapshot…" / "No settings files on disk" | ➕ real-added | `app/renderer/src/SettingsShell.tsx:270` · `:277` | Real UX states the prototype never shows. |
| Edit a value control (toggle/select/text) → local state | `SwToggle`/`SwSelect`/`SwText` + `set()` (`Settings.jsx:64-95`) | Value-editor categories render `CategoryStub` "coming soon" — no controls | ❓ missing-no-owner | `app/renderer/src/SettingsShell.tsx:349` (stub); `CAT_OWNER` `:109` = "a later Phase-4 settings session" | DANGER: general/model/privacy/theme/keybindings have NO concrete P4-N owner (P4-12 is Extensions only). The core built-in edit interaction is unowned. |
| Inline validation of an edited value (max-tokens ceiling / NaN) | `maxErr` (`Settings.jsx:165`) via Field error slot | Field HAS error-render slot but nothing computes/passes it (no control); engine validators unwired | ❓ missing-no-owner | `app/renderer/src/SettingsField.tsx:183` (slot exists) | Presentation half built; validation BEHAVIOR unbuilt + unowned. Real validators `src/utils/settings/` unreachable from the app. |
| Modified indicator → "Reset to default" affordance | Reset button when modified (`Settings.jsx:119`) | `Field` renders Reset when `modified && !managed && editable && onReset` | ✅ built | `app/renderer/src/SettingsField.tsx:192` | Primitive built but DORMANT — no control supplies `modified`/`onReset` until value editors land (same unassigned owner). |
| Reset a FLAG-overridden field → "cannot reset" | Toast "Flag overrides cannot be reset" (`Settings.jsx:181`) | Real design suppresses the affordance: flag/policy = non-editable; reset gated on `editable` | 🔁 adapted | `app/renderer/src/SettingsField.tsx:192` · `settingsDomain.ts:71` (`READ_ONLY_SOURCES`) | Adapt: suppress vs toast. Mechanism built; dormant until controls exist. ToastHost primitive itself exists (P4-1). |
| Extensions edit (MCP reconnect/remove, plugin/skill/hook toggle, Elicitation dialog) | `RowBtn`/`StatusPill` row actions + `ElicitationDialog` (`SettingsExtensions.jsx:35,24,193`) | mcp/plugins/skills/hooks render `CategoryStub`; `CAT_OWNER` → P4-12 | ⬜ deferred | `app/renderer/src/SettingsShell.tsx:119` (owner) · `docs/migration/backlog/phase4.md:649` | Concrete owner P4-12 "Settings extensions (MCP/Plugins/Skills/Hooks/Elicitation)", dep P4-3 (STATUS.md:228 ⬜). |
| Persist the edited value to disk (the WRITE seam) | Mock-only — never writes to disk | NO inbound settings-write frame: `SidecarClientMessage = AppClientMessage \| PermissionSetModeMessage`; engine `updateSettingsForSource(SettingsUpdater)` under cross-process lock never reached | ⬜ deferred | `app/shared/protocol.ts:103` · `src/utils/settings/settings.ts:480` (lock `:506`) | §0-flagged in STATUS.md:219 P4-3 row (deferred citation) but NO builder session assigned — AT-RISK. Any writer MUST route through `updateSettingsForSource` under the advisory lock (DR-2) or lose concurrent writes across the N-process model (`settingsWriteContention` probe). |
| Reflect persisted change (updated winning source / live re-emit) | Local state re-render (mock) | `settings.snapshot` is a spawn-time one-shot; no re-emit on change | ⬜ deferred | `app/sidecar/settingsDomain.ts:16` · `:146` · STATUS.md:219 | Explicitly deferred: general settings need an in-engine restart today; permission-rule changes already flow via C3. Same at-risk write-seam scope. |
| Live Theme preview canvas reacting to controls | `OutputPreview`/`ThemePanel` over `CODE_THEMES` mock + Prism (`Settings.jsx:282`) | Theme category renders `CategoryStub` | ✂️ cut | `app/renderer/src/SettingsShell.tsx:349` | Preview bound to prototype mock fixtures with no engine backing — mock-only visual, not a parity target. |
| IDE & LSP panel edit (connect/disconnect, auto-connect toggles, LSP restart) | `IDELSPPanel` toast-only over MOCK_IDE/MOCK_LSP (`Settings.jsx:469`) | `ide` category → `CategoryStub`; `CAT_OWNER` = "a later Phase-4 settings session" | ❓ missing-no-owner | `app/renderer/src/SettingsShell.tsx:123` | No concrete P4-N owns IDE/LSP settings; not P4-12, not cut. Real IDE status is MCP-client-derived but unreached. Danger-list. |

---

## Part C — The danger list: ❓ missing-no-owner (126)

Every prototype element/step that is **neither built, nor owned by a backlog session, nor
cut**. This is CC-1's load-bearing output: each item needs an **owner assignment or an
explicit waiver** before the Phase-4 gate. Full evidence for each lives in its Part A/B row.

**Ownership (assigned 2026-07-07 — every ❓ now has an owner or a waiver; 0 silently unowned):**

| Cluster (Part A/B §) | ❓ | Owner |
|---|--:|---|
| Messages transcript render (§5) | 49 | **P4-18** (Tranche E) |
| Chat activity / scroll / stop (§6) | 14 | **P4-18** |
| Permission "reject-all" / stop (FLOW-3) | 1 | **P4-18** |
| Settings core value-editors (§11) | 40 | **P4-19** (Tranche E) |
| Settings-edit interaction (FLOW-8) | 3 | **P4-19** |
| PermissionRules classifier + managed-rules-only toggles (§8) | 2 | **P4-19** |
| Composer attach + slash-picker footer chrome (§6 · §10) | 3 | **P4-0** |
| Restore/open row-reorder (FLOW-7) | 1 | **CC-2** (parked bug) |
| Palette mock-recents · per-agent-memory · match-type label (§9 · §23 · §8) | 5 | ✂️ **waived** (mock/cosmetic) |
| AskUserQuestion renderer (§7 + FLOW-3) | 8 | **P4-20** (recommended — not yet drafted, operator greenlight) |
| **Total** | **126** | **0 silently unowned** |

The point-in-time danger rows (dispositions as-built at ledger time) follow; ownership above supersedes
the "no owner" note in each:

| Surface / flow | Element / step | Why it has no owner |
|---|---|---|
| Messages.jsx | AssistantBubble — "Assistant" eyebrow label | Uppercase role label not rendered; no P4/P5 owner for transcript row chrome. |
| Messages.jsx | AssistantBubble — hover-reveal copy chip | Icon copy button (hover opacity + copied-check) not built. |
| Messages.jsx | Streaming caret on assistant text | Streaming DATA built (live delta rows); the blinking caret VISUAL not rendered at `TranscriptView.tsx:52-57`. |
| Messages.jsx | UserBubble — user message (right-aligned bubble) | MAJOR: user's own typed turns are projected but never rendered — the running app shows no user messages. Data built, visual + owner missing. |
| Messages.jsx | UserBubble — hover-reveal copy chip | Moot until UserBubble renders; still unowned. |
| Messages.jsx | Prose — GFM tables (`ProseTable`, `splitTableRow`) | Pipe tables won't parse; react-markdown alone drops them. No owner. |
| Messages.jsx | ProseCode — fenced code block + syntax highlighting (`FELines`/`ProseCode`) | INVENTORY W3 target implies shiki but it is unwired; code renders as plain `<code>`. No owner. |
| Messages.jsx | ProseCode — 5 code themes + Settings-synced picker | `CODE_THEMES` + `catcode.codeTheme` localStorage/sync-event not built; settings label exists, no binding. |
| Messages.jsx | ProseCode — per-block Copy button + language label | GUI-only affordance (prototype notes source TUI lacks it). Unbuilt, unowned. |
| Messages.jsx | Prose — long-content collapse (>60 lines, Show N more/Collapse) | GUI-only addition (source never truncates bodies). Minor; unbuilt, unowned. |
| Messages.jsx | Prose — render-error try/catch → plain-text fallback | No error boundary around `<Markdown>`; a throw surfaces as a React error instead of degrading. |
| Messages.jsx | FrameEShell — expand/collapse card shell (mark · WORD · target · state-dot) | Shared quiet-panel shell (family mark, uppercase word, target ellipsis, pulsing dot, click-to-collapse) not built; card is always-open JSON. |
| Messages.jsx | BashOutputCard — tail-peek collapsed preview | Collapsed tail-of-output peek + mask gradient not built. |
| Messages.jsx | BashOutputCard — stdout/stderr stream tabs | stdout/stderr toggle + line counts not built; stderr identity not separated at the projector. |
| Messages.jsx | BashOutputCard — inline truncation reveal band (N hidden / Show N more / Open full) | Head+tail windowing + progressive reveal + capped-bytes note not built. |
| Messages.jsx | BashOutputCard — tiny-output inline variant | "≤4 clean lines, no chrome" special case not built. |
| Messages.jsx | BashOutputCard — denied / cancelled / queued / running visual states | Blocked-by-rule struck command, SIGINT-killed, queued, running-italic states not built. |
| Messages.jsx | FileReadCard — numbered file contents / grouped read rows | Line-numbered read body + grouped multi-file list not built; Read renders as generic card. |
| Messages.jsx | FileWriteCard — created/overwritten + additions view | +prefixed new-file body with byte/line sub not built. |
| Messages.jsx | DiffView — word-level intra-line diff (`Diff.diffWordsWithSpace`) | Raw +/- lines only; no intra-line word highlighting. |
| Messages.jsx | DiffView — dual old/new gutter line numbers + +/- count header | Paired gutters + +adds/-dels file-header counts not built. |
| Messages.jsx | GrepCard — results list / grouped patterns | Grep/Glob renders as generic card; results-count + grouped-pattern list not built. |
| Messages.jsx | WebCard — WebFetch/WebSearch (status·content-type·size) | web-specific sub-header not built. |
| Messages.jsx | McpCard — server › tool call/resource | server›tool framing + result coloring not built. |
| Messages.jsx | NotebookCard — cell index + cell diff | cell[n]+diff view not built. |
| Messages.jsx | LspCard — diagnostics list with severity dots (`FEDiag`) | severity-dot diagnostics list not built. |
| Messages.jsx | SkillCard — skill source badge + activity | source/plugin sub not built. |
| Messages.jsx | GenerateImageCard — inline image + spec chips + saved-path/Open/Copy | The core GUI-over-TUI win (real inline image): image tile, size/quality chips, saved-path, Open/Copy actions unbuilt. Result fields (filePath/model/size) are real source but nothing renders them. |
| Messages.jsx | ThinkingBlock — reasoning block (expand/collapse, eyebrow, prose) | Data built (incl. Codex reasoningKind); thinking block VISUAL not rendered. No owner. |
| Messages.jsx | RedactedThinkingBlock — encrypted-thinking placeholder | Data built; lock-icon 'redacted' row not rendered. |
| Messages.jsx | SessionInitRow — session-start banner (cwd/model/tools/version) | Data built (cwd/model/tools/mode); ✦ started banner not rendered. |
| Messages.jsx | ResultRow — turn/session-end seam (subtype + duration) | Data built (subtype/isError/durationMs/cost); completed/errored divider not rendered. |
| Messages.jsx | CompactBoundaryRow — ✻ conversation-compacted seam | Data built (trigger/preTokens); compaction seam not rendered. |
| Messages.jsx | TurnDurationRow — ◷ worked-for duration seam | `turn_duration` system subtype is neither projected nor rendered — dropped. No owner. |
| Messages.jsx | InterruptedRow — "Interrupted · what should Claude do instead?" | The synthetic INTERRUPT carrier is suppressed at the projector; no interrupted seam renders. Real interruption identity lost at the seam. Unowned. |
| Messages.jsx | SystemNoticeRow — api_retry / local_command_output / account_diagnostic | Data built for exactly these 3 noticeTypes; the notice box (icon tone + tag) not rendered. |
| Messages.jsx | SystemNoticeRow — other subtypes (memory_saved/agents_killed/bridge_status/scheduled_task_fire/permission_retry/stop_hook_summary/api_error/away_summary) | 8 prototype SystemNotice subtypes neither projected nor rendered; real source subtypes exist but unmapped at the seam. Unowned. |
| Messages.jsx | MemorySavedRow — ✦ saved-to-memory row | Not projected/rendered. Memory PAGE is `phase4.md P4-10` but that owns the page, not this transcript seam — no confirmed owner for the row. |
| Messages.jsx | CommandEchoRow — /command echo (user-side) | Data UNIQUELY built (projector special-cases this tag) yet unrendered — clearest data-vs-view gap. |
| Messages.jsx | LocalCommandRow — ! local-command output | Data partially projected, not rendered; live identity degraded per P2-1. Unowned. |
| Messages.jsx | MemoryInputRow — # user-memory-input echo | Real ungated source tag but `<user-memory-input>` not parsed → degrades to plain user-text (itself unrendered). Unowned. |
| Messages.jsx | ResourceUpdateRow — ↻ MCP resource/polling update | `<mcp-resource-update>`/`<mcp-polling-update>` not parsed, not rendered. Niche; unowned. |
| Messages.jsx | AdvisorRow — advisor `server_tool_use` + `advisor_tool_result` (folded) | Degrades to a generic 'other' card with no correlated result; advisor advising/done/redacted/error states missing. Unowned. |
| Messages.jsx | TaskAssignRow — ◆ task-notification assignment | Not projected/rendered. Tasks is `phase4.md P4-9` but that owns the panel, not this transcript notice row — no confirmed owner for the row. |
| Messages.jsx | HookProgressRow — live Hook progress leg | Live ProgressMessage (excluded from persistence upstream); no app-seam projection/render. Would need a live-status seam. Unowned. |
| Messages.jsx | UserImageRow — pasted image content block | Data built (image source narrowing); thumbnail (+caption) not rendered. Unowned. |
| Messages.jsx | ApiErrorRow — API error banner + Retry + raw-details expand | Real API-error identity partially reaches the seam but nothing renders it, and there is no Retry affordance. BannerStack (P4-1) not wired to transcript API errors. Unowned. |
| Messages.jsx | SystemMsg — plain centered divider | Minor generic hairline+label divider not built; low value, unowned. |
| Messages.jsx | ReadGroupRow — expand-to-content read row (3rd disclosure level) | GUI-native 3rd disclosure level beyond source (source Read renders 'Read N lines' only). Unbuilt, unowned. |
| Chat.jsx | Transcript-mode 'Hidden' reveal toggle (eye icon, only when meta rows exist) | Real engine hides `isMeta`/`isVisibleInTranscriptOnly` rows; no reveal toggle built and no P4 owner. DANGER. |
| Chat.jsx | Meta-row dimmed rendering when revealed (opacity 0.55) | Tied to the unowned Hidden toggle; no meta-reveal styling in `TranscriptView.tsx`. DANGER. |
| Chat.jsx | Jump-to-bottom '↓ Latest' button | No jump/scroll control in `TranscriptView.tsx` and no P4 owner. DANGER. |
| Chat.jsx | Jump button running-cue variant (verb/elapsed/paused while generating) | Off-screen running cue; tied to the missing jump button + missing activity state. DANGER. |
| Chat.jsx | Auto-scroll stick-to-bottom + reveal-jump on scroll-up (`onScroll`/`stickRef`) | No scroll-stick logic in the renderer transcript. DANGER. |
| Chat.jsx | Instant-jump on session open vs smooth-scroll on live turn | Part of the unowned scroll UX. DANGER. |
| Chat.jsx | `SpinnerWithVerb` live activity row (verb + elapsed + token byline above composer) | P2-3 (✅, `STATUS.md:86`) shipped streaming DATA only; the activity-VISUAL half of INVENTORY W3 (`INVENTORY.md:62`) was never built or re-owned. DANGER — top of list. |
| Chat.jsx | `WaveDots` pulse animation + phase tone colors | Part of the missing activity indicator; tool-color map is cosmetic fixture. DANGER. |
| Chat.jsx | Activity phase mapping (connecting/thinking/tool/responding/idle) | Real `SpinnerMode` phases exist engine-side but no renderer maps them to a visible indicator. DANGER. |
| Chat.jsx | Elapsed timer + verb (playful/plain) | No elapsed timer in renderer; playful verbs are cosmetic fixture, the elapsed indicator is the real gap. DANGER. |
| Chat.jsx | Live per-turn token byline '(Ns · ↕ N tokens)' | Real per-turn output estimate exists engine-side (SOURCE `SpinnerAnimationRow.tsx:160`) but nothing surfaces it. DANGER. |
| Chat.jsx | Run tally (files changed / +added / −removed) | Prototype values are demo; the diff-stat run-tally indicator itself is unowned. DANGER. |
| Chat.jsx | Paused-on-permission activity state ('Waiting for your approval') | Permission round-trip is real (P2-4) but this paused-activity cue is part of the unbuilt spinner. DANGER. |
| Chat.jsx | Stop button / interrupt affordance while generating | `bridge.abort`/`app.abort` capability exists at the boundary but NO renderer UI control or keybinding calls it (rg empty in `App.tsx`). Genuine interrupt gap. DANGER. |
| Chat.jsx | Composer action: Add-attachment button | Real image/file attach (`imagePaste.ts`) unbuilt; P4-0 scope is @-mention/paste/history only. DANGER (low-confidence — stub in prototype too). |
| Permissions.jsx | AskUserQuestion — header chip + question text + multi-question stepper dots | DANGER. `AskQuestionFlow` wraps a REAL engine tool (`AskUserQuestionTool`); zero hits for it in `docs/migration/` (INVENTORY/STATUS/phase4). |
| Permissions.jsx | AskUserQuestion — option rows (label + description, 1-9 pick, active/checked) | DANGER. No AskUserQuestion renderer in `app/renderer/src`; not owned in `phase4.md`. |
| Permissions.jsx | AskUserQuestion — multi-select toggle (checkbox, space-toggle, joined answer) | DANGER. Real tool `outputSchema` joins multi answers; interaction seam not migrated. |
| Permissions.jsx | AskUserQuestion — built-in "Other…" freeform answer row | DANGER. No freeform answer input for this flow; unowned. |
| Permissions.jsx | AskUserQuestion — per-option preview badge + preview pane | DANGER. No preview pane implementation; unowned. |
| Permissions.jsx | AskUserQuestion — footer rail (Next question / Submit, key hints, Cancel/esc) | DANGER. The answer-submission action that would send the tool result is unbuilt. |
| Permissions.jsx | AskUserQuestion — dedicated keyboard handler (space toggle, advance, Esc reject) | DANGER. `App.tsx` permission keydown has no AskUserQuestion mode; unowned. |
| PermissionRules.jsx | Match-type label per row (exact/prefix/wildcard) | Derived annotation, renderer-computable; silently dropped, unowned, uncut — minor but flagged. |
| PermissionRules.jsx | Managed-rules-only enforcement toggle (disabled, policy-managed) | Real engine concept (managed-policy enforcement) not on C3 wire and unowned — genuine silent drop of a real capability. |
| PermissionRules.jsx | Classifier & debugging — Permission classifier toggle | Real setting (`TRANSCRIPT_CLASSIFIER`) — genuine dropped control, not editor/debug/denial chrome, unowned + uncut — flagged. |
| CommandPalette.jsx | 'Recent' commands section (label + recent rows) | DANGER: proto recents fed by mock `window.RECENT_COMMANDS` (`CommandPalette.jsx:122`); no recents render/store in real app; D5/P4-17 recents = welcome-launcher PROJECTS, not palette commands. |
| CommandPalette.jsx | Recent-section divider rule | Sub-element of the missing Recent section (`CommandPalette.jsx:261`). |
| SlashCommandPicker.jsx | Footer keyboard-hint bar container | DANGER ROW. Prototype footer (`SlashCommandPicker.jsx:163-170`) is unrendered — tsx component ends at the `<ul>` (`SlashCommandPicker.tsx:163`). No owner in `phase4.md`, no cut in `decisions/`, not covered by the metadata-only enrichment proposal. Shortcuts work (`App.tsx:1009-1032`) but the visual affordance was silently dropped. |
| SlashCommandPicker.jsx | Footer kbd chips (↑↓ navigate / ↵ select / esc dismiss) | DANGER ROW. The three `<kbd>` hint chips (`SlashCommandPicker.jsx:171-185`) exist nowhere in tsx; no decision cuts them, enrichment proposal is metadata-only. Same finding class as the 2026-07-07 Sidebar chrome misses. |
| Settings.jsx | SwToggle control primitive | Value-editor control; not in real files; used only by unbuilt panels; no named P4-N owns core value editors. |
| Settings.jsx | SwSelect control primitive | Same danger cluster as SwToggle. |
| Settings.jsx | SwText control primitive (+ mono/error variants) | Same danger cluster as SwToggle. |
| Settings.jsx | General ▸ Display name field | Stubbed, unowned; verify cat-code exposes display-name as a GUI setting. |
| Settings.jsx | General ▸ Default editor select | Value editor, unowned. |
| Settings.jsx | General ▸ On startup select | Value editor, unowned. |
| Settings.jsx | General ▸ Update channel select (flag-source, non-resettable) | Flag-override + reset toast; `editable` gating exists but field unbuilt/unowned. |
| Settings.jsx | General ▸ Max output tokens + ceiling/number validation | `maxErr` validation logic (`Settings.jsx:165`) is unbuilt value-editor code; unowned. |
| Settings.jsx | General ▸ Anonymous telemetry (managed toggle, disabled) | Managed pattern proven in ManagedPanel; this in-general field unbuilt/unowned. |
| Settings.jsx | General ▸ Co-author attribution toggle | Value editor, unowned. |
| Settings.jsx | Model ▸ Default model select | Value editor (mock model list), unowned. |
| Settings.jsx | Model ▸ Reasoning effort select | Value editor, unowned. |
| Settings.jsx | Model ▸ Always-on thinking toggle | Value editor, unowned. |
| Settings.jsx | Model ▸ Fast mode toggle | Value editor, unowned. |
| Settings.jsx | Model ▸ Show thinking summaries toggle | Value editor, unowned. |
| Settings.jsx | Model ▸ Auto-compact context toggle | Real engine has autocompact but no GUI editor; unowned. |
| Settings.jsx | Privacy ▸ Conversation retention select | Value editor, unowned. |
| Settings.jsx | Privacy ▸ Share session data toggle | Value editor, unowned. |
| Settings.jsx | Privacy ▸ Crash reporting (managed toggle) | Managed rendering proven in ManagedPanel; this field unbuilt/unowned. |
| Settings.jsx | Theme ▸ OutputPreview live code canvas | Live-preview reusing Messages CODE_THEMES/highlightWithPrism; unowned, likely adapt/cut once real theming source found. |
| Settings.jsx | Theme ▸ Accent color swatch picker | Value editor (drives `--accent`), unowned. |
| Settings.jsx | Theme ▸ Syntax highlighting toggle | Value editor, unowned. |
| Settings.jsx | Theme ▸ Code theme select | Value editor (localStorage-backed in prototype), unowned. |
| Settings.jsx | Theme ▸ Code font select | Value editor, unowned. |
| Settings.jsx | Theme ▸ Output style select + description | Over a REAL engine feature (`src/constants/outputStyles.ts`), no GUI editor; strong candidate for a named owner. |
| Settings.jsx | Keybindings ▸ Vim mode toggle | Value editor, unowned. |
| Settings.jsx | Keybindings ▸ Shortcuts reference list (6 bindings) | Mock display list; real `~/.claude/keybindings.json` exists but no GUI; unowned. |
| Settings.jsx | Keybindings ▸ 'Custom keymap not available yet' note | Even prototype stubs it; unowned in migration. |
| Settings.jsx | IDE ▸ Editor connection card (icon/name/status/url) | Real shapes exist (`useIdeConnectionStatus.ts`) but MOCK data; no named owner. |
| Settings.jsx | IDE ▸ status pill (connected/pending/connecting/disconnected) | IdeStatusPill states unowned. |
| Settings.jsx | IDE ▸ Connect / Disconnect button | Action buttons (toast-only in prototype); unowned. |
| Settings.jsx | IDE ▸ Open file button (disabled unless connected) | Unowned. |
| Settings.jsx | IDE ▸ Diagnose button | Unowned. |
| Settings.jsx | IDE ▸ Auto-connect toggle | Unowned. |
| Settings.jsx | IDE ▸ Auto-install extension toggle | Unowned. |
| Settings.jsx | IDE ▸ Editor extension field (Up-to-date / Install) | Unowned. |
| Settings.jsx | IDE ▸ 'Also detected' inactive-IDE list | Backed by `detectIDEs`/DetectedIDEInfo; unbuilt/unowned. |
| Settings.jsx | LSP ▸ section status pill + error/warning counts | MOCK_LSP data; unowned. |
| Settings.jsx | LSP ▸ per-server rows (dot/name/langs/state/restart/…) | Backed by `LSPServerInstance.ts`; one row covers per-server sub-elements; unowned. |
| Settings.jsx | LSP ▸ Recent diagnostics list (severity/message/uri:line/source) | DIAG_SEV taxonomy; unowned. |
| MemoryPage.jsx | "Agent memory" section — per-agent memory dirs, "N agent(s)" | No per-agent memory in real `MemorySnapshot` (types = Managed/User/Project/Local/AutoMem/TeamMem only, `protocol.ts:429-434`); not covered by P4-10 §0 flags. Likely `MOCK_MEMORY.agentMemory` invention — needs human ruling (cut-as-mock vs real gap). |
| MemoryPage.jsx | Per-agent rows — `AgentTypeChip` + dir + "N file(s)" (+ plain-text fallback) | Sub-elements of the unowned Agent-memory feature above; no real per-agent memdir state to bind to. |
| FLOW 3 permission-roundtrip | "Reject all" / abort-the-turn mass-deny button | C4 rules `app.abort` AS the mass-deny mechanism, but no UI button is wired and no P4-N owns a Stop/Reject-all control. Mechanism is one line from working. |
| FLOW 3 permission-roundtrip | AskUserQuestion rich flow (1-4 questions, multiSelect, built-in "Other" freeform, preview-on-focus, Next/Submit) | UNCERTAIN whether AskUserQuestion routes through `permission.requested` (it is its own tool, `src/tools/…AskUserQuestionTool`). If it does, it degrades to a raw JSON dump; if it routes elsewhere it has no surface. Needs recon + owner. |
| FLOW 7 resume-cross-project | Stable row order on restore/open (row must NOT move when a session is restored or opened) | THE DANGER ROW. A real prototype UX invariant is violated with no fix owner. Correct spec: reorder ONLY on message-sent — needs a last-activity signal absent from `SessionDescriptor` + shell state today. |
| FLOW 8 settings-edit | Edit a value control (toggle/select/text) → local state | DANGER: general/model/privacy/theme/keybindings have NO concrete P4-N owner (P4-12 is Extensions only). The core built-in edit interaction is unowned. |
| FLOW 8 settings-edit | Inline validation of an edited value (max-tokens ceiling / NaN) | Presentation half built; validation BEHAVIOR unbuilt + unowned. Real validators `src/utils/settings/` unreachable from the app. |
| FLOW 8 settings-edit | IDE & LSP panel edit (connect/disconnect, auto-connect toggles, LSP restart) | No concrete P4-N owns IDE/LSP settings; not P4-12, not cut. Real IDE status is MCP-client-derived but unreached. Danger-list. |

---

## Part D — Parity metrics

Counts are table rows per disposition. **In-scope** = built + adapted + deferred + ❓ (the
prototype elements that are parity targets); it **excludes** ✂️ cut (decided not to migrate)
and ➕ real-added (not a prototype element). **Realized%** = (built + adapted) ÷ in-scope —
the fraction of in-scope prototype elements already built or adapted. Phase-4 gate target ≈ 80%.

### Per surface

| # | Surface | ✅ | 🔁 | ➕ | ⬜ | ✂️ | ❓ | Rows | Realized% |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|
| 01 | AppV2 | 16 | 20 | 5 | 21 | 6 | 0 | 68 | 63% |
| 02 | Sidebar | 23 | 8 | 5 | 10 | 4 | 0 | 50 | 76% |
| 03 | TabBar | 22 | 13 | 8 | 1 | 0 | 0 | 44 | 97% |
| 04 | WorkspaceLayout | 17 | 12 | 8 | 3 | 0 | 0 | 40 | 91% |
| 05 | Messages | 3 | 10 | 1 | 0 | 12 | 49 | 75 | 21% |
| 06 | Chat | 9 | 9 | 2 | 40 | 6 | 15 | 81 | 25% |
| 07 | Permissions | 12 | 25 | 3 | 6 | 8 | 7 | 61 | 74% |
| 08 | PermissionRules | 1 | 11 | 4 | 0 | 21 | 3 | 40 | 80% |
| 09 | CommandPalette | 26 | 19 | 2 | 5 | 6 | 2 | 60 | 87% |
| 10 | SlashCommandPicker | 20 | 9 | 3 | 6 | 0 | 2 | 40 | 78% |
| 11 | Settings | 35 | 5 | 3 | 9 | 2 | 40 | 94 | 45% |
| 12 | Surfaces | 29 | 15 | 4 | 33 | 6 | 0 | 87 | 57% |
| 13 | AgentIdentity | 25 | 5 | 7 | 18 | 4 | 0 | 59 | 62% |
| 14 | Pages | 0 | 0 | 0 | 66 | 15 | 0 | 81 | 0% |
| 15 | AccountLifecycle | 0 | 0 | 0 | 44 | 2 | 0 | 46 | 0% |
| 16 | SessionsPage | 0 | 0 | 0 | 62 | 0 | 0 | 62 | 0% |
| 17 | SessionActions | 0 | 0 | 0 | 65 | 2 | 0 | 67 | 0% |
| 18 | MetadataInspector | 0 | 0 | 0 | 61 | 1 | 0 | 62 | 0% |
| 19 | AgentsPage | 32 | 5 | 8 | 0 | 4 | 0 | 49 | 100% |
| 20 | OrchestratorMode | 0 | 3 | 0 | 54 | 11 | 0 | 68 | 5% |
| 21 | TasksPage | 0 | 4 | 4 | 33 | 3 | 0 | 44 | 11% |
| 22 | GoalsPage | 11 | 21 | 6 | 26 | 4 | 0 | 68 | 55% |
| 23 | MemoryPage | 9 | 11 | 7 | 5 | 7 | 2 | 41 | 74% |
| 24 | PlanPanel | 0 | 0 | 1 | 57 | 0 | 0 | 58 | 0% |
| 25 | SettingsExtensions | 0 | 0 | 0 | 76 | 2 | 0 | 78 | 0% |
| 26 | RemoteSettings | 0 | 4 | 0 | 26 | 14 | 0 | 44 | 13% |
| 27 | Startup | 0 | 2 | 1 | 41 | 12 | 0 | 56 | 5% |
| 28 | ResumeStates | 20 | 7 | 3 | 0 | 9 | 0 | 39 | 100% |
| 29 | Welcome | 0 | 6 | 0 | 41 | 5 | 0 | 52 | 13% |
| 30 | ConnectionDemo | 0 | 0 | 1 | 0 | 9 | 0 | 10 | — |

### Per flow

| # | Flow | ✅ | 🔁 | ➕ | ⬜ | ✂️ | ❓ | Rows |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| 1 | first-run | 0 | 1 | 1 | 16 | 5 | 0 | 23 |
| 2 | session-lifecycle | 7 | 3 | 12 | 4 | 1 | 0 | 27 |
| 3 | permission-roundtrip | 12 | 6 | 3 | 2 | 1 | 2 | 26 |
| 4 | multi-session | 6 | 10 | 4 | 1 | 0 | 0 | 21 |
| 5 | orchestrator-nesting | 3 | 2 | 1 | 10 | 5 | 0 | 21 |
| 6 | accounts-reauth | 3 | 0 | 3 | 8 | 1 | 0 | 15 |
| 7 | resume-cross-project | 0 | 2 | 5 | 7 | 3 | 1 | 18 |
| 8 | settings-edit | 7 | 2 | 2 | 3 | 2 | 3 | 19 |

### Totals

| Scope | ✅ built | 🔁 adapted | ➕ real-added | ⬜ deferred | ✂️ cut | ❓ missing | Rows | In-scope | Realized% |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Surfaces (30) | 290 | 217 | 86 | 845 | 166 | 120 | 1724 | 1472 | 34% |
| Flows (8) | 38 | 26 | 31 | 51 | 18 | 6 | 170 | 121 | 53% |
| **Total** | **328** | **243** | **117** | **896** | **184** | **126** | **1894** | **1593** | **36%** |

_Realized% is low by design: 845 in-scope surface elements are ⬜ deferred to unbuilt Phase-4
sessions (P4-5…P4-17). The gate rises as those land; the 126 ❓ must first be given owners or
waived so the denominator is honest._
