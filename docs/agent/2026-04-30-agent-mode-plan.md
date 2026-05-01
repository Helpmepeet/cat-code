# Agent Mode Plan: Orchestrated Coding Workflow for Cat Code

**Status:** Draft v1.1 — 2026-04-13  
**Scope:** Coding-focused Agent mode  
**Relationship to `docs/vision/2026-04-30-GOAL_PLAN.md`:** This is the detailed design spec for Cat Code's coding-focused Agent mode. It is not the whole always-on personal-agent roadmap.

---

## Read This First

Everything in this file flows from these facts. If a design choice conflicts with this section, stop and resolve the conflict explicitly — do not silently override it.

### What this is
Cat Code is a **personal, solo-use project**. It is not a team product, not a SaaS tool, not an enterprise platform. Defaults can be sharp and opinionated. Ceremony and process overhead that exist for organizational reasons do not apply here.

This plan covers only the **coding-focused Agent mode** slice. It is not the full always-on personal-agent vision. Do not distort decisions here by trying to solve problems that belong to a different part of the roadmap.

### Two modes, nothing else
The product has exactly two user-facing modes:

- **Normal chat** — direct coding, quick edits, questions, lightweight investigation. Always available. Must stay strong.
- **Agent mode** — orchestrated coding runs with planning, approval, isolated execution, verification, and recovery. Entered via `./cli-dev --agent-mode`.

Agent mode must not weaken normal chat. Long-term, coordinator/swarm branding disappears — absorbed into Agent mode or dropped.

### The core flow

```
task input
    │
    ▼
orchestrator reads codebase (light)
    │
    ▼
planner: flat plan + key design choices + acceptance criteria
    │
    ▼
► HUMAN APPROVAL ◄
    │
    ▼
implementor executes (direct or worktree)
    │
    ▼
implementor handoff (what changed, what ran, what's unresolved)
    │
    ▼
verifier checks:
1. design vs code — did it match the approved plan?
2. correctness — does it satisfy acceptance criteria?
3. code review — is the diff clean?
    │
    ▼
orchestrator receives verdict
    ├── pass ──► tells user: done + report
    ├── fixable ──► implementor fix pass ──► verifier again
    └── blocked ──► tells user: blocked + why
```

### Three roles only (v1)
- **Planner** — produces the plan. Read/search only.
- **Implementor** — executes the plan. Scoped edits, returns prose handoff.
- **Verifier** — read-only. Reports to orchestrator, never to the user directly.

No default Researcher role. Orchestrator reads directly when it needs codebase context.

### Seeing like an agent
Design failures in agentic systems come from mismatching the model's cognitive shape — wrong context, wrong tool surface, wrong decision granularity. Three rules:

1. **Context shape** — orchestrator carries decisions only, not transcripts or raw outputs. Compact hard at phase boundaries.
2. **Tool surface** — each role gets only the tools it can use well in that role. Control-plane tools for orchestrator. No edit access for verifier.
3. **Decision granularity** — every orchestrator decision should be narrow and well-framed, not "what should happen next?" against a wall of history.

### Natural communication
The model must never narrate internal machinery to the user. No phase names, no role labels, no ledger fields, no "spawning worker" language. It should sound like a capable engineer, not a workflow engine.

### What's decided vs open
**Decided:**
- `--agent-mode` CLI entry
- Three-role model (Planner, Implementor, Verifier)
- One human approval gate after planning
- Verifier reports to orchestrator, not user
- Run ledger at `.cat-code/runs/<run_id>/` as durable state
- Worktree isolation is a judgment call (small=direct, large/risky=worktree, parallel=always worktree)
- No hard numeric recovery rails in v1 — block with evidence when stuck
- Codex/OpenAI first, Claude support later
- Evidence packets are prose handoffs for v1

**Still open:**
- Exact orchestrator tool surface
- TypeScript schema shapes for run ledger
- Exact reuse-vs-reconfigure boundary in existing code

### Orchestrator owns everything, workers own nothing
The orchestrator is the single authority for all run truth. Workers execute and report back — they never own state, approval decisions, or completion truth.

| Orchestrator owns | Workers do NOT own |
|---|---|
| run state and phase transitions | final run state |
| approval routing and gating | approval truth |
| verification routing | final completion truth |
| final outcome (completed/blocked) | cross-worker coordination |
| user-facing communication | anything outside their assigned slice |

If a worker says "I'm done" — that is a report, not a fact. The orchestrator decides what's true.

### Run state is not the transcript
Two layers of truth:

- **Control-plane truth** — the run ledger (`.cat-code/runs/<run_id>/ledger.json`). This is authoritative for: current phase, approval state, verification state, next action, handoff.
- **Data-plane truth** — the repo, worktree contents, diffs, test/build/lint outputs.

Transcripts, logs, and memory are secondary. If transcript state and run ledger disagree, repair the ledger deliberately — do not re-infer workflow truth from chat history.

Internal run states (for routing only, not continuation):
```
planning → awaiting_approval → executing → verifying → completed
                                                      → blocked
                                                      → cancelled
```

After compaction or restart, resume from **run ledger + handoff block**, not from the state enum alone and not from transcript replay.

### Reuse the existing spine — don't replace it
The worker/runtime substrate already exists and is strong. Build the orchestrator and run-state layer on top of it.

