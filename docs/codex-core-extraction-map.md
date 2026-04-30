# Codex Core Extraction Map

This document maps the current Codex/GPT request path in cat-code and identifies the smallest reusable pieces needed for one standalone LLM request. It is investigation-only: no implementation code was changed.

## Current Codex request flow

The Codex backend is reached through an Anthropic-compatible path:

1. The CLI starts in `src/entrypoints/cli.tsx` and loads the full app from `src/main.tsx`.
2. User input enters the app through `src/screens/REPL.tsx`, then `src/utils/handlePromptSubmit.ts`.
3. The main conversation loop runs in `src/QueryEngine.ts` through `QueryEngine.submitMessage()`.
4. The API layer in `src/services/api/claude.ts` builds Anthropic-shaped messages and request parameters.
5. `src/services/api/client.ts` creates an Anthropic SDK client with a provider-specific `fetch` implementation.
6. For OpenAI/Codex, `src/services/api/codex-fetch-adapter.ts` provides `createCodexFetch()`, which intercepts Anthropic `/v1/messages` requests.
7. `translateToCodexBody()` converts the Anthropic-shaped request into the Codex Responses API payload.
8. Codex streaming events are converted back into Anthropic-style stream events by `processCodexEvents()`, `translateCodexStreamToAnthropic()`, or `translateCodexWsStreamToAnthropic()`.
9. `queryModelWithoutStreaming()` can consume that stream and return a final assistant message for a single-call style result.
10. `QueryEngine.submitMessage()` consumes the app-level response, updates usage, and extracts the final text for CLI output.

The shortest reusable path for one standalone Codex/GPT request is:

```text
src/services/api/claude.ts:queryModelWithoutStreaming()
  -> src/services/api/client.ts:getAnthropicClient()
  -> src/services/api/codex-fetch-adapter.ts:createCodexFetch()
  -> src/services/api/codex-fetch-adapter.ts:translateToCodexBody()
  -> Codex backend
  -> src/services/api/codex-fetch-adapter.ts:processCodexEvents()
  -> Anthropic-style AssistantMessage
```

For a lower-level extraction, skip `queryModelWithoutStreaming()` and call the adapter/client path directly, but then the caller must provide valid Anthropic-shaped request data, auth tokens, model, effort, and error handling.

## Implemented extraction

The first reusable Codex core module is implemented under `src/codex-core/`:

- `src/codex-core/index.ts` exports the public API.
- `src/codex-core/client.ts` exports `runCodexLLM()`.
- `src/codex-core/accounts.ts` resolves one explicit account/profile by alias or account ID prefix.
- `src/codex-core/request.ts` normalizes core messages, builds the backend request payload, and validates message sequences.
- `src/codex-core/response.ts` consumes the Anthropic-style SSE stream returned by the existing Codex adapter and extracts final text, usage, stop reason, and raw stream events.
- `src/codex-core/errors.ts` exposes `CodexCoreError` with clear `auth`, `quota`, `rate_limit`, `model`, `backend`, `account_not_found`, and `invalid_request` codes.
- `src/codex-core/types.ts` defines the request/result/usage types.
- `scripts/test-codex-core.ts` provides the single-turn smoke script.
- `scripts/test-codex-core-conversation.ts` provides the two-turn continuation smoke script:

```sh
pnpm tsx scripts/test-codex-core-conversation.ts \
  --account my-profile \
  --model some-model \
  --reasoning-effort medium
```

The implementation intentionally reuses `src/services/api/codex-fetch-adapter.ts:createCodexFetch()` and its existing request/event translation. It does not import the TUI, agent loop, file tools, shell tools, workspace mutation logic, or planning logic.

The standalone core path is deliberately pure: `runCodexLLM()` sends only the caller-provided `systemPrompt` plus the caller's own `input` or `messages`. It does not include cat-code's normal agent/system prompts.

