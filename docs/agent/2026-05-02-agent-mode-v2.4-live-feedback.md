# Agent Mode v2.4 Feedback (Live Testing)

## Session metadata
- Date: 2026-05-02
- Branch: current working tree
- Runtime baseline: Treat the current live Agent Mode implementation as `v2.4`
- Goal: Capture fresh live-testing feedback for the current Agent Mode runtime after the recent worker-roster, worker-first doctrine, task-system, and spawn-fix follow-ups.

## Evidence status

This document is for **live v2.4 testing feedback**.

Interpretation rules:
- By default, entries are live-behavior observations from testing.
- If an item is later checked against source, add a short `Evidence (verified YYYY-MM-DD)` subsection under that item.
- If code reality and observed behavior differ, keep both:
  - what the tester experienced
  - what the code currently appears to do

Morning-after rule:
- If a note is ambiguous, assume it came from live usage unless it explicitly says it was code-verified.

---

## Current v2.4 baseline

The current working convention for this repository is:

- the current post-v2.3 runtime is treated as `v2.4`
- worker roster wording/tree formatting/naming has had a follow-up implementation pass
- worker-first orchestration doctrine has had a follow-up implementation pass
- task-system unification for agent workers has had a follow-up implementation pass
- the blocking `store is not defined` worker-spawn bug has had a follow-up implementation pass

This is a project convention for the current runtime, not a built-in semantic version label in code.

---

## What to watch during testing

- Worker spawn reliability:
  - Do Explore/coding/verifier workers launch cleanly?
  - If worker launch fails, does the orchestrator recover clearly?
- UI clarity:
  - Is there one clear top-level status owner?
  - Are worker rows readable without raw internal IDs?
- Worker continuity:
  - Do genuinely reusable workers surface when they should?
  - Is stale/non-reusable state labeled honestly?
- Worker lifecycle truth:
  - Is `running` vs `result ready` vs `reviewed` understandable?
  - Does the top-level surface match the worker roster?
- Orchestration posture:
  - Does Agent Mode now feel materially more worker-driven than normal mode?

---

## What worked well
- (to be filled during testing)

---

## Issues observed

### V24-001 — Top-level status is still duplicated after roster UI changes

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
- **Evidence**: fresh live retest on 2026-05-02. Sample:

  ```text
  ✻ Garnishing… (1m 5s · ↓ 2.5k tokens · thought for 2s)
  Tip: Use /btw to ask a quick side question without interrupting Claude's current work
  ◉ Agent Mode workers
  1 active
    └─ @ad0c227a12b1ff891 · Explore · running · Map data and analysis surfaces
  ```

- **Evidence (verified 2026-05-03)**: Source review shows the fix makes `AgentModeWorkerRoster` compact by demoting the roster to a subordinate `Workers` detail while the spinner remains the owner of top-level progress. Automated coverage includes the `AgentModeWorkerRoster` compact rendering test.
- **Suggested fix direction**: decide which surface owns primary session status in Agent Mode and demote or merge the other so the operator does not see two top-level status systems competing.

---

### V24-002 — Worker handle still falls back to raw ID in live usage

- **Symptom**: The worker roster still shows a raw agent ID instead of a human-readable themed handle.
- **Repro steps**:
  - Run Agent Mode in a live task that spawns an `Explore` worker.
  - Observe the worker row in the Agent Mode roster.
- **Expected**: The roster should show a stable human-readable worker name consistent with the intended themed naming system.
- **Actual**: The worker was shown as `@ad0c227a12b1ff891` instead of a friendly handle.
- **Severity**: medium
- **Likely layer**: runtime | ui
- **Evidence**: same fresh live retest sample as above.
- **Evidence (verified 2026-05-03)**: Source review shows `allocateWorkerName` supports an Agent Mode-only generic fallback, `runAgent` enables that fallback only when durable session tracking is active, and tracked launch-failure recording also persists a friendly fallback handle instead of a raw agent ID. Automated coverage includes `workerNames` tests for the `Explore` worker name and custom fallback behavior plus `AgentTool` coverage for failed launch handle persistence.
- **Suggested fix direction**: inspect the live spawn path and handle registration path for `Explore` workers to confirm where friendly naming is still bypassed or lost before UI render.

---

### V24-003 — Extra blank space appears between the worker block and the prompt area

- **Symptom**: The live Agent Mode layout leaves visible empty rows between the worker roster and the input prompt/footer area.
- **Repro steps**:
  - Run Agent Mode with at least one active worker and one completed/result-ready worker.
  - Observe the area between the roster block and the prompt line.
