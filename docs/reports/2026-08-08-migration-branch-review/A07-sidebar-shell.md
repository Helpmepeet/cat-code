# A07 — sidebar, tabs, workspace shell

## Verdict

This is the strongest code I have read in this renderer. The four persistence modules
(`sidebarWorkspaceOrder`, `sidebarPinnedSessions`, `sidebarHiddenWorkspaces`, `workspaceLayout`)
are pure, bounded, self-evicting, generic over `{ cwd }` / `{ sessionId }` so they test on bare
fixtures, and every one returns the same reference on a no-op. `shellState.ts` gets tab lifetime
exactly right, and the two focus areas the prompt flagged as risky are already clean: **zero**
interpolated Tailwind arbitrary-value classes in this scope (both dynamic `className`s go through
static maps, and three separate comments warn future editors about the trap), and **zero**
user-visible em dashes (every hit is a comment or a test name). The invented per-session status
word-chips are already gone from both the tab and the sidebar row.

The single most important thing to fix is `WorkspacePanels.tsx`, which is the one file in the scope
that did not get the treatment the others did: it hand-builds status text as `host spawning,
connection parked` and splices raw session ids into six rendered strings, bypassing the shared
`sessionStatusVisual` vocabulary that exists specifically to stop that. Secondarily, `Sidebar.tsx`
at 2219 lines carries ten distinct responsibilities and contains one near-verbatim duplicated
80-line block.

## Findings

### [HIGH] Panel labels hand-build status text from internal plane vocabulary
- **Where**: `/Users/pt/cat-code/app/renderer/src/WorkspacePanels.tsx:434-437`, rendered at `:305`, `:327`, `:371`, `:404`, `:425`
- **Type**: convention | design
- **What**: `sessionState()` returns `` `host ${host}, connection ${panel.connection.status}` `` and
  is spliced into five rendered `aria-label`s (the panel `<section>`, the session `<select>`, the
  close button, both `DropEdge` strips, and the `Divider`). It emits raw wire values — `host
  spawning, connection parked`, `host missing, connection dead` — never routed through
  `sessionStatusVisual`.
- **Trigger / why it matters**: two rules at once. (1) `aria-label` is a user-visible text surface
  per CLAUDE.md §7, and "host"/"connection" are the internal two-plane vocabulary the rule names.
  A screen-reader user tabbing the divider hears the transport model, not the session. (2)
  `sessionStatusVisual.ts:1-6` states it exists to collapse *four* drifted copies of this switch,
  and its `:42-47` note says the TabBar's inline `preview` label was "the exact fifth drifted copy
  this module exists to prevent." This is the sixth, and it is the only one still hand-built. When
  the host status union grows, every other surface updates from one switch and this one silently
  keeps printing the raw enum.
- **Fix**: replace `sessionState()` with `sessionStatusVisual(descriptor.status, descriptor.restorable, true).label`
  (falling back to a plain word when `panel.descriptor` is undefined). One function, five call sites unchanged.

### [MED] Raw session ids rendered to the user, including as visible on-screen text
- **Where**: `/Users/pt/cat-code/app/renderer/src/WorkspacePanels.tsx:440-447` (`workspaceLabel`), `:428-432` (`sessionIdentity`), `:297` (`title`)
- **Type**: convention
- **What**: `workspaceLabel()` falls back to `panel.sessionId.slice(0, 8)` and renders it as the
  **visible** text of the project pill. `sessionIdentity()` appends `(${panel.sessionId})` in full
  to four aria-labels. The pill's `title` falls back to the bare `panel.sessionId`.
- **Trigger / why it matters**: `panel.descriptor` is typed `SessionDescriptor | undefined`
  (`:25`), so every one of these fallbacks is live whenever a panel's descriptor has not landed —
  which is exactly the P3-6 relaunch window `readyToRestoreLayout` was built to cover. The operator
  ruling is that ids and internal identifiers never reach the page; an 8-char id fragment sitting
  in the project pill where a folder name belongs is the same class of thing as the deleted
  `DeferredNote`. Everywhere else in this scope the fallback is a word (`tabBarModel.ts:9` returns
  `'New session'`; `Sidebar.tsx:1383` returns `'Sessions with no recorded workspace'`).