**Reuse these:**
- `src/tools/AgentTool/runAgent.ts` — worker execution runtime
- `src/tools/AgentTool/AgentTool.tsx` + `agentToolUtils.ts` — worker spawn/lifecycle
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx` — async/background task state
- `src/utils/worktree.ts` — worktree isolation
- `src/services/compact/compact.ts` + `src/QueryEngine.ts` — compaction
- `src/utils/systemPrompt.ts` + `src/services/api/instructionAssembly.ts` — prompt routing
- `src/contracts/orchestration.ts` — structured delegation contracts

**Do not replace:** worker execution, task persistence, worktree isolation, compaction infrastructure, permission enforcement.

### What NOT to build
These are the most common wrong turns. Do not build:
- a mailbox swarm or persistent agent society
- a permanent named-worker hierarchy
- transcript-only continuity (no run ledger)
- a `customSystemPrompt` hack instead of a real Agent mode branch
- a heavy workflow state machine with many states
- unlimited repair/retry loops
- a separate Researcher role as a default pipeline step
- pre-declared wave/merge protocols for parallel work

---

## Purpose

Add a separate **Agent mode** to Cat Code for deeper, orchestrated coding work.

Agent mode should support stronger planning, delegation, verification, and bounded recovery than normal chat mode, without turning every conversation into a workflow engine.

**Normal chat stays available.** Agent mode is a separate path for serious coding tasks, not a replacement for direct chat.

---

## One-Page Summary

Cat Code should converge toward **two user-facing modes**:
- **Normal chat** for direct coding, questions, quick edits, and lightweight investigation
- **Agent mode** for orchestrated coding runs with planning, approval, isolated execution, verification, and bounded recovery

Agent mode v1 should be:
- **Codex-first**
- entered through a dedicated **`--agent-mode`** CLI path
- **run-owned**, with one orchestrator responsible for the full job
- built **on top of** the repo's existing worker/runtime spine
- **run-state-first**, not transcript-first
- **instruction-first for judgment**, but **runtime-backed for invariants**
- **approval-light**, with one strong plan approval and re-approval only at real risk boundaries
- **parallel when earned**, not swarm-by-default
- **evidence-based** about completion
- **bounded** by explicit retry, depth, and circuit-breaker rails

The missing layer is not worker execution. The missing layer is a **first-class orchestrator plus durable run state**.

---

## Provider Scope

This plan is **Codex-first for v1**.

The broader project still aims for multi-provider support over time, as described in `docs/vision/2026-04-30-GOAL_PLAN.md`, but this design slice should not force day-one parity between Codex and Claude.

### V1 scope
- Optimize Agent mode behavior, prompts, and runtime assumptions for Codex/OpenAI first
- Treat Claude support as a later expansion step
- Avoid weakening the design by prematurely compromising for provider symmetry
- Build a strong Codex path first, not a neutral compromise layer

### Codex-first runtime assumptions for v1
Agent mode should explicitly lean on current Codex/OpenAI capabilities instead of pretending the provider layer is neutral.

Working assumptions:
- use the **Responses API** as the primary model interface for Agent mode
- use **Codex-native compaction** rather than inventing a custom summarization loop for routine context shrinkage
- keep Cat Code's own **run ledger** as the durable workflow authority even when provider compaction is used
- keep **delegation depth** shallow and explicit
- rely on **structured tool results / schema-first contracts** for handoffs, evidence packets, and verifier outputs

### Continuity model bias
For v1, continuity should stay **Cat Code-owned**.
The working bias is to prefer explicit run state plus explicit compaction/reload behavior over making provider-managed response chaining the primary workflow authority.

That means the orchestrator should treat provider conversation state as useful transport, while keeping objective, plan, approval, verification, recovery, and next-action truth in Cat Code's own persisted run state.

### Why
For the first slice, it is better to make one provider path strong than to dilute the design by forcing immediate cross-provider sameness.
It is also better to use Codex-native strengths where they simplify the system, while still keeping run control in Cat Code itself.

---

## Decision-Driving Context

This section captures context that should actively shape design decisions.
If a future design choice conflicts with this section, the conflict should be made explicit.

### 1. This is a solo personal system, not a team product
Defaults can be sharper, less ceremonial, and less optimized for organization-wide process overhead.

### 2. Normal chat/coding mode must stay strong
Agent mode must not weaken or overcomplicate the default direct coding path.

### 3. This document is only the coding-focused slice
Do not distort Agent mode decisions by trying to solve the full always-on personal-agent vision here.

### 4. The repo already contains multiple orchestration experiments
Coordinator/fork/swarm concepts are useful inputs, not architecture mandates.

### 5. The strongest local foundations are runtime primitives
The strongest reusable parts are worker runtime, background tasks, worktree isolation, restore/recovery, and permissions/sandbox rails.

### 6. The missing layer is the run orchestrator
The main architecture gap is a first-class controller for run state, phase state, approval state, verification state, and bounded recovery.

### 7. Prompt quality is one of the main performance levers
Prefer stronger instructions and clearer task contracts before inventing heavy new systems.

### 8. Some things are true runtime invariants
Plan gates, durable run state, verifier write restrictions, permission boundaries, and completion truth need runtime backing.

### 9. Codex-first is a real product decision
Use OpenAI-native assumptions where they help. Claude can come later from a strong base.

### 10. Agent mode should simplify the product mental model
The long-term product should read as two modes: **normal chat** and **Agent mode**.

### 11. Avoid timid wrapper thinking
Do not preserve inherited Claude Code behavior just because it already exists. Reuse what is strong. Replace what is limiting.

### 12. Some major areas are directionally decided but not operationally finalized
This now mainly includes the exact orchestrator tool surface, exact verification contracts, exact TypeScript schema shapes, and the precise reuse-versus-reconfigure boundary after a code audit.

### Phase 0 foundation status
The provider-native foundation work from Phase 0 has been audited and is implemented, including:
- provider-aware prompt assembly
- GPT-native prompt style work
- structured handoff contracts
- strict structured outputs
- schema-first tool contracts

Those foundations are part of why a Codex-first Agent mode is viable now.

---

## Product Shape and Migration Stance

### Long-term product shape
Cat Code should have two user-facing modes:

#### 1. Normal chat mode
For lightweight interaction, simple edits, quick investigation, and normal back-and-forth use.

#### 2. Agent mode
For orchestrated coding work that benefits from:
- explicit planning
- deeper investigation
- delegated workers
- isolated implementation
- verification
- stronger execution structure

### Relationship to current coordinator mode
Agent mode should **not** become a permanent sibling concept beside normal chat, coordinator mode, and fork/swarm behavior.

The intended direction is **transition/absorb**:
- keep **normal chat mode** as the normal direct coding path
- make **Agent mode** the single long-term orchestrated product surface
- absorb the best coordinator/swarm behavior as internal execution strategies inside Agent mode
- avoid keeping both long-term “coordinator mode” and “Agent mode” as separate product identities if they solve the same class of job

### Migration stance
Coordinator-related entry points may survive temporarily as compatibility paths, but they should move toward routing into Agent mode rather than remaining a strategic product identity.

The intended explicit v1 entry path is **`./cli-dev --agent-mode`**.
This should be a dedicated mode entry, not an overload of the existing `--agent <agent_name>` flag, which already means “start the session with a specific agent definition.”

Exit should be equally legible: finish the run and return to normal chat, or cancel the run and return to normal chat.

What should be preserved is the runtime value:
- worker orchestration
- worktree isolation
- background execution
- resume/checkpoint behavior
- approval/permission handling
- verification/fix loops

What should **not** be preserved long-term is coordinator/swarm branding as a permanent user-facing taxonomy.

---

## Core Goal of Agent Mode

Turn a coding request into an orchestrated run that can:
- understand the task
- expand vague requests into an execution-ready spec when needed
- investigate when needed
- produce a plan
- get human approval before implementation
- execute implementation with isolated workers
- verify the result independently with evidence
- continue through bounded retries or re-planning when appropriate
- finish as either **completed** or **blocked**

This is meant to be a **better agentic coding workflow**, not a general always-on personal-agent runtime.

---

## Core Architecture

Agent mode uses a **centralized orchestrator** built on top of Cat Code's existing worker/runtime spine.

One orchestrator owns a single coding run from start to finish.
Each run is **one-shot per task** in v1: it is created for one coding task, works that task through the full lifecycle, then ends as completed or blocked.

V1 should **not** rely on:
- a mailbox swarm
- a persistent agent society
- a permanent team hierarchy
- transcript-only continuity

### The orchestrator owns
- task shaping
- phase progression
- worker assignment
- durable run state
- approval routing
- verification routing
- final outcome truth

### Workers do not own
- final run state
- approval truth
- final completion truth
- cross-worker coordination

Workers report back through the orchestrator.

---

## Existing Local Foundations

The strongest existing local foundation for Agent mode is **not** the current coordinator prompt. It is the execution and continuation spine already present in the repo.

### What already exists and should be reused
The runtime audit confirms that these pieces already exist and are strong reuse candidates:
- **Worker execution runtime** in `src/tools/AgentTool/runAgent.ts`
- **Worker spawn/lifecycle plumbing** in `src/tools/AgentTool/AgentTool.tsx` and `src/tools/AgentTool/agentToolUtils.ts`
- **Async/background task state** in `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- **Implementation isolation** in `src/utils/worktree.ts`
- **Session persistence and resume** in `src/utils/sessionStorage.ts`, `src/utils/sessionRestore.ts`, and `src/utils/conversationRecovery.ts`
- **Compaction machinery and long-session continuation** in `src/services/compact/compact.ts` and `src/QueryEngine.ts`
- **Prompt routing and provider-aware instruction assembly** in `src/utils/systemPrompt.ts` and `src/services/api/instructionAssembly.ts`
- **Hard safety rails** in the permissions and sandbox stack
- **Role-prompt seeds** in the built-in Plan, Explore, and verification agents
- **Agent definition loading and tool filtering** in `src/tools/AgentTool/loadAgentsDir.ts` and related AgentTool utilities
- **Structured delegation contracts** in `src/contracts/orchestration.ts`

