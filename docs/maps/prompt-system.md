# Prompt System Map

Last refreshed: 2026-09-11

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
| 1 | [`../../src/constants/prompts.ts`](../../src/constants/prompts.ts) | Main prompt corpus and provider sections. |
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
| Change GPT family calibration | `src/constants/promptStyle.ts` | `src/constants/prompts.ts`, `src/constants/promptStyles/gpt.ts`, `src/constants/promptAssembly.snapshot.test.ts` | Provider selects GPT style; exact `gpt-6-astra` model identity selects Astra calibration in doing-tasks, actions, and tone. Sol/Terra/Luna share the GPT-5.6 baseline. These static sections are rebuilt on model changes; dynamic sections do not depend on family. |
| Change prompt-section cache correctness | `src/constants/systemPromptSections.ts` | `src/constants/prompts.ts`, `src/utils/queryContext.ts`, `src/screens/REPL.tsx` | Cache entries are keyed by each section's captured inputs. Cache-breaking sections must not populate that cache; language intentionally remains session-stable until a cache-clearing transition. |
| Change runtime prompt precedence | `src/utils/systemPrompt.ts` | `src/utils/queryContext.ts`, `src/QueryEngine.ts`, `src/query.ts` | Effective branch order is override, coordinator, main-thread agent, custom, default. `appendSystemPrompt` appends unless override replaces everything. |
| Change repo/user instruction and recalled-memory loading | `src/utils/claudemd.ts` | `src/constants/corePolicy.ts`, `src/context.ts`, `src/utils/settings/constants.ts`, `src/utils/config.ts` | This path controls managed, user, project, and local instruction inputs plus separately framed auto-memory and team-memory indexes. Its source-tier wrapper grants workflow/repository authority, never permission authority. |
| Change generated context injection | `src/context.ts` | `src/utils/claudemd.ts`, `src/utils/queryContext.ts`, `src/QueryEngine.ts`, `src/services/api/instructionAssembly.ts` | User context and system context are separate channels until provider assembly. |
| Change SDK or custom-system-prompt behavior | `src/QueryEngine.ts` | `src/utils/queryContext.ts`, `src/utils/systemPrompt.ts`, `src/query.ts` | Custom prompts skip default prompt construction and skip `getSystemContext()` in `fetchSystemPromptParts()`. |
| Change final provider placement | `src/services/api/instructionAssembly.ts` | `src/query.ts`, `src/services/api/claude.ts`, `src/services/api/codex-fetch-adapter.ts`, `src/utils/providerPromptRegressions.test.ts` | OpenAI keeps volatile `gitStatus` and `cacheBreaker` in developer context instead of user input messages. Claude-style providers append system context and prepend user context. |
| Change subagent prompt behavior | `src/tools/AgentTool/runAgent.ts` | `src/tools/AgentTool/prompt.ts`, `src/tools/AgentTool/builtInAgents.ts`, `src/tools/AgentTool/loadAgentsDir.ts` | `runAgent.ts` builds the agent prompt, adds env details, and may trim inherited context. |
| Change output styles | `src/constants/outputStyles.ts` | `src/outputStyles/loadOutputStylesDir.ts`, `src/utils/plugins/loadPluginOutputStyles.ts`, `.claude/output-styles/*.md`, `~/.cat-code/output-styles/*.md` | Output style text is injected by `src/constants/prompts.ts`. |
| Change tool descriptions | `src/tools/*/prompt.ts` | `src/constants/promptStyles/gpt.ts`, `src/tools.ts`, `src/utils/api.ts`, `src/utils/providerPromptRegressions.test.ts` | Tool prompt files are model-visible instruction surfaces even when the main system prompt is unchanged. GPT's prompt style derives read/search guidance from the actual tool pool: bounded whole-file reads favor FileRead; targeted shell reads name Bash only when it is exposed; and local mutations require the provider-appropriate dedicated edit tool plus a diff check for command-driven mutation. `src/tools/BashTool/prompt.ts` also owns model-facing git/commit guidance, shell failure handling, sandbox retry wording, background execution, and sleep/polling guidance. |
| Change skill-loading guidance | `src/tools/SkillTool/prompt.ts` | `src/tools/SkillTool/SkillTool.ts`, `src/tools.ts`, `src/constants/prompts.ts` | The skill tool prompt requires matching skills to be loaded before a response, but avoids reinjecting instructions already visible in the same conversation; use the tool again only when those instructions are no longer available in context. |
| Change desktop-only prompt text (file-reference addendum, peer doctrine, peer tool prompts) | `app/sidecar/desktopSystemPrompt.ts` | `app/sidecar/{createPeer,sendToPeer,listPeers,readPeer}Tool.ts`, `app/sidecar/sessionController.ts` | Desktop-only. The addendum and doctrine are appended last via `appendSystemPrompt`; the four peer tool prompts are appended after `getTools`, and the terminal never sees any of it. `docs/migration/decisions/PEER-SESSIONS.md` §5 and §8 quote this text verbatim and are amended with it. |
| Change auto-mode permission-decision prompts | `src/utils/permissions/yolo-classifier-prompts/` | `src/utils/permissions/`, `src/constants/corePolicy.ts` | The auto-mode classifier's own prompt. Its rule 8 keys on the `<cross-session-message>` tag and is the only engine-side rule about peer authority. |
| Inspect emitted prompts | `src/services/api/dumpPrompts.ts` | `src/query.ts`, `src/services/api/claude.ts`, `/context` command paths | Ant-user dumps write under `~/.cat-code/dump-prompts/<session-or-agent-id>.jsonl` as init, system_update, message, and response entries. |
| Render a prompt for a dev-full evaluation | `src/entrypoints/cli.tsx` | `scripts/build.ts`, `src/constants/prompts.ts`, `src/utils/model/model.ts`, `src/bootstrap/state.ts` | A `dev-full` build includes the gated `--dump-system-prompt` fast path. It renders and exits; use `--model` plus explicit `--provider` when the desired prompt family differs from persisted startup provider state. |

