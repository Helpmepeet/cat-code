# Map-consultation diagnosis: do agents actually use `docs/maps/`?

**Date:** 2026-07-14
**Scope:** Diagnosis only — no fix proposed (deliberately). Measures whether
agents consult the `docs/maps/` routing maps before navigating the codebase,
why they do or don't, and whether it matters.

## TL;DR

The headline concern — "subagents almost never consult the navigation maps
(~10× worse than the main thread)" — is **real as a raw number but much smaller
and softer as a problem than it first appears.** Three findings collapse it:

1. **~91% of the "map-less" subagents were pre-routed.** Their parent handed
   them a specific file path in the task, so the routing already happened
   upstream — they didn't need the map. Genuinely unrouted, no-map subagents
   over the whole window: **~8**.
2. **No demonstrable cost.** Map-less subagents search *fewer* times (median 11)
   than map-reading ones (median 31). The "no map → flailing" hypothesis is
   refuted; search volume tracks task size, not map usage.
3. **The dominant subagent type (general-purpose, ~80%) does receive the map
   instruction** via CLAUDE.md and still mostly doesn't consult — but that is
   the same known "ambient CLAUDE.md is a weak trigger" issue, not a missing
   channel. Only the Explore agent (~9% of spawns) is map-blind *by design*.

When maps *are* consulted, they are used well (read early, followed through to
sub-maps). The one clean, uncontested defect found — WORKSPACE_MAP.md not
referencing its own folder path — is already fixed (commit `3fff7be`).

## Method

- **Window:** 2026-07-12 (the `map-routing-nudge` hook was added) → 2026-07-14
  (~2 days). Absolute counts drift by a few between measurements because
  subagent transcripts accumulate live during the analysis; ratios are stable.
- **Two runtimes:** transcripts under both
  `~/.claude/projects/-Users-pt-cat-code/` and
  `~/.cat-code/projects/-Users-pt-cat-code/`. Subagent transcripts live under
  `<session>/subagents/agent-*.jsonl`.
- **"Search"** = a `Grep`/`Glob` tool call, or a `Bash` call running `rg`/`grep`.
- **"Read a map"** = a `tool_use` referencing `docs/maps/` (WORKSPACE_MAP or any
  sub-map).
- **Subagent type** is not stored in the subagent transcript; it was recovered
  from the parent's `Agent`/`Task` `tool_use.subagent_type`.

## Finding 1 — The funnel

| Population | Total | Searched (2+) | Read maps folder | Read WORKSPACE_MAP | Read a sub-map |
|---|---|---|---|---|---|
| Main sessions | 63 | 28 | 19 | 16 | 16 |
| Subagents | ~116 | 103 | 16 | 9 | 15 |
| **Combined** | **~179** | **131** | **35** | **25** | **31** |

As rates:

- **Main** — of 28 searchers, ~68% opened a map, ~57% opened WORKSPACE_MAP.
- **Subagents** — of 103 searchers, only ~16% opened any map, ~9% opened
  WORKSPACE_MAP. Subagents are ~64% of all sessions and ~79% of all searching,
  but only ~46% of map reads.

Taken alone this reads as a large subagent gap. Findings 2–4 explain most of it
away.

## Finding 2 — Where the map instruction lives, and who receives it

