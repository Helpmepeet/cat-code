# Agent Mode Routing Map

Daily-refreshable routing map for Agent Mode ownership, integration points, and stale-doc checks.

Last refreshed: 2026-07-31 against the current source tree.

## First Files To Inspect

When refreshing this map, verify these source paths before trusting older docs:

1. `src/agent-mode/agentMode.ts` and `src/agent-mode/sessionState.ts`
2. `src/tools/AgentTool/AgentTool.tsx`, `src/tools/AgentTool/resolveAgentTarget.ts`, and `src/tools/AgentTool/resumeAgent.ts`
3. `src/tools/ResumeAgentTool/`, `src/tools/SendMessageTool/`, and the worker-control tool directories
4. `src/utils/recipientIdentity.ts` and `src/utils/swarm/teamHelpers.ts` (see `docs/maps/tasks-workers.md` for the mailbox/roster protocol)
5. `src/screens/REPL.tsx`, `src/utils/sessionStorage.ts`, and `src/utils/sessionRestore.ts`
6. `src/constants/prompts.ts`, `src/utils/systemPrompt.ts`, and `src/QueryEngine.ts`
7. Desktop controls: `app/sidecar/agentModeDomain.ts`, `app/sidecar/sidecarServer.ts`, `app/shared/protocol.ts`, and `app/renderer/src/AgentChrome.tsx`

## Current Mental Model

Agent Mode is currently an environment-selected orchestration mode, not the older run-ledger workflow described in some planning docs. The live implementation uses:

- `CLAUDE_CODE_AGENT_MODE` as the primary runtime switch.
- `src/agent-mode/orchestratorPrompt.ts` for the orchestrator doctrine.
- `src/constants/prompts.ts` plus `src/utils/systemPrompt.ts` for prompt replacement and Agent Mode session guidance.
- transcript-adjacent `.agent-mode-state.json` files for durable worker state.
- existing subagent/task machinery plus Agent Mode-specific worker roles and worker-control tools.
- a three-tool worker boundary: `Agent` spawns new workers, `ResumeAgent` continues stopped workers, and `SendMessage` queues messages into running workers.
- `src/screens/REPL.tsx` as the operational UI hub.
- optional friendly subagent names (`agentName`) persisted in `src/utils/sessionStorage.ts` and used for `@name` targeting via `resolveAgentTarget`.
- (2026-07-12 hardening) `ResumeAgent` is local-subagent-only — it never resumes a teammate process or in-process teammate loop, and public tool schemas were not widened for this rule. Resume-lifecycle ownership (`activeResumeLifecycles` in `src/tools/AgentTool/resumeAgent.ts`) is held from setup start until the detached lifecycle promise settles, not just through setup, so a delayed-resolution race can only launch one resumed lifecycle.

### Bare-teammate vs `@local` recipient routing

`src/utils/recipientIdentity.ts` is the canonicalization/routing-key authority consumed by both `Agent` spawn and `SendMessage` targeting:

- `@name` (`parseLocalRecipient()`) always explicitly targets a local subagent, never a teammate.
- A bare name prefers a current teammate roster member when Agent Teams is enabled; only when no teammate named `name` exists does a bare name fall back to a local alias, durable handle, or raw local agent ID.
- New teammate/local-alias names are canonicalized once via `canonicalizeNewTeammateName()` (lowercase `^[a-z0-9][a-z0-9_-]*$`, ≤64 bytes, rejects `*`, `team-lead`, path/address-like punctuation, and Windows device basenames). Collision checks use the case-insensitive `recipientNameKey()`, not raw display names.
- Recipient identity allocation is atomic and versioned through `TeamFile.recipientRecords` (`src/utils/swarm/teamHelpers.ts`: `allocateTeamRecipient()`, `transitionTeamRecipient()`, `recoverStartingRecipient()`, one `transactTeamFile()` primitive) — see `docs/maps/tasks-workers.md` for the full state machine. Recipient keys are never reused within a team; a terminated teammate cannot be resumed and requires a fresh `Agent` call with a new allocation, not `ResumeAgent`.
- `src/tools/AgentTool/AgentTool.tsx` `resolveSystemSubagentName()` is the spawn-time reservation path that calls into this same allocator for both plain local subagents and teammates, so a local alias and a teammate name can never collide.

