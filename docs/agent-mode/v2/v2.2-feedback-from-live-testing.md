# Agent Mode v2.2 Feedback (Live Testing)

## Session metadata
- Date: 2026-04-26
- Branch: phase1
- Commit: a2ee68f — feat: complete agent mode v2 branch integration
- Tester goal: Identify behavioral gaps, regressions, and friction points across orchestrator/worker prompt behavior, compaction continuity, subagent runtime truthfulness, and skill-based recovery — to inform v2.2 planning.
- Verification pass: 2026-04-26 — re-checked every claim in this doc against current code on `phase1`. Findings annotated under each issue.

---

## Closure decision

**Agent Mode v2.2 is finished.**

This is the authoritative closure decision for the milestone.

- The user explicitly decided that the reduced v2.2 scope counts as complete.
- This milestone is closed as a prompt-and-UI finish pass.
- Deferred non-goals are intentional and do not keep v2.2 open.
- If asked later whether v2.2 is done, answer **yes** unless the user explicitly reopens the milestone.

---

## What worked well
- [ ] (to be filled during testing)

---

## Issues observed

---

### V22-001 — No visible indicator that a session is in Agent Mode

- **Symptom**: The REPL UI looks identical in agent mode and normal mode. No badge, header label, prompt hint, or color change distinguishes them.
- **Repro steps**: Start an agent-mode session (`CLAUDE_CODE_AGENT_MODE=1`). Compare UI to a normal session — nothing differs.
- **Expected**: Some persistent, unambiguous visual marker that the current session is running under Agent Mode (orchestrator role, worker role, or both).
- **Actual**: `isAgentMode()` is imported in `REPL.tsx:126` but is never called anywhere in the file (verified via grep — zero call sites).
- **Severity**: high
- **Likely layer**: ui
- **Evidence (verified 2026-04-26)**:
  - `src/screens/REPL.tsx:126` — `isAgentMode` imported but never invoked. Other agent-mode gates in the file go through `process.env.CLAUDE_CODE_AGENT_MODE` directly (line 2913) or other module functions (`matchSessionMode`, `getAgentModeUserContext`).
  - `src/screens/REPL.tsx:4770` — only agent-mode-specific UI element is the abort-pending warning (`agentModeAbortPending`), which is a transient state, not a persistent indicator.
  - `src/agent-mode/agentMode.ts` — `isAgentMode()` and `getAgentModeUserContext()` exist and return accurate state.
- **Suggested fix direction**: Add a small persistent indicator (e.g., `[agent]` label or colored prefix in the prompt line or status bar) driven by `isAgentMode()`. Low-risk, purely additive.
- **Fix applied**: `src/screens/REPL.tsx` now renders a stronger `◉ Agent Mode` marker immediately above the prompt input, plus a compact worker-status line in the same input block.

---

### V22-002 — `/resume` session list gives no way to identify which sessions are Agent Mode

- **Symptom**: The `/resume` picker (`ResumeConversation` → `LogSelector`) shows session titles and metadata but no mode indicator. User cannot tell which past sessions were Agent Mode and should be resumed as such.
- **Repro steps**: Run multiple sessions, some normal and some agent-mode. Open `/resume` — session list is visually identical for both types.
- **Expected**: Agent-mode sessions marked with a visible tag/badge (e.g., `[agent]`) in the session list so the user knows (a) which sessions are agent-mode and (b) that resuming them will re-enter agent mode.
- **Actual**: `LogOption.mode` field exists at `src/types/logs.ts:50` and is populated from the JSONL `{"type":"mode"}` record (`src/utils/sessionStorage.ts:842`). It is read in only two places repository-wide — `sessionStorage.ts:3045` (carry-through during log enumeration) and `REPL.tsx:1839` (`matchSessionMode` mismatch warning) — and never for display.
  - `src/components/LogSelector.tsx:110–128` — `buildLogLabel` ignores `log.mode` entirely.
  - `src/components/LogSelector.tsx:129–142` — `buildLogMetadata` also ignores `log.mode`.
