# A18 — renderer page surfaces

## Verdict

These files are in better shape than their size suggests: the two mechanical traps this
codebase keeps re-learning are genuinely closed here. There is **zero** interpolated
arbitrary-value Tailwind (`text-[${x}]`) anywhere in scope, **zero** user-visible em dashes
(every one of the 60+ hits is a `//`, `/** */`, or `{/* */}` comment), and the Fast Refresh
boundary is clean in all 17 files — `AccentThemeProvider.tsx` / `CodeThemeProvider.tsx`
correctly keep their contexts in adjacent `accentTheme.ts` / `codeTheme.ts`. The single most
important thing to fix is the tag popover: pressing Enter on an empty query writes the
alphabetically-first existing tag to the engine, and on the bulk form it does so for every
selected live session at once. Beyond that, the dominant theme is **dead surface area**: two
entire page files with no importer, three `embedded={false}` branches that production never
reaches, a state selector that is tested but never called while its rule is re-derived inline
three times, and four props `SettingsShell` accepts and discards while `App` computes them
every render.

## Findings

### [HIGH] Enter on an empty tag query silently writes a tag to the engine

- **Where**: `/Users/pt/cat-code/app/renderer/src/SessionsPage.tsx:1075-1085`
- **Type**: correctness
- **What**: The tag popover's Enter handler falls back to `matches[0]` when
  `resolveTagCommit` returns null. `resolveTagCommit` returns null *only* for an empty/
  whitespace query (`sessionsPageState.ts:264-268`), and `selectMatchingTags('')` returns
  **all** known tags because `tag.toLowerCase().includes('')` is true for every string
  (`sessionsPageState.ts:276-278`). So the fallback fires on exactly the one input the
  selector was written to reject.
- **Trigger / why it matters**: Any workspace where at least one session already carries a
  tag. Click a row's `+ tag` (or the bulk bar's **Tag**), the popover opens with an empty,
  autofocused input, press Enter — `resolveTagCommit` returns null, `matches[0]` is the
  alphabetically-first existing tag (`selectKnownTags` sorts with `localeCompare`), and
  `apply()` dispatches the real `session.tag` verb. On the bulk form `applyTag` sends it to
  **every** selected live row and then clears the selection, so the user cannot see what was
  just changed. `resolveTagCommit`'s own doc comment says "an empty query does nothing"; the
  caller defeats that. The documented third branch ("then the first remaining match") is
  otherwise unreachable, since any non-empty query is by construction novel and takes the
  create path.
- **Fix**: Drop the `else if (matches[0]) apply(matches[0])` arm at line 1080. `resolveTagCommit`
  already encodes the full decision (exact match → create → nothing); the caller should just
  be `const resolved = resolveTagCommit(query, knownTags); if (resolved) apply(resolved)`.

### [MED] Direct-connect success details render for one frame, then vanish

- **Where**: `/Users/pt/cat-code/app/renderer/src/RemoteSettingsPage.tsx:278-290, 328-333`
- **Type**: correctness
- **What**: `matched` is computed **in the render body** from `pendingRequestId.current`, but
  the effect that consumes the result sets `pendingRequestId.current = null` and calls
  `setConnecting(false)`. The resulting re-render recomputes `matched` as false, so
  `connected` becomes `undefined`.
- **Trigger / why it matters**: Submit a valid server URL. The result frame arrives → render
  N has `matched === true` and paints `<RemoteRolePill/>` plus "Session `<id>` is reachable at
  `<wsUrl>`" → the effect runs, nulls the ref and flips `connecting` false → render N+1 has
  `matched === false` and unmounts both. The user gets a toast but never gets to read or copy
  the `wsUrl`, which is the only thing that panel exists to deliver. `BridgePanel` in the same
  file does this correctly by matching *inside* the effect (lines 123-134); the two halves of
  one file use two different shapes for the same job.
