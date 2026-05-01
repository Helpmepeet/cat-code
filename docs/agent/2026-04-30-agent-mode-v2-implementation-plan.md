# Agent Mode V2 Implementation Plan

**Status:** Active — created 2026-04-20  
**Purpose:** Step-by-step implementation plan for V2. Design baseline is in `docs/agent/2026-04-30-agent-mode-v2-plan.md`.

---

## Phase 0 — Blast radius (already mapped, no further research needed)

### Framing — what the core implementation actually is

The central unresolved V1→V2 contradiction is the **V1 control plane**:
- `src/agent-mode/orchestrator.ts`
- `src/agent-mode/runLedger.ts`
- dependent resume / compaction / status / REPL paths that still assume a bounded run workflow

That means:
- Phase 1 and Phase 2 are **prep/alignment**, not the main implementation
- Phase 3+4 is the **core implementation cutover**
- `/agent` entry cleanup is downstream of the state-model/runtime cutover, not a substitute for it

Prompt, role, and entry UX updates are useful, but they do **not** deliver V2 behavior while the V1 control plane is still active underneath.

The full deletion surface for `runLedger` / `orchestrator` / `agentModeContracts` is known:

### Files deleted entirely (Phase 3)
- `src/agent-mode/orchestrator.ts`
- `src/agent-mode/orchestrator.test.ts`
- `src/agent-mode/agentModeContracts.ts`
- `src/agent-mode/runLedger.ts`
- `src/agent-mode/runLedger.test.ts`

### Files that import deleted symbols and need edits (Phase 3)
- `src/agent-mode/agentMode.ts` — gutted (see Phase 3 detail)
- `src/screens/REPL.tsx` — `resumeAgentModeRunId`, `agentModeStatus`, `startAgentModeRun`, `AgentModeStatusSnapshot`
- `src/components/AgentModeStatusHeader.tsx` — consumes `AgentModeStatusSnapshot`
- `src/constants/xml.ts` — V1 work order XML tags
- `src/services/compact/prompt.ts` — `AgentModeCompactState`, `RunStatus`, `ApprovalStatus`, `HandoffBlock`, `VerificationSummary`; also `AGENT_MODE_COMPACT_APPENDIX` and `formatAgentModeState`
- `src/services/compact/compact.ts` — imports `AgentModeCompactState`, `AgentModeCompactionOptions`

### Files with live AGENT_MODE_RESEARCHER references (Phase 2)
- `src/agent-mode/rolePrompts.ts` — `AGENT_MODE_RESEARCHER` export (line 252)
- `src/agent-mode/orchestrator.ts` — uses researcher role (line 941) — deleted in Phase 3 anyway
- `src/tools/AgentTool/builtInAgents.ts` — does NOT currently register researcher (already absent from the agent list), but imports need audit

### Compaction migration risk (addressed by reordering phases)
`compact/prompt.ts` and `compact/compact.ts` have deep coupling to `RunStatus`, `ApprovalStatus`, `HandoffBlock`, `VerificationSummary` from `runLedger.ts`, and `AgentModeCompactState` / `AgentModeCompactionOptions`. Deleting `runLedger.ts` in Phase 3 before session state exists in Phase 4 would leave compaction broken. **Resolution: Phase 3 and Phase 4 are merged into a single atomic phase.** Delete the old files and introduce session state in the same pass, so compaction is never left in a broken state.

---

## Phase 1 — Orchestrator prompt rewrite

**File:** `src/agent-mode/orchestratorPrompt.ts` — rewrite in place

No structural dependencies. Safe to do first. Gets the V2 behavioral stance correct before touching infrastructure.

Changes:
- Remove rigid `plan → approval → execute → verify` framing
- Conversational, non-robotic orchestration stance
- Selective planning (not mandatory on every task)
- Approval only for risk boundaries and plan-mode
- Earlier and more natural subagent spawning
- End-to-end ownership triggered by intent signals ("finish this", "take care of this")
- Compaction recovery section: detect compaction, read session state, resume silently, never ask user "where were we?"
- Power moves doctrine: divergent-convergent, council, debate (available, not hardcoded)

---

## Phase 2 — New worker roles

**File:** `src/agent-mode/rolePrompts.ts`

- Delete `AGENT_MODE_PLANNER` and `AGENT_MODE_RESEARCHER` exports
- Rename `AGENT_MODE_IMPLEMENTOR` → `AGENT_MODE_CODING_WORKER`, update prompt and tool surface
  - Tools: `Read, Edit, Write, Bash, Glob, Grep, ask_orchestrator, Agent (Explore only)`
  - Can spawn Explore agent for deeper investigation
  - Hybrid output: short natural summary + small structured skeleton
- Update `AGENT_MODE_VERIFIER` prompt
  - Trigger: non-trivial implementation batches only (small changes reviewed inline by orchestrator)
  - Output shape updated to match V2

**File:** `src/tools/AgentTool/builtInAgents.ts`
- Remove planner and researcher registrations
- Register 2 new roles: coding worker, verification worker

Note: `ask_orchestrator` not wired yet — placeholder in tool list description only.

---

## Phase 3+4 — Delete V1 state machine + introduce session state (one atomic pass)

Highest-risk phase. Merged to avoid leaving compaction broken between deletions and replacements. Do in one focused pass: introduce new types first, then delete old files and fix all downstream breaks, then wire compaction to the new types.

### V1 behaviors removed in this phase

