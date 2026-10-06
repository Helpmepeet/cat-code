# Workspace Map Evaluation Plan

Date: 2026-10-06

Status: Revised after methodological review. No model experiments have started.

Project: Cat Code workspace maps and their maintenance workflow.

## Objective and claim boundary

We will evaluate whether the maps support accurate repository discovery and whether
we can keep them accurate and publish updates reliably at a reasonable cost.
The first study covers navigation, semantic map quality, maintenance reliability,
and documented failure cases. It does not establish repair success, code-review
quality, or developer productivity.

The work can support an application to Agoda's Developer Efficiency team, but the
career objective will not determine task selection, grading, or success criteria.
Code review is a possible follow-up because it matches the supplied job description;
it is not a prerequisite for a credible first study.

Before spending quota on a comparison, we will determine whether we can label enough
independent tasks to detect a decision-relevant effect. If not, we will complete the
content audit, maintenance evaluation, and descriptive case analysis without making
an unsupported average-effect claim.

## Verified starting evidence

The following observations were checked on 2026-10-06 against source at commit
`6800698f585449a13eab8f4609a7682aa8b902ce` and the then-current local hook log:

- There are 17 map files, totaling 44,252 whitespace-delimited words; the root has
  944 words. Actual model context cost depends on what is loaded, not this total.
- Current instructions require the root map even when owner files are supplied.
  The current hook nudges the first broad search when it detects no prior map read.
- The log contained 553 events: 11 older arm-labelled events (7 holdout, 4 nudge)
  and 542 later `first-broad-search` events. All were labelled `kind=main`. These
  are events, not necessarily distinct tasks or complete coverage of sessions.
- Git history since 2026-07-01 contained 127 map-touching commits: 23 maps-only,
  92 with other changed paths, and 12 merges. These counts measure activity, not
  authoring time, incremental effort, or the quality of the edits.
- A literal scan for `docs/maps/` or `WORKSPACE_MAP` found 49 Markdown documents
  outside the maps directory containing references. README and project guidance
  are additional surfaces; this scan is not an exhaustive include/alias audit.
- The refresh helper captures committed source, binds completion to reviewed map
  contents, commits explicit paths, and advances structured state. The reviewer
  still owns semantic completeness.

These observations are not evidence that maps improve task outcomes or that crash
recovery works at runtime. Counts must be frozen with input hashes for the study.
Historical reports describe older implementations and are not current contracts.

Project evidence:

- [Root map](../maps/WORKSPACE_MAP.md)
- [July usage study](2026-07-04-workspace-map-usage-evaluation.md)
- [July consultation diagnosis](2026-07-14-map-consultation-diagnosis.md)
- [Historical refresh review](2026-07-12-refresh-workspace-maps-automation-review.md)
- [September scalability review](2026-09-05-workspace-map-scalability-review.md)
- [Current maintenance contract](../maps/build-release-testing.md#workspace-map-maintenance)
- [Routing hook](../../scripts/mapRoutingNudge.ts)
- [Built-in routing guidance](../../src/tools/AgentTool/built-in/mapRoutingGuidance.ts)
- [Subagent context assembly](../../src/tools/AgentTool/runAgent.ts)
- [Instruction discovery](../../src/utils/claudemd.ts)
- [Refresh helper](../../scripts/workspaceMapRefreshState.ts)
- [Validator](../../scripts/workspaceMapLint.ts)

## Research informing the design

| Source | Relevant evidence and limitation | Design implication |
|---|---|---|
| [Lulla et al.](https://arxiv.org/html/2601.20404v1) | Reports runtime and output-token savings on 124 tasks across 10 repositories; comprehensive functional correctness was outside scope. | Efficiency alone cannot establish successful engineering work. |
| [Gloaguen et al.](https://arxiv.org/html/2602.11988v1) | Reports modest average benefit from developer-written context and additional cost; generated context often hurts. Its introduction reports about 4% performance improvement, while section 4.2 describes cost increases of at most 19% for developer context. | Context may help modestly while adding overhead; do not assume a large effect or universal benefit. |
| [Khatri](https://arxiv.org/html/2607.27250v1) | Uses 17 tasks and 288 evaluated runs; detects no correctness benefit and acknowledges low power and context-content confounds. Reported 10–15-point bounds are descriptive, not a well-powered equivalence result. | Check feasibility before running; more repeats do not replace task diversity. |
| [SWE-Explore](https://arxiv.org/html/2606.07297v1) | Separates source discovery from repair. Successful traces approximate useful context, but cannot enumerate every valid evidence path. | Score supported understanding and allow alternative routes. |
| [CR-Bench](https://arxiv.org/html/2603.11078v1) | Separates defect hits, useful observations, and noise. | Use this for a later review study, not as a reason to expand the first experiment. |
| [Aider maps](https://aider.chat/docs/repomap.html) | Generated, ranked symbol context offers a simpler alternative to maintained prose. | Compare it later if prose maintenance appears expensive. |
| [SPACE](https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/) | Productivity requires multiple dimensions of evidence. | Reserve productivity claims for a separate human-outcome study. |

These studies do not evaluate this map system. Their effect sizes are not our
expected results, and their task counts are not a sample-size prescription.

## Gate 0: Choose the execution contract and check feasibility

This gate precedes any paid or subscription-backed pilot.

### Solver and resource contract

The first specification decision is the exact solver/harness pair. The proposed
primary harness is Cat Code's headless engine at a recorded commit, because that
is where the current instruction and hook behavior lives. The model/provider,
reasoning settings, feature configuration, delegation policy, and authentication
mode must be selected and recorded before model runs. No solver model is selected
by this report, and an alternative harness must explicitly narrow the claim to
its own delivery behavior.

For subscription-backed runs, use an explicit maximum number of attempts, bounded
turns/time, concurrency limits, and a quota reserve for ordinary work. Run count
alone does not bound token consumption. Do not treat a USD estimate as a reliable
subscription-quota cap. The current [cost calculation](../../src/utils/modelCost.ts)
falls back when a model lacks a pricing entry; the [query engine](../../src/QueryEngine.ts)
emits `error_max_budget_usd` when its accumulated estimate reaches the configured
limit. This supports validating budget behavior, not the blanket claim that every
GPT run is silently killed. Capture stop reasons and budget errors.

For metered API runs, record the actual billing basis and enforce per-run and total
spending limits. Do not report estimated fallback prices as observed spend.
Authorization to write this plan does not cover live logins, token refreshes, or
quota-consuming trials under [CLAUDE.md](../../CLAUDE.md). Before launching, present
the concrete run manifest, credential arrangement, quota/spend cap, and stop policy
for authorization. Do not copy the live rotating account vault into per-run homes.

Record requested and returned model identifiers. If immutable provider versions
cannot be selected, run all conditions for each task close together in randomized
order, record timestamps, and flag version changes. Keep incomplete task blocks
visible and follow a predefined rerun rule rather than comparing different eras.

### Task-authoring capacity and detectability

First reconstruct and label three development cases offline, timing retrieval,
source verification, answer-key construction, and grading preparation separately.
These cases are not held-out evaluation tasks. Use that measured effort and an
explicit available-hours budget to estimate the number of distinct tasks we can
actually produce and grade, including exclusions and ambiguous cases.

Before a model pilot, calculate sensitivity over plausible paired outcome
correlations and success rates. Choose the smallest worthwhile effect for the
actual decision first; do not choose a larger target because it is easier to detect.

An initial exact calculation already illustrates the constraint:

| Independent tasks | Power to detect +10 percentage points, 20% discordance | Power to detect +10 percentage points, 50% discordance |
|---|---:|---:|
| 20 | 3.2% | 5.0% |
| 40 | 17.2% | 9.9% |
| 80 | 43.7% | 19.8% |

These are hypothetical planning scenarios, not measured map effects. Assumptions:
one binary outcome per task per condition, independent tasks, one paired contrast,
a two-sided exact McNemar test at 5%, and discordance equal to the fraction of tasks
where the conditions differ. They do not model repeated attempts, heterogeneous
subsystems, or multiple comparisons. They show why a small sample cannot simply
be assumed adequate; actual feasibility depends on the chosen endpoint and design.
The reproducible calculation is in the appendix.

Gate decision:

- If the affordable task count can support the decision under stated plausible
  assumptions, preregister one primary contrast and proceed to a small operational
  smoke followed by the held-out comparison.
- Otherwise, prioritize content accuracy, maintenance fault scenarios, and verified
  cases of help/harm. Any agent comparisons are labelled exploratory and cannot
  establish average benefit, equivalence, or absence of an effect.

The previous automatic 48-run pilot is removed. A tiny smoke can check execution
and accounting; two examples per category cannot estimate population variance
reliably. No model run count is committed until this gate is complete.

## Task population and reproducible sampling

The initial sampling frame is the frozen set of later `first-broad-search` hook
events, resolved to source sessions by the hook's SHA-256 session-ID convention.
Validate matches and deduplicate events, sessions, and repeated underlying issues.
Do not assume a unique hash means a distinct task.

This frame selects main sessions that reached broad search without previously
consulting a map according to the detector. It excludes earlier map readers,
non-triggering tasks, and many subagent paths. It is not a random sample of all
Cat Code work and is not a randomized treatment dataset. Historical performance
will not be compared causally by whether a map was read.

Freeze the log's hash and date interval. Sort eligible deduplicated task IDs by
SHA-256 of the fixed seed `workspace-map-eval-2026-10-06-v1` plus task ID. Screen in
that order using recorded eligibility rules: understandable original request,
recoverable source snapshot, source-verifiable discovery outcome, and executable
local setup where needed. Exclude based on these rules before inspecting map
coverage. Record every exclusion and reason; do not silently substitute an easier
or map-friendly example.

For exact-file controls, define a separate dated session inventory and apply the
same deterministic ordering and eligibility process. This population is absent
from many hook events and must not be fabricated by treating the hook log as
complete. Report control and broad-search results separately.

Stratify by upstream-derived, fork-added, and mixed surfaces using provenance, not
only directory names. `app/` and `src/codex-core/` are candidate fork-heavy areas;
verify their provenance. Familiarity from model training is a possible confound,
not something this study can observe or eliminate. Record subsystem, task size,
pre-supplied paths, and parent/subagent involvement. Related variants stay in one
split. Freeze held-out tasks before adjusting maps or prompts.

## Independent reference evidence and grading

Construct each answer key from the original request, source at the relevant commit,
known behavioral evidence, and patches or successful traces when available. Do not
open maps during key construction or derive expected owners from their tables.
Patch files and trace reads are candidates: verify why each is necessary and
accept other source-backed explanations. A successful trace may itself have used
maps and is not an independent oracle. Prefer map-free traces where available and
record provenance otherwise.

The author already knows this repository and its maps. A source-only workflow
reduces bias but does not make that author independent. Seek a second reviewer for
a prespecified sample when feasible; otherwise disclose sole-author grading and
keep interpretive conclusions exploratory. An LLM judge does not remove this bias.

Ask task-specific behavioral questions, for example where a rejection occurs and
which caller receives it. Require current-source evidence and an explanation.
Do not make a ranked copy of the map's owner table the primary output contract.
A correct filename without a correct explanation is insufficient.

Freeze the rubric and answer keys before solver outputs. Grade anonymized outputs
in randomized order, with condition labels, tool traces, map citations, and explicit
map-attribution phrases removed by a fixed transformation. Preserve original
outputs and source citations for audit. Record whether a grader could infer the
condition anyway; do not claim perfect blinding. Score map-use behavior separately
from correctness. Genuine novel evidence receives adjudication, not an automatic
penalty for differing from the key.

Include a separately reported robustness set with verified stale routes, existing
paths that no longer own the behavior, and unmapped areas. Distinguish naturally
occurring cases from deliberately perturbed fixtures. Their answer keys precede
map inspection or perturbation. Do not pool these oversampled cases into an
estimate for ordinary work.

## Conditions and delivery isolation

| Condition | Treatment |
|---|---|
| A: ordinary navigation | Source, search, normal non-map documentation, and common engineering constraints; no maps or map-specific routing cues. |
| B: optional maps | Identical baseline plus the maps and the frozen hint below; no requirement or hook forcing consultation. |
| C: current map-first package | Identical map content to B, plus the recorded mandatory policy and applicable hook/subagent delivery behavior. |

Frozen B hint: “Repository navigation maps are available at docs/maps/WORKSPACE_MAP.md. You may consult them when useful; verify behavioral claims in source.”

This hint is a treatment. B measures availability plus this wording, not spontaneous
map discovery. Report actual consultation, including when it occurs. C versus B
measures a policy package; it does not isolate the hook from the root instruction.
Choose the primary contrast at Gate 0; other comparisons are secondary and receive
appropriate multiplicity handling or explicit exploratory labels.

A clean checkout alone is insufficient. Before any trial, verify this inventory:

| Delivery channel | Isolation requirement |
|---|---|
| Root, parent-directory, nested, imported, and global instructions | Assemble controlled guidance with identical unrelated constraints and inspect effective loaded content. |
| Built-in General-purpose, Plan, and Implementor routing prompts | Inspect emitted prompts. Their current guidance is conditional on caller/project map-first rules, so A/B do not necessarily require an engine patch. Remove leaked policies at their source; any needed evaluation adapter is versioned and disclosed. |
| Explore and Plan instruction omission | Both declare `omitClaudeMd`; actual handling depends on overrides, flags, managed-session behavior, and parent messages. Never infer that a subagent cannot see map guidance from this flag alone. |
| Local hook configuration | The shell hook and `.claude/settings.local.json` are ignored by Git. Recreate the intended C hook explicitly; exclude it from A/B. Preserve unrelated hook behavior. |
| Global/project memory, rules, skills, and additional directories | Use a fresh per-run HOME, config, cache, temp, and memory root plus controlled filesystem access. Audit absolute overrides, managed instructions, and included directories; HOME alone is not sufficient. |
| Hook logs and once-per-session state | Redirect to per-run HOME/TMPDIR and verify no writes reach the live cache or state. |
| README, map links in other docs, archived reports, and history | Prepare a common sanitized baseline, removing map-routing links and answer-bearing reports consistently. A must not expose dangling-map links as discovery cues. Restore only declared treatment artifacts in B/C. Keep a manifest of removals and preserve unrelated documentation. |
| Delegation and parent handoffs | Freeze allowed agent types and delegation policy across conditions. Record every spawn, prompt, supplied paths, model, and context treatment; account for child tokens/time. |
| External retrieval and credentials | Prevent access to future solutions, live transcripts, personal memory, or uncontrolled workspaces. Use the authorized credential arrangement without copying ambient user settings. |

Prefer verifying isolation using captured requests, mocked transport, and local
inspection before real calls. Archive effective prompts, environment allowlists,
config hashes, accessible-file manifests, and per-run output paths. If a channel
cannot be controlled, narrow the comparison or stop; do not claim isolation.

## Execution and metrics if the feasibility gate passes

Use a fresh session and source snapshot per attempt. Historical cases use matched
source and map versions without later solution leakage. Randomize condition order
within nearby time blocks. Keep reasoning settings, tools, permissions, delegation,
resource limits, and machine contention comparable.

Primary navigation quality is whether the task-specific answer satisfies the
frozen source-backed rubric. Secondary metrics include supported dependency
coverage, unsupported claims, time to verified useful evidence, total completion
time, and all model resources used. Map-read counts and search counts are process
diagnostics, not successful outcomes.

Analyze at task level, clustering repeats and related issues. Report paired effects,
uncertainty, strata, exclusions, and failures. Do not analyze only successful runs.
Agent timeouts remain failures; infrastructure failures have a separate label and
predeclared retry rule. A non-significant result does not establish equivalence.

Classify failures as incorrect/stale content, missed delivery, wrong route choice,
excessive reading, unsupported inference, source misunderstanding, environment
failure, or grading uncertainty. A diagnostic run supplied with verified owners
can help distinguish discovery from later reasoning; keep it outside the main
comparison and do not present it as proof of a unique causal mechanism.

## Content audit and maintenance reliability

These workstreams proceed even if the comparative experiment is infeasible.
Audit a declared sample across all focused maps, including shared boundaries.
Record source evidence, correct owners, missing dependencies, stale claims, and
information that adds value beyond filenames and symbols. Publish the sample
selection method; a sampled audit cannot certify all map statements.

Evaluate maintenance in isolated repositories and state directories:

| Scenario | Observable pass condition |
|---|---|
| Rename/deletion or moved ownership | Old active routes are corrected, including cases where the old path still exists. |
| New subsystem or shared contract | Discoverable routes and affected consumer domains are accounted for. |
| Missed intervals | Changes since the last completed source cursor remain covered. |
| Missing cursor/divergent history | Coverage mode is explicit and unfinished review is not marked complete. |
| Concurrent source/map edit | Stale reviewed content cannot be silently published as verified. |
| Interruption around commit/state writes | Recovery reconciles durable work without false completion or duplicate publication. |
| Verified no-op | No unsupported edits or empty publication are introduced. |

Preserve initial fixture, event, map diff, validator output, state transitions, and
independent semantic adjudication. Reuse existing checks after checking what they
actually establish. Publication correctness and semantic completeness remain
separate outcomes. Deterministic helper exercises need no provider calls; any
model-driven refresh exercise belongs in the approved run/resource manifest.

## Full maintenance accounting

Inventory both maps-only updates and map edits bundled into feature/fix work.
Classify by changed paths and diff content, not commit title alone. Handle merge
commits separately to avoid counting the same edit twice. Include initial creation,
routine refresh, in-task map edits, review, corrections, recovery, hook upkeep, and
validation tooling. Report changes by domain and time interval.

Git gives edit frequency and provenance, not elapsed human/model effort. Recover
cost or time only from attributable records, and prospectively record incremental
map-work effort. Mark missing historical effort unknown; do not charge an entire
feature session to its small map edit or call commit counts a financial estimate.
Report API spend, subscription resource use, human minutes, and infrastructure
separately. Net savings require measured task frequency and quality-adjusted benefit;
they remain unestablished if either side cannot be measured.

## Follow-ups, only if their additional claims matter

- Repair: a separate small study with hidden behavior checks that fail before and
  pass after a valid fix, plus regression checks. This is required before claiming
  improved implementation outcomes.
- Code review: source bug-introducing changes and reviewed controls; grade verified
  defects, missed defects, false alarms, and verification effort. Keep this out of
  the first study because dataset construction and adjudication are expensive.
- Generated symbol maps: compare with the same solver if maintained prose has high
  recurring cost; account for generation and context budgets.
- Human usefulness: measure verification/correction time and repository familiarity;
  avoid repeated-task learning and disclose sole-author participation.
- Generalization: use a separate repository and model/harness configuration before
  making claims beyond the evaluated Cat Code setup.

## Deliverables, decisions, and publication

| Stage | Deliverable and decision |
|---|---|
| 1. Feasibility | Solver/resource contract, three timed offline task preparations, frozen candidate frames, capacity estimate, and sensitivity analysis. Decide confirmatory comparison versus descriptive work. |
| 2. Evidence preparation | Source-derived keys, grading transformation, content-audit sample, and isolation manifest with captured effective prompts. Resolve leakage before trials. |
| 3. Core evaluation | Content audit, maintenance scenario evidence, full maintenance inventory, and supported failure cases. Add agent trials only under the selected scope and authorized limits. |
| 4. Interpretation | Report supported claims, uncertainty, and what would change the decision. Do not equate successful navigation with repair or review success. |
| 5. Improvement | Make one evidence-driven change and check it on untouched cases; keep development examples separate. |
| 6. Portfolio | Produce a sanitized methods/results report and case studies reflecting actual evidence, including negative or inconclusive results. |

Possible actions include retaining optional maps, narrowing mandatory consultation,
repairing stale domains, simplifying expensive prose, or declining further benchmark
spend. No positive result is required for completing the study responsibly.

The [README](../../README.md) states that this is a private fork and provides no
redistribution license. Internal reproduction can use recorded commits, fixtures,
and private artifacts. External readers cannot reproduce a Cat Code experiment
without authorized repository access. Do not promise public reproducibility or
publish upstream-derived code, maps, diffs, or transcripts by default.
A public package can contain original methodology, aggregate measurements, and
permitted synthetic examples. Reproduction on a separately licensed public
repository is a distinct follow-up with its own results.

The immediate next work is Gate 0 and offline evidence preparation. The plan does
not authorize live credential use, quota-consuming calls, or publication of the
private repository. No runtime efficacy or maintenance fault results exist yet.

## Appendix: Reproduce the planning power table

This standard-library Python calculation uses an exact two-sided binomial test on
discordant pairs. Under a scenario with discordance q and true improvement delta,
the number of discordant tasks is Binomial(n, q), and the probability that a
discordant pair favors the treatment is (q + delta) / (2q).

```python
from math import comb


def rejects(m, k):
    tail = sum(comb(m, j) for j in range(min(k, m - k) + 1)) / 2**m
    return min(1.0, 2 * tail) <= 0.05


def power(n, q, delta):
    p = (q + delta) / (2 * q)
    total = 0.0
    for m in range(n + 1):
        pm = comb(n, m) * q**m * (1 - q)**(n - m)
        conditional = sum(
            comb(m, k) * p**k * (1 - p)**(m - k)
            for k in range(m + 1) if rejects(m, k)
        )
        total += pm * conditional
    return total


for n in (20, 40, 80):
    print(n, [round(100 * power(n, q, 0.10), 1) for q in (0.20, 0.50)])
```

The final design needs sensitivity calculations for its own endpoint, correlation,
repeats, and planned comparisons. This illustration does not supply a measured
prior or justify a particular sample size.
