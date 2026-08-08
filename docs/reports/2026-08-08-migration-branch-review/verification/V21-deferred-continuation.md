# S01 adversarial validation: deferred continuation subsystem

> **Verification provenance:** `claude-opus-5`, high effort, single subagent session.
> Source review plus **four standalone scratch repro scripts** that import the real
> repo modules against scratch `CLAUDE_CONFIG_DIR` / `HOME` roots
> (`scratchpad/v21/{high1-repro,abandon-repro,null-and-growth,low1}.ts`), plus
> **one focused test file run** — `bun test src/services/deferredContinuation.probe.test.ts`
> (6 pass / 0 fail, 22.22s) — and one timing measurement of the built `./cli-dev`
> worker against a scratch config dir. No repo file was edited except this report.
> No GUI, no `bun run --cwd app dev`, no full suite, no network: every
> `buildCodexStatus` call in the repros used `refresh: 'never'` or an injected
> `fetchUsage`, and no real vault or real `~/.cat-code` queue was read or written.
> Branch `migration` at `a1012b1`.

## Overall verdict

The original report is **substantially right**. Eleven of thirteen findings are
confirmed outright, one is confirmed with a narrower trigger than described, and
none is invalid. Its headline (HIGH-1) is not just real, it is **worse than
stated**: I built the exact scenario and the live pool went from
`decision: wait` / `eligibility: schedule` to `decision: delegate` /
`eligibility: run_now` purely because `buildCodexStatus` reloaded the pool, and a
usage snapshot explicitly reporting both accounts limit-reached did **not**
rescue it. Every file in this scope is **branch-new** (including
`loadPoolForObservation`, which does not exist on `main`), so unlike the
account-pool scope, everything here **is** introduced by this branch.

Where the report is wrong is in what it praised. Its "Re-entrancy is closed and
*proved*" verdict does not survive: `abandonForegroundDeferredAttempt`
(`deferredContinuationRunner.ts:460`) has **zero production call sites** — it is
referenced only by its own unit test, which is literally named *"abandonment
settles the waiter instead of stranding it and both locks forever"*. The queued
continuation command is `mode: 'prompt'`, `isMeta: false`, i.e.
`isQueuedCommandEditable === true`, so **pressing ESC or UP-arrow pops it out of
the queue**, and `clearCommandQueue()` drops it outright. I reproduced the
result: both filesystem locks held for the process lifetime, the job stuck at
`submitted`, every subsequent human prompt refused with "A scheduled continuation
is already in progress", and `/continue-after-limit cancel` unable to take the
lock. That is the single most important thing in this scope after HIGH-1, and the
report missed it while giving the area a clean bill.

The report's one soft spot among its own findings is HIGH-2: the mechanism and
consequence are exactly as described and I reproduced the `null` return, but its
two named triggers are narrower than claimed inside a single-threaded process,
and "permanently" is bounded by the effect's `activeSessionId` dependency.

The parent's warning about the account-pool premises is borne out: the
"Note on the pool race you asked about" embedded in MED-3 is now **void** —
`persistNextQuarantineProbe` was proven harmless (V24 F1 INVALID) and
`runQuarantineProbeOnce` (`codexTokenRefresh.ts:811-825`) does **zero disk I/O**
unless an account is already `quarantined`, which the note does not say.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| F1 | HIGH | Eligibility observes a pool it wiped; `schedule` unreachable | **CONFIRMED** | Repro: live pool `wait`/`schedule` → after reload `delegate`/`run_now`; usage snapshot does not rescue it |
| F2 | HIGH | `if (!attempt) return` kills the poll loop | **PARTIALLY CONFIRMED** | `null` return reproduced and the branch really has no timer, but the trigger is a narrow race and a session switch re-arms it |
| F3 | MED | Unattended background run has no turn/budget/deadline cap | **CONFIRMED** | `--max-turns` has no default and the rewritten argv omits it; `error_max_turns`/`error_max_budget_usd` branches are dead |
| F4 | MED | `enable-background` replaces every install error with a wrong one | **CONFIRMED** | Bare `catch {}` at `:275`; the darwin guard's own message is among the ones it swallows |
| F5 | MED | Empty-queue check behind the full CLI graph, 1,440×/day | **CONFIRMED** | Measured 110 ms vs 50 ms for the zero-import fast path; also materializes the queue tree every tick |
| F6 | MED | Store/runner boundary leaks policy; reset clamp duplicated | **CONFIRMED** | Both clamps present at `:1193` and `:597` with different first arguments |
| F7 | MED | Retry/reschedule policy has zero behavioural coverage | **CONFIRMED** | `transientRetries: 0` in all six fixture files; nothing reaches `applyAttemptResult`'s reschedule arms |
| F8 | LOW | Notice formatter has no tripwire and can return `undefined` | **CONFIRMED** | Reproduced under the repo's own compiler options: zero tsc errors, prints `undefined` |
| F9 | LOW | `locks/` and `tmp/` grow unbounded; one corrupt record disables pruning | **CONFIRMED** | Repro: 5 jobs → 10 permanent lock files; a truncated record made prune remove 0 of 4 expired tombstones |
| F10 | LOW | One poisoned due job delays every other due job | **CONFIRMED** | `return null` at `:260` and `:282` vs `continue` at `:236`; bounded at N ticks |
| F11 | LOW | Non-macOS `disable-background` shows a raw `TypeError` | **CONFIRMED** | `process.getuid!()` at `:48` is reached only from `uninstall`; `install` is guarded, status is not affected |
| F12 | LOW | `RESTORABLE_BACKGROUND_PERMISSION_MODES` is an untyped `Set<string>` | **CONFIRMED** | Bare literals, no link to `PermissionMode`; the exclusions are a real security decision |
| F13 | LOW | Em dash in user-visible strings | **CONFIRMED** | All ten cited sites exist and are user-visible |

## Per finding

### F1 — [HIGH] Eligibility observes a pool it wiped one line earlier; `schedule` is unreachable in its own primary scenario

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes, every citation. `evaluateDeferredContinuationEligibility`
  calls `buildCodexStatus({ refresh: 'auto' })` at `deferredContinuation.ts:1169`
  with no `loadPool`; `applyAttemptResult` does the same at
  `deferredContinuationRunner.ts:578`. `buildCodexStatus` sets
  `const loadPool = options.loadPool !== false` (`codexStatus.ts:414`) and calls
  `loadPoolForObservation()` at `:417-419`. That function assigns
  `pool.accounts = mergePoolAccounts(vaultAccounts, configAccount)`
  (`codexAccountPool.ts:188`) — a brand-new array from `loadVaultAccounts`
  (`:932-1024`), whose `results.push` (`:998-1013`) sets no `status:'capped'`,
  no `cappedAt`, no `usageAllowed`, no `usageLimitReached`, no `usageResetAt`,
  and resets `lastUsedAt` to 0. `markPoolAccountCapped` (`:469-489`) writes all
  of those to the in-memory `acct` only. `decide()` returns `delegate` on
  `pool.candidate >= 1` (`codexStatus.ts:386-388`).
