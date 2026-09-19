# Auto-mode Usage implementation

## Progress

| Task | Status | Changed files | Verification | Next |
| --- | --- | --- | --- | --- |
| 00 | Complete | This report | Source inspection complete | Define closed event and aggregate contracts |
| 01 | Complete | `autoModeObservation.ts`, `usageAutoMode.ts`, their tests | 4 focused tests passed; desktop typecheck and engine dev build passed | Implement pure disposition mapper |
| 02 | Complete | `autoModeObservation.ts` and its test | 5 focused tests passed; engine dev build passed | Run Tasks 03 and 05 in parallel |
| 03 | Complete | Observer lifecycle, owned diagnostic writer, and focused tests | 61 focused tests passed; engine dev build passed | Wire production routes |
| 04 | Complete | Permission caller matrix, occurrence context, core/classifier wiring, and focused tests | 65 focused tests passed with `TRANSCRIPT_CLASSIFIER`; engine dev build and diff check passed | Project diagnostics into the Usage index |
| 05 | Complete | Pure reducer and deterministic fixtures | 11 focused tests passed; engine dev build passed | Wire production routes and indexed projection |
| 06 | Complete | Retained diagnostic adapter, index projection, accounting/recovery exclusions, and focused tests | 55 focused tests passed; engine dev build and diff check passed | Extend the bounded summary contract |
| 07 | Complete | Retained auto-mode range summaries, strict worker validation, bounded fitting, and cache-version tests | 75 focused tests passed after final amendments; desktop/sidecar typechecks and engine dev build passed | Implement frontend selectors |
| 08 | Complete | `usageAutoModeState.ts` and selector tests | `5c3ac954`, `68432ac2`, and `bcd35b6c`; focused selector/flow tests passed | Build charts |
| 09 | Complete | `UsageAutoModeBlockRate.tsx` and its test | `62021556`; focused chart test passed | Build bars and flow |
| 10 | Complete | `UsageAutoModeBars.tsx` and its test | `62021556` and `d0136c3f`; focused chart test passed | Build flow |
| 11 | Complete | `UsageAutoModeFlow.tsx`, layout state, and tests | `62021556` and `d0136c3f`; focused flow/layout test passed | Integrate Usage page |
| 12 | Complete | `UsageAutoMode.tsx`, page integration, CSS, and page-level test | `2bcd94fb`; focused integration/chart/text suite, app typecheck, and renderer build passed | Verify production path |
| 13 | Complete | `app/sidecar/autoModeUsage.integration.test.tsx` | Production writer-to-renderer fixture passed with 29 assertions | Final validation and documentation |
| 14 | Complete | Historical retained-record adapter, index/parser version advance, and fixtures | 81 focused tests passed; live retained-history result parsed within the envelope | Final report |
| 15 | Complete | Capability, ownership, resource, terminal, grid, and production-fixture corrections | 204 boundary tests passed after independent verification findings | Final report |

## Task 00 evidence map

