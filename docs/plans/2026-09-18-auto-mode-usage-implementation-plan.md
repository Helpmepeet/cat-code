# Auto mode analytics on the Usage page

Implementation plan • 18 September 2026

Revision 4 • execution guide for an implementing agent, including a smaller model. The underlying specification and the 14-task guide have received independent subagent review. This revision addresses malformed-record handling, range-wide category ranking, and exact Sankey sizing. Implementation and runtime verification are still outstanding.

## Execution guide: start here

This guide turns the specification below into ordered, bounded changes. Complete one task card at a time. Do not implement the entire feature in one edit. The guide supplies proposed contracts and algorithms; they are design instructions, not claims that those APIs already exist.

### Fixed product decisions

1. Add exactly four charts: Sankey, command block-rate line, decision stacked bars, block-category bars.
2. Integrate into the existing desktop Usage page. Keep its existing timing panel; add no auto-mode latency chart.
3. Count the initial automatic permission decision once per logical tool attempt. Provider retries and later permission rechecks do not add attempts.
4. Count every instrumented auto-mode tool attempt in flow/bars. Only verified shell-command tool kinds enter the rate denominator.
5. Rate = initial automatic policy denials / recorded command permission attempts. It is not model accuracy or execution success rate.
6. Use retained metadata and the existing Usage worker/index/transport. Do not activate global analytics or add a second collector.
7. Missing history is unavailable; it is never invented as zero. Keep policy behavior and model input unchanged.

### How to work through the cards

Read these fixed decisions, Task 00, and the specification subsection named by the current task. Keep a brief progress table in the normal implementation report: task, changed files, verification command/result, next task, and unresolved evidence. This is a continuation record, not a new runtime feature.

For each card: inspect current owners → make the smallest cohesive change → run its targeted check → record the result → continue. If a check fails, fix that slice before expanding it. Do not repeatedly run every package gate after every small edit. Do not claim a card passed because types compile if it requires a behavior fixture.

Names of proposed new modules may follow nearby conventions. Do not change a metric definition, permission boundary, or retention policy to make an implementation easier. A blocked optional drill-down is not a reason to stop the four-chart implementation. Where source access is unavailable, write the precise missing symbol/question and follow the discovery fallback described in Task 00; do not fabricate a working integration.

| Task | Output | Depends on |
|---|---|---|
| 00 | Evidence map and resolved integration seams | None |
| 01 | Bounded event and result types | 00 |
| 02 | Pure disposition mapper | 01 |
| 03 | Logical-attempt lifecycle and writer | 01–02 |
| 04 | Production observer wiring | 03 |
| 05 | Record reducer and coverage rules | 01–02 |
| 06 | Durable index projection and activity isolation | 04–05 |
| 07 | Usage summary, grouping, validation, and versions | 06 |
| 08 | Frontend selectors and chart fixtures | 07 |
| 09 | Command block-rate line chart | 08 |
| 10 | Stacked decisions and block-reason bars | 08 |
| 11 | Sankey topology and layout | 08 |
| 12 | Usage page integration | 09–11 |
| 13 | End-to-end regression and delivery | 12 |

### Task 00 — resolve the few facts that cannot safely be guessed

**Read:** repository instructions; evidence table below; `src/utils/permissions/permissions.ts`; relevant callers; `src/utils/sessionStorage.ts`; `src/utils/statsUsage.ts`; `src/utils/statsUsageIndex.ts`; shared Usage types/parser; `UsagePage.tsx`.

**Write:** an evidence table with exactly these questions and a source-backed answer for each:

| Question | Known starting point | Required answer |
|---|---|---|
| Where does a logical initial tool permission attempt begin? | `useCanUseTool.tsx`; desktop/runtime callers must also be traced | Symbol that owns the tool occurrence and lifetime, including forced decisions |
| How is a recheck recognized? | `interactiveHandler.ts` reuses the tool-use ID | Explicit initial/recheck signal or occurrence-owned context that survives re-entry |
| What other callers need wiring? | Search `hasPermissionsToUseTool`, `forceDecision`, and `CanUseToolFn` in `src/` | Caller matrix: desktop/terminal/headless/subagent, initial/recheck, supported/unsupported |
| How is effective auto mode computed? | Core permission function’s current feature/mode gates | Reuse the same predicate; do not approximate by UI state |
| How do diagnostics stay out of model input? | Existing execution diagnostic writer/readers | Writer and transcript-reader/filter owners plus a test location |
| Is complete historical permission metadata retained? | Global analytics is inert; Usage index lacks permission events | Actual source/schema or explicit prospective-only conclusion |
| How will each bucket’s population support be established? | Existing session/build/mode provenance must be inspected | Exact evidence accepted; unknown source intervals stay partial/unavailable |
| Which versions invalidate indexed records and saved summaries? | Current `usageIndexPath`, shared counting/schema versions, parser | Current values and the smallest required successor changes |

Use targeted `rg` searches and follow callers, not a repository-wide reading tour. Inspect alternate engine adapters only far enough to determine coverage. Do not implement support for a different engine’s permission system incidentally.

**Default decisions:** prospective permission recording; no historical inference; existing SVG components; no drill-down beyond existing supported session navigation; no new dependency. If existing history proves adequate, implement a tested adapter to the same contract rather than bypassing it.

**Pass:** every integration question either has a verified owner or a precise unsupported-coverage treatment. A missing core writer/initial-attempt seam is a bounded investigation blocker for Tasks 03–04, not permission to invent one. Other pure tasks can proceed with fixtures while that seam is investigated. Routine naming and API placement are the implementer’s decision.

### Task 01 — define one small event contract

**Proposed owners:** `src/utils/permissions/autoModeObservation.ts` for engine observation types and `app/shared/usageAutoMode.ts` for renderer-safe aggregate types. Keep runtime writer imports out of shared renderer types. If an existing dependency-light shared location is preferred, use it and document the choice.

Use closed unions equivalent to these; names can follow repository conventions:

```ts
type Disposition =
  | 'allowed' | 'policy_blocked' | 'review_required'
  | 'operational_error' | 'cancelled' | 'unknown_outcome';
type SummaryOutcome = Disposition | 'incomplete';
type Route =
  | 'base' | 'forced' | 'guard' | 'accept_edits'
  | 'allowlist' | 'stage1' | 'stage2' | 'unknown';
type ToolKind = 'bash' | 'powershell' | 'other';
type Stage = 'fast' | 'thinking';
type Failure =
  | 'unavailable' | 'invalid_response' | 'context_limit'
  | 'interrupted' | 'internal_error' | 'unknown';
type PrimaryCategory = {
  kind: 'built_in' | 'custom' | 'permission_rule';
  id: string; // validated bounded identifier, not rule text
};
```

Record kinds:

| Record | Required payload, in addition to trusted writer envelope |
|---|---|
| Start | schema version, attempt ID, tool-use ID, ToolKind, effective-auto provenance, initial evaluation marker |
| Stage entered | schema version, attempt ID, Stage, phase=entered |
| Stage resolved | schema version, attempt ID, Stage, phase=resolved, exactly one valid `shouldBlock` or terminal Failure |
| End | schema version, attempt ID, raw result (`allow`/`deny`/`ask`/`throw`), Disposition, Route, bounded cause, optional PrimaryCategory |

