# Agent Mode Control Plane Instructions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update Agent Mode system instructions so workers and worktrees are treated as an agent-managed control plane with explicit lifecycle, convergence, isolation, and recovery rules.

**Architecture:** This is a prompt/doctrine change with focused tests. The main orchestrator doctrine lives in `src/agent-mode/orchestratorPrompt.ts`; dynamic tool-aware guidance lives in `src/constants/prompts.ts` and `src/constants/promptStyles/gpt.ts`; worker/verifier role contracts live in `src/agent-mode/rolePrompts.ts`; worktree tool descriptions live under `src/tools/*WorktreeTool/prompt.ts`. Do not change `/agent` entry behavior, worker runtime, worktree runtime, or implement new worker-control tools in this plan.

**Tech Stack:** TypeScript, Bun test, prompt-string unit tests.

---

## File Structure

- Modify `src/agent-mode/orchestratorPrompt.ts`: add durable worker lifecycle, convergence, worker-control, multitask decomposition, worktree-as-backend, and steering/recovery doctrine.
- Modify `src/constants/prompts.ts`: add concise dynamic Agent Mode guidance that references worker-control tools only when those tool names are present.
- Modify `src/constants/promptStyles/gpt.ts`: mirror the dynamic guidance for GPT-style prompt formatting.
- Modify `src/agent-mode/rolePrompts.ts`: clarify worker/verifier responsibilities around orchestrator-owned worktrees and compact result handoffs.
- Modify `src/tools/EnterWorktreeTool/prompt.ts`: change tool prompt from user-explicit worktree usage only to agent-managed isolated attempt semantics while preserving safety boundaries.
- Modify `src/tools/ExitWorktreeTool/prompt.ts`: change tool prompt from user-managed cleanup semantics to agent-managed apply/discard/keep semantics while preserving destructive confirmation.
- Create `src/agent-mode/orchestratorPrompt.test.ts`: focused substring tests for new orchestrator doctrine.
- Create `src/agent-mode/rolePrompts.test.ts`: focused substring tests for worker/verifier role prompt doctrine.
- Create `src/tools/EnterWorktreeTool/prompt.test.ts`: focused substring tests for worktree entry prompt copy.
- Create `src/tools/ExitWorktreeTool/prompt.test.ts`: focused substring tests for worktree exit prompt copy.
- Modify or create `src/constants/prompts.test.ts`: focused substring tests for dynamic Agent Mode worker-control guidance.

---

### Task 1: Add Orchestrator Control-Plane Doctrine

**Files:**
- Modify: `src/agent-mode/orchestratorPrompt.ts`
- Create: `src/agent-mode/orchestratorPrompt.test.ts`

- [ ] **Step 1: Write failing tests for orchestrator prompt doctrine**

Create `src/agent-mode/orchestratorPrompt.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { getOrchestratorSystemPrompt } from './orchestratorPrompt.js'

describe('Agent Mode orchestrator prompt', () => {
  test('defines worker lifecycle and convergence rules', () => {
    const prompt = getOrchestratorSystemPrompt()

    expect(prompt).toContain('Worker lifecycle and convergence')
    expect(prompt).toContain('completed_pending_synthesis')
    expect(prompt).toContain('Worker completion is not objective completion')
    expect(prompt).toContain('intentionally ignored with a reason')
    expect(prompt).toContain('Do not let completed workers disappear as just "done"')
  })

  test('defines worker-control tool doctrine without raw IDs as normal UX', () => {
    const prompt = getOrchestratorSystemPrompt()

    expect(prompt).toContain('Worker control tools')
    expect(prompt).toContain('Use ListWorkers')
    expect(prompt).toContain('Use WaitWorkers')
    expect(prompt).toContain('Use GetWorkerResult')
    expect(prompt).toContain('Use CancelWorker')
    expect(prompt).toContain('Prefer worker handles over raw task IDs or internal agent IDs')
  })

  test('defines multitask decomposition boundaries', () => {
    const prompt = getOrchestratorSystemPrompt()

    expect(prompt).toContain('Multitask and decomposition')
    expect(prompt).toContain('Split work only when ownership is clean')
    expect(prompt).toContain('Do not split when workers will compete over the same files')
    expect(prompt).toContain('Parallel workers should have explicit ownership and done conditions')
  })

  test('treats worktrees as agent-owned execution backends', () => {
    const prompt = getOrchestratorSystemPrompt()

    expect(prompt).toContain('Worktree isolation')
    expect(prompt).toContain('Worktrees are execution backends, not user-facing task state')
    expect(prompt).toContain('The orchestrator owns worktree lifecycle')
    expect(prompt).toContain('Do not ask the user to remember worktree paths, branches, or cleanup steps')
    expect(prompt).toContain('Ask the user only at semantic boundaries')
  })

  test('defines steering and recovery before duplicate spawning', () => {
    const prompt = getOrchestratorSystemPrompt()

    expect(prompt).toContain('Steering and recovery')
    expect(prompt).toContain('steer or resume it instead of spawning a duplicate')
    expect(prompt).toContain('Cancel only when the worker branch is obsolete, unsafe, conflicting, or no longer useful')
    expect(prompt).toContain('Failed or killed workers are evidence, not completion')
  })
})
```

