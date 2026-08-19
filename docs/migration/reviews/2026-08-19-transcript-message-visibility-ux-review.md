# Transcript message-visibility UX review

Date: 2026-08-19 · Scope: desktop app (`app/`) · Method: source-level review +
one executed probe against the real projector (no GUI driven). Requested focus:
scroll-to-top behavior, how many messages are shown and the logic behind it,
and whether closing other sessions helps a session that hit its message max.

## Verdict

The scroll machinery is well built (anchor-preserving corrections, honest
stick-to-bottom). The problem is the story of *how many messages you are
seeing*: the same session shows a different total depending on whether it is
live, reloaded, or resumed, and every truncation indicator that exists at the
protocol level is suppressed on the surfaces where truncation actually
happens. One probe-confirmed defect falls out of this: a truncated replay can
render a subagent's internal messages as if the user typed them.

Closing other sessions is handled correctly (memory freed, no cross-session
interference, durable history untouched) but does nothing for a capped
session: every cap is a fixed per-session constant, not a shared pool.

## 1. Scroll-to-top behavior

What works:

- **Reading position is protected while streaming.** One pane-local
  coordinator batches estimated→measured height corrections per animation
  frame and moves `scrollTop` only for changes above the visible anchor;
  bottom-lock wins only while pinned (`app/renderer/src/paneAnchorModel.ts:54`,
  `app/renderer/src/markdownScrollCoordinator.ts:159`). A reader scrolled up is
  never yanked back. Self-scroll suppression prevents correction feedback
  loops (`markdownScrollCoordinator.ts:127-134`).
- Stick-to-bottom uses a 120px gap threshold (`app/renderer/src/App.tsx:4649-4654`);
  the jump-to-bottom pill doubles as a live-activity indicator (verb + elapsed,
  "Waiting for approval" when paused) while scrolled up (`App.tsx:4928-4959`).
- The stick-to-bottom signature is derived from RENDERED rows, not the capped
  raw log, precisely because the cap once pinned `messages.length` and
  stranded the pane above the newest row (`App.tsx:4572-4578`).

Concerns:

1. **Scroll position is lost on every tab switch.** Binding a pane always
   slams to the bottom (`App.tsx:4553-4558`). Scroll up to read, switch tab,
   come back: you are at the bottom again.
2. **The top of a resumed transcript is a silent cliff.** History beyond the
   replayed tail is simply absent; there is no marker on live panes and no
   "load older" affordance anywhere in `app/renderer` (verified exhaustively).
   The full JSONL exists on disk with no UI route to it.
3. **No outer virtualization: all rows always mounted**
   (`app/renderer/src/TranscriptView.tsx:403-418`). Scrolling to the top is
   cheap once bound; the cost lands at bind time (a 5,000-row session mounts
   5,000 row trees before the pane is usable). Known and tracked: CC-59
   Stage-Two decision is deferred to a measured gate
   (`docs/plans/2026-08-15-cc59-transcript-leaf-virtualization-execution.md`).

## 2. The message-visibility pipeline

A message travels: engine JSONL on disk → (resume-only) sidecar history load →
sidecar replay → main's replay ring → renderer stores → read-time selection →
screen. Each hop has different units (messages vs frames vs rows) and its own
cap.

### Stage 0 — disk (unbounded)

The engine JSONL is complete and durable. Nothing in the app trims it; closing
a session deletes only the preview cache (`app/main/main.ts:1526-1528`), never
the JSONL.

### Stage 1 — resume load from disk (park-resume/restore only)

`app/sidecar/index.ts:271-299`: reads JSONL with `maxMessages: 4,000` and a
2× byte read window (8 MiB), merges the compaction seed, then splices subagent
sidechains. **Subagent branches get only the leftover budget**
(`budget = 4,000 − mainLength`, `app/sidecar/subagentHistory.ts:268`), loaded
in reachability waves. A 3,900-message main transcript leaves 100 frames for
all branches combined; restored Agent cards on long sessions come back
childless, indistinguishable from agents that produced nothing.

