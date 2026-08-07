# A04 — TranscriptView and tool rendering

## Verdict

The rendering discipline here is genuinely good: static tone→class maps everywhere (zero interpolated Tailwind, zero inline `style={{}}`), compile-time `never` tripwires paired with runtime tolerant fallbacks in both dispatch switches, and pure logic consistently split into tested `.ts` twins (~4,100 lines of tests against ~5,900 lines of source, designed around the SSR-only harness rather than in spite of it). The single most important thing to fix is a performance defect the file half-knows about: `attachChildren` in the projector spreads every row into a new object on every projected frame, so `React.memo(TranscriptRowView)` misses for the entire session history and every assistant message re-runs its remark/rehype parse on every streamed delta — the memo comment at `TranscriptView.tsx:492` asserts the opposite of what the comment at `:1420` correctly says. Second: `TranscriptView.tsx` is 3,557 lines and 73 top-level declarations rendering ~14 distinct row species inline; the house `Component.tsx` + `componentModel.ts` pairing exists in this very scope (`AgentChrome.tsx`/`agentChromeModel.ts`) and simply was not applied as the file grew.

## Findings

### [HIGH] Every row re-renders and re-parses its Markdown on every projected frame; the memo comment claims otherwise

- **Where**: `app/renderer/src/TranscriptView.tsx:492-498` (the `TranscriptRowView` memo and its comment), caused by `app/renderer/src/transcriptProjector.ts:683-689` (`attachChildren`)
- **Type**: correctness (perf) + quality (comment asserts a false property)
- **What**: `selectNestedTranscriptRows` is cached on the session slice, but when the slice does change it rebuilds the tree with `attachChildren = row => ({...row, children: ...})`, which mints a **new object for every row**. `React.memo`'s shallow compare on the `row` prop therefore misses for every row in the transcript, not just the changed one. `TranscriptRowView` is the only memo barrier on the path (`DisplayItemView` at `:455` is not memoized, `AssistantProse` at `:634` is not memoized), so the whole history re-renders.
- **Trigger / why it matters**: one streamed assistant delta for the active session → `projectServerFrame` returns a new `TranscriptState` → new session slice → `selectNestedTranscriptRows` cache miss → all rows are new objects → every `AssistantProse` in the session re-runs `remark-gfm` + `rehype-highlight` over its full body, and `reasoningStepsForRow`'s WeakMap (keyed on the row object, `reasoningLayout.ts:177`) misses so every prose reasoning step re-parses its markdown too and `ReasoningStep`'s memo (`:2845`) misses with it. On a 300-row session this is the entire transcript's markdown, per frame. Frames are batched per delivery (`serverFrameBatch.ts`), not on a time window, so a live turn commits many times a second.
  The file contains its own disproof: `:492` says *"a slice-cached read reuses unchanged row objects, so only the rows that actually changed re-render (markdown re-parses once per body)"*; `:1420-1423` says *"rows are rebuilt every frame, so the shallow compare misses."* Both cannot be true, and the second one is.
- **Fix**: preserve identity in `attachChildren` — keep a `WeakMap<TranscriptRow, NestedTranscriptRow>` and return the cached nested row when the source row object is identical and its children list is unchanged. `selectTranscriptRows` already returns the **same** `TranscriptRow` object when nothing changed (`transcriptProjector.ts:568-575`), and leaf rows (the overwhelming majority) always get the same empty children array, so this restores the memo the comment promises with no behaviour change. Then correct the `:492` comment.

### [HIGH] Full-payload parses run per collapsed tool card per frame, on a path this file already fixed once with WeakMaps

- **Where**: `app/renderer/src/TranscriptView.tsx:1190` and `:1950` (`parseToolAck`), `:2192` (`BashTailPeek`), `:1049-1056` + `:3357-3367` (`deriveSub` → `countDiff`)
- **Type**: correctness (perf)
- **What**: three unmemoized whole-payload walks run during the render of a **collapsed** card:
  - `parseToolAck(content)` at `:1190` does `JSON.parse` on the entire tool result for every non-agent card on every render, and an expanded card parses it a **second** time at `:1950`. Cheap for output that fails at byte 0, a full parse for the many results that really are JSON (every MCP result, every ack).
  - `BashTailPeek` at `:2192` does `selectPeekLines(content.split('\n'))` — an unconditional O(output) split plus a filter — on every render of every collapsed bash card. Collapsed is the default (`DEFAULT_TOOLS_EXPANDED = false`).
  - `deriveSub` at `:1197` calls `countDiff`, which walks every line of every hunk, on every render of every edit card, expanded or not.
