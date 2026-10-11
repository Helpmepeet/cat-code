# Cat Code harness improvement plan

Date: 2026-10-11

Status: research and implementation proposal; no runtime changes or model experiments performed

Source baseline: `94a5790933c2bc57765973a33fd28d20b36fe07d`

## Recommendation

Start with a small evaluation harness and a controlled experiment in clearing old tool output before summarization. Then evaluate a compact execution-plan reminder and a smaller workspace tool interface independently. Keep the current runtime as the control until measured outcomes justify a change.

Cat Code already has prefix summarization, large-output persistence, task tracking, provider-specific editing tools, and bounded diagnostics. The opportunity is to establish which mechanisms actually run in the desktop, measure their effects, and improve the missing or expensive paths. Building another general memory system or replacing the tool interface wholesale would be premature.

The first implementation slice should produce an offline, reproducible baseline through the real desktop sidecar, plus request-level context accounting. The first behavioral candidate should add pressure-triggered elision behind an experimental switch. Neither requires a renderer redesign.

## Paper evidence and limits

[Fan et al., *An Empirical Study of Harness Design for Coding Agents*, arXiv:2609.20804v1](https://arxiv.org/pdf/2609.20804), §§2–4, Tables 3–5, and Limitations:

- Across four models and two benchmarks, context management primarily prevented overflow. The average managed-versus-unmanaged success gap on SWE-Bench fell from 35.7 percentage points at 32k to 2.7 at 128k.
- T4 combined elision, recall, and summarization; it had the lowest budget-averaged cost in seven of eight model/benchmark panels. Elision plus summarization **without recall was not directly tested**.
- Persistent planning reduced SWE-Bench cost about 30%/32% for the two stronger models, with success decreasing 2.0/0.4 points.
- Bash-only helped Nemotron-550B but hurt Mistral on SWE-Bench: 45.4% versus 68.6% success with structured tools.
- Recall was rarely useful. Diagnostics and stuck detection were fixed controls, not demonstrated improvements.

These are conditional results: one run per task; planning/tool ablations only at T4/128k; 89 Terminal-Bench tasks; Python-only SWE-Bench; no Cat Code GPT/Claude evaluation. Tool ablation also changed prompts, tracking, and diagnostics. T1–T3 trigger later than T4's elision, confounding mechanism and timing. Trajectory labels support interpretations, not independent proof of causation.

Everything below is a Cat Code proposal derived from source inspection, not a performance claim from the paper.

## Current implementation: verified source facts

These findings describe the checked-out source, not measured behavior of an installed app or the user's remote feature settings.

| Area | What exists | Consequence for this plan |
|---|---|---|
| Query ordering | [`src/query.ts`](../../src/query.ts), `queryLoop`, runs tool-result budgeting, optional snip, microcompact, optional collapse, autocompact, then request assembly. | Extend this path; do not create a competing context manager. Preserve its ordering and usage-accounting semantics. |
| Cheap context clearing | [`microCompact.ts`](../../src/services/compact/microCompact.ts), `microcompactMessages`, supports idle-triggered clearing and cached microcompaction. [`cachedMCConfig.ts`](../../src/services/compact/cachedMCConfig.ts) returns a fixed disabled config; [`timeBasedMCConfig.ts`](../../src/services/compact/timeBasedMCConfig.ts) defaults disabled, with a 60-minute gap and five recent results retained. | There is no unconditional, provider-neutral pressure-triggered elision in this inspected path. A remote idle-setting override is possible; its live value was not inspected. |
| Build differences | [`scripts/build.ts`](../../scripts/build.ts) includes `CACHED_MICROCOMPACT` and `REACTIVE_COMPACT` in dev-full. [`app/main/mainDecisions.ts`](../../app/main/mainDecisions.ts), `SIDECAR_RUNTIME_ARGS`, enables `REACTIVE_COMPACT`, not cached microcompaction. | CLI feature presence cannot establish desktop behavior. Enabling a build flag alone would also leave the fixed cached config disabled. |
| Large-output handling | [`toolResultStorage.ts`](../../src/utils/toolResultStorage.ts) persists eligible oversized results with previews. Its separate aggregate per-message budget is provisioned by a feature gate defaulting false. Resume reconstruction deliberately freezes previously seen unreplaced outputs. | Per-result truncation/persistence, aggregate admission budgeting, and aging old results are different mechanisms. Do not make pressure elision by silently changing the existing first-seen replacement contract. |
| Context budget | [`contextWindowPolicy.ts`](../../src/utils/contextWindowPolicy.ts) separates native, entitled, configured, and effective windows, including output reservation. [`autoCompact.ts`](../../src/services/compact/autoCompact.ts) measures prompt/tool overhead and applies buffer-based thresholds. | Reuse the effective budget and overhead accounting. Avoid a second interpretation of “context window” or copying fixed percentages into production. |
| Summarization | [`reactiveCompact.ts`](../../src/services/compact/reactiveCompact.ts) preserves complete recent API rounds and summarizes the prefix. [`compact.ts`](../../src/services/compact/compact.ts) owns summary execution, restoration, and fallback. [`prompt.ts`](../../src/services/compact/prompt.ts) already preserves user constraints and relayed-message attribution. | Preserve these guarantees. A shorter summary is an independent experiment, not part of the first elision change. |
| Codex continuation | [`codex-websocket-transport.ts`](../../src/services/api/codex-websocket-transport.ts), `findReplacedToolResult` and `reconcileCanonicalDelta`, reject incremental continuation when an earlier same-call output changes. | Smaller local history can require a full resend. Net tokens, cache use, and latency matter more than local tokens removed. |
| Planning | [`TodoWriteTool/prompt.ts`](../../src/tools/TodoWriteTool/prompt.ts) makes task tracking selective. [`attachments.ts`](../../src/utils/attachments.ts), `getTodoReminderAttachments`/`getTaskReminderAttachments`, gates reminders by elapsed turns, unfinished work, and changed contents. [`tasks.ts`](../../src/utils/tasks.ts), `isTodoV2Enabled`, differs by session mode. | Existing reminders are not a guaranteed fresh execution-plan view on every model call. Desktop and headless task surfaces must be recorded separately. |
| Plan files | [`compact.ts`](../../src/services/compact/compact.ts), `createPlanAttachmentIfNeeded`, restores a plan-file reference after compaction. | A plan-mode document is not interchangeable with the current task list. Test both rather than assuming one preserves the other. |
| Tools and prompts | [`tools.ts`](../../src/tools.ts) selects FilePatch for OpenAI and FileEdit otherwise; its simple tool set still includes Bash, Read, and an editor. [`promptStyles/gpt.ts`](../../src/constants/promptStyles/gpt.ts) already allows targeted shell reads and bounds repeated verification. | “Simple mode” is not a ready-made bash-only experiment. Measure changes against the current prompt, not against a hypothetical verbose predecessor. |
| Loop termination and diagnostics | [`query.ts`](../../src/query.ts) has an unknown-tool circuit breaker that emits an API-error message but returns `reason: 'completed'`. [`LSPDiagnosticRegistry.ts`](../../src/services/lsp/LSPDiagnosticRegistry.ts) bounds and deduplicates diagnostics. | A terminal reason alone is not task success. Keep diagnostic delivery constant across experiments; investigate repeated failures only if measured. |

## Priority and dependency order

| Priority | Workstream | Expected value to test | Main risk | Dependency |
|---|---|---|---|---|
| P0 | Baseline runner and measurements | Detect real inefficiency and avoid false wins | Evaluating the wrong runtime or contaminated tasks | None |
| P1 | Pressure-triggered old-output elision | Fewer summary calls or overflow recoveries at lower total cost | Lost evidence; cache invalidation; resume divergence | P0 and offline invariants |
| P2 | Bounded execution-plan projection | Fewer omitted outcomes and unnecessary repeat checks | Stale tasks, extra prompt cost, false completion | P0; test separately from P1 |
| P3 | Model-specific workspace tool experiment | Fewer low-value interactions and invalid calls | Lost edit safeguards or task capability | P0; fixed planning/context policy |
| Conditional | Repeated-failure intervention | Reduce confirmed identical failing loops | Interrupting legitimate polling or retries | Evidence of recurring loops in P0 |

Do not bundle the first three behavior changes. Once individual results are understood, compare the selected combination against the unchanged control to detect interactions.

## P0: establish a trustworthy baseline

### Runner and ownership

Create a narrowly scoped `scripts/harness-design-eval/` runner, manifest, and analyzer. Reuse the production `SidecarSupervisor → Unix socket → sidecar → QueryEngine` path for desktop evidence. Use direct query dependency injection only for deterministic mechanism tests.

Two existing implementations are references, not turnkey validated infrastructure:

- [`scripts/workspace-map-eval/prep/harness/harness.ts`](../../scripts/workspace-map-eval/prep/harness/harness.ts) demonstrates a real sidecar startup and local fake transport. Its live branch explicitly says it is unverified and copies refreshed credentials back. Do not invoke or inherit that behavior without a fresh design and authorization.
- [`scripts/apply-patch-model-eval/run.ts`](../../scripts/apply-patch-model-eval/run.ts) demonstrates bounded runs, fixture comparison, and cost limits. Its CLI/tool-specific outcomes are not sufficient for desktop context behavior.

Build each arm from an immutable source snapshot. Keep fixture workspaces, account configuration, transcripts, caches, and result files isolated per attempt. Preserve the baseline repo instructions and workspace maps in both arms; this is not a map-removal study. Keep reference fixes and hidden verifiers outside model-readable directories. Detect unauthorized reads of the live checkout, other attempts, and answer files; invalidate affected pairs.

### Record the effective configuration

Every attempt needs source/build hashes, actual model/provider, effort, feature flags, permission mode, tool-schema/prompt hashes, summarizer model, task-system mode, all four context windows, output reservation, retry/time limits, and cache-start condition. Store sanitized configuration values, not credentials.

Resolve configuration from the executing process. A configured model label or an environment variable alone does not prove which request was sent. Capture the model-facing request at a controlled boundary in isolated evaluations; do not feed diagnostic bundles or production logs back into model prompts.

### Measurements

| Measure | Definition |
|---|---|
| Verified task success | Hidden behavioral oracle plus required repository checks and intended output; never assistant claims, tool acknowledgements, or loop return reason alone. |
| Failure class | Incorrect result, omission, context overflow, summary failure, transport/auth failure, budget exhaustion, permission block, or invalid action. Keep infrastructure failures distinct and disclose exclusions. |
| Total resource use | All main-loop, summary, retry, and helper calls; input/output/cache tokens separately; elapsed and active time. Use actual billing when available; label token-based cost estimates. Subscription usage is not automatically dollar cost. |
| Context trajectory | Full serialized request estimate, measured provider usage when available, overhead, peak occupancy, cleared bytes/tokens, summary frequency, and recovery attempts. State estimator error. |
| Cache/continuation impact | Full resend count and cause, incremental sends, cached-input fraction, and latency around each elision/summary event. |
| Work completion | Requested outcomes fulfilled, first meaningful edit, verification outcomes, and whether a long task stopped before attempting the required work. Exempt read-only tasks from edit metrics. |
| Redundant work | Repeated reads/patches/checks, with command, scope, workspace state, result, and reason. Repeating a test after a relevant edit or flaky result is not redundant. |
| Safety and continuity | Unexpected file changes, permission bypass, missing transcript records, duplicate effects on retry/resume, or lost user constraints. Any confirmed violation rejects the candidate. |

Use deterministic events and filesystem evidence first. Human review should adjudicate ambiguous “unnecessary verification” and failed-task diagnoses. An optional model judge is secondary, with its errors and cost measured separately.

**P0 exit:** offline runs reproduce the effective desktop configuration, account for every scripted request/tool result, and distinguish successful completion from terminal errors. This demonstrates runner correctness, not model-quality improvement.

## P1: pressure-triggered old-output elision

### Proposed mechanism

Add one experimental pre-request projection at the existing microcompact stage. Factor out or reuse the result-clearing transformation where appropriate, but keep its policy separate from idle-time eviction and first-seen per-message admission budgeting.

1. Calculate request pressure using the same effective-window policy and non-message overhead as autocompact. Preserve the existing runtime-model/provider resolution contract; if the new step needs that selection earlier, resolve it once and share it rather than deriving a second model choice.
2. Only consider completed, older textual observations. Initially restrict eligibility to source reads, searches, and successful bounded shell observations whose result status remains available. Exclude unresolved errors, permission decisions, pending/background handles, structured media, and active coordination state.
3. Preserve complete recent tool-call/result rounds and the latest user steering. Never alter tool IDs, call/result pairing, role/origin, or executed-action metadata. Protect active authorization and ownership information regardless of age.
4. Replace eligible bodies with deterministic, compact stubs. Reuse an existing persisted-output reference when one exists; do not add a new recall tool. Keep the canonical transcript available for history and recovery. Older file content is historical evidence, not a substitute for re-reading before mutation.
5. Recalculate pressure. If still above the existing compaction threshold, use the current prefix summarizer. If nothing is eligible, fall through immediately; never loop trying to meet an impossible target.

Start with one explicit experimental threshold below autocompaction, then calibrate using observed request growth. Include hysteresis so the next small result does not trigger another rewrite. The threshold, retained-tail budget, and minimum worthwhile reduction are experiment parameters, not global model-size rules.

### Persistence and provider correctness

Specify the projection state lifetime before implementation. Resume, fork, compaction, and workspace handoff must reconstruct the same decisions or intentionally reset the provider continuation and send a coherent full request. The existing aggregate replacement records cannot automatically be reused: their reconstruction intentionally protects already-seen content from new replacement.

Prefer an existing extensible transcript record only after proving that its semantics fit. If a new persisted shape is necessary, document compatibility, migration, and interrupted-write recovery through the repository's migration owner. Keep this out of the desktop wire protocol unless a user-visible feature actually needs it.

For Codex, verify that rewriting an old result forces the appropriate full send and cannot leave the server retaining the original large output through `previous_response_id`. For Claude-style providers, verify cache-prefix effects separately. Compare total cost over the remaining trajectory; reject a policy that saves local tokens but repeatedly pays more to resend history.

### Required acceptance cases

- Long active conversation with no idle gap reaches pressure, clears eligible output, and only summarizes if necessary.
- Many individually small results and one very large result both remain bounded.
- Pending tools, error evidence, latest user corrections, permissions, and complete recent rounds survive.
- Small contexts, very large prompt/tool overhead, and oversized protected tails fall back safely.
- Provider usage anchors before and after clearing do not subtract savings twice or trigger false overflow.
- Summary failure and user cancellation retain a usable conversation without re-executing completed tools.
- Fresh process resume, worker isolation, and handoff preserve transcript reachability and request coherence.
- Codex continuation sends the reduced context correctly; warm-cache and cold-cache trajectories are both measured.

**Keep criterion:** materially lower total resource use or fewer context failures on target tasks, without confirmed task-quality or continuity regressions. **Reject criterion:** lost constraints/evidence, cache costs erasing the benefit, or gains appearing only under artificially tiny windows.

## P2: make the execution plan useful at the point of action

Test whether existing tracked work needs a bounded current-state projection after compaction and before subsequent model calls. Reuse TodoWrite or Task tools according to the actual session mode. Do not add another task database or confuse execution tracking with entering permission plan mode.

Construct the projection from existing task content: requested outcome, unfinished items, current step, relevant blockers, and available verification evidence. Scope it to the current session/agent and request; do not pull every task from a shared team list into every conversation. A stale completed task must not become an instruction to resume old work.

Implement the experiment in request assembly, with one current bounded copy rather than accumulating identical transcript reminders. Keep changing task content out of stable OpenAI instructions. Inspect [`instructionAssembly.ts`](../../src/services/api/instructionAssembly.ts) and the adapter's continuation keys before selecting placement: a volatile developer field can still change request reuse behavior. Measure that effect.

First compare current behavior with the projection while leaving the task-creation policy unchanged. Only if task omission remains a measured problem, separately test an initial-plan nudge for tasks with several independently verifiable outcomes. Do not force a plan from a step-count heuristic or create tasks solely to satisfy a reminder.

Completion means the requested outcome and applicable checks are satisfied. A task marked complete is model-authored state, not external proof. The existing GPT verification wording is the baseline; the candidate should improve access to current evidence rather than add repeated “stop testing” instructions.

**Acceptance:** fewer forgotten outcomes or repeat checks, with no increase in premature stopping; fresh state after user redirection, compaction, and resume; bounded prompt/tool overhead. Reject if gains come from skipping required checks or if reminders primarily create more bookkeeping.

## P3: evaluate a smaller workspace tool interface

Start with a lean structured interface, not a production bash-only switch. Retain Bash, Read, and the existing provider-appropriate editing tool, plus every capability genuinely required by the task and permission workflow. Freeze the tool set for an attempt so cache changes and missing-tool errors are interpretable.

Change tool exposure and corresponding prompt references together through [`tools.ts`](../../src/tools.ts) and the prompt builders. Keep task tools, user-input tools, asynchronous process handling, permissions, diagnostics, and sidecar-specific capabilities constant. Do not repurpose simple mode without checking everything it removes.

Measure invalid tool names, schema overhead, edit failures, successful multi-file changes, partial shell failures, and repeat patching. Coarser actions are only useful when their independent results are checked. A shorter trace that silently skips a failing command is a regression.

A bash-only arm may follow in disposable evaluation workspaces, but report it as a different action interface. Cat Code's structured file tools carry read prerequisites, permission checks, mutation validation, and reviewable results that shell commands do not automatically reproduce. No production switch should remove those guarantees to obtain a better token score.

Evaluate each model/provider and task category separately. Resolve models through the current catalog and record exact IDs; do not classify capability from model size or a marketing label. Keep the full interface as the default when evidence is inconclusive.

## Conditional work and deliberate exclusions

**Repeated failures:** first measure exact repeated failing actions, excluding polling, pagination, retryable transport errors, permission denials, and calls whose underlying state changed. If they are materially costly, test a one-time evidence-backed nudge before considering termination. Reuse the query loop's existing recovery boundaries. A detector must not turn legitimate waiting into task failure; hard stopping needs separate evidence.

**Summary prompt size:** the current prompt is deliberately detailed and preserves origin/security constraints. Measure actual summary size and downstream re-reading before proposing a more compact variant. Do not change summarization style in the elision experiment.

**Recall/storage:** retain transcript history, saved results, and recovery infrastructure. Do not equate rare model retrieval with low value to the user or to durable recovery. Defer new retrieval machinery until an identified failure needs it.

**Diagnostics:** keep the existing bounded LSP/IDE delivery fixed. A new automatic TypeScript check after every edit could add latency, duplicate feedback, and depend on partial workspace state; it needs its own measured problem.

**Architecture:** no new orchestrator, agent delegation policy, renderer dashboard, permission redesign, or session-process model change is required by these experiments.

## Evaluation sequence and decision rules

### Task set

Prepare a versioned manifest before running candidates. Include repository bug fixes, multi-file changes, TypeScript/Electron boundary work, shell-oriented tasks, long-output investigations, read-only tasks, and user redirection after accumulated context. Add deterministic lifecycle fixtures for compaction/resume/handoff and duplicate-effect detection.

Use reconstructed pre-fix snapshots or newly authored fixtures with independent acceptance criteria. A current checkout already containing the fix is not a valid repair task. Do not use the old workspace-map study copies without revalidating their provenance and isolation. Keep an unseen confirmation set outside prompt development.

### Staged budget

1. **Offline:** deterministic scripted requests, transformations, tool execution, and lifecycle cases; no model quota required.
2. **Screening:** start with 12 balanced tasks, one chosen model, two context settings, and baseline versus P1: 48 attempts for one repetition. Randomize arm order within each task and keep cache-start conditions matched. This is a screen, not proof of equivalence.
3. **Confirmation:** use a held-out task set, repeat pairs, and add a second model/provider. Select sample size and a maximum spend before running, using screening variance and discordant outcomes. Evaluate P2 and P3 independently before testing a combined candidate.

One context setting should represent actual intended usage; the other should expose pressure without making the task infeasible. Record effective input capacity after output reservation. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` changes budgeting; it does not physically shrink the provider model. If claiming a hard-window experiment, enforce identical request admission limits in the runner and calibrate token estimates. Otherwise label it a compaction-policy experiment.

Before live runs, present the exact manifest, models, maximum attempts, per-run and total token/cost/time caps, account isolation strategy, and retry policy. Live model calls and credential handling require authorization under `CLAUDE.md` §10; this planning request does not execute them.

### Promotion gates

- Any attributable security, data-loss, unauthorized-effect, or durable-continuity failure blocks promotion.
- Report paired wins/losses and task-level uncertainty for success; use task-clustered resampling for repeated runs and cost/latency differences. Do not treat repetitions of one task as independent tasks.
- Predeclare one primary candidate comparison; label other cuts exploratory and correct for multiple comparisons when making several confirmatory claims.
- Proposed engineering targets: at least 10% lower total cost/tokens or 15% lower p95 completion latency, with the success-rate difference's 95% lower bound above a predeclared −5 percentage-point margin. These are provisional product tolerances, not paper results; settle them before confirmation. Use enough observations to estimate p95 credibly.
- A small sample with zero observed regressions does not establish non-inferiority. If budget cannot resolve uncertainty, leave the feature experimental and retain the current default.
- Report infrastructure failures, exclusions, cache states, and every required check omitted by either arm. Cheaper unsuccessful or incomplete runs do not count as efficiency improvements.

## Delivery slices and validation

| Slice | Concrete deliverable | Validation before proceeding |
|---|---|---|
| 1 | Frozen manifest, offline sidecar runner, sanitized request/configuration accounting, paired result schema | Scripted success/error/overflow/cancellation cases; isolation and cost-accounting checks; actual desktop flags and tools recorded |
| 2 | Experimental pressure elision, with documented state lifetime and kill switch | Focused microcompact/autocompact/usage tests; wire continuation checks; process restart/resume and preserved transcript evidence |
| 3 | P1 screening report and keep/change/drop decision | Paired artifacts, complete costs, failure analysis, explicit uncertainty |
| 4 | Execution-plan projection experiment | Current request scope, unchanged-list overhead, compaction/resume, provider-cache behavior, no skipped validation |
| 5 | Lean tool-interface experiment | Registry/prompt consistency, permission parity, mutation correctness, missing-tool behavior, independent task verification |
| 6 | Confirmation and optional default change | Held-out evidence, interaction comparison, documented stop conditions, fresh-session rollback path |

For implementation, start with existing coverage in `src/services/compact/{microCompact,autoCompact,reactiveCompact}.test.ts`, `src/utils/contextWindowPolicy.test.ts`, `src/services/api/codex-continuation-e2e.test.ts`, and `src/query.test.ts`. Prompt/task changes also touch the relevant prompt-assembly and attachment suites. Add only behavior tests that distinguish a real failure from the intended outcome, following the test-audit skill.

Engine changes require `bun run build:dev:full` and focused tests. Sidecar/shared-boundary changes require the affected desktop suite and typechecks specified in `CLAUDE.md`; renderer builds apply only if renderer inputs change. Process-boundary tests use isolated state. GUI claims require a separately authorized Cat Code Dev run. Mocks cannot prove durable session recovery.

Rollback should disable the experimental policy for new requests while retaining readable transcripts and saved outputs. A changed model-facing projection must invalidate or reconcile provider continuation; simply flipping a flag while reusing old server context is not a complete rollback. Pin experiment configuration per attempt and avoid mid-run policy switching.

## What is known and what remains open

The source establishes mechanisms, defaults, and likely integration points. It does not establish how much today's Cat Code usage spends on summaries, suffers context overflow, repeats verification, or benefits from fewer tools. Installed build identity, live feature overrides, and real task distributions were not inspected.

The highest-priority question is whether a pressure-based clearing policy yields a net benefit under actual desktop context sizes after cache and continuation costs. The second is whether current task state is unavailable when omissions occur. P0 and the first two experiments answer these questions directly; they should determine whether later work is worth doing.
