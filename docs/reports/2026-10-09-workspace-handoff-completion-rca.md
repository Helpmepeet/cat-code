# Workspace continuation timeout and transcript ancestry defects

- Date: 2026-10-09
- Status: Analysis and fix proposal; no implementation or live-state repair performed
- Investigation: GPT-6 Astra deep dive, followed by independent source inspection, transcript analysis, and isolated production-function experiments

## Result

The session completed its implementation turn, committed its changes, and emitted a final report. The desktop workspace-handoff lifecycle nevertheless retained an uncertain continuation state. Hours later, a close request caused the stale uncertainty warning and a model-facing wait instruction to be saved.

There are two independently validated defects:

1. The desktop waits at most 30 minutes for a continuation reply, but the engine replies only after the entire resumed turn finishes. Expiry deletes the request correlation entry. A later successful reply cannot settle that request, and there is no separate operation-level completion reconciliation path.
2. A deferred connection-recovery message can first be persisted when the handoff warning is written. Transcript deduplication then attaches the warning to an older prefix, bypassing already-persisted completed work. In this session, the production conversation selector chooses a branch that excludes the implementation report.

The historical timeout transition is strongly supported by source and timing, but was not explicitly logged with its request identity. The late-reply behavior and transcript-writing defect were reproduced using existing production functions in isolation. The saved ancestry defect was also verified against this session's actual records.

The proposed repair has not been implemented or tested. A full desktop/socket/engine reproduction and a live cold restore were not performed.

## Scope and identities

The user reported:

> The workspace changed, but completion could not be confirmed. Some work may have started. Send a message to review what happened.

| Identity | Value |
|---|---|
| App session | `5874b0c6-f67a-47c7-a3eb-e74ecca022ba` |
| Engine session | `984daf2a-a2d7-4897-b450-4ea22a7f6b18` |
| Workspace operation | `9050825e-8cdf-4fc8-8ebe-f31c3a3d51d0` |
| Continuation | `1b744bd4-e998-4349-b6a1-83eb6a06e337` |
| Source generation | `be8ef71b-f3ce-4355-98e2-cb849ab8e118` |
| Destination | `/Users/pt/cat-code` |
| Installed revision reported in transcript | `a0dfe5a1a3756b15882686e1601a9328534efb04` |
| Installed version | `2.1.280-desktop.shaa0dfe5a1` |
| Session model | `gpt-6-luna` |

The initial request was to fix PR #26's state/lifecycle findings end to end. The PR base supplied in the request was `24831bd819155f2fd664963a0a1cb2a6d1a3067c`.

The source workspace was a managed Chat Files directory:

```text
/Users/pt/Library/Application Support/Cat Code/Chat Files/b8b3a874-ed91-4bf4-a886-841ffaa4dcc3/d75635d4-fc26-4fff-ae33-64fab62c0735
```

The successful workspace jump resumed the conversation in the project checkout. An earlier malformed jump included an unexpected `format` field and was rejected; its retry succeeded. That input-validation error does not explain the later uncertain state.

This investigation was read-only except for creating this report. It did not modify source, tests, credentials, session records, or running processes, and did not launch or drive the app or run live model probes.

## Evidence and time convention

All user-facing times in this report use Asia/Bangkok, UTC+07:00. Raw log timestamps are UTC. For example, `2026-10-08T16:42:05Z` is **23:42:05 on 8 October**, not 00:42 on 9 October.

Source line numbers below are investigation-time anchors. Verify the named functions if later edits move them. Relevant historical behavior was checked with `git show a0dfe5a1:<path>` rather than assuming the current checkout exactly matches the installed app.

