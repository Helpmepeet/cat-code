# Done

> **How to use:**
> - One entry per finished task. No planned or in-progress items.
> - Keep entries short — describe what changed, not which files were touched.
> - Add to the latest phase. Only the user advances the phase number.
> - Agent must ask the user before writing here.

## Phase 0

### 6 Jul 2026

100. Implemented the Codex context-cost fixes plan (`docs/codex/2026-07-06-context-cost-fixes-plan.md`) on branch `context-cost-fixes`, cutting per-turn context growth and warm-cache-bust cost on the gpt path. (a) Canonicalized the Codex output-item round-trip: one `canonicalizeCodexItem` shape produced identically at record time and replay time, eliminating the three systematic drifts (the server's `logprobs` field on assistant text, Apply_patch's `custom_tool_call→function_call` type mismatch, and re-serialized tool-argument drift) that forced ~46% of continuation-eligible turns to a full send instead of an incremental one. (b) Middle-truncate tool results to codex's 10k×1.2 budget (~48k chars) at wire time for gpt models only — the on-disk transcript stays full, so a mid-session switch back to a Claude model and `--resume` are unaffected — with a deterministic retrieval-hint marker, exemptions for ToolSearch/image/orphaned results, and a gpt→claude usage-anchor invalidation so autocompact/413 warnings don't fire late after a model switch. (c) Removed the per-request WebSocket prewarm (it re-fired up to ~156×/conversation and, because the real request awaited it, never warmed anything ahead of time) and reworked connection lifecycle so transient errors and aborts preserve the continuation baseline while still closing the socket, any chained-request rejection resets the baseline, and account rotation drops it. Each item is its own commit with record→replay/round-trip and lifecycle tests (122 pass, `build:dev:full` clean); a plan-conformance review (PASS, zero gaps) and a correctness review (no confirmed bugs) followed, and the one functional review finding — an orphaned ToolSearch result could be truncated — was fixed. Deterministic gates pass; the live acceptance *indicators* (prewarm ≤2/conversation, warm-bust rate below the 3.1% baseline, cache-warmth) need a real multi-hour gpt session and are pending. Branch not yet merged. Source analysis: `docs/reports/2026-07-06-context-growth-pipeline-audit.md`.

### 29 Jun 2026

97. Fixed two independent UX bugs in the `/resume` session picker. (a) Wrong time and ordering: each row's "X ago" and the list sort both read `LogOption.modified`, which was set from the session file's mtime — and mtime drifts by days when post-message bookkeeping (last-prompt cache, file-history-snapshot, metadata-restore) rewrites the file. Now `readLiteMetadata` extracts the last in-file timestamp and `enrichLog` uses it for `modified` (mtime only as fallback), and the enriched batch is re-sorted in both progressive loaders and the load-more path so corrected timestamps drive the displayed order; the mtime-ordered stat list still drives paging. (b) Generated names never shown: the Haiku title produced at session start only set the terminal tab title, and `saveAiGeneratedTitle` (which writes the `aiTitle` the picker already reads) had zero callers — so every session fell back to raw first-prompt text. The title is now persisted when it resolves, guarded so a user `/rename` wins; no backfill for pre-existing sessions. Verified against the live project dir (45/120 enriched logs corrected) with a new mtime-drift test; dev-full build passes. Writeup: `docs/reports/2026-06-29-resume-menu-ux-bugs.md`.

96. Tuned the Bash tool's commit-message instruction from a hard "1-2 sentences" ceiling to a length sized to the change — a 1-2 sentence summary for a single-purpose commit, plus a short one-line-per-change bulleted body for commits spanning multiple distinct changes — so multi-part commits keep the per-change context a future reader needs while trivial commits stay clean. Attribution behavior unchanged.

