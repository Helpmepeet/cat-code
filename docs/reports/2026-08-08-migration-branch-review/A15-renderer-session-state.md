# A15 — renderer session and connection state

## Verdict

These thirteen modules are, mechanically, the best-disciplined code I have read in
this package: not one `Date.now()`, `Math.random()`, module-level mutable, or I/O
call sits inside a reducer or selector — clock inputs are injected at every single
site — and the `as`/`any` count across 3,738 lines is three. The damage is not in
the reducers, it is **between** them. `sessionActionRuntimeState.ts` and
`sessionActionDialogState.ts` were each written against an assumption about the
other, each pinned that assumption in its own test, and neither test crosses the
seam: the reducer refuses to record a lifecycle reset for a session it has never
seen, while the selector's documented contract depends on exactly that record
existing. I proved at runtime that a bulk export whose second session dies returns
`{status:'waiting'}` forever — no file, no toast, no error. Compounding it,
`reduceSessionActionRuntimeState` ignores `kind:'error'` entirely even though main
already copies `requestId` onto the error frame for it, and `permissionState.ts:161`
right next door shows the exact correlation pattern. **Fix the write-verb result
plane first: give `sessionActionRuntimeState` an error branch and make its lifecycle
branch unconditional.** That one change closes the hang, the silent tag failure, and
the eternally-spinning Export dialog together.

## Findings

### [HIGH] A bulk export hangs forever when a leg's session dies before it ever produced a result

- **Where**: `/Users/pt/cat-code/app/renderer/src/sessionActionRuntimeState.ts:51-57`
  and `/Users/pt/cat-code/app/renderer/src/sessionActionDialogState.ts:180-192`
- **Type**: correctness
- **What**: `selectBulkExportOutcome` distinguishes an explicit `null` slot ("its
  engine died, count the leg FAILED") from `undefined` ("nothing yet, keep
  waiting"). Its doc comment at `:164-176` states this as the contract. But the
  reducer that is supposed to write that `null` guards on
  `if (!(frame.sessionId in state.lastBySession)) return state` — so a session that
  has never produced a `session-action.result` gets **no key at all** on death, and
  the selector reads `undefined`, not `null`.
- **Trigger / why it matters**: a bulk export is normally the *first* session-action
  verb a session ever receives, so the guard fires for essentially every leg. Select
  two live rows on the Sessions page → Export. s1 replies; s2's engine dies (crash,
  idle-park, restart) before replying. `lastBySession` is `{s1: <result>}`; s2 has no
  key. `selectBulkExportOutcome` returns `{status:'waiting'}` permanently. No save
  dialog, no toast, no error. The only escape is `App.tsx:1624` discarding the batch
  when the user navigates away from the Sessions page — silently. Verified by running
  the two real modules against these inputs:
  `lastBySession keys: ["s1"] · s2 slot is: undefined · outcome: {"status":"waiting"}`.
  Both sides are pinned by tests that never meet:
  `sessionActionRuntimeState.test.ts:64` asserts "leaves untracked alone";
  `sessionActionDialogState.test.ts:255` asserts the failed-leg path using a
  hand-written `ok:false` frame, never a lifecycle reset.
- **Fix**: drop the `in` guard — write `null` unconditionally on `lifecycle`. The
  guard exists to avoid churning state for unrelated sessions; that is what the
  identity check should do, not a semantics change. (`if (state.lastBySession[frame.sessionId] === null) return state`
  preserves the bailout without breaking the contract.)

### [HIGH] Every rejected or undeliverable session-action verb is invisible: no toast, no failure state, guards strand

- **Where**: `/Users/pt/cat-code/app/renderer/src/sessionActionRuntimeState.ts:36-60`
  (no `kind === 'error'` branch)
