# Workspace Map Evaluation Plan

Date: 2026-10-06

Status: Proposed evaluation; experiments have not started.

Project: Cat Code workspace maps and their maintenance workflow.

## Purpose

We will evaluate whether workspace maps help AI coding agents do useful engineering
work, when they help, and whether their benefits justify the cost of reading and
maintaining them.

The evaluation will also become a portfolio case study for the Software Developer
role in Agoda's Developer Efficiency team within DevOps. The supplied job
description emphasizes AI-assisted code review, developer tooling, evaluation,
guardrails, automation, and product feedback. We will therefore include a code
review experiment and a maintenance reliability evaluation, alongside repository
navigation.

The objective is to reach a defensible conclusion. Positive, negative, mixed, and
inconclusive results are all valid outcomes. We will not treat map adoption,
well-written documentation, or passing link checks as proof of developer value.

## What we know so far

Source inspection on 2026-10-06 found:

- The map collection contains 17 Markdown files: the root router and 16 focused
  maps. A whitespace word count measured approximately 44,000 words in total and
  944 words in the root router. These are word counts, not model token counts.
- The intended workflow is progressive: read the root, select relevant focused
  guidance, and verify behavior in source. Agents are not expected to load the
  entire collection.
- Repository instructions currently require root-map consultation even when the
  task supplies an owner file or focused map.
- The routing hook nudges the first broad repository search when it detects no
  previous map consultation. Its current implementation does not contain the
  randomized holdout described in older project notes.
- The refresh helper captures a committed source target, checks reviewed map
  hashes, commits explicit map paths, and advances persistent state. Semantic
  ownership review still depends on the reviewer; structural validation alone
  cannot establish it.

These observations describe inspected source and configuration. They are not
benchmark results or certification of runtime reliability.

Relevant project evidence:

