# Normal-Mode Subagent Upgrade — Scope & Intent

Status: scope + key decisions locked after two independent reviews (2026-06-02)
Date: 2026-06-02 (revised same day)
Owner: phase1

## Decisions locked (2026-06-02)

- **Verifier:** do NOT register `agent-mode-verifier` in normal mode. Reuse the
  existing `verification` agent type
  ([`verificationAgent.ts:222`](../../src/tools/AgentTool/built-in/verificationAgent.ts))
  — already background, read-only, `VERDICT: PASS/FAIL/PARTIAL`, caller-oriented.
- **Coding worker:** register a NEW normal-mode type (recommended name
  `implementor`), distinct from `agent-mode-coding-worker`. A distinct type means
  a separate `agent-memory/<type>/` dir and NO auto-injection of
  `.cat-code/roles/implementor.md` Agent-Mode assumptions. Its prompt is written
  normal-mode-native (no orchestrator, no `ask_orchestrator`).
- **Name pool:** new type gets a coding-themed pool (reuse the coding-worker
  pool — Turing/Hopper/Curie). Cosmetic; no cross-mode collision because the
  registry collision is only on memory/role-files, which the distinct type
  already separates.
- **Memory:** the ONLY deferred follow-up. Built-in agents have no generic
  memory-injection path today, so per-role memory is real new wiring tracked
  separately. Everything else in this doc is the current build = named + role +
  resumable.
- **`ask_orchestrator`:** the constant-collision bug
  (`'AskOrchestrator'` vs `'ask_orchestrator'`) — **FIXED 2026-06-02.**
  `constants.ts` now re-exports the canonical `'ask_orchestrator'` from
  `prompt.ts`; regression tests in `src/agent-mode/rolePrompts.test.ts`. The new
  normal-mode coding-worker prompt simply never lists the tool regardless.
- **Verifier gate (decided at implementation start):** the `verification` agent
  is feature-gated OFF by default for non-ant builds
  ([`builtInAgents.ts:78-83`](../../src/tools/AgentTool/builtInAgents.ts):
  `feature('VERIFICATION_AGENT')` + `tengu_hive_evidence` default false).
  Decision: **un-gate `verification` for normal mode** so the verifier half is
  actually available, not dormant. Implementation must make it reliably
  registered in normal mode without depending on `tengu_hive_evidence`.
- **Work location (decided at implementation start):** implement **directly on
  the `phase1` git branch** (which already carries ~96 unrelated uncommitted
  files — preserve them; do not commit them as part of this work).

**Full scope of this doc (build it all, end to end):** naming + resume already
work (zero work). The real work is
(1) register a new `implementor` coding-worker type in normal mode, (2) write its
normal-mode-native role prompt (option B, with explicit block-don't-widen
discipline), (3) surface `verification` as the normal-mode verifier,
(4) **add lightweight delegation guidance** so the main agent actually reaches
for these roles (see below), (5) tests. The Agent-Mode verifier and the
worker-control tools are intentionally excluded (orchestrator-only); per-role
memory is the one deferred follow-up.

### Why delegation guidance is a core item, not an afterthought

