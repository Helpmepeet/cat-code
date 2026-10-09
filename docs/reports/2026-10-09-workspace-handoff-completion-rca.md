# Workspace handoff and restored-conversation history defects

- Date: 2026-10-09
- Status: Analysis and fix proposal; no implementation or live-state repair performed
- Investigation: GPT-6 Astra deep dive, followed by independent source inspection, transcript analysis, isolated production-function experiments, real QueryEngine persistence, and production-loader corpus comparison
- Updated: 2026-10-09 after independently validating the user-supplied follow-up investigation

## Result

The session completed its implementation turn, committed its changes, and emitted a final report. The desktop workspace-handoff lifecycle nevertheless retained an uncertain continuation state. Hours later, a close request caused the stale uncertainty warning and a model-facing wait instruction to be saved.

There are three independently validated defects:

1. The desktop waits at most 30 minutes for a continuation reply, but the engine replies only after the entire resumed turn finishes. Expiry deletes the request correlation entry. A later successful reply cannot settle that request, and there is no separate operation-level completion reconciliation path.
2. A deferred connection-recovery or API-error message can first be persisted when a later ordinary prompt or handoff outcome is written. Transcript deduplication attaches the new records to an older prefix, bypassing already-persisted work. This affects ordinary submissions as well as handoff settlement. The original session's saved active branch excludes its implementation report.
3. For eligible transcripts larger than 5 MiB, a pre-parse optimization keeps a single parent chain and discards parallel tool siblings before the reader can recover them. The active tip can remain correct while restored history is incomplete. Six saved sessions exhibited this defect; an isolated large-file reproduction confirmed the mechanism without compaction.

The historical timeout transition is strongly supported by source and timing, but was not explicitly logged with its request identity. The late-reply behavior and transcript-writing defect were reproduced using existing production functions in isolation. The saved ancestry defect was also verified against this session's actual records.

The proposed repair has not been implemented or tested. Production transcript loading and an ordinary QueryEngine submission were exercised in isolation. A full desktop/socket/engine reproduction and a live cold restore were not performed.

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

This investigation changed only this report in the repository and created isolated diagnostic files under `/private/tmp`. It did not modify source, tests, credentials, saved live sessions, or the running app. One owned diagnostic process was stopped during experiment cleanup. No app launch, GUI interaction, or live model probe was performed.

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
| Follow-up investigation supplied by user | [Pasted investigation](</Users/pt/.codex/attachments/dcca2e9c-418b-4260-965d-c1e06023220a/Pasted text.txt>) |
| Ordinary-prompt ancestry example | [b80eb44d transcript](/Users/pt/.cat-code/projects/-Users-pt-cat-code/b80eb44d-9e6e-4fb0-90e0-2545008aede1.jsonl) |
| Second completed-then-warned example | [30de99df transcript](/Users/pt/.cat-code/projects/-Users-pt-cat-code/30de99df-0765-4924-a2ec-35b9a66198fc.jsonl) |
| Unresolved uncertainty example | [27fcb7af transcript](/Users/pt/.cat-code/projects/-Users-pt-cat-code/27fcb7af-1034-4826-8e3a-1ee652814a3d.jsonl) |

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

### Second completed-then-warned session

App session `f4a206f8-8602-43e1-aea7-d2cd7f52ae70`, engine `30de99df-0765-4924-a2ec-35b9a66198fc`, independently shows the same externally visible completion/uncertainty contradiction:

- Git commit `d32f8c84`, `feat(sidebar): streamline session actions and add archive`, was created at 8 October, 00:16:16 Bangkok.
- The final assistant report ended normally at 00:20:17.871, transcript L2131.
- The uncertainty warning was saved at 10:02:01.887, L2132, approximately 9 hours 42 minutes later.
- Its ledger records destination settlement, consumed continuation, `cancelled: true`, `outcome: uncertain`, and `requiresUserReconciliation: false`.

