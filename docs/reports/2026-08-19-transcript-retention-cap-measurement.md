# What the transcript retention caps actually buy

Measured 2026-08-19 against this machine's live stores. Only aggregates were
read; no transcript content left the analysis.

This is evidence for the message-visibility fixes. Nothing in this run changed
retention behavior.

## 1. Corpora

| Corpus | What it is | Size |
|---|---|---|
| `~/.cat-code/projects/**/*.jsonl` | engine transcripts, uncensored ground truth | **1,849 sessions** |
| `~/.cat-code/desktop/transcript-cache` | distilled desktop caches (message frames only) | 118 sessions / 283,509 frames |
| `~/.cat-code/desktop/logs/delivery-trace-*` | real wire frames | 132,042 stage records |

The original sizing in `app/shared/limits.ts:155-166` used 142 transcripts;
`app/main/replayBuffer.ts:58-66` used **six**. This is 1,849 and 118.

## 2. Engine transcripts: the message-count caps never fire

| Quantity | p50 | p90 | p99 | max |
|---|---|---|---|---|
| Records/session | 82 | 332 | 1,075 | **2,988** |
| Bytes/session | 326 KiB | 1.34 MiB | 4.32 MiB | **18.1 MiB** |

| Cap | Sessions exceeding |
|---|---|
| 4,000 records (`MAX_HISTORY_REPLAY_FRAMES`) | **0 / 1,849 (0.0%)** |
| 8,000 records (`DEFAULT_MAX_BUFFERED_FRAMES`) | **0 / 1,849 (0.0%)** |
| 4 MiB (`MAX_HISTORY_REPLAY_BYTES`) | 19 / 1,849 (1.0%) |
| 8 MiB (`DEFAULT_MAX_BUFFERED_BYTES`) | 7 / 1,849 (0.4%) |

**No real engine transcript comes within 25% of either count cap.** The design
intent recorded in both files — raise the count until the byte budget is what
binds — is confirmed at scale. The counts are backstops, not policy.

Truncation is therefore **rare but real**: about 1% of sessions, and they are
the long ones a user is most likely to care about losing.

## 3. Desktop ring: the two caps bind at the same point

The desktop replay ring accumulates across an app session, not per engine
transcript, so it fills far more often than §2 suggests.

| Quantity | Measured |
|---|---|
| Message frames/session | p50 351 · p90 7,993 · **max 8,000** |
| Bytes/session | p50 1.80 MiB · **max 7.11 MiB** |
| Bytes/message frame | p50 724 B · p90 822 B · mean **1,083 B** |
| Sessions at/near the 8,000-frame cap | **36 / 118 (31%)** |

`max = 8,000` is exactly `DEFAULT_MAX_BUFFERED_FRAMES`, so this corpus is
censored at the cap: these sessions were truncated before they were cached.

At the measured mean frame size, 8 MiB holds ~7,745 frames. The 8,000-frame
cap and the 8 MiB byte cap therefore **bind at essentially the same point**.
Neither is mis-sized relative to the other, and the worst observed session sat
at 7.11 MiB against 8 MiB with its count exactly at the cap.

**Verdict: the cap VALUES are sound.** No change recommended to any of
`DEFAULT_MAX_BUFFERED_FRAMES`, `DEFAULT_MAX_BUFFERED_BYTES`,
`MAX_HISTORY_REPLAY_FRAMES`, or `MAX_HISTORY_REPLAY_BYTES`.

## 4. Frame mix on the wire

`event` frames are **93.1%** of all delivered frames (122,896 / 132,042); the
rest are once-per-attach snapshots that live in the buffer's `sticky` tier,
outside the ring budget. The ring is, in practice, pure transcript traffic.

Caveat: the trace records `frameKind`, which does not separate a finished
message from a `stream_event` delta. The cache evidence bounds it indirectly —
sessions distilled to exactly 8,000 *message* frames from an 8,000-frame ring
had essentially no deltas occupying ring slots, and those sessions ran the
Codex path. Delta inflation is therefore likely **provider-dependent** and was
not isolated here.

## 5. What this changes about the fix

1. **The boundary notice can never quote a constant.** The count that survives
   is set by bytes and varies per session: in simulation, over-budget sessions
   retained 52-67% of their messages under a 4 MiB tail. The notice must report
   the count that actually survived, or no count at all.
2. **`limits.ts:161` overstates per-message size** (recorded p50 1.9 KB / p90
   3.7 KB; measured here p50 724 B / p90 822 B on distilled frames). The
   conclusion it supports still holds, so this is a comment accuracy issue, not
   a sizing error.
3. **The caps stay as they are.** The defect is reporting, not retention.

## 6. Uncertainty

- Delta inflation per provider is unresolved (§4). It would take a trace that
  records the event subtype, which today's schema does not carry.
- The two corpora count different units (JSONL records vs projected message
  frames; mean 4,165 B vs 1,083 B each), so they are not directly comparable
  and are reported separately rather than combined.