Registering a role only makes it *selectable* via `subagent_type`; it does not
make the main agent *choose* it. Agent Mode gets delegation because its
orchestrator prompt actively coaches it ("a real implementation phase should
belong to a coding worker"). Normal mode has no such coaching, so a freshly
registered `implementor` would sit dormant — the main agent keeps doing the work
itself.

The fix is prompt-only and there is already a pattern to mirror in the
**normal-mode** session guidance:
[`getSessionSpecificGuidanceSection`](../../src/constants/prompts.ts) at
`prompts.ts:429` already coaches `subagent_type=Explore` (`:456`) and already
has feature-gated verification-delegation guidance (`:471`). Add a short,
normal-mode-native line that names `implementor` (and `verification`) and when
reaching for them helps — without orchestrator framing. This is what converts
"registered but dormant" into "actually used," and it is the cheap, low-risk
piece that makes the registration pay off.

Scope discipline: keep it to one or two lines, mirroring the existing Explore
line's tone. Do NOT import the orchestrator's aggressive "delegate by default"
doctrine — normal mode should suggest these roles for genuinely bounded
implementation/verification slices, not push execution outward reflexively.

This is a **what-and-why** document, not a step-by-step implementation plan. It
records the decisions and the *corrected* understanding of the source so a
later implementation pass can route correctly. All file:line anchors were
verified against the live tree on 2026-06-02; re-verify before editing, as this
repo drifts.

> **Revision note.** A first draft of this doc claimed four capabilities needed
> "un-gating" into normal mode. An independent source review found three of
> those claims wrong: friendly naming **already works** in normal mode; built-in
> per-role memory is **not** wired by adding a `memory` field; and
> `AskOrchestrator` is **not** Agent-Mode-gated. The scope below reflects the
> corrected facts. The "Corrections applied" section at the end records what
> changed and why, so the reasoning is auditable.

---

## Goal (unchanged)

Make the **normal-mode** subagent *be* the upgraded one — named, role-bearing,
resumable, and (where it makes sense) memory-backed — rather than introducing a
second "worker" kind that coexists with the normal subagent. "Agent Mode"
remains a layer of orchestrator doctrine on top of the same subagent, not a
different subagent type.

The four target capabilities are unchanged: **named, role-bearing, resumable,
per-role memory.** What changed is *how much work each one actually is*, now
that the source has been checked properly.

---

## Corrected status of each capability

### 1. Friendly names — ALREADY WORKS in normal mode. No work needed.

The first draft said naming was coupled to the Agent-Mode-only
`sessionStateTracking` and needed decoupling. **That is wrong.** The normal
spawn path already:

- resolves a name via `resolveSystemSubagentName(... allowGeneric: true)`
  ([`AgentTool.tsx:290`](../../src/tools/AgentTool/AgentTool.tsx), called at
  `:318`, threaded at `:829`), and
- registers it for **all** spawns via `registerAgentName`
  ([`AgentTool.tsx:1046`](../../src/tools/AgentTool/AgentTool.tsx)).
- A test already asserts ordinary normal subagents receive names
  ([`AgentTool.test.ts:28`](../../src/tools/AgentTool/AgentTool.test.ts)).

The `runAgent.ts:403` allocator (keyed off `Boolean(sessionStateTracking)`) is a
**fallback**, not the primary path. So **naming is not a work item.** The only
residual concern is UX policy (see Risks: name pools are small and registry is
not cleaned mid-session → long sessions get suffixed names).

### 2. Resumable — ALREADY WORKS in normal mode. No work needed.

Confirmed correct in the first draft. `ResumeAgent` resumes from transcript +
metadata ([`resumeAgent.ts:111`](../../src/tools/AgentTool/resumeAgent.ts)), is
enabled in normal sessions, and resolves targets (registry → durable worker
state → metadata → raw ID) via
[`resolveAgentTarget.ts:82`](../../src/tools/AgentTool/resolveAgentTarget.ts).
Because #1 already registers names in normal mode, resume-by-name already works.

### 3. Role identity — the only genuine "registration" work item.

Confirmed: the role types `agent-mode-coding-worker` /
`agent-mode-verifier` ([`rolePrompts.ts:136`,
`:283`](../../src/agent-mode/rolePrompts.ts)) are registered **only** under
`CLAUDE_CODE_AGENT_MODE`
([`builtInAgents.ts:39`](../../src/tools/AgentTool/builtInAgents.ts)). Making
them spawnable in normal mode is real work. But it is **not** as simple as
flipping the gate — it pulls in items 4, 5, and 6 below.

### 4. Per-role memory — NOT delivered by adding a `memory` field. Bigger than thought.

The first draft said "set a `memory` scope on the roles." **That is
insufficient for built-in agents.** `loadAgentMemoryPrompt()` is appended only
in the **custom** JSON/Markdown agent parsers
([`loadAgentsDir.ts:481`, `:726`](../../src/tools/AgentTool/loadAgentsDir.ts)).
Built-in agents get their prompt from their own `getSystemPrompt()`, and
`runAgent` does **not** generically append memory
([`runAgent.ts:1003-1007`](../../src/tools/AgentTool/runAgent.ts)); `AgentTool`
only logs memory **telemetry** for built-ins
([`AgentTool.tsx:870`](../../src/tools/AgentTool/AgentTool.tsx)). So per-role
memory for these built-in roles requires **new wiring**, not a field.

Two further blockers on memory:

- **The verifier cannot write a gotchas file.** Its definition sets
  `disallowedTools: [Edit, Write, NotebookEdit, ...]`
  ([`rolePrompts.ts:294`](../../src/agent-mode/rolePrompts.ts)). It is
  read-only by contract, so "accumulate gotchas across runs" is impossible
  without either breaking that contract or building a separate read-only
  memory-update mechanism.
- **Memory is keyed by `agentType`**
  ([`agentMemory.ts:52`](../../src/tools/AgentTool/agentMemory.ts)). If normal
  mode and Agent Mode both spawn `agent-mode-coding-worker`, they **share the
  same `agent-memory/<agentType>/` directory** — cross-contamination between an
  orchestrated worker's learnings and a normal subagent's.
- Auto-memory is gated by `isAutoMemoryEnabled()`
  ([`paths.ts:30`](../../src/memdir/paths.ts)), which is disabled not only by
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY` but also by `CLAUDE_CODE_SIMPLE`, remote
  mode without `CLAUDE_CODE_REMOTE_MEMORY_DIR`, and the `autoMemoryEnabled`
  setting.

Per-role memory is therefore **deferred / re-scoped**, not a quick add. See
Open Questions.

### 5. Role prompts → normal-mode variant (option B) — confirmed needed, deeper than "delete 'orchestrator'".

The prompts don't merely mention an orchestrator; they assume the whole
delegation frame: assigned slices, approved plans, synthesis, worktree
ownership, controller-driven completion
([`rolePrompts.ts:86`, `:105`, `:223`](../../src/agent-mode/rolePrompts.ts);
completion-ownership at `:56`, `:108`). A normal-mode variant must **rewrite the
input contract** to "evaluate / implement what the **main agent** asked,"
not "approved plan + implementor handoff." Option B stands, but it is a prompt
**rewrite**, not a find-and-replace.

### 6. `AskOrchestrator` — ungated, BUT a name-mismatch bug means the roles likely never receive it today.

The tool is **not** Agent-Mode-gated: it is in the base tool pool
([`tools.ts:241`](../../src/tools.ts)), has **no `isEnabled()`**
([`AskOrchestratorTool.ts:71`](../../src/tools/AskOrchestratorTool/AskOrchestratorTool.ts)),
and is allowed for async agents
([`constants/tools.ts:69`](../../src/constants/tools.ts)). The first draft was
right that it is ungated.

**But the second review found a real bug that the first draft missed (and that
this draft previously overstated).** There are TWO constants both named
`ASK_ORCHESTRATOR_TOOL_NAME` with DIFFERENT values:

- [`prompt.ts:1`](../../src/tools/AskOrchestratorTool/prompt.ts) → `'ask_orchestrator'`
- [`constants.ts:1`](../../src/tools/AskOrchestratorTool/constants.ts) → `'AskOrchestrator'`

The tool registers its runtime `name` from **prompt.ts** → `'ask_orchestrator'`
([`AskOrchestratorTool.ts:5,72`](../../src/tools/AskOrchestratorTool/AskOrchestratorTool.ts)).
The role `tools` arrays reference the **constants.ts** value `'AskOrchestrator'`
([`rolePrompts.ts:9,150,292`](../../src/agent-mode/rolePrompts.ts)). Tool
resolution is **exact-match by `tool.name`**
([`agentToolUtils.ts:188`](../../src/tools/AgentTool/agentToolUtils.ts)) with no
alias for AskOrchestrator
([`permissionRuleParser.ts:21`](../../src/utils/permissions/permissionRuleParser.ts)).

**Net:** the roles ask for `'AskOrchestrator'`, the tool is `'ask_orchestrator'`,
the lookup misses — so the Agent Mode coding-worker and verifier **likely do not
actually receive the tool their prompts tell them to call**. This is a
pre-existing Agent Mode bug independent of the normal-mode work. It must be
fixed/decided before relying on these tool lists. Flagged separately for its own
fix.

Implication for normal mode: "remove ask_orchestrator from the roles" may be
partly moot (it isn't binding today), but the constant collision must be
resolved so the eventual behavior is intentional in BOTH modes — not left as a
silent mismatch.

---

## What stays Agent-Mode-only (still correct)

- **Durable session-state ledger** `.agent-mode-state.json`
  ([`sessionState.ts`](../../src/agent-mode/sessionState.ts)). Its orchestration
  fields (synthesis, objective, currentPhase, nextAction) have no driver in
  normal mode. Normal mode uses live in-memory `appState.tasks`. The user
  confirmed normal mode needs only live-session management, not cross-restart.
- **The four worker-control tools** — `ListWorkers`, `WaitWorkers`,
  `GetWorkerResult`, `CancelWorker` (each `isEnabled() → isAgentMode()`;
  confirmed at [ListWorkersTool.ts:31](../../src/tools/ListWorkersTool/ListWorkersTool.ts),
  [WaitWorkersTool.ts:46](../../src/tools/WaitWorkersTool/WaitWorkersTool.ts),
  [GetWorkerResultTool.ts:36](../../src/tools/GetWorkerResultTool/GetWorkerResultTool.ts),
  [CancelWorkerTool.ts:30](../../src/tools/CancelWorkerTool/CancelWorkerTool.ts)).

  **Correction to the first draft's equivalence claim:** they are **not**
  cleanly replaced by Task tools.
  - `ListWorkers` ≠ `TaskList`. `TaskList` lists **todo-v2 task records**, not
    a subagent roster or `appState.tasks`
    ([`TaskListTool.ts:66`](../../src/tools/TaskListTool/TaskListTool.ts)).
  - `GetWorkerResult` / `CancelWorker` **partially** overlap `TaskOutput` /
    `TaskStop`, but those require live task IDs and do **not** resolve friendly
    names / worker handles
    ([`TaskOutputTool.tsx:183`](../../src/tools/TaskOutputTool/TaskOutputTool.tsx),
    [`TaskStopTool.ts:60`](../../src/tools/TaskStopTool/TaskStopTool.ts)).
  - `WaitWorkers` overlaps only with `TaskOutput(block=true)` for a **single**
    task ID — there is no wait-all-by-aliases in normal mode.

  So excluding the worker tools is still the right call, but the justification
  is "normal mode doesn't need orchestration-grade roster/convergence," **not**
  "Task tools already do this."

---

## Registration blast radius (from 2nd review — verified)

Registering `agent-mode-coding-worker` / `agent-mode-verifier` in normal mode
touches more than `builtInAgents.ts`:

- **Role-file injection fires automatically.** Built-in agents with those exact
  type names receive `.cat-code/roles/implementor.md` / `verifier.md` injection
  with **no mode gate**
  ([`roleFiles.ts:5`](../../src/agent-mode/roleFiles.ts),
  [`runAgent.ts:1016`](../../src/tools/AgentTool/runAgent.ts)). So keeping the
  type names silently imports any Agent-Mode assumptions baked into those repo
  files into normal mode too. **The first/second drafts under-called this.**
- **Name pools.** Keeping the type names reuses the worker-style pools
  (Turing/Noether…) ([`workerNames.ts:18`](../../src/agent-mode/workerNames.ts));
  renaming needs new pool mappings or generic names.
- **Resume metadata is exact `agentType`.** Renaming requires alias/migration
  for subagent metadata and restored main-thread agent settings
  ([`sessionStorage.ts:333`](../../src/utils/sessionStorage.ts),
  [`resumeAgent.ts:151`](../../src/tools/AgentTool/resumeAgent.ts)).
- **`Agent` tool advertised list + prompt cache.** The list is formatted in
  [`prompt.ts:45`](../../src/tools/AgentTool/prompt.ts) with cache commentary at
  `:50`. Two added role lines ≈ **~1.1 KB / ~280 tokens** if inline; changes
  cache keys and may make the main agent delegate more aggressively.
- **Permission / tool filtering end-to-end** — including the `AskOrchestrator`
  name mismatch above and the nested-`Agent` skip for subagents
  ([`agentToolUtils.ts:203`](../../src/tools/AgentTool/agentToolUtils.ts)).
- **A normal-mode verification type already exists:** existing surfaces target
  `subagent_type="verification"`, **not** `agent-mode-verifier`
  ([`verificationAgent.ts:222`](../../src/tools/AgentTool/built-in/verificationAgent.ts),
  [`prompts.ts:467`](../../src/constants/prompts.ts)). Strongly implies the
  normal-mode verifier should reuse `verification`, not adapt the Agent Mode one.
- **Shared prompt edits risk Agent Mode regressions** unless role prompts / tool
  lists are made mode-specific.

## Out of scope / deferred to implementation

- Per-role memory wiring for built-in roles (item 4) — needs a real mechanism,
  not a field; verifier read-only conflict unresolved.
- Memory scope (`project` vs `local`) and the cross-mode `agentType` sharing
  question.
- Whether to keep `agent-mode-*` type names vs. rename (see blast radius).
- Exact normal-mode role-prompt wording.
- `ask_orchestrator` constant-collision fix + disposition.

---

## Legacy note (corrected)

- **Old run-ledger** — `.cat-code/runs/<run_id>/ledger.json`. The first draft
  said "zero live references." **Wrong:** it is still read for orphaned-worktree
  cleanup at
  [`src/utils/worktree.ts:1169`](../../src/utils/worktree.ts) (parsed via
  `AgentRunFileSchema`). It may be compatibility cleanup only, but it is **not**
  fully removed. Verify intent before assuming it is dead.
- **Live session-state** — `.agent-mode-state.json`
  ([`sessionState.ts`](../../src/agent-mode/sessionState.ts)). Live,
  Agent-Mode-only. This is the "ledger" referenced throughout.

---

## Open Questions — with 2nd-review recommended answers

1. **Type naming.** *Recommended:* for the **verifier**, prefer the existing
   `verification` type in normal mode rather than `agent-mode-verifier`. For the
   coding worker, keep `agent-mode-coding-worker` only if continuity with role
   files / name pools / resume / memory is wanted; otherwise rename. Cost of
   keeping: cross-mode leakage + odd user-facing semantics. Cost of renaming:
   alias/migration across role files, memory dirs, permission rules, resume,
   name pools.
2. **Memory.** *Recommended:* disable verifier memory (read-only contract), and
   do **not** share coding-worker memory across modes by default — memory is
   `agentType`-keyed, so keeping the type name shares state unless the
   key/path gains a mode dimension. Cost: mode-split memory needs path/migration
   work; disabling verifier memory loses persistent verifier preferences.
3. **`ask_orchestrator`.** *Recommended:* first **fix the `AskOrchestrator` vs
   `ask_orchestrator` constant collision** (real bug, see §6 of corrected
   status). Then, for normal mode, remove it from the role tool lists or branch
   the role contract to "return blocked/question to the main agent." Cost:
   mode-specific role defs or an alias-fix plus tests.
4. **Roster surface.** *Recommended:* do **not** import worker-control tools for
   phase 1. Normal mode already has names for `SendMessage` (while running) and
   `ResumeAgent` (after stop); `TaskStop` stays task-id based. Defer a roster
   unless background role use proves hard to manage.
5. **Verifier reuse.** *Recommended:* reuse the existing normal `verificationAgent`
   prompt — it is caller-oriented, adversarial, background, read-only, and emits
   `VERDICT: PASS/FAIL/PARTIAL`
   ([`verificationAgent.ts:222`](../../src/tools/AgentTool/built-in/verificationAgent.ts)).
   The Agent Mode verifier is orchestrator-handoff oriented. Lower behavioral
   risk; less reuse of Agent Mode verifier role files/name pools.
6. **Prompt-cache / agent-list impact.** Registering roles mutates the `Agent`
   tool list ([`prompt.ts:45`](../../src/tools/AgentTool/prompt.ts)); inline mode
   ≈ +280 tokens and new cache keys, attachment mode reduces schema churn but
   still creates listing deltas. Accept the cache churn, but watch for the main
   agent delegating implementation/verification more aggressively once the role
   descriptions are visible.

## New gaps (2nd review)

- **[High] The `AskOrchestrator` name mismatch is an implementation blocker, not
  just a design choice.** Fix the constant collision regardless of the
  normal-mode decision.
- **[High] Role-file injection is under-called** (now captured in Blast Radius):
  keeping the type names auto-imports `.cat-code/roles/*.md` behavior into normal
  mode.
- **[Medium] Option-B scope discipline.** Without a controller, the normal-mode
  role prompt should explicitly **block/return** rather than widen scope when it
  hits ambiguity — the current prompts assume an orchestrator absorbs that.
- **[Medium] Test coverage** must include: normal-mode registration, advertised
  agent list, role-file injection, resolved tool sets, resume-by-name/type, and
  an Agent-Mode no-regression check.
- **[Low] Friendly-name registry cleanup** is imperfect (suffix reuse), already
  treated as a non-goal.

---

## Corrections applied (audit trail vs. first draft)

| First-draft claim | Reality | Source |
|---|---|---|
| Naming coupled to `sessionStateTracking`; must decouple | Naming already works in normal mode via `resolveSystemSubagentName` + `registerAgentName` | AgentTool.tsx:290, :1046; AgentTool.test.ts:28 |
| Per-role memory = add a `memory` field | Built-ins don't get generic memory append; needs new wiring | loadAgentsDir.ts:481/726; runAgent.ts:1003; AgentTool.tsx:870 |
| Verifier can accumulate gotchas | Verifier is read-only (`disallowedTools` blocks Write/Edit) | rolePrompts.ts:294 |
| AskOrchestrator naturally absent in normal mode | Not gated; in base pool + both role tool lists | tools.ts:241; AskOrchestratorTool.ts:71; rolePrompts.ts:150/292 |
| ListWorkers ≈ TaskList; Task tools cover it | TaskList = todo-v2 records; only partial overlap, no name resolution, no wait-all | TaskListTool.ts:66; TaskOutputTool.tsx:183; TaskStopTool.ts:60 |
| Auto-memory only off via one env var | Also off via SIMPLE, remote-without-dir, settings | paths.ts:30 |
| Legacy run-ledger has zero live refs | Still read for worktree cleanup | worktree.ts:1169 |

---

## Revised summary

| Capability | Real status | Work |
|---|---|---|
| Friendly name | Already works in normal mode | **None** |
| Resumable | Already works in normal mode | **None** (verify name resolution) |
| Role identity | Registration gated on Agent Mode | Register in normal mode (pulls in prompt + ask_orchestrator + memory questions) |
| Role prompt | Orchestrator-coupled at the contract level | Rewrite input contract for "main agent," not delete a word |
| `ask_orchestrator` | Present, not gated, in role tool lists | Decide gate/remove/repurpose |
| Per-role memory | Not wired for built-ins; verifier read-only; cross-mode key collision | Deferred — needs a real mechanism + decisions |
| Ledger / worker-control tools / synthesis | Agent-Mode-only | **Excluded by design** |
