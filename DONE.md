# Done

> **How to use:**
> - One entry per finished task. No planned or in-progress items.
> - Keep entries short — describe what changed, not which files were touched.
> - Add to the latest phase. Only the user advances the phase number.
> - Agent must ask the user before writing here.

## Phase 0

### 12 May 2026

64. Fixed subagent resume UX — `SendMessage` is available for normal-session subagent resume by worker handle/raw agent ID, resumed agents show visible terminal status, direct resumed-subagent prompts append inline resume/failure transcript messages, and resume results render with clearer success/error treatment.

63. Added first-class Cat Code support to Open Design — Open Design now has a dedicated `cat-code` runtime using the Claude-compatible stream-json adapter shape, `CAT_CODE_BIN` detection/configuration, Settings UI exposure, Cat Code diagnostics, managed-project `.mcp.json` MCP wiring, and regression coverage for runtime args, executable precedence, app config, diagnostics, MCP spawn, and Settings autosave.

### 9 May 2026

62. Fixed Codex non-streaming fallback message materialization — when a Codex WebSocket stream fails mid-turn and Cat Code falls back through the Anthropic SDK's non-streaming path, the Codex adapter now returns a real JSON assistant message instead of Anthropic SSE, preserving response IDs, text, tool calls, custom `Apply_patch` input, object-shaped function tool input, stop reasons, and usage while failing visibly on empty fallback output.

61. Enabled WebSearch on the OpenAI/Codex provider — the Codex adapter translates the Anthropic `web_search_20250305` tool into OpenAI's hosted `web_search` Responses tool (`type: 'web_search'`, `external_web_access: true`, optional `filters.allowed_domains`; no unverified `search_context_size` field), normalizes streamed `web_search_call` output items into Anthropic-compatible `server_tool_use` and `web_search_tool_result` blocks so the existing `WebSearchTool` parser and UI work unchanged, merges the `web_search_call.action.sources` include alongside the reasoning include without clobbering either, throws on `blocked_domains` at the adapter (defense in depth alongside the tool-level reject) since OpenAI hosted web_search only verifies `allowed_domains`, and now passes Anthropic `tool_choice` through to the Codex request (auto/none/any/tool→OpenAI auto/none/required/{type:'function'|'web_search'}) instead of hardcoding `'auto'` so callers like the WebSearchTool small/fast-model path that force `{type:'tool', name:'web_search'}` actually take effect on Codex. Mixed tool-call streams keep `stop_reason=end_turn` for search-only output and `tool_use` when a real function call follows. Renamed the misleading `useHaiku` flag in `WebSearchTool` to `useSmallFastModel`.

60. Installed the Cat Code change impact checklist skill — `checking-cat-code-change-impact` now lives in the user skills directory and prompts agents to consider logs, telemetry, docs, tests, registries, permissions, cache behavior, generated types, and stale references before claiming completion.

### 5 May 2026

59. Fixed auto-compaction request assembly refresh — provider instruction assembly now happens after auto-compaction updates the query messages, so both generic model input and OpenAI-native input use the compacted transcript; regression coverage locks the post-compact request payload.

### 3 May 2026

58. Strengthened goal completion evidence requirements — `UpdateGoal` now tells the model to mark a thread goal complete only after every explicit requirement is satisfied, real evidence supports completion, tests or green status actually cover the objective, and no required work remains; regression coverage locks the model-facing completion prompt.

### 2 May 2026

56. Fixed model-scaled autocompact headroom — autocompact no longer uses the same 10k recovery window for every model; the recovery window now scales with effective context size (with floor/cap), context analysis uses the same threshold logic as runtime, and regression coverage now locks the concrete windows plus blocking-limit behavior.

57. Fixed goal-mode token accounting — goal usage now tracks positive context-token growth instead of cumulative API/cache token usage, stays accumulated across compaction resets, freezes after completion, and labels goal budgets as context tokens.

53. Added Agent Mode worker control tools — Agent Mode can now list durable workers, wait for selected workers, read worker results, and cancel a specific worker by handle without stopping the whole run.

54. Added durable worker result synthesis tracking — completed workers now record result timestamps/summaries, mark outputs as pending synthesis, and can be explicitly marked synthesized after the orchestrator incorporates the result.

55. Improved Agent Mode worker/worktree UX — the REPL now surfaces a compact durable worker roster, prompt guidance requires worker-result convergence before claiming completion, and worktree copy frames isolated work as agent-managed attempts/results instead of user-managed branches.

### 1 May 2026

