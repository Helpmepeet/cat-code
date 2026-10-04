# Analytics page gap research

Date: 2026-09-30. Read-only research at HEAD `457b9b72` plus the shared working tree
(no Usage files were dirty). No code changed. Cost, pricing and spend are out of
scope, as is restyling of existing charts.

The question: what would help one heavy user of subscription-plan coding agents
(ChatGPT/Codex and Claude) understand and improve how they work, that the desktop
Analytics page does not show yet?

## Summary

The page answers **how many tokens, tool calls and sessions, and how well the cache
worked**. It does not answer **what the agent produced, why things failed, how much
steering it needed, how delegation went, or which settings drove usage**. Almost
all of that is already written to the operator's transcripts. The usage index
drops it deliberately in `projectRecord` (`src/utils/statsUsageIndex.ts:18-68`).

The best additions come from **new metadata-only projections of records that
already exist**: human prompts and autonomy, subagent outcomes, a closed error
taxonomy, interruptions and queued prompts, and reasoning-effort mix. They need a
USAGE-DASHBOARD amendment for new allowlisted fields, but no transcript content
reaches the renderer.

Several obvious candidates were **already cut by the operator**. Work produced,
Response latency and Context window pressure were cut on 2026-09-16
(`docs/migration/PARITY-LEDGER.md:2671-2672`,
`docs/migration/decisions/USAGE-DASHBOARD.md:170-171`). The Execution timing and
Tool activity panels were removed on 2026-09-24
(`docs/design-reviews/2026-09-24-analytics-review.md`, "Removed"). They are listed
below because the evidence supports them, but each one is marked as needing the
operator to reverse a decision. The records do not say why they were cut. The
2026-09-16 cut came from a mock reference, so it may have been about the mock
content rather than the metric.

## Method

- Read `docs/maps/WORKSPACE_MAP.md`, `docs/maps/analytics-diagnostics.md`, the
  Retained-history Analytics section of `docs/maps/web-app-runtime.md`,
  `docs/migration/decisions/USAGE-DASHBOARD.md` (all amendments),
  `docs/design-reviews/2026-09-24-analytics-review.md`, and
  `docs/reports/2026-09-17-usage-measurement-audit.md`.
- Read the renderer (`app/renderer/src/UsagePage.tsx` and the Usage components),
  the contract (`app/shared/usageDashboard.ts`), and the collector
  (`src/utils/statsUsageIndex.ts`, `src/utils/statsUsage.ts`).
- Profiled the operator's transcripts read-only under `~/.cat-code/projects`.
  Scripts only counted record types, key sets, value types, closed-enum values
  and numeric aggregates. No prompt, response or file content was printed.
  - Corpus: 2,510 JSONL files (544 main, 1,966 subagent), 587,101 records, 0 parse
    errors, timestamps from 2026-04-07 to 2026-09-29.
  - All numbers below come from this scan unless marked otherwise. They cover
    retained history, so they are not lifetime totals.
- Also inspected, read-only: `~/.cat-code/desktop/` (sessions catalog, operational
  logs), `~/.cat-code/usage-data/` (upstream `/insights` output), and
  `~/.cat-code/cache/codex-usage/observation.json`, reading key shapes only.
- Web research: queries and sources are listed at the end.

## What the page shows today

Render order in `app/renderer/src/UsagePage.tsx:65-91`:

1. **Header** (`:65`): title, local date range, "Updated" time, icon refresh
   button, and a 7 days / 30 days / All period control.
2. **Five summary cards** (`UsageMetrics.tsx`): Total tokens, Per active day,
   Sessions, Tool requests, Cache read rate. Each has a sparkline and a change
   against the prior period.
3. **Tokens** (`:75`): stacked area chart, By type or By model.
   - Selecting a day shows that day's tokens, sessions, tool requests and errors
     (`:79`).
   - It also shows a session table with Session, Tokens and Est. cost
     (`UsageSessionContributors.tsx:23`).
4. **Prompt cache** (`:84`): cache read rate trend, plus Cache reads, Cache
   writes and Input rows.
