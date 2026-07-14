# Continue After Limit — Codex-Only Implementation Plan

Date: 2026-07-14  
Status: DRAFT — awaiting user review; not approved for implementation  
Scope: terminal engine, main session, Codex/OpenAI only

## Mission

Add a manual `/continue-after-limit` command that records a user-authorized continuation for the current main session after the Codex account pool reaches a real usage limit. Cat Code should resume the same transcript after the known reset and append one new continuation turn rather than blindly replaying the failed request.

The durability contract is:

> Run shortly after the known reset if the Mac is awake. If it is asleep, logged out, rebooting, or powered off, run once after the next wake/login.

No local implementation can execute while the computer is powered off. This feature must preserve work and resume later rather than trying to prevent shutdown.

## Hard constraints

- Codex/OpenAI only. Add no Anthropic eligibility, reset-detection, recovery, tests, or provider abstraction.
- Main session only. Subagent- and worker-specific continuation are out of scope.
- The user invokes the command manually; a limit error does not arm continuation automatically.
- Never classify authentication, transient transport, ambiguous 429, context-window, max-turn, max-budget, or permission failures as a scheduleable quota reset.
- Never persist tokens, account IDs, aliases, raw provider responses, arbitrary commands, or arbitrary prompts.
- Never replay the failed API request. Tools may already have produced side effects.
- Never approve permissions or elevate the resumed session's permission mode.
- Never install a LaunchAgent without explicit one-time confirmation.
- Never use `pmset`, privileged wake scheduling, or default sleep prevention.
- Do not touch `app/`, the desktop protocol, the sidecar boundary, or migration state for v1.
- Preserve all unrelated changes currently present on the `migration` branch. Do not commit, stash, revert, clean, or write `DONE.md` without separate user authorization.
- Verification must not call live Codex endpoints or install a real LaunchAgent without explicit authorization.

## Current source truth

### Codex limit and reset evidence

`src/services/api/codexStatus.ts:351-490` already produces the machine-readable advisory decision needed by this feature:

- `delegate`: a viable account is available;
- `attempt`: the observation is transient or uncertain;
- `wait`: all viable accounts are quota-blocked and a reset is known;
- `recheck`: accounts are quota-blocked but no credible reset is known;
- `human_recovery`: no account or only authentication-blocked accounts remain.

The same status explicitly states that it is advisory, does not reserve an account, and does not share cap state with the next process. A deferred job may persist a not-before time, but it must not persist or assert that an account is healthy.

`src/services/api/codexAccountPool.ts:1312-1353,1476-1503` protects hard-429 authority and only treats a reset as credible for a hard cap when it post-dates the cap. The new command must use this existing account/status machinery rather than introducing a second quota belief model.

`src/services/api/accountDiagnostics.ts:14-31,136-151` distinguishes `quota.exhausted` from auth, transient, and pool-unavailable failures, but does not carry a reset timestamp. Diagnostics can classify an attempt outcome; `buildCodexStatus()` remains the reset-time source.

### Session resume

The real resume path is already present:

- CLI flag dispatch: `src/main.tsx`
- transcript recovery: `src/utils/conversationRecovery.ts:469-615`
- process/session restoration: `src/utils/sessionRestore.ts:493-649`
- headless resume: `src/cli/print.ts:4913-5258`

Accepted user messages are persisted before API execution at `src/QueryEngine.ts:456-483`. The continuation runner must enter through this real path rather than reconstructing QueryEngine context itself.

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
3. Inspect typed fields on the latest main-thread assistant API error; never parse rendered error text.
4. Call `buildCodexStatus({ refresh: 'auto' })`.
5. Apply the decision table below.
6. If a pending job already exists for this session, return its status without creating another.
7. Otherwise persist one pending job and print the exact local continuation time.

| Codex status decision | Command behavior |
|---|---|
| `wait` with `not_before` | Schedule at `not_before + 60 seconds`. |
| `delegate` | Enqueue the continuation immediately because a viable account exists. |
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