- **Fix**: fall back to the same wording those two use rather than to an id; drop the `(${sessionId})`
  suffix from `sessionIdentity` entirely (`tabLabel` already disambiguates, and panels are also
  numbered).

### [MED] A parked-then-closed session's full agent-mode snapshot is retained for the life of the window
- **Where**: `/Users/pt/cat-code/app/renderer/src/orchestratorState.ts:37-56`
- **Type**: correctness
- **What**: `reduceOrchestratorState` handles exactly two frame kinds. `lifecycle` sets
  `bySession[sessionId] = undefined` (it never `delete`s the key), and nothing at all reacts to
  `session-removed` — the reducer is fed only `{ type: 'frame' }` actions from the frame batch
  (`App.tsx:668-669`, `:855`), never a `HostEvent`.
- **Trigger / why it matters**: `App.tsx:1893-1896` records that "a parked session never receives a
  lifecycle frame when it is closed (the host deregisters the record before the child dies, so the
  exit is dropped)." So: run an orchestrator session with N workers → it idle-parks → the operator
  closes it. No `lifecycle` frame ever arrives, so its entire `AgentModeSnapshot` (every
  `AgentModeWorkerItem`, with descriptions and handles) stays pinned in `bySession` until the window
  dies. Unlike the other session-keyed maps in this scope, this one has no reaper. Secondarily,
  every `lifecycle` frame allocates a fresh `bySession` object even for a session that was never in
  the map, re-rendering every consumer for nothing.
- **Fix**: `delete` the key instead of assigning `undefined`, return `state` unchanged when the key
  is absent, and add a `{ type: 'session-removed'; sessionId }` action dispatched alongside the
  existing shell fold.

### [MED] `Sidebar.tsx` is a god component, and its two reorder blocks are near-verbatim duplicates
- **Where**: `/Users/pt/cat-code/app/renderer/src/Sidebar.tsx` (2219 lines); duplication at `:572-615` vs `:617-653`
- **Type**: design
- **What**: one file owns ten separable jobs: (1) the hover/pin/focus expansion state machine plus
  two timers and a `:hover` DOM probe (`:415-452`); (2) the nav destination list, unfold animation,
  static delay map and the focus handoff across the collapsed↔expanded branch swap (`:403-406`,
  `:660-680`, `:702-722`, `:1831-1947`); (3) search/filter; (4) three localStorage-backed stores and
  their commit wrappers (`:362-371`, `:554-570`); (5) workspace-group reordering; (6) pinned-session
  reordering; (7) hidden-workspace hide/restore plus its own popover menu (`:1104-1168`); (8) row
  rendering with drag, context menu, kebab anchor math and recency (`:1478-1829`); (9) group
  rendering with the row cap and the per-workspace "+" (`:1174-1475`); (10) fifteen inline SVG icon
  components (`:1964-2219`, ~257 lines with zero coupling to anything above).

  `reorderHandlers` and `pinnedReorderHandlers` are the same eighty lines twice: identical
  `onDragStart`/`onDragOver`/`onDragLeave`/`onDrop`/`onDragEnd`/`onStep` bodies differing only in
  the state atom, the reducer trio, and which refocus ref they set. The same shape appears a third
  time as the three `commitX` wrappers (`:554-570`), which are byte-identical modulo the store.
- **Trigger / why it matters**: the concrete cost is already visible. The `RowReorderHandlers` type
  had to be introduced (`:224-233`) purely to mirror `WorkspaceReorderHandlers` (`:199-208`), and
  the two carry different key names (`cwd` vs `sessionId`) for the same concept. Any fix to the
  drag semantics has to be applied twice and the SSR-only test suite cannot see a drag at all.
