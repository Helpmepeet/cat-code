# RAM-0 confirmation — catalog owner #4 (2026-07-22)

Discharges the "RAM-0 confirmation" gate on ratified decision #4 (catalog owner,
shape (b) — main-supervised one-shot worker), merged to `migration` as
`4aed914`. Confirms the RAM win is REAL, not just mechanistically-in-place.
Uses the same committed hermetic instrument as the 2026-07-21 baseline
(`app/scripts/ram-{corpus-gen,probe,measure}.ts`), so the A/B is same-instrument.

## Method

Reduced-but-conclusive re-run of the RAM-0 recipe against the **merged #4
sidecar** (`app/sidecar/index.ts` at tip `4aed914`): `--reps 2 --dwell-ms 45000
--sample-ms 22500`, corpora 50/600/empty (seed 42, min 160 KB/session). The
effect being tested is large (~154 MB) vs the run's noise (~±1 MB), so 2 reps
suffice for a confirmation (the 3-rep decision-grade baseline already exists).
Raw aggregate: `ram0-raw/2026-07-22-4-confirm-aggregate.json`. All runs
`validReps=2/2`, `allKillVerified=true`, no survivors.

## Result — the per-sidecar catalog plateau is ELIMINATED

Attached-idle sidecar, median RSS / footprint (MB):

| condition | boot RSS | plateau RSS | plateau footprint |
|---|---:|---:|---:|
| bootfloor (no attach) | 229.8 | — | — |
| enrich50 (50-session) | 232.8 | **233.4** | 190.5 |
| enrich600 (600-session) | 228.6 | **229.1** | 188.5 |
| mimalloc0 (600, PURGE=0) | 230.4 | 230.9 | 189.8 |

**enrich600 − enrich50 plateau (this run, #4): −4.3 MB RSS / −2.0 MB footprint ≈ 0.**
**Prior RAM-0 (same instrument, pre-#4): +163 MB RSS / +154 MB footprint.**

With #4 the attached sidecar sits at the boot floor (~230 RSS / ~190 fp)
**regardless of corpus size** — it no longer enumerates the catalog (the
on-attach enum + 30 s refresh + broadcast were removed). The ~154-163 MB
per-attached-sidecar catalog plateau is gone. Fleet saving ≈ **N × ~154 MB** for
N live sessions, minus one transient worker run (below).

## The owner's cost (what the plateau was traded for)

One catalog-worker run against the 600-session corpus (`CLAUDE_CONFIG_DIR` =
corpus, `--bare`): **~0.7-0.9 s wall** (0.88/0.67/0.66 s across 3 runs), **peak
RSS ~307 MB** (322 MB max-RSS: ~230 engine-graph base + ~77 catalog data),
**1 snapshot emitted, all 600 entries enumerated**, exit 0. The cost is
TRANSIENT (the worker exits; ~0 resident between runs), paid once per interval by
ONE process — versus the old ~154 MB RESIDENT paid by EVERY attached sidecar,
always. Net win holds even at N=1 (transient spike vs permanent resident).

## A2 (GUI finding) explained + fix lever

The operator's GUI A2 (external session took ~51 s > 30 s target) is **NOT**
enumeration cost — a run is ~0.9 s even for 600 sessions. It is dominated by the
**30 s poll interval** (driver reschedules 30 s after each run completes) plus
phase alignment (a session born just after a tick waits ~a full interval) and the
terminal-side transcript-flush delay. Fix lever = the interval length
(`sessionsCatalogRunner.ts` default 30_000 ms); shortening it directly cuts the
worst-case appear-latency. **Tradeoff:** the per-run cost is the ~189 MB
engine-graph *spawn* (not the ~0.9 s enumerate), so a shorter interval multiplies
spawn/CPU churn — a deliberate tuning choice, not a free win. Low priority (A2 is
latency, not correctness; the session did appear).

## Caveats

SCRATCH-class (2 reps, synthetic warm-cache corpus), sufficient for a
confirmation given the effect size; not a fresh 3-rep baseline. The worker run
was warm-cache — the operator's real cold-disk store may run marginally slower
but still seconds, not tens of seconds. Feature manifest = ∅ (all gates off),
same as the baseline (ruling #1 predecessor unchanged).
