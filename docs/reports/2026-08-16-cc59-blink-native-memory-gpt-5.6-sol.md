# CC-59 debug report: Blink native memory after transcript virtualization

> **SUPERSEDED 2026-08-16. Do not act on this report's verdict or its
> "Correction direction" section.** Both were disproven by experiment. The
> growth was React 19's development-build performance track cloning uncapped
> prop serializations into native memory, not text-layout churn; see
> `2026-08-16-cc59-blink-native-memory-claude-fable-5.md`. The fix
> (`eda3055e`) changes nothing in the rendering path this report describes —
> every whole-value `nodeValue` assignment, replace-all invalidation, reshape
> and synchronous geometry flush still happens on every commit — and the
> growth is gone anyway: 31 minutes across 3 panes ended at 120 MB where the
> failing run reached 6,451 MB in 11.5 minutes. This report proposed exactly
> that discriminator (§"Correction direction") and did not run it.
>
> **Kept because four things in it are correct and are not recorded
> elsewhere:** (1) `App.tsx:612-619` counts only `App`-level commits, so
> `BoundedMarkdown`-internal updates are invisible and every per-commit figure
> in either report is an upper bound; (2) the PartitionAlloc retention model
> (regions are not live objects, swapped is not freed), the only account on
> record of the 9.5-minute resident collapse; (3) the source map of the
> streaming text path through React and Chromium 130, which is accurate; (4)
> paint and compositor buffers as an untested contributor, a gap the
> superseding report's hidden-tab harness structurally could not see.
>
> Its rejections also hold and were independently confirmed: `rehype-highlight`,
> ResizeObserver, JS-state retention, and the replay storm are all correctly
> ruled out.

**Date:** 2026-08-16
**Investigation model:** GPT-5.6 Sol (`gpt-5.6-sol`)
**Branch:** `migration`
**Status:** Mechanism established at the allocation-path level. Exact byte attribution among native text, shaping, and paint buffers remains unmeasured.
**Scope:** Desktop renderer, one long streaming assistant response containing a fenced TypeScript block. No tool calls. No code change is proposed or made by this report.

## Executive verdict

The failure is caused by **native text-layout churn during streaming, followed by PartitionAlloc high-water retention**.

Transcript virtualization bounds the DOM present at one instant. It does not bound the cumulative native allocation caused by repeatedly replacing and laying out a growing text node. For each streamed update, React assigns the complete new text through `Text.nodeValue`. Blink treats this as replacement of the entire previous `CharacterData`, bypasses its incremental inline-edit path, invalidates the complete LayoutNG inline formatting context, and rebuilds native string, shaping, line-layout, and paint data for the currently mounted text.

`BoundedMarkdown` then reads layout geometry after every component commit. When layout is dirty, `getBoundingClientRect()` synchronously flushes the invalidated layout. Window or measurement updates can add further component commits that the app-level `rendersCommitted` counter does not observe.

The old native generations need not remain reachable as detached DOM. PartitionAlloc retains empty slot spans and fragmented VM mappings for reuse, especially in Blink's macOS buffer partition. Its dirty pages can be swapped rather than returned. The result is a renderer with a small V8 heap, a bounded live DOM, and gigabytes of PartitionAlloc footprint distributed over tens of thousands of regions.

The virtualization work therefore solved the wrong dimension for this workload. It bounds **live mounted structure** but not **the integral of native allocation over streaming mutations**.

## Incident evidence

The clean trajectory is:

`app/.ram-scratch/trajectory/single-turn-2026-08-16T05-17-11-883Z.run.json`

It contains 24 samples at 30-second intervals over 11.5 minutes, from one renderer process with one visible session and one pane.

