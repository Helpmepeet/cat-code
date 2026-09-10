# Desktop animation additions specification

**Date:** 2026-09-11
**Status:** implementation specification for the bounded additions below; not implemented. Queue-row acknowledgment is deliberately disabled under the current correlation contract.
**Intended repository path:** `docs/plans/2026-09-11-desktop-animation-additions-spec.md`
**Decision record:** `docs/reports/2026-09-06-desktop-animation-opportunities.md`, finalized in `d742a324c7e5fcde43a4fdfd0aff658a77b06d7e`.
**Source baseline:** source reviewed at that same reported commit. This dated specification does not supersede later source changes.

## 1. Outcome and limits

Add a restrained opening cue to selected unanimated menus, pickers, the command palette, the plan overlay, and the full-output inspector. A confirmed preparation of an attachment may receive one local acknowledgment. Preserve direct interaction, immediate dismissal, and the renderer's reading geometry.

The implementer has a closed surface list in §4 and four visual recipes in §2. A surface absent from that list does not acquire motion through a shared class change. The whole review is not an implementation backlog.

This specification excludes existing-motion refinements; sidebar, tabs and pane transitions; broad reduced-motion remediation; Latest or scroll behavior; chart motion; workflow-step fades; bulk bars and notices; settings; permission cards; transcript/prose delivery; compaction; worker/liveness cues; and historical HTML specimens. `PlanBar`, plan approval options and revision steps stay static. Existing pop/toast/dialog animations keep their classes and timing. Do not add a second entrance to a descendant of an already animated surface.

No dependency, animation library, preference UI, protocol extension, native capability, or persistent animation state is needed or authorized. The only reduced-motion work in this slice is the fallback and cancellation of these new effects. The review's wider reduced-motion findings remain separate work; they are not a prerequisite for adding effects that independently satisfy the final-state policy.

**Evidence labels:** “Verified” describes inspected declarations/control flow. “Decision” is the behavior this specification selects. “Operator-only” marks a runtime question that static source and headless DOM tests cannot settle. Proposed helper/class names below do not claim that those owners exist today.

## 2. Exact visual treatment

All recipes have zero delay, one iteration, no overshoot, and `cubic-bezier(0.2, 0, 0, 1)` easing. Their base CSS is the final state. Do not use a permanent hidden base plus a class required to reveal the content. No new effect animates position, transform, scale, dimensions, padding, margins, grid tracks, filter, backdrop-filter, or scroll offsets.

| Recipe | Duration | Animated target and endpoints | Final state / interaction |
|---|---:|---|---|
| M: ordinary anchored panel | 120 ms | The allowlisted panel's opacity, from 0.92 to 1. No travel. | Panel geometry and all content exist immediately. Focus entering the panel, pointer-down within it, or keyboard interaction with its options settles it immediately. |
| D: dialog/inspector outer chrome | 160 ms for palette/plan; 180 ms for inspector | Opacity from 0 to 1 on a noninteractive layer painting only the existing outer shadow. The panel fill, border, contents, controls and focus outline remain at final appearance. | Reaches the existing shadow, with no new accent, glow, border, or elevation. The content-bearing panel itself never fades or moves. |
| S: modal scrim | 120 ms | Scrim background color from transparent to the existing `--color-scrim`; opacity of the ancestor/container does not change. | Existing click interception is present immediately. Backdrop blur is constant throughout. No fade-out. |
| A: newly prepared attachment | 140 ms | Opacity from 0.92 to 1 on the selected attachment's thumbnail or noninteractive file icon/name content. | Its shell and Remove control do not fade or move. Any interaction with that attachment settles the acknowledgment. |

**Decision:** the optional travel and scale in the review are not selected. Several panels focus immediately, and output inspection contains measured reading content. Recipe D retains a visible outer entrance while leaving those contents untouched. Recipe M starts near full opacity to avoid a transparent menu of live controls; painted legibility still requires operator validation.

