# Audit — subagents-agent-mode.md & apply-patch-editing.md

Fact-check against live source at `/Users/pt/cat-code`. No source or plan files were modified.

## Shared-premise verdict

| Premise | Verdict | Note |
|---|---|---|
| `ALWAYS_LOG_PREFIXES` currently only `[codex-cache]`; non-ant + debug-off writes nothing unless prefix matches | **VERIFIED** | `debug.ts:110` list; gate at `debug.ts:121` (`USER_TYPE !== 'ant' && !isDebugMode() && !isAlwaysLog`). |
| `logError` is NOT debug-gated; always feeds `getInMemoryErrors()` which ships in bug reports | **VERIFIED (with one caveat)** | `log.ts:187` `addToInMemoryErrorLog(errorInfo)` runs before any sink/debug check. **Caveat:** `log.ts:168-176` early-returns (skips in-memory) under Bedrock/Vertex/Foundry, `DISABLE_ERROR_REPORTING`, or `isEssentialTrafficOnly()`. So "always" is true for the default config but not under those env flags. Does not invalidate any verdict that relies on logError; just narrows "always." |

The load-bearing logError-in-memory claim **holds**. A catch path calling `logError` IS production-diagnosable for standard (non-Bedrock/Vertex/Foundry, reporting-enabled) users.

---

## Plan 1 — subagents-agent-mode.md

| Claim / citation | Verdict | Note |
|---|---|---|
| `invalidTools` collected at `agentToolUtils.ts:226-228` | **VERIFIED** | `invalidTools.push(toolSpec)` at line 227; returned at 234. |
| Spawn path `runAgent.ts:559-561` reads `.resolvedTools`, discards `.invalidTools`, no log | **VERIFIED** | Line 561 `resolveAgentTools(...).resolvedTools` — full result not captured; `invalidTools` discarded. |
| `invalidTools` only surfaced in editor UI (`validateAgent.ts:89`, `AgentDetail.tsx:78`) | **VERIFIED** | `rg invalidTools` shows exactly these two consumers + the producer; no spawn-path read. |
| resolveAgentTarget null returns at `resolveAgentTarget.ts:143,177,199,209` | **VERIFIED** | 143 empty target, 177 ambiguous (>1 metadata match), 199 un-parseable id, 209 no live-task/transcript. All exact. |
| `ResumeAgentTool.tsx:123-130` `!resolved` returns "No subagent found", no log | **VERIFIED** | `if (!resolved)` at 123, return block 124-130. |
| `ResumeAgentTool.tsx:174-179` generic catch "Failed to resume", no log | **VERIFIED** | catch return block 174-179. |
| `SendMessageTool.ts:892-899` "No running subagent or Agent Mode worker found", no log | **VERIFIED** | exact. |
| `SendMessageTool.ts:883-888` stopped-target branch silent | **VERIFIED (minor)** | branch condition begins line 880; the cited 883-888 is the return block. Off-by-3 on the branch start but within window and the return is exactly 883-888. |
| Justification: don't log inside resolveAgentTarget because `validateInput` probes it at `SendMessageTool.ts:636` | **VERIFIED** | `validateInput` (begins 611) calls `resolveAgentTarget` at 636. Logging inside the resolver would fire on every validateInput probe — recommendation to log at the call sites instead is sound. (Note: ResumeAgentTool.validateInput at :75 does NOT call the resolver; only SendMessage does — plan's cite is precise.) |
| Worker-failure cause at `agentToolUtils.ts:1039-1058`: `msg` surfaced to user/transcript but never to logError/logForDebugging; only meta-failure logged at 1058 (debug-gated) | **VERIFIED** | `msg = errorMessage(error)` at 1039; failAsyncAgent/appendSubagentTerminal carry it; only `.catch` meta at 1058 logs. AbortError branch at 986 correctly excluded. |
| Parallel `agentResult.error` branch at `agentToolUtils.ts:879-900` | **VERIFIED** | same pattern; meta-only log at 899. |
| Mailbox catches pair logForDebugging + logError (`teammateMailbox.ts` 137-138,218-219,295,368,398-399) | **NOT RE-VERIFIED line-by-line** | Spot-trusted; the ADEQUATE verdict rests on logError reaching in-memory log, which is confirmed. Lines not individually opened in this audit. |

**Defect scan:** No double-log, hot-loop, PII, or steady-state-path issues. Finding #1's proposed log fires only on genuine misconfiguration (never steady state). Findings #2/#3 fire only on real failure paths. Proposed payloads interpolate agentType / target string / taskId / error message — no file contents or secrets. Adding `[subagent]` to `ALWAYS_LOG_PREFIXES` is scoped to the capability-gap case as recommended.

**Verdict: IMPLEMENT-AS-IS.** All citations accurate (one cosmetic off-by-3 on a branch start, return block exact). The logError-vs-logForDebugging reasoning is correct given the confirmed in-memory premise.

---

## Plan 2 — apply-patch-editing.md