| Metric | First | Peak or final | Result |
|---|---:|---:|---|
| Renderer footprint | 154 MB | 6,451 MB | Accelerating, 1,098 MB/min after warm-up |
| PartitionAlloc dirty | 55 MB | 5,222 MB peak | Later resident collapse is paging, not freeing |
| PartitionAlloc swapped | 0 | 5,837 MB | Native pages moved to swap |
| PartitionAlloc regions | 897 | 32,607 | Accelerating, 3,777 regions/min |
| V8 resident | 87.5 MB | 264.8 MB peak | Not the dominant compartment |
| JavaScript heap | unavailable initially | 129.5 MB peak, 53.3 MB final | Not the source of 6.45 GB |
| App-level React commits | unavailable initially | 10,166 cumulative | Native growth follows commit activity |

At 9.5 minutes, PartitionAlloc resident and dirty collapsed because about 5.7 GB had been swapped. Footprint and region count did not collapse. The allocator had not relinquished the high-water allocation state.

The renderer later exited through Chromium's deliberate PartitionAlloc out-of-memory abort class (`reason=crashed`, `exitCode=5`). No symbolicated crash report corresponding to this clean trajectory was found. The available 12:12 local renderer report belongs to the earlier DevTools-induced V8 parser crash and is not evidence for this run.

## Quantitative link between commits and native allocation

Across the 22 30-second windows carrying both commit counters and memory samples:

- 10,132 measured parent commits;
- 31,611 new PartitionAlloc regions;
- 6,346.9 MiB net renderer-footprint growth;
- Pearson correlation between commit delta and PartitionAlloc-region delta: **0.746**;
- the same correlation after excluding the largest native-growth window: **0.821**.

The seven windows with at least 700 commits contained:

- 8,254 commits;
- 23,770 new PartitionAlloc regions;
- 4,645.1 MiB footprint growth.

Four near-idle windows containing eight total commits added:

- eight PartitionAlloc regions;
- 1.4 MiB footprint.

The native cost per parent commit was not stationary:

| Run phase | Approximate native cost |
|---|---:|
| Earlier active windows | 1 to 4 PartitionAlloc regions per commit |
| Late active windows | about 7.4 regions per commit |
| Late footprint growth | about 1.5 to 2.5 MiB per measured parent commit |

This shape distinguishes a growing-input operation from a fixed listener or observer leak. Near-idle windows are nearly flat. Active windows allocate. Cost per commit rises as the streaming text and its current inline layout grow.

The app-level counter is a lower bound. `App` increments it in a no-dependency post-commit effect at `app/renderer/src/App.tsx:612-619`. State changes owned inside `BoundedMarkdown`, including window and measured-height updates, do not re-render `App` and therefore do not increment this counter.

## Current renderer path

### 1. The live DOM window is genuinely bounded

`BoundedMarkdown` derives a complete renderer-side plan, then mounts only:

```text
mergeMountedMarkdownLeaves(measuredLeaves, leafWindow.start, leafWindow.end)
```

at `app/renderer/src/BoundedMarkdown.tsx:76-79`.

The returned component renders only `mounted.map(...)` at `app/renderer/src/BoundedMarkdown.tsx:210-256`. There is no hidden complete document, staging tree, or `display:none` copy.

`selectMarkdownLeafWindow` applies the leaf and element ceilings at `app/renderer/src/markdownRenderPlan.ts:356-392`. Incorrect browser geometry can select the wrong bounded window, but it cannot bypass these loops and mount the full plan.

The existing absolute model proofs remain relevant:

- 50,000 inline links mount 201 nodes;
- 50,000-line and 500,000-line tool outputs mount the same 36 to 40 rows;
- a 200,000-character logical line mounts one bounded row.

Those proofs establish current mounted structure. They do not establish cumulative native allocation across thousands of replacements of that structure.

### 2. An open fence is not syntax-highlighted

The open-fence fast path is at `app/renderer/src/markdownRenderPlan.ts:193-235`.

While the final fence is unterminated:

1. the settled prefix HAST may be reused;
2. the tail is parsed only to confirm it remains one unterminated fence;
3. the tail is routed to `planPlainText`;
4. `rehype-highlight` is not run on the growing fence;
5. the fence becomes a highlighted code card only when its delimiter closes.

