# Query Provider Runtime Map

Last refreshed: 2026-08-30

## Purpose

Daily-refreshable routing map for provider-neutral turn execution in Cat Code.
Use this before changing model/provider selection, query-loop behavior, context
assembly, provider instruction placement, retry/compaction recovery, API client
routing, or model validation.

This map is a routing document, not the source of truth. Verify live behavior in
the source files below before editing. For prompt wording and prompt precedence,
use [`prompt-system.md`](prompt-system.md). For Codex/OpenAI adapter, account,
lease, websocket, and response parsing details, use
[`codex-core.md`](codex-core.md).

## First Files To Inspect

Read in this order for most provider-neutral query work:

| Order | File | Why first |
|---|---|---|
| 1 | [`../../src/QueryEngine.ts`](../../src/QueryEngine.ts) | SDK/headless turn owner: input processing, prompt/context refresh, model switches, transcript writes, and query invocation. |
| 2 | [`../../src/screens/REPL.tsx`](../../src/screens/REPL.tsx) | Interactive turn owner; computes the same runtime model before prompt construction and query launch. |
| 3 | [`../../src/query.ts`](../../src/query.ts) | Main query state machine: compaction gates, runtime model, instruction assembly, calls, and retries. |
| 4 | [`../../src/utils/queryContext.ts`](../../src/utils/queryContext.ts) | Shared fetcher for prompt parts, user/system context, and cache-safe side-question params. |
| 5 | [`../../src/utils/systemPrompt.ts`](../../src/utils/systemPrompt.ts) | Effective system-prompt branch selection after context fetch. |
| 6 | [`../../src/services/api/instructionAssembly.ts`](../../src/services/api/instructionAssembly.ts) | Provider-neutral placement of prompt/context/messages for OpenAI vs Claude-style providers. |
| 7 | [`../../src/utils/model/model.ts`](../../src/utils/model/model.ts) | Defaults, runtime plan-mode adjustment, aliases, display, and API normalization. |

## Runtime Flow

```text
src/QueryEngine.ts
  receives a user/SDK turn
  resolves initial model/provider and thinking defaults
  fetches prompt/context parts through src/utils/queryContext.ts
  builds effective system prompt through src/utils/systemPrompt.ts
  processes user input and slash-command side effects
  refreshes prompt/context if model/provider changed
  calls src/query.ts

src/query.ts
  projects messages after compact boundaries
  applies tool-result budget, snip, microcompact, context-collapse, autocompact
  resolves runtime model and request provider for this iteration
  builds provider instruction assembly
  calls deps.callModel, normally src/services/api/claude.ts:queryModelWithStreaming
  streams assistant output, executes tools, appends attachments, and loops

src/services/api/claude.ts
  normalizes messages and tool schemas
  adds API-time prefixes, betas, cache controls, thinking, effort, output_config
  wraps provider client creation and request execution in withRetry()
  streams provider events into Cat Code messages

src/services/api/client.ts
  resolves concrete Anthropic SDK-compatible client
  chooses first-party, Bedrock, Vertex, Foundry, or OpenAI adapter fetch
```

## Routing By Goal