- **Reachable in production?**: Yes, on the only path there is. `/continue-after-limit`
  with no argument calls `evaluateDeferredContinuationEligibility` **without**
  a `buildStatus` override (`continue-after-limit.tsx:376-380`), so the default
  `buildCodexStatus({refresh:'auto'})` runs. The trigger state is minted by the
  same process: `getCodexExhaustionDiagnosticCode` (`withRetry.ts:167-177`)
  returns `quota.exhausted` only when `capped === counts.total` **in memory**, and
  `terminalCodeForCodexExhaustion` turns that into the durable
  `quota_exhausted` the command keys on. No env gate, no feature flag, no
  test-only path. The reason no test caught it: every `buildCodexStatus` test
  passes `loadPool: false` (`codexStatus.test.ts:130,159,181,204,229,296,309,420`),
  and every eligibility test injects `buildStatus`, so the real reload is never
  exercised.
- **Trigger**: Two vault accounts, both capped by 429s, then `/continue-after-limit`.
  Constructed and executed:

  ```
  loaded      : bbbbbbbb:healthy aaaaaaaa:healthy
  after cap   : bbbbbbbb:capped/usage_cap allowed=false reset=1786164902 cappedAt=true
                aaaaaaaa:capped/usage_cap allowed=false reset=1786164902 cappedAt=true
  withRetry   : capped 2 of 2 => quota_exhausted? true
  decision(loadPool:false): wait  quota_blocked_reset_known  not_before= 2026-08-08T04:55:02.000Z
  after reload: bbbbbbbb:healthy/undefined allowed=undefined reset=undefined cappedAt=false
                aaaaaaaa:healthy/undefined allowed=undefined reset=undefined cappedAt=false
  decision(loadPool:true) : delegate  candidate_available  not_before= null
  ELIGIBILITY (production default path): {"action":"run_now","observedAt":1786162202365}
  ELIGIBILITY (loadPool:false control) : {"action":"schedule","resetAt":1786164902000,"notBefore":1786164962000}
  ```

  The decision inverts, and the pool the REPL is still using comes back healthy.
- **Counter-arguments considered**: I attacked this four ways. (a) **Does the pool
  reload to the same state?** No — `getVaultRefreshPoolStatus` (`:1159-1210`)
  derives status from the vault `refresh` block and `last_refresh` age only, so a
  capped-but-token-fresh account reloads as `healthy`, which the repro shows.
  (b) **Is the decision taken from a different source?** No —
  `evaluateDeferredContinuationEligibility` reads only `status.decision.action`.
  (c) **Does the `refresh: 'auto'` usage poll rescue the classification?** This
  was the strongest possible rescue and it **fails**: `classifyProfile(account, now)`
  (`codexStatus.ts:206-233`) takes no `usage` argument, and
  `fetchPoolUsage({updateRoutingHints:false})` never calls
  `updateRoutingHintsFromUsage` (`codexUsage.ts:299-301`), so the poll result is
  never stamped on the accounts. I injected a snapshot reporting
  `allowed:false, limitReached:true` for **both** accounts and still got
  `delegate candidate_available`. (d) **Is the consequence chain real?**
  `applyAttemptResult`'s reschedule arm is gated on
  `status.decision.action === 'wait'` (`:590`); with a fully-capped live pool the
  same builder returns `delegate`, so the `else` fires and the job is tombstoned
  with `quota_reset_unknown` — "A reliable Codex reset time is unavailable"
  (`deferredContinuationPresentation.ts:41-44`).
- **True consequence**: All three consequences the report listed hold.
  (a) `schedule` is unreachable in the fully-capped scenario the feature exists
  for; the command prints "A usable Codex account is available, so continuation
  will start now" (`continue-after-limit.tsx:413`) and submits a turn that 429s.
  (b) The live REPL's shared `pool` object is un-capped as a side effect, so the
  next ordinary turn re-burns a 429 per account. (c) The quota retry ladder can
  never re-arm; it terminates for attention on the first attempt.
- **Evidence**: `scratchpad/v21/high1-repro.ts` (output above), run as
  `HOME=<scratch> NODE_ENV=test bun run high1-repro.ts` against a fake two-account
  vault. Provenance: `git cat-file -e main:src/services/api/codexStatus.ts` fails
  and `git show main:src/services/api/codexAccountPool.ts | grep loadPoolForObservation`
  is empty — **both `codexStatus.ts` and `loadPoolForObservation` are branch-new**,
  so this finding is introduced by `migration`.
- **Disposition**: Apply the report's fix — it is correct and I verified its
  safety claim. `src/cli/handlers/codexStatus.ts` calls `buildCodexStatus({refresh})`
  with no pool init of its own, so `loadPool: !getPoolStatus().initialized` is
  `true` there and the subcommand is unchanged; and if `preAction`'s
  `void initAccountPool()` has already landed, that path also called
  `loadPoolForObservation`, so the data is identical either way. **Two additions
  I would insist on.** First, do not leave `loadPoolForObservation` as a
  foot-gun any caller can re-trip: either rename it to
  `loadPoolForObservationDestructive` or make it a no-op (with a debug log) when
  `pool.initialized` is already true — the bug is that a function named
  "for observation" silently destroys observed state. Second, the report's
  proposed regression test is the right one and must seed a **capped** pool and
  assert `schedule`, not `run_now`; a test that injects `buildStatus` reproduces
  exactly the blind spot that let this ship. Do **not** attempt to fix this by
  making `classifyProfile` consult the usage snapshot instead — that is a
  separate defect (see *Findings the original report missed*) and fixing it
  would not restore `cappedAt`/`runtime_cap` state that no poll can see.

### F2 — [HIGH] `if (!attempt) return` permanently kills the continuation poll loop

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes. `useDeferredContinuation.ts:138` is exactly
  `if (!attempt) return`, with no `setTimeout`. Every sibling exit re-arms
  (`:89`, `:104`, `:114`, `:120`, `:134`, `:150`, `:157`), and the file's own
  comment at `:85-88` states the rule the branch breaks. The `null` return sites
  in `beginForegroundDeferredContinuation` are at `:697-705` as cited.
- **Reachable in production?**: The branch is reachable but only through a race,
  and the two races the report names are narrower than it says **inside a single
  process**. `beginForegroundDeferredContinuation` returns `null` only when, under
  the lock, the record is gone / has a different `jobId` / is no longer `pending`.
  A competitor that is *holding* the locks makes the hook's zero-retry acquire
  throw `ELOCKED`, which lands in the `catch` at `:132` and **does** re-arm. So
  the competitor must acquire, transition and release entirely between the hook's
  read at `:81` and its lock acquisition inside `begin`. In-process that means the
  human-prompt guard (`deferredContinuation.ts:775-861`, wired at
  `handlePromptSubmit.ts:228`) or `/continue-after-limit cancel` must complete its
  whole critical section inside the hook's gap — achievable, because the hook's
  gap contains ~15 filesystem operations of `ensureDeferredContinuationStore` +
  `ensureLockTarget` + `lock()`, and widest on the one branch that awaits
  `getDeferredContinuationBackgroundStatus()` (`:128`, the
  first-poll/hard-quota/overdue case). Cross-process, a background worker that
  takes the short refuse path (`deferredContinuationRunner.ts:250-261`, e.g. a job
  saved in `bypassPermissions`) tombstones and releases in milliseconds and can
  land in the same gap.