- **Trigger / why it matters**: compounded with the finding above (the memo cannot save any of them), a session holding 30 tool cards with a few MB of accumulated output re-walks all of it on every streamed frame. This is not hypothetical for this file: `:1366-1367` already installs `grepDigestByResult`/`readDigestByResult` for exactly this reason, and its comment states the measurement — *"a COLLAPSED run parsed every member's whole file on every frame, measured at 37ms for two 40k-line members."* The same fix was not applied to the three call sites above.
- **Fix**: cache all three on the `ToolResultProjection` object with the identical `WeakMap` idiom already in the file — `result` is copied by reference across row rebuilds (`:1358-1365` explains why that key is the correct one), so one parse per tool result instead of one per frame. Also drop the duplicate `parseToolAck` at `:1950` by threading the value `ToolCard` already computed.

### [MED] A new blockquote component type is minted every render, remounting quote subtrees and killing the copy confirmation

- **Where**: `app/renderer/src/TranscriptView.tsx:650-653` (and the same shape at `:2929`)
- **Type**: correctness
- **What**: `AssistantProse` builds `components = {...MARKDOWN_COMPONENTS, blockquote: createBlockquoteComponent(content)}` fresh on every render. `createBlockquoteComponent` returns a **new function**, and React treats a changed element type as a different component — so every `<blockquote>` subtree unmounts and remounts on each render, discarding the `copied` state inside `QuoteCopyChip` (`:786`).
- **Trigger / why it matters**: click "Copy quote" on any message, then let any transcript activity land inside the 600 ms tick window (`:795`) — a streamed token in this session, a frame from another session, opening the inspector. The checkmark vanishes instantly and the user gets no confirmation that the copy happened. Combined with the first finding, any live turn makes the tick unreachable in practice. The comment at `:645-649` justifies the fresh build on allocation cost (*"cheap next to the remark/rehype parse"*), which was never the concern — component **identity** is.
- **Fix**: `const components = useMemo(() => ({...MARKDOWN_COMPONENTS, blockquote: createBlockquoteComponent(content)}), [content])`. `ReasoningHeading` at `:2929` mints a new `p` component the same way; it holds no state so there is no visible bug, but it forces the same remount and should get the same treatment (or a module-level constant, since it does not close over anything).

### [MED] `TranscriptView.tsx` is a 3,557-line god file rendering ~14 row species inline