- [ ] **Step 2: Run the failing orchestrator prompt tests**

Run:

```bash
bun test src/agent-mode/orchestratorPrompt.test.ts
```

Expected: fails because the new section names and exact doctrine strings are not present yet.

- [ ] **Step 3: Add the prompt sections**

In `src/agent-mode/orchestratorPrompt.ts`, insert these sections after the existing `## Delegation rules` section and before `## Decision shape`:

```ts
`## Worker lifecycle and convergence

- Session state is the control plane. Treat worker state as authoritative when it exists.
- Track every worker as one of: running, blocked, completed_pending_synthesis, synthesized, failed, cancelled, or intentionally_ignored.
- Worker completion is not objective completion. A completed worker is only useful after its result has been read, judged, and synthesized into the main outcome.
- Before reporting final completion, every worker result must be one of: read and synthesized into the final outcome, intentionally ignored with a reason, failed and recovered or reported, or cancelled because it is obsolete, conflicting, or unsafe.
- Do not let completed workers disappear as just "done". Pending worker results are unresolved evidence, not closure.
- Do not spawn another worker until checking whether an existing worker can be resumed or steered.

## Worker control tools

- When worker-control tools are available, use ListWorkers to inspect the roster before spawning more workers when prior workers may exist.
- Use WaitWorkers after launching parallel workers so convergence is explicit rather than inferred from transcript order.
- Use GetWorkerResult before claiming worker output was incorporated. Mark a worker result synthesized only after actually using it.
- Use CancelWorker for stale, wrong, conflicting, unsafe, or no-longer-needed workers. Do not cancel the whole run when only one worker is stale.
- Prefer worker handles over raw task IDs or internal agent IDs. Keep raw IDs hidden unless they are needed for debugging.

## Multitask and decomposition

- Split work only when ownership is clean.
- Good split criteria: independent files or subsystems, independent investigation questions, implementation and verification can run separately, or best-of-N/design alternatives are explicitly useful.
- Do not split when workers will compete over the same files, the next step depends on a prior answer, the task is tiny, or synthesis cost is larger than delegation benefit.
- Parallel workers should have explicit ownership and done conditions.

## Worktree isolation

- Worktrees are execution backends, not user-facing task state.
- The orchestrator owns worktree lifecycle.
- Use worktrees for parallel edits, risky edits, broad refactors, experiments, or when isolation keeps the main workspace clean.
- Do not ask the user to remember worktree paths, branches, or cleanup steps.
- Track worktree path internally as worker metadata. Explain worktrees to the user only as an isolated worker or isolated attempt unless they ask for details.
- Ask the user only at semantic boundaries: apply verified changes to the main workspace, discard non-empty work, or keep a branch/worktree for later.
- Clean up clean or obsolete worktrees when safe. If applying worktree changes can affect user work, ask first.

## Steering and recovery

- If a worker is still relevant but incomplete or slightly off-track, steer or resume it instead of spawning a duplicate.
- Cancel only when the worker branch is obsolete, unsafe, conflicting, or no longer useful.
- Failed or killed workers are evidence, not completion.
- Recovery should classify the next move: fix current branch, steer existing worker, spawn replacement, re-plan, or report blocker.`
```

