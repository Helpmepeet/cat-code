# Codex Core Map

Last refreshed: 2026-07-13

## Purpose

Daily-refreshable routing map for Codex-backed model and account behavior in Cat
Code. Use this to choose the first files to inspect before changing Codex
request building, account selection, lease/pool routing, response parsing,
continuation, failure handling, or structured account diagnostics. Verify
behavior in source before editing; older Codex docs in `docs/codex/` are useful
incident history, not the live source of truth. Extraction-oriented background
for the minimal core path lives in
[`../reference/2026-04-30-codex-core-extraction-map.md`](../reference/2026-04-30-codex-core-extraction-map.md).

## First Files To Inspect

Read in this order for most Codex/OpenAI work:

| Order | File | Why first |
|---|---|---|
| 1 | [`WORKSPACE_MAP.md`](WORKSPACE_MAP.md) | Current map index and adjacent domain maps. |
| 2 | [`../../src/codex-core/client.ts`](../../src/codex-core/client.ts) | Smallest standalone Codex request path; `request.ts` and `response.ts` alongside it own core request shaping and SSE/usage parsing. |
| 3 | [`../../src/codex-core/accounts.ts`](../../src/codex-core/accounts.ts) | Explicit account/profile resolution and the exported `maybeRefreshAccount()` refresh-on-use entry point. |
| 4 | [`../../src/services/api/client.ts`](../../src/services/api/client.ts) | Provider routing and async lease-aware Codex token lookup. |
| 5 | [`../../src/services/api/codex-fetch-adapter.ts`](../../src/services/api/codex-fetch-adapter.ts) | Codex model catalog, Anthropic-to-Codex request translation, effort mapping, per-request token resolver callback, and stream/error bridge. |
| 6 | [`../../src/services/api/codexAccountPool.ts`](../../src/services/api/codexAccountPool.ts) | Global account inventory, credential authority, health, active account, and usage hints. |
| 7 | [`../../src/services/api/withRetry.ts`](../../src/services/api/withRetry.ts) | Retry policy and Codex failover on cap/connection/auth errors. |

The goal, concern, and failure tables below route the remaining surfaces
(app request assembly, websocket continuation, lease manager, status
observation, structured diagnostics, image-generation auth).

## Codex Routing By Goal

