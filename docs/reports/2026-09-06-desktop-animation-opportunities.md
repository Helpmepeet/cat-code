# Desktop animation opportunities

Original report date: 2026-09-06

Source review: 2026-09-10

Status: Source review and coverage reconciliation complete. Runtime visual acceptance remains operator-only.

## Recommendation

Use motion to explain an opening surface or acknowledge a discrete, confirmed event. Preserve the renderer's existing delivery and activity cues. Keep reading, editing, permissions, navigation targets, and measured transcript geometry stable.

The strongest new opportunities are consistent menu entrances, the command palette and plan overlay, the full-output inspector, and modest acknowledgment of accepted queue items or prepared attachments. Existing dialogs, toasts, sidebar transitions, prose arrival, worker indicators, and compaction already have motion. They need selective refinement, not another decorative layer. Reduced-motion coverage should extend beyond named CSS animations before the motion vocabulary grows.

This is a design report, not an implementation plan, approval to change behavior, or a claim that unanimated UI is defective. Recommendations are design judgments grounded in current source. No application code or HTML specimen was modified, and no desktop GUI was launched or operated.

## Evidence and coverage boundary

The review followed `docs/maps/web-app-runtime.md`, then inspected the current owners under `app/renderer/src/`. Source wins over comments, dated reports, historical validation records, and design specimens. The prior draft's second-hand findings were rechecked directly; its incomplete coverage statements and stale roster ownership are superseded here.

This is a dated source review, not a permanent assertion about future revisions. Current source wins if a later renderer change affects a cited owner or shared motion mechanism.

The inventory contains **64 production TSX files**, including providers, in-app previews, and the entrypoint. All appear in the ledger below. The broader motion discovery scanned **192 non-test-named text candidates: 64 TSX, 127 TypeScript, and one CSS file**. That candidate count is not a production-module count: test harnesses, fixture helpers, type declarations, and development-only diagnostics were distinguished from runtime motion owners. Test files, generated output, the terminal renderer, Electron main/preload behavior, and external prototype projects are outside the production renderer boundary. Static image/font assets are not additional animation owners.

Discovery covered animation classes and keyframes; transition properties, delays, transforms and visibility changes; timers; animation-frame scheduling; scroll APIs and direct scroll writes; DOM-created controls; preference providers; and overlay lifecycle helpers. Directly relevant call sites, conditions, shared styles, and helper bodies were read. A keyword match alone was not treated as a visual effect: frame batching, focus placement, scroll correction, and timeout handling have different purposes.

### Inspection depth and the follow-up review

Coverage means every production TSX owner was reconciled and its motion-relevant rendering and lifecycle were inspected. It does **not** mean every line of all 192 candidate files was read. The initial standalone report inspected relevant source across the 64 TSX owners, screened supporting TypeScript for motion mechanisms, and read only the five specimens' titles. The follow-up read the specimens in full and deepened the lifecycle paths below.

| Area | Follow-up inspection | Remaining boundary |
|---|---|---|
| Transcript measurement | Full `BoundedMarkdown.tsx`, `VirtualLineList.tsx`, and `transcriptScrollMemory.ts`; `TranscriptView.tsx` / `BoundedChildList`; coordinator correction and observer paths | Runtime layout, frame timing, and viewport drift remain unobserved. |
| Prose freshness | `AssistantProse`, its row caller and leaf renderer; full `proseArrivalMark.ts`, `ProseArrivalPreview.tsx`, and `proseArrivalPreviewModel.ts`; streaming-row creation/finalization in `transcriptProjector.ts` | The full projector/reducer was not read line by line. Streaming pane and leaf remounts were not operated. |
| Overlay lifecycle | Full `overlayFocus.ts` and `composerPopover.ts`; live inspector selection and overlay composition in `TranscriptRowsView` | Source checks do not establish painted focus visibility or actual screen-reader behavior. |
| Navigation geometry | Full `WorkspacePanels.tsx`; sidebar hover, focus handoff, footer and resize paths; pane bind, bottom-follow, Latest and capture-cleanup paths | Other application business logic was inspected only where it affected these decisions. |
| Historical exploration | All five listed HTML files, including CSS, markup, and playback JavaScript | No specimen was executed or visually rated; none establishes an approved production requirement. |

Pure data/formatting branches without a motion connection, test bodies, generated assets, native desktop behavior, and unrelated application logic are not claimed as exhaustive line-by-line reads. This is a complete motion-surface ledger with explicitly bounded source inspection, not a whole-application correctness audit.

All owner paths are repository-relative. In the two coverage ledgers, filenames resolve under `app/renderer/src/`. Symbols identify the relevant behavior without fragile cross-file line-number citations.

### Reading the decisions

| Label | Meaning |
|---|---|
| **Existing / preserve** | Source contains the behavior; retain its useful purpose. |
| **Refinement** | Change or constrain an existing effect, subject to later approval and runtime validation. |
| **New opportunity** | Source exposes a suitable surface or event but does not currently declare the proposed effect there. |
| **Intentional no motion** | Keep state changes direct; do not introduce a decorative transition. Existing local control feedback may remain where explicitly noted. |

“No entrance” below means no explicit entrance found on the inspected owner or its shared motion class. It does not claim to measure perceived abruptness. Source establishes declarations and control flow, not frame rate, compositing, visual quality, live focus visibility, or assistive-technology behavior.

## Motion principles

- **State is immediate; decoration follows.** Do not defer input, action availability, focus, accessible state, dismissal, or confirmed results to animation completion.
- **Animate semantic events, not mounts.** A newly accepted queue item is different from a restored item, a re-render, a virtualized remount, or a refreshed snapshot. If freshness cannot be established, leave it static.
- **Keep targets stable.** Do not move a focused control, permission choice, Stop button, caret, drag target, or measured transcript body. Focused controls should reach a fully visible state immediately.
- **Protect measurement coordinates as well as layout.** A transform can change the rectangles used for windowing and scroll anchors even when it does not change normal-flow dimensions. Keep measured transcript roots, row wrappers, and their scrolling ancestors free of entrance transforms.
- **Do not queue effects.** Rapid interactions should resolve to the newest state. No obsolete fades or retained invisible interactive layers.
- **Prefer entrance-only opportunities.** Current conditional rendering commonly removes surfaces directly. An exit is not a free styling change: retained presence would alter lifecycle and interaction. This report does not recommend delayed dismissal.
- **Reduced motion resolves to the final state.** Proposed transforms, layout interpolation, staggers, loops, and smooth scrolling should stop. Necessary geometry correction, focus scheduling, data delivery, and real status updates must continue.
- **Use one local activity signal where practical.** Do not stack a new pip onto an already breathing worker face, pulse whole cards, or turn persistent configuration into apparent activity. Existing background-attention signals have a separate purpose from running-work signals.
- **Keep blur and material stable.** A scrim's color/opacity may fade; native glass, backdrop blur radius, theme, and syntax palette should not tween.

