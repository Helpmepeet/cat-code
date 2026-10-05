# Sidebar pages as tabs

Date: 2026-10-04
Status: Proposed implementation plan, revised after an Opus 5.5 adversarial review and direct source checks; application code is unchanged.

## Goal and size

Opening Goals, Accounts, Analytics, or Settings from the sidebar should open a separate tab beside the session tabs. The user can return to a conversation by selecting its tab, without finding it again in the sidebar.

Revised estimate: medium renderer feature, difficulty 5/10 (initial estimate 4/10). Expect several renderer modules and their tests to change. The complexity is auditing selection writers and proving lifecycle integration, not rendering the four existing pages. No engine, IPC, host API, dependency, or persisted-format change is expected. Preserving extensive page-local editor state or restoring page tabs across launches would increase scope.

The user requested a plan and an adversarial Opus 5.5 subagent review, not implementation. The review completed; application implementation remains outside this task.

## Source observations

- `app/renderer/src/App.tsx` keeps `activeView` independently of `activeSessionId`, constructs tabs from session pane membership, and switches the main body between page components and the chat workspace.
- `app/renderer/src/TabBar.tsx` requires a session descriptor for every tab. Its selection, close, restart, actions, keyboard, and drag contracts are session-specific.
- `app/renderer/src/Sidebar.tsx` offers the four requested destinations but only raises a view-change callback.
- `app/renderer/src/shellState.ts` owns the ordered host roster, session tab membership, and cached previews. It is not the owner of app-page navigation.
- `app/renderer/src/workspaceLayout.ts` stores session-only split panels and their persisted layout. Pages must not become panels or synthetic sessions.
- App's global Command/Ctrl+W closes the retained active session even when a page is visible. Number shortcuts use session-only slots, not a combined tab strip.
- App's `selectTab` already sets the view to chat. Source therefore predicts that clicking an existing session tab returns to chat. The user's report that sidebar selection is needed has not been reproduced in a running app; do not claim its additional cause is established.
- App reports no visible sessions to the host while a page is displayed. This controls idle parking and must remain true.
- Account OAuth progress belongs to App rather than the page, and intentionally survives view changes. Settings uses retained session/project context and also works without a session.
- `tabStatus.ts` suppresses permission attention for a tab considered active. App currently computes that flag from retained session context even when a page hides the pane; mixed navigation must use visible selection instead.
- The command palette can route `/resume` to the existing Sessions page. That reachable internal destination requires a fifth page-tab kind, without adding it to the sidebar.
- Closing the last page must preserve the existing first-run authentication/startup gates. An initialized empty account pool can show sign-in rather than welcome in empty chat mode.

The missing page tabs are verified in source. Failure of an existing session tab to return to chat is a separate, unverified symptom. With operator authorization, reproduce that interaction in the installed build and compare with Cat Code Dev before claiming that symptom fixed. This investigation does not require blocking the independent page-tab feature, but its acceptance report must distinguish the two.

## Proposed behavior

1. Each requested page has at most one open tab per window. First open appends it; later sidebar clicks select the existing tab without moving or duplicating it.
2. A page tab uses the existing shell tab treatment with its page title and an ordinary close control. It has no session status, restart action, session overflow menu, permission badge, or session drag payload.
3. Selecting a page makes only that tab selected. The previous session tab remains available but is not visually or accessibly selected. Selecting a session restores the chat workspace using the existing session focus/layout path.
4. Page tabs occupy the main content area, not a split panel. Existing split assignments and widths remain intact while a page is visible. Split controls are unavailable on page tabs.
5. Closing a page is a renderer-only navigation operation: never close, park, restore, or otherwise issue lifecycle commands for a session. Closing the active tab selects the nearest surviving tab to its left, otherwise the nearest to its right. Closing an inactive tab does not change selection. With no tabs remaining, show the existing empty-chat/startup surface without spawning a session: welcome when eligible, first-run sign-in when required.
6. Closing a session retains existing host close/preview behavior and failure handling. If it is selected, use the same visible-strip neighbor rule after successful closure; a page may be the next selected tab. Closing a background session must not dismiss the active page.
7. Command/Ctrl+W closes the selected tab. Command/Ctrl+1 through 9 follows visible tab order across both kinds. Arrow/Home/End navigation follows that same order with one roving keyboard focus target. Command/Ctrl+T and the plus control retain their existing new-chat behavior.
8. All app entry points for these pages use the same open-or-focus operation, including sidebar, account-health actions, composer account-management links, and command palette navigation. The reachable internal Sessions page follows the same mechanism as a fifth page-tab kind; do not add a new sidebar destination.
9. Keep current durable data owners and page unmount/remount behavior in the initial change. Accounts operations/OAuth progress and Analytics selection already owned by App stay intact. Do not eagerly mount every page or retain hidden editors, effects, listeners, or modal dialogs just to implement tabs. Preserving additional page-local drafts, category/search state, or scroll positions is not promised by this initial plan and must be disclosed.
10. Page-tab membership is window/renderer-lifetime UI state. This change does not promise reopening page tabs after reload or app restart and does not modify saved session or split-layout formats.

