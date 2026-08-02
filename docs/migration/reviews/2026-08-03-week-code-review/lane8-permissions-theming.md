# Lane 8: Permission UI, inspectors, theming

Review target: committed range `2f4278d..7c6959f`. All anchors are `git show 7c6959f:<path>`.
The working tree is dirty with other sessions' edits in several of these files; nothing below
was read from the working copy.

## Scope reviewed

The week did four things in this lane. (1) `2df63f8` (P4-43) made the permission card's four
advertised keys actually work: the card that the shortcuts act on now takes DOM focus, marks
itself as the key *host* via `data-permission-key-host`, and the focused-control guard moved out
of `App.tsx` into a shared pure predicate `permissionKeysAreLive` in the new
`permissionPromptModel.ts`. (2) `77e6151` (P4-42) gave the card a legible preview of what it is
approving (`selectPermissionPreview` / `buildChangeLines`) instead of `JSON.stringify(input)`.
(3) `e54fc80` + `c39941b` + `4d2021b` grew `MetadataInspector` into the session inspector, moving
the live permission context, effective settings, flag layer and engine diagnostics off Settings
onto a read-only drawer backed by the new `sessionInspectorState.ts`; `39351bd` (P4-37) added
copy/search/wrap to `ToolInspector`. (4) `fbf2939`/`6fdacba`/P4-34 added a five-key code theme and
a five-key accent theme, both painted purely by CSS custom properties under `data-code-theme` /
`data-accent`, plus self-hosted woff2 fonts (`61e8316`).

## Findings

### [HIGH] A permission card arriving mid-turn steals focus from the composer, so the user's next Enter allows the tool instead of sending their message — CONFIRMED

**Location:** `app/renderer/src/PermissionPrompt.tsx:104-124`, with
`app/renderer/src/App.tsx:2059-2094` and `app/renderer/src/App.tsx:3670-3676`

**Defect:** The keyboard-target card focuses itself unconditionally on mount, with no check for
whether the user is currently typing; the document-level shortcut listener then interprets the
user's next Enter, aimed at the composer, as "allow this permission request".

