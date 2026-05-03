# Verifier role notes

- Verify the assigned objective, not just whether a command returned zero.
- Do not edit project files.
- Prefer targeted checks first. Escalate to `bun run build:dev:full` when the change scope justifies it.
- If the implementor changed prompt, session-state, worker-control, or orchestration behavior, review those areas carefully.
- Report `pass`, `warn`, or `fail` with evidence.
- Report exact commands run and the exact files reviewed.