### A restrained vocabulary

These are optional design targets, not measured runtime timings, required replacements for existing constants, or a mandate to add every pattern.

| Pattern | Suggested treatment | Design target |
|---|---|---|
| Ordinary control feedback | Color or border feedback without moving the target | 80–120 ms |
| Anchored popover | Panel opacity; optional travel of about 3 px toward its actual anchor | 100–130 ms |
| Centered dialog | Panel opacity; optional scale from .98; independent color scrim fade | Panel 140–180 ms; scrim 100–130 ms |
| Right inspector | Panel opacity; optional 8 px travel from the right | 160–200 ms |
| Accepted item | Local opacity only around an already established layout | 120–160 ms |
| Explicit workflow step | New body opacity inside a stable shell | 100–140 ms |

Favor gentle deceleration, no overshoot. No bounce, elastic spring, confetti, looping decoration, title/footer cascades, or per-choice stagger. No animation library or new preference interface is proposed.

## Existing motion inventory

`app/renderer/src/theme.css` is the shared motion stylesheet and imports Tailwind. Its renderer-owned declarations and the literal utility consumers below establish the current vocabulary. Tailwind utility timings are not inferred from historical documentation or uninspected generated CSS.

| Existing mechanism | Current source behavior and real consumers | Design disposition |
|---|---|---|
| `prose-arrive-smooth`, `prose-arrive-flowing` | `catcode-prose-arrive` changes opacity from 0 to 1: 220 ms smooth, 160 ms flowing, linear, with `both` fill. `TranscriptView.tsx` / `AssistantProse` and `ProseArrivalPreview.tsx` apply the marking path. | **Preserve** the existing preference and source-offset marking; no second message/paragraph entrance. |
| `animate-toast-in` | `catcode-toast-in`: opacity plus 6 px upward settlement over 180 ms. Used by `ToastHost.tsx`, `AccountsPage.tsx` / `ALDialog`, `TasksDialog.tsx`, `AgentsPage.tsx` / `AgentInspectDrawer`, and `MetadataInspector.tsx`. | **Preserve** toast entrance. Dialog and drawer consistency are **refinements**, not missing effects. |
| `animate-sa-pop` | `catcode-sa-pop`: opacity plus scale .97 and translateY(-3 px) to rest over 130 ms. Used by `SAModal.tsx`, `SessionActionsMenu.tsx`, `FilePathActionsMenu.tsx`, and the project menu in `Sidebar.tsx`. | **Preserve** the baseline. Refine placement-specific direction only where useful; do not layer another entrance over it. |
| `animate-token-warn-in` | `ComposerActionsBar.tsx` / `TokenWarningChip` uses an opacity/scale .8 entrance over 180 ms. The accompanying warning popover has no corresponding explicit entrance. | **Preserve** the discrete warning cue; no repeating alert or extra gauge pulse. |
| `animate-face-pulse` | `AgentChrome.tsx` / `AgentFace` conditionally applies a 1.4 s opacity breath. `TranscriptView.tsx` supplies `pulse` through `agentIdentity.ts` / `agentFacePulse`: running state only, excluding launch records. Delegate-group faces use the same gate. | **Preserve** this deliberate existing face cue. Do not add a competing status pulse to the same card. |
| `animate-compact-ingest`, `animate-compact-absorb` | `SessionPane.tsx` / `CompactingGlyph` uses traveling marks and a scaling receiver in a fixed 30 px slot; both cycle over 1.5 s. | **Preserve** the specific compaction explanation; do not expand it into moving transcript content. |
| `animate-compact-star`, `animate-compact-sweep-left`, `animate-compact-sweep-right` | `TranscriptView.tsx` / `CompactingSeam` renders a 2.4 s rotating/scaling glyph with 1.5 s opposing hairline sweeps. The sweeps animate `left`/`right`, not solely transforms. | **Preserve** the bounded live seam and immediate handoff to `CompactBoundarySeam`. No completion flourish; performance is unmeasured. |
| `animate-pulse` | Consumers include worker pips (`AgentChrome.tsx`, `WorkerRoster.tsx`), active todo step (`TodoPlanPanel.tsx`), transcript tool/skeleton states (`TranscriptView.tsx`), activity/Latest status (`SessionPane.tsx`), account-health indicators (`AccountsPage.tsx`), and `App.tsx` / `TasksStrip`. | **Preserve selectively** according to meaning. Persistent account trouble and waiting states are not all evidence of ongoing work. |
| `animate-ping` | `TabBar.tsx` / `AttentionBadge` signals a permission waiting in a background session. `StatusDot` itself is static. | **Preserve** its attention function; do not describe it as a running indicator or add a second tab pulse. |
| `animate-spin` | Waiting/loading markers in `StartupSurfaces.tsx`, `AccountsPage.tsx`, `AccountsUsageCharts.tsx`, and `TasksDialog.tsx`. | **Preserve** truthful pending cues with adjacent status. No fake percentage or extra dwell. |
| Sidebar transitions | `Sidebar.tsx`: 200 ms width/shadow transition, 300 ms footer grid/opacity transition, 200 ms navigation-item transforms/opacity with entrance delays, rotating footer affordance, and action-reveal feedback. Pointer resizing adds `transition-none`. | **Refine** delays and reduced-motion behavior. Do not add a second sidebar or route animation. |
| Other transition utilities | Toggle travel in `SettingsEditors.tsx` and `PermissionRulesEditor.tsx`; tab close width/opacity in `TabBar.tsx`; chart bars/hover marks in `AccountsUsageCharts.tsx`; disclosure chevrons and action reveals in `TranscriptView.tsx`; smaller color/opacity affordances throughout the renderer. `composerDom.ts` also creates a paste-pill close control with `transition-colors`. | **Preserve narrowly**, constrain `transition-all` where it could interpolate unrelated geometry, and snap focused/reduced-motion states. |

### Reduced motion: what is present and what is not

The media rule in `app/renderer/src/theme.css` names all **14 animation classes** identified in this source inventory, including the three Tailwind indicator classes and both prose classes, and applies `animation: none !important`. The compaction sweep classes also have off-track resting positions; ingest dots have an opacity-zero base, while the receiver, glyph, text, and base hairlines remain available. This establishes source-level fallback intent, not visual acceptance.

The rule does **not** neutralize ordinary CSS transitions or their delays. Sidebar width/footer movement, tab close expansion, toggle travel, chart transitions, and hover/focus fades are outside that animation-only rule. No renderer-side reduced-motion branch was found for `SessionPane.tsx` / `jumpToBottom`, which explicitly calls `scrollTo` with `behavior: 'smooth'`. `ProseArrivalPreview.tsx` also continues its interval-driven sample replacement/reset cycle irrespective of that CSS rule.

