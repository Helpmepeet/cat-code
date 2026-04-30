# Prompt And Instruction Surfaces

This is the prompt-routing index for this repository.

Use it when you need to answer questions like:
- Where is the main system prompt?
- Which files inject additional instructions into the model context?
- Where do subagent, tool, memory, and maintenance prompts live?
- Which prompt sources are user-configurable outside the repo?

This file is intentionally:
- routing-oriented
- prompt-focused
- broader than `docs/reference/WORKSPACE_MAP.md` for prompt work
- not a line-by-line walkthrough of every prompt string

## Edit By Goal

| Goal | Start here | Then inspect |
|---|---|---|
| Change default assistant behavior (coding deployment) | `src/constants/prompts.ts` | `src/constants/systemPromptSections.ts`, `src/QueryEngine.ts` |
| Change deployment-aware prompt behavior | `src/constants/prompts.ts` | `src/tools/AgentTool/runAgent.ts`, `src/constants/system.ts`, `src/constants/prompts.ts` |
| Change prompt priority / override behavior | `src/utils/systemPrompt.ts` | `src/QueryEngine.ts`, `src/coordinator/coordinatorMode.ts`, `src/tools/AgentTool/loadAgentsDir.ts` |
| Change injected repo or user instructions | `src/utils/claudemd.ts` | `src/context.ts`, repo `CLAUDE.md`, `.claude/rules/*.md`, `CLAUDE.local.md` |
| Change final prompt assembly before model invocation | `src/QueryEngine.ts` | `src/utils/queryContext.ts`, `src/services/api/claude.ts` |
| Change output-style prompt content | `src/constants/outputStyles.ts` | `src/outputStyles/loadOutputStylesDir.ts` |
| Change subagent or coordinator prompt behavior | `src/coordinator/coordinatorMode.ts` | `src/tools/AgentTool/prompt.ts`, `src/tools/AgentTool/built-in/*.ts` |

## Start Here

If you are changing the assistant's main behavior, inspect these in order:

1. `src/constants/prompts.ts`
2. `src/utils/systemPrompt.ts`
3. `src/context.ts`
4. `src/utils/claudemd.ts`
5. `src/utils/queryContext.ts`
6. `src/QueryEngine.ts`

That path covers:
- the default system prompt text
- runtime prompt selection and replacement
- auto-injected git/date/user instruction context
- `CLAUDE.md` and `.claude/rules/*.md` loading
- `customSystemPrompt` and `appendSystemPrompt`
- final assembly before model invocation

## Prompt Flow

```text
src/constants/prompts.ts
  builds default system prompt blocks

src/utils/systemPrompt.ts
  chooses the winning prompt branch:
  override > agent-mode > coordinator > agent > custom > default

appendSystemPrompt
  appended at the end of the winning branch
  except when overrideSystemPrompt fully replaces the prompt

src/context.ts
  injects userContext:
    - claudeMd
    - currentDate
  injects systemContext:
    - gitStatus
    - cacheBreaker

src/QueryEngine.ts
  assembles effective prompt + injected contexts

src/services/api/claude.ts
  emits the final API request
```

## Highest-Leverage Prompt Surfaces

These are the surfaces you are most likely to configure directly.

| Surface | Primary owner files | What it controls |
|---|---|---|
| Default assistant system prompt (coding) | `src/constants/prompts.ts` | Base policy, behavior rules, tool-use guidance, response conventions |
| Deployment-aware system prompt behavior | `src/constants/prompts.ts`, `src/tools/AgentTool/runAgent.ts` | Main prompt behavior, agent runtime prompt assembly, and deployment-related behavior checks |
| Effective prompt selection | `src/utils/systemPrompt.ts`, `src/QueryEngine.ts` | Override vs default vs coordinator vs agent prompt, plus appended prompt text |
| Auto-injected context | `src/context.ts`, `src/utils/queryContext.ts` | Git snapshot, current date, injected prompt sections, user context |
| Repo/user/admin instructions | `src/utils/claudemd.ts` | Managed, user, project, and local `CLAUDE.md` and `.claude/rules/*.md` loading order |
| Output style prompts | `src/constants/outputStyles.ts`, `src/outputStyles/loadOutputStylesDir.ts` | Style-specific prompt text layered into the main prompt |
| Coordinator and subagent prompts | `src/coordinator/coordinatorMode.ts`, `src/tools/AgentTool/prompt.ts`, `src/tools/AgentTool/built-in/*.ts`, `src/tools/AgentTool/loadAgentsDir.ts` | Worker orchestration policy, agent spawning guidance, built-in and custom agent system prompts |

