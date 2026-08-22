# Where Cat Code trails upstream and its peers

**Date:** 2026-08-22 · Four research lanes: upstream Claude Code **2.1.239** (fork point
2.1.87, ~150 releases of drift), OpenAI Codex CLI 0.147.0, and a web survey of OpenClaw,
Hermes Agent and Muse Code.

Evidence grades used below. **RUN** = a `--help` or read-only listing actually executed on
both binaries. **STRINGS** = a bounded grep of the upstream binary, weak on its own because
a string can be dead code, always cross-checked against a Cat Code source read. **DOCS** =
a cited URL.

## The one finding that changes the picture

Every peer harness surveyed avoids the many-sessions-one-tree problem rather than solving
it. OpenClaw has session-to-session messaging but states it has **no locking primitives**;
Hermes has a session-turn lock that guards a session, not a file; both answer collisions
with worktrees, which this repo already does. So the survey's honest conclusion was that
nobody had solved it.

That conclusion was wrong in one place, and it is the place that matters:

> **Upstream Claude Code already ships a machine-wide live-session roster.**
> `claude agents --json [--cwd <path>] [--all]` prints every live session, interactive and
> background, with `id`, `cwd`, `name`, `state` (`running` / **`blocked`**), `startedAt`.
> Purely local, no cloud. **RUN** — it listed real sessions on this machine, including two
> under `/Users/pt/cat-code`.

Cat Code's `agents` subcommand lists agent *definitions*, which is a different thing, and
its `BG_SESSIONS` feature flag is dead with the module missing. So today no session here can
answer "who else is alive in this tree, and which of them is stuck on a permission prompt".
The `--cwd` filter is precisely the shared-tree question, and `state: "blocked"` is precisely
the "why has that session not moved in 20 minutes" question.

## Ranked gaps against upstream 2.1.239

