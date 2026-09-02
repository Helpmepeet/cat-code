# Idle-park, "disconnected", and the replay ring — assessment against the owner's complaint

**Date:** 2026-09-02
**Kind:** design assessment, read-only. No code changed.
**Question asked:** the owner avoids the desktop app for two reasons, message
truncation and how sessions disconnect/park. Do the three mechanisms behind
that (idle-park, the deliberate `disconnected` overlap, the replay/reconnect
buffer) explain the friction, and what is worth changing? Every operator
ruling and every locked decision was declared reopenable for this review.

**Verdict:** the design explains both complaints, but not through the paths
the brief pointed at. "Disconnect" is park, and it lands on the owner's
primary session twice an hour; on top of that, every ordinary quit leaves the
parked sessions reading **crashed** on the next launch. "Message truncate" is
most likely the replay ring: the ring is about 95% streaming deltas, so it
holds roughly two hundred real messages instead of the thousands its caps
suggest, and that tail is what a reload or a relaunch preview shows. That is
the leading hypothesis, not a reproduction; §4 states the evidence and what
would confirm it. No locked decision needs reopening: the friction comes from
two tunables and one retention bug. The RAM the park policy defends is about
0.9 GB of this machine's 24 GB, one park saves under 1% of it, and the memory
ceiling used to justify the ring's size is overstated eightfold (§9.1).

Everything below is read from source or measured on this machine unless the
§Extrapolations section says otherwise. Measurements read aggregates only; no
transcript content left the analysis.

> **Revised 2026-09-02 after the cold review**
> (`2026-09-02-idle-park-disconnect-truncation-assessment-review.md`, `f0c04357`).
> Each finding was re-verified against source before this revision:
>
> - **F1 accepted.** Recommendation 2's compaction boundary was wrong: an
>   `assistant` frame is emitted per content block, and the projector needs the
>   stream's `message_start` for every later delta. Boundary corrected in §5.
> - **F2 accepted in part.** The model is restored from the transcript on
>   resume and persisted effort levels survive; my "runs on the defaults"
>   claim was wrong for both, and the `modeApi: null` citation was Agent Mode,
>   not permission mode. Permission mode and fast mode DO reset, which the
>   review did not dispute. §2 rewritten field by field.
> - **F3 narrowed, not accepted as stated.** The correlation the review asked
>   for is now in §4: all four sessions in the Aug 30 window have transcripts
>   of 1.4–2.6 MiB, under the 4 MiB restore cap, so park→restore removed no
>   rows for them, while two of them have ring-truncated caches at 200 and 468
>   messages. The ring stays the leading explanation; it is labelled a
>   hypothesis pending the owner's reproduction, and the 4 MiB reset path is
>   kept as the secondary one.
> - **F4 accepted.** Five open tabs are not five live engines; no cap victim
>   was produced in the window. The TTL is the operative knob; §2 and §5
>   corrected.
> - **F5/F6 accepted.** Main can mint the load-earlier anchor; that is better
>   than a renderer-authored uuid. §6 corrected.
> - The review's framing that the document "should not be used as an
>   implementation brief" is agreed; it was written as an assessment, and the
>   §5 sketches now state the ordering requirements they omitted.
> - **Constants audit** added the same day as §9 on the owner's ask, and folded
>   into the verdict, §5 (items 6–8) and §7.

## 1. Evidence

### 1.1 The owner's own diagnostics export (2026-08-31)

`cat-code-diagnostics_31_Aug.json` at the repo root (untracked, the operator's
own **Save diagnostics bundle** output) covers one launch, 2026-08-30 15:52 to
17:33 UTC, with five sessions open (`renderer.health.sample` reports
`sessions: 5` throughout). Operational records, non-routine only:

| Signal | Count |
|---|---|
| `sidecar.exit` | 3, all `exitCode: 5` (`PARKED_EXIT_CODE`) |
| `sidecar.disconnected` (socket loss under a living child) | 0 |
| `sidecar.spawn.started` / `session.restore.completed` | 7 / 2 |
| `session.turn.started` / `.completed` | 17 / 16 |

The parks, against the session's last `result` message (the frame that stamps
recency, `app/host/host.ts:207-215` → `registry.markMessageSent`):

| Session | Last turn ended | Parked | Restored by the next message |
|---|---|---|---|
| ca05a9f2 | 16:25:27 | 16:46:17 | 16:59:21 |
| 3440ab20 | 16:37:29 | 16:58:17 | not in window |
| ca05a9f2 | 16:59:47 | 17:20:17 | 17:24:42 |