| Evidence | Location |
|---|---|
| Engine transcript | [Session JSONL](/Users/pt/.cat-code/projects/-Users-pt-cat-code/984daf2a-a2d7-4897-b450-4ea22a7f6b18.jsonl) |
| Session debug companion | [Debug log](/Users/pt/.cat-code/debug/984daf2a-a2d7-4897-b450-4ea22a7f6b18.txt) |
| Durable workspace ledger | [Workspace operation](/Users/pt/.cat-code/workspace-jumps/5874b0c6-f67a-47c7-a3eb-e74ecca022ba.json) |
| Original runtime log | [Operational log](/Users/pt/.cat-code/desktop/logs/operational-d5c859b3-ad87-4db9-a15a-6fec4042cfb4-1791477229956.jsonl) |
| Later close and user turns | [Later operational log](/Users/pt/.cat-code/desktop/logs/operational-d5c859b3-ad87-4db9-a15a-6fec4042cfb4-1791506930683.jsonl) |

The transcript contained 2,042 parseable records at independent validation time. The investigation used the session-analysis inspector for discovery and normalized timelines. A narrow metadata-only parent walk was used for ancestry, which the inspector does not expose. It did not dump message bodies or account data.

## Incident timeline

| Bangkok time | Observation and evidence |
|---|---|
| 8 Oct, 23:41:53 | Initial user request begins. Transcript L5 and operational log L63. |
| 23:42:04 | Source turn finishes the handoff. The source sidecar exits with `expected: true`; this is not evidence of an initial crash. Original operational log L64-L66. |
| 23:42:05.854 | Replacement sidecar starts the destination continuation. Original operational log L73. |
| 9 Oct, approximately 00:12:05 | The fixed 30-minute deadline would expire. This is an inference from source and the continuation start time. |
| 00:12:20.900 | A sidecar diagnostic and handoff-result trace occur, consistent with the additional 15-second idle wait refusing uncertainty settlement while the turn remains active. The trace does not reveal action, request ID, or `ok`, so this linkage remains inferred. |
| 00:24:57 | Commit `8b9e58b98aa7ab5ec2c3aea0c1bc8e65ed8b7547`, `fix(app): preserve state across session lifecycle actions`, is created. Its existence and timestamp were independently verified with Git. |
| 00:26:21.679 | Assistant implementation report is emitted, transcript L2014. |
| 00:26:21.823 | Runtime records successful turn completion, duration `2655969` ms. Original operational log L521. A handoff-result trace is emitted at the same time. |
| 09:11:14.875 | Renderer requests session close. Later operational log L357. |
| 09:11:14.957 | Uncertainty warning and internal wait instruction are persisted, transcript L2019-L2020. |
| 09:11:19.612 | Another renderer close request is recorded, later operational log L358. |
| 09:11:55 onward | User sends `hi`; the engine runs a turn and replies that it is paused awaiting reconciliation. Transcript L2022/L2028; later operational log L365-L367 records successful execution of that turn. |
| 09:12:35 onward | User asks whether all work finished. The model acknowledges the implementation commit and validation limits, but repeats the pause. Transcript L2034/L2037; the runtime again records a successful turn. |

The destination continuation ran for approximately **44 minutes and 16 seconds**, exceeding the acknowledgement deadline by approximately 14 minutes.

### What actually completed

The implementation report describes fixes for archive preserving live sessions, queued input staying outside continuation tool rounds, saved session pins, and Fork excluding concurrent submissions. It reports focused checks passing while retaining broader desktop/root failures and no GUI verification.

This investigation confirms that the commit exists, a final report was emitted, and the runtime recorded successful turn completion. It does **not** independently establish that every implementation change is correct or that the PR's entire validation is green.

## Defect 1: completion is coupled to an expiring control request

### What the 30-minute acknowledgement means

Main's `requestWorkspaceControl` sends `workspace.handoff` with `action: continue` and waits for a boolean reply. Its timer is:

```ts
action.action === 'continue' ? 30 * 60_000 : 20_000
```

Continuation receives 30 minutes; other control actions receive 20 seconds. The continuation deadline is fixed from dispatch. Tool execution, edits, permission waits, and streamed progress do not reset it.

