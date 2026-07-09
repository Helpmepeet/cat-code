# Context-growth pipeline audit: cat-code Codex path vs Codex CLI (2026-07-06)

**Question:** why does cat-code's context grow per turn noticeably faster than
Codex CLI for similar work? Usage accounting is confirmed accurate
(`src/services/api/codex-fetch-adapter.ts:2473` maps OpenAI usage with input
exclusive of cached), so the growth is real request content.

**Method:** traced the full request assembly path
(`QueryEngine.ts` → `query.ts` → `instructionAssembly.ts` → `claude.ts` →
`codex-fetch-adapter.ts` / `codex-websocket-transport.ts`), then compared
against openai/codex source (shallow clone of `openai/codex@main`, 2026-07-06:
`codex-rs/core/src/context_manager/history.rs`, `client.rs`,
`models-manager/models.json`), and validated empirically — first in depth
against two recent gpt-5.5 transcripts (`c487c2ae`, `f5f183a0`), then broadened
to **all 20 gpt sessions with ≥10 usage-bearing calls across both projects**
(see "Cross-session validation" below). No code changed.

## TL;DR

The per-turn **slope** divergence is dominated by tool-result volume — mostly
the Read tool's whole-file default with no record-time truncation — plus a
~2× **fixed** request overhead (≈22k tokens of instructions+tools vs codex's
≈9–11k). Encrypted-reasoning replay, the other big byte bucket, is **parity**
with Codex CLI, not a bug. System-reminder/attachment spam, the obvious
suspect, is empirically small on the gpt path today.

**Second-pass addendum (see "Pressure test" section below):** the slope
analysis above holds, but it missed the largest *cost* bucket — mid-session
warm-cache busts (~3.1% of warm calls, ≈19% of all uncached gpt input
re-billed), and the pruning stack described in D2 is even thinner than
stated: on this build, autocompact is the *only* live pruning mechanism on
the Codex path.

## What each request contains (verified assembly)

For `provider === 'openai'`, `buildProviderInstructionAssembly()`
(`src/services/api/instructionAssembly.ts:38-73`) produces:

- `instructions` = system prompt (GPT style, `src/constants/promptStyles/gpt.ts`)
  + stable systemContext + all userContext (CLAUDE.mds, MEMORY.md index,
  currentDate) (`instructionAssembly.ts:80-84`).
- a `developer` message with volatile keys (gitStatus, cacheBreaker)
  unshifted to `input[0]` on **every** request
  (`codex-fetch-adapter.ts:881-892`).
- `input` = the full Anthropic-shaped transcript translated by
  `translateMessages()` (`codex-fetch-adapter.ts:667-851`): user/assistant
  text, `function_call`/`function_call_output` pairs, and prior-turn
  encrypted reasoning replayed as `reasoning` items
  (`codex-fetch-adapter.ts:803-810`).

API-time Anthropic prefixes (attribution header, CLI prefix) do **not** reach
the Codex path — `_openaiInstructionAssembly.instructions` is passed through
unchanged (`claude.ts:1657-1670`). No double-send of claudeMd was found (it's
in instructions only; `prependUserContext` runs only on the non-OpenAI branch,
`instructionAssembly.ts:68-72`).

## Divergences

### D1 — Fixed request baseline is ~2× Codex CLI (~+11k tokens, constant)

Measured: cat-code's instructions+tools prefix is **≈22k tokens** (session
`c487c2ae`: startup prewarm produced `cached=22,016` on the first real call;
session `f5f183a0` first call total 21,998 with only a user prompt in input).

Codex CLI equivalent: gpt-5.5 `base_instructions` is 21,459 bytes ≈ **5.4k
tokens** (`codex-rs/models-manager/models.json`), plus a ~5-tool lean toolset
(~2–3k), AGENTS.md and one environment_context item — **≈9–11k total**.

Cat-code's extra ≈11k comes from: the full Claude-Code tool schema set
translated verbatim (`translateTools`, `codex-fetch-adapter.ts:591-623`; long
prose descriptions on Bash/Agent/Artifact etc.), the GPT prompt style, and
user+project CLAUDE.md + memory index folded into instructions.