| Goal | Owner | Fallback order | Notes |
|---|---|---|---|
| Run one standalone Codex call | `src/codex-core/client.ts` | `src/codex-core/request.ts`, `src/codex-core/accounts.ts`, `src/codex-core/response.ts`, `src/services/api/codex-fetch-adapter.ts` | `runCodexLLM()` is the smallest supported path. It requires explicit `accountProfile` and currently supports `stream: false` only. |
| Change minimal core request shape | `src/codex-core/request.ts` | `src/codex-core/types.ts`, `src/codex-core/request.test.ts`, `src/services/api/codex-fetch-adapter.ts` | Core messages are plain `system`/`developer`/`user`/`assistant` strings and become `_openaiInstructionAssembly`. |
| Change app-level Codex request assembly | `src/services/api/claude.ts` | `src/services/api/instructionAssembly.ts`, `src/utils/messages.ts`, `src/query.ts`, `src/QueryEngine.ts` | The main app path normalizes transcript messages first, then hands Anthropic-shaped params to the Codex adapter. |
| Change Anthropic-to-Codex body translation | `src/services/api/codex-fetch-adapter.ts` | `src/services/api/codex-fetch-adapter.test.ts`, `src/services/api/codex-continuation-e2e.test.ts` | `translateToCodexBody()` owns model mapping, tool translation, developer-context placement, reasoning, JSON output, and cache-related request fields. |
| Change Codex model catalog, picker, or display wiring | `src/services/api/codex-fetch-adapter.ts`, `src/utils/model/configs.ts`, `src/utils/model/modelOptions.ts` | `src/utils/model/model.ts`, `src/utils/context.ts`, `src/utils/effort.ts`, `src/utils/fastMode.ts`, `src/utils/model/gpt56LunaLabel.test.ts` | New GPT/Codex models need catalog entries, config keys, picker options, canonical/display names, context-window budgeting, effort defaults/support, and any Fast Mode eligibility updated together. Defaults can intentionally lag preview access. |
| Change Codex account resolution for explicit profile use | `src/codex-core/accounts.ts` | `src/services/api/codexAccountPool.ts`, `src/utils/auth.ts`, `src/services/oauth/codex-client.ts` | Core account selection is explicit-only: alias or account ID prefix, no silent rotation. `maybeRefreshAccount()` is the shared refresh-on-use entry point for callers; it preserves the vault state machine when a vault file exists and the raw refresh-with-ledger path for config/no-vault accounts. |
| Change pooled account selection for app traffic | `src/services/api/codexAccountPool.ts` | `src/services/api/client.ts`, `src/services/api/codexUsage.ts`, `src/codex-core/accounts.ts`, `src/query.ts` | Pool state owns credential authority, health/classification, refresh recovery inputs, active account, normalized block reasons, LRU/usage-aware selection, and persistent active-account choice even for a single account. `poolManagesCredentials()` gates credential authority; `canFailover()` gates rotation; `isPoolActive()` is only the legacy failover alias. Hard-429, usage-poll, and reset-redemption quota observations are reconciled so lagging usage polls do not immediately undo newer cap/reset evidence. |
| Change subagent/main-thread account pinning | `src/services/api/codexAccountLeaseManager.ts` | `src/services/api/client.ts`, `src/services/api/withRetry.ts`, `src/tasks/LocalAgentTask/`, `src/tools/AgentTool/` | Lease manager pins owners to accounts and isolates failover by owner instead of mutating one shared route. |
| Change retry or failover policy | `src/services/api/withRetry.ts` | `src/services/api/codexAccountLeaseManager.ts`, `src/services/api/codexAccountPool.ts`, `src/services/api/codex-fetch-adapter.ts` | Cap errors and repeated connection errors are handled here, not in the core request builder. Rotation decisions use `canFailover()`; credential/classification decisions use `poolManagesCredentials()`. |
| Change Codex transport continuation | `src/services/api/codex-websocket-transport.ts` | `src/services/api/codex-continuation-e2e.test.ts`, `src/services/api/codex-fetch-adapter.ts`, `src/utils/messages.ts` | This owns `previous_response_id`, canonical delta checks, prewarm, and stale response-id fallback. |
| Change final text/usage parsing for standalone core | `src/codex-core/response.ts` | `src/services/api/codex-fetch-adapter.ts`, `src/codex-core/errors.ts` | Core parses Anthropic-style SSE events returned by the adapter and extracts text, stop reason, usage, and cache metadata. |
| Change token refresh and vault persistence | `src/codex-core/accounts.ts:maybeRefreshAccount()` | `src/services/api/codexTokenRefresh.ts`, `src/services/api/codexAccountPool.ts`, `src/services/oauth/codex-client.ts`, `src/utils/auth.ts` | Callers should enter through `maybeRefreshAccount()`. Vault-backed refresh is a state machine with file locking and ownership checks; raw/no-vault refresh stays behind the cross-process ledger and config/vault persistence path. It can reset safe offline failures to idle, mark ambiguous or fatal outcomes for reauth, preserve capped state, or save a new profile on identity mismatch. |
| Change usage-reset availability and consumption | `src/components/Settings/Reset.tsx`, `src/components/Settings/redeemResetMachine.ts` | `src/services/api/codexUsage.ts`, `src/codex-core/accounts.ts`, `src/services/api/codexAccountPool.ts` | The Reset tab owns preflight/fetch/consume side effects; the React-free machine owns account eligibility, default targeting, request-id lifetime, usage-window display data, and outcome mapping. Confirmed redemption calls `applyRedeemedUsageReset()` to heal pool state and guards briefly against stale usage hints. |
| Change read-only Codex pool status JSON | `src/cli/handlers/codexStatus.ts`, `src/services/api/codexStatus.ts` | `src/main.tsx`, `src/services/api/codexAccountPool.ts`, `src/services/api/codexUsage.ts`, `src/services/api/codexStatus.test.ts` | `cat-code codex status --json` emits one advisory observation. `--refresh never` is read-only with no network; default `--refresh auto` may call cached, refresh-free usage fetches with `updateRoutingHints: false`. Keep the output opaque and non-reservational. |
| Continue after a confirmed Codex usage limit | `src/services/deferredContinuation.ts`, `src/services/deferredContinuationRunner.ts` | `src/services/deferredContinuationPresentation.ts`, `src/services/api/codexStatus.ts`, `src/services/api/withRetry.ts`, `src/services/api/errors.ts`, `src/commands/continue-after-limit/`, `src/hooks/useDeferredContinuation.ts`, `src/main.tsx` | Scheduling requires the typed terminal Codex quota envelope plus fresh post-cap status evidence. The delayed turn is a fixed new reconciliation message, never a replay. Queue durability, job→session locks, crash ambiguity, permission non-escalation, and bounded retry policy remain in the shared runner. |
| Change image-generation Codex auth | `src/tools/GenerateImageTool/GenerateImageTool.ts` | `src/services/api/client.ts`, `src/codex-core/accounts.ts`, `src/services/api/codexAccountPool.ts`, `src/tools/GenerateImageTool/GenerateImageTool.test.ts` | Image auth uses `resolveCodexOAuthTokensForLeaseOwner()` so main/subagent requests share lease-aware selection and `maybeRefreshAccount()` refresh recovery. Image endpoint 401/429 pool-state reporting remains deferred; do not add ad-hoc refresh or raw config token writes in the tool. |