**Refinement:** extend the final-state policy to these mechanisms before broadening motion. Explicit Latest navigation may remain smooth for ordinary motion, but should snap under reduced motion. The preview should show a settled sample under reduced motion instead of repeatedly replacing its content. A stylesheet-only adjustment cannot by itself stop those JavaScript behaviors. Necessary animation-frame scheduling for focus, measurement, and scroll anchors is not decoration and should not be disabled.

`docs/migration/backlog/phase4.md` / P4-52 and `docs/migration/STATUS.md` record the earlier stylesheet-only work. Their historical six-class inventory and historical passing tests do not describe the entire current surface or establish current end-to-end accessibility. This report makes no compliance certification.

## Design decisions by surface

### 1. Menus, suggestions, and readout popovers

**Existing:** `ComposerActionsBar.tsx` uses `POPOVER_PANEL` / `POPOVER_PANEL_RIGHT` for model, effort, account, and usage surfaces without an explicit panel entrance. The same is true of the permission-mode menu, mention/slash panels, account-row menu, sessions sort/tag panels, welcome project picker, and composer paste preview in their respective ledger owners. `WorkerRoster.tsx` reveals its multi-worker popover through CSS hover/focus display classes; `TodoPlanPanel.tsx` / `TodoStepReadout` uses a similar readout reveal. These are different lifecycle mechanisms from a newly mounted modal.

**New opportunity:** a single short panel entrance can clarify the anchor. Open upward from composer controls and downward from below-trigger menus only when actual placement agrees. The welcome picker is eligible; the entire welcome page and its cat artwork are not. Roster and todo readouts are lower-value candidates: retain the current plain reveal if a fade makes keyboard content less immediately visible. Paste preview may receive opacity only, preserving its existing pointer-travel grace logic.

Keep query results, option selection, previews, counts, and active-row scrolling immediate. Do not reanimate on filtering or snapshot refresh. Do not stagger worker/todo/menu rows. `MentionPicker.tsx`, `SlashCommandPicker.tsx`, `CommandPalette.tsx`, `AskQuestionFlow.tsx`, and `TasksDialog.tsx` use nearest-row scrolling without an explicit smooth request; retain that distinction from Latest.

**Refinement:** session-action and file-path menus already pop. Their flyouts could use a small horizontal reveal matching placement. `SessionActionsMenu.tsx` positions the copy flyout at `left-full`; `FilePathActionsMenu.tsx` supports `flipLeft`. Do not invent left-flip behavior for the former. Preserve `composerPopover.ts` / `overlayFocus.ts` focus and dismissal ownership; animation must not become a prerequisite for interaction.

The focus helpers schedule initial focus on an animation frame and restore it through stack cleanup and explicit close paths. They do not wait for a CSS effect to finish. `overlayFocus.ts` / `isFocusableElement` filters tab index, disabled, hidden, inert, and aria-hidden attributes; it does not inspect computed opacity, CSS visibility, or painted rectangles. Therefore a fade is not evidence that its invisible controls are excluded from interaction. Preserve actual visibility/inert/unmount ownership, make the focus destination immediately readable, and do not retain an outgoing interactive body merely to finish a fade. This is a constraint on new motion, not a claim that the current helper has a demonstrated accessibility defect.

### 2. Dialogs and full-output inspectors

**New opportunity:** `CommandPalette.tsx` and `PlanPanel.tsx` have scrims and dialog bodies without explicit entrances. A single short panel entrance plus independent scrim color fade is reasonable. A newly available `PlanBar` may use opacity once, if it does not replay on restored plan data. Keep plan text, approval choices, revision input, and palette filtering still.

**Refinement:** `SAModal.tsx` already uses `animate-sa-pop`; `TasksDialog.tsx` and `AccountsPage.tsx` / `ALDialog` already use `animate-toast-in`. Treat a consistent centered-dialog treatment as optional harmonization, not three new animation features. No title, icon, or footer cascade; no second effect inside `ExportDialog` on initial open.

**Refinement:** `AgentsPage.tsx` / `AgentInspectDrawer` and `MetadataInspector.tsx` already rise using toast motion. A modest rightward-origin entrance better expresses their edge placement. **New opportunity:** the full-output drawer does not declare an entrance; its overlay owner is `TranscriptView.tsx` / `ToolInspectorOverlay`, while `ToolInspector.tsx` owns the output body. Put any proposed outer reveal in that conceptual boundary; do not animate its virtualized search, diff, or output rows. Switching the inspected row inside an open drawer should update directly. Immediate dismissal remains preferred.

`TranscriptRowsView` stores the inspected row's ID and re-derives its current contents with `findNestedToolUseRow`; late results update the existing drawer, and an absent row yields a null overlay. Those are data updates/removal, not fresh drawer openings. The inspector and file-path menu render inline as siblings of the transcript column, without a portal at this boundary. Keep the fixed overlay host and its ancestors static; if a later design explores travel, confine it to the visible panel. A transformed common ancestor could change fixed-position containing-block behavior. That is a structural risk inferred from this composition, not an observed clipping bug.

### 3. Accepted queue items, attachments, notices, and toasts

**Existing:** `SessionPane.tsx` renders queued items with stable queue IDs under one status region, with force-send/recall controls outside it. Prepared image/file previews are separate from the transcript; removal controls already reveal on hover/focus. `BannerStack.tsx` has notice IDs and status rows without a row entrance. `App.tsx` also renders local notices, including account-health/error surfaces. `SessionsPage.tsx` / `BulkBar` is a fixed overlay. `ToastHost.tsx` already animates each toast and owns expiry/dismissal timers.

**New opportunity:** a short opacity acknowledgment for a genuinely new accepted queue item or successfully prepared attachment. Establish final layout immediately and keep force-send, recall, remove, and composer targets still. Prefer opacity over the draft's traveling queue-item treatment. Do not imply successful preparation before it is confirmed. Do not animate a queued bubble flying into the transcript: those are separate state/render locations, and a transfer metaphor would overstate their continuity.

The bulk bar may enter once on the none-to-some selection boundary; counts then update directly. A genuinely new notice may use a local opacity entrance. Reappearing account-health information or changed detail text does not automatically constitute a new event. Do not animate banner height collapse, queue reorder, or composer resizing.

**Existing / preserve:** toast entrance, actual dismissal/expiry, and copy acknowledgments. No extra toast exit delay or stack-reordering animation is recommended. `PathCopyButton.tsx`, transcript copy controls, and `ToolInspector.tsx` already change copied feedback after clipboard completion; no celebratory bounce or redundant confirmation is needed.

### 4. Tasks, workers, todo, and attention