ca05a9f2 ran about fifteen turns in the window. It was parked twice, each
time 20m30s to 20m50s after its last turn ended (the 20-minute TTL plus up to
one 60 s sweep), and the owner came back to it 13 and 4 minutes later. The
supervisor source corroborates the pattern from a different window:
"a log window in which all 11 abnormal exits were parks"
(`app/supervisor/supervisor.ts:416`).

The bundle labels the parks `expected: false` at error level. Current source
already fixes that (`supervisor.ts:418`, `cleanExit = code === 0 || parked`);
the bundle predates the fix.

### 1.2 The at-rest transcript caches (`~/.cat-code/desktop/transcript-cache`)

A cache is the distilled replay-ring snapshot persisted at park/close
(`app/main/main.ts:1841-1848` `persistTranscriptCache` → `clearSession`;
allowlist in `app/main/transcriptCache.ts:119-140` keeps message events plus
the two truncation markers). So the caches show what the ring held.

| Measure | Result |
|---|---|
| Cache files | 176 |
| Files carrying the ring marker (`catcode.replay-truncated`) | 59 (34%) |
| Retained-message count the marker reports | min 2, median 468, max 8,000 |
| At-cap caches (≥7,900 frames) | 41 |
| At-cap: `stream_event` frames | 318,938 · 232 MiB · mean 763 B |
| At-cap: finished messages (user/assistant/system/result) | 8,663 · 31.3 MiB · mean 3,792 B |
| Finished messages per full ring | about 210 |
| Finished messages 8 MiB would hold with no deltas | about 2,200 |

At-cap caches sit at 7,950–8,001 frames, so the 8,000-frame **count** cap is
what binds, contrary to the sizing comment in `app/main/replayBuffer.ts:66`
("raised until the BYTE budget below is what actually binds").

### 1.3 Recent engine transcripts (`~/.cat-code/projects/**/*.jsonl`, mtime ≤ 14 d)

| Measure | Result |
|---|---|
| Transcripts touched in the last 14 days | 139 |
| ≥ 4 MiB (`MAX_HISTORY_REPLAY_BYTES`) | 6 |
| ≥ 8 MiB | 2 |
| Largest | 12.9 MiB |

So the restore-time history replay (newest 4 MiB / 4,000 messages,
`app/shared/limits.ts:166-167`) truncates only a handful of the owner's
sessions. The ring, not the restore replay, is where truncation is felt.

## 2. Mechanism 1 — idle-park

**Design, verified against `app/main/idleParkDriver.ts`:** cap of 4 live
engines (`:41`), TTL 20 min (`:49`), recency = max of the three stamps
(`:138-144`, the `??` postmortem is accurate), visible panels excluded from the
victim pool but counted for the cap (`:166-187`), `canResume` filter (§1c)
applied (`:169`). Recency is bumped on a live `result` message
(`host.ts:207-215`), i.e. at turn END, not at submit — a long-running turn does
not become park-eligible the instant it finishes. The doc's claim that the
gate + latch cannot interleave with a submit holds: `handleFrame` is
synchronous, every gate read is synchronous
(`app/sidecar/sidecarServer.ts:2503-2536`, `:2566-2578`), and `onPark` →
`cleanup()` → `server.close()` runs inside the same dispatch
(`app/sidecar/index.ts:598-613`).

**Why it fires on the owner: the TTL, not the cap.** Only `spawning` and
`ready` descriptors count as live (`idleParkDriver.ts:55-58`, `:193`); a
parked tab stays open but does not count, so "five sessions open" is not five
live engines. No cap victim was produced in the Aug 30 window: 0bd22b4a
spawned at 16:25:32 with no park following it, and every observed park landed
20m30s–20m50s after a turn end, which is the TTL plus up to one 60 s sweep. A
20-minute TTL is simply shorter than the owner's gap between visits to a
session they are multiplexing. The knobs were set for "a typical 2–3 live
sessions" (`idleParkDriver.ts:18`); how many engines are concurrently live in
the owner's real use is not in the bundle (two of the five sessions predate
its window).

**What a park costs, verified field by field** (corrects the first edition,
which claimed everything the rail shows resets to defaults):