Keep the rest of the prompt wording unchanged unless a nearby sentence becomes directly redundant.

- [ ] **Step 4: Run the orchestrator prompt tests**

Run:

```bash
bun test src/agent-mode/orchestratorPrompt.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/agent-mode/orchestratorPrompt.ts src/agent-mode/orchestratorPrompt.test.ts
git commit -m "docs: define agent mode worker convergence doctrine"
```

---

### Task 2: Add Dynamic Worker-Control Guidance

**Files:**
- Modify: `src/constants/prompts.ts`
- Modify: `src/constants/promptStyles/gpt.ts`
- Create or modify: `src/constants/prompts.test.ts`

- [ ] **Step 1: Write failing tests for dynamic Agent Mode guidance**

If `src/constants/prompts.test.ts` does not exist, create it. Add:

```ts
import { describe, expect, test } from 'bun:test'
import { getAgentModeSystemPromptSections } from './prompts.js'

describe('Agent Mode dynamic prompt guidance', () => {
  test('includes worker-control guidance when worker-control tools are present', async () => {
    const sections = await getAgentModeSystemPromptSections(
      [
        { name: 'Agent' },
        { name: 'ListWorkers' },
        { name: 'WaitWorkers' },
        { name: 'GetWorkerResult' },
        { name: 'CancelWorker' },
      ] as any,
      'claude-sonnet-4-6',
      [],
      [],
    )
    const prompt = sections.join('\n')

    expect(prompt).toContain('Worker control:')
    expect(prompt).toContain('ListWorkers')
    expect(prompt).toContain('WaitWorkers')
    expect(prompt).toContain('GetWorkerResult')
    expect(prompt).toContain('CancelWorker')
    expect(prompt).toContain('Use worker handles instead of raw task IDs')
  })
})
```

- [ ] **Step 2: Run the failing dynamic guidance test**

Run:

```bash
bun test src/constants/prompts.test.ts
```

Expected: fails because the `Worker control:` guidance is not present.

- [ ] **Step 3: Add a helper in `src/constants/prompts.ts`**

Add this helper near `getAgentModeSessionSpecificGuidanceSection`:

```ts
function getAgentModeWorkerControlGuidance(enabledTools: Set<string>): string | null {
  const available = [
    enabledTools.has('ListWorkers')
      ? 'Use ListWorkers to inspect the worker roster before redundant spawning.'
      : null,
    enabledTools.has('WaitWorkers')
      ? 'Use WaitWorkers after launching parallel workers so convergence is explicit.'
      : null,
    enabledTools.has('GetWorkerResult')
      ? 'Use GetWorkerResult before synthesis or final completion; mark results synthesized only after using them.'
      : null,
    enabledTools.has('CancelWorker')
      ? 'Use CancelWorker for stale, wrong, conflicting, unsafe, or no-longer-needed workers.'
      : null,
  ].filter(item => item !== null)

  if (available.length === 0) return null

  return `Worker control: ${available.join(' ')} Use worker handles instead of raw task IDs or internal agent IDs.`
}
```

In `getAgentModeSessionSpecificGuidanceSection`, add this item after the existing Agent Mode orchestration item:

```ts
getAgentModeWorkerControlGuidance(enabledTools),
```

- [ ] **Step 4: Mirror the helper in `src/constants/promptStyles/gpt.ts`**

Add this helper near `getGPTAgentModeSessionGuidanceSection`:

```ts
function getGPTAgentModeWorkerControlGuidance(enabledTools: Set<string>): string | null {
  const available = [
    enabledTools.has('ListWorkers')
      ? 'ListWorkers: inspect the worker roster before redundant spawning.'
      : null,
    enabledTools.has('WaitWorkers')
      ? 'WaitWorkers: wait after parallel launches so convergence is explicit.'
      : null,
    enabledTools.has('GetWorkerResult')
      ? 'GetWorkerResult: read worker output before synthesis or final completion; mark synthesized only after use.'
      : null,
    enabledTools.has('CancelWorker')
      ? 'CancelWorker: cancel stale, wrong, conflicting, unsafe, or no-longer-needed workers.'
      : null,
  ].filter(item => item !== null)

  if (available.length === 0) return null

  return `WORKER CONTROL: ${available.join(' ')} Use worker handles instead of raw task IDs or internal agent IDs.`
}
```