## Runtime Flow

```text
App path
src/query.ts / src/QueryEngine.ts
  -> src/services/api/claude.ts
  -> src/services/api/client.ts:getAnthropicClient()
  -> src/services/api/client.ts:resolveCodexOAuthTokensForLeaseOwner()
     -> src/codex-core/accounts.ts:maybeRefreshAccount()
  -> src/services/api/codex-fetch-adapter.ts:createCodexFetch(resolveTokensForRequest)
  -> src/services/api/codex-fetch-adapter.ts:translateToCodexBody()
  -> src/services/api/codex-websocket-transport.ts (when WS path is used)
  -> src/services/api/codex-fetch-adapter.ts:processCodexEvents()

Standalone core path
src/codex-core/client.ts:runCodexLLM()
  -> src/codex-core/accounts.ts:resolveCodexCoreAccount()/maybeRefreshAccount()
  -> src/codex-core/request.ts
  -> src/services/api/codex-fetch-adapter.ts:createCodexFetch()
  -> src/codex-core/response.ts
```

## Routing By Concern

| Concern | Inspect first | Then inspect | Notes |
|---|---|---|---|
| Model mapping and provider-native request body | `src/services/api/codex-fetch-adapter.ts` | `src/utils/model/providers.ts`, `src/utils/model/model.ts`, `src/utils/model/configs.ts`, `src/utils/model/modelOptions.ts`, `src/utils/context.ts`, `src/utils/effort.ts` | `CODEX_MODELS`, `mapClaudeModelToCodex()`, and `mapEffortToCodex()` are durable adapter owners. Model launch wiring also spans config keys, picker entries, canonical/display names, context windows, and default/support effort. |
| Codex core message validation | `src/codex-core/request.ts` | `src/codex-core/request.test.ts` | Rejects empty content, mixed `input`+`messages`, and conversation history that does not start with a user message. |
| Developer vs instruction prefix placement | `src/codex-core/request.ts` | `src/services/api/claude.ts`, `src/services/api/codex-fetch-adapter.ts` | Core and app paths both separate stable instructions from conversation messages before translation. |
| Standalone core explicit account selection | `src/codex-core/accounts.ts:resolveCodexCoreAccount()` | `src/services/api/codexAccountPool.ts:describeCodexAccountAvailability()` | Resolves a caller-named profile explicitly; throws typed errors for `quarantined` (503), `capped` (429), and `dead` (401), while a healthy account proceeds even when a fresh usage hint would mark it `blocked`. Deliberate asymmetry with pool routing — see the explicit-selection trap below before changing it. |
| Pool credential authority and failover predicates | `src/services/api/codexAccountPool.ts` | `src/services/api/client.ts`, `src/services/api/withRetry.ts`, `src/services/api/codexUsage.ts` | `poolManagesCredentials()` is true for initialized inventory with one or more accounts and means the pool is authoritative for tokens/classification. `canFailover()` is true only when at least two selectable accounts can rotate. `isPoolActive()` remains exported as a legacy failover alias and should not be used for credential routing. `getActiveAccount()` can repair an invalid active account by finding another selectable one. |
| Usage-reset availability and consumption | `src/services/api/codexUsage.ts` | `src/components/Settings/Reset.tsx`, `src/components/Settings/redeemResetMachine.ts`, `src/services/api/codexAccountPool.ts` | Usage fetches provide reset credits and current primary/secondary window percentages. Redemption retries reuse one idempotency key; only confirmed reset outcomes call `applyRedeemedUsageReset()` to heal pool state. |
| GPT-5.6 Sol/Terra/Luna reasoning support | `src/utils/effort.ts`, `src/services/api/codex-fetch-adapter.ts` | `src/services/api/codex-fetch-adapter.test.ts`, `src/utils/model/gpt56LunaLabel.test.ts` | Sol and Terra support `low` through `ultra`; Luna supports `low` through `max`. Codex `xhigh` is labeled “Extra high,” supported levels pass through unchanged, and disabled thinking/minimal requests map to `none`. |
| Lease-aware token selection | `src/services/api/client.ts` | `src/services/api/codexAccountLeaseManager.ts`, `src/services/api/codexAccountPool.ts`, `src/codex-core/accounts.ts` | `resolveCodexOAuthTokensForLeaseOwner()` is async and pool-authoritative. It prefers subagent lease, main lease, repaired lease, active account, then any selectable pool account; it calls `maybeRefreshAccount()` before returning tokens. `createCodexFetch()` receives a resolver callback so each request re-derives tokens with the same lease/selectability/refresh semantics. |
| Per-owner failover | `src/services/api/withRetry.ts` | `src/services/api/codexAccountLeaseManager.ts` | Leased owners fail over locally; unleased main-thread requests fall back to pool switching. |
| Structured account diagnostics | `src/services/api/accountDiagnostics.ts` | `src/entrypoints/sdk/coreSchemas.ts`, `src/services/api/client.ts`, `src/services/api/withRetry.ts` | Downstream remediation only requires `version`, `code`, `severity`, `provider`, and `recoverable`; optional fields are sanitized hints. |
| WebSocket incremental continuation | `src/services/api/codex-websocket-transport.ts` | `src/services/api/codex-continuation-e2e.test.ts`, `src/utils/messages.ts` | `responseItemsEqual()` and `getIncrementalInputDelta()` are the strict continuation gates. |
| HTTP fallback / stream normalization | `src/services/api/codex-fetch-adapter.ts` | `src/services/api/codex-fetch-adapter.test.ts` | Adapter owns stream translation for both HTTP SSE and websocket-backed event flows. |
| Initial stream liveness and aborts | `src/services/api/codex-fetch-adapter.ts` | `src/services/api/codex-fetch-adapter.test.ts`, `src/services/api/codex-websocket-transport.ts` | `primeCodexEvents()` waits for visible output or completion before releasing the stream, uses `CLAUDE_STREAM_IDLE_TIMEOUT_MS` for initial-output and idle timeouts, and cancels HTTP readers on abort. HTTP requests forward the caller `RequestInit.signal`. |
| Standalone response parsing | `src/codex-core/response.ts` | `src/codex-core/errors.ts` | Core classifies 401/403 as auth, 429 as quota or rate-limit, 400/model text as model, else backend. |
| Long-running token freshness | `src/codex-core/accounts.ts`, `src/services/api/codexTokenRefresh.ts` | `src/services/api/codexAccountPool.ts`, `src/services/oauth/codex-client.ts` | Refresh-on-use goes through `maybeRefreshAccount()`. Timer/startup refresh lives in `codexTokenRefresh.ts:touchAll()` and skips accounts outside the shared refresh skew. Startup touch-all is skipped for non-interactive print sessions; periodic refresh and quarantine probes still start for vault accounts. Check the persisted vault `refresh` state, transport classifier, and ownership guards before changing account health rules. |
| Config-token mirror demotion | `src/services/api/codexAccountPool.ts` | `src/utils/auth.ts`, `src/components/ConsoleOAuthFlow.tsx` | Login still writes the legacy `codexOAuth` config mirror for compatibility, but pool merge ignores that mirror when any vault profile exists. If no vault profile exists, the config account becomes pool inventory and is still governed by `poolManagesCredentials()`. |
| Cap/quarantine/dead state is per-process by design | `src/services/api/codexAccountPool.ts`, `src/services/api/withRetry.ts` | `src/services/api/codexTokenRefresh.ts` | Only refresh state is shared cross-process (vault `refresh` block plus the raw-refresh ledger); quota caps, quarantine, and dead-marks are in-memory per process by design — see the per-process cap-state trap below. |
| Codex account display vocabulary | `src/commands/accounts/accounts.ts`, `src/components/LogoV2/AccountsPanel.tsx` | `src/services/api/codexAccountPool.ts:describeCodexAccountAvailability()`, `src/services/api/codexUsage.ts` | Current Codex UI uses shared availability labels such as `Ready`, `Limit reached`, `Connection issue (retrying)`, and `Needs re-login`, plus lease-first active-account display. Avoid resurrecting old bracket tags such as `[capped]`, `[quarantined]`, or raw `unavailable` status text in Codex account UI. |
| Read-only external status observations | `src/services/api/codexStatus.ts` | `src/cli/handlers/codexStatus.ts`, `src/services/api/codexAccountPool.ts`, `src/services/api/codexUsage.ts` | Status observations deliberately differ from request routing: they do not refresh credentials, rotate accounts, persist active choices, mutate routing hints, or reserve capacity. Profile refs are opaque hashes, and `cap_state_shared_with_next_process` is always false. |

