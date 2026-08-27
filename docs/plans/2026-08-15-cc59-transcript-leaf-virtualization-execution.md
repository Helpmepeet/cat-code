# CC-59: Evidence-Gated Transcript Leaf Virtualization

**Model: ANY · Difficulty: 9/10 · 🖐 GUI**

## Objective

Repair and complete the Stage-One transcript leaf virtualization introduced by
`7115ff71` and `45f3b3f0` without replacing one unbounded renderer with another.
The work owns the eleven validated findings `711-F1` through `711-F6` and
`45-F1` through `45-F5`, plus the governing design's Stage-One requirement to
bound nested transcripts, grouped tool members, delegate members, tool-output
families, and diff bodies.

The governing design is
`docs/plans/2026-08-14-desktop-transcript-virtualization-design.md`. This plan
narrows that design into evidence gates. It deliberately does not prescribe an
unverified Markdown-to-React or incremental-highlighting API.

## Hard constraints

1. Preserve complete authoritative Markdown and tool output in JavaScript state.
2. Bound mounted Markdown leaves and every semantic parent's mounted children,
   including nested transcripts, grouped tool/delegate members, every routed
   tool-output family, and both transcript and inspector diffs.
3. Preserve the existing native pane scroller. Do not add a transcript scroller.
4. Preserve GFM tables, ordered and nested lists, blockquotes, references, task
   lists, links, path-aware clicks, quote copy, code themes, full-source copy,
   search, wrap behavior, and raw-HTML-disabled security.
5. Do not parse semantic Markdown with handwritten regular expressions.
6. Do not claim that independently parsed Markdown source fragments retain
   document context unless an executable fixture proves it.
7. Do not claim `rehype-highlight` supports line-window tokenization unless an
   executable probe against the installed API proves it.
8. Do not claim server-side rendering tests exercise effects, callback refs,
   `ResizeObserver`, scrolling, or keyed DOM replacement.
9. No new dependency or inline-style exception is authorized by this document.
   Stop and request the exact approval after proving why it is necessary.
10. No protocol, preload, host API, sidecar, or security-boundary change is in
    scope. If a proposed diagnostic requires one, stop and report the need.
11. Do not launch or drive the desktop GUI. The operator owns all GUI and live
    memory checks.
12. Work on `migration`; preserve concurrent work and stage only explicit paths.
13. One pane-local coordinator owns scroller observation, scroll correction,
    animation-frame measurement batching, and attachment lifetime. Per-body
    virtualizers register with it; they do not each attach listeners to the pane
    scroller.

## Findings owned

| ID | Required outcome |
|---|---|
| `711-F1` | An open streaming fence retains its final line and renders plainly. |
| `711-F2` | A large fence remains one logical code card with one complete copy action and bounded mounted code children. |
| `711-F3` | No semantic child can create an unbounded wrapping text node; pathological content remains inside its semantic parent. |
| `711-F4` | Unwrapped output has exact fixed geometry; wrapped output uses measured variable-height geometry with correct search navigation. |
| `711-F5` | Scroll/root observers are not recreated for each streamed source update. |
| `711-F6` | Virtual boundaries preserve tables, lists, blockquotes, references, and accessibility semantics. |
| `45-F1` | Measurements are pruned when leaf IDs leave the active plan. |
| `45-F2` | Measured virtual geometry includes all spacing represented by the mounted leaf. |
| `45-F3` | A changed unmounted leaf cannot retain a stale measurement. |
| `45-F4` | Observer lifecycle has automated browser-level coverage; without it, CC-59 remains in progress. |
| `45-F5` | A keyed replacement DOM node is observed immediately even when the numeric window is unchanged. |

## Stage-One global acceptance

The task cannot close from the eleven local regressions alone. It must also
prove:

- expanded nested transcripts, grouped tool members, and delegate members have
  bounded mounted child counts;
- every routed tool output and both diff surfaces have row, character, and
  token-descendant ceilings;
- pane-level observer and listener counts remain bounded as transcript history
  grows;
- logical source completeness is independent from mounted DOM counts;
- the live memory trajectory and many-short-row decision gate pass.

## Phase 0: Establish ownership and baseline

Before changing production code:

