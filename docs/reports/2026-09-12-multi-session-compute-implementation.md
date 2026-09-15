# Multi-session compute optimizations — implementation

Date: 2026-09-12. Follow-up to the [audit](2026-09-12-multi-session-compute-audit.md) and its [independent review](2026-09-12-multi-session-compute-review.md). All four changes are implemented and verified. The lanes ran in parallel in the existing shared checkout, followed by integration checks and independent account/report reviews.

| Change | Concrete reduction | Limits and tradeoffs |
|---|---|---|
| Trace directory preparation | A 100-record fixture prepares the log directory once, down from 100 times. | Per-record stat/write operations remain. Externally changed directory permissions are repaired on reopen/rotation rather than the next append; log files remain 0600. This is not a 99% reduction in total logging I/O. |
| Auxiliary session title input | The title request receives at most 4,096 UTF-16 code units of description, retaining the beginning and ending. A 96 KiB ASCII prompt contributes 95.8% less description text. | The full conversation prompt is unchanged. Savings apply to the title request's description, not all request tokens or model cost. Title quality on real workloads has not been measured; middle-only information may be omitted. |
| Paired 7-day/30-day analytics | A mixed fixture drops from two discoveries/nine JSONL reads to one discovery/five reads. A real disposable worker reads two eligible fixture files twice total, versus three reads with separate ranges. | Independent accumulators still perform each range's calculations. No persistent transcript cache was added; later refreshes still read eligible files. |
| Shared Codex usage observations | Three simultaneous engine processes and a subsequent fourth process used one authenticated fixture GET. Compatible ordinary observations are shared for 60 seconds. | This saves status HTTP requests, not model inference. Forced and post-request refreshes remain fresh and are not deduplicated. Worker launches and per-session account maintenance remain. |

These are operation counts and bounded-input guarantees from synthetic fixtures. No application power, battery life, real-account request volume, or wall-clock improvement has been measured. Actual benefit depends on transcript size, prompt length, account inventory, and overlapping requests.

The fourth lane is shared account observations. MCP lazy startup, account recovery timer redesign, renderer batching, and persistent worker ownership are outside this implementation.

## Preserved behavior and implementation anchors

- [Trace sink](/Users/pt/cat-code/app/main/deliveryTraceSink.ts) prepares private directories when opening/reopening a log. Rotation, retention, 0600 log files, and diagnostic contents remain covered by the existing suites; the new tests also verify permission repair on rotation.
- [Title generation](/Users/pt/cat-code/src/utils/sessionTitle.ts) caps only the auxiliary description. Short inputs pass through, head/tail boundaries avoid splitting surrogate pairs, and the Claude and GPT request paths use the same excerpt. Model choice and thinking settings remain unchanged.
- [Engine stats](/Users/pt/cat-code/src/utils/stats.ts), [stats domain](/Users/pt/cat-code/app/sidecar/statsDomain.ts), and [accounts worker](/Users/pt/cat-code/app/sidecar/accountsPoolWorker.ts) share discovery, metadata/header checks, and JSONL reads. The existing mtime/start-date filters, resumed-session behavior, repeated message IDs, subagents, all-range cache, five-run cadence, and failure-as-null policy are retained. Both complete range outputs were compared against the pre-change implementation on the mixed fixture.
- [Usage entry point](/Users/pt/cat-code/src/services/api/codexUsage.ts) and [shared cache](/Users/pt/cat-code/src/services/api/codexUsageSharedCache.ts) retain process-local routing authority. Cache scope includes account inventory, hashed credentials, backend and durable file revisions. An invalidation epoch prevents old in-flight results from updating the shared cache, process-local cache or routing hints after a normal invalidation. An original caller can still receive its earlier result.

The account cache stores bounded, schema-validated normalized usage in a private 0700 directory and 0600 file. It includes account identity fields used by the existing engine Reset UI; it is not a fully redacted host payload. It excludes credentials, raw responses, vault paths, and arbitrary errors. Main and the renderer still receive the existing redacted projection. No provider credentials or private conversations were used in tests.

Unforced cache reads accept observations younger than 60 seconds. Combined with the host's 60-second poll, displayed usage can approach two minutes old before the next successful run, plus execution delay. Explicit fresh reads bypass this tradeoff. Offline last-good display can remain older as before. If epoch publication fails, the engine attempts eviction and disables sharing locally; if storage also refuses eviction, another process may use the previous observation until its TTL expires. Account usage remains advisory.

## Review and change impact

