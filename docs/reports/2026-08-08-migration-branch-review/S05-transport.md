# S05 — Codex transport, status, provider routing

## Verdict

The transport layer is unusually well-reasoned: SSE buffering, UTF-8 boundaries, WS
reconnect bounds, abort-to-socket-close, and error classification are all handled
deliberately and mostly correctly, and the cache-continuity machinery
(`reconcileCanonicalDelta`, canonical record/replay shapes) is genuinely careful work.
Provider routing is fixed — `getAnthropicClient` now routes on `resolveRequestProvider`
and the documented dead-Haiku re-derivation bug is gone. Two things need fixing before
this is safe. First, the confirmed `buildCodexStatus` HIGH is worse than "an observation
call destroys state": on the live REPL path it also **inverts its own verdict**, because
the wipe makes every capped account read `healthy`, so `/continue-after-limit` reports "a
usable account is available" to a user whose pool is fully exhausted. Second,
`primeCodexEvents` abandons its source iterator on the `response.failed` path, which
permanently deadlocks the per-conversation WebSocket turn queue — every later WS turn on
that conversation blocks until the 10-minute SDK timeout.

## Findings

### [HIGH] `buildCodexStatus` blast radius: the pool wipe runs on the live REPL path and inverts the verdict it reports
- **Where**: `src/services/api/codexStatus.ts:417-419` (`loadPoolForObservation()`); callers `src/commands/continue-after-limit/continue-after-limit.tsx:376`, `src/services/deferredContinuationRunner.ts:578`, `src/cli/handlers/codexStatus.ts:17`
- **Type**: correctness
- **What**: `loadPoolForObservation` (`codexAccountPool.ts:183-207`) assigns `pool.accounts = mergePoolAccounts(vaultAccounts, configAccount)` on the module singleton (`codexAccountPool.ts:96`). `mergePoolAccounts` (`:1040-1063`) builds entirely fresh objects from vault JSON and never merges in-memory state, and `loadVaultAccounts` (`:998-1013`) emits `status` derived only from vault refresh state plus `lastUsedAt: 0`. Every in-memory field on `PoolAccount` (`:32-58`) is destroyed: `status: 'capped' | 'quarantined'`, `statusReason`, `cappedAt`, `usagePrimary/usageWeekly/usageAllowed/usageLimitReached/usageFetchedAt/usageResetAt`, `redeemedAt`, `lastErrorAt`, and the LRU `lastUsedAt`. `pool.activeIndex` is also recomputed from `config.activeCodexAccountId`, discarding the position the process failed over to.
- **Trigger / why it matters**: per caller —
  - `cli/handlers/codexStatus.ts:17` — standalone one-shot process, exits immediately. **Harmless**, and this is the case the file header was written for.
  - `commands/continue-after-limit/continue-after-limit.tsx:376` → `evaluateDeferredContinuationEligibility` (`deferredContinuation.ts:1169`) — **hot path, in the live REPL process.** Concrete sequence: all N Codex accounts 429 → `markPoolAccountCapped` sets `status:'capped'` + `cappedAt` → withRetry throws terminal `quota_exhausted` → the user types `/continue-after-limit` → `buildCodexStatus` reloads the pool → every account is now `status:'healthy'` with no `cappedAt` → `getCodexAccountAvailability` (`codexAccountPool.ts:1544-1572`) returns `available` → `classifyProfile` (`codexStatus.ts:206-233`) returns `candidate` for all of them → `decide` (`:386-388`) returns `delegate`/`candidate_available` → eligibility is `run_now` → the command prints "A usable Codex account is available, so continuation will start now" and schedules an immediate retry that re-burns a 429 on every profile. The emitted JSON is self-contradictory in the same object: `classifyProfile` reads only the (wiped) account, while `buildProfileUsage` (`:271-300`) reads the live/cached usage snapshot, so a profile can be `routing_state: "candidate"` with `usage.allowed: false, limit_reached: true`.
  - `services/deferredContinuationRunner.ts:578` (`applyAttemptResult`, `quota_exhausted` arm) — reachable from `beginForegroundDeferredContinuation` (`:686`) and `reconcileDeferredContinuationJob` (`:730`), **both of which run in the live REPL process**, so the same wipe hits the session the user is actively working in. Also reachable from the one-shot `deferred-continuation-worker` process (`main.tsx:618`), where it is harmless.
  - `app/sidecar/accountsDomain.ts:587` (`reloadPool`) — **live sidecar session process**, but only on a resolve-miss before an account-targeting write. The comment at `:604-605` claims "the in-memory usage hints the pool accumulated are not thrown away on every verb"; on the miss path they are thrown away completely, along with cap state.
  - `app/sidecar/accountsPoolWorker.ts:104` — disposable per-run process. **Harmless.**
