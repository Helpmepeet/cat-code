# Context-limit handling: subagent failure reporting + narrow recovery window

Date: 2026-05-01
Last updated: 2026-05-01 (incorporated review feedback)
Investigation session: `ed0deecb-a957-46df-bc9a-612b5736f8fb`

## TL;DR

Two distinct but related problems in how Cat Code handles context-window exhaustion:

1. **Subagent failure misreporting (correctness bug).** When a subagent exhausts its context window, the synthesized `"Prompt is too long"` assistant message is surfaced to the parent as a normal successful Agent tool result. The parent assistant cannot tell the subagent ran and failed; partial work (tool calls, file reads, findings) is discarded.

2. **Narrow autocompact recovery window (frequency driver).** The gap between the autocompact threshold and the blocking limit is **10,000 tokens for every model** (gpt-5.x, Claude Sonnet/Opus, even 1M Sonnet). A single oversized tool_result can leap the gap, leaving autocompact no opportunity to act. This affects **both** subagents and the main agent in non-ant builds.

The first problem is subagent-specific. The second is structural and applies broadly.

## PR plan

- **PR 1 — Problem 1 (correctness).** Land first. Makes subagent failures truthful and preserves partial work. Includes async/background lifecycle. Local to AgentTool; no `query.ts` changes.
- **PR 2 — Problem 2 (recovery window).** Separate design discussion. Changes context-management behavior globally; depends on PR 1 to make failures observable so we can measure frequency before tuning.

---

## Problem 1: Subagent context failures are reported as successful completions

### Observed behavior

In session `ed0deecb-a957-46df-bc9a-612b5736f8fb`, two subagents:

| Agent | Tool calls | Duration | Final message | Reported status |
|---|---|---|---|---|
| `a10cd434d7a6a4f84` | 67 | 126,370 ms | `isApiErrorMessage: true`, `error: "invalid_request"`, `text: "Prompt is too long"` | `completed` |
| `a82eb9f4cfc06b132` | 110 | 247,590 ms | same | `completed` |

The parent transcript records:

```
line 16:  subagent-spawned  agentId=a10cd434d7a6a4f84
line 60:  subagent-terminal status=completed durationMs=126370
line 61:  tool_result content="Prompt is too long"
line 65:  subagent-spawned  agentId=a82eb9f4cfc06b132
line 127: subagent-terminal status=completed durationMs=247590
line 128: tool_result content="Prompt is too long"
```

`toolUseResult.status` on lines 61 and 128 is `"completed"`, not `"completed_with_error"`.

The parent assistant then told the user (line 151): *"I made three Agent tool calls, but the first two were rejected immediately with `Prompt is too long`."* This was incorrect — both subagents launched, ran for minutes, and only failed at the end.

### Root cause

The synthetic `isApiErrorMessage` flag is **never read** by AgentTool finalization code:

```
$ grep -n "isApiErrorMessage" src/tools/AgentTool/agentToolUtils.ts src/tools/AgentTool/AgentTool.tsx
(no matches)
```

The flow that produces the bug:

1. **`src/query.ts:682-687`** — When pre-flight token estimation trips `isAtBlockingLimit`, the query loop yields a synthetic `createAssistantAPIErrorMessage` with `isApiErrorMessage: true` and *returns* `{ reason: 'blocking_limit' }`.

2. **`src/query.ts:1313-1316`** — When the last message has `isApiErrorMessage: true`, the loop returns `{ reason: 'completed' }` *without throwing*. (Intentional — prevents hook death-spirals on rate-limit/PTL — but it means the caller sees normal completion.)

3. **`src/tools/AgentTool/AgentTool.tsx:1276-1315`** — `syncAgentError` is only set inside a `catch` block. The query generator returned normally, so no exception propagates; `syncAgentError` stays `null`.

4. **`src/tools/AgentTool/agentToolUtils.ts:496-578` (`finalizeAgentTool`)** — Extracts text from `getLastAssistantMessage(agentMessages)` with no check for `isApiErrorMessage`. The synthetic `"Prompt is too long"` text becomes the subagent's "output."

5. **`src/tools/AgentTool/AgentTool.tsx:1466-1493`** — Both `subagent-terminal` status and the returned `data.status` are gated on `syncAgentError`, so both record `'completed'`.

6. **`src/tools/AgentTool/AgentTool.tsx:1589-1595`** — One-shot built-in agents (Plan, Explore) short-circuit on `status === 'completed'`, returning **only** the bare content with no usage/error trailer. This is why the parent saw the four-word string with zero context.

