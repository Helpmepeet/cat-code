# Desktop session stall on restore, 2026-08-09

Investigation only. No code changed, no fixes applied.

**Question asked:** why does a desktop session stall, such that closing and
reopening it is the only way to see the updated transcript?

**Answer:** the stall reproduced in a live transcript, and it is not one bug but
three, all on the close-and-reopen path the operator is using as the workaround.
A restore rebuilds the interrupted turn's history and then never resumes it, so
the session sits inert with no visible reason. The in-memory command queue dies
with the killed process, so a prompt the operator already watched leave the
composer is silently destroyed. And the host-initiated park path is guarded by
seven gates against exactly these two losses, while the user-initiated close
path is guarded by none.

The workaround makes the problem worse than the symptom it treats.

## Method

Forensics on live state at 2026-08-09 15:38 to 16:00 local (UTC+7), while the
dev app was running (Electron PID 65183, launched 15:38:54 from
`app/.dev-electron/`, its only sessions addressed through
`/tmp/catcode-65183/`).

Sources:

- `~/.cat-code/desktop/registry.json` for session rows, attach times, shutdown
  classification, engine PIDs.
- `~/.cat-code/projects/-Users-pt-cat-code/b88d43cf-….jsonl` (2,024 records,
  7.0 MB) as the engine's own record of the stalled session. A second stalled
  session, `27093454-…`, corroborates the attach-then-silence shape.
- Process and socket state (`ps`, `lsof`, `/tmp/catcode-65183/`).
- Source under `src/` and `app/`, cited by `file:line` below.

Scope caveat stated up front: this explains what happened after the operator
closed and reopened the session. It does not fully explain what made the pane
look stalled in the first place. See "What remains unproven".

## The reproduced stall

Session `00803a43` (engine `b88d43cf`, gpt-5.6-sol, effort high, permission mode
auto). Times local.

| Time | Record | Reading |
|---|---|---|
| 15:54:18 | `tool_result` | engine working normally |
| 15:54:22 | `queue-operation` enqueue, content `then start fixing it` | operator typed while a turn was running, so it queued |
| 15:54:31 | `assistant` thinking block | turn still running |
| 15:54:36 | session killed and restored; `Continue from where you left off.` (`isMeta`) and `No response requested.` (`isInternalNoResponseSentinel`) written | restore rebuilt the interrupted turn |
| 15:54:36 to 15:54:55 | nothing | session inert for 19 seconds |
| 15:54:55 | user content `..` | operator poked it |
| 15:55:21 | `assistant` thinking | it wakes |
| 15:55:23 | `assistant` text: "I incorrectly stopped after the resume signal. I'm continuing the approved fix now" | the engine's own account |

The engine was demonstrably alive and mid-turn at the moment it was killed. The
restore left it holding a complete, API-valid history and no reason to act.

## Finding 1: a restored session never resumes its interrupted turn

`deserializeMessagesWithInterruptDetection` detects a mid-turn interruption and
transforms it into a resumable one at
[`conversationRecovery.ts:219`](../../src/utils/conversationRecovery.ts:219): it
appends a synthetic `Continue from where you left off.` user message, then
inserts an assistant sentinel carrying `NO_RESPONSE_REQUESTED`
([`messages.ts:246`](../../src/utils/messages.ts:246)) and marks it
`isInternalNoResponseSentinel`
([`conversationRecovery.ts:251`](../../src/utils/conversationRecovery.ts:251)).

The sentinel's own doc comment states the contract: it exists "so the
conversation is API-valid **if no resume action is taken**". The pair is meant
to be removed by whoever does take that action. `loadConversationForResume`
returns `turnInterruptionState`
([`conversationRecovery.ts:510`](../../src/utils/conversationRecovery.ts:510))
for precisely that purpose.

Headless print mode takes the action. At
[`print.ts:1260`](../../src/cli/print.ts:1260) it logs
`Auto-resuming interrupted turn`, strips the synthetic pair via
[`removeInterruptedMessage`](../../src/cli/print.ts:1267), and re-submits the
continuation content as a real prompt.

The desktop sidecar does not. `resumeEngineSession` passes the whole `loaded`
object into `processResumedConversation`
([`sessionResume.ts:68`](../../app/sidecar/sessionResume.ts:68)) and never reads
`turnInterruptionState`. Searched repo-wide, every consumer of that field, and
every call site of `removeInterruptedMessage`, lives in `src/cli/print.ts`.
There are **zero consumers under `app/`**.

Compounding it, the sentinel is filtered out of the restored history the
renderer receives
([`historyProjection.ts:13`](../../app/sidecar/historyProjection.ts:13)), which
is correct as display policy but means nothing on screen accounts for the
silence. The operator sees a complete transcript and an idle session.

This is the stall. Reopening restores the history and then waits indefinitely
for a message that the engine believes was already answered.

## Finding 2: reopening silently destroys queued input