The multi-account behavior is explicit-only. The caller must provide `accountProfile`; the resolver matches an alias or account ID prefix and uses that account only. It does not call account rotation or retry/failover logic. If the selected account is missing, capped, expired, rate-limited, unauthorized, or rejected by the backend, the call returns a `CodexCoreError` instead of silently switching accounts.

## Focused map: multi-turn, continuation, and caching

This map focuses on the continuation and cache path that the first extraction did not fully cover.

1. Conversation history is stored as `Message[]` in `src/types/message.ts`, and the per-turn loop in `src/QueryEngine.ts:QueryEngine.submitMessage()` appends to that array across turns.
2. The main app converts conversation history in `src/services/api/claude.ts:normalizeMessagesForAPI()`, `userMessageToMessageParam()`, and `assistantMessageToMessageParam()`.
3. The Codex adapter converts those Anthropic-shaped messages into Responses API input items in `src/services/api/codex-fetch-adapter.ts:translateMessages()` and `translateToCodexBody()`.
4. Assistant text is replayed as plain text response items. Assistant `thinking.signature` blocks are replayed as Codex `reasoning.encrypted_content` items in `src/services/api/codex-fetch-adapter.ts:translateMessages()`.
5. `previous_response_id` is used in `src/services/api/codex-websocket-transport.ts:streamTurnViaWebSocket()`. The websocket session stores `lastResponseId` and reuses it on the next incremental turn when the request signature matches.
6. Encrypted reasoning is stored and replayed through `thinking.signature` in `src/services/api/claude.ts:assistantMessageToMessageParam()` and `src/services/api/codex-fetch-adapter.ts:translateMessages()`. The websocket transport also preserves reasoning items in `session.lastResponseOutputItems`.
7. Encrypted reasoning replay is required for exact Codex cache continuity on the websocket path. Without it, the server-side prefix no longer matches what it saw on the prior turn.
8. Prompt-cache usage is parsed after the response in `src/services/api/codex-fetch-adapter.ts` from `response.completed` / `input_tokens_details.cached_tokens`, and the core extractor now also parses `cache_read_input_tokens` in `src/codex-core/response.ts`.
9. Cached-token counts are shown and summarized in `src/services/api/codex-fetch-adapter.ts:getCodexCacheStats()` and `src/commands/cache-stats/cache-stats.ts`.
10. Cache behavior is controlled by request-time fields such as `prompt_cache_key`, `reasoning`, `include=['reasoning.encrypted_content']`, and `previous_response_id` on the websocket path. The counts themselves are still only reported after the response arrives.
11. Reusable pieces for `codex-core` are the explicit account resolver, request builder, response parser, and usage/cache normalization. Pieces that are still too coupled to extract now are the prompt-cache break detector, websocket incremental continuation logic, and the full agent loop.

## Multi-turn conversation and caching support

### 1. Message format

`src/codex-core/types.ts` now exposes a simple public message type:

- `CodexCoreMessage`
  - `role: 'system' | 'developer' | 'user' | 'assistant'`
  - `content: string`

`src/codex-core/request.ts:normalizeCodexCoreMessages()` validates these messages, preserves order, rejects empty content, and rejects invalid message sequences.

### 2. How messages are converted to backend request format

`src/codex-core/request.ts:buildCodexCoreRequest()` converts the public messages into the backend payload used by `src/services/api/codex-fetch-adapter.ts:translateToCodexBody()`.

Mapping rules:

- `systemPrompt` and `role: 'system'` messages become the backend instruction prefix.
- `role: 'developer'` messages become the backend developer context.
- `role: 'user'` and `role: 'assistant'` messages become normal conversation history items.
- Assistant text is replayed as plain text. The extracted core does not invent hidden reasoning state.

The merge into instruction fields is required because the backend payload has a separate `instructions` field and a separate developer-context slot rather than an arbitrary list of prefix messages.

### 3. How to continue a conversation

`src/codex-core/client.ts:runCodexLLM()` now accepts an optional `conversationId` and returns the same `conversationId` on the result. The caller can continue by reusing:

