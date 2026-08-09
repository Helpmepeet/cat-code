# S01 — deferred continuation subsystem

## Verdict

The durability layer, the lock/claim protocol, and the LaunchAgent installer are
unusually well built for this repo: atomic temp+rename+fsync writes, a
terminal-authority tombstone with a correctness-preserving retention rule, a
two-lock zero-retry claim with ownership re-asserts before every durable write,
and real multi-process probe tests that prove exactly one owner. Re-entrancy and
double-spend are genuinely closed. The single most important thing to fix is
different and it is upstream of all of that: the eligibility check calls
`buildCodexStatus`, which calls `loadPoolForObservation()`, which **replaces the
live in-process account pool** with a fresh vault read. Codex cap state is
in-memory only, so the observation that decides "wait for reset vs run now" is
taken against a pool that has just forgotten the exhaustion it is reacting to.
That inverts the feature's primary decision and destroys the host REPL's routing
state as a side effect. Second: `useDeferredContinuation.ts:138` returns without
re-arming its timer, permanently killing the poll loop in the one branch its
tests never produce.

## Findings

### [HIGH] Eligibility observes a pool it wiped one line earlier; `schedule` is unreachable in its own primary scenario

- **Where**: `src/services/deferredContinuation.ts:1169` (and the same call at `src/services/deferredContinuationRunner.ts:578`)
- **Type**: correctness
- **What**: `evaluateDeferredContinuationEligibility` calls `buildCodexStatus({ refresh: 'auto' })`. `buildCodexStatus` defaults `loadPool: true` (`src/services/api/codexStatus.ts:414-419`) and so calls `loadPoolForObservation()`, which assigns `pool.accounts = mergePoolAccounts(...)` (`src/services/api/codexAccountPool.ts:188`). `mergePoolAccounts` (`:1040-1063`) builds a brand-new array from `loadVaultAccounts` (`:998-1012`), which never restores `status:'capped'`, `cappedAt`, `usageAllowed`, `usageLimitReached`, or `usageResetAt` — cap state is in-memory only (`markPoolAccountCapped`, `:469-489`, writes nothing to disk).
- **Trigger / why it matters**: the durable failure this feature keys on is only stamped `quota_exhausted` when `capped === counts.total` (`src/services/api/withRetry.ts:167-176`) — i.e. every profile is capped *in memory*. The user then runs `/continue-after-limit`. The transcript check passes, then `buildCodexStatus` reloads every account as `healthy`, `getCodexAccountAvailability` (`codexAccountPool.ts:1544`) returns `available` for all of them, `decide()` hits `pool.candidate >= 1` (`codexStatus.ts:386-388`) and returns `delegate`, and eligibility returns `run_now`. The command prints "A usable Codex account is available, so continuation will start now" (`continue-after-limit.tsx:413`) and immediately submits a turn that 429s again. Three consequences: (a) the `schedule`/`wait` path is unreachable in the exact scenario the feature exists for; (b) running the command mutates the live REPL's shared `pool` object, un-capping every account so the *next* ordinary turn also re-burns 429s across the pool; (c) the runner's quota-reschedule branch (`deferredContinuationRunner.ts:588-617`) sees the same reloaded pool, never gets `action === 'wait'`, and falls through to `stopDeferredContinuationForAttention(..., 'quota_reset_unknown')` — so the retry ladder terminates with "A reliable Codex reset time is unavailable" instead of rescheduling.
- **Fix**: do not reload a pool this process already owns. `getPoolStatus()` already exposes `initialized` (`codexAccountPool.ts:413-423`), so both call sites become `buildCodexStatus({ refresh: 'auto', loadPool: !getPoolStatus().initialized })`. That keeps the standalone `cat-code codex status` process (`main.tsx:4335`) behaving exactly as today, since its pool is uninitialized.

### [HIGH] `if (!attempt) return` permanently kills the continuation poll loop

