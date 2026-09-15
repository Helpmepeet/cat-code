# Quality-of-life feature proposals — Cat Code

Date: 2026-08-31 · Branch: `migration` · Scope: `src/` engine + `app/` desktop

## What this is

A survey of what is missing from Cat Code, along two axes the operator named:
what a **normal desktop app** has that this one does not, and what an
**agentic platform** needs for day-to-day supervision of running agents.

Nine independent read-only scouts swept one lane each: desktop/OS integration,
session lifecycle, permissions and steering, orchestration and background work,
context/cost/quota, memory and inputs, engine and CLI, failure and
observability, and a ninth that mined the project's own deferral record
(STATUS, backlogs, parity ledgers, the 30-surface prototype) rather than
inventing anything.

**Evidence standard.** Every scout was required to prove absence, not assert
it: cite `file:line` for what exists and the exact empty search for what does
not, and to mark anything unsettled as undetermined rather than guess. Every
load-bearing claim below was then re-verified directly against source before
being written down. Claims that survived that check are stated plainly; the
few that did not are in *Corrections*, and what remains genuinely unknown is
in *Open questions*.

**Read this as a menu, not a plan.** Nothing here is scheduled and no ranking
survives contact with the operator's own priorities.

---

## Part 1 — The five structural findings

These are not feature requests. They are properties of the system that recurred
across independent lanes, and they set the frame for everything in Part 2.

### S1. The desktop app advertises capability it does not have

This is the most consequential finding, and four lanes hit it independently
from different directions.

The desktop sidecar is launched with exactly two engine features:

```
SIDECAR_RUNTIME_ARGS = ['--feature=TRANSCRIPT_CLASSIFIER', '--feature=REACTIVE_COMPACT', 'run']
```
— `app/main/mainDecisions.ts:49`

while `build:dev:full` compiles all 40 of `fullExperimentalFeatures`
(`scripts/build.ts:13-52`). So cron/`AGENT_TRIGGERS`, `BRIDGE_MODE`,
`AWAY_SUMMARY` and the rest are paid for and unreachable from the surface the
operator actually sits in front of.

It compounds. In the same app:

- **MCP is entirely inert.** `const mcpClients: [] = []` — the annotation is
  the empty tuple, so it can never hold a client
  (`app/sidecar/sessionController.ts:346`), and `:404-407` passes
  `mcpTools: []`, `mcpCommands: []`, `mcpResources: {}`. The terminal builds
  real clients through a React hook the sidecar never mounts. Meanwhile the
  Settings pane lists those same servers as "Configured", and `AgentsPage`
  computes "Missing MCP" pills from the hardcoded empty array, so every
  MCP-requiring subagent renders as broken.
- **~50 slash commands are no-ops in the picker.** The catalog filters on
  `userInvocable !== false` with no type check
  (`app/sidecar/sessionController.ts:370-372`), so `local-jsx` commands ship
  into the composer typeahead; `QueryEngine` hardcodes
  `isNonInteractiveSession: true` (`src/QueryEngine.ts:402`) and
  `processSlashCommand` bails for exactly that case
  (`src/utils/processUserInput/processSlashCommand.tsx:646-654`). `/memory`,
  `/add-dir`, `/config`, `/hooks`, `/resume` all appear and do nothing. The app
  already classifies these correctly elsewhere
  (`app/sidecar/remoteSettingsDomain.ts:118-122`) — that classifier is simply
  not applied to the composer catalog.
- **Two settings toggles have no effect.** "Prompt suggestions"
  (`app/shared/settingsEditable.ts:263`) drives an engine path that only ever
  delivers through the Ink `AppState` store, never a wire frame. The Remote
  Control toggle says so in its own comment: it sets `replBridgeEnabled` while
  "no worker actually serves the session"
  (`app/renderer/src/RemoteSettingsPage.tsx:135-138`).

