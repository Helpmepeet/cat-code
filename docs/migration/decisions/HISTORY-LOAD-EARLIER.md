# Load earlier messages — the one inbound verb that reaches back to disk

**Status: DECIDED (operator-approved 2026-08-19). WIRE HALF IMPLEMENTED 2026-08-20 (`a14d94bc`). RENDERER HALF IMPLEMENTED 2026-08-20: the control ships on the boundary row and the reading position now anchors on row identity. B1/B2/B4/B5 all CLOSED — see §Blockers. What remains is operator acceptance of a live press, which no headless suite can give.**
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

**Inbound** (`app/shared/protocol.ts`, additive, no version bump).

CORRECTED 2026-08-20 against source. This doc originally specified a top-level
`kind`, which no inbound frame in this app has. Every inbound frame is a
`ClientFrame` envelope (`protocol.ts:505`) and `handleFrame` validates the
envelope before dispatch, so the shipped shape carries the same four pieces of
information in the repo's real envelope:

    { protocolVersion, sessionId, message: { type: 'history.loadEarlier', requestId } }

`requestId` is the only renderer-authored byte. No cursor, offset, count or
path exists on the frame.

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
- **Per-reader state (amended 2026-08-20).** The recovery anchor and the
  completeness latch are per-`Connection`, not per-session, and are reassigned
  every time a connection attaches and is replayed. This doc originally implied
  session state; that was wrong in a way only a reload exposes. Because every
  new connection is replayed the same original tail, a session-scoped anchor
  advanced by an earlier reader would leave a reloaded renderer computing its
  missing prefix from an anchor it was never sent, and recovering nothing. The
  in-flight guard below IS still per-session, which is correct: it bounds work,
  not reader position.
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

## Blockers on the renderer half (found 2026-08-20, before any UI was written)

The wire half is landed and inert. Two problems the design above did not
anticipate must be settled before a control can be shown. Neither is a reason
to change the wire contract.

B1, B2 and B4 are CLOSED (2026-08-20). They share one mechanism: an additive
optional `recovered?: true` on `EventFrame`, set by the load-earlier path alone
and never by the attach replay. A recovered frame is genuinely replayed history
and therefore sets BOTH `recovered` and `replay`; the marker exists only to tell
an INSERTION apart from an append. No version bump, no cap moved, no new inbound
surface.

### B1 — the projector is append-only, so recovered rows would land at the BOTTOM
**CLOSED 2026-08-20.**

`appendFrameRows` (`app/renderer/src/transcriptProjector.ts:1757`) does
`rows: [...state.rows, ...rows]` and there is no `.sort()` anywhere in the
module. **Transcript order is frame ARRIVAL order.** Restore works only because
replayed history happens to arrive before anything else. Messages recovered
mid-session would therefore render underneath the conversation they precede.

The wire half's report claimed "the projector needs no change at all". That is
false, and it was reasoned from the restore path. Verified by reading, not
assumed.

Built: `TranscriptSessionState.recoveryInsertAt` is a head-insertion cursor,
`null` for every ordinary frame. `appendFrameRows` and the assistant path's
`upsertFrameRows` each carry ONE extra branch, taken only when that cursor is
non-null, so the append every other frame gets is untouched. The cursor counts
up through a batch (frames arrive oldest-first; inserting each at 0 would
reverse them) and resets on the closing `history.loadEarlier.result`, so a
second recovery — which reaches further back — stacks above the first.

`projectServerFrame` re-derives the cursor from EVERY event frame it projects: a
frame without `recovered` forces it back to `null`. That is what makes an
interrupted batch harmless — if the closing result never arrives because the
connection dropped, the next ordinary frame closes it, and it cannot corrupt a
later batch.