- **Where**: `src/hooks/useDeferredContinuation.ts:138`
- **Type**: correctness
- **What**: every other exit in `check()` schedules a follow-up `setTimeout`, and the file's own comments state why ("returning without a timer kills the loop for the session's lifetime", `:85-88`). This one branch returns bare.
- **Trigger / why it matters**: `beginForegroundDeferredContinuation` returns `null` whenever the lock-guarded re-read shows the job changed (`deferredContinuationRunner.ts:697-705`). Two reachable races produce that: (1) a background worker completed the job between the hook's read at `:81` and the lock acquisition; (2) the user sent a message at the same moment, so `prepareHumanPromptAgainstDeferredContinuation` (`deferredContinuation.ts:837`) already moved it to history. The effect deps are `[activeSessionId, setMessages]` — `setMessages` is a stable `useState` dispatcher and `activeSessionId` is fixed for the session — so nothing re-runs it. From that point the session never consumes another notice (background-worker outcomes are dropped on the floor) and never picks up a *newly scheduled* continuation, which with background continuation off means it never runs at all. Entirely silent: no message, no error.
- **Fix**: replace `if (!attempt) return` with the same 1 s re-arm the sibling `catch` at `:132-136` uses.

### [MED] The unattended background continuation runs with no turn cap, no budget cap, and no deadline, while holding the session lock

- **Where**: `src/main.tsx:617-622` (worker argv) and `src/main.tsx:2941-2943` (`maxTurns`/`maxBudgetUsd` come only from CLI options)
- **Type**: correctness / security
- **What**: the worker rewrites argv to `--print --resume … --model … --permission-mode …` and never sets `--max-turns` or `--max-budget-usd`, both of which default to `undefined`. `preparedBackgroundAttempt` holds both filesystem locks for the whole run, and `proper-lockfile` refreshes the lock mtime every `DEFERRED_LOCK_UPDATE_MS`, so the guard's abort signal can never fire on a run that is merely long.
- **Trigger / why it matters**: a scheduled continuation resumes a long conversation unattended, at a time the user chose not to be present, in the session's saved permission mode (`acceptEdits` is in `RESTORABLE_BACKGROUND_PERMISSION_MODES`, `deferredContinuationRunner.ts:89-94`), and can run indefinitely burning quota. While it runs, the user's own session is hard-blocked: `prepareHumanPromptAgainstDeferredContinuation` refuses every prompt with "A scheduled continuation is already in progress" and resume is refused with `DEFERRED_RESUME_BUSY_NOTICE`. There is no user-facing stop. The code already anticipates caps — `classifyDeferredHeadlessResult` handles `error_max_turns` and `error_max_budget_usd` (`deferredContinuationRunner.ts:177-182`) — but nothing ever sets them, so those two branches are dead. The consent dialog ("It runs only Cat Code's fixed continuation worker and does not store prompts or credentials", `continue-after-limit.tsx:285`) does not disclose an uncapped agentic run.
- **Fix**: append a conservative `--max-turns` (and optionally `--max-budget-usd`) to the worker argv at `main.tsx:621`. Those outcomes already have terminal handling and user copy.

### [MED] `enable-background` discards every actionable install error and replaces it with a wrong one

- **Where**: `src/commands/continue-after-limit/continue-after-limit.tsx:275-280`
- **Type**: quality (error handling)
- **What**: the whole `installDeferredContinuationLaunchAgent` call is wrapped in `catch { onDone('Background continuation requires a stable installed Cat Code executable. Install Cat Code normally, then run /continue-after-limit enable-background again.') }`.
- **Trigger / why it matters**: install throws four distinct, deliberately-authored messages that name the plist path and the recovery state — "the previous launchd job is still loaded. `<path>` was kept for recovery" (`deferredContinuationLaunchAgent.ts:247`), "unable to verify that the previous launchd job unloaded" (`:248`), and the two bootstrap-failure variants at `:277-280` which state whether the previous plist was restored and reloaded. All are replaced by a message about the executable, which is wrong and unactionable for every one of them; the user is told to reinstall Cat Code when the actual problem is a stuck launchd job. The sibling `disable-background` branch does the opposite and explains why in a comment (`:320-328`: "Its message names the plist and the manual bootout command, so surface that text instead of a generic failure string"). The two branches contradict each other.
- **Fix**: mirror `disable-background` — surface `error.message`, keeping the executable-specific copy only for the `validateStableDeferredContinuationExecutable` failure.

### [MED] The empty-queue check sits behind the entire CLI module graph, and launchd runs it 1,440×/day forever

