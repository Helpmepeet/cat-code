# Workspace Map Usage Evaluation

Date: 2026-07-04  
Repository: `/Users/pt/cat-code`  
Scope: observed model usage of `docs/maps/WORKSPACE_MAP.md` and current subsystem maps under `docs/maps/` in local Cat Code, Claude, and Codex transcript JSONL files.

## Executive Summary

Models do use the workspace maps, but usage is uneven and should not be interpreted as simple adoption. The maps are most effective as a routing aid for broad source-discovery work. In those cases, a model reads `WORKSPACE_MAP.md` or a focused subsystem map, then inspects source files that align with the map's ownership boundaries. This pattern appears in Agent Mode, task/worker, permissions, Codex account usage, app/runtime, build, diagnostics, and desktop migration investigations.

Map use is not reliably substantive. Some sessions read a map only after broad search already found the relevant files. Some read only the index and skip the focused map. Some pick a weak or irrelevant focused map. Some see maps only in `git status` or `git diff` output while doing unrelated work. Opening or mentioning a map is therefore an upper-bound signal for possible use, not proof of meaningful use.

Many skipped-map sessions are reasonable. When the user supplies exact files, a specific bug report, or a migration plan with named source files, models often go directly to those files. In sampled cases, this usually caused no obvious harm. Skipping maps is more concerning in broad research tasks where the model fans out across many files. One broad OpenAI/image-generation research subagent skipped maps, searched widely, read many source files, and ended with `Prompt is too long`; it is reasonable to infer maps might have reduced the search breadth, but that counterfactual is not proven.

Current map-guided decisions were generally accurate when the model selected an appropriate map and used it before source search. I did not find a verified case where current `docs/maps/*.md` content directly misled a model. The more common failure mode is model behavior around the maps: late use, superficial use, wrong focused-map choice, or no use.

The old auto-map context-injection feature should be excluded from this analysis. The repo's `DONE.md` says that feature was transient API-payload context, never written to JSONL, and has been removed. This report focuses on active assistant tool calls and observable behavior in transcripts.

## Research Question

The goal was observation and evaluation, not improving adoption or redesigning the map system. The requested questions were:

- Whether models actually use the workspace maps.
- When and why they use or skip them.
- How maps affect their work.
- Whether usage is substantive or superficial.
- Whether map-guided decisions are accurate and useful.
- When usage helps, harms, misleads, or makes no meaningful difference.
- Whether behavior varies by task, session, model, platform, or other relevant conditions.
- Other important real-world findings.

## Sources Inspected

Transcript locations:

- `/Users/pt/.cat-code/projects/-Users-pt-cat-code/**/*.jsonl`
- `/Users/pt/.claude/projects/-Users-pt-cat-code/**/*.jsonl`
- `/Users/pt/.codex/sessions/**/*.jsonl`
- `/Users/pt/.codex/archived_sessions/**/*.jsonl`

No `/Users/pt/.claude-code` directory was present during this investigation.

Repository instruction sources:

- `AGENTS.md` points to `CLAUDE.md`.
- `CLAUDE.md` instructs models to use `docs/maps/WORKSPACE_MAP.md` before broad source search for non-trivial questions, bugs, or features, and to inspect matching subsystem maps before prompt, tools, permissions, config, persistence, or Agent Mode changes.
- `docs/maps/WORKSPACE_MAP.md` is the current map index.
- Current subsystem maps are the files directly under `docs/maps/`.

The current map set contains 18 files:

- `WORKSPACE_MAP.md`
- `agent-mode.md`
- `analytics-diagnostics.md`
- `auth-accounts-oauth.md`
- `bridge-remote-cli.md`
- `build-release-testing.md`
- `codex-core.md`
- `config-persistence.md`
- `ide-lsp.md`
- `native-client-integrations.md`
- `plugins-skills-commands.md`
- `proactive-assistant-services.md`
- `prompt-system.md`
- `query-provider-runtime.md`
- `tasks-workers.md`
- `terminal-ui-state.md`
- `tools-permissions.md`
- `web-app-runtime.md`

## Treatment of Auto Map Injection

Auto map injection was deliberately excluded.

`DONE.md` entry 91 states that the keyword auto-map context-injection feature was investigated and removed. The important points for this report are:

- The injected content was a transient attachment rendered into the API payload at query time.
- It was never written to transcript JSONL.
- Logs and transcripts could not confirm it fired.
- The measured matcher would have fired on 27.5% of interactive prompts.
- 58% of those fires added a marginal second map, often from generic keywords such as `account`.
- The matched map had already been read in-session 85% of the time without the feature.
- The feature was deleted, while the maps and `CLAUDE.md` instruction remained.

