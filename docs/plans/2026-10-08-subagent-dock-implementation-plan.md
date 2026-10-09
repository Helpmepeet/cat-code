# Subagent dock: implementation plan

Status: approved design, not started. Visual and motion spec:
[`docs/design-html/2026-10-08-subagent-dock-top-right.html`](../design-html/2026-10-08-subagent-dock-top-right.html)
(PROPOSED view, Events, Play, and the states strip). The mockup is the
reference for layout, copy, and timing; this plan is the reference for data,
ownership, and behavior the mockup cannot show.

## Goal

Replace the two surfaces that show live subagents today, the roster line
docked above the composer (`WorkerRoster`, mounted in `SessionPane.tsx`) and
the bottom-right pill (`TasksStrip` in `App.tsx`), with one dock in each
session pane's top-right corner.

## Operator decisions (2026-10-08)

These are settled. Several reverse older rulings recorded in code comments or
the parity ledger; the operator approved that.

1. One dock per session pane, top-right. Full panel (288px) when it fits beside
   the transcript; otherwise a chip of cat faces. The operator can collapse the
   panel to the chip. Default in a wide pane is the panel.
2. Chip ⇄ panel is an animated morph: faces travel between chip slots and rows,
   names ride beside their faces, details fill in after.
3. Non-subagent background tasks are not shown in the dock. They stay reachable
   through ⌘K "Background tasks" and `TasksDialog`.
4. `WorkerRoster` (mount) and `TasksStrip` are removed.
5. Finished subagents (done, stopped, failed) live in a Finished group,
   collapsed by default, opened by clicking its header. Finished history lasts
   for the session and survives reload and restart. Clear hides the current
   finished entries for that session and stays cleared.
6. Failed subagents turn red in place, hold about 1.5s, then settle into
   Finished. Done and stopped hold about 0.7s.
7. Resume: the row returns from Finished to the active list with a 1.8s blue
   arrival wash, a badge pop, and the word "resumed" for as long as that run is
   live. A resumed run is a background run (ring badge).
8. Hover detail is a strip attached to the row's left edge, the row's height,
   two lines on the row's baselines. It shows only what the row does not.
   Hovering a chip face shows a small popover that also names the worker.
9. Live activity appears only for foreground running workers. Background and
   resumed runs show none.
10. Model and activity may be joined from the transcript; resume state may be
    read from the tasks feed.

## Data: sources and joins

All derivation is renderer-side. No protocol change is needed; if one turns out
to be needed, stop and raise it (`app/shared/protocol.ts` rules in CLAUDE.md §6).

| Fact | Source | Join key | Notes |
|---|---|---|---|
| Live lifecycle, name, type, task, blocked reason, verdict, result summary | `workers.snapshot` (`LiveWorkerItem`, already a `SessionPane` prop) | `agentId` | Replaced wholesale per frame; cleared on lifecycle frames (`reduceWorkersState`). Local agents only. |
| Resumed | `tasksSnapshot` local-agent items, `resumedAt` (`tasksDomain.ts`) | `agentId` (verify the task id equals the agent id for local agents before relying on it) | `deriveTaskAgentState` returns `background` before `resumed`, so do not reuse it for this; read `resumedAt` directly. |
| Model, settled cost, recorded account, terminal outcome of foreground runs | Transcript `Agent` / `Task` / `ResumeAgent` tool rows (`result.agentId`, `agentModel`, `agentAccount`, `agentUsage`) | `result.agentId` (ResumeAgent: `input.agentId`) | The parent transcript survives restore; only nested subagent history is bounded. |
| Live account, held time, failover | `LeaseSnapshotContext` (`leaseState.ts`), `selectLeaseForOwner` | `ownerId === agentId` | Exists only while a run holds a Codex lease. Absent for Anthropic-path workers. |
| Foreground activity | Transcript row children (`agentActivityOf` logic) | same row | Background runs emit no nested progress; the projector ignores `task_progress`. |

### State derivation

