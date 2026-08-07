# A19 — renderer interactive components

## Verdict

This is unusually disciplined UI code: the permission boundary is clean (the renderer
never constructs a rule object, only sends indices), the Tailwind dynamic-class trap
has zero hits, the Fast Refresh boundary is intact, and there is no em dash in any
user-readable string. The shared focus machinery in `overlayFocus.ts` is genuinely
good and most overlays route through it. The single most important thing to fix is
`AskQuestionFlow`'s window keydown handler: it guards against `INPUT`/`TEXTAREA` by
tag name, but the composer is a **contentEditable div**, so typing in the composer
while a question is pending sends Escape → deny and Enter → submit to the engine, and
swallows the letters `o`/`j`/`k` and digits 1–9 out of the draft. The sibling surface
one file over (`PermissionPrompt`) already solved exactly this with
`permissionKeysAreLive`; the fix is to use it.

## Findings

### [HIGH] AskQuestionFlow's window keydown hijacks the composer, denying or submitting the request

- **Where**: `/Users/pt/cat-code/app/renderer/src/AskQuestionFlow.tsx:150` (guard), `:152`, `:157`, `:167`, `:183`
- **Type**: correctness
- **What**: The flow registers a `window` keydown listener and bails only on
  `target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'`. The composer is a
  `contentEditable` `<div role="textbox">` (`ComposerInput.tsx:317-350`,
  `contentEditable={editable}`), so its `tagName` is `DIV` and the guard never fires.
  The handler also never checks `event.defaultPrevented`, and the composer's own
  keydown (`App.tsx:4074-4116`) calls `preventDefault()` but never `stopPropagation()`,
  so every keystroke reaches this listener.
- **Trigger / why it matters**: An `AskUserQuestion` is pending on the active pane
  (`composerGate` keeps the composer editable in exactly this state — `App.tsx:3798`,
  "Typing and attaching are allowed"). The user clicks into the composer to type a
  note and:
  - presses **Escape** → `onCancel()` fires → `buildDenyResponse('User declined to
    answer questions')` is sent (`App.tsx:2687-2696`). The request is denied by a
    keystroke aimed at the text field. This needs no precondition at all, and fires
    even mid-turn where the composer already consumed Escape for `stopTurn`.
  - presses **Enter** to send the message → `advance()` also runs; if an option was
    already picked, the last question submits `onAnswer(...)` alongside the prompt.
  - types **`o`** → `preventDefault()` + `setOtherActive(true)`, and the
    `useEffect` at `:75-77` moves focus out of the composer into the freeform input.
    The letter never lands in the draft.
  - types **`j``k`** or **`1`–`9`** → swallowed from the draft, cursor moves / an
    option is toggled invisibly.
- **Fix**: Replace the tag-name test with the existing
  `permissionKeysAreLive(event.target)` from `permissionPromptModel.ts:106` (its
  `FOCUSED_KEY_OWNER_SELECTOR` already includes `[contenteditable]` and uses
  `closest`), and add an `if (event.defaultPrevented) return` at the top of the
  handler.

### [MED] PermissionPrompt acts on keys it is not advertising, so an unseen row can be confirmed

- **Where**: `/Users/pt/cat-code/app/renderer/src/PermissionPrompt.tsx:250`, `:294-302`, `:183-211`
- **Type**: correctness
- **What**: `keysLive` (which gates both the `↑↓ · 1–9 · ↵ · esc` hint and
  `activeIndex`, i.e. the visible highlight) is only re-derived by the card's own
  `onFocus`/`onBlur` and by the `keyboardTarget` effect. The keydown listener,
  however, decides independently via `permissionKeysAreLive(event.target)`. The two
  can disagree.
