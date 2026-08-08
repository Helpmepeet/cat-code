# S05 adversarial validation: Codex transport, status, provider routing

> **Verification provenance:** `claude-opus-5`, high effort, single subagent session.
> Source review plus **three standalone scratch repro scripts** that import the real
> repo modules and drive them against isolated fake HOMEs and the transport's own
> `_setWebSocketFactoryForTest` seam
> (`scratchpad/{h1-repro,h1-contradiction,h2-repro,good-claims}.ts`).
> **One focused test file was run**: `bun test src/services/api/codexStatus.test.ts`
> (12 pass / 0 fail). No repo file was edited except this report. No GUI, no
> `bun run --cwd app dev`, no full suite. The operator's real `~/codex-vault` was
> read once by accident on a first repro attempt (Bun snapshots `os.homedir()` at
> launch, so an in-script `process.env.HOME` assignment is too late); that run was
> read-only and produced no writes, and every subsequent run used
> `HOME=<scratchpad> bun run …`. Branch `migration` at `a1012b1`.

## Overall verdict

The S05 report is **substantially right**. Eleven of thirteen findings stand as
written, one narrows, one is half wrong. Both HIGHs are real and I reproduced both
against live repo modules rather than reasoning about them: `buildCodexStatus`
really does wipe the live pool and really does invert its own verdict
(`wait`/`schedule` becomes `delegate`/`run_now` in the same process, same second),
and abandoning the priming iterator really does deadlock the per-conversation
WebSocket turn queue.

The single most important correction is **provenance, and it cuts the opposite way
from the rest of this review**. Verification so far has found the large majority of
`src/` findings pre-existing on `main`; here, **HIGH#1 is branch-new**.
`src/services/api/codexStatus.ts`, `src/services/deferredContinuation.ts`,
`src/services/deferredContinuationRunner.ts`,
`src/commands/continue-after-limit/continue-after-limit.tsx` and
`loadPoolForObservation` itself do not exist on `main` at all: they arrived in
`44f45b1`. HIGH#2 by contrast is pre-existing, and `main` is **worse** than the
branch (`main`'s `acquireConversationTurn` takes no `AbortSignal`, so on `main` the
deadlock has no escape hatch at all; the branch added the one that bounds it).

What most deserves action: **HIGH#1**, because it is branch-new, it is on a live
REPL path that fires with no user action, it lies to the user in the direction that
costs quota, and the production default (`loadPool: true`) has **zero test
coverage** - all 12 tests in `codexStatus.test.ts` pass `loadPool: false`.

The report's clean bill on provider routing holds, with one correction: it is not
"now fixed" by this branch. `main:src/services/api/client.ts:356-357` already
resolves once via `resolveRequestProvider` and already emits
`model.provider_mismatch`. The branch changed nothing there.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| F1 | HIGH | `buildCodexStatus` wipes the live pool and inverts its verdict | **CONFIRMED** | Repro: same process, `wait`→`delegate`, `schedule`→`run_now`, cap state gone. **Branch-new.** |
| F2 | HIGH | `primeCodexEvents` abandons iterator, deadlocks WS turn queue | **CONFIRMED** | Repro against real transport: turn 2 never settles; `iterator.return()` fixes it. Pre-existing; `main` is worse |
| F3 | MED | Same abandonment on HTTP path leaks reader/listener/90 s timer | **CONFIRMED** | `httpSseToEvents` `finally` at `:1601-1604` cannot run on an abandoned generator; `IDLE_TIMEOUT_MS` is 90 000 |
| F4 | MED | `sessions` never evicted for finished subagents | **CONFIRMED** | Only non-adapter caller of `clearWebSocketSession` is `sessionTitle.ts:170`; clean completion leaves the socket open |
| F5 | MED | `prompt_cache_key` becomes a random UUID for non-first (account, model) | **CONFIRMED** | `:199-201` verbatim; `resetCodexCacheContext` is wired only to `/switch-account` and `/delete-account` |
| F6 | MED | `CodexResponseFailedError` not unwrapped by `withRetry` | **PARTIALLY CONFIRMED** | Mechanism exact; but on the WS path attempts 0-1 **hang** (F2) rather than re-spend tokens |
| F7 | LOW | SSE parser drops spec-legal frames; "second, more correct parser" exists | **PARTIALLY CONFIRMED** | Drops proven by repro; the "more correct parser" claim is **wrong** - same space requirement, different wire format |
| F8 | LOW | `processCodexEvents` is a 765-line god function | **CONFIRMED** | `:1612-2377` = 766 lines; `createCodexFetch` closure `:3230-3633` |
| F9 | LOW | `translateCodexStreamToAnthropic` exported only for tests | **CONFIRMED** | `git grep` shows one definition, zero production callers, 10 test call sites |
| F10 | LOW | Cap/auth code lists duplicated with no drift test | **CONFIRMED** | No test asserts set equality; the auth half is branch-new |
| F11 | LOW | Em dash in `/accounts` output | **CONFIRMED** | `codexUsage.ts:489` exact; pre-existing on `main:382`, present in the diff only as context |
| F12 | LOW | Cheap secondary calls can upgrade to Terra under custom small-fast model | **CONFIRMED** | `mapClaudeModelToCodex` falls through to `DEFAULT_CODEX_MODEL`; three cited sites verified |
| F13 | LOW | Dead `body.cancel()` on a locked stream | **CONFIRMED** | Runtime proof: `REJECTED TypeError` |

## Per finding

### F1 — [HIGH] `buildCodexStatus` blast radius: the pool wipe runs on the live REPL path and inverts the verdict it reports

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `src/services/api/codexStatus.ts:414-419` is
  `const loadPool = options.loadPool !== false` then
  `if (loadPool) { await loadPoolForObservation() }`.
  `loadPoolForObservation` (`src/services/api/codexAccountPool.ts:183-207`)
  assigns `pool.accounts = mergePoolAccounts(vaultAccounts, configAccount)` at
  `:188` on the module singleton declared at `:96`, and recomputes
  `pool.activeIndex` at `:191-198`. `mergePoolAccounts` (`:1040-1063`) builds a
  Map from the freshly-parsed vault objects and merges nothing from memory.
  `loadVaultAccounts` (`:998-1013`) emits `lastUsedAt: 0` and a `status` derived
  only from vault refresh state. Every field the report lists is destroyed.