1. Re-read `docs/migration/STATUS.md` immediately before writing it. Insert a new
   first row in the cross-cutting table:
   `CC-59 · Stage-One transcript leaf virtualization remediation`, status
   `🟡 IN PROGRESS`, with this plan as its contract. Edit no other row.
2. Record `git status --short --branch`. Treat every unrelated dirty or untracked
   path as another session's work.
3. Run the current focused suites:

   ```bash
   bun test app/renderer/src/markdownRenderPlan.test.ts \
     app/renderer/src/lineWindow.test.ts \
     app/renderer/src/BoundedMarkdown.test.tsx \
     app/renderer/src/TranscriptView.test.tsx
   ```

4. Inspect `app/package.json` and `app/bun.lock`; identify which parser,
   MDAST-to-renderer, highlighter, and DOM-test packages are direct dependencies
   versus transitive implementation details.
5. Load the repository's `writing-cat-code-tests` skill before modifying tests.

Do not proceed past Phase 0 if the relevant production files are concurrently
modified by another session. Report the overlap instead of overwriting it.

## Phase 1: Add failing regression fixtures without choosing architecture

Add the smallest tests or executable probes that demonstrate the actual
contracts. These are architecture-neutral acceptance fixtures.

### Markdown fixtures

Prove the current failure for:

- an unclosed fence whose final line has no trailing newline;
- a multiline block containing a line over 12,000 characters;
- a fence over 400 lines that must remain one logical card;
- a GFM table whose body crosses the current line and character limits;
- an ordered list that crosses a virtual boundary;
- a nested task list;
- a blockquote with multiple child blocks and its existing copy behavior;
- a reference link whose definition is outside the mounted child;
- inline links and path-aware controls inside table cells and list items.
- an expanded agent transcript containing thousands of child rows;
- a grouped tool run and delegate group containing thousands of members;
- large file-read, file-write, grep, image-result, transcript-diff, and
  inspector-diff bodies.

Compare semantic output, not snapshots alone. Assert logical table/list/
blockquote row or item counts in retained data separately from mounted DOM
counts. At first, middle, and final virtual windows, assert valid table/list/
blockquote roles, ordered-list numbering, nested task relationships, link
destinations, complete copy source, and fixed mounted-child bounds. Traverse
all windows or inspect retained data to prove complete logical coverage without
requiring all children to coexist in the DOM.

### Line-window fixtures

Prove:

- exact 20 px fixed geometry in unwrapped mode;
- a wrapped logical line can have a measured height greater than 20 px;
- prefix offsets and range lookup after measurements;
- width revision invalidation;
- estimate-scroll followed by measured centering of an active search match;
- no more than `MAX_MOUNTED_OUTPUT_LINES` mounted logical rows.
- a multi-megabyte single logical line in inline output and the inspector;
- a repetitive one-character search whose logical matches would otherwise
  create an unbounded React segment array;
- windows and active-match navigation immediately before and after the
  interstitial reveal band.

Require separate fixed budgets for mounted logical rows, characters in one
mounted visual chunk, and search-highlight/token descendants. Full search,
copy, and logical line numbering remain model-backed and complete.

### Measurement fixtures

At the pure-model layer prove:

- pruning removed IDs;
- invalidating a measurement when content or width revision changes;
- preserving measurements for unchanged IDs and revisions;
- replacing an estimate with a measured height;
- stable top and bottom spacer sums.

Keep the browser lifecycle expectation separate. A pure model cannot prove
callback-ref or observer attachment.

## Gate A: Prove a context-preserving Markdown render seam

Run a focused implementation spike before rewriting `BoundedMarkdown`.

The spike must answer this question with executable evidence:

> How can one parsed Markdown document render only a bounded semantic child range
> while preserving the existing React component overrides and document context?

The proof must cover a table, nested ordered/task list, blockquote, reference
link, ordinary link, and path-aware inline element. It must preserve valid and
accessible HTML.

Acceptable outcomes:

1. A supported installed API can render positioned AST/HAST subtrees through the
   current component behavior, demonstrated by tests; or
2. Additional direct packages are required. Name the exact packages and APIs,
   show the minimal proof using the already installed transitive copy only for
   investigation, then stop for dependency authorization; or