- **Trigger**: I reproduced the exact state deterministically rather than argue
  probability — a competitor tombstones the record under the lock, then the hook
  calls `begin` with its stale `job`:

  ```
  (a) begin() with the record tombstoned under the lock => null (no throw) -> hook hits `if (!attempt) return`
  (b) begin() when the record moved to submitted        => null
  ```

  Both return `null`, not a throw, so neither reaches the re-arming `catch`.
- **Counter-arguments considered**: (a) **Does anything re-arm the loop?** The
  effect deps are `[activeSessionId, setMessages]`. `setMessages` is
  `useCallback(..., [])` at `REPL.tsx:1304-1328` — stable for the component's
  life, so it never re-runs the effect. `activeSessionId` is `getSessionId()`
  (`bootstrap/state.ts:447-449`), which **does** change on `switchSession`
  (`:495-507`) and `regenerateSessionId` (`:460-477`) — so `/clear`, `/resume`
  and fork re-render REPL and re-run the effect. "Permanently" is therefore
  bounded by the *session*, not the process, and the report's own wording
  ("for the session's lifetime") is the accurate one; the finding title
  overstates it. (b) **Is the lost work real?** Yes. From that point the session
  consumes no further notice, so background-worker outcomes for that session are
  never rendered, and a newly scheduled continuation is never picked up.
  (c) **Could the branch be intentional?** No — every other exit re-arms, and the
  file carries a comment explaining why.
- **True consequence**: In a narrow but real race the session's continuation poll
  loop stops silently until the user runs `/clear` or `/resume`. No message, no
  error. Worth noting: the success tail at `:139-160` is also outside any
  `try`, so a throw from `show()` or `enqueue()` kills the loop the same way and
  raises an unhandled rejection from `void check()` — the same class of hole, one
  the report did not name.
- **Evidence**: `scratchpad/v21/null-and-growth.ts` (output above);
  `useDeferredContinuation.ts:138` vs `:89/:104/:114/:120/:134/:150/:157`;
  `REPL.tsx:1304-1328`, `:4713`; `bootstrap/state.ts:447-449,460-477,495-507`.
  Test-blindness confirmed: the hook's mock at
  `useDeferredContinuation.test.ts:144-153` always returns
  `{ command, finished }`, never `null`. Branch-new file.
- **Disposition**: Apply the report's one-line fix — replace the bare `return`
  with the same 1 s re-arm the sibling `catch` uses. It is strictly correct: a
  `null` from `begin` means "someone else owns or ended this job", which is
  precisely the state the poll loop exists to observe. **Go one step further than
  the report and make the class impossible**: wrap the whole body of `check()`
  from `:93` down in a `try/finally` that schedules the next tick unless
  `canceled`, so no future exit can forget the timer. That also closes the
  unguarded success tail at `:139-160`. Add the hook test the report proposes
  (`beginForegroundDeferredContinuation` resolves `null`, assert a second poll
  happens); it is one fixture line given the existing mock.

### F3 — [MED] The unattended background continuation runs with no turn cap, no budget cap, and no deadline, while holding the session lock

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `main.tsx:616-621` rewrites argv to exactly
  `[prompt, '--print', '--resume', sessionId, '--model', model, '--permission-mode', mode, '--output-format', 'json']`
  — no `--max-turns`, no `--max-budget-usd`. `main.tsx:2941-2942` passes
  `maxTurns: options.maxTurns` / `maxBudgetUsd: options.maxBudgetUsd` straight
  from the parsed CLI options, and neither option declares a `.default()`
  (`main.tsx:1029`, `new Option('--max-turns <turns>', …).argParser(Number)`), so
  both are `undefined`. `classifyDeferredHeadlessResult` handles
  `error_max_turns` / `error_max_budget_usd` at `:177-182`, and those branches are
  therefore dead.
- **Reachable in production?**: Yes, for any user who ran
  `/continue-after-limit enable-background`. `preparedBackgroundAttempt` holds the
  guard across the whole run (`:293`, released only in
  `completePreparedBackgroundDeferredContinuation`/`fail…`), and the guard's
  abort signal is wired into headless (`main.tsx:2965`) but fires only on
  `onCompromised` — `proper-lockfile` refreshes the lock mtime every
  `DEFERRED_LOCK_UPDATE_MS` (20 s, `deferredContinuation.ts:231,929`), so a merely
  long run never compromises it.
- **Trigger**: A scheduled continuation resumes a long conversation unattended in
  a saved `acceptEdits` mode (`RESTORABLE_BACKGROUND_PERMISSION_MODES`,
  `:89-94`) and loops. Meanwhile the user's own session is hard-blocked: I
  reproduced the refusal text in the abandonment repro
  ("A scheduled continuation is already in progress"), and `cancel` refuses
  `submitted` (`continue-after-limit.tsx:221-227`).
- **Counter-arguments considered**: I looked for an implicit bound and found two
  partial ones the report did not credit. (a) **Quota is a real backstop**: the
  run exists because the pool was capped, so a runaway burns one reset window and
  then terminates with `quota_exhausted`. (b) **Context is a bound**: autocompact
  plus `model_context_window_exceeded` produces the `context_window` terminal
  outcome. Neither is a *cap* — they are exhaustion — and neither bounds tool side
  effects, so the finding survives. I also checked whether the consent copy
  discloses this: `continue-after-limit.tsx:285` says only that it "runs only Cat
  Code's fixed continuation worker and does not store prompts or credentials".
- **True consequence**: As claimed, with the severity calibration that the run is
  practically bounded by the quota window rather than truly unbounded. The
  user-facing hole is the absence of any stop control while it runs.
- **Evidence**: `main.tsx:616-621`, `:1029`, `:2941-2942`, `:2965-2978`;
  `deferredContinuationRunner.ts:89-94`, `:177-182`, `:293`;
  `scratchpad/v21/abandon-repro.ts` for the blocked-prompt text. Branch-new.
- **Disposition**: Apply the report's fix (append a conservative `--max-turns`,
  and `--max-budget-usd` if a default is agreed) at `main.tsx:621` — both outcomes
  already have terminal handling and user copy, so it is additive. **Two things
  the report did not ask for that I would pair with it**: extend the consent
  dialog at `:285` to state that the run is an agentic turn in the saved
  permission mode (one sentence, no em dash), and give the running attempt a stop
  path — today `/continue-after-limit cancel` refuses `submitted` and there is no
  other control.

### F4 — [MED] `enable-background` discards every actionable install error and replaces it with a wrong one

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `continue-after-limit.tsx:275-280` is a bare
  `catch {` around the whole `installDeferredContinuationLaunchAgent` call,
  emitting the fixed executable string. The messages it swallows are at
  `deferredContinuationLaunchAgent.ts:247` (previous job still loaded, plist kept),
  `:248` (could not verify the unload), and `:277-279` (bootstrap failed, with
  three distinct recovery suffixes at `:272`, `:273`, `:275`). The sibling
  `disable-background` does the opposite at `:320-328` and explains why in a
  comment.