| Question | Source-backed answer |
| --- | --- |
| Where does a logical initial tool permission attempt begin? | `QueryEngine` forwards each tool occurrence's stable `toolUseID` and optional forced decision to its configured `CanUseToolFn` ([`src/QueryEngine.ts:379-390`](../../src/QueryEngine.ts)). There is not one shared wrapper today: terminal React uses `useCanUseTool` ([`src/hooks/useCanUseTool.tsx:28-39`](../../src/hooks/useCanUseTool.tsx)); desktop wraps its base checker in `createAppRuntimeCanUseTool` ([`src/app-runtime/appRuntimeCanUseTool.ts:26-47`](../../src/app-runtime/appRuntimeCanUseTool.ts)); structured/print paths own parallel wrappers. Task 03 must attach an occurrence-owned observer at those outer wrappers before their `forceDecision ?? core` branch, not inside the core checker. |
| How is a recheck recognized? | `handleInteractivePermission().recheckPermission()` calls `hasPermissionsToUseTool` again with `ctx.toolUseID` ([`src/hooks/toolPermission/handlers/interactiveHandler.ts:204-212`](../../src/hooks/toolPermission/handlers/interactiveHandler.ts)). It is re-entry to the same occurrence, so it must not start or finish another observer. |
| What other callers need wiring? | The caller matrix is: React terminal interactive wrapper, print no-prompt/custom prompt wrapper, `StructuredIO.createCanUseTool`, desktop app-runtime wrapper, and in-process swarm wrapper. All can receive `forceDecision`; only the terminal interactive path currently exposes the same-ID recheck. Their common core is `hasPermissionsToUseTool`; headless and subagent behavior is selected by `ToolUseContext` rather than a separate auto-mode permission engine. Unsupported alternate permission engines remain unavailable rather than inferred. |
| How is effective auto mode computed? | Reuse exactly the core predicate: `TRANSCRIPT_CLASSIFIER` enabled and permission mode `auto`, or mode `plan` with `autoModeStateModule.isAutoModeActive()` ([`src/utils/permissions/permissions.ts:537-544`](../../src/utils/permissions/permissions.ts)). Do not derive it from renderer state. |
| How do diagnostics stay out of model input? | The existing metadata-only writer is `appendSystemDiagnostic` ([`src/utils/sessionStorage.ts:599-622`](../../src/utils/sessionStorage.ts)); it requires an active transcript lease, writes no file if no owner exists, stamps envelope fields itself, and swallows ordinary I/O failure. Usage dispatches recognized permission system subtypes before ordinary accounting ([`src/utils/statsUsage.ts:230-241`](../../src/utils/statsUsage.ts)); resume keeps non-local system rows out of model normalization ([`src/utils/messages.ts:2149-2166`](../../src/utils/messages.ts)). Writer, projection, and recovery regressions cover those boundaries. |
| Is complete historical permission metadata retained? | No. `logEvent`/`logEventAsync` are inert ([`src/services/analytics/index.ts:28-38`](../../src/services/analytics/index.ts)); `autoModeMeta` is a bounded process-local map. Retained `run_facts`, tool-use IDs/names, and exact code-owned denial text support a conservative partial reconstruction, but not historical routes, categories, rechecks, or a complete denominator. |
| How will each bucket's population support be established? | A valid prospective Start carries frozen `auto_mode` provenance and normalized `tool_kind`; its trusted writer timestamp defines the UTC start bucket. Complete support requires source/schema/build capability evidence for every included source interval plus successful retained reading. Missing starts, unsupported older sources, damaged reads, or unknown source intervals make the relevant population partial/unavailable. Recording enabled alone does not establish complete delivery. |
| Which versions invalidate indexed records and saved summaries? | The retained-record index is `index-v8.sqlite` ([`src/utils/statsUsageIndex.ts:12-17`](../../src/utils/statsUsageIndex.ts)); v8 rebuilds because earlier projections lacked source capability markers. Snapshots require counting version 12 and pricing version 1 ([`app/shared/usageDashboard.ts:223-244`](../../app/shared/usageDashboard.ts)). Pricing remains 1 because pricing semantics did not change. |

## Task 00 contract decisions

- Record only prospective metadata through the existing owned transcript diagnostic path. No classifier dump, global analytics, tool input, command text, prompt, response, rule text, credential, or path enters the Usage projection.
- The initial decision is occurrence-owned and frozen before a forced/core branch. Same-tool-use rechecks are supplementary and non-counting.
- Existing Usage host publication, snapshot cache, UTC ranges, 256 KiB result budget, and renderer-local selection remain unchanged.

## Task 01 contracts

- `AutoModeObservationEvent` is a closed metadata-only union for prospective Start, Stage entered/resolved, and End records. A Stage resolution carries exactly one boolean verdict or bounded failure. Start freezes `tool_kind`, effective-auto provenance (`auto` or `plan_auto`), and the initial marker.
- Record identifiers are UTF-8 bounded to 160 bytes. Category IDs are bounded identifiers, not rule text or free-form labels. The event parser rejects unknown kinds/enums, conflicting stage payloads, oversized IDs, and envelope fields the trusted diagnostic writer owns.
- `AutoModeUsageSummary` is the renderer-safe aggregate vocabulary only: outcomes, population coverage, UTC buckets, route/outcome counts, and bounded categories. It imports no engine writer or transcript data.

