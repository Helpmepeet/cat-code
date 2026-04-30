# Prefix-Friendly Prompt Assembly — Investigation & Design

## Summary

The codebase already has a deliberate static/dynamic split in prompt assembly, anchored by `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` and a `splitSysPromptPrefix` function that maps prompt blocks into Claude-native `cache_control` scopes. However, this machinery is entirely Claude-shaped: it produces `cache_control: { type: 'ephemeral', scope: 'global' }` breakpoints that the Codex/OpenAI fetch adapter silently strips when flattening system blocks into a single `instructions` string. The result is that OpenAI requests get no caching benefit from the careful prefix discipline, and Claude requests get no benefit from the careful dynamic-boundary discipline when the global-cache feature flag is off.

The design recommendation is to make the existing boundary-aware assembly **provider-dispatched at the point where the system prompt is serialized into the API request**, so that Claude requests continue to get explicit breakpoints/TTL and OpenAI requests get `prompt_cache_key` + prefix-stable `instructions` ordering — both driven by the same logical split.

---

## Relevant Files

### Prompt content assembly (what goes into the prompt)

| File | Role |
|---|---|
| `src/constants/prompts.ts` | Builds the default system prompt array; defines `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` |
| `src/constants/systemPromptSections.ts` | Memoized vs volatile section helpers |
| `src/constants/system.ts` | Identity prefix strings (Claude vs OpenAI variants) |
| `src/utils/systemPrompt.ts` | Chooses winning prompt branch (override > coordinator > agent > custom > default) |
| `src/context.ts` | Injects `userContext` (CLAUDE.md, date) and `systemContext` (git status, cache breaker) |
| `src/utils/queryContext.ts` | `fetchSystemPromptParts()` — parallel fetch of default prompt + user context + system context |
| `src/QueryEngine.ts` | Final assembly: default/custom prompt + memory mechanics + append prompt |

### Prompt serialization (how it becomes an API request)

| File | Role |
|---|---|
| `src/utils/api.ts` | `splitSysPromptPrefix()` — splits prompt array at the boundary marker into `SystemPromptBlock[]` with `cacheScope`; `prependUserContext()` / `appendSystemContext()` |
| `src/services/api/claude.ts` | `buildSystemPromptBlocks()` — maps `SystemPromptBlock[]` to `TextBlockParam[]` with `cache_control`; `addCacheBreakpoints()` — places message-level `cache_control` on the last user/assistant message |
| `src/services/api/codex-fetch-adapter.ts` | Translates the entire Anthropic-shaped request to OpenAI Responses API; flattens system blocks into a single `instructions` string; sets `prompt_cache_key` to a session-scoped UUID |

### Provider routing

| File | Role |
|---|---|
| `src/utils/model/providers.ts` | `getAPIProvider()` — returns `'firstParty'`, `'openai'`, etc. |
| `src/services/api/client.ts` | Creates Anthropic SDK client; routes through `createCodexFetch()` when provider is OpenAI |

---

## Current Assembly Order

The prompt array returned by `getSystemPrompt()` in `src/constants/prompts.ts:435` has this structure:

```
┌─────────────────────────────────────────────────────┐
│ 1. Identity intro (getSimpleIntroSection)            │  STATIC
│ 2. System rules (getSimpleSystemSection)             │  STATIC
│ 3. Doing tasks (getSimpleDoingTasksSection)          │  STATIC
│ 4. Actions (getActionsSection)                       │  STATIC
│ 5. Using tools (getUsingYourToolsSection)            │  STATIC*
│ 6. Tone & style (getSimpleToneAndStyleSection)       │  STATIC
│ 7. Output efficiency (getOutputEfficiencySection)    │  STATIC
│ ── SYSTEM_PROMPT_DYNAMIC_BOUNDARY ──                 │  marker
│ 8. Session guidance (tools/agents/skills)             │  DYNAMIC
│ 9. Memory prompt                                     │  DYNAMIC
│ 10. Ant model override                               │  DYNAMIC
│ 11. Env info (model, cwd, platform, provider)        │  DYNAMIC
│ 12. Language preference                              │  DYNAMIC
│ 13. Output style                                     │  DYNAMIC
│ 14. MCP instructions (DANGEROUS_uncached)            │  VOLATILE
│ 15. Scratchpad instructions                          │  DYNAMIC
│ 16. Function result clearing                         │  DYNAMIC
│ 17. Summarize tool results                           │  DYNAMIC
│ 18. Length guidance                                   │  DYNAMIC
│ 19. Token budget (feature-gated)                     │  DYNAMIC
│ 20. Brief section (feature-gated)                    │  DYNAMIC
└─────────────────────────────────────────────────────┘
```

