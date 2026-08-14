# Overnight turn hang: engine never closed the run; UI "working" for 9 hours was correct

Incident of 2026-08-10, investigated same day. Session: app
`f578320a-942a-4c6b-8c35-c5274e4fab5a` / engine
`ae87a15c-294d-4f25-a3e9-8242e012eb17`, desktop dev app, model `gpt-5.6-terra`
(Codex websocket path). Operator symptom: an overnight agentic run was left
going; in the morning the transcript showed the session as working but nothing
moved; quitting and relaunching the app showed the run finished.

This report exists so the NEXT session that sees this symptom does not redo the
investigation. Read the verdict, then jump to "Playbook for the next
occurrence".

## Verdict

The freeze was an ENGINE hang, not a UI failure. Proven chain:

1. At 02:30:16.8 local the final provider stream completed cleanly
   (`codex_stream_surface` in the engine transcript: `completed: true`,
   130 output tokens), and the final assistant message (stop_reason `end_turn`)
   was appended and delivered to the renderer end-to-end (delivery trace
   sequence 22169, all 11 stages acknowledged at 02:30:16.839).
2. After that the run never terminated: the terminal `result` SDKMessage and
   the `turn.status` idle event were never emitted. `turn.status` is emitted in
   `AppSessionController.submit`'s finally block
   (`src/app-runtime/AppSessionController.ts:178-193`) only when the engine's
   `for await` over the run completes — so a stuck "working" indicator means
   the engine-side run genuinely never closed. The renderer displayed the
   truth for 9 hours.
3. Quit + relaunch "fixed" the display because restore derives status from the
   transcript at read time (last message `end_turn` → finished), while the live
   path requires the engine to actually emit the result.

Context, not cause: the model's final message said it was blocked on two
permission denials (a denied focused-test command at 02:29:03 and a
destructive-delete authorization). That explains why the MESSAGE was final; the
run should still have closed and gone idle seconds later. It did not — that
gap is the bug.

## Evidence sources and what each showed

| Source | Finding |
|---|---|
| `~/.cat-code/desktop/logs/operational-4eb4a492-*.jsonl` (overnight launch) | Renderer healthy all night: hidden-window throttling artifacts only (`eventLoopLagMs` pinned ~59999 with `visible:false` — see `docs/reports/2026-08-09-renderer-sigtrap-root-cause.md` for that signature), heap steady 172→188MB, first `visible:true` sample at 04:17:49Z with 5.2ms lag. No `renderer.process.gone`, no recovery events. Workers (`sessions-catalog`/`accounts-pool`) churned on cadence all night — sidecar alive. |
| Delivery trace `delivery-trace-4eb4a492-*-1786303793867.jsonl` | Last frame seq 22169 at 02:30:16.839, `renderer.state.queued` acknowledged. Zero frames after. Pipeline healthy to the last frame the engine ever produced. |
| Engine transcript `~/.cat-code/projects/-Users-pt-cat-code/ae87a15c-*.jsonl` | 529-minute silence starting immediately after the 02:30:16 `end_turn` + its end-of-stream summary records. All 6 subagent runs `status: completed` by 02:26; queue balanced (5 enqueues / 5 dequeues of background-task notifications, all processed); both background Bash builds finished (02:15, 02:29). Nothing was pending when the run failed to close. |
| macOS DiagnosticReports | No Electron crashes in the window. Nothing died. |

Ruled out: renderer death or paint hang (probes healthy, visible sample 5.2ms),
delivery-pipeline loss (full-stage acks), pending subagents or queue items
(balanced), still-running background Bash (outputs show completed builds),
crashes (no reports), and "the run legitimately went idle" (idle would have
emitted `result` + `turn.status`; the UI showing working proves it never did).

## Candidate hang sites (ranked; none are discriminable from current logs)

Everything between the last assistant message and result emission was traced
(2026-08-10). The awaits that can block forever, writing NOTHING to any log:

1. `await pendingToolUseSummary` — `src/query.ts:1113`. Post-turn summary call
   (`queryHaiku` → small-fast model `gpt-5.6-luna`, routed over the same Codex
   machinery) with no timeout, awaited after the final assistant message and
   before the run can return. Gated on `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES`
   (`src/query/config.ts`); nothing in the repo or settings sets it, but the
   sidecar inherits the launch shell's env (`app/supervisor/supervisor.ts:332`),
   so it cannot be ruled out post hoc.