- **Severity**: high
- **Likely layer**: ui
- **Evidence (verified 2026-04-26)**:
  - `src/types/logs.ts:50` — `mode?: 'agent' | 'coordinator' | 'normal'` exists on `LogOption` (note: doc previously said line 50, confirmed unchanged).
  - `src/utils/sessionStorage.ts:840–846` — mode is written to JSONL on session creation.
  - `src/components/LogSelector.tsx:110–142` — label and metadata builders never read `log.mode`. `grep -rn 'log\.mode' src/` returns only the two non-display sites above.
- **Suggested fix direction**: In `buildLogLabel` or `buildLogMetadata`, append a short suffix (e.g., ` [agent]`) when `log.mode === 'agent'`. No new data plumbing needed — the field is already present.
- **Fix applied**: `src/components/LogSelector.tsx` now appends ` [agent]` to agent-mode session labels and subtracts that suffix from the existing width budget before truncating titles.

---

---

### V22-003 — Orchestrator does its own reads/searches instead of dispatching to Explore agent

- **Symptom**: Orchestrator reads files and runs searches directly, pulling raw file content into its own context. This bloats orchestrator context with implementation detail it should never carry.
- **Repro steps**: Give the orchestrator a task that requires understanding an unfamiliar file or subsystem. Observe it reading files directly rather than dispatching an Explore worker to summarize and return findings.
- **Expected**: Orchestrator delegates all non-trivial exploration (file reads beyond a quick path check, broad grep/search, subsystem understanding) to the Explore agent and receives a compact summary back. Orchestrator context stays decision-focused.
- **Actual**: Orchestrator prompt (`src/agent-mode/orchestratorPrompt.ts:25`) says "Use shallow reads yourself when they are enough" and "Delegate broad exploration" — but never names the Explore agent, never sets a threshold for what counts as "shallow enough," and never makes Explore the default for codebase questions. The Explore agent's `whenToUse` description (`src/tools/AgentTool/built-in/exploreAgent.ts:94–95`) is written for human users via the Agent tool, not as orchestrator doctrine.
- **Severity**: high
- **Likely layer**: prompt
- **Evidence (verified 2026-04-26)**:
  - `src/agent-mode/orchestratorPrompt.ts:25` — line still reads verbatim: `"Use shallow reads yourself when they are enough to frame the next decision. Delegate broad exploration, implementation batches, and non-trivial verification."` Explore agent is not named anywhere in the prompt.
  - `src/tools/AgentTool/built-in/exploreAgent.ts:94–95` — Explore's `whenToUse` is accurate but not referenced in orchestrator doctrine.
  - Orchestrator prompt has no affordance that steers toward Explore as the default for codebase exploration questions.
- **Suggested fix direction**: Add an explicit rule in the orchestrator prompt's delegation section naming the Explore agent and defining the threshold: any question about codebase structure, file contents, symbol locations, or subsystem behavior should go to Explore rather than direct reads. "Shallow reads" should be limited to: confirming a known path exists, reading a single short config file when you already know exactly what you need. Anything requiring search, multi-file reading, or understanding should be Explore.
- **Fix applied**: `src/agent-mode/orchestratorPrompt.ts` now names the Explore agent as the default for codebase questions and narrows direct reads to explicit exceptions.

---

---

### V22-004 — Brief format too rigid for lightweight exploration tasks

- **Symptom**: The orchestrator brief template requires "done condition with executable evidence" and a structured return format. This is appropriate for coding workers but ill-suited for open-ended Explore tasks where the output is naturally freeform and there is no executable check.
- **Expected**: Orchestrator uses a lighter brief shape for Explore — just the question, scope, and thoroughness level. Structured fields reserved for coding/verifier workers.
- **Actual**: `orchestratorPrompt.ts:29` — single brief format applied to all worker types. No distinction between exploration briefs and implementation briefs. (Doc previously cited line 30; the actual line is 29 in the current file — one-off due to header counting. Substance verified.)
- **Severity**: low
- **Likely layer**: prompt
- **Evidence (verified 2026-04-26)**: `src/agent-mode/orchestratorPrompt.ts:29` — `"Keep fresh briefs compact but complete: role, one-sentence objective, scope and write boundaries, required context, constraints, done condition with executable evidence, and return format."` Single shape for all worker types.
- **Suggested fix direction**: Add a one-line note that Explore briefs are lighter — question, scope, thoroughness level. The done condition for Explore is simply "findings returned." Full brief skeleton applies to coding workers and verifiers only.
- **Fix applied**: `src/agent-mode/orchestratorPrompt.ts` now carves out a lighter but still structured Explore brief shape — `question | scope | thoroughness | constraints/exclusions | return shape` — while keeping the full brief skeleton for coding workers and verifiers.

