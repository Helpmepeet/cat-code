# Lane 2: App shell, overlays, focus, toasts

## Scope reviewed

Committed range `2f4278d..7c6959f` for `App.tsx` (+1039/-460), the new
`overlayFocus.ts` (375), `appModel.ts` (356), `SAModal.tsx` (201),
`accountHealthBanner.ts`, `rosterBootstrap.ts`, `toastModel.ts`,
`toastContext.ts`, `bannerStackModel.ts`, `tabBarModel.ts`,
`agentChromeModel.ts`, plus their colocated tests and every consumer of the two
new focus hooks (`AccountsPage`, `AgentsPage`, `CommandPalette`,
`MetadataInspector`, `PlanPanel`, `SessionActionsMenu`, `SessionsPage`,
`Sidebar`, `StartupSurfaces`, `TasksDialog`, `TranscriptView`,
`composerPopover.ts`). The week did four things here: extracted App's pure
helpers into `appModel.ts` (with two deliberate, documented behaviour fixes to
the activity verb and the token byline), unified every overlay onto
`useModalFocus`/`usePopoverFocus` with a module-level modal-owner stack,
converted `hostSnapshotReady` from a boolean into a three-state roster-bootstrap
reducer with a retry, and stopped success paths from clearing `shellError`.
All lane files are clean in the working tree, so the working copies equal the
committed content and I read them directly.

## Findings

### [MEDIUM] Escape is stolen by a popover underneath the ⌘K palette, and focus lands behind the modal — CONFIRMED

**Location:** `app/renderer/src/overlayFocus.ts:323-333` (popover Escape) vs
`app/renderer/src/overlayFocus.ts:257-291` (modal Escape);
`app/renderer/src/App.tsx:2100-2109` (⌘K)

**Defect:** `useModalFocus` arbitrates Escape between modals through
`modalFocusStack.isTop`, but `usePopoverFocus` has no stack awareness at all, so
when a popover is open beneath a modal the popover's `document` listener wins
purely on registration order.

