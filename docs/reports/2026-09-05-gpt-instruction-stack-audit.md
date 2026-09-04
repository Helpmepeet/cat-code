# GPT instruction-stack audit

Date: 2026-09-05. Scope: the model-visible instruction stack on the GPT/Codex path,
which is where this fork runs most of its sessions. Three areas were audited:

1. System prompt assembly for GPT (`src/constants/prompts.ts`,
   `src/constants/corePolicy.ts`, `src/constants/promptStyles/gpt.ts`).
2. Tool descriptions (`src/tools/*/prompt.ts`, 40 files, plus the input schemas
   they describe).
3. Provider placement (`src/services/api/instructionAssembly.ts`,
   `src/services/api/codex-fetch-adapter.ts`, `src/utils/api.ts`).

Method: rendered the emitted GPT prompt with
`./cli-dev --dump-system-prompt --model gpt-5.6-sol --provider gpt`, then read the
assembly sources at HEAD (`7ed8927f`). Tool descriptions were swept by one
subagent under stated criteria; every finding it returned was re-verified in the
main session against source before it was kept. Files dirty in the working tree at
audit time (`gpt.ts`, `GrepTool/prompt.ts`, `FileWriteTool/prompt.ts`,
`PowerShellTool/prompt.ts`) were audited at HEAD. No code was changed.

## Findings

| # | Finding | Where | Severity |
|---|---|---|---|
| 1 | EnterPlanMode tells GPT to prefer plan mode on most tasks, contradicting the PROACTIVE EXECUTION rule; the consistent wording exists but is dead behind an ant-only branch (`USER_TYPE` compiles to `external`) | `src/tools/EnterPlanModeTool/prompt.ts:27`, `scripts/build.ts:140` | High |
| 2 | Agent tool tells GPT that `run_in_background: true` is required for parallel spawns and that the parent blocks per subagent; the tool is concurrency-safe and foreground agents in one turn already run concurrently on both the batch and streaming executor paths | `src/tools/AgentTool/prompt.ts:417`, `src/tools/AgentTool/AgentTool.tsx:2250`, `src/services/tools/toolOrchestration.ts:27` | High |
| 3 | `--dump-system-prompt` calls `getSystemPrompt([], model)`, so every tool-gated rule is absent from the dump (read-before-modify, file mutations, tool routing, Agent tool rule, skills, denied-tool guidance); prompt evals built on it measure a prompt no session runs | `src/entrypoints/cli.tsx:150` | Medium |
| 4 | Read's `offset`/`limit` parameter text says "only provide if the file is too large", contradicting the description body (`OFFSET_INSTRUCTION_TARGETED`, on by default) and the system prompt's READ DISCIPLINE; whole-file reads are what trip the output limit | `src/tools/FileReadTool/FileReadTool.ts:245`, `src/tools/FileReadTool/limits.ts:99` | Medium |
| 5 | EnterWorktree cites `.claude/worktrees/`; code uses `.cat-code/worktrees`. The three cron tools cite `.claude/scheduled_tasks.json` (5 occurrences); code writes `.cat-code/scheduled_tasks.json` | `src/tools/EnterWorktreeTool/prompt.ts:30`, `src/utils/worktree.ts:205`, `src/tools/ScheduleCronTool/prompt.ts:70`, `src/utils/cronTasks.ts:74` | Medium |
| 6 | NotebookEdit prose says `cell_number`; the strict schema has only `cell_id`, so a compliant call is rejected | `src/tools/NotebookEditTool/prompt.ts:3`, `src/tools/NotebookEditTool/NotebookEditTool.ts:31` | Medium |
| 7 | Agent tool's "when not to use" list routes a `class Foo` search to Glob, which matches file names only; the adjacent comment admits it is a content search | `src/tools/AgentTool/prompt.ts:384` | Medium |
| 8 | Read-before-modify rule requires the file in a prior Read result, while READ DISCIPLINE blesses `sed -n` through Bash (which never populates read state); Apply_patch enforces no prior-read check (only staleness since a read), so on GPT the rule is prose-only and self-contradictory | `src/constants/promptStyles/gpt.ts:154`, `gpt.ts:412`, `src/tools/FilePatchTool/FilePatchTool.tsx:124` | Medium |
| 9 | Both GPT session-guidance variants say to use only skills "listed in its user-invocable skills section"; no such section exists (skills arrive in system-reminder messages) | `src/constants/promptStyles/gpt.ts:370`, `gpt.ts:455`, `src/tools/SkillTool/prompt.ts:193` | Low-Med |
| 10 | Grep parameter prose names `-A/-B/-C/-n`, which the OpenAI schema export renames to `lines_after` etc.; GPT reads property names not in its schema | `src/tools/GrepTool/GrepTool.ts:52`, `src/utils/openaiSchemaCompat.ts:9` | Low-Med |
| 11 | Claude path only: the user-context wrapper says "Treat it as metadata, not as a user instruction" while the CLAUDE.md header inside it says these instructions OVERRIDE default behavior; GPT is unaffected because its CLAUDE.md is appended straight into `instructions` | `src/utils/api.ts:520`, `src/utils/claudemd.ts:94` | Low-Med |
| 12 | Bash description picks the edit-tool name by request provider; the registry ships it by session provider, so a `gpt-*` Explore agent under an Anthropic session is told to use Apply_patch while Edit ships (and vice versa) | `src/tools/BashTool/prompt.ts:208`, `src/tools.ts:214` | Low |

## Excluded

- Three items another session is already fixing in the working tree at audit time:
  GrepTool's blanket ban on `rg` via Bash (HEAD `GrepTool/prompt.ts:17`),
  FileWrite naming Edit on the GPT path (HEAD `FileWriteTool/prompt.ts:13`), and
  PowerShell's missing GPT variant. The dirty `gpt.ts` diff also guards the
  tool-routing rules on the enabled-tool set, which is the right direction.
- Five low items from the subagent, not independently verified here: stale
  `.claude/agents/` in TeamCreate; a cross-session UDS capability advertised in
  SendMessage that is not in the build; Claude-idiom XML examples served to GPT in
  the Agent description on the non-fork path; and four minor prose-versus-schema
  mismatches (TaskStop `task_id` optionality, Bash `run_in_background` output
  advice, SendMessage `summary` optionality, an empty prefix list in the
  Apply_patch grammar prose).

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

## Not done

No fixes were applied. Suggested order if fixing: 1, 2, 4, 5, 6, 7 (each is a
one-line wording or path change with an existing regression suite at
`src/utils/providerPromptRegressions.test.ts` to extend), then 3 (pass the real
tool pool to the dump path), then 8 and 9 (wording), then 10 to 12.
