# Agent Mode v2.3 Feedback (Live Testing)

## Session metadata
- Date: 2026-05-02
- Branch: current working tree
- Runtime baseline: Treat the current live Agent Mode implementation as `v2.3`
- Goal: Capture live-testing feedback for the current Agent Mode runtime, especially worker continuity, control-plane behavior, synthesis truthfulness, UI clarity, and worktree/isolation UX.

## Evidence status

This document is for **live v2.3 testing feedback**.

Interpretation rules:
- By default, entries are live-behavior observations from testing.
- If an item is later checked against source, add a short `Evidence (verified YYYY-MM-DD)` subsection under that item.
- If code reality and observed behavior differ, keep both:
  - what the tester experienced
  - what the code currently appears to do

Morning-after rule:
- If a note is ambiguous, assume it came from live usage unless it explicitly says it was code-verified.

---

## Current v2.3 baseline

The current working convention for this repository is:

- Agent Mode resume/continuity behavior is part of `v2.3`
- Durable worker session state is part of `v2.3`
- Worker control-plane tools are part of `v2.3`
- Pending-synthesis tracking is part of `v2.3`
- Agent Mode worker roster / isolated-attempt UX is part of `v2.3`

This is a project convention for the current runtime, not a built-in semantic version label in code.

---

## What to watch during testing

- Worker continuity:
  - Does a follow-up reuse the same worker when overlap is high?
  - Does the system respawn unnecessarily?
- Worker control plane:
  - Does the orchestrator seem aware of known workers, pending results, and stale workers?
  - Does it converge parallel workers cleanly?
- Synthesis truthfulness:
  - Does the main thread clearly distinguish "worker finished" from "objective finished"?
  - Are unsynthesized worker results surfaced clearly?
- UI clarity:
  - Is Agent Mode visibly distinct?
  - Is the worker roster understandable and useful?
- Isolation UX:
  - Do worktree flows feel like isolated attempts rather than user-managed git mechanics?

---

## What worked well
- Live control-plane truth beat stale historical hints in the real session reviewed from JSONL.
  - In session `c1786874-fe55-420e-83f8-c7bc50390eb8`, the orchestrator checked `ListWorkers(activeOnly:false)` near the start of the run and got an empty worker roster.
  - It did not pretend prior workers were safely reusable just because historical/session metadata may have existed elsewhere.
  - This is a real strength if `v2.3` values truthful runtime state over optimistic but potentially false continuity.
  - Tradeoff: this also makes continuity feel weaker from the operator seat, so it should be counted as both a strength in truthfulness and a product gap in resumability UX.

---

## Issues observed

---

## Implementation follow-up (pending retest)

Use this section when a later coding pass claims to address a feedback item, but the fix has not yet been re-validated from the operator seat.

### 2026-05-02 — Goal-aware execution hardening landed in a later implementation pass

Status:
- Reported implemented
- Not yet re-validated by fresh live testing in this feedback log

Reported implementation areas:
- durable Agent Mode objective sync with `/goal`
- goal completion blocked by unresolved worker state
- continuation seeding on resume / restore / budget-limited paths
- more truthful `currentPhase` / `activeWorker` / `nextAction`
- stale worker state reset when goals are cleared, completed, or replaced
- expanded focused test coverage

Reported file set:
- [sessionState.ts](/Users/pt/cat-code/src/agent-mode/sessionState.ts)
- [goal.tsx](/Users/pt/cat-code/src/commands/goal/goal.tsx)
- [AgentTool.tsx](/Users/pt/cat-code/src/tools/AgentTool/AgentTool.tsx)
- [UpdateGoalTool.ts](/Users/pt/cat-code/src/tools/UpdateGoalTool/UpdateGoalTool.ts)
- [threadGoal.ts](/Users/pt/cat-code/src/utils/threadGoal.ts)
- [REPL.tsx](/Users/pt/cat-code/src/screens/REPL.tsx)
- related tests including:
  - [goal.test.ts](/Users/pt/cat-code/src/commands/goal/goal.test.ts)
  - [UpdateGoalTool.test.ts](/Users/pt/cat-code/src/tools/UpdateGoalTool/UpdateGoalTool.test.ts)
  - [threadGoal.test.ts](/Users/pt/cat-code/src/utils/threadGoal.test.ts)
  - [sessionState.test.ts](/Users/pt/cat-code/src/agent-mode/sessionState.test.ts)
  - [AgentTool.test.ts](/Users/pt/cat-code/src/tools/AgentTool/AgentTool.test.ts)

Reported outcomes:
- resumed active goals should continue more reliably
- restored budget-limited goals should seed wrap-up correctly
- unresolved workers should block goal completion
- pending synthesis should derive `verifying`
- failed workers should derive `blocked`
- stale workers from old goals should no longer poison new goals

Retest targets:
- Re-test `V23-008` for whether synthesis state now behaves better from the operator seat, even if the UI wording is still weak.
- Re-test `V23-011` with a real live `/goal` set before starting work.
- Re-test whether restored or resumed goals now continue without dead-idle behavior.
- Re-test whether stale worker state still leaks across goal boundaries in live usage.

