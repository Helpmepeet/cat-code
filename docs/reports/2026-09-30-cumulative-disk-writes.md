# Cat Code cumulative disk writes

Measured 2026-09-30 with Bun 1.4.0 on macOS, isolated synthetic state. This
establishes reproducible amplification, **not** a comparable real-world SSD
endurance incident. The [motivating Codex issue](https://github.com/openai/codex/issues/28224)
reported churn despite bounded retention; its rates are not Cat Code measurements.

## Reproduce and accounting boundaries

```sh
bun scripts/measure-disk-writes.ts --assert
bun scripts/measure-disk-writes.ts --normal --assert
bun test src/utils/statsReader.test.ts src/utils/statsUsageIndex.test.ts app/main/deliveryTraceSink.test.ts
```

The probe wraps actual filesystem writes, source FileHandle reads, and SQLite
statement results. It does not add per-record persistence or enable logging.
It captures JSONL bytes **at append**, including anything subsequently rotated
or deleted, rather than using retained-directory size. SQLite measurements count
changed rows and capture the WAL before the writer closes/checkpoints it away.
The WAL frame count is `(walBytes - 32) / (4096 + 24)` here. These transactions
do not cycle/reuse the WAL between commits, so its serialized size represents
that transaction's WAL traffic. Database and SHM sizes are retained sizes, **not
cumulative device writes**. Database checkpoint writes and filesystem/device
amplification are additional and not measured. No OS write-accounting dependency.

Fixtures: seven delivery stages, one active stream, ten simulated minutes at
20 frames/s (heavy) or 2 frames/s (lower rate); 50,000 distinct assistant records
in a 60,577,780-byte JSONL, then three one-record/1,212-byte appends; 6,000 small
MCP debug messages; 100 main-start/sidecar-complete turn pairs. Simulated rate
equivalents are workload extrapolations, not measured user activity. Clock and
generated identifier serialization can cause small JSONL-byte variation.

Raw results: [before](2026-09-30-disk-write-measurements/before.json),
[after](2026-09-30-disk-write-measurements/after.json),
[lower rate](2026-09-30-disk-write-measurements/normal.json).
Before uses the unchanged owners from Git HEAD with the same probe; new regression
tests were also run against those owners and failed for the intended reasons.

## Hypotheses, measured facts, and decisions

| Static-audit hypothesis | Measured fact | Conclusion / change |
| --- | --- | --- |
| Delivery ring eviction can persist routine loss traffic | 9,952 loss records / 3,630,266 bytes for 12,000 fully delivered frames | Confirmed; publish exact loss ranges/counts at rollup cadence and shutdown |
| Small transcript appends rebuild the source index | First append deletes 50,000 rows, inserts 50,001, reads 60,578,992 source bytes | Confirmed on the production index owner; retain validated prefix rows and project/insert only the new region |
| SQLite write amplification comes only from source replacement | 100,002 scratch identity writes accompany the first append | Audit incomplete; remove scratch identity traffic from the durable WAL too |
| MCP debug persistence bypasses debug mode | All 6,000 controlled debug messages reach the real JSONL sink with normal debug disabled | Confirmed; 982,890 bytes, largest record 164 bytes; leave unchanged for this workload |
| Sidecar operational records bypass local dedupe | Real `writeRecord` path persists each controlled completion | Correct call-path distinction, but this lifecycle fixture writes only 65,808 bytes before / 65,841 after; leave unchanged |

Production chain checked: main runs the `usage-stats` worker on the five-minute
refresh; `usageStatsWorker` → `collectUsageDashboard` → `aggregateUsageDashboard`
→ `collectIndexedUsage`. Measurements invoke that same real owner with isolated
files, not a replacement index algorithm. The existing process probe exercises
the actual worker/runner with broken isolated account storage and verifies its
saved result. Delivery stages drive the real sink; MCP calls the real logging
API and sink while capturing its filesystem boundary so no user's cache is touched.

## Before / after

| Heavy fixture metric | Before | After |
| --- | ---: | ---: |
| Frames / terminal trace records | 12,000 / 12,000 | 12,000 / 12,000 |
| Routine trace bytes | 8,706,198 | 8,707,046 |
| Rollup records / bytes | 10 / 5,402 | 10 / 5,402 |
| Ring-loss records / bytes | 9,952 / 3,630,266 | 9 / 3,306 |
| Other anomaly records | 0 | 0 |
| Total diagnostic bytes/frame | 1,028.49 | 726.31 |
| Delivery MB/hour equivalent | 74.05 | 52.29 |
| First append source bytes read | 60,578,992 | 60,578,992 |
| First append records deleted / inserted | 50,000 / 50,001 | 0 / 1 |
| First append durable identity writes | 100,002 | 0 |
| First append serialized WAL bytes | 44,388,912 | 74,192 |
| First append WAL frames | 10,774 | 18 |
| First append elapsed milliseconds | 2,110 | 1,786 |
| DB retained size after append | 44,167,168 | 26,447,872 |
| SHM retained size during append | 98,304 | 32,768 |

Second and third appends also insert one row, delete none, write no durable
identities, and serialize 74,192 WAL bytes each. Three-append cumulative WAL:
133,166,736 → 222,576 bytes, approximately **99.83% less**. Cold build WAL falls
44,384,792 → 26,561,672 bytes. Warm unchanged sources remain unread.

Lower-rate delivery produces 1,200 terminal records / 868,551 bytes, ten rollups /
5,125 bytes, no losses or anomalies, 728.06 bytes/frame, 5.24 MB/hour equivalent.
MCP's controlled 10-message/s fixture extrapolates to 5.90 MB/hour; operational
turn lifecycle at ten turns/minute to about 0.40 MB/hour.

The transcript fixture writes 60,577,780 bytes initially and 3,636 new bytes over
three appends. These are necessary input writes made by the fixture, not Analytics
rewrites. Neither index collection nor diagnostic probes write a transcript cache.
Transcript writers/caches, general debug logging, attachments, settings, migrations,
and other application persistence are outside the exercised workload; their absence
from this probe is **not** evidence of zero production writes.

## Implementation and safety

Index continuation stores only byte offset, existing source generation, and SHA-256
digest in additive derived-source quality metadata. It leaves the SQLite schema,
privacy projection, record identities, and published snapshot format unchanged.
Older sources without checkpoint metadata rebuild once when changed. Continuation
requires the same generation, growth, a newline boundary, and an exact matching
prefix digest on the open source descriptor. Prefix edits plus growth, truncation,
replacement, missing/incompatible checkpoints, incomplete final records, changing
reads, and corruption cannot silently retain a stale prefix.

**The source prefix is still read to validate its digest.** Only JSON parsing,
projection, and durable row updates are incremental. A file stat or a sampled
prefix would not prove that historical data was unchanged. Aggregation still
reads projected history and reconstructs cross-record identity accounting, so
this change does not promise constant-time collection. Tail-only source IO would
need a trustworthy producer mutation/generation contract, a separate design change.

Identity accounting now uses a SQLite memory store capped at 64 MiB of database
pages. On exhaustion it copies to private temporary SQLite scratch, preserving the
previous 1-GiB storage ceiling. Scratch has no WAL or durability requirement and is
removed at normal exit, including failures. Existing writer locking, transactional
index/snapshot publication, deadline checks, and damaged-index repair remain intact.
No raw prompt, response, tool input, or result content is added to the projection.

Delivery preserves all terminal-frame detail, incomplete-frame evidence, anomalies,
rollups, and exact eviction loss totals. Routine ring-loss serialization is bounded
by rollup cadence instead of frames. An abrupt process death can lose the pending
minute's range detail; rollups continue carrying cumulative loss counters. This is
intentional batching of bounded diagnostic state, not lost conversation data.

## Verification and limitations

- 64 focused engine tests passed, including continuation, prefix rewrite, truncation,
  replacement, partial-tail completion, rollback/recovery, lock exclusion, corruption
  repair, privacy projection, and forced scratch-memory exhaustion/spill.
- The delivery byte/count regression and the append row-mutation regression fail
  on the original owners. The reader continuation contract also fails there.
- `--assert` passes for both rates, guarding one inserted/zero deleted rows per
  append, zero durable identity writes, WAL below 1 MiB per append, and at most
  ten/8 KiB ring-loss records/bytes for the heavy fixture. Budgets are operation/byte
  based; elapsed times are descriptive only.
- Dev full build, workspace-map lint, and `git diff --check` passed. The 61 focused
  desktop tests (delivery sink, diagnostics export, usage runner, real worker probe)
  passed. The actual worker cold/saved probe passed in the broad run too.
- Full `bun test app/` with local socket access: 5,168 pass, one skip, 11 fail,
  one error. Failures concern project relocation/routing, stale history-replay
  expectations (an additional `history.replay.complete` frame), renderer source/text
  expectations, and an archived `tmp/.../app/...` test missing a module. These are
  outside the changed paths; the broad suite is **not green**. The blocked-socket
  sandbox run was interrupted after rerunning with socket access.
- Desktop/sidecar typechecks are **not green**: project-routing policy test typing
  and the desktop configuration's broad engine-import diagnostics. Root typechecking
  still reports the existing legacy snapshot-test `unknown` property errors in
  `statsUsageIndex.test.ts`; no diagnostics remain in the changed production owners
  or measurement script. Unrelated source/test work was not repaired.

## Required closing assessment

**What the static audit got right/wrong:** Correct about source replacement,
routine eviction traffic, MCP debug persistence, and the sidecar dedupe distinction.
It missed durable scratch identity writes; the historical 9.85 MB/min delivery
measurement does not describe this implementation.

**What was measured:** Actual persistence boundaries under isolated, reproducible
synthetic traffic; source read bytes, SQLite changed rows/WAL, trace/rollup/loss
bytes and records, MCP debug bytes, and operational lifecycle bytes.

**Actual write-heavy paths:** Before the fix, Analytics rewrites dominate this
large-transcript fixture. Sustained successful delivery detail remains the largest
continuous diagnostic writer in the tested traffic. This is not a machine-wide
or real-world ranking.

**What was changed:** Validated incremental projection/insertion, nondurable identity
scratch with bounded memory and disk spill, and cadence-batched ring-loss records.

**Before:** 44.39 MB WAL per one-record append; 74.05 MB/hour heavy delivery equivalent.

**After:** 74.19 KB WAL per append; 52.29 MB/hour heavy delivery equivalent.

**What was intentionally left unchanged:** Successful per-frame detail, anomaly
fidelity, retention budgets, MCP persistence, operational logging, transcript/cache
writers, and the snapshot aggregator.

**Remaining risks:** Prefix verification and aggregation remain linear reads/work;
large histories can spill scratch writes; SQLite memory pages add up to 64 MiB
plus allocation overhead; killed workers can leave private scratch files in OS
temporary storage; delivery detail remains proportional to successful frames;
MCP rates/record sizes can exceed this small-message fixture; device writes and
live user workloads were not measured. There is no new total diagnostic write cap.

**Regression guard:** Owner-level rollback/fallback/storage tests plus the reproducible
`measure-disk-writes.ts --assert` row and byte budgets.
