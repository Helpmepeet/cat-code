# Codex Usage Race Condition — Full Engineering Report

> **Date**: 22 Apr 2026
> **Status**: Fix applied, monitoring
> **Error**: `"undefined is not an object (evaluating 'q.input_tokens')"`
> **Minified stack**: `q.input_tokens` → variable `q` = `usage`, property `input_tokens`

---

## 1. The Crash

The orchestrator accesses `lastAssistantMessage.message.usage` without a null guard. When `usage` is `undefined`, the subsequent `usage.input_tokens` dereference throws a TypeError.

### Crash site (before fix)

```typescript
// orchestrator.ts:1867 (before fix)
const usage = lastAssistantMessage.message.usage      // ← undefined
const totalTokens =
    usage.input_tokens +                                // ← CRASH
    usage.output_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
```

### When does `usage` arrive?

The SSE streaming protocol delivers usage in **two phases**:

```
message_start  →  usage: { input_tokens: 0, output_tokens: 0 }   (zeroed placeholder)
content_block_start / content_block_delta / content_block_stop    (actual content)
message_delta  →  usage: { input_tokens: 1234, output_tokens: 567 }  (real values)
```

The `AssistantMessage` object is **yielded at `content_block_stop`** (claude.ts:2295-2314). The real `usage` from `message_delta` is **written back via direct mutation** at claude.ts:2360:

```typescript
lastMsg.message.usage = usage   // direct property mutation after yield
```

### The race window

```
  TIME ──────────────────────────────────────────────────────►

  content_block_stop           message_delta
       │                            │
       ▼                            ▼
  yield AssistantMessage       lastMsg.message.usage = usage
  (usage = partialMessage      (real values written back
   .usage from message_start)   via mutation)

       ◄────── RACE WINDOW ──────►
       Any reader accessing .message.usage
       in this window sees zeroed or undefined values
```

---

## 2. Root Causes

### Root Cause 1: Type system hole

`AssistantMessage.message` did not declare `usage` in its TypeScript type:

```typescript
// types/message.ts (BEFORE fix)
message: {
    id?: string
    model?: string
    role?: 'assistant'
    content: TContentBlock[]
    // ← NO usage field → TypeScript can't enforce access guards
}
```

This meant TypeScript couldn't warn when code accessed `.message.usage` without a null check.

### Root Cause 2: Missing guard in orchestrator

The orchestrator copied the usage-access pattern from `agentToolUtils.ts` but **without** the guard that `agentToolUtils.ts` already had:

```typescript
// agentToolUtils.ts:355-367 — HAS the guard ✅
if (!lastAssistantMessage.message.usage) {
    logForDebugging(`[agent-tool] finalize_missing_usage ...`)
}
const totalTokens = lastAssistantMessage.message.usage
    ? getTokenCountFromUsage(lastAssistantMessage.message.usage)
    : (totalTokensOverride ?? 0)

// orchestrator.ts:1867 — MISSING the guard ❌
const usage = lastAssistantMessage.message.usage   // ← no fallback
const totalTokens = usage.input_tokens + ...       // ← crash
```

### Root Cause 3: Scenarios where `usage` is undefined

| Scenario | How `usage` becomes undefined |
|----------|-------------------------------|
| **Race window** | Message yielded at `content_block_stop` before `message_delta` writes real usage back |
| **Deserialized transcripts** | Messages read from disk may lack `usage` if serialized during the race window |
| **Synthetic messages** | `createAssistantMessage()` factory always includes `usage` (safe), but direct `{ message: { ... } }` construction might not |
| **Stream interruption** | If streaming aborts between `content_block_stop` and `message_delta`, usage is never written back |
| **Codex adapter quirks** | The synthetic `message_start` only had `{ input_tokens: 0, output_tokens: 0 }` — missing `cache_creation_input_tokens` and `cache_read_input_tokens` |

---

## 3. What We Fixed (4 Layers)

### Layer 1: Type system — `types/message.ts`

```diff
-import type { BetaContentBlock } from '@anthropic-ai/sdk/...'
+import type { BetaContentBlock, BetaUsage } from '@anthropic-ai/sdk/...'

 message: {
     id?: string
     model?: string
     role?: 'assistant'
     content: TContentBlock[]
+    usage?: BetaUsage
+    stop_reason?: string | null
+    stop_sequence?: string | null
 }
```

**Purpose**: Makes the gap visible to TypeScript. Future consumers get red squiggles if they access `usage` without checking.

### Layer 2: Message construction — `claude.ts`

```diff
 // Streaming path (content_block_stop) — L2298
 const m: AssistantMessage = {
     message: {
         ...partialMessage,
+        usage: partialMessage.usage ?? { ...EMPTY_USAGE },
         content: normalizeContentFromAPI(...)
     },

 // Non-streaming fallback — L2696
 const m: AssistantMessage = {
     message: {
         ...result,
+        usage: result.usage ?? { ...EMPTY_USAGE },
         content: normalizeContentFromAPI(...)
     },
```