In `getGPTAgentModeSessionGuidanceSection`, add:

```ts
getGPTAgentModeWorkerControlGuidance(enabledTools),
```

- [ ] **Step 5: Run dynamic guidance tests**

Run:

```bash
bun test src/constants/prompts.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/constants/prompts.ts src/constants/promptStyles/gpt.ts src/constants/prompts.test.ts
git commit -m "docs: add agent mode worker-control prompt guidance"
```

---

### Task 3: Update Worktree Tool Doctrine And Copy

**Files:**
- Modify: `src/tools/EnterWorktreeTool/prompt.ts`
- Modify: `src/tools/ExitWorktreeTool/prompt.ts`
- Create: `src/tools/EnterWorktreeTool/prompt.test.ts`
- Create: `src/tools/ExitWorktreeTool/prompt.test.ts`

- [ ] **Step 1: Write failing tests for `EnterWorktree` prompt**

Create `src/tools/EnterWorktreeTool/prompt.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { getEnterWorktreeToolPrompt } from './prompt.js'

describe('EnterWorktree prompt', () => {
  test('frames worktrees as isolated execution backends', () => {
    const prompt = getEnterWorktreeToolPrompt()

    expect(prompt).toContain('isolated workspace for this attempt')
    expect(prompt).toContain('main workspace stays untouched')
    expect(prompt).toContain('Agent Mode')
    expect(prompt).toContain('Do not ask the user to remember the worktree path or branch')
  })
})
```

- [ ] **Step 2: Write failing tests for `ExitWorktree` prompt**

Create `src/tools/ExitWorktreeTool/prompt.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { getExitWorktreeToolPrompt } from './prompt.js'

describe('ExitWorktree prompt', () => {
  test('frames exit as apply, discard, or keep isolated result', () => {
    const prompt = getExitWorktreeToolPrompt()

    expect(prompt).toContain('isolated result')
    expect(prompt).toContain('Apply, discard, or keep')
    expect(prompt).toContain('Do not make the user manage cleanup mechanics')
    expect(prompt).toContain('Confirm before discarding non-empty work')
  })
})
```

- [ ] **Step 3: Run failing worktree prompt tests**

Run:

```bash
bun test src/tools/EnterWorktreeTool/prompt.test.ts src/tools/ExitWorktreeTool/prompt.test.ts
```

Expected: fails because current prompt says to use these tools only when the user explicitly asks for worktrees.

- [ ] **Step 4: Update `EnterWorktree` prompt**

Replace `getEnterWorktreeToolPrompt()` with:

```ts
export function getEnterWorktreeToolPrompt(): string {
  return `Create an isolated workspace for this attempt. In Agent Mode, worktrees are execution backends: the main workspace stays untouched while isolated work runs.

## When to Use

- Agent Mode needs isolation for parallel edits, risky edits, broad refactors, experiments, or an implementation attempt that should not touch the main workspace yet
- The user explicitly asks to work in a worktree

## When NOT to Use

- The task is tiny and safe to do directly
- The next step depends on a prior answer and parallel isolation would add synthesis overhead
- Another active worker already owns the same files or subsystem
- The user only asks to create or switch branches; use normal git commands for branch-only requests

## Agent Responsibilities

- Treat the worktree as internal execution state, not user-facing task state
- Do not ask the user to remember the worktree path or branch
- Track the worktree path as worker/session metadata and expose it only when needed for debugging or explicit user request
- Before asking the user to apply, discard, or keep work, inspect and summarize the isolated result

## Requirements

- Must be in a git repository, OR have WorktreeCreate/WorktreeRemove hooks configured in settings.json
- Must not already be in a worktree

## Behavior

