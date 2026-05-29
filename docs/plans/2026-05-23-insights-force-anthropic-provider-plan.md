# Plan: Force Anthropic Provider for `/insights` Facet Extraction

**Date:** 2026-05-23
**Branch:** phase1
**Status:** Draft (pending review)

## Problem

`/insights` errors with:

> Could not extract any usage insight facets. Check network/account status and rerun /insights.

Root cause (confirmed in current session):

1. [src/commands/insights.ts:1014](../../src/commands/insights.ts:1014) calls `sideQuery({ model: getAnalysisModel() /* claude-opus-4-6 */ })` and [src/commands/insights.ts:1673](../../src/commands/insights.ts:1673) does the same with `getInsightsModel()`.
2. Inside [src/utils/sideQuery.ts:126](../../src/utils/sideQuery.ts:126), `resolveRequestProvider('claude-opus-4-6')` returns the caller-supplied provider, or falls back to `getAPIProvider()`. For Claude-family model IDs, `getProviderForModel` returns `null`, so the session provider wins.
3. The user's `~/.cat-code/.cat-code.json` has `"lastUsedProvider": "openai"` (set after the last successful run). So `getAPIProvider()` returns `'openai'`.
4. `sideQuery` then attaches `_openaiInstructionAssembly`, the Codex adapter remaps `claude-opus-4-6` → `gpt-5.5` ([codex-fetch-adapter.ts:335](../../src/services/api/codex-fetch-adapter.ts:335)), and the call is sent to OpenAI/Codex. The facet schema + forced tool_choice combination silently fails (or the account/quota rejects it).
5. Every call returns `null` via the `catch` block in `extractFacetsFromAPI`. The new `extractMissingFacetsForInsights` throws when zero facets succeed ([insights.ts:1126-1130](../../src/commands/insights.ts:1126)).

This branch's new `loadLogForFacetExtraction` flow also widens the impact: previously, only freshly-parsed sessions were eligible for extraction. Now every uncached-facet session is queued, so a single misrouted provider turns into "0 of 50 succeeded" → guaranteed throw.

## Goal

`/insights` should always run its Claude-only prompts against the Anthropic provider, regardless of the user's current session/global provider preference. The user's Codex/OpenAI session selection should not break a Claude-specific analysis pipeline.

## Non-goals

- Do not redesign the provider-resolution system.
- Do not change behavior of any other `sideQuery` caller (memdir search, permission explainer, agentic session search, validate model, autoMode, claudeInChrome MCP server).
- Do not silently route GPT models — if a caller explicitly passes a `gpt-*` model, that still routes to OpenAI.
- Do not touch facet caching, the meta-session filter, or `extractMissingFacetsForInsights` throw behavior.

## Design

Add an **opt-in provider override** to `sideQuery`. Default behavior unchanged. The insights command opts in for facet extraction and section generation.

### Step 1 — Extend `SideQueryOptions`

In [src/utils/sideQuery.ts](../../src/utils/sideQuery.ts):

```ts
export type SideQueryOptions = {
  // ...existing fields...
  /**
   * Optional provider override. When set, this call ignores the session/global
   * provider preference (`getAPIProvider()`) and routes to the given provider.
   * Use when the prompt or tool schema is provider-specific (e.g. Claude tool
   * use with a forced `tool_choice`) and must not be misrouted to Codex/OpenAI
   * just because the user last selected an OpenAI model.
   *
   * GPT-prefixed model IDs still route to OpenAI regardless of this override
   * (existing `getProviderForModel` behavior).
   */
  provider?: APIProvider
}
```

Import `APIProvider` from `./model/providers.js` (already imported for `resolveRequestProvider`).

### Step 2 — Plumb the override through

Inside `sideQuery`:

```ts
const provider = resolveRequestProvider(model, opts.provider)
```

`resolveRequestProvider(model, baseProvider)` already does the right thing:
- If `model` starts with `gpt-`, returns `'openai'` (unchanged).
- Otherwise returns the explicit `baseProvider` if given, else falls back to `getAPIProvider()`.

Then pass that `provider` to `getAnthropicClient({ ..., provider })` (already wired — line 130).

The `_openaiInstructionAssembly` injection at lines 184–192 keys off the resolved `provider === 'openai'`, so it auto-disables when we force `firstParty`. No additional change needed.

### Step 3 — Opt insights into the override

In [src/commands/insights.ts](../../src/commands/insights.ts):