## Routing Table

| Concern | Start here | Then inspect | Notes |
|---|---|---|---|
| Mode selection and env | `src/agent-mode/agentMode.ts` | `src/utils/systemPrompt.ts`, `src/constants/prompts.ts`, `src/tools/AgentTool/builtInAgents.ts`, `src/utils/sessionStorage.ts` | `isAgentMode()` reads `CLAUDE_CODE_AGENT_MODE`. `getCurrentSessionMode()` returns `agent`, `coordinator`, or `normal`. `matchSessionMode()` mutates env vars to match resumed session metadata. |
| Desktop Agent Mode snapshot and toggle | `app/sidecar/agentModeDomain.ts` | `app/sidecar/sidecarServer.ts`, `app/shared/protocol.ts`, `app/main/main.ts`, `app/preload/preload.ts`, `app/renderer/src/AgentChrome.tsx` | The sidecar projects persisted session state plus live local-agent tasks into a redacted snapshot. `agent-mode.set` uses the engine's `matchSessionMode()` in that sidecar process only; it does not respawn a session. |
| `/agent` entrypoint | `src/commands/agent/agent.tsx` | `src/screens/REPL.tsx` `enterAgentModeSession`, `src/commands.ts` | `/agent` starts a fresh Agent Mode session, clears the conversation, and forwards inline args as the next submitted prompt. |
| Agent list/config UX | `src/commands/agents/agents.tsx` | `src/components/agents/AgentsMenu.tsx`, `src/tools/AgentTool/loadAgentsDir.ts` | `/agents` is a general agent configuration UI, not the Agent Mode runtime owner. |
| Orchestrator prompt doctrine | `src/agent-mode/orchestratorPrompt.ts` | `src/agent-mode/agentMode.ts`, `src/constants/{corePolicy,prompts}.ts` | This is the live Agent Mode orchestrator prompt. It rejects a mandatory plan-approval-execute workflow, pushes substantive execution to workers, and selects the provider-specific shared policy core rather than hard-coding Claude policy text. |
| Prompt replacement / priority | `src/utils/systemPrompt.ts` | `src/utils/queryContext.ts`, `src/QueryEngine.ts`, `src/screens/REPL.tsx` | Agent Mode prompt sections replace the default prompt when Agent Mode is active and `agentModePromptSections` are supplied. Custom system prompts can bypass the Agent Mode prompt-section build path. |
| Agent Mode prompt sections | `src/constants/prompts.ts` | `src/constants/{corePolicy,promptStyles/gpt}.ts`, `src/context.ts` | `getAgentModeSystemPromptSections()` builds the mode-specific array, retaining core policy/action sections across providers and adding worker-first tool and session-specific worker-control guidance. |
| Per-turn Agent Mode context | `src/agent-mode/agentMode.ts` `getAgentModeUserContext()` | `src/QueryEngine.ts`, `src/utils/queryContext.ts`, `src/screens/REPL.tsx` | Injects a provider-aware candidate tool set, connected MCP server names, scratchpad context when gated, and formatted durable state. Role definitions can grant fewer tools; read-only roles receive no file-edit/write tools. |
| Worker state persistence | `src/agent-mode/sessionState.ts` | `src/tools/AgentTool/runAgent.ts`, `src/tools/AgentTool/AgentTool.tsx`, `src/tools/AgentTool/agentToolUtils.ts` | Durable state lives beside transcripts as `<session-id>.agent-mode-state.json`. It tracks objective, active workers, known workers, status, resumability, synthesis status, handles, and worktree path. |
| Worker lifecycle recording | `src/tools/AgentTool/runAgent.ts` | `src/tools/AgentTool/AgentTool.tsx`, `src/tools/AgentTool/agentToolUtils.ts` | Spawns record durable worker state when `sessionStateTracking` is present. Terminal paths record completed, failed, and killed status and set completed results to `synthesisStatus: pending`. |
| Subagent target resolution (`@name`, IDs) | `src/tools/AgentTool/resolveAgentTarget.ts` | `src/utils/recipientIdentity.ts`, `src/utils/sessionStorage.ts` agent metadata, `src/agent-mode/sessionState.ts` worker handles, `src/tasks/LocalAgentTask/` | Explicit `@name` (`parseLocalRecipient()`) always means local. A bare name checks the live `agentNameRegistry`, durable Agent Mode worker handles, then persisted subagent metadata (`subagents/agent-*.meta.json`) before falling back to raw agent IDs — and, with Agent Teams enabled, a current teammate roster member takes priority over all of those (see "Bare-teammate vs `@local`" above). |
| Worker control tools | `src/tools/ListWorkersTool/ListWorkersTool.ts` | `src/tools/WaitWorkersTool/WaitWorkersTool.ts`, `src/tools/GetWorkerResultTool/GetWorkerResultTool.ts`, `src/tools/CancelWorkerTool/CancelWorkerTool.ts`, `src/tools.ts` | These tools are enabled only in Agent Mode. They list workers, wait for terminal status, read and optionally synthesize results, and cancel specific workers. |
| Worker spawn / resume / steering | `src/tools/AgentTool/AgentTool.tsx`, `src/tools/ResumeAgentTool/ResumeAgentTool.tsx`, `src/tools/SendMessageTool/SendMessageTool.ts` | `src/tools/AgentTool/resolveAgentTarget.ts`, `src/tools/AgentTool/resumeAgent.ts`, `src/agent-mode/sessionState.ts` | `Agent` spawns new workers (local subagent or, in a team context, a teammate allocation). `ResumeAgent` restarts stopped LOCAL SUBAGENTS ONLY by alias, durable handle, or raw agent ID — it never resumes a teammate. `SendMessage` queues into a currently running local worker or a rostered (active or idle) teammate; it re-reads fresh state before routing rather than trusting a captured `task.status` (`src/tools/SendMessageTool/SendMessageTool.ts` `routeToLocalWorker`, `src/tasks/LocalAgentTask/LocalAgentTask.tsx` `queuePendingMessageIfRunning()`). |
| Agent prompt/schema/result capability wording | `src/tools/AgentTool/agentToolUtils.ts` `getAgentContinuationCapabilities()` | `src/tools/AgentTool/prompt.ts` `getPrompt()`, `src/tools/AgentTool/AgentTool.tsx` `mapToolResultToToolResultBlockParam()`, `src/utils/swarm/inProcessRunner.ts` `resolveInProcessRuntime()` | Continuation guidance (SendMessage/ResumeAgent hints, the `name` schema description) is derived from the SAME resolved tool array used to build that invocation's own prompt/API tool definitions — never re-derived from the unfiltered parent tool pool. In-process teammates resolve their tool pool and system prompt from the explicit `'in-process-teammate'` `AgentToolEnvironment` (not AsyncLocalStorage timing) so the two can't disagree. |
| Prior-session continuity | `src/agent-mode/sessionState.ts` `readSessionStateWithContinuity()` | `src/tools/ListWorkersTool/ListWorkersTool.ts`, `src/tools/ResumeAgentTool/ResumeAgentTool.tsx`, `src/tools/AgentTool/resolveAgentTarget.ts` | Continuity reads recent prior Agent Mode state files for completed, resumable workers and marks unavailable transcripts as stale/non-reusable. |
| Role prompts | `src/agent-mode/rolePrompts.ts` | `src/tools/AgentTool/{builtInAgents,agentToolUtils,runAgent}.ts` | Agent Mode adds coding-worker and verifier definitions. File-edit aliases are one capability across providers, so either deny blocks both; `Skill` is default-off and needs an explicit role grant. Coding workers can edit/run scoped checks; verifiers are read-only. |
| Repo-local worker customization | `src/agent-mode/roleFiles.ts` | `.cat-code/roles/implementor.md`, `.cat-code/roles/verifier.md`, `.cat-code/context/*.md` | Built-in role files are injected by role. Context files are listed, not auto-injected; workers decide which relevant files to read. |
| Worker naming and roster display | `src/agent-mode/workerNames.ts` | `src/agent-mode/workerUxSummary.ts`, `src/agent-mode/AgentModeWorkerRoster.tsx` | Friendly handles are allocated by role when durable tracking is active. UX summary buckets running, result-ready, reviewed, resumable, stale, and attention workers. |
| REPL Agent Mode UX | `src/screens/REPL.tsx` | `src/agent-mode/AgentModeWorkerRoster.tsx`, `src/agent-mode/workerUxSummary.ts` | REPL enters Agent Mode, rebuilds prompt context, renders the worker roster, handles Escape/a abort confirmation, and refreshes worker state from durable session state. |
| Background sessions | `src/screens/REPL.tsx` background query path | `src/constants/prompts.ts`, `src/utils/systemPrompt.ts` | Backgrounded queries rebuild Agent Mode prompt sections when `CLAUDE_CODE_AGENT_MODE` is truthy and no custom system prompt is active. |
| Resume mode matching | `src/agent-mode/agentMode.ts` `matchSessionMode()` | `src/utils/sessionStorage.ts`, `src/utils/sessionRestore.ts`, `src/screens/ResumeConversation.tsx`, `src/screens/REPL.tsx` | Session metadata stores mode via `saveMode()`. Resume paths call `matchSessionMode()` and then re-derive active built-in agent definitions for the target mode. |
| Compaction continuity | `src/services/compact/prompt.ts` | `src/services/compact/prompt.test.ts`, `src/skills/bundled/agent-mode-compaction-recovery/SKILL.md` | Compaction summaries can include authoritative Agent Mode run state. The orchestrator prompt says to recover from durable session state before trusting summary text. |
| Goal continuity | `src/utils/threadGoalActions.ts` | `src/utils/threadGoal.ts`, `src/tools/UpdateGoalTool/UpdateGoalTool.ts`, `src/commands/goal/goal.test.ts` | `/goal` syncs durable Agent Mode objective state and can reset workers. Goal completion is blocked while Agent Mode has unresolved workers. |
| Worktree doctrine | `src/agent-mode/orchestratorPrompt.ts` | `src/tools/EnterWorktreeTool/prompt.ts`, `src/tools/ExitWorktreeTool/prompt.ts`, `src/tools/AgentTool/` | Worktrees are execution backends owned by the orchestrator, not user-facing task state. Verify current apply/cleanup behavior in tool code before changing docs. |

