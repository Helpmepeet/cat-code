# Phase 0: GPT-Native Prompt Style — Layer 2: Built-In Agent Prompts

**Status:** Ready for implementation (depends on Layer 1)
**Scope:** Rephrase built-in agent system prompts for GPT-optimal delivery. Same behavioral rules and constraints, different instruction style.

---

## Context

Layer 1 (see `docs/prompts/2026-04-30-gpt-native-style-layer1-core.md`) creates the prompt style router (`isGPTPromptStyle()`) and GPT-style rewrites of the core system prompt sections. This task extends that to the built-in agent system prompts.

When Cat Code spawns a subagent (Explore, Plan, general-purpose, verification, Claude Code guide), each agent gets its own system prompt from `src/tools/AgentTool/built-in/*.ts`. These prompts are currently written in Claude style regardless of which provider the agent will run on.

The OpenAI prompt engineering guide is the reference for GPT patterns: https://developers.openai.com/api/docs/guides/prompt-guidance

Key GPT patterns relevant to agents:
- **Completeness contracts**: "Maintain an internal checklist. Do not return until all items are covered."
- **Tool persistence**: "Do not stop early when another tool call would materially improve correctness or completeness."
- **Verification loops**: "Before returning results, verify coverage against the original request."
- **Output contracts**: Explicit output structure with per-section requirements.
- **Phase parameters**: For multi-step workflows, preserve phase state between tool calls.

---

## What needs to happen

For each built-in agent, add a GPT-style variant of its system prompt. Use `isGPTPromptStyle()` from `src/constants/promptStyle.ts` (created in Layer 1) to branch.

### Agent inventory

#### 1. General-purpose agent
**File:** `src/tools/AgentTool/built-in/generalPurposeAgent.ts`

Current prompt: narrative identity + "complete the task fully" + shared guidelines (strengths list, file search tips, thoroughness tips).

GPT variant needs:
- Task completion contract with explicit "done" criteria
- Tool persistence rule (don't stop searching when more results likely)
- Same shared guidelines, rephrased as numbered rules

#### 2. Explore agent
**File:** `src/tools/AgentTool/built-in/exploreAgent.ts`

Current prompt: identity + read-only mode block + strengths + guidelines + speed note.

GPT variant needs:
- Read-only contract (already fairly imperative, may need light touch)
- Completeness rule: "before returning, verify you've checked multiple naming conventions and locations"
- Efficiency contract: "maximize parallel tool calls per turn"
- Same constraints, contract-first delivery

#### 3. Plan agent
**File:** `src/tools/AgentTool/built-in/planAgent.ts`

Current prompt: identity + read-only block + 4-step process + required output format.

GPT variant needs:
- Process as numbered execution steps with completion gates between phases
- Output contract with explicit section requirements
- Read-only rules as binding constraints, not explanatory paragraphs

#### 4. Verification agent
**File:** `src/tools/AgentTool/built-in/verificationAgent.ts`

Current prompt: already heavily contract-style (output format, verdict format, rationalization warnings). This is the most GPT-like prompt in the codebase already.

GPT variant: lighter changes. Mainly restructure the ordering to put the execution contract and verdict format first (GPT guide says frontload constraints). The content itself is already imperative.

#### 5. Claude Code guide agent
**File:** `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts`

Current prompt: identity + three documentation domains + fetch URLs.

GPT variant needs:
- Completeness rule for documentation lookups
- Verification: "confirm your answer against the fetched docs before responding"
- Same URLs and domain list

#### 6. Status line setup agent
**File:** `src/tools/AgentTool/built-in/statuslineSetup.ts`

Minimal prompt. Likely needs little or no GPT variant. Evaluate and skip if trivial.

### Also update

**`getDefaultAgentPrompt()` in `src/constants/prompts.ts`** — this is the fallback agent prompt (used when a custom agent's `getSystemPrompt()` fails). Should already be handled in Layer 1, but verify.

**`enhanceSystemPromptWithEnvDetails()` in `src/constants/prompts.ts`** — appends notes and env info to all agent prompts. The "Notes:" block (absolute paths, emoji rule, no-colon rule) may benefit from GPT-style rephrasing. Evaluate.

---

## Implementation pattern

Same pattern as `isNewInstructionEnabled()` — branch inside the existing `getSystemPrompt` function of each agent:

```ts
import { isGPTPromptStyle } from '../../../constants/promptStyle.js'

function getExploreSystemPrompt(): string {
  if (isGPTPromptStyle()) {
    return `${getSearchAgentIdentityPrefix()} ...GPT-contract-style prompt...`
  }
  // existing Claude-style prompt unchanged
  return `${getSearchAgentIdentityPrefix()} ...`
}
```

No new files needed for this layer — changes are inline in existing agent definition files.

---

## Files involved

### Modified files
- `src/tools/AgentTool/built-in/generalPurposeAgent.ts`
- `src/tools/AgentTool/built-in/exploreAgent.ts`
- `src/tools/AgentTool/built-in/planAgent.ts`
- `src/tools/AgentTool/built-in/verificationAgent.ts`
- `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts`
- `src/tools/AgentTool/built-in/statuslineSetup.ts` (if non-trivial)
- `src/constants/prompts.ts` — `enhanceSystemPromptWithEnvDetails()` notes block (if needed)

### Files to read for context (do NOT modify)
- `src/tools/AgentTool/runAgent.ts` — how agent system prompts are assembled and enhanced
- `src/tools/AgentTool/loadAgentsDir.ts` — custom agent loading (not affected, but understand the flow)
- `src/constants/promptStyle.ts` — the style router (created in Layer 1)
- `src/constants/system.ts` — `getAgentPromptIdentityPrefix()` and `getSearchAgentIdentityPrefix()` (already provider-aware)

---

## What does NOT change

- Agent tool restrictions, disallowed tools, model selection — behavioral config stays the same
- Custom agents loaded from `.claude/agents/*.md` — user-authored, not our prompts to restyle
- `runAgent.ts` — assembly pipeline stays the same
- Agent memory system (`agentMemory.ts`) — factual content, not styled

---

## Verification

1. `bun run build` — no type/import errors
2. Set `CLAUDE_CODE_USE_OPENAI=1`, spawn each agent type, inspect dumped prompts — GPT-style agent prompts should appear
3. Unset the env var, spawn agents — Claude-style prompts unchanged
4. For each agent, verify every constraint (read-only, tool restrictions, output format) is preserved in the GPT variant