- In a git repository: creates a new git worktree inside \`.claude/worktrees/\` with a new branch based on HEAD
- Outside a git repository: delegates to WorktreeCreate/WorktreeRemove hooks for VCS-agnostic isolation
- Switches the session's working directory to the isolated workspace
- Use ExitWorktree to leave mid-session. On session exit, if still in the worktree, the user will be prompted only for the meaningful outcome: apply, discard, or keep the isolated result.

## Parameters

- \`name\` (optional): A stable name for the isolated attempt. If not provided, a random name is generated.
`
}
```

- [ ] **Step 5: Update `ExitWorktree` prompt**

Replace `getExitWorktreeToolPrompt()` with:

```ts
export function getExitWorktreeToolPrompt(): string {
  return `Exit an isolated worktree session created by EnterWorktree and return to the original working directory. In Agent Mode, the orchestrator owns worktree lifecycle.

## Scope

This tool ONLY operates on worktrees created by EnterWorktree in this session. It will NOT touch:
- Worktrees created manually with \`git worktree add\`
- Worktrees from a previous session
- The directory you're in if EnterWorktree was never called

If called outside an EnterWorktree session, the tool is a no-op: it reports that no worktree session is active and takes no filesystem action.

## When to Use

- The isolated attempt is complete and the session should return to the main workspace
- The isolated attempt is obsolete, conflicting, unsafe, or no longer useful
- The user explicitly asks to exit or leave the worktree

## Agent Responsibilities

- Treat this as apply, discard, or keep decision support for the isolated result
- Do not make the user manage cleanup mechanics or remember paths and branch names
- Confirm before discarding non-empty work
- If the isolated result should be applied to the main workspace, ask for that semantic approval before applying changes through the appropriate workflow; this tool only exits or removes the isolated workspace

## Parameters

- \`action\` (required): \`"keep"\` or \`"remove"\`
  - \`"keep"\` preserves the isolated result for later. Use this when the result may still be useful or the user asks to keep it.
  - \`"remove"\` deletes the isolated workspace and branch. Use this when the result is clean, obsolete, abandoned, or already safely incorporated.
- \`discard_changes\` (optional, default false): only meaningful with \`action: "remove"\`. If the worktree has uncommitted files or commits not on the original branch, the tool refuses to remove it unless this is true. If the tool reports changes, confirm with the user before re-invoking with \`discard_changes: true\`.

## Behavior

- Restores the session's working directory to where it was before EnterWorktree
- Clears CWD-dependent caches so prompt context reflects the original directory
- If a tmux session was attached to the worktree: killed on \`remove\`, left running on \`keep\`
- Once exited, EnterWorktree can be called again for a fresh isolated attempt
`
}
```

- [ ] **Step 6: Run worktree prompt tests**

Run:

```bash
bun test src/tools/EnterWorktreeTool/prompt.test.ts src/tools/ExitWorktreeTool/prompt.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/tools/EnterWorktreeTool/prompt.ts src/tools/ExitWorktreeTool/prompt.ts src/tools/EnterWorktreeTool/prompt.test.ts src/tools/ExitWorktreeTool/prompt.test.ts
git commit -m "docs: frame worktrees as agent-managed isolation"
```

---

### Task 4: Update Worker And Verifier Role Prompts

**Files:**
- Modify: `src/agent-mode/rolePrompts.ts`
- Create: `src/agent-mode/rolePrompts.test.ts`

- [ ] **Step 1: Write failing role prompt tests**

Create `src/agent-mode/rolePrompts.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import {
  AGENT_MODE_CODING_WORKER,
  AGENT_MODE_VERIFIER,
} from './rolePrompts.js'

const toolUseContext = {
  options: {
    mainLoopModel: 'claude-sonnet-4-6',
    mainLoopProvider: undefined,
  },
} as any