51. Fixed cross-tab Codex "usage unavailable" inconsistency — opening multiple tabs showed different profiles as `usage unavailable` in `/accounts` because each tab's wham/usage call ran against whatever access_token was sitting in the vault file, and stale tokens (>1h old, common at startup since interactive launches don't trigger a refresh) returned HTTP 401. Two-layer fix: (1) reactive — `fetchAccountUsageResult` now refreshes the account's token on HTTP 401 and retries the usage call once, honoring the existing vault lock so concurrent tabs don't double-refresh; (2) proactive — `initAccountPool` now fires `void touchAll()` at interactive startup alongside the existing periodic-refresh setup so vault tokens are fresh before any usage or Codex API call runs.

52. Added local reference skills for account/profile support and session forensics — `cat-code-profiles-accounts` now covers Claude/Codex account pools, aliases, login/delete/rename/switch behavior, vault/config source tags, logging, and Codex refresh/usage states; `session-analysis` now covers Cat Code/Claude/Codex JSONL discovery, schema differences, subagent metadata, debug logs, and safe transcript reconstruction.

### 26 Apr 2026

50. Made cache-break warnings more diagnostic on the server-context-shrink path — the generic "server truncated context window" reason now distinguishes prefix pruning ("pruned N messages from prefix") from in-place compaction ("compacted message contents in place, same message count") via per-turn message-count tracking, surfaces both the input-token drop and invalidated-cache-token count, and flags suspicious cascading evictions ("change hit near prefix start, cascaded") when invalidated cache tokens are ≥10× the input drop.

### 25 Apr 2026

49. Finished Agent Mode v2.2 as a prompt-and-UI finish pass — upgraded the prompt-area Agent Mode marker to a stronger `◉ Agent Mode` identity, added a compact worker summary above the input, tightened orchestrator doctrine to keep codebase exploration Explore-first with narrow direct-read exceptions, and recorded the deferred non-goals explicitly in the v2.2 closure doc.

48. Implemented Codex reasoning display — reasoning summaries stream live inline by default; `/reasoning [off|summary|raw]` slash command switches modes; raw provider trace (`response.reasoning_text.delta`) is opt-in; adjacent reasoning blocks (one per tool-call step) share a single `∴ Thinking…` header with `───` separators instead of repeating the header; `reasoningKind` tag distinguishes Codex summary/raw blocks from Anthropic-native thinking blocks.

47. Fixed Codex session metadata leaking into user role — `gitStatus` and `cacheBreaker` are no longer injected as a `role: "user"` message; they now go into a `role: "developer"` input item wrapped in `<session_context>`, keeping stable instructions in `instructions`, real user prompts in `role: "user"`, and tool outputs in `function_call_output`.

### 24 Apr 2026

46. Reduced Codex backend latency — moved WebSocket prewarm off the critical path with empty-input startup seeding, added fast-mode `service_tier: "priority"`, time-bounded sticky HTTP fallback, continuation preservation across reconnect/account rotation, and regression coverage for the prewarm/open race.

### 23 Apr 2026

45. Restored the full dev build and improved latency diagnostics — fixed the broken ESLint rule/plugin resolution that blocked `build:dev:full`, and added first-visible-output timing so slow sessions can be separated into transport-start delay vs actual user-visible output delay.

44. Made partial-stream failures non-destructive — once visible output has started, Cat Code no longer replays the turn after a websocket drop, logs that replay was skipped to avoid duplication, and surfaces a clearer partial-stream error.

43. Closed the remaining Codex missing-usage crash surface — the last raw `response.usage` / `result.usage` readers now tolerate absent usage and emit explicit diagnostics instead of crashing with `"q.input_tokens"`.

42. Hardened Codex stream recovery — pre-visible-output websocket failures now classify cleanly, replay safely through HTTP fallback on the same turn, and keep later turns on sticky HTTP fallback for that conversation instead of repeating the broken websocket path.

### 22 Apr 2026

41. Fixed Codex usage race condition crash (`"undefined is not an object (evaluating 'q.input_tokens')"`) — structural 4-layer fix: (1) added `usage?: BetaUsage`, `stop_reason?`, `stop_sequence?` to `AssistantMessage.message` type so the gap is visible at compile time; (2) enforced `EMPTY_USAGE` fallback at both `AssistantMessage` construction sites in `claude.ts` (streaming `content_block_stop` and non-streaming fallback); (3) guarded the crash site in `orchestrator.ts` with `?? EMPTY_USAGE` matching the existing pattern in `agentToolUtils.ts`; (4) enriched Codex adapter's synthetic `message_start` with `cache_creation_input_tokens` and `cache_read_input_tokens` fields.

