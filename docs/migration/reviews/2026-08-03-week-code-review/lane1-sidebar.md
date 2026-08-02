# Lane 1: Sidebar and session organization

## Scope reviewed

Committed range `2f4278d..7c6959f` for `Sidebar.tsx` (+1445/-176), the three new
renderer-local persistence modules (`sidebarWorkspaceOrder.ts`,
`sidebarPinnedSessions.ts`, `sidebarHiddenWorkspaces.ts`), `SessionsPage.tsx`
(+685/-58) with `sessionsPageState.ts`, and the session-action surface
(`SessionActionsMenu.tsx`, `SessionActionIcons.tsx`, `SessionActionDialogs.tsx`,
`sessionActionDialogState.ts`, `sessionActions.ts`) plus all colocated tests. The
week rebuilt the rail from a new design source (New chat, a Pinned section that
lifts a session out of its project group, a Projects header with add/hide, a
folded footer nav), added drag + ⌥↑/⌥↓ reordering for workspace headers and
pinned rows with localStorage persistence, added project hiding with an
activity-based self-heal, shipped the P4-29 Sessions-page action half
(multi-select, bulk bar, inline rename, tag popover) and the P4-30 Branch/Export
dialogs, and reverted an in-group session ordering feature that inverted the rail
at its 64-id cap. I read the full current files at HEAD (`f5bda45`); every file in
this lane is byte-identical between `7c6959f` and HEAD and clean in the working
tree, so no `git show` anchoring was needed. `git diff 7c6959f f5bda45 --
app/renderer/src/` touches only `rawMessageLog.*`.

Overall the lane is in good shape. The pure reducers/selectors are unusually well
specified and well tested, the storage boundary is genuinely defensive (a corrupt,
absent, wrong-version or junk-laden store degrades to empty and never throws or
blanks the rail), the Tailwind dynamic-class trap is avoided everywhere with
static maps, the closed union has a real `never` tripwire, and there is no em dash
in any user-visible string. **No HIGH findings.** Two MEDIUMs, both in the wiring
between a tested pure core and the DOM, which is exactly where the SSR-only test
harness cannot see.

## Findings

### [MEDIUM] Reverse Tab into the collapsed rail drops focus to the body: the P4-53 handoff targets a button inside an `inert` container — CONFIRMED
**Location:** `app/renderer/src/Sidebar.tsx:675-680` (the handoff layout effect) and
`app/renderer/src/Sidebar.tsx:994-1019` (the `inert` nav container)

**Defect:** `51cd0f1` fixed reverse focus entry by re-focusing the expanded nav
button that matches the collapsed icon the user Shift+Tabbed onto; `b030f11` then
folded the expanded nav list behind `inert={!navOpen}`, and `HTMLElement.focus()`
on an inert element is a no-op, so the handoff silently fails.

**Failure scenario:** Rail collapsed, `navOpen` false (its only default — nothing
opens it automatically, and `useEffect(() => { if (!open) setNavOpen(false) },
[open])` forces it shut on every collapse). The user Shift+Tabs backwards from the
first control after the sidebar. Focus lands on the last focusable in the `<aside>`,
the collapsed **Settings** `NavItemRail` button. `onFocusCapture` reads
`data-sidebar-nav-id="settings"`, stores `refocusNavId.current = 'settings'`, and
sets `focusWithin` → `open` becomes true → the collapsed `<nav>` branch unmounts
and the focused button is removed from the DOM, so focus falls to `document.body`.
The layout effect then runs `navRefs.current.get('settings')?.focus()` — that
element is `NavItemExpanded`'s button, which lives inside
`<div … inert={!navOpen}>` with `navOpen === false`. Per the HTML focusing steps
an inert element is not focusable, so `focus()` does nothing. Net result: the
sidebar expands but focus is on `<body>`, and the next Shift+Tab jumps to the end
of the document instead of continuing backwards through the rail. Forward entry
(Tab onto the always-mounted pin) is unaffected.

