# P2-2 flag: `mcp_tool_use`/`mcp_tool_result` are unpinned in the SDK types

**Status: FLAGGED, not blocking.** Found while building the P2-2 tool-card correlation pass
(`app/renderer/src/transcriptProjector.ts`).

## What's real

`src/utils/messages.ts` explicitly switches on `mcp_tool_use` (`:1319-1320` orphan-detection)
and `mcp_tool_result` (`:2762`, `:3140`) as real content-block discriminants the engine's own
consumers handle. Correlation for them must exist.

## What's missing

The pinned `@anthropic-ai/sdk` package version vendored in this repo's `node_modules` does **not**
include `mcp_tool_use`/`mcp_tool_result` in its public `ContentBlock` (`messages.d.mts:435`) or
`ContentBlockParam` unions — only `server_tool_use` and its six sibling result types
(`web_search_tool_result`, `code_execution_tool_result`, `bash_code_execution_tool_result`,
`text_editor_code_execution_tool_result`, `tool_search_tool_result`, `web_fetch_tool_result`)
are typed. This means:

- The engine's own `Content*` types (`ContentBlockParam` re-exported from the SDK,
  `src/entrypoints/sdk/coreTypes.generated.ts:1`) don't statically model these two block types
  either — they must be arriving as untyped/beta wire shapes the engine's `unknown`-typed content
  arrays tolerate at runtime, same as every other content block on this seam.
- I could not add an `mcp_tool_use`/`mcp_tool_result` fixture sample typed against
  `SDKMessage`/`ContentBlockParam` without a cast (a `tool_result`-shaped `mcp_tool_result` sample
  was attempted and removed — `tsc` correctly rejected the literal, `TS2820`).

## What P2-2 did instead

`transcriptProjector.ts`'s `isToolResultBlockType`/`projectAssistantContentBlock` switches
already include `'mcp_tool_use'`/`'mcp_tool_result'` as string literals matched against the
runtime-narrowed `block.type` (no compile-time union membership required — blocks are `unknown[]`
by design, `coreTypes.generated.ts:96`). Correlation and family derivation (`'mcp'` via the
`mcp__<server>__<tool>` name prefix) both work at runtime for these block types today; only the
**fixture sample** coverage for this specific pair is missing, because the fixture's mapped-type
tripwire requires a real, type-checking `SDKMessage` literal and none exists for this pair without
widening the SDK version or adding a cast (neither of which is in scope here).

## Recommendation

Not a blocker for P2-2 (correlation logic already tolerates and handles these block types by
name, same as the schema-drift tolerance the P2-0 tripwire already covers). If a future session
wants explicit fixture/test coverage for `mcp_tool_use`/`mcp_tool_result` specifically (as opposed
to relying on the generic drift-tolerance tests), the fix is upgrading the vendored
`@anthropic-ai/sdk` version to one whose public types include these two block shapes — not a
projector code change.