| Claim / citation | Verdict | Note |
|---|---|---|
| `src/tools/FilePatchTool/` has ZERO logForDebugging/logError/logAntError | **VERIFIED** | `rg` over the dir: no matches. (`FilePatchTool.tsx:351` calls `logFileOperation`, a success-only generic file-op analytics call — not one of the three, and not a failure/domain log; does not contradict the claim.) |
| Fuzzy-tier success leaves no record; `applier.ts:240-273` / return at `253-258`/`257` | **VERIFIED** | matchFns 240-245, searchPasses 247-251, `return matches[0]` at 257. No log. |
| Ambiguity throw `applier.ts:264-267` (`PATCH_ANCHOR_AMBIGUOUS`) | **VERIFIED** | exact. |
| changed-on-disk throw `applier.ts:286-291`, reuses `PATCH_ANCHOR_NOT_FOUND` | **VERIFIED** | cached-version match block; same `.code` as the plain miss — analytics can't separate the two causes, as claimed. |
| anchor-not-found throw `applier.ts:294-297` | **VERIFIED** | exact. |
| `classifyToolError` discards `.code`, keeps `error.name` → `tengu_tool_use_error` = `'FilePatchError'` (`toolExecution.ts:156-167`) | **VERIFIED** | 156-167 exact. `FilePatchError.code` is a custom property, not an errno (getErrnoCode miss), so falls to line 165 → `error.name`. `.code` genuinely lost to analytics. |
| Generic catch `toolExecution.ts:1645-1652`; logForDebugging debug-gated → lost for non-ant debug-off | **VERIFIED but OVERSTATED** | `logForDebugging` at 1647 IS debug-gated. **However line 1651 `logError(error)` ALSO fires** (guarded only by `!(error instanceof ShellError)`; FilePatchError is not a ShellError). So the failure message+stack DOES reach the in-memory error log / bug reports for standard users. The summary frames root-cause as "lost in production" citing only the gated logForDebugging; it omits that logError already captures the full FilePatchError text. **The structured `.code` is still lost to analytics (true), but the human-readable cause is NOT lost from bug reports.** This weakens the "in production you can tell *a* patch failed but not *why*" line — you CAN see why in the in-memory error log, just not in BQ analytics. |
| Rollback catch `FilePatchTool.tsx:343-346` (catch → rollbackAppliedFiles → rethrow), silent | **VERIFIED** | catch 343, rollback 344, throw 345. `writtenFiles` in scope (declared 289). |
| Parser format/envelope throws `parser.ts:24,31,51,57,100,168,201,227,271,286,307` — adequate, no per-branch log | **VERIFIED** | all 11 lines are `throw new FilePatchError`. |
| Schema-safety throws `applier.ts:27,39,63,92,164,177,234` — adequate | **VERIFIED** | all 7 are `throw new FilePatchError`. |
| `validateInput` at `FilePatchTool.tsx:117-222` | **VERIFIED** | opens 117, closes 222. |
| `assertFileUnchangedSinceRead` `FileEditTool/shared.ts:222-240`, `!lastRead` skip | **VERIFIED** | function 222-240; `if (!lastRead) return` present. |
| Proposed logs are "basename + counts + tier/code only, no file content" | **VERIFIED (one caveat)** | fuzzy/anchor/changed-on-disk/ambiguous payloads use `basename(path)`, `hunkIndex`, `fingerprint.length` (a line *count*, not content), `matches.length`, `scopeHints` count, tier names — no content/secret leak. **Caveat (rollback log):** the rollback recommendation interpolates `errorMessage(error).slice(0,120)` of a *write/fs* error, which can contain a **full file path** (not basename) though not file contents. Minor PII (path, not content); within the truncation and not a hard defect, but inconsistent with the plan's own "basename only" rule. |
| `errorMessage` already importable in FilePatchTool.tsx | **DRIFTED/UNVERIFIED-BY-PLAN-CORRECTLY-HEDGED** | `errorMessage` is NOT currently imported in FilePatchTool.tsx. The plan says "confirm import before use" — so it self-flagged; needs an import added. Not a defect, just a build prerequisite. |

**Defect scan:**
- The fuzzy-tier recommendation (`tier=${['exact','trimEnd','trim','unicode'][t]}`) assumes an indexed loop variable `t`, but source uses `for (const matchFn of matchFns)` with no index (applier.ts:254). Implementing as written requires converting to an indexed loop. **Feasibility caveat, not a factual error** — flagged so the implementer doesn't paste verbatim.
- No double-log: the new applier-level logs fire *before* the throw; the existing `toolExecution.ts:1647/1651` fire on the rethrown error. These are different layers (cause-at-source vs generic-tool-catch) and not duplicates of each other. OK.
- No hot-loop: fuzzy log only on non-exact match; exact first-pass (common case) stays silent. OK.

**Verdict: NEEDS-FIXES (minor).** All line citations accurate. Two corrections before implementing: (1) the summary **overstates** the production-blindness — `logError` at `toolExecution.ts:1651` already lands the FilePatchError cause in the in-memory bug-report log; the real remaining gap is *structured analytics* (`.code` lost) + *fuzzy-success invisibility*, not "no record of why." Reframe accordingly. (2) The rollback log should use `basename`/a sanitized message to honor the plan's own no-full-path rule, and the fuzzy-tier snippet needs an indexed loop. Add the `errorMessage` import.
