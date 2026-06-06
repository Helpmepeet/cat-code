# Logging / observability review of completed work — 2026-06-04

A per-domain audit of the finished tasks in `DONE.md`, asking one question of each:
**when this code path fails or mis-behaves in production (non-ant user, debug mode OFF),
is there enough log signal to diagnose it?**

The bar is the existing `[codex-cache]` always-log prefix in `src/utils/debug.ts`
(`ALWAYS_LOG_PREFIXES`), which bypasses the non-ant debug gate so critical diagnostic
signal survives in a bug report. Plain `logForDebugging(...)` and the no-op `logEvent` /
`logOTelEvent` telemetry stubs write **nothing** for a normal user — that is the recurring
root cause behind most gaps below.

One reviewer per domain produced each plan. Every recommendation is surgical (a prefix,
a level, or one missing call site) — no new logging framework.

## Audit status (2026-06-04)

Three independent fact-checker subagents verified every plan's `file:line` citations and
"silent in production" claims against source. The shared premise held in full: `logEvent`
and `logOTelEvent` are no-op stubs, `ALWAYS_LOG_PREFIXES = ['[codex-cache]']`, the interactive
diagnostic sink is no-op unless `CLAUDE_CODE_DIAGNOSTICS_FILE` is set, and `logError` *does*
feed the in-memory bug-report log (so logError-based catches are production-diagnosable — true
for the default config; bypassed under Bedrock/Vertex/Foundry/`DISABLE_ERROR_REPORTING`).

Per-plan audit verdict (see `_audit-*.md`):

| Plan | Audit verdict | Fixes needed before implementing |
|------|---------------|----------------------------------|
| auto-mode-classifier | **Implement as-is** | none — all 11 cites exact |
| subagents-agent-mode | **Implement as-is** | none — cites exact, validateInput-probe justification confirmed |
| codex-transport-cache | **Implement as-is** | none (nit: `setup.ts` → `src/setup.ts`) |
| codex-accounts-leasing | **Implement as-is** | none — confirmed no token/secret leak (uses `truncId()`/`.slice`) |
| provider-routing-tools | **Minor fixes** | snippet var `requestedProvider` → `provider`; schema paths are `src/utils/openaiSchemaCompat.ts`/`src/utils/api.ts` not `src/services/api/` |
| context-compaction-goals | **Minor fixes** | field-add lands at ~`compact.ts:676+` (after `truePostCompactTokenCount` is computed), not 636; relabel `src/utils/messages.ts` |
| apply-patch-editing | **Minor fixes** | one overstatement (`logError` already lands the human cause in bug reports — real gap is structured `.code` + fuzzy-success invisibility); rollback log must use basename not `errorMessage(error)` (path leak); fuzzy-tier snippet assumes an indexed loop the source lacks |

No double-log, double-persist, hot-loop, or token/secret-leak defects were found in any plan.

## Domains & verdicts

| Plan | Domain | Verdict | Headline gap |
|------|--------|---------|--------------|
| [auto-mode-classifier.md](auto-mode-classifier.md) | Auto Mode & safety classifier | **Gaps (high)** | Every allow/block decision is invisible in production — both telemetry sinks are no-op stubs and no `[auto-mode]` always-log prefix exists. False-negative *allows* leave zero trace. |
| [provider-routing-tools.md](provider-routing-tools.md) | Provider routing, prompts, tool/call-ID contracts | **Gaps (high)** | Wrong-provider routing has no durable record in interactive sessions (diagnostic sink is container-only); `/insights` silent-`null` branches (#71/#72 class) don't log. |
| [subagents-agent-mode.md](subagents-agent-mode.md) | Subagents, Agent Mode, worker lifecycle | **Gaps (med)** | The #81 silent-capability-gap class: `invalidTools` (declared-but-unwired tools) is discarded at spawn with no log; resume/worker-failure causes miss the in-memory error log. |
| [apply-patch-editing.md](apply-patch-editing.md) | GPT-native apply_patch / file editing | **Gaps (med)** | FilePatchTool has zero domain logging; fuzzy-tier-success and failure root-cause (`.code`) are discarded. Lightweight log version of the telemetry #69 deferred. |
| [codex-accounts-leasing.md](codex-accounts-leasing.md) | Codex accounts, leasing, rotation | **Gaps (med)** | Critical account/lease state transitions (cap via lease, pool exhaustion, lease reassign, orphaned-lease fallback) route only through `emitAccountDiagnostic`, a REPL no-op. |
| [context-compaction-goals.md](context-compaction-goals.md) | Context, compaction, goals, cache warnings | **Gap (low)** | Compaction boundary records pre-compact size only; post-compact size + threshold aren't persisted, so autocompact thrash (#59 class) has no durable footprint. |
| [codex-transport-cache.md](codex-transport-cache.md) | Codex transport & prompt cache | **Mostly adequate** | Well-instrumented via `[codex-cache]` + JSONL. One gap: the "caching never turned on at all" branch logs only under a debug-gated prefix and returns before JSONL persistence. |

## Cross-cutting theme

Five of seven domains share the same root cause: **production-critical state transitions and
decisions are logged with calls that are silent for normal users** — either debug-gated
`logForDebugging` without an always-log prefix, no-op analytics/telemetry stubs
(`logEvent` at `src/services/analytics/index.ts`, `logOTelEvent` at
`src/utils/telemetry/events.ts`), or `emit*Diagnostic` sinks that only fire under
stream-json SDK / an env-var-gated diagnostics file. The consistent fix is to adopt the
`[codex-cache]` always-log-prefix pattern for the narrow set of must-survive events per
domain (proposed prefixes: `[auto-mode]`, `[provider-route]`, `[subagent]`,
`[apply-patch]`, `[codex-account]`, `[compaction]`).

The Codex transport/cache domain is the model to imitate — it already pairs an always-log
prefix with session-JSONL persistence, so its failures are diagnosable from a bug report.

## Status

Review and planning only. **No source was modified.** Each plan lists concrete,
surgical edits; none have been implemented.
