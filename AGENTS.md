# AGENTS.md

For build commands, architecture overview, and build system details, see `CLAUDE.md`.

Keep `AGENTS.md`, `CLAUDE.md`, and `README.md` in the repository root as the main human/operator entrypoints. Move phase-specific planning and research docs into dedicated docs folders instead of leaving them loose in the root.

## Workspace Navigation

- For any non-trivial question, bug, or feature work, consult `docs/reference/WORKSPACE_MAP.md` before doing broad code search.
- Use `docs/reference/WORKSPACE_MAP.md` to identify the likely owner files and fallback inspection order for the area you are changing.
- Treat `docs/reference/WORKSPACE_MAP.md` as the routing layer, then verify behavior in the source files it points to before making changes.
- If `docs/reference/WORKSPACE_MAP.md` and a README comment disagree, prefer the implementation and the map's routing guidance over prose summaries.

## Prompt System

- For anything involving prompts, instructions, agent behavior, or output style, start at `docs/instructions/PROMPT_SURFACES.md`.
- The main system prompt and deployment-aware behavior are built in `src/constants/prompts.ts`.
- Agent runtime prompt assembly currently lives in `src/tools/AgentTool/runAgent.ts` (`getAgentSystemPrompt(...)`).
- If you are changing deployment-specific identity or behavior, verify the actual prompt entrypoint in code instead of assuming `src/agent/prompt.ts` exists.

## Two-Deployment Architecture

This binary supports two deployment configurations, selected at startup via env var:

- **Coding deployment** (`AGENT_DEPLOYMENT=coding` or unset) — interactive coding/general-purpose agent behavior.
- **Agent deployment** (`AGENT_DEPLOYMENT=agent`) — intended autonomous/always-on behavior, but verify the current implementation in code because the original `src/agent/` prompt split described in older docs is not present in this snapshot.

Both share the same tools, auth, memory, and API backend. Prompt behavior currently routes through the main prompt pipeline in `src/constants/prompts.ts` and the agent runtime assembly in `src/tools/AgentTool/runAgent.ts`. See `docs/agent-mode/two-mode-prompt-plan.md` for the original plan and `docs/agent-mode/agent-identity.md` for the identity design.

## Key Reference Documents

| Document | Purpose |
|---|---|
| `CLAUDE.md` | Build commands, architecture, build system |
| `docs/reference/WORKSPACE_MAP.md` | File routing map for navigating the codebase |
| `docs/instructions/PROMPT_SURFACES.md` | Prompt routing index — all prompt and instruction surfaces |
| `docs/vision/GOAL_PLAN.md` | Long-term vision and milestone priorities |
| `docs/agent-mode/agent-identity.md` | Agent deployment identity and behavioral principles |
| `docs/agent-mode/two-mode-prompt-plan.md` | Implementation plan for the two-deployment prompt system |