- `result.conversationId`
- `result.messagesForNextTurn`

If a `systemPrompt` was supplied, it is carried forward in `messagesForNextTurn` as the first system message so the caller can replay the same prefix on the next turn without reconstructing it manually.

The smoke script in `scripts/test-codex-core-conversation.ts` demonstrates the two-turn pattern.

### 4. Whether plain text messages are enough

For the extracted core, plain text messages are enough for the supported text-only continuation path. The core does **not** extract websocket-only `previous_response_id`, `responseItems`, or encrypted reasoning replay state yet.

That state still exists in the repo's Codex websocket transport and is used for exact continuation and cache matching there.

### 5. What cache metadata is exposed

`src/codex-core/response.ts` now exposes:

- `usage.inputTokens`
- `usage.outputTokens`
- `usage.cachedInputTokens`
- `usage.cacheCreationInputTokens`
- `cache.hit`
- `cache.cachedInputTokens`
- `cache.cacheCreationInputTokens`

The cache result is conservative:

- `hit` is only set when cached input tokens are actually reported.
- No cache numbers are invented.
- No cache-control request fields are added by the core.

### 6. What cache behavior is intentionally not implemented

The extracted core does **not** implement:

- automatic account rotation
- prompt-cache break detection
- websocket prewarm logic
- retry/failover policy
- encrypted reasoning replay as a public core field
- `previous_response_id` management outside the existing transport path

Those pieces remain coupled to `src/services/api/codex-websocket-transport.ts`, `src/services/api/promptCacheBreakDetection.ts`, and the broader agent loop.

### 7. Risks and open questions

- The websocket transport still owns exact continuation state, including `previous_response_id` and reasoning replay. The extracted core only returns stable message history plus a conversation ID.
- Text-only replay is sufficient for the current extracted flow, but it is not yet a full mirror of the repo's continuation semantics.
- The cache metadata exposed here comes from response usage only. It is useful for reporting, but it does not expose the transport's internal cache-break classification.
- Tool-heavy conversations and reasoning-heavy conversations may need a later extraction step if the core is expected to round-trip hidden state exactly.

### 8. TODO boundary for the extracted core

Keep the extracted core focused on reusable request/result handling. Do **not** pull in the following yet:

- websocket session management
- `previous_response_id` chaining
- encrypted reasoning replay as a core API contract
- cache break detection and prompt-cache diagnostics
- transport-specific retry/failover policy

Those pieces are real, but they belong to the existing transport layer until we decide to extract exact Codex continuation parity.

## Exact files and functions involved

### 1. CLI entrypoint

| File | Names | What it does | Reusable for standalone LLM call? |
| --- | --- | --- | --- |
| `src/entrypoints/cli.tsx` | `main()` | Lightweight process bootstrap and flag routing before loading the full CLI. | No. Bootstrap only. |
| `src/main.tsx` | `main()` | Full CLI app entrypoint. Wires commands, REPL, provider/session startup, and app state. | No. Too coupled to the terminal app. |

### 2. Main agent loop

| File | Names | What it does | Reusable for standalone LLM call? |
| --- | --- | --- | --- |
| `src/QueryEngine.ts` | `QueryEngine`, `QueryEngine.submitMessage()` | Owns the per-conversation loop, message accumulation, streamed assistant output, usage tracking, and final result assembly. | Partially. Useful for full app behavior, but too stateful for a minimal single request. |
| `src/utils/handlePromptSubmit.ts` | `handlePromptSubmit()`, `executeUserInput()` | Handles user input, slash commands, tool gating, and dispatch into the query loop. | No. UI/input orchestration. |
| `src/screens/REPL.tsx` | component submit callback | Collects terminal input and hands it to `handlePromptSubmit()`. | No. TUI layer. |

### 3. Codex/GPT backend client