## Safe Vs Careful Edits

Usually safe for content changes:

- `src/constants/prompts.ts`
- `src/constants/outputStyles.ts`
- `src/tools/*/prompt.ts`
- `src/tools/AgentTool/built-in/*.ts`
- repo `CLAUDE.md` and `.claude/rules/*.md`

Core plumbing: edit carefully:

- `src/utils/systemPrompt.ts`
- `src/QueryEngine.ts`
- `src/utils/queryContext.ts`
- `src/context.ts`
- `src/utils/claudemd.ts`
- `src/constants/systemPromptSections.ts`
- `src/services/api/claude.ts`

## Core System Prompt Pipeline

| File | Role |
|---|---|
| `src/constants/prompts.ts` | Main default system prompt text and section builders |
| `src/constants/prompts.ts` | Main default system prompt text and deployment-aware behavior |
| `src/tools/AgentTool/runAgent.ts` | Agent runtime system prompt builder (`getAgentSystemPrompt()`) |
| `src/constants/systemPromptSections.ts` | Memoized/volatile prompt section helpers |
| `src/utils/systemPrompt.ts` | Chooses the effective system prompt array at runtime |
| `src/utils/queryContext.ts` | Fetches prompt pieces used to build cache-safe prompt context |
| `src/context.ts` | Injects git status, current date, and loaded instruction memory |
| `src/utils/claudemd.ts` | Loads instruction files and wraps them for prompt injection |
| `src/QueryEngine.ts` | Final assembly of `defaultSystemPrompt`, `customSystemPrompt`, memory prompt, and `appendSystemPrompt` |

## How Instructions Stack

This section describes the instruction stack in three complementary ways:

1. File discovery order
2. Runtime prompt assembly
3. Override precedence

### 1. File Discovery Order

This is the `CLAUDE.md` and rules loading order handled by `src/utils/claudemd.ts`.

Low priority to high priority:

1. Managed instruction files
2. User-global instruction files
3. Project instruction files
4. Local/private project instruction files

Concretely, that means:

- Managed `CLAUDE.md`
- `~/.cat-code/CLAUDE.md`
- `~/.cat-code/rules/*.md`
- repo `CLAUDE.md`
- repo `.claude/CLAUDE.md`
- repo `.claude/rules/*.md`
- repo `CLAUDE.local.md`

Two important details:

- Directory traversal matters: instruction files closer to the current working directory are higher priority than ones higher up the tree.
- `src/utils/claudemd.ts` explicitly frames these loaded files as overriding default behavior.

### 2. Runtime Prompt Assembly

This is the request-time stack used by `src/constants/prompts.ts`, `src/context.ts`, `src/utils/queryContext.ts`, and `src/QueryEngine.ts`.

Think of the runtime instruction stack as multiple channels, not one flat string:

1. Base system prompt from `src/constants/prompts.ts`
2. Dynamic system-prompt sections resolved inside that same pipeline
3. User context from `src/context.ts`
4. System context from `src/context.ts`
5. Final prompt selection and optional append/replace logic in `src/utils/systemPrompt.ts` and `src/QueryEngine.ts`

In more practical detail:

- The base system prompt starts in `src/constants/prompts.ts`.
- That default prompt already includes layered sections such as:
  - output style
  - memory instructions
  - language preference
  - MCP server instructions
  - scratchpad/tool-result/session guidance
- `src/context.ts` separately injects:
  - `claudeMd`
  - current date
  - git status
  - cache-breaker state when enabled
- `src/QueryEngine.ts` then builds the effective request using:
  - `defaultSystemPrompt`
  - `customSystemPrompt` when provided
  - memory mechanics prompt in the custom-prompt path
  - `appendSystemPrompt`

So the real model-facing instruction stack is:

1. effective system prompt array
2. user context attachments such as `CLAUDE.md`
3. system context such as git/date-related data

### 3. Override Precedence