The warning's parent is the final report, and production selection retains that report. This is a second completed-then-warned example, not another demonstrated final-report ancestry loss. No matching retained operational log established its exact timeout transition; the timer cause remains inferred for this instance.

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

The initial investigation executed the isolated selector. The follow-up validation also executed the actual `loadTranscriptFile` and selector across saved files. That verifies reader behavior, but does not establish a GUI restoration or the exact model context after a live restart.

The live engine still had its mutable conversation in memory, which explains how a later reply could know about the commit even though the saved active branch excluded it.

### Ordinary prompts trigger the same defect

The ordinary submission path also persists the mutable conversation before accepting the next prompt. It can encounter the same unrecorded system message between already-persisted assistant messages. Handoff settlement is therefore one trigger, not the defect's scope.

A real QueryEngine experiment seeded disk with user/A/B, retained an unpersisted recovery between A and B in memory, and submitted an ordinary prompt. It stopped at `onInputPersisted` before model execution, flushed the real writer, and read the result using the production loader. The next prompt's parent was the recovery; the recovery's parent was A. B remained physically on disk but was excluded from the selected conversation. There was no tip record and no network request. This establishes the ordinary-submission mechanism independently of the handoff controller.

The saved `b80eb44d` example confirms practical impact:

| Record | Evidence |
|---|---|
| L8130 | Completed implementation report describing eight Luna workers, timestamp 8 October, 13:05:55.051 Bangkok. |
| L8136 | Deferred recovery from 10:42:46.333, parent pointing to L3144 rather than the completed work. |
| L8137 | Ordinary user prompt, “give me tldr, what happend problems we found?”, at 13:43:53.479; parent is that recovery. |
| Production selection | 376 messages, excludes the completed report; 549 user/assistant records are bypassed by this gap. |

This session previously jumped workspace at L22. The validated claim is that an ordinary prompt triggered the later fork without a new handoff at that point. It is not evidence that the session never used handoff. A tip record exists in this file, so adding tip records alone does not prevent this writing defect.

### Independent corpus footprint

The follow-up scan covered top-level session JSONL files one project directory below `/Users/pt/.cat-code/projects`; nested subagent logs were excluded. At scan time:

| Metric | Count |
|---|---:|
| Files examined | 642 |
| Resumable selected conversations | 612 |
| Files containing a tip record | 55 |
| Files larger than 5 MiB | 25 |
| Files with identified deferred recovery/API-error ancestry gaps | 18 |
| Gap edges | 20 |
| Recovery edges / API-error edges | 15 / 5 |
| Unique bypassed user/assistant records across these gaps | 2,320 |
| Affected files with deferred-message timestamps on or after 25 September | 6 |

The earliest identified API-error gap dated to 9 August. These are observed corpus counts, not a prediction that every ordinary prompt loses history. The mechanism requires an eligible deferred message followed by later persistence.

The scan used first-occurrence UUID positions, loaded selections, and gaps spanning at least three omitted user/assistant records. Counts exclude duplicate UUID inflation and do not imply physical deletion. The supplied investigation's nine backward references around `eff9c620` L9965-L9973 were duplicate records with earlier occurrences; those references do not independently prove nine new ancestry defects. For example, L9965 first occurs at L6507 and L9966 at L7013. The origin and general safety of duplicate records remain uninvestigated.

## Defect 3: large-file pruning removes recoverable parallel history

### Source mechanism and affected restore path

[`loadTranscriptFile`](/Users/pt/cat-code/src/utils/sessionStorage.ts:4998) can call [`walkChainBeforeParse`](/Users/pt/cat-code/src/utils/sessionStorage.ts:4816) when the buffer exceeds `5 * 1024 * 1024` bytes, history/all-leaves preservation is disabled, there is no preserved segment, the optimization-disable flag is unset, and no usable buffered active-tip marker is found. The walker keeps one leaf's linear parent ancestry plus required metadata. It applies the reduced buffer only when it removes at least half the original bytes.

