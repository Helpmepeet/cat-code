# IPC-RATE-BUDGET — reserving inbound capacity so diagnostics cannot starve user actions

> **STATUS: OPERATOR-RULED 2026-08-09.** Extends `SECURITY-MINIMUM.md` T7 / R4;
> does not amend or relax it. Prompted by the black-window incident of the same
> day (`docs/reports/2026-08-09-renderer-black-window-delivery-ack-rate-cap.md`,
> STATUS row CC-38). The operator ruled to build this without waiting for the
> observational trigger proposed in that report (see §6).

## 1. The problem

T7/R4 gives the renderer → main direction a single fixed-window rate cap,
`MAX_FRAMES_PER_WINDOW = 120` per `RATE_WINDOW_MS = 1000` (`app/shared/limits.ts`),
enforced for every fixed channel by one shared counter
(`app/preload/rendererIpcGuard.ts`). One counter is the right shape for a flood
bound: it is what makes the cap total rather than per-channel, so a compromised
renderer cannot multiply its allowance by spreading traffic across channels.

The cap was sized for a hostile renderer, not for the application's own
telemetry. Delivery-trace acknowledgements are high-volume, automatic, and scale
with engine output, and they draw on the same 120 slots as a prompt submit or a
permission response. On 2026-08-09 they exhausted the window during an ordinary
streaming turn.

Containing the resulting exception (CC-38) stops the crash but not the
starvation: batches sent before an overflow have already spent the counter, so a
genuine user action can still arrive at a full window. That failure is *correct*
per T7 and still wrong for the user.

## 2. Rejected alternatives

- **Raise `MAX_FRAMES_PER_WINDOW`.** Buys headroom by widening the flood surface,
  which is the one thing T7 exists to bound. Rejected outright.
- **Give diagnostics their own independent 120.** Two independent budgets means a
  total inbound ceiling of 240: the flood surface doubles while each individual
  cap still looks unchanged. Rejected.
- **Exempt diagnostics from the guard.** An unbounded channel is exactly the T7
  threat, regardless of which code authors the traffic.
- **Drop the acknowledgements entirely.** They are the only evidence that a frame
  reached and was applied by the renderer; the 2026-08-09 diagnosis depended on
  them.
- **Do nothing and rely on the containment already shipped.** Defensible, and it
  was the recommendation pending measurement (§6). Overruled by the operator.

## 3. Decision

**One total ceiling, with a sub-cap on the diagnostics class inside it.**

- `MAX_FRAMES_PER_WINDOW = 120` per window is **unchanged** and remains the total
  inbound bound across all fixed channels. The flood surface does not move.
- `MAX_DIAGNOSTIC_FRAMES_PER_WINDOW = 80` bounds how much of that total the
  diagnostics class may occupy.
- Therefore **at least 40 slots per window are always available to control
  traffic**, no matter how much telemetry the renderer produces.
- Control traffic is *not* capped below the total: with the window otherwise
  quiet, a user action may still use up to the full 120.

The guarantee is one-directional and deliberately so. Diagnostics can be starved
by user actions; user actions cannot be starved by diagnostics.

**The reservation is per window, not per rolling second.** The guard implements a
fixed (tumbling) window: counters zero on the first call after the boundary. So
an interval straddling a boundary can carry up to 240 total and 160 diagnostics.
That burst behaviour is pre-existing in the total cap and is not introduced here,
and the ≥40 control reservation holds within every window, but a reader
reasoning about the flood bound should not assume a rolling window.

### Sizing

An acknowledgement flush carries up to `MAX_DELIVERY_ACKS_PER_BATCH = 64`
acknowledgements per guarded send, and CC-38 moved the schedule to a 50 ms timer,
so steady-state acknowledgement traffic is on the order of 20 sends per second.
80 leaves roughly four times that headroom before diagnostics are throttled at
all, while still reserving a third of the window. The number is a policy choice,
not a measurement; it should be revisited if §6's counter shows the diagnostics
class routinely approaching it.

## 4. Classification

**Diagnostics class — the acknowledgement flush only.**
It is the only high-volume renderer → main sender: its rate is a function of
engine output, not of user intent, and nothing downstream of it is user-visible.

**Control class — everything else, including two senders that are arguably
diagnostics but must not be throttled with them:**

- **`reportRendererFault`.** It is bounded independently to
  `MAX_RENDERER_FAULTS_PER_MINUTE = 12` and so cannot flood on its own. It is
  also the single highest-value record precisely when the window is saturating,
  which is the condition it exists to report. Throttling the crash reporter
  alongside the traffic causing the crash is the mistake CC-38 already made once.
- **The delivery health response.** Roughly one per five seconds, and it is the
  liveness signal main uses to decide the renderer is alive
  (`app/main/main.ts`). Starving it would make main record a false
  `renderer.health.missed` for a healthy renderer, converting a telemetry flood
  into a fake outage. Since CC-39 the cost is higher than one warning: sustained
  starvation escalates to an error-level `renderer.health.unavailable` that then
  repeats every minute, so a healthy renderer would be reported as a continuing
  outage rather than a single blip.

## 5. Failure semantics

**Budget class and failure class are separate axes, and conflating them is a
mistake this document made in its first revision.** A sender's budget class
(§4) decides how much of the window it may take. Its failure class decides what
happens when it is refused. The two do not have to agree, and for the fault
reporter and the health response they deliberately do not: both are control
class *and* silent.

The rule that matters is about **user actions**, not about control class:

- **No user-action sender is wrapped.** A submit, a permission response or a
  verb still throws and stays visible, because a silently dropped user action is
  a worse outcome than an error the user can see.
- **All three telemetry senders swallow their rejection** — the acknowledgement
  flush, the fault reporter, and the health response. Two of them are control
  class; swallowing is about the cost of the loss, not the size of the budget.

Rejection handling differs by what the rejection means:

- A **rate** rejection clears when the window rolls, so the acknowledgement
  flush retains the batch and retries it, bounded (§3 sizing). Dropping it
  instead would be worse than losing evidence: `updateWatermarks` advances each
  stage by a contiguous scan, so a discarded batch pins the watermark and
  `firstMissing` then reports a renderer stall that never happened. Note the
  honest limit: retention narrows fabricated evidence to starvation deeper than
  the bound, it does not eliminate it, because any ack actually dropped still
  pins the watermark.
- A **size** or **serialization** rejection is a property of the payload and
  would refuse identically forever, so it is dropped rather than retried. The
  guard reports which kind it raised for exactly this reason.

In every case the guard still runs and a rejected payload is never sent, so the
cap remains strictly more restrictive than the traffic offered to it.

## 6. What this does not settle

The report recommended measuring before building: user-action starvation would
now surface as the recovery panel appearing during a heavy turn, and if it never
appeared, this work was unnecessary. The operator chose to build it rather than
wait for that signal, so the sizing in §3 rests on the arithmetic above rather
than on observed contention.

The measurement that would confirm or resize it is still not recorded anywhere:
guarded sends per window, per class. Until that exists, `80` should be treated as
a first estimate that no evidence has yet contradicted.

## 7. Verification bar

- The guard rejects a diagnostics payload once the sub-cap is spent, while a
  control payload in the same window still passes. This is the assertion the
  whole decision exists to make true, and it fails without the change.
- The total ceiling still rejects both classes at 120.
- `bun run --cwd app test:hardening` green; no new inbound frame kind, no new
  preload channel, no protocol change.