- **Per-turn cost:** none while cached; **+11k billed uncached on every cold
  turn** (account rotation, model switch, restart, cache TTL — see G2 in
  `docs/research/2026-06-05-codex-cache-deep-dive.md`), and permanently
  occupies ~4% of the 272k window.
- **Control measurement (Claude path, same harness):** first-call totals on
  Claude-model sessions run **28–41k tokens** (Fable ≈28–31k, Sonnet ≈39–41k;
  12 recent sessions sampled) vs ≈20–22k on the gpt path. So the codex
  adapter's prefix is *leaner* than the harness's own Claude path — the
  overhead is inherited harness weight (tool schemas, CLAUDE.mds, memory
  index), not something the codex path added. The 2× figure vs Codex CLI
  explains the observed cost gap against that client; it is not evidence of a
  cat-code defect.
- **Classification:** intentional Claude-Code inheritance (richer toolset is
  the product), but the tool-description prose is a real, shrinkable cost.

### D2 — Read tool: whole-file default, no record-time truncation (the main slope divergence)

Observed (session `c487c2ae`, read-heavy audit work): 606KB of tool_result
bytes over 21 usage-bearing calls ≈ **29KB (~7k tokens) per API call**;
`Read` alone was 424KB/39 calls (max single result 32KB), `Grep` 182KB/32
(max 20KB).

Codex CLI for the same work:

- **Every** recorded tool output is middle-truncated to the model's
  truncation policy at history-record time —
  `record_items()`/`process_item()` →
  `truncate_function_output_payload(output, policy × 1.2)`
  (`codex-rs/core/src/context_manager/history.rs:121-135, 370-395, 463-480`).
  Policy for gpt-5.5/5.4/5.4-mini/5.3-codex: **Tokens(10,000)**
  (`models-manager/models.json`).
- Live exec output is capped at min(max_output_tokens, policy) =
  **10,000 tokens** (`codex-rs/core/src/unified_exec/mod.rs:70`,
  `tools/context.rs:404`).
- Reads happen via `shell` (`sed -n`/`rg`-style slices), which naturally
  returns targeted chunks rather than whole files.

Cat-code caps on the same surfaces:

- Read: 2000 lines / **0.25MB** (~64k tokens possible)
  (`src/tools/FileReadTool/prompt.ts:10`, `src/utils/file.ts:48`), plus
  `cat -n` line-number framing (~6-8 bytes/line, ~10-15% overhead on code).
- Bash: 30,000 chars (`src/utils/shell/outputLimits.ts:4`) — comparable to
  codex, fine.
- Grep: default head_limit 250 (`src/tools/GrepTool/GrepTool.ts:108`) — fine
  (added precisely to stop this class of bloat).
- **No eager truncation at record time on the codex path.** Pruning is
  reactive only: tool-result budget (`src/query.ts:407`), snip, microcompact,
  context collapse, autocompact — all gated on nearing limits. Codex truncates
  every output eagerly *and* auto-compacts at ~90% of window; between
  compaction events cat-code's history is structurally fatter.

- **Per-turn cost:** the dominant growth term. Individual observed reads
  (4.5–8k tokens) sit under codex's 10k cap, so the eager-truncation gap is a
  tail-risk (a single 0.25MB Read = ~64k tokens; codex would record ≤12k).
  The everyday delta is behavioral: whole-file Read defaults vs codex's
  targeted shell slices — estimate **1.5–2× tool-result bytes for similar
  exploratory work**.
- **Classification:** intentional Claude-Code inheritance (tool design). The
  missing record-time cap for the Codex path is a defensible gap on the
  Anthropic path (caching makes it cheap) but a genuine cost on Codex, where
  every cold turn re-bills the whole fat history.

### D3 — Encrypted reasoning replay: PARITY, not a divergence (do not chase)

Cat-code replays every prior-turn reasoning item as
`{type:'reasoning', summary:[], encrypted_content}`
(`codex-fetch-adapter.ts:803-810`) and requests
`include=['reasoning.encrypted_content']` whenever reasoning is set
(`codex-fetch-adapter.ts:1000`). Measured volume: 98KB of signatures in
`c487c2ae` (~4.7KB/call), 287KB in `f5f183a0` — i.e. roughly **0.5–2k
tokens/call of growth**.

