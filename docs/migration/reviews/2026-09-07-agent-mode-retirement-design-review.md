# Agent Mode Retirement Design Review

**Verdict: RED.** The retirement boundary is directionally correct, but the
execution contract still has live omissions and one unresolved UI/data
contradiction. Do not dispatch implementation until these are folded into the
contract.

## Findings

### F1 — High: prompt removal omits live assembly surfaces

The design names the main query paths but not the context-analysis path or the
provider-specific Agent Mode helpers. `src/utils/analyzeContext.ts:1046-1071`
still detects `CLAUDE_CODE_AGENT_MODE`, builds Agent Mode sections, and passes
them to `buildEffectiveSystemPrompt`. `src/constants/promptStyles/gpt.ts:176-185`
changes the normal action contract from the same environment variable, while
`getGPTAgentModeUsingToolsSection`,
`getGPTAgentModeSessionGuidanceSection`, and its worker-control helper remain
dedicated Agent Mode prompt builders.

If only the named foreground/background query paths are removed, prompt
analysis can still assemble the retired prompt and provider prompt code retains
dead mode behavior.

**Disposition:** add `src/utils/analyzeContext.ts` and the Agent Mode exports and
branches in `src/constants/promptStyles/gpt.ts` to the required removal set,
including their regression tests.

### F2 — High: legacy-mode normalization has no complete ingestion boundary

The intended conversion from legacy `agent` to current `normal` is correct, but
the design does not pin the conversion before runtime and wire types. The
desktop catalog currently copies the legacy value unchanged at
`app/sidecar/sessionsCatalogDomain.ts:215`; the wire still admits it at
`app/shared/protocol.ts:3295`; the terminal still renders `[agent]` at
`src/components/LogSelector.tsx:123`; the Sessions page renders its icon and
badge at `app/renderer/src/SessionsPage.tsx:664-719`; and the metadata inspector
prints the mode at `app/renderer/src/MetadataInspector.tsx:176`.

Normalizing only in `sessionsCatalogState` leaves other consumers capable of
surfacing the retired mode. It also leaves `agent` in a current wire union even
though the design says current modes are only `normal | coordinator`.

**Disposition:** define the legacy input union at the transcript parsing
boundary, normalize there for resume, and normalize again at the catalog
mapping boundary before emitting the current wire type. Add explicit coverage
for terminal resume/listing, desktop catalog, and metadata inspection.

### F3 — Medium: the surviving worker detail and proposed snapshot disagree

The proposed generic snapshot excludes `outputSummary`, while the design also
says the worker inspection panel remains. The current detail derives its result
at `app/renderer/src/workerInspection.ts:135-149` and renders it at
`app/renderer/src/TasksDialog.tsx:630-638`. Live local-agent tasks already carry
the terminal `result` at
`src/tasks/LocalAgentTask/LocalAgentTask.tsx:150-187`, but the proposed retained
wire fields do not project it.

The current persisted `outputSummary` is generally the task description rather
than the worker's conclusion, so blindly retaining it is not the right fix.
However, silently dropping the result section would contradict the promise to
retain worker inspection behavior.

**Disposition:** make an explicit product decision in the implementation
contract: either remove the misleading result section as an acknowledged
parity cut while retaining inspection, or project a bounded, secret-guarded
neutral result summary from the live task result. Add the corresponding
renderer and outbound-boundary tests.

### F4 — Medium: tracked Agent Mode support files are absent from the removal list

Agent Mode also owns a bundled recovery skill and tracked repo-local role files:

- `src/skills/bundled/index.ts:2,36`
- `src/skills/bundled/agentModeCompactionRecovery.ts`
- `src/skills/bundled/agent-mode-compaction-recovery/SKILL.md`
- `src/agent-mode/roleFiles.ts:5-84`
- `.cat-code/roles/implementor.md`
- `.cat-code/roles/verifier.md`

The detailed design discusses compaction and role-file injection, but its
implementation and documentation lists do not require deleting the bundled
skill registration/files or the role files that have no remaining reader.
Leaving them preserves dead product and repo-local instruction surfaces.

**Disposition:** name these files explicitly in the removal set and verify that
the ordinary built-in `implementor` and `verification` prompts remain
self-contained without them.

### F5 — Medium: current documentation owners extend beyond the listed maps

The repository's live architecture instructions still route Agent Mode through
`CLAUDE.md:55,340`. The canonical prompt routing document still specifies an
Agent Mode precedence branch at
`docs/prompts/2026-04-30-prompt-surfaces.md:62-86`. The undated current
decisions `AGENT-CHROME.md`, `ORCHESTRATOR-IN-SESSION.md`, and
`WELCOME-LAUNCHER.md` also describe the worker seam and mode toggle that this
retirement changes; annotating only `AGENT-MODE-TOGGLE.md` leaves current
decision material pointing at removed types and owners.

**Disposition:** update `CLAUDE.md` and the canonical prompt routing document.
Add retirement amendments to the undated decision records whose live rulings
are changed, while preserving dated reports, plans, reviews, and `docs/agent/`
as historical records.

### F6 — Medium: the proposed stale-reference sweep cannot prove the contract

The command scans all of `docs`, where historical Agent Mode references are
intentionally preserved, but it does not state executable exclusions. At the
same time, its expression omits live retirement identifiers including
`AskOrchestrator`, `OrchestratorRoster`, `orchestratorState`,
`AgentModeSnapshot`, `AgentModeWorkerItem`, `AgentModeStatusHeader`, the bundled
recovery skill, and plain `mode === 'agent'` or `orchestrating` display checks.

This can produce both false positives from historical records and false
negatives in maintained source.

**Disposition:** split verification into two commands: a zero-hit sweep over
source/config/live docs for every retired identifier, and a separate audited
list of allowed historical hits under dated records. Include current decision
docs and canonical routing docs in the zero-stale-reference set.

## Confirmed correct boundaries

- The four Agent Mode-only tools are exactly `ListWorkers`, `WaitWorkers`,
  `GetWorkerResult`, and `CancelWorker`.
- `Agent`, `ResumeAgent`, `SendMessage`, `TaskStop`, teams, peers, worktrees, and
  generic tasks remain.
- `AskOrchestrator` is a generic child-to-parent escalation capability and
  should be renamed rather than removed.
- Coordinator Mode needs the neutral worker persistence extraction.
- Existing `.agent-mode-state.json` files must not be deleted; only legacy
  coordinator records should be read into the successor state.
- The desktop replacement should remain outbound-only and continue through
  outbound preparation, secret scanning, and frame-size enforcement.
- `is_local_agent_mode` analytics is unrelated to this runtime and remains.

## Dispatch decision

The requested Luna implementation session was not created because the user's
condition was to dispatch only if the retirement design missed nothing.