| Goal | Inspect first | Then inspect | Notes |
|---|---|---|---|
| Change one-turn SDK/headless execution | `src/QueryEngine.ts` | `src/utils/queryContext.ts`, `src/query.ts` | `QueryEngine.submitMessage()` owns the outer turn lifecycle and is where prompt/context are initially built and refreshed after slash-command model changes. |
| Change the provider-neutral query loop | `src/query.ts` | `src/query/deps.ts`, `src/services/tools/toolOrchestration.ts`, `src/query/stopHooks.ts` | `queryLoop()` is the state machine. Tests can inject `QueryDeps` for `callModel`, `microcompact`, `autocompact`, and UUID generation. |
| Change context assembly | `src/context.ts` | `src/utils/queryContext.ts`, `src/utils/claudemd.ts`, `src/services/api/instructionAssembly.ts` | `getUserContext()` and `getSystemContext()` are memoized. `fetchSystemPromptParts()` decides when to skip default prompt/system context for custom prompts. |
| Change effective system prompt precedence | `src/utils/systemPrompt.ts` | `src/QueryEngine.ts`, `src/utils/queryContext.ts`, [`prompt-system.md`](prompt-system.md) | Branch order is override, Agent Mode, coordinator, main-thread agent, custom, default; `appendSystemPrompt` appends except under override. |
| Change provider instruction placement | `src/services/api/instructionAssembly.ts` | `src/query.ts`, `src/services/api/claude.ts`, [`prompt-system.md`](prompt-system.md) | OpenAI receives stable instructions and optional developer context. Claude-style providers receive system-context-appended prompts and user-context-prepended messages. |
| Change model selection defaults, aliases, or catalog options | `src/utils/model/model.ts` | `src/utils/model/modelStrings.ts`, `src/utils/model/aliases.ts`, `src/utils/model/configs.ts`, `src/utils/model/modelOptions.ts`, `src/utils/context.ts`, `src/utils/effort.ts` | Defaults depend on subscription/provider. `parseUserSpecifiedModel()` resolves aliases and `[1m]`; `normalizeModelStringForAPI()` strips context suffixes at API time. New model launches need config keys, picker entries, display/canonical names, context-window budgeting, and default effort checked together. |
| Change provider selection | `src/utils/model/providers.ts` | `src/QueryEngine.ts`, `src/query.ts`, `src/services/api/client.ts`, `app/sidecar/runControlsDomain.ts` | `getAPIProvider()` reads session provider, env, and startup preference. `resolveModelSelectionProvider()` handles interactive cross-provider selection; `resolveRequestProvider()` performs request-time GPT routing. |
| Change runtime model adjustment | `src/utils/model/model.ts` | `src/query.ts`, `src/screens/REPL.tsx`, `src/utils/context.ts` | `getRuntimeMainLoopModel()` adjusts plan-mode behavior before each API iteration and before REPL builds normal or background prompt sections. The request provider is resolved again after this runtime model is chosen. |
| Change API request shaping | `src/services/api/claude.ts` | `src/utils/api.ts`, `src/utils/messages.ts`, `src/services/api/instructionAssembly.ts` | Despite the filename, this is the shared Anthropic-SDK-shaped request path for all providers, including providers reached through adapters. |
| Change cheap secondary model calls | `src/utils/model/model.ts:getSmallFastModelForProvider()` | `src/services/api/claude.ts:queryHaiku()`, `src/services/compact/compact.ts`, `src/services/awaySummary.ts`, `src/utils/hooks/apiQueryHookHelper.ts`, `src/utils/hooks/skillImprovement.ts` | Codex subscribers route provider-aware side-calls to GPT mini. OpenAI-bound callers must build provider instruction assembly; cheap calls explicitly request low reasoning effort. Anthropic-only callers such as `/insights` pin `provider: 'firstParty'`. |
| Change first-party model defaults or retirement migration | `src/utils/model/model.ts` | `src/utils/model/{configs,modelOptions,aliases}.ts`, `src/migrations/migrateRetiredClaude46ModelsToClaude5.ts`, `src/main.tsx`, `src/constants/prompts.ts` | Model parsing and defaults distinguish first-party availability from third-party lag. Retired first-party Claude 4.6 pins migrate to Claude 5 and drop the obsolete `[1m]` suffix; the on-disk migration uses literal third-party/base-URL configuration rather than session provider state, which has not settled when startup migrations run. |
| Change client/auth routing | `src/services/api/client.ts` | `src/utils/auth.ts`, `src/utils/model/providers.ts`, [`codex-core.md`](codex-core.md) | Provider-specific clients are selected here. OpenAI/Codex fetch-adapter and account lease details are intentionally routed to `codex-core.md`. |
| Change retry/fallback behavior | `src/services/api/withRetry.ts` | `src/query.ts`, `src/services/api/claude.ts`, [`codex-core.md`](codex-core.md) | `claude.ts` wraps requests with `withRetry()`. `query.ts` handles model fallback by switching model/provider and replaying the whole attempt; a long-context entitlement refusal latches the lower budget instead of consuming retry attempts. |
| Change compaction/collapse hooks | `src/query.ts` | `src/services/compact/{autoCompact,reactiveCompact,compact}.ts`, `src/utils/contextWindowPolicy.ts`, `src/services/contextCollapse/index.ts` | Query loop order matters: tool-result budget, snip, microcompact, context collapse, autocompact, blocking-limit check, API call, reactive recovery. Prefix compaction is the normal automatic path when `REACTIVE_COMPACT` is compiled and enabled; full replacement is the short-conversation fallback. |
| Change model validation | `src/utils/model/validateModel.ts` | `src/utils/model/modelAllowlist.ts`, `src/utils/model/modelCapabilities.ts`, `src/utils/sideQuery.ts` | Validation checks allowlist and aliases before probing the API via `sideQuery()`. Codex subscriber model handling short-circuits known Codex/OpenAI models. |

