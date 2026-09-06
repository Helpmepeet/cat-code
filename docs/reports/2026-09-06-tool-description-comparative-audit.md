# Tool descriptions: comparative audit of the emitted GPT surface

> **Superseded for conclusions.** Read [2026-09-06-instruction-stack-decisions.md](2026-09-06-instruction-stack-decisions.md) for where this work landed. This file is kept as the evidence record; some of its conclusions were later reversed.

Date: 2026-09-06

Status: Recommendations only. No source, prompt, existing report, or plan changed. The report is ready for installation and an explicit-path commit on the operator's current branch; that commit has not been executed from this read-only connection.

## Verification pass (main session, 2026-09-06)

Checked against HEAD `0c09bbbb` before this report was installed.

- **D1 confirmed, and already in flight.** At HEAD, `FileWriteTool/prompt.ts`
  hardcodes `Edit` twice, while `tools.ts` `getProviderFileEditTool()` returns
  `FilePatchTool` on the OpenAI path. So the GPT pool really is told to prefer a
  tool it does not expose. **But another session is mid-fix:** the working-tree
  copy of that file already parameterises `editToolName`. Do not edit it. One
  observation for whoever owns that change: it selects the patch tool from an
  `ordered` flag rather than from the enabled pool, which is a proxy for the pool
  rather than the pool itself. If the two ever diverge, the defect returns.
- **D2 confirmed.** `TaskGetTool/prompt.ts` says to verify `blockedBy` is empty
  before starting, while `TaskListTool.ts` filters resolved ids out of its own
  `blockedBy`. The two tools therefore report different lists for one task, and a
  completed prerequisite leaves TaskGet's list permanently non-empty. Followed
  literally, the tip blocks a task whose prerequisite has finished.
- **D3 confirmed.** `AgentTool/prompt.ts:417` carries "The agent's outputs should
  generally be trusted", which contradicts the root `CLAUDE.md` statement that a
  subagent's output is the parent's to verify.
- **D4 not verified here.** The result-mapper strings were not re-read in this
  pass; the report's own recommendation is to investigate rather than change, so
  nothing turns on it yet.
- **Measurement difference is explained, not a conflict.** This report's
  45,532/49,637 figures use the dev-full feature union and a 30/33-tool pool; the
  earlier 42,328 figure used the default preset pool at 27 tools. Neither
  supersedes the other, and the report says so.

## Decisions

1. **Change Write's edit-tool reference.** The measured GPT pool exposes `Apply_patch`, while Write directs the model to `Edit`. Keep the complete-read-before-overwrite contract.
2. **Correct TaskGet's dependency guidance.** A measured completed prerequisite remains in TaskGet's `blockedBy`, but is removed from TaskList's view. An empty raw list is not the readiness test. Claude Code carries the same misleading instruction; copying upstream would preserve the defect.
3. **Qualify Agent's trust instruction.** Replace blanket trust with responsibility for checking evidence before reporting consequential actions as completed. Codex explicitly calls for reviewing returned changes; Hermes explicitly distinguishes child self-reports from verified external effects. Do not require repeating every delegated investigation or test.
4. **Investigate, then align Agent's background handoff text.** Its measured result tells the parent to end the turn while its description permits continuing independent work. The text conflict is verified; premature stopping by a real GPT session is suspected, not measured. Preserve automatic notification, cancellation, resumption, and transcript restrictions.

These are correctness and responsibility decisions, not a length ranking. No model-quality improvement is claimed as verified.

## Evidence rules and selection criteria

**Verified-text** means a literal, branch, or schema was inspected at the pinned revision. **Verified-measurement** means the supplied executable collector produced the stated output. Neither label means a GPT model followed the instruction. **Suspected** covers model behavior, expected improvements, unexercised runtime behavior, and unverified deployment selection. Recommendations are judgments resting on those explicitly labeled premises.

A **contract** tells the model something it cannot safely infer from general programming competence or the field's type: accepted patch syntax, path base, destructive effects, full versus partial output, valid lifecycle transitions, capability availability, delivery timing, permission boundaries, or what a successful result establishes. A prerequisite enforced elsewhere still belongs in a tool description when knowing it before the call prevents an invalid action.

**Teaching** explains generic problem-solving or performs an example task without adding a tool-specific constraint: elementary coding demonstrations, exhortations to be thorough, and broad advice about briefing colleagues. Teaching is not automatically wrong or removable. Its benefit requires evidence; length alone supplies none.

