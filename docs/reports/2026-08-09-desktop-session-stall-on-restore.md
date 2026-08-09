# Desktop close-and-restore loses an interrupted turn, 2026-08-09

Investigation only. No code changed, no fixes applied.

**Revised 2026-08-09** after an adversarial review returned RED. The first
version presented a secondary close-and-restore failure as the answer to the
operator's original question. It was not. See "Revision record" at the end.

**Question asked:** why does a desktop session stall, such that closing and
reopening it is the only way to see the updated transcript?

**Answer, narrowed:** this report does **not** establish why the pane appeared
stalled before the operator closed it. That remains **unresolved**, and should
be tracked separately.

What it does establish is a distinct second failure on the close-and-reopen path
the operator is using as the workaround. A live turn was replaced while recently
accepted user input had not reached durable conversation history. Restore
reconstructed an API-valid interrupted history but scheduled no continuation, so
the session sat inert until a new prompt arrived; the accepted prompt was absent
afterward. The host-initiated park path is guarded against both of those losses
by seven gates. The user-initiated close path is guarded by none.

So the workaround carries its own cost, independent of whatever causes the
symptom it treats.

## Method and source state

Forensics on live state at 2026-08-09 15:38 to 16:00 local (UTC+7), while the
dev app ran as Electron PID 65183, launched 15:38:54 from `app/.dev-electron/`,
addressing its sessions through `/tmp/catcode-65183/`.

Sources:

- `~/.cat-code/desktop/registry.json` for session rows, attach times, shutdown
  classification, engine PIDs.
- `~/.cat-code/projects/-Users-pt-cat-code/b88d43cf-….jsonl`, 2,024 records,
  7.0 MB, as the engine's own record of the affected session.
- Process and socket state (`ps`, `lsof`, `/tmp/catcode-65183/`).

**Source state, recorded because it matters for the anchors below.** The live
investigation ran against a dirty working tree: at the time, 27 files under
`app/` were modified and 13 untracked, all of it another session's in-flight
work (a generated-image-preview feature touching `transcriptProjector.ts`,
`sidecarServer.ts`, `protocol.ts`). **Every `file:line` in this report is
anchored to commit `6e7c052`**, not to that dirty tree. Where the dirty tree
differs materially, it is called out. The behavior described was read in both.

## What the transcript shows

Session `00803a43`, engine `b88d43cf`, gpt-5.6-sol, effort high, permission mode
auto. Times local.

| Time | Record | Reading |
|---|---|---|
| 15:54:18 | `tool_result` | engine working normally |
| 15:54:22 | `queue-operation` enqueue, content `then start fixing it` | input accepted while a turn ran, so it queued |
| 15:54:31 | `assistant` thinking block | turn still running |
| 15:54:36 | engine process replaced | a live turn was terminated |
| 15:54:36 (record timestamps) | `Continue from where you left off.` (`isMeta`) and `No response requested.` (`isInternalNoResponseSentinel`) | interrupted history reconstructed |
| 15:54:36 to 15:54:55 | no engine activity | session inert for 19 seconds |
| 15:54:55 | user content `..` | operator sent a new prompt |
| 15:55:21 | `assistant` thinking | engine acts again |

Two qualifications on this table, both of which the first version got wrong.

**The synthetic pair was created during restore, not durably appended by it.**
File order in the JSONL puts the 15:54:55.919 `run_facts` record *before* the
two 15:54:36 records, so those were held in memory and flushed later, with the
next real submission. The timestamps are creation times.

**The engine's closing message is not telemetry.** At 15:55:23 the assistant
wrote "I incorrectly stopped after the resume signal." That is model-generated
interpretation and carries no independent evidentiary weight. The evidence is
the record structure: a continuation message, a no-response sentinel, and 19
seconds of silence.

## Finding 1: restore reconstructs an interrupted turn and schedules no continuation

`deserializeMessagesWithInterruptDetection` transforms a mid-turn interruption
into a resumable one at
[`conversationRecovery.ts:219`](../../src/utils/conversationRecovery.ts:219): it
appends a synthetic `Continue from where you left off.` user message, then
inserts an assistant sentinel carrying `NO_RESPONSE_REQUESTED`
([`messages.ts:246`](../../src/utils/messages.ts:246)), marked
`isInternalNoResponseSentinel` at
[`:251`](../../src/utils/conversationRecovery.ts:251). The sentinel exists, per
its own comment, "so the conversation is API-valid **if no resume action is
taken**". `loadConversationForResume` returns `turnInterruptionState`
([`:510`](../../src/utils/conversationRecovery.ts:510)) so a caller can take
that action.

