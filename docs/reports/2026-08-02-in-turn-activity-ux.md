# What the desktop app shows while the agent is working

**Date:** 2026-08-02
**Scope:** `app/renderer` in-turn activity surface, `app/sidecar` + `src/app-runtime` turn signalling
**Trigger:** operator asked what the app actually renders during a live turn
**Outcome:** one defect fixed and committed (`d9c1cf1`, `91aa79f`, STATUS row CC-25); two defects
found and left open, one of them discovered only after the first fix made the surface visible

---

## 1. Summary

The desktop app had a complete "agent is working" surface: an activity row with a verb, target,
elapsed clock and per-turn token byline; a Stop button; Escape as an interrupt; a running variant
of the jump-to-bottom pill; a mid-turn composer lock. None of it had ever rendered. Every one of
those affordances is gated on a single flag that was false for the entire lifetime of a normally
attached session.

That is fixed. In the process, the verb logic behind the row turned out to be independently wrong:
it reports the state of the last transcript row rather than the state of the turn, which produces a
demonstrably incorrect verb whenever more than one tool runs at once.

| Finding | Severity | State |
|---|---|---|
| F1 · Turn state was an attach-only handshake value, so the whole activity surface was dead | High | **Fixed**, committed |
| F2 · `deriveActivity` reads only the last row, so parallel tools report the wrong verb | Medium | Open, fix designed |
| F3 · Thinking never streams, so the reasoning phase renders nothing at all | Medium | Open, blocked on a file another session holds |

---

## 2. F1 — the activity surface never rendered

### Mechanism

`SessionPane` derives one flag and hangs six affordances off it:

```ts
// app/renderer/src/App.tsx:3359
const generating =
  !!activeSessionId &&
  activeConnection.status === 'ready' &&
  !activeConnection.inputEnabled
```

`inputEnabled` was only ever written from the `app.ready` handshake payload
(`connectionState.ts:128`, `rawMessageLog.ts:78`), and the sidecar sends that frame exactly once,
when a client attaches (`sidecarServer.ts:498`). The sidecar flipped its own `activeTurn` at
`sidecarServer.ts:1066` and back at `:1097` but never re-broadcast, and no frame in
`app/shared/protocol.ts` carried turn state at all.

So on any normally attached session `inputEnabled` stayed at its attach-time value of `true`, and
`generating` was false for the whole session.

### Proof before the fix

Replaying the repository's own canonical streaming fixture (`S1_STREAMING_TEXT_TURN`) through the
real reducers:

```
attached (idle)                  generating=false  activityRow=hidden  rows=[]
stream_event/thinking_delta      generating=false  activityRow=hidden  rows=[]
stream_event/text_delta          generating=false  activityRow=hidden  rows=[assistant-text*]
assistant                        generating=false  activityRow=hidden  rows=[assistant-text]
result                           generating=false  activityRow=hidden  rows=[assistant-text | result]
```

### What that disabled

| Affordance | Site |
|---|---|
| Activity row: verb, target, elapsed, token byline | `App.tsx:3831` |
| Stop button | `App.tsx:4138` — its only mount site is inside that row |
| Escape to interrupt | `App.tsx:3622`, guarded by `generating` |
| Jump-to-bottom running cue | `App.tsx:3745` — the pill rendered, always as plain "↓ Latest" |
| Mid-turn composer lock and its placeholder | `App.tsx:3379` — the entire P4-58 deliverable |
| Amber "Waiting for approval" state | the `paused` branch of the above |

### Why the test suite was green

The renderer suite is server-side-render only and passes `inputEnabled: false` in as a prop
(`App.test.tsx:883`). It asserted the correct rendering of a state that nothing in the running
system could produce. This is the same failure class recorded before: a data path proven in
isolation is not an effect proven end to end.

### The fix

The engine already had this exact pattern working for a sibling concern. `setAbortState`
(`AppSessionController.ts:198`) sets the field and emits an event, and the sidecar forwards every
controller event unconditionally (`sidecarServer.ts:395`). Abort state was live; turn state was not,
only because nobody had wired it the same way.

So turn state now rides that same channel:

- `src/app-runtime/sessionEvents.ts` — new `AppSessionTurnStatusEvent` (`turn.status`, carrying one
  boolean) on the `AppSessionEvent` union.
