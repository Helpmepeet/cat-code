# D6 — Session lifetime: do sessions die with the window?

**Status: DECIDED — owner ruling 2026-07-02; formalized 2026-07-03 (Phase-3 pre-work,
parallel to Phases 1–2).** The ruling itself was made the day of the direction review and is
already recorded in `TRANSPORT.md` §4.4 and `INVENTORY.md` D6. This document does what those
one-paragraph records could not: pin the exact semantics the ruling implies, state the Phase-3
gate line it buys and the one it waives, and record why — so Phase 3 builds against a decision,
not a slogan. Source anchors verified against the working tree on 2026-07-03; where this doc and
source disagree, source wins.

Provenance: `reviews/2026-07-02-direction-review.md` DR-1 / §5 named this "the one question that,
if answered wrong, sinks this program" — because the docs had been treating **re-attach** and
**re-spawn** as synonyms when they are opposite architectures, and the answer was about to be
given *by default* by whichever IPC mechanism was easiest.

| # | Question | Verdict |
|---|---|---|
| **L1** | v1 session lifetime | **DIE-WITH-WINDOW.** Closing the last window ends every session's engine process (in-flight turns included). Parity with today's TUI. |
| **L2** | Is die-with-window achieved by process parenting? | **NO — behavior, not welding.** The sidecars die because the supervisor's `shutdown()` kills them (`app/main/main.ts:396-414`), not because their channel is parent-bound. The Unix-socket + Electron-free-supervisor structure (TRANSPORT §4.4 pins 1–2) is a **non-negotiable condition of the ruling**. |
| **L3** | Phase-3 gate line | The DR-1 line — "quit + relaunch with a turn in flight → sessions **re-attach**" — is **explicitly WAIVED for v1**. Substitute gate line in §4: relaunch **restores** sessions from the app registry by re-spawn + engine-transcript resume (`REGISTRY.md` R3). |
| **L4** | Always-on / server-Mac milestone | **Deferred, not foreclosed.** v2 = move the same host module (supervisor + registry + socket) into a daemon; the window becomes one attachable client. No Phase-3 artifact may assume the window is the only client. |

---

## 1. What was actually at stake (re-attach ≠ re-spawn)

Two behaviors hide under "the app comes back and my sessions are there":

- **Re-attach:** the engine processes *kept running* while no window was attached; a new window
  connects to the existing sockets and resumes the live streams. In-flight turns survive.
  Requires: a channel that outlives the parent (the Unix socket file — pinned), somewhere for
  the supervisor plane to live when no window exists (a daemon — **not built in v1**), and
  replay/reconnect semantics.
- **Re-spawn:** the engine processes died; relaunch starts *fresh* processes and reloads each
  session's durable state — the engine's own transcript (`getTranscriptPathForSession`,
  `src/utils/sessionStorage.ts:238`) through the engine's real resume machinery
  (`loadConversationForResume`, `src/utils/conversationRecovery.ts:465` +
  `processResumedConversation`, `src/utils/sessionRestore.ts:493`; `switchSession`,
  `src/bootstrap/state.ts:474`, only adopts the id and is not itself a resume).
  In-flight turns are lost; completed history is not.

Under parent-bound pipes (stdio/child-IPC), re-attach is *impossible* and every "re-attach or
re-spawn" sentence silently means re-spawn — which is why DR-1 forced the socket pin before P1-0
poured concrete. The pin held: the shipped transport is a filesystem socket
(`app/supervisor/supervisor.ts:136,293`; `app/sidecar/index.ts:76-77`), and the supervisor is an
Electron-free module with zero `electron` imports (`app/supervisor/supervisor.ts:1-37`) that
Electron main merely *calls* (`app/main/main.ts:19,349-353`).

## 2. The ruling, restated precisely

**v1 sessions die with the window** — chosen, not defaulted. What the owner accepted is the
*behavior*; what the ruling explicitly rejected is *welding* that behavior into the topology.
Concretely, as built today:

- `window-all-closed` → `supervisor.shutdown()` → `SIGTERM` every sidecar + delete socket files +
  clear the registry map (`app/main/main.ts:396-410`, `app/supervisor/supervisor.ts:246-255`).