- **Trigger / why it matters**: The card mounts while the user is typing in the
  composer, so `isEditableElement(previous)` is true, focus is deliberately left
  alone, and `keysLive` is set false (`:191-197`) — no hint, no highlighted row. The
  user then clicks a non-focusable area (transcript background); `document.activeElement`
  becomes `<body>`. No focus event ever reaches the card's `<section>`, so `keysLive`
  stays false, but `permissionKeysAreLive(document.body)` returns `true`, so the
  listener is fully live. ArrowDown now walks the cursor with nothing painted, and
  Enter confirms `pickAt(cursor)` — which may be a suggestion row, applying an
  always-allow rule the user was never shown as selected. This is precisely the
  invariant the hover path was gated for (`:415-419`: "the highlighted row is always
  the last row the user was shown as highlighted"); the keyboard path reproduces the
  defect.
- **Fix**: Gate the listener on the same condition as the paint — either bail when
  `!keysLive` for the `confirm`/`pick` intents, or re-derive `keysLive` from
  `document.activeElement` inside the handler before acting.

### [MED] TasksDialog's keyboard selection is never scrolled into view, so `K` can stop an unseen task

- **Where**: `/Users/pt/cat-code/app/renderer/src/TasksDialog.tsx:161-181`, `:257`, `:786-788`, `:808-815`
- **Type**: correctness
- **What**: ↑/↓ move `selected` over the flattened task list and `K` stops
  `stoppableTaskIdAt(flat, selected)`, but nothing scrolls the selected row into the
  `overflow-y-auto` body, and `TaskRow` is a plain `<div>` with no `role="option"` /
  `aria-selected` — only a background class conveys selection.
- **Trigger / why it matters**: A session with more tasks than fit in the
  `max-h-[74vh]` panel. Hold ArrowDown past the visible window: the highlight leaves
  the viewport with no feedback, and `K` then kills a task the user cannot see. Both
  sibling lists in this scope do the right thing —
  `CommandPalette.tsx:70-74` and `SlashCommandPicker.tsx:51-55` each run a
  `scrollIntoView({ block: 'nearest' })` effect keyed on the active index.
- **Fix**: Add the same `scrollIntoView` effect keyed on `selected` (mark rows with a
  `data-task-active` attribute), and give the list `role="listbox"` with
  `role="option"` + `aria-selected` rows.

### [MED] MentionPicker never scrolls its active row into view

- **Where**: `/Users/pt/cat-code/app/renderer/src/MentionPicker.tsx:104-141`
- **Type**: correctness
- **What**: The picker takes `activeIndex` from the consumer and renders it as a
  background tint, but its list is `max-h-60 overflow-y-auto` and there is no
  scroll-into-view. The consumer does not compensate either — `App.tsx:3686-3707`
  only calls `setMentionActiveIndex`.
- **Trigger / why it matters**: More than ~6 mention items (real agent rosters
  exceed this). ArrowDown past the sixth row leaves the highlight below the fold;
  Enter then inserts a mention the user could not see. Its direct sibling
  `SlashCommandPicker.tsx:51-55` implements exactly this and MentionPicker does not.
- **Fix**: Mirror `SlashCommandPicker`'s effect — a `listRef` plus
  `querySelector('[data-mention-active="true"]')?.scrollIntoView({ block: 'nearest' })`
  keyed on `[open, activeIndex]`.

### [MED] `isBypassPermissionsModeAvailable` crosses the wire and no renderer reads it

- **Where**: `/Users/pt/cat-code/app/renderer/src/PermissionModeChip.tsx:184-200`, `/Users/pt/cat-code/app/renderer/src/PermissionRulesEditor.tsx:206-232`; field at `app/shared/protocol.ts:654`, populated at `app/sidecar/sidecarServer.ts:3982`
- **Type**: dead-code / correctness
- **What**: The permission context snapshot carries
  `isBypassPermissionsModeAvailable`, and a repo-wide grep finds no renderer consumer
  (only tests and fixtures). Both mode pickers gate `auto` on
  `context.permissionClassifierEnabled` but offer `bypassPermissions`
  unconditionally. The engine itself treats this field as a gate
  (`src/bridge/replBridge.ts:186` says to check it *before* calling
  `transitionPermissionMode`; `src/utils/settings/applySettingsChange.ts:62`).
- **Trigger / why it matters**: On a machine where bypass is unavailable (managed
  policy / killswitch), the picker still shows an enabled "Bypass permissions" row.
  Clicking it round-trips a `permission.setMode` the sidecar will refuse, and the
  chip does not change — an affordance that looks live and does nothing, which is
  the exact failure mode `SAButton`'s disabled+reason idiom exists to prevent.
- **Fix**: Gate the `bypassPermissions` row the same way `auto` is gated, with the
  engine's own reason text.
- **Note**: both cited blocks sit in **uncommitted hunks** (`PermissionModeChip.tsx`
  `@@ -193,3 +188 @@`/`@@ -206,2 +198,0 @@`, `PermissionRulesEditor.tsx`
  `@@ -209,4 +209 @@`/`@@ -227,3 +224 @@`) — another session is mid-change there.

### [MED] Four copies of the same label tables, already drifted

- **Where**: `/Users/pt/cat-code/app/renderer/src/PermissionRulesEditor.tsx:17`, `:35`; `/Users/pt/cat-code/app/renderer/src/MetadataInspector.tsx:316`; `/Users/pt/cat-code/app/renderer/src/permissionPromptModel.ts:118`, `:138`; `/Users/pt/cat-code/app/renderer/src/PermissionModeChip.tsx:48`
- **Type**: design
- **What**: Permission-mode names and rule-source names are each duplicated across
  three or four modules, every copy carrying a comment justifying it with the Fast
  Refresh rule ("a renderer `.tsx` may export React components only"). The rule's
  own remedy — an adjacent `.ts` module — is not applied, even though
  `permissionPromptModel.ts` and `sessionInspectorState.ts` are already `.ts`
  modules imported by these very files.
- **Trigger / why it matters**: They have **already drifted**. For the same
  `permission.context` source token, `PermissionRulesEditor.RULE_SOURCE_LABEL` says
  `localSettings` → "private to you" and `projectSettings` → "this project", while
  `MetadataInspector.DIRECTORY_SOURCE_LABEL` says "your private settings" and "this
  project's settings" — and MetadataInspector's comment claims the map is
  "Duplicated from `PermissionRulesEditor`'s **identical** map". Both surfaces are
  reachable in one session, so the operator sees two vocabularies for one fact. Only
  `PermissionModeChip`'s copy has a compile-time tripwire (`satisfies Record<…>`);
  the two `Record<string, string>` copies have none.
- **Fix**: Move the source-label and mode-label tables into one `.ts` module
  (`permissionPromptModel.ts` already owns the mode names) typed as a total `Record`
  over the union, and import from all four call sites.

### [MED] PermissionRulesEditor leaks raw engine tokens into user-visible text and drops a union tripwire

- **Where**: `/Users/pt/cat-code/app/renderer/src/PermissionRulesEditor.tsx:26-28`, `:46-48`, `:51-55`, `:391`
- **Type**: convention
- **What**: `modeLabel` returns `MODE_LABEL[mode] ?? mode`, `ruleSourceLabel` returns
  `RULE_SOURCE_LABEL[source] ?? source`, and the rule row renders
  `MATCH_TYPE_LABEL[matchType] ?? matchType`. All three fall back to printing the
  engine's own token. Separately, `matchType` is a **closed union** on the wire
  (`'exact' | 'prefix' | 'wildcard'`, `app/shared/protocol.ts:647`) but
  `MATCH_TYPE_LABEL` is typed `Record<string, string>`, so a new match type compiles
  clean and ships its raw token to the page.
- **Trigger / why it matters**: Any source or mode not in the hand-written table
  renders as e.g. "(from flagSettings)" or "wildcardPrefix" — internal vocabulary
  on a user surface, which CLAUDE.md §7 forbids. `MetadataInspector.tsx:328` solves
  the same problem correctly (`?? 'another source'`) and its comment even calls out
  "instead of leaking the token", so the correct behavior is already established one
  file over.
- **Fix**: Fall back to a neutral phrase rather than the token, and type
  `MATCH_TYPE_LABEL` as a total `Record<PermissionContextSnapshot['ruleMetadata'][number]['matchType'], string>`
  so a new variant fails the build.
- **Note**: `MATCH_TYPE_LABEL` sits in an **uncommitted hunk** (`@@ -93 +93 @@`).

### [MED] The composer's two typeaheads are not wired as comboboxes

- **Where**: `/Users/pt/cat-code/app/renderer/src/ComposerInput.tsx:317-350`; `/Users/pt/cat-code/app/renderer/src/SlashCommandPicker.tsx:60-64`; `/Users/pt/cat-code/app/renderer/src/MentionPicker.tsx:66-70`
- **Type**: convention
- **What**: Both pickers render `role="listbox"` with `aria-selected` options while
  DOM focus stays in the composer, but the composer field carries no
  `aria-expanded`, `aria-controls`, or `aria-activedescendant`, so nothing links the
  focused textbox to the active option. `SlashCommandPicker` additionally labels its
  root `role="dialog"` (`:62`) while never receiving focus, trapping focus, or
  handling its own Escape — its keys all live in `App.tsx`.
- **Trigger / why it matters**: A screen-reader user typing `/he` or `@` gets no
  announcement of the filtered list or of which row Enter will insert, and the
  slash picker announces a dialog that never opens. The keyboard *works*; only the
  accessibility contract is missing.
- **Fix**: Put `aria-expanded` / `aria-controls` / `aria-activedescendant` on the
  composer's `role="textbox"` div, give each option a stable `id`, and change
  `SlashCommandPicker`'s root from `role="dialog"` to a plain container (its inner
  `<ul role="listbox">` is already correct).