## Failure Paths And Diagnostic Codes

| Path | Inspect first | Then inspect | Result |
|---|---|---|---|
| Usage cap / hard 429 | `src/services/api/withRetry.ts` | `src/services/api/codexAccountLeaseManager.ts`, `src/services/api/codexAccountPool.ts`, `src/services/api/codex-fetch-adapter.ts` | `CodexAccountCapError` is the only path that marks the failed account capped. Successful rotation emits `account.failover.succeeded`; terminal exhaustion becomes `quota.exhausted` only when every remaining account is capped. |
| Refresh/auth failure / 401 | `src/services/api/withRetry.ts` | `src/codex-core/accounts.ts`, `src/services/api/codexTokenRefresh.ts`, `src/services/api/codexAccountPool.ts`, `src/services/api/client.ts` | `CodexAccountAuthError` tries `maybeRefreshAccount()` first, then marks the account dead, emits `account.token_refresh.failed`, and ends as `account.pool.unavailable` or `auth.missing` only if no healthy replacement remains. Stored raw refresh-state codes such as `http_401` should be normalized before they reach users. |
| Transient transport / websocket rejection | `src/services/api/withRetry.ts` | `src/services/api/codex-websocket-transport.ts`, `src/services/api/codexAccountLeaseManager.ts` | Repeated `APIConnectionError` emits `account.transient_failure`, does not mark the failed account capped, and can still emit `account.failover.succeeded` when another healthy account exists. |
| Pool unavailable before send | `src/services/api/client.ts` | `src/services/api/codexAccountPool.ts`, `src/services/api/accountDiagnostics.ts` | `resolveCodexOAuthTokensForLeaseOwner()` refuses raw config fallback when `poolManagesCredentials()` is true, including single-account pool inventory. `getAnthropicClient()` emits `auth.missing` when no Codex account exists, `account.pool.unavailable` when accounts exist but none are healthy, and `quota.exhausted` only when all known accounts are capped. |
| Image-generation Codex auth failure | `src/tools/GenerateImageTool/GenerateImageTool.ts` | `src/services/api/client.ts`, `src/codex-core/accounts.ts` | Image requests share the async resolver/refresh route. The image endpoint still does not mark 401/429 into pool state; that reporting is intentionally deferred to the shared API retry/failover path. |