### Note on framing

An earlier reading suggested this was an Anthropic-side API error. It is not. The `"Prompt is too long"` message is **synthesized locally** in `query.ts` *before* any API call when token estimation exceeds the blocking limit. The subagent legitimately ran out of context window for its own model.

### Fix (PR 1)

Four surgical changes (A–D). No changes needed in `query.ts` — the local-synthesis behavior is correct (it prevents hook death-spirals).

**Naming:** use `error: string | undefined` as the single signal of failure. Do **not** introduce a separate `isApiError: boolean` field. The presence of `error` is the signal; two redundant fields invite drift (one set, the other not). `completed_with_error` already uses `error` for thrown-exception failures; reusing it for synthetic-API-error failures is consistent.

#### Change A — extend `AgentToolResult`

In the result schema (`agentToolResultSchema`):

```ts
error: z.string().optional(),
```

That's the only addition. The sync path's existing `error` field on `data` (used for `syncAgentError.message`) and this new `error` on the `agentResult` line up — both feed the same `completed_with_error` branch.

#### Change B — `finalizeAgentTool` detects synthetic API-error terminals

In `src/tools/AgentTool/agentToolUtils.ts:496`:

1. After `getLastAssistantMessage`, check `lastAssistantMessage.isApiErrorMessage === true`. If so, capture its text into `apiErrorText` and set `result.error = apiErrorText`.

2. In the fallback content scan (lines 506–516, the loop that searches backward for an assistant message with text content), **skip messages where `isApiErrorMessage === true`**. This is the critical change for preserving partial work — without it, the synthetic `"Prompt is too long"` text becomes the subagent's apparent output.

3. Edge case: if no prior assistant message has real text content, return `content: []` (empty). Do not fall back to the synthetic error text. The empty content combined with `error` set will cause the result mapper to render the `(Subagent completed but returned no output.)` marker plus the error trailer — correct behavior.

#### Change C — sync AgentTool path treats `agentResult.error` like `syncAgentError`

In `src/tools/AgentTool/AgentTool.tsx:1466-1493`:

```ts
const terminalError = syncAgentError?.message ?? agentResult.error
const completedWithError = Boolean(terminalError)
```

Then:

- `appendSubagentTerminal`: `status: completedWithError ? 'failed' : 'completed'`, `reason: terminalError` when set
- `recordWorkerSessionTerminal`: same `status` logic, `error: terminalError` when set
- Returned `data`: `status: completedWithError ? 'completed_with_error' : 'completed'`, with `error: terminalError` when set

#### Change D — async/background lifecycle (`runAsyncAgentLifecycle`)

This was missing from the original plan. `runAsyncAgentLifecycle` also calls `finalizeAgentTool` and records the task as `completed`; without this change, background-launched agents will keep mis-reporting (the third subagent in our investigated session was `async_launched`, so this path is exercised in practice).

After `finalizeAgentTool`:

```ts
if (agentResult.error) {
  failAsyncAgent(...)
  appendSubagentTerminal(... status: 'failed', reason: agentResult.error ...)
  recordWorkerSessionTerminal(... status: 'failed', error: agentResult.error ...)
  enqueueAgentNotification(... status: 'failed' ...)
  return
}
```

#### Result mapper — no change needed

The existing `completed_with_error` branch at `src/tools/AgentTool/AgentTool.tsx:1598-1613` already does the right thing: preserves `contentOrMarker` (partial output) **and** appends the error text and the `<usage>` trailer. The one-shot built-in short-circuit at line 1589 only fires on `status === 'completed'`, so `'completed_with_error'` naturally falls through to the full path.

### Test cases (PR 1)

Under `src/tools/AgentTool/`:

1. **API-error terminal becomes `completed_with_error`.** Final assistant message has `isApiErrorMessage: true`, `text: "Prompt is too long"` → `finalizeAgentTool` returns `error: "Prompt is too long"`; sync AgentTool path returns `data.status === 'completed_with_error'`, `data.error === "Prompt is too long"`.

2. **Subagent terminal records `failed`.** Same setup → `appendSubagentTerminal` called with `status: 'failed'`, `reason: "Prompt is too long"`.

3. **One-shot built-in preserves error trailer.** For `Plan` / `Explore` with `completed_with_error`, returned tool_result content includes partial text content **and** the trailer with `status: completed_with_error`, `error: ...`, `<usage>` block.

