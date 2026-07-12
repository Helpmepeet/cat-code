# ResumeAgent and SendMessage cold review

Date: 2026-07-12

## Verdict: RED

The local-subagent API split is conceptually correct and its ordinary paths work:

- `Agent` starts a new local worker.
- `SendMessage` queues input to a local worker that is currently running.
- `ResumeAgent` reconstructs a stopped local worker from its transcript and starts a new background lifecycle.

Agent Teams is a different lifecycle. A teammate can be idle while its long-lived process or in-process loop remains alive; `SendMessage` wakes or queues work for that teammate. A terminated teammate is not a `ResumeAgent` target. The implementation does not consistently preserve or teach this distinction.

The review found one High-severity identity defect and four Medium-severity routing or contract defects. The High finding can merge distinct teammate identities or route messages through the same mailbox, so the control surface should be reworked before it is treated as reliable.

## Contract and conformance

The separation contract is stated in `docs/superpowers/plans/2026-05-12-separate-resume-from-sendmessage-plan.md:6-18` and the current routing map at `docs/maps/agent-mode.md:26-37`. The local-subagent implementation conforms on the ordinary path:

- `ResumeAgent` rejects a running local task and calls the resume primitive for a stopped target: `src/tools/ResumeAgentTool/ResumeAgentTool.tsx:115-155`.
- `SendMessage` queues only to a running local task and returns `ResumeAgent` guidance for a resolved stopped target: `src/tools/SendMessageTool/SendMessageTool.ts:851-888`.
- `resumeAgentBackground` reloads transcript and metadata, registers the replacement task, and starts a detached lifecycle: `src/tools/AgentTool/resumeAgent.ts:93-149`, `src/tools/AgentTool/resumeAgent.ts:231-306`, `src/tools/AgentTool/resumeAgent.ts:317-371`.

The May 12 plan explicitly excluded teammate/swarm lifecycle changes at `docs/superpowers/plans/2026-05-12-separate-resume-from-sendmessage-plan.md:405-412`. There is therefore no complete current contract for what the model should do with a terminated teammate. That omission is now visible through conflicting schemas and prompts.

## Findings

### F1 — High — Teammate names can collapse into the same identity or mailbox

**Defect.** Teammate uniqueness is checked against the raw requested name before canonicalization, while deterministic agent IDs and mailbox paths use different canonicalizers. Reserved `SendMessage` recipient syntax is also accepted as a teammate name.

**Evidence.**

- Raw case-insensitive uniqueness is checked at `src/tools/shared/spawnMultiAgent.ts:267-294`.
- Only afterward is `@` changed to `-`, then the deterministic teammate ID is built: `src/tools/shared/spawnMultiAgent.ts:329-336` and `src/tools/shared/spawnMultiAgent.ts:864-871`.
- `sanitizeAgentName` replaces only `@`: `src/utils/swarm/teamHelpers.ts:104-110`.
- Mailboxes replace every non-alphanumeric, non-hyphen, non-underscore character with `-`: `src/utils/teammateMailbox.ts:79-92` and `src/utils/tasks.ts:212-219`.
- `SendMessage` reserves `"*"` for broadcast at `src/tools/SendMessageTool/SendMessageTool.ts:901-904`, but teammate spawn accepts it.
- `uds:`, `bridge:`, and leading `/` are also reserved by `src/utils/peerAddress.ts:7-20`. Those collisions are latent in custom builds because `UDS_INBOX` is not in the external `dev-full` feature set at `scripts/build.ts:13-50`.

**Failure scenarios.**

1. Existing teammate `foo-bar`; spawn `foo@bar`. The raw uniqueness check sees different strings, but the second name becomes `foo-bar`, producing the same deterministic agent ID. In-process mode can then run two task loops while `teamContext` exposes only the later agent-ID-keyed entry.
2. Teammates `foo.bar` and `foo-bar` have distinct roster names and IDs but both use `foo-bar.json` as their mailbox. Messages can be consumed by the wrong teammate.
3. A teammate named `*` is returned as successfully spawned but cannot be addressed individually because every `SendMessage` to `*` broadcasts.

**Disposition.** Agent Teams owner. Define one canonical teammate-name function, apply it before uniqueness checks, reject reserved recipient forms, and use the same canonical identity for roster, deterministic ID, routing, and mailbox path. Add collision and reserved-name tests for every spawn backend.