- **Fix**: Hold the matched result in state rather than deriving it from a ref during render:
  in the effect, `setConnected(lastResult.directConnect ?? null)` alongside the existing
  `setConnecting(false)`, and render off that state.

### [MED] Two page files in scope have zero importers

- **Where**: `/Users/pt/cat-code/app/renderer/src/DiagnosticsSection.tsx` (131 lines),
  `/Users/pt/cat-code/app/renderer/src/WorkspaceTrustSection.tsx` (93 lines)
- **Type**: dead-code
- **What**: Neither is imported by any `.ts`/`.tsx` in `app/`, `web/`, or `src/` — verified
  with `rg "from './DiagnosticsSection.js'"` / `"from './WorkspaceTrustSection.js'"` (no hits)
  and a repo-wide `rg` that returns only `docs/` prose. They have no colocated tests either.
- **Trigger / why it matters**: 224 lines that typecheck, lint, and get reviewed on every pass
  while rendering nothing. `docs/reports/2026-07-28-bug-catalogue.md:427` already flagged
  "Four orphaned surfaces" including both of these, so this has survived at least one sweep.
  `WorkspaceTrustSection.tsx:72-73` also contains a live rendering bug nobody can see: the JSX
  text `` (`--add-dir` and `permissions.additionalDirectories`) `` renders **literal backtick
  characters** to the user, and names two internal config keys besides.
- **Fix**: Delete both files. Their content was relocated to `MetadataInspector.tsx` per
  `SettingsShell.tsx`'s Law 1 header comment (lines 15-19), which is the change that orphaned
  them.

### [MED] `SettingsShell` accepts four props it never renders, and `App` computes them every render

- **Where**: `/Users/pt/cat-code/app/renderer/src/SettingsShell.tsx:173-181`;
  call site `/Users/pt/cat-code/app/renderer/src/App.tsx:3219-3239`
- **Type**: dead-code
- **What**: `additionalWorkingDirectories`, `permissionContext`, `diagnosticsSnapshot`, and
  `workspaceTrustSnapshot` are declared with a comment saying they are "Accepted but no longer
  rendered here". `App` still passes all four, each through a live selector call
  (`selectAdditionalWorkingDirectories`, `selectPermissionContext`, `selectDiagnosticsSnapshot`,
  `selectWorkspaceTrustSnapshot`).
- **Trigger / why it matters**: Four selectors run on every `App` render to produce values that
  are destructured into nothing. It also makes the prop type lie about what the component
  consumes, which is how the two orphaned files above stopped being noticed. The comment says
  to "drop them from App's call site and from here in the same later change" — that change has
  not happened, and the note is the only thing holding the intent.
- **Fix**: Remove the four props from the type and from `App.tsx:3219-3239` in one edit.

### [MED] `selectWritableSelection` is dead, and its rule is re-derived inline three times

- **Where**: `/Users/pt/cat-code/app/renderer/src/sessionsPageState.ts:191-201`;
  inline copies at `SessionsPage.tsx:236`, `SessionsPage.tsx:443`, `SessionsPage.tsx:604`
- **Type**: dead-code / duplication
- **What**: The selector exists specifically to own "which selected rows can receive a write
  verb" (its doc comment names Rename/Export/Branch/Tag). Its only caller is
  `sessionsPageState.test.ts:103`. `SessionsPage` instead writes `row.live && row.appSessionId
  != null` three separate times: in `applyTag` (line 236), in `writableCount` for the bulk bar
  (line 443), and as `writable` per row (line 604).
- **Trigger / why it matters**: The predicate is a security-adjacent gate (it decides which
  sessions a bulk write reaches). Four copies of it, one of which is covered by tests and none
  of which is used, means a change to the rule is a four-site edit where the tested site is the
  one that does not matter. This is the "duplicating logic that already exists" pattern CLAUDE.md
  §8.10 names.
- **Fix**: Have `SessionsPage` call `selectWritableSelection` (returning `appSessionId`s) or
  export a single `isSessionWritable(row)` predicate from `sessionsPageState.ts` and use it at
  all three sites.

