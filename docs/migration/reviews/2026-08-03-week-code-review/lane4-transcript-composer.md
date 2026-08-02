# Lane 4: Transcript, composer, in-turn activity

All line references are to the **committed** tree at `7c6959f` (`git show 7c6959f:<path>`),
not the dirty working copy.

## Scope reviewed

`transcriptProjector.ts` (+ `transcriptViewModel.ts`), `TranscriptView.tsx`,
`ComposerActionsBar.tsx` (+ `composerActionsBarModel.ts`), `contextUsage.ts`,
`tokenWarning.ts`, `rawMessageLog.ts`, `previewTranscriptState.ts`,
`inlineOutputWindow.ts`, `outputSearchModel.ts`, `toolAck.ts`, and the two files the
lane's newest feature actually lives in but that were not on the list:
`composerState.ts` (the gate + park model) and `appModel.ts`
(`deriveActivity`/`selectLiveTokenEstimate`), plus the `App.tsx` composer/activity
region that wires them.

The week did four things here: (1) opened the composer mid-turn and parked the submit
until the turn boundary (`4394086`, `16878cf`), backed by a new `turn.status` engine
event (`d9c1cf1`); (2) moved Stop out of the activity row into the composer send slot
(`151bb19`); (3) rebuilt the activity byline to read the *turn* rather than the last row
and to count real `output_tokens` (`cb3adec`, `6d57e39`, `7c6959f`); (4) unpinned
autoscroll from the raw-message log and raised that log's count cap 512 → 8,000
(`8bb244e`). Supporting work: inline output windowing, inspector search, tool-ack
rendering, agent-completion folding.

## Findings

### [HIGH] Stop does not cancel a queued prompt, it fires it — and a queued prompt can never be removed — CONFIRMED

**Location:** `app/renderer/src/App.tsx:1903-1922` (drain), `:3475-3483` (`stopTurn`),
`:3856-3868` (the Queued row), `src/app-runtime/AppSessionController.ts:169-170`

**Defect:** `stopTurn` aborts the turn but leaves `pendingSubmits` armed. The abort makes
the controller run `finally { this.setActiveTurn(false) }`, which broadcasts
`turn.status(activeTurn: false)`; the renderer flips `inputEnabled` true; the drain
effect immediately submits the parked prompt as a **new** turn. Nothing in the UI can
cancel a queued prompt: the Queued row is a bare `role="status"` div with no control, and
Escape is gated on `generating` (`App.tsx:3658`) so it is inert the instant the turn ends.

**Failure scenario:** Turn is running. User types "also delete the old migration" and
presses Enter → parked, composer cleared, "Queued … Sends when this response finishes."
User then sees the agent going the wrong way and clicks Stop. The turn aborts, and within
one socket round-trip the queued prompt is submitted, starting a fresh turn with tools at
the session cwd. The user has no way to prevent it and no way to remove the queued text;
the only escape is to press Stop a second time and hope to beat the next turn's first
tool call.

**Evidence:** the drain is unconditional on why input reopened:

```
const outcome = resolvePendingSubmit(selectConnection(connection, sessionId))
if (outcome === 'wait') continue
...
getBridge().submit(sessionId, parked)
```

`resolvePendingSubmit` (`composerState.ts:533`) only reads `status`/`inputEnabled`; an
abort is indistinguishable from a natural turn end. The terminal REPL this feature cites
as its parity anchor does drain after a cancel too, **but it also gives the user a queue
pop**: `useCancelRequest.ts:104-110` makes a second Escape (when no task is active) call
`popCommandFromQueue()`. The desktop shipped the drain without the pop, so the terminal's
escape hatch does not exist here. Either Stop should clear `pendingSubmits` for that
session, or the Queued row needs a remove control.

### [MEDIUM] One error frame pins an undismissable red engineering string above the composer for the rest of the session — CONFIRMED

**Location:** `app/renderer/src/rawMessageLog.ts:116-123`, rendered at
`app/renderer/src/App.tsx:3844-3846`

**Defect:** `reduceServerFrameWithLimits` writes `frame.message` into `session.error` for
every `kind:'error'` frame. The only writer that clears it is the `app.ready` branch
(`rawMessageLog.ts:101-113`), which fires on attach/restore. There is no dismiss, no
timeout, and no clear on the next successful turn.

**Failure scenario:** The user pastes a ~100 KB block (the composer explicitly invites
this: "Paste a large block to attach it as a collapsed chip.", `App.tsx:4066`) and hits
Enter. The sidecar rejects it at `sidecarServer.ts:1011-1019` with
`prompt exceeds 98304 bytes`. From then on, `prompt exceeds 98304 bytes` sits in
`text-tone-danger` directly above the composer for the entire session, through every
subsequent successful turn, with no way to clear it. The same applies to
`turn_already_running`, `unauthorized`, and the idle-park `session parking` frame.

