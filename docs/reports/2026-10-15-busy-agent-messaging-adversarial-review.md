# Adversarial review: busy agent messaging report

Date: 2026-10-15, Asia/Bangkok.

Reviewed [research report](/Users/pt/cat-code/docs/reports/2026-10-15-busy-agent-messaging-research.md), original 167-line draft, SHA-256 `7246bc3613b81ed8f044ca1e6cefad645c3ebcfac4cb4a83aff17a380e3f69ab`. Report line references below identify that draft; subsequent corrections may move them. This review did not modify the research report or production code.

## Assessment

The main conclusion is supported: keep safe-boundary queues, distinguish acceptance from consumption and work completion, and use execution controls for enforced stopping. The draft avoids the major causal mistakes in the earlier conversation: it does not interpret a transcript attachment timestamp as proof of model comprehension, does not blame the queue alone for the 35-minute interval, and distinguishes missing selected handoff content from deletion of the worker transcript.

No P0 or P1 finding was established. Three P2 corrections and one P3 clarification should be incorporated before treating the report as a design input. They refine the account rather than overturn its conclusion.

## Findings

### R1. P2: include the existing terminal worker-to-parent escalation contract

**Report locations:** original lines 43–49, 131, 137–139.

The path inventory covers parent-to-worker delivery and later discusses progress and completion, but omits `ask_parent_session`. This matters because the recommended acknowledgment/blocked/completed workflow can otherwise look like a missing generic reply channel that should be invented from scratch.

The existing tool has a specific contract: a worker hands a question or blocker to the parent and ends its run; the parent's answer arrives through a new or resumed run. The harness detects the tool result, aborts the current query, writes a synthetic `status: blocked` handoff, and breaks the loop. That is materially stronger than asking the worker to stop in prose. [Tool contract](/Users/pt/cat-code/src/tools/AskParentSessionTool/prompt.ts:3) · [Harness enforcement](/Users/pt/cat-code/src/tools/AgentTool/runAgent.ts:1317) · [Blocked handoff formatting](/Users/pt/cat-code/src/tools/AskParentSessionTool/AskParentSessionTool.ts:70)

**Suggested correction:** add a source-derived worker-to-parent escalation row. Preserve terminal escalation plus resume for genuinely blocked work; distinguish it from the still-missing lightweight progress/reply surface while a worker continues. Do not suggest that this existing tool is a live conversational reply channel or that it should be used for routine status reporting.

### R2. P2: the peer retry limit is a no-progress limit, not a lifetime three-attempt cap

**Report location:** original line 61.

“Three delivery attempts” overstates the bound. Every successful consumption acknowledgment resets the attempt counter of **all remaining pending messages for that recipient** to one. A message can therefore be redelivered more than three times in total if the recipient consumes other messages between restarts. The redelivery code explicitly describes the limit as counting wakes during which the recipient consumed nothing. [Counter reset](/Users/pt/cat-code/app/main/peerRequestPlane.ts:1339) · [Exhaustion condition and explanation](/Users/pt/cat-code/app/main/peerRequestPlane.ts:1562)

**Suggested correction:** say “a three-attempt no-progress retry threshold, reset when the recipient consumes a message.” Retain the separate observation that pending age is not bounded by this interface. Do not describe the mechanism as a total delivery-attempt budget or elapsed-time guarantee.

### R3. P2: describe the observed retry sequence and qualify the abort's provenance

**Report location:** original line 78.

The 35-minute enqueue-to-input interval and the misleading sender receipt are supported. The surrounding description, however, compresses several attempts into “a long active stream” and assigns a “user-triggered abort” more confidently than the cited records establish.

The recipient records a WebSocket idle timeout, then several HTTP attempts ending with `AbortError` around five minutes apart. Separate `api_error` rows record retry attempts one, two, and three. A new human `.` prompt is queued at 14:14:51.852 Bangkok time; another abort occurs at 14:14:54.843 and the new prompt is consumed shortly afterward. A later partial-stream failure precedes the peer message's consumption. [Initial timeout](/Users/pt/.cat-code/projects/-Users-pt-Playtorium/5eb04c6f-eddc-4579-8c20-6f3ca2a85ea7.jsonl:869) · [First retry](/Users/pt/.cat-code/projects/-Users-pt-Playtorium/5eb04c6f-eddc-4579-8c20-6f3ca2a85ea7.jsonl:875) · [Third retry](/Users/pt/.cat-code/projects/-Users-pt-Playtorium/5eb04c6f-eddc-4579-8c20-6f3ca2a85ea7.jsonl:885) · [New prompt](/Users/pt/.cat-code/projects/-Users-pt-Playtorium/5eb04c6f-eddc-4579-8c20-6f3ca2a85ea7.jsonl:888) · [Later failure](/Users/pt/.cat-code/projects/-Users-pt-Playtorium/5eb04c6f-eddc-4579-8c20-6f3ca2a85ea7.jsonl:1824)

The timing strongly suggests a relationship between the new input and the last abort, but `AbortError` alone does not identify a human cancellation. The inspected debug excerpt also says the request was aborted without naming its trigger.

**Suggested correction:** describe “a provider timeout/retry sequence, an abort near a new user prompt, and a later streaming failure.” Use “user-triggered” only if a separate control-plane record establishes it. This preserves the receipt finding while making clear that stream/retry handling is another owner to investigate.

### R4. P3: scope execution identity to the delivery mode

**Report locations:** original lines 125, 135, 155.

