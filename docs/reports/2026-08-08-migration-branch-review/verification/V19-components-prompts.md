# V19 adversarial validation: renderer components (A19) + prompts/policy (S08)

> **Verification provenance:** Claude Opus 5, high effort. Source review of every cited
> `file:line`; **five scratch Bun scripts** written to the scratchpad that import real repo
> modules and exercise the claimed behaviour directly. Three of them mount **real React 19
> components in a real DOM** (`happy-dom` installed into the scratchpad, never the repo;
> `react`/`react-dom` symlinked from `app/node_modules`) and dispatch **real
> `KeyboardEvent`s** — this is the DOM harness `X01`/`V29` say the package lacks, so the two
> keyboard findings are *reproduced*, not traced. Two more call the real `getSystemPrompt`,
> `getTools` and `initializeToolPermissionContext` under `CLAUDE_CODE_SIMPLE=1`.
> **No repo file was edited, no git write, no GUI, and no repo test file was executed.**
> Branch `migration` at `a1012b1`. Working tree dirty with other sessions' work, including
> `PermissionModeChip.tsx`, `PermissionRulesEditor.tsx`, `sessionController.ts` and
> `permissionDomain.ts` — which turns out to be decisive for one finding.

## Overall verdict

**A19 is substantially right, and its HIGH is worse than it claimed.** I reproduced the
`AskQuestionFlow` bug end to end in a real DOM: typing `ok 2 jobs` into the composer with a
question pending loses five of nine characters, Escape denies the request (twice under
StrictMode), and Enter sends the answer alongside the message. I also reproduced its sharpest
MED — with nothing painted, ArrowDown + Enter applies an **always-allow rule** the user was
never shown as selected. Both were traced-only in the original report; both now have a
runnable repro.

**But A19's `isBypassPermissionsModeAvailable` MED is INVALID at HEAD**, and it is the exact
shape this review set is hunting. A19 asserts "a repo-wide grep finds no renderer consumer"
and "both mode pickers offer `bypassPermissions` unconditionally". At `a1012b1` **both
pickers gate it** on that field, with reason text. The gates exist only as `-` lines in
another session's *uncommitted* diff. A19 flagged the file as dirty and still drew the
conclusion from the deletion. Applying its fix would revert a deliberate in-flight change.

**S08's HIGH is exactly right and I proved it verbatim**: the bare prompt is 59 bytes,
`"You are Cat Code.\n\nCWD: …\nDate: …"`, all seven named invariants plus the cyber policy
absent, tool list `["Bash","Read","Edit"]`. Two qualifications: the bare branch is
**pre-existing on `main`** (root commit `86051a8`) — the branch's new `corePolicy.ts` simply
did not extend to it — and I confirmed that `--tools ""`, the form CLAUDE.md §12 actually
documents, really does yield `[]`. S08's MED and both LOWs each have a valid core with a
refuted trigger.

The one thing that most deserves action is the `AskQuestionFlow` guard: one line, one
already-exported predicate (`permissionKeysAreLive`), and it closes a shipped
deny-by-keystroke.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| **A19** |||||
| A1 | HIGH | `AskQuestionFlow` window keydown hijacks the composer | **CONFIRMED** | Reproduced in a real DOM: Escape → deny, Enter → submit, `o`/`j`/`k`/digits swallowed |
| A2 | MED | `PermissionPrompt` acts on keys it does not advertise | **CONFIRMED** | Reproduced: nothing painted, ArrowDown+Enter fires `onAllow([0])` — the always-allow row |
| A3 | MED | `TasksDialog` selection never scrolled into view | **CONFIRMED** | Only 2 `scrollIntoView` sites in the renderer; neither is `TasksDialog` |
| A4 | MED | `MentionPicker` never scrolls its active row into view | **CONFIRMED** | `max-h-60 overflow-y-auto`, no scroll effect in picker or consumer |
| A5 | MED | `isBypassPermissionsModeAvailable` crosses the wire, no reader | **INVALID** | Both pickers read it at HEAD; the "no consumer" state is another session's uncommitted deletion |
| A6 | MED | Four copies of the same label tables, already drifted | **PARTIALLY CONFIRMED** | Drift is real and **three-way**, but two copies do carry total-`Record` tripwires |
| A7 | MED | `PermissionRulesEditor` leaks raw tokens, drops a tripwire | **OVERSTATED** | No fallback is reachable today; the cited example (`flagSettings`) *is* in the table |
| A8 | MED | Composer typeaheads are not wired as comboboxes | **CONFIRMED** | Zero `aria-expanded`/`-controls`/`-activedescendant` on the textbox; picker root is `role="dialog"` |
| A9 | LOW | Disabled session-action rows carry reason only in `title` | **CONFIRMED** | No `aria-label`/`describedby`; row also lacks `tabindex`, so roving nav skips it entirely |
| A10 | LOW | `LeaseRosterPanel` asserts a lease strategy it has not read | **PARTIALLY CONFIRMED** | Ungated fallback is real, but `'spread'` *is* the true engine default |
| A11 | LOW | `CommandPalette`'s `inputRef` assigned, never read | **CONFIRMED** | `.current` unread repo-wide; focus really comes from `focusFirst` |
| A12 | LOW | `SlashCommandPicker` carries another function's JSDoc | **CONFIRMED** | Doc describes `parseSlashDraft`, which lives in `slashCommandPickerModel.ts:3` |
| A13 | LOW | `SessionActionsMenu` measures viewport in render | **CONFIRMED** | Zero `resize`/`scroll` listeners in the entire renderer; the anchor rect is frozen too |
| A14 | LOW | `PlanPanel` backdrop lacks `role="presentation"` | **OVERSTATED** | `role="presentation"` on a `div` is a no-op; `aria-hidden` here would be a bug |
| **S08** |||||
| S1 | HIGH | `--bare` bypasses every policy invariant | **CONFIRMED** | 59-byte prompt printed verbatim; all 8 rules absent; tools `["Bash","Read","Edit"]` |
| S2 | MED | Apply_patch path rule missing in Agent Mode and REPL | **PARTIALLY CONFIRMED** | Agent-Mode leg confirmed and live; REPL leg needs an ant build this repo cannot produce |
| S3 | LOW | Output-style policy test exercises no output-style assembly | **PARTIALLY CONFIRMED** | Description right; the claimed missed mutation is caught by two other tests in the same file |
| S4 | LOW | Verification test proves wording removal, not behavior | **PARTIALLY CONFIRMED** | Wording-only assertion confirmed; the runtime nudge is dead code (`tengu_hive_evidence` can never be true) |

**Tally: 10 CONFIRMED · 5 PARTIALLY CONFIRMED · 2 OVERSTATED · 1 INVALID · 0 DUPLICATE · 0 UNPROVEN.**

---

## Per finding — A19

### A1 — [HIGH] AskQuestionFlow's window keydown hijacks the composer, denying or submitting the request

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes, verbatim. `AskQuestionFlow.tsx:150` is
  `if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return`; the listener is
  registered at `:199` (`window.addEventListener('keydown', onKeyDown)`); the Escape → `onCancel()`
  branch is `:152-156`, Enter → `advance()` `:157-161`, digits `:167-179`, `o`/`O` `:183-188`,
  `j`/`k` `:189-197`. `ComposerInput.tsx:325` is `contentEditable={editable}` on a
  `<div role="textbox">`. `App.tsx:4006` `onComposerKeyDown` is bound to the `<form>` at `:4352`
  and contains no `stopPropagation`.
- **Reachable in production?**: Yes, on the default path, with no flag.
  1. The flow mounts whenever `askQuestion` is non-null (`App.tsx:4284-4293`).
  2. The composer is editable at exactly that moment. `selectComposerGate`
     (`composerState.ts:450-486`) sets `editable = engineInputEnabled || connectPending ||
     turnPending`, and a pending `AskUserQuestion` is a `ready` connection with
     `inputEnabled: false` → `turnPending: true` → **editable**. `App.tsx:3792-3797` says so in
     its own words ("Typing and attaching are allowed in all three").
  3. React 19 delegates to the **root container** (`main.tsx:11,23` — `document.getElementById('root')`),
     which is a descendant of `window`. The native event continues bubbling to `window` after
     React's dispatch, and `preventDefault()` does not stop propagation.
- **Trigger**: An `AskUserQuestion` is pending on the active pane; the user clicks into the
  composer and types. Reproduced with a real React mount and real `KeyboardEvent`s:
  - `Escape` → `onCancel()` → `App.tsx:2687-2696` `buildDenyResponse('User declined to answer
    questions')`. Mid-turn the composer *also* runs `stopTurn()` first — both fire.
  - `Enter` → composer `requestSubmit()` **and** `onAnswer(...)` in the same keystroke.
  - `o` → `preventDefault()` + `setOtherActive(true)`, and the effect at `:75-77` **moves DOM
    focus out of the composer** into the freeform input mid-sentence.
  - typing `ok 2 jobs` loses `o`, `k`, `2`, `j`, `o` — five of nine characters.
