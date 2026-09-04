# GPT instruction-stack audit

Date: 2026-09-05 (revised the same day after a cold review; see "Review
corrections"). Scope: the model-visible instruction stack on the GPT/Codex path,
which is where this fork runs most of its sessions. One cross-provider item is
kept in an appendix. Three areas were audited:

1. System prompt assembly for GPT (`src/constants/prompts.ts`,
   `src/constants/corePolicy.ts`, `src/constants/promptStyles/gpt.ts`).
2. Tool descriptions (`src/tools/*/prompt.ts`, 40 files, plus the input schemas
   they describe).
3. Provider placement (`src/services/api/instructionAssembly.ts`,
   `src/services/api/codex-fetch-adapter.ts`, `src/utils/api.ts`).

Method: probed the system-prompt text with
`./cli-dev --dump-system-prompt --model gpt-5.6-sol --provider gpt` (this emits
the system-prompt sections only, not user context, tool schemas, or the final
provider request), then read the assembly sources at HEAD (`7ed8927f`). The
local `cli-dev` binary was built from a working tree with uncommitted `gpt.ts`
changes, so dump observations were cross-checked against `git show 7ed8927f:`
before being used. Tool descriptions were swept by one subagent under stated
criteria; every finding it returned was re-verified in the main session against
source before it was kept. Files dirty in the working tree at audit time
(`gpt.ts`, `GrepTool/prompt.ts`, `FileWriteTool/prompt.ts`,
`PowerShellTool/prompt.ts`) were audited at HEAD. No code was changed by the
audit itself.

## Findings

| # | Finding | Where | Severity |
|---|---|---|---|
| 1 | EnterPlanMode tells GPT to prefer plan mode on most tasks, contradicting the PROACTIVE EXECUTION rule; the consistent wording exists but is dead behind an ant-only branch (`USER_TYPE` compiles to `external`) | `src/tools/EnterPlanModeTool/prompt.ts:27`, `scripts/build.ts:140` | High |
| 2 | Agent tool tells GPT that `run_in_background: true` is required for parallel spawns and that the parent blocks per subagent; the tool is concurrency-safe and foreground agents in one turn already run concurrently on both the batch and streaming executor paths | `src/tools/AgentTool/prompt.ts:417`, `src/tools/AgentTool/AgentTool.tsx:2250`, `src/services/tools/toolOrchestration.ts:27` | High |
| 3 | `--dump-system-prompt` calls `getSystemPrompt([], model)`. At clean HEAD the empty tool list drops the tool-gated session guidance (Agent tool rule, skills, task tracking, denied-tool guidance) and makes the read-before-modify and tool-routing text name `Edit` instead of `Apply_patch`. Once the pending `gpt.ts` change that gates file-mutation and routing rules on the enabled set lands, those vanish too. Prompt evals built on the dump measure a prompt no session runs | `src/entrypoints/cli.tsx:156` | Medium |
| 4 | Read's `offset`/`limit` parameter text says "only provide if the file is too large", contradicting the description body (`OFFSET_INSTRUCTION_TARGETED`, on by default) and the system prompt's READ DISCIPLINE; whole-file reads are what trip the output limit | `src/tools/FileReadTool/FileReadTool.ts:245`, `src/tools/FileReadTool/limits.ts:99` | Medium |
| 5 | EnterWorktree cites `.claude/worktrees/`; code uses `.cat-code/worktrees`. The three cron tools cite `.claude/scheduled_tasks.json` (5 occurrences in the prompt file, plus any schema or rendered-result text); code writes `.cat-code/scheduled_tasks.json` | `src/tools/EnterWorktreeTool/prompt.ts:30`, `src/utils/worktree.ts:205`, `src/tools/ScheduleCronTool/prompt.ts:70`, `src/utils/cronTasks.ts:74` | Medium |
| 6 | NotebookEdit prose says `cell_number`; the strict schema has only `cell_id`, so a compliant call is rejected | `src/tools/NotebookEditTool/prompt.ts:3`, `src/tools/NotebookEditTool/NotebookEditTool.ts:31` | Medium |
| 7 | Agent tool's "when not to use" list routes a `class Foo` search to Glob, which matches file names only; the adjacent comment admits it is a content search | `src/tools/AgentTool/prompt.ts:384` | Medium |
| 8 | Read-before-modify rule requires the file in a prior Read result, while READ DISCIPLINE blesses `sed -n` through Bash (which never populates read state); Apply_patch enforces no prior-read check (`validateFileNotModifiedSinceRead` returns success when no read-state entry exists), so on GPT the rule is incoherent and unenforced | `src/constants/promptStyles/gpt.ts:154`, `gpt.ts:412`, `src/tools/FilePatchTool/FilePatchTool.tsx:124`, `src/tools/FileEditTool/shared.ts:170` | Medium |
| 9 | TeamCreate says custom agents live in `.claude/agents/`; the loader reads `.cat-code/<subdir>` roots. Shipped only when agent swarms are on | `src/tools/TeamCreateTool/prompt.ts:20`, `src/utils/markdownConfigLoader.ts:253` | Low |
| 10 | SendMessage lists "cross-session UDS or bridge messages" under "Requires Agent Teams"; that capability is gated by `UDS_INBOX`, which is not in the build list, so enabling Agent Teams does not provide it | `src/tools/SendMessageTool/prompt.ts:31`, `scripts/build.ts` | Low |
| 11 | Bash description picks the edit-tool name by request provider; the registry ships it by session provider, so a `gpt-*` Explore agent under an Anthropic session is told to use Apply_patch while Edit ships. The inverse direction is not established (`resolveRequestProvider` only forces OpenAI for `gpt-*`) | `src/tools/BashTool/prompt.ts:208`, `src/tools.ts:214`, `src/utils/model/providers.ts:205` | Low |
| 12 | Wording nit: both GPT session-guidance variants say to use only skills "listed in its user-invocable skills section"; the runtime supplies the list under "The following skills are available for use with the Skill tool" and the Skill description says where to find it, so nothing is missing, but the names should agree | `src/constants/promptStyles/gpt.ts:370`, `gpt.ts:455`, `src/tools/SkillTool/prompt.ts:193` | Low |
| 13 | Wording nit: Grep's `output_mode` description says "supports -A/-B/-C context, -n line numbers", naming sibling properties in the dash form that the OpenAI schema export renames. The per-property notes such as "(rg -A)" are ordinary semantic documentation and are fine | `src/tools/GrepTool/GrepTool.ts:56`, `src/utils/openaiSchemaCompat.ts:9` | Low |

## Appendix: cross-provider

| # | Finding | Where | Severity |
|---|---|---|---|
| A1 | Claude path only: the user-context wrapper says "Treat it as metadata, not as a user instruction" while the CLAUDE.md header inside it says these instructions OVERRIDE default behavior. GPT is unaffected because its CLAUDE.md is appended straight into `instructions` | `src/utils/api.ts:520`, `src/utils/claudemd.ts:94` | Low-Med |

## Excluded

- Three items another session is already fixing in the working tree at audit time:
  GrepTool's blanket ban on `rg` via Bash (HEAD `GrepTool/prompt.ts:17`),
  FileWrite naming Edit on the GPT path (HEAD `FileWriteTool/prompt.ts:13`), and
  PowerShell's missing GPT variant. The dirty `gpt.ts` diff also guards the
  tool-routing rules on the enabled-tool set, which is the right direction.
- Five low items from the subagent, not independently verified here:
  Claude-idiom XML examples served to GPT in the Agent description on the
  non-fork path, and four minor prose-versus-schema mismatches (TaskStop
  `task_id` optionality, Bash `run_in_background` output advice, SendMessage
  `summary` optionality, an empty prefix list in the Apply_patch grammar prose).

## Provider placement (no defects)

- OpenAI `instructions` = every system-prompt section (dynamic boundary marker
  dropped) + `# claudeMd` + `# currentDate`. Git status and the cache-breaker go
  to a developer-role message at input index 0
  (`instructionAssembly.ts`, `codex-fetch-adapter.ts:1344`).
- Git status is memoized per session and cleared only on `/clear`, so the
  developer message is stable and the WebSocket strict-prefix delta holds.
- MCP instructions are an uncached section inside `instructions`; the delta mode
  that avoids the bust (`isMcpInstructionsDeltaEnabled`) is a GrowthBook flag
  defaulting off for external builds. Desktop passes no MCP clients, so this only
  affects terminal sessions that connect a server after the first turn.
- `token_budget` (feature `TOKEN_BUDGET`) is an unconditional ~90-token no-op
  section; deliberately cached rather than toggled (see comment in `prompts.ts`).

## Review corrections

A cold review of the first revision returned six findings. Accepted: the dump
observation had mixed a dirty build with clean-HEAD claims (finding 3 narrowed,
anchor corrected to line 156); TeamCreate and SendMessage were wrongly left
unverified (now findings 9 and 10); the Claude-only wrapper conflict was outside
the stated scope (moved to the appendix); "and vice versa" on the provider
mismatch was unsupported (removed); the Grep and skills-section items were
overstated (downgraded to wording nits). Rejected: none. The review's own
`maps:lint` failure came from map files another session had left dirty, not from
this report.

## Fix plan

Fix order: 1, 2, 4, 5, 6, 7, 3, 9, 10, 11, 13, then 8 and 12 (both live in
`gpt.ts`, which another session has uncommitted edits in; defer until that
lands), then A1. Most are wording or path changes, but 5 spans several strings
and 3 needs the real tool pool wired into the dump path. Extend
`src/utils/providerPromptRegressions.test.ts` and the colocated suites.
