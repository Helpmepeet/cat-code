# Fact-check audit: auto-mode-classifier.md & provider-routing-tools.md

Auditor pass against source at `/Users/pt/cat-code` on branch `phase1`.
No source or plan files were modified.

## Shared premise (both plans depend on it)

| Claim | Verdict | Note |
|---|---|---|
| `logEvent` (`src/services/analytics/index.ts:30`) is a no-op stub | **CONFIRMED** | `export function logEvent(...) {}` empty body at line 30-33. Whole module is an inert compatibility boundary ("all analytics become inert"). `logEventAsync` also empty. |
| `logOTelEvent` (`src/utils/telemetry/events.ts:9`) is a no-op stub | **CONFIRMED** | `export async function logOTelEvent(...) {}` empty body at line 9-12. |
| `logForDebugging` drops non-ant + debug-off messages unless prefix ∈ `ALWAYS_LOG_PREFIXES` (only `[codex-cache]`), `debug.ts` ~110-135 | **CONFIRMED** | `ALWAYS_LOG_PREFIXES = ['[codex-cache]']` at line 110. Gate at line 121: `if (USER_TYPE !== 'ant' && !isDebugMode() && !isAlwaysLog) return false`. Exact. |
| Interactive diagnostic sink (`main.tsx` ~937 → `logForDiagnosticsNoPII` → `diagLogs.ts` ~33) writes nothing unless `CLAUDE_CODE_DIAGNOSTICS_FILE` set | **CONFIRMED** | `main.tsx:936-950` installs the hook for interactive sessions, emitting via `logForDiagnosticsNoPII`. `diagLogs.ts:32-35`: `const logFile = getDiagnosticLogFile(); if (!logFile) return`. `getDiagnosticLogFile()` returns `process.env.CLAUDE_CODE_DIAGNOSTICS_FILE` (line 60). Exact. |

**Premise verdict: HOLDS in full.** All four claims confirmed. The plans' core rationale (these sinks are silent in a normal non-ant debug-off desktop session) stands.

## Plan 1 — auto-mode-classifier.md

| Claim / citation | Verdict | Note |
|---|---|---|
| `debug.ts:110` allowlist = `['[codex-cache]']` only | **VERIFIED** | Exact line. |
| block verdict `permissions.ts:900-903`, `warn`, no prefix | **VERIFIED** | `logForDebugging(\`Auto mode classifier blocked action: ${classifierResult.reason}\`, {level:'warn'})` at 900-903. (Plan body says `classifierResult.reason`; the snippet in the cell uses `classifierResult.reason` — matches.) |
| allow verdict `permissions.ts:932-944` emits no `logForDebugging`, only inert `logEvent` | **VERIFIED** | Success path 932-944 returns `behavior:'allow'` with no debug log; `recordSuccess`+persist only. Suggested insertion "before the `return` at 936" lands at the `return {behavior:'allow'...}` which begins at 936 — correct, executes on the allow path. |
| fail-closed block `permissions.ts:871-874`, `warn`, no prefix | **VERIFIED** | Exact text + lines. |
| fail-open fallback `permissions.ts:889-892`, `warn`, no prefix | **VERIFIED** | Exact text + lines. |
| model fallback `yoloClassifier.ts:971-974`, `warn`, no prefix | **VERIFIED** | Exact text + lines; recommended uses `errorMessage(error)` which is the actual helper in scope (line 972 uses it). |
| transcript-too-long fallback `permissions.ts:848-851`, `warn`, no prefix | **VERIFIED** | Exact text + lines. |
| parse-failure branches `yoloClassifier.ts:892-897, 916-921`, `warn`, no prefix, fail-closed block | **VERIFIED** | 892-897 (`No tool use block found`) and 916-921 (`Invalid response schema`) both `warn`, both `return shouldBlock:true`. Exact. |
| denial-limit fallback `permissions.ts:1047-1050`, `warn`, no prefix | **VERIFIED** | Exact text + lines. |
| ant-only diagnostics `yoloClassifier.ts:790-806, 872-883`, `maybeDumpAutoMode 154-181`, `dumpErrorPrompts 215-256`; `/share` notify `permissions.ts:723-734` | **VERIFIED** | 790-806 is `isDebugMode()`-gated context comparison; `maybeDumpAutoMode` def at 154; `dumpErrorPrompts` def at 215; ant `/share` notify at 723-734. All present & correctly characterized as gated/ant-only. |
| missing-usage warn `yoloClassifier.ts:556-559` already uses `[auto-mode]` prefix, becomes durable for free | **VERIFIED** | 556-559: `logForDebugging(\`[auto-mode] classifier_missing_usage ...\`, {level:'warn'})`. Prefix already present; claim exact. |

**Defect scan:** No double-logging — each recommended site is a distinct branch that returns/continues, so exactly one line fires per path. No hot loop (model fallback is bounded by retry/`continue`, not per-stream). No PII leak — recommended payloads are `tool.name`, `classifierResult.model`, and `classifierResult.reason` (a short classifier verdict string, not prompt/file content). The allow line is `info`-leveled to avoid `warn` spam on the steady-state path. Adding `[auto-mode]` to `ALWAYS_LOG_PREFIXES` will also promote the already-present 790-806 lines, but those are `isDebugMode()`-gated *before* `logForDebugging` is called, so they stay debug-only — no accidental promotion. Clean.