5. **Model usage** (`:85`): donut with a Current / All models toggle.
6. **Tools** (`:87`): request bars split into successful, error and unmatched,
   plus an "Error rate over time" chart per tool.
7. **Daily activity** (`:88`): one box per local day.
8. **Auto mode** (`:89`): Decision flow, Command block rate, Decisions over time,
   and Block reasons.
9. **View as table** (`:91`): full-precision tables for tokens, models, tools,
   observed Cat Code builds, daily activity, and auto-mode routes, outcomes and
   reasons.

**In the snapshot but not rendered:**

- `UsageRangeSummary.timing`, defined at `app/shared/usageDashboard.ts:112-127`.
  It holds model logical calls, retried calls, attempt outcomes, and p50/p95 for
  response time, first text and tool duration.
- `UsageSessionContributor` fields, defined at `app/shared/usageDashboard.ts:128-143`:
  - per-session `requests`, `results`, `errors`, `models` and `rank`;
  - a `timeline` of up to 12 model and tool events.

The test at `app/renderer/src/UsagePage.test.tsx:45` asserts that "Execution
timing" is absent, and `UsageSessionContributors.dom.test.tsx:31` asserts that no
timeline row renders.

## What the usage index keeps and drops

`projectRecord` (`src/utils/statsUsageIndex.ts:18-68`) keeps:

- The record envelope: type, sessionId, uuid, timestamp, cwd, version and
  isSidechain (`:21-22`).
- For assistant records: message id, model, four token fields, and tool_use
  id/name.
- For user records: tool_result id and is_error (`:36`).
- Among system records, only the auto-mode records and the five
  `model_attempt_*` / `tool_execution_*` subtypes (`:41-66`).

Everything else is dropped. The table below lists what the operator's transcripts
contain that this projection discards.

| Record (writer) | Count, first to last seen | Useful metadata fields |
|---|---|---|
| `run_facts` (`src/utils/sessionStorage.ts:925`) | 602, 07-31 to 09-29 | model, permissionMode, effort, contextWindow |
| `codex_send_path` (`sessionStorage.ts:734`) | 35,738, 07-31 to 09-29 | effort per request, mode (incremental 33,254 / full 2,431 / stale_retry 53), ttfb_ms, cached_tokens |
| `codex_stream_surface` (`sessionStorage.ts:763`) | 49,058, 07-31 to 09-29 | transport (websocket 35,849 / http 13,209), first_text_delta_ms, completed_ms, completed, error_name |
| `codex_request_start` (`sessionStorage.ts:713`) | 41,091, 08-12 to 09-29 | model, mode, account_id_prefix |
| `compact_boundary` | 90, 04-08 to 09-27 | compactMetadata.trigger (auto 74 / manual 16), preTokens |
| `subagent-spawned` / `subagent-terminal` (`sessionStorage.ts:562,573`; types `src/types/logs.ts:362-385`) | 536 / 542, 08-02 to 09-27 | agentType, status, durationMs; also free-text `description` and `reason` |
| `api_error` | 187, 04-10 to 09-27 | error status (401, 503), retryAttempt, retryInMs |
| `transport_recovery` | 14 | attempt, maxAttempts |
| `prompt_cache_break` (`sessionStorage.ts:977`) | 889, 04-28 to **08-28** | reason, ttlBucket, `*Changed` flags, tokenDrop |
| `turn_duration` (`src/utils/messages.ts:4657`) | 413, 04-08 to **08-16** | durationMs, messageCount |
| `queue-operation` (`src/utils/messageQueueManager.ts:62`) | 1,883, 07-31 to 09-28 | operation (enqueue 946 / dequeue 747 / remove 190) |
| `pr-link` (`sessionStorage.ts:1679`) | 5, 08-08 to 09-05 | prNumber, prRepository |
| attachment `hook_non_blocking_error` / `hook_success` | 2,222 / 405 | hookName (event:matcher), exitCode, durationMs; also command and stderr |
| attachment `invoked_skills`, `skill_listing`, `queued_command`, `todo_reminder`, `date_change` | 8 / 274 / 245 / 1,931 / 15 | counts |
| user `toolUseResult`, Apply_patch / Edit / Write | 4,410 file patches | `structuredPatch` hunks (line counts derivable); apply_patch `mutationOutcome` and `code` |
| user `toolUseResult`, Skill | 1,015+ | commandName, success |
| user `toolUseResult`, Agent | 349 | agentType, status, totalDurationMs, totalTokens, totalToolUseCount |
| user `toolUseResult`, SendToPeer | 267 | delivery, outcome |
| user envelope | 158,630 | permissionMode, isMeta, promptId, `origin.kind` (task-notification 621, peer 215, interruption 76) |
| assistant `usage` | 244,696 | speed and service_tier (always `standard`), server_tool_use |

