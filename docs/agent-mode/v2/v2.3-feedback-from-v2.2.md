# Agent Mode v2.3 Feedback (from v2.2)

## Session metadata
- Date: 2026-04-27
- Branch: phase1
- Source: Follow-up feedback after v2.2 live-testing and real Agent Mode usage
- Goal: Capture the next round of product/runtime feedback that should shape v2.3

## Evidence status

This document is primarily an **operator/orchestrator-experience feedback note**, not a full code-verified audit.

Interpretation rules:
- Unless a specific item explicitly says it was verified in code, treat it as a behavior/product-design observation from live use.
- Many items here describe what the orchestrator experienced through the exposed prompt/tool surface, which may differ from what is technically implemented deeper in the runtime.
- In other words: this doc records **what it felt like the system could or could not do from the orchestrator seat**, not necessarily what has already been proven by repository inspection.

Morning-after rule:
- If you read this later and wonder "did we verify this in code, or did the orchestrator just experience it this way?", assume **experienced behavior** unless the item explicitly says otherwise.

---

## Framing

v2.2 was primarily a prompt-and-UI tightening pass.

That was the right scope for the milestone, but live usage exposed a remaining structural gap:
**the orchestrator is being asked to behave like a multi-turn coordinator of persistent workers, while the worker tool surface is still too close to one-shot spawn semantics.**

So v2.3 should not just be "more prompt fixes." It should focus on the next layer down: **worker continuity, session state, and orchestration truthfulness.**

---

## What v2.2 improved

- Agent Mode now has a clearer visible identity in the REPL.
- Resume/session list surfaces agent-mode state more clearly.
- The orchestrator prompt now pushes exploration outward more aggressively.
- The orchestrator is better instructed to preserve active-task continuity across user interruptions.
- Redundant respawns caused purely by prompt drift should be less common.

These fixes were good and necessary.

---

## What still feels wrong after v2.2

### 1. Worker continuity is still weaker than the orchestration model implies

Observed problem:
- A worker investigates something useful.
- The user asks a natural follow-up on that same topic.
- The orchestrator should ideally continue the same worker.
- In practice, the system may need to spawn a fresh worker because the tool surface does not cleanly support continuing any previous worker session.

Consequence:
- duplicate investigation
- weaker context hygiene
- less believable agent continuity
- friction between the user's mental model and the runtime model

This is the clearest v2.3 issue.

---

### 2. Prompt doctrine and tool capability are still slightly misaligned

v2.2 improved the orchestrator doctrine, but a prompt can only ask for behaviors that the runtime can actually support well.

Current mismatch:
- the orchestrator is told to preserve task continuity and avoid redundant respawns
- but the runtime/tool surface does not fully support "reuse the same worker" as a first-class action

This means some orchestration failures are no longer really prompt failures. They are capability-boundary failures.

---

### 3. Session-state treatment of workers is still too implicit

The system conceptually has workers as session-scoped collaborators, but operationally they still feel too transcript-driven and spawn-centric.

Symptoms:
- worker discoverability is weaker than it should be
- follow-up handling depends too much on what the orchestrator remembers in-context
- continuity becomes harder after interruption, compaction, or a turn-shape change

v2.3 should make worker identity and resumability more explicit in session state.

---

### 4. The system still needs a clearer rule for resume vs fresh spawn

Even with a better runtime, the orchestrator needs a clean product rule:
- when should it continue the same worker?
- when should it intentionally choose a fresh worker?

v2.2 improved "don't spawn redundantly," but v2.3 should turn that into a sharper default:
- resume when overlap is high
- spawn fresh when independence or clean-room context is the point

---

### 5. The orchestrator still lacks basic worker lifecycle tools

Resume is the biggest missing piece, but it is not the only one.

Current friction points:
- the orchestrator cannot easily inspect which workers already exist and what state they are in
- the orchestrator cannot explicitly stop a specific worker when the scope is wrong
- parallel work does not have a clean explicit "wait/join these results" control surface
- worker handoffs are not guaranteed to return in a strongly structured shape
- task/run state is more implicit than it should be for multi-step orchestration

Consequence:
- redundant respawns stay more likely than necessary
- recovery after interruption is harder than it should be
- orchestration decisions depend too much on conversational memory instead of explicit controls