**Plan 1 recommendation: implement as-is.** Every citation is exact, the current-state claims are accurate, and the recommended edits are surgical and consistent with the `[codex-cache]` pattern. No defects.

## Plan 2 — provider-routing-tools.md

| Claim / citation | Verdict | Note |
|---|---|---|
| sink `accountDiagnostics.ts:421-441` (`emitAccountDiagnostic`) | **VERIFIED** | Exact. |
| interactive emitter `main.tsx:937-950` → `logForDiagnosticsNoPII` | **VERIFIED** | Exact. |
| `diagLogs.ts:32-35` no-op unless env set | **VERIFIED** | Early return at 33-35. |
| producer `client.ts:324` `emitProviderMismatchDiagnostic` | **VERIFIED** | Exact line. |
| producers `client.ts:346-352 / 527-533` `emitRouteSelectedDiagnostic` | **VERIFIED** | Both blocks exact (Codex-OAuth path 346-352, Codex-subscriber path 527-533). |
| add breadcrumb "right after `resolveRequestProvider` (line 323)" | **VERIFIED (minor snippet bug)** | `resolveRequestProvider(model, provider)` is at line 323; `resolvedProvider` exists from there. **However** the proposed level ternary references `requestedProvider` — that variable does not exist; the requested provider param is named `provider` (the body string correctly uses `requested=${provider ?? 'session'}`). Implementer must use `provider`, not `requestedProvider`, in the ternary. One-token fix, not a design flaw. |
| insights facet `insights.ts:1082` (no tool_use), `1085` (safeParse fail) return null, no log, bypass catch@1089 | **VERIFIED** | 1082 `return null`, 1085 `return null`, `catch` with `logError` at 1089. Both non-throw branches truly silent. |
| insights section `insights.ts:1717` (no tool_use) returns `{result:null}`, no log; catch@1718 logs | **VERIFIED** | 1717 exact; catch `logError` at 1719. |
| call-ID fail-fast `codex-fetch-adapter.ts:684-690` throws; sole-pending reuse 678-680 at debug | **VERIFIED** | Exact message text + lines. |
| schema remap `openaiSchemaCompat.ts:29-78`; reverse-map guard `!(original in normalizedInput)`; gate `api.ts:613-617` on `getAPIProvider()` | **VERIFIED (path drift)** | Content exact: rename fns 29-78, reverse-map guard at line 70, `getAPIProvider()==='openai'` gate at `api.ts:613`, `normalizeToolInput` at 608. **BUT the plan omits the directory:** real paths are `src/utils/openaiSchemaCompat.ts` and `src/utils/api.ts`, not `src/services/api/...`. Files & lines otherwise correct. |
| WebSearch `codex-fetch-adapter.ts:517-521` throws on `blocked_domains` | **VERIFIED** | Exact message + lines. |
| Codex-unavailable `client.ts:191-218` throws `APIConnectionError` | **VERIFIED** | `emitCodexUnavailableDiagnostic` at 191, `throwNoHealthyCodexAccount` at 214; throw is the durable signal as claimed. |

**Defect scan:** The provider breadcrumb is placed at the single `getAnthropicClient` chokepoint (one line per client construction, not per stream event) — not a hot loop, no PII (source/model/provider enums only). The three insights `logError` additions land on the silent non-throw branches and match the sibling `catch` `logError` level — no double-log (the catch only fires on throw, these only on the no-tool-use/parse-fail return). No PII (messages name the tool and provider, not session content). `logError` surfaces via `getInMemoryErrors()` as claimed. The "adequate, no-change" cells (call-ID, schema remap, WebSearch, Codex-unavailable) are correctly assessed.

**Plan 2 recommendation: implement with two minor fixes.**
1. In the provider breadcrumb snippet, replace `requestedProvider` with `provider` in the level ternary (the variable in scope).
2. Correct the schema-compat citation paths to `src/utils/openaiSchemaCompat.ts` and `src/utils/api.ts` (currently implied under `src/services/api/`). Content/lines are right.
Neither affects the plan's logic or rationale.

## Bottom line

- Shared premise: **holds in full** — both telemetry sinks are inert stubs, `logForDebugging` is prefix-gated to `[codex-cache]` only, and the interactive diag sink is silent without `CLAUDE_CODE_DIAGNOSTICS_FILE`.
- Plan 1 (auto-mode): **sound, implement as-is.** All 11 citations exact, current-state claims accurate, edits surgical, no defects.
- Plan 2 (provider): **needs two minor fixes** — a one-token variable-name correction in the proposed breadcrumb (`requestedProvider`→`provider`) and a wrong directory prefix on the schema-compat citation (`src/services/api/` → `src/utils/`). No logic defect, no PII/double-log/hot-loop risk.
