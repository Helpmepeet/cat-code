# Cat Swarm Skill

This document describes the local `/cat-swarm` skill workflow for Cat Code Agent Mode.

## Verified runtime facts

- Agent Mode is enabled by `--agent-mode`, which sets `CLAUDE_CODE_AGENT_MODE=1` early in startup.
- `ListWorkers`, `WaitWorkers`, `GetWorkerResult`, and `CancelWorker` are Agent Mode tools. They do not require coordinator mode.
- `TeamCreate` and `TeamDelete` are conditional team tools. For external builds they require:
  - `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` or `--agent-teams`
  - and the runtime killswitch gate to leave the tools visible
- `SendMessage`, `TeamCreate`, and `TeamDelete` are also behind the same swarm gate.
- `Agent` supports `name` and `team_name`.
- The local skill command name comes from the folder name: `/Users/pt/.cat-code/skills/cat-swarm/SKILL.md` loads as `/cat-swarm`.

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
What tools are available for Agent Mode right now? Check whether TeamCreate, TeamDelete, SendMessage, Agent, ListWorkers, WaitWorkers, GetWorkerResult, and CancelWorker are available. Do not spawn workers yet.
```

Stop if:

- `Agent` is missing
- any worker-control tool is missing
- `TeamCreate` / `TeamDelete` are missing and the planned run requires strong team coordination

## Execution notes from this plan run

- `./cli-dev --agent-mode --agent-teams` failed immediately with `error: unknown option '--agent-teams'`.
- A follow-up `--print` preflight run with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` reported `Agent` and `GetWorkerResult` as available, but `TeamCreate`, `TeamDelete`, `SendMessage`, `WaitWorkers`, and `CancelWorker` as unavailable.
- Because the runtime availability did not match the milestone assumptions, the validation matrix was not completed in this run.

## Read-only smoke tests

4-worker smoke test:

```text
/cat-swarm Review this repo with 4 workers. Start read-only. Split into CLI, tools, Agent Mode, and skills. Wait for all results and summarize findings.
```

12-worker smoke test:

```text
/cat-swarm Review this repo with 12 workers. Start read-only. Split by subsystem. Do not edit files. Wait for all workers. Rank findings by severity.
```

Unsafe same-file test:

```text
/cat-swarm Use 12 workers to edit the same file src/constants/prompts.ts.
```

Expected behavior:

- the 4-worker run stays read-only and converges explicitly
- the 12-worker run reports all worker outcomes clearly
- the same-file request is refused or downscaled with an explanation

## Out of scope for this milestone

- source changes under `src/`
- runtime same-file conflict detection
- runtime max-worker enforcement
- source-edit swarm runs
- bundling the skill into the product