Direct impact on existing feedback:

- Likely made partially stale at the **code** level, but still needs live retest:
  - `V23-008` — worker synthesis lifecycle is operationally unclear
    - code now derives `verifying` for pending synthesis and improves `nextAction`
    - this may improve truthfulness, but does not by itself prove the UI is now understandable
  - `V23-011` — “goal-aware” run did not operate under a live `/goal`
    - code now syncs durable objective state more aggressively with `/goal`
    - but the original session remains a partial test, and this item still needs a new live run with a real `/goal`
- Very likely fixed the underlying behavior that was described in the implementation report, but not yet re-validated from the operator seat:
  - continuation drift / dead-idle after resume or restore
  - restored budget-limited wrap-up seeding
  - stale worker leakage across goal boundaries
- Probably unaffected by this patch and should be treated as still current until separately changed:
  - `V23-001` top-level dual UI surfaces
  - `V23-002` tree-style roster formatting
  - `V23-003` stronger worker naming theme
  - `V23-004` ambiguous `pending review` wording
  - `V23-005` mathematically misleading summary counts
  - `V23-006` fresh session did not expose prior reusable workers
  - `V23-007` main thread stayed too involved after Explore spawn
  - `V23-009` no historical worker reuse was even attempted
  - `V23-010` autonomy gain came from exploration parallelism, not delegated implementation
  - `V23-012` verifier worker path was not exercised
  - `V23-013` task creation split across old/new systems
  - `V23-014` Agent Mode not aggressive enough relative to normal mode

Important interpretation:

- This patch materially changes the truth model around goals, worker state, continuation seeding, and session-state phase reporting.
- So some old feedback is now potentially stale as a description of **current code**.
- But none of the live-usage observations should be deleted yet, because they were true when observed and still need fresh retesting to confirm the new behavior from the operator seat.

Important note:
- Keep the original feedback issues even if this patch is correct.
- Only mark an issue resolved after a fresh user-observed run confirms the behavior improved.

---

### V23-001 — Two competing top-level status surfaces in Agent Mode

- **Symptom**: Agent Mode currently shows two different UI/status surfaces at the same time, which makes it unclear which one is the primary source of session state.
- **Repro steps**: Start an Agent Mode session and observe the prompt area while idle or during normal interaction.
- **Expected**: Agent Mode should have one clear primary top-level status surface, or at least a strongly ordered hierarchy between generic status and Agent Mode status.
- **Actual**: The tester observed both of these at once:

```text
✶ Bloviating…
Tip: Use /memory to view and manage Claude memory
◉ Agent Mode · orchestrating workers
  workers: none yet
```

- **Severity**: medium
- **Likely layer**: ui
- **Evidence**: live usage observation on 2026-05-02
- **Suggested fix direction**: undecided; record first, decide later whether generic status, Agent Mode status, or a merged surface should be primary.

---

### V23-002 — Worker roster would read better with tree-style structure

- **Symptom**: The current Agent Mode worker roster is much clearer than before, and the aligned indentation already helps, but the list still reads like flat rows rather than one grouped worker tree.
- **Repro steps**: Start an Agent Mode session with multiple active workers and inspect the roster block, for example:

```text
◉ Agent Mode · orchestrating workers
  workers: 2 active
  @aa86af7374e04dccd · Explore · running · Map agent state and synthesis
  @a516110eb061cfd7c · Explore · running · Map goal and idle paths
```

- **Expected**: Keep the current indentation discipline, but render worker rows with tree-style connectors such as `├─` and `└─` so the block reads as one structured roster under the Agent Mode header.
- **Actual**: The tester reports that the current version already looks good because the lines share the same indent, but still recommends tree markers as a clearer visual structure.
- **Severity**: low
- **Likely layer**: ui
- **Evidence**: live usage observation on 2026-05-02
- **Suggested fix direction**: if this is changed later, preserve the current compactness and alignment while testing whether `├─` / `└─` improves scanability without adding visual clutter.

Implementation follow-up:
- Likely addressed in commit `b3f4988` (`fix: clarify agent mode worker roster`)
- Keep open pending fresh live retest

---

### V23-003 — Worker handles should use a stronger themed naming system

- **Symptom**: Raw worker IDs like `@aa86af7374e04dccd` are hard to read, and even after moving to friendly handles, the naming theme itself affects how memorable and usable the roster feels.
- **Repro steps**: Observe current Agent Mode worker handles in the roster and compare them with the kind of names that would be easier to remember and refer back to in follow-up turns.
- **Expected**: Worker handles should be short, human-readable, and drawn from a deliberate theme that feels distinctive and easy to remember.
- **Actual**: The tester explicitly prefers themed names in the style of `einstein` or `heisenberg` and does not want to settle yet on the final theme, only on the requirement that the theme should feel stronger and more intentional than raw IDs or weak/generic names.
- **Severity**: medium
- **Likely layer**: ui
- **Evidence**: live usage feedback on 2026-05-02
- **Suggested fix direction**: later decide a naming theme first, then make worker-handle generation consistent across worker types using that theme.

