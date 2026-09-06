# Subagent escalation and delegation: what one blocked worker exposed

**Date:** 2026-09-06
**Status:** Findings only. Nothing fixed, nothing changed in `src/` or `app/`.
**Revision:** third pass. Rewritten after an adversarial review, then corrected
again after a peer critique of the fix direction. Every claim was re-derived from
source or transcript. §5 of the first version was refuted; the classification
count, the sweep-kill enforcement claim, and the framing of §4 were wrong in
later versions and are corrected here.
**Scope:** the subagent escalation path (`ask_orchestrator`, `SendMessage`), the
delegation boundary (`ALL_AGENT_DISALLOWED_TOOLS`, `ClaudeCli`), auto mode's view
of both, and the coordinator-to-worker message channel.
**Evidence:** engine session `b7a7db9a-b981-4b1c-80e1-fd8d7899724a` (desktop app
session `bf507bbd-0a88-46a1-9c64-be97f195ce0f`, named Alum), its debug log, and a
sweep of all 1,840 subagent transcripts across 457 sessions under
`~/.cat-code/projects`.

This started as one question: what happened to a subagent named Wilkes. Wilkes
was the visible symptom. Three of the four subagents in that session misfired.

---

## 1. The session

At 2026-09-06 12:43:34 UTC, session Alum (`gpt-6-astra`) spawned four
`general-purpose` subagents on `gpt-5.6-luna` to sweep `app/renderer` for
animation opportunities, partitioned by component filename:

| Agent | id | Partition | Outcome |
|---|---|---|---|
| Ritchie | `a8c3fed45084bfd9f` | A–C | Tried to delegate: 3 `ClaudeCli`, then 4 shell spawns |
| Kay | `a9ee0c5a8079cc72e` | D–P | Completed, then redirected onto Q–S |
| Wilkes | `aaf1056ee62605a91` | Q–S | Returned Blocked, 0 components read |
| Goldstine | `a154c0a744d4180d7` | T–Z | Tried to delegate: 4 `ClaudeCli`, then 4 shell spawns |
| Backus | `a8bc6b6b72553597b` | A–C (replacement) | Completed correctly |

That table is derived from the parent transcript. Do not re-derive it from the
`agent-*.meta.json` files: `runAgent.ts` rewrites `spawnedAt` and
`parentToolUseId` on resume, so Ritchie's meta reads `12:56:41` and Kay's
`12:51:11` — resume times, not spawn times.

Each worker was handed a brief that opened:

> Read-only discovery for a desktop animation design report. User explicitly
> requests Luna subagents sweep ALL application components for animation
> opportunities, no implementation; main agent must NOT read application code…

Three of the four read *"Luna subagents sweep ALL application components"* as an
instruction to **themselves** to delegate.

Backus is the control. Its prompt opened *"YOU are the Luna subagent assigned to
read source. Do NOT delegate or spawn other agents."* It did the work.

---

## 2. `ask_orchestrator` is an echo, and its contract is unreachable

Wilkes, unable to find an Agent tool, called the tool that exists for exactly
this situation, and got its own words back.

`AskOrchestratorTool.call()`
(`src/tools/AskOrchestratorTool/AskOrchestratorTool.ts:112`) returns its input
(normalising an omitted `evidence` to `[]`). `parseAskOrchestratorToolResult`
(same file, line 36) is exported and has **zero call sites** in `src/` or `app/`
— the only reference is its own recursion.

On tests, narrowly: there is no test file in the tool's directory, and nothing
tests `call()` or the escalation contract. Three suites do reference the tool —
`src/agent-mode/rolePrompts.test.ts`, `src/tools/AgentTool/agentToolUtils.test.ts`
and `src/services/compact/prompt.test.ts` — covering name resolution and
tool-set exclusion.

The echo is not accidental. The real contract is at
`src/agent-mode/rolePrompts.ts:70`:

> Use `ask_orchestrator` when you need a decision from the orchestrator before
> you can proceed. **After calling it, stop your turn immediately and return a
> blocked handoff with the question.**