---

---

### V22-005 — Orchestrator direct-read rule is unstable under "trivial edit" framing

- **Symptom**: The threshold "small file + trivial edit → do it yourself" is circular — you cannot know if an edit is trivial before reading, and once you have the file content you tend to pull in dependencies.
- **Expected**: Explore-first is the default, not a fallback. Direct reads are the explicit exception.
- **Actual**: V22-003 changed the prompt to Explore-first with narrow direct-read exceptions, but this failure mode is still worth watching under multi-step pressure. The model may still rationalize exceptions ("just one file", "this is obvious") even with the improved wording.
- **Severity**: medium
- **Likely layer**: prompt
- **Evidence (verified 2026-04-26)**: Design analysis from smarter model — "trivial edit" threshold fails because: (a) you can't classify before reading, (b) small reads chain into dependency reads, (c) prompt rules degrade under multi-step pressure. Full Design 2 (capability boundary) is out of scope for v2.2 but the prompt should be written as if that is the intent. Premise still holds because V22-003 has not been fixed.
- **Suggested fix direction**: Reframe the delegation rule from threshold-based ("if large file...") to default-based ("delegate to Explore unless..."). The exception list should be narrow and explicit: single known config file, path existence check, file you just wrote yourself this turn.

---

## Candidate v2.2 changes
- (to be prioritized after issues are observed)

---

## Open questions

1. **Reading before editing** — decided. The intended pattern is a strict coordinator/worker split: the orchestrator stays high-level, Explore maps code and returns findings, and a coding worker reads exact file content when it is time to edit.

2. **Explore brief format** — decided. Explore briefs should stay lighter than coding-worker briefs, but still be structured for robustness: `question | scope | thoroughness | constraints/exclusions | return shape`.

3. **Prompt-only degradation under pressure** — accepted as a known limitation for v2.2. Design 2 (capability boundary) remains the right long-term fix, but is out of scope for this milestone.

---

## Other issues

---

### V22-007 — Orchestrator abandons active task when user sends conversational side question

- **Symptom**: Orchestrator dispatches a subagent for a task, user sends an unrelated side question, orchestrator answers the side question and never returns to synthesize the subagent result or complete the original task.
- **Repro steps**: In agent mode, give the orchestrator a task that spawns a subagent. While it is running or after it completes, ask a meta or conversational question (e.g. "are you still in agent mode?"). Observe that the orchestrator fully pivots to the side question and the original task objective is dropped.
- **Expected**: Orchestrator answers the side question briefly then steers back to the active task. The main objective is preserved across conversational interruptions.
- **Actual**: Session `f0f28d92` — orchestrator spawned Explore subagent "Map agent-mode UI surfaces", subagent completed. User asked "check the system instruction again, are you still in agent mode?" Orchestrator spent the entire next turn on mode/state discussion and never synthesized the subagent findings. When user explicitly asked about the UX/UI result, orchestrator spawned a second redundant Explore instead of using the first result.
- **Severity**: high
- **Likely layer**: prompt (orchestrator task-holding behavior)
- **Evidence (from session log; not re-verified at code level on 2026-04-26 because the JSONL file was not re-inspected this pass)**:
  - `subagent-terminal` for `adbdeab09cc938cd2`: completed at `08:23:13`
  - Orchestrator next response: entirely about agent mode / plan mode state, no mention of subagent findings
  - Second Explore `a9f950e38c6dab978` spawned for same task at `08:25:21`
  - Model self-assessment (when asked): "I let meta-conversation displace the actual work. I should have answered briefly then steered back."