- **Reachable in production?**: Yes; no gate. Every one of those throws is on the
  normal `enable-background` path.
- **Trigger**: A stuck launchd job. `launchctl bootout` leaves the job loaded,
  `getDeferredContinuationLoadState` returns `loaded`, install throws the
  `:247` message naming the plist path — and the user is told to reinstall Cat
  Code.
- **Counter-arguments considered**: I checked whether the blanket catch might be
  defensible because the *most common* failure really is the executable check —
  it is not, and it is worse than the report says: on a non-macOS host the
  **platform** error from `validateStableDeferredContinuationExecutable:119-121`
  ("Background continuation is only supported on macOS") is also swallowed and
  replaced with the executable message, which is how F4 and F11 interlock. I also
  checked whether the raw message could leak anything sensitive: it contains the
  plist path under the user's own `~/Library/LaunchAgents`, which
  `disable-background` already surfaces, so there is no new disclosure.
- **True consequence**: Exactly as claimed, plus the non-macOS misdiagnosis.
- **Evidence**: `continue-after-limit.tsx:264-280` vs `:316-329`;
  `deferredContinuationLaunchAgent.ts:119-121,242-250,256-280`. Branch-new.
- **Disposition**: Apply the report's fix, mirroring `disable-background`.
  **One correction to its wording**: keeping "the executable-specific copy only
  for the `validateStableDeferredContinuationExecutable` failure" is not
  implementable as a single catch, because that function throws four different
  messages including the platform one. Surface `error.message` for everything —
  all four strings it throws are already written as user-facing prose naming the
  concrete requirement — and drop the fixed string entirely.

### F5 — [MED] The empty-queue check sits behind the entire CLI module graph, and launchd runs it 1,440×/day forever

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. The worker branch is at `main.tsx:616-621`,
  inside `main()`, and `src/main.tsx` has exactly **172** static `import`
  statements (`grep -c '^import ' src/main.tsx`). The plist sets `RunAtLoad` +
  `StartInterval 60` at `deferredContinuationLaunchAgent.ts:103-106`. The
  `cli.tsx` precedent is real: "All imports are dynamic to minimize module
  evaluation for fast paths" at `:40-41`, and the `touch-all` fast path at
  `:66-81` exists verbatim for macOS LaunchAgents.
- **Reachable in production?**: Yes, on every machine that enabled the feature.
  Nothing self-disables when the queue drains; the only removal is
  `/continue-after-limit disable-background`.
- **Trigger**: Enable background continuation and let the queue drain.
- **Counter-arguments considered**: I measured the cost rather than assume it,
  using the built `./cli-dev` against a scratch `CLAUDE_CONFIG_DIR` (3 runs each):
  `--version` (zero-import fast path) **0.05 s**, `deferred-continuation-worker`
  with an empty queue **0.11 s**. So the marginal cost of not following the
  `cli.tsx` precedent is ~60 ms once a minute — about 0.1% of one core, ~86 s of
  CPU per day. That is real but small, and the report's unquantified "the cost is
  paid once a minute, forever" reads heavier than the number supports. One factual
  correction in the other direction: the report says the empty case is "a handful
  of `readdir`s on a directory that usually does not exist" — it is not read-only.
  `prepareBackgroundDeferredContinuation:214` → `pruneDeferredContinuationHistory`
  → `ensureDeferredContinuationStore` **materializes** `deferred-continuations/{pending,history,locks,tmp}`
  on every tick; my scratch config dir was created from empty by the first run.
- **True consequence**: A design/hygiene defect with a measured ~60 ms/minute
  cost, not a user-visible one. Worth fixing because the precedent and the
  mechanism already exist next door.
- **Evidence**: `/usr/bin/time -p ./cli-dev --version` vs
  `/usr/bin/time -p ./cli-dev deferred-continuation-worker` with
  `CLAUDE_CONFIG_DIR` pointed at `scratchpad/v21/cfg3`; `find` of the created
  tree. Branch-new.
- **Disposition**: Apply the report's fix (hoist the branch into `cli.tsx` next to
  `touch-all`, dynamically import the runner, and only
  `await import('../main.js')` when a job was claimed) — but file it as **LOW**,
  not MED, on the measured cost. **Reject the embedded "Note on the pool race"
  outright**: it is now void. `persistNextQuarantineProbe` was proven not to
  destroy an in-flight rotation (V24 F1, INVALID — line 913 spreads
  `...refreshState`, preserving `attempt_id`, and writes via `atomicWriteJson`),
  and `runQuarantineProbeOnce` (`codexTokenRefresh.ts:811-825`) filters to
  `status === 'quarantined'` accounts and performs **zero disk I/O** when none
  are, so the worker adds no writer at all on a healthy pool. Do not carry that
  paragraph into any follow-up.

### F6 — [MED] The `deferredContinuation` / `Runner` boundary leaks scheduling policy, and the reset clamp is duplicated

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes, all of it. `deferredContinuation.ts:1193` is
  `notBefore: Math.max(now, resetAt + 60_000)`; `deferredContinuationRunner.ts:597`
  is `const notBefore = Math.max(result.observedAt, resetAt + 60_000)` with the
  comment "Same clamp the scheduler applies". File sizes match (1201 / 793 lines).
  `prepareHumanPromptAgainstDeferredContinuation` (lock + notice + history move)
  is at `deferredContinuation.ts:775-861`. The transcript reader is at `:1051`
  and the metadata extractor at `deferredContinuationRunner.ts:102`.
- **Reachable in production?**: N/A — design finding; both modules are live.
- **Trigger**: N/A. The checkable instance is the duplicated clamp: the "+60 s
  after reset" grace and the "never in the past" rule must change in two files.
- **Counter-arguments considered**: I checked whether the two clamps are actually
  *different* policies that only look alike — they are not the same expression
  (one clamps to `now`, the other to `result.observedAt`), but that difference is
  the argument, not the policy, so a single
  `computeContinuationNotBefore(observedAt, resetAt)` covers both exactly. I also
  checked whether the "leak" is only stylistic: it is not — the human-prompt guard
  in the store module performs lock acquisition, notice writes and a history move,
  which is the runner's stated job, and it is the one place a durable transition
  happens outside the runner's `authority.assertHealthy()` discipline (it passes
  `guard` explicitly at `:843`, so it is correct today, but nothing structural
  keeps it that way).
- **True consequence**: As claimed.
- **Evidence**: `deferredContinuation.ts:1189-1194`, `:775-861`, `:1051`;
  `deferredContinuationRunner.ts:589-617`, `:102`. Branch-new.
- **Disposition**: Apply the report's fix — export one
  `computeContinuationNotBefore(observedAt, resetAt)` and call it from both. Do
  **not** take on the larger boundary re-shuffle (moving
  `prepareHumanPromptAgainstDeferredContinuation` into the runner) in the same
  change: it would create an import cycle between the two modules and it touches
  the one function that guards every human prompt in the app. Extract the clamp;
  leave the boundary alone unless it is re-designed deliberately.