- **Expected**: The space between the worker roster and the prompt should be tight and intentional, without unexplained empty rows.
- **Actual**: The user observed multiple blank rows between the roster and the prompt/footer area.
- **Severity**: low
- **Likely layer**: ui
- **Evidence**: fresh live retest on 2026-05-02. Sample:

  ```text
  ✢ Garnishing… (9m 14s · ↓ 17.8k tokens)
  Tip: Use /btw to ask a quick side question without interrupting Claude's current work
  ◉ Agent Mode workers
  1 active · 1 result ready
    ├─ @ad0c227a12b1ff891 · Explore · result ready · Map data and analysis surfaces
    └─ @a4a2caac2777a0d73 · general-purpose · running · Run integrity audit
  [blank_space1]
  [blank_space2]
  ──────────────────────────────────────────────────────────────────────────────
  ❯
  ```

- **Evidence (verified 2026-05-03)**: Source review shows the compact roster removes its bottom margin while the spinner is visible. Automated coverage asserts `marginBottom` is `0` for that state.
- **Suggested fix direction**: inspect `REPL` layout spacing around the spinner/tip block, worker roster mount, and prompt container to see whether Agent Mode is reserving vertical space twice or leaving a stale spacer when both surfaces render together.

---

### V24-004 — Worker failure/stop state does not propagate truthfully to the roster

- **Symptom**: A worker can show `Tool execution failed` or be stopped by the user, but the Agent Mode roster still leaves related worker entries in misleading active/running states.
- **Repro steps**:
  - Run Agent Mode with multiple workers.
  - Let one worker fail during initialization or execution, or stop it manually with `X`.
  - Compare the inline task/error surface with the Agent Mode roster afterward.
- **Expected**: Once a worker fails or is stopped, the roster should update promptly and truthfully:
  - no stale `running` state for the failed/stopped worker
  - no stale `active` summary count driven by dead entries
  - a clear terminal/error/attention state that matches what the operator just saw
- **Actual**: The user saw:

  ```text
   Agent(Fix OCR pipeline coherence)
  Initializing…
  Tool execution failed
  ```

  but the roster still showed:

  ```text
  ◉ Agent Mode workers
  2 active · 2 reviewed · 1 attention
    ├─ @ac7943fdf0354782f · general-purpose · running · Compute anomalies and p-values
    ├─ @ab4ab4c25b17f3af1 · general-purpose · attention · Fix OCR pipeline coherence
    └─ @a81c44c9d04a5182c · general-purpose · running · Fix OCR pipeline coherence
  ```

  This suggests the visible failure/stop state and the durable worker roster state are not staying in sync.
- **Severity**: high
- **Likely layer**: session-state | recovery | ui
- **Evidence**: fresh live retest on 2026-05-02 from a real Agent Mode run in another workspace.
- **Evidence (verified 2026-05-03)**: Source review shows terminal worker state now removes failed/killed workers from active tracking and surfaces terminal workers as attention/blocker state. Automated coverage includes the `sessionState` terminal failed/killed test, including `activeWorkers` cleanup.
- **Suggested fix direction**: inspect the worker terminal-state update path for:
  - tool execution failure during initialization
  - explicit user stop/cancel via `X`
  - summary-bucket recomputation in the roster
  and ensure failed/stopped workers cannot remain counted as active/running in durable session state.

---

## Candidate v2.4 issues

Use this shape for new issues:

### V24-XXX — Short title

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
- [ ] Did the spawn-fix fully resolve the `store is not defined` bug across non-cat-code workspaces?
- [ ] If worker spawn fails again, does the orchestrator now recover clearly or fail loudly?

---

## Combined verification evidence

- **Automated verification (2026-05-03)**: The coordinator ran the focused suite after Tasks 1-3 in this worktree:

  ```text
  bun test src/agent-mode/workerNames.test.ts src/agent-mode/AgentModeWorkerRoster.test.tsx src/agent-mode/sessionState.test.ts src/agent-mode/workerUxSummary.test.ts src/tools/AgentTool/AgentTool.test.ts src/tools/AgentTool/resumeAgent.test.ts src/commands/goal/goal.test.ts src/tools/UpdateGoalTool/UpdateGoalTool.test.ts src/agent-mode/agentMode.test.ts
  ```

  Result: 65 pass, 0 fail, 176 expect calls.
- **Manual live Agent Mode smoke (2026-05-03)**: Not run in this noninteractive subagent pass. The original live/manual smoke remains pending unless someone runs it separately.

---

## Closure decision

The code/test fix for the listed v2.4 feedback is complete with automated/source evidence recorded on 2026-05-03.

Deferred follow-ups:
- Run manual live Agent Mode smoke in an interactive session before claiming live-smoke completion.
- Continue watching for worker-spawn failures in non-cat-code workspaces, including any recurrence of the prior `store is not defined` class of failure.