Add a direct observational mode/capability marker only if required by the source-backed coverage strategy in Task 00. It must identify supported source intervals without storing settings or prompts. Instrumentation enabled does not certify that every write succeeded.

Use trusted writer timestamp/session/subagent/build envelope fields. Payload cannot override that envelope. Reuse existing ID and label limits where applicable; introduce explicit bounds if no relevant limit exists. Category IDs require the same screening as other renderer-visible labels; unknown/custom free text is not safe merely because it is called an ID.

This is the strict emitted-event contract. The defensive retained-record reader additionally implements Task 05's two-layer validation and salvage rules. Rejecting a malformed event must not discard trustworthy correlation evidence; missing/invalid route or category detail must not erase an independently valid disposition.

**Pass:** unknown kinds, invalid enum values, conflicting stage fields, oversized IDs, and illegal envelopes are rejected by targeted schema tests. Incomplete is never emitted as a fabricated end event. Fixtures contain no real command, path, credential, or transcript text.

### Task 02 — implement a pure disposition mapper

**Proposed owner:** `autoModeObservation.ts` or a neighboring pure `.ts` module. Inputs are the existing permission result plus observed classifier/guard cause; output is the normalized end metadata. Do not add fields to the live permission return type solely for analytics when an observation context suffices.

Apply this precedence table:

| Observed initial result | Additional evidence | Disposition |
|---|---|---|
| allow | Any route | allowed |
| ask | Any cause, including classifier block/failure | review_required |
| deny | Recorded unavailable/parse/context/internal failure cause | operational_error |
| deny | Recorded base rule, safety policy, or valid classifier policy block | policy_blocked |
| deny | Cause cannot be established | unknown_outcome |
| throw | Recorded context-limit/provider/internal failure | operational_error |
| throw | Recorded cancellation/interruption, no stronger operational cause | cancelled |
| throw | Cause unknown | unknown_outcome |

Only inspect structured evidence. Do not parse English exception/rejection messages. A `shouldBlock=true` classifier result may mean unavailable; inspect its typed outcome first. An AbortError may mean context overflow; inspect its observed cause first. A malformed category does not turn a known policy block into an unknown disposition: use Uncategorized for grouping.

**Pass:** table-driven tests cover every row, plus Stage 2 block → ask and unavailable → ask. The mapper has no I/O and never modifies its input permission result.

### Task 03 — implement the observer lifecycle and durable writer

**Owners:** the initial occurrence owner resolved in Task 00, proposed `autoModeObservation.ts`, and the diagnostic appenders in `sessionStorage.ts`.

Create one occurrence-owned observer with an injected writer for unit tests. Production uses the existing transcript owner. Proposed methods: `enterStage`, `resolveStage`, and `finish`. The initial creation emits Start only if effective auto mode is true. Freeze that fact and the trusted occurrence identity at creation.

The observer accepts only the first finish; repeated callbacks become no-ops for recording. It never caches a permission result for use by the engine. Rechecks must still execute their existing permission behavior, but use a non-counting observer or no observer. Attach identity to the existing occurrence lifetime rather than a permanent process-global Map. Dispose in-memory state with that occurrence; retained records provide history.

Provider fallback happens inside a stage: one entered event, one resolved event after the last internal attempt. Record terminal failure only if the stage actually finishes in failure. No new retry behavior is introduced.

A production wrapper follows this conceptual pattern; adapt it to the verified owner:

```text
observer := initial occurrence's observer, or absent for a recheck
try:
    result := existing permission computation, unchanged
    observer.finish(map structured result + observed cause)
    return the same result
catch error:
    observer.finish(map observed cause + existing error classification)
    rethrow the same error
```

Respect the existing transcript lease assertion. Ordinary append I/O is best-effort; do not weaken ownership checks or construct orphan transcripts. No writer call may execute a tool or make a model request.

**Pass:** one Start/End under duplicate finish, no Start on a recheck, new tool occurrence gets a new attempt, same result/error identity returned, null transcript owner creates no file, existing lease failure remains enforced.

### Task 04 — wire the observer into production paths

**Owners:** verified outer callers; `permissions.ts`; `yoloClassifier.ts`. Modify only the relevant call chain. Preserve forced decisions, input updates, abort signals, ordering, denial counters, and prompt/model options.

At the outer initial occurrence, create the observer before the forceDecision/core-check choice. Inside the core checker mark the chosen route as soon as it is established. Pass an optional observation callback/context through the classifier call so it can report stage entry/resolution without importing the Usage collector. Optional observer absence must preserve the existing API behavior for other callers.

Map route at these branches: base early return → base; supplied initial forceDecision → forced; explicit interaction/safety guard → guard; successful acceptEdits → accept_edits; allowlisted tool → allowlist; only first stage reached → stage1; second stage reached → stage2. Missing metadata → unknown. A failed fast-path eligibility check does not produce a terminal event.

Record precise operational cause immediately before existing context-limit throws or unavailable/parse-result returns. Do not catch and reinterpret unrelated engine exceptions to obtain a nicer chart.

**Pass:** permission-entry and caller-level tests assert the original result, input updates, denial counters, and classifier call count alongside the expected records. Include forced allow/deny, all fast paths, Stage 1 allow, Stage 2 allow/block, ask fallback, headless context limit, user abort, and same-ID recheck. No live classifier quota is needed.

### Task 05 — implement record reduction and coverage

**Proposed owner:** `src/utils/autoModeUsage.ts`. Use the existing identity-store abstraction and synthetic record input. Do not involve JSX or chart geometry.

Algorithm:

1. Validate in two layers before any totals: first the trusted envelope, diagnostic kind, bounded correlation identity, scope, and cutoff; then the event payload. Reject invalid payloads as events, but retain a minimal `invalid_terminal` marker when an End has trustworthy correlation identity and an unusable core terminal payload. If correlation identity cannot be trusted, increment source-level invalid diagnostics and mark affected coverage partial without creating an attempt. Never retain rejected raw payloads. Apply the existing reader's damaged-line handling when the envelope itself cannot be recovered.
2. Deduplicate exact records using canonical identity; join by existing source scope plus attempt ID. Preserve matching records regardless of traversal order.
3. A valid Start creates the population member and freezes tool kind and start bucket. Identical starts collapse. Conflicting start identity/time/tool-kind evidence makes that join unclassifiable: exclude it from classified attempt totals, increment invalid-start diagnostics, and mark the affected population partial. Do not choose whichever timestamp produces a better rate.
4. A valid End classifies it. Contradictory or unusable terminal evidence, including a correlated `invalid_terminal` marker, yields one Unknown outcome even if another terminal is valid. No terminal evidence yields Incomplete. End/stage/invalid-terminal marker without a valid Start is an orphan outside attempt totals. Markers are derived data-quality facts, not new writer events or permission decisions.
5. Validate disposition evidence separately from optional detail. An invalid/missing route alone uses Unknown route; an invalid/missing category alone uses Uncategorized for a trustworthy policy block. Neither alone creates an `invalid_terminal` marker or erases a known disposition. Reserve that marker for unusable core terminal evidence. Use validated stage/route facts for routing; irreconcilable route evidence does not justify invented edges.
6. Aggregate the member once into its start bucket, all-tools outcomes, command outcomes if applicable, route/disposition pair, and one policy-block category if applicable.
7. Finish coverage only after all relevant sources/records have been inspected. Apply source-level unknowns conservatively if they cannot be assigned to a particular bucket; do not turn them into timestamped fake attempts.