A no-op that looks like a working feature is worse than an absent one, and this
is the fourth instance of the defect class CLAUDE.md §8 rule 1 already names.
**The cheapest fix is honesty, not capability**: stop advertising what is not
wired. That is an afternoon. Wiring MCP is the separate, larger prize.

### S2. Nothing reaches the operator who is not looking at the window

For a system whose premise is unattended long-running work, this is the
load-bearing gap, and it was found by four lanes.

There is no OS notification, dock badge, dock bounce, tray item, sound, or
window-title change anywhere in the app. `rg -n "new Notification" .` is empty
across the whole repo; the only `app.dock` call is `setIcon`
(`app/main/main.ts:3344`). The app states it in its own Settings pane:

> "Not built yet. This app raises in-window toasts only, so it needs the window
> visible." — `app/renderer/src/SettingsShell.tsx:786`

The engine already solved this. `src/services/notifier.ts` dispatches to
iTerm2/kitty/ghostty channels, `src/hooks/useNotifyAfterTimeout.ts` has a 6s
idle threshold, and `preferredNotifChannel` machinery sits in
`src/utils/config.ts`. None of it is reachable from the desktop.

Cross-session attention is thinner still: a tab badges **only** for a pending
permission (`app/renderer/src/tabStatus.ts:107`), and a session listed in the
sidebar but not open as a tab has no indicator at all. A finished 40-minute
run, a blocked handoff, and a completed worker are all silent.

### S3. The always-on agent system has no always-on process

Three mechanisms that should provide continuity each stop at the window:

- **Lifetime is die-with-window** (locked decision L1). Not in dispute — but
  its costs are unsoftened (see S5).
- **Cron exists and is good, and only runs while a session is alive.**
  `AGENT_TRIGGERS` *is* compiled in; storage, leader election across concurrent
  sessions, and a 1s scheduler tick all work (`src/utils/cronScheduler.ts:40`,
  `src/utils/cronTasksLock.ts`). But the only two mount points are the Ink REPL
  (`src/hooks/useScheduledTasks.ts:85`) and one `-p` run
  (`src/cli/print.ts:2831`). "Do this at 7am" currently means "do this at 7am
  if I left a terminal open in the right directory."
- **The daemon is deferred, not foreclosed.** `SESSION-LIFETIME.md` L4: "v2 =
  move the same host module (supervisor + registry + socket) into a daemon; the
  window becomes one attachable client." The Electron-free host plane was built
  for this. It is the literal subject of "always-on agent system" and it is the
  one unbuilt milestone that would change the product's category.

The one process that *does* outlive a session is the deferred-continuation
macOS LaunchAgent (`src/services/deferredContinuationLaunchAgent.ts:87-113`),
which handles exactly one case: resuming after a Codex usage limit. It proves
the pattern end to end.

### S4. Money and quota are measured wrong on the path actually used

The operator runs mostly on Codex/GPT models through a ChatGPT subscription,
where dollars are not the currency. Three defects sit on that path:

1. **USD cost is fabricated for every GPT turn.** `MODEL_COSTS` contains zero
   `gpt-*` entries (`rg -c 'gpt' src/utils/modelCost.ts` → no matches);
   unknown models fall back to *the default Claude model's rate*
   (`src/utils/modelCost.ts:198-204`). That invented number reaches `/cost`,
   the statusline, the $5 dialog — and the budget cap.
2. **`--max-budget-usd` then kills the run on it.** `src/QueryEngine.ts:1145`
   compares `getTotalCost()` against the cap with no provider or subscription
   check.

   This is the root cause of a rule the operator already derived empirically
   and wrote into their own CLAUDE.md — "never pass `--max-budget-usd` to a
   `gpt-*` model… it exits 0 with `Error: Exceeded USD budget (N)` and no
   report." The workaround was documented; the one-line defect underneath it
   never was.