### [MED] Session rows are `role="button"` while containing three nested buttons

- **Where**: `/Users/pt/cat-code/app/renderer/src/SessionsPage.tsx:753-778`
- **Type**: quality (accessibility)
- **What**: The comment at line 753 explains the row is a `div` rather than a `button`
  precisely because "a button may not contain buttons" — and then line 758 applies
  `role={openable ? 'button' : undefined}` to that same div, which contains the selection
  checkbox (line 628), the rename input (line 657), the tag control (line 703), and the ⋯
  trigger (line 713).
- **Trigger / why it matters**: `role="button"` makes the element a leaf in the accessibility
  tree. Screen readers presentationally flatten its contents, so the four nested controls lose
  their own roles and names — the checkbox stops announcing `aria-pressed`, and the rename
  input (`aria-label="Session name"`) becomes unreachable by role. The ARIA fix the comment
  set out to make was undone by the role attribute one line later.
- **Fix**: Drop `role`/`tabIndex` from the container and put them on the row's title element
  (the `<span>` at line 676), or keep the div as a plain `listitem` and let the existing
  `onClick` serve pointer users with an explicit "Open" control for keyboard users.

### [MED] `AgentsPage`, `MemoryPage`, and `RemoteSettingsPage` each carry an unreachable standalone layout

- **Where**: `AgentsPage.tsx:90-100,148-153`, `MemoryPage.tsx:51-79`,
  `RemoteSettingsPage.tsx:50-73`
- **Type**: dead-code
- **What**: All three are imported only by `SettingsShell.tsx` (lines 603, 599, 614), which
  always passes `embedded`. The `embedded === false` branch — the `<main>` wrapper,
  `MemoryHeader`, `RemoteSettingsHeader`, the `AgentsPage` `<h1>` + "N active" line — is
  unreachable in production. `AgentsPage`'s standalone header is the only place `counts.active`
  is rendered at all outside the summary card.
- **Trigger / why it matters**: Three components carry a second layout, a second heading, and a
  second copy of the page title that no route reaches, and it is invisible in tests because the
  suites render them directly. `MemoryPage`'s `<h1>Memory</h1>` and `SettingsShell`'s own
  `<h2>` for the same rail item would both render if the flag were ever flipped.
- **Fix**: Delete the `embedded` prop and the standalone branches; these are settings panes, not
  pages. If a standalone route is planned, that is the moment to add it back.

### [MED] `PathCopyButton` and `EmptyState` are each duplicated verbatim across two files

- **Where**: `AgentsPage.tsx:417-454` vs `MemoryPage.tsx:326-363` (`PathCopyButton`);
  `AgentsPage.tsx:167-174` vs `SessionsPage.tsx:900-905` (`EmptyState`)
- **Type**: duplication
- **What**: `PathCopyButton` is byte-identical in both files except for one `font-sans` class in
  the `AgentsPage` copy — same clipboard guard, same toast strings, same 1200 ms `setCopied`
  reset, same `aria-label` shape. `EmptyState`'s markup is identical down to the utility strings
  (`py-14 text-center`, `mb-1 text-sm font-medium text-text-subtle`, `text-xs text-text-subtle/75`);
  only the prop names differ (`title`/`hint` vs `headline`/`subtext`).
- **Trigger / why it matters**: Both are pure presentational leaves with no page-specific logic,
  so there is no reason for two of each. The `font-sans` divergence is already the first drift:
  the same button renders in a different typeface on two settings panes.
- **Fix**: Move both into a shared module (`PathCopyButton` next to `toastContext.ts` consumers,
  `EmptyState` beside `Chip.tsx`) and import from both sites.

### [MED] `StartupOAuth` switches over a closed union with no exhaustiveness tripwire