## Tests And Validation

Use the closest test first:

| Area | Entry point |
|---|---|
| Minimal core request builder | `bun test src/codex-core/request.test.ts` |
| Core account resolution and refresh | `bun test src/codex-core/accounts.test.ts` |
| Standalone core smoke | `bun run scripts/test-codex-core.ts --account <alias> --model <model> --prompt "hello"` |
| Standalone two-turn continuation smoke | `pnpm tsx scripts/test-codex-core-conversation.ts --account <alias> --model <model>` |
| Adapter translation and transport fallback | `bun test src/services/api/codex-fetch-adapter.test.ts` |
| Model catalog/display/context/effort wiring | `bun test src/utils/model/gpt56LunaLabel.test.ts src/utils/model/agent.test.ts src/utils/fastMode.test.ts src/services/api/codex-fetch-adapter.test.ts` |
| Websocket transport behavior | `bun test src/services/api/codex-websocket-transport.test.ts` |
| End-to-end continuation canonicalization | `bun test src/services/api/codex-continuation-e2e.test.ts` |
| Pool behavior, credential authority, config mirror demotion, and startup touch-all gating | `bun test src/services/api/codexAccountPool.test.ts` |
| Lease selection and lease-local failover | `bun test src/services/api/codexAccountLeaseManager.test.ts` |
| Token refresh identity handling | `bun test src/services/api/codexTokenRefresh.test.ts` |
| Image-generation Codex auth resolver/refresh | `bun test src/tools/GenerateImageTool/GenerateImageTool.test.ts` |
| Structured diagnostics and SDK/app validation | `bun test src/services/api/accountDiagnostics.test.ts src/entrypoints/sdk/accountDiagnosticsSchema.test.ts src/app-runtime/sessionEvents.test.ts` |
| Read-only Codex status observation | `bun test src/services/api/codexStatus.test.ts` |
| Deferred continuation eligibility, terminal evidence, durability, UX, runner, context restoration, process races, and background shape | `bun test src/services/api/deferredTerminalFailure.test.ts src/services/deferredContinuation.test.ts src/services/deferredContinuationRunner.test.ts src/services/deferredContinuationLaunchAgent.test.ts src/services/deferredContinuation.probe.test.ts src/commands/continue-after-limit/continue-after-limit.test.ts src/utils/sessionRestore.deferred.test.ts` |
| Full documented build | `bun run build:dev:full` |