Implementation follow-up:
- Likely addressed in commit `b3f4988` (`fix: clarify agent mode worker roster`)
- Keep open pending fresh live retest

---

### V23-004 — “pending review” is ambiguous in the worker roster

- **Symptom**: The roster label `pending review` is not self-explanatory from the operator seat. It is unclear what review is needed, who is expected to do it, and what action the user or orchestrator should take next.
- **Repro steps**: Observe an Agent Mode session after workers complete and the roster shows entries like:

```text
Agent Mode · orchestrating workers
  workers: 0 active · 2 done · 2 pending review
  @aa86af7374e04dccd · Explore · pending review · Map agent state and synthesis
  @a516110eb061cfd7c · Explore · pending review · Map goal and idle paths
```

- **Expected**: The status text should make the meaning operationally obvious, for example by indicating whether the orchestrator still needs to read/synthesize the result, whether the user needs to make a decision, or whether this is only internal state.
- **Actual**: The tester’s immediate reaction was: “there is 2 pending reviews. what is it? what review it need?” That suggests the label does not explain the action model well enough.
- **Severity**: medium
- **Likely layer**: ui
- **Evidence**: live usage feedback on 2026-05-02
- **Suggested fix direction**: later revisit the visible wording for unsynthesized completed workers so the roster communicates the next action, not just the internal state name.

Implementation follow-up:
- Likely addressed in commit `b3f4988` (`fix: clarify agent mode worker roster`)
- Reported code change replaces `pending review` with `result ready`
- Keep open pending fresh live retest

---

### V23-005 — Worker summary counts look mathematically misleading

- **Symptom**: The top-line worker counts appear to mix overlapping categories in a way that reads as false from the operator perspective.
- **Repro steps**: Observe a session after two workers complete and the roster shows:

```text
Agent Mode · orchestrating workers
  workers: 0 active · 2 done · 2 pending review
  @aa86af7374e04dccd · Explore · pending review · Map agent state and synthesis
  @a516110eb061cfd7c · Explore · pending review · Map goal and idle paths
```

- **Expected**: The summary should either:
  - use mutually exclusive buckets, or
  - make the relationship explicit if one count is a subset of another.

  From the tester’s perspective, with only 2 workers spawned total, `2 done` plus `2 pending review` reads as untrue or double-counted.
- **Actual**: The roster presents `done` and `pending review` side by side as if they are separate categories, even though the visible rows suggest the same 2 workers may be contributing to both counts.
- **Severity**: medium
- **Likely layer**: ui
- **Evidence**: live usage feedback on 2026-05-02
- **Suggested fix direction**: later decide whether `pending review` should replace `done` for unsynthesized completed workers, or whether the summary should explicitly show subset semantics instead of parallel bucket semantics.

Implementation follow-up:
- Likely addressed in commit `b3f4988` (`fix: clarify agent mode worker roster`)
- Reported code change replaces overlapping `done` / `pending review` summary semantics with `result ready` / `reviewed`
- Keep open pending fresh live retest

---

### V23-006 — Fresh Agent Mode session did not expose prior reusable workers

- **Symptom**: Cross-session worker continuity did not feel real from the operator perspective. A fresh Agent Mode session behaved as if no prior worker context was available for reuse.
- **Repro steps**:
  - Start a fresh `/agent` session after earlier Agent Mode work has happened in the same project.
  - Inspect the live worker roster behavior at the start of the new run.
  - Compare that with the expectation that resumable/reusable workers are part of current `v2.3`.
- **Expected**: If prior workers are meant to be practically reusable across sessions, the new session should expose them clearly enough that reuse feels available, not merely theoretical.
- **Actual**: In the session JSONL, the orchestrator checked live state early and got an empty worker roster from `ListWorkers`, then spawned fresh Explore workers instead of continuing any prior worker context.
- **Severity**: high
- **Likely layer**: recovery
- **Evidence**: verified from actual session JSONL on 2026-05-02; session `c1786874-fe55-420e-83f8-c7bc50390eb8` started fresh, `ListWorkers(activeOnly:false)` returned `workers: []`, and the run proceeded with fresh Explore spawns.
- **Suggested fix direction**: later decide whether fresh-session reuse should be surfaced more aggressively, restored more reliably, or explicitly scoped down so operator expectations match product reality.

#### Evidence (verified 2026-05-02)

- Session file: `/Users/pt/.cat-code/projects/-Users-pt-cat-code/c1786874-fe55-420e-83f8-c7bc50390eb8.jsonl`
- `2026-05-02T06:01:00.082Z`: the run begins with `Started a fresh Agent mode session.`
- `2026-05-02T06:01:20.920Z`: the orchestrator calls `GetGoal`
- `2026-05-02T06:01:20.973Z`: the orchestrator calls `ListWorkers(activeOnly:false)`
- `2026-05-02T06:01:20.989Z`: the `ListWorkers` result is `{"objective":"","currentPhase":"planning","nextAction":"","workers":[]}`
- `2026-05-02T06:01:42.451Z` and `2026-05-02T06:01:42.452Z`: instead of continuing prior workers, the orchestrator spawns two fresh `Explore` workers

