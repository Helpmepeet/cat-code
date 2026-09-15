# UX and interaction polish report

**Date:** 2026-09-15

**Scope:** Existing Electron desktop experience. Recommendations only.

**Recommendation:** Start with clearer action feedback and stable controls. Then improve loading continuity and align the motion already in the app.

## Summary

The best return is in the moments between an action and its result: attaching an image, changing an account, copying text, saving a setting, and waiting for data. Several of these operations already work but offer uneven acknowledgment. Another useful pass is keeping titles, buttons, and reading positions steady as their surrounding state changes.

I would start with **items 1–4**, then address **loading stability and reduced motion** before adding more entrances. Springs and bounce are a small optional finishing touch; they are unlikely to improve the experience as much as these changes.

| Priority | Where | Proposed polish | Relative effort |
|---|---|---|---|
| P1 | 1. Composer and attachments | Explain preparation and disabled Send; improve immediate feedback | Small |
| P1 | 2. Account actions | Show pending actions and preserve the dialog on failure | Medium |
| P1 | 3. Copy controls | Consistent confirmation, stable width, and visible failure | Small |
| P1 | 4. Session tabs | Remove hover-driven width changes; keep selected tabs visible | Medium |
| P1 | 5. Accounts, Sessions, Usage | Stabilize loading and refresh layouts | Medium |
| P1 | 6. Reduced motion | Cover transitions, explicit scrolling, and the animated preview | Medium |
| P2 | 7. Settings edits | Put save progress and results beside the edited control | Medium |
| P2 | 8. Shared controls | Align hover, press, focus, and disabled treatments | Small |
| P2 | 9. Menus and overlays | Apply the existing bounded entrance specification | Medium |
| P2 | 10. Transcript navigation | Verify and refine the handoff from Latest to bottom-follow | Investigation first |
| P2 | 11. Notifications | Keep confirmations readable during hover and keyboard focus | Small–medium |
| P3 | 12. Page rhythm and empty states | Align comparable spacing and make existing recovery actions clearer | Small–medium |

P1 means the first polish pass; it does not label every item a correctness bug. Effort is comparative, not a delivery estimate.

## Evidence and limits

This is a **source-based review**, not a record of observed GUI defects. I inspected current renderer components, styles, and relevant state owners, including working-tree changes present during the review. HEAD was `50c015cc` when recorded; the shared tree was changing, so that commit alone does not reproduce every inspected file. Perceived speed, painted focus, frame rate, and the size of visual shifts still need live validation.

The earlier [animation opportunities report](2026-09-06-desktop-animation-opportunities.md) and [September 11 animation specification](../plans/2026-09-11-desktop-animation-additions-spec.md) provide useful context. This report broadens the review to feedback, loading, recovery, and layout stability. The existing specification remains the detailed reference for its selected animation additions.

Two historical suggestions already have newer treatments in the inspected source: sidebar footer destinations are directly available, and Welcome account usage has a loading rail. The old footer stagger is not a current finding. New Accounts, Usage, Welcome, and Sidebar work should be rechecked before implementing recommendations against those files.

## 1. Composer: explain what happens after attaching an image

**What exists:** `SessionPane` tracks image preparation and disables Send and Attach during it. Preparation failure appears above the composer. A second attachment attempt or submission can produce “Wait for the image to finish attaching.” The normal pending state has no corresponding visible preparation label. The Send button has a color transition but no explicit hover fill or pressed treatment; Stop has a hover fill.

**What I would change:** Show a quiet “Preparing image…” status beside the attachment area while the existing preparation flag is true. Keep its icon/status slot stable, and show the thumbnail as soon as preparation succeeds. Explain disabled Send for preparation or connection readiness through a nearby status and accessible description. An empty draft can remain quietly disabled. Give Send a restrained hover fill and immediate pressed color feedback while keeping its position fixed.

**Check:** Paste a large image, type while it prepares, and exercise success and failure. It should be clear why Send is unavailable; the draft, caret, and Send/Stop slot should stay stable. No success checkmark should appear before preparation succeeds.

**Owners:** [SessionPane.tsx](../../app/renderer/src/SessionPane.tsx), `attachImage`, attachment rendering, Send/Stop; [ComposerActionsBar.tsx](../../app/renderer/src/ComposerActionsBar.tsx), attachment control.