Other local stores:

- `~/.cat-code/desktop/sessions-catalog.json` has title, messageCount,
  createdAtMs, modifiedAtMs, gitBranch and prNumber per session.
- Desktop operational logs hold `session.turn.completed` with durationMs, but
  retention is short: the oldest file is from 2026-09-29.
- `~/.cat-code/cache/codex-usage/observation.json` holds only the latest account
  quota observation (5-hour and weekly windows). There is no history.

## Ranked candidates

Ranking is value to this user multiplied by feasibility. Where an item conflicts
with an earlier decision, it drops.

Availability tags:

- **[snapshot]**: already in the dashboard snapshot.
- **[indexed]**: in the usage index but not aggregated.
- **[recorded]**: in transcripts but not projected by the index.
- **[not recorded]**: not captured anywhere.

### 1. Prompts and autonomy

**Shows:** human prompts per day, plus these ratios per prompt: tool requests,
tokens, and agent working time (from the prompt to the last record before the next
prompt). It also shows a distribution of prompts per session.

**Why it matters:** it is the core "how much did I have to drive it" signal, and it
works across every model and provider. Measured values:

- 2,570 human prompts in main sessions. This excludes tool results, isMeta,
  injected-origin records and interrupt markers.
- The median session has 2 prompts; p90 is 12.
- The median gap between an assistant record and the user's next prompt is 57 s;
  p90 is 555 s. This is the user's think time.

**Availability:** [recorded]. User records are indexed, but their text blocks are
projected as `null` (`statsUsageIndex.ts:36`), and isMeta and `origin` are dropped.
The fix is to project a boolean "human prompt", derived from isMeta, origin.kind
and "has text block", with no text.

**Owners:** `src/utils/statsUsageIndex.ts`, `src/utils/statsUsage.ts`,
`app/shared/usageDashboard.ts`, `app/sidecar/usageSummary.ts`, and a new renderer
card or panel.

**Effort:** M.

**Conflicts:** needs a projection amendment for a derived boolean; no content
crosses. External precedent:

- Factory's "autonomy ratio and tool calls per user message".
- Devin's "User Messages", read as a course-correction signal.
- Grafana's Claude Code dashboard "User Prompts".
- `/insights` `user_response_times` (`src/commands/insights.ts:470-720`).

### 2. Subagent delegation

**Shows:**

- Spawns by agent type.
- Outcome mix: completed, failed, killed, stall-detected.
- Duration p50/p90.
- Subagent share of tokens and tool requests versus main sessions.

**Why it matters:** delegation is a large share of this user's work (1,966
subagent transcripts against 544 main). Outcomes are poor enough to act on. Of 542
terminal records:

- completed 425, failed 86 (16%), killed 19, stall-detected 12;
- median duration 5.8 min, p90 18.7 min.

**Availability:** [recorded] for spawn and terminal records. The main/subagent
split is [indexed]: `statsUsage.ts:437` already separates subagent files. It
credits their tokens to the owning session and never reports the split.

**Owners:** as for item 1, plus the `SubagentTerminalMessage` status enum
(`src/types/logs.ts:375-385`).

**Effort:** M.