| File | Names | What it does | Reusable for standalone LLM call? |
| --- | --- | --- | --- |
| `src/services/api/client.ts` | `getAnthropicClient()`, `buildFetch()`, `resolveCodexOAuthTokensForLeaseOwner()`, `createStderrLogger()` | Constructs the Anthropic SDK client. For OpenAI/Codex, injects the Codex fetch adapter and resolves the right account/lease token. | Yes. Best reusable client entrypoint. |
| `src/services/api/codex-fetch-adapter.ts` | `createCodexFetch()` | Intercepts Anthropic SDK `/v1/messages` calls and reroutes them to the Codex backend. | Yes. Core backend adapter. |
| `src/services/api/codex-fetch-adapter.ts` | `CODEX_BASE_URL`, `CODEX_MODELS`, `DEFAULT_CODEX_MODEL` | Defines Codex endpoint and model mapping constants. | Yes. Supporting configuration. |

### 4. Auth, account, and profile handling

| File | Names | What it does | Reusable for standalone LLM call? |
| --- | --- | --- | --- |
| `src/services/oauth/codex-client.ts` | `CodexTokens`, `extractCodexAccountId()`, `buildCodexAuthUrl()`, `exchangeCodexCode()`, `refreshCodexToken()`, `startCodexCallbackServer()`, `runCodexOAuthFlow()` | Implements OpenAI/Codex PKCE login, token exchange, token refresh, callback server, and account ID extraction. | Partially. Needed for login/bootstrap, not needed if a token is already available. |
| `src/components/ConsoleOAuthFlow.tsx` | `persistCodexLogin()`, `startCodexOAuth()` | UI wrapper around Codex login that persists tokens, appends accounts to the pool, and asks for aliases. | No. UI-specific. |
| `src/utils/auth.ts` | `getCodexOAuthTokens()`, `saveCodexOAuthTokens()`, `clearCodexOAuthTokens()`, `hasCodexTokens()`, `isCodexSubscriber()`, `getAccountInformation()`, `getOauthAccountInfo()`, `checkAndRefreshOAuthTokenIfNeeded()`, `handleOAuth401Error()` | Central auth state and account metadata for Claude and Codex. Returns Codex account info when OpenAI is the active provider. | Yes for token lookup and refresh. Avoid UI-facing parts for a minimal call. |
| `src/services/api/codexAccountPool.ts` | `PoolAccount`, `initAccountPool()`, `isPoolActive()`, `hasAnyPoolAccount()`, `getActiveAccount()`, `setActiveAccount()`, `selectAccountForTurn()`, `rotateOnFailure()`, `appendAccount()`, `getPoolStatus()`, `getPoolAccountsForLeaseSelection()`, `markPoolAccountCapped()`, `markPoolAccountLastError()`, `touchPoolAccountUsage()`, `switchToAccount()`, `markAccountDead()`, `saveCodexTokenToVault()`, `setAccountAlias()`, `removeCodexAccount()`, `updateAccountUsageHints()`, `getPoolAccountUsageScore()` | Multi-account Codex pool, active-account selection, aliasing, vault/config merging, account health, usage hints, and persistence. | Partially. Reuse for multi-account behavior; skip for a single fixed token. |
| `src/services/api/codexAccountLeaseManager.ts` | `CodexLease`, `CodexLeaseSnapshot`, `registerCodexLease()`, `getCurrentCodexLease()`, `getCodexLeaseForOwner()`, `runWithCodexLeaseOwner()`, `failoverCodexLease()`, `reassignCodexLeaseToActiveAccount()`, `releaseCodexLease()`, `getCodexLeaseSnapshot()` | Pins callers/subagents to a Codex account and supports failover. | Partially. Useful for pooled or multi-agent calls, not the minimal standalone path. |
| `src/services/api/codexTokenRefresh.ts` | `refreshAccountTokens()`, `touchAll()`, `startPeriodicRefresh()`, `stopPeriodicRefresh()` | Refreshes stored Codex account tokens and marks dead accounts. | Partially. Useful for long-running processes. |
| `src/services/oauth/types.ts` | `OAuthTokens`, `OAuthProfileResponse`, `OAuthTokenExchangeResponse`, `UserRolesResponse` | Shared OAuth/profile/account response types. | Yes as supporting types. |
| `src/commands/accounts/accounts.ts` | `call()` | `/accounts` command for displaying Claude and Codex accounts, leases, and usage. | No. Command/UI. |
| `src/commands/switch-account/switch-account.ts` | `call()`, `performCodexSwitch()`, `performClaudeSwitch()` | `/switch-account` command. Switches active accounts and reassigns Codex leases. | Partially. Useful for account-pool operations, not one call. |
| `src/commands/delete-account/delete-account.ts` | `call()`, `applyPostDeleteAccountStateRefresh()` | Deletes accounts and refreshes auth-sensitive app state. | No for a minimal call. |
| `src/commands/rename-account/rename-account.ts` | `call()` | Renames account aliases. | No. |

