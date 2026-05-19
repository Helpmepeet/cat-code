# Prompt System Map

Last refreshed: 2026-05-12

## Purpose

Daily-refreshable routing map for prompt and instruction surfaces in Cat Code.
Use this to choose the first files to inspect before changing prompt behavior.
It is a routing document, not the source of truth. Verify live behavior in the
source files below before editing prompt policy, context injection, or provider
request assembly.

## First Files To Inspect

Read in this order for most prompt or instruction work:

| Order | File | Why first |
|---|---|---|
| 1 | [`WORKSPACE_MAP.md`](WORKSPACE_MAP.md) | Current map index. Use focused maps before broad search. |
| 2 | [`../prompts/2026-04-30-prompt-surfaces.md`](../prompts/2026-04-30-prompt-surfaces.md) | Older prompt-specific index. Useful background, but verify against code. |
| 3 | [`../../src/constants/prompts.ts`](../../src/constants/prompts.ts) | Main prompt corpus and system-prompt section builders. |
| 4 | [`../../src/utils/systemPrompt.ts`](../../src/utils/systemPrompt.ts) | Runtime branch selection and append/replace rules. |
| 5 | [`../../src/context.ts`](../../src/context.ts) | Auto-injected user and system context. |
| 6 | [`../../src/utils/claudemd.ts`](../../src/utils/claudemd.ts) | Instruction file discovery, wrapping, includes, excludes, and priority. |
| 7 | [`../../src/utils/queryContext.ts`](../../src/utils/queryContext.ts) | Shared cache-prefix prompt/context fetcher and side-question fallback. |
| 8 | [`../../src/QueryEngine.ts`](../../src/QueryEngine.ts) | SDK/headless query setup and prompt refresh after model/provider changes. |
| 9 | [`../../src/query.ts`](../../src/query.ts) | Final query loop before provider request assembly. |
| 10 | [`../../src/services/api/instructionAssembly.ts`](../../src/services/api/instructionAssembly.ts) | Provider-specific placement of system, user, and volatile context. |
| 11 | [`../../src/services/api/claude.ts`](../../src/services/api/claude.ts) | API request prompt blocks, cache boundary handling, and extra API-time prompt prefixes. |
| 12 | [`../../src/tools/AgentTool/runAgent.ts`](../../src/tools/AgentTool/runAgent.ts) | Subagent prompt assembly and context trimming. |

## Prompt Routing By Goal

| Goal | Owner | Fallback order | Notes |
|---|---|---|---|
| Change normal default assistant behavior | `src/constants/prompts.ts` | `src/constants/promptStyles/gpt.ts`, `src/constants/systemPromptSections.ts`, `src/utils/systemPrompt.ts`, `src/QueryEngine.ts` | `getSystemPrompt()` builds the default prompt array. GPT-style sections can live in provider-specific prompt-style files. |
| Change Agent Mode system prompt behavior | `src/constants/prompts.ts` | `src/agent-mode/agentMode.ts`, `src/agent-mode/orchestratorPrompt.ts`, `src/agent-mode/rolePrompts.ts`, `src/utils/systemPrompt.ts` | Agent Mode is active via `CLAUDE_CODE_AGENT_MODE`. It uses dedicated sections from `getAgentModeSystemPromptSections()` when available. |
| Change runtime prompt precedence | `src/utils/systemPrompt.ts` | `src/utils/queryContext.ts`, `src/QueryEngine.ts`, `src/query.ts` | Effective branch order is override, Agent Mode, coordinator, main-thread agent, custom, default. `appendSystemPrompt` appends unless override replaces everything. |
| Change repo/user instruction loading | `src/utils/claudemd.ts` | `src/context.ts`, `src/utils/settings/constants.ts`, `src/utils/config.ts`, `src/bootstrap/state.ts` | This path controls managed, user, project, local, auto-memory, and team-memory instruction inputs. |
| Change generated context injection | `src/context.ts` | `src/utils/claudemd.ts`, `src/utils/queryContext.ts`, `src/QueryEngine.ts`, `src/services/api/instructionAssembly.ts` | User context and system context are separate channels until provider assembly. |
| Change SDK or custom-system-prompt behavior | `src/QueryEngine.ts` | `src/utils/queryContext.ts`, `src/utils/systemPrompt.ts`, `src/query.ts` | Custom prompts skip default prompt construction and skip `getSystemContext()` in `fetchSystemPromptParts()`. |
| Change final provider placement | `src/services/api/instructionAssembly.ts` | `src/query.ts`, `src/services/api/claude.ts`, `src/services/api/codex-fetch-adapter.ts`, `src/utils/providerPromptRegressions.test.ts` | OpenAI keeps volatile `gitStatus` and `cacheBreaker` in developer context instead of user input messages. Claude-style providers append system context and prepend user context. |
| Change subagent prompt behavior | `src/tools/AgentTool/runAgent.ts` | `src/tools/AgentTool/prompt.ts`, `src/tools/AgentTool/builtInAgents.ts`, `src/tools/AgentTool/loadAgentsDir.ts`, `src/agent-mode/rolePrompts.ts` | `runAgent.ts` builds the agent prompt, injects Agent Mode addenda, adds env details, and may trim inherited context. |
| Change output styles | `src/constants/outputStyles.ts` | `src/outputStyles/loadOutputStylesDir.ts`, `src/utils/plugins/loadPluginOutputStyles.ts`, `.claude/output-styles/*.md`, `~/.cat-code/output-styles/*.md` | Output style text is injected by `src/constants/prompts.ts`. |
| Change tool descriptions | `src/tools/*/prompt.ts` | `src/tools.ts`, `src/utils/api.ts`, `src/utils/providerPromptRegressions.test.ts` | Tool prompt files are model-visible instruction surfaces even when the main system prompt is unchanged. |
| Inspect emitted prompts | `src/services/api/dumpPrompts.ts` | `src/query.ts`, `src/services/api/claude.ts`, `/context` command paths | Ant-user dumps write under `~/.cat-code/dump-prompts/<session-or-agent-id>.jsonl` as init, system_update, message, and response entries. |

