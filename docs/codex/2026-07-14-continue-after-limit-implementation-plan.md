# Continue After Limit — Codex-Only Implementation Plan

Date: 2026-07-15
Status: READY FOR IMPLEMENTATION — technical and user-facing contracts fixed in this revision
Scope: terminal engine, main session, Codex/OpenAI only

## Mission

Add a manual `/continue-after-limit` command that records a user-authorized continuation for the current main session after the Codex account pool reaches a real usage limit. Cat Code should resume the same transcript after the known reset and append one new continuation turn rather than blindly replaying the failed request.

The durability contract depends on the user's explicit background choice:

- Background off: run at or after the known reset while this conversation is open; otherwise remain pending until this same conversation is resumed.
- Background on: run shortly after the known reset if the Mac is awake; if it is asleep, logged out, rebooting, or powered off, run once after the next wake/login.

No local implementation can execute while the computer is powered off. This feature must preserve work and resume later rather than trying to prevent shutdown.

## Revision basis

ChatGPT review `Helpmepeet/cat-code#12` was created from `main`, while this plan targets the current `migration` branch. Its blocker claiming that `src/services/api/codexStatus.ts` does not exist is therefore false for the target branch. Current source confirms that `buildCodexStatus()` exists and owns the aggregate Codex action decision.

The review still exposed a real adjacent gap: status aggregation can treat a positive usage reset as known without proving that it is fresh relative to a hard cap. This revision keeps the existing Codex status owner, adds that missing freshness contract, and adopts the review's source-valid findings about interrupted-turn replay, resume context, single-writer ownership, LaunchAgent lifecycle, and transcript-path trust.

A final source review on 2026-07-15 found four additional blockers: terminal Codex quota evidence was not durable or distinguishable from a generic 429, the pre-provider transcript write was buffered rather than an fsync-backed crash boundary, the live REPL had no UUID-keyed completion/lock handoff, and the lock text conflicted with `proper-lockfile` crash recovery. This revision resolves all four with the contracts below. These are implementation requirements, not choices left to the worker.

A user-perspective review found that the earlier success message did not make the lifecycle sufficiently transparent. This revision also fixes the user-facing state model and baseline copy: users are told when continuation will run, what it will submit, that the failed request is not replayed, whether closing Cat Code delays execution, why an automatic action stopped, and what to do next.

An independent UX review then found four remaining contradictions: the immediate-account path falsely mentioned a reset, background-off copy implied that opening any Cat Code session was sufficient, refusal reasons had no exact copy, and terminal states that never retry were labeled “paused.” The transparency contract below resolves those issues, accounts for the background worker's scan latency, and collapses nonrecovering outcomes into one `Stopped — needs you` vocabulary.

## Hard constraints

- Codex/OpenAI only. Add no Anthropic eligibility, reset-detection, recovery, tests, or provider abstraction.
- Main session only. Subagent- and worker-specific continuation are out of scope.
- The user invokes the command manually; a limit error does not arm continuation automatically.
- Never classify authentication, transient transport, ambiguous 429, context-window, max-turn, max-budget, or permission failures as a scheduleable quota reset.
- Never persist tokens, account IDs, aliases, raw provider responses, arbitrary commands, or arbitrary prompts.
- Never replay the failed API request. Tools may already have produced side effects.
- Never automatically resubmit an attempt whose provider-call state is ambiguous after a crash.
- Never approve permissions or elevate the resumed session's permission mode.
- Never let a foreground REPL and background worker write or run turns against the same session concurrently.
- Never trust a persisted transcript path. Derive it from validated session-storage identity at execution time.
- Never install a LaunchAgent without explicit one-time confirmation.
- Never use `pmset`, privileged wake scheduling, or default sleep prevention.
- Do not touch `app/`, the desktop protocol, the sidecar boundary, or migration state for v1.
- Preserve all unrelated changes currently present on the `migration` branch. Do not commit, stash, revert, clean, or write `DONE.md` without separate user authorization.
- Verification must not call live Codex endpoints or install a real LaunchAgent without explicit authorization.

## Current source truth

### Codex limit and reset evidence

`src/services/api/codexStatus.ts:351-495` already owns the machine-readable aggregate action decision:

- `delegate`: a viable account is available;
- `attempt`: the observation is transient or uncertain;
- `wait`: all viable accounts are quota-blocked and a reset is known;
- `recheck`: accounts are quota-blocked but no credible reset is known;
- `human_recovery`: no account or only authentication-blocked accounts remain.

The status is advisory, does not reserve an account, and does not share cap state with the next process. A deferred job may persist a not-before time, but it must not persist or assert that an account is healthy.

`src/services/api/codexAccountPool.ts:1312-1353,1476-1503` protects hard-429 authority when selecting account availability: a reset is credible for a hard cap only when it post-dates the cap. `codexStatus.ts:337-371` currently extracts a positive `usageResetAt` separately and can return `wait` without enforcing the same freshness rule. Before this command consumes `wait`, strengthen the existing status owner so a hard-capped account contributes a known reset only when the reset is fresh relative to `cappedAt`.

Do not add a second quota belief model. Add a closed Codex-only eligibility evaluator that combines:

- a runtime-narrowed terminal assistant failure;
- a refreshed `buildCodexStatus()` result;
- reset evidence whose freshness was established by the status/account owner.

The evaluator returns only:

```ts
type DeferredContinuationEligibility =
  | { action: 'run_now'; observedAt: number }
  | {
      action: 'schedule'
      observedAt: number
      resetAt: number
      notBefore: number
    }
  | {
      action: 'refuse'
      reason:
        | 'not_codex'
        | 'not_terminal_quota'
        | 'observation_uncertain'
        | 'quota_reset_unknown'
        | 'account_recovery'
    }
```

Normalize timestamps once at this evaluator boundary. `CodexStatus` exposes RFC3339 strings, pool usage resets originate as Unix seconds, and `cappedAt` is epoch milliseconds; every numeric timestamp in the eligibility result and persisted job is epoch milliseconds.

Only a terminal typed Codex quota outcome plus a credible post-cap reset may return `schedule`. Generic 429s, rendered error text, authentication failures, transport failures, malformed `unknown` details, and stale process-local cap observations fail closed.

The typed terminal outcome does not exist durably in current source: both Codex exhaustion and generic 429s collapse to the assistant error category `rate_limit`, while the richer account diagnostic is sent to a diagnostic sink rather than the transcript. Fix that at the existing retry decision, not by parsing assistant copy or reconstructing pool state later.

Add this internal, sanitized envelope to `AssistantMessage` and persist it with the assistant turn:

```ts
type DeferredTerminalFailureV1 = {
  version: 1
  provider: 'openai'
  code:
    | 'quota_exhausted'
    | 'account_recovery'
    | 'transient_network'
    | 'ambiguous_rate_limit'
  observedAt: number
}
```

The terminal branch in `src/services/api/withRetry.ts` that already decides and emits `quota.exhausted`, account recovery, or terminal transport exhaustion mints this envelope once. `src/services/api/errors.ts` carries it onto the terminal assistant API-error message. Account diagnostics and the persisted envelope must be projections of that same typed decision; neither may infer from the other. A 429 that did not pass through the hard-cap/all-accounts-exhausted decision is `ambiguous_rate_limit`, never `quota_exhausted`. The envelope contains no account reference, provider body, rendered text, token, alias, or reset time.

