# Bug: Codex websocket continuation is too fragile, causing repeated full sends and runaway context growth

**Session:** `4b6fe61b-3503-480b-b4e1-90ba5d6ab267`  
**Workspace:** `/Users/pt/project/SEML_PROJ`  
**Date:** 2026-04-23  
**Severity:** High for latency and cache efficiency  
**Scope of this report:** system issues only

This report intentionally ignores:
- worktree/subagent orchestration failures
- model effort policy tradeoffs

It focuses only on:
1. why the main thread fell back to `mode:"full"` on almost every turn
2. why later turns carried very large context and became expensive

---

## What happened

On the main session thread, only the first main Codex turn used incremental continuation. After that, the websocket path mostly degraded into full re-sends.

Evidence from the session JSONL:

- first main turn was incremental at `/Users/pt/.cat-code/projects/-Users-pt-project-SEML-PROJ/4b6fe61b-3503-480b-b4e1-90ba5d6ab267.jsonl:10`
- subsequent main turns were full sends at `:19`, `:26`, `:31`, `:35`, `:44`, `:49`, `:62`, `:71`, `:84`, `:89`, `:97`, `:105`
- later turns also carried very large inputs:
  - `65,439` input tokens at `:89`
  - `65,230` at `:97`
  - `66,189` at `:105`
- cache continuity also degraded:
  - `15,872 → 13,824` at `:64`
  - `15,872 → 0` at `:74`
  - `18,944 → 15,872` at `:91`

This is not mainly a TTFB problem. Those turns still had decent `ttfb_ms`, usually `206–351ms`, while `total_stream_ms` stayed high.

---

## Root Cause 1: continuation matching requires exact replay of prior input/output bytes, but the caller rebuilds that replay from mutable transcript state

The websocket continuation path only works when the next request's `input[]` begins with an exact structural replay of:

`previous_input + previous_output_items`

That check is implemented in [src/services/api/codex-websocket-transport.ts](/Users/pt/cat-code/src/services/api/codex-websocket-transport.ts:281):

- `responseItemsEqual(...)` uses `JSON.stringify(left) === JSON.stringify(right)` at lines `281–286`
- `getIncrementalInputDelta(...)` requires the new `input[]` to be a strict prefix extension at lines `288–305`
- if that fails, the transport falls back to full send and clears continuation state at lines `530–560`

That design would be fine if the next turn reused the exact same Codex `input[]` items. It does not.

Instead, each request rebuilds `_openaiInstructionAssembly.inputMessages` from transcript state in [src/services/api/claude.ts](/Users/pt/cat-code/src/services/api/claude.ts:1627), then normalizes those messages again via `normalizeMessagesForAPI(...)` at lines `1632–1636`.

From there, the Codex adapter reconstructs a fresh `input[]` array in [src/services/api/codex-fetch-adapter.ts](/Users/pt/cat-code/src/services/api/codex-fetch-adapter.ts:310):

- assistant text blocks are re-emitted as separate Codex `message` items at lines `454–462`
- assistant tool calls are re-emitted as `function_call` / `custom_tool_call` items at lines `463–487`
- user tool results are re-emitted as `function_call_output` items at lines `394–410`
- the full rebuilt array is used directly as `codexBody.input` at lines `522–535`

The replay is therefore not sourced from the exact raw items the server saw last turn. It is re-derived from higher-level transcript objects after several normalization and merge passes.

### Why that replay is unstable

[src/utils/messages.ts](/Users/pt/cat-code/src/utils/messages.ts:2143) mutates API-bound history in ways that are reasonable for prompt hygiene but hostile to byte-stable continuation:

- injects `Tool loaded.` boundary siblings for tool references at lines `2143–2189`
- normalizes assistant tool inputs and canonical tool names at lines `2208–2247`
- merges assistant messages with the same message id at lines `2253–2273`
- conditionally relocates tool-reference siblings at lines `2302–2312`
- runs multiple cleanup passes over assistant/user content at lines `2314–2352`
- can append `[id:...]` tags to user messages at lines `2354–2373`
- merges adjacent user messages, preserving or changing UUID/meta semantics at lines `2420–2445`

Those passes are useful locally, but they mean the Codex `input[]` for turn `N+1` is a re-serialization of normalized transcript state, not a canonical replay of turn `N`.

Because the websocket matcher is strict, harmless structural drift is enough to break continuation.

### Why I think this is the main cause of the `full`-send pattern

- In the SEML session, the main thread kept the same instruction hash `f49ca80c` while repeatedly flipping to `mode:"full"` instead of `incremental`.
- The websocket transport only has three continuation blockers:
  - no prior response id
  - non-input request fields changed
  - input is not a strict prefix extension
- For most of these turns, the same instruction hash and same session key strongly suggest the failure is in the input replay, not in the non-input signature.
- The current codebase has no end-to-end test that exercises:
  - transcript normalization
  - Codex input translation
  - websocket continuation matching
  in one chain.

The existing websocket tests in [src/services/api/codex-websocket-transport.test.ts](/Users/pt/cat-code/src/services/api/codex-websocket-transport.test.ts:157) only verify happy-path incremental continuation when the caller provides already-stable Codex items. They do not cover replay through `normalizeMessagesForAPI(...)` plus `translateMessages(...)`.

