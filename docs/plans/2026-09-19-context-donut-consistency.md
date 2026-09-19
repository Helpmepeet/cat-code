# Composer context donut: implementation plan

Date: 2026-09-19
Status: reviewed and revised after independent subagent source review; no application changes made
Suggested repository destination: docs/plans/2026-09-19-context-donut-consistency.md

## Goal and scope

Make the composer and its popover show the same context usage, keep the donut's meaning stable on hover, and prevent outdated category estimates from appearing current. Use the existing components, usage selector, engine thresholds, and snapshot request path.

The agreed simple design is an aggregate donut with an estimated category list underneath. Category-colored arcs are removed; category swatches and token counts remain. Preserve the popover's size, spacing, typography, palette, and Compact action as far as this change allows.

No new dependencies, tokenizer, polling loop, diagnostic subsystem, protocol shape, or broad refactor. Do not change engine compaction policy, token accounting, or transcript persistence. Do not scale category estimates to make them add up to API usage.

## Evidence and limits

contextUsage.ts reads reported message usage and the effective context window for the composer.

selectPanelUsage() in contextBreakdownState.ts replaces that total with the category sum and the breakdown's window. This is the direct source of the conflicting headline measurements.

selectDonutView() switches the center to category share of the category total on hover, while the arcs retain a full-window basis.

The supplied engine transcript's final Sol response reports 518,338 input tokens and 444 output tokens. The actual composer selector returns 53% for 518,782 / 980,000. The 980,000 denominator matches the reviewed Sol policy, but the live run-controls snapshot at screenshot time was not captured.

The exact 317k breakdown and its age were not recorded in the supplied logs. Do not claim that this plan fixes the estimator's underlying accuracy or proves screenshot-specific staleness.

## Target behavior

| Surface | Required behavior |
|---|---|
| Composer percentage | Existing reported usage divided by the effective window |
| Popover header | Same numerator, denominator, rounding, and fullness tone as the composer |
| Large donut | Same overall percentage; no category segments |
| Category hover | Optional row highlight only; center percentage and ring geometry stay unchanged |
| Category list | Heading Estimated breakdown; retain the returned counts and category colors |
| Capacity rows | Derived from reported usage and current engine thresholds, independently of category estimates |
| Missing or invalidated breakdown | Overall usage remains available; stale category rows are absent |
| Unknown window | Preserve the existing no-percentage behavior; do not manufacture a denominator |

The separate existing auto-compaction warning still measures headroom to the engine's compaction threshold. Its percentage is intentionally a different metric and should retain its current explanatory wording.

## Step 1: unify the headline and simplify the donut

Primary files:
- `app/renderer/src/ComposerActionsBar.tsx`
- `app/renderer/src/contextBreakdownState.ts`
- `app/renderer/src/contextUsage.ts` only if a small pure helper belongs there

Implementation:
- Make ContextUsagePanel use its supplied usage directly for the headline, large donut, pressure tone, and Compact-action escalation. Categories must not override any of these.
- Pass the same usage object through ContextChip to both its trigger and popover. Keep selectContextPercent() and pressureTone() as the existing shared rules.
- Replace ContextBreakdownDonut with a small aggregate ring in the same 76px space. Use the existing SVG approach: neutral full-circle track, used arc, and center percentage. At 53%, the arc must occupy approximately 53% of the circle.
- Keep the aggregate ring visible when the breakdown is absent. For an unknown window, render the neutral ring without a percentage and retain the token-only header.
- Remove the category-hover percentage and arc-emphasis state. A CSS hover background on list rows is sufficient. There should be no new hover-only information or keyboard interaction contract.
- Add Estimated breakdown immediately above the category list. Preserve category order, swatches, and counts. Use the existing formatter for the counts.
- Remove selectPanelUsage(), selectDonutView(), and their types/constants only where reference checks show they are obsolete. Retain category filtering and its current trust guard. Do not turn this into a cleanup of unrelated state modules.

Acceptance: changing only a breakdown snapshot must never change the headline, overall arc, fullness color, or Compact-action escalation.

