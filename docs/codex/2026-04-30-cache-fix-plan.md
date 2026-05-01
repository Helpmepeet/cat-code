# Codex Prompt Cache Fix — Implementation Plan

## Problem

Sessions burn through usage caps at ~6M tokens/hour because prompt caching on the ChatGPT Codex endpoint achieves only ~13% hit rate. Evidence from session `14e2ff6f-465e-463c-94f5-d3b97f0b07cd`: 14.2M input tokens over 2 hours, 3 accounts capped in ~1 hour once rotation started.

Root causes (three independent bugs):

1. **`prompt_cache_key` is process-ephemeral.** `src/services/api/codex-fetch-adapter.ts:30` generates a fresh `randomUUID()` every CLI launch. Upstream `openai/codex` keys by the stable `conversation_id`. Every CLI restart = cold server cache.
2. **Cache routing headers reset on account rotation.** `resetCodexCacheContext()` clears `codexConversationIdByCacheKey` on every account switch. In the 2-hour session there were 4 rotations; each one wiped routing and forced the next turn to pay full price.
3. **Volatile content lives inside the cached prefix.** `instructions` (sent to the Responses API as the system prompt) includes `gitStatus` and `currentDate`. Both are computed at session start and prepended to the prefix. Any change invalidates the entire instruction cache.

The account-capping itself is a downstream symptom: one account caps → rotate → cache wiped → next account pays full price on 150k tokens → caps faster → rotate again. Death spiral.

## Goals

- Lift steady-state cache hit rate to at least 60% on long sessions (upstream target is 20:1 cached:uncached; we should aim for similar on the happy path).
- Eliminate the three known cache-destroying behaviors without regressing account failover correctness.
- Keep changes minimal and reversible. No new abstractions.

## Non-goals