**Existing / preserve:** Tasks has a dialog entrance, task spinner, worker detail/lease panels, and nearest-row selection scrolling. Worker roster counts and promoted identity update from `workersState.ts`; todo markers/readout derive from `todoPlan.ts`; worker-face pulse gating is owned by `agentIdentity.ts`. Keep engine-derived status and Stop/background controls immediate. Do not stagger refreshed task/lease rows, animate live counts, or slide a worker detail body on every update.

Preserve the current running face breath in transcript cards. The general preference for one local cue does not justify replacing this established design with a new pip. Roster pips serve their own compact layout. Grouped faces may show several running members; whether that feels excessive is an operator judgment, not a source-proven performance or visual defect.

**Refinement candidate:** distinguish persistent trouble/waiting from active work. `AccountsPage.tsx` pulses quarantined/account-health states, and `SessionPane.tsx` pulses even when displaying “Waiting for approval.” Static text plus a steady status mark is a reasonable calmer direction for those persistent states. This is a design choice, not evidence that the existing status semantics are incorrect. Preserve TabBar's separate background-permission attention purpose; never use permission motion to suggest acceptance.

### 5. Transcript delivery, compaction, and reading

**Existing / preserve:** `TranscriptView.tsx` / `AssistantProse` uses the selected `proseArrival.ts` style and a previous-source-length boundary to mark arriving text. `proseArrivalMark.ts` retains whitespace, shares untouched tree branches, and leaves unpositioned nodes unmarked. Flowing adds 25 ms per word with a 400 ms cap. CSS fades do not buffer engine delivery, but they do affect visible opacity: with `both` fill and a delay, an arriving word can initially be transparent. “Inserted immediately” must not be reported as “fully readable at full opacity immediately.”

Keep the existing options and bounded delay rather than adding a second per-row, per-leaf, or per-paragraph animation. Completed non-streaming rows are not marked by this caller. `transcriptProjector.ts` / `createStreamingTextRow` supplies `isStreaming`, and `finalizeStreamingTurn` removes that flag while retaining available text; `TranscriptRowView` passes it to `AssistantProse`. Completion should expose the settled state directly, without a new completion fade.

The follow-up identifies two specific freshness boundaries. First, `AssistantProse` initializes its previous-length ref to zero on mount. A newly mounted component receiving an already-partial row still flagged as streaming therefore treats its available text as arriving. Session-keyed pane replacement in `WorkspacePanels.tsx` makes this relevant to leaving and returning to live work. Second, `markArrival` captures the offset from its parent render; advancing the ref in an effect does not itself replace that callback. `BoundedMarkdown` can change its mounted leaf window independently, so a remounted leaf can receive the last marked tail again before a subsequent parent render advances the captured boundary. These are source-derived replay risks; neither their visible frequency nor severity was measured. Preserve the no-history-reanimation goal, and treat freshness across remounts as a refinement concern before expanding the effect.

The flowing counter is shared within each `markArrivedText` call, and the caller invokes it separately for each rendered leaf/tree. Its 400 ms cap is a per-word delay ceiling, not a global delivery scheduler or proof of one uninterrupted sequence across the entire message. Keep this distinction when judging the existing effect.

The marking path also reaches positioned text in rendered code leaves. It is not a strict prose-only selector. `CodeBlock` keeps the card frame and disables copy while a fence is open. There is no basis here for mandating the exploratory streaming-code-card cue. Comments mentioning a blinking streaming caret are not proof of one: the inspected `AssistantProse` return does not render such a caret.

**Intentional no motion:** virtual spacers, source gutters, line wrapping, search centering, diff rows, code-card dimensions, measured height corrections, historical rows, peer-message bubbles, and error/stop seams. `TranscriptView.tsx` reasoning/tool disclosures already have limited chevron/color feedback; bodies should open directly without animated height, child stagger, or a summary-line liveness loop. `BoundedMarkdown.tsx`, `VirtualLineList.tsx`, and `ReadSourceLines.tsx` remain reading infrastructure.

The virtualization boundary is more precise than “the transcript is virtualized”: `TranscriptRowsView` maps its top-level display items into keyed row wrappers, while Markdown leaves, composite child bodies, and output lines have bounded windows. `BoundedMarkdown` and `BoundedChildList` use `getBoundingClientRect()` for viewport offsets and per-commit body-height corrections; `transcriptScrollMemory.ts` also reads row rectangles. Their ResizeObserver measurements use layout-box dimensions. **Intentional no motion:** do not introduce scale/translation on those measured roots, row wrappers, or scrolling ancestors, or animate spacer heights. Mixing animated visual coordinates with settled layout measurements could perturb the window/anchor calculations. This strengthens the earlier geometry restriction beyond width/height animations; it does not claim that the current renderer already suffers that failure.

**Existing / preserve:** the live compaction glyph/seam and static completed boundary. The current seam is a transient tail element, followed by a durable compact-boundary row; do not stretch that handoff into an artificial phase or animate the compacted history. Existing skeleton pulses are placeholders, not measured progress. No skeleton shimmer or extra loader layer is proposed.

### 6. Scroll navigation, sidebar, tabs, and split panes

**Existing:** `SessionPane.tsx` / `jumpToBottom` alone explicitly requests smooth navigation. `transcriptScrollMemory.ts` restores position through a direct `scrollTop` assignment. `markdownScrollCoordinator.ts` pools geometry events, consults `paneAnchorModel.ts`, and applies one direct correction before its subscribers recompute windows. `VirtualLineList.tsx` centers selected output lines directly. These mechanisms must not become easing animations.

The smooth request does not prove an uninterrupted smooth journey. `jumpToBottom` also calls `applyAtBottom(true)`; when that changes `atBottom`, the following effect writes `scrollTop = scrollHeight` directly. The coordinator can likewise repin after pending geometry changes while bottom-follow is active. Actual interaction between these writes and Chromium's smooth scroll remains operator-only. The design outcome is explicit navigation to the latest content with stable follow intent, not preservation of a particular animation duration.

Restoration is anchored to top-level row identity plus offset, not a list index; a missing key falls back to the bottom. Capture is coalesced by `createTranscriptScrollCapturePump` and flushed during the pane's layout-effect cleanup while its DOM still exists. Keep that cleanup and the row column's position as the scroller's first element child intact. A decorative wrapper, moved row, or delayed unmount would not be a purely visual change at this boundary.

**New opportunity:** the Latest affordance may fade in once when it becomes available, without replaying on elapsed-time or token updates. Keep its final horizontal centering transform intact and avoid competing transforms on the same geometry. Smooth Latest navigation requires the reduced-motion refinement already described; automatic bottom following and restoration remain direct.

