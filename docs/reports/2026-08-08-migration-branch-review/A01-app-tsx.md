# A01 — renderer shell root (App.tsx)

## Verdict

The mechanical hygiene of this code is genuinely high: zero `as` casts, zero `any`, zero inline
`style={{}}`, no interpolated Tailwind arbitrary values, no user-visible em dash, and every one of
the 25 effects in `App()` has a matching teardown. The named "frame for an unknown session gets
silently dropped" bug class is **absent** — `applyServerFrameBatch` fans every frame into every
store with no roster filter. The problem is not defects, it is scale: `App.tsx` is 4,882 lines and
`App()` alone is a single 3,033-line function with 146 hook calls, 23 reducer stores and at least 17
distinct responsibilities. Everything below the top finding is a symptom of that one thing — the
duplicated verb-dispatch blocks, the store-internals reaches, the unpruned per-session maps, and the
unconditional panel rebuild all exist because there is no seam to put them behind. The single most
important fix is to extract the frame/host/preload plumbing and the composer+session-action domains
into `*State.ts` modules and hook files so the remaining shell root is a router.

## Findings

### [HIGH] `App()` is a god component: 3,033 lines, 146 hooks, 17 responsibilities

- **Where**: `app/renderer/src/App.tsx:429-3461` (the component); file total 4,882 lines
- **Type**: design
- **What**: One function owns 28 `useState`, 24 `useReducer` (23 distinct stores), 25 `useEffect`,
  40 `useCallback`, 8 `useMemo` and 21 `useRef`. The file also carries `SessionPane` (1,020 lines,
  `:3542-4561`), `TasksStrip`, `ActivityIndicator`, `ConnectionRecovery`, and a reducer
  (`reduceShell`, `:4726`).
- **Trigger / why it matters**: The distinct jobs, each independently testable if extracted:
  (1) frame-transport subscription + batch fan-out to 20 stores `:820-878`;
  (2) host control-plane subscription + roster projection + local `reduceShell` `:912-981, :4726`;
  (3) transcript-preload scheduler with its own admission queue, byte-reservation ledger and
  cancellation `:735-818, :1181-1199`;
  (4) preview↔live handover + lazy-restore claims `:1023-1033, :1876-1965`;
  (5) workspace layout: split/close/widths, localStorage persistence, restore-on-relaunch
  `:1148-1227, :1681-1770`;
  (6) active-session focus policy `:1013-1021`;
  (7) composer drafts/pastes/history/pending-submit + the CC-16 park/drain machine
  `:2037-2140, :2193-2255`;
  (8) permission response routing + plan/ask dedicated-flow arbitration `:2263-2318`;
  (9) OAuth flow framing with three dwell timers and an orphan-adoption rule `:1404-1438,
  :2803-2907`;
  (10) account verb dispatch + pool promotion + health-banner dismissal `:1316-1396`;
  (11) session actions: menu, rename, branch/export dialogs, tag echo, bulk-export document
  assembly `:1549-1660, :2971-3139, :3284-3330`;
  (12) toast dedup ledgers for three result families `:1547, :1667, :3318`;
  (13) command-palette inventory + recents `:2775-2801`;
  (14) global keyboard shortcuts `:2325-2355`;
  (15) page routing across five views `:3217-3415`;
  (16) visible-session reporting to main for the idle-park policy `:2156-2191`;
  (17) dev debug-state export `:1285-1300`.
  The cost is concrete and already visible in this file: two of the findings below
  (duplicated dispatch blocks, unconditional panel rebuild) exist only because there is nowhere
  else to put the logic, and reasoning about any one effect requires holding 23 stores in head.
- **Fix**: Lift the three plumbing effects into hooks in adjacent `.ts` files
  (`useServerFrameStream`, `useHostRoster`, `useTranscriptPreload`) and move `reduceShell` +
  `ShellAction` into `shellState.ts` where the rest of that reducer already lives. Then split
  `SessionPane` into its own `SessionPane.tsx`. That alone removes ~1,400 lines and 8 effects
  without touching a single locked decision.

### [MED] Per-session renderer maps are never pruned when a session leaves the roster