- **Note**: JSONL message chain inspected — no duplicate user messages at storage level. However, deeper investigation needed: the assembled prompt sent to the API was not inspected. Injection could still occur at tool-result interleaving or system-reminder injection layer. Do not rule out runtime bug until the actual API payload is examined.
- **Suggested fix direction**: Add explicit orchestrator doctrine: when an active task is in progress (subagent dispatched, result pending, or synthesis pending), treat user side questions as brief interruptions — answer in one sentence and return to the task. Do not let conversational drift displace active work.
- **Fix applied**: `src/agent-mode/orchestratorPrompt.ts` now tells the orchestrator to keep active tasks primary across user messages, answer side questions in one sentence, and return to pending synthesis.

---

### V22-008 — Redundant subagent spawn after valid result already returned

- **Symptom**: Orchestrator spawns a second subagent for a task that a prior subagent already completed successfully.
- **Repro steps**: Follows from V22-007 — because the orchestrator lost track of the active task, when prompted it spawned a new Explore rather than using the existing result.
- **Expected**: Orchestrator tracks which subagents have completed and uses their results before spawning again for the same objective.
- **Actual**: First Explore completed with a full UI surface map. Orchestrator spawned a second Explore ("Inspect agent-mode UX/UI") for effectively the same task.
- **Severity**: medium
- **Likely layer**: prompt (orchestrator task-state tracking)
- **Evidence**: `subagent-spawned` records for `adbdeab09cc938cd2` (completed) and `a9f950e38c6dab978` (killed by user) in session `f0f28d92`.
- **Suggested fix direction**: Related to V22-007. If the orchestrator holds the task objective across turns, it will naturally check what it already has before spawning. No separate fix needed if V22-007 is addressed.
- **Fix applied**: `src/agent-mode/orchestratorPrompt.ts` now tells the orchestrator to check whether a recent completed subagent result already covers the objective before spawning again.

---

### V22-009 — (Previously V22-007, renumbered) Subagent result handling under concurrent user message

- **Symptom**: Orchestrator spawns a subagent, user sends a message while subagent is running, subagent completes, but its result is never synthesized — orchestrator answers the user message instead and the subagent findings are lost.
- **Repro steps**: In agent mode, trigger an Explore subagent dispatch. While the subagent is running, send a new user message. Observe that the orchestrator responds to the user message and ignores the subagent result entirely. Orchestrator may then re-spawn the same subagent when asked about the result.
- **Expected**: Subagent result is delivered to the orchestrator and synthesized. If a user message arrived during execution, the orchestrator should handle both — either queue the user message until the subagent result is processed, or acknowledge the result before moving on.
- **Actual**: Session `f0f28d92`: Explore agent `adbdeab09cc938cd2` completed at `08:23:13` after 77s. User message "check the system instruction again" had already been submitted. Orchestrator answered that message and the Explore findings were never surfaced. When user then asked "the UX/UI subagent spawn" (enqueued at `08:24:45`), orchestrator spawned a second Explore for the same task.
- **Severity**: high (behavior) / **revised layer**: prompt (not runtime)
- **Likely layer**: ~~runtime~~ → **prompt** (revised after 2026-04-26 code trace)
- **Evidence**:
  - `subagent-terminal` for `adbdeab09cc938cd2`: `status: completed`, `endedAt: 08:23:13`
  - `queue-operation enqueue` for user message: `08:24:45` — 92 seconds after subagent completed
  - Orchestrator response between those timestamps answered plan-mode state question, no mention of Explore findings
  - Second Explore `a9f950e38c6dab978` spawned at `08:25:21` for the same task, then killed by user