## Common Failure Routes

| Symptom | Inspect in this order | Why |
|---|---|---|
| `No healthy Codex account is available for this request` or apparent “all accounts exhausted” | `src/services/api/client.ts` -> `src/services/api/codexAccountLeaseManager.ts` -> `src/services/api/codexAccountPool.ts` -> `src/services/api/withRetry.ts` | Check the emitted diagnostic first: `auth.missing` means no configured account, `account.pool.unavailable` means accounts exist but none are healthy, and `quota.exhausted` means every known account is capped. Single-account pool inventory still blocks stale config fallback. |
| Repeated cap rotation or false account exhaustion | `src/services/api/withRetry.ts` -> `src/services/api/codexAccountLeaseManager.ts` -> `src/services/api/codexAccountPool.ts` -> `docs/codex/2026-05-12-bug-codex-pool-false-cap-on-claude-oauth-failure.md` | Distinguish real `CodexAccountCapError` paths from `CodexAccountAuthError` refresh/dead-account handling and `account.transient_failure` connection failover. |
| Slow turns or full re-sends instead of incremental continuation | `src/services/api/codex-websocket-transport.ts` -> `src/services/api/codex-continuation-e2e.test.ts` -> `src/utils/messages.ts` -> `docs/codex/2026-04-30-bug-websocket-continuation-prefix-instability-and-context-bloat.md` | Continuation breaks when rebuilt input no longer matches strict canonical prefix expectations. |
| Cache hit drops or unexpected uncached input | `src/services/api/codex-fetch-adapter.ts` -> `src/services/api/codex-websocket-transport.ts` -> `src/codex-core/response.ts` -> `docs/codex/2026-04-30-cache-context-truncation.md` | Request fields, message growth, and continuation mode all affect cache continuity; counts are only known after response parsing. |
| Standalone `runCodexLLM()` fails before sending | `src/codex-core/client.ts` -> `src/codex-core/request.ts` -> `src/codex-core/accounts.ts` | Core validates options aggressively and does not auto-recover via pool rotation. |
| Refresh changed account identity or profile alias drift | `src/codex-core/accounts.ts` -> `src/services/api/codexTokenRefresh.ts` -> `src/services/api/codexAccountPool.ts` | Refresh can intentionally save a new vault profile and leave the old one dead rather than rewriting aliases across identities. |
| Image generation uses the wrong Codex account or stale token | `src/tools/GenerateImageTool/GenerateImageTool.ts` -> `src/services/api/client.ts` -> `src/services/api/codexAccountLeaseManager.ts` -> `src/codex-core/accounts.ts` | Image generation should use the same lease-aware async resolver as app requests, including refresh-on-use. |

