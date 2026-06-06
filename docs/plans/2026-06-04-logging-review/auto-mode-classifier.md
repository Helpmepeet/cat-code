# Logging review: Auto Mode & safety classifier

## Summary

The auto-mode classifier decides allow/block on every consequential tool call,
yet in production (non-ant, debug OFF) it leaves **no durable record of any
decision**. The path is heavily instrumented on paper — `tengu_auto_mode_decision`,
`tengu_auto_mode_outcome`, and `tengu_auto_mode_denial_limit_exceeded` carry rich
metadata, and the decision/fallback/fail-closed sites all call `logForDebugging`
— but in this fork `logEvent` (`src/services/analytics/index.ts:30`) and
`logOTelEvent` (`src/utils/telemetry/events.ts:9`) are **no-op stubs**, and
`logForDebugging` is suppressed for non-ant users with debug off
(`src/utils/debug.ts:121`) unless the message starts with a prefix in
`ALWAYS_LOG_PREFIXES` (currently only `[codex-cache]`). The `[auto-mode]` prefix
strings already present in `yoloClassifier.ts` are NOT in that allowlist, so they
are dropped too. The only surviving surfaces are in-memory and session-scoped:
`recordAutoModeDenial` (last 20 denials, shown in `/permissions`) and the
rejection message echoed into the transcript — neither persists past the session
nor is greppable from a log file, and **allows leave no trace at all**. The result:
a user reporting "auto mode blocked my harmless command" or "auto mode let through
something dangerous" cannot be diagnosed from logs without first reproducing under
`--debug`. Unlike the Codex cache domain (which has `recordPromptCacheBreak` JSONL
as a durable backstop behind its dead `logEvent`s), auto mode has no such backstop.
This is a real gap. The fix is surgical: add `[auto-mode]` to `ALWAYS_LOG_PREFIXES`
and ensure the four decision-outcome sites emit one always-on, leveled line each
(the prefix is already in use; most sites only need a level/wording touch-up, and
two need the line added outside the `isDebugMode()` guard).

## Findings

