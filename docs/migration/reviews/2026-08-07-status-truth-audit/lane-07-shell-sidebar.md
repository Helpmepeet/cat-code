# Lane 07 — Shell, sidebar, tabs, palette

**Auditor verdict:** YELLOW
**Rows audited:** 10 · TRUE 9 · OVERSTATED 1 · FALSE 0 · STALE 0 · UNVERIFIABLE-HEADLESS 0

All audit reads were against committed `HEAD` = `d85f770`. None of this lane's owner
files are dirty in the shared tree (`app/main/main.ts` is dirty from a concurrent
session; its two anchors were read via `git show HEAD:`).

## Row verdicts

### P3-4 — Renderer multiplex foundation: stores keyed by `sessionId`
**Verdict:** TRUE
**Claims checked:**
1. connection / permission / raw / projector reducers mutate only `frame.sessionId` slices.
2. `App` owns a stable explicit `activeSessionId`; no per-store implicit active id.
3. `TranscriptView` selects from it.
4. Typed send failures map per session to dead / starting / disconnected.
5. Two-session fixture + replay tests prove isolation, incl. a B permission while A is active.

**Evidence:**
- `app/renderer/src/connectionState.ts:220,232,248,286` — every write is `{...state.sessions, [frame.sessionId]: …}`; `:50` selector is `state.sessions[sessionId]`.
- `app/renderer/src/permissionState.ts:116,124,144,151,367` — same shape, `updateSession(state, sessionId, …)`.
- `app/renderer/src/transcriptProjector.ts:817-832` — `sessions[frame.sessionId]` created lazily, projected, replaced.
- `app/renderer/src/App.tsx:478` — `const [activeSessionId, setActiveSessionId] = useState<SessionId | null>(null)`; `:1035` `selectConnection(connection, activeSessionId)`.
- `app/renderer/src/shellState.ts:6-9` — doc comment states `activeSessionId` is deliberately NOT in the shell reducer, so a background frame cannot steal focus. Confirmed: `ShellState` (`:22-36`) has no active field.
- `app/renderer/src/connectionState.ts:75-84,117-122,164-174,264-267` — `starting` / `dead` / `disconnected` mapped from typed error codes; `:246` comment pins that a turn event cannot resurrect a dead session.
- `app/renderer/src/rendererSessionIsolation.test.ts` exists (the two-session isolation suite); `permissionState.test.ts:262` `permission and lifecycle frames cannot clear another session queue`.

**Reachable-path trace:** sidecar `AppSessionEvent` → `App.tsx` frame dispatch → per-session reducer slice → `selectTranscriptRows(transcript, sessionId)` (`App.tsx:2359`) → `WorkspaceLayout` panes / `TranscriptView`, mounted unconditionally at `App.tsx:3403`.
**Anchor drift:** none — the row cites no `file:line`.

### P3-5a — Shell frame + TabBar (live sessions, switch, close, dead-tab)
**Verdict:** TRUE
**Claims checked:**
1. Root state is a real projection of the `HostEvent` stream (replaces AppV2 mock glue).
2. One tab per live session; switch without losing background streaming.
3. Close → `closeSession`, stays restorable; dead/exited tab → restart affordance.
4. Background-session permission badge.
5. ⌘1-9 switching.
6. The settings-write lost-update race found during GUI acceptance was fixed engine-side (`lockSync` + `SettingsUpdater` under the lock, real two-process probe).

**Evidence:**
- `app/renderer/src/shellState.ts:1-10,52-56` — `reduceShellState` folds `HostEvent` only; `:26-33` tab membership is event history (crash keeps the tab, clean close revokes).
- `app/renderer/src/TabBar.tsx:27-44` — `onSelect` / `onClose` / `onRestart` props; `:271` select, `:309` restart, `:354` close.
- `app/renderer/src/TabBar.tsx:284-288` — `visual.needsAttention ? <AttentionBadge/> : <StatusDot tone={visual.tone}/>`; `AttentionBadge` at `:387-397` is the background permission signal (`aria-label="Permission request waiting"`).
- `app/renderer/src/App.tsx:2346-2351` — ⌘1-9 via `sessionAtSlot(shell, Number(event.key))`; `:2340-2344` ⌘W close.
- `app/renderer/src/App.tsx:2950-2963` — `<TabBar …/>` mounted unconditionally in the shell frame.
- Engine race fix still present: `src/utils/settings/settings.ts:435` `acquireSettingsLockSync`, `:462` `SettingsUpdater`, `:483,507` updater invoked under the lock; probe pair `src/utils/settings/settingsWriteContention.probe.test.ts` + `.probe.child.ts` both exist.