The suspected repeated `rehype-highlight` pass is therefore not the mechanism for the measured open-fence stream. It can still add CPU and V8 work for settled Markdown or prose appended after a closed fence, but it does not explain the native PartitionAlloc trajectory while the long fence is open.

### 3. React performs whole-value text replacement

The installed React DOM implementation commits a changed text child with:

```text
textInstance.nodeValue = newText
```

at `app/node_modules/react-dom/cjs/react-dom-client.development.js:22174-22175`.

This is not a DOM `appendData()` or a narrow `replaceData()` call. The complete current string is assigned on every streamed text commit.

### 4. Blink classifies the mutation as replace-all

Electron 33.4.11 embeds Chromium 130.0.6723.191, revision `b872957737636278e1da4818e40a40c66b72a2b0`.

In that source:

- `CharacterData::setData()` represents assignment as `TextDiffRange::Replace(0, old_length, new_length)`;
- `CharacterData::SetDataAndUpdate()` installs a new immutable Blink `String`, updates the `Text` layout object, increments document state, and runs mutation handling;
- `Text::UpdateTextLayoutObject()` reaches `LayoutText::SetTextWithOffset()`;
- `InlineNode::SetTextWithOffset()` rejects incremental editing when the supplied edit replaces the complete old value;
- `LayoutText::TextDidChange()` requests layout, intrinsic-width recalculation, and full paint invalidation;
- `LayoutText::TextDidChangeWithoutInvalidation()` invalidates LayoutNG inline items and requests inline recollection.

Chromium's source states the governing limitation directly:

> Invalidation is currently all or nothing in LayoutNG.

The relevant upstream files are:

- `third_party/blink/renderer/core/dom/character_data.cc`;
- `third_party/blink/renderer/core/layout/layout_text.cc`;
- `third_party/blink/renderer/core/layout/inline/inline_node.cc`.

### 5. LayoutNG rebuilds the inline formatting context

After the whole-value mutation invalidates the old inline items, `InlineNode::PrepareLayout()` recollects inline content, segments text, and shapes text for the inline node.

`InlineNode::ShapeText()` explicitly supplies the shaper with the full context of the entire node. Because the changed `LayoutText` invalidated the old items, a single large `white-space: pre-wrap` text item is reshaped as a whole rather than preserving all unchanged leading lines and processing only the appended tail.

The work includes:

- collecting the complete current inline text into `InlineItemsData`;
- segmentation and bidirectional-text data as applicable;
- glyph shaping and glyph-position buffers;
- line breaking for preserved newlines and wrapping;
- line and physical-fragment construction;
- full paint invalidation.

The open fence avoids thousands of highlight spans, but its plain `pre-wrap` text remains expensive because every append becomes replace-all layout work.

### 6. The geometry path forces dirty layout to settle

`BoundedMarkdown` reads root and scroller rectangles when selecting a live window at `app/renderer/src/BoundedMarkdown.tsx:98-110`.

It also runs an effect after every `BoundedMarkdown` commit with no dependency array and reads the root rectangle at `app/renderer/src/BoundedMarkdown.tsx:130-153`.

In Chromium, `Element::getBoundingClientRect()` routes through:

```text
Element::GetBoundingClientRect
Document::EnsurePaintLocationDataValidForNode
Document::UpdateStyleAndLayoutForNode
Document::UpdateStyleAndLayout
LocalFrameView::UpdateStyleAndLayout
```

If the streamed text or virtual spacer changed and layout is dirty, this call synchronously updates it before returning geometry. It does not itself paint, but it prevents dirty text layout from remaining deferred past that read.

The pane coordinator batches corrections once per animation frame at `app/renderer/src/markdownScrollCoordinator.ts:113-180`. That prevents the explicit self-scroll feedback cycle. It does not prevent the text mutation from invalidating and rebuilding the current inline context.

