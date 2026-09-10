# Desktop animation opportunities

Date: 2026-09-06

Status: Draft. A-S evidence consolidated; T-Z and non-TSX coverage pending.

## Recommendation

Make the application feel more responsive through consistent, small transitions around actions and state changes, not by making every component move.

The strongest opportunities are opening menus and overlays, acknowledging a queued message or prepared attachment, revealing bulk actions, and distinguishing steps in a workflow. Preserve quiet reading surfaces. Do not animate typing, historical transcript rows, live counters, source lines, theme changes, or permission choices themselves.

This is a design report, not an implementation proposal or a verified bug list. Luna subagents inspected application source; the author did not read application code. Source observations below are attributed to those inspections. Recommendations are the author's judgment, including rejection of some subagent suggestions. No application code was changed and no GUI was launched. Durations are design targets, not measured runtime behavior.

## Scope and evidence

The target is the Electron desktop application, not the terminal interface. Discovery began with renderer filenames, then subagents examined components, internal subcomponents, relevant styles, and behavior helpers. The filename inventory contains 64 production TSX files, including providers and the renderer entrypoint. Tests and generated output are not production animation surfaces.

Some initial subagent reports overlapped. Coverage is counted by the actual files inspected, not by the assigned partition or number of reports. A-S is covered. T-Z and UI owners outside TSX are pending at this draft stage.

The shared tree was being edited by other sessions during inspection. Source anchors describe the inspected snapshot and can move. Runtime appearance, responsiveness under load, and focus during animation have not been visually verified. The report does not claim the existing app looks broken where it merely lacks an explicit animation declaration.

## Motion language

### Desired character

Quiet, precise, and attached to the action that caused it. A panel should feel as though it opens from its control; an accepted input should receive a small acknowledgment; completion should settle rather than celebrate. No bounce, elastic spring, overshoot, confetti, whole-card pulse, or decorative repeated movement.

Use a small shared vocabulary instead of bespoke effects per screen:

| Pattern | Appearance | Target timing |
|---|---|---|
| Control feedback | Short background, border, or icon-color change; no geometry change | 80-120ms |
| Anchored popover | Opacity in; move 3px from the trigger toward the final position; optional scale .98 to 1 | 100-130ms |
| Centered dialog | Opacity in with scale .98 to 1; scrim fades independently | Panel 140-180ms; scrim 100-130ms |
| Right-side drawer | Opacity in with 8px right-to-left travel; no long screen-edge flight | 160-200ms |
| Newly available item | Opacity in, optionally 3-4px toward its resting position | 120-160ms |
| Explicit workflow step | New body fades in after old controls are removed; optional 4px directional cue | 120-160ms |
| Short disclosure | Chevron rotation; bounded non-virtual body reveals without staggering children | 140-180ms |

Entrances should decelerate gently into rest, without overshoot. Pointer-following and selection feedback should be nearly immediate. Use the existing shared visual vocabulary where it fits; no animation library or dependency is recommended by this report.

### Non-negotiable behavior

- **State is immediate; decoration follows.** Text, numbers, accessible state, focus, and action availability update at the real event. Never wait for animation to accept input.
- **Animate semantic events, not renders.** A fresh item may animate once. A snapshot refresh, virtualized remount, session restore, or component re-render is not a fresh item.
- **Do not queue motion.** Rapid toggles cancel or retarget to the newest state. No backlog of obsolete fades.
- **Keep input targets stable.** Do not move a focused row, approval button, Stop control, editor, or caret. Do not animate dimensions involved in transcript measurement.
- **Prefer entrance-only initially.** Many current surfaces unmount immediately. An exit needs intentional retained presence and correct pointer/focus behavior. Do not keep an invisible dialog interactive or delay dismissal merely to play an outro.
- **Reduced motion means the final state immediately.** Disable proposed translation, scale, stagger, layout interpolation, looping animation, and smooth scrolling. Keep a static icon plus actual status text where activity needs explaining.
- **One activity cue per local unit.** Prefer a small status pip over pulsing a face, name, and card together. Persistent configuration is not activity.
- **No animated blur.** Keep native glass and backdrop blur stable. Fade a scrim's color layer, not the blur radius.

## Existing motion worth preserving or refining

Luna reported existing prose-arrival fades, toast entrance, menu/modal pop, token-warning entrance, active-worker pulses, and compaction animation in [theme.css](../../app/renderer/src/theme.css). These are not missing-animation opportunities.

