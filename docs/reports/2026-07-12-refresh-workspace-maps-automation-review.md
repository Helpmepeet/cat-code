# Review: `refresh-workspace-routing-map` automation — prompt vs. actual output

Date: 2026-07-12
Reviewed by: Claude (Fable 5), from the automation config, its memory file, the two most
recent run transcripts, git history/reflog, and source spot-checks.

## Verdict

The prompt is well-designed and the model (gpt-5.5, medium effort) executed it
faithfully in both reviewed runs: diff-first workflow followed verbatim, scope
respected (docs-only, focused sub-maps), map content **accurate against source in
every spot-check**. The failures are not in the prompt's instructions or the model's
map-writing — they are at the system boundary the prompt ignores:

1. **Output durability.** The automation leaves its edits uncommitted overnight in a
   repo where orchestrator sessions run `git reset`. The Jul-10 run's output was
   destroyed ~21 hours later; one good routing row is permanently lost and nothing
   flagged it.
2. **Cadence blindness.** The fixed 30-hour lookback assumes daily execution, but the
   automation silently missed 4 consecutive days; ~20 commits were never scanned by
   any run.
3. **Memory addressing.** The `$CODEX_HOME` path in the automation header is not a
   real shell variable; the Jul-11 run's memory read silently no-op'd (exit 0, empty)
   while the model *claimed* it had consulted memory.

## Evidence base

| Artifact | Location |
|---|---|
| Automation config | `~/.codex/automations/refresh-workspace-routing-map/automation.toml` (gpt-5.5, medium effort, daily 03:00 local, local execution, cwd `/Users/pt/cat-code`) |
| Automation memory | `~/.codex/automations/refresh-workspace-routing-map/memory.md` (rewritten wholesale each run; holds only the latest run) |
| Run A transcript | `~/.codex/sessions/2026/07/10/rollout-2026-07-10T03-00-07-019f4877-….jsonl` — the "Last run: 2026-07-09T20:00:07.928Z" in the reviewed prompt (local = UTC+7) |
| Run B transcript | `~/.codex/sessions/2026/07/11/rollout-2026-07-11T03-01-55-019f4d9f-….jsonl` — most recent run |

## What actually happened

### Run A — 2026-07-10 03:00–03:03 local

~29 shell calls + 6 `apply_patch` calls (one patch failed on stale context; the model
correctly split and retried). Followed the prompt's command list exactly. Edited six
maps documenting the GPT-5.6 Terra/Luna launch wiring — which at 03:03 was
**uncommitted work-in-progress** by other sessions sitting in the tree: `codex-core.md`,
`query-provider-runtime.md`, `tools-permissions.md`, `agent-mode.md`,
`config-persistence.md`, plus the `WORKSPACE_MAP.md` date. Ran `git diff --check` plus
a self-initiated all-map link check (ad-hoc node script). Left everything uncommitted.

**Fate of Run A's output** (established via reflog + `git log -S`):

- The feature session that later committed the GPT-5.6 work (`f1f0518`, 13:28 same
  day) **absorbed the automation's rows near-verbatim** into `codex-core.md`,
  `query-provider-runtime.md`, `tools-permissions.md`, and `build-release-testing.md`
  — updating them in the process (`gpt54Label.test.ts` → `gpt56LunaLabel.test.ts`,
  Terra/Luna → Sol/Terra/Luna, effort-mapping wording corrected).
- The rest was **wiped** by `reset: moving to migration` at Jul 11 00:04:33 (reflog
  `a2672ae` — the same reset incident that wiped STATUS.md rows, which were recovered;
  the map edits were not).
- Permanently lost: the `agent-mode.md` "Subagent model overrides and downgrade
  protection" routing row + its test route (`git log -S` across all refs: never
  committed). `agent-mode.md` still says `Last refreshed: 2026-07-01`.
- No trace remains: the next run's memory rewrite deleted the Jul-10 summary, so the
  system's only record that this work existed is the session transcript.

### Run B — 2026-07-11 03:01–03:04 local

~34 shell calls + `apply_patch`. First action was the memory read via
`"$CODEX_HOME/automations/…"` — `$CODEX_HOME` is unset in the shell, the `if [ -f ]`
guard was false, the call returned **empty output with exit 0**, and the model
proceeded while narrating "starting from … the automation memory so I don't repeat
prior map edits." It only read memory successfully at the very end (literal path,
`mkdir -p`) when writing the new summary. It did notice `$CODEX_HOME` was empty
(`printf` check) but never flagged the failed opening read.