- **Runtime investigation (2026-04-26 — followup pass)**: Traced the subagent-result delivery path end-to-end. The runtime does **not** drop tool_results.
  - `src/tools/AgentTool/AgentTool.tsx:1390–1399` — sync subagent (Explore on this path) returns `{ data: { status: 'completed', ... } }` to the tool runner.
  - `src/tools/AgentTool/AgentTool.tsx:1436–1518` — `mapToolResultToToolResultBlockParam` produces a proper `tool_result` block (with the Explore findings as content) keyed to the orchestrator's `tool_use_id`.
  - `src/query.ts:1419–1447` — `runTools`/`StreamingToolExecutor` pushes that `tool_result` onto `toolResults` synchronously inside the same query iteration; nothing dequeues from the user-message queue until line 1605 below.
  - `src/query.ts:1605–1617` — between tool execution and the next API call, the loop snapshots queued commands at priority `next` (or `later` if the turn ran Sleep). Filter: main-thread (`agentId === undefined`) drains `prompt` and `task-notification` modes; subagents drain only their own task-notifications.
  - `src/utils/attachments.ts:1045–1083` — `getQueuedCommandAttachments` converts those queued user messages into `queued_command` attachment objects.
  - `src/query.ts:1619–1681` — those attachments are appended onto `toolResults` AFTER the real tool_result, then `removeFromQueue` clears them from the queue.
  - `src/query.ts:1753–1766` — recursion fires with `messages: [...messagesForQuery, ...assistantMessages, ...toolResults]`. Net: the orchestrator's next API call sees the Explore tool_result AND the queued user prompt in the same input. There is no path that drops the tool_result; there is no path that swaps it for the user message.
  - `src/hooks/useQueueProcessor.ts:48–60` — between-turn dequeues are gated on `!isQueryActive`. While the orchestrator's recursive query is running, the queue is read mid-turn (above) but never drained outside that path. So a "concurrent" user message becomes a same-turn attachment, not a separate query.