These are proposed defaults, not additional behavior approved by the user. Review may identify a necessary adjustment before implementation.

## State and architecture

### Navigation state separate from session ownership

Introduce a small renderer-owned navigation model in a `.ts` module, following the existing pure reducer/selector conventions. Represent session and page targets as a discriminated union with distinct keys. Pages must never be represented by invented `SessionDescriptor` objects or passed into APIs expecting a `SessionId`.

The navigation model owns combined open-tab order and selected target. Reconcile session membership from the filtered display projection: `filterInteractiveSessionDescriptors(selectPaneSessions(shell), sessionCatalogSnapshot)`, not raw shell membership. Catalog-marked noninteractive sessions must not consume invisible keyboard slots or become close fallbacks. Do not duplicate the host registry or change shell lifecycle semantics. Seed session tabs in their existing order. New page tabs and genuinely newly opened/reopened session tabs append in open order. Descriptor/status/title changes and preview-to-live handover for the same ID do not move or duplicate tabs. Session removal removes only the corresponding session target.

Make visible page/chat mode derive from navigation selection rather than allowing a second independent `activeView` writer. Retain App's session context separately: `activeSessionId` remains the last valid focused session for project-aware operations and split layout, not evidence that its tab is visibly selected. Selecting a page must not null that context or tear down session stores. When no session context remains, pages still work using their existing session-free paths.

Pass visible selected-session identity into `deriveTabVisualState`'s `isActive` input. A retained session hidden by a page is a background tab and must show attention for actionable permission requests. Preserve existing status helpers while correcting their inputs; do not rely on TabBar rendering tests with manually precomputed attention values to cover this integration.

Selection correction must distinguish visible selection from session-context repair. Host additions, removals, background frames, parking, previews, and restore completions may update membership/context without stealing selection from a page. A selected session that disappears falls back through the combined visible order. An existing pending-close target remains available until the close succeeds or the authoritative membership transition occurs.

Use current selection and a supersedable foreground-selection claim for asynchronous close, preview fetch, restore, creation, and history-open handling. If the user selects a page while a previous operation is awaiting a host response, that completion must not redirect them to chat. Preserve explicit foreground session-opening intent, but invalidate its focus claim when a newer tab selection supersedes it. Audit split-panel focus/assignment/close callbacks too: user focus within a visible chat workspace updates the selected session tab, whereas background layout/context repair must not replace a page selection.

### Presentation and dispatch

Extend TabBar's presentation contract to accept the two tab variants and the selected target. Keep session-specific rendering and handlers narrowed to session tabs. Reuse its accessibility, scroll-into-view, entrance animation, window drag-region, overflow, and close-control conventions. Change the tablist's accessible name from session-only wording to a suitable mixed-tab name.

Use one combined visible sequence for rendering, arrow focus, numeric shortcuts, and close-neighbor resolution. Keep split-layout and drag-to-split logic session-only. Preserve the session title/status helpers rather than teaching them about page targets.

Route App and palette selected-tab actions through variant-aware dispatch. Session actions that are explicitly named as acting on the retained session may remain session-scoped, but generic tab operations must not silently target it while a page is selected. Inspect palette action names/availability and session overlays to ensure background context is not presented as the visible tab.

## Implementation sequence

