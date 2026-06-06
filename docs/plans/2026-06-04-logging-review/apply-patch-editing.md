# Logging review: GPT-native apply_patch / file editing

## Summary

The FilePatchTool / V4A subsystem (`src/tools/FilePatchTool/`) has **zero
domain-specific logging** — `applier.ts`, `parser.ts`, and `FilePatchTool.tsx`
contain no `logForDebugging` / `logAntError` / `logError` calls. Failure modes
are surfaced *only* by throwing a `FilePatchError` whose message goes back to
the model. Two production-observability gaps follow directly from this, and both
land exactly where plan #69 said "Phase 0 failure telemetry... remains unbuilt":

1. **Fuzzy-tier success is completely invisible.** When a hunk applies via a
   lenient match tier (`trimEnd`, `trim`, `unicodeNormalize`) or via the
   EOF tail→full-scan fallback (`applier.ts:240-273`), there is **no record
   anywhere** — not in debug logs, not in analytics — that the exact match
   failed and a fuzzy tier rescued it. This is precisely the "2-4 attempts /
   sloppy edit succeeded anyway" symptom, and today it is **unmeasurable**.

2. **Failure root-cause is not durably recorded in production.** A fully-failed
   patch throws out to the generic tool-error catch
   (`toolExecution.ts:1645-1652`), which logs via plain `logForDebugging`
   (debug-gated → lost for non-ant users with debug off) and emits
   `tengu_tool_use_error` with `error: classifyToolError(...)` =
   `'FilePatchError'` — the rich `.code`
   (`PATCH_ANCHOR_NOT_FOUND` vs `PATCH_ANCHOR_AMBIGUOUS` vs the changed-on-disk
   variant) is **discarded** (`classifyToolError` returns only `error.name`,
   `toolExecution.ts:156-167`). So in production you can tell *an* apply_patch
   failed, but not *why*.

The surgical fix is a single always-on `[apply-patch]` prefix (added to
`ALWAYS_LOG_PREFIXES` in `src/utils/debug.ts:110`) carrying the structured
outcome — match tier + cause `.code` + path basename. This is a lightweight,
log-based realization of the deferred Phase-0 telemetry and is the right fix:
it needs no eval-suite driver, no analytics schema change, and survives a
production bug report. Everything below is one prefix and ~4 call sites.

> Note on PII: log the path **basename only** (not full path) and **never**
> log file contents or hunk text — match tier names and error codes are safe;
> raw lines are not. The recommendations below follow this.

## Findings