Use the current surface fills, radii, borders, shadows and scrim token at each call site. In recipe D, transfer the existing shadow to one absolutely positioned, pointer-events-none decorative layer, sized to the panel without contributing to layout. A pseudo-element is acceptable where it does not conflict with existing decoration. Keep the layer outside content overflow clipping, keep focus outlines above it, and preserve existing z-order and fixed-position hosts. Do not duplicate the old shadow beneath it. If that extraction cannot preserve geometry and stacking locally, ship the scrim portion and leave the shadow static; do not refactor the overlay system to obtain it. Record that bounded fallback in the implementation result.

`theme.css` already defines `animate-sa-pop` and `animate-toast-in` with transforms. Do not attach them to these additions or edit their keyframes to obtain a fade-only variant. Add narrowly named static classes for M, D, S and A, sharing an opacity keyframe where appropriate. The proposed names are `animate-menu-enter`, `animate-dialog-chrome-enter`, `animate-inspector-chrome-enter`, `animate-scrim-enter`, and `animate-attachment-ack`. Scope them by explicit use, not by generic selectors such as every dialog, listbox, `.bg-surface-raised`, or `POPOVER_PANEL_RIGHT` consumer.

## 3. Entrance identity and cancellation contract

### 3.1 An opening is an event, not a mount

The controller that owns the opening interaction also owns its one-use entrance grant. It may render the content without a grant; lack of a grant always means fully settled. Do not infer a grant inside a panel body merely because it mounted.

A small renderer-only `.ts` helper may centralize grant lifetime and reduced-motion observation. Proposed owner: `app/renderer/src/surfaceEntrance.ts` (new). It is not a presence manager or general motion framework. Keep component exports in `.tsx` and helper/hook exports in `.ts` per the Fast Refresh rule.

Each controller keeps at most one current grant per visible surface. A grant contains a monotonically increasing local generation, the surface's interaction identity, recipe, and a monotonic expiry time. It contains no prompt, attachment bytes, model output, or persisted preference. Generate it outside React functional state updaters; those must remain pure under StrictMode. Render the final state on an initially open mount unless the surviving controller supplies a still-unconsumed grant from an actual opening event.

| Event | Decoration outcome | Functional outcome |
|---|---|---|
| Eligible explicit closed-to-open action | Issue a fresh grant; consume it once when the panel commits. Start the recipe if motion is allowed and the surface is visible. | Existing open state and focus handling run normally. |
| Initial render with existing open/data state | No inferred grant. | Render immediately. |
| Rerender, data refresh, active-row change, query change or internal step change | Keep the same consumed generation; never restart. | Apply current data/selection immediately. |
| Surface DOM disappears and returns within the same interaction | Consumed grant remains spent, even before its old expiry. | Render the returned surface settled. |
| Genuine close followed by a new explicit open | A new generation may animate. | Preserve existing close/open behavior. |
| Close, missing owner/target, removal, pane unbind, or session replacement | Cancel decoration and discard its grant. | Dismiss/remove without a timer or animation-end dependency. |
| Reduced motion becomes active | Cancel the active recipe and consume the grant. | Final state immediately. Turning motion back on does not replay it. |
| Focus/pointer/keyboard interaction with M or A | Consume/settle the grant for the remainder of that opening. | Event reaches its original handler in the original order. |

The grant belongs above conditional content, not inside its animated leaf. On a commit, claim it at most once; a later leaf remount cannot reclaim it. An opening controller that itself unmounts discards its grant. Do not recreate a controller or change content keys solely to get another CSS animation.

A bounded cleanup timer may remove decoration classes at the recipe deadline. It must cancel on cleanup and must not control focus, open state, accessible state, content, button availability or removal. Prefer one pending timer per active grant, no interval, no event queue and no global “seen every item” registry. `animationend` may clean up decoration, but correctness must survive it never firing. Repeated renders must not extend a deadline.

For M, a scoped CSS `:focus` / `:focus-within` override is the immediate final-state backstop. The controller also consumes the grant on focus capture so blurring cannot restart the CSS animation. Do not add focus to a panel that previously kept it in the composer. For typeahead, existing composer arrow/Enter/Escape handlers settle its current recipe before their normal action; `aria-activedescendant` is not DOM focus within the panel.

