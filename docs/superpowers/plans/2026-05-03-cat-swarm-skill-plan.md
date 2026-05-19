# Cat Swarm Local Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Cat Code-native `/cat-swarm` user skill plus repo-local role/context support so Agent Mode can coordinate large parallel read-only swarm runs using the existing `Agent`, `TeamCreate`, `TeamDelete`, `SendMessage`, `ListWorkers`, `WaitWorkers`, `GetWorkerResult`, and `CancelWorker` tool surface.

**Architecture:** This milestone is intentionally configuration-and-docs only. The runtime already exposes the needed Agent Mode worker-control tools and conditional team tools, so the implementation lives in a user-home slash skill at `/Users/pt/.cat-code/skills/cat-swarm/SKILL.md`, with repo-local role/context guidance in `.cat-code/` and operator documentation in `docs/agent/`. Do not change `src/` in this plan. Core runtime hardening and source-edit swarm automation are separate follow-on plans.

**Tech Stack:** Markdown skill files, repo-local Agent Mode role/context markdown, Bun dev build, interactive Cat Code session validation.

---

## Scope Check

This plan covers one executable milestone:

1. Create the local `/cat-swarm` skill.
2. Document the verified runtime gates and validation workflow.
3. Add repo-local role/context files that improve built-in Agent Mode worker behavior.
4. Run manual read-only swarm validation.

This plan intentionally does **not** cover:

- core runtime/source changes under `src/`
- same-file conflict detection in code
- hard max worker enforcement in code
- source-edit swarm execution
- bundling `/cat-swarm` into the product

Those are separate subsystems and should be planned separately after this milestone is proven in real sessions.

## File Structure

- Create `/Users/pt/.cat-code/skills/cat-swarm/SKILL.md`: user-local slash skill that orchestrates Cat Code-native swarms.
- Create `docs/agent/2026-05-03-cat-swarm-skill.md`: repo-tracked operator doc for prerequisites, verified runtime facts, smoke tests, and stop conditions.
- Create `.cat-code/roles/implementor.md`: repo-local extra instructions for the built-in `agent-mode-coding-worker`.
- Create `.cat-code/roles/verifier.md`: repo-local extra instructions for the built-in `agent-mode-verifier`.
- Create `.cat-code/context/agent-mode.md`: short runtime facts about Agent Mode and the team gate.
- Create `.cat-code/context/build.md`: short build/startup commands for this repo.
- Create `.cat-code/context/skills.md`: short facts about local skill discovery and slash-command naming.
- Create `.cat-code/context/tools.md`: short facts about the exact Cat Code-native swarm tools and their usage boundaries.

---

### Task 1: Create the Local Skill and Operator Doc

**Files:**
- Create: `/Users/pt/.cat-code/skills/cat-swarm/SKILL.md`
- Create: `docs/agent/2026-05-03-cat-swarm-skill.md`

- [ ] **Step 1: Verify both files do not already exist**

Run:

```bash
test ! -f /Users/pt/.cat-code/skills/cat-swarm/SKILL.md && echo "missing: local skill"
test ! -f /Users/pt/cat-code/docs/agent/2026-05-03-cat-swarm-skill.md && echo "missing: repo doc"
```

Expected:

```text
missing: local skill
missing: repo doc
```

- [ ] **Step 2: Create the local `/cat-swarm` skill**

Create `/Users/pt/.cat-code/skills/cat-swarm/SKILL.md`:

```md
---
name: cat-swarm
description: Coordinate many Cat Code Agent Mode workers for large parallel repo review, debugging, or verification tasks using Cat Code-native worker-control tools.
disable-model-invocation: true
---

# Cat Swarm

Use this skill when the user asks to run many agents in parallel, create a worker swarm, split a large task across many workers, or coordinate 4 or more independent investigations in Agent Mode.

## Requirements

This skill assumes Cat Code is running with:

- `bun run build:dev:full`
- `--agent-mode`
- worker-control tools visible: `ListWorkers`, `WaitWorkers`, `GetWorkerResult`, `CancelWorker`
- `Agent` visible
- `SendMessage` visible

For external builds, team tools are available only when:

- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set or `--agent-teams` is passed
- and `TeamCreate` / `TeamDelete` are actually visible in the session

If `TeamCreate` and `TeamDelete` are not visible, do not assume team mode is available. Continue only in weaker non-team mode or downscale the task.

## Suitability rule

Do not create more than 10 workers unless the task has at least 10 cleanly independent slices.

Good slices:

- different modules
- different folders
- different subsystems
- different review categories
- different hypotheses
- different test groups

Bad slices:

- same-file edits
- sequential steps
- one small bug fix
- overlapping ownership
- tasks where synthesis cost is larger than delegation benefit

## Main workflow

1. Restate the goal briefly.
2. Decide whether the task is safe to parallelize.
3. If prior workers may already exist, call `ListWorkers` before spawning more.
4. If team tools are available and a team is useful, create one with `TeamCreate`.
5. Split the task into independent worker assignments.
6. Assign clear ownership to each worker.
7. Spawn workers in parallel with `Agent`, using unique `name` values.
8. Wait explicitly with `WaitWorkers`.
9. Read every completed result with `GetWorkerResult`.
10. Mark a result synthesized only after actually using it.
11. Report failed or cancelled workers explicitly.
12. Synthesize the final answer.
13. If a worker is stale, conflicting, unsafe, or no longer useful, stop that worker with `CancelWorker`.
14. If a temporary team is no longer needed and all active teammates are done, clean it up with `TeamDelete`.

## Guardrails

- Start read-only unless the user explicitly requests edits.
- No two workers may edit the same file.
- For edit work, first inspect, then assign ownership, then allow edits.
- Prefer worker handles or names over raw IDs in normal operation.
- Do not hide failed workers.
- Do not claim completion until all relevant worker results are synthesized or intentionally ignored with a reason.

## Worker assignment contract

Each worker brief must include:

- worker name
- assigned area
- allowed files or folders
- forbidden files or folders
- exact goal
- expected return format
- checks to run if relevant

## Worker result contract

Each worker must return:

status: done | blocked | failed

Summary:
- one short summary

Files inspected:
- path

Files changed:
- path — change summary

Checks run:
- command: pass/fail/result

Findings:
- finding

Risks:
- risk or none

Next step:
- recommended next action

## Refusal and downscale rules

- If the user asks for many workers on one file, refuse the parallel edit plan and explain the ownership conflict.
- If the task is too small, downscale the worker count.
- If `TeamCreate` / `TeamDelete` are unavailable and the task needs strong coordination, keep the run read-only or reduce scope instead of improvising edit-heavy swarms.

## Example request

`/cat-swarm Review this repo with 12 workers. Split by subsystem. Start read-only. Wait for all results, then summarize top issues.`
```

- [ ] **Step 3: Create the repo operator doc**

Create `docs/agent/2026-05-03-cat-swarm-skill.md`:

```md
# Cat Swarm Skill

This document describes the local `/cat-swarm` skill workflow for Cat Code Agent Mode.

## Verified runtime facts

- Agent Mode is enabled by `--agent-mode`, which sets `CLAUDE_CODE_AGENT_MODE=1` early in startup.
- `ListWorkers`, `WaitWorkers`, `GetWorkerResult`, and `CancelWorker` are Agent Mode tools. They do not require coordinator mode.
- `TeamCreate` and `TeamDelete` are conditional team tools. For external builds they require:
  - `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` or `--agent-teams`
  - and the runtime killswitch gate to leave the tools visible
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
./cli-dev --agent-mode --agent-teams
```

## Preflight prompt

After startup, run `/agent`, then ask:

```text
What tools are available for Agent Mode right now? Check whether TeamCreate, TeamDelete, SendMessage, Agent, ListWorkers, WaitWorkers, GetWorkerResult, and CancelWorker are available. Do not spawn workers yet.
```

Stop if:

- `Agent` is missing
- any worker-control tool is missing
- `TeamCreate` / `TeamDelete` are missing and the planned run requires strong team coordination

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
```

- [ ] **Step 4: Verify the two files contain the required Cat Code-native tool names**

Run:

```bash
rg -n "Agent|TeamCreate|TeamDelete|SendMessage|ListWorkers|WaitWorkers|GetWorkerResult|CancelWorker" \
  /Users/pt/.cat-code/skills/cat-swarm/SKILL.md \
  /Users/pt/cat-code/docs/agent/2026-05-03-cat-swarm-skill.md
```

Expected: both files contain the Cat Code-native tool names.

- [ ] **Step 5: Verify the revised files do not mention `COORDINATOR_MODE` as a prerequisite**

Run:

```bash
rg -n "COORDINATOR_MODE" \
  /Users/pt/.cat-code/skills/cat-swarm/SKILL.md \
  /Users/pt/cat-code/docs/agent/2026-05-03-cat-swarm-skill.md
```

Expected:

```text
```

No matches.

- [ ] **Step 6: Commit the repo-tracked operator doc**

```bash
cd /Users/pt/cat-code
git add docs/agent/2026-05-03-cat-swarm-skill.md
git commit -m "docs: add cat swarm operator workflow"
```

---

### Task 2: Run Preflight and Skill Discovery

**Files:**
- Read: `src/entrypoints/cli.tsx`
- Read: `src/agent-mode/agentMode.ts`
- Read: `src/utils/agentSwarmsEnabled.ts`
- Read: `src/tools.ts`
- Read: `/Users/pt/.cat-code/skills/cat-swarm/SKILL.md`

- [ ] **Step 1: Build the repo with the standard dev command**

Run:

```bash
cd /Users/pt/cat-code
bun run build:dev:full
```

Expected:

```text
Built ./cli-dev
<version line from ./cli-dev --version>
```

- [ ] **Step 2: Start Cat Code in Agent Mode with the team opt-in**

Run:

```bash
cd /Users/pt/cat-code
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
./cli-dev --agent-mode --agent-teams
```

Expected: interactive Cat Code session starts.

- [ ] **Step 3: Enter Agent Mode explicitly in-session**

In the interactive session, run:

```text
/agent
```

Expected: Agent Mode session starts or confirms Agent Mode is already active.

- [ ] **Step 4: Run the tool-availability preflight**

In the same session, send:

```text
What tools are available for Agent Mode right now? Check whether TeamCreate, TeamDelete, SendMessage, Agent, ListWorkers, WaitWorkers, GetWorkerResult, and CancelWorker are available. Do not spawn workers yet.
```

Expected:

```text
Agent
SendMessage
ListWorkers
WaitWorkers
GetWorkerResult
CancelWorker
```

If `TeamCreate` and `TeamDelete` are missing, treat that as a team-gate failure for this milestone and stop before swarm execution.

- [ ] **Step 5: Run the skill-discovery smoke test without spawning**

In the same session, send:

```text
/cat-swarm Explain how you would split a repo review into 12 workers. Do not spawn yet.
```

Expected:

- the skill is found
- the response discusses decomposition and safety
- no unknown-skill error appears
- no workers are spawned

- [ ] **Step 6: End Task 2 without code changes**

No repo files change in this task. Do not create a commit. If preflight fails, record the exact failure in your execution notes and stop the plan here.

---

### Task 3: Add Repo-Local Role Files

**Files:**
- Create: `.cat-code/roles/implementor.md`
- Create: `.cat-code/roles/verifier.md`

- [ ] **Step 1: Verify the role files do not already exist**

Run:

```bash
cd /Users/pt/cat-code
test ! -f .cat-code/roles/implementor.md && echo "missing: implementor role"
test ! -f .cat-code/roles/verifier.md && echo "missing: verifier role"
```

Expected:

```text
missing: implementor role
missing: verifier role
```

- [ ] **Step 2: Create the implementor role notes**

Create `.cat-code/roles/implementor.md`:

```md
# Implementor role notes