**Failure scenario:**
1. A turn is running. Since `4394086` (landed in this same range) the composer is *editable*
   mid-turn (`composerState.ts` `turnPending` joins `editable`) and the send button is replaced by
   Stop, so **Enter is the only submit path** (`App.test.tsx`: "the send slot still holds Stop
   mid-turn … so Enter is the submit path here"). The user starts typing a follow-up.
2. The agent hits a gated `Bash` call. `permission.requested` lands, `PermissionQueue` renders a
   card with `keyboardTarget` true.
3. The card's effect captures `previous = document.activeElement` (the textarea) and, on a
   `setTimeout(…, 0)`, calls `node.focus()`. The caret leaves the composer mid-word. Nothing
   consults what has focus first.
4. The user finishes the sentence and presses Enter. Focus is on the card's `<section>`, which
   carries `PERMISSION_KEY_HOST_ATTR`, so `permissionKeysAreLive(event.target)` returns **true**,
   `permissionActionForKey` returns `'allow'`, and `allowPermission(pendingPermission.requestId, [])`
   fires. The tool runs. The typed message is gone (the characters after step 3 went to a
   non-editable `<section>`).

The `n`/`Backspace` variant is the same bug in the other direction: a follow-up containing the
letter `n` typed after the focus steal denies the request.

**Evidence:**
```ts
// PermissionPrompt.tsx:104-124
useEffect(() => {
  if (!keyboardTarget) { setKeysLive(false); return }
  const node = sectionRef.current
  if (!node) return
  const previous = document.activeElement
  const timer = setTimeout(() => {
    node.focus()                       // <- unconditional; `previous` is not consulted
    setKeysLive(document.activeElement === node)
  }, 0)
```
`previous` is captured only so focus can be handed *back* on unmount; it is never used to decide
whether taking focus is safe. The cited precedent (`PlanPanel.tsx:99-110`) appears at a turn
boundary, where the composer is not being typed into; a permission card appears **mid-turn**, in
the one window the composer was just opened for. Note the interaction is new: before `4394086` the
mid-turn composer was `readOnly`, so there was nothing to steal focus from, and P4-43 (`2df63f8`,
Jul 31) predates the composer change (Aug 2) — neither change is wrong alone.

Suggested shape of the fix (not applied): skip the focus grab when
`document.activeElement` is an editable control, and let the existing "focus is on nothing"
predicate carry the keys as it did before, or arm the card only after the composer is blurred.

---

### [MEDIUM] The permission shortcuts stay armed on Settings / Accounts / Sessions / Goals, where no card is on screen — CONFIRMED

**Location:** `app/renderer/src/App.tsx:2059-2094` (effect + dep list), against
`app/renderer/src/App.tsx:2884-3026` (view switch)

**Defect:** The document `keydown` listener is gated on `pendingPermission`, `activeSessionId` and
`dedicatedFlowOwnsKeyboard` — but not on `activeView`. The cards that the keys act on render only
in the final `else` branch of the view switch, so on every other view the keys are live with no
visible card and no hint.

**Failure scenario:** A permission request is pending in the active session. From the composer's
profile popover the user clicks "Manage accounts" (`App.tsx:2247` `onManageAccounts={() =>
setActiveView('accounts')}`) — a one-click path reachable *while the card is up*. The workspace
panels unmount, so the permission card disappears from the screen; the effect does not re-run,
because none of its three deps changed. On the Accounts page the user clicks a non-interactive
region or dismisses something (focus falls back to `document.body`) and presses Enter or Escape.
`body.closest(FOCUSED_KEY_OWNER_SELECTOR)` is `null`, so `permissionKeysAreLive` returns true and
the invisible request is **allowed** (Enter) or silently snoozed (Escape). Returning to chat, the
allow has already been sent, or the card is now sitting in the "Snoozed" list the user never asked
for.

**Evidence:**
```ts
// App.tsx:2059-2062 — the whole gate
useEffect(() => {
  if (!pendingPermission || !activeSessionId) return
  if (dedicatedFlowOwnsKeyboard) return
```
deps: `[allowPermission, denyPermission, pendingPermission, activeSessionId, dedicatedFlowOwnsKeyboard]`.
The comment at `App.tsx:2050-2053` states the invariant as one-directional — "a card can never
claim keys the listener does not deliver". The converse, the listener delivering keys no card
claims, is exactly this gap, and P4-43's own goal was to make the advertised keys and the
delivered keys the same set.

---

### [MEDIUM] Nothing rate-limits the shortcuts, so one held key walks a queue of pending requests — PLAUSIBLE

**Location:** `app/renderer/src/permissionPromptModel.ts:13-21` and `app/renderer/src/App.tsx:2063-2084`

**Defect:** `permissionActionForKey` inspects only `key` and the three modifier flags. There is no
`event.repeat` check and no "this card just appeared" arming delay, and the handler always targets
whatever `selectVisiblePermission` currently returns.

**Failure scenario:** A parallel tool batch produces three pending permission requests (the queue
is a designed state — `permissionState.ts` models it explicitly, and `PermissionQueue` renders
"3 permission requests pending"). The user holds Enter (auto-repeat, ~30 ms after the initial
delay). Keydown 1 allows request A; React commits, `selectVisiblePermission` advances to B, the
effect re-binds to B, and the card for B focuses itself on a `setTimeout(…, 0)`. Subsequent
repeats land on B and then C. Two requests the user never read are approved.

**Evidence:**
```ts
export function permissionActionForKey(event: KeyLike): PermissionKeyboardAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.key === 'Enter') return 'allow'
```
`KeyLike` is `{ key, altKey?, ctrlKey?, metaKey? }` — `repeat` is not even in the type, so no
consumer can filter on it. Marked PLAUSIBLE rather than CONFIRMED because the card-to-card focus
bounce (A's cleanup restores focus to the composer for a tick before B focuses itself, see
`PermissionPrompt.tsx:117-123`) may swallow one or two repeats; how many get through needs a live
run. The `app/` renderer suite is SSR-only and cannot press a key at all.

---

### [LOW] A bundled woff2 with no consumer — CONFIRMED

**Location:** `app/renderer/src/theme.css:35-41` and `:161`,
`app/renderer/src/assets/fonts/PressStart2P-Regular.woff2`

**Defect:** `61e8316` added a `@font-face` rule and a 4.7 kB woff2 for `Press Start 2P`, backing
the `--font-display` token. `--font-display` predates this range (`2f4278d:theme.css:82`) and has
**zero** consumers: `git grep font-display 7c6959f -- app/` returns only the `font-display: swap`
descriptors and the token declaration itself. So the range shipped a font asset into the renderer
bundle that no class ever requests. Either a display-font surface is missing, or the token and the
file should go together.

---

### [LOW] The accent stylesheet test does not cover the token the glows actually read — CONFIRMED

**Location:** `app/renderer/src/AccentThemeProvider.test.tsx:73-85`, against
`app/renderer/src/theme.css:89-108` and `:261-299`

**Defect:** The test asserts each non-default `[data-accent='…']` block redeclares `--accent` and
`--accent-soft`. It does not assert `--accent-rgb`, which was added later and is what
`.sidebar-row-actions*` and `.welcome-cat-glow` read (`rgb(var(--accent-rgb) / …)`), and it does
not bind `ACCENT_SWATCH_CLASS`'s literal hexes (`accentTheme.ts:50-56`) to the `--accent` hexes in
the stylesheet. All five currently agree, so there is no live defect. The cost is that the two
silent-failure modes this test exists to catch — a swatch that shows a colour the app does not
paint, and an accent whose glows stay pink — are both outside it. Contrast `codeTheme.test.ts`,
which parses `theme.css` and proves every theme covers every themed scope.

---

### [LOW] Two comments assert the opposite of the code beside them — CONFIRMED

**Location:** `app/renderer/src/PermissionModeChip.tsx:94-97`;
`app/renderer/src/MetadataInspector.tsx:11`

**Defect:** `PermissionModeChip.tsx:94-97` says "The prototype's Bypass is the mode NOT on the
desktop wire allowlist — it stays off until a trusted desktop grant surface exists". It is on the
allowlist (`protocol.ts:99-105` `PERMISSION_SET_MODE_MODES` includes `bypassPermissions`; the
same file's header at `:16-18` and the `satisfies readonly PermissionSetModeMode[]` on
`MODE_DISPLAY_ORDER` both prove it). The grant surface exists — `CATCODE_ALLOW_BYPASS=1`, per
PERMISSION-BOUNDARY.md §3 (2026-07-13). A stale claim about which permission modes cross the
boundary is the kind a future change reads and trusts. Separately,
`MetadataInspector.tsx:11` says every value "degrades to `—`"; the file renders `none` throughout,
per the CLAUDE.md §7 placeholder rule. Comments are not a user-visible surface, so neither is a
rule violation, but the first is actively misleading.

## Coverage gaps

- **Permission-card key handling has no executable coverage of the behaviour that matters.**
  `permissionKeysAreLive` and `permissionActionForKey` are unit-tested against a hand-rolled
  `focusTarget()` stub (`PermissionPrompt.test.tsx:480-504`), and the SSR test at `:506` pins the
  marker attribute and `tabindex="-1"`. `App.test.tsx:1486` is a **source-text** assertion (it
  reads `App.tsx` with `readFileSync` and greps the effect body), not an execution. So: no test
  presses a key, no test proves the selector actually matches the card's `<section>`, no test
  observes the focus grab, and no test can see either of the two focus-related findings above.
  The test file says so honestly ("LAYER HONESTY: this stands in for the DOM … only the operator's
  GUI run can prove a key press arrives"), which is the right disclosure, but the shipped feature
  is *entirely* keyboard and focus behaviour and it is landing on operator judgement alone.
- **No `permissionPromptModel.test.ts`, `toolInspectorModel.test.ts` or `accentTheme.test.ts`**
  exists; those modules are covered from the sibling component test files instead. Fine for
  `permissionPromptModel` (well covered from `PermissionPrompt.test.tsx`) and `toolInspectorModel`
  (covered from `ToolInspector.test.tsx`); `accentTheme` is covered from
  `AccentThemeProvider.test.tsx`, with the two holes noted above.
- **No test that the shortcut listener is scoped to the view that renders the card.** The
  view-gating finding would be caught by extending the existing `App.test.tsx:1486` source-text
  tripwire, which is already the pattern this file uses for this effect.

## Clean

Checked and found sound:

- **C1 selection is index-only and request-bound.** `buildAllowResponse`
  (`permissionState.ts:333-344`) sends `{behavior:'allow', updatedInput:{}, applySuggestions}` and
  nothing else; the card closes over `item.request.requestId` and renders `onAllow([index])` where
  `index` is the array index of the same `permission_suggestions` array it renders
  (`PermissionQueue.tsx` `onAllow={applySuggestions => onAllow(item.request.requestId, …)}`,
  `PermissionPrompt.tsx:221-236`). No rule object, destination or rule string is ever constructed
  renderer-side; `describeSuggestion` is display-only. The sidecar re-attaches its own pending
  entry's objects (`sidecarServer.ts:3365+`, `validateSuggestionSelection`). T6b holds.
- **T6 `updatedInput` is echo-only** — literally `{}` with a comment saying the sidecar substitutes
  the engine-owned gated input.
- **T5a.** Every response carries the engine-minted `requestId`; `respondToPermission`
  (`App.tsx:1986-2014`) refuses a second answer for an already-`submitted` id, and
  `allowPermission` bails when the id is no longer in the queue, so a late answer for a superseded
  request cannot be attributed to a new one (the card is keyed by `requestId`, so a new request
  gets a fresh component and a fresh index space).
- **No credential exposure in the inspectors.** `MetadataInspector`'s effective-settings section
  prints key *names* for every resolved key but a *value* only for keys in the closed
  `EDITABLE_SETTINGS` allowlist (`app/shared/settingsEditable.ts`, explicitly "no key here is ever
  credential-bearing"), and states so on screen. Flag-layer rows print key names and the settings
  file path, never values. Diagnostics prints engine doctor strings (version, sandbox flag,
  install/health/memory warnings) — the same strings `/doctor` shows in the TUI. `ToolInspector`
  shows tool input/output that the transcript already renders, adding no new seam. Nothing in the
  lane reads env vars, tokens or auth headers.
- **No Tailwind dynamic-class trap anywhere in the lane.** Grepped for
  `(bg|text|border|…)-[${` across every lane file: zero hits. `accentTheme.ts` and `codeTheme.ts`
  both paint through CSS custom properties under a data attribute rather than classes, and both
  say why in a comment; `ACCENT_SWATCH_CLASS`, `PREVIEW_LINE_CLASS`, `LINE_TEXT_CLASS`,
  `WRAP_BUTTON_CLASS`, `STEP_BUTTON_CLASS`, `MODE_META.tone*` and `SOURCE_BADGE_CLASS` are all
  static literal maps.
- **No inline `style={{}}`** in any lane file.
- **`theme.css` token hygiene.** All five accents declare all three tokens (`--accent`,
  `--accent-soft`, `--accent-rgb`), pink via the unscoped `:root`. Every `@theme inline` token I
  sampled has real consumers (`text-faint` 16 files, `shell-seam` 37, `surface-panel` 8,
  `tone-success` 4, `source-policy` 3, …); the only orphan is `--font-display` (reported above).
  Code-theme specificity is correct — `[data-code-theme="x"] .hljs-*` is (0,2,0) against the
  unscoped (0,1,0), and the two compound selectors keep their extra class. `codeTheme.test.ts`
  parses the stylesheet and proves every theme covers every themed scope with five distinct
  palettes, which is the right test for a CSS-only feature.
- **CLAUDE.md §7 text rules.** `rg '—'` across the lane: every hit is inside a comment. No-value
  placeholders are `none`, not `—`. No `file.ts:123`, no `P4-…`/`CC-…`, no `MAX_*` in rendered
  text; `sessionInspectorState.ts` documents at length that source citations were deliberately
  moved from the screen into comments, and `userVisibleText.test.ts` now enforces this repo-wide
  across all four planes. Raw engine tokens are translated before display
  (`DIRECTORY_SOURCE_LABEL`, `RULE_SOURCE_LABEL`, `MATCH_TYPE_LABEL`, `MODE_LABEL`, `MODE_META`),
  each with a fallback that avoids leaking an unknown token.
- **Fast Refresh boundary.** `AccentThemeProvider.tsx`, `CodeThemeProvider.tsx` and
  `CodeThemePreview.tsx` each export exactly one component; contexts, storage helpers, key lists,
  labels and `PREVIEW_CODE` all live in the `.ts` siblings, with the reason cited at each site.
- **Exhaustiveness tripwires present and total.** `describeSuggestion`'s `const _exhaustive: never
  = update`; `Record<PermissionUpdate['destination'], string>`; `Record<SuggestionMode, string>`;
  `satisfies Record<PermissionSetModeMode, ModeMeta>`; `Record<InspectorSeamId, string>`;
  `Record<PermissionPreviewLine['kind'], string>`.
- **Display degrades, never throws.** `selectPermissionPreview` runtime-narrows every field and
  returns `null` on a mismatch; `buildChangeLines` and `formatPermissionInput` and `safeStringify`
  all catch; `describeToolForInspector` narrows a non-record input to `{}`. Zero `as` casts on wire
  data — the only two in the lane are `JSON.parse(raw) as Partial<…>` on renderer-owned
  localStorage (`accentTheme.ts:83`, `codeTheme.ts:101`), both followed by real runtime validation
  inside a `try`, with the hostile cases covered by tests.
- **`PermissionRulesEditor` is genuinely read-only in the inspector** (`showModes={false}`,
  `onSetMode` bound to a no-op); the current-mode pill emits nothing. The `?? 'exact'` matchType
  fallback in `RuleGroup` is unreachable, not a mislabel risk: `ruleMetadata` is built at the
  sidecar from the *same* three rule maps in the same frame
  (`sidecarServer.ts` `buildPermissionContextSnapshot`), keyed by behavior+source+rule.
- **The key hint tracks the live state.** `hintVisible = keyboardTarget && keysLive && !denyOnly`,
  and `keysLive` is re-derived from the real `activeElement` through the same predicate the
  listener uses, on focus and on blur. Focus moving to a button on the card correctly hides it
  (React `onFocus` bubbles); blur to nothing correctly keeps it (target becomes `body`, which the
  listener also treats as live). The only inconsistent window is the initial optimistic
  `useState(keyboardTarget === true)` before the `setTimeout(0)` focus lands, which is sub-frame
  and self-correcting; not reported.