### 5. Model selection

| File | Names | What it does | Reusable for standalone LLM call? |
| --- | --- | --- | --- |
| `src/utils/model/model.ts` | `getUserSpecifiedModelSetting()`, `getMainLoopModel()`, `getDefaultMainLoopModelSetting()`, `getDefaultMainLoopModel()`, `parseUserSpecifiedModel()`, `renderModelSetting()`, `getClaudeAiUserDefaultModelDescription()`, `modelDisplayString()` | Resolves model choice from session override, CLI flag, environment variable, settings, and provider/subscription defaults. For Codex subscribers, the default main-loop model resolves to `gpt-5.5`. | Yes if standalone behavior should match cat-code model resolution. |
| `src/services/api/codex-fetch-adapter.ts` | `mapClaudeModelToCodex()`, `isCodexModel()`, `CODEX_MODELS` | Maps Claude-style model names to Codex/GPT model identifiers and detects Codex models. | Yes. Core provider mapping. |

### 6. Reasoning effort selection

| File | Names | What it does | Reusable for standalone LLM call? |
| --- | --- | --- | --- |
| `src/utils/effort.ts` | `resolveAppliedEffort()`, `getDefaultEffortForModel()`, `getEffortEnvOverride()`, `getDisplayedEffortLevel()`, `modelSupportsEffort()`, `modelSupportsMaxEffort()`, `convertEffortValueToLevel()` | Resolves the effective effort level from env overrides, model defaults, and model support. Handles `max` fallback where unsupported. | Yes. Reuse for parity with current Codex calls. |
| `src/commands/effort/effort.tsx` | `executeEffort()`, `setEffortValue()`, `showCurrentEffort()` | User-facing `/effort` command. | No. Command/UI only. |
| `src/services/api/codex-fetch-adapter.ts` | `mapEffortToCodex()`, `getReasoningSummaryDetail()` | Converts cat-code/Claude-style effort to Codex `reasoning.effort` and reasoning summary settings. | Yes. Core request payload logic. |

### 7. Request payload construction

| File | Names | What it does | Reusable for standalone LLM call? |
| --- | --- | --- | --- |
| `src/services/api/codex-fetch-adapter.ts` | `translateToCodexBody()`, `translateMessages()`, `translateTools()`, `translateToolResultOutput()`, `mapClaudeModelToCodex()`, `mapEffortToCodex()` | Converts Anthropic request shape into Codex Responses API JSON. Handles messages, tools, tool results, developer context, reasoning, JSON schema output, `prompt_cache_key`, `store: false`, and `stream: true`. | Yes. This is the direct Codex request builder. |
| `src/services/api/claude.ts` | `queryModel()`, `normalizeMessagesForAPI()`, `userMessageToMessageParam()`, `assistantMessageToMessageParam()`, `buildSystemPromptBlocks()` | Builds Anthropic-compatible message params from cat-code internal messages and context before provider dispatch. | Partially. Reuse if the standalone caller uses cat-code message structures; otherwise extract a smaller prompt builder. |

### 8. Streaming and event handling