- **Where**: `app/renderer/src/TranscriptView.tsx` (whole file: 73 top-level declarations, ~48 of them components)
- **Type**: design
- **What**: the header doc describes this module as *"the row dispatch"* — an exhaustive switch over `NestedTranscriptRow['kind']`. That module is about 400 lines. The other 3,150 are every row body, every tool family, the markdown stack, the diff renderer, the agent card, the reasoning trail, and the seam/notice grammar, all inline. Distinct row types rendered here: assistant prose, user bubble, command echo, user image, thinking block, redacted thinking, reasoning trail (run/step/line/withheld), system notice, task notification, injected turn, result seam, compact-boundary seam, snip/tombstone seams, tool card (14 families × 7 body renderers), grouped tool run, agent card, delegate group.
- **Trigger / why it matters**: the concrete cost is already visible in this review. Three findings above are *the same defect applied inconsistently to sibling call sites 700 lines apart* (`grepDigestByResult` exists; `parseToolAck`/`BashTailPeek`/`countDiff` do not). Two comments in the file contradict each other about whether the row memo works. `PARITY-LEDGER.md:996` records that a P4-32b change could not be applied to the agent-card header *because another session held this one file uncommitted* — file size is directly serializing concurrent work on this shared tree.
- **Fix**: split along the seams that already exist, each as a `Component.tsx` + `componentModel.ts` pair (the established house pattern — `AgentChrome.tsx`/`agentChromeModel.ts`, `ToolInspector.tsx`/`toolInspectorModel.ts`, `TranscriptView.tsx`/`transcriptViewModel.ts`), which is also what the Fast Refresh rule requires since most groups carry static class maps:
  1. `AssistantProse.tsx` — `AssistantProse`, `MarkdownErrorBoundary`, `childrenToText`, `MARKDOWN_COMPONENTS`, `QuoteCopyChip`, `createBlockquoteComponent`, `CodeBlock`, `BubbleCopyChip`, `REMARK_PLUGINS`/`REHYPE_PLUGINS`/`COPY_CHIP_TEXT` (~330 lines). `CodeBlock` is already imported cross-file by `CodeThemePreview.tsx:38`, i.e. a shared primitive currently living in a private module.
  2. `ToolCard.tsx` + `toolCardModel.ts` — `ToolCardShell`, `ToolCard`, `ToolInspectorLaunch`, `FAMILY_STYLE`/`STATE_STYLE`, and the pure `deriveTarget`/`deriveSub`/`mcpServerTool` (~700 lines). Those three derivations are pure and today are only testable through rendered markup.
  3. `ToolRunCard.tsx` + `toolRunDigest.ts` — `ToolRunCard`, `toolRunHead`, `ToolRunRow`, `ToolRunRowLabel`, `readRangeLabel`, `toolRunDigest`, `memberReadPath`, `memberGrepDigest`, `deriveToolRunStatus`, the digest WeakMaps (~300 lines).
  4. `AgentToolCard.tsx` + `agentToolCardModel.ts` — `agentToolSourceOf`, `agentActivityOf`, `agentToolCallCount`, `agentProgressBadge`, `agentWorkerType`, `AgentToolCard`, `DelegateGroup`, `AgentCompletionBody`, `agentCompletionTone`, `compactCount`, `formatDuration` (~300 lines).
  5. `ToolCardBodies.tsx` — `ToolCardBody`, `LogLines`, `BashBody`, `BashTailPeek`, `AckPeek`, `AckBody`, `NumberedBody`, `AdditionsBody`, `WriteBody`, `GrepBody`, `PlainLinesBody`, `ImageResultBody`, `InlineRevealBand`, `useInlineOutputWindow`, `stringifyInput`, `LOG_GUTTER_CLASS`/`INLINE_OUTPUT_SCROLLER` (~450 lines).
  6. `DiffView.tsx` + `wordDiff.ts` — `DiffView`, `DiffHunk`, `WordDiffBody`, `countDiff`, `wordDiffPair`, the four `DIFF_*`/`WORD_*` maps (~200 lines). `wordDiffPair`'s 90 % guard has no unit test today precisely because it is welded to JSX.
  7. `ReasoningTrail.tsx` — `ReasoningRun`, `ReasoningStep`, `ReasoningNode`, `ReasoningProse`, `ReasoningHeading`, `ReasoningLine`, `WithheldReasoningLine`, `RedactedThinkingBlock`, `ThinkingBlock` (~230 lines; the pure half is already in `reasoningLayout.ts`).
  8. `TranscriptSeams.tsx` — `Seam`, `ResultSeam`, `CompactBoundarySeam`, `SystemNoticeBox`, `TaskNotificationBox`, `InjectedTurnBox` and their five constant maps (~350 lines).
  9. `UserRows.tsx` — `UserBubble`, `CommandEchoBubble`, `UserImageRowView` (~90 lines).

  What should remain in `TranscriptView.tsx`: `TranscriptView`, `TranscriptRowsView`, `DisplayItemView`, `NestedRowList`, `TranscriptRowView`, `ToolInspectorOverlay`, `PreviewSkeleton`, `groupDisplayItems`, `displayItemKey`, `isRevealedHiddenItem`, and the contexts — the dispatcher the header doc actually describes.

  Two prop-shape smells fall out of the same split and are worth fixing while the code moves: `ToolCardShell` (`:1072`) has 11 props including three optional `ReactNode` slots (`headerBadge`/`alwaysExtra`/`collapsedExtra`), so it cannot be read without reading all four of its callers; `Seam` (`:3309`) has 8 props, 4 of them booleans (`dashed`/`faded`/`boldLabel`/`italicLabel`), two of which are only ever passed together and one of which has a single caller.

### [MED] `InjectedTurnBox` renders the raw discriminant as a corner tag — the exact debug tag its sibling removed for violating §7