Keep terminal joins outside the selected date interval when needed to resolve starts inside it, while honoring the snapshot cutoff. Reuse existing retained-history identity limits and persistent stores rather than retaining every attempt in heap memory.

Aggregate exact policy-block category counts across the selected range using a namespaced `(category kind, category id)` key. Use the existing disk-backed mechanism when cardinality exceeds bounded memory. Select the top eight named categories only after range aggregation, breaking ties by stable key. Combine the remaining known categories into Other and keep missing/unusable categories in Uncategorized. Never calculate range rankings by merging already-truncated daily/source top-eight summaries.

Coverage decision table for the primary rate:

| Population evidence | Denominator | Unresolved outcomes | Display |
|---|---:|---:|---|
| Unavailable or partial | Any | Any | Gap; observed counts may appear separately as partial |
| Supported recorded population | 0 | 0 | Gap / no recorded commands |
| Supported recorded population | >0 | 0 | Confirmed numeric point |
| Supported recorded population | >0 | >0 | Provisional point, hollow marker, no solid bridge to confirmed segments |

“Supported” means the retained source intervals satisfy Task 00’s coverage rule; it does not promise lossless delivery. Incomplete and Unknown outcome are unresolved. Errors, cancellations, and Review required are known outcomes and do not by themselves make a point provisional.

**Pass:** the 100-attempt fixture below reconciles; duplicates/order permutations do not change totals; invalid starts and orphans do not create denominators; mixed coverage suppresses the primary rate; 1/10 plus 1/90 aggregates to 2%. Start plus malformed correlated End produces one Unknown and zero Incomplete; an End with untrusted identity invents no attempt. A category ranked ninth in each source but first after combining sources appears by name. Equal category IDs in different kinds remain distinct.

### Task 06 — persist projection and protect existing Usage accounting

**Owners:** `statsUsageIndex.ts`, `statsUsage.ts`, writer/readers identified in Task 00.

Add only the new schema’s fields and the minimal derived invalid-terminal/data-quality representation from Task 05 to the index projection allowlist. Preserve those markers so indexed and direct reduction agree; do not preserve malformed raw payloads. Bump the current derived index version because old indexed rows discarded permission metadata. Preserve existing source fingerprints, locking, transactions, corrupt-cache recovery, and last-good snapshot behavior. Do not mutate original transcripts or migrate account state.

In `statsUsage.ts`, dispatch recognizable new diagnostic subtypes before existing record/session/day/earliest-activity bookkeeping, regardless of payload validity. Valid records enter permission reduction; invalid records enter its data-quality handling. Neither falls through to ordinary activity accounting. Leave unrelated subtype semantics untouched. Do not let permission-only diagnostic records inflate summary records, sessions, active days, token amounts, request counts, or previous-period comparisons. Unparseable/truncated lines follow existing reader behavior without fabricated ordinary activity.

Ensure new records are excluded from model-facing transcript reconstruction, compaction, and ordinary transcript UI by following existing diagnostic filtering owners. Do not assume the writer alone guarantees this.

**Pass:** compare the existing Usage metrics for the same fixture with and without valid, malformed, duplicate, and truncated new diagnostics: identical existing metrics, new autoMode/data-quality values only, subject to existing damaged-line handling. Verify indexed/direct aggregation equivalence including malformed terminals, old-index rebuild, warm cache restore, source replacement/deletion, and no raw payload survives the projection.

### Task 07 — extend bounded summaries and strict parsing

**Owners:** `app/shared/usageDashboard.ts`, proposed `usageAutoMode.ts`, `app/shared/usageStatsWorker.ts`, `app/sidecar/usageSummary.ts`, current snapshot/counting-version owners.

Implement a summary equivalent to this conceptual shape. Derive total attempts by summing outcome counts, instead of storing redundant unchecked totals:

```ts
type OutcomeCounts = Record<SummaryOutcome, number>;
type Coverage = {
  state: 'complete' | 'partial' | 'unavailable';
  invalidRecords: number;
  orphanRecords: number;
};
type Population = { outcomes: OutcomeCounts; coverage: Coverage };
type AutoBucket = {
  date: string;
  allTools: Population;
  commands: Population;
};
type AutoSummary = {
  allTools: Population;
  commands: Population;
  buckets: AutoBucket[];
  routes: Array<{ route: Route; outcome: SummaryOutcome; count: number }>;
  categories: Array<{
    key: string; kind: 'named' | 'other' | 'uncategorized';
    label: string; count: number;
  }>;
};
```

Add bounded coverage reason flags if needed to explain unsupported population versus damaged reads; never rely on prose error text. Stage progress for incomplete attempts can be represented by the last verified route. Keep detailed stage-verdict counters only if needed for the chosen validated contract; they must not create duplicate outcome counts.

Validation: finite safe nonnegative integers; commands are a subset of all-tools for every outcome; route counts sum to range outcomes; category counts sum to policy blocks; bucket outcomes sum to range outcomes; route/outcome combinations are permitted; dates are valid and aligned to the existing range buckets. Known allow-only paths cannot carry a recorded policy-block terminal. Partially observed contradictory paths use unknown routing.

Budgets: preserve existing day/All bucket limits; at most 8 named categories plus Other and Uncategorized, selected from exact range-wide counts as specified in Task 05; route cardinality bounded by closed enum pairs. Omit zero route rows. Fit under the existing 256 KiB envelope using existing optional-detail reduction first. If extra reduction is necessary, explicitly coarsen temporal buckets with exact summed counts and worst coverage, or return the existing typed resource failure; never silently truncate time buckets or denominators. Prefer reusing shared Usage bucket structures over duplicating large date arrays when compatible.

Bump counting/summary versions to current successors and update strict fixtures. Old snapshots rebuild; absent autoMode never means measured zero. Use the existing host publication path without adding an inbound operation.

**Pass:** parser rejects bad counts, dates, enum values, impossible sums, and oversized payloads; cache invalidation works; envelope fitting preserves exact totals and coverage; existing named model/tool categories are not prematurely collapsed.

### Task 08 — implement frontend selectors first

**Proposed owner:** `app/renderer/src/usageAutoModeState.ts`; fixture tests alongside it. Use only validated AutoSummary input.

Write small pure helpers for total attempts, command rate point, contiguous confirmed line segments, outcome series, sorted categories, and fixed route-to-edge conversion. A point contains date, numerator, denominator, rate or null, and confirmed/provisional/unavailable status. A headline uses summed numerator/denominator only when range coverage permits it.

Create one shared synthetic fixture module expanding the reference 100-attempt example into exact IDs, UTC timestamps, routes, tool kinds, dispositions, and categories, with golden aggregate output. Choose the unspecified edit/allowlist split and command/category assignments once while preserving every specified total, including 40 commands and four command policy blocks. Reuse it across reducer, selectors, and all four chart tests rather than creating inconsistent versions of the example.