- **Type**: correctness
- **What**: the reducer handles only `session-action.result` and `lifecycle`. An
  `ErrorFrame` carrying the verb's own `requestId` is dropped on the floor, even
  though main deliberately copies it there for correlation
  (`app/main/main.ts:1583-1585` and `:1604-1606`,
  `...('requestId' in message && typeof message.requestId === 'string' ? {requestId: message.requestId} : {})`).
  The renderer has exactly one error-correlating reducer, `permissionState.ts:161-169`,
  and this one does not follow it.
- **Trigger / why it matters**: click Rename/Export/Branch/Tag on a row whose engine
  has gone since the last render. `supervisor.send` throws (`supervisor.ts:333-338`),
  main mints `session_disconnected`/`session_not_found` **with** the requestId,
  `reduceConnectionState` records the status, and the write plane learns nothing.
  Three surfaces strand at once:
  1. **Export dialog** — `selectLatchedExportPreview` stays `{status:'pending'}`, so
     the dialog shows its "rendering, one moment" state forever and Copy stays
     disabled (`sessionActionDialogState.ts:97-104`).
  2. **Tag** — `App.tsx:3291` put an entry in `pendingTagWritesRef` that is only
     deleted on a result. No result ⇒ no toast, no echo, and the row silently keeps
     its old tag while the map entry leaks for the window's lifetime.
  3. **Bulk export** — same hang as the finding above, by a second route.
  Note the sidecar's *own* rejections do carry the requestId
  (`sidecarServer.ts:2028-2035`), so the wire is fully correlatable today; only the
  renderer store throws the correlation away.
- **Fix**: add `if (frame.kind === 'error' && frame.requestId)` to the reducer,
  synthesizing `{ok:false, message: frame.message, requestId, verb}` into the
  session's slot — mirroring `permissionState.ts:161`. Every downstream consumer
  already handles `ok:false` correctly.

### [HIGH] Four session-keyed stores structurally cannot be pruned; one of them retains whole export transcripts

- **Where**: `connectionState.ts:211` · `sessionActionRuntimeState.ts:36` ·
  `leaseState.ts:29` · `tasksState.ts:29` (all under
  `/Users/pt/cat-code/app/renderer/src/`)
- **Type**: correctness
- **What**: all four reducers take **only** a `ServerFrame`. `session-removed` is a
  HostEvent on a different channel (`App.tsx:958-975`), which these reducers cannot
  see and cannot be sent. There is therefore no expressible action that removes a
  session key from any of them. `App.tsx`'s `session-removed` handler cleans six
  refs and dispatches `preview-reset`, and touches none of these four.
- **Trigger / why it matters**: `connectionState.sessions`, `leaseState.bySession`
  and `tasksState.bySession` leak small entries (the latter two null their payload on
  `lifecycle`, so only the key survives). `sessionActionRuntimeState.lastBySession`
  is the expensive one: it retains the **entire** `SessionActionResultFrame`,
  including `exportText`, which the sidecar caps at
  `MAX_OUTBOUND_FRAME_BYTES - 64 KiB` = just under 32 MiB
  (`sidecarServer.ts:2081-2085`, `shared/limits.ts:26`). Export a session and keep
  working in it: the full rendered transcript is pinned in renderer heap until that
  session emits a lifecycle frame — i.e. until it dies. Bulk-export ten sessions and
  ten transcripts are pinned. Nothing frees it on dialog close, tab close, or
  `session-removed`. `appModel.ts`'s `PromptDraftState` has the same shape problem:
  `reducePromptDrafts` deletes a key only when the value becomes empty, so a draft
  for a removed session survives the session.
- **Fix**: give each of the four a non-frame action (`{type:'session-removed'; sessionId}`)
  and dispatch it from the existing `session-removed` block in `App.tsx:958`. At
  minimum do it for `sessionActionRuntimeState`, and additionally drop the slot when
  an Export dialog closes — the frame is a one-shot the latch has already copied.

### [MED] `resolveSessionOpenRoute` omits the `cwdExists` gate its own sibling applies, so dead-workspace history rows render openable