**Reachable-path trace:** host `HostEvent` → `reduceShellState` → `tabs` → `<TabBar>` at App root → click / ⌘N → `selectTab` / `closeTab` / `restartTab` → preload → host.
**Anchor drift:** none cited. Note the row's *description* of per-tab status ("chip `DISCONNECTED`") is superseded: the tab now paints a status DOT with a static tone map (`TabBar.tsx:399-409 toneDotClass`) plus a `restart` button, not an uppercase status chip. Behavior claim intact.

### P3-5b — Sidebar + restore-offer (live ∪ restorable, real restore)
**Verdict:** TRUE
**Claims checked:**
1. Sidebar shows live ∪ restorable.
2. Selecting a restorable row → `restoreSession` → a live tab with its RESTORED transcript.
3. Crash keeps the tab (restart-in-place) while the Sidebar row offers restore.
4. Ordering by `lastAttachedAt`.

**Evidence:**
- `app/renderer/src/App.tsx:2913-2947` — `<Sidebar rows={sessionCatalogRows} … onRestore={sessionId => void performRestore(sessionId)} …/>`, mounted unconditionally.
- `app/host/host.ts` `restoreSession` — validates the registry row, re-checks `canResume`, refuses a live/advisory-live id, clears a crashed tombstone, then `this.spawn({ appSessionId, cwd, title, resumeEngineSessionId: row.engineSessionId })`. This is a **new sidecar process resuming the same engine transcript**, which is the anti-Potemkin bar for "restore works" — not a JSONL replay.
- `app/renderer/src/shellState.ts:26-33` — crash (`restorable` + `disconnected`) keeps tab membership; clean close revokes it.
- `app/renderer/src/App.tsx:1926` `performRestore` → `:1841` `bridge.restoreSession(sessionId)` → `app/main/main.ts:1322` `host.restoreSession`.

**Reachable-path trace:** `listSessions`/registry → merged rows → `Sidebar` row click → `performRestore` → preload → main → host → fresh sidecar with `resumeEngineSessionId`.
**Anchor drift:** none cited. **Superseded sub-claim (not a defect):** ordering is no longer `lastAttachedAt`. `sidebarState.ts:20-21` records the reason explicitly ("restore bumps `lastAttachedAt`, so that jumped a restored row") and `sortSidebarSessionRows` (`:328`) now orders on CC-2 activity. The rail also renders the merged registry ∪ terminal-history roster (P4-6a), a strict superset of live ∪ restorable.

### P3-6 — WorkspaceLayout: 1–3 split panels, resize, drag
**Verdict:** TRUE
**Claims checked:**
1. 1–3 panels, 4th split refused.
2. Renderer-owned `localStorage` persistence, registry-unaware.
3. Graceful degradation on reaped sessions; same-session duplicate focuses rather than mirrors.
4. HIGH fix: drop-edge strips are `pointer-events-none` at rest, `pointer-events-auto` only during a tab drag.
5. MED fix: panel `key={panel.sessionId}`, not the index.
6. Relaunch fix: split held in `pendingRestore`, disk write gated while pending, `readyToRestoreLayout` snaps back atomically.
7. Resize divider + tab→edge drag are real DOM interactions.

