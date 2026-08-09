# Adversarial second-pass review: A05 projector

> **Verification provenance:** Independent `gpt-5.6-sol` subagent at max effort. `gpt-5.6-luna` was requested, but the runtime ignored the same-family downgrade from the Sol parent. Read-only source review; no tests or GUI run.

## Overall verdict

The report identifies real issues, but overstates several costs and proposed fixes. The sole HIGH finding is confirmed as an idempotence/performance defect, not a visible-data correctness failure. Its “whole transcript rerender per duplicate frame” cost partly belongs to A04’s `attachChildren` identity defect, and restore traffic is coalesced into one reducer dispatch rather than one React commit per replayed frame.

No finding has been fixed by current uncommitted work. Relevant dirty changes add `agent_name` fixtures/tests and the engine-side `progressAgentName`; they do not alter projector, preview, raw-log, or view-model behavior. No tests or GUI were run because current source settles the claims.

## Findings

### 1. [HIGH] Tool-result-only user frames are not marked seen: **CONFIRMED**

- **Evidence:** `/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:1039-1052` deduplicates before correlation, but `/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:1106` returns correlated state without recording the frame. Only `/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:1295-1305` records `seenFrameIds`; tool results project no row at `:2016-2017`.
- **Trigger/cost:** Replaying the same UUID-bearing tool-result-only frame rebuilds its result projection and session slice. During an in-run restore this causes redundant map copying and a final selector-cache miss. Restore frames are batch-folded, however, so it is not one React commit per replayed result.
- **A04 overlap:** `/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:683-689` is what recreates every nested row. Only correlated tool rows fail the join identity check at `:573-580`; the “every row clones” cost must not be counted again here.
- **Disposition:** Mark a valid no-row frame seen after correlation and add a regression beside `/Users/pt/cat-code/app/renderer/src/transcriptProjector.test.ts:2798-2840` asserting replayed state and selector identities are unchanged.

### 2. [MED] Streaming deltas repeatedly scan the row array: **PARTIALLY CONFIRMED**

- **Evidence:** `/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:1681-1689` calls `/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:1762-1783`, which maps all rows and separately builds a set from all row IDs.
- **Trigger/cost:** Every live text delta in a long transcript performs two avoidable row-wide passes before the normal selector work. Live attached frames are delivered individually at `/Users/pt/cat-code/app/main/attachmentGate.ts:73-79`.
- **Limit:** Immutable replacement of an array tail remains O(rows). The proposed `[...rows.slice(0, -1), replacement]` also performs two copies, so it does not remove the asymptotic cost. The downstream rerender/Markdown cost is A04, not an additional A05 defect.
- **Disposition:** If profiling still justifies it after A04, use a guarded tail path with one `slice()`, replace its final element, and retain the general fallback.

### 3. [MED] Preview cache data is cast to `SDKMessage`: **PARTIALLY CONFIRMED**

- **Evidence:** `/Users/pt/cat-code/app/renderer/src/previewTranscriptState.ts:197-208` validates only record plus string `type`, then casts. This contradicts its no-cast claim at `:150-157`.
- **Trigger/cost:** This is type-system debt, not a current runtime defect. The consumers re-narrow sensitive fields, and main already excludes array messages while reading caches at `/Users/pt/cat-code/app/main/transcriptCache.ts:404-448`.
- **Limit:** The suggested `Record<string, unknown>[]` cannot currently be passed to `selectContextUsage`, whose signature is `readonly SDKMessage[]` at `/Users/pt/cat-code/app/renderer/src/contextUsage.ts:335-344`. The dirty projector-test additions also make the report’s exact cast-count claim stale.
- **Disposition:** Either widen the tolerant context-selection pipeline to unknown records and narrow there, or correct the “no casts” documentation. Merely adding an array check does not resolve the assertion.

### 4. [MED] Fixture row counts cannot detect hidden-row loss: **OVERSTATED**