- **Counter-arguments considered**:
  - *Is there an upstream guard?* No. I checked `isActivePane` (`:124` — true for the pane that
    owns the composer, so it does not help), `submitted` (false while the user is typing),
    `event.repeat/metaKey/altKey` (`:126` — a plain keystroke passes), and `inOurInput` (`:132`
    — false unless the freeform field is already open). There is **no** `event.defaultPrevented`
    check; I proved it by adding a capture-phase `preventDefault()` upstream and `onCancel`
    still fired.
  - *Does the composer's own handler stop it?* No. `onComposerKeyDown` calls `preventDefault()`
    on several branches and `stopPropagation()` on none; `rg -n stopPropagation` over the
    renderer returns 20 sites, none in the composer keydown path.
  - *Does the tag-name guard accidentally work?* No — decisive negative control: for the same
    element, `tagName === 'INPUT' || 'TEXTAREA'` is **false** while `isContentEditable` is
    **true**. The guard is the cause; swapping the predicate is the fix.
  - *Is the composer maybe a `<textarea>` after all?* No — `ComposerInput.tsx:1-15` explains it
    is a contentEditable div precisely so paste pills can be inline nodes; `composer.tagName`
    printed `DIV`.
- **True consequence**: A user typing a note while a question is pending can silently deny the
  request with Escape, silently answer it with Enter, and loses `o`/`j`/`k`/`1`-`9` from the
  draft along with their caret position. The deny is engine-visible and irreversible.
- **Evidence**: scratch `askflow.test.tsx` / `askflow2.test.tsx` (real React 19 + happy-dom):
  ```
  composer.tagName = DIV   composer.isContentEditable = true
  MID-TURN: ["composerForm:Escape","stopTurn()","onCancel(DENY)"]
  IDLE:     ["composerForm:Escape","onCancel(DENY)","onCancel(DENY)"]
  swallowed from draft = ["o","k","2","j","o"]
  ENTER: [...,"requestSubmit()","onAnswer:[{\"optionIndices\":[0]}]"]
  control — Escape from a real <input> = []          <-- guard works only for real inputs
  tagName guard bails = false | isContentEditable guard bails = true
  ```
  Source: `AskQuestionFlow.tsx:150,199`; `ComposerInput.tsx:325`; `App.tsx:2687-2696,3792-3797,4006,4352`;
  `composerState.ts:450-486`; `main.tsx:11,23`.
- **Disposition**: Apply A19's fix, and prefer `V29`'s framing of it. Replace the tag-name test
  with `permissionKeysAreLive(event.target)` (`permissionPromptModel.ts:106` — its
  `FOCUSED_KEY_OWNER_SELECTOR` already lists `[contenteditable]` and uses `closest`, so it also
  covers a click inside a pill), and add `if (event.defaultPrevented) return` at the top. Then
  do the extraction `V29` recommends: lift `:125-198` into
  `askQuestionFlowModel.ts` as a pure `askQuestionKeyIntent(event, target)` mirroring
  `permissionKeyIntent`, so the fix is pinned by a unit test rather than by a DOM harness the
  package does not have. One caveat A19 did not raise: the effect at `:119-201` has **no
  dependency array**, so it re-registers on every render; that is harmless (cleanup runs) but
  it means the extraction cannot memoise the handler without adding one.

### A2 — [MED] PermissionPrompt acts on keys it is not advertising, so an unseen row can be confirmed

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `PermissionPrompt.tsx:250` is
  `if (!permissionKeysAreLive(event.target)) return`; `:294-302` derives `hintVisible` and
  `activeIndex` from `keyboardTarget === true && keysLive`; `:183-211` is the focus effect whose
  `isEditableElement(previous)` branch sets `keysLive` from the composer and returns; the
  hover-gate comment is at `:412-419`.
- **Reachable in production?**: Yes. `keysLive` is re-derived in exactly three places — the
  effect (deps `[keyboardTarget]`), and the section's own `onFocus`/`onBlur` (`:311-312`), which
  only fire for focus events **inside the card**. The listener is independent, on `document`
  (`:290`), and consults `permissionKeysAreLive(event.target)` live.
- **Trigger**: Reproduced. The card mounts while the composer holds focus →
  `permissionKeysAreLive(composer)` is false (its `closest('[contenteditable]')` is the composer,
  which lacks `PERMISSION_KEY_HOST_ATTR`) → `keysLive = false`, no hint, no highlight. The user
  then clicks a non-focusable area, so `document.activeElement` becomes `<body>`. No focus event
  reaches the card, so `keysLive` stays `false` — but `permissionKeysAreLive(document.body)`
  returns **`true`** (body matches no `FOCUSED_KEY_OWNER_SELECTOR` entry). ArrowDown then walks
  `cursor` with `activeIndex === undefined` (nothing painted) and Enter runs
  `pickAt(Math.min(cursor, count-1))`.
- **Counter-arguments considered**:
  - *Is the listener's behaviour on `<body>` a bug?* **No, and this matters for the fix.**
    `permissionKeysAreLive`'s own doc (`:95-105`) states keys are deliberately live when focus is
    "on nothing element-like". The listener is correct; the **paint** is the half that fails to
    follow. A19's first proposed fix ("bail when `!keysLive` for `confirm`/`pick`") would break
    the intended focus-on-nothing case.
  - *Does the card's `onBlur` catch the composer losing focus?* No — React `onBlur` is
    `focusout`, which only bubbles within the card's subtree; the composer is outside it.
  - *Does something else re-run the effect?* Its deps are `[keyboardTarget]`, which does not
    change on a focus move.
  - *Is the reachable row harmless?* No — with one engine suggestion the options are
    `[allow, rule-0, deny]`, so a single ArrowDown lands on the always-allow row.
- **True consequence**: With no hint and no highlight on screen, Enter can apply an
  always-allow rule (`applySuggestions: [0]`) the user was never shown as selected — the exact
  invariant `:412-419` gates the hover path for.
- **Evidence**: scratch `permprompt.test.tsx`, real `PermissionPrompt` mount with one
  `addRules` suggestion:
  ```
  composer focused: calls after Enter = []                        <-- designed case OK
  activeElement = BODY   permissionKeysAreLive(document.body) = true
  hint painted = false | highlight painted = false
  after ArrowDown, highlight painted = false
  calls after ArrowDown+Enter = ["onAllow:[0]"]                   <-- always-allow, unpainted
  ```