**Policy** is a third category, not disguised contract or automatically disposable teaching. Rules about authorized delegation, documentation, or verification may encode operator choices even when the runtime does not enforce them. Preserve a fork-specific policy when a named local requirement justifies it. Do not import another harness's authorization policy merely because it targets GPT.

For each nomination, the checks were: actual GPT emission; session enablement; exact current text; comparable external text; the local implementation or measured output behind the contract; a concrete proposed change; and a separately labeled behavioral hypothesis. Comparator agreement is supporting evidence, never a vote that overrides a measured contradiction. Codex receives the greatest weight for GPT-facing conventions; its API semantics must still match before borrowing wording.

## Scope, provenance, and measurements

**Verified-text.** Cat source was read from the exported HEAD archive, revision `0c09bbbb1290d118e3efd8cfaa66d4196fc3fcc6`, not the operator's dirty `src/`. Root `CLAUDE.md`, the prompt-surface router, both instruction-stack reports, and the apply plan were read. Their base-prompt recommendations are not repeated or reopened here:

- [Subtraction report](2026-09-06-instruction-stack-subtraction.md)
- [Comparative decisions](2026-09-06-instruction-stack-comparative-decisions.md)
- [Existing apply plan](../plans/2026-09-06-instruction-stack-apply-plan.md)

**Verified-text.** The relevant entry is `tool.prompt(...)`, called by `toolToAPISchema` in `src/utils/api.ts`, not the UI-facing `description()` method. Pool selection is in `src/tools.ts`. Source-file totals are not emitted-description totals.

**Operator measurement, not independently reproduced in this exact configuration:** 42,328 characters / 27 tools for the original default GPT pool, versus a 24,680-character system prompt. The 153,641 characters in 40 source files and the stated 28% ratio are source-to-emission context only; they were not used to choose changes. The original measurement is neither replaced nor presented as disproved by the different fixture below.

**Verified-measurement.** The successful collector used Bun 1.4.0 on macOS arm64, the pinned source archive, existing dependencies, OpenAI session selection and `gpt-6-astra`, isolated temporary configuration, no MCP, and the union of `defaultFeatures` and `fullExperimentalFeatures` from `scripts/build.ts` (the dev-full feature set). It called `getTools(getEmptyToolPermissionContext())` and rendered every selected tool through `toolToAPISchema`. The schema cache was cleared between agent-list profiles. It did not send model requests or start actual agents. Dependency fixtures were confined to its temporary task list.

| Session | Enabled tools | Empty agent listing: description characters | Built-in agent listing: description characters |
| --- | ---: | ---: | ---: |
| Noninteractive | 30 | 45,532 | 49,373 |
| Interactive | 33 | 49,637 | 53,478 |

**Verified-measurement.** The built-in listing adds 3,841 characters in each mode. Interactive replaces TodoWrite with TaskCreate, TaskGet, TaskUpdate, and TaskList. The verification build feature is true, while `tengu_hive_evidence` is false in this isolated fixture. Read's selected defaults include `targetedRangeNudge: true` and `maxTokens: 25000`. Thus neither the long Claude TodoWrite example body nor an inactive Read template is grounds for a GPT recommendation.

**Suspected/unresolved.** The exact contribution of revision, build flags, configuration, and listing inputs to the difference from the operator's original 27-tool measurement is not isolated. Do not call the difference a regression or attribute it all to one feature. A desktop session can expose additional tools; these totals are not live-desktop totals. The user's cache-prefix observation remains a constraint: this is context occupancy, not a claim that the whole block is newly billed on each request. Tool-result instructions are dynamic and excluded from these static-description totals.

**Verified-measurement.** Evidence archive `tool-audit-evidence(3).zip` has SHA-256 `2b44ccca953071e218e198082ba29770a375c998b8fa2d312defda476c04f155`. Both runs exit successfully and contain schema JSON. Earlier collector failures produced no valid totals and are excluded.

### External sources

**Verified-text.** Public repository comparisons use pinned checkouts, not README prompt captures:

| Comparator | Pinned source | What was compared |
| --- | --- | --- |
| Codex CLI | `ac192cd7937b0d73edc6dffe009940ae53782dd4` | Tool factories for patch, shell, planning, and both agent API versions; attached grammar |
| Hermes | `245e48008fa814b3251f50755eb656bd9fb86cb1` | File schemas, provider overrides, registration, delegation description |
| OpenClaw | `05bd75f6ff3d6363f2e6f6311c376277141f7632` | Exec/process description builders and capability-dependent session-spawn fields |
| Claude Code | SDK artifact 2.1.87; native artifact 2.1.239 | Readable SDK literals and bounded UTF-8 plus UTF-16LE literal extraction from the newer binary |

**Verified-text.** Claude native binary SHA-256 is `2056a3377b26592760e97e750fe5f373113029038bf8b01a02d9ee75e27d6953`. Native literal presence is not proof of a selected live branch. The two encodings were both searched. The public Claude repository was not used as a source of tool definitions.

**Suspected/unresolved.** The pinned Codex repository is not asserted to equal installed binary 0.153.4 or the operator's current server-selected catalog. This audit uses actual tool factories rather than per-model base text; the local model catalog and stale PATH binary were not used to re-audit the system prompt. Comparator runtime emission and model responses were not executed. Version-dependent alternatives are stated below rather than collapsed into a universal “Codex says.”

## D1. Fix Write's unavailable Edit reference

**Verified-measurement.** Both GPT session modes emit Write constraint 4:

> Before using Write, check whether Edit is the better tool. Prefer Edit for modifying an existing file because it sends only the diff.

Both pools expose `Apply_patch` and omit `Edit`. This is not a recommendation concerning a disabled tool: Write itself is enabled and its mismatched reference is emitted. **Verified-text:** `src/tools.ts`, `getProviderFileEditTool`, selects FilePatchTool for OpenAI and FileEditTool otherwise. The reference lives in `src/tools/FileWriteTool/prompt.ts`.

