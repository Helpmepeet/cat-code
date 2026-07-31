# Desktop app (`app/`) — UI/UX gap audit

**Date:** 2026-07-31 (revised same day after cold review)
**Scope:** `app/renderer/src` (all surfaces), plus `app/main/main.ts` window config where it bears on layout.
**Type:** UX audit. Not a bug hunt, not a security review, not a parity re-count.
**Status:** rev 3, with rev-4 prototype-coverage corrections applied inline.
Revs 1 and 2 were both returned RED; see [Revision history](#revision-history).
**Companion:** `2026-07-31-app-ux-gap-prototype-coverage.md` classifies every finding below by
whether the prototype already solves it (7 portable · 8 already-decided · 12 need fresh design).
Consult it before designing anything here.

## How to read this report

Three claim types, kept separate on purpose:

- **Source-verified** — a `file:line` citation was read and confirmed by the lead. Safe to act on.
- **Hypothesis** — a frequency, severity, or effort claim. **Not** evidence-backed: this was a
  source-only audit with no GUI run, no telemetry, and no operator observation. Marked *(hypothesis)*.
  Do not order work by these without validating them.
- **Operator question** — a proposal that would reverse a recorded ruling. **Not** a recommendation.
  Listed so the decision is visible, never as a backlog item. Marked *(operator question)*.

Priority tiers below reflect the lead's judgment, which is itself a hypothesis. The
[Highest-confidence work](#highest-confidence-work) section at the end is the part that does not
depend on the ranking being right.

## Method

Three parallel source audits. Lanes A and B have disjoint **surface** scopes; lane C owns the
remaining surfaces and additionally sweeps three **lenses** across the whole renderer, so it
deliberately revisits A's and B's files through those lenses only.

| Lane | Scope |
|---|---|
| A | App shell, onboarding, navigation, session lifecycle |
| B | Conversation surface: transcript, composer, permissions, in-conversation feedback |
| C | Settings / accounts / agents pages, **plus** accessibility, responsiveness, and theme as a cross-cutting lens over the whole renderer |

Every high-impact claim was then re-verified against source by the lead. Started from 41 raw
findings; merged 9 duplicates, cut 6 as weak or already-ruled.

**Current population: 26 numbered findings** (1 through 26, with 5a added and 24 reduced in rev 3),
plus **2 operator questions** (O1, O2) that are excluded from the backlog. The two rev-1 proposals
that became O1 and O2 were removed from their parent findings, not deleted; those findings survive
with their non-reversing halves.

No GUI was launched (§8). The renderer suite is SSR-only, so interaction and timing are
structurally invisible to a source audit; see [Open questions](#open-questions-worth-one-operator-run).

## Framing

`docs/migration/PARITY-LEDGER.md` already tracks 1,875 rows, of which **145 are ❓ missing** at 79%
realized parity (Part D totals, `PARITY-LEDGER.md:2600`; the ledger's own 127 headline is stale and
should be reconciled separately). This report is deliberately **not** that list. It is ranked by
hypothesized user pain, and several items are cheap fixes the ledger classes as low-priority
deferrals because it ranks by prototype fidelity instead.

---

## P0 — Blocks or degrades the core loop

### 1. Mid-turn typing is swallowed with no queue and no honest signal

- **Where** — `App.tsx:3227` (`generating`), `:3790` (`readOnly`), `:3247` (placeholder), `composerState.ts:398`.
- **User goal** — Add "also update the tests" while the agent is working, instead of waiting.
- **What is missing** — The block is intentional and guarded by `App.test.tsx:500` ("the engine owns
  that"). Nothing compensates. The placeholder still reads "Ask Cat Code anything or describe a
  task…" because it only changes for non-`ready` statuses; the caret still blinks and the focus ring
  still lights. Keystrokes vanish. The `pendingSubmit` park exists (`composerState.ts:462`) but
  covers only the *connecting* case. The terminal engine has a real queue with a rendered strip
  (`src/hooks/useCommandQueue.ts`, `src/components/PromptInput/PromptInputQueuedCommands.tsx`).
- **Why it matters** — The user cannot distinguish "input is closed" from "the app is frozen".
  *(hypothesis: this affects most long turns; unmeasured.)*
- **Improvement** — Extend the existing park to mid-turn: keep the textarea editable, route submit
  into a per-session queue, render it in the strip already built at `App.tsx:3681`, drain on the next
  `inputEnabled: true`. Minimum viable and independently shippable: swap the placeholder so the
  read-only state is legible. **Open:** whether the sidecar would accept a queued submit decides
  whether this is renderer-only.

### 2. Global account and settings reads exist; global account writes do not

> **Rev 2 correction.** Rev 1 claimed OAuth "spins forever" with no session and proposed a one-line
> fix. Both were wrong. Corrected below.
>
> **Rev 4/5 reclassification — this finding splits in two.**
>
> **2a, account and trust: an operator question.** The prototype gates trust and OAuth at app level
> before any session exists (`cat-app/Startup.jsx:461-489`), which is what this half asks for, but
> `decisions/STARTUP-GATES.md` §1.1 deliberately made trust **per-session-create** instead. Not a
> backlog item without an operator ruling.
>
> **2b, the session-free user-settings read: actionable now.** `settingsScope.ts:33` states that
> the **user layer is session-invariant**, so reading My defaults without a session is
> architecturally clean and is **not** governed by the trust ruling. Rev 4 implied the whole finding
> sat behind STARTUP-GATES; that would have parked valid work.

- **Where** — `App.tsx:2396` + `accountsState.ts:106` (accounts snapshot); `App.tsx:1178`
  (`sendAccountVerb` no-session path); `settingsReadState.ts:45` (settings).
- **User goal** — Open the app for the first time and sign in, or set defaults before starting work.
- **What is missing** — Three surfaces degrade with no session, for one shared reason, but **not**
  the reason rev 1 gave:
  - `selectAccountsSnapshot` returns `null` with no `activeSessionId`, so `shouldShowFirstRunOAuth`
    (`appModel.ts:14`) is structurally unreachable on a genuine first launch. The user's only path to
    sign-in is: guess they must pick a folder, native picker, session spawns, trust gate, *then* the
    card appears. Nothing on screen suggests that sequence.
  - Settings renders "No session is open, so your settings files have not been read yet."
    (`settingsReadState.ts:45`) with no controls at all, so the Settings nav item always looks broken
    on first click.
  - Account **verbs** are the constraint, not a bug: with no session `sendAccountVerb` returns an
    explicit `ok: false` result reading "Open a session first, then change accounts from there."
    (`App.tsx:1178`). The flow does **not** hang, and the paste-code fallback and `error` phase both
    exist (`StartupSurfaces.tsx:222-226,256`).
- **Why it matters** — The reads are session-scoped by accident; the writes are session-scoped by
  necessity, because a verb needs an engine process to carry it. Naively switching the first-run gate
  to `selectGlobalAccountsSnapshot` would **expose a sign-in surface with no process to execute it**,
  manufacturing the dead end rev 1 wrongly claimed already existed.
- **Improvement** — Needs a host-plane design owner, not a patch. The shape to decide: whether
  account writes get a host-plane path (as accounts *reads* did in CC-20,
  `decisions/ACCOUNTS-OWNERSHIP.md`), or whether the first-run surface explicitly spawns a session to
  carry the login. The `user` settings scope is the separable, lower-risk half: it is documented as
  session-invariant (`settingsScope.ts:31`) and could move to a host-plane read on the CC-20 pattern
  independently of the account-write question.

### 3. Permission prompts show raw JSON instead of the command or the diff

- **Where** — `PermissionPrompt.tsx:110`, `JSON.stringify(request.request.input, null, 2)` in a
  144px `<pre>`, for every tool.
- **User goal** — Decide whether to approve a shell command or a file edit.
- **What is missing** — A Bash approval means reading `{"command": "…", "timeout": 120000}`. An Edit
  means reading `old_string`/`new_string` as escaped JSON with literal `\n`, a diff the app already
  renders well via `DiffView` (`TranscriptView.tsx:2236`) but does not use here. The terminal has 15
  per-family renderers (`src/components/permissions/`).
- **Why it matters** — This is the app's only safety gate and its least legible surface.
  *(hypothesis: unreviewable diffs train approve-without-reading; plausible but unobserved.)*
- **Improvement** — Branch on `tool_name`: Bash to the command in mono; Edit/Write to a
  `ToolDiffProjection` mounted in `DiffView`; WebFetch to the URL. Keep the JSON as a collapsed
  "Show raw input" fallback for unrecognized tools.

### 4. Nothing on the tab bar shows which session is currently working

> **Rev 2 correction.** Rev 1 also proposed a sidebar status dot. Removed: that reverses a recorded
> operator decision. See [operator question O1](#o1-sidebar-session-state).

- **Where** — `tabStatus.ts:51` (`deriveTabVisualState`), `sessionStatusVisual.ts:47`.
- **User goal** — Run several sessions in parallel and know which is thinking.
- **What is missing** — The `busy` tone exists in the type and in both class maps
  (`TabBar.tsx:402,415`) but has **exactly one producer**: the preview pseudo-tab (`App.tsx:947`). A
  tab mid-turn is pixel-identical to one that finished ten minutes ago. The signal already exists and
  is already passed in: `connection.status === 'ready' && !inputEnabled`, received by
  `deriveTabVisualState` at `tabStatus.ts:53` and unused.
- **Why it matters** — Multi-session is a headline feature; without an indicator the user polls by
  clicking tabs. *(hypothesis: frequency scales with parallel use; unmeasured.)*
- **Improvement** — Return `{ tone: 'busy' }` from `deriveTabVisualState` on that condition. This
  stays entirely within the TabBar, which `Sidebar.tsx:29` names as the surface that legitimately
  carries live/dead/busy state.

---

## P1 — Friction and legibility

### 5a. Transcript retention `0` destroys existing history, with no confirmation and no way back

> **Rev 3 correction.** Rev 1 called this a copy-versus-behavior mismatch; rev 2 "corrected" that to
> say the copy is honest and existing rows are unaffected. **Rev 2 was wrong in the dangerous
> direction** and is the reason this is now P1 rather than P2.

- **Where** — `SettingsEditors.tsx:441` (`IntField`, commits on blur);
  `app/shared/settingsEditable.ts:235` (the visible description); engine semantics at
  `src/utils/settings/types.ts:331`; cleanup at `src/utils/cleanup.ts:25-30`.
- **User goal** — Reduce how long transcripts are kept.
- **What is missing** — `0` does not merely stop future writes. The engine's own schema description
  states it plainly: "Setting to 0 disables session persistence entirely: no transcripts are written
  **and existing transcripts are deleted at startup**" (`types.ts:331`). `getCutoffDate()` multiplies
  the period by a day in ms, so `0` yields a cutoff of *now* and startup cleanup sweeps everything
  (`cleanup.ts:25-30`). Typing `0` and tabbing away commits silently, with no confirmation; per
  finding 15 the key then cannot be un-written from the UI; and the loss lands on the *next launch*,
  far from the action that caused it.
- **Why it matters** — Irreversible destruction of all session history, reachable by editing a
  number field and clicking away. The description is honest but appears in a field subtitle, and it
  does not say the deletion is retroactive in a way a skimming user would catch.
- **Improvement** — Treat `0` as a distinct destructive choice, not a value: an explicit confirm
  before commit naming the actual consequence ("Past sessions will be deleted the next time the app
  starts, and cannot be restored"), commit on Enter rather than blur for this key, and a persistent
  inline warning while the value is `0`. Pair with finding 15 so the choice is reversible.

  > **Rev 5.** Rev 4 replaced this with "remove `0` from the domain", deriving a 30/60/90/Forever
  > enum from the prototype. **Withdrawn — the prototype's select is mock state, not the contract.**
  > The engine accepts any nonnegative integer and the desktop registry declares
  > `{ kind: 'int', min: 0, max: 3650, default: 30 }` (`app/shared/settingsEditable.ts:240`), so an
  > enum would delete every legitimate value in between (7, 45, 365) and `Forever` has no wire
  > representation. The confirm-based fix above is restored as the recommendation.

### 5. A failed turn shows one word and drops the error text it already has

> **Rev 2 correction.** Rev 1 filed this P0 on a "retype from memory / data loss" rationale. That was
> wrong: `retireDraft()` pushes the submitted text into `↑`/`↓` history (`App.tsx:1789`), and a
> synchronous bridge throw does not retire the draft, so the prompt is recoverable on both paths.
> Demoted to P1 and re-argued on legibility alone.

- **Where** — `TranscriptView.tsx:443` passes only `isError`/`subtype`/`durationMs`/`totalCostUsd`
  to `ResultSeam`; `transcriptProjector.ts:851` projects `result` and `errors[]`, both dropped.
- **User goal** — Find out *why* the turn failed.
- **What is missing** — The user gets a thin rule reading `Errored · 12.4s · $0.0031`. The failure
  text is on the row and never rendered, so the app knows the reason and does not say it. There is
  also no resend affordance, though recovery via `↑` is available.
- **Why it matters** — A diagnosable failure is presented as undiagnosable.
- **Improvement** — Render `errors[0]` under the seam in `tone-danger`, truncated with a "show
  more". Optionally add "Send again" that repopulates the composer from the nearest preceding
  `user-text` row; this is convenience over `↑`, not recovery.

### 6. Read and Write output is cut at 400 lines with no note, and the escape hatch cannot be copied

- **Where** — `TranscriptView.tsx:1229` (`NumberedBody`) and `:1245` (`AdditionsBody`);
  `ToolInspector.tsx:102`.
- **User goal** — Read what a tool actually returned.
- **What is missing** — Both bodies `.slice(0, MAX_INLINE_TOOL_LINES)` and render nothing, while
  `BashBody` and `PlainLinesBody` do call `ToolOverflowNote` (`:1302`). A 900-line file read shows
  400 lines that simply stop, so the last visible line looks like the end of the file. The inspector
  those other bodies point users to has no copy button and no search.
- **Why it matters** — Silent truncation is worse than visible truncation: the user forms a wrong
  belief about the file's contents, with no cue to doubt it.
- **Improvement** — Add `<ToolOverflowNote …/>` to both bodies (two lines each; the component
  exists). Add a copy button to `ToolInspector`, reusing the `CodeBlock` pattern at
  `TranscriptView.tsx:674`.

### 7. You cannot copy an assistant message

- **Where** — `TranscriptView.tsx:518` (`AssistantProse`); compare `BubbleCopyChip` at `:1329`,
  mounted only in `UserBubble` at `:1406`.
- **User goal** — Take the agent's answer into a commit message, a doc, or a chat.
- **What is missing** — The user's *own* message has a hover copy chip and fenced code blocks have
  one; the assistant's prose has neither. The only whole-message paths export the entire session as
  raw JSON with a sensitive-content warning.
- **Why it matters** — Hand-selecting rendered markdown loses formatting and picks up interleaved
  tool cards. *(hypothesis: several times per session; unmeasured.)*
- **Improvement** — Reuse `BubbleCopyChip` with the raw markdown, but **this is not a drop-in mount**
  as rev 2 claimed. The chip is `absolute bottom-1.5 right-2 opacity-0` and reveals via
  `group-hover` / `group-focus-within` (`TranscriptView.tsx:1352`), while `AssistantProse`'s wrapper
  is a bare `<div>` that is neither `relative` nor `group` (`:533`). Mounted as-is it would position
  against a distant ancestor and stay invisible to pointer users. The work is designing a positioned
  group wrapper that also behaves under streaming and the collapsed-prose branch.

### 8. Shell failures land in an undismissable one-line bar with no retry

> **Rev 2 correction.** Rev 1 bundled this with a proposal to mount `BannerStack` for account and
> quota state. Removed: that reverses a recorded operator decision. See
> [operator question O2](#o2-account-and-quota-surfacing).

- **Where** — `App.tsx:2722` (the bar), written by seven paths: `newSession` `:1118`,
  `newSessionInWorkspace` `:1138`, `closeTab` `:1576`, `restartTab` `:1589`, `restoreLiveSession`
  `:1635`, `openHistorySession` `:1727`, `performRestore` `:1702`.
- **User goal** — Understand why the session did not open, and try again.
- **What is missing** — Seven distinct failures funnel into one bare red line with no icon, no
  dismiss, no retry, and no indication which session or action it refers to. It clears only as a side
  effect of the next successful operation, so a stale error can sit indefinitely while an unrelated
  success wipes one the user has not read.
- **Why it matters** — "Restore didn't work" is answered with a sentence and nowhere to click.
- **Improvement** — Give the bar a dismiss control and name the session and verb, or route these
  through the existing toast channel (`App.tsx:1386,1416`) with retry bound to the session id for the
  three verbs where retry is meaningful. This concerns **shell lifecycle errors only** and is
  untouched by the STARTUP-GATES ruling, which governs account health surfacing.

### 9. Interrupting renders as a message the user never wrote

- **Where** — no `interrupted` case in `transcriptProjector.ts`; `INTERRUPT_MESSAGE`
  (`src/utils/messages.ts:213`) arrives as an ordinary user frame and lands at
  `TranscriptView.tsx:389`.
- **User goal** — Stop the agent and understand what state the conversation is in.
- **What is missing** — The transcript gains a right-aligned pink `UserBubble` reading
  `[Request interrupted by user]`. No "Interrupted" seam, no next-step prompt, no distinction from a
  message the user actually typed. The terminal has a dedicated `src/components/InterruptedByUser.tsx`.
- **Why it matters** — The transcript contains a fake user turn that both the human and the model see
  on resume.
- **Improvement** — Add an `interrupted` row kind rendered through the existing `Seam`
  (`TranscriptView.tsx:2004`). **Do not match the engine's literal interrupt strings in the
  renderer** — that duplicates engine machinery (§8 rule 10) and breaks silently when the constant
  changes. Prefer engine-authored provenance on the frame or a shared wire-safe identifier; that is a
  protocol question, so it needs an owner before the renderer half is written.

### 10. No file completion and no attachment payload

> **Rev 2 correction.** Rev 1's title claimed you cannot reference a file by path. False: a
> free-typed `@path` submits as ordinary text (`composerState.ts:66`).

- **Where** — `ComposerActionsBar.tsx:1042` (attach button) whose handler is a toast at
  `App.tsx:3855`; `composerState.ts:60` (mentions offer agents only).
- **User goal** — Point the agent at a file without typing the path exactly, or drop in an image or log.
- **What is missing** — Two separable things. **Completion:** typing `@src/foo` produces no
  suggestions, so paths are free-typed and typo-prone; the terminal completes from `git ls-files`
  (`src/hooks/fileSuggestions.ts`). **Attachment:** the `+` button opens nothing, raising "Paste a
  large block to attach it as a collapsed chip.", and there is no drag-and-drop handler.
- **Why it matters** — The `+` button reads as broken rather than deliberate.
- **Improvement** — **Neither half is a renderer-only task**, contrary to rev 2. `composerState.ts:60-70`
  states that file mentions are absent precisely because the engine's `@`-file index is not on the
  wire and surfacing it requires a new read seam; `MentionPicker.tsx:51-58,71-102` is a
  data-source-agnostic primitive whose optional tabs render only when a caller supplies items, and
  App supplies agents only. So completion is a **cross-plane read-seam feature** needing a
  host/sidecar owner and the normal boundary review (§5 security baseline), not a UI patch.
  Attachment is separate and larger still: no attachment payload exists on the wire, so a native
  picker that only inserts a path string is a different, smaller feature and should be labeled as
  such rather than sold as "attachments".

### 11. Drafts and prompt history are lost on restart, and empty on restore

- **Where** — `App.tsx:414,420`, both plain in-memory `useState`.
- **User goal** — Come back to a half-written prompt, or recall a prompt from a previous run.
- **What is missing** — Quitting discards every unsent draft across every session with no warning.
  `↑` recall starts empty for a *restored* session showing many turns on screen, because history is
  populated only by submits made in this process (`App.tsx:1789`). No history search. The terminal
  persists to `~/.cat-code/history.jsonl` (`src/history.ts:114`) with a Ctrl+R picker.
- **Why it matters** — The empty-history-on-restore case is misleading: the evidence that history
  exists is on screen. Note this is about *cross-run* persistence; within a run, submits do reach
  history (see finding 5).
- **Improvement** — Persist both to `localStorage` using the versioned-key pattern at
  `reasoningLayout.ts:41`. **Do not seed history from `user-text` rows unfiltered**, as rev 2
  proposed: finding 9 establishes that engine interrupt literals currently project as ordinary
  `user-text` (`transcriptProjector.ts:1573-1645` makes any unprovenanced text a `user-text` row), so
  an unfiltered seed would put `[Request interrupted by user]` into `↑` recall as though the user had
  typed it. A human-authored-history predicate is needed first, which couples this to finding 9's
  provenance decision. The `localStorage` half is independently shippable and carries no such
  coupling.

### 12. Permission keyboard shortcuts are dead exactly when they are advertised

- **Where** — hint at `PermissionPrompt.tsx:141`; guard at `App.tsx:1968` against
  `FOCUSED_KEY_OWNER_SELECTOR` (`App.tsx:367`, which includes `textarea`).
- **User goal** — Approve a tool call with one keypress.
- **What is missing** — The card prints "Enter allow · N / ⌫ deny · Esc snooze", but the handler
  bails whenever focus is inside an interactive element. The normal flow leaves focus in the composer
  after sending, so on many permission requests the advertised keys do nothing. The guard is correct;
  the hint does not know about it, and nothing moves focus when a card appears.
- **Why it matters** — An advertised fast path fails with no signal why.
- **Improvement** — **Rev 2's proposal (focus the Allow button) is insufficient** and is withdrawn:
  `button` is itself in `FOCUSED_KEY_OWNER_SELECTOR`, so focusing Allow restores Enter only through
  native button activation while N, Backspace, and Esc stay suppressed. Three of the four advertised
  keys would remain dead and the finding would be falsely closed. Two shapes actually work: move
  focus to a non-interactive card container (`tabIndex={-1}` on the `<section>`), which keeps the
  global handler live for all four keys; or bind the keys on the card itself rather than on
  `document`. Whichever is chosen, the hint must match what is actually live. Note this interacts
  with the composer's lack of autofocus; decide both together.

  **Rev 4: the first shape is the prototype's, verbatim.** `cat-app/Permissions.jsx:363` blurs the
  active element and focuses a `tabIndex={-1}` card (`:437`) on mount, with keys bound on a window
  listener. We adapted that into "window keydown ignores INPUT/TEXTAREA targets", which is the exact
  mechanism that kills the advertised keys. So this is a **revert of an adaptation**, not new design.

---

## P2 — Navigation, discoverability, configuration

### 13. Command palette routing lands on the wrong pane, and the obvious fix is insufficient

> **Rev 2 correction.** Rev 1 proposed threading `initialScope`/`initialCategory`. That does not work
> when Settings is already mounted.

`PAGE_NAV_BY_COMMAND` routes seven commands to `'settings'` (`commandPaletteModel.ts:79`), but the
mount hardcodes `initialCategory="agents"` and never passes `initialScope` (`App.tsx:2771`), so
`/mcp` lands on My defaults, Agents. `cost`/`usage`/`stats` route to Accounts, whose analytics region
is §0-deferred. **The fix is not prop-threading:** `SettingsShell` seeds `scope` and `item` via
`useState(initial…)` (`SettingsShell.tsx:179-180`), which runs once, and palette navigation carries
only a page string (`commandPaletteModel.ts:46`). Navigating from an already-open Settings page would
change nothing. **Fix:** widen the palette's nav payload to `{page, scope?, category?}` and make
`SettingsShell` route-controlled (lift `scope`/`item` to props with an `onNavigate` callback), or
give it an intentional remount key. Route-controlled is the better shape; a remount key discards the
user's scroll and query.

### 14. One advertised shortcut does not exist; the palette itself has no visible entry point

`WelcomeScreen.tsx:273` renders `⌘O` beside "Open folder…", but the chord handler implements only
k/t/w/1-9 and `app/main/` registers no `Menu`, so nothing binds it. Conversely `⌘K` is the only route
to the palette and appears in no affordance anywhere, hiding real actions (restart session, copy
transcript, background tasks). **Fix:** wire `o` or delete the hint; add a `⌘K` affordance to the tab bar.

### 15. No reset-to-default for any editable engine setting

> **Rev 2 correction.** Rev 1 said "9 of 11" and claimed a user value blocks a project default. Both
> wrong: the registry holds **14** editable keys (`app/shared/settingsEditable.ts:123`), the editor
> wires reset for **none** of them, and precedence is policy ▸ flag ▸ local ▸ project ▸ user
> (`settingsState.ts:141`), so the user layer is the *lowest*.

`SettingsEditors.tsx:189` omits `modified`/`onReset`, and the sidecar only clears a key on
`SETTINGS_ENGINE_DEFAULT`, which only `dynamic-enum` produces. Setting a value back to its default
therefore *pins* it rather than removing it. The consequence is scope-dependent and worth stating
precisely: a pinned **user** value is overridden by project, local, flag, and policy layers, so it
mostly affects machine-wide defaults; a pinned **local** value does shadow project settings. The
`Field` primitive already ships "Reset to default" (`SettingsField.tsx:184`), wired only for two
app-local prefs. **Fix:** pass `modified`/`onReset` and handle the clear token for all control kinds;
both halves exist.

### 16. Three configuration pages report state they offer no way to change

> **Rev 2 correction.** Rev 1 said "four of five sidebar destinations" and listed three items, two of
> which are Settings rail categories rather than top-level destinations.
>
> **Rev 4: split this into three backlog items; they have three different answers.** *Goals* has a
> full prototype design (per-row Resume/Pause/Replace/Clear plus a Create dialog,
> `cat-app/GoalsPage.jsx:63,110-115,226-260`) but **cannot be started**: all 25 rows are Part C ❓
> with owner UNASSIGNED, no inbound goal-mutation verb exists on the wire, and P4-10 is spent. It
> needs a goal-writer-boundary owner. *Memory* and *Agents* have no prototype backing for the asks
> below; the prototype's analogue is an **open-the-file** button (`MemoryPage.jsx:161,180`;
> `AgentsPage.jsx:306` "Edit definition"), which is a better affordance than copy-path and is
> missing from all three pages.

Memory prints "Auto-memory is enabled" for a real engine key with no toggle (`MemoryPage.tsx:107`).
Goals, a top-level sidebar destination, is entirely read-only and ends with "Use the `/goal` command"
with no button and no indication that you type it into a session composer (`GoalsPage.tsx:34`). The
Agents rail category shows a file path with no copy or reveal (`AgentsPage.tsx:337-342`). **Fix:** make
`autoMemoryEnabled` editable; add copy-path and reveal affordances; add a "Run `/goal`" button that
prefills the active composer.

### 17. Sessions-page state resets every time you open a session

Search, sort, tag filter, workspace scope, scroll, and multi-selection are all component-local
`useState` (`SessionsPage.tsx:115`), and every open path sets `activeView('chat')`, unmounting the
page. Triaging a large catalog, the page's purpose, is punishing after the first item. **Fix:** lift
the four filters plus selection into `App`, or persist them following `sidebarWorkspaceOrder.ts`.

### 18. Cold launch shows "No recent projects yet", and a failed roster read shows it forever

The launcher branch has no `hostSnapshotReady` condition (`App.tsx:2880`), so it paints empty-state
copy before `listSessions()` resolves. A *failed* read is swallowed and still sets `hostSnapshotReady`
in `.finally()` (`App.tsx:845`), so the app looks empty permanently with no error signal. **Fix:**
skeleton while `!hostSnapshotReady`; a distinct error state with Retry in the `.catch()`.

### 19. The session actions menu runs off the bottom of the window

`SessionActionsMenu.tsx:74` applies raw `top`/`left`; call sites clamp `left` only. The menu is
roughly 300px tall, so opening it from a bottom row puts Copy and Export out of reach with no scroll
(it is `position: fixed`). Its own doc comment at line 16 admits the bottom-flip "stays owned by the
anchor call sites", and no call site implements it. `placeTagPopover` (`sessionsPageState.ts:237`)
already does exactly this, tested. **Fix:** move placement into the component and reuse that helper.

**Unverified:** the rendered menu height is inferred from row count, not measured, and whether the
app's menu clips today is unconfirmed.

**Rev 4/5:** the prototype solves this in two lines with a **constant** 320px threshold
(`cat-app/SessionActions.jsx:112-113`), anchoring the flipped menu to `bottom`. That establishes
inferring the height as the intended design, so port the mechanism. Rev 4 went further and retired
the UNVERIFIED tag; **rev 5 restores it** — a constant that suits the prototype's menu says nothing
about the app's, whose rows, fonts, zoom and viewport differ. Unit-test the placement helper and
confirm clipping live before closing this finding.

### 20. Welcome tells users their terminal projects cannot be opened, which is no longer true

`WelcomeScreen.tsx:331`: "Open this project from the terminal. The desktop cannot restore it yet."
But `openHistorySession` shipped, and both `Sidebar.tsx:859` and the Sessions page open exactly those
rows by engine id. **Fix:** carry the history route into `RecentWorkspace` and reuse
`resolveSessionOpenRoute`; keep the disabled state only for `cwd === ''`.

### 21. Sessions in the same workspace are indistinguishable until a title generates

`tabBarModel.ts:4` and `sessionsCatalogState.ts:159` both fall back to `basename(cwd)`, so every
session in a repo renders identically across tabs, sidebar, palette, and Sessions page.
Multiple-sessions-per-workspace is a deliberately built flow. **Fix:** append a disambiguator from
data already on the row (created time or ordinal); `disambiguateWorkspaceLabels` in the same file is
the precedent.

### 22. Settings search never reaches the long lists

`railItemSearchText` (`settingsScope.ts:408`) covers rail labels and editable-setting labels. Skills,
Agents, MCP servers, Hooks, and Plugins contribute nothing and carry no filter of their own. The one
search box looks like it should do this and returns "No matches". **Fix:** per-panel client-side
filters; extend the rail search text with extension names.

### 23. Model picker drops the descriptions the wire already carries

`getModelOptions()` supplies pricing and positioning plus "Use the default model (currently X)"; the
sidecar forwards them (`settingsDomain.ts:399`); `SettingsEditors.tsx:280` reads only `option.label`.
The no-override row becomes indistinguishable from a real model name. **Fix:** render the selected
option's description as helper text, or reuse `ComposerActionsBar`'s popover pattern.

### 24. A benign transient renders as a red failure

`'starting'` falls through `ConnectionRecovery`'s guard (`App.tsx:4024`) and renders in danger red as
"Session starting." beside a Restart button. One-line fix: add it to the guard.

*(Rev 2's finding 24a — transcript retention — was materially wrong about the engine's behavior and
has been corrected and promoted to finding 5a in P1.)*

---

## P3 — Accessibility, platform, and consistency

### 25. Accessibility gaps

> **Rev 2 correction.** Rev 1 claimed nothing announces a permission request and that the sidebar has
> no keyboard route. Both overstated; narrowed below.

- **No reduced-motion support.** `prefers-reduced-motion` appears nowhere in `app/` (verified
  absent), while the primary reading surface runs indefinite `animate-pulse` per streaming row,
  `animate-ping` per attention tab, and pulsing account and cap indicators. This is the WCAG 2.2.2
  case. The engine already models the preference (`src/utils/settings/types.ts:959`) and the terminal
  honors it (`src/screens/REPL.tsx:1596`).
- **Streaming content is not announced.** Only two `aria-live` regions exist: `ToastHost.tsx:126`
  and `TranscriptView.tsx:299`, the latter on the *loading skeleton* rather than the content that
  streams into it. Permission requests **are** announced: `PermissionPrompt.tsx:41` is
  `role="alertdialog"` with `aria-labelledby`. The real gaps are assistant replies, tool calls, and
  errors. `ToastViewport` also returns `null` when empty, so its live region is created at the same
  moment as its content, which assistive tech frequently misses.
- **The sidebar's session roster cannot be reached by keyboard.** Narrower than rev 1 claimed: the
  collapsed rail's nav buttons are focusable, and `⌘K` plus the tab bar provide routes to view
  navigation and session switching. The precise defect is that the rail expands only on
  `onMouseEnter` (`Sidebar.tsx:248`) with no `onFocus` equivalent, and the pin button is rendered
  *inside* the expanded branch, so keyboard focus can never expand the rail and enter the roster,
  workspace grouping, search, reorder, or per-row actions.
- **No focus trap or restore in most overlays.** Focus save/restore exists in exactly two modules
  (`PlanPanel.tsx:104`, `composerPopover.ts:14`). `SAModal`, which hosts destructive session actions,
  has no Escape handler. `AccountRowMenu` declares `role="menu"` while implementing no arrow-key
  navigation, one file away from a correct implementation.

**Improvement** — A `prefers-reduced-motion` block in `theme.css` (stylesheet-only); render
`ToastViewport`'s container unconditionally and split polite from assertive; add a visually-hidden
polite region for turn boundaries; add `onFocusCapture` to the sidebar `<aside>` and hoist the pin
button out of the expanded branch; extract `composerPopover.ts`'s focus logic into a shared hook and
adopt it in the overlays that lack it.

### 26. Platform and consistency

- **No minimum window size.** `app/main/main.ts:685` sets `width: 1100` with no `minWidth`/
  `minHeight`, and responsive prefixes appear in only six files (all `sm:grid-cols-*`), against a
  240px non-shrinking Settings rail and several fixed-width columns. One line sets a floor.
  **Unverified:** actual clipping behavior at narrow widths was not observed.
- **Dark-only.** No `prefers-color-scheme` or `[data-theme]` rule exists in `theme.css`, though the
  engine has a real `theme` setting (`src/utils/config.ts:197`) and `[data-accent]` proves the
  attribute-override pattern works. Around 50 hardcoded hexes bypass the token layer, several exact
  duplicates of existing tokens (`#a1a1aa` *is* `text-muted`), each of which would become a
  light-mode bug. The known Tailwind v4 interpolation trap is currently **clean**: zero live
  `[${…}]` classes.
- **Copy explains the roadmap instead of the user's action.** Three instances, one of them in the
  core transcript. `DeferredNote`, which `CLAUDE.md` records as "deleted 2026-07-27 after the
  operator rejected the page", **is alive and rendering** at `SettingsExtensions.tsx:104,137,219`.
  `SystemNoticeBox` prints the raw discriminant `account_diagnostic`/`api_retry` on screen
  (`TranscriptView.tsx:1779`). And `ImageResultBody` renders "inline image tile pending a projector
  image-payload seam" directly beneath every successful image result
  (`TranscriptView.tsx:1295`) — seam vocabulary and a roadmap note on the app's most-read surface,
  which §7 names explicitly. All three violate §7; the word-list test passes them by design. Replace
  each with a user action or omit it.
- **The Remote rail promises what the pane lacks.** `settingsScope.ts:332` advertises "Saved SSH
  environments"; `RemoteSettingsSnapshot` carries only `bridge` and `commandFilter`, so `sshConfigs`
  never crosses the wire. The description is a one-line fix that need not wait for the seam.

---

## Operator questions — ANSWERED 2026-07-31

> **Both were ruled on 2026-07-31.** The reasoning below is kept because it is why the questions
> were asked; the answers now govern.
>
> - **O1 — sidebar session state: live-only dot, no text.** A single small unlabeled dot on live
>   rows, absent otherwise. The minimum exception to the bare-row ruling, matching the standing
>   target of live-vs-not-live with no text. No chip, no status word, no colour vocabulary. The data
>   already exists at `Sidebar.tsx:839`.
> - **O2 — quota surfacing: pinned, dismissable, non-blocking.** Mount the existing `BannerStack`
>   above the transcript for **account health only**. STARTUP-GATES #12 is unchanged: never blocks
>   submit, always dismissable, no re-auth wall semantics, does not resurrect `ReauthWall.tsx` or
>   `reauthBannerState.ts`. Shell lifecycle errors (finding 8) remain a separate surface — do not
>   merge the two error classes into one banner plane.
>
> Recorded in `decisions/STARTUP-GATES.md` (O2) and in the companion coverage document's Operator
> rulings section (O1, which has no decision doc of its own). Finding 2 was also ruled: fix
> discoverability only, §1.1 stands.

The original framing follows.

### O1. Sidebar session state

`Sidebar.tsx:26-29` records that the per-row health dot "was removed 2026-07-14 to match the
prototype (operator decision)", and ledger §02 records the status chip as cut per the 2026-07-20
bare-row ruling. The observation that motivated rev 1's proposal still stands: a cleanly-closed
session leaves the tab bar entirely (`shellState.ts:149`), so for that session the sidebar is the
only surface, and it carries state in `aria-label` only. **Question for the operator:** is that
acceptable, or does the closed-session case warrant an exception to the bare-row ruling? No change
proposed either way.

### O2. Account and quota surfacing

STARTUP-GATES.md #12 (2026-07-20, operator GUI-acceptance) removed the reauth alert surface
entirely and deleted `ReauthWall.tsx` and `reauthBannerState.ts`, on the reasoning that a send at
zero-healthy should proceed and fail naturally at request time with the engine's own typed error.
`BannerStack.tsx` still exists with zero production importers. The observation: quota exhaustion
currently surfaces as a grey `cat_code_account_diagnostic` notice *inside* the scrolling transcript
(`TranscriptView.tsx:1763`), which scrolls away. **Question for the operator:** is the request-time
failure path sufficient, or should the diagnostic be non-scrolling? Rev 1 recommended remounting
`BannerStack`; that recommendation is **withdrawn** as a direct reversal of #12.

---

## Corrections carried from review

Beyond the inline rev-2 notes above:

- **`DiagnosticsSection` is not orphaned.** Lane C reported "zero importers"; it is imported by
  `MetadataInspector.tsx` and reachable via the session inspector. Reduced finding: palette
  `doctor`/`status` route to Settings, which has no diagnostics pane, so those two remain dead ends
  (finding 13).
- **The em-dash rule is clean, but not for the stated reason.** 87 non-test files contain `—`.
  Spot-checking shows they are code comments and test names, so the rule holds, but it holds because
  `userVisibleText.test.ts` enforces it, not because the character is absent.
- **Rev 4: four ledger rows overstate what shipped** (found during the prototype-coverage pass, all
  verified against source). §05 tags `OutputInspector` "adapted (search, wrap, copy)" when
  `ToolInspector.tsx` has none of the three. §17 tags menu placement adapted while its own evidence
  says no bottom-flip exists. §05 says the interrupt carrier is projector-suppressed via
  `isSynthetic`; `createUserInterruptionMessage` (`src/utils/messages.ts:557-572`) sets no such flag.
  And every §11 per-field row is ✅/🔁 while **no** editable-settings field passes
  `modified`/`onReset` — the ledger tracks the primitive, not the wiring, which is why finding 15 was
  invisible to it. That last one is the most consequential: the same granularity gap probably hides
  other wiring-level misses.

## Open questions worth one operator run

The renderer suite is SSR-only, so interaction and timing are structurally invisible to a source
audit. In addition to O1 and O2 above:

1. How long the empty-state flash in finding 18 actually lasts.
2. Whether `⌘W` with no active session escalates to closing the window. `App.tsx:2026` returns
   before `preventDefault`, and `app/main/` registers no `Menu`, so Electron's default should own the
   chord.
3. Whether the sidecar would accept a queued mid-turn submit, which decides whether finding 1 is
   renderer-only.
4. Whether the session actions menu (finding 19) genuinely clips; the height is inferred, not measured.
5. Real contrast ratios for `--color-text-subtle` on `--color-shell-chrome` at 10.5px, which carries
   a lot of explanatory prose.

## Highest-confidence work

These are source-verified, self-contained, and reverse no ruling. Ordered by confidence, **not** by
estimated effort, which this audit cannot support:

| # | Change | Confidence | Prototype |
|---|---|---|---|
| 7 | Assistant copy chip | Design + gates exist; wrapper is the only work | **A** — port |
| 12 | Focus a `tabIndex={-1}` card on mount | Reverts an adaptation | **B** — undocumented |
| 6 | `ToolOverflowNote`, then inspector copy + search | Component exists; two call sites | **A** — port |
| 24a | Add `'starting'` to the `ConnectionRecovery` guard | One condition | C |
| 4 | `busy` tone from `deriveTabVisualState` | Input already passed in | C — see note |
| 20 | Carry `engineSessionId`, route via `openHistorySession` | Target state clear; **not a deletion** | **A** — port |
| 26c | Remove the three rendered engineering notes | Copy-only; §7 already forbids them | C |
| 3 | Per-family permission previews | Larger, but the variant table is data | **B** — undocumented |
| 19 | Menu bottom-flip | Mechanism is proven; **threshold is not** | **A** — port + verify |

**Rev 4 changes to this table.** Finding 7 is restored (rev 3 removed it): the prototype supplies the
positioned wrapper that rev 3 said needed designing. Findings 12, 19, 20 added as ports. Finding 23
removed: the prototype's Settings select drops descriptions too, so this is a design question, not a
port. Finding 4 carries a caveat — the prototype's tabs are deliberately bare with zero status
elements, so confirm the bare-row ruling's reasoning does not extend to tabs before building.

Bucket column: **A** = port the prototype design · **B** = reverses an adaptation, but one with no
decision doc behind it, so no operator ruling is needed · **C**/**D** = no prototype backing. Full
classification in the companion document.

## Revision history

- **Rev 1 (2026-07-31)** — initial audit, 26 findings. Returned **RED** by cold review.
- **Rev 2 (2026-07-31)** — finding 2 rediagnosed (OAuth does not hang; no one-line fix); findings 4
  and 8 stripped of ruling-reversing proposals, which moved to O1/O2; finding 5 demoted from P0 and
  re-argued after the data-loss claim was disproved; findings 10, 13, 15, 16, 24a, 25 corrected on
  source facts; all frequency and effort claims demoted to labeled hypotheses and the one-day
  estimate removed. Returned **RED** by cold review
  (`2026-07-31-app-ux-gap-audit-rev2-review.md`).
- **Rev 3 (2026-07-31)** — this revision. All 7 review findings and 3 nits verified against source
  by the lead and accepted; none were disputed. Changes:
  - **Rev 2's transcript-retention "correction" was wrong in the dangerous direction** and is
    reversed. `0` deletes existing transcripts at startup (`src/utils/settings/types.ts:331`,
    `src/utils/cleanup.ts:25-30`). Split out and promoted to finding **5a** in P1.
  - Finding 10: file completion reclassified from a renderer task to a **cross-plane read-seam
    feature** needing a host/sidecar owner and boundary review; the "existing read seam" does not
    exist (`composerState.ts:60-70`).
  - Finding 12: the focus-the-Allow-button fix is **withdrawn** as insufficient; it repairs Enter
    only, leaving N, Backspace, and Esc suppressed by the same guard.
  - Finding 11: the unfiltered `user-text` history seed is **withdrawn**; it would import synthetic
    interrupt turns into `↑` recall. Now coupled to finding 9's provenance decision.
  - Finding 7: removed from the highest-confidence table; `BubbleCopyChip` needs a positioned group
    wrapper, so it is not a drop-in mount.
  - Finding 26: added the missed transcript-surface §7 violation (`ImageResultBody`,
    `TranscriptView.tsx:1295`).
  - Parity count corrected from the ledger's stale 127 headline to Part D's **145**.
  - Nits: lane scoping described accurately (C overlaps A and B by lens, by design); finding
    population stated unambiguously; `AgentsPage` line anchor re-verified.
- **Rev 4 (2026-07-31)** — prototype-coverage pass. Every finding was checked against
  `~/catcode_prototype/cat-app/` to separate "port an existing design" from "design it fresh"; full
  classification lives in `2026-07-31-app-ux-gap-prototype-coverage.md`. Corrections applied here:
  - **Finding 2 reclassified as an operator question.** It reopens `STARTUP-GATES.md` §1.1. The
    audit should have flagged that and did not; this is the third ruling-reversal in this document's
    history, after O1 and O2.
  - Finding 5a: the smaller fix is removing `0` from the domain (the prototype's four-option select),
    since the `IntField` adaptation is what made the destructive value typeable.
  - Finding 12: the surviving fix is the prototype's mechanism verbatim, so it is a revert of an
    adaptation rather than new design.
  - Finding 19: the "unverified height" caveat retired — the prototype uses a constant threshold by
    design.
  - Finding 16: split into three items with three different answers; the Goals cluster is unowned
    and blocked on a missing wire verb.
  - Highest-confidence table rebuilt with a prototype-bucket column; finding 7 restored, 12/19/20
    added, 23 removed.
  - Four ledger-drift rows recorded under Corrections.
- **Rev 5 (2026-07-31)** — the rev-4 companion pass was itself returned RED; corrections applied
  here. All five review findings and both nits verified against source and accepted:
  - **Finding 5a: rev 4's "remove `0` from the domain" is withdrawn.** The prototype's
    30/60/90/Forever select is mock state, not the contract — the registry declares
    `{ kind: 'int', min: 0, max: 3650 }`, so an enum would delete legitimate values and `Forever` has
    no wire representation. Rev 3's confirm-based fix is restored.
  - **Finding 2 split.** 2a (account/trust) is the operator question; 2b (session-free user-settings
    read) is actionable now and is **not** governed by STARTUP-GATES, since the user layer is
    session-invariant by design. Rev 4 parked both.
  - **Finding 19: the UNVERIFIED tag is restored.** A prototype constant proves the mechanism, not
    the threshold, and says nothing about whether the app's menu clips.
  - Confidence table: 19 re-tagged "port + verify"; 24 → 24a; 26c corrected from D to C.
  - Companion-doc corrections (composite findings now classified atomically, totals recomputed over
    38 items, the open-the-file capability reclassified as a privileged seam behind HC1) are recorded
    in `2026-07-31-app-ux-gap-prototype-coverage.md`.
- **Rev 6 (2026-07-31)** — companion rev 3 was returned RED; one correction lands here. The
  confidence table described finding 20 as "delete the app-invented disabled recent row", which the
  companion had simplified it into. **That would ship a clickable no-op:** a history-only workspace
  carries `appSessionId: null` by design (`sessionsCatalogState.ts:587-595`) and both
  `WelcomeScreen.tsx:246` and `App.tsx:2891` early-return on it. The row now states the actual
  requirement, which is what this finding's body said all along: carry a history `engineSessionId`
  and route through `openHistorySession`. The other three companion findings (bucket-taxonomy split,
  six missing design questions, and the MEMORY.md truncation pill that already exists) are corrected
  in the companion and change nothing here.