Because the feature did not persist into JSONL and no longer exists, this report treats active assistant tool calls as the observable evidence.

## Method

I used a conservative transcript parser plus manual validation.

Hard evidence counted:

- Assistant tool calls that explicitly read a current `docs/maps/*.md` file.
- Assistant shell/tool calls that searched current `docs/maps/*.md` files.
- The order of map reads/searches relative to source-file reads/searches.
- Follow-on source paths and final answers in representative sessions.

Not counted as map use:

- User prompt text that mentioned maps.
- Startup/system/deferred context.
- Auto-injected context.
- Tool outputs from unrelated commands that happened to include map paths.
- `git status`, `git diff`, `git add`, or `git commit` output involving maps unless separately classified as map-maintenance context.
- Opening or editing maps when the user's task was explicitly to refresh or modify maps, except where noted as map-maintenance behavior.

The parser had to handle three transcript formats:

- Cat Code JSONL with assistant `tool_use` entries.
- Claude JSONL with assistant `tool_use` entries.
- Codex JSONL with `function_call` entries, often shell commands such as `sed`, `cat`, or `rg`.

The Codex corpus was filtered by `cwd`, workspace root, or clear `/Users/pt/cat-code` context. This is best-effort rather than guaranteed exhaustive.

Manual validation focused on representative cases where the parser found map access or where subagents reported interesting skipped/superficial behavior. Subagent reports were treated as leads, then spot-checked against local transcripts before being incorporated.

## Quantitative Baseline

Conservative current-map count:

| Measure | Count |
|---|---:|
| Filtered transcript files | 1,609 |
| Cat Code transcripts | 1,139 |
| Claude transcripts | 126 |
| Codex transcripts | 344 |
| Root sessions | 675 |
| Subagent sessions | 934 |
| Sessions with any current-map tool event | 406 |
| Sessions with active current-map read/search | 392 |
| Sessions with map read/search before first detected source inspection | 280 |

By platform, current-map read/search sessions:

| Platform | Map read/search sessions | Total filtered sessions |
|---|---:|---:|
| Cat Code | 235 | 1,139 |
| Claude | 32 | 126 |
| Codex | 125 | 344 |

By platform, current-map read/search before first detected source inspection:

| Platform | Sessions |
|---|---:|
| Cat Code | 149 |
| Claude | 27 |
| Codex | 104 |

Current-map read/search event counts by file:

| Map | Events |
|---|---:|
| `WORKSPACE_MAP.md` | 425 |
| `tools-permissions.md` | 146 |
| `codex-core.md` | 140 |
| `auth-accounts-oauth.md` | 119 |
| `terminal-ui-state.md` | 94 |
| `tasks-workers.md` | 89 |
| `config-persistence.md` | 89 |
| `agent-mode.md` | 87 |
| `plugins-skills-commands.md` | 63 |
| `bridge-remote-cli.md` | 60 |
| `query-provider-runtime.md` | 57 |
| `web-app-runtime.md` | 56 |
| `build-release-testing.md` | 54 |
| `prompt-system.md` | 36 |
| `analytics-diagnostics.md` | 34 |
| `native-client-integrations.md` | 19 |
| `ide-lsp.md` | 13 |
| `proactive-assistant-services.md` | 6 |

Important interpretation: these are access counts. They are not meaningful-use counts. A session can read a map and still not use it substantively.

## Observed Usage Patterns

### 1. Routing-First Substantive Use

This is the strongest pattern. A model reads `WORKSPACE_MAP.md` or a focused subsystem map early, then inspects source files in the map's domain. In many cases the final answer or implementation cites those files.

This pattern is common in:

- Agent Mode and worker UI questions.
- Background task and subagent lifecycle questions.
- Codex account usage and account-pool debugging.
- Permissions/tooling audits.
- Web/app runtime and desktop migration work.
- Diagnostics inventory.

This is the map system working as an index and boundary guide, not as a source of truth. The decisive facts still come from source.

### 2. Direct Focused-Map Use Without Workspace Index

Some sessions skip `WORKSPACE_MAP.md` and read an obviously relevant focused map directly. Example: a worker/subagent UI task read `agent-mode.md` first. This can still be substantive. For a well-scoped task, direct focused-map use is not a failure.

### 3. Prompt-Driven Subagent Use

Several parent agents instructed subagents to read `WORKSPACE_MAP.md` and focused maps. Those subagents complied and often used maps effectively. This is real map use, but it is not autonomous discovery by the subagent. The condition causing usage is explicit delegation wording.

### 4. Late Confirmation