Codex CLI does exactly the same: reasoning items are `is_api_message` and are
retained in history (`history.rs:497-505`), and
`include=["reasoning.encrypted_content"]` is sent whenever reasoning is on
(`codex-rs/core/src/client.rs:852-853`). Summaries are not replayed by either
client (cat-code sends `summary: []`; summary text stays local).

One nuance: the server can signal `ServerReasoningIncluded`
(`codex-rs/core/src/session/turn.rs:2199-2201`) and codex adjusts its local
context *estimate* for prior-turn reasoning the server drops
(`history.rs:293-312, 327-346`). This affects the **gauge**, not what's sent.
If eyeballing codex's context meter vs cat-code's, part of the perceived gap
can be this display accounting, not request content.

### D4 — Per-request re-sends Codex CLI doesn't do (small, constant)

1. **gitStatus developer message every request**
   (`instructionAssembly.ts:23, 87-98` + `codex-fetch-adapter.ts:881-892`):
   ~100–600 tokens per request depending on repo state (truncated at 2k chars,
   `src/context.ts:20,116-120`). Codex sends `environment_context` **once** as
   a persisted history item. Memoized per process (`context.ts:36,147`), so
   it's cache-stable within a session — but it sits at `input[0]`, so any
   change across restart/resume invalidates the entire input prefix cache.
   Classification: cat-code design choice (deliberate volatile/stable split);
   cost is constant, the cache positioning is the sharper edge.
2. **`<available-deferred-tools>` ephemeral prepend every request** when the
   delta attachment flag is off (`claude.ts:1418-1432`;
   flag = `USER_TYPE==='ant' || tengu_glacier_2xr`,
   `src/utils/toolSearch.ts:629-634`): ~0.3–1k tokens/request, and the code
   comment itself notes it busts cache when the pool changes. Classification:
   Claude-Code inheritance with a known fix (delta attachment) behind a flag.

### D5 — Attachments / system-reminders: smaller than expected on the gpt path

The full per-turn battery (`src/utils/attachments.ts:744-1004`: changed_files,
todo/task reminders, memories, skill listings, diagnostics, token_usage, etc.)
persists as user messages and is re-sent every subsequent request. Codex's
analogue (`codex-rs/core/src/context/*`) is a handful of tiny developer
fragments (current-time reminder is one sentence).

Empirically, recent gpt-5.5 sessions show only 1–9 meta/reminder messages per
session; the dominant items are **skill invocations injecting full SKILL.md
content (4.5–11KB each, permanent for the session)** — e.g. 8 skill injections
= 59KB in `f5f183a0`. `changed_files` injects diff snippets only
(`attachments.ts:2106-2122`), not whole files.

- **Per-turn cost:** <100 tokens/call averaged, +1–3k tokens per skill
  invocation. Higher in interactive, edit-heavy, plan-mode, or task-using
  sessions (each reminder occurrence is permanent history).
- **Classification:** intentional inheritance; not the current growth driver.

### D6 — Startup prewarm request (one-time, working as designed)

`schedulePrewarm()` sends one request per conversation with `input: []`
(`src/services/api/codex-websocket-transport.ts:391-441`) — bills the ~22k
instructions+tools prefix once (uncached the first time), in exchange for the
first real call landing warm (confirmed: first call in `c487c2ae` read 22,016
cached). Codex CLI has no equivalent. Net cost ≈ one extra cold prefix per
conversation; net win on any session with ≥1 real turn. Not a bug.

### D7 — Things checked and cleared

- `store: false`, `prompt_cache_key`/conversation-id stamping: unchanged from
  prior investigation; not growth-related.
- Usage mapping (`codex-fetch-adapter.ts:2461-2483`): input exclusive of
  cached, creation always 0 — accurate per the brief.
- `system`-type transcript rows, file-history snapshots, progress rows: never
  sent to the API.
- No duplicate claudeMd (instructions only), no orphaned tool results
  (skipped-tool filtering, `codex-fetch-adapter.ts:754-761`), StructuredOutput
  stripped from history (`:825-828`).
