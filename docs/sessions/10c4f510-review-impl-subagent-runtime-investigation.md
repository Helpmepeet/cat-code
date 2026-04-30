# Session `10c4f510` — `/review-impl` subagent runtime failure investigation

**Date:** 2026-04-21  
**Session analyzed:** `10c4f510-c0e3-4e86-800d-682897782eb1`  
**Scope:** Cat Code subagent/runtime reliability, not the reviewed application code.

---

## 1. Incident summary

A `/review-impl` workflow spawned review subagents in normal REPL mode. The run exhibited multiple runtime failures:

1. **Design reviewer crashed** with:
   - `undefined is not an object (evaluating 'O.input_tokens')`
2. **Correctness reviewer hit a mid-stream transport failure** observed by the user as:
   - `API Error: WebSocket closed before response.completed`
3. **A spawned review subagent recursively invoked `review-impl`** instead of directly reviewing the provided scope.
4. **Failed subagent artifacts were hard to inspect** because transcript lines are large JSONL records.
5. **Parent-facing task status/notifications were misleading** and did not clearly distinguish operational failure from partial useful output.

This is a tooling/runtime bug cluster in Cat Code’s subagent execution path.

---

## 2. Evidence to load first in a follow-up session

### Parent transcript
- `~/.cat-code/projects/-Users-pt-cat-code/10c4f510-c0e3-4e86-800d-682897782eb1.jsonl`

Key parent transcript facts recovered during investigation:
- `review correctness quality` subagent spawned as `ab9fd98dab947764e`
- `review design alignment` subagent spawned as `a91dc61b73bbc5e68`
- `a91dc61b73bbc5e68` terminalled with reason:
  - `undefined is not an object (evaluating 'O.input_tokens')`
- `ab9fd98dab947764e` was marked `completed` in the parent transcript despite the user observing a transport failure inside that run
- narrower replacement reviewers were later spawned and completed

### Subagent transcript paths
- `~/.cat-code/projects/-Users-pt-cat-code/10c4f510-c0e3-4e86-800d-682897782eb1/subagents/agent-ab9fd98dab947764e.jsonl`
- `~/.cat-code/projects/-Users-pt-cat-code/10c4f510-c0e3-4e86-800d-682897782eb1/subagents/agent-a91dc61b73bbc5e68.jsonl`
- metadata sidecars:
  - `.../agent-ab9fd98dab947764e.meta.json`
  - `.../agent-a91dc61b73bbc5e68.meta.json`

### Subagent roles from metadata
- `ab9fd98dab947764e` → `review correctness quality`
- `a91dc61b73bbc5e68` → `review design alignment`

---

## 3. Proven findings

## 3.1 This incident used the normal Agent-tool subagent path, not agent mode orchestrator

The relevant runtime path for this incident is the ordinary `Agent` tool stack, especially:
- `src/tools/AgentTool/AgentTool.tsx`
- `src/tools/AgentTool/agentToolUtils.ts`
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- `src/tools/AgentTool/UI.tsx`

`src/agent-mode/orchestrator.ts` has a similar bug pattern, but it is supporting evidence of a broader smell, not the primary path for this incident.

## 3.2 Mid-stream WebSocket close is a real, tested failure mode

In the WebSocket transport:
- `src/services/api/codex-websocket-transport.ts:624-637`

Behavior:
- if the socket closes **before any events are yielded** → `CodexWebSocketUsageLimitError`
- if the socket closes **after events have already started** → plain `Error('WebSocket closed before response.completed')`

Tests already cover this behavior:
- `src/services/api/codex-websocket-transport.test.ts:580-602`
- `src/services/api/codex-fetch-adapter.test.ts:379-395`

So the failure mode itself is proven.

## 3.3 Mid-stream close is classified too generically for the stronger recovery path

Relevant code:
- `src/services/api/codex-fetch-adapter.ts:1266-1278`
- `src/services/api/codex-fetch-adapter.ts:1304-1321`
- `src/services/api/withRetry.ts:323-366`

What happens now:
- `CodexWebSocketUsageLimitError` can be normalized into account-cap handling
- a close **after first event** remains a generic error
- the stronger retry/failover logic is built around typed/retryable classes, not this generic mid-stream close

Practical result:
- **before first event** → stronger classification, can enter failover path
- **after first event** → generic transport error, no equivalent recovery path

This is the clearest runtime-level root cause currently established.

## 3.4 Normal Agent-tool sync recovery can return outward `completed` after internal failure

This is the strongest correctness bug found in the normal subagent path.

Relevant code:
- `src/tools/AgentTool/AgentTool.tsx:1319-1378`