**Refinement:** retain or simplify existing sidebar opening/footer motion. Remove visual delay for the item receiving focus and resolve all geometry/opacity to rest under reduced motion. Keep resize feedback immediate. The earlier proposed sidebar group-body reveal is not recommended: live row changes and focusable descendants make extra layout interpolation a poor default. A static disclosure remains clear without it.

The sidebar reserves a fixed 48 px rail footprint and expands as a fixed overlay over the transcript; its opening is not a content-pane push. Hover show/hide timers are interaction grace periods, separate from the CSS entrance delays. Keyboard focus can open the rail and unfold destinations in the same update, with `useLayoutEffect` handing focus to the replacement destination. The folded list uses `inert={!navOpen}`, while its newly unfolded items still carry stagger classes. Preserve the grace-period and focus-handoff purposes; refine the visual delays without treating every timer as decorative motion. Source establishes those paths, not whether the focused item is visibly settled at the first painted frame.

`TabBar.tsx` already expands the close control from zero width and opacity on hover/focus. Keep tab activation, close, attention state, order, and title edits direct. Ensure keyboard-focused close is fully visible immediately rather than slowly becoming targetable; actual visibility requires operator observation. No tab insertion slide, animated underline sweep, or closing-tab collapse is proposed.

`WorkspacePanels.tsx` / `WorkspaceLayout` owns pointer resizing, drag/drop edges, and session-keyed panels. **Intentional no motion:** splitter widths, drop geometry, session rebinding, and layout restoration. Preserve existing local color feedback. Do not animate pane swaps or route transitions in `App.tsx`.

### 7. Workflow transitions and confirmed results

**New opportunity, selectively:** explicit model-to-effort navigation in `ComposerActionsBar.tsx` / `ModelChip`, Next/Back in `AskQuestionFlow.tsx`, and real OAuth phases in `StartupSurfaces.tsx` are semantic boundaries. An optional new-body fade can connect those steps while preserving a stable shell. Focus, question text, current choices, input, and action availability must not wait for it. No overlapping interactive old/new bodies or error shake.

`SessionActionDialogs.tsx` / `ExportDialog` renders the correlated export result within `SAModal`; a ready preview may appear as one document, never line by line. `RemoteSettingsPage.tsx` / `DirectConnectSection` checks a matching request ID before updating its connected result and toast. `AccountsPage.tsx` similarly has confirmed result handling. A local result tint/fade is optional only where it adds information beyond the existing toast or label. Do not introduce a success flourish merely to supply animation, or invent progress while waiting.

### 8. Permissions and trust

**Intentional no motion:** newly arriving permission cards, their queue wrapper, pending counts, approval/deny choices, snoozed rows, command previews, and trust decisions. `PermissionPrompt.tsx` and `PermissionQueue.tsx` already represent pending and snoozed states; no opacity/scale entrance is necessary. The draft's optional permission-card fade is rejected because immediate legibility and reliable targets outweigh its small aesthetic benefit. Submitting a choice must not visually suggest completion before real resolution.

The permission-mode popover may share an ordinary menu entrance; the selected mode itself updates directly. `StartupSurfaces.tsx` / `WorkspaceTrustGate` should keep paths, consequences, Trust, and Don't open immediately readable, with no motion that privileges acceptance. This report does not alter permission, trust, or focus semantics.

### 9. Settings, themes, inventories, and previews

**Existing / preserve with refinement:** toggle travel in `SettingsEditors.tsx` / `ToggleSwitch` and `PermissionRulesEditor.tsx` can remain for ordinary motion, snapping under reduced motion. A new validation message in `SettingsField.tsx` or a local editor may optionally use a brief opacity entrance, provided it is legible and does not move the input target. No shaking, count-up values, or manufactured persistence acknowledgment.

**Intentional no motion:** settings scope/category replacement, provenance badges, managed locks, Reset availability, native selects, and editable values. The draft's broad category-body fade is not retained: `SettingsShell.tsx` switches both content and write context, and additional crossfading risks ambiguity for little gain. No remount solely to animate.

All eight preference providers remain static. Palette, light/dark appearance, glass mode, reasoning layout, tool-card density, expanded-tools preference, and prose-arrival selection should take effect directly. `ColorSchemeProvider.tsx` and `GlassModeProvider.tsx` use layout-effect stamping where available; do not add a global appearance tween. Layout and density changes are not an invitation to animate transcript measurements.

`CodeThemePreview.tsx` and `ToolCardStylePreview.tsx` should remain accurate, immediate previews using the actual rendering components. Tool style uses a fixed-height sample; do not animate that height. `ProseArrivalPreview.tsx` is an intentional live demonstration through the real marking path, not a static preview awaiting decoration. Preserve it for ordinary motion and settle it under reduced motion.

The prose preview's 152 px shell already prevents its delivery loop from resizing the surrounding settings form. It starts during a settled hold. Changing the option replaces the keyed inner subtree and recreates the interval, but the outer `tick` state is retained; the comment about restarting delivery is not proof of a reset to the beginning. Its parity with production is the marking/CSS mechanism, not the engine's timing, pane restoration, or leaf-remount lifecycle. Do not use a successful preview alone to accept transcript arrival changes.

Keep `GoalsPage.tsx`, `MemoryPage.tsx`, extension inventories, permission-rule lists, welcome recents/account tables, `EmptyState.tsx`, and `RendererErrorBoundary.tsx` quiet. Refreshed inventories are not new-item events. Recovery and Retry must be immediately usable. No animated mascot, empty-state loop, or generic page-load cascade.

### 10. Usage charts and telemetry

**Existing:** `AccountsUsageCharts.tsx` has 300 ms width transitions on model/cache bars, `transition-all` on hover-sensitive SVG points, opacity emphasis, and loading spinners. `AccountsUsageSection.tsx` changes range controls and values. `AccountsPage.tsx` / `HeadroomBar`, `WelcomeScreen.tsx` / `UsageBar`, and composer account bars assign widths directly. `ContextGauge.tsx` sets arc geometry from the current data without smoothing; `ComposerActionsBar.tsx` / `ContextBreakdownDonut` has local hover opacity/stroke-width feedback.

**Refinement:** preserve useful bar continuity only where entity and scale remain comparable. Model bars use index-derived keys, so DOM reuse does not establish that an animated bar still represents the same model after reorder. SVG `transition-all` is broader than hover-radius feedback: data changes can also change geometry. Restrict the design intent to local hover emphasis and comparable data; snap entity/scale changes. Do not claim current chart transitions are already limited to hover or safely identity-preserving.

**Low-priority new opportunity:** after a discrete, confirmed refresh, a quota fill may interpolate briefly while its label updates immediately, but only on a stable scale and with a reduced-motion snap. Current direct updates are also acceptable. A fixed-frame pending-to-ready reveal may be useful; no chart drawing from zero, SVG path morph between ranges, per-bar stagger, count-up KPI, or moving tooltip. Keep hover inspection immediate.

