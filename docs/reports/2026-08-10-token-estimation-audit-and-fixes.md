# Token/context estimation: audit, calibration, and fixes

**Date:** 2026-08-10 · **Branch:** `migration` · **Commits:** `e1e8a806`, `9a2356d8`, `e9e161db`, `d083428e`, `3d951201`
**Scope:** `tokenCountWithEstimation()` and every path that relies on it for context-window/autocompact decisions.

This is a historical record of one session: a source-level audit of the token
estimator, an independent review that corrected the audit's blast-radius
claims, a tokenizer calibration, and the orchestrated implementation of every
accepted fix. Line numbers cite the tree as of `d083428e`; verify against
current source before acting on them.

## 1. Verdict

Mostly correct with bounded approximation on the live decision paths. The
anchor+slice design (last real API usage + rough estimate of messages appended
since) is structurally sound, and each pre-existing special case — preserved-
segment skip, zero-seed skip, openai-anchor invalidation — correctly fixes the
failure it was written for. The weak point was the **rough-estimation
fallback**: everywhere the estimator could not trust an anchor it omitted
~20-40k tokens of system prompt + tool schemas + userContext
(self-documented at `compact.ts` near the `truePostCompactTokenCount`
computation) and undercounted dense structured output. The recurring failure
*class* is: a context mutation ships that shrinks the rendered request without
shrinking the stored array, and no estimator compensation ships with it — the
estimator's git history before this session was exactly three commits: the
initial snapshot, the stale-statusline fix (`0798e15a`), and the gpt
wire-truncation fix (`c5738776`), each a point fix after an incident.

## 2. Confirmed findings (all reproduced before fixing)

1. **Sibling-split double-count** (over-estimation). One streamed API response
   with parallel tool calls becomes N assistant records sharing one
   `message.id`; only the last gets the final usage written back
   (`src/services/api/claude.ts` content_block_stop split + late write-back).
   The estimator's sibling walk-back re-counted the sibling records' own
   content on top of the anchor's `output_tokens`. Measured: +20,018 phantom
   tokens on three parallel 40KB Writes.
2. **Boundary-blind walk** (stale anchor). `tokenCountWithEstimation` never
   stopped at a compact boundary; only `query.ts` sliced before decisions.
   Fullscreen mode (default-on) keeps pre-compact scrollback in the REPL
   array, so every unsliced caller (StatusLine, REPL telemetry, the
   context-warning banner, session-memory cadence) re-anchored on pre-compact
   usage after compaction. Measured: 180,514 vs 14 on the same array sliced.
   The independent review found one unsliced caller that is a real decision
   path: the in-process swarm teammate compaction gate
   (`src/utils/swarm/inProcessRunner.ts`), which also omitted `currentModel`.
3. **Rough-fallback structural gap** (under-estimation). Pure-rough paths
   (post-compaction, preserved-segment fall-through, openai-anchor
   invalidation) counted messages only — never system prompt, tool schemas, or
   the request-time userContext reminder.
4. **Density miscalibration** (under-estimation, narrower than first claimed).
   The flat 4 chars/token measured *accurate* for TypeScript source
   (4.24-4.32) and conservative for prose (6.11); it undercounts structured
   tool output (grep 3.47, dense JSON 3.07, JSONL 2.86) and badly undercounts
   identifier-saturated output (UUID/SHA JSONL 1.84 — a 2.17x under-factor).
   Measured with o200k_base as a labeled proxy (see §4). The audit's original
   "up to 2x on code/JSON" claim was wrong about code and leaned on
   `bytesPerTokenForFileType`'s `json: 2`, which is a deliberately
   conservative gate value, not a calibration.
5. **Latent: time-based microcompact** (both directions; config-off but
   remotely enableable via `tengu_slate_heron`). It content-cleared old
   tool_results in the request array only: same turn, its savings never
   reached autocompact (stale-high anchor → spurious compaction); next turn,
   the gap trigger doesn't re-fire so full content is re-sent against a
   post-clear (small) anchor → under-count of exactly the cleared amount.