### F2 — Medium — Agent Teams mailbox sends can report success without a recipient or a successful write

**Defect.** The teammate fallback accepts any unresolved string, creates an inbox even when no such teammate exists, and reports success even if the mailbox write fails.

**Evidence.**

- An unresolved plain recipient falls through directly to `handleMessage`: `src/tools/SendMessageTool/SendMessageTool.ts:851-912`.
- `handleMessage` does not check the team roster or teammate task state before returning `success: true`: `src/tools/SendMessageTool/SendMessageTool.ts:156-195`.
- `writeToMailbox` creates a new inbox for an arbitrary name: `src/utils/teammateMailbox.ts:208-235`.
- Mailbox creation, locking, read, and write errors are logged and swallowed rather than propagated: `src/utils/teammateMailbox.ts:222-265`.
- The existing mailbox test covers only a known `alice` member: `src/tools/SendMessageTool/SendMessageTool.test.ts:381-430`.

**Failure scenario.** A model mistypes `alic` or the filesystem is read-only/full. `SendMessage` returns `Message sent to alic's inbox`, but no running teammate will consume the orphan inbox, or the write did not occur at all. The model proceeds as if coordination succeeded.

**Disposition.** Agent Teams messaging owner. Validate ordinary teammate recipients against the current team roster and propagate mailbox write failure as `success: false`. Idle teammates may remain valid; nonexistent or terminated members should fail with a concrete next action.

### F3 — Medium — In-process teammates receive control instructions for tools absent from their runtime pool

**Defect.** The in-process teammate prompt is assembled from the leader's unfiltered tool pool, then the actual teammate tools are filtered later. In external builds, the intended nested-`Agent` exception is unreachable because the blanket disallow check runs first. In internal builds where nested `Agent` is available, completed synchronous subagent results instruct the teammate to call `ResumeAgent`, but `ResumeAgent` is not in the in-process teammate allowlist.

**Evidence.**

- External builds compile `USER_TYPE` as `external`: `scripts/build.ts:132-140`.
- External subagents blanket-disallow `Agent` and `ResumeAgent`: `src/constants/tools.ts:46-55`.
- `filterToolsForAgent` returns on that blanket disallow before reaching the in-process `Agent` exception: `src/tools/AgentTool/agentToolUtils.ts:94-125`.
- The in-process teammate allowlist adds `SendMessage`, not `ResumeAgent`: `src/constants/tools.ts:114-130`.
- The teammate system prompt is prebuilt from `toolUseContext.options.tools` before resolved-tool filtering: `src/utils/swarm/inProcessRunner.ts:1002-1017`; filtering occurs later at `src/tools/AgentTool/runAgent.ts:559-577`.
- The Agent prompt says stopped agents use `ResumeAgent` and says in-process teammates support synchronous subagents: `src/tools/AgentTool/prompt.ts:397-409`.
- A completed synchronous Agent result also emits a literal `ResumeAgent(...)` instruction: `src/tools/AgentTool/AgentTool.tsx:1992-2008`.

**Failure scenario.** An external in-process teammate is taught to use nested `Agent`/`ResumeAgent` despite neither being callable. In an internal build, it can run a synchronous subagent, receive a literal resume instruction, then fail because `ResumeAgent` was filtered out. Models may compensate by calling `Agent` again, searching for the absent tool, or sending the wrong control message.

**Disposition.** Agent runtime owner. Decide the intended external in-process capability first. Then generate tool guidance from the resolved tool pool, move the intended `Agent` exception before blanket rejection if nested sync agents are supported, and make continuation guidance capability-aware. Add a test comparing rendered prompt/tool-result instructions with the actual in-process tool names.

### F4 — Medium — Running/stopped decisions use stale AppState and can misroute or double-resume

**Defect.** Both tools capture `AppState` before asynchronous target resolution and use that old snapshot afterward. The resume guard covers only setup and is released as soon as the detached lifecycle is scheduled; the primitive does not recheck fresh root task state.

**Evidence.**