- **Where**: `src/main.tsx:617-622`; plist at `src/services/deferredContinuationLaunchAgent.ts:103-105` (`RunAtLoad` + `StartInterval` 60)
- **Type**: design
- **What**: once background continuation is enabled, launchd spawns the full `cat-code` executable every 60 seconds indefinitely, with no self-disable when the queue drains. The worker's early exit is `if (!job) return` inside `main()` — reached only after `src/main.tsx`'s 172 static imports and their transitive graph have been evaluated. The actual work in the empty case is a handful of `readdir`s on a directory that usually does not exist.
- **Trigger / why it matters**: `src/entrypoints/cli.tsx` is explicitly built for this ("All imports are dynamic to minimize module evaluation for fast paths", `:41-43`) and already carries the precedent — the `touch-all` fast path at `:66-81` exists verbatim because "macOS LaunchAgents (installed via /install-agents)" invoke it periodically. The deferred worker did not follow it. The cost is paid once a minute, forever, on every machine that ever enabled the feature.
- **Fix**: hoist the `deferred-continuation-worker` branch into `cli.tsx` next to `touch-all`: dynamically import `deferredContinuationRunner`, and only `await import('../main.js')` when `prepareBackgroundDeferredContinuation()` returned a job.
- **Note on the pool race you asked about**: the empty-queue tick does **not** amplify the `persistNextQuarantineProbe` race. `init()` (`main.tsx:969`) is far below the early return, so a no-job worker never reaches `initAccountPool`. A worker that *claims* a job does: `startPeriodicRefresh()` + `startQuarantineProbe()` run unconditionally (`codexAccountPool.ts:222-224`), while startup `touchAll()` is skipped because `shouldRunStartupCodexTouchAll()` is `!getIsNonInteractiveSession()` (`:162-164`) and `setIsInteractive(false)` runs at `main.tsx:848` for `--print`. So the net effect is one extra **quarantine-probe writer** — the side that performs the unlocked whole-vault read-modify-write — running unattended at the quota-reset moment, which is exactly when a user is also likely to open or resume a session. It does not add a `touchAll()` racer, but it does turn "probe races a human-initiated init" into a scheduled, unwitnessed event.

### [MED] The `deferredContinuation` / `Runner` boundary leaks scheduling policy, and the reset clamp is duplicated

- **Where**: `src/services/deferredContinuation.ts:1193` and `src/services/deferredContinuationRunner.ts:597`
- **Type**: design / duplication
- **What**: the stated split is store-and-primitives (1201 lines) vs execution (793 lines), but three concerns cross it. Scheduling policy lives on both sides: `evaluateDeferredContinuationEligibility` computes `Math.max(now, resetAt + 60_000)` in the store file, and `applyAttemptResult` recomputes `Math.max(result.observedAt, resetAt + 60_000)` in the runner, with a comment admitting it ("Same clamp the scheduler applies"). Lifecycle transitions also cross: `prepareHumanPromptAgainstDeferredContinuation` (`deferredContinuation.ts:775-861`) orchestrates locks, notices, and a history move — runner-shaped work — from the store module. Transcript parsing is split too: the reader is in the store (`:1051`), the metadata extractor in the runner (`:102`).
- **Trigger / why it matters**: the duplicated clamp is the checkable instance — the "+60 s after reset" grace and the "never schedule in the past" rule must change in two files, and a divergence produces a schedule that fires before the reset and burns a real turn. This is concrete cost, not aesthetics.
- **Fix**: export one `computeContinuationNotBefore(observedAt, resetAt)` from the store module and call it from both places.

### [MED] Retry/reschedule policy — the part that decides whether a continuation re-arms — has zero behavioural test coverage