- **Where**: `app/renderer/src/App.tsx:458-459, :472-474, :523-525, :726`
- **Type**: correctness
- **What**: `pasteState`, `historyState`, `transportErrors`, `revealHiddenSessions`,
  `removedIdsRef`, `toastedActionRequestsRef` and `toastedVerbAckRequestsRef` accumulate one entry
  per session / per request for the life of the window and are never cleared. The
  `session-removed` handler `:958-972` prunes `lazyRestoreClaimsRef`, `cancelledRestoresRef`,
  `swappedPreviewsRef`, `preloadReservedBytesRef` and the preview transcript — but none of these.
- **Trigger / why it matters**: Open a session, paste a 500 KB block into the composer, never
  submit, close the session; `session-removed` fires and the full paste text stays resident in
  `pasteState` forever (`reduceSessionPastesCleared` runs only on submit,
  `composerState.ts:205-213`). Under the die-with-window v1 lifetime this window is meant to run
  for days, and `MAX_REGISTRY_SESSIONS` bounds the registry, not this map. `historyState` is capped
  per session but the *number of session keys* is unbounded. Worse, `releasePendingSubmit`
  `:1776-1790` is called from the `session-removed` handler `:966` and *writes* a draft and a
  transport error for a session that has just left the roster and can never be reopened.
- **Fix**: In the `session-removed` branch `:958-972`, add prune actions for the four per-session
  maps (`reduceSessionPastesCleared`, plus delete-key reducers for history/transport/reveal), and
  skip the draft restore in `releasePendingSubmit` when the caller is the removal path. Bound the
  two `toasted*` sets with an LRU or clear them when their store's `lastBySession` entry is
  evicted.

### [MED] Global ⌘-shortcuts fire while a modal overlay is open, and the metadata inspector retargets

- **Where**: `app/renderer/src/App.tsx:2325-2355` (handler), `:3141-3168` (inspector)
- **Type**: correctness
- **What**: The shell keydown handler is registered on `document` with no guard for an open
  overlay. `useModalFocus` (`overlayFocus.ts:313-330`) claims only `Escape` and `Tab`, so
  ⌘K / ⌘T / ⌘W / ⌘1-9 all reach App while `MetadataInspector`, `ExportDialog`, `BranchDialog`,
  `SessionRenamePopover`, `SessionActionsMenu` or `CommandPalette` is up.
- **Trigger / why it matters**: Open a session's ⋯ menu → "Inspect metadata…" → press ⌘2. The
  `SessionActionsMenu` bound `targetId` (`:2977`) and the comment at `:2966-2970` states the menu
  "acts against the row it was OPENED for, never the active tab" — but `metadataOpen` is a bare
  boolean and the inspector's content is derived entirely from `activeSessionId` (`:3143-3165`), so
  the still-open drawer silently swaps to a different session's cwd, settings, permission context
  and raw log. (Today the `metadata` action is `isActiveOpen`-gated in `sessionActions.ts:198-202`
  so the two ids agree *at open time*; nothing keeps them agreeing afterwards, and nothing
  compile-checks that gate.) The same handler also lets ⌘W close the tab out from under an open
  `BranchDialog` that still holds that session's id.
- **Fix**: Store the target on the drawer (`metadataTarget: SessionId | null` instead of
  `metadataOpen: boolean`) so it renders the session it was opened for, and early-return from the
  shell keydown handler when `modalFocusStack` reports any registered modal.

### [MED] No root error boundary: one render throw blanks the whole window

- **Where**: `app/renderer/src/main.tsx:23-37`
- **Type**: correctness
- **What**: The composition root wraps `<App />` in five context providers and nothing else. The
  only `getDerivedStateFromError` in the entire renderer is `Markdownn` inside
  `TranscriptView.tsx`, scoped to markdown rendering.
- **Trigger / why it matters**: The repo's stated asymmetry is "display = degrade gracefully:
  unknown variant renders a tolerant fallback row, never throws". Any throw that escapes that one
  markdown boundary — a projector row shape the renderer does not expect, an undefined
  `window.catcode` method after a preload change (`bridge.ts:16` returns the global with no runtime
  check and types it non-nullable) — unmounts the entire tree. In a desktop app the window *is* the
  UI: the user gets a blank window with no message, no reload affordance, and the diagnostic only
  in a devtools console they cannot open in a packaged build.