- **Reachable in production?**: Yes, on two live-REPL paths. Full caller
  enumeration (`git grep`, not `rg` - see the missed-findings section for why
  `rg` cannot see `src/cli/`):

  | Caller | Process | Hot? | What it destroys |
  |---|---|---|---|
  | `src/cli/handlers/codexStatus.ts:17` (`cat-code codex status`, registered `src/main.tsx:4329-4336`) | one-shot, `process.exit` immediately after | no | nothing that outlives the call, **but** `init()` runs as a commander `preAction` (`src/main.tsx:969`) and fires `void initAccountPool()` (`src/entrypoints/init.ts:90`), so this races the startup usage poll and can discard hints that had already landed |
  | `src/services/deferredContinuation.ts:1169` (`evaluateDeferredContinuationEligibility`), reached from `src/commands/continue-after-limit/continue-after-limit.tsx:376` | **live REPL** | user-invoked `/continue-after-limit` | full wipe: `status`, `statusReason`, `cappedAt`, `usagePrimary/Weekly/Allowed/LimitReached/FetchedAt/ResetAt`, `redeemedAt`, `lastError`, `lastErrorAt`, LRU `lastUsedAt`, and `activeIndex` |
  | `src/services/deferredContinuationRunner.ts:578` (`applyAttemptResult`, `quota_exhausted` arm) | **live REPL, automatic** | yes | same wipe. Reached from `beginForegroundDeferredContinuation:686` and `reconcileDeferredContinuationJob:730`, both called by `src/hooks/useDeferredContinuation.ts:98,131`, mounted unconditionally at `src/screens/REPL.tsx:4713`. **No user action required.** Also reachable in the one-shot `deferred-continuation-worker` (`src/main.tsx:618`), harmless there |
  | `app/sidecar/accountsDomain.ts:587` (`reloadPool`, calls `loadPoolForObservation` directly, not `buildCodexStatus`) | live sidecar session | only on a resolve-miss before an account-targeting write | same wipe. The comment at `:604-605` claiming "the in-memory usage hints the pool accumulated are not thrown away on every verb" is true for the hit path and false for the miss path |
  | `app/sidecar/accountsPoolWorker.ts:104` | disposable per-run worker | no | nothing |

  The report attributed the second row's call directly to
  `continue-after-limit.tsx:376`; the direct call is `deferredContinuation.ts:1169`
  and `continue-after-limit.tsx:376` is the transitive caller. Immaterial.
- **Trigger**: constructed and executed. Isolated fake HOME with a two-account
  vault (both `refresh: {state:'idle'}`, recent `last_refresh`), pool loaded,
  `touchPoolAccountUsage` then `markPoolAccountCapped` on both (exactly what
  `withRetry` does on a hard 429), then the real
  `evaluateDeferredContinuationEligibility` with the real default
  `buildCodexStatus({refresh:'auto'})`.
- **Counter-arguments considered**: I looked hard for something that re-derives cap
  state after the load, since that is the only thing that could save the verdict.
  (a) `buildCodexStatus` **does** fetch usage after the reload (`:427`), but with
  `updateRoutingHints: false`, and `updateRoutingHintsFromUsage` is the only writer
  of those hints (`codexUsage.ts:299-301`) - so the fetched truth is used for
  `buildProfileUsage` display and never for `classifyProfile`, which reads the wiped
  account only. Proven: the same status object reports
  `routing_state=candidate` next to `usage.allowed=false limit_reached=true
  freshness=live`. (b) `getCodexAccountAvailability` (`codexAccountPool.ts:1544-1572`)
  has a `hasFreshPoolAccountUsageHint` arm at `:1560-1568` that could have blocked a
  healthy-looking account - it cannot fire, because the hint fields were wiped too.
  (c) Is anything reloading the hints later? Only `fetchPoolUsage({updateRoutingHints:
  true})`, whose production call sites are `initAccountPool:233` (startup, once),
  `/accounts` (`src/commands/accounts/accounts.ts:35`), the accounts panel
  (`AccountsPanel.tsx:327`), the usage settings screen (`Usage.tsx:361`), and the
  sidecar worker. All operator-initiated or startup - nothing on the request path.
  (d) Does a `runtime_cap` recover that way at all? No: `runtime_cap` and `cappedAt`
  are hard-429 beliefs with no usage-poll equivalent, so they are simply gone.
  (e) Could `pool.initialized` already be false so the load is legitimate? In the
  REPL it is true by then (`init.ts:90`). Nothing rescues the claim.
- **True consequence**: Exactly as claimed, and the eligibility inversion is the
  concrete harm: a user whose entire Codex pool just 429'd is told
  "A usable Codex account is available, so continuation will start now"
  (`continue-after-limit.tsx:409-413`) and a job is created with
  `scheduleReason: 'account_available'` and `notBefore: now`, which burns a fresh
  429 on every profile. Secondarily, the process's own routing state is destroyed:
  `canFailover()` flips false→true, `activeIndex` jumps back to the account the
  process had already failed away from, and every `lastUsedAt` resets to 0 so the
  LRU ranking in `findLRUHealthy` is flat.
- **Evidence**: `scratchpad/h1-repro.ts`, run as
  `HOME=<scratchpad>/h1-home NODE_ENV=test bun run h1-repro.ts`:

  ```
  after both capped : activeIndex=-1 [backup capped cappedAt=set allowed=false] [main capped cappedAt=set allowed=false]
  canFailover (pre)  : false
  CONTROL (loadPool:false) decision: {"action":"wait","reason_code":"quota_blocked_reset_known",…}
  CONTROL pool counts     : {"profiles_total":2,"candidate":0,"quota_blocked":2,…}
  REAL    (default)   decision: {"action":"delegate","reason_code":"candidate_available",…}
  REAL    pool counts     : {"profiles_total":2,"candidate":2,"quota_blocked":0,…}
  after REAL        : activeIndex=0 [backup healthy cappedAt=- allowed=undefined lastUsed=0] [main healthy cappedAt=- …]
  canFailover (post) : true
  ELIGIBILITY (via real buildCodexStatus): {"action":"run_now",…}
  ELIGIBILITY (loadPool:false)          : {"action":"schedule","resetAt":…,"notBefore":…}
  ```

  `scratchpad/h1-contradiction.ts` (usage stub returning the shape a genuinely
  capped account produces):

  ```
  decision  : {"action":"delegate","reason_code":"candidate_available",…}
  profile   : routing_state=candidate block_code=null usage.allowed=false usage.limit_reached=true freshness=live
  ```

  Coverage: `bun test src/services/api/codexStatus.test.ts` → 12 pass / 0 fail, and
  **every one of the 12 passes `loadPool: false`** (`:130 :159 :181 :204 :229 :296
  :309 :420` inline, `:89 :257 :350 :383` in multi-line options). The production
  default is untested.

  Provenance: `git cat-file -e main:<path>` fails for `codexStatus.ts`,
  `deferredContinuation.ts`, `deferredContinuationRunner.ts`,
  `cli/handlers/codexStatus.ts` and `continue-after-limit.tsx`;
  `git show main:src/services/api/codexAccountPool.ts | grep loadPoolForObservation`
  is empty. All introduced by `44f45b1` on this branch. **BRANCH-NEW - this one
  does block.**