| Rail face | After park→restore | Evidence |
|---|---|---|
| Model | **Survives.** Resume selects the latest non-error assistant model from the transcript and installs it before QueryEngine construction. Narrow gap: a model picked in the rail but never answered on before the park is not in the transcript and does not come back. | `app/sidecar/sessionController.ts:225-236` `initializeSidecarModelProvider`, `:268-281` `selectResumedProviderModel` |
| Effort | **Persisted levels survive**, shared last-writer-wins across sessions; ephemeral levels (xhigh/ultra/numeric) die. | `sessionController.ts:312-320` `getInitialEffortSetting()`; `runControlsDomain.ts:145-155` `executeEffort` persists |
| Permission mode | **Resets** to the settings default. There is no per-session restore; `resumedInitialState` is applied before a fresh `toolPermissionContext`. | `sessionController.ts:127-144` `initialPermissionModeFromCLI`, `:302-309` |
| Fast | **Resets.** `setFast` writes the store only. | `runControlsDomain.ts:158-169` |
| Thread goal | **Survives** (the IDLE-PARK.md §7 DIE row is stale). | `app/sidecar/sessionResume.ts:106-110`, `:290` |

The first edition cited `sessionResume.ts:262` `modeApi: null` as the
permission-mode reset; that field is Agent Mode's API, not permission mode.

What this means on screen: CC-33 keeps the last model, effort, fast and mode
on the rail as read-only faces while parked
(`app/renderer/src/composerRailModel.ts`). On restore the fresh snapshots
replace them (`app/renderer/src/runControlsState.ts:66-83`), so the display
converges to the truth; the residual gap is that the held prompt's first turn
runs with the default permission mode and fast off, while the parked rail
showed otherwise until `ready`. Smaller than the first edition claimed, still
a promise the submit breaks for a session the owner had put into `auto`.

The DIE-list (IDLE-PARK.md §7) was accepted as "identical to what a
crash→restore already loses". True, but a crash is rare and a park happens
twice an hour; and two of its rows (model, thread goal) no longer match
source.
2. **The transcript is rebuilt.** The resumed sidecar's `ready` frame wipes
   the session's rows (`app/renderer/src/transcriptProjector.ts:1276-1288`)
   and the newest ≤ 4 MiB tail is replayed from disk
   (`sidecarServer.ts:1070-1130`). Scroll behaviour across the rebuild is
   unverified.
3. **§1d dead clicks** (IDLE-PARK.md §1d, still open per STATUS.md CC-33).
4. **A renderer reload while parked removes the tab.** A hydrated
   `disconnected` + restorable row never gains a tab
   (`app/renderer/src/shellState.ts:155-167` `foldTabMembership`), and a saved
   split that references it waits forever (`app/renderer/src/workspaceLayout.ts:141-150`
   `readyToRestoreLayout` needs every referenced session to be a pane).

## 3. Mechanism 2 — the `disconnected` overlap

**The renderer-side classification is sound.** `lifecycleConnectionStatus`
reads the exit code (`app/renderer/src/connectionState.ts:204-211`), the
`disconnectSettleMs` settle (`supervisor.ts:709-721`) removes the FIN-before-exit
flash, the two absorbed send-failure codes are the right two
(`connectionState.ts:295-301`), and the descriptor's `parked` bit is correctly
gated on `liveStatus === null` (`app/host/host.ts:918`).

**The overlap breaks on every quit.** `shutdownAll` calls
`markLiveCleanSync`, which skips any row whose `shutdown` is non-null
(`app/host/registry.ts:892-898`). A parked row is `'parked'`, so it stays
`'parked'` on disk; the next launch normalizes it to `'crashed'`
(`registry.ts:1244-1251`); the descriptor then carries `disconnected` +
`restorable` + `parked: false` (`host.ts:899, :918`); and every
descriptor-derived surface prints `crashed` in the dead tone
(`app/renderer/src/sessionStatusVisual.ts:74` falls through). The
normalization comment says this path is for "the app crashed while a session
was parked". It runs on every ordinary quit. Since most background sessions
are parked at any moment under a 20-minute TTL, most of the sidebar, the
Sessions page and the ⌘K palette read **crashed** after every relaunch. This
is the strongest single explanation for "disconnect" feeling pervasive rather
than occasional.

## 4. Mechanism 3 — the replay ring and truncation

