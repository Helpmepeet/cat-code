# Codex Cache Drop 2 — Context Truncation at Skill Injection Boundary

**Status:** Open — detection added, prevention not implemented  
**Session analyzed:** `6e18e0aa-7349-45ff-8983-55b136d03370` (2026-04-20)  
**Working directory:** `/Users/pt/cat-code`  
**Build command:** `bun scripts/build.ts --feature-set=dev-full --dev` → `./cli-dev`

---

## What happened

At turn 131 of the session, the Codex prefix cache dropped from **127,744 → 0 tokens** (full miss). The `/review-impl` skill was invoked immediately before this turn.

### Token arithmetic

```
Turn 122 (last cached):  130,415 total  = 2,671 uncached + 127,744 cached
  /review-impl invoked → skill injected ~1,622 tokens as new user message
Turn 131 (full miss):    125,215 total  = 125,215 uncached + 0 cached

Expected (simple append): 130,415 + 1,622 = 132,037
Actual:                    125,215
Context shrank by:         130,415 − 125,215 = 5,200 tokens
Net pruned (shrank + new): 5,200 + 1,622 = ~6,822 tokens removed
```

The Codex server pruned ~6,822 tokens of old messages to fit within what appears to be a ~131,072 token prefix cache eviction boundary. This changed the prefix → full cache miss.

### Timeline (all timestamps 2026-04-20)

```
09:22:53  Turn 122 completes — 127,744 cached, 130,415 total context
09:22:53  system/informational: "Cache miss: likely server-side (prompt unchanged, <5min gap)
          (cached tokens: 44,800 → 13,824)"  ← earlier drop, unrelated
09:22:59  User invokes /review-impl
09:22:59  L125: user message — raw /review-impl command (88 chars)
09:22:59  L126: user message (isMeta=True) — skill content injected, ~6,489 chars (~1,622 tokens)
09:22:59  L127: file-history-snapshot (NOT sent to API, irrelevant)
09:23:18  Turn 131 completes — 0 cached, 125,215 total context
          model=gpt-5.4, msg_id=msg_codex_1776676979910
09:23:45  system/informational: "Cache miss: likely server-side (prompt unchanged, <5min gap)
          (cached tokens: 127,744 → 0)"  ← this is Drop 2, misdiagnosed
```

Note the detection misdiagnosed it as "prompt unchanged" — the system hash (system prompt + tools) was indeed unchanged, but the *message array* changed due to skill injection. This mismatch is now logged correctly as `server truncated context window after /review-impl`.

---

## Session file location

Full session JSONL:
```
/Users/pt/.cat-code/projects/-Users-pt-cat-code/6e18e0aa-7349-45ff-8983-55b136d03370.jsonl
```

147 lines total. The relevant lines are 122–133.

To re-examine the token arithmetic:
```python
python3 << 'EOF'
import json
path = '/Users/pt/.cat-code/projects/-Users-pt-cat-code/6e18e0aa-7349-45ff-8983-55b136d03370.jsonl'
with open(path) as f:
    lines = f.readlines()
for i, line in enumerate(lines):
    obj = json.loads(line)
    if obj.get('type') == 'assistant':
        msg = obj.get('message', {})
        usage = msg.get('usage', {})
        inp = usage.get('input_tokens', 0)
        cr = usage.get('cache_read_input_tokens', 0)
        cc = usage.get('cache_creation_input_tokens', 0)
        out = usage.get('output_tokens', 0)
        if inp + cr + cc + out > 0:
            total = inp + cr + cc
            print(f'L{i+1:3d} total={total:7d} cached={cr:7d} uncached={inp:7d} model={msg.get("model","?")}')
EOF
```

---

## What we know (confirmed)

1. **The context shrank.** Total input tokens went from 130,415 → 125,215 across a turn where content was added. This is not measurement noise — it's a net removal of ~6,822 tokens by the server.

2. **The skill injection is temporally correlated.** `/review-impl` fired 25 seconds before the miss, added ~1,622 tokens, and is the only content change between the two turns.

3. **The math fits a ~131,072 threshold.** 130,415 + 1,622 = 132,037, which is 965 tokens over 131,072 (2^17). The server pruned enough to bring it back to 125,215.

4. **The cache detection misdiagnosed it.** It classified as "prompt unchanged, likely server-side" because it only hashes system prompt + tools, not the message array. Now fixed — see Detection Status below.