- **Where**: `/Users/pt/cat-code/app/renderer/src/StartupSurfaces.tsx:409-522`
- **Type**: convention
- **What**: `StartupOAuthView` is a closed five-variant union (lines 238-243). The renderer is a
  chain of `if (view.phase === …) return …` with a bare fallthrough `return` for the `'ready'`
  case. There is no `default` assigning to `never`, so `view` is never narrowed to `never` at
  the end.
- **Trigger / why it matters**: Adding a sixth phase to `StartupOAuthView` (say
  `'waiting_for_alias_retry'`) compiles clean and silently renders the **provider-chooser**
  screen — mid-flow, after the browser has already been opened. The repo's own convention
  (`CLAUDE.md` §7) requires the tripwire precisely so `tsc` catches this; `SettingsEditors.tsx`
  `IntField` (lines 525-528) does it correctly in the same package.
- **Fix**: Restructure as `switch (view.phase)` with the `'ready'` body in its own case and
  `default: { const exhaustive: never = view; return exhaustive }`.

### [MED] The Welcome screen's Codex table has seven unlabeled columns

- **Where**: `/Users/pt/cat-code/app/renderer/src/WelcomeScreen.tsx:557-585`
- **Type**: quality (accessibility)
- **What**: `CodexRow` lays out
  `[account | bar | pct | reset | bar | pct | reset]` in a bare CSS grid with no header row and
  no per-cell label. `UsageBar` renders a naked `<div>`; `UsagePct` renders a bare `"57%"`;
  `ResetCell` renders a bare `"4h56m"`. Nothing on screen says which pair is the 5-hour window
  and which is the weekly one, and the last cell is always empty by design (line 582).
- **Trigger / why it matters**: A user with two accounts sees four bars and four percentages
  with no legend. `AccountsPage`'s `HeadroomBar` renders the exact same two values with visible
  `"5h"` / `"wk"` labels (lines 599-605), so the same data is legible on one page and not on the
  other. For assistive tech the row reads as "alias, 57%, 4h56m, 12%" with no structure at all.
- **Fix**: Add a header row (or per-cell `aria-label`s) naming the 5h and weekly windows, matching
  the `HeadroomBar` labels.

### [MED] The Welcome screen's usage meters hardcode pink and ignore the accent theme

- **Where**: `/Users/pt/cat-code/app/renderer/src/WelcomeScreen.tsx:599, 614`
- **Type**: quality
- **What**: `UsageBar` uses `bg-gradient-to-r from-[#f9a8d4] to-[#ec4899]` and `UsagePct` uses
  `text-[#ec4899]` / `text-[#f9a8d4]` — literal pink hexes rather than `--accent`. These are
  static arbitrary values so Tailwind does generate them (no dynamic-class trap here), but they
  are outside the theming mechanism.
- **Trigger / why it matters**: `accentTheme.ts` ships five accents (`pink`, `blue`, `green`,
  `purple`, `amber`) and `AccentThemeProvider` repaints the whole shell through `--accent`. Pick
  Blue in Settings ▸ This app ▸ Appearance: every other surface retints, and the Welcome screen's
  Codex bars and percentages stay pink. `accentTheme.ts:11-19` is explicit that "every
  accent-tinted class in the app already resolves through `--accent` … so one attribute repaints
  all of them" — these three classes are the exception that breaks the claim.
- **Fix**: Use `from-accent-soft to-accent` and `text-accent` / `text-accent-soft`.

### [MED] Internal vocabulary and unbuilt-feature explanations rendered to users

- **Where**: `StartupSurfaces.tsx:417-418`; `SettingsExtensions.tsx:300-302`;
  `AgentsPage.tsx:375-376, 390`; `SettingsShell.tsx:283-292`
- **Type**: convention
- **What**: Four user-readable strings name internals or explain why something was not built,
  which `CLAUDE.md` §7 rules out:
  - `"Your Codex account appears once the engine captures the callback."` — the callback capture
    is our plumbing, not the user's model.
  - `"the … flags are read-only here (toggling is deferred to a settings writer)"` — "deferred to
    a settings writer" is an internal work item printed on the page.
  - `"present, withheld"` / `"present, payload withheld"` / `"present, config withheld"` in the
    agent detail grid — "withheld" is security-boundary vocabulary; the user reads it as an error.
  - `"Anything this page does not show lives in the same file … , which holds no settings yet."`
    — a sentence about the page's own coverage rather than an action.