Some sessions search source first, find the relevant files, then read the map. In these cases the map may confirm routing, but it did not materially shape discovery. This pattern should not be counted as strong evidence of map effectiveness.

### 5. Nominal Compliance

Some sessions read `WORKSPACE_MAP.md` but do not follow to a focused subsystem map, or read a focused map that does not match the task. These sessions look compliant in a simple grep but show little evidence of actual map-guided work.

### 6. Map Maintenance

Map-refresh automation sessions and stale-doc cleanup sessions read and edit maps extensively. These are substantive map interactions, but not ordinary map use for coding-task navigation. They should be analyzed separately.

### 7. Reasonable Skips

When the user provides exact files, a precise bug report, or already-scoped migration instructions, models often skip maps. In sampled cases this was often efficient and did not obviously degrade the result.

### 8. Risky Broad Skips

When a task is broad and source-discovery-heavy, skipping maps is more likely to cause waste. The clearest observed symptom was context blow-up from wide search. The counterfactual remains uncertain.

## Representative Cases

### Helpful and Substantive: Agent Mode Worker Count UI

Transcript: `/Users/pt/.cat-code/projects/-Users-pt-cat-code/0a594536-7de9-4b59-9e3a-5e617ce53402.jsonl`

Task: investigate how live worker/subagent count is displayed in the UI.

Verified map evidence:

- Line 6 reads `/Users/pt/cat-code/docs/maps/agent-mode.md`.

Follow-on source inspection:

- `src/agent-mode/AgentModeWorkerRoster.tsx`
- `src/agent-mode/workerUxSummary.ts`
- `src/components/StatusLine.tsx`
- `src/components/PromptInput/PromptInputFooter.tsx`
- `src/screens/REPL.tsx`
- `src/components/CoordinatorAgentStatus.tsx`
- task status files

Final behavior:

- The answer distinguished the Agent Mode roster above the prompt from the generic `/tasks` footer pill.
- It identified the relevant component and state flow.

Assessment:

- Substantive and useful.
- The model did not read `WORKSPACE_MAP.md`, but direct `agent-mode.md` use was appropriate because the task was clearly in Agent Mode/worker UI.

### Helpful and Substantive: Worker Lifecycle and Status Semantics

Transcript: `/Users/pt/.cat-code/projects/-Users-pt-cat-code/2c8bf668-580b-4f02-be1b-85e402b0459b.jsonl`

Task: clarify worker lifecycle/statuses and who unblocks each state for subagent status UI.

Verified map evidence:

- Read `tools-permissions.md`.
- Read `agent-mode.md`.
- Read `tasks-workers.md`.

Follow-on source inspection:

- `src/agent-mode/sessionState.ts`
- `src/agent-mode/workerUxSummary.ts`
- `src/agent-mode/AgentModeWorkerRoster.tsx`
- `src/tasks/types.ts`
- `src/components/tasks/taskStatusUtils.tsx`
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- Agent tool utilities
- worker-control tools
- permission handlers
- orchestrator prompt files

Assessment:

- Substantive and useful.
- The maps helped include both Agent Mode worker state and generic task surfaces.

### Helpful but Methodologically Incomplete: Energy Investigation

Transcript: `/Users/pt/.cat-code/projects/-Users-pt-cat-code/0f831fa5-79e3-4719-b118-33abd6317e5d.jsonl`

Task: investigate high energy usage on an M4 Mac, suspected around subagents, background tasks, proactive services, app runtime, and prompts.

Verified map evidence:

- Read `WORKSPACE_MAP.md`.
- Read `bridge-remote-cli.md`.
- Read `web-app-runtime.md`.
- Read `agent-mode.md`.
- Read `tasks-workers.md`.
- Read `prompt-system.md`.
- Read `query-provider-runtime.md`.

Follow-on source inspection:

- `src/tools/AgentTool/AgentTool.tsx`
- `src/tools/AgentTool/agentToolUtils.ts`
- `src/tools/AgentTool/runAgent.ts`
- `src/tools/AgentTool/builtInAgents.ts`
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- task framework files
- cancellation/shutdown code
- `src/screens/REPL.tsx`
- web runtime files
- prompt files

Final behavior:

- The model admitted it had not proven high battery usage.
- It found high API/token usage and candidate local-energy paths, but lacked CPU/wakeups/disk/network proof.

Assessment:

- Map use was substantive for routing.
- Map use did not ensure the investigation answered the user's true energy question.
- This shows maps help navigation, not methodology.

### Helpful and Substantive: Background-Agent Handoff Diagnosis

Transcript: `/Users/pt/.cat-code/projects/-Users-pt-cat-code/0a653235-1be8-46e2-bdf2-23cfda7793b0.jsonl`