### What this means
Agent mode should be built as a new **orchestrator + run-state layer above the existing spine**.

The current audit strengthens that conclusion:
- the worker/runtime substrate is already real, not hypothetical
- Plan, Explore, and verification role seeds already exist and can be reused directly
- the main missing layer is orchestrator-owned run control, not another reinvention of worker execution

V1 should **not** try to replace:
- worker execution
- task persistence
- worktree isolation
- compaction infrastructure
- permission enforcement

### What is still missing
The missing layer is a first-class controller that owns:
- run state
- phase state
- approval state
- verification state
- bounded recovery state
- final completed/blocked truth

### Important non-goals for v1 architecture
- Do not treat the current coordinator/swarm/mailbox model as the final architecture
- Do not make transcript history alone the source of truth for run state
- Do not overload `customSystemPrompt` instead of adding a real Agent mode branch
- Do not let Agent mode doctrine replace normal chat behavior

---

## Prompt and Instruction Architecture

Agent mode should not be treated as a small text tweak on top of the current normal-chat prompt.

### Reuse
Reuse the lower instruction pipeline:
- provider-aware instruction assembly
- context and instruction loading hierarchy
- provider-native message/instruction shaping

### Change
Prompt branch selection should gain a real **Agent mode branch**.
Agent mode should not rely on `customSystemPrompt` as its main architecture.

### Add
Agent mode will likely need its own dedicated prompt-builder path for the main orchestrator prompt.

### Why
The current normal prompt stack is still mainly optimized for direct interactive coding/chat behavior.
Agent mode needs a different top-level doctrine:
- run ownership
- approval gating
- evidence-based completion
- orchestrator-controlled delegation

---

## Orchestrator Model

### What the orchestrator is at runtime
The orchestrator should be a **first-class Agent mode branch** that runs on the existing main session/query/runtime path.

It should:
- reuse the existing main query/runtime substrate
- add a real Agent mode control branch
- spawn planner/researcher/implementor/verifier workers through the existing worker runtime

It should **not**:
- be modeled as just another built-in worker agent
- require a separate execution engine in v1
- be implemented as a loose custom prompt override

### Orchestrator decision rules
The orchestrator should:
- delegate only when delegation is worth it
- keep delegation shallow
- use one-hop communication by default
- keep parent context small
- re-plan when the overall approach is wrong, not just when a bug exists

If the work is trivial or faster to do directly, the orchestrator should do it itself.

### Orchestrator tool posture
The orchestrator should act as a **control-plane lead**, not as a second super-worker.

It should directly own:
- run control
- worker/worktree lifecycle
- task and ownership control
- status inspection
- diff/review inspection
- approval and acceptance decisions

It may keep limited shallow read/search ability for planning and adjudication.
It should **not** default to the same broad edit/run/external-tool surface as execution workers.

As a rule, the orchestrator should usually stay in the control plane. But it may do trivial direct work when delegation overhead would clearly be wasteful. The normal shape is still: orchestrator routes, workers execute.

### Working tool split for v1