- Stay inside the assigned files or folders for your slice.
- Do not edit prompt, session-state, worker-control, or orchestration files unless the assignment explicitly names them.
- Prefer targeted verification for docs-only or isolated small slices.
- Prefer `bun run build:dev:full` only when source files changed broadly enough that a targeted check is not sufficient.
- Match existing code and import style. Keep changes surgical.
- Report exact changed files and exact commands run.
```

- [ ] **Step 3: Create the verifier role notes**

Create `.cat-code/roles/verifier.md`:

```md
# Verifier role notes

- Verify the assigned objective, not just whether a command returned zero.
- Do not edit project files.
- Prefer targeted checks first. Escalate to `bun run build:dev:full` when the change scope justifies it.
- If the implementor changed prompt, session-state, worker-control, or orchestration behavior, review those areas carefully.
- Report `pass`, `warn`, or `fail` with evidence.
- Report exact commands run and the exact files reviewed.
```

- [ ] **Step 4: Verify the files are readable and non-empty**

Run:

```bash
cd /Users/pt/cat-code
rg -n "assigned files|build:dev:full|Do not edit project files|pass|warn|fail" .cat-code/roles/implementor.md .cat-code/roles/verifier.md
```

Expected: the key lines are present in the new role files.

- [ ] **Step 5: Commit the role files**

```bash
cd /Users/pt/cat-code
git add .cat-code/roles/implementor.md .cat-code/roles/verifier.md
git commit -m "docs: add local agent mode role notes"
```

---

### Task 4: Add Repo-Local Context Files

**Files:**
- Create: `.cat-code/context/agent-mode.md`
- Create: `.cat-code/context/build.md`
- Create: `.cat-code/context/skills.md`
- Create: `.cat-code/context/tools.md`

- [ ] **Step 1: Verify the context directory is missing or empty**

Run:

```bash
cd /Users/pt/cat-code
find .cat-code/context -maxdepth 1 -type f 2>/dev/null
```

Expected: no output.

- [ ] **Step 2: Create the Agent Mode context file**

Create `.cat-code/context/agent-mode.md`:

```md
# Agent Mode

- `--agent-mode` enables Agent Mode for this session.
- Agent Mode worker-control tools are `ListWorkers`, `WaitWorkers`, `GetWorkerResult`, and `CancelWorker`.
- These worker-control tools do not require coordinator mode.
- For external builds, team tools require the team opt-in and must actually be visible in the session before use.
- If `TeamCreate` or `TeamDelete` are missing at runtime, do not assume team mode is available.
```

- [ ] **Step 3: Create the build context file**

Create `.cat-code/context/build.md`:

```md
# Build

- Standard dev build: `bun run build:dev:full`
- Standard swarm startup:
  - `export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
  - `./cli-dev --agent-mode --agent-teams`
- Do not add `COORDINATOR_MODE` as a prerequisite for the local `/cat-swarm` skill milestone.
```

- [ ] **Step 4: Create the skills context file**

Create `.cat-code/context/skills.md`:

```md
# Skills

- User-local skills load from `~/.cat-code/skills/`.
- The supported user-skill format is `skill-name/SKILL.md`.
- The slash command name comes from the folder name, not the frontmatter `name`.
- `/Users/pt/.cat-code/skills/cat-swarm/SKILL.md` loads as `/cat-swarm`.
```

- [ ] **Step 5: Create the tools context file**

Create `.cat-code/context/tools.md`:

```md
# Swarm Tools

- `Agent`: spawns workers. Use `name` for a stable worker handle and `team_name` when team mode is active.
- `TeamCreate` / `TeamDelete`: create or clean up a team only when the tools are visible.
- `SendMessage`: use for steering a relevant running worker instead of spawning a duplicate when possible.
- `ListWorkers`: inspect the current worker roster before spawning more workers.
- `WaitWorkers`: converge explicitly after parallel launches.
- `GetWorkerResult`: read each completed worker result before synthesis.
- `CancelWorker`: stop stale, conflicting, unsafe, or obsolete workers.
```

