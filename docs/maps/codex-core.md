# Codex Core Map

Last refreshed: 2026-07-05

## Purpose

Daily-refreshable routing map for Codex-backed model and account behavior in Cat
Code. Use this to choose the first files to inspect before changing Codex
request building, account selection, lease/pool routing, response parsing,
continuation, failure handling, or structured account diagnostics. Verify
behavior in source before editing; older Codex docs in `docs/codex/` are useful
incident history, not the live source of truth.

## First Files To Inspect

Read in this order for most Codex/OpenAI work:

| Order | File | Why first |
|---|---|---|
| 1 | [`WORKSPACE_MAP.md`](WORKSPACE_MAP.md) | Current map index and adjacent domain maps. |
| 2 | [`../reference/2026-04-30-codex-core-extraction-map.md`](../reference/2026-04-30-codex-core-extraction-map.md) | Extraction-oriented background for the minimal Codex core path. |
| 3 | [`../../src/codex-core/client.ts`](../../src/codex-core/client.ts) | Smallest standalone Codex request path. |
| 4 | [`../../src/codex-core/request.ts`](../../src/codex-core/request.ts) | Core request normalization and instruction assembly. |
| 5 | [`../../src/codex-core/accounts.ts`](../../src/codex-core/accounts.ts) | Explicit account/profile resolution and refresh-on-use behavior. |
| 6 | [`../../src/codex-core/response.ts`](../../src/codex-core/response.ts) | SSE parsing, final text extraction, usage, and cache metadata. |
| 7 | [`../../src/services/api/client.ts`](../../src/services/api/client.ts) | Provider routing and lease-aware Codex token lookup. |
| 8 | [`../../src/services/api/claude.ts`](../../src/services/api/claude.ts) | Main app request assembly and Anthropic-shaped message normalization. |
| 9 | [`../../src/services/api/codex-fetch-adapter.ts`](../../src/services/api/codex-fetch-adapter.ts) | Anthropic-to-Codex request translation and stream/error bridge. |
| 10 | [`../../src/services/api/codex-websocket-transport.ts`](../../src/services/api/codex-websocket-transport.ts) | Incremental continuation, `previous_response_id`, prewarm, and stale-session handling. |
| 11 | [`../../src/services/api/codexAccountPool.ts`](../../src/services/api/codexAccountPool.ts) | Global account inventory, health, active account, and usage hints. |
| 12 | [`../../src/services/api/codexAccountLeaseManager.ts`](../../src/services/api/codexAccountLeaseManager.ts) | Per-owner account pinning and lease-local failover. |
| 13 | [`../../src/services/api/withRetry.ts`](../../src/services/api/withRetry.ts) | Retry policy and Codex failover on cap/connection/auth errors. |
| 14 | [`../../src/services/api/accountDiagnostics.ts`](../../src/services/api/accountDiagnostics.ts) | Structured `cat_code_account_diagnostic` emission and cross-process sanitization. |

## Codex Routing By Goal

