# Renderer Blanks To Black: Delivery Acknowledgements Exhaust The IPC Rate Cap

**Date:** 2026-08-09
**Scope:** Electron desktop application (`app/`) — preload IPC guard, delivery-trace acknowledgement path, renderer error boundary. Secondary: sidecar → supervisor operational-record boundary.
**Status:** Diagnosed from a live incident. No runtime code changed.
**Severity:** High. Total, silent loss of the application UI during ordinary use, with the recovery UI and the crash telemetry both disabled by the same failure.

## Summary

During a normal development session the Cat Code Dev window went black. The
renderer process did not crash, did not hang, and did not fail to load: it was
still answering IPC health probes five minutes later. React had unmounted the
entire component tree.

The cause is a chain in which the application's own instrumentation destroys the
application:

1. Delivery-trace **acknowledgements** — pure telemetry — are sent through the
   same shared inbound rate budget as genuine user input.
2. They fail to batch in steady state, so ack traffic scales with the frame
   rate, at up to four acks per frame.
3. An ordinary streaming turn exceeds the 120-per-second cap. The guard fails
   closed and throws, correctly, into a React passive effect.
4. The error boundary catches it and reports the fault through the **same**
   exhausted budget, so the report throws inside `componentDidCatch`.
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
- The trigger is ordinary use, not an edge case. Roughly 30 frames per second of
  streaming output is sufficient.

## Environment

- Branch `migration`, dev launch via `bun run --cwd app dev`.
- Electron pid 6580, operational launch id `93071dc6`, window opened 18:14:33.
- Two live sessions: `20f8b31a` (first, resumed, 177 messages) and `000638f7`
  (second, started 18:14:50). The failure is confined to the second.

## Reproduction

Not isolated to a deterministic script. The observed conditions were:

1. Run the desktop app in dev with at least one session streaming engine output.
2. Start a second session and let it stream a turn of ordinary length.
3. The window blanks during the stream.

Any load that sustains more than about 30 delivery frames per second in a single
one-second window should reproduce it, since each frame yields up to four
acknowledgements against a 120-per-window budget.

## Root cause

### 1. The rate cap is a single shared budget

`MAX_FRAMES_PER_WINDOW = 120` per `RATE_WINDOW_MS = 1000`
(`app/shared/limits.ts:35`, `:38`). Every renderer → main call through the
preload passes `sendGuard.assertAllowed`, and this is deliberate and tested:
`app/preload/rendererIpcGuard.test.ts:18` is named "counts all fixed-channel
sends in one shared rate window" and asserts the throw. The guard is not
malfunctioning. It is being spent by traffic it was never sized for.

### 2. Acknowledgements do not batch in steady state

`sendDeliveryAcknowledgement` (`app/preload/preload.ts:113`) pushes onto a
pending array and schedules the flush with **`queueMicrotask`**
(`app/preload/preload.ts:136`). A microtask drains at the end of the current
task, and each arriving frame is delivered in its own task, so in steady state
each acknowledgement flushes alone. The `MAX_DELIVERY_ACKS_PER_BATCH = 64`
coalescing at `app/preload/preload.ts:87` only engages when acks accumulate
synchronously, which happens on the renderer's effect-drain path
(`app/renderer/src/App.tsx:603`) but not on the per-frame receipt path.

Each frame can produce four acknowledgements — `preload.received`,
`renderer.subscription.received`, `renderer.state.applied`, and
`renderer.ui.committed` (the accepted stage list is at `app/main/main.ts:355`).
So the effective ack rate is up to 4× the frame rate, each one consuming a slot
in a 120-slot budget shared with every user action.

### 3. The guard throws into a React effect

`flushDeliveryAcknowledgements` calls `sendGuard.assertAllowed(payload)`
unguarded at `app/preload/preload.ts:152`. Failing closed is right for hostile
input; here the caller is application code on a passive-effect path, so the
throw escapes into React's commit phase.

Observed console output:

```
Uncaught Error: renderer IPC rate exceeds 120 frames per 1000ms
    at Object.assertAllowed
    at flushDeliveryAcknowledgements
```

### 4. The error boundary is disabled by the same budget

`RendererErrorBoundary.componentDidCatch` calls
`getBridge().reportRendererFault('component', error.message)`
(`app/renderer/src/RendererErrorBoundary.tsx:17`). That path runs
`sendGuard.assertAllowed` at `app/preload/preload.ts:361`, which is still over
budget, so it throws **inside `componentDidCatch`**.

Note that the fault reporter has its own limiter,
`MAX_RENDERER_FAULTS_PER_MINUTE = 12` (`app/preload/preload.ts:90`), checked at
`app/preload/preload.ts:108` — but that check runs *before* `assertAllowed`, so
it provides no protection here.

React cannot recover from an error thrown in a boundary's own lifecycle. It
reported exactly that:

```
An error occurred in the <RendererErrorBoundary> component.
```

With no boundary above the root, React unmounts the whole tree. **This is the
black window.** The fallback markup in `RendererErrorBoundary.render` is
correct and simply never runs.

### 5. The uncaught handler repeats the failure

`window.addEventListener('error', …)` at `app/renderer/src/main.tsx:44` also
calls `reportRendererFault`, and throws for the same reason. The
`unhandledrejection` handler at `app/renderer/src/main.tsx:47` shares the flaw.

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

Three `trace.sequence.gap` records at 18:14:50.488, 18:14:51.405 and
18:14:53.062 show sequences 191, 192 and 193 arriving while the sink still
expected 134, all on stream epoch `fb89180c`.

**Those gaps are lost acknowledgements, not lost frames.** Renderer-side stages
reach main as acknowledgements over `CH_DELIVERY_ACK`
(`app/main/main.ts:1593`), so once the ack flush threw, the stages stopped being
reported while frames kept flowing. `main.ipc.sent = 193` confirms main sent
them. This reading is supported by the absence of any `trace.loss` record —
the sink emits one whenever it drops a record itself
(`app/main/deliveryTraceSink.ts:186`) — and by the absence of file rotation
during this launch (a single 1.37 MB trace file against a ~20 MB rotation
threshold).

## Contributing defect: the log could not answer this question

The delivery trace alone could not distinguish "frames were lost" from "trace
records were lost," because a second, independent defect suppresses exactly the
record that would have disambiguated it.

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
`process: main`. The sidecar's never arrived. The sidecar-side stage counts
undercount accordingly (`engine.produced` 136 against
`supervisor.socket.received` 193).

The instrument that reports blindness is itself blinded, and it fails hardest on
the busiest session — which is the one that goes dark.

## Proposed fixes

Ordered by value. None require a protocol change, a new inbound frame kind, or
any movement of the security baseline; `MAX_FRAMES_PER_WINDOW` stays where it is.

1. **Make fault reporting unkillable.** Wrap the guard and send in
   `reportRendererFault` (`app/preload/preload.ts:358`) in try/catch so a
   saturated budget cannot suppress a crash report. This alone converts the
   black window into the intended recovery UI, for this bug and for every future
   renderer error regardless of cause. The rate cap is unchanged; the report is
   simply dropped rather than thrown.
2. **Stop telemetry from spending the user-input budget.**
   - Make `flushDeliveryAcknowledgements` (`app/preload/preload.ts:147`)
     best-effort: drop the batch when over budget instead of throwing.
     Acknowledgements are diagnostics, the trace sink already has loss
     accounting, and every other diagnostics path in this codebase already
     degrades silently by design.
   - Replace the `queueMicrotask` flush (`app/preload/preload.ts:138`) with a
     short timer so batching actually coalesces, cutting ack IPC volume by
     roughly one to two orders of magnitude.
3. **Stamp `appSessionId` on every sidecar operational record.** Give
   `createSidecarOperationalLogger` an `appSessionId` option — `args.sessionId`
   is already in hand at `app/sidecar/index.ts:162` — and default every `write`
   to it, keeping the supervisor's boundary check strict.
4. **Surface renderer death in the dev terminal.** `did-fail-load` and
   `render-process-gone` (`app/main/main.ts:1166`, `:1171`) currently log only
   to JSONL. Under `IS_DEV` they should also write to stderr, so a dead renderer
   stops looking identical to a healthy one.

## Test coverage gaps

- `app/preload/rendererIpcGuard.test.ts` covers the guard's shared-window
  behaviour, but nothing covers what an **overflow on the acknowledgement path**
  does to the application.
- `app/renderer/src/deliveryAcknowledgements.test.ts` covers ack ordering and
  post-commit evidence only; it has no rate or volume case.
- Nothing covers a failure inside `componentDidCatch`, which is the step that
  turned a recoverable error into total unmount.
- Nothing covers a sidecar operational record reaching the supervisor through
  the `legacy` or `log.suppressed` paths.

Each proposed fix should land with the corresponding case.

## Open questions

- **Ack volume budget.** Should acknowledgements have their own budget separate
  from user input rather than merely failing softly on the shared one? Softening
  the failure fixes the crash but leaves telemetry competing with user actions
  for slots, which could still starve real input under sustained load. This is a
  boundary-design question and is deliberately left out of the fixes above.
- **Two launch ids.** This dev run produced two operational launches 19 seconds
  apart (`9b6efbd4` at 18:14:14, `93071dc6` at 18:14:33) where the terminal shows
  a single `dev` invocation. Not investigated; possibly unrelated.
- **Exact frame rate at failure.** The 4-acks-per-frame multiplier and the
  120/1000ms cap give a threshold near 30 frames per second, but the precise
  burst that tripped it was not measured, because the acks that would have
  recorded it are the ones that died.