The command accepts only the latest main-chain terminal assistant message with a runtime-valid `DeferredTerminalFailureV1 { provider: 'openai', code: 'quota_exhausted' }`. Because the envelope is part of the transcript, this remains checkable after a process restart. `buildCodexStatus()` remains the sole reset-time source.

### Session resume

The real resume path is already present:

- CLI flag dispatch: `src/main.tsx`
- transcript recovery: `src/utils/conversationRecovery.ts:469-615`
- process/session restoration: `src/utils/sessionRestore.ts:493-649`
- headless resume: `src/cli/print.ts:4913-5258`

The headless path calls `recordTranscript()` before API execution at `src/QueryEngine.ts:456-483`, but that function currently places local writes on a delayed queue; it calls `flushSessionStorage()` only under unrelated environment flags. The interactive REPL writes through `useLogMessages`, so it also lacks a pre-provider durable boundary. Ordinary behavior remains unchanged, but deferred attempts require the explicit durability seam defined below. The continuation runner must still enter through the real query paths rather than reconstructing QueryEngine context itself.

Two current resume behaviors must be corrected for this feature:

- `src/cli/print.ts:1182-1205` can replay the interrupted prompt when `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` is set. The deferred runner needs a private internal option that suppresses only that enqueue branch; ordinary print recovery remains unchanged.
- interactive resume restores worktree/cwd and lifecycle context more completely than `src/cli/print.ts:5053-5203`. The deferred path must restore trusted cwd/worktree context before project instructions, settings, skills, and tools are loaded.

### Existing scheduled tasks are not the right store

Project cron tasks live in `.cat-code/scheduled_tasks.json` through `src/utils/cronTasks.ts`. They cannot own this feature because:

- storage is project-scoped rather than session-owned;
- one-shot tasks use minute-resolution cron expressions;
- one-shot jitter can fire before the wall-clock mark;
- missed one-shots are removed and surfaced for user confirmation;
- execution belongs to whichever live process owns the project scheduler lock;
- the scheduler is process-local and its timers are unreferenced.

Relevant behavior is in:

- `src/utils/cronTasks.ts:1-10,30-82,421-457`
- `src/utils/cronScheduler.ts:179-227,245-344,456-459`
- `src/utils/cronTasksLock.ts:100-172`

This feature needs a dedicated user-private queue. Reuse existing lock and session primitives, not cron semantics.

## Product behavior

### Command surface

```text
/continue-after-limit
/continue-after-limit status
/continue-after-limit cancel
/continue-after-limit enable-background
/continue-after-limit disable-background
```

### Default invocation

`/continue-after-limit` performs these steps:

1. Require an idle main session.
2. Resolve the active model through the existing model-to-provider route and require Codex/OpenAI.
3. Runtime-narrow the latest main-thread assistant API error into the closed terminal-failure classification; malformed `unknown` fields refuse scheduling.
4. Call `buildCodexStatus({ refresh: 'auto' })` and require the strengthened reset-freshness contract.
5. Build the typed `DeferredContinuationEligibility` result and apply the decision table below.
6. If a pending job already exists for this session, return its status without creating another.
7. Otherwise persist one pending job and print the local scheduled time; when background mode is on, also disclose the periodic scan latency.

| Codex status decision | Command behavior |
|---|---|
| `wait` with a credible post-cap `not_before` | Schedule at `not_before + 60 seconds`. |
| `delegate` after the terminal quota failure | Enqueue the continuation immediately because a viable account exists. |
| `attempt` | Refuse scheduling; this is an uncertain/transient observation, not a known reset. |
| `recheck` | Refuse scheduling because no credible reset time exists. |
| `human_recovery` | Refuse and show the sanitized account/auth recovery reason. |

The latest turn must carry the valid terminal `quota_exhausted` envelope. A generic `rate_limit` assistant category or a `wait` observation alone is insufficient to turn this command into a generic scheduler.

### User-facing transparency contract

The feature must explain its behavior in user language at every state change. A technically correct queue state is not sufficient if the user cannot tell what will happen next.

Hard UX rules:

- Never imply that Cat Code will replay the failed request. Every schedule and status result says that it will add a new reconciliation message instead.
- Always show the scheduled time in local time with timezone and a relative duration, for example `Jul 15, 4:31 PM ICT (in 2h 14m)`.
- When background mode is on, disclose that the periodic worker normally starts within about one scan interval after the displayed time, but operating-system scheduling can delay it longer. Do not imply minute-exact background execution.
- Always show whether background continuation is on or off and what closing this conversation, opening a different conversation, sleep, shutdown, wake, and login mean for that mode.
- Never expose internal enum names such as `pending`, `submitted`, `ambiguous`, or `needs_attention`, nor job IDs, attempt UUIDs, queue paths, raw provider errors, or account identifiers.
- Every automatic cancellation, start, delay, completion, reschedule, or safety stop produces a visible system notice. A result produced while no REPL is open is persisted and shown when the original conversation is next resumed; it is marked shown so it does not repeat on every resume.
- `/continue-after-limit status` is read-only and uses the same user-facing state mapping and copy as automatic notices.
- Refusals state what evidence is missing or what the user can do next. They do not reduce every failure to “cannot schedule.”
- User-visible job state uses only `Scheduled`, `Running`, `Done`, `Canceled`, and `Stopped — needs you`, plus the absence state `No continuation scheduled`. A delay or reschedule remains `Scheduled`; every terminal non-success that cannot retry automatically is `Stopped — needs you` with one sanitized reason and one next action.

When a genuine typed terminal Codex quota failure is written, the assistant error ends with a hint, but does not arm anything automatically:

```text
Codex usage limit reached.

Run /continue-after-limit to continue this conversation after the reset.
```

Render this hint at most once for the same persisted terminal failure; transcript rerenders and session resume must not duplicate it.

Command-time refusals use exact, non-jargon copy:

| Eligibility refusal | Required copy |
|---|---|
| `not_codex` | `This command only works in a Codex/OpenAI conversation. This conversation is not using a Codex model, so nothing was scheduled.` |
| `not_terminal_quota` | `Cat Code did not confirm that the last failure was a Codex usage limit, so nothing was scheduled. Review the latest error and continue manually when it is safe.` |
| `observation_uncertain` | `Cat Code cannot confirm a Codex usage limit right now, so nothing was scheduled. Review the latest transcript and try again manually when it is safe.` |
| `quota_reset_unknown` | `The Codex usage limit is confirmed, but Cat Code cannot find a trustworthy reset time, so nothing was scheduled. Run /accounts to check Codex status, then try /continue-after-limit again when a reset time is available.` |
| `account_recovery` | `Cat Code cannot schedule continuation because Codex account access needs attention. Run /login or /accounts, then continue this conversation manually.` |

When background continuation is off, successful scheduling prints:

```text
Continuation scheduled for Jul 15, 4:31 PM ICT (in 2h 14m).

What will happen:
- Cat Code will add a new “continue and reconcile” message to this conversation.
- It will not resend your failed request.
- Sending another message before then will cancel this schedule.
- Viewing or resuming this conversation without sending a message is safe.

Background continuation: OFF
This conversation must be open to continue. If it is closed at the scheduled
time, continuation waits until you reopen and resume this conversation.
Opening Cat Code in a different conversation will not start it.

Enable continuation after closing the terminal:
/continue-after-limit enable-background

Cancel:
/continue-after-limit cancel
```