- **Fix**: Add one error boundary between `ToastHost` and `App` that renders the error text plus a
  reload button. This is the cheapest possible fix and it is the difference between a bad frame
  degrading one row and losing the session.

### [MED] The renderer fabricates an `account.result` protocol frame

- **Where**: `app/renderer/src/App.tsx:1324-1336`
- **Type**: design
- **What**: When `sendAccountVerb` is called with no active session, App constructs a literal
  `ServerFrame` — `kind: 'account.result'`, `protocolVersion: PROTOCOL_VERSION`, `sessionId: ''` —
  and dispatches it into `accountsState` as if it had arrived over the wire.
- **Trigger / why it matters**: The store can no longer distinguish a sidecar-authored outcome from
  a renderer-authored one, which is exactly the distinction the security baseline is built on. It
  works today only because `SessionId = string` (`app/shared/protocol.ts:82`) lets `''` pass as a
  session id, and because the two consumers happen to filter it out: `SessionPane` compares
  `accountsLastResult.sessionId === activeSessionId` (`:3617`) and the pool-promotion effect
  early-returns on `!result.ok` (`:1363`). Both are accidents, not guarantees. It also means
  `PROTOCOL_VERSION` — the wire contract's version constant — is imported into App for the sole
  purpose of forging a frame.
- **Fix**: Give `accountsState` a local action (`{ type: 'localVerbRejected', requestId, message }`)
  and dispatch that. The wire vocabulary stops being something the renderer can author.

### [MED] `sessionId` means two different ids in the same component, with no type to tell them apart

- **Where**: `app/renderer/src/App.tsx:504-506, :3022, :3291-3294` vs `:488-502, :510-515, :537-545`
- **Type**: quality
- **What**: `SessionId` is `export type SessionId = string` (`app/shared/protocol.ts:82`), so the
  compiler cannot separate the address (`appSessionId`) from the transcript key
  (`engineSessionId`). App holds five pieces of state whose `sessionId` field is an *app* id
  (`sessionActionsTarget`, `renamingSession`, `branchConfirm`, `exportDialog`, `pendingSubmits`)
  and two whose `sessionId` field is an *engine* id: `sessionsRenameRequest` is fed
  `targetRow.sessionId` (`:3022`), which `sessionsCatalogState.ts:92-99` documents as the engine
  id, and `pendingTagWritesRef` stores `sessionIds: [row.sessionId]` (`:3292`) alongside a verb
  dispatched to `row.appSessionId` (`:3295`).
- **Trigger / why it matters**: Both consumers happen to be correct today
  (`SessionsPage.tsx:178` matches on `row.sessionId`, `sessionsPageState.ts:113` keys confirmed
  tags by the same). Nothing enforces it: swapping `row.sessionId` for `row.appSessionId` at
  `:3022` type-checks cleanly and silently breaks the inline rename for every row. The two-id model
  is a locked decision; the type system currently gives it zero support.
- **Fix**: Brand the ids — `type SessionId = string & { readonly __app: unique symbol }` and an
  `EngineSessionId` peer — or, at minimum, rename these two App-local fields to
  `engineSessionId` so the name carries what the type cannot.

### [MED] The verb-dispatch try/catch block is copy-pasted ~12 times inside the panel map

- **Where**: `app/renderer/src/App.tsx:2475-2482, :2542-2553, :2556-2567, :2570-2581, :2599-2606, :2673-2685, :2723-2730` (plus `:2093-2101, :2129-2138, :2277-2288`)
- **Type**: quality
- **What**: Every bridge verb repeats the identical shape: `try { getBridge().X(sessionId, …);
  setTransportErrors(prev => reduceTransportErrorCleared(prev, sessionId)) } catch (error) {
  setTransportErrors(prev => reduceTransportErrorSet(prev, sessionId, errorMessage(error))) }`.
  `getBridge()` is called 33 times in `App()`.
- **Trigger / why it matters**: This is where a divergence hides. `onRequestContextBreakdown`
  (`:2530-2537`) already deviates deliberately (best-effort, swallows), and
  `onToggleOrchestrator` (`:2598`) adds a `connectionHasEngine` guard the six siblings do not have
  — those are correct decisions but they are invisible against seven identical neighbours, so the
  next verb added will be a coin flip. The indentation in this region is also literal-tab/space
  mixed (`:2367-2765`), which is what happens to code nobody wants to touch.