## 2. Accounts: make pending actions and failures local

**What exists:** `AccountsPage.submit` stores a pending request in a ref and waits for the correlated result. The ref does not render a busy state. Rename is disabled for validation errors, but receives no pending prop. The completion callback toasts the result and calls `setDialog(null)` for both success and failure.

**What I would change:** On Rename, Switch, and other existing account actions, show a fixed-width “Renaming…” or “Switching…” state on the initiating control. Prevent duplicate submissions of that operation while it is pending. Close a dialog after confirmed success; keep it open with its entered values and an inline error after failure. Keep the existing confirmation requirements for destructive operations.

**Check:** With a delayed result, one activation produces one request and visible acknowledgment. A refused rename retains the alias for correction. A successful rename closes once and updates the account display. Another account's update must not complete the pending action.

**Owners:** [AccountsPage.tsx](../../app/renderer/src/AccountsPage.tsx), `submit`, `RenameAccountDialog`, `pendingRef`.

## 3. Copy: one recognizable confirmation pattern

**What exists:** Quote copy resets after 600 ms; code and path copy use 1,200 ms; response copy uses 1,300 ms. Path copy reports clipboard failure, while quote, code, and response controls silently return or swallow rejection. `PathCopyButton` changes from “Copy” to “Copied” without reserving the longer label's width.

**What I would change:** Use a common confirmation duration around 1,200–1,500 ms, with the same checkmark/color treatment and accessible confirmation. Keep label-based buttons wide enough for both states. Report clipboard failure consistently through the existing notification mechanism. Restart the confirmation timer on another successful copy so an older timer cannot erase newer feedback. Retain a toast where the local tick may be missed, such as response copy; avoid adding an extra toast to every small control by default.

**Check:** Copy twice rapidly, move the pointer away, and simulate clipboard rejection. The last successful copy receives the full acknowledgment interval, neighboring text does not shift, and failure is visible.

**Owners:** [TranscriptView.tsx](../../app/renderer/src/TranscriptView.tsx), `QuoteCopyChip`, `CodeBlock`, `BubbleCopyChip`; [PathCopyButton.tsx](../../app/renderer/src/PathCopyButton.tsx).

## 4. Tabs: hold the pointer target and title geometry steady

**What exists:** The close control expands from width 0 to 18 px on hover/focus using `transition-all`. The actions control is mounted only on the active tab. These controls participate in the tab's flex layout. The tab strip scrolls horizontally and keyboard arrows focus the selected tab; there is no explicit reveal path for an active-tab change coming from elsewhere.

**What I would change:** Reveal close/actions inside a stable tab box, using an overlay and a local text mask if needed, so hovering does not resize neighboring tabs or reflow the title. Preserve as much title space as possible at rest. Reveal controls immediately for keyboard focus. When a sidebar selection or shortcut activates an off-screen tab, reveal just that tab with nearest-edge scrolling.

**Check:** Use many long titles, cross adjacent tabs with the pointer, close several tabs, and activate an off-screen session from the sidebar. The intended target should stay under the pointer, and the active tab should be visible. Check the crowded strip in the actual app before choosing the final overlay geometry.

**Owner:** [TabBar.tsx](../../app/renderer/src/TabBar.tsx), `Tab`, tab refs, horizontal strip.

## 5. Loading and refresh: keep the page recognizable

**What exists:** Accounts initially replaces its pools with a centered loading card. Sessions uses `EmptyState` for initial loading and inserts a history-loading notice above existing rows. Usage retains its snapshot while refreshing, which is good, but inserts/removes status paragraphs above the cards; `.usage-status:empty` removes that block. Its chart panels are conditional on having a usable summary. Welcome already reserves a usage region with a loading rail.

**What I would change:** Keep headings, toolbars, and major section frames mounted during initial loads. Use neutral placeholders that resemble the eventual rows/cards without implying real accounts, counts, or zero usage. Put brief refresh status in a stable header/status slot so a routine refresh does not push the page down and back up. Preserve existing data while refreshing, with its freshness/error label. For actionable errors, allow readable wrapping instead of forcing all messages into a tiny fixed-height slot.

For Usage, give the selected-day readout a consistent small minimum height; it currently has a maximum height but can expand from an empty body when a day is selected.