“Return the existing message ID and execution identity at acceptance” is too broad across the listed backends. Peer acceptance currently binds a message to a recipient session and returns `messageId` plus queue outcome; it does not bind it to an execution. A parked recipient can be woken, and an idle message can start a new turn. Local worker messages are accepted into the currently running worker state. These are different identities and scheduling promises. [Peer envelope and wake path](/Users/pt/cat-code/app/main/peerRequestPlane.ts:1246) · [Peer acceptance result](/Users/pt/cat-code/app/main/peerRequestPlane.ts:1294) · [Worker acceptance](/Users/pt/cat-code/src/tasks/LocalAgentTask/LocalAgentTask.tsx:381)

**Suggested correction:** always expose stable message and recipient identity; include an expected/current execution identity for run-scoped steering and controls. For a follow-up that intentionally creates later work, explicitly describe whether its execution is allocated at acceptance or assigned later, and expose that eventual linkage. Do not imply every backend already has an execution ID available when it accepts input.

## Claims independently checked and retained

- `SendToPeer` maps both host queue outcomes to `delivery: delivered`, while dropping the host-assigned message ID from the returned shape. The report's terminology criticism is supported. [Mapping](/Users/pt/cat-code/app/sidecar/sendToPeerTool.ts:133)
- Local-worker delivery confirmation requires a valid provider response and records staged message attachments through a later callback. The report correctly qualifies their creation timestamps. [Confirmation](/Users/pt/cat-code/src/query.ts:1119) · [Transcript callback](/Users/pt/cat-code/src/tools/AgentTool/runAgent.ts:1176)
- Torvalds' terminal notification includes the short acknowledgment and explicitly lists the urgent instruction as uncertain. The substantive earlier result survives in the worker transcript. The current last-assistant-text selection explains the vulnerability without proving the whole historical recovery sequence is reproducible today. [Notification](/Users/pt/.cat-code/projects/-Users-pt-cat-code/7cdbf736-fdbf-4c7e-ba40-4c578dbd0b8f.jsonl:2278) · [Detailed result](/Users/pt/.cat-code/projects/-Users-pt-cat-code/7cdbf736-fdbf-4c7e-ba40-4c578dbd0b8f/subagents/agent-afaec76b610354207.jsonl:1918) · [Selection](/Users/pt/cat-code/src/tools/AgentTool/agentToolUtils.ts:725)
- Running local-worker `TaskOutput` uses a final-answer-unavailable placeholder when it has no clean result. The report correctly limits its criticism to that retrieval path. [Implementation](/Users/pt/cat-code/src/tools/TaskOutputTool/TaskOutputTool.tsx:63)
- The user and teammate wrappers defer consideration, while the peer wrapper requests consideration during current work. The report appropriately avoids asserting that this caused the observed stalls. [Wrappers](/Users/pt/cat-code/src/utils/messages.ts:5804)
- The proposed cancellation wording correctly avoids treating eager `killed` state or an abort request as proof that every external effect has stopped. [Worker abort/state transition](/Users/pt/cat-code/src/tasks/LocalAgentTask/LocalAgentTask.tsx:950)

The primary external documentation supports the table's principal contrasts: [Pi queue dispositions and timing](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md), [Codex execution-targeted steering](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn), [Claude Code input boundaries](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works), [cross-session idle subscriptions](https://code.claude.com/docs/en/cross-session-messaging#get-a-notice-when-another-session-goes-idle), [LangSmith concurrency policies](https://docs.langchain.com/langsmith/double-texting), and [Managed Agents event processing](https://platform.claude.com/docs/en/managed-agents/events-and-streaming). These are documentation checks, not comparative experiments. The [OpenAI steering guide](https://developers.openai.com/api/docs/guides/steering) additionally makes clear that accepted steering is queued, can later fail, and does not survive disconnection by assumption, consistent with the report's receipt/recovery distinction.

## Proportionality and verification gaps

The implementation order is proportionate if treated as independently justified stages, not approval to build every proposed status and control at once. Truthful queue outcomes, existing IDs, wrapper alignment, and exposing existing worker progress are smaller changes than a new message subsystem. A stable substantive-result field and graceful checkpoint still need concrete contracts; heuristic selection of the “best” earlier text would create new ambiguity.

This review inspected current source, selected historical transcript records and companion debug evidence, and primary public documentation. It did not run a Cat Code agent, provider experiment, GUI, build, or behavioral test. It did not independently recompute every seven-worker timing or re-enumerate the complete historical corpus. The sample is not a latency distribution, and these findings do not establish failure frequency, token savings, exactly-once execution, or correctness of proposed changes.

Repository documentation checks and final report link validation remain the parent author's responsibility after incorporating corrections. No unrelated files, live state, or transcripts were changed; no commit or push was made.

## Resolution recheck

Rechecked the revised research report on 2026-10-15. **R1–R4 are resolved in the report.** The original findings above remain as review history.

- R1: the [new escalation row](/Users/pt/cat-code/docs/reports/2026-10-15-busy-agent-messaging-research.md:48) and [reuse guidance](/Users/pt/cat-code/docs/reports/2026-10-15-busy-agent-messaging-research.md:140) distinguish terminal blocked handoff/resume from continuing progress and replies.
- R2: the [retry paragraph](/Users/pt/cat-code/docs/reports/2026-10-15-busy-agent-messaging-research.md:62) now describes the no-progress threshold, recipient-wide counter reset, and absence of a lifetime or elapsed-time bound.
- R3: the [35-minute interpretation](/Users/pt/cat-code/docs/reports/2026-10-15-busy-agent-messaging-research.md:79) records the timeout/retry sequence and no longer assigns an unverified human trigger to the abort.
- R4: the [identity proposal](/Users/pt/cat-code/docs/reports/2026-10-15-busy-agent-messaging-research.md:136) now separates stable message/recipient identity from expected/current run identity and eventual follow-up execution linkage.

The review file's initial 23 local links resolved and its whitespace check emitted no errors. The recheck found no additional material issue in the revised passages. This resolves documentation findings only; the implementation and runtime verification gaps above remain.