## Task 02 disposition mapping

- The mapper consumes only the initial raw result and structured observed failure/policy evidence. A typed unavailable, invalid-response, context-limit, or internal failure takes precedence over a classifier's fail-closed block result.
- `ask` is always Review required, including Stage 2 block and unavailable paths that hand off. A recorded interruption only maps a thrown initial check to Cancelled after stronger operational failures have been ruled out.
- Rule/safety/classifier policy evidence maps a deny to Policy-blocked; missing cause maps it to Unknown outcome. The mapper has no I/O and does not inspect or mutate permission results.

## Task 03 observer lifecycle

- An occurrence-owned observer emits parser-approved metadata only when its effective auto mode is frozen as `auto` or `plan_auto`. Rechecks use no observer; every new occurrence receives a new attempt ID.
- The observer accepts only its first terminal result and retains one entered/resolved record per completed classifier stage. The reusable outer seam preserves the original forced result or thrown error identity while Task 04 remains responsible for production route/cause mapping.
- `recordAutoModeObservation` uses the established transcript lease/owner path. Invalid payloads do not reach the writer; no transcript owner writes no file; a lease violation still throws; ordinary append failures remain best effort.

## Task 04 production permission wiring

- `CanUseToolFn` now accepts one final optional, engine-owned occurrence context. `QueryEngine` forwards it without changing denial tracking. The verified initial wrappers create it before their forced/core choice: React terminal, desktop app runtime, structured output, both print variants, and in-process swarm. Same-ID interactive and swarm rechecks call the core checker directly without a context; special-purpose permission callbacks remain compatible because the new parameter is optional.
- `getEffectiveAutoMode` is the single predicate used to freeze a Start and decide whether the core applies auto mode: `TRANSCRIPT_CLASSIFIER` with `auto`, or `plan` while the engine-owned auto-mode state is active. The context is in-memory, metadata-only, and is passed only to the core and its optional classifier stage callback.
- The core records base, forced, guard, accept-edits, allowlist, Stage 1, and Stage 2 routes. It supplies structured rule, safety, classifier, unavailable, invalid-response, context-limit, and interruption evidence without parsing diagnostic or error text. Context-limit/internal evidence retains precedence over a later interruption.
- The classifier callback emits exactly one entry/resolution pair per reached stage, including provider fallback retries as a single stage. It has no Usage writer import or access to renderer, IPC, prompt, tool-input, or model-output channels.

## Task 06 retained projection and accounting isolation

- The shared retained-system adapter recognizes the actual persisted event subtypes (`auto_permission_start`, `auto_permission_stage`, and `auto_permission_end`) before generic Usage activity accounting. Valid events are parser-normalized. A malformed End with a bounded attempt ID retains only its subtype and ID so the reducer produces Unknown rather than Incomplete; every other malformed event becomes a payload-free invalid marker. No unvalidated event field, tool input, command text, or free-form error survives.
- Direct retained accounting dispatches recognized diagnostics before timestamp, record, session, active-day, earliest-activity, token, request, comparison, and timing accounting. This preserves existing Usage metrics for valid, malformed, and duplicate diagnostics. Truncated JSON still follows the existing reader's partial-coverage behavior without inventing ordinary activity.
- The derived index writes only sanitized observation metadata, source capability, and normalized historical hints. `index-v8.sqlite` rebuilds older projections without changing transcripts. Existing source fingerprints, lock/transaction publication, corrupt-index recovery, source replacement/deletion, timeout, and warm-cache paths remain unchanged.
- Resume uses the established non-local system-message exclusion before model normalization. The regression verifies auto-mode metadata cannot enter resumed model messages or mask an interrupted prompt.

## Task 07 bounded summary contract

