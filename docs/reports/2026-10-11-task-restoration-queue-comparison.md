# Task restoration on a more demanding queue repair

Date: 2026-10-11. GPT-6.1 Sol, low effort, authorized Cat Code subscription.

All four attempts passed 25 independent behavioral checks, protected-file checks,
actual regression-test execution and the required smoke check. Both matched pairs
tied on completion after a documented correction to the documentation grader.
Restoration did not consistently reduce requests: on used 23 versus 24 in pair 1,
but 27 versus 21 in pair 2. No attempt hit an admission/time limit.

| Pair / arm | Behavioral checks | Final assessed completion | Requests | Time | Inclusive input | Cached subset | Output |
|---|---|---|---:|---:|---:|---:|---:|
| 1 / off | 25/25 | Pass, documentation regraded | 24 | 331.635s | 690,143 | 510,464 | 10,713 |
| 1 / on | 25/25 | Pass | 23 | 297.208s | 644,144 | 496,896 | 9,246 |
| 2 / on | 25/25 | Pass | 27 | 361.687s | 819,930 | 687,488 | 11,900 |
| 2 / off | 25/25 | Pass, documentation regraded | 21 | 349.601s | 635,462 | 457,856 | 10,940 |

Off totals: 45 requests, 681.236 seconds, 1,325,605 input and 21,653 output tokens.
On totals: 50 requests, 658.895 seconds, 1,464,074 input and 21,146 output tokens.
On used 11.1% more requests and 10.4% more inclusive input, with 3.3% less total
time. Noncached input was 357,285 off versus 279,690 on. Cache variability, natural
summary differences and two repetitions prevent a reliable efficiency estimate.
Neither request counts nor token counts were converted into API charges or
subscription-quota percentages.

## Task and experiment

The new controlled fixture repairs a TypeScript durable job queue with interacting
requirements: dependency graphs and cycle detection, priority/FIFO ordering,
idempotency across restart, fenced leases, stale acknowledgements, retry backoff,
expiry, cancellation propagation, append-before-memory behavior, detached state,
journal replay and interrupted JSONL write recovery. It also requires documentation,
agent-authored regression tests and `bun check.ts`, with specification, public
types, smoke check, package metadata and archive protected from modification.
The public specification is in
[queue-fixture.ts](../../scripts/harness-design-eval/task-restore/queue-fixture.ts).

This is substantially more demanding than the prior two-function invoice repair,
but it is a synthetic, small-project task, not a large production repository
benchmark. All four solutions passed the measured behavioral cases, so this
still does not locate the model's difficulty limit or demonstrate improvement
on work it otherwise cannot solve. The checks cover specific contracts, not
every possible input or an actual machine/power failure.

Each seed uses the real task tools and transcript writer to reconstruct unfinished
investigation, followed by natural manual compaction and a fresh-process resume.
The long inspection history is prepared, not a model-generated warm-up. Both arms
have access to the same SPEC.md. Hidden cases and the reference implementation
are outside the model/tool sandbox. The grader runs after the model process stops,
with write permission only to its separate temporary journal directory.

The order is off/on, then on/off. Both compile restoration; only its existing
runtime toggle differs within a pair. Model, low effort, stateless subscription
HTTP transport, fixed recovery turn and 64-request/20-minute attempt limits are
unchanged from the higher-limit invoice comparison. The production engine remains
the repaired `46f82fbcb8b410556727c31d45779491d530bfd6`. Only evaluation support
changed in this work. No product default was enabled.

## Grader correction, disclosed separately

The frozen automated grader marked both off attempts incomplete solely for
`documentation topic 6`. It looked for `tail`, `torn` or `partial`, but both
READMEs correctly described an unterminated **final fragment** being ignored and
removed before append while preserving complete records. That is the contract's
own terminology. All four READMEs were read against the same six documentation
requirements; there was no substantive missing recovery explanation.

After all four live attempts ended, a regression test reproduced the lexical
false failure, then passed after adding `fragment` to the recognized wording.
The same corrected grader was applied to all four saved workspaces. No model
was rerun, no answer was changed, and the original result files, hashes and
automated pair verdicts remain intact. The
[verification artifact](2026-10-11-task-restoration-queue-verification.json)
retains the original automated results at the top level and explicitly records
corrected assessments under `documentationRegrade`. Its original two automated
on wins must not be interpreted as model wins; the corrected completion result
is two ties. This keyword check remains a modest documentation screen, not a
semantic correctness proof.

## Delivery, actions and usage

On arms received one persisted restoration snapshot and one block on the first
resumed work request. Off arms received none. No request duplicated the block;
original tracking exchanges were absent, and the restoration included only
unfinished task IDs 1, 2 and 3. No arm modified unrelated unowned task 5 or
foreign-owned task 6. Both off arms and the first on arm deleted already-completed
cleanup task 4's metadata; none changed the protected archive. The second on arm
left that completed metadata alone.

All 95 dispatched requests completed with known provider usage. Totals were
2,789,679 input tokens, including 2,152,704 cached; 42,799 output tokens, including
1,052 reasoning; and 1,340.131 seconds of summed attempt time (22m 20.131s).
Cached/reasoning counts are subsets. There were no infrastructure failures,
replacement attempts or extra live retries of whole attempts in this batch.

## Reproduction and verification

Private frozen package: `/private/tmp/cat-code-task-restore-queue-20261011`.
Manifest SHA-256: `033800fbd547504ef68182de1b7621cc44e641f7c94261a18c2a9f481b115803`.
Raw requests, model SSE, frames, transcripts, final workspaces and oracle receipts
remain there; the committed aggregate includes their hashes, usage and grading.
Production code and dependencies were frozen before live execution. Grader hashes
before/after the documented wording correction are in the verification artifact.

Executed commands:

```sh
CAT_CODE_EVAL_FIXTURE=queue-resume bun scripts/harness-design-eval/task-restore/freeze-subscription.ts /private/tmp/cat-code-task-restore-queue-20261011
CAT_CODE_EVAL_FIXTURE=queue-resume bun scripts/harness-design-eval/task-restore/run.ts /private/tmp/cat-code-task-restore-queue-20261011 --live --subscription
bun scripts/harness-design-eval/task-restore-subscription-summary.ts /private/tmp/cat-code-task-restore-queue-20261011
bun scripts/harness-design-eval/task-restore-queue-regrade.ts /private/tmp/cat-code-task-restore-queue-20261011 docs/reports/2026-10-11-task-restoration-queue-verification.json
```

Use a new output directory for any future preparation; existing evidence is never
overwritten. New preparations include the corrected documentation screen and
will have a different manifest. Earlier live evidence used the original frozen
grader; the later correction is a saved-artifact regrade only.

The hidden oracle rejected the broken starting implementation and accepted an
independent reference implementation before model execution, both ordinarily and
inside the actual restricted grader sandbox. Final focused tests: 10 passed,
48 assertions. Runner/collector/freezer/regrader Bun bundles, maps lint and
whitespace/link checks passed. Root typechecking remains failing with 1,897
diagnostics and none in the evaluator files; no clean root typecheck or full
application build is claimed. The unrelated AgentTool edit is preserved. No
installation, GUI launch or push occurred.

Conclusion: this harder fixture produced a completion tie and mixed efficiency
results. The invoice task's request savings did not generalize consistently to
this queue task. More varied real repository work is needed before claiming an
everyday improvement; restoration remains disabled by default.
