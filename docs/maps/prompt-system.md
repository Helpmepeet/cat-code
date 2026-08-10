# Prompt System Map

Last refreshed: 2026-08-10

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
| 1 | [`../../src/constants/prompts.ts`](../../src/constants/prompts.ts) | Main prompt corpus, provider sections, and default/Agent Mode builders. |
| 2 | [`../../src/constants/corePolicy.ts`](../../src/constants/corePolicy.ts) | Shared policy core for cyber, provenance, instruction authority, outcome reporting, and retry budget. |
| 3 | [`../../src/constants/systemPromptSections.ts`](../../src/constants/systemPromptSections.ts) | Section registration and input-keyed prompt cache behavior. |
| 4 | [`../../src/utils/systemPrompt.ts`](../../src/utils/systemPrompt.ts) | Runtime branch selection and append/replace rules. |
| 5 | [`../../src/utils/claudemd.ts`](../../src/utils/claudemd.ts) | Instruction-file discovery, source-tier wrapper, includes, excludes, and priority. |
| 6 | [`../../src/utils/queryContext.ts`](../../src/utils/queryContext.ts) | Shared prompt/context fetcher and side-question fallback. |
| 7 | [`../../src/services/api/instructionAssembly.ts`](../../src/services/api/instructionAssembly.ts) | Provider-specific placement of system, user, and volatile context. |

## Prompt Routing By Goal

| Goal | Owner | Fallback order | Notes |
|---|---|---|---|
| Change normal default assistant behavior | `src/constants/prompts.ts` | `src/constants/{corePolicy,systemPromptSections}.ts`, `src/constants/promptStyles/gpt.ts`, `src/utils/systemPrompt.ts`, `src/QueryEngine.ts` | `getSystemPrompt()` builds the default prompt array. `corePolicy.ts` supplies the provider/mode-neutral action policy; GPT-specific sections remain in `promptStyles/gpt.ts`. |
| Change Agent Mode system prompt behavior | `src/constants/prompts.ts` | `src/constants/corePolicy.ts`, `src/agent-mode/{agentMode,orchestratorPrompt,rolePrompts}.ts`, `src/utils/systemPrompt.ts` | Agent Mode is active via `CLAUDE_CODE_AGENT_MODE`; its sections select the same provider policy core and actions as the default path, then add Agent Mode doctrine. |
| Change prompt-section cache correctness | `src/constants/systemPromptSections.ts` | `src/constants/prompts.ts`, `src/utils/queryContext.ts`, `src/screens/REPL.tsx` | Cache entries are keyed by each section's captured inputs. Cache-breaking sections must not populate that cache; language intentionally remains session-stable until a cache-clearing transition. |
| Change runtime prompt precedence | `src/utils/systemPrompt.ts` | `src/utils/queryContext.ts`, `src/QueryEngine.ts`, `src/query.ts` | Effective branch order is override, Agent Mode, coordinator, main-thread agent, custom, default. `appendSystemPrompt` appends unless override replaces everything. |
| Change repo/user instruction and recalled-memory loading | `src/utils/claudemd.ts` | `src/constants/corePolicy.ts`, `src/context.ts`, `src/utils/settings/constants.ts`, `src/utils/config.ts` | This path controls managed, user, project, and local instruction inputs plus separately framed auto-memory and team-memory indexes. Its source-tier wrapper grants workflow/repository authority, never permission authority. |
| Change generated context injection | `src/context.ts` | `src/utils/claudemd.ts`, `src/utils/queryContext.ts`, `src/QueryEngine.ts`, `src/services/api/instructionAssembly.ts` | User context and system context are separate channels until provider assembly. |
| Change SDK or custom-system-prompt behavior | `src/QueryEngine.ts` | `src/utils/queryContext.ts`, `src/utils/systemPrompt.ts`, `src/query.ts` | Custom prompts skip default prompt construction and skip `getSystemContext()` in `fetchSystemPromptParts()`. |
| Change final provider placement | `src/services/api/instructionAssembly.ts` | `src/query.ts`, `src/services/api/claude.ts`, `src/services/api/codex-fetch-adapter.ts`, `src/utils/providerPromptRegressions.test.ts` | OpenAI keeps volatile `gitStatus` and `cacheBreaker` in developer context instead of user input messages. Claude-style providers append system context and prepend user context. |
| Change subagent prompt behavior | `src/tools/AgentTool/runAgent.ts` | `src/tools/AgentTool/prompt.ts`, `src/tools/AgentTool/builtInAgents.ts`, `src/tools/AgentTool/loadAgentsDir.ts`, `src/agent-mode/rolePrompts.ts` | `runAgent.ts` builds the agent prompt, injects Agent Mode addenda, adds env details, and may trim inherited context. |
| Change output styles | `src/constants/outputStyles.ts` | `src/outputStyles/loadOutputStylesDir.ts`, `src/utils/plugins/loadPluginOutputStyles.ts`, `.claude/output-styles/*.md`, `~/.cat-code/output-styles/*.md` | Output style text is injected by `src/constants/prompts.ts`. |
| Change tool descriptions | `src/tools/*/prompt.ts` | `src/tools.ts`, `src/utils/api.ts`, `src/utils/providerPromptRegressions.test.ts` | Tool prompt files are model-visible instruction surfaces even when the main system prompt is unchanged. `src/tools/BashTool/prompt.ts` also owns model-facing git/commit guidance, shell failure handling, sandbox retry wording, background execution, and sleep/polling guidance. |
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