40. Fixed Apply_patch false "file unexpectedly modified" error in worktree sessions — when a Bash `cd` mutated STATE.cwd between a Read and Apply_patch call, relative paths expanded to different absolute keys causing a readFileState cache miss; `assertFileUnchangedSinceRead` incorrectly threw on `!lastRead` (no baseline) instead of skipping, inconsistent with `validateFileNotModifiedSinceRead` which already returns null on the same condition.

### 21 Apr 2026

39. Fixed Codex subagent swiss-cheese failure — 5 layered holes that caused 3/4 subagents to silently fail with `[Error: ...]` assistant text: (1) WS `"usage limit"` errors now throw `CodexWebSocketUsageLimitError` instead of plain `Error`; (2) WS close with zero events yielded is classified as account rejection (`CodexWebSocketUsageLimitError`) instead of transport drop; (3) stream error catch block now calls `controller.error()` instead of emitting error text with `stop_reason: end_turn`, so `withRetry` sees real failures; (4) expired-plan accounts (`chatgpt_subscription_active_until` in past) are marked `capped` at vault load with reason shown in `/accounts`; (5) recently-errored accounts get a 60s cool-down tiebreaker in lease selection (configurable via `CODEX_POOL_ERROR_COOLDOWN_MS`) and `lastErrorAt` is stamped on both cap-failover and non-cap task failure paths. `account_id_prefix` in session JSONL confirmed populated via spread from WS transport.

### 20 Apr 2026

38. Fixed Codex WS cache cold-miss on server-side response_id eviction — added `prewarm_websocket` (`generate=false`) before each real request so a fresh `response_id` is always seeded before generation; added `lastInstructionsHash` tracking to `WsSession` so volatile instruction changes (e.g. gitStatus) now drop `previous_response_id` instead of sending a mismatched chain; fixed incremental gate (`>` → `>=`) so the real turn chains from the prewarm's response_id; added `notifyStaleResponseIdRetry` so `promptCacheBreakDetection` labels the drop as "server evicted previous_response_id" instead of generic "likely server-side". Root-caused via session d452331d analysis against openai/codex `client.rs`.

37. Added user-visible cache warnings — REPL now shows a warning system message after each turn when prompt caching is unexpectedly absent (zero cache tokens on turn 2+) or when a cache break is detected (cached tokens drop >5%). Warnings show the reason (system prompt change, model switch, TTL expiry, etc.) and the token delta.

36. Fixed WebSocket transport reliability — stale response ID, 60-min connection limit, premature close, and stale turn-state are now all handled transparently without surfacing errors to the user. Added test coverage.

### 19 Apr 2026

35. Broken Codex 13,824-token cache ceiling via WebSocket transport — replaced the plain HTTP path with a persistent WebSocket to `wss://chatgpt.com/backend-api/codex/responses`; each turn sends only the incremental delta with `previous_response_id` so the server chains its KV-cache across turns; cached tokens now grow with conversation history instead of being pinned to the instructions prefix size.

34. Fixed Codex reasoning round-trip — added `include: ['reasoning.encrypted_content']` to requests and smuggle the server's encrypted reasoning blob through as `thinking.signature` in each assistant message; fixed `claude.ts` overwriting the pre-filled signature on `content_block_start`; on the next turn `translateMessages` replays it as a `reasoning` input item so the server's KV-cache prefix matches. This brought turn-2 cache hit from 0% to ~79%.

33. Fixed Codex prompt cache resume cold-start — `onSessionSwitch` now rebinds `prompt_cache_key` to the resumed session UUID so the first turn after `--resume` hits the server's cached instructions prefix instead of starting cold.

### 9 Apr 2026

32. Implemented GPT-native apply_patch editing — OpenAI now uses a provider-native freeform apply_patch tool instead of Edit, with custom-tool schema/export wiring, stream normalization, V4A patch parsing/application, shared edit safety checks, transactional multi-file rollback, and regression/manual smoke verification.

31. Fixed same-account Codex cache fragmentation — prompt-cache routing now shares `conversation-id` across main/subagent requests on the same account and model instead of splitting by lease owner, while keeping cross-account isolation intact and adding coverage for same-account sharing plus per-model separation.

30. Implemented lease-based Codex account routing for subagents — the main thread now uses a main lease, spawned subagents default to spread allocation, each subagent stays pinned to its leased account unless capped, only the capped subagent fails over, capped accounts are avoided at selection time, and account surfaces now reflect lease-aware usage instead of a single shared active account.

29. Reduced GPT/default prompt drift — FileEdit/FileWrite plus MagicDocs/SessionMemory now share underlying rule lists across GPT and default renderings, and added regression coverage for provider-aware schema caching, OpenAI remap round-trips, OpenAI agent identity text, and prompt-alignment invariants.

