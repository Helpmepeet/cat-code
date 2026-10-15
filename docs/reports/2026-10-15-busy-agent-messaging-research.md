# Busy agent messaging research and transcript findings

Date: 2026-10-15, Asia/Bangkok. Scope: user-to-agent, desktop peer-to-peer, and parent-to-subagent communication in Cat Code. Source baseline: checkout HEAD `008dc331ee27d8467cc584a648e235d5ba0454b1`, including existing uncommitted changes. This is a research report, not an implemented design.

## Main conclusion

Keep the queues. Make their scheduling behavior explicit, report delivery truthfully, and separate execution controls from conversational instructions. Cat Code already supports delivery during active work on several paths. The central problem is that different paths expose different meanings of “sent,” “delivered,” “finished,” and “stop.”

Real transcripts show both useful mid-run coordination and consequential failures: a peer question waited over 35 minutes after a “delivered” receipt; a productive interview hit the loop guard; an urgent subagent instruction remained unconfirmed; and a useful worker handoff was displaced by a later acknowledgment. These observations justify focused changes to existing mechanisms before adding a new messaging service or universal protocol.

## Evidence and interpretation

Three evidence classes are kept separate:

- **Observed:** historical sender and recipient transcripts, correlated by tool-use ID, queue UUID/source UUID, message body, worker identity, and timestamp.
- **Source-derived:** current implementation behavior inspected in this dirty shared checkout. Historical runs used older builds, including `2.1.280-desktop.shab79a1dfb` and `2.1.280-desktop.sha5cd53c0e`; their behavior is not automatically a reproduction on today's build.
- **Proposed:** design choices and validation scenarios inferred from the observations and external documentation.

Transcript samples are selected examples from October 6–14, not a representative latency benchmark. Queue insertion, attachment preparation, transcript persistence, provider response, understanding, and action completion are different events. In particular, local-worker attachment timestamps are not provider acknowledgment timestamps: current code records those attachments after a valid response while retaining their earlier creation timestamp. The previously reported 0.7–23.6 second worker timings must be read as send-to-recorded-attachment-timestamp intervals, not verified read or action latency. See [worker transcript recording](/Users/pt/cat-code/src/tools/AgentTool/runAgent.ts:1176) and [provider confirmation](/Users/pt/cat-code/src/query.ts:1119).

The bundled session inspector was used for discovery and timelines, with fielded JSON searches and a small read-only cross-file correlation for timing. Replayed rows and repeated terminal records are not counted as independent executions. A tool result labeled “ok” by the inspector can still contain `success: false` or `delivery: not_delivered`; the structured result controls interpretation. Peer messages stored with a user role are not human instructions.

## What other systems do

Public documentation was checked on 2026-10-15. These are documented contracts, not comparative runtime benchmarks. The systems operate at different layers; a protocol or deployment service is not a drop-in harness implementation.

