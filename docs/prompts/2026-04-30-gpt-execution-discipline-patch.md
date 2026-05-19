# GPT Execution Discipline Patch

**Status:** Analysis complete, ready for implementation
**Date:** 2026-04-12
**Scope:** Smallest prompt-only patch to fix GPT execution waste without changing user-visible behavior

---

## Design constraint

All changes must be invisible to the user. The model's tone, style, communication pattern, and interaction feel must not change. The patches only affect internal execution discipline — how the model manages its own investigation, delegation, and implementation workflow behind the scenes.

The user should experience: same conversation, faster results, less wasted time.

---

## Problem summary

GPT running in this harness wastes significant tokens and time on execution patterns that Claude handles naturally. The root cause is not GPT being "worse" — it's that the harness prompts assume Claude-like self-regulation behaviors that GPT does not have.

The five verified waste patterns, in priority order:

1. **Over-investigation**: GPT keeps searching after diagnosis is already sufficient
2. **Delegation duplication**: GPT reads the same files it just delegated to subagents
3. **Implementer re-investigation**: subagents receiving precise "edit file X, change Y" prompts still grep broadly before editing
4. **Review scope drift**: review-flavored subagents investigate the entire codebase instead of validating a bounded diff
5. **Late delegation**: implementation work gets delegated at the very end instead of early

---

## Evidence base

### Verified sessions

- **Session 569653ce** (GPT/Codex — diagnose & fix GPT edit failures): findings 1-5
- **Session 1ff42642** (GPT/Codex — Web UI Phase 1): findings 6-7
- **Session 02d8a892** (Claude baseline): findings 8-9

### Key finding detail