**Check:** Compare initial loading, fast success, slow success, refresh, empty history, and failure at narrow and normal widths. Existing data should remain readable during refresh, and surrounding controls should not move for routine progress text. Never delay ready data just to complete a skeleton animation.

**Owners:** [AccountsPage.tsx](../../app/renderer/src/AccountsPage.tsx), `WaitingState`; [SessionsPage.tsx](../../app/renderer/src/SessionsPage.tsx), catalog notice and `SessionsEmptyState`; [UsagePage.tsx](../../app/renderer/src/UsagePage.tsx); [usageDashboard.css](../../app/renderer/src/usageDashboard.css), `.usage-status`, `.usage-day-readout`. Existing reference: [WelcomeScreen.tsx](../../app/renderer/src/WelcomeScreen.tsx), `UsageLoadingRail`.

## 6. Reduced motion: make the existing preference complete

**What exists:** The reduced-motion media rule disables named animations, including activity indicators and prose fades. It does not disable ordinary transition utilities. Sidebar width, tab close width, and toggle translation therefore fall outside that rule. `jumpToBottom` explicitly requests smooth scrolling. `ProseArrivalPreview` continues its interval-driven text replacement independently of the CSS preference.

**What I would change:** Make spatial transitions and transition delays settle immediately under reduced motion. Make Latest use direct scrolling in that mode. Show a settled prose sample instead of repeatedly clearing and rebuilding it. Keep actual status changes and all focus, measurement, and scroll-correction scheduling working.

**Check:** Enable reduced motion before opening the app and toggle it while a surface is moving. All content should reach its final state without an old effect replaying when the preference changes back. Streaming and scroll anchoring must still function.

**Owners:** [theme.css](../../app/renderer/src/theme.css), reduced-motion rule; [SessionPane.tsx](../../app/renderer/src/SessionPane.tsx), `jumpToBottom`; [ProseArrivalPreview.tsx](../../app/renderer/src/ProseArrivalPreview.tsx); [SettingsEditors.tsx](../../app/renderer/src/SettingsEditors.tsx), `ToggleSwitch`; [Sidebar.tsx](../../app/renderer/src/Sidebar.tsx).

## 7. Settings: confirm the edit beside the field

**What exists:** Engine-backed controls derive their values from snapshots. `sendSettingWrite` creates a request ID, but the editor has no field-level pending/result state. Failed acknowledgments already generate a toast; successful values arrive through a refreshed snapshot. `Field` conditionally adds reset and error content, which can also change row height.

**What I would change:** Add a compact field status slot: “Saving…”, then a brief “Saved”, or a persistent local failure message. Correlate it with the existing request ID and the target field/scope. Keep the status and reset affordance from changing the row's control alignment. Preserve snapshot truth and avoid presenting an unconfirmed toggle position as a successful save. Apply this to asynchronous engine-backed writes; renderer-local appearance preferences need no artificial saving phase.

**Check:** Delay or reject a write, change scope, and navigate away and back. Feedback must stay attached to the correct edit and must not replay as a new success. A successful write should not produce a page-wide visual disturbance.

**Owners:** [SettingsEditors.tsx](../../app/renderer/src/SettingsEditors.tsx), `SettingEditor`, `SettingControl`; [SettingsField.tsx](../../app/renderer/src/SettingsField.tsx), `Field`; [App.tsx](../../app/renderer/src/App.tsx), `sendSettingWrite`; [verbAckResultState.ts](../../app/renderer/src/verbAckResultState.ts).

## 8. Shared controls: consistent hover, press, and focus

**What exists:** Most inspected buttons have hover colors, but Send, account primary actions, modal actions, and small chrome controls use different treatments. Explicit focus rings exist on some menus and transcript actions; other controls depend on their local or browser treatment. Small actions range from 18 px tab controls to 22 px chrome controls and the 30 px Send/Stop slot.

**What I would change:** Define a small set of shared interaction styles for primary, secondary, destructive, and icon controls. Use a consistent visible focus treatment and an immediate pressed color. Where space permits, enlarge small hit areas around the existing glyph without increasing the visual icon size or overlapping another target. Disabled controls should suppress hover/press feedback and explain surprising restrictions.