| Goal | Owner | Fallback order | Notes |
|---|---|---|---|
| Run one standalone Codex call | `src/codex-core/client.ts` | `src/codex-core/request.ts`, `src/codex-core/accounts.ts`, `src/codex-core/response.ts`, `src/services/api/codex-fetch-adapter.ts` | `runCodexLLM()` is the smallest supported path. It requires explicit `accountProfile` and currently supports `stream: false` only. |
| Change minimal core request shape | `src/codex-core/request.ts` | `src/codex-core/types.ts`, `src/codex-core/request.test.ts`, `src/services/api/codex-fetch-adapter.ts` | Core messages are plain `system`/`developer`/`user`/`assistant` strings and become `_openaiInstructionAssembly`. |
| Change app-level Codex request assembly | `src/services/api/claude.ts` | `src/services/api/instructionAssembly.ts`, `src/utils/messages.ts`, `src/query.ts`, `src/QueryEngine.ts` | The main app path normalizes transcript messages first, then hands Anthropic-shaped params to the Codex adapter. |
| Change Anthropic-to-Codex body translation | `src/services/api/codex-fetch-adapter.ts` | `src/services/api/codex-fetch-adapter.test.ts`, `src/services/api/codex-continuation-e2e.test.ts` | `translateToCodexBody()` owns model mapping, tool translation, developer-context placement, reasoning, JSON output, and cache-related request fields. |
| Change Codex account resolution for explicit profile use | `src/codex-core/accounts.ts` | `src/services/api/codexAccountPool.ts`, `src/utils/auth.ts`, `src/services/oauth/codex-client.ts` | Core account selection is explicit-only: alias or account ID prefix, no silent rotation. |
| Change pooled account selection for app traffic | `src/services/api/codexAccountPool.ts` | `src/services/api/codexUsage.ts`, `src/services/api/codexTokenRefresh.ts`, `src/query.ts` | Pool state owns health, derived switchability, active account, normalized block reasons, LRU/usage-aware selection, and persistent active-account choice. Hard-429 cap timestamps and usage-fetch timestamps prevent lagging usage polls from immediately undoing a cap. |
| Change subagent/main-thread account pinning | `src/services/api/codexAccountLeaseManager.ts` | `src/services/api/client.ts`, `src/services/api/withRetry.ts`, `src/tasks/LocalAgentTask/`, `src/tools/AgentTool/` | Lease manager pins owners to accounts and isolates failover by owner instead of mutating one shared route. |
| Change retry or failover policy | `src/services/api/withRetry.ts` | `src/services/api/codexAccountLeaseManager.ts`, `src/services/api/codexAccountPool.ts`, `src/services/api/codex-fetch-adapter.ts` | Cap errors and repeated connection errors are handled here, not in the core request builder. |
| Change Codex transport continuation | `src/services/api/codex-websocket-transport.ts` | `src/services/api/codex-continuation-e2e.test.ts`, `src/services/api/codex-fetch-adapter.ts`, `src/utils/messages.ts` | This owns `previous_response_id`, canonical delta checks, prewarm, and stale response-id fallback. |
| Change final text/usage parsing for standalone core | `src/codex-core/response.ts` | `src/services/api/codex-fetch-adapter.ts`, `src/codex-core/errors.ts` | Core parses Anthropic-style SSE events returned by the adapter and extracts text, stop reason, usage, and cache metadata. |
| Change token refresh and vault persistence | `src/services/api/codexTokenRefresh.ts` | `src/services/api/codexAccountPool.ts`, `src/services/oauth/codex-client.ts`, `src/utils/auth.ts` | Refresh is a vault-state machine with file locking and ownership checks. It can reset safe offline failures to idle, mark ambiguous or fatal outcomes for reauth, preserve capped state, or save a new profile on identity mismatch. |
| Change usage-reset redemption | `src/components/Settings/Reset.tsx`, `src/components/Settings/redeemResetMachine.ts` | `src/services/api/codexUsage.ts`, `src/services/api/codexAccountPool.ts` | The Reset tab owns preflight/fetch/consume side effects; the React-free machine owns account eligibility, default targeting, request-id lifetime, usage-window display data, and outcome mapping. Confirmed redemption heals the pool and guards briefly against stale usage hints. |

## Runtime Flow

```text
App path
src/query.ts / src/QueryEngine.ts
  -> src/services/api/claude.ts
  -> src/services/api/client.ts:getAnthropicClient()
  -> src/services/api/codex-fetch-adapter.ts:createCodexFetch()
  -> src/services/api/codex-fetch-adapter.ts:translateToCodexBody()
  -> src/services/api/codex-websocket-transport.ts (when WS path is used)
  -> src/services/api/codex-fetch-adapter.ts:processCodexEvents()

Standalone core path
src/codex-core/client.ts:runCodexLLM()
  -> src/codex-core/accounts.ts
  -> src/codex-core/request.ts
  -> src/services/api/codex-fetch-adapter.ts:createCodexFetch()
  -> src/codex-core/response.ts
```

## Routing By Concern