## Runtime Flow

```text
src/constants/prompts.ts
  builds default prompt sections

src/context.ts
  builds userContext and systemContext

src/utils/claudemd.ts
  discovers and wraps CLAUDE.md, rules, includes, and memory files

src/utils/queryContext.ts
  fetches defaultSystemPrompt, userContext, systemContext

src/QueryEngine.ts
  merges coordinator user context
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
| Memory mechanics for custom prompts | `src/QueryEngine.ts` | appended system prompt text | Only when `customSystemPrompt` is set and auto-memory path override is present. |
| MCP instructions | `src/constants/prompts.ts` | prompt section or delta attachment | If MCP instruction delta is enabled, prompt text is not recomputed in the normal section. |
| Output style | `src/constants/prompts.ts` | dynamic system-prompt section | Loaded from built-in, user/project, or plugin output-style sources. |
| Scratchpad instructions | `src/constants/prompts.ts` | dynamic system-prompt section | Present only when scratchpad support is enabled. |
| Injected-origin framing (`wrapCommandText`) | `src/utils/messages.ts` | mid-turn attachment text | The model-facing framing of every injected origin: peer, teammate, channel, coordinator, task-notification. Applied only when a queued command becomes a mid-turn attachment; an idle recipient's turn is started with the raw value, so the peer creation-prompt arm is read by no model today. |

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
subagents. It builds a subagent prompt from the agent definition,
`enhanceSystemPromptWithEnvDetails()`, and inherited context.

Watch these trims before debugging "missing" instructions in a worker:

- Read-only agents with `omitClaudeMd` can drop `claudeMd` unless an explicit override context is passed.
- Explore and Plan agents drop inherited `gitStatus`; they can run git commands when they need fresh state.
- Fork children that use exact tools preserve more parent context to maximize cache compatibility.
- The default and GPT Agent-tool guidance keeps the assigned request in the current thread unless a bounded subtask has a concrete delegation reason. Review, audit, cold-review, and verification wording names a method, not permission to hand off the request; an independent reviewer needs an explicit user request.

## Tests And Validation

Use focused checks first, then the documented build:

| Area | Command |
|---|---|
| Main prompt and policy core | `bun test src/constants/corePolicy.test.ts src/constants/prompts.test.ts src/constants/systemPromptSections.test.ts` |
| Whole default prompt and GPT family divergence | `bun test src/constants/promptAssembly.snapshot.test.ts` — regenerate intended changes with `UPDATE_PROMPT_SNAPSHOTS=1`, then inspect the full diff |
| Instruction and recalled-memory framing | `bun test src/utils/claudemd.test.ts` |
| Save-side memory evaluator wiring | `bun test scripts/memory-behavior-eval/save-side.test.ts` |
| Provider instruction placement and prompt regressions | `bun test src/utils/providerPromptRegressions.test.ts` |
| Main query behavior | `bun test src/query.test.ts` |
| Agent tool prompt/resume behavior | `bun test src/tools/AgentTool/prompt.test.ts src/tools/AgentTool/resumeAgent.test.ts src/tools/AgentTool/AgentTool.test.ts` |
| Skill-loading prompt policy | `bun test src/tools/SkillTool/` |
| Compaction behavior | `bun test src/services/compact/compact.test.ts` |
| Full documented build | `bun run build:dev:full` |

For emitted-prompt inspection, use prompt dumps when available:

- `src/services/api/dumpPrompts.ts` writes `~/.cat-code/dump-prompts/<session-or-agent-id>.jsonl` for ant users.
- Inspect `init` and `system_update` records for system/tool payload changes.
- Use `/context` when available to compare loaded instruction files and prompt sections.

## Traps And Stale Assumptions

- Do not assume `src/constants/prompts.ts` always wins. Coordinator mode, main-thread agent prompts, custom prompts, and override prompts can replace it.
- Do not assume `appendSystemPrompt` replaces the prompt. It appends to the winning branch, except when `overrideSystemPrompt` is set.
- Do not assume custom prompts still get `gitStatus`. `fetchSystemPromptParts()` skips `getSystemContext()` when `customSystemPrompt` is present.
- Do not assume `CLAUDE.md` is part of the system prompt. It is collected as `userContext`, then placed by provider assembly.
- Do not assume OpenAI and Claude-style providers receive context in the same shape. OpenAI puts stable context in `instructions` and volatile session metadata in developer context.
- Do not assume a subagent sees the same context as the main loop. `runAgent.ts` may omit `claudeMd` or `gitStatus` by agent type and feature gate.
- Do not move or remove `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` without checking prompt-cache code in `src/utils/api.ts` and `src/services/api/claude.ts`.
- Do not trust older historical docs that mention the removed `src/agent/prompt.ts` split. Verify current prompt entrypoints in this map.
- Do not debug MCP prompt churn only in `prompts.ts`; MCP instruction delta behavior can move instructions out of the normal prompt section.
- Do not forget API-time additions in `src/services/api/claude.ts`, such as CLI prompt prefixes and tool-search related instructions.
- Do not assume safety or orchestration guidance is shared across providers. GPT-specific tool-output handling, risky-action policy, verification bounds, and Explore delegation rules are assembled in `src/constants/promptStyles/gpt.ts`.
- Do not treat a single subagent as a neutral pass-through. The default and GPT prompt styles both require a concrete reason delegation beats doing that work in the current thread.
- Do not reach for `src/services/api/dumpPrompts.ts` without setting `USER_TYPE=ant`. Every entry point returns early otherwise, so the rows above that point at prompt dumps describe an ant-only path. `/context` is the only inspection surface live by default.
- Do not assume `--dump-system-prompt` exists in every build. `scripts/build.ts` enables `DUMP_SYSTEM_PROMPT` only for the `dev-full` feature set; when inspecting a non-GPT model, pass `--provider` explicitly or the persisted startup provider can select the wrong prompt style.
- Do not assume the repo's `.claude/skills/` load into a Cat Code session. Project skills come from `.cat-code/skills/` only (`src/skills/loadSkillsDir.ts`); `.claude/` is honoured for `CLAUDE.md` and `rules/*.md` alone (`src/utils/claudemd.ts:915-939`).
- Do not assume a prompt difference from upstream is Cat Code's doing. Roughly half of the prompt-system differences audited on 2026-08-10 were upstream changes made after the fork. Check [`../reports/2026-08-10-cat-code-upstream-divergence-ledger.md`](../reports/2026-08-10-cat-code-upstream-divergence-ledger.md) before re-syncing anything toward upstream, especially the instruction-authority wrapper in `src/utils/claudemd.ts` and the input-keyed section cache, which are deliberate.