So v2.3 should be framed more broadly as **orchestrator capability completion**, not only worker resume.

---

### 6. Some instruction language is now ahead of the exposed tool surface

This is not mainly a "bad prompt" problem. It is a prompt-runtime mismatch.

Current mismatch examples:
- the doctrine says to treat workers as session-scoped handles
- the doctrine says "resume" means continuing the same worker session
- the doctrine strongly implies the orchestrator should reuse prior workers when overlap is high
- but the exposed tool surface may still only guarantee fresh spawn semantics

This creates a confusing failure mode:
- the orchestrator knows the right behavior is "continue that same worker"
- but the operationally available action is "spawn another worker"
- so the result can look like instruction failure when it is really capability mismatch

v2.3 should either:
- make the runtime/tool surface satisfy that doctrine directly, or
- soften the doctrine until the capability truly exists

---

### 7. Delegation and convergence guidance are better, but still somewhat under-specified

v2.2 improved dispatch behavior a lot, especially around Explore-first delegation.

Remaining ambiguity:
- where exactly the line sits between a tiny direct action and worker dispatch
- how strongly the orchestrator should prefer reuse over fresh spawn in borderline cases
- what the clean default is after launching parallel workers: wait, synthesize partials, or continue answering side questions first

This is smaller than the runtime gaps above, but still worth capturing as instruction-level feedback for v2.3.

---

### 8. The orchestrator still lacks a strong enough control plane for active work

Beyond worker resume, there is still a broader control-plane weakness:
- it is not explicit enough which worker results already exist
- it is not explicit enough which results have been synthesized vs merely returned
- worker completion and overall objective completion are still too easy to blur together
- interruptions still create unnecessary ambiguity about what the main thread should return to next

The result is that orchestration truth still depends too much on conversational continuity and not enough on explicit run-state.

This is probably the deeper issue underneath several of the symptoms above.

---

## Candidate v2.3 issues

---

### V23-001 — No first-class way to continue an earlier worker session

- **Symptom**: A follow-up that strongly overlaps an earlier worker's scope cannot be naturally sent back to that same worker session.
- **Expected**: The orchestrator can continue a previous worker regardless of original worker type when continuity is the right action.
- **Actual**: Worker follow-up is too spawn-oriented. The orchestrator may need to recreate the same split with new workers or absorb the work itself.
- **Severity**: high
- **Likely layer**: runtime / tool surface / session state
- **Why it matters**: This is a structural orchestration gap, not just a wording issue.
- **Suggested fix direction**: Add true worker-resume semantics and make previous workers addressable as persistent session-scoped collaborators.

---

### V23-002 — Orchestrator doctrine now outruns worker runtime capabilities

- **Symptom**: The orchestrator is instructed to maintain continuity and reuse existing work, but the worker interface still makes fresh spawn the easiest action.
- **Expected**: Prompt doctrine and runtime capability should match.
- **Actual**: Some "bad orchestration" outcomes are actually the product of missing runtime affordances.
- **Severity**: medium-high
- **Likely layer**: prompt + runtime boundary
- **Suggested fix direction**: Reduce reliance on prompt-only continuity rules where the runtime should provide explicit support.

---

### V23-003 — Worker identity/discoverability is not explicit enough in durable state

- **Symptom**: Worker reuse and continuity depend too much on conversational context and not enough on explicit known-worker state.
- **Expected**: The orchestrator should be able to reliably know which workers exist, what they were for, and whether they are still resumable.
- **Actual**: Workers exist operationally, but their continuity model is not first-class enough.
- **Severity**: medium
- **Likely layer**: session state / recovery / orchestration plumbing
- **Suggested fix direction**: Promote worker handles, purpose, and resumability into explicit durable session state.

---

### V23-004 — No clear default policy for overlapping follow-up work

- **Symptom**: When a user asks a follow-up on an earlier worker's topic, the system has no strong product-default answer for whether to resume or respawn.
- **Expected**: Overlapping follow-up work should usually continue the same worker; fresh spawn should be intentional.
- **Actual**: The decision is under-specified and easy to get wrong.
- **Severity**: medium
- **Likely layer**: prompt / product behavior
- **Suggested fix direction**: Make resume the default for strong overlap, with explicit exceptions for second opinions, stale context, or reframed tasks.