- **Fix**: `buildCodexStatus` must not load the pool when one is already live. Gate on the existing `pool.initialized` (or add a `loadPool: 'if-empty'` default) so the in-process callers observe the live pool and only a cold standalone process reads from disk. The two deferred-continuation call sites should pass `loadPool: false` explicitly.

### [HIGH] `primeCodexEvents` abandons its iterator on `response.failed`, permanently deadlocking the WebSocket turn queue for that conversation
- **Where**: `src/services/api/codex-fetch-adapter.ts:3102-3130`; queue at `src/services/api/codex-websocket-transport.ts:149-213`, released only in `streamTurnViaWebSocketLocked`'s `finally` (`:548-550`)
- **Type**: correctness
- **What**: `primeCodexEvents` calls `iterator.return?.()` only when the failure is its own initial-output timeout (`:3124-3126`). On the `responseFailedErrorForInitialEvent` branch (`:3102-3108`) it throws while the source generator is suspended at a `yield`, so no `return()` is issued and no `finally` in the delegation chain ever runs.
- **Trigger / why it matters**: the server emits `response.failed` as the first event of a streamed WS turn (bad tool schema, content policy, transient upstream failure). `_streamTurnAttempt` yields it (`:1356`), `primeCodexEvents` throws `CodexResponseFailedError`, and the abandoned chain means `streamTurnViaWebSocketLocked`'s `finally { releaseTurn() }` never fires. `releaseTurn` is what resolves `gate`, and `queue.tail = priorTail.finally(() => gate)` (`:167`) — `Promise.prototype.finally` waits on a thenable returned by its callback, so `queue.tail` never settles. `conversationTurnQueues` still holds the entry (it is deleted only when `pending` reaches 0, `:209-211`). **Every subsequent WebSocket turn on that conversationId then blocks forever at `await priorTail` (`:185`)**, released only by the request's own abort — i.e. the SDK's 600 s `API_TIMEOUT_MS` (`client.ts:460`) or a user Esc. The same abandonment also skips `_streamTurnAttempt`'s `finally` (`:1438-1443`), leaking the three `ws` listeners and leaving its 90 s idle timer armed.
- **Fix**: in `primeCodexEvents`, run `iterator.return?.()` on **every** abnormal exit, not just the timeout — move it into the `catch` unconditionally (or into the `finally` guarded by a "did we hand the iterator off" flag).

### [MED] Same abandonment on the HTTP path leaks the response reader, the abort listener, and a 90 s timer
- **Where**: `src/services/api/codex-fetch-adapter.ts:1601-1604` (`httpSseToEvents` cleanup), abandoned by `:3102-3108`
- **Type**: correctness
- **What**: on the HTTP streaming path (`:3611-3617` and `:3421-3428`) the abandoned generator is `httpSseToEvents`, whose `finally` performs `clearIdleTimer()` and `signal.removeEventListener('abort', abortReader)`. Neither runs, and `reader.cancel()` is never called.
- **Trigger / why it matters**: an HTTP-transport turn whose first event is `response.failed` leaves the `ReadableStreamDefaultReader` uncancelled and a 90 s `setTimeout` armed, which keeps the event loop alive and holds the underlying connection until the timer self-heals. Bounded at 90 s, but it fires on every such turn and delays clean process exit.
- **Fix**: same one-line change as the HIGH above.

