# Subagent dock implementation report

Implemented on branch `codex/subagent-dock` in the isolated worktree
`/Users/pt/.codex/worktrees/subagent-dock/cat-code`, starting from `a0dfe5a1`.
The original shared checkout was preserved. The approved
[implementation plan](2026-10-08-subagent-dock-implementation-plan.md) and
[visual reference](../design-html/2026-10-08-subagent-dock-top-right.html)
define the intended behavior. Headless verification is complete; live GUI
acceptance is pending. No app installation, push, or live model probe was run.

## Result

Each session pane has one top-right subagent dock. A measured 288px panel
occupies the transcript gutter when it fits; otherwise the dock is a chip.
The chip expands to a floating panel when space permits, and opens the Workers
dialog when the pane is too small. The app-wide collapse preference is shared
between panes. The composer roster and footer task strip were removed;
non-agent tasks remain available through the command palette and Tasks dialog.

The dock joins real worker lifecycle, task resume evidence, transcript metadata,
and live lease information. Waiting workers precede live workers. Terminal rows
hold before moving to the initially collapsed Finished group; resumed rows
return with the arrival treatment. Foreground activity is shared with transcript
cards. Background and resumed runs have no live activity line. Attached details
omit information already shown by their anchor and clamp within the pane.

Finished rows navigate to and expand their transcript agent card, including
virtualized cards. A missing card in truncated history requests earlier history.
Rows without a tool-use target use the Workers dialog. Keyboard focus, Escape,
Finished disclosure, inert collapsed rows, and one polite announcement region
are implemented. Motion includes chip/panel morph, face/name travel, reorder,
settle, resume wash, and detail-strip transitions; reduced motion applies state
changes immediately.

## Evidence and persistence

- Both local-agent registration paths in
  `src/tasks/LocalAgentTask/LocalAgentTask.tsx` pass `agentId` into
  `createTaskStateBase`, establishing the task-id join for `resumedAt`.
- Foreground launches can lack a result `agentId` while running. The dock uses
  the existing `tasksSnapshot.subagents` tool-use metadata to join them; it does
  not invent an agent identity from nested child rows.
- Host restore in `app/host/host.ts` resumes the recorded engine identity.
  Persistence uses `engineSessionId`, with migration from the provisional
  app-session key. This also supports reopening history under another app ID.
- Background terminal snapshots can be evicted before a pane is mounted.
  Shell-level observation retains them independently of pane lifetime. Visible
  panes and shell observation share run identities; a stale completion cannot
  replace a newer resumed run.
- Versioned local storage retains terminal display evidence and Clear markers,
  with limits of 32 sessions, 128 finished agents per session, 512 Clear markers
  per session, and 2,000,000 serialized characters. The runtime observation cache
  is bounded to 64 sessions. Live activity and lease state are not persisted.
- Clear suppresses the current finished run identities. Late transcript
  enrichment does not resurrect them; a later resume creates a new identity.
  Unchanged terminal evidence performs no local-storage I/O or serialization.

## Verification

| Check | Observed result |
|---|---|
| `bun test app/` | 5,702 passed, 3 skipped, 5 failed across 383 files (224.62s). Every remaining failure reproduced at baseline `a0dfe5a1`; details below. |
| `bun run --cwd app typecheck` | Passed, including renderer Fast Refresh export checks. |
| `bun run --cwd app typecheck:sidecar` | Passed scoped check; 5,586 upstream diagnostics ignored by the existing wrapper. |
| `bun run --cwd app renderer:build` | Passed; existing large-chunk warning remains. |
| `bun run maps:lint` | Passed, 17 maps, zero warnings. |
| `git diff --check` | Passed. |

Behavior coverage includes terminal settling, disappearance without invented
outcomes, blocked completed workers, resume/deduplication, Clear and late
metadata, foreground source joins, lease-only detail, persistence bounds and
invalid storage, shared collapse state, pane sizing, focus/disclosure, motion,
virtualized transcript reveal, durable-key restore, and offscreen background
completion through eviction and another resumed finish. New user-visible text
passed the existing text checks in the full desktop suite.

The five remaining failures are existing expectations that disagree with the
baseline source. They were independently run against an archived baseline with
the same dependencies:

- `App.test.tsx`: CC-16 submit/drain wiring tripwire; foreground subagent handoff
  source tripwire; D5 retained-submit wiring tripwire.
- `GoalMemoryPages.test.tsx`: memory waiting-state copy expectation.
- `PermissionRulesEditor.test.tsx`: CC-13 unread-settings copy expectation.

Logs from this run are under `/tmp/subagent-dock-*`: `app-final.log`,
`typecheck-final.log`, `sidecar.log`, `build-final.log`, and the baseline logs
`baseline.log` / `baseline-other.log`. These temporary files are local evidence,
not checked-in fixtures. No unrelated source or test expectations were repaired.

## Pending operator GUI acceptance

Step 7 of the approved plan requires operator authorization. Follow
[GUI-VERIFICATION.md](../migration/process/GUI-VERIFICATION.md) using **Cat Code
Dev** from this worktree. Run `bun install` in the worktree first if dependencies
are absent; validation reused temporary links to the original checkout's installed
dependencies, which were removed after checks. Existing session evidence may be used; any live model
turn or account operation needs authorization for that action. Headless tests
and source inspection do not prove the following rendered behavior:

1. In a wide single pane, compare the panel against the approved mockup. Collapse
   and expand it, watching the face/name trajectories, frame morph, and focus
   destination. Check long and unnamed workers.
2. Split into two and three panes, resize their dividers, then reduce the window
   to 852×467 and a pane to its 20% minimum. Confirm panel-to-chip switching,
   floating-panel fit, Workers-dialog fallback, and independent pane data.
3. The operator hovers a row and a chip face. Check aligned strip baselines,
   hoverable details, below-row fallback near the left edge, pane clamping,
   scrolling out of view, and Escape. Tab through the same controls.
4. Observe foreground running, background, waiting, failed, stopped, done, and
   resumed evidence. Check the 0.7s/1.5s terminal holds, Finished ordering, 1.8s
   resumed wash, ring badge, and absence of background live activity.
5. Click a finished row outside the mounted transcript window. Confirm it scrolls
   to and opens the card; verify earlier-history loading when required.
6. Clear Finished, reload or restart, and reopen the same engine session. Verify
   history remains cleared and a later resumed finish appears once. Complete a
   background worker while its session is offscreen, then return to its pane.
7. Repeat appearance and geometry checks in light mode and with macOS reduced
   motion enabled. Confirm no morph, reorder, or arrival wash under reduced
   motion. Record live labels/screenshots with each acceptance claim.

The agent did not launch Cat Code Dev, steal focus, or move the operator's cursor.
