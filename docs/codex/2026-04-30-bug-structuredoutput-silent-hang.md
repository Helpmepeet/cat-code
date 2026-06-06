# Bug: gpt-5.4 emits `StructuredOutput` tool calls — session hangs silently

**Session:** `4deaaab5-d330-4f8f-9769-9976d32442b3`  
**Date:** 2026-04-21 08:18–08:20 UTC  
**Model:** `gpt-5.4` (Codex WebSocket path)  
**Severity:** High — session is completely unresponsive to the user with no error shown

---

## What happened

User sent a prompt. The session never produced a visible response. The terminal appeared to hang for ~2 minutes before the user killed it.

---

## Root cause

### Background: what `StructuredOutput` is

`StructuredOutput` is a **cat-code–internal tool**, not an OpenAI built-in. It is defined as `SYNTHETIC_OUTPUT_TOOL_NAME = 'StructuredOutput'` in `src/tools/SyntheticOutputTool/SyntheticOutputTool.ts:20`. It is injected into the tool list only when:

1. `--json-schema` flag is set (`isSyntheticOutputToolEnabled`, `src/main.tsx:1987`)
2. The active model supports structured outputs (`modelSupportsStructuredOutputs()`, `src/utils/betas.ts:142`), which **explicitly returns `false` for all non-Anthropic models and all Codex/OpenAI models**

Verified against the openai/codex repo and OpenAI platform docs: there is **no built-in tool named `StructuredOutput`** in the OpenAI Responses API. Structured outputs in OpenAI are a `response_format`/`json_schema` parameter, not a tool. The `gpt-5.4` model supports Functions, Web search, File search, and Computer use — nothing called `StructuredOutput`.

### What actually happened

`gpt-5.4` called a tool named `StructuredOutput` (call ID `call_YV0XRToFpjntYNP1guuqV5Kt`) even though:
- the tool was never registered for this session
- `gpt-5.4` is not even a model that would receive the tool in its tool list

The most probable cause: the conversation history (replayed via `[codex-ws] full send input=1 items`) included system context or a prior assistant message that described the `StructuredOutput` tool schema — from a preceding Claude session that had `--json-schema` active. `gpt-5.4` pattern-matched on that and attempted to call it. This is a **context bleed** from a Claude-mode session into a Codex-mode session.

### Failure chain (from debug log)

```
08:18:26  User prompt received
08:18:26  [codex-ws] full send, model=gpt-5.4, messages=1
08:18:31  gpt-5.4 responds → StructuredOutput (call_YV0XRToFpjntYNP1guuqV5Kt)
08:18:31  [ERROR] Tool StructuredOutput not found         ← thrown in React render (dy7)
08:18:31  [DEBUG] Unknown tool StructuredOutput            ← toolExecution.ts:371
           toolExecution yields tool_use_error back to model, continues
08:18:31  QueryEngine re-sends to gpt-5.4, messages=4 (turn 2)
08:20:08  [ERROR] Tool StructuredOutput not found         ← turn 2, same call
08:20:11  [DEBUG] Unknown tool StructuredOutput            ← toolExecution.ts:371
           tool_use_error returned again, messages=9 (turn 3)
08:20:13  [ERROR] Cannot find package 'image-processor-napi'
           → Ink re-render storm (100+ "High write ratio" events), UI locked
08:20:18  Session ends with no user-visible output
```

The model called the same unknown tool on **every single turn**. No error was shown to the user.

---

## Two bugs

### Bug 1 — Context bleed: `StructuredOutput` schema visible to Codex model

**Severity:** High  
**Where:** session history handling / conversation replay

When a Codex session inherits or replays conversation history that includes the `StructuredOutput` tool schema (from a Claude session), `gpt-5.4` sees that schema and tries to call it. The tool is 100% internal to cat-code and should never be visible in Codex-path conversation history.

**Fix:**
- Before replaying conversation history to a Codex/OpenAI model, filter out any assistant messages that contain `StructuredOutput` tool calls, and any tool_result messages that respond to them.
- Alternatively, rename the tool to something clearly internal (e.g., `cc_StructuredOutput`) so OpenAI models are less likely to pattern-match on it.

### Bug 2 — Silent infinite retry on unknown tool

**Severity:** High  
**Where:** `src/services/tools/toolExecution.ts:369-409`

When a tool call cannot be resolved, `toolExecution` yields a `tool_use_error` result back to the model and returns normally. The QueryEngine then fires another API request. If the model ignores the error and repeats the same unknown tool call (which `gpt-5.4` did every turn), the loop runs indefinitely with no user-visible feedback.

The error is thrown in a React render path (`dy7` in the minified bundle, line 2412) and logged at `[ERROR]`, but **never surfaced as a visible message in the terminal UI**.

**Fix:**
- Track consecutive unknown-tool errors for the same tool name within a single turn.
- After 2 occurrences, abort the turn and display an explicit error to the user:  
  `"Model attempted to call unknown tool 'StructuredOutput'. Aborting."`

---

## Secondary issue — `image-processor-napi` missing

At `08:20:13`, immediately after the third loop, this error fires:

```
[ERROR] ResolveMessage: Cannot find package 'image-processor-napi' from '/$bunfs/root/cli.js'
```

This is unrelated to the hang but caused a cascade of ~100 Ink re-render events (`blit=0, write=4896, 100% writes`) that locked the terminal. The package is a native image-processing addon that's absent from the Bun bundle in some environments. Clipboard image paths now treat the native import as an optional fast path and fall back without reporting the missing package as an error.

---

## Files to touch

| File | What to change |
|------|----------------|
| `src/services/tools/toolExecution.ts:369` | Count consecutive same-name unknown-tool errors per turn; abort + surface error after threshold (2) |
| Conversation history / replay layer | Strip `StructuredOutput` tool calls and their results from history before Codex sends |
| `src/tools/SyntheticOutputTool/SyntheticOutputTool.ts:20` | Consider renaming to `cc_StructuredOutput` to reduce collision risk |
| Clipboard `image-processor-napi` imports | Fixed: missing optional native module falls back without `logError` spam |