The sidecar's continuation handler awaits `controller.continueHandoff`, which awaits the real submitted turn. It sends `workspace.handoff.result` after that turn finishes and its result is checked. This acknowledgement therefore represents whole-turn completion, not merely acceptance or startup.

### Failure chain established by source

1. Timer expiry calls `settle(false)`, clears the timer, deletes the pending request, and resolves the waiting promise unsuccessfully.
2. `continueDestination` throws when the request resolves false.
3. The workspace coordinator catches that failure, chooses `uncertain`, enables user reconciliation, and attempts terminal-outcome persistence.
4. The sidecar waits up to 15 seconds for the active turn to become idle. If work is still running, it refuses the settlement attempt.
5. Timer expiry does not abort the continuing agent. The work can still finish successfully.
6. Main's reply handler only settles a matching **existing** pending request. Once that entry was deleted, a late success cannot settle the original request. There is no separate completion repair path.
7. A later close while the operation remains reserved invokes cancellation. Terminal handling preserves an already-chosen non-completed outcome, so it retries `uncertain` rather than replacing it with `cancelled`.
8. With the engine now idle, the warning can be saved.

Relevant owners:

- [Control timeout and pending request ownership](/Users/pt/cat-code/app/main/main.ts:4225), `requestWorkspaceControl`.
- [Reply correlation](/Users/pt/cat-code/app/main/main.ts:2033), `workspace.handoff.result` handler.
- [Close behavior](/Users/pt/cat-code/app/main/main.ts:3166), reserved-session cancellation.
- [Continuation outcome handling](/Users/pt/cat-code/app/main/workspaceJumpCoordinator.ts:303), `move`.
- [Sticky terminal outcome](/Users/pt/cat-code/app/main/workspaceJumpCoordinator.ts:279), `terminal`.
- [Engine continuation and settlement](/Users/pt/cat-code/app/sidecar/sidecarServer.ts:1891), `handleWorkspaceHandoff`.
- [Controller continuation](/Users/pt/cat-code/src/app-runtime/AppSessionController.ts:150), `continueHandoff`.

### Ledger interpretation

The observed ledger contained:

```text
phase: settled
location: destination
consumed: true
cancelled: true
outcome: uncertain
sourceOutcomePersisted: true
requiresUserReconciliation: false
continuation.state: settled
```

These fields represent different layers and must not be collapsed into a single execution verdict. In particular, the coordinator currently writes `outcome: completed` when continuation is admitted, before the resumed turn completes. That field alone is not authoritative completion evidence.

The combination `cancelled: true` and `outcome: uncertain` is consistent with the later close cancelling a retained reservation while terminal handling preserves the earlier uncertainty.

### Historical confidence boundary

The logs explicitly establish long-running execution, final output, successful turn completion, later close requests, and subsequent warning persistence. They also contain handoff-result traces at the relevant times.

The exact timer firing and late-result discard were not recorded with sufficient request/action identity to prove their historical linkage independently. The hypothesis is strongly supported, but this report does not label those unlogged transitions as directly observed events.

Websocket timeout/reconnect and invalid `previous_response_id` incidents also occurred. The session continued afterward. They are not necessary to explain this deadline failure, and the investigation does not attribute the stale handoff state directly to those transport incidents.

## Defect 2: deferred system persistence forks the active ancestry

### Source mechanism

`QueryEngine` records assistant, user, and compact-boundary messages during execution. Its general system-message branch can retain a recovery message in `mutableMessages` without recording it inline.

When `persistHandoffOutcome` later records the whole mutable array, `recordTranscript` behaves as follows:

- Already-persisted prefix messages advance `startingParentUuid`.
- The first previously unrecorded message sets `seenNewMessage`.
- Later already-persisted messages are skipped and no longer advance the parent.
- The remaining new messages are appended as a chain from that earlier prefix.

Given this ordering:

```text
assistant A       already persisted
recovery          deferred, not persisted
assistant B/final already persisted
warning           new
wait instruction  new
```

the append becomes:

```text
assistant A -> recovery -> warning -> wait instruction
```

It bypasses `assistant B/final`. Publishing the wait instruction as the active tip selects that older branch.

The existing progress-message branch already documents this deferred-message hazard and records progress inline. The relevant historical general-system branch has the same missing protection.

Owners:

- [Inline message recording](/Users/pt/cat-code/src/QueryEngine.ts:994).
- [Existing progress-message explanation](/Users/pt/cat-code/src/QueryEngine.ts:1080).
- [General system-message retention](/Users/pt/cat-code/src/QueryEngine.ts:1231).
- [Outcome persistence and active-tip publication](/Users/pt/cat-code/src/QueryEngine.ts:1601).
- [Deduplicating transcript append](/Users/pt/cat-code/src/utils/sessionStorage.ts:2339), `recordTranscript`.
- [Active conversation selection](/Users/pt/cat-code/src/utils/sessionStorage.ts:3372), `selectActiveConversation`.

### Actual saved ancestry

The independent metadata walk found:

| Transcript record | Parent record | Raw ancestor-chain size | Contains implementation report L2014? |
|---|---|---:|---|
| L2014 implementation report | L2013 | 505 | Yes |
| L2018 old `transport_recovery` | L581 | 127 | No |
| L2019 warning | L2018 | 128 | No |
| L2020 wait instruction | L2019 | 129 | No |
| L2028 response to `hi` | L2027 | 132 | No |
| L2037 later status response | L2036 | 135 | No |

L2021 explicitly selects L2020 as the active tip. The last observed active marker, L2023, selects the following genuine user message, which remains on that warning branch.

The production active-conversation selector was then executed against this session's records, including its real parallel-tool recovery function:

| Selector source | Active selection | Completed report branch | Active selection contains report? |
|---|---:|---:|---|
| Installed `a0dfe5a1` | 208 messages | 653 messages | No |
| Current checkout | 208 messages | 653 messages | No |

The raw ancestry counts differ from these selection counts because production selection recovers orphaned parallel tool blocks/results. Even with that recovery, the completed report is excluded.

### Impact and limits

The records were not deleted. The active saved conversation points to a branch that omits much of the completed work. This establishes a persisted selection defect and a restore-context risk.

A full `loadTranscriptFile`/cold-start app restore was not run. The isolated selector result must not be described as a verified GUI restoration or a measurement of actual model context after restart.

The live engine still had its mutable conversation in memory, which explains how a later reply could know about the commit even though the saved active branch excluded it.

## Why the model said it was paused

Saving the outcome inserted this meta instruction:

> The workspace changed, but continuation completion could not be confirmed. Some work may have started. Wait for the user to reconcile the conversation before continuing.

The controller can admit genuine user input and clear reconciliation, while the model still sees that instruction. The observed `hi` and status-question turns reached the engine and completed successfully. Their pause wording is not evidence of an engine deadlock.

The runtime gate and model-facing explanation must agree about when reconciliation is satisfied. See [outcome wording](/Users/pt/cat-code/src/app-runtime/handoff.ts:55) and [controller settlement](/Users/pt/cat-code/src/app-runtime/AppSessionController.ts:159).

## Independent validation performed

These were bounded diagnostic experiments, not committed regression tests. They executed existing production code with isolated adapters and controlled time. No production seam or live-state mutation was introduced.

### Historical request and late-reply experiment

The actual `requestWorkspaceControl` function and reply-handler block were extracted from `git show a0dfe5a1:app/main/main.ts`, transpiled with Bun, and executed in a VM. Dependencies supplied request identity, a pending map, a captured outbound frame, and a controllable timer. The production functions owned request insertion, expiry, and reply matching.

Observed output:

```json
{
  "deadlineMs": 1800000,
  "pendingBeforeTimeout": 1,
  "timeoutResolvedValue": false,
  "pendingAfterLateSuccess": 0,
  "lateSuccessCanSettleOriginalRequest": false,
  "forwardedControls": ["continue"]
}
```