The read-time caches hold: rows on both sides of the cut are the same objects in
the same order, so the row-keyed caches still hit; the slice-keyed
`nestedRowsCache` / `revealedNestedRowsCache` miss, which is required, because
the boundary row is synthesized above `rows[0]` and `rows[0]` just changed.
Pinned by `transcriptProjector.test.ts` ("the boundary row stays above the newly
inserted rows", "an insertion leaves every existing row object identical").

Still open on the memory axis: the measured pass this note asked for was NOT
run. The insertion allocates one new row array per recovered frame, the same
per-frame cost the append path already pays, so nothing new is expected — but
expected is not measured, and the §Known cost note above still governs.

### B2 — recovered frames enter main's replay ring and can evict live history
**CLOSED 2026-08-20.**

Recovered `event` frames flow through the normal outbound path into main's
per-session ring (8,000 frames / 16 MiB, `app/main/replayBuffer.ts`). The ring
evicts oldest-by-ARRIVAL, so a large recovery evicts the OLDEST LIVE frames
while retaining the ancient ones that just arrived. A renderer reload after a
big recovery could then replay a transcript with a hole in the middle, which
is strictly worse than the contiguous tail the boundary row promises.

Ruling, made and built: **recovered frames are not retained in the ring at
all.** The ring exists to restore a reloaded renderer to what it was showing;
recovered history is by definition re-fetchable from disk on demand, so dropping
it on reload costs one more click and keeps every retained tail contiguous.

`FRAME_RETENTION` is keyed by frame KIND and both a restore replay and a
recovered frame are kind `'event'`, so the discrimination cannot live in that
table — it sits in `record`, where the ring decides to retain, and the table's
exhaustiveness tripwire is untouched. It deliberately does NOT set
`entry.truncated`: nothing was evicted, so the retained tail is exactly as
complete as it was, and the boundary row the renderer draws from the sidecar's
own signal still says what is true. No cap value moved.

### B4 — nothing clears the boundary row when the transcript becomes whole
**CLOSED 2026-08-20.**

`HistoryLoadEarlierResultFrame.complete` is documented as the signal that the
truncation-boundary row goes away. No such path exists.
`TranscriptSessionState.historyTruncated` latches permanently once set and is
cleared only by `resetTranscriptSession` on the preview-to-live handover
(`transcriptProjector.ts`). A renderer wired to this frame without adding a
clearing path would leave the row standing over a transcript that is now
complete, which inverts the design's own completeness signal ("absence of the
row means you are seeing everything").

Built: `projectServerFrame` clears `historyTruncated` when a
`history.loadEarlier.result` arrives with `ok` AND `complete` for that session,
which removes the read-time boundary row because the row is synthesized from
that flag alone. Gated on `ok` too: a refusal learned nothing, and leaving the
boundary standing is the recoverable direction (press again) while removing it
wrongly is not. The `complete` doc comment in `protocol.ts` no longer carries the
"NOT yet implemented" caveat.

### B5 — index-based scroll anchoring assumes the projector only appends
**CLOSED 2026-08-20.**

The per-session scroll memory (`transcriptScrollMemory.ts`) anchors on row
INDEX plus intra-row offset. That is exact under appends and wrong under
anything that renumbers the head of the list, which is precisely what B1's fix
would introduce. The `rowsToken` guard fails safe (a changed first-row id
discards the anchor and opens at the end), so nothing renders wrongly, but the
user would be thrown to the bottom at the exact moment they loaded earlier
history, which is the opposite of the promised "you stay where you were
reading".

Built as that fix shape. `TranscriptScrollAnchor` carries a `rowKey` instead of
a `rowIndex`, `TranscriptView` publishes each display item's key on its row
wrapper as `data-row-key`, and `readTranscriptRowGeometry` reads the key back
off the DOM — which is what lets the anchor survive the grouping passes
(delegate groups, reasoning runs, tool runs) without the scroll memory knowing
them. The `rowsToken` guard is GONE rather than relaxed: with identity
anchoring, its whole job (notice that the head moved) is the case that must NOT
discard the anchor. Every earlier guarantee is pinned by the same tests it
always was: a never-opened session opens at the end, a pane left pinned to the
end lands at the new end, a key no longer in the list falls back to the end, and
one capture per frame still costs 13 boxes on a 2,000-row pane.

Cost, accepted: every top-level row now renders inside a wrapper `div` that
carries the key. The nested lists already did this (`data-transcript-child`), and
the revealed-hidden branch already wrapped its rows, so the shape is not new —
but it is one DOM level per row across the whole column, and the flex item is
now the wrapper rather than the row. Nothing in the headless suite can see a
layout difference; a live pane is what would.

### B3 — subagent branches on the recovered prefix

`withRestoredSubagentHistory` keeps its existing budget, so on a session
already at the replay cap a recovered Agent card can arrive without children.
That degrades to the card built for exactly this case (CC-73, "This agent's
steps aren't loaded.") and is never a wrong tree, so it is acceptable as-is and
recorded rather than fixed.