## Turn Execution Owners

| Stage | Owner | Key decisions |
|---|---|---|
| Initial model/provider snapshot | `src/QueryEngine.ts` | Captures `getAPIProvider()` and `getMainLoopModel()` or `parseUserSpecifiedModel(userSpecifiedModel)` before prompt fetch. |
| Prompt/context fetch | `src/utils/queryContext.ts` | Fetches default prompt, Agent Mode sections, user context, and system context in parallel; skips default/system context for custom system prompt. |
| Extra user context | `src/QueryEngine.ts` | Merges base user context with coordinator and Agent Mode user context. |
| Effective prompt | `src/utils/systemPrompt.ts` | Builds final `SystemPrompt` from branch priority plus append/memory mechanics. |
| User input processing | `src/QueryEngine.ts` | `processUserInput()` may add messages, allowed tools, result text, or a new model. |
| Prompt refresh after switch | `src/QueryEngine.ts` | If model or provider changed during input processing, refetch prompt/context and rebuild effective system prompt. |
| Query state machine | `src/query.ts` | Carries mutable loop state, tracks query chain depth, handles recovery transitions, and returns terminal reasons. |
| API call dependency | `src/query/deps.ts` | Production `callModel` is `queryModelWithStreaming()`; tests can override it. |

## Model And Provider Selection

| Decision | Owner | Behavior |
|---|---|---|
| Session/env provider | `src/utils/model/providers.ts:getAPIProvider()` | Session provider wins, then Bedrock/Vertex/Foundry/OpenAI env vars, then startup provider preference, then first-party. |
| Request provider | `src/utils/model/providers.ts:resolveRequestProvider()` | Provider implied by model name wins; GPT-family models route to OpenAI, otherwise the base provider is used. |
| Interactive selection provider | `src/utils/model/providers.ts:resolveModelSelectionProvider()` | GPT selections route to OpenAI. Only an explicit Claude ID/alias crosses an OpenAI-started session to the configured Anthropic provider; Default/null and ambiguous custom IDs stay provider-local. `canApplyModelSelection()` rejects provider-family changes after the first turn. |
| Startup provider | `src/utils/model/providers.ts:resolveStartupProvider()` | An explicit CLI/settings/agent model may select a provider. An implicit default preserves environment/provider precedence, so `CLAUDE_CODE_USE_OPENAI` cannot be overwritten by a stale Anthropic preference. |
| Default main-loop model | `src/utils/model/model.ts:getDefaultMainLoopModelSetting()` | Codex subscribers default to a GPT model; other defaults depend on ant/user subscription and provider. |
| Model catalog and picker entries | `src/utils/model/configs.ts`, `src/utils/model/modelOptions.ts` | Codex/OpenAI and Claude options are assembled separately from adapter request translation. Before the first turn, a credentialed session may expose both provider families; after tokens are spent, the picker stays provider-local to preserve prompt/cache invariants. First-party rows omit redundant `[1m]` variants when the base frontier model already has a 1M context window; third-party model IDs remain distinct. Keep picker labels/descriptions, `ALL_MODEL_CONFIGS`, and display/canonicalization in `model.ts` aligned. |
| User-selected model | `src/utils/model/model.ts:getMainLoopModel()` | Session override, startup flag, `CAT_CODE_MODEL` (falls back to upstream `ANTHROPIC_MODEL` via `getModelEnvOverride()`), settings, then default. Disallowed configured models are ignored. |
| Runtime model | `src/utils/model/model.ts:getRuntimeMainLoopModel()` | Per-iteration adjustment based on permission mode and token state, notably plan-mode aliases. |
| API model string | `src/utils/model/model.ts:normalizeModelStringForAPI()` | Removes `[1m]`/`[2m]` suffixes before API dispatch. |
| Provider-specific model capability | `src/utils/model/modelCapabilities.ts` | Ant-only first-party model capability cache can refine known limits; otherwise callers fall back to static context/model utilities. |