| File | Names | What it does | Reusable for standalone LLM call? |
| --- | --- | --- | --- |
| `src/services/api/codex-fetch-adapter.ts` | `httpSseToEvents()`, `processCodexEvents()`, `buildAnthropicStreamResponse()`, `translateCodexStreamToAnthropic()`, `translateCodexWsStreamToAnthropic()` | Converts Codex HTTP SSE or WebSocket events into Anthropic-style stream events for text, tool calls, reasoning, usage, and stop events. | Yes if streaming or Anthropic-compatible consumption is needed. |
| `src/services/api/codex-websocket-transport.ts` | `streamTurnViaWebSocketLocked()`, `schedulePrewarm()`, `clearWebSocketSession()`, `registerStaleResponseIdCallback()`, `registerSendPathLogger()`, `CodexWebSocketUsageLimitError`, `CodexWebSocketIdleTimeoutError`, `CodexWebSocketClosedBeforeCompletedError` | WebSocket transport, session prewarm, stale response handling, and transport-specific errors. | Maybe later. Useful for performance/current parity, but not required for the first non-streaming extraction. |

### 9. Final text extraction

| File | Names | What it does | Reusable for standalone LLM call? |
| --- | --- | --- | --- |
| `src/services/api/claude.ts` | `queryModelWithoutStreaming()` | Consumes model streaming internally and returns a final `AssistantMessage`. | Yes. Best existing wrapper for a single final answer. |
| `src/services/api/claude.ts` | `queryModelWithStreaming()` | Streams model events to callers while producing assistant output. | Yes for streaming use cases. |
| `src/QueryEngine.ts` | `QueryEngine.submitMessage()` | Extracts final assistant text from the last assistant message and returns app-level result data. | Partially. Shows app behavior but is coupled to sessions and loop state. |

### 10. Usage and token extraction

| File | Names | What it does | Reusable for standalone LLM call? |
| --- | --- | --- | --- |
| `src/services/api/codex-fetch-adapter.ts` | `processCodexEvents()` `response.completed` handling, `finishStream()` | Extracts Codex usage from completed responses, converts it to Anthropic-style usage, and emits final stream usage events. | Yes. Core usage bridge. |
| `src/services/api/codex-fetch-adapter.ts` | `getCodexCacheStats()`, `recordCacheStat()` | Tracks prompt-cache/routing statistics. | Maybe later. Useful for observability, not required for minimal call. |
| `src/services/api/claude.ts` | `updateUsage()`, `accumulateUsage()` | Aggregates token usage across streamed Anthropic messages. | Yes if using the `claude.ts` wrapper. |
| `src/QueryEngine.ts` | `currentMessageUsage`, `totalUsage`, usage updates in `submitMessage()` | Maintains per-turn and total usage in the app loop. | No. App state. |

### 11. Error, rate-limit, and auth failure handling

| File | Names | What it does | Reusable for standalone LLM call? |
| --- | --- | --- | --- |
| `src/services/api/codex-fetch-adapter.ts` | `CodexAccountCapError`, `normalizeCodexStreamError()`, `normalizeInitialWebSocketError()`, `isRecoverableCodexStreamError()`, `createPartialStreamReplaySkippedError()` | Classifies Codex cap, idle-timeout, WebSocket close-before-complete, partial replay, and generic stream/transport failures. | Yes. Core Codex error normalization. |
| `src/services/api/codex-fetch-adapter.ts` | HTTP 401/429 handling inside `createCodexFetch()` | Converts account-cap/rate-limit/auth-like failures into pool-aware errors when possible, otherwise returns JSON API errors. | Yes. |
| `src/services/api/withRetry.ts` | `withRetry()`, `CannotRetryError`, `FallbackTriggeredError` | Generic retry wrapper. Handles auth refresh on 401/403, Codex pool failover on `CodexAccountCapError`, and capacity/auth fallback behavior. | Yes if matching app retry semantics is desired. |
| `src/services/api/errors.ts` | `getAssistantMessageFromError()`, `classifyAPIError()`, `categorizeRetryableAPIError()` | Converts API and transport failures into user-facing assistant errors and analytics categories, including rate-limit/auth cases. | Partially. Useful for UI-facing normalization. |