**Evidence:**
- `app/renderer/src/workspaceLayout.ts:4` `MAX_WORKSPACE_PANELS = 3`, enforced at `:56` (`.slice`), `:213` (split refused), and in the UI at `WorkspacePanels.tsx:182,197` + `TabBar.tsx:155`.
- `app/renderer/src/App.tsx:559-563` — layout read from `readWorkspaceLayoutFromStorage(getWorkspaceStorage())`; no host/registry read.
- `app/renderer/src/WorkspacePanels.tsx:366` — `(interactive ? 'pointer-events-auto ' : 'pointer-events-none ')`, driven by `dragActive` (`:68,185,200`) which is set only on a `dragover` carrying `text/sessionid` (`:129-138`) and cleared on window `drop`/`dragend` (`:71-80`). Fix #4 present.
- `app/renderer/src/WorkspacePanels.tsx:150` — `<Fragment key={panel.sessionId}>`. Fix #5 present.
- `app/renderer/src/App.tsx:568-580` `pendingRestore`; `:1208-1220` `readyToRestoreLayout(pendingRestore, paneSessionIds)`; `:1224-1227` the persist effect returns early while `pendingRestore` is set. Fix #6 present exactly as described.
- Real handlers: divider `onMouseDown` (`WorkspacePanels.tsx:241-248`) sets `resize`; the window `mousemove`/`mouseup` pair (`:82-102`) drives `resizeWorkspaceDivider`; keyboard `ArrowLeft/Right` ±5% at `:228-240`; `role="separator"` at `:402`. Drop producer is `TabBar.tsx:270-274` (`draggable` + `setData('text/sessionId', id)`), consumer `splitFromDrop` at `WorkspacePanels.tsx:103-115`.

**Reachable-path trace:** `App.tsx:3403 <WorkspaceLayout …/>` inside the chat branch (sibling of `BannerStack`, not behind any dev gate) → panels map over `workspaceLayout.panels` → each pane renders a live session.
**Anchor drift:** none cited by row. The component's exported name is `WorkspaceLayout` inside `WorkspacePanels.tsx` — a grep for `<WorkspacePanels` returns nothing and reads as unmounted; it is mounted.

### P3-7 — CommandPalette + SlashCommandPicker (recon-first)
**Verdict:** TRUE
**Claims checked:**
1. The `commands: []` stub-context defect is fixed by populating the catalog from the engine's own `getCommands(cwd)`.
2. Names ride the existing `system/init.slash_commands`; no new wire vocabulary invented.
3. Projector captures the catalog per session, `[]`-tolerant.
4. `SlashCommandPicker` opens only on a leading `/token`, prefix-then-substring filter, pick submits through the existing `app.submit`.
5. `CommandPalette` (⌘K) has an all-real action inventory, unavailable actions omitted not disabled, plus live ∪ restorable session search.

**Evidence:**
- `app/sidecar/sessionController.ts:31` imports `getCommands`; `:180-186` `loadCommandCatalog` = `await getCommands(cwd)`, fail-soft to `[]` with stderr; `:323,333` the result is what the session config carries. The `commands: []` stub is gone.
- `app/sidecar/sessionController.ts:349` — the richer `slashCatalog` is projected from the SAME loaded `commands`, not a second `getCommands()` call.
- `app/renderer/src/slashCommandPickerModel.ts:3-6` — `parseSlashDraft` is `/^\/(\S*)$/`, so the picker closes the moment a space is typed; `:8-23` prefix-then-substring.
- `app/renderer/src/App.tsx:3649-3661` — `slashEntries` prefers the rich catalog and falls back to `selectSlashCommands(transcript, activeSessionId)` (names-only), so the picker never regresses below name-only; `:3658` `slashOpen` gate.
- `app/renderer/src/App.tsx:4370-4376` `<SlashCommandPicker …/>` mounted inside the composer form.
- `app/renderer/src/App.tsx:2328` ⌘K → `setPaletteOpen`; `:3434-3441` `<CommandPalette open={paletteOpen} …/>` as a fixed overlay above the shell.
- `app/renderer/src/commandPaletteModel.ts:116-232` — every entry is a real action (`new-session`, `close-active`, `restart-active`, `copy-active`, `close-panel`, `open-tasks`), each conditionally *omitted* (`:128,138,147,159` are inside guards), plus session rows (`:187`) and command rows (`:214`).