### F7 — [MED] Retry/reschedule policy — the part that decides whether a continuation re-arms — has zero behavioural test coverage

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `applyAttemptResult` is
  `deferredContinuationRunner.ts:551-684`. `attempt.number` is
  `z.number().int().positive()` (`deferredContinuation.ts:157`) with no ceiling,
  while `transientRetries` is `.min(0).max(3)` (`:162`).
  `NETWORK_RETRY_DELAYS[job.transientRetries]` at `:629` is the only bound on the
  network ladder; the quota re-arm guard is `resetAt > (job.resetAt ?? 0)` at
  `:592`.
- **Reachable in production?**: N/A — test-gap finding. The gap itself is verified:
  `rg 'transientRetries' --glob '*.test.ts' src/` returns `transientRetries: 0` in
  all **six** fixture files (`deferredContinuationRunner.test.ts:70`,
  `deferredContinuation.test.ts:179`, `useDeferredContinuation.test.ts:70`,
  `deferredContinuation.probe.test.ts:64`, `continue-after-limit.test.ts:40`,
  `sessionRestore.deferred.test.ts:93`) and nothing else.
- **Trigger**: N/A.
- **Counter-arguments considered**: I tried to find coverage the report missed.
  (a) `applyAttemptResult` is not exported, but it *is* reachable through
  `beginForegroundDeferredContinuation` → `finalizeDeferredAttempt`, and the
  runner test does call `begin` at `:165` and `:257` — so I read both. Both settle
  with `outcome: 'completed'` and both are terminal-barrier tests that
  deliberately fail *before* `applyAttemptResult` runs
  (`expect(...state).toBe('submitted')`). (b) The "typed result policy" test at
  `:289` exercises `classifyForegroundDeferredAttempt`, i.e. classification, not
  application. (c) `reconcileDeferredContinuationJob` — the other route into
  `applyAttemptResult` — has no test at all. So no test reaches the quota or
  network arms. The report's four sub-claims all hold, including that HIGH-1
  makes sub-claim 2's branch unreachable in production.
- **True consequence**: As claimed. Every one of these fails by quietly stopping
  the job with a plausible "needs you" message.
- **Evidence**: greps above; `deferredContinuationRunner.test.ts:157-300`;
  `deferredContinuation.ts:157,162`. Branch-new.
- **Disposition**: Apply the report's fix, with one change to make it possible:
  `applyAttemptResult` has **no injection seam** for the status builder — unlike
  `evaluateDeferredContinuationEligibility`, which takes `buildStatus`. Give
  `applyAttemptResult` (and through it `finalizeDeferredAttempt` /
  `reconcileDeferredContinuationJob`) an optional `buildStatus` parameter
  defaulting to `buildCodexStatus`, or the three proposed tests cannot be written
  without `mock.module`. Sequence this **after** F1: the quota→reschedule test is
  the regression test F1's fix needs anyway, and writing it against today's code
  would pin the broken behaviour.

### F8 — [LOW] `formatDeferredContinuationNotice` has no exhaustiveness tripwire and can return `undefined`

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. The switch is
  `deferredContinuationPresentation.ts:105-135` with no `default`, unlike both
  siblings (`deferredContinuation.ts:853-856`,
  `deferredContinuationRunner.ts:679-682`, both with
  `const exhaustive: never = …`). `formatDeferredContinuationStopped(reason: string)`
  is at `:23`, and `notice.notBefore!` appears at `:126` and `:131`.
- **Reachable in production?**: The defect arms when the union is extended at
  `deferredContinuation.ts:695-703`. The premise is verified: root `tsconfig.json`
  sets `"strict": false` and declares no `noImplicitReturns`, so a fall-through
  in a `: string` function is not an error.
- **Trigger**: Add a `kind`. I proved it with the repo's own compiler options:

  ```
  // low1.ts — same shape, one unhandled member
  low1.ts(11,1): error TS2584: Cannot find name 'console'   ← the ONLY diagnostic
  tsc exit=2
  $ bun run low1.ts
  undefined
  more
  ```

  Zero diagnostics on the non-exhaustive switch, and the caller's
  `let text = format(...); text += ...` renders the literal string `undefined` —
  exactly the `useDeferredContinuation.ts:61-68` shape.
- **Counter-arguments considered**: I checked whether TS's control-flow analysis
  would flag it today — it does not, because the switch *is* currently exhaustive
  over the union, so the end is unreachable and no error is possible until the
  union grows. That is precisely why the tripwire matters and why "it compiles
  clean today" is not a refutation. I also checked whether
  `noFallthroughCasesInSwitch: true` helps — it governs case fall-through, not a
  missing case.
- **True consequence**: Exactly as claimed.
- **Evidence**: `scratchpad/v21/low1.ts` + scratch `tsconfig.json` mirroring the
  repo's `compilerOptions`; root `tsconfig.json`. Branch-new.
- **Disposition**: Apply the report's fix (`default: { const exhaustive: never = notice.kind; return exhaustive }`
  and type the `reason` parameter as `DeferredContinuationTerminalReason`). On the
  two `notice.notBefore!` assertions: keep them, but move the invariant into the
  type rather than deleting the assertion — the schema's `superRefine`
  (`:710-738`) already enforces `notBefore` on exactly the reschedule kinds, so a
  discriminated union on `kind` would let the compiler see it. That is optional;
  the `never` default is the load-bearing half.

### F9 — [LOW] Queue directories `locks/` and `tmp/` grow without bound, and one corrupt record disables the only pruning pass

- **Verdict**: **CONFIRMED** (both halves, reproduced)
- **Cited location holds?**: Yes. `ensureLockTarget` creates `locks/job-<uuid>`
  and `locks/session-<uuid>` (`:863-877`) and nothing unlinks them.
  `shouldScannerAttemptLock` writes `tmp/stale-<basename>.json` (`:898-913`) and
  nothing removes them. `tmp/notice-<sessionId>.json` is unlinked only by
  `takeDeferredContinuationNotice` (`:761`). `atomicWriteJson` creates
  `tmp/<uuid>.tmp` before the rename (`:332-347`), so a crash in between orphans
  it. The prune abort is at `:601-608`: `ENOENT` → `continue`, `ZodError` →
  continue, **anything else → `return 0`**.
- **Reachable in production?**: Yes, every scheduled job.
- **Trigger**: Reproduced against a scratch store — five jobs scheduled and
  terminated, then a truncated pending record:

  ```
  (c) pending : 1 entries
  (c) history : 4 entries
  (c) locks   : 10 entries   ← two permanent files per job, none ever unlinked
  (c) tmp     : 3 entries    ← notices for sessions that never reopened
  (d) prune with a truncated pending record: removed = 0 (history entries still present: 4)
  (d) prune with a ZodError pending record : removed = 4 (history entries now: 0)
  ```

  The control line is the proof: with a `SyntaxError`-producing record the pass
  removes **none** of four 40-day-old unreferenced tombstones; swap it for a
  schema-invalid but parseable record and the same pass removes all four.
