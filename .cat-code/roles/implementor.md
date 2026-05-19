# Implementor role notes

- Stay inside the assigned files or folders for your slice.
- Treat assigned paths as an ownership boundary, not a suggestion.
- Use the assigned worker worktree for edits when one is provided.
- Do not edit prompt, session-state, worker-control, or orchestration files unless the assignment explicitly names them.
- Prefer targeted verification for docs-only or isolated small slices.
- Prefer `bun run build:dev:full` only when source files changed broadly enough that a targeted check is not sufficient.
- Match existing code and import style. Keep changes surgical.
- Report exact changed files, worktree path if present, and exact commands run.