- **Fix**: three seams, in decreasing value. (a) `useReorderList(state, commit, { moved, stepped, edge })`
  in an adjacent `.ts` file — collapses ~80 duplicated lines to ~25 and makes the drag state
  testable without React; the Fast Refresh boundary requires it live in a `.ts` file anyway.
  (b) `usePersistedState(storage, key, read, write)` for the three commit wrappers. (c) move the
  icons to `sidebarIcons.tsx` — a mechanical ~257-line extraction with no behaviour change.

### [LOW] Hidden-workspace self-heal reads activity off the search-filtered row subset
- **Where**: `/Users/pt/cat-code/app/renderer/src/Sidebar.tsx:528-537`, consuming `groups` from `:513-519`
- **Type**: correctness
- **What**: `selectVisibleWorkspaceGroups` is given `groups`, which when a query is present is
  `groupByWorkspace(groupRows.filter(matchesQuery), …)` — so each group's `rows` is the *matching*
  subset. The `activityOf` callback then reduces `sidebarActivityKey` over only those rows.
  `sidebarHiddenWorkspaces.ts:198` describes this argument as "how a group reports its most recent
  work", which the filtered subset is not.
- **Trigger / why it matters**: hide project P at time T. Later send a message in session A of P, so
  P's real activity is now `> T` and P has correctly self-healed back onto the rail. Now type a
  search term that matches only session B of P (older, activity `< T`). P is re-classified as hidden
  for the duration of the search, and the rail reads "Show 1 hidden project" for a project that is
  not hidden. Clicking it is harmless (it re-clears an entry that no longer applies), so this is a
  transient display lie rather than data loss.
- **Fix**: compute the activity key from `allGroups` (the unfiltered sequence, already memoized at
  `:505-512`) rather than from the filtered `groups`, keyed by cwd.

### [LOW] Three dead exports, one of them the function whose misuse was a fixed bug
- **Where**: `sidebarHiddenWorkspaces.ts:166` · `shellState.ts:239` · `sidebarState.ts:220`
- **Type**: dead-code
- **What**: `reduceHiddenWorkspacesCleared` has no production caller — its only references are its
  own test, and `sidebarHiddenWorkspaces.test.ts:88` and `:108` record that the restore button
  *used* to call it and that this was the bug `reduceHiddenWorkspacesShown` was written to fix.
  `selectSession` (`shellState.ts:239`) is referenced only by `shellState.test.ts`.
  `MergedRowVisual.tone` is computed on every sidebar row (`sidebarState.ts:237`) and never read —
  `deriveMergedRowVisual` has exactly one production consumer (`Sidebar.tsx:1521`), which uses
  `.openable`, `.intent`, `.kind` and `.label` but never `.tone`; the O1 dot paints a hardcoded
  `bg-tone-good` off `row.live`.
- **Trigger / why it matters**: the first one is the live hazard. It is the wrong-scope clearer,
  still exported with a plausible name next to the right one, with a green test asserting it works.
  That is a loaded footgun for the next person wiring an "unhide all" affordance.
- **Fix**: delete all three plus their tests; `reduceWorkspaceShown` and `panelIndexForSession` can
  also drop `export` (both are used only inside their own module).

### [LOW] `SessionGroup`'s drop handler has no MIME guard while every sibling handler does
- **Where**: `/Users/pt/cat-code/app/renderer/src/Sidebar.tsx:1303-1310`
- **Type**: quality
- **What**: the group's `onDragOver` (`:1279-1285`) checks `WORKSPACE_ORDER_DRAG_MIME`, and
  `SidebarRowItem`'s `onDrop` (`:1633-1639`) re-checks its own mime, but `SessionGroup`'s `onDrop`
  calls `preventDefault()` and `reorder.onDrop(group.cwd)` unconditionally.
