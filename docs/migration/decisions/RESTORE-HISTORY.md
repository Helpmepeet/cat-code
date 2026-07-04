# F2 — Restored history → renderer (the replay-on-attach decision)

**Status: DECIDED (operator-approved) + IMPLEMENTED 2026-07-05.** Owns the one wire change
Phase 3's restore story needs beyond F1. Origin: the host-plane integration review
(`reviews/2026-07-05-p3-host-plane-review.md` F2) found that even with F1 fixed (the resumed
`Message[]` seeded into the engine), nothing carried restored history to the renderer — a
restored session rendered empty. Proposal reviewed and approved as recommended; this doc is
the owning record (E-7 precedent: vocabulary additions get an owning decision, like C2/C3 in
`PERMISSION-BOUNDARY.md`).

## Decision

**Replay the restored transcript as standard `event` frames on sidecar attach, converted by
the engine's own `toSDKMessages` mapper, marked with one additive optional field.** No new
frame kind; no new inbound vocabulary; renderer works unchanged.

The in-tree precedent that settled it: the remote/RC bridge already replays `initialMessages`
via an injected `toSDKMessages` + history cap to a late-attaching display client
(`src/bridge/remoteBridgeCore.ts:101-103,149-152`, `src/bridge/initReplBridge.ts:451-453`).
This is that idiom on our socket.

## Shape (as landed)

- **One source, no drift (composes with F1):** `app/sidecar/index.ts` converts the SAME
  `resumeEngineSession().messages` array that seeds the engine (`initialMessages`) —
  `toSDKMessages(resumedMessages)`, converted after resume so `getSessionId()` stamps the
  adopted engine id. Enforced by test: a source-level one-variable assertion
  (`resumeSeed.probe.test.ts`) + a runtime uuid-for-uuid match between the mapper output and
  the live QueryEngine's seeded state (`resumeSeedProbe.fixture.ts`).
- **Frame:** `EventFrame` gains `replay?: true` (`app/shared/protocol.ts`), set ONLY on
  attach-time history frames, never on live events. Additive under `PROTOCOL_VERSION = 1`
  (the `ReadyFrame.engineSessionId` precedent); the renderer may ignore it (rows render
  identically — test-proven) or use it for a "restored" divider / notification suppression
  (P3-5's call).
- **Order:** per attaching connection, after `ready` + the C3 `permission.context` snapshot,
  before any live event — single-socket ordering, no sequencing machinery
  (`sidecarServer.ts` `sendHistoryReplay`).
- **Cap + truncation:** the NEWEST contiguous tail is kept under BOTH
  `MAX_HISTORY_REPLAY_FRAMES` (400) and `MAX_HISTORY_REPLAY_BYTES` (4 MiB)
  (`app/shared/limits.ts`); stop-not-skip, so never a mid-history hole. Any omission emits
  the boundary error frame `requestId: 'catcode.history-truncated'`
  (`HISTORY_REPLAY_TRUNCATION_REQUEST_ID`, protocol.ts) BEFORE the tail — the exact
  `replayBuffer.ts` truncation idiom, so a capped replay is visibly lossy, never silent.
- **Reload alignment (operator-held seam):** both caps sit STRICTLY below main's per-session
  replay-buffer budgets (512 frames / 8 MiB, `app/main/replayBuffer.ts`), with headroom for
  ready/C3/early live frames, so a renderer reload replays the SAME history from main's
  buffer. Enforced by `app/main/historyReplayReload.test.ts` (invariant + an at-cap
  functional pass through the real `AttachmentGate` + `FrameReplayBuffer`); byte accounting
  matches the buffer's (serialized UTF-8 JSON of the whole frame).
- **Deliberate asymmetry:** the ENGINE seed (F1) is always the full resumed transcript
  (TUI-`--resume` parity); only the display replay is capped.

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
- Engine-side resume normalization is transmitted faithfully: e.g. recovery replaces an
  incomplete trailing assistant with its API-validity sentinel
  (`conversationRecovery.ts:243`) — the replay shows what the engine RESUMED, not a re-read
  of the JSONL (that fidelity is the point of the same-source rule).

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

## Tests (all in `bun test app/`)

`app/sidecar/historyReplay.test.ts` (order/flag/caps/truncation) ·
`app/main/historyReplayReload.test.ts` (cap alignment + reload preservation) ·
`app/renderer/src/restoredHistoryRender.test.ts` (renders as normal rows; flag invisible) ·
`app/sidecar/spawnConfig.probe.test.ts` (b) (REAL resumed sidecar replays the minted
transcript over the wire) · `app/sidecar/resumeSeed.probe.test.ts` (same-source with the F1
engine seed).