## Instruction And Recalled-Memory Discovery

`src/utils/claudemd.ts` loads instruction files in reverse priority order so
later entries have more weight:

1. Managed `CLAUDE.md` and managed rules.
2. User-global `CLAUDE.md` and user rules.
3. Project `CLAUDE.md`, `.claude/CLAUDE.md`, and `.claude/rules/*.md`, walking from root toward CWD.
4. Local `CLAUDE.local.md`, also root toward CWD.
5. Additional directory instructions when `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is enabled.
6. Auto-memory and team-memory entrypoints when their features are enabled;
   these are recalled background context, not instruction files.

Important details:

- `@include` paths can pull in additional text files, with circular-reference and external-include guards.
- `.claude/rules/*.md` can be conditional through frontmatter paths.
- `claudeMdExcludes` can suppress memory files.
- Nested git worktrees skip duplicate checked-in project files above the worktree.
- `filterInjectedMemoryFiles()` may omit auto-memory/team-memory index files when feature gates move them to attachments.
- `getClaudeMds()` gives managed/user/project/local instruction files explicit
  override language, while AutoMem/TeamMem indexes receive recalled-background
  framing with a verify-before-acting caveat.

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
- The default Agent-tool guidance says to work inline unless delegation has a named advantage: parallel work, an independent perspective, or isolating a raw-output-heavy sweep.

## Tests And Validation

Use focused checks first, then the documented build:

| Area | Command |
|---|---|
| Main prompt, policy core, and Agent Mode prompt sections | `bun test src/constants/corePolicy.test.ts src/constants/prompts.test.ts src/constants/systemPromptSections.test.ts` |
| Instruction and recalled-memory framing | `bun test src/utils/claudemd.test.ts` |
| Save-side memory evaluator wiring | `bun test scripts/memory-behavior-eval/save-side.test.ts` |
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
- Do not assume safety or orchestration guidance is shared across providers. GPT-specific tool-output handling, risky-action policy, verification bounds, and Explore delegation rules are assembled in `src/constants/promptStyles/gpt.ts`.
- Do not treat a single subagent as a neutral pass-through. The default and GPT prompt styles both require a concrete reason delegation beats doing that work in the current thread.
- Do not reach for `src/services/api/dumpPrompts.ts` without setting `USER_TYPE=ant`. Every entry point returns early otherwise, so the rows above that point at prompt dumps describe an ant-only path. `/context` is the only inspection surface live by default.
- Do not reach for `--dump-system-prompt`. Its call site in `src/entrypoints/cli.tsx` is guarded on a feature name that does not appear in `scripts/build.ts`, so it is eliminated from every build and the CLI reports it as an unknown option.
- Do not assume a prompt difference from upstream is Cat Code's doing. Roughly half of the prompt-system differences audited on 2026-08-10 were upstream changes made after the fork. Check [`upstream-divergence.md`](upstream-divergence.md) before re-syncing anything toward upstream, especially the instruction-authority wrapper in `src/utils/claudemd.ts` and the input-keyed section cache, which are deliberate.