The "read the map first" instruction exists in exactly one place: **CLAUDE.md
§2** ("Non-trivial bug/feature/question → open `docs/maps/WORKSPACE_MAP.md`
first, follow its routing table to the owner files"). **No built-in agent prompt
references `docs/maps` at all** (grep over `src/tools/AgentTool/built-in/`
returns nothing). So an agent gets the instruction only if it loads CLAUDE.md.

Subagent type distribution (from parent spawn calls, n≈96):

| Type | Spawns | Loads CLAUDE.md? |
|---|---|---|
| general-purpose | 77 | **Yes** |
| Explore | 9 | **No — by design** |
| Plan | 4 | On demand (can `Read` it) |
| verification | 3 | Yes |
| implementor | 2 | Yes |
| claude-code-guide | 1 | Yes |

Source-confirmed, cat-code (not inferred from upstream docs):

- `src/tools/AgentTool/built-in/exploreAgent.ts:114` sets `omitClaudeMd: true`.
- `src/tools/AgentTool/runAgent.ts:455-468` drops `claudeMd` from the agent's
  user context when `omitClaudeMd` is set, gated by feature flag
  `tengu_slim_subagent_claudemd` (default on). Rationale in-comment: *"Dropping
  claudeMd here saves ~5-15 Gtok/week across 34M+ Explore spawns."*
- `src/tools/AgentTool/loadAgentsDir.ts:128-132` documents the flag; **only
  Explore sets it** — general-purpose/verification/implementor keep CLAUDE.md.
- `src/tools/AgentTool/built-in/planAgent.ts:143`: Plan is read-only and "can
  Read CLAUDE.md directly if it needs conventions."

**Consequence:** the original hypothesis ("subagents don't consult maps because
they never get the instruction") is only true for Explore (~9% of spawns). The
dominant type — general-purpose (~80%) — *does* receive CLAUDE.md §2 and still
mostly doesn't consult. That is the pre-existing "ambient CLAUDE.md is a weak
trigger at the decision point" problem, not a missing channel.

## Finding 3 — Most "map-less" subagents were already routed (the reframe)

Of the **87** subagents that searched 2+ times without reading a map, the task
their parent gave them:

- **79 (91%)** named a concrete source file path (e.g.
  `src/tools/AgentTool/agentToolUtils.ts`) → the parent had already located the
  target; the subagent was dispatched to execute, not to navigate.
- **8 (9%)** contained no specific path → genuinely could have benefited from
  the map.

This is the intended division of labor. The Explore design states it explicitly
(`exploreAgent.ts`: *"the main agent has full context and interprets their
output"*): the parent — which holds CLAUDE.md and the map, and consults it ~63%
of the time when searching — does the routing; the subagent runs the scoped
task. A subagent not re-deriving the map in that case is correct behavior, not a
miss.

**Net addressable population:** ~8 unrouted, no-map subagents + a handful of
main sessions over the two-day window — not 87.

*Caveat:* "named a file path" is a heuristic for "pre-routed." It could
over-count if a path appears incidentally. The regex required a concrete file
with an extension (not a bare directory), and the 91% signal is large enough to
survive noise, but this is correlation, not proof of intent.

## Finding 4 — No demonstrable cost

If skipping the map caused flailing, map-less subagents should search *more*.
They search *less*:

| Subagents (searched 2+) | n | mean searches | median | max |
|---|---|---|---|---|
| **Without** a map read | 87 | 22.1 | 11 | 209 |
| **With** a map read | 18 | 33.5 | 31 | 86 |

Search volume is dominated by task size (thorough general-purpose audits both
read maps and search a lot; quick scoped tasks do neither), so this comparison
cannot isolate a map effect — but it clearly **refutes the naive "no map →
more searching" cost story.** Whether non-consultation hurts *accuracy* (wrong
files, worse answers) is unmeasured and not isolable from these transcripts.

## Finding 5 — When maps are consulted, they are used well

Among transcripts that read a map:

- **Router-first** (map read before ≤1 search): main 14/19 (74%), subagents
  10/16 (63%). Maps are read early, as the router they are meant to be — not
  opened as an afterthought.
- **Follow-through** from WORKSPACE_MAP to a sub-map: main 13/16 (81%),
  subagents 8/9 (89%). The router successfully hands off to detailed maps.

So the map content and structure are effective. The efficacy loss is entirely
front-door (non-consultation), not read-but-ignored.

## Finding 6 — The `map-routing-nudge` hook's structural limits

The PreToolUse hook (`.claude/settings.local.json:109-119`) that reminds agents
to read the map is **main-thread only**, by construction:

- The PreToolUse hook input carries no `agent_transcript_path` — that field
  exists only on `SubagentStopHookInputSchema`
  (`src/entrypoints/sdk/coreSchemas.ts:556`), never PreToolUse
  (`src/utils/hooks.ts:3418-3424`).
- `createBaseHookInput` (`src/utils/hooks.ts:301-327`) sets `transcript_path`
  to the **main** session's transcript, so when a subagent searches, the hook
  reads the main session's history and counts the main session's searches.
- State is keyed by the main `session_id`, so the once-per-session claim also
  suppresses subagent-triggered evaluations.

Empirically consistent: across all firings the log shows `kind=main` only; zero
subagent firings. (The hook *does* deliver its `additionalContext` into the
running query when it fires — `src/services/tools/toolHooks.ts:566` →
`src/services/tools/toolExecution.ts:859-860` — so injection works; only
subagent *detection* is structurally impossible.) It is also a soft nudge
(`additionalContext`), not an enforcement block, so it is as ignorable as the
CLAUDE.md instruction it echoes.

Given Findings 3–4, this limit matters less than it first seemed: the subagents
the hook can't reach are mostly pre-routed and show no measurable cost.

## Already actioned

- **WORKSPACE_MAP.md did not reference its own folder.** All 17 sub-maps were
  linked by bare filename (`codex-core.md`), never `docs/maps/codex-core.md`.
  Fixed so every reference shows the full repo-root-relative path in the label
  (link targets kept relative so rendered links resolve). Committed as
  **`3fff7be`** on the `migration` branch. This was the single clean,
  uncontested defect; the ~85% follow-through above shows it wasn't blocking
  navigation, but it removes an inference step.

## Methodology notes — tests run and discarded

Two measurements produced misleading numbers and were dropped; recording them so
the same traps aren't re-hit:

1. **"Sub-map read" counter** initially reported values larger than the total
   map-folder-read count (impossible). Cause: a `grep -qv` empty-input edge
   case. Recomputed with an explicit non-empty check.
2. **"Does the subagent context contain CLAUDE.md §2?"** grepped transcripts for
   the §2 phrase and found 0/118 subagents — but also **1/63 main sessions**,
   which is impossible if it measured context membership (all main sessions load
   CLAUDE.md). Distinctive CLAUDE.md phrases appear in ~0 transcripts, i.e.
   **CLAUDE.md is not persisted verbatim in transcript JSONL.** The test cannot
   measure context membership and was discarded; the "who loads CLAUDE.md" claim
   in Finding 2 rests on source, not this grep.

## Open questions (unmeasured)

- **Does non-consultation ever cost accuracy?** Search-count shows no cost, but
  going to the wrong files / producing worse answers is not measurable from
  these transcripts. This is the real unknown behind the whole question.
- **Why do general-purpose subagents (which have CLAUDE.md §2) consult even less
  than the main thread?** Hypotheses: parents pre-route them (supported by
  Finding 3); scoped tasks don't read as "non-trivial navigation" to the
  subagent; speed-optimized behavior. Not distinguished here.
- **Type split of the map-less population is approximate.** Subagent type isn't
  in the subagent transcript; the distribution in Finding 2 is from parent spawn
  calls (n≈96) and doesn't per-row label the 87 map-less subagents.
- **Two-day window.** Stable within it, but not a long baseline.