### [LOW] Disabled session-action rows carry their reason only in a `title`

- **Where**: `/Users/pt/cat-code/app/renderer/src/SessionActionsMenu.tsx:322-338`
- **Type**: convention
- **What**: The inert `MenuRow` branch is a non-focusable `<div role="menuitem"
  aria-disabled="true" title={item.reason}>` with a visible `soon` tag but no
  accessible name carrying the reason.
- **Trigger / why it matters**: `SAModal.tsx:158-161` states the rule for this repo
  explicitly — "a bare `title` reaches only a hovering mouse" — and `SAButton`
  implements the three-channel fix (visible marker + `title` + `aria-label`). This
  row implements two of the three, so a keyboard or screen-reader user learns that
  Export is unavailable but never why.
- **Fix**: Add `aria-label={`${item.label}, ${item.reason}`}` to the disabled row,
  matching `SAButton`.

### [LOW] LeaseRosterPanel asserts a lease strategy it has not read

- **Where**: `/Users/pt/cat-code/app/renderer/src/TasksDialog.tsx:655-661`
- **Type**: correctness
- **What**: `{snapshot?.strategy ?? 'spread'}` renders the word "spread" in a
  semibold teal mono span, with no snapshot behind it.
- **Trigger / why it matters**: Open the Leases tab before `lease.snapshot` arrives
  (or on a session that never emits one) and the panel states "Subagent strategy
  this session: **spread**" as fact. This is the same absent-vs-default confusion
  `PermissionRulesEditor`'s `settingsLoaded` three-state exists to avoid, and the
  file's own header commits to real data only.