- **Disposition**: Take A19's **second** option only — re-derive `keysLive` from focus, not
  from the handler. Concretely: add a `focusin`/`focusout` listener on `document` while
  `keyboardTarget` is true that runs `setKeysLive(permissionKeysAreLive(document.activeElement))`.
  Do **not** gate the listener on `keysLive` (A19's first option): that would kill the
  intentional focus-on-nothing path and make the shortcuts unreachable after any background
  click.

### A3 — [MED] TasksDialog's keyboard selection is never scrolled into view, so `K` can stop an unseen task

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `TasksDialog.tsx:161-181` moves `selected` and runs
  `stoppableTaskIdAt(flat, selected)` for `K`; the panel is `max-h-[74vh] … overflow-hidden`
  (`:203`) with an `overflow-y-auto` body (`:257`); `TaskRow` (`:793-...`) is a plain `<div>`
  whose only selection signal is `bg-shell-active`.
- **Reachable in production?**: Yes — the listener is `window`-level (`:182-183`), gated only on
  `open` and `tab === 'tasks'`.
- **Trigger**: More tasks than fit in `74vh`. Hold ArrowDown; `selected` walks past the visible
  window with no scroll, then `K` stops `stoppableTaskIdAt(flat, selected)`.
- **Counter-arguments considered**: (a) *Native scroll from focus?* No — `TaskRow` is a
  non-focusable `div`; nothing calls `.focus()` on it. (b) *Is `scrollIntoView` provided by a
  shared helper?* No: `rg -n scrollIntoView app/renderer/src --glob '!*.test.*'` returns
  **exactly two** hits, `SlashCommandPicker.tsx:54` and `CommandPalette.tsx:73`. The sibling
  comparison A19 draws is exact. (c) *Is `K` guarded?* Only by `stoppableTaskIdAt` returning a
  non-terminal id — it does not care whether the row is visible.
- **True consequence**: A destructive action (stop task) can address a row outside the
  viewport, with the a11y contract (`role="listbox"`/`option`/`aria-selected`) also absent so a
  screen reader gets no announcement either.
- **Evidence**: `TasksDialog.tsx:161-183,203,257,793+`; `SlashCommandPicker.tsx:51-55`;
  `CommandPalette.tsx:70-74`.
- **Disposition**: Apply as written. Add the `scrollIntoView({block:'nearest'})` effect keyed on
  `selected` behind a `data-task-active` attribute, and add `role="listbox"` +
  `role="option"`/`aria-selected`. The `role` half is the cheaper and more valuable one: it is
  what makes the selection perceivable at all, not just scrolled to.

### A4 — [MED] MentionPicker never scrolls its active row into view

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `MentionPicker.tsx:104` opens the
  `max-h-60 overflow-y-auto` list; rows at `:114-141` carry `role="option"` and
  `aria-selected={index === activeIndex}` plus a `bg-white/[0.04]` tint, and there is no
  `scrollIntoView` and no `data-mention-active` hook. The consumer at `App.tsx:3686-3707` only
  calls `setMentionActiveIndex`.
- **Reachable in production?**: Yes. `mentionOpen` requires only a parsed `@` query with at
  least one match (`App.tsx:3691-3692`).
- **Trigger**: `max-h-60` is 240px against ~40px rows, so roughly six rows are visible. Arrow
  past the sixth and the highlight is below the fold; Enter inserts an unseen mention.
- **Counter-arguments considered**: (a) *Does focus scroll it?* No — DOM focus deliberately
  stays in the composer (the whole point of the typeahead), so the buttons never receive focus
  and never trigger native scroll-into-view. (b) *Does the consumer compensate?* No — I read
  `App.tsx:3686-3707` and `pickMention`; neither touches scroll. (c) *Is the list ever short
  enough to be moot?* No — the mention roster is agents plus files, routinely over six.
- **True consequence**: Same class as A3 but non-destructive: Enter inserts a mention the user
  could not see. Its direct sibling `SlashCommandPicker.tsx:51-55` implements the missing
  effect, so the fix already has a template in the same folder.
- **Disposition**: Apply as written. Mirror `SlashCommandPicker`'s `listRef` +
  `querySelector('[data-mention-active="true"]')?.scrollIntoView({block:'nearest'})` keyed on
  `[open, activeIndex]`.

### A5 — [MED] `isBypassPermissionsModeAvailable` crosses the wire and no renderer reads it

- **Verdict**: **INVALID** (at HEAD). The finding describes another session's uncommitted deletion.
- **Cited location holds?**: **No, not at `a1012b1`.** `git diff` shows both cited blocks are
  hunks that **remove** the reader:
  - `PermissionModeChip.tsx:185-196` at HEAD:
    `const unavailable = (mode === 'auto' && !context.permissionClassifierEnabled) || (mode ===
    'bypassPermissions' && !context.isBypassPermissionsModeAvailable)`, with the disabled-reason
    `'Bypass mode has to be turned on when Cat Code starts. Enable it from the command line, then
    open a new session.'`
  - `PermissionRulesEditor.tsx:206-232` at HEAD: the same two-clause `unavailable`, with
    `'Bypass mode has to be turned on when Cat Code starts.'`
  Both `-` blocks; the `+` blocks reduce `unavailable` to the `auto` clause alone.
- **Reachable in production?**: The *claimed* state is not reachable from HEAD at all. The
  producer is also being changed in the same wave: `sessionController.ts:158-170` at HEAD is
  `isBypassPermissionsModeAvailable: process.env.CATCODE_ALLOW_BYPASS === '1'` (false by
  default, per PERMISSION-BOUNDARY.md §3); the working tree replaces it with a literal `true`.
  `permissionDomain.ts:100` is having its comment rewritten from "reaches here only when the
  trusted launch flag enabled it" to "only after the user selects it in the app". This is one
  coherent in-flight change: *bypass becomes a directly available desktop mode.*
- **Trigger**: None at HEAD. A19's stated trigger — "Clicking it round-trips a
  `permission.setMode` the sidecar will refuse, and the chip does not change" — is **doubly
  wrong**: at HEAD the row is `disabled`, so it cannot be clicked; and if it could be, the
  sidecar would **not** refuse (see the missed finding below).
- **Counter-arguments considered**: I checked whether A19 might be right about a *third*
  surface — `rg -n isBypassPermissionsModeAvailable app/ src/` returns, in `app/renderer`,
  only the two pickers (dirty) and five `*.test.tsx` fixtures. So at HEAD there are exactly two
  readers and both are the ones A19 says do not exist. I also checked A19's own hedge: it does
  cite the hunk headers in a `Note`, and its "Not reviewed" section flags
  `sessionController.ts:163`. It saw the evidence and still drew the conclusion from the
  post-deletion tree.
- **True consequence**: No defect at HEAD. Applying A19's fix ("gate the `bypassPermissions`
  row the same way `auto` is gated") would re-add code the owning session is deliberately
  removing, and would collide with `protocol.ts:91-92` and `:2796-2797` — **committed at
  HEAD** — which already state "`bypassPermissions` is available directly in the app mode
  picker; the engine's own bypass killswitch remains authoritative".
- **Evidence**: `git diff app/renderer/src/PermissionModeChip.tsx`,
  `git diff app/renderer/src/PermissionRulesEditor.tsx`,
  `git diff app/sidecar/sessionController.ts`, `git diff app/sidecar/permissionDomain.ts`;
  `app/shared/protocol.ts:91-92,2796-2797` (clean).
- **Disposition**: **Do not apply.** Withdraw the finding. The real question this area raises
  is the unenforced boundary, which is a separate defect — see "Findings the original report
  missed" below. Process note for the review set: this is the second instance in `A19` of a
  conclusion drawn from a dirty hunk; findings that touch uncommitted lines should be scored
  against `git show HEAD:<file>`, not against the tree.

### A6 — [MED] Four copies of the same label tables, already drifted

- **Verdict**: **PARTIALLY CONFIRMED** — the drift is real and **worse** than described; the
  tripwire claim is wrong.
- **Cited location holds?**: Yes, all six tables are where A19 says
  (`PermissionRulesEditor.tsx:17,35`; `MetadataInspector.tsx:316`;
  `permissionPromptModel.ts:118,138`; `PermissionModeChip.tsx:48`).
- **Reachable in production?**: Yes — all four surfaces render in one session.
- **Trigger**: The drift is **three-way**, not two-way. For the same engine source token:

  | token | `PermissionRulesEditor` | `MetadataInspector` | `permissionPromptModel` |
  |---|---|---|---|
  | `localSettings` | "private to you" | "your private settings" | "Project settings (local)" |
  | `projectSettings` | "this project" | "this project's settings" | "Project settings" |

  And for modes: `PermissionRulesEditor` says `default` → "Ask", `bypassPermissions` →
  "Bypass"; `permissionPromptModel` says "Ask permissions" / "Bypass permissions";
  `PermissionModeChip` carries both (`label` vs `title`). `MetadataInspector.tsx:310-315`'s
  comment claiming the map is "Duplicated from `PermissionRulesEditor`'s **identical** map" is
  **false as written**.
- **Counter-arguments considered**:
  - *Is the Fast Refresh justification sound?* It is real (CLAUDE.md §7 and
    `lint:fast-refresh`), but it argues for the `.ts` module A19 prescribes, not for copying —
    and `permissionPromptModel.ts` and `sessionInspectorState.ts` are already `.ts` and already
    imported by these files, so there is no obstacle.
  - *"Only `PermissionModeChip`'s copy has a compile-time tripwire"* — **false.**
    `permissionPromptModel.ts:118` is `Record<PermissionUpdate['destination'], string>` and
    `:138` is `Record<SuggestionMode, string>`, both **total** records whose own doc comment
    says "The total `Record` is the tripwire". Three of the six tables are typed; the untyped
    ones are `PermissionRulesEditor`'s three (`Record<string, string>`) and
    `MetadataInspector`'s one.
- **True consequence**: One operator sees three vocabularies for one fact, and a source
  comment asserts an identity that does not hold. The typing gap is narrower than claimed but
  is concentrated in the one file that is also A7's subject.
- **Evidence**: `PermissionRulesEditor.tsx:17-24,35-43,49-53`; `MetadataInspector.tsx:310-329`;
  `permissionPromptModel.ts:115-143`; `PermissionModeChip.tsx:47-95`.
- **Disposition**: Apply A19's fix, with a correction to its ordering. Move the **source**
  labels into one `.ts` module first — that is where the user-visible drift is — and pick
  `MetadataInspector`'s wording, which is the fuller phrasing and already has the correct
  neutral fallback. Fix the false "identical map" comment in the same edit. The **mode** labels
  are a second, smaller pass and are partly intentional (a chip `label` is shorter than a menu
  `title`), so do not collapse them blindly.

### A7 — [MED] PermissionRulesEditor leaks raw engine tokens into user-visible text and drops a union tripwire

- **Verdict**: **OVERSTATED**
- **Cited location holds?**: Yes. `PermissionRulesEditor.tsx:26-28` `modeLabel` → `?? mode`;
  `:46-48` `ruleSourceLabel` → `?? source`; `:51-55` `MATCH_TYPE_LABEL: Record<string, string>`;
  `:391` renders `MATCH_TYPE_LABEL[matchType] ?? matchType`. `app/shared/protocol.ts:647` is
  `matchType: 'exact' | 'prefix' | 'wildcard'`.
- **Reachable in production?**: **No — not one of the three fallbacks can fire today.** I
  checked each against its real union:
  - `RULE_SOURCE_LABEL` covers **all eight** members of `PermissionRuleSource`
    (`src/types/permissions.ts:54-62`: userSettings, projectSettings, localSettings,
    flagSettings, policySettings, cliArg, command, session).
  - `MODE_LABEL` covers **all six** members of `PERMISSION_SET_MODE_MODES`
    (`protocol.ts:99-106`).
  - `MATCH_TYPE_LABEL` covers **all three** members of the wire union.
- **Trigger**: None exists. A19's own worked example refutes it: it predicts "(from
  flagSettings)", but `flagSettings` **is** in the table, mapped to "a launch flag". Its other
  example, "wildcardPrefix", is not a wire value.