If the user submits a new human prompt in the same session before the job fires, cancel the pending continuation and show a system notice. This prevents an old “continue” turn from firing after the user has changed the session's direction.

Merely reopening/resuming the transcript without sending new input does not cancel the job; the new REPL may adopt it.

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

Keep lock and temporary files outside `pending/` so an operating-system queue watcher treats only real jobs as pending work.

### Job schema

```ts
type DeferredContinuationJobV1 = {
  version: 1
  jobId: string
  sessionId: string
  transcriptPath: string
  projectRoot: string
  model: string
  effort?: EffortValue
  createdAt: number
  statusObservedAt: number
  resetAt: number
  notBefore: number
  state: 'pending' | 'claimed' | 'running'
  attempt: {
    number: number
    messageUuid: string
  }
  owner?: {
    pid: number
    processStartedAt: number
  }
  lease?: {
    holderPid: number
    acquiredAt: number
    expiresAt: number
  }
  transientRetries: number
}
```

The record intentionally omits a provider field because the feature is Codex-only. It also omits prompt text; the worker selects the fixed continuation copy from source by schema version.

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
- Lock read-modify-write operations with `src/utils/lockfile.ts`.
- Temp-file write, flush, and atomic rename.
- Validate UUIDs, finite timestamps, model, effort, and state transitions.
- Resolve and validate transcript paths through existing session-storage helpers; never execute a path or command supplied by the record.
- Recover stale claims only when the recorded process is gone or its lease expired.
- Retain terminal history for a bounded period, then clean it during normal queue startup.

## State machine

```text
pending
  -> claimed
  -> running
  -> completed

running
  -> pending          newer credible quota reset
  -> pending          bounded transient retry
  -> needs_attention  auth, permission, context, unknown reset, bad session

claimed/running
  -> pending          stale owner or expired lease, recoverable attempt

pending
  -> canceled
```

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

Existing request retries remain authoritative within each attempt. The queue's transient retry is only for a terminal attempt after the normal request retry policy has stopped.

## Live REPL execution

Add a hook modeled after `src/hooks/useScheduledTasks.ts:32-122`.

The hook should:

1. Discover the pending job for the current session.
2. Recompute from epoch time after wake or a system-clock change.
3. Wait until `notBefore` without keeping the process alive solely for the timer.
4. Acquire the job lease.
5. Enqueue the fixed continuation with the stored UUID.
6. Observe the resulting turn and transition the job.
7. Release ownership on REPL shutdown.

If the REPL remains open, this path keeps output and permission prompts visible in the original terminal.

## Background takeover

### Hidden worker entry point

Add a fixed hidden CLI entry point:

```text
cat-code deferred-continuation-worker
```

It accepts no prompt, command, account, model, or transcript path from CLI arguments. It reads validated queue records and executes only the built-in continuation operation.

For each due unowned job, it invokes the real Cat Code print/resume path with an argument array, never a shell string:

```text
cat-code -p
  --resume <validated-transcript-path>
  --model <captured-model>
  --effort <captured-effort>
  --input-format stream-json
  --output-format stream-json
  --verbose
```

Feed one structured user message through stdin using the attempt UUID. Do not use `--bare`; it would bypass instruction and session behavior needed for faithful resume.

The worker parses structured output for:

- `cat_code_account_diagnostic` / `quota.exhausted`;
- final result subtype and `is_error`;
- permission denials;
- authentication/account diagnostics;
- max-turn, budget, and other terminal result types.

If the attempt remains quota-blocked, obtain a fresh advisory reset through the existing Codex status builder. Never retry-hammer when no newer reset is known.

### macOS LaunchAgent

Install a dedicated user LaunchAgent only after explicit confirmation.

Recommended shape:

- label: `com.cat-code.deferred-continuation`;
- fixed absolute Cat Code executable path;
- fixed `deferred-continuation-worker` argument;
- `QueueDirectories`: the private `pending/` directory;
- `RunAtLoad`: reconcile pending jobs after login;
- no model output in launchd stdout/stderr logs;
- no `KeepAlive` when the queue is empty.