This proves the isolated mechanism. It does not reproduce transport delivery, the whole coordinator, cancellation, and real engine execution together.

### Transcript append experiment

The current production `recordTranscript` function was executed with an identity cleaning adapter, two already-persisted assistant UUIDs, and an adapter that only captured the insertion arguments. The production function chose the parent and new-message list.

Observed output:

```json
{
  "alreadyPersisted": ["assistant-A", "assistant-B-final"],
  "appended": {
    "ids": ["deferred-recovery", "outcome", "outcome-context"],
    "parent": "assistant-A"
  },
  "returnedTip": "outcome-context",
  "finalBypassedByAppend": true
}
```

This verifies the parent-selection defect without writing a transcript file. Actual session ancestry and production selection supplied the independent on-disk evidence described above.

### Checks not performed

- No full desktop/socket/engine reproduction of the historical incident.
- No live app launch, GUI interaction, or cold restore.
- No implementation or regression test of the proposed new completion lifecycle.
- No independent review of the correctness of commit `8b9e58b9`.
- No repair of the affected session's active branch or warning.

## Fix plan

Implement two coordinated repairs. Fix persistence first so subsequent lifecycle recovery does not create another incomplete saved branch. Raising the 30-minute duration alone is insufficient.

### 1. Preserve ordered transcript ancestry

Ensure retained, loggable system messages cannot first be persisted later in the middle of an already-recorded chain. Apply ordered inline persistence at the `QueryEngine` owner where appropriate, surface write failures, and verify that outcome appends preserve the current conversation ancestry before publishing a new active tip.

Do not simply relax `recordTranscript`'s prefix behavior: it also protects compaction/preserved-message ordering. Validate deferred recovery, repeated outcome persistence, parallel tool records, and compacted histories through the production reader.

### 2. Separate continuation acceptance from execution completion

Use a short, bounded command acknowledgement to establish that continuation was accepted. Track the actual admitted operation separately through running and terminal states.

A fixed command-reply deadline must not classify legitimate tools, permission waits, retries, or long model turns as completed or failed. Missing delivery acknowledgement should initiate status reconciliation without replaying the continuation.

Write `completed` only when the real continuation has settled successfully, rather than using it for admission. Define conservative interpretation/migration for legacy records where `completed` and `admitted` coexist.

### 3. Record durable, independently recoverable completion evidence

Introduce a bounded, engine-owned continuation receipt tied to the exact app session, engine session, operation, continuation UUID, and admission identity/destination generation. Persist terminal evidence only after the real turn settles and required transcript writes succeed.

Main remains the sole owner of the workspace-jump ledger. Live completion and restart/status recovery reconcile the receipt into that ledger. Recovery must never resubmit already-admitted work. Receipt identity must be checked against the admitted operation and validated restore identity; a new process generation must not blindly accept unrelated old evidence.

The exact receipt schema, storage owner, and control/event shape remain implementation design work. They must be settled before code changes, with explicit success/failure/cancellation semantics and durability ordering.

### 4. Serialize lifecycle transitions and reconcile late success

Give one coordinator transition owner responsibility for completion, status observation, timeout, Stop, close, process loss, warning persistence, and user reconciliation. Recheck state/identity after awaits.

Required behavior:

- A confirmed completion clears the retained running operation even if an earlier RPC expired.
- Close after confirmed completion closes normally.
- Cancellation during active execution retains existing review semantics.
- Duplicate messages are idempotent.
- Stale operations, replies, generations, and callbacks cannot overwrite newer cancellation, completion, or reconciliation.
- Transcript-write failure cannot publish a successful durable receipt or advance an active tip as though persistence succeeded.

### 5. Treat uncertainty as recoverable observation before committing a warning

Before saving a terminal warning, check authoritative completion evidence and serialize that check with completion handling. A missing reply alone does not prove that work failed.