Behavior:
1. iteration error is captured as `syncAgentError`
2. if any assistant messages already exist, the code does **not** rethrow
3. it proceeds to `finalizeAgentTool(...)`
4. it appends transcript terminal metadata with:
   - `status: 'failed'` when `syncAgentError` exists
   - `src/tools/AgentTool/AgentTool.tsx:1361-1368`
5. but it still returns outward tool data with:
   - `status: 'completed'`
   - `src/tools/AgentTool/AgentTool.tsx:1371-1377`

This directly explains how the parent session can see an apparently completed subagent even though the run had an internal error.

## 3.5 Normal Agent-tool finalization assumes `usage` exists

Relevant code:
- `src/tools/AgentTool/agentToolUtils.ts:323-347`
- `src/utils/tokens.ts:121-129`

Behavior:
- gets `lastAssistantMessage`
- computes token count using `lastAssistantMessage.message.usage`
- there is no guard for missing `usage`

This is a plausible direct contributor to the `input_tokens` crash family in normal mode.

## 3.6 `LocalAgentTask` progress and Agent UI also assume `usage` exists

Relevant code:
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx:72-80`
- `src/tools/AgentTool/UI.tsx:400-403`
- `src/tools/AgentTool/UI.tsx:542-545`

So this is not a single-callsite problem. Multiple normal subagent progress/completion surfaces assume usage metadata is always present.

## 3.7 Provider streaming writes final usage later, by mutation

Relevant code:
- `src/services/api/claude.ts:2332-2350`

The code explicitly states:
- assistant messages are created earlier at `content_block_stop`
- real `usage` and final `stop_reason` arrive later in `message_delta`
- then the code mutates the already-yielded last message:
  - `lastMsg.message.usage = usage`
  - `lastMsg.message.stop_reason = stopReason`

This creates a real window where an assistant message exists before final usage has been written back.

## 3.8 `getLastAssistantMessage()` is a simple last-assistant lookup

Relevant code:
- `src/utils/messages.ts:332-339`

It just returns the last assistant message in the array. It does not distinguish:
- fully finalized assistant messages
- synthetic/error assistant messages
- partially finalized streamed assistant messages

That makes downstream `last assistant => usage exists` assumptions unsafe.

## 3.9 `review-impl` recursion is plausibly allowed by current skill behavior

Relevant code:
- `src/skills/bundled/reviewImpl.ts:142-156` — `review-impl` is `userInvocable: true`
- `src/utils/processUserInput/processSlashCommand.tsx:803-815` — user-invocable skills are formatted like slash commands
- `src/tools/SkillTool/prompt.ts:181-198` — slash-command references should invoke the Skill tool unless already loaded in the current turn
- `src/tools/AgentTool/runAgent.ts:625-652` — subagents preload skill metadata/content

The `/review-impl` prompt itself does **not** literally instruct review workers to call `/review-impl` again. But current skill discovery/loading behavior makes that recursion plausible, and transcript inspection during the incident indicated that it happened.

---

## 4. Important correction from the investigation

One earlier hypothesis turned out to be too broad and should **not** be treated as the main explanation.

### API-error assistant messages created by `createAssistantAPIErrorMessage()` are not the strongest missing-usage source

Relevant code:
- `src/utils/messages.ts:436-459`
- `src/utils/messages.ts:356-409`

`createAssistantAPIErrorMessage()` ultimately goes through `baseCreateAssistantMessage()`, which supplies a default zeroed usage object if none is provided.

So the strongest missing-usage suspect for this incident is **not** “API-error assistant messages have no usage.”

The stronger explanation is the **late usage mutation window** in the streamed provider path combined with normal Agent-tool code assuming usage is already there.

---

## 5. Best current model of the incident

Best current model:
1. `/review-impl` spawned ordinary Agent-tool subagents in normal REPL mode.
2. At least one subagent began streaming normally.
3. Its WebSocket closed **after events had already begun**.
4. Because events had already begun, the transport emitted only the generic:
   - `WebSocket closed before response.completed`
5. The normal Agent-tool sync path treated the run as recoverable because assistant messages already existed.
6. That recovery path can still return outward `completed`, which explains the parent/status mismatch.
7. During completion/progress/UI handling, code assumed `message.usage` existed and hit the `input_tokens` crash family.
8. Separately, recursive `review-impl` invocation widened scope and likely increased fragility, but is not yet proven to be the direct cause of the `input_tokens` crash.

---

## 6. What is still unknown

## 6.1 We do **not** yet know why the WebSocket physically closed

This is the biggest remaining root-cause gap.

What the code preserves today:
- stream started
- some events were yielded
- socket closed before `response.completed`

What is still unknown:
- provider-side abort/reset
- account/session invalidation mid-stream
- local transport issue
- backend instability
- close code / close reason
- whether a more specific structured error preceded the close

Current transport code does not preserve enough detail to distinguish these.

## 6.2 We do **not** yet know whether recursion directly caused the transport failure

We know:
- recursion is plausible and likely happened
- mid-stream close happened
- usage-assumption crash paths exist

We do **not** know:
- whether recursion directly caused the socket close
- whether it only increased runtime length/scope and therefore failure likelihood

---

## 7. Why transcript inspection was painful

The incident’s debugging ergonomics problem is real.

Observed in practice during investigation:
- JSONL transcript records are large single-line payloads
- direct `Read` calls easily hit token/size limits
- `Grep` often collapses long matching lines into omitted output
- extracting the exact last subagent event sequence is much harder than it should be

This is not the primary runtime bug, but it materially slows postmortems.

---

## 8. Highest-value next investigation steps

### Step 1 — instrument the physical WS close
Add logging for every mid-stream close:
- account id prefix
- agent id / lease owner id
- conversation id prefix
- whether any events were yielded
- count of yielded events
- last event type seen
- WebSocket close code and close reason if available
- whether the lease/account was switched or marked unhealthy during the same attempt

Best files:
- `src/services/api/codex-websocket-transport.ts`
- `src/services/api/codex-fetch-adapter.ts`
- `src/utils/sessionStorage.ts`

### Step 2 — fix false-completed sync recovery
Best file:
- `src/tools/AgentTool/AgentTool.tsx`

Required behavior:
- if `syncAgentError` exists, do **not** return outward `status: 'completed'`
- preserve partial output if useful, but mark failure/partial honestly

### Step 3 — guard missing `usage` in normal subagent paths
Best files:
- `src/tools/AgentTool/agentToolUtils.ts`
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- `src/tools/AgentTool/UI.tsx`

Required behavior:
- treat `message.usage` as optional
- avoid crashing when usage is unavailable
- preserve textual output even when token stats are unavailable

### Step 4 — introduce a richer typed error for after-first-event close
Best files:
- `src/services/api/codex-websocket-transport.ts`
- `src/services/api/codex-fetch-adapter.ts`
- `src/services/api/withRetry.ts`

Goal:
- stop collapsing after-first-event close into an untyped generic error that loses retry/failover semantics

### Step 5 — block orchestration-skill recursion for review workers
Best files:
- `src/skills/bundled/reviewImpl.ts`
- `src/tools/SkillTool/prompt.ts`
- `src/tools/AgentTool/runAgent.ts`

Goal:
- spawned review workers should review directly, not recursively invoke orchestration skills unless explicitly allowed

---

## 9. Regression tests that should exist after the fix

1. **Normal Agent-tool sync recovery with partial assistant output + thrown iteration error**
   - returned status is not falsely `completed`
   - partial text is preserved

2. **Normal Agent-tool finalization with missing or delayed `usage`**
   - no crash
   - token stats degrade gracefully

3. **Mid-stream WebSocket close after at least one yielded event**
   - richer classification or retryable behavior exists
   - not silently collapsed into generic failure with poor parent semantics

4. **Review-worker recursion guard**
   - a spawned review worker cannot re-enter `review-impl` by default

Existing tests already relevant:
- `src/services/api/codex-websocket-transport.test.ts:580-602`
- `src/services/api/codex-fetch-adapter.test.ts:379-395`

---

## 10. Confidence summary

### High confidence
- normal-mode Agent-tool path is relevant
- mid-stream close after events is real and tested
- after-first-event close is classified too generically
- normal sync recovery can return outward `completed` after internal failure
- normal completion/progress/UI paths assume `usage` exists
- provider streaming writes final usage later

### Medium confidence
- the `input_tokens` crash is caused by one of these normal-mode usage assumptions meeting a not-yet-finalized assistant message
- recursion into `review-impl` increased fragility and scope materially

### Low confidence / unknown
- exact physical reason the WebSocket closed
- whether recursion directly caused the close or the `input_tokens` crash

---

## 11. Related report

There is a separate existing report for a different failure family centered on account-pool health and bad-account routing:
- `docs/codex-subagent-failure-swiss-cheese-report.md`

Do not merge the two incident families mentally. They may share downstream symptoms, but this `10c4...` incident is primarily about:
- mid-stream close handling
- normal-mode Agent-tool recovery semantics
- unsafe usage assumptions
- `review-impl` recursion risk

---

End of report.
