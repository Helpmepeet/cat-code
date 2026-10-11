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
