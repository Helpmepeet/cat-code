# P3-5 Shell Review — multi-session TabBar + Sidebar restore surface — 2026-07-05

**Status: FINAL.** Two independent read-only review passes plus primary-agent spot-check.

Reviewed the uncommitted working-tree changes under `app/` on branch `migration`, on top of
HEAD, including the new renderer files:

- `app/renderer/src/shellState.ts` + test
- `app/renderer/src/tabStatus.ts` + test
- `app/renderer/src/TabBar.tsx` + test
- `app/renderer/src/sidebarState.ts` + test
- `app/renderer/src/Sidebar.tsx`

Scope: P3-5a/P3-5b renderer shell behavior — one engine process per session, TabBar create/switch/
close/restart affordances, Sidebar live∪restorable roster, and closed-session restore via the host
control plane. Source contract checked against `app/shared/hostApi.ts`, `app/preload/preload.ts`,
`app/host/host.ts`, and `docs/migration/backlog/phase3.md` P3-5a/P3-5b.

No app code was edited as part of this review. This document was added afterward at operator request.

## Executive verdict

**RED for P3-5 as currently written.** The visual shell exists and the app tests/typecheck are green,
but two host/renderer contract mismatches break the core P3-5 behavior:

1. closing a tab can leave the closed/restorable session in the TabBar and active pane instead of
   moving it to the Sidebar restore surface;
2. the Sidebar can classify live ready sessions as restore targets because the host currently sets
   `restorable:true` for live rows with an `engineSessionId`.

There is also a startup/reload race in the initial roster hydrate path that can drop or resurrect
session state. This is less immediately visible than the two restore-surface bugs, but it cuts
against the documented HostEvent projection model.

## Gates re-run

| Gate | Result |
|---|---|
| `bun test app/` | **339 pass / 0 fail** |
| `bunx tsc --noEmit -p app/tsconfig.json` | **clean** |

I did not launch the Electron app. GUI verification was explicitly being checked separately.

## Findings, ranked

### F1 — High — Closed sessions stay in the TabBar and can remain active

**Contract:** P3-5a says the TabBar is “one tab per LIVE session,” and P3-5b says closing a tab
should surface the row as a restorable Sidebar row. See `docs/migration/backlog/phase3.md:568` and
`:641-645`.

**Evidence:**

- `app/host/host.ts:344-370` — `closeSession()` keeps the registry row restorable and emits
  `session-status`, not `session-removed`.
- `app/renderer/src/shellState.ts:56-62` — `session-status` only replaces the descriptor; it keeps
  the id in `order`.
- `app/renderer/src/shellState.ts:79-82` — `selectSessions()` returns every descriptor in `order`,
  with no live-only filter.
- `app/renderer/src/App.tsx:195-209` — TabBar tabs are built directly from `selectSessions(shell)`.
- `app/renderer/src/App.tsx:162-168` — active focus only changes on `session-removed`, so closing
  the active tab via `closeSession()` can leave focus on the closed session.
- `app/renderer/src/tabStatus.ts:86-90` — any `exited` tab becomes restartable, but
  `app/host/host.ts:404-411` rejects restart for non-live closed/restorable rows.

**Impact:** closing a tab does not reliably make it “leave the bar.” The closed session can remain
as an exited/restartable TabBar tab, and if it was active, the active pane can stay pointed at a
closed/restorable session. This conflicts with the P3-5 split: TabBar = live sessions; Sidebar =
live∪restorable roster and restore offer.

**Fix shape:** keep the shell’s roster capable of representing live∪restorable rows for the Sidebar,
but ensure the TabBar projection and active-tab fallback operate on live rows only. Closing the
active live tab should move focus to another live tab or `null`, while the closed row remains
available through the Sidebar restore flow.

### F2 — High — Sidebar restore classification does not match current host descriptors

**Contract:** `SessionDescriptor.restorable` is documented as true when no process is live but the
row+transcript can be re-spawned:

- `app/shared/hostApi.ts:74-77`
- `docs/migration/backlog/phase3.md:627-629`

**Evidence:**

