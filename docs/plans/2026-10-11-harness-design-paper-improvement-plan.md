# Cat Code harness improvement plan

Date: 2026-10-11

Status: research and implementation proposal; no runtime changes or model experiments performed

Source baseline: `94a5790933c2bc57765973a33fd28d20b36fe07d`

Revision: source-checked against `1b4e34c7a249417d6c9560b710157bc95c2979c1` after review. Log availability was checked; log contents have not yet been analyzed for this proposal.

## Recommendation

Start with a read-only audit of existing logs. Establish how often real sessions compact, what eligible output remains after existing wire truncation, and whether avoiding a summary can repay the cache cost of rewriting history. Build only the evaluation infrastructure needed to resolve the gaps that remain.

Cat Code already has prefix summarization, large-output persistence, task tracking, provider-specific editing tools, and bounded diagnostics. The opportunity is to establish which mechanisms actually run in the desktop, measure their effects, and improve the missing or expensive paths. Building another general memory system or replacing the tool interface wholesale would be premature.

The smallest behavior candidate is restoring unfinished task state once after compaction, if an offline reproduction confirms its absence from the preserved context. Context elision is conditional on the log audit: first test it at an existing compaction decision or an independently justified cold-cache boundary, not at a new early threshold during warm requests. The P1/P2 labels below identify workstreams, not a requirement to implement elision first. No renderer redesign is needed.

## Paper evidence and limits