3. **No burn rate, and no live quota in the terminal.** Only an instantaneous
   percent exists anywhere (`AccountsPage.tsx:19` says so outright). The
   statusline's `rate_limits` is Anthropic-header-derived and has no Codex
   writer. The 80% near-cap warning is computed
   (`src/services/api/codexUsage.ts:89`) but every delivery path is a dead end:
   in the terminal it goes to a diagnostics log, and the desktop banner only
   fires when *every* account is blocked.

"Can I start a 40-minute run right now" is the daily question, and the answer
requires a rate the system never computes.

### S5. Losing work is easy; undoing it is impossible

- **Composer drafts are not persisted.** Found independently by three lanes.
  `promptDrafts` is plain React state (`app/renderer/src/App.tsx:557`) while
  *every other* renderer preference persists under a `catcode.` key. The app's
  own crash-recovery path reloads the document, so the healing mechanism
  destroys unsent text.
- **The desktop takes zero file snapshots.** The engine's checkpoint machinery
  is complete (`src/utils/fileHistory.ts`, 1115 lines, with rewind and diff
  stats), and is structurally unreachable: `fileHistoryEnabled()` branches on
  non-interactive, the sidecar never calls `setIsInteractive`, and the SDK
  branch requires `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` — which appears
  exactly once in the repo, at its own definition. So "Edit from here" rewinds
  the transcript while everything the tools wrote stays written. The terminal
  offers `both | conversation | code`; the desktop offers conversation only.
- **A quit mid-turn records nothing.** `captureInterruptedTurnForAbort` fires
  only on the two user-abort branches (`src/query.ts:1252,1863`); the sidecar's
  SIGTERM path (`app/sidecar/index.ts:600-620`) closes the socket and exits
  without aborting the turn. Making park/quit run the same cooperative abort
  the Stop button already runs converts a silent loss into a resumable one
  **without touching the locked lifetime rule**.
- **`turnInterrupted` is computed, shipped, and never read.** Set at
  `app/sidecar/index.ts:238`, declared on the ready frame
  (`app/shared/protocol.ts:587`), and its only renderer references are two test
  helpers. The cheapest softening of die-with-window is already on the wire.
- **No delete or archive.** The only removal path in the system is age-based
  cleanup. There is no way to get a botched or sensitive session out.

### Bonus: observability records the wrong things

From the operator's own exported bundle (`cat-code-diagnostics_31_Aug.json`,
aggregate counts only — raw diagnostics are never model context), covering a
101-minute window:

| | count |
|---|---|
| worker processes spawned | 309 (202 sessions-catalog + 107 accounts-pool) |
| `process.started` + `process.exited` | 627 of 974 records (**64%**) |
| `session.turn.started` | 17 (**1.7%**) |
| renderer health went unavailable | 7 |
| records **suppressed** by the log budget | 2,583 |

Two-thirds of the budget records idle process churn; the actual unit of work is
under 2%; and the system then drops 2,583 records, 2.7× more than it kept.

Yesterday's perf commit (`124f7638`) cut the sessions-catalog worker from 30s
to 120s, which accounts for 202 of those spawns. `ACCOUNTS_POOL_REFRESH_INTERVAL_MS
= 60_000` (`app/main/accountsPoolRunner.ts:48`) is untouched and explains the
other 107 exactly — a fresh Bun process every minute for the life of the app,
of which ~0.49s per run is module-graph import alone (measured on the sibling
worker in that same commit).

Separately, the **turn-stall watchdog already works and nobody can see it**.
The sidecar detects a 10-minute silent turn (`sidecarServer.ts:218`) and
deliberately does not abort, because "the hung state is the evidence" — then
writes it to a private JSONL with no consumer (`app/sidecar/index.ts:424`).
"Is it thinking or is it dead?" is the question the whole lane exists for, and
the detector for it ships its answer to a file.

---

## Part 2 — Proposals

Sized S (< 1 day) / M / L. Security-baseline notes are included where a
proposal touches the inbound boundary; the constraint is non-negotiable
(closed allowlist validated at the sidecar, renderer never authors permission
rules or paths).

