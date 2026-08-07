# A16 — composer, permission, and context state

## Verdict

This is unusually careful code: the permission queue is a correct engine-authoritative
model with real dedupe/rebuild semantics, the composer's paste/history/park machinery is
source-anchored to the engine line-by-line, and every runtime narrowing is cast-free.
The single most important thing to fix is the **context gauge's denominator**: it divides
by the model's raw context window while every user-facing context percentage in the engine
(`StatusLine`, `TokenWarning`, `ExitPlanModePermissionRequest`) divides by
`getEffectiveContextWindowSize` — window minus up to 20k reserved. On a 200k model that is
an 8-percentage-point understatement, and it makes the composer rail contradict itself
(donut reading 84% beside a warning glyph reading "0% left"). Second: the tab
attention badge counts pending permissions with no connection gate while the pane that
would satisfy it is gated on `ready`, so a background tab can pulse forever over an empty
rail. Everything else is quality: heavy duplication across seven identical
snapshot-domain modules, and three production-dead exports, one of which encodes a
behaviour the codebase elsewhere documents as a bug.

## Findings

### [HIGH] Context gauge divides by the raw window; every engine context percentage divides by the effective window

- **Where**: `/Users/pt/cat-code/app/renderer/src/contextUsage.ts:376-380` (and the
  denominator it consumes, `/Users/pt/cat-code/app/sidecar/runControlsDomain.ts:573-578`)
- **Type**: correctness
- **What**: `selectContextUsage` computes `percentUsed = usedTokens / contextWindow` where
  `contextWindow` is `getContextWindowForModel(...)` — the model's raw window, taken either
  from `modelUsage[model].contextWindow` on the result frame
  (`/Users/pt/cat-code/src/cost-tracker.ts:107`) or from `readContextWindow`
  (`runControlsDomain.ts:574`, the same raw function). The engine's own user-facing context
  percentage uses `getEffectiveContextWindowSize(model)` =
  `getContextWindowForModel(...) − min(getMaxOutputTokensForModel(model), 20_000)`
  (`/Users/pt/cat-code/src/services/compact/autoCompact.ts:40-56`), consumed by
  `/Users/pt/cat-code/src/components/StatusLine.tsx:51-52`,
  `/Users/pt/cat-code/src/components/TokenWarning.tsx:144`, and
  `/Users/pt/cat-code/src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx:19-20`.
  The numerator matches (`getTokenCountFromUsage`, all four buckets,
  `/Users/pt/cat-code/src/utils/tokens.ts:52-59`); only the denominator diverges.