Task: understand `background-agent-result-handoff-safety` and delayed subagent result injection.

Verified map evidence:

- Read `WORKSPACE_MAP.md`.
- Read `tasks-workers.md`.
- Read `query-provider-runtime.md`.
- Read `config-persistence.md`.

Follow-on source inspection:

- `TaskOutputTool.tsx`
- `AgentTool.tsx`
- `LocalAgentTask.tsx`
- `messages.ts`
- `messageQueueManager.ts`
- `query.ts`
- `queueProcessor.ts`
- `attachments.ts`
- `taskNotification.ts`

Assessment:

- Substantive and useful.
- The maps appear to have steered the model from a general subagent/task issue into task-worker, query queue, and persistence surfaces.

### Helpful and Direct: Diagnostics Inventory

Transcript: `/Users/pt/.cat-code/projects/-Users-pt-cat-code/f8d7c169-c86b-4091-8075-21150f77c46c/subagents/agent-a1b2f3547659b8647.jsonl`

Task: read-only inventory of `/doctor` and `/status` diagnostics surfaces.

Verified map evidence:

- Read `WORKSPACE_MAP.md`.
- Globbed `docs/maps/**/*.md`.
- Searched maps for `doctor|status`.
- Found and read `analytics-diagnostics.md`.

Follow-on source inspection:

- `src/commands/doctor/*`
- `src/commands/status/*`
- `src/screens/Doctor.tsx`
- `src/components/Settings/Status.tsx`
- `src/utils/status.tsx`
- `doctorDiagnostic.ts`
- `doctorContextWarnings.ts`

Assessment:

- Substantive and direct.
- Map search identified the relevant diagnostics map and owner files.

### Helpful and Substantive: Codex Account Usage Mismatch

Transcript: `/Users/pt/.claude/projects/-Users-pt-cat-code/0c289e10-405e-4c4b-a86e-e08c7956f9f0.jsonl`

Task: debug why Cat Code showed `main2` Codex usage as 100% while the Codex app showed 31% remaining.

Verified map evidence:

- Read `WORKSPACE_MAP.md`.
- Read `codex-core.md`.

Follow-on source inspection:

- `src/services/api/codexUsage.ts`
- `src/services/api/codexAccountPool.ts`
- `src/components/Settings/Usage.tsx`
- `src/commands/accounts/accounts.ts`

Assessment:

- Substantive and useful.
- The map led to the correct Codex API/account-pool surface.

### Helpful and Substantive: Codex Account Availability Design Review

Transcript: `/Users/pt/.claude/projects/-Users-pt-cat-code/53159be1-fa67-4fd6-ba62-9ea841fdeadd.jsonl`

Task: review Codex account availability design.

Verified map evidence:

- Read `auth-accounts-oauth.md`.
- Read `codex-core.md`.

Follow-on source inspection:

- `codexAccountPool.ts`
- `codexUsage.ts`
- `codexTokenRefresh.ts`
- `codexAccountLeaseManager.ts`
- account command and UI files
- retry/client code

Assessment:

- Substantive and useful.
- Source path followed the map boundaries closely.

### Helpful and Substantive, But Prompt-Driven: GUI Mock Data Shape Audit

Transcript: `/Users/pt/.claude/projects/-Users-pt-cat-code/80d12ced-6f11-4af0-a86b-5329284f7837.jsonl` and subagents.

Task: verify GUI mock data shapes against real Cat Code types.

Verified map evidence:

- Parent prompted subagents to check `WORKSPACE_MAP.md`.
- One subagent read `WORKSPACE_MAP.md`, then `terminal-ui-state.md` and `tools-permissions.md`.
- Another subagent read `WORKSPACE_MAP.md`, then auth/config/agent/plugins/IDE maps.

Follow-on source inspection:

- `src/types/logs.ts`
- `src/types/message.ts`
- `src/types/permissions.ts`
- `PermissionRequest.tsx`
- `codexAccountPool.ts`
- `claudeAccountPool.ts`
- `src/agent-mode/sessionState.ts`
- command and IDE utility files

Assessment:

- Substantive and useful.
- Usage was caused by explicit delegation instructions, not spontaneous behavior.

### Helpful and Substantive: Subsystem Routing for DONE Review

Transcript: `/Users/pt/.claude/projects/-Users-pt-cat-code/813e3f6c-b7ba-4425-8c90-41f869353ea2.jsonl` and subagents.

Task: group `DONE.md` work and spawn review subagents by subsystem.

Verified map evidence:

- Parent read `WORKSPACE_MAP.md`.
- Parent said maps would guide subagents.
- Subagents read focused maps such as `codex-core.md`, `query-provider-runtime.md`, `agent-mode.md`, and `tasks-workers.md`.