Operator implication:
- the practical feeling of “v2.3 resumable workers” is weak if a fresh session immediately looks empty and falls back to new workers
- even if historical worker metadata exists elsewhere, it did not surface here in a way the operator could benefit from

---

### V23-007 — Main thread stayed too involved after spawning Explore workers

- **Symptom**: After spawning investigative workers, the main thread still did substantial local reading and grep work. This can make orchestration feel too main-thread-heavy and reduce the visible benefit of parallel delegation.
- **Repro steps**:
  - Start a task that clearly justifies broad exploratory delegation.
  - Observe what the main thread does after workers are launched.
  - Compare whether post-spawn activity feels like useful orchestration or duplicated investigation.
- **Expected**: After spawning bounded Explore workers, the main thread should mainly coordinate, synthesize, or handle non-overlapping critical-path work.
- **Actual**: In the session JSONL, after the two Explore workers were launched, the main thread continued substantial file reads and searches across `sessionState`, `agentMode`, worker tools, and `REPL.tsx` rather than shifting cleanly into a lighter orchestration role.
- **Severity**: medium
- **Likely layer**: prompt
- **Evidence**: verified from actual session JSONL on 2026-05-02; post-spawn main-thread reads/greps continued across multiple owner files while the Explore workers were active.
- **Suggested fix direction**: later decide whether Agent Mode should more strongly discourage overlapping main-thread investigation once bounded Explore workers are already running.

#### Evidence (verified 2026-05-02)

- Workers were spawned at `06:01:42Z` for:
  - `Map goal and idle paths`
  - `Map agent state and synthesis`
- After that spawn point, the main thread still performed broad investigation locally, including reads/greps touching:
  - `/Users/pt/cat-code/src/agent-mode/agentMode.ts`
  - `/Users/pt/cat-code/src/agent-mode/sessionState.ts`
  - `/Users/pt/cat-code/src/tools/GetWorkerResultTool/GetWorkerResultTool.ts`
  - `/Users/pt/cat-code/src/tools/WaitWorkersTool/WaitWorkersTool.ts`
  - `/Users/pt/cat-code/src/tools/ListWorkersTool/ListWorkersTool.ts`
  - `/Users/pt/cat-code/src/agent-mode/workerUxSummary.ts`
  - `/Users/pt/cat-code/src/screens/REPL.tsx`
- Example timestamps:
  - `06:05:01Z`: main-thread reads of `agentMode.ts`, `sessionState.ts`, `GetWorkerResultTool.ts`, `REPL.tsx`
  - `06:05:07Z`: main-thread greps around worker/session/REPL behaviors
  - `06:06:54Z` to `06:06:58Z`: additional targeted reads in `REPL.tsx`

Operator implication:
- the session does show parallelism, but the orchestrator still looks busy doing investigative work itself
- this makes the benefit of Explore workers feel partial rather than decisive
- worth deciding whether this is good “critical-path synthesis work” or unnecessary overlap

Open interpretation:
- this may be acceptable if the main-thread work was truly non-overlapping or needed to integrate worker findings
- but from the outside, it can also read as “spawn workers, then keep doing the same kind of investigation anyway”

Implementation follow-up:
- Likely addressed by prompt/doctrine changes in commits `9236a36` and `4fe8b18`
- Reported changes explicitly tell Agent Mode not to spawn Explore and then keep doing overlapping repo reads/searches on the main thread
- Keep open pending fresh live retest

---

### V23-008 — Worker synthesis lifecycle is operationally unclear

- **Symptom**: The completed-worker lifecycle is too implicit. The system distinguishes between “worker result retrieved” and “worker result synthesized,” but that distinction is not obvious enough from the operator seat.
- **Repro steps**:
  - Run parallel workers to completion.
  - Observe how results are read and when they transition out of unsynthesized state.
  - Compare the internal lifecycle with what the UI/status language makes understandable.
- **Expected**: The lifecycle from worker completion to result consumption to synthesis should be easy to understand operationally.
- **Actual**: In the session JSONL, the orchestrator first called `GetWorkerResult(..., markSynthesized:false)` and only later called `GetWorkerResult(..., markSynthesized:true)` for both workers. That confirms synthesis is a separate explicit step, but the live UI/status language does not make that model feel clear.
- **Severity**: medium
- **Likely layer**: ui
- **Evidence**: verified from actual session JSONL on 2026-05-02; worker results were first read unsynthesized, then later marked synthesized explicitly.
- **Suggested fix direction**: later make the visible status model explain whether a completed worker has merely finished, has had its result read, or has actually been synthesized into the orchestrator’s judgment.

#### Evidence (verified 2026-05-02)