- `ResumeAgentTool` captures state, awaits resolution, then reads task status from the captured object: `src/tools/ResumeAgentTool/ResumeAgentTool.tsx:115-143`.
- `SendMessageTool` does the same: `src/tools/SendMessageTool/SendMessageTool.ts:855-870`.
- Target resolution can perform metadata, durable-state, and transcript I/O: `src/tools/AgentTool/resolveAgentTarget.ts:217-312`.
- `activeResumeLaunches` is removed after scheduling setup returns: `src/tools/AgentTool/resumeAgent.ts:77-90`, while the lifecycle itself continues fire-and-forget at `src/tools/AgentTool/resumeAgent.ts:331-371`.
- Task registration replaces an existing task, including its visible controller/state: `src/utils/task/framework.ts:69-94`.
- The REPL is a separate caller of the resume primitive: `src/screens/REPL.tsx:3937-3958`.
- The existing race test starts two calls together and only proves overlap while `activeResumeLaunches` is held: `src/tools/ResumeAgentTool/ResumeAgentTool.test.ts:591-639`.

**Failure scenarios.**

1. A delayed `SendMessage` resolver holds a stopped snapshot while another path resumes the worker. It returns false `ResumeAgent` guidance even though the worker is now running.
2. A delayed resume caller captures stopped state, another caller schedules a lifecycle and releases `activeResumeLaunches`, then the delayed caller enters the primitive. It registers a second running task and launches a second lifecycle with the same agent ID and transcript.
3. A worker stops after `SendMessage` captured running state. The message is appended to the stopped task and reported as queued, but it will not execute until a later resume.

Ordinary tool calls in one model response are serialized because the tool defaults to non-concurrency-safe, which narrows reachability. REPL-versus-tool and other overlapping entry paths remain possible, and impact is high when the race occurs.

**Disposition.** Local-agent lifecycle owner. Re-read root task state after resolution and enforce the running/resuming invariant inside the resume primitive. The ownership guard must survive until lifecycle ownership is safely transferred, not merely until detached scheduling returns. Add a delayed-resolution test and a REPL-versus-tool-equivalent test.

### F5 — Medium — Agent's `name` schema promises ResumeAgent support for teammate identities

**Defect.** The same `name` field has two lifecycle meanings, but its model-facing schema promises `ResumeAgent` continuation unconditionally.

**Evidence.**

- The schema says a named agent is addressable by `SendMessage` while running and by `ResumeAgent` after stopping: `src/tools/AgentTool/AgentTool.tsx:355-364`.
- With a team context, `name` routes the call to `spawnTeammate`: `src/tools/AgentTool/AgentTool.tsx:562-593`.
- `ResumeAgent` explicitly excludes teammate names: `src/tools/ResumeAgentTool/ResumeAgentTool.tsx:23-30`.
- The teammate result correctly describes mailbox delivery rather than resume: `src/tools/AgentTool/AgentTool.tsx:1913-1929`, so the schema and result teach different contracts.

**Failure scenario.** A team leader follows the input schema after a teammate terminates and calls `ResumeAgent({agentId: name, ...})`. Resolution fails or, if a local subagent has the same alias, targets that unrelated local worker.

**Disposition.** Agent tool-contract owner. Make the schema conditional on the route: local named subagent versus teammate identity. Explicitly state that terminated teammates are replaced with `Agent`, while idle/running teammates use `SendMessage`.

## Test gaps

The focused tests pass but do not exercise the findings above:

- no delayed target-resolution race after the launch guard is released;
- no prompt-versus-runtime-tool comparison for in-process teammates;
- no nonexistent teammate or mailbox-write-failure test;
- no reserved teammate-name test;
- no post-sanitization identity collision or mailbox canonicalization collision test;
- no Agent Teams schema assertion distinguishing local names from teammate names.

## Verification

Command run:

```bash
bun test src/tools/ResumeAgentTool/ResumeAgentTool.test.ts src/tools/SendMessageTool/SendMessageTool.test.ts src/tools/SendMessageTool/UI.test.tsx src/tools/AgentTool/AgentTool.test.ts src/tools/AgentTool/prompt.test.ts src/tools/AgentTool/resumeAgent.test.ts src/tools/AgentTool/resolveAgentTarget.test.ts src/tools/AgentTool/agentToolUtils.test.ts src/utils/swarm/inProcessRunner.test.ts
```

Result: **83 pass, 0 fail, 215 assertions across 9 files**.

No implementation files were modified. A full engine build was not run because this was a source review with a report-only documentation addition; the focused suites establish the current tested baseline but do not invalidate the uncovered missing cases.