6. **Hardening set:** `getTokenUsage` dropped real usage from any response
   whose first text block exactly matched a synthetic string ("No response
   requested."); four sibling walkers anchored on `{0,0,0,0}` Codex seed
   records after interrupted turns; `/stats` summed input/cache once per split
   record (n× for parallel-tool responses); the Codex adapter could emit
   negative `input_tokens` on a malformed payload (`cached_tokens >
   input_tokens`); the blocking preempt used `options.mainLoopModel` instead
   of the runtime model.

Findings verified as **correct** and left alone: append-only estimation after
an anchor; preserved-segment skip plus resume-time usage zeroing
(`sessionStorage.ts` relink walk); tool-result budget replacement (frozen by
`seenIds`, replayed on resume); claude→gpt switching; rewind/tombstone
(conservative by construction); the Codex adapter's inclusive→exclusive cache
subtraction.

## 3. Context-mutation inventory (as of this session's build)

Live: full/partial/session-memory compaction (compensated via boundary
replacement or `preservedSegment` annotation), tool-result budget
(self-consistent), gpt wire truncation (compensated on switch where
`currentModel` is passed), attachments (estimator and renderer share
`normalizeAttachmentForAPI`), deferred-tool schema growth (one-request lag,
small), resume (usage restored; preserved-range usage zeroed on load).
Compiled out or stubbed: history snip (`snipCompact.ts` returns
`tokensFreed: 0`), context collapse, reactive compact (absent — so a real 413
surfaces as a terminal error; the synthetic blocking preempt is the last line
of defense and runs on this same estimator). Config-off: cached microcompact
(`enabled: false` hard-coded), time-based microcompact (GrowthBook default
off).

## 4. Calibration method

Claude's own `count_tokens` was unreachable from this machine (stored
Anthropic OAuth token revoked; forcing a vault refresh was out of bounds), so
ratios were measured with **o200k_base** via `js-tiktoken` in a scratchpad —
a labeled proxy. Claude's tokenizer is generally no more byte-efficient on
code/JSON, so the under-factors are lower bounds and the corrections safe-side.
The density-escalator threshold (0.65 hex-fraction) was validated against
**18,740 real tool_result payloads** from local transcripts: median 0.271,
p90 0.342, p99 0.570, with an empty band up to the identifier tail — every
inspected payload above 0.65 was genuinely identifier-saturated. A direct
Claude calibration remains a single free API call once a logged-in account
exists.

## 5. What landed

| Commit | Content |
|---|---|
| `e1e8a806` | Codex adapter clamps `input_tokens` at 0; `/stats` dedups splits by `message.id` (input once, output as max); swarm gate passes the current model |
| `9a2356d8` | `tokens.ts` core: all usage walks floor at the last compact boundary and rough fallbacks estimate the post-boundary slice only; sibling content excluded from the slice **only when the anchor has `stop_reason`** (interrupted-stream seeds keep counting it); `NON_MESSAGE_REQUEST_OVERHEAD_TOKENS = 20_000` on pure-rough paths; `getTokenUsage` synthetic text-match dropped (SYNTHETIC_MODEL stamp is sufficient — verified all constructors route through `baseCreateAssistantMessage`); `hasRealUsage` zero-seed guard on all four walkers |
| `e9e161db` | Time-based MC reports `tokensFreed`; query loop combines it with snip savings into `preRequestTokensFreed`, subtracted in the autocompact check and blocking preempt; clearing made **sticky** (cleared tool_use_ids re-apply on every main-thread request; reset with the rest of microcompact state); preempt uses the runtime model |
| `d083428e` | Shape-aware ratios in `tokenEstimation.ts`: tool_result strings + server/MCP catch-all at 3 chars/token; identifier-dense strings escalate to 2 via a bounded 4KB hex-density sample at threshold 0.65; nested text inside tool_result arrays inherits the structured ratio; prose/code/tool_use/thinking stay at 4; `bytesPerTokenForFileType` untouched |
| `3d951201` | Two desktop doc comments (`app/sidecar/runControlsDomain.ts`, `app/renderer/src/tokenWarning.ts`) re-cited from `snipTokensFreed` to `preRequestTokensFreed` |

