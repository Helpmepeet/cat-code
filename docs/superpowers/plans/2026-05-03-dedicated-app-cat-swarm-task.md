# Dedicated App Refactor Cat Swarm Task

> Give this file to `/cat-swarm`. The swarm owns planning, decomposition,
> worker assignment, implementation, integration, and verification.

## Required Context

Before deciding the implementation plan, read:

- `docs/agent/2026-05-03-dedicated-app-groundtruth.md`
- `docs/design/2026-05-03-dedicated-app-prototype-brief.md`
- `docs/superpowers/plans/2026-05-03-dedicated-app-replacement-plan.md`
- `docs/reference/2026-04-30-WORKSPACE_MAP.md`

## Goal

Refactor Cat Code from a terminal-first product into a real dedicated app path.
This is a refactor/migration task, not a request to make the existing browser
debug UI look nicer.

The dedicated app must follow the product direction in the prototype brief:
dense local workspace, session sidebar, multiple chat/workspace panels,
command palette, permissions, agents, accounts/usage, settings, and runtime
state surfaces.

## Hard Constraint: Do Not Treat `web/` As The Dedicated App

The existing `web/` directory is a browser/Vite surface and may be useful as
reference or temporary bridge code, but it is not the dedicated app target.

Do not complete this task by only expanding `web/src/App.tsx`, adding panels to
the current web UI, or preserving the current REPL-owned WebSocket submission
path as the primary architecture.

If the repository does not yet contain a desktop/native app framework, the swarm
must explicitly report that as a blocker or create the minimal app-shell
scaffold needed for the refactor. Do not silently substitute the old web app.

## Required Refactor Direction

- Identify the actual dedicated app shell target before writing UI code.
- If no dedicated app shell target exists, choose and justify the minimal
  scaffold needed for a local dedicated app path.
- Extract runtime ownership away from `src/screens/REPL.tsx` so the app can
  submit prompts, receive stream events, answer permissions, manage sessions,
  and observe `/goal` state without depending on terminal UI ownership.
- Preserve terminal compatibility during the migration, but make terminal the
  compatibility client, not the architectural owner.
- Use the prototype as product and interaction direction, not as mock backend
  evidence.

## Runtime Constraints

- Do not rewrite provider routing.
- Do not replace `QueryEngine`.
- Do not import `ink`, `src/screens/REPL.tsx`, or terminal components from
  runtime-only app boundary files.
- Preserve transcripts, permissions, `/goal`, tools, Agent Mode, and provider
  behavior.
- Preserve existing dirty worktree changes.
- Prefer isolated worker worktrees when the swarm chooses parallel edit work.
- If a baseline command fails before implementation, report it as a baseline
  failure instead of hiding it inside implementation results.

## Expected End-To-End Outcomes

- A concrete refactor plan chosen by the swarm after reading the context docs.
- Runtime boundary work that removes terminal UI ownership from app-facing
  submission, streaming, permission, transcript, and goal state.
- A real dedicated app shell path or an explicit blocker explaining why the repo
  cannot yet host one.
- Prototype-aligned app architecture and UI direction, not a webapp-only skin.
- Documentation updated so future workers know what was refactored, how to run
  it, what remains, and which surfaces are authoritative.
- Validation evidence for runtime, terminal compatibility, app shell build, and
  any package/scaffold introduced by the swarm.

## Validation Gates

At minimum, run:

```bash
bun test src/utils/threadGoal.test.ts src/commands/goal/goal.test.ts src/tools/GetGoalTool/GetGoalTool.test.ts src/tools/CreateGoalTool/CreateGoalTool.test.ts src/tools/UpdateGoalTool/UpdateGoalTool.test.ts
bun run build:dev:full
```

The swarm must add validation for the dedicated app shell it chooses. If it
creates runtime-boundary tests, run those too. If it touches `web/`, it must
explain why that is not being treated as the final dedicated app target.

Do not claim completion after only runtime-boundary work. Do not claim
completion after only `web/` UI work. Completion means the swarm has either
delivered a real dedicated-app refactor path or clearly reported the blocker
that prevents it.

## Suggested Command

```text
/cat-swarm Execute docs/superpowers/plans/2026-05-03-dedicated-app-cat-swarm-task.md end to end. This is a refactor into a real dedicated app path, not a webapp expansion. Read the required context docs first. Own the planning, worker decomposition, implementation, integration, and verification. Stop only when validation passes or a blocker is clearly reported.
```
