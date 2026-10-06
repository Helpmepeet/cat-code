# Desktop performance measurements

Saved harness for the [desktop performance assessment](../2026-10-06-desktop-performance-assessment.md). It replaces the inline probes behind that report's numbers, which were not saved. Results recorded here are a fresh baseline: compare a change only against a run of this same harness at a known source revision, never against the assessment's original figures.

## Tiers

**Tier A** calls production functions with deterministic synthetic inputs from `fixtures.ts`. Each probe is bundled with esbuild and run under Node, so timings come from V8 as in the renderer and Electron main. Nothing reads user state. Trace and cache probes write only to private temporary directories and remove them.

| Probe | What it times | Not included |
|---|---|---|
| `markdown` | `planMarkdownLeaves` with the transcript plugins and the options `BoundedMarkdown` passes: append shapes after a 33,600-character prefix, settled and open code blocks, a whole reply streamed from empty, and the cold plan on tab return. Each update is classified as plain append, settled body reused, or full transform. | React reconciliation, layout, paint. |
| `raw-replay` | One replayed history burst folded through `withBatch(reduceServerFrame)`, fresh and duplicate. | Transcript projection, React, IPC. |
| `tracing` | The production delivery trace sink. Scenario 1 reproduces the assessment (frames buffered before first readiness, then replayed). Scenario 2 models a reload after live delivery: partials on the live stream, a compacted replay of finished messages, then the renderer's acknowledgements. | IPC transfer, renderer work, the deduplicated operational warning. |
| `cache` | `readCache`, and the persistence step main runs at park, close, restart and quit (read existing, carry previews, atomic write with fsync), including a four-session quit. | Engine transcript run-facts read, cold disk. |

`tracing` and `cache` mirror `traceFrame`, the acknowledgement handler and `persistTranscriptCache`, which are private to `app/main/main.ts`. Re-check those mirrors against main.ts when the source revision changes.

**Tier B** (`probes/real-data.ts`) reads the operator's own `~/.cat-code/desktop` logs and transcript caches, read-only, and records aggregates only: event counts, sizes, distributions, timings. It never calls `readCache`, which deletes files it rejects. Real finished replies are streamed through the planner with synthetic piece boundaries, because provider deltas are not stored on disk. Run it only with the operator's approval.

## Running

From the repository root, choosing a new output directory each time:

```sh
# Functional smoke; timings are not evidence.
bun docs/reports/2026-10-06-performance-measurements/run.ts --smoke --out /tmp/catcode-perf-smoke

# Full tier A: five scored repetitions after one discarded warm-up (heavy cases cap at three).
bun docs/reports/2026-10-06-performance-measurements/run.ts --out /tmp/catcode-perf-tier-a

# One probe.
bun docs/reports/2026-10-06-performance-measurements/run.ts --probe tracing --out /tmp/catcode-perf-tracing

# Tier B, read-only on real state. Requires the operator's approval.
bun docs/reports/2026-10-06-performance-measurements/run.ts --probe real-data --out /tmp/catcode-perf-real
```

## Baseline, 2026-10-06

Both runs measured source revision `bc5e4602dfda8f656031af117b5e1c388c9e77a4`; every measured desktop source matched that revision's blobs. No desktop source changed since the assessment's `41ec7f5d`. Node v24.3.0, Apple M4 Pro, 12 logical CPUs. Other sessions kept the machine busy: the load average was 6 to 9 at the start of each run. Treat absolute times as noisy; the raw samples are in `results-tier-a/` and `results-tier-b/`.

### Real workload (tier B)

The operational logs cover 2026-10-01 10:34 to 2026-10-06 03:49 UTC (about 4.7 days). Delivery traces cover only the last 13 hours, because the trace lane wrote 92 MB in that time against its 100 MB budget.

| Signal | Value |
|---|---|
| Turns started | 169 |
| App starts / windows created / renderer navigations | 12 / 17 / 20 |
| Renderer process exits | 2, both `clean-exit` |
| Session restores | 15; messages per restore p50 11, p90 153, max 190 |
| Transcript caches | 352 files; messages per cache p50 134, p90 676, p99 1,417, max 2,201 |
| Caches holding generated-image previews | 1 of 352 |
| Cache read + `JSON.parse` (no guard scan) | p50 2.0 ms, p90 9.1 ms, p99 16.8 ms, max 67.0 ms |
| Assistant text blocks | 2,582; characters p50 320, p90 1,630, p99 12,634; 217 at 2,000 or more, 30 at 10,000 or more |
| Streamed partials per finished trace record | 7.2 (all kinds); each stream's last 2,048 sequences held only 136 to 200 finished messages (3 streams) |

Twenty real replies of 2,000 characters or more, streamed through the planner with synthetic piece boundaries:

| Pieces | Updates | Full transforms | Per update p50 / p90 / p99 / max | Updates over 16.7 ms |
|---|---:|---:|---|---:|
| 1 word | 19,886 | 74% | 1.0 / 10.6 / 18.5 / 34.8 ms | 486 |
| 4 words | 4,980 | 79% | 1.1 / 11.6 / 18.7 / 23.5 ms | 187 |

### Synthetic cases (tier A, medians)

| Case | Result |
|---|---|
| Append after 33,600-character prefix | Plain word 0.65 ms; space-ending, multi-sentence, soft break and Thai 13.0 to 13.6 ms, none reused |
| Settled code block then formatted append | 15,500: 2.3 ms; 16,500: 5.8 ms; 32,000: 11.5 ms; 64,000: 24.3 ms |
| Open fence append | 16,000: 1.3 ms; 64,000: 3.3 ms; 128,000: 5.8 ms; 256,000: 11.0 ms |
| 12,000-character synthetic reply streamed whole | 1-word pieces: 1,201 ms total over 1,646 updates, 49% full transforms, none over 3.8 ms; 4-word: 334 ms over 412 |
| Tab return, 28,822 characters | Cold plan 6.5 ms; with a primed cache 5.4 ms, because the planner parses before it compares settled bodies |
| Fresh replay, 300 / 1,300-character messages | 500: 1.9 / 2.2 ms; 2,000: 17.2 / 21.6 ms; 4,000: 59 / 80 ms; 8,000: 258 / 282 ms (the 1,300-character run retains 5,484 under the byte cap) |
| Cache read, 1,300-character messages | 500: 1.5 ms; 1,000: 2.7 ms; 3,000: 8.0 ms |
| Cache persist (read + fsync write) | 500: 6.2 ms (read 1.5); 3,000: 22.6 ms (read 8.2); quit of 4 × 1,000: 37.6 ms (read 11.7) |
| Buffered initial replay, three passes | 2,048: 14.0 ms; 3,000: 116 ms; 4,000: 225 ms; 8,000: 667 ms |

Reload after live delivery, three passes plus acknowledgements:

| Finished messages | Partials each | Total | Evicted after passes | Rejected acknowledgements | Trace records written | Of which out of order |
|---:|---:|---:|---:|---:|---:|---:|
| 300 | 0 | 14 ms | 0 | 0 | 2,094 | 1,794 |
| 1,000 | 0 | 46 ms | 0 | 0 | 6,994 | 5,994 |
| 3,000 | 0 | 221 ms | 952 | 3,808 | 22,898 | 14,186 |
| 100 | 19 | 4.6 ms | 0 | 0 | 694 | 594 |
| 300 | 19 | 29 ms | 197 | 788 | 2,488 | 1,006 |
| 1,000 | 19 | 115 ms | 897 | 3,588 | 8,788 | 2,406 |
| 3,000 | 19 | 364 ms | 2,897 | 11,588 | 26,788 | 6,406 |

Live tracing cost 0.023 to 0.045 ms per frame.

### What the baseline changes

- **Markdown remains first.** With real long replies, three quarters of updates transform the whole document, and the p90 update costs about 11 ms. Only about 8% of assistant blocks are that long. The planner keeps no cache at all after a full transform of a document that cannot take the plain-paragraph path, so the next update starts cold as well.
- **Tab-return reuse needs a different design.** A plan cache that survives remount saves about 1 ms of 6.5 ms, because `planMarkdownLeaves` parses the whole source before comparing it with the cached body. Reuse would have to key on the source and skip the parse.
- **Raw replay drops.** Real restores in this window were 11 messages at the median and 190 at most, where the duplicate check costs well under 2 ms. It matters only for the rare large restore.
- **Reload tracing rises.** Each real stream's trace window held only 136 to 200 finished messages, about the size of the median cache (134), so roughly half of sessions evict and re-add on reload. The cost begins well below 2,048 messages: 29 ms at 300 and 115 ms at 1,000 in the model, per session. Every replayed frame that is still retained also writes six `trace.sequence.out_of_order` records (two IPC passes and four acknowledgements), which is diagnostic noise as well as I/O. Reloads are rare: three more navigations than windows created, and two renderer exits, in 4.7 days.
- **The persistence read is almost always wasted.** 351 of 352 caches had no preview to carry. The fsync write, not the read, dominates small persists.

Still unmeasured: key-press scope and every native interaction latency (tier C, in Cat Code Dev), real provider delta boundaries and rates, cold disk reads, and launch time.

## Run rules

The runner refuses to overwrite an output directory, records the environment, source revision and SHA-256 of every production source and harness file, keeps every raw sample, and rejects the run if any of those files change while it runs. It cannot detect unrelated CPU load; `environment.json` records the load average before and each probe file after. Run while builds and tests are idle.