- **Where**: `src/services/deferredContinuationRunner.ts:551-684` (`applyAttemptResult`)
- **Type**: correctness (test gap, named branches)
- **What**: `rg` over all four test files finds no test that calls `applyAttemptResult`, no test that stubs `buildCodexStatus`, and `transientRetries` only ever `0` in fixtures. The only tests mentioning `network_retry`/`quota_rescheduled` are presentation tests that format an already-constructed notice (`deferredContinuationRunner.test.ts:418-419`).
- **Trigger / why it matters**: specific untested branches whose failure is silent, in the order you asked about:
  1. `useDeferredContinuation.ts:138` (`attempt === null`): the hook's mock always returns an attempt object (`useDeferredContinuation.test.ts:144-153`), so the loop-killing branch above cannot be reached by any test.
  2. Quota reschedule (`:588-617`): the strict `resetAt > (job.resetAt ?? 0)` guard is the only thing preventing a re-arm on an unchanged reset, and the `else` is a permanent stop. HIGH-1 makes this whole branch unreachable in production and no test would notice.
  3. Network-retry ladder bound (`:629-630`): `NETWORK_RETRY_DELAYS[job.transientRetries]` returning `undefined` at index 3 is the *only* thing bounding infinite network retry; the boundary is never exercised.
  4. `attempt.number` has no ceiling (schema `z.number().int().positive()`, `deferredContinuation.ts:157`) — unlike `transientRetries`, which is capped at 3. The quota path relies entirely on the provider reporting a strictly-increasing reset.
  Every one of these fails by quietly stopping the job with a plausible "needs you" message, which is indistinguishable from correct behaviour.
- **Fix**: three tests against `applyAttemptResult` with an injected status builder: quota→reschedule, quota→stop (reset not advancing), and `transientRetries: 3`→`'network'` stop. Plus one hook test where `beginForegroundDeferredContinuation` resolves `null`.

### [LOW] `formatDeferredContinuationNotice` has no exhaustiveness tripwire and can return `undefined`

- **Where**: `src/services/deferredContinuationPresentation.ts:102-136`, and `:23`
- **Type**: convention / types
- **What**: the switch over the 7 notice kinds has no `default: { const exhaustive: never = ... }`, unlike both sibling switches (`deferredContinuation.ts:853-856`, `deferredContinuationRunner.ts:679-682`). Root tsconfig sets neither `strict` nor `noImplicitReturns`, so an added kind compiles clean and returns `undefined`; the caller does `let text = format(...)` then `text += ...` (`useDeferredContinuation.ts:61-68`) and renders the string `"undefined"`. Related in the same file: `formatDeferredContinuationStopped(reason: string)` takes a bare `string` rather than `DeferredContinuationTerminalReason`, so a new terminal reason silently lands in the generic fallback with no compile error; and `notice.notBefore!` at `:126` and `:131` are non-null assertions standing in for a schema invariant.
- **Trigger / why it matters**: the union is extended by adding a `kind` to the schema at `deferredContinuation.ts:695-703` — nothing forces the presentation side to follow.
- **Fix**: add the `never` default, and type the `reason` parameter as the union.

### [LOW] Queue directories `locks/` and `tmp/` grow without bound, and one corrupt record disables the only pruning pass

- **Where**: `src/services/deferredContinuation.ts:863-877`, `:898-913`, `:740-743`, `:601-608`
- **Type**: correctness (resource growth)
- **What**: `history/` has a deliberate 30-day retention pass with a well-reasoned safety rule. Nothing else does. `ensureLockTarget` creates `locks/job-<uuid>` and `locks/session-<uuid>` and they are never unlinked, so every job ever scheduled leaves two permanent files. `shouldScannerAttemptLock` writes `tmp/stale-job-<uuid>.json` observations that are never removed. `tmp/notice-<sessionId>.json` is only unlinked by `takeDeferredContinuationNotice`, so a notice for a session the user never reopens persists forever. Orphaned `tmp/<uuid>.tmp` files from a crash between `open` and `rename` (`:332-347`) are never swept.
- **Trigger / why it matters**: separately, `pruneDeferredContinuationHistory` returns 0 and aborts the entire pass for any pending-record read error that is not `ENOENT` or a `ZodError` (`:604-605`). A truncated record throws `SyntaxError` from `JSON.parse` inside `readPrivateJson`, and a mode-widened record throws a plain `Error` — either one permanently disables history pruning, and a malformed pending record is only removed by the user running `/continue-after-limit cancel` in that specific session.
- **Fix**: extend the existing prune pass to unlink lock targets and `tmp/` entries with no surviving pending job, and treat `SyntaxError` the same as `ZodError` at `:605` (an unparseable record is equally non-executable). Minor consistency note in the same area: `shouldScannerAttemptLock` uses a raw `readFile`+`JSON.parse` at `:900` while every other read in the module goes through `readPrivateJson`.