| Feature | Location | State | Recommendation |
|---|---|---|---|
| #69 fuzzy-tier-used (the "2-4 attempts" symptom) | `applier.ts:253-258` (success return inside `findHunkPosition`) | **gap** | The tier loop returns the moment a tier matches with no record of *which* tier or whether it was the non-exact path. Add, right before `return matches[0]` at line 257, a tier-aware log keyed off the `matchFn` index and search pass. Concretely, capture the tier index `t` and pass `p` in the loop and, when `t > 0 \|\| searchStart > 0` (i.e. not the strict first-pass exact match), emit: `logForDebugging(`[apply-patch] fuzzy match: tier=${['exact','trimEnd','trim','unicode'][t]} pass=${searchStart === 0 ? 'scan' : 'tail'} hunk=${hunkIndex} file=${basename(path)}`, { level: 'info' })`. Rationale: this is the *only* way to measure how often lenient matching is silently rescuing sloppy hunks — the core diagnostic #69 deferred. Exact first-pass matches (the common case) stay silent, so volume is low. |
| #32 anchor not found | `applier.ts:294-297` | **gap** | The throw is the only signal; in prod (non-ant, debug off) the downstream `toolExecution.ts:1647` log is gated and analytics loses the `.code`. Before the throw, emit `logForDebugging(`[apply-patch] anchor not found: hunk=${hunkIndex} fingerprint=${fingerprint.length}L file=${basename(path)}`, { level: 'warn' })`. Rationale: durable production record of the most common hard failure, with no file content leaked. |
| #40 changed-on-disk (distinct cause, same `.code`) | `applier.ts:286-291` | **gap** | This branch fires when the *cached* (last-read) version would have matched — the #40 scenario — but it reuses `code: 'PATCH_ANCHOR_NOT_FOUND'`, so analytics cannot separate "stale anchor" from "file mutated under us after read." Before the throw, emit `logForDebugging(`[apply-patch] changed-on-disk: hunk=${hunkIndex} file=${basename(path)} — cached version matched, on-disk did not`, { level: 'warn' })`. Rationale: #40 was a real regression (Bash `cd` mutating cwd between Read and apply); a distinct durable log makes a recurrence diagnosable from a bug report without re-deriving it. |
| #69 ambiguity rejection (full-hunk fingerprint) | `applier.ts:264-267` | **gap** | Multi-location match rejected after scope hints fail to disambiguate. Before the throw, emit `logForDebugging(`[apply-patch] ambiguous: hunk=${hunkIndex} matches=${matches.length} scopeHints=${hunk.scopeHints.filter(h => h.trim()).length} file=${basename(path)}`, { level: 'warn' })`. Rationale: distinguishes "model gave too-little context" from anchor-miss; the `scopeHints` count tells whether hints were supplied but insufficient. |
| #32 transactional multi-file rollback | `FilePatchTool.tsx:343-346` (`catch` → `rollbackAppliedFiles` → rethrow) | **gap** | A mid-batch write failure silently rolls back N already-written files and rethrows; in prod there is no record that a partial multi-file patch was reverted. Add, inside the catch before `throw`: `logForDebugging(`[apply-patch] rollback: reverting ${writtenFiles.length} file(s) after write failure: ${errorMessage(error).slice(0, 120)}`, { level: 'error' })`. Rationale: rollback is rare and high-consequence (files mutated then un-mutated on disk); it must leave a durable trace. |
| #32 / #69 parser format & envelope errors | `parser.ts:24,31,51,57,100,168,201,227,271,286,307` | **adequate** | These are malformed-patch / invalid-format throws. They are model-facing correctness errors (the message tells the model how to fix the patch) and are not a silent-success or root-cause-ambiguity concern. The class name `'FilePatchError'` already lands in `tengu_tool_use_error`. Do **not** add per-branch logging here — it would be noise and the messages are already actionable. (If desired, a single coarse `[apply-patch] parse error code=${err.code}` at the `parseFilePatch` call site in `normalizeOperations` would suffice, but it is not required.) |
| #32 schema-level safety throws (target missing/exists, context/delete out of bounds, pure-insert misuse) | `applier.ts:27,39,63,92,164,177,234` | **adequate** | These are structural invariants caught by `validateInput` (`FilePatchTool.tsx:117-222`) before the real apply, surfacing as clean `behavior:'ask'` results, or are impossible-state guards. They are deterministic and self-describing; no telemetry value in logging them. Leave as-is. |
| #40 `assertFileUnchangedSinceRead` | `FileEditTool/shared.ts:222-240` | **adequate** | The #40 fix (skip on `!lastRead`) is correct and the throw path is covered by the `[apply-patch] changed-on-disk` log above (which fires *inside* the applier with richer context than this generic mtime guard). No separate log needed here; adding one would double-log the same event. |

## Implementation notes

- **One prefix, one allowlist edit.** Add `'[apply-patch]'` to
  `ALWAYS_LOG_PREFIXES` in `src/utils/debug.ts:110` so all four `warn`/`error`
  call sites above survive in production for non-ant users. The single `info`
  fuzzy-tier log will also bypass the gate via the prefix — acceptable because
  it only fires on non-exact matches (low volume).
- **No content/PII.** All recommended calls log basename + counts + tier/code
  only. Do not interpolate `hunk.lines`, `fingerprint` contents, or file bodies.
- **Imports needed in `applier.ts`:** `logForDebugging` from
  `../../utils/debug.js` and `basename` from `node:path` (neither currently
  imported). `FilePatchTool.tsx` already has access to `errorMessage` via the
  existing error-handling utilities (confirm import before use).
- **Optional, not required:** a structured `logEvent('tengu_apply_patch_outcome',
  { cause, tier })` would give BQ-level aggregation, but that crosses into the
  analytics-schema work #69 explicitly deferred. The log-based version above is
  the surgical fix; the analytics event can stay deferred.
