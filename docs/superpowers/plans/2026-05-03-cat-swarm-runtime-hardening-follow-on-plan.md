# Cat Swarm Runtime Hardening Follow-On Plan

## Goal

Resolve the runtime validation blockers discovered during the local `/cat-swarm` milestone so external builds can validate the intended execution-swarm workflow cleanly.

## Problems observed

- `./cli-dev --agent-mode --agent-teams` was rejected by the built external CLI even though the source still checks `process.argv` for `--agent-teams`.
- A non-interactive `--print` preflight response was not reliable for validating Agent Mode worker-control availability.
- The milestone could not complete the team-gated validation path required for `TeamCreate`, `TeamDelete`, and `SendMessage`.
- The original skill shape over-emphasized read-only review instead of worktree-backed execution.

## Scope

1. Verify whether `--agent-teams` should be exposed in external builds, source-gated away, or replaced by env-var-only opt-in.
2. Make the runtime and docs agree on the supported team opt-in path for external builds.
3. Add an authoritative validation path for tool availability that distinguishes:
   - Agent Mode worker-control tools
   - swarm-gated tools
   - worktree-backed edit capability
   - prompt/UI summaries that are only advisory
4. Re-run the Cat Swarm validation matrix only after the runtime gating is clarified.
5. Validate an execution swarm that produces kept worker worktrees and integration recommendations.

## Out of scope

- Changing same-file edit policy
- Changing worker-count policy
- Bundling `/cat-swarm` into the product

## Expected deliverables

- A source-level fix or explicit product decision around `--agent-teams`
- Updated operator guidance that matches the actual external-build behavior
- A repeatable validation procedure for `Agent`, `ListWorkers`, `WaitWorkers`, `GetWorkerResult`, `CancelWorker`, `SendMessage`, `TeamCreate`, and `TeamDelete`
- A repeatable validation procedure for `Agent` with `isolation: "worktree"` on edit-capable workers