**The ring is 95% streaming deltas.** The desktop turns on
`includePartialMessages` (`src/app-runtime/createRuntimeBackedAppSession.ts:41`,
`createQueryEngineAppSessionConfigFromSetup.ts:116`). Every delta is an
`event` frame of type `message` with `message.type === 'stream_event'`, and
`FrameReplayBuffer.record` retains it in the ring beside the finished message
it is a partial of (`replayBuffer.ts:326-336`). §1.2 measures the result:
about 7,800 deltas and about 210 finished messages per full ring.

**The 2026-08-19 retention report reached the wrong verdict on this.**
`docs/reports/2026-08-19-transcript-retention-cap-measurement.md` §3 argues
"sessions distilled to exactly 8,000 message frames … had essentially no
deltas occupying ring slots" and concludes "the cap VALUES are sound … the
defect is reporting, not retention". Its own §4 caveat admits the trace could
not separate a finished message from a delta. The caches can, and they say
the opposite: the 8,000 "message frames" are ~97% `stream_event`. The
`replayBuffer.ts:58-66` sizing rationale (six real transcripts, 223–1,413
finished messages) also counted finished messages and never the deltas that
sit between them on the wire.

**Where the owner sees it, verified paths:**

- **Renderer reload of a live session.** `onRendererReady` replays the ring
  (`app/main/attachmentGate.ts:196-201`); the sidecar does not re-replay
  history on a reload because main never re-runs connect
  (`replayBuffer.ts:23-27`). The pane shows the last ~200–470 finished
  messages and the boundary row.
- **Relaunch / reopening from the sidebar.** The preview is the distilled ring
  tail with the boundary row and no load-earlier control, because a preview
  has no engine (`app/renderer/src/App.tsx:3692-3702`). Typing engages a
  resume, which then replays up to 4 MiB from disk.
- **Park → restore, the secondary path.** Every resumed `ready` resets the
  renderer's rows and the replacement is a newest tail capped at 4 MiB, so a
  session above that cap loses visible rows on every park. That did not apply
  to any session in the Aug 30 window:

  | Session (Aug 30) | Transcript | Cache on disk today |
  |---|---|---|
  | ca05a9f2 (parked twice) | 2.07 MiB, 691 records | 461 finished, 0 deltas, no marker (backfill-written) |
  | 3440ab20 (parked once) | 1.36 MiB, 384 records | 7,058 frames, 6,745 deltas, no marker yet |
  | b64260f6 | 2.61 MiB, 660 records | 7,997 frames, 7,528 deltas, marker N = 468 |
  | 0bd22b4a | 1.47 MiB, 588 records | 8,000 frames, 7,799 deltas, marker N = 200 |

  All four are under the 4 MiB cap, so park→restore replayed them whole, while
  two of them already carry ring-truncated caches. The 6 transcripts above
  4 MiB in the last 14 days (§1.3) are real but were not the parked ones.
  The brief's hypothesis that park-driven buffer loss (`main.ts:1847`
  `clearSession`) is the truncation mechanism is therefore not supported;
  that loss becomes visible only through the two paths above.

**Status of the claim.** The ring is the leading explanation because it is
the only truncation path that fires on ordinary sessions: 59 of 176 previews
on disk are ring tails today, and a ring-distilled cache is replaced by the
backfill worker only when the transcript's mtime is newer than the cache
(`app/main/main.ts:883-884` `isCacheStale`), which a park-time cache rarely
is. It remains a hypothesis until the owner reproduces the complaint on a
named session; what would confirm it is the boundary row appearing on a
reload or a relaunch preview of a session the owner considers truncated.

**Accounting details, verified:**

- `retainedMessageCount` (`replayBuffer.ts:429-438`) correctly excludes
  `stream_event`, but counts `system`, `result` and tool-result `user`
  messages as "messages", so N overstates what a reader calls a message.
- **The count is never displayed.** The projector only latches
  `historyTruncated` (`transcriptProjector.ts:1296-1322`) and the row prints a
  constant label (`app/renderer/src/TranscriptView.tsx:974`). The Aug 19
  finding-3 fix computes a number nobody renders.
- `recovered: true` frames are correctly exempt from the ring
  (`replayBuffer.ts:312`).

## 5. What to change, ranked by value against cost

1. **Mark parked rows clean on quit.** One condition in `markLiveCleanSync`
   (`registry.ts:895`) or a sibling `markParkedCleanSync`. Removes the red
   **crashed** roster after every relaunch. Trivial.
