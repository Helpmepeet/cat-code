# F2 — Restored history → renderer (the replay-on-attach decision)

**Status: DECIDED (operator-approved) + IMPLEMENTED 2026-07-05; AMENDED 2026-08-01.** Owns the one wire change
Phase 3's restore story needs beyond F1. Origin: the host-plane integration review
(`reviews/2026-07-05-p3-host-plane-review.md` F2) found that even with F1 fixed (the resumed
`Message[]` seeded into the engine), nothing carried restored history to the renderer — a
restored session rendered empty. Proposal reviewed and approved as recommended; this doc is
the owning record (E-7 precedent: vocabulary additions get an owning decision, like C2/C3 in
`PERMISSION-BOUNDARY.md`).

## Decision

**Replay the display transcript as standard `event` frames on sidecar attach, converted by
the engine's own `toSDKMessages` mapper, marked with one additive optional field.** The model
seed remains the compacted resume projection. Display history is an archival prefix followed
by the exact visible model-seed tail; internal no-response sentinels stay engine-only. No new
frame kind; no new inbound vocabulary; renderer works unchanged.

The in-tree precedent that settled it: the remote/RC bridge already replays `initialMessages`
via an injected `toSDKMessages` + history cap to a late-attaching display client
(`src/bridge/remoteBridgeCore.ts:101-103,149-152`, `src/bridge/initReplBridge.ts:451-453`).
This is that idiom on our socket.

## Shape (current)

- **Two projections, exact shared tail (amended 2026-08-01):**
  `resumeEngineSession().messages` remains the sole engine seed (`initialMessages`). The display
  loader reads an independently bounded archival tail from the same JSONL and walks
  `parentUuid`, falling through a compact boundary's persisted `logicalParentUuid` only for
  display. Preserved-segment compactions are spliced into display topology without pruning:
  summarized archival rows remain before the seam and every preserved UUID appears once in
  its exact model-seed position after the seam. `app/sidecar/index.ts` aligns the two
  projections by UUID and replaces the display
  suffix with the exact `projectResumedHistory(resumedMessages)` output. The invariant is now
  **display = archival prefix + byte-identical visible engine-seed tail**, not
  **display = engine seed**. A failed alignment falls back to the seed and announces
  truncation rather than presenting drift. Current internal sentinels carry
  `isInternalNoResponseSentinel`; legacy silent rate-limit fallback records are recognized only
  by the conjunction of `isApiErrorMessage` and the exact sentinel-only payload. A genuine
  assistant response with identical text remains visible because content alone never filters.
- **Bounded archival read:** the display loader reads at most 8 MiB of the newest JSONL payload
  bytes plus a one-byte line-alignment probe, and at most 4,000 messages. A missing older
  predecessor is reported to the existing replay truncation path. The backfill worker uses the
  same display loader and the same normalized-seed merge as live replay. The model loader keeps
  its compact-pruning optimization and is unchanged.