## Context And Instruction Assembly

| Context/instruction surface | Built by | Provider placement |
|---|---|---|
| Default or Agent Mode prompt sections | `src/constants/prompts.ts` via `src/utils/queryContext.ts` | Fed into `buildEffectiveSystemPrompt()`. See [`prompt-system.md`](prompt-system.md). |
| Custom system prompt | `src/QueryEngine.ts` input config | Replaces default prompt branch; `fetchSystemPromptParts()` skips default prompt and system context. |
| Append system prompt | `src/QueryEngine.ts` input config | Appended to winning prompt branch unless an override prompt replaces everything. |
| Memory mechanics prompt | `src/QueryEngine.ts` | Added only for custom system prompt plus auto-memory path override. |
| User context | `src/context.ts:getUserContext()` | OpenAI: folded into stable instructions. Claude-style: prepended to message history. |
| System context | `src/context.ts:getSystemContext()` | OpenAI: stable keys go into instructions; volatile keys go into developer context. Claude-style: appended to system prompt. |
| Provider assembly | `src/services/api/instructionAssembly.ts` | Returns either adjusted `systemPrompt/messages` or `openAIInstructionAssembly` with `instructions`, `inputMessages`, and optional `developerContext`. |
| API-time prompt additions | `src/services/api/claude.ts` | Adds attribution header, CLI prefix, advisor instructions, Chrome/tool-search instructions, and cache-aware system blocks after provider assembly. |

## Query Loop And Recovery Hooks

The loop in `src/query.ts` carries a `State` object across continuations. The
major gates run in this order:

1. Start memory and skill-discovery prefetch for the turn/iteration.
2. Project messages after the latest compact boundary.
3. Apply tool-result content replacement budget.
4. Apply history snip when the feature is compiled in.
5. Run microcompact via `deps.microcompact()`.
6. Apply context-collapse projection when compiled/enabled.
7. Resolve runtime model and request provider for this iteration.
8. Run autocompact via `deps.autocompact()`; if it succeeds, yield compact
   boundary/messages and continue with post-compact messages.
9. Enforce blocking-limit preflight unless recovery systems own overflow.
10. Build provider instruction assembly and call the model.
11. Withhold recoverable prompt-too-long, media, or max-output errors until
    recovery paths have had a chance to run.
12. Execute stop hooks, token-budget continuation, tools, attachments, and
    recurse when tool results require a follow-up model call.

Recovery decisions:

| Recovery | Owner | Trigger |
|---|---|---|
| Model fallback | `src/query.ts` with `FallbackTriggeredError` from API path | Switches to `fallbackModel`, recomputes provider, clears partial messages/tool results, strips signatures for ant fallback, and retries the whole request. |
| Context-collapse drain | `src/query.ts` plus `src/services/contextCollapse/index.ts` | On withheld prompt-too-long, drains staged collapses once before reactive compact. In this source snapshot the default module is a no-op unless replaced by a feature build. |
| Reactive compact | Feature-gated loader and retry flow in `src/query.ts`; implementation in `src/services/compact/reactiveCompact.ts` (compiled in by the root `dev-full` set and the desktop sidecar's `REACTIVE_COMPACT` runtime flag) | On withheld prompt-too-long/media errors, summarizes an older prefix, keeps the newest complete API rounds verbatim, records the preserved segment, and retries the interrupted request once before surfacing the error. |
| Max-output escalation | `src/query.ts` | Can retry once with `ESCALATED_MAX_TOKENS`, then up to `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` continuation nudges. |
| Codex partial-stream continuation | `src/query.ts` with the typed marker from `src/services/api/codex-fetch-adapter.ts` and `src/services/api/errorUtils.ts` | On a Codex transport interruption that arrived after visible output. The request is never replayed. When the adapter certifies a transient transport failure with no client tool call and no hosted web search, the loop drops the synthetic error, keeps the sealed partial assistant text, appends a meta continuation instruction, and repeats the request over the adapter's sticky HTTP fallback. Bounded by `CODEX_PARTIAL_STREAM_CONTINUATION_LIMIT` (2) for the whole top-level `query()` call: no per-round reset. A name-only marker blocks replay but never authorizes a continuation. |
| Autocompact circuit breaker | `src/services/compact/autoCompact.ts` | Stops automatic retries after repeated non-transient compaction failures and persists failure count by scope. |
| Unknown-tool loop breaker | `src/query.ts` | Aborts when repeated follow-up turns only produce unknown-tool errors for the same tool. |

## API Client Routing

| Provider path | Owner | Routing notes |
|---|---|---|
| First-party Anthropic | `src/services/api/client.ts` | Uses the Anthropic SDK client with API key or Claude.ai OAuth token. First-party request IDs are injected only for first-party base URLs. |
| AWS Bedrock | `src/services/api/client.ts` | Uses Bedrock SDK client, region/model-region resolution, optional bearer token, and refreshed AWS credentials. |
| Google Vertex | `src/services/api/client.ts` | Uses Vertex SDK client, optional credential refresh, project fallback, and model-region resolution. |
| Microsoft Foundry | `src/services/api/client.ts` | Uses Foundry SDK client with API key or Azure AD token provider. |
| OpenAI/Codex adapter | `src/services/api/client.ts` | Uses Anthropic SDK shape plus a custom fetch adapter. Account pool, lease, adapter translation, websocket continuation, and response parsing are routed in [`codex-core.md`](codex-core.md). |

## Tests And Validation

Use focused checks first, then the documented build for broader confidence:

| Area | Command |
|---|---|
| Query loop behavior | `bun test src/query.test.ts` |
| Model catalog labels/options/agent downgrades | `bun test src/utils/model/gpt56LunaLabel.test.ts src/utils/model/agent.test.ts` |
| Provider instruction placement | `bun test src/utils/providerPromptRegressions.test.ts` |
| Prompt/context behavior | `bun test src/constants/prompts.test.ts src/services/compact/prompt.test.ts` |
| Compaction behavior | `bun test src/services/compact/compact.test.ts src/services/compact/autoCompact.test.ts src/services/compact/reactiveCompact.test.ts` |
| Codex/OpenAI adapter/account routing | See [`codex-core.md`](codex-core.md) § Tests And Validation. |
| Docs-only map change | `git diff --check -- docs/maps/query-provider-runtime.md` |
| Full documented build | `bun run build:dev:full` |

For model validation logic specifically:

- `validateModel()` rejects empty or disallowed model names before network I/O.
- Known aliases are accepted immediately.
- Codex subscribers with known Codex/OpenAI models skip Anthropic API probing.
- Other model names are probed through `sideQuery()` with a minimal message.
- 3P model-not-found errors may include fallback suggestions for current model
  launch availability drift.

## Traps And Stale Assumptions

- Do not assume `src/services/api/claude.ts` means Claude-only. It is the shared
  Anthropic-SDK-shaped request path before provider-specific client/fetch routing.
- Do not assume the session provider is the request provider. GPT-family model
  names override the base provider through `resolveRequestProvider()`.
- Do not assume model/provider changes during slash-command processing keep the
  old prompt. `QueryEngine.ts` refetches prompt/context when either changed.
- Do not assume custom system prompts still include system context. The custom
  prompt path skips `getSystemContext()` in `fetchSystemPromptParts()`.
- Do not collapse native, entitlement, configured, and effective context
  windows into one number. `src/utils/contextWindowPolicy.ts` records each
  clamp, including a provider long-context refusal and output reservation.
- Do not assume user context and system context are placed the same way for all
  providers. Check `instructionAssembly.ts` before changing prompt placement.
- Do not assume autocompact is the only overflow recovery path. The query loop
  can also use context-collapse drain, reactive compact, max-output recovery,
  and blocking-limit preflight depending on gates and failure type.
- Do not debug Codex account failover or websocket continuation here. Route to
  [`codex-core.md`](codex-core.md) and the adapter/account files it owns.
- Do not run the full build for a docs-only map unless needed; repo guidance
  says `git diff --check` and path/link checks are sufficient for docs-only
  changes.