## Where the PartitionAlloc bytes go

The mechanism spans several native allocation classes.

### Native Blink strings

`WTF::String` owns immutable, ref-counted `StringImpl` storage. `StringImpl::CreateUninitialized()` allocates the object and its complete 8-bit or 16-bit payload through Blink's `WTF::Partitions::BufferMalloc()` root.

That buffer root is PartitionAlloc memory, VM tag 253 in this Electron build. On macOS it deliberately uses a larger empty-slot-span ring.

A complete growing JavaScript string can therefore materialize as a complete new native Blink character buffer on each assignment. The exact V8-to-WTF conversion strategy depends on the V8 string representation, so this report does not assign all bytes to string copies alone.

### Shaping buffers

`ShapeResult` object shells use Blink GC, but their glyph payloads are mixed-ownership. HarfBuzz run glyph data and optional glyph-offset arrays use native `new[]` or WTF-native storage routed through the renderer allocator.

Repeated full-node shaping therefore creates native glyph and position buffers even when V8 remains flat.

### Display and paint buffers

Every text change requests full paint invalidation. Blink display-item vectors and compositor `PaintRecord`/`PaintOpBuffer` data own native buffers. Paint is a plausible secondary contributor after the mandatory string and inline-layout work.

The geometry read forces layout, not paint, so the measured commit correlation does not independently quantify the paint share.

### Allocator retention and region proliferation

PartitionAlloc is designed to keep capacity for reuse:

- normal allocations reserve superpages;
- address space reserved for a slot span is not released merely because the span becomes empty;
- newly empty spans remain in an empty-span ring before reclamation;
- the memory reclaimer can lag or miss a short allocation spike;
- Blink's macOS buffer partition keeps a larger ring;
- decommitting or remapping subranges can split VM mappings, increasing region count;
- macOS can move retained dirty pages to swap.

Consequences for interpreting the trajectory:

- region count is not a live-object count;
- a freed old text or shaping generation can leave allocator capacity behind;
- swapped pages are not freed pages;
- no detached DOM history is required to produce a monotonically increasing region count and high footprint.

## Candidate-mechanism dispositions

| Candidate | Disposition | Evidence |
|---|---|---|
| Live renderer mounts the full Markdown document | Rejected | Production renders only the bounded `mounted` range; geometry cannot bypass the leaf and element loops. |
| `rehype-highlight` repeatedly creates the native growth | Rejected for the open-fence workload | The open tail is excluded from the processor and rendered as plain text until closure. Highlighting builds HAST in V8, not a hidden DOM. |
| JavaScript state or HAST retention | Rejected as the dominant compartment | JS heap peaked at 129.5 MB while renderer footprint reached 6.45 GB. |
| ResizeObserver retains every historical target or record | Rejected | Chromium keeps one observation per current target, uses a weak target reference, clears delivered entries, and disconnects current observations. Application measurements are capped and pruned. |
| Observer/window feedback mounts unbounded DOM | Rejected | It can add layout and bounded remount churn, but the final render still maps only the bounded window. The pane suppresses its own scroll feedback. |
| Detached React or DOM subtrees are the main retained object | Low support; unnecessary to explain the run | Stable row and leaf keys reuse ordinary streaming nodes. No application owner retains every generation. Region growth tracks updates, not a few structural remount boundaries. |
| Replay storm drives the clean run | Rejected | Preserved replay evidence belongs to an earlier occurrence ending more than nine minutes before this trajectory. Almost none of that replay reached renderer state application. |
| Full native string replacement plus full inline layout and shaping | Established primary mechanism | React uses whole-value `nodeValue`; Blink classifies it as replace-all; LayoutNG invalidation is all-or-nothing; dirty layout is synchronously flushed; native allocation scales with commit activity and becomes more expensive late in the stream. |
| Paint/compositor record churn | Plausible secondary contributor | Every text change requests full paint invalidation and paint buffers are native, but no allocation trace separates their share. |
| Native selection | Fatal-allocation trigger in a prior crash, not the growth source | Selection-bounds shaping can request the allocation that finally fails after the allocator is exhausted. It does not explain the preceding gigabytes. |