- **Counter-arguments considered**: (a) *Is the wire type open?* Yes — `protocol.ts:645` types
  `source` as bare `string`, so a future engine source would leak. That makes this a **latent**
  defect, not a live one. (b) *Is the tripwire gap real?* Yes, and it is the salvageable half:
  `matchType` is a closed union on the wire but `Record<string, string>` in the renderer, so
  adding a fourth match type compiles clean and ships the token. (c) *Is
  `MetadataInspector.tsx:328` really the correct model?* Yes — `?? 'another source'`, with a
  comment naming the reason.
- **True consequence**: No user today can see a raw engine token from this file. The real,
  smaller finding is a missing compile-time tripwire on `MATCH_TYPE_LABEL` plus three
  token-shaped fallbacks that would become user-visible the first time the engine adds a
  variant.
- **Evidence**: `PermissionRulesEditor.tsx:17-55,391`; `src/types/permissions.ts:54-62`;
  `app/shared/protocol.ts:99-106,643-648`; `MetadataInspector.tsx:328`.
- **Disposition**: Apply the **typing** half of A19's fix and drop the urgency. Type
  `MATCH_TYPE_LABEL` as a total `Record` over the wire union so a new variant fails the build —
  that is the change with actual protection value. Change the three `?? token` fallbacks to
  neutral phrases as a convention cleanup, but do not report it as a live §7 violation, because
  it is not one. Note the `MATCH_TYPE_LABEL` block sits one line above an uncommitted hunk
  (`@@ -90,7 +90,7 @@`), so coordinate with the owning session.

### A8 — [MED] The composer's two typeaheads are not wired as comboboxes

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. The composer field (`ComposerInput.tsx:317-350`) carries
  `role="textbox"`, `aria-multiline`, `aria-label`, `aria-placeholder`, `aria-readonly`,
  `aria-disabled` — and none of `aria-expanded`, `aria-controls`, `aria-activedescendant`.
  `SlashCommandPicker.tsx:59-64` roots at `role="dialog" aria-label="Slash commands"`;
  `MentionPicker.tsx:66-70` roots at `role="listbox" aria-label="Mentions"` with
  `role="option"` + `aria-selected` rows (`:114-118`).
- **Reachable in production?**: Yes, on every `/` or `@` in the composer.
- **Trigger**: A screen-reader user types `/he`. The filtered list renders and the active row
  changes, but the focused textbox announces nothing: with no `aria-activedescendant` there is
  no link from the focused element to the active option, and with no `aria-expanded` there is
  no announcement that a list opened. `SlashCommandPicker` additionally announces a *dialog*
  that never takes focus, never traps it, and handles no Escape of its own (its keys all live in
  `App.tsx:4016-4045`).
- **Counter-arguments considered**: (a) *Does an `aria-live` region compensate?* No —
  `rg -n 'aria-live' app/renderer/src` finds none on these surfaces. (b) *Is `role="dialog"`
  defensible as "a floating panel"?* No: a dialog implies focus management the component does
  not do, and its inner `<ul role="listbox">` is already the correct construct.
  (c) *Does the keyboard actually work?* Yes — this is a pure a11y-contract finding, exactly as
  A19 scopes it, not a functional one.
- **True consequence**: Both typeaheads are operable by sighted keyboard users and effectively
  invisible to assistive tech; the slash picker also mis-announces its own nature.
- **Evidence**: `ComposerInput.tsx:317-350`; `SlashCommandPicker.tsx:59-64`;
  `MentionPicker.tsx:66-70,114-118`; `App.tsx:4016-4045,4352`.
- **Disposition**: Apply as written. `aria-expanded`/`aria-controls`/`aria-activedescendant`
  on the textbox, stable `id`s on options, and demote `SlashCommandPicker`'s root from
  `role="dialog"` to a plain container. Sequence it **after** A1: both edits touch the composer's
  keyboard/ARIA surface, and A1 is the one with a user-visible bug behind it.

### A9 — [LOW] Disabled session-action rows carry their reason only in a `title`

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `SessionActionsMenu.tsx:322` is `if (!item.enabled) {`; the
  inert element (`:324-338`) is
  `<div role="menuitem" aria-disabled="true" title={item.reason} …>` with an `aria-hidden`
  icon, the label, and a literal `soon`. No `aria-label`, no `aria-describedby`, no
  visually-hidden text. `SAModal.tsx:158-161` carries the rule verbatim ("a bare `title`
  reaches only a hovering mouse") and `SAModal.tsx:185` implements the three-channel fix
  (`{...(explained ? { title: reason, 'aria-label': \`${label}, ${reason}\` } : {})}`).
- **Reachable in production?**: Yes; the file is branch-new and committed (not dirty).
- **Trigger**: Open the ⋯ menu on a session with a disabled action. A mouse user hovering gets
  the reason; nobody else does.
- **Counter-arguments considered**: (a) *Is the reason surfaced visually?* Only as the word
  `soon`, which states that it is unavailable, not why. (b) *Is `reason` always present?* No —
  it is optional (`sessionActions.ts:84`), so `title` can be `undefined`; that narrows the blast
  radius but does not change the shape. (c) **A guard that makes it slightly worse, which A19
  missed:** `overlayFocus.ts:20-25`'s `MENU_ITEM_SELECTOR` requires
  `[role="menuitem"][tabindex]:not([tabindex="-1"])`, and this div has no `tabIndex`, so the
  roving-key handler skips the row entirely — a keyboard user never lands on it at all.
  (d) *Is the current behaviour pinned?* Yes — `SessionActionsMenu.test.tsx:131-136` asserts
  "reason rides the disabled row's title attribute", so the fix must update that test.
- **True consequence**: Mouse-hover-only reason on a row that keyboard navigation already
  skips. Correctly rated LOW.
- **Disposition**: Apply as written (`aria-label={`${item.label}, ${item.reason}`}`), and
  update `SessionActionsMenu.test.tsx:131-136` in the same change. Optionally add
  `tabIndex={-1}`… **no** — that would still be excluded by the selector; if the row should be
  reachable, it needs `tabIndex={0}` plus an inert click handler, which is a bigger decision
  than this finding justifies. Ship the `aria-label` only.

### A10 — [LOW] LeaseRosterPanel asserts a lease strategy it has not read

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes, off by one at the top — the sentence starts at
  `TasksDialog.tsx:656`, and `:658` is `{snapshot?.strategy ?? 'spread'}` inside a
  `font-mono font-semibold text-teal-300` span.
- **Reachable in production?**: Yes. `TasksDialog.tsx:268` renders
  `<LeaseRosterPanel nowMs={now} snapshot={leases} />` whenever `tab === 'leases'`, and `leases`
  defaults to `null` (`:100`). There is no `{snapshot ? … : …}` and no early return. Three
  proven no-snapshot paths: no lease domain (`sidecarServer.test.ts:6448`), a lease read that
  throws (`:6455-6470`), and a `lifecycle` frame clearing the snapshot
  (`leaseState.ts:41-46`).
- **Trigger**: Open the Leases tab before `lease.snapshot` arrives.
- **Counter-arguments considered**: **The decisive one lands on severity.** `'spread'` is the
  genuine engine default —
  `src/services/api/codexAccountLeaseManager.ts:593-599`
  `return getInitialSettings().codexSubagentAccountStrategy ?? 'spread'` for non-`main` owners,
  documented as "default: spread" in `src/utils/settings/types.ts:333-338`. So the panel is
  **correct in the default configuration** and wrong only for an operator who set
  `codexSubagentAccountStrategy: 'follow-main'`. The behaviour is also deliberate and pinned:
  `TasksDialog.test.tsx:471-477` — "The default strategy is stated rather than left blank."
- **True consequence**: A stated-as-fact default that is right for most operators and wrong for
  one non-default setting, in three degraded paths. Real absent-vs-default confusion, much
  narrower than "asserts a strategy it has not read" implies.
- **Disposition**: Apply the *weaker* of A19's two options — keep the line, but mark it as a
  default rather than a reading (e.g. render the strategy only when `snapshot` is non-null and
  otherwise say the strategy has not been reported yet). Note the existing test encodes the
  opposite intent, so this needs an operator ruling, not a silent flip. Given `'spread'` is
  genuinely correct by default, this is defensible as-is and is the lowest-value item in the set.

### A11 — [LOW] CommandPalette's `inputRef` is assigned and never read

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes — `CommandPalette.tsx:41` declares it, `:128` attaches it.
- **Reachable in production?**: N/A (dead code).
- **Trigger**: `rg -n 'inputRef' app/renderer/src` shows `.current` read only in
  `SessionActionsMenu.tsx:169,178,179,211` — a **different** ref that is genuinely used. In
  `CommandPalette.tsx`, `.current` is never read, the ref is in no dependency array, is not
  passed to a helper and is not forwarded; it is a component-local `const`, so no external
  reader is possible.
- **Counter-arguments considered**: (a) *Does it silence an unused-variable error?* No —
  `app/tsconfig.json` does not set `noUnusedLocals`, and line 128 would count as a use anyway.
  (b) *Is initial focus really `focusFirst`?* Yes — `useModalFocus` (`overlayFocus.ts:268-303`)
  defaults `initialFocus = 'first'` and calls `focusFirst(container, FOCUSABLE_ELEMENT_SELECTOR,
  true)` at `:302`; inside `dialogRef` the `SearchIcon` `<svg>` is not focusable, so the
  `<input>` at `:127-135` is the first match.
- **True consequence**: Two dead lines, zero behaviour. The cost is the misleading signal A19
  names.
- **Disposition**: Apply as written (delete the ref and its `ref=`).

### A12 — [LOW] SlashCommandPicker's exported component carries another function's JSDoc

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `SlashCommandPicker.tsx:27-34` is a doc block ending
  "Returns the text AFTER the slash (possibly empty for a bare `/`)" sitting immediately above
  `export function SlashCommandPicker({` at `:35` — a component that returns JSX and has no
  return value of that shape.
- **Reachable in production?**: N/A (comment only). CLAUDE.md §7 explicitly exempts code
  comments from the user-visible-text rules, so this touches no gate.
- **Trigger**: The contract described belongs to `parseSlashDraft`, which lives in
  `app/renderer/src/slashCommandPickerModel.ts:3`; `App.tsx:111` imports it and `:3656` calls it.
- **Counter-arguments considered**: (a) *Could it belong to something else in the file?* No —
  the file's module doc is `:1-22`, and the only other declaration after `:24` is `listRef`
  (`:48`). (b) *Was the extraction recent enough that this is a known-transient?* The subject
  moved to a `.ts` module (the Fast Refresh remedy), and the prose stayed; nothing marks it
  transitional.
- **True consequence**: The component's real contract (`open`/`query`/`commands`/`activeIndex`/
  `onPick`, keys owned by the caller) is undocumented while a contract it does not have sits in
  its place.