**Failure scenario:** Open a composer face popover (Model / Reasoning /
Permission mode; `composerPopover.ts:28`), then press ⌘K. The palette opens
(`z-[210]`, above the popover's `z-40`) and takes focus. The popover does **not**
close: `usePopover` only dismisses on an outside `mousedown`
(`composerPopover.ts:46-55`), and no mouse event occurred. Now press Escape:

1. The popover's listener runs first and unconditionally handles it —
   `event.preventDefault()`, `restoreTriggerFocus()`, `onEscape()`.
2. `restoreFocus` moves focus to the composer's trigger `<button>`, which is
   behind the palette's full-viewport scrim.
3. The palette's listener runs next, sees `event.defaultPrevented`, and
   `modalKeyAction` returns `null` (`overlayFocus.ts:183`). The palette stays
   open with focus outside itself.

The user is left with an open modal whose search input is not focused; Enter or
Space now activates the composer button behind the scrim (re-opening the
popover). A second Escape closes the palette.

**Evidence:** ordering is deterministic, not incidental. The palette's Escape
effect lists `onEscape` in its deps (`overlayFocus.ts:291`) and App passes an
inline arrow (`App.tsx:3072` `onClose={() => setPaletteOpen(false)}`), so it is
torn down and re-added on **every** App render — always landing last in
`document`'s listener list. The popover's effect deps
(`[onEscape, open, restoreTriggerFocus]`, `overlayFocus.ts:333`) are all stable
`useCallback`s, so it never re-registers and stays first. Commit `35b1bd6`
solved exactly this hazard for modal-vs-modal ("even if callback changes reorder
listener registration") but popovers were left outside the arbitration. Same
path is reachable with ⌘K over an open `SessionActionsMenu` / sidebar row menu.

---

### [MEDIUM] A failed initial roster read permanently disables layout persistence and startup preload, with a retry control that can vanish — CONFIRMED

**Location:** `app/renderer/src/App.tsx:502-507, 786-807, 1075-1093, 1101-1114,
1116-1121, 3004-3025`; `app/renderer/src/rosterBootstrap.ts:19-33`

**Defect:** `hostSnapshotReady` used to become true on *any* settled read
(`.finally(() => setHostSnapshotReady(true))` at `2f4278d:App.tsx`). It is now
`rosterBootstrap.status === 'ready'`, reachable only via `read-succeeded`. There
is no automatic retry, and the sole `onRetry` wiring lives on the
`WelcomeScreen` launcher, which is rendered only in the `chat` view when there is
no active session.

**Failure scenario:** Cold launch; `bridge.listSessions()` rejects (host IPC
hiccup / registry read error). State goes to `failure`. The launcher shows
"Recent projects could not load. / Retry". The user ignores it and presses ⌘T,
picks a folder, and gets a session. `session-added` arrives, `activeSessionId`
is set, `workspacePanels.length > 0` → the `WelcomeScreen` branch
(`App.tsx:3004`) unmounts and the Retry button is gone for the rest of the run.
`hostSnapshotReady` stays false forever, which silently disables:

- `writeWorkspaceLayoutToStorage` (`App.tsx:1116-1121`) — the user splits into
  two panels, quits, relaunches, and the split is gone with no error;
- `runStartupTranscriptPreload` (`App.tsx:1075-1093`) — every restore is a
  cold cache read;
- the saved-split re-form (`App.tsx:1101-1114`), which also leaves
  `pendingRestore` non-null, double-blocking the persist effect above.

Nothing is surfaced: the failure never reaches `shellError` or a banner.

**Evidence:** `reduceRosterBootstrapState` has exactly one edge into `ready`
(`rosterBootstrap.ts:30-31`), and `hydrateHostRoster` has exactly two call sites
— the mount effect (`App.tsx:876`) whose deps are two `[]`-dep `useCallback`s so
it runs once, and `App.tsx:3021`. The intent in the commit message ("so
snapshot-dependent work does not start from an unknown roster") is sound; the
recovery path is what is incomplete.

---

### [LOW] Global shell chords fire straight through an open modal — CONFIRMED

**Location:** `app/renderer/src/App.tsx:2100-2130`

**Defect:** The ⌘K/⌘T/⌘W/⌘1-9 `document` keydown handler has no modal-state
guard, and `modalKeyAction` deliberately ignores modifier chords, so a modal
that is `aria-modal="true"` and traps Tab does not gate any of them.

**Failure scenario:** Open the ⋯ menu on session A and pick Branch. The
`BranchDialog` opens, subtitled "Fork a copy of this conversation". Press ⌘2 →
`selectTab(sessionB)` runs behind the dialog: `setActiveSessionId(B)` and
`setActiveView('chat')`. The dialog stays mounted (it is bound to
`branchConfirm.sessionId`, correctly) and now floats over session B's
transcript. "this conversation" is now false on screen. The confirm still forks
A, so no wrong write occurs, but the confirmation gate is showing the user a
different session than the one it will act on. ⌘T behaves similarly, opening the
native folder picker over any modal, including the workspace trust gate.

**Evidence:** `App.tsx:2102` returns only for non-meta/ctrl or alt events; there
is no check on `paletteOpen`, `branchConfirm`, `exportDialog`, `metadataOpen`,
`tasksOpen`, or `showTrustGate`. (⌘W is in the same block but on macOS Electron
installs its default application menu — `Menu.setApplicationMenu` is never
called in `app/main` — so its Window→Close accelerator probably takes ⌘W before
the renderer sees it; I did not verify that at runtime, so I am not resting the
finding on ⌘W.)

---

### [LOW] Dismissing an anchored menu by its scrim drops focus to `<body>` — CONFIRMED

**Location:** `app/renderer/src/SessionActionsMenu.tsx:89-97, 191-195`;
`app/renderer/src/Sidebar.tsx:1122-1123`; `app/renderer/src/SessionsPage.tsx:1007`

**Defect:** `usePopoverFocus` restores the trigger only on Escape or an explicit
`restoreTriggerFocus()` from a selection handler. The scrim path calls only
`onClose`.

**Failure scenario:** Tab to a session tab's ⋯ button and press Enter. The menu
opens and `usePopoverFocus` focuses its first `role="menuitem"`
(`overlayFocus.ts:317-320`). Click the scrim to dismiss. The scrim is a plain
`aria-hidden` `div`, so the click focuses nothing; the focused menu item is then
unmounted and focus falls to `document.body`. The next Tab restarts from the top
of the document instead of returning to the ⋯ button.

**Evidence:** `composerPopover.ts:25-26` states the intended rule ("Plain
outside-click leaves focus wherever the user clicked"), which is reasonable for
a real outside click but degenerates to focus loss for these three surfaces
because a full-viewport non-focusable scrim swallows the click.

---

### [LOW] `modalKeyAction` treats modifier+Tab as a plain Tab, unlike Escape — CONFIRMED

**Location:** `app/renderer/src/overlayFocus.ts:173-186`

**Defect:** `overlayEscapeAction` explicitly rejects `metaKey`/`ctrlKey`/
`altKey` (`overlayFocus.ts:79-83`), but the Tab branch is a bare
`event.key === 'Tab'` with no modifier filter, and `nextTabStopIndex` only reads
`shiftKey`.

**Failure scenario:** With any modal open, press Ctrl+Tab. `modalKeyAction`
returns `'tab'`, the handler calls `event.preventDefault()` and moves focus to
the next control inside the modal — the chord is swallowed and mis-handled
rather than ignored. The same applies to any other modifier+Tab the OS does not
intercept first.

---

### [LOW] Closing the Export dialog before its result lands toasts a success the user never received — CONFIRMED

**Location:** `app/renderer/src/App.tsx:1417-1418, 1470-1477`

**Defect:** The export-result suppression is keyed on `openExportRequestIdRef`
read at result time. If the dialog is gone by then, the ref is already `null`
and the generic toast fires.

**Failure scenario:** ⋯ → Export. The dialog opens `pending` and the verb is
dispatched (`App.tsx:2709-2722`). Press Escape immediately. `setExportDialog(null)`
runs, so `openExportRequestIdRef.current` becomes `null`. The
`session-action.result` arrives ~200 ms later carrying
`message: 'Transcript exported.'` (`app/sidecar/sessionActionsDomain.ts:165`)
and the effect toasts it as a success. Nothing was written to disk and nothing
reached the clipboard — the dialog's Copy button was the only delivery path — so
the toast asserts an export that did not happen from the user's point of view.
The comment at `App.tsx:1414-1416` claims closing the dialog "can never make a
stale outcome pop as a toast later"; that holds only for results that already
arrived.

---

### [LOW] `bannerStackModel.ts` ships with no production consumer — CONFIRMED

**Location:** `app/renderer/src/bannerStackModel.ts:1-31`

**Defect:** `useBannerStack`, `upsertBanner`, and `dismissBanner` are referenced
only by `BannerStack.test.tsx`. App derives `accountHealthBanners` directly
(`App.tsx:1287-1290`) and passes the array to `<BannerStack>`.

**Cost:** The week created a new module file to carry this across the Fast
Refresh boundary out of `BannerStack.tsx` (it was already unused there at
`2f4278d`), so the suite reports four green tests for a stacking/dismissal
model that never runs, and a future contributor who wires it will get
append-and-filter semantics that differ from the account-health banner's
single-id dismissal rule. Deleting it was the alternative to moving it.

## Coverage gaps

The `app/` renderer suite is SSR-only (`renderToStaticMarkup`; no jsdom or
happy-dom is a dependency — see `AccountsPage.test.tsx:27-28`), so React effects
never execute. Concretely, in this lane:

- **The two focus hooks have zero executable coverage.** `overlayFocus.test.ts`
  exercises only the pure helpers (`selectFocusableElements`,
  `nextTabStopIndex`, `overlayEscapeAction`, `modalKeyAction`,
  `createModalFocusStack`). Everything in `useModalFocus`/`usePopoverFocus`
  bodies — `document` listener add/remove, the `requestAnimationFrame` initial
  focus and its `isTop` guard, `restoreFocus`'s `isConnected` check, the Tab
  trap's `container.focus()` fallback, and the modal-vs-popover Escape
  interaction that is finding #1 — ships untested. The stack tests use a
  hand-rolled `focusNode` whose `contains()` walks `parentNode`, which is not
  how a real detached DOM subtree behaves, so even the stack's
  `resolveConnectedRestoreTarget` path is only proven against a model.
- **`SAModal`'s focus half is untested by construction.** The file splits
  `SAModal`/`SAModalFrame` precisely so the frame can be invoked hook-free
  (`SAModal.tsx:47-55`); the tests exercise `SAModalFrame` and the `<SAModal>`
  markup, never `useModalFocus`'s effect.
- **`ToastHost`'s timer lifecycle is untested.** `toastReducer` is covered;
  the expiry `setTimeout`, the cap-eviction timer reconcile
  (`ToastHost.tsx:77-85`), and the unmount clear (`:87-93`) are not — the only
  host-level test asserts SSR renders no viewport.
- **The two new App-level tests are source-text greps.** `App.test.tsx:1853`
  (P4-54) and `:1891` (P4-55) `readFileSync('./App.tsx')` and assert on
  substrings and `indexOf` offsets. They pin the spelling of the source, not the
  behaviour: a behaviour-preserving reformat fails them, and a behaviour break
  that keeps the strings passes them. Neither exercises the state machine's
  effect on `hostSnapshotReady`'s three consumers, which is finding #2.
- `rosterBootstrap.test.ts` does cover the reducer and `attemptRosterBootstrap`
  (including stale-attempt and removal merging) — that part is genuinely tested.

## Clean

- **Stacked modal ownership works.** `createModalFocusStack` correctly returns
  `shouldRestore: false` for a non-top removal, promotes the next owner via
  `isTop`, and — the part I expected to be wrong — patches higher entries whose
  `restoreTarget` lived inside the container being removed
  (`overlayFocus.ts:149-157`), so A-opens/B-opens/A-closes-first leaves B with a
  live restore target. `restoreFocus` and `resolveConnectedRestoreTarget` both
  gate on `isConnected`, so focus is never restored to a detached node.
- **No leaked document listeners.** Every `addEventListener` in `overlayFocus.ts`,
  `composerPopover.ts`, `PlanPanel.tsx`, and `App.tsx` has a matching cleanup;
  both rAFs are cancelled.
- **No keyboard deadlock.** The only `escapeEnabled: false` cases are the
  startup gates (`StartupSurfaces.tsx:129`, deliberate, buttons present),
  `MetadataInspector.tsx:110` (only when `onClose` is absent), and `PlanPanel`
  while its approve menu or revise textarea is up — both of which have their own
  Escape handler that restores the outer one on the next keypress. Effect
  ordering (children-before-parent on mount) puts `ApproveMenu`'s popover
  listener ahead of the re-registered `PlanPanel` modal listener, so Escape
  closes the inner surface first, correctly.
- **Toast lifecycle is sound.** `MAX_TOASTS` cap in the reducer, a reconcile
  effect that reaps timers for evicted toasts, an unmount clear, module-counter
  ids that cannot collide, and stable `toast`/`dismiss` identities so consumer
  effects that list `toast` in their deps do not churn. `ToastHost` is correctly
  mounted above `App` in `main.tsx:25`.
- **Banner dismissal cannot swallow an escalation.** The id doubles as the
  dismissal signature and the reset effect (`App.tsx:1282-1286`) clears it the
  moment the id changes, so capacity→signin re-shows; the pre-effect render
  already shows it, so there is no one-frame hole.
- **Toast dedup cannot permanently swallow a distinct message** — keyed on
  `crypto.randomUUID()` per action, and the tag effect is defined before the
  generic effect so it claims tag ids first.
- **`appModel.ts` extraction is faithful.** `fmtElapsed`, `fmtTok`,
  `buildDebugExport`, `selectPromptDraft`, `reducePromptDrafts`,
  `sendPermissionResponse` are byte-identical moves. `deriveActivity` and
  `selectLiveTokenEstimate` changed on purpose, with the reasoning and the
  removed `task-notification` boundary documented in the file
  (`appModel.ts:56-70, 225-257`); the new token estimate does not double-count a
  message across its rows, degrades to the character estimate rather than zero,
  and is memoised behind the same 30 s gate the byline uses.
- **`mergeRosterSnapshot`** is a verbatim extraction of the previous inline
  hydrate fold, with `removed` and `lastAttachedAt` precedence intact.
- **`reduceRosterBootstrapState`** has a valid exhaustiveness tripwire: the
  switch has no `default` and the declared return type excludes `undefined`, so
  a new action variant fails `tsc` under `strict`.
- **Project rules:** no em dash in any user-visible string in this lane (every
  `—` hit in `App.tsx` is a `//` or `{/* */}` comment); no rendered engineering
  notes, session ids, or `MAX_*` names; no positive `tabIndex` anywhere in
  `app/renderer/src` (so `querySelectorAll` document order really is Tab order
  for the trap); no interpolated Tailwind arbitrary values — `SAModal`'s tint and
  width maps are static `Record`s and its only `[${hex}]` mention is the comment
  warning against it; no new JSX `style={{}}`; the Fast Refresh boundary holds
  (`toastContext.ts`/`toastModel.ts`/`bannerStackModel.ts`/`tabBarModel.ts`/
  `agentChromeModel.ts` are all `.ts`, and `App.tsx` exports only components).
- **`selectAccountHealthBanner`** is a pure selector with an injectable `now`,
  filters the `usageResetAt === 0` unknown sentinel, and refuses to raise a bar
  on an uninitialised pool.

## Uncertainty

- The ⌘W half of finding #3 depends on whether Electron's default macOS
  application menu consumes ⌘W before the renderer's `document` handler.
  `Menu.setApplicationMenu` is never called in `app/main`, so a default menu is
  installed and its Window→Close accelerator very likely wins — which would mean
  the shell's own ⌘W "close tab" shortcut is dead on macOS. That is a separate
  question from this lane and needs a live GUI check; the finding above is
  written to stand on ⌘T/⌘1-9 alone.
- Finding #1's Escape ordering is CONFIRMED from the listener-registration
  analysis, but the *visible* consequence (focus sitting on a control behind the
  scrim) has not been observed in a running app — no DOM harness exists to prove
  it headlessly, and I did not drive the GUI.