- **Fix**: Render the strategy line only when `snapshot` is non-null, or say the
  strategy has not been reported yet.

### [LOW] CommandPalette's `inputRef` is assigned and never read

- **Where**: `/Users/pt/cat-code/app/renderer/src/CommandPalette.tsx:41`, `:128`
- **Type**: dead-code
- **What**: `inputRef` is created and attached to the search input, but `.current` is
  never read anywhere. Initial focus comes from `useModalFocus`'s `focusFirst`, which
  finds the input on its own.
- **Trigger / why it matters**: A leftover ref reads as a focus mechanism that no
  longer exists, inviting a future edit to "restore" a second focus path that would
  fight `useModalFocus`.
- **Fix**: Delete the ref and its `ref=` attribute.

### [LOW] SlashCommandPicker's exported component carries another function's JSDoc

- **Where**: `/Users/pt/cat-code/app/renderer/src/SlashCommandPicker.tsx:27-34`
- **Type**: quality
- **What**: The doc block immediately above `export function SlashCommandPicker`
  describes a query extractor ("Extract the in-progress slash query from the
  composer draft, or `null` when the picker should be closed… Returns the text
  AFTER the slash"). That contract belongs to `parseSlashDraft`, which lives in a
  different module (`App.tsx:3656` imports it).
- **Trigger / why it matters**: The component's actual contract (`open`/`query`/
  `commands`/`activeIndex`/`onPick`, keys owned by the caller) is undocumented,
  while a return-value contract it does not have is documented in its place.
- **Fix**: Move the block to `parseSlashDraft` and describe the component.

### [LOW] SessionActionsMenu measures the viewport during render and never repositions

- **Where**: `/Users/pt/cat-code/app/renderer/src/SessionActionsMenu.tsx:53-57`, `:81-85`, `:184-188`
- **Type**: quality
- **What**: `readViewport()` reads `window.innerWidth/innerHeight` in the render
  body, and the resulting `placement` is baked into an inline `style`. Nothing
  recomputes it on resize or scroll.
- **Trigger / why it matters**: Open the ⋯ menu, then resize the window or scroll the
  session list underneath it — the panel stays at the stale coordinates, which is the
  clipping the P4-39 placement work exists to prevent. Reading `window` during render
  is also the kind of side effect the SSR fallback at `:54` is patching around.
- **Fix**: Compute placement in a layout effect (or on a resize/scroll listener while
  the menu is open) instead of during render.

### [LOW] PlanPanel's backdrop lacks the `role="presentation"` its siblings carry

- **Where**: `/Users/pt/cat-code/app/renderer/src/PlanPanel.tsx:136-140`
- **Type**: convention
- **What**: The scrim is a bare `<div className="fixed inset-0 …" onClick={onClose}>`
  with no `role` and no `aria-hidden`. `SAModal.tsx:81-84` and
  `TasksDialog.tsx:196-200` both use `role="presentation"` on the identical element,
  and `MetadataInspector.tsx:115-119` uses `aria-hidden="true"`.
- **Trigger / why it matters**: The scrim is exposed to assistive tech as an
  unlabeled clickable generic sitting over the dialog. Three of the four modals in
  this scope handle it; this one is the outlier.
