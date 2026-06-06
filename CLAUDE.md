# CLAUDE.md

Cat Code is a personal always-on agent system forked from Claude Code.

## Build

Use:

```bash
bun run build:dev:full
```

Do not use `bun run build` or `./cli` unless explicitly asked.

## Navigation

- Use `docs/maps/WORKSPACE_MAP.md` before broad source search for non-trivial questions, bugs, or features.
- `docs/maps/WORKSPACE_MAP.md` is the map index; focused subsystem maps live under `docs/maps/`.
- For prompt, instruction, agent behavior, or output-style work, start with `docs/prompts/2026-04-30-prompt-surfaces.md`.
- Keep `README.md`, `CLAUDE.md`, and `AGENTS.md` as the root entrypoints. Move plans/research into topic folders under `docs/`.
- `DONE.md` records completed phase work; ask before writing to it.

## Architecture

- CLI/bootstrap: `src/entrypoints/cli.tsx`, `src/entrypoints/init.ts`, `src/main.tsx`.
- Terminal UI/session loop: `src/screens/REPL.tsx`.
- Commands/tools: `src/commands.ts`, `src/commands/`, `src/tools.ts`, `src/tools/`.
- Query pipeline: `src/QueryEngine.ts`, `src/query.ts`, `src/services/api/`.
- Agent/subagent runtime: `src/agent-mode/`, `src/tools/AgentTool/`, `src/tasks/`.
- Config/persistence: `src/utils/settings/`, `src/utils/config.ts`, `src/utils/sessionStorage.ts`, `src/memdir/`.
- App runtime: `src/app-runtime/`.

## Development Rules

- Verify behavior in source before editing; older docs and plans can drift.
- Keep changes surgical. Touch only files needed for the request.
- Prefer existing local patterns over new abstractions.
- Do not add speculative features, configurability, or broad refactors.
- Preserve unrelated user changes in the worktree.
- Use focused tests or validation scaled to the risk. For docs-only changes, use `git diff --check` and link/path checks.
- If changing prompts, tools, permissions, config, persistence, or Agent Mode, inspect the matching map under `docs/maps/` first.
