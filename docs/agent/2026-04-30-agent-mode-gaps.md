# Agent Mode Gaps & Recommendations

**Status:** Updated — 2026-04-19  
**Purpose:** Complement to `AGENT_MODE_PLAN.md`. Documents what the current implementation has, what is missing or weak, and what should be added.  
**How to use:** Review each gap, decide which phase it belongs in, adopt or reject explicitly. Do not let open items drift silently.

---

## Current State Snapshot

All control-plane requirements from `AGENT_MODE_PLAN.md` are implemented. A full code audit on 2026-04-19 found every gap in the original draft to be already fixed in the codebase. Only one real gap remains.

| Component | Status |
|---|---|
| `AgentModeOrchestrator` class | Implemented. Full state machine: planning → awaiting_approval → executing → verifying → completed/blocked/cancelled |
| `RunLedger` with Zod schema | Implemented. Crash-safe write (tmp→rename), resume helpers, terminal state detection |
| `AgentModeStatusHeader` | Implemented. Live phase status, elapsed time, running cost — shown during active runs |
| Planner/Implementor/Verifier roles | Implemented as `AgentDefinition` objects in `rolePrompts.ts` with Zod-validated return schemas |
| Worktree isolation + apply-back | Implemented. `decideSingleWorkerIsolation()` uses planner signals. Parallel workers always use worktrees |
| Recovery counters | Implemented. fix_attempts ≤ 2, replan_attempts ≤ 2, parallel ≤ 3, total_spawns ≤ 15, orchestrator_turns ≤ 50 |
| Worker timeout | Implemented. 10-minute default via `AbortController`. Times out with a blocked packet and resume hint |
| Mid-run abort | Implemented. Escape during active run shows `[a] abort / [Esc] let it finish` prompt |
| `/agent` slash command | Implemented. Accepts inline task or prompts interactively. Registered in `commands.ts` |
| `/runs` slash command | Implemented. List, detail by run_id prefix, cleanup (7-day terminal cutoff with confirmation) |
| Cost display | Implemented. Live cost in status header, final cost in completion/blocked report |
| Per-run cost telemetry | Implemented. tokens_in, tokens_out, estimated_cost tracked per worker in ledger |
| `--agent-mode` CLI flag | Implemented as `CLAUDE_CODE_AGENT_MODE=1` env var |
| Orphaned worktree cleanup | Implemented. On startup: scans `.claude/worktrees/` for `agent-<8hex>` slugs not claimed by non-terminal run ledgers |
| Compaction at phase boundaries | Implemented. `onCheckpoint` fires `compactAgentModeCheckpoint` in REPL with run-state-preserving hint |
| Orchestrator system prompt | Implemented in `orchestratorPrompt.ts` |
| REPL integration | Implemented. Approval dialogs wired, orphaned run detection on mount, checkpoint triggers, completion/blocked report |

---

## Remaining Gap

### Gap 13: No Unit Tests

**Status: Open**

`orchestrator.test.ts` and `runLedger.test.ts` exist but are minimal/empty.

**What's missing:**
- State machine transition tests (planning → awaiting_approval → executing → …)
- Recovery counter limit enforcement (fix_attempts, replan_attempts)
- Ledger read/write round-trips
- Packet parsers (`parsePlannerPacket`, `parseImplementorPacket`, `parseVerifierPacket`) — pure functions with edge-case-heavy section-parsing logic
- Approval gate enforcement (`assertPlanApproved` throws when expected)
- Worktree cleanup paths

**Why it matters:** The orchestrator has significant state transitions, counter checks, and parsing edge cases. Regressions are only caught by running a real agent mode session, which is slow and expensive.

**Recommendation:** Add unit tests for:
1. The three packet parser functions — pure, fast, fragile
2. `createRunLedger` / `writeRunLedger` / `readRunLedger` round-trips
3. `RecoveryCounters` limit enforcement (mock `runWorker` to return quickly)
4. `warn` verdict routing

---

## Previously Open Gaps — All Closed

| Gap | Description | Resolution |
|---|---|---|
| Gap 1 | No live status display | Fixed — `AgentModeStatusHeader` rendered in REPL |
| Gap 2 | No structured blocked report UI | Fixed — `buildAgentModeBlockedLines` renders reason, issues, open questions, cost |
| Gap 3 / Gap 11 | No in-session `/agent` command | Fixed — `src/commands/agent/agent.tsx` registered |
| Gap 4 | No mid-run abort | Fixed (Tier 1) — Escape shows abort prompt, abort controller wired through `runWorker` |
| Gap 5 | No `/runs` history command | Fixed — `src/commands/runs/runs.tsx` with list/detail/cleanup |
| Gap 6 | Cost not surfaced to user | Fixed — shown in status header and completion/blocked report |
| Gap 7 | Orphaned worktree cleanup after crash | Fixed — `cleanupOrphanedAgentWorktrees()` cross-references run ledgers at startup |
| Gap 8 | No worker timeout | Fixed — 10-minute default, `worker-timeout` abort reason, blocked packet on timeout |
| Gap 9 | `warn` verdict no decision logic | Fixed — `warn` routes correctly through `classifyVerifierReturn` |
| Gap 10 | Approval dialog lacks risk highlight / scope | Fixed — yellow risky actions, `N areas · N steps` scope indicator |
| Gap 12 | Role prompts not audited | Closed — prompts match Zod-validated return schemas; `VerifierReturnSchema` fully defined |
| Gap 14 | `rejectPlan` returns wrong kind | Fixed — returns `kind: 'planning'` |