- WebSocket incremental continuation only changes transport bytes, not billed
  context.

## Cross-session validation (20 sessions)

To rule out single-session bias, the composition analysis was re-run over
every gpt session with ≥10 usage-bearing API calls under
`~/.cat-code/projects/` (20 sessions, 50–144 calls each, two different
projects). Results are uniform:

- **First-call total is 18–22k tokens in every session** — confirms the fixed
  instructions+tools prefix estimate (D1) independent of workload.
- **Median per-call context growth: 0.5–2.4k tokens.**
- **Transcript byte composition** (share of API-sent content):
  tool_result 40–72% (median ≈57%), reasoning signatures 13–31%,
  tool args 4–25%, user text 5–34%, assistant text 2–11%.
- **System-reminder content did not reach the top-5 bucket in any session**
  (<~2% everywhere) — D5 confirmed negligible on the gpt path.
- No session showed an anomalous composition (e.g. growth on idle turns or a
  dominant reminder bucket) that would indicate a hidden defect.

Representative rows (session, calls, first→last total, median Δ/call, top buckets):

| session | calls | first → last | med Δ | composition |
|---|---|---|---|---|
| 9962367c | 144 | 22,024 → 57,036 | 710 | tool_result 52% · reasoning 18% · args 16% |
| f0559c9b (pt2nd) | 117 | 18,122 → 157,012 | 763 | tool_result 39% · reasoning 31% · args 17% |
| 0a653235 | 92 | 19,492 → 184,649 | 1,408 | tool_result 61% · reasoning 18% |
| c41aee46 | 64 | 19,576 → 227,917 | 983 | tool_result 72% · reasoning 15% |
| c6631670 | 56 | 19,318 → 136,204 | 1,450 | user_text 34% · tool_result 29% · reasoning 20% |

Note: the broader sample shows reasoning replay running higher than the
two-session estimate in places (up to 31% of bytes) — still parity with Codex
CLI (D3), but a larger share of the slope than initially stated.

## Per-turn cost summary

| Divergence | Per-turn cost (gpt-5.5, observed) | Verdict |
|---|---|---|
| D2 Read/Grep result volume | ~2–7k tok/API call; 1.5–2× codex for similar work; tail risk 64k/single Read | Inheritance + real gap (no record-time cap on Codex path) |
| D3 Reasoning replay | 0.5–2k tok/call | **Parity with Codex CLI** — not actionable |
| D5 Reminders/skills | <100 tok/call avg; +1–3k per skill invocation | Inheritance, bounded today |
| D4 gitStatus dev msg + deferred-tools block | 0.4–1.6k tok/request, constant | Design choice / flagged fix exists |
| D1 Fixed prefix | 0 warm; +11k on every cold turn; −11k usable window | Inheritance; tool prose shrinkable |
| D6 Prewarm | one-time ~22k/conversation | Working as designed |

## If action is wanted (not done in this pass)

1. Biggest lever for the slope: eager record-time truncation of tool results
   on the Codex path, mirroring codex's Tokens(10k)×1.2 middle-truncate — or
   at minimum drop Read's effective cap toward ~10k tokens for gpt models.
2. Biggest lever for cold-turn cost: trim tool-schema prose sent to Codex
   (D1) — codex models were never tuned on those long descriptions anyway.
3. Cheap: enable the deferred-tools delta attachment path (D4.2) outside
   ant builds.

## Pressure test + extended evidence (2026-07-06, second pass)

Second pass re-verified every divergence against source and extended the
empirical base from transcripts to the **debug logs**
(`~/.cat-code/debug/*.txt`, 776 files, 120 gpt-bearing; the
`[codex-cache] request … instructions=…B hash=… messages=… effort=…`,
`[codex-cache] owner=… account=… conversation=… cached=… input=…`, and
`[codex-ws] full send/incremental …` lines allow per-request correlation of
cache outcome with account, conversation, instructions hash, effort, tool
pool, and transport send mode). Corpus: 14,912 gpt calls, 971M input tokens,
101.9M uncached (10.5%).