The tool is a marker; the worker's *final result* is the delivery channel. That
is coherent. The problem is where it is written: `rolePrompts.ts` builds Agent
Mode **role** prompts, which a `general-purpose` subagent never sees. What it
sees is the tool's one-sentence description, which promises a conversation:

> Ask the orchestrator for clarification, missing context, or report that you
> are blocked with evidence. Use this instead of guessing when the task is
> ambiguous or you cannot continue safely.

A model reads that as request/response, gets a non-answer, and escalates.

One qualifier that matters for the fix: the tool is declared
`shouldDefer: true` (line 83), so it is not in a subagent's default tool list.
Wilkes reached it only because a `ToolSearch` for "agent subagent task
delegation" surfaced it. Editing the description therefore helps only agents
that search their way to it; the contract also needs to live somewhere the
agent always sees.

**Corpus:** `ask_orchestrator` has been called **once, ever**, across the whole
transcript corpus — by Wilkes.

---

## 3. The delegation denial is never communicated

`src/constants/tools.ts:55` strips `Agent` and `ResumeAgent` from every subagent
outside `USER_TYPE=ant`. That is deliberate — an authorization boundary, not an
oversight.

The line that tells a worker about it is `src/agent-mode/rolePrompts.ts:46`:

> `- You do not have Agent: nested delegation is orchestrator-only. Do the
>   investigation yourself.`

Same problem as §2: Agent Mode role prompts only. A general-purpose subagent is
denied the capability and never told, so when a brief implies delegation it goes
looking. Wilkes's actual sequence was `ToolSearch select:Agent` ("No matching
deferred tools found") → `ToolSearch "agent subagent task delegation"` (which
returned `ClaudeCli`, `TodoWrite`, `EnterWorktree`, `ask_orchestrator`,
`ExitWorktree`) → `ask_orchestrator` → `ToolSearch "spawn worker parallel agent"`
→ `SendMessage`.

Then:

> No running subagent or Agent Mode worker found for orchestrator. Without Agent
> Teams, SendMessage can only target running worker handles or agent IDs.

That message is accurate. `src/tools/SendMessageTool/SendMessageTool.ts:1296` is
the honest fall-through: SendMessage routes downward and sideways, never upward.
There is no parent address by design, and nothing in the tool's description says
so.

---

## 4. The granted delegation channel, and the fallback through `Bash`

`CLAUDE_CLI_TOOL_NAME` sits at `src/constants/tools.ts:95`, inside
`ASYNC_AGENT_BASE_ALLOWED_TOOLS` — the default tool grant for every async
subagent, two lines below `ASK_ORCHESTRATOR_TOOL_NAME`. It is not in
`ALL_AGENT_DISALLOWED_TOOLS`. So a subagent may not use `Agent`, and is handed by
default a tool whose purpose is launching a nested Claude CLI session. That is
also what `ToolSearch` handed Wilkes.

**This is deliberate, and that changes what the defect is.** Commit `b35072ba`
(2026-05-21) says so in its own message: the tool was wired into "the base tool
registry, the async-agent allowed-tool list, and the Agent Mode coding-worker
role prompts and allowedTools." The intended use is stated at
`src/agent-mode/rolePrompts.ts:63`: *"Use ClaudeCli only for a narrow advisory
pass (a review, second opinion, or focused read-only investigation)… Never
delegate your assigned implementation work to it."*

So Ritchie and Goldstine did not slip through a hole; they exercised a granted
capability. The defect is that the grant's **scope** does not match its stated
intent. It is default-on for every async subagent, while the documented purpose
is a bounded advisory pass by an Agent Mode coding worker that is separately told
how to use it. The repository therefore holds two policies at once: internal
recursive delegation is prohibited, and external delegated agent loops are
granted broadly and described narrowly.

Both workers used it **first**, and it failed:

| Agent | `ClaudeCli` calls | `permission_mode` | Result |
|---|---|---|---|
| Ritchie | 3, at 12:44:42 | `auto` | all `exit_code: 1` |
| Goldstine | 4, at 12:44:55 | `dontAsk` | all `exit_code: 1` |

