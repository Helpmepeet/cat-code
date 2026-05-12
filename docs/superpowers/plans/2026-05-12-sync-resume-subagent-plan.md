# Sync Subagent Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a synchronous resume mode for subagents so that spawn and resume have symmetric mode coverage. Today `Agent` spawns can be sync (default) or async (`run_in_background: true`); resumes can only be async. After this change, callers can choose to block on a resumed subagent's next turn and receive its reply inline, matching the sync-spawn return shape.

**Architecture:** Resume already flows through `resumeAgentBackground` in `src/tools/AgentTool/resumeAgent.ts`, which builds the resumed message list and metadata then hands off to `runAgent`. Sync-spawn uses the same `runAgent` core but wraps it in a foreground driver loop (`AgentTool.call` at `src/tools/AgentTool/AgentTool.tsx:1015–1300+`) that handles the foreground task registration, ctrl-C-to-background race, progress UI, summarization, and result aggregation. The sync-resume path will reuse that driver loop unchanged — only the entry point and the initial `runAgent` parameter assembly differ. A new exported function `resumeAgentForeground` in `resumeAgent.ts` shares the existing transcript/metadata/system-prompt reconstruction with `resumeAgentBackground`, then runs the same foreground driver that sync-spawn uses. A new tool `ResumeAgentTool` exposes this to the model with the same surface as `Agent` (description, prompt, run_in_background flag), but addressing an existing `agentId` instead of selecting an agent type.

**Tech Stack:** TypeScript, existing AgentTool runtime, Bun test.

---

## Prerequisites

- The recent SendMessage resume message cleanup (PR landing the `Resumed "${description}" in the background.` wording) should be merged. This plan keeps the existing async resume path; it only adds a sync sibling.
- No changes to `SendMessage` semantics — it remains async-only. Sync resume is a deliberate, separate operation.

---

## File Structure

- Modify `src/tools/AgentTool/resumeAgent.ts`: extract the transcript/metadata/system-prompt reconstruction currently inside `resumeAgentBackground` into a shared helper `prepareResumeContext`. Add `resumeAgentForeground` that calls the helper then runs the foreground driver loop. Keep `resumeAgentBackground` callable and unchanged externally.
- Create `src/tools/AgentTool/syncDriver.ts`: extract the foreground iteration loop from `AgentTool.call` (lines ~1034–1300) into a shared driver `runAgentForegroundLoop({ agentDefinition, runAgentParams, ... })` that both sync-spawn and sync-resume reuse. The driver owns: foreground task registration, ctrl-C-to-background race, BackgroundHint UI, progress summarization, message aggregation, and final result shaping.
- Modify `src/tools/AgentTool/AgentTool.tsx`: replace the inline foreground loop in `AgentTool.call` with a call to `runAgentForegroundLoop`. No behavior change for sync spawn — same loop, just lifted.
- Create `src/tools/ResumeAgentTool/ResumeAgentTool.tsx`: new tool. Schema: `{ agentId: string, prompt: string, run_in_background?: boolean }`. When `run_in_background: true`, delegates to `resumeAgentBackground` and returns the async ack (same shape as the existing SendMessage resume return: `Resumed "${description}" in the background.`). When false/omitted, delegates to `resumeAgentForeground` and returns the sync result (same shape as sync-spawn return: assistant content + agentId trailer + usage block).
- Create `src/tools/ResumeAgentTool/ResumeAgentTool.test.ts`: tests for both modes, error paths (agent not found, transcript missing, agent currently running), and result shape parity with sync-spawn / async-spawn.
- Modify `src/tools.ts`: register `ResumeAgentTool` in the tool pool (same gating as `AgentTool`).
- Modify `src/tools/AgentTool/prompt.ts` (or wherever the Agent tool prompt lives): add a short note pointing to `ResumeAgentTool` for resuming a paused subagent, mirroring how `Agent` describes async vs sync spawn.
- Modify `src/tools/SendMessageTool/SendMessageTool.ts`: no functional change. Optionally tighten the success-message wording for the resume branches now that there's an explicit sync alternative, so the async ack reads cleanly against the new tool.

---

### Task 1: Extract Foreground Driver