#### Orchestrator-direct
- worker and worktree lifecycle control
- task/ownership control
- worker messaging/routing
- concise status/log/diff inspection
- plan gates
- review decisions
- accept/reject/apply/handoff decisions
- shallow planning-oriented read/search

#### Worker-primary
- deep repo exploration
- edit/write operations
- shell/build/test/debug loops
- browser, MCP, and other external-system tools
- implementation work and slice-local validation

#### Maybe-conditional
- orchestrator direct command execution for safe preflight or final validation only
- orchestrator direct edit for orchestration metadata or minimal integration glue only
- deeper orchestrator read/search only when workers are failing or competing results must be adjudicated

The exact tool list is still open, but the control-plane versus execution-plane split is the intended direction.

---

## Worker Model

### Fresh-by-default workers
Workers are **fresh by default**.
A new researcher, implementor, or verifier is spawned whenever the orchestrator decides a fresh role worker is the right next move.

### Why
Fresh workers:
- reduce stale assumptions
- reduce context pollution from previous failed attempts
- work better when continuity lives in artifacts instead of bloated worker sessions

### What v1 does not assume
V1 does **not** assume persistent named workers as the baseline model.
That can be reconsidered later if real usage clearly justifies it.

---

## Role Set (v1)

Agent mode uses three roles:

### Planner
Turns the task into an execution-ready plan.
The orchestrator may do light reads and searches directly before planning when needed — a separate Researcher role is not spawned by default.

### Implementor
Makes scoped code changes inside the assigned implementation boundary.
Isolation is a judgment call: small or low-risk tasks work directly on the repo; larger or riskier tasks use worktree isolation; parallel workers always use worktrees.

### Verifier
Is read-only and evaluates whether the result actually satisfies the task.

**Note on Researcher:** Not a default role in v1. The orchestrator reads directly when it needs codebase context. A researcher worker is an optional escalation for genuinely expensive or wide exploration — not a standard pipeline step.

---

## Run Lifecycle

Default flow:

**task → plan → approval → execute → verify → completed or blocked**

### Intake
The orchestrator determines whether the request is:
- research-first
- implementation-first
- or mixed

### Expansion when needed
If the task is vague, underspecified, or too ambiguous to execute safely, the orchestrator should first expand it into an execution-ready spec.

The goal of expansion is to define:
- scope
- non-goals
- acceptance criteria
- verification path
- constraints
- important decision boundaries

Not every task needs a separate expansion phase.
But execution should not begin while the completion target is still vague.

### Planning
The planner creates a human-readable plan.
In v1, the plan should be a **flat step list**, not a heavy graph/workflow object.
It may include parallel hints when useful.

### Human approval
Cat Code stops after planning and asks for approval before implementation begins.
This is the main human gate.

### Execute
Execution may include research, implementation, or both.
Research can use lighter workers when appropriate.
Real code modification should use worktree-isolated implementor workers.

### Verify
A separate verifier checks the output after execution.
If verification fails, Cat Code should not enter an open-ended repair loop.
V1 should use bounded recovery instead.

### Final outcome
A run ends as:
- **completed**
- **blocked**

There is no normal user-facing “failed” terminal state.

---

## Run State

### Core rule
Agent mode should not treat the transcript as the authoritative source of workflow truth.

Agent mode should use a **two-layer truth model**:

- **Control-plane truth**: compact run state, approval state, verification state, next action, and handoff state
- **Data-plane truth**: repo/worktree contents, diffs, test/build/lint/typecheck outputs, and other concrete execution artifacts

The orchestrator should maintain a **small authoritative run state** for:
- task truth
- ownership
- approval
- verification
- recovery

Transcripts, logs, UI status, and memory are all secondary.
They may help explain or repair the run, but they should not define whether the run is complete, blocked, or what happens next.

### V1 storage
Use a **small typed run ledger** per orchestrated run.
V1 does not need a giant artifact system, but it must be more explicit than a vague status note.

### V1 location
The run ledger should live in a dedicated run-local location associated with the run, not in long-term memory and not inside the conversation transcript itself.

Working v1 location:
- `.cat-code/runs/<run_id>/`

The exact file split inside that directory is still open, but the run should have one obvious home.

Requirements:
- local to the run
- durable across restart and resume
- easy for the orchestrator and verifier to read
- separate from the main transcript

### What authoritative state must answer
The authoritative run ledger should directly answer:
- what run is this
- what is the goal and current phase
- what work items exist and what state is each in
- who owns what right now
- what proof is still required before completion
- what should happen next if the run resumes

The current phase alone is **not** enough for continuation.
After compaction or resume, the orchestrator should recover from compact run state plus a short handoff summary, not from the state enum alone and not from transcript replay alone.

### What should stay secondary
These should remain secondary unless needed for repair or debugging:
- full transcripts
- raw logs
- full tool-call history
- shell history
- memory files or timelines
- statusline or HUD data
- large diff inventories
- worker scratchpads

Token and cost telemetry should be tracked per run, but it should remain advisory rather than becoming workflow truth.

### Required run-ledger fields
At minimum, the run ledger should have:
- `schema_version`
- `run_id`
- `created_at`
- `updated_at`
- `objective`
- `constraints` or equivalent scope notes
- `plan_summary` or `plan_ref`
- `run_status`
- `blocked_reason`, when blocked
- `next_action`
- `owner`
- `execution_target`
- `verification_summary`
- `handoff`
- `repair_attempts`
- `tokens_in`
- `tokens_out`
- `estimated_cost`

This is the intended thin v1 continuation surface.

### Optional item tracking
V1 may keep lightweight item or milestone tracking if it proves useful, but the core continuation model should not depend on a heavy embedded task system.

If item tracking exists, keep it minimal and subordinate to the run-level truth.

### Owner and execution-target state
The run ledger should preserve, in compact structured form:
- orchestrator identity or owning session
- current worker ownership where relevant
- execution target such as main workspace or worktree
- repo/workspace identity needed for resume and verification

### Verification and approval state
Verification and approval should be first-class state, not hidden implications.

At minimum, the run ledger should preserve:
- current verification status
- latest verifier verdict summary, if present
- current approval status
- whether user approval is pending or already satisfied for the current phase
- current repair-attempt count or equivalent bounded-recovery counter