- **Disposition**: Apply the report's second sentence, not its first. Pass
  `loadPool: false` explicitly at `deferredContinuation.ts:1169` and
  `deferredContinuationRunner.ts:578`. Do **not** implement the report's preferred
  `pool.initialized` gate: `init()` fires `void initAccountPool()`
  fire-and-forget (`src/entrypoints/init.ts:90`), so `pool.initialized` is
  racy at exactly the moment the `codex status` one-shot reads it, and gating on it
  would make the CLI's behaviour non-deterministic between "reads a cold pool" and
  "reads whatever the async init happened to finish". Two additions the report did
  not ask for and I would insist on: (1) a test that exercises the **default**
  (`loadPool` omitted) and asserts the pre-existing pool survives - the defect is
  invisible today precisely because no test uses the production default;
  (2) `app/sidecar/accountsDomain.ts:604-605`'s comment is now false on the miss
  path and should say so, or the miss path should merge rather than replace.
  A merging `loadPoolForObservation` would be the real fix, but it is a larger
  change than this branch should carry.

### F2 — [HIGH] `primeCodexEvents` abandons its iterator on `response.failed`, permanently deadlocking the WebSocket turn queue for that conversation

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes, line for line.
  `codex-fetch-adapter.ts:3102-3108` throws `responseFailedErrorForInitialEvent(...)`
  from inside the priming loop; the `catch` at `:3123-3127` calls
  `iterator.return?.()` **only** when `error === timeoutError`; the `finally` at
  `:3128-3130` clears the timeout and nothing else. The queue is
  `codex-websocket-transport.ts:149-213`, `queue.tail = priorTail.finally(() => gate)`
  at `:167`, released only from `streamTurnViaWebSocketLocked`'s
  `finally { releaseTurn() }` at `:548-550`. `_streamTurnAttempt` yields
  `response.failed` through the generic `yield event` at `:1356` and only sets
  `reachedTerminalDisposition` when resumed (`:1427-1432`), so an abandoned
  consumer leaves it suspended at the yield and its own `finally` (`:1438-1443`)
  never runs either.
- **Reachable in production?**: Yes, unconditionally. No feature gate: WS is tried
  for every streaming Codex request (`:3441-3442`,
  `isStreamingAnthropicRequest = anthropicBody.stream === true` at `:3275`), gated
  only by the 60 s sticky HTTP flag. `_setWebSocketFactoryForTest` exists but the
  default factory is the real `ws` package (`codex-websocket-transport.ts:99-107`).
- **Trigger**: constructed and executed. Server answers the first turn on a
  conversationId with `response.failed` (non-cap, non-auth: e.g.
  `invalid_request_error` for a bad tool schema). Then any later turn on the same
  conversationId hangs.
- **Counter-arguments considered**: I went looking specifically for the guard that
  would make this a non-issue. (a) **Does the sticky HTTP fallback route later turns
  away from the poisoned queue?** No - and this is the load-bearing check.
  `normalizeInitialWebSocketError` returns early for `CodexResponseFailedError` at
  `:3157-3159`, **before** the `markStickyHttpFallback(conversationId, …)` call at
  `:3189`, and the outer catch rethrows it at `:3540-3546` without arming the flag.
  Every later turn therefore re-enters `streamTurnViaWebSocketLocked`.
  (b) **Does `clearWebSocketSession` / `closeSocketPreservingState` reset the queue?**
  No - neither touches `conversationTurnQueues` (`:215-227`, `:246-264`), and the
  queue entry is deleted only when `pending` hits 0 (`:209-211`), which requires the
  release that never happens. (c) **Does closing the socket resume the suspended
  generator?** No - a suspended async generator resumes only on `next`/`return`/
  `throw`; the `onClose` handler enqueues into a queue nobody drains.
  (d) **Does account failover dodge it?** Partially, and the report missed this:
  for a **cap/auth**-classified `response.failed`, `createCodexResponseFailedError`
  (`:511-538`) returns `CodexAccountCapError`/`CodexAccountAuthError`, `withRetry`
  fails over to another account, and `getConversationIdForRequest` is keyed by
  `${accountId}:${model}` (`:192`) - so the retry uses a **different**
  conversationId and does not hit the poisoned queue until the session routes back
  to that account. For a plain `CodexResponseFailedError` (the case described)
  there is no failover, so attempts 0 and 1 hit it immediately. (e) **Is the abort
  escape real?** Yes, and it bounds the damage: `acquireConversationTurn` races
  `priorTail` against the signal (`:176-201`), and I proved an abort releases the
  queued turn. The 600 s figure checks out: `client.ts:460`
  `timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10)`.
  The SDK does not multiply it - cat-code sets `maxRetries: 0` on the SDK client
  (`claude.ts:944`, `:1979`) - but cat-code's own `withRetry` does, so a full
  budget can be several consecutive 600 s hangs.
- **True consequence**: as claimed for the non-cap case, narrowed for the cap/auth
  case. On a non-cap `response.failed`, the turn queue for that conversationId is
  dead: every later WS turn blocks at `await priorTail` (`:185`) until its own
  abort - Esc, or the 600 s SDK timeout. Three `ws` listeners leak and the 90 s
  idle timer stays armed (`:1438-1443` skipped).
- **Evidence**: `scratchpad/h2-repro.ts`, driving the real transport through
  `_setWebSocketFactoryForTest`:

  ```
  turn1 first event: "response.failed"
  abandoned turn 1 without iterator.return(): CodexResponseFailedError (simulated primeCodexEvents throw)
  turn2 after 2s: STILL PENDING (deadlocked)
  CONTROL turn2 after 2s: resolved ["response.completed"]          ← same sequence WITH iterator.return()
  queued-with-signal before abort: pending
  queued-with-signal after abort : rejected AbortError: The operation was aborted.
  ```

  The one inference the repro does not execute is `primeCodexEvents` itself
  (module-private, not exported): the script models its abandonment by taking one
  `next()` and never calling `return()`. That is a direct reading of
  `:3090-3130`, quoted above.

  Provenance: `git show main:src/services/api/codex-fetch-adapter.ts` has the
  identical `catch { if (error === timeoutError) … }` at `main:2680-2686`, and
  `main:src/services/api/codex-websocket-transport.ts:136-170` has the same
  `queue.tail = priorTail.finally(() => gate)` - **pre-existing on `main`**, and
  `main:136` takes **no** `AbortSignal` and does a bare `await priorTail` at
  `main:160`, so on `main` the hang has no escape at all. The branch strictly
  improved this. **Does not block the branch; does need fixing.**
