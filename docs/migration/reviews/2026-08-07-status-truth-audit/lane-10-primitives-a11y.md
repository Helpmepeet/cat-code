# Lane 10 — Primitives, shell fidelity, and accessibility

**Auditor verdict:** YELLOW
**Rows audited:** 11 · TRUE 6 · OVERSTATED 3 · FALSE 0 · STALE 2 · UNVERIFIABLE-HEADLESS 0

Six of eleven rows carry a `🟡`/`🔁` marker that already reserves operator GUI
acceptance, so this lane audits the built-and-wired half those rows claim, and
says so per row. Two rows describe layouts/features that later commits changed
out from under them; neither STATUS row was updated.

---

## Row verdicts

### P4-1 — Shared primitive kit + ConnectionChip (✅ 2026-07-07)
**Verdict:** OVERSTATED

**Claims checked:**
1. Chip / ChipStrip / BannerStack / ToastHost / MentionPicker / ToolInspector built.
2. "real `ConnectionChip` (cut `ConnectionDemoBar`)"; "ConnectionChip reads real `ConnectionSnapshot` (no simulator)".
3. Built on P0-2 `--tone-*` via shared `tone.ts` (JIT-safe literals).
4. ToastHost is a real provider mounted at `main.tsx` root, replacing `window.toast`.
5. ToolInspector narrows real `ToolUseRow` tolerantly, zero casts.
6. `--color-surface-raised` / `--color-surface-panel` tokens + toast keyframe added.

**Evidence:**
- Claim 3 holds and is the strongest part of the row: `app/renderer/src/tone.ts:44-99` is a fully enumerated `Record<Tone, ToneClasses>` of literal class strings, with the `hover:` variant pre-composed at `:39` precisely so nothing is runtime-prefixed. No interpolated arbitrary-value class exists anywhere in the production renderer (swept; every `text-[${hex}]` hit in `app/renderer/src` is a comment warning against the trap).
- Claim 4 holds: `app/renderer/src/main.tsx:26` wraps `<App/>` in `<ToastHost>`; `toastContext.ts:13` degrades with a warning outside it.
- Claim 5 holds: zero `as <Type>` casts in `ToolInspector.tsx` / `toolInspectorModel.ts`.
- Claim 1 holds for five of six. **`ChipStrip` is dark today**: `Chip.tsx:98` exports it, `Chip.test.tsx:50-68` tests it, and there is **zero** production `<ChipStrip` call site. The composer rail that was supposed to consume it (§0 flag "composer `ChipStrip`→P4-0") was built as its own component instead (`ComposerActionsBar.tsx:35` cites `ChipStrip` in a comment and reimplements the rail).
- Claim 2 fails. **`ConnectionChip` does not exist anywhere in `app/`.** Its whole life: created `2209808` (P4-1), touched `8a0f4f8`, deleted `ed741a2` (2026-07-21) — "delete dark ConnectionChip (audit ruling #6, waived)". `STATUS.md:49` (CC-5) records the reason in its own words: *"§I.5 ConnectionChip deleted (ruling #6, dark/never-mounted)"*. So the component this row names in its title was never mounted at the moment the ✅ was written, and is now gone.

**Reachable-path trace:** Chip → `RemoteSettingsPage.tsx:90`, `SessionsPage.tsx:682` (mounted views). BannerStack → `App.tsx:3398`. MentionPicker → `App.tsx:4377`. ToolInspector → `TranscriptView.tsx:385`. ToastHost → `main.tsx:26`. ChipStrip → **no consumer**. ConnectionChip → **no file**.

**Anchor drift:** the row cites no `file:line`, so no anchor drift; the drift is in the artifact list.

---

### P4-2 — AgentIdentity vocabulary (✅ 2026-07-07)
**Verdict:** TRUE

**Claims checked:**
1. Pure vocabulary module over verified-real engine shapes.
2. `deriveAgentModeWorkerState` mirrors the engine's `getWorkerStatusLabel` guard + fall-through (prior + `resumable === undefined` no longer forced to `stale`).
3. Backgrounded-running → `background`.
4. `stateFromTaskStatus` gained a default arm.
5. ⚠ two-strikes: `waiting` unreachable, wire-or-delete at P4-8.

**Evidence:**
- Claim 2: `agentIdentity.ts:339-345` — `origin==='prior' && resumable===true → 'resumable'`, `=== false → 'stale'`, `undefined` falls through to the status arms. The engine contract it mirrors is pinned by `src/agent-mode/workerUxSummary.test.ts:89-111` (`result ready` / `reviewed` / `attention` / `running` / `resumable` / `stale`), and the renderer arms at `:341-345` reproduce that exact order.
- Claim 3: `agentIdentity.ts:367-369`.
- Claim 4: `stateFromTaskStatus` at `:428`, reached from all four `deriveTaskAgentState` arms (`:373,380,387,390`).
- Claim 5 is **resolved**, not outstanding: `orchestratorState.ts:84` returns `'waiting'` when an orchestrator owns a blocked handoff (`active`), and `agentIdentity.ts:359-361` documents the wiring. The dead `blockedOwner` arm was deleted (B6). The row's ⚠ is stale in the reader's favour.

