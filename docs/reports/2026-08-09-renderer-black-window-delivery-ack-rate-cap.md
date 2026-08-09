# Renderer Blanks To Black: Delivery Acknowledgements Exhaust The IPC Rate Cap

**Date:** 2026-08-09
**Scope:** Electron desktop application (`app/`) — preload IPC guard, delivery-trace acknowledgement path, renderer error boundary. Secondary: sidecar → supervisor operational-record boundary.
**Status:** Diagnosed from a live incident. No runtime code changed.
**Severity:** High. Total, silent loss of the application UI during ordinary use, with the recovery UI and the crash telemetry both disabled by the same failure.
**Revision:** Rewritten 2026-08-09 after a RED review. The first version mis-derived the rate arithmetic, mis-attributed the `trace.sequence.gap` records, and omitted the stack frame that proves the React path. Corrections are marked inline where the earlier reading was wrong.

## Summary

During a normal development session the Cat Code Dev window went black. The
renderer process did not crash, did not hang, and did not fail to load: it was
still answering IPC health probes five minutes later. React had unmounted the
entire component tree.

The application's own instrumentation destroyed the application:

1. Delivery-trace **acknowledgements** — pure telemetry — are sent through the
   same shared inbound rate budget as genuine user input.
2. Under a burst, an acknowledgement flush exceeds the 120-per-second cap. The
   guard fails closed and throws, correctly.
3. On the synchronous flush path that throw surfaces inside a React passive
   effect, so the error boundary catches it.
4. The boundary reports the fault through the **same** exhausted budget, so the
   report throws inside `componentDidCatch`.
5. React cannot recover from an error thrown in a boundary's own lifecycle. With
   no boundary above it, the root tree unmounts. The window goes black, the
   "Cat Code needs to reload" fallback never renders, and no fault record ever
   reaches the operational log.

Every individual component behaved as designed. The defect is in the composition:
telemetry shares a security budget with user input, and the crash reporter shares
it with the crash.

## Impact

- The window blanks completely. The rendered fallback UI in
  `RendererErrorBoundary` is unreachable, so the user sees black rather than a
  recovery message.
- The failure is silent from the operator's terminal: every renderer failure
  signal routes to the JSONL operational log rather than stdout/stderr, so a
  dead renderer and a healthy one produce identical terminal output.
- No telemetry survives. `reportRendererFault` is the mechanism that would have
  recorded the fault, and it is disabled by the same exhausted budget, so the
  operational log contains no error or fatal record for the incident at all.
- The trigger is ordinary use, not an edge case.

## Environment

- Branch `migration`, dev launch via `bun run --cwd app dev`.
- Electron pid 6580, operational launch id `93071dc6`, window opened 18:14:33.
- Two live sessions: `20f8b31a` (first, resumed, 177 messages) and `000638f7`
  (second, started 18:14:50). The failure is confined to the second.
- Incident-specific identifiers, timestamps and stage counts in this report come
  from the operator's private desktop logs and the DevTools console. They are
  first-party observations, not independently reproducible from the repository.

## Reproduction

Not isolated to a deterministic script. The observed conditions were:

1. Run the desktop app in dev with at least one session streaming engine output.
2. Start a second session and let it stream a turn of ordinary length.
3. The window blanks during the stream.

The load required is whatever pushes guarded acknowledgement sends past 120 in
one sliding second. See the arithmetic below: this is a function of IPC *batch
sends*, not acknowledgement objects, and the exact triggering burst was not
measured.

## Root cause

### 1. The rate cap is a single shared budget

`MAX_FRAMES_PER_WINDOW = 120` per `RATE_WINDOW_MS = 1000`
(`app/shared/limits.ts:35`, `:38`). Every renderer → main call through the
preload passes `sendGuard.assertAllowed`, which increments one shared counter
(`app/preload/rendererIpcGuard.ts:44`). This is deliberate and tested:
`app/preload/rendererIpcGuard.test.ts:18` is named "counts all fixed-channel
sends in one shared rate window" and asserts the throw. The guard is not
malfunctioning. It is being spent by traffic it was never sized for.

### 2. What actually consumes budget slots

**Corrected from the first version of this report, which claimed roughly four
slots per frame and a threshold near 30 frames per second. Both were wrong.**

The guard is called **once per batch**, not once per acknowledgement:
`flushDeliveryAcknowledgements` splices up to `MAX_DELIVERY_ACKS_PER_BATCH = 64`
acknowledgements and calls `assertAllowed` a single time for the batch
(`app/preload/preload.ts:147-154`, batch size at `:87`). Acknowledgement object
count and guarded-send count are therefore different quantities, and only the
latter consumes budget.