- `before-quit` → same shutdown (`app/main/main.ts:412-414`).
- On macOS the Electron process itself stays alive in the dock after `window-all-closed`
  (`main.ts:407-409`), and `activate` builds a **fresh host with a fresh session**
  (`ensureHost`, `main.ts:389-393`). So v1 is literally die-with-*window*, not
  die-with-*app-process*: an app icon sitting in the dock holds no live sessions. This is the
  TUI-parity reading (closing the terminal kills the TUI) and it is what ships; if daily use
  shows "window closed, dock icon alive, agent dead" to be the wrong feel, that is a
  **dogfood-gate finding (DR-3), not a Phase-3 re-architecture** — flipping it means *not
  calling shutdown* on window-all-closed, which the structure already permits.
- A sidecar dying does **not** kill anything else (crash isolation held in P0-1 §2 and the
  supervisor's per-record `exit` handling, `supervisor.ts:179-190`); D6 is about the window's
  effect on sessions, not sessions' effect on each other.

**The boundary of the ruling:** if the host process *crashes* (no `shutdown()` ran), sidecars
survive it — the socket is not parent-bound, so nothing reaps them automatically. Die-with-window
therefore needs an explicit janitor: on next launch, the registry's liveness sweep finds orphaned
engine PIDs and kills them (v1 policy) rather than re-attaching (v2 would attach instead). That
policy lives in `REGISTRY.md` §4 — the reap is *registry work*, but the v1 kill-don't-attach
choice is *this* decision.

## 3. Lifetime semantics matrix (v1 — what Phase 3 builds against)

| Event | Engine processes | In-flight turn | Session identity/history |
|---|---|---|---|
| Quit (⌘Q) / last window closed | killed via `supervisor.shutdown()` | lost (aborted with the process) | engine transcript on disk; registry row persists → restorable |
| Relaunch after clean quit | fresh spawns | — | **restore offered from registry** (re-spawn + transcript resume; gate line §4) |
| Host (Electron) crash | **orphaned** (socket outlives parent) | runs to completion, unobserved | next launch: liveness sweep **kills orphans**, rows marked `crashed`, restore offered |
| One sidecar crashes | that session only | lost for that session | restart is caller policy (`supervisor.ts:231-243`); other sessions untouched |
| Phase-5 auto-update relaunch | = clean quit + relaunch | lost | same as relaunch; **update UX must warn if a turn is in flight** (carry-forward §7) |
| macOS dock-alive, zero windows | none running | — | next window = fresh session (+ restore offer) |

## 4. The Phase-3 gate line (deliverable of this decision)

DR-1's original line — *"quit and relaunch the app with a turn in flight; sessions re-attach"* —
is **waived for v1 by this ruling**. The substitute, which Phase 3's gate MUST include so the
waiver doesn't silently become "no lifetime behavior at all":

> **Gate (lifetime):** with two live sessions (each its own engine process), quit the app and
> relaunch. Both sessions are offered for restore from the app-owned registry and, on accept,
> reopen with their transcript history intact in fresh engine processes (engine-session resume,
> not blank sessions). A host **crash** (SIGKILL Electron) followed by relaunch must additionally
> reap the orphaned sidecars and still offer the same restore. An in-flight turn at quit time is
> **expected to be lost** — the gate asserts the *sessions* come back, not the turn.
>
> **Anti-Potemkin clause** — "history intact" is proven, not eyeballed: after restore, submit a
> prompt whose answer depends on a unique fact stated *before* the quit (e.g. a nonce the operator
> told the session), and assert (a) the engine answers from restored context, (b) the transcript
> file for the **same `engineSessionId`** now has post-restore entries appended by a **new
> engine PID**, and (c) the restore ran through the engine-side resume machinery (§1 anchors:
> `conversationRecovery.ts:465` / `sessionRestore.ts:493`) — a renderer that merely re-renders
> old JSONL, or a fresh engine session with pasted-in history, fails all three.

Structural assertions that ride along (these keep v2 an attach, and they are already true —
the gate pins them against regression): the supervisor module contains zero `electron` imports;
the sidecar channel remains a filesystem socket; no Phase-3 code path derives session lifetime
from `child.on('exit')` of the *window* process.

## 5. Why die-with-window is the right v1 (justification, not just precedent)

1. **It matches the product the operator actually uses today.** The TUI dies with its terminal;
   v1 parity means the desktop app is never *worse* than the thing it replaces, and the migration
   keeps its "rebuild the home, don't renovate the resident" scope.
2. **The alternative's cost lands in the wrong phase.** Real re-attach needs a daemon lifecycle
   (install/upgrade/health), reconnect-replay semantics on the event stream, and an answer to
   "who owns the sidecars when no UI exists" — all of it Milestone-4 work (`GOAL_PLAN.md:75`)
   that would displace the transcript/permission core Phases 2–4 exist to ship.
3. **The dogfood gate (DR-3) will price the pain correctly.** If losing sessions on quit is the
   thing that hurts daily, that datum arrives *before* Phase 4 spends the session budget — and
   the fix is a behavior flip on an already-detachable structure, not a rewrite.
4. **The expensive wrong-default was already defused.** The direction review's nightmare — Phase 3
   encodes child-ownership, Phase 5's auto-update massacres live work, the server-Mac milestone
   reopens Phase 3 — required parent-bound pipes. Those are gone. What remains of "wrong default"
   under die-with-window is *deliberate, bounded, and reversible*.

## 6. What flips at the always-on milestone (v2 sketch — non-binding)

Recorded so Phase 3 doesn't accidentally make it harder: the host module (supervisor + registry +
control API) moves out of Electron main into a launchd-style daemon; Electron main's `ensureHost()`
becomes "connect to daemon, else spawn it"; `window-all-closed` stops calling `shutdown()`; the
registry's `socketPath`/`pid` fields (already persisted from day one — `REGISTRY.md` R2) turn the
crash-sweep's *kill* into an *attach*; the replay question (what a late-attaching window missed)
gets a real answer, for which the per-session `FrameReplayBuffer` (`app/main/replayBuffer.ts:33`)
is the seed. None of this is v1 work; all of it must remain *possible* — that is L2.