An optional tiny compression of a decorative glyph on press could be tested after these basics. Keep its button hitbox fixed. A quick, well-damped release is sufficient; overshoot on Stop, permission choices, text, or scrolling content would work against precision. No spring dependency is needed for the first pass.

**Check:** Use pointer and keyboard across Send, modal actions, account actions, and icon controls in both color schemes. Focus should be immediately apparent and pressing should register without moving the target.

**Owners:** [SAModal.tsx](../../app/renderer/src/SAModal.tsx), `SAButton`; [ComposerActionsBar.tsx](../../app/renderer/src/ComposerActionsBar.tsx), chip styles and `MENU_FOCUS_RING`; [SessionPane.tsx](../../app/renderer/src/SessionPane.tsx); [AccountsPage.tsx](../../app/renderer/src/AccountsPage.tsx); [theme.css](../../app/renderer/src/theme.css).

## 9. Menus and overlays: finish the existing entrance work

**What exists:** Session/file actions already pop in. Shared session dialogs use a pop; Tasks and metadata inspection use toast-style entrance motion. Composer model/effort/account menus, the command palette, the plan overlay, and full-output inspection have no equivalent explicit entrance in the inspected owners.

**What I would change:** Use the [existing animation specification](../plans/2026-09-11-desktop-animation-additions-spec.md) for the selected menus and overlays: short menu opacity acknowledgment, and scrim/shadow treatment for dialogs and measured output. This provides a bounded starting point without moving reading content. Harmonizing older dialog recipes can be a later, separate refinement.

**Check:** Open with mouse and keyboard, type immediately, dismiss immediately, and reopen quickly. Input/focus and dismissal must never wait for motion. Filtering or refreshing results must not restart the entrance. Keep approval options readable and available immediately.

**Owners:** [ComposerActionsBar.tsx](../../app/renderer/src/ComposerActionsBar.tsx), `POPOVER_PANEL` consumers; [CommandPalette.tsx](../../app/renderer/src/CommandPalette.tsx); [PlanPanel.tsx](../../app/renderer/src/PlanPanel.tsx); [TranscriptView.tsx](../../app/renderer/src/TranscriptView.tsx), `ToolInspectorOverlay`; shared [composerPopover.ts](../../app/renderer/src/composerPopover.ts) and [overlayFocus.ts](../../app/renderer/src/overlayFocus.ts).

## 10. Transcript scrolling: verify Latest before changing the follow system

**What exists:** The renderer already restores row-based reading positions, corrects measured heights, and releases bottom-follow when the reader scrolls upward. Latest requests smooth scrolling and immediately sets bottom-follow true; another effect writes `scrollTop = scrollHeight` when that state changes. Those paths may compete during the requested smooth journey. This is a runtime question, not a demonstrated jump.

**What I would change:** First observe that specific handoff with a long transcript and active streaming. If it snaps, make the explicit Latest journey and subsequent follow mode cooperate, while allowing user scroll input to interrupt the journey. Preserve instant session restoration and necessary height corrections. Do not add smooth scrolling to automatic token delivery or height compensation.

**Check:** Scroll well above the end during a response, choose Latest, interrupt with the trackpad, expand a tool result, load earlier history, and switch sessions. Text should stay under the reader's eye when they have chosen to read back. Repeat with reduced motion.

**Owners:** [SessionPane.tsx](../../app/renderer/src/SessionPane.tsx), `jumpToBottom`, bottom-follow effect; [paneAnchorModel.ts](../../app/renderer/src/paneAnchorModel.ts); [transcriptScrollMemory.ts](../../app/renderer/src/transcriptScrollMemory.ts); [markdownScrollCoordinator.ts](../../app/renderer/src/markdownScrollCoordinator.ts).

## 11. Notifications: give the user time to read them

**What exists:** Toasts already enter over 180 ms, stack to a maximum of five, and normally expire after 3,200 ms. Their timers do not pause on hover or focus. Removal immediately changes the stack. Each toast is itself a dismiss button.

**What I would change:** Pause expiration while a notification is hovered or keyboard-focused, then resume the remaining duration. Keep important recoverable errors beside the action that caused them, with the toast as supplemental feedback. Preserve immediate deliberate dismissal. Keep the existing entrance; a new exit-animation lifecycle is unnecessary for this pass.

**Check:** Trigger several notifications, hover one near expiry, and tab to one. It should remain readable while engaged. Dismissing a focused notification should leave focus at a sensible surviving destination.