---

## Root Cause 2: the Codex path keeps sending the full normalized history every turn, so context balloons

The second issue is more direct.

The OpenAI/Codex request path rebuilds and sends the entire normalized message history on every request:

- `claude.ts` passes normalized `inputMessages` into `_openaiInstructionAssembly` at [src/services/api/claude.ts](/Users/pt/cat-code/src/services/api/claude.ts:1631)
- `translateToCodexBody(...)` converts all of those messages into Codex `input[]` at [src/services/api/codex-fetch-adapter.ts](/Users/pt/cat-code/src/services/api/codex-fetch-adapter.ts:503)
- `codexBody.input = input` is assigned directly at lines `522–535`

There is no Codex-specific trimming step in that path before send.

This matches the existing repo note in [docs/codex/2026-04-30-cache-context-truncation.md](/Users/pt/cat-code/docs/codex/2026-04-30-cache-context-truncation.md:1), which already documents that `translateToCodexBody()` sends the full message array and that large contexts can trigger server-side truncation and cache drops.

### Why this is a system bug, not just “big task = big prompt”

Large context is expected sometimes. The problem here is that the system keeps carrying forward more raw history than the websocket continuation path can efficiently exploit:

- once continuation falls back to `full`, the transport loses the main benefit of the websocket chain
- the full translated history still keeps growing
- later turns become more expensive to send, more expensive to process, and more likely to lose cache continuity

The session shows this clearly:

- around mid-session, main-thread sends are still around `19k` input tokens at `:62` and `:71`
- later they jump to `65k+` at `:89`, `:97`, `:105`
- cache continuity gets worse at the same time

So the problem is not just “the repo was large”. It is that the current Codex path lacks a stable compaction boundary between transcript state and provider-native replay state.

---

## Why these two bugs are coupled

These are not separate accidents.

The current design does both of these at once:

1. rebuilds provider-native history from mutable transcript state each turn
2. sends the full rebuilt history each turn

That combination causes:

- fragile websocket continuation
- frequent `full` fallback
- context growth that keeps compounding on the full-send path
- cache misses that become harder to distinguish between client drift and server truncation

---

## Expected behavior

For a stable Codex websocket session:

- the main thread should stay incremental across ordinary turns when non-input request fields have not changed
- provider-native replay items should remain stable across turns
- large transcript history should be compacted or summarized before it routinely expands into `65k+` token Codex requests

---

## Suggested fixes

### Fix A: persist and reuse canonical Codex replay items instead of rebuilding them from transcript state

Do not use `normalizeMessagesForAPI(...)` + `translateMessages(...)` as the source of truth for continuation replay.

Instead:

- persist the exact provider-native `input[]` items that were sent last turn
- persist the exact normalized output items that the server completed
- build the next delta against those canonical provider-native items
- keep transcript normalization for UI/history concerns, but decouple it from websocket continuation state

This would remove most of the false `strict prefix extension` failures.

### Fix B: add first-mismatch diagnostics to the websocket matcher

Right now the transport only logs:

- `input is not a strict prefix extension of prior input + output`

It should also log:

- the first mismatching index
- prior item type vs current item type
- a short diff hint for common cases like:
  - merged assistant blocks
  - injected `Tool loaded.` sibling
  - `[id:...]` tag added
  - normalized tool input drift

Without this, future regressions will be expensive to diagnose.

### Fix C: add a Codex-specific compaction boundary before `translateToCodexBody()`

The Codex path needs a clearer policy for what survives into provider-native replay:

- compact or summarize older large file/tool outputs before they become part of every subsequent request
- avoid carrying transcript-only helper artifacts into long-lived provider replay
- add token guardrails before the translated Codex `input[]` routinely reaches the `60k+` range

This should happen before `codexBody.input` is materialized, not after the server starts truncating.

### Fix D: add end-to-end regression tests across normalization + translation + continuation

Missing test class:

- start from transcript-style messages
- run `normalizeMessagesForAPI(...)`
- run `translateToCodexBody(...)`
- simulate a completed Codex response
- verify next-turn continuation stays incremental when no semantic change occurred

At least one regression test should cover:

- assistant message merge behavior
- tool_reference boundary injection/relocation
- user message tagging / merge behavior

---

## Files to inspect first

- [src/services/api/codex-websocket-transport.ts](/Users/pt/cat-code/src/services/api/codex-websocket-transport.ts:281)
- [src/services/api/codex-fetch-adapter.ts](/Users/pt/cat-code/src/services/api/codex-fetch-adapter.ts:310)
- [src/services/api/claude.ts](/Users/pt/cat-code/src/services/api/claude.ts:1627)
- [src/utils/messages.ts](/Users/pt/cat-code/src/utils/messages.ts:2143)
- [docs/codex/2026-04-30-cache-context-truncation.md](/Users/pt/cat-code/docs/codex/2026-04-30-cache-context-truncation.md:1)

---

## Bottom line

The root system problem is not “Codex is slow”.

It is that the websocket continuation layer expects a provider-native replay that is structurally stable, while the caller regenerates that replay from a transcript pipeline that intentionally rewrites message structure. Once that breaks continuation, the same path keeps dragging an ever-larger full history forward, which inflates latency and destabilizes cache reuse.