**Intentional no motion:** live context percentage/arc/reference tick, elapsed time, tokens, worker counts, recency labels, and costs. Do not smooth the context ring behind its number or create intermediate measurements. These findings describe source mechanics, not measured update cadence or performance.

## Coverage ledger: production TSX

Every row below names a current file under `app/renderer/src/`. “Static” means no additional decorative motion recommended, not an absence of React updates or shared descendants.

| File | Source-verified surface | Decision |
|---|---|---|
| `AccentThemeProvider.tsx` | Accent context and data attribute | Static provider; immediate palette. |
| `AccountsPage.tsx` | Animated `ALDialog`, menus, account-health pulses, spinners, direct quota fills | Preserve dialog/loading cues; optional menu/result reveal; review persistent warning loops. |
| `AccountsUsageCharts.tsx` | SVG hover transitions, model/cache width transitions, loading marker | Refine property/entity boundaries; no chart drawing or count-up. |
| `AccountsUsageSection.tsx` | Range selection and summary/chart composition | Immediate range/labels; optional fixed-frame ready reveal only. |
| `AgentChrome.tsx` | Conditional face pulse, status pips, static identity/type/baton | Preserve gated existing cues; no duplicate local activity. |
| `AgentsPage.tsx` | Config inventory and animated `AgentInspectDrawer` | Static inventory; refine drawer direction. |
| `App.tsx` | Shell/routes, notices, `TasksStrip` pulse, first-paint preload orchestration | No shell/route animation; preserve task cue; local notice opportunities only. |
| `AskQuestionFlow.tsx` | Question/review steps, selection, nearest-row scrolling | Optional explicit-step fade; stable choices and input. |
| `BannerStack.tsx` | ID-keyed status notices/actions | Optional fresh-notice opacity; no height collapse. |
| `BoundedMarkdown.tsx` | Measured/windowed Markdown leaves and spacers | Static geometry; preserve separate delivery marking. |
| `Chip.tsx` | Compact control/status variants with color feedback | Preserve feedback; no geometry or identity animation. |
| `CodeThemePreview.tsx` | Actual Markdown/code rendering preview | Static accurate palette preview. |
| `CodeThemeProvider.tsx` | Syntax-theme context/data attribute | Static provider. |
| `ColorSchemeProvider.tsx` | Appearance stamping, system preference observation | Immediate appearance; no theme tween. |
| `CommandPalette.tsx` | Dialog, filtering, nearest-row selection | New dialog/scrim opportunity; static results. |
| `ComposerActionsBar.tsx` | Anchored menus, model/effort step, warning entrance, usage hover emphasis | New panel/step opportunities; preserve warning; static rail/telemetry. |
| `ComposerInput.tsx` | Contenteditable/paste DOM and hover preview | Optional preview opacity; static caret, IME, and editing geometry. |
| `ContextGauge.tsx` | Direct SVG arc, percentage, reference tick | Static telemetry; no smoothing. |
| `EmptyState.tsx` | Explanatory title/body | Static; no loop. |
| `FilePathActionsMenu.tsx` | Animated root/flyouts, placement flip, focus scheduling | Preserve entrance; optional directional refinement. |
| `GlassModeProvider.tsx` | Glass preference and root stamping | Static material application. |
| `GoalsPage.tsx` | Read-only grouped goals and metrics | Static inventory and values. |
| `MemoryPage.tsx` | Memory/instruction inventory and copy controls | Static content; preserve copy acknowledgment. |
| `MentionPicker.tsx` | Tabbed suggestion panel and nearest-row scrolling | New panel-only opportunity; immediate filtering/selection. |
| `MetadataInspector.tsx` | Animated right inspector and detail selection | Refine outer entrance; static details. |
| `PathCopyButton.tsx` | Clipboard-confirmed label feedback | Preserve direct acknowledgment. |
| `PermissionModeChip.tsx` | Upward mode menu using shared popover lifecycle | New menu entrance only; immediate mode state. |
| `PermissionPrompt.tsx` | Permission decisions, previews, pending state | Static decision surface. |
| `PermissionQueue.tsx` | Pending/snoozed prompt grouping | Static ordering/counts; no card-to-row morph. |
| `PermissionRulesEditor.tsx` | Mode/rule display and toggle transform | Preserve small toggle feedback; static rule list. |
| `PlanPanel.tsx` | `PlanBar`, plan dialog, approval menu, revision footer | Optional outer entrances; static plan/approval/editor. |
| `ProseArrivalPreview.tsx` | Interval-driven real marking-path demonstration | Preserve ordinary preview; settle under reduced motion. |
| `ProseArrivalProvider.tsx` | Renderer-local arrival preference | Static provider; no extra transition. |
| `ReadSourceLines.tsx` | Source, grep, and addition rows/gutters | Static reading surface. |
| `ReasoningLayoutProvider.tsx` | Reasoning-layout preference | Static provider; no layout morph. |
| `RemoteSettingsPage.tsx` | Bridge state and correlated direct-connect result | Optional result reveal; no fictional progress. |
| `RendererErrorBoundary.tsx` | Recovery screen and retry action | Static immediate recovery. |
| `SAModal.tsx` | Shared modal frame and pop entrance | Preserve baseline; optional scrim consistency. |
| `SessionActionDialogs.tsx` | `ExportDialog` over `SAModal` | Preserve inherited entrance; optional ready-document reveal. |
| `SessionActionIcons.tsx` | Static action glyph vocabulary | Static glyphs. |
| `SessionActionsMenu.tsx` | Animated root and right copy flyout | Preserve; optional horizontal flyout refinement. |
| `SessionPane.tsx` | Queue, attachments, Latest, activity/compaction, scroll lifecycle | Local fresh-item opportunities; refine reduced motion; static input/geometry. |
| `SessionsPage.tsx` | Catalog rows, sort/tag menus, fixed `BulkBar` | Menu/bulk opportunities; no refresh/reorder animation. |
| `SettingsEditors.tsx` | Toggle travel, selects, integer validation | Preserve/snap toggle; optional local error opacity. |
| `SettingsExtensions.tsx` | MCP/plugin/extension inventories and tab color feedback | Static inventories; configuration is not activity. |
| `SettingsField.tsx` | Error text, provenance, managed state, Reset | Optional local error opacity; other states direct. |
| `SettingsShell.tsx` | Category/scope routing and actual preference previews | Static scope/category changes; preserve preview ownership. |
| `Sidebar.tsx` | Width/footer/stagger transitions, hover actions, project-menu entrance | Refine existing motion and focus visibility; no added group-body interpolation. |
| `SlashCommandPicker.tsx` | Suggestion panel and nearest-row scrolling | Panel-only opportunity; immediate composer interaction. |
| `StartupSurfaces.tsx` | Trust gate, OAuth stages/spinner | Static trust; optional real-phase body fade. |
| `TabBar.tsx` | Color feedback, close width/opacity, background permission ping | Preserve attention; refine focused close reveal; static tab geometry/state. |
| `TasksDialog.tsx` | Animated dialog, task spinner, worker/lease details | Preserve/refine dialog; static row updates and controls. |
| `ToastHost.tsx` | Animated toast stack and expiry/dismissal timers | Preserve entrance; no retained exit or animated reorder. |
| `TodoPlanPanel.tsx` | Hover/focus readout, active-step pulse, static step rows | Preserve cue; optional panel reveal only; static steps/counts. |
| `ToolCardStylePreview.tsx` | Fixed-height actual transcript sample | Static accurate density preview. |
| `ToolCardStyleProvider.tsx` | Tool-card density context | Static provider. |
| `ToolInspector.tsx` | Output/search/wrap/copy and virtualized diff/output bodies | Static reading geometry; outer opportunity belongs to `ToolInspectorOverlay`. |
| `ToolsExpandedProvider.tsx` | Expanded-tools preference | Static provider; no expansion cascade. |
| `TranscriptView.tsx` | Prose marking, bounded children, tool/reasoning disclosures, worker faces, skeletons, compaction, copy reveals, output overlay | Preserve delivery/activity; new outer inspector opportunity; static history/geometry. |
| `VirtualLineList.tsx` | Measured line windows/spacers and selected-line centering | Direct measurement/centering; no row entrance. |
| `WelcomeScreen.tsx` | Project picker/chevron, static cat, recents and quotas | Picker-only opportunity; static welcome content. |
| `WorkerRoster.tsx` | Current live-worker roster, CSS hover/focus popover and pips | Preserve cues; optional panel reveal; static identities/counts. |
| `WorkspacePanels.tsx` | `WorkspaceLayout`, dividers, drop edges, session-keyed panels | Direct resizing/rebinding; retain color feedback only. |
| `main.tsx` | Renderer mounting, provider nesting, stylesheet import | No independent visual animation. |