**Conflicts:** project only `agentType`, `status` and `durationMs`. Do not project
the free-text `description` or `reason`. External precedent: SigNoz's "Subagent
Token Spend vs Main", ai-session-analysis, claudit, and Agent Deck.

### 3. Why tool calls fail: a closed error taxonomy

**Shows:** errors split into a fixed set of categories: command exit, not found,
permission denied, patch anchor, auto-mode classifier block, timeout, interrupted,
and other. For apply_patch it adds the tool's own closed codes.

**Why it matters:** today the page says how often tools fail, but not why. The
categories point to different fixes, such as prompts, permissions, patch tooling or
environment. A rough keyword classification of 7,210 recorded errors gives:

| Category | Count |
|---|---|
| command exit | 3,045 |
| not found | 1,271 |
| other | 1,173 |
| permission denied | 749 |
| patch | 617 |
| classifier blocked | 180 |
| interrupted | 90 |
| timeout | 85 |

apply_patch no-mutation codes: `PATCH_ANCHOR_AMBIGUOUS` 271,
`PATCH_ANCHOR_NOT_FOUND` 133, `PATCH_ANCHOR_NONCONSECUTIVE` 14,
`PATCH_ORDER_CONFLICT` 11, `PATCH_PREFLIGHT_FAILED` 9.

**Availability:** [recorded].

- The apply_patch codes are structured
  (`src/tools/FilePatchTool/FilePatchTool.tsx:684`).
- Every other category needs classification of result text at index time.
  Precedent: `/insights` categorizes the same way.

**Owners:** the index projection, plus a shared classifier. A better long-term
source would be an engine-emitted `error_type`, like Claude Code OTel's
`tool_result.error_type`.

**Effort:** M.

**Conflicts:** the index would read result text transiently and persist only an
enum. That needs an explicit amendment, because the current rule is that tool
results project only IDs and is_error. External precedent: Sniffly's error
breakdown, and Claude Code OTel `tool_result` with `error_type`.

### 4. Interruptions and steering

**Shows:** per day and per session:

- user interrupts;
- prompts queued while the agent was busy;
- turns injected by peers or task notifications.

**Why it matters:** these count how often the user has to redirect a running agent,
which is the most direct friction signal short of reading transcripts. Measured:

- 165 `[Request interrupted by user…]` markers, plus 76 `origin.kind:
  interruption` records;
- 946 queued prompts (`queue-operation` enqueue);
- 621 task-notification turns and 215 peer turns.

**Availability:** [recorded]. `queue-operation` is not a user/assistant/system
record, so the index ignores it. The interrupt marker is the constant at
`src/utils/messages.ts:215`.

**Owners:** the index projection. Accept `queue-operation.operation`, project
`origin.kind`, and add a boolean interrupt flag.

**Effort:** S to M.

**Conflicts:** interrupt detection matches one fixed constant string; it is not
classification. External precedent: Sniffly "interruptions", `/insights`
`user_interruptions`, and Devin user-message counts.

### 5. Reasoning effort and permission mode mix

**Shows:** tokens and requests by reasoning effort (low, medium, high, xhigh,
max), and share of work per permission mode, over time.

**Why it matters:** on a subscription, effort is the main lever the user controls
over quota burn and latency. Per-request effort over 35,738 Codex sends:

| Effort | Requests |
|---|---|
| high | 24,621 |
| max | 7,503 |
| medium | 2,214 |
| low | 977 |
| xhigh | 376 |

`run_facts` shows permissionMode `auto` in 589 of 602 records.

**Availability:** [recorded]: `run_facts` from 07-31 and `codex_send_path.effort`.
Attribution is simple: each assistant record inherits the latest preceding
`run_facts` in the same file, in order.

**Owners:** index projection (`run_facts` fields), accumulator, contract.

**Effort:** M.

**Conflicts:** none; closed values. External precedent: Claude Code OTel carries
`effort` on `token.usage` and `api_request`.

### 6. Work produced: lines and files changed

**Shows:**

