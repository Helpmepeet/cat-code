# Agent Mode — Personal Manual

---

## What it is

Agent mode is for coding tasks that are big enough to deserve a plan, isolated execution, and independent verification before anything lands in your repo. It runs a full loop: plan → your approval → implement → verify → done (or blocked with an explanation).

Normal chat is still the right choice for quick edits, questions, and anything you can describe in one turn. Use agent mode when you want structured, evidence-based execution.

---

## How to start

**From the command line:**
```
./cli-dev --agent-mode
```
Then type your task at the prompt.

**From inside a running session:**
```
/agent add pagination to the user list
```
Or just `/agent` with no argument — it will ask you for the task.

---

## What happens after you give it a task

1. **Planning** — it reads the relevant parts of the codebase and produces a flat plan with steps, acceptance criteria, intended files, how it will verify the result, and any risky actions it already knows about.

   - If the task is too vague to plan safely, it stops immediately and blocks with a list of open questions. Give it the missing information and restart with `/agent`.
   - If the planner hits critical unknowns it can't resolve on its own, it spawns a **researcher** first to investigate, then comes back and finalises the plan. You won't see this happen — it's automatic.

2. **Your approval** — it stops and shows you the plan. You have three choices:
   - **Approve** — start implementation
   - **Request changes** — type feedback, it goes back and replans
   - **Cancel** — end the run

3. **Implementation** — it executes the plan. For small/safe tasks this works directly on your repo. For larger or riskier tasks it uses a git worktree (isolated copy) so your main workspace stays clean.

   - If the plan has clearly separable work, it may split into **parallel lanes** — multiple implementor workers each running in their own worktree simultaneously. An integrator then merges the results. You'll see the status header reflect each active worker. Parallel is used only when ownership is clean; otherwise it stays sequential.

4. **Verification** — a separate read-only pass checks three things:
   - Did the implementation match the approved plan?
   - Does it satisfy the acceptance criteria (tests, build, lint)?
   - Is the diff clean?

5. **Outcome** — either **completed** with a summary and cost, or **blocked** with a specific explanation and what you need to do next.

---

## The worktree approval

If the task ran in an isolated worktree and verification passed, you get a second approval before the changes land in your main workspace:

> *"Implementation and verification passed in an isolated worktree. Approve copying the verified changes into the shared workspace."*

This is intentional. You're approving applying verified, staged changes back into your working directory. Your workspace must be clean (no uncommitted changes) for this to work.

---

## While it's running

A status line at the top of the terminal shows:
- What phase it's in ("Planning…", "Implementing…", "Verifying…")
- How long the current phase has been running
- Running estimated cost

If you want to abort mid-run, press **Escape**. You'll see:
```
Worker running — [a] abort and cancel run  [Esc] let it finish
```
Press `a` to kill it, or Escape again to let it keep going.

---

## When it finishes

**Completed** — shows a summary, what checks ran, and the final cost.

**Blocked** — shows the specific reason, any issues the verifier found, open questions, and the suggested next step. Usually looks like:
```
Restart with /agent <modified task> or provide the missing information.
Estimated cost: $0.43 (12k tokens in / 8k tokens out)
```

---

## Recovery limits

It won't spin forever. Hard limits per run:
- **4 fix passes** — if the verifier finds a bug, it gets 4 tries to fix it
- **4 re-plan passes** — if the approach is fundamentally wrong, it gets 4 tries at a new plan
- **30 total worker spawns**
- **100 orchestrator turns**
- **1 hour per worker** — a hung worker gets killed and the run blocks

If any limit is hit, it stops and tells you exactly why.

---

## Viewing past runs

```
/runs
```
Lists all runs: ID, objective, status, cost, date.

```
/runs a3f2c1
```
Shows full detail for that run — ledger, plan, verifier verdict.

```
/runs cleanup
```
Deletes terminal runs (completed/blocked/cancelled) older than 7 days. Asks for confirmation first.

---

## Resuming after a crash

If the CLI crashes mid-run, the next time you start with `--agent-mode` it will detect the in-progress run and ask:

```
Resume prior Agent mode run? [y] resume  [n/esc] discard
```

Press `y` to pick up from where it left off. The run state is read from the ledger on disk, not from conversation history.

---

## Re-approval triggers

It will ask for your approval again (beyond the initial plan gate) only when:
- The plan materially changes
- Scope expands beyond what was approved
- A worktree result is ready to be applied back to your main workspace
- It needs permissions or access that weren't already approved

It will **not** ask again for: normal fix passes, internal retries, or ordinary implementation details that don't change the goal or risk level.

---

## Run files

All run state lives at:
```
.cat-code/runs/<run_id>/
  ledger.json          — authoritative run state
  plan.md              — the approved plan
  planner-packet.json  — structured planner output
  implementor-packets.json
  verifier-packet.json
```

These survive crashes and are what the resume/inspect flow reads from.

---

## Quick reference

| What | How |
|---|---|
| Start a run (CLI) | `./cli-dev --agent-mode` |
| Start a run (in session) | `/agent <task>` |
| Abort mid-run | Escape → `a` |
| List past runs | `/runs` |
| Inspect a run | `/runs <id prefix>` |
| Clean up old runs | `/runs cleanup` |