### 3.2 Reduced motion is part of every recipe

Verified: `app/renderer/src/theme.css` disables 14 named animation classes under `prefers-reduced-motion: reduce`; it does not automatically cover new classes. Add the new recipes and any animated pseudo-element selectors to that rule, with `animation: none !important` and final appearance supplied by the base styles. S returns to the existing scrim color. D returns to full existing shadow. M and A return to opacity 1. No lingering delay or invisible wrapper.

The scoped grant helper observes the same media query so turning reduced motion on consumes active grants rather than merely pausing them. Clean up the listener. If the query cannot be evaluated, default these new additions to settled. This read-only observation creates no preference or bridge API. It must not change existing effects or disable requestAnimationFrame work for focus and measurement.

Consume grants without animation when their originating pane/surface is no longer visible or the document is hidden. Do not accumulate effects to play when the tab, route, or window becomes visible again. A still-running effect should settle on document hiding. None of this changes application visibility or session lifecycle.

## 4. Closed menu and picker allowlist

Each row below uses M on its outer panel only. “Anchor” describes the existing placement to preserve, not a request for new positioning logic. Full owner paths resolve under `app/renderer/src/` in this table.

| ID | Verified owner and anchor | Eligible opening / grant owner | Changes that remain static |
|---|---|---|---|
| M1 | `ComposerActionsBar.tsx` / `ModelChip`; `POPOVER_PANEL`, above-left | Trigger's false-to-true open action, owned by `ModelChip` | Model snapshot, provider groups, selected option, model-to-effort face and Back. Do not add workflow motion. |
| M2 | `ComposerActionsBar.tsx` / `ReasoningChip`; above-left | Its explicit open action | Selected effort, option availability and snapshot updates. |
| M3 | `ComposerActionsBar.tsx` / `AccountChip` → `AccountSwitcherPanel`; above-right | `AccountChip` opening, passing eligibility to its body | Account refresh, quota bars, pool reorder, switch result. The exported body alone has no opening authority. |
| M4 | `PermissionModeChip.tsx`; existing upward menu | Mode trigger opening through its existing `usePopover` state | Selected mode and permissions. No animation on permission cards, approval choices or trust surfaces. |
| M5 | `SessionPane.tsx` → `MentionPicker.tsx`; above composer | A new local mention-query interaction, owned by `SessionPane` | Matching rows, source tabs, filtering, active option, result arrival and restored draft. |
| M6 | `SessionPane.tsx` → `SlashCommandPicker.tsx`; above composer | A new local slash-query interaction, owned by `SessionPane` | Catalog updates, filtering, match count, active option and restored draft. |
| M7 | `AccountsPage.tsx` / `AccountRowMenu`; below-right | Its own menu trigger opening | Row/health updates, account actions, any resulting dialog (already animated separately). |
| M8 | `SessionsPage.tsx` / sort menu; below-right | Existing sort trigger, tracked by the page's `sortOpen` controller | Applying sort, changing counts, catalog reorder. Transparent click catcher stays static. |
| M9 | `SessionsPage.tsx` / `TagPopover`; fixed placement from `sessionsPageState.ts` / `placeTagPopover` | Explicit tag action while no tag popover is open; grant owned with page tag state | Query, create/remove/apply, target update while already open, known-tag refresh and placement recomputation. Its autofocus settles M immediately. |
| M10 | `WelcomeScreen.tsx` / `ProjectPicker`; below-left | Existing project trigger opening | Recents/roster refresh, failure/retry branch and project selection. Native folder picker receives no renderer animation. |

Do not append a class globally to `POPOVER_PANEL` / `POPOVER_PANEL_RIGHT` without checking and explicitly gating every consumer. In particular, `ContextUsagePanel`, `TokenWarningChip`'s warning readout and other usage/readout panels are **not** included in this high-value list. Their telemetry and existing warning entrance remain unchanged.