This is the replacement order, not the load order.

Primary precedence is defined in `src/utils/systemPrompt.ts`:

1. `overrideSystemPrompt`
2. Agent mode system prompt
3. coordinator system prompt
4. main-thread agent system prompt
5. `customSystemPrompt`
6. default system prompt

Then:

- `appendSystemPrompt` is added at the end unless `overrideSystemPrompt` fully replaces everything.

Important nuance:

- In proactive mode, an agent prompt may be appended on top of the default prompt instead of replacing it.
- In normal mode, agent or custom prompts replace the default prompt branch selected beneath them.

### Short Mental Model

If you want the shortest useful model:

- `src/utils/claudemd.ts` decides which instruction files are loaded
- `src/constants/prompts.ts` builds the default instruction body
- `src/context.ts` injects extra instruction/context channels
- `src/utils/systemPrompt.ts` decides which prompt branch wins
- `src/QueryEngine.ts` assembles the final request

## Concrete Example Trace

Case:

- repo `CLAUDE.md` exists
- `customSystemPrompt` is set
- `appendSystemPrompt` is also set

What happens:

1. `src/utils/claudemd.ts` still loads repo instructions
2. `src/utils/queryContext.ts` skips the default prompt build because `customSystemPrompt` is set
3. `src/utils/queryContext.ts` also skips `systemContext` on that path
4. `src/QueryEngine.ts` builds the system prompt from:
   - `customSystemPrompt`
   - optional memory mechanics prompt
   - `appendSystemPrompt`
5. `src/context.ts` still contributes `userContext`, so repo `CLAUDE.md` remains in context

Final effective stack in that case:

- system prompt:
  - `customSystemPrompt`
  - optional memory mechanics prompt
  - `appendSystemPrompt`
- user context:
  - repo `CLAUDE.md`
  - current date
- system context:
  - omitted on the custom-prompt path

The important consequence:

- editing `src/constants/prompts.ts` will not affect this request
- editing repo `CLAUDE.md` still can affect this request
- `appendSystemPrompt` adds to the custom prompt; it does not replace it

## Instruction Sources Outside The Repo

These are not `src/` files, but they are first-class instruction inputs to the system.

| Source | Loaded by | Notes |
|---|---|---|
| `~/.cat-code/CLAUDE.md` | `src/utils/claudemd.ts` | User-global instructions |
| `~/.cat-code/rules/*.md` | `src/utils/claudemd.ts` | User-global rule fragments |
| `CLAUDE.md` | `src/utils/claudemd.ts` | Project-shared instructions |
| `.claude/CLAUDE.md` | `src/utils/claudemd.ts` | Project-shared instructions under `.claude/` |
| `.claude/rules/*.md` | `src/utils/claudemd.ts` | Project rule fragments |
| `CLAUDE.local.md` | `src/utils/claudemd.ts` | Project-local private instructions |
| Managed `CLAUDE.md` locations | `src/utils/claudemd.ts`, `src/utils/config.ts` | Admin-controlled global instructions |
| `.claude/output-styles/*.md` | `src/outputStyles/loadOutputStylesDir.ts` | Project output style prompt files |
| `~/.cat-code/output-styles/*.md` | `src/outputStyles/loadOutputStylesDir.ts` | User output style prompt files |
| `.claude/agents/*.md` | `src/tools/AgentTool/loadAgentsDir.ts` | Project custom agent system prompts |
| `~/.cat-code/agents/*.md` | `src/tools/AgentTool/loadAgentsDir.ts` | User custom agent system prompts |
| `~/.cat-code/session-memory/config/prompt.md` | `src/services/SessionMemory/prompts.ts` | Override for session-memory update prompt |
| `~/.cat-code/magic-docs/prompt.md` | `src/services/MagicDocs/prompts.ts` | Override for Magic Docs update prompt |

## Common Mistakes

- Editing `src/constants/prompts.ts` but seeing no change because `src/utils/systemPrompt.ts` selected coordinator, agent, custom, or override prompt instead.
- Editing repo instruction files but getting overridden by a closer `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`, or `CLAUDE.local.md`.
- Treating `appendSystemPrompt` as replacement behavior. It appends to the selected branch; it does not become the branch.
- Debugging only the system prompt and forgetting that `CLAUDE.md` is injected through `userContext`, not built inside `src/constants/prompts.ts`.
- Changing prompt text and then reading stale assumptions from cached prompt sections or old diagnostics instead of checking the emitted request again.