- `src/app-runtime/AppSessionController.ts` — a private `setActiveTurn` becomes the **only** writer
  of `activeTurn` and emits on change. A bare assignment cannot announce itself; making the setter
  the sole writer is what stops a future code path from silently reintroducing this bug.
- `app/renderer/src/connectionState.ts` and `rawMessageLog.ts` — reduce it into `inputEnabled`.
  Both, because `selectComposerGate` reads both copies and a disagreement would leave the composer
  half-enabled mid-turn. Turn events move `inputEnabled` only and never `status`, so a late frame
  cannot revive a dead session; a repeated value returns the identical state object.
- `src/web/appSessionEventMapper.ts` — the browser protocol has no turn event, so this maps to
  nothing explicitly. That narrowing is also what keeps the mapper's later `event.message` reads
  sound.

No new frame kind, no sidecar broadcast plumbing, no protocol version bump, no new inbound
vocabulary, no preload channel, no change to the secret boundary. Outbound-only and additive.

Deliberately chosen over the alternative of a new app-owned `turn.snapshot` frame built from the
sidecar's own `activeTurn` mirror: that would have duplicated state the engine owns, which is the
documented house defect class. It also would have meant editing two files that other sessions
currently hold uncommitted.

### Verification

Same probe after the fix:

```
attached (idle)        generating=false
turn.status(true)      generating=true
stream_event           generating=true
assistant              generating=true
result                 generating=true
turn.status(false)     generating=false
```

The load-bearing test is a real-spawn probe in `app/sidecar/roundtrip.probe.test.ts`: it asserts
`turn.status` crosses an actual Unix-domain socket, arrives after `ready`, opens before the turn's
first message and closes after its last. That is the proof class the SSR suite structurally cannot
provide, and its absence is why this shipped dead.

| Battery | Result |
|---|---|
| `bun test app/` | 2307 pass / 0 fail, 169 files, 8060 assertions (2305/0 at session start) |
| `bun run --cwd app typecheck` | clean |
| `bun run --cwd app typecheck:sidecar` | scoped pass, 5,559 upstream ignored, 0 owned |
| `bun run --cwd app test:hardening` | 19/19 |
| `bun run --cwd app renderer:build` | ok |
| `bun run build:dev:full` | green, `2.1.87-dev.20260802.t100719.sha312c50c5` |
| `bun test src/app-runtime/` | 19/0 |
| `bun test src/web/` | 38/0 |
| `git diff --check` | clean |

Five existing event-order assertions changed, because the new event genuinely appears on the real
path. One of them was a security test: F6 (secret carried in an outbound event) asserted that **no**
event frame at all was sent, which the benign turn boundary would have quietly loosened. It was
strengthened rather than relaxed, and now pins that the raw wire bytes contain neither the token
value nor the forbidden key.

---

## 3. F2 — the verb reports a row, not the turn

Found after F1 landed and the row became visible.

```ts
// app/renderer/src/appModel.ts:55
const last = rows[rows.length - 1]
if (!last) return { verb: 'Working', target: null }
if (last.kind === 'tool-use' && last.status === 'pending') {
  return { verb: 'Running', target: last.toolName }
}
if (last.kind === 'thinking') return { verb: 'Thinking', target: null }
if (last.kind === 'assistant-text' && last.isStreaming === true) {
  return { verb: 'Responding', target: null }
}
return { verb: 'Working', target: null }
```

Only the tail row is consulted. Three consequences, all reproduced against the real projector.

### 3.1 Parallel tools report the wrong state

Three tools dispatched in one assistant message, results arriving newest-first:

```
all three dispatched           verb=Running Read   actually pending: [Grep, Glob, Read]
Read finishes (the LAST row)   verb=Working        actually pending: [Grep, Glob]
Glob finishes                  verb=Working        actually pending: [Grep]
Grep finishes                  verb=Working        actually pending: []
```

Two tools are still executing while the row says `Working`. This is a plain wrong-state report, not
a fidelity gap.

### 3.2 One word covers three different states

A realistic read-then-answer turn:

```
user submits                         verb=Working        last=user-text
stream: thinking_delta               verb=Working        last=user-text
stream: text_delta                   verb=Responding     last=assistant-text/streaming
assistant (thinking+text+tool_use)   verb=Running Read   last=tool-use(pending)
user (tool_result)                   verb=Working        last=tool-use(success)
stream: closing delta                verb=Responding     last=assistant-text/streaming
```