- **Counter-arguments considered**: (a) Could the lock files be reaped elsewhere?
  `rg 'unlink' src/services/deferredContinuation.ts` shows unlinks only for the
  pending record, the notice, and history — never `locks/`. (b) Is the abort
  actually conservative-by-design? The comment says the pass "cannot prove which
  tombstones are still load-bearing", which is a defensible reason to skip *that
  record*; skipping the *whole pass* is the over-reaction, and the report's
  proposed `SyntaxError` handling is right because an unparseable record is
  equally never executed by `listDueDeferredContinuations` (`:534-536`).
  (c) **One thing the report missed, in its favour**: `pruneDeferredContinuationHistory`
  has exactly **one** production caller —
  `prepareBackgroundDeferredContinuation:214`. So on any machine where background
  continuation was never enabled, `history/` is **never pruned at all**, corrupt
  record or not.
- **True consequence**: As claimed, and worse: retention only exists for users who
  enabled the LaunchAgent.
- **Evidence**: `scratchpad/v21/null-and-growth.ts` (output above). Branch-new.
- **Disposition**: Apply the report's fix (extend the pass to unlink lock targets
  and `tmp/` entries with no surviving pending job; treat `SyntaxError` like
  `ZodError` at `:605`). **Add two things it did not cover.** First, call the
  prune from a foreground path too — the hook's poll or
  `/continue-after-limit status` — or the fix does nothing for background-disabled
  users. Second, do **not** unlink a `locks/<name>` file without first proving no
  `.lock` directory sits beside it; `ensureLockTarget` re-creates the target on
  demand, so deleting a live one is harmless to correctness but will race
  `proper-lockfile`'s own bookkeeping. The report's minor note about
  `shouldScannerAttemptLock` using a raw `readFile` at `:900` instead of
  `readPrivateJson` is accurate and worth folding in — that file is written by
  this process and read as a trust input.

### F10 — [LOW] One poisoned due job delays every other due job by a full scan interval

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. Inside
  `for (const candidate of await listDueDeferredContinuations(now))`, the
  non-restorable-model/permission arm does `stop… ; await guard.release(); return null`
  (`:250-261`) and the transcript-restore-failure arm does the same
  (`:262-283`), while the lock-loss case a few lines up correctly uses `continue`
  (`:235-237`).
- **Reachable in production?**: Yes. `bypassPermissions` and `auto` are outside
  `RESTORABLE_BACKGROUND_PERMISSION_MODES`, so a job scheduled from either mode
  takes the `permission_restore` arm; an unreadable transcript takes the other.
- **Trigger**: N unrunnable jobs queued ahead of a healthy one —
  `listDueDeferredContinuations` sorts by `notBefore` then `jobId` (`:538`), so an
  older poisoned job always precedes.
- **Counter-arguments considered**: I checked whether the delay is really bounded.
  It is: `stopDeferredContinuationForAttention` moves the poisoned job to history,
  so it is gone from the pending set next tick and the healthy job runs on tick
  N+1 — the report's own characterisation. One unbounded edge it did not name: if
  `moveDeferredContinuationToHistory` itself throws (EACCES, ENOSPC), the error
  propagates out of the outer `catch` at `:296-299` (`await guard.release(); throw error`),
  the job stays pending, and it blocks the queue on **every** subsequent tick,
  not N of them.
- **True consequence**: As claimed — N minutes of latency on a feature whose point
  is firing promptly after a reset — with the unbounded edge above.
- **Evidence**: `deferredContinuationRunner.ts:229-300`;
  `deferredContinuation.ts:520-539`. Branch-new.
- **Disposition**: Apply the report's fix — `await guard.release(); continue` in
  both places — and while there, wrap the `stopDeferredContinuationForAttention`
  call in its own `try/catch` so a write failure on one poisoned job cannot abort
  the scan for every other session. That closes the unbounded edge at the same
  cost.

### F11 — [LOW] Non-macOS `/continue-after-limit disable-background` shows the user a raw `TypeError`

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `getDeferredContinuationLoadState` does
  `process.getuid!()` at `:48`. `uninstallDeferredContinuationLaunchAgent` takes
  the `ENOENT` branch and calls it at `:297`.
  `continue-after-limit.tsx:325` prints `error.message` verbatim.
  `installDeferredContinuationLaunchAgent` is guarded, because
  `validateStableDeferredContinuationExecutable:119-121` throws on non-darwin
  before `:242` is reached.
- **Reachable in production?**: On Windows only — `process.getuid` is `undefined`
  there and a function everywhere else. Windows is not a hypothetical target for
  this codebase: `rg "process.platform === 'win32'" --glob '!*.test.*' src/`
  returns 55 hits.
- **Trigger**: `/continue-after-limit disable-background` on Windows with no
  plist: `lstat` → `ENOENT` → `getDeferredContinuationLoadState` →
  `process.getuid!()` → `TypeError: process.getuid is not a function`, printed
  verbatim.
- **Counter-arguments considered**: I checked whether `status` or the hook can hit
  it — they cannot. `getDeferredContinuationBackgroundStatus` guards every
  `getuid` use with `typeof process.getuid === 'function'` (`:190`) and returns
  `{state:'disabled'}` on `ENOENT` before reaching the load-state helper. So the
  blast radius is `disable-background` alone. On **Linux** there is no
  `TypeError` — `getuid` exists, `launchctl` fails to spawn, the executor returns
  `{outcome:'unavailable'}` → `'unknown'`, and the user gets the long
  "could not be disabled … Unload it with: launchctl bootout …" message, which is
  confusing but not a crash. The report's "Windows" framing is the correct one.
  The related `enable-background` misdiagnosis is confirmed and is the same defect
  as F4.
- **True consequence**: Exactly as claimed, scoped to Windows and to one
  subcommand.
- **Evidence**: `deferredContinuationLaunchAgent.ts:43-55,119-121,284-308`;
  `continue-after-limit.tsx:316-329`. Branch-new.
- **Disposition**: Apply the report's fix — early-return `{ state: 'disabled' }` /
  `false` when `process.platform !== 'darwin'`. Put the guard at the **top of
  `getDeferredContinuationLoadState`** returning `'not_loaded'`, not only in
  `uninstall`: that is the single function every `getuid!()` flows through, and it
  fixes both the `ENOENT` branch at `:297` and the plist-present branch at `:309`
  with one line. Fixing F4 first would already turn the crash into a readable
  message, so these two should land together.

### F12 — [LOW] `RESTORABLE_BACKGROUND_PERMISSION_MODES` is an untyped `Set<string>`

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `deferredContinuationRunner.ts:89-94` is
  `new Set(['default','acceptEdits','dontAsk','plan'])`, inferred as
  `Set<string>`, with no reference to `PermissionMode` / `PERMISSION_MODES`
  (`src/types/permissions.ts:16-38`). The security reasoning checks out:
  `bypassPermissions` and `auto` are excluded, and `dontAsk` is safe because it
  converts `ask` → `deny` (`src/utils/permissions/permissions.ts:521-534`).
- **Reachable in production?**: N/A — types finding. The set gates every
  unattended background run at `:252`.