- **Evidence:** The contract at `/Users/pt/cat-code/app/renderer/src/sdkMessageFixtures.ts:87-92` conflicts with the default-view assertion at `/Users/pt/cat-code/app/renderer/src/transcriptProjector.test.ts:517-531`; the synthetic sample declares zero at `/Users/pt/cat-code/app/renderer/src/sdkMessageFixtures.ts:865-878`.
- **Trigger/cost:** The fixture loop alone conflates “stored” with “visible.” However, `/Users/pt/cat-code/app/renderer/src/transcriptProjector.test.ts:2680-2717` directly proves synthetic rows are retained, so reverting to an early synthetic drop would not leave the overall suite green.
- **Limit:** Tool-result carriers produce no stored row even in revealed mode. Changing the selector would not test their correlation side effect.
- **Disposition:** Rename the field to `expectVisibleRows`, or add a distinct stored/revealed count and update the synthetic sample to one. Keep correlation coverage separate.

### 5. [MED] Exhaustiveness is not per nominal union member: **INVALID**

- **Evidence:** The current union has 19 aliases at `/Users/pt/cat-code/src/entrypoints/sdk/coreTypes.generated.ts:793-812`, while the fixture is keyed by runtime `type` at `/Users/pt/cat-code/app/renderer/src/sdkMessageFixtures.ts:98-108`. The projector’s `never` check at `/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:929-937` correctly exhausts those runtime discriminants.
- **Trigger/cost:** No current member lacks a sample. Several aliases structurally overlap: replay extends user with an optional property, and result-success is a subtype of result. TypeScript therefore cannot reliably treat the source aliases as 19 nominal members.
- **Disposition:** Do not add `UnionLength<SDKMessage> = 19`; it is brittle and does not prove sample coverage. If stronger enforcement is needed, generate an explicit census from runtime schema discriminants/subtypes.

### 6. [MED] Stored and selected tool rows share one type: **OVERSTATED**

- **Evidence:** `/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:103-120` requires derived fields, while stored rows receive defaults at `:1846-1852`; session rows are declared at `:404-416`.
- **Trigger/cost:** This is a type-model limitation, but no current consumer reads raw status. The only production reach-through found is the row count at `/Users/pt/cat-code/app/renderer/src/App.tsx:3910-3913`.
- **Limit:** Removing the fields from stored rows would force every pending tool row to be allocated by every selector pass, defeating the identity optimization at `/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:573-580` unless additional caching were introduced.
- **Disposition:** Clarify that correlated values, rather than the placeholder fields themselves, are never stored. Prefer making session internals opaque or adding a row-count selector over a broad row-type split.

### 7. [MED] Raw-log eviction repeatedly slices arrays: **CONFIRMED**

- **Evidence:** `/Users/pt/cat-code/app/renderer/src/rawMessageLog.ts:160-175` slices both arrays inside the eviction loop; `TextEncoder` is allocated at `:197-199`.
- **Trigger/cost:** Once a live log reaches its cap, each additional message copies the retained arrays. A large incoming message can evict many entries and produce O(k·n) copies.
- **Correction:** The report’s normal-restore estimate is not generally valid: same-UUID replay is explicitly skipped at `:139-150`, and replay is a newest-tail batch capped at `/Users/pt/cat-code/app/shared/limits.ts:141-142`.
- **Disposition:** Compute a drop index while subtracting byte sizes, then slice each array once. Hoist the stateless encoder.

### 8. [LOW] Parent cycles can remove rows from the nested view: **CONFIRMED**

- **Evidence:** `/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:663-689` classifies any row with a known parent as a child, then begins traversal only from `topLevel`.
- **Trigger/cost:** A self-parented row or mutual cycle leaves every cycle member outside `topLevel`, so all disappear. Current engine output does not mint this, but malformed cache/wire drift violates the renderer’s degrade-without-data-loss rule.
- **A04 overlap:** This shares the function with A04’s identity problem but is an independent data-loss condition.
- **Disposition:** Add cycle-aware reachability/visited tracking and surface cyclic components at top level, with self-cycle and mutual-cycle tests.

### 9. [LOW] Narrowing/name helpers are duplicated: **DUPLICATE/DEPENDENT**

