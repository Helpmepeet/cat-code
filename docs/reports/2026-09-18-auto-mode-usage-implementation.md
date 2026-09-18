# Auto-mode Usage implementation

## Progress

| Task | Status | Changed files | Verification | Next |
| --- | --- | --- | --- | --- |
| 00 | Complete | This report | Source inspection complete | Define closed event and aggregate contracts |
| 01 | Complete | `autoModeObservation.ts`, `usageAutoMode.ts`, their tests | 4 focused tests passed; desktop typecheck and engine dev build passed | Implement pure disposition mapper |

## Task 00 evidence map

| Question | Source-backed answer |
| --- | --- |
| Where does a logical initial tool permission attempt begin? | `QueryEngine` forwards each tool occurrence's stable `toolUseID` and optional forced decision to its configured `CanUseToolFn` ([`src/QueryEngine.ts:379-390`](../../src/QueryEngine.ts)). There is not one shared wrapper today: terminal React uses `useCanUseTool` ([`src/hooks/useCanUseTool.tsx:28-39`](../../src/hooks/useCanUseTool.tsx)); desktop wraps its base checker in `createAppRuntimeCanUseTool` ([`src/app-runtime/appRuntimeCanUseTool.ts:26-47`](../../src/app-runtime/appRuntimeCanUseTool.ts)); structured/print paths own parallel wrappers. Task 03 must attach an occurrence-owned observer at those outer wrappers before their `forceDecision ?? core` branch, not inside the core checker. |
| How is a recheck recognized? | `handleInteractivePermission().recheckPermission()` calls `hasPermissionsToUseTool` again with `ctx.toolUseID` ([`src/hooks/toolPermission/handlers/interactiveHandler.ts:204-212`](../../src/hooks/toolPermission/handlers/interactiveHandler.ts)). It is re-entry to the same occurrence, so it must not start or finish another observer. |
| What other callers need wiring? | The caller matrix is: React terminal interactive wrapper, print no-prompt/custom prompt wrapper, `StructuredIO.createCanUseTool`, desktop app-runtime wrapper, and in-process swarm wrapper. All can receive `forceDecision`; only the terminal interactive path currently exposes the same-ID recheck. Their common core is `hasPermissionsToUseTool`; headless and subagent behavior is selected by `ToolUseContext` rather than a separate auto-mode permission engine. Unsupported alternate permission engines remain unavailable rather than inferred. |
| How is effective auto mode computed? | Reuse exactly the core predicate: `TRANSCRIPT_CLASSIFIER` enabled and permission mode `auto`, or mode `plan` with `autoModeStateModule.isAutoModeActive()` ([`src/utils/permissions/permissions.ts:537-544`](../../src/utils/permissions/permissions.ts)). Do not derive it from renderer state. |
| How do diagnostics stay out of model input? | The existing metadata-only writer is `appendSystemDiagnostic` ([`src/utils/sessionStorage.ts:599-622`](../../src/utils/sessionStorage.ts)); it requires an active transcript lease, writes no file if no owner exists, stamps envelope fields itself, and swallows ordinary I/O failure. Usage reads those `system` subtypes separately before assistant/user accounting ([`src/utils/statsUsage.ts:300-369`](../../src/utils/statsUsage.ts)). Resume/recovery treats system rows as non-conversation records ([`src/utils/conversationRecovery.ts:331-337`](../../src/utils/conversationRecovery.ts)). Task 03 writer tests belong beside `src/utils/sessionStorage.test.ts`; Task 06 must add explicit model/compaction/UI exclusion regressions. |
| Is complete historical permission metadata retained? | No. `logEvent`/`logEventAsync` are inert ([`src/services/analytics/index.ts:28-38`](../../src/services/analytics/index.ts)); `autoModeMeta` is a bounded process-local map; the index projects only model/tool timing diagnostics ([`src/utils/statsUsageIndex.ts:15-55`](../../src/utils/statsUsageIndex.ts)). The feature is prospective-only. Older source intervals are `unavailable`, never zero. |
| How will each bucket's population support be established? | A valid prospective Start carries frozen `auto_mode` provenance and normalized `tool_kind`; its trusted writer timestamp defines the UTC start bucket. Complete support requires source/schema/build capability evidence for every included source interval plus successful retained reading. Missing starts, unsupported older sources, damaged reads, or unknown source intervals make the relevant population partial/unavailable. Recording enabled alone does not establish complete delivery. |
| Which versions invalidate indexed records and saved summaries? | Current index is `index-v5.sqlite` ([`src/utils/statsUsageIndex.ts:11-16`](../../src/utils/statsUsageIndex.ts)); snapshots require counting version 9 and pricing version 1 ([`app/shared/usageDashboard.ts:223-244`](../../app/shared/usageDashboard.ts)). Task 06 must advance the index path because v5 discarded these records. Task 07 must advance counting version and strict parser fixtures; pricing remains 1 unless pricing semantics change. |

## Task 00 contract decisions

- Record only prospective metadata through the existing owned transcript diagnostic path. No classifier dump, global analytics, tool input, command text, prompt, response, rule text, credential, or path enters the Usage projection.
- The initial decision is occurrence-owned and frozen before a forced/core branch. Same-tool-use rechecks are supplementary and non-counting.
- Existing Usage host publication, snapshot cache, UTC ranges, 256 KiB result budget, and renderer-local selection remain unchanged.

## Task 01 contracts

- `AutoModeObservationEvent` is a closed metadata-only union for prospective Start, Stage entered/resolved, and End records. A Stage resolution carries exactly one boolean verdict or bounded failure. Start freezes `tool_kind`, effective-auto provenance (`auto` or `plan_auto`), and the initial marker.
- Record identifiers are UTF-8 bounded to 160 bytes. Category IDs are bounded identifiers, not rule text or free-form labels. The event parser rejects unknown kinds/enums, conflicting stage payloads, oversized IDs, and envelope fields the trusted diagnostic writer owns.
- `AutoModeUsageSummary` is the renderer-safe aggregate vocabulary only: outcomes, population coverage, UTC buckets, route/outcome counts, and bounded categories. It imports no engine writer or transcript data.

## Verification

- `bun test src/utils/permissions/autoModeObservation.test.ts app/shared/usageAutoMode.test.ts`: 4 passed, 0 failed.
- `bun run --cwd app typecheck`: passed.
- `bun run build:dev:full`: passed. Workspace-map lint reported 7 existing recommended-section warnings; undefined-name lint passed with 0 diagnostics.
- `git diff --check`: passed.
