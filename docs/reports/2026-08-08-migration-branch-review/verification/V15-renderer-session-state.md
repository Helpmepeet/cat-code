# A15 adversarial validation: renderer session and connection state

> **Verification provenance:** Claude Opus 5, high effort. Source review of the
> thirteen A15 modules plus their consumers (`App.tsx`, `SessionsPage.tsx`,
> `MetadataInspector.tsx`) and the layers behind them (`app/main/main.ts`,
> `app/supervisor/supervisor.ts`, `app/host/host.ts`, `app/sidecar/sidecarServer.ts`).
> Four standalone scratch scripts importing the REAL repo modules, run under Bun
> outside the repo. One focused test file (`bun test app/renderer/src/sessionActionRuntimeState.test.ts`
> — 4 pass / 0 fail). No GUI, no app launch, no full suite, no repo edits.
> Branch `migration` at `a17e5e9`.

## Overall verdict

The original report is substantially right. Of 17 findings, 14 are CONFIRMED and
3 are PARTIALLY CONFIRMED; none is invalid, stale, or mis-located, and its
`file:line` citations are unusually accurate (I checked roughly 45 of them and
found two off by ≤2 lines and one naming slip). Both HIGH claims about the
session-action write plane reproduce at runtime against the real reducers, and
the second reproduces with the error frame main actually mints. **The thing that
most deserves action is the write-verb result plane, but NOT via the fix the
report proposes:** writing `null` unconditionally on `lifecycle` would make a
second, unreported defect in the same seam worse — I proved that a slot already
holding a stale `null` makes a *new* bulk-export leg settle as FAILED instantly,
while its export is still in flight. Two of the report's other proposed fixes
also do not do what it says: the F5 gate does not close the window F5 names, and
the F3 dispatch point (`session-removed`) almost never fires because an ordinary
close deliberately does not emit it. The praise section's "three `as`/`any`" is
the one count I could not reproduce — the true number is one unsafe assertion,
which is better than claimed.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| F1 | HIGH | Bulk export hangs when a leg dies before its first result | CONFIRMED | Reproduced against the real reducer + selector; `{status:'waiting'}` persists across repeated lifecycle frames |
| F2 | HIGH | Rejected session-action verbs are invisible | CONFIRMED | Reproduced: main mints the error frame WITH `requestId`, every store receives it, the write plane drops it |
| F3 | HIGH | Four session-keyed stores structurally cannot be pruned | CONFIRMED | No key-deletion action is expressible in any of the four; the proposed dispatch point is the wrong one |
| F4 | MED | `resolveSessionOpenRoute` omits the `cwdExists` gate | CONFIRMED | Both copies verified; `cwdExists` is really populated false; Sessions page does not filter |
| F5 | MED | Enable gate reads host plane, deliverability lives in frame plane | PARTIALLY CONFIRMED | Divergence real and unbounded, but the named 250 ms trigger is the one case its own fix does not close |
| F6 | MED | `selectSeamState` is dead; seven hand-rolled branches | CONFIRMED | Zero production callers; six `Empty` branches + the `unwired` guard |
| F7 | MED | Merge key flips identity when `ready` lands | PARTIALLY CONFIRMED | Only a FRESH create has a null `engineSessionId`, and every create path navigates off the Sessions page |
| F8 | MED | Debug snapshot fabricates and inverts a permission label | CONFIRMED | Exact; but `import.meta.env.DEV`-gated with no current mis-asserting consumer, so severity is LOW |
| F9 | MED | `selectWritableSelection` has no consumer | CONFIRMED | Only the test imports it; four independent inline copies verified |
| F10 | MED | `messageCount` is dead state on every merged row | CONFIRMED | Zero renderer reads; two comments say it is unusable |
| F11 | LOW | `reduceLeaseState`/`reduceTasksState` break bailout and drop siblings | CONFIRMED | All nine cited line numbers exact; 6 guarded vs 3 unguarded verified |
| F12 | LOW | `withResolvedTitle` linear-scans up to 600 entries per tab | CONFIRMED | `tabs` memo deps include `connection` and `permissions` (`App.tsx:1078`) |
| F13 | LOW | Naming drift across the store modules | PARTIALLY CONFIRMED | Type/field drift real; `sessionActions.ts` does not carry the `…State` suffix it is accused of |
| F14 | LOW | `appModel.ts` is a grab-bag with the only IPC call | CONFIRMED | Eight concerns, sole `bridge.` call in scope, self-declared duplication present |
| F15 | LOW | `runStartupTranscriptPreload` swallows two error classes | CONFIRMED | Two bare `catch { result.failures += 1 }`; injected `log` unused there |
| F16 | LOW | `tasksState` comment contradicts the cast below it | CONFIRMED | Comment at `:141-143`, cast at `:144`; two hand-maintained lists |
| F17 | LOW | `resolveTagCommit` doc describes a branch that does not exist | CONFIRMED | Comment has three clauses, code has two, test pins two |

## Per finding

### F1 — [HIGH] A bulk export hangs forever when a leg's session dies before it ever produced a result

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, exactly. `sessionActionRuntimeState.ts:51-57` is
  the `lifecycle` branch with `if (!(frame.sessionId in state.lastBySession)) return state`
  at `:52`. `sessionActionDialogState.ts:180-192` is the `selectBulkExportOutcome`
  loop, with the `slot === null` FAILED branch at `:184-187` and the pending →
  `{status:'waiting'}` return at `:189`. The contract doc is at `:145-163`.
- **Reachable in production?**: Yes. No env gate, no feature flag. The store is a
  live `useReducer` at `App.tsx:654-658`, fed by `applyServerFrameBatch`
  (`serverFrameBatch.ts`, dispatched from `App.tsx:864`), and the selector is
  called from a real effect at `App.tsx:1587-1605`. `lifecycle` frames are minted
  by MAIN, not the sidecar (`app/main/mainDecisions.ts:65-87`) from supervisor
  `exit` / `status:'disconnected'|'failed'` events, so a crashed sidecar does not
  need to survive to report its own death — the path is genuinely reachable.
- **Trigger**: Two live rows selected on the Sessions page → Export. `s1` replies
  with `session-action.result`; `s2`'s engine dies (crash, or a transport drop
  settling to `disconnected`) before replying, and `s2` has never received a
  session-action verb before. `lastBySession` is `{s1: <frame>}`, `s2` has no key,
  the selector reads `undefined` not `null`, and the fold returns `waiting`.