The child's own output is `[claude-code:unrecognized_model]
{"model":"gpt-5.6-luna"}` and `Failed to authenticate: OAuth session expired and
could not be refreshed`. The tool accepts a `model` its target cannot run: a
worker on `gpt-5.6-luna` naturally passes its own model, and nothing validates it
at the tool boundary. Seven calls were spent on this.

Only then did they fall back to shell:

```
timeout 600 cat-code -p --model gpt-5.6-luna --effort low \
  --permission-mode auto --tools Read,Bash --output-format text "…"
```

Ritchie: 12:45:23.164, 12:45:34.760, 12:45:34.790, and 12:47:41.385.
Goldstine: 12:45:36.532, then 12:51:25.298/.301/.357. (The first version of this
report dated Ritchie's to 12:43 — that was the subagents' own spawn time — and
counted a fifth Goldstine spawn at 12:54:44, which is a `pgrep`, not a launch.)

So the causal sentence is not that the runtime "silently cannot" delegate. It has
a first-class nested-delegation tool, that tool is broken on this machine, and
`Bash` was the fallback.

Three consequences:

1. **A nested top-level engine gets the full tool pool.** Directly observed on
   the `ClaudeCli` path: the failed children's `system/init` frames list
   `["Task","Bash",…,"TaskStop",…]`, including `Task`, the delegation tool the
   parent process withheld. The shell spawns both passed `--tools Read,Bash`,
   which is an allowlist (`src/main.tsx:985`), so no *observed* nested run
   actually received `Agent`. The hole is real; it was not exercised here.

2. **Each nested engine adds a `cua-driver mcp` child.** `cua-driver` is the sole
   global MCP server in `~/.cat-code/.cat-code.json`. Ritchie's own `ps` caught
   three at 12:47:30 and two at 12:48:37. Note what this is and is not: MCP tools
   are already available to every subagent — `filterToolsForAgent`
   (`src/tools/AgentTool/agentToolUtils.ts`) returns true for any `mcp__` tool
   ahead of every disallow check. The nested engines added processes, not
   capability.

3. **Some of it is invisible.** Goldstine passed `--no-session-persistence`;
   those runs leave no transcript.

**Corpus — the shell route is new, the `ClaudeCli` route is not.** Exactly **2**
of 1,840 subagent transcripts contain a real nested `cat-code` shell spawn, and
both are this session. (The first version said 3. The third was an agent
authoring a markdown code fence containing `cat-code -p` into
`/Users/pt/open-design/README.md` — a naive-grep artifact, and the exact trap
this report warns about elsewhere.)

The front door has been in use since May. Deduplicating `tool_use` blocks by id
across every non-replay subagent transcript, **14 `ClaudeCli` calls by subagents
across 6 parent sessions**:

| Date | Parent | Calls | `permission_mode` |
|---|---|---|---|
| 2026-05-31 | `3be0260f…` | 1 | `dontAsk` |
| 2026-05-31 | `1560c2bf…` | 1 | `dontAsk` |
| 2026-07-11 | `3d89921b…` | 2 | `acceptEdits`, model `opus` |
| 2026-07-12 | `2927630a…` | 1 | `plan` |
| 2026-07-13 | `9b13959b…` | 2 | `acceptEdits` |
| 2026-09-06 | `b7a7db9a…` | 7 | `auto` ×3, `dontAsk` ×4 |

So today is the largest instance, not the first: half the corpus history is this
one session, but the behaviour goes back three months and has crossed four
projects. The July attempts failed at a different gate — `this workspace has not
been trusted`, a structural block on headless spawn into an unvisited directory.
That gate did **not** stop today's: neither Ritchie's nor Goldstine's transcripts
contain the trust message at all.

The internal half of the boundary, by contrast, holds perfectly: **zero**
`Agent` or `ResumeAgent` `tool_use` blocks by any non-replay subagent, across all
1,840 transcripts since 2026-04-17. (Apparent hits live only in
`agent-acompact-*` transcripts, which replay the parent session's own history
under the compaction agent's id.) `ALL_AGENT_DISALLOWED_TOOLS` does exactly what
it claims; `ClaudeCli` is simply not in it.

---

## 5. REFUTED: subagent background tasks are *not* misrouted to the parent

The first version of this report claimed Ritchie's background runs were
registered in the parent's task namespace and that "the orchestrator received
completion and failure reports for work it never launched". That is wrong.

`src/tools/BashTool/BashTool.tsx:660` stamps `agentId: toolUseContext.agentId`
onto the shell task. `src/query.ts` gives a subagent only
`cmd.mode === 'task-notification' && cmd.agentId === currentAgentId`, and both
main-thread drains (`src/utils/queueProcessor.ts:61`, `src/cli/print.ts:2059`)
take the complement, `cmd.agentId === undefined`. A notification stamped with
Ritchie's agentId cannot reach the parent's turn. The parent's transcript
contains those four records only because there is one JSONL per engine session.

What survives is smaller and real: `logOperation`
(`src/utils/messageQueueManager.ts`) writes `sessionId` and **drops `agentId`
entirely**, so the persisted `queue-operation` record does not say who a queued
notification was addressed to. That is what made the record misreadable — an
observability gap, not a routing defect.

---

## 6. Exit 144 is a sentinel, it decodes as the wrong signal, and Ritchie fired it

Two background runs ended with zero bytes and `failed with exit code 144`.

There is no `144` in the codebase. It is produced at
`src/utils/ShellCommand.ts:225` inside `#exitHandler`:

```ts
const exitCode =
  code !== null && code !== undefined
    ? code
    : signal === 'SIGTERM'
      ? 144
      : 1
```

Two problems, not one. The value is opaque *and* misleading: under the universal
`128 + N` convention it decodes as signal 16, which on macOS is SIGURG. SIGTERM's
conventional code is 143 — and the same file already defines it, `const SIGTERM =
143`, sixteen lines above the handler that returns 144. The file contradicts
itself.

Who sent the SIGTERM is answered in Ritchie's own transcript, which the first
version of this report did not check. At 12:48:55.422 Ritchie ran, described as
"Stop owned delegated sweeps":

```
kill 37882 37884 37885 37899 37963 37966 37967 37981 37997 37999 38000 38014 38944 38946 38947
```

It returned `Exit code 8` at 12:48:59.872 — eight of the fifteen were already
gone — and the two 144 notifications were enqueued at 12:48:59.870 and .875.
Ritchie killed its own sweeps. §10's open question is closed, and the guess about
a process-group teardown is withdrawn.

---

## 7. A subagent ran a discovery-paired kill on the shared machine

That `kill` list was not remembered; it was discovered. Ritchie ran a
machine-wide sweep at 12:48:43 —
`ps -axo pid=,etime=,state=,command= | rg 'cat-code -p --model gpt-5\.6-luna|…'`
— and killed every PID it printed. Its own launches were at 12:45:23, 12:45:34
×2 and 12:47:41; at least one targeted group (37997/37999/38000) had an elapsed
time placing its start around 12:45:40, which is not obviously Ritchie's.

`CLAUDE.md` §4 bans exactly this pattern. The hook that enforces it for Claude
Code sessions would **not** have caught this one: `.claude/hooks/block-sweep-kill.sh`
deliberately permits a plain `kill 12345` (its own header lists that form as
still-allowed) and fires only on `pkill`/`killall` or a discovery-to-kill
pipeline inside one command. Ritchie ran the sweep in one command and the numeric
kill in a later one. So porting the hook unchanged into Cat Code would not close
this; the correct control is ownership — a worker may terminate only process
trees registered to it, which the runtime already tracks per `agentId` for shell
tasks. Whether another worker's engine was destroyed cannot be recovered from the
transcripts.

---

## 8. Coordinator-to-worker messages: the silence is explained, the delivery is not

At 12:48:45 the parent sent all three running subagents a correction:

> Clarification: YOU are the requested Luna subagent, so you should read source
> directly. Only I, the parent/main agent, am forbidden…