- `2026-05-02T06:04:50.154Z`: the orchestrator calls `GetWorkerResult(worker:"aa86af7374e04dccd", markSynthesized:false)`
- later, near final integration:
  - `2026-05-02T06:09:37.709Z`: `GetWorkerResult(worker:"aa86af7374e04dccd", markSynthesized:true)`
  - `2026-05-02T06:09:37.710Z`: `GetWorkerResult(worker:"a516110eb061cfd7c", markSynthesized:true)`

What this proves:
- worker completion and worker synthesis are not the same event
- the system has a real intermediate state where a worker is done but not yet synthesized into orchestrator judgment

Why this matters for feedback:
- this state model is structurally important to `v2.3`
- if the UI only says something like `pending review`, the operator still does not know whether:
  - the worker has merely finished
  - the orchestrator has read the result
  - the orchestrator has integrated the result into the session’s actual decision-making

Operator implication:
- the JSONL supports the claim that the lifecycle is real
- the live surface still does not explain that lifecycle well enough

---

### V23-009 — No historical worker reuse was even attempted in the real run

- **Symptom**: The practical user experience was not “reuse failed,” but “reuse never really entered the flow.” That matters because resumability can appear stronger in theory than in live operation.
- **Repro steps**:
  - Start a fresh Agent Mode session after earlier related work.
  - Observe whether the run attempts to continue a prior worker, message a prior worker, or otherwise surface reuse as a live option.
- **Expected**: If resumable workers are a meaningful `v2.3` behavior, live runs should make reuse feel like a normal path when context overlap is high.
- **Actual**: In the session JSONL, no historical worker resume/send-message path was attempted. The run checked live roster state, found no workers, and moved directly to fresh worker creation.
- **Severity**: medium
- **Likely layer**: recovery
- **Evidence**: verified from actual session JSONL on 2026-05-02; the run showed fresh-session state checks and new `Agent` spawns, but no old-worker reuse attempt.
- **Suggested fix direction**: later decide whether this is acceptable product truth or whether Agent Mode should surface stronger “continue previous worker” behavior when overlap is obvious.

#### Evidence (verified 2026-05-02)

- The beginning of the session shows this sequence:
  - `GetGoal`
  - `ListWorkers(activeOnly:false)`
  - empty worker roster result
  - fresh `Agent` spawns for two Explore workers
- In the actual session JSONL examined for this task, I found:
  - fresh worker creation
  - later `GetWorkerResult`
  - no `SendMessage`-style continuation of an older worker
  - no visible attempt to continue a prior worker from earlier sessions

Why this issue is separate from `V23-006`:
- `V23-006` is about the system not surfacing prior reusable workers in a fresh session
- `V23-009` is about the live operator flow never even presenting reuse as an active decision path in this run

Operator implication:
- the experience is not “I tried reuse and it failed”
- the experience is “reuse was not really in play”
- that is a weaker practical story than the product language around resumability may suggest

---

### V23-010 — Real autonomy gain came from exploration parallelism, not delegated implementation

- **Symptom**: On a real project task, Agent Mode used subagents for investigation but kept implementation on the main thread. That may be the right call, but it means the practical autonomy benefit felt narrower than “the agent really handled the work.”
- **Repro steps**:
  - Give Agent Mode a real repo-improvement task with both investigation and implementation phases.
  - Observe whether it delegates only research or also delegates meaningful implementation work.
- **Expected**: Depending on product goals, Agent Mode might be expected to delegate some implementation work too when that produces a clearer autonomy win.
- **Actual**: In the session JSONL, the only worker spawns were the two Explore workers. The code edits, focused test runs, diff review, and final integration all stayed on the main thread.
- **Severity**: medium
- **Likely layer**: prompt
- **Evidence**: verified from actual session JSONL on 2026-05-02; no coding-worker spawn occurred in this run.
- **Suggested fix direction**: later decide whether this should remain normal for narrow patches, or whether Agent Mode should be more willing to delegate bounded implementation work to make autonomy more tangible.

#### Evidence (verified 2026-05-02)

- Worker creation in the session was limited to two `Explore` spawns at `06:01:42Z`
- After the investigation phase, the rest of the run stayed on the main thread:
  - local source inspection
  - local diff review
  - local test execution
  - final synthesis and reporting
- Examples from the session:
  - `06:09:23Z` and `06:09:24Z`: main-thread test runs via `Bash`
  - `06:09:31Z`: main-thread diff review and source reads around changed files
  - no later worker spawn for bounded implementation or verification ownership

Why this matters:
- the run was still useful, because Explore parallelism helped map the problem
- but the autonomy win came mainly from investigative parallelism, not from handing off implementation execution

Operator implication:
- if the goal for Agent Mode is “feel materially more autonomous on real project work,” this session only partially delivered that
- if the goal is “delegate when delegation clearly pays off, otherwise keep a narrow patch local,” then this may be acceptable

Open interpretation:
- this is not automatically a bug
- it is a product-direction question about how much delegated implementation you want to normalize in `v2.3`