| # | Capability | Cat Code today | State | Size |
|---|---|---|---|---|
| 1 | `--bg` background sessions + `agents --json` live roster **(RUN)** | `agents` lists definitions; `BG_SESSIONS` dead, module missing | ABSENT | L |
| 2 | `PermissionRequest` + `SubagentStart` hook events **(STRINGS)** | union in `src/types/hooks.ts` has neither | ABSENT | S |
| 3 | Lazy skill discovery: `ListSkills` / `SearchSkills` + prefetch **(STRINGS)** | **call sites already written**, `src/query.ts:78`, `src/constants/prompts.ts:104,112,366,1152`; `src/services/skillSearch/` does not exist | ABSENT, pre-wired | M |
| 4 | `/fork` and `/subtask` (copy or send this conversation to a background agent) **(STRINGS)** | absent; `FORK_SUBAGENT` dead | ABSENT | M |
| 5 | `Monitor` tool: wait on a condition instead of polling `sleep` **(STRINGS)** | `src/tools.ts:44-45` already imports it behind dead `MONITOR_TOOL`; **directory does not exist** | ABSENT, pre-wired | M |
| 6 | `--safe-mode`: start with CLAUDE.md, skills, plugins, hooks, MCP, agents all off **(RUN)** | absent; `--bare` is a different thing | ABSENT | S |
| 7 | `--exclude-dynamic-system-prompt-sections`: move cwd/env/**git status** out of the system prompt **(RUN)** | absent; `PROMPT_CACHE_BREAK_DETECTION` detects the break with no lever to fix it | ABSENT | S |
| 8 | `mcp login` / `mcp logout` OAuth **(RUN)** | `McpAuthTool` exists, no CLI entry | ABSENT | M |
| 9 | `plugin init/details/eval/prune`, `/reload-skills`, `/skill-doctor` **(RUN + STRINGS)** | has `reload-plugins`, not `reload-skills`; no token-cost projection, no unused-skill report | PARTIAL | M |
| 10 | `--autocompact <auto\|tokens>` per-session window **(RUN)** | three compaction features live, no per-invocation control | ABSENT | S |
| 11 | `project purge` (delete all state for a project) **(RUN)** | no `project` subcommand | ABSENT | S |
| 12 | `doctor` as a real checkup, incl. **settings validation** **(RUN)** | auto-updater + MCP stdio health only | PARTIAL | M |

**Rows 3 and 5 deserve attention out of rank order.** Both are already wired into Cat Code
and both are dead only because the module never came across the fork. Row 3 is the largest
recoverable context cost here: ~40 skills, every description in every system prompt of every
concurrent session. Row 7 is a two-line prompt-assembly reorder that directly targets a cost
this repo pays constantly, because git status changes between turns when several sessions
commit to one tree, busting the cached system prompt every time.

**Not a gap, recorded because the help text lies:** `auto-mode defaults --help` says
"environment, allow, and deny rules", but `src/utils/settings/types.ts:1031-1047` and
`src/cli/handlers/autoMode.ts:47-56,72-73` implement the full upstream four-tier
`allow`/`soft_deny`/`hard_deny`/`environment` vocabulary, with `deny` kept as a back-compat
alias. Stale help string, not a missing feature.

## Ideas worth stealing from the peers

Ranked for one operator, many sessions, one tree. All **DOCS**.

1. **Shadow-git checkpoints with `/rollback`** (Hermes) — one snapshot per turn, taken
   before the first write, in a shadow repo via `GIT_DIR`+`GIT_WORK_TREE`, **completely
   isolated from the project's git**. Rollback also rewinds the conversation turn so context
   matches the filesystem, and takes a pre-rollback snapshot so the undo is undoable. The
   isolation property is what makes this safe under this repo's "never `git stash`, never
   `checkout -- .`" rule: undo becomes possible with no operation on the shared index.
2. **Worktree as a session primitive with auto-prune** (Hermes) — a whole session gets a
   disposable worktree; on completion the result reports `path, branch, commits ahead, dirty`,
   and **a worktree with no commits and a clean tree is pruned automatically, anything
   holding work is kept.** That predicate is the reap-at-the-source rule, mechanized. It is
   what prevents a repeat of the 34-worktree / ~7 GB pileup.
3. **Intent-before-effect append-only event log with idempotency keys** (Muse Code) — a
   durable record written *before* each side effect, so a crash between intent and terminal
   is resolvable without repeating the effect. Cat Code already has a raw `AppSessionEvent`
   stream; making it durable and intent-first extends an existing spine.
4. **Per-session auth-profile pinning with model-scoped cooldowns** (OpenClaw) — profiles
   pinned per session rather than rotated per request, explicitly to preserve prompt-cache
   affinity; cooldowns escalate 30s/1m/5m and are **model-scoped**, so sibling models on one
   provider stay available. Refinements to an account pool this repo already has.
5. **Auxiliary model routing per side-task** (Hermes) — separate model for compaction,
   title generation, vision, approval classification. Turns "don't burn frontier quota on
   dev-loop turns" from a discipline into a config.
6. **Programmatic tool calling over a local socket** (Hermes `execute_code`) — agent-written
   code calls tools in a child process; only its `print()` output re-enters context, so
   intermediate tool results never do. Cat Code already runs a UDS sidecar. Biggest per-turn
   token lever found.

## What this pass did not cover

- **Settings-schema drift.** CLI flags, subcommands, tools, hook events and slash-command
  names were diffed; `settings.json` keys were not. ~150 releases almost certainly added
  settings with no CLI surface, and that is the most likely place for gaps this missed.
- **Whether rows 3 and 5 are ports or rewrites.** The call sites exist here; whether the
  upstream modules are recoverable from the 2.1.87 agent-sdk bundle was not checked, and that
  single check would move those size estimates more than anything else in the table.
- **Whether `--bg` needs a supervisor.** `agents --json` reads a local registry, but whether
  background sessions reparent to a daemon or are just detached children decides whether
  row 1 is L or XL.
- **`PermissionRequest`'s payload shape** — specifically whether a hook can *decide* the
  permission or only observe it. That distinction is the whole value of row 2.
- **In-session behaviour changes** (compaction strategy, context management, tool-result
  truncation) leave no distinctive strings and are invisible to `--help`.