- **Where**: `app/renderer/src/TranscriptView.tsx:3182-3184`, field defined at `:3195`
- **Type**: convention (user-visible text)
- **What**: the row renders `style.tag` in its top-right corner: `channel`, `teammate`, `coordinator`, `continuation`, or `injected`. The field's own doc comment calls it *"Trailing debug tag, matching the SystemNoticeBox/TaskNotificationBox idiom."* That idiom no longer exists — `SystemNoticeBox`'s doc at `:2986-2988` records that this exact affordance was **removed**: *"it used to also print the raw discriminant in the corner, which is a debug tag, not a word anyone reads (CLAUDE.md §7)"* — and `TaskNotificationBox` has no tag either.
- **Trigger / why it matters**: any channel, teammate, coordinator or deferred-continuation turn prints an internal discriminant at the user. It is the last surviving instance of a pattern the operator already rejected once, kept alive by a comment citing a sibling that no longer does it.
- **Fix**: delete the `tag` field from `InjectedTurnStyle` and its render. The glyph plus the heading (`Channel message` / `@handle` / `Coordinator` / `Continuation`) already carry the kind.

### [MED] An expanded Edit card prints its file path and ±counts twice

- **Where**: `app/renderer/src/TranscriptView.tsx:1197` + `:1049-1056` (the `sub`) against `:1945` + `:3545-3549` (`DiffView`'s header)
- **Type**: correctness (visual defect)
- **What**: `ToolCard` passes `sub={deriveSub(row)}`, which for a diff result returns `` `${filePath} · +${adds} −${dels}` ``. `ToolCardShell` renders that as a micro-label at `:1154-1158` whenever the card is expanded. The body for that same row is `DiffView`, whose header renders the identical `filePath`, `+{adds}` and `−{dels}` immediately below it.
- **Trigger / why it matters**: expand any `Edit` / `Apply_patch` card and the same three values appear on two consecutive lines. `deriveSub`'s own doc comment says it exists for the *"uppercase micro-label under the header"*; it predates `DiffView` growing a header of its own and neither owner noticed the overlap.
- **Fix**: drop the diff branch from `deriveSub` (leaving it to return `undefined` for edits, as it already does for most families) — `DiffView`'s header is the richer of the two, since it truncates the path and hides zero counts.

### [MED] The inline "Show N more" reveal is lost when rows regroup — the same failure `toolCardExpansion.ts` exists to prevent, one level down

- **Where**: `app/renderer/src/TranscriptView.tsx:2067-2074` (`useInlineOutputWindow`)
- **Type**: correctness
- **What**: `headShown` lives in component-local `useState`. When a lone read or search folds into a run, both the React key and the component type change — `ToolCard` keyed `<row id>` becomes a `ToolRunRow` inside a run keyed `read-run:<row id>` — React unmounts the subtree and the reveal resets to the first 30 lines (`INLINE_HEAD_LINES`).
- **Trigger / why it matters**: expand a read card, click "Show 100 more" twice to reach line 230, then let the model issue a second adjacent read. The run forms and the body snaps back to 30 lines. This is the identical mechanism `toolCardExpansion.ts:6-13` documents and solves for card *expansion* — *"the moment a second adjacent read arrives … both the key AND the component type change, so React unmounts the old tree and the user's expansion dies with it"* — and the reveal has the same lifetime requirement but was not moved with it.
- **Fix**: key the reveal off the engine's `toolUseId` in the same store — either a second map on `ToolCardExpansionStore`, or generalise it from `Map<string, boolean>` to per-card view state so both the expansion and the reveal depth survive a regroup.

### [MED] The tool inspector mounts up to 5,000 line rows unwindowed and re-splits the whole output on every render

- **Where**: `app/renderer/src/ToolInspector.tsx:178` and `:292-328`; cap at `app/renderer/src/outputSearchModel.ts:31`
- **Type**: correctness (perf)
- **What**: `describeOutputSearch(body, query, matchIndex)` is called bare at `:178` while `source` and `body` directly above it are both `useMemo`'d — so `text.split('\n')` re-runs on every render, including the `Wrap` and `Copy` toggles, which change nothing about the search. The body then maps every line to a `<div>` + sticky gutter `<span>` + N segment spans with no virtualization.
- **Trigger / why it matters**: click "Open full output" on a 5,000-line bash result (the band exists precisely for outputs that large) and roughly 15,000 DOM nodes mount at once. Type one character in the search field and you get a full re-split plus 5,000 `toLowerCase().includes()` scans plus a `splitLineByQuery` allocation per line, per keystroke. `outputSearchModel.ts:24-30` anticipates the second half (*"the whole body re-renders on every keystroke — so an unbounded output would freeze the renderer on a keypress"*) and answers it with a cap rather than windowing, and the missing `useMemo` was not part of that reasoning at all.
- **Fix**: wrap `describeOutputSearch` in `useMemo` on `[body, query, matchIndex]` (one line, removes the toggle-driven re-splits immediately). Windowing the rendered rows to the visible range plus the active match is the real fix for the DOM count.

### [LOW] Two unreachable branches in the row switch

- **Where**: `app/renderer/src/TranscriptView.tsx:531-534` and `:538-542`
- **Type**: dead-code
- **What**: the `thinking` case's non-`blocks` branch (`<ReasoningRun steps={reasoningStepsForRow(row)} />`) and the `redacted-thinking` case's non-`blocks` branch (`<WithheldReasoningLine />`) can never run. In `trail` mode `groupDisplayItems` (`:426-433`) converts *every* reasoning row into a `reasoning-run` item before dispatch, both at top level (`:297-299`) and inside `NestedRowList` (`:482`), so no reasoning row ever reaches `TranscriptRowView` in that mode; in `blocks` mode the other branch always wins.
- **Trigger / why it matters**: the comment at `:523-528` explains a dispatch that cannot happen, which is exactly the kind of confident-and-wrong prose that costs the next reader time.
- **Fix**: reduce both cases to their `blocks` treatment and note in the comment that trail-mode reasoning is handled upstream by the grouping pass.

### [LOW] `ResultSeam`'s tone ternary is dead, and with it the `success` entries in both seam maps

- **Where**: `app/renderer/src/TranscriptView.tsx:3251` and `:3261`; maps at `:3289-3301`
- **Type**: dead-code
- **What**: `:3251` returns `null` unless `isError`, so `tone={isError ? 'danger' : 'success'}` at `:3261` always evaluates to `'danger'`. No other caller passes `tone="success"`, so `SEAM_RULE_CLASS.success` and `SEAM_LABEL_TONE.success` have no reachable call site either.
- **Trigger / why it matters**: leftover from the 2026-07-19 removal of the success turn-footer (noted in the comment at `:3248-3250`); it reads as if a success seam still renders somewhere.
- **Fix**: `tone="danger"` literal; leave the map entries only if a future success seam is planned, otherwise drop them.

### [LOW] `bg-tone-good` and `bg-tone-success` are one colour under two names inside one file

- **Where**: `app/renderer/src/TranscriptView.tsx:3020-3026` vs `:977-988`; both resolve to `var(--tone-good)` at `app/renderer/src/theme.css:154-155`
- **Type**: quality (naming)
- **What**: `agentCompletionTone` returns `bg-tone-good` while `STATE_STYLE.success` uses `bg-tone-success`. `agentChromeModel.ts:11` picks `tone-good`, `ToolInspector.tsx:367` picks `tone-good`, the diff maps pick `tone-success`. Same token, four call sites, two spellings.
- **Trigger / why it matters**: a reader diffing two green dots has to open `theme.css` to learn they are identical, and a future retheme that changes one alias silently splits them.
- **Fix**: pick one spelling across the renderer and delete the other alias from `theme.css`.

### [LOW] The `url` image source renders a broken image under the app's own CSP

- **Where**: `app/renderer/src/TranscriptView.tsx:2684-2704`; policy at `app/main/main.ts:704` and `app/renderer/index.html:13`
- **Type**: correctness (degrade-gracefully)
- **What**: `UserImageRowView` builds `src = source.url` for the `{type:'url'}` variant and renders `<img src={src}>` whenever `src.length > 0`. The renderer's CSP is `img-src 'self' data:`, so any remote URL is refused and the row draws a broken-image box with no explanation. Only the `base64` branch (a `data:` URI) can ever load. The projector accepts any string as a URL (`transcriptProjector.ts:2036-2039`).
- **Trigger / why it matters**: a pasted or injected image block carrying a URL rather than bytes renders as a broken tile. The component's own doc comment claims *"Malformed or empty sources degrade to a placeholder label rather than a broken `<img>`"*, which the `url` branch does not honour. (The CSP is doing its job here — this is a display defect, not a security hole.)
- **Fix**: fall through to the `[Image]` placeholder for any source that is not a `data:` URI, or state the unloadable source in text.

### [LOW] `AgentStateWord` is a dead export and the parity ledger claims otherwise

- **Where**: `app/renderer/src/AgentChrome.tsx:137`; the stale claim at `docs/migration/PARITY-LEDGER.md:996`
- **Type**: dead-code
- **What**: a repo-wide grep for `AgentStateWord` returns only its own definition. The ledger row asserts it is *"Rendered by `AgentStateWord` … in the `/tasks` Workers-tab worker row (`app/renderer/src/TasksDialog.tsx:466`)"* and concludes *"this is no longer a tested dead export"* — `TasksDialog.tsx` contains no reference to it, and `:466` is `WorkerRow`'s signature. Related: `OrchestratorBadge` (`:218`) now has no production call site either (its tab placement was removed on operator ruling, recorded at `PARITY-LEDGER.md:450`), yet its doc comment at `:205-217` still says it *"rides the session TAB next to the title (B1) … and with `onToggle` it IS the mode switch (M1)"*.
- **Trigger / why it matters**: two ledger/doc claims that a grep disproves, in the file a reader would consult to decide whether a primitive is safe to change.
- **Fix**: delete `AgentStateWord` (or wire it where P4-32b intended), correct the ledger row, and update `OrchestratorBadge`'s doc comment to describe where it actually renders (the empty-state reflect, `WelcomeScreen.tsx`).

### [LOW] `NOTICE_STYLE[noticeType]` destructures without the fallback its neighbour has

- **Where**: `app/renderer/src/TranscriptView.tsx:2997`
- **Type**: convention (degrade-gracefully asymmetry)
- **What**: `const { glyph, glyphTone } = NOTICE_STYLE[noticeType]` throws on a missing key, while `InjectedTurnBox` fifteen lines below does `INJECTED_TURN_STYLE[injectedKind] ?? INJECTED_TURN_FALLBACK` for the same shape. The same bare lookup appears at `:1107-1108` (`FAMILY_STYLE[family]`, `STATE_STYLE[status]`).
- **Trigger / why it matters**: none today — all three keys are minted only inside the renderer's own projector with literal values (`transcriptProjector.ts:358`, `:1964`, and `deriveToolFamily` at `:1549` has a `default: 'other'`), so drift cannot reach them. It is a trap rather than a bug: in a module whose stated doctrine is *"display = degrade gracefully"*, the two spellings sit side by side with nothing marking which one is load-bearing.
- **Fix**: `?? FALLBACK` on all three, or a one-line comment at each stating that the key is projector-minted and closed.

### [LOW] `DelegateGroup` derives each member's agent vocabulary twice

- **Where**: `app/renderer/src/TranscriptView.tsx:1886` and `:1923` → `:1799`
- **Type**: quality
- **What**: `DelegateGroup` maps `deriveAgentDisplayVocabulary(agentToolSourceOf(member))` over every member to build its header, then renders `<AgentToolCard row={member}>` for each, which recomputes the identical value at `:1799`.
- **Trigger / why it matters**: the derivation walks `row.children` (`agentToolSourceOf` at `:1670-1674`), so it is not free, and it runs on every frame per the first finding. More importantly the two copies can be edited apart — the header's `anyPending`/`anyError` and the card's own state word are supposed to agree, and the comment at `:1887-1890` says exactly that.
- **Fix**: compute once and pass the vocabulary down as a prop, so there is one derivation the two readings cannot diverge from.

## What is good here

- **Tailwind v4 discipline is exemplary and consistently reasoned.** Zero interpolated arbitrary-value classes across the scope (`rg` for `` [${ `` returns only the two comments that *warn* about the trap), zero inline `style={{}}`, and every colour lives in a static `Record` map — `FAMILY_STYLE`, `STATE_STYLE`, `DIFF_ROW_CLASS`/`DIFF_SIGN_CLASS`, `WORD_EMPH_CLASS`/`WORD_DIM_CLASS`, `SEAM_RULE_CLASS`/`SEAM_LABEL_TONE`, `NOTICE_STYLE`, `REASONING_NODE_PLACEMENT`, `LINE_TEXT_CLASS`/`WRAP_BUTTON_CLASS`/`STEP_BUTTON_CLASS`, `AGENT_*_TONE_CLASS`, `PIP_SIZE_CLASS`. `FAMILY_STYLE`'s header (`:930-938`) and `DIFF_ROW_CLASS`'s (`:3376-3379`) each explain *why* a literal hex beats a named utility, so the next author cannot "tidy" it back.
- **The error asymmetry is implemented, not just documented.** Both dispatch switches carry a compile-time `never` tripwire *and* a runtime tolerant fallback beside it (`:590-602`, `:465-469`), which is the harder half to get right. `MarkdownErrorBoundary` catches a react-markdown throw and degrades to the raw source; `wordDiffPair` (`:3416-3439`) has its own `try/catch` with a comment explaining why it cannot rely on that boundary (`DiffView` sits outside it, and SSR would not catch a throw at all).
- **Pure logic is genuinely extracted and genuinely tested.** `inlineOutputWindow.ts`, `outputSearchModel.ts`, `readSource.ts`, `grepResult.ts`, `toolRunLayout.ts`, `transcriptViewModel.ts`, `reasoningLayout.ts` are all side-effect-free with colocated suites — ~4,100 test lines against ~5,900 source lines. Several headers say explicitly that the split exists *because* the renderer suite is SSR-only and cannot click (`inlineOutputWindow.ts:16-19`, `outputSearchModel.ts:5-10`). That is designing around a known harness limit rather than pretending it away.
- **Two places choose silence over a false number.** `totalGrepDigest` (`grepResult.ts:83-102`) returns `null` for a run whose members measured different units rather than summing files into matches, and distinguishes that refusal from a real measured zero. `toolRunDigest` (`:1602-1619`) reports a line count only when `parseReadSource` truly recognised the engine's numbered shape, because several *successful* reads carry no file at all. Both carry the source citations that justify the rule.
- **`toolCardExpansion.ts` is a correct diagnosis with the right mechanism.** Keying on the engine-minted `toolUseId` rather than React identity is the only thing that survives a row being re-projected, re-nested or folded into a run; backing it with a `Map` behind a ref rather than React state means a card toggle re-renders one card instead of the whole transcript. The header states both the failure it fixes and the reason state was rejected.

## Not reviewed / uncertain

- **No DOM or app run.** Every interaction claim above is derived from source plus React's type-identity and key/lifetime rules, not observed: the blockquote remount, the reveal reset on regroup, and the inspector's keystroke cost. The renderer suite is SSR-only so none of them is covered by a test today, and none would be caught by the existing battery. A React Profiler recording of one streaming turn on a long session, plus a manual click on a quote-copy chip during a live turn, would settle all three in minutes.
- **The two performance findings are not measured.** The mechanism is proven from source (`attachChildren`'s spread, the missing WeakMaps), but the magnitude depends on the sidecar's real frame delivery rate and typical payload sizes. The nearest existing data point is the `37ms for two 40k-line members` measurement already recorded in this file's own comment at `:1261-1264`, which is the same class of cost.
- **Autoscroll is another scope's file.** `App.tsx:3961-3972` owns stick-to-bottom off `contentSignature = renderedRowCount:partialCount`. I confirmed only the negative: card expansion and the inline reveal do not change that signature, so neither can yank the viewport. Whether `partialCount` advances on every text delta — and therefore whether stick-to-bottom keeps pace mid-message rather than only at row boundaries — I did not verify.
- **`ToolCardExpansionStore` is read during render as an external mutable `Map`** (`toolCardExpansion.ts:118-121`) without `useSyncExternalStore`. Under concurrent rendering a discarded-and-replayed render could in principle observe a torn value. The module argues the tradeoff explicitly and `bump()` forces a synchronous re-render of the one card, so I did not treat it as a finding — but it is the one place in this scope where the React-18 concurrency contract is knowingly bent, and it would want a second look if `startTransition` is ever introduced on the transcript path.