`QueueDirectories` allows launchd to start or restart the worker while real pending job files exist, without polling once per minute forever. The worker may wait for future jobs but must not call `caffeinate`; ordinary sleep remains allowed.

Do not overload `src/commands/install-agents/install-agents.ts`. That command currently owns unrelated Codex token-refresh agents and stale historical labels. Keep continuation installation and removal behind `/continue-after-limit enable-background|disable-background`.

### Computer lifecycle contract

| Event | Behavior |
|---|---|
| REPL remains open | The in-process hook submits at or after `notBefore`. |
| Terminal closes normally | LaunchAgent worker takes over the persisted job. |
| REPL crashes | Stale owner/lease recovery lets the worker take over. |
| Mac sleeps or lid closes | Nothing runs during sleep; due work runs after wake. |
| User logs out | User LaunchAgent stops; `RunAtLoad` reconciles after login. |
| Reboot or power loss | Flushed queue/transcript state survives; work resumes after login. |
| Mac remains powered off | No execution is possible. |
| Network is unavailable after wake | Apply the bounded transient retry policy. |

No local guarantee may claim exact execution while asleep or powered off. That would require an always-on remote host and is outside this feature.

## Concurrency and idempotency

`src/utils/concurrentSessions.ts:48-109` already records the session ID, PID, cwd, and process start time. Extend it with a validated read-only query for live registrations matching one session ID.

A background worker may claim a job only when:

- no matching live session owns it; or
- the recorded owner is stale; and
- the per-job lease is acquired atomically.

Compare both PID and recorded process start time to reduce PID-reuse mistakes.

If two unrelated live processes have resumed the same session, do not create a third writer. Move the job to `needs_attention: concurrent_session`.

Crash ordering:

1. Persist the attempt UUID and claim.
2. Submit the structured input through the real resume path.
3. `QueryEngine` persists the user message before API work.
4. Mark the attempt running/completed from structured output.

A crash after an external tool side effect but before its result is persisted cannot be made exactly-once by this queue. Existing interrupted-turn recovery plus the explicit reconciliation prompt reduces the risk, but the implementation must not claim perfect exactly-once side-effect semantics.

## Permission and environment behavior

- Restore the session's existing mode and permission context through normal resume machinery.
- Do not pass a more permissive `--permission-mode`.
- A background permission requirement becomes `needs_attention`; never synthesize approval.
- Project/user settings and normal environment loading follow startup behavior.
- Session-only `/env` values are intentionally not persisted. A background continuation depending on them may stop as `needs_attention`; do not serialize possible secrets into the job file.
- If the original REPL remains open, its process-local environment remains available through the foreground path.

## Files

### New production files

- `src/commands/continue-after-limit/index.ts`
  - command metadata and argument hint.
- `src/commands/continue-after-limit/continue-after-limit.tsx`
  - schedule/status/cancel and explicit background-enable confirmation UX.
- `src/services/deferredContinuation.ts`
  - strict job schema, paths, storage, locking, state transitions, eligibility.
- `src/services/deferredContinuationRunner.ts`
  - attempt dispatch, result classification, reschedule/terminal policy.
- `src/services/deferredContinuationLaunchAgent.ts`
  - plist generation and explicit install/uninstall.
- `src/hooks/useDeferredContinuation.ts`
  - live-session ownership, timer, queue dispatch, outcome observation.
- `src/cli/handlers/deferredContinuation.ts`
  - hidden background worker.

Add colocated tests for each behavior-bearing module. Do not create separate documentation or helper modules unless implementation proves they are necessary.

### Existing files to modify

- `src/commands.ts`
  - register `/continue-after-limit`.
- `src/main.tsx`
  - register the hidden worker and lightweight startup reconciliation.
- `src/screens/REPL.tsx`
  - mount the live deferred-continuation hook.
- `src/utils/concurrentSessions.ts`
  - expose validated live-session lookup by session ID.
- `src/utils/handlePromptSubmit.ts`
  - cancel a pending job on a new human prompt.
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
- `src/services/preventSleep.ts`
- `app/**`
- `scripts/build.ts`, unless implementation later introduces an explicitly approved feature gate

