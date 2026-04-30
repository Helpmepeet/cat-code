# Phase 0: GPT-Native Prompt Style — Layer 1: Core System Prompt

**Status:** Ready for implementation
**Scope:** Rephrase the main system prompt sections for GPT-optimal delivery. Same behavioral rules, different instruction style.

---

## Context

Cat Code supports Claude (Anthropic) and GPT 5.4 (OpenAI) as providers. The provider detection, instruction assembly, and identity prefixes already branch on provider. But the actual prompt *content* — behavioral rules, tool guidance, tone instructions — is written in Claude-optimal style regardless of provider.

Claude and GPT respond differently to the same instructions:

- **Claude** works well with narrative context, explanations of *why*, examples, and structured markdown sections.
- **GPT 5.4** works well with explicit contracts, numbered priority rules, verification loops, completeness criteria, and output schemas.

The OpenAI prompt engineering guide documents these patterns: https://developers.openai.com/api/docs/guides/prompt-guidance

This task creates GPT-style rewrites of every core system prompt section. No rules are added or removed — only how they're delivered changes. The Claude prompt path stays as-is.

### Existing provider branching (already done)

These are already provider-aware and do NOT need changes in this task:

- `src/constants/system.ts` — identity prefixes (`DEFAULT_PREFIX` vs `OPENAI_DEFAULT_PREFIX`)
- `src/services/api/instructionAssembly.ts` — structural assembly (system prompt array for Claude, flattened `instructions` string for OpenAI)
- `src/constants/prompts.ts:computeSimpleEnvInfo()` — suppresses Claude model IDs on OpenAI, shows provider name

### Existing style-branching precedent

`isNewInstructionEnabled()` in `src/constants/newInstruction.ts` is a boolean that selects between two phrasings of the same rule inline within section builders. This task follows the same pattern, keyed on provider instead of env var.

---

## What needs to happen

### 1. Create a prompt style router

**New file: `src/constants/promptStyle.ts`**

A small module that exposes `isGPTPromptStyle(): boolean`. It reads `getAPIProvider()` from `src/utils/model/providers.ts` and returns `true` when the provider is `'openai'`.

This is the single decision point. Every section builder uses this to branch.

### 2. Create GPT-style section builders

**New file: `src/constants/promptStyles/gpt.ts`**

GPT-style equivalents for every static section builder in `src/constants/prompts.ts`. Each function takes the same parameters as its Claude counterpart and returns a string with the same behavioral rules, rephrased in GPT contract style.

The sections to rewrite (mapping 1:1 to existing Claude builders):

| GPT function | Claude counterpart in prompts.ts | What it covers |
|---|---|---|
| `getGPTIntroSection()` | `getSimpleIntroSection()` | Identity, role, security rules, URL policy |
| `getGPTSystemSection()` | `getSimpleSystemSection()` | Platform rules, tool permissions, hooks, compression |
| `getGPTDoingTasksSection()` | `getSimpleDoingTasksSection()` | All behavioral rules: read before editing, minimal changes, no over-engineering, security, code style, verification, help/feedback |
| `getGPTActionsSection()` | `getActionsSection()` | Reversibility rules, confirmation requirements, destructive action checks |
| `getGPTUsingToolsSection(enabledTools)` | `getUsingYourToolsSection(enabledTools)` | Tool preferences, parallelism rules, task management |
| `getGPTToneAndStyleSection()` | `getSimpleToneAndStyleSection()` | Emoji, conciseness, formatting, code references |
| `getGPTOutputSection()` | `getOutputEfficiencySection()` | Writing quality, brevity, structure, user-facing text rules |
| `getGPTSessionGuidanceSection(enabledTools, skillToolCommands)` | `getSessionSpecificGuidanceSection(enabledTools, skillToolCommands)` | Agent tool guidance, skill invocation, verification agent contract |

Each GPT function must:
- Encode the **exact same rules** as the Claude counterpart
- Use GPT-optimal patterns: contract-first, numbered priority rules, verification criteria, explicit completeness rules
- Accept the same parameters and return a string
- Handle the same conditional logic (feature flags, `isNewInstructionEnabled()`, tool availability checks)

### 3. Wire into `getSystemPrompt()`

**Modified file: `src/constants/prompts.ts`**