**Reachable-path trace:** engine `getCommands(cwd)` → sidecar session config → `system/init.slash_commands` + `slashCatalog` snapshot → projector → `slashEntries` → `<SlashCommandPicker>` in the composer → pick → `completeSlashDraft` → existing `app.submit`.
**Anchor drift:** the row cites `app/sidecar/sessionController.ts:95` for the pre-fix `commands: []` (expected — it was the thing fixed). The row also quotes the palette session aria-label as `` session <title> — <state>[, restorable] ``; the shipped string is comma-separated (`commandPaletteModel.ts:194`), i.e. STATUS quotes a string that the §7 em-dash rule has since replaced. Low.

### P3-H — GUI-verification dev harness
**Verdict:** TRUE
**Claims checked:**
1. Main-owned cwd allowlist + initial cwd. 2. Active-session picker `defaultPath`. 3. Dev-only debug export stripped from the packaged preload. 4. Readiness latch. 5. `Cat Code Dev` title. 6. Scripted demo. 7. Hardening no-export assertion.

**Evidence:**
- `app/main/devHarness.ts:31-43` — `resolveDevHarnessConfig` returns a fully disabled config when `isPackaged`; `:46-49` reads `CATCODE_TEST_CWD_ALLOWLIST` and validates each entry through the injected `validateCwd`.
- `app/main/main.ts:668-676` — `devHarnessConfig` + `createDevPickerBypass`; `:1533,1546` both debug-export paths short-circuit on `!IS_DEV || !devHarnessConfig.debugState`; `:1748-1749` initial cwd.
- `app/preload/preload.ts:357-363` — `reportDebugShellState` is added only inside `if (__CATCODE_DEV_HARNESS__)`, i.e. removed at build time from the packaged preload, not merely gated at runtime.
- `app/main/main.ts:190` `app.setName('Cat Code Dev')` under `IS_DEV`; `:783` window title; `:685,822,1217` readiness latch (window + renderer).
- `app/scripts/harness-demo.ts:89` sets `CATCODE_TEST_CWD_ALLOWLIST`; `app/scripts/harness-demo-driver.ts` drives it; `harnessDemoSource.test.ts` pins the source.
- `app/scripts/hardening-smoke.ts:359-368` — asserts the packaged production path did NOT create a debug-state export.

**Documentary wiring (checked per house rule before judging a harness):** `docs/migration/process/GUI-VERIFICATION.md` is routed to from `docs/migration/PROGRAM-PLAN.md:428`, `docs/migration/2026-07-22-phase4-gui-acceptance.md:16`, and ~6 live GUI riders in `docs/migration/backlog/phase4.md` (`:96,1619,1737,1841,2166,2307`). Not dead.
**Anchor drift:** none cited.

### CC-10 — Terminal-created sessions take ~51 s to appear in the sidebar
**Verdict:** OVERSTATED
**Claims checked:**
1. The worker runs 0.45 s end-to-end. 2. The delivery hop is synchronous, un-batched, un-throttled. 3. The residual ~20 s is upstream: a transcript file only exists from the first user/assistant message, and a `hasConversation === false` row is dropped. 4. The fix is start-anchored scheduling closing a latent unbounded-period bug. 5. Two colocated tests fail pre-fix; one also pins `maxConcurrent === 1`. 6. The 30 s interval was deliberately unchanged.