28. Hardened provider-aware prompt/tool routing — tool schema caching is now provider-aware, OpenAI schema key remapping is centralized and reversible, default agent identity follows the resolved provider, and in-process teammate prompt/message formatting now follows the teammate's own provider instead of ambient session state.

27. Fixed GPT parallel agent spawning — clarified in the GPT-only prompt path that `run_in_background: true` is required for true parallelism; without it the harness blocks on each subagent serially even when spawns are emitted in the same turn.

26. Implemented structured handoff contracts — fork worker requests/results and the meaningful local teammate/direct handoff transports now use provider-aware structured contracts end-to-end, including mailbox and mid-turn attachment delivery, while explicit control-message protocols and cross-session text-only limits remain unchanged.

25. Implemented strict structured outputs — provider-aware schema-backed outputs now cover the remaining reliability-sensitive automation paths, including OpenAI/Codex-native side-query structured output and fork worker result contracts.

### 8 Apr 2026

24. Implemented GPT-native call-ID tool state — Codex/OpenAI tool continuity now preserves real function-call IDs across request translation and streaming, resolves deltas/completions by call_id/item_id/output_index, and fails fast on ambiguous or orphaned tool results instead of fabricating positional IDs.

### 7 Apr 2026

23. Reduced XML to structure-only use — XML-like wrappers remain only where they help structure, readability, or parsing, and are no longer treated as the main behavioral control surface on GPT paths.

22. Implemented schema-first tool contracts — Zod-generated tool schemas now strip `$schema`, and the OpenAI path renames GrepTool dash-prefixed schema properties to identifier-safe keys with reverse-mapping before validation so tool calls remain compatible without changing GrepTool itself.

21. Implemented prefix-friendly prompt assembly — prompt construction now preserves a stable prefix and appends dynamic session/task material late, improving provider-native caching behavior and keeping control surfaces cleaner.

20. Implemented role-native instruction hierarchy — Claude and GPT now receive provider-native instruction layering instead of sharing a fake common authority model, so each provider follows its own control surface rather than a lowest-common-denominator prompt structure.

19. Removed GPT visible-thinking dependence — Codex/OpenAI reasoning is no longer translated into Anthropic-style `thinking` transcript state; Claude-native thinking continuity remains intact, and OpenAI is gated out of Claude-only thinking preservation/counting/compaction paths.

18. Updated agent model routing — spawned agents now support GPT-5.4 / GPT-5.4 Mini, key built-in research agents prefer GPT-5.4 Mini over Haiku 4.5, Codex family mapping points to newer GPT targets, and Explore/Plan were verified in the `dev-full` build.

17. Fixed `/clear` provider lock — clearing a session now resets per-session token usage so provider/model switching is allowed again after `/clear`.

16. Fixed Codex prompt cache 0% hit rate — `session-id` and `conversation-id` headers were using hyphens instead of underscores (`session_id`, `conversation_id`); this invalidated `prompt_cache_key` on every request; fix brings cache hit rate from 0% to 90–99% on sequential tool-call loops. Also fixed `input_tokens_details` field name (was incorrectly reading `prompt_tokens_details`).

15. Fixed GPT/Codex context window — was falling through to Claude's 200K default; set to correct 272K max input (400K total minus 128K output reserve) for all gpt-* models; also fixed max output tokens to 128K (100K for codex-mini)

14. Changed default model/profile to latest use

13. Completed Cat Code rebrand sweep — replaced all user-facing "Claude Code" strings and `claude` CLI references with "Cat Code" / `cat-code`

### 5 Apr 2026 (includes earlier work first logged today)

1. Fixed Codex provider lock-in (duplicate `isCodexSubscriber`)
2. Rewrote core system prompt — model identity shifted to general-purpose agent
3. Added per-provider system prompt prefixes (Claude vs Codex behavioral split)
4. Added multi-account Codex rotation with round-robin pool
5. Rebranded splash screen to Cat Code
6. Added account aliases and `/rename-account` command
7. Fixed effort level support for Codex/GPT-5 (`/effort` now works via `reasoning.effort`)
8. Fixed Codex token double-counting bug causing early auto-compact
9. Fixed Claude usage-limit state carry-over across account changes (rate limits, session ID, cache eligibility, extra-usage reason now reset on auth change)
10. Fixed Codex `/switch-account` stale-state carry-over (account switches now refresh session/user state and auth-dependent hooks)
11. Fixed startup dashboard showing stale active Codex account after `/switch-account` + `/clear` (added `key={conversationId}` to LogoHeader to force remount)
12. Added active profile indicator to status line — shows current Codex account alias next to model name (e.g. `Opus 4.6 · backup1`) in pink
