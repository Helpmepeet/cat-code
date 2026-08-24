# GOAL-SNAPSHOT-SURFACE — what a goal sends across the wire

> **STATUS: DECIDED 2026-08-25 — accept the current full-record snapshot, with
> the limits below written down.** Raised by the goal-loop implementation review
> as "the wire surface widened without a decision record". It had: the durable
> goal grew from a small record to one carrying a contract, an evidence ledger,
> a call-fingerprint history, and attempt/lease bookkeeping, and because
> `AppGoalSnapshot = ThreadGoal` every one of those fields began crossing to the
> renderer and to `web/` with no one deciding it should.

## The surface

`app/shared/engine-types.snapshot.d.ts` defines `AppGoalSnapshot` as
`ThreadGoal | null`, and the desktop forwards raw `AppSessionEvent` frames
(a locked decision, `docs/migration/decisions/`). So whatever the durable goal
holds, the renderer and `web/` receive.

Today that includes `contract`, `evidence`, `callHistory`, `pendingAttempt`,
`recentWakeKeys`, and `chargedResponseIds` in addition to the objective,
status, and counters the UI actually renders.

## What consumers read

- `web/src/App.tsx` reads four fields: `objective`, `status`, `tokensUsed`,
  `tokenBudget`.
- The desktop goal card renders `formatThreadGoalSummary`, which additionally
  needs the counters, `childAgentIds.length`, and the required criteria
  (`id` + `verifyCommand`) for its "Required before complete" list.

Nothing reads `evidence`, `callHistory`, `recentWakeKeys`, `pendingAttempt`, or
`chargedResponseIds`.

## Decision

**Accepted as-is. Not narrowed.** The reasoning, so a later reader can weigh it
rather than re-derive it:

1. **It is not a disclosure boundary.** Renderer, `web/`, and engine are the
   same user on the same machine. `secretGuard` still runs on outbound frames,
   and evidence persists digests rather than command output.
2. **Narrowing is a breaking shape change**, which under `CLAUDE.md` §6 means a
   `protocol.ts` version bump with a stated reason, a re-synced type snapshot,
   the drift tripwire, and boundary tests on both consumers. That is design
   work, not a review fix, and it was not what the loop overhaul asked for.
3. **The cost of carrying it is bounded** by `MAX_THREAD_GOAL_EVIDENCE` (128)
   and the wake/call-history caps, and by `MAX_OUTBOUND_FRAME_BYTES`.

## The sharp edge, stated rather than fixed

`evidence[].label` is **the user's `verifyCommand`, verbatim**. It is the one
field on this record that is neither digested nor derived: it is typed text
that crosses to the renderer and is included in the judge bundle.
`secretGuard` matches key names, not values, so a credential typed into
`/goal require` is persisted and forwarded. This is the user's own text rather
than model- or output-derived, but it is not the same as "nothing raw is
stored", and `src/utils/threadGoalEvidence.ts` says so in its module doc.

If that stops being acceptable, the narrowing to prefer is a purpose-built
projection carrying objective, status, statusReason, the counters, the child
count, and required criteria ids only, leaving evidence, call history, and
attempt bookkeeping engine-side.
