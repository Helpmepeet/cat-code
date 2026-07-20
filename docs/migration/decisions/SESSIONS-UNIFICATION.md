# SESSIONS-UNIFICATION — one unified session concept (operator ruling)

**Status: DECIDED 2026-07-20 (operator).** Branch `migration`.

## The ruling (verbatim)

> "it should be both. The session that created in app should be the same
> sessions that created on cat-code terminal."

Asked whether the app should list only app-created sessions or also
terminal-created ones, the operator ruled: **ONE unified session concept.** A
session created in the cat-code terminal must be listed in the app sidebar AND
openable in the app, exactly like an app-created session — and vice-versa.

## What this overrules

The **registry-only sidebar scoping**. The shipped sidebar rendered only
`selectSidebarRows` (the desktop registry — live ∪ restorable app sessions). The
Sessions page already merged registry ∪ terminal history (P4-6a, commit
`44546eb`), but history rows were **browse-only** — no host path opened a bare
transcript (the P4-6b gap, flagged in `sessionsCatalogState.ts` + the SessionsPage
row tooltip). Both narrowings are now overruled: the sidebar lists the merged
roster, and terminal-history rows are openable.

The data layer was already unified (this ruling formalizes it, it does not
build it): app sessions write real engine transcripts to the SAME store the
terminal reads (`~/.cat-code/projects/**/<engineSessionId>.jsonl`, via the
engine's `appendEntryToFile`, `src/utils/sessionStorage.ts`), and the sidecar
enumerates that store into the catalog. Opening a terminal session resumes it
through the engine's real resume machinery (`app/sidecar/sessionResume.ts` →
`loadConversationForResume` → `processResumedConversation`), the same path the
TUI's `--resume` uses (`src/main.tsx:3784-3797`).

## Part A — the open-from-history host path (the load-bearing piece)

A new host-API method, `openHistorySession(engineSessionId)`, opens a
terminal-created transcript as a real desktop session. Security shape:

- **HC1** — the renderer NEVER authors a cwd or path. It passes ONLY the engine
  session id; main validates it (strict UUID shape, the same reject the host
  uses for appSessionIds) and rejects anything else before any lookup.
- **cwd resolution happens outside the renderer.** Main resolves
  `engineSessionId → cwd` from the sidecar-written baseline cache it already
  reads (`readSessionsCatalogCache(defaultRegistryDir())` — engine-derived data,
  not renderer-authored). An id absent from the cache, or one whose recorded cwd
  is empty (the ~83 MAJOR-1 unreconcilable-workspace rows), **fails closed** with
  a typed `HostError` the renderer renders honestly ("open it from the
  terminal"). Main never guesses a cwd and never trusts a renderer hint.
- **Compose, don't reimplement.** On a resolvable id, main calls the existing
  `host.createSession({ cwd, resumeEngineSessionId })` — the SAME create/spawn
  path `restoreSession` uses, which spawns a sidecar with
  `CATCODE_SIDECAR_RESUME_SESSION_ID` → `sessionResume.ts`. No new spawn path, no
  new socket frame; the control plane stays separate from the frame plane
  (`hostApi.ts` error unions never merge with `protocol.ts`). New preload method
  follows the HC3 fixed-sender pattern; hardening + source inventories extended.
- **Dedup:** if the id is already bound to a *ready* desktop registry row (one
  whose `engineSessionId` is filled — that happens only on its ready frame), main
  returns that descriptor (the renderer switches/restores it) instead of spawning
  a second sidecar — `host.createSession` does not dedup by engine id. Because a
  row's `engineSessionId` is null through its ~1–3s pre-ready spawn window, the
  resolver dedup alone would miss a rapid second open during that window; the main
  handler closes it with an **in-flight-promise coalesce** keyed by engine id
  (`openHistoryInFlight`), so a second open of an in-flight transcript returns the
  same session. **Residual (waived, cold-review 2026-07-20 Finding A):** a click
  in the sub-ms gap between `createSession` resolving and the ready frame filling
  the id could still spawn twice; its worst case is two sidecars resuming one
  transcript, which is exactly the already-accepted unguarded-concurrent-resume
  behavior below — waived to that decision, not a separate guard.

### Concurrency (engine-precedent flag — on record, unguarded by design)

Opening a transcript that is **live in a terminal process right now** is
**unguarded**, matching the engine exactly. The engine's own `--resume`/`/resume
<id>` does no liveness check (`src/utils/conversationRecovery.ts:536-538`) and
the transcript write is a plain `fs.appendFileSync` with no lockfile
(`src/utils/sessionStorage.ts:2971`); concurrent non-fork resume silently opens a
second writer to the same JSONL. `--fork-session` is the only thing that avoids
it, and it is opt-in. The ruling is "same session, match the terminal," so this
path adds **no** cross-process guard the TUI lacks. The workspace-trust gate
still fail-closes first-turn execution at the resolved cwd regardless of how the
session was spawned (`app/sidecar/sidecarServer.ts:987`, `!== true`) — no
create-path bypass. If a cross-process resume lock is ever wanted, it is a NEW
engine decision affecting the TUI too, not an app-only patch.

## Part B — unified sidebar (prototype parity)

The sidebar renders the merged roster via the D5-blessed shared selector
`selectMergedSessionRows` (App's `sessionCatalogRows` — no second merge, no new
feed), grouped by workspace with session search — matching the prototype
`~/catcode_prototype/cat-app/Sidebar.jsx`, which receives the entire session
list. Registry rows keep exact switch/restore behavior; history rows with a
resolvable workspace raise the Part-A open path; empty-cwd history rows are
visibly browse-only. Live / restorable / history read distinctly. Registry-row
ordering stays CC-2 warp-free (a row floats up only on message-send, never on
open/restore).

## Files

- Host path: `app/main/openHistorySession.ts` (+ test), `app/main/main.ts`
  (`CH_HOST_OPEN_HISTORY` handler), `app/preload/preload.ts`,
  `app/shared/protocol.ts` (`CatCodeBridge.openHistorySession`).
- Sidebar: `app/renderer/src/Sidebar.tsx`, `app/renderer/src/sidebarState.ts`
  (merged-row visual + intent + warp-free order),
  `app/renderer/src/sessionsCatalogState.ts` (`lastMessageSentAt` on the merged
  row), `app/renderer/src/App.tsx`, `app/renderer/src/SessionsPage.tsx`
  (history rows openable).