### 12. Claude-specific compatibility layer

| File | Names | What it does | Reusable for standalone LLM call? |
| --- | --- | --- | --- |
| `src/services/api/claude.ts` | `queryModel()`, `queryModelWithoutStreaming()`, `queryModelWithStreaming()`, `userMessageToMessageParam()`, `assistantMessageToMessageParam()`, `normalizeMessagesForAPI()`, `buildSystemPromptBlocks()`, `getRetryOwnerId()`, `getCodexConversationIdOverride()` | Main compatibility layer between cat-code internal messages and Anthropic SDK calls. Also selects provider behavior and preserves Codex conversation context where needed. | Yes if using cat-code's app contract. Extract carefully if a smaller neutral LLM API is desired. |
| `src/services/api/claude.ts` | `getPreviousRequestIdFromMessages()`, `stripExcessMediaItems()`, `ensureToolResultPairing()` | Repairs/respects Anthropic message-history requirements for resumed conversations, media limits, and tool-result pairing. | Maybe later. Mostly compatibility and resilience logic. |
| `src/services/api/claude.ts` | `getErrorMessageIfRefusal()` | Converts refusal stops into user-facing errors. | Partially. Useful if preserving current behavior. |

## Minimal call path for one standalone request

For the first extraction, the minimal path should avoid the terminal UI and agent loop. The likely target shape is:

1. Resolve credentials:
   - single-account path: `src/utils/auth.ts:getCodexOAuthTokens()` and `checkAndRefreshOAuthTokenIfNeeded()`.
   - multi-account path: `src/services/api/codexAccountPool.ts:getActiveAccount()` or `selectAccountForTurn()`, with lease support from `src/services/api/codexAccountLeaseManager.ts` if concurrent callers matter.
2. Resolve model:
   - `src/utils/model/model.ts:getMainLoopModel()` or a simpler caller-provided model.
   - `src/services/api/codex-fetch-adapter.ts:mapClaudeModelToCodex()` for provider mapping.
3. Resolve reasoning effort:
   - `src/utils/effort.ts:resolveAppliedEffort()`.
   - `src/services/api/codex-fetch-adapter.ts:mapEffortToCodex()`.
4. Build request:
   - Anthropic-shaped convenience path: `src/services/api/claude.ts:queryModelWithoutStreaming()`.
   - lower-level path: construct Anthropic-style request params and use `src/services/api/codex-fetch-adapter.ts:translateToCodexBody()`.
5. Send request:
   - `src/services/api/client.ts:getAnthropicClient()` with `createCodexFetch()` installed.
6. Parse response:
   - final-answer path: `queryModelWithoutStreaming()` returns an `AssistantMessage`.
   - streaming path: `processCodexEvents()` converts Codex events to Anthropic-style events.
7. Extract usage:
   - `processCodexEvents()` and `finishStream()` bridge Codex usage to Anthropic usage.
   - `src/services/api/claude.ts:updateUsage()` and `accumulateUsage()` aggregate usage when using the wrapper.
8. Normalize errors:
   - Codex-specific: `normalizeCodexStreamError()`, `CodexAccountCapError`, HTTP 401/429 handling in `createCodexFetch()`.
   - retry/failover: `src/services/api/withRetry.ts:withRetry()`.
   - user-facing mapping: `src/services/api/errors.ts`.

## Parts to extract

### A. Likely reusable

- Auth/profile selection:
  - `src/utils/auth.ts`
  - relevant token/account types from `src/services/oauth/types.ts`
  - optional login bootstrap from `src/services/oauth/codex-client.ts`
- Multi-account support, if needed:
  - `src/services/api/codexAccountPool.ts`
  - `src/services/api/codexAccountLeaseManager.ts`
  - `src/services/api/codexTokenRefresh.ts`