## How To Debug The Final Emitted Prompt

Use this order:

1. Check which branch should win in `src/utils/systemPrompt.ts`.
   - If `overrideSystemPrompt` is set, stop there.
   - Otherwise check coordinator mode, main-thread agent prompt, then `customSystemPrompt`, then default prompt.
2. Check request-time assembly in `src/QueryEngine.ts`.
   - Look at where `customSystemPrompt`, memory mechanics, and `appendSystemPrompt` are combined.
3. Check injected instruction context in `src/context.ts`.
   - `getUserContext()` tells you whether `claudeMd` and current date are included.
   - `getSystemContext()` tells you whether git status and cache-breaker data are included.
4. Check `src/utils/claudemd.ts` if repo instructions did not appear.
   - Verify discovery order, directory traversal, excludes, and whether a closer file won.
5. Check the emitted API payload if available.
   - `src/services/api/dumpPrompts.ts` writes request dumps under `~/.cat-code/dump-prompts/<session-or-agent-id>.jsonl`.
   - In those dumps, inspect the `init` or `system_update` records to see the emitted `system` payload.
6. Use `/context` when available.
   - `src/commands/context/context.tsx` and `src/utils/analyzeContext.ts` help confirm system prompt sections, memory files, and context composition.

Practical checks:

- To tell which branch won:
  - if the emitted system prompt starts with coordinator text, `src/coordinator/coordinatorMode.ts` won
  - if it starts with a built-in or custom agent prompt, the agent branch won
  - if your `src/constants/prompts.ts` edits are absent, a replacement branch won
- To confirm whether `CLAUDE.md` was loaded:
  - inspect `getUserContext()` in `src/context.ts`
  - inspect discovery and excludes in `src/utils/claudemd.ts`
  - use `/context` or request dumps to confirm the user-context side actually changed
- To verify append vs replace behavior:
  - check whether your text appears at the end of the emitted system prompt
  - if the whole prompt body changed shape, you are likely on a replacement branch rather than an append-only change

## Output Style Prompt Surfaces

| File | Role |
|---|---|
| `src/constants/outputStyles.ts` | Built-in output-style prompt text |
| `src/outputStyles/loadOutputStylesDir.ts` | Loads markdown-defined output styles |
| `src/utils/plugins/loadPluginOutputStyles.ts` | Loads plugin-defined output styles |

## Coordinator And Agent Prompt Surfaces

### Main coordinator/subagent routing

| File | Role |
|---|---|
| `src/coordinator/coordinatorMode.ts` | Coordinator-mode system prompt and worker context |
| `src/tools/AgentTool/prompt.ts` | Instructions for how the main agent should use the Agent tool |
| `src/tools/AgentTool/loadAgentsDir.ts` | Loads custom agent markdown and exposes their system prompts |
| `src/tools/AgentTool/builtInAgents.ts` | Registers built-in agents |
| `src/tools/AgentTool/agentMemory.ts` | Loads memory addenda for agents with persistent memory |

### Built-in agent prompt files

- `src/tools/AgentTool/built-in/generalPurposeAgent.ts`
- `src/tools/AgentTool/built-in/exploreAgent.ts`
- `src/tools/AgentTool/built-in/planAgent.ts`
- `src/tools/AgentTool/built-in/verificationAgent.ts`
- `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts`
- `src/tools/AgentTool/built-in/statuslineSetup.ts`

## Tool Prompt Files

These files define tool descriptions and usage instructions exposed to the model.

### Filesystem, shell, and search

- `src/tools/BashTool/prompt.ts`
- `src/tools/PowerShellTool/prompt.ts`
- `src/tools/FileReadTool/prompt.ts`
- `src/tools/FileEditTool/prompt.ts`
- `src/tools/FileWriteTool/prompt.ts`
- `src/tools/NotebookEditTool/prompt.ts`
- `src/tools/GlobTool/prompt.ts`
- `src/tools/GrepTool/prompt.ts`

### Agenting, planning, and task flow