**Over-investigation (finding #1)**:
- By msg 67 the agent said it had enough to reject the simple explanation
- By msg 102 it said it had narrowed to a specific conclusion
- It continued with many more grep topics and did not move to implementation
- First substantive answer to the user came much later than necessary

**Delegation duplication (finding #2)**:
- GPT spawned background Explore agents early
- After spawning, the main agent continued reading overlapping files itself
- The overlap was real file-level duplication, not pagination

**Implementer re-investigation (finding #3)**:
- The implementer prompt included exact files, exact changes, and explicit constraints
- Despite that, the implementer performed many greps before its first edit

**Review scope drift (finding #5)**:
- Reviewer behavior involved many reads/greps/bash calls for a very small known file set
- Some commands were legitimate but overall scope was disproportionate

**Late delegation (finding #7)**:
- In all runs, implementer spawn happened at the end, right before API/account errors
- Earlier delegation would have yielded partial useful work

### Important correction (from prior analysis)

Many apparent "duplicate file reads" were actually legitimate pagination (different offsets in the same file). The true problem is repeated investigation of already-covered ground, especially after convergence or after delegation. Do not overstate file-read duplication.

---

## What the harness currently assumes (and why it fits Claude better)

### 1. No investigation phase gate

Nothing in the main prompt, agent tool prompt, or general-purpose agent prompt says "once your diagnosis is stable, stop investigating and act."

The general-purpose GPT agent prompt (`generalPurposeAgent.ts:40`) actually says:

> "Do not stop at partial progress when another tool call would materially improve correctness or completeness."

This is the correct instruction for exploration agents. It is the **wrong** instruction for a main agent in diagnosis mode — it encourages GPT to keep searching after convergence. Claude self-regulates this; GPT does not.

### 2. Delegation ownership is a soft suggestion

The agent tool prompt (`prompt.ts:344`) has one bullet:

> "avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself."

Claude treats this as a binding constraint. GPT treats it as one bullet among many and continues reading files it just delegated. This needs to be a hard rule with explicit behavior: "After spawning agents, STOP your own research on those topics."

### 3. No exact-file obedience rule for implementers

The general-purpose agent prompt tells GPT to "verify coverage" and "not stop at partial progress." When an implementer receives a precise prompt saying "edit file X line Y, change Z," GPT interprets these instructions as "I should investigate the surrounding context first." There is no instruction saying "if the prompt specifies exact files and exact changes, start editing immediately."

### 4. No reviewer scope boundary

There is no built-in "reviewer" role. Reviews happen through general-purpose agents with review-flavored caller prompts. The general-purpose prompt's "completeness" push encourages broad investigation instead of bounded diff validation.

### 5. Non-coordinator mode lacks workflow structure

The coordinator mode prompt (`coordinatorMode.ts:252-269`) has excellent guidance:
- "Always synthesize — your most important job"
- "Never write 'based on your findings' or 'based on the research'"
- Explicit phase structure (research → synthesis → implementation → verification)

The standard single-user non-coordinator mode has none of this. No phase guidance, no synthesis discipline, no delegation timing.

---

## Architecture of the current prompt surfaces

The roles listed below are what actually exists today. There is no built-in "implementer" or "reviewer" role — those are just general-purpose agents that happen to receive implementation/review-flavored prompts from the caller.

### Real prompt targets (what exists)

| Surface | File | GPT variant exists? |
|---------|------|-------------------|
| Main system prompt (core sections) | `src/constants/promptStyles/gpt.ts` | Yes — 8 section functions |
| Agent tool prompt (delegation guidance) | `src/tools/AgentTool/prompt.ts` | Yes — `isGPTPromptStyle` branch |
| General-purpose agent | `src/tools/AgentTool/built-in/generalPurposeAgent.ts` | Yes — `provider === 'openai'` branch |
| Explore agent | `src/tools/AgentTool/built-in/exploreAgent.ts` | Yes — `provider === 'openai'` branch |
| Plan agent | `src/tools/AgentTool/built-in/planAgent.ts` | Yes — `provider === 'openai'` branch |
| Verification agent | `src/tools/AgentTool/built-in/verificationAgent.ts` | Yes — `provider === 'openai'` branch |

### Not real (do not target)

- "Implementer" role — does not exist as a built-in agent. Implementation is done by general-purpose agents.
- "Reviewer" role — does not exist as a built-in agent. Reviews are done by general-purpose agents.
- Coordinator mode roles — exist but are a separate feature. Do not change coordinator prompts in this patch.

---

## Patch plan

All patches are prompt-only. No workflow, orchestration, or code changes. All patches target only the GPT `provider === 'openai'` branches — Claude prompts are untouched.

### Patch 1: Investigation phase gate (P0)

**Problem**: GPT over-investigates after diagnosis converges (finding #1)
**Target**: `src/constants/promptStyles/gpt.ts` → `getGPTSessionGuidanceSection()`
**Constraint**: Does not change how the model talks to the user. Only affects when it stops searching internally.

Add to the `items` array:

```
INVESTIGATION DISCIPLINE: When diagnosing a problem, track whether your conclusion is stable. Once you can identify the specific files and changes needed, STOP investigating and either act (edit/implement) or report your findings. Do not continue searching for confirming evidence after your conclusion has stabilized. The test: can you write a precise implementation spec with file paths and line numbers? If yes, move on.
```

### Patch 2: Hard ownership transfer on delegation (P0)

**Problem**: GPT duplicates subagent work (finding #2)
**Target**: `src/tools/AgentTool/prompt.ts` → the GPT branch of the `agentToolRule` variable in `getGPTSessionGuidanceSection` (in `gpt.ts`), or the usage rules in `prompt.ts`
**Constraint**: Does not change how the model communicates delegation to the user. Only affects what it does internally after spawning.

Current GPT text in `gpt.ts:297`:
```
AGENT TOOL: Use the Agent tool when the task matches a specialized agent's description. Agents parallelize independent queries and protect your context from large outputs. Do not use excessively. Do not duplicate work a subagent is already doing.
```

Replace with:
```
AGENT TOOL: Use the Agent tool when the task matches a specialized agent's description. Agents parallelize independent queries and protect your context from large outputs. Do not use excessively. OWNERSHIP TRANSFER: After spawning an agent for a topic, do NOT read, grep, or investigate that same topic yourself. Wait for the agent's results before acting on that topic. If you need to do something before results arrive, work on a different aspect of the task.
```

### Patch 3: Exact-file obedience for general-purpose agents (P1)

**Problem**: Subagents receiving precise implementation prompts re-investigate before editing (finding #3)
**Target**: `src/tools/AgentTool/built-in/generalPurposeAgent.ts` → the `provider === 'openai'` branch
**Constraint**: Does not change agent output style. Only affects whether it greps before editing when told exactly what to edit.

Current text:
```
TASK CONTRACT: Use the available tools to complete the assigned task. ${completionRule} Do not stop at partial progress when another tool call would materially improve correctness or completeness. Before returning, verify that you covered each part of the user's request.
```

Replace with:
```
TASK CONTRACT: Use the available tools to complete the assigned task. ${completionRule}

EXECUTION PRIORITY:
1. If the prompt specifies exact files and exact changes, begin editing immediately. Do not search for surrounding context unless the specified changes are ambiguous or clearly incomplete.
2. If the prompt is open-ended, investigate first — but once you can identify specific changes, switch to editing.
3. Before returning, verify that you covered each part of the caller's request.
```

### Patch 4: Handoff completeness guidance (P2)

**Problem**: Subagents spawn without required context, wasting full agent cycles (finding #4)
**Target**: `src/tools/AgentTool/prompt.ts` → the GPT `writingThePromptSection`
**Constraint**: Does not change how delegation looks to the user. Only affects prompt quality.

Add after the "Never delegate understanding" paragraph:

```
HANDOFF COMPLETENESS: When spawning an agent for implementation or review, your prompt must include:
- Exact file paths to change or review
- The current state (any uncommitted changes, dirty baseline, or prior failed attempts the agent needs to know)
- What "done" looks like
- Any constraints the agent must follow
A prompt missing this context wastes a full agent cycle.
```

### Patch 5: No conclusion restating (P3)

**Problem**: GPT repeats conclusions verbosely instead of advancing (finding #9)
**Target**: `src/constants/promptStyles/gpt.ts` → `getGPTOutputSection()`
**Constraint**: Does not change tone. The model still communicates the same information — it just doesn't repeat it.

Add after existing RULE 4:

```
RULE 6 — No restating: Do not repeat conclusions or status you have already communicated to the user. Each message should advance the task or add new information.
```

---

## What NOT to change in this patch

| Item | Why defer |
|------|-----------|
| Claude prompt tuning | Claude is the acceptable baseline — don't touch |
| Instruction assembly architecture (`instructionAssembly.ts`, `codex-fetch-adapter.ts`) | Real issue (see `role_native_instruction_hierarchy.md`) but infrastructure, not behavioral |
| XML control surfaces | Documented in `reduce_xml_to_structure_only.md`, not first-order for GPT behavior |
| Tool schema normalization | Documented in `schema_first_tool_contracts.md`, minor |
| Replay/retry patterns (finding #6) | Insufficient evidence — may be API-level, not prompt-fixable |
| Coordinator mode prompts | Already has the best guidance, separate feature |
| Thinking block handling | Already fixed in adapter |
| Prompt caching optimization | Documented in `prefix_friendly_prompt_assembly.md`, orthogonal |
| Output tone or style | Violates the design constraint (must be invisible to user) |
| New built-in agent roles (implementer, reviewer) | Not needed for this patch — fix the general-purpose agent prompt instead |

---

## Verification plan

### For each patch

1. Build with `bun run build:dev:full`
2. Run with `CLAUDE_CODE_USE_OPENAI=1`
3. Compare GPT behavior on a similar task before/after

### Specific checks

**Patch 1 (phase gate)**: Run a diagnosis task. Count tool calls after diagnosis stabilizes. Before patch: 30+. After patch: should drop to <10 before implementation starts.

**Patch 2 (ownership transfer)**: Spawn an Explore agent, then check whether the main agent reads overlapping files. Before patch: significant overlap. After patch: main agent should work on different aspects or wait.

**Patch 3 (exact-file obedience)**: Spawn a general-purpose agent with a precise "edit file X, change Y" prompt. Count greps before first edit. Before patch: 5+. After patch: 0-1.

**Patch 4 (handoff completeness)**: Check whether spawned agents receive file paths, baseline state, and done criteria. Qualitative check.

**Patch 5 (no restating)**: Check whether GPT repeats the same conclusion across multiple messages. Qualitative check.

### User-visibility check

For all patches: the model's conversation with the user should read the same way. Same tone, same level of detail, same communication style. The difference should only be visible in tool-call traces (fewer redundant searches, faster time-to-edit).

---

## Next step

Apply patches 1 and 2 (phase gate + ownership transfer) first. These target the two highest-waste GPT behaviors and are the smallest changes. Run a GPT session with a diagnosis+implementation task and compare tool-call counts against the baseline sessions.
