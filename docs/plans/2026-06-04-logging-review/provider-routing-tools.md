# Logging review: Provider-aware routing, prompts, tool contracts & call-ID state

## Summary

This domain is mostly well structured but has one systemic production-visibility
hole and one cluster of silent-null sites that together cover exactly the
#71/#72-class bug ("my request silently went to the wrong provider → empty
result"). The provider-routing surface in `client.ts` is richly instrumented with
structured `emitAccountDiagnostic` events (`model.provider_mismatch`,
`account.route.selected`, plus the Codex-unavailable error path), but **in an
interactive desktop session every one of those events terminates in a no-op.**
The only interactive sink (`main.tsx:937`) forwards to `logForDiagnosticsNoPII`,
which writes **nothing unless `CLAUDE_CODE_DIAGNOSTICS_FILE` is set** — a
container/managed-environment variable that an ordinary user does not have. So a
normal user who is silently routed to the wrong provider gets no route record at
all (the one exception is total Codex unavailability, which throws a clear error).

Separately, the #71/#72/#25 /insights path returns `null` on the "model returned
no tool_use" and "structured output failed schema parse" branches with no log on
the non-throwing branches — the exact shape that produced the original "No data"
incident. The thrown-error paths (#24 call-ID fail-fast, #61 WebSearch
unsupported-option, the insights `catch` blocks) are adequate, and the #22/#28
schema key remap is deterministic with no failure mode and correctly needs no
logging. Recommendations below are deliberately narrow: one always-on routing
breadcrumb and three cheap warn-level logs on the silent-null insights branches.

## Findings

| Feature | Location | State | Recommendation |
|---|---|---|---|
| #28/#71/#72 provider-route diagnostics never reach a desktop user | `accountDiagnostics.ts:421-441` (sink), `main.tsx:937-950` (interactive emitter), `diagLogs.ts:32-35` (no-op unless env set); producers at `client.ts:324` (`emitProviderMismatchDiagnostic`), `client.ts:346-352 / 527-533` (`emitRouteSelectedDiagnostic`) | **gap** | The structured diagnostics exist but in interactive mode flow only to `logForDiagnosticsNoPII`, which `return`s early when `CLAUDE_CODE_DIAGNOSTICS_FILE` is unset (`diagLogs.ts:33-35`) — i.e. nothing for a normal user with debug off. A user cannot answer "did this request go to Codex or Anthropic?" from any artifact. Add one always-on breadcrumb at the single chokepoint where the provider is resolved, in `client.ts` right after `resolveRequestProvider` (line 323): `logForDebugging(`[provider-route] source=${source} model=${model ?? 'default'} requested=${provider ?? 'session'} resolved=${resolvedProvider}`, { level: requestedProvider && requestedProvider !== resolvedProvider ? 'warn' : 'info' })`. Use the `[provider-route]` ALWAYS_LOG prefix (add to `ALWAYS_LOG_PREFIXES` in `debug.ts:110`). Rationale: this is the single highest-value gap in the domain — it is the only durable record of where each request was actually routed, and it makes the #71/#72 misroute class diagnosable from a production bug report. Keep it to one line per `getAnthropicClient` call (model + resolved provider + source), not per stream event. |
| #71/#72/#25 /insights facet extraction silently returns null | `insights.ts:1082` (no tool_use block), `insights.ts:1085` (schema `safeParse` failed) | **gap** | Both branches `return null` with no log when the side query *succeeded* but the result was unusable — the model returned no `tool_use` block, or returned one that failed `sessionFacetsSchema().safeParse`. This is the non-throwing twin of the original misroute incident (wrong provider → model ignores the forced tool → empty insights), and it bypasses the `catch` at 1089 entirely. Add before each `return null`: 1082 → `logError(new Error(`Facet extraction: no ${insightsToolName} tool_use in response (provider=${resolveRequestProvider(getAnalysisModel(), 'firstParty')})`))`; 1085 → `logError(new Error(`Facet extraction: ${insightsToolName} output failed schema validation`))`. `logError` (in-memory + debug) is the right level here — it matches the sibling `catch` blocks and surfaces in `getInMemoryErrors()` for bug reports without new infrastructure. No new prefix. Rationale: closes the exact silent-empty-result shape that #71/#72 were filed for. |
| #25/#26 /insights section generation silently returns null | `insights.ts:1717` (no tool_use block) | **gap** | Mirrors the above on the parallel-insights path: `return { name: section.name, result: null }` with no log when the side query returned no `tool_use`. The `catch` at 1718 logs, but this non-throw branch does not. Add before 1717: `logError(new Error(`Insights section "${section.name}": no ${insightsToolName} tool_use in response`))`. `logError` level, no new prefix. Rationale: a section that silently produces no result renders as a blank/"No insights" panel with no trail. |
| #24 GPT-native call-ID fail-fast | `codex-fetch-adapter.ts:684-690` (throw on ambiguous/orphaned tool_result) | **adequate** | The fail-fast throws an `Error` whose message names the exact reason (`no pending function_call remains` vs `N pending function_call items remain`). It bubbles up as a request failure rather than fabricating a positional ID, and the message carries enough context to diagnose. The sole-pending-reuse fallback (line 678-680) logs at debug, which is fine. No change. |
| #22/#28 OpenAI GrepTool key remap + reverse-map | `openaiSchemaCompat.ts:29-78`, applied outbound via `n`/`toolToAPISchema` and inbound via `normalizeToolInput` (`api.ts:613-617`) | **adequate** | Pure deterministic mapping with no failure mode: a missing key is a no-op, and the reverse-map guards against clobbering (`!(original in normalizedInput)`). There is no error condition to log; adding logging here would be over-logging. (Noted for the owner, not a logging item: the inbound reverse-map at `api.ts:613` gates on session-level `getAPIProvider()` rather than the per-request resolved provider — a correctness nuance, out of scope for this review.) |
| #61 WebSearch on OpenAI/Codex | `codex-fetch-adapter.ts:517-521` (throw on unsupported `blocked_domains`) | **adequate** | The one unsupported-option path throws a clear, actionable `Error` ("does not support blocked_domains; use allowed_domains"). The normal translation has no failure mode. No change. |
| Codex-unavailable route failure | `client.ts:191-218` (`emitCodexUnavailableDiagnostic` + `throwNoHealthyCodexAccount`) | **adequate** | Unlike the info/warn route diagnostics, this path additionally **throws** an `APIConnectionError` with a clear message, so the user sees a real failure rather than a silent wrong-provider fallthrough. The structured diagnostic is best-effort; the thrown error is the durable signal. No change. |

## Notes

- No over-logged findings in this domain. The existing `emitAccountDiagnostic`
  events are appropriate for SDK/headless/bridge consumers (where real sinks are
  installed in `cli/print.ts`, `initReplBridge.ts`, `AppSessionController.ts`);
  the gap is specifically the interactive desktop path, which the proposed
  `[provider-route]` always-on line addresses without disturbing the structured
  stream-json contract.
- The two recommended prefixes/levels reuse existing machinery only:
  `[provider-route]` via the established `ALWAYS_LOG_PREFIXES` pattern (sibling
  `[codex-cache]`), and `logError` for the insights silent-null sites to match
  the adjacent `catch` blocks. No new logging framework is introduced.