In the return array of `getSystemPrompt()` (around line 558), each static section branches on `isGPTPromptStyle()`:

```ts
const gpt = isGPTPromptStyle()
return [
  gpt ? getGPTIntroSection(outputStyleConfig) : getSimpleIntroSection(outputStyleConfig),
  gpt ? getGPTSystemSection() : getSimpleSystemSection(),
  // ... same pattern for each static section
  ...(shouldUseGlobalCacheScope() ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),
  ...resolvedDynamicSections,
].filter(s => s !== null)
```

**Dynamic sections stay shared.** Memory, env info, MCP instructions, scratchpad, function result clearing, token budget, length guidance — these are factual/structural content, not behavioral instructions. They don't need style variants.

Also update `getDefaultAgentPrompt()` (line 756) to branch on style.

### 4. Update the proactive mode path

The proactive/KAIROS path (around line 468) has its own return array with a different structure. If GPT is used with proactive mode, the intro and proactive section should also get GPT-style treatment. However, proactive mode is feature-gated — handle this only if the feature flags are active in the build.

---

## GPT prompt style patterns to follow

Reference: https://developers.openai.com/api/docs/guides/prompt-guidance

Key patterns for the GPT section rewrites:

1. **Contract-first structure**: Task definition (1 sentence) → critical rules → step sequences → edge cases → output format → worked example
2. **Explicit priority ordering**: "Rule N overrides Rule M when they conflict"
3. **Completeness rules**: "Do not return until all items are covered. Maintain an internal checklist."
4. **Verification loops**: "Before [action], check [condition] against [source]"
5. **Tool persistence**: "Do not stop early when another tool call would materially improve correctness or completeness"
6. **Output contracts**: Per-section format/length specs, not just "be concise"
7. **Scoped steering**: Mid-conversation overrides state scope + what still applies

Example transformation (Doing Tasks — "read before editing" rule):

**Claude style** (current):
```
In general, do not propose changes to code you haven't read. If a user asks about
or wants you to modify a file, read it first. Understand existing code before
suggesting modifications.
```

**GPT style** (target):
```
RULE: Read before modifying. Before proposing any change to a file, you must have
read its current contents in this conversation. Verification: confirm the file
appears in a prior Read tool result before emitting an Edit.
```

Same rule. Same behavior. GPT delivery: imperative statement, verification criterion.

---

## Files involved

### New files
- `src/constants/promptStyle.ts`
- `src/constants/promptStyles/gpt.ts`

### Modified files
- `src/constants/prompts.ts` — branch each static section on `isGPTPromptStyle()`

### Files to read for context (do NOT modify)
- `src/constants/system.ts` — identity prefixes (already provider-aware)
- `src/constants/newInstruction.ts` — precedent for style branching pattern
- `src/constants/systemPromptSections.ts` — caching system (works regardless of content)
- `src/services/api/instructionAssembly.ts` — structural assembly (already handles Claude vs OpenAI)
- `src/utils/model/providers.ts` — `getAPIProvider()` and `APIProvider` type
- `src/constants/cyberRiskInstruction.ts` — `CYBER_RISK_INSTRUCTION` constant (shared, not restyled)

---

## What does NOT change

- Dynamic sections (memory, env info, MCP, scratchpad, token budget, etc.)
- `instructionAssembly.ts` — structural assembly already correct
- `system.ts` — identity prefixes already branch on provider
- `systemPrompt.ts` — priority/override logic is provider-agnostic
- `systemPromptSections.ts` — caching infra works regardless of content
- `QueryEngine.ts` — assembly pipeline stays the same
- `context.ts` — injected context is factual
- Tool `prompt.ts` files — separate layer, not in scope
- Agent system prompts — separate layer, not in scope
- Service prompts (compact, memory) — separate layer, not in scope

---

## Verification

1. `bun run build` — no type/import errors
2. `bun run build:dev` — dev build succeeds
3. Set `CLAUDE_CODE_USE_OPENAI=1`, start a session, and inspect dumped prompts at `~/.cat-code/dump-prompts/` — GPT-style sections should appear
4. Unset the env var, start a session — Claude-style sections should appear unchanged
5. Verify every behavioral rule in the Claude prompt has a corresponding rule in the GPT prompt (no rules dropped or added)