- **Trigger**: Rename or add a mode; nothing forces a review.
- **Counter-arguments considered**: I checked whether the compiler already
  constrains it indirectly through `current.context.permissionMode`
  (typed `PermissionMode`) — it does not: `Set<string>.has(x: string)` accepts a
  `PermissionMode` silently, so a stale literal in the set is invisible. I also
  checked the union for a member the report missed: `'bubble'` exists in
  `InternalPermissionMode` but is not in the runtime `PERMISSION_MODES` array, and
  the job schema uses `z.enum(PERMISSION_MODES)` (`deferredContinuation.ts:146`),
  so it can never be persisted — the report's list of exclusions is complete for
  what matters. Worth noting for whoever applies the fix: `'auto'` is itself
  feature-gated into `PERMISSION_MODES` (`permissions.ts:33-36`), so
  `Set<PermissionMode>` still compiles either way.
- **True consequence**: As claimed.
- **Evidence**: `deferredContinuationRunner.ts:89-94,250-261`;
  `src/types/permissions.ts:16-38`; `src/utils/permissions/permissions.ts:521-534`.
  Branch-new.
- **Disposition**: Apply the report's fix (`new Set<PermissionMode>([...])`). It
  is one type argument and it makes a removed member a compile error. Add a
  one-line comment naming *why* `bypassPermissions` and `auto` are out — the
  compiler can enforce the shape but not the intent, and the next person to add a
  mode needs the reason, not just the error.

### F13 — [LOW] Em dash in user-visible strings

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes, all ten. Verified by
  `rg -n '—' <the six files>`: `deferredContinuationPresentation.ts:82,92,99,117`;
  `deferredContinuation.ts:796`; `useDeferredContinuation.ts:155`;
  `continue-after-limit.tsx:109,186,199,217`. Every hit is inside a string that is
  rendered to the user, not a comment.
- **Reachable in production?**: Yes — these are notice, status and cancel strings.
- **Trigger**: N/A.
- **Counter-arguments considered**: The report's own honesty check is the strongest
  counter-argument and it is accurate: CLAUDE.md §7 scopes its verification
  command to `app/renderer/src`, and the engine is saturated with em dashes
  already. So this is not a rule violation as written; it is a judgement call the
  owner has to make. I did not re-run the repo-wide count.
- **True consequence**: A convention question, not a defect.
- **Evidence**: `rg -n '—'` over the six files. Branch-new.
- **Disposition**: Owner's call, exactly as the report framed it. If the rule is
  extended to `src/`, take the report's rewrites. **Do not** apply a blanket
  regex sweep across `src/` as part of this — a mechanical replacement over
  ~6,771 lines is a large untested diff on user-facing prose. If it is done at
  all, do it for this branch-new subsystem only, where the strings are all new.

## Findings the original report missed

### [HIGH] `abandonForegroundDeferredAttempt` has zero production call sites, so an ordinary ESC or UP-arrow strands both locks and bricks the session