**Reachable-path trace:** engine worker/task shapes → `deriveAgentDisplayVocabulary` (`:417`) → consumed by 10 production modules: `AgentChrome.tsx`, `TranscriptView.tsx`, `TasksDialog.tsx`, `OrchestratorRoster.tsx`, `MemoryPage.tsx`, `orchestratorState.ts`, `tasksState.ts`, `agentChromeModel.ts`, `workerInspection.ts`.

**Anchor drift:** none.

---

### P4-3 — Settings shell + Field/SourceBadge/ManagedBadge (✅ 2026-07-07)
**Verdict:** TRUE

**Claims checked:**
1. Read-seam is a `settings.snapshot` outbound frame built sidecar-side.
2. **Review fix:** the seam no longer calls `getSettingsWithSources()` (whose first line `resetSettingsCache()` wiped the engine's process-global cache on every attach); it reads once at spawn via `getSettingsForSource` per enabled source in canonical `SETTING_SOURCES` precedence.
3. Secret-safe by construction: model only, no values; `resolved` is an ARRAY so setting names ride as string values.
4. Field API = `Field` / `SourceBadge` / `ManagedBadge` / `PaneSection`, consumed by P4-12.
5. `SourceBadge` renders nothing on an absent source instead of a fabricated "User" (B5).

**Evidence:**
- Claims 1+2: `app/sidecar/settingsDomain.ts:8-10` states the constraint and names the hazard; `:372-374` is the loop — `for (const source of SETTING_SOURCES) { … getSettingsForSource(source) }`. `getSettingsWithSources` appears only in comments (`:9,139`). The hazard it avoids is real and current: `src/utils/settings/settings.ts:936-939` still opens with `resetSettingsCache()`.
- Claim 4: `SettingsField.tsx:80` `SourceBadge`, `:116` `ManagedBadge`, `:134` `Field`, `:199` `PaneSection`; consumed by **8** production modules (`SettingsShell`, `SettingsEditors`, `SettingsExtensions`, `PermissionRulesEditor`, `AgentsPage`, `DiagnosticsSection`, `WorkspaceTrustSection`, `RemoteSettingsPage`, `MetadataInspector`) — well past the one consumer the row promised.
- Claim 5: `SettingsField.tsx:167` renders `SourceBadge` only inside the origin branch.

**Reachable-path trace:** sidecar `settingsDomain` snapshot → `settings.snapshot` frame → `settingsState.ts` reducer → `SettingsShell` mounted at `App.tsx:3218` under `activeView === 'settings'` (`App.tsx:3217`), reachable from the sidebar nav (`Sidebar.tsx:59` — all five destinations wired).

**Anchor drift:** STATUS cites `settings.ts:924` for `getSettingsWithSources`; actual is `src/utils/settings/settings.ts:936`. Low.

---

### P4-4 — Shell-fidelity true-up: Sidebar/TabBar/shell/WorkspaceLayout (✅ 2026-07-07)
**Verdict:** OVERSTATED (Sidebar half superseded)

**Claims checked:**
1. Sidebar rebuilt to `Sidebar.jsx` grammar: hover-expand rail 48px → 240px, pin, PawLogo, session search, workspace grouping by cwd, nav destination rail.
2. **"Chat wired/active; Sessions/Goals/Accounts/Settings DISABLED + flagged (unbuilt)."**
3. TabBar gains the prototype Split/Unsplit cluster as additive optional props reusing `splitWorkspacePanel`/`closeWorkspacePanel`.
4. WorkspacePanels header gains the project/cwd pill (real cwd basename).
5. `theme.css` +1 token `--accent-soft` #f9a8d4.
6. Fidelity delta landed: selected-row pink border, visible row-hover, identity-first rebalance.

**Evidence:**
- Claims 3-5 hold cleanly and are the durable part of this row: `TabBar.tsx:160-177` Split/Unsplit cluster with `SplitIcon`/`UnsplitIcon` (`:187,208`); `WorkspacePanels.tsx:290` project pill over `basename` (`:14,439-443`); `theme.css:55` `--accent-soft: #f9a8d4`, surfaced as `--color-accent-soft` at `:150` and per-accent-theme at `:91,96,101,106`.
- Claim 1 holds *as geometry* (`Sidebar.tsx:2` header, `:696` `w-12` spacer, `:736` `w-60` open, `:749` `PawLogo`, `:786` search) — but the file is now 2,219 lines and was rebuilt from a **different design source** by P4-61, so "trued up to the prototype `Sidebar.jsx`" no longer describes what ships.
- Claim 2 is **stale**: `Sidebar.tsx:59` — *"All five nav destinations are wired: Chat, Sessions (P4-6a), Goals, …"*. The `!item.enabled` disabled branches (`:1852-1871`, `:1911-1924`) are now unreachable for every shipped destination.
- Claim 6's fidelity deltas cannot be separated from P4-61's later restyle of the same rows; not independently confirmable from source.

**Reachable-path trace:** `<Sidebar>` mounted `App.tsx:2913`; `<TabBar>` and `<WorkspacePanels>` in the workspace frame. All reachable.

**Anchor drift:** the row's one live anchor, `Sidebar.tsx:354` (invisible 6%-alpha row-hover), points at unrelated code today.

---

### P4-61 — Sidebar rebuilt from the operator's Claude Design source (🟡 2026-08-01)
**Verdict:** OVERSTATED — one whole feature block in this row was reverted five days ago and the row still describes it as built

**Claims checked:**
1. `New chat` action above the list.
2. `Pinned` section lifting a pinned session out of its group, own manual reorderable order.
3. `Projects` header `+` = add-project via the native picker.
4. Per-row pin + existing ⋮ in a right-edge overlay; actions backing hover/focus-only.
5. Footer: active account (avatar + alias, links to Accounts) with five destinations folded behind a toggle unfolding upward; collapsed rail keeps all five as icons.
6. Pins renderer-local (`sidebarPinnedSessions.ts`); no protocol frame / preload channel / registry field / host verb added; `New chat` and group `+` route through existing `createSessionInWorkspace(repId)` (HC1/T8).
7. **"Session rows inside a project are drag-reorderable too" — `sidebarSessionOrder.ts` namespaces order by cwd; ranked rows hold their slot; unranked rows sit above the arranged block; the first drag freezes the group.**
8. **"All three reorder gestures in the rail (workspace headers, Pinned, project rows) now share one drop-edge rule, one keyboard path (⌥↑/⌥↓) and one row-handler shape … kept apart by four distinct drag payload types (`text/workspace-cwd`, `text/pinned-session-id`, `text/sidebar-session-id`, `text/sessionId`)."**
9. A project can be REMOVED (hidden) from the rail; `sidebarHiddenWorkspaces.ts`; "Show N hidden projects".
10. Every new arbitrary-value class confirmed present in the built CSS.

**Evidence:**
- Claims 1-6 and 9 hold. `Sidebar.tsx:797-810` New chat; `:817-852` Pinned section with `pinnedReorderHandlers` and `selectPinnedDropEdge`; `:858-873` Projects header + add-project button; `:963-1037` footer with account and the destination toggle (`:994` `aria-label` "Hide/Show destinations", `:1013` comment on inert-while-folded); `sidebarPinnedSessions.ts` and `sidebarHiddenWorkspaces.ts` both present with the versioned-JSON idiom. All of it is wired from `App.tsx:2913-2943` — `onNewChat` (`:2934`), `onAddProject` → `newSession()` picker (`:2938`), `onNewSessionInWorkspace(repId)` (`:2933`, a registry id, HC1 intact), `accountAlias` (`:2939`).
- Claim 4's caught defect is real and fixed in CSS, not a class: `theme.css:273-303` paints `.sidebar-row-actions` backing only under `.group:hover`, `.group:focus-visible`, `:focus-within`, with the reason stated at `:262-266`.
- Claim 10 spot-confirmed against the emitted stylesheet `app/renderer/dist/assets/index-BALh8Yxq.css`: `z-\[210\]`, `grid-rows-`, and the reduced-motion rule all present.
- **Claims 7 and 8 are false against HEAD.** `sidebarSessionOrder.ts` does not exist. Commit `6d90f5f` (2026-08-02, "drop in-group session reordering, keep Pinned as the one manual order") deleted the module and its 20-test suite, unwired `rowReorder`/`rowDrag` from `Sidebar.tsx`, and made project rows no longer drag handles — because the stored order capped at 64 ids and cat-code's 168-session project surfaced its 104 oldest rows above its 64 newest. Today only **three** drag payload types exist: `text/workspace-cwd` (`sidebarWorkspaceOrder.ts:53`), `text/pinned-session-id` (`sidebarPinnedSessions.ts:52`), `text/sessionId` (`TabBar.tsx:273`). `text/sidebar-session-id` is gone; `rg` finds `sidebarSessionOrder` only in `Sidebar.test.tsx`. The STATUS row still quotes the operator's request ("we can drag the session in the claude design but still cant in app") and answers it as delivered.

**Reachable-path trace:** `MergedSessionRow[]` → `Sidebar` (`App.tsx:2913`) → rendered when `open` (`Sidebar.tsx:408` `selectSidebarOpen`), reached by hover, pin, or keyboard focus. Pin/hide state is renderer-local storage, no wire surface — confirmed, no new inbound vocabulary.

**Anchor drift:** the row cites almost no `file:line`, so the drift here is a deleted module named as shipped.

---

### P4-49 — No connection tone grammar; the bar prints a raw status word (🟡 2026-07-31)
**Verdict:** TRUE (headless half; the row reserves GUI acceptance itself)

**Claims checked:**
1. `ConnectionRecovery`'s failure presentation is gated on `connectionTone(status) === 'danger'`.
2. `connectionTone` is `isTerminalConnectionStatus(status) ? 'danger' : 'neutral'` with **no second switch**.
3. Two tones only; the transient tone is the ABSENCE of a bar, so nothing new mounts.
4. `Session {status}.` is replaced by four `connectionRecoveryMessage` sentences.
5. No sentence contains a status word or an em dash.
6. Bound respected: no dot, no chip, no `ConnectionChip.tsx`, fenced files untouched.

**Evidence:**
- Claims 1-3: `connectionState.ts:145-149` is a one-line derivation from `isTerminalConnectionStatus` (`:70-93`, own `never` tripwire at `:89`). `App.tsx:4656-4658` — `const tone = connectionTone(...)`; `if (!sessionId || tone !== 'danger' || message === null) return null`. There is genuinely no second switch and no per-state colour vocabulary; the whole bar is one `text-tone-danger` (`App.tsx:4663`).
- Claim 4: `connectionState.ts:172-179` carries all four sentences verbatim as STATUS quotes them. The `parked` member added later (IDLE-PARK) correctly returns `null` (`:170-171`) and classifies non-terminal (`:81-82`), so the grammar absorbed a new union member without an author picking a colour — the row's stated design goal, now actually exercised.
- Claim 5 verified repo-wide, not just in this file: `rg -n '—' app/renderer/src --glob '!*.test.*'` yields **zero** hits in a user-visible string. Every hit is a code comment or a JSX comment; the only string-literal hits are `sdkMessageFixtures.ts` fixture `name` fields, which have no production consumer (`transcriptProjector.ts:16,889` and `contextUsage.ts:48` reference the file only in comments). No `'—'` no-value placeholder literal exists in production.
- Claim 6: no `ConnectionChip` file or symbol anywhere in `app/`. The tone tokens the bar resolves against are correct in `theme.css`: `--tone-good #4ade80`, `--tone-warn #fbbf24`, `--tone-danger #f87171`, `--tone-info #60a5fa` (`:67-70`) — the historical "tone-info renders pink" drift is fixed, and `tone.ts:14-17` records the correction.

**Reachable-path trace:** supervisor lifecycle/error frame → `reduceConnectionState` (`connectionState.ts:211`) → `selectConnection` → `activeConnection` → `<ConnectionRecovery>` mounted at `App.tsx:4179` inside the chat `<main>`. User kills an engine → sentence + Restart button.

**Anchor drift:** three of three cited anchors are wrong. STATUS cites `App.tsx:4052` (actual `:4658`), `connectionState.ts:87` for `connectionTone` (actual `:145`), `connectionState.ts:101` for `connectionRecoveryMessage` (actual `:159`). All caused by the later IDLE-PARK insertion, not by the code being different.

---

### P4-39 — Session actions menu has no bottom-flip (🔁 headless-done, GUI pending)
**Verdict:** TRUE (for what the row claims; the row explicitly does not claim the finding is closed)

**Claims checked:**
1. `SessionActionsAnchor` widened from a placed point to the trigger's rect.
2. Pure `placeSessionActionsMenu` + `estimateSessionActionsMenuHeight` landed.
3. Consumed by the menu and, with its own height, by the rename popover.
4. Five call sites hand over rects, including the two right-click paths that had no clamp of any kind.
5. Modelled on `placeTagPopover`, with the flip decided by fit rather than a constant.

**Evidence:**
- Claim 1: `sessionActions.ts:293-300` — `{top, bottom, left}`, with `:296` documenting that a pointer repeats `top`.
- Claims 2+5: `sessionActions.ts:333-355`. The flip condition is `spaceBelow < panelHeight && spaceAbove > spaceBelow` (`:347`), i.e. fit-based with a below-preference tie-break, exactly as `:322-327` describes. `estimateSessionActionsMenuHeight` at `:379-394` over the four documented constants (`:374-377`). The 264px figure P4-46 depends on checks out: 14 chrome + 7×30 rows + 1×22 label + 2×9 dividers = 264.
- Claim 3: `SessionActionsMenu.tsx:81-84` (menu) and `:184` (rename popover, with `SESSION_RENAME_POPOVER_HEIGHT` at `sessionActions.ts:402`).
- Claim 4: rect handovers at `TabBar.tsx:324`, `Sidebar.tsx:1414`, `Sidebar.tsx:1786`, and the right-click path at `Sidebar.tsx:1656-1663` collapsing the pointer to a zero-height rect. `Sidebar.tsx:1125` places the workspace menu through the same helper.

**Reachable-path trace:** ⋯ button `getBoundingClientRect()` → `onOpenRowActions(sessionId, anchor)` → `App.tsx:2921` `setSessionActionsTarget` → `<SessionActionsMenu>` → `placeSessionActionsMenu` → discriminated `bottom`/`top` CSS anchoring.

**Anchor drift:** heavy — every cited anchor moved, most because P4-61 grew `Sidebar.tsx` by ~800 lines. STATUS `sessionActions.ts:273,319` → actual `:333,379`. `SessionActionsMenu.tsx:77,169` → `:81,184`. `Sidebar.tsx:970,911` → `:1414/:1786` and `:1656`. `TabBar.tsx:323` → `:324`.

---

### P4-46 — The window has no minimum size (🟡 headless green 2026-07-31, `c6c2469`)
**Verdict:** STALE — the constraint the floor was derived from no longer exists in source

**Claims checked:**
1. `minWidth: 852` / `minHeight: 495` added to the one `BrowserWindow`; `webPreferences`, defaults and CSP untouched.
2. Both numbers derived and cited in the construction so they are re-derivable.
3. **Binding width = 740 transcript/composer column (`App.tsx:3661`, `TranscriptView.tsx:233` `max-w-[740px]`) + 48 sidebar rail + 64 chat-pane padding.**
4. Binding height = 264 session-actions menu + 40 tab bar + 64 chat-pane padding + 16 gap + 83 composer dock + 28 macOS title bar.
5. No test, because `main.ts` cannot be instantiated headlessly and `mainSourceGuards.test.ts:14-22` rules out presence-greps by name.

**Evidence:**
- Claim 1 holds at HEAD: `app/main/main.ts:749-750`, inside the single `new BrowserWindow` at `:726`, with `webPreferences:754-769` (sandbox/contextIsolation/no nodeIntegration) untouched and the CSP block at `:715-718` intact. The working-tree modification to `main.ts` is a concurrent session's unrelated comment edit at `:998` — noted as context, not a finding.
- Claim 2 holds in form: the derivation is a 20-line comment at `:729-748`.
- **Claim 3 fails.** `max-w-[740px]` does not exist anywhere in `app/renderer/src`. Commit `f9f9f0f` (**2026-08-07**, "lighten the text greys and widen the transcript column") replaced it with `max-w-[1000px]` — `TranscriptView.tsx:318,402`, `App.tsx:4269`. Re-deriving with the row's own formula gives 48 + 64 + 1000 = **1112**, not 852. At the shipped floor the transcript column is 260px narrower than its current design width. Both cited anchors (`App.tsx:3661`, `TranscriptView.tsx:233`) also point at unrelated code.
- Claim 4's 264 term still checks out (verified above). Its "64 chat-pane padding" term does not: the chat pane is `px-8 pb-8` (`App.tsx:4173`), so its *vertical* padding is 32, not 64. The height floor over-counts by 32px. The 40 tab bar term is correct (`TabBar.tsx:119` `h-10`).
- Claim 5 holds: no test asserts these numbers, by design.

**Reachable-path trace:** `createWindow()` → the single Electron `BrowserWindow`. The values ship. It is the *derivation* that is stale, not the wiring.

**Anchor drift:** `App.tsx:3661` and `TranscriptView.tsx:233` both dead; the cited class string is gone from the repo. `Sidebar.tsx:407` (`w-12 shrink-0`) → actual `:696`. `sessionActions.ts:320` → actual `:379`. `AccountsPage.tsx:768` → actual `:759`. `SettingsShell.tsx:294,356` → actual `:300,362`.

---

### P4-51 — Shared focus trap and restore across overlays (🟡 2026-07-31)
**Verdict:** TRUE (headless half)

**Claims checked:**
1. Stable open-order stack; top-owner-only initial focus / Tab / Escape; underlying promotion; restoration past disconnected overlay content.
2. `CommandPalette` owns a dedicated global `z-[210]` band, above the highest co-mountable modal (`ToolInspectorOverlay` at 200).
3. The source test derives every production `useModalFocus` owner and fails if an interrupted owner reaches the palette layer.
4. No dialog closes, ⌘K behaviour unchanged, no App state or modal product behaviour changed beyond stacking.

**Evidence:**
- Claim 1: `overlayFocus.ts:143` `createModalFocusStack`, `:198` `modalKeyAction`, `:229` `popoverKeyAction`, `:251` `restoreFocus`, `:268` `useModalFocus` with the restore at `:308` (`restoreFocus(removal.restoreTarget)`), `:350` `usePopoverFocus` restoring the trigger at `:365`. `:375` documents that popovers join the SAME stack, so menus and modals arbitrate together rather than in parallel.
- Claim 2: `CommandPalette.tsx:26` `const COMMAND_PALETTE_LAYER_CLASS = 'z-[210]'` — a complete literal, so JIT-safe; confirmed **emitted** as `.z-\[210\]` in `app/renderer/dist/assets/index-BALh8Yxq.css`. The band it must clear is `TranscriptView.tsx:371` `fixed inset-0 z-[200]` (ToolInspectorOverlay) and `ToastHost.tsx:123` `z-[200]`.
- Claim 3: all nine named owners exist and call `useModalFocus` — `AccountsPage.tsx:78`, `AgentsPage.tsx:264`, `CommandPalette.tsx:58`, `MetadataInspector.tsx:106`, `PlanPanel.tsx:110`, `SAModal.tsx:59`, `StartupSurfaces.tsx:125`, `TasksDialog.tsx:187`, `TranscriptView.tsx:364`. No production `fixed inset-0` overlay is left unowned: the remaining ones (`SessionActionsMenu.tsx:71,171`, `Sidebar.tsx:1116`, `SessionsPage.tsx`, `composerPopover.ts:36`) route through `usePopoverFocus` into the same stack.

**Reachable-path trace:** open a modal → `useModalFocus` registers on the shared stack → top owner takes Tab/Escape → close → `restoreFocus` returns to the recorded trigger. Every owner is a mounted, user-reachable surface.

**Anchor drift:** none (the row cites commits, not lines). Actual paint order and focus landing remain operator-only, which the row states.

---

### P4-52 — Stylesheet-level reduced-motion support (🟡 2026-07-31)
**Verdict:** TRUE — and confirmed one level stronger than the row claims (emitted CSS, not just source)

**Claims checked:**
1. One stylesheet media rule sets six classes to `animation: none !important`.
2. The inventory is exactly the current renderer animation set: `animate-pulse`, `animate-ping`, `animate-spin`, `animate-toast-in`, `animate-sa-pop`, `animate-token-warn-in`.
3. No component, setting, protocol, preload or security-boundary change.
4. A focused source test failed before the rule and passes after, pinning the media query, class inventory, and declaration.
5. Renderer build emits the media query.

**Evidence:**
- Claim 1: `theme.css:317-326`, written **outside** the `@layer components` block that closes at `:312`. This matters and is correct: Tailwind emits `.animate-pulse{animation:var(--animate-pulse)}` as a *normal* declaration inside `@layer utilities` (confirmed in the built CSS), and an `!important` declaration beats a normal one regardless of layer, so the override wins in both directions.
- Claim 2 verified independently: `rg -o 'animate-[a-z0-9-]+' app/renderer/src --glob '!*.test.*'` returns exactly those six names and nothing else (pulse ×16, toast-in ×7, sa-pop ×7, spin ×5, token-warn-in ×3, ping ×2).
- Claim 4: `codeTheme.test.ts:162-184` regex-matches the media rule out of the raw stylesheet, asserts the sorted selector list is exactly those six, and asserts the declaration text is `animation: none !important;`. This is a real stylesheet assertion, not a component shape test.
- Claim 5 confirmed against the artifact, which is the strongest available headless evidence: `app/renderer/dist/assets/index-BALh8Yxq.css` contains `@media(prefers-reduced-motion:reduce){.animate-pulse,.animate-ping,.animate-spin,.animate-toast-in,.animate-sa-pop,.animate-token-warn-in{animation:none!important}}`.

**Reachable-path trace:** `main.tsx:9` `import './theme.css'` → bundled stylesheet → OS preference evaluated by Chromium at paint. No JS gate anywhere, so the row's "stylesheet-level" requirement is met literally.

**Anchor drift:** none. The row's terminal-precedent citations (`src/screens/REPL.tsx`, `src/components/TextInput.tsx`, `src/components/tasks/RemoteSessionProgress.tsx`) were not re-checked; they are context, not the claim.

**Gap (see F4):** the rule neutralizes `animation` only. 119 `transition-*` utilities in the production renderer are untouched, including motion added *after* this row landed.

---

### P4-53 — Sidebar session roster reachable by keyboard (🟡 2026-07-31)
**Verdict:** TRUE (headless half)

**Claims checked:**
1. Forward Tab entry is correct through an always-mounted pin.
2. Reverse Tab preserves the focused nav identity across the collapsed-to-expanded branch replacement, via a shared generic destination id.
3. `<aside>` focus capture records that id before adding `focusWithin`; a `useLayoutEffect` transfers focus to the matching expanded button.
4. Settings is covered by the same path as the other four, with no destination special case.
5. Hover, pin, DOM/tab order, roster data, labels and styling unchanged.

**Evidence:**
- Claim 1: `Sidebar.tsx:757-773` — the pin button is mounted in both states; when collapsed it takes `pointer-events-none absolute inset-0 … opacity-0` (`:769`), which is transparent but still focusable. `:739-740` states the intent. Focus on it sets `focusWithin` (`:721`), which feeds `selectSidebarOpen` (`:408-413`), which renders the roster (`:776`).
- Claims 2-4: `Sidebar.tsx:702-721`. The capture handler resolves `target.dataset.sidebarNavId` against `NAV`, calls `selectSidebarNavFocusHandoff(open, focusedNavId)` (`:710`), stores it in `refocusNavId`, and — the subtle part, documented at `:715-719` — calls `setNavOpen(true)` in the *same* update, because `focus()` on an `inert` element is a no-op. The transfer runs at `:675-680`. The generic id is stamped on all four nav renderings (`:1859`, `:1878`, `:1918`, `:1931`), so there is genuinely no per-destination branch. Helper behaviour is pinned by `sidebarState.test.ts:82-97`.
- Claim 5: the same `focusWithin`/`refocus` machinery survived P4-61's rebuild intact, which is worth saying explicitly — this row's mechanism is one of the few that a later full-file rebuild did not silently drop.

**Reachable-path trace:** Tab from page content → pin button (always mounted) → `onFocusCapture` → `focusWithin` → `selectSidebarOpen` true → search input, New chat, then session rows. Reverse Tab → collapsed `NavItemRail` → id recorded → `setNavOpen(true)` → layout effect refocuses the expanded counterpart.

**Anchor drift:** none cited.

---

## Findings

| # | Severity | Row | Defect | Evidence | Failure scenario |
|---|---|---|---|---|---|
| F1 | High | P4-61 | STATUS describes in-group session drag-reordering as built, quoting the operator's request as answered. It was deleted five days later and the row was never updated: `sidebarSessionOrder.ts` does not exist, project rows are not drag handles, and there are three drag payload types, not the four listed. | `6d90f5f` (2026-08-02) deletes the module + 20 tests and unwires `rowReorder`; only `sidebarWorkspaceOrder.ts:53`, `sidebarPinnedSessions.ts:52`, `TabBar.tsx:273` remain | Operator reads STATUS, tries to drag a session inside a project, nothing happens, and the row says it ships. The revert commit's reason (a 64-id cap inverted a 168-session project) is invisible from STATUS. |
| F2 | High | P4-46 | The window floor's binding-width derivation cites `max-w-[740px]` at two anchors; that class no longer exists anywhere in the repo. The column is now `max-w-[1000px]`, so the row's own formula yields 1112, not the shipped 852. | `f9f9f0f` (2026-08-07); `TranscriptView.tsx:318,402`, `App.tsx:4269`; floor at `app/main/main.ts:749-750`; comment at `:733-739` | Anyone re-deriving or defending the floor reads a comment describing a layout that is gone. At 852px the transcript sits 260px under its design width, and the row offers no evidence that is intended. |
| F3 | Medium | P4-1 | The row's title component was dark when the ✅ was written and is now deleted; a second primitive is still dark. | `ConnectionChip` deleted `ed741a2` (2026-07-21), reason recorded at `STATUS.md:49` as "dark/never-mounted"; `ChipStrip` exported `Chip.tsx:98`, tested `Chip.test.tsx:50-68`, zero production `<ChipStrip` | The house "built but never rendered" defect, ✅-graded. Two of seven named artifacts never reached a user; the tests that graded them were shape-only. |
| F4 | Medium | P4-52 | The rule neutralizes `animation` only. 119 `transition-*` utilities still animate under `prefers-reduced-motion: reduce`, including motion added *after* this row landed, and the inventory test structurally cannot see them. | `theme.css:317-326`; new motion at `Sidebar.tsx:264-268` (`delay-[150ms]` unfold stagger, P4-61) and `:735` (200ms rail width expand) | A reduced-motion user still gets the sidebar expand sweep and the footer unfold stagger. The row's guard test passes green because the new motion is a transition, not an animation. |
| F5 | Medium | P4-4 | The row states Sessions/Goals/Accounts/Settings are DISABLED and unbuilt. All five destinations are wired; the disabled branches are dead for every shipped destination. Separately, the Sidebar half was rebuilt from a different design source by P4-61. | `Sidebar.tsx:59`; dead branches `:1852-1871`, `:1911-1924` | A reader planning nav work believes four destinations are stubs. Reading P4-4 as the current Sidebar contract is wrong on both the nav state and the design source. |
| F6 | Low | P4-39, P4-46, P4-49, P4-3, P4-4 | Systematic anchor drift. Roughly a dozen cited `file:line` anchors no longer point at the described code, mostly from P4-61 growing `Sidebar.tsx` ~800 lines and IDLE-PARK inserting into `connectionState.ts`. | P4-49: `App.tsx:4052`→`:4658`, `connectionState.ts:87`→`:145`, `:101`→`:159`. P4-39: `sessionActions.ts:273,319`→`:333,379`; `Sidebar.tsx:970,911`→`:1414/1786`, `:1656`. P4-46: `Sidebar.tsx:407`→`:696`, `AccountsPage.tsx:768`→`:759`. P4-3: `settings.ts:924`→`src/utils/settings/settings.ts:936` | Anchors are the audit trail. Each stale one costs the next reader a search, and the F2 case shows drift hiding an actual semantic change rather than a line shift. |
| F7 | Low | P4-46 | The height derivation counts "64 chat-pane padding", but the pane is `px-8 pb-8`, i.e. 32px vertical. The 495 floor over-counts by 32. | `App.tsx:4173`; comment `app/main/main.ts:743` | Harmless in effect (the floor is 32px too tall) but it means the stated derivation does not reproduce the shipped number. |

---

## Operator steps required

No row in this lane is `UNVERIFIABLE-HEADLESS` as a verdict: every row's *built* half was settleable from source, and each row already carries its own GUI-pending marker. The steps below close the halves that source cannot reach. They are what the `🟡`/`🔁` markers are reserving.

**P4-39 — does the menu actually flip, and at the right y?**
1. Launch the app; make sure at least six sessions exist in one project so the sidebar list overflows.
2. Drag the window to `minHeight` (or as short as the screen allows).
3. Click the ⋯ on the **bottom-most** sidebar session row. Confirm all seven items are on screen and the panel grew upward, not off the bottom.
4. Repeat on the bottom-most Sessions-page row.
5. Right-click a session row within ~100px of the bottom edge. Confirm the same.
6. Open the ⋯ on the **top-most** row and confirm it still opens downward (no over-eager flip).

**P4-46 — is 852×495 where the window should stop?**
1. Drag the window's bottom-right corner in until it refuses to shrink.
2. At that floor, check the transcript column, composer, tab bar and sidebar rail are all fully visible and nothing is clipped or overlapping. Note that the transcript column's design width is now 1000px, so it will be visibly narrower than intended (F2).
3. Open a session actions menu at the floor height and confirm it fits.
4. Split into two workspace panels at the floor and judge whether each pane is still usable.

**P4-51 — does the palette actually paint above an interrupted dialog?**
1. Open the Tasks dialog (⌘K → Tasks, or the tasks affordance).
2. With it open, press ⌘K.
3. Confirm the command palette paints **above** the Tasks dialog, has the text cursor, and that Tab cycles only palette items.
4. Press Escape once: the palette closes, the Tasks dialog stays open and regains focus.
5. Press Escape again: Tasks closes and focus returns to the element that opened it.

**P4-52 — does motion actually stop?**
1. macOS System Settings → Accessibility → Display → enable **Reduce motion**.
2. Relaunch the app (or reload the renderer).
3. Trigger a toast (e.g. a failing verb), start a turn to get the pulsing activity indicator, and open a surface with a spinner.
4. Confirm the toast appears without its slide-in, the indicator is a static dot, and the spinner does not rotate.
5. Note for the record whether the sidebar's hover-expand sweep and the footer unfold stagger still animate. They will (F4).
6. Turn Reduce motion off, relaunch, confirm all six animations return.

**P4-53 — is the roster reachable without a mouse?**
1. Launch with the sidebar unpinned and collapsed; click into the composer.
2. Press Shift+Tab repeatedly until focus enters the rail. Confirm the rail expands and the focus ring is on a nav destination (not lost to `<body>`), and that it is the *same* destination that was highlighted while collapsed.
3. Do this for each of the five destinations, Settings included.
4. From the page top, Tab forward until focus enters the rail. Confirm it lands on the pin, the rail expands, and continued Tab reaches Search → New chat → the first session row.
5. Press Enter on a session row and confirm it opens.
6. Tab out past the last rail element and confirm the rail collapses.

**P4-61 — the gesture half of the rebuild.**
1. Hover the collapsed rail; confirm the expand timing feels right and the footer destinations unfold upward with a stagger.
2. Pin a session; confirm it lifts into `Pinned` and is not duplicated in its project group.
3. Drag pinned rows to reorder, and repeat with ⌥↑/⌥↓.
4. **Attempt to drag a session row inside a project group. It will not move (F1).** Confirm with the operator whether that is the intended end state.
5. Hover a project header; confirm the ⋮ hides the group and that "Show N hidden projects" restores it.
6. Confirm the row actions backing appears only under the pointer, including on a pinned row whose pin is always visible.

---

## Nits

- P4-2's row still carries "⚠ two-strikes → P4-8: `waiting` state currently unreachable". It is reachable (`orchestratorState.ts:84`) and the code says so (`agentIdentity.ts:359-361`). Stale in the reader's favour, but it is an open warning on a closed item.
- P4-3 cites `settings.ts` without its directory; the file is `src/utils/settings/settings.ts`.
- `Chip.tsx:11-13` documents that the shared-kit `ChipStrip` is deliberately *not* the prototype's composer-specific one. That is a reasonable call, but combined with F3 it means the kit shipped a primitive whose stated purpose no surface wanted.
- P4-52's row lists its terminal precedents (`src/screens/REPL.tsx:1596-1607` etc.) as context; those anchors were not re-verified here, as they are outside `app/` and not part of the claim.
- The `app/renderer/dist` stylesheet used as evidence for P4-52 and P4-51 is dated 2026-08-07 22:08 and may be a concurrent session's build. It agrees with `theme.css` at HEAD in every respect checked.
- `app/main/main.ts` is dirty in the working tree (an unrelated comment edit at `:998` about `bypassPermissions`). Audited at HEAD; noted as concurrent edit in flight.