**Files:**
- Create: `src/tools/AgentTool/syncDriver.ts`
- Modify: `src/tools/AgentTool/AgentTool.tsx`

**Steps:**
- [ ] Identify the foreground iteration block in `AgentTool.call` (approximately lines 1034–1300, ending where the sync result is returned).
- [ ] Extract into `runAgentForegroundLoop({ agentDefinition, runAgentParams, description, prompt, agentId, toolUseContext, syncAgentContext, ... })`. The function owns: registering the foreground task, building the background-race promise, driving `runAgent`'s async iterator, showing `BackgroundHint`, handling ctrl-C-to-background, running progress summarization, and returning the aggregated tool result (content blocks + agentId trailer + usage).
- [ ] Replace the inline block in `AgentTool.call` with a single call to `runAgentForegroundLoop`. Preserve identical behavior; verify by running existing AgentTool tests.
- [ ] Do not change worktree handling, codex-lease registration, or analytics wrappers — those stay in `AgentTool.call` and are passed into the driver as already-resolved values.

**Verification:**
- [ ] Existing AgentTool tests pass unchanged.
- [ ] Manual: spawn a sync agent (e.g., Explore) and confirm progress UI, background hint after 2s, ctrl-C-to-background, and final result shape all unchanged.

---

### Task 2: Extract Resume Context Preparation

**Files:**
- Modify: `src/tools/AgentTool/resumeAgent.ts`

**Steps:**
- [ ] Extract the prep block at the top of `resumeAgentBackground` (transcript load, message filtering, replacement-state reconstruction, worktree resolution, agent definition selection, fork system prompt rebuild, tool pool assembly, `runAgentParams` construction) into a private helper `prepareResumeContext({ agentId, prompt, toolUseContext, sourceSessionId })` returning `{ selectedAgent, runAgentParams, description, syncAgentContext, resumedWorktreePath, ... }`.
- [ ] `resumeAgentBackground` becomes: call `prepareResumeContext`, then the existing async-launch path (register async agent, run lifecycle, return `ResumeAgentResult`).
- [ ] Confirm `resumeAgentBackground`'s exported signature and return shape are unchanged.

**Verification:**
- [ ] Existing `resumeAgent.test.ts` passes unchanged.
- [ ] Existing `SendMessageTool.test.ts` resume-related tests pass unchanged.

---

### Task 3: Add `resumeAgentForeground`

**Files:**
- Modify: `src/tools/AgentTool/resumeAgent.ts`

**Steps:**
- [ ] Add exported function `resumeAgentForeground({ agentId, prompt, toolUseContext, canUseTool, invokingRequestId, sourceSessionId })`.
- [ ] Implementation: call `prepareResumeContext`, then invoke `runAgentForegroundLoop` with the prepared params. The return type matches sync-spawn's return: assistant content + agentId trailer + usage block, packaged the same way `AgentTool.call`'s sync path does it.
- [ ] Error handling: if `prepareResumeContext` throws (missing transcript, etc.), surface a structured error with the same wording shape as the async resume errors at `SendMessageTool.ts:884` / `:912`, but without the "could not be resumed" past tense — the sync path hasn't started running yet.
- [ ] Guard: if the target agent is currently `running` (per `appState.tasks[agentId].status`), refuse with a clear error. Sync resume cannot interrupt an in-flight turn. Caller should queue via SendMessage or wait.

**Verification:**
- [ ] Unit test: paused subagent + foreground resume yields a result matching the sync-spawn shape (content array + agentId trailer + usage block).
- [ ] Unit test: running subagent + foreground resume returns the refusal error.
- [ ] Unit test: missing-transcript case yields the expected error.

---

### Task 4: Create `ResumeAgentTool`

**Files:**
- Create: `src/tools/ResumeAgentTool/ResumeAgentTool.tsx`
- Create: `src/tools/ResumeAgentTool/ResumeAgentTool.test.ts`

