# A04 Transcript View: Adversarial Second-Pass Review

> **Verification provenance:** Independent `gpt-5.6-sol` subagent at max effort. `gpt-5.6-luna` was requested, but the runtime ignored the same-family downgrade from the Sol parent. Read-only source review; no tests or GUI run.

## Overall verdict

The current `migration` source confirms 9 of 15 findings, including the central row-identity defect. The mechanism is proven: a same-session projected frame recreates every nested row, defeating `React.memo`; its HIGH severity remains unmeasured because no current profiler data exists. One other HIGH finding is primarily downstream of that defect, while two findings are invalid and several proposed fixes are broader than warranted.

Relevant dirty-tree note: `/Users/pt/cat-code/app/main/main.ts` is modified only around permission-mode commentary, not its CSP. Untracked `/Users/pt/cat-code/.design-sync/` now consumes two components discussed by finding 13, materially changing its deletion advice. No tests or GUI were run.

## Finding classifications

1. **CONFIRMED — [HIGH] Every row re-renders after a same-session projection**

   **Evidence:** `/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:552-580` preserves unchanged source-row objects, but `attachChildren` spreads every one at `:683-690`. Consequently the memo at `/Users/pt/cat-code/app/renderer/src/TranscriptView.tsx:492-505` receives a new `row`; the contradictory comment at `:1420-1423` is correct. Reasoning’s row-keyed WeakMap at `/Users/pt/cat-code/app/renderer/src/reasoningLayout.ts:177-200` also misses.

   **Trigger/cost:** Any projected change to the active session slice, including each text delta, re-enters every historical row’s render and Markdown path. The mechanism is certain; “300 rows per frame” and HIGH user impact are unmeasured.

   **Disposition:** Make nested projection identity-preserving, with tests covering unchanged leaves, a newly attached child, and changed descendants. Correct both comments. A recursive WeakMap is suitable only if cached parents are reused after comparing child references.

2. **DUPLICATE/DEPENDENT — [HIGH] Whole-payload parsing in collapsed cards**

   **Evidence:** `parseToolAck` runs at `/Users/pt/cat-code/app/renderer/src/TranscriptView.tsx:1190` and again in the expanded body at `:1950`; collapsed Bash output splits at `:2191-2193`; diff counting runs at `:1049-1052` and `:3541-3543`. Existing result-keyed caches are at `:1355-1367`.

   **Trigger/cost:** These become per-stream-frame historical costs because finding 1 forces settled cards to render. Independently, expanded acknowledgements and diffs perform two walks in one render. The report’s claimed “37ms for two 40k-line members” comment does not exist in current source, so the HIGH magnitude lacks evidence.

   **Disposition:** Fix finding 1 first. Then thread the already-derived acknowledgement and diff counts into the body. Do not add three WeakMaps unless profiling still shows repeated legitimate renders.

3. **PARTIALLY CONFIRMED — [MED] Fresh blockquote component remounts quote content**

   **Evidence:** `/Users/pt/cat-code/app/renderer/src/TranscriptView.tsx:650-653` creates a new blockquote function via `:853-867`; `QuoteCopyChip` owns `copied` state at `:785-796`. `ReasoningHeading` similarly creates a `p` renderer at `:2923-2930`.

   **Trigger/cost:** When an `AssistantProse` actually re-renders, React sees a different blockquote element type and remounts it, clearing copy confirmation. Same-session deltas currently trigger this through finding 1. The report overstates the trigger: another session’s frame is stopped by the slice cache plus `TranscriptRowsView` memo, and opening the inspector reaches the stable `TranscriptRowView` memo. The reasoning renderer has no comparable local-state loss.

   **Disposition:** Memoize the blockquote component by `content`; move the stateless reasoning paragraph renderer to module scope. This does not require broader Markdown refactoring.

4. **CONFIRMED — [MED] `TranscriptView.tsx` is an overgrown multi-responsibility module**

   **Evidence:** `/Users/pt/cat-code/app/renderer/src/TranscriptView.tsx` is currently 3,557 lines with 115 top-level declaration statements and 76 top-level function declarations. It combines dispatch, Markdown, tool cards, grouped runs, agents, output bodies, notices, reasoning, and diffing. `CodeBlock` at `:884` is already imported across the boundary by `/Users/pt/cat-code/app/renderer/src/CodeThemePreview.tsx:38`.

   **Trigger/cost:** Changes to unrelated transcript species contend on one file and make consistency checks harder. The report’s exact declaration counts are stale, but the cohesion problem is stronger, not weaker.

   **Disposition:** Reject the proposed nine-module big-bang move. Extract one tested seam at a time, beginning with the already cross-imported Markdown/`CodeBlock` area or pure diff logic. Create `.ts` model twins only where pure logic exists.