**Evidence (all mechanics verified):**
- `app/main/sessionsCatalogRunner.ts:266-268` — `const delay = Math.max(0, intervalMs - (now() - startedAt))`; `:281,292` the run's own `startedAt` is what `schedule()` receives. Claim 4 holds exactly.
- `app/main/sessionsCatalogRunner.ts:42-43` — `SESSIONS_CATALOG_REFRESH_INTERVAL_MS = 30_000`, `SESSIONS_CATALOG_WORKER_TIMEOUT_MS = 5 * 60 * 1000` (the 5.5-minute worst-case period the fix closes). Claim 6 holds.
- `app/main/sessionsCatalogRunner.test.ts:272,300` — `fixed cadence: the next run is anchored to run START, not completion` and the overrun case; `:236,241,326` `maxConcurrent === 1`. Claim 5 holds.
- Delivery hop is still synchronous: `app/main/main.ts:512-513` `onCatalog: catalog => sendHostEvent({ type: 'sessions-catalog', catalog })` → `app/renderer/src/App.tsx:923-924` `dispatchSessionsCatalog`. Claim 2 holds.
- Upstream gate confirmed: `src/utils/sessionStorage.ts:1452-1458` — the file materializes only when `messages.some(m => m.type === 'user' || m.type === 'assistant')`; `app/sidecar/sessionsCatalogDomain.ts:186` — `if (log.hasConversation === false) return null`. Claim 3 holds.

**Why OVERSTATED:** the row is titled by the operator's symptom (~51 s) and carries a ✅, but by its own measurements the landed change moves observed latency from 30.36 s to 30.000 s — **0.36 s**. The symptom persists: app-side worst case is still **30.0 s / mean ~15 s**, set by `SESSIONS_CATALOG_REFRESH_INTERVAL_MS` (`sessionsCatalogRunner.ts:42`), and the larger upstream component (operator typing + first turn before the transcript file exists) is untouched and unbounded by the app. What actually landed is a *different, real* fix — closing the unbounded-period bug where a hung run stretched the refresh period to 5.5 minutes. The prose says all of this honestly and flags the residuals ⬜; the ✅ marker against the symptom title does not. A reader scanning STATUS for "is the sidebar-latency bug fixed" gets the wrong answer.
**Reachable-path trace:** timer → one-shot worker → `onCatalog` → `sendHostEvent` → renderer reducer → merged rows → Sidebar.
**Anchor drift:** four of the row's citations no longer point at what they describe — `sessionStorage.ts:1290,1319` (actual `:1452-1458`), `sessionsCatalogDomain.ts:181` (actual `:186`), `main.ts:394,714` (actual `:512-513`; `:714` is now CSP), `App.tsx:673` (actual `:923-924`; `:673` is now a lease reducer).

### CC-14 — Two sidebar workspace groups both labelled `APP`
**Verdict:** TRUE
**Claims checked:**
1. Disambiguation is progressive, not a fixed one parent segment. 2. Exhausting a path falls back to the whole cwd, which bounds the loop. 3. Empty cwd stays in the `Unknown workspace` bucket, held out of disambiguation. 4. Read-time only, no new field / protocol / preload change. 5. Ordering sorts on the disambiguated label, frozen (activeCwd-free), with a `cwd` tiebreak. 6. Both consumers render `group.name`, so zero component change was needed.

**Evidence:**
- `app/renderer/src/sessionsCatalogState.ts:487-521` — `disambiguateWorkspaceLabels` loops, widening only the still-colliding cwds by one depth per round (`:503-509`), and skips a cwd already showing its full path (`:505-506`) — that skip is what terminates the loop. Claims 1 and 2 hold.
- `:556-566` — `groupByWorkspace` calls the helper, labels empty cwd as `'Unknown workspace'` (`:562`), and sorts `a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd)` (`:566`). Claims 3 and 5 hold.
- Consumers: `SessionsPage.tsx:402` and `Sidebar.tsx:1393` both render `group.name`; `Sidebar.tsx:926,1425` reuse it. Claim 6 holds; `rg` finds no third consumer.
- No protocol/preload/sidecar touch: the helper is a pure renderer function over cwds the selector already receives. Claim 4 holds.
- **The row's flagged residual has since been closed:** `selectRecentWorkspaces` now runs the same helper (`sessionsCatalogState.ts:703`), so the Welcome launcher no longer carries the latent ambiguity.