### [LOW] One poisoned due job delays every other due job by a full scan interval

- **Where**: `src/services/deferredContinuationRunner.ts:258-261` and `:275-282`
- **Type**: correctness
- **What**: inside the `for (const candidate of await listDueDeferredContinuations(now))` loop, a job with a non-restorable model/permission mode, or one whose transcript cannot be read, is stopped for attention and then the function `return null`s — abandoning the remaining due candidates. The lock-loss case a few lines up correctly uses `continue` (`:236`).
- **Trigger / why it matters**: with N unrunnable jobs queued, a healthy job waits N launchd ticks (N minutes). Bounded, but it is an unintended asymmetry with the sibling branch and costs real latency on a feature whose whole point is firing promptly after a reset.
- **Fix**: `await guard.release(); continue` in both places.

### [LOW] Non-macOS `/continue-after-limit disable-background` shows the user a raw `TypeError`

- **Where**: `src/services/deferredContinuationLaunchAgent.ts:48` and `:297`
- **Type**: correctness / convention (user-visible text)
- **What**: `getDeferredContinuationLoadState` does `process.getuid!()`. On Windows `process.getuid` is undefined. `uninstallDeferredContinuationLaunchAgent` lstats a `~/Library/LaunchAgents` path that cannot exist, takes the `ENOENT` branch, and calls `getDeferredContinuationLoadState` — throwing a `TypeError` that escapes and is printed verbatim by `continue-after-limit.tsx:325` (`onDone(error.message)`). `install` guards the platform (`:119-121`); `uninstall` and status do not. Relatedly, `enable-background` on a non-macOS host reports "Background continuation requires a stable installed Cat Code executable", which misdiagnoses an unsupported platform as a bad install.
- **Fix**: early-return `{ state: 'disabled' }` / `false` from the launch-agent module when `process.platform !== 'darwin'`.

### [LOW] `RESTORABLE_BACKGROUND_PERMISSION_MODES` is an untyped `Set<string>`

- **Where**: `src/services/deferredContinuationRunner.ts:89-94`
- **Type**: types
- **What**: the set of permission modes safe to restore unattended is written as bare string literals with no link to `PermissionMode` / `PERMISSION_MODES` (`src/types/permissions.ts:16-38`). The exclusion of `bypassPermissions` and `auto` is a security decision, and `dontAsk` is included because it converts `ask` to `deny` (`src/utils/permissions/permissions.ts:521-535`) — all correct today, and all invisible to the compiler.
- **Trigger / why it matters**: renaming or adding a mode silently changes which unattended runs are allowed. A rename makes every job stop with `permission_restore`; an addition silently opts the new mode in or out with no review.
- **Fix**: `new Set<PermissionMode>([...])`, so a removed member is a compile error.

### [LOW] Em dash in user-visible strings

- **Where**: `src/services/deferredContinuationPresentation.ts:82,92,99,117`; `src/services/deferredContinuation.ts:796`; `src/hooks/useDeferredContinuation.ts:155`; `src/commands/continue-after-limit/continue-after-limit.tsx:109,186,199,217`
- **Type**: convention
- **What**: `Status: Stopped — needs you`, `Nothing to cancel — no continuation is scheduled…`, etc.
- **Trigger / why it matters**: flagged because the review contract states the rule for anything a user can read. Honest baseline: `rg -c '—' src --glob '!*.test.*'` reports ~6,771 matching lines across the engine, and CLAUDE.md's own verification command scopes the check to `app/renderer/src`. Treat this as a judgement call for the owner, not a defect — but this is new code, so it is the cheap moment to decide.
- **Fix**: `Status: Stopped, needs you` / `Nothing to cancel. No continuation is scheduled for this conversation.` if the rule is meant to apply to `src/`.

## What is good here

