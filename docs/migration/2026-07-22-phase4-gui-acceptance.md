# Phase-4 GUI acceptance script (rebuilt 2026-07-26)

**Purpose.** This is the operator's single-sitting acceptance checklist for the
desktop surfaces currently runnable from `migration`. It is intentionally
source-grounded: each check names the committed production seam that makes the
state reachable. Headless tests remain necessary, but they cannot accept live
interaction, ordering, timing, focus, or prototype fidelity.

This script does **not** ask the operator to inspect deleted UI. There is no
`WorkerDetail`, `WorkerFocusView`, Orchestrator page, or Leases tab in current
production renderer source. P4-32 is decision-first and must be ruled before any
new in-session Orchestrator chrome is accepted.

## Part A — launch and evidence

Follow `docs/migration/process/GUI-VERIFICATION.md` exactly and use its P3-H
harness. The agent does not drive the GUI. For a check that needs a model, use
`gpt-5.6-luna` at low effort on a healthy account.

Keep `~/catcode_prototype/CatCode Web App.html` open beside the desktop app.
For every fidelity check, capture a prototype/actual **pair** for each state;
one screenshot is not acceptance. Record `PASS`, `FAIL`, or `BLOCKED`, plus the
artifact paths. A visible mismatch is a failure unless the operator has
explicitly approved it.

Before starting, prepare:

- one existing restorable session with real transcript history;
- one fresh session in a nested folder of a git repository;
- one terminal Cat Code session in that same repository;
- a turn that produces `apply_patch`, Bash, an agent/subagent, and (if
  available) `AskUserQuestion`;
- one real permission request and one worker-relayed request carrying
  `agent_id`.

Do not perform real account login, logout, token, delete, or destructive session
actions merely to create acceptance data.

## Part B — source-audit boundaries

These are deliberate exclusions, not skipped acceptance:

- **Deleted Orchestrator surfaces:** no production files named
  `WorkerDetail`, `WorkerFocusView`, `LeaseRoster`, or `OrchestratorPage` exist.
  Current shipped seams are the empty-session mode switch, inline Agent cards,
  delegate groups, and `TasksDialog`
  (`WelcomeScreen.tsx:137-140,341-372`;
  `TranscriptView.tsx:1072-1163`; `TasksDialog.tsx`).
- **No Leases tab:** Accounts currently renders a real **Codex Pool**, not a
  Leases view (`AccountsPage.tsx:943-993`). Do not search for or accept a Leases
  tab.
- **No reauth banner/all-dead wall acceptance:** current `App.tsx:2254-2258`
  says those surfaces were removed. Do not follow the stale instruction to find
  a closable reauth banner or persistent all-dead wall.
- **P4-32:** decision-only until the operator rules on the decision document
  specified by `docs/migration/backlog/phase4.md`; there is no P4-32 GUI
  acceptance in this sitting.

## Part C — runnable on `migration` (24 checks)

Run in order so each prepared session is reused and related surfaces stay
together.

### Shell, navigation, and session lifecycle

- [ ] **C1 · P4-4 shell fidelity.** Compare collapsed, hover-expanded, pinned,
  selected-row, search-filtered, split, and unsplit states for Sidebar, TabBar,
  and WorkspaceLayout. Confirm the selected-row outline and identity-first row
  treatment, not a process-monitor treatment.
  Source: `app/renderer/src/Sidebar.tsx`, `TabBar.tsx`,
  `WorkspacePanels.tsx`, `workspaceLayout.ts`.

- [ ] **C2 · P4-26 navigation + P4-6 Sessions page.** Click **Sessions** from
  both the rail and expanded sidebar; the real catalog mounts. Repeat for Goals,
  Accounts, and Settings and confirm the selected nav state follows the mounted
  page.
  Source: `Sidebar.tsx:91-97`; `sidebarState.ts`
  (`resolveNavSelection`); `App.tsx` page routing.

- [ ] **C3 · P4-6 session actions.** From a real sidebar row and a real tab, open
  the same target-bound actions menu. Open the currently shipped
  `MetadataInspector`, verify its base live session fields, close by ×, backdrop,
  and Escape, and exercise only safe actions. This accepts the landed P4-6
  wiring, **not** P4-31's parked fidelity delta.
  Source: `Sidebar.tsx:610-624`; `TabBar.tsx:306-327`;
  `App.tsx:2169-2245`; `SessionActionsMenu.tsx`; `MetadataInspector.tsx`.

- [ ] **C4 · CC-12 never-typed clean close.** Open a brand-new session, type
  **nothing**, then close it. Its row must disappear from the left sidebar and
  must not reappear as a restore offer. Do not substitute a session that has
  sent a message; that creates a transcript and tests a different path.
  Source: `app/host/host.ts:494-532,824-851`.