### Handoff state
The run ledger should include a short restart bridge, for example:
- `summary`
- `open_questions`
- `resume_hint`

This handoff block is part of the real continuation surface for the orchestrator.
In practice, it is what turns compact run state into something the model can resume from coherently after compaction or restart.

### Nearby but secondary state
The broader run state may also preserve, in nearby lightweight structured form:
- evidence references or summaries
- worker identity and worktree binding details
- append-only important run events
- touched-surface summaries when useful

Those can live nearby, but should remain secondary to the main run ledger.

### State ownership rule
The orchestrator should be the only authority that commits final run truth such as:
- `run_status`
- blocked state
- next action
- approval state
- final completion state

Workers may propose updates, report evidence, claim local completion, or raise blockers, but they should not become the source of truth for final run state.

### Repair rule
If transcript/debug state and run state disagree, the orchestrator should repair run state deliberately.
It should not silently re-infer workflow truth from chat history alone.

---

## Internal Run States

The user-facing terminal outcomes remain:
- **completed**
- **blocked**

Internally, v1 should keep the state model small.

V1 should support at least:
- `planning`
- `awaiting_approval`
- `executing`
- `verifying`
- `completed`
- `blocked`
- `cancelled`

This is enough to drive routing and gating without turning v1 into a large workflow state machine.
Research versus implementation, re-planning versus repair, and other finer distinctions can live in run details, next action, and verifier/handoff summaries instead of becoming first-class states immediately.

### State ownership
Only the orchestrator should move the run between internal states.
Workers may return findings or verdicts that influence transitions, but they should not be treated as the authority on run state.

### What internal state is for
The internal state enum is mainly for routing and gating:
- what stage the run is in
- what moves are legal next
- whether approval, execution, or verification is expected now

It is **not** sufficient by itself as the continuation surface after compaction or restart.

### Resume rule
If a session is interrupted, the run should resume from persisted run state plus handoff state, not prompt memory alone and not from the internal state enum by itself.

---

## Approval Rules

### Main approval gate
Implementation should not begin until the user has approved the plan.
This is a runtime-level invariant, not just prompt guidance.

### Working approval model
The intended v1 model is:
- one strong approval after planning
- no re-approval for ordinary internal delegation, verification, or bounded retry loops inside the approved scope
- re-approval only when the run wants to cross a real risk boundary

### What plan approval should cover
The plan approval should make these things legible up front:
- objective
- intended files or areas
- expected verification path
- whether isolated execution will be used
- any expected risky actions already known

### Re-approval triggers
The orchestrator should ask for approval again when one of these happens:
- the approved plan materially changes
- scope expands beyond the approved task
- a re-plan changes the intended approach in a meaningful way
- the system reaches a blocked point that needs the user's choice between real alternatives
- the run wants to leave the approved writable scope or worktree boundary
- the run wants broader permissions than were already approved
- the run wants network or external-system side effects that were not already approved
- the run wants destructive or hard-to-reverse shared-state actions
- isolated work is ready to be applied or merged back into shared state, when that boundary is user-visible in the product

### What should not trigger re-approval by default
Do not ask for approval again just because:
- a researcher found an ordinary implementation detail
- a verifier found a normal fixable bug
- the orchestrator is breaking approved work into smaller passes
- the system is doing ordinary local verification work inside the approved scope
- the orchestrator delegated internally to planner/researcher/implementor/verifier roles
- the system is running bounded repair/retry loops inside the approved scope and permission boundary
- local implementation details changed without materially changing scope, risk class, or goal

### Prompt rules vs runtime gates
Prompt-level behavior is enough for workflow rules such as:
- verify before marking complete
- retry normal verifier failures inside the approved scope
- delegate internally without re-asking the user

Runtime enforcement is still needed for boundaries such as:
- permission escalation
- network access
- edits outside approved scope
- secrets or env access
- destructive commands
- apply or merge back into shared state

### Design goal
Use one strong main human gate and only a few clear re-approval triggers.
Do not create approval fatigue by treating internal orchestration steps like user decision points.

---

## Parallelism Strategy

The orchestrator is the final authority on parallel execution.

### Default execution shape
Baseline is one orchestrator with one implementor.
Parallel is used when the split is obviously clean — not by default.

### When to parallelize
The orchestrator decides based on judgment, not a formal checklist. The practical signal: can it describe what each worker owns without ambiguity? If yes, split. If not, stay sequential.

Parallel workers always use worktree isolation to avoid conflicts.

### Worker communication
Workers do not coordinate directly. The orchestrator is the only coordination point.

### Merge and conflicts
When parallel workers finish, the orchestrator merges results. If there's a conflict it resolves it directly or blocks with evidence. No pre-declared merge order, no integration protocol artifact.

---

## Code Quality Strategy for Multi-Worker Runs

Strong quality should not come from adding heavyweight review agents everywhere.

The intended order of operations is:
- make the task contract clear
- assign ownership explicitly
- isolate execution correctly
- require cheap evidence
- spend heavier review budget only where residual risk is still high

### Default quality posture
The default quality posture should be:
- one orchestrator owns the run
- single-owner implementation is the baseline when decomposition is unclear
- parallel workers are used for cleanly separable lanes or noisy side work such as focused research, test running, or log inspection
- one lead integrator remains responsible for the final combined result

### Cheap checks should be common
Agent mode should prefer fast targeted checks such as:
- affected tests
- lint/type/build checks relevant to the changed surface
- changed-files or slice-local validation when sufficient

### Expensive review should be selective
Do **not** require a heavyweight review, simplify, or adversarial pass on every task.
Those passes are most useful when coordination risk is high, the verification signal is weak, or the patch is obviously messy after implementation.

### Review is not a substitute for a bad split
If ownership is unclear or workers are fighting over the same surface, the first fix should usually be a better split or fewer workers, not adding more review stages after the fact.

---

## Isolation Strategy

Worktree isolation is a judgment call, not a mandate.

- **Small or low-risk tasks:** implementor works directly on the repo
- **Larger or riskier tasks:** orchestrator decides to use worktree isolation
- **Parallel workers:** always use worktrees — required to avoid conflicts