**Purpose**: Structural guarantee — every `AssistantMessage` has a valid `usage` object from birth, even if `partialMessage` or `result` somehow lacks one. Uses `{ ...EMPTY_USAGE }` (spread copy) so each message gets its own mutable object (the `message_delta` write-back mutates it).

### Layer 3: Crash site guard — `orchestrator.ts`

```diff
+import { EMPTY_USAGE } from '../services/api/emptyUsage.js'

-const usage = lastAssistantMessage.message.usage
+const usage = lastAssistantMessage.message.usage ?? EMPTY_USAGE
```

**Purpose**: Direct crash prevention. Even if Layers 1 & 2 fail (e.g., message came from disk, from an older adapter, or from a code path we missed), this guard prevents the TypeError.

### Layer 4: Codex adapter — `codex-fetch-adapter.ts`

```diff
 usage: {
     input_tokens: 0,
     output_tokens: 0,
+    cache_creation_input_tokens: 0,
+    cache_read_input_tokens: 0,
 },
```

**Purpose**: The synthetic `message_start` emitted by the Codex adapter was missing cache token fields. While these default to `0` via `?? 0` at most access sites, their absence could cause unexpected behavior in code that iterates or spreads usage properties.

---

## 4. All `.message.usage` Access Sites (Audit)

These are **every site** in the codebase that accesses `.message.usage`. If the crash recurs, check these:

| # | File | Line | Code | Guard | Risk |
|---|------|------|------|-------|------|
| 1 | [orchestrator.ts](file:///Users/pt/cat-code/src/agent-mode/orchestrator.ts#L1868) | 1868 | `lastAssistantMessage.message.usage ?? EMPTY_USAGE` | ✅ **FIXED** | Was the crash site |
| 2 | [agentToolUtils.ts](file:///Users/pt/cat-code/src/tools/AgentTool/agentToolUtils.ts#L355) | 355 | `if (!lastAssistantMessage.message.usage)` | ✅ Guarded | Team already added diagnostic |
| 3 | [agentToolUtils.ts](file:///Users/pt/cat-code/src/tools/AgentTool/agentToolUtils.ts#L366-367) | 366 | `usage ? getTokenCountFromUsage(usage) : override` | ✅ Guarded | Ternary fallback |
| 4 | [agentToolUtils.ts](file:///Users/pt/cat-code/src/tools/AgentTool/agentToolUtils.ts#L405) | 405 | `usage: lastAssistantMessage.message.usage` | ⚠️ Pass-through | Only reached if L366 guard passes |
| 5 | [claude.ts](file:///Users/pt/cat-code/src/services/api/claude.ts#L2354) | 2354 | `lastMsg.message.usage !== undefined` | ✅ Existence check | Diagnostic logging |
| 6 | [claude.ts](file:///Users/pt/cat-code/src/services/api/claude.ts#L2360) | 2360 | `lastMsg.message.usage = usage` | ✅ Write (assignment) | Write-back mutation |
| 7 | [claude.ts](file:///Users/pt/cat-code/src/services/api/claude.ts#L2953) | 2953 | `fallbackMessage.message.usage` | ✅ Safe | Non-streaming path, `result` from API always has usage |
| 8 | [query.ts](file:///Users/pt/cat-code/src/query.ts#L919) | 919 | `lastAssistant?.message.usage` | ✅ Optional chain + ternary | `usage ? ... : 0` |
| 9 | [promptSuggestion.ts](file:///Users/pt/cat-code/src/services/PromptSuggestion/promptSuggestion.ts#L246) | 246 | `lastAssistantMessage.message.usage` | ✅ Guarded | `if (!usage) return null` at L247 |
| 10 | [tokens.ts](file:///Users/pt/cat-code/src/utils/tokens.ts#L17-24) | 17 | `'usage' in message.message` | ✅ `in` operator | Returns `undefined` if absent |
| 11 | [stats.ts](file:///Users/pt/cat-code/src/utils/stats.ts#L309-310) | 309 | `if (message.message?.usage)` | ✅ Optional chain + if | Reads from disk transcripts |
| 12 | [vcr.ts](file:///Users/pt/cat-code/src/services/vcr.ts#L170) | 170 | `message.message.usage` | ⚠️ **Unguarded** | Test/ant-internal only; passes to `calculateUSDCost` |
| 13 | [microCompact.ts](file:///Users/pt/cat-code/src/services/compact/microCompact.ts#L378) | 378 | `lastAsst.message.usage as unknown as Record<...>` | ⚠️ Cast | Uses `?? 0` on the accessed field |
| 14 | [sessionStorage.ts](file:///Users/pt/cat-code/src/utils/sessionStorage.ts#L2007) | 2007 | `...msg.message.usage` | ⚠️ **Unguarded spread** | Only in preserved-segment compact context |
| 15 | [QueryEngine.ts](file:///Users/pt/cat-code/src/QueryEngine.ts#L851) | 851 | `message.event.message.usage` | ✅ Safe | Stream event, not AssistantMessage |

### Remaining risk sites (not fixed, low priority)

- **vcr.ts:170** — Only runs in test/VCR recording mode. If it crashes, it would only affect fixture recording, not production.
- **sessionStorage.ts:2007** — Spread inside `applyPreservedSegmentRelinks`. Only runs during session resume compact boundary processing. If `usage` is undefined, spread of `undefined` is a no-op in JS (safe), but the subsequent explicit `input_tokens: 0` overwrites handle it.
- **microCompact.ts:378** — Cast through `unknown` then `?? 0` on the field access. Safe unless the cast itself throws (it won't).

---

## 5. Key File Locations

| What | File | Key Lines |
|------|------|-----------|
| `EMPTY_USAGE` constant | [emptyUsage.ts](file:///Users/pt/cat-code/src/services/api/emptyUsage.ts#L8-L22) | L8-22 |
| `AssistantMessage` type | [message.ts](file:///Users/pt/cat-code/src/types/message.ts#L71-L90) | L71-90 |
| Streaming message construction | [claude.ts](file:///Users/pt/cat-code/src/services/api/claude.ts#L2295-L2314) | L2295-2314 |
| `message_delta` write-back mutation | [claude.ts](file:///Users/pt/cat-code/src/services/api/claude.ts#L2348-L2362) | L2348-2362 |
| Race window comment | [claude.ts](file:///Users/pt/cat-code/src/services/api/claude.ts#L2340-L2345) | L2340-2345 |
| Non-streaming fallback message | [claude.ts](file:///Users/pt/cat-code/src/services/api/claude.ts#L2695-L2706) | L2695-2706 |
| Crash site (fixed) | [orchestrator.ts](file:///Users/pt/cat-code/src/agent-mode/orchestrator.ts#L1868) | L1868 |
| AgentTool guard (reference) | [agentToolUtils.ts](file:///Users/pt/cat-code/src/tools/AgentTool/agentToolUtils.ts#L349-L368) | L349-368 |
| Codex synthetic message_start | [codex-fetch-adapter.ts](file:///Users/pt/cat-code/src/services/api/codex-fetch-adapter.ts#L732-L736) | L732-736 |
| `createAssistantMessage` factory | [messages.ts](file:///Users/pt/cat-code/src/utils/messages.ts#L363-L397) | L363-397 |
| Timeout message path | [orchestrator.ts](file:///Users/pt/cat-code/src/agent-mode/orchestrator.ts#L1988-L1994) | L1988-1994 |

---

## 6. Diagnostic Signals

### If the crash recurs

1. **Check the log for `[agent-tool] finalize_missing_usage`** — this is the existing diagnostic at agentToolUtils.ts:355. If you see it, usage is still undefined at finalization time despite our Layer 2 fix, meaning the `partialMessage.usage` fallback was bypassed.

2. **Check the log for `[provider] late_usage_writeback`** — this is at claude.ts:2356. The `had_prior_usage` field tells you whether the message already had usage from `content_block_stop` time.

3. **Check if the crash is in orchestrator or elsewhere** — our Layer 3 guard only protects `orchestrator.ts:1868`. If the same `undefined` crash appears at a different call site, check the audit table above.

4. **Check the streaming source** — is this a Claude API message or a Codex adapter message? The Codex adapter's synthetic `message_start` path is different from Claude's native SSE.

### Debug commands

```bash
# Find all unguarded .message.usage accesses
rg '\.message\.usage' src/ --type ts -n | grep -v '??' | grep -v '?.' | grep -v 'if.*usage' | grep -v '!.*usage' | grep -v '= usage'

# Check if EMPTY_USAGE is properly imported everywhere it's used
rg 'EMPTY_USAGE' src/ --type ts -n

# Find message construction sites that might skip usage
rg 'AssistantMessage\s*=' src/ --type ts -n
```

---

## 7. What This Fix Does NOT Cover

| Gap | Why we left it | Risk |
|-----|----------------|------|
| `vcr.ts:170` unguarded access | Test/internal only; doesn't affect production users | Very low |
| `sessionStorage.ts:2007` spread | JS `...undefined` is a no-op; explicit zeroed fields follow | None (JS-safe) |
| Other consumers added in future | Type system (Layer 1) will now flag missing guards at compile time | Mitigated |
| Transcript deserialization from old sessions | Old transcripts may have messages without `usage`; reading code (stats.ts, tokens.ts) already guards for this | Low |
| `message_delta` never arriving (abort during stream) | Layer 2 ensures zeroed `EMPTY_USAGE` is present from birth; the zeroed values are harmless for token accounting | None |

---

## 8. Verification Checklist

- [x] `npx tsc --noEmit` — zero new type errors from our changes
- [x] All 4 modified files compile cleanly
- [x] `EMPTY_USAGE` import resolves in orchestrator.ts (from `emptyUsage.ts`, not `logging.ts` — avoids circular deps)
- [x] `{ ...EMPTY_USAGE }` spread creates a fresh mutable copy (safe for write-back mutation at claude.ts:2360)
- [x] Codex adapter cache fields align with `EMPTY_USAGE` shape
- [ ] Runtime test with Codex-backed subagent spawning (agent mode orchestrator)
- [ ] Monitor for `[agent-tool] finalize_missing_usage` log entries post-deploy