- Active group, in order: waiting (blocked handoff) first, then running,
  background, resumed by launch order.
  - running / background: live worker `status: running`, `isBackgrounded`.
  - resumed: live and running, with a `resumedAt` newer than the run's last
    terminal time. Badge is the background ring; the word "resumed" shows.
  - waiting: live worker `handoffStatus: 'blocked'`. Note it is a completed run
    with no eviction deadline, not a paused one.
- Finished group, newest first: done, stopped, failed. Built from terminal
  evidence, not from the live snapshot alone:
  - a live entry with `status` completed / failed / killed (and not blocked);
  - a transcript row for that agent whose state is settled
    (`deriveAgentToolState`), which is the only evidence for foreground runs:
    `unregisterAgentForeground` removes them from the task store at the end
    unless deliveries are pending.
- A live worker that disappears with no terminal evidence yet keeps its last
  active row until the transcript result lands (bounded wait; if none arrives,
  drop it rather than invent an outcome).
- Dedupe by `agentId`; a resumed agent has one row, carrying its latest run.

### Clear

Clear records, per session, the set of `(agentId, terminal run identity)` that
were finished at the time of clearing. Use the run's tool-use id or end time as
the run identity so a later resume and finish of the same agent shows again.
Persist it with the `promptDraftPersistence.ts` pattern (versioned JSON under a
`catcode.`-prefixed key, bounded). Before relying on the key, verify which
session identity survives app restart for a restored session.

### Finished row click

`TasksDialog` resolves workers only against the live snapshot, so an evicted
finished worker has nothing to open there. Open decision for the operator:
recommended behavior is to scroll the transcript to that agent's card and
expand it; the alternative is a transcript-derived detail view in the dialog.

## Hover strip contents

Line A sits beside the name, line B beside the task. Never repeat what the
anchor shows.

| State | Line A | Line B |
|---|---|---|
| running | model (omitted on a row that already shows a differing model), account | live activity |
| background, resumed | model, account, failover if any | `held <lease age>` |
| waiting | model, recorded account | blocked reason |
| done | model, tool calls and tokens | verdict and result summary, when present |
| failed, stopped | model, recorded account | none |

