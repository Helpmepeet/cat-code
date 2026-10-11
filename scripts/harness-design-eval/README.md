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

The user subsequently authorized the existing Cat Code subscription for the
four serial GPT-6.1 Sol low-effort attempts. The subscription extension uses
production Codex request/stream translation, account resolution, refresh-on-use
and credential-send lifecycle checks in the parent gateway. A transport-only
client factory in the isolated sidecar retains OpenAI-native prompt assembly,
normal tools, compaction, durable writing and fresh-process resume. It never
places credentials in the fixture process. The hidden grader is unchanged.
The paid-API proposal and authorization example are historical and are not
used by this route.

```sh
# Clone the prepared seeds; freeze only evaluator changes over the repaired engine.
bun scripts/harness-design-eval/task-restore/freeze-subscription.ts /private/tmp/task-subscription-new
# Requires explicit user authorization for subscription/account access.
bun scripts/harness-design-eval/task-restore/run.ts /private/tmp/task-subscription-new --live --subscription
bun scripts/harness-design-eval/task-restore-subscription-summary.ts /private/tmp/task-subscription-new
```

The schedule is off/on, then on/off. Limits are 12 requests and six minutes per
attempt, 48 requests and 26 minutes per suite, plus the conservative serialized
workload gate recorded in the frozen policy. The SDK output setting is 4096,
but the production subscription translator does not forward a provider output
cap. Account refresh stays coordinated with existing sessions; no copied vault
or refresh token is used. Subscription usage comes from raw completed provider
responses, including cached-input and reasoning-output subsets. It is not
converted to API charges. Results and failures are never overwritten. Plain
`--live` remains blocked; the subscription flag requires a frozen matching
subscription policy.

The [subscription pilot report](../../docs/reports/2026-10-11-task-restoration-subscription-pilot.md) records the actual outcomes, request-capped failures, task-state mistake, and usage from both the failed preliminary batch and corrected comparison.