## Runtime Flow

```text
src/constants/prompts.ts
  builds default or Agent Mode prompt sections

src/context.ts
  builds userContext and systemContext

src/utils/claudemd.ts
  discovers and wraps CLAUDE.md, rules, includes, and memory files

src/utils/queryContext.ts
  fetches defaultSystemPrompt, agentModePromptSections, userContext, systemContext

src/QueryEngine.ts
  merges coordinator and Agent Mode user context
  optionally injects memory mechanics for custom prompt + auto-memory override
  calls buildEffectiveSystemPrompt()

src/utils/systemPrompt.ts
  selects the winning system prompt branch

src/query.ts
  applies compaction/collapse gates, then calls provider instruction assembly

src/services/api/instructionAssembly.ts
  places instructions/context differently for OpenAI vs Claude-style providers

src/services/api/claude.ts
  adds API-time prompt prefixes, tool-search extras, prompt-cache blocks, and sends
```

## Generated And Injected Context

| Context | Built by | Injected as | Key gates and behavior |
|---|---|---|---|
| `claudeMd` | `src/context.ts` via `src/utils/claudemd.ts` | `userContext` | Disabled by `CLAUDE_CODE_DISABLE_CLAUDE_MDS`; bare mode skips auto-discovery unless explicit additional dirs exist. |
| `currentDate` | `src/context.ts` | `userContext` | Always included by `getUserContext()` as local ISO date text. |
| `gitStatus` | `src/context.ts` | `systemContext` | Skipped for remote sessions or when git instructions are disabled; snapshot is memoized and capped. |
| `cacheBreaker` | `src/context.ts` | `systemContext` | Feature-gated by `BREAK_CACHE_COMMAND`; setting it clears user/system context memo caches. |
| Coordinator context | `src/coordinator/coordinatorMode.ts` | merged into `userContext` | Added by `QueryEngine.ts` and side-question fallback when coordinator mode is active. |
| Agent Mode worker/session context | `src/agent-mode/agentMode.ts` | merged into `userContext` | Added by `QueryEngine.ts` and `queryContext.ts` fallback; empty when Agent Mode is off. |
| Memory mechanics for custom prompts | `src/QueryEngine.ts` | appended system prompt text | Only when `customSystemPrompt` is set and auto-memory path override is present. |
| MCP instructions | `src/constants/prompts.ts` | prompt section or delta attachment | If MCP instruction delta is enabled, prompt text is not recomputed in the normal section. |
| Output style | `src/constants/prompts.ts` | dynamic system-prompt section | Loaded from built-in, user/project, or plugin output-style sources. |
| Scratchpad instructions | `src/constants/prompts.ts` | dynamic system-prompt section | Present only when scratchpad support is enabled. |

## Instruction File Discovery

`src/utils/claudemd.ts` loads instruction files in reverse priority order so
later entries have more weight:

1. Managed `CLAUDE.md` and managed rules.
2. User-global `CLAUDE.md` and user rules.
3. Project `CLAUDE.md`, `.claude/CLAUDE.md`, and `.claude/rules/*.md`, walking from root toward CWD.
4. Local `CLAUDE.local.md`, also root toward CWD.
5. Additional directory instructions when `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is enabled.
6. Auto-memory and team-memory entrypoints when their features are enabled.

Important details:

- `@include` paths can pull in additional text files, with circular-reference and external-include guards.
- `.claude/rules/*.md` can be conditional through frontmatter paths.
- `claudeMdExcludes` can suppress memory files.
- Nested git worktrees skip duplicate checked-in project files above the worktree.
- `filterInjectedMemoryFiles()` may omit auto-memory/team-memory index files when feature gates move them to attachments.
- `getClaudeMds()` wraps loaded content with explicit override language before injection.

## Subagent Prompt Notes

`src/tools/AgentTool/runAgent.ts` does not call `getSystemPrompt()` for normal
subagents. It builds a subagent prompt from the agent definition, Agent Mode
prompt injections, `enhanceSystemPromptWithEnvDetails()`, and inherited
context.

Watch these trims before debugging "missing" instructions in a worker:

- Read-only agents with `omitClaudeMd` can drop `claudeMd` unless an explicit override context is passed.
- Explore and Plan agents drop inherited `gitStatus`; they can run git commands when they need fresh state.
- Built-in agents can receive extra Agent Mode prompt injections.
- Fork children that use exact tools preserve more parent context to maximize cache compatibility.

## Tests And Validation Entry Points

Use focused checks first, then the documented build:

| Area | Command |
|---|---|
| Main prompt and Agent Mode prompt sections | `bun test src/constants/prompts.test.ts` |
| Provider instruction placement and prompt regressions | `bun test src/utils/providerPromptRegressions.test.ts` |
| Main query behavior | `bun test src/query.test.ts` |
| Agent Mode context and prompt owners | `bun test src/agent-mode/agentMode.test.ts src/agent-mode/orchestratorPrompt.test.ts src/agent-mode/rolePrompts.test.ts` |
| Agent tool prompt/resume behavior | `bun test src/tools/AgentTool/prompt.test.ts src/tools/AgentTool/resumeAgent.test.ts src/tools/AgentTool/AgentTool.test.ts` |
| Compaction prompt behavior | `bun test src/services/compact/prompt.test.ts src/services/compact/compact.test.ts` |
| Full documented build | `bun run build:dev:full` |

For emitted-prompt inspection, use prompt dumps when available:

- `src/services/api/dumpPrompts.ts` writes `~/.cat-code/dump-prompts/<session-or-agent-id>.jsonl` for ant users.
- Inspect `init` and `system_update` records for system/tool payload changes.
- Use `/context` when available to compare loaded instruction files and prompt sections.

## Traps And Stale Assumptions

- Do not assume `src/constants/prompts.ts` always wins. Agent Mode, coordinator mode, main-thread agent prompts, custom prompts, and override prompts can replace it.
- Do not assume `appendSystemPrompt` replaces the prompt. It appends to the winning branch, except when `overrideSystemPrompt` is set.
- Do not assume custom prompts still get `gitStatus`. `fetchSystemPromptParts()` skips `getSystemContext()` when `customSystemPrompt` is present.
- Do not assume `CLAUDE.md` is part of the system prompt. It is collected as `userContext`, then placed by provider assembly.
- Do not assume OpenAI and Claude-style providers receive context in the same shape. OpenAI puts stable context in `instructions` and volatile session metadata in developer context.
- Do not assume a subagent sees the same context as the main loop. `runAgent.ts` may omit `claudeMd` or `gitStatus` by agent type and feature gate.
- Do not assume Agent Mode is only a plan. It is wired through `src/constants/prompts.ts`, `src/utils/systemPrompt.ts`, `src/utils/queryContext.ts`, `src/QueryEngine.ts`, and `src/agent-mode/`.
- Do not move or remove `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` without checking prompt-cache code in `src/utils/api.ts` and `src/services/api/claude.ts`.
- Do not trust older docs that mention a missing `src/agent/prompt.ts` split. Verify current prompt entrypoints in this map.
- Do not debug MCP prompt churn only in `prompts.ts`; MCP instruction delta behavior can move instructions out of the normal prompt section.
- Do not forget API-time additions in `src/services/api/claude.ts`, such as CLI prompt prefixes and tool-search related instructions.