### Tier 1 — small, high daily value

| # | Proposal | Size | Note |
|---|---|---|---|
| 1 | **OS notification + dock badge** when a turn finishes or blocks | S | Main already sees every frame; derive there. Outbound only, no inbound vocabulary. Notification text is a §7 surface. |
| 2 | **Persist composer drafts** | S | Six sibling modules already do keyed `localStorage` in the right idiom. Renderer-local, no protocol. |
| 3 | **Surface the turn stall** | M | *Re-sized after review.* The sidecar detector reads `turnLastEventAtMs`, exempts an unanswered permission, and classifies `phase` from held state (`sidecarServer.ts:1882`). A renderer measuring elapsed-since-start is a different, worse signal, and duplicating it creates two definitions of stalled. Needs a typed propagation path. |
| 4 | **Read `turnInterrupted`** and offer to continue | S | Data already on the ready frame; one projector case. |
| 5 | **Deny with a reason** in the permission card | S | The `message` param exists all the way up and is already used by PlanPanel. Today the row promises "tell Cat Code what to do differently" and sends `"Denied by user"`. |
| 6 | **Stop advertising dead slash commands** | S | Filter `local-jsx` from the catalog using the classifier that already exists. |
| 7 | **Fix fabricated USD**; carry cost provenance | M | *Re-sized and re-scoped after review.* The fabricated-price half is right. Refusing the flag by "subscription-routed model" is the wrong abstraction: `resolveRequestProvider` falls back to the caller's provider, and fallback models and subagents can resolve differently mid-run, so one run can mix metered and subscription requests. Fix is provenance (`metered`/`subscription`/`unknown`) carried through accumulation and enforcement. Returning zero is also wrong: zero reads as a known-free request. |
| 8 | **WebSearch `isEnabled()` should check `EXA_API_KEY`** | S | Today the model is offered a tool that always throws. Likely the mechanical reason web research is routed to ChatGPT by habit. |
| 9 | **Persist window geometry** | S | Zero `getBounds`/`setBounds` in main; every launch is 1100×720 at the OS default. |
| 10 | **An application menu** | M | *Re-sized after review.* The markup is small; accelerator ownership is not. `App.tsx:3075` currently owns ⌘K/⌘T/⌘W/⌘1-9 as window-level behavior, so a native menu moves dispatch into main and changes precedence. Needs one command-routing policy, and Open question 1 must be settled first. |
| 11 | **More keyboard chords + a cheatsheet** | S | Four *global* chords exist (⌘K/⌘T/⌘W/⌘1-9). *Corrected after review:* element-scoped bindings also exist, e.g. ⌥↑/⌥↓ workspace reorder, which is properly discoverable via `aria-keyshortcuts` and a tooltip (`Sidebar.tsx:1542,1558`). Any cheatsheet must inventory those too or it will collide with a live binding. |
| 12 | **Zoom / text size, persisted** | S | No zoom control anywhere; transcript column caps at 740px. |
| 13 | **Finder image drop into the composer** | S | Composer reads `dataTransfer.getData('text')` only, so a Finder drag is silently inert. Reuse the existing byte-based `attachImage` path. Images only — a dropped *file path* is a separate HC1 decision. |
| 14 | **Persist scroll position** | M | *Re-sized after review.* Serializable encoding is the easy 10%. The module states it is deliberately not persisted, and falls back to bottom when a row key is gone (`transcriptScrollMemory.ts:1-9,144-151`); across a restart an anchor can outlive pruning, compaction, grouping changes, or not-yet-loaded history. Needs versioning, retention, restore ordering, and an invalid-anchor policy. |
| 15 | **Session-scoped always-allow** | S | Engine mints *more* suggestions (same rule at `destination: 'session'`); the renderer keeps selecting by index. **Zero boundary change** — this is why it is cheap. |
| 16 | **Cross-tab attention beyond permissions** | M | *Re-sized after review.* A snapshot is current state, not an attention event: the reducer replaces wholesale with no seen/transition metadata (`tasksState.ts:40`) and it is `sticky` in the replay buffer (`replayBuffer.ts:127`), so reconnect replays it. "New for you" needs per-session watermarks and replay dedupe, or badges reappear on every reload. |
| 17 | **Expose `autoDreamEnabled` + memory keys** in settings | S | `settingsEditable.ts` is a declarative array; this is one entry. |
| 18 | **Roster click should open *that* worker** | S | `onOpenTasks?: (agentId?: string)` is typed and the id is discarded at the call site. |
| 19 | **`-p` stdin stall** | S | Every delegation subprocess pays 3s + a stderr warning; skip the peek when a positional prompt was supplied. |
| 20 | **Typed headless exit codes** | M | *Re-sized after review.* Seven result subtypes collapse to exit 1, but early failures (settings parse, invalid MCP config, auth/org validation) `process.exit(1)` in `src/main.tsx` before a result exists. Mapping only the result subtypes ships a contract that lies about the most common failures. |
| 21 | **Strict settings validation on load** | S | The strict validator exists and is wired only to the Edit tool; a typo'd *key name* is silently ignored forever. Warn, never reject, and route through the existing invalid-settings surface rather than creating a second policy. (Challenged in review and held: see Review outcomes.) |
| 22 | **A feature-gate lint** | S/M | See S1 and *Hazards*. Catches the recurring half-wired defect class at build time. |