- **Disposition**: Apply the report's fix, with one change. Move `iterator.return?.()`
  out of the `if (error === timeoutError)` guard so it runs on every abnormal exit -
  but put it in the **`finally`**, guarded by a `handedOff` flag set immediately
  before the `return { async *[Symbol.asyncIterator]() … }` at `:3132`. Putting it in
  the `catch` (the report's literal wording) misses the `next.done` /
  "stream ended before first event" throw at `:3095`, which has the same shape.
  Do **not** also change the queue to self-heal on error: `queue.tail` is correct as
  written, and papering over an abandoned generator there would hide the next
  instance of the same bug. Add the regression test the report's uncertainty section
  describes; my `h2-repro.ts` is directly portable into
  `codex-websocket-transport.test.ts` (the fake WS harness there already has
  everything it needs).

### F3 — [MED] Same abandonment on the HTTP path leaks the response reader, the abort listener, and a 90 s timer

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `httpSseToEvents`'s `finally`
  (`codex-fetch-adapter.ts:1601-1604`) does `clearIdleTimer()` and
  `signal?.removeEventListener('abort', abortReader)`. `IDLE_TIMEOUT_MS` is
  `parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000`
  (`:1537-1538`), so the report's "90 s" is right. The two abandonment sites are
  `:3612-3617` (HTTP-primary streaming) and `:3423-3428` (WS-to-HTTP fallback);
  the report cited `:3611-3617` and `:3421-3428`, off by one.
- **Reachable in production?**: Yes, whenever the WS path is unavailable or the
  sticky HTTP flag is set and the server answers with `response.failed` before any
  visible output.
- **Trigger**: same first-event `response.failed`, HTTP transport. `primeCodexEvents`
  throws, and because `error !== timeoutError` the generator is abandoned mid-yield.
- **Counter-arguments considered**: (a) The HTTP call sites **do** pass
  `cancelOnTimeout` (`:3427`, `:3616`) where the WS site does not (`:3477-3481`
  passes three arguments) - so I checked whether that rescues the failure path. It
  does not: `cancelOnTimeout` is invoked only inside the timeout callback
  (`:3080`). (b) Does `reader` get collected? No - an abandoned async generator's
  `finally` never runs, and there is no `FinalizationRegistry` here.
  (c) Is the timer `unref`'d? No (`:1558`), so it does hold the event loop.
- **True consequence**: as claimed, and correctly rated MED: one uncancelled
  `ReadableStreamDefaultReader` and one armed 90 s `setTimeout` per such turn,
  self-healing after 90 s but delaying clean process exit in the interim.
- **Evidence**: `codex-fetch-adapter.ts:1537-1538`, `:1551-1554`, `:1601-1604`,
  `:3612-3617`. Provenance: `main:src/services/api/codex-fetch-adapter.ts:1147`
  carries the identical body - **pre-existing on `main`**.
- **Disposition**: Same single change as F2; no separate fix. Verify with a second
  case in the same regression test (abandon an `httpSseToEvents` generator, assert
  the idle timer is cleared).

### F4 — [MED] `sessions` map is never evicted for finished subagents

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `sessions` at
  `codex-websocket-transport.ts:129`; the retained clones at `:1366-1367`
  (`cloneJsonValue(fullInput)` and `cloneJsonValue(completedOutputItems)`, written
  only in the `response.completed` arm). Subagent conversationIds are
  `` `${getSessionId()}/${options.agentId}` `` at `src/services/api/claude.ts:788`
  (report said `:787-789`; the function is `:782-793`).
- **Reachable in production?**: Yes. `git grep clearWebSocketSession` outside tests
  returns the transport itself (`:215`, `:251`, `:1101`), the adapter (`:524`,
  `:3533`) and exactly one external caller, `src/utils/sessionTitle.ts:170` -
  which cleans up its own `side/title/<uuid>` conversation in a `finally`. Nothing
  in `src/tools/AgentTool/` or `src/tasks/` calls it.
  `resetCodexCacheContext` (`codex-fetch-adapter.ts:109-112`) clears
  `stickyHttpFallback` and `conversationIdsByCacheKey` and not `sessions`,
  as claimed.
- **Trigger**: run N subagents in one REPL session; each gets its own
  conversationId, its own `WsSession`, and after its last `response.completed` the
  `finally` at `:1438-1457` sees `reachedTerminalDisposition === true` and
  deliberately does **not** close the socket.
- **Counter-arguments considered**: (a) Does something else close the socket between
  turns? The 90 s idle timer is per-turn (`clearIdle()` in the same `finally`), so
  no. (b) Does `closeSocketPreservingState` help? It closes the socket but keeps the
  `sessions` entry and its clones by design (`:246-264`), so it caps the socket leak
  on error paths only, never the memory leak. (c) Is the 60-minute server limit a
  real reaper? Partly - `WS_CONNECTION_LIMIT_CODE` (`:77`) is observed as an error on
  the **next** turn, not as a passive close, so an idle abandoned socket is not
  guaranteed to be reaped at 60 minutes. The report's "until the server's 60-minute
  limit closes them" is a mild overstatement in the leak's favour.
- **True consequence**: as claimed. One open TLS WebSocket to `chatgpt.com` plus one
  full translated-input clone retained per finished subagent, for the life of the
  REPL process.
- **Evidence**: `git grep -n "clearWebSocketSession" -- src/ app/ | grep -v '\.test\.'`;
  `codex-websocket-transport.ts:129`, `:1359-1372`, `:1438-1457`, `:246-264`.
  Provenance: `const sessions = new Map` present on `main` - **pre-existing**.
- **Disposition**: Apply the report's fix - it named the right precedent. Call
  `clearWebSocketSession(conversationIdOverride)` in a `finally` where the agent's
  lease is released, mirroring `sessionTitle.ts:168-171`. One caution the report did
  not raise: the override is `${sessionId}/${agentId}`, and `mapConversationIdToTrackingKey`
  (`:234-242`) reads the same string for prompt-cache-break attribution, so the
  cleanup must run **after** the last turn's telemetry, not on the tool's abort path.

### F5 — [MED] `prompt_cache_key` becomes a per-process random UUID for any non-first (account, model) pair

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes, with the line range off by one:
  `getConversationIdForRequest` is `codex-fetch-adapter.ts:184-205`, and the branch
  is `:198-201` -
  `conversationIdsByCacheKey.size === 0 ? (codexPromptCacheKey ?? CODEX_SESSION_ID) : randomUUID()`.
  Consumed at `:3289` (`codexBody.prompt_cache_key = conversationId`) and echoed
  into the request headers.
- **Reachable in production?**: Yes. `withRetry` rotates the Codex lease inside a
  single request (`withRetry.ts:616`, `:662`, `:817`, `:861`, `:986`, `:1018` all call
  `options.onCodexAccountSwitch?.()`), which is wired to
  `toolUseContext.onChangeAPIKey` at `src/query.ts:750`.
- **Trigger**: as described - failover from account A to B mid-session gives
  `B:model` a `randomUUID()`; restart with B active first gives `B:model` the
  session-derived key instead, orphaning the server-side prefix.
- **Counter-arguments considered**: I checked whether anything resets the map on
  failover, which would make the claim moot.
  `git grep resetCodexCacheContext -- src/ app/` outside tests returns exactly two
  production callers: `src/commands/switch-account/switch-account.ts:246` and
  `src/commands/delete-account/delete-account.ts:151`. Both are explicit operator
  commands. The automatic `withRetry` failover path does not call it. I also
  checked whether subagents are affected - they are not, because
  `conversationIdOverride` short-circuits at `:190-192`.
- **True consequence**: as claimed. Cache-continuity loss across CLI restarts for
  every account/model pair after the first, silently defeating the stated goal in
  the comment at `:65-67`. Cost only.
- **Evidence**: `codex-fetch-adapter.ts:184-205`, `:109-112`, `src/query.ts:750`.
  Provenance: identical branch at `main:src/services/api/codex-fetch-adapter.ts:139-141`
  - **pre-existing on `main`**.
- **Disposition**: The report's fix is right in direction but I would not ship the
  literal string. `` `${codexPromptCacheKey ?? CODEX_SESSION_ID}/${accountId}:${model}` ``
  puts a raw account id into `prompt_cache_key`, which is echoed as
  `conversation-id`/`session_id`/`x-client-request-id` headers (`:3335-3337`) and is
  the one field this codebase is otherwise careful to keep opaque (compare
  `codexStatus.ts`'s `cp_<4hex>` discipline). Use a short stable hash instead -
  `sha256(`${sessionKey}:${accountId}:${model}`).slice(0,32)` - and add the
  corresponding branch to `mapConversationIdToTrackingKey` (`:234-242`), which the
  report correctly flagged.

### F6 — [MED] `CodexResponseFailedError` is not unwrapped by `withRetry`, so a deterministic upstream failure consumes the whole retry budget and triggers account failover

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes. `unwrapCodexAccountError`
  (`withRetry.ts:274-282`) unwraps only `CodexAccountAuthError` and
  `CodexAccountCapError` from `APIConnectionError.cause`; called once, at `:585`.
  The wrap is real and I verified it in the vendored SDK rather than inferring it:
  `node_modules/@anthropic-ai/sdk/client.js:267`
  `throw new Errors.APIConnectionError({ cause: response })` for any fetch-thrown
  error. `shouldRetry` returns `true` unconditionally for `APIConnectionError`
  (`withRetry.ts:1528-1530`). The failover branch is at `:909-914` and the
  outage sleep at `:936-965`, both as cited.
- **Reachable in production?**: Yes. Note the SDK does **not** double-retry:
  cat-code passes `maxRetries: 0` (`claude.ts:944`, `:1979`, "Disabled auto-retry
  in favor of manual implementation"), so the budget spent is cat-code's own.
- **Trigger**: a permanent non-cap `response.failed` before visible output.
- **Counter-arguments considered**: (a) Could the error arrive unwrapped, making the
  unwrap moot? No - `client.js:267` wraps everything the custom `fetch` throws.
  (b) Is `CodexResponseFailedError` maybe already terminal somewhere upstream?
  `:3540-3546` rethrows it deliberately with a comment saying it "must propagate",
  and nothing between there and `withRetry` reclassifies it. (c) **Is the claimed
  consequence right?** This is where it narrows. The report says each retry
  "re-send[s] the entire turn's input tokens". On the WebSocket path that is false:
  because F2 is real and no sticky HTTP flag is armed for this error class
  (`:3157-3159` returns before `:3189`), attempts 0 and 1 do not re-send anything -
  they **block** at `acquireConversationTurn` until the 600 s timeout. Only once
  `attempt >= 2` does the Codex connection-error failover at `:909-914` rotate to a
  different account, which changes the conversationId
  (`getConversationIdForRequest` keys on `${accountId}:${model}`) and *then* the
  turn really is re-sent and re-billed on the new account. The token-re-spend
  description is accurate for the HTTP path (sticky fallback already active) and for
  the post-failover attempts.
- **True consequence**: a deterministic upstream failure is treated as transient and
  consumes the full retry budget. On WS that budget is spent mostly on 600 s hangs
  and then one re-billed attempt on a rotated account; on HTTP it is spent on
  repeated full re-sends. Either way it can reach the suspected-network-outage sleep
  at `:936-965`, misattributing a schema error to a network outage.
- **Evidence**: `withRetry.ts:274-282`, `:585`, `:909-914`, `:1528-1530`;
  `node_modules/@anthropic-ai/sdk/client.js:267`; `claude.ts:944`.
  Provenance: `unwrapCodexAccountError` does **not** exist on `main`
  (`git show main:src/services/api/withRetry.ts | grep unwrapCodexAccount` is
  empty) - the helper is **branch-new**, though the underlying "response.failed is
  retried as a connection error" behaviour predates it. The omission is in new code.
- **Disposition**: Take the report's **first** option, not its second. Add a
  `CodexResponseFailedError` arm to `unwrapCodexAccountError` and let the retry loop
  throw `CannotRetryError`. Do **not** subclass `CodexResponseFailedError` from
  `APIConnectionError` the way `CodexAccountUnavailableError` does (`:340`): that
  class deliberately *stays* an `APIConnectionError` so existing `instanceof`
  handling keeps treating it as retryable, which is the opposite of what is wanted
  here, and it would silently change the WS catch at `:3540-3546`. Fix F2 first -
  with F2 unfixed, making this terminal converts a 600 s hang into a fast failure,
  which is better, but the poisoned queue still outlives the request.

### F7 — [LOW] The upstream SSE parser silently drops spec-legal frames; a second, more correct parser lives in the same file

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: The first half yes, the second half no.
  `httpSseToEvents:1589-1599` does require the exact prefix `'data: '` (`:1592`),
  treats each line as a self-contained JSON document, and `continue`s silently on
  both a prefix miss (`:1592`) and a `JSON.parse` failure (`:1597`). But
  `parseAnthropicSseBlocks` (`:2597-2621`) **also** requires the space -
  `else if (line.startsWith('data: ')) { dataLines.push(line.slice(6)) }` at
  `:2608-2609`. It is more correct on exactly one axis (multi-line `data:`
  accumulation via `dataLines.join('\n')` at `:2614`) and identical on the other.
- **Reachable in production?**: The strict parser yes; the *harm* is unproven
  because it depends on backend behaviour I could not observe, which the report
  itself conceded. `parseAnthropicSseBlocks` is not a competing parser of the same
  input at all: its only caller is `materializeAnthropicMessageFromSse` (`:2631`),
  called from `translateCodexStreamToAnthropicMessage:2812` on the SSE **cat-code
  itself generated** via `buildAnthropicStreamResponse`. Different wire format,
  opposite direction. Calling it "a second, more correct parser [of the same
  thing]" is mis-located.
- **Trigger**: I proved the drop behaviour but not that the backend produces it.
  Feeding `translateCodexStreamToAnthropic` a `data:{…}` frame with no space, and
  separately a `data:`-split-across-two-lines frame, both yield empty text with no
  error and no log.
- **Counter-arguments considered**: (a) Is there a log I missed? No - `:1592` and
  `:1597` are bare `continue`. (b) Would a dropped `response.completed` really end
  the stream "successfully"? On the HTTP path, yes: `httpSseToEvents` returns on
  `done` and `processCodexEvents` closes the controller. (c) Does the ChatGPT/Codex
  Responses endpoint emit either form? Unknown; I did not capture a live
  `text/event-stream` body, and doing so would spend real quota.
- **True consequence**: the parser is stricter than the SSE grammar and fails
  silently. Today that is a latent robustness gap, not an observed defect. The
  "a more correct parser already exists here" framing should be dropped.
- **Evidence**: `scratchpad/good-claims.ts`:

  ```
  (3a) no-space `data:` text = "" (empty = silently dropped)
  (3b) multi-line `data:` text = "" (empty = silently dropped)
  ```

  `codex-fetch-adapter.ts:1589-1599`, `:2597-2621`, `:2812`. Provenance:
  `startsWith('data: ')` present on `main` - **pre-existing**.
- **Disposition**: Take only the second half of the report's fix. Log a warning on
  `JSON.parse` failure instead of `continue` at `:1597` - that is free and turns any
  future instance of this into a visible event. Do **not** relax the prefix or add
  multi-line accumulation on a hypothesis: `httpSseToEvents` is on the hot streaming
  path, the current shape is exactly what the OpenAI Responses API emits, and a
  speculative rewrite of a stream parser with no failing case is the kind of change
  this repo's conventions explicitly discourage. If the log ever fires, revisit with
  a real capture.

### F8 — [LOW] `processCodexEvents` is a 765-line god function

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `processCodexEvents` spans
  `codex-fetch-adapter.ts:1612-2377` (766 lines by `awk` on the closing brace);
  `createCodexFetch` is `:3230-3633`, so the returned closure is the ~400 lines the
  report describes.
- **Reachable in production?**: N/A - design finding on the shared HTTP+WS event
  processor.
- **Trigger**: N/A.
- **Counter-arguments considered**: I checked whether the content-block invariants
  are in fact covered elsewhere, which would defuse the "hardest to test" claim.
  `codex-fetch-adapter.test.ts` reaches them only through
  `translateCodexStreamToAnthropic` (see F9) and `createCodexFetch`, both
  end-to-end; there is no unit-level seam for `contentBlockIndex` /
  `openToolCallBlocks`. The report's framing holds.
- **True consequence**: as claimed - the index bookkeeping is the part most likely to
  break and the part with no isolated test.
- **Evidence**: line spans above.
  Provenance: same function on `main` - **pre-existing**.
- **Disposition**: Agree with the direction, but do not do it on this branch. An
  extraction of the content-block emitter touches the single hottest translation
  path in the Codex transport, and this branch already carries +770 lines in this
  file. File it; land it separately with its own tests, and land F2's fix first.

### F9 — [LOW] `translateCodexStreamToAnthropic` is exported only for tests, and the tests that "cover the HTTP SSE path" do not exercise the production one

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. Defined at `codex-fetch-adapter.ts:2582-2595`;
  `git grep translateCodexStreamToAnthropic\\b -- src/ app/` returns the definition
  plus 10 call sites, all in `codex-fetch-adapter.test.ts`. Production uses
  `buildAnthropicStreamResponse` after `primeCodexEvents` (`:3612-3618`) or
  `translateCodexStreamToAnthropicMessage` (`:3627`). The wrapper calls
  `httpSseToEvents(codexResponse)` with **no** signal and no priming (`:2589`).
- **Reachable in production?**: No - that is the finding.
- **Trigger**: N/A.
- **Counter-arguments considered**: I checked `app/` and `scripts/` as well as
  `src/` in case a desktop or build path imported it. It does not.
- **True consequence**: as claimed, and it is the direct explanation for why F2
  slipped through: the two `response.failed` tests at
  `codex-fetch-adapter.test.ts:1838` and `:1873` assert on a code path that never
  runs in production, so they cannot observe the priming abandonment.
- **Evidence**: `git grep` output above; test bodies at `:1838-1845`, `:1873-1880`.
  Provenance: exported on `main` too - **pre-existing**.
- **Disposition**: Do **not** delete the wrapper as the report's second option
  suggests, and do not repoint all ten tests. Take the first option for the two
  `response.failed` tests only - they are the ones whose claimed coverage is false -
  and leave the eight translation-shape tests (`Apply_patch`, `web_search_call`,
  `stop_reason`) on the wrapper, where the missing signal and priming are irrelevant
  and the seam is genuinely convenient. Rename it `_translateCodexStreamToAnthropicForTest`
  so the next reader is not misled.

### F10 — [LOW] Cap/auth code lists are duplicated across the adapter and the transport with a "keep in sync" comment and no test enforcing it

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `CODEX_ACCOUNT_AUTH_ERROR_CODES` at
  `codex-fetch-adapter.ts:363-368` with the sync comment at `:356-362`;
  `isAuthTokenRejection` at `codex-websocket-transport.ts:886-894` with its own
  mirror comment at `:880-885`. Same pattern for `codexFailureTextIndicatesUsageCap`
  (`:378-386`) vs `isUsageLimitRejection` (`:878-883`).
- **Reachable in production?**: N/A - quality finding; both predicates are live.
- **Trigger**: N/A.
- **Counter-arguments considered**: I searched for a drift test that would make the
  finding stale - `git grep "token_invalidated" -- src/ | grep -i test` returns only
  behavioural tests that exercise one side or the other
  (`codex-fetch-adapter.test.ts:1873`, `:2170`), never an assertion that the two sets
  are equal. I also checked whether the import direction really forces the
  duplication: it does, the adapter imports the transport at `:26-28`.
- **True consequence**: as claimed.
- **Evidence**: line refs above. Provenance: `isUsageLimitRejection` is on `main`
  (`main:codex-websocket-transport.ts:695`); `isAuthTokenRejection` and
  `CODEX_ACCOUNT_AUTH_ERROR_CODES` are **branch-new**, so the branch doubled the
  duplication it documents.
- **Disposition**: Apply the report's **second** option only - a test asserting the
  two sets are equal. Do not extract a leaf module: the transport is deliberately
  adapter-free (the doc comments at `:52-66` and `:880-885` state that constraint),
  and a new shared module is a third file to keep aligned for a four-string list. A
  five-line test is the whole fix.

### F11 — [LOW] Em dash in `/accounts` output

- **Verdict**: **CONFIRMED** (but out of scope for this branch)
- **Cited location holds?**: Yes, exactly:
  `src/services/api/codexUsage.ts:489` is `return '  [free — no Codex access]'`.
- **Reachable in production?**: Yes - `formatDisplayStatusTag` is part of
  `formatPoolUsage`, the `/accounts` rendering.
- **Trigger**: any free-plan Codex account in the pool.
- **Counter-arguments considered**: (a) Is it actually in the branch's diff as a
  change? No. `git diff main...HEAD -- src/services/api/codexUsage.ts` shows the
  line only as **context** inside an adjacent hunk; the string is at
  `main:src/services/api/codexUsage.ts:382` and was introduced by `d6da1a9`
  (2026-06-16), long before this branch. (b) Does the CLAUDE.md rule reach here?
  §7's prohibition is written for "anything a user can read on screen", which CLI
  output is, but the enforcement check it specifies is
  `rg -n '—' app/renderer/src`, i.e. renderer-scoped. So this is a real instance of
  the spirit of the rule and not a branch regression.
- **True consequence**: one em dash in `/accounts` output.
- **Evidence**: `codexUsage.ts:489`; `git log -S` → `d6da1a9`; diff shows context
  only.
- **Disposition**: Apply `'  [free, no Codex access]'` if someone is already in the
  file. Do not open a change for it on this branch, and do not treat it as a branch
  finding - flagging pre-existing engine text as a migration-branch defect is how
  review noise accumulates. Note the same comment block two lines up (`:485-487`)
  also contains an em dash, but comments are explicitly not a text surface.

### F12 — [LOW] Cheap secondary calls can silently upgrade to the frontier model under a custom `ANTHROPIC_SMALL_FAST_MODEL`

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `mapClaudeModelToCodex`
  (`codex-fetch-adapter.ts:567-574`) is exactly the substring ladder described, with
  the final `return DEFAULT_CODEX_MODEL` and `DEFAULT_CODEX_MODEL = 'gpt-5.6-terra'`
  at `:560`. `getSmallFastModel()` (`src/utils/model/model.ts:43-45`) returns
  `process.env.ANTHROPIC_SMALL_FAST_MODEL || getDefaultHaikuModel()`, and
  `getSmallFastModelForProvider()` (`:60-65`) is the Codex-aware variant.
  All three cited call sites verified: `src/utils/hooks/execPromptHook.ts:72`,
  `src/utils/hooks/execAgentHook.ts:118`, `src/utils/hooks/skillImprovement.ts:214`.
- **Reachable in production?**: Yes, but gated on the user setting
  `ANTHROPIC_SMALL_FAST_MODEL` to a value containing none of
  `haiku`/`sonnet`/`opus`. Unset, the default Haiku model name maps to
  `gpt-5.6-luna` correctly.
- **Trigger**: `ANTHROPIC_SMALL_FAST_MODEL=fast-tier` while the session is routed
  through Codex; every prompt-hook, agent-hook and skill-improvement call routes to
  Terra.
- **Counter-arguments considered**: (a) Does `resolveRequestProvider` send a Claude
  model string to the Codex adapter at all? Yes -
  `getProviderForModel` (`src/utils/model/providers.ts:66-70`) returns `null` for a
  non-`gpt-*` model, so the session provider decides, and a Codex session sends it
  to the adapter. (b) Are the other `getSmallFastModel()` call sites also affected?
  `tokenEstimation.ts` and `claudeAiLimits.ts` are documented Anthropic-billing
  consumers (`model.ts:56-59`) and are correct as-is; `claude.ts:375`, `:599`,
  `client.ts:511`, `agenticSessionSearch.ts:259` were not in scope here and I did
  not classify them.
- **True consequence**: cost only, as claimed. No functional break.
- **Evidence**: line refs above.
  Provenance: `main:src/utils/hooks/execPromptHook.ts:72` has the same
  `getSmallFastModel()` - **pre-existing on `main`**.
- **Disposition**: Apply the report's fix at the three named sites. One caution it
  did not state: `hook.model ?? getSmallFastModel()` means a hook that *explicitly*
  configures a model must keep winning, so the change is
  `hook.model ?? getSmallFastModelForProvider()`, not a wholesale swap. Consider
  also auditing `agenticSessionSearch.ts:259`, which has the same shape and was
  outside S05's scope.

### F13 — [LOW] Dead `body.cancel()` on a locked stream

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `codex-fetch-adapter.ts:1565` is
  `codexResponse.body?.cancel(idleTimeoutError).catch(() => {})`, immediately after
  `cancelReader(idleTimeoutError)` at `:1564` which does
  `reader.cancel(error).catch(() => {})` (`:1546-1549`). The reader was acquired at
  `:1540`, so the stream is locked.
- **Reachable in production?**: Yes, on every 90 s idle timeout.
- **Trigger**: idle timeout fires.
- **Counter-arguments considered**: I checked whether the spec behaviour might differ
  in Bun, since the whole claim rests on it, and confirmed it at runtime rather than
  from the spec text. I also checked whether `reader.cancel()` alone is sufficient -
  it is: cancelling through the reader cancels the underlying source.
- **True consequence**: exactly as claimed - a no-op line whose rejection is
  swallowed.
- **Evidence**: `scratchpad/good-claims.ts` →
  `(5) body.cancel() on locked stream -> REJECTED TypeError`.
  Provenance: `main:src/services/api/codex-fetch-adapter.ts:1147` - **pre-existing**.
- **Disposition**: Delete the line. Trivially safe.

## The "what is good" claims

Verified by execution rather than reading, since a false clean bill is as damaging
as a false defect:

- **UTF-8 boundary handling** - **HOLDS.** Splitting a 4-byte emoji across two
  reads round-trips intact: `(1) utf8-split text = "日本語テスト🎉" OK`. The
  `TextDecoder({stream: true})` + `buffer = lines.pop()` carry-forward
  (`:1572-1587`) also survives an event split at an arbitrary byte:
  `(2) split-event text = "hello world" OK`.
- **Abort really reaches the socket** - **HOLDS.** Driving the real
  `streamTurnViaWebSocketLocked` with a signal: `socket closed before abort: false`,
  `socket closed after abort: true | turn rejected: AbortError`. The path is
  `onAbort` (`:1237-1239`) → `failStream(…, {closeSocket: true})` (`:1197-1219`) →
  `closeSocketPreservingState`.
- **Reconnect bounds** - **HOLDS by inspection.** `streamTurnViaWebSocket:908-941`
  is a 3-iteration loop with one `StaleResponseIdError` retry and one
  `ConnectionLimitError` reconnect; `openSession`'s connect timeout is at `:324-326`;
  `STICKY_HTTP_FALLBACK_TTL_MS = 60 * 1000` at `:74`. Not executed.
- **Provider routing single-sourced** - **HOLDS, with a provenance correction.**
  `client.ts:453-454` resolves once via `resolveRequestProvider(model, provider)` and
  emits `model.provider_mismatch` (`:158-176`); `rg` over `client.ts` finds no
  second derivation (`startsWith('gpt-')` appears nowhere in the file). The
  correction: this is **not** a branch fix.
  `main:src/services/api/client.ts:356-357` is byte-identical in substance, so
  "Provider routing is fixed" describes the state of `main`, not a change this
  branch made. Other scopes leaning on this should lean on it - it is true - but
  should not credit the migration branch for it.
- **`reconcileCanonicalDelta` and the record/replay contract** - **NOT
  independently verified.** I read the injection seam (`:52-66`) and the
  reasoning-item escape hatch comment (`:688-690`) and found them as described, but
  I did not exercise the delta logic. Treat that praise as unverified.
- **`codexStatus.ts` opacity discipline** - **HOLDS by inspection**, and my F1 repro
  incidentally corroborates it: profile refs came out as `cp_95ec`/`cp_85ba` with no
  account id, alias, or email anywhere in the emitted object, even with an email
  present in the injected usage snapshot.

## Findings the original report missed

### [MED, tooling] `.gitignore:3` makes `rg` and `git status` blind to all of `src/cli/`

- **Where**: `.gitignore:3` - a bare `cli` pattern, intended for the built `./cli`
  binary at the repo root.
- **What**: the pattern has no leading slash, so it matches a directory named `cli`
  at **any** depth. `git check-ignore -v src/cli/zzz-new-file.ts` →
  `.gitignore:3:cli	src/cli/zzz-new-file.ts`. Consequences, both verified:
  - `rg` respects `.gitignore`, so **any traversal-based search silently skips
    `src/cli/**`**. `rg -n "buildCodexStatus" src/` returns 6 hits and does not
    include `src/cli/handlers/codexStatus.ts`; `rg -n "buildCodexStatus" src/cli/`
    (explicit path, which overrides the ignore) returns it. Explicitly-passed paths
    and `git grep` are unaffected.
  - A **newly added** file under `src/cli/` would not appear in `git status` and
    would need `git add -f`. Existing files are tracked, so they are safe.
- **Why it matters here**: this is the same failure shape as the documented
  `codex-fetch-adapter.ts` NUL-byte blind spot (fixed 2026-07-28), and it is live
  right now on a directory containing 20+ files including the print-mode entry
  points and every CLI subcommand handler. Any reviewer or agent that concludes
  "no callers" from an `rg` sweep over `src/` is wrong about `src/cli/`. S05 found
  `src/cli/handlers/codexStatus.ts:17` anyway, so it did not suffer from this - but
  it is luck, not method.
- **Evidence**: commands and outputs above. Provenance: `main:.gitignore:3` is
  identical - **pre-existing**, not branch-introduced. The branch's `.gitignore`
  diff only appends design-sync entries.
- **Disposition**: Change line 3 to `/cli` and line 4 to `/cli-dev`, anchoring both
  to the repo root where the build artifacts actually live. One-character fix, no
  behavioural risk, and it restores `rg` coverage of a fifth of the CLI surface.
  Verify with `git check-ignore -v src/cli/zzz.ts` returning exit 1 and
  `rg --files src/ | grep -c src/cli` being non-zero afterwards.

### [supporting, folded into F1] `buildCodexStatus`'s production default has zero test coverage

Not a separate defect, but the reason F1 shipped. All 12 tests in
`src/services/api/codexStatus.test.ts` pass `loadPool: false`; the production
default (`loadPool` omitted → `true`) is exercised by nothing. `bun test
src/services/api/codexStatus.test.ts` → 12 pass / 0 fail, so the suite is green and
blind at the same time. Any fix for F1 must add a default-path test or the next
change re-introduces it.

## Provenance summary (branch-blocking assessment)

| Finding | Cited file | On `main`? | Blocks `migration`? |
|---|---|---|---|
| **F1** | `codexStatus.ts`, `deferredContinuation*.ts`, `continue-after-limit.tsx`, `codexAccountPool.ts:183` | **NO — all introduced by `44f45b1` on this branch** | **YES** |
| F2 | `codex-fetch-adapter.ts:3123`, `codex-websocket-transport.ts:149` | yes (`main:2680`, `main:136`); `main` lacks the abort escape and is worse | no |
| F3 | `codex-fetch-adapter.ts:1601` | yes (`main:1147` region) | no |
| F4 | `codex-websocket-transport.ts:129` | yes | no |
| F5 | `codex-fetch-adapter.ts:198-201` | yes (`main:139-141`) | no |
| F6 | `withRetry.ts:274-282` | **helper is branch-new**; the retry behaviour it fails to cover predates it | no |
| F7 | `codex-fetch-adapter.ts:1592` | yes | no |
| F8, F9, F13 | `codex-fetch-adapter.ts` | yes | no |
| F10 | `codex-websocket-transport.ts:886` | cap half yes (`main:695`); **auth half branch-new** | no |
| F11 | `codexUsage.ts:489` | yes (`main:382`, from `d6da1a9`); in the diff as context only | no |
| F12 | `execPromptHook.ts:72` etc. | yes | no |
| missed (gitignore) | `.gitignore:3` | yes | no |

**One finding in this scope is introduced by the `migration` branch: F1.** It is
also the one with the worst user-facing consequence, it is on an automatic live-REPL
path, and its production default is untested. Everything else is engine-wide debt
that predates the migration program.

## Uncertainty

- **Whether the Codex backend ever emits `data:` without a space or a multi-line
  `data:` field (F7's severity).** Same open question the original report declared.
  I proved cat-code drops both forms; I did not prove the server produces either.
  What would settle it: one captured raw `text/event-stream` body from
  `chatgpt.com/backend-api/codex/responses`. That spends real quota, so I did not.
- **`primeCodexEvents` itself was not executed.** It is module-private and not
  exported, so `h2-repro.ts` models its abandonment (one `next()`, no `return()`)
  rather than calling it. The modelling is a direct reading of
  `codex-fetch-adapter.ts:3090-3130`, quoted in F2, and the control arm proves the
  fix works - but the last inch is inference, not execution. Exporting a
  `_primeCodexEventsForTest` seam, or driving `createCodexFetch` end to end with a
  stubbed WS and stubbed credential resolver, would close it.
- **`reconcileCanonicalDelta` was read, not exercised.** The report praises it; I
  neither confirmed nor refuted that praise beyond checking the seam and the
  documented assumption.
- **`translateMessages` (`codex-fetch-adapter.ts:1054-1259`) was not read**, same
  limitation the original report declared. F5's cache-continuity analysis is
  therefore complete only for the request-envelope fields.
- **No `app/` battery was run.** F1 touches `app/sidecar/accountsDomain.ts:587` and
  `app/sidecar/accountsPoolWorker.ts:104` as callers of the same function; I
  classified them by reading, and whoever applies the fix owes the `app/` battery
  per CLAUDE.md §3.
