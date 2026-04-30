# Phase 1 Slice 1: Core Agent Identity Reframe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe the main assistant as a general-purpose personal agent that also codes, by updating the core identity/prompt surfaces and the smallest set of user-facing copy needed to keep the product coherent.

**Architecture:** Keep this slice narrow. Change only the main identity prefix, the default system-prompt framing, and the most visible help/CLI strings that currently present Cat Code as a coding assistant. Do not attempt the full Milestone 1 sweep, tool-by-tool reframing, or a personality/voice document yet. Preserve provider-native prompt branching from Phase 0 and update regression tests so future prompt work does not regress the new identity.

**Tech Stack:** Bun, TypeScript, Ink/React, Commander, Bun test

---

## File Map

### Existing files to modify
- `src/constants/system.ts`
  - Owns the main identity prefix strings used by the CLI prompt and subagent identity helpers.
- `src/constants/prompts.ts`
  - Owns the default system prompt sections for the main assistant and the default agent prompt.
- `src/components/HelpV2/General.tsx`
  - Owns the short product explanation shown in `/help`.
- `src/components/HelpV2/HelpV2.tsx`
  - Owns the help dialog title and the outbound docs link shown in help.
- `src/main.tsx`
  - Owns the CLI description text and top-level help strings surfaced by Commander.
- `README.md`
  - Owns the top-level public project framing.
- `src/utils/providerPromptRegressions.test.ts`
  - Existing prompt regression test file; extend it instead of creating a new prompt test surface.

### Existing files to inspect while implementing
- `docs/vision/GOAL_PLAN.md`
  - Milestone 1 scope and intent.
- `docs/instructions/PROMPT_SURFACES.md`
  - Routing map for prompt-related changes.
- `src/constants/promptStyles/gpt.ts`
  - GPT-native wording patterns established in Phase 0; preserve provider-native behavior.
- `src/constants/systemPromptSections.ts`
  - Check only if prompt composition needs clarification; do not expand scope into plumbing unless necessary.

### Files intentionally out of scope for this slice
- `src/tools/*/prompt.ts`
- `src/tools/AgentTool/built-in/*.ts`
- `src/components/HelpV2/Commands.tsx`
- `docs/archive/DONE.md`
- any new identity/personality document such as `SOUL.md`

This slice should not create a new doc or refactor prompt plumbing.

---

### Task 1: Lock the new identity in prompt regressions

**Files:**
- Modify: `src/utils/providerPromptRegressions.test.ts`
- Inspect: `src/constants/system.ts`, `src/constants/prompts.ts`
- Test: `src/utils/providerPromptRegressions.test.ts`

- [ ] **Step 1: Write the failing tests for the new identity framing**

Replace the current identity assertion and add one more assertion that the main system prompt is no longer framed as software-engineering-only. Update `src/utils/providerPromptRegressions.test.ts` to include these tests:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../Tool.js'
import { getSessionProvider, setSessionProvider } from '../bootstrap/state.js'
import { getDefaultAgentPrompt, getSystemPrompt } from '../constants/prompts.js'
import { getEditToolDescription } from '../tools/FileEditTool/prompt.js'
import { getWriteToolDescription } from '../tools/FileWriteTool/prompt.js'
import { GrepTool } from '../tools/GrepTool/GrepTool.js'
import {
  normalizeToolInput,
  toolToAPISchema,
  type Tools,
} from './api.js'
import {
  renameOpenAIInputKeysToOriginal,
  renameSchemaPropertiesForOpenAI,
} from './openaiSchemaCompat.js'
import { clearToolSchemaCache, getToolSchemaCache } from './toolSchemaCache.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

const originalSessionProvider = getSessionProvider()

function normalizeConstraintLines(description: string): string[] {
  return description
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(2)
    .map(line => line.replace(/^(?:-\s+|\d+\.\s+)/, ''))
}