- Held time and failover come only from a live lease (`leaseHeldLabel` on the
  lease's `createdAt`), never from worker start time.
- Account after a run ends is the result's recorded stamp, as on the transcript
  card. Omit when unknown.
- Chip popover: name (or task when unnamed) and state word, then lines A and B.
  It always shows the model.

## Layout

- Decide panel or chip from the measured pane (ResizeObserver on the pane),
  not the window: the panel docks flat when the gutter beside the
  `--transcript-width` column fits panel width plus margins; otherwise chip,
  and clicking it opens the panel floating with `--elev-popover`.
- Smallest supported layout: 852×467 window, up to three panes, a pane as
  narrow as 20% of the workspace (`MIN_WINDOW_*`, `MIN_WORKSPACE_PANEL_WIDTH`).
  When even the floating panel cannot fit inside the pane, the chip opens
  `TasksDialog` on the Workers tab instead.
- Keep the panel, strip, and popover inside the pane (`WorkspacePanels` clips
  overflow). When the strip has no room to the left, show it as a popover below
  the row, clamped to the pane.
- Cap the list by available pane height, not a fixed 360px.
- Names truncate with an ellipsis (no length limit exists in
  `normalizeExplicitSubagentName`). Unnamed workers (`selectWorkerDisplayName`
  returns null, the common case) show the task in the name line. Unknown types
  use the existing neutral `agentTypeMeta` fallback.

## Accessibility

- The chip is one button whose accessible name lists each face's name and state.
- Rows are buttons; the strip is linked with `aria-describedby` while shown,
  opens on hover and on keyboard focus, stays open while hovered, Esc closes.
- Finished toggle carries `aria-expanded`; collapsed rows are `inert`.
- An empty dock is removed from the tree, not hidden.
- Collapse returns focus to the chip; expand focuses the panel's first row.
- Announce failed, finished, and resumed through one polite live region.
  Wording follows CLAUDE.md §7.

## Appearance and motion

- Add semantic roles in `theme.css` for both appearances: the attached row and
  strip fill, the chip hover fill, and the resume arrival wash (reuse the
  `--source-project` hue the workspace-move arrival uses). No raw hex in
  components; styling in stylesheets/classes, not inline `style`.
- Timings from the mockup: morph 340ms open / 260ms close, row reorder 260ms,
  settle hold 0.7s (1.5s failed), arrival wash 1.8s, strip 190ms in / 140ms
  out. Map to the `--motion-*` tokens where one fits.
- `prefers-reduced-motion`: state changes apply instantly; no morph, wash, or
  reorder animation.
- Per-render entrance classes are cut short by the next rerender; use
  `entranceLatch.ts` for the arrival and settle effects.

## Persistence

- Collapsed (chip) preference: app-wide, `viewPreference.ts` pattern.
- Finished open/closed: per pane, in memory, closed on load.
- Clear markers: per session, persisted (see Clear).

## Code ownership

New modules (renderer TSX exports components only; helpers in `.ts`):

- `subagentDockState.ts`: pure selector from (live workers, tasks snapshot,
  transcript rows, lease snapshot, clear markers) to `{ active, finished,
  chipFaces }` with per-row display fields and strip lines.
- `subagentDockPersistence.ts`: clear markers and the collapse preference.
- `SubagentDock.tsx`: chip, panel, Finished disclosure, strip, morph.
- Move `agentModelOf`, `agentAccountLabel`, `agentActivityOf`, and the usage
  read out of `TranscriptView.tsx` into a shared `.ts` module used by both the
  transcript card and the dock, without behavior change.

Edits:

- `SessionPane.tsx`: mount the dock; remove the `WorkerRoster` mount.
- `App.tsx`: remove `TasksStrip` and its mount; pass the pane's tasks snapshot
  and transcript rows the dock needs if `SessionPane` lacks them.
- `theme.css`: new roles above.
- `WorkerRoster.tsx`: delete if nothing else renders it; update its tests.
- Docs: `DESIGN.md` components, `docs/maps/web-app-runtime.md`, and the parity
  ledger rows for `TasksStrip`, the docked roster, and `bgTaskPill`.

## Delivery order

Each step is a coherent, verified commit.

1. Extract the shared transcript agent helpers. No behavior change; existing
   transcript tests pass.
2. `subagentDockState.ts` with table tests covering: blocked completed as
   waiting; foreground worker that vanishes then gains a transcript result;
   resumed while backgrounded; failed settling to Finished; dedupe across
   resume; clear not resurrected by the next snapshot; resume after clear
   shows again; unnamed worker; strip lines per state and anchor; lease-only
   held and failover; Anthropic-path worker with no lease.
3. Persistence module and tests with isolated storage.
4. `SubagentDock.tsx` static structure, tokens, accessibility, pane-measured
   layout; mounted alongside the old surfaces.
5. Motion: morph, settle and reorder, arrival wash, strip.
6. Remove `WorkerRoster` mount and `TasksStrip`; update tests and docs.
7. GUI verification in Cat Code Dev per
   `docs/migration/process/GUI-VERIFICATION.md` (needs operator authorization;
   otherwise leave operator steps).

## Verification

- `bun test app/`, `bun run --cwd app typecheck`,
  `bun run --cwd app typecheck:sidecar`, `bun run --cwd app renderer:build`.
- `app/renderer/src/userVisibleText.test.ts` covers new strings.
- Behavior tests at the selector layer; DOM-harness tests for layout mode,
  disclosure, inert rows, and accessible names.
- Live checks the headless suite cannot prove: morph and strip geometry in a
  real pane, split view, smallest window, light appearance, reduced motion.

## Open items

- Finished row click for evicted workers (recommendation above).
- Confirm the local-agent task id equals `agentId` for the `resumedAt` join.
- Confirm which session identity survives restart for Clear persistence.