- **Counter-arguments considered**:
  1. *Does a dying sidecar actually produce a lifecycle frame the renderer sees?*
     Yes — `mainDecisions.ts:65-87` mints it from supervisor events, independent
     of the sidecar process.
  2. *Is idle-park one of the three causes the report names?* **No.** The sidecar
     increments `inFlightDurableWrites` around every session-action verb
     (`sidecarServer.ts:2072-2073`, decremented at `:2137`) and `isParkGateOpen()`
     refuses to park while it is non-zero (`:1617-1626`). A leg with an export in
     flight cannot idle-park. Crash and transport-disconnect remain valid; the
     report over-listed by one.
  3. *Does anything else settle the batch?* No. A later unrelated result for `s2`
     writes a frame whose `requestId` does not match, which `selectExportPreview`
     reads as pending (`sessionActionDialogState.ts:66-68`), so the batch stays
     `waiting`. I ran five further lifecycle frames for `s2` and the outcome did
     not move.
  4. *Is "forever" literally true?* No, and the report says so itself:
     `App.tsx:1616-1625` clears `pendingBulkExportRef` when `activeView !== 'sessions'`,
     and the comment there documents this exact defect ("A leg whose session dies
     before its very first result leaves no reset to observe, so the batch can
     wait indefinitely"). So it is a *known, deliberately mitigated* hang, not an
     unknown one — which raises the bar for calling it a defect, but does not
     clear it: the mitigation is silent.
- **True consequence**: The export never happens. No file, no save dialog, no
  toast, no error, for as long as the user stays on the Sessions page; leaving
  the page discards the batch silently. The user's only signal is that nothing
  occurred.
- **Evidence**: `/private/tmp/claude-501/-Users-pt-cat-code/cdbe5dee-58e0-41f0-8421-b6cd23d30457/scratchpad/v15/f1-bulk-export-hang.ts`,
  importing the real `sessionActionRuntimeState.ts` and `sessionActionDialogState.ts`:
  ```
  [A] keys after s2 lifecycle: ["s1"]
  [A] s2 slot: undefined
  [A] "s2" in lastBySession: false
  [A] outcome: {"status":"waiting"}
  [A] outcome after 5 more lifecycles: {"status":"waiting"}
  [B] s2 slot: null                      <- control: prior result existed
  [B] outcome: {"status":"settled",...,"failed":1}
  [C] single-leg outcome: {"status":"waiting"}
  ```
  The two tests that pin the seam from opposite sides are as described:
  `sessionActionRuntimeState.test.ts:64` ("a lifecycle frame clears a tracked
  session, leaves untracked alone") and `sessionActionDialogState.test.ts:275`,
  whose comment asserts "An explicit null is the reducer recording a lifecycle
  reset" while hand-writing `{ s2: null }` the reducer would not produce.
- **Disposition**: **Do not apply the report's fix.** Dropping the `in` guard, or
  its softer variant `if (state.lastBySession[frame.sessionId] === null) return state`,
  writes a `null` for every session that ever emits a lifecycle frame into a store
  that F3 shows is never pruned — and, worse, it multiplies the inverse defect I
  found (see "Findings the original report missed"): a stale `null` already makes
  a *new* bulk-export leg settle as FAILED instantly. The correct fix does not
  overload `null` at all. Either (a) have the bulk-export effect consult the
  leg's `ConnectionSnapshot` — the renderer already holds it, and
  `connectionHasEngine` (`connectionState.ts:112`) was written for exactly this
  question — and count a leg failed when its session has no engine and no
  matching result; or (b) clear the leg's slot at dispatch (`App.tsx:3307-3326`)
  so `null` means "died since we asked" rather than "died at some point". Option
  (a) also closes F5 with one mechanism.

### F2 — [HIGH] Every rejected or undeliverable session-action verb is invisible: no toast, no failure state, guards strand

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `sessionActionRuntimeState.ts:36-60` handles
  only `session-action.result` and `lifecycle`; there is no `kind === 'error'`
  branch. `main.ts:1585-1587` (no-supervisor path) and `main.ts:1605-1607`
  (send-throw path) carry the exact spread the report quotes.
  `permissionState.ts:162` is the lone error-correlating reducer.
  `sidecarServer.ts:2028-2035` is the sidecar's own `sendError(connection, requestId, …)`.
- **Reachable in production?**: Yes, and the correlation question the prompt
  raised is **settled in the affirmative for session-action verbs specifically**:
  1. Session-action verbs reach main on their own IPC channel
     (`preload.ts:63,185`) and are forwarded through `forward()` at
     `main.ts:1134` — the same `forward()` that mints both error frames.
  2. `SessionActionVerbMessage` always carries `requestId`
     (`protocol.ts:1806-1816`), so `'requestId' in message && typeof … === 'string'`
     is always true and the field is always copied.
  3. `ErrorFrame.requestId` is optional at the type level (`protocol.ts:609`), but
     it is *set* on this path.
  4. `applyServerFrameBatch` (`serverFrameBatch.ts`) fans **every** frame to
     **every** store, so `reduceSessionActionRuntimeState` really does receive the
     error frame and really does return `state` unchanged.
  Exactly three renderer reducers touch `kind === 'error'`:
  `connectionState.ts:261`, `permissionState.ts:162`, `rawMessageLog.ts:116`. Only
  `permissionState` correlates by `requestId`. **The fix is renderer-only** — no
  main, sidecar, or protocol change is needed.
- **Trigger**: Rename/Export/Branch/Tag on a row whose engine has gone since the
  last render. `supervisor.send` throws at `supervisor.ts:332-334`
  (`sendFailureCodeForStatus`, `:578-581`), main catches at `:1598` and delivers
  the error frame with the verb's `requestId`.
- **Counter-arguments considered**:
  1. *Does `connectionState` already tell the user?* Partly, and the report omits
     this. `connectionState.ts:261-302` maps the error to `dead`/`starting`/`disconnected`,
     so an **active chat tab** does paint the recovery banner
     (`connectionRecoveryMessage`, `:159-185`). Three reasons that does not rescue
     the finding: (a) the verb is normally issued from the Sessions page, where no
     chat pane and therefore no banner is mounted; (b) the banner names a
     connection problem, never the failed verb, and the Export dialog keeps
     spinning regardless; (c) for a **parked** session the error is deliberately
     absorbed (`connectionState.ts:286-292`) so there is literally no signal at
     all — I confirmed this at runtime.
  2. *Does `sendSessionActionVerb` catch anything?* No — `App.tsx:1503-1508` is a
     bare fire-and-forget `getBridge().sessionActionVerb(...)`.
  3. *Does `verbAckResultState` cover it?* No. It handles four other `.result`
     kinds and ignores `error` (`verbAckResultState.ts:56-77`).
- **True consequence**: The Export dialog stays `{status:'pending'}` with Copy
  disabled until dismissed; a Tag write leaks its `pendingTagWritesRef` entry
  (`App.tsx:1557-1559`, deleted only at `:1572` on a result) and the row silently
  keeps its old tag; a bulk export hangs by a second route. For a parked session
  there is no user-visible signal on any surface.
- **Evidence**: `/private/tmp/claude-501/…/scratchpad/v15/f2-error-frame-dropped.ts`
  feeding the exact frame main mints into the three real reducers:
  ```
  sessionActionRuntime unchanged (same ref): true
  sessionActionRuntime keys: []
  latest result for s1: null
  verbAckResult for s1: null
  connection for s1: {"status":"disconnected","inputEnabled":false}
  selectExportPreview: {"status":"pending"}
  selectLatchedExportPreview: {"status":"pending"}
  ```
- **Disposition**: Apply the report's fix, with one correction. Add
  `if (frame.kind === 'error' && frame.requestId)` to
  `reduceSessionActionRuntimeState`, mirroring `permissionState.ts:162`. But do
  **not** synthesize a `verb` field as the report suggests — the error frame does
  not carry one, and inventing it would put a guessed value in the slot that
  `selectExportPreview` discriminates on (`:66`). Store the error under a shape
  the selector can distinguish (e.g. a `verb: null` variant, or a separate
  `errorBySession` map keyed by `requestId`) so a rename error cannot be read as
  an export failure. Needs a boundary-free renderer change plus a unit test that
  the Export dialog reaches `{status:'failed'}`.

### F3 — [HIGH] Four session-keyed stores structurally cannot be pruned; one of them retains whole export transcripts

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, all four exactly. `reduceConnectionState`
  (`connectionState.ts:211-214`) takes a bare `ServerFrame` — no action envelope
  exists, so a removal action is not merely unimplemented, it is
  **inexpressible**. `reduceSessionActionRuntimeState` (`:36-39`),
  `reduceLeaseState` (`leaseState.ts:29-32`) and `reduceTasksState`
  (`tasksState.ts:29`) each take a single-member action union `{type:'frame'; frame}`.
  `App.tsx:958-972` handles `session-removed` and touches none of them.
- **Reachable in production?**: Yes; this is a structural property, not a path.
  `session-removed` is a `HostEvent` on the `subscribeHost` channel
  (`hostApi.ts:224`), which these frame reducers cannot receive.
- **Trigger**: Export a session and keep working in it. The entire
  `SessionActionResultFrame` including `exportText` is stored at
  `sessionActionRuntimeState.ts:43-46` and freed only by a later result for the
  same session or a `lifecycle` frame. The sidecar caps `exportText` at
  `MAX_OUTBOUND_FRAME_BYTES - 64 KiB` (`sidecarServer.ts:2078-2085`), and
  `MAX_OUTBOUND_FRAME_BYTES = 32 * 1024 * 1024` (`shared/limits.ts:26`) — just
  under 32 MiB, as claimed. Ten bulk-exported sessions pin ten transcripts.
- **Counter-arguments considered**:
  1. *Is there an uncalled deletion path I could have missed?* No. I grepped every
     action type reaching these four; only `batch(frameActions)`/`batch(frames)`
     is ever dispatched (`serverFrameBatch.ts`, `App.tsx:844-867`). This is
     genuinely "no expressible action", not "an action that goes uncalled" — the
     two the prompt asked me to separate.
  2. *Does ordinary close free anything?* **No, and this changes the fix, not the
     finding.** V01 is right: `App.tsx:1812-1818` documents that `closeSession`
     emits `session-status(exited, restorable)` and deliberately **not**
     `session-removed`. `emitRemoved` fires at only three host sites
     (`host.ts:453` registry bound-reap during spawn, `:475` fresh-create spawn
     failure, `:537`). So the report's proposed dispatch point fires rarely.
  3. *Is the retained size bounded another way?* Only weakly: any subsequent
     session-action verb for the same session overwrites the slot (latest-only,
     by design), so a rename after an export frees the text. Key count is
     unbounded over a long-lived window.
  4. *`PromptDraftState`*: confirmed at `appModel.ts:368-382` — the key is deleted
     only when the value becomes empty, so a non-empty draft for a removed session
     outlives it.
- **True consequence**: Small per-key leaks in three stores (`connectionState.sessions`,
  `leaseState.bySession`, `tasksState.bySession`), unbounded in key count over a
  window's life; up to ~32 MiB per pinned export in `sessionActionRuntimeState.lastBySession`.
  Not a crash; a real renderer-heap cost on an always-on app.
- **Evidence**: reducer signatures above; `App.tsx:958-972`; `App.tsx:1812-1818`;
  `host.ts:453,475,537,884`.
- **Disposition**: Do the narrow thing, not the report's broad thing. (1) In the
  Export dialog's close handler and after `saveTranscript` completes, clear the
  session's slot — the latch (`sessionActionDialogState.ts:79-104`) has already
  copied the text, so the frame is spent. That alone removes the only expensive
  retention. (2) Only if a leak of *keys* is measured to matter, add a
  `{type:'session-removed'}` action — but wire it to a trigger that actually
  fires, which given (2) above means the shell's own tab/roster teardown, not the
  rare host `session-removed`. Adding an action dispatched from `App.tsx:958`
  alone would look like a fix and free almost nothing.

### F4 — [MED] `resolveSessionOpenRoute` omits the `cwdExists` gate its own sibling applies

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, precisely. `sessionsCatalogState.ts:415-430` is
  `resolveSessionOpenRoute`; the history branch is `if (!row.inRegistry && row.cwd.trim().length > 0)`
  at `:426`. `openableHistoryId` at `:626-630` reads
  `if (row.cwd.trim().length === 0 || !row.cwdExists) return null`.
  `sidebarState.ts:249` has the two-part test; `:288` is `isSidebarVisibleRow`.
  `SessionsPage.tsx:595-596` re-derives without `cwdExists`. `host.ts:275` is the
  `cwd is not an existing directory: ${req.cwd}` message. The field comment is at
  `sessionsCatalogState.ts:105-112` and the "~40 stale transcripts" note at `:622-625`.
- **Reachable in production?**: Yes. `cwdExists` is genuinely computed false —
  `sessionsCatalogDomain.ts:122` stamps `cwdExists: existing.has(entry.cwd)` from a
  real stat pass; `sessionsCatalogBaseline.ts:91-92` round-trips a `false` and
  defaults only a legacy absent field to `true`. The Sessions page applies no
  `cwdExists` filter anywhere (grep: the only three renderer uses are
  `sidebarState.ts:249,288` and `sessionsCatalogState.ts:628`).
- **Trigger**: A terminal-history row whose workspace has been deleted. It paints
  openable on the Sessions page, the click goes `openCatalogRow` (`App.tsx:2017-2022`)
  → `resolveSessionOpenRoute` → `openHistorySession` (`App.tsx:1979-1998`) →
  `host.createSession` → `hostError('invalid_cwd', …)` → `setShellError` at
  `App.tsx:1985`, i.e. a shell banner carrying the raw path.
- **Counter-arguments considered**: The Welcome launcher is genuinely safe, but
  not for the reason implied. `WelcomeScreen.tsx:382` calls `resolveRecentOpenRoute`,
  which at `sessionsCatalogState.ts:723-737` passes `recent.historySessionId` —
  and that id was already filtered through `openableHistoryId` at `:677/:697`. So
  the protection is upstream, not in `resolveSessionOpenRoute`. That makes the
  report's "the one place that decision lives" critique sharper, not weaker: two
  of three callers are safe only by accident of what they feed it.
- **True consequence**: A dead-workspace history row on the Sessions page renders
  as a live clickable row; the click produces a red banner with a filesystem path
  — verbatim the failure `cwdExists` was added to prevent.
- **Evidence**: line citations above; `sessionsCatalogDomain.ts:122`;
  `sessionsCatalogBaseline.ts:91-92`.
- **Disposition**: Apply, with one mechanical correction the report missed:
  `resolveSessionOpenRoute`'s parameter is `Pick<MergedSessionRow, 'appSessionId' | 'live' | 'cwd' | 'sessionId' | 'inRegistry'>`
  (`:416-419`) — `cwdExists` is not in it, so the Pick must be widened and
  `resolveRecentOpenRoute` (`:727`) updated to supply it. Registry rows are
  hard-coded `cwdExists: true` (`:197`), so the added clause cannot regress them.
  Replacing `SessionsPage.tsx:595-596` with `resolveSessionOpenRoute(row).kind !== 'none'`
  is right.

### F5 — [MED] Two-store divergence: the write-verb enable gate reads the host plane while deliverability lives in the frame plane

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Yes. `sessionActions.ts:136` is `const live = row.live === true`;
  `connectionState.ts:112` is `connectionHasEngine` with its doc at `:95-111`;
  `sessionsCatalogState.ts:200` is `live: !descriptor.restorable && descriptor.status !== 'exited'`;
  `supervisor.ts:181` is `disconnectSettleMs ?? 250`, `:547-560` is
  `reportSocketLoss`, `:332-334` the send throw, `:578-581` `sendFailureCodeForStatus`.
  `App.tsx:2984-2992` passes no connection snapshot into `SessionActionsContext`.
- **Reachable in production?**: Yes, but **not in the window the report names**.
- **Trigger**: I split it into three and ran all three against the real
  `selectMergedSessionRows` + `resolveSessionActions` + `connectionHasEngine`:
  - **Window A (the report's trigger, 0–250 ms after socket loss).** `record.socket`
    is cleared synchronously and the status event is deferred, so the registry row
    is untouched **and `connectionState` still reads `'ready'`**. The two stores
    AGREE; both are stale. `connectionHasEngine('ready')` is `true`, so the
    report's own proposed gate `row.live && connectionHasEngine(status)` still
    renders the verbs **enabled** and the click still errors. **The named trigger
    is precisely the case its fix does not close.**
  - **Window B (after the settle, child still alive).** `isTerminalStatus` is
    `exited|failed` only (`host.ts:911-913`), so a `disconnected` supervisor
    status projects `descriptorFromRow(row, 'disconnected')` → `status:'disconnected'`,
    and `isRestorable` forces `false` while `liveStatus != null`. Therefore
    `row.live === true` while `connectionState` reads `'disconnected'`. This is a
    genuine divergence with **no time bound at all** — the report understates it.
    Here the proposed gate does fire.
  - **Window C (parked).** A parked row is `restorable`, so `row.live === false`
    and the verbs are already disabled. Not a divergence; but the error frame from
    a stray verb is absorbed (`connectionState.ts:286-292`), which is why F2's
    "no signal" is total for this case.
- **Counter-arguments considered**: I looked for a reconciler between the planes
  and found none; for a guard in `SessionActionsMenu` (none — the enable bit comes
  straight from `resolveSessionActions`); and for a main-side pre-check before
  `forward()` (none — `main.ts:1134` forwards unconditionally). I also checked
  whether `session_not_found` behaves as claimed: `main.ts:1580-1594` mints it
  when `supervisor` is absent, which is a process-lifetime condition, not a
  per-session one.
- **True consequence**: Rename/Export/Branch render enabled on a session that
  cannot receive them, in two distinct situations: a 250 ms window where both
  stores are stale, and an unbounded state where only the host plane is stale.
  Combined with F2, the click produces nothing visible.
- **Evidence**: `/private/tmp/claude-501/…/scratchpad/v15/f5-two-store-divergence.ts`:
  ```
  [A settle window] row/verbs: {"live":true,"rename":true,"branch":true,"export":true}
  [A]  connection: {"status":"ready"}  hasEngine: true
  [A]  proposed gate (row.live && connectionHasEngine): true      <- fix does NOT fire
  [B after settle]  row/verbs: {"live":true,"rename":true,"branch":true,"export":true}
  [B]  connection: {"status":"disconnected"}  hasEngine: false
  [B]  proposed gate: false                                       <- fix fires
  [C parked] connection after PARKED_EXIT_CODE lifecycle: {"status":"parked"}
  [C]  connection after the verb error frame: {"status":"parked"} (absorbed)
  ```
- **Disposition**: Wire the snapshot in as the report says — it closes Window B,
  which is the worse one — but **do not describe it as closing the settle
  window**, and do not stop there. No renderer-side predicate can close Window A,
  because during it both planes believe the session is live; only F2's error
  branch can tell the user what happened after the fact. Ship F2's fix first and
  treat F5's gate as the complement, not the cure.

### F6 — [MED] `selectSeamState` is dead; `MetadataInspector` re-derives its branch in seven places

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `sessionInspectorState.ts:98` is the `SeamState`
  type, `:100-106` the selector, and the header claim is at `:19-22` ("`selectSeamState`
  is the single place that branch is made, so no section re-remembers it").
- **Reachable in production?**: The selector is **not** reachable — that is the
  finding. A repo-wide grep for `selectSeamState` returns the definition, two
  comments (`MetadataInspector.tsx:27,94`), and `sessionInspectorState.test.ts`
  (import at `:14`, six assertions at `:72-112`). Zero production call sites.
- **Trigger**: `MetadataInspector.tsx` makes the two-value distinction by hand at
  `:358, 400, 415, 500, 518, 537` (six `INSPECTOR_SEAM_UNREAD_NOTE` branches),
  plus the lone `sessionState === undefined` `unwired` guard at `:188` — seven, as
  claimed. The three-value model collapses to two in every section.
- **Counter-arguments considered**: Whether the `Record<InspectorSeamId, string>`
  tripwire at `:130-141` already forces the branch — it does not; it forces only
  the *sentence*. Whether some other module consumes `SeamState` as a type — no
  importer exists.
- **True consequence**: A module header asserts a centralization that does not
  exist, and an eighth section is an eighth hand-rolled ternary. No user-visible
  defect today.
- **Evidence**: grep results above.
- **Disposition**: Prefer deleting `selectSeamState` + `SeamState` and correcting
  the header sentence. Routing the six `Empty` branches through it would need a
  `pick` callback per section for a two-way branch each site already expresses in
  one ternary — more ceremony than the drift it prevents. The header is the actual
  bug; fix that either way.

### F7 — [MED] The merge key flips identity when `ready` lands, silently dropping a selection or an in-progress rename

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Yes. `sessionsCatalogState.ts:185` is
  `const key = descriptor.engineSessionId ?? descriptor.appSessionId`;
  `hostApi.ts:75` types `engineSessionId: string | null`; `host.ts:170-178` fills
  it from the ready frame and re-emits status; `sessionsPageState.ts:116-152` is
  the `catalog-settled` prune (`byId.has` at `:134-142`); `SessionsPage.tsx:153-155`
  dispatches it with dep `[rows]`.
- **Reachable in production?**: Yes, but through a much narrower door than the
  report describes.
- **Trigger — as narrowed**: Only a **fresh create** leaves `engineSessionId` null
  during the spawn window. Restore (`host.ts:368`), restart (`host.ts:634`) and
  open-from-history all pass `resumeEngineSessionId`, which `spawn()` seeds into
  the row at `host.ts:446-450` for this exact reason (the comment there names the
  "jump then settle" symptom). And every fresh-create entry point navigates away:
  `newSession` sets `activeView='chat'` at `App.tsx:1238`, `newSessionInWorkspace`
  at `:1257`. `SessionsPage` holds `page` in a component-local `useReducer`
  (`SessionsPage.tsx:141`) and is conditionally rendered, so that state is
  destroyed on navigation regardless. The user must therefore create a session,
  navigate *back* to the Sessions page, and tick/rename inside the remaining spawn
  window.
- **Counter-arguments considered**: Whether restore also flips the key (it does
  not — seeded at spawn); whether `page` state survives navigation (it does not);
  whether `confirmedTags` is affected too (it is — `onTagRows` records
  `row.sessionId` at `App.tsx:3292`, so a tag echo landing after the flip misses
  `selectRowTag`'s lookup at `sessionsPageState.ts:167`).
- **True consequence**: In a narrow, self-inflicted window a tick clears or a
  rename editor closes with typed text discarded. Real, latent, and unguarded by
  types (`SessionId` is a bare `string`) — but not the routine occurrence the
  report's phrasing suggests.
- **Evidence**: `host.ts:368,446-450,634`; `App.tsx:1238,1257`;
  `SessionsPage.tsx:141,153-155`; `sessionsPageState.ts:134-142`.
- **Disposition**: Take the report's second option, not its first. Having
  `catalog-settled` migrate a key whose row now carries a different `sessionId`
  but the same `appSessionId` is a local, testable change. Re-keying page state on
  `appSessionId` "for registry rows and `sessionId` for history rows" introduces a
  two-space key into a reducer that currently has one, which is how this class of
  bug is created rather than fixed.

### F8 — [MED] The debug snapshot fabricates a permission label the UI never renders — and inverts it for deny suggestions

- **Verdict**: CONFIRMED (severity should be LOW)
- **Cited location holds?**: Yes. `debugStateReport.ts:87-89` is
  ``suggestion => `Always allow: ${describeSuggestion(suggestion)}` ``.
  `describeSuggestion` is at `permissionPromptModel.ts:154-173`;
  `describeSuggestionOption` at `:201-230` with `BEHAVIOR_LEAD` at `:181-189`
  carrying exactly the four leads quoted. The card consumes the latter at `:290`.
  `describeSuggestion` has exactly one production consumer: `debugStateReport.ts:88`.
- **Reachable in production?**: **No — and this is the one gate the report did not
  disclose.** `buildDebugShellStateSnapshot` is called only from `App.tsx:1285-1300`,
  whose first line is `if (!import.meta.env.DEV) return`. It is a dev-only
  diagnostic. That does not invalidate the finding (the P3-H harness runs in dev,
  which is the stated use), but it does bound the blast radius to zero users.
- **Trigger**: Any `deny`/`ask`/`removeRules`/`setMode`/`addDirectories`
  suggestion serializes with an "Always allow: " lead. A `deny` reads
  `"Always allow: deny Bash(rm:*) · session"` — absent from the screen and
  semantically backwards, exactly as claimed.
- **Counter-arguments considered**: Whether anything currently asserts against the
  field. The wire name is `n` (`shared/debugState.ts`); `main/devHarness.ts`
  only shape-validates it (bounded string array), and the sole assertion is
  `debugStateReport.test.ts`, which pins an **allow** case
  (`'Always allow: allow Bash(date) · User settings'`) where the label happens to
  be right. So "anything asserting against this snapshot is asserting against a
  fiction" is true in principle and vacuous in practice today.
- **True consequence**: A dev-only debug field is wrong for five of six update
  types. No user impact, no current mis-assertion.
- **Evidence**: `App.tsx:1286`; `permissionPromptModel.ts:154,201,290`;
  `debugStateReport.test.ts`.
- **Disposition**: Apply the report's fix (build the label from
  `describeSuggestionOption` and join `pre + code + post`) — it is three lines and
  makes the snapshot match the screen. Reclassify as LOW; it is not MED work.

### F9 — [MED] `selectWritableSelection` has no consumer; `SessionsPage` re-derives the same predicate three times

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `sessionsPageState.ts:191-201` is the selector;
  its only importer is `sessionsPageState.test.ts:13`. The inline copies are at
  `SessionsPage.tsx:236`, `:443`, `:604` (all `row.live && row.appSessionId != null`)
  and `App.tsx:3309` (`if (!row.live || row.appSessionId == null) continue`) — four
  independent derivations, as claimed.
- **Reachable in production?**: The selector is not; the four copies are.
- **Trigger**: None today — I checked all four for equivalence and they agree.
  The finding is drift risk, correctly typed `dead-code`.
- **Counter-arguments considered**: Whether the copies differ subtly (they do not);
  whether the selector is re-exported anywhere (it is not).
- **True consequence**: The bulk bar's "Exports N of M" promise and what the
  export loop dispatches are four derivations of one rule with nothing keeping
  them aligned.
- **Disposition**: The report's fix is **not a drop-in**. `selectWritableSelection`
  returns `SessionId[]` (the `appSessionId`s), but `SessionsPage.tsx:236` needs
  the writable **rows** to pass to `onTagRows`, and `App.tsx:3308-3315` needs rows
  to read `row.title`. Either add a sibling `selectWritableRows` returning rows and
  define the id selector in terms of it, or change the existing selector's return
  type and update its one test. Do that first, then delete the four copies.

### F10 — [MED] `messageCount` is dead state on every merged row

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `sessionsCatalogState.ts:145` (field), `:208`
  and `:236` (the two writes). Zero renderer reads outside the type. The two
  comments explaining why it cannot be used are at `:372-376` (the removed "Most
  active" sort) and `SessionActionDialogs.tsx:25`.
- **Reachable in production?**: The field is carried and stored; nothing reads it.
- **Trigger**: n/a — dead state.
- **Counter-arguments considered**: One correction to the report. It is not
  unconditionally zero *by construction*: `sessionsCatalogDomain.ts:203` maps
  `messageCount: log.messageCount ?? 0`, so it is 0 only because the bounded
  enrich path does not populate it — as the domain header at `:14-17` states. If a
  full-chain read is ever added the field would carry real values. That makes the
  report's "always 0" accurate today and its "drop it from `SessionCatalogEntry`
  too" the more debatable half.
- **True consequence**: A per-row field on up to 600 rows that reads 0 and is
  documented twice as unusable.
- **Disposition**: Drop it from `MergedSessionRow` (`:145,208,236`) — that is the
  dead half and the change is contained. Keep it on `SessionCatalogEntry` and on
  the wire: it is validated in three places (`sessionsCatalogBaseline.ts:103,123`,
  `sessionsCatalogWorker.ts:136,158`) and removing a protocol field is a
  versioning question, not a cleanup. Severity is LOW, not MED.

### F11 — [LOW] `reduceLeaseState` and `reduceTasksState` break React bailout and will silently wipe any sibling field

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, and every one of the nine comparison line
  numbers is exact. Unguarded + no spread: `leaseState.ts:43-47`,
  `tasksState.ts:38-42`, `orchestratorState.ts:49-53`. Guarded + spread:
  `diagnosticsState.ts:42`, `runControlsState.ts:44`, `contextBreakdownState.ts:45`,
  `remoteSettingsState.ts:44`, `workspaceTrustState.ts:55`,
  `sessionActionRuntimeState.ts:52`. (The report missed a seventh correct sibling,
  `verbAckResultState.ts:71` — not a defect in the finding.)
- **Reachable in production?**: Yes. A `lifecycle` frame for any session reaches
  every store via `applyServerFrameBatch`, so an unrelated session's death returns
  a new state object from both, forcing a re-render for a no-op.
- **Trigger**: Any lifecycle frame for a session with no lease/tasks snapshot.
- **Counter-arguments considered**: Whether the (b) half is a live bug — it is
  not: both state types currently have exactly one field, so nothing is wiped
  today. Correctly filed as latent. Also whether the snapshot branches have the
  same missing spread — they do (`leaseState.ts:36-38`, `tasksState.ts:33-35`),
  so the report's "every snapshot and every lifecycle frame" is right.
  `contextBreakdownState.ts` is dirty in the working tree; the guard is present on
  disk as cited.
- **True consequence**: A guaranteed no-op re-render per unrelated lifecycle
  frame, plus a latent sibling-field wipe with no type error.
- **Disposition**: Apply as written, to all **three** (include `orchestratorState.ts:49`,
  which the report names but leaves out of its fix line).

### F12 — [LOW] `withResolvedTitle` linear-scans up to 600 catalog entries per tab

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `sessionsCatalogState.ts:317-319` is
  `catalog?.entries.find(candidate => candidate.sessionId === descriptor.engineSessionId)`;
  the `byId` Map is built at `:175-178` for the same lookup thirty lines earlier.
- **Reachable in production?**: Yes. `withResolvedTitle` is called at
  `App.tsx:1052` inside the `tabs` memo, whose dependency array at `App.tsx:1078`
  is `[shell, connection, permissions, activeSessionId, sessionCatalogSnapshot]` —
  so it re-runs on every ready/lifecycle/turn-status frame and every permission
  change, exactly as claimed. `SESSIONS_CATALOG_ENRICH_LIMIT = 600`
  (`sessionsCatalogDomain.ts:54`) and `MAX_LIVE_SESSIONS = 32`
  (`hostApi.ts:245` — this also settles the report's own stated uncertainty about
  that figure; the `App.tsx:3325` comment is correct).
- **Trigger**: Any frame-driven re-render with many tabs and a large catalog.
- **Counter-arguments considered**: `.find` short-circuits on a hit, and
  `withResolvedTitle` early-returns for a descriptor with no `engineSessionId`
  (`:315`), so the practical average is well under 32×600. The report already
  called it "bounded, not pathological".
- **True consequence**: Redundant O(tabs×entries) work per frame. No user-visible
  defect measured.
- **Disposition**: Apply, but keep it cheap: memoize the id→entry Map on the
  snapshot in `App.tsx` and pass it in. Do not restructure `selectMergedSessionRows`
  to export its internal map — that couples two selectors for a LOW-severity win.

### F13 — [LOW] Naming drift across the store modules

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Mostly. `LeaseStateStore` is at `leaseState.ts:19`
  (the report's `:14` is the `LeaseState as LeaseLifecycle` import alias, which is
  the other half of the same claim, so both citations are meaningful).
  `TasksState` at `tasksState.ts:19`, `ConnectionState` at `connectionState.ts:33`,
  `lastBySession` at `sessionActionRuntimeState.ts:27`. `sessionInspectorState.ts`
  exports `buildSessionInspectorState` (`:71`), not `create…`; `sessionActionDialogState.ts`
  has no `create`/`reduce` at all.
- **What does not survive**: "three modules carry the `…State` suffix while
  holding no store … `sessionActionDialogState.ts`, `sessionInspectorState.ts`,
  and `sessionActions.ts`". `sessionActions.ts` **does not carry the `…State`
  suffix** — it is the counter-example to the complaint, not an instance of it.
  Two modules, not three.
- **Reachable in production?**: n/a (convention).
- **Counter-arguments considered**: Whether the four "follows it exactly" files
  really do — `sessionsCatalogState`, `sessionsPageState`, `tasksState` yes;
  `sessionActionRuntimeState` has `create`/`reduce`/`select` but its map is
  `lastBySession`, which is the drift the same finding complains about, so it
  cannot be counted as exact.
- **True consequence**: A reader cannot tell from the filename whether a module
  owns state. No functional cost.
- **Disposition**: The `LeaseStateStore` → `LeaseState` rename and the `bySession`
  standardization are cheap and worth doing when those files are next touched. Do
  **not** rename `sessionActionDialogState.ts` / `sessionInspectorState.ts` as a
  standalone change: a file rename across a package with import-extension
  conventions costs more churn than the clarity buys, and the report's own list
  of what to rename is partly wrong.

### F14 — [LOW] `appModel.ts` is a grab-bag that also owns the only IPC call in the scope

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, with a 2-line drift. The file is 409 lines. The
  eight concerns are at `:19-58`, `:105-133`, `:155-182`, `:184-198`, `:200-342`,
  `:344-356`, `:358-382`, `:384-409` — the report's ranges. The self-declared
  duplication note is at `:211-215` (report said `:213-216`). `isRecord` at `:200`,
  `foldOutputTokens` at `:217`, `selectCompletedOutputTokens` at `:250-276`;
  `contextUsage.ts`'s counterparts at `:112` (`isRecord`) and `:157-176`
  (`foldUsage`, which does fold `output_tokens` at `:173-176`).
- **Reachable in production?**: Yes. I confirmed by grep that
  `appModel.ts:351` (`bridge.respondPermission`) is the **only** `bridge.` call
  across all thirteen scope modules.
- **Trigger**: n/a (design).
- **Counter-arguments considered**: Whether the duplication is actually unsafe —
  it is deliberate and documented, and the two folds answer different questions
  (output-only vs four-bucket). `contextUsage.ts` is dirty in the working tree, so
  the stated blocker's status remains that session's call, exactly as the report
  said in its own uncertainty section.
- **True consequence**: Two stream-event token scanners that can drift into two
  different numbers on one screen; a module name that describes none of its eight
  concerns.
- **Disposition**: Do the low-risk half only: move `sendPermissionResponse` to the
  bridge-adjacent layer and leave the fold dedupe until `contextUsage.ts` settles.
  A four-way file split is a refactor with no failing behaviour behind it and
  should not ride a review finding.

### F15 — [LOW] `runStartupTranscriptPreload` swallows two error classes into a bare counter

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, exactly. `sessionPreload.ts:192-195` is
  `catch { result.failures += 1; continue }` around `options.previewSession`;
  `:216-218` is `catch { result.failures += 1 }` around
  `projectPreviewTranscriptCache` + `estimateProjectedPreviewBytes` +
  `options.onLoad`. The completion log at `:221-223` prints only `failures=N`.
- **Reachable in production?**: Yes, at launch. `log` is already injected
  (`:153`, defaulting to `console.info`) so the fix has no new dependency.
- **Trigger**: Any preload IPC failure or any cache shape the projector throws on.
- **Counter-arguments considered**: Whether the second catch also swallows an
  `onLoad` failure — it does, which means a renderer-state failure is counted as a
  preload failure. That slightly strengthens the finding.
- **True consequence**: `loaded=0/12 … failures=12` with no session id, no
  message, no stack.
- **Disposition**: Apply as written at both sites. Add the `sessionId` and, for
  the second site, distinguish projection failure from `onLoad` failure so the
  count does not conflate two subsystems.

### F16 — [LOW] `tasksState`'s narrowing comment contradicts the cast one line below it

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. The comment at `tasksState.ts:141-143` ends
  "(no `as` cast — every field is copied explicitly from the snapshot item)" and
  `:144` is `const type = item.type as TaskAgentSource['type']`.
  `TASK_AGENT_TYPES` is `new Set<TaskSnapshotItem['type']>([...])` at `:133-137`;
  `TaskAgentSource['type']` is the three-member union at `agentIdentity.ts:479`.
- **Reachable in production?**: Yes; the cast is sound today because of the
  `TASK_AGENT_TYPES.has` check at `:140`.
- **Trigger**: Adding a fourth member to `TASK_AGENT_TYPES` without adding it to
  `TaskAgentSource['type']`. The `as` is a down-cast from the wider
  `TaskSnapshotItem['type']`, so TS raises nothing and `toTaskAgentSource` returns
  a value whose `type` lies about its own union.
- **Counter-arguments considered**: Whether the comment can be read charitably as
  describing the object literal rather than the `type` const — it can, but the
  parenthetical states "no `as` cast" one line above an `as` cast, which is
  exactly the drift the finding names.
- **True consequence**: No live defect; a comment that misleads and a two-list
  invariant held only by a cast.
- **Disposition**: Apply. Type the Set as `ReadonlySet<TaskAgentSource['type']>`
  and narrow through a typed predicate; the comment then becomes true instead of
  needing rewording.

### F17 — [LOW] `resolveTagCommit`'s doc describes a three-branch precedence the code does not implement

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. The comment at `sessionsPageState.ts:255-258`
  says "an exact match wins, then create-if-novel, then the first remaining
  match"; the body at `:260-269` has two branches (exact match, else the
  normalized query). `sessionsPageState.test.ts:209-213` pins exact-match,
  trim-and-create, and empty — no third path.
- **Reachable in production?**: The described third branch does not exist, so it
  cannot be reached. The finding is about the comment.
- **Trigger**: With tag `backend` present, typing `back` + Enter creates `back` —
  which matches what the popover renders (`selectCanCreateTag` /
  `selectMatchingTags` both exist and the popover shows both rows), so it is not a
  live defect. The report says so.
- **Counter-arguments considered**: Whether "first remaining match" is implemented
  by a caller — no; `resolveTagCommit` is the whole decision.
- **True consequence**: A reader implementing to the comment would "fix" working
  behaviour.
- **Disposition**: Apply — delete the third clause. Trivial and correct.

## Findings the original report missed

### [HIGH] The same seam settles a bulk-export leg PREMATURELY when its slot holds a stale `null`

This is the exact inverse of F1, in the same two functions, and it matters most
because **it is the reason F1's proposed fix must not be applied**.

`selectBulkExportOutcome` treats `slot === null` as "this leg's engine died, count
it FAILED" (`sessionActionDialogState.ts:184-187`). But `null` carries no
timestamp and no request identity, and nothing clears it when the session comes
back: `reduceSessionActionRuntimeState` ignores `ready` frames entirely
(`:36-60`), so a `null` written by an old death survives a restore indefinitely.
A **new** bulk export over that session therefore settles instantly, drops the
leg, writes the file without it, and reports "the rest could not be read" — while
that session's export is still in flight and its result is about to arrive (and
will then sit unread in `lastBySession`, since `pendingBulkExportRef` was already
cleared at `App.tsx:1595`).

Reproduced with the real modules
(`/private/tmp/claude-501/…/scratchpad/v15/f18-stale-null-leg.ts`):

```
s2 slot after restore + ready: null
outcome while s2 export is STILL IN FLIGHT: {"status":"settled","sections":[{"title":"One","text":"ONE"}],"failed":1}
-> the file is written now, s2 silently reported as unreadable: true
```

Consequence: a user-visible **wrong file** plus a misleading count, which is
worse than F1's do-nothing hang. And F1's proposed remedy — writing `null` for
every session on every lifecycle frame — converts this from "a session that
previously exported and died" to "**any** session that has ever emitted a
lifecycle frame", i.e. nearly all of them after a while, in a store F3 shows is
never pruned. Both defects share one root cause: `null` is being used as a
tri-state sentinel it cannot support. Fix them together with the
`ConnectionSnapshot`-based approach in F1's disposition.

### Corrections to the report's "What is good here"

A clean bill is as falsifiable as a defect, so I recounted mechanically across
the thirteen modules (file list in
`/private/tmp/claude-501/…/scratchpad/v15/files.txt`):

- **"Zero `Date.now()` or `Math.random()` inside any reducer or selector" — TRUE.**
  Exactly one hit repo-wide in scope: `debugStateReport.ts:26`, `const now = args.now ?? Date.now`,
  in a builder, not a reducer or selector. Zero `Math.random`, zero `performance.now`.
- **"Time is injected at every single site" — OVERSTATED.** It is *injectable* at
  every site. `buildDebugShellStateSnapshot`'s sole production caller
  (`App.tsx:1291-1296`) does **not** pass `now`, so that one path takes the
  module's `Date.now` default.
- **"The `as`/`any` count across 3,738 lines is three" — WRONG, in the code's
  favour.** There is exactly **one** unsafe type assertion (`tasksState.ts:144`,
  the F16 cast). The other four `as` tokens are `as const` literal assertions,
  which are type-safe: `sessionActions.ts:122`, `sessionsCatalogState.ts:768`,
  `debugStateReport.ts:63` (×2). `leaseState.ts:14` is an import alias, not a
  cast. There are **zero** `any` types — every `any` hit is the English word in a
  comment.
- **"Zero module-level mutable state" — TRUE.** No top-level `let` or `var` in any
  of the thirteen.
- **"Zero I/O" in reducers/selectors — TRUE.** The only two I/O-adjacent calls in
  scope are `appModel.ts:351` (`bridge.respondPermission`) and
  `sessionPreload.ts:153` (the injected `log`'s `console.info` default); neither
  is a reducer or selector.
- **"Four exhaustive switches in one file [`connectionState`], all real" — THREE.**
  `isTerminalConnectionStatus` (`:73`), `connectionHasEngine` (`:115`),
  `connectionRecoveryMessage` (`:162`), each with a `never` tripwire.
  `connectionTone` (`:145-149`) derives from the first rather than switching —
  which is the better design the report praises, but it is not a fourth switch.
- **Line total**: the twelve files I could positively identify sum to 3,615
  (`wc -l`); adding `verbAckResultState.ts` gives 3,718. I could not identify a
  thirteenth file reaching 3,738, so the figure is approximate.

### Working-tree state

All files are under `app/`, so all are branch-new relative to `main`. **None of
the thirteen A15 modules is dirty.** The dirty renderer files at `a17e5e9` are
`ComposerActionsBar.tsx/.test.tsx`, `PermissionModeChip.tsx/.test.tsx`,
`PermissionRulesEditor.tsx/.test.tsx`, `contextBreakdownState.ts`,
`contextUsage.ts`, `planState.ts/.test.ts`, `sdkMessageFixtures.ts`,
`transcriptProjector.test.ts`. Two of these are cited by A15 findings:
`contextUsage.ts` (F14 — the report correctly flagged this itself) and
`contextBreakdownState.ts` (F11, cited as a correct sibling; its guard is present
on disk as cited, so the citation stands).