The stale roster entry in the draft has been replaced by the current `WorkerRoster.tsx` owner, verified through its source and runtime consumers. The ledger covers the entire TSX inventory, including the formerly omitted end-of-alphabet surfaces.

## Coverage ledger: CSS and non-TSX ownership

The TypeScript scan was renderer-wide, not restricted to hooks imported by the original draft. The following are the direct motion/visible-placement owners and the supporting boundaries material to these decisions. Other candidate modules were screened for motion mechanisms; pure reducers, selectors, parsers, and formatting/data helpers are not independent entrance-animation surfaces.

| Owner under `app/renderer/src/` | Verified responsibility | Treatment |
|---|---|---|
| `theme.css` | Shared keyframes/classes, Tailwind import, named-class reduced-motion rule | Preserve vocabulary; refine coverage beyond CSS animation. |
| `proseArrival.ts` | Arrival options/default, class selection, stagger/cap, storage | Preserve existing renderer-local choice; no buffering. |
| `proseArrivalMark.ts` | Source-offset word spans and inline animation delays | Preserve source-based marking; no transform/line-layout animation. |
| `proseArrivalPreviewModel.ts` | Preview chunk/hold/reset sequence | Actual demonstration model; settled reduced-motion presentation recommended. |
| `transcriptProjector.ts` | Streaming-row flag creation and terminal finalization, inspected at those symbols | Source of arrival eligibility; data finalization is not a new animation event. |
| `markdownScrollCoordinator.ts` | Pooled observers/frame scheduling and direct scroll correction | Necessary placement work; never ease or disable with decorative motion. |
| `paneAnchorModel.ts` | Bottom-lock and above-viewport correction decisions | Static geometry policy. |
| `transcriptScrollMemory.ts` | Row-relative anchors, capture pump, direct restoration | Immediate restoration; preserve cleanup capture. |
| `markdownRenderPlan.ts` | Leaf planning, measured/windowed Markdown and tree rendering | No leaf-entry or height interpolation. |
| `lineWindow.ts`, `compositeChildWindow.ts` | Virtual line/child geometry and selected windows | Static spacers and corrections. |
| `overlayFocus.ts` | Modal/popover stack, frame-scheduled initial focus and restoration | Preserve interaction lifecycle; not an animation-completion hook. |
| `composerPopover.ts` | Menu open/close, outside click, selected-item focus policy | Preserve lifecycle; proposed decoration must be independent. |
| `composerDom.ts` | Editable/paste DOM, selection restoration, generated close-control color transition | Static editor mutation; ordinary local feedback only. |
| `composerTypeaheadA11y.ts` | Composer/typeahead active-option semantics | Immediate accessibility state; no animation gate. |
| `agentIdentity.ts`, `workersState.ts`, `tasksState.ts`, `tabStatus.ts`, `todoPlan.ts` | Conditions behind worker pulses, tasks, background attention, and todo display | Preserve truthful state-derived cues; no fabricated liveness. |
| `toolCardExpansion.ts`, `toolsExpanded.ts`, `toolRunLayout.ts`, `reasoningLayout.ts` | Disclosure state/preferences and grouped reading layout | Direct disclosure; no remount-based arrival effects. |
| `toolCardStyle.ts`, `viewPreference.ts` | Density preference and shared local preference persistence | Immediate view application. |
| `accentTheme.ts`, `codeTheme.ts`, `colorScheme.ts`, `glassMode.ts` | Appearance options/application support | No global palette/material tween. |
| `sidebarWidth.ts`, `sidebarState.ts`, `sidebarWorkspaceOrder.ts`, `sidebarPinnedSessions.ts`, `workspaceLayout.ts` | Width/order/layout state and pointer decisions | Direct resize/drop/order updates. |
| `toastModel.ts`, `toastContext.ts` | Toast state/cap and API | Preserve expiry semantics; not retained-exit orchestration. |
| `contextUsage.ts`, `contextBreakdownState.ts`, `tokenWarning.ts`, `sessionStatusVisual.ts` | Gauge/warning/activity data selection | Immediate telemetry; use real thresholds/state. |
| `statsState.ts` | Usage pending/timeout state | Timeout handling is not an animation clock. |
| `sessionPreload.ts`, `serverFrameBatch.ts` | Preload scheduling and delivery batching | Keep data work separate from visual pacing. |
| `windowChrome.ts` | Fullscreen-related chrome reservation | Direct layout adaptation; not a motion preference owner. |

The scan found no production renderer use of Web Animations `.animate()`, the View Transition API, or animation/transition-end-driven retained exits. Static transforms for alignment, real data updates, timers that reset copied labels, and frame-scheduled focus/measurement were not mislabeled as animation systems. `reactDevPerformanceTrack.ts` is development diagnostics, not a product motion recommendation. Test harness/fixture utilities and `vite-env.d.ts` do not enlarge the production motion boundary.