Implementation was orchestrated: four Opus subagents in two waves batched by
file ownership, plus one follow-up agent for the app comments; the
orchestrator reviewed each diff and committed explicit paths.

## 6. Verification evidence

- Consolidated focused suites at `d083428e`: **144 pass / 0 fail** across
  `tokens.test.ts` (42), `tokenEstimation.test.ts` (11, new),
  `microCompact.test.ts` (new), `autoCompact.test.ts`, `compact.test.ts`,
  `stats.test.ts` (new), `codex-fetch-adapter.test.ts`.
- `bun run build:dev:full`: 0 errors, `./cli-dev` built
  (`2.1.87-dev.20260810.t154813.shad083428e`).
- Key tests mutation-verified: disabling the sibling exclusion reproduces
  exactly the audited +20k phantom; forcing the boundary floor to 0 fails all
  three boundary tests; `STRUCTURED 3→4` fails 5/11 density tests.
- Typecheck: zero new diagnostics in owned files against the known-red
  baseline (`tokens.ts` net −1).
- App battery for `3d951201`: app tsc pass, sidecar wrapper 0 owned
  diagnostics, 21/21 tests, `git diff --check` clean.

Pre-existing, not-ours findings hit during verification:
`analyzeContext.test.ts` mock-pollutes `./tokens.js` process-wide (co-run
failures reproduce at HEAD; file-isolated it passes) — the CLAUDE.md §3
file-isolation caveat in action.

## 7. Open items

- **Sticky-set reset scope:** RESOLVED in a same-day follow-up — the reset
  now sits inside `runPostCompactCleanup`'s main-thread guard and the
  in-process-teammate reset call was removed after tracing that teammates
  (querySource `agent:custom`) can never write microcompact state. Residual:
  the sticky set is process-memory only, so **resume drops stickiness** while
  the resumed anchor still reflects cleared content — a bounded under-count
  window until the next response, deliberately not persisted.
- **Calibration is proxy-based.** Re-run against Claude `count_tokens` (free)
  when an Anthropic login exists; only the escalator threshold and the 3
  chars/token band would plausibly move.
- **Post-audit hardening (same-day follow-ups, second verification pass):**
  a review of the shipped design confirmed and fixed three further issues —
  CJK text was under-counted 3.1x at the flat 4 (now 1.5 chars/token via a
  script-range detector; Cyrillic measured safe and excluded), base64 tool
  results were under-counted 2.05x (now 1.5 via an alphabet/run-length
  detector), and density sampling now takes head/middle/tail windows so a
  long prose header cannot defeat the escalators; the flat 20k overhead was
  demoted to a FLOOR, with the autocompact check and blocking preempt
  supplying a measured value from the real system prompt, context blocks,
  and serialized tool schemas (memoized per tool set). Verified safe as-is:
  the `stop_reason` terminal-sibling signal (single assignment site per
  adapter, atomic with final usage). Confirmed but not code-fixable: the
  compensation-discipline hazard (§7's design rule remains the only guard).
- **`/stats` cache:** days aggregated before `e1e8a806` keep their inflated
  input/cache numbers until the stats cache rebuilds.
- **Behavior change to watch:** tool-result-heavy transcripts now autocompact
  earlier (intended). If it feels premature in real sessions, the constants
  are named and documented in `src/services/tokenEstimation.ts`.
- **Escalator gap (accepted):** identifier-dense payloads arriving as
  tool_result *arrays* get 3, not 2; and a payload whose first 4KB are
  identifier-dense but whose bulk is prose is overestimated by up to 1.5x
  (bounded, pinned by a test).
- **Design rule going forward** (also in the orchestrating session's memory):
  any new mutation that shrinks the rendered request without shrinking the
  stored array must ship with one of the three existing compensation patterns
  — `tokensFreed` threading (snip/MC), anchor invalidation (gpt switch), or
  usage rewriting (resume) — or it recreates this bug class.
