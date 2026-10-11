# Offline harness audit

This is a read-only extractor, not a model evaluator. It reads explicitly named
debug/transcript directories and writes aggregate JSON outside those inputs.
It does not read credentials, change the live account configuration, or call a
model. Symlink inputs are excluded. Run from an immutable source snapshot for a
repeatable policy version:

```sh
bun scripts/harness-design-eval/audit.ts \
  --debug-dir /path/to/debug \
  --projects-dir /path/to/projects \
  --production-composition \
  --out /private/tmp/harness-audit
bun test ./scripts/harness-design-eval/audit.test.ts
```

The public artifact contains aggregate counts, anonymous file labels, input
hashes/lengths, dates, builds, models and boundary locations. It excludes paths,
session/account/conversation/tool IDs, commands and result bodies. Actual event
dates determine cohorts; filenames and mtimes do not establish request dates.
Identical timestamped debug lines are deduplicated within each file.

Transcript joins require a matching filename identity AND matching persisted
session identity without a conflicting identity. Worker joins are not inferred.
Input size and mtime are compared before/after reading; unstable inputs are
reported, not silently described as a frozen snapshot. Repeating a run against
growing live inputs can change the manifest; hashes identify the exact read.

`--production-composition` optionally recovers a selected pre-boundary prefix
with the production transcript reader when a simple parent walk lacks complete
parallel tool exchanges. Its child process has isolated temporary configuration,
no inherited credentials, and a fail-closed fetch implementation. A mode-0600
raw prefix is removed after the child finishes. Nothing is fed to a model.

Composition is a UTF-16-character proxy: apply the current GPT 48,000-character
per-result cap, preserve its exemptions, then count an optimistic old-output
upper bound excluding errors and the newest three assistant rounds. It does
not establish a safe elision projection, historical request assembly, tokenizer
counts, instruction/tool overhead, cache savings or task quality. Missing
instrumentation never implies zero compactions, failures or recovery costs.

The dated execution report explains the measured cohort and decision gates:
[2026-10-11 report](../../docs/reports/2026-10-11-harness-improvement-execution.md).

## Task restoration screen

The separate, fixed-case evaluator now prepares and runs paired Task-mode
attempts through the real supervisor, Unix socket, sidecar and QueryEngine.
Its offline mode supplies scripted transport responses. Those results verify
infrastructure and data delivery, not model behavior.

```sh
# New destination required; freezes source, dependencies, fixtures and schedule.
bun scripts/harness-design-eval/task-restore/prepare.ts /private/tmp/task-screen-new
bun test ./scripts/harness-design-eval/task-restore/evaluation.test.ts
bun scripts/harness-design-eval/task-restore/run.ts /private/tmp/task-screen-new --offline
bun scripts/harness-design-eval/task-restore/collect.ts /private/tmp/task-screen-new/offline-results
```

Offline execution needs macOS `sandbox-exec` and permission to create a localhost
listener and isolated Unix sockets. Preparation and offline execution never
read a live credential. Each arm receives a fresh cloned configuration and
fixture. Source, support and installed dependency hashes must match the frozen
manifest; results cannot be silently overwritten or retried. The only substantive
paired configuration change is `CAT_CODE_EVAL_COMPACT_TASK_RESTORE=0` versus `1`.

The [repair report](../../docs/reports/2026-10-11-task-restoration-resume-repair.md)
records two pre-fix omissions, the production transcript-reader fix and correct
delivery afterward. The refreshed offline package runs 16 attempts, including
fresh-process cancellation and real completed/unrelated task controls. Its
frozen engine revision, manifest digest and independent evidence are pinned in
the [v2 manifest](task-restore-manifest.v2.json). The candidate remains off by
default. The [original experiment](../../docs/reports/2026-10-11-task-restoration-experiment.md)
and v1 artifacts remain historical evidence.

The user selected a **GPT-6.1 Sol proposal only**: four serial attempts, two
matched off/on pairs of the repaired resume case. The v2 proposal has a $24
suite/$6 attempt ceiling and a deliberately unapproved
[authorization example](task-restore-gpt-authorization.example.json). It cannot
execute through this Anthropic Messages gateway. Current `--live` execution
refuses before manifest, authorization or credential reads.

A separately scoped Responses integration must preserve the real engine path
and independent grader, prove token/output accounting and durable spending
admission offline, and freeze a new runnable manifest. Dedicated API access,
current rates, an enforced project limit and exact digest-bound human approval
remain required. Provider limits can overshoot; the proposed local ledger must
reserve the full token ceiling before every dispatch. No live authorization or
model improvement is established by these offline results.