- **Fix**: One `useCallback` helper, `sendVerb(sessionId, fn)`, that owns the try/catch and the two
  `setTransportErrors` calls; the deviating cases then read as deviations.

### [MED] `workspacePanels` is rebuilt on every render, including on views that never show a panel

- **Where**: `app/renderer/src/App.tsx:2365-2766`
- **Type**: quality
- **What**: A 400-line unmemoized expression that, per panel, runs ~20 store selectors
  (`selectRawMessageLog`, `selectConnection`, `selectPermissionQueue`, `selectPlanReview`,
  `selectAskQuestion`, `selectGenericPermissionQueue`, `selectPreviewTranscript`,
  `selectAccountsSnapshot`, `selectAgentModeSnapshot`, `selectDiagnosticsSnapshot`,
  `selectRunControlsSnapshot`, `selectContextBreakdown`, `selectSlashCatalog`, …), performs an
  O(n) `sessionCatalogRows.find` (`:2430`), filters the entire raw message log (`:2401-2403`), and
  constructs a full `<SessionPane>` element tree with ~40 freshly-allocated closures.
- **Trigger / why it matters**: `App` re-renders on every batched frame delivery, i.e. at
  streaming cadence. On the Settings / Sessions / Accounts / Goals views the result is consumed
  only as `workspacePanels.length` (`:2779`, `:3366`) — the whole tree is built and thrown away
  while the user is on a page that cannot show it. The `paletteItems` guard right below
  (`:2775`, with its comment explaining exactly this reasoning for the palette) shows the author
  already knew the rule and did not apply it here.
- **Fix**: `useMemo` it, and skip the build entirely when `activeView !== 'chat'` (return
  `workspaceLayout.panels.length` separately for the two `.length` consumers).

### [MED] App reaches past the `select<X>` seam into eight state modules' internals

- **Where**: `app/renderer/src/App.tsx:1367, :1566, :1592, :2465, :3232, :3252, :3380-3382, :3911`
- **Type**: design
- **What**: The renderer-state convention is `create<X>State` / `reduce<X>State` / `select<X>`, and
  App uses it for most reads — then bypasses it for `accounts.pool`, `accounts.lastResult`,
  `sessionActionRuntime.lastBySession`, `remoteSettings.lastResult`, `rosterBootstrap.status`,
  `rosterBootstrap.retrying`, and `transcript.sessions[activeSessionId]?.rows.length` (`:3911`,
  two lines below a correct `selectNestedTranscriptRows` call on the same state).
- **Trigger / why it matters**: `:3911` is the sharpest case: it is load-bearing scroll logic
  (`contentSignature`), and its own comment explains it must be derived from the *rendered*
  transcript — yet it hand-rolls the read, so a change to `TranscriptState`'s internal shape
  breaks scroll-to-bottom with no selector to update. The `lastBySession` cases are a missing
  selector rather than a bypass: the tag and bulk-export effects need "all sessions' latest
  results" and the module only exports the per-session read.
- **Fix**: Add `selectRenderedRowCount(state, sessionId)` to `transcriptProjector.ts` and
  `selectAllLatestResults(state)` to `sessionActionRuntimeState.ts`; route the remaining five
  through existing selectors.

### [LOW] A debug surface marked "TEMPORARY … DELETE ME" on 2026-07-28 is still shipping

- **Where**: `app/renderer/src/App.tsx:4509-4534`
- **Type**: dead-code
- **What**: A dev-gated line under the composer printing `app <appSessionId> · engine
  <engineSessionId> · facts model,mode,effort,ctx`.
- **Trigger / why it matters**: It is honest about itself — the comment names the §7 rule it would
  violate and the `import.meta.env.DEV` gate keeps it out of production, so this is not a live
  convention breach. But it is ten days past its stated deletion date, it is precisely the
  "print the engineering to-do list on the page" shape that got `DeferredNote` deleted, and every
  dev-loop screenshot the operator takes now carries it.