Implementation follow-up:
- Likely addressed by prompt/doctrine changes in commits `9236a36` and `4fe8b18`
- Reported changes make coding workers the default implementation owner once work exceeds a tiny pass, and push prompt/session-state/orchestration patches toward coding workers even when single-file
- Keep open pending fresh live retest

---

### V23-011 — “Goal-aware” run did not operate under a live `/goal`

- **Symptom**: The session was framed as a test of goal-aware autonomous execution, but it did not actually start with a live thread goal set through `/goal`.
- **Repro steps**:
  - Start a fresh Agent Mode session for a task intended to validate goal-aware behavior.
  - Observe whether the session first establishes a real `/goal` before testing worker alignment, continuation, synthesis, and completion behavior.
- **Expected**: A real test of goal-aware behavior should ideally run with an actual live `/goal` already in force, so the test exercises the same state the product is meant to coordinate around.
- **Actual**: In the reviewed JSONL session, the orchestrator called `GetGoal` early and got `{"goal": null}`. The run then proceeded with investigation, worker spawning, implementation, and verification without ever starting from a live goal state.
- **Severity**: medium
- **Likely layer**: session-state
- **Evidence**: verified from actual session JSONL on 2026-05-02; `GetGoal` returned null near the start of the run and the task proceeded anyway.
- **Suggested fix direction**: not necessarily a product fix yet; first decide whether Agent Mode should insist on a real `/goal` for goal-aware tasks, or whether this should simply be documented as a test-validity limitation when evaluating such runs.

#### Evidence (verified 2026-05-02)

- `2026-05-02T06:01:20.920Z`: `GetGoal`
- `2026-05-02T06:01:20.988Z`: tool result `{"goal":null}`
- The rest of the run then continued into top-level reading, Explore worker creation, implementation, tests, and final reporting

Why this matters:
- this means the session tested important goal-related code paths, but not the strongest end-to-end product path of “live `/goal` drives the whole task”
- if we later judge this run as evidence about `/goal`-based coordination, we should be explicit that it was only a partial test

---

### V23-012 — Verifier worker path was not exercised in a real completion flow

- **Symptom**: The session did verify work, but it did not use a verifier worker. That means the run did not fully exercise the intended role split between Explore, coding, and verifier behavior.
- **Repro steps**:
  - Give Agent Mode a real task with investigation, code changes, and end-of-task verification.
  - Observe whether completion goes through a dedicated verifier-worker path or stays entirely on the main thread.
- **Expected**: If verifier-worker behavior is part of the intended Agent Mode model, a meaningful completion flow should sometimes route through that dedicated role rather than relying only on main-thread tests and judgment.
- **Actual**: In the reviewed session JSONL, only two `Explore` workers were spawned. Verification happened on the main thread through focused test runs, diff inspection, and final synthesis. No verifier worker was spawned.
- **Severity**: medium
- **Likely layer**: prompt
- **Evidence**: verified from actual session JSONL on 2026-05-02; the run included main-thread test execution and result synthesis, but no verifier-worker creation.
- **Suggested fix direction**: later decide whether verifier usage should be expected by doctrine for tasks of this shape, or whether verifier-role invocation should remain selective and only trigger under certain complexity/risk thresholds.

#### Evidence (verified 2026-05-02)

- Worker creation in the session was limited to two `Explore` spawns at `06:01:42Z`
- Main-thread verification examples:
  - `2026-05-02T06:09:23.982Z`: focused `bun test` run for goal and session-state tests
  - `2026-05-02T06:09:24.011Z`: focused `bun test` run for worker-state tests
  - `2026-05-02T06:09:31Z`: local diff review and source inspection around changed files
- No verifier-worker spawn appears in the reviewed session timeline

Why this matters:
- the run did verify changes, so this is not a “no verification happened” bug
- the gap is specifically that the dedicated verifier-role path was not exercised
- if `v2.3` is supposed to demonstrate a clearer role split, this run only partially showed it

Implementation follow-up:
- Likely addressed by prompt/doctrine changes in commits `9236a36` and `4fe8b18`
- Reported changes make verification workers the default review path for multi-file and orchestration/prompt/session-state/worker-control changes
- Keep open pending fresh live retest

---

### V23-013 — Task creation is split across old and new systems and can disappear in Agent Mode flows

- **Symptom**: From the operator perspective, task creation can look missing even though task code exists in the repository. The product currently has more than one task-management path, and they are not aligned cleanly across main-thread and worker execution.
- **Repro steps**:
  - Run non-trivial work in normal interactive chat and in Agent Mode.
  - Observe whether tasks are actually created or updated in a visible, reliable way during the run.
  - Compare main-thread behavior with delegated async-worker behavior.
- **Expected**: If task creation is meant to be part of the product behavior, it should feel consistently available and normal across current live paths, especially in Agent Mode.
- **Actual**: Investigation found that task behavior is currently split:
  - main interactive runtime can use newer v2 task tools such as `TaskCreate`
  - legacy paths still use older `TodoWrite`
  - async Agent Mode worker paths are still tied strongly enough to the old split that in live interactive v2 sessions they can effectively end up without a usable task-management tool
