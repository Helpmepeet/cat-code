# Swarm Tools

- `Agent`: spawns workers. Use `name` for a stable worker handle, `isolation: "worktree"` for isolated edit work, and `team_name` when team mode is active.
- `TeamCreate` / `TeamDelete`: create or clean up a team only when the tools are visible.
- `SendMessage`: use it for steering a relevant running worker by handle or agent ID instead of spawning a duplicate. Broadcasts and teammate protocol routes require Agent Teams.
- `ListWorkers`: inspect the current worker roster before spawning more workers.
- `WaitWorkers`: converge explicitly after parallel launches.
- `GetWorkerResult`: read each completed worker result before synthesis or integration.
- `CancelWorker`: stop stale, conflicting, unsafe, or obsolete workers.
- Git-backed worker worktrees can be removed automatically when clean; hook-based worktrees may be kept even when clean.
- Kept worker worktrees must be inspected before their changes are integrated.