| Feature | Location | State | Recommendation |
|---|---|---|---|
| infra: always-log allowlist | `src/utils/debug.ts:110` | **gap** | `ALWAYS_LOG_PREFIXES = ['[codex-cache]']` is the only must-survive channel in this fork (both telemetry sinks are inert). Add `'[auto-mode]'`: `const ALWAYS_LOG_PREFIXES = ['[codex-cache]', '[auto-mode]']`. This is the enabling change for every finding below — without it, no auto-mode decision is durable in production. Rationale: the classifier is a per-tool-call security gate; its decisions are exactly the "must-survive diagnostic signal" the prefix mechanism exists for. |
| #76 block verdict (classifier said block) | `src/utils/permissions/permissions.ts:900-903` | **gap** | The actual block is logged `Auto mode classifier blocked action: ${reason}` at `warn` but with no prefix, so it is gated off in production. This is the primary "auto mode blocked my harmless command" signal. Change to: `logForDebugging(\`[auto-mode] blocked tool=${tool.name} model=${classifierResult.model} reason=${classifierResult.reason}\`, { level: 'warn' })`. Always-on prefix: **yes**. Rationale: the single most-reported failure shape; must be reconstructable (tool, model, reason) from a plain bug report. |
| #76 allow verdict (classifier said allow) | `src/utils/permissions/permissions.ts:932-944` | **gap** | The success path (`recordSuccess` + `behavior: 'allow'`) emits **no `logForDebugging` at all** — only the inert `logEvent`. A false negative ("auto mode let through something it shouldn't") therefore has zero production footprint. Add, before the `return` at 936: `logForDebugging(\`[auto-mode] allowed tool=${tool.name} model=${classifierResult.model} reason=${classifierResult.reason}\`, { level: 'info' })`. Always-on prefix: **yes**, level `info` (allows are higher-volume than blocks; `info` keeps them present without `warn`-level alarm). Rationale: without this, the false-negative case — the most dangerous one — is undiagnosable. |
| #76/#79 fail-closed block (classifier unavailable, iron gate closed) | `src/utils/permissions/permissions.ts:871-874` | **gap** | Logs `Auto mode classifier unavailable, denying with retry guidance (fail closed)` at `warn`, no prefix → gated off in prod. Add prefix + the model that failed: `logForDebugging(\`[auto-mode] fail-closed (classifier unavailable) tool=${tool.name} model=${classifierResult.model}\`, { level: 'warn' })`. Always-on prefix: **yes**. Rationale: a fail-closed block looks identical to a real block to the user; distinguishing "the model errored" from "the classifier decided no" is essential and currently impossible in prod logs. |
| #76 fail-open fallback (classifier unavailable, iron gate open) | `src/utils/permissions/permissions.ts:889-892` | **gap** | Logs `…falling back to normal permission handling (fail open)` at `warn`, no prefix → gated. This silently degrades auto mode to manual prompting on API errors. Add prefix: `logForDebugging(\`[auto-mode] fail-open (classifier unavailable, falling back to manual) tool=${tool.name} model=${classifierResult.model}\`, { level: 'warn' })`. Always-on prefix: **yes**. Rationale: explains "auto mode suddenly started prompting me" reports; without it the degradation is invisible. |
| #79 transient-failure model fallback (gpt-5.5 → gpt-5.4) | `src/utils/permissions/yoloClassifier.ts:971-974` | **gap** | The #79 broadened-transient fallback logs `Auto mode classifier model ${model} unavailable, retrying with ${fallbackModel}: ${err}` at `warn`, no prefix → gated in prod. This is the exact path #79 fixed; if it regresses (e.g. a status no longer matched), there is no production signal. Change to: `logForDebugging(\`[auto-mode] model fallback ${model}→${fallbackModel}: ${errorMessage(error)}\`, { level: 'warn' })`. Always-on prefix: **yes**. Rationale: the fallback firing (or NOT firing and instead fail-closing) is the only way to tell #79 still works in the field. |
| #79 transcript-too-long fallback to manual | `src/utils/permissions/permissions.ts:848-851` | **gap** | Logs `Auto mode classifier transcript too long, falling back to normal permission handling` at `warn`, no prefix → gated. Add prefix: `logForDebugging(\`[auto-mode] transcript-too-long, falling back to manual tool=${tool.name}\`, { level: 'warn' })`. Always-on prefix: **yes**. Rationale: a deterministic, recurring degradation (transcript only grows); deserves a durable, distinguishable signal separate from the generic unavailable path. |
| #76 classifier returned no/invalid result (parse failure) | `src/utils/permissions/yoloClassifier.ts:892-897, 916-921` | **gap** | Both parse-failure branches block for safety and log `Auto mode classifier: No tool use block found` / `Invalid response schema` at `warn`, no prefix → gated. These are fail-closed blocks indistinguishable from real blocks in prod. Prefix both: e.g. `logForDebugging(\`[auto-mode] parse failure (no_tool_use) model=${model} — blocking for safety\`, { level: 'warn' })` and `(invalid_schema)` for the second. Always-on prefix: **yes**. Rationale: a model/contract regression here silently turns into a wave of false blocks; needs a production footprint. |
| #76 denial-limit fallback to prompting | `src/utils/permissions/permissions.ts:1047-1050` | **gap** | Logs `Classifier denial limit exceeded, falling back to prompting: ${warning}` at `warn`, no prefix → gated. Lower severity (it surfaces a user-facing warning anyway), but for consistency add the prefix: `logForDebugging(\`[auto-mode] denial limit exceeded, falling back to prompting: ${warning}\`, { level: 'warn' })`. Always-on prefix: **yes**. Rationale: ties the "why did it start asking me again" warning to a greppable durable line; cheap given the prefix is already being added. |
| ant-only diagnostics (context comparison, API usage, dumps) | `src/utils/permissions/yoloClassifier.ts:790-806, 872-883`, `maybeDumpAutoMode` `154-181`, `dumpErrorPrompts` `215-256` | **adequate** | These are intentionally `isDebugMode()`-gated or ant-gated and are token/overhead/projection diagnostics, not decisions. The error-prompt dump is additionally surfaced to ants via `/share` and a notification (`permissions.ts:723-734`). Leave gated — promoting would be high-volume noise and they are not the allow/block signal. |
| missing-usage warn | `src/utils/permissions/yoloClassifier.ts:556-559` | **adequate** | Already uses the `[auto-mode]` prefix at `warn`; once the prefix is added to `ALWAYS_LOG_PREFIXES` it becomes durable for free. No further change. |

## Notes

- Root cause is one-line: in this fork both analytics (`logEvent`) and OTel
  (`logOTelEvent`) are inert stubs, so every `tengu_auto_mode_*` event and every
  `tool_decision` OTel event is dropped. `logForDebugging` is the only real sink,
  and it is gated off for non-ant + debug-off except for `ALWAYS_LOG_PREFIXES`.
- No over-logging found. The verbose context-comparison / per-call token
  accounting is correctly `isDebugMode()`-gated and should stay that way.
- Recommended change count: **1 infra line** (`debug.ts` allowlist) **+ ~9 log-site
  touch-ups** (add `[auto-mode]` prefix, and add two missing lines — the allow
  verdict at `permissions.ts:936` and confirm each decision/fallback site emits
  exactly one always-on line). All edits are prefix/wording/level only; no new
  logging framework, matching the existing `[codex-cache]` pattern.
- Suggested rollout: land the `debug.ts` allowlist change together with the
  decision-site prefixes in one commit so the always-on channel is never half-wired.