---

### V23-005 — No first-class worker registry or status-query surface

- **Symptom**: The orchestrator cannot cleanly ask "which workers already exist and what state are they in?" as an explicit runtime action.
- **Expected**: The orchestrator can discover known workers, their role, status, and resumability without transcript archaeology.
- **Actual**: Worker awareness is too implicit, which makes reuse and recovery less reliable.
- **Severity**: high
- **Likely layer**: runtime / session state / tool surface
- **Suggested fix direction**: Add a worker registry or status-query capability, or expose the equivalent through durable session state in a way the orchestrator can reliably use.

---

### V23-006 — No explicit way to cancel or replace a specific worker

- **Symptom**: When a worker is scoped wrong, stale, or no longer needed, the orchestrator lacks a crisp targeted control for stopping just that worker.
- **Expected**: The orchestrator can cancel a specific worker and either rescope or replace it deliberately.
- **Actual**: Worker lifecycle control is weaker than it should be for parallel orchestration.
- **Severity**: medium
- **Likely layer**: runtime / tool surface
- **Suggested fix direction**: Add per-worker cancellation/kill semantics so orchestration can correct mistakes without broad collateral effects.

---

### V23-007 — No explicit wait/join primitive for parallel worker orchestration

- **Symptom**: Parallel workers can be launched, but the orchestrator lacks a clean first-class primitive for "wait for these workers, then synthesize."
- **Expected**: Parallel orchestration should have an explicit join point rather than relying only on notifications or ad hoc timing.
- **Actual**: Coordination remains more implicit than ideal.
- **Severity**: medium
- **Likely layer**: runtime / tool surface
- **Suggested fix direction**: Add a wait/join capability for selected workers, or an equivalent orchestration primitive that makes parallel convergence explicit.

---

### V23-008 — Worker result handoffs are not structured enough by default

- **Symptom**: Worker outputs can be useful but uneven, which makes synthesis and verification more fragile than necessary.
- **Expected**: Non-trivial worker handoffs should reliably include what was inspected, what changed, what checks ran, blockers, and final verdict.
- **Actual**: The orchestrator may need extra follow-up just to determine whether the worker actually completed the intended job.
- **Severity**: medium
- **Likely layer**: worker contract / prompt + runtime result shape
- **Suggested fix direction**: Standardize stronger handoff metadata for implementation and verification tasks while keeping exploration outputs lightweight.

---

### V23-009 — Task/run state is still too implicit for multi-step orchestration

- **Symptom**: The orchestrator can carry the objective conversationally, but there is not enough explicit task-state support for active objective, pending synthesis, and completed subgoals.
- **Expected**: Multi-step orchestration should have durable run-state support, not just transcript continuity.
- **Actual**: Interruptions, compaction, and side questions can still create unnecessary ambiguity.
- **Severity**: medium
- **Likely layer**: session state / orchestration plumbing
- **Suggested fix direction**: Strengthen explicit run-state/task-state support so orchestration truth does not depend only on the conversational thread.

---

### V23-010 — Prompt doctrine implies stronger worker-resume capability than the tool surface guarantees

- **Symptom**: The orchestrator is told to treat workers as session-scoped handles and to preserve continuity, but it may not actually have a first-class resume/send-message operation for prior workers.
- **Expected**: Either the doctrine matches the exposed capability exactly, or the capability exists to support the doctrine.
- **Actual**: The prompt can imply "continue that same worker" while the actual available action is still "spawn a new worker."
- **Severity**: high
- **Likely layer**: prompt/runtime boundary
- **Suggested fix direction**: Align prompt doctrine with the true tool surface, ideally by adding first-class worker resume capability rather than weakening the orchestration model.

---

### V23-011 — Parallel-orchestration doctrine defines dispatch more clearly than convergence

- **Symptom**: The instructions encourage parallelism when ownership is clear, but give less explicit guidance for waiting, joining, partial synthesis, or interruption handling after dispatch.
- **Expected**: The orchestrator should have a clearer default model for converging parallel branches.
- **Actual**: Dispatch is well-described; convergence is still more implicit than ideal.
- **Severity**: medium
- **Likely layer**: prompt / orchestration doctrine
- **Suggested fix direction**: Add a sharper convergence rule in doctrine and, where possible, back it with explicit runtime primitives.

