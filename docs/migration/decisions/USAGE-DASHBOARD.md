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

Rollout uses a single main-owned CATCODE_USAGE_DASHBOARD=1 switch. Disabled means
Usage is Unavailable. Account workers and session frames are not authoritative
publishers for this overview. Rollback disables the switch; it never restores old
misleading totals or changes retained transcripts. No persisted usage migration.

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