## Preserved delivery evidence

The preserved delivery and operational logs are from an earlier occurrence, not from the clean trajectory. They were analyzed only as closed-vocabulary aggregates; no transcript or payload content was copied into this report.

They establish that the earlier occurrence had a real replay storm:

- 6,676 distinct replay-marked sequences;
- all were requeued and resent through main IPC;
- 2,027 reached preload;
- four reached the renderer subscription;
- none reached renderer state application in the retained replay subset.

Normal queued and applied counts matched until the final minute. They then diverged by 1,246 sequences, consistent with a renderer that stopped committing at the end of that occurrence.

These facts separate three phenomena:

1. replay was a real but mostly pre-renderer delivery amplifier in the earlier occurrence;
2. final commit starvation occurred later in that earlier occurrence;
3. the clean 05:17 trajectory independently shows native allocation tracking ordinary render commits without evidence that replay was involved.

## Why the prior fix was plausible and insufficient

The previous diagnosis correctly identified mounted DOM, layout, text, and highlighting as native Blink costs. It then treated **live structure count** as the controlling variable and built a hierarchical leaf virtualizer.

That intervention was necessary for giant static documents and element-dense content. It did not cover a different cost function:

```text
cumulative native cost
  = sum over streamed commits(
      native string materialization
      + full current inline recollection
      + full current inline shaping
      + line layout
      + paint invalidation
    )
```

A fixed maximum mounted chunk still permits this sum to become unbounded with the number of streaming updates. Within each bounded chunk, the current text grows from small to the leaf ceiling and is replaced repeatedly. PartitionAlloc keeps the high-water pages after each generation dies. The next bounded chunk repeats the cycle.

The clean trajectory's increasing regions per commit is the empirical signature of that omitted dimension.

## Correction direction

No code change is made here. The mechanism identifies the required behavior of a future correction:

1. **Do not represent an open streaming fence as one React text value repeatedly replaced wholesale.**
2. Keep completed visible lines or chunks immutable and isolate the mutable trailing line in a narrow layout scope.
3. Apply append-local DOM changes, or an equivalent keyed-line rendering model that does not turn a tail append into replacement of the full current inline node.
4. Preserve the existing line, character, element, and viewport bounds.
5. Batch stream deltas to no more than one visible commit per animation frame.
6. Recompute virtual geometry only when line, chunk, or window geometry can change, rather than merely because another token arrived.
7. Continue to defer syntax highlighting for the open fence; on settlement, highlight only the bounded visible lines or chunks.

A useful isolated discriminator before changing the app would compare two hidden real-Chromium fixtures under external `vmmap` sampling:

- current behavior: replace a growing bounded `pre-wrap` text node and read its rectangle each update;
- append-local behavior: immutable completed lines plus one narrow mutable tail, with the same visible content and update cadence.

The probe must run outside a loaded user renderer, without DevTools, and report only process memory, region counts, and fixed DOM counts. A flat second trajectory against a reproducing first one would assign causality without adding a bridge or exposing transcript data.

## Confidence and remaining unknowns

### Established

- The clean failure is native PartitionAlloc growth, not V8 heap growth.
- The production renderer mounts a bounded Markdown window.
- The open fence bypasses syntax highlighting while streaming.
- React performs complete text-value assignment.
- Blink classifies that assignment as a complete replacement.
- Chromium 130's LayoutNG path invalidates and rebuilds the inline context rather than applying a tail-only edit.
- Geometry reads synchronously settle dirty layout.
- Native region growth tracks commit activity and is nearly flat during near-idle windows.
- PartitionAlloc can retain capacity and VM-region high water without detached DOM ownership.

### Not measured