When background continuation is on, replace the background paragraph with:

```text
Background continuation: ON
Cat Code will continue on its own after the scheduled time, even after this
terminal closes, as long as the Mac is on. Background checks run once a minute,
so it normally starts within about one minute after the displayed time, though
system scheduling can delay it longer. If the Mac is asleep, logged out, shut
down, or powered off, it continues after wake or login.
```

When a viable alternate Codex account is available, do not present a future schedule:

```text
A usable Codex account is available, so continuation will start now.

Cat Code will add a new reconciliation message. It will not resend the
failed request.
```

First-time background enablement requires this explicit confirmation:

```text
Allow Cat Code to run scheduled continuations after this terminal closes?

This installs a user-level macOS background job. It runs only Cat Code's
fixed continuation worker and does not store prompts or credentials.

[Enable background continuation] [Cancel]
```

After confirmation, show the installed executable path in a user-readable form, explain that moving or deleting that executable disables background continuation, and show `/continue-after-limit disable-background` as the removal command.

Successful background configuration and explicit cancellation use fixed acknowledgements:

```text
Background continuation enabled. Scheduled continuations can run after their
terminals close while the Mac is on, or after the next wake or login.
```

```text
Background continuation disabled. Scheduled continuations now wait until their
original conversations are open.
```

No-op configuration is explicit: `Background continuation is already enabled.` or `Background continuation is already disabled.` An enabled-but-invalid executable is never reported as already enabled; it uses the repair state.

```text
Scheduled continuation canceled.
```

If no job exists, `/continue-after-limit cancel` prints:

```text
Nothing to cancel — no continuation is scheduled for this conversation.
```

If neither an active job nor relevant terminal history exists, `/continue-after-limit status` prints:

```text
Status: No continuation scheduled
You can schedule one after a confirmed Codex usage-limit failure.
```

If an attempt is already running, cancellation refuses safely:

```text
Continuation is already running and cannot be canceled safely. Wait for it to
finish, then check /continue-after-limit status.
```

`/continue-after-limit status` uses this shape for a scheduled job:

```text
Status: Scheduled
When: Jul 15, 4:31 PM ICT (in 2h 14m)
Background continuation: Enabled
Timing: Normally within about one minute after the scheduled time; system
        scheduling can delay it longer
Action: Add a new reconciliation message; do not replay the failed request
Cancel: /continue-after-limit cancel
```

When background mode is disabled, replace the background/timing lines with:

```text
Background continuation: Disabled
Requirement: Resume this conversation; opening another conversation will not
             start it
```

All nonrecovering failures use this status shape rather than separate “paused,” “attention,” or “not rescheduled” states:

```text
Status: Stopped — needs you
Reason: <one sanitized user-facing reason>
Next: <one concrete recovery action>
Automatic retry: Off
```

The user-facing state mapping is fixed:

| Internal condition | User-facing label or notice | Required explanation/action |
|---|---|---|
| No job exists | `Status: No continuation scheduled` | Explain that `/continue-after-limit` only works after a genuine Codex usage-limit failure. |
| Future job | `Status: Scheduled` | Show local time, relative time, background mode, no-replay action, and cancel command. |
| Due attempt or alternate-account attempt starting | `Status: Running` and `Continuing now…` | Emit before the correct fixed continuation-message variant; the transcript explains whether a reset elapsed or an account became available. |
| This conversation was closed with background off | `Continuation was waiting because this conversation was closed. Continuing now…` | Emit when this exact session is resumed before execution; merely opening another conversation leaves it scheduled. |
| New human message before submission | `Scheduled continuation canceled because you sent a new message.` | Cancel first, then submit the human message. |
| Attempt already owns the session | `A scheduled continuation is already in progress. Wait for it to finish, then send your message again.` | Do not queue or append the human message. |
| Bounded network retry | `Status: Scheduled` and `Continuation could not connect. Retrying at <local time> (retry <n> of 3).` | Show the next local retry time; do not call it another usage reset. |
| New credible quota reset | `Codex is still usage-limited. Continuation rescheduled.` | Show the newer reset-derived local time and background behavior. |
| Completed | `Status: Done` and `Scheduled continuation completed at <local time>.` | Preserve the visible fixed continuation turn and terminal result in the transcript. |
| Explicit or human-message cancellation | `Status: Canceled` | State whether the command or a new human message canceled it. |
| Authentication/account recovery | `Status: Stopped — needs you` | Say account access needs attention, that it will not retry, and direct the user to `/login` or `/accounts` before manual continuation. |
| Permission is required or cannot be restored safely | `Status: Stopped — needs you` | Say permission is required, that it will not retry, and direct the user to resume this conversation manually. |
| Context, max-turn, max-budget, session restoration, transcript durability, explicit interruption, or unknown terminal outcome | `Status: Stopped — needs you` | Give one sanitized specific reason, say it will not retry, and direct the user to continue this conversation manually. |
| Fourth terminal network failure | `Status: Stopped — needs you` | Use the exact network-exhaustion copy below. |
| No trustworthy newer reset exists | `Status: Stopped — needs you` | Say a reliable continuation time is unavailable, that it will not retry, and direct the user to `/accounts` or manual continuation. |
| Crash leaves provider/tool execution uncertain | `Status: Stopped — needs you` | Use the stronger safety-stop copy below and never retry automatically. |
| Background executable moved or missing | Keep the job state unchanged; show `Background continuation: Needs repair` | Show the validated configured executable path and explicit repair/disable actions. Do not misrepresent a configuration problem as a job outcome. |

Required stopped-state copy includes:

```text
Automatic continuation stopped — your Codex account needs attention, so it
will not retry on its own. Run /login or /accounts, then continue this
conversation manually.
```

```text
Automatic continuation stopped — this step needs your permission. Reopen this
conversation and continue manually so you can approve it.
```

```text
Automatic continuation stopped after repeated network failures. It will not
keep retrying on its own. Check your connection, then continue this
conversation manually.
```

The crash-uncertain notice is exact:

```text
Automatic continuation stopped — needs you.

Cat Code may have started the continuation before it closed. It will not
retry automatically because that could repeat tool actions.

Review the latest transcript and continue manually.
```

These messages are the baseline product copy. Implementation may adapt line wrapping and interactive controls, but not omit or weaken the disclosures.

### Continuation turn

Do not resubmit the interrupted user request or the failed provider payload. Select one of two visible, fixed continuation turns from the typed eligibility/attempt cause; neither variant is user-customizable.

After waiting for a credible reset, append:

```text
Automated continuation requested through /continue-after-limit.

The Codex usage limit should now have reset. Continue the previous task, but
first reconcile the current transcript and filesystem state. Do not repeat
work or side effects that already completed.
```

Use “should now have reset,” not “has reset,” because reset observations are advisory.

When `DeferredContinuationEligibility.action === 'run_now'` because a viable alternate account is available, append instead:

```text
Automated continuation requested through /continue-after-limit.

A usable Codex account is now available. Continue the previous task, but first
reconcile the current transcript and filesystem state. Do not repeat work or
side effects that already completed.
```

The immediate variant must never claim that a limit reset occurred. If an immediate attempt later reaches another real quota reset and is rescheduled, its next attempt uses the reset-elapsed variant.

The queued input must use:

- `skipSlashCommands: true`;
- `isMeta: false`;
- `priority: 'later'`;
- the persisted attempt UUID as `QueuedCommand.uuid`;
- `origin: { kind: 'deferred-continuation', jobId, attemptUuid }`.

Extend the closed `MessageOrigin` union with that internal origin and stamp it onto the resulting user message. The origin is provenance and completion correlation, not authority: the runner must already hold the matching job and session locks, and the job record must contain the same attempt UUID. `QueuedCommand` already carries a UUID at `src/types/textInputTypes.ts:299-358`. Reusing the UUID after a crash lets transcript persistence deduplicate one attempt. A later retry after a newly observed quota reset mints a new attempt UUID.

The command descriptor sets `disableModelInvocation: true` but does not use static `availability: ['openai']`: command availability follows the saved session provider, while this repository routes each request by model string. The invocation-time model-to-provider check is authoritative. No model, skill, bridge client, scheduled task, or remote message may invoke the command on the user's behalf.

### Manual activity invalidates the schedule

If the user submits a new human prompt in the same session before the job fires, acquire the job lock, atomically cancel the pending continuation, emit `Scheduled continuation canceled because you sent a new message.`, and only then submit the human prompt. This prevents an old “continue” turn from firing after the user has changed the session's direction without making the cancellation invisible.

If the background or foreground continuation already holds the job/session locks, do not submit human input concurrently. Show `A scheduled continuation is already in progress. Wait for it to finish, then send your message again.` If crash reconciliation marks the attempt `ambiguous`, show the exact safety-stop notice instead of silently canceling or retrying it.

Merely reopening/resuming the transcript without sending new input does not cancel the job. Resume/adopt must still respect the per-session lock so it cannot read and adopt the transcript while a background attempt is appending it.

## Dedicated persistence

### Location

```text
~/.cat-code/deferred-continuations/
  pending/
    <session-id>.json
  history/
    <job-id>.json
  locks/
  tmp/
```

One pending filename per session enforces the one-job-per-session rule without a second index.

Keep lock and temporary files outside `pending/` so each one-shot scan enumerates only real job records.

### Job schema

```ts
type DeferredContinuationJobV1 = {
  version: 1
  jobId: string
  sessionId: string
  projectStorageKey: string
  context: {
    cwd: string
    worktreeRoot?: string
    model: string
    effort?: EffortValue
    permissionMode: PermissionMode
  }
  createdAt: number
  statusObservedAt: number
  scheduleReason: 'account_available' | 'hard_quota_reset'
  resetAt?: number
  notBefore: number
  state: 'pending' | 'submitted' | 'ambiguous'
  attempt: {
    number: number
    messageUuid: string
    submittedAt?: number
  }
  transientRetries: number
}
```

The record intentionally omits a provider field because the feature is Codex-only. It also omits prompt text and transcript path: the runner selects one of the two fixed continuation variants from typed attempt cause in source and derives the transcript from `projectStorageKey + sessionId`.

`projectStorageKey` is the validated private session-storage directory identity captured from the live session, not a user-supplied path. `cwd` and `worktreeRoot` are canonical runtime context that must be revalidated against the transcript/session metadata before bootstrap. The schema refines these invariants:

- all numeric timestamps are finite epoch milliseconds;
- `hard_quota_reset` requires a finite `resetAt` whose post-cap credibility was established before persistence;
- `account_available` omits `resetAt` and is immediately due;
- `submittedAt` exists only in `submitted` or `ambiguous`;
- permission mode is a known closed value and never includes persisted temporary grants or approval rules.

Terminal records move atomically to `history/` with one of:

```ts
type DeferredContinuationTerminalState =
  | 'completed'
  | 'canceled'
  | 'needs_attention'
```

Store only a sanitized reason code, never a raw error body.

### Persistence requirements

- Strict Zod schema; reject unknown or malformed records.
- Queue directory mode `0700`; files mode `0600`.
- Use `src/utils/lockfile.ts` for authoritative per-job and per-session filesystem locks. Hold both locks for the full attempt.
- Acquire locks in one global order: job lock, then session lock. Foreground and background paths must never reverse it.
- There is no queue-global lock. Scanners may select the same candidate, but a zero-retry per-job lock acquisition chooses the sole owner before any state change. This keeps the only global order `job -> session`.
- Use explicit shared `proper-lockfile` options for both lock kinds: `realpath: false`, bounded `stale` and `update` heartbeat values, zero acquisition retries in scanners, and an `onCompromised` handler that aborts the local attempt and forbids further state transitions. The exact constants live in one module and are covered by fake-time/process probes.
- A background scanner never reclaims a stale lock on its first observation. It records the lock directory's validated inode/mtime identity under `tmp/` and exits; reclamation is eligible only when a later one-shot scan, at least one scan interval later, sees the same unchanged stale identity. A foreground owner waking from sleep therefore gets an event-loop turn to refresh its heartbeat before any worker can reclaim. Changed, missing, malformed, or newly-created lock identity restarts the observation. This observation grants no write authority; the later `proper-lockfile` acquisition still does that.
- The prohibition is on a PID, deadline, owner token, or lease stored in the job schema and treated as authority. `proper-lockfile`'s own heartbeat/stale protocol is the crash-reclamation mechanism. `concurrentSessions`/PID liveness may be used only as a conservative reason to delay reclamation, never as permission to acquire or write.
- Temp-file write, file `fsync`, atomic rename, then parent-directory `fsync` for every job create/update/history move. A failed durability step is a failed transition.
- Validate UUIDs, finite timestamps, model, effort, and state transitions.
- Derive the transcript from the validated private storage root, `projectStorageKey`, and `sessionId`; never execute or open a transcript path supplied by the record.
- Reject symlinked queue, lock, project-storage, and transcript components. Require expected ownership, restrictive modes, and regular-file type.
- Revalidate containment at the open boundary. Use no-follow open semantics where available, then compare `fstat` identity with the validated file so a path swap cannot redirect the read.
- Treat `src/utils/concurrentSessions.ts` as advisory display data only. PID liveness and application-recorded `startedAt` do not prove process identity or writer ownership.
- Retain terminal history for a bounded period, then clean it during normal queue startup.

### Durable transcript boundary

Add a private `flushCurrentTranscriptDurably()` seam in `src/utils/sessionStorage.ts`. It accepts no path. It drains the existing write queue, derives and opens the current transcript through trusted session state, calls `FileHandle.sync()`, and syncs the parent directory when the transcript was newly materialized. Merely awaiting `recordTranscript()` or the current `flushSessionStorage()` is not this boundary.

After the runner receives a typed terminal outcome, append a dedicated sanitized transcript entry before changing the job:

```ts
type DeferredContinuationResultEntryV1 = {
  type: 'deferred-continuation-result'
  version: 1
  sessionId: string
  attemptUuid: string
  outcome:
    | 'completed'
    | 'quota_exhausted'
    | 'account_recovery'
    | 'transient_network'
    | 'ambiguous_rate_limit'
    | 'permission_required'
    | 'context_window'
    | 'max_turns'
    | 'max_budget'
    | 'session_restore'
    | 'aborted'
    | 'unknown'
  observedAt: number
}
```

This entry contains no text, error body, account data, prompt, reset time, or path. It is the durable terminal descendant for reconciliation even when the headless SDK result (for example max-turn or max-budget) has no transcript assistant message. It is accepted only from the internal runner while it owns the matching locks and is keyed directly to the persisted attempt UUID.