Parallel assistant tool blocks and their result messages can be siblings outside that linear ancestry. [`recoverOrphanedParallelToolResults`](/Users/pt/cat-code/src/utils/sessionStorage.ts:3449) runs after parsing. It cannot recover siblings already removed from the input buffer.

The ordinary resume reader in [`loadMessagesFromJsonlPath`](/Users/pt/cat-code/src/utils/conversationRecovery.ts:547) uses the default loader. [`loadOwnedConversationForResume`](/Users/pt/cat-code/app/sidecar/sessionResume.ts:70) reaches that resume path. In contrast, [`loadDisplayTranscriptFromJsonlPath`](/Users/pt/cat-code/src/utils/sessionStorage.ts:5468) requests `keepCompactedHistory: true` and bypasses this optimization. Displayed history can therefore contain records missing from a resumable conversation. Automatic idle parking also makes restoration relevant without a user deliberately restarting the app; no live parking experiment was performed.

The pruning function and call are present in the repository's `86051a8e` snapshot dated 30 April. This is a pre-existing defect rather than a new change introduced during this investigation.

### Actual production-loader comparison

Each file below has no tip record. The default loader was compared with the same loader under `CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP=1`, followed by the same production selector. All six comparisons selected the **same final tip**, while the default path omitted history:

| Engine session | Bytes | Default selected | Optimization disabled | Omitted messages | Omitted result IDs with retained calls |
|---|---:|---:|---:|---:|---:|
| `cfb83b47-3a78-4e97-a4f7-6a700fcae501` | 6,149,253 | 200 | 253 | 53 | 39 |
| `b31fcac4-ecc8-432e-a738-36f829bd89be` | 8,077,649 | 1,234 | 1,436 | 202 | 136 |
| `be4f3286-6139-4343-8bab-a4bad17fb964` | 6,150,664 | 321 | 412 | 91 | 39 |
| `dec9466e-7412-4306-983d-408c5a147eae` | 8,818,078 | 1,292 | 1,710 | 418 | 196 |
| `eff9c620-2496-4f65-8df6-0b2f8134c15a` | 15,262,409 | 623 | 840 | 217 | 107 |
| `04becfe9-f1c3-47b9-8bb8-39df6992c3cc` | 5,552,008 | 863 | 1,134 | 271 | 103 |
| Total | | | | 1,252 | 620 |

The omitted messages comprise 316 assistant tool-use messages and 936 tool-result messages. Crucially, **620 distinct tool-result IDs were omitted while their calls remained selected**. The supplied suggestion that pruning only removes complete call/result pairs is disproven by this comparison. Downstream API normalization was not exercised, so whether it repairs, rejects, or transmits those missing-result cases remains unknown; API validity is not established.

For `04becfe9`, default loading retained 2,131 records and selected 863 messages. Both optimization-disabled loading and display-history loading retained 2,402 records and selected 1,134 messages, with the same final UUID `9b561f79-5620-4a43-8833-802594f1a7d2`.

### Isolated reproduction without compaction

An isolated 6,293,404-byte transcript contained six ordered records: a user root, parallel assistant calls A/B sharing a message ID, results A/B, and a final assistant record descending from result A. Result B carried a 6 MiB payload. The file contained neither compaction nor a tip marker.

| Loader mode | Loaded / selected | Same final tip? | Call B and result B retained? |
|---|---|---|---|
| Default | 4 / 4 | Yes | No |
| Optimization disabled | 6 / 6 | Yes | Yes |

This isolates the pruning defect from compaction and demonstrates why checking only the final tip is insufficient. The corpus comparison's disable flag also affects pre-compaction skipping; the no-compaction fixture removes that confound for the demonstrated mechanism.

## Existing uncertainty that remains legitimate

App `dc4712c9-cde3-480a-b7fe-b9cd6e7e4245`, engine `27fcb7af-1034-4826-8e3a-1ee652814a3d`, provides a different case. At validation time its ledger still required user reconciliation and its continuation was uncertain.