3. No viable bounded semantic renderer was established. Stop and report the
   blocker. Do not fall back to isolated source-slice parsing or a custom regex
   parser.

Do not add production dependencies during the spike.

## Gate B: Prove bounded token and pathological-text seams

Inspect the installed highlighting implementation and prove a real API before
changing code-card rendering.

The proof must establish:

- one logical code card and one full-source copy action;
- open streaming code rendered as plain text;
- settled code producing the existing `hljs-*` theme classes;
- no more than the fixed mounted line/token-child budget;
- behavior when a multiline comment, string, or template begins before the
  mounted chunk;
- a documented and tested chunk-boundary policy.
- a fixed character ceiling for one mounted code or output chunk;
- a fixed rendered-token or search-segment ceiling;
- complete model-backed search and copy when only one bounded part of a
  pathological logical line is mounted.

If the current `rehype-highlight` API cannot provide this, do not describe it as
if it can. Identify the smallest direct tokenizer dependency or bounded
fallback, demonstrate it with a focused probe, and stop for authorization.

The text proof must include a multi-megabyte single line and a repetitive
one-character search query. Counting one logical row as bounded is not
sufficient evidence.

## Gate C: Establish automated observer-lifecycle coverage

Find the lowest existing automated layer capable of mounting React DOM and
running callback refs, effects, `ResizeObserver`, keyed replacement, and
unmount cleanup.

The proof must:

- replace a mounted leaf key while keeping the numeric window unchanged, then
  assert that the old node is unobserved and the replacement is observed;
- stream repeated source revisions and assert that root/scroller listener and
  observer identities remain stable;
- grow transcript history with many Markdown bodies and assert pane-level
  listener and observer attachment counts remain fixed;
- exercise a measured height correction above the visible anchor and assert
  the pane preserves that anchor or its bottom lock.

Acceptable outcomes:

1. Add the test to an existing DOM/Electron harness with no new dependency; or
2. Demonstrate that no such harness exists, identify the smallest DOM-test
   dependency and exact test setup, then stop for authorization; or
3. Demonstrate that no existing harness can prove the lifecycle and stop for
   authorization to add the smallest DOM-test dependency.

Operator eyeballing is not automated coverage and cannot silently close
`45-F4`.

## Gate D: Architecture decision

Proceed only when Gates A, B, and C each have a proven implementation path.
Fill the Gate D decision record with the selected supported APIs, direct
dependencies, proofs, and residual limits. Do not continue from aspirational
prose or an unresolved test waiver.

### Gate D decision record

Before Phase 2, fill this section with evidence-backed decisions:

| Decision | Selected API/mechanism | Executable proof | Direct dependency or approval | Residual limitation |
|---|---|---|---|---|
| Context-preserving Markdown renderer | pending | pending | pending | pending |
| Bounded code highlighter | pending | pending | pending | pending |
| Pathological output/search renderer | pending | pending | pending | pending |
| Browser DOM lifecycle harness | pending | pending | pending | pending |
| Dynamic spacer geometry | pending | pending | pending | pending |
| Pane-local coordinator integration | pending | pending | pending | pending |

Any dependency authorization must name exact packages. After authorization,
add them to `app/package.json`, run `bun install` from `app/`, and inspect
`app/bun.lock` so unrelated pins do not move.

Any dynamic spacer style exception must be explicitly authorized and limited to
numeric virtualizer geometry. It does not authorize arbitrary inline styling.

## Phase 2: Implement measurement coordination

After Gate C:

1. Add adjacent `.ts` measurement modules containing only pure state and range
   logic. Measurements are qualified by stable leaf ID, monotonic content
   revision, and width revision.
2. Add one pane-local coordinator that owns the pane scroller listener,
   scroller/root observation, animation-frame batch, visible anchor, bottom
   lock, and measurement correction. Markdown bodies register and unregister
   leaves with it. They do not each observe the pane scroller.
3. Keep per-body height data instance-scoped under the pane coordinator. Do not
   use a process-global cache.
4. Prune IDs absent from the current plan.
5. Invalidate stale content or width revisions without deleting unchanged
   measurements.
6. Register mounted elements through callback refs so keyed replacements attach
   immediately.