### Stage 2 — sidecar replay to the renderer (resume wire cap)

`app/sidecar/sidecarServer.ts:996-1053`: walks newest→oldest counting
serialized frame bytes; STOPS (never skips) at the first overflow of
`MAX_HISTORY_REPLAY_FRAMES` 4,000 or `MAX_HISTORY_REPLAY_BYTES` 4 MiB
(`app/shared/limits.ts:167-168`), so the tail is contiguous. Any omission
emits one boundary error frame before the tail: "Only the N most recent
messages are shown." (`catcode.history-truncated`,
`app/shared/protocol.ts:600`). Here N is honest: one frame = one full message.

The 4,000 figure is empirically sized: `limits.ts:134-166` records the
measurement over 142 real transcripts that corrected the previous 400 (which
truncated 18 of them, worst case dropping 645 of 1,045 messages).

### Stage 3 — main's replay ring (reload cap)

`app/main/replayBuffer.ts:118-182`, four retention tiers:

| Tier | What | Budget |
|---|---|---|
| `head` | the one `ready` frame | permanent, outside budget |
| `sticky` | ~18 once-per-attach snapshot kinds, replaced in place | one slot each, outside budget |
| `ring` | ALL transcript `event` traffic + lifecycle, errors, pongs, `*.result` | 8,000 frames / 8 MiB, oldest-first |
| `preview` | generated-image frames by tool-use id | 32 frames / 32 MiB, own budget |

Non-obvious properties:

- **Frames ≠ messages in this ring.** Streaming puts every `stream_event`
  delta in alongside the final assistant frame, and pongs/lifecycle/results
  share the budget. 8,000 frames of a chatty streaming session is far fewer
  than 8,000 messages.
- **The marker's wording is wrong in kind**: `"Only the ${retained} most
  recent messages are shown."` reports `entry.recent.length`
  (`replayBuffer.ts:372-385`), a FRAME count including deltas and pongs. If
  ever surfaced it would overstate the retained message count, possibly by
  several times.
- `truncated` latches forever once set (`:295`) — honest, evicted frames are
  gone. An individually oversized frame (>8 MiB) is dropped alone rather than
  clearing the ring (`:274-284`).
- Global ceiling math is documented at `:69-77`: `MAX_LIVE_SESSIONS` 32 ×
  8 MiB = 256 MiB worst case in main; idle-park frees a parked session's
  buffer.

### Stage 4 — renderer stores (three projections of one stream)

- **`transcriptProjector` — the store that IS the screen. Uncapped.** Only
  `kind:'event'` + `event.type:'message'` frames project
  (`app/renderer/src/transcriptProjector.ts:954-957`). Error frames — both
  truncation markers included — are no-ops, which is why live panes cannot
  show a truncation boundary today. `seenFrameIds` dedupes replays by uuid.
- **`rawMessageLog`** — `DEFAULT_MAX_RAW_MESSAGES` 8,000 /
  `DEFAULT_MAX_RAW_MESSAGE_BYTES` 8 MiB per session
  (`app/renderer/src/rawMessageLog.ts:41,47`), oldest-first eviction. Feeds
  only the context donut, the composer gate, and the debug export. Both
  truncation-marker frames are dropped at display (`:133-139`) because the
  ring notice once pinned an undismissable red error line (`:9-21`).
- **`previewTranscriptState`** — projects the on-disk cache for preview panes;
  the ONLY store that surfaces a `truncationMessage`, and only the
  history-replay one — the ring boundary is deliberately skipped
  (`app/renderer/src/previewTranscriptState.ts:141-146`).

### Stage 5 — read-time selection (message → visible row count)