**Correction to the first version.** That version said headless print mode takes
the action and the desktop fails to match it, implying parity drift. That is
wrong. The replay at [`print.ts:1249`](../../src/cli/print.ts:1249) is gated on
`process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN` **and**
`!options.suppressInterruptedTurnReplay`
([`:1252`](../../src/cli/print.ts:1252),
[`:1257`](../../src/cli/print.ts:1257)). The only other reference to that
variable anywhere in the repo deletes it
([`deferredContinuationRunner.ts:294`](../../src/services/deferredContinuationRunner.ts:294)).
Auto-resume is therefore an **opt-in path for one specific runner, not ordinary
resume behavior anywhere.**

The accurate statement is narrower and still actionable: the desktop sidecar has
no continuation path at all. `resumeEngineSession` passes the whole `loaded`
object into `processResumedConversation`
([`sessionResume.ts:68`](../../app/sidecar/sessionResume.ts:68)) and never reads
`turnInterruptionState`; searched repo-wide, every consumer of that field and
every call site of `removeInterruptedMessage` is in `src/cli/print.ts`, with
**zero under `app/`**. The sentinel is additionally filtered out of the restored
history the renderer receives
([`historyProjection.ts:13`](../../app/sidecar/historyProjection.ts:13)), which
is defensible display policy but means nothing on screen accounts for the
silence.

Net effect: reopening restores history and then waits for a message the engine
treats as already answered, with no visible reason.

## Finding 2: accepted input was lost during process replacement

The command queue is a module-level in-memory array
([`messageQueueManager.ts:54`](../../src/utils/messageQueueManager.ts:54)),
never persisted. Process replacement destroys it.

All 7 `queue-operation` records in `b88d43cf`:

| Time | Op | Content | Appears later as a delivered user message? |
|---|---|---|---|
| 15:17:20 | enqueue | task notification | yes |
| 15:27:33 | enqueue | task notification | yes |
| 15:28:32 | dequeue | (n/a) | (n/a) |
| 15:29:39 | dequeue | (n/a) | (n/a) |
| 15:42:49 | enqueue | review verdict text | yes |
| 15:43:32 | dequeue | (n/a) | (n/a) |
| **15:54:22** | **enqueue** | **`then start fixing it`** | **no** |

The phrase appears exactly once in the 7 MB transcript, in the audit record
proving it was accepted. **The loss is established.**

**The stage of loss is not**, and the first version overreached in implying it
was. Two reasons. Normal in-query consumption does not call `dequeue` at all; it
calls `remove`, imported as `removeFromQueue`
([`query.ts:84`](../../src/query.ts:84)) and applied to consumed commands at
[`query.ts:1709`](../../src/query.ts:1709), which logs a `remove` operation
rather than a `dequeue`. And every audit write is fire-and-forget: `logOperation`
issues `void recordQueueOperation(...)` without awaiting
([`messageQueueManager.ts:29`](../../src/utils/messageQueueManager.ts:29)), so a
record can be lost when the process dies. A prompt that was consumed and then
lost before its turn persisted would leave the same artifact as one that was
never consumed. This session contains no `remove` records at all, which is
consistent with either.

## Finding 3: park is gated against both losses; close is not gated at all

`isParkGateOpen` refuses to park on any of seven conditions
([`sidecarServer.ts:1641`](../../app/sidecar/sidecarServer.ts:1641)): an active
turn, a queued parent task notification, **a queued parent prompt**
([`:1647`](../../app/sidecar/sidecarServer.ts:1647), defined at
[`:1110`](../../app/sidecar/sidecarServer.ts:1110)), a pending permission
request, live tasks, in-flight durable writes, an OAuth login in flight. The
queued-prompt gate was written for this case: "a prompt the user sent mid-turn
that no tool round drained: parking over it would strand a message the user has
already watched leave the composer."

`closeSession` calls `supervisor.killSession` unconditionally
([`host.ts:518`](../../app/host/host.ts:518)). No turn check, no queue check,
none of the five other gates.

**What the registry does and does not prove.** Every row from this app run is
marked `shutdown: "clean"`. The first version read that as confirmation the
operator closed these sessions. It is not: `markClean` is also called on
synchronous spawn failure
([`host.ts:470`](../../app/host/host.ts:470)), and quit-time
`markLiveCleanSync` marks every live row clean at once
([`host.ts:662`](../../app/host/host.ts:662),
[`registry.ts:859`](../../app/host/registry.ts:859)). `closeSession` also marks
clean without observing child exit. `clean` means host-classified cleanup, and
**does not identify which termination path ran.** The gating asymmetry above
holds regardless; which path fired here is not established from artifacts.

## What remains unresolved

**Why the pane appeared stalled at 15:54:22, before the close.** This is the
operator's original question and it is not answered here.

The engine was alive and productive at that moment: tool results at 15:54:12 and
15:54:18, a thinking block at 15:54:31. Two candidates:

