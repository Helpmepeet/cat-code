# Agent And Team Tools

- `Agent`: spawns workers. Use `name` for a stable worker handle, `isolation: "worktree"` for isolated edit work, and `team_name` when team mode is active.
- `TeamCreate` / `TeamDelete`: create or clean up a team only when the tools are visible.
- `ResumeAgent`: continue a stopped local subagent from its transcript and metadata.
- `SendMessage`: use it for steering a relevant running worker by handle or agent ID instead of spawning a duplicate. Broadcasts and teammate protocol routes require Agent Teams.
- Background task controls expose running local agents and teammates through the task panel and task navigation.
- Git-backed worker worktrees can be removed automatically when clean; hook-based worktrees may be kept even when clean.
- Kept worker worktrees must be inspected before their changes are integrated.