- **Trigger / why it matters**: I could not construct a trigger — `drop` cannot fire without a
  `dragover` that called `preventDefault()`, the group's own `dragover` refuses foreign payloads,
  and no descendant of a `SessionGroup` calls `preventDefault` on `dragover` (group rows are not
  reorderable; only pinned rows are, and those live outside any group). So this is a hardening and
  consistency finding, not a live bug. The cost is that the three drag types
  (`text/workspace-cwd`, `text/pinned-session-id`, `text/sessionId`) are kept apart by a guard that
  is present in three of four handlers, so the invariant reads as accidental.
- **Fix**: copy the four-line `types.some(…)` guard from `:1633-1639` into the group's `onDrop`.

### [LOW] `role="tablist"` contains non-tab children; the resize divider exposes no value
- **Where**: `/Users/pt/cat-code/app/renderer/src/TabBar.tsx:118-151` · `/Users/pt/cat-code/app/renderer/src/WorkspacePanels.tsx:396-409`
- **Type**: quality
- **What**: the `role="tablist"` element wraps the "+" new-session button (`:142-150`) and, in the
  same subtree, the Split/Unsplit cluster (`:153-181`). ARIA requires a tablist's children to be
  tabs. Separately, `Divider` is `role="separator"` with `tabIndex={0}` and arrow-key resize but no
  `aria-valuenow`/`aria-valuemin`/`aria-valuemax`.
- **Trigger / why it matters**: a screen reader announces "tab list, 4 items" while one of them is a
  button, and a focusable separator that reports no value gives no feedback that ArrowLeft did
  anything. Both surfaces are otherwise carefully labelled, so these read as oversights rather than
  choices.
- **Fix**: move the "+" and the split cluster out of the `role="tablist"` element (wrap the mapped
  tabs in their own `role="tablist"` div); add the three value attributes to `Divider` from
  `layout.widths[index]`.

### [LOW] Recency text is computed at render time with no ticker
- **Where**: `/Users/pt/cat-code/app/renderer/src/Sidebar.tsx:1527`, `:1951-1960`
- **Type**: quality
- **What**: `formatRecency(sidebarActivityKey(row))` calls `Date.now()` during render, so a row
  reading `now` keeps reading `now` until something unrelated re-renders the Sidebar.
- **Trigger / why it matters**: in practice the rail re-renders on hover, so the operator rarely
  sees stale text. It is worth knowing rather than fixing: it means the subtitle is a render-time
  artifact, and any future memoization of `SidebarRowItem` would freeze it permanently.
- **Fix**: none needed today. If `SidebarRowItem` is ever memoized, pass a `now` prop from a
  minute-interval tick so the memo key moves.

### [LOW] Raw palette colours bypass the tone tokens the rest of the shell uses
- **Where**: `/Users/pt/cat-code/app/renderer/src/OrchestratorRoster.tsx:51-55`, `:129` · `/Users/pt/cat-code/app/renderer/src/WorkspacePanels.tsx:296`
- **Type**: convention
- **What**: `COUNT_TONE_CLASS` maps to `text-blue-400` / `text-stone-400`, the rest-state dot uses
  `bg-blue-400`, and the panel project pill uses literal hexes `#60a5fa` / `#93c5fd`. Everything
  else in this scope goes through the token families (`bg-tone-good`, `text-tone-warn`, `bg-accent`,
  `text-text-faint`).
- **Trigger / why it matters**: these are static classes, so the Tailwind v4 trap does not apply and
  nothing is broken. The cost is that a theme change moves every other surface and leaves these four
  behind. Both spots carry a correct "never an interpolated arbitrary value" comment, so the author
  was aware of the harder rule and only missed the token one.
- **Fix**: route through the existing tone tokens, or add the two missing token entries if no
  suitable family exists.

## What is good here