1. Add the pure mixed navigation model and tests covering membership reconciliation, order, unique page tabs, selection, and close fallback. Confirm the precise shell events/projections that expose reopened and removed session membership before choosing the reconciliation seam.
2. Adapt TabBar and its static/DOM tests for mixed tabs, selection, keyboard order, close intents, and absence of session controls on pages. Keep existing session-tab behavior covered.
3. Integrate navigation into App without changing host/session stores. Route all page entry points, session focus/create/preview/restore paths, host membership changes, split controls, and selected-tab keyboard/palette actions through the model.
4. Provide a behavioral test seam that includes production selection decisions and their lifecycle joins, not only keyboard dispatch. Prefer a narrow production navigation controller used by App if it can expose roster reconciliation, host-close results, preview/restore/create/history-open completion, and panel-focus decisions without moving unrelated state. Otherwise mount App with a bounded isolated fake preload bridge. Tests must drive deferred responses through the same completion code App uses; neither a keyboard-only adapter nor test-only callbacks are sufficient. Existing App source-text assertions alone are not acceptance evidence.
5. Review stale references to session-only tab assumptions across source, imports, tests, documentation, configuration, and YAML/Markdown. Update the relevant maintained runtime map/design text to describe mixed tabs and any deliberate limitations.
6. Run affected package checks and operator GUI acceptance before claiming the UX is complete. Respect unrelated shared-tree edits and stage only this feature's paths or hunks if implementing later.

## Required behavioral coverage

- Open each requested destination from the sidebar: one page tab appears, receives selection, and shows the correct content.
- Reopen the same destination: no duplicate tab or order change.
- Select the previously focused session while a page is visible, including an already-active retained session: chat becomes visible and its tab becomes selected.
- Open pages with zero session tabs: no engine session is created; closing the last page returns to the existing empty-chat/startup surface. Test credential-ready welcome and synthetic initialized-empty-pool sign-in states without accessing live credentials.
- Close an active and an inactive page with mouse and Command/Ctrl+W: correct fallback, zero session lifecycle calls.
- Numeric and arrow shortcuts select the same tabs in the same displayed order; accessibility reports only the visible tab selected.
- Close a selected session next to a page, including close failure: correct fallback only after success; no optimistic session removal on failure.
- Remove/park/crash/restart a background session while on a page: page remains selected; session status/membership follows existing behavior.
- Resolve pending close, preview fetch, restore, creation, or history-open after the user selects a page: no delayed focus theft. Same-ID preview-to-live transitions keep a single stable tab.
- Open a page while a session streams: session stores continue receiving frames, attention badges remain accurate, and returning shows the accumulated transcript and existing draft.
- Session A is retained as context, a page is visible, then A receives an actionable permission request: its background attention badge appears through the production visual-state calculation.
- A catalog marks a shell session noninteractive: it appears in neither the combined visible sequence, numeric shortcuts, nor close fallback.
- Open a page from a split workspace and return: same split panels/widths, no page drag-to-split, no visible-session protection while the page is displayed.
- Focus another visible split panel: its session tab becomes selected. Session-context or layout repairs while a page is visible leave the page selected.
- Open Accounts from all existing management entry points: they focus the same page tab; app-owned OAuth remains intact across navigation.
- Open Sessions through the existing palette route: it follows the same open-or-focus behavior without a new sidebar item.
- Settings retains existing project-context semantics and works with no session. Test session-context removal while Settings is visible without manufacturing a new context.

Pure navigation tests do not prove App integration. Cover dispatch with actual production helpers, and separately verify the running UX.

## Validation and authorization

Applicable implementation checks from the repository root:

- Focused renderer/navigation/TabBar/Sidebar/App/command-palette/workspace-layout suites as appropriate to the changed code.
- `bun test app/`
- `bun run --cwd app typecheck`
- `bun run --cwd app typecheck:sidecar`
- `bun run --cwd app renderer:build`
- `git diff --check`
- `bun run maps:lint` and changed-link checks if maintained docs change.

No Electron GUI or hardening smoke launch is authorized by the request for a plan/review. If later implementation needs live acceptance, use Cat Code Dev and `docs/migration/process/GUI-VERIFICATION.md`, with authorization covering the launch/drive. Operator acceptance should exercise a real session, each page, keyboard selection/closing, and an existing split workspace. Do not inspect or mutate real account credentials, settings, or tokens to validate tab navigation. Report any missing runtime/GUI evidence explicitly.

For the current plan-only task, validation is documentation checks and source-grounded review, not application tests or runtime claims.

## Adversarial review outcome

An Opus 5.5 subagent reviewed the initial plan read-only. Direct source inspection in the main session confirmed the substantive issues: retained session context suppresses hidden-session permission attention; empty chat can display first-run sign-in rather than welcome; and the behavioral test seam must cover delayed lifecycle completions and panel focus, not only keyboard dispatch. The plan now explicitly covers these cases, uses the filtered displayed-session membership, and includes the already-reachable Sessions destination.

The review did not establish a need for engine/IPC changes or a parking redesign. Parked sessions retain their existing tab membership. The installed-app session-tab symptom and mixed-tab GUI behavior remain unverified. The revised plan has not received a second independent review.