`ComposerInput.tsx`'s paste preview, `WorkerRoster.tsx` and `TodoPlanPanel.tsx` readout popovers are deferred. The review treated them as lower-value candidates or constrained readouts; they are not needed to deliver the selected menus. Existing `SessionActionsMenu.tsx`, `FilePathActionsMenu.tsx`, sidebar project menu, and all `SAModal` consumers already have motion and are excluded. `PlanPanel.tsx` / `ApproveMenu` stays static to keep the approval surface quiet.

### Typeahead trigger detail

Verified: `SessionPane` derives `slashOpen` and `mentionOpen` from query eligibility, dismissal state **and nonzero matches**. Therefore `open: false → true` alone is insufficient: a filter can temporarily produce zero results and later produce matches within the same query interaction.

Decision: track the local query interaction independently of match count. A local edit that enters a previously inactive slash/mention query establishes one generation. An eligible, visible panel may consume that generation on the first commit only if matches are already available for that opening edit. If there are no matches then, consume it without motion; later catalog/results arrival stays static. Subsequent typing, including recovery from zero matches, does not rearm it. Completing the token, clearing it, selecting a result, Escape, pane unbind or session change ends/consumes the generation. Typing after Escape may reopen the panel under existing behavior, but it does not animate again until a new query interaction starts.

Restoring a draft, recalling a message, receiving props/catalog data and remounting a pane do not constitute the initiating local edit. Preserve existing IME guards, composer selection, keyboard insertion and nearest-row scrolling. No artificial focus transfer, new key binding, scrolling animation or typeahead behavior change is allowed.

### Menu focus and placement detail

Verified: `composerPopover.ts` and `overlayFocus.ts` own open/close, frame-scheduled selected/first-item focus, Escape and restoration. Tag input also has autofocus. `isFocusableElement` filters relevant attributes and tab index but does not prove painted visibility. M must settle when focus arrives; the normal opening effect may consequently be barely visible for keyboard-first menus. That is intended. Do not delay focus to make the animation more visible.

Keep existing anchors, maximum sizes, scroll containers, outside-click handlers and placement flips. A late placement correction is direct and does not trigger another entrance. M has no transform origin to guess. No row staggering or blank delay before choices appear.

## 5. Command palette and plan overlay

### P1: Command palette

Verified owner: `app/renderer/src/CommandPalette.tsx`. The component remains mounted around its `open` prop, returns null when closed, resets query/cursor on opening, calls `useModalFocus`, and scrolls the active result with `block: 'nearest'`. The fixed wrapper currently combines scrim color and constant backdrop blur, with a separate inner dialog.

Decision: on an explicit false-to-true palette opening, apply D (160 ms) to its outer shadow layer and S (120 ms) to scrim color. Keep the panel background, search input, results, footer, focus ring and all actions fully visible immediately. Do not apply opacity to the fixed wrapper or inner content-bearing dialog. Preserve its current top offset, width and z-index.

Typing, cursor movement, recent-item updates and item refresh cannot restart either effect. Enter still executes once and closes immediately, even during the opening. Escape and backdrop mouse-down keep their current ordering. Reopening after a real close may receive a new grant. Restored/initial `open=true` without an explicit opening grant is settled.

### P2: Plan overlay

Verified owners: `app/renderer/src/SessionPane.tsx` owns `planPanelOpen`, resets it on pane/session changes and closes it when `planReview` disappears. `app/renderer/src/PlanPanel.tsx` returns null for `!open || !review`, initially focuses its container through `useModalFocus`, and owns approval/revision substate. Its modal Escape handling intentionally differs while those substeps are open.

Decision: View plan opening while a review is present grants D (160 ms) and S (120 ms). Plan text, paths, listed tools, Approve, Revise, Close and focus outline are fully visible at their final positions from the first render. Review arrival itself does not open or animate the overlay and does not animate `PlanBar`. A missing review renders nothing, regardless of a decorative grant.