| Concern | Inspect first | Then inspect | Notes |
|---|---|---|---|
| Model mapping and provider-native request body | `src/services/api/codex-fetch-adapter.ts` | `src/utils/model/providers.ts`, `src/utils/model/model.ts`, `src/utils/effort.ts` | `mapClaudeModelToCodex()` and `mapEffortToCodex()` are the durable owner functions. |
| Codex core message validation | `src/codex-core/request.ts` | `src/codex-core/request.test.ts` | Rejects empty content, mixed `input`+`messages`, and conversation history that does not start with a user message. |
| Developer vs instruction prefix placement | `src/codex-core/request.ts` | `src/services/api/claude.ts`, `src/services/api/codex-fetch-adapter.ts` | Core and app paths both separate stable instructions from conversation messages before translation. |
| Pool activation and active-account fallback | `src/services/api/codexAccountPool.ts` | `src/services/api/client.ts`, `src/services/api/codexUsage.ts` | `getActiveAccount()` can repair an invalid active account by finding another healthy one. `getCodexAccountAvailability()` owns normalized dead/capped reasons and treats an elapsed primary-window reset as routable even while a cached usage hint remains fresh. |
| Usage-reset availability and consumption | `src/services/api/codexUsage.ts` | `src/components/Settings/Reset.tsx`, `src/components/Settings/redeemResetMachine.ts`, `src/services/api/codexAccountPool.ts` | Usage fetches provide reset credits and current primary/secondary window percentages. Redemption retries reuse one idempotency key; only confirmed reset outcomes call `applyRedeemedUsageReset()` to heal pool state. |
| Lease-aware token selection | `src/services/api/client.ts` | `src/services/api/codexAccountLeaseManager.ts`, `src/services/api/codexAccountPool.ts` | `resolveCodexOAuthTokensForLeaseOwner()` is the bridge between pool/lease state and API client creation. |
| Per-owner failover | `src/services/api/withRetry.ts` | `src/services/api/codexAccountLeaseManager.ts` | Leased owners fail over locally; unleased main-thread requests fall back to pool switching. |
| Structured account diagnostics | `src/services/api/accountDiagnostics.ts` | `src/entrypoints/sdk/coreSchemas.ts`, `src/services/api/client.ts`, `src/services/api/withRetry.ts` | Downstream remediation only requires `version`, `code`, `severity`, `provider`, and `recoverable`; optional fields are sanitized hints. |
| WebSocket incremental continuation | `src/services/api/codex-websocket-transport.ts` | `src/services/api/codex-continuation-e2e.test.ts`, `src/utils/messages.ts` | `responseItemsEqual()` and `getIncrementalInputDelta()` are the strict continuation gates. |
| HTTP fallback / stream normalization | `src/services/api/codex-fetch-adapter.ts` | `src/services/api/codex-fetch-adapter.test.ts` | Adapter owns stream translation for both HTTP SSE and websocket-backed event flows. |
| Initial stream liveness and aborts | `src/services/api/codex-fetch-adapter.ts` | `src/services/api/codex-fetch-adapter.test.ts`, `src/services/api/codex-websocket-transport.ts` | `primeCodexEvents()` waits for visible output or completion before releasing the stream, uses `CLAUDE_STREAM_IDLE_TIMEOUT_MS` for initial-output and idle timeouts, and cancels HTTP readers on abort. HTTP requests forward the caller `RequestInit.signal`. |
| Standalone response parsing | `src/codex-core/response.ts` | `src/codex-core/errors.ts` | Core classifies 401/403 as auth, 429 as quota or rate-limit, 400/model text as model, else backend. |
| Long-running token freshness | `src/services/api/codexTokenRefresh.ts` | `src/services/api/codexAccountPool.ts`, `src/services/oauth/codex-client.ts` | Refresh-on-timer and refresh-on-use are separate paths. Check the persisted vault `refresh` state, transport classifier, and ownership guards before changing account health rules. |


## Failure Paths And Diagnostic Codes

| Path | Inspect first | Then inspect | Result |
|---|---|---|---|
| Usage cap / hard 429 | `src/services/api/withRetry.ts` | `src/services/api/codexAccountLeaseManager.ts`, `src/services/api/codexAccountPool.ts`, `src/services/api/codex-fetch-adapter.ts` | `CodexAccountCapError` is the only path that marks the failed account capped. Successful rotation emits `account.failover.succeeded`; terminal exhaustion becomes `quota.exhausted` only when every remaining account is capped. |
| Refresh/auth failure / 401 | `src/services/api/withRetry.ts` | `src/services/api/codexTokenRefresh.ts`, `src/services/api/codexAccountPool.ts`, `src/services/api/client.ts` | `CodexAccountAuthError` tries vault refresh first, then marks the account dead, emits `account.token_refresh.failed`, and ends as `account.pool.unavailable` or `auth.missing` only if no healthy replacement remains. Stored raw refresh-state codes such as `http_401` should be normalized before they reach users. |
| Transient transport / websocket rejection | `src/services/api/withRetry.ts` | `src/services/api/codex-websocket-transport.ts`, `src/services/api/codexAccountLeaseManager.ts` | Repeated `APIConnectionError` emits `account.transient_failure`, does not mark the failed account capped, and can still emit `account.failover.succeeded` when another healthy account exists. |
| Pool unavailable before send | `src/services/api/client.ts` | `src/services/api/codexAccountPool.ts`, `src/services/api/accountDiagnostics.ts` | `resolveCodexOAuthTokensForLeaseOwner()` refuses raw config fallback when the pool is active. `getAnthropicClient()` emits `auth.missing` when no Codex account exists, `account.pool.unavailable` when accounts exist but none are healthy, and `quota.exhausted` only when all known accounts are capped. |

## Tests And Scripts

