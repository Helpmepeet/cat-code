# Continue After Limit — Codex-Only Implementation Plan

Date: 2026-07-14
Status: DRAFT — revised after source-backed review; not approved for implementation
Scope: terminal engine, main session, Codex/OpenAI only

## Mission

Add a manual `/continue-after-limit` command that records a user-authorized continuation for the current main session after the Codex account pool reaches a real usage limit. Cat Code should resume the same transcript after the known reset and append one new continuation turn rather than blindly replaying the failed request.

The durability contract is:

> Run shortly after the known reset if the Mac is awake. If it is asleep, logged out, rebooting, or powered off, run once after the next wake/login.

No local implementation can execute while the computer is powered off. This feature must preserve work and resume later rather than trying to prevent shutdown.

## Revision basis

ChatGPT review `Helpmepeet/cat-code#12` was created from `main`, while this plan targets the current `migration` branch. Its blocker claiming that `src/services/api/codexStatus.ts` does not exist is therefore false for the target branch. Current source confirms that `buildCodexStatus()` exists and owns the aggregate Codex action decision.

The review still exposed a real adjacent gap: status aggregation can treat a positive usage reset as known without proving that it is fresh relative to a hard cap. This revision keeps the existing Codex status owner, adds that missing freshness contract, and adopts the review's source-valid findings about interrupted-turn replay, resume context, single-writer ownership, LaunchAgent lifecycle, and transcript-path trust.

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

`src/services/api/accountDiagnostics.ts:14-31,136-151` distinguishes `quota.exhausted` from auth, transient, and pool-unavailable failures, but does not carry a reset timestamp. Diagnostics can classify an attempt outcome; `buildCodexStatus()` remains the reset-time source.

### Session resume

The real resume path is already present:

- CLI flag dispatch: `src/main.tsx`
- transcript recovery: `src/utils/conversationRecovery.ts:469-615`
- process/session restoration: `src/utils/sessionRestore.ts:493-649`
- headless resume: `src/cli/print.ts:4913-5258`

Accepted user messages are persisted before API execution at `src/QueryEngine.ts:456-483`. The continuation runner must enter through this real path rather than reconstructing QueryEngine context itself.

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
7. Otherwise persist one pending job and print the exact local continuation time.

| Codex status decision | Command behavior |
|---|---|
| `wait` with a credible post-cap `not_before` | Schedule at `not_before + 60 seconds`. |
| `delegate` after the terminal quota failure | Enqueue the continuation immediately because a viable account exists. |
| `attempt` | Refuse scheduling; this is an uncertain/transient observation, not a known reset. |
| `recheck` | Refuse scheduling because no credible reset time exists. |
| `human_recovery` | Refuse and show the sanitized account/auth recovery reason. |

The latest turn must also be a terminal quota/rate-limit error. A `wait` observation alone is insufficient to turn this command into a generic scheduler.

### User-visible result

A scheduled result should state:

```text
Continuation scheduled for Jul 14, 4:31 PM.

It will run in this session if Cat Code remains open. With background
continuation enabled, it can also resume after the terminal closes or the
process crashes. If the Mac is asleep or powered off, it will run after the
next wake or login.

Cancel with: /continue-after-limit cancel
```

When background continuation is not enabled, disclose the reduced guarantee: closing Cat Code delays execution until Cat Code starts again.

### Continuation turn

Do not resubmit the interrupted user request or the failed provider payload. Append a new, visible, fixed continuation turn:

```text
Automated continuation requested through /continue-after-limit.

The Codex usage limit should now have reset. Continue the previous task, but
first reconcile the current transcript and filesystem state. Do not repeat
work or side effects that already completed.
```

Use “should now have reset,” not “has reset,” because reset observations are advisory.

The queued input must use:

- `skipSlashCommands: true`;
- `isMeta: false`;
- `priority: 'later'`;
- the persisted attempt UUID as `QueuedCommand.uuid`.

`QueuedCommand` already carries a UUID at `src/types/textInputTypes.ts:299-358`. Reusing the UUID after a crash lets transcript persistence deduplicate one attempt. A later retry after a newly observed quota reset mints a new attempt UUID.

### Manual activity invalidates the schedule