- **Durability is textbook and I could not fault it.** `atomicWriteJson` (`deferredContinuation.ts:330-350`): `O_EXCL|O_NOFOLLOW` temp at 0600, write, `fsync`, `rename`, `chmod`, `fsync` of the destination directory. `readPrivateJson` (`:352-370`) lstats, then re-stats the open handle and compares `dev`/`ino` to defeat a swap between check and open. There is no truncate-then-write anywhere, and no partial-write window.
- **The tombstone invariant is reasoned about rather than assumed.** `moveDeferredContinuationToHistory` writes history *before* unlinking pending, `terminalHistoryExists` treats any record at `history/<jobId>.json` as authority *even when it fails to parse* (`:377-396`), and the retention pass refuses to delete a tombstone any surviving pending record still references (`:566-632`). The comment explains precisely which crash window each rule closes. Corrupt state fails closed everywhere: `listDueDeferredContinuations` skips malformed records rather than executing them, and the one no-exit trap that created (an unreadable record blocking every prompt) has a named, tested escape via `discardUnreadableDeferredContinuation`.
- **Re-entrancy is closed and *proved*, not asserted.** Two-lock ordering with `retries: 0`, a re-read of the record under the lock before every transition, and `assertHealthy()` re-asserted immediately before each durable write with a comment naming the window it covers. `deferredContinuation.probe.test.ts` spawns real processes: two racers yield exactly one acquirer, a fresh worker loses cleanly to a foreground lock, an active submitted job does not starve an unrelated session, and a lock-losing owner provably writes no terminal descendant. That last one waits out a real `proper-lockfile` update tick rather than faking a compromise.
- **The LaunchAgent is the careful version of a pattern this repo already has a sloppy version of.** Fixed namespaced label, no interpolation into the plist except an XML-escaped absolute path, `execFile` with an argv array (no shell anywhere, no `shell: true`), atomic plist write, explicit user consent dialog, and — the part that matters — it never claims an install or uninstall it could not verify, because `launchctl bootout`'s exit code is ambiguous. Compare `src/commands/install-agents/install-agents.ts:142,155,189`, which shells out with unescaped interpolation and swallows every error. Worth noting the two now duplicate plist rendering, install, and uninstall; the older one should be retired onto this implementation rather than the reverse.
- **Quota state is delegated, not re-derived** (your item 5). The subsystem reuses `buildCodexStatus` → `getCodexAccountAvailability`/`getPoolStatus` (`src/services/api/codexStatus.ts:452-498`) and the `DeferredTerminalFailureV1` envelope minted by `withRetry.ts:417-444`. There is no parallel exhaustion classifier and no re-implemented reset math. HIGH-1 is a misuse of that shared machinery, not a duplicate of it — which is the good news, because the fix is one option flag rather than a rewrite.

## Not reviewed / uncertain

- **`activeSessionId` staleness in the hook.** `useDeferredContinuation` reads `getSessionId()` during render (`:33`) and keys its effect on it. Whether a mid-session `switchSession` (fork, `/resume`) reliably re-renders `REPL.tsx` and re-runs the effect is not something I traced; if it does not, the effect polls a stale session id. Resolved by a test that mounts, switches session, and asserts the second session's job is picked up.
- **Upgrade survival of the pinned executable path.** `validateStableDeferredContinuationExecutable` stores `realpath(process.execPath)` in the plist, deliberately resolving symlinks. On this machine `~/.local/bin/cat-code` is a symlink to a fixed path, so an in-place upgrade is fine; an installer that swaps the symlink to a versioned binary would silently leave the plist pointing at a deleted file, and the only surface that reports it is `/continue-after-limit status`. I could not determine the shipped install layout (`install.sh` is flagged known-stale in CLAUDE.md). Resolved by confirming how releases replace the binary.
- **`launchd` `StartInterval` catch-up semantics after sleep.** The user copy claims a run "after wake or login" (`continue-after-limit.tsx:64-69`). That matches documented `StartInterval` behaviour but I did not verify it on this OS version, and it is the claim the whole "machine asleep at the scheduled moment" story rests on.
- **HIGH-1 is proved by source reading only.** I did not run it: doing so needs a real capped Codex pool, which the contract puts out of bounds. Every step is cited above and each is a direct assignment or return, so I am confident, but a single test that seeds a capped pool and asserts `evaluateDeferredContinuationEligibility` returns `schedule` rather than `run_now` would settle it in a minute — and is the regression test the fix needs anyway.