95. Hardened the GPT system-prompt instruction surface after an adversarial token-by-token review. (a) Added a standing System Rule that tool output (file contents, command output, web pages, errors, document/email bodies) is data, not instructions — closing a gap where the only injection rule was recognition-gated, so "handle this content" requests no longer let embedded imperative text act as commands. (b) Bounded the verification-contract retry loop (was "re-run until PASS", an unbounded loop) to 3 cycles then stop-and-report, consistent with the existing 3-attempt failure cap. (c) Narrowed risky-action authorization to the user's own global/managed config — a project-level CLAUDE.md is now treated as untrusted data and cannot authorize destructive or shared-state actions — and removed a dangling "Rule 1 overrides Rule 2" reference plus a fabricated `CAT_CODE.md` filename the loader never reads. (d) Gave the Bash tool an error-handling contract (empty/failed output is a result to interpret, not a success signal) and rewrote the misleading `dangerouslyDisableSandbox` "don't ask, just do it" phrasing to state that the harness gates approval. (e) Replaced the vague Explore-delegation threshold with an observable rule. (f) Fixed the session-transcript grep example, which told the model to match `"tool_use_id":"toolu_"` — wrong for this Codex build, where IDs use the `call_` prefix and the old pattern matched zero lines. Edits independently reviewed; dev-full build passes.

94. Shipped three independent Codex/runtime features to `main`. (a) Codex HTTP streams now race the first visible-output event against an initial-output timeout (`CLAUDE_STREAM_IDLE_TIMEOUT_MS`, default 90s) so a stream that opens but never emits fails fast with a diagnostic error instead of hanging, and the caller's abort signal is forwarded into SSE reads so readers cancel on abort as well as idle. (b) GPT-agent background job results now include a usage summary derived by scanning the session transcript at job end — call count, input/cached/uncached and output tokens, full vs incremental sends, and prompt-cache breaks. (c) Fast mode is now session-only: `/fast` and the Settings toggle mutate session AppState/model instead of persisting `userSettings.fastMode`, and sessions always start with fast mode off. Focused tests (78 pass) and lint clean.

### 23 Jun 2026

93. Fixed GPT MCP background-job result retrieval — default tool discovery now exposes the read-only `get_gpt_agent_job_status`, `get_gpt_agent_job_result`, and `wait_for_gpt_agent_job` tools so completed background GPT outputs can be fetched by `job_id` without re-running via `send_gpt_agent_message`. Mutating/log job tools stay debug-gated, default guidance no longer advertises hidden tools, stale docs were updated, focused MCP tests and dev-full build pass.

92. Implemented named GPTs for the GPT MCP server — the normal tool surface is now `spawn_gpt_agent`, `send_gpt_agent_message`, and `list_gpt_agents`, with job-control tools hidden and blocked unless `GPT_AGENT_DEBUG_TOOLS=1`. Named GPT continuation is registry-backed instead of `conversations.json`-backed, generated names are stable (`GPT 1`, `GPT 2`, ...), duplicate/replace/busy flows are explicit, prompt-cache freshness gates guard stale resumes, and background reconciliation/cleanup no longer strand GPTs busy. Focused MCP tests and the dev-full build pass.

### 17 Jun 2026

91. Investigated and removed the keyword auto-map context-injection feature. First instrumented it (debug log line + a dim one-line UI notice) because the injection was invisible — it's a transient attachment rendered into the API payload at query time, never written to the transcript JSONL, and its analytics event only POSTs to telemetry, so neither logs nor transcripts could confirm it fired. Then measured the matcher against real prompt history: it would fire on 27.5% of interactive prompts, 58% of those fires stapled on a marginal second map (mostly `codex-core`+`auth-accounts-oauth` via the generic `account` keyword), and the matched map was already read in-session 85% of the time without the feature. Two model design reviews plus the data agreed it was redundant with the standing `CLAUDE.md` "read the map index before broad search" rule and that its value was anti-correlated with need (fires on obvious prompts, misses oblique ones). Deleted the matcher (`subsystemMapContext.ts`), its test, the injection gate in `processUserInput.ts`, the `auto_map_context` attachment type, its model-serialization and UI render cases, and the debug instrumentation. Kept the maps and the `CLAUDE.md` instruction. Build, lint, and typecheck pass.