## Step 2: reconcile capacity without double-counting reservations

Primary files:
- `app/renderer/src/ComposerActionsBar.tsx`
- `app/renderer/src/contextUsage.ts` for a small, testable capacity calculation

ComposerActionsBar already has runControls?.autoCompact. Pass the relevant existing threshold data through ContextChip to the panel; no new wire field is needed.

For known effective window W, reported usage U, and valid enabled autocompact threshold T:

T must be finite and positive and come from the current live controls whose effective window matches W. If that relationship cannot be established, use the single remaining-capacity row below. Do not combine a historical usage window with unrelated live threshold data.

```
remaining = max(0, W - U)
configured reserve within this window = clamp(W - T, 0, W)
remaining reserved capacity = min(remaining, configured reserve)
free before autocompaction = remaining - remaining reserved capacity
```

Display Free before auto-compact and Reserved remaining. The latter means the reserved space still left, so it can shrink if usage enters the reserve. The ring itself remains used versus remaining capacity; the reserve is not painted as consumed content.

Example using the logged total and the reviewed default Sol policy:

| Quantity | Tokens |
|---|---|
| Effective window | 980,000 |
| Reported used | 518,782 |
| Autocompact threshold | 900,000 |
| Free before auto-compact | 381,218 |
| Reserved remaining | 80,000 |

Here, used + free + reserved = 980,000. Do not insert the raw-window reserve of 100,000: the effective window already excludes 20,000 for summary output.

Edge behavior:
- If autocompaction is disabled, the threshold is unavailable, or no current engine snapshot exists, show only Remaining capacity when W is known. Do not imply a known auto-compaction budget or invent a manual reserve.
- If W is unknown, omit these capacity rows.
- If usage exceeds the window, keep the real used-token count, clamp the visual arc as today, and show zero remaining. Do not reduce the reported usage just to force an equality.
- Stop using breakdown.freeTokens to populate this panel's capacity rows. Leave the wire field and analyzer output intact for compatibility; changing their meaning is outside this fix.

## Step 3: invalidate estimates using existing events

Primary files:
- `app/renderer/src/contextBreakdownState.ts`
- `app/sidecar/sidecarServer.ts`
- `app/main/replayBuffer.ts`

Keep computation on demand. Invalidating a snapshot must not initiate an expensive analysis by itself.

Renderer:
- Clear a session's category snapshot on main-session turn start and completion, a main-thread compact boundary, transcript.reset, and changes to the selected/resolved control model, effective window, or permission mode. Use the existing event, run-controls.snapshot, and permission.context frames. turn.status carries activeTurn; it is not the process lifecycle frame.
- Ignore subagent messages when recognizing compact boundaries. Preserve the existing process-lifecycle reset behavior.
- Retain only enough per-session control state to detect these actual changes. Unrelated effort updates and identical snapshots must not invalidate the breakdown.
- Do not reject a breakdown by comparing its model directly with runControls.model.current. The analyzer resolves the runtime model, while run controls use the main-loop model; Plan mode can legitimately substitute Sonnet for a Haiku selection or Opus for opusplan. Use control-change invalidation and the sidecar generation guard below. Do not add a renderer model resolver.
- After invalidation, an already-open popover continues showing reported usage and capacity, with categories absent. Reopening requests a breakdown through the existing callback. No polling or automatic per-turn recount.

Sidecar:
- Use the existing controller, run-controls, and permission-context subscriptions to invalidate contextBreakdownLast and its freshness timestamp on the corresponding changes. Compare permission mode in the permission-context subscription; the existing run-control signature does not track it. Do this before any no-client broadcast guard, independently of whether a client is attached.
- Invalidate when a successful edit-from-message changes engine history, before projection/replay. Do not wait for a new turn or put invalidation inside the connection loop. This also covers a successful history mutation followed by a projection failure. The renderer clears on the resulting transcript.reset.
- Continue reusing a successful snapshot for 15 seconds only when no invalidation has occurred.
- Guard analysis races with one local generation counter: capture it when analysis starts; discard the result if invalidation changed it before completion. Never stamp an obsolete result as fresh.
- Preserve existing coalescing. A new explicit request during analysis can queue one follow-up attempt. Invalidation alone must not create a recount loop. If a result is discarded without a queued request, leave categories unavailable until the next opening.
- A failed refresh must not restore an invalidated snapshot. Preserve the reported headline and normal session operation.