**Owners:** [ToastHost.tsx](../../app/renderer/src/ToastHost.tsx), timer lifecycle and `ToastViewport`; [toastModel.ts](../../app/renderer/src/toastModel.ts).

## 12. Page rhythm and empty states: a small finishing pass

**What exists:** Sessions and Accounts use 28 px page gutters and 18 px headings; Usage uses 20 px padding and a 24 px heading. Their content widths serve different content. Sessions already distinguishes loading, no matches, no tag matches, and no sessions, but filtered empty states offer only “Try a different filter.” The command palette also changes result-body height freely down to its no-match message.

**What I would change:** Align comparable page headers, outer gutters, and toolbar spacing while retaining widths suited to each page. Do a visual comparison before choosing final values. Put a direct clear-search/filter action in the filtered Sessions empty state, using the existing filter state. Consider a modest minimum height for the command palette result region so brief searches do not repeatedly move its footer; keep results immediate.

**Check:** Navigate among Accounts, Sessions, and Usage at the same window size; then repeat narrow. Headers should have a consistent rhythm, controls should wrap cleanly, and an empty search should have an obvious recovery. Palette keyboard selection and nearest-row scrolling should remain immediate.

**Owners:** [SessionsPage.tsx](../../app/renderer/src/SessionsPage.tsx), header and `SessionsEmptyState`; [AccountsPage.tsx](../../app/renderer/src/AccountsPage.tsx); [usageDashboard.css](../../app/renderer/src/usageDashboard.css); [EmptyState.tsx](../../app/renderer/src/EmptyState.tsx); [CommandPalette.tsx](../../app/renderer/src/CommandPalette.tsx).

## Motion and feedback targets

These are design starting points for a later implementation, not measured performance results or replacements for the September 11 specification.

| Interaction | Starting target |
|---|---|
| Hover and color feedback | 80–120 ms; keyboard focus immediately readable |
| Press acknowledgment | Immediate color; optional decorative glyph settlement within 100–140 ms |
| Selected menu entrance | Existing specification: 120 ms, near-opaque, no travel |
| Selected dialog/inspector chrome | Existing specification: 160–180 ms; scrim 120 ms |
| Local success acknowledgment | Hold around 1,200–1,500 ms after confirmed success |
| Data and keyboard selection | Available immediately; no animation-induced delay |
| Reduced motion | Final geometry immediately; real state updates continue |

Share named durations/easing and explicit transition properties where repetition justifies it. Do not turn `transition-all` into the general interaction policy.

## Existing polish to preserve

- Prose arrival is already configurable and uses newly delivered text. Avoid a second entrance on messages or virtualized remounts.
- Scroll memory and height correction already protect the reader's place. Preserve their measurement coordinates.
- The composer already uses a fixed Send/Stop slot, a growing input with a height cap, and a separate overflow region for notices and permissions.
- Sidebar expansion already has hover intent delays and disables its width transition during manual resizing. Its current footer keeps destinations directly available; further timing changes need a live feel check.
- Welcome usage already has a reserved loading region, and Usage already retains data during refresh. Extend those useful patterns.
- Worker and compaction indicators already convey activity. Additional loops, card pulses, or completion bounce would add noise.

## Suggested delivery order and acceptance

1. **Feedback pass:** composer readiness, account action lifecycle, copy consistency, and tab geometry. These affect frequent actions and can be checked independently.
2. **Stability pass:** page loading/refresh, settings acknowledgment, and reduced-motion coverage. Investigate the Latest handoff in this pass.
3. **Visual consistency pass:** shared control states, selected menu/overlay entrances, notifications, and page spacing.

For an implementation, verify actual painted behavior in **Cat Code Dev** using the repository's [GUI process](../migration/process/GUI-VERIFICATION.md). Check pointer and keyboard use, both color schemes, reduced motion, narrow/split layouts, fast repeated actions, and delayed/refused results. Use isolated state for failure scenarios. Test feedback against actual acknowledgments; preserve drafts, active work, and permission semantics.

This report changes documentation only. No application behavior was modified or GUI behavior certified.

**Documentation validation:** All 46 relative links resolve. Whitespace validation passed. Workspace map lint passed with seven existing recommended-section warnings in other map files.
