# Usage tool trends, build attribution, and execution timing

The user authorized GPT-5.6 Sol to implement measured execution timelines and
latency metrics, then requested replacing the Tools panel's expandable result
breakdown with selectable error-rate lines and commit markers. The markers refer
to the Cat Code version running the tools, not commits in the working project.
Three Sol agents implemented the timing, tool trends, and build-provenance slices.

## Acceptance and interpretation

- Keep the existing Tools request/outcome totals. Replace the redundant expanded
  error bars with a visible time series for selected tools.
- Compute each error rate from errors divided by matched results for that tool
  and time bucket. Display counts; a missing result is not a success. No-result
  buckets are unavailable, while observed zero-error buckets are genuinely zero.
- Attribute an outcome to its canonical request's date and recorded build even
  when the result arrives on another date. Multiple builds can overlap.
- Commit markers identify observed Cat Code build activity. They neither assert
  the deployment time nor prove a commit caused an error. Historical missing
  versions cannot be recovered by inspecting today's checkout.
- Preserve build provenance across copied/resumed records; keep required session
  identity and cwd restamping. Distinguish source builds containing local changes.
- Record actual model/tool intervals with explicit boundaries and identities.
  First streamed text is distinct from protocol startup and renderer paint.
  Durations of concurrent operations must not be added to imply session duration.
- Compute latency statistics from individual eligible measurements, with sample
  counts and missing measurements disclosed. Older logs lacking measurements
  remain unavailable. No demo values are used in the application.
- Retain bounded metadata-only indexing and strict outbound validation. Preserve
  the existing envelope cap, user transcripts, account isolation, and navigation.

## Implemented surfaces

The Tools panel keeps its stacked request/outcome totals. The former disclosure
is replaced by [UsageToolErrorTrend](../../app/renderer/src/UsageToolErrorTrend.tsx),
with multiple tool selections, an adaptive percentage axis, gaps, exact values,
and a Commits toggle. Build markers share the date/bucket axis and combine the
same build across selected tools. Focus/hover exposes per-tool matched-result
counts and rates, with the first observed timestamp. Keyboard navigation uses a
single entry point and arrow keys. Missing provenance and omitted markers are
reported separately.

[UsageTiming](../../app/renderer/src/UsageTiming.tsx) adds the always-visible
Execution timing panel: p50/p95 and sample counts for first streamed text,
successful model-attempt duration, and successful tool-run duration. Counts show
success, failure, cancellation, starts without an end, and observed retried calls.
First-text measurements can include streams that later failed or remained
incomplete; duration percentiles explicitly include successes only.

In a selected UTC day, each session contributor has a Timeline button beside
Open. Recent model/tool intervals share a time axis and overlap lanes. Model
retries retain opaque call identity and display Call labels and connectors.
Missing terminal records are labelled “No end recorded.” This is a bounded recent
execution view for the selected day, not an unbounded lifetime trace viewer.
All-history buckets retain aggregate metrics and tool trends; session drilldown
continues to use the 7-day and 30-day ranges.

## Measurement and persistence

[modelAttemptRecorder](../../src/services/api/modelAttemptRecorder.ts) records
stable logical-call/attempt IDs and monotonic durations around the shared model
request path in [claude.ts](../../src/services/api/claude.ts). The same path covers
resolved Claude and OpenAI providers, including streaming/nonstreaming fallback.
Provider-adapter internal transport attempts remain inside this interval; the
reported retry count does not inventory those wire-level retries. Streaming
first text observes a nonempty text delta; nonstreaming requests do not supply it.

[toolExecution](../../src/services/tools/toolExecution.ts) measures tool.call.
Duration stops when the call returns, while outcome uses the mapped error flag
or thrown failure/cancellation. Metadata-only start/text/end rows are persisted
best effort to an already-owned transcript. No prompt, response body, tool input,
error body, or account identity is added to Usage.

[buildProvenance](../../src/utils/buildProvenance.ts) reads the trusted Cat Code
source checkout once at startup/build time, with bounded Git queries and explicit
dirty state. Unknown commit/cleanliness remains unknown. Transcript serialization
preserves source versions on copied history while restamping destination
sessionId/cwd. A compiled asynchronous write test covers Bun's macro substitution
behavior. Historical copies already relabelled by the old writer are irrecoverable;
legacy SHA fields identify the recorded build, not independent proof of the
executing binary. Dirty markers identify a base commit plus unspecified local edits.

[statsUsage](../../src/utils/statsUsage.ts) owns accounting and measurement joins;
[usageTiming](../../src/utils/usageTiming.ts) computes nearest-rank percentiles
from individual measured samples before UI truncation. Invalid/duplicate timing
rows increment timing-specific `invalidTimings`, which does not imply incomplete
token/tool totals. The timing panel reports the excluded count.

Counting version 8 and the rebuildable index-v5 projection preserve version and
allowlisted timing fields. Old snapshots rebuild; unchanged indexed records can
be reused when their projection already contains the needed fields. Normal
transcripts remain untouched by collection. Cache-read worker behavior remains
independent of engine/account initialization.

The existing 256 KiB envelope stays fixed. Range-wide tool/model grouping remains
consistent across days. Build markers retain up to 8, 4, or zero identities per
tool bucket as detail falls back, with exact omitted outcome totals. Timelines
retain the latest 12, 6, or 1 events per shown session at the 20/10/5 contributor
tiers, with exact omission counts; final zero-detail fallback remains possible.
Aggregate latency statistics are computed before these display caps.

## Verification

- Final combined focused run: **187 passed, zero failed**, 1,299 assertions across
  29 files. Covers real persisted timing rows, compiled build stamps, provider
  retry behavior, tool execution, accounting/indexing, envelope fallback, strict
  validation, graph interactions, timeline interactions, and session navigation.
- App typecheck, renderer production build, final engine build, and scoped
  sidecar typecheck pass (zero owned diagnostics).
- The cold/cached usage worker probe passes without account initialization.
- A broad desktop run caught an envelope issue with busy measured history:
  three events at the five-contributor tier forced all session detail out. The
  corrected one-event tier retains recent detail across all 30 fixture days;
  the final focused run includes this regression passing.
- Broad desktop run: **5,005 passed, 37 failed, 10 errors** across 318 files.
  This run started before the final fixes and includes the corrected busy-history
  failure described above. Remaining failures concern socket/process/runtime
  probes, including explicit Unix-socket EPERM failures and absent authentication;
  an archived temporary test also imports a missing accountsState.js. The normal
  bootstrap test failed in the broad run but passes in isolated configuration
  (one passed, zero failed). The broad suite was not rerun after the focused fixes,
  and no full-suite pass is claimed.
- A final timing/timeline and user-visible-text subset passes (**13 passed, zero
  failed**) after clarifying that transport retries within an attempt are not
  counted separately.
- Map lint passes for 17 maps with 7 existing recommended-section warnings.
  Diff whitespace check passes.

No GUI, hardening launch, installation, app restart, live account call, or push was
performed. These are source/headless results, not visual acceptance. Building
source does not update the installed app. After an authorized update/restart,
open Usage to inspect the Tools graph and Execution timing panel; choose a day
and then Timeline beside a session. Historical timing remains unavailable where
the new measurements were never recorded.