1. **Message → 0..N rows.** Of 17 `SDKMessage` variants only 5 project
   (`assistant`, `user`, `system`, `result`, `stream_event` as replaceable
   preview); 12 are explicit no-ops (`transcriptProjector.ts:979-1069`). Each
   content block becomes its own row (`:1224-1238`): one user message with
   text + two images = 3 rows; a tool_result-only user frame = 0 rows.
2. **Hidden tier.** `isSynthetic: true` frames are retained but filtered from
   the default view (`:1197`, `:574-580`), mirroring the engine's
   `shouldShowUserMessage`. The reveal toggle is a filter, not extra history.
3. **Nesting.** A row whose `parentToolUseId` matches an existing tool-use row
   folds under that card (`:756-768`); subagent traffic leaves the top-level
   flow.
4. **Grouping.** 2+ Agent tool_use rows sharing one API message id collapse
   into one DelegateGroup card (`:848-887`).
5. `TranscriptView` mounts every resulting display item; no windowing.

## 3. How many messages the user sees, by path

| Path into the pane | What binds | Truncation indicator |
|---|---|---|
| Live since spawn | nothing (projector uncapped) | n/a — complete |
| Renderer reload of a live session | ring tail ≤8,000 FRAMES / 8 MiB (deltas, pongs, results count) | none — marker minted, dropped at display |
| Park/close → resume | ≤4,000 MESSAGES / 4 MiB; subagents from leftover budget | banner in preview state only; vanishes on engage |
| Preview of a dead session | whatever the cache inherited (≤8 MiB), fail-closed to nothing on corruption | history-replay banner only; ring truncation invisible |

Consequences:

- **Reload and resume can disagree in either direction.** Reload retention was
  spent in frames including deltas; resume retention in full messages from
  disk. A delta-heavy session can show MORE history after park+resume than
  after a reload. Nothing communicates this; history appears to come and go
  nondeterministically.
- **Recovery exists but is undiscoverable.** A pane that starts
  mid-conversation after a reload could recover up to 4,000 messages via
  park+resume. No UI hints at it. The only truncation affordances anywhere:
  the preview banner (`App.tsx:4907-4914`), a sessions-list note
  (`SessionsPage.tsx:438-442`), and one line in the clipboard debug export
  (`appModel.ts:404`).
- **The banner disappears at the exact moment of engagement.**
  `truncationMessage` is returned only while the pane is a preview; the
  preview→live handover withdraws the warning even though the live replay is
  truncated by the same or tighter caps. Shown read-only, withdrawn
  interactive: backwards.

## 4. Probe-confirmed defect: orphaned subagent rows impersonate the user

Both truncation paths drop OLDEST first (ring eviction
`replayBuffer.ts:288-296`; resume newest-tail walk
`sidecarServer.ts:1005-1035`). An Agent tool_use parent is always older than
its children, so a boundary landing inside a subagent run retains child rows
whose parent card is gone. In `selectNestedTranscriptRows`, a child whose
parent misses `byToolUseId` falls through to TOP LEVEL
(`transcriptProjector.ts:756-768`).

Executed against the real projector (probe, 2026-08-19): full replay = Agent
card with 2 nested children (2 top-level items); same frames minus the parent
= the subagent rows surface as 3 top-level items. The rows carry `agentName`,
but only the Agent CARD builder ever reads it
(`TranscriptView.tsx:2140-2148`). The top-level renderers ignore it:

- `user-text` → `<UserBubble>` (`TranscriptView.tsx:798`) — a subagent's
  internal task prompt renders as a bubble indistinguishable from a message
  the user typed;
- `assistant-text` → `<AssistantProse>` (`:788`) — subagent prose renders as
  the main assistant's own reply.

Combined with the missing truncation marker, a truncated transcript can open
with fabricated-looking conversation and no cue anything was cut. Spawned as a
follow-up task 2026-08-19 ("Guard orphaned subagent rows after truncated
replay"): fixture first, then a guard (attribution, tolerant placeholder card,
or hidden-tier routing) consistent with the degrade-gracefully doctrine and
the rows-never-rewritten rule.

