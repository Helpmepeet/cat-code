# Build

- Standard dev build: `bun run build:dev:full`
- Standard swarm startup:
  - `export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
  - `./cli-dev --agent-mode`
- Current snapshot note: `./cli-dev --agent-teams` was rejected by the built external CLI even though the source has swarm gating for that argv token.
- Use an interactive Agent Mode preflight to validate tool availability; do not treat a non-interactive `--print` tool summary as authoritative for worker-control tools.
- For execution swarms, verify that `Agent` accepts `isolation: "worktree"` before assigning broad edits.
- Do not add `COORDINATOR_MODE` as a prerequisite for the local `/cat-swarm` skill milestone.
