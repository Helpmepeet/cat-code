# Session attention and native notification UX design

**Status:** proposed 2026-09-15 after a product debate and a separate user-roleplay review; not implemented.

## Decision

Cat Code should not begin with a generic macOS notification that merely restores the app. The first feature should be durable per-session attention state in the tab bar and Sidebar. Native notifications should be a second layer over that state, and should ship only when they can identify and open the originating session and truthfully represent a stable user-actionable state.

The sequence is:

1. Add a persistent **New response** marker to background sessions.
2. Keep blocking attention, such as a permission request, visually stronger than a new response.
3. Clear attention only when the session is actually visible while Cat Code is focused.
4. Add opt-in native notifications after stable readiness and click-through navigation have a reliable owner.

If the second stage cannot prove stable readiness or select the originating session, defer it. The in-app marker is useful on its own; a generic native alert without provenance is not.

### Relationship to the earlier quality-of-life proposal

The 2026-08-31 quality-of-life survey independently identified both missing
capabilities. It ranked an OS notification plus Dock badge as a small Tier-1
feature and cross-tab attention as medium because truthful unread state needs
per-session watermarks and replay deduplication
([`docs/plans/2026-08-31-quality-of-life-feature-proposals.md:86-107`](../plans/2026-08-31-quality-of-life-feature-proposals.md#L86-L107),
[`docs/plans/2026-08-31-quality-of-life-feature-proposals.md:231-250`](../plans/2026-08-31-quality-of-life-feature-proposals.md#L231-L250)).

This design deliberately reverses that delivery order after user-roleplay
review. A native alert that cannot reveal its origin creates a scavenger hunt,
and a notification throttle without durable per-session state loses events.
The medium-sized attention owner is therefore a prerequisite for the smaller
native shell. This report does not reclassify durable unread state as a tiny
renderer tweak.

## User problem

Cat Code supports several concurrent agent sessions, but its attention model is incomplete:

- A background permission request can pulse on a tab through `needsAttention` ([`app/renderer/src/tabStatus.ts:29-41`](../../app/renderer/src/tabStatus.ts#L29-L41)).
- A completed background turn has no equivalent unread or new-response state. The tab falls back to its lifecycle dot ([`app/renderer/src/TabBar.tsx:323-327`](../../app/renderer/src/TabBar.tsx#L323-L327)).
- Sidebar session rows show a live-only green dot, not recent activity ([`app/renderer/src/Sidebar.tsx:1782-1796`](../../app/renderer/src/Sidebar.tsx#L1782-L1796)).
- The Notifications pane explicitly says only in-window toasts exist today ([`app/renderer/src/SettingsShell.tsx:750-756`](../../app/renderer/src/SettingsShell.tsx#L750-L756)).

This leaves two common workflows unsupported:

1. Cat Code is focused on session A while session B finishes. The user must remember to poll B.
2. Cat Code is unfocused while one or more sessions change. A generic alert can summon the user, but without an in-app origin marker it creates a search problem after they return.

The job of this design is not to announce every engine event. It is to answer two user questions:

- **Which session changed while I was elsewhere?**
- **Does this session need me now?**

## Experience principles

### Attention must have an origin

Every attention signal belongs to one session. The tab and Sidebar row for that session remain marked until it is viewed. Native notification activation selects that session when there is one origin.

### Blocking outranks informational

A permission request or question blocks progress. A new response is informational. They must not look equally urgent:

1. **Action required:** pulsing attention signal.
2. **New response:** steady attention signal.
3. **Lifecycle:** existing live, busy, warning, or dead status dot.

Only the first state moves. Motion remains reserved for work that cannot continue without the user.

### Seen means visible, not selected in storage

A session is seen only when its pane is visible and the application window is focused. This definition handles split panes correctly and avoids clearing a marker merely because a stale active-session ID exists.

The marker is not cleared by:

- hovering a row;
- opening a row menu;
- restoring the application while another session remains active;
- receiving replayed history;
- a background lifecycle transition.

### Notifications report user state, not engine trivia

A raw `turn.status` transition is insufficient. An aborted turn also emits its terminal `turn.status` before its final abort classification ([`src/app-runtime/AppSessionController.ts:236-250`](../../src/app-runtime/AppSessionController.ts#L236-L250)). A successful result may also be followed by another goal-driven turn because the scheduler wakes after a turn settles ([`src/app-runtime/attachThreadGoalScheduler.ts:183-239`](../../src/app-runtime/attachThreadGoalScheduler.ts#L183-L239)).

Therefore native copy must not say **done**, **work finished**, or **ready** until the application can prove that the session has settled waiting for the user. Replayed events are never new activity; the wire already marks restored history for notification suppression ([`app/shared/protocol.ts:992-1004`](../../app/shared/protocol.ts#L992-L1004)).

### Private by construction

macOS notification text never contains:

- prompts or responses;
- session or project names;
- working directories;
- account or model names;
- tool names, arguments, or results;
- error details.

The internal session ID may be retained solely for click-through navigation. It is never placed in displayed notification content.

## Stage 1: persistent in-app attention

### State model

Each session has independent attention facts rather than one overloaded status:

| Fact | Meaning | Cleared when |
|---|---|---|
| `newResponse` | A live, non-replayed turn outcome arrived while the session was not seen | Its pane is visible while the app is focused |
| `actionRequired` | A live permission, question, or other supported blocking request awaits the user | The underlying request resolves |
| `lifecycle` | Existing host and transport status | Existing lifecycle rules |

These facts are composed at read time. They should not mutate transcript rows or reinterpret stored history.

`actionRequired` remains derived from the real pending-request owner. The existing permission selector already counts unresolved requests and drives background tab attention ([`app/renderer/src/permissionState.ts:317-332`](../../app/renderer/src/permissionState.ts#L317-L332)). `newResponse` is a separate renderer state keyed by `appSessionId`.

### Event rules

Set `newResponse` when all of the following are true:

1. A live event belongs to the session.
2. It represents a terminal outcome for the current turn under the existing SDK message contract.
3. The event is neither restored replay nor history loaded earlier.
4. The session pane is not presently visible in a focused Cat Code window.

Do not infer success from `inputEnabled`. Do not create attention from attach-time snapshots, restored transcript rows, or lifecycle reconnects.

When a terminal failure has a dedicated user-actionable surface, it may later receive stronger treatment. The first slice should mark that new activity exists without inventing a failure taxonomy.

### Seen rules

Clear `newResponse` when:

- the user selects the session while Cat Code is focused;
- a split-pane layout makes the session visible while Cat Code is focused; or
- focus returns to Cat Code and the session is already visible.

Focus and visibility transitions need explicit renderer state. Current renderer source has no existing `document.hasFocus()` or visibility listener to reuse, so this must be a small owned seam rather than scattered checks.

### Persistence

The marker should survive renderer reload and application restart until the session is seen. Persist only a versioned, bounded map of session IDs and attention booleans. Store no transcript content, titles, paths, timestamps from model events, or notification text.

Prune entries when a session leaves the live-or-restorable catalog, and cap retained entries so malformed or stale storage cannot grow without bound. A corrupt or unknown storage version degrades to no restored markers and does not prevent startup.

### Visual language

Reuse the existing leading status-dot lane in both tabs and Sidebar rows. Do not add a second badge column, counter bubble, or text chip that competes with session identity.

- **Lifecycle:** existing 6 px tone dot.
- **New response:** steady accent dot with a quiet outer ring. No animation.
- **Action required:** existing pulsing accent treatment, with an accessible reason.

Priority is `action required > new response > lifecycle`. If a permission request arrives on a session that already has a new response, resolving the permission reveals the still-unread response marker rather than erasing it.

The distinctive element is one shared **attention beacon** grammar across tab and Sidebar. It uses Cat Code's existing accent and tone tokens, existing typography, and existing dot lane. No new palette, type scale, card, or decorative surface is introduced.

Accessible labels and tooltips use direct language:

- `New response`
- `Permission request waiting`
- `Answer needed`

The session row or tab `aria-label` includes the active reason. Color and motion are never the only signal.

## Stage 2: native macOS notifications

### Settings experience

Notifications remain opt-in and default off. Do not request macOS notification permission until the user enables the setting.

Under **Settings → This app → Notifications**, replace the current placeholder with:

- Toggle: **Notify when a session needs attention**
- Description: **Shows private notifications for long-running responses and requests that need your input. Prompts, responses, project names, and session names are never included.**
- Select: **Notify after**
  - **1 minute**
  - **5 minutes**
  - **15 minutes**

The duration applies to successful long-running responses only. Blocking requests do not wait for it.

The existing rail already describes Notifications as how the app reports a finished turn ([`app/renderer/src/settingsScope.ts:342-346`](../../app/renderer/src/settingsScope.ts#L342-L346)), but Settings opens in the user scope rather than the app scope ([`app/renderer/src/SettingsShell.tsx:153-166`](../../app/renderer/src/SettingsShell.tsx#L153-L166)). Search should therefore match the toggle label, description, and `Notifications` destination. A one-time hint is optional only after a qualifying unfocused long turn; it must be dismissible and must not request OS permission itself.

### Notification triggers

A success notification requires all of:

1. Notifications are enabled.
2. Cat Code is unfocused.
3. A non-replayed turn exceeds the selected duration.
4. The session has settled in a state that is waiting for the user.
5. No automatic continuation or queued work has taken ownership of the session.
6. Its in-app `newResponse` marker has been retained.

An action-required notification is immediate when a supported blocking request arrives in an unfocused window. Its in-app marker remains the durable source of truth even if the OS notification cannot be shown.

Do not implement stable readiness as an arbitrary delay after a result. A delay may hide common races but cannot prove that a goal scheduler will not wake later. If the current app-owned activity vocabulary cannot express stable user-actionable state, add that truthful state at its owner or defer success notifications.

### Notification copy

For one stable session:

- Title: **Cat Code**
- Body: **A session is ready for you.**

For one blocked session:

- Title: **Cat Code**
- Body: **A session needs your attention.**

For grouped sessions:

- **3 sessions are ready for you.**
- **3 sessions need your attention.**

These messages describe the user's next action without claiming the overall goal or job is complete.

### Activation

Clicking a single-session notification must:

1. restore the existing window if minimized;
2. focus the window;
3. select and reveal the originating session;
4. leave the marker visible until the focused pane has rendered that session.

The existing second-instance handler already restores and focuses the window ([`app/main/main.ts:3631-3636`](../../app/main/main.ts#L3631-L3636)). Session selection is additional behavior and needs an explicit bounded main-to-renderer event. If the session no longer exists, focus the app without creating or impersonating a replacement session.

Clicking a grouped notification restores and focuses Cat Code without choosing one arbitrary session. Every originating tab and Sidebar row remains marked, so the user can work through them.

### Coalescing

Do not silently discard qualifying sessions behind a process-wide cooldown. During a cooldown window, collect unique session IDs and update or replace the notification with an aggregate count when the platform permits. Regardless of OS behavior, retain each session's in-app marker.

The native layer is an interrupt hint. The in-app attention state is the record.

## Ownership and trust boundaries

The renderer owns knowledge of which panes are visible and whether a response has been seen. Electron main owns the native notification side effect and window restoration. The engine or sidecar must own the truth that a session has settled and no automatic continuation is active.

The final implementation path must preserve these rules:

- The renderer never authors notification title or body text.
- Main accepts only closed reason enums and validated session IDs if an inbound notification request exists.
- Main enforces enablement, focus checks, coalescing, and rate bounds at the receiving boundary.
- Displayed content is fixed in trusted code.
- A compromised renderer cannot generate unbounded native notifications.
- Raw model output and operational logs never enter OS notification payloads.
- Any new inbound protocol kind receives closed validation plus valid and invalid boundary tests, as required by the desktop protocol rules.

There is one architecture decision to resolve before Stage 2: how main obtains trustworthy stable-readiness state without duplicating engine semantics. Main currently forwards raw session events but deliberately does not own the engine's `turn.status` vocabulary. A small dedicated app-owned attention snapshot from the sidecar may be safer than teaching main to infer readiness from message ordering. A renderer-authored request is acceptable only if main can independently constrain and correlate it. This decision is not needed for Stage 1.

## Interaction scenarios

### Background tab finishes while Cat Code is focused

1. Session A is visible; session B produces a live terminal outcome.
2. B receives a steady new-response beacon in its tab and Sidebar row.
3. No native notification appears because Cat Code is focused.
4. Selecting B clears its marker after B is visible.

### Visible split-pane session finishes

1. Sessions A and B are both visible while Cat Code is focused.
2. B finishes.
3. No unread marker is created because the response was already visible.

### Long turn settles while Cat Code is unfocused

1. B exceeds the configured threshold and settles waiting for the user.
2. B receives an in-app marker.
3. macOS shows **A session is ready for you.**
4. Clicking restores Cat Code and selects B.
5. The marker clears only after the focused pane shows B.

### Automatic goal continuation starts

1. B produces a successful turn result.
2. The goal scheduler takes another turn.
3. B may retain new-response state according to Stage 1's event rule, but no native **ready** notification appears.
4. Notification eligibility is reconsidered only when app-owned state proves B has settled.

### Permission arrives while unfocused

1. B emits an engine-owned permission request.
2. B receives the pulsing action-required beacon.
3. macOS immediately shows **A session needs your attention.**
4. Clicking selects B and exposes the real permission surface.

### Several sessions settle together

1. B, C, and D become eligible during the coalescing window.
2. Each retains its own in-app marker.
3. macOS shows **3 sessions are ready for you.**
4. Clicking focuses Cat Code; it does not choose one session arbitrarily.

### Renderer reload and history replay

1. Existing unread markers restore from bounded local state.
2. Replayed event frames rebuild transcripts without creating new markers or notifications.
3. Visible focused sessions clear their restored markers after rendering.

## Acceptance criteria

Stage 1 is acceptable when:

- a background live result marks exactly its originating tab and Sidebar row;
- the marker survives navigation, renderer reload, and application restart;
- replay and load-earlier events never create attention;
- a visible focused split pane does not become unread;
- selecting a session while the app is unfocused does not falsely clear it;
- action-required attention visually outranks and does not destroy new-response state;
- labels expose the distinction without relying on color or animation;
- corrupt persisted state fails harmlessly and boundedly.

Stage 2 is acceptable when:

- the setting is off by default and macOS permission is not requested before opt-in;
- success notifications require stable user-actionable state rather than a raw turn boundary;
- blocked notifications do not wait for the long-turn threshold;
- no displayed notification contains user, project, session, model, account, tool, or response content;
- clicking a single-origin alert selects that session;
- grouped or throttled alerts preserve every origin through in-app markers;
- replay, abort, reconnect, and immediate goal continuation do not produce false **ready** alerts;
- notification requests and activation events are bounded and validated at their receiving boundaries.

## Verification plan

The implementation should be verified at the lowest owner for each risk:

- pure reducer tests for set, priority, clear, restore, corruption, and pruning;
- renderer DOM tests for tab and Sidebar visuals, accessible labels, focus, visibility, split panes, and activation;
- protocol or host-boundary tests accepting the closed valid shape and rejecting invalid session IDs, reasons, and extra fields;
- main-process tests for fixed private copy, opt-in behavior, cooldown aggregation, missing-session activation, and focus suppression;
- replay tests proving restored and load-earlier frames remain silent;
- scheduler integration tests proving immediate automatic continuation does not emit a **ready** notification;
- desktop package tests, renderer build, app and sidecar typechecks, and the applicable hardening suite;
- authorized GUI verification for real macOS notification permission, minimized-window restoration, grouped alerts, click-through selection, VoiceOver labels, and multi-pane clearing behavior.

## Deliberate exclusions

This design does not add:

- model-generated notification summaries;
- session names or project names in OS notifications;
- per-tool or per-message notifications;
- notification history separate from session attention state;
- sounds, Dock bouncing, or badge counts;
- cross-device or remote push notifications;
- a claim that a thread goal, task, or overall job is complete.

Those additions would expand privacy, interruption, or lifecycle semantics without being necessary to solve the current monitoring problem.