### Confirmed

- Assembly path, volatile-key split, and passthrough (no Anthropic prefixes,
  no claudeMd double-send) — all as described. `cacheBreaker` is ant-only
  (`feature('BREAK_CACHE_COMMAND')`, not in the dev-full set), so the
  developer message is gitStatus-only on this install.
- D1 magnitude: instructions measure 44,493B (~11k tokens) in live logs;
  with tools ≈22k first-call total, matching the estimate.
- D3 reasoning-replay parity and D6 prewarm — code- and log-confirmed
  (first real call reads `cached=22,016`).
- Usage mapping (exclusive input) — confirmed at the message_delta emit.

### Corrections

- **C1 — D2 understated: autocompact is the ONLY live pruning layer on this
  build's Codex path.** The five "reactive" mechanisms listed in D2 mostly
  don't exist here: the tool-result budget gates on GrowthBook
  `tengu_hawthorn_steeple` (default false → `contentReplacementState`
  undefined → no-op); `HISTORY_SNIP`, `CONTEXT_COLLAPSE`, and
  `REACTIVE_COMPACT` are compile-time `bun:bundle` features **not** in the
  `dev-full` set (`scripts/build.ts:13-50`); microcompact is hard-off —
  `DEFAULT_CACHED_MC_CONFIG.enabled: false` with Claude-only
  `supportedModels` (`cachedMCConfig.ts:9-13`), and the legacy
  (non-cache-editing) microcompact path was deleted outright
  (`microCompact.ts:288-292`). Debug logs confirm per request:
  `Cached MC gate: enabled=false modelSupported=false model=gpt-5.5`.
  Between session start and the autocompact cliff
  (`threshold=228,840` of `effectiveWindow=252,000` per live logs), nothing
  trims history.
- **C2 — window numbers:** live autocompact math uses effectiveWindow
  252,000 for gpt-5.5, not the raw 272k input cap cited in D1.

### N1 — Mid-session warm-cache busts: the missing cost bucket (largest finding)

The report modeled cold turns as restart/rotation/TTL events. Empirically,
**warm conversations bust constantly**: among same-account, same-conversation
calls with >30k prior context and <10min gap, **3.1% arrive with
`cached` below half the prior total** (280 events). Excess uncached input
(beyond normal turn growth) attributable to busts: **≈22.1M tokens = 21.7%
of ALL uncached gpt input**, split:

- warm busts (no account switch, no TTL gap): **19.1M tokens**
- TTL gaps >10min: 2.4M — expected, parity with any client
- account switches (G2 failover): 0.7M — smaller than assumed

Cause attribution for the warm busts (per-request hash/effort/tool-count
correlation):

- **Not** instructions changes (hash stable in 237/280), **not** account
  rotation, **not** tool-pool changes (`Dynamic tool loading: N/M` changed in
  only 3 busts, incl. the one ToolSearch case).
- **Client-caused subclasses identified:** `/effort` switches mid-session —
  **5/5 observed at >30k ctx produced a full `cached=0` bust** (the server
  evidently keys the cache on reasoning effort); Skill invocations (11–16
  busts, partial signature `cached≈18–36k` = instructions+tools survive,
  input transcript diverges near its head — mechanism unconfirmed);
  message-count *shrinkage* between consecutive calls (6 busts, e.g.
  125→88 — some history restructure; unexplained, follow-up below).
- **The bulk (~236 events) is mode-independent** — bust rate is identical
  (3.1%) after WS-incremental sends (which are `previous_response_id`-anchored
  and byte-stable) and after full sends. The parsimonious explanation is
  **server-side prompt-cache eviction** (observed pattern: WARM 98.5% →
  COLD 0% 16s later → WARM 99.2% 6s after that, same conversation/account).
- **Divergence framing:** eviction itself is presumably parity with Codex
  CLI, but the *cost per miss* is not — cat-code re-bills a ≈22k prefix plus
  an untrimmed history (C1), i.e. each eviction costs roughly 2× what the
  same event costs codex. The heavy same-account side-query/subagent traffic
  cat-code generates (title gen, summaries, subagents each with their own
  prompt_cache_key) may also raise eviction pressure; not proven here.