- **Disposition**: Apply as written — move the block to `parseSlashDraft` and write the
  component's own contract. Free, and it removes a trap for the next reader of A8's fix.

### A13 — [LOW] SessionActionsMenu measures the viewport during render and never repositions

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `readViewport()` at `:53-57` reads
  `window.innerWidth/innerHeight`; it is called **in the render body** at `:83` (menu) and
  `:186` (rename popover); the results are baked into inline `style` at `:108-112` and
  `:204-208`.
- **Reachable in production?**: Yes; branch-new, committed.
- **Trigger**: Open the ⋯ menu, then resize the window.
- **Counter-arguments considered**, all failed:
  - `rg "'resize'|'scroll'" app/renderer/src/*.ts*` → **zero** hits in the entire renderer.
  - `overlayFocus.ts`'s `usePopoverFocus` registers only `keydown` (`:405`) plus an rAF focus
    call — no resize, scroll or blur.
  - `composerPopover.ts` has no `innerWidth`/`innerHeight`/`resize`, and `SessionActionsMenu`
    does not import it anyway (`:25-44`).
  - No remount `key` at the call site (`App.tsx:2979`).
  - **Stronger than A19 claims:** a re-render would not fix it either. The anchor rect is
    frozen at open time (`TabBar.tsx:324`, `SessionsPage.tsx:717,797,971` all capture
    `event.currentTarget.getBoundingClientRect()` into state), so recomputation without
    re-measurement would place against a stale rect.
  - **A mitigation A19 omits, and it is why LOW is right:** the scrim at `:89-97` is
    `fixed inset-0 z-[70]` with `onClick`/`onContextMenu` → `onClose`, so the list underneath
    cannot scroll out from under an open menu, and any click dismisses it. The only live
    trigger is a window resize with the menu open.
- **True consequence**: A resize with the menu open leaves it at stale coordinates —
  the clipping the P4-39 placement work exists to prevent — plus an impure render that would
  misbehave under concurrent rendering.
- **Disposition**: Apply A19's fix but pair it with re-measurement, not just relocation:
  compute placement in a layout effect that **re-reads the anchor rect**, and register a
  `resize` listener only while the menu is open. Fixing the render purity without re-measuring
  the anchor would leave the bug in place.

### A14 — [LOW] PlanPanel's backdrop lacks the `role="presentation"` its siblings carry

- **Verdict**: **OVERSTATED**
- **Cited location holds?**: Literally yes — `PlanPanel.tsx:137-140` is a bare
  `<div className="fixed inset-0 …" onClick={onClose}>` with no `role` and no `aria-hidden`,
  and the three comparators are as described (`SAModal.tsx:82-84` and `TasksDialog.tsx:197-199`
  `role="presentation"`; `MetadataInspector.tsx:116-118` `aria-hidden="true"`).
- **Reachable in production?**: The element renders; the *defect* does not exist.
- **Trigger**: None. `role="presentation"` on a plain `<div>` is a **no-op**: a `div` already
  maps to `generic` with no accessible name, so the accessibility tree is byte-identical with
  and without it. A19's stated consequence — "exposed to assistive tech as an unlabeled
  clickable generic" — is equally true after its own fix.
- **Counter-arguments considered**: **The finding conflates two structurally different
  scrims.** Surveying every `fixed inset-0` overlay in the renderer:
  - *Wrapper* scrims (the dialog is a **child**): `SAModal:82`, `TasksDialog:197` carry
    `role="presentation"`; `PlanPanel:138` and `CommandPalette:113` carry nothing.
  - *Sibling* scrims (the dialog is a **sibling**): `MetadataInspector:116`, `Sidebar:1136`,
    `SessionActionsMenu:90,192`, `SessionsPage:297,1052` — **6 of 6** carry `aria-hidden="true"`.

  So half of A19's prescription is impossible: `aria-hidden` on `PlanPanel`'s scrim would hide
  the dialog it wraps, and `overlayFocus.ts:44` (`closest('[hidden],[inert],[aria-hidden="true"]')`)
  would then treat every control inside as unfocusable, **breaking the Tab trap**. PlanPanel is
  also not the outlier: `CommandPalette.tsx:113-115` has the same shape and the same absence.