Luna also found substantial sidebar width, footer, stagger, and chevron transitions in [Sidebar.tsx](../../app/renderer/src/Sidebar.tsx). The sidebar should not receive another decorative layer.

The current reduced-motion rule was reported at [theme.css:1420](../../app/renderer/src/theme.css:1420). It disables named animation classes but does not cover all ordinary CSS transitions or explicit JavaScript smooth scrolling. Examples reported by Luna include sidebar width/stagger, toggle movement, and [SessionPane.tsx:887](../../app/renderer/src/SessionPane.tsx:887), where an explicit Latest action uses smooth scroll. Treat consistent reduced-motion behavior as a prerequisite for expanding motion, not as a reason to invent a separate preference UI.

## Priority 1: high-value additions and consistency

### 1. Composer menus, suggestions, and small contextual menus

**Where:** model/effort/account/context menus in [ComposerActionsBar.tsx:246](../../app/renderer/src/ComposerActionsBar.tsx:246); [PermissionModeChip.tsx:112](../../app/renderer/src/PermissionModeChip.tsx:112); [MentionPicker.tsx:78](../../app/renderer/src/MentionPicker.tsx:78); [SlashCommandPicker.tsx:61](../../app/renderer/src/SlashCommandPicker.tsx:61); account menu in [AccountsPage.tsx:534](../../app/renderer/src/AccountsPage.tsx:534); sort/tag menus in [SessionsPage.tsx:1042](../../app/renderer/src/SessionsPage.tsx:1042).

**Reported current behavior:** most of these panels appear abruptly, although their rows already change color on hover or selection. Session actions and file-path menus already use the shared pop animation.

**Recommended appearance:** one 100-130ms panel entrance. For a panel above the composer, begin 3px below its final position and settle upward. For a panel below its trigger, begin 3px above and settle downward. Match the transform origin to the actual anchor. Use a small opacity fade and, only if it remains crisp, scale .98 to 1.

Animate the panel, never its list of choices. Search filtering, arrow-key selection, empty states, and active-row scrolling remain immediate. Do not replay entrance when the query or result count changes. Preserve the composer's focus where the picker deliberately retains it.

**Smaller surfaces:** apply the same restrained treatment to the pasted-content preview in [ComposerInput.tsx:315](../../app/renderer/src/ComposerInput.tsx:315). Keep its existing pointer-travel grace period; do not extend that delay for an outro. For roster reveal in [OrchestratorRoster.tsx:90](../../app/renderer/src/OrchestratorRoster.tsx:90), use the same upward opening only if hover and keyboard entry stay immediate. Do not replay row entrances every time the roster opens.

**Already animated flyouts:** [SessionActionsMenu.tsx:262](../../app/renderer/src/SessionActionsMenu.tsx:262) and [FilePathActionsMenu.tsx:192](../../app/renderer/src/FilePathActionsMenu.tsx:192) should use a 3px horizontal reveal away from their parent row rather than a generic vertical pop. Only use flipped-left behavior where actual placement supports it. Luna reported that the session-copy flyout is right-positioned, while the file-path flyout can flip.

### 2. Command palette and plan-review overlay

**Where:** [CommandPalette.tsx:111](../../app/renderer/src/CommandPalette.tsx:111), [PlanPanel.tsx:136](../../app/renderer/src/PlanPanel.tsx:136), and its compact `PlanBar` at [PlanPanel.tsx:45](../../app/renderer/src/PlanPanel.tsx:45).

**Reported current behavior:** these overlay bodies have no explicit entrance, unlike the shared session-action modal.

**Recommended appearance:** fade the scrim over 100-130ms; reveal the dialog over 140-180ms with scale .98 to 1 and at most 4px travel. Let initial focus and keyboard controls work immediately. A newly available PlanBar can receive a single 140ms fade, without a looping alert.

Keep command results static while searching. Keep plan text, allowed-tool chips, and approval controls still. The plan approval submenu can use the anchored-popover pattern. Revision mode should replace the footer directly, with at most a short new-content fade; never animate the textarea or delay its focus.

**Existing shared modal:** preserve the entrance in [SAModal.tsx:66](../../app/renderer/src/SAModal.tsx:66). Standardize the scrim treatment rather than stacking a second entrance onto each dialog. No title/icon/footer cascade.

### 3. Inspector drawers

**Where:** [AgentsPage.tsx:227](../../app/renderer/src/AgentsPage.tsx:227), [MetadataInspector.tsx:137](../../app/renderer/src/MetadataInspector.tsx:137).