2. **Stop retaining `stream_event` partials in the ring once their message
   has fully stopped.** Main-only, in `FrameReplayBuffer.record`; no protocol,
   no inbound surface, no security change. Roughly ten times more real history
   per reload and per preview for the same 8 MiB, and the at-rest caches shrink
   about seven-fold. **Boundary, corrected after review:** compact at the
   stream's `message_stop` (or at the turn's `result`), never at a finished
   `assistant` frame. The provider loop yields one `assistant` message per
   `content_block_stop` and reaches `message_stop` only later
   (`src/services/api/claude.ts:2425-2467`, `:2561`), and the projector opens
   a stream on `message_start`, requires that id for every later delta, and
   closes it on `message_stop`
   (`app/renderer/src/transcriptProjector.ts:1894-1906`, `:1948-1968`,
   `:1991`). Dropping deltas at the first `assistant` frame would strip the
   `message_start` a later block's deltas need on reload. Keep an interrupted
   stream's deltas until the next `message_stop` or `result`. Add a
   replay-buffer plus projector regression: two blocks, reload between block
   completions. Then re-measure: the byte cap binds again and the 2026-08-19
   verdict is void.
3. **Raise the idle TTL.** `PARK_IDLE_TTL_MS` 20 min → 120 min
   (`idleParkDriver.ts:49`) stops every park observed in §1.1. Cost is RAM
   held for longer by sessions the owner has genuinely left, about 223 MB
   each. If that is too much, gate the TTL on free system memory
   (`process.getSystemMemoryInfo()` in main) rather than on time. Leave
   `MAX_LIVE_ENGINES` alone until concurrent-live counts are measured: the
   bundle shows no cap victim, so raising it is not supported by this
   evidence.
4. **Restore permission mode and fast across a park, with an ordering
   barrier.** Scope narrowed after review: model and persisted effort already
   survive (§2). What does not is the per-session permission mode and fast.
   Any fix must (a) capture the values BEFORE the park, since the resumed
   sidecar's fresh `permission.context` and `run-controls.snapshot` overwrite
   the renderer's retained faces on `ready` (`runControlsState.ts:66-83`);
   (b) hold them as separate pending-control state, because `PendingSubmit`
   carries none of them; and (c) apply them before the held prompt is
   released, since the drain submits on the first `ready`
   (`App.tsx:2925-2980`). The cleanest place is sidecar startup, before
   `ready`: main records the last `permission.context` mode and fast flag it
   forwarded for that session and passes them as spawn config on restore, at
   the cost of a registry field and its migration (CLAUDE.md §6). A
   renderer-side replay of `permission.setMode` and the fast verb after
   `ready` is possible only with the barrier in (c); never replay effort this
   way, because `setEffort` writes the persisted setting and would clobber a
   newer choice made in another session.
5. **§1d ruling.** Pick (b), route the click to the composer, plus the (c)
   tooltip. A better option not on the table: keep the pickers live while
   parked and let a pick trigger the same restore a submit does
   (`resolvePendingSubmit` → `'restore'`, `app/renderer/src/composerState.ts:894-916`).
   The pick then needs item 4's pending-control state and barrier; without
   them it is overwritten by the fresh snapshot on `ready`.
6. **Raise the ring to 16 MiB, after item 2 and not before.**
   `DEFAULT_MAX_BUFFERED_BYTES` 8 → 16 MiB (`replayBuffer.ts:83`), leaving
   the 8,000-frame count as a backstop. Cost is at most 64 MiB of main at the
   current cap and 128 MiB at a cap of 8, because park clears parked buffers
   and the 256 MiB figure in the file assumes 32 live sessions that the cap
   never allows (§9.1). Once deltas stop riding the ring, 16 MiB holds every
   one of the last 14 days' transcripts whole on a reload or a preview
   (§9.2). Before item 2 it buys ~420 messages and is not worth the churn.
   `MAX_TRANSCRIPT_CACHE_BYTES` follows automatically. Do NOT raise the 4 MiB
   restore replay in the same change: every replayed row stays mounted for
   the pane's life, its per-row cost is unmeasured (§7), and the
   replay-below-ring invariant (`limits.ts:139-145`) must keep its headroom.
7. **Let the diagnostics export show a day.** `MAX_BUNDLE_BYTES` 2 MiB and
   `MAX_FILE_BYTES` 512 KiB (`app/main/diagnosticsBundle.ts:52-53`) cut the
   Aug 30 export to 100 minutes of a day-long launch with 2,583 records
   suppressed at the source (§9.5). The log itself keeps 14 days. Raise the
   bundle cap, or add an operational-only export that skips the delivery
   trace, which is what dominates the bytes.