Follow-on source inspection:

- Codex adapter/API files.
- File patch tool files.
- Agent Mode files.
- Agent tool files.
- task files.

Assessment:

- Substantive and useful.
- The map system shaped delegation boundaries.

### Substantive but Late: Agent Mode Naming Mechanics

Transcript: `/Users/pt/.claude/projects/-Users-pt-cat-code/4943ae33-ec24-400b-a3c6-30af1a2c579c.jsonl`

Task: reason about Agent Mode/subagent naming mechanics.

Verified map evidence:

- Read `WORKSPACE_MAP.md`.
- Read `agent-mode.md`.

Follow-on source inspection:

- `src/agent-mode/agentMode.ts`
- `src/tools.ts`
- `src/tools/AgentTool/AgentTool.tsx`
- `src/constants/prompts.ts`
- `workerNames.ts`
- `resolveAgentTarget.ts`

Assessment:

- The map reads were substantive in content, but late.
- Several broad searches had already found core files.
- Likely effect: confirmation more than routing.

### Mixed and Initially Misleading: Agent Tool Rendering in Chat Transcript

Transcript: `/Users/pt/.cat-code/projects/-Users-pt-cat-code/3e1d3a37-b1cf-4f7f-8b89-d02f19d9bea8.jsonl`

Task: inspect how agent-type tool calls are rendered in the chat transcript. The user cited `cat-app/Messages.jsx`, `cat-app/data.js`, and `MOCK_AGENTS`.

Verified map evidence:

- Initially read `config-persistence.md`.
- Later globbed for `WORKSPACE_MAP.md`.
- Read `WORKSPACE_MAP.md`.
- Later read `web-app-runtime.md`.

Observed behavior:

- The model first tried nonexistent repo paths under `/Users/pt/cat-code/cat-app`.
- It then used `/Users/pt/Downloads/cat-app`, an old prototype.
- The user corrected that this was stale.
- The model then read `web-app-runtime.md` and switched to current sources:
  - `web/src/App.tsx`
  - `web/src/components/MessageContent.tsx`
  - `web/src/appProtocol.ts`
  - `src/web/appSessionEventMapper.ts`
  - `src/app-runtime/sessionEvents.ts`
  - `src/tools/AgentTool/AgentTool.tsx`
  - `src/tools/AgentTool/UI.tsx`
  - task files

Assessment:

- Initial map choice was wrong and superficial.
- Later `web-app-runtime.md` helped re-route to live code.
- Map use did not prevent stale-prototype work or stale filename assumptions.
- Net result: mixed. The map system eventually helped, but not early enough to avoid wasted work.

### Superficial/Partial: Exa WebSearch Implementation

Transcript: `/Users/pt/.cat-code/projects/-Users-pt-cat-code/54e6b9de-15e6-44bc-ad6f-14b4e6fd7f6a.jsonl`

Task: implement Batch 1 of Exa-backed `WebSearch`.

Verified map evidence:

- Read `WORKSPACE_MAP.md`.
- Read `prompt-system.md`.
- Later verifier subagent searched maps for `WebSearch|web search` and read `WORKSPACE_MAP.md`.

Follow-on source inspection:

- `src/tools/WebSearchTool/exa.ts`
- `src/tools/WebSearchTool/WebSearchTool.ts`
- `src/tools/WebSearchTool/WebSearchTool.test.ts`
- `src/tools/WebSearchTool/prompt.ts`
- `src/tools/WebSearchTool/UI.tsx`
- `src/utils/subprocessEnv.ts`

Assessment:

- Little verified effect on navigation.
- The plan already named the files.
- For tool/permission work, `tools-permissions.md` was likely the better focused map, but the main implementation read `prompt-system.md`.

### No Meaningful Difference: Electron Streaming Projector

Transcript: `/Users/pt/.cat-code/projects/-Users-pt-cat-code/04e7ec96-ff0a-4738-ab3f-0020e9dbe8a2.jsonl`

Task: implement P2-3 streaming/activity engine in an isolated worktree.

Verified map evidence:

- Read `.worktrees/p2-3-streaming/docs/maps/WORKSPACE_MAP.md` after user-specified migration docs.

Follow-on source inspection:

- `app/renderer/src/transcriptProjector.ts`
- `sdkMessageFixtures.ts`
- `transcriptProjector.test.ts`
- `TranscriptView.tsx`

Assessment:

- The user prompt had already prescribed docs and source files.
- Map use did not appear to change navigation.
- No meaningful difference.

### Reasonable Skip: Exact Skill Watcher Bug Fix