Entering or leaving approval/revision substeps does not animate. Replacing/updating a review while the overlay is already open updates directly, with no new grant. Resolution removes it immediately. Do not retain old review content for a fade or change permission/request handling. Preserve the current Escape arbitration and focus restoration.

## 6. Full-output inspector

Verified owners: `app/renderer/src/TranscriptView.tsx` / `TranscriptRowsView` stores `inspectedId`, resolves the current tool row through `findNestedToolUseRow`, and renders `ToolInspectorOverlay` as a sibling of the transcript column. `ToolInspectorOverlay` owns the fixed full-screen host, scrim, modal focus container and outer shadow. `app/renderer/src/ToolInspector.tsx` owns the output body, search, wrap and copy UI.

Decision: only an explicit inspect action from a closed inspector, with a presently resolvable tool row, issues D (180 ms) and S (120 ms). Grant ownership stays with inspector selection above the conditional overlay. Repeated clicks on the same row while open, switching inspected rows, late tool results, search changes and wrap changes are not entrances.

Animate only the existing outer shadow's decorative layer and scrim color. Do not put opacity, translation, scale or layout interpolation on the fixed host, modal content container, `ToolInspector` root, measured reading descendants, or their ancestors. The output is fully visible immediately. No change to `BoundedMarkdown`, `VirtualLineList`, line/diff renderers, expansion state, windowing, or scroll coordination is needed.

If the selected row vanishes, the existing null overlay result wins immediately and consumes its grant. If the same stored ID later resolves again without a new inspect action, it renders settled. Dismissal never waits for an effect. Preserve inline overlay composition, z-order, modal stack ownership and current click handling; no portal migration.

## 7. Confirmed attachment preparation

### Verified event and identity boundaries

`app/renderer/src/SessionPane.tsx` / `attachImage` awaits `prepareImageAttachment`, then calls `onAttachImage`. `attachFile` awaits the native picker, returns without success on cancel/error, routes image selections through image preparation, and invokes `onAttachFile` only for a successful file-token selection. `app/renderer/src/imageAttachment.ts` validates/reads or converts the image before returning prepared bytes. These are genuine preparation results, not proof that a later prompt was accepted or that thumbnail decoding has painted.

`app/renderer/src/App.tsx` supplies those callbacks and owns attachment state. `app/renderer/src/composerState.ts` / `reduceImageAttachmentAdded` replaces the selected image and assigns a numeric ID based on the current selection. After removal an ID can be reused. File selection uses an opaque main-issued token, and its wrapper is currently unkeyed. Restored, recalled, refused and released submits also write attachment state through separate restore paths. Presence, a new object, increasing image ID, file name, or a changed token is therefore not sufficient proof of new preparation.

### A1: preparation acknowledgment contract

Decision: grant A only at the existing successful preparation-to-selection callback boundary, after the existing data update has been accepted for the originating session. The same selected content must be committed to that session's visible, still-mounted pane. Use separate renderer-only presentation metadata; do not add fields to wire payloads, file tokens or prepared image data.

The implementer may add a small pure metadata owner, proposed `app/renderer/src/attachmentEntrance.ts` (new), held by `App` alongside attachment selection. It carries only session ID, attachment slot/kind, a local preparation generation, originating pane mount generation, and expiry/consumption status. It must not retain a second copy of base64 data. The metadata is paired with the successful selection action, not derived by comparing old/new rendered arrays.

| Selection event | Metadata and visual outcome |
|---|---|
| Successful new image preparation committed through `onAttachImage` | Issue one fresh image-slot generation associated with this completion and pane mount. Acknowledge only the resulting current selected thumbnail. |
| Successful non-image file selection committed through `onAttachFile` | Issue one fresh file-slot generation. Acknowledge the resulting current file icon/name, without requiring the unkeyed file wrapper to remount. |
| Error, cancel, rejected format/size or no callback | No grant, no success cue. Preserve current error handling. |
| Selection replaced before its cue commits | Discard the superseded grant. Only the surviving selected preparation may acknowledge; no delayed playback of the old item. |
| Remove or submit clears selection | Clear its metadata immediately. No exit animation. |
| Refused submit, pending-submit release, recall, draft/session restoration | Clear/suppress metadata for the overwritten slot; show the restored selection settled. Do not change how restoration preserves or replaces data. |
| Completion after pane unbind, session replacement, route change or document hiding | Preserve the existing data outcome for the originating session, but discard the visual grant. Returning to the pane does not acknowledge old preparation. |