- `app/host/host.ts:523-537` — descriptors call `isRestorable(row, liveStatus)`.
- `app/host/host.ts:547-552` — `isRestorable()` ignores `liveStatus` and returns true for any row
  whose `engineSessionId !== null`.
- `app/renderer/src/sidebarState.ts:95-128` — the Sidebar derives `kind:'restorable'` solely from
  `descriptor.restorable`.
- `app/renderer/src/Sidebar.tsx:101-106` — restorable rows call `onRestore(id)` instead of selecting
  the live session.
- `app/host/host.ts:255-260` — `restoreSession()` rejects already-live ids as `session_not_found`.

**Impact:** a normal ready live session can appear in the Sidebar as a restore candidate once it has
an `engineSessionId`. Clicking the row can call `restoreSession()` instead of switching to the live
tab, and the host rejects the operation because the session is already live. This makes Sidebar
switch/restore semantics unreliable and contradicts the shared type contract.

**Fix shape:** restore the host contract: a descriptor should be `restorable:true` only when the row
has an engine session id, has a transcript, and is not currently live. If the intended meaning is
instead “has enough durable identity to be restored later,” then the shared type docs, P3-5b logic,
and Sidebar action split all need to be renamed/reworked; the current mixed meaning is the bug.

### F3 — Medium — Initial roster hydration can lose or resurrect session state

**Contract:** HostEvents carry full descriptors so subscribers can update without follow-up reads;
the renderer’s roster is intended to be a projection of the HostEvent stream. See
`app/shared/hostApi.ts:115-123`.

**Evidence:**

- `app/renderer/src/App.tsx:147-155` — App starts `listSessions()` before subscribing to host events.
- `app/renderer/src/App.tsx:155-170` — host events are then folded into local shell state.
- `app/renderer/src/App.tsx:755-765` — when the snapshot resolves, hydrate folds every snapshot row
  as `session-added`; it never reconciles removals or newer statuses that occurred after the
  snapshot was taken.
- `app/renderer/src/shellState.ts:56-58` — `session-status` for an unknown session is ignored even
  though the event carries a complete descriptor.
- `app/main/main.ts:265-270` — host events are forwarded to the current renderer; there is no replay
  buffer for missed host-control events.

**Impact:** around startup or renderer reload, a session can be added, removed, or transition status
between the initial snapshot and the subscription. The renderer can then miss the status, resurrect
a removed row from the stale snapshot, or retain stale status until another host event happens.

**Fix shape:** subscribe before snapshot and/or make hydrate reconcile against the authoritative
current snapshot rather than only adding rows. Separately, consider treating `session-status` for an
unknown id as an upsert, since the HostEvent contract says it carries the full descriptor.

## Cosmetic/style notes

These do not change the RED verdict; they are polish items to consider while touching the same files.

### S1 — Low — The new renderer files are over-commented with phase/spec prose

The implementation carries a lot of review/backlog language directly in source:

- `app/renderer/src/TabBar.tsx:1-16`
- `app/renderer/src/Sidebar.tsx:1-26`
- `app/renderer/src/shellState.ts:1-15`
- `app/renderer/src/sidebarState.ts:1-17`
- `app/renderer/src/App.tsx:477-507`

Some of this was useful while landing the split P3-5a/P3-5b work, but it is heavier than the usual
code-comment bar. Once the behavior is fixed, trim comments that restate the backlog or visual
continuity claims, and keep only the invariants a future maintainer needs in place: live vs
restorable split, no UI-driven teardown on tab switch, and the HostEvent/snapshot race constraints.

### S2 — Low — TabBar uses ARIA tab roles without focusable tab behavior

`app/renderer/src/TabBar.tsx:43-47` declares a `role=\"tablist\"`, and each tab is a clickable
`div role=\"tab\"` at `app/renderer/src/TabBar.tsx:97-105`. The tab element is not focusable and
does not handle Enter/Space or arrow-key tab movement; the nested restart/close buttons are
focusable, but the tab itself is mouse-only aside from the global `⌘1..9` shortcuts.

