# Delivery-trace retention: what the current caps actually buy

Measured 2026-08-10 against the live desktop log directory
(`~/.cat-code/desktop/logs`), 6 retained `delivery-trace-*.jsonl` files,
**103.2 MB / 155,672 records** — the retention budget essentially full. Only
aggregates were read; no record content left the analysis.

This is the evidence for an **owner decision**. Nothing in this run changed
retention behavior.

## 1. The measurement

| Quantity | Measured |
|---|---|
| Bytes per record (all kinds) | **663 B** |
| Bytes per `delivery.trace` record | **679 B** |
| Stage records per frame | **~12** (11.99 / 12.75 / 12.94 / 12.97 across full files) |
| Cost per frame | **~8.1 KB** |
| Frames the 100 MB budget holds | **~12,300** |
| Burn rate, heavy use | **9.85 MB/min** (87.3 MB written in 8.9 min, one launch) |
| Burn rate, light use | **0.04 MB/min** (15.9 MB over 429 min, current launch) |

So `MAX_DELIVERY_TRACE_TOTAL_BYTES` buys **about 10 minutes of history under
load** and tens of hours when idle. Retention is bimodal, and the mode that
matters is the one that lasts ten minutes: an incident is exactly when the app
is busy. A 20 MB file (`MAX_DELIVERY_TRACE_FILE_BYTES`) fills in **1.4–3.0
minutes** under load.

The overnight hang was diagnosed hours after it began. Under these caps, the
traces covering its onset were rotated away before anyone looked, which is what
`docs/reports/2026-08-10-overnight-hang-log-request.md` reported.

## 2. Where the bytes go

- **42.0%** of `delivery.trace` records are the five intermediate stages:
  `sidecar.received`, `sidecar.socket.queued`, `main.ipc.queued`,
  `renderer.state.queued`, `renderer.subscription.received`. The last of these
  is redundant for continuity on its own — `contiguousEither` already treats it
  as equivalent to `preload.received` — and is **8.7%** of records by itself.
- **`trace.loss` is 10,467 records (~4.8 MB, 4.7% of the budget)**, every one of
  them `in_memory_eviction`: the 2,048-sequence in-memory ring evicting a
  sequence. Each record says only that one sequence was evicted.
- **`renderer.ui.committed` appears ZERO times** in 144,345 records. It is not
  missing evidence: `App.tsx` sends it only for the ACTIVE session and only once
  that session's projection is terminal. Any consumer treating its absence as a
  lost frame is wrong by construction (fixed for the stall verdict in `bb7d5964`).
- CC-48's `messageKind` tag adds a projected **+3.1%** (25 B on each of 122,772
  event-frame records). Real, and small: it is not what makes retention short.

## 3. What the candidates buy

| Option | Retention under load | Cost |
|---|---|---|
| Today | ~10 min | baseline |
| Drop `renderer.subscription.received` | ~11 min | loses nothing (redundant with `preload.received`) |
| Drop all 5 intermediate stages | ~17 min | loses queue-vs-send attribution inside a process |
| Sample full stages 1-in-20, keep 2 stages on every frame | **~46 min** | per-frame continuity kept; per-frame stage detail becomes a sample |
| Raise the budget to 500 MB | ~50 min | 5× disk on the operator's machine, linear |
| Per-minute rollup lane | **72 h** (the age cap) | ~700 B/stream/min ≈ 3 MB for three days |

## 4. Recommendation

**Add a rollup lane; sample the raw stage detail; do not simply raise the cap.**

1. **Per-minute rollup records, retained on their own budget.** One record per
   stream per minute carrying the watermarks, the anomaly counts, and the last
   `messageKind`. At ~3 MB for the full 72-hour age cap this is ~0.003% of the
   current spend, and it is what an investigation reads FIRST — "at 03:14 this
   stream had produced 812 and delivered 812, last message `assistant`" answers
   the overnight question outright. Rotation currently destroys precisely this
   and keeps the per-frame detail nobody reads at hour three.
2. **Sample full-stage tracing.** Keep two stages on every frame
   (`engine.produced` and `supervisor.socket.received` — the continuity pair
   that carried the whole 2026-08-10 verdict), and the full twelve on 1-in-20.
   Continuity detection is unchanged because it is judged at arrival; what
   becomes a sample is the per-frame hop timing, which is the part that was
   never read.
3. **Raising the cap is the weakest option on its own.** It is linear: 5× the
   disk buys 50 minutes, still less than the gap between an overnight hang and
   the morning that finds it. Worth doing only alongside (1).

One caveat against (2): sampling makes `trace.sequence.duplicate` and
`trace.sequence.out_of_order` blind on unsampled frames. Both are stage-scoped
anomalies about diagnostic plumbing rather than about frames, so the loss is
bounded — but it is a real reduction, not free.

`trace.loss`'s 10,467 identical `in_memory_eviction` records should be coalesced
whichever option is chosen. A run of consecutive evictions is one fact.