- Every Usage range now carries an `autoMode` aggregate. The collector feeds parser-normalized retained metadata into the pure reducer with a time-bounded prospective capability marker from the first retained Start and bounded observed source interval. Sources outside the requested range/bucket are ignored; a pre-capability interval is unavailable, an interval crossing that marker is partial, and only later evidence is complete. No source is retrospectively counted as a measured zero.
- The strict worker contract validates closed outcomes/routes, safe counts, command-subset invariants including bucket-to-range command totals, bucket/range and route/range reconciliation, bounded unique category keys and category totals, UTC range containment, and known allow-only route restrictions. All-history auto buckets coarsen onto the existing UTC grid with exact outcome sums and worst coverage before the bounded envelope is parsed.
- Counting version 12 invalidates older saved snapshots while pricing remains version 1. The existing index rebuild path reconstructs the new summary from retained projections without rereading unchanged sources.

## Task 05 retained-record reduction

- `reduceAutoModeUsage` is pure and accepts synthetic metadata-only retained records plus explicit source population support. It performs two-layer event/terminal validation, source-scoped joins, canonical record de-duplication, stable UTC start-bucket attribution, malformed-terminal salvage, orphan handling, and conservative coverage state.
- A valid Start with a malformed correlated End produces Unknown outcome rather than Incomplete. Invalid/missing route becomes Unknown route, invalid/missing category becomes Uncategorized, and neither erases an independently valid disposition. Invalid start identities and orphan markers never enter a denominator.
- Command rate is derived from integer policy-blocked command outcomes over all command outcomes. Partial/unavailable coverage returns an unavailable primary rate; complete coverage with unresolved outcomes returns a provisional numeric rate. Named category ranking is range-wide and namespaced by category kind/id before top-eight grouping.

## Verification

- `bun test src/utils/permissions/autoModeObservation.test.ts app/shared/usageAutoMode.test.ts`: 4 passed, 0 failed.
- `bun test src/utils/permissions/autoModeObservation.test.ts`: 5 passed, 0 failed. Covers every disposition-table row, Stage 2 block to Review required, unavailable to Review required, and input immutability.
- `bun test src/utils/permissions/autoModeObservation.test.ts src/utils/sessionStorage.test.ts`: 61 passed, 0 failed.
- `bun test src/utils/autoModeUsage.test.ts`: 11 passed, 0 failed.
- `bun test --feature=TRANSCRIPT_CLASSIFIER src/utils/permissions/autoModeObservation.test.ts src/utils/permissions/permissions.observation.test.ts src/utils/permissions/yoloClassifier.test.ts src/utils/permissions/permissions.test.ts src/app-runtime/appRuntimeCanUseTool.test.ts src/utils/swarm/inProcessRunner.test.ts`: 65 passed, 0 failed. Covers forced allow/deny, base/guard/fast paths, both classifier stages, review fallback, context limit, user abort, recheck omission, and desktop occurrence-context forwarding without changing the base result.
- `bun test src/utils/autoModeUsage.test.ts src/utils/statsUsage.test.ts src/utils/statsUsageIndex.test.ts src/utils/conversationRecovery.test.ts`: 55 passed, 0 failed. Covers sanitized valid/malformed metadata, unchanged ordinary accounting, indexed/direct reduction equivalence, warm cache, replacement/deletion, truncated input, index-version advance, and model-message exclusion.
- `bun test src/utils/autoModeUsage.test.ts src/utils/statsUsage.test.ts src/utils/statsUsageIndex.test.ts app/shared/usageStatsWorker.test.ts app/sidecar/usageSummary.test.ts app/sidecar/usageSummary.integration.test.ts`: 75 passed, 0 failed after final amendments. Covers observed source intervals, time-bounded capability, command-bucket reconciliation, bounded category keys, retained collection, cache rebuild, strict auto-mode parsing, bounded sidecar fitting, and the 256 KiB envelope.
- `bun run --cwd app typecheck`: passed.
- `bun run --cwd app typecheck:sidecar`: passed.
- `bun run build:dev:full`: passed. Workspace-map lint reported 7 existing recommended-section warnings; undefined-name lint passed with 0 diagnostics.
- `git diff --check`: passed.

## Task 13 production-path integration