- [Workspace map](../maps/WORKSPACE_MAP.md)
- [July usage evaluation](2026-07-04-workspace-map-usage-evaluation.md)
- [July consultation diagnosis](2026-07-14-map-consultation-diagnosis.md)
- [Historical refresh review](2026-07-12-refresh-workspace-maps-automation-review.md)
- [September scalability review](2026-09-05-workspace-map-scalability-review.md)
- [Current maintenance contract](../maps/build-release-testing.md#workspace-map-maintenance)
- [Routing hook implementation](../../scripts/mapRoutingNudge.ts)
- [Refresh helper](../../scripts/workspaceMapRefreshState.ts)
- [Map validator](../../scripts/workspaceMapLint.ts)

Older reports describe earlier versions. We will use them to identify hypotheses
and failure cases, then verify applicability against the evaluated version.

## Research informing the design

| Source | Relevant finding or method | What we will take from it |
|---|---|---|
| [Lulla et al., AGENTS.md efficiency](https://arxiv.org/html/2601.20404v1) | Reports runtime and output-token reductions on 124 tasks across 10 repositories, but explicitly excludes comprehensive functional correctness evaluation. | Measure quality alongside speed and cost. |
| [Gloaguen et al., Evaluating AGENTS.md](https://arxiv.org/html/2602.11988v1) | Generated context often adds cost without improving success; developer-written context performs differently. | Do not assume additional guidance is beneficial. Separate content from requirements to consume it. |
| [Khatri, two-agent context-file study](https://arxiv.org/html/2607.27250v1) | Finds no measurable correctness improvement in a small study; acknowledges limited task diversity and context-delivery confounds. | Keep comparisons controlled and avoid treating repeated attempts as new independent tasks. |
| [SWE-Explore](https://arxiv.org/html/2606.07297v1) | Separates repository exploration from repair, evaluating ranked source regions under a budget. | Evaluate evidence discovery directly, then check downstream usefulness. |
| [CR-Bench](https://arxiv.org/html/2603.11078v1) | Evaluates defect findings, useful suggestions, and noise. | Count false alarms and developer verification effort, not just detected defects. |
| [Aider repository maps](https://aider.chat/docs/repomap.html) | Provides a generated, ranked, token-budgeted symbol map. | Consider a simpler generated-map alternative when assessing the value of maintained prose. |
| [SPACE framework](https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/) | Developer productivity cannot be represented by a single activity or efficiency measure. | Keep agent efficiency and human developer value as distinct claims. |

These sources study related approaches, not this exact system. Their findings
motivate the experiments; their effect sizes are not targets or predictions for
Cat Code.

## Questions we will answer

1. **Content quality:** Do routes identify current owners, relevant dependencies,
   and useful constraints accurately?
2. **Navigation:** Do maps improve source discovery compared with ordinary search?
3. **Usage policy:** Does requiring consultation improve results compared with
   making the same maps available optionally?
4. **Code review:** Do maps help an agent identify consequential defects without
   increasing unsupported findings or human verification effort?
5. **Maintenance:** Does the refresh workflow keep routes accurate and publish
   changes reliably through interruptions and concurrent work?
6. **Net value:** Do recurring benefits justify reading, generation, maintenance,
   and correction costs?

## Experiment conditions

The primary comparison will use the same model, agent harness, source snapshot,
task prompt, tools, and execution limits. Only map availability and map-consultation
policy will differ.

| Condition | Available context and policy | Purpose |
|---|---|---|
| A: ordinary navigation | Source, normal documentation, search tools, and unrelated project instructions. Maps and map-specific routing instructions are excluded. | Establish the baseline. |
| B: optional maps | The same environment plus the map collection and a brief description of its purpose. The agent decides whether to consult it. | Measure the benefit of making maps available. |
| C: current map-first workflow | The same map contents as B, with current mandatory consultation guidance and applicable routing-hook behavior. | Measure the incremental effect of the current usage policy. |

Condition B must not retain a hook that silently makes consultation mandatory.
Condition A must not receive maps through parent instructions, memory, reports,
cached summaries, or searchable history. Normal documentation and unrelated
engineering and permission requirements remain consistent across conditions.

We will record the effective instructions and enabled hooks for every condition.
Policy changes will exist only in isolated evaluation environments.

A generated symbol-map condition is a follow-up comparison, not a prerequisite
for the initial pilot. If added, it must use the same solver and tools. We will
report its context size and generation cost rather than comparing whole agent
products and attributing the difference to maps.

## Phase 1: Audit the map content and prepare the task bank

We will sample routes across all focused maps, including shared boundaries and
areas with recent ownership changes. For each sampled route, record:

- The source commit, map version, and claim under inspection.
- Whether the named owner is correct and its references resolve.
- Whether important caller, consumer, or validation routes are missing.
- Whether the text adds useful information beyond names and symbol listings.
- Any stale claim, ambiguity, or unsupported behavioral statement.

This is a sampled semantic audit. Its report will include the sampling method and
will not claim complete coverage of every map statement.

We will build tasks from real engineering questions and historical changes,
selecting them independently of whether the maps describe their areas well.
The task bank will include broad discovery, cross-component reasoning, review
work, and requests that already provide exact owner files.

Each task record will contain:

| Field | Required content |
|---|---|
| Identity | Stable task ID, task category, subsystem, and provenance. |
| Environment | Source commit, matched map snapshot, setup instructions, and artifact hashes. |
| Input | User-facing problem statement or proposed-change diff. |
| Evaluation | Required outcomes, source-backed reference evidence, accepted alternatives, and grading rubric. |
| Limits | Execution budget, timeout, tool access, and stop conditions. |
| Split | Pilot/development or held-out evaluation. Related variants stay in the same split. |

Historical repair tasks use pre-fix source and contemporaneous maps. Review tasks
use the proposed change and context that could have existed when reviewing it.
Later fixes, reports, tests, and history that reveal the answer are unavailable to
the evaluated agent. Reference answers and hidden checks stay outside its workspace.

## Phase 2: Navigation and code-review pilot

The proposed pilot contains eight tasks:

| Task type | Count |
|---|---:|
| Broad owner discovery | 2 |
| Cross-component explanation | 2 |
| Code review: one known defective change and one reviewed control change | 2 |
| Exact-owner-file requests | 2 |

At three conditions and two attempts per task, this is **48 agent runs**. This
number is an operational pilot budget, not a statistically justified final sample.
It checks the evaluation machinery and provides initial cost and variability data.

Every attempt starts in a clean, isolated environment and a fresh session. We will
randomize condition order and record model/version, reasoning settings, harness
version, cache accounting, and effective instructions. Parallelism and machine
resources must be comparable so system load does not masquerade as a map effect.

Before launching the full pilot, one setup case will verify that the runner can
capture outputs, classify completion, and apply its grader correctly. Paid runs
will have an explicit overall spending cap and per-run limits.

### Navigation grading

The agent will return a bounded, ranked set of relevant files or code regions,
their roles, and source evidence supporting the answer. The pilot will calibrate
the output budget before we freeze it for the main experiment.

We will grade correct ownership, necessary dependency coverage, unsupported claims,
and whether the answer supplies enough evidence to act on. The reference patch's
edited files are a starting point for annotation, not an exhaustive definition of
relevant context. Valid alternative routes receive credit.

### Code-review grading

Review tasks will emphasize defects that require repository context: contract
changes, caller assumptions, validation boundaries, persistence behavior, and
cross-component interactions. Straightforward local defects and reviewed controls
help reveal where maps add overhead or encourage false alarms.

Each finding will be classified as a confirmed defect, another valid actionable
observation, unsupported/incorrect, duplicate, or unresolved. Matching the known
defect requires identifying its mechanism and consequence, not repeating keywords.
New findings will be checked against source rather than automatically rejected
for being absent from the answer key. A merged change is not assumed defect-free.

Human graders will be blinded to condition labels where practical. An LLM judge
may help organize findings, but it will be calibrated against human decisions and
will not be the sole evidence for correctness. Unresolved grading disagreements
will remain visible in the results.

## Phase 3: Main held-out comparison

After the pilot, we will freeze the main protocol before running held-out tasks:

- The primary outcome for each task family and the planned comparisons.
- The task sampling method and category proportions.
- The minimum benefit worth detecting and acceptable quality degradation.
- The number of distinct tasks and attempts, justified by pilot variation and
  available budget.
- Spending limits, stopping rules, and handling of infrastructure failures.
- The analysis method and uncertainty reporting.

The earlier suggestion of 24 tasks, three repeats, and a universal 20% improvement
threshold is superseded. It was not supported by a power analysis or measured
economics. We will not replace it with another arbitrary success threshold.

The unit of comparison is the task. Attempts of the same task are clustered, and
related variants must not inflate the independent sample count. We will report
paired differences, uncertainty intervals, and category-level results. Challenge
tasks deliberately selected for difficulty will be identified separately from a
representative sample of everyday work.

Agent timeouts and failures remain in the outcome accounting. Infrastructure
failures receive a separate label and follow a predefined retry rule; we will not
silently discard poor runs. If evidence is too imprecise to distinguish benefit
from harm, the conclusion is inconclusive rather than equivalent performance.

For a small diagnostic subset, we may supply verified source owners directly.
If an agent still fails, that suggests navigation is not the only bottleneck.
These diagnostic runs will not be mixed into the primary comparison.

We will classify observed failures as inaccurate map content, missed map discovery,
wrong focused-map selection, excessive reading, failure to verify source, reasoning
or implementation error, environment failure, or grading uncertainty.

## Metrics

| Dimension | Measurement | Interpretation |
|---|---|---|
| Navigation quality | Correct owners, required relationships, supported conclusions. | Direct evidence of useful discovery. |
| Review quality | Known defects detected, confirmed findings, unsupported findings, and duplicates. | Coverage and reliability of review feedback. |
| Human effort | Time to verify, dismiss, or correct outputs. | Developer value beyond agent speed. |
| Latency | End-to-end completion time and time to first verified useful source evidence. | Includes map-reading overhead. |
| Resource cost | Actual input/output/cache usage, billing when available, and retries. | Do not assume equal token prices or count cached tokens twice. |
| Navigation behavior | Map reads, source reads, searches, and context volume. | Diagnostic measures, not success criteria. |
| Maintenance | Refresh cost, review time, missed updates, unnecessary edits, and recovery outcomes. | Cost and reliability of keeping guidance current. |

Quality and cost will be presented together. We will not compare latency only among
successful runs and hide differing failure rates. Aggregate cost per accepted
outcome will include resources spent on failed attempts; success rate and raw cost
will also be reported separately.

## Phase 4: Refresh reliability and semantic freshness

We will evaluate maintenance separately in isolated repositories and isolated
state directories, without changing live maps or the scheduled automation.

| Scenario | Expected observable behavior |
|---|---|
| Rename or deletion | Obsolete active routes are corrected across affected maps. |
| Ownership moves while old paths still exist | Semantic review identifies the new owner; path existence alone is insufficient. |
| New subsystem | A discoverable, source-backed route is established. |
| Shared contract changes | Affected consumer domains are considered. |
| Missed refresh intervals | The interval since the last completed cursor is accounted for. |
| Missing cursor or divergent history | Coverage mode is explicit; incomplete review is not reported as complete. |
| Source or map changes during review | Stale reviewed content cannot be silently published as verified. |
| Interruption around commit and state updates | Recovery reconciles durable work without false completion or duplicate publication. |
| No relevant changes | A justified no-op is recorded without unnecessary map edits. |

For each case, preserve initial state, injected event, resulting map diff, validation
output, final persistent state, and independently checked ownership accuracy.

We will distinguish **publication correctness** from **semantic completeness**.
Correct hashes and recoverable commits cannot prove that the reviewer noticed every
required change. Existing checks will be inventoried and reused where they cover
the behavior; new checks should address meaningful uncovered failure modes.

## Phase 5: Human usefulness and maintenance economics

If we want to claim developer productivity rather than agent efficiency, we will
conduct a small human study of output verification and correction. Participants
should not see the same task repeatedly under different conditions without
accounting for learning effects. Record prior repository familiarity and disclose
if only the project author participates.

The initial human study will be exploratory. It will measure actionable findings,
verification effort, correction effort, and confidence supported by evidence.

We will compare recurring task savings with map generation, refresh, and human
maintenance costs at the observed task volume. Report model/API spend and human
minutes separately unless an explicit monetary conversion is chosen. Include
quality changes and recovery costs; do not declare a financial win from token
savings alone.

## Decisions the results should support

| Observed result | Supported next decision |
|---|---|
| Optional maps improve useful outcomes; mandatory reading adds overhead | Keep the maps and revise the consultation policy. |
| Maps help cross-component work but not exact-file tasks | Use task-sensitive routing and report the limited scope of benefit. |
| Correct routes are frequently ignored | Investigate discovery and delivery before rewriting map content. |
| Agents follow maps but source claims are stale | Improve refresh coverage and source verification. |
| Navigation improves but review outcomes do not | Keep the navigation claim narrow and investigate downstream reasoning failures. |
| A simpler generated map performs comparably at lower maintenance cost | Consider simplifying the maintained prose or limiting it to distinctive knowledge. |
| Benefits do not cover recurring costs | Reduce scope, redesign, or retire the uneconomic parts. |
| Results remain uncertain | Report the uncertainty and decide whether another experiment is worth its cost. |

One repository and one model/harness configuration support a local claim. A
separate repository and a second configuration are follow-up replication work if
we want to claim broader applicability. Comparisons across configurations must
not be used to attribute model differences to maps.

## Deliverables and sequence

| Milestone | Deliverable | Completion criterion |
|---|---|---|
| 1. Specification | Frozen condition definitions, sampled content audit, task schema, and pilot cases. | Expected outcomes have source evidence; environment differences are explicit. |
| 2. Pilot | Runner, per-run records, graded outputs, cost accounting, and failure analysis. | We can reproduce and explain measurements from the 48 planned runs. |
| 3. Main protocol | Held-out task bank, sample-size rationale, budgets, metrics, and stopping rules. | Choices are recorded before seeing held-out results. |
| 4. Evaluation | Paired navigation/review results and maintenance scenario evidence. | Failures, uncertainty, and material limitations are included. |
| 5. Improvement | One evidence-driven change evaluated on untouched tasks. | Development examples and final evaluation remain separated. |
| 6. Portfolio report | Reproduction instructions, result tables, and a win/failure/neutral case study. | Claims match the evidence and explain the engineering tradeoffs. |

The implementation stack should fit the existing TypeScript/Bun project unless a
separate requirement justifies another choice. We do not need a dashboard, a new
search platform, or a GitLab integration to establish whether maps work. Those
can be separate demonstrations after the evaluation is credible.

The immediate next step is milestone 1: prepare the source-backed pilot task set
and precise evaluation specification. No paid agent trials, maintenance fault
experiments, or human study have yet been performed.