If the user submits a new human prompt in the same session before the job fires, acquire the job lock, atomically cancel the pending continuation, and only then submit the human prompt. This prevents an old “continue” turn from firing after the user has changed the session's direction.

If the background or foreground continuation already holds the job/session locks, do not submit human input concurrently. Show that the continuation is in progress and require the user to retry after its terminal result. If crash reconciliation marks the attempt `ambiguous`, show the manual-reconciliation state instead of silently canceling or retrying it.

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

The record intentionally omits a provider field because the feature is Codex-only. It also omits prompt text and transcript path: the runner selects the fixed continuation copy from source and derives the transcript from `projectStorageKey + sessionId`.

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
- Use `src/utils/lockfile.ts` for authoritative per-job and per-session filesystem locks. Hold both locks for the full attempt; do not persist PID ownership or expiring leases.
- Acquire locks in one global order: job lock, then session lock. Foreground and background paths must never reverse it.
- Temp-file write, flush, and atomic rename.
- Validate UUIDs, finite timestamps, model, effort, and state transitions.
- Derive the transcript from the validated private storage root, `projectStorageKey`, and `sessionId`; never execute or open a transcript path supplied by the record.
- Reject symlinked queue, lock, project-storage, and transcript components. Require expected ownership, restrictive modes, and regular-file type.
- Revalidate containment at the open boundary. Use no-follow open semantics where available, then compare `fstat` identity with the validated file so a path swap cannot redirect the read.
- Treat `src/utils/concurrentSessions.ts` as advisory display data only. PID liveness and application-recorded `startedAt` do not prove process identity or writer ownership.
- Retain terminal history for a bounded period, then clean it during normal queue startup.

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

`submitted` is a durable crash boundary, not a claim or lease. On startup:

1. If the transcript does not contain the attempt's user-message UUID, QueryEngine never crossed its pre-provider persistence boundary. Return the same attempt to `pending`.
2. If the UUID and a terminal descendant are present, classify that durable result and complete, reschedule, or stop for attention.
3. If the UUID is present without a terminal descendant, transition to `ambiguous`. Never call the provider automatically again.

This deliberately prefers a manual recovery over duplicate tools or external side effects. UUID deduplication in `src/utils/sessionStorage.ts:1532-1577` prevents a duplicate transcript entry, but `src/QueryEngine.ts:430-483,733-739` can still proceed to the provider after persistence is skipped. UUID reuse is not provider-call idempotency.

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
| Attempt UUID present without terminal outcome after crash | `ambiguous`; never retry automatically |

Existing request retries remain authoritative within each attempt. The queue's transient retry is only for a terminal attempt after the normal request retry policy has stopped.

## Live REPL execution

Add a hook modeled after `src/hooks/useScheduledTasks.ts:32-122`.

The hook should:

1. Discover the pending job for the current session.
2. Recompute from epoch time after wake or a system-clock change.
3. Wait until `notBefore` without keeping the process alive solely for the timer.
4. Acquire the job lock and then the per-session execution lock.
5. Re-read the job under lock, validate that it is still due, and atomically mark the attempt `submitted`.
6. Enqueue the fixed continuation with the stored UUID.
7. Observe the resulting turn, atomically transition the job, and release both locks.

The hook and background scanner use the same runner and locks. The foreground timer normally wins while the REPL is active, keeping output and permission prompts visible in the original terminal. Correctness must not depend on that preference: if the background worker wins the lock race, the REPL observes the submitted state and must not start a second turn.

## Background takeover

### Hidden worker entry point

Add a fixed hidden CLI entry point:

```text
cat-code deferred-continuation-worker
```

It accepts no prompt, command, account, model, transcript path, cwd, or job ID from CLI arguments. One invocation scans the validated queue, attempts at most one due job, and exits.

Do not launch a nested public `cat-code -p --resume <path>` process. The hidden entry point must dispatch before normal project bootstrap so the shared runner can:

1. choose one due record under the queue lock;
2. acquire the job lock and then the session execution lock;
3. derive and securely open the transcript from `projectStorageKey + sessionId`;
4. validate the saved canonical cwd/worktree identity against session metadata;
5. restore/chdir to that context before project instructions, settings, skills, and tools load;
6. restore the captured model and effort;
7. reconstruct a permission context that is equal to or stricter than the captured mode, without temporary approvals;
8. invoke the real internal headless resume/query path with the fixed continuation and persisted UUID;
9. classify the terminal result and atomically transition the record.