- [ ] **C5 · CC-10 terminal discovery cadence.** In the terminal session, send
  its first real user message so the transcript exists; start timing at that
  message, not at terminal process creation. The session should appear in the
  desktop within one roughly 30-second catalog cadence, plus ordinary display
  latency. Record the measured duration. A result near 60 seconds is a failure
  worth preserving with logs.
  Source: `app/main/sessionsCatalogRunner.ts:11-24,37-43`.

- [ ] **C6 · CC-8 terminal rename after desktop open.** Open the terminal-created
  session in the desktop first, then run terminal `/rename`. Without restarting
  the desktop, verify the new name reaches Sidebar, TabBar, and Sessions after
  the next catalog refresh. This order matters: a never-opened history row was
  not the broken case.
  Source: `sessionsCatalogState.ts:250-303`.

- [ ] **C7 · P4-28/CC-2 ordering boundary.** Open or restore an older history
  row. The row must not jump merely because it was opened; ordering changes only
  after a message is sent. Record any transient and the state after 40 seconds.
  Do not accept “eventually settles” as equivalent to the operator's no-reorder
  rule.
  Source: `sidebarState.ts`; canonical open issue: `STATUS.md` CC-2.

- [ ] **C8 · CC-6 browsing safety.** Note several recent restorable rows, browse
  several other history sessions, and confirm the noted rows remain available.
  This is a practical smoke of the raised 256-row registry bound, not the stale
  32-row “undecided cap reshape” check.
  Source: `app/host/registry.ts` (`MAX_REGISTRY_SESSIONS`);
  `app/shared/hostApi.ts` (`MAX_LIVE_SESSIONS` remains separate).

### Startup, trust, and launcher

- [ ] **C9 · CC-9 trust scope copy.** Create/open the nested-folder session while
  it is untrusted. The gate keeps exactly one Workspace path box and clearly
  says trust is stored for the git repository, covering sibling folders and the
  terminal CLI. Also capture the root-equals-cwd state if available.
  Source: `StartupSurfaces.tsx:142-204`.

- [ ] **C10 · P4-15/P4-17 startup and launcher.** Verify the first-run/trust
  sequence does not expose the chat before acceptance, then compare Welcome
  launcher chrome and real recents derived from registry ∪ history. Open one
  recent through its real address. Do not look for the deleted reauth banner or
  all-dead wall.
  Source: `StartupSurfaces.tsx`; `WelcomeScreen.tsx`;
  `sessionsCatalogState.ts:487-535`; `App.tsx:876-909,2392-2418`.

### Accounts, settings, and permissions

- [ ] **C11 · P4-5 Accounts.** Settings/Accounts shows the real redacted Codex
  Pool, active account, usage/headroom, status, and only lifecycle affordances
  valid for the actual account state. Inspect read-only; do not trigger login,
  logout, token, switch, rename, or delete merely for acceptance. There is no
  Leases tab.
  Source: `AccountsPage.tsx:824-993`.

- [ ] **C12 · P4-19 settings editors.** Compare General, Model, Privacy, Theme,
  Keybindings, IDE, and LSP editors. Make one safe reversible write, verify the
  value and source badge round-trip, then restore the original. Confirm a
  managed field is disabled if the environment supplies one; otherwise record
  that state as data-blocked, not passed.
  Source: `SettingsShell.tsx`; `SettingsField.tsx`; `settingsState.ts`.

- [ ] **C13 · CC-5 mode pill.** Settings → Permissions shows a read-only current
  permission-mode pill such as `default` or `plan`; it must not show interactive
  mode buttons in this pane.
  Source: `PermissionRulesEditor.tsx:45-81`.

- [ ] **C14 · P4-34 Lane 2 rule provenance.** In Settings → Permissions, verify
  real rules show their `exact`, `prefix`, or `wildcard` match-type label and
  source badge. Confirm **Managed-rules-only enforcement** and **Permission
  classifier** display their real on/off state as disabled/read-only switches;
  clicking them must not mutate state.
  Source: `PermissionRulesEditor.tsx:84-170,176-233`.

- [ ] **C15 · P4-34 Lane 2 worker-relay permission chrome.** Compare an ordinary
  permission request with one carrying a real engine `agent_id`. Only the latter
  shows the `worker` badge and names the engine-sourced worker and role. An
  unnamed or unmatched worker shows the role only, never the raw id. Allow/deny
  still answers the same engine-minted request.
  Source: `PermissionPrompt.tsx:81-104`.

### Command palette

- [ ] **C16 · P4-34 Lane 2 ⌘K recents and divider.** Open ⌘K before any invocation
  and confirm there is no fabricated Recent section. Run a real page/session
  item, reopen ⌘K, and confirm it appears under **Recent** above a divider while
  the canonical item remains in its normal group. Search must suppress duplicate
  Recent rows. Use keyboard navigation and invoke a page item; the real page must
  mount. Recents reset after app restart because they are intentionally
  session-local.
  Source: `commandPaletteModel.ts:200-228,237-257`;
  `CommandPalette.tsx:120-180`; `App.tsx:483-486,2435-2447`.