### Tier 2 — medium, structural

- **MCP in the sidecar** (M). The largest single capability gap between the two
  surfaces. The config loader, five-state health model, and backoff reconnect
  are all framework-free already; what is missing is a non-React connection
  manager. A read/connect-only first cut adds no inbound vocabulary.
- **Full-text search across transcripts** (M). Both surfaces search *metadata*
  only. The terminal's content search exists and is dead-gated behind literal
  `|| true` / `&& false` (see *Hazards*). `src/utils/ripgrep.ts` exists; the
  catalog worker is already the disposable process to run it in.
- **Find in transcript, ⌘F** (M). Not `webContents.findInPage` — the transcript
  windows its content, so unmounted rows are invisible to Chromium's finder.
  Search projected rows instead.
- **Desktop file checkpointing + rollback** (M/L, needs a decision first).
  Compliant shape: the renderer authors only a `messageId` already on the wire
  plus a `requestId`; the sidecar re-resolves against the engine's own snapshot
  chain. Enabling snapshots at all changes what every desktop tool write does
  on a live tree — that is the real decision, not the UI.
- **Burn rate and time-to-exhaustion** (M). The 60s worker already samples;
  retain a bounded ring and derive slope.
- **A local override for the dark memory features** (S-M + a decision).
  Automatic recall, background extraction, past-context search, and team memory
  are complete and gated on flags that can never be true: `isGrowthBookEnabled()`
  is `is1PEventLoggingEnabled()` which is hard-stubbed `return false`, and
  **both** override paths are themselves `USER_TYPE === 'ant'`-gated against a
  build that defines it as `'external'`. Needs a new override consulted ahead
  of the gate. Each feature costs a background model call per turn, so make
  them individually switchable.
- **@file mentions in the composer** (M). A fuzzy `FileIndex` already exists and
  is Ink-only. Needs one cwd-bounded, gitignore-respecting outbound seam.
- **Live-refresh the knowledge snapshots** (M). Memory, instructions, skills,
  and the slash catalog are all read once at spawn and never again, so editing
  CLAUDE.md mid-session leaves every surface showing stale truth silently.