- **Severity**: high
- **Likely layer**: tool surface
- **Evidence**: code investigation completed on 2026-05-02; task creation is not absent everywhere, but it is inconsistent enough that users can honestly experience “the agent does not create tasks.”
- **Suggested fix direction**: unify task-management behavior across the live runtime, especially for async Agent Mode workers, instead of leaving the product split between `TaskCreate` and `TodoWrite`.

#### Evidence (verified 2026-05-02)

What was verified in code:

- The main interactive runtime has newer v2 task tools:
  - [tasks.ts](/Users/pt/cat-code/src/utils/tasks.ts:133)
  - [tools.ts](/Users/pt/cat-code/src/tools.ts:220)
  - [TaskCreateTool.ts](/Users/pt/cat-code/src/tools/TaskCreateTool/TaskCreateTool.ts:48)
- The older task-writing path still exists separately:
  - [TodoWriteTool.ts](/Users/pt/cat-code/src/tools/TodoWriteTool/TodoWriteTool.ts:31)
- Prompt guidance appears to soft-suggest task creation rather than strongly require it:
  - [prompts.ts](/Users/pt/cat-code/src/constants/prompts.ts:290)
  - [prompts.ts](/Users/pt/cat-code/src/constants/prompts.ts:623)
- Async agent allowed-tool wiring still reflects the split strongly enough that workers can miss usable v2 task tooling:
  - [tools.ts](/Users/pt/cat-code/src/constants/tools.ts:64)
  - [agentToolUtils.ts](/Users/pt/cat-code/src/tools/AgentTool/agentToolUtils.ts:113)
  - [runAgent.ts](/Users/pt/cat-code/src/tools/AgentTool/runAgent.ts:536)
- Remote and non-interactive surfaces still show migration lag:
  - [RemoteAgentTask.tsx](/Users/pt/cat-code/src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:371)
  - [RemoteAgentTask.tsx](/Users/pt/cat-code/src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:720)

Simple interpretation:
- task creation is not globally missing
- but the product is still split between old and new task systems
- because of that split, live Agent Mode can easily fail to make task creation feel real or reliable

Why this matters:
- it explains why the user’s experience can honestly be “Agent Mode does not create tasks” even though task-related code exists
- this is not just a prompt weakness; there is a real runtime and tool-surface inconsistency underneath

Implementation follow-up:
- Likely addressed in commit `f5b7a1e` (`fix: unify task management for agent workers`)
- Reported code change gives async agent paths access to the v2 task tools and updates remote task projection logic to understand v2 task events
- Keep open pending fresh live retest

---

### V23-014 — Agent Mode orchestration posture does not feel aggressive enough relative to normal mode

- **Symptom**: The user expects Agent Mode to feel materially more aggressive than normal chat in delegation, worker usage, and overall orchestration posture. In the reviewed real run, Agent Mode did use workers, but still felt too conservative.
- **Repro steps**:
  - Run a real non-trivial repo task in Agent Mode.
  - Compare its behavior against the expected “stronger than normal mode” posture.
  - Observe whether the run clearly escalates into broader delegation, coding-worker use, verifier-worker use, and stronger worker-driven execution, or whether it still feels close to normal chat with only mild extra delegation.
- **Expected**: Agent Mode should feel distinctly more orchestration-forward than normal chat:
  - earlier worker use
  - stronger default toward delegation
  - clearer separation between main-thread synthesis and worker execution
  - more obvious use of coding/verifier roles when the task warrants them
- **Actual**: The reviewed session did spawn two `Explore` workers early, so Agent Mode was not passive. But it still:
  - kept substantial investigation on the main thread after worker spawn
  - did not delegate implementation to a coding worker
  - did not delegate verification to a verifier worker
  - therefore felt more like “normal mode plus some Explore usage” than a strongly more aggressive orchestrator
- **Severity**: medium
- **Likely layer**: prompt
- **Evidence**: mixed evidence from both prompt inspection and actual session JSONL on 2026-05-02; prompt doctrine claims stronger delegation than normal mode, but the observed run still felt conservative.
- **Suggested fix direction**: strengthen the practical Agent Mode contract so real runs default more clearly toward worker-owned investigation, implementation, and verification, instead of leaving too much room for conservative main-thread execution.

#### Evidence (verified 2026-05-02)

Prompt-side evidence:

- The Agent Mode orchestrator prompt explicitly claims a stronger posture in [orchestratorPrompt.ts](/Users/pt/cat-code/src/agent-mode/orchestratorPrompt.ts:4):
  - “stronger orchestration posture and earlier, more natural subagent use”
  - “Delegate earlier than normal chat”
  - “Parallelism is the default”
  - “You are a coordinator, not the default codebase explorer”
- It also explicitly says certain work should be delegated:
  - substantial implementation work → coding worker
  - independent review of non-trivial implementation batches → verification worker
  - see [orchestratorPrompt.ts](/Users/pt/cat-code/src/agent-mode/orchestratorPrompt.ts:87)