Work: documented the new `cat-code codex status --json` surface (committed 44f45b1 the
previous day) across `WORKSPACE_MAP.md`, `analytics-diagnostics.md`,
`auth-accounts-oauth.md`, `build-release-testing.md`, `codex-core.md`, and corrected
the desktop typecheck command in `web-app-runtime.md`. Verified with
`git diff --check` + an ad-hoc python link check. As of 2026-07-12 these edits are
**still uncommitted** in the working tree — exposed to the same wipe risk that
destroyed Run A.

## Output quality — content accuracy

Every claim spot-checked in Run B's surviving diff verifies against source:

| Map claim | Source evidence | Result |
|---|---|---|
| Decision actions `delegate/wait/recheck/attempt/human_recovery` | `src/services/api/codexStatus.ts:55-59` | ✅ exact |
| `--refresh never` = zero network | `src/services/api/codexStatus.ts:12,392` | ✅ |
| Default `auto` = cached refresh-free GET with `updateRoutingHints: false` | `src/services/api/codexStatus.ts:154,398` | ✅ |
| Opaque `cp_<hash>` profile refs | `src/services/api/codexStatus.ts:172` (`cp_` + sha256 slice) | ✅ |
| `cap_state_shared_with_next_process` always false | `src/services/api/codexStatus.ts:111,480` | ✅ |
| Exit 0 for valid observations (even no-account/all-blocked), nonzero = internal failure | `src/cli/handlers/codexStatus.ts:7,19,23` | ✅ |
| Wiring via `src/main.tsx` (not `src/commands.ts`) | `src/main.tsx:4252` | ✅ |
| Test route `bun test src/services/api/codexStatus.test.ts` | file exists | ✅ |
| Typecheck fix `bunx tsc -p app/tsconfig.json` → `bun run --cwd app typecheck` | `app/package.json:13`; matches CLAUDE.md §3 | ✅ |

Run A's content matched the tree as of 03:03; its effort-mapping detail ("minimal →
`low`") was superseded within hours by the evolving feature (committed as "→ `none`").
That is inherent same-day drift from documenting in-flight work, not a model error —
but see prompt defect 6.

Scope compliance in both runs: docs-only, no unrelated changes, no
AGENTS.md/CLAUDE.md read-instructions added to maps, filenames left undated, main map
kept concise (one added routing row). Both runs went beyond the prompt and
link-checked all 18 maps — good initiative the prompt only asks for in the light-check
branch.

## Output quality — reporting honesty

- **Run B claimed evidence it didn't have**: "starting from the automation memory" when
  the read silently returned nothing.
- **Both runs' summaries imply durable completion** ("Workspace maps refreshed …
  verified"). Neither notes that the output is uncommitted and can be wiped. Run A's
  inbox card said "GPT-5.6 routing updates verified"; the work evaporated 21 hours
  later with zero signal to the user.
- Otherwise the final summaries are exemplary: what changed, which changed paths drove
  it, what verification ran, what was deliberately left untouched.

## Prompt review

### What works (keep)

- The exact diff-first command list — both runs executed it verbatim; it reliably
  anchors the session in evidence before any reading.
- "Read WORKSPACE_MAP first, open only the focused sub-maps" — both runs opened 8–9 of
  18 maps, correctly matched to the changed areas.
- The light-check branch for no-op days; the anti-noise rules (no AGENTS/CLAUDE
  boilerplate in maps, undated filenames, concise main map); "avoid unrelated code
  changes"; `git diff --check` + drove-by-paths summary requirement.

### Defects (ranked)

1. **No durability step.** The prompt ends at "verify and summarize"; output is left
   uncommitted in a repo where overnight orchestrator sessions `git reset`. Proven
   cost: Run A's unique `agent-mode.md` row is permanently lost, and Run B's output
   is currently exposed to the same risk.
2. **Fixed 30-hour window assumes a cadence the automation doesn't achieve.** Prior
   runs: Jul 5 12:19 → Jul 10 03:00 (no automation sessions exist Jul 6–9). Commits
   between Jul 5 and Jul 8 ~21:00 — about 20, including the CLAUDE.md rewrite
   (`0069681`) and split workspace panels/command palette (`482579f`) — fell outside
   every run's window and were never diff-scanned. Stale-map dates partially
   compensate (Run B refreshed old maps opportunistically), but nothing guarantees the
   gap is ever closed; `agent-mode.md` remains stamped 2026-07-01 after two
   subsequent runs.