Add a private headless option such as `suppressInterruptedTurnReplay: true` and check it at `src/cli/print.ts:1182-1205`. The worker also removes `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` from its behavior environment before bootstrap as defense in depth. Do not disable normal interruption recovery for public print mode.

The runner classifies typed structured outcomes:

- `cat_code_account_diagnostic` / `quota.exhausted`;
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
| Terminal closes normally | The next LaunchAgent scan takes over the persisted job. |
| REPL crashes | Filesystem locks become reclaimable; the next scan reconciles durable attempt state. |
| Mac sleeps or lid closes | Nothing runs during sleep; due work runs on a scan after wake. |
| User logs out | User LaunchAgent stops; `RunAtLoad` reconciles after login. |
| Reboot or power loss | Flushed queue/transcript state survives; work resumes after login. |
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
4. Atomically write `submitted` with `submittedAt`.
5. Enter QueryEngine with the fixed input and stored UUID.
6. QueryEngine persists the user message before provider work.
7. Atomically move to a terminal state or reschedule after a typed terminal result.
8. Release session and job locks.

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
  - schedule/status/cancel and explicit background-enable confirmation UX.
- `src/services/deferredContinuation.ts`
  - strict schema, private path derivation, queue/history I/O, job/session locks, state transitions, and Codex-only eligibility.
- `src/services/deferredContinuationRunner.ts`
  - shared foreground/background attempt dispatch, trusted runtime restoration, crash reconciliation, result classification, and reschedule/terminal policy.
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
  - add the private deferred-runner option that suppresses interrupted-turn replay.
- `src/services/api/codexStatus.ts`
  - enforce hard-cap reset freshness in the existing aggregate status owner.
- `src/services/api/codexStatus.test.ts`
  - add the cross-module stale-reset regression and closed decision cases.
- `src/screens/REPL.tsx`
  - mount the live hook and coordinate resume/adopt with the session execution lock.
- `src/utils/sessionRestore.ts`
  - expose shared trusted cwd/worktree restoration needed before deferred headless bootstrap.
- `src/utils/sessionStorage.ts`
  - derive/open a transcript from validated project-storage identity and session ID without accepting a persisted path.
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
2. Runtime-narrow the latest assistant API failure into a closed Codex terminal-failure classification.
3. Add the Codex-only `DeferredContinuationEligibility` evaluator without adding a provider abstraction.
4. Test generic 429, auth, network, malformed details, stale pre-cap reset, fresh post-cap reset, viable alternate account, and missing reset.

Acceptance:

- `buildCodexStatus()` cannot return a scheduleable `wait` from reset evidence older than the hard cap.
- Only a typed terminal Codex quota failure plus fresh status evidence can create a future job.
- Uncertain or malformed evidence fails closed without text parsing.

### Slice 2 — Durable store, secure identity, and locks

1. Add strict job/terminal schemas and private storage paths.
2. Implement atomic create/read/update/cancel/history transitions.
3. Implement whole-attempt per-job and per-session filesystem locks with fixed acquisition order.
4. Derive transcripts from project-storage identity plus session ID; add containment, no-symlink, ownership, mode, regular-file, and open-boundary checks.
5. Implement `pending`/`submitted`/`ambiguous` crash reconciliation from durable transcript UUID evidence.

Acceptance:

- The queue contains no prompt, transcript path, token, account identifier, temporary permission grant, or raw error data.
- Repeated command invocation cannot create duplicate jobs.
- Two processes cannot own one session attempt concurrently.
- A crash with an unresolved persisted attempt UUID never causes automatic provider resubmission.

### Slice 3 — Shared trusted resume runner

1. Expose the smallest shared cwd/worktree restoration seam used by interactive and deferred headless resume.
2. Dispatch the hidden worker before project bootstrap, restore trusted cwd/worktree first, then load settings, instructions, skills, and tools.
3. Restore model and effort and reconstruct a permission context that cannot be more permissive than the captured mode.
4. Add the private print-runner option that suppresses interrupted-turn replay.
5. Enter the real QueryEngine path with the fixed continuation UUID and classify typed terminal results.
6. Add process probes covering replay flags, cwd/worktree, instruction loading, model, effort, permission behavior, and crash boundaries.