Every deferred attempt uses this ordering while both locks are held:

1. Durably write job state `submitted` with its attempt UUID.
2. Append the fixed user message with that UUID.
3. Call `flushCurrentTranscriptDurably()` and verify that the durable transcript contains the UUID.
4. Only then allow the first provider request.
5. Append `DeferredContinuationResultEntryV1`, then call `flushCurrentTranscriptDurably()` again.
6. Only then durably move the job to history or durably reschedule it.

The headless path gets a private QueryEngine/print option carrying the expected deferred attempt UUID; immediately after its existing pre-provider `recordTranscript()` call it executes the durable barrier. The live REPL recognizes the validated `deferred-continuation` origin and performs the same `recordTranscript()` plus durable barrier after adding the user message but before entering `query()`. Normal human and SDK turns keep their existing persistence behavior.

If the pre-provider barrier fails, no provider call is allowed and the job becomes `needs_attention: transcript_persistence`. If the terminal barrier or terminal job transition fails, leave the durable job at `submitted`; startup reconciliation, not an in-process guess, decides its next state.

## State machine

```text
pending
  -> submitted        after both locks are held, before QueryEngine receives input

submitted
  -> completed
  -> pending          newer credible quota reset; mint a new attempt UUID
  -> pending          bounded transient retry; mint a new attempt UUID
  -> needs_attention  auth, permission, context, unknown reset, bad session
  -> ambiguous        attempt UUID persisted but no terminal outcome after crash

pending
  -> canceled

ambiguous
  -> canceled         explicit user action after manual reconciliation
```

### Crash reconciliation

`submitted` plus the fsync-backed transcript barrier is the durable crash boundary, not a claim or lease. On startup:

1. If the transcript does not contain the attempt's user-message UUID, the durable pre-provider barrier did not complete, so the provider gate could not open. Return the same attempt to `pending`.
2. If the UUID and a valid matching `deferred-continuation-result` entry are present, classify that durable result and complete, reschedule, or stop for attention.
3. If the UUID is present without a terminal descendant, transition to `ambiguous`. Never call the provider automatically again.

This deliberately prefers a manual recovery over duplicate tools or external side effects. UUID deduplication in `src/utils/sessionStorage.ts:1532-1577` prevents a duplicate transcript entry, but it is not provider-call idempotency. The private provider gate and fsync-backed barrier—not UUID reuse alone—make the absence test safe.

### Attempt result policy

| Attempt outcome | Transition |
|---|---|
| Successful terminal assistant result | `completed` |
| `quota.exhausted` plus a newer known reset | Update reset/not-before, mint next attempt UUID, return to `pending` |
| `quota.exhausted` with no reset | `needs_attention: quota_reset_unknown` |
| Authentication or no usable account | `needs_attention: account_recovery` |
| Interactive permission required | `needs_attention: permission_required` |
| Context window, max turns, max budget | `needs_attention` with the exact typed reason |
| Terminal transient network failure | Retry after 1, 5, then 15 minutes |
| Fourth transient failure | `needs_attention: network` |
| Missing transcript, cwd, worktree, or model | `needs_attention: session_restore` |
| Pre-provider transcript durability failure | No provider call; `needs_attention: transcript_persistence` |
| Explicit abort after the provider gate opened | `needs_attention: interrupted`; never automatic retry |
| Unknown or malformed terminal outcome | `needs_attention: unknown` |
| Attempt UUID present without terminal outcome after crash | `ambiguous`; never retry automatically |

Existing request retries remain authoritative within each attempt. The queue's transient retry is only for a terminal attempt after the normal request retry policy has stopped.

## Live REPL execution

Add a hook modeled after `src/hooks/useScheduledTasks.ts:32-122`.

The foreground path uses a UUID-keyed in-process registry owned by `deferredContinuationRunner.ts`; it does not add a second persistence or state-machine owner. `beginForegroundDeferredAttempt()` registers exactly one waiter for the job/attempt UUID while the runner retains both filesystem-lock release functions. It returns the fixed `QueuedCommand` plus a promise that resolves only from the REPL query lifecycle. Duplicate registration or an origin/job/UUID mismatch fails closed.

The hook should:

1. Discover the pending job for the current session.
2. Recompute from epoch time after wake or a system-clock change.
3. Wait until `notBefore` without keeping the process alive solely for the timer.
4. Acquire the job lock and then the per-session execution lock.
5. Re-read the job under lock, validate that it is still due, and durably mark the attempt `submitted`.
6. Register the UUID-keyed foreground waiter and enqueue the fixed continuation with its deferred origin.
7. Await the waiter without blocking React rendering; the runner, not the hook effect, continues to own both locks.
8. Durably classify/transition the job and only then release the session and job locks.

`REPL.tsx` performs three explicit integrations:

1. Before `query()` starts, a user message with a validated deferred origin must pass the durable transcript/provider gate. A normal queued command cannot opt into this by UUID or origin alone; the live registry and locked job must match.
2. `onQueryEvent` forwards raw terminal assistant failure evidence for that UUID to the registry before UI projection discards context.
3. The `onQuery` `finally` path settles the registry exactly once with the final message slice, abort/throw state, and permission outcome. It settles on success, API error, denial, abort, and exception. The runner then applies the shared result policy and durable terminal ordering.

Unmount, `/resume`, or process shutdown cannot simply drop a registered waiter. Resume/adopt is blocked by the session lock; an in-process abort without a durable terminal descendant leaves `submitted` for startup reconciliation. No React state or callback is treated as durable evidence.

The hook and background scanner use the same runner and locks. The foreground timer normally wins while the REPL is active, keeping output and permission prompts visible in the original terminal. Correctness must not depend on that preference: if the background worker wins the lock race, the REPL observes the submitted state and must not start a second turn.

## Background takeover

### Hidden worker entry point

Add a fixed hidden CLI entry point:

```text
cat-code deferred-continuation-worker
```

It accepts no prompt, command, account, model, transcript path, cwd, or job ID from CLI arguments. One invocation scans the validated queue, attempts at most one due job, and exits.

Do not launch a nested public `cat-code -p --resume <path>` process. The hidden entry point must dispatch before normal project bootstrap so the shared runner can:

1. scan validated due records in deterministic order and acquire one record's zero-retry job lock; there is no queue lock;
2. acquire that record's session execution lock;
3. derive and securely open the transcript from `projectStorageKey + sessionId`;
4. validate the saved canonical cwd/worktree identity against session metadata;
5. restore/chdir to that context before project instructions, settings, skills, and tools load;
6. restore the captured model and effort;
7. reconstruct a permission context that is equal to or stricter than the captured mode, without temporary approvals;
8. invoke the real internal headless resume/query path with the fixed continuation and persisted UUID;
9. classify the terminal result and durably transition the record.

Add a private headless option such as `suppressInterruptedTurnReplay: true` and check it at `src/cli/print.ts:1182-1205`. The worker also removes `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` from its behavior environment before bootstrap as defense in depth. Do not disable normal interruption recovery for public print mode.

The runner classifies typed structured outcomes:

- the persisted `DeferredTerminalFailureV1` envelope, with account diagnostics used only as a consistency assertion;
- final result subtype and `is_error`;
- permission denials;
- authentication/account diagnostics;
- max-turn, budget, and other terminal result types.