Do not borrow `errors / matched results` from the existing error chart. Reuse formatting/date helpers, not its metric definition. Format percentages from full-precision counts, rounding only at the label. Maintain real calendar positions across sparse All buckets.

**Pass:** selectors reproduce the fixture values without React; null/provisional points break solid line segments; legend ordering is stable across dates; category grouping is range-wide; all-zero confirmed buckets yield zero count bars but no numeric rate.

### Task 09 — build the command block-rate line

**Proposed owner:** `UsageAutoModeBlockRate.tsx`, styles in `usageAutoMode.css`. Read `UsageToolErrorTrend.tsx` for chart-width, SVG, axis, and accessible table patterns.

Render coral straight segments, small confirmed dots, hollow provisional dots, UTC x-axis, and percentage y-axis starting at zero. Cap the computed ceiling at 100%; use the existing axis helper. When no numeric points exist, render the meaningful empty/unavailable state without fabricated axes/data. Tooltip/readout contains date, policy-denied commands, all recorded commands, percentage, known errors/reviews, and unresolved count when relevant.

Use an accessible exact-values table and keyboard selection for equivalent information. Preserve the fixed initial-decision formula in concise chart description text. Do not add trend arrows or call a decrease an improvement.

**Pass:** DOM/render tests show 4/40 as 10%, 0/0 as unavailable, missing dates as gaps, provisional points without confirmed bridges, and keyboard-readable values. No clipping at a narrow width.

### Task 10 — build the two bar charts

**Proposed owner:** `UsageAutoModeBars.tsx` or two small chart modules, using Task 08 helpers.

Decisions: one calendar bucket per stacked bar, fixed outcome ordering, all-tools population, count axis. Extra Cancelled/Incomplete/Unknown series appear only if nonzero in the selected range. Show partial observed counts as partial; never imply complete activity for missing intervals.

Block reasons: render the backend's exact range-wide category ranking from Tasks 05/07 in descending count order with deterministic key tie-breaks; include Other and Uncategorized when nonzero. Do not reconstruct ranking from per-bucket top lists. Percentage denominator is all policy-blocked tool attempts. No category bar for operational error or review handoff. Use exact table values instead of adding a new raw-log browser.

**Pass:** totals and legends match the 100-attempt fixture; category totals equal seven policy blocks; changing range changes ranking consistently; no-policy-block state is readable; labels remain legible in both themes.

### Task 11 — build the Sankey from a fixed graph

**Proposed owners:** pure layout helper in `usageAutoModeState.ts` or `usageAutoModeFlowState.ts`, component `UsageAutoModeFlow.tsx`.

Use these route templates, removing zero-count edges and summing shared edges:

| Route | Path before its outcome sink |
|---|---|
| base | Attempts → Base checks |
| forced | Attempts → Supplied decision |
| guard | Attempts → Base checks → Review/safety guard |
| accept_edits | Attempts → Base checks → Workspace edits |
| allowlist | Attempts → Base checks → Allowlist |
| stage1 | Attempts → Base checks → Stage 1 |
| stage2 | Attempts → Base checks → Stage 1 → Stage 2 |
| unknown | Attempts → Unknown route |

Do not invent Base checks on a forced path or fast-path success on a classifier path. Route ending at an interrupted stage goes to Incomplete/Cancelled as supported by records. Stage 1 may emit policy-blocked only if source establishes an actual initial policy decision there; its normal positive harm verdict escalates, rather than becoming a policy-block sink.

Use fixed columns: Attempts; Base/Supplied/Unknown; Workspace edits/Allowlist/Guard; Stage 1; Stage 2; Outcomes. Edges may skip columns. With a fixed small graph, native SVG is sufficient. Calculate each node value from its edges (inflow equals outflow for internal nodes; do not sum both). Remove zero-value nodes. For each nonempty column `c`, compute `availableHeight[c] = plotHeight - gap * (nodeCount[c] - 1)` and `sumNodeValues[c]`. Choose the single pixels-per-attempt scale `min(availableHeight[c] / sumNodeValues[c])` over those columns. Ensure available heights are positive by increasing plot height if necessary; an empty graph uses the empty state without dividing by zero. Center each column's scaled nodes plus gaps independently, then assign incoming/outgoing ribbon offsets cumulatively in stable neighbor order. Draw cubic ribbons using equal source/target thickness. Do not enforce a visual minimum on true ribbons; add transparent hit areas instead. All nodes and edges must preserve the same scale. If six columns and their labels do not fit a narrow panel, keep a legible minimum SVG width in a horizontally scrollable container, with the accessible route table immediately available; never overlap or squeeze labels to fit.

**Pass:** layout tests show nonnegative sizes, in-bounds coordinates, node conservation, stable order, and correct forced/unknown routes. Test single-route, tiny minority flow, all seven outcomes, and narrow window layouts. In particular, one source node and seven outcome nodes carrying the same total must both fit the plot at the same scale. Provide an accessible route/count table; a decorative SVG alone is insufficient.

### Task 12 — integrate into UsagePage

**Owners:** `UsagePage.tsx`, proposed `UsageAutoMode.tsx`, `usageAutoMode.css`, existing Usage state only where the new contract requires it.

Add the section after the existing model/tools row and before the hourly heatmap, unless current page layout has materially changed. Reuse the current range value and summary; no second range selector or polling effect. Section order: full-width Sankey, full-width line, two lower bar panels. Use existing theme tokens and local fonts; charts stack on narrow windows. Keep all existing panels and existing navigation behavior.

Handle loading, unsupported historical data, zero recorded attempts, partial metadata, and stale last-good data locally to this section. Do not clear the entire Usage page when only auto-mode data is unavailable. All-history bucket labels must disclose coarsening using the existing pattern.

**Pass:** page tests cover 7d/30d/All switching and all section states; old Usage panels remain; new auto-mode latency is absent; existing Execution timing remains; current refresh still works without any open chat session.

### Task 13 — verify one real pipeline, then finish

Build one isolated integration fixture that invokes the production observation writer through a permission caller with stubbed classifier responses, writes actual diagnostic records to a temporary owned transcript, runs the production index and summary finalizer, parses the result, and renders the Usage section. No dangerous tool execution, real credentials, or live model requests are needed.

Assert both sides: the permission result/call counts are unchanged, and the graphs receive the expected route/outcome/rate. Re-run after duplicate record replay and after a cached restart; values must not double. Append new permission diagnostics and verify old Usage activity metrics remain unchanged.

Run the applicable repository gates in Phase 6 once the affected slice is integrated. For visual checks, use supported isolated render fixtures and the authorized Cat Code Dev process. Report unavailable live GUI verification honestly. Update the Usage decision document and relevant map with metric definition, coverage limits, data version, and exclusion of raw content. Follow repository commit rules; do not publish or push without authorization.

**Pass:** four charts show validated metadata, production contract tests pass, existing permission behavior is preserved, and material verification gaps are listed. Finish with changed files, actual tests/results, recording start/coverage limits, and any required operator follow-up. Do not describe planned checks as completed.

## Reference specification