- lines added and removed, files touched, and language by file extension, per day
  and per session;
- optionally, lines per million tokens as an efficiency ratio.

**Why it matters:** every external product surveyed shows this, and it is the only
output-side measure available. Measured from `structuredPatch` in Apply_patch,
apply_patch, Edit and Write results:

- 75,203 lines added and 42,674 removed across 4,410 file patches;
- extensions: ts 2,444, tsx 779, md 718, py 233.

**Availability:** [recorded]. Persistence truncates only long lines, never the line
count (`src/utils/diff.ts:161-179`). New-file writes have an empty patch; their
lines come from the written content.

**Owners:** index projection, keeping numbers and the extension only.

**Effort:** M.

**Conflicts:**

- **"Work produced" was an operator-directed cut on 2026-09-16.** Re-adding it
  needs the operator to reverse that.
- Paths must not be projected; extension only.

External precedent: Claude Code analytics "lines of code accepted" and OTel
`lines_of_code.count`, Cursor, Copilot, Factory, WakaTime and Grafana.

### 7. Breakdown by project

**Shows:** tokens, sessions, tool requests and errors per project for the whole
period. Today the page only has per-day session lists, capped at 20.

**Why it matters:** it answers where the agent time went, for someone working
across 68 project directories.

**Availability:** [indexed]. Counting v4 already projects cwd into a project hash
and label for contributors (`USAGE-DASHBOARD.md:126-130`), but nothing aggregates
it at range level.

**Owners:** `statsUsage.ts` range aggregation, `usageSummary.ts` bounding, and the
contract.

**Effort:** S to M.

**Conflicts:** none beyond the existing basename-label rule. External precedent:
WakaTime (by project), meow-ops, Agent Deck.

### 8. Parallel sessions and active hours

**Shows:**

- active agent hours per day;
- how often several main sessions run at once;
- user wait time versus agent run time.

**Why it matters:** this user runs parallel sessions and peers. Counting minutes
that contain a main-session user or assistant record:

| Main sessions active | Minutes |
|---|---|
| 1 | 6,308 |
| 2 | 979 |
| 3 | 109 |
| 4 or more | 13 |

So about 15% of active minutes had two or more main sessions running (subagents
excluded).

**Availability:** [indexed] for timestamps and sessions. The user/agent split
depends on item 1.

- The desktop never writes `turn_duration`; only the terminal REPL does
  (`src/screens/REPL.tsx:1813,3481`). The last record is dated 2026-08-16.
- Desktop operational logs have turn durations but a short retention window.

**Owners:** the accumulator. Durations are derived from timestamps, so they
approximate wall-clock spans.

**Effort:** M.