- **True consequence**: A code-consistency nit across 2 of 4 wrapper scrims, with no
  accessibility effect. Verified PlanPanel is not inside an `inert`/`aria-hidden` subtree (it
  renders at `App.tsx:4256`; the renderer's only `inert` is `Sidebar.tsx:1014`).
- **Disposition**: Add `role="presentation"` to `PlanPanel:138` **and** `CommandPalette:113`
  for consistency if you are in the file anyway, but do not justify it as an a11y fix and do
  not add `aria-hidden` to either. A far better use of the same attention, verified in passing:
  `AgentsPage.tsx:274-277` is a scrim built as `<button className="fixed inset-0 …">` with no
  `aria-label` and no `aria-hidden` — an unnamed focusable control in the tab order, a strictly
  worse instance of this family that this review did not flag.

### A19's "What is good here" — re-derived

Both load-bearing clean bills **hold**, and I derived them independently rather than
re-reading the report's citations.

**The permission boundary — CONFIRMED.** `buildPermissionOptions`
(`permissionPromptModel.ts:273-302`) creates a rule row only where the engine minted a
suggestion and carries nothing but `suggestionIndex`; `pickAt` (`PermissionPrompt.tsx:215-224`)
sends `[option.suggestionIndex]`; `buildAllowResponse` (`permissionState.ts:333-344`) emits
`applySuggestions: number[]` plus the `updatedInput: {}` sentinel. The decisive negative check:
`rg -n 'PermissionUpdate|updatedPermissions|ruleContent|ruleValue' app/renderer/src --glob
'!*.test.*'` shows `PermissionUpdate` used **only as a type** for labelling and reading
(`permissionPromptModel.ts:118,126,136,146,154,182,201`), and `ruleContent` read exactly once,
in `formatRules` (`:149`), for display. **No renderer path constructs a rule object.** The
sidecar re-validates the indices at `sidecarServer.ts:4039-4084` (allow-only, array-only,
`MAX_SUGGESTION_SELECTIONS` cap, in-range, no duplicates). Boundary intact.

**No dismissal strands the engine — CONFIRMED.** "Keep pending" dispatches `dismissed`, which
renders a "Snoozed … (still pending)" row with an **Answer** button
(`PermissionQueue.tsx:88-106`); `selectPendingPermissionCount` (`permissionState.ts:291-300`)
filters on `submittedRequestIds` only, so a snoozed request still drives the tab badge — the
comment at `:288-289` states this as the contract. `respondToPermission`
(`App.tsx:2263-2276`) refuses a second response for an already-submitted id. I looked for the
counter-case A19 might have missed — navigating away from the chat view unmounts the card — and
the request correctly stays pending with the tab badge live, which is the desired behaviour,
not a strand.

---

## Per finding — S08

### S1 — [HIGH] `--bare` bypasses every new policy invariant

- **Verdict**: **CONFIRMED** (mechanism and exposure both proven), with two severity
  qualifications the report does not make.
- **Cited location holds?**: Yes. Per the brief I did not re-verify the three legs already
  settled by the lead (`main.tsx:1073`, `prompts.ts:696`, `corePolicy.test.ts:56`); all three
  are as described, and I additionally found `cli.tsx:316-319` sets `CLAUDE_CODE_SIMPLE=1` even
  **earlier**, before commander runs, so the gate fires during module evaluation too.
- **(a) What the 59-byte prompt actually contains, verbatim.** I called the real
  `getSystemPrompt` with `CLAUDE_CODE_SIMPLE=1`:
  ```
  --- BARE PROMPT BLOCKS: 1 ---
  [block 0] 59 bytes
  "You are Cat Code.\n\nCWD: /Users/pt/cat-code\nDate: 2026-08-08"
  TOTAL BYTES = 59
  ```
  Identical for a `gpt-*` model (`getCLISyspromptPrefix` is called with
  `isNonInteractive: false`, so it always returns `DEFAULT_PREFIX`, and
  `OPENAI_DEFAULT_PREFIX === DEFAULT_PREFIX === 'You are Cat Code.'`,
  `src/constants/system.ts:9,12`). The 59 bytes are cwd- and date-dependent, so treat the
  number as an instance, not a constant.

  **Which invariants are genuinely absent, machine-checked against the real constants:**
  ```
  TOOL_OUTPUT_IS_DATA_RULE            absent
  PROMPT_INJECTION_RULE               absent
  RUNTIME_METADATA_RULE               absent
  HOOK_AUTHORITY_RULE                 absent
  PROJECT_INSTRUCTION_AUTHORITY_RULE  absent
  OUTCOME_REPORTING_RULE              absent
  RETRY_RULE                          absent
  cyber policy                        absent
  ```
  **Are any supplied elsewhere?** I checked the three plausible alternate carriers and found
  none:
  1. *Consumers of the rules* — `rg` over `src/` shows every consumer is inside
     `prompts.ts:162-284,651,739,889` or `promptStyles/gpt.ts:110-195`, i.e. **downstream of
     the early return**. The single exception is `src/utils/claudemd.ts:96`, which embeds
     `INSTRUCTION_AUTHORITY_LIMIT` in the loaded-instruction wrapper — and `--bare` disables
     CLAUDE.md auto-discovery, so it does not fire by default. That is the *one* invariant with
     a conditional alternate carrier, and only when `--add-dir` supplies CLAUDE.md dirs.
  2. *Tool descriptions* — I read `BashTool/prompt.ts`, `FileReadTool/prompt.ts`,
     `FileEditTool/prompt.ts`: no injection, provenance, or authority language. The only
     `CLAUDE_CODE_SIMPLE` gate in a tool prompt is `BashTool/prompt.ts:58`, which drops the
     *skills* section.
  3. *Per-tool-result reminders* — the only `<system-reminder>` the Read tool emits is the
     empty-file / short-file warning (`FileReadTool.ts:701-702`). This fork has **no**
     "do not follow instructions in this file" reminder to fall back on. The
     `CLAUDE_CODE_SIMPLE` gates in `FileReadTool.ts:577` and `FileEditTool.ts:313` are skill
     discovery, not guards.

  So: **all eight are genuinely absent, and only `INSTRUCTION_AUTHORITY_LIMIT` has any
  alternate carrier at all.**
- **(b) Is the claimed tool exposure real?** Yes, exactly as stated. `src/tools.ts:306-338`
  is a `CLAUDE_CODE_SIMPLE` branch commented "Simple mode: only Bash, Read, and Edit tools",
  returning `[BashTool, FileReadTool, getProviderFileEditTool()]`. Executed against the real
  function:
  ```
  BARE TOOLS with NO --tools = ["Bash","Read","Edit"]
  ```
  `getProviderFileEditTool()` (`src/tools.ts:213-215`) resolves to `FilePatchTool`
  (`Apply_patch`) under the OpenAI provider, so a `gpt-*` bare run gets
  `["Bash","Read","Apply_patch"]`.
- **(c) Quantifying the real risk vs the theoretical one.** I ran the mitigation rather than
  reasoning about it:
  ```
  parseBaseToolsFromCLI(['']) = []
  BARE TOOLS with --tools ""                        = []
  BARE TOOLS with --permission-mode plan --add-dir . = ["Bash","Read","Edit"]
  ```
  - **The documented §12 reviewer command is safe on the action axis.** `--tools ""` really
    does empty the surface (`permissionSetup.ts:926-933` deny-lists every tool not in the base
    set, and `getTools` runs `filterToolsByDenyRules` even on the bare branch). The residual
    risk there is **integrity, not action**: attacker-controlled text inside the piped diff can
    steer a verdict, in a prompt with no "tool output is data" and no "flag prompt injection"
    rule. That is real for a review tool whose whole output is a judgement, but it is not the
    file-reading scenario the finding describes.
  - **The §12 `--permission-mode plan --add-dir .` variant is the sharp case**, and it is worse
    than the lead's note says: it restores **all three** tools to the model's visible surface,
    not just Read. Plan mode constrains writes at permission-check time, but Read executes and
    pulls untrusted repository content into an assembly with zero provenance rules.
  - **A third consumer exists that neither report mentions**: `src/utils/attachments.ts:761-772`
    states "Coworker runs with `--bare`", so `--bare` is not only a documented review
    convention. (The `app/` workers that set `CLAUDE_CODE_SIMPLE=1` — `sessionsCatalogWorker.ts:33`,
    `accountsPoolWorker.ts:72`, `transcriptBackfillWorker.ts:42` — are non-LLM utility
    processes and add no model exposure.)
- **Counter-arguments considered**: (a) *Does `--append-system-prompt` restore anything?*
  It appends **user** text; §12's reviewer persona carries no policy. (b) *Is the gap
  branch-new?* **No — and this is the correction.** `git blame` puts both
  `prompts.ts:696-703` and `tools.ts:306-312` at `86051a8`, the fork's root commit, also on
  `main`. `corePolicy.ts` **is** branch-new (`git cat-file -e main:src/constants/corePolicy.ts`
  → does not exist). So the accurate framing is *"the branch's new policy core did not extend
  to a pre-existing minimal path"*, not *"the branch introduced a bypass"*. S08 correctly
  marked it "Touches uncommitted lines: No", but neither it nor the lead note establishes that
  the bare path predates the branch entirely.
- **True consequence**: Every `--bare` invocation runs on a 59-byte prompt with no cyber
  policy, no provenance/injection handling, no instruction-authority limit, no consent rule and
  no truthful-reporting rule, and — unless `--tools ""` is passed — with `Bash`, `Read` and the
  provider edit tool live. The project's own documented GPT-review flow passes `--tools ""` and
  is therefore action-safe but integrity-exposed; its documented `plan` variant is not.
- **Evidence**: scratch `bare/bare.test.ts` and `bare/tools.test.ts` (outputs above);
  `src/constants/prompts.ts:696-703`; `src/constants/system.ts:9-14,48-72`;
  `src/constants/corePolicy.ts:1-98`; `src/tools.ts:213-215,306-338`;
  `src/utils/permissions/permissionSetup.ts:652-665,926-933`; `src/utils/claudemd.ts:96`;
  `src/entrypoints/cli.tsx:316-319`; `git blame` as above.
- **Disposition**: Apply S08's fix, scoped tighter than "a minimal provider system/actions/core
  assembly". Emit exactly the four rules whose absence is load-bearing —
  `TOOL_OUTPUT_IS_DATA_RULE`, `PROMPT_INJECTION_RULE`, `INSTRUCTION_AUTHORITY_LIMIT`,
  `OUTCOME_REPORTING_RULE` — plus `getCyberPolicyInstruction()`, before the early return.
  That is roughly 1.5 KB and preserves every reason `--bare` exists (no hooks, no CLAUDE.md
  walk, no auto-memory, no keychain); `RETRY_RULE` and `HOOK_AUTHORITY_RULE` can stay out
  (hooks are disabled in bare mode anyway, so `HOOK_AUTHORITY_RULE` would be dead text).
  Then fix the test blindness: `withPromptEnv` must take a `simple` option instead of
  unconditionally deleting the env var at `corePolicy.test.ts:56`, and the file needs a bare
  assembly for both providers. **Do not** re-frame this as a branch regression in STATUS — cite
  it as a pre-existing gap the new policy work should close.

### S2 — [MED] The dirty Apply_patch path fix misses two modes where the tool can remain live

- **Verdict**: **PARTIALLY CONFIRMED** — leg (a) confirmed and live; leg (b)'s trigger is
  unreachable in any build this repo can produce.
- **Cited location holds?**: Yes. `gpt.ts:227` is `if (isReplModeEnabled()) {` with its own
  return at `:234`; the new path rule sits at `:246-250`, inside `preferredToolRules`, strictly
  **after** that return:
  `` `${FILE_PATCH_TOOL_NAME} file paths → resolved against the session working directory, which is not always the project root` ``.
  `getGPTAgentModeUsingToolsSection` (`gpt.ts:293-310`) emits only TASK TRACKING / DELEGATION /
  CONTEXT SHAPE / PARALLELISM — no preferred-tool rules at all.
- **Provenance**: The "fix" under review is an **uncommitted** working-tree hunk in both
  `gpt.ts` and `providerPromptRegressions.test.ts`. The two gaps it misses are **pre-existing**:
  `git blame` puts `REPL_ONLY_TOOLS` (`src/tools/REPLTool/constants.ts:37-46`), the filter
  (`src/tools.ts:352-363`) and the body of `getGPTAgentModeUsingToolsSection` at `86051a8`
  (also on `main`).
- **The likeliest refutation was checked and FAILED.** `Apply_patch` is **not** `Edit`
  renamed: `FILE_PATCH_TOOL_NAME = 'Apply_patch'` (`src/tools/FilePatchTool/constants.ts:1`) vs
  `FILE_EDIT_TOOL_NAME = 'Edit'` (`src/tools/FileEditTool/constants.ts:2`), and `FilePatchTool`
  is a distinct `buildTool` object with its own schema and patch grammar
  (`FilePatchTool.tsx:49-50`). `getProviderFileEditTool()` puts exactly one in the pool, and
  `src/tools.ts:360` filters by literal `tool.name`, so on the OpenAI path nothing in
  `REPL_ONLY_TOOLS` matches. There is no canonical-name indirection. S08's premise survives.
- **Leg (a) — CONFIRMED and reachable in the dev-full build.** `--agent-mode` sets the latch
  (`src/entrypoints/cli.tsx:48-49`); `src/screens/REPL.tsx:3149` calls
  `getAgentModeSystemPromptSections(freshTools, …)` with the merged pool;
  `src/constants/prompts.ts:654-656` routes GPT to `getGPTAgentModeUsingToolsSection`. Nothing
  in `src/agent-mode/` strips the orchestrator's edit tool — the role tool-lists at
  `rolePrompts.ts:168,323` constrain *workers*. So a `gpt-*` agent-mode orchestrator holds
  `Apply_patch` and receives zero path guidance.
- **Leg (b) — REFUTED as stated.** "An ant-native interactive GPT session enables REPL by
  default" describes a binary this repo cannot build: `scripts/build.ts:133` hard-defines
  `'process.env.USER_TYPE': JSON.stringify('external')` for **both** dev and prod, and there is
  no ant target. Consequently `src/tools.ts:21-23` sets `REPLTool = null`, `:267` only adds it
  for ant, and `isReplModeEnabled()`'s default-on clause (`REPLTool/constants.ts:26-29`) is
  statically dead. The one live entrance is `CLAUDE_REPL_MODE=1` (`constants.ts:25`), which
  nothing in the repo sets — and there the shape differs from the claim: the prompt
  early-returns (dropping *all* tool-preference rules) while `src/tools.ts:358`'s `replEnabled`
  guard is **false** (no `REPLTool` in the pool), so the filter never runs and every primitive
  stays directly exposed. Worse in shape, but gated behind an env var and an inert REPL surface.
- **Test-coverage claim — CONFIRMED.** `providerPromptRegressions.test.ts:393-399` calls
  `getGPTUsingToolsSection` twice and nothing else; under `bun test`, `USER_TYPE` is not `'ant'`
  and `CLAUDE_REPL_MODE` is unset, so only the non-REPL branch runs and the agent-mode builder
  is never called. Both gaps stay green.
- **True consequence**: A prompt-coverage gap, not a security one. `FilePatchTool`'s own
  description says only "File references can only be relative, NEVER ABSOLUTE"
  (`src/tools/FilePatchTool/prompt.ts:72`) without naming a base — exactly the ambiguity the new
  rule fixes — so GPT Agent Mode keeps the original defect.
- **Disposition**: Take S08's **first** fix and drop its second. Put the path-base statement in
  `getFilePatchToolDescription`, where every exposed instance inherits it regardless of prompt
  builder — that closes leg (a) and the `CLAUDE_REPL_MODE` case in one edit, and it is the
  correct home because the rule is about the tool, not about a mode. **Do not add
  `FILE_PATCH_TOOL_NAME` to `REPL_ONLY_TOOLS` on this finding's evidence**: the set is
  unreachable in this repo's builds, so the change is untestable here and would be a
  speculative edit to a pre-existing upstream constant. Add the Agent-Mode assembly test; skip
  the REPL assembly test until an ant target exists. Adjacent inconsistency worth a separate
  note: `getReplPrimitiveTools()` (`primitiveTools.ts:28-39`) lists `FileEditTool` and never
  `FilePatchTool`, so REPL's "still accessible inside the VM" promise would not hold for the
  OpenAI edit tool either.

### S3 — [LOW] The output-style policy test does not exercise an output-style assembly

- **Verdict**: **PARTIALLY CONFIRMED** — the description is right, the claimed missed failure
  is refuted.
- **Cited location holds?**: Yes. `corePolicy.test.ts:210-231`, named "an output style that
  drops coding instructions still gets reporting and retry", calls
  `getCorePolicySection({cyberPolicy:false, retryRule:true})` directly, asserts three things
  about that string, then greps `promptsSource` for `'const hasDoingTasksSection ='`,
  `'outputStyleConfig.keepCodingInstructions === true'` and `'retryRule: !isAgentMode,'`. It
  never configures an output style and never calls `getSystemPrompt` under that state. Repo-wide,
  `keepCodingInstructions` appears in tests **only** in this file, as a comment (`:212`) and a
  string literal (`:228`). The file's own header ("These tests build the real assemblies",
  `:19-25`) is untrue of this one.