- Exact byte percentages among `StringImpl`, glyph arrays, inline-layout auxiliaries, display items, and paint-op buffers.
- The number of nested `BoundedMarkdown` commits per parent `App` commit in the live run.
- Mounted DOM counts and exact browser geometry during the clean run, because Phase 4 forbids a diagnostic bridge for them.
- A symbolicated terminal allocation stack for the clean run.

Those unknowns limit byte-level attribution. They do not undermine the replace-all layout-churn mechanism, which is supported independently by application source, React's installed commit path, Chromium's invalidation path, the memory compartment split, and the commit-to-region trajectory.

## Source anchors

Repository source:

- `app/renderer/src/App.tsx:612-619` — app-level render-commit counter and delivery acknowledgement.
- `app/renderer/src/App.tsx:4279-4299` — pane bottom-lock ownership.
- `app/renderer/src/App.tsx:4371-4382` — content-signature bottom following.
- `app/renderer/src/BoundedMarkdown.tsx:40-51` — Markdown plan recomputation from complete current source.
- `app/renderer/src/BoundedMarkdown.tsx:76-79` — selected mounted units.
- `app/renderer/src/BoundedMarkdown.tsx:85-128` — real-geometry window selection.
- `app/renderer/src/BoundedMarkdown.tsx:130-153` — post-commit rectangle read and height correction.
- `app/renderer/src/BoundedMarkdown.tsx:155-208` — measured-height observer and pruning.
- `app/renderer/src/BoundedMarkdown.tsx:210-256` — final bounded DOM map.
- `app/renderer/src/markdownRenderPlan.ts:193-235` — open-fence prefix reuse and plain-text tail.
- `app/renderer/src/markdownRenderPlan.ts:356-392` — bounded leaf-window selection.
- `app/renderer/src/markdownRenderPlan.ts:400-448` — mounted HAST folding and JSX conversion.
- `app/renderer/src/markdownRenderPlan.ts:501-629` — line, character, child, and element leaf bounds.
- `app/renderer/src/markdownRenderPlan.ts:632-670` — settled code-card planning.
- `app/renderer/src/markdownScrollCoordinator.ts:113-180` — frame batching and self-scroll suppression.
- `app/renderer/src/TranscriptView.tsx:895-978` — assistant Markdown integration and open streaming caret.
- `app/renderer/src/TranscriptView.tsx:1331-1372` — settled code-card DOM.
- `app/node_modules/react-dom/cjs/react-dom-client.development.js:22174-22175` — whole-value `nodeValue` assignment.
- `app/scripts/rendererMemoryTrajectory.ts` — vmmap parsing and trajectory analysis contract.

Upstream Chromium 130.0.6723.191, revision `b872957737636278e1da4818e40a40c66b72a2b0`:

- `third_party/blink/renderer/core/dom/character_data.cc` — whole-value `CharacterData` replacement.
- `third_party/blink/renderer/core/layout/layout_text.cc` — replace-all layout invalidation.
- `third_party/blink/renderer/core/layout/inline/inline_node.cc` — inline recollection and full-context shaping.
- `third_party/blink/renderer/core/dom/element.cc` — bounding-rectangle binding path.
- `third_party/blink/renderer/core/dom/document.cc` — style and layout update path.
- `third_party/blink/renderer/platform/wtf/text/string_impl.cc` — native immutable string allocation.
- `third_party/blink/renderer/platform/wtf/allocator/partitions.cc` — Blink buffer PartitionAlloc root.
- `third_party/blink/renderer/platform/fonts/shaping/shape_result.h` — shaping ownership.
- `base/allocator/partition_allocator/PartitionAlloc.md` — superpage and slot-span retention model.
- `base/allocator/partition_allocator/src/partition_alloc/partition_page.cc` — empty-span and direct-map behavior.
- `base/allocator/partition_allocator/src/partition_alloc/page_allocator_internals_posix.h` — macOS discard and decommit behavior.
- `third_party/blink/renderer/core/resize_observer/resize_observer.cc` — current-target observer lifecycle.
