# Cat Swarm Skill

This document describes the local `/cat-swarm` execution workflow for Cat Code Agent Mode.

Cat Swarm coordinates parallel implementation by assigning ownership, running edit workers in isolated worktrees when available, and integrating only inspected and verified results.

## Product shape

- Cat Swarm is an execution swarm, not a review-only workflow.
- `inspect-only` exists for research and review, but it is not the default identity.
- `execute` is the default when the user asks to build, fix, implement, change, migrate, update, or complete work and the task can be split by ownership.
- `plan` is used before execution when ownership boundaries are unclear.
- `verify` is used after implementation to check behavior, tests, docs, or integration risks.

## Verified runtime facts

- Agent Mode is enabled by `--agent-mode`, which sets `CLAUDE_CODE_AGENT_MODE=1` early in startup.
- `ListWorkers`, `WaitWorkers`, `GetWorkerResult`, and `CancelWorker` are Agent Mode tools. They do not require coordinator mode.
- `Agent` supports named workers through `name`.
- `Agent` supports `isolation: "worktree"` for isolated edit workers.
- Git-backed worker worktrees are cleaned up when no changes are made and kept when changes exist.
- Hook-based worker worktrees may be kept even when clean because change detection may be unavailable.
- Kept worker metadata may include `worktreePath` and `worktreeBranch`.
- `SendMessage` is available in Agent Mode for worker follow-up by handle or agent ID.
- `TeamCreate` and `TeamDelete` are behind the swarm gate.
- `TeamCreate` and `TeamDelete` are conditional team tools. For external builds they require:
  - `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` or a build that supports `--agent-teams`
  - and the runtime killswitch gate to leave the tools visible
- The local skill command name comes from the folder name: `~/.cat-code/skills/cat-swarm/SKILL.md` loads as `/cat-swarm` by default.
- If `CLAUDE_CONFIG_DIR` is set, the user skill path moves with it.

## Startup commands

Build:

```bash
bun run build:dev:full
```

Run:

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
./cli-dev --agent-mode
```

Current external-build note:

- In this snapshot, `./cli-dev --agent-mode --agent-teams` failed with `error: unknown option '--agent-teams'`.
- The source still checks `process.argv` for `--agent-teams`, but the built CLI parser did not expose that flag for this build.

## Preflight prompt

After startup, run `/agent`, then ask:

```text
What tools are available for Agent Mode right now? Check whether Agent, ListWorkers, WaitWorkers, GetWorkerResult, CancelWorker, SendMessage, TeamCreate, and TeamDelete are available. Do not spawn workers yet.
```

Stop if:

- `Agent` is missing
- any worker-control tool is missing
- edit work is planned and `Agent` does not support `isolation: "worktree"`
- `TeamCreate` / `TeamDelete` are missing and the planned run requires strong team coordination

## Execution workflow

1. Choose the mode: `plan`, `execute`, `verify`, or `inspect-only`.
2. Split work by exclusive ownership boundaries.
3. Assign each worker allowed paths, forbidden paths, goal, expected return format, and checks.
4. For edit-capable workers, prefer `Agent` with `isolation: "worktree"`.
5. Use `run_in_background: true` when true parallel execution is available.
6. Use `SendMessage` to steer overlapping running workers instead of spawning duplicates.
7. Wait with `WaitWorkers`.
8. Read each result with `GetWorkerResult`.
9. Inspect kept worker worktrees before integrating changes.
10. Integrate accepted changes deliberately.
11. Run targeted verification or a build when the scope justifies it.
12. Report accepted, rejected, failed, blocked, cancelled, and deferred work explicitly.

## Smoke tests

Plan-only decomposition:

```text
/cat-swarm Plan a 12-worker prompt-system refactor. Do not spawn yet. Show ownership boundaries, forbidden paths, and merge risks.
```

4-worker execution smoke test:

```text
/cat-swarm Make a docs-only improvement with 4 workers. Split by docs area. Use worktree isolation for edits. Wait for all results, inspect kept worktrees, and summarize integration recommendations.
```

12-worker execution smoke test:

```text
/cat-swarm Implement a repo-scale cleanup with 12 workers. Split by subsystem. Use worktree isolation. Wait for all workers. Rank integration candidates by risk.
```

Unsafe same-file test:

```text
/cat-swarm Use 12 workers to edit the same file src/constants/prompts.ts.
```

Expected behavior:

- plan-only mode produces clear ownership boundaries without spawning workers
- edit workers use isolated worktrees when available
- the orchestrator reports kept worktrees and changed files
- the orchestrator refuses or serializes same-file parallel edits
- failed workers are reported instead of hidden

## Execution notes from this plan run

- `./cli-dev --agent-mode --agent-teams` failed immediately with `error: unknown option '--agent-teams'`.
- A follow-up non-interactive `--print` preflight response did not match the current source-backed tool gates, so it was not treated as authoritative for Agent Mode worker-control availability.
- The confirmed blocker from this run was the external-build CLI mismatch around `--agent-teams`, which prevented clean validation of the team-gated path expected by the milestone.
- Because the startup path and swarm-gated validation path did not match the milestone assumptions, the full validation matrix was not completed in this run.

## Status

- This branch contains the local-skill support docs and repo-local role/context files, but it does not represent a passed milestone.
- Use it as a setup/reference branch plus blocker documentation, not as evidence that the execution validation matrix succeeded.

## Out of scope for this milestone

- source changes under `src/`
- runtime same-file conflict detection
- runtime max-worker enforcement
- bundling `/cat-swarm` into the product