| System and layer | Documented handling while busy | Relevant lesson |
|---|---|---|
| Pi coding-agent RPC | `steer` queues input after the current assistant turn's tool calls and before the next model call. `follow_up` waits until no tool calls or steering messages remain. Prompt responses distinguish `queued`, `started`, and `handled`, without promising completion. `abort` waits for idle; queue clearing is separate. | Separate scheduling intent from acceptance and completion. [RPC commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md) |
| Codex app-server and IDE | `turn/steer` appends input to an active turn and requires matching `expectedTurnId`; it fails without an active turn. `turn/interrupt` requests cancellation. IDE settings expose queue-versus-steer behavior. | Bind steering to the intended execution and make concurrency behavior visible. [App-server](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn), [settings](https://learn.chatgpt.com/docs/developer-settings#editor-settings-reference) |
| Claude Code user input | Normal queued input waits for a delivery boundary after tool calls. Send-now handling can background eligible work or interrupt. Queue recall is available. | Safe-boundary delivery and explicit interruption can coexist. [Interactive input](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works) |
| Claude Code cross-session messages | Busy recipients receive messages between tool calls; idle recipients start a turn. A separate idle subscription can wait without starting a recipient turn or spending recipient tokens. | Separate useful messages from lifecycle polling. Idle means a turn finished with nothing queued, not proof of objective completion. [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) |
| LangGraph Agent Server / LangSmith Deployment | Enqueue is the default; reject, interrupt, and rollback policies are available. Interruption requires handling partially completed tool calls. This feature is not supplied by the open-source graph framework alone. | Choose explicit concurrency policy. Graph-state rollback must not be interpreted as undoing external side effects. [Double texting](https://docs.langchain.com/langsmith/double-texting) |
| Claude Managed Agents | Event sending and processing are distinct. `processed_at` remains unset while a sent event waits, with documented exceptions for events processed on receipt. Interrupt events have a processing lifecycle too. | Expose queue acceptance separately from processing. [Event lifecycle](https://platform.claude.com/docs/en/managed-agents/events-and-streaming) |
| A2A protocol | Message identity, task identity, task states, status retrieval, and subscriptions are distinct. Tasks can request more input using their existing task/context identity. | Correlate communication with work, without assuming the protocol prescribes a harness interruption policy. [Specification](https://a2a-protocol.org/v1.0.0/specification/) |

Provider-level steering is a separate capability from harness queue draining. OpenAI documents mid-turn steering and explicitly limits its effect on already executed actions and started tools. Its availability does not establish that Cat Code currently uses it. [Mid-turn steering](https://developers.openai.com/api/docs/guides/steering)

The transferable pattern is an explicit contract, not “always interrupt.” Frequent interruption can waste work, leave partial tool results, and destabilize tasks. Deferring every message until completion instead delays corrections and can block collaborators.

## Current Cat Code paths

| Path | Current behavior and available guarantees | Main gap |
|---|---|---|
| Desktop user to main agent | Busy input enters the queue and can join the active run after tools finish. Force-send interrupts ordinary active work but targets the queue head; workspace handoff settlement has additional gating. | No consistent steer/follow-up choice; an urgent non-head message cannot independently force its way through. |
| Desktop peer to peer | Host assigns a message ID, retains pending delivery in memory, uses consumption acknowledgments, bounded retries, and duplicate recognition. Busy input drains at a tool boundary; idle input starts a turn or wakes the session. | `SendToPeer` reports host acceptance as delivered and drops the ID from its model-facing result. |
| Parent to local subagent | `SendMessage` queues for the current worker execution. Internal records distinguish pending, prepared, submitted, delivered, undelivered, and uncertain. Finishing closes acceptance atomically; stopped workers require `ResumeAgent`. | Sender gets no message-specific ID/status handle or timing choice. Text does not interrupt execution. |
| Local subagent to parent escalation | `ask_parent_session` hands a question or blocker to the parent. The harness ends the current worker run with a blocked handoff; the answer arrives in a new or resumed run. | This is a terminal escalation, not a continuing conversation or routine progress channel. Preserve it while improving parent-visible progress. |
| User directly viewing an in-process teammate | Input enters `pendingUserMessages` and appears in its displayed transcript. The idle wait loop consumes it after current work returns. | Different timing from main-agent/local-worker input, despite similar UI expectations. Display does not prove model consumption. |
| Teammate mailbox | Separate roster/mailbox routing and lifecycle controls exist, including authority-checked shutdown and plan responses. | Do not equate this backend with local workers or desktop peers. Its prompt wrapper also encourages deferral. |

Source owners: [desktop input](/Users/pt/cat-code/app/sidecar/sidecarServer.ts:2440), [force-send](/Users/pt/cat-code/app/sidecar/sidecarServer.ts:2832), [peer consumption](/Users/pt/cat-code/app/sidecar/sidecarServer.ts:2466), [peer acceptance](/Users/pt/cat-code/app/main/peerRequestPlane.ts:1294), [worker send](/Users/pt/cat-code/src/tools/SendMessageTool/SendMessageTool.ts:300), [worker states](/Users/pt/cat-code/src/tasks/LocalAgentTask/LocalAgentTask.tsx:53), [worker finish gate](/Users/pt/cat-code/src/tasks/LocalAgentTask/LocalAgentTask.tsx:472), [teammate input](/Users/pt/cat-code/src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx:64), [teammate idle consumption](/Users/pt/cat-code/src/utils/swarm/inProcessRunner.ts:875).

### Delivery labels and instruction wrappers disagree

`SendToPeer` converts `queued_live` and `queued_wake` into `delivery: delivered`; the prose mentions later reading but the structured value overstates acceptance. A local worker send instead correctly says the instruction was queued. Its internal `delivered` means a valid provider response was received, while a peer consumption acknowledgment occurs earlier at engine consumption. Neither guarantees the requested work was performed. [Peer result mapping](/Users/pt/cat-code/app/sidecar/sendToPeerTool.ts:133), [worker confirmation](/Users/pt/cat-code/src/query.ts:1119)

The mid-run user wrapper says to address the message after completing the current task. The teammate wrapper likewise defers consideration. The coordinator wrapper says to address it before completion, while the peer wrapper says to consider it now and respond promptly to blocking questions. Early transport delivery can therefore be undermined by contradictory scheduling instructions. The observed stalls below do not prove that these wrappers caused them. [Wrappers](/Users/pt/cat-code/src/utils/messages.ts:5804)

### Recovery and terminal notification gaps

The host's pending peer store is in memory. Recipient restart redelivery is not a guarantee of surviving a whole-app restart. Bounded redelivery exhaustion records failure in the operational log; the inspected path does not send a new failure outcome to the originating model. Current limits include a three-attempt no-progress retry threshold, fifty pending peer messages per recipient, and a sixteen-hop pair guard with a ten-minute chain window. Consuming any peer message resets all remaining pending messages' attempt counters for that recipient to one, so this is neither a lifetime three-attempt cap nor an elapsed-time limit. These bounds serve real overload and loop-control purposes. [Pending store](/Users/pt/cat-code/app/main/peerRequestPlane.ts:599), [counter reset](/Users/pt/cat-code/app/main/peerRequestPlane.ts:1339), [retry exhaustion](/Users/pt/cat-code/app/main/peerRequestPlane.ts:1565), [limits](/Users/pt/cat-code/app/shared/limits.ts:339)

Completion notifications use next-boundary delivery. However, `TaskOutput` marks a finished task notified without removing an already queued notification, leaving a source-derived duplicate-notification risk. This audit did not establish a corresponding duplicate-action incident. [TaskOutput](/Users/pt/cat-code/src/tools/TaskOutputTool/TaskOutputTool.tsx:233), [notification enqueue](/Users/pt/cat-code/src/tasks/LocalAgentTask/LocalAgentTask.tsx:903)

## Observed peer conversations

### A delivered receipt preceded input consumption by 35 minutes

Tunnel sent Quarry an interview question about polymorphism on October 14. Both sides show the same request and queue UUID. Times below are Bangkok time.

| Event | Time |
|---|---|
| Recipient enqueues the question | 13:54:14.535 |
| Sender receives `delivery: delivered` | 13:54:14.536 |
| Recipient records the question as user input after dequeue | 14:29:57.492 |
| Recipient sends its substantive answer | 14:30:05.591 |

The enqueue-to-input interval was **35 minutes 42.957 seconds**. During the interval the recipient had a provider timeout/retry sequence, an abort near a new user prompt, and a later streaming failure. The transcript records a WebSocket idle timeout followed by repeated HTTP attempts and retries; it does not establish who triggered the later abort. This establishes a misleading receipt and an unbounded-by-this-interface wait; it does not isolate the queue as the cause of provider delay or prove message loss. Stream/retry handling is a separate owner to investigate. [Enqueue](/Users/pt/.cat-code/projects/-Users-pt-Playtorium/5eb04c6f-eddc-4579-8c20-6f3ca2a85ea7.jsonl:868), [send receipt](/Users/pt/.cat-code/projects/-Users-pt-Playtorium/bb59c842-0dee-44e2-b32c-22e39feb8f8f.jsonl:486), [timeout](/Users/pt/.cat-code/projects/-Users-pt-Playtorium/5eb04c6f-eddc-4579-8c20-6f3ca2a85ea7.jsonl:869), [retry](/Users/pt/.cat-code/projects/-Users-pt-Playtorium/5eb04c6f-eddc-4579-8c20-6f3ca2a85ea7.jsonl:875), [input and answer](/Users/pt/.cat-code/projects/-Users-pt-Playtorium/5eb04c6f-eddc-4579-8c20-6f3ca2a85ea7.jsonl:1828)

### Productive dialogue and repetitive chatter both hit the design problem

Rocker and Cradle completed eight interview questions. Sending question nine returned `not_delivered` / `chain_too_long`, with advice to finish the work independently. This blocked the user-requested interaction. The current guard still advances a pair counter across replies even when the active route unwinds. The observed eight-question threshold is specific to this exchange, not a universal count for every conversation. [Refusal](/Users/pt/.cat-code/projects/-Users-pt-Playtorium/bb03ea86-e3e4-4475-93b7-c589a4941c2b.jsonl:381), [current guard](/Users/pt/cat-code/app/main/peerRequestPlane.ts:803)

In a separate exchange, Quarry repeatedly sent completion/waiting statements, including “Done,” “STOP,” and “[end],” after answering. Tunnel asked it to send only substantive answers. These were ordinary text messages, not lifecycle controls. The evidence supports retaining loop and cost protection while improving the idle/finish contract and avoiding status chatter that consumes turns. [Repeated sends](/Users/pt/.cat-code/projects/-Users-pt-Playtorium/5eb04c6f-eddc-4579-8c20-6f3ca2a85ea7.jsonl:121), [sender correction](/Users/pt/.cat-code/projects/-Users-pt-Playtorium/bb59c842-0dee-44e2-b32c-22e39feb8f8f.jsonl:235)

### Shared-tree coordination needs an actual agreement

Porphyry's intention to stage/commit reached Scoria's recorded input about **40.707 seconds** after enqueue. Before consuming it, Scoria announced its own staging/commit plan. Scoria then explicitly said their messages had crossed, confirmed nothing was staged, and agreed to wait for Porphyry's commit SHA. That correction took **39.181 seconds** from enqueue to recorded attachment timestamp on the other side. [Initial consumption](/Users/pt/.cat-code/projects/-Users-pt-cat-code/7cdbf736-fdbf-4c7e-ba40-4c578dbd0b8f.jsonl:2393), [correction](/Users/pt/.cat-code/projects/-Users-pt-cat-code/7cdbf736-fdbf-4c7e-ba40-4c578dbd0b8f.jsonl:2397), [correction consumption](/Users/pt/.cat-code/projects/-Users-pt-cat-code/b6088f97-471f-4ea8-86b6-743a676d95a6.jsonl:5852)

No lost commit or overwritten file was established by this example. It shows that even prompt message delivery cannot substitute for an explicit handoff before modifying a shared resource. A positive example is Iridium obtaining Titanium's confirmation that no edits, tests, or builds were running before advancing a branch-switch workflow and preserving the reported commit. [Confirmation](/Users/pt/.cat-code/projects/-Users-pt-cat-code/b5f4e3bd-f5b8-43a6-aaa8-43205c9d85cb.jsonl:3910), [parent use of confirmation](/Users/pt/.cat-code/projects/-Users-pt-cat-code/b5f4e3bd-f5b8-43a6-aaa8-43205c9d85cb.jsonl:3928)

Rocker also interleaved active conversations with database and API peers. This provides a useful counterexample to the claim that all messages wait for an entire assignment to finish. [Interleaved exchange](/Users/pt/.cat-code/projects/-Users-pt-Playtorium/bb03ea86-e3e4-4475-93b7-c589a4941c2b.jsonl:691)

## Observed parent and subagent behavior

### Routine instructions reach active workers

In the scheduled-task implementation, seven messages were matched from the parent to Milner and Kiczales while they worked. Their send-to-recorded-attachment-timestamp intervals were 7.150, 13.531, 13.498, 6.930, 3.800, 0.732, and 23.554 seconds. Both workers subsequently reached terminal completion. This supports retaining the existing mid-run path, but does not establish that every instruction was understood or correctly implemented. [Parent sends](/Users/pt/.cat-code/projects/-Users-pt-cat-code/dd904d9c-6a8a-428f-951d-d4cf0ba557d0.jsonl:344), [Milner example](/Users/pt/.cat-code/projects/-Users-pt-cat-code/dd904d9c-6a8a-428f-951d-d4cf0ba557d0/subagents/agent-a8ecbc6f1805aae53.jsonl:37), [Kiczales example](/Users/pt/.cat-code/projects/-Users-pt-cat-code/dd904d9c-6a8a-428f-951d-d4cf0ba557d0/subagents/agent-aaba14849ddfb0bff.jsonl:163)

### An urgent return instruction remained uncertain

On October 8, Scoria sent Torvalds “Finish only the command already in flight, then return your current result NOW” at **18:02:24.273**. The send result said queued. The parent then assured the user that the worker would do no more investigation or test iterations, without an acknowledgment that this restriction had taken effect.

The terminal notification arrived at **18:15:41.473**, **13 minutes 17.200 seconds** after the send. It marked this instruction uncertain because the provider stream ended ambiguously after submission. The transcript does not establish a confirmed receipt time, deliberate noncompliance, or that the worker ignored a message it had definitely seen. The established problem is that a conversational stop request did not provide an execution guarantee, yet the parent spoke as if it had. [Instruction](/Users/pt/.cat-code/projects/-Users-pt-cat-code/7cdbf736-fdbf-4c7e-ba40-4c578dbd0b8f.jsonl:2247), [parent assurance](/Users/pt/.cat-code/projects/-Users-pt-cat-code/7cdbf736-fdbf-4c7e-ba40-4c578dbd0b8f.jsonl:2259), [terminal report](/Users/pt/.cat-code/projects/-Users-pt-cat-code/7cdbf736-fdbf-4c7e-ba40-4c578dbd0b8f.jsonl:2278)

Local workers already preserve this uncertainty instead of silently declaring successful delivery. A separate Hellman terminal report also included an instruction that remained uncertain at completion. Sends to stopped Hellman and Goldstine workers were correctly refused with a `ResumeAgent` instruction. These protections should be retained. [Hellman uncertainty](/Users/pt/.cat-code/projects/-Users-pt-cat-code/9a12b48e-b2c2-4095-a20b-610afc45bba3.jsonl:16576), [stopped-worker refusal](/Users/pt/.cat-code/projects/-Users-pt-cat-code/b80eb44d-9e6e-4fb0-90e0-2545008aede1.jsonl:2721)

### Progress existed but the normal parent retrieval omitted it

Scoria requested a progress update at 16:44:21.947. Torvalds' transcript contains a substantive update at 16:49:59.700 describing the latest native result and remaining checks. At 18:01:44.857, the parent's `TaskOutput` still returned running/not-ready with only a final-answer-unavailable placeholder. Current `getTaskOutputData` deliberately uses that placeholder while a local worker is running. This is a gap in this model-facing retrieval path, not a claim that no UI, raw transcript, or alternative inspection surface can show progress. [Worker update](/Users/pt/.cat-code/projects/-Users-pt-cat-code/7cdbf736-fdbf-4c7e-ba40-4c578dbd0b8f/subagents/agent-afaec76b610354207.jsonl:1741), [TaskOutput result](/Users/pt/.cat-code/projects/-Users-pt-cat-code/7cdbf736-fdbf-4c7e-ba40-4c578dbd0b8f.jsonl:2245), [retrieval implementation](/Users/pt/cat-code/src/tools/TaskOutputTool/TaskOutputTool.tsx:67)

### A later acknowledgment displaced the substantive handoff

Torvalds wrote a detailed result at 18:13:49.288 with test outcomes, changed files, logs, and limitations. At 18:15:39.924 it wrote a short statement saying the preserved handoff was complete and there was nothing to append. The terminal notification included the short statement instead of the substantive handoff. Scoria concluded that test results were omitted and began inspecting saved logs and diffs.

The detailed result remained in the worker transcript; this was loss from the selected handoff, not deletion of the underlying evidence. Current finalization selects text from the last assistant message and only searches backward when that message has no text. That directly explains the selection vulnerability. The triggering recovery/continuation sequence is not isolated as a reproducible current-build bug by this audit. [Detailed result](/Users/pt/.cat-code/projects/-Users-pt-cat-code/7cdbf736-fdbf-4c7e-ba40-4c578dbd0b8f/subagents/agent-afaec76b610354207.jsonl:1918), [short follow-up](/Users/pt/.cat-code/projects/-Users-pt-cat-code/7cdbf736-fdbf-4c7e-ba40-4c578dbd0b8f/subagents/agent-afaec76b610354207.jsonl:1923), [parent reaction](/Users/pt/.cat-code/projects/-Users-pt-cat-code/7cdbf736-fdbf-4c7e-ba40-4c578dbd0b8f.jsonl:2282), [selection code](/Users/pt/cat-code/src/tools/AgentTool/agentToolUtils.ts:695)

## Recommended contract

### Separate delivery timing from execution authority

| Intent | Proposed meaning | Required limit |
|---|---|---|
| Steer | Apply relevant input at the next safe model boundary during the current work. | No promise to interrupt a running tool or an already streaming model response. |
| Follow up | Keep independent work for after the current run reaches its terminal boundary. | Preserve ordering and surface pending state; do not silently move it into a different run. |
| Interrupt | Request cancellation, settle in-flight execution, and then process the replacement instruction. | Report requested and stopped separately. Completed side effects are not undone. |
| Stop after current tool | Finish the admitted tool work, prevent new tool dispatch, and return available progress. | Requires a harness control and a definition for concurrent tool batches; urgent prose is insufficient. |

For ordinary user corrections, steer is a proposed default, with an explicit follow-up choice. This is a design preference, not a conclusion that all public systems use that default. Agent messages should default to noninterrupting delivery. Parent control over an owned worker can use existing cancellation machinery; arbitrary peers must not acquire interruption authority merely by labeling content urgent. Preserve receiving-session permissions, lifecycle identity, and explicit user stops.

Reuse `TaskStop` for cancellation and `ResumeAgent` for stopped workers. A graceful checkpoint needs explicit semantics beyond these primitives. Define which run the request targets, which tools have already been admitted, how long settlement can take, and what the caller sees on timeout. Do not describe abort requested or an eager status transition as proof that every child process or external side effect has stopped. [TaskStop](/Users/pt/cat-code/src/tools/TaskStopTool/TaskStopTool.ts), [worker abort](/Users/pt/cat-code/src/tasks/LocalAgentTask/LocalAgentTask.tsx:950)

### Separate transport receipts from requested work

Expose stable message and recipient identity at acceptance. For steering or control aimed at a particular run, include the expected/current execution identity and reject stale targets. Peer acceptance currently returns a message ID and queue outcome without binding an execution; follow-ups that intentionally start later work need an explicit policy for allocating that execution and exposing its eventual linkage. Expose runtime facts such as queued, prepared/submitted, consumed, provider-confirmed, rejected, canceled, and uncertain, while making clear that not every backend supplies every observation. Do not collapse peer consumption and worker provider confirmation into one undocumented delivered state. Avoid a “read” label implying comprehension.

Only requests that need an answer should require a correlated reply. Track acknowledgment, blocked/declined, and completed outcomes separately from transport. A runtime receipt should not spend a recipient model turn. Preserve failure/uncertainty reporting after acceptance, and allow a sender to wait for a specific receipt or work result instead of repeatedly asking whether the message arrived.

Reuse `ask_parent_session` for a worker that cannot continue without its parent's answer. It already produces a harness-owned blocked handoff and ends that run; the parent supplies its answer through new or resumed work. Keep this separate from progress or replies that should allow a worker to continue. The existing escalation is evidence that enforced lifecycle transitions are possible without relying on the worker to stop voluntarily. [Escalation contract](/Users/pt/cat-code/src/tools/AskParentSessionTool/AskParentSessionTool.ts:38), [harness enforcement](/Users/pt/cat-code/src/tools/AgentTool/runAgent.ts:1317)

Keep worker progress and the substantive task result independently accessible. A later acknowledgment or recovery response must not silently replace the result. Scope a result to the work/run it answers so preserving an old handoff does not falsely satisfy a newer assignment. A status query should expose existing bounded progress and message state rather than requiring raw transcript ingestion.

### Bound stale input and stalled waiting

Expose pending age and why the recipient cannot reach a delivery boundary. A timeout means unconfirmed, not undelivered; automatic retry must preserve identity and avoid replaying already acted-on instructions. Allow unsent instructions to be recalled or superseded, with an explicit too-late result once processing has begun.

Retain queue, byte, rate, and cost bounds. Reconsider the fixed pair-hop guard for sustained user-requested conversations, while retaining protection against circular exchanges and repeated status chatter. An idle subscription can reduce polling and wakeups, but idle is not semantic completion. These are design improvements; this audit has not measured their token savings or proved an optimal budget.

Faster delivery alone does not serialize shared Git operations. For those cases, require an explicit handoff/acknowledgment before proceeding, or use existing ownership/isolation mechanisms. Do not infer exclusive ownership from a send receipt.

## Suggested implementation order and acceptance evidence

| Order | Change | Evidence needed before claiming it works |
|---|---|---|
| 1 | Truthful peer acceptance result, returned IDs, consistent scheduling wrappers | Busy-recipient receipt says queued; later consumption is correlated; a correction wrapper permits considering the correction during current work. |
| 2 | Parent-visible worker progress, uncertainty, and stable substantive handoff | Reproduce the Torvalds sequence without losing the substantive result; a running-worker query returns the latest bounded progress and unresolved instruction state. |
| 3 | Explicit cancellation/checkpoint contract and stale-run guard | A queued stop is not reported as executed; tool admission ceases at the specified boundary; cancellation failure/timeout is honest; a late request cannot affect a resumed run. |
| 4 | Consistent steer/follow-up behavior, including direct teammate input | Main, local-worker, and teammate paths satisfy their documented timing; force-send/recall addresses the chosen queued message without corrupting tool-result pairing. |
| 5 | Recovery, duplicate suppression, loop-budget and stale-message refinements | Preserve identity across recipient restart; define whole-app restart behavior; surface exhausted delivery; avoid duplicate notification after polling; support sustained legitimate dialogue without allowing unbounded loops. |

Implement the smallest owner-level changes that satisfy these cases. Do not add a separate message broker, make every update an acknowledgment workflow, or infer safe interruption solely from a text priority. Provider stalls require their own diagnosis; queue improvements alone cannot promise a bound on model response time.

## Verification boundaries

Historical transcripts and current source were inspected read-only. External contracts were checked against primary documentation. No live Cat Code agents were spawned for reproduction, no GUI was driven, and no provider calls were made to test message delivery. The requested adversarial review of this report is separate from runtime verification. No production behavior has been changed by this report.

Transcript links point to private local files and are not portable outside this machine. Repository source line numbers describe the inspected working tree and may drift as concurrent work proceeds. Preserve the original evidence and recheck owning code before implementing a fix.

The [adversarial review](/Users/pt/cat-code/docs/reports/2026-10-15-busy-agent-messaging-adversarial-review.md) found three P2 corrections and one P3 clarification. All four were incorporated: terminal worker-to-parent escalation, the no-progress retry threshold, qualified abort provenance, and delivery-mode-specific execution identity. The review retained the central conclusion and found no P0 or P1 issue. Its source and transcript checks do not replace implementation or runtime verification.