## Tests And Validation

| Area | Focused tests |
|---|---|
| Agent Mode facade and prompt sections | `bun test src/agent-mode/agentMode.test.ts src/agent-mode/orchestratorPrompt.test.ts src/constants/prompts.test.ts` |
| Session state and worker continuity | `bun test src/agent-mode/sessionState.test.ts src/tools/ListWorkersTool/ListWorkersTool.test.ts src/tools/GetWorkerResultTool/GetWorkerResultTool.test.ts src/tools/WaitWorkersTool/WaitWorkersTool.test.ts src/tools/CancelWorkerTool/CancelWorkerTool.test.ts` |
| Role prompts and naming | `bun test src/agent-mode/rolePrompts.test.ts src/agent-mode/workerNames.test.ts` |
| Roster UX | `bun test src/agent-mode/workerUxSummary.test.ts src/agent-mode/AgentModeWorkerRoster.test.tsx` |
| AgentTool integration and resume | `bun test src/tools/AgentTool/AgentTool.test.ts src/tools/AgentTool/resumeAgent.test.ts src/tools/AgentTool/resolveAgentTarget.test.ts src/tools/AgentTool/prompt.test.ts src/tools/AgentTool/agentToolUtils.test.ts src/tools/ResumeAgentTool/ResumeAgentTool.test.ts` |
| SendMessage worker follow-up | `bun test src/tools/SendMessageTool/SendMessageTool.test.ts src/tools/SendMessageTool/UI.test.tsx` |
| Recipient identity, allocation, and spawn races | `bun test src/utils/recipientIdentity.test.ts src/utils/swarm/teamHelpers.test.ts src/tools/shared/spawnMultiAgent.test.ts` (the plan's two-process `spawnMultiAgent.probe.test.ts` proving a cross-process local/teammate key race is not yet built — known gap, see plan Task 1 Step 9) |
| In-process teammate prompt/tool-pool consistency | `bun test src/utils/swarm/inProcessRunner.test.ts` |
| Goal integration | `bun test src/commands/goal/goal.test.ts src/tools/UpdateGoalTool/UpdateGoalTool.test.ts src/utils/threadGoal.test.ts` |
| Build-level validation | `bun run build:dev:full` |

## Traps And Stale Assumptions

Treat these docs as historical planning or operator notes unless current source confirms each claim:

- `docs/agent/2026-04-30-agent-mode-plan.md` describes an older run-ledger-oriented plan with planner/implementor/verifier flow, approval gates, and `.cat-code/runs/<run_id>/`. Current source routes through `src/agent-mode/sessionState.ts` and transcript-adjacent `.agent-mode-state.json` instead.
- `docs/agent/2026-04-30-agent-mode-manual.md` still describes mandatory plan approval, `/runs`, run ledgers, cost/status headers, and hard run limits. Do not treat those as current implementation facts without source verification.
- `docs/agent/2026-04-30-agent-mode-gaps.md` claims older class/status-header/run-state components are implemented. Re-check source first; the current live owner is `src/agent-mode/` plus REPL/task integration.
- `docs/agent/2026-04-30-agent-mode-two-mode-prompt-plan.md` is a deployment prompt plan, not the live Agent Mode routing source. The live prompt entrypoints are `src/constants/prompts.ts`, `src/utils/systemPrompt.ts`, and `src/agent-mode/orchestratorPrompt.ts`.
- `docs/agent/2026-04-30-agent-mode-orchestrator-system-prompt.md` is useful for comparison but may drift from the exact live string. Prefer `src/agent-mode/orchestratorPrompt.ts` and `src/constants/prompts.ts`.
- `docs/agent/2026-04-30-agent-mode-v2-v2.3-resumable-subagents.md` is a design proposal. Many concepts now exist through durable session state, worker-control tools, `ResumeAgent`, and `SendMessage`, but the doc is not the source of truth.
- `docs/agent/2026-05-02-agent-mode-v2.3-live-feedback.md` and `docs/agent/2026-05-02-agent-mode-v2.4-live-feedback.md` are live feedback logs. Use their verified-evidence sections as clues, not authority.
- `docs/agent/2026-05-03-cat-swarm-skill.md` contains useful runtime facts about worker-control tools and `SendMessage`, but it is scoped to a local workflow, not the general Agent Mode architecture.
- `docs/agent/2026-04-30-agent-mode-readme.md` is the closest operator-facing overview. Still verify prompt, role, compaction, and UI claims against source before editing behavior.

## Refresh Notes

- If Agent Mode behavior changes, update this map before or with operator docs so future agents route to source correctly.
- Keep Agent Mode-specific routing updates here or under `docs/agent/`.
- Prefer implementation and tests over docs when claims conflict.