The following sections provide rationale and edge-case requirements for the cards. They do not require a second implementation pass. If a current-source fact differs, use the Task 00 evidence process. If two instructions appear inconsistent, preserve the fixed product decisions and resolve the narrow contract explicitly before coding the affected slice.

## Objective and scope

Add an Auto mode section to Cat Code’s existing desktop Usage page with four graphs:

1. Decision flow: Sankey diagram.
2. Command block rate over time: line chart.
3. Decisions over time: stacked bars.
4. Block reasons: horizontal bars.

Use the attached dashboard image as an appearance reference. Its numbers and Sankey connections are illustrative, not implementation requirements. Match the clean layout, restrained colors, and whitespace while using Cat Code’s existing typography and theme tokens.

Do not add the proposed auto-mode permission-latency chart. Preserve the existing Usage page’s Execution timing panel and other features. This project observes permission behavior; it must not change permission policy, classifier prompts, consent requirements, fast paths, or provider routing. Accuracy scoring, confusion matrices, cost charts, a new labeling workflow, and a full transcript inspector are outside this implementation.

This document is a plan, not an implemented change. Repository inspection was read-only through My Mac Files at `/Users/pt/cat-code`. No live application, classifier request, or production log collection was run.

## Evidence and corrections

The following are source observations, not live measurements. Recheck current files before implementation because this repository is shared and actively changing.

| Area | Verified source under `/Users/pt/cat-code` | Implementation implication |
|---|---|---|
| Usage surface | `app/renderer/src/UsagePage.tsx` | Integrate here. It already supports 7 days, 30 days, All, UTC dates, retained snapshots, and an Execution timing panel. |
| Summary contract and validation | `app/shared/usageDashboard.ts`, `app/shared/usageStatsWorker.ts` | Extend the existing bounded, validated Usage result instead of introducing a second dashboard transport. |
| Collection and index | `src/utils/statsUsage.ts`, `src/utils/statsUsageIndex.ts` | The current collector reads retained transcripts; a rebuildable SQLite index projects allowlisted accounting fields. |
| Snapshot grouping | `app/sidecar/usageSummary.ts` | Preserve exact totals while bounding optional detail and the 256 KiB result envelope. |
| Main-owned publication | `app/main/usageStatsRunner.ts` | Existing refresh interval is five minutes; last-good snapshots survive refresh errors. Reuse this lifecycle. |
| Permission routing | `src/utils/permissions/permissions.ts` | Base decisions can return before the auto-mode classifier branch. Eligible acceptEdits checks and the tool allowlist can bypass classification. |
| Classifier | `src/utils/permissions/yoloClassifier.ts` | Stage 1 can allow or escalate; failures and Stage 2 outcomes require distinct accounting. |
| Analytics API | `src/services/analytics/index.ts` | `logEvent`, `logEventAsync`, and sink attachment are no-ops. Existing `tengu_auto_mode_*` calls are NOT proof of retained events. Do not reactivate global product telemetry for this feature. |
| Classifier outcome memory | `src/utils/permissions/autoModeMeta.ts` | The bounded in-memory ledger feeds classifier context. It is not a durable Usage data source. |
| Existing diagnostic writer pattern | `src/utils/sessionStorage.ts` | Contains metadata-only execution diagnostic writers. Investigate this owner for permission records. |
| Permission callers and rechecks | `src/hooks/useCanUseTool.tsx`, `src/hooks/toolPermission/handlers/interactiveHandler.ts` | The caller can bypass the core checker with `forceDecision`; an interactive recheck can call it again with the same tool-use ID. Instrumenting each checker invocation would produce incorrect counts. |
| Existing line chart | `app/renderer/src/UsageToolErrorTrend.tsx` and its state/CSS files | Reuse responsive SVG, UTC axis, gap, and accessible-value patterns. Its errors/matched-results formula is different from command block rate. |
| Architecture rules | `CLAUDE.md`, `docs/migration/decisions/USAGE-DASHBOARD.md` | Preserve bounded local collection, metadata-only projection, existing host ownership, secret screening, and rebuildable-cache semantics. |

The inspected index currently allowlists model-attempt and tool-execution diagnostics, not a complete permission-attempt history. Historical auto-mode coverage has not been established. First verify any additional retained sources before deciding what can be backfilled.

## Phase 1: resolve integration details from current source

Read the current repository instructions and relevant Usage/permission decision records. Inspect the working tree before editing; preserve unrelated changes.

Trace these boundaries before writing production code:

- The outer permission entry point, `forceDecision` paths, internal rechecks, and every early return, thrown interruption, review handoff, and classifier failure path. Inspect desktop, terminal, headless, and subagent callers separately where their wiring differs.
- How effective auto mode is detected, including plan mode with auto active, async agents, and any alternate engine path. Do not infer it from a session’s current UI mode.
- Where metadata-only diagnostic records are written, how main/subagent identity is stamped, and whether they stay out of model prompts, compaction input, visible transcript messages, token accounting, and ordinary transcript-record counts.
- Which existing logs, if any, persist permission results with usable attempt IDs, mode, timestamps, routes, and categories. Inspect only the relevant bounded schemas/samples. Do not treat opted-in raw classifier dumps as a production source.
- The worker finalizer, strict parser, host event, cached restore, and renderer state path that carry Usage snapshots.
- Existing SVG utilities and any already-installed chart/layout dependency. Prefer existing primitives; the app package inspected here has no dedicated chart library.

Deliver a short field-coverage note with each required field marked retained, derivable with evidence, or missing. If history is insufficient, record new events prospectively and display historical unavailability. Do not invent or heuristically reconstruct past verdicts from command text, rejection prose, or tool execution errors.

### Decisions deliberately left to the implementing agent

Choose the exact writer API and subtype names after tracing the real diagnostic path. Choose the necessary version bumps after rereading current schemas; this plan does not reserve version numbers. Resolve safe branch/subagent attribution using existing Usage identity rules. Decide whether an existing bounded navigation path supports graph drill-down; do not create a general raw-log endpoint to satisfy it.

These are bounded implementation decisions, not blockers requiring routine user clarification. Follow any actual repository authorization requirements for dependencies, live probes, GUI launches, or locked-boundary changes. Do not broaden architecture or permissions merely to complete a chart.

## Phase 2: define the measurement contract

### Unit and population

The unit is one logical tool-action permission attempt that enters the authoritative permission pipeline while auto mode is effectively active. Include base-rule allow/deny and fast-path outcomes, even when no classifier runs. Do not count every emitted tool call if it never reaches this pipeline.

For these graphs, measure the first automatic decision for that logical attempt, ending when it allows, denies, fails, is interrupted, or returns `ask` into further permission handling. Name that last disposition **Review required**. It does not assert that a human dialog opened: downstream coordinators, hooks, configuration rechecks, or headless handling may resolve it differently. This is deliberately not a full execution-authorization audit.

A classifier provider retry is part of the same permission attempt. A new agent-issued tool call after a denial is a new attempt. Repeated internal checks or replayed records for the same logical attempt do not create new counts. Use an engine-generated stable attempt ID, associated with the tool-use ID and existing project/session/subagent scope; do not use command text as identity. Decide where that identity is created only after inspecting re-entry behavior.