- **Reinterpreted root cause**: The orchestrator received both the tool_result (Explore findings) and the queued user prompt as input to its next API call. It chose to address the user prompt and ignore the tool_result content. That is a doctrine/prompt failure, not a delivery failure. V22-009 collapses into V22-007.
- **Suggested fix direction (revised)**: Drop the runtime/buffer hypothesis. The fix is the same one V22-007 already proposes: orchestrator doctrine that an active task (subagent dispatched, result pending in this turn's input, or synthesis pending) takes precedence over a conversational side question. Treat the side question as a brief interruption — answer in one sentence and return to synthesizing the tool_result.
- **Caveat**: I have not inspected the actual API request payload sent to the model for the failing turn. Code analysis says the tool_result block was present in `messages`. If a payload-level inspection ever shows it missing, that would reopen the runtime hypothesis. Until then, treat as prompt-layer.
- **Fix applied**: `src/agent-mode/orchestratorPrompt.ts` now treats result-pending and synthesis-pending work as the primary objective across user interruptions, so the orchestrator should synthesize the existing tool_result before drifting to side conversation.

---

### V22-006 — Thinking blocks not displayed for GPT-5.4 and GPT-5.3

- **Symptom**: Thinking blocks are visible when using GPT-5.5 but absent on GPT-5.4 and GPT-5.3.
- **Expected**: Thinking blocks display consistently across supported OpenAI models.
- **Actual**: GPT-5.5 works, lower models do not.
- **Severity**: low
- **Likely layer**: runtime (thinking block extraction/rendering)
- **Code-level verification (2026-04-26)**: The premise is questionable. The Codex fetch adapter handles all GPT models through the same path:
  - `src/services/api/codex-fetch-adapter.ts:720–723` — `response.output_item.added` items of `type === 'reasoning'` are explicitly **ignored** (no synthetic thinking block emitted from the live reasoning item).
  - `src/services/api/codex-fetch-adapter.ts:819–822` — `response.reasoning.delta` events are explicitly **discarded** with the comment "GPT reasoning is provider-managed state. Do not adapt it into Anthropic-style visible thinking transcript blocks."
  - `src/services/api/codex-fetch-adapter.ts:886–938` — The only thinking block emitted is a synthetic round-trip carrier with `thinking: ''` (empty) and the encrypted reasoning blob smuggled through `signature`. It is intentionally hidden by `Message.tsx:540` and `AssistantThinkingMessage.tsx:33–35` (returns `null` when `thinking` is empty).
  - Net result expected from code: **no visible thinking transcript content for any GPT/Codex model**, only the "∴ Thinking" placeholder spinner if anything at all.
- **Possible explanations for what was actually observed**:
  1. The "thinking" the tester saw on GPT-5.5 may be the spinner shimmer / status line text, not a transcript block.
  2. There may be another rendering path (e.g. a streaming side-channel) that handles GPT-5.5 differently from 5.4/5.3 — not found during this verification pass but worth a closer look.
  3. The GPT-5.5 server response may include a `summary_text` field or surface reasoning content in `output_text.delta` while older models do not, which would bypass the discarding branch above. Not observed in current adapter code.
- **Suggested next step**: Re-confirm the observation with concrete screenshots from each model, then search for model-version branching outside `codex-fetch-adapter.ts` (e.g. in shimmer/spinner code or in any GPT-5.5-specific render path). If the symptom holds, the fix is likely model-name gating on whatever path is currently emitting visible reasoning for 5.5 — not a missing case for 5.4/5.3.

---

## UI/UX issues

*Core finding: Agent Mode has no coherent terminal identity as a multi-agent job. UI surfaces exist but are fragmented across status line, transcript events, task list, notifications, and teammate/background views. The user has to reconstruct state manually.*

*Source: Explore subagent "Map agent-mode UI surfaces" from session f0f28d92. Spot-checked against current code on 2026-04-26 — the structural observations below all match what is currently in the tree.*

---

### V22-U01 — No persistent Agent Mode identity in the REPL (expands V22-001)

- **Relevant files**: `src/components/StatusLine.tsx`, `src/screens/REPL.tsx`
- **Gap**: The REPL mounts StatusLine, Notifications, CancelRequestHandler, TaskListV2, SessionBackgroundHint — but Agent Mode is not a first-class built-in state indicator. The status line is configurable and can show model/cwd/tokens/permissions/worktree, but mode is absent. Entering Agent Mode is not visually durable — mode is hidden unless a custom status-line config exposes it.
- **Verification (2026-04-26)**: `src/components/StatusLine.tsx:109–113` exposes `agent.name` (subagent type) but not session mode. No `agentMode`/`isAgentMode` reference exists in the StatusLine input shape. Confirmed.
- **Decision (2026-04-26)**: A status-line level solution is not required for v2.2. A stronger prompt-area marker is enough if it is unmistakable.
- **Fix applied**: `src/screens/REPL.tsx` now replaces the dim `[agent]` text with a stronger `◉ Agent Mode` marker directly above the input, plus a compact worker-status line in the same input block.

---

### V22-U02 — No mode badge in /resume session picker (expands V22-002)

- **Relevant files**: `src/components/LogSelector.tsx`, `src/utils/format.ts`, `src/screens/ResumeConversation.tsx`, `src/commands/resume/resume.tsx`
- **Gap**: `/resume` labels and metadata include title, relative time, branch, message count, file size, tags, agent setting, PR metadata — but not session mode. Agent Mode sessions and normal sessions look identical in the picker. Mode metadata exists in the JSONL but is never surfaced.
- **Verification (2026-04-26)**: Confirmed same as V22-002 — `log.mode` is read only by `matchSessionMode` warning logic, never by display builders.

---

### V22-U03 — No unified workers dashboard

- **Relevant files**: `src/tools/AgentTool/UI.tsx`, `src/components/TaskListV2.tsx`, `src/tasks/LocalAgentTask/LocalAgentTask.tsx`, `src/components/PromptInput/Notifications.tsx`
- **Gap**: Progress state (Initializing, In progress, Done, Completed with error) exists. TaskListV2 shows persistent task state. Background agent notifications include task id, status, summary, usage, worktree, output file. But there is no unified view of "what the orchestrator is doing, what workers exist, and which are healthy." State is split across transcript, task list, footer notifications, and worker-specific surfaces. User must reconstruct the full picture manually.
- **Verification (2026-04-26)**: Not exhaustively re-verified file by file this pass; structural claim matches the codebase layout. Treat as needing a focused UI/UX review pass before scoping a fix.
- **Decision (2026-04-26)**: Do not build a full dashboard in v2.2. A compact unified worker summary in the prompt/input area is enough.
- **Fix applied**: `src/screens/REPL.tsx` now shows a compact worker summary directly above the input while Agent Mode is active (`active`, `queued`, `done`, `attention`), giving a single job-control glance point without adding a new screen.

---

### V22-U04 — Interruption semantics not discoverable

- **Relevant files**: `src/hooks/useCancelRequest.ts`, `src/hooks/useBackgroundTaskNavigation.ts`, `src/tasks/LocalAgentTask/LocalAgentTask.tsx`, `src/components/SessionBackgroundHint.tsx`
- **Gap**: Cancellation behavior is context-dependent. Esc cancels current foreground request. Ctrl+C interrupts current request. Teammate/background views have extra behaviors (kill selected agent, kill all, navigate, open transcript). Ctrl+B backgrounds foreground tasks. User cannot tell whether they are stopping: current orchestrator action, current worker action, a selected worker, or all workers. None of this is discoverable from the UI.
- **Verification (2026-04-26)**: Not exhaustively re-verified at file level. Behavior pattern matches current code; treat as observation requiring a separate cancellation-UX audit.
- **Decision (2026-04-26)**: Out of scope for v2.2. Current interruption behavior is acceptable for this personal-project milestone.

---

### V22-U05 — No unified job-completion or error-ownership surface

- **Relevant files**: `src/tools/AgentTool/UI.tsx`, `src/components/PromptInput/Notifications.tsx`, `src/screens/ResumeConversation.tsx`, `src/commands/resume/resume.tsx`
- **Gap**: Worker-level completion and error messages exist (Done, Completed with error, Backgrounded agent). Resume flow has loading/failure messaging. Footer notifications handle some error visibility. But there is no single "overall orchestrated job is complete / blocked / partially failed" surface. Error ownership is diffuse — the user sees worker completions but not a strong overall job-state signal.
- **Verification (2026-04-26)**: Not exhaustively re-verified at file level; consistent with the surface inventory in V22-U03.
- **Decision (2026-04-26)**: Do not add a top-level overall-job state surface in v2.2.

---

## Verification summary (2026-04-26)

| Issue   | Code-level claim verified? | Notes |
|---------|----------------------------|-------|
| V22-001 | Fixed | `src/screens/REPL.tsx` now shows a stronger `◉ Agent Mode` marker plus a compact worker summary directly above the prompt input. |
| V22-002 | Fixed | `src/components/LogSelector.tsx` now appends ` [agent]` to agent-mode session labels and budgets width for the suffix before truncation. |
| V22-003 | Fixed | `src/agent-mode/orchestratorPrompt.ts` now makes the Explore agent the default for codebase questions and narrows direct reads to explicit exceptions. |
| V22-004 | Fixed | `src/agent-mode/orchestratorPrompt.ts` now gives Explore a lighter but still structured brief shape and reserves the full brief skeleton for coding workers and verifiers. |
| V22-005 | Closed by doctrine | V22-003 fix landed. Treat Explore-first with narrow exceptions as the current rule; reopen only if live behavior still rationalizes direct reads. |
| V22-006 | Premise contradicted by code | Codex adapter discards reasoning content and only emits empty thinking blocks (signature carrier) for **all** GPT models. Re-confirm the live observation before treating this as a runtime bug. |
| V22-007 | Fixed | `src/agent-mode/orchestratorPrompt.ts` now tells the orchestrator to keep active tasks primary across user messages and return to pending synthesis after a one-sentence side-answer. |
| V22-008 | Fixed | `src/agent-mode/orchestratorPrompt.ts` now tells the orchestrator to reuse a recent completed subagent result before spawning again for the same objective. |
| V22-009 | Fixed | `src/agent-mode/orchestratorPrompt.ts` now treats result-pending and synthesis-pending work as primary across user interruptions, matching the prompt-layer root cause identified in the code trace. |
| V22-U01 | Fixed | `src/screens/REPL.tsx` now shows a stronger `◉ Agent Mode` marker plus a compact worker summary in the input area. |
| V22-U02 | Yes (same as V22-002) | |
| V22-U03 | Fixed at v2.2 scope | No full dashboard added; prompt area now provides a compact unified worker summary, which is sufficient for this milestone. |
| V22-U04 | Deferred by decision | Current interruption UX is acceptable for this personal-project milestone. |
| V22-U05 | Closed by decision | No top-level overall job-state surface is wanted for v2.2. |

---

## Out of scope / do not do
- No broad refactors.
- No speculative feature work.
- No hidden "cleanup" not tied to observed testing evidence.
