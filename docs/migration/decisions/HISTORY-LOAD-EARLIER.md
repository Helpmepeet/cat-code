# Load earlier messages — the one inbound verb that reaches back to disk

**Status: DECIDED (operator-approved 2026-08-19, AFK delegation), IMPLEMENTATION PENDING.**
Owns the single inbound vocabulary addition needed to make a truncated
transcript recoverable from inside the app. Origin: the message-visibility UX
review (`reviews/2026-08-19-transcript-message-visibility-ux-review.md`,
findings 1 and 6) established that the complete transcript always exists on
disk and no UI route reaches it. Sizing evidence:
`reports/2026-08-19-transcript-retention-cap-measurement.md`.

## Decision

**One parameterless inbound frame, `history.loadEarlier`, carrying nothing but
the session it applies to. The sidecar owns every number.** On receipt the
sidecar re-reads the display transcript through the SAME entry point the
restore path already uses, diffs it against what it has already replayed, and
emits the missing prefix as ordinary `replay: true` event frames followed by
one completion frame stating whether anything still remains beyond the ceiling.

No cursor. No offset. No count. No path. The renderer names a session and a
verb; it cannot influence how much is read or from where.

## Why parameterless, and why not paging

The measured corpus (1,849 engine transcripts) settles this. Records per
session: p50 82, p90 332, p99 1,075, **max 2,988**. Bytes per session: p50
326 KiB, p99 4.32 MiB, **max 18.1 MiB**. A whole real transcript fits in one
bounded read, so a cursor protocol would buy nothing and cost a validated,
attacker-reachable offset on the trust boundary.

This also satisfies the reuse rule (CLAUDE.md §8 mistake 10): the read goes
through `loadDisplayTranscriptFromJsonlPath` with a larger budget, exactly as
`app/sidecar/index.ts:271-299` already calls it. No second history loader
comes into existence, and the compaction-seam and subagent-splice behavior
that loader already owns is inherited rather than reimplemented.

## Rejected alternatives

- **Cursor/`before-uuid` paging.** Correct for a store with unbounded objects;
  this one has a measured 2,988-record maximum. It adds a renderer-supplied
  value on the inbound boundary that the sidecar would have to validate as a
  real, reachable uuid, for a scaling problem no measured session has.
- **Raising the retention caps instead.** The measurement says the caps are
  well sized: the ring's frame and byte budgets bind at essentially the same
  point (8,000 frames ≈ 7,745 frames at the measured 1,083 B mean). Raising
  them trades a bounded, user-initiated cost for a permanent one in every
  session, and the ceiling is Electron main, shared across 32 live sessions.
- **Resend everything and let the projector dedupe.** `seenFrameIds` would in
  fact absorb it, but it spends the whole transcript on the wire to deliver
  its missing prefix, and outbound framing is the one budget with a hard
  per-frame ceiling.

## Shape

**Inbound** (`app/shared/protocol.ts`, additive, no version bump):

    { kind: 'history.loadEarlier', protocolVersion, sessionId, requestId }

`requestId` is the standard request-scoped correlation id, engine-minted rules
unchanged. There are no other fields, and the sidecar's local schema must
REJECT any frame carrying extra properties rather than ignoring them.

**Outbound**: the recovered messages ride existing `event` frames with
`replay: true` — no new outbound transcript vocabulary.

Verified contract (2026-08-19), so the implementer does not rediscover it:
`loadDisplayTranscriptFromJsonlPath(filePath, { maxMessages, maxBytes })` lives
in the ENGINE at `src/utils/sessionStorage.ts:4811` and returns
`{ messages, truncated }`. `maxBytes` bounds the file read; `maxMessages`
slices the tail of the display chain. Its `truncated` is
`capped || (sourceTruncated && missingPredecessor)` — i.e. exactly the
"anything still above this?" signal the completion frame needs. No engine
change is required, which is what keeps this inside the reuse rule. They are followed by
`history.loadEarlier.result` carrying whether the transcript is now complete,
and the honest count of what was added.

## Bounds (T7, SECURITY-MINIMUM)

- **A new ceiling constant in `app/shared/limits.ts`** governs the deeper read.
  It must be sized above p99 (4.32 MiB) with margin and below the largest
  observed session (18.1 MiB) only if the implementer records why; the
  recommended starting value is 16 MiB with no message-count cap, since the
  measurement shows counts never bind.
- **One in-flight request per session.** A second `history.loadEarlier` while
  one is outstanding is rejected, not queued. The renderer's control is
  disabled while in flight, but the sidecar must not depend on that: the
  guard lives at the boundary, per SECURITY-MINIMUM's rule that inbound
  validation is a sidecar responsibility and never only a preload one.
- **Control class** for rate purposes (`IPC-RATE-BUDGET.md` §4): it is driven
  by user intent, is at most a few per session, and must not be throttled with
  the diagnostics class.
- Outbound frames stay under `MAX_OUTBOUND_FRAME_BYTES`; the directional limit
  split is untouched.
- Filesystem reach is unchanged: the sidecar resolves the transcript path from
  its own session identity via `getTranscriptPath()`, never from frame content.

## Renderer behavior

- The control appears on the truncation boundary row, and ONLY when that row is
  present. A complete transcript has no row and therefore no control.
- Panes with no live engine process (a read-only preview of a closed session)
  show the boundary row WITHOUT the control. Engaging with the session is what
  gains the capability. This is the deliberate inverse of the defect being
  fixed, where engaging WITHDREW the warning.
- Recovered messages land above the reader's position. `paneAnchorModel.ts`
  already moves `scrollTop` only for changes above the visible anchor, so
  reading position is preserved by the existing mechanism, not a new one.
- When the transcript is complete, the boundary row disappears entirely. Its
  absence is the completeness signal.

## Known cost, accepted

The projector is uncapped and `TranscriptView` mounts every row (no
virtualization; CC-59 Stage Two is deferred to a measured gate). Each recovered
page therefore stays mounted for the life of the pane. This is accepted because
the action is user-initiated, bounded by the ceiling above, and released on
close/park like all other per-session renderer state. It is the same axis CC-59
burned us on, so the implementer must not raise the ceiling without re-opening
that gate.

## Verification bar

- Sidecar boundary tests BOTH accepting a valid frame and rejecting: unknown
  extra properties, a wrong-typed `sessionId`, a second concurrent request.
- A live-path test proving recovered messages come from the real loader, not a
  fixture (CLAUDE.md §8 mistake 1).
- `bun run --cwd app test:hardening` all-pass with the new inbound kind present.
- A renderer test proving the control is absent when the transcript is complete
  and absent on a preview pane.