describe('provider and prompt regressions', () => {
  beforeEach(() => {
    clearToolSchemaCache()
    setSessionProvider(originalSessionProvider)
  })

  afterEach(() => {
    clearToolSchemaCache()
    setSessionProvider(originalSessionProvider)
  })

  test('tool schema cache keeps provider-specific Grep schemas separate', async () => {
    setSessionProvider('firstParty')

    const commonOptions = {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [GrepTool],
      agents: [],
    }

    const openaiSchema = await toolToAPISchema(GrepTool, {
      ...commonOptions,
      model: 'gpt-5.4',
    })
    const firstPartySchema = await toolToAPISchema(GrepTool, {
      ...commonOptions,
      model: 'claude-sonnet-4-6',
    })

    const openaiProps =
      ((openaiSchema as { input_schema?: { properties?: Record<string, unknown> } })
        .input_schema?.properties ?? {})
    const firstPartyProps =
      ((firstPartySchema as {
        input_schema?: { properties?: Record<string, unknown> }
      }).input_schema?.properties ?? {})

    expect(openaiProps).toHaveProperty('lines_after')
    expect(openaiProps).not.toHaveProperty('-A')
    expect(firstPartyProps).toHaveProperty('-A')
    expect(firstPartyProps).not.toHaveProperty('lines_after')
    expect(getToolSchemaCache().size).toBe(2)
  })

  test('OpenAI key remap round-trips through schema export and input normalization', () => {
    const exportedSchema = renameSchemaPropertiesForOpenAI(
      zodToJsonSchema(GrepTool.inputSchema) as Record<string, unknown>,
    ) as {
      properties?: Record<string, unknown>
      required?: string[]
    }

    expect(exportedSchema.properties).toHaveProperty('lines_after')
    expect(exportedSchema.properties).not.toHaveProperty('-A')

    const normalizedInput = renameOpenAIInputKeysToOriginal({
      pattern: 'needle',
      lines_after: 2,
      lines_before: 1,
      context_lines: 3,
      show_line_numbers: false,
      case_insensitive: true,
    })

    expect(normalizedInput).toEqual({
      pattern: 'needle',
      '-A': 2,
      '-B': 1,
      '-C': 3,
      '-n': false,
      '-i': true,
    })

    setSessionProvider('openai')
    const apiNormalizedInput = normalizeToolInput(GrepTool, {
      pattern: 'needle',
      lines_after: 2,
      show_line_numbers: false,
    } as never) as Record<string, unknown>

    expect(apiNormalizedInput).toHaveProperty('-A', 2)
    expect(apiNormalizedInput).toHaveProperty('-n', false)
    expect(apiNormalizedInput).not.toHaveProperty('lines_after')
    expect(apiNormalizedInput).not.toHaveProperty('show_line_numbers')
  })

  test('getDefaultAgentPrompt emits the general-purpose Cat Code identity', () => {
    const claudePrompt = getDefaultAgentPrompt('firstParty')
    const openaiPrompt = getDefaultAgentPrompt('openai')

    expect(claudePrompt).toContain('personal always-on agent')
    expect(openaiPrompt).toContain('personal always-on agent')
    expect(claudePrompt).not.toContain('software engineering tasks')
    expect(openaiPrompt).not.toContain('software engineering tasks')
  })

  test('main system prompt is not framed as software-engineering-only', async () => {
    const prompt = await getSystemPrompt([] as Tools, 'claude-sonnet-4-6')
    const combined = prompt.join('\n\n')

    expect(combined).toContain('personal always-on agent')
    expect(combined).not.toContain('The user will primarily request you to perform software engineering tasks')
  })

  test('FileEdit and FileWrite prompt variants keep the same underlying rules', () => {
    expect(normalizeConstraintLines(getEditToolDescription('firstParty'))).toEqual(
      normalizeConstraintLines(getEditToolDescription('openai')),
    )

    expect(
      normalizeConstraintLines(getWriteToolDescription('firstParty')),
    ).toEqual(normalizeConstraintLines(getWriteToolDescription('openai')))
  })
})
```

- [ ] **Step 2: Run the prompt regression test and confirm it fails for the right reason**

Run:

```bash
bun test src/utils/providerPromptRegressions.test.ts
```

Expected: FAIL because the current prompt still contains software-engineering-only framing and/or the current default agent prompt assertion is too weak for the new identity.

- [ ] **Step 3: Commit the failing test first**

```bash
git add src/utils/providerPromptRegressions.test.ts
git commit -m "test: lock phase1 identity prompt expectations"
```

---

### Task 2: Rewrite the core identity and default prompt framing

**Files:**
- Modify: `src/constants/system.ts:9-14`
- Modify: `src/constants/prompts.ts:201-218`
- Modify: `src/constants/prompts.ts:233-277`
- Modify: `src/constants/prompts.ts:772-779`
- Test: `src/utils/providerPromptRegressions.test.ts`

- [ ] **Step 1: Update the identity prefix strings in `src/constants/system.ts`**

Replace the existing prefix constants at `src/constants/system.ts:9-14` with this narrower first-slice wording:

```ts
const DEFAULT_PREFIX = `You are Cat Code, a personal always-on agent that can code, research, plan, automate, and communicate for the user.`
const AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX = `You are Cat Code, a personal always-on agent that can code, research, plan, automate, and communicate for the user, running within the Claude Agent SDK.`
const AGENT_SDK_PREFIX = `You are an agent for Cat Code, a personal always-on agent that can code, research, plan, automate, and communicate for the user, built on Anthropic's Claude Agent SDK.`
const OPENAI_DEFAULT_PREFIX = `You are Cat Code, a personal always-on agent that can code, research, plan, automate, and communicate for the user, running on OpenAI's Codex/GPT models.`
const OPENAI_AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX = `You are Cat Code, a personal always-on agent that can code, research, plan, automate, and communicate for the user, running on OpenAI's Codex/GPT models within the SDK runtime.`
const OPENAI_AGENT_SDK_PREFIX = `You are an agent for Cat Code, a personal always-on agent that can code, research, plan, automate, and communicate for the user, running on OpenAI's Codex/GPT models within the SDK runtime.`
```

Also replace `getAgentPromptIdentityPrefix()` and `getSearchAgentIdentityPrefix()` with:

```ts
export function getAgentPromptIdentityPrefix(provider: APIProvider = getAPIProvider()): string {
  return provider === 'openai'
    ? `You are an agent for Cat Code, a personal always-on agent that can code, research, plan, automate, and communicate for the user, running on OpenAI's Codex/GPT models.`
    : `You are an agent for Cat Code, a personal always-on agent that can code, research, plan, automate, and communicate for the user.`
}