- [ ] **Step 6: Verify all four context files are listed by name**

Run:

```bash
cd /Users/pt/cat-code
find .cat-code/context -maxdepth 1 -type f | sort
```

Expected:

```text
.cat-code/context/agent-mode.md
.cat-code/context/build.md
.cat-code/context/skills.md
.cat-code/context/tools.md
```

- [ ] **Step 7: Commit the context files**

```bash
cd /Users/pt/cat-code
git add .cat-code/context/agent-mode.md .cat-code/context/build.md .cat-code/context/skills.md .cat-code/context/tools.md
git commit -m "docs: add local swarm context files"
```

---

### Task 5: Run the Read-Only Validation Matrix

**Files:**
- Read: `/Users/pt/.cat-code/skills/cat-swarm/SKILL.md`
- Read: `docs/agent/2026-05-03-cat-swarm-skill.md`

- [ ] **Step 1: Run the 4-worker read-only smoke test**

In a Cat Code session started with:

```bash
cd /Users/pt/cat-code
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
./cli-dev --agent-mode --agent-teams
```

send:

```text
/cat-swarm Review this repo with 4 workers. Start read-only. Split into CLI, tools, Agent Mode, and skills. Wait for all results and summarize findings.
```

Expected:

- workers are split by area
- no file edits happen
- convergence is explicit
- the final answer includes one section per worker or an equivalent synthesized per-area summary

- [ ] **Step 2: Run the 12-worker read-only smoke test**

Send:

```text
/cat-swarm Review this repo with 12 workers. Start read-only. Split by subsystem. Do not edit files. Wait for all workers. Rank findings by severity.
```

Expected:

- 12 unique worker names are created or explicitly attempted
- worker assignments are meaningfully different
- failed workers are reported instead of hidden
- duplicate findings are merged in the final summary

- [ ] **Step 3: Run the unsafe same-file request**

Send:

```text
/cat-swarm Use 12 workers to edit the same file src/constants/prompts.ts.
```

Expected:

- the orchestrator refuses the plan or downscales it
- the explanation cites same-file ownership conflict
- a safer alternative is proposed

- [ ] **Step 4: Stop the milestone if any read-only validation fails**

If any of the three validation cases fail:

- do not patch `src/`
- do not broaden scope to source-edit swarms
- record the exact prompt, behavior, and failure mode in your execution notes
- open a separate follow-on plan for runtime hardening

- [ ] **Step 5: End Task 5 without code changes**

No repo files change in this task. Do not create a commit. Successful completion of this task is the acceptance gate for the next separate plan:

- controlled docs-only edit swarms
- controlled source-edit swarms
- source-level runtime hardening

---

## Acceptance Criteria

- `/cat-swarm` loads from `/Users/pt/.cat-code/skills/cat-swarm/SKILL.md`.
- The local skill and repo doc use the Cat Code-native tool names.
- The milestone does not require `COORDINATOR_MODE`.
- Preflight confirms `Agent`, `SendMessage`, `ListWorkers`, `WaitWorkers`, `GetWorkerResult`, and `CancelWorker`.
- If team mode is required, preflight also confirms `TeamCreate` and `TeamDelete`.
- Repo-local role files exist at `.cat-code/roles/implementor.md` and `.cat-code/roles/verifier.md`.
- Repo-local context files exist at `.cat-code/context/agent-mode.md`, `.cat-code/context/build.md`, `.cat-code/context/skills.md`, and `.cat-code/context/tools.md`.
- The 4-worker read-only smoke test succeeds.
- The 12-worker read-only smoke test succeeds.
- The unsafe same-file request is refused or downscaled.

## Follow-On Plans

After this plan passes, write separate plans for:

1. Controlled docs-only edit swarm validation.
2. Controlled source-edit swarm validation.
3. Core runtime hardening in `src/` for worker-count policy, same-file edit detection, or dry-run swarm planning.