If the attempt remains quota-blocked, obtain a fresh advisory reset through the strengthened Codex status builder. Never retry-hammer when no newer credible reset is known.

### macOS LaunchAgent

Install a dedicated user LaunchAgent only after explicit confirmation.

Recommended shape:

- label: `com.cat-code.deferred-continuation`;
- canonical, stable Cat Code executable path captured by the installer;
- fixed `deferred-continuation-worker` argument;
- `RunAtLoad`: reconcile pending jobs after login;
- `StartInterval: 60`: run a bounded one-shot scan and exit;
- no model output in launchd stdout/stderr logs;
- no `QueueDirectories`, `KeepAlive`, shell command string, or resident sleeper.

`QueueDirectories` is intentionally rejected: a future job keeps the directory nonempty, forcing either a resident worker or an immediate relaunch loop when the scanner exits. The periodic one-shot design accepts up to one scan interval of latency in exchange for bounded process lifetime and simple wake/login recovery.

Background enablement must refuse a transient development executable or another path that cannot be expected to survive restart. `/continue-after-limit status` validates that the installed absolute path still identifies an executable. If an update moves it, background mode reports `needs repair`; rerunning `enable-background` atomically rewrites and reloads the plist. A stale path is never resolved through a shell or untrusted `PATH`.

Do not overload `src/commands/install-agents/install-agents.ts`. That command currently owns unrelated Codex token-refresh agents and stale historical labels. Keep continuation installation and removal behind `/continue-after-limit enable-background|disable-background`.

### Computer lifecycle contract

| Event | Behavior |
|---|---|
| REPL remains open | The in-process hook submits at or after `notBefore`. |
| Terminal closes normally; background on | The next LaunchAgent scan takes over the persisted job, normally within one scan interval; operating-system scheduling can delay it longer. |
| Terminal closes normally; background off | The job remains pending until this exact conversation is resumed. Opening Cat Code in a different conversation does not execute it. |
| REPL crashes; background on | Filesystem locks become reclaimable; the next scan reconciles durable attempt state. |
| REPL crashes; background off | Durable state remains pending or is reconciled when this exact conversation is next resumed. |
| Mac sleeps or lid closes | Nothing runs during sleep. After wake, an open original conversation runs through its hook; otherwise background mode must be on for a scan to take over. |
| User logs out | User LaunchAgent stops. With background on, `RunAtLoad` reconciles after login; with it off, the job waits for the original conversation. |
| Reboot or power loss | Flushed queue/transcript state survives. With background on, work resumes after login; with it off, it waits for the original conversation. |
| Mac remains powered off | No execution is possible. |
| Network is unavailable after wake | Apply the bounded transient retry policy. |

No local guarantee may claim exact execution while asleep or powered off. That would require an always-on remote host and is outside this feature.

## Concurrency and idempotency

`src/utils/sessionStorage.ts:848-985` serializes writes only inside one process. `src/utils/concurrentSessions.ts:49-204` records PID metadata and probes `process.kill(pid, 0)`; it does not prove OS process identity, prevent PID reuse, or lock a transcript.

Use two `proper-lockfile`-backed authorities:

- a per-job lock serializes scheduling, cancellation, crash reconciliation, and terminal moves;
- a per-session execution lock prevents concurrent transcript load/write and provider turns for that session.

Hold both for the entire continuation attempt. Every continuation-aware entry path follows the same job-then-session lock order:

- foreground due-time hook;
- background worker;
- human prompt cancellation when a job exists;
- resume/adopt of a session with a nonterminal job.

If a human prompt races an attempt that already holds the locks, fail visibly and let the user retry after the attempt ends. Do not cancel a submitted provider turn or append concurrently.

Crash ordering is:

1. Persist the attempt UUID while `pending`.
2. Acquire job and session locks.
3. Revalidate the job, transcript, and runtime context.
4. Durably write `submitted` with `submittedAt`.
5. Enter the foreground or headless real query path with the fixed input, deferred origin, and stored UUID.
6. Persist and fsync the user message; verify the UUID; only then open the provider gate.
7. Capture the typed terminal result, persist and fsync its terminal descendant.
8. Durably move to a terminal state or reschedule.
9. Release session and job locks.

A crash after a provider call or tool side effect but before a terminal result is persisted cannot be made exactly-once by this queue. The `submitted`/`ambiguous` recovery rule prevents blind replay; the implementation must not claim perfect exactly-once provider or side-effect semantics.

## Permission and environment behavior

- Capture the current closed permission mode when scheduling and validate it when loading the job.
- Reconstruct the background context through the same real permission builder used by headless startup, with authority equal to or stricter than the captured mode.
- Never persist or restore process-local temporary approvals, permission callbacks, or “always allow” rules from the job.
- If exact safe reconstruction is impossible for the captured mode, stop at `needs_attention: permission_restore`.
- A background permission requirement becomes `needs_attention`; never synthesize approval.
- Restore canonical cwd/worktree before project/user settings, instructions, skills, and tools load.
- Suppress interrupted-turn replay through the private runner option even if the inherited environment requests it.
- Session-only `/env` values are intentionally not persisted. A background continuation depending on them may stop as `needs_attention`; do not serialize possible secrets into the job file.
- If the original REPL remains open, its process-local environment remains available through the foreground path.

## Files

### New production files

- `src/commands/continue-after-limit/index.ts`
  - metadata-only command registration surface.
- `src/commands/continue-after-limit/continue-after-limit.tsx`
  - schedule/status/cancel, the fixed user-facing state/copy mapping, and explicit background-enable confirmation UX.
- `src/services/deferredContinuation.ts`
  - strict schema, private path derivation, queue/history I/O, job/session locks, state transitions, persisted one-shot notice bookkeeping, and Codex-only eligibility.
- `src/services/deferredContinuationRunner.ts`
  - shared foreground/background attempt dispatch, trusted runtime restoration, crash reconciliation, result classification, user-facing notice events, and reschedule/terminal policy.
- `src/services/deferredContinuationLaunchAgent.ts`
  - periodic one-shot plist generation, stable-executable validation, and explicit install/uninstall.
- `src/hooks/useDeferredContinuation.ts`
  - thin live-session timer and runner invocation.

The hidden worker dispatch stays in `src/main.tsx` and calls the shared runner; it does not get a parallel behavior owner. Add colocated tests for each behavior-bearing module. Do not create separate documentation or helper modules unless implementation proves they are necessary.

### Existing files to modify

- `src/commands.ts`
  - register `/continue-after-limit`.
- `src/main.tsx`
  - dispatch the hidden one-shot worker before project bootstrap and thread trusted runner options.
- `src/cli/print.ts`
  - add private deferred-runner options that suppress interrupted-turn replay and carry the expected durable attempt UUID/provider gate.
- `src/QueryEngine.ts`
  - enforce the private deferred pre-provider durability gate and expose the raw typed terminal outcome to the internal runner without widening the public CLI surface.
- `src/services/api/withRetry.ts`
  - mint the sanitized terminal failure envelope at the existing terminal account/retry decision.
- `src/services/api/errors.ts`
  - carry the envelope onto the terminal assistant API-error message and add the manual-command hint only for typed terminal quota exhaustion; generic 429 remains ambiguous.
- `src/types/message.ts`
  - add `DeferredTerminalFailureV1`, the optional assistant field, and the closed deferred-continuation message origin.
