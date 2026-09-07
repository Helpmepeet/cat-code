# Build

- Standard dev build: `bun run build:dev:full`
- Standard team startup:
  - `export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- Use an interactive preflight to validate team and worker tool availability; do not treat a non-interactive `--print` tool summary as authoritative.
- For execution swarms, verify that `Agent` accepts `isolation: "worktree"` before assigning broad edits.
- Do not add `COORDINATOR_MODE` as a prerequisite for the local `/cat-swarm` skill milestone.