Acceptance:

- A transcript ending in a failed prompt plus `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` executes only the fixed continuation UUID.
- Background execution uses the captured canonical project/worktree context before instruction discovery.
- Unsafe or inexact permission restoration stops for attention rather than widening authority.
- The runner does not accept a public transcript path or arbitrary prompt.

### Slice 4 — Command and foreground coordination

1. Add the command descriptor and local JSX implementation.
2. Add schedule/status/cancel behavior and first-use background confirmation.
3. Add the thin REPL hook and fixed continuation copy.
4. Thread the stored attempt UUID through the existing command queue.
5. Atomically cancel pending work before new human input.
6. Coordinate resume/adopt and prompt submission with the job/session locks.
7. Observe successful/error terminal messages and update job state.

Acceptance:

- An open REPL executes once at/after the fake reset time.
- The continuation prompt is visible and uses the stored UUID.
- A human prompt cancels a still-pending continuation before submission.
- Human input after attempt submission is visibly blocked rather than appended concurrently.

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
- Auth, permission, context, and ambiguous failures stop for attention.

### Slice 6 — Documentation and impact sweep

1. Update the three routing maps listed above.
2. Run the Cat Code change-impact checklist.
3. Search imports, commands, docs, configs, tests, schemas, LaunchAgent labels, and generated surfaces for stale or missing references.
4. Do not write `DONE.md` without explicit user approval.

## Verification plan — run only after implementation

The user requested review of this plan before verification. Do not run these checks now.

### New focused tests

- Codex status decision matrix, including stale pre-cap versus fresh post-cap reset.
- Runtime narrowing of terminal quota, generic 429, auth, transport, and malformed `unknown` failure details.
- Latest-error and model/provider eligibility.
- Unknown, stale, zero, malformed, and already-past reset times.
- One pending job per session.
- Strict schema with no transcript-path field.
- Session-ID/project-storage derivation and mismatch rejection.
- Direct symlink, parent symlink, path swap, wrong-owner/mode, non-regular-file, and containment rejection.
- Directory/file permissions.
- Atomic write and read-modify-write contention.
- Two-process per-job and per-session lock races.
- Manual resume after background lock acquisition.
- Human input after attempt submission.
- Stable attempt UUID and the distinction between transcript deduplication and provider execution.
- Crash before UUID persistence, after UUID persistence, and after terminal result.
- `submitted` recovery to pending, terminal classification, or `ambiguous`.
- Human-input cancellation.
- Foreground fake-clock execution.
- Background fresh-process execution.
- Interrupted transcript with `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`; only the fixed continuation reaches QueryEngine.
- Trusted cwd, worktree, instruction set, model, effort, and permission restoration.
- Quota reschedule with newer reset.
- Quota failure without a newer reset.
- Auth, permission, context, max-turn, and network outcomes.
- LaunchAgent plist snapshot/path escaping without installation.
- One-shot scanner behavior for empty queue, future job, malformed job, foreground-owned job, wake/login, and stale executable.

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

The draft fixes these defaults for implementation unless the user changes them:

1. Codex-only, main-session-only scope.
2. Strengthen the existing Codex status owner; do not introduce another quota belief model.
3. Dedicated global queue rather than extending cron.
4. Session ID plus validated project-storage identity; never persist a transcript path.
5. Reset plus a 60-second safety margin.
6. Visible fixed reconciliation prompt with internal interrupted-turn replay suppression.
7. Whole-attempt per-job and per-session filesystem locks; PID metadata is never ownership authority.
8. Durable `submitted`/`ambiguous` crash handling rather than blind provider resubmission.
9. Trusted cwd/worktree restoration before instructions and tools load.
10. Foreground REPL execution with a periodic one-shot LaunchAgent fallback, never `QueueDirectories`.
11. Eventual execution after wake/login, not forced wake or sleep prevention.
12. Explicit opt-in before installing the background LaunchAgent.
13. New human input cancels only a still-pending continuation; submitted work blocks concurrent input.
14. Three bounded terminal network retries: 1, 5, and 15 minutes.
15. Background permission requirements or inexact restoration stop as `needs_attention`.