8. **Gate renderer-health escalation on visibility.** All seven
   `renderer.health.unavailable` errors in the bundle carry `visible: false`
   and 59,999 ms lag, which is macOS hidden-window throttling
   (`mainDecisions.ts:164-167`, §9.3). A hidden window should not count
   misses toward the flight recorder.

Two numbers to watch rather than change: the registry holds 193 of 256 rows
today, 53 of them `crashed`, and the reap at 256 drops the oldest terminal
rows from the sidebar (§9.4); and the 8 MiB export cap is within reach of the
two largest recent transcripts.

**Locked decisions.** None needs reopening. N-process is why park exists, but
replacing it to save ~230 MB per idle tab is a rewrite of the supervisor plane
for a problem item 3 solves by spending the RAM. Die-with-window makes every
relaunch go through preview → resume, and item 2 is what makes that preview
whole. UDS transport, raw-event fidelity and the two-id model are untouched by
any of the above. The one recorded rule this document does propose to bend is
HISTORY-LOAD-EARLIER's "the renderer names a session and a verb, nothing
else", and only by a main-authored field (§6).

## 6. Correctness risks found along the way

- **Load-earlier can declare a transcript complete over a hole or a tail.**
  After a reload of a session started in the app, the sidecar's `history` is
  empty, so `handleHistoryLoadEarlier` answers `complete: true, added: 0`
  (`sidecarServer.ts:4469-4477`) and the renderer clears the boundary row
  (`transcriptProjector.ts:1353-1372`) over a ring-truncated view. On a
  resumed session whose live traffic evicted the attach replay, the
  per-connection anchor still points at the attach-time oldest message
  (`sidecarServer.ts:1121`), so the recovered prefix ends above a gap the
  renderer never receives, again reported complete. Both become rare once
  item 2 lands. **Fix, corrected after review:** the anchor should be minted by
  MAIN, not the renderer. Main owns the ring and knows the oldest retained
  finished message for the session, and every renderer frame passes through
  one point on its way to the sidecar (`app/main/main.ts:3195` `forward`).
  Stamping that uuid onto the `history.loadEarlier` message there, and adding
  one uuid-shaped key to the sidecar's allowlist and local schema
  (`sidecarServer.ts:5504`, `:5608`), gives the sidecar a diff anchor that
  matches what the reader actually holds, including the fresh-session case
  where its own `history` is empty. Main overwrites whatever the renderer
  sends in that field, so nothing renderer-authored widens. The first edition
  proposed a renderer-stated uuid; that was the wrong side of the boundary.
- **Same-chunk dispatch after the latch.** `handleData` keeps dispatching the
  rest of a decoded chunk after `handlePark` has latched and closed the server
  (`sidecarServer.ts:1183`, guard only at entry). Turn-starting verbs carry a
  `parking` guard; the durable-write verbs do not (account verb `:2725`,
  profile delete `:2781`, fork/export/branch `:3153`, edit-from-message
  `:3294`), and `exitCleanly` awaits the lease release before `process.exit`.
  A token refresh started in that gap is cut with its lockfile held.
  Vanishingly unlikely; two-line fix: break the loop on `this.parking`.
- **The sidecar exit never runs the engine's registered cleanups.** Only
  `src/utils/gracefulShutdown.ts:457` calls `runCleanupFunctions`;
  `app/sidecar/index.ts` `exitCleanly` does not. Not park-specific, and low
  risk because recency is stamped at turn end so the 100 ms transcript flush
  (`src/utils/sessionStorage.ts:1179`) is long done before a TTL park.
- **The count cap binds, not the byte cap** (§1.2), inverting the stated
  design. Self-corrects with item 2.

## 7. Extrapolations and what would settle them

- **Reload frequency.** Not measured. Dev-mode HMR fall-through to a full
  reload is plausible given concurrent renderer edits while the app is open;
  a `renderer-ready` count per launch in the operational log would settle it.
- **Permission-mode and fast reset on restore, and the scroll jump.**
  Reasoned from the code paths cited in §2, not observed live. One forced park
  of a session in `auto` with fast on, then a submit, settles both.