5. **CONFIRMED — [MED] Injected turns expose a raw debug tag**

   **Evidence:** `/Users/pt/cat-code/app/renderer/src/TranscriptView.tsx:3182-3184` renders `style.tag`; `:3195` explicitly calls it a debug tag. The sibling notice comment at `:2983-2988` explains why the same pattern was removed.

   **Trigger/cost:** Every injected channel, teammate, coordinator, or continuation row repeats an internal discriminant beside an already descriptive heading.

   **Disposition:** Remove the rendered tag and the `tag` field from all injected styles and fallback.

6. **CONFIRMED — [MED] Expanded Edit cards duplicate path and counts**

   **Evidence:** `deriveSub` creates `path · +adds −dels` at `/Users/pt/cat-code/app/renderer/src/TranscriptView.tsx:1049-1053`; the shell displays it when expanded at `:1152-1159`; `DiffView` repeats all three at `:3541-3549`.

   **Trigger/cost:** Expanding any diff-backed Edit or Apply_patch card produces consecutive duplicate headers and calculates counts twice.

   **Disposition:** Remove the diff branch from `deriveSub`; retain its MCP branch.

7. **CONFIRMED — [MED] Inline reveal depth is lost during tool regrouping**

   **Evidence:** Reveal depth is component-local at `/Users/pt/cat-code/app/renderer/src/TranscriptView.tsx:2067-2073`. A single row uses its row id at `:435-437`; grouping creates `read-run:<first-id>` at `/Users/pt/cat-code/app/renderer/src/toolRunLayout.ts:120-125`, changing both key and ancestor component. Expansion survives only because `/Users/pt/cat-code/app/renderer/src/toolCardExpansion.ts:5-17` stores it by `toolUseId`.

   **Trigger/cost:** Reveal a lone read beyond 30 lines, then receive a second adjacent read. The old body unmounts; the grouped member mounts with `headShown = 30`.

   **Disposition:** Add a narrow reveal-depth store keyed by `toolUseId`. Do not generalize all card UI into an abstract “view state” object.

8. **CONFIRMED — [MED] Inspector renders up to 5,000 rows and repeats search derivation**

   **Evidence:** `/Users/pt/cat-code/app/renderer/src/ToolInspector.tsx:171-179` memoizes source/body but not `describeOutputSearch`; `:287-329` maps every retained line. `/Users/pt/cat-code/app/renderer/src/outputSearchModel.ts:24-31` sets the 5,000-line cap, and `:52-82` splits and scans.

   **Trigger/cost:** Opening a 5,000-line result mounts thousands of row and segment elements. Wrap and copy-state changes repeat the model split despite unchanged search inputs; every query keystroke necessarily scans and rebuilds all retained lines. The mechanism is proven, but MED-visible latency is not measured.

   **Disposition:** Memoize `describeOutputSearch(body, query, matchIndex)`. Profile before undertaking virtualization; active-match scrolling makes a correct windowing change larger than the report suggests.

9. **CONFIRMED — [LOW] Two reasoning switch branches are unreachable**

   **Evidence:** Top-level rows are grouped at `/Users/pt/cat-code/app/renderer/src/TranscriptView.tsx:297-299`; nested rows at `:480-487`. `/Users/pt/cat-code/app/renderer/src/reasoningLayout.ts:238-267` converts every reasoning row, including a singleton, into `reasoning-run` in trail mode. Therefore the trail fallbacks at `/Users/pt/cat-code/app/renderer/src/TranscriptView.tsx:531-542` cannot execute.

   **Trigger/cost:** No runtime failure; the dead branches and misleading explanation complicate dispatch reasoning.

   **Disposition:** Keep only blocks-mode row rendering and document that trail mode dispatches upstream. Removing the unconditional context read also prevents unrelated rows from rerendering when layout mode changes.

10. **CONFIRMED — [LOW] Result success tone is dead**

    **Evidence:** `/Users/pt/cat-code/app/renderer/src/TranscriptView.tsx:3251` returns before every non-error result, making the ternary at `:3261` always danger. No other `Seam` call uses success; its dead union/map entries remain at `:3287-3301`.

    **Trigger/cost:** No runtime defect; dead vocabulary falsely implies success seams still render.

    **Disposition:** Use literal `danger` and delete the unused success tone and map entries. Do not retain speculative branches.

