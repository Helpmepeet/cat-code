# Phase 0: GPT-Native Prompt Style — Layer 4: Tool Descriptions

**Status:** Ready for implementation (depends on Layer 1, lowest priority)
**Scope:** Evaluate and selectively rephrase tool description prompts for GPT-optimal delivery. Same tool semantics, different instruction style where it materially improves GPT tool-calling quality.

---

## Context

Layers 1-3 cover the core system prompt, agent prompts, and service prompts. This layer covers the 50+ tool description files in `src/tools/*/prompt.ts`.

Tool descriptions are presented to the model as part of the tool schema. They describe what each tool does, when to use it, and any usage constraints. Unlike the system prompt (which is long-form behavioral instruction), tool descriptions are relatively short and already fairly structured — they're closer to API documentation than conversational guidance.

The OpenAI prompt engineering guide is the reference: https://developers.openai.com/api/docs/guides/prompt-guidance

Key question for this layer: **Do tool descriptions actually need GPT-specific rephrasing?** The answer is "selectively." Most tool descriptions are short, factual, and schema-adjacent — they work fine across providers. A few have long behavioral guidance sections that would benefit from GPT contract style.

---

## Assessment approach

Before rewriting anything, evaluate each tool description by asking:

1. **Is it long enough to matter?** Descriptions under ~5 lines are unlikely to benefit from restyling.
2. **Does it contain behavioral instructions?** "Use this tool when X, don't use it when Y" — these benefit from GPT contract style.
3. **Does it have complex conditional guidance?** Multiple "if/then" rules benefit from numbered priority ordering.
4. **Is there evidence of GPT struggling with this tool?** Tool-calling errors, wrong tool selection, incorrect parameter usage.

### Likely candidates for GPT variants (long, behavioral, conditional)

| Tool | File | Why |
|---|---|---|
| **BashTool** | `src/tools/BashTool/prompt.ts` | Long description with many behavioral rules (prefer dedicated tools, quoting, git safety, etc.) |
| **AgentTool** | `src/tools/AgentTool/prompt.ts` | Complex guidance about when to use agents, agent types, prompt writing tips |
| **FileEditTool** | `src/tools/FileEditTool/prompt.ts` | Usage rules about reading first, indentation, uniqueness |
| **FileWriteTool** | `src/tools/FileWriteTool/prompt.ts` | Rules about when to write vs edit, reading first |
| **TodoWriteTool** | `src/tools/TodoWriteTool/prompt.ts` | Task management guidance |
| **SkillTool** | `src/tools/SkillTool/prompt.ts` | Skill invocation rules |
| **GrepTool** | `src/tools/GrepTool/prompt.ts` | Complex regex and output mode guidance |

### Likely fine as-is (short, factual, schema-adjacent)

Most other tools: GlobTool, FileReadTool, SleepTool, WebFetchTool, WebSearchTool, EnterPlanModeTool, ExitPlanModeTool, SendMessageTool, AskUserQuestionTool, MCPTool, ConfigTool, LSPTool, TaskCreate/Get/List/Stop/Update tools, etc.

---

## What needs to happen

### 1. Audit all tool descriptions

Read every `src/tools/*/prompt.ts` file. For each, decide: GPT variant needed, or fine as-is.

Criteria:
- If the description is >10 lines and contains behavioral "when to use / when not to use" guidance → needs GPT variant
- If the description is short and factual → skip
- If the description has complex conditional rules → needs GPT variant

### 2. Write GPT variants for selected tools

For each tool that needs a GPT variant, add a style branch in the prompt file using `isGPTPromptStyle()`.

GPT tool description patterns:
- **When to use**: explicit trigger conditions, not explanatory prose
- **When NOT to use**: explicit exclusion list
- **Parameter guidance**: per-parameter rules, not narrative
- **Safety rules**: as binding constraints with verification steps

Example transformation (BashTool — "prefer dedicated tools" rule):

**Claude style** (current):
```
Do NOT use the Bash to run commands when a relevant dedicated tool is provided.
Using dedicated tools allows the user to better understand and review your work.
```

**GPT style** (target):
```
CONSTRAINT: Before using Bash, check if a dedicated tool exists for this operation.
If Read, Edit, Write, Glob, or Grep can accomplish the task, use that tool instead.
Bash is reserved for operations that no dedicated tool covers.
```

### 3. Tool descriptions that are part of the system prompt

Some tool guidance lives in the system prompt (`getUsingYourToolsSection()` in `prompts.ts`) rather than the tool description itself. That's already handled by Layer 1. This layer only covers the `prompt.ts` files.

---

## Files involved

### Modified files (selective — only tools that need GPT variants)

High priority:
- `src/tools/BashTool/prompt.ts`
- `src/tools/AgentTool/prompt.ts`
- `src/tools/FileEditTool/prompt.ts`
- `src/tools/FileWriteTool/prompt.ts`

Medium priority (evaluate first):
- `src/tools/TodoWriteTool/prompt.ts`
- `src/tools/SkillTool/prompt.ts`
- `src/tools/GrepTool/prompt.ts`
- `src/tools/FileReadTool/prompt.ts`

### Files to read for context (do NOT modify)
- `src/constants/promptStyle.ts` — the style router (created in Layer 1)
- `src/constants/prompts.ts` — system prompt tool guidance (handled in Layer 1)
- All `src/tools/*/prompt.ts` files — read for audit

---

## What does NOT change

- Tool schemas (Zod definitions) — these are parameter contracts, not prose
- Tool implementations — behavior stays the same
- MCP tool descriptions — third-party, not our prompts
- Tool prompt files that are short and factual — skip if no material benefit

---

## Verification

1. `bun run build` — no type/import errors
2. Set `CLAUDE_CODE_USE_OPENAI=1`, start a session, inspect the tool descriptions in dumped prompts — GPT-style descriptions should appear for modified tools
3. Unset the env var — Claude-style descriptions unchanged
4. For each modified tool, verify the description preserves all usage rules and constraints
5. Optionally: test GPT tool-calling accuracy on tools with the longest descriptions (BashTool, AgentTool) before and after to measure improvement