- `src/types/textInputTypes.ts`
  - carry the closed deferred origin through `QueuedCommand`; add no arbitrary callback or public command field.
- `src/types/logs.ts`
  - add the sanitized `DeferredContinuationResultEntryV1` transcript-entry variant used for durable crash reconciliation.
- `src/services/api/codexStatus.ts`
  - enforce hard-cap reset freshness in the existing aggregate status owner.
- `src/services/api/codexStatus.test.ts`
  - add the cross-module stale-reset regression and closed decision cases.
- `src/screens/REPL.tsx`
  - mount the live hook, render persisted user-facing continuation notices, enforce the foreground durable provider gate, settle the UUID-keyed runner registry from every query exit, and coordinate resume/adopt with the session execution lock.
- `src/utils/sessionRestore.ts`
  - expose shared trusted cwd/worktree restoration needed before deferred headless bootstrap.
- `src/utils/sessionStorage.ts`
  - derive/open a transcript from validated project-storage identity and session ID without accepting a persisted path, append/validate the sanitized deferred result entry, and add the no-argument fsync-backed current-transcript barrier.
- `src/utils/handlePromptSubmit.ts`
  - atomically cancel pending work before new human input and reject input while an attempt owns the session.
- `docs/maps/config-persistence.md`
  - document the user-global queue and owner module.
- `docs/maps/terminal-ui-state.md`
  - route command and live-REPL execution.
- `docs/maps/codex-core.md`
  - route status/reset evidence and delayed continuation without changing quota authority.

### Files explicitly not changed

- `src/services/claudeAiLimits.ts`
- `src/services/rateLimitMessages.ts`
- `src/utils/cronTasks.ts`
- `src/utils/cronScheduler.ts`
- `src/utils/concurrentSessions.ts`
- `src/services/preventSleep.ts`
- `app/**`
- `scripts/build.ts`, unless implementation later introduces an explicitly approved feature gate

## Implementation sequence

### Slice 1 — Strengthen Codex eligibility

1. Apply the account pool's post-cap reset credibility rule inside the existing `codexStatus.ts` aggregation path.
2. Mint `DeferredTerminalFailureV1` in the existing terminal retry/account decision and carry it onto the persisted assistant turn.
3. Runtime-narrow the latest main-chain assistant envelope into the closed Codex terminal-failure classification.
4. Add the Codex-only `DeferredContinuationEligibility` evaluator without adding a provider abstraction.
5. Test generic 429, hard quota exhaustion, auth, network, malformed envelopes, stale pre-cap reset, fresh post-cap reset, viable alternate account, and missing reset.

Acceptance:

- `buildCodexStatus()` cannot return a scheduleable `wait` from reset evidence older than the hard cap.
- Only a typed terminal Codex quota failure plus fresh status evidence can create a future job.
- Uncertain or malformed evidence fails closed without text parsing.
- The persisted envelope and emitted account diagnostic are produced from one typed terminal decision and contain no account identity or raw provider data.

### Slice 2 — Durable store, secure identity, and locks

1. Add strict job/terminal schemas and private storage paths.
2. Implement fsync-backed atomic create/read/update/cancel/history transitions.
3. Implement whole-attempt per-job and per-session filesystem locks with fixed acquisition order, shared heartbeat/compromise behavior, and two-scan stale-lock observation.
4. Derive transcripts from project-storage identity plus session ID; add containment, no-symlink, ownership, mode, regular-file, and open-boundary checks.
5. Add the no-argument durable transcript barrier.
6. Implement `pending`/`submitted`/`ambiguous` crash reconciliation from fsync-backed transcript UUID evidence.

Acceptance:

- The queue contains no prompt, transcript path, token, account identifier, temporary permission grant, or raw error data.
- Repeated command invocation cannot create duplicate jobs.
- Two processes cannot own one session attempt concurrently.
- A crash with an unresolved persisted attempt UUID never causes automatic provider resubmission.
- A provider stub cannot be reached until the accepted UUID is present after the durable transcript barrier.

### Slice 3 — Shared trusted resume runner

1. Expose the smallest shared cwd/worktree restoration seam used by interactive and deferred headless resume.
2. Dispatch the hidden worker before project bootstrap, restore trusted cwd/worktree first, then load settings, instructions, skills, and tools.
3. Restore model and effort and reconstruct a permission context that cannot be more permissive than the captured mode.
4. Add the private print-runner options that suppress interrupted-turn replay and require the durable accepted-input gate.
5. Enter the real QueryEngine path with the fixed continuation UUID, enforce the pre-provider barrier, and classify the raw typed terminal result.
6. Add process probes covering replay flags, cwd/worktree, instruction loading, model, effort, permission behavior, and crash boundaries.

Acceptance:

- A transcript ending in a failed prompt plus `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` executes only the fixed continuation UUID.
- Background execution uses the captured canonical project/worktree context before instruction discovery.
- Unsafe or inexact permission restoration stops for attention rather than widening authority.
- The runner does not accept a public transcript path or arbitrary prompt.

### Slice 4 — Command and foreground coordination

1. Add the command descriptor and local JSX implementation.
2. Implement the fixed user-facing state/copy mapping, exact schedule/status/cancel behavior, and first-use background confirmation.
3. Set `disableModelInvocation: true`, omit the misleading static provider gate, and enforce runtime model-route validation.
4. Add the thin REPL hook, the two cause-correct fixed continuation variants, and runner-owned UUID waiter registry.
5. Thread the stored attempt UUID and closed deferred origin through the existing command queue.
6. Enforce the foreground pre-provider transcript barrier and settle the registry from every query exit.
7. Add the typed terminal-quota command hint without hinting on generic 429, auth, transport, or other failures.
8. Atomically cancel pending work before new human input and emit the visible cancellation notice.
9. Coordinate resume/adopt and prompt submission with the job/session locks.
10. Durably record the sanitized result entry and pending user-facing notice before updating job state; render an unseen notice once when the original conversation is next resumed.

Acceptance:

- An open REPL executes once at/after the fake reset time.
- The continuation prompt is visible and uses the stored UUID.
- Every schedule and status result shows local time plus timezone, relative time, background mode, close/sleep behavior, the new-reconciliation action, and the no-replay disclosure where applicable.
- User output contains no internal state enum, job ID, UUID, queue path, account identifier, or raw provider error.
- A human prompt cancels a still-pending continuation before submission and shows the cancellation notice.
- Human input after attempt submission is visibly blocked with the fixed retry-later notice rather than appended concurrently.
- Immediate start, delayed start, retry, reschedule, completion, stopped, and crash-uncertain paths use the fixed simplified user-facing mapping.
- A result produced without the original conversation open is visible once when that exact session is next resumed and does not repeat on later resumes.
- Opening Cat Code in a different conversation with background mode off neither starts the job nor changes its scheduled state.
- A forged deferred origin without the matching live registry entry and locked job cannot open the provider gate.

### Slice 5 — Periodic background takeover

1. Add the pre-bootstrap hidden one-shot worker dispatch.
2. Scan and execute at most one due job per invocation through the shared runner.
3. Add bounded result retry/reschedule behavior.
4. Add `RunAtLoad + StartInterval` plist generation and explicit install/uninstall commands.
5. Validate the stable executable path and expose moved-path repair status.
6. Add process probes for empty queue, future job, malformed job, two-worker race, foreground race, owner crash, wake/login-style fresh process, and stale executable.