90. Installed a local `cat-code-gpt-prompting` skill for Cat Code prompt authors — it turns the GPT-vs-Claude behavioral research into direct guidance for writing and reviewing Cat Code system prompts, harness prompts, agent instructions, and tool descriptions on the GPT backend, with explicit trigger/negative-scope metadata, prompt-writing rules, Claude-era porting inversions, a checklist, and validation scenarios.

89. Audited auto-mode classifier fidelity vs. real Claude Code. Confirmed auto mode is an upstream port whose decision-boundary prompts were authored locally, and that the classifier runs on the GPT main-loop model (`gpt-5.5`), not an Anthropic endpoint. Axis-1 (do the GPT classifier's allow/block verdicts match the authored policy?) is blocked on a Codex usage cap — all live probes fail closed — pending reset. Axis-2 (does the agent respond correctly when a tool call is denied?) was audited statically and externally reviewed: the denial message is a verbatim upstream port that correctly forbids laundering and tells the agent to escalate when a capability is essential, but offloads "intent behind this denial" inference onto the model with no decision procedure — headline risk is wrong-intent routing (picking a "natural alternative" that defeats the block while believing it complies). Writeup: `docs/research/2026-06-17-auto-mode-agent-response-audit.md`.

### 16 Jun 2026

99. Made a Codex account with a revoked refresh token (HTTP 401 → `reauth_required`) say "needs re-login" instead of showing the raw refresh error. Such an account (e.g. `yoxrent`) still has a valid *access* token, so `/accounts` keeps showing its usage even though it can't be routed to — switching first refreshes, and the *refresh* token is what OpenAI revoked. The two surfaces now name the cure: `/switch-account` refuses with `Cannot switch to yoxrent — login expired — run /login (OpenAI) to re-authenticate this account. Staying on …`, and `/accounts` tags the account `[needs re-login]` (instead of `[dead]`) with a `fix: run /login (OpenAI) …` line. Detection keys off the structural `statusReason === 'auth_dead'` signal (covering both the 401-revoked and >7-day-expired cases), not string-matching the error text. No recovery code changed — a fresh `/login` already self-heals: the new refresh token's hash differs from the stored `reauth_required` hash, so the next refresh runs for real and resets the vault state to `idle`. Lint clean on touched files and `build:dev:full` compiles.

98. Stopped `/switch-account` from lying about a downgraded (free) Codex account and fixed the misleading usage display for it. `/switch-account <free-or-expired-account>` previously reported "Switched to …" even though the account had no Codex access (ChatGPT plan lapsed to free), then silently failed over to another account on the next request — the status line stayed on the real account, contradicting the success message. The switch now consults live `wham/usage` for accounts carrying only soft plan warnings before committing, and refuses with a truthful, unified message (e.g. `Cannot switch to hiby — subscription expired 2026-06-01. Staying on main2.`) shared by both the live-check path and the existing "not switchable" gate; the reason is humanized (free plan / expired subscription / usage-cap) instead of the internal availability string. Usage parsing no longer collapses a free-plan response (null `secondary_window`) to "usage unavailable", and all three Codex usage renderers (the `/accounts` text output, the Settings usage panel, and the LogoV2 accounts panel) now show "free — no Codex access (upgrade required)" instead of fabricated `5h 100% resets 28d / 7d 0% resets now` bars. Focused codexUsage/switch-account/accounts/LogoV2 tests pass, lint clean on touched files, and `build:dev:full` compiles; verified live against the genuinely-free `hiby` account.

### 15 Jun 2026

88. Restored async background subagent handoff contract — background Agent launch guidance now tells parent agents to yield for automatic completion notifications by default while keeping `TaskOutput` for explicit status checks, manual retrieval, or intentional waits; `output_file` remains debug transcript only. Updated regression coverage and the handoff plan; focused AgentTool/TaskOutput/LocalAgentTask tests plus touched-file diff/lint checks pass, while canonical `build:dev:full` remains blocked by the existing `.worktrees` lint-wrapper scan.

87. Removed the old Claude Code feedback survey surfaces from Cat Code — the post-command Bad/Fine/Good session prompt, memory/post-compact/frustration survey hooks, transcript-sharing survey upload path, and feedback-triggered `/issue` auto-run wiring are gone. Skill-improvement prompts now own their tiny response type/validation directly instead of depending on the deleted survey module. Stale survey docs/comments were cleaned; targeted ESLint, stale-reference search, diff check, dev-full build, and `cli-dev --version` pass.

### 14 Jun 2026

86. Fixed background subagent result handoff affordances for GPT/Codex — async agent launch and fork guidance now treat `output_file` as a debug transcript path only, dependency waits are explicitly routed through `TaskOutput(block=true)`, `canCheckProgress` requires `TaskOutput` instead of raw `Read`, and running local-agent `TaskOutput(block=false)` returns bounded status instead of transcript content. Local-agent completion notifications stay on the default `later` queue path. Focused AgentTool/TaskOutput/LocalAgentTask/prompt/compact tests, touched-file ESLint, diff check, and dev-full compile pass; canonical `build:dev:full` remains blocked by the existing `.worktrees` lint-wrapper scan.

### 13 Jun 2026

85. Improved stopped-subagent resume context messaging — `ResumeAgent` success now reports neutral post-action context as `Previous context: ~53k / 200k tokens (27%)`, removes "last checkpoint" and fresh-agent advice after the resume has already been scheduled, while stopped-agent `SendMessage` guidance keeps that advice in the pre-action path and also includes the model-window denominator when available. Context-window resolution now falls back from live task progress to the transcript model so retained stopped agents with progress but no live model still show the denominator. Focused ResumeAgent/SendMessage/target-resolution tests pass; the canonical `build:dev:full` gate remains blocked by the existing `.worktrees` lint scan.

### 10 Jun 2026

84. Cut idle/background energy usage — teammate mailbox polling (the 1s inbox poller and the 500ms in-process teammate wait loop) now stats the inbox file for an mtime+size signature and skips reading/parsing unchanged mailboxes, with the in-process idle loop backing off 500ms→2s when empty; web mode no longer leaks the vite dev server on exit (the global SIGINT handler's `process.exit(0)` skipped the async cleanup, orphaning vite+esbuild — one orphan had run for 2¼ days — fixed with a `process.on('exit')` hook that SIGTERMs the child); and the browser web app's WebSocket reconnect backs off exponentially 1.5s→30s instead of hammering a dead backend every 1.5s forever. Verified live: an idle interactive session now measures ~0.3% CPU, ~0.3 wakeups/s, macOS power score 0.0. A long active session's ~1GB RSS was diagnosed as JS-heap retention plus allocator slack (not a leak, not battery-relevant).

### 6 Jun 2026

83. Stopped the model from forcing subagents onto GPT-5.4. GPT-5.5 main sessions were spawning normal subagents (and Explore) pinned to GPT-5.4 — traced to the model volunteering a `model` argument on `Agent` calls, not a defaulting bug (subagents already default to `inherit`, and no instruction anywhere told the model to pick GPT-5.4; it was choosing it from the bare `model` enum). Tightened the `Agent` tool's `model` parameter description to a bright-line rule — omit it (inherit your model or the agent's own pin) and set it only when the user explicitly named a model, with GPT-5.4 called out as the anti-pattern — and dropped the stale "sonnet to audit your work" example since Claude models are retired on the Codex backend. Prompt-only; no model-resolution code changed.

### 2 Jun 2026

82. Surfaced normal-mode subagents in the UI to match the new named/role/resumable capability — background `local_agent` tasks now carry the resolved friendly name, so the footer pill, detail dialog, and notifications show `@Name · role` (e.g. `@Curie · implementor`) instead of the generic "local agent" label. Added a distinct **blocked / needs-input** state derived from the implementor's `status: blocked` handoff return: it reuses the existing question-mark/warning treatment (not a new icon), renders a "Needs input" block with the blocking reason in the detail dialog, and drives a completion/blocked notification so the block-don't-widen behavior is actually visible to the user rather than reading as a green "completed" tick. Verification completions surface their `VERDICT: PASS/FAIL/PARTIAL` inline, and terminal/blocked states show a `resume with @Name` hint. Reused `taskStatusUtils` icons/colors throughout; no Agent Mode rendering changed. LocalAgentTask tests pass (9/9).

81. Gave normal-mode subagents first-class role identity by importing the useful slice of Agent Mode without the orchestrator machinery — registered a new normal-mode `implementor` coding-worker type with a normal-mode-native prompt (reports to the main agent, no orchestrator/ask_orchestrator framing, explicit block-and-return-don't-widen-scope discipline), reused the existing `verification` agent as the normal-mode verifier and un-gated it so it is reliably available outside the ant A/B flag, mapped `implementor` to the coding-themed friendly-name pool, and added short delegation guidance so the main agent actually reaches for these roles instead of leaving them dormant. Friendly naming and resume already worked in normal mode (no change needed); per-role agent memory is a deliberate deferred follow-up. Also fixed a pre-existing `ask_orchestrator` constant-name collision (`'AskOrchestrator'` vs `'ask_orchestrator'`) that meant Agent Mode workers never actually received the tool their prompts told them to call. Build passes clean and the implementor/AskOrchestrator regression tests run green (the implementor assertions use source-text checks to sidestep the pre-existing circular tool-graph initialization issue that blocks importing agent definitions in tests).

### 1 Jun 2026

80. Fixed Codex session-title request shaping and clipboard native-module fallback noise — forced `StructuredOutput` tool choices are no longer sent to Codex after the internal tool is filtered from the request, preventing `Tool choice 'function' not found in 'tools' parameter` errors on `side/title` calls. Clipboard image fast paths now treat missing `image-processor-napi` as an optional fallback case without `logError` spam while still logging unexpected native clipboard failures. Added focused regression coverage and updated the older Codex incident note.

### 31 May 2026

79. Fixed Auto Mode wrongly blocking Bash on transient Codex classifier failures — the `gpt-5.5` safety classifier only fell back to `gpt-5.4` on a narrow `503/529` status set, so common transient Codex outages (bare `500/502/504`, and WS→HTTP-fallback errors where the SDK strips the numeric status into an `APIConnectionError`) failed closed and blocked the tool with a misleading "temporarily unavailable" message. Broadened the transient set to `408/429/500/502/504/529`, recovered the status embedded in `Codex API error (NNN)` messages, and added generic backend-body keywords. Included non-cap `429` (the classifier path has no app-level account failover, so a generic rate limit would otherwise block) while explicitly excluding true `CodexAccountCapError`/`CodexAccountAuthError` by name so account caps still fail closed and preserve their signal. Covered with focused regression tests including a real SDK `APIError`, non-cap-429 fallback, and cap/auth no-fallback guards.

77. Made auto mode usable from GPT/Codex sessions — GPT-prefixed main models now satisfy the auto-mode support gate, and Shift+Tab/session availability uses an enabled fallback when no remote auto-mode config has been cached yet. Kept the shared `getAutoModeEnabledState()` default conservative for migration safety, added a separate availability helper for UI/session surfaces, and covered the GPT eligibility plus Shift+Tab carousel behavior with focused regression tests.

78. Fixed status-line effort display for session-only `/effort max` — status-line command input now includes the resolved `effortLevel` and refreshes when effort changes, so custom status-line scripts no longer fall back to persisted settings and show stale `high`; added regression coverage and updated the status-line payload docs.

### 30 May 2026

76. Enabled auto mode and made it the default — auto mode (a classifier reviews each consequential tool call, auto-approving safe actions and blocking risky ones) was already ported from upstream but compiled out and missing its classifier prompts. Turned it on in every build, authored the missing classifier system prompt and external permissions policy (conservative deny rules covering irreversible destruction, out-of-workdir writes, remote code execution, secret/env-var exposure, network exfiltration, persistence, privilege escalation, and publishing/deploying; explicit user boundaries like "don't push" hard-block even otherwise-allowed actions), and wired `--enable-auto-mode` to start a session directly in auto mode. Verified by build and classifier-prompt parsing; live allow/block behavior in a real session not yet exercised.

### 29 May 2026

75. Installed a portable `codex-subscription-client` skill for building/reviewing subscription-backed Codex backend integrations — it now teaches the single-account default flow (OpenAI/Codex OAuth, secure token refresh/storage, Codex request adapter, HTTP/WebSocket streaming, scoped cache, and error handling), keeps OpenAI API-key billing and `codex app-server` separate, treats vaults/account pools/leases as optional multi-account infrastructure, and avoids Cat Code-only file references so agents can use it in other workspaces.

74. Fully isolated `cat-code` configuration paths, project-level settings, worktrees, skills, cron tasks, and permissions from the upstream `Claude Code` configurations (`.claude`). All global/project settings and cache directories now read/write under `.cat-code/` or `~/.cat-code/` dynamically. Updated the local installer wrapper generation, agent folder mappings, and wizard UIs to match, while retaining fallback legacy `.claude` permissions/launch paths for compatibility.

### 23 May 2026

73. Tightened the Agent tool's `model`-param guidance to stop the orchestrator clobbering built-in model defaults — analysis of 501 real subagent spawns showed the orchestrator passed an explicit `model` on ~46% of calls and chose `gpt-5.4` for ~90% of those overrides, both downgrading heavy `general-purpose` work below its own tier (50/50 with omitting, no consistent rule) and forcing `Explore` off its cheap `gpt-5.4-mini` pin for trivial searches. The old description ("Optional… takes precedence… omit for built-ins") read as permission; the rewrite leads with "OMIT this by default," names the exact waste, and whitelists only deliberate uses (cross-family reviewer, upgrading from a weaker parent, or a misconfigured custom agent) so the built-in resolution path takes effect while preserving the intentional `sonnet`-reviewer pattern. Prompt-only change; no resolution logic touched. Two independent model evaluations confirmed it's a miscalibrated reflex (not a routing strategy) with no measured quality harm, and that a hard code-side strip would wrongly kill the legitimate override paths.

72. Honored `provider: 'firstParty'` overrides in `getAnthropicClient` — a session-level `isCodexSubscriber()` check was routing **every** `getAnthropicClient` call through the Codex fetch adapter whenever the user's session provider was openai, even when the caller (e.g. /insights facet extraction after entry 71) explicitly pinned the request to `firstParty`. The Codex adapter then complained "OpenAI request missing provider-native instruction assembly payload" and bubbled it up as a generic "Connection error", so /insights still showed "No data" for facet-derived charts (`Primary Friction Types`, `Inferred Satisfaction`, `Outcomes`, `What Helped Most`). The Codex fallback now requires `resolvedProvider === 'openai'` in addition to `isCodexSubscriber()`, so firstParty-pinned requests reach the Anthropic client path correctly.

71. Fixed `/insights` misrouting to Codex/OpenAI — when the user's `lastUsedProvider` was `openai`, the Claude-only facet extraction and section insight `sideQuery` calls were routed through the Codex adapter (model remapped to `gpt-5.5`), every call returned `null`, and `extractMissingFacetsForInsights` threw "Could not extract any usage insight facets." `SideQueryOptions` now accepts an opt-in `provider` override threaded into `resolveRequestProvider`; both `/insights` call sites pin to `firstParty` so a user's OpenAI session selection no longer breaks a Claude-specific pipeline. GPT-prefixed models still route to OpenAI regardless of the override.

### 22 May 2026

70. Fixed Codex network-recovery stuck state — when a transient outage caused multiple distinct accounts to hit `APIConnectionError` in one retry budget, Cat Code used to burn all six attempts in ~800 ms and stay broken until exit + `/resume`. Now each connection-error failover sleeps with exponential backoff (~5–15 s total budget) and yields a `system / api_error` message so the UI shows the wait; when ≥2 distinct accounts fail with `APIConnectionError`, a one-shot "suspected network outage" path emits a diagnostic, recycles the keep-alive socket pool, and applies a jittered 5–10 s recovery wait without burning the lease-failover budget. Attempt-1 connection errors count toward the detector. Bug report `docs/reports/2026-05-20-network-recovery-stuck-bug-report.md` now closed against current code.

69. Verified the GPT `apply_patch` UX improvements plan is resolved — the "2–4 attempts for a simple edit" failure no longer reproduces; `FilePatchTool` is live on the OpenAI provider path with canonical Codex V4A semantics covering all five root causes (BOF prepend, EOF append, anchor-out-of-order, changed-on-disk detection over a hard read-gate, full-hunk-fingerprint ambiguity rejection, remediation hints), plus beyond-plan fuzzy-match tiers and `@@` scope-hint disambiguation. Implementation diverged from the proposed `>>>BOF<<<` sentinel; only the measurement scaffolding (Phase 0 failure telemetry and the eval-suite driver for the existing 12 fixtures) remains unbuilt and is non-blocking. Plan doc updated with a status header.

### 21 May 2026

68. Finished the Open Design Cat Code diagnostic UX follow-up — Cat Code now emits sanitized near-cap usage warnings reliably even when usage was cached before stream-json setup, Open Design pre-flights Cat Code run submission for unrecoverable diagnostics, surfaces the narrow `account.usage.warning` inline note once per run session per tab, keeps recoverable routing log-only, bounds warning throttles, preserves the no-account-picker boundary, and documents the aggregate-counts/usage-warning carve-outs.

67. Finished Open Design's Cat Code diagnostics boundary — Open Design now parses structured Cat Code account-backend diagnostics from stdout/stderr, routes unrecoverable failures into user-facing errors, keeps recoverable routing log-only with sanitized metadata, preserves the profile-free boundary, and verifies Cat Code settings stay binary-path-only with focused daemon/web tests.

66. Finished the account-switching fixes plan — account UI refreshes after switches, explicit no-op switches avoid side effects, Codex leases stay owner-local except intentional main/follow-main propagation, `/accounts` usage display is observational, retry failovers are bounded and body-aware, account diagnostics are wired through terminal/bridge/app/SDK paths, identity mismatches reconcile live pool state without stealing active sessions, exact account matches win over prefix ambiguity, dead turn rotation was removed, and image generation now uses lease-aware Codex auth.

### 12 May 2026

65. Split subagent continuation from message delivery — added `ResumeAgent` for stopped/resumable subagents, restricted `SendMessage` to running-target queueing, shared target/display-name resolution across tool and REPL paths, migrated shipped prompts to the Agent/ResumeAgent/SendMessage boundary, and added regression coverage for raw running IDs, prior-session handles, evicted transcript resume, teammate fallback, concurrent resume, and pending-message preservation.

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

51. Fixed cross-tab Codex "usage unavailable" inconsistency — opening multiple tabs showed different profiles as `usage unavailable` in `/accounts` because each tab's wham/usage call ran against whatever access_token was sitting in the vault file, and stale tokens (>1h old, common at startup since interactive launches don't trigger a refresh) returned HTTP 401. Fix: `initAccountPool` fires `void touchAll()` at interactive startup alongside the existing periodic-refresh setup so vault tokens are fresh before any usage or Codex API call runs, honoring the existing vault locks so concurrent tabs don't double-refresh. (A second, reactive layer — refreshing the token and retrying once inside `fetchAccountUsageResult` on HTTP 401 — was also implemented but later reverted in commit 3e38b39 "Fix account switching drift": the only refresh primitive, `refreshAccountTokens`, marks accounts dead on failure and moves+persists the active account on identity mismatch, so running it from the read-only-looking usage/`/accounts` display paths reintroduced the DP2/DP4 drift. `fetchAccountUsageResult` now treats 401 as observational; regression tests in `codexUsage.test.ts` lock this in.)

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