**Evidence:** the commit that landed this week (`8bb244e`) diagnosed exactly this
mechanism for the replay-retention notice — *"Nothing ever clears `error`, so displaying
it pinned an undismissable red line above the composer for the rest of the session"* —
and fixed it by filtering **one request id**
(`rawMessageLog.ts:117`, `REPLAY_BUFFER_TRUNCATION_REQUEST_ID`). The general defect is
untouched. Secondary §7 violation: the strings rendered are raw engine text carrying a
`MAX_*` constant's value (`prompt exceeds 98304 bytes`) and internal codes, which §7 bans
on a user text surface.

### [MEDIUM] The queue-release message and every transport error are app-global, so they are reported on the wrong pane — CONFIRMED

**Location:** `app/renderer/src/App.tsx:433` (state), `:1666`
(`setTransportError(PENDING_SUBMIT_RELEASED_MESSAGE)`), `:2456`
(`transportError={transportError}` — same value to every panel), `:3848-3850` (render)

**Defect:** `pendingSubmits` and the drain are correctly per-session, but the *user-facing
outcome* of a release is a single app-wide string handed to every `SessionPane`.

**Failure scenario:** Session B is a background tab with a prompt queued mid-turn. Its
engine process dies. The drain (`App.tsx:1903`, which iterates **all** sessions
regardless of which is active) resolves `release`, restores the text into B's draft, and
sets the global `transportError`. The user is looking at session A: A's pane now shows
"Your message was not sent, so it is back in the composer." in red, while A's composer is
empty and nothing about A is wrong. In a split workspace both panes show it
simultaneously. The message is cause-free by design (`composerState.ts:561`), so there is
nothing in it to disambiguate which session it means.

**Evidence:** `PENDING_SUBMIT_RELEASED_MESSAGE` is set through the same single
`setTransportError` every other pane's bridge errors use; there is no per-session error
slot in `App`. `releasePendingSubmit` (`App.tsx:1655-1667`) is stable-`useCallback` and
takes `sessionId`, so the fix is a per-session map, not a re-wire.

### [MEDIUM] The draft (and its paste chips) are destroyed before the sidecar accepts the prompt — CONFIRMED

**Location:** `app/renderer/src/App.tsx:1873-1894`

**Defect:** `retireDraft()` clears the draft, deletes the session's collapsed-paste
entries (`reduceSessionPastesCleared`) and pushes to ↑ history, and is called immediately
after a fire-and-forget `getBridge().submit(...)`. The `try/catch` around it only catches
a *synchronous* bridge throw; every sidecar-side rejection arrives later as an `error`
frame, by which point the composer is already empty.

**Failure scenario:** Oversized prompt (above), or a submit landing in the window between
the drain's `submit()` and the arrival of `turn.status(true)` — the sidecar's `activeTurn`
is already `true` (`sidecarServer.ts:1048-1057`) so it answers `turn_already_running`,
which the renderer never handles (`git grep turn_already_running` finds it only in
`protocol.ts:579`). Result: composer empty, paste pills gone, one permanent red line, and
no indication the message did not go. The text itself is recoverable via ↑ (history stores
the paste-expanded string), but nothing tells the user to try that, and the pills are
genuinely gone.

**Evidence:** `getBridge().submit(sessionId, text); retireDraft()` — the retire is
unconditional on the far side accepting. The parked-submit path has a proper release
mechanism (`releasePendingSubmit` → `restoreDraftWithPending`) for exactly this hazard;
the direct-send path has none.

### [MEDIUM] The live token byline walks the whole retained raw log on every streaming delta after 30s, and that log just grew 16× — CONFIRMED (path) / PLAUSIBLE (magnitude)

**Location:** `app/renderer/src/App.tsx:3464-3470`,
`app/renderer/src/appModel.ts:197-223`, `app/renderer/src/rawMessageLog.ts:37`

**Defect:** `liveTokens` is a `useMemo` over `[generating, nestedRows, activeLog.messages,
elapsedMs]`. `activeLog.messages` is a **new array identity on every appended message**
(`rawMessageLog.ts:154`), and streaming deltas are appended messages. So once
`elapsedMs > 30_000` the memo recomputes on every delta, and each recompute runs
`selectCompletedOutputTokens` over the *entire* retained log, building a fresh `Map`.
`8bb244e` raised `DEFAULT_MAX_RAW_MESSAGES` from 512 to 8,000 in the same week, so the
per-delta scan is up to 16× longer than it was.