Assign or retrieve that ID at the outer logical-attempt owner, before selecting a core-check or forced-decision route. Carry it through nested checks; do not create a new ID inside every `hasPermissionsToUseTool` invocation. The first terminal decision is immutable. Subsequent rechecks for the same logical attempt may have explicitly tagged supplementary records but cannot contribute a second start/terminal or rewrite the charts. An initial forced decision is included if it belongs to this population, with its recorded source; use Unknown outcome rather than guessing the reason for a forced denial. A synthetic invocation without a reliable logical identity needs a documented scoped identity strategy, not a command hash.

Freeze the population at attempt start. A later mode change does not relabel its origin. Clearly limit coverage to instrumented execution paths; unsupported engines are unavailable, not zero-activity auto mode.

### Separate verdict, disposition, and execution

Retain the actual Stage 1/Stage 2 verdicts independently from what the permission pipeline finally does. Use these mutually exclusive dispositions at the auto-mode boundary:

| Disposition | Meaning |
|---|---|
| Allowed | The pipeline grants permission automatically. |
| Policy-blocked | The pipeline denies because of a policy, permission rule, or enforced safety boundary. |
| Review required | The initial automatic check returns `ask` or explicitly hands off to further permission handling. It does not prove human interaction. |
| Operational error | The initial check cannot decide and ends without a review handoff because of unavailability, parse failure, or another recorded operational failure. A fail-closed denial is still operational here. |
| Cancelled | A recorded interruption ends the check. |
| Incomplete | A valid retained start has no terminal evidence by the snapshot cutoff. This is derived, not a fabricated verdict. |
| Unknown outcome | A valid retained start has conflicting/invalid terminal evidence, or insufficient cause information to distinguish a policy denial from an operational failure. Preserve any known raw deny result, but do not invent its cause. This is a data-quality state, not a policy decision. |

Store bounded cause codes separately. For example, an unavailable classifier followed by an `ask` handoff is one Review required attempt with an unavailable cause, not two outcomes. A Stage 2 block converted into review by denial-limit handling is Review required for these charts; retain its classifier block verdict for diagnosis. A user’s later approval/decline or automatic recheck does not rewrite the earlier handoff into an automatic allow/policy block.

Classify failures by recorded cause, not exception class alone. In the inspected code, a classifier context overflow in headless mode throws `AbortError`; it is an operational error, not a user cancellation. Preserve these distinctions without changing the behavior of the thrown error.

This establishes that the block-rate numerator measures policy-blocked pipeline dispositions, not every internal `shouldBlock: true`. Never use a subsequent `tool_result.is_error` or shell exit status as a permission verdict.

### Time, coverage, and categories

Attribute every attempt to its start timestamp in UTC. Only apply terminal/stage records observed at or before the captured snapshot cutoff; a cross-midnight terminal updates its original attempt bucket. Use the existing 7d, 30d, and All bounds. Begin with daily buckets for 7d/30d and the existing bounded calendar buckets for All; hourly drill-down is optional future work, not a prerequisite.

Auto-mode coverage must be independent from general transcript coverage. Distinguish unsupported history, incomplete reads, missing terminals, invalid records, and unknown route/category. Do not claim history is complete simply because files were read successfully. The first retained event is not proof that every session after that time was instrumented; use source/schema/build capabilities and explicit instrumentation markers where needed.

Require coverage metadata for each time bucket and separately for its all-tools and shell-command populations. At minimum retain complete/partial/unavailable collection status, supported-population status, unresolved-outcome counts, and bounded invalid/orphan diagnostics. Derive range coverage from the included buckets and sources. A mixture of instrumented and uninstrumented sessions cannot silently become a complete denominator. Do not display the main rate line for buckets whose full eligible command population cannot be established; retain supportable observed counts with a partial-history label. Missing categories or route detail alone should not suppress a rate if disposition and population are still established. A valid complete denominator with incomplete/unknown outcomes may show a distinctly provisional observed rate, with unresolved count and an accessible explanation. Do not connect confirmed segments through these provisional points as if all points were equally settled.

Use “recorded attempts in retained history” in the metric definition. Instrumentation capability and successful reading do not prove lossless durable delivery; do not promise an audit-grade count of every action ever attempted.

Use recorded structured category IDs, including custom category kind where supported. For a base policy denial with no classifier category, use a bounded recorded rule kind when available, otherwise Uncategorized. Never use free-text reasons as unbounded series labels. Keep Unknown/Uncategorized distinct from Other: the former is missing information; the latter groups known low-frequency categories.

## Phase 3: add durable metadata-only instrumentation

Prefer extending the established transcript diagnostic writer and retained-history projection. Final names below are illustrative:

- `auto_permission_start`: schema version, stable attempt ID, tool-use ID, normalized tool kind, effective auto-mode provenance, and start timestamp/identity supplied by the writer.
- `auto_permission_stage`: attempt ID, stage (`fast` or `thinking`), phase (`entered` or `resolved`), and on resolution a valid verdict or bounded terminal failure code. A resolved record represents the stage result after internal retries. Optional retry counts/cause summaries are bounded metadata, not additional verdicts or actions.
- `auto_permission_end`: attempt ID, disposition, bounded route, Stage 1/2 results if needed for a complete projection, primary category/kind, and cause code.

The route must distinguish base decision, acceptEdits, safe-tool allowlist, Stage 1 only, Stage 1 then Stage 2, explicit manual/safety guard, and unknown. Preserve the actual order: acceptEdits is tried before the allowlist in the inspected permission function. Do not assume Bash is excluded from all fast paths.

Record starts outside classifier-only branches so the denominator includes early returns. Ensure exactly one terminal per completed logical attempt, including early allows/denies, thrown interruptions, parser failures, unavailable paths, and manual fallback. Preserve stage progress for attempts interrupted between stages. Logging failure must not change permission decisions or execute tools; follow the existing nonblocking/bounded writer behavior and make known recording failures visible to coverage where possible.

Emit a stage-entered record before dispatch so an interrupted in-flight check can still be located in the Sankey. A failed provider attempt followed by a successful stage result is not conflicting terminal evidence. Do not infer a missing stage-entered event from elapsed time or a model-call record; validated terminal route metadata can supply that route if the contract explicitly permits it.

The existing `appendSystemDiagnostic` checks the active transcript lease **outside** its best-effort catch and silently writes nothing if no transcript owner exists. Reuse this owner deliberately: preserve the lease assertion and existing ownership guarantees; do not wrap it in a blanket catch or create an orphan transcript. Test the null-owner path and report unavailable coverage where appropriate. Ordinary I/O recording failure must not change a permission result; a genuine lease violation remains governed by the existing architecture invariant. Do not add a persistent “complete” claim that the best-effort writer cannot support.

Persist no new raw command text, file contents, transcript, model reasoning, or classifier request/response bodies. The four graphs need metadata only. Avoid turning diagnostic records into model messages or counting them as additional user activity. If using system diagnostic records, explicitly test their exclusion from model-facing flows and existing Usage record metrics.

Reuse existing build/schema provenance where useful. Keep the global analytics no-op boundary unchanged. Do not require classifier dump environment flags, account initialization, or network calls for collection.

