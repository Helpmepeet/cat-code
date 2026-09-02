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
the replay ring, and the ring is about 95% streaming deltas, so it holds
roughly two hundred real messages instead of the thousands its caps suggest.
No locked decision needs reopening: the friction comes from three tunables
and one retention bug.

Everything below is read from source or measured on this machine unless the
§Extrapolations section says otherwise. Measurements read aggregates only; no
transcript content left the analysis.

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

**Why it fires on the owner:** five sessions open against a cap of four means
the cap is over on every host event, and a 20-minute TTL is shorter than the
owner's gap between visits to a session they are multiplexing. Both knobs
were set for "a typical 2–3 live sessions" (`idleParkDriver.ts:18`); the
observed workload is five.

**What a park costs, verified:**

1. **The first message after a park runs on the defaults, not on what the
   rail shows.** CC-33 keeps model, effort, fast and mode on screen as
   read-only faces (`app/renderer/src/composerRailModel.ts`, DISPLAY outlives
   the engine). The restore re-spawns with the in-memory model override gone
   (`app/sidecar/runControlsDomain.ts:431` reads `getMainLoopModelOverride()`),
   `modeApi: null` (`app/sidecar/sessionResume.ts:262`), and the only model
   restore on resume is from a resumed agent definition
   (`src/utils/sessionRestore.ts:273-279`). The rail displays a promise the
   submit breaks. The DIE-list (IDLE-PARK.md §7) was accepted as "identical
   to what a crash→restore already loses"; true, but a crash is rare and a
   park happens twice an hour.
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
- **Park → restore.** NOT a truncation path in practice: the renderer keeps
  its rows through the park, and the restore replays up to 4 MiB, which covers
  all but 6 of the last 14 days' transcripts (§1.3). The brief's hypothesis
  that park-driven buffer loss (`main.ts:1847` `clearSession`) is the
  truncation mechanism is wrong; that loss becomes visible only through the
  two paths above.

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
   completes.** Main-only, in `FrameReplayBuffer.record`; no protocol, no
   inbound surface, no security change. Roughly ten times more real history
   per reload and per preview for the same 8 MiB, and the at-rest caches shrink
   about seven-fold. Keep the deltas of the one in-flight message so a reload
   mid-stream still shows partial text; drop them when the finished
   `assistant` message lands. Then re-measure: the byte cap binds again and the
   2026-08-19 verdict is void.
3. **Retune the park knobs to the observed workload.** `PARK_IDLE_TTL_MS`
   20 min → 120 min and `MAX_LIVE_ENGINES` 4 → 8 (`idleParkDriver.ts:41,49`).
   Cost is RAM: eight live engines is about 1.8 GB worst case at the measured
   ~223 MB per engine. If that is too much, gate the TTL on free system memory
   (`process.getSystemMemoryInfo()` in main) rather than on time. Either way
   the parks observed in §1.1 stop.
4. **Re-apply what the rail displays when a parked session restores.** The
   renderer already holds the last model, effort, fast and mode, and each has
   an existing sidecar-validated verb (run-control verbs, `permission.setMode`
   with its auto-mode gate). Replaying them after the resumed `ready` frame
   adds no inbound surface. Alternative with a cleaner trust story: main
   records the last `run-controls.snapshot` / `permission.context` it forwarded
   and passes them as spawn config, at the cost of a registry field and its
   migration (CLAUDE.md §6).
5. **§1d ruling.** Pick (b), route the click to the composer, plus the (c)
   tooltip. A better option not on the table: keep the pickers live while
   parked and let a pick trigger the same restore a submit does
   (`resolvePendingSubmit` → `'restore'`, `app/renderer/src/composerState.ts:894-916`),
   applying the pick after `ready`. That is item 4's mechanism with one more
   trigger.

**Locked decisions.** None needs reopening. N-process is why park exists, but
replacing it to save ~230 MB per idle tab is a rewrite of the supervisor plane
for a problem item 3 solves by spending the RAM. Die-with-window makes every
relaunch go through preview → resume, and item 2 is what makes that preview
whole. UDS transport, raw-event fidelity and the two-id model are untouched by
any of the above.

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
  item 2 lands. The honest fix needs the renderer to state its oldest row id,
  which reopens HISTORY-LOAD-EARLIER's "parameterless" rule by one validated
  uuid.
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
- **Rail-then-defaults sequence and the scroll jump on restore.** Reasoned
  from the code paths cited, not observed live. One forced park with a
  non-default model, then a submit, settles both.
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