[Fan et al., *An Empirical Study of Harness Design for Coding Agents*, arXiv:2609.20804v1](https://arxiv.org/pdf/2609.20804), §§2–4, Tables 3–5, and Limitations:

- Across four models and two benchmarks, context management primarily prevented overflow. The average managed-versus-unmanaged success gap on SWE-Bench fell from 35.7 percentage points at 32k to 2.7 at 128k.
- T4 combined elision, recall, and summarization; it had the lowest budget-averaged cost in seven of eight model/benchmark panels. Elision plus summarization **without recall was not directly tested**.
- Persistent planning reduced SWE-Bench cost about 30%/32% for the two stronger models, with success decreasing 2.0/0.4 points.
- Bash-only helped Nemotron-550B but hurt Mistral on SWE-Bench: 45.4% versus 68.6% success with structured tools.
- Recall was rarely useful. Diagnostics and stuck detection were fixed controls, not demonstrated improvements.

These are conditional results: one run per task; planning/tool ablations only at T4/128k; 89 Terminal-Bench tasks; Python-only SWE-Bench; no Cat Code GPT/Claude evaluation. Tool ablation also changed prompts, tracking, and diagnostics. T1–T3 trigger later than T4's elision, confounding mechanism and timing. Costs use input/output list rates without a cache-discount model; they do not establish savings under Cat Code's caching. Trajectory labels support interpretations, not independent proof of causation.

Everything below is a Cat Code proposal derived from source inspection, not a performance claim from the paper.

## Current implementation: verified source facts

These findings describe the checked-out source, not measured behavior of an installed app or the user's remote feature settings.

| Area | What exists | Consequence for this plan |
|---|---|---|
| Query ordering | [`src/query.ts`](../../src/query.ts), `queryLoop`, runs tool-result budgeting, gated snip, microcompact, gated collapse, autocompact, then request assembly. [`snipCompact.ts`](../../src/services/compact/snipCompact.ts) and [`contextCollapse/index.ts`](../../src/services/contextCollapse/index.ts) are no-op stubs in this snapshot. | Preserve ordering and usage accounting; do not count the stubs as available pruning strategies. |
| Cheap context clearing | [`microCompact.ts`](../../src/services/compact/microCompact.ts), `microcompactMessages`, supports idle-triggered clearing and cached microcompaction. [`cachedMCConfig.ts`](../../src/services/compact/cachedMCConfig.ts) returns a fixed disabled config; [`timeBasedMCConfig.ts`](../../src/services/compact/timeBasedMCConfig.ts) defaults disabled, with a 60-minute gap and five recent results retained. | There is no unconditional, provider-neutral pressure-triggered elision in this inspected path. A remote idle-setting override is possible; its live value was not inspected. |
| Build differences | [`scripts/build.ts`](../../scripts/build.ts) includes `CACHED_MICROCOMPACT` and `REACTIVE_COMPACT` in dev-full. [`app/main/mainDecisions.ts`](../../app/main/mainDecisions.ts), `SIDECAR_RUNTIME_ARGS`, enables `REACTIVE_COMPACT`, not cached microcompaction. | CLI feature presence cannot establish desktop behavior. Enabling a build flag alone would also leave the fixed cached config disabled. |
| Large-output handling | [`toolResultStorage.ts`](../../src/utils/toolResultStorage.ts) persists eligible oversized results with previews. Its separate aggregate per-message budget is provisioned by a feature gate defaulting false. Resume reconstruction deliberately freezes previously seen unreplaced outputs. | Per-result truncation/persistence, aggregate admission budgeting, and aging old results are different mechanisms. Do not make pressure elision by silently changing the existing first-seen replacement contract. |
| GPT wire truncation | [`codex-fetch-adapter.ts`](../../src/services/api/codex-fetch-adapter.ts), `truncateCodexToolOutputText`, already middle-truncates eligible text to 48,000 characters: a nominal 10,000-token policy with a 1.2 allowance and a character approximation. ToolSearch, unknown-origin results, and outputs containing images are exempt. | The transcript stays complete and identical content translates deterministically. Count only additional savings after this cap; it is not a hard tokenizer limit or a whole-history budget. |
| Read deduplication | [`FileReadTool.ts`](../../src/tools/FileReadTool/FileReadTool.ts) can return `file_unchanged` for an unchanged previously read range. [`fileStateCache.ts`](../../src/utils/fileStateCache.ts) also carries read evidence used by mutation checks. | Eliding that range without invalidating its dedup eligibility can make a subsequent Read point back to missing content. Recovery must preserve mutation safeguards. |
| Context budget | [`contextWindowPolicy.ts`](../../src/utils/contextWindowPolicy.ts) separates native, entitled, configured, and effective windows, including output reservation. [`autoCompact.ts`](../../src/services/compact/autoCompact.ts) measures prompt/tool overhead and applies buffer-based thresholds. | Reuse the effective budget and overhead accounting. Avoid a second interpretation of “context window” or copying fixed percentages into production. |
| Compaction strategy order | [`autoCompact.ts`](../../src/services/compact/autoCompact.ts) first tries [`sessionMemoryCompact.ts`](../../src/services/compact/sessionMemoryCompact.ts); its two remote flags default false, with explicit environment overrides. Next it tries [`reactiveCompact.ts`](../../src/services/compact/reactiveCompact.ts), then full compaction when a prefix split is unavailable. [`compact.ts`](../../src/services/compact/compact.ts) owns summary execution and restoration. | Record the selected strategy and gates. Preserve this fallback chain and the user-constraint/origin guarantees in [`prompt.ts`](../../src/services/compact/prompt.ts). Do not silently bypass an enabled session-memory strategy. |
| Server-side clearing | [`apiMicrocompact.ts`](../../src/services/compact/apiMicrocompact.ts), called by [`claude.ts`](../../src/services/api/claude.ts), builds `clear_tool_uses_20250919` requests for internal users with `USE_API_CLEAR_TOOL_RESULTS`/`USE_API_CLEAR_TOOL_USES`. | This is a related existing mechanism, not proof it is active or equivalent on the user's provider. Record it and avoid stacking a second clearer without understanding request/usage semantics. |
| Codex continuation | [`codex-websocket-transport.ts`](../../src/services/api/codex-websocket-transport.ts), `findReplacedToolResult` and `reconcileCanonicalDelta`, reject incremental continuation when an earlier same-call output changes. | Smaller local history can require a full resend. Net tokens, cache use, and latency matter more than local tokens removed. |
| Planning | [`TodoWriteTool/prompt.ts`](../../src/tools/TodoWriteTool/prompt.ts) makes task tracking selective. [`attachments.ts`](../../src/utils/attachments.ts), `getTodoReminderAttachments`/`getTaskReminderAttachments`, gates reminders by elapsed turns, unfinished work, and changed contents. [`tasks.ts`](../../src/utils/tasks.ts), `isTodoV2Enabled`, differs by session mode. | Existing reminders are not a guaranteed fresh execution-plan view on every model call. Desktop and headless task surfaces must be recorded separately. |
| State after compaction | Full/prefix compaction restore plan files, skills, and background agents; the desktop runtime hook in [`sessionController.ts`](../../app/sidecar/sessionController.ts) restores peer context. These inspected restoration paths do not explicitly attach the TodoWrite/Task list. Reminders require ten assistant messages since the relevant write/reminder. | If compaction removes the relevant task messages, only summary prose may carry their contents until a later reminder. A preserved recent task result may already suffice; reproduce each case before adding an attachment. |
| Tools and prompts | [`tools.ts`](../../src/tools.ts) selects FilePatch for OpenAI and FileEdit otherwise; its simple tool set still includes Bash, Read, and an editor. [`promptStyles/gpt.ts`](../../src/constants/promptStyles/gpt.ts) already allows targeted shell reads and bounds repeated verification. | “Simple mode” is not a ready-made bash-only experiment. Measure changes against the current prompt, not against a hypothetical verbose predecessor. |
| Loop termination and diagnostics | [`query.ts`](../../src/query.ts) has an unknown-tool circuit breaker that emits an API-error message but returns `reason: 'completed'`. [`LSPDiagnosticRegistry.ts`](../../src/services/lsp/LSPDiagnosticRegistry.ts) bounds and deduplicates diagnostics. | A terminal reason alone is not task success. Keep diagnostic delivery constant across experiments; investigate repeated failures only if measured. |

## Priority and dependency order

| Priority | Workstream | Expected value to test | Main risk | Dependency |
|---|---|---|---|---|
| P0a | Read-only log audit and feasibility decision | Determine whether compaction/output volume is a worthwhile target | Missing coverage or treating old builds as current | None |
| P0b | Minimal offline reproductions and paired runner | Resolve only the uncertainties the audit cannot answer | Evaluating the wrong runtime or contaminated tasks | P0a for the experiment scope |
| P2, small first candidate | Restore unfinished tasks once after compaction | Preserve explicit task state before the delayed reminder | Duplicate, stale, or cross-session task state | Offline proof the list is missing; independent of P1 |
| P1, conditional | Elision at compaction or a justified cold boundary | Avoid some summaries at lower end-to-end cost | Read dedup breakage; cache cost; resume divergence | P0a evidence of opportunity and P0b correctness |
| P3, later | Model-specific workspace tool experiment | Fewer low-value interactions and invalid calls | Lost edit safeguards or task capability | Measured tool overhead; fixed planning/context policy |
| Conditional | Repeated-failure intervention | Reduce confirmed identical failing loops | Interrupting legitimate polling or retries | Evidence of recurring loops in P0a |

Do not bundle the first three behavior changes. Once individual results are understood, compare the selected combination against the unchanged control to detect interactions.

## P0a: answer the first question from existing logs

The [2026-07-06 context-growth audit](../reports/2026-07-06-context-growth-pipeline-audit.md) already analyzed 14,912 GPT calls and investigated warm-cache losses. Its measurements and then-current 252k effective window are historical evidence, not current model limits or proof of today's bottleneck. Later source changes include the wire-time cap and prefix-compaction path described above.

On 2026-10-11, a metadata-only inventory found 128 non-symlink `.txt` files in `~/.cat-code/debug`, all modified within the previous 30 days, totaling 41,478,897 bytes. Modification dates do not prove request-date coverage. No log contents were mined for this revision.

Write a small read-only extractor before a general evaluation runner. Produce an aggregate report and a manifest of examined files/date ranges without modifying live state, launching the app, refreshing credentials, or calling a model. Keep raw bodies and identifiers local; report sanitized aggregates and evidence locations.

1. Determine actual event-date coverage, model/build cohorts, request identity, and missing fields. Separate desktop, terminal, worker, and unknown-origin calls only where the logs establish the distinction. Deduplicate repeated request records and distinguish threshold checks from actual compaction attempts and successes.
2. Count automatic/manual/reactive compactions, selected strategies, failures, summary calls, and time/token use where recorded. Report rates per observed session and per model call, plus censoring at log boundaries. Do not assume missing events mean zero compaction.
3. At each observable compaction boundary, estimate eligible old-output volume **after current wire truncation**, separately from tools/instructions, recent protected context, and other history. Debug counters may not contain result bodies or age information: join to local transcripts through proven IDs where possible, otherwise report composition as unavailable. Historical transcripts may not reconstruct today's prompts exactly.
4. Compare warm/cold usage and full/incremental sends around those boundaries. Account for model/effort/account changes, idle gaps, and source versions. Cached-token counts are observations; full send is not synonymous with a cache miss, and a previous miss does not prove the next request is cold.
5. Estimate an upper bound on avoidable summary work and eligible bytes. Show what the logs cannot establish: candidate task success, causal cache savings, and counterfactual summary avoidance require controlled experiments.

**Decision:** if current cohorts rarely compact, eligible output is small after the existing cap, or even an optimistic saving cannot cover likely resend/re-read costs, defer P1. If logs cannot answer these questions, add narrowly scoped evaluation-only instrumentation. Do not build the full runner or spend quota merely to reconfirm that short tasks never hit the trigger.

## P0b: build only the missing evaluation support

### Runner and ownership

After P0a, extend the small `scripts/harness-design-eval/` extractor with only the runner/manifest support justified by its decision. Reuse the production `SidecarSupervisor → Unix socket → sidecar → QueryEngine` path for desktop evidence. Use direct query dependency injection only for deterministic mechanism tests.

Two existing implementations are references, not turnkey validated infrastructure:

- [`scripts/workspace-map-eval/prep/harness/harness.ts`](../../scripts/workspace-map-eval/prep/harness/harness.ts) demonstrates a real sidecar startup and local fake transport. Its live branch explicitly says it is unverified and copies refreshed credentials back. Do not invoke or inherit that behavior without a fresh design and authorization.
- [`scripts/apply-patch-model-eval/run.ts`](../../scripts/apply-patch-model-eval/run.ts) demonstrates bounded runs, fixture comparison, and cost limits. Its CLI/tool-specific outcomes are not sufficient for desktop context behavior.

Build each arm from an immutable source snapshot. Keep fixture workspaces, account configuration, transcripts, caches, and result files isolated per attempt. Preserve the baseline repo instructions and workspace maps in both arms; this is not a map-removal study. Keep reference fixes and hidden verifiers outside model-readable directories. Detect unauthorized reads of the live checkout, other attempts, and answer files; invalidate affected pairs.

### Record the effective configuration

Every attempt needs source/build hashes, actual model/provider, effort, feature flags, permission mode, tool-schema/prompt hashes, summarizer model, task-system mode, all four context windows, output reservation, retry/time limits, and cache-start condition. Include session-memory flags and environment overrides, server-side clearing, Read dedup, aggregate result budgeting, and the wire-truncation policy/version. Store sanitized configuration values, not credentials.

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

**P0b exit:** offline runs reproduce the effective desktop configuration, account for every scripted request/tool result, and distinguish successful completion from terminal errors. This demonstrates runner correctness, not model-quality improvement.

## P1: conditional elision at an existing compaction decision

### Proposed mechanism

Only proceed if P0a identifies a material opportunity. First compare normal autocompaction with an attempt to reclaim eligible output at that same decision point. Leave warm requests below the existing trigger unchanged. A separate candidate can use an independently justified cold boundary; the existing idle policy is a reference, not a provider-independent cache-TTL guarantee.

Integrate after `shouldAutoCompact` establishes pressure and the existing session-memory strategy has declined, before invoking prefix/full summarization. Hold that strategy's flags fixed in the first comparison; do not change selection order to manufacture an elision win. Factor out the clearing transformation where useful without changing idle-time or first-seen budgeting semantics.

There is an integration decision to resolve first: `autoCompactIfNeeded` currently returns a compaction result, not an ordinary reduced message view. Specify how the reduced view returns to `queryLoop` through an internal result/projection contract. Do not manufacture a compact boundary or silently mutate the canonical transcript to fit the existing return shape. Review that internal contract before coding; no desktop wire change is implied.

1. Calculate request pressure using the same effective-window policy, resolved runtime model/provider, and non-message overhead as autocompact. Estimate additional savings on the actual provider-bound representation, after existing caps and exemptions.
2. Only consider completed, older textual observations. Initially restrict eligibility to source reads, searches, and successful bounded shell observations whose result status remains available. Exclude unresolved errors, permission decisions, pending/background handles, structured media, and active coordination state.
3. Preserve complete recent tool-call/result rounds and the latest user steering. Never alter tool IDs, call/result pairing, role/origin, or executed-action metadata. Protect active authorization and ownership information regardless of age.
4. Replace eligible bodies with deterministic, compact stubs. Reuse an existing persisted-output reference when one exists; do not add a new recall tool. Keep the canonical transcript available for history and recovery. Older file content is historical evidence, not a substitute for re-reading before mutation.
5. Recalculate pressure. Return the reduced request without summarizing only if it creates enough headroom for useful continued work. Otherwise continue the existing prefix/full fallback, with unchanged hooks, cleanup, and failure handling. If nothing is eligible, fall through immediately. No summary-free path may claim that a summary was created or reuse summary-only bookkeeping blindly.

Use observed request growth to set minimum useful headroom and prevent repeated clear/resend cycles. Do not introduce an earlier warm-cache threshold in the first candidate. Elision at the existing threshold is still not free: summary execution can share the old cache, while elision may invalidate an earlier prefix and cause more re-reading. Measure both trajectories, including the next several requests or until completion.

### Read recovery is a correctness prerequisite

The Read tool deduplicates an unchanged exact range by pointing to an earlier result. After that result is elided, the same request must return content rather than another `file_unchanged` stub. Full and prefix compaction already clear `readFileState`; the proposed summary-free path must explicitly address this dependency.

Before including Read outputs, define which surviving model-visible result justifies each dedup entry. Start with conservative invalidation of affected entries, or a dedup-eligibility projection if existing metadata can establish the dependency. Account for multiple reads of the same file/range and inherited dedup stubs. If the relation cannot be established safely, exclude Read from the first candidate.

`readFileState` also supports mutation prerequisites: invalidation may require a fresh Read, but must never fabricate full-read evidence, weaken file-identity checks, or authorize a mutation from partial content. Test same-range rereads, changed files, offset/limit reads, and mutation authorization separately. Do not clear the whole shared cache merely to silence dedup without assessing those callers.

### Persistence and provider correctness

Try a deterministic request projection before proposing new persistence. The existing wire cap provides a useful precedent: the same result body always produces the same shortened body. Age/pressure-based elision is harder because adding a turn can change which older outputs qualify.

Prove that transcript plus a recoverable policy/version yields the same projection on repeated calls and fresh-process resume, preserves deliberate changes as history grows, and does not resurrect elided content after pressure falls. Include fork/branch selection, compacted history, model switches, Read dedup validity, and workspace handoff. A cold-boundary policy depending on wall time or unrecorded cache state does not automatically satisfy this proof. Any intentional projection change must reset or reconcile provider continuation.

If those properties hold, keep full transcripts and add no new records. The aggregate replacement records cannot automatically substitute for this proof: their existing reconstruction protects previously seen unreplaced output from new replacement.

Prefer an existing extensible transcript record only after proving that its semantics fit. If a new persisted shape is necessary, document compatibility, migration, and interrupted-write recovery through the repository's migration owner. Keep this out of the desktop wire protocol unless a user-visible feature actually needs it.

For Codex, verify that rewriting an old result forces the appropriate full send and cannot leave the server retaining the original large output through `previous_response_id`. For Claude-style providers, verify cache-prefix effects separately. Compare total cost over the remaining trajectory; reject a policy that saves local tokens but repeatedly pays more to resend history.

### Required acceptance cases

- A warm conversation below the existing compaction trigger remains unchanged; at the trigger, elision either provides useful headroom or follows the existing strategy chain.
- Many individually small results expose aggregate pressure. One large GPT result exercises the already-existing wire cap and exemptions; report only incremental improvement beyond that baseline.
- An unchanged same-range Read after elision returns the needed content; invalidated entries cannot bypass read-before-mutation or file-identity checks. Retained valid evidence continues to work.
- Pending tools, error evidence, latest user corrections, permissions, and complete recent rounds survive.
- Small contexts, very large prompt/tool overhead, and oversized protected tails fall back safely.
- Provider usage anchors before and after clearing do not subtract savings twice or trigger false overflow.
- Summary failure and user cancellation retain a usable conversation without re-executing completed tools.
- Fresh process resume, worker isolation, and handoff preserve transcript reachability and request coherence.
- Codex continuation sends the reduced context correctly; warm-cache and cold-cache trajectories are both measured.

**Keep criterion:** materially lower cost per verified completion or fewer context failures on target tasks, without confirmed task-quality or continuity regressions. **Reject criterion:** lost constraints/evidence, broken re-reading, cache/recovery costs erasing the benefit, or gains appearing only under artificially tiny windows.

## P2: restore unfinished task state once after compaction

First reproduce a compaction that removes the latest task-list result and leaves unfinished work. Verify what the next real request sees for both TodoWrite and Task modes, including preserved-tail and resume cases. The current reminder uses ten assistant messages since the relevant write/reminder; this can delay explicit task state when compaction removes both. It is not a universal ten-turn delay because prefix compaction can retain task messages and counts.

If confirmed, attach a bounded snapshot of relevant unfinished tasks once when the final compaction result is assembled. Reuse existing task state and attachment types where their framing fits. Include the current step and blockers already present in that state; do not invent test evidence or another task database. A plan-mode document remains distinct from execution tracking.

Own restoration in the engine's common post-compaction assembly, not the peer-only desktop runtime hook. Cover automatic, manual, reactive, and session-memory paths without running restoration for discarded fallback attempts. Deduplicate against equivalent current task content in the preserved suffix; scope the list to the session/agent and current request, not every task on a shared team list. Preserve the attachment durably and include its tokens in post-compact budgeting.

Leave task creation and normal reminder frequency unchanged. Omit empty/completed lists and stale tasks from earlier requests. Test concurrent task changes and a user correction around compaction. A summary-free P1 elision does not itself justify task restoration unless task content was lost.

Defer every-request plan injection unless this smaller repair fails to address demonstrated omissions. Such an experiment would need independent evidence about prompt overhead and cache effects in [`instructionAssembly.ts`](../../src/services/api/instructionAssembly.ts); it is not part of P2's initial scope.

Completion means the requested outcome and applicable checks are satisfied. A task marked complete is model-authored state, not external proof. The existing GPT verification wording is the baseline; the candidate should improve access to current evidence rather than add repeated “stop testing” instructions.

**Acceptance:** the first request after compaction has the relevant unfinished task state exactly once, including after restart; no stale/cross-agent state, attachment-budget overflow, or duplicate normal reminders. Then measure task omissions and required-check completion. Reject a behavior change that mainly creates bookkeeping or encourages premature stopping.

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

1. **Log audit:** run P0a without model quota; decide whether there is an opportunity and what is still unmeasurable.
2. **Offline:** reproduce Read dedup and missing-task-state cases, then exercise the selected candidate through deterministic requests and real tool execution. Build full sidecar support only where the boundary matters.
3. **Screening:** preselect a small cohort of realistic long tasks or consented, sanitized resume fixtures that reach the relevant trigger under the control, plus a separate ordinary-task cohort. Derive this selection from baseline evidence before inspecting candidate results. For P1, assert that the elision decision executes in the trigger cohort; for P2, assert that compaction removes relevant task state. Report trigger frequency and no-trigger pairs rather than treating unchanged runs as mechanism evidence. Choose counts after P0a; the original fixed 48-attempt proposal is withdrawn.
4. **Confirmation:** use held-out tasks, repeated pairs, and an additional model/provider if justified. Randomize arm order and match cache-start conditions. Predeclare sample size, maximum spend, stopping rules, and treatment of infrastructure failures using screening variance and discordant outcomes. Evaluate P2 and P3 independently before testing a combined candidate.

Report both the effect conditional on the trigger and the workload-wide effect using the observed trigger prevalence. Do not claim a product-wide win from a deliberately enriched compaction cohort. A resume fixture initially starts cold unless an identical warm-up is established in both arms; it cannot by itself establish savings for continuously warm sessions.

One context setting should represent actual intended usage; the other should expose pressure without making the task infeasible. Record effective input capacity after output reservation. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` changes budgeting; it does not physically shrink the provider model. If claiming a hard-window experiment, enforce identical request admission limits in the runner and calibrate token estimates. Otherwise label it a compaction-policy experiment.

Before live runs, present the exact manifest, models, maximum attempts, per-run and total token/cost/time caps, account isolation strategy, and retry policy. Live model calls and credential handling require authorization under `CLAUDE.md` §10; this planning request does not execute them.

### Promotion gates

- Any attributable security, data-loss, unauthorized-effect, or durable-continuity failure blocks promotion.
- Report paired wins/losses and task-level uncertainty for success; use task-clustered resampling for repeated runs and cost/latency differences. Do not treat repetitions of one task as independent tasks.
- Predeclare one primary candidate comparison; label other cuts exploratory and correct for multiple comparisons when making several confirmatory claims.
- Remove the provisional five-percentage-point success-loss allowance. Evaluate cost and time **per verified completion**, including failures, bounded retries, fallback to the existing policy, and human correction where measurable. Report quality separately; lower cost does not authorize worse correctness.
- Before confirmation, derive an economic break-even bound from measured baseline success and failure-recovery costs, then apply any stricter user-approved quality tolerance. As a diagnostic only, independent identical retries would cost `c / p` per success, so candidate cost ratio `r` needs `p_candidate > r × p_baseline` to save money. Real retries are often correlated and user recovery is costly; measure the actual bounded recovery workflow instead of using that simplifying model as a promotion rule.
- Predeclare the smallest worthwhile resource improvement and a quality non-inferiority margin supported by that decision, with paired confidence intervals for both. If no quality tradeoff is authorized, do not invent one. Use enough observations to estimate tail latency before reporting a p95 improvement.
- A small sample with zero observed regressions does not establish non-inferiority. If budget cannot resolve uncertainty, leave the feature experimental and retain the current default.
- Report infrastructure failures, exclusions, cache states, and every required check omitted by either arm. Cheaper unsuccessful or incomplete runs do not count as efficiency improvements.

## Delivery slices and validation

| Slice | Concrete deliverable | Validation before proceeding |
|---|---|---|
| 1 | Read-only log extractor, coverage report, and P1 go/defer decision | Current versus historical cohorts; real compaction counts; post-cap composition or an explicit missing-data finding; no live-state changes |
| 2 | Focused offline reproductions; once-after-compaction task restoration if justified | First request contains current tasks exactly once; full/prefix/session-memory paths, scoped ownership, resume, and bounded attachments |
| 3, only if justified | Minimal paired sidecar runner and conditional elision | Actual flags/tools; proven trigger exposure; Read recovery and mutation safeguards; wire continuation; deterministic replay or documented state design |
| 4 | Separate P1/P2 screening reports and keep/change/drop decisions | Complete cost per verified completion, failure recovery, trigger prevalence, paired artifacts, and uncertainty |
| 5, later | Lean tool-interface experiment | Registry/prompt consistency, permission parity, mutation correctness, missing-tool behavior, independent task verification |
| 6 | Confirmation and optional default change | Held-out evidence, interaction comparison, documented stop conditions, fresh-session rollback path |

For implementation, start with existing coverage in `src/services/compact/{microCompact,autoCompact,reactiveCompact}.test.ts`, `src/utils/contextWindowPolicy.test.ts`, `src/services/api/codex-continuation-e2e.test.ts`, and `src/query.test.ts`. Read recovery also needs the FileRead and affected mutation-tool coverage; task restoration needs compact/attachment coverage. Add only behavior tests that distinguish a real failure from the intended outcome. Use the repository's [test-audit plan](../testing/2026-09-25-test-audit-plan.md) as the portable reference. The `test-audit` skill is also installed in this environment at `/Users/pt/.codex/skills/test-audit/SKILL.md`; its existence is not a repository dependency.

Engine changes require `bun run build:dev:full` and focused tests. Sidecar/shared-boundary changes require the affected desktop suite and typechecks specified in `CLAUDE.md`; renderer builds apply only if renderer inputs change. Process-boundary tests use isolated state. GUI claims require a separately authorized Cat Code Dev run. Mocks cannot prove durable session recovery.

Rollback should disable the experimental policy for new requests while retaining readable transcripts and saved outputs. A changed model-facing projection must invalidate or reconcile provider continuation; simply flipping a flag while reusing old server context is not a complete rollback. Pin experiment configuration per attempt and avoid mid-run policy switching.

## What is known and what remains open

The source establishes mechanisms, defaults, and likely integration points. The log inventory establishes available files, not compaction frequency or request composition. The July audit supplies historical evidence of cache costs; its counts and model windows have not been rerun for current sessions. Installed build identity, live feature overrides, and real task distributions remain unmeasured here.

The next action is P0a's read-only log audit, followed by the smallest offline reproduction needed. That evidence decides whether to pursue elision at all. Missing-task restoration can proceed as a separate bounded repair if reproduced; every-request plan injection and earlier warm-cache clearing remain deferred.