4. **Partial work is preserved.** Subagent has 67 tool_use blocks and produces real text content before the API error → `agentResult.content` contains that real content, not `"Prompt is too long"`. `totalToolUseCount`, `totalDurationMs`, `changedFiles` all populated.

5. **Normal completion unaffected.** Final assistant message without `isApiErrorMessage` still returns `'completed'` with existing one-shot short-circuit intact.

6. **Async agent API-error is failed, not completed.** Same synthetic terminal message routed through `runAsyncAgentLifecycle` → terminal status `failed`, notification status `failed`.

7. **No prior text before API error.** Final message is `isApiErrorMessage`, no earlier assistant text exists → `completed_with_error`, `content: []`, `error: "Prompt is too long"`. Result mapper renders the `(Subagent completed but returned no output.)` marker plus error trailer.

8. **API-error text is not selected by fallback content scan.** Earlier assistant text exists; final synthetic API error exists → `content` = earlier text, `error` = final API-error text. Critical regression test for the partial-work-preservation behavior.

---

## Problem 2: Autocompact recovery window is too narrow

### The math

For any model:

```
effectiveContextWindow = contextWindow - min(maxOutputTokens, MAX_OUTPUT_TOKENS_FOR_SUMMARY)
                       = contextWindow - 20_000   (for models with maxOut >= 20k)

autoCompactThreshold   = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS  (13_000)
blockingLimit          = effectiveContextWindow - MANUAL_COMPACT_BUFFER_TOKENS (3_000)

recoveryWindow         = blockingLimit - autoCompactThreshold = 10_000  (constant)
```

Concrete values per model:

| Model | Context | Effective | Autoc threshold | Blocking limit | Recovery window |
|---|---|---|---|---|---|
| gpt-5.4 / gpt-5.5 / gpt-5.4-mini | 272,000 | 252,000 | 239,000 | 249,000 | **10,000** |
| claude-sonnet-4-6 | 200,000 | 180,000 | 167,000 | 177,000 | **10,000** |
| claude-sonnet-4-6 [1m] | 1,000,000 | 980,000 | 967,000 | 977,000 | **10,000** |
| claude-opus-4-7 | 200,000 | 180,000 | 167,000 | 177,000 | **10,000** |

**The recovery window is a fixed 10k tokens regardless of context size.** It does not scale.

### Why this matters

A single tool_result larger than 10k tokens — common for `Read` on long files, broad `Grep` queries, large directory listings — pushes the running context from "below autocompact threshold" to "past blocking limit" in one step. Autocompact only checks at the start of each loop iteration; it cannot react to a tool_result that hasn't happened yet, and it cannot intervene mid-iteration.

The pre-flight check at `src/query.ts:678-688` then synthesizes `"Prompt is too long"` and returns `{ reason: 'blocking_limit' }`. For the main agent, the user sees the error and can recover with `/compact` or by restarting. For a subagent, the failure surfaces as Problem 1.

### Verified against this session

For subagent `a82eb9f4cfc06b132` (gpt-5.4):

- Last successful API call: `input=248,131` tokens (at 10:30:35.182, from `~/.cat-code/debug/ed0deecb-...txt`)
- One ~5,086-char tool_result (~1,300 tokens) returned
- Estimated next-call size: **~249,431 tokens**
- Autocompact threshold (239k): crossed → `shouldAutoCompact` returns true
- Blocking limit (249k): also crossed in same iteration

Autocompact would have been triggered, but no compaction request reached the API (only `[codex-cache]` log lines exist for this session — non-ant builds suppress all other `logForDebugging` output, see `src/utils/debug.ts:117`). Most likely autocompact attempted to fork a compact agent, which itself failed because summarizing ~249k of context puts the compact request within ~3k of the model's 272k input limit. We cannot directly observe this from logs.

### Effect on the main agent

The same vulnerability applies to the main agent in **non-ant builds**:

- `query.ts:1135-1226` contains 413/PTL recovery paths (collapse drain, reactive compact strip-retry) but they are guarded by `feature('CONTEXT_COLLAPSE')` and optional `reactiveCompact?` modules
- Both `contextCollapse` and `reactiveCompact` are dead-code-eliminated from non-ant builds (verified: neither string appears in `cli` or `cli-dev` binaries)
- In this build, the main agent has **the same recovery posture as a subagent**: only proactive autocompact at the threshold, then synthetic PTL at blocking limit

The main agent's parent thread (`conv=6922b11b` on gpt-5.5) reached ~200k tokens during this session — within 39k of the threshold. A larger conversation would hit the same wall.

