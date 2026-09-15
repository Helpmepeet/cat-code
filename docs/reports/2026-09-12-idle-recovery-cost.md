# Idle account recovery: cost check and decision

Date: 2026-09-12. Decision: **leave the production scheduler unchanged**.

The user delegated whether to pursue idle-account optimization. Source inspection and a small synthetic measurement do not establish enough benefit to justify a recovery-scheduler change. The current healthy tick only scans an in-memory account list. It does not read vault files, call a provider, or discover other processes' account changes.

## Narrow measured result

This is a warmed function-body microbenchmark, not an idle-app or energy profile. It executes the exact source text of `getPoolStatus` and `runQuarantineProbeOnce`, transpiled by Bun, against synthetic healthy accounts. The full engine is never imported. A throwing vault-read boundary makes accidental entry into recovery fail without accessing account files.

Each of seven rounds makes 200,000 calls per case after 20,000 warmup calls. Case order alternates forward/reverse. CPU includes the async loop and result-length validation; the empty async control is reported separately and is not subtracted. Normal garbage collection remains enabled. Source files are checked for changes after measurement, and source/fragment hashes are saved.

| Healthy accounts per synthetic pool | Median CPU microseconds/check | Range across repetitions |
|---|---:|---:|
| Empty async loop control | 0.047 | 0.046–0.089 |
| 1 | 0.091 | 0.087–0.148 |
| 8 | 0.100 | 0.094–0.127 |
| 32 | 0.133 | 0.127–0.137 |

All 28 samples returned the expected empty results with no attempted vault reads. Runtime: Bun 1.4.0, Apple M4 Pro, arm64, Darwin 25.6.0. Other applications and sessions remained running.

For scale only, multiplying these hot-loop rates by 28,800 calls (eight session processes checking once per second for an hour) gives about **2.6–3.8 milliseconds of function-body CPU**. This arithmetic is **not measured hourly idle CPU or a saving estimate**: timer dispatch, the promise catch attached by the interval, OS wakeups, cold-cache behavior, background engine work, quarantined accounts, and energy are excluded. It cannot bound battery impact. The fully healthy fixture does not establish recovery-path performance or correctness.

## Why stop here

Independent source review found that a safe implementation needs more than replacing an interval. The pool has no change subscription. Suppressing the healthy timer requires notification for relevant pool mutations, explicit started/stopped lifecycle state, and correct behavior when a probe is already running. A true deadline scheduler additionally needs a way to notice another process moving a known account's persisted retry deadline earlier. Existing locking, reservation, token rotation and terminal-verdict behavior must remain intact.

The measured body is cheap, while OS wakeup energy remains unmeasured. That combination does not justify adding notifications or vault watchers solely for this optimization. This is a prioritization decision, not proof that the existing timer has zero energy cost. Revisit only if a real idle profile attributes material CPU or wakeup cost to this timer. No account settings, recovery behavior, production source, or live state changed.

The next candidate for busy-session performance remains profiling message-history copying. No renderer bottleneck or saving is established by this account experiment.

## Reproduction and verification

- [Harness](2026-09-12-compute-measurements/idle-probe-benchmark.ts)
- [Immutable raw samples](2026-09-12-compute-measurements/idle-probe-results.json)
- Source: [account status accessor](/Users/pt/cat-code/src/services/api/codexAccountPool.ts:468) and [recovery probe](/Users/pt/cat-code/src/services/api/codexTokenRefresh.ts:862).

```sh
bun docs/reports/2026-09-12-compute-measurements/idle-probe-benchmark.ts /tmp/catcode-idle-probe-20260912-01.json
```

The recorded run exited 0 and produced 28 samples. Choose a new output path to reproduce; the harness refuses to overwrite results. Archive bytes match the original output. This docs-only experiment did not run engine builds, application tests, GUI launches, or provider calls because production code was unchanged.

Independent subagent review reproduced all medians, matched source hashes, and found no material methodological issue or overclaim within this narrow scope. The reviewer agreed that leaving the scheduler unchanged is reasonable. `git diff --check` passed; `bun run maps:lint` passed with seven existing recommended-section warnings.