- **Fix**: Add `role="presentation"` to match.

## What is good here

- **The permission boundary holds at the renderer, exactly as specified.**
  `buildPermissionOptions` (`permissionPromptModel.ts:273-302`) creates rule rows
  *only* where the engine minted a suggestion and carries nothing but
  `suggestionIndex`; `PermissionPrompt.pickAt` (`:223`) sends
  `[option.suggestionIndex]`; `buildAllowResponse` (`permissionState.ts:333-344`)
  emits `applySuggestions: number[]` plus an `updatedInput: {}` sentinel. No path
  constructs a `PermissionUpdate`. `PermissionRulesEditor` is read-only by
  construction and says so; the one interactive control emits `permission.setMode`.
  The chip shown on a suggestion row is the engine's own serialization, with a
  comment explaining why the prototype's client-side `scopeFromRule` was rejected.
- **No dismissal strands the engine.** "Keep pending" dispatches `dismissed`, which
  renders a "Snoozed … (still pending)" row with an **Answer** button
  (`PermissionQueue.tsx:88-106`), and `selectPendingPermissionCount`
  (`permissionState.ts:291-300`) filters on `submittedRequestIds`, not on dismissal,
  so a snoozed request still drives the tab badge. Double-answer is blocked twice:
  `respondToPermission` (`App.tsx:2269-2275`) refuses a second response for an
  already-submitted id, and both the mouse and keyboard paths bail on `submitted`.
- **`overlayFocus.ts` is a genuinely good shared primitive.** One stack arbitrates
  modals and popovers, `isBlockedByModal` lets a popover yield Escape to a modal
  opened on top of it, `resolveConnectedRestoreTarget` walks to a still-connected
  restore target instead of dropping focus to `<body>`, and `modalKeyAction` rejects
  Ctrl/Cmd/Alt+Tab so OS chords are not eaten by the focus trap. `TasksDialog`'s
  document-then-window listener ordering (its own handler checks `defaultPrevented`
  first) is the right way to layer a second key map under it.
- **Zero Tailwind dynamic-class hits, and the discipline is explicit.** Every tone,
  tint, and diff colour rides a static `Record` map (`PREVIEW_LINE_CLASS`,
  `TINT_CLASS`, `TAB_TONE_CLASS`, `MODE_META`, `BANNER_SOFT_TEXT`), several with a
  `satisfies Record<Union, …>` tripwire. The two inline `style` uses
  (`ComposerActionsBar.tsx:427` percent width, `SessionActionsMenu.tsx:108`/`:204`
  anchored geometry) are the two cases Tailwind genuinely cannot express and are
  tagged as §0 exceptions in place.
- **Untrusted text is handled consistently.** `PermissionPreviewBlock`,
  `MentionPicker`, `BannerStack`, and `ToastHost` each carry a note that
  model/status/path text renders as a text node only, and no branch anywhere in
  scope sets inner HTML or turns a model-supplied URL into a link.

## Not reviewed / uncertain

- **Runtime behavior was not exercised.** Per the contract I ran no app and no test
  suites, so the HIGH finding and the two scroll findings are traced through source
  (listener registration, propagation path, absence of a `scrollIntoView`) rather
  than reproduced. The repo's own note that `app/`'s renderer suite is SSR-only means
  these classes of bug are structurally invisible to it; a DOM harness pressing
  Escape in the composer with an `AskUserQuestion` pending would settle the HIGH
  finding in one test.
- **`ComposerActionsBar.tsx`, `PermissionModeChip.tsx`, and `PermissionRulesEditor.tsx`
  are dirty.** I reviewed what is on disk. Findings that touch uncommitted lines are
  flagged inline (the bypass gate and `MATCH_TYPE_LABEL`); nothing in
  `ComposerActionsBar`'s modified hunks (the context breakdown / usage panel, lines
  ~644-760 and ~891-925) produced a finding, but that code is mid-change and my read
  of it may not match where the owning session lands.
- **`isBypassPermissionsModeAvailable` on the sidecar side.**
  `app/sidecar/sessionController.ts:163` appears to set it to a literal `true` on one
  path while `sidecarServer.ts:3982` forwards the engine's real value. That is
  outside this scope; if the sidecar constant is the live path, gating the renderer
  on the field would be a no-op until it is fixed there too.
- **`MetadataInspector`'s rendered ids.** It prints session ids, frame UUIDs, request
  ids, and tool-use ids. I did not flag this against the "no engineering notes"
  convention because a metadata inspector labelled `read-only` is the one surface
  whose job is exactly that, but an operator ruling could disagree.