**Reported current behavior:** both already use the toast-style vertical entrance; scrims appear without a separate fade.

**Recommended appearance:** refinement, not a missing feature. Use a common right-drawer entrance: 8px from the right plus opacity over 160-200ms, with a 100-130ms scrim fade. A small horizontal motion explains the edge relationship better than rising like a toast.

Do not move or stagger metadata fields. Changing the selected message or agent inside an open inspector should replace details directly; a reading surface does not need a repeated transition. Start with immediate dismissal rather than a delayed exit.

### 4. Queued messages and prepared attachments

**Where:** [SessionPane.tsx:1216](../../app/renderer/src/SessionPane.tsx:1216), [SessionPane.tsx:1486](../../app/renderer/src/SessionPane.tsx:1486).

**Reported current behavior:** queue rows and attachment previews arrive without an entrance.

**Recommended appearance:** give a newly accepted queue item a 140-160ms fade with 4px upward settlement. This communicates “your input was retained” while another turn runs. Give a successfully prepared thumbnail or attachment chip a 120-140ms opacity entrance.

Animate only the new item. Keep the draft, attachment container dimensions, composer height, text, and caret static. Never replay on restore or every streamed update. Errors remain immediately readable.

Do not animate a queued bubble flying into the transcript. Luna found separate render locations; a convincing transfer would need more coordination than the visual benefit warrants here. The disappearance of the queued state and arrival of the real message should remain honest and direct.

### 5. Bulk actions and newly available notices

**Where:** `BulkBar` in [SessionsPage.tsx:951](../../app/renderer/src/SessionsPage.tsx:951), [BannerStack.tsx:63](../../app/renderer/src/BannerStack.tsx:63), the shell error surface reported in [App.tsx:4168](../../app/renderer/src/App.tsx:4168).

**Recommended appearance:** when selection changes from none to some, reveal the bulk-action bar once with 6px upward travel and opacity over 140-180ms. Further count changes are immediate. Keep focus on the selected row, not the new toolbar.

For a genuinely new banner ID, use a 120-150ms opacity entrance, optionally 3px into place. Keep the title, actions, and live-region announcement immediately available. Do not pulse, stagger, or reanimate a notice when its detail text refreshes.

Do not initially animate height collapse around the transcript or focused controls. Immediate removal is preferable to a decorative transition that shifts the reading position or leaves a dismissed banner interactive.

### 6. Workflow phases and confirmed results

**Where:** [StartupSurfaces.tsx:392](../../app/renderer/src/StartupSurfaces.tsx:392), [RemoteSettingsPage.tsx:243](../../app/renderer/src/RemoteSettingsPage.tsx:243), [SessionActionDialogs.tsx:20](../../app/renderer/src/SessionActionDialogs.tsx:20), and account-result surfaces in [AccountsPage.tsx:783](../../app/renderer/src/AccountsPage.tsx:783).

**Recommended appearance:** preserve the shell and fade only the newly active content over 120-160ms after a real phase change or correlated result. For OAuth, ready/waiting/alias/success/error are useful boundaries; every arriving URL or keystroke is not. A confirmed success check may appear once with opacity and scale .95 to 1 over 120ms. Add no extra dwell, celebration, or fake progress.

For export, fade the ready preview as one document, never line by line. Enable Copy/Download immediately when it is ready. For direct connect, fade the confirmed result region without moving the form. For account refresh, keep row positions fixed and acknowledge the specific confirmed result with a brief background or border tint, not a row bounce.

Trust decisions are excluded from decorative step motion: scope, paths, caveats, Trust, and Don't open must be readable and actionable immediately. No emphasis that nudges acceptance. Errors should not shake.

## Priority 2: selective polish

### 7. Model-to-effort and question-step continuity

**Where:** [ComposerActionsBar.tsx:246](../../app/renderer/src/ComposerActionsBar.tsx:246), [AskQuestionFlow.tsx:437](../../app/renderer/src/AskQuestionFlow.tsx:437).

The model picker moving to effort selection is a genuine nested step. Keep the panel anchored and replace its body with a 120ms fade and at most 4px horizontal cue. Back reverses that cue. Move keyboard focus immediately; do not slide a full pane or maintain two interactive faces.

For an explicit Next action in a multi-question flow, use at most a 100-140ms new-body fade if the footer and focus stay stable. Option selection gets only a short background/border transition. Keep question text immediately readable, cursor movement immediate, and option previews static as arrow keys move. Reject row staggers, animated selected counts, delayed submit, and a spinner solely to justify more motion.