The original audit received its requested independent subagent review. An additional bounded implementation review examined account sharing and finished GREEN with 10 passing process tests. It identified existing tests that needed explicit disk-cache isolation; those suites now disable shared persistence while the dedicated process probes use temporary homes and synthetic HTTP responses. It also identified the failed-epoch invalidation limitation, leading to best-effort eviction and an explicit storage-failure test and disclosure. A separate report review requested narrower invalidation wording and disclosure of directory-permission repair timing; both corrections are included here.

Canonical account ownership documentation, account/analytics maps and stale worker/runner comments were updated. Existing wire schemas, preload permissions, settings, registries, telemetry, model selection, prompt instructions, MCP behavior, and renderer layout required no changes. The cache has a private versioned schema and needs no user-config migration. No new logs were added. DONE.md was not changed.

This was an ad hoc optimization request, not a dispatched visual migration session. Work stayed on the inherited shared `main` checkout, following CLAUDE.md's current-branch instruction. Other sessions' edits were preserved. No application was installed or launched and nothing was pushed.

Implementation commits: `cdbb2fa1` (trace preparation), `bbba34b3` (title input), `d58b9f10` (paired analytics), `7a42a74d` (shared account observations). The closing documentation change also corrects one nullable test assertion found by the scoped typecheck.

## Verification

```text
VERIFICATION
- bun test app/main/deliveryTraceSink.test.ts app/main/jsonlRetention.test.ts app/main/diagnosticsBundle.test.ts
  → 52 pass / 0 fail; 170 assertions across the sink and bundle suites. The middle path does not exist and matched no tests. The two new operation-count tests failed before the change and passed after it.
- bun test src/utils/sessionTitle.test.ts
  → 10 pass / 0 fail; 37 assertions.
- bun test app/sidecar/sessionTitleGen.test.ts
  → 11 pass / 0 fail; 21 assertions.
- bun test src/utils/stats.test.ts app/sidecar/statsDomain.test.ts app/sidecar/accountsPoolWorker.probe.test.ts
  → 16 pass / 0 fail; 72 assertions.
- Temporary comparison against the original stats module
  → 4 pass / 0 fail; complete 7d and 30d results matched.
- bun run --cwd app typecheck
  → PASS, including renderer fast-refresh lint.
- bun test src/services/api/codexUsageSharedCache.test.ts
  → 10 pass / 0 fail; 46 assertions. Independent reviewer also passed the process suite.
- bun test src/services/api/codexUsage.test.ts
  → 45 pass / 0 fail.
- bun test src/services/api/codexAccountLeaseManager.test.ts
  → 61 pass / 0 fail.
- bun test src/services/deferredContinuation.test.ts
  → 32 pass / 0 fail.
- bun test src/services/deferredContinuationRunner.test.ts
  → 15 pass / 0 fail.
- bun test src/commands/accounts/accounts.test.ts
  → 5 pass / 0 fail. Account suites ran separately with synthetic/isolated state: 168 passing tests in total.
- bun test app/
  → 4,793 pass / 0 fail; 27,954 assertions across 293 files (91.82 seconds).
- bun run build:dev:full
  → PASS; ./cli-dev built and printed 2.1.87-dev.20260912.t081955.shaa20f0435 (Cat Code). Map lint passed with 7 recommended-section warnings; undefined-name lint found 0 undefined names.
- bun run --cwd app typecheck:sidecar
  → PASS; 5,559 upstream diagnostics ignored by the scoped wrapper. The first run found one new test assertion typing error, corrected before this passing rerun.
- bun test app/sidecar/statsDomain.test.ts
  → 7 pass / 0 fail; 29 assertions after the assertion correction.
- git diff --check; bun run maps:lint
  → Clean diff; 17 maps passed with 7 recommended-section warnings. Report link targets all exist.
Stale-reference sweep: Current code and canonical docs updated. The 2026-08 correction in ACCOUNTS-OWNERSHIP is retained with an explicit superseding amendment. The audit is a dated pre-change artifact; its findings remain historical evidence. The stats all-range path still legitimately processes today's data separately.
Not run: bun run --cwd app test:hardening (no preload/wire boundary change and no Electron launch authorization); bun run --cwd app renderer:build (no renderer build inputs changed in these four lanes); real-provider, live GUI, title-quality and energy profiling (not performed).
```

The initial sandboxed desktop test attempt was stopped after local-socket and process-access failures. The approved rerun above passed with the required local probe access. Account process probes similarly required loopback access and used no real provider endpoint. The history commit was initially rejected by automatic approval review; supplying CLAUDE.md's explicit current-branch commit instruction resolved that rejection without changing branches or publishing work.