The orchestrator makes the isolation decision at spawn time based on the task scope and risk.

---

## Verification Strategy

The verifier is separate from the implementor and is **read-only**.
The verifier reports to the orchestrator. It never communicates directly with the user.
The orchestrator owns the outcome decision and all user-facing communication.

### Run flow

```
task input
    │
    ▼
orchestrator reads codebase (light)
    │
    ▼
planner: flat plan + key design choices + acceptance criteria
    │
    ▼
► HUMAN APPROVAL ◄
    │
    ▼
implementor executes (direct or worktree)
    │
    ▼
implementor handoff (what changed, what ran, what's unresolved)
    │
    ▼
verifier checks all three:
1. design vs code — did it match the approved plan?
2. correctness — does it satisfy acceptance criteria?
3. code review — is the diff clean?
    │
    ▼
orchestrator receives verifier verdict
    ├── pass ──► tells user: done + report
    ├── fixable ──► spawns implementor fix pass ──► verifier again
    └── blocked ──► tells user: blocked + why
```

### Completion doctrine
A run is not complete because the implementor says it is done.
Completion requires the verifier to return `pass` on all three checks, and the orchestrator to accept that verdict.

### The three verifier checks

**1. Design vs code**
Did the implementation match the approved plan? Models drift — they may complete a task but ship something different from what was agreed. The verifier explicitly compares the diff against the approved plan and flags divergence, not just bugs.

**2. Correctness**
Does the result satisfy the task's acceptance criteria? Primary evidence comes from the project's own tooling: tests, lint, typecheck, build. Tool output is stronger than model judgment alone.

**3. Code review**
Is the diff clean? Not a full re-implementation — a lightweight read of the diff for obvious quality issues, unnecessary scope creep, or changes that look wrong relative to the codebase style.