- **Evidence:** Local guards exist at `/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:1790-1792`, `/Users/pt/cat-code/app/renderer/src/previewTranscriptState.ts:265-267`, and `/Users/pt/cat-code/app/sidecar/subagentHistory.ts:50-55`. The engine normalization at `/Users/pt/cat-code/src/utils/queryHelpers.ts:111-116` is currently uncommitted.
- **Trigger/cost:** The only concrete divergence is preview’s array check, already covered by finding 3. Null versus undefined reflects local contracts. Engine, renderer, and sidecar are separate runtime/bundle boundaries.
- **Disposition:** Do not create a broad cross-process `narrow.ts`. Address preview locally if finding 3 is changed; retain tiny boundary-local helpers.

### 10. [LOW] `logLineClass` documentation is misplaced: **CONFIRMED**

- **Evidence:** The documentation occupies `/Users/pt/cat-code/app/renderer/src/transcriptViewModel.ts:24-59`, immediately before `PEEK_LINES` at `:60-62`; `logLineClass` is at `:199`.
- **Trigger/cost:** Readers inspecting either declaration receive the wrong contextual documentation, including a live parity-deviation note.
- **Disposition:** Move the block directly above `logLineClass`; no behavior change.

### 11. [LOW] Repeated init frames invalidate transcript caches: **PARTIALLY CONFIRMED**

- **Evidence:** `/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:1186-1213` always creates a new slice and command array. The selector cache is keyed by that entire slice at `:633-661`; system init is emitted per query turn by `/Users/pt/cat-code/src/utils/messages/systemInit.ts:42-49`.
- **Trigger/cost:** One row-wide projection occurs at each turn start even if the catalog is unchanged.
- **Limit:** Reusing the command array while still updating `seenFrameIds` does not preserve the cache. Returning the original state without recording the UUID can let a later out-of-order replay of an older catalog revert the current one. Its full rerender cost also depends on A04.
- **Disposition:** Do not apply the proposed equality-only patch. Revisit only with a cache key based on row-affecting fields or separate init dedupe metadata.

### 12. [LOW] `messageUuid` uses a redundant cast: **CONFIRMED**

- **Evidence:** `/Users/pt/cat-code/app/renderer/src/rawMessageLog.ts:201-205` casts before reading `uuid`; the current common message base already declares `uuid?: string` at `/Users/pt/cat-code/app/shared/sdk-types.snapshot.d.ts:102-107`.
- **Trigger/cost:** No runtime defect; this is a redundant type assertion in projector-style boundary code.
- **Disposition:** Read `message.uuid` directly. A shared record guard is unnecessary.

### 13. [LOW] Reducer naming differs across modules: **PARTIALLY CONFIRMED**

- **Evidence:** Raw log pairs `createRawMessageLogState` with generic `reduceServerFrame` at `/Users/pt/cat-code/app/renderer/src/rawMessageLog.ts:73-100`; preview follows the state naming convention at `/Users/pt/cat-code/app/renderer/src/previewTranscriptState.ts:81-101`; projector deliberately uses `projectServerFrame` at `/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:807-834`.
- **Trigger/cost:** Only the raw-log name is materially ambiguous. Projection and preview reduction have different semantics, and `dispatchRawLog`/`dispatchTranscript` at `/Users/pt/cat-code/app/renderer/src/serverFrameBatch.ts:45-52` would remain store-specific regardless.
- **Disposition:** Rename the raw reducer only during a related API change, or explicitly waive it. A standalone multi-file rename is not justified.

## Counts

| Classification | HIGH | MED | LOW | Total |
|---|---:|---:|---:|---:|
| CONFIRMED | 1 | 1 | 3 | 5 |
| PARTIALLY CONFIRMED | 0 | 2 | 2 | 4 |
| STALE/ALREADY FIXED | 0 | 0 | 0 | 0 |
| OVERSTATED | 0 | 2 | 0 | 2 |
| DUPLICATE/DEPENDENT | 0 | 0 | 1 | 1 |
| INVALID | 0 | 1 | 0 | 1 |
| **Original severity totals** | **1** | **6** | **6** | **13** |

## Prioritized confirmed remediation

1. Mark no-row user frames seen and add an identity-preserving replay regression.
2. Change raw-log eviction to calculate one drop range and slice once; reuse one `TextEncoder`.
3. Make nested-row construction cycle-safe and retain cyclic rows at top level.
4. Move the misplaced `logLineClass` documentation.
5. Replace the redundant `messageUuid` cast with direct typed property access.
