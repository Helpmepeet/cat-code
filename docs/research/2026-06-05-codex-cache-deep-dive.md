# Codex prompt-cache deep dive (2026-06-05)

Follow-up to the Apr-11 cache investigation (8.3% hit rate, usage burning
fast). The earlier notes flagged seven open questions that needed code reading.
Since then the routing path was rebuilt (the "Phase 1" cache work), so several
of those questions are now obsolete. This pass verifies the **current** code on
`phase1` and records what actually governs cache hits today, plus the live
gaps that can still cost cache reads.

Scope: `src/services/api/codex-fetch-adapter.ts`,
`codexAccountLeaseManager.ts`, `withRetry.ts`, `src/setup.ts`.

## How caching is wired today (current code, not the Apr-11 model)

OpenAI's ChatGPT backend does implicit server-side prefix caching. A request
gets cache reads only if it lands on the same backend node **and** presents a
stable identity. Cat Code controls that identity through one value, the
`conversationId`, which is stamped into all of: `prompt_cache_key` (body),
and the `conversation-id` / `session_id` / `x-client-request-id` headers
(`codex-fetch-adapter.ts:2760`, `:2789`, `:2805–2807`).

The `conversationId` is resolved per request by `getConversationIdForRequest()`
(`codex-fetch-adapter.ts:119–140`):

- Key it caches under is `` `${accountId}:${model}` `` (`:128`).
- **First** key ever seen in the process (map size 0) gets the *stable*
  `codexPromptCacheKey` (`:134–136`).
- **Every subsequent** key gets a fresh `randomUUID()` (`:137`).

`codexPromptCacheKey` is the Cat Code session UUID, pinned at boot and
re-pinned on `--resume` session switch (`setup.ts:90`, `:95–97`). This is the
fix for the Apr-11 "#1 process restart busts the key" problem: restarts and
resumes now reuse the same key. **That question is resolved.**

`store: false` is still sent (`codex-fetch-adapter.ts:887`). Upstream
openai/codex sends the same; it disables OpenAI *conversation storage*, not
prefix caching. The non-zero `cached_tokens` we observe in WARM turns proves
caching works with `store:false`. **Question #5 resolved — not a cache buster.**

`cache_creation_input_tokens` is still emitted as a hard `0`
(`:2461`, `:2483`) because OpenAI never reports write tokens. The Apr-11
worry that "creation=0 means cache never written" was a misread: creation is
*always* 0 by construction; the real signal is `cache_read_input_tokens`
(= `cached_tokens`). **Question #4 resolved.**

## Live gaps that still cost cache reads

### G1 — Every model switch mints a brand-new conversation_id (one COLD turn each)

Because the map key includes `model`, the first request on a *second* model
(e.g. switching the main thread between a reasoning and a non-reasoning Codex
model, or a side query like title generation on a different model) is treated
as "not the first key" → gets a `randomUUID()`, not the stable session key.
That UUID has never been seen by any backend node, so its first turn is
guaranteed COLD. Subsequent turns on that model reuse the minted UUID, so it
warms up — the cost is one cold turn per (account,model) combo per process.

Impact: low-to-moderate. It bites sessions that bounce between models or run
side queries on a different model. Not the dominant cost.

### G2 — Account failover inside a turn lands COLD on the new account (the big one for multi-account users)

On a 429, `withRetry` calls `failoverCodexLease()` and retries immediately on a
different account (`withRetry.ts:497–521`). The next request re-derives
`currentAccountId` from the new lease (`codex-fetch-adapter.ts:2738–2742`), so
the cacheKey becomes `` `${newAccount}:${model}` ``. That key has no entry →
`getConversationIdForRequest` mints a fresh `randomUUID()` (map size is already
> 0). So:

1. The new account starts a **new** conversation_id → guaranteed COLD first
   turn on that account.
2. Worse, the prefix that *was* warming on account A is abandoned. If the pool
   rotates A→B→A within a session, account A's original conversation_id is
   still in the map (keyed `A:model`) and is reused — good — but B's is a fresh
   UUID, and any future C is fresh again.

For a heavy multi-account user who hits caps and rotates often, **every
rotation pays a full cold turn on a large context**. With 20–27M-token
sessions (Apr-11 data), one cold turn is ~hundreds of K to millions of input
tokens billed uncached. This is the single most plausible explanation for the
8.3% aggregate: the big sessions were almost certainly rotating accounts.

Mitigation options (not yet implemented — needs a design decision):
- Carry the *same* conversation_id across the failover instead of keying by
  account. OpenAI's prefix cache is per-node, and a different account routes to
  a different node anyway, so reusing the id won't produce a hit on turn 1 —
  but it keeps the id **stable** so account A's prefix survives a temporary
  hop to B and back. Today A's id already survives (keyed `A:model`), so the
  marginal win is mainly for B onward.
- The structurally correct fix is to make the routing identity
  `(account, session)` derived deterministically from the stable session key
  (e.g. `${codexPromptCacheKey}:${accountId}`) instead of a random UUID. Then
  re-visiting any account in the same session reuses that account's id, AND the
  id is stable across process restarts for that account too. This turns "one
  cold turn per account per process" into "one cold turn per account, ever
  (until the node's cache TTL expires)". Low risk, high upside for multi-acct.

### G3 — Large/growing context caps the achievable hit rate regardless

The 31MB-transcript session (Apr-11, 8.8%) is partly structural: each turn
appends new messages, so the cacheable *prefix* grows but the *new* suffix
(the just-appended user/assistant/tool content) is never cached on the turn it
first appears. With very long sessions the per-turn new content is large
relative to context, capping the steady-state ratio well below the ~90% a
short session sees. This is inherent to prefix caching and not a bug.
Compaction / context trimming is the only lever, and that's a separate concern.

## Question-by-question disposition (vs Apr-11 list)

1. Lease ↔ cache-key interaction — **answered**: cacheKey is `accountId:model`,
   derived from the lease's account. Concurrent subagents on different accounts
   get different ids (correct, no collision). Same account+model share an id
   (correct, they *should* share a node).
2. `getCodexCacheContextKey()` ownerId sharing — **obsolete**: that function is
   gone. Routing is now account+model, not ownerId.
3. `withRetry` mid-turn failover — **answered, and it's G2**: yes, failover
   happens within a user turn and yes it produces a cold first turn on the new
   account.
4. Why `cache_creation = 0` — **answered**: always 0 by construction.
5. `store: false` — **answered**: not a cache buster.
6. Session size vs effectiveness — **answered, G3**: structural prefix-growth
   limit, not a bug.
7. `CODEX_SESSION_ID` vs `conversation-id` scope — **obsolete**: session_id and
   conversation-id are now the *same* value per request, no longer split.

## Bottom line

The two fixes that landed since Apr-11 (stable `prompt_cache_key` across
restart/resume) closed the biggest known leak. The remaining recoverable loss
is **G2: account failover mints a fresh, cold conversation_id**. For a
multi-account user who rotates on caps, that is very likely the dominant
remaining cost. The recommended next step is to make the routing id
deterministic from `(session key, account)` so re-visited accounts reuse a
stable id (see G2 mitigation #2). G1 is a minor variant of the same fix. G3 is
structural and out of scope for cache-routing changes.

No code was changed in this pass — analysis only.
