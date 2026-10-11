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

Read the [experiment report](../../docs/reports/2026-10-11-task-restoration-experiment.md)
and [versioned proposal](task-restore-manifest.v1.json) before considering live
execution. The full frozen manifest and offline evidence paths are in the report.
A dedicated first-party API project/key, dated billing rates, an enforceable
provider spending limit, and explicit approval of the manifest digest are still
required. The committed [authorization example](task-restore-authorization.example.json)
is deliberately unapproved and bound to the prepared manifest digest. A new
preparation requires its own exact digest; null fields must be resolved explicitly.
An authorized operator can later use `--live --authorization /path/to/approval.json`;
this preparation request does not authorize that operation.

The offline screen found a persisted restoration snapshot missing from the
first resumed request on the prefix-compaction path. It records that delivery
gap and blocks advancement; it does not change the candidate or default.