At 9 October, 10:04:13.036 Bangkok, L1754 recorded `partial_stream_replay_skipped` after an OpenAI websocket idle timeout, with a client tool call already present and automatic continuation ineligible. This is actual incomplete execution evidence; it must not be automatically relabelled successful because other sessions completed after the handoff deadline.

Its ancestry is nevertheless defective. Deferred recoveries at L1755-L1756 lead back through L796 and bypass 256 user/assistant records; the warning at L1757 descends from those recoveries. The failed-turn operational record reports approximately 50 minutes 22 seconds. A later close at 10:11:42.094 is followed by warning persistence at 10:11:42.153.

A historical [restore event](/Users/pt/.cat-code/desktop/logs/operational-e21679ba-1dcc-4a9b-ba24-43c7b62b731d-1791515514738.jsonl:20) at 10:12:02.468 records `messageCount: 88`. The later production-loader snapshot selected 91 messages after subsequent records. This shows restoration already occurred historically; it is not a live restore performed by this investigation. Exact model-token input was not captured.

This case requires preserving both truthful uncertainty and full conversation ancestry. The live ledger is a validation-time snapshot and may subsequently change.

## Why the model said it was paused

Saving the outcome inserted this meta instruction:

> The workspace changed, but continuation completion could not be confirmed. Some work may have started. Wait for the user to reconcile the conversation before continuing.

The controller can admit genuine user input and clear reconciliation, while the model still sees that instruction. The observed `hi` and status-question turns reached the engine and completed successfully. Their pause wording is not evidence of an engine deadlock.

The runtime gate and model-facing explanation must agree about when reconciliation is satisfied. See [outcome wording](/Users/pt/cat-code/src/app-runtime/handoff.ts:55) and [controller settlement](/Users/pt/cat-code/src/app-runtime/AppSessionController.ts:159).

## Independent validation performed

These were bounded diagnostic experiments, not committed regression tests. They executed existing production code with isolated adapters, controlled time, or isolated disk/configuration state. No production seam or live-state mutation was introduced. The follow-up corpus scan was independently implemented rather than accepting the pasted counts.

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

### Real ordinary-submission persistence

The isolated QueryEngine experiment used the actual transcript writer, stopped at the input-persisted callback before model execution, and then used the production loader and selector. Its accepted run produced:

```json
{
  "barrierReached": true,
  "hasTipRecord": false,
  "nextPromptParentIsDeferredRecovery": true,
  "recoveryParentIsAssistantA": true,
  "completedResponseBStillOnDisk": true,
  "selectedContainsCompletedResponseB": false,
  "selectedContainsNextPrompt": true,
  "selectedTipIsNextPrompt": true,
  "blockedNetworkRequests": 0
}
```

The configuration and workspace were isolated, the credential was a dummy value, and network access was blocked by the harness. Only the run that reached the persistence barrier with zero network requests was accepted as evidence. This confirms real engine submission and disk round-trip behavior without a live model call.

### Production reader and corpus verification

The scan imported the actual loader and active selector and compared ordinary reads with optimization-disabled reads. It independently obtained the counts and six large-file differences recorded above. The synthetic fixture then exercised the same actual loader with no compaction, no tip marker, and enough sibling payload to trigger the byte-reduction condition.

Diagnostic artifacts were stored temporarily under `/private/tmp/handoff-validation-20261009-01a11e6e`: `scan.ts`, `independent-scan.json`, `scan-output.json`, and `ordinary-prompt.ts`. These are scratch artifacts, not durable regression tests or required repository dependencies. The significant results are preserved in this report so the analysis does not depend on their retention.

### Corrections and remaining investigation scope

- The deferred-persistence bug affects ordinary submissions; it does not fire on every ordinary prompt regardless of message state.
- The `b80eb44d` example had an earlier workspace jump, but the demonstrated later fork was triggered by an ordinary prompt.
- A usable active-tip marker bypasses the identified large-file pruning path. It does not fix deferred-message ancestry or prove complete parallel history on other paths.
- Large-file pruning does not preserve complete call/result pairs in the observed corpus. Actual downstream API normalization remains unvalidated.
- Duplicate UUID positions must be compared using their first occurrence; backward file positions alone do not prove new forks.
- Small backward gaps, duplicate-record origins, other routing/peer/goal timers, deferred runners, lease races, and the full compaction/supervisor lifecycle were not exhaustively audited. No additional defect is claimed for them.