**Failure scenario:** A long session (raw log at cap) running a >30 s streaming turn: each
delta triggers a full 8,000-message scan plus a Map rebuild, on the render path, while the
same deltas are also re-copying two 8,000-element arrays in the reducer. Expected symptom
is composer/transcript input lag that gets worse the longer a session has been open — i.e.
precisely on the long turns the byline exists to serve.

**Evidence:** `7c6959f` fixed the *pre-30s* half of this ("it was walking the whole
retained raw log once per streaming delta for a number nothing could show yet") by moving
the gate into the memo. Past 30 s the walk resumes unchanged, and 99% of it is wasted:
only message ids belonging to the current operator turn are ever looked up
(`appModel.ts:268-287`), but the scan covers every turn in the session. Not measured — I
did not run the app.

### [MEDIUM] Switching tabs mid-turn resets the elapsed clock to 0s and hides the token byline for another 30s — CONFIRMED

**Location:** `app/renderer/src/App.tsx:3435-3451`, `:3464-3470`;
`app/renderer/src/WorkspacePanels.tsx:150` (`<Fragment key={panel.sessionId}>`)

**Defect:** `elapsedMs` / `turnStartRef` are `SessionPane`-local state. Panels are keyed by
`panel.sessionId`, so selecting a different session in a panel unmounts the `SessionPane`
and remounts a fresh one; returning re-mounts with `elapsedMs = 0` and
`turnStartRef = Date.now()`.

**Failure scenario:** Session A has been running a turn for 3 minutes. User switches to
tab B, then back to A. The activity byline reads "Working 0s" and the token byline
disappears until 30 more seconds pass — a wrong number presented as a measurement, on the
one surface whose job is to say how long the turn has been going. `stopError` and the
transcript scroll position are lost the same way.

**Evidence:** the effect derives the start time from the mount, not from any turn fact on
the wire. `turn.status` carries the boundary but no timestamp, so the pane has nothing
durable to re-anchor to — this needs either a per-session turn-start map in `App` or a
timestamp on the event.

### [LOW] Inspector search highlights mis-slice a line when case-folding changes its length — CONFIRMED

**Location:** `app/renderer/src/outputSearchModel.ts:127-145`

**Defect:** `splitLineByQuery` computes match offsets on `line.toLowerCase()` but slices
`line` with them. For characters whose lowercase form has a different UTF-16 length
(`İ` U+0130 → `i̇`, 1 unit → 2), every offset after the first such character is shifted, so
the emitted segments no longer reconcatenate to the original line.

**Failure scenario:** Searching `i` inside a tool output line containing `İSTANBUL`: the
highlighted runs land one code unit off, and the rendered line drops or duplicates a
character relative to the source. The `describeOutputSearch` match *list* is unaffected
(it uses `includes`), so the counter says the right thing while the body renders wrong.

### [LOW] The tolerant fallback row prints an internal union member to the user — CONFIRMED

**Location:** `app/renderer/src/TranscriptView.tsx:498-501`

**Defect:** The degrade-gracefully branch renders `Unrecognized transcript row: {rowKind}`,
where `rowKind` is a projector row-kind identifier (`snip-boundary`, `injected-turn`, …).
§7 bans internal vocabulary on a user text surface. The fallback itself is correct and
required (it must not throw); only the string is. Cost is small but it is on the one path
that fires exactly when the app is already confusing the user.

### [LOW] The lane's one `as` cast in projector-style code — CONFIRMED

**Location:** `app/renderer/src/previewTranscriptState.ts:206`

**Defect:** `messages.push(message as SDKMessage)` after checking only `isRecord(message)`
and `typeof message.type === 'string'`. Everything downstream re-narrows
(`readStringField`, `selectContextUsage`'s `isRecord` guards), so nothing currently breaks
— but §7's "zero `as` casts in projector-style code" is otherwise held across the whole
lane, and this is the single exception. `contextUsage.ts` is handed this array and treats
`message.usage`/`message.modelUsage` as `unknown`, so the cast buys nothing it doesn't
already re-check.

## Coverage gaps

- **The entire mid-turn queue drain is untested behaviourally.** `App.test.tsx:791`
  ("CC-16 wiring tripwire") is a `readFileSync` + `expect(source).toContain(...)` test and
  says so outright: *"the app/ renderer suite is SSR-only … React effects never run here
  and the drain cannot be executed."* Nothing exercises: drain-on-turn-end,
  release-on-terminal-status, per-session isolation, the one-slot toast, or a second
  Enter. The finding above (Stop rearms the queue) is invisible to every test in the
  package by construction, and a refactor that reformats `submitSession` breaks the test
  without breaking behaviour — and vice versa.
- **Stop × queue has no test at all**, in either direction. `151bb19` and `4394086`
  landed a day apart and neither test file mentions the other's state.
- **Autoscroll.** `8bb244e`'s fix is asserted at source level only (`contentSignature`
  derivation); the effect that consumes it (`App.tsx:3548-3552`), `onTranscriptScroll`'s
  120px threshold, and `jumpToBottom` cannot run under SSR. "Does the pane fight the
  user's scroll" is unanswerable from this suite.
- **Keyboard paths**: Escape→Stop, Tab→toolbar, Enter-vs-Shift+Enter, and the IME guard
  are all `onKeyDown` on a form that never receives events in these tests.
- Good counter-examples worth keeping: `inlineOutputWindow.ts` and `outputSearchModel.ts`
  were deliberately extracted as pure functions *because* the suite is SSR-only, and both
  carry real unit coverage. That is the pattern the queue drain should have followed.

## Clean

Checked and found sound:

- **Projector immutability.** No in-place row mutation anywhere in `transcriptProjector.ts`
  (no field assignment on a stored row, no `Object.assign`, no `splice`/`sort`/`reverse`,
  no `rows[i] =`). `selectTranscriptRows:438-467` joins `status`/`result`/`agentCompletion`
  at read time and returns the *same* row object when nothing changed, which is what makes
  the `React.memo` rows work.
- **The read-time caches are keyed correctly.** `nestedRowsCache` is a `WeakMap` on the
  session **slice object**, not on `session.rows` — which matters, because a `tool_result`
  changes only `toolResultsByUseId` and leaves `rows` identical. `foldToolResultBlocks`
  (`:1190`) returns `{...state, toolResultsByUseId}`, a new slice, so the cache misses and
  a completing tool card actually re-renders. Same for `displayItemsCache`.
- **Exhaustiveness tripwires** are present and real at all three sites
  (`transcriptProjector.ts:783`, `TranscriptView.tsx:367`, `:496`), each paired with a
  runtime-tolerant branch. No `SDKMessage` case was added this week (the `+case` lines in
  the diff are tool-family names), and `sdkMessageFixtures.ts` gained 123 lines in the same
  range, so the two sides did not drift.
- **Display degrades, never throws.** Unknown row kind → fallback row. `parseToolAck`
  (`toolAck.ts:44-62`) is fail-soft with zero casts across five rejection paths.
  `ToolUseRow.input` is guarded at the mint site (`transcriptProjector.ts:1630`,
  `isRecord(block.input) ? block.input : {}`), so `JSON.stringify(row.input).length` in the
  token estimate cannot throw.
- **Token arithmetic.** `selectContextUsage` cannot divide by zero (`contextWindow` is
  forced positive at `:105-108`) and clamps to 0–100; `readNum` rejects `NaN`/`Infinity`.
  `selectTokenWarning` cannot emit `NaN` because the sidecar only ships a `threshold` that
  passed `positive()` (`runControlsDomain.ts:549`). `selectLiveTokenEstimate` counts each
  message id once (`counted` set) and `continue`s past a counted row so real tokens and the
  character estimate cannot double-count the same message.
- **Queue correctness apart from the Stop hole**: `pendingSubmits` is keyed by `SessionId`,
  the drain iterates by key, a release restores into the *right* session's draft (prepended
  ahead of anything typed since, `restoreDraftWithPending`), the one-slot limit is enforced
  with an explicit toast rather than a silent drop, and all four terminal outcomes of a
  restore call `releasePendingSubmit`.
- **Project rules.** Zero em dashes in any user-visible string across the lane (every `—`
  hit in `TranscriptView.tsx`, `ComposerActionsBar.tsx` and the `App.tsx` composer region
  is inside a comment); no `'—'` placeholder, no ` — ` aria separator. Fast Refresh
  boundary held: both `.tsx` files export components and types only. No interpolated
  arbitrary-value Tailwind classes — every template literal splices a value from a static
  map (`fam.color`, `st.dot`, `SEAM_LABEL_TONE`, `DIFF_ROW_CLASS`). The two `style={{}}`
  uses (`ComposerActionsBar.tsx:406,645`) are width-only percentages with the §0 exception
  documented in place.
- **Raw-log dedupe**: replayed frames are uuid-deduped, live frames are not — correct for a
  raw debug view, and the eviction loop keeps `messages`/`messageBytes` in lockstep.