- Model config:
  - `src/utils/model/model.ts`
  - `CODEX_MODELS`, `DEFAULT_CODEX_MODEL`, `mapClaudeModelToCodex()` in `src/services/api/codex-fetch-adapter.ts`
- Reasoning effort config:
  - `src/utils/effort.ts`
  - `mapEffortToCodex()` and `getReasoningSummaryDetail()` in `src/services/api/codex-fetch-adapter.ts`
- Request builder:
  - `translateToCodexBody()` and its helpers in `src/services/api/codex-fetch-adapter.ts`
- Backend client:
  - `getAnthropicClient()` and `buildFetch()` in `src/services/api/client.ts`
  - `createCodexFetch()` in `src/services/api/codex-fetch-adapter.ts`
- Response parser:
  - `processCodexEvents()` and stream translation helpers in `src/services/api/codex-fetch-adapter.ts`
  - `queryModelWithoutStreaming()` in `src/services/api/claude.ts` for final-answer consumption
- Usage parser:
  - `processCodexEvents()` `response.completed` handling
  - `updateUsage()` and `accumulateUsage()` in `src/services/api/claude.ts`
- Error normalization:
  - Codex stream/error helpers in `src/services/api/codex-fetch-adapter.ts`
  - `withRetry()` in `src/services/api/withRetry.ts`
  - `classifyAPIError()` and `categorizeRetryableAPIError()` in `src/services/api/errors.ts`

### B. Probably not reusable

- TUI and terminal input:
  - `src/screens/REPL.tsx`
  - terminal UI state managed around prompt submission
- Autonomous agent loop:
  - `src/QueryEngine.ts` for the minimal call path
  - `src/utils/handlePromptSubmit.ts`
- File editing tools, shell execution tools, and workspace mutation logic:
  - tool orchestration should stay out of a standalone LLM call primitive
- Planning and slash-command logic:
  - command files under `src/commands/**`, except as references for account/effort behavior
- UI wrappers around auth/account flows:
  - `src/components/ConsoleOAuthFlow.tsx`
  - account display/rename/delete command UI

### C. Maybe later

- Streaming support:
  - `processCodexEvents()`, `translateCodexStreamToAnthropic()`, `translateCodexWsStreamToAnthropic()`
- WebSocket transport and prewarm:
  - `src/services/api/codex-websocket-transport.ts`
- Session persistence and resumed conversation compatibility:
  - compatibility helpers in `src/services/api/claude.ts`
- Encrypted reasoning replay:
  - include only after the single-call path is stable and the exact replay contract is verified
- Prompt-cache tracking:
  - `getCodexCacheStats()`, `recordCacheStat()`
- Retry logic:
  - `withRetry()` is valuable, but it brings account failover, auth refresh, and app policy. Extract after deciding whether the standalone caller wants those semantics.

## Risks and open questions

- The current Codex implementation deliberately masquerades as an Anthropic client path. This is convenient for reuse inside cat-code, but a standalone call primitive may be cleaner if it exposes provider-neutral inputs and keeps Anthropic compatibility as an adapter.
- `queryModelWithoutStreaming()` is the easiest single-call wrapper, but it may pull in more app context than a true minimal LLM primitive needs.
- `translateToCodexBody()` is the key extraction point, but it assumes Anthropic-shaped messages and tool definitions. A neutral request type may need a smaller translator.
- Multi-account pool and lease behavior is useful for cat-code, subagents, and failover, but it is not required for a single-token standalone call.
- Retry and fallback behavior may hide policy decisions. Decide whether the extracted primitive should perform retries automatically or return normalized errors to the caller.
- WebSocket streaming appears to be a performance/parity feature, not a prerequisite for the first standalone non-streaming request.
- Usage extraction is split between Codex event translation and Anthropic-style aggregation. A standalone API should define its own normalized usage shape rather than leaking provider-specific fields.
- Auth refresh is reusable, but login UI is not. Separate token acquisition, token storage, token refresh, and account selection before extraction.