- **Fix**: Delete it, or move the same three facts into `buildDebugShellStateSnapshot` (`:1291`),
  which already exists to carry dev state out of the renderer without rendering it.

### [LOW] One rejection permanently disables all transcript preloading for the run

- **Where**: `app/renderer/src/App.tsx:759-815`
- **Type**: quality
- **What**: `preloadQueueRef.current = preloadQueueRef.current.then(async () => { try { … }
  finally { … } })`. There is a `finally` but no `catch`, and the chained promise is the queue
  itself.
- **Trigger / why it matters**: If anything in the chained body ever rejects, `preloadQueueRef`
  becomes a rejected promise and every subsequent `.then()` is skipped for the lifetime of the
  window — startup preload and same-launch backfill both go silently dead, plus an unhandled
  rejection. I traced the body and could **not** find a guaranteed throw path today
  (`runStartupTranscriptPreload` catches around both `previewSession` and `onLoad`,
  `sessionPreload.ts:190-218`; `calculateStartupPreloadCapacity` is pure). So this is a robustness
  shape, not a live bug — but the failure mode is total and silent, which is the wrong direction
  for a queue.
- **Fix**: `.then(…).catch(() => {})` on the chain assignment, so a rejection costs one job rather
  than the queue.

## What is good here

- **Frames are not dropped for unknown sessions.** `applyServerFrameBatch`
  (`serverFrameBatch.ts:97-116`) dispatches every frame to all 20 stores unconditionally;
  `getRosterById` is consulted only for focus arbitration (`:87-95`), never as a filter. The
  known "renderer store silently loses events for a session it doesn't know about" failure is
  genuinely absent on this path.
- **Every listener, timer and subscription is torn down.** I checked all 25 effects in `App()` and
  all 11 in `SessionPane`: `document` keydown (`:2353-2354`), frame subscribe (`:877`), host
  subscribe (`:979`), the rAF+timeout pair (`:1194-1198`), three OAuth dwell timers, the debug
  timer (`:1299`), and the elapsed `setInterval` (`:3851`) all pair correctly. There is no
  per-session registration that outlives its session.
- **The stable-identity discipline is real, not cargo cult.** The batch-folding reducers at module
  scope (`:387-420`), `EMPTY_WORKERS` / `EMPTY_BANNERS` / `EMPTY_PALETTE_ITEMS` / `EMPTY_TURN_STARTS`,
  and the `paneSessionKey` vs `rosterKey` separator reasoning (`:1201-1206`) each fix a named
  re-render or missed-effect bug, with the failure mode written down.
- **Mechanical conventions are clean throughout.** Zero `as` casts, zero `any`, zero inline
  `style={{}}`, no interpolated arbitrary-value Tailwind class (the `${dot}` / `${tone}` splices
  are complete static class names), and no em dash on any user-visible surface — every `—` in the
  file is inside a comment. Fast Refresh is satisfied: the four runtime exports (`App`,
  `TasksStrip`, `SessionPane`, `ConnectionRecovery`) are all components, and the module-scope
  helpers and `reduceShell` are unexported.
- **`bridge.ts` is the right size.** Type-only protocol import, one accessor, a documented reason
  (no engine runtime in the renderer bundle). Nothing to change except the missing runtime
  null-guard noted above.

## Not reviewed / uncertain

- I did not run the app or any test. `App.test.tsx` (2,256 lines) exists and I did not read it —
  some findings above may already have coverage, or a deliberate recorded waiver I did not see.
- The preload-chain poisoning (`:759-815`) is reported as robustness, not a defect, precisely
  because I could not name a throw path. Reading `previewTranscriptState.ts`'s reducer for a throw
  on a malformed cache would settle it either way.
- I did not check whether the modal/shortcut interaction is a recorded accepted behavior; no
  decision doc under `docs/migration/decisions/` was consulted for it.
- The two perf findings are structural (call counts and render cadence read from source), not
  measured. A React Profiler trace during a streaming turn would size them.
- `SessionPane` (`:3542-4561`) is in this file and I read it fully, but its composer/keyboard
  behavior is only source-verifiable here; the renderer suite is SSR-only, so the caret,
  IME and picker paths in `onComposerKeyDown` (`:4006-4170`) are structurally untestable headlessly
  and I have made no claim about them.