- **Trigger / why it matters**: same session, 140,000 tokens of context on a 200k model.
  Engine: `round(140000 / 180000 * 100)` = **78%**. Desktop donut:
  `round(140000 / 200000 * 100)` = **70%**. The desktop reads *low* — it understates
  pressure, which is the dangerous direction. Worse, the divergence is visible inside the
  desktop itself: `tokenWarning.ts:60-74` measures against
  `RunControlsSnapshot.autoCompact.threshold`, which the sidecar derives from
  `getEffectiveContextWindowSize` (`runControlsDomain.ts:545-551`). At 167k on a 200k model
  the donut shows 84% while the glyph beside it shows 0% headroom left before auto-compact.
  The comment at `tokenWarning.ts:41-44` already names the mismatch ("the denominator is
  `getEffectiveContextWindowSize` … which differs from the gauge's `contextWindow`") without
  reconciling it.
- **Fix**: have `readContextWindow` (`runControlsDomain.ts:573`) return
  `getEffectiveContextWindowSize(model)` — the module already imports it at
  `runControlsDomain.ts:56` — and use `modelContextWindow` in preference to the result
  frame's raw `modelUsage[model].contextWindow` for the gauge. One number, one basis,
  matching the engine that actually compacts.

### [MED] The tab "permission request waiting" badge has no connection gate; the pane that would satisfy it does

- **Where**: `/Users/pt/cat-code/app/renderer/src/permissionState.ts:291-300`,
  consumed at `/Users/pt/cat-code/app/renderer/src/tabStatus.ts:108,131` and rendered at
  `/Users/pt/cat-code/app/renderer/src/TabBar.tsx:269,285`
- **Type**: correctness
- **What**: `selectPendingPermissionCount` reads `session.pending` with no connection-status
  condition, and `deriveTabVisualState` turns it straight into
  `needsAttention: pendingPermissionCount > 0 && !isActive` on every return path, including
  the dead/disconnected one. The rail that would show those cards is gated on
  `sessionConnection.status === 'ready'` in all three places
  (`/Users/pt/cat-code/app/renderer/src/App.tsx:2370-2394`).
- **Trigger / why it matters**: a background session has a pending `Bash` permission. A verb
  send to it fails and the supervisor replies with an `error` frame carrying
  `session_disconnected` or `session_not_found`. `reduceConnectionState`
  (`/Users/pt/cat-code/app/renderer/src/connectionState.ts:259-268`) flips the status to
  `disconnected`/`dead` — but **no `lifecycle` frame is involved**, and
  `reducePermissionState` only resets a session's queue on `lifecycle`
  (`permissionState.ts:154-160`); its `error` branch (`:162-170`) touches
  `submittedRequestIds` and nothing else. So `pending` survives. The tab now carries the
  amber dot and the aria-label ", permission request waiting" indefinitely, and clicking it
  shows an empty permission rail. This path is not hypothetical: `App.tsx:1892-1895`
  documents that a parked session closed by the user "never receives a lifecycle frame …
  the host deregisters the record before the child dies, so the exit is dropped."
  Only a full restart (which produces a `ready` frame and rebuilds the queue from the
  engine snapshot) clears it.
- **Fix**: pass the connection status into `deriveTabVisualState`'s attention calculation, or
  gate `selectPendingPermissionCount` the same way the rail is gated. The two derivations
  must answer the same question.

### [MED] `permission_not_found` re-arms the card instead of removing the request

- **Where**: `/Users/pt/cat-code/app/renderer/src/permissionState.ts:162-170`
- **Type**: correctness
- **What**: the reducer's `error` branch ignores `frame.code` entirely and, for any error
  carrying a `requestId` that is in `submittedRequestIds`, removes it from that list —
  re-enabling Allow/Deny. But `permission_not_found` is the sidecar's definitive statement
  that the request is no longer pending engine-side
  (`/Users/pt/cat-code/app/sidecar/sidecarServer.ts:2470-2479`, the same lookup used by
  `handlePermissionResponse`). Un-submitting on that code is exactly backwards.
- **Trigger / why it matters**: if a `permission.resolved` event is ever missed (it is the
  **only** removal path in the reducer besides `lifecycle` and the `ready` rebuild —
  `permissionState.ts:193-199`), the card stays in the queue. The user clicks Allow; the
  sidecar answers `permission_not_found`; the reducer re-enables the buttons and
  `respondToPermission`'s `answered` guard (`App.tsx:2272-2276`) now passes again, so the
  next click repeats the round trip and raises another transport-error banner. There is no
  "this request is gone" path — only Esc-snooze hides it. The precondition (a lost
  `permission.resolved`) is not something I demonstrated end-to-end, but the reducer's
  response to the code is wrong regardless of how the state is reached.
- **Fix**: branch on `frame.code`: `permission_not_found` → `removeRequest(session, frame.requestId)`;
  every other code keeps the existing un-submit.

### [MED] `selectUsedTokens` rescans the whole session log on every streamed frame

- **Where**: `/Users/pt/cat-code/app/renderer/src/contextUsage.ts:281-333` and `:350-367`,
  driven from `/Users/pt/cat-code/app/renderer/src/App.tsx:3925-3928`
- **Type**: correctness (performance)
- **What**: the memo is keyed on `activeLog.messages`, which is a fresh array on every
  appended frame. `selectUsedTokens` then does an unconditional full forward pass to collect
  `message_start` indices (`:287-291`), a backwards group fold, and — when no group reported
  a positive total — a second full backwards pass over the assistant frames. `selectContextUsage`
  adds a third backwards pass looking for the newest `result` frame, which scans the entire
  array when the session has not produced one yet.
- **Trigger / why it matters**: the raw log is capped at
  `DEFAULT_MAX_RAW_MESSAGES = 8_000` (`/Users/pt/cat-code/app/renderer/src/rawMessageLog.ts:37`),
  so a mature session runs 8,000–16,000 iterations *per streamed delta*, on the main thread,
  in the same pane that is reconciling the transcript. During a long first turn (no `result`
  frame yet) all three passes run at full length on every delta.
- **Fix**: this is an incremental fold over an append-only log. Either carry the last
  computed `{groupStart, usage}` forward across renders, or bound the walk — the answer only
  ever depends on the newest `message_start` group plus, in the fallback, the newest
  usage-bearing assistant frame.

### [MED] Seven renderer modules are the same snapshot-per-session domain copy-pasted

- **Where**: `/Users/pt/cat-code/app/renderer/src/contextBreakdownState.ts:18-62`,
  `/Users/pt/cat-code/app/renderer/src/runControlsState.ts:17-61`,
  `/Users/pt/cat-code/app/renderer/src/slashCatalogState.ts:21-65`,
  `/Users/pt/cat-code/app/renderer/src/verbAckResultState.ts:37-88`, plus
  `diagnosticsState.ts`, `extensionsState.ts`, `workspaceTrustState.ts`
- **Type**: quality
- **What**: each is `{ sessions: Record<SessionId, T | null> }` + a reducer that stores the
  payload on one frame kind, nulls the entry on `lifecycle` when the key exists, and returns
  `state` otherwise + a `select` that returns `?? null`. The bodies are token-identical down
  to the comment ("A process/transport reset drops the stale snapshot; a fresh one arrives on
  re-attach. Untracked sessions are left alone"), which is literally duplicated across all
  seven. The only variation is the frame kind, the payload field name, and whether the empty
  value is `null` or `[]`.
- **Trigger / why it matters**: ~250 lines of exact duplication, and seven places to change
  when the reset semantics move. It also hides the one place they *do* differ:
  `slashCatalogState.selectSlashCatalog` returns `[]` while the others return `null`,
  a difference a reader has to diff four files to notice.
- **Fix**: one `createSnapshotDomain<Kind, Payload>({ kind, read, empty })` factory returning
  the `create`/`reduce`/`select` triple; keep the per-domain files as thin bindings so the
  `create<X>State` / `reduce<X>State` / `select<X>` naming convention is preserved.

### [LOW] `reducePasteRemoved` is production-dead and encodes the behaviour the code elsewhere calls a bug

- **Where**: `/Users/pt/cat-code/app/renderer/src/composerState.ts:169-179`
- **Type**: dead-code
- **What**: exported, covered by `composerState.test.ts:168`, and called from nowhere in
  production. `removeSessionPaste` (`App.tsx:2234-2253`) deliberately does *not* use it, and
  says why: "Dropping the entry here outright would strand that surviving pill with nothing
  behind it, so it would submit as the literal token."
- **Trigger / why it matters**: the next contributor reaching for a "remove this paste"
  reducer finds one, uses it, and reintroduces the exact defect the comment two files away
  warns about. A test passing on it makes it look supported.
- **Fix**: delete the function and its test.

### [LOW] `describeSuggestion` is production-dead and prints the raw engine `behavior` enum

- **Where**: `/Users/pt/cat-code/app/renderer/src/permissionPromptModel.ts:154-173`
- **Type**: dead-code / convention
- **What**: the only callers are in `PermissionPrompt.test.tsx`. Its live sibling
  `describeSuggestionOption` (`:201-239`) exists specifically because printing `behavior`
  raw was wrong — `BEHAVIOR_LEAD` at `:181-188` carries the comment: "`behavior` is the one
  engine enum this module used to print raw, which produced rows reading 'Yes, and deny
  `Bash(rm:*)`' next to a row whose effect is an allow." `describeSuggestion:160` still does
  `` `${update.behavior} ${rules} · …` ``, emitting `allow Bash(rm:*) · User settings`.
- **Trigger / why it matters**: wiring it to any surface would put internal engine vocabulary
  in front of a user, which §7's user-visible-text rule forbids. Two formatters for the same
  concept, one of them the known-bad version, kept alive by its test.
- **Fix**: delete it and fold its coverage into `describeSuggestionOption`'s tests.

### [LOW] `composerPopover.ts` has unused imports and creates a second import path for one function

- **Where**: `/Users/pt/cat-code/app/renderer/src/composerPopover.ts:7-13`
- **Type**: quality
- **What**: `handleMenuRovingKeyDown` and `nextMenuRovingIndex` are imported at `:8-9` and
  never referenced in the module body (only `usePopoverFocus` is, at `:36`); the re-export at
  `:13` is a separate `export … from` binding. The result is that
  `ComposerActionsBar.tsx:12`, `PermissionModeChip.tsx:2`, `WelcomeScreen.tsx:56` and
  `AccountsPage.tsx:75` import `handleMenuRovingKeyDown` from `composerPopover.js`, while
  `PlanPanel.tsx:3` and `SessionsPage.tsx:44` import the identical function from
  `overlayFocus.js`.
- **Trigger / why it matters**: two import paths for one symbol makes a grep for its call
  sites incomplete, and the pass-through re-export adds no abstraction — `composerPopover`
  owns `usePopover`, nothing about roving.
- **Fix**: drop `handleMenuRovingKeyDown`/`nextMenuRovingIndex` from both the import and the
  re-export; point the four consumers at `overlayFocus.js` like the other two already do.

### [LOW] `selectGenericPermissionQueue` takes a queue while its siblings take state, and its doc claims a composition it does not perform

- **Where**: `/Users/pt/cat-code/app/renderer/src/askQuestionState.ts:126-144`
- **Type**: design
- **What**: the doc comment says "Composed on top of `selectNonPlanPermissionQueue` so the
  plan exclusion stays single-sourced in `planState.ts`", but the function takes an arbitrary
  `PermissionQueueItem[]` and only filters AskUserQuestion. The composition happens at the
  call site (`App.tsx:2391-2393`). Its two peers in the same layer,
  `selectPlanReview(state, sessionId)` and `selectAskQuestion(state, sessionId)`, take state.
- **Trigger / why it matters**: a second call site that passes `selectPermissionQueue(...)`
  directly gets the plan request back in the generic queue, and `PlanPanel` renders the same
  `ExitPlanMode` request simultaneously — two cards, two Allow buttons, for one requestId.
  The comment actively tells the reader that cannot happen.
- **Fix**: give it the sibling signature `(state, sessionId)` and perform the
  `selectNonPlanPermissionQueue` composition inside, which is what the comment describes.

### [LOW] `addSessionPaste` writes paste state from a stale closure instead of an updater

- **Where**: `/Users/pt/cat-code/app/renderer/src/App.tsx:2209-2232`
- **Type**: correctness
- **What**: `reducePasteAdded(pasteState, …)` reads `pasteState` from the render closure and
  `setPasteState(nextPasteState)` writes the whole object back, unlike every other paste
  mutation in the file, which uses the functional form (`setPasteState(prev => …)`).
- **Trigger / why it matters**: if two `addSessionPaste` calls land in one React batch, the
  second starts from the pre-first snapshot, so `session.nextId` repeats and the second entry
  **overwrites** the first at the same key (`composerState.ts:159-165`) while both
  `[Pasted text #1]` tokens remain in the draft. Both pills then preview the same content and
  the submitted prompt carries the wrong body. I could not construct a user-reachable
  double-call — `handlePaste` (`App.tsx:3989-4003`) fires once per paste event — so this is
  currently latent rather than live.
- **Fix**: `setPasteState(prev => reducePasteAdded(prev, sessionId, content).state)`, with the
  token derived from the same reducer result.

### [LOW] An external draft write during IME composition is silently discarded

- **Where**: `/Users/pt/cat-code/app/renderer/src/ComposerInput.tsx:175-226` (the
  `isComposingRef` early return at `:180`) and `:244-248`
- **Type**: correctness
- **What**: the layout effect that syncs `value` → DOM returns early while an IME composition
  is active, which is correct for protecting the composition. But on `compositionend`,
  `handleInput` reads the DOM back and calls `onValueChange(readComposerText(root))` — the
  DOM still holds the *pre-write* text, so whatever set `value` during the composition is
  overwritten.
- **Trigger / why it matters**: a parked prompt is released while the user is mid-composition.
  `releasePendingSubmit` (`App.tsx:1776-1789`) writes the released text into the draft via
  `restoreDraftWithPending` and shows "Your message was not sent, so it is back in the
  composer." The composition then commits, the DOM read wins, and the text the banner just
  promised is gone. Same shape for a `history-nav` write landing during composition.
- **Fix**: record that an external write was skipped while composing, and on `compositionend`
  re-run the sync from `value` (splicing in the committed text) rather than trusting the DOM.

### [LOW] `buildAllowResponse` ignores its first parameter

- **Where**: `/Users/pt/cat-code/app/renderer/src/permissionState.ts:333-344`
- **Type**: quality
- **What**: `_request: PermissionRequest` is never read; the function only forwards
  `applySuggestions`. Both call sites (`App.tsx:2610-2617`, `:2640-2648`) run a `.find()` over
  the queue purely to produce an argument the function discards.
- **Trigger / why it matters**: the signature implies the response is derived from the
  request, which is precisely the thing the permission boundary forbids (C1: the renderer
  selects by index, the sidecar re-attaches the engine's objects). A reader has to open the
  body to learn that.
- **Fix**: drop the parameter. Keep the call-site `.find()` as an explicit existence guard —
  which is what it actually is.

### [LOW] `nextSlashIndex` also drives the mention picker

- **Where**: `/Users/pt/cat-code/app/renderer/src/slashCommandPickerModel.ts:25-32`, called
  for mentions at `/Users/pt/cat-code/app/renderer/src/App.tsx:4160,4165` (and the
  slash equivalents above)
- **Type**: quality (naming)
- **What**: a generic wrap-around index step named after one of its two consumers, living in
  the slash module while `mentionPickerModel.ts` (10 lines, one function) sits beside it.
- **Fix**: rename to `nextPickerIndex` and move it next to the other picker primitives, or
  merge the two 10–36-line picker-model files into one `pickerModel.ts`.

## What is good here

- **`permissionKeysAreLive` (`permissionPromptModel.ts:106-111`) is the correct version of
  the focus-ownership test the confirmed `AskQuestionFlow.tsx:150` bug gets wrong.** It uses
  `closest(FOCUSED_KEY_OWNER_SELECTOR)` with `[contenteditable]` in the selector list
  (`:65-69`), so the contentEditable composer *is* recognised as a key owner and the plain
  `n`/Enter/Escape shortcuts stay dead while the user types. The fix for AskQuestionFlow is
  to adopt this predicate plus its own host attribute, not to extend the tag-name list.
- **The `ready`-frame rebuild (`permissionState.ts:112-138`) is the right authority model**:
  the engine's `pendingPermissionRequests` snapshot replaces the queue outright and local
  dismissed/submitted bookkeeping is filtered down to ids still pending. That is what makes
  a re-attach self-healing, and it is why most stranding scenarios recover on restart.
- **`selectUsedTokens`'s newest-group-first fold is genuinely correct, not defensive.** The
  per-group fold with an explicit group end (`contextUsage.ts:296-316`) prevents a newer
  delta leaking into an older group's total, `foldUsage` (`:157-178`) mirrors the engine's
  newest-positive-wins rule rather than summing, and the compact-boundary floor plus
  preserved-tail skip (`:222-252`, `:318-322`) matches
  `/Users/pt/cat-code/src/utils/tokens.ts:75-96,338` including the snake_case
  `compact_metadata.preserved_segment.head_uuid` field names in the SDK snapshot. The
  boundary predicate also correctly matches only `compact_boundary` and not
  `microcompact_boundary`, exactly like `isCompactBoundaryMessage`
  (`/Users/pt/cat-code/src/utils/messages.ts:797-801`).
- **`PASTE_REF_RE` is a module-level `/g` regex and every consumer handles `lastIndex`
  correctly** — `splitComposerText` (`composerDom.ts:168`) and `pasteIdAtCaret`
  (`composerState.ts:299`) each build a fresh instance, and the one direct use is
  `String.replace`, which the spec resets. All reducers in this scope are pure; there is no
  other module-level mutable state.
- **The parked-submit state machine is the strongest piece here.** `resolvePendingSubmit`
  (`composerState.ts:604-626`) has a `never` exhaustiveness tripwire, its terminal partition
  is pinned against `isTerminalConnectionStatus` by test, and every terminal arm hands the
  text back to the composer with a visible message rather than dropping it
  (`restoreDraftWithPending`, `PENDING_SUBMIT_RELEASED_MESSAGE`). The Stop-race note at
  `:628-651` documents a real byte-identical-frame ambiguity and resolves it synchronously.

## Not reviewed / uncertain

- **The AskUserQuestion cross-request answer leak is closed, and I verified it.** The scoped
  question was whether `askQuestionState` can record an answer for a question the user never
  saw. `AskQuestionFlow` holds `answers`/`qi` in component state seeded once by a lazy
  initializer (`AskQuestionFlow.tsx:50-53`), so a request swap under a live instance would
  submit the previous request's drafts — but `App.tsx:4286` renders it with
  `key={askQuestion.request.requestId}`, forcing a remount. `advance()` also requires
  `canAdvance` on the current question, and `qi` only ever increments, so every question in a
  submitted payload was reached and answered. The *state* side is sound; the exposure is
  entirely the `AskQuestionFlow.tsx:150` tag-name guard already confirmed, which lets `1`–`9`
  select an option and Enter submit while the user types in the composer.
- **The permanently-null context breakdown degrades correctly.** When
  `contextBreakdownDomain.snapshot()` returns null, `broadcastContextBreakdown`
  (`sidecarServer.ts:3043-3046`) sends no frame at all, so
  `contextBreakdownState.sessions[id]` stays undefined, `selectBreakdownRows` returns `[]`,
  and `ContextUsagePanel` (`ComposerActionsBar.tsx:743-775`) renders the aggregate header row
  alone with no donut, no legend, no `Free`, and no hanging spinner — the popover's
  recompute request is explicitly best-effort (`App.tsx:2528-2537`). The one cost: a user
  cannot distinguish "not computed yet" from "cannot be computed", and nothing is logged
  renderer-side. That is the documented "absent, never fabricated" posture, so I did not file
  it as a defect.
- **I did not run the app or any GUI verification**, so the perf claim in the
  `selectUsedTokens` finding is derived from the code path and the 8,000-message cap, not
  from a measured profile. A profile during a live streaming turn on a mature session would
  settle whether it is worth fixing now or is lost in reconciliation noise.
- **`reducePermissionState` re-appends on a duplicate `permission.requested`**
  (`permissionState.ts:174-191` filters then pushes to the end), which reorders the
  arrival-order queue and could move `selectVisiblePermission`'s pick mid-interaction. I
  could not find an engine path that re-mints the same `requestId`, so I did not file it;
  confirming whether the engine ever re-emits a request would close it either way.