- ~~**A second directory per session**~~ — **CORRECTED 2026-09-01, and dropped.**
  The original entry said a desktop session is locked to one directory. It is
  not. `addDirs: []` is hardcoded at spawn, but the renderer already renders
  `addDirectories` permission updates
  (`app/renderer/src/permissionPromptModel.ts:170`), so when a tool first
  touches a path outside the cwd the engine mints an add-directory suggestion
  and the user accepts it by index through the already-reviewed C1
  selection-by-index path. The capability exists **reactively**; only the
  proactive "grant it up front" version is missing. That is convenience, not a
  missing capability, and it does not justify a new inbound frame kind plus
  boundary tests plus a decision doc. Operator ruling 2026-09-01: skip.
- **A diagnostics reader, and rebalance the log budget** (M). Can be a
  `scripts/` reader rather than app code. Pair it with cutting the churn that
  is crowding the budget out.
- **Cooperative abort on park/quit** (M). Converts silent mid-turn loss into a
  resumable record without reopening the lifetime decision. The difficulty is
  ordering against the supervisor's SIGKILL deadline.
- **Archive a session** (M). The cheap half of delete: a transcript entry, like
  `tag`. Delete proper is irreversible-from-a-click and needs the §10 gate.

### Tier 3 — large, category-changing

- **The always-on daemon** (L). `SESSION-LIFETIME.md` L4. The host/supervisor
  split already exists for it, and no Phase-3 artifact may assume the window is
  the only client. This is what would make "always-on agent system" literal
  rather than aspirational.
- **A scheduler that outlives sessions** (M/L). Either host-owned, or
  generalize the deferred-continuation LaunchAgent that already proves the
  pattern. Must spawn *new* sessions, not claim to keep old ones alive, or it
  reopens L1.
- **Quota-aware admission** (M). Queue cheap work into the window's tail, hold
  expensive work for the reset. Every primitive exists (reset times, lockfile
  and ledger discipline, a durable job file); nothing composes them.
- **Desktop verbs that drive orchestration** (M per verb, **high security
  attention**). Today the app can watch workers and not spawn or steer them.
  This is precisely CLAUDE.md §8 mistake 5, so each verb needs a sidecar-local
  schema, a boundary test, and a decision doc; a spawn verb must name a
  *definition* the sidecar re-resolves and must never carry renderer-authored
  tool lists or permissions.
- **Read-only peer awareness across sessions** (M). "Who else is editing this
  file right now" is a daily question on a shared tree with no mechanism.
  `src/utils/concurrentSessions.ts` already writes per-PID status files, so the
  read-only answer is far cheaper than messaging — and messaging is *not* the
  cheap option here (see *Hazards*).

---

## Hazards worth naming separately

Two patterns will waste future sessions' time until someone addresses them.

**48 of 89 feature-gate names are permanently dead.** Every name in
`scripts/build.ts` has call sites, but 48 names with runtime `feature('X')`
call sites are never compiled in — and nearly all of them gate modules that are
**not in the repository**. Eight tools are `require`d from `src/tools.ts` with
nothing behind them (`MonitorTool`, `WebBrowserTool`, `SnipTool`,
`ListPeersTool`, `WorkflowTool`, `CtxInspectTool`, `TerminalCaptureTool`,
`OverflowTestTool`); so are `src/cli/bg.ts`, `src/daemon/`, `src/ssh/`,
`src/coordinator/workerAgent.ts`, `src/services/skillSearch/` (13 importers).
`feature()` dead-code elimination is the only reason the build stays green, so
flipping a promising-looking flag "to try it" produces a module-not-found that
reads like a real bug. `AUTO_THEME` is one of only three whose modules all
resolve — a plausible S-sized win, and worth one build to confirm.

**Dead UI behind literal `false`.** Three separate surfaces are computed on
every run and hidden by a constant: `/context`'s per-tool message breakdown
(`messageBreakdown && false &&`, `src/components/ContextVisualization.tsx:339`,
plus two sibling `[ANT-ONLY]` blocks), and the terminal's transcript content
search (`if (… || true) { return }` at `LogSelector.tsx:793`, `&& false &&` at
`:1057,:1347`). These are the exact features Tier 2 wants. Re-enabling is
cheap; the labels need §7 rewording first, and someone should establish whether
each was a deliberate fork cut or upstream drift.