- **The four persistence modules are a template worth copying verbatim.** Each is keyed on a stable
  identity with the reason spelled out (`sidebarWorkspaceOrder.ts:17-21` explains why the key is
  `cwd` and never the derived label, because `disambiguateWorkspaceLabels` rewrites labels), each is
  capped at the storage boundary with the truncation direction matched to the insertion direction
  (`sidebarPinnedSessions.ts:34-44` — new pins append, the cap drops from the head, and the comment
  records that the two used to disagree), each returns the *same reference* on a no-op so the caller
  can skip a state write, and each is generic over a minimal row shape so it tests on bare fixtures
  with no `MergedSessionRow` import.
- **Dangling persisted entries are handled by design, not by a reaper.** A pin or hidden-workspace
  entry naming a session/workspace that no longer exists is skipped at read time, bounded by the
  cap, and evicted by the next insertion — so no entry can accumulate forever and none can become
  permanently unclearable. `sidebarHiddenWorkspaces.ts:18-23`'s self-healing rule (activity newer
  than `hiddenAt` un-hides) is the sharpest idea in the scope: it makes "Add project" on a hidden
  folder impossible to get stuck on, and it is the honest answer to "where did my session go".
- **Tab lifetime is exactly right and the reasoning is recorded.** `shellState.ts:149-163`
  `foldTabMembership` treats membership as event history rather than a descriptor predicate: live
  grants, clean close (`restorable` + `exited`) revokes, crash (`restorable` + `disconnected`) keeps,
  and a crashed row hydrated from a *previous* run never gains one because its restart tombstone
  died with that run. I looked for a leak path and found none: `session-removed` prunes `order`,
  `byId`, `tabs` and `previews` together, and the preview↔tab promotion is closed off at
  `App.tsx:1023-1033` and `:1798-1811`.
- **The Tailwind v4 trap is defended in depth, not just avoided.** Three separate comments
  (`Sidebar.tsx:259-261`, `:1314-1315`, `:1715-1716`; `OrchestratorRoster.tsx:50`;
  `orchestratorState.ts:227-229`) tell the next editor *why* the static map exists. That is the
  right shape for a hazard a headless test cannot see.
- **`reorderOnArrival` (`shellState.ts:165-193`) solves a subtle ordering bug correctly**: a
  restored session moves to the end of tab order rather than snapping back to its original arrival
  index, and the comment names the exact failure (index 0 for the first-ever session, jumping ahead
  of tabs the user has open now).

## Not reviewed / uncertain

- **Runtime behaviour.** Per the contract I did not run the app. Every finding above is source-verified,
  but the drag-and-drop paths, the hover/pin timers, and the `:hover` probe at `Sidebar.tsx:443` are
  structurally invisible to the SSR-only renderer suite. In particular I verified the MIME-guard
  reachability argument in finding 6 by reading handlers, not by dragging.
- **The `reduceShell` split the prompt asked me to note.** `shellState.ts` is the pure, exported,
  event-only fold, but the actual reducer `App.tsx:4726-4741` wraps it to add a third action —
  `hydrate`, which delegates to `mergeRosterSnapshot` in `rosterBootstrap.ts:61-75`. So the shell's
  state machine is spread across three files and the module named for it owns only two of the three
  actions. From my side this is defensible (`shellState.ts:11-13` explicitly wants to stay
  React-free and `HostEvent`-only, and hydrate-vs-live merge is genuinely a different concern), but
  it does mean `ShellStateAction` is not the full action union and a reader of `shellState.ts` alone
  will not know `hydrate` exists. A one-line pointer in the `shellState.ts` header would close that.
- **Whether the `WorkspacePanels` aria-labels were a deliberate debugging affordance.** They read
  like a diagnostic aid (`host X, connection Y` is precisely the two-plane split), and there is no
  comment either way. If they were intentional, the fix is to move that text behind the debug-state
  export (`debugStateReport.ts`) rather than delete it. The STATUS row or the P3-6 backlog entry
  would resolve it; I did not find a decision doc covering panel labelling.