**Reachable-path trace:** merged rows → `groupByWorkspace(groupRows, activeCwd)` (`Sidebar.tsx:508`) → `selectOrderedWorkspaceGroups` → `SessionGroup` header text (`Sidebar.tsx:1393`).
**Anchor drift:** the row cites pre-fix `sessionsCatalogState.ts:444` / `:448` and post-fix `:469-506`; actual are `:562` / `:566` / `:487-521`. Consumer anchors `Sidebar.tsx:426` and `SessionsPage.tsx:236` are now `:1393` and `:402`. Low.

### CC-18 — Sidebar workspace groups drag-reorderable, order sticks
**Verdict:** TRUE (for what the row claims: headless-only, operator GUI acceptance explicitly PENDING)
**Claims checked:**
1. One pure module owns the decision; the DOM is thin over it. 2. The shared `groupByWorkspace` is untouched, so the Sessions page keeps frozen-alphabetical. 3. The order is keyed on `cwd`, never the rendered label. 4. `activeCwd` is never read by the ordering selector (CC-2 warp-free rule intact). 5. Renderer-local versioned persistence only, no protocol/preload/host field. 6. Drag payload `text/workspace-cwd`, deliberately distinct from the tab→split `text/sessionId`. 7. Keyboard path ⌥↑/⌥↓ with `aria-keyshortcuts`. 8. Drop indicator uses static classes only.

**Evidence:**
- `app/renderer/src/sidebarWorkspaceOrder.ts:36` storage key `catcode.sidebarWorkspaceOrder.v1`; `:53` `WORKSPACE_ORDER_DRAG_MIME = 'text/workspace-cwd'` — distinct from `TabBar.tsx:273`'s `'text/sessionId'`. Claims 5 and 6 hold.
- `app/renderer/src/Sidebar.tsx:507-518` — `selectOrderedWorkspaceGroups(groupByWorkspace(groupRows, activeCwd), workspaceOrder)`: the custom order is applied to the *result*, and `selectOrderedWorkspaceGroups` receives only the groups and the order — `activeCwd` never reaches it. `SessionsPage.tsx:37` still calls the bare `groupByWorkspace`. Claims 2 and 4 hold.
- `app/renderer/src/Sidebar.tsx:1337-1350` — header `draggable`, `setData(WORKSPACE_ORDER_DRAG_MIME, group.cwd)`; `:572-599` the handler set (`onDragStart/Over/Leave/Drop/End`) reduces through `reduceWorkspaceOrderMoved` and commits; `:554-558` `commitWorkspaceOrder` writes via `writeWorkspaceOrderToStorage(orderStore, next)`. Claims 1 and 3 hold (keys are `group.cwd` throughout).
- `app/renderer/src/Sidebar.tsx:901` — `reorder={reorderHandlers}` is actually passed to every `SessionGroup`, so `reorderable` is satisfied on the real path (not a never-satisfied gate).
- `app/renderer/src/Sidebar.tsx:1369-1379` — `event.altKey` guard + `aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"`. Claim 7 holds.
- `app/renderer/src/Sidebar.tsx:1312-1330` — drop indicator is `h-[2px] … bg-accent` written as a literal class, no interpolation. Claim 8 holds.

**Reachable-path trace:** `App.tsx:2913 <Sidebar>` → `visibleGroups.map(group => <SessionGroup reorder={reorderHandlers} …/>)` (`Sidebar.tsx:889-901`) → draggable header → `onDrop` → `reduceWorkspaceOrderMoved` → `commitWorkspaceOrder` → `localStorage` → next mount reads it back (`Sidebar.tsx:362-364`).
**Anchor drift:** the row cites `sessionsCatalogState.ts:508` for `groupByWorkspace` (actual `:546`), `Sidebar.tsx:203` (actual `:508`), `SessionsPage.tsx:37` (holds), `TabBar.tsx:265` (actual `:273`). Low.

### P4-44 — Sidebar rows cannot be told live from not-live
**Verdict:** TRUE (row is correctly marked 🟡, GUI acceptance genuinely outstanding)
**Claims checked:**
1. One small unlabeled dot when `row.live`, nothing otherwise. 2. No chip, no status word, one tone, no per-state colour vocabulary. 3. Liveness is `MergedSessionRow.live`, not `deriveMergedRowVisual().kind`. 4. `aria-hidden`, with the state already in the `aria-label`. 5. Fixed leading lane every row reserves, so live and not-live rows lay out identically. 6. Classes are static, so the Tailwind trap is ruled out. 7. Dot centred on the title, 5px from the border, 8px to the text.

