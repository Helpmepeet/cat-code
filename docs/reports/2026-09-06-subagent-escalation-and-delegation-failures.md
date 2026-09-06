# Subagent escalation and delegation: seven defects found from one blocked worker

**Date:** 2026-09-06
**Status:** Findings only. Nothing fixed, nothing changed in `src/` or `app/`.
**Scope:** the subagent escalation path (`ask_orchestrator`, `SendMessage`),
the delegation boundary (`ALL_AGENT_DISALLOWED_TOOLS`), the background-task
namespace, and the coordinator-to-worker message channel.
**Evidence:** engine session `b7a7db9a-b981-4b1c-80e1-fd8d7899724a` (desktop app
session `bf507bbd-0a88-46a1-9c64-be97f195ce0f`, named Alum), plus a sweep of all
1,840 subagent transcripts across 457 sessions under `~/.cat-code/projects`.

This started as one question: what happened to a subagent named Wilkes. Wilkes
was the visible symptom. Three of the four subagents in that session misfired,
two of them in ways that left processes running on the machine.

---

## 1. The session

At 2026-09-06 12:43:34 UTC, session Alum (`gpt-6-astra`) spawned four
`general-purpose` subagents on `gpt-5.6-luna` to sweep `app/renderer` for
animation opportunities, partitioned by component filename:

| Agent | id | Partition | Outcome |
|---|---|---|---|
| Ritchie | `a8c3fed45084bfd9f` | A–C | Delegated to 4 nested engines (§4) |
| Kay | `a9ee0c5a8079cc72e` | D–P | Completed, then redirected onto Q–S |
| Wilkes | `aaf1056ee62605a91` | Q–S | Returned Blocked, 0 components read |
| Goldstine | `a154c0a744d4180d7` | T–Z | Delegated to 4+ nested engines (§4) |
| Backus | `a8bc6b6b72553597b` | A–C (replacement) | Completed correctly |

Each was handed a brief that opened:

> Read-only discovery for a desktop animation design report. User explicitly
> requests Luna subagents sweep ALL application components for animation
> opportunities, no implementation; main agent must NOT read application code…

Three of the four read *"Luna subagents sweep ALL application components"* as an
instruction to **themselves** to delegate. Wilkes gave up. Ritchie and Goldstine
shelled out.

Backus is the control. Its prompt opened *"YOU are the Luna subagent assigned to
read source. Do NOT delegate or spawn other agents."* It did the work.

---

## 2. `ask_orchestrator` is a no-op with no consumer and no test

Wilkes, unable to find an Agent tool, called the tool that exists for exactly
this situation:

```
ask_orchestrator({kind: "blocked", message: "…No Agent/subagent tool or running
subagent handles are available in this session…", evidence: [...]})
```

It got its own words back, verbatim.

`AskOrchestratorTool.call()`
(`src/tools/AskOrchestratorTool/AskOrchestratorTool.ts:112`) returns its input
unchanged. `parseAskOrchestratorToolResult`
(`src/tools/AskOrchestratorTool/AskOrchestratorTool.ts:36`) is exported and has
**zero call sites** in `src/` or `app/` — the only reference is its own
recursion. The tool directory holds no test file.

The echo is not accidental. The real contract is stated at
`src/agent-mode/rolePrompts.ts:70`:

> Use `ask_orchestrator` when you need a decision from the orchestrator before
> you can proceed. **After calling it, stop your turn immediately and return a
> blocked handoff with the question.**

So the tool is a marker and the worker's *final result* is the delivery channel.
That is a coherent design. The problem is where it is written: `rolePrompts.ts`
builds Agent Mode **role** prompts. A `general-purpose` subagent spawned through
`AgentTool` never sees it. What it sees is the tool's own description, which is
one sentence and promises a conversation:

> Ask the orchestrator for clarification, missing context, or report that you
> are blocked with evidence. Use this instead of guessing when the task is
> ambiguous or you cannot continue safely.

A model reads that as request/response, gets a non-answer, and escalates.