### [MED] `sessions` map is never evicted for finished subagents: an open WebSocket and a full input clone are retained per agent run
- **Where**: `src/services/api/codex-websocket-transport.ts:129` (`sessions`), `:1364-1367` (retained payload); no cleanup call site
- **Type**: correctness
- **What**: each subagent gets its own conversationId `${sessionId}/${agentId}` (`claude.ts:787-789`), so each gets its own `WsSession` holding a live `ws` plus `cloneJsonValue(fullInput)` and `cloneJsonValue(completedOutputItems)` — the entire translated conversation input for that agent's last turn. Entries are removed only by `clearWebSocketSession` and the reconnect branch (`:450`). The only non-adapter caller of `clearWebSocketSession` is `sessionTitle.ts:165`, which cleans up its own `side/title/<uuid>` conversation. Nothing cleans up after an agent finishes; `resetCodexCacheContext` (`codex-fetch-adapter.ts:109-112`) clears the sticky/conversation maps but not `sessions`.
- **Trigger / why it matters**: run 20 subagents in one REPL session and the process holds 20 open WebSockets to `chatgpt.com` (until the server's 60-minute limit closes them) plus 20 retained full-transcript clones. This repo has a documented energy regression from exactly this class of retained connection. `sessionOpenVersions` (`:130`) and `stickyHttpFallback` (`codex-fetch-adapter.ts:81`) grow the same way, though their per-entry cost is trivial.
- **Fix**: `sessionTitle.ts:165` is the right precedent — call `clearWebSocketSession(conversationIdOverride)` when a subagent run completes, in the same place the agent's lease is released.

### [MED] `prompt_cache_key` becomes a per-process random UUID for any non-first (account, model) pair
- **Where**: `src/services/api/codex-fetch-adapter.ts:183-204` (`getConversationIdForRequest`), consumed at `:3289` (`codexBody.prompt_cache_key = conversationId`)
- **Type**: correctness
- **What**: only the **first** `${accountId}:${model}` pair seen in the process gets the restart-stable key (`codexPromptCacheKey`, set from the session id at `setup.ts:90`). Every later pair gets `randomUUID()`. The exact varying field is `prompt_cache_key` (and the identical `conversation-id` / `session_id` / `x-client-request-id` headers at `:3335-3337`).
- **Trigger / why it matters**: the pool auto-fails over from account A to account B inside `withRetry` (`withRetry.ts:602`, `:652`); `onCodexAccountSwitch` is wired to `toolUseContext.onChangeAPIKey` (`query.ts:750`), a UI callback that does **not** call `resetCodexCacheContext`. So `B:model` gets a random key. Restart the CLI and resume: B is now active first, so `B:model` gets `codexPromptCacheKey` instead — a different value, orphaning the server-side prefix built under the random one. This directly defeats the stated Phase-1 goal at `:65-67` ("set by the session bootstrap from the persisted Cat Code sessionId so that CLI restarts reuse the same key"). The same applies to switching models mid-session and back.
- **Fix**: derive the id deterministically instead of randomly, e.g. `` `${codexPromptCacheKey ?? CODEX_SESSION_ID}/${accountId}:${model}` `` (or a short stable hash of it), so every pair is restart-stable. `/` is already used as a separator by the subagent override, and `mapConversationIdToTrackingKey` (`:234-242`) would need the corresponding branch.

### [MED] `CodexResponseFailedError` is not unwrapped by `withRetry`, so a deterministic upstream failure consumes the whole retry budget and triggers account failover
- **Where**: `src/services/api/withRetry.ts:274-282` (`unwrapCodexAccountError`), thrown at `src/services/api/codex-fetch-adapter.ts:539` / surfaced at `:3543-3545`
- **Type**: correctness
- **What**: `unwrapCodexAccountError` unwraps only `CodexAccountAuthError` and `CodexAccountCapError` from `APIConnectionError.cause` (the existence of that unwrap is itself the evidence that the Anthropic SDK wraps adapter-thrown errors). `CodexResponseFailedError` stays wrapped and is therefore seen by the retry loop as a plain `APIConnectionError`.
- **Trigger / why it matters**: a permanent upstream `response.failed` (invalid request, unsupported schema, content policy) delivered before any visible output is retried the full budget, each retry re-sending the entire turn's input tokens. After two attempts it also enters the Codex connection-error failover branch (`withRetry.ts:909-914`), rotating the lease to a healthy account and re-spending there, and can reach the suspected-network-outage sleep at `:936-965`. The adapter's own comment at `:3537-3539` says these "must propagate" and "preserve the upstream error" — the retry layer does not honor that.
- **Fix**: either add a `CodexResponseFailedError` arm to `unwrapCodexAccountError` and treat it as terminal (`CannotRetryError`), or subclass it from the non-retryable error family the way `CodexAccountUnavailableError` (`withRetry.ts:340`) narrows `APIConnectionError`.

### [LOW] The upstream SSE parser silently drops spec-legal frames; a second, more correct parser lives in the same file
- **Where**: `src/services/api/codex-fetch-adapter.ts:1589-1599` vs `:2597-2621`
- **Type**: correctness
- **What**: `httpSseToEvents` requires the exact prefix `'data: '` with a space and treats each `data:` line as a self-contained JSON document; anything else hits `continue` with no log. The SSE grammar makes the space optional and allows a value split across several `data:` lines. `parseAnthropicSseBlocks`, 1000 lines down in the same file, handles both correctly (`dataLines.join('\n')`).
- **Trigger / why it matters**: if the Codex backend ever emits `data:{"type":...}` or a multi-line `data:` field, the event vanishes with no error and no log. If the dropped event is `response.completed`, the stream ends "successfully" with truncated output rather than failing. I could not confirm the current backend does either, which is why this is LOW and not higher.
- **Fix**: relax to `line.startsWith('data:')` + strip one optional leading space, accumulate `data:` lines per blank-line-delimited block, and log a warning on a JSON parse failure instead of `continue`.

### [LOW] `processCodexEvents` is a 765-line god function
- **Where**: `src/services/api/codex-fetch-adapter.ts:1612-2377`; the closure returned by `createCodexFetch` is another ~400 lines (`:3235-3633`)
- **Type**: design
- **What**: one function owns Anthropic SSE emission, reasoning-block ordinal bookkeeping, tool-call block lifecycle, web-search translation, usage extraction, transport-fallback control flow, telemetry, and error classification, with a labeled `stream_loop`/`continue stream_loop` for the fallback. Ten-plus mutable locals are shared across all of it.
- **Trigger / why it matters**: the content-block index invariants (`contentBlockIndex`, `currentTextBlockStarted`, `openToolCallBlocks`) are the part most likely to break under an unfamiliar event ordering, and they are the part hardest to isolate in a test. This is the cost, not a hypothetical.
- **Fix**: extract the content-block emitter (start/stop/index bookkeeping) into its own small stateful object with its own tests, leaving `processCodexEvents` as event dispatch plus transport control flow.

### [LOW] `translateCodexStreamToAnthropic` is exported only for tests, and the tests that "cover the HTTP SSE path" do not exercise the production one
- **Where**: `src/services/api/codex-fetch-adapter.ts:2582-2595`; consumed only by `codex-fetch-adapter.test.ts` (10 call sites)
- **Type**: dead-code
- **What**: no production call site. Production uses `buildAnthropicStreamResponse` directly (`:3618`) or `translateCodexStreamToAnthropicMessage` (`:3627`), both of which go through `primeCodexEvents` and pass an abort signal; the test seam calls `httpSseToEvents(codexResponse)` with **no** signal and no priming.
- **Trigger / why it matters**: the `response.failed` tests at `:1838` and `:1873` assert behavior on a code path production never takes — which is exactly why the `primeCodexEvents` abandonment (HIGH above) is not caught by them.
- **Fix**: point the tests at `buildAnthropicStreamResponse(await primeCodexEvents(httpSseToEvents(res, signal), ...))` and delete the wrapper, or keep it and route production through it.

### [LOW] Cap/auth code lists are duplicated across the adapter and the transport with a "keep in sync" comment and no test enforcing it
- **Where**: `src/services/api/codex-fetch-adapter.ts:363-368` (`CODEX_ACCOUNT_AUTH_ERROR_CODES`) vs `src/services/api/codex-websocket-transport.ts:886-894` (`isAuthTokenRejection`); same pattern for `codexFailureTextIndicatesUsageCap` vs `isUsageLimitRejection`
- **Type**: quality
- **What**: the import direction (adapter → transport) forces the duplication, which is reasonable, but nothing detects drift. The auth list already exists because `token_invalidated` was missed once (the comment at `:356-362` records it).
- **Fix**: move both predicates into a small leaf module both files import, or add a test asserting the two sets are equal.

### [LOW] Em dash in `/accounts` output
- **Where**: `src/services/api/codexUsage.ts:489` — `return '  [free — no Codex access]'`
- **Type**: convention
- **What**: user-visible CLI text containing an em dash. The string itself predates this branch (the surrounding comment block was edited here), but the block is in the diff.
- **Fix**: `'  [free, no Codex access]'`.

### [LOW] Cheap secondary calls can silently upgrade to the frontier model under a custom `ANTHROPIC_SMALL_FAST_MODEL`
- **Where**: `src/services/api/codex-fetch-adapter.ts:567-574` (`mapClaudeModelToCodex`), reached from `getSmallFastModel()` call sites such as `src/utils/hooks/execPromptHook.ts:72`, `execAgentHook.ts:118`, `skillImprovement.ts:214`
- **Type**: correctness
- **What**: those call sites use `getSmallFastModel()` rather than `getSmallFastModelForProvider()` (`model.ts:60-65`). While the session is on Codex, `resolveRequestProvider` sends the Claude model string to the adapter, where `mapClaudeModelToCodex` rescues it only by substring — `haiku`/`sonnet` → `gpt-5.6-luna`, `opus` → `gpt-5.6-terra`, and **anything else** → `DEFAULT_CODEX_MODEL` (`gpt-5.6-terra`).
- **Trigger / why it matters**: a user who sets `ANTHROPIC_SMALL_FAST_MODEL` to a gateway alias without `haiku`/`sonnet`/`opus` in the name (e.g. `fast-tier`) silently routes every hook evaluation and skill-improvement call to Terra instead of Luna. Cost only, no functional break.
- **Fix**: use `getSmallFastModelForProvider()` at those three sites, matching `awaySummary.ts:44`, `sessionTitle.ts:112`, `generateSessionName.ts:44`, and `teleport.tsx:127`.

### [LOW] Dead `body.cancel()` on a locked stream
- **Where**: `src/services/api/codex-fetch-adapter.ts:1565`
- **Type**: quality
- **What**: `codexResponse.body?.cancel(err)` is called immediately after `reader.cancel(err)`. Per spec `ReadableStream.cancel()` on a locked stream returns a rejected `TypeError`, which the attached `.catch(() => {})` swallows — so the line never does anything.
- **Fix**: delete it; `reader.cancel()` already cancels the underlying source.

## What is good here

- **Abort really does reach the socket.** `onAbort` → `failStream(..., {closeSocket: true})` (`codex-websocket-transport.ts:1236-1238`, `:1197-1219`), plus the abandoned-consumer guard in the generator's `finally` (`:1450-1457`) that closes the socket when the consumer walks away without a terminal disposition. The Esc-abort case is handled explicitly rather than assumed.
- **Reconnect is genuinely bounded, with no spin.** `streamTurnViaWebSocket` caps at 3 attempts with a single stale-response-id retry and a single connection-limit reconnect (`:908-941`), the connect itself has a 15 s timeout (`:324-326`), and the 60 s sticky HTTP fallback (`codex-fetch-adapter.ts:74`) keeps a failing WS from being retried in a hot loop.
- **`TextDecoder({stream: true})` + carry-forward buffer** in `httpSseToEvents` (`:1572-1587`) is the correct pattern for both multi-byte UTF-8 splits and events split across reads; the idle timer is reset per read and cleared in `finally`.
- **The record/replay canonicalization contract is documented at the seam it constrains.** `canonicalizeCodexItem` is injected into the transport rather than imported (`:52-66`), with the reason (the adapter imports the transport) stated in place, and `reconcileCanonicalDelta`'s reasoning-item escape hatch names its assumption explicitly (`:688-690`).
- **`codexStatus.ts` opacity discipline.** Opaque `cp_<4hex>` profile refs, closed status/reason enums, no raw account ids or error strings on the wire, and `buildCodexStatusError` deliberately returning a generic message with the detail going to the debug log (`:542-555`).
- **Provider routing is now single-sourced.** `getAnthropicClient` resolves once via `resolveRequestProvider(model, provider)` (`client.ts:453`) and emits `model.provider_mismatch` when the caller's provider disagrees (`:158-177`) — the documented re-derivation bug cannot recur silently.

## Not reviewed / uncertain

- **Whether the Codex backend ever emits `data:` without a space or a multi-line `data:` field.** This decides whether the SSE-parser finding is LOW or HIGH. A capture of a raw `text/event-stream` response body from `chatgpt.com/backend-api/codex/responses` would settle it.
- **The `response.failed`-first-event deadlock is reasoned from source, not executed.** The chain (`primeCodexEvents` throw → no `iterator.return()` → `releaseTurn` never runs → `queue.tail` never settles) is verified line by line, but I did not run a test. A focused test — inject a WS factory that emits `response.failed` as the first frame, then issue a second turn on the same conversationId and assert it does not hang — would confirm it and guard the fix.
- **`claude.ts` (3,751 lines) was read only around the Codex seams** (`getCodexConversationIdOverride`, the `getSmallFastModelForProvider` block at `:3583`, and the `onCodexAccountSwitch` plumbing). Its streaming/non-streaming fallback interaction with adapter-thrown errors is not covered by this review.
- **`translateMessages` (`codex-fetch-adapter.ts:1054-1259`) was not read line by line.** It is the other place a per-request cache-busting variance could hide; I ruled out the request-envelope fields and `prompt_cache_key`, and confirmed `getSystemContext` is memoized (`context.ts:147`) so the volatile developer message is stable within a process, but I did not audit message translation itself for nondeterministic serialization.
- **No tests or batteries were run** (read-only review per the contract).