This phase is not just file migration. It is where the blocking V1 runtime behavior is removed:
- planner worker no longer gates ordinary implementation
- approval is no longer mandatory before every implementation task
- Agent Mode no longer advances through a fixed `planning -> awaiting_approval -> executing -> verifying` run machine
- resume / status / compaction stop depending on run-ledger-first state
- REPL no longer treats Agent Mode primarily as a bounded run that starts from a task and waits on plan approval by default

### Step A — Introduce session state
**New file:** `src/agent-mode/sessionState.ts`

Schema:
- Mode identity
- Current objective + last handoff summary
- Active named workers: `name → { role, agentId }`
- Pending approvals

Storage: `.cat-code/sessions/<session-id>/state.json`  
Write pattern: write-to-tmp-then-rename (crash safe, same as old ledger).

Export the types that `compact/prompt.ts` will need to replace `RunStatus`, `ApprovalStatus`, `HandoffBlock`, `VerificationSummary`.

### Step B — Update compaction to use session state
**File:** `src/services/compact/prompt.ts`
- Replace `AgentModeCompactState` (run-ledger fields) with a new `AgentModeSessionState` type drawn from `sessionState.ts`
- Rewrite `formatAgentModeState` to format session state fields
- Keep `AGENT_MODE_COMPACT_APPENDIX` but update its wording to match V2 (session state wins, not run state)

**File:** `src/services/compact/compact.ts`
- Replace `AgentModeCompactionOptions` import accordingly

### Step C — Delete V1 files
- `src/agent-mode/orchestrator.ts`
- `src/agent-mode/orchestrator.test.ts`
- `src/agent-mode/agentModeContracts.ts`
- `src/agent-mode/runLedger.ts`
- `src/agent-mode/runLedger.test.ts`

### Step D — Gut agentMode.ts
Remove everything tied to the V1 run-ledger state machine:
- `AgentModeStatusSnapshot`, `AgentModeStatusLedger` types
- `buildStatusFromSnapshot`, `buildStatusFromEvent`, `buildPlanSnapshot`, `buildCompletionSummary`
- `setAgentModeStatusFromSnapshot`, `setAgentModeStatusFromEvent`
- `describeAgentModeRunStatus`
- `humanizeWorkerDescription`, `getLatestWorkerUpdate`, `collectChecks`, `collectChangedFiles`
- `isApplyBackApproval`

Keep: `isAgentMode()`, `getAgentModeSystemPrompt()`, `getCurrentSessionMode()`, `matchSessionMode()`, `getAgentModeUserContext()`

### Step E — Fix all remaining downstream breaks
Work through each file from the blast radius list:
- `src/main.tsx` — remove `initialAgentModeRunId` prop threading
- `src/screens/REPL.tsx` — remove `resumeAgentModeRunId`, `agentModeStatus`, `startAgentModeRun` (V1 run trigger), `AgentModeStatusSnapshot` state
- `src/components/AgentModeStatusHeader.tsx` — simplify or remove (no longer driven by snapshot)
- `src/constants/xml.ts` — remove V1 work order XML tags

---

## Phase 5 — `ask_orchestrator` tool

**New dir:** `src/tools/AskOrchestratorTool/`

Study `SendMessageTool` first for the routing pattern.

A real registered tool. Subagent calls it with a question or "stuck" signal. Message routes back through the orchestrator loop. Orchestrator decides whether to answer directly or route to user.

Wire into coding worker tool surface (update Phase 2 role definition).

---

## Phase 6 — Role files + context files

**New file:** `src/agent-mode/roleFiles.ts`

At worker spawn:
1. Check `.cat-code/roles/<role>.md` — if present, inject into system prompt (appended after built-in role prompt). File documents its own path so workers know where to write learnings.
2. Scan `.cat-code/context/` — inject list of available files (filename + first-line description) into worker briefing. Workers read whichever files are relevant. No content injection — avoids bloating context.

Workers can update role files and context files directly via their normal Write/Bash tools.

---

## Phase 7 — Named worker pool

**New file:** `src/agent-mode/workerNames.ts`

- Per-role name pool (human first names, different pool per role)
- System assigns a name randomly at spawn from the available pool
- Names tracked in session state (Phase 4)
- Session-scoped only — name is gone when session ends
- "Resume felix" = continue existing agent session for that worker via existing `resumeAgent` mechanism
- Name deallocated on worker completion

---

## Dependency order

```
Phase 0    blast radius already mapped — no writes needed
Phase 1    safe, no deps
Phase 2    deps: Phase 1 done
Phase 3+4  deps: Phase 2 done; atomic — session state introduced before deletions,
           compaction wired to new types before old types removed
Phase 5    deps: Phase 3+4 done (session state needed to route correctly)
Phase 6    deps: Phase 3+4 done (spawn path updated there)
Phase 7    deps: Phase 3+4 and 6 done
```

Phase 3+4 is the highest-risk phase. It will break compilation mid-pass. Strategy: work through all files in one sitting in the order A → B → C → D → E before committing.

---

## Out of scope for V2

These were explicitly rejected in the design:
- Repo fingerprinting / compressed context packet
- Thinking-budget routing per role
- Structured handoff schema (agentModeContracts.ts removed, not replaced with new schema)
- All trigger/event-driven automation
- Code intelligence infrastructure (LSP, AST, call graphs)
- Security/sandbox infrastructure
- UI observability surfaces (HUD, statusline heartbeats)
- Async/background execution patterns
- Cost/budget management
- Multi-model routing
