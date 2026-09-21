# Desktop retained-history usage

The desktop overview uses one read-only, independent usage worker and a versioned
host event. It adds no inbound engine operation. Existing account limits and
operations are unchanged. Legacy terminal stats remain separate; their cache is
never used for the new metric version.

Scope is retained discovered project transcripts, not lifetime account usage.
Files are scanned sequentially from byte zero through an open-handle size captured
for each file. This is not an atomic filesystem snapshot. Both windows share one
UTC cutoff captured before discovery. Future/invalid records do not seed identity
or cumulative usage state. Pre-window valid records do seed that state.

Session identity is project-directory namespace plus recorded sessionId (filename
fallback). Copies inside that namespace share record/API/tool identities; imports
in a different project namespace count separately. Subagents add a subagent-file
identity and contribute tokens/tools, not main-session/record counts. Canonical
tool occurrence is the first encountered in sorted source-path and byte-offset
order. Replays never move it. Conflicting name/timestamp is reported; first wins.
Missing tool IDs use record UUID/block index, else file generation/offset/index.
This is recorded requests, not proven globally unique executions.

Limits: 256 KiB encoded two-range worker record, 160 UTF-8 bytes per display label,
8 named models and 10 named tools per window plus structured Unknown and Other.
Reader: 64 KiB chunks, 4 MiB records, one open transcript at a time. Discovery:
25,000 entries/sources and 16 MiB retained path text. Accumulator:
250,000 identity/category entries and 64 MiB estimated retained key/value payload;
120-second collection deadline. Limits abort with a typed error, without eviction.
These are initial enforced budgets; fixture measurements are recorded with test
results before activation. Count overflow aborts rather than rounding.

Rollout is enabled by default as of 2026-09-15. The single main-owned
`CATCODE_USAGE_DASHBOARD=0` switch is retained as an emergency rollback; when set,
Usage is Unavailable. Account workers and session frames are not authoritative
publishers for this overview. Rollback never restores old misleading totals or
changes retained transcripts. No persisted usage migration.

## Persistent index amendment, 2026-09-13

The operator's retained history exceeded the initial heap budget. Repeated full
transcript scans are superseded by `statsUsageIndex.ts`: a rebuildable SQLite
index of accounting fields, plus the last validated, grouped dashboard. Prompt
text, response text and tool inputs are excluded. Legacy stats and source
transcripts remain untouched. This derived cache needs no engine-state migration;
the index filename versions the projection and accounting implementation.

At startup main restores the saved snapshot through `usage-stats --cached` before
refreshing. The cached path skips engine bootstrap and transcript discovery. Its
result passes the same size, schema and secret checks as fresh results. The UI
keeps the saved cutoff until a successful refresh and retains values on failure.

Background refresh discovers/stat-checks sources. Matching device, inode, size,
mtime, ctime and birth time reuse the index. Changed files are reindexed from byte
zero; deleted files are removed. An append currently reindexes that changed file,
not just its tail. Unstable or incomplete reads are retried. If nothing changed,
the UTC day is unchanged, and no previously future record became eligible, totals
are reused with the new verified cutoff. Otherwise the compact indexed records
are replayed in the original sorted path/offset order, preserving cumulative
baselines, copied-file deduplication, conflicts and both windows. This is incremental
source indexing, not incremental per-record aggregate updates.