### Chat, transcript, tools, and agent activity

- [ ] **C17 · P4-24 ChatView.** Compare the real SessionPane transcript and
  composer in empty, active-turn, completed-turn, and disconnected states.
  Confirm Model/Reasoning/Fast controls reflect the live session and the
  composer is not the old `<h1>Transcript</h1>`/single-input scaffold.
  Source: `App.tsx` (`SessionPane`); `TranscriptView.tsx`;
  `ComposerActionsBar.tsx`.

- [ ] **C18 · P4-18 transcript families and scroll.** Over real content, compare
  user/assistant prose, reasoning, Bash, FileRead, FileWrite, Edit/diff,
  Agent/delegate, activity seams, result seams, streaming, sticky-bottom, and
  scroll-away → `↓ Latest` → re-pin.
  Source: `transcriptProjector.ts`; `TranscriptView.tsx`.

- [ ] **C19 · CC-5 apply_patch inspector diff.** Open ToolInspector on a real
  `apply_patch` row. It must render a **Diff · <file>** section with the primary
  file's hunks. A real Bash row must show no Diff section. Close by ×, backdrop,
  and Escape.
  Source: `transcriptProjector.ts:1137-1186`;
  `ToolInspector.tsx:104-180`; `TranscriptView.tsx:264-295`.

- [ ] **C20 · P4-18 live tool failure transition.** Keep a tool card visible as a
  live turn changes from pending to error. It must update and auto-expand the
  error body; accepting only an already-errored history row does not test the
  fixed transition.
  Source: `TranscriptView.tsx` tool-card state/effect path; canonical finding:
  `STATUS.md` P4-REVIEW.

- [ ] **C21 · P4-20 AskUserQuestion.** Produce a live `AskUserQuestion` and
  complete its real interactive answer flow. It must not degrade to a generic
  permission card or raw JSON.
  Source: `permissionState.ts:243-277`; `AskQuestionFlow.tsx`;
  `PermissionQueue.tsx`.

- [ ] **C22 · CC-7 injected-turn authorship.** In a real delegated/channel
  session, capture every available engine-injected kind: task notification,
  coordinator, channel, teammate, and deferred continuation. Each must be a
  left-aligned notice with its engine-origin label/tag, never the operator's
  right-aligned pink bubble. Record unavailable kinds as data-blocked; do not
  infer their live pass from headless coverage.
  Source: `transcriptProjector.ts:1558-1617`;
  `TranscriptView.tsx:1730-1857`.

- [ ] **C23 · shipped Orchestrator seams only.** In an empty session, toggle the
  Orchestrator switch on/off and verify the next turn uses the selected mode.
  During a delegated turn, verify inline Agent cards/delegate groups and open
  `TasksDialog`. Do **not** look for a roster/detail/focus page or Leases tab;
  P4-32 decides future in-session chrome.
  Source: `WelcomeScreen.tsx:137-140,341-372`;
  `App.tsx:1740-1840`; `TranscriptView.tsx:1072-1163`;
  `TasksDialog.tsx`.

- [ ] **C24 · CC-5 failure toast.** Trigger a controlled server-side failure for
  one of `agent-mode.set`, `task-control`, `run-control`, or `settings` (for
  example stopping an already-terminal task if the action is still offered).
  A red/danger toast must show the sidecar's real error; a successful action
  stays silent. Do not count client-side validation that sends no verb.
  Source: `verbAckResultState.ts:27-35,90-103`; `App.tsx` verb-ack toast effect.

## Part D — parked worktrees: not runnable from `migration`

Do not attempt these checks in the migration build and do not mark them failed.
The branches are intentionally unmerged.

- [ ] **D1 · P4-31 MetadataInspector — BLOCKED on parked
  `worktree-p4-31`.** After the branch is explicitly integrated, compare closed,
  opening, plain-message, subagent-message, compacted-session, and
  optional-fields-absent states. The two unresolved operator decisions remain:
  surface attribution falls back to `cli` without a per-message seam, and
  subagent metadata is live-task-backed rather than durable after
  eviction/resume. Until those are ruled, no P4-31 surface acceptance is
  possible.

- [ ] **D2 · P4-34 Lane 3 — BLOCKED on parked
  `worktree-p4-34b`.** After explicit integration, compare Settings model
  unset/selected/unavailable, live theme preview enabled/disabled, all five
  accents, Memory with zero/one/many configured agents, and Welcome `/workspace`
  picker closed/open with recent and native-picker paths. It is not present on
  `migration` and remains parked because its TranscriptView overlap is
  contended.

## After the sitting

Return the 24 Part-C verdicts and both Part-D blocker states with artifact paths
and measured timings. A failed or artifact-missing check stays open. Do not flip
STATUS rows merely because engineering tests are green; only operator-approved
prototype/actual pairs close live fidelity.