\* "STATIC" means memoized-once-per-session. Section 5 (using tools) has session-variant bits but is placed before the boundary; it reads the `enabledTools` set which is stable per session. However, `getSessionSpecificGuidanceSection` (section 8) was deliberately moved post-boundary because it reads runtime booleans like `getIsNonInteractiveSession()` and feature flags that would fragment the cache prefix if placed earlier.

After `getSystemPrompt()` returns, `QueryEngine.ts` wraps the array with:

```
[attribution header] + [CLI sysprompt prefix] + [...systemPrompt] + [advisor/chrome instructions]
```

Then `buildSystemPromptBlocks()` calls `splitSysPromptPrefix()`, which:

1. Identifies the attribution header and CLI prefix by content matching against `CLI_SYSPROMPT_PREFIXES`
2. Splits the remaining blocks at `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`
3. Returns `SystemPromptBlock[]` where:
   - attribution header → `cacheScope: null`
   - CLI prefix → `cacheScope: null` (global mode) or `'org'` (default mode)
   - static content (before boundary) → `cacheScope: 'global'`
   - dynamic content (after boundary) → `cacheScope: null`

Finally `buildSystemPromptBlocks()` maps these to `TextBlockParam[]` with `cache_control: { type: 'ephemeral', scope: <scope>, ttl: <ttl> }`.

### What happens on the OpenAI path

The Codex fetch adapter (`codex-fetch-adapter.ts:258-326`) intercepts the Anthropic-shaped request and:

1. Extracts `system` (the `TextBlockParam[]` with `cache_control`) and flattens it to a single string by joining `.text` fields — **all `cache_control` metadata is discarded**
2. Sets `instructions: <flattened string>`
3. Sets `prompt_cache_key: CODEX_SESSION_ID` (a per-process UUID)
4. The dynamic boundary marker itself is already filtered out by `splitSysPromptPrefix`

**The ordering of content in `instructions` is correct** (stable prefix first, dynamic tail last) because the source array preserves order. But no OpenAI-specific caching knobs are applied beyond the session-scoped `prompt_cache_key`, and the adapter has no awareness of which content is stable vs dynamic.

### Where userContext and systemContext go

- `userContext` (CLAUDE.md, date) → prepended as a synthetic `user` message via `prependUserContext()` in `src/utils/api.ts:449`. This becomes the first `user` message before the real conversation. On Claude, it can receive a message-level `cache_control` breakpoint. On OpenAI, it becomes the first `input` item.
- `systemContext` (git status, cache breaker) → appended to the system prompt array via `appendSystemContext()`. This goes **after** the dynamic sections, making it the last part of the system prompt.

---

## Stability Analysis: What's Stable vs What Churns

### Stable across turns (within a session)

- Identity prefix (section 1)
- System rules (section 2)
- Doing tasks (section 3)
- Actions (section 4)
- Using tools (section 5)
- Tone & style (section 6)
- Output efficiency (section 7)
- Tool schemas (computed once, cached in `toolSchemaCache`)
- userContext (CLAUDE.md content, date — memoized)
- systemContext (git status — memoized)

### Stable across sessions (for same project/config)

- All static sections (1-7) — these are pure functions of build-time constants and settings
- Tool schemas (same tool set → same schemas)

### Potentially volatile

- MCP instructions (section 14) — explicitly `DANGEROUS_uncachedSystemPromptSection` because servers connect/disconnect between turns
- Memory prompt (section 9) — cached per session, but changes if user saves memories mid-session
- Session guidance (section 8) — reads runtime feature flags; stable in practice but not guaranteed

### Churn risks for caching

1. **MCP instructions** — the only explicitly volatile section. When MCP servers connect mid-session, this section changes and busts any prefix that includes it. Already post-boundary, so this is correctly handled for Claude. On OpenAI, since the entire `instructions` string is one blob, any MCP change busts the entire prefix cache.

2. **Tool schemas** — on Claude, the last tool in the array carries `cache_control`. Tool search (`defer_loading`) can change which tools are in the array, but deferred tools are stripped from the prefix. On OpenAI, tools are a separate array and don't affect `instructions` caching.

3. **systemContext appended to system prompt** — git status is memoized, so it doesn't churn turn-to-turn. But the cache breaker (ant-only debug feature) is intentionally volatile.

4. **Late-added instructions** (advisor, chrome tool search) — appended after the main prompt array but before serialization. These are session-stable once active.

---

## Design Recommendation

### Principle

Keep the existing logical split (static prefix / dynamic tail) and the `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` mechanism. Add a provider-dispatch layer at the serialization boundary so each provider's caching model is applied correctly.

### Architecture

