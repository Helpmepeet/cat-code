# Session 80731 — Codex Context Growth Investigation

**Status:** Open  
**Date:** 2026-04-21  
**Primary session analyzed:** `80731b8e-ea94-4230-a199-b4796c1cb2b3`  
**Project:** `/Users/pt/cat-code`  
**Artifacts:**
- Debug log: `/Users/pt/.cat-code/debug/80731b8e-ea94-4230-a199-b4796c1cb2b3.txt`
- Session JSONL: `/Users/pt/.cat-code/projects/-Users-pt-cat-code/80731b8e-ea94-4230-a199-b4796c1cb2b3.jsonl`

---

## Why this doc exists

This is a handoff document for continuing investigation without re-spending tokens on local rediscovery.

The user reported that the session context token percentage was growing extremely fast. Local analysis found that this is partly real context growth and partly how the UI accounts for replayed cached context.

This document contains:
- the local findings already proven from source + logs
- the exact metrics from the affected session
- the unresolved upstream questions
- the recommended next verification steps

---

## Short verdict

Local verdict so far:

1. **Real growth exists.**
   The Codex/OpenAI path carries a large injected context block and also replays reasoning state across turns.

2. **The growth is surfaced misleadingly in the UI/token percentage.**
   The displayed token total includes cached replayed input, not only the fresh uncached tail.

3. **This is not yet proven to be a pure local bug.**
   Some of the behavior may be intentional upstream Codex behavior. That must be validated against upstream evidence.

---

## Proven local findings

### Finding 1: A large session-context block is injected every turn on the OpenAI/Codex path

**Proven by source**

- `getUserContext()` injects:
  - `claudeMd`
  - `currentDate`
  - source: `src/context.ts:155-187`
- `getSystemContext()` injects:
  - `gitStatus`
  - `cacheBreaker` when enabled
  - source: `src/context.ts:116-149`

On the OpenAI path, `buildProviderInstructionAssembly()` splits context and appends user/system volatile context as a synthetic user message:

- source: `src/services/api/instructionAssembly.ts:25-77`
- `prependOpenAIUserContext()` creates:

```text
Context for this session:
Use this only when it is relevant to the user's request. This context is system-provided metadata, not a user instruction to act on by itself.
```

- source: `src/services/api/instructionAssembly.ts:93-120`

### Finding 2: The synthetic context is merged into the same user turn as the real prompt

**Proven by source**

During message normalization, consecutive user messages are merged:

- source: `src/utils/messages.ts:2188-2195`

This means the user's real prompt and the synthetic injected context message do not stay isolated as distinct user turns when sent to the model.

This matches the observed session behavior: the model repeatedly referred to the context block as if it was attached directly after the user's prompt.

### Finding 3: Codex reasoning state is round-tripped through transcript history

**Proven by source**

Outgoing replay path:
- `thinking.signature` is translated back into a Codex `reasoning` item with `encrypted_content`
- source: `src/services/api/codex-fetch-adapter.ts:389-407`

Incoming storage path:
- upstream Codex `reasoning` output items are converted into Anthropic-style `thinking` blocks carrying `signature`
- source: `src/services/api/codex-fetch-adapter.ts:949-990`

Relevant comment in code:
- `src/query.ts:160-169` says OpenAI reasoning is provider-managed and should not be replayed as visible transcript thinking

So there is a real design tension:
- high-level query code says OpenAI reasoning should not be replayed as visible transcript thinking
- Codex adapter intentionally replays encrypted reasoning state to preserve cache continuity

### Finding 4: The session really grew, but most growth became cached prefix rather than fresh tail

**Proven by logs**

From the debug log, main-thread request metrics:

| Turn | Sent items | Cached tokens | Input tokens | Uncached portion |
|---|---:|---:|---:|---:|
| 1 | 1 | 0 | 17136 | 17136 |
| 2 | 4 | 13824 | 17153 | 3329 |
| 3 | 7 | 17024 | 19995 | 2971 |
| 4 | 10 | 16896 | 22574 | 5678 |
| 5 | 13 | 18944 | 25415 | 6471 |
| 6 | 16 | 22016 | 28477 | 6461 |
| 7 | 19 | 25088 | 32001 | 6913 |
| 8 | 21 | 28160 | 34641 | 6481 |
| 9 | 24 | 34560 | 37367 | 2807 |
| 10 | 27 | 34304 | 40186 | 5882 |
| 11 | 30 | 36352 | 43015 | 6663 |