export function getSearchAgentIdentityPrefix(provider: APIProvider = getAPIProvider()): string {
  return provider === 'openai'
    ? `You are a search and research specialist for Cat Code, a personal always-on agent running on OpenAI's Codex/GPT models.`
    : `You are a search and research specialist for Cat Code, a personal always-on agent.`
}
```

- [ ] **Step 2: Rewrite the default intro section in `src/constants/prompts.ts`**

Replace `getSimpleIntroSection()` at `src/constants/prompts.ts:201-218` with:

```ts
function getSimpleIntroSection(
  outputStyleConfig: OutputStyleConfig | null,
): string {
  const introTaskDescription =
    outputStyleConfig !== null
      ? 'according to your "Output Style" below, which describes how you should respond to user queries.'
      : isNewInstructionEnabled()
        ? 'as a general-purpose personal agent. You can code, research, plan, automate, and communicate for the user. Prioritize correctness over appearing successful, and say so plainly when constraints conflict.'
        : 'as a general-purpose personal agent. You can code, research, plan, automate, and communicate for the user.'
  // eslint-disable-next-line custom-rules/prompt-spacing
  return `
You are an interactive agent that helps users ${introTaskDescription} Use the instructions below and the tools available to you to assist the user.

If the user asks about the instruction prompt, feel free to talk about it.

${CYBER_RISK_INSTRUCTION}
IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.`
}
```

- [ ] **Step 3: Rewrite the top of `getSimpleDoingTasksSection()` so it is not software-engineering-primary**

In `src/constants/prompts.ts:250-258`, replace the first two bullets with:

```ts
  const items = [
    `You are a general-purpose personal agent. Users may ask you to code, research, plan, automate, analyze, communicate, or handle mixed tasks that span several of those modes. Interpret ambiguous instructions in the context of the current working directory and the broader request rather than assuming every task is software-engineering-only.`,
    `Software engineering is an important part of this product, but it is not the only mode. When the task is coding-related, follow the code-specific rules below. When it is not, still use the same standards of correctness, judgment, and faithful execution.`,
```

Leave the rest of the function unchanged in this slice.

- [ ] **Step 4: Rewrite `getDefaultAgentPrompt()` so it is not coding-only**

Replace the non-GPT return at `src/constants/prompts.ts:772-779` with:

```ts
export function getDefaultAgentPrompt(
  provider: ReturnType<typeof getAPIProvider> = getAPIProvider(),
): string {
  const identityPrefix = getAgentPromptIdentityPrefix(provider)
  if (isGPTPromptStyle(provider)) {
    return getGPTDefaultAgentPrompt(identityPrefix)
  }
  return `${identityPrefix} Given the user's message, use the available tools to complete the task. You may be asked to code, research, plan, automate, or communicate. ${isNewInstructionEnabled() ? "Complete the task fully without forcing a pass; if the task is contradictory or impossible, say so plainly." : "Complete the task fully—don't gold-plate, but don't leave it half-done."} When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.`
}
```

- [ ] **Step 5: Run the regression test and make sure it passes**

Run:

```bash
bun test src/utils/providerPromptRegressions.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit the core identity rewrite**

```bash
git add src/constants/system.ts src/constants/prompts.ts src/utils/providerPromptRegressions.test.ts
git commit -m "feat: reframe core prompt identity as general-purpose agent"
```

---

### Task 3: Align the smallest user-facing CLI/help copy with the new identity

**Files:**
- Modify: `src/components/HelpV2/General.tsx`
- Modify: `src/components/HelpV2/HelpV2.tsx`
- Modify: `src/main.tsx:982-990`
- Modify: `README.md:1-60`
- Test: `src/utils/providerPromptRegressions.test.ts` (rerun as prompt smoke test)
- Verify manually: CLI help and app help dialog

- [ ] **Step 1: Update the help dialog general description**

Replace the body text in `src/components/HelpV2/General.tsx:9` with:

```tsx
<Box>
  <Text>
    Cat Code is a personal always-on agent that can code, research, plan,
    automate, and communicate from your terminal.
  </Text>
</Box>
```

- [ ] **Step 2: Update the help dialog title and docs link**

In `src/components/HelpV2/HelpV2.tsx`, make these targeted replacements:

1. Replace the title expression around `src/components/HelpV2/HelpV2.tsx:141`:

```tsx
<Tabs title={false ? '/help' : `Cat Code v${MACRO.VERSION}`} color="professionalBlue" defaultTab="general">
```

with:

```tsx
<Tabs title={false ? '/help' : `Cat Code v${MACRO.VERSION}`} color="professionalBlue" defaultTab="general">
```

Leave the title text unchanged in this slice. The actual required change here is the docs link block below.

2. Replace the “For more help” block at `src/components/HelpV2/HelpV2.tsx:149` with:

```tsx
<Box marginTop={1}>
  <Text>
    For more context: <Link url="https://github.com/paoloanzn/free-code" />
  </Text>
</Box>
```

This removes the Claude Code docs pointer from the main help surface without expanding scope into a full docs audit.

- [ ] **Step 3: Update the top-level CLI description text**

In `src/main.tsx:982`, replace:

```ts
program.name('cat-code').description(`Cat Code - starts an interactive session by default, use -p/--print for non-interactive output`).argument('[prompt]', 'Your prompt', String)
```

with:

```ts
program.name('cat-code').description(`Cat Code - personal always-on agent. Starts an interactive session by default; use -p/--print for non-interactive output`).argument('[prompt]', 'Your prompt', String)
```

Do not broaden this task into renaming every command description.

- [ ] **Step 4: Tighten the README intro only**

Update only the opening section of `README.md:1-60` so it matches the new identity without doing the full Milestone 2 rebrand/doc rewrite. Replace the top intro block with:

```md
# Cat Code

<p align="center">
  <img src="assets/screenshot.png" alt="Cat Code" width="720" />
</p>

<h1 align="center">Cat Code</h1>

<p align="center">
  <strong>A personal always-on agent system.</strong><br>
  Built from a Claude Code fork and being reshaped into a general-purpose personal agent that also codes.<br>
  One binary, local-first, no callbacks home.
</p>
```

And replace `README.md:47-51` with:

```md
## What is this

Cat Code is a personal always-on agent system. It started from Anthropic's [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, but the product direction is broader: a general-purpose personal agent that can code, research, plan, automate, and communicate.

See [docs/vision/GOAL_PLAN.md](docs/vision/GOAL_PLAN.md) for the full vision and milestones.
```

Do not rewrite the provider sections, install flow, or the rest of the README in this slice.

- [ ] **Step 5: Build and manually verify the visible strings**

Run:

```bash
bun run build
./cli --help | head -40
```

Expected:
- build succeeds
- the top CLI description says “personal always-on agent”
- no obvious “Claude understands your codebase” wording remains in the help intro path you changed

If `head` is unavailable in your environment policy, use a plain `./cli --help` check instead and inspect the first block manually.

- [ ] **Step 6: Re-run the prompt regression test as a smoke check**

Run:

```bash
bun test src/utils/providerPromptRegressions.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit the user-facing identity alignment**

```bash
git add src/components/HelpV2/General.tsx src/components/HelpV2/HelpV2.tsx src/main.tsx README.md
git commit -m "docs: align core help and cli copy with phase1 identity"
```

---

## Self-Review

### Spec coverage
- Milestone 1 item “Rewrite the core system prompt so the model sees itself as a general-purpose agent, not a coding assistant” is covered by Task 2.
- Milestone 1 item “Remove Claude Code-specific onboarding, help text, and UX flows that assume a developer user” is covered only in the smallest visible surfaces by Task 3. The broader sweep is intentionally deferred to later slices.
- Milestone 1 item “Ensure the model can naturally handle non-coding tasks” is partially enabled by Task 2’s intro/doing-tasks rewrite, but not fully proven across all tool and agent surfaces. That belongs in later slices.
- Milestone 1 item “Per-provider system prompts” is not part of this slice because Phase 0 already established provider-native behavior; this slice preserves that structure.

### Placeholder scan
- No TBD/TODO placeholders remain.
- All code-changing steps include concrete code blocks.
- All verification steps include exact commands and expected outcomes.

### Type consistency
- Test code uses `Tools` from `src/Tool.ts`, matching the real `getSystemPrompt()` signature in `src/constants/prompts.ts:455`.
- Prompt function names and file paths match the current codebase.

---

Plan complete and saved to `docs/superpowers/plans/2026-04-11-phase1-agent-identity-slice-1.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**