### 8. Permission arrival, not permission persuasion

**Where:** [PermissionPrompt.tsx:76](../../app/renderer/src/PermissionPrompt.tsx:76), [PermissionQueue.tsx:18](../../app/renderer/src/PermissionQueue.tsx:18).

A new approval card can use a restrained 100-130ms opacity entrance, but no scale, bounce, traveling buttons, pulsing border, or delayed choices. This is lower priority than ordinary popovers because clarity and reliable keyboard response matter more than softness.

Do not animate the queue wrapper, card ordering, pending count, input preview, or command lines. Do not stagger simultaneous prompts. On submission, leave the card visibly pending until the engine resolves it; do not fade the whole card into apparent completion. Snoozed rows and restored prompts should use direct state changes rather than a card-to-row morph.

### 9. Disclosures and explicit navigation affordances

**Where:** workspace groups in [Sidebar.tsx:1315](../../app/renderer/src/Sidebar.tsx:1315), Latest pill in [SessionPane.tsx:1281](../../app/renderer/src/SessionPane.tsx:1281).

For user-triggered sidebar group expansion, a short 140-180ms bounded reveal and chevron rotation can clarify the relationship. Keep the group header still, avoid child staggering, and immediately remove collapsed items from keyboard reach. Rapid toggles reverse toward the current target.

The sidebar's existing width and footer motion should be simplified or retained, not augmented. Eliminate delays for the item receiving keyboard focus and for reduced-motion users. Resizing, drag targets, and drop indicators follow the pointer immediately.

When a reader leaves the bottom, the Latest pill can appear once with opacity and 4px upward movement over 100-130ms. Do not replay it for each elapsed second or new token. Explicit Latest scrolling may be smooth only when reduced motion is off; restore, bottom-follow, and scroll corrections remain immediate.

### 10. Settings selection and validation

**Where:** [SettingsEditors.tsx:340](../../app/renderer/src/SettingsEditors.tsx:340), [SettingsField.tsx:134](../../app/renderer/src/SettingsField.tsx:134), [SettingsShell.tsx:153](../../app/renderer/src/SettingsShell.tsx:153).

Keep existing toggle travel, standardized to approximately 120-160ms with a reduced-motion snap. For a new validation error, an optional 100ms opacity entrance is enough; do not shake the field or move controls. Error semantics remain independent of animation.

Explicit category navigation may use a 100-120ms entrance on the newly selected right-hand content only. Do not crossfade simultaneously interactive settings belonging to different write scopes. Scope labels, write targets, and values update immediately. Do not remount editors just to trigger motion or replay animations on each search keystroke.

An accent swatch may briefly emphasize its selection ring. The application theme itself changes immediately. Keep source badges, managed locks, Reset links, integer values, native selects, and save acknowledgment text static. Do not manufacture success before persistence confirms it.

### 11. Usage charts and quota bars

**Where:** [AccountsUsageCharts.tsx:762](../../app/renderer/src/AccountsUsageCharts.tsx:762), [AccountsUsageSection.tsx:128](../../app/renderer/src/AccountsUsageSection.tsx:128), quota bars in [AccountsPage.tsx:150](../../app/renderer/src/AccountsPage.tsx:150).

Luna found existing 300ms model/cache bar transitions. Retain useful bar continuity but do not add a second chart entrance. A changed quota bar after a discrete refresh can interpolate over 180-240ms; its number updates immediately. Retarget new values rather than queueing frames, and snap under reduced motion.

A pending-to-ready chart may fade in over 120ms inside its fixed frame. For an explicit range change, update labels immediately and use a short data-region fade only if the old and new scales cannot be confused. Do not morph SVG line paths between different ranges, trace historical lines from zero, animate every bar, or count KPI numbers up. Those motions fabricate intermediate measurements and make comparison slower.

Hover inspectors should be immediate. Keep existing short point/opacity emphasis, but do not animate tooltip travel or replacement at pointer speed. Do not enlarge the role of pointer-only information; accessibility of chart data is a separate concern.

## Surfaces intentionally kept quiet

### Read-only inventories

[GoalsPage.tsx](../../app/renderer/src/GoalsPage.tsx), [MemoryPage.tsx](../../app/renderer/src/MemoryPage.tsx), [SettingsExtensions.tsx](../../app/renderer/src/SettingsExtensions.tsx), and [PermissionRulesEditor.tsx](../../app/renderer/src/PermissionRulesEditor.tsx) should not receive generic page or row-arrival effects.