Transcript: `/Users/pt/.claude/projects/-Users-pt-cat-code/ed6b7cad-1074-475b-932e-b4ff64b2b445.jsonl`

Task: fix a specific finding in `docs/reports/2026-06-06-done-md-code-review.md`; the user named the bug and relevant files.

Observed behavior:

- No map read.
- The model read the report and exact files:
  - `src/utils/skills/skillChangeDetector.ts`
  - `src/skills/loadSkillsDir.ts`
  - `src/bootstrap/state.ts`
- It added/updated a focused test and ran build/tests.

Assessment:

- Skipping maps was reasonable.
- The task had exact anchors.
- Map use likely would not have materially changed the result.

### Risky Skip: GPT/OpenAI-Compatible API and Image Generation Research

Transcript: `/Users/pt/.cat-code/projects/-Users-pt-cat-code/7aa7ed1a-04c4-4168-b3ee-a3a330891742/subagents/agent-a51a2ce4a7f4d27a2.jsonl`

Task: research how GPT/OpenAI-compatible API calls are implemented and where image generation support should be added.

Observed behavior:

- No current map read.
- The model immediately ran broad searches across `src`.
- It read many provider/model/API/attachment/command files:
  - `src/services/api/codex-fetch-adapter.ts`
  - `src/utils/model/*`
  - `src/services/api/client.ts`
  - `src/services/api/filesApi.ts`
  - `src/services/api/claude.ts`
  - `src/query.ts`
  - `src/tools.ts`
  - `src/commands.ts`
  - and more
- The transcript ended with `Prompt is too long`.

Assessment:

- This was a broad source-discovery task where maps were likely relevant.
- It is reasonable to infer maps such as `query-provider-runtime.md`, `codex-core.md`, and possibly `tools-permissions.md` could have narrowed the search.
- It is not proven that map use would have prevented the context failure.

### Substantive Codex Use: Normal-Mode Subagent Design Review

Transcript: `/Users/pt/.codex/sessions/2026/06/02/rollout-2026-06-02T13-52-29-019e871a-edd3-7523-9c50-bce4f9f3bce1.jsonl`

Task: second-pass review of `docs/agent/2026-06-02-normal-mode-subagent-upgrade.md`.

Verified map evidence:

- Read `docs/maps/WORKSPACE_MAP.md`.
- Searched `docs/maps` and `docs/prompts`.
- Read:
  - `agent-mode.md`
  - `tasks-workers.md`
  - `tools-permissions.md`
  - `config-persistence.md`

Follow-on source inspection:

- `src/tools/AgentTool/*`
- `src/agent-mode/rolePrompts.ts`
- `src/agent-mode/roleFiles.ts`
- `src/memdir/paths.ts`
- `src/utils/permissions/filesystem.ts`

Assessment:

- Substantive and useful.
- The model explicitly stated that the maps pointed to Agent Mode, AgentTool, task, permission, and persistence owners before source-level checks.

### Substantive Codex Use: Agent Mode UI/Status Mismatch

Transcript: `/Users/pt/.codex/sessions/2026/06/02/rollout-2026-06-02T23-20-59-019e8923-678e-74c1-b1c6-6a90d64ce378.jsonl`

Task: troubleshoot Agent Mode UI/status mismatch around a background subagent.

Verified map evidence:

- Read `WORKSPACE_MAP.md`.
- Searched maps.
- Read or surfaced `tasks-workers.md`.

Follow-on source inspection:

- `src/tasks.ts`
- `src/tasks/`
- `src/screens/REPL.tsx`
- `src/agent-mode/sessionState.ts`
- `src/main.tsx`
- `src/tools/AgentTool/*`

Assessment:

- Substantive and useful.
- The maps routed the investigation into task/worker and Agent Mode state layers. The final root cause still came from logs and source.

### Substantive but Final Verdict Came From Source: Desktop Transport/Shell Review

Transcript: `/Users/pt/.codex/sessions/2026/07/02/rollout-2026-07-02T01-53-03-019f1f07-0d3c-7822-8e91-d87d89262a3e.jsonl`

Task: adversarial falsification of desktop migration transport/shell decision.

Verified map evidence:

- Read `WORKSPACE_MAP.md`.
- Read `web-app-runtime.md`.
- Read `build-release-testing.md`.
- Read `tools-permissions.md`.

Follow-on source inspection:

- `src/entrypoints/sdk/coreTypes.generated.ts`
- `src/app-runtime/*`
- `src/web/*`
- `src/bootstrap/state.ts`
- `src/QueryEngine.ts`
- `scripts/build.ts`

Assessment:

- Map use scoped the relevant runtime/build areas.
- Decisive findings came from direct protocol/schema/source probes.
- Substantive, but not clearly outcome-changing.

### Substantive Codex Use: Desktop Migration P1 Fixes

Transcript: `/Users/pt/.codex/sessions/2026/07/03/rollout-2026-07-03T19-18-59-019f27ea-fbae-7aa0-9162-c5a4f7bb0fd6.jsonl`

Task: re-verify and fix P1-F1 through P1-F9 for desktop migration.

Verified map evidence:

- Read `WORKSPACE_MAP.md`.
- Searched maps for desktop/supervisor/sidecar/transport/renderer terms.
- Read `web-app-runtime.md`.
- Read `build-release-testing.md`.

Follow-on source inspection:

- `app/supervisor/supervisor.ts`
- `app/main/main.ts`
- `app/shared/*`
- `app/sidecar/*`
- `app/renderer/src/*`
- sidecar typecheck scripts

Assessment:

- Substantive and useful.
- The map search selected focused runtime/build maps before implementation work.

### Skip With No Observed Harm: Desktop Migration Plan Review

Transcript: `/Users/pt/.codex/sessions/2026/06/28/rollout-2026-06-28T19-52-39-019f0e4a-0535-7751-b743-588c5d6e6aba.jsonl`

Task: adversarial review of CatCode desktop migration plan from `/Users/pt/catcode_prototype`, inspecting `/Users/pt/cat-code`.

Observed behavior:

- No active current-map call.
- The first broad source call searched `package.json`, `scripts`, and `src`.
- Follow-on source included `package.json`, `scripts/build.ts`, `src/app-runtime/*`, `src/web/*`, `src/QueryEngine.ts`, `src/bootstrap/state.ts`, `src/utils/Shell.ts`, and `src/services/tools/StreamingToolExecutor.ts`.

Assessment:

- This probably met the broad-task condition where maps were intended to be used.
- No concrete harm was observed; the source search was broad but successful.

## When Models Use Maps

Models are more likely to use maps when:

- The task is broad and framed as investigation, review, or architecture tracing.
- The task domain matches a known subsystem: Agent Mode, tasks/workers, permissions, accounts, Codex API, web runtime, build/testing, diagnostics.
- The user or parent agent explicitly says to use maps.
- A subagent is given a map-guided subsystem assignment.
- The model is operating in a later session where `CLAUDE.md` map instructions are more likely to be loaded and current.

Models sometimes use focused maps directly when the subsystem is obvious. This can be good behavior.

## When Models Skip Maps

Models skip maps when:

- The prompt names exact files.
- The prompt names a specific report or code-review finding.
- The task is implementation from an existing plan with clear file ownership.
- The model starts from recent diffs instead of architecture.
- A subagent is given a narrow file list and no map instruction.
- The session predates the current `docs/maps/` system or uses older map conventions.

Some skips are appropriate. The repo instruction says to use maps before broad source search for non-trivial questions, bugs, or features. It does not imply every exact-file edit needs a map read.

## How Maps Affect Work

Observed helpful effects:

- Narrowed initial source search.
- Directed models to adjacent owner files beyond the obvious file.
- Improved cross-subsystem coverage in review tasks.
- Helped split subagent work by subsystem.
- Helped models distinguish task/worker state from Agent Mode worker state.
- Helped account investigations include both Codex-core and auth/account-pool surfaces.
- Helped web/runtime work include build/test surfaces.

Observed limited/no effects:

- No meaningful difference when the user gave exact files.
- No meaningful difference when the model read a map after finding source files.
- Little effect when the model read only `WORKSPACE_MAP.md` and did not follow to a focused map.
- Little effect when the selected focused map did not match the task.

Observed negative/friction effects:

- Wasted time on irrelevant map reads.
- Nominal compliance can hide that the map did not influence work.
- Map reads do not prevent stale external context or incorrect file assumptions.
- Maps do not ensure the right empirical method for performance/energy investigations.

## Accuracy and Usefulness of Map-Guided Decisions

Verified current-map guidance was generally accurate in the substantive cases.

Useful map-guided decisions included:

- `agent-mode.md` for Agent Mode worker roster/status work.
- `tasks-workers.md` for background task and subagent handoff work.
- `codex-core.md` and `auth-accounts-oauth.md` for Codex account usage and availability work.
- `tools-permissions.md` for permission UI and tool-filtering audits.
- `analytics-diagnostics.md` for `/doctor` and `/status` surfaces.
- `web-app-runtime.md` and `build-release-testing.md` for desktop/web runtime migration work.
- `query-provider-runtime.md` for query loop/provider-routing work.