---

## Axes this survey did not cover

Named by an external review of this document. None of the nine lanes covers
these, and each cuts across the engine/desktop boundary. Listed as scope for a
follow-up survey, not as proposals.

**Accessibility as an interaction contract.** The report treats shortcuts and
zoom as conveniences and never asks whether the app is operable and correctly
announced under keyboard-only use or VoiceOver. This deserves its own lane
precisely because the dangerous controls are the ones a focus bug changes the
behavior of: permission cards, AskQuestion, plan review, task kill/dismiss,
modals. Audit surface: `overlayFocus.ts`, `PermissionPrompt.tsx`,
`AskQuestionFlow.tsx`, `TabBar.tsx`, and whether a windowed `TranscriptView`
keeps a stable VoiceOver reading position. Worst case: a permission request is
visibly actionable but unreachable or unannounced, so the session is blocked or
the wrong decision is submitted.

**Resource and energy budgets.** There is failure observability here and one
idle-TTL note, but no envelope for RAM, CPU, renderer work, or battery, which
matters unusually much when every live session can own an engine process
(`app/main/main.ts:1537-1540` names the engine graph at ~189 MB). Unmeasured:
marginal RSS per live sidecar, practical live-tab ceiling, CPU while an
inactive tab streams, cost of the 1s ticks and health polling, and whether
parking reduces resident memory or only process count. This is not another
parking proposal; parking exists. Worst case: multi-session use gets nicer
while each session still costs enough that the renderer is OOM-killed or the
laptop is unusable on battery.

**Upgrade, schema migration, and rollback.** No lane owns what happens to local
state when Cat Code itself changes version, which is distinct from session
restore: the app can restore perfectly within one build and fail across an
upgrade. Several versioned boundaries already exist and disagree in strategy
(`app/main/transcriptCache.ts:91-95` gates on protocol/guard versions rather
than app version; `app/host/registry.ts:472-474` moves an unknown
`registryVersion` aside and starts empty). Needs a map of every persisted
schema, its compatibility rule, whether migration is atomic, what rollback
does, and which state is derivable versus authoritative.

**Backup, disaster recovery, and Mac-to-Mac portability.** Session lifecycle
asks how to reopen a session, not how to recover the whole local product state
after disk loss or a machine move. The registry is explicitly "an index, not a
backup" with the transcript catalog as the recovery path
(`app/host/registry.ts:472-474,509-512`) — good local design, but not a
user-visible backup contract. Needs an inventory of transcripts, registry,
tags, settings, memories, plugin/MCP config, window layout, and future
drafts/anchors: where each lives, whether it holds secrets, and how absolute
paths are repaired on a new machine. A shareable export is not a backup; it
strips state on purpose.

---

## Review outcomes

This document was reviewed by ChatGPT against the repo. Its findings were
verified here rather than accepted, per standing practice.

**Accepted.** Six Tier-1 items moved S → M (3, 7, 10, 14, 16, 20), each for the
same underlying reason, which is the review's most useful observation: *the
datum existing somewhere is not the same as the user-facing semantic being
local*. Stall truth is sidecar-private; cost truth is per-request, not a model
property; menu accelerators cross the main/renderer boundary; a scroll anchor
is only same-window durable; attention needs unread history, not a sticky
snapshot; exit codes span pre-query process exits. Proposal 7 was also
re-scoped: refusing the budget flag by "subscription-routed model" is the wrong
abstraction, since fallback models and subagents can resolve a different
provider mid-run, so one run can mix metered and subscription requests.

**Accepted with precision.** "Four chords exist total" was too absolute. Four
*global* chords exist; element-scoped bindings also exist (⌥↑/⌥↓ workspace
reorder, `Sidebar.tsx:1542`), and that one is properly discoverable via
`aria-keyshortcuts` and a tooltip. A cheatsheet must inventory those or risk
assigning a colliding chord.