This is not a migration blocker, but it is an accessibility/style mismatch: either make the tab
roles behave like tabs (`tabIndex`, keyboard selection, focus policy), or use simpler button markup
if the intended interaction is “clickable tab-shaped button” rather than a full ARIA tab widget.

### S3 — Info — Shortcut hints are hard-coded to `⌘` while the handler supports Ctrl too

The keyboard handler accepts either Meta or Ctrl (`app/renderer/src/App.tsx:435-460`), but the visible
and title hints are Mac-only:

- `app/renderer/src/TabBar.tsx:93-94`
- `app/renderer/src/TabBar.tsx:64`
- `app/renderer/src/App.tsx:548`

If the desktop app is intentionally Mac-first, this is fine. If the renderer is expected to read
cleanly on Linux/Windows too, the hint should be platform-aware or say the generic accelerator.

## Things that passed / were not findings

- The new renderer state is session-id keyed and does not tear down background session stores on tab
  switch; this matches the P3-4 foundation.
- TabBar and Sidebar are presentational components; host calls remain owned by `App`.
- The new UI reads only real `SessionDescriptor` fields and does not port prototype-only fixture
  fields such as cost/model/tags/workspace.
- The focused app test suite and renderer/main/preload/shared typecheck are green.

## Final assessment

The change is close in shape, but the restore surface is not yet correct enough to land as P3-5:
F1 and F2 break the live-vs-restorable split that P3-5a/P3-5b are built around. Fix those before GUI
sign-off, then re-run `bun test app/` and `bunx tsc --noEmit -p app/tsconfig.json`; the GUI check
should specifically verify: close active tab → tab leaves TabBar and appears as restorable in the
Sidebar → selecting it restores a live tab and transcript history.

## Resolution — the three blocking findings (F1/F2/F3) fixed 2026-07-05 (lead-verified)

All F1/F2/F3 fixed coherently and re-verified by the lead session against the evidence anchors above.
The RED verdict is cleared; the S1–S3 cosmetic notes are NOT blocking and their disposition is
tracked separately.

- **F2 (root, host):** `isRestorable` (`host.ts:547`) now returns `false` when `liveStatus !== null`
  — a live session is never a restore candidate, matching the `hostApi.ts:74` contract. Path (a)
  taken (fix the predicate); the contract was NOT renamed. One host test (`host.test.ts:300`, which
  encoded the old wrong behavior) updated to assert `restorable:false` for a live ready session; all
  other host tests green untouched.
- **F1 (renderer):** the TabBar now projects **live-only** via `selectLiveSessions` =
  `filter(!descriptor.restorable)` (`shellState.ts:99`); `activeAfterLiveChange` (`shellState.ts:110`)
  moves focus off a now-non-live active tab to the first live tab (or empty shell). The old
  removed-only focus handler + `activeAfterRemoval` are gone. The stale `closeTab` comment is fixed.
  **Restart-affordance facet resolved by construction:** `!restorable` is simultaneously the TabBar
  membership test AND the host's `restartSession` acceptance boundary — a cleanly-closed row leaves
  the bar (→ Sidebar restore), a crashed-not-reaped row stays a tab with a host-accepted restart, so
  no affordance is offered that the host rejects. `tabStatus.ts` needed no change.
- **F3 (renderer):** `subscribeHost` is now installed **before** `listSessions()` (the review's
  preferred fix — closes the race window); `hydrate` reconciles as a baseline (a live-removed id is
  not resurrected; newer-by-`lastAttachedAt` live state is never rolled back); `session-status` for
  an unknown id is now **adopted** (upsert) not dropped (`shellState.ts:56`).

**Gates (lead re-run):** `bun test app/` **341 pass / 0 fail**; renderer tsc clean; sidecar tsc
5549→5549 (no new); hardening 18/18. **RED → GREEN on the blockers, pending operator GUI sign-off**
of the close→Sidebar→restore flow named above. S1 (over-commenting), S2 (ARIA tab keyboard
behavior), S3 (Mac-only shortcut hints) remain open as non-blocking polish.