- **Trigger / why it matters**: §7's rule is "tell the user what to DO, not why we have not built
  it"; the `settingsRowNote` helper (`settingsScope.ts`) already models the right shape by
  returning null for the ordinary case. `SettingsShell`'s own `PermissionsPane` gets this exactly
  right one screen away: `"The mode a session starts in. Change it from the CLI."` (line 682).
- **Fix**: Rewrite each as an action or delete it: "Your account appears here once you finish in
  the browser."; "Change these in the agent's own file."; "Set, not shown here."; drop the
  coverage sentence.

### [MED] `CodeThemePreview` duplicates the plugin config it exists to stay in sync with

- **Where**: `/Users/pt/cat-code/app/renderer/src/CodeThemePreview.tsx:41-52`
- **Type**: duplication
- **What**: `PREVIEW_REHYPE_PLUGINS` restates `TranscriptView.tsx`'s module-private
  `REHYPE_PLUGINS`. The comment concedes this and names the fix ("the drift-free form is to
  import it, which costs one word").
- **Trigger / why it matters**: The file's own header (lines 6-14) argues at length that the
  preview "MUST BE THE TRANSCRIPT'S OWN CODE BLOCK, NOT A LOOKALIKE" because a lookalike "would
  drift from what a fenced block actually looks like the moment either side is touched". The
  duplicated tokenizer config is exactly that drift vector: change `detect` or `ignoreMissing` in
  `TranscriptView.tsx` and the theme picker starts advertising a highlighting behavior the
  transcript no longer has. The stated reason for the copy — the file "was under concurrent edit"
  — has expired.
- **Fix**: `export const REHYPE_PLUGINS` in `TranscriptView.tsx` and import it here.

### [LOW] The alias input's only accessible name is its placeholder

- **Where**: `/Users/pt/cat-code/app/renderer/src/StartupSurfaces.tsx:373-380`; also
  `PasteCodeFallback` input at lines 304-309, `SessionsPage.tsx:271-276` search input
- **Type**: quality (accessibility)
- **What**: `AliasForm`'s input has `autoFocus` and `placeholder="work · personal · team-a"` but
  no `aria-label` and no `<label>`. Its computed accessible name is therefore
  "work · personal · team-a", which names three example values rather than the field.
- **Trigger / why it matters**: The identical control on `AccountsPage` does it right
  (`aria-label="New alias"`, line 321), and `SettingsShell`'s search input does too
  (`aria-label="Search settings"`, line 303), so this is inconsistency rather than an unknown
  pattern. `RemoteSettingsPage:310-320` shows the best form in scope, a real `<label htmlFor>`.
- **Fix**: Add `aria-label="Account alias"`, `aria-label="Authorization code"`, and
  `aria-label="Search sessions"` respectively.

### [LOW] `GoalsPage` renders an internal goal id and conflates loading with empty

- **Where**: `/Users/pt/cat-code/app/renderer/src/GoalsPage.tsx:32, 62-64`
- **Type**: convention / quality
- **What**: The status header prints `{goal.goalId}` in mono beside the badge — an internal
  identifier with no user meaning (§7 bars rendered session ids). Separately, `snapshot === null`
  is the only non-goal branch, so it renders "No active thread goal" both before the snapshot
  arrives and when there genuinely is none.
- **Trigger / why it matters**: Open the Goals page on a session that does have a goal: for the
  window before the frame lands, the page asserts there is none and tells the user to run
  `/goal`. Every other page in scope distinguishes these — `SessionsPage`'s `EmptyState` takes a
  `catalogLoaded` flag (lines 877-899), `AccountsPage` has a dedicated `WaitingState` (line 677),
  `MemoryPage` and `SettingsExtensions` both have `WaitingRow`/`WaitingState`.
- **Fix**: Drop the `goalId` line; add a `loaded` prop (or a third snapshot state) so the empty
  copy is only claimed once a read has happened.

### [LOW] `PathCopyButton`'s reset timer is never cleared

- **Where**: `AgentsPage.tsx:431`, `MemoryPage.tsx:340`
- **Type**: correctness
- **What**: `setTimeout(() => setCopied(false), 1200)` runs outside any effect and has no
  cleanup.
- **Trigger / why it matters**: Copy a path in `AgentInspectDrawer`, then press Escape within
  1.2 s — the drawer unmounts and the timer still fires `setCopied` on a dead component. React 18
  no longer warns, so this is a stray timer rather than a visible bug, but the button is rendered
  once per instruction file and once per auto-memory row, so a page with 30 rows holds 30
  independent uncancelled timers if the user clicks around.
- **Fix**: Store the handle in a ref and clear it in a `useEffect` cleanup, or drive `copied` off
  a `useEffect` keyed on the copy event.

### [LOW] Relative timestamps freeze until an unrelated re-render

- **Where**: `SessionsPage.tsx:147` (`const now = Date.now()`), `MemoryPage.tsx:230`,
  `WelcomeScreen.tsx:650` (`formatResetCompact` reads `Date.now()` at call time),
  `accountsPageModel.ts:154` (`formatResetLabel` default arg)
- **Type**: quality
- **What**: Every relative-time string is computed during render with no ticker.
- **Trigger / why it matters**: Leave the Sessions page open. "2m ago" stays "2m ago"
  indefinitely, and the Accounts page's "Resets in 4h 12m" likewise, because nothing schedules a
  re-render. On Accounts this is load-bearing copy — it is the answer to "when can I use this
  account again" and it is shown on a page a user parks on while waiting.
- **Fix**: One `useEffect` interval per page bumping a `now` state every 30–60 s.

### [LOW] Dead exports: `SessionsPageAnchor`, `RemoteRolePill`

- **Where**: `sessionsPageState.ts:28`, `RemoteSettingsPage.tsx:88`
- **Type**: dead-code
- **What**: `SessionsPageAnchor` has no importer anywhere (`SessionsPage` uses
  `SessionActionsAnchor` from `SessionActionsMenu.js` instead). `RemoteRolePill` is exported but
  used only at line 308 in its own file, and not by any test.
- **Trigger / why it matters**: `SessionsPageAnchor` and `SessionActionsAnchor` are two names for
  overlapping concepts in one feature, which is the "names that differ for the same concept"
  smell; the unused one should not survive to be picked by mistake.
- **Fix**: Delete `SessionsPageAnchor`; drop `export` from `RemoteRolePill`.

### [LOW] `AgentsPage` renders a constant dressed as data

- **Where**: `/Users/pt/cat-code/app/renderer/src/AgentsPage.tsx:358`
- **Type**: quality
- **What**: `['Provider', 'runtime-selected']` is a hardcoded row in the agent detail grid; it
  reads the same for every agent and is styled in mono like the real fields around it.
- **Trigger / why it matters**: §7's "say only what is surprising" — a field that never varies
  carries no information but occupies a labeled row in a grid where every neighbour is real
  engine data, so the user reasonably reads it as this agent's configured provider.
  `settingsRowNote` (`settingsScope.ts`) is the house pattern for this: return null for the
  ordinary case.
- **Fix**: Remove the row.

## What is good here

- **The dynamic-class trap is genuinely closed, and closed the right way.** `AGENT_DOT_CLASS`
  (`AgentsPage.tsx:60-69`), `ACCENT_SWATCH_CLASS` (`accentTheme.ts:50-56`), `SOURCE_BADGE_CLASS`
  (`SettingsField.tsx:24-32`), and `MEM_TYPE_CLASS` (`MemoryPage.tsx:210-215`) are all static
  hex→class maps with a comment saying why. Zero interpolated arbitrary values in 7,695 lines.
- **The "refuse to state what we have not read" discipline is unusually rigorous.**
  `settingsReadState.ts`'s `SETTINGS_UNKNOWN_VALUE` threaded through `SettingControl`
  (`SettingsEditors.tsx:255-261`) renders *no control at all* rather than a disabled one at a
  guessed position, on the argument that "a position is a claim about the operator's file".
  `ManagedPanel` (`SettingsShell.tsx:948-972`) applies the same rule to "nothing is enforced".
  This is the right instinct and worth copying to `GoalsPage`.
- **Correlate-by-requestId with no optimistic UI**, implemented identically in `AccountsPage`
  (lines 716-747) and `RemoteSettingsPage`'s `BridgePanel` (lines 123-141): mint an id, dispatch,
  and toast only when the matching result frame arrives. `TouchAllDialog` (line 420) even
  documents why it self-correlates outside the page's generic pending slot.
- **`sessionsPageState.ts` is a model renderer state module**: `create`/`reduce`/`select` naming,
  a pure reducer, read-time selectors, an identity-stable no-op return in `catalog-settled`
  (lines 143-150) so `useReducer` bails out, and a header that states the two things it
  deliberately does *not* store and why.
- **User-visible text is clean on the hardest rule.** Not one em dash reaches a screen across
  seventeen files, and the copy that replaced older prose is noticeably better —
  `NOT_LIVE_REASON = 'Open or restore this session first.'` and the bulk bar's
  `Exports 3 of 7: the rest are closed.` both name the action instead of the limitation.

## Not reviewed / uncertain

- **Colocated test files were not reviewed for quality**, only consulted to confirm call sites
  (`sessionsPageState.test.ts` for the dead `selectWritableSelection`, `resolveTagCommit`'s
  expectations at lines 208-213). The scope named "their colocated tests"; I read them as
  evidence, not as subjects. Notably, `sessionsPageState.test.ts:209` asserts
  `resolveTagCommit('  ', known)` is null and stops there — it never exercises the *caller's*
  empty-query path, which is exactly why the HIGH finding survives a green suite.
- **No test was executed.** The contract permits `bun test <one file>` sparingly; I verified every
  finding by reading source and grepping call sites instead. The HIGH finding is proven by
  construction (`''.includes('')` is true, so `selectMatchingTags('')` returns all tags) rather
  than by a run.
- **Cross-file behavior I could not verify from this scope**: whether `App.tsx` guards against a
  `session.tag` verb for a row that stopped being live between render and dispatch. `applyTag`
  (`SessionsPage.tsx:236`) filters on `row.live`, but the row list is a prop snapshot; the sidecar
  re-resolves targets for account verbs (T6) and I did not confirm the same holds for
  `session.tag`. Reading `app/sidecar/sessionActions` handling would resolve it.
- **Not assessed**: whether the accent-token fix I propose for `WelcomeScreen`'s usage bars is
  acceptable as *prototype parity* — the comment at line 588 states the prototype deliberately
  uses one flat pink for every account, unlike `AccountsPage`'s threshold colouring. My finding
  is about theme responsiveness (pink stops being the accent), not about the flat-vs-threshold
  choice, but an operator ruling may be needed since `--accent` under a non-pink accent changes
  the deliberate visual distinction between the two surfaces.
- **Item 7 of the brief (AccountsPage secrets) is closed clean.** No token, key, or credential is
  rendered, masked or otherwise. The only identifiers on screen are `account.alias ?? account.id`
  (an OpenAI account UUID, documented at `protocol.ts:1869-1876` as an addressing identifier and
  explicitly not blocked by `secretGuard`), `account.email` for Anthropic rows, and
  `availabilityLabel` / `lastError`, both documented as redacted at the wire
  (`protocol.ts:1884, 1903`). I verified the renderer side only; I did not re-verify that the
  sidecar populates those fields from a redacted source.