The accepted stage union has **five** members, not four:
`preload.received`, `renderer.subscription.received`, `renderer.state.queued`,
`renderer.state.applied`, `renderer.ui.committed` (`app/main/main.ts:355`).

For an ordinary live frame these do not cost five slots, because most of them
coalesce:

1. `preload.received` is queued in the frame handler
   (`app/preload/preload.ts:330-339`), which schedules a microtask flush.
2. The handler then calls `listener(frames)` **synchronously**
   (`app/preload/preload.ts:343`), so `renderer.subscription.received` and
   `renderer.state.queued` are queued in the same task
   (`app/renderer/src/App.tsx:873`, `:924`).
3. No microtask runs until that task ends, so all three land in **one** batch
   and cost **one** slot.
4. `renderer.state.applied` is queued later by the React effect
   (`app/renderer/src/App.tsx:603-607`), normally a second batch and a second
   slot.
5. `renderer.ui.committed` is restricted to qualifying terminal lifecycle frames
   (`app/renderer/src/App.tsx:608-617`, `:936-945`) and is not a per-frame cost.

So steady state is on the order of **two guarded sends per frame**, putting the
theoretical ceiling near 60 frames per second rather than 30 — and that figure
is still only an upper bound, because the effect path batches many acks into one
send whenever more than one frame lands between commits, and because other
bridge traffic shares the same window. The honest statement is that the budget
was exhausted; the precise triggering rate is unmeasured, and measuring it
requires counting `CH_DELIVERY_ACK` sends per window, not acknowledgements.

### 3. Two distinct throw paths, only one of which reached React

The console shows both, and the first version of this report conflated them.