Why the prompt may still feel soft in practice:

- The same prompt leaves broad room for local execution:
  - inline planning and synthesis stay local
  - tiny and low-ambiguity edits stay local
  - splitting is discouraged when synthesis cost seems larger than delegation benefit
  - see [orchestratorPrompt.ts](/Users/pt/cat-code/src/agent-mode/orchestratorPrompt.ts:94) and [orchestratorPrompt.ts](/Users/pt/cat-code/src/agent-mode/orchestratorPrompt.ts:127)
- Shared prompt guidance outside the dedicated Agent Mode prompt is also still cautious about subagent overuse:
  - [prompts.ts](/Users/pt/cat-code/src/constants/prompts.ts:339)
  - [prompts.ts](/Users/pt/cat-code/src/constants/prompts.ts:389)
  - [prompts.ts](/Users/pt/cat-code/src/constants/prompts.ts:633)

Session-side evidence:

- In the reviewed JSONL run:
  - two `Explore` workers were spawned early
  - the main thread still performed substantial local investigation afterward
  - no coding worker was spawned
  - no verifier worker was spawned

Interpretation:
- Agent Mode is definitely more delegation-oriented than normal mode in doctrine
- but the real behavioral gap may still be too small from the user’s perspective
- the current posture can read as “slightly more agentic normal chat” rather than a clearly more assertive orchestration mode

Important nuance:
- the specific user prompt for that session also pushed toward a narrow, careful, one-pass fix, which likely made local implementation easier to justify
- so this is not purely a prompt bug in Agent Mode
- but the live doctrine still appears permissive enough that conservative execution remains common

Implementation follow-up:
- Likely addressed by prompt/doctrine changes in commits `9236a36` and `4fe8b18`
- Reported changes explicitly say Agent Mode should feel more aggressive than normal chat by moving execution outward sooner
- Keep open pending fresh live retest

---

### V23-015 — Top-level status is still duplicated after roster UI changes

- **Symptom**: The live Agent Mode surface still presents two competing top-level status areas at once.
- **Repro steps**:
  - Run a fresh Agent Mode task after the recent roster/UI fixes.
  - Wait until a worker is active.
  - Observe the top of the UI.
- **Expected**: There should be one clear primary top-level status surface, or a clearly subordinate secondary line that does not read like duplicate status.
- **Actual**: The user still sees both:
  - `✻ Garnishing… (1m 5s · ↓ 2.5k tokens · thought for 2s)`
  - `◉ Agent Mode workers`
  This still reads as duplicated status ownership rather than one unified surface.
- **Severity**: medium
- **Likely layer**: ui
- **Evidence**: fresh live retest from user after the recent follow-up fixes. Sample:

  ```text
  ✻ Garnishing… (1m 5s · ↓ 2.5k tokens · thought for 2s)
  Tip: Use /btw to ask a quick side question without interrupting Claude's current work
  ◉ Agent Mode workers
  1 active
    └─ @ad0c227a12b1ff891 · Explore · running · Map data and analysis surfaces
  ```

- **Suggested fix direction**: decide which surface owns primary session status in Agent Mode and demote or merge the other so the operator does not see two top-level status systems competing.

Implementation follow-up:
- This is a fresh post-fix retest result.
- Earlier roster/UI changes did not fully resolve the original duplicate-status complaint.
- Keep open.

---

### V23-016 — Worker handle still falls back to raw ID in live usage

- **Symptom**: The worker roster still shows a raw agent ID instead of a human-readable themed handle.
- **Repro steps**:
  - Run Agent Mode in a live task that spawns an `Explore` worker.
  - Observe the worker row in the Agent Mode roster.
- **Expected**: The roster should show a stable human-readable worker name consistent with the intended themed naming system.
- **Actual**: The worker was shown as `@ad0c227a12b1ff891` instead of a friendly handle.
- **Severity**: medium
- **Likely layer**: runtime | ui
- **Evidence**: same fresh live retest sample as above:

  ```text
  ◉ Agent Mode workers
  1 active
    └─ @ad0c227a12b1ff891 · Explore · running · Map data and analysis surfaces
  ```

- **Suggested fix direction**: inspect the live spawn path and handle registration path for `Explore` workers to confirm where friendly naming is still bypassed or lost before UI render.

Implementation follow-up:
- This is a fresh post-fix retest result against the earlier naming work.
- It suggests the naming improvements are not applied consistently across all live worker spawn paths.
- Keep open.

---

## Candidate v2.3 issues

Use this shape for new issues:

### V23-XXX — Short title

- **Symptom**:
- **Repro steps**:
- **Expected**:
- **Actual**:
- **Severity**: low | medium | high
- **Likely layer**: prompt | runtime | ui | session-state | tool surface | recovery
- **Evidence**:
- **Suggested fix direction**:

---

## Open questions
- [ ] (to be filled during testing)

---

## Closure decision

Leave this blank until you explicitly decide whether the current `v2.3` milestone is:

- complete
- incomplete
- complete with deferred follow-ups