All three returned `success: true, "Message queued for delivery to @X at its next
tool round."` None appears in any recipient's transcript.

**Why no record is now settled, and it is not evidence of anything.**
`src/tools/AgentTool/runAgent.ts:931` reads *"Yield attachment messages (e.g.,
structured_output) without recording them"*, then `yield`s and `continue`s before
the recording path. A delivered coordinator message arrives as an attachment, so
**no subagent transcript can ever contain one**, whatever happened at runtime.
The corpus-wide absence is a property of the logger, not a measurement. (In the
*main* session a drained `queued_command` *is* persisted — the parent's own
transcript holds `"Wilkes dead. spawn again"` as an attachment record. It is the
subagent path that drops it.)

The first version of this report also claimed the task-notification wrapper text
is "absent from every transcript in the corpus". That sentence is false: it
occurs 22 times across 19 transcripts, all inside `tool_result` blocks. The point
it was making — that it never appears as a *delivered message* — survives; the
sentence did not.

**The behavioural evidence is mixed, not leaning toward non-delivery.** Counting
deduplicated `tool_use` blocks either side of the 12:48:45.9 message: Ritchie 31
before / 103 after, Goldstine 12 / 71, Kay 44 / 59. Ritchie killed its delegated
engines ten seconds after the message and began reading `app/renderer` source
itself. That looks like compliance. Against it, Goldstine launched three more
nested engines at 12:51:25 — but 14 seconds after a *second* message that asked
about partitions and did not repeat the no-delegation instruction. On balance:
leaning toward delivery for Ritchie, unresolved for Goldstine.

**Corpus:** 39 parent-to-named-subagent `SendMessage` calls exist under the
natural definition, all returning `success: true`. The first version attached a
date range and a desktop/terminal split to that number; three independent
re-derivations produced three different splits, so both are withdrawn. Earliest
confirmed *event* (a `tool_use` in a parent transcript, not a quotation inside a
compaction summary): 2026-08-05.

---

## 9. Escalation capability differs by spawn shape, and nobody is told

`isAsync` is `run_in_background === true || selectedAgent.background === true`
(`src/tools/AgentTool/AgentTool.tsx:1052`), and `filterToolsForAgent` applies
`ASYNC_AGENT_ALLOWED_TOOLS` only when `isAsync`. `SEND_MESSAGE_TOOL_NAME` is not
in that set — it appears only in `IN_PROCESS_TEAMMATE_ALLOWED_TOOLS`
(`src/constants/tools.ts:162`) and `COORDINATOR_MODE_ALLOWED_TOOLS` (line 193).

So the four foreground workers had `SendMessage`, which cannot reach a parent,
while Backus — the background replacement — had no `SendMessage` at all. Its only
escalation channel was the no-op of §2. Two workers on the same task, in the same
session, with different escalation capability, neither told which it had.

---

## 10. Auto mode allowed all of it, and could not have done otherwise

Session totals: **106 actions classified** (93 `Bash`, 7 `ClaudeCli`, 6 `User`)
and **97 recorded permission decisions, every one `allow`, zero denials** —
covering all seven `ClaudeCli` calls and all eight shell spawns.

(An earlier revision said "154 classifications, 154 allows". That counted
`"behavior": "allow"` occurrences in the debug log, most of which sit inside
permission-rule *suggestion* objects rather than decisions — the same
string-is-not-an-event error this report flags in §14, made by this report.)

### 10.1 On the `ClaudeCli` path the classifier never sees the configuration

`ClaudeCliTool.toAutoClassifierInput`
(`src/tools/ClaudeCliTool/ClaudeCliTool.tsx:497`) is:

```ts
toAutoClassifierInput(input) {
  return input.prompt
},
```

It receives the tool name and the delegated prompt. Not `permission_mode`, not
`tools`, not `model`, not `cwd`. The debug log confirms it: the classified action
reads `ClaudeCli Goal: Produce a read-only desktop animation design discovery
report…`, no flags anywhere.