## Traps And Stale Assumptions

- Do not assume all Codex requests go through `src/codex-core/`. The main app still routes through `src/services/api/claude.ts` and the adapter.
- Do not assume the pool and lease manager are interchangeable. The pool owns inventory, credential authority, and health; the lease manager owns runtime pinning and owner-local failover.
- Do not use `isPoolActive()` to decide credential routing or whether single-account pool inventory matters. Use `poolManagesCredentials()` for token/classification authority and `canFailover()` for rotation. `isPoolActive()` is a legacy failover alias.
- Do not assume Codex pool behavior requires more than one account. One account is enough for pool-managed credentials, classification, refresh recovery, and stale-config-fallback prevention.
- Do not "align" standalone explicit account selection with pool availability gating. `resolveCodexCoreAccount()` intentionally lets a healthy explicitly-named account proceed even when a fresh usage hint would mark it `blocked` ("explicit selection, let reality decide"): availability is consulted only for the reason strings on the `quarantined`/`capped`/`dead` throw branches, and a real 429/401 reclassifies the account instead of pre-emptively refusing on a possibly-stale hint. Pool routing (`resolveCodexOAuthTokensForLeaseOwner()`/`getCodexAccountAvailability()`) deliberately differs and does defer to the availability reducer; keep the asymmetry unless the explicit-selection contract itself changes.
- Do not add cross-process persistence for quota caps, quarantine, or dead-marks without revisiting the F5 reconciler's authority/lag precedence. Only refresh state is shared across processes; the rest lives in the in-memory pool, so two concurrent processes can briefly disagree about the same account until each rediscovers its state from live traffic. This is a deliberate decision, not a gap.
- Do not assume `conversationId` alone guarantees websocket continuation. Incremental reuse still depends on exact request-signature and canonical-prefix checks in `codex-websocket-transport.ts`.
- Do not assume connection errors mean usage caps. `withRetry.ts` has a separate connection-error failover path that should not mark accounts capped.
- Do not collapse every account failure into `quota.exhausted`. Refresh/auth failures and transient transport failures have their own diagnostic codes and should stay distinct from hard cap rotation.
- Do not assume the standalone core has feature parity with the app path. `runCodexLLM()` is explicit-account, text-only, and non-streaming.
- Do not add separate Codex image-token refresh logic. `GenerateImageTool` should keep using `resolveCodexOAuthTokensForLeaseOwner()` / `maybeRefreshAccount()`.
- Do not assume cache numbers exist before response completion. Cache hit/miss data is parsed from completed response usage, not predicted at request time.
- Do not treat old incident docs under `docs/codex/` as current behavior without checking the source and tests above. They are useful failure history, especially for continuation and pool bugs, but some fixes have already landed.
- Do not treat `cat-code codex status --json` as a reservation or authoritative retry path. It is a standalone advisory snapshot for external scheduling; `withRetry.ts`, the pool, and the lease manager remain authoritative once a real request starts.
- Do not turn `/continue-after-limit` into generic retry or transcript replay. It is Codex-only, requires durable typed quota evidence, adds one fixed reconciliation turn, and stops rather than guessing after ambiguous provider/tool execution.