**Evidence:** The repo's own focus helper already encodes the rule this violates —
`app/renderer/src/overlayFocus.ts:44` treats `closest('[hidden], [inert], …') !==
null` as not focusable. The SSR test that guards this is
`Sidebar.test.tsx:813-822`, which asserts `inert=""` **and** `data-sidebar-nav-id="settings"`
in the same markup with the comment "Every destination is still MOUNTED (the
focus-handoff ref map depends on it)" — mounted is necessary but not sufficient,
and SSR cannot dispatch focus, which is why the regression survived. Note the
handoff was correct when written: at `51cd0f1` the expanded footer had no folded
container at all; `inert` first appears in `b030f11` (`git show b030f11 --
app/renderer/src/Sidebar.tsx | grep -n inert` → line 793 of the diff, one hunk).

---

### [MEDIUM] "Show 1 hidden project" un-hides every hidden project, not the one it names — CONFIRMED
**Location:** `app/renderer/src/Sidebar.tsx:932-946`, with
`app/renderer/src/sidebarHiddenWorkspaces.ts:166-170`

**Defect:** The restore button's label is computed from `hiddenGroups.length`
(hidden projects **in this render's group list**) but its click calls
`reduceHiddenWorkspacesCleared`, which empties the entire persisted hidden list —
including entries the current render never enumerated.

**Failure scenario:** Operator hides projects `/w/alpha` and `/w/beta` via the
project ⋮. Both leave the rail; the button reads "Show 2 hidden projects". They
then type `alpha` into the rail's search box. `groups` is recomputed from
`groupRows.filter(matchesQuery)`, so only `/w/alpha`'s group exists this render;
`selectVisibleWorkspaceGroups` therefore returns `hidden: [alpha]` and the button
now reads **"Show 1 hidden project"**. Clicking it calls
`commitHiddenWorkspaces(reduceHiddenWorkspacesCleared(hiddenWorkspaces))` →
`[]`, so `/w/beta` is un-hidden too and reappears the moment the search is
cleared. The same mismatch occurs without any search whenever a hidden project's
rows are all dropped by `isSidebarVisibleRow` (dead-cwd history rows,
`sidebarState.ts:285`) or all pinned (`selectUnpinnedRows` removes them from
`groupRows` before grouping), so the project has no group this render.

**Evidence:**
```jsx
{hiddenGroups.length > 0 ? (
  <button onClick={() => commitHiddenWorkspaces(reduceHiddenWorkspacesCleared(hiddenWorkspaces))} …>
    {hiddenGroups.length === 1 ? 'Show 1 hidden project' : `Show ${hiddenGroups.length} hidden projects`}
```
`hiddenGroups` comes from `selectVisibleWorkspaceGroups(groups, …)`, which only
ever iterates `groups` — an entry in `hiddenWorkspaces` whose cwd is not in
`groups` contributes nothing to the count but is still cleared. The per-project
inverse already exists and is fully tested (`reduceWorkspaceShown`,
`sidebarHiddenWorkspaces.ts:157-163`; `sidebarHiddenWorkspaces.test.ts:68`) but
has **zero call sites in the renderer** (`rg reduceWorkspaceShown
app/renderer/src --glob '!*.test.*'` → only the definition), so clear-all is the
only way back and the mismatch is unavoidable in practice. It is non-destructive
and re-hidable, hence MEDIUM rather than HIGH.

---

### [LOW] Pinning a 33rd session shows it pinned, then silently loses it on relaunch — CONFIRMED
**Location:** `app/renderer/src/sidebarPinnedSessions.ts:41`, `:80-86`, `:130-144`

**Defect:** The storage cap truncates the **tail** of the pin list, but
`reducePinnedSessionsToggled` appends new pins to the **tail**, so past the cap
the entry that gets dropped is always the one the user just created. In-memory
state is uncapped, so the UI shows the pin succeeding.

**Failure scenario:** 32 sessions are pinned. The operator pins a 33rd. It appears
at the bottom of the Pinned section immediately (state is
`[...pinned, sessionId]`, uncapped). `writePinnedSessionsToStorage` persists
`normalizePinnedSessions(pinned).slice(0, 32)`, which keeps entries 1..32 and
drops the new one. On the next launch the session is not pinned, with no notice.

**Evidence:** `MAX_SIDEBAR_PINNED_SESSIONS = 32`, and its own doc comment argues
"The tail is the least-preferred end, so truncating there costs least" — which
contradicts `reducePinnedSessionsToggled`'s "A NEW pin lands at the END of the
list". Only one of the two can be true. This is the same cap-versus-order class of
bug the header of `Sidebar.tsx:86-98` documents for the reverted in-group ordering
("shipped on 2026-08-01 with a 64-id cap and inverted the rail"); the pinned list
is short enough that the blast radius is one lost pin rather than an inverted
rail, hence LOW. `MAX_SIDEBAR_WORKSPACE_ORDER_ENTRIES = 64` has the same shape but
new ranks are inserted positionally rather than appended, and 64 workspaces is
implausible.

---

### [LOW] Disabled menu rows print "soon" even for verbs that are fully built and merely session-gated — CONFIRMED
**Location:** `app/renderer/src/SessionActionsMenu.tsx:322-338`, with
`app/renderer/src/sessionActions.ts:100-101`

**Defect:** `MenuRow` renders the literal `soon` marker for *every* `enabled:
false` item, but `resolveSessionActions` disables items for two different reasons:
genuinely unbuilt (`rewind`, `copy-md`) and built-but-not-applicable-right-now
(`rename` / `branch` / `export` on a closed session, `open` on a history row,
`copy`/`metadata` on a non-attached tab).

**Failure scenario:** Right-click a closed (restorable) session row in the rail.
The menu shows `Rename` greyed with the marker **soon**, whose hover title reads
"Open or restore this session first. Rename, Export and Branch run in its live
engine, which a closed session has stopped." The marker says the feature does not
exist; the reason says it exists and needs one action. Restoring the session
makes the same row work, so the marker was simply wrong. Rename/Export/Branch are
explicitly documented as *wired* verbs (`sessionActions.ts:11-27`).

**Evidence:** `MenuRow`'s disabled branch has no per-item condition:
```jsx
<span …>soon</span>
```
Only `SessionActionItem.reason` distinguishes the two cases, and nothing reads it
except the `title`. `SessionActionsMenu.test.tsx:106` asserts "soon" for Rewind;
`:125` covers the non-live row but deliberately asserts only on `'live engine'`,
so the wrong marker is untested. Secondary, same location: the disabled row is a
`<div role="menuitem" aria-disabled="true" title={reason}>` with no `tabindex`, so
it does not match `MENU_ITEM_SELECTOR` (`overlayFocus.ts:20-25`) and is skipped by
`handleMenuRovingKeyDown` — the honest reason this whole design rests on is
pointer-hover-only and unreachable by keyboard or screen reader.

---

### [LOW] Session rows are `role="button"` containing real buttons, which makes the kebab and pin presentational to assistive tech — CONFIRMED
**Location:** `app/renderer/src/Sidebar.tsx:1539/1557` (`SidebarRowItem`), same
pattern at `app/renderer/src/SessionsPage.tsx:739-741`

**Defect:** WAI-ARIA lists `button` among the roles whose children are
presentational, so the nested `Session actions for X` and `Pin X` buttons inside a
`role="button"` row are not exposed as controls.

**Failure scenario:** A screen-reader user arrows to a sidebar session row. It is
announced as "session Alpha, live, button". The kebab and the pin toggle are
inside it and are dropped from the accessibility tree by the presentational-children
rule, so the only per-row action reachable without a pointer is activating the row
itself. (They remain in the Tab order, so the controls are physically focusable —
the loss is semantic exposure, and real AT behaviour varies, which is why this is
LOW.)

**Evidence:** `SessionsPage.tsx:735-737` reasons the opposite direction for the
same problem ("A div, not a button: the row now nests its own controls … a button
may not contain buttons") and then applies `role="button"` to the div anyway,
reintroducing the constraint it was avoiding.

---

### [LOW] The tag popover silently does nothing if its target stops being live while it is open — CONFIRMED
**Location:** `app/renderer/src/SessionsPage.tsx:220-231`

**Defect:** `applyTag` re-filters the target rows to `row.live && row.appSessionId
!= null` and dispatches only when the filtered list is non-empty, but closes the
popover unconditionally and gives no feedback in the empty case.

**Failure scenario:** Open a live row's `+ tag` control (it is enabled only for a
live row). While the popover is open, the session crashes or is closed; the
catalog refresh flips `row.live` to false. `catalog-settled` keeps the popover
open because the row still exists (`sessionsPageState.ts:137-142` only drops the
popover when the row disappears). The user clicks a tag. `writable.length === 0`,
so no verb is sent, the popover closes, no toast fires, and the row shows no tag —
indistinguishable from the write having been applied and then reverted.

**Evidence:**
```ts
const writable = targets.filter(row => row.live && row.appSessionId != null)
if (writable.length > 0) onTagRows?.(writable, tag)
if (target.kind === 'bulk') dispatchPage({ type: 'clear-selection' })
dispatchPage({ type: 'close-tag-popover' })
```
The bulk path has the same silent-drop shape, though the bulk button's `title`
does at least warn up front when `writableCount < selectedCount`
(`SessionsPage.tsx:938-944`). The single-row path has no such warning.

---

### [LOW] Hiding a project drops keyboard focus to the document body — CONFIRMED (stuck-rail consequence PLAUSIBLE)
**Location:** `app/renderer/src/Sidebar.tsx:1140-1151` (`WorkspaceActionsMenu`'s
Hide item), `app/renderer/src/Sidebar.tsx:1053-1068`

**Defect:** `restoreTriggerFocus()` returns focus to the project header's ⋮ button
and the very next statement (`onHide()`) removes that button from the DOM by
hiding the group.

**Failure scenario:** Keyboard user opens a project ⋮ (focus moves into the menu
via `usePopoverFocus`'s rAF), presses Enter on "Hide project". `restoreTriggerFocus()`
focuses the ⋮; `onHide()` → `commitHiddenWorkspaces` → the whole `SessionGroup`
unmounts, taking the just-focused button with it. Focus ends on `<body>`, so the
next Tab restarts from the top of the document rather than from the Projects
section. The scrim-dismiss path (`onClose` on the backdrop, `:1125`) never calls
`restoreTriggerFocus()` at all, so it has the same end state.

**Evidence:**
```jsx
onClick={() => { restoreTriggerFocus(); onHide(); onClose() }}
```
Related and worth watching, but I could not close it by source alone: the rail's
`open` state includes `focusWithin`, which is cleared **only** by
`onBlurCapture` on the `<aside>`. If the browser does not dispatch
`blur`/`focusout` for a focused element that is removed from the DOM (Chromium's
historical behaviour), `focusWithin` stays `true` after this unmount and the rail
stays expanded over the transcript until the user clicks a non-focusable region
elsewhere. The existing `useEffect([menuActive, pinned])` re-collapse guard
(`Sidebar.tsx:440-446`) does not cover this, because the project menu is local
`workspaceMenu` state and is not part of the App-level `menuActive` prop. I am
marking this half PLAUSIBLE because it turns on browser blur-on-removal semantics
I cannot verify from source.

---

### [LOW] The Export dialog can sit on "Rendering this session, one moment." forever — CONFIRMED
**Location:** `app/renderer/src/SessionActionDialogs.tsx:143-153`, with
`app/renderer/src/App.tsx:1484-1499`

**Defect:** The dialog's only exit from `pending` is a `session-action.result`
frame carrying its own `requestId`. Nothing else clears it — not session death,
not a timeout.

**Failure scenario:** Export is chosen on a live session; `session.export` is
dispatched and the dialog opens pending. The sidecar crashes (or the session is
closed) before rendering the transcript, so no result frame for that `requestId`
ever arrives. `selectExportPreview` keeps returning `{status:'pending'}`, the
latch never fills, the pane keeps reading "Rendering this session, one moment.",
Copy stays disabled with "The transcript is still rendering.", and Download is
permanently disabled by design. The only way out is the close button, with no
indication that the export failed.

**Evidence:** `selectExportPreview` maps everything that is not a matching
`ok`/failed result to `pending` (`sessionActionDialogState.ts:64-75`), and the
App-side latch effect explicitly bails on pending (`if (projected.status ===
'pending') return`). There is no liveness check on `exportDialog.sessionId`
anywhere. Narrow (requires the engine to die inside the export window) and
recoverable by closing the dialog, hence LOW.

## Coverage gaps

- **Every DOM drag handler ships untested.** `sidebarWorkspaceOrder.test.ts` (423
  lines) and `sidebarPinnedSessions.test.ts` (222) prove the reducers and
  selectors thoroughly, but the SSR harness cannot fire `dragstart`/`dragover`/
  `dragleave`/`drop`. Untested by construction: the MIME gate
  (`types.some(t => t.toLowerCase() === MIME)`) actually rejecting a foreign drag;
  the group's `onDrop` having **no** MIME check at all (safe only because a
  non-matching `dragover` never calls `preventDefault`, so the browser suppresses
  the drop — a one-line change to the `dragover` guard would silently open it);
  `onDragLeave`'s `currentTarget.contains(relatedTarget)` re-entry filter;
  `stopPropagation` keeping a pinned-row drag out of the group handler. The SSR
  tests instead pass `dragging`/`dropEdge` in as props, so they only prove the
  indicator markup, not that the state machine ever reaches those props.
- **Both keyboard refocus paths are unverifiable here** — `refocusCwd` /
  `refocusRowId` / `refocusNavId` all resolve in `useLayoutEffect` + `.focus()`,
  which `renderToStaticMarkup` never runs. The nav one is broken (finding 1) and
  the test that covers it (`Sidebar.test.tsx:478`) asserts only that the
  `data-sidebar-nav-id` markers exist in both branches. Its own comment concedes
  "SSR cannot press Shift+Tab or observe the layout-effect focus."
- **No test combines hidden projects with a search query**, which is the shortest
  path to finding 2. `Sidebar.test.tsx:623-660` covers hide, self-heal and
  nothing-hidden, always with an empty query and every hidden project present in
  the roster.
- **Persistence caps are tested only at the pure boundary.** `MAX_SIDEBAR_PINNED_SESSIONS`
  has a slice test in `sidebarPinnedSessions.test.ts:193`, but nothing exercises
  the component path where in-memory state exceeds the cap and the write silently
  disagrees with what is on screen (finding 3).
- **The Sessions page's action half is mostly shape-asserted.** `SessionsPage.test.tsx`
  proves markers ("+ tag" vs "#tag", menu present/absent, bulk bar present/absent);
  the reducer tests in `sessionsPageState.test.ts` are good, but the wiring in
  between — `applyTag`'s live re-filter, `onRenameCommit` firing from `onBlur`,
  the two one-shot effects (`renameRequest` / `tagEcho`) and their identity-ref
  de-dupe — has no coverage, and it is where finding 6 lives.
- `WorkspaceActionsMenu` is tested only as an isolated `renderToStaticMarkup`
  (`Sidebar.test.tsx:608`); nothing covers the open→hide→focus sequence.

## Clean

- **Em dash sweep is clean.** `rg -n '—'` across all eleven lane files returns 13
  hits, every one inside a `{/* … */}` JSX comment or a `/** … */` block. No JSX
  text, `title`, `aria-label`, `placeholder`, toast, empty state or disabled reason
  carries one. The `'—'` no-value placeholder does not appear.
- **No engineering notes rendered.** Session ids (`P4-53`, `CC-2`, `HC1`, `O1`),
  `file.ts:line` citations and internal vocabulary appear only in comments. User
  strings say what to do ("Open or restore this session first.", "Change it from
  the CLI" idiom, "Add project: choose a folder"). The one debatable marker is
  `soon` (finding 4), which is copy, not jargon.
- **Fast Refresh boundary holds.** Every runtime export from the four `.tsx`
  modules is a component (`Sidebar`, `WorkspaceActionsMenu`, `SessionGroup`,
  `SidebarRowItem`; `SessionsPage`; `SessionActionsMenu`, `SessionRenamePopover`;
  `BranchDialog`, `ExportDialog`; the icon set). `RowDropEdge`,
  `RowReorderHandlers`, `WorkspaceReorderHandlers` and the `SessionActionsAnchor`
  re-export are all `export type`. Reducers, selectors, constants and geometry all
  live in adjacent `.ts` files.
- **Tailwind v4 dynamic-class trap avoided.** `NAV_UNFOLD_DELAY` is a literal
  array of five `delay-[Nms]` strings indexed by position (`Sidebar.tsx:263-269`),
  the drop indicators and the live dot use fixed classes, and the row's cursor is
  built as exactly one class from a ternary chain with an explicit comment about
  emit order. The only `style={{}}` uses are the measured-anchor `top/bottom/left`
  of the three anchored panels, each tagged `§0 EXCEPTION`, which is genuinely not
  expressible in Tailwind.
- **Storage boundary is defensive and cannot blank the rail.** All three modules
  wrap `JSON.parse` in try/catch, check `version === 1` and `Array.isArray`, drop
  non-strings / malformed entries / blanks / duplicates, and cap. `write` swallows
  quota and privacy-mode throws. A `null` storage disables persistence entirely.
  Verified against the corrupt-store tests in each `*.test.ts`.
- **Reorder math is correct**, including the parts that are easy to get wrong: the
  first drag freezes the **unfiltered** group sequence (`allCwds`) so search-hidden
  groups are not demoted; hidden and search-filtered entries keep their rank across
  a neighbour's move; the drop edge shown is computed by the same
  `select*DropEdge` the reducer calls, so the indicator and the semantics cannot
  disagree; `''` ("Unknown workspace") is excluded from ranking, hiding and
  stepping and is pinned last; every no-op returns the same reference so the state
  write is skipped. I hand-traced the filtered-list and hidden-group insertion
  cases and found no off-by-one.
- **No stale closures in the drag/step handlers.** `onDrop` reads `headerDrag` /
  `pinDrag` from the current render, and `setHeaderDrag`/`setPinDrag` re-render on
  every `dragover`, so the closure is always fresh by drop time. All the memo
  dependency arrays are complete: `matchesQuery` closes over `query`, and `query`
  is a dependency of both `pinnedRows` and `groups`.
- **Types.** `app/` strictness is respected. The only `as` casts are the
  `JSON.parse(raw) as Partial<Persisted…>` storage-boundary casts (each followed by
  real runtime narrowing) and two `event.relatedTarget as Node | null` DOM
  narrowings. `SessionActionIcon` carries a real `const exhaustive: never = kind`
  tripwire for `SessionActionKind`.
- **Sidebar/Sessions-page grouping stays shared.** The custom workspace order is
  applied on the sidebar side of `groupByWorkspace` rather than inside it, so the
  Sessions page keeps its frozen-alphabetical grouping; order is keyed on `cwd`,
  never on the label that `disambiguateWorkspaceLabels` rewrites.
- **No new inbound frame, preload channel or host verb.** Pins, order and hidden
  projects are renderer-local view preferences under `catcode.*` localStorage keys;
  New chat and the per-group "+" both route through the existing
  `createSessionInWorkspace(repId)` with a registry id, and Add project uses the
  native picker, so the renderer authors no cwd. The security baseline is untouched
  by this lane.