**Evidence:**
- `app/renderer/src/Sidebar.tsx:1716-1724` — `<span aria-hidden="true" className="pointer-events-none flex h-4 w-1.5 shrink-0 items-center self-start">{row.live ? <span className="h-1.5 w-1.5 rounded-full bg-tone-good"/> : null}</span>`. The LANE renders unconditionally; only the dot inside it is conditional. Claims 1, 4, 5 hold.
- `app/renderer/src/sessionsCatalogState.ts:200` — `live: !descriptor.restorable && descriptor.status !== 'exited'`. **This anchor is exact.** Claim 3 holds.
- `bg-tone-good` resolves through `theme.css:154` `--color-tone-good: var(--tone-good)` → `:67` `#4ade80`. A literal class, not interpolated. Claim 6 holds.
- **The contested question — did it add text chips the operator did not want? No.** I read `SidebarRowItem` end to end (`Sidebar.tsx:1560-1800`): the row renders the dot lane, the title, and a `time · model` subtitle (`:1745-1753`), and nothing else at rest. No status word, no second tone, no per-state colour. `rg` for `crashed|closed|history|live` as rendered text in `Sidebar.tsx` returns only comments, prop names and `visual.kind === 'history'` branch logic — no status string reaches the DOM. Per-state status vocabulary lives on the TabBar (`TabBar.tsx:399-409`), which the operator's ruling left in place. Claim 2 holds.

**Reachable-path trace:** registry descriptor → `selectMergedSessionRows` → `row.live` → `SidebarRowItem` → `Sidebar` mounted at `App.tsx:2913`. Every session row on the rail hits it.
**Anchor drift:** the row cites `Sidebar.tsx:943-958` (actual `:1716-1724`) and `Sidebar.tsx:27-42` for the rewritten note (actual `:44-62`). The file was reworked on 2026-08-01 against the operator's Claude Design source; the dot survived that rework intact and the note now sits in the §0 flag block. Low.
**Claim 7 (geometry) is not headless-verifiable** — see Operator steps.

## Findings

| # | Severity | Row | Defect | Evidence | Failure scenario |
|---|---|---|---|---|---|
| F1 | Medium | CC-10 | ✅ sits on a symptom-titled row whose symptom persists. The landed change buys 0.36 s (30.36 → 30.000 s); app-side worst case is still 30.0 s / mean ~15 s, and the dominant upstream component is untouched. What actually landed is a different real fix (closing a 5.5-minute unbounded period). | `app/main/sessionsCatalogRunner.ts:42,266-268`; `src/utils/sessionStorage.ts:1452-1458`; `app/sidecar/sessionsCatalogDomain.ts:186` | Operator scans STATUS, reads "✅ terminal-created sessions take ~51 s to appear" as fixed, creates a session in the terminal, and still waits up to ~30 s app-side plus the pre-materialization window. Row prose says so; the ✅ does not. |
| F2 | Low | CC-10, CC-14, CC-18, P4-44, P3-7 | Anchor drift: 13 cited `file:line` no longer point at the described code, and one cited user-visible string is superseded. Notably `main.ts:714` now points at CSP and `App.tsx:673` at a lease reducer — a reader following them lands somewhere confidently wrong. | listed per row above | A future session verifies a claim against `App.tsx:673`, finds unrelated code, and either re-does the work or concludes the row is false. |

No Critical or High findings. No security-baseline issue: nothing in this lane adds an inbound frame kind, a preload channel, or a host field — CC-18 and P4-44 are renderer-local (`localStorage` and a derived boolean), and P3-7 rides the pre-existing outbound `system/init` frame plus the existing `app.submit`.