- **Trigger — the claimed mutation does NOT survive.** Inverting `prompts.ts:887` leaves line
  895's doing-tasks ternary untouched, so:
  - For the **normal Claude and GPT variants** (`hasDoingTasksSection === true`), the core is
    emitted *alongside* doing-tasks, duplicating `OUTCOME_REPORTING_RULE` (`corePolicy.ts:93`
    + `prompts.ts:266` / `gpt.ts:169`) and `RETRY_RULE` (`corePolicy.ts:94` + `prompts.ts:262`
    / `gpt.ts:165`). `corePolicy.test.ts:114-136` asserts
    `expect(prompt.split(rule).length - 1).toBeLessThanOrEqual(1)` — **fails for both**.
  - For the **agent-mode assembly** (`:185-208`, `hasDoingTasksSection === false`), the
    inverted branch yields `null` and `expect(prompt).toContain(OUTCOME_REPORTING_RULE)` at
    `:201` — **fails**.
  So "every current assertion still passes" holds only for the three assertions inside that one
  test, not for the file, and the mutation is caught twice over.
- **Counter-arguments considered**: I searched for output-style tests outside this file
  (`src/constants/prompts.test.ts` and repo-wide) and found none — so the *coverage* observation
  stands even though the *mutation* is caught. I also checked provenance:
  `prompts.ts:872-899` is branch-committed (`bf7beca`); the working-tree diff to `prompts.ts`
  touches only the verification-contract removal.
