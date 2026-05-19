# Separate Subagent Resume From SendMessage Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Caveat:** This plan rewrites prompts the implementing sub-skill may itself read. If the survey in Task 0 surfaces hits inside the skill's own prompts, update them as part of Task 7; do not silently rely on the old pattern.

**Goal:** Stop overloading `SendMessage` to do two unrelated things. Today it (a) queues messages to running subagents and (b) auto-resumes stopped subagents as a side effect — including reloading transcripts, reconstructing system prompts, and spinning up agent processes — while presenting itself as a delivery primitive. Introduce a dedicated `ResumeAgent` tool that owns subagent resume end-to-end. Reduce `SendMessage` to a delivery primitive that targets only currently-running recipients. Migrate all *shipped* prompts that teach the old pattern in the same change.

**Why:** The auto-resume side effect is the root cause of (i) the ugly tool-result string the user originally complained about (raw IDs, tmp paths, false notification promises), (ii) model confusion about which operation it is performing, and (iii) accumulating prompt debt that teaches the conflation across coordinator mode, agent mode, the Agent tool description, and built-in agent definitions. The wording fix already merged is a patch; the real fix is the API split. This plan does that split, and migrates the live shipped prompts that teach the conflation so the model is taught the new boundary from day one.

**Architecture:**

- New `ResumeAgentTool` at `src/tools/ResumeAgentTool/` is the model-facing surface for resume. It owns target resolution (registered alias, durable cross-session handle, raw `createAgentId`), task-status checking, the four error paths, and delegates to `resumeAgentBackground` for the actual resume.
- `resumeAgentBackground` at `src/tools/AgentTool/resumeAgent.ts` is the internal primitive. **It is not a pure "resume from spawn metadata" function** — it depends on the caller's live `ToolUseContext` for current app state (line 66), the current set of agent definitions (line 121), the current tool pool (line 178), and, for forks, the caller's rendered system prompt (line 134). This plan does not refactor that primitive; it documents the dependency and matches it in the new tool's setup.
- `SendMessageTool` keeps the running-target queueing path. Its auto-resume branches are deleted. When the target resolves to a stopped or evicted subagent, it emits a structured error pointing at `ResumeAgent` with the literal call shape.
- REPL user-driven resume at `src/screens/REPL.tsx:3986` is the only non-model entry point that calls `resumeAgentBackground`. It stays. Principle: `ResumeAgentTool` is the **model-facing** surface; `resumeAgentBackground` is the **internal primitive** that REPL also uses.
- Shipped prompts that teach SendMessage-as-continuation are rewritten in this same change. The migration is part of the plan, not a follow-up.

This plan ships async-only. The follow-up plan (`2026-05-12-sync-resume-subagent-plan.md`) adds a `run_in_background: false` mode by extending this tool.

**Tech Stack:** TypeScript, existing AgentTool runtime, Bun test.

---

## Prerequisites

- The SendMessage resume message cleanup is merged (the wording `Resumed "${result.description}" in the background.` at `SendMessageTool.ts:877` and `:905`). Those branches are removed in this plan.
- This plan ships **before** the sync-resume plan. The sync plan layers on top by adding a flag to the tool introduced here.

---

## Migration Surface

Surface verified at plan time. Task 0 confirms completeness and extends if needed.

### Code paths that change in this plan