Mint the preparation generation in the completion/action path outside functional state updaters. Apply metadata and existing selection updates in the same React batch, with any new pure reducer logic repeatable under StrictMode. Do not change the current one-image selection rule or file-token semantics. Use explicit mount/session identity for presentation eligibility; names and bytes are not correlation keys. A visible split pane can acknowledge its own preparation without becoming the active pane or taking focus.

The originating completion may pass its presentation identity through the existing callback boundary, but must not delay or suppress the data callback just because its visual grant is stale. Clearing metadata on every existing restoration/removal/submit path is a necessary local part of A1, not authorization to redesign draft or attachment state.

Apply A only to noninteractive preview content. Keep the attachment shell, Remove button, composer and Stop targets at their final geometry and appearance. No height/width tween, thumbnail zoom, upload progress, checkmark, toast or transfer-to-transcript animation. Natural insertion/replacement layout still happens as it does today; this feature adds no intermediate geometry and promises no elimination of existing image decode/layout changes.

Use a transient animation class on the current selected content without changing its React key. A new preparation in the same file slot can restart only through its explicit fresh generation. Consume the generation after one commit, so an image decoder event, repeated render, removal/re-add with a reused ID, or pane remount cannot restart it. If focus or pointer input reaches the attachment before completion of A, settle it without affecting Remove's existing action/reveal behavior.

## 8. Queued messages: source-backed no-op in this slice

Verified: `app/renderer/src/queuedPromptsState.ts` replaces a session's whole queue from `queued-prompts.snapshot`. That frame is also sent on attach and is retained as a sticky snapshot. `app/shared/protocol.ts` defines `QueuedPromptItem` as engine `id` plus preview `text`. The current `SubmitResultFrame` returns `submitId` and `accepted`, where accepted means either an idle turn started or a prompt was staged. It supplies neither the queue item ID nor a queued-vs-started outcome. `composerState.ts` / `reduceSubmitAnswers` correlates answers with retained local submits; a queue snapshot is explicitly not that answer. The sidecar's `queuedPromptItems` in `app/sidecar/sidecarServer.ts` builds the authoritative visible queue, but does not attach the renderer's submit ID to its items.

**Decision:** do not add queue-row acknowledgment in this implementation. The existing contracts establish that a row is waiting, but do not safely identify which newly accepted local submission should receive a one-shot row cue across attach/replay and intervening snapshots. A new ID in a replaced array is not the required semantic event. Matching truncated preview text, array position, temporal proximity, same-batch arrival, or one accepted submit against one new row is forbidden.

Do not animate the renderer-local `pendingSubmit.showQueuedRow` either: it represents a parked submission and is not engine acceptance. Leave the actual queue caption/status region, `QueuedRow`, force-send/recall controls and all removal behavior static. Keep the queue block after the transcript row column, preserving scroll-memory structure. Do not move a queued bubble into the transcript or add a new success toast as a substitute.

This is an explicit bounded deferral, not an implementer research task or permission to extend the protocol. A later separately scoped design could supply authoritative queue-acceptance identity/provenance and then reconsider recipe A on a noninteractive queued body. Until such a source contract exists, the acceptance condition here is **no new queue motion**. A1 delivers the safe acknowledgment addition available in the present renderer.

## 9. Implementation boundaries and order

The following is the later engineer's potential change set, not files changed by this documentation task. Existing owner paths are verified; the two helper files are explicitly proposed new files.