- **Concurrent live-engine count.** Not in the bundle; two of the five
  sessions predate its window. A `listSessions` live count sampled with the
  renderer health record would settle whether the cap ever fires.
- **Per-row renderer cost.** The renderer mounts every transcript row with no
  virtualization, and the only memory figure on record is the 360–390 MB
  working set at five sessions of unknown row count. CC-59's 6.4 GB was
  React DEV performance measures, not rows, so the row cost that the 4 MiB
  restore cap protects against has never been measured. One
  `rendererMemoryTrajectory` run at 2,000 and 4,000 mounted rows would
  settle whether that cap can follow the ring.
- **Per-message clipping.** "Message truncate" could also mean a single long
  message being cut. The CC-59 leaf windowing (`app/renderer/src/lineWindow.ts`,
  `markdownRenderPlan.ts`) mounts ranges rather than cutting content, but this
  was not verified visually.
- **The 71-vs-59 marker count.** A first pass matched marker text and counted
  71 files; the second pass parsed frames and counted 59. The difference is
  files whose marker text appears outside an `error` frame; 59 is the number
  to trust.

## 8. Measurement recipe (aggregates only)

- Operational histogram: `python3` over `streams.operational` of the bundle,
  grouped by `event`/`level`, then the non-routine records with `timestamp`.
- Cache composition: per file under `~/.cat-code/desktop/transcript-cache`,
  count frames by `event.message.type`, sum `len(json.dumps(frame))` by
  class, and read N from the `Only the N most recent messages are shown`
  marker. Python's default serializer inflates bytes by a few percent versus
  compact JSON, which is why the at-cap byte totals (3.8–8.4 MiB) are reported
  as a bound, not as the ring's own accounting.
- Transcript sizes: `os.stat` over `~/.cat-code/projects/**/*.jsonl`
  excluding `/subagents/`, mtime within 14 days.

## 9. Constants audit (added 2026-09-02, same day, on the owner's ask)

The first edition evaluated the TTL and the ring's count-versus-bytes and
took every other number at face value. This section checks each constant on
these paths against the evidence available: this machine (24 GB RAM,
`sysctl hw.memsize`), the Aug 30 bundle's renderer health samples, the
2026-07-22 fleet measurement, the 139 transcripts touched in the last 14
days, the 176 caches, and the registry file. The app was not running during
the audit, so no live per-process RSS was taken.

### 9.1 RAM: what the park lever actually buys

| Item | Constant / measurement | Cost on this machine |
|---|---|---|
| Engine process | ~223 MB RSS each (IDLE-PARK.md header, `app/scripts/ram-fleet.ts` 2026-07-22) | 4 live = ~0.9 GB (3.7% of 24 GB); 8 live = ~1.8 GB (7.4%) |
| Renderer, 5 sessions open | working set 360–390 MB, JS heap 98–108 MB (bundle `renderer.health.sample`) | fixed cost of the window, not of live engines |
| Main replay ring | 8 MiB per live session, `replayBuffer.ts:83` | the file's 256 MiB ceiling assumes 32 live buffers; park clears parked buffers and the cap holds live at 4, so the real ceiling is 4 × 8 = **32 MiB** (8x overstated) |
| Preview tier | 32 MiB per live session, `replayBuffer.ts:89-91` | real ceiling 4 × 32 = 128 MiB, and only with generated images |

One park saves ~223 MB, under 1% of the machine. The whole policy, at its
cap, is defending about 0.9 GB. That is the number to hold against §2's
cost per park.

### 9.2 Transcript-size caps against the owner's last 14 days (139 transcripts)

| Cap | Where | Fits whole |
|---|---|---|
| 4 MiB | restore-time history replay, `limits.ts:167` | 133 / 139 (95.7%) |
| 8 MiB | replay ring (`replayBuffer.ts:83`), export cap (`limits.ts:106`) | 137 / 139 (98.6%) |
| 16 MiB | load-earlier read, `limits.ts:203` | 139 / 139; corpus max 18.1 MiB, 1 of 1,849 |
| 8,000 / 4,000 frames | ring / replay counts | corpus max 2,988 finished records: backstops once deltas stop riding the ring; today the 8,000 binds at ~210 messages |

Finished-message frames average 3,792 B against 4,165 B per JSONL record
(§1.2), so a byte cap on frames covers roughly the same span as the same cap
on the file.