## Implementation sequence

### Slice 1 — Codex eligibility and durable job domain

1. Add strict job/terminal schemas and private storage paths.
2. Implement atomic create/read/update/cancel/history transitions.
3. Implement per-job leases and stale recovery using existing lock/process helpers.
4. Implement Codex-only eligibility from the latest typed API failure plus `buildCodexStatus()`.
5. Test decision mapping, reset parsing, stale/missing reset rejection, one-job-per-session idempotency, file permissions, malformed input, and lock races.

Acceptance:

- Only a real terminal Codex quota failure with `decision.action === 'wait'` and a valid `not_before` can create a future job.
- The queue contains no prompt, token, account identifier, or raw error data.
- Repeated command invocation cannot create duplicate jobs.

### Slice 2 — Command and foreground execution

1. Add the command descriptor and local JSX implementation.
2. Add schedule/status/cancel behavior and first-use background confirmation.
3. Add the REPL hook and fixed continuation copy.
4. Thread the stored attempt UUID through the existing command queue.
5. Cancel pending work when a new human prompt changes the session.
6. Observe successful/error terminal messages and update job state.

Acceptance:

- An open REPL executes once at/after the fake reset time.
- The continuation prompt is visible and uses the stored UUID.
- A human prompt cancels stale scheduled continuation.
- Permission mode is unchanged.

### Slice 3 — Background worker and takeover

1. Add the hidden worker entry point.
2. Resume through the real headless CLI path using structured input/output.
3. Add validated live-session detection and lease takeover.
4. Add result classification and bounded retry/reschedule behavior.
5. Add plist generation and explicit install/uninstall commands.
6. Add process probes for owner crash, two-worker races, and reboot-style fresh-process recovery.

Acceptance:

- Closing or killing the original REPL leaves one durable job.
- Exactly one worker submits each attempt UUID.
- A due job resumes the same transcript and model.
- A second quota limit reschedules only from newer credible reset evidence.
- Auth, permission, context, and ambiguous failures stop for attention.

### Slice 4 — Documentation and impact sweep

1. Update the three routing maps listed above.
2. Run the Cat Code change-impact checklist.
3. Search imports, commands, docs, configs, tests, schemas, and generated surfaces for stale or missing references.
4. Do not write `DONE.md` without explicit user approval.

## Verification plan — run only after implementation

The user requested review of this plan before verification. Do not run these checks now.

### New focused tests

- Codex status decision matrix.
- Latest-error and model/provider eligibility.
- Unknown, stale, zero, malformed, and already-past reset times.
- One pending job per session.
- Strict schema and path-containment rejection.
- Directory/file permissions.
- Atomic write and read-modify-write contention.
- Two-process claim race.
- Stale owner and expired lease recovery.
- Stable attempt UUID and transcript deduplication.
- Human-input cancellation.
- Foreground fake-clock execution.
- Background fresh-process execution.
- Quota reschedule with newer reset.
- Quota failure without a newer reset.
- Auth, permission, context, max-turn, and network outcomes.
- LaunchAgent plist snapshot/path escaping without installation.

### Existing focused regressions

```bash
bun test src/services/api/codexStatus.test.ts
bun test src/services/api/codexAccountPool.test.ts
bun test src/services/api/codexUsage.test.ts
bun test src/services/api/accountDiagnostics.test.ts
bun test src/utils/sessionStorage.test.ts
bun test src/utils/cronTasks.test.ts src/utils/cronScheduler.test.ts
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
2. Dedicated global queue rather than extending cron.
3. Reset plus a 60-second safety margin.
4. Visible fixed reconciliation prompt rather than request replay.
5. Foreground REPL ownership with LaunchAgent takeover after process loss.
6. Eventual execution after wake/login, not forced wake or sleep prevention.
7. Explicit opt-in before installing the background LaunchAgent.
8. New human input cancels the pending continuation.
9. Three bounded terminal network retries: 1, 5, and 15 minutes.
10. Background permission requirements stop as `needs_attention`.