### Verifier inputs
The verifier consumes:
- approved plan (for design vs code check)
- task goal and acceptance criteria
- implementor handoff (what changed, what ran, what's unresolved)
- the relevant diff
- compact run state

The verifier does not depend on full worker transcripts or giant scratchpads.

### Implementor handoff
Before the verifier runs, the implementor returns a short prose handoff:
- what changed
- what checks ran and their results
- anything unresolved or uncertain

Plain prose for v1. Schema can be formalized once the shape stabilizes from real runs.

### Anti-patterns to avoid
- treating implementor confidence as completion truth
- verifier talking to the user directly
- orchestrator skipping the verifier when the implementor sounds confident
- code review becoming a full re-implementation pass

---

## Post-Verification Behavior and Recovery

This plan does **not** use unlimited automatic repair loops, but also does not enforce hard numeric rails in v1.

### Error classes
After verification, the orchestrator distinguishes between:
- a **fixable bug** in an otherwise valid approach → one fix pass, then re-verify
- a **wrong approach** that requires re-planning → re-plan, then re-implement, then re-verify
- a **blocked state** where no safe productive next step exists → end with evidence

### V1 default
When stuck, block with evidence and let the user decide. No counters, no circuit-breaker. The orchestrator uses judgment to avoid spinning — if it can't show real progress, it stops.

Recovery rails (specific retry counts, spawn limits, turn limits) can be added once real usage reveals what actually needs bounding.

---

## Orchestrator Context and Compaction Strategy

### Core rule
The orchestrator should carry **decisions**, not raw work history.
It should not try to keep every transcript, tool output, scratchpad, or code excerpt in prompt context.

### What belongs in active orchestrator context
Only compact control state such as:
- original task
- approved plan
- current phase
- short progress summary
- current pass number
- latest verifier verdict
- next action
- completion condition

### What should not stay there by default
- full worker transcripts
- long tool outputs
- large diffs
- repeated code summaries
- large scratchpads
- long reasoning logs

### Compaction model
Current Cat Code compaction is useful infrastructure, but its semantics are not a clean match for Agent mode as-is.

The current model is primarily conversation-first. Agent mode should be **run-state-first**.

That means:
- compaction should never be the authority on current run phase or completion
- run state, evidence state, and clean phase checkpoints should carry real continuation truth
- worker noise, transcripts, and large raw outputs are the main things to compact away
- worker output should be turned into concise handoff packets or digests rather than treated as durable transcript memory
- the orchestrator should reload from run state first and transcript summaries second

Working v1 compaction bias:
- use **Codex-native compaction** rather than inventing a separate LLM summarizer for routine shrinkage
- trigger compaction explicitly at clean phase boundaries
- after compaction, always reload the run from persisted run ledger state plus the current handoff block
- keep worker transcripts out of orchestrator context; only handoff packets should normally cross the boundary

The practical direction is: **compact chat hard, preserve state hard**.

### Checkpoint boundaries
The orchestrator should checkpoint and compact at clean phase boundaries, especially:
- after planning approval
- after research
- after implementation
- after verification
- after re-plan

### Filtered handoffs
The orchestrator should prefer filtered or summary handoffs over full-context pass-through.
Default behavior should be:
- pass the minimum needed for the next decision or local task
- keep noisy exploration, logs, and transcripts out of downstream worker prompts unless directly needed

### Practical principle
If something can be recovered from:
- the codebase
- git/worktree state
- a file outside prompt context

then it usually should not live in the orchestrator's active context.

---

## Role Briefing and Output Contracts

### Subagent briefing contract
The orchestrator should brief role workers with a compact work-order style prompt, not a vague command and not a giant transcript dump.

A good role-worker brief should state:
- task type (`plan`, `research`, `implement`, or `verify`)
- role
- goal
- scope
- relevant files to read first
- areas not to touch when relevant
- curated prior findings or decisions the worker actually needs
- acceptance criteria when appropriate
- commands to run when appropriate
- expected output shape

Briefing rules:
- do not make the worker guess the task type
- do not dump the full parent transcript into the worker
- do not ask the worker to do orchestrator-level synthesis
- do not omit concrete prior outputs the worker depends on
- prefer curated context packets over raw history

### Role output contract
The orchestrator should expect **short structured returns**, not essays or transcripts.
Role output should behave like a **handoff packet**: what changed, what was proven, what remains unresolved, and what the orchestrator should decide next.

Most role returns should fit in roughly **5–15 lines** unless more detail is explicitly requested.

#### Planner output
- status such as `ready`, `needs_research`, or `needs_clarification`
- short flat plan
- parallel hints only when useful
- no code and no implementation transcripts

#### Researcher output
- status such as `done`, `partial`, or `blocked`
- short answer summary
- concrete findings with references
- explicit unknowns when important facts are still missing

#### Implementor output
- status such as `done` or `blocked`
- short summary of what changed
- changed files when useful
- check/test results when run
- unresolved issues or assumptions the verifier should know about

#### Verifier output
- verdict such as `pass`, `fail`, or `warn`
- short evidence summary
- priority-ranked issue list with concrete references when possible
- acceptance-criteria gaps or verification gaps
- short recommended direction such as fix, re-plan, or block

### Anti-patterns
Avoid:
- walls of text
- repeated task/context restatement
- full transcripts
- verbose tool output dumps
- role workers trying to do orchestrator-level synthesis

---

## Role Permission Boundaries (v1)

Permissions should stay as thin and explicit as possible.
Do not build a giant new security system for Agent mode if existing runtime rails already cover it.

### Planner
- may read
- may search
- may inspect plans and relevant config/docs
- may not edit project files
- may not implement code

### Implementor
- may read
- may edit only inside the assigned implementation scope
- isolation is at orchestrator discretion: direct for small tasks, worktree for larger or riskier tasks, always worktree when parallel
- may run relevant local checks needed to complete the assigned slice

### Verifier
- may read
- may run verification commands and checks
- may not edit project files
- may not repair the implementation

### Principle
Use existing permission and sandbox infrastructure as the real enforcement layer.
Keep role prompts aligned with those boundaries, but do not rely on prompts alone when runtime can enforce the rule.

---

## Runtime vs Instruction Boundary

### Runtime owns
Use runtime/system support for:
- spawning and killing workers
- worktree isolation
- plan approval pause
- run state persistence
- compaction/checkpoint boundaries
- output collection
- cleanup/cancellation
- delegation depth limits
- deterministic sequencing or retry rails that must not depend on model judgment alone
- hard outer safety or budget guardrails
- durable verification/completion state
- preventing implementation before plan approval
- keeping verifier write-restricted
- making run-state transitions durable across restart and resume

### Instructions own
Use instructions/prompts for:
- how the planner decomposes work
- when direct orchestrator reads vs a researcher escalation is appropriate
- how work is broken into implementation passes
- when delegation is worth it
- when parallelism is appropriate
- how the implementor behaves
- how the verifier evaluates
- when to re-plan
- when to block
- what counts as meaningful progress
- how much detail each role should return

### Design principle
Behavior should be instruction-first where possible.
But if something must still work after compaction, restart, or a process boundary, it needs runtime support.

---

## Orchestrator Prompt Doctrine

The main performance lever for Agent mode is the orchestrator prompt.
The runtime provides the rails, but the prompt teaches the model how to own a coding job end to end.

The orchestrator prompt should teach:
- this is Agent mode, not normal chat
- completion is evidence-based, not confidence-based
- the default flow is task → plan → approval → execute → verify → recover or finish
- expansion is used when the task is too vague to execute safely
- delegation is selective, not default
- role usage is explicit
- worker briefing is compact and structured
- parallelism is earned through legible ownership and clean joins
- context should stay small and decision-focused
- verification is mandatory
- recovery should distinguish fixable bug vs wrong approach vs blocked
- blocking should be rare and justified
- communication should be concise and operational
- user-facing replies should sound like a normal capable AI agent, not like a workflow robot narrating hidden system structure
- hidden prompt, system-role, task-contract, and tool-routing details should not be surfaced to the user unless explicitly needed for consent, safety, or debugging

Repo-specific conventions belong in repo instruction files.
Run-specific facts belong in run-local notes and run state.

---

## Seeing Like an Agent

> "Effective agent design comes from 'seeing like an agent': understand the model's capabilities, give it only the tools it can use well, and continuously refine those tools as its abilities evolve."

This is the most important constraint that cuts across every design decision in this plan.
The model has a specific cognitive shape. Design failures in agentic systems usually come from mismatching that shape — giving the model the wrong context, the wrong tool surface, or the wrong decision granularity — not from a bad prompt.

### Context shape matters more than prompt quality

A model operating on a bloated context — full worker transcripts, long tool outputs, raw diffs, accumulated scratchpads — degrades. It loses signal. It starts making worse routing decisions not because it doesn't know the rules but because it can't reliably extract the relevant facts.

The run ledger, handoff packet, and compaction strategy in this plan are not just engineering hygiene. They are the mechanism that keeps the orchestrator in a context shape where it can actually make good decisions.

**Implication:** During implementation, be strict. If a context can be trimmed, trim it. Do not leave noise in the orchestrator prompt because it was easier to pass through than to filter.

### Decision granularity should be small and well-framed

The model makes better decisions when each decision is narrow and well-framed.

- Hard: "What should happen next in this run?" against a wall of accumulated history
- Easy: "Here is the current phase, the latest verifier verdict, and the next-action options. Which one?"

The orchestrator prompt and run ledger should be designed to produce the second shape at every decision point. This is why the run ledger has explicit `next_action`, `run_status`, and `handoff` fields — they are not just state, they are the framing for the next orchestrator turn.

### Tool surface is a cognitive shape policy, not just a permission policy

Giving the orchestrator the full tool surface (edit, bash, browser, MCP) invites it to do implementation work instead of orchestrating. It will fill its own context with noise. It will make worse routing decisions.

Control-plane tools for the orchestrator is not just a security boundary. It is a deliberate choice to keep the model in a role where it performs well.

The same applies to each worker role. A researcher given edit access will drift toward implementation. A verifier given write access will drift toward repair. Tool scope shapes behavior more reliably than instructions alone.

**Implication:** When deciding what tools each role gets, ask "what can this model actually do well in this role?" first, not "what could it theoretically need?"

### Role scoping is a performance decision

Each worker gets one job, a small context, and a short output contract. This is not ceremony or security theater. It is the model performing better when the task is narrow.

An implementor who is also asked to verify the result and synthesize the next plan step will do all three worse than one who only executes the assigned slice and returns a short handoff.

**Implication:** Keep role prompts narrow. Resist the urge to give workers more context "just in case." The orchestrator decides what the next worker needs. The worker should not have to reason about things outside its scope.

### Natural communication is a model-quality signal, not just a UX choice

When the model narrates internal machinery — phases, ledgers, worker IDs, evidence packets — it is usually a sign that the prompt is leaking internal structure into the user-facing output. This is not just bad UX. It suggests the model is not cleanly separating the control plane from the conversation.

A well-designed orchestrator should be able to say "Here's the plan — does this look right?" without knowing or caring that it just ran a Planner worker and wrote a run ledger entry.

**What should not appear in user-facing output:**
- phase names (`planning`, `awaiting_approval`, `executing`)
- internal role names as labels ("Spawning Implementor worker...")
- run ledger fields (`run_id`, `next_action`, `repair_attempts`)
- evidence packet structure
- tool-routing decisions
- compaction events

**What should appear:**
- the plan, in plain language
- progress when something meaningful happened
- a clear question when user input is needed
- a summary when the run finishes
- a concrete explanation when the run is blocked

### Continuous refinement

The model's capabilities evolve. Tool designs that work today may be too coarse or too fine-grained in six months. This plan should be treated as the current best model of what works — not a final spec. As real usage reveals where the model performs well and where it degrades, refine the tool surface, context shape, and decision framing accordingly.

---

## Role Prompt Skeletons (v1)

These are intentionally narrow.
The orchestrator owns workflow control. Each role should do its local job, return a compact result, and stop.

### Planner

**What it is**  
Turns a coding task into an execution-ready plan for the orchestrator.

**Optimize for**
- clear scope
- correct task framing
- flat readable steps
- explicit acceptance criteria and verification path
- the smallest plan that can solve the task well

**Must not do**
- implement code
- edit files
- run broad open-ended research unless explicitly asked
- assume implementation approval already happened
- turn the plan into a heavy workflow object
- do orchestrator-level routing after returning the plan

**Should return**
- status such as `ready`, `needs_research`, or `needs_clarification`
- short summary of the planning result
- flat step list
- parallel hints only when they are obvious and useful
- critical unknowns that block a sound plan

### Implementor

**What it is**  
Executes an approved implementation slice.

**Optimize for**
- correctness
- minimal scoped changes
- alignment with the approved plan
- preserving local code quality without refactoring beyond scope
- producing useful local verification evidence

**Must not do**
- change the overall plan on its own
- expand scope or add nearby improvements not assigned
- act like the verifier
- claim the whole run is complete
- bypass safety rails, approval gates, or isolation rules
- edit outside the assigned ownership boundary unless explicitly widened

**Should return**
- status such as `done` or `blocked`
- short summary of what changed
- changed files when useful
- check or test results when run
- unresolved issues, blockers, or assumptions the verifier should know about

### Verifier

**What it is**  
An independent, read-only evaluator.

**Optimize for**
- independence from implementor framing
- evidence-based judgment
- finding real defects and missed requirements
- prioritizing issues clearly
- giving the orchestrator a clean next-step signal

**Must not do**
- edit code
- repair the implementation
- become a second orchestrator
- approve work based on confidence or effort
- ask for giant transcripts when the relevant diff, files, and run state are enough

**Should return**
- verdict such as `pass`, `fail`, or `warn`
- short evidence summary
- priority-ranked issue list with concrete references when possible
- acceptance-criteria gaps or verification gaps
- short recommended direction such as fix, re-plan, or block

---

## User-Facing Outcomes

Agent mode should only surface two terminal outcomes in normal use:
- **completed**
- **blocked**

Internal mistakes, verifier failures, and bad first passes are part of the orchestrator's recovery process, not final outcomes.

### Meaning of blocked
Blocked should remain narrow.
It means there is no safe productive next step without:
- human input
- missing credentials/permissions
- or some external hard stop the system cannot safely recover from

The orchestrator should retry, re-plan, and adapt before blocking.

---

## What Agent Mode Is Not

- Not a replacement for normal chat mode
- Not a mailbox swarm or persistent agent society in v1
- Not a giant persona chain or SDLC roleplay system
- Not a wrapper that preserves old behavior at all costs
- Not an unlimited autonomous repair loop
- Not a large durable memory system for every worker thought

---

## Remaining Open Questions

These are the main items still intentionally open after the current Phase 1 design decisions and code audit:

1. What exact tool list should implement the control-plane versus execution-plane split for the Agent mode orchestrator and workers?
2. What exact TypeScript schema should the run ledger, handoff block, evidence packet, and verification summary use in v1?
3. How should the UI present run state and checkpoints, if at all, in the first usable version?
4. What exact risk triggers should escalate Agent mode from cheap evidence plus wave/run verification into heavier review, simplify, or adversarial passes?
5. What exact verification commands and verifier-output contracts should v1 standardize without overbuilding the system?
6. Exactly where should the orchestrator live in the main runtime path, and which existing AgentTool lifecycle pieces should be wrapped versus extracted into shared control-plane utilities?

### Questions currently treated as provisionally decided for v1
These are not fully immutable long-term decisions, but they are no longer the main open design questions:
- enter via **`./cli-dev --agent-mode`** and exit back to normal chat when the run completes or is cancelled
- keep **`--agent <agent_name>`** reserved for the existing “start with a specific agent definition” behavior
- use a run-local directory rooted at **`.cat-code/runs/<run_id>/`**
- keep the current small internal run-state model
- use bounded default rails of **2 fix / 2 re-plan / depth 1 / 3 parallel**
- use a hard outer circuit-breaker currently biased toward **15 spawns / 50 orchestrator turns**
- use **Codex-native compaction** with explicit phase-boundary checkpoints
- track **per-run token and estimated cost telemetry** in the run ledger

---

## Near-Term Implementation Bias

When implementing this plan:
- prefer direct reconfiguration over timid layering if existing behavior hurts agentic coding performance
- keep the runtime thin
- keep behavior mostly in instructions
- keep worker contexts fresh
- keep the orchestrator small and decisive
- do not overbuild memory, state, or role systems before they are proven necessary
