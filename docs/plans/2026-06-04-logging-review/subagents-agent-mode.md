# Logging Review — Subagents, Agent Mode & Worker Lifecycle

## Summary

Audited observability for durable worker control (#53), result-synthesis tracking
(#54), worker/worktree UX (#55), subagent resume UX (#64/#65), normal-mode role
identity (#81), and UI surfacing (#82). Production = non-ant, debug OFF.

Two reference facts shaped the judgments:
- `logForDebugging` is debug-gated for non-ants (only `[codex-cache]` bypasses).
- `logError` (`src/utils/log.ts`) is NOT debug-gated for the in-memory error log:
  it always pushes to `getInMemoryErrors()`, which ships in bug reports. So a
  catch-path that calls `logError` IS diagnosable in production even with debug off.

Net: the **mailbox/handoff layer is adequate** (every catch pairs `logForDebugging`
with `logError`). The gaps are concentrated in three silent paths:
1. **Tool-availability mismatch at spawn (the #81 class) — undiagnosable. Top priority.**
2. Resume/SendMessage target-resolution failure — undiagnosable.
3. Worker-failure *cause* — surfaced to user/transcript but absent from the
   in-memory error log, so it's missing from bug reports.

`src/agent-mode/sessionState.ts` has zero logging of any kind, but most of its
failure modes surface elsewhere; only the resolution path is a real gap.

---

## Findings

### 1. [#81] `invalidTools` discarded at worker spawn — silent capability gap (HIGH)

- **File:** `src/tools/AgentTool/agentToolUtils.ts:226-228` (collection) and
  `src/tools/AgentTool/runAgent.ts:559-561` (the live spawn path).
- **Current state:** `resolveAgentTools` separates declared tool specs into
  `validTools` / `invalidTools` (a declared name that matches no registered tool
  lands in `invalidTools`, line 227). At the actual spawn site, `runAgent.ts:561`
  reads `.resolvedTools` and **throws `.invalidTools` away with no log**.
  `invalidTools` is only ever surfaced in the agent-editor UI
  (`validateAgent.ts:89`, `AgentDetail.tsx:78`) — neither runs for built-in role
  agents at spawn. This is exactly the #81 failure: `ask_orchestrator` referenced
  under a divergent constant landed in `invalidTools`, vanished from the worker's
  pool, and the worker's prompt told it to call a tool it didn't have — with zero
  signal anywhere.
- **Recommended:** In `runAgent.ts`, capture the full result and emit when
  `invalidTools` is non-empty:
  ```ts
  const resolution = resolveAgentTools(agentDefinition, availableTools, isAsync)
  if (resolution.invalidTools.length > 0) {
    logForDebugging(
      `[subagent] ${agentDefinition.agentType} declared unresolved tools: ` +
        `${resolution.invalidTools.join(', ')} — dropped from tool pool`,
      { level: 'warn' },
    )
  }
  const resolvedTools = useExactTools ? availableTools : resolution.resolvedTools
  ```
- **Level / prefix:** `warn`, prefix `[subagent]`. **Add `[subagent]` to
  `ALWAYS_LOG_PREFIXES`** (`src/utils/debug.ts`) for this one. Rationale: a
  built-in role silently missing a tool its prompt mandates is a capability gap
  that is invisible until someone notices a worker "never asks the orchestrator"
  — the highest-severity, hardest-to-spot class in this domain, and it only fires
  on genuine misconfiguration (never in steady state), so it won't spam.

### 2. [#64/#65] Resume/SendMessage target resolution failures are unlogged (MEDIUM)

- **Files:**
  - `src/tools/AgentTool/resolveAgentTarget.ts:143, 177, 199, 209` — every `null`
    return (empty target, ambiguous metadata match, un-parseable ID, no
    live-task/transcript) is silent.
  - `src/tools/ResumeAgentTool/ResumeAgentTool.tsx:123-130` — `!resolved` returns
    a model-facing "No subagent found" with no log; the generic catch at line
    174-179 returns "Failed to resume" with no log either.
  - `src/tools/SendMessageTool/SendMessageTool.ts:892-899` — "No running subagent
    or Agent Mode worker found" returned with no log; stopped-target branch
    (883-888) also silent.
- **Current state:** A "@Name resume did nothing" / "SendMessage went nowhere"
  user report is **undiagnosable in production**. The model sees a message; nothing
  is written to the in-memory error log or debug log, so a bug report contains no
  trace of which target string failed to resolve or why.
- **Recommended:** Log at the tool-call resolution-failure sites (not inside
  `resolveAgentTarget`, to avoid noise from `validateInput`'s probe call at
  `SendMessageTool.ts:636`). In `ResumeAgentTool.tsx` before line 124 and
  `SendMessageTool.ts` before line 893:
  ```ts
  logForDebugging(
    `[subagent] resume target "${input.agentId}" did not resolve to any ` +
      `live task, durable worker, or transcript`,
    { level: 'warn' },
  )
  ```
  and the SendMessage analogue with `input.to`.
- **Level / prefix:** `warn`, prefix `[subagent]`. **Do NOT add to
  ALWAYS_LOG_PREFIXES for these two** — debug-gated is acceptable since the failure
  is already user-visible via the returned message; the log just needs to be there
  for a `/debug` repro. (If #1 adds `[subagent]` to the always-list, reconsider:
  these would then become production-visible too, which is acceptable but not
  required. Keep the always-bypass scoped to the capability-gap case if minimizing
  volume.) Rationale: turns an opaque "did nothing" into a one-line repro under
  debug, at near-zero cost.

### 3. Worker-failure cause absent from in-memory error log (MEDIUM)

- **File:** `src/tools/AgentTool/agentToolUtils.ts:1039-1058` (async lifecycle
  catch) and the parallel `agentResult.error` branch at 879-900.
- **Current state:** On real worker failure the error `msg` is surfaced to the
  user (notification, error color) and the transcript (`appendSubagentTerminal`),
  and terminal state is persisted. But `msg` itself is **never passed to
  `logError` or `logForDebugging`** — only the *meta*-failure ("Failed to record
  Agent Mode worker failure", line 1058) is logged, and that's debug-gated. So a
  bug report's in-memory error log does not contain the worker's actual failure
  reason; you must dig through transcript JSONL to reconstruct it.
- **Recommended:** In the catch at line 1039, after computing `msg`:
  ```ts
  const msg = errorMessage(error)
  logForDebugging(`[subagent] worker ${taskId} failed: ${msg}`, { level: 'error' })
  ```
  Consider `logError(error)` instead/additionally if the original stack is useful
  (it routes to in-memory log → bug reports). The AbortError branch (986) is a
  normal user-kill and should stay unlogged.
- **Level / prefix:** `error`, prefix `[subagent]`. Debug-gated is acceptable
  given user-visibility, but if `logError(error)` is used it reaches bug reports
  unconditionally — preferred for the genuine-failure (non-abort) path. Rationale:
  closes the "subagent silently failed" diagnosis loop in collected bug reports.

---

## Explicitly assessed as ADEQUATE (no change)

- **Mailbox / handoff delivery** — `src/utils/teammateMailbox.ts`. ~36
  `logForDebugging` calls are debug-gated, BUT every catch path pairs them with
  `logError` (lines 137-138, 218-219, 295, 368, 398-399), which reaches the
  production-visible in-memory error log. A dropped handoff/mailbox write IS
  diagnosable from a bug report. The debug-gated traces add `/debug` detail. No gap.
- **Worker terminal-state persistence meta-failures** —
  `agentToolUtils.ts:898, 943, 1018, 1057`. Debug-gated `logForDebugging` on the
  `.catch` of `recordWorkerSessionTerminal`. The terminal status itself still
  reaches the user notification + transcript; only the durable-state write is
  best-effort. Acceptable — over-logging to production here would be noise.
- **Worker control tools** (`CancelWorkerTool`, `GetWorkerResultTool`,
  `WaitWorkersTool`) — unresolved handles `throw new Error(...)`, which surfaces as
  a tool error the model sees and that flows into normal tool-error handling. No
  extra log needed.
- **Blocked-state derivation (#82)** — `src/tasks/pillLabel.ts:121`,
  `LocalAgentTask.tsx:487-493`. Derived deterministically by text parsing
  (`extractHandoffStatus`/`extractBlockReason`); a parse miss degrades the UI badge
  but is not a runtime failure. Not worth a log.

## Priority order
1. Finding #1 (capability gap, add `[subagent]` to ALWAYS_LOG_PREFIXES) — HIGH.
2. Finding #3 (worker-failure cause → bug reports) — MEDIUM.
3. Finding #2 (resume/send resolution repro under debug) — MEDIUM.