**House-defect sweep results (all negative except as noted):**
- **Stub context at a seam** — the P3-7 instance (`commands: []`) is genuinely fixed and the enrichment reuses the same loaded array rather than re-calling `getCommands` (`sessionController.ts:349`). No new instance in this lane.
- **Built but never rendered** — none. `Sidebar` (`App.tsx:2913`), `TabBar` (`:2950`), `WorkspaceLayout` (`:3403`), `CommandPalette` (`:3434`) and `SlashCommandPicker` (`:4370`) are all mounted, and `reorder={reorderHandlers}` is actually passed (`Sidebar.tsx:901`), so CC-18's `reorderable` gate is satisfied on the real path.
- **Tailwind dynamic-class trap** — **resolved.** `rg` for interpolated arbitrary-value classes across `Sidebar.tsx`, `TabBar.tsx`, `WorkspacePanels.tsx`, `CommandPalette.tsx`, `SlashCommandPicker.tsx` returns **one hit, and it is a comment warning against the pattern** (`Sidebar.tsx:259`). The historic shipping instance around `Sidebar.tsx:543` is gone; the file's tone/state classes are now static maps (`TabBar.tsx:399-409 toneDotClass`).
- **User-visible text rules** — clean. Every `—` in this lane's owner files is inside a JSDoc or `{/* */}` comment. The one aria-label separator STATUS quotes has already been converted to a comma (`commandPaletteModel.ts:194`). No rendered session ids, file paths, or internal vocabulary.

## Operator steps required

These are the sub-claims a headless audit cannot settle. None of them changes a verdict on its own; each is an outstanding acceptance the row already marks ⬜ or 🟡.

**P4-44 — dot placement (row is 🟡 for exactly this).** Launch the dev app. In the rail, get three rows visible at once: a live session that is NOT the active tab, the live active session, and a closed/restorable session. Check three things: (a) the dot sits level with the *title* baseline, not floating in the gap between the title and the `time · model` line; (b) the title's left edge is at the same x on all three rows (the not-live row must not shift left); (c) the closed row has no dot and no gap artefact. Then click the non-active live row to make it active and confirm the dot does not move or change tone — it follows liveness, not activeness.

**CC-18 — drag gesture and persistence (row is explicitly headless-only).** With at least three projects in the rail, drag the second project's header above the first. Expect a 2px accent rule on the target edge during the drag and 50% opacity on the source. Drop. Then type in the sidebar search to hide one of the reordered projects, clear the search, and confirm the reordered pair kept their positions. Then ⌘Q and relaunch: the order must survive. Finally, focus a project header with Tab and press ⌥↓ — it must step down one slot, and stop at the "Unknown workspace" bucket rather than passing it.

**P3-6 — resize and tab→edge drag re-verify (residual, not a new gap).** The row's 2026-07-07 GUI acceptance predates the 2026-08-01/02 Sidebar and composer rework, so it is worth one re-run: drag a tab onto the right edge of the pane to split; drag the divider left and right and confirm neither panel collapses below ~20%; with the split open, click the × on panel 2 and confirm it closes (this is the regression the HIGH fix addressed — if the drop strips ever revert to `pointer-events-auto` at rest, that click is swallowed); then attempt a 4th split and confirm the "Workspace layout supports up to three panels." notice. Finally ⌘Q and relaunch, restore both sessions, and confirm the split re-forms.

## Nits

- `Sidebar.tsx` is 2,219 lines and now holds `SidebarRowItem`, `SessionGroup`, the footer, and eight icon components. Not a defect; it is the file most likely to accumulate the next unmounted-component bug.
- `WorkspacePanels.tsx` exports its component as `WorkspaceLayout`. A `rg '<WorkspacePanels'` sweep — the natural first check for "is this mounted" — returns nothing and reads as dead code. Worth a one-line note in the file header for the next auditor.
- The P3-5a row's prose still describes tab status as uppercase chips (`DISCONNECTED`, `CRASHED`); the shipped TabBar uses a tone dot plus a `restart` button. Behavior is unchanged, the description is stale.
- CC-14's flagged residual (`selectRecentWorkspaces`) was fixed later but the row still shows it ⬜.