11. **INVALID — [LOW] `tone-good` and `tone-success` aliases**

    **Evidence:** `/Users/pt/cat-code/app/renderer/src/theme.css:152-156` intentionally exposes two semantic utilities backed by the same palette token.

    **Trigger/cost:** There is no current behavioral failure. Semantic aliases sharing a present color are legitimate; later divergence may be intentional rather than accidental.

    **Disposition:** No change. A renderer-wide rename and token deletion would be unrelated churn.

12. **CONFIRMED — [LOW] Remote URL images conflict with CSP**

    **Evidence:** `/Users/pt/cat-code/app/renderer/src/TranscriptView.tsx:2684-2700` renders every non-empty URL. The projector accepts arbitrary URL strings at `/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:2020-2035`. Both `/Users/pt/cat-code/app/main/main.ts:690-722` and `/Users/pt/cat-code/app/renderer/index.html:11-14` restrict images to self/data.

    **Trigger/cost:** An external HTTPS image source is rejected by CSP and renders a broken image/alt tile. The dirty main-file change does not touch this policy.

    **Disposition:** Render an explicit unavailable-image placeholder for unsupported URL sources. Do not weaken CSP or add remote fetching without a separate security design.

13. **PARTIALLY CONFIRMED — [LOW] `AgentStateWord` lacks its claimed production consumer**

    **Evidence:** `/Users/pt/cat-code/app/renderer/src/TasksDialog.tsx:460-485` does not render `AgentStateWord`, contradicting `/Users/pt/cat-code/docs/migration/PARITY-LEDGER.md:996`. `OrchestratorBadge`’s comment at `/Users/pt/cat-code/app/renderer/src/AgentChrome.tsx:205-217` also describes removed tab placement; Welcome uses a different `OrchestratorReflect` at `/Users/pt/cat-code/app/renderer/src/WelcomeScreen.tsx:445-505`.

    Current untracked consumers now exist at `/Users/pt/cat-code/.design-sync/previews/AgentStateWord.tsx:2-46` and `/Users/pt/cat-code/.design-sync/previews/OrchestratorBadge.tsx:2-46`, so “repo-wide grep returns only its definition” is stale.

    **Disposition:** Correct the ledger’s production claim. Do not delete either export while another session’s untracked design-sync work consumes it; decide explicitly whether preview-only exports are supported.

14. **INVALID — [LOW] Closed style lookups need fallbacks**

    **Evidence:** `NOTICE_STYLE` lookup is at `/Users/pt/cat-code/app/renderer/src/TranscriptView.tsx:2997`, but its key is the closed union minted through typed calls in `/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:356-359,1276-1284`. Tool family and status are likewise locally derived closed unions. By contrast, injected kinds are deliberately open strings and correctly use a fallback at `/Users/pt/cat-code/app/renderer/src/TranscriptView.tsx:3166`.

    **Trigger/cost:** None exists on the current data path. Adding fallbacks would mask internal invariant violations rather than improve wire-drift handling.

    **Disposition:** No change.

15. **OVERSTATED — [LOW] Delegate vocabulary is derived twice**

    **Evidence:** `/Users/pt/cat-code/app/renderer/src/TranscriptView.tsx:1885-1924` derives group vocabulary, then `AgentToolCard` derives it again at `:1798-1807`; `agentToolSourceOf` scans children at `:1657-1674`.

    **Trigger/cost:** The duplicate computation is real but small, and its per-frame repetition is downstream of finding 1. The two results cannot silently diverge today because both call the same pure resolver at `/Users/pt/cat-code/app/renderer/src/agentIdentity.ts:417-425`.

    **Disposition:** No standalone fix. Pass precomputed vocabulary only if this area is already being changed or profiling identifies it.

## Counts

| Classification | HIGH | MED | LOW | Total |
|---|---:|---:|---:|---:|
| CONFIRMED | 1 | 5 | 3 | 9 |
| PARTIALLY CONFIRMED | 0 | 1 | 1 | 2 |
| STALE/ALREADY FIXED | 0 | 0 | 0 | 0 |
| OVERSTATED | 0 | 0 | 1 | 1 |
| DUPLICATE/DEPENDENT | 1 | 0 | 0 | 1 |
| INVALID | 0 | 0 | 2 | 2 |
| **Original severity totals** | **2** | **6** | **7** | **15** |

## Prioritized confirmed remediation

1. Preserve nested-row identity and add referential-identity tests; correct the conflicting memo comments.
2. Persist inline reveal depth by `toolUseId`; remove the injected-turn debug tag; render URL images as an explicit unavailable placeholder without weakening CSP.
3. Remove the duplicated Edit summary and the unreachable reasoning/result-seam branches.
4. Memoize inspector search derivation, then profile before committing to virtualization.
5. Incrementally extract cohesive `TranscriptView` seams; avoid the proposed nine-file big-bang refactor.