1. **The pane was not showing that activity.** The projector creates per-session
   state only from a `ready` frame and drops any `event` frame for a session it
   has no state for
   ([`transcriptProjector.ts:480`](../../app/renderer/src/transcriptProjector.ts:480),
   [`:825`](../../app/renderer/src/transcriptProjector.ts:825)). Main's
   attachment gate replays on the first `rendererReady` per document load and
   delivers nothing on a repeat; only `did-start-navigation` re-arms it
   ([`attachmentGate.ts:14`](../../app/main/attachmentGate.ts:14)). The
   projector's own comment adds that "a resumed sidecar sends exactly one"
   `ready`; that describes the present topology rather than a sidecar contract,
   since a sidecar sends `ready` per connection. Whether this fired here is not
   established.
2. **The turn was slow** at high effort and read as dead.

**A correction on how to tell them apart.** The first version proposed opening
devtools and treating a clean console as evidence for candidate 2. That test is
invalid: the drop is `return state`, silent by construction
([`transcriptProjector.ts:825`](../../app/renderer/src/transcriptProjector.ts:825)),
and the subscription callback
([`App.tsx:847`](../../app/renderer/src/App.tsx:847)) contains no assertion that
would throw. Projector state can be missing with a perfectly clean console.

The discriminating observation is instead: capture the frame sequence actually
delivered, and whether projector state exists for each `sessionId` at the moment
of the freeze. In the dirty tree at the time of writing, another session was
building exactly this instrumentation (`app/shared/deliveryTrace.ts`,
`app/main/deliveryTraceSink.ts`, untracked and not yet wired into `main.ts`).

## Ruled out

- **HMR or Fast Refresh disturbance.** Only `app/main/idleParkDriver.ts` was
  modified after the 15:38:54 launch, and main-process changes do not hot
  reload. No renderer module changed during the app's lifetime.
- **Test interference with live state.** App tests that construct a registry
  pass an explicit `storageDir`, and 16 test files set `CLAUDE_CONFIG_DIR`.
- **Oversize frames.** The session's largest record is well under 200 KB.
- **Idle-park as the cause of the 15:54:36 replacement.** A turn was active and
  a prompt was queued, so two independent park gates were closed.

Not corroborating evidence, contrary to the first version: session `27093454`.
Its transcript ends with a completed assistant response, and its later restore
shows no interrupted turn, no queued input, and no subsequent prompt. It is an
ordinary completed session restored and waiting for input.

## Fix options

Not implemented. None of these is as small as the first version claimed.

1. **A post-attachment, trust-checked continuation path in the sidecar.**
   Addresses Finding 1. This must **not** be a copy of `print.ts`: that path is
   opt-in (Finding 1), submits directly, and resume runs before renderer
   attachment. A naive startup submission could run tools before workspace-trust
   approval, which the sidecar boundary otherwise enforces, and could emit events
   before any connection exists to retain them. Requires tests for the untrusted
   workspace case and for pre-attachment event ordering.
2. **A cross-process close lifecycle.** Addresses Findings 2 and 3, and is a
   design task, not a host-side edit. The authoritative gates live in the
   sidecar; close begins in the host; supervisor termination is synchronous and
   unacknowledged. Gating close needs a typed sidecar round trip, race
   semantics, refusal or deferred-close behavior, and renderer UX for both.
   "Drain before SIGTERM" is not a shortcut: it can wait indefinitely, or keep
   running tools after the user asked to close.
3. **A recovery path in the projector** for an `event` frame naming an unknown
   session, instead of dropping it permanently. Worth doing on its own merits,
   since today there is no route back short of a new document load. Whether it
   addresses the unresolved pane stall is unknown, by definition.

## Revision record

An adversarial review of the first version returned RED. It was substantially
correct. Retracted or narrowed:

- The headline answered the post-restore inactivity while the operator's actual
  question, the pre-close pane freeze, was conceded as unexplained in the body.
  Retitled and narrowed; the pane stall is now stated as unresolved up front.
- "Headless print mode takes the action, the desktop does not" implied parity
  drift. The headless path is opt-in behind an env var whose only other
  reference deletes it.
- `shutdown: "clean"` was read as proof the operator closed the sessions. Three
  code paths produce it.
- The queue evidence was presented as identifying the stage of loss. It
  identifies the loss only; the normal consumption op is `remove`, not
  `dequeue`, and audit writes are unawaited.
- The proposed devtools discriminator was self-refuting: the drop it was meant
  to detect is silent by construction.
- Session `27093454` was cited as a corroborating second stall. It is not.
- Fix 1 and Fix 2 were described as small and safe. Neither is.
- All `file:line` anchors were taken from a dirty working tree, and one pointed
  at the wrong one of two identical lines. Re-anchored to `6e7c052`, with the
  source state now recorded in Method.
- An unrelated observation about a stale six-day `bun test app/` process (PID
  10941) has been dropped from this report as noise.