I did not verify a current-map content error that directly misled a model. The closest negative evidence came from wrong model choices around maps, not wrong map facts:

- reading `config-persistence.md` for chat transcript rendering;
- reading maps too late;
- reading only the index;
- using stale external prototype files despite later map availability.

## Substantive vs Superficial Use Criteria

Strong evidence of substantive map use:

- Map read/search happens before source inspection.
- The focused map matches the task domain.
- Follow-on source files align with the map's owner list.
- The final answer or implementation depends on those source paths.
- The model includes adjacent subsystems that are not obvious from the user prompt.

Moderate evidence:

- Map read happens before source inspection, but source path also follows exact user-provided files.
- Map read confirms routing already suggested by the prompt.

Weak/superficial evidence:

- Map read happens after broad source search.
- Only `WORKSPACE_MAP.md` is read.
- The focused map is irrelevant or too generic.
- Map path appears in `git status`/`git diff` output.
- The task is map maintenance rather than map-guided coding.
- The transcript contains user/developer instructions mentioning maps but no assistant tool call reads them.

## Variation by Platform, Model, and Time

There is variation, but strong causal claims are not supported.

A rough model/date pass found:

- April 2026 filtered sessions had no current `docs/maps/*` access under the strict current-map definition.
- May 2026 had 101 map-read/search sessions out of 489.
- June 2026 had 272 out of 683.
- July 2026 had 32 out of 76.

This likely reflects the introduction/maturation of the current map system, changes in repo instructions, and task mix. It should not be read as pure model behavior.

Approximate model-level counts from the same rough pass:

| Model label | Sessions | Sessions with current-map access | Percent |
|---|---:|---:|---:|
| `gpt-5.5` | 580 | 285 | 49.1% |
| `gpt-5.4` | 561 | 54 | 9.6% |
| `gpt-5.4-mini` | 151 | 23 | 15.2% |
| `claude-opus-4-8` | 76 | 28 | 36.8% |
| `gpt-5.2` | 15 | 7 | 46.7% |

These figures are weak evidence. They are confounded by platform, session date, task type, prompt style, and whether the current map system existed or was relevant.

Subagents are also overrepresented in file counts: 934 of 1,609 filtered transcript files were subagent transcripts. Treating each subagent as an independent user session would overstate behavioral frequency.

## Important Limitations

Transcript evidence cannot prove internal cognition. It can show that a model opened a map and then opened certain files. It cannot prove the map caused that source path.

The parser is conservative but imperfect. It detects explicit current-map reads/searches in heterogeneous transcript formats. It may miss unusual tool wrappers or overcount shell snippets that read maps as part of larger commands.

Some tool output was persisted to sidecar files; not every sidecar was semantically reviewed.

Codex filtering is best-effort. Some relevant sessions may be excluded if `cwd` was not captured; some included sessions may have used Cat Code as source while operating from another context.

Auto map injection cannot be evaluated from JSONL because repo evidence says it was never written to transcript JSONL and has since been removed.

The report does not estimate causal lift. The evidence supports statements like "map use often preceded accurate source routing" and "skipping maps sometimes led to broad search." It does not support strong claims like "maps reduce task time by X%" or "maps prevent Y% of misses."

## Conclusions

Verified:

- Models actively read and search current workspace maps in a meaningful number of sessions.
- Map use is often substantive for broad source-discovery tasks.
- Focused subsystem maps frequently route models to correct owner files.
- Subagents use maps more reliably when explicitly instructed.
- Many no-map sessions are narrow exact-file tasks where skipping maps is not clearly harmful.
- There is a real difference between map access and map-guided behavior.

Reasonable inferences:

- Maps help most by reducing initial search breadth and surfacing adjacent subsystem owners.
- The benefit is highest when the task is broad and the model reads a focused map before searching source.
- Superficial map reads may create a false impression of compliance.
- In broad research tasks, skipping maps can increase context waste and risk of missed owner files.
- The current maps are usually accurate enough to be useful when selected correctly.

Unknowns:

- The actual causal effect size of map use on task quality, time, token cost, or bug rate.
- Whether stronger models would use maps more selectively or more substantively.
- How often map use changes final outcomes rather than just search path.
- How much of the observed platform/model variation is caused by task mix and session date.
- Whether unobserved injected or summarized context affected behavior in ways not visible in JSONL.

Overall, the current evidence supports this product-analysis framing: workspace maps function as a practical navigation layer, not as a guaranteed behavior-control mechanism. They are useful when models actually route through them, but the real-world behavior is conditional, uneven, and often prompt/task dependent. Any future analysis should separate "opened a map" from "used a map to make a correct and useful decision."