Subagents suggested new-row fades for goals, memories, and rules. I am not recommending them by default: snapshots and page remounts are not reliably user-meaningful arrivals, and these views are for scanning. Keep IDs, paths, counts, badges, rule strings, hook definitions, plugin versions, and memory summaries static. A confirmed status may use a short color transition where that helps, but it needs no ongoing animation.

A configured MCP server is not an active connection; an enabled plugin or bridge flag is not work in progress. No pulsing status dots for these states. No marketplace shimmer for a view that only explains a terminal action.

### Transcript geometry, source, and editing

[BoundedMarkdown.tsx](../../app/renderer/src/BoundedMarkdown.tsx), [ReadSourceLines.tsx](../../app/renderer/src/ReadSourceLines.tsx), and the editing body of [ComposerInput.tsx](../../app/renderer/src/ComposerInput.tsx) are not animation targets. Keep virtualization, spacer heights, code wrapping, selection, IME composition, paste-pill mutation, caret restoration, and measured height corrections immediate.

The existing prose-arrival system should remain the only delivery effect for newly arrived prose. No second per-message, per-paragraph, or per-leaf entrance. Scrolling old content into view must never make it look newly generated.

### Identity and live telemetry

[AgentChrome.tsx](../../app/renderer/src/AgentChrome.tsx), [Chip.tsx](../../app/renderer/src/Chip.tsx), [SessionActionIcons.tsx](../../app/renderer/src/SessionActionIcons.tsx), and [ContextGauge.tsx](../../app/renderer/src/ContextGauge.tsx) need no decorative motion. Retain a small existing running indicator where appropriate; do not pulse identity and status simultaneously or bounce completion badges.

Keep elapsed time, token counts, context percentage, reference tick, worker counts, recency text, and icon geometry immediate. I reject proposed smoothing of the always-visible context gauge until actual cadence demonstrates a benefit; persistent interpolation could leave the ring behind its number.

### Providers, previews, recovery, and empty states

Keep all preference providers static: AccentThemeProvider, CodeThemeProvider, ColorSchemeProvider, GlassModeProvider, ProseArrivalProvider, and ReasoningLayoutProvider. No global light/dark, accent, translucency, or syntax-palette tween. Prepaint theme synchronization is more important than a fade.

[CodeThemePreview.tsx](../../app/renderer/src/CodeThemePreview.tsx) stays static and reflects the chosen palette immediately. [ProseArrivalPreview.tsx](../../app/renderer/src/ProseArrivalPreview.tsx) already demonstrates the real motion; do not decorate it. For reduced motion, prefer the settled sample instead of an automatic replaying demonstration, while leaving actual transcript delivery honest and immediate.

[RendererErrorBoundary.tsx](../../app/renderer/src/RendererErrorBoundary.tsx) remains a minimal static recovery screen. [EmptyState.tsx](../../app/renderer/src/EmptyState.tsx) needs no loop or generic mount fade. Loading text is not a reason to imply measured progress.

[PathCopyButton.tsx](../../app/renderer/src/PathCopyButton.tsx) already has a clear Copied acknowledgment. Keep it immediate and fixed-width in appearance; no bounce or extra toast animation layered onto the label.

## Coverage ledger

A-S source coverage is established by the returned Luna reports. Each row names the actual production file inspected; internal subcomponents were included rather than inferred from the filename.