**The microtask path**, which throws uncaught and never reaches React
(46 occurrences by the console's repeat count):

```
Uncaught Error: renderer IPC rate exceeds 120 frames per 1000ms
    at Object.assertAllowed
    at flushDeliveryAcknowledgements
```

These escape into `window.onerror` (see step 5 below).

**The synchronous path**, which is the one that unmounted the tree:

```
Error: renderer IPC rate exceeds 120 frames per 1000ms
    at App.tsx:606:19
    at Object.react_stack_bottom_frame
    at commitHookEffectListMount
    at commitPassiveMountOnFiber
```

`app/renderer/src/App.tsx:606` is the `getBridge().deliveryAck(...)` call inside
the passive effect at `:603`. A throw surfacing there, beneath
`commitHookEffectListMount`, can only originate from the **immediate** flush
branch at `app/preload/preload.ts:134-135`: the effect loop pushes
acknowledgements without yielding, so no microtask drains the pending array, it
crosses 64 mid-loop, and the flush runs inline on the effect's own stack. React
attributed the error to `<App>` accordingly.

This is the evidence that the synchronous branch ran. It requires 64 or more
`renderer.state.applied` acknowledgements to accumulate between two React
commits, which the batching reducer (`reduceConnectionStateBatched`,
`app/renderer/src/App.tsx:596`) makes reachable under a streaming burst.

### 4. The error boundary is disabled by the same budget

`RendererErrorBoundary.componentDidCatch` calls
`getBridge().reportRendererFault('component', error.message)`
(`app/renderer/src/RendererErrorBoundary.tsx:17`). That path runs
`sendGuard.assertAllowed` at `app/preload/preload.ts:361`, which is still over
budget, so it throws **inside `componentDidCatch`**.

The fault reporter's own limiter, `MAX_RENDERER_FAULTS_PER_MINUTE = 12`
(`app/preload/preload.ts:90`), is checked at `app/preload/preload.ts:108` —
*before* `assertAllowed` — so it provides no protection here.

React cannot recover from an error thrown in a boundary's own lifecycle. It
reported exactly that:

```
An error occurred in the <RendererErrorBoundary> component.
```

With no boundary above the root, React unmounts the whole tree. **This is the
black window.** The fallback markup in `RendererErrorBoundary.render` is correct
and simply never runs.

### 5. The uncaught handler repeats the failure

`window.addEventListener('error', …)` at `app/renderer/src/main.tsx:44` also
calls `reportRendererFault`, and throws for the same reason — which is what the
46 uncaught microtask throws in step 3 feed into. The `unhandledrejection`
handler at `app/renderer/src/main.tsx:47` shares the flaw.

## Evidence from the logs

Read from `~/.cat-code/desktop/logs/` for launch `93071dc6`. Event names, counts,
and stage metadata only.

**The renderer was alive throughout.** Zero `error` or `fatal` records for the
entire launch; three `warn`s, none related. No `renderer.process.gone`, no
`renderer.load.failed`, no `renderer.health.missed`. `renderer.health.sample`
is a genuine round trip — main probes, the renderer answers over IPC, and main
validates the reply against the current `documentId` and `subscriptionEpoch`
before logging (`app/main/main.ts:1654`) — and the last reply landed at
18:19:38, roughly five minutes after the window blanked. `documentId` and
`subscriptionEpoch=2` are identical across every traced stage, so there was no
reload or HMR document swap.

**The delivery funnel diverges sharply between the two sessions:**

| Stage | `20f8b31a` (first) | `000638f7` (second) |
|---|---|---|
| `main.ipc.sent` | 17 | 193 |
| `preload.received` | 17 | 145 |
| `renderer.state.applied` | 17 | 102 |

**A second symptom, found during the 2026-08-09 review of the fix.** The renderer
acknowledges `renderer.subscription.received` inside the `bridge.subscribe`
callback at `app/renderer/src/App.tsx:875`, deliberately before any reducer
projection. Before the fix, a rate rejection there threw *out of the subscribe
callback*, so `applyServerFrameBatch` never ran and the entire frame batch was
never applied to any store. So this incident lost real frames from renderer
state, not only trace evidence, and the containment in `deliveryAck` closes that
path as well as the black window. This does not change the root cause; it adds a
consequence the first two versions of this report missed.

**What the funnel divergence does and does not prove.** Renderer-side stages reach
main as acknowledgements over `CH_DELIVERY_ACK` (`app/main/main.ts:1593`), so once
acknowledgement sends began throwing, those stages stopped being reported while
frames kept flowing. That makes acknowledgement loss the leading explanation,
and it is consistent with the console evidence above. It is not proof on its own:
`main.ipc.sent` records that main invoked `webContents.send`
(`app/main/main.ts:856-864`), which is not a receipt, so frame-delivery loss is
not excluded by these counts alone. The absence of any `trace.loss` record
excludes only loss inside the main-process trace sink
(`app/main/deliveryTraceSink.ts:156-203`); it says nothing about sidecar pipe
loss, frames never arriving, or acknowledgement batches failing before main.

**The sequence gaps are a different failure and were misread in the first version
of this report.** Three `trace.sequence.gap` records at 18:14:50.488,
18:14:51.405 and 18:14:53.062 show sequences 191, 192 and 193 arriving while the
sink expected 134, on stream epoch `fb89180c`. That anomaly is emitted **only**
for `stage === 'engine.produced'` (`app/main/deliveryTraceSink.ts:290-293`), so
it concerns missing *source-stage* trace records, not acknowledgements. It is
evidence for the sidecar diagnostics-loss defect described in the next section —
source-stage records dropped before ever reaching the main sink — and the
sidecar-side undercount agrees (`engine.produced` 136 against
`supervisor.socket.received` 193).

## Contributing defect: the log could not answer this question

The delivery trace alone could not distinguish lost frames from lost trace
records, because a second, independent defect suppresses exactly the record that
would have disambiguated it.

The sidecar's diagnostics writer drops records when its queue saturates
(`app/sidecar/operationalLogger.ts:76`) and reports the count through a
`log.suppressed` record (`app/sidecar/operationalLogger.ts:92`). That record is
emitted **without `appSessionId`**, and the supervisor requires an exact session
match on every inbound record:

```ts
if (!parsed || parsed.process !== 'sidecar' || parsed.appSessionId !== record.sessionId)
```

`app/supervisor/supervisor.ts:253`

So it is discarded and logged as "invalid". The same applies to every
`legacy(line)` record (`app/sidecar/operationalLogger.ts:159`), which is the
sink for the entire session-controller diagnostic stream
(`app/sidecar/index.ts:312`). Every other call site stamps `appSessionId`
explicitly (`app/sidecar/index.ts:168`, `:193`, `:362`, `:436`), and the fatal
path derives it from `activeAppSessionId` (`app/sidecar/index.ts:75`); only
these two paths have nothing to fall back on, because
`createSidecarOperationalLogger` takes no session id.

Confirmed in this launch: the two `log.suppressed` records present are both
`process: main`. The sidecar's never arrived.

The instrument that reports blindness is itself blinded, and it fails hardest on
the busiest session — which is the one that goes dark.

## Proposed fixes

Ordered by value. Items 1 and 2 require no protocol change and no movement of
`MAX_FRAMES_PER_WINDOW`. Item 3 is a boundary-design change and needs a recorded
decision.

1. **Make fault reporting non-fatal.** Wrap the guard and send in
   `reportRendererFault` (`app/preload/preload.ts:358`) in try/catch, and do the
   same at the two call sites that run during failure handling
   (`app/renderer/src/RendererErrorBoundary.tsx:17`,
   `app/renderer/src/main.tsx:44` and `:47`). This converts the black window into
   the intended recovery UI for this bug and for any future renderer error,
   whatever its cause. Note the precise claim: the report is then *dropped*
   rather than thrown. This makes reporting non-fatal, not guaranteed.
2. **Make acknowledgement flushing non-fatal, and flush on a timer.** Catch the
   overflow in `flushDeliveryAcknowledgements` (`app/preload/preload.ts:147`)
   and drop the batch rather than throwing; acknowledgements are diagnostics,
   the trace sink already has loss accounting, and every other diagnostics path
   in this codebase degrades silently by design. Replacing the `queueMicrotask`
   schedule (`app/preload/preload.ts:138`) with a short timer additionally makes
   batching coalesce across tasks, cutting guarded-send volume substantially and
   removing the 64-item synchronous branch as a routine occurrence.
   **This stops the crash. It does not stop telemetry from spending the budget** —
   the batches that ran before the overflow already incremented the shared
   counter (`app/preload/rendererIpcGuard.ts:39-44`), so a submit or permission
   response can still find the window full. That is item 3.
3. **Reserve capacity for control traffic.** Give diagnostics traffic a budget
   that cannot starve genuine user actions, while preserving size validation and
   the T7 flood posture for both classes. This is the actual composition defect
   and the only fix that makes user input immune to telemetry volume. It changes
   a security-baseline boundary, so it needs a decision record rather than an
   inline change.
4. **Stamp `appSessionId` on every sidecar operational record.** Give
   `createSidecarOperationalLogger` an `appSessionId` option — `args.sessionId`
   is already in hand at `app/sidecar/index.ts:162` — and default every `write`
   to it, keeping the supervisor's boundary check strict.
5. **Surface renderer faults in the dev terminal.** Scoped precisely: the
   incident in this report fired **neither** `did-fail-load` nor
   `render-process-gone` (`app/main/main.ts:1166`, `:1171`), so adding stderr
   output for those two would not have surfaced it. The channel that matters
   here is the renderer fault channel (`app/main/main.ts:1678-1701`), which is
   exactly what item 1 restores. Adding dev stderr output for the process-death
   events is still worth doing, as process-crash diagnostics — not as
   remediation for this incident.

## Test coverage gaps

- `app/preload/rendererIpcGuard.test.ts` covers the guard's shared-window
  behaviour, but nothing covers what an **overflow on the acknowledgement path**
  does to the application.
- `app/renderer/src/deliveryAcknowledgements.test.ts` covers ack ordering and
  post-commit evidence only; it has no rate or volume case, and nothing
  exercises the 64-item synchronous flush branch.
- Nothing covers a failure inside `componentDidCatch`, which is the step that
  turned a recoverable error into total unmount. A deterministic test here would
  also close the remaining doubt about the incident chain.
- Nothing covers a sidecar operational record reaching the supervisor through
  the `legacy` or `log.suppressed` paths.

Each proposed fix should land with the corresponding case.

## Confidence and open questions

**Established by source plus the console stack:** the shared-counter design; the
boundary's reporter using that same guard and being able to throw; the
synchronous flush branch reached from `App.tsx:606` inside a passive effect; the
sidecar records omitting `appSessionId` and being rejected at the supervisor.

**Established by first-party observation only:** the incident identifiers,
timestamps and stage counts.

**Open:**

- **A deterministic regression test for the chain.** The stack proves the
  synchronous path ran during this incident. A test that drives 64 pending
  acknowledgements through one effect and asserts the boundary renders its
  fallback would convert that from a well-evidenced reading into a guarded
  invariant, and would fail today.
- **The precise triggering rate.** The measurement that matters is
  `CH_DELIVERY_ACK` sends per rate window, which is not currently recorded.
- **Two launch ids.** This dev run produced two operational launches 19 seconds
  apart (`9b6efbd4` at 18:14:14, `93071dc6` at 18:14:33) where the terminal shows
  a single `dev` invocation. Not investigated; possibly unrelated.