Verdicts: **ring 8 → 16 MiB is cheap** (at most 64 MiB of main at cap 4,
128 MiB at cap 8) and makes reload and preview whole for ~99% of sessions,
but only AFTER recommendation 2; before compaction 16 MiB holds ~420 messages
and is still short. **Restore replay 4 → 8 MiB** would make restore whole for
98.6%, but every replayed row is mounted for the pane's life (no
virtualization) and the per-row cost is unmeasured since CC-59's blowup was
traced to React DEV performance measures; measure before raising, and keep
the replay-below-ring alignment invariant (`limits.ts:139-145`). **16 MiB
load-earlier: keep.** **Frame counts: keep as backstops.**

### 9.3 Time constants

| Constant | Value | Evidence | Verdict |
|---|---|---|---|
| `PARK_IDLE_TTL_MS` | 20 min | parks at 20m30s–20m50s after turn end; owner returned in 4 and 13 min | change (§5 item 3) |
| `DEFAULT_SWEEP_INTERVAL_MS` | 60 s | adds ≤ 60 s jitter to the TTL | keep |
| `DEFAULT_SIDECAR_IDLE_TTL_MS` | 15 min, `app/sidecar/index.ts:73` | fires only at zero supervisor connections, which never happens under the desktop supervisor | inert; keep |
| `DEFAULT_TURN_STALL_MS` | 10 min quiet, `sidecarServer.ts:219` | report-only (`:1881-1903`); the 23 and 24 minute turns in the window produced no stall record | keep |
| `disconnectSettleMs` | 250 ms, `supervisor.ts:226` | measured FIN-to-exit gap 7 ms | keep, 35x margin |
| `LAZY_REPLAY_FLUSH_MS` | 50 ms | bounded restore batching | keep |
| Renderer health | sample 30 s, degraded at 3 misses, unavailable at 6 (`mainDecisions.ts:164-167`) | all 7 `renderer.health.unavailable` errors in the bundle carry `visible: false` and 59,999 ms lag, which is macOS hidden-window throttling | misfires on a hidden window; gate the escalation on visibility |

### 9.4 Count and size bounds

| Constant | Value | Evidence | Verdict |
|---|---|---|---|
| `MAX_PROMPT_BYTES` | 96 KiB | over-cap prompt is REFUSED, not cut (`sidecarServer.ts:2380-2382`, `bad_request`, text retained via the D5 retained-submit path) | keep; the refusal copy `prompt exceeds 98304 bytes` is engineering text on a user surface (§7) |
| `MAX_SAVE_TEXT_BYTES` | 8 MiB | 2 of 139 recent transcripts exceed 8 MiB on disk; exported text is smaller than JSONL | borderline; copy already points to the terminal |
| `MAX_REGISTRY_SESSIONS` | 256, `registry.ts:72` | registry today: 193 rows, 140 `clean`, 53 `crashed`. Real crashes are rare, so most of the 53 are parked-at-quit rows (§3) | reap at 256 removes the oldest terminal rows from the sidebar; the count corroborates §3 |
| `MAX_LIVE_SESSIONS` | 32 | unreachable under a cap of 4; hostile bound | keep |
| `MAX_OUTBOUND_FRAME_BYTES` vs ring | 32 MiB vs 8 MiB | a frame between the two is delivered live and marks the ring `truncated`, so one large image or tool result raises the boundary row after a reload although no message was lost | minor mislabel; keep |
| `MAX_TRANSCRIPT_CACHE_BYTES` | ring + 256 KiB | largest cache file 8.38 MB against an 8.65 MB cap; envelope overhead is ~8 KB | keep; moves with the ring |
| Preview tier | 32 MiB / 32 images | rarely exercised | keep |
| `MAX_QUEUED_PROMPTS` / preview chars | 32 / 500 | display-only truncation of a waiting row | keep |

### 9.5 Diagnostics numbers

The operational log keeps 8 MiB across 16 files for 14 days
(`operationalLog.ts`, bundle manifest), which is enough. The EXPORT is not:
`MAX_BUNDLE_BYTES` is 2 MiB with 512 KiB per file
(`app/main/diagnosticsBundle.ts:52-53`), and the Aug 30 export reports
`bundleLimitReached: true`, `sourceWindowTruncated: true`, 2,583 records
suppressed at the source, and 974 operational records covering 100 minutes of
a day-long launch. For a complaint of this shape the bundle cannot show a
day. Raise the bundle cap, or add an operational-only export variant that
skips the delivery trace.