Large record/API/tool identity ledgers use SQLite, not the JavaScript heap.
Category/session summary maps retain their 64 MiB/250,000-entry guard. SQLite uses
an approximately 4 MiB page cache and a 262,144-page database cap (1 GiB with the
created database's 4 KiB pages); its temporary WAL also needs disk space. The
120-second deadline and 256 KiB outbound cap remain. No identities are evicted to
make totals fit.

An external writer lock covers refresh and corrupt-database repair; SQLite WAL
transactions publish index and snapshot together. Failure or process termination
rolls back the refresh, leaving the last committed snapshot readable. Corrupt
SQLite files are retained under a unique suffix and rebuilt under that same lock.
No account initialization, token refresh or transcript mutation is introduced.

Read-only real-history verification with the index under `/tmp`: 2,314 sources,
complete coverage, first scan approximately 12.5 seconds; unchanged refresh
approximately 109 ms. This is a local measurement, not a latency guarantee. The
fixture suite additionally exceeds the old heap budget, tests warm reads without
transcript access, future eligibility, UTC rollover, deletions, replacement,
incomplete tails, writer exclusion, rollback and corrupt-cache recovery.

### Cache-write reporting amendment (2026-09-13)

Counting version 2 adds per-day and per-range cacheWriteReporting metadata and
uses index-v2.sqlite to rebuild derived snapshots. The OpenAI adapter's normalized
zero cache-creation field is unreported, not a measured zero. Positive recorded
writes take precedence; explicit Claude counts are reported; ambiguous or mixed
coverage is partial. Empty scopes are unavailable. The renderer preserves exact
numeric accounting while labeling unreported and partial write coverage.

### Activity and tool-outcome amendment (2026-09-14)

Counting version 3 adds 24 hourly request counts per UTC day and per-tool results
and errors. Index-v3.sqlite adds only tool-result IDs and error flags to the
allowlisted projection. The strict summary validator checks hourly reconciliation,
future hours, safe counts, and errors <= results <= requests. Request/result
matching uses the canonical tool identity and same project/session/subagent scope;
first retained result wins, including when it precedes the request in file order.
Only results observed by the cutoff count, attributed to request time. Missing
or orphan results do not imply success. Error rate uses matched results as its
denominator; grouping preserves both counts. Error means recorded is_error, not
an inferred error from a result body or subprocess exit code. See the
[implementation report](../../reports/2026-09-14-usage-activity-and-errors.md).


## Session attribution and overview amendment, 2026-09-16

The operator-requested redesign adds a day-to-session table to Usage. Counting
version 4 and `index-v4.sqlite` add contributor tokens, requests, matched results,
recorded errors, and model attribution. Subagent accounting remains owned by its
main session. The index additionally projects recorded cwd; the outbound record
contains only a project hash and basename, stable contributor ID, and a UUID
session ID when reliable. No prompt, response, or tool-input text is projected.

Each day exposes up to 20 contributors ranked by tokens, with an explicit omitted
count. Envelope fallback reduces that bound to 10 or 5. Contributor model detail
retains up to four named models plus Unknown/Other. Grouping never changes total
accounting. Validators check per-bucket reconciliation and result/error bounds.
The previous derived index remains untouched and v4 rebuilds independently.

Renderer navigation requires a unique match in the existing session catalog,
using project hash when present, then uses the existing Open/Restore action.
Missing matches display unavailable navigation. Range/date selection is owned by
App and survives navigation; all surrounding aggregates remain explicitly labeled
as period totals. Hourly selection opens the whole day's contributors.

See [implementation and verification](../../reports/2026-09-16-usage-session-drilldown.md).


## All-history and visible trends amendment, 2026-09-16

The operator requested All beside 7/30 days, the model donut, always-visible cache
trend, a matching shaded daily tool-request trend, and omission of unreported
cache writes with a rebalanced layout. The two trend panels now share a row;
cache values use two columns unless writes have reported coverage. Measured zero
writes remain visible. No evaluation or cost system is added.

All covers every eligible retained record through the existing cutoff. Its daily
series is sparse and limited to 180 occupied points; larger histories use explicit
`bucketDays` with exact totals and unique sessions per bucket. Calendar spacing,
zero-request gaps, cache-share gaps, bucket labels, and cutoff dates remain
truthful. All does not expose session contributors or the hourly heatmap; those
remain available in 7/30-day views. Payload fallback may reduce recent contributor
lists to zero with truthful omitted counts. Strict validation rejects old two-range
saved snapshots so they rebuild from the existing index without a transcript
reread; no index-format or account-state migration is required.

See [implementation evidence](../../reports/2026-09-16-usage-all-and-trends.md).


## Preview graph design amendment, 2026-09-16

The operator supplied `preview.html` as the next graph reference, explicitly
excluding Work produced, Response latency and Context window pressure. The
renderer adopts full-width token flow with By type/By model and Hide cache reads,
paired cache/tool trends, model donut and stacked tool outcome bars, and a
permanently seven-day token heatmap. Error rate uses matched results and the
Requests toggle preserves the previously requested daily call trend. Card heights
remain independent. Shared UTC accounting stays unchanged.

`UsageDay` now carries required matched `results`/`errors` attributed to request
dates; seven-day rows also require 24 hourly exclusive token totals. Totals,
future-hour exclusions and result/error reconciliation are validated. Existing
saved snapshots without those fields rebuild from the index, with no additional
transcript projection or database migration. The 256 KiB cap remains unchanged.

The reference's generated Thinking share, comparisons and cache-TTL details are
not live data. Cached input remains the available summary metric instead of
Thinking share. No demo values or remote font loading are introduced. See
[verification and visual gate](../../reports/2026-09-16-usage-preview-graphs.md).


### 2026-09-16 visual correction

The supplied reference further defines narrow capped bars, regular chart ticks,
inline headline metrics, vertical value/share rows, separated interactive donut
arcs, and hour labels above the fixed seven-day grid. These now replace the first
approximation. Tool Requests remains alongside Error rate; unreported cache-write
rows stay absent; cards size independently. Existing local typography and glass
preference remain. Live Dev inspection was performed, but the local reference URL
was blocked by browser security, so rendered side-by-side acceptance remains open.
See the follow-up evidence in the linked preview-graphs report.


### 2026-09-16 previous-period indicators

The operator approved actual 7-day/30-day comparisons beside the summary-card
sparklines. Each baseline is the current observed UTC interval shifted back the
selected number of days, ending at the same time of day. Counts and tokens per
active day use relative change; Cached input uses percentage points. All,
incomplete coverage, insufficient retained history and zero count baselines omit
indicators. No demo percentages or inferred Thinking share are introduced.

Bounded `previousPeriod` totals retain exact unique sessions and active days.
Counting version 5 invalidates older derived snapshots while reusing indexed
source records. See [period delta semantics and evidence](../../reports/2026-09-16-usage-period-deltas.md).

### 2026-09-16 metric colors

Operator rejected the earlier monolithic pink chart palette and subsequent dull teal/green
on the charts. Per operator direction, pink is adopted purposefully: vivid pink for
Output tokens in the Token Flow stacked columns, and a 9-step rose-to-magenta intensity ramp
for "Token volume by hour". The rest of the dashboard uses blue for fresh input / total tokens,
vivid cyan for cache reads / prompt cache area trend / cached input sparkline, amber for
requests / cache writes, coral for errors, violet for sessions, and clean emerald for successful
tool executions. Model stacks and donut share a distinct categorical palette free of olive/murky
greens. Comparison deltas ▲ and ▼ receive clear directional indicator colors: green for increases (▲)
and red for decreases (▼). Legend swatches, sparklines and trend markers follow those same roles.
Light theme uses darker series colors; dark theme uses lighter colors. Labels, exact values
and keyboard controls remain available alongside color.

Adapted with operator authorization. Native Cat Code Dev observations confirmed chart and
delta colors; light-mode visual acceptance remains open. Renderer checks passed; renderer build
passed. No data, backend or layout behavior changed.

## Session investigation and configured-rate token cost, 2026-09-17

The user authorized the revised Usage roadmap, starting with existing session
investigation and qualified token estimates. GPT-5.6 Sol owns implementation.
The [measurement audit](../../reports/2026-09-17-usage-measurement-audit.md)
defines timing and retry prerequisites; those later features are not part of
this amendment.

Counting version 6 adds deterministic ordinal ranks across all contributors in
each UTC day for tokens, tool requests, and recorded errors. The outbound list
selects the union of the top `floor(limit / 3)` contributors for those metrics,
then fills remaining places by token rank. Existing limits remain 20, 10, 5,
or zero under envelope fallback. This preserves leaders for all three metrics
without suggesting the bounded list contains every session. Ranks survive
regrouping; sorting the displayed rows, including by cost, applies only to the
shown list. All-history contributors remain unavailable.

Models and contributors carry a configured-rate USD subtotal and the number of
priced tokens. Pricing occurs on canonical usage deltas before model grouping,
so `Other` preserves priced amounts and coverage. Known exact configured model
IDs use standard rates for fresh input, cache reads, and output from the shared
dependency-light `modelCostRates.ts`. Cache-write tokens remain unpriced because
the index lacks write-duration detail. Unknown models, including GPT models
without configured rates, remain unpriced.
The existing live-query calculator retains its separate fallback behavior.

These are API-equivalent token estimates at configured standard rates, not
provider bills or subscription spend. They exclude non-token service charges
and do not reconstruct historical prices or speed adjustments. Token pricing
coverage is not monetary coverage. A partially
priced amount is displayed as a subtotal, and absent pricing is not displayed
as zero cost. Existing history and cache-write reporting limitations remain.

The strict snapshot validator requires counting version 6 and pricing version
1, checks nonnegative finite subtotals and priced-token bounds, reconciles
contributor/model amounts, and bounds ranks against contributor counts. Bump
`USAGE_PRICING_VERSION` when configured rates, recognized IDs, or pricing
semantics change. Old saved summaries rebuild from the existing index-v4
projection without rereading unchanged transcripts. Cached worker reads remain
independent of account initialization. No new inbound operation, source
transcript field, account access, or frame-size allowance is introduced.

See [implementation and verification](../../reports/2026-09-17-usage-investigation-implementation.md).

## Tool error trends and measured execution, 2026-09-17

The operator subsequently authorized implementing both the execution timeline
and latency metrics, and replacing the Tools panel's expandable result breakdown
with selectable tool error-rate lines. Commit markers refer to recorded Cat Code
builds, not commits in the session's working project.

Per-tool rates retain the existing errors / matched-results denominator and
request-date attribution. Build-level outcomes also follow the original request,
including results that arrive on a later day. Several builds may occupy a bucket;
an observed build marker is neither a deployment timestamp nor proof of causation.
Unknown versions and bounded omissions remain explicit. The graph preserves
range-wide category grouping instead of changing the meaning of Other each day.

Fresh transcript records carry running-build provenance, and copied messages
retain their recorded source version while sessionId/cwd continue to be stamped
for their destination. SHA-bearing versions identify the recorded base commit;
dirty builds include local edits beyond that commit. Already-relabelled historical
copies cannot be repaired retrospectively, so legacy versions are recorded
provenance rather than independent evidence of the executing binary.

Model measurements cover individual attempts through the shared provider request
path. Logical-call and attempt identities are newly generated; the conversation's
previous request ID does not identify retries. First text means the first nonempty
streamed text delta consumed by that path, not response startup, reasoning, tool
input, or renderer paint. Nonstreaming requests do not contribute first-text
latency. Adapter-internal transport activity remains inside the measured attempt.
Tool intervals cover tool.call, excluding permission and hook waits. A returned
error result remains an error even when the function resolved normally.

Metadata-only starts and terminal records support measured durations; a retained
start without an end does not imply success. Monotonic durations remain separate
from wall-clock placement. Concurrent intervals are not summed into session wall
time, and latency statistics are derived from individual eligible measurements
with population/sample information rather than averages of daily percentiles.

See [implementation scope and verification](../../reports/2026-09-17-usage-tool-trends-and-timing.md).

### Display correction, 2026-09-17

The operator requested a compact Execution timing panel. Its default surface now
shows only metric labels, values, meaningful sample counts, and a nonzero invalid
record notice. Measurement definitions move to titles; repeated unavailable
paragraphs and outcome prose are removed. The underlying measurements and
session timelines remain unchanged.

Named models and tools must not disappear merely because session detail exceeds
the output budget. The production finalizer reduces optional session/build
information independently before collapsing named categories. Counting v9
invalidates earlier saved summaries while reusing index-v5 records. The 256 KiB
limit and exact totals remain unchanged. See [correction evidence](../../reports/2026-09-17-usage-display-corrections.md).

## Automatic permission Usage amendment, 2026-09-18

Usage records initial automatic permission decisions prospectively through a
closed Start/Stage/End metadata contract. The retained projection contains only
bounded IDs, tool kind, effective-auto provenance, route, disposition, and
category identifiers. It excludes tool input, command text, rule text, model or
classifier content, credentials, paths, and transcript message bodies.

The command block rate is `policy-blocked initial command attempts / recorded
initial command attempts`. It is unavailable whenever complete command coverage
is not established; partial retained observations remain explicitly partial.
Pre-capability, older, and unsupported transcript intervals are unavailable, not
measured zeroes. Rechecks are non-counting.

Counting version 13 and `index-v9.sqlite` invalidate older summary/index
projections so retained auto-mode metadata is reconstructed from transcripts.
The Usage section presents only the fixed four chart scopes: Decision flow,
Command block rate, Decisions over time, and Block reasons. No new inbound
operation, renderer-authored rule, or raw-content boundary is introduced.

### Historical display exclusion, 2026-09-19

Pre-contract inference is excluded from the charts. The retained evidence cannot
recover initial routes or outcomes reliably, and its Unknown population obscured
the measured prospective signal. Only structured capability and Start/Stage/End
records contribute to Auto mode charts.

Newly materialized main and agent transcripts write a bounded capability marker
before their first transcript message. That marker proves the observation path
was available for the source's entire retained interval, including zero-attempt
periods. A resumed older source remains Partial before its first marker.