**Conflicts:** the measurement audit forbids summing overlapping intervals into
session time (`docs/reports/2026-09-17-usage-measurement-audit.md`, "No metric may
claim…"). Show spans and overlap counts, not summed durations. External precedent:
Claude Code OTel `active_time.total` (user vs cli), Grafana "Active Time per Day",
`/insights` multi-clauding.

### 9. Model and provider reliability

**Shows:** per day:

- failed and cancelled model attempts, and retried calls;
- stream disconnects by type;
- API auth and server errors.

**Why it matters:** it separates agent mistakes from infrastructure trouble.
Measured:

- `model_attempt_end`: 5,729 succeeded, 24 failed, 24 cancelled; 3 retries.
- `codex_stream_surface` errors: `CodexWebSocketClosedBeforeCompletedError` 49,
  `CodexWebSocketIdleTimeoutError` 35, `AbortError` 27.
- `api_error` status 401 ×5, 503 ×4.
- Subagent failures from Codex account authentication: 33.

**Availability:** partly [snapshot]: `timing.models.outcomes` and `retriedCalls`.
The rest is [recorded].

**Owners:** `src/utils/usageTiming.ts`, and the index projection for `api_error`
status and `codex_stream_surface.error_name`.

**Effort:** M.

**Conflicts:**

- **The Execution timing panel, which carried these outcomes, was removed on
  2026-09-24.**
- The audit says Codex stream-surface records lack a join key and cover only the
  Codex adapter. Present them as a qualified diagnostic, not complete coverage.

External precedent: Grafana "API Errors Over Time", Claude Code OTel `api_error`
and `api_retries_exhausted`.

### 10. Skills and hooks

**Shows:**

- skill invocations by skill name, with success;
- hook runs and failures by event and matcher, with exit code and duration;
- optionally, MCP server grouping of tool calls.

**Why it matters:** the operator authors many skills and hooks. Two findings from
this data:

- Top skills: `cat-code-migration-session` 148, `verifying-cat-code-changes` 141,
  `writing-cat-code-tests` 135.
- **A hook has been failing silently at volume** (see Surprises).

**Availability:** [recorded]. Skill names come from `toolUseResult.commandName`.
Hooks come from attachment records, which the index keeps only as bare envelopes.

**Owners:** index projection, contract, and the Tools panel or a small new panel.

**Effort:** S to M.

**Conflicts:**

- Skill names are user-authored labels. Bound them like model names (160 bytes).
- Do not project hook `command` or `stderr`.

External precedent: Factory "skills invocations, slash commands, hooks, MCP
servers", Claude Code OTel `skill_activated` and `hook_execution_start`, and
claudit.

### 11. Compaction and context pressure

**Shows:** compactions per day (auto vs manual), context size before compaction,
and peak context-window use per session.

**Why it matters:** compaction loses working state. Measured:

- 90 compactions; median pre-compaction context 272,625 tokens, maximum 742,348.
- Of the 419 sessions with a known window, peak window use has median 18% and p90
  57%; 7 sessions exceeded 80%.

**Availability:** [recorded]: `compact_boundary`, and the `run_facts` context
window.

**Effort:** M.

**Conflicts:** **"Context window pressure" was an operator-directed cut on
2026-09-16.** Its value also looks modest at these percentiles.

### 12. Subscription window pacing

**Shows:** token burn per rolling 5-hour block and per week, and optionally how
much quota a block consumed.

**Why it matters:** subscription limits work in 5-hour and weekly windows, not
calendar days.

**Availability:**

- Block burn from the user's own records is [snapshot] for 7 days only: seven-day
  days carry hourly exclusive tokens (`UsageHour.tokens`,
  `usageDashboard.ts:149-159`).
- Quota-percentage history is [not recorded]: `observation.json` keeps only the
  latest observation.

**Effort:** S for burn blocks; L for quota history.

**Conflicts:**

- Quota polling belongs to Accounts (`docs/maps/web-app-runtime.md`, Retained-history
  Analytics).
- The account pool rotates, so per-account pacing belongs there.
- **Only the pool-wide burn-per-block view clearly belongs on Analytics.**

External precedent: ccusage `blocks` (burn rate, projection, gaps),
Claude-Code-Usage-Monitor, Codex `/status`, codex-reset.com.

### 13. Latency

**Shows:** time to first text, response duration and tool duration (p50/p95).

**Availability:** [snapshot]: `timing`. Also `codex_stream_surface` back to 07-31.
Measured:

- model attempts: first text p50 7.9 s; attempt p50 9.9 s, p95 54.4 s;
- Bash execution p50 81 ms, p95 11.4 s.

**Effort:** S if reinstated.

**Conflicts:** **cut twice**, as "Response latency" on 2026-09-16 and as Execution
timing on 2026-09-24. Listed only because the data costs nothing to show.

### 14. Richer session rows

**Shows:** in the selected-day session table, requests, errors, error rate and
models per session, plus the per-session timeline.

**Availability:** [snapshot] (`usageDashboard.ts:128-143`).

**Effort:** S.

**Conflicts:** on 2026-09-24 the operator agreed the table "keeps Session, Tokens,
and Est. cost". Extra columns reverse that.

### 15. Prompt cache break causes (marginal)

**Shows:** why the cache missed: system prompt change, tool change, model change,
TTL, or server eviction.

**Why it is marginal:** 808 of the 889 records say "likely server-side", and the
cache read rate is already about 96.5%. **No records since 2026-08-28**; that cause
is unverified.

### 16. Git outcomes (weak)

**Shows:** commits and PRs per session.

**Availability:** `pr-link` has only 5 records. Detecting commits needs Bash
input, which the privacy rules forbid, or new engine instrumentation.

**Effort:** L.

**Why it is weak:** for one user the git log already answers this.

## Judged not worth adding here

- **Suggestion accept rate** (Claude Code analytics and OTel
  `code_edit_tool.decision`). This user runs in auto mode (589 of 602 `run_facts`),
  and the Auto mode panel already covers permission outcomes.
- **Team metrics**: DAU/WAU/MAU, stickiness, leaderboards, adoption cohorts or
  phases (Copilot, Cursor, Factory, DX). There is only one user.
- **AI vs human line attribution and PR attribution** (WakaTime, Claude Code
  contribution metrics). These need a git-diff attribution pipeline and a repo
  history join. The cost is high, and for one person the answer is usually "most
  of it".
- **Model-judged session facets** (upstream `/insights`: goal, outcome,
  satisfaction, friction; Devin Session Insights). They would send transcript
  content to a model, spend subscription quota, and give nondeterministic output.
  The upstream `/insights` command already exists (`src/commands.ts:198-208`).
- **Prompt length** (WakaTime, OTel `prompt_length`). It is a number derived from
  content with little decision value.
- **Gamification and streaks** (meow-ops). Terminal `/stats` already has streaks.
- **Speed and service tier**: always `standard` across 48k records.
  `cache_deleted_input_tokens` has no non-zero values.
- **App health** (sidecar exits, renderer health). Operational logs have short
  retention and belong to diagnostics, not work analytics.
- **CSV export.** "View as table" already exists.

## Surprises and findings outside the listed categories

- **The map-routing nudge hook has failed silently on 2,222 tool calls.**
  - The hook is `PreToolUse` `.claude/hooks/map-routing-nudge.sh`, configured at
    `.claude/settings.local.json:117`.
  - It exits with code 127 and the error "exec: bun: not found".
  - It hit Bash 2,042 times, Grep 155 and Glob 25, on 2026-09-15 and from 09-19 to
    09-27. It also succeeded in some sessions.
  - Likely cause (unverified): the session environment lacks `bun` on PATH.
  - This affects any evaluation of that nudge. The memory index says "nudge hook
    live, readout never recorded". A hook-failure count on Analytics would have
    surfaced it.
- **Subagent failures included a code defect.**
  - 25 terminal records had the reason "toolUseContext.setResponseLength is not a
    function", from 2026-09-04 to 09-23.
  - Current source calls it optionally (`src/services/compact/compact.ts:511` and
    similar), so it appears fixed. Not verified at runtime.
  - Another 33 failures were Codex authentication with no healthy replacement
    account (08-07 to 09-12).
- **The snapshot carries data the page never draws.** Timing summaries and
  per-session timelines still occupy the 256 KiB payload budget after the
  2026-09-24 removal.
- **`turn_duration` is terminal-only.** Desktop sessions have no per-turn duration
  record at all.
- **`/insights` would undercount this user's edits.** It counts lines only from
  Edit and Write (`src/commands/insights.ts:572`). This operator edits mostly with
  Apply_patch and apply_patch (7,420 tool_use blocks against 1,713 for Edit plus
  Write). Its local output (`~/.cat-code/usage-data/`) was last written 2026-05-23.
- **The Current model view may be mostly "Other".** In `assets/readme/analytics.png`
  (30 days), the "Current" view shows Other at 65.6% with 2 named models.
  - The Current filter hides only named `gpt-5.6-sol/luna`
    (`app/shared/usageModelStatus.ts:4`) and keeps Other.
  - Whether Other is mostly retired models is unverified. If it is, the Current
    view's model mix is misleading.
- **`prompt_cache_break` stopped appearing after 2026-08-28.** The cause is
  unverified.

## Web research

All searches and fetches ran on 2026-09-30.

**Queries:**

1. `AI coding agent usage analytics dashboard metrics 2026`
2. `Claude Code analytics dashboard lines accepted suggestion accept rate sessions per user`
3. `ccusage OR "claude-code-usage-monitor" burn rate session block limit prediction`
4. `Cursor analytics dashboard agent requests tabs accepted lines per user 2026`
5. `GitHub Copilot usage metrics dashboard agent mode code review lines changed 2026`
6. `OpenAI Codex usage dashboard analytics rate limits credits 2026`
7. `WakaTime AI coding agent tracking Claude Code Cursor 2026 dashboard "AI"`
8. `sniffly claude code analytics error types dashboard`
9. `open source local dashboard Claude Code Codex session transcripts analytics subagents compaction 2026`
10. `DX AI measurement framework utilization impact cost metrics agent "time savings" 2026`
11. `Claude Code OpenTelemetry metrics active_time lines_of_code commit pull_request code_edit_tool.decision`
12. `Factory AI droids analytics dashboard OR Devin session insights metrics 2026`
13. `Codex CLI "/status" OR "codex usage" rate limit 5 hour weekly pacing reset tracker tool`

**Sources fetched and read:**

| Product | Source | Date |
|---|---|---|
| Claude Code Team/Enterprise analytics | https://code.claude.com/docs/en/analytics | undated docs page |
| Claude Code OTel metrics and events | https://code.claude.com/docs/en/monitoring-usage | undated docs page |
| ccusage blocks report | https://ccusage.com/guide/blocks-reports | undated |
| GitHub Copilot impact dashboard | https://github.blog/changelog/2026-07-22-new-copilot-usage-metrics-impact-dashboard/ | 2026-07-22 |
| WakaTime AI dashboard | https://wakatime.com/ai | ©2026, undated |
| Sniffly (local Claude Code dashboard) | https://github.com/chiphuyen/sniffly | release date not visible |
| Grafana "Claude Code" dashboard 25052 | https://grafana.com/grafana/dashboards/25052-claude-code/ | 2026-03-23, updated 2026-05-01 |
| SigNoz degradation signals | https://signoz.io/blog/claude-code-measure-degradation-opentelemetry/ | May 2026 |
| Factory Analytics | https://factory.com/news/factory-analytics | 2026-03-11 |
| Devin Session Insights | https://docs.devin.ai/product-guides/session-insights | undated |

**Seen only in search snippets (not fetched; treat as unverified):**

- Cursor team analytics (docs.cursor.com); Copilot VS Code Agents metrics
  (changelog 2026-09-11).
- claudit, meow-ops, ai-session-analysis, Agent Deck, agent-session-index
  (GitHub, undated).
- Claude-Code-Usage-Monitor.
- DX AI Measurement Framework (getdx.com).
- Codex rate-limit trackers: codex-reset.com, inventivehq.

**Not yet named in the brief:** Factory, Devin, SigNoz, Sniffly, WakaTime,
claudit, Agent Deck, and the Grafana community dashboard.

## Could not verify

- **Why each operator cut was made** (2026-09-16 and 2026-09-24). The records state
  the decisions, not the reasons.
- **The error taxonomy counts.** They come from my own keyword classifier over
  result text. They show the scale of the distribution, not a production
  specification.
- **The human prompt definition.** It is my own rule: no tool_result, not isMeta,
  no origin, has text, not an interrupt. It may differ from the engine's notion.
- **Concurrency and span figures.** They come from record timestamps at minute
  granularity and approximate activity, not measured active time.
- **Several root causes:** the hook's PATH cause, the cause of the
  `prompt_cache_break` gap, the composition of the model donut's Other slice, and
  the runtime status of the `setResponseLength` fix.
- **The Claude-side share.** The corpus is overwhelmingly GPT/Codex (307 Claude
  assistant records). Claude-path fields such as cache-write TTL buckets were
  barely observable.
- **Features in the snippet-only products above.** Not independently confirmed.