The isolated desktop fixture materializes an owned temporary transcript, calls
`createAppRuntimeCanUseTool` with a controlled Stage 1 classifier/base decision,
and retains the production Start, entered/resolved Stage, and End records through
`recordAutoModeObservation`. It preserves the original allow decision and
`updatedInput`, calls the base permission path once, indexes and finalizes the
snapshot, validates the strict worker result, and server-renders `UsageAutoMode`.
It verifies the Stage 1 Allowed route and the command numerator/denominator.

Replayed diagnostic rows retain one logical attempt, and a cached restart reads
no transcript source. A later malformed diagnostic is included in the indexed
collection without changing existing token, request, session, record, or timing
metrics. The fixture uses no live tool, classifier provider, network, account, or
user state.

### Recording start and coverage limits

Recording begins only for a prospective initial occurrence after
`TRANSCRIPT_CLASSIFIER` is enabled and effective auto mode is frozen. A source
interval that began before its first retained Start is Partial, so its primary
command block rate is Unavailable rather than a fabricated zero percent. Older
or unsupported retained history is Unavailable; a valid recorded attempt remains
an observed count, not a claim of complete history.

### Task 13 verification

- `bun test --feature=TRANSCRIPT_CLASSIFIER app/sidecar/autoModeUsage.integration.test.tsx`: 1 passed, 0 failed, 29 assertions.
- Boundary-focused permission, reducer, index, parser, summary, and renderer suite: 171 passed, 0 failed, 1,389 assertions.
- `bun run build:dev:full`: passed; workspace-map lint reported 7 existing recommended-section warnings and undefined-name lint reported 0 diagnostics.
- `bun run --cwd app typecheck`, `bun run --cwd app typecheck:sidecar`, and `bun run --cwd app renderer:build`: passed.
- `bun test app/` is not green because of two existing `sessionController.test.ts` agent-fixture failures and an existing archived `tmp/` renderer-test import error. The final suite reported 5,078 passed, 1 expected feature-disabled skip, 3 failed, and 1 error; both auto-mode integration fixtures passed when explicitly run with `TRANSCRIPT_CLASSIFIER`.

## Task 14 historical partial reconstruction

The retained JSONL audit found pre-contract evidence that is useful but not
complete: Auto `run_facts`, tool-use IDs/names, exact code-owned classifier
denial/unavailable results, and later tool-execution diagnostics. The historical
adapter projects only a normalized outcome enum and correlates it with bounded
tool metadata. Exact denials become Policy-blocked, exact unavailable results
become Operational error, and other correlated Auto attempts become Unknown or
Incomplete. No raw result text survives `index-v8.sqlite`.

All reconstructed sources remain Partial. They populate observed counts and
Unknown routes without producing a confirmed historical command block rate.
Prospective structured observations suppress the fallback for the same tool-use
ID. A bounded live retained-history run parsed successfully at 142,071 bytes:
All contained 397 policy blocks, 169 operational errors, 37,628 unknown outcomes,
14 incomplete attempts, and 76 calendar buckets. These are reconstructed observed
counts, not a claim of complete historical activity.

## Independent verification remediation

The independent read-only pass identified five material gaps. The follow-up
records a capability marker before the first main or agent transcript message,
so new capable sources can establish complete zero-attempt intervals while
resumed pre-capability history remains Partial. Auto observations now honor the
collector's identity/state budget and target the agent-owned transcript when a
subagent identity is present.

End-event validation rejects contradictory raw-result/disposition pairs and the
defensive reducer degrades them to Unknown. Strict worker parsing now requires
All-history auto buckets to align with the published UTC grid. The production
fixture invokes the real permission core and a stubbed classifier response,
rather than manually emitting route/stage callbacks.

### Native visual verification

Unperformed: no authorization covered launching or driving Cat Code Dev. An
operator can launch with
`ANTHROPIC_MODEL=gpt-5.6-luna CATCODE_TEST_CWD_ALLOWLIST=<isolated-project> CATCODE_DEBUG_STATE=1 bun run --cwd app dev`,
wait for `[main] renderer ready`, open the isolated project, and select Usage.
Verify the live labels Decision flow, Command block rate, Decisions over time,
and Block reasons for 7 days, 30 days, and All; confirm unavailable/partial
coverage remains local to this section and Execution timing remains visible.