2. Per-conversation websocket lock —
   `src/services/api/codex-websocket-transport.ts:185`
   (`acquireConversationTurn` awaiting the prior turn's tail). No timeout, and
   it blocks BEFORE any send, so the transport's 90s idle watchdog (armed only
   after `ws.send`, `:1314`) never arms. A previously abandoned stream
   generator whose `finally` never ran leaves the lock held forever; any later
   call on that conversation hangs silently.
3. Stop hooks (`src/query.ts:1325` → `src/query/stopHooks.ts:195`) — none
   registered at the time, but plugin/SDK-registered Stop hooks would reopen
   this; per-hook timeout is 10 minutes, so a hook alone cannot explain 9 hours
   unless the hook process itself never returned.

Why the logs cannot pick one: the Codex diagnostics
(`codex_send_path`/`codex_stream_surface`, `src/utils/sessionStorage.ts`) are
written only when a stream ENDS — a hung request writes nothing anywhere.
There are no request-start markers, no turn-lifecycle records, and the
SDK-level stream idle watchdog is off unless `CLAUDE_ENABLE_STREAM_WATCHDOG`
is set (`src/services/api/claude.ts:2080`). Sidecar stderr (where frame-drop
paths log) is inherited to the dev terminal and not persisted
(`app/supervisor/supervisor.ts:327`).

## Playbook for the next occurrence

Symptom to match: a session shows working/streaming, no new transcript rows,
and the app otherwise responds (other sessions fine, window paints).

1. **Before anyone quits the app: capture the live stack.** The hung await is
   sitting in the sidecar process right now and one sample names it — the one
   piece of evidence no log can give after a quit:

   ```bash
   sample <sidecar-pid> 5 -file ~/sidecar-hang.txt
   ```

   Find the pid in the operational log (`sidecar.spawn.started {pid}` for the
   session's launch) or via `pgrep -f sidecar`. Do NOT pattern-kill anything
   (repo rule §4); sampling is read-only.
2. **Confirm it is the same failure class.** In the session's delivery trace:
   the last frames end with assistant events and no result follows. In the
   engine transcript: last records are an `end_turn` assistant message plus
   `codex_send_path`/`codex_stream_surface` summaries, then silence. Renderer
   health samples stay healthy. If instead the renderer died, that is the
   OTHER incident — see `docs/reports/2026-08-09-renderer-sigtrap-root-cause.md`.
3. **Read the turn-lifecycle records, if the log request has landed.** The
   2026-08-10 log request (delivered in-session; summarized below) proposes:
   `session.turn.started` / `session.turn.completed` / `session.turn.stalled`
   in the operational log, an engine transcript diagnostic naming the post-turn
   phase when an await exceeds ~60s, a websocket lock-wait warning, and
   `frame.dropped` records. Verify against `app/shared/operationalLog.ts` and
   `src/query.ts` whether they exist yet — source wins over this report. If
   they exist, `session.turn.stalled`'s phase field IS the answer; grep for it
   first and skip the code trace.
4. **Check the sidecar env** for `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES` and
   `CLAUDE_ENABLE_STREAM_WATCHDOG` (`ps eww <sidecar-pid>` while alive) — it
   decides whether candidate 1 was armed.

## Non-findings worth keeping (so they are not re-investigated)

- `app.shutdown.started {reason: window-all-closed}` with no
  `app.shutdown.completed` is the DESIGNED macOS park-in-dock route
  (`app/main/main.ts` skips `app.quit()` on darwin; D6/F5). It reads like a
  hung shutdown; it is not. The windowless Electron process it leaves is not a
  leak.
- The 2026-08-09 renderer OOM fixes (`6ee65a56`, `fb518346`, `2fc7440c`) did
  not regress and were not involved: no renderer death occurred, and the
  `visible` telemetry ruled out hidden-page throttling. The then-named
  `heapUsedBytes` field (now `jsHeapUsedBytes`) measures only the V8 heap, not
  process memory.