| Step | Later implementation owners | Deliverable |
|---|---|---|
| 1 | `app/renderer/src/theme.css`; proposed `app/renderer/src/surfaceEntrance.ts` | Static-final recipes, scoped reduced-motion selectors, bounded one-use grant lifetime and cancellation. No global selector/transition cleanup. |
| 2 | M1–M10 owners in §4; caller wiring in `SessionPane.tsx` as needed | Explicit panel allowlist and per-opening grants, including typeahead interaction identity. Preserve `composerPopover.ts` / `overlayFocus.ts` semantics. |
| 3 | `CommandPalette.tsx`, `PlanPanel.tsx`, `SessionPane.tsx`; inspector selection/overlay symbols in `TranscriptView.tsx` | Scrim and existing-shadow entrances only, with content and focus fully visible. No reading-body edits. |
| 4 | `App.tsx`, `SessionPane.tsx`; proposed `app/renderer/src/attachmentEntrance.ts`; `composerState.ts` only if a pure selection/metadata integration needs it | Preparation provenance, consumed generations, scoped cleanup across existing selection/restore paths and A1. |
| 5 | Colocated tests for changed behavior | Temporal, provenance, focus and no-replay acceptance below. No tests or implementation for the deferred queue effect. |

Do not change `app/shared/protocol.ts`, preload, main, sidecar, server frame batching, queue reducers, transcript projectors or geometry helpers for this feature. Their source is evidence for boundaries. No map/status/report rewrite is necessary merely to add these effects. If later implementation finds a real owner change, report it and follow the then-current repository instructions without expanding the feature.

Before editing, recheck git status and these owners against the source baseline. If a panel has acquired an entrance since this specification, preserve it and remove that surface from the additions rather than stacking a second animation. Recheck existing focus/geometry composition before extracting a shadow layer. No GUI launch or operation is authorized by this document.

## 10. Testable acceptance

Use the repository's test-writing workflow when implementing tests. Exercise real owner transitions/callbacks in the renderer DOM harness with controlled timers and media-query signals. Pure helper tests complement those owner tests; screenshots of static markup or class-name assertions alone do not prove lifecycle correctness. Do not add wall-clock sleeps or run the Electron GUI from tests.

| ID | Required scenario | Passing outcome |
|---|---|---|
| T1 | Open an M surface; rerender with changed rows/selection; close/reopen rapidly | One grant for each true explicit opening, no replay for data changes, no stale timer affecting the later opening. Actions and immediate removal work throughout. |
| T2 | Open with focus landing immediately; interact while M is active; blur within the same opening | Final opacity on focus/input; original handlers execute once; blur cannot restart. Focus is not delayed or re-routed by the helper. |
| T3 | Begin typeahead, edit through zero matches and back, refresh catalog, restore a draft, remount pane | Only the eligible initial local query event can animate. Every filtering/data/restoration/remount case is settled. Existing completion, active option and scrolling behavior is preserved. |
| T4 | Change model to effort face and Back; change tag query/target while open; recover project-picker error branch | No second panel entrance or content remount for decoration. Existing semantic updates are immediate. |
| T5 | Open palette, type and execute immediately; open plan, enter approval/revision, remove review | Content/focus are available at once; actions fire once; normal Escape arbitration is preserved; removal does not await decoration. PlanBar and approval choices have no new animation. |
| T6 | Open inspector, update its live row, switch target, remove row and later return it without a new inspect action | One opening grant. Result updates and return without new intent stay settled. Null row immediately removes overlay; no output/geometry animation or new content key. |
| T7 | Start in reduced motion; switch it on during each recipe; switch it off again; hide/show document | Final appearance immediately, no replay on preference/visibility return, no retained grant or timer. Existing focus/measurement scheduling still executes. |
| T8 | Prepare image/file successfully, then send irrelevant renders and decoder events | One A1 for the successful committed selection, no extra grant from renders/decoding. Remove/input/Stop remain usable. |
| T9 | Cancel/fail preparation; replace/remove before display; resolve after origin pane unbind; reuse an image ID | No false or stale acknowledgment. Latest selected data follows existing rules. Removed or old-generation items cannot animate later. |
| T10 | Restore attachments through refused-submit, recall and pending release; switch sessions with existing selections | Restored data is intact and static. No cross-session or remount acknowledgment. |
| T11 | Inspect unchanged queue rendering and use existing queue/submit regression coverage for first/repeated/reordered snapshots, accepted/refused results, attach/replay and parked pending submits | No new queue motion or acknowledgment. No guessed submit-to-row association. No new suite solely to restate this unchanged behavior. |
| T12 | Inspect new CSS and rendered hosts | New keyframes contain only allowed opacity/background-color properties; defaults are final; every recipe/pseudo-element has a reduce override; existing animation definitions are unchanged; D does not target content opacity. |