**Differences are in user impact, not vulnerability:**

- **Main agent failure** → user sees `"Prompt is too long"` in REPL, can run `/compact` or restart. Recoverable.
- **Subagent failure** → parent assistant sees only `"Prompt is too long"` as a tool result, cannot tell what happened, partial work is lost, may waste another Agent call retrying. Compounds with Problem 1.

### Why the buffer constants look reasonable but aren't

- `AUTOCOMPACT_BUFFER_TOKENS = 13_000` — room for autocompact to run before blocking
- `MANUAL_COMPACT_BUFFER_TOKENS = 3_000` — room for the user to invoke `/compact` after blocking
- `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000` — reservation for the autocompact summary output

The 13k autocompact buffer assumes at most one *normal* tool turn fits inside it. With agents on large repos using `Read`/`Grep` heavily, that assumption breaks. A single large tool_result is structurally able to leap from below-threshold to past-blocking, and there is no mid-iteration intervention.

### Candidate fixes (PR 2 — separate design discussion)

PR 2 changes context-management behavior globally and warrants its own review. PR 1 should land first; it makes failures truthful so we can observe Problem 2's frequency before tuning.

Note on the obvious-looking 5% rule: `max(13_000, 0.05 * effectiveWindow)` does **not** help the model class that's actually failing. For gpt-5.4 (effective 252k), 5% = 12.6k, which the `max` clamps back to 13k — i.e. zero change. It only helps the 1M Sonnet (49k buffer). A 5% rule documents the problem without fixing it for the workload that produced this report.

The real choice is between two mechanisms:

1. **Buffer-floor bump.** E.g. `max(20_000, 0.05 * effectiveWindow)`, or a tiered constant — 13k for ≤200k models, 25–30k for ≥256k models. Adjusts the size of the gap. Simple to implement; trades some usable context. Doesn't address the underlying mechanism (a single oversized tool_result can still exceed any fixed gap).

2. **Per-tool_result cap (preferred).** Tighten `applyToolResultBudget` (`src/utils/toolResultStorage.ts`) to cap any individual tool_result at e.g. 8k tokens. Addresses the leap-the-gap mechanism directly: if no single result can produce >8k tokens, the gap can be narrower and still safe. Already exists in some form, but per the reviewer's note, tools with `Number.isFinite(t.maxResultSizeChars) === false` skip the aggregate path — so large `Read`-style outputs bypass the budget today. Audit needed.

Other options worth recording but lower priority:

3. **Restore reactive PTL recovery for external builds.** `query.ts:1135-1226` has the recovery infrastructure but it's guarded behind `contextCollapse` / `reactiveCompact`, both dead-code-eliminated for non-ants. A stripped-down version (drop oldest tool_results when blocking is imminent) would catch the leap-the-gap case after-the-fact. Requires re-evaluating why the ant-only gating exists.

4. **Subagent-specific: fail loud instead of compact.** A subagent that hits the limit is usually scoped too broadly. Once Problem 1 is fixed, the parent can re-plan rather than letting the subagent degrade itself through mid-task summarization. This is more about *not* adding subagent-side recovery than adding it.

Recommendation: lead with (2) — it's the most targeted and the least invasive. (1) as a fallback if the audit shows the budget can't be reliably tightened. (3) and (4) are deferrable.

---

## Why neither problem was caught earlier

- The synthetic-PTL message was added in `query.ts:1313` to prevent hook death-spirals, with `return { reason: 'completed' }` chosen over throwing to keep the rest of the loop simple. AgentTool was written assuming `'completed'` meant the subagent succeeded.
- The 10k recovery window was sized for Claude 200k models with conservative tool_result sizes. Increasing tool result sizes (Read/Grep on large repos) and the move to higher-context gpt-5.x models did not prompt a re-tuning.
- Non-ant builds' `logForDebugging` filtering (`src/utils/debug.ts:117`) means autocompact failures, blocking-limit hits, and finalize_missing_usage warnings are silently dropped; only `[codex-cache]` events survive. This makes both problems hard to diagnose from user-shared logs.

## Severity

- **Problem 1: high.** Actively corrupts the parent assistant's reasoning about subagent state. False user-facing claims; wasted retries; lost work. Subagent-specific.
- **Problem 2: medium-to-high.** Structural; affects all agents in non-ant builds. Frequency depends on workload (large-repo agentic flows hit it often, focused tasks rarely). Hard to observe due to log filtering.

The two compound: Problem 2 produces the failure, Problem 1 hides it.