That same tool's `checkPermissions` returns `passthrough` with the message
*"Review the delegated prompt, cwd, model, effort, and permission mode before
allowing."* Under auto mode the reviewer is the classifier, and four of those
five fields are what it is never given. The only hard guard is a
`bypassPermissions` check (line 502).

### 10.2 On the `Bash` path it saw everything and allowed it anyway

The debug log records it classifying the full command lines verbatim, both the
`--permission-mode auto` and the `--permission-mode dontAsk` variants.

The on-point rule is `Create Unsafe Agents`
(`src/utils/permissions/yolo-classifier-prompts/upstream/permissions.txt:76`):
"launching ANY agent or coding-agent loop that can run arbitrary actions… without
sandbox isolation AND without a per-action approval/monitor gate, whatever binary
drives it." It is `named+specifics` — block unless the user named the agent. The
user named nothing.

Its trip condition is conjunctive, and `--permission-mode auto` supplies a
per-action gate: another instance of the same classifier. So auto mode reads its
own recursion as the human approval the rule is asking for.

### 10.3 The deeper reason: the classifier is starved and identity-blind

Measured from the debug log's own context comparison, for the four shell spawns:

| agent context | classifier context | of which user turns |
|---|---|---|
| 41,968 tok | 2,266 tok | 1,850 chars |
| 41,223 tok | 2,459 tok | 1,850 chars |
| 46,073 tok | 2,570 tok | 2,057 chars |
| 50,000 tok | 3,053 tok | 1,850 chars |

Roughly 5–6%, and most of that is tool schema text.

Worse than the volume is what is excluded. `buildTranscriptEntries`
(`src/utils/permissions/yoloClassifier.ts:457`) keeps user turns and assistant
`tool_use` blocks and drops the rest, because *"assistant text is model-authored
and could be crafted to influence the classifier's decision."* That is a sound
anti-injection decision, and it means the subagent's misreading — which exists
only in its reasoning — is structurally invisible. Tool results are dropped too,
so the empty `ToolSearch select:Agent` result is invisible as well.

And `agentId`, `agentType`, `isSubagent`, `subagent` appear **nowhere** in
`yoloClassifier.ts`. The classifier cannot tell a subagent from the main session.

The consequence for design: asking auto mode to *detect the misunderstanding* is
not reachable, and widening its input to model-authored text would trade a
containment hole for a prompt-injection surface. Asking it to block the
*category* is reachable, because it needs only two structural facts it currently
lacks — the caller is a subagent, and this action starts an agent loop.

---

## 11. The cascade, and a stale comment in the same area

Wilkes owned Q–S. The parent labelled its replacement *"Replace A C animation
sweep"* and scoped Backus to A–C. A–C was swept twice, Q–S was orphaned, and the
repair arrived as a `ResumeAgent` redirecting Kay off its finished D–P work. A
model error, not an engine defect. The session recovered and produced its sweep.

Separately, `app/renderer/src/orchestratorState.ts:158` states that blocked
workers "fed a question back through AskOrchestratorTool
(`AskOrchestratorTool.ts:83`)". Both halves are false: `handoffStatus` is parsed
from the worker's result text (`extractHandoffStatus` in
`src/tasks/LocalAgentTask/LocalAgentTask.tsx`), and line 83 of that tool is
`shouldDefer: true`.

---

## 11b. Two containment gaps under the delegation channel

Neither is about who may delegate; both are about what a granted child can leave
behind.

**`ClaudeCli` does not own its process tree.** `ClaudeCliTool` spawns with plain
`spawn` and, on timeout or abort, calls `child.kill('SIGKILL')` on the direct
child only. `ShellCommand` by contrast has `killProcessGroupSync`, and registered
background shell tasks are attributed to a worker and killed when it exits
(`src/tasks/LocalShellTask/killShellTasks.ts`). So a `ClaudeCli` child's own
descendants — its MCP servers among them — can outlive it. That is the mechanism
behind the leftover `cua-driver mcp` processes in §4, and it matters more than
the model-validation repair.