7. Keep pane listener attachment independent of streamed leaf-array identity
   and transcript-history length.
8. Batch streamed plan commits and observer updates to at most one commit per
   animation frame.
9. Put all spacing inside the measured wrapper or otherwise include it in the
   measured virtual height.
10. Apply every measurement correction through the pane's anchor algorithm.
    Bottom lock wins when active; otherwise only changes before the visible
    anchor adjust scroll position.

Focused tests must cover all pure transitions and Gate C's real DOM lifecycle.

## Phase 3: Implement line virtualization

1. Preserve the fixed 20 px path for unwrapped output and enforce matching CSS.
2. Add a variable-height prefix index for wrapped output, keyed by logical line
   index and width revision.
3. Bound mounted rows in both modes.
4. Search navigation estimate-scrolls to mount the target, measures it, then
   applies one centering correction.
5. A wrap toggle or width change invalidates wrapped measurements.
6. Represent reveal bands and other interstitial chrome as explicit measured or
   fixed-height prefix entries. They are outside logical row measurement but
   inside total virtual geometry and active-match offsets.
7. Bound characters and highlighted/search segments in one mounted visual
   chunk, including a giant logical line.
8. Preserve full source for search and copy.

Apply and test the line virtualizer across this explicit consumer matrix:

- Bash and plain inline output;
- numbered file reads and source highlighting;
- file-write additions;
- grouped grep/search output;
- image-result text;
- transcript diffs;
- inspector output and inspector diffs.

For each family, test a large multiline body and a giant single line. Assert
fixed mounted row, character, and token-descendant bounds.

Run the focused line-model, `VirtualLineList`, `ToolInspector`, and transcript
output tests before integration.

## Phase 4: Implement semantic Markdown leaves

Use only the APIs proven at Gates A and B.

1. Parse the complete source into positioned semantic blocks before React DOM
   construction.
2. Cache only unchanged completed blocks by stable source identity. Keep the
   mutable tail separate, prune obsolete cache entries, and perform a complete
   settlement reparse.
3. Stable React keys derive from source identity and semantic kind. Content and
   width revisions are separate and never part of the key.
4. Preserve one semantic parent while bounding its mounted children:
   - table header plus bounded body rows and semantically valid spacers;
   - list wrapper plus bounded items with correct ordered numbering and nesting;
   - blockquote wrapper plus bounded child blocks and existing copy behavior;
   - one code card plus bounded code children and complete raw copy;
   - pathological inline content kept inside its parent;
   - top-level pathological atomic prose rendered through the disclosed bounded
     viewer with full-source copy.
5. Keep every mounted semantic child under both line and character ceilings.
6. Preserve raw HTML being disabled and existing URL/path handling.
7. Preserve current user-visible chrome. No new engineering notes appear in JSX
   or accessibility text.
8. In the real DOM harness selected by Gate C, render first, middle, and final
   windows for tables, lists, and blockquotes. Assert valid semantic structure,
   correct numbering and relationships, fixed mounted bounds, and complete
   logical coverage in retained data.

Do not expose mounted-count diagnostics through `aria-label` or
`aria-description`. If a live numeric counter is required, use an existing
private debug mechanism proven during Gate D or keep the assertion in automated
fixtures. A new bridge/schema requires a separate approved scope.

## Phase 5: Integrate all Stage-One composite surfaces

1. Route assistant, thinking, and reasoning prose through the same proven
   semantic renderer.
2. Add recursive bounded rendering for expanded nested agent transcripts.
3. Bound grouped tool-run and delegate-group member collections while
   preserving their existing group chrome and stable member identities.
4. Route every tool-output and diff consumer in the Phase 3 matrix through its
   proven bounded renderer.
5. Pass explicit streaming/settled state so the planner can perform the final
   complete reparse.
6. Preserve streaming caret, assistant copy chip, reasoning collapse state,
   blockquote copy, code themes, and render-error fallback.
7. Preserve tool-card expansion, progressive reveal extent, reasoning
   hide/show, and nested transcript interaction state across unmount/remount.
8. Confirm unknown display variants still degrade gracefully.
9. Confirm no protocol, preload, main, host, sidecar, or shared security file
   changed.

