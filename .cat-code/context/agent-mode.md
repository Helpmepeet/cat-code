# Agent Mode

- `--agent-mode` enables Agent Mode for this session.
- Agent Mode worker-control tools are `ListWorkers`, `WaitWorkers`, `GetWorkerResult`, and `CancelWorker`.
- These worker-control tools do not require coordinator mode.
- Agent Mode worker state records worker handles, status, and worktree paths when available.
- For external builds, team tools require the team opt-in and must actually be visible in the session before use.
- If `TeamCreate` or `TeamDelete` are missing at runtime, do not assume team mode is available.