- **Where**: `src/services/deferredContinuationRunner.ts:460-473` (never called),
  `:378-392` (the queued command's shape), `src/hooks/useDeferredContinuation.ts:146`
  (`enqueue`), `src/utils/messageQueueManager.ts:412-414` and `:481-500`
  (`isQueuedCommandEditable` / `popAllEditable`),
  `src/components/PromptInput/PromptInput.tsx:952-955` (UP) and `:1968-1972` (ESC),
  `src/screens/REPL.tsx:2433-2436` (permission-cancel),
  `src/hooks/useCancelRequest.ts:253` and `src/hooks/usePtcloveBridge.ts:466`
  (`clearCommandQueue`).
- **What**: `beginForegroundDeferredContinuation` writes the job to `submitted`,
  registers the attempt, and returns a `finished` promise that resolves **only**
  when `settleForegroundDeferredAttempt` is called from `REPL.onQuery`'s `finally`
  (`REPL.tsx:3396`). Until then it holds both filesystem locks. The command it
  hands the hook is `mode: 'prompt'`, `isMeta: false`, so
  `isQueuedCommandEditable` returns **true**, and `useQueueProcessor` only drains
  the queue when `!isQueryActive && !hasActiveLocalJsxUI` — i.e. the command sits
  visibly in the queue for the whole of any in-flight turn or open dialog. In that
  window, pressing **UP** (`PromptInput.tsx:954`) or **ESC**
  (`:1971`), cancelling a permission request (`REPL.tsx:2435`), or double-pressing
  the kill-agents chord (`useCancelRequest.ts:253`) removes it from the queue. It
  then never reaches `onQuery`, nothing settles the registration, and
  `finished` never resolves. `abandonForegroundDeferredAttempt` exists for exactly
  this — its own comment says "Dropping the registration without resolving would
  leave `beginForegroundDeferredContinuation`'s awaiter pending forever, holding
  both filesystem locks for the process lifetime" — and
  `rg abandonForegroundDeferredAttempt src/` returns **only** its definition and
  two lines in `deferredContinuationRunner.test.ts`, one of which is the test
  named *"abandonment settles the waiter instead of stranding it and both locks
  forever"*. This is CLAUDE.md §8 item 7: an unwired feature with a passing test.
- **Why it is reachable**: no env gate, no feature flag, no race — it is ordinary
  keyboard input during the window the design creates.
- **Consequence** (reproduced end to end):

  ```
  attempt claimed. command.mode = prompt  isMeta = false
  isQueuedCommandEditable(command) => true (true means ESC/UP pops it out of the queue)
  after 300ms with the command dropped: finished settled? false
  registrations still held: 1
  job state on disk: submitted
  human prompt decision: block | A scheduled continuation is already in progress. Wait for it to finish, then send your message again.
  /continue-after-limit cancel could take the lock? false
  after abandonForegroundDeferredAttempt: finished settled? true
  locks free after abandon? true
  ```

  The session is bricked for the process lifetime: every prompt is refused
  (`handlePromptSubmit.ts:228` → `prepareHumanPromptAgainstDeferredContinuation`
  → `acquireDeferredContinuationLocks` throws → `block`), `cancel` refuses
  because the state is `submitted` (`continue-after-limit.tsx:221-227`), and
  `discardUnreadableDeferredContinuation` does not apply because the record parses
  fine. `proper-lockfile`'s 20 s mtime refresh keeps the lock from ever going
  stale, so no other process can reclaim it either. The last two lines show the
  unused function is the exact fix.
- **Evidence**: `scratchpad/v21/abandon-repro.ts` run with a scratch
  `CLAUDE_CONFIG_DIR`; `rg abandonForegroundDeferredAttempt src/`;
  `bun test src/services/deferredContinuation.probe.test.ts` → 6 pass (the probes
  are genuine `Bun.spawn` multi-process races with barrier files, so the report's
  praise of *them* is accurate — they simply never exercise abandonment).
  Branch-new.
- **Disposition**: Wire it. The queue is the owner of the drop, so the call
  belongs where a command leaves the queue without executing:
  `popAllEditable` and `clearCommandQueue` should call
  `abandonForegroundDeferredAttempt(cmd.origin)` for every removed command
  carrying a `deferred-continuation` origin. A cheaper alternative that is *not*
  sufficient on its own: mark the command non-editable
  (`isMeta: true` would exclude it from `isQueuedCommandEditable`) — that closes
  the ESC/UP path but not `clearCommandQueue`, and `isMeta: true` would also hide
  it from the transcript, which `registerForegroundDeferredAttempt`'s comment says
  is deliberate ("must stay visible … that is what routes it through the REPL's
  durable pre-provider barrier"). Do both halves: keep the command visible, and
  abandon on removal. Also add the hook's cleanup (`useDeferredContinuation.ts:164-167`)
  to the abandon set — unmount today leaves the same stranded registration.

### [MED] `buildCodexStatus` classifies profiles from account fields only, so a live usage poll proving every account capped still yields `delegate`

- **Where**: `src/services/api/codexStatus.ts:206-233` (`classifyProfile`),
  `:452-489` (the snapshot is looked up but only fed to `buildProfileUsage` and
  `quotaResetSeconds`), `src/services/api/codexUsage.ts:299-301`
  (`updateRoutingHintsFromUsage` runs only when `updateRoutingHints === true`,
  which `buildCodexStatus:427` explicitly sets to `false`).
- **What**: `classifyProfile(account, now)` takes no `usage` argument. The
  `refresh: 'auto'` poll therefore informs the rendered `usage` block and
  `earliest_known_reset_at` (and the latter only for accounts *already* classified
  `quota_blocked` from account fields), but never the routing bucket that
  `decide()` reads.
- **Consequence**: I injected a snapshot with `allowed: false, limitReached: true`
  for both accounts and the decision was still
  `delegate / candidate_available / not_before: null` with
  `candidate: 2, quota_blocked: 0`. So the advisory observation contradicts the
  freshest evidence it just fetched. This is independent of F1 — it survives even
  if the pool wipe is fixed, because a pool that was never capped in *this*
  process (a `-p` one-shot, or the standalone `codex status` subcommand) has no
  account fields to classify from.
- **Evidence**: `scratchpad/v21/high1-repro.ts` step 4:
  `decision(auto+cappedUsageSnapshot): delegate candidate_available not_before= null`.
  Branch-new (`codexStatus.ts` does not exist on `main`).
- **Disposition**: Pass the account's `AccountUsage` into `classifyProfile` and
  apply the same rule `getCodexAccountAvailability:1560-1568` already applies to
  stored hints (`allowed === false || limitReached === true`, unless the reported
  window has elapsed). Do **not** reach for `updateRoutingHints: true` — that
  would violate the module's stated read-only contract at `codexStatus.ts:14-16`.
  **Possible overlap**: the parent mentioned an `S05` scope examining
  `buildCodexStatus` from the transport side; there is no codex-status
  verification report in
  `docs/reports/2026-08-08-migration-branch-review/verification/` as of this
  writing (`V05` is the desktop projector), so I am reporting it here. Deduplicate
  before acting if that scope lands.

### [LOW] History retention only ever runs inside the background worker

- **Where**: `src/services/deferredContinuation.ts:586-632` (the pass) with
  exactly one production caller,
  `src/services/deferredContinuationRunner.ts:214`.
- **What**: The 30-day retention the report praises as "a deliberate retention
  pass with a well-reasoned safety rule" is invoked only from
  `prepareBackgroundDeferredContinuation`. Background continuation is opt-in
  behind a consent dialog, so on every machine that never enabled it, `history/`
  accumulates one tombstone per job forever.
- **Consequence**: Unbounded growth of small JSON files, and — more relevant —
  `getLatestDeferredContinuationHistory` (`:649-672`) reads and schema-parses
  **every** file in `history/` on each `/continue-after-limit status` and on the
  no-job path of the bare command, so the cost of that command grows linearly with
  every continuation ever scheduled.
- **Evidence**: `rg -n 'pruneDeferredContinuationHistory' --glob '!*.test.*' src/`
  → the definition plus one call site. Branch-new.
- **Disposition**: Fold into F9's fix: call the prune (already
  `.catch(() => 0)`-wrapped and bounded) from a foreground path as well — the
  natural place is alongside `getLatestDeferredContinuationHistory` in
  `statusText`, which is already paying to read the whole directory.

## Provenance summary (branch-blocking assessment)

`git cat-file -e main:<path>` fails for **every** file cited in this scope:

| File | On `main`? |
|---|---|
| `src/services/deferredContinuation.ts` | no — branch-new |
| `src/services/deferredContinuationRunner.ts` | no — branch-new |
| `src/services/deferredContinuationPresentation.ts` | no — branch-new |
| `src/services/deferredContinuationLaunchAgent.ts` | no — branch-new |
| `src/hooks/useDeferredContinuation.ts` | no — branch-new |
| `src/commands/continue-after-limit/continue-after-limit.tsx` | no — branch-new |
| `src/services/api/codexStatus.ts` | no — branch-new |
| `codexAccountPool.ts` `loadPoolForObservation` | no — branch-new (`main` has only `initAccountPool` at `:162`) |

**Every finding in this scope is introduced by the `migration` branch.** That is
the opposite of the account-pool scope (V24), where nothing was. F1 and the
missed abandonment finding are the two that would ship a user-visible defect: F1
inverts the feature's primary decision, and the abandonment hole can brick a
session with one keystroke.

## Uncertainty

- **F2's real-world hit rate.** I proved the branch is entered whenever `begin`
  returns `null`, and I proved `begin` returns `null` for the three transition
  shapes. What I could not measure is how often a competitor completes inside the
  hook's ~15-operation window in a live session. What would settle it: a
  deterministic test that suspends the hook between its read and its lock (a
  seam already exists — `beginForegroundDeferredContinuation` takes an injectable
  `now`, but not an injectable clock hook), or an instrumented counter on the
  `null` return. The fix is one line and matches every sibling, so the hit rate
  does not change the disposition.
- **`launchd` `StartInterval` catch-up after sleep** (the report's own open item).
  I did not verify it either; it is an OS behaviour question, not a code one, and
  the user copy at `continue-after-limit.tsx:64-69` rests on it.
- **Upgrade survival of the pinned executable path** (the report's other open
  item) is unresolved for the same reason it flagged: `install.sh` is known-stale
  per CLAUDE.md and I did not determine the shipped install layout. I did confirm
  the narrower half — the only string that ever reaches the plist or its argv is
  `realpath(process.execPath)`, passed from `continue-after-limit.tsx:265`, and
  `installDeferredContinuationLaunchAgent` has no other production caller
  (`rg` verified). The label is a fixed namespaced constant with no interpolation,
  install is idempotent (`enable-background` short-circuits on `state === 'enabled'`,
  and a repeat write is atomic temp+rename of identical bytes), and no
  config-supplied value can influence either. So the parent's LaunchAgent
  questions are answered clean; only the upgrade question remains.
- **F5's cost measurement used `./cli-dev`**, the dev bundle, not a release
  binary. The 110 ms / 50 ms split is indicative of the shipped shape but not
  identical to it.
- **I ran one test file** (`deferredContinuation.probe.test.ts`, 6 pass / 0 fail).
  The other seven suites touching this subsystem were read for coverage claims,
  not executed, so I cannot report whether any proposed fix breaks an existing
  assertion — that belongs to whoever applies them.