- `src/tools/SendMessageTool/SendMessageTool.ts:838` — comment "Stopped agents are auto-resumed" (rewrite).
- `src/tools/SendMessageTool/SendMessageTool.ts:843–847` — durable handle resolution via `resolveWorkerAgentTarget`. **Logic extracted** into a shared `resolveAgentTarget` helper used by both tools.
- `src/tools/SendMessageTool/SendMessageTool.ts:851–862` — running-target queueing. **Unchanged.** SendMessage keeps this.
- `src/tools/SendMessageTool/SendMessageTool.ts:864–916` — the two auto-resume branches. **Removed**; replaced with a single structured error.
- `src/tools/AgentTool/AgentTool.tsx:1812` — async spawn continuation hint (rewrite).
- `src/tools/AgentTool/AgentTool.tsx:1850` — sync spawn continuation trailer (rewrite).
- `src/tools/AgentTool/prompt.ts:300`, `:323`, `:391` — Agent tool description teaches SendMessage-as-continuation (rewrite all three).
- `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts:134` — built-in agent's `whenToUse` teaches the old pattern (rewrite).
- `src/agent-mode/agentMode.ts:77` — orchestrator routing hint (rewrite).
- `src/coordinator/coordinatorMode.ts` — **the live coordinator system prompt teaches SendMessage-as-continuation in thirteen distinct places.** Sites: `:131`, `:139`, `:165`, `:191`, `:233`, `:238`, `:249`, `:254`, `:287`, `:298`, `:301`, `:306`, `:361`. All thirteen rewrite to teach the new boundary in Task 6 — see that task for the per-line rewrite text. This is the highest-blast-radius migration in the plan. (Initial plan revision listed six; second-pass review surfaced the additional seven inside the "Continue vs spawn" decision table, continue-mechanics worked examples, and the example session. Task 0's survey re-verifies before Task 4 ships.)
- `src/tools/SendMessageTool/prompt.ts` — tool description (tighten to running-only).
- `src/screens/REPL.tsx:3986` — REPL user-driven resume. **No change.** Calls `resumeAgentBackground` directly as an internal primitive.

### Code paths that stay

- `resumeAgentBackground` and its internal helpers: unchanged. The new tool calls it the same way SendMessage does today.
- `LocalAgentTask.queuePendingMessage` / `drainPendingMessages`: unchanged. The key invariant is at `src/utils/task/framework.ts:87`: `registerTask` carries `pendingMessages` forward when a task is replaced during resume. So a message queued via `SendMessage` to a running agent that subsequently stops survives the stop and is drained on the agent's next tool round after `ResumeAgent` runs. This is the behavior the plan preserves (Decision 9 below) and tests for (Task 2).
- All notification machinery: both async paths feed `runAsyncAgentLifecycle` at `resumeAgent.ts:261`, which calls `enqueueAgentNotification` at `agentToolUtils.ts:903 / :964 / :1017 / :1057`. Unchanged.

---

## Design Decisions

### 1. Tool input addressing
`ResumeAgent` accepts `{ agentId: string, prompt: string }`. The `agentId` field accepts the same set of identifiers SendMessage's resume branches accept today, resolved in this order via the shared `resolveAgentTarget` helper:
1. Registered alias via `appState.agentNameRegistry`.
2. Durable worker handle via `resolveWorkerAgentTarget(getSessionId(), input)` — returns `{ agentId, originSessionId }`; `originSessionId` may be a *prior* session, which `resumeAgentBackground` already handles via its `sourceSessionId` parameter at `resumeAgent.ts:73–82`.
3. Raw `createAgentId`-shape ID via `toAgentId(input)` — **only returns non-null if a transcript exists on disk for that ID in the current session**.

**Why the disk-check matters (verified loophole in the prior plan revision):** today at `SendMessageTool.ts:842`, `rawAgentId = toAgentId(input.to)` resolves any string matching the createAgentId regex, unconditionally. Resume then fails inside `resumeAgentBackground` at `resumeAgent.ts:84` ("No transcript found"). Under the new contract, SendMessage emits the "use ResumeAgent" error whenever `resolveAgentTarget` returns non-null AND the target is not running. Without the disk-check, a teammate name that happens to match the createAgentId regex would resolve, trigger the new SendMessage error, and **bypass the teammate-mailbox fallthrough at `SendMessageTool.ts:920`**. Wrong wording, wrong behavior. The disk-check (cheap stat against `getAgentTranscriptPath(agentId)`) is required for `resolveAgentTarget` to honestly mean "this identifier names a resumable subagent."

Implementation note: steps 1 and 2 already imply existence — registry entries and durable handles are only created for real agents. Step 3 needs the explicit transcript stat. The cost is one filesystem stat per SendMessage-to-non-running-target call, which is acceptable.

### 2. Permission scope on resume
**Permissions for the resumed agent are NOT inherited from spawn-time metadata.** `AgentMetadata` at `src/utils/sessionStorage.ts:333` has no `permissionMode` field; `runAgent` does not persist one at `src/tools/AgentTool/runAgent.ts:798`; and `resumeAgentBackground` at `src/tools/AgentTool/resumeAgent.ts:174–177` constructs `workerPermissionContext` from the *current* selected agent definition (`selectedAgent.permissionMode`), which is looked up against the caller's *current* `appState.agentDefinitions` at line 121. The caller's `appState.toolPermissionContext` also flows in at line 71.

**Implication for this plan:** `ResumeAgentTool` must construct and pass a `ToolUseContext` that produces the *same* permission environment SendMessage's resume branches produce today, so resume behavior is unchanged. Concretely: the tool's `call` receives a `ToolUseContext` from the tool runtime; pass that context to `resumeAgentBackground` unmodified. **Do not** attempt to "re-derive permissions from metadata" — that infrastructure does not exist. Reviewer caught the author's original (incorrect) claim that metadata-based inheritance was already the behavior. It is not. The behavior matches today's SendMessage path because the context passed in is the same shape.

**Subagent-type fallback:** if the agent was originally spawned with a `subagent_type` that no longer exists in the caller's current `appState.agentDefinitions.activeAgents`, `resumeAgentBackground` falls back to `GENERAL_PURPOSE_AGENT` at `resumeAgent.ts:125–128`. This matches today's behavior under SendMessage auto-resume and is preserved unchanged. Worth flagging as a known edge case: an agent originally spawned with a custom subagent_type that's been removed will resume with a different toolset than it had originally. This is a pre-existing limitation, not introduced by this plan.

### 3. Currently-running target
`ResumeAgent` on a currently-running agent (`appState.tasks[agentId].status === 'running'`) returns an error. Wording in Decision 4 below. **No auto-fallback** to SendMessage queueing — explicit error preserves the model's mental model.

### 4. Error wording (final, written-out)

| Condition | Wording |
|---|---|
| Target not resolvable at all (no registry, no durable handle, no transcript) | `No subagent found for "${input.agentId}". Check the agentId or call Agent to spawn a new one.` |
| Target resolves; task in-state with `status === 'running'` | `Agent "${displayName}" is already running; resume is not needed. Any message you send via SendMessage will queue automatically and deliver at the next tool round.` |
| Target resolves; task either in-state stopped or evicted; `resumeAgentBackground` throws `No transcript found` | `Agent "${displayName}" has no transcript to resume; it may have been cleaned up. Spawn a new agent with Agent.` |
| Target resolves; `resumeAgentBackground` throws any other error | `Failed to resume "${displayName}": ${errorMessage(e)}` |

`displayName` resolves via: registered alias → metadata description → task description → short ID. **Helper location:** the existing REPL inline logic at `src/screens/REPL.tsx:3979–3984` is the closest thing to a helper today. Task 1 extracts a shared helper alongside `resolveAgentTarget` — REPL also migrates to it so display-name resolution is one function with one set of tests. Scope: ~30 lines + a small test file.

**Precedence caveat for prior-session targets:** `appState.agentNameRegistry` is in-session only (`src/state/AppStateStore.ts:166` defines it as a Map populated by `AgentTool.call` at `:948–956` during fresh spawns). When a target is surfaced via `resolveWorkerAgentTarget` from a *prior* session, the registry doesn't contain that agent's alias. So in the most common stopped-target case — prior-session resume — the precedence falls through to metadata description directly. This is fine, but a reader scanning the precedence list might assume "alias wins" universally. It doesn't.

### 5. SendMessage's new stopped-target error
When SendMessage is called on a target that `resolveAgentTarget` resolves to a stopped subagent (in-state with non-running status, or evicted from state but agent exists), emit:

`Agent "${displayName}" is stopped. Use ResumeAgent({ agentId: "${agentId}", prompt }) to restart it.`

The `agentId` is the resolved canonical ID, not the raw `input.to`, so the model gets a usable handle to copy-paste.

**Emit condition (precise):** the new error fires when `resolveAgentTarget` returns non-null AND the resolved target is not currently running. When `resolveAgentTarget` returns null (no registry hit, no durable handle, no transcript), SendMessage MUST preserve the existing fallthrough to teammate-mailbox routing at `SendMessageTool.ts:920`. The new error and the teammate-mailbox path are mutually exclusive on the resolution outcome — emitting "use ResumeAgent" for a typo of a teammate name would be wrong.

### 6. REPL exemption
The REPL user-driven path at `src/screens/REPL.tsx:3986` keeps calling `resumeAgentBackground` directly. It does NOT go through `ResumeAgentTool`. Principle: `ResumeAgentTool` is the model-facing surface; `resumeAgentBackground` is the internal primitive. Internal callers (REPL, and any future internal flows) use the primitive directly. This is consistent — the rule is "the model has one tool for this responsibility," not "all callers funnel through the tool."

### 7. Race conditions
Three races are explicitly handled:

- **Stale status read in `ResumeAgent`.** The tool reads `task.status` from `appState`, then calls `resumeAgentBackground` which registers the task as running at `resumeAgent.ts:228`. Two concurrent `ResumeAgent` calls on the same agent can both see `status !== 'running'` before either registers. **Resolution:** `registerTask` at `framework.ts:69` already merges existing task state on re-register (line 73 — `isReplacement = existing !== undefined`). The second resume's `registerTask` call sees the first one's registration and replaces it. Effect: the second resume *wins* (its prompt and run state replace the first's), which is the same behavior as today when two SendMessage auto-resume calls race. Test in Task 2 documents this as the expected behavior; the plan does not introduce a new lock.
- **Stale status read in `SendMessage`.** SendMessage at `SendMessageTool.ts:851` checks `status === 'running'`, then calls `queuePendingMessage` at `LocalAgentTask.tsx:184` which does not recheck. An agent that stops between the check and the queue still gets the message appended to its `pendingMessages` array — which, per Decision 9, is preserved across resume. So the message is not lost; it is delivered when something (the next `ResumeAgent` call, or REPL resume) restarts the agent. **No new behavior**; the plan documents this and tests it.
- **REPL-vs-tool race.** The REPL exemption (Decision 6) means resume can be initiated from two paths: a model call to `ResumeAgent` and a user typing into a paused-agent view at `REPL.tsx:3986`. Both call `resumeAgentBackground`, both eventually call `registerTask`. The same `registerTask` merge that handles concurrent `ResumeAgent` calls also handles REPL-vs-tool races: whichever `registerTask` invocation wins the setAppState race replaces the other. Last writer wins; no corruption. The REPL exemption (Decision 6) does not undermine race safety — the merge covers it.

### 8. Fork subagents
Resume has special handling for forks at `resumeAgent.ts:118–164`: it selects `FORK_AGENT` instead of the named agent, reconstructs the parent system prompt at `:132`, and reuses the caller's exact tool pool at `:178–180` (rather than re-assembling from current MCP state). This depends on `toolUseContext.renderedSystemPrompt` being available, with a fallback path at `:137–157` that reconstructs from the caller's main-thread agent definition.

**Implication for this plan:** `ResumeAgentTool` must work for fork resume. The new tool's `ToolUseContext` is what the tool runtime gives it; it should have `renderedSystemPrompt` populated for the tool's invoking session. Verify in Task 2 with a fork-resume test. If `renderedSystemPrompt` is unavailable in the new tool's context for some reason, the fallback path at `resumeAgent.ts:137–157` handles it, so the behavior is at worst equivalent to today's SendMessage path.

### 9. Pending messages preservation
A message queued via `SendMessage` to a running subagent that subsequently stops is **not lost — under one precise condition.** The mechanism is `registerTask` at `framework.ts:74–87`, which carries `pendingMessages` forward when the task is replaced during resume. This merge only fires when the existing entry is a `LocalAgentTaskState` (the `existing && 'retain' in existing` check at `framework.ts:80`). Concretely:

- **Task is in `appState.tasks` when resume runs** (the case SendMessage's auto-resume branch at `:864–887` handled): `pendingMessages` are preserved. After `ResumeAgent` runs, they drain at the next tool round via `getAgentPendingMessageAttachments` at `attachments.ts:1086`.
- **Task is evicted from `appState.tasks` before resume** (the case SendMessage's branch at `:888–916` handled): there is no `existing` to merge from, so `pendingMessages` defaults to `[]` on the freshly-registered task. **This was already the behavior under SendMessage auto-resume** — there were no pending messages to preserve because the task that held them was evicted. Behavior is unchanged.

Delivery order in the preserved case: the `ResumeAgent` `prompt` parameter is processed first (it is the explicit invocation, delivered as the latest user message in the resumed conversation); pending messages drain as attachments on the next iteration. This matches today's behavior under SendMessage auto-resume. Tested in Task 2.

Prior plan revisions implied pendingMessages always survive resume; that was imprecise. The precise statement is: pendingMessages survive when the task is still tracked in `appState.tasks` at the moment of resume.

### 10. No deprecation period — but high migration bar
The cut is hard, BUT it only proceeds after all *shipped* prompts that teach SendMessage-as-continuation are migrated in the same change. The reviewer correctly flagged that the original "count A-class hits, gate at 10" criterion was wrong: blast radius is determined by *liveness*, not volume. One live coordinator system prompt is bigger than ten dead docs.

**New criterion:** before Task 4 (remove SendMessage auto-resume) can ship, every prompt enumerated under "Migration Surface" → "Code paths that change" MUST be updated. Task 0's survey extends the list if it finds more. User-authored prompts (CLAUDE.md in user repos, third-party plugins, user-installed skills) are out of scope and rely on the new error message as their migration aid.

---

## File Structure

- Create `src/tools/ResumeAgentTool/ResumeAgentTool.tsx`: tool implementation.
- Create `src/tools/ResumeAgentTool/ResumeAgentTool.test.ts`: behavior tests covering all four error paths, the success path, fork resume, race conditions, and pending-message preservation.
- Create `src/tools/ResumeAgentTool/prompt.ts`: tool description.
- Create `src/tools/ResumeAgentTool/constants.ts`: `RESUME_AGENT_TOOL_NAME = 'ResumeAgent'`.
- Create `src/tools/AgentTool/resolveAgentTarget.ts`: shared resolution helper. Returns `{ agentId, sourceSessionId, displayName } | null`.
- Create `src/tools/AgentTool/resolveAgentTarget.test.ts`: tests for alias / durable handle / raw ID resolution and display-name fallback.
- Modify `src/tools/SendMessageTool/SendMessageTool.ts`: use the helper; remove auto-resume; emit the new stopped-target error.
- Modify `src/tools/SendMessageTool/SendMessageTool.test.ts`: remove the four auto-resume tests; add new error-path tests; keep all running-target tests.
- Modify `src/tools/SendMessageTool/prompt.ts`: tighten description — running recipients only.
- Modify `src/tools/AgentTool/AgentTool.tsx`: rewrite continuation hints at lines 1812 and 1850.
- Modify `src/tools/AgentTool/prompt.ts`: rewrite SendMessage-as-continuation at lines 300, 323, 391.
- Modify `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts`: rewrite `whenToUse` at line 134.
- Modify `src/agent-mode/agentMode.ts`: rewrite line 77.
- Modify `src/coordinator/coordinatorMode.ts`: rewrite lines 131, 139, 165, 191, 233, 238.
- Modify `src/screens/REPL.tsx:3979–3984`: replace inline display-name logic with a call to the shared helper.
- Modify `src/tools.ts`: register `ResumeAgentTool` (Task 3 covers gating in detail).
- Modify `src/constants/tools.ts`: export `RESUME_AGENT_TOOL_NAME`; add to `COORDINATOR_MODE_ALLOWED_TOOLS` at line 141; consider whether to add to `ALL_AGENT_DISALLOWED_TOOLS` at line 42 (Task 3 decision).
- Modify `docs/maps/` (subagent / AgentTool map): add `ResumeAgentTool` and document the three-tool boundary.

---

### Task 0: Migration Survey

**Files:** none modified. Survey only. Output: a "Survey Results" section appended to this plan.

**Steps:**
- [ ] `rg -n "SendMessage" src/ docs/ skills/ -t ts -t tsx -t md` and classify each hit:
  - **A. Teaches auto-resume / continuation** — needs rewrite. Save file, line, exact string.
  - **B. Describes running-target messaging** — leave alone.
  - **C. Unrelated** — note count only.
- [ ] **Coordinator and Agent Mode surveys (explicit, by concept not by string):** read `src/coordinator/coordinatorMode.ts`, `src/agent-mode/agentMode.ts`, and `src/agent-mode/rolePrompts.ts` end-to-end. Find every routing-to-subagent instruction. The known hits are listed in Migration Surface above (thirteen in coordinatorMode); the survey confirms completeness and adds any missed. Specifically scan for: (a) tool-list bullets that group SendMessage with continuation, (b) prose sentences mentioning SendMessage in continue/resume/restart contexts, (c) worked-example code calls passing a stopped or completed agentId to SendMessage, (d) decision tables / matrices whose rows reference SendMessage as the "continue" mechanism. The prior plan revision missed the worked examples and decision table.
- [ ] Search the `.claude/`, `skills/`, and any plugin/skill markdown shipped in this repo for prompts teaching the old pattern.
- [ ] Identify ALL callers of `resumeAgentBackground` (`rg -n "resumeAgentBackground" src/`). Expected: SendMessageTool, REPL, tests. Anything else is an unknown that needs designing for.
- [ ] **Hard gate:** if the survey turns up any live shipped prompt not listed in Migration Surface, append it to Migration Surface AND add a corresponding step in Task 7 BEFORE proceeding to Task 4. Decision 10 forbids removing SendMessage auto-resume while any live shipped prompt still teaches the old pattern.

**Verification:**
- [ ] Classified list lives in this document under "Survey Results." No "audit later" loose ends.
- [ ] Every A-class hit has a corresponding step in Task 5 / Task 6 / Task 7.

---

### Task 1: Extract Shared Resolution and Display-Name Helpers

**Files:**
- Create: `src/tools/AgentTool/resolveAgentTarget.ts`
- Create: `src/tools/AgentTool/resolveAgentTarget.test.ts`
- Create: `src/tools/AgentTool/displayNameForAgent.ts` (or co-locate in `resolveAgentTarget.ts` if simpler)
- Modify: `src/tools/SendMessageTool/SendMessageTool.ts` (consume helper; auto-resume still in place)
- Modify: `src/screens/REPL.tsx:3979–3984` (consume the display-name helper)

**Steps:**
- [ ] Extract resolution from `SendMessageTool.ts:840–847` into `resolveAgentTarget({ input, appState, sessionId })` returning `{ agentId, sourceSessionId, displayName } | null`. Resolution order matches Decision 1.
- [ ] Extract display-name logic from `REPL.tsx:3979–3984` into `displayNameForAgent({ agentId, appState })` returning a string. Precedence: registered alias → metadata description → task description → short ID. Reuse inside `resolveAgentTarget` so the helper has a single source.
- [ ] **Intentional REPL behavior change:** today's REPL inline at `:3979–3984` only consults `agentNameRegistry` and falls back to `task.description || task.id`. The new helper adds an in-between fallback to `readAgentMetadata().description` for agents whose task is evicted from state but metadata exists on disk. This is a behavior change in REPL display strings, and it is desirable — the prior behavior showed raw IDs for evicted tasks, the new behavior shows the original task description. Document the change in the helper's docstring so a future reader does not "fix" it back.
- [ ] Update `SendMessageTool.ts` to call `resolveAgentTarget`. Running-target queueing branch stays. Auto-resume branches stay (Task 4 removes them).
- [ ] Update REPL to call `displayNameForAgent` instead of the inline `for (const [name, id] of agentNameRegistry)` loop.
- [ ] Tests cover: alias resolution; durable handle, current-session origin; durable handle, prior-session origin; raw ID, current session; raw ID, prior session via `writePriorSessionState`/`writePriorAgentTranscript` fixtures (reuse the patterns from `SendMessageTool.test.ts:322`/`:374`); not-found; display-name fallback at each precedence level.

**Verification:**
- [ ] `bun test src/tools/AgentTool/resolveAgentTarget.test.ts` passes.
- [ ] `bun test src/tools/SendMessageTool/` passes — running-target behavior and existing auto-resume behavior both unchanged at this point.
- [ ] Manual: in a dev session, open a paused subagent's view in REPL and confirm the displayed name is unchanged.

---

### Task 2: Create `ResumeAgentTool` (Async Only)

**Files:**
- Create: `src/tools/ResumeAgentTool/ResumeAgentTool.tsx`
- Create: `src/tools/ResumeAgentTool/ResumeAgentTool.test.ts`
- Create: `src/tools/ResumeAgentTool/prompt.ts`
- Create: `src/tools/ResumeAgentTool/constants.ts`

**Steps:**
- [ ] Define schema: `{ agentId: z.string(), prompt: z.string() }`. No `run_in_background` flag (single mode now; the sync-resume follow-up adds it).
- [ ] `call({ agentId, prompt }, context, canUseTool, { assistantMessage }?)` implementation:
  - Call `resolveAgentTarget({ input: agentId, appState: context.getAppState(), sessionId: getSessionId() })`. If `null`, return Decision 4's "not found" error.
  - Read `task = appState.tasks[resolved.agentId]`. If `isLocalAgentTask(task)` and `task.status === 'running'`, return Decision 4's "already running" error.
  - Otherwise call `resumeAgentBackground({ agentId: resolved.agentId, prompt, sourceSessionId: resolved.sourceSessionId, toolUseContext: context, canUseTool, invokingRequestId: assistantMessage?.requestId })`.
  - On success: `{ success: true, message: 'Resumed "${result.description}" in the background.' }`. Same wording as the SendMessage path produces today.
  - On thrown error: detect the "transcript missing" case via a **typed sentinel**, not a regex against `errorMessage(e)`. Concretely: introduce `class TranscriptNotFoundError extends Error` in `resumeAgent.ts` (or a similar discriminated-union shape), throw it at `resumeAgent.ts:84` in place of the current generic `Error`, and check `e instanceof TranscriptNotFoundError` in the tool. Rationale: the current throw at `resumeAgent.ts:84` uses an exact-string message; a future refactor that rewords it would silently degrade the specific error to the generic "Failed to resume" path. The typed-sentinel survives reword. **Implementation cost:** one new error class + one throw-site swap + import in the new tool. The change is purely additive — REPL and any other future callers can still treat any thrown error as failure without caring about the type.
- [ ] Tool description (`prompt.ts`): explain what it does, when vs `Agent`, when vs `SendMessage`, and that a sync mode is planned. Include the literal call shape.
- [ ] Tests:
  - [ ] Success: stopped subagent + valid prompt → ack returned. Spy on `resumeAgentBackground` asserts called once with expected args.
  - [ ] Resolution by registered alias.
  - [ ] Resolution by durable handle, current-session origin.
  - [ ] Resolution by durable handle, **prior-session origin** (uses `writePriorSessionState`/`writePriorAgentTranscript` fixtures, mirrors `SendMessageTool.test.ts:322`).
  - [ ] Resolution by raw agentId, prior-session origin (mirrors `SendMessageTool.test.ts:374`).
  - [ ] Task in-state with `status === 'completed'` → success.
  - [ ] Task evicted from state but transcript exists on disk → success (this is a structurally distinct code path inside `resumeAgentBackground` — the "evicted" branch that today's `SendMessageTool.ts:888` triggers).
  - [ ] Error: agent not found (no registry, no durable handle, raw ID has no transcript).
  - [ ] Error: agent currently running (`status === 'running'`).
  - [ ] Error: transcript cleaned up (`resumeAgentBackground` throws `No transcript found for agent ID`).
  - [ ] Error: `resumeAgentBackground` throws generic.
  - [ ] `invokingRequestId` wiring: spy asserts the call args include the requestId passed by the tool runtime.
  - [ ] **Fork resume:** spawn metadata indicates `agentType === FORK_AGENT.agentType`; assert `resumeAgentBackground` is invoked with a context whose `renderedSystemPrompt` is present (or that the fallback at `resumeAgent.ts:137` produces a valid prompt). Reuse fork test fixture patterns from `resumeAgent.test.ts`.
  - [ ] **Concurrent double resume:** call `ResumeAgent` twice in parallel on the same stopped agent. Assert both calls complete (no deadlock, no thrown error from race), and that the final task state reflects one running registration (registerTask's `isReplacement` merge handles the race; test documents that the second call wins).
  - [ ] **Pending messages preserved across resume:** stage `task.pendingMessages = ['queued-1', 'queued-2']`; call `ResumeAgent`; assert post-call `task.pendingMessages` still contains the queued items (resume preserves them; the agent's next tool round drains them via `getAgentPendingMessageAttachments`, which is out of scope for this test).
  - [ ] **Mid-lifecycle failure:** mock `resumeAgentBackground` to return successfully (it schedules the async lifecycle), then trigger a synthetic lifecycle failure. Assert the tool's success return is unaffected (it already returned) — failure is delivered via the notification channel, same as today. This documents the contract: the tool returns when scheduling succeeds, not when the agent completes.
  - [ ] Result shape parity: same `Resumed "X" in the background.` wording the SendMessage path produces today.

**Verification:**
- [ ] `bun test src/tools/ResumeAgentTool/` passes.

---

### Task 3: Register Tool With Correct Gating

**Files:**
- Modify: `src/tools.ts`
- Modify: `src/constants/tools.ts`

**Steps:**
- [ ] Export `RESUME_AGENT_TOOL_NAME = 'ResumeAgent'` from `src/constants/tools.ts`.
- [ ] **Base registration:** add `ResumeAgentTool` to the tool pool in `src/tools.ts` near where `AgentTool` is registered (around line 215). Match conditional inclusion (gates / feature flags).
- [ ] **Coordinator mode allowlist:** add `RESUME_AGENT_TOOL_NAME` to `COORDINATOR_MODE_ALLOWED_TOOLS` at `src/constants/tools.ts:141`. Coordinator mode is the *primary* consumer of the new tool — it spawns workers via `Agent` and continues them. Without this entry, coordinator mode cannot use the new tool and the prompt rewrites in Task 6 would teach an unusable pattern.
- [ ] **Subagent disallowed set:** decide whether `RESUME_AGENT_TOOL_NAME` goes into `ALL_AGENT_DISALLOWED_TOOLS` at `src/constants/tools.ts:42`. The existing `AGENT_TOOL_NAME` entry prevents subagents from recursively spawning. ResumeAgent has a similar concern — should a subagent be able to resume sibling subagents? **Default decision: add it.** Subagents resuming siblings introduces complex authorization questions (which permission scope governs the resumed agent? whose tool pool?) that are out of scope for this plan. The `USER_TYPE === 'ant'` carve-out at line 47 applies the same way: ant builds permit nested agents, so they permit nested resume. Document the decision so it can be revisited.
- [ ] **`filterToolsForAgent`** at `src/tools/AgentTool/agentToolUtils.ts:107` matches on tool name; with `RESUME_AGENT_TOOL_NAME` in `ALL_AGENT_DISALLOWED_TOOLS`, filtering applies automatically. No code change in that file.
- [ ] **`IN_PROCESS_TEAMMATE_ALLOWED_TOOLS` at `src/constants/tools.ts:111`.** Teammates today are explicitly allowed `SendMessage`. Under the current contract, a teammate can SendMessage to a stopped subagent and auto-resume it. After this plan, that path errors. **Default decision: do NOT add `RESUME_AGENT_TOOL_NAME` to the teammate allowlist.** Teammates that need to resume a sibling subagent are out of scope for this plan; same rationale as Decision 3's recursive-resume case. Document explicitly so a future contributor doesn't add it without thinking through the authorization implications. If a real teammate-driven resume use case surfaces, it becomes its own plan.
- [ ] **End-to-end smoke** before proceeding to Task 4: build the dev binary (`bun run build:dev:full`), open a fresh session, spawn an async agent via `Agent({ description: '...', prompt: '...', run_in_background: true })`, wait for it to complete or stop, then call `ResumeAgent({ agentId, prompt })`. Confirm the resume executes and the success ack matches expected wording. This is a hard gate: if the smoke fails, do not proceed to Task 4.

**Verification:**
- [ ] Dev build succeeds.
- [ ] Tool enumerable in a fresh session.
- [ ] End-to-end smoke passes.
- [ ] Subagent context cannot see `ResumeAgent` (confirm by spawning a sync subagent and inspecting its available tools).

---

### Task 4: Remove Auto-Resume From SendMessage

**Files:**
- Modify: `src/tools/SendMessageTool/SendMessageTool.ts`
- Modify: `src/tools/SendMessageTool/SendMessageTool.test.ts`

**Hard prerequisite:** Tasks 0, 5, 6, 7 must be complete. Decision 10 forbids removing auto-resume while any shipped prompt still teaches it.

**Mechanical gate (added in second-pass review):** before this task ships, run the following sweep and require it to be empty (or contain only allowlisted strings):

```
rg -n "SEND_MESSAGE_TOOL_NAME.{0,40}(continue|resume|restart|stopped|completed)" src/ skills/ docs/
rg -n "SendMessage.{0,40}(continue|resume|restart)" src/ skills/ docs/
```

Allowlist (strings that may legitimately remain after migration): `"SendMessage to a running worker"`, `"SendMessage only for workers that are still running"`, `"queue messages into a worker that is currently running"`, `"SendMessage to queue"`. Anything else is a survey miss — go back to Task 0, add the hit, route through Tasks 5/6/7 first. Decision 10's "every shipped prompt migrated" is enforced by this sweep, not by hand-grep diligence.

**Steps:**
- [ ] Remove the two auto-resume branches at `SendMessageTool.ts:864–887` (in-state stopped) and `:888–916` (evicted from state).
- [ ] Replace both with a single error path per Decision 5. Use `resolveAgentTarget`'s `displayName` and canonical `agentId`.
- [ ] Drop the import of `resumeAgentBackground` from `SendMessageTool.ts`.
- [ ] Update the comment at line 838: `"Stopped subagents are NOT auto-resumed; SendMessage targets running recipients only. Use ResumeAgent for stopped subagents."`
- [ ] Update the inline comment at line 891 (`"toAgentId validates the createAgentId format, so teammate names never reach this block"`). After Decision 1's disk-check requirement, this comment becomes a contradiction. Rewrite or remove — the new helper guarantees a non-null return implies the target has either a registered alias, a durable handle, or a transcript on disk.
- [ ] Tests:
  - [ ] Remove all **four** existing auto-resume tests in `SendMessageTool.test.ts`:
    - Durable-handle resume (around line 251).
    - Stopped in-memory resume (around line 284).
    - Prior-session handle resume (around line 322).
    - Prior-session raw-agentId resume (around line 374).
  - [ ] Coverage for these moves to `resolveAgentTarget.test.ts` (resolution) and `ResumeAgentTool.test.ts` (resume behavior). Port the `writePriorSessionState`/`writePriorAgentTranscript` fixture wiring; do not redesign it.
  - [ ] Add: SendMessage to a stopped in-state agent → new error; `resumeAgentBackground` NOT called (spy infra at line 129).
  - [ ] Add: SendMessage to a durable-handle target whose task is evicted → new error; `resumeAgentBackground` NOT called.
  - [ ] Add: SendMessage to an unresolvable target (no registry, no durable handle, no transcript) → existing teammate-mailbox fallthrough (`SendMessageTool.ts:920` and below) executes; new error is NOT emitted. This is the regression guard for Decision 5's emit condition.
  - [ ] Add: SendMessage with `to: '*'` (broadcast) is unaffected by this plan — broadcast routing is gated at `SendMessageTool.ts:839` and skips subagent resolution entirely. Existing broadcast tests should pass unchanged; confirm explicitly.
  - [ ] Keep ALL running-target tests (queue delivery, broadcast, teammate messaging). MUST pass unchanged.

**Verification:**
- [ ] `bun test src/tools/SendMessageTool/` passes.
- [ ] `rg "resumeAgentBackground" src/tools/SendMessageTool/` returns nothing.

---

### Task 5: Update Spawn Continuation Hints in AgentTool

**Files:**
- Modify: `src/tools/AgentTool/AgentTool.tsx`
- Modify: `src/tools/AgentTool/prompt.ts`

**Steps:**
- [ ] `AgentTool.tsx:1812` (async spawn success): change `"Use SendMessage with to: '${data.agentId}' to continue this agent."` to `"Use ResumeAgent({ agentId: '${data.agentId}', prompt }) to continue this agent."`
- [ ] `AgentTool.tsx:1850` (sync spawn completion trailer): change `"(use SendMessage with to: '${data.agentId}' to continue this agent)"` to `"(use ResumeAgent({ agentId: '${data.agentId}', prompt }) to continue this agent)"`
- [ ] `prompt.ts:300`: rewrite `"Use ${SEND_MESSAGE_TOOL_NAME} to continue a worker..."` to use `ResumeAgent`. Same for `:323`.
- [ ] `prompt.ts:391`: rewrite `"To continue a previously spawned agent, use ${SEND_MESSAGE_TOOL_NAME}..."` to teach `ResumeAgent`.
- [ ] Add `RESUME_AGENT_TOOL_NAME` import alongside the existing `SEND_MESSAGE_TOOL_NAME` import at `prompt.ts:10`.
- [ ] Update inline comment at `AgentTool.tsx:1835`: `"One-shot built-ins (Explore, Plan) are never continued via SendMessage"` → `"One-shot built-ins (Explore, Plan) are never continued via SendMessage or ResumeAgent"`. Internal comment, not model-facing, but appears in the Task 4 mechanical sweep and would confuse future maintainers.
- [ ] `rg "SendMessage|SEND_MESSAGE_TOOL_NAME" src/tools/AgentTool/` and confirm no remaining hits teach continuation via SendMessage. Legitimate references (e.g., "messages running workers via SendMessage") stay.

**Verification:**
- [ ] `bun test src/tools/AgentTool/` passes.

---

### Task 6: Update Orchestrator, Coordinator, and SendMessage Prompts

**Files:**
- Modify: `src/agent-mode/agentMode.ts`
- Modify: `src/coordinator/coordinatorMode.ts`
- Modify: `src/tools/SendMessageTool/prompt.ts`
- Any prompt surfaces flagged by Task 0 not already in this list.

**Steps:**
- [ ] `agentMode.ts:77`: rewrite to teach the three-way split. Suggested: `"Use this state to choose whether to resume an existing worker or spawn a fresh one. Use ResumeAgent on a resumable worker handle when the follow-up overlaps that worker's loaded context. Use SendMessage only to queue messages into a worker that is currently running."`
- [ ] `coordinatorMode.ts` — **thirteen** rewrites (vs. the six the prior plan version listed; second-pass review surfaced the rest):
  - [ ] Line 131: tool list entry. Change `"${SEND_MESSAGE_TOOL_NAME} - Continue an existing worker..."` to two entries: `"${SEND_MESSAGE_TOOL_NAME} - Send a message to a running worker"` and `"${RESUME_AGENT_TOOL_NAME} - Restart a stopped worker with a new prompt"`. Adds one bullet.
  - [ ] Line 139: change `"Continue workers whose work is complete via ${SEND_MESSAGE_TOOL_NAME}..."` to `"Continue stopped workers via ${RESUME_AGENT_TOOL_NAME} to take advantage of their loaded context. Use ${SEND_MESSAGE_TOOL_NAME} only for workers that are still running."`
  - [ ] Line 165: change `"use SendMessage with that ID as \`to\` to continue that worker"` to `"use ${RESUME_AGENT_TOOL_NAME} with that ID as agentId to continue that worker (a completed worker is a stopped worker)"`
  - [ ] Line 191: example call inside the worked example. Change from `${SEND_MESSAGE_TOOL_NAME}({ to: "agent-a1b", message: "..." })` to `${RESUME_AGENT_TOOL_NAME}({ agentId: "agent-a1b", prompt: "..." })`. agent-a1b just completed in the example, so it is stopped — ResumeAgent is correct.
  - [ ] Line 233: change `"Continue the same worker with ${SEND_MESSAGE_TOOL_NAME}..."` to `"Continue the same worker with ${RESUME_AGENT_TOOL_NAME}..."` (a worker reporting failure has stopped).
  - [ ] Line 238: change `"Stopped workers can be continued with ${SEND_MESSAGE_TOOL_NAME}"` to `"Stopped workers can be continued with ${RESUME_AGENT_TOOL_NAME}"`.
  - [ ] Line 249: TaskStop block example call. Change `${SEND_MESSAGE_TOOL_NAME}({ to: "agent-x7q", message: "..." })` to `${RESUME_AGENT_TOOL_NAME}({ agentId: "agent-x7q", prompt: "..." })`. agent-x7q was just stopped via TaskStop, so it is stopped.
  - [ ] Line 254: prose introducing Section 5 — `"choose whether to continue that worker via ${SEND_MESSAGE_TOOL_NAME} or spawn a fresh one"`. Change to `"choose whether to continue that worker via ${RESUME_AGENT_TOOL_NAME} (if it is stopped) or ${SEND_MESSAGE_TOOL_NAME} (if it is still running), or spawn a fresh one"`.
  - [ ] Line 287: decision-table cell — `"**Continue** (${SEND_MESSAGE_TOOL_NAME}) with synthesized spec"`. Change to `"**Continue** (${RESUME_AGENT_TOOL_NAME} if stopped, ${SEND_MESSAGE_TOOL_NAME} if running) with synthesized spec"`. This is the central decision-table cell; verify the resulting line still fits the table layout.
  - [ ] Line 298: continue-mechanics lead-in — `"When continuing a worker with ${SEND_MESSAGE_TOOL_NAME}..."`. Change to teach both: `"When continuing a stopped worker with ${RESUME_AGENT_TOOL_NAME} (or a running worker with ${SEND_MESSAGE_TOOL_NAME}), it has full context from its previous run:"`
  - [ ] Line 301: worked continuation example. Change `${SEND_MESSAGE_TOOL_NAME}({ to: "xyz-456", message: "..." })` to `${RESUME_AGENT_TOOL_NAME}({ agentId: "xyz-456", prompt: "..." })`. The worker "finished research" in the example, so it is stopped.
  - [ ] Line 306: correction worked example. Change `${SEND_MESSAGE_TOOL_NAME}({ to: "xyz-456", message: "..." })` to `${RESUME_AGENT_TOOL_NAME}({ agentId: "xyz-456", prompt: "..." })`. The worker "reported test failures" in the example, so it is stopped (it reported = it finished its turn).
  - [ ] Line 361: example-session step continuing a completed agent. Change `${SEND_MESSAGE_TOOL_NAME}({ to: "agent-a1b", message: "..." })` to `${RESUME_AGENT_TOOL_NAME}({ agentId: "agent-a1b", prompt: "..." })`. agent-a1b completed in the example.
- [ ] Add `RESUME_AGENT_TOOL_NAME` import to `coordinatorMode.ts` alongside the existing `SEND_MESSAGE_TOOL_NAME` import at `:12`.
- [ ] `SendMessageTool/prompt.ts`: tighten the description. Explicit statement: `"SendMessage targets recipients that are currently running. To restart a stopped subagent, use ResumeAgent. To start a fresh subagent, use Agent."` Drop any language that implies auto-resume.
- [ ] Apply any additional rewrites from Task 0's survey.

**Verification:**
- [ ] Read each rewritten coordinator section fresh as if I were a model seeing it for the first time. Each makes the tool boundary obvious.
- [ ] `rg "SEND_MESSAGE_TOOL_NAME.*continue|continue.*SEND_MESSAGE" src/coordinator/ src/agent-mode/` returns no stale guidance.
- [ ] `bun test src/coordinator/ src/agent-mode/` passes (any prompt-snapshot tests will need updating).

---

### Task 7: Migrate Other Shipped Prompts

**Files:**
- Modify: `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts`
- Any other A-class hits surfaced by Task 0 in `src/`, `skills/`, `docs/`.

**Steps:**
- [ ] `claudeCodeGuideAgent.ts:134`: rewrite the `whenToUse` clause. Change `"check if there is already a running or recently completed claude-code-guide agent that you can continue via ${SEND_MESSAGE_TOOL_NAME}"` to `"check if there is already a running claude-code-guide agent (continue via ${SEND_MESSAGE_TOOL_NAME}) or a recently completed one (continue via ${RESUME_AGENT_TOOL_NAME})"`. Add the `RESUME_AGENT_TOOL_NAME` import.
- [ ] `src/utils/agentContext.ts:48`: comment `"Whether this invocation is the initial spawn or a subsequent resume via SendMessage. Undefined when invokingRequestId is absent."` Rewrite to `"...subsequent resume (via ResumeAgent or the REPL user-driven path)."` This is not model-facing — it's an inline doc comment — but it will surface in the Task 4 mechanical sweep and an honest survey lists it.
- [ ] For every other A-class hit in Task 0's survey not already covered, rewrite using the same vocabulary: `ResumeAgent` for stopped subagents, `SendMessage` for running ones.

**Verification:**
- [ ] `rg "SendMessage.*continue|SendMessage.*resume|SendMessage.*restart" src/ skills/ docs/` returns no shipped-content hits.

---

### Task 8: Documentation and Maps

**Files:**
- Modify: appropriate map in `docs/maps/` (locate via `docs/maps/WORKSPACE_MAP.md`).
- Modify if applicable: `docs/prompts/2026-04-30-prompt-surfaces.md`.

**Steps:**
- [ ] Add `ResumeAgentTool` entry to the agent runtime map. Include the three-tool boundary in one paragraph: `Agent` spawns, `ResumeAgent` continues a stopped subagent, `SendMessage` queues into a running one.
- [ ] If `docs/maps/WORKSPACE_MAP.md` mentions SendMessage's auto-resume responsibility, update.
- [ ] If prompt-surfaces doc enumerates per-tool descriptions, add the new entry.

**Verification:**
- [ ] `git diff --check` clean.
- [ ] Internal markdown links resolve.

---

## Risks

- **Live coordinator prompt is the highest blast radius.** Thirteen sites in `coordinatorMode.ts` teach the old pattern. Task 6 must rewrite all thirteen in the same change as Task 4's removal of SendMessage auto-resume. If any are missed, coordinator users hit the new error on legitimate calls and lose one turn per occurrence until the prompt re-fires with the updated text. Decision 10's hard gate prevents this.
- **User-authored prompts.** CLAUDE.md in user repos, third-party plugins, user-installed skills are out of scope. The new error message is the migration aid for those. Acceptable cost: one wasted model turn per affected callsite per session, with explicit error wording guiding the correction.
- **`resolveAgentTarget` extraction may shift behavior.** Today's resolution at `SendMessageTool.ts:840–847` is inline and slightly intertwined with the running-target check. Extraction should be behavior-preserving; Tasks 1 and 4 tests guard.
- **`renderedSystemPrompt` for forks.** The new tool's `ToolUseContext` should have `renderedSystemPrompt` populated for forks to resume cleanly; the fallback at `resumeAgent.ts:137–157` handles the absent case. Task 2's fork test verifies.
- **Coordinator allowlist regression.** Forgetting `RESUME_AGENT_TOOL_NAME` in `COORDINATOR_MODE_ALLOWED_TOOLS` makes the new tool unavailable in coordinator mode — the primary consumer. Task 3 lists this explicitly.
- **Recursive subagent resume.** Decision 3 adds `RESUME_AGENT_TOOL_NAME` to `ALL_AGENT_DISALLOWED_TOOLS`. Documented; can be revisited as a separate plan if there's demand.
- **Lifecycle failure after scheduling.** The tool returns success when scheduling succeeds; downstream failure is delivered via notification (Task 2 test documents this). Behavior identical to today's SendMessage path. Worth flagging because the caller's mental model may need to be that "success" means "scheduled," not "completed."

## Non-Goals

- No sync resume mode. The follow-up `2026-05-12-sync-resume-subagent-plan.md` adds a `run_in_background: false` mode by extending `ResumeAgentTool`.
- No changes to the REPL-driven user resume path. It calls `resumeAgentBackground` directly as an internal primitive.
- No changes to teammate / swarm messaging. SendMessage's running-recipient behavior unchanged.
- No backwards-compatibility shim. The new error is the migration aid for user-authored content; shipped prompts migrate in the same change.
- No changes to the notification machinery. Both paths feed `runAsyncAgentLifecycle` → `enqueueAgentNotification`.
- No refactor of `resumeAgentBackground`. It stays the internal primitive; the plan documents its `ToolUseContext` dependencies (Decision 2) so the new tool's `call` produces a compatible context.
- No introduction of locking or new concurrency primitives. Existing `registerTask` semantics handle the resume-race case (Decision 7).

## Survey Results

Survey run on 2026-05-12 with:

- `rg -n "SendMessage" src/ docs/ skills/ -g '*.ts' -g '*.tsx' -g '*.md'` (repo has no root `skills/` directory)
- `rg -n "SendMessage|SEND_MESSAGE_TOOL_NAME|continue|resume|restart|stopped|completed" src/agent-mode/agentMode.ts src/coordinator/coordinatorMode.ts src/agent-mode/rolePrompts.ts`
- `rg -n "resumeAgentBackground" src/`
- `.claude/`, `src/skills/`, `src/utils/skills/`, `src/components/skills/`, and `src/commands/skills/` prompt scan

### A. Teaches auto-resume / continuation

These need rewrite before Task 4 removes SendMessage auto-resume:

- `src/agent-mode/agentMode.ts:77` - `"Prefer SendMessage to a resumable worker handle..."`
- `src/coordinator/coordinatorMode.ts:131` - SendMessage tool-list entry says "Continue an existing worker"
- `src/coordinator/coordinatorMode.ts:139` - "Continue workers whose work is complete via SendMessage"
- `src/coordinator/coordinatorMode.ts:165` - task ID guidance says use SendMessage to continue
- `src/coordinator/coordinatorMode.ts:191` - completed-worker example continues via SendMessage
- `src/coordinator/coordinatorMode.ts:233` - worker failure guidance continues via SendMessage
- `src/coordinator/coordinatorMode.ts:238` - stopped worker guidance continues via SendMessage
- `src/coordinator/coordinatorMode.ts:249` - TaskStop example continues via SendMessage
- `src/coordinator/coordinatorMode.ts:254` - continue-vs-spawn prompt points only at SendMessage
- `src/coordinator/coordinatorMode.ts:287` - decision table labels continue mechanism as SendMessage
- `src/coordinator/coordinatorMode.ts:298` - continue mechanics lead-in points at SendMessage
- `src/coordinator/coordinatorMode.ts:301` - finished-research continuation example uses SendMessage
- `src/coordinator/coordinatorMode.ts:306` - correction continuation example uses SendMessage
- `src/coordinator/coordinatorMode.ts:361` - example-session completed worker continues via SendMessage
- `src/tools/AgentTool/AgentTool.tsx:1812` - async spawn result says use SendMessage to continue
- `src/tools/AgentTool/AgentTool.tsx:1835` - one-shot comment says never continued via SendMessage
- `src/tools/AgentTool/AgentTool.tsx:1850` - sync spawn result says use SendMessage to continue
- `src/tools/AgentTool/constants.ts:7` - comment couples agentId trailers to SendMessage continuation
- `src/tools/AgentTool/prompt.ts:300` - Agent prompt says use SendMessage to continue a worker
- `src/tools/AgentTool/prompt.ts:323` - same guidance in alternate prompt branch
- `src/tools/AgentTool/prompt.ts:391` - Agent prompt says SendMessage resumes with full context
- `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts:134` - built-in agent says continue recently completed guide agent via SendMessage
- `src/utils/agentContext.ts:48` - comment says subsequent resume via SendMessage
- `docs/maps/agent-mode.md:47` - map calls the responsibility "Worker resume / steering" under SendMessage

Historical design docs and prior implementation plans under `docs/agent/` and `docs/superpowers/plans/` contain old SendMessage-continuation examples. They are not live shipped prompts, but the mechanical sweep will be reviewed after live prompt migration so any stale wording that still trips the gate can be either updated or explicitly treated as historical context.

### B. Describes running-target messaging

These remain valid after the split:

- `src/utils/swarm/teammatePromptAddendum.ts:12-15` - teammate messaging by name or broadcast
- `src/tools/TeamCreateTool/prompt.ts:45,107` - team shutdown and teammate communication via SendMessage
- `src/tools/AgentTool/AgentTool.tsx:259,945-947` - naming/routing comments for running agents
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx:155,194` - pending-message queueing comments
- SendMessage tool implementation, UI, tests, constants, and imports that name the tool without teaching continuation
- Agent Mode worker role disallow-list entries for SendMessage in `src/agent-mode/rolePrompts.ts`

### C. Unrelated / historical references

The remaining hits are tests, imports, UI names, report tables, archived plans, historical design docs, and generic tool lists. They do not change the model-facing live prompt boundary unless captured in A above.

### `resumeAgentBackground` Callers

Production callers:

- `src/tools/SendMessageTool/SendMessageTool.ts` - removed in Task 4
- `src/screens/REPL.tsx` - intentionally remains as the internal user-driven resume path

Tests and comments:

- `src/tools/AgentTool/resumeAgent.test.ts`
- `src/tools/SendMessageTool/SendMessageTool.test.ts`
- comments in task/session/tool-result utilities documenting resume plumbing