- **True consequence**: The test is misnamed and proves less than it claims, but the specific
  regression S08 predicts would turn the suite red. The genuine residual is narrower: a mutation
  confined to the **output-style term** — e.g. `const hasDoingTasksSection = !isAgentMode` —
  is invisible to every behavioural assertion, defended only by the source-substring grep at
  `:227-229`.
- **Disposition**: Apply S08's fix, but write it against the residual it actually covers.
  Inject an output style with `keepCodingInstructions: false`, build both provider prompts, and
  assert the assembly contains `OUTCOME_REPORTING_RULE` and `RETRY_RULE` — that kills the
  narrowed mutation and lets the three source greps at `:227-229` be deleted. Do **not** justify
  it with the `prompts.ts:887` inversion; that claim will not reproduce.

### S4 — [LOW] The dirty verification test proves wording removal, not the behavior its name claims

- **Verdict**: **PARTIALLY CONFIRMED** — the test critique holds; the reachability claim is
  refuted.
- **Cited location holds?**: Yes, and it is an **uncommitted** hunk replacing a committed
  "bound the verification loop at three fix/verify cycles" test. `corePolicy.test.ts:292-302`
  asserts only `expect(gpt).not.toContain('VERIFICATION CONTRACT:')` and
  `expect(promptsSource).not.toContain('The contract: when non-trivial implementation happens on
  your turn')` — both against **file text** (`Bun.file('./promptStyles/gpt.ts')` and
  `promptsSource`), not an assembled prompt. A reworded mandate, or one added to a third prompt
  surface, passes. First half CONFIRMED.
- **Reachability — REFUTED.** The claimed runtime behaviour is dead code in the dev-full
  binary. The text does exist (`TodoWriteTool.ts:104-108`, `TaskUpdateTool.ts:402-404`, cited by
  S08 as `:78` and `:341` — both **off by ~26 and ~61 lines**), but it is gated on
  `feature('VERIFICATION_AGENT') && getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence',
  false)`. `VERIFICATION_AGENT` **is** in the dev-full list (`scripts/build.ts:47`), so that
  conjunct is live. `tengu_hive_evidence` can never be true:
  - env overrides — `growthbook.ts:170-192`, guarded by `process.env.USER_TYPE === 'ant'`,
    statically `'external'`;
  - config overrides — `growthbook.ts:211-212`, `if (process.env.USER_TYPE !== 'ant') return undefined`;
  - GrowthBook itself — `growthbook.ts:427-429` → `is1PEventLoggingEnabled()`, which is
    `return false` hardcoded at `firstPartyEventLogger.ts:26-28` in this fork.

  All three closed. Further narrowing even in a hypothetical ant build: `!context.agentId`
  (main thread only) and `TodoWriteTool.isEnabled() = !isTodoV2Enabled()`. The repo says so in
  the very line the working tree deletes: `// 3P default: false — verification agent is ant-only A/B`.
- **Counter-arguments considered**: (a) *Is the surviving text really "mandatory"?* No — the
  removed contract said "you **MUST** spawn … you own the verification gate"; the survivor is a
  `NOTE:` with an imperative. S08 calls it "orders the model", which overstates it. (b) *Does
  removing the prompt contract orphan a capability?* No — the verification agent is still
  registered unconditionally (`builtInAgents.ts:60-65`), so only the mandate is removed.
- **True consequence**: A misnamed wording-removal test, exactly as described. But the trigger
  S08 offers ("enable `VERIFICATION_AGENT` and `tengu_hive_evidence`") **cannot be constructed**
  in this repo, so "the runtime still imposes automatic verification" is false for the shipped
  build.
- **Disposition**: Apply the *first* half of S08's fix — rename the test to state what it
  checks (removal of the static legacy contract from two named files). **Skip the second half**:
  a behavioural test for the just-in-time nudge would have to force a statically-false feature
  value, so it would either be untestable or require a production seam this finding does not
  justify. If the nudge matters, the cheaper move is to note in `TodoWriteTool.ts` that the
  branch is ant-only and currently unreachable in dev-full.

---

## Findings the original reports missed

Two, both verified to the same bar as the above.

### M1 — [HIGH] The sidecar never enforces `isBypassPermissionsModeAvailable`, though three HEAD comments say it does

`handleSetMode` (`app/sidecar/sidecarServer.ts:1639-1692`) is 54 lines and I read all of them.
It fail-closes for exactly one mode:

```ts
if (raw.mode === 'auto' && this.permissions?.getDisplayFacts().permissionClassifierEnabled !== true) { … bad_request … }
```

There is **no** `bypassPermissions` branch, and `rg -i bypass app/sidecar app/shared --glob
'!*.test.*'` finds the field in only two live places: the producer
(`sessionController.ts:163`) and the outbound snapshot (`sidecarServer.ts:3982`). Nothing
reads it as a guard.

At HEAD this contradicts three separate comments that assert defence in depth:
- `PermissionModeChip.tsx:13-20` — "the sidecar re-checks that flag and rejects otherwise (C2,
  PERMISSION-BOUNDARY.md §3)";
- `PermissionModeChip.tsx:85-88` — "the sidecar rejects a request anyway (defence in depth)";
- `sessionController.ts:158-167` — "the sidecar's `permission.setMode` boundary honours a
  bypass request (`sidecarServer.ts` handleSetMode reads this same context flag)".

So at HEAD the only thing standing between a renderer and `bypassPermissions` is the renderer's
own `disabled` attribute — precisely the renderer-side-only gate the security baseline exists to
forbid, and the inverse of A19's claim that the sidecar would refuse. A compromised or scripted
renderer sending `{type:'permission.setMode', mode:'bypassPermissions'}` passes
`checkStrictKeys`, passes the Zod union (`bypassPermissions` is in `PERMISSION_SET_MODE_MODES`,
`protocol.ts:99-106`), and reaches `permissionDomain.setMode` → `transitionPermissionMode`.

This is being overtaken by events: the in-flight change makes bypass an intentionally available
desktop mode, which removes the contradiction by removing the gate. That is a policy decision
for the operator, not a fix I would apply. **Either way, the three comments must stop claiming
an enforcement that does not exist**, and if bypass is to remain gated, the guard belongs in
`handleSetMode` beside the `auto` one. Recommend routing this to whoever owns the in-flight
`sessionController.ts` / `permissionDomain.ts` change rather than opening a competing edit.

### M2 — [LOW] `WorkspacePanels`' panel header is a pointer-only focus affordance

`WorkspacePanels.tsx:279-281` is `<div className="flex h-9 …" onClick={() => onFocusPanel(index,
panel.sessionId)}>` with no `role`, no `tabIndex` and no `onKeyDown`. A sweep of every `<div>`
carrying `onClick` without a role or keyboard handler across the renderer returns 12 sites, and
this is the **only one** that is not a modal scrim (the other 11 are scrims plus
`PlanPanel.tsx:141`'s `stopPropagation` shim; `TabBar.tsx:252` looked like a hit but carries
`role="tab"`, `tabIndex` and `onKeyDown` at `:262-277`). Severity is genuinely LOW because it is
redundant: `WorkspacePanels.tsx:165` already focuses the panel on `onMouseDown` over the whole
panel. But it does mean panel focus has **no keyboard path at all** in a split workspace. Same
family as A9/A14; worth folding into whatever a11y pass those produce rather than its own change.

## Uncertainties

- **The `app/` DOM harness is mine, not the repo's.** `happy-dom` was installed into the
  scratchpad and `react`/`react-dom` symlinked from `app/node_modules`; the repo gained no
  dependency and no test file. happy-dom's focus and `activeElement` semantics are faithful for
  what I exercised (I included a passing negative control — Escape from a real `<input>` is
  correctly ignored — and a designed-case control for A2), but it is not Chromium. If A1 and A2
  are treated as release-blocking, one operator keypress in the real app would settle them in
  seconds, and my scripts are directly portable into `app/` if the DOM-harness decision in
  `V29`'s F1 disposition is taken.
- **A2's trigger assumes a click on a non-focusable region moves `activeElement` to `<body>`.**
  That is standard browser behaviour and happy-dom reproduces it, but I did not verify it in
  Electron specifically.
- **S1's 59 bytes is cwd- and date-dependent.** It matched the report exactly only because the
  cwd matched. Do not cite the number as a constant.
- **I did not run any repo test file**, per the contract. Every `bun test` invocation above ran
  a scratchpad file only.