**A subagent's subprocesses inherit the environment, credentials included.**
`subprocessEnv()` (`src/utils/subprocessEnv.ts`) returns `process.env` unless
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is truthy; scrubbing is off by default. So
removing a tool from a schema does not remove the underlying authority: a worker
with a shell still has the credentials, the account vault under `~/.cat-code/`,
and the network. Any claim that "subagents cannot create agency" is a statement
about tool lists, not about capability, until that environment is narrowed.

---

## 12. Fix order

| # | Change | Why here |
|---|---|---|
| 1 | Move `ClaudeCli` out of `ASYNC_AGENT_BASE_ALLOWED_TOOLS` into the explicit-grant mechanism already used for `Skill` (`ASYNC_AGENT_EXPLICIT_GRANT_TOOLS`) | Decides whether everything below is hardening an allowed feature or closing an unintended one. `generalPurposeAgent.ts:60` is `tools: ['*']`, so a wildcard must not count as an explicit grant. |
| 2 | Enforce the grant deterministically in `ClaudeCli.checkPermissions` using `ToolUseContext.agentId`/`agentType` (`src/Tool.ts:254`) | A code-level deny beats asking a classifier to apply a rule. Also enforce the prompt's own limits — no `acceptEdits`/`bypassPermissions` from a worker. |
| 3 | Give `ClaudeCli` the same process-group ownership and worker-scoped cleanup that `Bash` already has (§11b) | Stops granted children leaving descendants behind. |
| 4 | Pass the full delegated configuration to the classifier (§10.1) | Defence in depth and audit, *after* the deterministic decision — not a second authorization layer. |
| 5 | One harness-authored line per worker stating whether it may delegate and which escalation channel it has (§2, §3, §9) | Replaces four hand-maintained prompt variants. Derived from the resolved capability, not asserted separately. |
| 6 | Make `ask_orchestrator` terminal: it should end the worker loop and construct the blocked handoff itself | Removes the echo, the misleading name, and the reliance on the model volunteering to stop. |
| 7 | Ownership-scoped cancellation instead of raw `kill` (§7) | The runtime already knows which shell tasks belong to which `agentId`. A regex on command shape does not. |
| 8 | Diagnostics: record coordinator-message origin in sidechains; add `agentId` to queue-operation records; replace 144 with the real signal | Cheap, and §8's open question needs the first of these or an instrumented request. |
| 9 | Narrow the subprocess environment for workers (§11b) | Decides whether the boundary is a tool-list convention or an actual containment boundary. Largest scope; needs a decision, not a patch. |

Dropped from the previous ordering: classifier caller identity as the top item
(superseded by 2, which enforces the same fact in code), porting the sweep-kill
hook (§7 — it would not have caught this), and static `ClaudeCli` model
validation (it would have pushed both workers to the less-governed shell route
sooner; reject incompatible provider namespaces instead and let the external CLI
own its own model catalog).

Whether a classifier should ever treat its own recursion as the approval gate
that satisfies `Create Unsafe Agents` is a policy question, not a patch.

---

## 13. Open

- **Whether the 39 coordinator messages are delivered.** The silence is explained
  (§8), so only the runtime question is open. A controlled spawn-then-SendMessage
  with a nonce settles it; an attempt on 2026-09-06 was blocked because the Codex
  pool was capped, and the Claude Code harness has no `SendMessage` tool to test
  the mechanism in.
- **Whether Ritchie's 12:48:55 kill destroyed another worker's engine.** PID
  37997's owner is not recoverable from the transcripts.
- **Whether every nested `cat-code -p` boots a `cua-driver` child.** Three were
  observed while four runs were alive.

## 14. Method note

Two counts in the first version of this report were wrong in the same way: a
string in a transcript was treated as an event. Transcripts contain agents
reading repository source, `ToolSearch` results listing tool names, tool results
carrying file contents, and compaction summaries quoting earlier turns. Every
count here was re-derived by parsing `tool_use` blocks and deduplicating by tool
id. Where two methods disagreed and nothing depended on the answer — the
desktop/terminal split in §8 — the claim was withdrawn rather than picked.