| File | Recommended treatment |
|---|---|
| AccentThemeProvider.tsx | Static provider/theme application |
| AccountsPage.tsx | Preserve modal motion; menu entrance; confirmed-result tint; discrete quota continuity |
| AccountsUsageCharts.tsx | Preserve limited bar/hover motion; fixed-frame loaded-state reveal; no chart drawing |
| AccountsUsageSection.tsx | Immediate values and range selection; no count-up |
| AgentChrome.tsx | Small existing activity cue only; static identity |
| AgentsPage.tsx | Refine drawer direction/scrim; static inventory |
| App.tsx | Local overlays/notices only; no shell or route animation |
| AskQuestionFlow.tsx | Optional explicit-step fade; immediate choices and previews |
| BannerStack.tsx | One entrance per genuinely new notice; no loop or height animation initially |
| BoundedMarkdown.tsx | Static virtualized geometry; preserve separate prose-arrival ownership |
| Chip.tsx | Existing short color feedback only |
| CodeThemePreview.tsx | Static accurate preview |
| CodeThemeProvider.tsx | Static provider |
| ColorSchemeProvider.tsx | Immediate prepaint appearance |
| CommandPalette.tsx | Dialog/scrim entrance; static filtering |
| ComposerActionsBar.tsx | Anchored menus; nested model-to-effort step; stable rail |
| ComposerInput.tsx | Paste-preview entrance only; static editing body |
| ContextGauge.tsx | Immediate measured state; no smoothing recommended |
| EmptyState.tsx | Static explanatory content |
| FilePathActionsMenu.tsx | Preserve root pop; directional flyout refinement |
| GlassModeProvider.tsx | Immediate native/renderer appearance coordination |
| GoalsPage.tsx | Static inventory and metrics |
| MemoryPage.tsx | Static memory/instruction inventory |
| MentionPicker.tsx | Panel entrance only |
| MetadataInspector.tsx | Refine drawer/scrim; static detail replacement |
| OrchestratorRoster.tsx | Optional popover reveal; no worker/count cascade |
| PathCopyButton.tsx | Existing immediate acknowledgment |
| PermissionModeChip.tsx | Anchored menu entrance; immediate permission state |
| PermissionPrompt.tsx | Optional short card opacity entrance; stable choices |
| PermissionQueue.tsx | No wrapper/reorder/morph animation |
| PermissionRulesEditor.tsx | Static rules; restrained selected-state color |
| PlanPanel.tsx | Bar/dialog/menu entrances; static plan/approval content |
| ProseArrivalPreview.tsx | Preserve existing demonstration; settle under reduced motion |
| ProseArrivalProvider.tsx | Static provider |
| ReadSourceLines.tsx | Static source/gutters/highlights |
| ReasoningLayoutProvider.tsx | Static provider |
| RemoteSettingsPage.tsx | Confirmed-result reveal; no fictional connection activity |
| RendererErrorBoundary.tsx | Static recovery |
| SAModal.tsx | Preserve entrance; consistent scrim; no child cascade |
| SessionActionDialogs.tsx | Fixed-frame export-ready preview fade |
| SessionActionIcons.tsx | Static glyph vocabulary |
| SessionActionsMenu.tsx | Preserve entrances; directional copy flyout |
| SessionPane.tsx | Queue/attachment/Latest arrival; static input, counters, and scrolling machinery |
| SessionsPage.tsx | Bulk-bar/popover reveal; no search or catalog-refresh reordering animation |
| SettingsEditors.tsx | Existing toggle timing; optional local error reveal |
| SettingsExtensions.tsx | Static inventories; no configuration-as-activity motion |
| SettingsField.tsx | Optional local error reveal; static provenance and controls |
| SettingsShell.tsx | Optional explicit-category body entrance; immediate scope and theme changes |
| Sidebar.tsx | Refine existing motion/reduced-motion; optional bounded group reveal |
| SlashCommandPicker.tsx | Panel entrance only; preserve composer focus |
| StartupSurfaces.tsx | Real OAuth phases; immediate trust choices and input |
| main.tsx | Inspected mounting entrypoint; no independent visual animation |

T-Z and non-TSX UI coverage will be added before this report is finalized.

## Acceptance criteria for any later implementation

This section describes what would need checking, not tests performed for this report.

1. With reduced motion enabled, show final states immediately, including sidebar geometry and explicit Latest navigation. Keep textual activity status.
2. Open/close menus rapidly; type and navigate suggestions continuously. No delayed focus, stale panel, queued transition, or invisible interactive exit layer.
3. Stream a long transcript, scroll away from the bottom, return to old content, restore a session, and switch panes. Old content never reanimates, caret/scroll anchors remain stable, and Stop works immediately.
4. Receive several permissions and questions, then answer/snooze/restore quickly. No option moves underneath the pointer or disappears before real resolution.
5. Refresh catalogs, accounts, and usage data repeatedly. Stable rows and numbers do not pulse, count, or replay entrances.
6. Check keyboard and screen-reader behavior independently of appearance. Focused controls are fully visible immediately; announcements and real state are not deferred to animation completion.
7. Check narrow and split-pane layouts before accepting directional popovers/drawers. Motion follows actual placement, not a presumed direction.
8. Check hover-only surfaces through operator observation; this report did not drive them.

## Report validation

Pending final coverage reconciliation, path checks, whitespace check, and documentation-map lint. Application builds and tests are not needed for a report-only change and were not run. No visual acceptance or source-level independent verification by the author is claimed.