- **Frame:** `EventFrame` gains `replay?: true` (`app/shared/protocol.ts`), set ONLY on
  attach-time history frames, never on live events. Additive under `PROTOCOL_VERSION = 1`
  (the `ReadyFrame.engineSessionId` precedent); the renderer may ignore it (rows render
  identically — test-proven) or use it for a "restored" divider / notification suppression
  (P3-5's call).
- **Order:** per attaching connection, after `ready` + the C3 `permission.context` snapshot,
  before any live event — single-socket ordering, no sequencing machinery
  (`sidecarServer.ts` `sendHistoryReplay`).
- **Cap + truncation:** the NEWEST contiguous tail is kept under BOTH
  `MAX_HISTORY_REPLAY_FRAMES` (4,000) and `MAX_HISTORY_REPLAY_BYTES` (4 MiB)
  (`app/shared/limits.ts`); stop-not-skip, so never a mid-history hole. Any omission emits
  the boundary error frame `requestId: 'catcode.history-truncated'`
  (`HISTORY_REPLAY_TRUNCATION_REQUEST_ID`, protocol.ts) BEFORE the tail — the exact
  `replayBuffer.ts` truncation idiom, so a capped replay is visibly lossy, never silent.
- **Reload alignment (operator-held seam):** both caps sit STRICTLY below main's per-session
  replay-buffer budgets (8,000 frames / 16 MiB, `app/main/replayBuffer.ts`), with headroom for
  early live frames, so a renderer reload replays the SAME history from main's
  buffer. Enforced by `app/main/historyReplayReload.test.ts` (invariant + an at-cap
  functional pass through the real `AttachmentGate` + `FrameReplayBuffer`); byte accounting
  matches the buffer's (serialized UTF-8 JSON of the whole frame).
- **Deliberate asymmetry:** the ENGINE seed (F1) is the compacted resume transcript
  (TUI-`--resume` parity). Display replay may additionally include archival history and is
  capped independently.

## Security posture (baseline unchanged)

Outbound-only. Every replay frame passes the normal outbound path — `prepareOutboundPayload`
(clone + JSON-safe) then `send` (secretGuard + `MAX_OUTBOUND_FRAME_BYTES`) — per frame. No
inbound vocabulary added (`checkStrictKeys` untouched); no new preload surface (frames ride
the existing `subscribe`); T4/T5a/T6/T6b/T7 + HC1–HC4 unaffected.

## Degenerate cases

- Fresh session (no resume): no history option, nothing sent — attach behavior unchanged.
- Un-serializable restored message: dropped + replay marked truncated (should be
  unreachable for JSONL-round-tripped content).
- Oversized transcript: capped with the visible boundary; a single frame bigger than the
  whole byte budget retains nothing but still announces (mirrors `replayBuffer.ts`).
- Engine-side resume normalization remains model-faithful while internal no-response
  bookkeeping stays invisible. The API-validity assistant appended by
  `conversationRecovery.ts` remains in the engine seed, but its explicit internal tag excludes
  it from terminal and desktop replay. Silent API fallback records are also excluded from the
  live SDK normalizer and the general internal→SDK mapper; legacy persisted fallback records use
  the narrower API-error-plus-exact-payload compatibility check. The archival prefix comes from
  the bounded display read; the aligned tail comes from the engine's normalized seed. Replay
  frame/byte caps and the model's no-pre-compaction-context boundary are unchanged.

## Rejected (from the reviewed proposal)

- **Single `history` frame (new kind):** races `MAX_OUTBOUND_FRAME_BYTES` on big
  transcripts — worst degenerate is a silently empty restore; chunking it reinvents
  per-message frames.
- **Widen `ReadyFrame`/`AppReadyPayload`:** R2/R6 precedent (engine-owned type shared with
  the WS server) + the same single-frame size bomb.
- **Control-plane transcript read (main reads JSONL for the renderer):** violates HC3 ("no
  method that returns filesystem contents"), duplicates projector semantics renderer-side,
  bypasses engine truth.
- **Pull model (renderer requests history):** new inbound vocabulary + validation surface
  for a thing wanted exactly once at attach; revisit only if v2-remote needs pagination.

## Tests (desktop suite plus focused engine tests)

`src/utils/conversationRecovery.test.ts` (manual-compact fixture, API validity, interruption
control, terminal visibility) · `src/utils/queryHelpers.test.ts` (live SDK suppression and
genuine-text control) · `src/utils/messages/mappers.test.ts` (general SDK projection suppresses
current/legacy internal records without content-only filtering) ·
`src/utils/sessionStorage.test.ts` (display chain crosses
`logicalParentUuid` without changing resume; suffix/prefix preserved segments; exact byte-tail
alignment; mixed-ID ordering and provider-persistence continuity) ·
`app/sidecar/historyProjection.test.ts`
(archival-prefix + exact-seed-tail invariant, recovery and rate-limit sentinel provenance) ·
`app/sidecar/historyReplay.test.ts` (order/flag/caps/truncation) ·
`app/main/historyReplayReload.test.ts` (cap alignment + reload preservation) ·
`app/renderer/src/restoredHistoryRender.test.ts` (compact boundary renders; replay flag
invisible) ·
`app/sidecar/spawnConfig.probe.test.ts` (b) (REAL resumed sidecar replays the minted
transcript over the wire, including compacted archival history) ·
`app/sidecar/transcriptBackfillWorker.probe.test.ts` (backfill uses the same compacted display
projection and drops a raw unresolved-tool tail removed from the normalized seed) ·
`app/sidecar/resumeSeed.probe.test.ts` (exact visible F1 seed tail).