Main-process replay:
- Make context-breakdown.snapshot non-retained in replayBuffer.ts, using a small explicit retention policy for this frame. Continue forwarding live snapshots normally. After renderer reload, categories start unavailable; opening the popover uses the existing request and sidecar cache.
- Do not merely move this frame from sticky storage to the ring. Run controls remain sticky and replay before ring events, so an old breakdown could otherwise arrive after newer controls and appear current. Keeping a sticky breakdown also lets historical turn events erase a valid snapshot on replay. Excluding on-demand breakdowns from replay avoids both ordering problems without a protocol change.
- Use existing frame shapes. A local generation counter does not need to cross the protocol boundary. If implementation reveals that a wire change is genuinely required, document the concrete race before expanding scope.

## Step 4: regression checks and cleanup

Extend the existing suites; use compact synthetic fixtures, not the user's full transcripts.

| Test location | Behavior to pin |
|---|---|
| `contextUsage.test.ts` | Logged buckets: 3,650 uncached + 514,688 cached + 444 output = 518,782; 980k denominator gives 53%; capacity edge cases |
| `ComposerActionsBar.test.tsx` | A conflicting approximately 317k breakdown cannot change the 53% header, ring, or tone; absent breakdown still shows overall usage; estimates are labeled |
| `contextBreakdownState.test.ts` | Turn/compact/model/window/permission-mode/reset invalidation; identical controls retained; valid Plan-mode runtime-model differences accepted; subagent isolation; lifecycle behavior |
| `contextBreakdownBoundary.test.ts` | Same-context reopen uses cache; invalidation bypasses its 15-second floor even after detached changes; obsolete analysis is discarded, including after an idle edit or permission-mode change; failed analysis cannot resurrect old data |
| `app/main/replayBuffer.test.ts` and the existing forwarding test seam | Breakdown snapshots never replay, including snapshot → model switch without a turn → reload; live delivery remains unchanged; reopening requests current data |

- Replace tests that require the old denominator switch or invisible category arcs. Keep assertions that still describe useful behavior, including no fabricated percentage for an unknown window and the Compact action's existing gating/focus behavior.
- Use an existing DOM-capable test harness if needed for hover. Do not add a UI testing dependency. Verify that hovering every category leaves the center percentage unchanged.
- Update touched comments that incorrectly describe reported usage as fresh-input-only or claim the category sum plus free space always equals capacity. Update the maintained desktop map only where this change makes its description inaccurate.
- Run the focused suites first. Before landing, follow current AGENTS.md/CLAUDE.md verification requirements, including applicable desktop tests, renderer/sidecar typechecks, and renderer build. Do not run bare repository-wide bun test.
- A manual Cat Code Dev check should verify: matched percentages, stable hover, unknown/empty context, model and Plan-mode changes, compaction, idle edit-from-message, renderer reload, reopening within 15 seconds after a change, and failure without stale rows returning. Follow the repository's existing GUI authorization rules; if GUI execution is unavailable, report that limitation and supply these operator steps.

## Delivery and completion

Implement sequentially: headline and aggregate ring, capacity rows, freshness, then regression verification. This is a small enough change for one implementer.

Before editing, re-read the affected functions and check the working-tree diff; the repository is shared. Preserve unrelated changes. Inspect all callers before deleting helpers. Follow the repository's current commit rules; do not push unless requested.

Done means the composer and popover agree for the same usage input, hover cannot change the metric, capacity rows use the same window, category estimates are clearly identified, and invalidated estimates cannot be served as fresh. The report must distinguish focused tests from actual GUI verification. Improving the category estimator and recovering the historical 317k snapshot remain separate work.