For T2/T5/T6, a DOM harness can establish focus ownership, callbacks and removal ordering; it cannot prove painted focus contrast, CSS animation quality, hitbox geometry or compositing. Keep those claims for §11. CSS-source assertions are a narrowly useful fallback-coverage check, not proof that reduced motion looks correct in Chromium.

Later implementation must run the current `CLAUDE.md` desktop battery for the application files it changes, including its renderer build gate, plus focused new tests and documentation validation. Re-read those instructions rather than inheriting historical test counts. This documentation-only session requires only the commands recorded in §12; no application tests/build are claimed here.

## 11. Operator-only visual acceptance

After headless implementation checks, provide these steps to the operator under `docs/migration/process/GUI-VERIFICATION.md`. Do not operate the GUI or warp the pointer. Judge current source in the correct desktop runtime; a stale packaged renderer is not evidence about new code.

1. Open representative above-left, above-right, below-trigger and clamped tag panels with mouse and keyboard. Confirm the target does not move, choices are readable immediately, focus is visible on arrival, and placement/scrolling remain correct in narrow and split layouts. An autofocus entrance that settles almost instantly is acceptable.
2. Type into slash/mention suggestions, pass through zero matches, navigate and insert immediately. Confirm no filter-driven flashing, caret movement or interference with IME. Test the remaining allowlisted surfaces, not just the shared helper.
3. Open palette and plan, then act or dismiss during the entrance. Confirm the only dialog effect is the restrained shadow/scrim, blur stays constant, text/focus remain fully visible, and no old interactive layer persists. Approval/revision substeps remain static.
4. Open full output with long wrapped text and a diff, search, switch inspected tools and close during entry. Confirm no content fade/travel, selected-line drift, altered clipping, or change in transcript scroll position. Watch the shadow layer for a stacking/clipping regression.
5. Prepare, replace and remove image/file selections; cancel/fail preparation; change panes before completion; restore recalled/refused content. Confirm one acknowledgment only for fresh visible preparation, no fake success, no repeated cue and no additional target movement. Queue rows remain static.
6. Repeat with reduced motion already enabled, toggle it during the effect, then turn it off. Final appearance must be immediate and must not replay. Hide/show the window during entry and confirm that old effects do not resume.

Operator-only uncertainties: whether M/A's slight opacity change is useful and legible, actual focus painting, live-region/screen-reader output, shadow and blur compositing, pointer hitboxes, image decode behavior, visual clipping, display-scale behavior and frame performance. Do not call these passed from source inspection. If a recipe is imperceptible because interaction correctly settles it, prefer that outcome to delaying interaction or increasing travel.

## 12. Repository validation

This documentation-only change adds this plan. It does not represent desktop GUI or application test results as evidence. Repository validation records the documentation checks run for this import.

| Check | Result |
|---|---|
| New-file whitespace check | Pass: `git diff --no-index --check /dev/null` produced no whitespace diagnostics. Its exit status denotes an added file, not a failed check. |
| `bun run maps:lint` | Pass: 17 maps checked. It emitted seven advisory warnings about recommended sections in unrelated map files. |
| Backticked file-reference check | Pass: all 40 references resolve, except the two explicitly proposed helper files. |
| Scope and stale-reference sweep | Pass: no external-handoff validation language, draft-status claims, or obsolete roster owner remains. |
