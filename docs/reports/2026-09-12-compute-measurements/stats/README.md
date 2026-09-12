# Stats paired-range benchmark

Preparation, smoke checks and six paired timed samples at each of three corpus sizes were completed on 2026-09-12. Raw results from that run are saved in `results.json`. Timed samples were serialized with the logging benchmark.

To reproduce from the repository in a fresh temporary directory, keep `prepare.ts` and `run.ts` together and run:

    bun run docs/reports/2026-09-12-compute-measurements/stats/prepare.ts /Users/pt/cat-code

It prints the prepared directory. Run `bun run <that-directory>/run.ts --smoke` for output parity only or omit `--smoke` for timed samples. Each invocation creates a fresh isolated config directory, so prior corpus stages cannot contaminate reruns.

The result is written incrementally to `results.json` in that temporary directory. Stdout contains each stage's summary. The saved original manifest contains that run's temporary paths for provenance; reproduction generates a new manifest. Remove only the directory printed by preparation after preserving its results; it contains synthetic data and symlinks to shared dependencies.

## Method

- Both stats modules are byte-exact git blobs: before `d9f5eef5dad750ceffe411e6913692e8789bc9ca`, after `d58b9f10f7fb6d31a033045bc7321bbccccaf885`. SHA-256 hashes are checked before execution. Relative dependencies are symlinks to the same checkout files and load in the same Bun process.
- Before invokes the original concurrent `Promise.all([aggregateClaudeCodeStatsForRange('7d'), aggregateClaudeCodeStatsForRange('30d')])`; after invokes `aggregateClaudeCodeStatsForRanges(['7d', '30d'])`.
- A deterministic synthetic corpus grows from 128 to 384 to 768 main sessions, plus one subagent transcript per four main sessions. Each transcript contains 96 generated assistant records with repeated response IDs, usage counts, and fixed-size body text. The corpus mixes recent overlap, month-only history, old untouched history, and old sessions with recent modification times.
- The config directory and home are isolated. Credentials are removed from the child environment; network requests throw without issuing a request. No real transcript directories are read.
- Each stage first compares complete before/after results. Calibration chooses the same 2–16 aggregations per sample to target at least 750 ms per baseline sample. Calibration is recorded separately. Both variants then receive two warmup passes.
- Six paired samples per stage alternate before/after and after/before order. `performance.now()` captures elapsed time; `process.cpuUsage()` captures process user/system CPU time. Raw samples and calibration are retained. All individual aggregation outputs are checked for exact structural equality outside the timed interval; an output digest is recorded.
- Corpus creation, imports, validation, and console/file reporting are excluded from timing. No explicit garbage collection is forced. Fail the run if its date changes, since production range boundaries use the current date.

## Limits

These are warmed-file-cache synthetic history measurements, not cold-disk, battery, power, live-account, GUI, startup, or end-to-end app measurements. Shared dependencies come from the current checkout, not two full historical checkouts. Both versions receive exactly those same dependency instances. Background system activity and normal garbage collection can influence measurements; alternating order and repeated samples reduce, but cannot eliminate, that noise. The fixed age distribution and record sizes do not represent every personal history. Smaller files can have different header-filter behavior. No claim about provider inference cost follows from this benchmark.