```
getSystemPrompt()          → string[] with boundary marker
  ↓
QueryEngine.ts             → wraps with prefix, appends extras
  ↓
splitSysPromptPrefix()     → SystemPromptBlock[] (text + cacheScope)
  ↓
┌──────────────────────────────────────────────────┐
│ Provider dispatch point (new)                     │
│                                                   │
│  Claude path:                                     │
│    buildSystemPromptBlocks() (existing)            │
│    → TextBlockParam[] with cache_control           │
│                                                   │
│  OpenAI path:                                     │
│    buildOpenAISystemPrompt() (new)                 │
│    → { instructions: string,                       │
│         prompt_cache_key: string,                  │
│         prompt_cache_retention: string }            │
└──────────────────────────────────────────────────┘
```

### Claude path (existing, minor refinements)

The current implementation is already correct for Claude. The only refinement:

- **Move the dispatch earlier**: instead of building `TextBlockParam[]` in `buildSystemPromptBlocks()` and having the adapter strip them, skip `cache_control` annotation entirely when `getAPIProvider() === 'openai'`. This avoids wasted work and makes the adapter simpler.

- **Preserve `SystemPromptBlock[]`** as the provider-neutral intermediate format. Both paths consume it.

### OpenAI path (new)

Add a `buildOpenAISystemPrompt()` function (in `src/utils/api.ts` or a new `src/utils/api/openai.ts`) that:

1. Receives `SystemPromptBlock[]` from `splitSysPromptPrefix()`
2. **Joins static blocks** (those with `cacheScope !== null`) into a stable prefix string
3. **Joins dynamic blocks** (those with `cacheScope === null`, excluding attribution header) into a dynamic suffix string
4. Concatenates them with a clear separator: `<stable>\n\n<dynamic>`
5. Returns:
   ```ts
   {
     instructions: stablePrefix + '\n\n' + dynamicSuffix,
     prompt_cache_key: sessionCacheKey,       // existing CODEX_SESSION_ID
     prompt_cache_retention: 'in_memory',     // or '24h' for long sessions
   }
   ```

The Codex fetch adapter (`codex-fetch-adapter.ts`) would then:
- Accept the pre-built instructions string and cache params instead of extracting and flattening system blocks itself
- Stop discarding `cache_control` metadata (it would never receive it)

### Where provider dispatch should happen

**Option A (recommended): In `src/services/api/claude.ts` at the `queryAPI()` call site.**

`queryAPI()` (around line 1363-1384) is where `buildSystemPromptBlocks()` is called today. This is the last point before the request is serialized. Add a provider check:

```ts
const system = getAPIProvider() === 'openai'
  ? buildOpenAISystemBlocks(systemPrompt)
  : buildSystemPromptBlocks(systemPrompt, enablePromptCaching, { ... })
```

The Codex adapter would receive the OpenAI-shaped blocks and use them directly instead of re-parsing.

**Option B: In the Codex fetch adapter itself.**

The adapter already receives the full Anthropic request and translates it. It could consume `SystemPromptBlock[]` if passed through as metadata. This is less clean because it requires smuggling structured data through the fetch interception layer.

**Recommendation: Option A.** It's cleaner, avoids the metadata-smuggling problem, and keeps provider-specific logic in the API layer where it belongs.

### What each provider's caching path looks like

#### Claude (firstParty, bedrock, vertex)

```
Request shape:
  system: [
    { type: 'text', text: '<attribution>' },
    { type: 'text', text: '<CLI prefix>' },
    { type: 'text', text: '<static sections 1-7>', cache_control: { type: 'ephemeral', scope: 'global' } },
    { type: 'text', text: '<dynamic sections 8-20 + systemContext>' }
  ]
  messages: [
    { role: 'user', content: '<userContext (CLAUDE.md, date)>' },   ← cache_control on last message
    ...conversation
  ]

Caching model:
  - Explicit breakpoints at static/dynamic boundary
  - TTL: 5m default, 1h for long sessions
  - scope: 'global' for static (shared across orgs), 'org' for dynamic
  - tools carry cache_control on the last tool
  - Last message carries cache_control for message-level caching
```

#### OpenAI (codex)

```
Request shape:
  model: 'gpt-5.3-codex'
  instructions: '<static sections>\n\n<dynamic sections>'
  input: [
    { role: 'user', content: '<userContext>' },
    ...conversation (translated to function_call/function_call_output)
  ]
  tools: [...]
  prompt_cache_key: '<session UUID>'
  prompt_cache_retention: 'in_memory'

Caching model:
  - Automatic prefix caching (≥1024 tokens)
  - prompt_cache_key routes to same backend node
  - Stable prefix is stable because static content comes first
  - Dynamic content at the end means only the tail changes turn-to-turn
  - Tool array is separate and stable (tool search defers, not removes)
```

### What belongs where