## Phase 4: extend the existing Usage collector and transport

Implement a pure permission reducer, preferably in a small helper such as `src/utils/autoModeUsage.ts`, called by `statsUsage.ts`. Keep writer/types and renderer derivation separate from JSX components.

Extend `statsUsageIndex.ts` to project only the new allowlisted fields and minimal derived data-quality markers from Tasks 05/06. Preserve trustworthy correlation identity for unusable core terminal evidence, without copying rejected payloads, so direct and indexed reduction agree on Unknown versus Incomplete. If old indexed records omitted these fields, bump the derived index/projection version and rebuild from retained transcripts. A summary-only version bump cannot recover fields already discarded by the old index. Preserve source transcripts and use existing lock, transaction, corruption-recovery, and last-good snapshot behavior.

Follow established project/session/subagent identity and copied-record deduplication semantics. Do not add child-session attempts twice through both child and parent views. Detect contradictory duplicate terminals and invalid stage sequences; expose invalid/unknown coverage rather than silently choosing whichever record yields a favorable rate. Apply the repository’s canonical-order conflict rules where applicable and document them.

Make record reduction order-independent for correlated start/stage/end records. Exact logical duplicates count once. Reserve Incomplete for a valid start with no terminal evidence. Conflicting or invalid core terminal evidence for a valid start produces Unknown outcome; it is excluded from the policy-block numerator. Stage/terminal records with no valid retained start are orphans: exclude them from attempt totals and expose their count in coverage. Do not manufacture a start or its timestamp from the end. A terminal whose disposition is trustworthy but whose route is absent contributes that disposition through Unknown route. Keep legacy canonical identity rules for source/copy conflicts; do not turn a policy disagreement between non-identical terminals into “first verdict wins.”

The inspected `statsUsage.ts` increments existing record/session/day bookkeeping before processing system diagnostics. Handle recognizable new permission diagnostic subtypes before that activity bookkeeping regardless of payload validity, while retaining identity/cutoff validation and their permission aggregation or data-quality handling. Ensure they do not move earliest-activity dates, create artificial active days/sessions, or increase existing record counts. Preserve accounting of existing diagnostic subtypes; this change is not a rewrite of historical Usage semantics.

Bound the new correlation ledger as well as the outbound summary. Prefer the existing SQLite-backed identity abstraction for history-sized joins; avoid an unbounded JavaScript Map of all permission attempts. Respect current memory, disk, identity, and deadline budgets. On limit exhaustion retain the last good snapshot or return the existing typed failure; never evict identities to make a denominator fit.

Add a bounded `autoMode` summary to each Usage range (exact type names at implementer discretion):

- Coverage state and capability/record diagnostics.
- Population totals and counts for each disposition.
- A small fixed route graph or route-path counts with stage outcomes.
- UTC bucket counts and per-population coverage metadata for all auto-mode attempts and for the command-only subset, including incomplete and unknown outcomes.
- Range-wide primary policy-block category counts, with Other and Uncategorized accounting.

Store integer numerators/denominators, not rounded percentages. Derive percentages at presentation time. Reconcile: sum of dispositions, including Incomplete and Unknown outcome, equals valid canonical retained starts; orphans are outside that equation; policy-blocked commands are at most command attempts; category counts including Other/Uncategorized equal policy blocks. Each Sankey node must conserve count except its source and sinks. Counters for resolved-stage verdicts and final dispositions are distinct and need not match one another.

Extend `app/shared/usageDashboard.ts`, `app/shared/usageStatsWorker.ts`, and `app/sidecar/usageSummary.ts` together. Reject invalid enums, negative/non-integer/unsafe counts, impossible sequences, oversized labels, and inconsistent totals. Keep the existing 256 KiB envelope and bounded All-history behavior. Allocate fixed route/bucket/category budgets and group detail explicitly; never silently trim denominators. Bump the current counting/cache versions as required. Retained old snapshots must rebuild or show unavailable auto-mode data, never masquerade as measured zero.

Continue using `app/main/usageStatsRunner.ts` and its existing host-owned publication lifecycle. Do not introduce renderer filesystem access, a second polling worker, a generic IPC channel, or a mandatory active chat session. Follow actual protocol-version and generated-type requirements if the changed contract reaches them.

## Phase 5: implement the four graphs

Add a clearly identified Auto mode section to `UsagePage.tsx`. Suggested component split: `UsageAutoMode.tsx`, chart components as needed, `usageAutoModeState.ts` for pure derivation/layout, and `usageAutoMode.css` for styles. These are proposed new files, not verified existing owners.

Use the page’s controlled date-range selection, snapshot cutoff/freshness, responsive chart-width helper, and theme tokens. Keep the same UTC bucket boundaries across the new temporal charts. Do not change the existing page’s selection/navigation contract as an incidental refactor.

### 1. Decision flow

Place a full-width Sankey first. Fixed small topology: Attempts → Base checks → eligible fast-path routes or classifier → Stage 1 → Stage 2 where actually reached → disposition sinks. Direct base allows, base denies, and manual guards must bypass classifier nodes. Show acceptEdits and allowlist separately when useful; failure of a fast-path eligibility check is not a separate population of attempts.

Ribbon thickness encodes counts; use a consistent scale. Stable ordering and generous spacing matter more than animation. Preserve true sizes for rare flows; use transparent hit targets or text values for interaction instead of inflating ribbon thickness. Hover/focus gives count and explicitly labeled percentage denominator, preferably all attempts in the selected period. Do not add node counts together as if stages were disjoint attempts.

Only draw routes established by records. If outcomes are known but routes are missing, show an Unknown route branch or mark the Sankey unavailable while retaining the independently supportable charts. Include Cancelled/Incomplete/Unknown outcome only when nonzero. Never invent links to match the attached image.

### 2. Command block rate

Place a full-width coral line directly below the Sankey. The population is shell-command tool attempts under effective auto mode. Start from verified tool identities (for example Bash and any supported PowerShell path), not a text search for commands inside arbitrary tools. Do not recursively count shell calls hidden inside a single recorded tool action unless the pipeline emits separate attempts for them.

For bucket b: `rate[b] = 100 × policyBlockedCommandAttempts[b] / allCommandAttempts[b]`.

Operational failures, review handoffs, cancellations, incomplete starts, and unknown outcomes remain in the valid-start denominator but not the policy-block numerator. Their counts and coverage must be available in the tooltip/readout so a falling rate caused by outages is not mistaken for improvement. If the denominator cannot be established, use an unavailable point. Apply the per-bucket coverage rules above, including provisional styling for unresolved outcomes. Tooltip definition: “Initial automatic policy denials / recorded command permission attempts.” A later human decline is not an initial automatic policy denial.

No attempts means null, not 0%. Break the line across null/unavailable intervals. Do not interpolate missing history. Use straight segments and small points; no smoothing that changes or overshoots measured rates. Start the percentage axis at zero and use a clear bounded ceiling based on data, never above 100%. Hover and keyboard focus show period, numerator, denominator, percentage, and material coverage limits. Range headlines and merged All buckets use summed counts, never an average of percentages.