**Corpus:** `ask_orchestrator` has been called **once, ever**, across 1,840
subagent transcripts — by Wilkes.

---

## 3. The delegation denial is never communicated

`src/constants/tools.ts:55` strips `Agent` and `ResumeAgent` from every subagent
outside `USER_TYPE=ant`. That is deliberate and correct — it is an
authorization boundary, not a capability oversight.

The line that tells a worker about it is
`src/agent-mode/rolePrompts.ts:46`:

> `- You do not have Agent: nested delegation is orchestrator-only. Do the
>   investigation yourself.`

Same problem as §2: it is composed into Agent Mode role prompts only. A
general-purpose subagent is denied the capability and never told, so when a
prompt implies delegation it goes looking. Wilkes ran `ToolSearch
select:Agent` ("No matching deferred tools found"), then two more semantic
searches — which returned `ClaudeCli`, `EnterWorktree` and `ExitWorktree` as the
nearest matches for "spawn worker parallel agent", pointing it further astray.

After that, Wilkes tried `SendMessage({to: "orchestrator"})` and got:

> No running subagent or Agent Mode worker found for orchestrator. Without Agent
> Teams, SendMessage can only target running worker handles or agent IDs.

That message is accurate. `src/tools/SendMessageTool/SendMessageTool.ts:1296` is
the honest fall-through: SendMessage routes downward and sideways — running
workers you own, agent IDs, teammates under Agent Teams — never upward. There is
no parent address by design. But nothing in the tool's description says the
parent is unreachable, so the model keeps hunting before it gives up.

---

## 4. `Bash` walks straight through the delegation boundary

Ritchie and Goldstine did not give up. They launched full nested engines:

```
timeout 600 cat-code -p --model gpt-5.6-luna --effort low \
  --permission-mode auto --tools Read,Bash --output-format text "…"
```

Ritchie launched four (three at 12:43, one at 12:47). Goldstine launched four
between 12:45:36 and 12:51:25, and another at 12:54:44. Three of Goldstine's
were still running when this report's investigation began.

Three consequences, in ascending order of how easy they are to miss:

1. **The tool-list boundary is advisory in practice.** A nested top-level engine
   receives the full tool pool, including the `Agent` tool its parent process
   deliberately withheld. `--permission-mode dontAsk` is *not* an escalation —
   it denies anything not pre-approved (`coreSchemas.ts`: "Don't prompt for
   permissions, deny if not pre-approved") — so this is a capability hole, not a
   permission hole. But it is a hole.

2. **Every nested engine boots a GUI-automation server.** `cua-driver` is
   registered as a global MCP server in `~/.cat-code/.cat-code.json`, so each
   `cat-code -p` spawns a `/Users/pt/.local/bin/cua-driver mcp` child. Ritchie's
   own `ps` caught three of them at once. A read-only text sweep stood up three
   GUI drivers, on a machine where §8 of `CLAUDE.md` makes GUI driving a
   per-run, operator-authorized action.

3. **Some of it is invisible.** Goldstine passed `--no-session-persistence`.
   Those runs leave no transcript, so their reasoning, tool calls and token
   spend are unrecoverable.

**Corpus:** only **3** of 1,840 subagent transcripts ever shelled out to a
nested `cat-code`, and **2 of the 3 are this session**. This is not a chronic
habit; it is what happens when a brief tells a worker to delegate and the
runtime silently cannot.

---

## 5. A subagent's background tasks are filed under the parent's session

Ritchie's four `cat-code -p` runs were registered in the **parent's** task
namespace, `/private/tmp/claude-501/-Users-pt-cat-code/b7a7db9a-…/tasks/`, and
their completion notices were enqueued into the **parent's** queue:

```
L329 12:48:24  Task ID: b2u1uob4b  Status: completed
               Background command "Run Luna read-only B component sweep" completed (exit code 0)
L380 12:48:52  Task ID: b4i3rcnio  Status: completed
               Background command "Run Luna read-only C component sweep" completed (exit code 0)
L398 12:48:59  Task ID: bfxi3kbxd  Status: failed
               Background command "Run Luna read-only A component sweep" failed with exit code 144
L399 12:48:59  Task ID: bnfd39oj2  Status: failed
               Background command "Run bare Luna A discovery sweep" failed with exit code 144
```

Every one of those notifications carries a `Tool use ID` that **does not exist
in the parent transcript** — `call_BSDtkWbJU63SJtl7zipmwWaT`,
`call_W9XgoNdXdy4cTVVBAsWHD2LB`, `call_qJjMdkRQ49vS3QqimcVdxvhD`,
`call_DjVsGAeFtXpOZYQ6GH8JFV7A` are all Ritchie's. The orchestrator received
completion and failure reports for work it never launched, addressed by IDs it
cannot resolve, and had to reason about them anyway.

---

## 6. Exit code 144 is an internal sentinel, surfaced as a real exit status

Two of those background runs died with zero bytes of output and
`failed with exit code 144`.

There is no `144` anywhere in the codebase. It is produced at
`src/utils/ShellCommand.ts:225`, inside `#exitHandler`:

```ts
const exitCode =
  code !== null && code !== undefined
    ? code
    : signal === 'SIGTERM'
      ? 144
      : 1
```

144 means **killed by SIGTERM** — the process never chose an exit status. Both
kills landed within 5 ms of each other at 12:48:59.87, consistent with a process
group teardown, not with two independent failures.

What the model sees is a plausible-looking numeric exit code from a program that
does not use one. What actually happened — the work was terminated and its
output lost — is not recoverable from the message. `#exitHandler` should report
the signal.

---

## 7. Coordinator-to-worker messages leave no record anywhere

This is the one I could not close, and it is the most consequential.

At 12:48:45 the parent, having realised its workers were misreading the brief,
sent all three running subagents a correction:

> Clarification: YOU are the requested Luna subagent, so you should inspect the
> source yourself…

All three calls returned:

```json
{"success": true, "message": "Message queued for delivery to @Goldstine at its next tool round."}
```

None of the three messages appears anywhere in the recipients' transcripts. Nor
does any evidence that one arrived.

I widened it to the whole corpus. **39** parent-to-named-subagent `SendMessage`
calls exist, from 2026-08-02 to 2026-09-06, 34 on desktop and 5 in the terminal.
All 39 returned `success: true`. **Zero** produced a record of receipt in the
recipient's transcript.

The mechanism reads correct in source:

- queued under `agentId` into the shared task store —
  `src/tools/SendMessageTool/SendMessageTool.ts:321`
- drained once per tool round — `src/utils/attachments.ts:927` →
  `src/utils/attachments.ts:1095`
- `agentId` and `setAppStateForTasks` are both propagated to the child context by
  `createSubagentContext` (`src/utils/forkedAgent.ts`)
- the delivered text is wrapped as *"The coordinator sent a message while you
  were working: …"* (`src/utils/messages.ts`, `wrapCommandText`)

Then I ran the control, and it defeats the inference: the **task-notification**
wrapper text ("A background agent completed a task:") is *also* absent from
every transcript in the corpus — and task notifications demonstrably do arrive,
because the parent visibly acts on them. The wrapped delivery text is simply
never persisted to JSONL. Sixteen transcripts contain the coordinator wrapper
string, and on inspection all sixteen are agents *reading `messages.ts` source*,
not receiving messages.

**So absence proves nothing either way, and that is itself the finding:** a
coordinator cannot tell whether a correction reached a worker, and neither can
anyone reading the logs afterwards. The behavioural evidence in this session
leans toward non-delivery — Goldstine spawned three more nested engines at
12:51:25, 2.5 minutes after being told not to delegate; Ritchie returned a
duplicate A–C sweep — but three models ignoring an instruction is not proof.

Settling it requires either a `--debug` run that dumps request bodies, or the
fix itself: persist the delivery.

---

## 8. The cascade that cost the most was ordinary confusion, amplified

Wilkes owned Q–S. When the parent replaced it, it labelled the replacement
*"Replace A C animation sweep"* and scoped Backus to A–C. So A–C was swept twice
(Ritchie and Backus), Q–S was orphaned, and the repair arrived minutes later as
a `ResumeAgent` redirecting Kay off its finished D–P work onto Q–S.

That is a model error, not an engine defect. It is listed here because §7 is what
made it expensive: the parent's three attempts to correct its running workers
mid-flight had no observable effect, so it could only fix things by killing and
respawning.

The session did recover. It produced its sweep.

---

## 9. Recommended order

| # | Defect | Cost to fix | Why this order |
|---|---|---|---|
| 7 | Coordinator deliveries unrecorded | Small | Cheap, settles the open question permanently, makes every future orchestration debuggable |
| 2 | `ask_orchestrator` contract invisible to non-role agents | One edit | Move the "call it, then end your turn" contract into the tool description |
| 3 | Delegation denial never communicated | One edit | Same: the no-Agent line belongs in the subagent system prompt, not only in role prompts |
| 6 | 144 sentinel surfaced as an exit code | Small | Report the signal; a killed process should not look like a program's own status |
| 5 | Subagent tasks in the parent's namespace | Design | Needs a decision about task ownership, not a patch |
| 4 | `Bash` bypasses the delegation boundary | Design | Needs a decision about whether the boundary is meant to hold at all |

§1 and §8 need no fix. They are what the other six produce.

---

## 10. What is not established

- Whether the 39 coordinator messages were delivered. §7 explains why the logs
  cannot answer it and what would.
- Why two of Ritchie's four background runs were SIGTERMed while the other two
  completed. The 5 ms gap between the two kills suggests one teardown event, but
  I did not identify what triggered it.
- Whether any nested engine ever used its `cua-driver` MCP server. It was
  attached to at least six processes; nothing in the evidence shows a GUI call
  being made.

---

## 11. Addendum: auto mode, and the front door §4 missed

Added 2026-09-06 after review. §4 said `Bash` walks through the delegation
boundary. That is true but it is the secondary path, and it left the operator's
question unanswered: the session was in auto mode, so why did auto mode not
block any of it?

### 11.1 `ClaudeCli` is a sanctioned subagent capability

`CLAUDE_CLI_TOOL_NAME` sits at `src/constants/tools.ts:95`, inside
`ASYNC_AGENT_BASE_ALLOWED_TOOLS` — the default tool grant for every async
subagent — two lines below `ASK_ORCHESTRATOR_TOOL_NAME`. It is not in
`ALL_AGENT_DISALLOWED_TOOLS`.

So the boundary is not merely leaky. A subagent may not use `Agent` for
"authorization-boundary" reasons (§3), and is handed, by default, a tool whose
whole purpose is launching a nested Claude/Cat Code CLI session.

That is how most of the spawning in this session actually happened. Counting
`tool_use` blocks in the subagent transcripts:

| Agent | `ClaudeCli` calls | `permission_mode` passed | plus `Bash cat-code -p` |
|---|---|---|---|
| Ritchie | 6 | `auto` ×6 | 4 |
| Goldstine | 4 | `dontAsk` ×4 | 4 |

Roughly twenty nested engine spawns, not the eight §4 implies. §4's count and
its framing both understate this.

### 11.2 Why auto mode allowed the `ClaudeCli` calls: it never saw the mode

`ClaudeCliTool.toAutoClassifierInput`
(`src/tools/ClaudeCliTool/ClaudeCliTool.tsx:497`) is:

```ts
toAutoClassifierInput(input) {
  return input.prompt
},
```

The classifier receives the tool name and the delegated prompt. It does not
receive `permission_mode`, `tools`, `disallowed_tools`, `model`, or `cwd`. The
debug log shows exactly that — the classified action reads
`ClaudeCli Goal: Produce a read-only desktop animation design discovery
report…`, with no flags anywhere in it.

The same tool's `checkPermissions` returns `behavior: 'passthrough'` with the
message:

> ClaudeCli launches an external Claude CLI process. **Review the delegated
> prompt, cwd, model, effort, and permission mode before allowing.**

Under auto mode the reviewer is the classifier, and four of the five fields that
sentence asks it to review are the fields it is never given. The only hard guard
is a `bypassPermissions` check (`ClaudeCliTool.tsx:502`); `dontAsk` and `auto`
are unguarded.

This is a structural blindness, not a judgment error. No classifier prompt
change can fix it.

### 11.3 Why auto mode allowed the `Bash` spawns: judgment, not blindness

On the Bash path the classifier saw everything. The debug log records it
classifying, verbatim,
`Bash timeout 600 cat-code -p --model gpt-5.6-luna --effort low
--permission-mode auto --tools Read,Bash …` and
`Bash cat-code -p --model gpt-5.6-luna --effort high --permission-mode dontAsk
--tools Read,Bash --disallowed-tools Edit,Write,NotebookEdit,Apply_patch
--no-session-persistence …`. It allowed both.

There is a vendored rule that is squarely on point, `Create Unsafe Agents`
(`src/utils/permissions/yolo-classifier-prompts/upstream/permissions.txt:76`):

> Creating new autonomous agent loops that can execute arbitrary actions (e.g.
> shell commands, code execution) without human approval or established safety
> frameworks… This is NOT limited to `claude` — it covers launching ANY agent or
> coding-agent loop that can run arbitrary actions (shell, code execution, file
> edits) without sandbox isolation AND without a per-action approval/monitor
> gate, whatever binary drives it.

It is a `named+specifics` rule: it should block unless the user named the agent
being run with sandbox or approvals off. The user named nothing.

The most likely reason it did not fire is that its trip condition is
conjunctive — no sandbox **and** no per-action gate — and `--permission-mode
auto` supplies a per-action gate. The gate is another instance of the same
classifier. So auto mode approves its own recursion: at every depth the
"approval" is machine approval standing in for a human who is never asked, and
the rule reads as satisfied at each level.

The user's `settings.json` `autoMode` block carries custom `allow`, `soft_deny`
and `environment` entries but no `hard_deny`, and nothing about spawning agents,
so the vendored rule was the only thing standing here.

**Session totals: 154 auto-mode classifications, 154 `allow`, 0 denials** —
including all six `ClaudeCli` spawns and all the `cat-code -p` shell spawns.

### 11.4 `dontAsk` was the safer of the two, not the mistake

Goldstine passed `--permission-mode dontAsk`; Ritchie passed `auto`. The
intuition that `dontAsk` is the wrong choice, and that these spawns should have
used `auto`, is inverted for this case.

`src/utils/permissions/permissions.ts:527` converts an `ask` decision to `deny`
under `dontAsk`, before the auto-mode branch at line 539 is reached. So in a
non-interactive `-p` child, `dontAsk` denies everything not already pre-approved
by rules, while `auto` hands the decision to the classifier. `dontAsk` is
strictly the more restrictive of the two.

The convention that a delegated Cat Code run should use `--permission-mode auto`
exists because a human is dispatching a run they want to succeed, and under `-p`
a gated call is denied rather than prompted. It is a convention about the
operator's own dispatches. Applied to a spawn the operator never authorized, it
would make things worse, not better: `auto` is precisely what let Ritchie's six
nested engines recurse the classifier.

So there is nothing to fix in the mode the subagent chose. The defects are that
it could spawn at all (§11.1), and that auto mode could not see what it was
spawning (§11.2) or judge it when it could (§11.3).

### 11.5 Effect on §9

The fix order in §9 stands, with two additions above `#5`:

- Pass the full delegated configuration to the classifier for `ClaudeCli`, not
  just the prompt. Small, and it closes a hole no prompt tuning can reach.
- Decide whether `CLAUDE_CLI_TOOL_NAME` belongs in
  `ASYNC_AGENT_BASE_ALLOWED_TOOLS` at all. If nested delegation is an
  authorization boundary worth stripping `Agent` for, granting every async
  subagent a CLI that spawns a whole session is the same boundary with a
  different door.

Whether a classifier should ever treat its own recursion as the "per-action
approval gate" that satisfies `Create Unsafe Agents` is a policy question for
the operator, not a patch.