Preserve idempotent warning persistence. Once a warning is already durable, resolve it through explicit durable follow-up state rather than silently rewriting history. Existing uncertain ledgers without trustworthy completion evidence remain conservative; neither a Git commit nor free-text assistant output automatically clears them.

### 6. Align model-facing reconciliation with controller state

Once genuine user input has been durably accepted for reconciliation, expose that the condition was satisfied or use warning context with an unambiguous expiration condition. Do not leave the model to interpret an indefinite wait instruction after the controller already cleared its gate.

Maintain fencing for automatic and peer-originated turns. Clearing model-facing ambiguity must not broaden which inputs can reconcile an operation.

### 7. Improve bounded operational evidence

Record the control action, request/operation identity, deadline expiry versus explicit refusal, continuation admission/settlement, and warning persistence using the existing bounded operational-log schemas. Do not log user message bodies, credentials, or unrestricted raw engine output.

The incident is currently reconstructable, but critical historical transitions remain inferred because these correlation fields are absent.

## Validation plan

The primary regression must cover the actual control-request/coordinator/sidecar boundary with accelerated time and isolated deterministic engine behavior:

```text
admit continuation once
keep real continuation active beyond the former deadline
finish successfully and persist completion
deliver/reconcile completion
close the chat
```

Assert no stale uncertainty note, no duplicate execution, preserved conversation history, settled reservations, and normal close behavior. A coordinator stub that immediately resolves `continueDestination` cannot detect this failure.

Distinct additional cases:

- Lost acceptance acknowledgement and lost completion delivery, recovered without replay.
- Process death before admission, during execution, after durable receipt, and before main-ledger settlement.
- Completion racing Stop/close, duplicate events, and stale operation/generation messages.
- Long permission waits and queued genuine user input, with automatic/peer input still fenced.
- Failed/interrupted turns, malformed receipts, and transcript-write failures remaining conservative.
- Real transcript write/read round-trip: assistant A, deferred recovery, assistant B/final, outcome. The production active selector must retain B/final. Include compaction and idempotent repeated outcome persistence.
- Genuine-user reconciliation clearing both controller gating and model-facing stale pause semantics.
- Conservative migration/recovery for existing ledgers without a completion receipt.

Regressions must fail against the pre-fix behavior for the intended reason. Follow the test-audit authoring gate, use existing production boundaries, and avoid test-only exports or mocks that supply the outcome being asserted.

After focused regressions, run the affected engine and desktop package checks required by `CLAUDE.md`. Shared runtime/protocol changes require the broader affected checks. Investigate failures against the current shared-tree diff rather than declaring them unrelated merely because the tree is dirty.

Packaged-app, hardening, and GUI checks are separate validation steps requiring the applicable authorization. A passing isolated test or renderer build is not GUI evidence.

## Constraints and existing-session recovery

Preserve destination trust validation, source-boundary verification, permission ownership, one-shot continuation consumption, queued-input fencing, Unix-socket control transport, separate app/engine identities, and main ownership of the jump ledger.

New protocol kinds/fields require receiving-boundary validation and the repository's versioning rules. New persisted formats require the registered migration path. Determine receipt lifecycle, retention, restart identity, and conflict handling before implementation.

The shared checkout contains unrelated work. Any implementation must preserve it and stage only reviewed owned changes.

Repairing this already-affected session is separate from prevention. Code changes alone will not restore its existing active branch. A repair requires explicit authorization, backups, verified branch selection, and validation through the production reader. Do not delete the warning branch or replay the original task as an automatic workaround.

## Completion criteria

The repair is complete when legitimate long-running continuations can finish without stale uncertainty; completion can be reconciled after lost replies without duplicate execution; close/cancellation races preserve correct state; recovery warnings preserve full active ancestry; genuine-user reconciliation agrees with model-facing context; and the relevant regressions and package checks pass with material limitations reported.

At report creation, analysis and the bounded independent validations are complete. Implementation, full-boundary reproduction, proposed-fix validation, GUI verification, and any existing-session repair remain outstanding.