### Checks not performed

- No full desktop/socket/engine reproduction of the historical incident.
- No live app launch, GUI interaction, or cold restore.
- No implementation or regression test of the proposed new completion lifecycle.
- No independent review of the correctness of commit `8b9e58b9`.
- No repair of the affected session's active branch or warning.

## Fix plan

Implement three coordinated repairs at their respective owners: ordered transcript writing, parallel-preserving transcript loading, and durable handoff completion reconciliation. Fix writing and reading first so subsequent lifecycle recovery preserves complete saved history. Raising the 30-minute duration alone is insufficient.

### 1. Preserve ordered transcript ancestry

Ensure retained, loggable system messages cannot first be persisted later in the middle of an already-recorded chain. Apply ordered inline persistence at the `QueryEngine` owner where appropriate, including recovery/API-error messages on ordinary submission paths. Surface write failures, and verify that subsequent prompt and outcome appends preserve the current conversation ancestry before publishing a new active tip.

Do not simply relax `recordTranscript`'s prefix behavior: it also protects compaction/preserved-message ordering. Validate deferred recovery, repeated outcome persistence, parallel tool records, and compacted histories through the production reader.

### 2. Preserve parallel history before parsing

Replace or constrain `walkChainBeforeParse` so pruning preserves everything the production selector needs: the chosen ancestry, eligible parallel assistant blocks sharing message identity, their tool results, and compaction/preserved-segment semantics. If the fast path cannot establish that closure safely, fall back to the correctness-preserving reader. Disabling this unsafe optimization is a possible interim mitigation, subject to explicit memory/performance validation; it is not an implemented fix.

Keep the default resume reader and display reader consistent about recoverable conversation content. A tip marker or a matching final UUID alone is not an adequate repair or validation oracle. Do not hide missing results by dropping retained calls; verify the expected full conversation and downstream API shaping. Establish a bounded performance strategy after correctness is demonstrated rather than retaining unsafe byte filtering for speed.

### 3. Separate continuation acceptance from execution completion

Use a short, bounded command acknowledgement to establish that continuation was accepted. Track the actual admitted operation separately through running and terminal states.

A fixed command-reply deadline must not classify legitimate tools, permission waits, retries, or long model turns as completed or failed. Missing delivery acknowledgement should initiate status reconciliation without replaying the continuation.

Write `completed` only when the real continuation has settled successfully, rather than using it for admission. Define conservative interpretation/migration for legacy records where `completed` and `admitted` coexist.

### 4. Record durable, independently recoverable completion evidence

Introduce a bounded, engine-owned continuation receipt tied to the exact app session, engine session, operation, continuation UUID, and admission identity/destination generation. Persist terminal evidence only after the real turn settles and required transcript writes succeed.

Main remains the sole owner of the workspace-jump ledger. Live completion and restart/status recovery reconcile the receipt into that ledger. Recovery must never resubmit already-admitted work. Receipt identity must be checked against the admitted operation and validated restore identity; a new process generation must not blindly accept unrelated old evidence.

The exact receipt schema, storage owner, and control/event shape remain implementation design work. They must be settled before code changes, with explicit success/failure/cancellation semantics and durability ordering.

### 5. Serialize lifecycle transitions and reconcile late success

Give one coordinator transition owner responsibility for completion, status observation, timeout, Stop, close, process loss, warning persistence, and user reconciliation. Recheck state/identity after awaits.

Required behavior:

- A confirmed completion clears the retained running operation even if an earlier RPC expired.
- Close after confirmed completion closes normally.
- Cancellation during active execution retains existing review semantics.
- Duplicate messages are idempotent.
- Stale operations, replies, generations, and callbacks cannot overwrite newer cancellation, completion, or reconciliation.
- Transcript-write failure cannot publish a successful durable receipt or advance an active tip as though persistence succeeded.