- Implementing `previous_response_id` chaining. Upstream doesn't use it either; the server already handles prefix caching when the key is stable. Revisit only if items below are insufficient.
- Rewriting the instruction assembly pipeline. We change *what* goes where, not *how* it's assembled.
- Fixing the ChatGPT-backend degradation tracked in [openai/codex#5556](https://github.com/openai/codex/issues/5556). That's upstream; we can only minimize our contribution.

## Scope of changes

All changes land in three files:

- `src/services/api/codex-fetch-adapter.ts` — cache key + routing lifetime
- `src/services/api/instructionAssembly.ts` — keep instructions stable
- `src/context.ts` — move volatile fields out of `systemContext`

## Phase 1 — stabilize `prompt_cache_key` across CLI restarts

**File:** `src/services/api/codex-fetch-adapter.ts`

**Current state** (L30, L361):
```ts
const CODEX_SESSION_ID = randomUUID()
// ...
prompt_cache_key: CODEX_SESSION_ID,
```

**Change:** derive `prompt_cache_key` from the Cat Code session UUID (`sessionId` already persisted in `~/.cat-code/projects/*/<sessionId>.jsonl`), not a fresh UUID per process.

**Implementation:**

1. Thread the Cat Code `sessionId` into the adapter. It's already on the query context (see `src/utils/sessionStorage.ts` / `src/QueryEngine.ts`). Add a module-level setter:
   ```ts
   let codexPromptCacheKey: string | null = null
   export function setCodexPromptCacheKey(sessionId: string): void {
     codexPromptCacheKey = sessionId
   }
   ```
2. Call the setter once at session bootstrap (cli.tsx) and on resume (`src/utils/sessionRestore.ts`). On resume, the **same** sessionId must be reused — do not allocate a new one.
3. In `translateToCodexBody`, use `codexPromptCacheKey ?? CODEX_SESSION_ID` as the fallback. Keep the random fallback for edge cases (tests, non-session entry paths).
4. Also update the `session-id` header (L1133) to use the same stable value.

**Verification:**
- Start session, do two turns, quit, restart with `--resume <sessionId>`, do one more turn. Confirm third turn's `cache_read_input_tokens > 0`.
- Log `prompt_cache_key` at DEBUG level once per request so we can confirm stability in future session logs.

## Phase 2 — don't nuke conversation routing on account rotation

**File:** `src/services/api/codex-fetch-adapter.ts`

**Current state** (L44, L1113–1119): `resetCodexCacheContext()` clears the conversation-id map on rotation. `getCodexCacheContextKey` keys by `${accountId}:${model}`, so a new account always gets a fresh conversation-id.

**The tradeoff:** the original rationale was "different accounts have different cache state, don't mix them." That's correct — each OpenAI account has its own cache. But clearing the entire map on every rotation means even returning to a previously-used account gets a *new* conversation-id, defeating the per-account cache.

**Change:** keep the `(accountId, model)` → `conversationId` map **persistent across rotations**. Don't clear it; just pick the right entry for the currently-active account.

**Implementation:**

1. Remove the `resetCodexCacheContext()` call sites (search for call sites; likely in `codexAccountPool.ts` on account switch). The map is already keyed per-account, so stale entries for other accounts cause no harm.
2. Persist the map to disk (`~/.cat-code/codex-cache-routing.json`) keyed by `${accountId}:${model}`, loaded on module init. This survives CLI restarts — important because restart-stable `prompt_cache_key` (Phase 1) only helps if `conversation-id` is also stable.
3. Add a bounded LRU (max 32 entries) to cap disk growth. No TTL — the server decides when a cache prefix expires; we don't need to guess.

**Verification:**
- Force a 429 failover mid-session. Confirm that after rotation the pre-rotation account's conversation-id is still in the map, and that when the pool cycles back to it, the same conversation-id is reused.
- Confirm the `cache_read_input_tokens` trace no longer shows a full-miss streak after rotation.

## Phase 3 — move volatile fields out of `instructions`

**Files:** `src/context.ts`, `src/services/api/instructionAssembly.ts`

**Current state:** `buildOpenAIInstructions` (instructionAssembly.ts:53) does `appendSystemContext(systemPrompt, systemContext).join('\n\n')`. `systemContext` contains `gitStatus` (context.ts:142) — recent commits, branch, working tree status — and on Anthropic paths also `currentDate`. These become part of the cached prefix. Any change (new commit, next day) invalidates the whole instruction cache.

For the Codex path specifically, `currentDate` lives in `userContext` (context.ts:186), which becomes the first user message (instructionAssembly.ts:72–82). That's *not* in `instructions`, but it's still at position 0 of `input` — also cache-prefix territory.

**Change:** keep `instructions` stable; push volatile content to the **tail** of the message array where cache misses are cheap.

**Implementation:**

1. Split `systemContext` into two buckets inside `getSystemContext`:
   - `stableSystemContext`: CLAUDE.md, tool policies, anything that doesn't change mid-session.
   - `volatileSystemContext`: `gitStatus`, `cacheBreaker`, anything computed per-session from external state.
2. `buildOpenAIInstructions` uses only `stableSystemContext`. Volatile context becomes a user message appended *after* the conversation history, not prepended. Rationale: the Responses API caches prefixes; appending to the end doesn't invalidate earlier cached segments.
3. Move `currentDate` out of `userContext` entirely for the Codex path. Inject it into the same tail user message as `gitStatus`. It changes once per day and only needs to be present — it doesn't need to be at the top.
4. For Anthropic path, no change (Anthropic handles prefix caching via explicit `cache_control` breakpoints which we already set elsewhere; out of scope here).

**Verification:**
- Diff the `instructions` string across two turns where only `gitStatus` changed. Should be byte-identical.
- Confirm the model still *sees* gitStatus and currentDate when it needs them (spot-check with a turn that asks about current date / uncommitted files).

## Phase 4 — observability

Before and after each of the above phases, we need numbers. Without these we can't tell if a phase actually helped or if the server-side weather just changed.

**Implementation:**

1. In the `response.completed` handler (`codex-fetch-adapter.ts:836`), emit a structured log entry per request:
   ```
   codex.cache_stats { accountId, model, input_tokens, cached_tokens,
                       hit_ratio, prompt_cache_key_prefix, conversation_id_prefix }
   ```
2. Add a `/cache-stats` slash command (simple: read the in-memory rolling window, print hit ratio + median cached tokens over last 20 turns). Lets the user verify in real time.
3. Log `prompt_cache_key` and `conversation-id` (first 8 chars) at request time so session JSONLs become self-describing for future investigations.

## Risks & mitigations

- **Persisting cache-routing to disk could leak account IDs into a shared file.** Mitigation: the file is under `~/.cat-code/` which is already user-scoped and already contains OAuth tokens. No new exposure.
- **A stable `prompt_cache_key` across CLI restarts could make the server return stale cached content if our prefix semantically changed.** Not actually possible — the server verifies by prefix hash. If bytes differ, no hit. The key just tells the router where to look.
- **Removing `resetCodexCacheContext` means a misconfigured account could keep routing to a dead backend node.** Mitigation: the adapter already falls back gracefully on 401/429; failover logic in `withRetry.ts` is unchanged.
- **Instruction split could break agents that rely on seeing gitStatus at the top of the prompt.** Mitigation: check agent prompts that explicitly reference "git status above" — grep for it before shipping. If any exist, keep those agents on the old path.

## Order of operations

Do phases in order, measure between each. Each phase is independently valuable.

1. Phase 4 (observability) — land first so we can measure everything after.
2. Phase 1 (stable `prompt_cache_key`) — biggest single win; restart cost disappears.
3. Phase 2 (persistent routing map) — recovers cache across failover.
4. Phase 3 (split instructions) — the long tail; diminishing returns but cheap.

## Success criteria

- On a fresh session of 50+ turns with no failover: **> 70% of turns have `cache_read_input_tokens > 50k`**.
- After a forced failover mid-session: **first post-failover turn has `cache_read_input_tokens > 0`** on accounts previously seen this session.
- Session restart (resume): **first turn after resume has `cache_read_input_tokens > 0`**.
- No regression in account-failover latency (measured: median time from 429 to next successful response).

## Out of scope — parked ideas

- `previous_response_id` chaining. Worth revisiting if the above gets us to only 40–50% hit rate instead of 70%+.
- Client-side prefix deduplication (sending only message deltas). Would require server cooperation we don't control.
- Pre-warming caches across accounts. Not worth it — the server prefix cache isn't shareable between accounts by design.