| Content | Position | Rationale |
|---|---|---|
| Identity prefix | Stable prefix | Never changes within a session |
| System rules, doing tasks, actions, tools guidance, tone, output efficiency | Stable prefix | Pure functions of build constants |
| Tool schemas | Separate array (both providers) | Cached independently on Claude; separate `tools` param on OpenAI |
| SYSTEM_PROMPT_DYNAMIC_BOUNDARY | Stripped at serialization | Only meaningful as a split marker |
| Session guidance, memory, env info, language, output style | Dynamic tail | Session-specific but stable within session |
| MCP instructions | Dynamic tail (volatile) | Can change between turns |
| systemContext (git status) | Dynamic tail | Session-specific, memoized |
| userContext (CLAUDE.md, date) | First user message | Injected as synthetic message on both providers |
| Attribution header | Before everything (Claude) / omitted (OpenAI) | Billing, not behavioral |
| Advisor/chrome instructions | Dynamic tail (appended late) | Feature-gated additions |

### Provider-specific content

- `src/constants/system.ts` already has separate identity prefixes for Claude vs OpenAI (`DEFAULT_PREFIX` vs `OPENAI_DEFAULT_PREFIX`). This is correct and should remain.
- `computeSimpleEnvInfo()` already conditionally includes/excludes Claude model family info based on `apiProvider === 'openai'`. This is correct.
- The env info section includes `This session is running through the ${apiProvider} provider.` — correct.

No additional provider-specific prompt content changes are needed for this task. The provider dispatch is at the serialization layer, not the content layer.

---

## Risks

1. **Cache key stability during account rotation**: The Codex adapter resets `codexConversationId` on account rotation (`resetCodexCacheContext()`), but `CODEX_SESSION_ID` (used as `prompt_cache_key`) is per-process. If OpenAI routes by `prompt_cache_key`, account rotation should not bust the prefix cache. Verify this assumption.

2. **MCP instruction churn**: MCP instructions are the main source of mid-session prefix instability. On Claude, they're post-boundary and don't affect the global-scope cache. On OpenAI, they're part of the `instructions` string and any change busts the prefix. The `isMcpInstructionsDeltaEnabled()` path (which moves MCP instructions to per-message attachments) is the correct mitigation for both providers. Ensure this path works on OpenAI.

3. **Effort/reasoning config**: The Codex adapter translates `output_config.effort` to `reasoning.effort`. This doesn't affect prompt caching but is a per-request parameter that should not be embedded in `instructions`.

4. **Tool search interaction**: Claude's `defer_loading` strips deferred tools from the prefix before cache key computation. OpenAI's tool search injects discovered tools at the end of the context window. Both preserve cache. The current implementation handles Claude correctly; the OpenAI path doesn't use tool search yet. When it does, tools should go in the `tools` array (separate from `instructions`), not in the instructions string.

5. **Side question cache alignment**: `buildSideQuestionFallbackParams()` in `queryContext.ts` mirrors the main assembly to preserve cache hits. The provider dispatch must also apply there, or side questions will bust the cache on one provider.

---

## What to Ignore for This Task

- **Tool loop mechanics** (tool_use/tool_result vs function_call/function_call_output) — separate Phase 0 item
- **Thinking/reasoning persistence** — separate Phase 0 item
- **Instruction hierarchy** (system vs developer vs user roles) — separate Phase 0 item; but note that the `instructions` parameter on OpenAI is effectively the "developer" role, which is correct for our use case
- **Structured output schema differences** — separate Phase 0 item
- **Compaction** — separate concern; compaction operates on message history, not prompt prefix
- **Agent/subagent prompt assembly** — agents build their own system prompts via `src/tools/AgentTool/prompt.ts` and `src/tools/AgentTool/runAgent.ts`; the same dispatch principle applies but is a separate implementation slice

---

## Suggested Next Implementation Slice

**Slice 1: Provider-aware system prompt serialization**

1. Add `buildOpenAISystemBlocks()` in `src/utils/api.ts` (or new file) that consumes `SystemPromptBlock[]` and returns `{ instructions: string, cacheParams: { prompt_cache_key, prompt_cache_retention } }`
2. In `src/services/api/claude.ts:queryAPI()`, dispatch on `getAPIProvider()` to choose between `buildSystemPromptBlocks()` and `buildOpenAISystemBlocks()`
3. Modify `codex-fetch-adapter.ts:translateToCodexBody()` to accept pre-built instructions + cache params instead of re-parsing the system blocks
4. Verify: dump prompts for both providers and confirm prefix stability across turns

**Estimated touch points**: 3 files (`src/utils/api.ts`, `src/services/api/claude.ts`, `src/services/api/codex-fetch-adapter.ts`)

**Slice 2: Side question alignment**

1. Apply the same dispatch in `buildSideQuestionFallbackParams()` to ensure side questions match the main loop's serialization

**Slice 3: MCP delta path on OpenAI**

1. Verify `isMcpInstructionsDeltaEnabled()` works correctly on the OpenAI path
2. If MCP instructions still go through the system prompt on OpenAI, move them to the input array as a synthetic message (similar to `userContext`) so they don't bust the instructions prefix