The command queue is a module-level in-memory array
([`messageQueueManager.ts:54`](../../src/utils/messageQueueManager.ts:54)),
never persisted. Only an audit record of the operation reaches the transcript
(`logOperation` writing a `queue-operation` entry). SIGTERM destroys the queue
itself.

Audited all 7 `queue-operation` records in `b88d43cf`:

| Time | Op | Content | Later delivered? |
|---|---|---|---|
| 15:17:20 | enqueue | task notification | yes |
| 15:27:33 | enqueue | task notification | yes |
| 15:28:32 | dequeue | (n/a) | (n/a) |
| 15:29:39 | dequeue | (n/a) | (n/a) |
| 15:42:49 | enqueue | review verdict text | yes |
| 15:43:32 | dequeue | (n/a) | (n/a) |
| **15:54:22** | **enqueue** | **`then start fixing it`** | **no** |

Every machine-generated enqueue was delivered. The only content that never
arrived is the operator's own typed message, and there is no matching dequeue
after it. It died at the 15:54:36 kill. The phrase appears exactly once in the
7 MB transcript: in the audit record proving it was accepted.

## Finding 3: park is gated against both losses; close is not gated at all

`isParkGateOpen` refuses to park on any of seven conditions
([`sidecarServer.ts:1660`](../../app/sidecar/sidecarServer.ts:1660)): an active
turn, a queued parent task notification, **a queued parent prompt**
([`:1666`](../../app/sidecar/sidecarServer.ts:1666), defined at
[`:1124`](../../app/sidecar/sidecarServer.ts:1124)), a pending permission
request, live tasks, in-flight durable writes, an OAuth login in flight.

The queued-prompt gate was written for this exact case. Its comment: "a prompt
the user sent mid-turn that no tool round drained: parking over it would strand
a message the user has already watched leave the composer."

`closeSession` calls `supervisor.killSession` unconditionally
([`host.ts:518`](../../app/host/host.ts:518)). No turn check, no queue check,
none of the five other gates.

So the host-initiated path the operator never sees is carefully protected, and
the user-initiated path the operator is driving repeatedly is not. Every row
from this app run is marked `shutdown: "clean"`, which `markClean` sets only on
graceful close or a synchronous spawn failure, confirming these were closes and
not crashes.

## What remains unproven

Why the pane looked stalled at 15:54:22, before the operator closed it.

The engine was alive and productive at that moment: tool results at 15:54:12 and
15:54:18, a thinking block at 15:54:31. Two candidates:

1. **The pane was not showing that activity.** The renderer's projector creates
   per-session state only from a `ready` frame and silently drops every `event`
   frame for a session it has no state for
   ([`transcriptProjector.ts:497`](../../app/renderer/src/transcriptProjector.ts:497),
   [`:842`](../../app/renderer/src/transcriptProjector.ts:842)). Main's
   attachment gate replays on the first `rendererReady` per document load and
   delivers nothing on a repeat; only `did-start-navigation` re-arms it
   ([`attachmentGate.ts:14`](../../app/main/attachmentGate.ts:14)). A resumed
   sidecar sends exactly one `ready`, so once that state is lost there is no
   in-place recovery, and close-and-reopen is the only cure. This mechanism is
   real; whether it fired here is not established.
2. **The turn was simply slow** at high effort and read as dead.

One observation separates them: open the renderer devtools before the next
freeze. A thrown error in the `bridge.subscribe` callback
(`app/renderer/src/App.tsx:847`) indicates the first; a clean console indicates
the second.

## Ruled out

- **HMR or Fast Refresh disturbance.** Only `app/main/idleParkDriver.ts` was
  modified after the 15:38:54 launch, and main-process changes do not hot
  reload. No renderer module changed during the app's lifetime.
- **Test interference with live state.** App tests that construct a registry
  pass an explicit `storageDir`, and 16 test files set `CLAUDE_CONFIG_DIR`, so
  they do not write `~/.cat-code/desktop`.
- **Oversize frames.** The stalled session's largest record is well under
  200 KB; nothing approaches `MAX_OUTBOUND_FRAME_BYTES`.
- **Idle-park as the cause of the 15:54:36 kill.** A turn was active and a
  prompt was queued, so two independent park gates were closed.

## Fix options

Not implemented. Listed smallest first.

1. **Act on `turnInterruptionState` in the sidecar resume**, as
   `src/cli/print.ts` already does: strip the synthetic pair, submit the
   continuation. This alone makes reopening continue the work instead of
   stalling. Smallest change, addresses Finding 1, which is the stall itself.
2. **Protect close the way park is protected.** Either gate `closeSession` on
   the same conditions, or drain and deliver the queue before SIGTERM. Addresses
   Findings 2 and 3.
3. **Give the projector a recovery path** for an `event` frame naming a session
   it has no state for, rather than dropping it forever. Addresses candidate 1
   under "What remains unproven", and is worth doing on its own merits since the
   current design has no route back short of a new document load.

## Unrelated observation

A `bun test app/` process (PID 10941) has been running since 2026-08-02 21:56,
over six days. It belongs to no session active today and is a candidate for
reaping by whoever owns it.