- `extractFacetsFromAPI` at line 1014: add `provider: 'firstParty'` to the `sideQuery` call.
- `generateSectionInsight` at line 1673: add `provider: 'firstParty'` to the `sideQuery` call.

Both calls use Claude-only models, Claude tool_use semantics, and a forced `tool_choice` that depends on Anthropic's schema. Pinning them is correct.

Import `APIProvider` type — not needed, we pass a string literal.

### Step 4 — Tests

In [src/utils/sideQuery.test.ts](../../src/utils/sideQuery.test.ts):

- Existing test (`includes OpenAI instruction assembly for Codex-routed requests`) stays as-is.
- Upgrade the mock to spy on `getAnthropicClient` arguments so we can assert the resolved `provider` value reaches the client factory, not just the request body.
- Add: `respects explicit provider override for Claude models`.
  - Set `process.env.CLAUDE_CODE_USE_OPENAI = '1'` (forces session provider = openai).
  - Call `sideQuery({ model: 'claude-opus-4-6', provider: 'firstParty', ... })`.
  - Assert: `capturedBody._openaiInstructionAssembly` is `undefined`.
  - Assert: the captured `getAnthropicClient` call received `provider: 'firstParty'`.
  - Restore env var afterwards.
- Add: `forwards provider override even when openai is the session preference`.
  - Same setup as above with a different model (e.g. `claude-sonnet-4-6` to cover the section-insights path).
  - Same assertions. This is cheap insurance that both insights call sites are protected.

In [src/commands/insights.test.ts](../../src/commands/insights.test.ts):

- This file currently only tests `extractMissingFacetsForInsights` with injected fakes — it doesn't exercise the real `sideQuery` path. No new test needed here; the behavior is covered at the `sideQuery` layer.

## Files touched

- [src/utils/sideQuery.ts](../../src/utils/sideQuery.ts) — add `provider?: APIProvider` field; thread it into `resolveRequestProvider(model, opts.provider)`.
- [src/commands/insights.ts](../../src/commands/insights.ts) — add `provider: 'firstParty'` to both `sideQuery` call sites.
- [src/utils/sideQuery.test.ts](../../src/utils/sideQuery.test.ts) — add one test for the override.

Three files total. No new exports beyond the new optional field.

## Verification

1. **Build:** `bun run build:dev:full`.
2. **Unit tests:** `bun test src/utils/sideQuery.test.ts src/commands/insights.test.ts`.
3. **Manual repro:**
   - Confirm `~/.cat-code/.cat-code.json` still has `"lastUsedProvider": "openai"`.
   - Run `/insights` end-to-end. Expect: facets are extracted, report generated, no error banner.
   - Spot-check that new files appear under `~/.claude/usage-data/facets/` for previously-uncached sessions.
4. **Regression check:** confirm GPT-routed `sideQuery` tests still pass — the `gpt-5.5` test in `sideQuery.test.ts` still injects `_openaiInstructionAssembly`, because `getProviderForModel('gpt-5.5')` returns `'openai'` regardless of any override.

## Risks & trade-offs

- **Footgun: other Claude-only `sideQuery` callers.** [findRelevantMemories.ts:107](../../src/memdir/findRelevantMemories.ts:107) (uses `getDefaultSonnetModel()`) has the **identical latent bug**. `agenticSessionSearch`, `permissionExplainer`, `validateModel`, `autoMode`, `claudeInChrome` MCP server may also misroute depending on the model they're passed. This plan does NOT fix them. Recommend: explicit opt-in here, **spawn a follow-up task to fix `findRelevantMemories` the same way**, and let the others surface organically.
- **Explicit-better-than-implicit:** the override is at the call site, so future readers see "this call is Claude-only" inline.
- **3P providers (Bedrock/Vertex/Foundry):** scope explicitly excluded — not a target user for this feature. We hard-pin to `firstParty`.
- **Quota/billing:** Pinning to firstParty means /insights consumes the user's Anthropic credentials even when they're "primarily on OpenAI". That's the right behavior for a Claude-analysis feature.

## Out of scope (future)

- A broader fix where Claude-family model IDs default to `firstParty` unless the caller opts into the session provider. That would invert today's behavior — bigger change, separate review.
- Surfacing a more actionable error when the upstream API fails (currently the catch in `extractFacetsFromAPI` swallows the underlying error string into the generic "Facet extraction failed" log line).
- Fixing the other Claude-only `sideQuery` callers — tracked as separate follow-ups.