**Rejected, with evidence.** The review argued proposal 21 is wrong because
invalid settings already raise a startup dialog (`src/main.tsx:2352-2362`).
That dialog is real but catches a different error class. The load path is
`SettingsSchema().safeParse(data)` with no `.strict()`
(`src/utils/settings/settings.ts:226`) against a schema ending in
`.passthrough()` (`src/utils/settings/types.ts:1125`), so an **unrecognized
key** produces no error and the dialog never fires for it. The original claim
was about a typo'd key name, and it stands. The review's constructive half was
kept: route the warning through the existing invalid-settings surface instead
of creating a second policy.

---

## Corrections

The ninth lane's mandate was to find things the docs call missing that have
actually shipped, so these are **not** proposals:

`lastMessageSentAt` sidebar reordering · accounts usage analytics · interrupt
provenance · open-the-file capability · app-session title generation ·
ToolInspector copy/search/wrap · GFM tables, syntax highlighting, word-level
diff · image attachment · Branch/Rewind (the *dialogs* were cut; the capability
shipped as inline message actions) · `task.stop` · the orchestrator roster,
lease family, and mode badge · sidebar pinning.

The parity ledger's Part C is roughly five weeks behind source by its own front
matter's admission; a large fraction of its 126 open rows have shipped. Do not
size work off it, or off the "~1,974 known-red typecheck" figure, without
re-measuring.

One scout also reported `COORDINATOR_MODE` as "off but implemented" and then
corrected itself: `src/coordinator/workerAgent.ts` is absent while
`builtInAgents.ts:54` requires it. Eleven prototype `Messages.jsx` row types
(`AwaySummaryRow`, `CrossSessionMessageRow`, and nine others) are prototype
inventions with no corresponding engine subtype — they are not a gap list.

---

## Open questions

Genuinely unsettled; each names what would settle it.

1. **Does ⌘W close a tab or the window?** With no `setApplicationMenu` call,
   Electron installs its default menu whose Window ▸ Close takes `CmdOrCtrl+W`,
   and NSMenu key equivalents are handled before the key reaches web contents.
   The app advertises ⌘W as "close tab" in two places. If the menu wins, ⌘W
   tears down every sidecar. **Settle it:** press ⌘W in a running dev app with
   two tabs. This should be checked before designing proposal 10.
2. **Do hooks execute in desktop sessions at all?** The config read-seam is
   real and the hook *lifecycle events* are provably dropped by the projector,
   but whether `QueryEngine` runs hooks from settings inside the sidecar is
   untraced. If they do fire, a user-authored hook is already intercepting
   desktop tool calls invisibly.
3. **Is enabling sidecar file checkpointing safe at this session volume?**
   100 snapshots per session, hardlink-first; the current store is 3.9 MB from
   TUI use only. Unmeasured under desktop volume.
4. **Nine engine system-message subtypes are silently dropped** by the
   projector (`hook_started`, `post_turn_summary`, `files_persisted`,
   `task_started`, and five more) — fixtures for several already exist. Is that
   a deliberate cut or drift?
5. **Is `AGENTS.md` deliberately not an instruction source?** It is not loaded
   by `claudemd.ts`; the only repo-wide hits are a policy string and the
   `/init` prompt. This repo keeps a root `AGENTS.md`.
6. **Would adding features to `SIDECAR_RUNTIME_ARGS` work?** Verified the list
   is short and the features compile; *not* verified that the sidecar's headless
   session loop has mount points equivalent to the Ink REPL's React effects.
   Cron in particular mounts as a REPL effect.
7. **Does the desktop's 60s pool worker emit the 80% warning at all?** It runs
   in a separate process where the diagnostic sink is likely absent, in which
   case `emitUsageWarnings` returns early.
</content>
</invoke>