**Verified-text, comparator evidence.** Codex names the available `apply_patch` tool in its actual [patch factory](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/apply_patch_spec.rs). Hermes's [file schemas and `_patch_schema_overrides`](https://github.com/NousResearch/hermes-agent/blob/245e48008fa814b3251f50755eb656bd9fb86cb1/tools/file_tools.py) advertise V4A mode only on the OpenAI-family path. OpenClaw's [exec builder](https://github.com/openclaw/openclaw/blob/05bd75f6ff3d6363f2e6f6311c376277141f7632/src/agents/bash-tools.descriptions.ts) mentions background/process continuation conditionally on `hasProcessTool`. These are concrete examples of matching instruction vocabulary to available capability. Claude's Edit-oriented Write wording is reasonable evidence of ancestry, not justification for retaining an unavailable name in this fork.

**Decision:** on the measured GPT path, use “Use Apply_patch for partial changes to existing files. Use Write for new files or complete replacements.” More generally, resolve the edit-tool reference from the enabled pool, with neutral wording if no edit tool is exposed. Preserve the exact spelling of the actual API name, including its case; do not substitute Codex's lowercase spelling into this fork.

**Keep:** overwrite disclosure; a complete, untruncated Read without offset or limit before overwriting an existing file; refusal to treat a partial read as authorization; the fallback to targeted editing when the complete file cannot be read. Those are operational contracts, not generic coding instruction. Do not import another harness's weaker overwrite prerequisite.

**Suspected:** this reduces attempts to call an unavailable tool or unnecessary full-file writes. No model rollout measured either failure rate. The existing documentation/emoji restrictions are policy and outside this defect fix.

## D2. Describe unresolved prerequisites, not an empty raw blockedBy

**Verified-measurement.** TaskGet is interactive-only in this fixture. Its emitted tip says:

> After fetching a task, verify its blockedBy list is empty before beginning work.

The collector created prerequisite task 1 and dependent task 2, added the dependency, and marked task 1 completed through the repository's task functions. Calling the actual tools then yielded:

| Tool | Task 2 status | Task 2 blockedBy |
| --- | --- | --- |
| TaskGet | pending | `["1"]` |
| TaskList | pending | `[]` |

**Verified-text.** `src/tools/TaskGetTool/TaskGetTool.ts` returns the stored edges. `src/tools/TaskListTool/TaskListTool.ts` filters completed tasks from them. `src/utils/tasks.ts`, `updateTask` / `updateTaskUnsafe`, preserves dependency edges on status completion; `claimTask` evaluates open prerequisites. The observed discrepancy is therefore explained by the implementation, not a malformed schema or an assumed model response.

**Verified-text, comparator evidence.** Claude SDK 2.1.87 contains the same quoted tip. The newer native artifact also contains it (UTF-8 byte offset 297149626; another literal-table occurrence at 75240236). Agreement across both Claude artifacts argues against calling this fork-specific, but does not invalidate the fixture. Codex's [plan description](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/plan_spec.rs) specifies an at-most-one-in-progress invariant for its plan array. It has no corresponding dependency-edge contract in that tool. Do not transplant that invariant into Cat's V2 task graph or treat the tools as interchangeable.

**Decision:** replace the tip with “Before starting, check that every prerequisite is completed. TaskGet's blockedBy contains dependency IDs, including completed prerequisites; TaskList omits completed prerequisites from its blockedBy summary.” Adjust the Output explanation to identify dependency IDs rather than imply every returned ID is currently blocking.

This is a description correction. Changing TaskGet to filter edges would be a separate API behavior decision, not something silently included in this audit.

**Suspected:** the correction prevents false blocking after prerequisites finish. No GPT task execution measured that downstream effect. Edge cases involving missing tasks or internal metadata were not exercised and are not covered by this proposed readiness statement.

## D3. Replace blanket Agent trust with scoped evidence responsibility

**Verified-measurement.** Agent is enabled in both modes and emits:

> The agent's outputs should generally be trusted.

**Verified-text.** The statement appears in `src/tools/AgentTool/prompt.ts`; it also appears in the older Claude SDK artifact. Cat's root `CLAUDE.md` says a subagent's output is the parent’s responsibility to verify. This supports a local distinction between using delegated analysis and asserting successful actions.

**Verified-text, comparator evidence.** Codex's [V1 agent description](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) calls for quickly reviewing returned changes before integration. Its V2 description instead emphasizes a bounded independent task and final-result delivery; do not claim the V1 review wording appears in every Codex configuration. Hermes's [delegation description](https://github.com/NousResearch/hermes-agent/blob/245e48008fa814b3251f50755eb656bd9fb86cb1/tools/delegate_tool.py) explicitly treats child summaries as self-reports and requires a verifiable handle plus a check before claiming external side effects succeeded. That addresses a distinction Cat's trust sentence does not make.

**Decision:** replace that sentence with “Use the agent's findings, but review returned changes and supporting evidence before reporting completion. For claimed external actions, obtain a verifiable result such as a URL, ID, or file path and check it before telling the user the action succeeded.” A path's existence alone does not verify its content; the check must support the particular claim.

This is scoped reporting responsibility, not an instruction to repeat delegated work, read every file, rerun every test, or always spawn a verification agent. Keep the fork's returned-ID, TaskStop, ResumeAgent, SendMessage, worktree, and automatic-notification instructions: those explain APIs a model cannot infer from the name Agent.

**Suspected:** stronger grounding of completion reports. No comparative rollout or ablation measured that benefit. The exact trust sentence was not found in the bounded newer Claude extraction, but this is not evidence that the newer product has no equivalent trust policy elsewhere.

## D4. Measure the background handoff before changing its policy

**Verified-measurement.** Agent's description permits continuing other work and describes background launches as appropriate for independent parallel work. Calling its real result mapper with synthetic `async_launched` data and `canCheckProgress: true` emits both a non-overlap instruction and:

> For background launches, normally briefly tell the user what you launched, end your response, and yield the turn; the result will arrive via automatic completion notification.

With `canCheckProgress: false`, the emitted result explicitly requires ending the response and generating no other text. These are result-body instructions in `src/tools/AgentTool/AgentTool.tsx`, not prompt-file content. Synthetic mapper execution verifies the strings, not which branch an actual desktop launch chooses.

**Verified-text, comparator evidence.** Codex's same [agent factory](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) pairs delegation with useful independent local work in V2, and explicitly discourages reflexive waiting in V1. Hermes's [background delegation description](https://github.com/NousResearch/hermes-agent/blob/245e48008fa814b3251f50755eb656bd9fb86cb1/tools/delegate_tool.py) directs continuation of other work while results return automatically. OpenClaw's [spawn schema](https://github.com/openclaw/openclaw/blob/05bd75f6ff3d6363f2e6f6311c376277141f7632/src/agents/tools/sessions-spawn-tool.ts) makes completion handoff conditional through `expectsCompletionMessage`; the mere existence of background execution does not establish notification semantics. In the newer Claude binary's readable code near byte 296880917, the ordinary async-result wording permits other work or a response and handles output-file access separately. Other Claude branches still have turn-ending wording; no universal absence is claimed.

**Decision:** retain as a focused follow-up, not an unconditional deletion. If ordinary parallel launches can support continued parent work, make that branch say to continue non-overlapping work and yield when no useful local work remains. Keep any genuinely required handoff-only branch, but explain its scope consistently in the description. Do not remove automatic notification or authorize transcript polling merely because another harness exposes live transcript inspection.

**Suspected:** the current result instruction may terminate useful parent work early. To resolve it, exercise actual foreground/background launches in the intended CLI and desktop configurations and observe both branch selection and subsequent parent behavior. This audit deliberately did not launch agents or spend model quota. No infrastructure limitation requiring universal immediate yield was measured here.

## Contracts to preserve; teaching not promoted into a new cut list

| Surface | Verified evidence and comparison | Decision / uncertainty |
| --- | --- | --- |
| Apply_patch format | Cat emits its patch envelope, headers, prefixes, relative paths, and session/thread path-base rules. `src/utils/api.ts` attaches permissive `start: /(.|\\n)*/`. Codex attaches a real [patch grammar](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/assets/tools/apply_patch.lark) through its factory. | Keep the grammar explanation and examples that resolve actual parse ambiguity. Codex's short prose is not evidence that Cat can discard its prose contract. Path-base semantics were inspected, not exercised with file edits. |
| Read / Write | Measured Read selects targeted-range guidance. Write requires a complete untruncated read before replacement. FileRead results carry partial-view continuation notices. Hermes's [read schema](https://github.com/NousResearch/hermes-agent/blob/245e48008fa814b3251f50755eb656bd9fb86cb1/tools/file_tools.py) also describes bounded output and continuation. | Keep completeness, truncation, and continuation semantics. Do not equate fewer Read calls with safer overwrite authorization. |
| Bash / process control | Cat's measured Bash description carries shell-state and working-directory rules; its edit preference adapts to the enabled editor. OpenClaw's exec/process builder conditions continuation instructions on process-tool availability. | Preserve state, timing, and continuation contracts. A reduced-pool fixture containing only Bash and Read still receives references to unavailable search/write tools; this is a secondary verified-text-in-fixture issue, not evidence that the default pool lacks those tools. Apply D1's capability principle if reduced pools are supported in the target deployment. |
| TaskStop / ResumeAgent / SendMessage | Cat distinguishes stopping, resuming a stopped agent, and queueing a message to a running one. Codex distinguishes V1 close/resume from V2 interrupt/follow-up, with different lifecycle consequences. | Keep explicit lifecycle wording. Never copy Codex's API names or semantics. Newer Claude name-based stopping is not proof Cat's TaskStop accepts names; Cat's validator looks up the task ID. |
| TaskCreate | Measured interactive text includes “demonstrate thoroughness to the user,” plus concrete fields, pending initial status, dependency setup, and duplicate checks. Codex plan text exposes state constraints rather than a demonstration of thoroughness. | The flourish is teaching; the fields and initial state are contract. No model-benefit measurement warrants a separate task-list rewrite here. Do not revive the disabled-interactive TodoWrite example audit as a V2 finding. |
| Skill / plans | GPT Skill emission is 1,318 characters in this fixture; listings and branches matter. EnterPlanMode's tool result also imposes a mode-specific restriction. | Keep invocation/availability and plan-permission contracts. Existing example-removal decisions remain in the prior plan; source line count alone is not an additional finding. |
| Tool-specific and fork-specific tools | GenerateImage, ClaudeCli, orchestrator requests, goals, worktrees, and scheduling occur in this measured pool. Some descriptions live in the tool implementation itself rather than a separate prompt file. | An imperfect comparator mapping is not a reason to cut. Persistent state, destructive cleanup, capability limits, and explicit goal authorization qualify as contracts/policy. This audit makes no unmeasured claim that their wording changes behavior. |

## Instruction text outside prompt files

**Verified-text.** A search across tool implementation files for result mappers, reminders, and imperative strings, followed by inspection of the relevant producers, found more than TodoWrite's known nudge. The table is a positive evidence inventory, not a proof that all possible dynamic instruction text has been counted.

| Producer | Instruction-bearing output | Reachability and measurement limit |
| --- | --- | --- |
| `src/tools/AgentTool/AgentTool.tsx` | Background handoff, non-overlap, TaskOutput use, transcript restrictions | Both synthetic result branches measured; live branch selection unmeasured |
| `src/tools/FileReadTool/FileReadTool.ts` | Partial-view notice, next offset, conditional search-first guidance | Read enabled both modes; result construction source verified, no real read fixture run here |
| `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts` | Read-only plan-mode workflow and file-edit restriction | Tool enabled both modes; interview-feature branch not runtime-measured |
| `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` | Do not implement after failed submission or before leader approval | Tool enabled; teammate/approval branches conditional and not exercised |
| `src/tools/ToolSearchTool/ToolSearchTool.ts` | Retry search when MCP servers are still connecting | Tool enabled; no-MCP fixture does not trigger that branch |
| `src/tools/ScheduleCronTool/CronCreateTool.ts` | Cancellation direction plus actual durability/expiration information | Tool enabled; no job scheduled |
| `src/tools/TodoWriteTool/TodoWriteTool.ts` and `src/tools/TaskUpdateTool/TaskUpdateTool.ts` | Verification-agent directive | Already known to the prior plan; V1 noninteractive / V2 interactive, isolated runtime gate false |
| `src/tools/WebFetchTool/WebFetchTool.ts` | Authentication warning added by `prompt()` outside prompt.ts; redirect-related instructions originate in fetch handling | WebFetch enabled; prefix included in emitted description, network-result branches not exercised |

**Verified-text.** Skill's result mapper can wrap a forked execution result; that text can itself carry delegated content. ToolSearch can return tool references. Consequently, there is no honest single static total for all result instructions without specifying outcomes, payloads, loading state, and branches. The 45,532/49,637 measurements count description fields only; neither a result transcript nor the secondary summarization prompt should be added to them as though it were the same static prefix.

## What the search added beyond the brief

- **Verified-measurement:** a reachable Write description naming an absent editor, not merely duplicated advice.
- **Verified-measurement plus verified-text:** TaskGet's completed-dependency contradiction, including evidence that both Claude artifacts preserve the same instruction.
- **Verified-text:** the grammar-channel difference that makes directly copying Codex's patch-description brevity unsafe.
- **Verified-measurement:** Agent's two contradictory handoff/result branches; **verified-text:** materially different comparator lifecycle wording.
- **Verified-text:** Hermes's explicit self-report/evidence distinction and Codex's scoped review instruction provide a concrete replacement for blanket trust.
- **Verified-text:** additional instruction producers in plan transitions, deferred-tool search, Read continuation, and scheduling. These extend the surface beyond the TodoWrite example without claiming an exhaustive result-text total.

## Validation and remaining limits

**Verified-measurement:** both final collector runs exited 0; 30/33 enabled tools; full schema outputs; synthetic Agent mapper outputs; actual TaskGet/TaskList calls against an isolated two-task fixture. No live model behavioral claims are verified.

**Verified-text:** cited Cat paths refer to the exported revision. Public comparator links are pinned. Claude evidence is versioned and includes native offsets and the binary hash; the binary was not executed.

**Verified-measurement:** running `node scripts/workspaceMapLint.ts` with Node 24.19.0 against the partial exported snapshot returned 86 errors and 7 warnings. Missing unexported app paths account for many errors; an existing map/index date mismatch also appears. This is not a pass, not the required Bun command on the live repository, and not a reason to modify maps or other sessions' files. Bun is unavailable in the analysis workspace. The operator-side documentation gate remains `git diff --check` and `bun run maps:lint`; the new report passed its whitespace check (`git diff --no-index --check /dev/null <report>` emitted no diagnostics; exit 1 denotes the new-file difference). Every cited Cat source path and every pinned comparator file path exists in the inspected snapshots, and comparator HEADs match their linked revisions.

**Suspected/unresolved:** no behavioral ablation, no desktop live pool capture, no exact reproduction of the original 27-tool setup, no proof of installed Codex/server parity, and no live Claude branch trace. These limitations constrain the claims above; they do not erase the measured unavailable-name or dependency contradictions.

**Commit boundary:** only this new report belongs in the commit. Preserve the current branch, all source changes, existing reports/plan, and other staged files. Do not push. Installation and the actual commit require the operator's command runner because My Mac Files exposes read-only tools.