### 6. Treat uncertainty as recoverable observation before committing a warning

Before saving a terminal warning, check authoritative completion evidence and serialize that check with completion handling. A missing reply alone does not prove that work failed.

Preserve idempotent warning persistence. Once a warning is already durable, resolve it through explicit durable follow-up state rather than silently rewriting history. Existing uncertain ledgers without trustworthy completion evidence remain conservative; neither a Git commit nor free-text assistant output automatically clears them.

Explicitly retain uncertainty for interrupted partial execution such as `27fcb7af`. Fixing the timeout classification must not manufacture a successful receipt for a genuinely failed or incomplete turn.

### 7. Align model-facing reconciliation with controller state

Once genuine user input has been durably accepted for reconciliation, expose that the condition was satisfied or use warning context with an unambiguous expiration condition. Do not leave the model to interpret an indefinite wait instruction after the controller already cleared its gate.

Maintain fencing for automatic and peer-originated turns. Clearing model-facing ambiguity must not broaden which inputs can reconcile an operation.

### 8. Improve bounded operational evidence

Record the control action, request/operation identity, deadline expiry versus explicit refusal, continuation admission/settlement, and warning persistence using the existing bounded operational-log schemas. Do not log user message bodies, credentials, or unrestricted raw engine output.

The incident is currently reconstructable, but critical historical transitions remain inferred because these correlation fields are absent.

## Validation plan

### Transcript writer and reader regressions

Use the real production writer and reader in isolated storage, with assertions about full selected history and tool identities:

1. Ordinary prompt: persist assistant A and B/final, retain a deferred recovery between them in memory, and submit a normal user prompt through QueryEngine. With no tip record, flush and reload; B/final must remain selected. Repeat with an API-error message and with handoff outcome persistence.
2. Large-file parallel recovery: create a transcript above 5 MiB, without compaction or a tip marker, with sibling tool calls/results and enough removable bytes to activate the optimization. Both siblings must survive normal loading with the same final tip. This fixture must fail against the current reader.
3. Missing-result case: preserve a call on the selected parent chain while placing its result in a recoverable sibling. Assert that both remain selected and that actual downstream API normalization produces the expected complete conversation. Do not substitute a complete-pair-only fixture for this case.
4. Reader boundaries: cover below/above the byte threshold, pruning below/above the half-buffer reduction threshold, usable/missing tip markers, multiple leaves, and display versus default resume reads. Assert content equality where semantics require it, not merely tip equality.
5. Compaction and durability: retain preserved segments, valid compacted ancestry, idempotent repeated writes/outcomes, and parallel recovery. A transcript-write failure must neither advance a durable active tip nor publish successful completion.

Include the synthetic six-record reproduction as a focused failing fixture and a representative corpus-derived shape as independent coverage. Avoid copying large private transcripts into repository tests. Validate the safe fallback's resource use with representative large files after correctness checks; no performance claim has yet been established.

### Handoff lifecycle regressions

The primary lifecycle regression must cover the actual control-request/coordinator/sidecar boundary with accelerated time and isolated deterministic engine behavior:

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
- An actually interrupted partial turn retaining uncertainty while preserving all saved ancestry.
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

The repair is complete when ordinary submissions and recovery warnings preserve full active ancestry; large-file resume loading preserves recoverable parallel calls/results; legitimate long-running continuations can finish without stale uncertainty; completion can be reconciled after lost replies without duplicate execution; close/cancellation races preserve correct state; genuine-user reconciliation agrees with model-facing context; and the relevant regressions and package checks pass with material limitations reported.

At this update, the three mechanisms and the follow-up corpus findings have been independently validated to the limits described above. Implementation, full-boundary lifecycle reproduction, downstream API normalization checks, proposed-fix validation, GUI verification, and any existing-session repair remain outstanding.