- **Where**: `/Users/pt/cat-code/app/renderer/src/sessionsCatalogState.ts:415-430`
- **Type**: correctness
- **What**: the history branch gates on `row.cwd.trim().length > 0` only.
  `openableHistoryId` at `:626-630` — same file, same concept — gates on
  `row.cwd.trim().length === 0 || !row.cwdExists`, and `sidebarState.ts:249` uses the
  same two-part test. `resolveSessionOpenRoute`'s own header calls itself "the one
  place that decision lives (P4-29)", and it is the weaker of the two copies.
- **Trigger / why it matters**: the sidebar hides dead-cwd rows
  (`sidebarState.ts:288` `isSidebarVisibleRow`), but the **Sessions page does not** —
  `SessionsPage.tsx:595-596` re-derives openability as
  `row.appSessionId == null && !row.inRegistry && row.cwd.trim().length > 0`, also
  without `cwdExists`. So a terminal-history row whose workspace was deleted paints
  as a live, hoverable, clickable row; the click reaches
  `openCatalogRow` → `resolveSessionOpenRoute` → `openHistorySession` →
  `host.createSession` → `hostError('invalid_cwd', 'cwd is not an existing directory: <path>')`
  (`host/host.ts:271-276`) → a red shell banner containing a raw filesystem path.
  This is verbatim the failure `cwdExists`'s own field comment says it exists to
  prevent ("rather than failing `invalid_cwd` only at open time",
  `sessionsCatalogState.ts:105-112`), and `selectRecentWorkspaces`'s comment at
  `:622-625` puts the population at "~40 stale transcripts whose temp workspaces are
  long gone" on the operator's machine.
- **Fix**: add `&& row.cwdExists` to the history branch at `:426` and delete the
  inline re-derivation at `SessionsPage.tsx:595-596` in favour of
  `resolveSessionOpenRoute(row).kind !== 'none'` (which `WelcomeScreen.tsx:382`
  already does correctly).

### [MED] Two-store divergence: the write-verb enable gate reads the host plane while deliverability lives in the frame plane

- **Where**: `/Users/pt/cat-code/app/renderer/src/sessionActions.ts:136`
  (`const live = row.live === true`) vs
  `/Users/pt/cat-code/app/renderer/src/connectionState.ts:112`
  (`connectionHasEngine`)
- **Type**: design
- **What**: `MergedSessionRow.live` is computed purely from the **host registry**
  descriptor (`sessionsCatalogState.ts:200`,
  `!descriptor.restorable && descriptor.status !== 'exited'`).
  `ConnectionSnapshot.status` is computed purely from the **frame stream**. These are
  two independent channels out of main with two independent delivery latencies, and
  nothing reconciles them. `connectionHasEngine` was written for precisely the
  question "is there a process a verb could reach" — its doc comment at `:96-111`
  says so — and `resolveSessionActions` never receives a connection snapshot at all
  (`App.tsx:2984-2992` passes only the row plus three transcript booleans).