**Steps:**
- [ ] Define the tool schema: `agentId: z.string()`, `prompt: z.string()`, `run_in_background: z.boolean().optional()`. Mirror the AgentTool prompt vocabulary so the calling model picks the right verb.
- [ ] Tool description: explain that this resumes a paused subagent, that sync mode blocks for the agent's next turn (use when you need the reply inline), and that async mode returns immediately (use when delegating long work). Cross-reference `Agent` for fresh spawns and `SendMessage` for fire-and-forget messaging.
- [ ] `call` impl: dispatch to `resumeAgentForeground` or `resumeAgentBackground` based on the flag. Reuse the existing `ResumeAgentResult` shape for the async branch and the sync-spawn result shape for the sync branch.
- [ ] Tests:
  - [ ] Sync resume returns content + agentId + usage.
  - [ ] Async resume returns the `Resumed "${description}" in the background.` ack with no leaked tmp path or ID.
  - [ ] Refuses sync resume on a currently-running agent.
  - [ ] Refuses on missing transcript with a clear message.
  - [ ] Result shape parity check vs `AgentTool` sync and async returns.

---

### Task 5: Register Tool and Update Model Guidance

**Files:**
- Modify: `src/tools.ts`
- Modify: `src/tools/AgentTool/prompt.ts` (or the appropriate prompt surface — confirm via `docs/prompts/2026-04-30-prompt-surfaces.md` before editing)
- Modify: `src/tools/SendMessageTool/SendMessageTool.ts` (prompt/description only, no logic)

**Steps:**
- [ ] Register `ResumeAgentTool` in the assembled tool pool with the same permission gating as `AgentTool`.
- [ ] Update the Agent tool's prompt blurb so the model knows: spawn a fresh agent with `Agent`; resume an existing paused agent with `ResumeAgent`; send a one-way message to a still-running agent with `SendMessage`.
- [ ] Update `SendMessageTool`'s description to mention that auto-resume on a stopped target is always async; recommend `ResumeAgent` when a sync reply is needed.
- [ ] Verify against the prompt surfaces map that no other prompt needs updating.

**Verification:**
- [ ] Build the dev binary (`bun run build:dev:full`) and confirm the new tool is enumerable.
- [ ] Manual: in a session with a paused subagent, call `ResumeAgent({ agentId, prompt, run_in_background: false })` and confirm the reply comes back inline. Then call it again with `run_in_background: true` and confirm the async ack.

---

### Task 6: Documentation and Map Updates

**Files:**
- Modify: `docs/maps/` — locate the AgentTool / subagent runtime map and add `ResumeAgentTool` next to `AgentTool`.
- Possibly modify: `docs/prompts/2026-04-30-prompt-surfaces.md` if it enumerates per-tool prompt blurbs.

**Steps:**
- [ ] Add a one-line entry under the agent runtime map describing `ResumeAgentTool` and its relationship to `AgentTool` and `SendMessage`.
- [ ] If the prompt surfaces doc lists tool descriptions, add the new tool's blurb.

**Verification:**
- [ ] `git diff --check` for whitespace.
- [ ] Internal links resolve.

---

## Open Questions

- **Permission prompts during sync resume.** Sync spawn allows permission prompts; async spawn suppresses them. Sync resume should match sync spawn (allow prompts). Confirm `runAgentForegroundLoop` preserves this when invoked from the resume entry point — the relevant logic is in `runAgent` at `src/tools/AgentTool/runAgent.ts:494` and should already key off the same `isAsync` signal.
- **Ctrl-C-to-background on sync resume.** Should pressing Ctrl-C during a sync resume detach the agent into the background, the same way it does for sync spawn? Default: yes, same behavior. The reused foreground driver gives this for free.
- **Worktree handling.** Sync spawn can create or reuse worktrees. Sync resume inherits the worktree from the resumed agent's metadata (already handled in `prepareResumeContext` via `meta.worktreePath`). No new worktree is created on resume.
- **Timeout policy.** Sync spawn has no timeout — it runs as long as the agent runs. Sync resume should match.

## Non-Goals

- No changes to `SendMessage` semantics. It remains the async-only messaging primitive.
- No changes to the existing async resume path beyond the helper extraction in Task 2.
- No new notification surfaces. The existing `enqueueAgentNotification` already fires the user-visible completion banner for the async path; the sync path returns inline so no notification is needed.
- No changes to swarm/teammate resume paths — those go through different runtime and are out of scope.