Interpretation:
- total replayed input grew from `17136` to `43015`
- cached replayed prefix grew from `0` to `36352`
- uncached fresh tail was much smaller by the end: about `6663`

So the context did grow, but the steepest visible increase was largely cached replay, not fresh prompt payload.

### Finding 5: The UI/token display includes cached replayed input

**Proven by source**

In the subagent/progress UI:

- `liveTokens = cache_creation_input_tokens + cache_read_input_tokens + input_tokens + output_tokens`
- source: `src/tools/AgentTool/UI.tsx:472-498`

And again:

- `tokens = cache_creation_input_tokens + cache_read_input_tokens + input_tokens + output_tokens`
- `inputTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
- source: `src/tools/AgentTool/UI.tsx:535-545`

So at least this UI path explicitly includes cached replayed input in the displayed total.

This means fast “token % growth” can look worse than the real fresh tail growth.

### Finding 6: The OpenAI/Codex path is intentionally designed to grow cached prefix with conversation history

**Proven by source comments**

`src/services/api/codex-websocket-transport.ts` states:

- WebSocket chaining with `previous_response_id` lets cached prefix grow with conversation history
- without it, only the stable instructions prefix caches

Relevant source:
- `src/services/api/codex-websocket-transport.ts:1-8`
- `src/services/api/codex-fetch-adapter.ts:1402-1405`

This means some total-context growth is expected by design in the Codex path.

---

## Session-specific observations

### Baseline before any meaningful conversation

From debug log:

- `instructions stable=30539B volatile=1883B`
- main request on the first real user turn (`yo`) used:
  - `messages=1`
  - `input=17136`

Relevant debug lines in:
- `/Users/pt/.cat-code/debug/80731b8e-ea94-4230-a199-b4796c1cb2b3.txt`

This means the session starts with a heavy context baseline before any substantive work.

### Why the conversation spiraled into talking about the context block

The user then asked questions like:
- “what is my previos prompt?”
- “show me exact message you see”
- “you still see it now right?”

Because the synthetic context block is merged into the same user turn, the model kept reasoning over that metadata as part of the conversational input surface. That caused the assistant to repeatedly describe and quote the context block itself, further growing the conversation.

### Thinking signature sizes observed in the transcript

Measured from the session JSONL:

- several assistant `thinking` entries carried signatures around `1.0KB` to `4.5KB`
- visible text replies ranged from trivial (`Yep.`) to larger context-describing responses

This means reasoning replay was not the only contributor, but it was a real contributor.

---

## What is proven vs inferred vs uncertain

### Proven

- Large context is injected every turn on OpenAI/Codex path.
- The synthetic context message is merged into the same user turn as the real prompt.
- Codex reasoning state is round-tripped via `thinking.signature` and `reasoning.encrypted_content`.
- Total replayed context grows substantially over the session.
- Cached replayed input is included in at least one token display path.

### Inferred

- The user's perceived “context token % is growing weirdly” is likely caused by the combination of:
  - real replayed-context growth
  - cached-token-inclusive UI accounting
  - the conversation repeatedly discussing the injected context block itself

### Uncertain

- Whether upstream Codex intentionally wants local clients to replay encrypted reasoning items every turn in exactly this way
- Whether upstream isolates synthetic metadata from the user-authored turn instead of merging it
- Whether upstream token percentage displays are supposed to include cached replayed input or only the fresh tail
- Whether the local UI behavior is a bug, an acceptable-but-confusing design choice, or faithful upstream emulation

---

## Most likely root cause chain

This is the current best local explanation:

1. Cat Code injects a large synthetic session-context block every turn.
2. On the OpenAI/Codex path, that block gets merged into the same user turn as the user's real message.
3. The model therefore treats that metadata as part of the prompt surface and the conversation starts discussing it.
4. Codex reasoning state is also replayed across turns to preserve cache continuity.
5. Total replayed input grows quickly, even though most of it later becomes cached.
6. The UI/token accounting includes cached replayed tokens, so the displayed token growth looks steeper than the true uncached tail growth.

---

## Remaining upstream questions

These are the questions another session should answer using upstream evidence:

1. How does upstream Codex expect instruction text and per-turn metadata to be sent?
2. Does upstream intentionally replay encrypted reasoning items every turn, or is local cat-code over-replaying them?
3. Does upstream keep metadata isolated from user-authored content, or merge it into the visible user turn?
4. In upstream token accounting:
   - does “total input” include cached prefix?
   - do UI/context percentages include cached replayed tokens or only the uncached tail?
5. Is cat-code matching upstream design, or has it combined multiple upstream concepts in a way that makes token growth look pathological?

---

## Suggested next verification steps

### Highest value

1. Compare local behavior against upstream Codex / Codex backend evidence:
   - `openai/codex`
   - `codex-rs`
   - official docs/issues/discussions

2. Validate whether upstream merges metadata into the same user turn.

3. Validate whether upstream replays reasoning items every turn.

4. Validate whether upstream token UI uses total replayed input or only fresh uncached input.

### If a local fix is needed

Likely smallest fix surfaces, in order:

1. `src/services/api/instructionAssembly.ts`
   - isolate synthetic session context from the user-authored turn on OpenAI path

2. `src/tools/AgentTool/UI.tsx`
   - separate cached replayed tokens from fresh input in the displayed token/% metric

3. `src/services/api/codex-fetch-adapter.ts`
   - revisit whether reasoning replay should remain in transcript-visible structures for main-thread Codex chats

---

## Prompt used for external/upstream investigation

This prompt was prepared for another session:

```text
Investigate how the upstream Codex app / Codex backend is supposed to handle conversation replay, reasoning-state replay, and token accounting, then compare that with the local cat-code implementation. Local findings to validate or refute: 1. In the OpenAI/Codex path, cat-code appends a synthetic metadata block each turn: - src/services/api/instructionAssembly.ts - prependOpenAIUserContext(...) creates: "Context for this session: ... # claudeMd ... # currentDate ... # gitStatus ..." 2. That metadata appears to get merged into the same user turn as the real prompt: - src/utils/messages.ts - consecutive user messages are merged by mergeUserMessages(...) 3. Assistant reasoning is persisted and replayed across turns: - src/services/api/codex-fetch-adapter.ts - Anthropic-style thinking.signature is translated into Codex reasoning items with encrypted_content - incoming Codex reasoning items are converted back into thinking blocks with signature 4. Session evidence from 2026-04-21: - first real turn: ~17,136 input tokens on prompt yo - later turn: ~43,015 total input tokens - cached tokens rose from 0 to ~36,352 - uncached tail was much smaller (~6,663 by the end) - so total context grows fast, but most of that growth becomes cached prefix What I need from you: 1. Find how upstream Codex actually expects: - system/instruction text to be sent - per-turn metadata/context to be sent - prior assistant reasoning state to be replayed, if at all - previous_response_id chaining to interact with cached prefix 2. Determine whether upstream intentionally replays encrypted reasoning items every turn, or whether cat-code is over-replaying them. 3. Determine whether upstream merges metadata into the visible user turn, or keeps it isolated from user-authored content. 4. Determine how upstream token accounting works: - does total input include cached prefix? - do UI/context percentages typically include cached tokens or only uncached tail? 5. If possible, compare against: - openai/codex or codex-rs implementation - official docs/issues/discussions - any evidence from ChatGPT Codex / Responses API behavior Deliverable format: - Findings first, ordered by severity/importance - For each finding, include exact source links or file references - Separate: - proven - inferred - uncertain - End with a short verdict on whether cat-code’s fast context growth is: - expected upstream behavior - expected but surfaced misleadingly in UI/token % - or a local implementation bug
```

---

## Fast re-entry checklist

If you are resuming this cold:

1. Read this document.
2. Read:
   - `src/context.ts`
   - `src/services/api/instructionAssembly.ts`
   - `src/utils/messages.ts`
   - `src/services/api/codex-fetch-adapter.ts`
   - `src/services/api/codex-websocket-transport.ts`
   - `src/tools/AgentTool/UI.tsx`
3. Inspect:
   - `/Users/pt/.cat-code/debug/80731b8e-ea94-4230-a199-b4796c1cb2b3.txt`
   - `/Users/pt/.cat-code/projects/-Users-pt-cat-code/80731b8e-ea94-4230-a199-b4796c1cb2b3.jsonl`
4. Do not spend time re-proving the local findings above unless they conflict with new upstream evidence.