Apply the same coverage rule to range headlines and merged buckets. If any included source makes the intended population unknown, do not present the sum over only instrumented records as a complete-period rate. Show unavailable, or an explicitly scoped recorded-subset readout outside the primary rate series. Regrouping must retain partial/provisional coverage rather than erase it.

### 3. Decisions over time

Below the line, left panel: stacked bars for all auto-mode tool permission attempts, not just commands. Use one exclusive disposition per attempt. Default legend: Allowed, Policy-blocked, Review required, Operational error. Add Cancelled, Incomplete, and Unknown outcome when present rather than hiding or relabeling them. These extra data states are not counted as operational failures.

Bar height is attempt count. Hover/focus shows exact counts and within-bucket shares. Label scope so users do not expect its total to equal the command-only chart’s denominator. Missing instrumentation is a gap/unavailable interval, not an empty bar claiming inactivity.

### 4. Block reasons

Below the line, right panel: horizontal bars sorted by policy-block count across all auto-mode tools in the selected period. One primary category per policy-blocked disposition; secondary matches may be retained in diagnostics but do not multiply bar totals. Select the top categories range-wide, with Other and Uncategorized explicitly included. Exclude operational failures and Review required dispositions, even if their earlier classifier verdict was block. Keep this initial-decision scope explicit in the chart description.

Hover/focus shows count and percentage of all policy-blocked attempts. If an existing bounded session-detail/navigation surface supports a category filter, reuse it. Otherwise provide accessible exact values without a misleading clickable affordance; building a raw decision inspector is not required for these four charts.

### Visual and accessibility requirements

- Full-width Sankey, full-width line, two equal lower panels; stack lower panels on narrow windows.
- Generous whitespace, subtle borders/grid lines, compact legends, readable local fonts, and minimal chrome.
- Consistent semantic colors: approved teal/emerald for allowed, coral for blocked, amber for review, neutral gray for operational failures; distinguish any extra states with labels/patterns. Reuse current light/dark palette conventions rather than replacing global theme colors.
- Keyboard-accessible readouts and exact-value tables, visible focus, adequate contrast, reduced-motion behavior, and labels that do not rely on color alone.
- Reuse existing SVG patterns and CSS classes. No new dependency unless needed and authorized under repository instructions.
- No accuracy score, invented historical data, automatic “improved” claims, or green/red trend arrows implying that lower block rate is inherently better.
- Loading, no recorded attempts, historical unavailability, partial coverage, and stale retained data must remain distinguishable without replacing the entire Usage page with an error.

## Phase 6: verify at the boundaries that can fail

Use synthetic fixtures and isolated state. Do not run destructive sample commands or spend classifier quota to validate chart accounting.

### Permission instrumentation tests

Exercise the real permission entry point with controlled classifier responses. Cover base allow/deny, acceptEdits, allowlist, Stage 1 allow, escalation with Stage 2 allow/block, unavailable/parse failure, denial-limit manual handoff, non-classifier safety guards, interruption, async/subagent attribution, and mode changes. Assert unchanged permission behavior and one logical attempt with the correct route/disposition. Verify provider retries do not increment command-attempt counts.

Include a caller-level fixture for initial forced decisions and interactive rechecks using the same tool-use ID: one start, one immutable initial disposition, no extra denominator. Test provider failure followed by success within one stage, interruption after stage entry but before resolution, and headless context overflow throwing `AbortError` without being mislabeled as cancellation. Cover null transcript ownership and preserve lease-violation behavior.

### Reducer and chart fixture

Use this deterministic 100-attempt fixture to check all panels:

- Base checks: 50 allowed, 5 policy-blocked, 3 review required, 2 operational errors, 40 continue.
- Of those 40: 20 fast-path allows, 20 enter Stage 1.
- Stage 1: 12 allowed, 1 operational error, 7 escalate.
- Stage 2: 3 allowed, 2 policy-blocked, 1 review required, 1 operational error.
- Expected totals: 85 allowed, 7 policy-blocked, 4 review required, 4 operational errors. All Sankey links conserve these totals.
- Mark a subset of 40 as shell-command attempts, including 4 policy blocks: expected command block rate is 10%, not the all-tools 7%.

Add separate fixtures for zero attempts; no blocks with a nonzero denominator; all blocked; operational fail-closed behavior; duplicate/reordered records; start-only attempts; conflicting terminals; midnight/cutoff boundaries; sparse All buckets; old uninstrumented sessions; missing categories; and recorded custom categories. Check unequal denominators: 1/10 and 9/90 aggregate to 10/100, and use a second unequal-rate example to catch arithmetic averaging (1/10 plus 1/90 gives 2%, not 5.56%).

Explicit expectations: a valid start with contradictory terminals yields one Unknown outcome; an orphan terminal yields zero attempts plus an orphan coverage diagnostic; the same records in different file order yield the same aggregation. A bucket mixing unsupported and supported sessions must not publish an unqualified command rate. A fully supported bucket with known starts but unresolved terminals is provisional. High-volume joins must stay within the existing resource budgets and preserve identity counts across the indexed path.

### Persistence and contract tests

Verify durable writer → retained record → index projection → aggregation → strict worker parser → renderer, not just an in-memory chart fixture. Check metadata-only projection, no raw command leakage, exclusion from model/compaction inputs, unchanged token/tool/record totals, cached restart, old-index rebuild, source replacement/deletion, incomplete tails, last-good snapshot retention, bounded payload fallback, and subagent/copied-history identity semantics.

### UI checks and repository gates

Extend Usage page DOM/render tests for range switching, stable layout, null line gaps, percent/count tooltips, keyboard access, small windows, light/dark modes, empty/partial/stale states, and preserved existing Execution timing content. Verify the added auto-mode latency chart is absent.

Run the current applicable engine/desktop checks from repository instructions. Expected candidates: focused permission and Usage tests; `bun run build:dev:full`; `bun test app/`; `bun run --cwd app typecheck`; `bun run --cwd app typecheck:sidecar`; and `bun run --cwd app renderer:build`. Use `git diff --check` and documentation gates for changed docs. Do not run bare repository-wide `bun test` indiscriminately. Resolve failures against the current diff and report material pre-existing gaps accurately.

For visual verification use the documented Cat Code Dev workflow and permissions. If live GUI access is unavailable, verify supported render/DOM fixtures and leave precise operator steps to compare against the attached mockup; do not claim a native visual pass.

## Implementation checkpoints and completion criteria

Complete in this order, keeping every checkpoint reviewable:

1. Field-coverage note and explicit outcome/denominator contract.
2. Durable metadata instrumentation with unchanged permission results.
3. Indexed aggregation, coverage handling, strict contract, and cache versioning.
4. Four themed responsive graphs in the existing Usage page.
5. End-to-end fixture verification, focused regression checks, and updated decision/map documentation.

The feature is complete when real retained metadata can populate all four charts; counts reconcile across routes and outcomes; command-only rate denominators are explicit; unknown history stays unknown; retries and duplicates behave correctly; no raw transcript data is added to Usage transport; existing page features remain intact; and material verification limits are documented.

If access is missing, the implementing agent should investigate the named owner and choose the smallest compatible solution using current repository evidence. Record that decision and its test in the implementation report. Do not fill evidence gaps with invented routes, assumed durable telemetry, or fake production values.