### N2 — Round-trip translation instability defeats the incremental transport (defect, cheap fix)

The WS transport only sends an incremental delta when the freshly-translated
input byte-matches what the server recorded last turn
(`codex-websocket-transport.ts:559-618`). Corpus-wide send-mode counts:
**7,747 incremental vs 6,553 full sends**, of which 1,926 are legitimate
first-sends ("no prior response_id"). The rest are drift-forced downgrades:

- **`message_content_drift len_delta=-14` — 3,648 of 3,650 drift cases, 100%
  systematic.** `,"logprobs":[]` is exactly 14 bytes: the server's
  `output_text` content part carries a `logprobs` field, while the
  reconstruction emits only `{type, text, annotations: []}`
  (`codex-fetch-adapter.ts:813-818`). Every turn whose previous output
  contained assistant text falls back to full send.
- **`type_mismatch baseline=custom_tool_call current=function_call` — 378
  cases:** Apply_patch is recorded by the server as `custom_tool_call`, but
  on replay `translateMessages` emits `custom_tool_call` only when the stored
  `tool_use.input` is still a string (`codex-fetch-adapter.ts:830-836`);
  the transcript evidently stores it parsed → re-emitted as `function_call`.
- **`tool_input_drift` — 541 cases:** re-serialized `arguments` JSON differs
  from what was originally sent.

Net: **~46% of continuation-eligible turns lose incremental continuation.**
Direct cost is transport bytes/latency and retry churn, not billed tokens
(bust rate is the same 3.1% either way) — but it halves the coverage of the
one mechanism that is *immune* to byte-level prefix instability. Fix:
normalize recorded output items and replayed items to one canonical shape
(strip/add `logprobs`, preserve Apply_patch input as string, canonicalize
argument serialization once at record time).

### Investigation round 3 (2026-07-06 evening): bust causes narrowed

Follow-up pass to raise confidence on N1's attribution. Method: correlated
every warm bust against WS connection lifecycle events, lease owner changes,
cross-session temporal clustering, and prewarm activity in the debug logs.

**R1 — WS reconnects are a major, mechanistic bust cause (~35% of warm
busts).** Calls with a `[codex-ws]` connection event (connected/onclose/
reconnecting/session cleared) between them and the previous call bust at
**10.4–11.5% vs 2.2–2.7% without — a 4–5× risk ratio** (same-conversation
socket events: 49/428 = 11.45%; any socket event in process: 99/949 =
10.4%). Interpretation: OpenAI's prefix cache is node-local with sticky
routing; a new WS connection can land on a different backend node where the
cache for this conversation simply doesn't exist, regardless of request
bytes. This reframes much of the "eviction" bucket as **connection-affinity
loss** — still server-side, but with client levers (connection longevity,
fewer session recreations).

**R2 — Prewarm is not "one-time per conversation" (D6 correction).**
1,680 prewarm requests across the corpus; per-conversation counts reach 42,
102, and **156** (≈ one per turn — the WS session was evidently recreated
constantly in those sessions). Prewarm-adjacent usage lines show ~82% of
prewarms billing fully cold, and of prewarms followed by a real call within
120s, only **61% delivered a warm first call; 16% were followed by a fully
COLD real call anyway** (double-billed prefix). Adjacency-based attribution
has error bars (concurrent calls can interleave), so treat the token totals
as order-of-magnitude: prewarm-attributable uncached input is **≈10M
tokens**, a further ~10% of all uncached gpt spend, on requests that produce
no output. D6's "working as designed / net win" verdict does not survive:
the win case exists, but re-fire frequency and the 39% miss rate make it a
cost center in practice.

**R3 — Exonerated:** lease-owner flips (bust rate 0.48% on flips vs 3.41%
stable — safe); fleet-wide incidents (only 8% of busts cluster within 180s
across sessions); Skill *content* (case study: all pre-existing items
byte-matched at the bust — the skill correlation is real but indirect,
plausibly via turn shape/connection churn); tool-pool mutation (3 busts
total).