- `src/tools/AgentTool/prompt.ts`
- `src/tools/AskUserQuestionTool/prompt.ts`
- `src/tools/EnterPlanModeTool/prompt.ts`
- `src/tools/ExitPlanModeTool/prompt.ts`
- `src/tools/SendMessageTool/prompt.ts`
- `src/tools/TaskCreateTool/prompt.ts`
- `src/tools/TaskGetTool/prompt.ts`
- `src/tools/TaskListTool/prompt.ts`
- `src/tools/TaskStopTool/prompt.ts`
- `src/tools/TaskUpdateTool/prompt.ts`
- `src/tools/TeamCreateTool/prompt.ts`
- `src/tools/TeamDeleteTool/prompt.ts`
- `src/tools/TodoWriteTool/prompt.ts`

### Integration and utility tools

- `src/tools/BriefTool/prompt.ts`
- `src/tools/ConfigTool/prompt.ts`
- `src/tools/EnterWorktreeTool/prompt.ts`
- `src/tools/ExitWorktreeTool/prompt.ts`
- `src/tools/LSPTool/prompt.ts`
- `src/tools/ListMcpResourcesTool/prompt.ts`
- `src/tools/MCPTool/prompt.ts`
- `src/tools/ReadMcpResourceTool/prompt.ts`
- `src/tools/RemoteTriggerTool/prompt.ts`
- `src/tools/ScheduleCronTool/prompt.ts`
- `src/tools/SkillTool/prompt.ts`
- `src/tools/SleepTool/prompt.ts`
- `src/tools/ToolSearchTool/prompt.ts`
- `src/tools/WebFetchTool/prompt.ts`
- `src/tools/WebSearchTool/prompt.ts`

## Memory, Summarization, And Maintenance Prompts

These are model-driven prompt surfaces that are not the main assistant system prompt, but still govern important system behavior.

| File | Role |
|---|---|
| `src/memdir/teamMemPrompts.ts` | Auto/team memory instructions injected into the main assistant prompt |
| `src/services/extractMemories/prompts.ts` | Background memory-extraction subagent prompt |
| `src/services/SessionMemory/prompts.ts` | Session-memory summary/update prompt, with user override support |
| `src/services/compact/prompt.ts` | Conversation compaction/summarization prompt |
| `src/services/MagicDocs/prompts.ts` | Magic Docs update prompt, with user override support |
| `src/services/autoDream/consolidationPrompt.ts` | Memory consolidation prompt for auto-dream flows |

## Other Prompt Modules

| File | Role |
|---|---|
| `src/utils/claudeInChrome/prompt.ts` | Browser-automation instruction text for Claude-in-Chrome flows |
| `src/utils/ultraplan/prompt.txt` | Minimal ultraplan planning prompt |
| `src/buddy/prompt.ts` | Companion/buddy instruction attachment text |

## Important Prompt Adjacent Files

These are not primary prompt owners, but they often matter when prompt changes appear not to take effect.

| File | Why it matters |
|---|---|
| `src/bootstrap/state.ts` | Caches system prompt sections and related state |
| `src/services/api/dumpPrompts.ts` | Useful for inspecting emitted prompts |
| `src/services/api/promptCacheBreakDetection.ts` | Prompt cache diagnostics |
| `src/utils/mcpInstructionsDelta.ts` | Controls MCP instruction delta behavior |
| `src/utils/plugins/loadPluginAgents.ts` | Plugin-provided agent prompts |
| `src/utils/plugins/loadPluginOutputStyles.ts` | Plugin-provided output-style prompts |

## Practical Routing

- If you want to change default assistant behavior, start at `src/constants/prompts.ts`.
- If you want to change repo/user instruction files, start at `src/utils/claudemd.ts`.
- If you want to change runtime prompt precedence, start at `src/utils/systemPrompt.ts` and `src/QueryEngine.ts`.
- If you want to change worker or subagent behavior, start at `src/coordinator/coordinatorMode.ts` and `src/tools/AgentTool/`.
- If you want to change tool instructions, start in `src/tools/*/prompt.ts`.
- If you want to change output styles, start at `src/constants/outputStyles.ts` and `.claude/output-styles/*.md`.
- If you want to inspect everything prompt-related before editing, read this file first, then `docs/reference/WORKSPACE_MAP.md`.