describe('Agent Mode role prompts', () => {
  test('coding worker treats worktree lifecycle as orchestrator-owned', () => {
    const prompt = AGENT_MODE_CODING_WORKER.getSystemPrompt({ toolUseContext })

    expect(prompt).toContain('worktree or isolation lifecycle is orchestrator-owned')
    expect(prompt).toContain('Do not ask the user to manage worktree cleanup')
    expect(prompt).toContain('ready for orchestrator synthesis')
  })

  test('verifier judges isolated worktree result safety', () => {
    const prompt = AGENT_MODE_VERIFIER.getSystemPrompt({ toolUseContext })

    expect(prompt).toContain('If verifying an isolated worktree result')
    expect(prompt).toContain('safe to apply')
    expect(prompt).toContain('should be discarded')
    expect(prompt).toContain('Do not expose raw paths unless needed for evidence')
  })
})
```

- [ ] **Step 2: Run failing role prompt tests**

Run:

```bash
bun test src/agent-mode/rolePrompts.test.ts
```

Expected: fails because the new exact strings are not present.

- [ ] **Step 3: Update coding worker prompts**

In both provider branches of `getImplementorSystemPrompt`, add these bullets under the boundaries section:

```text
- The worktree or isolation lifecycle is orchestrator-owned. Do not ask the user to manage worktree cleanup, paths, or branches.
- If you worked in an isolated workspace, report that only as compact metadata for the orchestrator.
- Your handoff must make clear whether your changes are ready for orchestrator synthesis, blocked, or unsafe to apply.
```

For the non-OpenAI markdown branch, use the same text with normal `-` bullets.

- [ ] **Step 4: Update verifier prompts**

In both provider branches of `getVerifierSystemPrompt`, add these bullets under constraints or check order:

```text
- If verifying an isolated worktree result, report whether it is safe to apply, needs fixes, or should be discarded.
- Do not expose raw paths unless needed for evidence.
```

Keep the verifier read-only rule intact.

- [ ] **Step 5: Run role prompt tests**

Run:

```bash
bun test src/agent-mode/rolePrompts.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/agent-mode/rolePrompts.ts src/agent-mode/rolePrompts.test.ts
git commit -m "docs: clarify agent mode worker isolation handoffs"
```

---

### Task 5: Full Prompt Validation

**Files:**
- All files changed in Tasks 1-4

- [ ] **Step 1: Run targeted prompt tests**

Run:

```bash
bun test src/agent-mode/orchestratorPrompt.test.ts src/agent-mode/rolePrompts.test.ts src/constants/prompts.test.ts src/tools/EnterWorktreeTool/prompt.test.ts src/tools/ExitWorktreeTool/prompt.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run existing Agent Mode and compact prompt tests**

Run:

```bash
bun test src/agent-mode/agentMode.test.ts
bun test src/agent-mode/sessionState.test.ts
bun test src/services/compact/prompt.test.ts
```

Expected: all tests pass. These guard live session state injection, durable session state behavior, and compaction wording.

- [ ] **Step 3: Run build**

Run:

```bash
bun run build:dev
```

Expected: build completes successfully.

- [ ] **Step 4: Inspect final diff for scope**

Run:

```bash
git diff -- src/agent-mode/orchestratorPrompt.ts src/constants/prompts.ts src/constants/promptStyles/gpt.ts src/agent-mode/rolePrompts.ts src/tools/EnterWorktreeTool/prompt.ts src/tools/ExitWorktreeTool/prompt.ts
```

Expected: diff is prompt/test focused. There should be no changes to `/agent` command behavior, worker runtime, worktree runtime, task runtime, or git cleanup logic.

- [ ] **Step 5: Commit final validation changes if any**

If Task 5 required fixes, commit them:

```bash
git add src/agent-mode src/constants src/tools/EnterWorktreeTool src/tools/ExitWorktreeTool
git commit -m "test: cover agent mode control-plane prompt doctrine"
```

If no files changed during Task 5, do not create an empty commit.

---

## Non-Goals

- Do not change `/agent` fresh-start behavior.
- Do not implement `ListWorkers`, `WaitWorkers`, `GetWorkerResult`, or `CancelWorker` in this plan.
- Do not remove `EnterWorktree` or `ExitWorktree`.
- Do not hide worktree path/branch from structured tool output or debug evidence.
- Do not make every task use a worktree.
- Do not create a mandatory plan-approval workflow.
- Do not change runtime permission policy, sandboxing, worker process management, or git cleanup behavior.

---

## Self-Review

- Spec coverage: This plan covers Agent Mode system instruction changes, dynamic worker-control guidance, worktree-as-backend copy, role prompt updates, and prompt tests. Worker-control tool implementation is explicitly out of scope because it has a separate plan.
- Placeholder scan: The plan contains concrete files, test code, prompt text, commands, and expected results.
- Type consistency: Tests import exported functions/constants that already exist or are created in the task. New helper functions are internal to prompt files and do not change public API.