**R4 — Downgraded to unreliable:** the EFFORT-switch (5) and MSG_SHRINK (6)
subclasses from the first pass. The request-meta pairing that produced them
mixes interleaved conversations in one debug file; message-count sequences
in those files show normal multi-conversation interleaving, not history
shrinkage. Effort-switch busting remains plausible (mechanism: server cache
keyed on reasoning params) but is **unconfirmed** pending a clean test.

**R5 — Residual:** ~2.2–2.7% of warm calls bust with *no* logged connection
event, no account/conversation/instructions change, and no gap. Bust rate
*decreases* with context size (5.2% under 50k vs 1.2% at 200k+), which is
inconsistent with capacity eviction of large prefixes and consistent with
early-session connection churn plus per-node cache misses. Settling the
residual requires the controlled live probe (byte-frozen client, fixed
context, ~60s cadence) — not run; it burns real quota.

**R6 — openai/codex source claims independently re-verified** (fresh shallow
clone, HEAD `be33f80bc65` 2026-07-05; subagent audit). All of D2/D3/D6's
upstream citations check out: record-time middle-truncate ×1.2 in
`record_items()` (scope nuance: covers FunctionCallOutput +
CustomToolCallOutput only — messages/web-search/tool-search items are not
truncated); Tokens(10,000) policy and 272k window for gpt-5.5/5.4/5.4-mini/
5.3-codex; base_instructions exactly 21,459B (~5.4k tokens); live exec cap
10k; auto-compact at 90% (~244.8k); reasoning retained + encrypted-content
include; ~5 default tools (shell_command, update_plan, apply_patch,
view_image, hosted web_search); environment_context recorded once
(re-transmitted in replayed history but byte-stable). Two additions:
**(a)** codex-rs has *no* cache-miss detection or recovery either — it
optimizes prefix stability (stable keys, stable synthetic IDs) and merely
records `cached_tokens`; there is no acknowledgment anywhere that
cached_tokens can drop mid-conversation. Evictions presumably hit Codex CLI
users too; they just cost ~10× less against a lean history. **(b)** codex-rs
protocol types have **no `logprobs` or `annotations` fields** on output
text; unknown fields deserialize and are silently dropped, never
re-serialized. That upstream-validates N2's fix: stripping `logprobs` (and
normalizing content-part shape) in `normalizeCompletedOutputItem` mirrors
exactly what the native client does, so the server demonstrably tolerates
replayed output items without those fields.

### Updated action list

1. *(unchanged, slope)* record-time truncation of tool results on the Codex
   path — now more urgent given C1: there is literally nothing else pruning
   history before 228k.
2. *(unchanged, cold cost)* trim tool-schema prose for Codex requests.
3. **New:** fix N2's three round-trip drifts — restores incremental sends to
   ~90%+ of turns. The logprobs strip is upstream-validated safe (R6b).
4. **New (R1):** WS connection longevity — investigate why sessions get
   recreated so often (some conversations show ~1 prewarm per turn, R2);
   every new connection carries a 4–5× bust risk on the next call.
5. **New (R2):** rate-limit or gate prewarm re-fires — it is not one-time in
   practice and ~39% of followed-up prewarms fail to deliver a warm first
   call anyway.
6. **Downgraded from first pass:** the `/effort`-switch and message-shrink
   subclasses are unconfirmed (R4) — retest cleanly before acting on them.
7. **Open:** the residual ~2.2% bust rate needs the controlled live probe
   (R5) if we want certainty; otherwise accept it as server-side and focus
   on shrinking the per-miss cost (items 1–2).

---

Sessions measured in depth: `~/.cat-code/projects/-Users-pt-cat-code/{c487c2ae-…, f5f183a0-…, 8011e696-…}.jsonl`;
cross-validated against all 20 gpt sessions with ≥10 calls under `~/.cat-code/projects/` (2026-07-06).
Second pass additionally used `~/.cat-code/debug/*.txt` (14,912 gpt calls) — grep keys:
`[codex-cache] request`, `[codex-cache] owner=`, `[codex-ws] full send`, `Dynamic tool loading`, `Cached MC gate`.
Codex reference: `openai/codex` @ main 2026-07-06 (shallow clone; paths cited above).