---

### V23-012 — No explicit surface for recent worker results and synthesis state

- **Symptom**: The orchestrator can receive useful worker results, but it is not explicit enough which results already exist, which ones have already been synthesized, and which ones are still pending synthesis.
- **Expected**: The control plane should make recent worker results and synthesis-pending state explicit, so solved work is not accidentally redispatched or ignored.
- **Actual**: Worker-result handling depends too much on conversational memory and local inference.
- **Severity**: medium-high
- **Likely layer**: session state / orchestration control plane
- **Suggested fix direction**: Track recent worker results and their synthesis status explicitly in durable run-state.

---

### V23-013 — Worker completion and objective completion are not distinct enough in orchestration state

- **Symptom**: A worker can complete its bounded assignment, but that does not necessarily mean the user's overall objective is complete. The system does not make that distinction explicit enough.
- **Expected**: The control plane should clearly separate worker done, synthesis pending, verification pending, and overall objective done/blocked.
- **Actual**: Those layers can blur together, especially in multi-step runs.
- **Severity**: medium
- **Likely layer**: session state / orchestration model
- **Suggested fix direction**: Add stronger run-state semantics for subtask completion versus overall objective completion.

---

### V23-014 — Interruption recovery is still too dependent on conversational continuity

- **Symptom**: When the user asks a side question mid-run, the orchestrator can answer it, but reliably returning to pending worker results, pending synthesis, or unfinished main work still depends too much on prompt discipline.
- **Expected**: The system should preserve a strong “what was in progress and what comes next” model across ordinary interruptions.
- **Actual**: Recovering the main thread after side conversation is better than before, but still more fragile than it should be.
- **Severity**: medium
- **Likely layer**: prompt + run-state/control-plane support
- **Suggested fix direction**: Strengthen explicit pending-work state so the orchestrator can return to the main objective from durable truth, not just conversational momentum.

---

## v2.3 theme recommendation

**Recommended theme:** make workers feel like persistent collaborators, and make the orchestrator feel fully equipped to manage them.

That means v2.3 should center on:
- resumable workers
- stronger worker identity in session state
- worker registry and lifecycle controls
- explicit parallel convergence primitives
- stronger worker handoff contracts
- prompt/runtime alignment for worker continuity
- stronger run-state and synthesis-state control
- cleaner continuity after interruption or compaction
- clearer orchestrator defaults for reuse vs fresh spawn

This is a better v2.3 framing than treating the whole milestone as a single feature doc.

---

## Recommended scope for v2.3

### In scope
- Add worker continuation/resume capability
- Make worker identity and resumability explicit in durable state
- Add clearer worker discovery/status capabilities
- Add better worker lifecycle controls where needed
- Add explicit convergence support for parallel worker flows
- Tighten worker handoff/result contracts for non-trivial tasks
- Align instruction language with actual worker/runtime capabilities
- Strengthen explicit run-state for worker results, synthesis, and overall objective progress
- Update orchestrator doctrine to use resume by default when overlap is high
- Ensure recovery/compaction paths preserve worker continuity metadata

### Out of scope
- Broad UI redesign
- New worker taxonomies
- Major rewrite of prompt architecture
- Fancy autonomous worker scheduling beyond continuity needs

---

## Success criteria

v2.3 should feel successful if:
- the user can naturally ask to continue "the same worker"
- the orchestrator can actually do that
- the orchestrator can clearly see what workers exist and what state they are in
- the orchestrator can stop or replace the wrong worker without awkward workarounds
- parallel worker flows have a clear convergence point
- worker handoffs are strong enough that synthesis and verification are reliable
- worker results and synthesis-pending state are explicitly visible to the orchestrator
- worker completion is clearly distinct from overall objective completion
- overlapping follow-ups stop causing redundant respawns
- worker continuity survives ordinary session interruptions
- prompt doctrine and runtime capability feel aligned again, especially around worker continuity and parallel convergence

---

## Recommendation

v2.3 should be framed as a **continuity and orchestration-capability** milestone, not just another prompt pass.

The most important lesson from v2.2 is:
**once Agent Mode starts acting like a real coordinator, the runtime must support persistent worker relationships, explicit run-state, and core orchestration controls directly.**