Use the closest test first:

| Area | Entry point |
|---|---|
| Minimal core request builder | `bun test src/codex-core/request.test.ts` |
| Core account resolution and refresh | `bun test src/codex-core/accounts.test.ts` |
| Standalone core smoke | `bun run scripts/test-codex-core.ts --account <alias> --model <model> --prompt "hello"` |
| Standalone two-turn continuation smoke | `pnpm tsx scripts/test-codex-core-conversation.ts --account <alias> --model <model>` |
| Adapter translation and transport fallback | `bun test src/services/api/codex-fetch-adapter.test.ts` |
| Websocket transport behavior | `bun test src/services/api/codex-websocket-transport.test.ts` |
| End-to-end continuation canonicalization | `bun test src/services/api/codex-continuation-e2e.test.ts` |
| Pool behavior and vault/profile handling | `bun test src/services/api/codexAccountPool.test.ts` |
| Lease selection and lease-local failover | `bun test src/services/api/codexAccountLeaseManager.test.ts` |
| Token refresh identity handling | `bun test src/services/api/codexTokenRefresh.test.ts` |
| Full documented build | `bun run build:dev:full` |

## Common Failure Routes

| Symptom | Inspect in this order | Why |
|---|---|---|
| `No healthy Codex account is available for this request` or apparent “all accounts exhausted” | `src/services/api/client.ts` -> `src/services/api/codexAccountLeaseManager.ts` -> `src/services/api/codexAccountPool.ts` -> `src/services/api/withRetry.ts` | Check the emitted diagnostic first: `auth.missing` means no configured account, `account.pool.unavailable` means accounts exist but none are healthy, and `quota.exhausted` means every known account is capped. |
| Repeated cap rotation or false account exhaustion | `src/services/api/withRetry.ts` -> `src/services/api/codexAccountLeaseManager.ts` -> `src/services/api/codexAccountPool.ts` -> `docs/codex/2026-05-12-bug-codex-pool-false-cap-on-claude-oauth-failure.md` | Distinguish real `CodexAccountCapError` paths from `CodexAccountAuthError` refresh/dead-account handling and `account.transient_failure` connection failover. |
| Slow turns or full re-sends instead of incremental continuation | `src/services/api/codex-websocket-transport.ts` -> `src/services/api/codex-continuation-e2e.test.ts` -> `src/utils/messages.ts` -> `docs/codex/2026-04-30-bug-websocket-continuation-prefix-instability-and-context-bloat.md` | Continuation breaks when rebuilt input no longer matches strict canonical prefix expectations. |
| Cache hit drops or unexpected uncached input | `src/services/api/codex-fetch-adapter.ts` -> `src/services/api/codex-websocket-transport.ts` -> `src/codex-core/response.ts` -> `docs/codex/2026-04-30-cache-context-truncation.md` | Request fields, message growth, and continuation mode all affect cache continuity; counts are only known after response parsing. |
| Standalone `runCodexLLM()` fails before sending | `src/codex-core/client.ts` -> `src/codex-core/request.ts` -> `src/codex-core/accounts.ts` | Core validates options aggressively and does not auto-recover via pool rotation. |
| Refresh changed account identity or profile alias drift | `src/services/api/codexTokenRefresh.ts` -> `src/services/api/codexAccountPool.ts` -> `src/codex-core/accounts.ts` | Refresh can intentionally save a new vault profile and leave the old one dead rather than rewriting aliases across identities. |

## Traps And Stale Assumptions

- Do not assume all Codex requests go through `src/codex-core/`. The main app still routes through `src/services/api/claude.ts` and the adapter.
- Do not assume the pool and lease manager are interchangeable. The pool owns inventory and health; the lease manager owns runtime pinning and owner-local failover.
- Do not assume `conversationId` alone guarantees websocket continuation. Incremental reuse still depends on exact request-signature and canonical-prefix checks in `codex-websocket-transport.ts`.
- Do not assume connection errors mean usage caps. `withRetry.ts` now has a separate connection-error failover path that should not mark accounts capped.
- Do not collapse every account failure into `quota.exhausted`. Refresh/auth failures and transient transport failures now have their own diagnostic codes and should stay distinct from hard cap rotation.
- Do not assume the standalone core has feature parity with the app path. `runCodexLLM()` is explicit-account, text-only, and non-streaming.
- Do not assume cache numbers exist before response completion. Cache hit/miss data is parsed from completed response usage, not predicted at request time.
- Do not treat old incident docs under `docs/codex/` as current behavior without checking the source and tests above. They are useful failure history, especially for continuation and pool bugs, but some fixes have already landed.