`Working` appears for "nothing has happened yet", for "the model is reasoning", and for "a tool just
finished and the model is deciding what is next". A completed tool falls through every branch to the
default.

### 3.3 `Thinking` is unreachable, not merely rare

It never fires in the trace above. Thinking deltas produce no row (see F3), and when the assistant
message finally lands, the thinking row is never last, because the text or `tool_use` block in the
same message follows it.

### Proposed fix

Derive from the turn, not the tail:

1. Scope to the current turn first, reusing the boundary logic `selectLiveTokenEstimate` already has
   (`appModel.ts:87`, `TURN_BOUNDARY_KINDS`). This is not optional polish: an aborted turn leaves its
   `tool-use` row `pending` forever, because no `tool_result` ever arrives, so an unscoped "any
   pending tool wins" rule would pin the verb to that tool for every later turn. Tool results
   themselves do not create false boundaries, since a result-only user frame projects no visible row.
2. Any pending tool in that window wins, not only a trailing one.
3. Then a streaming assistant-text tail gives `Responding`.
4. Otherwise `Working`.

`Thinking` should **not** be synthesized from the absence of other activity. That would assert a
state the renderer cannot observe. It becomes real once F3 is fixed.

Two open questions for the operator, both about user-visible text:

- With several tools running, name them (`Running` · `Grep, Glob`) or stay generic
  (`Running` · `3 tools`)? Naming them is more useful and equally honest; the row already truncates.
- Whether to fold in the separate target fix at the same time, so the row reads
  `Running` · `npm test -- auth` rather than `Running Bash`. The tool card families already derive a
  real per-family target, so this should reuse that rather than add a second extractor.

---

## 4. F3 — thinking never streams

`projectStreamEvent` accepts only text blocks and `text_delta`, and returns state unchanged for
every other delta type (`transcriptProjector.ts:1452`). `thinking_delta` is therefore dropped, and a
thinking row exists only once the complete assistant message arrives.

The consequence is the quietest part of the whole interface: between the user bubble and the first
token, nothing is added to the transcript at all. With F1 fixed the activity row at least says the
turn is live, but the reasoning itself remains invisible, and per F2 the verb during that window
reads `Working`.

The fix is to accept thinking blocks and `thinking_delta` alongside the text path, and to teach
`finalizeStreamingTurn` to prune thinking preview rows as well; today it filters only
`assistant-text` streaming rows, so without that second half the preview would duplicate the final
row.

Not attempted this session: `transcriptProjector.ts` currently carries roughly 186 uncommitted lines
from another session, and editing it would have meant working on top of someone else's in-flight
change.

---

## 5. Smaller items, both invisible until F1 landed

- The elapsed clock resets when the active session changes, because its effect keys on
  `activeSessionId` (`App.tsx:3428`). Switching away from a running turn and back restarts the timer
  at zero.
- `deriveActivity` uses `toolName` as the target, so the row reads `Running Bash` where the
  prototype shows the actual command or path beside a per-tool verb (`Chat.jsx:31`, which also tints
  the indicator dots per tool and shimmers the verb).

---

## 6. Prototype comparison

The prototype's live surface is `SpinnerWithVerb` (`Chat.jsx:1370`), docked above the composer, with
phases `connecting → thinking → tool → responding` and a quiet `paused` state. `ActivityIndicator`
in the same file is defined but never rendered, and is already recorded as cut.

The desktop equivalent is now reachable and structurally matches: pulse dots, verb, target, elapsed,
gated token byline. It adds a Stop button, correctly, because the desktop has no Ctrl+C. What
remains different is the verb vocabulary and the target text, which is F2 plus the item above.

---

## 7. Not verified

Everything in section 2 is proven headlessly and through a real socket. Nothing here has been
confirmed by an operator looking at a running window. The acceptance steps are:

Send a turn and confirm the activity row appears above the composer with a live elapsed clock; that
Stop and Escape both interrupt it; that the composer goes read-only mid-turn and recovers after; and
that scrolling up during a turn shows the running cue rather than "↓ Latest". Worth doing from a
fresh launch rather than a dev window left open across these edits, since a running dev app is
showing hot-module state.

```bash
cd /Users/pt/cat-code && bun run --cwd app dev
```