- **Trigger / why it matters**: a named, bounded window exists by construction.
  `supervisor.reportSocketLoss` clears `record.socket` **synchronously** but defers
  the status event by `disconnectSettleMs = 250` (`supervisor.ts:181, 548-556`).
  Inside that window `supervisor.send` throws `session_disconnected`
  (`supervisor.ts:333-337` + `:579-580`) while the registry row is untouched. So the
  row still reads `live: true`, Rename/Export/Branch render **enabled**, the click
  produces an error frame, and — per the HIGH finding above — the user is told
  nothing. `session_not_found` (main's no-supervisor path, `main.ts:1580-1592`)
  produces the same split with no time bound at all. This is the documented
  two-store failure mode of this app: two stores hold overlapping session state and
  the action gate reads the one that does not know.
- **Fix**: pass the session's `ConnectionSnapshot` into `SessionActionsContext` and
  make the three write verbs require `row.live && connectionHasEngine(status)`. The
  predicate and its exhaustiveness tripwire already exist; only the wiring is
  missing.

### [MED] `selectSeamState` is dead; `MetadataInspector` re-derives its branch in seven places

- **Where**: `/Users/pt/cat-code/app/renderer/src/sessionInspectorState.ts:100-106`
  (and the `SeamState` type at `:98`)
- **Type**: dead-code
- **What**: neither `selectSeamState` nor `SeamState` is imported anywhere in
  production. `MetadataInspector.tsx` imports the two note constants but not the
  selector, and makes the distinction by hand seven times as
  `state.X ? … : <Empty>{INSPECTOR_SEAM_UNREAD_NOTE.Y}</Empty>`
  (`MetadataInspector.tsx:358, 400, 415, 500, 518, 537`, plus the lone `unwired`
  check at `:188`). The module header at `sessionInspectorState.ts:19-22` states
  flatly: "`selectSeamState` is the single place that branch is made, so no section
  re-remembers it." That is false — it is remembered in seven sections and the
  selector is called zero times.
- **Trigger / why it matters**: the cost is the drift the module was written to
  prevent. The `Record<InspectorSeamId, string>` tripwire at `:130` forces an author
  to write a *sentence* for a new seam, but nothing forces them to write the
  *branch*, and the three-value model (`unwired`/`unread`/`read`) is collapsed to two
  in every section — only the top-level guard knows about `unwired`. An eighth
  section is an eighth hand-rolled ternary.
- **Fix**: either route the seven branches through `selectSeamState` (and drop the
  claim from the header if that is not wanted), or delete the selector and its type
  and correct the header. Shipping a centralizing selector that nothing calls while
  the comment asserts it is authoritative is the worst of the three.

### [MED] The merge key flips identity when `ready` lands, silently dropping a selection or an in-progress rename

- **Where**: `/Users/pt/cat-code/app/renderer/src/sessionsCatalogState.ts:185`
  (`const key = descriptor.engineSessionId ?? descriptor.appSessionId`) consumed by
  `/Users/pt/cat-code/app/renderer/src/sessionsPageState.ts:116-152`
- **Type**: correctness
- **What**: `SessionDescriptor.engineSessionId` is `string | null`
  (`shared/hostApi.ts:75`) and for a freshly created session is seeded only when the
  `ready` frame relays it into the registry row (`host/host.ts:173-178`). So
  `MergedSessionRow.sessionId` is the **appSessionId** while a session spawns and the
  **engineSessionId** afterwards. `sessionsPageState` keys `selected`,
  `renaming.sessionId`, `tagPopover.target.sessionId` and `confirmedTags` on that
  value.
- **Trigger / why it matters**: `catalog-settled` fires on every `rows` change
  (`SessionsPage.tsx:153-155`, dep `[rows]`), and prunes any key not present in the
  new row set (`sessionsPageState.ts:134-142`). Start a session, then on the Sessions
  page tick its row or begin an inline rename while it is still spawning. When
  `ready` arrives the row's key changes, `catalog-settled` runs, `byId.has(oldKey)`
  is false, and the tick clears / the rename editor closes with the typed text
  discarded. `SessionId` is a bare `string` with no compile-time support, so nothing
  catches this class.
- **Fix**: key the page state on `appSessionId` for registry rows (stable for a row's
  whole life) and fall back to `sessionId` only for history-only rows; or have
  `catalog-settled` migrate a key whose row now carries a different `sessionId` but
  the same `appSessionId`.

### [MED] The debug snapshot fabricates a permission label the UI never renders — and inverts it for deny suggestions

- **Where**: `/Users/pt/cat-code/app/renderer/src/debugStateReport.ts:87-89`
- **Type**: quality
- **What**: `suggestionLabels` is built as
  `` `Always allow: ${describeSuggestion(suggestion)}` ``. The real permission card
  does not use `describeSuggestion` at all; it uses `describeSuggestionOption`
  (`permissionPromptModel.ts:201-215`), whose leads are
  `"Yes, and don't ask again for "`, `"Yes, and always block "`,
  `"Yes, and always ask for "`, `"Yes, and stop applying "`. After this refactor
  `describeSuggestion` has exactly one production consumer left: this line.
- **Trigger / why it matters**: the debug snapshot is the P3-H harness's view of the
  renderer, used to cross-check GUI verification against what is on screen. A `deny`
  suggestion serializes here as `"Always allow: deny Bash(rm:*) · session"` — a
  string that is both absent from the screen and semantically backwards. Anything
  asserting against this snapshot is asserting against a fiction.
- **Fix**: build the label from `describeSuggestionOption` and join
  `pre + code + post`, so the snapshot carries the string the card actually shows.

### [MED] `selectWritableSelection` has no consumer; `SessionsPage` re-derives the same predicate three times

- **Where**: `/Users/pt/cat-code/app/renderer/src/sessionsPageState.ts:191-201`
- **Type**: dead-code
- **What**: the selector is imported only by `sessionsPageState.test.ts:13`.
  `SessionsPage.tsx` computes `row.live && row.appSessionId != null` inline at
  `:236` (the tag write), `:443` (the bulk bar's `writableCount`) and `:604` (the
  per-row `writable` flag).
- **Trigger / why it matters**: the selector's own doc explains the invariant it
  protects ("a selection that includes closed sessions writes only to the live part
  of it"). Three uncoordinated copies of the predicate mean the bulk bar's promise
  ("Exports 3 of 5") and what the export loop actually dispatches
  (`App.tsx:3308-3310`, a fourth copy) are four independent derivations of one rule.
  They agree today; nothing keeps them agreeing.
- **Fix**: call `selectWritableSelection` from the three SessionsPage sites and from
  `App.tsx`'s `onExportRows`; delete the inline predicates.

### [MED] `messageCount` is dead state on every merged row

- **Where**: `/Users/pt/cat-code/app/renderer/src/sessionsCatalogState.ts:145, 208, 236`
- **Type**: dead-code
- **What**: computed and stored on all 600+ merged rows, read by nothing. The only
  other production mentions are two comments explaining why it *cannot* be used:
  `sessionsCatalogState.ts:372-376` (the "Most active" sort was removed because the
  loader never populates it) and `SessionActionDialogs.tsx:25`
  ("`MergedSessionRow.messageCount` cannot supply it"). The sidecar confirms it is
  never populated (`sidecar/sessionsCatalogDomain.ts:13-17`, "`messageCount` (needs a
  full-chain read) … NOT populated by this loader").
- **Trigger / why it matters**: it is a field that is always `0`, carried across the
  wire, stored per row, and documented twice as unusable — a standing invitation for
  the next author to build a feature on it. The documented instance of state that
  nothing renders.
- **Fix**: drop it from `MergedSessionRow`. Keep it on `SessionCatalogEntry` only if
  a full-chain read is actually planned; otherwise drop it there too.

### [LOW] `reduceLeaseState` and `reduceTasksState` break React bailout and will silently wipe any sibling field

- **Where**: `/Users/pt/cat-code/app/renderer/src/leaseState.ts:43-48` ·
  `/Users/pt/cat-code/app/renderer/src/tasksState.ts:38-42`
- **Type**: correctness
- **What**: two problems in four lines. (a) The `lifecycle` branch is unguarded, so a
  lifecycle frame for a session these stores have never seen still returns a **new**
  state object and a new `bySession` — a guaranteed React re-render for a no-op, and
  a new key mapped to `undefined`. (b) Both return `{ bySession: … }` rather than
  `{ ...state, bySession: … }`, so the day either state type gains a second field it
  is wiped on every snapshot and every lifecycle frame with no type error.
- **Trigger / why it matters**: six sibling domains do this correctly
  (`diagnosticsState.ts:42`, `runControlsState.ts:44`, `contextBreakdownState.ts:45`,
  `remoteSettingsState.ts:44`, `workspaceTrustState.ts:55`,
  `sessionActionRuntimeState.ts:52`); three do not (these two plus
  `orchestratorState.ts:49`). Relatedly, `sessionActionRuntimeState.ts:53`'s comment
  claims its guard "mirrors the other domains" — true of six of the nine, and the
  guard it mirrors is what causes the HIGH finding above.
- **Fix**: `if (!(frame.sessionId in state.bySession)) return state` plus
  `{ ...state, bySession: … }` in both — matching the six-domain majority.

### [LOW] `withResolvedTitle` linear-scans up to 600 catalog entries per tab, in a file that already builds the Map

- **Where**: `/Users/pt/cat-code/app/renderer/src/sessionsCatalogState.ts:317-319`
- **Type**: quality
- **What**: `catalog?.entries.find(candidate => candidate.sessionId === descriptor.engineSessionId)`.
  `selectMergedSessionRows` at `:175-178` builds `byId: Map<string, SessionCatalogEntry>`
  for exactly this lookup, thirty lines earlier in the same module.
- **Trigger / why it matters**: `SESSIONS_CATALOG_ENRICH_LIMIT = 600`
  (`sidecar/sessionsCatalogDomain.ts:54`) and `withResolvedTitle` is called once per
  pane session inside the `tabs` memo (`App.tsx:1052`), whose deps include
  `connection` and `permissions` — so it re-runs on every ready/lifecycle/turn-status
  frame and every permission change. Up to 32 tabs × 600 entries per recompute.
  Bounded, not pathological, but it is a second normalization of a keyed lookup the
  module already owns.
- **Fix**: export the id→entry map (or memoize it on the snapshot) and have
  `withResolvedTitle` take the map.

### [LOW] Naming drift: the same concept has three names for its type, four for its field, and one alias that only exists because the name is taken twice

- **Where**: `leaseState.ts:14, 19` · `tasksState.ts:19` · `connectionState.ts:33` ·
  `sessionActionRuntimeState.ts:25`
- **Type**: convention
- **What**: the per-session store type is `LeaseStateStore` in one file and
  `TasksState` / `ConnectionState` / `SessionsCatalogState` in its siblings. The
  per-session map is `bySession` (lease, tasks), `sessions` (connection), and
  `lastBySession` (session-action). `leaseState.ts:14` must alias the protocol's
  `LeaseState` to `LeaseLifecycle` because the module already spent that name on its
  store. Separately, three modules carry the `…State` suffix while holding no store
  and offering no `create`/`reduce`: `sessionActionDialogState.ts` (pure selectors
  over caller-held data), `sessionInspectorState.ts` (a `build…` bundle, not a
  `create…` store), and `sessionActions.ts` (a pure resolver). The suffix has stopped
  carrying information.
- **Trigger / why it matters**: the recipe (`create<X>State` / `reduce<X>State` /
  `select<X>`) is what tells a reader in three seconds whether a module owns state or
  derives it. Four of thirteen files in this scope follow it exactly
  (`sessionsCatalogState`, `sessionsPageState`, `sessionActionRuntimeState`,
  `tasksState`); `connectionState` and `leaseState` follow it with drift; the rest do
  not participate.
- **Fix**: rename `LeaseStateStore` → `LeaseState` (import the protocol type as
  `LeaseLifecycle` in the reverse direction), standardize on `bySession`, and drop the
  `…State` suffix from the three stateless modules
  (`sessionActionDialogModel.ts`, `sessionInspectorModel.ts`).

### [LOW] `appModel.ts` is a grab-bag that also owns the only IPC call in the scope, and re-implements `contextUsage.ts`'s usage fold

- **Where**: `/Users/pt/cat-code/app/renderer/src/appModel.ts`
- **Type**: design
- **What**: 409 lines covering eight unrelated concerns — OAuth first-run gating
  (`:19-58`), the activity verb (`:105-133`), per-session turn starts (`:155-182`),
  duration/token formatting (`:184-198`), stream-usage token accounting
  (`:200-342`), an IPC wrapper (`:344-356`), prompt drafts (`:358-382`), and the
  debug-export document builder (`:384-409`). It is the only module in this scope
  that calls the bridge (`sendPermissionResponse` → `bridge.respondPermission`). Its
  `isRecord` (`:200`), `foldOutputTokens` (`:217`) and `selectCompletedOutputTokens`
  (`:250-276`) duplicate `contextUsage.ts`'s `isRecord` (`:112`), `foldUsage`
  (`:157-176`, which already folds `output_tokens`) and its `message_start` /
  `message_delta` scan (`:309-311`).
- **Trigger / why it matters**: the duplication is self-declared at `:213-216`
  ("DELIBERATE DUPLICATION, pending … Dedupe both once that settles"), and it is a
  stream-event scanner — the kind of code where two copies drift into two different
  token numbers on the same screen. The module name tells a reader nothing about
  which of the eight concerns lives here.
- **Fix**: split by concern (`turnActivity.ts`, `tokenEstimate.ts`, `promptDrafts.ts`,
  `debugExport.ts`), move `sendPermissionResponse` to the bridge-adjacent layer, and
  take the output-only fold from `contextUsage.foldUsage`. See "Not reviewed" — I
  could not confirm the stated blocker has cleared.

### [LOW] `runStartupTranscriptPreload` swallows two error classes into a bare counter

- **Where**: `/Users/pt/cat-code/app/renderer/src/sessionPreload.ts:193-195, 216-218`
- **Type**: quality
- **What**: `catch { result.failures += 1 }` twice — once around the
  `previewSession` IPC read, once around projection + estimation. Neither the error
  nor the `sessionId` is captured, and the completion log at `:221-223` prints only
  `failures=N`.
- **Trigger / why it matters**: this runs at launch across up to twelve sessions. If
  the preload IPC breaks, or `projectPreviewTranscriptCache` throws on one cache
  shape, the operator's evidence is `[session-preload] complete: loaded=0/12 …
  failures=12` with no session id, no message, and no stack. The module already takes
  an injected `log`, so there is no reason not to use it.
- **Fix**: `catch (error) { result.failures += 1; log(\`[session-preload] ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}\`) }`
  at both sites.

### [LOW] `tasksState`'s narrowing comment contradicts the cast one line below it, and the Set/union pair is hand-maintained

- **Where**: `/Users/pt/cat-code/app/renderer/src/tasksState.ts:133-144`
- **Type**: quality
- **What**: the comment at `:142-143` reads "no `as` cast — every field is copied
  explicitly"; line `:144` is `const type = item.type as TaskAgentSource['type']`.
  The cast is *sound* today (the `TASK_AGENT_TYPES.has` check at `:140` guarantees
  it), but `TASK_AGENT_TYPES` (a `Set<TaskSnapshotItem['type']>`, `:133-137`) and
  `TaskAgentSource['type']` (a three-member literal union,
  `agentIdentity.ts:479`) are two hand-maintained copies of the same list, and only
  the cast keeps them agreeing. Add a fourth agent type to the Set and the cast
  widens silently with no compile error.
- **Fix**: type the Set as `ReadonlySet<TaskAgentSource['type']>` and narrow with a
  typed predicate helper, so the two lists are one list and the cast disappears.

### [LOW] `resolveTagCommit`'s doc describes a three-branch precedence the code does not implement

- **Where**: `/Users/pt/cat-code/app/renderer/src/sessionsPageState.ts:255-269`
- **Type**: quality
- **What**: the comment states "an exact match wins, then create-if-novel, then the
  first remaining match". The code has two branches: exact match, then return the
  normalized query. There is no "first remaining match" path and no test covers one
  (`sessionsPageState.test.ts:210-212` pins only exact-match and trim/empty).
- **Trigger / why it matters**: with tag `backend` present, typing `back` + Enter
  creates a new tag `back`. That happens to match what is rendered (the popover shows
  both the `backend` match and a "Create #back" row), so it is not a live defect —
  but a reader implementing against the comment would change the behaviour believing
  they were fixing a bug.
- **Fix**: delete the third clause from the comment.

## What is good here

- **Time is injected at every single site across all thirteen files.**
  `bucketByDate(rows, nowMs)`, `formatRelativeTime(fromMs, nowMs)`,
  `leaseHeldLabel(createdAtMs, nowMs)`, `reduceTurnStarts(starts, connection, now)`,
  `buildDebugShellStateSnapshot({now})`. Zero `Date.now()` or `Math.random()` inside
  any reducer or selector, zero module-level mutable state, zero I/O. This is why
  these modules are unit-testable at all under an SSR-only harness, and it is worth
  copying verbatim elsewhere in `app/`.
- **`pickTitle`'s two-writer reconciliation** (`sessionsCatalogState.ts:285-304`) is
  a genuinely correct solution to a hard problem: two independent writers (desktop
  registry, engine transcript) that cannot see each other, reconciled by comparing
  `descriptor.titleUpdatedAt` against a `capturedAtMs` that is stamped **before** the
  read (`sessionsCatalogDomain.ts:71-73`) precisely so the inequality is a sound
  lower bound. I checked all four orderings; the rule does not flicker.
- **`connectionState`'s refusal to derive `connectionHasEngine` from
  `isTerminalConnectionStatus`** (`:96-131`), with the reason recorded and both
  switches carrying `never` tripwires. `'parked'` is the member where the two
  questions came apart, and the module makes a future author answer explicitly rather
  than inherit an answer that is accidentally right. Four exhaustive switches in one
  file, all real.
- **`disambiguateWorkspaceLabels`** (`sessionsCatalogState.ts:487-522`) grows labels
  progressively per collision round rather than adding a fixed parent segment, and
  carries an explicit proof of termination in the code (`:508-510` — a cwd already
  showing its full path cannot widen, and its label is unique because the cwd is the
  group key). Applied after the cap in `selectRecentWorkspaces` for a stated reason.
- **`selectExportPreview`'s requestId matching** (`sessionActionDialogState.ts:55-76`)
  and the `LatchedExportPreview` keyed by requestId rather than session. The T5a-analog
  discipline is right; only the error path is missing.

## Not reviewed / uncertain

- I ran no test suite and did not launch the app. Every finding is source-verified;
  the one behavioural claim I could not settle by reading (the bulk-export hang) I
  proved by executing the two real modules against synthetic frames in a scratch
  script outside the repo.
- `contextUsage.ts` is dirty in the working tree (another session's in-flight work),
  so I could not judge whether the blocker `appModel.ts:213-216` cites for its
  deliberate duplication has cleared. The duplication itself is present in both files
  today; whether it is now safe to dedupe is that session's call.
- `SessionsPage.tsx`, `MetadataInspector.tsx` and `App.tsx` belong to other reviewers.
  I read them only far enough to establish consumers and to confirm that a module in
  my scope is the cause; I did not review their own correctness.
- The "~40 dead-cwd history rows" figure in the `resolveSessionOpenRoute` finding is
  the module's own recorded count (`sessionsCatalogState.ts:622-625`), not a fresh
  enumeration — I did not read the operator's real `~/.cat-code` transcript store. The
  defect does not depend on the count, only on the count being non-zero.
- I did not verify the `MAX_LIVE_SESSIONS = 32` bound cited in `App.tsx:3325`'s
  comment against its definition, so the worst-case retained-export figure in the leak
  finding is derived from that comment rather than from source.