Add stress fixtures for thousands of nested rows, grouped tool members, and
delegate members. A fixed viewport must retain fixed mounted descendant and
pane-level observer/listener counts as each source grows 10x.

## Phase 6: Headless verification

Run focused suites first, then the complete desktop battery:

```bash
bun test app/renderer/src/markdownRenderPlan.test.ts \
  app/renderer/src/markdownMeasurementCoordinator.test.ts \
  app/renderer/src/lineWindow.test.ts \
  app/renderer/src/BoundedMarkdown.test.tsx \
  app/renderer/src/TranscriptView.test.tsx

bun test app/
bun run --cwd app typecheck
bun run --cwd app typecheck:sidecar
bun run --cwd app test:hardening
bun run --cwd app renderer:build
```

Run `git diff --check` and an exhaustive stale-reference search across source,
tests, imports, configuration, and docs. Classify shared-tree failures against
the dirty baseline before changing any failing file.

## Phase 7: Operator verification and live memory gate

Read `docs/migration/process/GUI-VERIFICATION.md`. Do not launch the app. Print
operator steps using:

```bash
cd /Users/pt/cat-code && \
CATCODE_TEST_CWD_ALLOWLIST=/Users/pt/cat-code \
CATCODE_INITIAL_CWD=/Users/pt/cat-code \
CATCODE_DEBUG_STATE=1 \
bun run --cwd app dev
```

The operator verifies:

- an open streaming fence never loses its final line;
- a 400-line code block remains one card and copies all source;
- a large table and nested ordered/task list retain semantics;
- blockquote copy and path-aware links still work;
- wrapped inspector output has no blank ranges and search centers later matches;
- reading older content while streaming does not move the viewport;
- replacement leaves converge without spacer jumps.

The operator runs the established workloads at fresh launch, five minutes, ten
minutes, fifteen minutes, and settled turn completion. At every sample record
renderer footprint, PartitionAlloc resident and dirty bytes, V8 resident bytes,
region count, mounted outer/Markdown/line descendants, render-commit latency,
visible-anchor error, and bottom gap.

Blocking acceptance criteria:

- one long streaming turn: renderer footprint below 750 MB;
- two-session reproduction: footprint below 1.0 GB, PartitionAlloc dirty below
  700 MB, fewer than 3,000 regions;
- three panes: footprint below 1.5 GB and post-warm-up slope below 5 MB/minute;
- no accelerating curve after the first five minutes and less than 5% region
  growth during the final five minutes;
- fixed viewport under 10x source growth: mounted transcript DOM increases by
  no more than 15%;
- no more than 12,000 transcript descendants per pane or 36,000 across three
  panes;
- settled anchor error no more than 2 px, cumulative error no more than 4 px
  over 100 streamed/resized/expanded updates, and bottom gap no more than 2 px;
- no transcript-induced main-thread task over 100 ms and p95 streaming render
  commit below 50 ms;
- tool expansion, reveal extent, reasoning state, nested state, search, and
  complete copy survive scroll-out and remount.

Run a separate three-pane workload where transcript history grows 10x through
many short rows, not one growing response. If memory, region count, mounted DOM,
or pane-level attachment counts do not flatten, Stage Two outer transcript
virtualization is required. Record that decision explicitly; do not declare
Stage One sufficient from the long-response workload.

Any failed or unobserved live criterion is blocking. Mark it `UNVERIFIED`, keep
`CC-59` in progress, and do not claim Stage-One acceptance. Headless code may be
reported as complete without converting the task to complete.

## Phase 8: Closeout

Immediately before editing `docs/migration/STATUS.md`, reread its cross-cutting
table. Update only `CC-59` with:

- exact focused and full battery outcomes;
- which gates selected which APIs and dependencies;
- evidence that `45-F4` has automated browser-level coverage;
- live GUI and memory status;
- the measured decision on whether Stage Two outer virtualization is required;
- every parity adaptation or unresolved item.

Set `CC-59` to complete only when all headless, GUI, memory, trajectory, semantic,
descendant-bound, and many-short-row gates pass. Otherwise leave it in progress
with the exact blocking evidence.

Commit only explicit CC-59 paths according to the repository's shared-tree git
rules. Do not write `DONE.md` without operator approval.