3. **`$CODEX_HOME` in the automation header is not resolvable in the shell.** Run A
   happened to hardcode the literal path (worked); Run B trusted the variable and the
   memory read silently no-op'd. Same prompt, nondeterministic outcome, and the
   failure mode is invisible (guarded command, exit 0).
4. **Memory holds only the last run and is never reconciled with the tree.** Full
   rewrite each run means a wiped run leaves no trace; nothing instructs the model to
   check that the *previous* run's edits actually persisted (Run B had both the
   memory claim "updated codex-core…" and a tree where `WORKSPACE_MAP.md` was back at
   2026-07-05 — a contradiction it never got to see because the memory read failed,
   and wouldn't have been told to act on anyway).
5. **Link/filename verification is only specified in the light-check branch**, though
   it matters more when edits happen. Both runs did it anyway; codify it.
6. **No rule for uncommitted in-flight work.** Run A documented a feature 10 hours
   before it was committed, from other sessions' unstaged edits. It happened to be
   absorbed; had the feature been reverted instead, the maps would have documented
   phantom behavior. The prompt should either prefer committed state or require
   flagging rows sourced from an uncommitted diff.
7. **A genuinely new domain falls into the wrong branch.** New code inside an
   existing domain is handled well (Run B mapped the brand-new `codex status
   --json` surface into three existing maps). But a subsystem no sub-map covers is,
   by the prompt's letter, "changed paths do not touch mapped source/doc areas" →
   light check → "no routing updates needed" — the wrong outcome, repeated daily and
   silently. Nothing in the prompt authorizes creating a sub-map; the only
   authorization is a maintenance rule inside `WORKSPACE_MAP.md` ("update or create
   the relevant sub-map"), unreachable from the light-check branch. New domains also
   typically arrive untracked, visible only as `??` in `git status --short`, and both
   runs deliberately left untracked paths alone (live example: untracked
   `scripts/memory-behavior-eval/` appears in no map today).

## Recommendations

Ordered by value; 1–2 need a user decision, the rest are prompt edits.

1. **Make output durable (user decision).** Either (a) grant the automation explicit
   authority to commit its own docs-maps-only diff (`docs(maps): daily routing
   refresh`) — note it will land on whatever branch is checked out, currently
   `migration`; or (b) minimally, have it write `git diff -- docs/maps >
   ~/.codex/automations/refresh-workspace-routing-map/last-run.patch` before
   finishing, so a reset is recoverable. (b) is safe and costless regardless.
2. **Recover the lost row.** Re-add the `agent-mode.md` "Subagent model overrides and
   downgrade protection" routing row (content preserved in Run A's transcript;
   re-verify `src/tools/AgentTool/AgentTool.tsx` + `src/utils/model/agent.ts` first).
3. **Derive the lookback from memory, not a constant**: "use `git log
   --since=<last-run timestamp from memory>` (fall back to 30 hours if memory is
   missing), and cross-check each opened map's `Last refreshed` date against that
   window."
4. **Use the absolute memory path** (`/Users/pt/.codex/automations/…`) in the prompt
   itself, and require the run to state loudly whether memory was found or missing —
   never proceed on a silently-empty read.
5. **Add a persistence check**: "before refreshing, verify the previous run's edits
   (per memory) still exist in the tree; if they were reverted, say so in the summary
   and re-apply what is still correct." Consider bounded append-style memory (last
   3–5 runs) instead of full rewrite.
6. **Move the link/filename check out of the light-check branch** (both runs already
   do this) and add: "if a mapped claim is sourced from uncommitted working-tree
   changes, mark the row or prefer committed state."
7. **Handle new domains explicitly**: "if changed paths introduce a subsystem no
   existing sub-map covers, add a routing row to `WORKSPACE_MAP.md` and flag the
   missing sub-map in the summary (or create a new undated sub-map if ownership is
   clear) — never report 'no routing updates needed' for an unmapped new subsystem."
   Given unattended gpt-5.5/medium runs, flag-for-manual-creation is the safer
   default over auto-authoring a full map.

## Uncertainties

- The claim that `f1f0518` *absorbed* Run A's uncommitted rows is inferred from
  near-verbatim wording plus timeline (automation authored 03:03; commit 13:28); I did
  not reconstruct the f1f0518 session's transcript to confirm the mechanism.
- Why the automation didn't fire Jul 6–9 is unestablished (machine asleep at 03:00 vs.
  Codex Desktop not running). Worth checking before relying on recommendation 3 alone.
- Run A's absorbed rows were spot-checked, not exhaustively re-verified against
  current source; `9bb0e06` (Jul 12) has already revised the effort-mapping row again.
