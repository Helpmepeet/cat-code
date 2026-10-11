# Cat Code harness study: consolidated report and final decision

Date: 2026-10-11. Evidence through local commit `e36641f5`.

We investigated whether ideas from a coding-agent paper would improve Cat Code,
implemented an optional reminder of unfinished tasks after conversation
compaction, repaired a real transcript-resume bug, and tested the reminder with
live GPT-6.1 Sol calls through the existing subscription.

The reminder works mechanically. It did not demonstrate a consistent improvement
in completed work: with adequate request limits, both configurations completed
both test tasks, and efficiency results varied by task. **The final decision is
to leave the reminder disabled and stop this evaluation for now.** Keep the
verified resume repair, experiment code and evidence. This does not prove the
reminder can never help; it means we do not have a sufficient reason to enable it.

The repair and candidate are committed source changes. This project did not
install or launch Cat Code, push commits, or establish that the running daily-use
app contains the repair. There is no new enabled user-facing feature from this
work.

This report supersedes the status and proposed next steps in the earlier dated
plans and reports. Their evidence remains relevant; statements such as “live
execution blocked” describe an earlier stage, not an outstanding action now.

## 1. What the paper said

[Fan et al., *An Empirical Study of Harness Design for Coding Agents*,
arXiv:2609.20804v1](https://arxiv.org/pdf/2609.20804) studies the software around a
coding model: its tools, planning support and management of long conversations.
It compares 176 settings across four models and two coding benchmarks.

Its practical message is that harness choices matter, but their benefits depend
on the model, task and context budget. Context management mainly prevented
overflow: the managed-versus-unmanaged SWE-Bench success gap fell from 35.7
percentage points at 32k context to 2.7 at 128k. A combination of old-output
elision, recall and summarization had the lowest budget-averaged cost in seven
of eight panels. Planning changed effort and costs; simpler tool interfaces
helped some models and hurt others.

These results do not directly establish a Cat Code improvement. The paper did
not test Cat Code's GPT/Claude setup, used one run per task, and calculated costs
without cache discounts. Elision plus summarization without recall was not a
separate tested configuration. We treated the findings as hypotheses to check,
not features to copy automatically.

## 2. What we chose to investigate

Cat Code already had summarization, large-output persistence, task tracking,
provider-specific editing tools and bounded diagnostics. The source inspection
also found that the optional snip and context-collapse paths were stubs, so they
could not be counted as working optimizations.

The [original plan](../plans/2026-10-11-harness-design-paper-improvement-plan.md)
separated the following workstreams:

| Workstream | Final disposition | Reason |
|---|---|---|
| P0a: inspect existing usage logs | Completed | Established what was observable in actual histories and where evidence was missing. |
| P0b: evaluation support | Targeted offline and live runner delivered | Enough to compare task restoration through the real sidecar/resume path; not a general benchmark platform. |
| P2: restore unfinished tasks after compaction | Implemented, evaluated, left off | Delivery is verified; completion benefit and consistent efficiency benefit are not. |
| P1: discard more old tool output | Deferred | Potential volume existed, but frequency, safe removal and net cache/cost benefit were unproven. |
| P3: reduce the available tool interface | Deferred; full interface retained | No isolated evidence that a smaller interface would help the user's model. |
| Extra recall, slimmer summaries, repeated-failure interventions, planning on every request | Existing behavior retained | No demonstrated local problem justified these additions. |

## 3. What the log audit established

The read-only audit examined 128 debug logs, about 41.5 MB, covering recorded
events from October 6 through October 11. It verified joins to 44 main
transcripts; 84 logs had no verified main-transcript join.

There were 4,384 automatic context-threshold checks and **zero recorded threshold
crossings**. The records used an effective window of 1,030,000 tokens, and the
largest observed tokens-to-threshold ratio was 60.47%. One manual compaction
boundary was found within the matched histories and date ranges. These are
incomplete historical observations, not a population compaction rate or proof
that compaction never happens in daily use.

Many small old tool outputs can accumulate despite the existing per-result
48,000-character wire cap. A reconstructed historical prompt proxy contained
about 1.08 million potentially old-output characters. That was an optimistic
volume estimate, not proof those characters were safe to remove or a token-saving
measurement. Removing old history can also affect read deduplication, mutation
evidence, continuation and cache reuse.

Recorded cached input was roughly 95% of input tokens in the audited aggregates.
That made “smaller prompt means cheaper” an especially weak assumption. The audit
could not determine cost per verified completion, compaction's causal effect on
cache use, or the frequency of task forgetting. It justified deferring broad
context pruning. See the [audit execution report](2026-10-11-harness-improvement-execution.md)
and [sanitized data](2026-10-11-harness-log-audit.json).

## 4. What changed in the product source

### Optional unfinished-task reminder

Compaction replaces older conversation content with a summary. If that removes
the task-tracking exchanges, the next model request may lack explicit unfinished
task state until the normal delayed reminder appears. The candidate adds a
bounded snapshot once after compaction, while the complete task state remains
stored separately.

The snapshot is scoped to the relevant session, agent and task list, uses
successful tracking evidence, excludes completed and unrelated tasks, and avoids
duplicate restoration. Its text is bounded below 3,000 characters with an
estimated 1,000-token reserve. Conservative eligibility can omit older work that
would still be useful; this is not a general-purpose memory system.

It requires both the compiled `COMPACT_TASK_RESTORE` feature and
`CAT_CODE_EVAL_COMPACT_TASK_RESTORE=1`. The runtime opt-in remains absent by
default. The feature was enabled only in the experiment's on configurations.

### Independent transcript-resume repair

The first scripted experiment found a more concrete problem: a reminder could
be saved in the transcript but absent from the first resumed model request.
Passing artifact checks had initially hidden this delivery failure.

Prefix compaction retained a selected conversation tip, but the transcript reader
rejected the following compact boundary because its logical parent belonged to
the summarized prefix. Resume could select the old tip and omit the subsequent
summary, local commands and restoration attachment.

The repair follows the existing evidence that the boundary preserves the selected
tip in the same session. It does not add new persisted fields or accept arbitrary
discarded branches. Earlier work also repaired trailing attachment restoration
when the selected tip was the summary itself.

In both reproduced fresh-process cases, the result changed from **one snapshot
saved / zero delivered** to **one saved / one delivered**. Across 32 repaired
scripted attempts, checks found correct delivery and no duplicate reminder or
revival of cancelled, completed or unrelated work. These are correctness results,
not evidence that a live model became better at coding. The reader repair remains
valuable independently of the optional reminder. Details are in the
[resume-repair report](2026-10-11-task-restoration-resume-repair.md).

## 5. How the experiments worked

The runner used the actual supervisor, Unix socket, sidecar, QueryEngine, task
tools, compaction, transcript persistence and fresh-process resume. Offline runs
scripted provider responses to test infrastructure and delivery. Live runs used
GPT-6.1 Sol at low effort through the authorized Cat Code subscription, using
production request/response translation and normal coordinated account access.

The sidecar's provider client/auth boundary was proxied through a parent gateway.
Credentials stayed with the parent; they were not copied into fixture accounts
or recorded in request evidence. Model tools ran in isolated fixture workspaces
and could not access the hidden grader, other attempts or live account files.
The transport was HTTP SSE, so these timings do not measure desktop WebSocket
continuation performance.

Each comparison ran serially **off/on, then on/off**, with equivalent starting
files within each pair and a fresh provider identity per attempt. Both
configurations had access to the task specification. The investigation history
was prepared, then naturally summarized by the model; it was not an authentic
full model-generated investigation. Compaction was manually forced. Independent
graders checked actual output files, protected files and required command
execution after the model stopped.

The original preparation proposed dedicated paid API accounts and spending
controls, first for Anthropic and then for GPT. Those proposals were never the
route executed. The user's later subscription authorization superseded them.
No separate API billing account or API key was introduced.

## 6. All live rounds and their results

### A. Preliminary attempts: evaluator failures

Four live attempts made 15 requests but produced no verified completion. An
overly conservative input reservation was not reconciled to actual usage, and
the sandbox blocked `/dev/fd` operations needed by Read. These were evaluator
problems, not evidence against the reminder. Their outcomes and usage were kept.

Fourteen additional startup/admission failures made zero model requests. A
historical automatic approval review rejected one unlaunched credential-path
denial probe; that probe was removed before later approved launches. None of
these zero-call events is counted as a model trial or successful completion.

### B. Corrected pilot: request limit prevented a valid comparison

The corrected pilot allowed 12 requests and six minutes per attempt.

| Attempt, in execution order | Artifacts passed | Entire protocol completed | Requests | Time |
|---|---|---|---:|---:|
| Pair 1, off | Yes | No; request cap | 12 | 172.786s |
| Pair 1, on | No | No; request cap | 12 | 131.723s |
| Pair 2, on | Yes | Yes | 10 | 149.077s |
| Pair 2, off | Yes | No; request cap | 12 | 141.003s |

Both off attempts finished artifacts before the cap blocked the fixed recovery
turn. Only one attempt completed the whole protocol, so there was no fully valid
matched pair. The second off attempt also deleted foreign-owned fixture task
metadata. That was a real isolated-fixture mistake despite passing artifact
checks; it did not establish a general difference between configurations.

The user correctly challenged stopping at this result: the cap was preventing
the experiment from answering its question. We increased it and reran.

### C. Higher-limit invoice task: quality tie, fewer requests with the reminder

Limits became 64 requests and 20 minutes per attempt. The invoice task required
decimal totals and fractional rounding, CSV escaping, documentation, a successful
check command and protected archive preservation. All four attempts passed the
eight hidden behavioral checks and completed the protocol; none hit a limit.

| Attempt | Final result | Requests | Time | Input, including cached | Output |
|---|---|---:|---:|---:|---:|
| Pair 1, off | Pass | 20 | 185.671s | 479,367 | 4,607 |
| Pair 1, on | Pass | 11 | 167.456s | 290,687 | 4,911 |
| Pair 2, on | Pass | 20 | 192.104s | 484,100 | 5,097 |
| Pair 2, off | Pass | 22 | 195.396s | 515,454 | 4,940 |

On used 31 requests versus 42 off, 26.2% fewer, and 5.6% less summed time.
However, on used slightly more noncached input and output. Lower total input
therefore did not establish monetary or subscription-quota savings. Most of the
request difference came from the first pair; reduced task rediscovery was not
consistent across both pairs. No unrelated or foreign-owned task was changed.

### D. Harder durable-queue task: quality tie, mixed efficiency

At the user's request, we built a substantially more demanding fixture: repair a
durable TypeScript job queue with dependencies and cycles, priority/FIFO ordering,
restart-safe idempotency, fenced leases, stale acknowledgements, retries,
cancellation propagation, append-before-memory behavior, detached state, journal
replay and interrupted-write recovery. The task also required regression tests,
documentation and successful checks, while protecting the specification and
public interface.

The independent oracle rejected the broken seed and accepted a separate reference
implementation before live execution, including in the restricted grading
sandbox. All four model solutions passed all 25 behavioral checks, actual
regression-test execution and protected-file checks. None hit a limit.

| Attempt | Final assessed result | Requests | Time | Input, including cached | Output |
|---|---|---:|---:|---:|---:|
| Pair 1, off | Pass after documentation regrade | 24 | 331.635s | 690,143 | 10,713 |
| Pair 1, on | Pass | 23 | 297.208s | 644,144 | 9,246 |
| Pair 2, on | Pass | 27 | 361.687s | 819,930 | 11,900 |
| Pair 2, off | Pass after documentation regrade | 21 | 349.601s | 635,462 | 10,940 |

On used 50 requests versus 45 off, 11.1% more, and 10.4% more inclusive input,
but 3.3% less summed time and less noncached input. The earlier request reduction
did not generalize consistently. No unrelated or foreign-owned task was changed.
This was a harder small synthetic project, not a large production-repository
benchmark or evidence that we reached the model's difficulty limit.

**Grader correction:** the original documentation screen falsely failed both off
solutions because it recognized “tail,” “torn” and “partial” but not their correct
wording, “final fragment.” After all live attempts ended, all four READMEs were
read against the same requirements. A regression test reproduced the false
failure, the matcher was corrected, and the same corrected grader regraded all
four saved workspaces. No model reran and no answer changed. The original raw
results remain intact. The queue verification JSON's top-level two on wins are
historical automated results; **`documentationRegrade` contains the corrected
four completions and two ties**. Treating the original verdict as a model win
would be wrong.

Across the corrected live rounds, each on attempt received the restoration once
on its first resumed work request; off received none, with no duplicate blocks.
Some attempts deleted already-completed cleanup task metadata, but none changed
the protected archive. Metadata cleanup is distinguished from executing the
completed file-deletion instruction.

## 7. Total recorded experiment usage

| Live batch | Attempts | Requests | Input | Cached subset | Output | Reasoning subset | Summed attempt time |
|---|---:|---:|---:|---:|---:|---:|---:|
| Preliminary failures | 4 | 15 | 537,754 | 132,096 | 13,203 | 0 | 412.638s |
| Corrected capped pilot | 4 | 46 | 1,185,531 | 644,480 | 17,411 | 249 | 594.589s |
| Higher-limit invoice | 4 | 73 | 1,769,608 | 1,193,472 | 19,555 | 236 | 740.627s |
| Harder queue | 4 | 95 | 2,789,679 | 2,152,704 | 42,799 | 1,052 | 1,340.131s |
| **Total** | **16** | **229** | **6,282,572** | **4,122,752** | **92,968** | **1,537** | **3,087.985s** |

That is about **51 minutes 28 seconds of summed live-attempt time**. It includes
failed preliminary model attempts and capped attempts. Cached input and reasoning
output are subsets, not additional tokens. All dispatched requests in these
records have completed responses with known usage.

This is not total project effort or cost. It excludes planning, implementation,
debugging, report-writing and other session usage, offline scripted runs, and
zero-call startup time. No API dollar charge or subscription-quota percentage was
inferred. The SDK's requested 4,096-output-token value was not forwarded by the
production subscription translator, so it was not an enforced provider output
cap; actual output was measured.

## 8. What is established, and what remains unknown

| Question | Answer supported by this work |
|---|---|
| Was there a real resume bug? | Yes. The production reader omitted a persisted compact continuation; before/after regressions and real process delivery demonstrate the repair. |
| Does the optional reminder arrive correctly? | Yes in the tested offline and live paths, with scoped content and no duplicate delivery. |
| Did it make the tested completed work better? | No observed completion advantage in the eight uncapped attempts: four matched pairs tied across two fixtures. |
| Did it reduce effort? | Sometimes. Invoice requests decreased; queue requests increased. Timing and cache results were mixed. |
| Does it improve everyday Cat Code usage? | Unknown. The small, forced-compaction sample cannot establish frequency or general benefit. |
| Did we enable or install it? | No. The reminder remains off; this project made local source commits without installation or GUI acceptance. |

The eight uncapped attempts should not be pooled with invalid or capped attempts
as though all 16 were one uniform statistical sample. There are only two repeats
per fixture, one model/effort setting, prepared histories and independently
generated summaries. Cache state was observed rather than controlled. Live runs
used Task tracking; offline coverage also exercised Todo restoration. Hidden
checks establish their specified contracts, not correctness for every possible
input. All successful off runs also had the underlying resume repair, so the live
comparison measures the reminder, not the repair's benefit over broken resume.

## 9. Verification and process lessons

Production work passed the dev-full build and focused behavior/process checks.
The initial implementation recorded 24 candidate behavior tests, fresh-process
restoration and 29 lifecycle process tests, with desktop and sidecar typechecks
passing. Its broad desktop run had 5,865 passes and the same eight failures as
baseline. The later reader repair passed 74 storage tests; broader related checks
had 173 passes, one skip and two failures reproduced on the pre-fix baseline.

The final evaluator work passed 10 focused tests with 48 assertions, four Bun
entrypoint bundles, maps lint and whitespace/link checks. Root typechecking still
had 1,897 diagnostics, with none in the evaluator files; a clean root typecheck is
not claimed. These are stage-specific checks and overlapping suites, not counts
to add together. No full application build was repeated for the final evaluator-
only changes. Earlier reports contain exact commands and baseline comparisons.

The investigation also exposed avoidable process costs:

- Paid-API preparation and approval machinery grew before settling on the
  user's actual subscription/model path. It delayed the practical comparison.
- Scripted artifact success initially hid missing reminder delivery. Provider-
  boundary observation was necessary to detect the production bug.
- The first live cap was too low to compare complete attempts. Raising it
  resolved that confound, as the user suggested.
- Independent graders can be wrong. Inspecting the queue documentation false
  failures prevented reporting a nonexistent quality win.
- A working mechanism and a passing fixture are distinct from everyday value.
  Once the larger-limit and harder-task results were mixed, stopping was a
  reasonable decision, without either declaring success or deleting useful work.

The unrelated edit in `src/tools/AgentTool/runAgent.test.ts` was preserved
throughout. No installation, Cat Code GUI launch, push or default enablement was
part of this project.

## 10. Final disposition and evidence index

Keep the transcript-reader repair, gated candidate, audit/evaluator support and
recorded results. Leave task restoration disabled. Stop this evaluation now.
There is no pending approval, required paid run or automatic follow-up. Revisit
only if a concrete daily-use loss of unfinished work appears, or the user chooses
a new evaluation question. No further experiment is required to close this work.

| Stage | Local commit(s) | Detailed evidence |
|---|---|---|
| Paper/source plan and revision | `1b4e34c7`, `b0bbbaa9` | [Plan](../plans/2026-10-11-harness-design-paper-improvement-plan.md) |
| Audit, gated candidate, initial repair | `5c69d686`, `59771b50`, `5e2b9dae` | [Execution](2026-10-11-harness-improvement-execution.md), [audit JSON](2026-10-11-harness-log-audit.json) |
| Offline experiment and discovered delivery gap | `2ba07b86` | [Experiment](2026-10-11-task-restoration-experiment.md), [verification](2026-10-11-task-restoration-offline-verification.json) |
| Preserved-tip resume repair and proof | `46f82fbc`, `55622ebc` | [Repair](2026-10-11-task-restoration-resume-repair.md), [verification](2026-10-11-task-restoration-repair-verification.json) |
| Subscription pilot, including preliminary failures | `cf9beffc` | [Pilot](2026-10-11-task-restoration-subscription-pilot.md), [verification](2026-10-11-task-restoration-subscription-verification.json) |
| Higher-limit invoice comparison | `c97460a9` | [Comparison](2026-10-11-task-restoration-higher-limit-comparison.md), [verification](2026-10-11-task-restoration-higher-limit-verification.json) |
| Harder queue comparison and uniform regrade | `e36641f5` | [Comparison](2026-10-11-task-restoration-queue-comparison.md), [verification including corrected results](2026-10-11-task-restoration-queue-verification.json) |

Committed aggregate artifacts retain usage, grading, hashes and limitations.
Detailed reports identify frozen manifests and raw local packages under
`/private/tmp`. Those temporary directories are not durable repository storage;
their future availability is not guaranteed. The recorded hashes identify the
evidence but cannot reconstruct deleted raw files. Reproduction instructions are
historical documentation, not a request to restart model calls.