## 5. Message max + closing other unused sessions

**What the max is:** compile-time constants per session
(`DEFAULT_MAX_BUFFERED_*`, `DEFAULT_MAX_RAW_*`, `MAX_HISTORY_REPLAY_*`). No
runtime sizing, no shared pool, no memory-pressure reclaim. The only global
numbers are ceilings that do not rebalance: 32 live sessions × 8 MiB ring, the
32 MiB preview tier, and the startup preload budget (12 sessions / 64 MiB
projected, `app/renderer/src/sessionPreload.ts:15-17` — affects open speed,
not retention).

**What closing does — correct and careful:**

1. Host close/restart fires `evictReplay` in a fixed order: persist the
   transcript cache FIRST (snapshot → distill → synchronous atomic write),
   cancel pending replay flush, clear the attachment gate, drop the ring entry
   (`app/main/main.ts:2638-2642`, `replayBuffer.ts:344-346`).
   Persist-before-evict means a close cannot lose the preview.
2. A fully removed row deletes its cache file (`main.ts:1526-1528`); the
   engine JSONL survives and the session stays openable from the history
   catalog.
3. The renderer `session-removed` sweep drops the projected transcript, raw
   log, preview entry, queued/retained prompts, recall requests, and every
   per-session domain store (`App.tsx:1168-1204`). Parking gets the same
   release with the preview cache re-admitted under startup bounds
   (`App.tsx:1151-1166`).
4. Eviction loops are strictly per-`SessionEntry`; no code path reads another
   session's entry. Cross-session interference is impossible by construction.

**What closing does for the capped session: nothing.** Caps do not grow,
evicted frames do not return. The only recovery route is park/resume (disk has
everything, re-read under the 4,000-message cap) — and nothing tells the user
that closing sessions is, for this purpose, a no-op.

## 6. Findings ranked

1. **Silent truncation on live/reloaded panes.** Both boundary sentences are
   minted end-to-end and both are dropped before display. Smallest fix with
   the largest effect: project the history-truncation frame as one quiet
   boundary row at the top of the transcript (not an error line).
2. **Orphaned subagent rows render as user/assistant messages**
   (probe-confirmed, §4). Follow-up task spawned.
3. **Ring marker counts frames, says "messages"** (`replayBuffer.ts:382`).
   Must count `event.type === 'message'` frames if ever surfaced.
4. **The preview truncation banner vanishes on engage**, exactly when the
   information becomes actionable.
5. **Subagent history starvation on resume** — childless Agent cards look
   like agents that did nothing (`subagentHistory.ts:268`).
6. **Path-dependent history totals** (reload vs resume vs live) with no
   explanation and an undiscoverable recovery route.
7. **Scroll position lost on tab switch** (`App.tsx:4553-4558`).
8. **Context donut edge**: a retained tail with no usable usage message falls
   back to `DEFAULT_CONTEXT_WINDOW` and renders a confident percentage
   against a fabricated denominator (`contextUsage.ts:400`); the donut is
   never hidden by design.
9. **Debug export self-contradicts**: complete projected transcript beside a
   truncated raw dump with no explanation of the disagreement
   (`appModel.ts:384-408`).
10. `REPLAY_BUFFER_TRUNCATION_REQUEST_ID` is declared twice across the process
    boundary (`replayBuffer.ts:91`, `rawMessageLog.ts:30`); the renderer copy's
    own comment requests promotion to `shared/protocol.ts`.

## 7. Uncertainties

- Source-level review; the app was not launched. The orphan artifact (§4) is
  executed at the projector layer but not reproduced in the live GUI.
- The reload-vs-resume disagreement is logic-verified, not measured; the ~142
  transcripts in this repo's store could quantify it.
- Feel-level scroll judgments (120px threshold, bind-time bottom slam) need an
  operator pass; the renderer suite is largely SSR and blind to interaction.