## Historical specimens and changed conclusions

All five historical specimens were read in full during the follow-up, including their playback code. They were not operated, changed, or treated as proof of runtime behavior. Their simulated clocks, reserved dimensions, and handcrafted content do not establish how the production renderer behaves.

| Historical file | What its source explores | Current design disposition |
|---|---|---|
| `docs/design-html/2026-08-22-compaction-animation.html` | Fold/drain/star/ingest activity variants, opposing seam sweeps, a height-changing shrinking-stack variant, and alternative completed notices; a 3.2 s interval toggles simulated live state. | Preserve only the current glyph/seam behavior verified in `SessionPane.tsx`, `TranscriptView.tsx`, and `theme.css`. Do not import the simulated duration, stack collapse, or notice-content alternatives. |
| `docs/design-html/2026-08-24-summary-line-motion.html` | Crossfade, vertical roll with an outgoing ghost, changed-word rise, blur swap, and breathing text. Crossfade/blur paths delay text replacement by 200/240 ms. | Keep current summaries immediate and static. Delayed replacement, outgoing ghosts, blur and moving words conflict with this report's reading/lifecycle principles. |
| `docs/design-html/2026-08-24-summary-line-liveness.html` | Changed-word travel combined with breathing, sweep, pulsing dot, blinking caret, or interval-driven ellipsis. | No new summary-line liveness loop. Existing worker/status cues remain owned by current production source; this comparison does not authorize stacking more cues. |
| `docs/design-html/2026-08-25-streaming-prose-arrival.html` | Raw chunks, fade, staggered fade, blur and rise under a deterministic simulated delivery schedule. Unrevealed words/blocks use `display:none`; settled height is reserved after fonts load. | Current smooth/flowing opacity is independently verified in production. Do not import hidden-word scheduling, reserved full-message height, blur, rise, or playback timing. The specimen does not exercise real Markdown reparsing or transcript windowing. |
| `docs/design-html/2026-08-25-streaming-code-card-cue.html` | Four copy-label presentations during simulated fence opening: live, dim, dots and “writing”; an animation-frame loop reveals plain text, then switches to highlighted settled markup after a hold. | Current `CodeBlock` determines real open-fence/copy behavior. No artificial completion hold, new caret, label cycle, or syntax crossfade is required. The specimen's buttons do not implement production clipboard handling. |

Source references to an earlier choice explain provenance; they do not approve every variant in a specimen. The production owners, rather than the historical comparison labels, establish what is already shipped.

Material corrections to the partial draft are:

1. Completed the TSX ledger and reconciled current roster ownership; added renderer-wide CSS/TypeScript discovery and direct-motion helpers.
2. Reclassified Tasks/account dialogs as already animated, and full-output inspection as a distinct opportunity owned by `ToolInspectorOverlay`, not solely its body component.
3. Preserved deliberate existing worker-face breathing instead of applying a blanket identity-must-never-pulse rule; separated background-permission attention from running status.
4. Rejected permission-card fades, sidebar group-body interpolation, and broad settings category fades. Narrowed queue acknowledgment to stable-layout opacity.
5. Kept prose-arrival behavior but corrected the distinction between immediate DOM delivery and delayed visible opacity. Did not infer a streaming caret or isolated prose-only marking from comments.
6. Identified transition/JavaScript reduced-motion gaps beyond the historical stylesheet work; preserved frame-based focus and geometry infrastructure.
7. Qualified chart continuity against actual index keys and broad transition properties. Existing interpolation is not automatically identity-safe or limited to hover.
8. Strengthened the no-motion boundary to include transforms affecting measured transcript coordinates, and distinguished top-level row wrappers from bounded body/line windows.
9. Replaced generic remount uncertainty with the specific component-ref and leaf-callback freshness risks; clarified the preview's retained tick and limited parity with production.
10. Qualified Latest's smooth request against direct bottom-follow writes, and tied overlay/sidebar recommendations to their actual focus and removal lifecycles.
11. Completed full source reads of the five specimens and explicitly rejected their artificial text delays, completion holds, and additional reading-surface motion.

## Operator-only validation boundaries

No visual/runtime validation was performed. Later design acceptance should resolve these questions without interpreting a source check as a GUI pass:

| Scenario | What remains to observe |
|---|---|
| Reduced motion on/off, including preference changes while open | Actual cessation of named effects; final states of sidebar/toggles/tab close; Latest scrolling; whether the preview remains distracting. |
| Rapid menu/dialog open-close and keyboard navigation | Immediate visible focus, legible choices, correct dismissal/restoration, no stale/invisible interactive layer. Hover-only surfaces require operator observation. |
| Long streamed/restored transcripts and pane switches | Revisit a still-streaming pane and scroll a recently marked leaf out/in during a delivery pause; observe any replay. Check viewport drift, bottom lock, caret/IME and immediately usable Stop. |
| Latest during idle and actively growing output | Whether the smooth request is superseded by direct follow/correction writes, whether navigation settles correctly, and whether reduced motion reaches the same final position directly. |
| Output inspector search, wrap changes, large diff/code output | Stable virtual windows and selected-line centering; no moving search or copy targets. |
| Multiple permissions, queued messages, tasks, and notices | Correct announcements and pending/confirmed semantics; no target movement, duplicate local activity, or misleading completion. |
| Narrow/split layouts, sidebar resize, dragging tabs/panels | Correct placement and clipping; movement agrees with the actual anchor; pointer feedback remains direct. |
| Account/usage refresh and model/range changes | Whether bar continuity aids comparison, whether identity/scale changes mislead, and actual loading/hover behavior. |
| Dense active-worker and compaction scenes | Whether concurrent existing cues are restrained, legible, and performant at the operator's display scale and refresh rate. |

Screen-reader announcements, focus visibility during animation, GPU/compositing behavior, frame rate, and subjective appearance remain unverified. Source does not establish a performance regression or prove accessibility compliance.

## Repository validation

This report changes documentation only. Its source claims are bounded above; no desktop GUI or application test result is represented as evidence. Repository validation records the documentation checks run for this import.

| Check | Result |
|---|---|
| `git diff --check` | Pass. |
| `bun run maps:lint` | Pass: 17 maps checked. It emitted seven advisory warnings about recommended sections in unrelated map files. |
| Backticked file-reference check | Pass: all 120 references resolve either from the repository root or `app/renderer/src/`. |
| Explicit repository-path check | Pass: all nine cited root-relative paths exist. |
| Obsolete-draft reference sweep | Pass: no pending-coverage claims, stale roster owner, or handoff-only validation wording remains. |
