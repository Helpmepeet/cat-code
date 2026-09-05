# Subagent interruption and model-controlled resume

**Status:** Design. Revises the operator's 2026-09-04 plan ("Model-Controlled
Subagent Crash Resume"). No source files change with this doc.

**Verified against source 2026-09-04.** Every `file:line` below is to that
state of the tree. Where the submitted plan and source disagree, source won
and the disagreement is recorded in §0.

**Companion:** `docs/agent/2026-07-11-recovery-authority-model.md` ruled on
which record wins when planes disagree, and specified the process-restart
decay rule (§2 Q3) that this design finally implements. Nothing here reopens
those rulings.

---

## 0. What changed from the submitted plan, and why

The plan's ownership rule, its ten acceptance criteria, and its
"detection is automatic, recovery is not" invariant all stand. The mechanism
underneath them changes in ten places because the plan modelled a crash as an
exception and the runtime does not work that way.

| # | Plan said | Source says | Consequence |
|---|---|---|---|
| 1 | Unexpected failures throw into the lifecycle's `catch`; classify the thrown error there. | Network, provider, auth and rate-limit deaths do not throw out of the stream. `withRetry` burns its budget (`withRetry.ts:98`, `:491`, `:1318`), the API layer converts the final error into a synthetic assistant message with `isApiErrorMessage: true` and a typed `error` code (`errors.ts:1088-1290` `getAssistantMessageFromError`; `query.ts:1165-1187`), the stream then ends normally, `finalizeAgentTool` reports it as `error` (`agentToolUtils.ts:694-706`), and the lifecycle takes the `agentResult.error` branch (`agentToolUtils.ts:1087-1136`). The generic `catch` (`agentToolUtils.ts:1239-1290`) sees only runtime exceptions. | Classification reads the terminal message's typed `error` code and the max-turns marker. It does not string-match a thrown exception. §3. |
| 2 | Add a first-class `crashed` task status. | `TaskStatus` is one union for seven task kinds (`Task.ts:15-20`), the SDK schema (`coreSchemas.ts:1359`, generated types), the persisted task-notification origin (`message.ts:13-17`), the desktop wire (`app/shared/protocol.ts:1539`, `:1670`), and at least twelve consumers written as non-exhaustive `if` chains (`taskStatusUtils.tsx:19,45,69`, `pillLabel.ts:130`, `Notifications.tsx:381,426`, `WaitWorkersTool.ts:79`, `useTeammateViewAutoExit.ts:45`, `app/renderer/src/tasksState.ts:63`). A fifth value is silently *non-terminal* in every one of them: the renderer's `TERMINAL_STATUSES` set would show a crashed worker as live forever, which is the exact lie this feature exists to remove. | Status stays `failed` / `killed`. The distinction the model needs lives in a new `cause` field carried on the task, the durable row, and the notification. §3. |
| 3 | On restore, compare durable `running` workers against live `LocalAgentTask`s. | After restore the task map is empty (`main.tsx:3007` `tasks: {}`); nothing rehydrates local agents. The only durable `running` claim is Agent Mode's `knownWorkers[].status` (`sessionState.ts:505`), and the 2026-07-11 decay rule for it was specified but never implemented. | Restart recovery is a durable-planes reconciliation only, and Phase 4 implements the decay rule as a one-time rewrite. §7. |
| 4 | `buildStallReminders()` already detects lost workers; only its wording changes. | Its gate is "no `tool_result` for the spawn's `toolUseId`" (`sessionRestore.ts:611-618`, `:660`). A background launch returns its `tool_result` immediately (`AgentTool.tsx:2325` "Async agent launched successfully"), and so does a resume (`ResumeAgentTool.tsx:159`). **Every background worker is invisible to the reminder today.** The existing tests (`sessionRestore.stallReminders.test.ts:41-91`) only exercise foreground shapes. | The gate becomes per launch kind: foreground = `tool_result` present; background = a task-notification user message for that agent after the spawn row. §7. |
| 5 | Transport retry is "existing API adapters may retry"; document the boundary. | Three attempt-internal self-heal layers exist and each restarts model calls without ending the attempt: `withRetry` (5 attempts, Codex lease failover, outage backoff, `withRetry.ts:98-1318`); the Codex partial-stream continuation (two per top-level query, with a recovery prompt nearly identical to the plan's §20 text, `query.ts:253-257`, `:1535-1570`); max-output-tokens recovery (`query.ts:226`); reactive compaction on prompt-too-long (`query.ts:1290-1300`). | The boundary is the lifecycle, not the adapter: once `runAsyncAgentLifecycle`'s `for await` returns or throws, the attempt is over and nothing below the model starts another. §1 invariant I-A. |
| 6 | Graceful exit writes `stall-detected`. | Only when the lifecycle loses a race. `gracefulShutdown` runs `runCleanupFunctions()` under a 2 s budget (`gracefulShutdown.ts:455-470`); the local-agent cleanup is `killAsyncAgent` (`LocalAgentTask.tsx:644-648`), which aborts the run, so the lifecycle's `AbortError` handler writes a `killed` row and unregisters the agent (`agentToolUtils.ts:1196-1238`). `flushStallDetectedEntries` on `exit` (`gracefulShutdown.ts:263`) only sees agents that handler did not reach. A `killed` row from shutdown is byte-identical to one from a user `TaskStop`. | Shutdown stamps `cause: 'parent-exit'` on the task before aborting; the abort handler copies the stamped cause into the row. §4. |
| 7 | (not covered) | `failAgentTask` marks the leased Codex account as errored on every failure (`LocalAgentTask.tsx:583-584`), including prompt-too-long and max-turns, which are the worker's fault, not the account's. | Account blame is gated on cause. §4. |
| 8 | (not covered) | Foreground agents fail through a separate path that writes the same `subagent-terminal` row (`AgentTool.tsx:2100-2150`, `:2195-2225`) and returns the error inline as the `tool_result`. | Same cause record, different delivery channel. §5. |
| 9 | Store `resumable: true` on the terminal record. | Resumability is "the transcript exists", and both consumers already check that at use time: `TranscriptNotFoundError` on resume (`resumeAgent.ts:136-138`) and the continuity read's transcript re-check (`sessionState.ts:421-437`). A stored flag is a claim that decays, the failure class §1-P2 of the recovery doc catalogues. | Not stored. The restart reminder and the notification state the fact ("transcript: available") after a `stat`. §3. |
| 10 | (not covered) | Agent Mode records `resumable: completed` (`sessionState.ts:639`) and prior-session continuity merges only `completed && resumable` workers (`sessionState.ts:415`). This contradicts decision D8 of the recovery doc (resume-to-repair a failed worker) and means a worker interrupted in a prior session cannot be found by handle. | Follow-on, not v1: §13. |

Everything else in the plan (ResumeAgent as the only wake path, SendMessage
never waking a worker, double-resume protection, same `agentId` across
attempts, no retry timer) is already true in source and stays.

---

## 1. Goal and invariants

A subagent attempt can end because of its environment (network, provider,
account, parent process) or because of its own trajectory (context limit,
turn budget, a bug). Either way the runtime records what happened, keeps the
transcript, releases live resources, and tells the parent model. The parent
model decides whether the same worker continues. Nothing below the model ever
restarts a worker.

```text
Runtime owns:      detecting the end of an attempt
                   naming its cause
                   persisting the terminal record
                   releasing live resources, keeping durable ones
                   notifying the parent model with enough to decide

Parent model owns: whether continuing is useful
                   the recovery prompt
                   calling ResumeAgent, spawning fresh, or dropping it

ResumeAgent owns:  reconstructing context from the transcript
                   starting the next attempt
```

Five invariants, each with the check that proves it:

- **I-A No restart below the model.** No code path in `agentToolUtils.ts`,
  `LocalAgentTask.tsx`, `cleanupRegistry.ts`, `gracefulShutdown.ts`,
  `sessionRestore.ts`, or `resumeAgent.ts`'s own failure handling calls
  `resumeAgentBackground` or `runAgent` in response to a termination. Check:
  the tests in §10 assert `runAgent` call count stays 1 across a failure and
  across an hour of fake time; a grep for those two names in those files finds
  only the launch sites.
- **I-B One attempt, one terminal row, one cause.** Every attempt that
  started (a `subagent-spawned` row) ends with exactly one `subagent-terminal`
  row carrying `cause`, or, after an unclean process death, with no row at
  all, which restore reads as `parent-exit`. Check: §10 tests per exit path.
- **I-C The transcript survives every termination.** Terminal transitions
  release the abort controller, the Codex lease, the websocket session, the
  cleanup registration, and the task-output symlink. They never touch
  `agent-<id>.jsonl` or `agent-<id>.meta.json`. Check: today's terminal
  paths already only call `releaseAgentCodexResources` and `evictTaskOutput`
  (`LocalAgentTask.tsx:366-369`, `diskOutput.ts:288-298`, which flushes and
  drops the in-memory writer for a symlinked file); the §10 tests `stat` the
  transcript after each termination.
- **I-D Only `ResumeAgent` moves an agent back to running.** `SendMessage`
  keeps refusing stopped targets with a `ResumeAgent` hint
  (`SendMessageTool.ts:316-341`). Check: existing SendMessage test plus §10
  test 4.
- **I-E After a process restart nothing is running.** Every durable claim
  of `running` decays to an interrupted terminal state at restore, with cause
  `parent-exit`, before the model sees the conversation. Check: §10 tests 5
  and 6.

---

## 2. Anatomy of an attempt

One attempt is one `runAsyncAgentLifecycle` call (or, for a foreground agent,
one `AgentTool.call` iteration). It has four ways to end. The plan only
modelled the third.

```text
                 for await (message of makeStream())        agentToolUtils.ts:1011-1052
                                 │
      ┌──────────────────────────┼───────────────────────────┬────────────────────┐
      │                          │                           │                    │
 (a) stream ended,          (b) stream ended,           (c) throw            (d) process death
     last assistant is          max-turns marker             │                    │
     a synthetic API            in messages              ┌───┴────┐         ┌─────┴──────┐
     error terminal                 │                    │        │         │            │
      │                             │               AbortError  other    graceful      SIGKILL /
      │                             │                    │        │       shutdown     machine crash
 finalizeAgentTool             finalizeAgentTool      killAsync  fail      │            │
 sets error (:694-706)         sets error (:706)      Agent     Async   cleanup fn     nothing
      │                             │                 (:1202)   Agent   (LocalAgent    written;
      └──────────┬──────────────────┘                    │      (:1251)  Task:651)     spawn row
                 │                                       │        │        aborts →     has no
      agentResult.error branch                     'killed' row  'failed'  (c) or       terminal
      (:1087-1136) → 'failed' row                  (:1214)       row       exit sweep   row
                                                                 (:1252)   'stall-
                                                                            detected'
                                                                           (cleanupRegistry.ts:98)
```

What actually reaches exit (a) today, by source of the synthetic terminal:

| Terminal produced by | Typed signal on the message | Meaning |
|---|---|---|
| `withRetry` exhaustion on `APIConnectionError` / timeout | `error: 'unknown'` or connection text (`errors.ts:1088`, `:1161`) | environment: network |
| 5xx / 529 / overload exhaustion | `error: 'server_error'` (`errors.ts:1201`) | environment: provider |
| 429, Codex cap, lease exhausted | `error: 'rate_limit'` / `billing_error` (`errors.ts:1194`) | environment: quota |
| 401, reauthentication required | `error: 'authentication_failed'` | environment: account |
| blocking-limit preempt | `PROMPT_TOO_LONG` text, `error: 'invalid_request'` (`query.ts:804-808`) | worker: context limit |
| max_output_tokens after 3 recoveries | `apiError: 'max_output_tokens'` (`claude.ts:2536-2556`) | worker: output limit |
| `query()` internal throw (bug) | plain text, no code (`query.ts:1181-1187`) | runtime |

`classifyAPIError` (`errors.ts:1150-1215`) already maps thrown errors to
these classes for analytics. The design reuses that vocabulary rather than
inventing a parallel one.

---

## 3. Data model

### 3.1 The cause vocabulary

```ts
// src/tasks/LocalAgentTask/terminationCause.ts  (new, small, no React)
export type SubagentTerminationCause =
  | 'connection'     // network / timeout budget exhausted
  | 'provider'       // 5xx / 529 / overload budget exhausted, Codex response failed
  | 'rate-limit'     // 429, usage cap, every leased account exhausted
  | 'auth'           // 401 / reauthentication required
  | 'context-limit'  // prompt-too-long blocking limit; resume hits the same wall
  | 'output-limit'   // max_output_tokens recovery budget exhausted
  | 'max-turns'      // turn budget spent; resume starts a fresh budget
  | 'runtime'        // exception thrown inside the lifecycle
  | 'parent-exit'    // parent process shut down or died
  | 'user-stop'      // TaskStop / ESC
  | 'unknown'

/** The worker was not at fault; the same context will likely succeed later. */
export function isEnvironmentalCause(cause): boolean
  // connection | provider | rate-limit | auth | parent-exit

/** A failure the leased account should be marked for. */
export function isAccountFaultCause(cause): boolean
  // auth | rate-limit | provider

export function classifyTermination(input: {
  terminalMessage?: AssistantMessage   // exit (a): last assistant, isApiErrorMessage
  maxTurnsReached?: boolean            // exit (b)
  thrown?: unknown                     // exit (c)
  stamped?: SubagentTerminationCause   // exit (d): cause set on the task before abort
}): SubagentTerminationCause
```

Classification order, first match wins:

1. `stamped` (a shutdown stamped `parent-exit`; see §4).
2. `thrown instanceof AbortError` → `user-stop`.
3. `thrown` anything else → `runtime`.
4. `terminalMessage.error` by code: `authentication_failed` → `auth`;
   `rate_limit` | `billing_error` → `rate-limit`; `server_error` →
   `provider`; `invalid_request` with the prompt-too-long text →
   `context-limit`; `apiError === 'max_output_tokens'` → `output-limit`;
   connection text per `classifyAPIError` → `connection`.
5. `maxTurnsReached` → `max-turns`.
6. `unknown`.

`resumable` is **not** a field. It is a fact checked when it matters:
`ResumeAgent` throws `TranscriptNotFoundError` (`resumeAgent.ts:136-138`),
and the restart reminder `stat`s the transcript before it renders (§7).

### 3.2 Where the cause lives

| Record | Field | Written by | Notes |
|---|---|---|---|
| `LocalAgentTaskState` (`LocalAgentTask.tsx:150`) | `terminationCause?: SubagentTerminationCause`; `attempt: number` | terminal transitions (§4); `registerAsyncAgent` sets `attempt: 1`, resume sets `meta.attempt + 1` | `status` union untouched. `error` stays the human text. |
| `SubagentTerminalMessage` (`logs.ts:354-364`) | `cause?: SubagentTerminationCause`; `attempt?: number` | every `appendSubagentTerminal` call site (`agentToolUtils.ts:1093,1140,1214,1252`; `AgentTool.tsx` ×8; `cleanupRegistry.ts:98` writes `cause: 'parent-exit'`) | Additive. `status` union unchanged (`stall-detected` stays; it now also carries a cause). Older rows without `cause` are read as §7 rule 3. |
| `AgentMetadata` (`sessionStorage.ts:398`) | `attempt?: number`; `lastTerminationCause?: SubagentTerminationCause` | `attempt` through the existing `writeAgentMetadata` on spawn and the resume re-persist (`resumeAgent.ts:275-277`); `lastTerminationCause` through a new `updateAgentMetadata(agentId, patch)` read-merge-write at terminal time | Single writer per agent is already guaranteed (`activeResumeLifecycles`, `resumeAgent.ts:75`). This is the per-agent cache; the parent transcript's spawn/terminal rows remain the per-attempt ledger of record. |
| `AgentModeWorkerSession` (`sessionState.ts:26-44`) | `terminationCause?` | `recordWorkerSessionTerminal` gains a `cause` argument | Status union unchanged. |
| Task notification (`taskNotification.ts:17-27`, `message.ts:13-17`) | `cause?`; `attempt?` | `enqueueAgentNotification` | Additive on both the formatter and the persisted origin. Persisting them is what lets restore (§7) know a background worker's outcome was delivered. |

The desktop wire (`app/shared/protocol.ts`) needs nothing in v1 because no
status value changes. Projecting `cause` onto `TaskSnapshotItem` later is an
additive change under that file's care rule.

---

## 4. Task transitions

No new transition function. The two existing terminal transitions grow a
cause; a stamp hook is added for shutdown.

```ts
failAgentTask(taskId, error, setAppState, cause)      // LocalAgentTask.tsx:568
killAsyncAgent(taskId, setAppState, cause = 'user-stop')   // :374
```

- `failAgentTask` stores `terminationCause`, and calls
  `markPoolAccountLastError` **only** when `isAccountFaultCause(cause)`
  (today it blames the account unconditionally, `:583-584`).
- `killAsyncAgent` stores the cause it was given. The cleanup registered in
  `registerAsyncAgent` (`:644-648`) passes `'parent-exit'`. Every other
  caller keeps the default.
- The lifecycle's `AbortError` handler (`agentToolUtils.ts:1196`) reads the
  task's stamped cause (via `getAppState`) and writes it into the `killed`
  row and the Agent Mode record. If the stamp says `parent-exit`, the
  notification is skipped: the process is exiting and the restart reminder
  (§7) is the delivery channel for that case.
- Both transitions keep their `status !== 'running'` guard, release live
  resources exactly as today, and never touch the transcript (I-C).

`markAgentTaskResumed` (`:252`) additionally clears `terminationCause` and
`error` and bumps `attempt`, so the live task describes the current attempt
while the ledger keeps history.

---

## 5. Lifecycle changes

`runAsyncAgentLifecycle` (`agentToolUtils.ts:946`) has three terminal
branches. Each computes `cause` once at its top and threads it through the
task transition, the terminal row, the Agent Mode record, the metadata
update, and the notification. Nothing else in the control flow moves.

| Branch | Today | Change |
|---|---|---|
| `agentResult.error` (`:1087-1136`) | `failAsyncAgent(taskId, msg)`, row `failed`, notification `failed` | `cause = classifyTermination({ terminalMessage: last assistant, maxTurnsReached })`; all four sinks carry it |
| `catch AbortError` (`:1196-1238`) | `killAsyncAgent`, row `killed`, notification `killed` | `cause = stamped ?? 'user-stop'`; skip notification when `parent-exit` |
| `catch other` (`:1239-1290`) | `failAsyncAgent`, row `failed`, notification `failed` | `cause = 'runtime'` |

The foreground path in `AgentTool.tsx` (`:2100-2150`, `:2195-2225`) computes
the same cause for its `failed` rows and Agent Mode records. Its delivery
channel is the inline `tool_result`, which already carries the error text; it
gains one line, `Cause: <cause>`, and the same "will not resume
automatically" sentence when the cause is environmental.

### 5.1 Notification text

`enqueueAgentNotification` (`LocalAgentTask.tsx:274`) builds the summary. For
`failed`:

```text
Task notification
Task ID: <agentId>
Output file: <path>
Tool use ID: <toolUseId>
Status: failed
Cause: connection
Attempt: 2 (previous: connection)
Summary: Agent @Ada stopped: Unable to connect to API. Check your internet connection
Result:
<partial text, as today>
Usage: ...
Worktree: ...
Recovery: This worker is stopped and will not resume automatically. Its transcript is kept.
ResumeAgent continues the same context once the connection is back. Agent starts fresh if the context is not worth keeping.
```

The `Recovery:` block is one canned sentence pair per cause, chosen so the
model does not have to infer the resume prognosis:

| cause | Recovery line |
|---|---|
| connection, provider | transient; `ResumeAgent` keeps the context once the environment is back |
| rate-limit | wait for the window or switch account, then `ResumeAgent` |
| auth | the user must re-authenticate first; do not resume until they have |
| context-limit | `ResumeAgent` replays the same context and will hit the same limit; spawn a fresh `Agent` with a tight brief, or resume with an instruction to summarise and hand off only if the last turn was small |
| output-limit | resume works; tell the worker to write in smaller pieces |
| max-turns | resume starts a fresh turn budget; check the transcript tail for looping first |
| runtime | inspect the error; resume may reproduce it |
| user-stop | not a failure; no recovery line |

`Attempt:` and `previous:` print only when `attempt > 1`. That is the whole
of the plan's "repeated crash protection": history, no counter, no limit.

---

## 6. Resume path

`resumeAgentBackground` (`resumeAgent.ts:79`) already does everything the
plan asks: transcript load with API-validity filters (`:139-143`), worktree
re-validation, same `agentId`, spawn row, lifecycle launch, and two layers of
double-resume protection (`activeResumeLifecycles` `:75-97`; fresh-state
recheck `:290-293`; `ResumeAgentTool.tsx:135-146`). Changes:

- Read `meta.attempt`; pass `attempt: (meta.attempt ?? 1) + 1` into the
  metadata re-persist and the lifecycle metadata.
- `ResumeAgentTool`'s success message appends `Attempt N; previous attempts
  ended: connection, connection.` when `N > 1`, read from `meta`.
- The synthetic API-error tail in the transcript needs no special handling:
  it is persisted with `isApiErrorMessage` (`messages.ts:843`) and
  `normalizeMessagesForAPI` drops synthetic-model error messages before any
  request (`messages.ts:2137-2160`), so the resumed worker sees its own real
  partial output and not the error string.
- `TranscriptNotFoundError` and `AgentResumeInProgressError` handling is
  unchanged.

The plan's §20 default resume prompt is guidance for the model, not code. It
goes in the ResumeAgent prompt (§8), not into the runtime.

---

## 7. Restart recovery

`processResumedConversation` (`sessionRestore.ts:760`) calls
`buildStallReminders` (`:595`). It is rewritten around three rules and one
write.

**Rule 1: gate per launch kind.** For each `subagent-spawned` row, the
outcome was delivered to the conversation if either a `tool_result` for its
`toolUseId` exists **and the launch was foreground**, or a user message with
`origin.kind === 'task-notification'` and `origin.taskId === agentId` appears
after the spawn row (background launch or resume). The spawn row gains
`launch: 'foreground' | 'background' | 'resume'` (additive) so restore does
not have to guess from the `tool_result` text. Rows without it are treated as
foreground, which preserves today's behaviour for old transcripts.

**Rule 2: liveness is decided, not hedged.** The process that owned the
worker is gone. Every undelivered worker is `interrupted`; the reminder never
says "may still be running".

**Rule 3: cause from the ledger.** Terminal row with `cause` → that cause.
`stall-detected` without `cause` → `parent-exit`. `killed` without `cause` →
`user-stop`. `failed` without `cause` → `unknown`. No terminal row →
`parent-exit` (unclean death). The transcript is `stat`ed; the reminder says
`transcript: available` or `transcript: missing (cannot resume; spawn fresh)`.

**One reminder shape**, warning level under 24 hours, info level after:

```text
<system-reminder>
A subagent from this session was interrupted and its outcome never reached this conversation.

  agentId: <id>
  name: @<name>          (when present)
  description: <description>
  cause: parent-exit     (interrupted when the previous process exited)
  attempt: 2
  ranFor: 312s
  lastActivityAt: <iso>
  transcript: available
  worktree: <path> (has uncommitted changes)   (when metadata records one and git says so)

It is stopped. It will not restart on its own. Decide now, before answering the user's next message:
- ResumeAgent({ agentId, prompt }) if its transcript or worktree holds work worth continuing. Tell it what was interrupted and to inspect its own state before repeating anything.
- Agent(...) with a fresh brief if the context is stale or the direction changed.
- Nothing, if the task is moot; say so in one line.
Ask the user only where the decision is theirs: discarding a dirty worktree, state they may have edited by hand, or a question the worker had raised for them. Do not tell the user the subagent was never spawned.
</system-reminder>
```

The old reminders' "ask the user which of (1)(2)(3)" instruction is gone;
that is the plan's §14 and the recovery doc's decision table D9/D10/D12 made
concrete. The over-24-hour variant keeps today's "mention only if relevant"
wording.

**The one write: Agent Mode decay.** For a non-fork restore of an Agent Mode
session, after the reminders are computed, every `knownWorkers[].status ===
'running'` entry is rewritten to `status: 'failed', terminationCause:
'parent-exit', error: 'interrupted by process exit'` through
`mutatePersistedSessionState`. This is the recovery doc's S1 decay rule
(`§2 Q3`) implemented; it stops `deriveCurrentPhase` reporting `executing`
and `getActiveWorker` selecting a ghost (`sessionState.ts:141-185`). The
transcript lease (`activateTranscriptLease`, `sessionRestore.ts:751`) makes
the resumed process the sole writer, so the rewrite cannot race a live
owner. `--fork-session` restores read the source state as decayed but do not
write it.

---

## 8. Model-facing prompts

Three files, exact sentences. All three already point at `ResumeAgent`; the
additions state the invariant the model cannot otherwise know.

`src/tools/ResumeAgentTool/prompt.ts` (after the "Use ResumeAgent when a
worker has completed, failed, been stopped, or been evicted" sentence):

```text
A worker that stopped because of its environment (connection, provider, rate limit, the previous process exiting) never resumes on its own. Its transcript and worktree are kept; a new attempt starts only when you call ResumeAgent. When you resume after an interruption, say so in the prompt and tell the worker to inspect its transcript and working tree before repeating completed actions. A worker that stopped at its context limit will hit the same limit if resumed; prefer a fresh Agent with a tight brief.
```

`src/tools/AgentTool/prompt.ts` (background bullet, `:415-420`):

```text
A background agent that fails is stopped, not retried. The failure notification names the cause and whether resuming is likely to help; decide between ResumeAgent, a fresh Agent, or dropping it. Nothing restarts it for you.
```

`src/tools/SendMessageTool/prompt.ts`: no change beyond confirming the
existing "must be currently running; use ResumeAgent if it has stopped"
sentence (`SendMessageTool.ts:98-99`) stays.

---

## 9. What this design deliberately does not do

- **No new status value** (§0 #2). The cost is a fifth value across two
  runtimes and a wire contract; the benefit is a label the `cause` field
  provides better.
- **No `resumable` flag** (§0 #9).
- **No retry counter or cap.** Every retry is a model action; the attempt
  history in the notification is the only guard the plan's §22 needs.
- **No change to attempt-internal recovery** (§0 #5). `withRetry`, the
  Codex partial-stream continuation, output-token recovery and reactive
  compaction stay as they are; they run inside one attempt and are not
  resumes.
- **No desktop changes in v1.** Status values are unchanged, so every
  renderer predicate keeps working. `cause` on the wire is a follow-on.
- **No user confirmation for recovery itself** (plan §14). The user is
  consulted only at the recovery doc's user-authority points (I4, I6, S2).

---

## 10. Tests

The plan's ten tests map onto real seams as follows. Each names its owner
file; all use `bun:test` with mocked `runAgent` where a stream is needed
(pattern: `resumeAgent.test.ts:48-200`).

| # | Test | Seam | Critical assertion |
|---|---|---|---|
| 1 | connection loss mid-run | `agentToolUtils.test.ts`: stream yields two real assistant messages then a synthetic terminal with `error: 'unknown'` and connection text | task `failed`, `terminationCause: 'connection'`; terminal row has `cause`; transcript path `stat`s OK; `runAgent` called once; notification contains `Cause: connection` and the will-not-resume line; `markPoolAccountLastError` **not** called |
| 1b | prompt-too-long terminal | same | `cause: 'context-limit'`; Recovery line says a resume hits the same limit |
| 1c | max-turns | same | `cause: 'max-turns'` |
| 1d | thrown exception | same, `makeStream` throws | `cause: 'runtime'` |
| 1e | provider 5xx terminal | same | `cause: 'provider'`; `markPoolAccountLastError` **called** |
| 2 | explicit resume after 1 | `resumeAgent.test.ts` | same `agentId`; transcript loaded; prompt appended; task `running`; `attempt: 2`; `terminationCause` cleared; `runAgent` called once for the new attempt |
| 3 | no timer | after test 1, `advance fake timers 1h` | `runAgent` still 1; status still `failed` |
| 4 | SendMessage cannot wake | `SendMessageTool.test.ts` | `success: false`, message names `ResumeAgent`, status unchanged |
| 5 | unclean death, foreground | `sessionRestore.stallReminders.test.ts` | spawn row, no terminal row, no `tool_result` → one reminder, `cause: parent-exit`, `transcript: available`, no Agent/ResumeAgent call |
| 5b | **unclean death, background** | same | spawn row `launch: 'background'`, `tool_result` present, **no** task-notification → one reminder. (Fails against today's code; this is the §0 #4 regression guard.) |
| 5c | background outcome delivered | same | spawn row, task-notification user message with that `taskId` → no reminder |
| 6 | graceful exit | `LocalAgentTask.test.ts` + `agentToolUtils.test.ts` | cleanup fn runs → task `killed` with `terminationCause: 'parent-exit'`; abort handler writes row with `cause: 'parent-exit'`; no notification enqueued |
| 6b | exit sweep | `cleanupRegistry.test.ts` | `stall-detected` row carries `cause: 'parent-exit'` |
| 6c | Agent Mode decay | `sessionState.test.ts` / restore test | `running` worker becomes `failed` + `parent-exit` on non-fork restore; untouched on fork restore |
| 7 | double resume | existing `resumeAgent.test.ts:132-200` | one lifecycle, one `AgentResumeInProgressError` |
| 8 | normal completion | existing | no `cause`, no Recovery line |
| 9 | user stop | existing TaskStop tests | `killed`, `cause: 'user-stop'`, notification has no Recovery line |
| 10 | transcript deleted | existing `TranscriptNotFoundError` path | "has no transcript to resume"; no fresh worker |
| 11 | classification table | `terminationCause.test.ts` | one case per row of §3.1's order, including precedence (stamped beats thrown, thrown beats terminal message) |

---

## 11. Acceptance criteria

1. Every attempt that ends produces a terminal row with a `cause`, or no row
   (unclean death), never a row without one.
2. The transcript and metadata exist after every termination kind.
3. The task is `failed` or `killed`, never `running`, after any termination;
   no new status value exists.
4. The parent model receives the cause and a per-cause recovery line, with
   attempt history when `attempt > 1`.
5. No runtime path calls `resumeAgentBackground` or `runAgent` in response
   to a termination; no timer retries.
6. `SendMessage` never wakes a stopped worker.
7. Only `ResumeAgent` moves the same worker back to `running`; it keeps the
   `agentId`, transcript, worktree and name.
8. After a process restart every previously running worker is reported as
   interrupted, including background ones, and Agent Mode durable state no
   longer says `running`.
9. Concurrent resumes still schedule at most one lifecycle.
10. The leased account is blamed only for account-fault causes.
11. §3 battery green for `src/` (`bun run build:dev:full` + the focused
    suites above); `bun test app/` unchanged because nothing in `app/` moves.

---

## 12. Implementation order

Each phase is independently shippable and leaves the tree consistent.

1. **Vocabulary.** `terminationCause.ts` + `classifyTermination` + test 11.
   Additive fields on `LocalAgentTaskState`, `SubagentTerminalMessage`,
   `AgentMetadata`, `AgentModeWorkerSession`, `TaskNotificationDetails`,
   `MessageOrigin`. `updateAgentMetadata` helper. No behaviour change yet.
2. **Transitions and lifecycle.** `failAgentTask` / `killAsyncAgent` cause
   parameters, account-blame gate, shutdown stamp, three lifecycle branches,
   foreground path, notification text. Tests 1 to 1e, 3, 6, 6b, 8, 9.
3. **Resume.** `attempt` threading, ResumeAgent result text. Tests 2, 7, 10.
4. **Restart recovery.** Spawn-row `launch` field, per-kind gate, cause from
   ledger, transcript `stat`, single reminder shape, Agent Mode decay write.
   Tests 5, 5b, 5c, 6c.
5. **Prompts.** §8 sentences; `prompt.test.ts` snapshots for the three
   tools.
6. **Docs.** `docs/maps/tasks-workers.md` local-agent rows (completion path
   now names `cause`; restore now covers background agents);
   `docs/maps/config-persistence.md` if it lists `subagent-terminal` fields.

---

## 13. Follow-ons and open questions

- **Agent Mode `resumable`.** `recordWorkerSessionTerminal` writes
  `resumable: completed` (`sessionState.ts:639`) and prior-session
  continuity merges only completed workers (`:415`). Under this design an
  interrupted worker from a prior session is resumable by raw `agentId` (the
  metadata fallback in `resolveAgentTarget.ts:289-306` is same-session only)
  but not by handle. Proposed: `resumable` becomes "transcript exists"
  regardless of terminal status, and the continuity filter admits any
  terminal status. Out of v1 because it changes what the Agent Mode roster
  shows.
- **Desktop projection of `cause`.** Additive `cause?` on
  `TaskSnapshotItem` and `AgentModeWorkerItem`, projected in
  `app/sidecar/tasksDomain.ts:134` and `agentModeDomain.ts:266-302`, so the
  renderer can label an interrupted worker without a new status. Needs the
  `protocol.ts` care-rule steps.
- **SIGKILL detection window.** With no terminal row, restore reports
  `parent-exit` and `lastActivityAt` from the transcript tail. There is no
  way to tell "died 2 s after spawning" from "died after an hour of work"
  except that timestamp; the reminder prints it and leaves the judgement to
  the model.
- **Worktree dirtiness in the reminder** (§7 example) requires a `git
  status` per interrupted worker at restore. Bounded by the number of
  undelivered workers, which is small, but it is a process spawn on the
  resume path; drop the line if it measurably slows `--resume`.