## 7. Rejected alternatives

- **R1 — Build the daemon now ("answer the vision immediately").** Rejected: v1 has no consumer
  for detached sessions (no phone client, no server Mac deployment), and the daemon tax lands on
  every phase after it. The ruling keeps the *structure* and defers the *behavior*.
- **R2 — Middle path: sidecars keep running while the dock icon is alive (macOS).** Rejected for
  v1: it blurs the lifetime story ("sometimes my sessions survive") without delivering the actual
  always-on promise (a reboot or ⌘Q still kills everything), and it creates invisible running
  agents with no attached UI — the exact state the security minimum prefers not to mint before
  the registry/attach UX exists. Revisit at the dogfood gate with usage data.
- **R3 — Die-with-window via process parenting (stdio/child-IPC).** Rejected by the direction
  review and already build-refuted: the shipped socket transport is the anti-decision. Recorded
  here only so nobody "simplifies" the socket away citing L1.

## 8. Adversarial self-review

- **A1 — "You accepted the exact failure §2 of the direction review warned about."** No: the
  review's attack was lifetime-by-*default* under a topology that *forecloses* re-attach. This is
  lifetime-by-*ruling* under a topology that preserves it. The review itself named
  die-with-window "an acceptable v1 answer *if chosen*" (DR-1 course-correction 3). It is chosen.
- **A2 — "Auto-update will still massacre live work in Phase 5."** True and accepted for v1 —
  an update is a quit. The matrix (§3) makes it a *visible* cost: Phase 5 must gate updates on
  "no turn in flight" or warn. If dogfooding shows updates are frequent enough to hurt, that is
  evidence for scheduling the v2 flip, not for redesigning Phase 3.
- **A3 — "Orphans after a host crash violate the ruling."** They violate neither ruling nor
  structure; they are the unavoidable consequence of *not* welding. The registry sweep (§2, §3)
  is the enforcement mechanism; the gate line (§4) tests it.
- **A4 — "The operator will keep living in the TUI because the TUI only dies when *he* closes
  it."** That is precisely TUI parity — the desktop app dies exactly when he closes *it*. The
  residual risk (that always-on is the real daily need) is measured by the DR-3 dogfood gate, and
  the v2 flip is priced at "move the host module," not "rebuild Phase 3."
- **A5 — "Fresh-session-per-activate (macOS) leaks sessions into the registry."** `ensureHost()`
  mints a new session per dock reopen (`main.ts:389-393`). Without registry hygiene this creates
  row litter. Registry R4 (reap + bounded rows) owns this; flagged there.

## 9. Carry-forwards

- **Phase-5 update UX:** updates are quits — block or warn when a turn is in flight (§8 A2).
- **Dogfood-gate probe (DR-3):** explicitly collect "did you lose work / want sessions to
  survive quit?" in the keep/cut/change list — it is the empirical test of this ruling.
- **Registry owns:** orphan reap policy mechanics, restore UX, row hygiene for macOS reopen
  (→ `REGISTRY.md` §4, §7).
- The engine's `daemon`/`daemon-worker` session kinds (`src/utils/concurrentSessions.ts:18`)
  show the *engine* already anticipates daemon-hosted sessions; the desktop host does not use
  them in v1 — do not conflate the two when v2 arrives.