## What we don't know (unconfirmed)

1. **The exact Codex eviction threshold.** 131,072 is inferred from the power-of-2 coincidence. It could be a different boundary, or the server could use a different mechanism entirely. The real Codex codebase (OpenAI-side) is not accessible.

2. **Whether pruning caused the cache miss.** It's possible the server truncates AND resets its cache as separate operations, or that something else triggered the miss and the truncation is a consequence.

3. **Whether this is repeatable.** One data point. Could be a one-off server routing event that coincided with the skill injection. Need more sessions near the context limit to confirm.

4. **Whether 131,072 is the right model to use.** The `getContextWindowForModel()` function in `src/utils/context.ts` returns 272,000 for gpt-* models. The 131,072 boundary is a *prefix cache* eviction threshold, not the context window limit — these are different things.

---

## Three other drops in the same session (for reference)

This session had 3 total cache drop events:

| Drop | Turn | Before → After | Gap | Cause | Status |
|------|------|----------------|-----|-------|--------|
| 1 | 49 | 44,800 → 13,824 | 99s | TTL eviction (99s user think time) | Expected, no fix needed |
| **2** | **131** | **127,744 → 0** | **25s** | **Context truncation after /review-impl** | **This document** |
| 3 | 140 | 125,824 → 0 | 4s | Subagent WS session collision | **Fixed** — `${sessionId}/${agentId}` conversationId |

Drop 3 was a confirmed bug (shared `CODEX_SESSION_ID` singleton between main session and subagents). It was fixed in this session. Drop 2 remains open.

---

## Detection status (already shipped)

`src/services/api/promptCacheBreakDetection.ts` now:

- Tracks `prevTotalInputTokens` (input + cache_read + cache_creation) per turn
- Fires `contextTruncated = true` when total input shrinks by >2,000 tokens with no client-side changes
- Extracts `triggeringCommand` from the last user message's `<command-name>` tag
- Logs: `Cache miss: server truncated context window after /review-impl (total input: 130,415 → 125,215 tokens)`
- Emits `tengu_prompt_cache_break` analytics with fields: `contextTruncated`, `triggeringCommand`, `totalInputTokens`, `prevTotalInputTokens`

Once more sessions are observed, query BQ for `contextTruncated=true` grouped by `triggeringCommand` to see if skill injections are the consistent trigger.

---

## Potential fix (not implemented)

**Where:** `src/utils/processSlashCommand.tsx` (or wherever `getMessagesForSlashCommand` is called)

**What:** Before injecting skill content as a user message, estimate `currentContextTokens + skillTokens`. If it exceeds `getContextWindowForModel(model) - SAFETY_BUFFER`, either:
- Warn the user ("context near limit, consider /compact before running this skill")
- Auto-trigger compaction first
- Refuse injection with an explanation

**Why it's not trivial:**
- `getMessagesForSlashCommand()` doesn't currently receive the `messages` array — it would need to be threaded in
- Token estimation is approximate (no exact count without a server round-trip)
- The threshold is unknown (131,072 is guessed, not confirmed)
- Auto-compaction before skill injection adds latency and complexity

**Relevant files to read first:**
- `src/utils/processSlashCommand.tsx` — where skill content is injected into the message array
- `src/utils/handlePromptSubmit.ts` — calls `onQuery()` after skill injection; no token check here
- `src/utils/context.ts` — `getContextWindowForModel()` returns 272k for gpt-*, not the prefix cache limit
- `src/services/api/codex-fetch-adapter.ts` — `translateToCodexBody()` sends full message array, no client-side trimming

**Decision gate:** Don't implement until we have ≥3 confirmed instances of `contextTruncated=true` with `triggeringCommand` set in BQ. One data point is not enough to justify the complexity.

---

## Files changed in this investigation session

| File | Change |
|------|--------|
| `src/services/api/codex-fetch-adapter.ts` | `createCodexFetch` accepts `conversationIdOverride` (Drop 3 fix) |
| `src/services/api/client.ts` | `getAnthropicClient` threads `codexConversationIdOverride` to both Codex paths |
| `src/services/api/claude.ts` | Subagents pass `${sessionId}/${agentId}` as conversationId override; `inputTokens` passed to cache break detection |
| `src/services/api/promptCacheBreakDetection.ts` | `prevTotalInputTokens` tracking; `contextTruncated` + `subagentWsCollision` detection; `triggeringCommand` extraction and logging |