Acceptance:

- Closing or killing the original REPL leaves one durable job.
- Each scan exits without becoming resident or entering a relaunch loop.
- Exactly one lock owner can submit an attempt.
- A second quota limit reschedules only from newer credible reset evidence.
- Auth, permission, context, network exhaustion, and ambiguous failures become the internal attention state and render uniformly as `Stopped — needs you` with a reason and next action.

### Slice 6 — Documentation and impact sweep

1. Update the three routing maps listed above.
2. Run the Cat Code change-impact checklist.
3. Search imports, commands, docs, configs, tests, schemas, LaunchAgent labels, and generated surfaces for stale or missing references.
4. Do not write `DONE.md` without explicit user approval.

## Verification plan — run only after implementation

The user requested review of this plan before verification. Do not run these checks now.

### New focused tests

- Codex status decision matrix, including stale pre-cap versus fresh post-cap reset.
- Terminal failure envelope minting and transcript round-trip for hard quota, generic 429, auth, transport, and malformed `unknown` evidence.
- Account diagnostic and terminal envelope consistency from the same retry decision.
- Latest-error and model/provider eligibility.
- Unknown, stale, zero, malformed, and already-past reset times.
- One pending job per session.
- Strict schema with no transcript-path field.
- Sanitized deferred-result transcript entry schema, runner-only append authority, attempt-UUID match, and raw-data rejection.
- Session-ID/project-storage derivation and mismatch rejection.
- Direct symlink, parent symlink, path swap, wrong-owner/mode, non-regular-file, and containment rejection.
- Directory/file permissions.
- Fsync-backed atomic write/rename/parent-sync ordering and injected durability failures.
- Pre-provider gate proving the provider stub is unreachable before the accepted UUID is durably readable.
- Terminal descendant durability before completed/rescheduled history transition.
- Atomic read-modify-write contention.
- Two-process per-job and per-session lock races.
- Lock compromise abort behavior and two-scan unchanged-stale-identity reclamation after simulated sleep/wake.
- Manual resume after background lock acquisition.
- Human input after attempt submission.
- Stable attempt UUID and the distinction between transcript deduplication and provider execution.
- Crash before UUID persistence, after UUID persistence, and after terminal result.
- `submitted` recovery to pending, terminal classification, or `ambiguous`.
- Human-input cancellation.
- Foreground fake-clock execution.
- Foreground UUID registry success, API error, permission denial, abort, throw, duplicate settlement, unmount, and forged-origin mismatch.
- User-facing copy/state snapshots for no job, scheduled background off/on, immediate start, delayed start, manual and explicit cancellation, active-attempt blocking, network retry/exhaustion, quota reschedule, completion, auth, permission, context/budget, unknown reset, crash uncertainty, background enable/disable, and background repair.
- Cause-correct fixed continuation-turn snapshots: reset-elapsed wording for scheduled attempts and usable-account wording with no reset claim for immediate alternate-account attempts.
- Exact refusal snapshots for `not_codex`, `not_terminal_quota`, `observation_uncertain`, `quota_reset_unknown`, and `account_recovery`.
- Background-off lifecycle probe: reopening Cat Code in another conversation leaves the job scheduled; resuming the original conversation starts it and emits the delayed-start notice.
- Schedule/status snapshots include local timezone, relative time, background behavior, reconciliation action, and no-replay disclosure; they reject internal enums, identifiers, paths, raw provider errors, and account data.
- Typed quota assistant hint appears only for `quota_exhausted`, never generic 429, auth, transport, or malformed evidence.
- Background completion and stopped-state notices render once on the original conversation's next resume and remain queryable through read-only status afterward.
- Background fresh-process execution.
- Interrupted transcript with `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`; only the fixed continuation reaches QueryEngine.
- Trusted cwd, worktree, instruction set, model, effort, and permission restoration.
- Quota reschedule with newer reset.
- Quota failure without a newer reset.
- Auth, permission, context, max-turn, and network outcomes.
- LaunchAgent plist snapshot/path escaping without installation.
- One-shot scanner behavior for empty queue, future job, malformed job, foreground-owned job, wake/login, and stale executable.
- Command metadata prevents model invocation; no static provider gate hides a GPT-routed session, and runtime model routing rejects a non-Codex model.

### Existing focused regressions

```bash
bun test src/services/api/codexStatus.test.ts
bun test src/services/api/codexAccountPool.test.ts
bun test src/services/api/codexUsage.test.ts
bun test src/services/api/accountDiagnostics.test.ts
bun test src/utils/sessionStorage.test.ts
```

Run all new focused test paths, then the engine gate:

```bash
bun run build:dev:full
```

Do not run bare `bun test` or root `bun run typecheck`. Do not call live account/reset endpoints. A live LaunchAgent smoke test requires separate explicit authorization because it changes persistent user-level operating-system state.

## Non-goals

- Anthropic support or a provider-neutral abstraction.
- Automatic scheduling on every limit error.
- Subagent/worker continuation.
- Desktop renderer, preload, protocol, host, or sidecar integration.
- Linux systemd or Windows Task Scheduler integration.
- Remote execution while the local Mac is off.
- Privileged wake/power scheduling.
- Default `caffeinate` or prevention of lid-close sleep.
- Custom persisted continuation prompts.
- Persisting `/env`, credentials, account selection, or account health.
- Operating-system notifications.
- Perfect exactly-once guarantees for external side effects across process death.

## Review points

This ready plan fixes these defaults for implementation unless the user changes them:

1. Codex-only, main-session-only scope.
2. Strengthen the existing Codex status owner; do not introduce another quota belief model.
3. Dedicated global queue rather than extending cron.
4. Session ID plus validated project-storage identity; never persist a transcript path.
5. Reset plus a 60-second safety margin.
6. Two visible, fixed, cause-correct reconciliation prompts—reset elapsed or alternate account available—with internal interrupted-turn replay suppression.
7. Whole-attempt per-job and per-session filesystem locks in `job -> session` order, with no queue-global lock; PID metadata is never ownership authority.
8. A persisted sanitized terminal failure envelope, not rendered error text or diagnostic logs, proves quota eligibility.
9. Fsync-backed accepted-input and terminal-descendant barriers make `submitted`/`ambiguous` reconciliation safe; UUID deduplication alone is insufficient.
10. A runner-owned UUID registry hands foreground completion back from every REPL query exit while the runner retains both locks.
11. Trusted cwd/worktree restoration before instructions and tools load.
12. Foreground REPL execution with a periodic one-shot LaunchAgent fallback, never `QueueDirectories`.
13. Eventual execution after wake/login, not forced wake or sleep prevention.
14. Explicit opt-in before installing the background LaunchAgent.
15. New human input cancels only a still-pending continuation; submitted work blocks concurrent input.
16. Three bounded terminal network retries: 1, 5, and 15 minutes.
17. Background permission requirements or inexact restoration stop internally as `needs_attention` and render as `Stopped — needs you`; they never appear “paused” or imply automatic retry.
18. Background-off continuation requires the original conversation to be open; opening a different conversation neither executes nor cancels it.
19. User-facing output always explains when, what, no replay, background behavior and scan latency, cancellation, and the next action; internal queue terminology and identifiers remain hidden.
20. Every automatic transition is visible immediately or as a persisted one-shot notice when the original conversation is next resumed, while `/continue-after-limit status` remains the durable read-only source of truth.
