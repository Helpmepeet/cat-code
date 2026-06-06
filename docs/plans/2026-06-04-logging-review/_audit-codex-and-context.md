# Fact-check audit — Codex transport/cache, accounts/leasing, context/compaction

Audited 2026-06-04 against source at `/Users/pt/cat-code`. No plans or source modified.
Citation policy: ±15-line window. Verdicts: VERIFIED / DRIFTED (line off but found) /
WRONG (claim false) / OVERSTATED (claim true-ish but stronger than source supports).

## Shared premise — VERIFIED

`src/utils/debug.ts`:
- `ALWAYS_LOG_PREFIXES = ['[codex-cache]']` at **line 110** (cited correctly).
- `shouldLogDebugMessage` (112–135): for `process.env.USER_TYPE !== 'ant'`, if neither
  `isDebugMode()` nor an `ALWAYS_LOG_PREFIXES` prefix match, returns `false` (line 121–123).
  Gate confirmed exactly as described. Only `[codex-cache]` currently bypasses it.

The premise that non-ant + debug-off writes nothing unless prefixed `[codex-cache]` HOLDS.
All three plans' "production-silent unless always-on prefix" reasoning rests on solid ground.

---

## Plan 1 — Codex transport & prompt cache

| Claim / citation | Verdict | Note |
|---|---|---|
| #37 zero-cache branch `promptCacheBreakDetection.ts:545-558` pushes UI warning + `[PROMPT CACHE]` warn then `return`s early before `recordPromptCacheBreak`/BQ | VERIFIED | Branch at 545–558; `logForDebugging('[PROMPT CACHE] zero cache tokens…', {level:'warn'})` at 556; `return` at 558. `recordPromptCacheBreak` (821) and `logEvent('tengu_prompt_cache_break')` (735) are both far downstream — genuinely skipped. |
| Swap to `[codex-cache]` prefix won't double-persist | VERIFIED | The early-return path has no JSONL/BQ write; swapping the prefix only un-gates the existing single log. No second sink on that branch → no double-persist. SAFE. |
| Confirmed breaks ARE persisted via `recordPromptCacheBreak` | VERIFIED | `recordPromptCacheBreak({...})` at 821–866, reached only after the 558 early-return; `pendingCacheWarnings` user-warning at 871. |
| #16 header underscores `codex-fetch-adapter.ts:2806-2807` | VERIFIED | `session_id: conversationId` at 2806 (inline underscore header). |
| #47 instructionAssembly `instructionAssembly.ts:52-54` always-on volatile_keys log | VERIFIED | `[codex-cache] instructions=…developer_context=…volatile_keys=[…]` at 53. |
| #33 resume rebind — `setup.ts:90-97` + `codex-fetch-adapter.ts:76-79` | DRIFTED (path) | Behavior CORRECT: `setCodexPromptCacheKey` logs `[codex-cache] prompt_cache_key set…` at adapter:78; called initially at `src/setup.ts:90` and on `onSessionSwitch` at `src/setup.ts:95-96`. But the cite reads bare `setup.ts` — the file is **`src/setup.ts`**, NOT `src/services/api/setup.ts` (no such file). Line numbers 90-97 correct for `src/setup.ts`. |
| #34 reasoning round-trip `codex-fetch-adapter.ts:797-799, 1740-1743` | VERIFIED | `[codex-cache] replay reasoning…` at 798; `[codex-cache] stream reasoning item encrypted=…ABSENT` at 1741. |
| #42/#44 `codex-fetch-adapter.ts:1847-1898` | VERIFIED | `[codex-fetch] replay_skipped_visible_output=true` at 1882, within window. |
| #15/#46 sticky fallback `codex-fetch-adapter.ts:89-103,2511-2545,2957-2962` | VERIFIED | `sticky_http_fallback` set/expire at 99/111; `stream_transport_error` classification at 2543. |
| #35/#36 WS stale-id `codex-websocket-transport.ts:925-936` | VERIFIED | `[codex-cache] stale_response_id_retry conv=…` warn at 929. |
| #70 network outage `withRetry.ts:695-776` | VERIFIED | `[codex-pool] Suspected network outage…` at 770; `account.transient_failure` at 732/754; `codexNetworkOutageHandled` reset path described accurately (recovery not logged, as plan notes). |
| #50 recordPromptCacheBreak cite (also referenced by Plan 3) `:836` | DRIFTED | `recordPromptCacheBreak` call OPENS at **821**; `:836` is the `reason` field inside the call. Block spans 821–866. Minor. |

**No DEFECTs.** Every always-on `[codex-cache]`/`[codex-fetch]` line slices IDs
(`.slice(0,8)`); no token/secret leak. The single recommended #37 change is sound and
will not double-persist or double-log.

**Verdict: implement-as-is** (fix the `setup.ts` → `src/setup.ts` path label in the #33 row; cosmetic).

---

## Plan 2 — Codex accounts, leasing & rotation

| Claim / citation | Verdict | Note |
|---|---|---|
| Central: `emitAccountDiagnostic` is a no-op in interactive REPL (stream-json sink or optional stderr only) | VERIFIED | `accountDiagnostics.ts:421-441`: no emitter → returns; only `process.stderr.write` if `allowStderrFallback===true` (430-433). REPL has neither sink. `hasAccountDiagnosticSink()` (417) confirms. `emitCodexDiagnostic` (withRetry.ts:127) forwards to it. |
| Gap1: `withRetry.ts:349-357` `throwRetryExhausted` emits only diagnostic, no `logForDebugging` | VERIFIED | Fn at 342–359; `emitCodexDiagnostic({code:'account.retry.exhausted'…})` at 349–356; no logForDebugging. `accountRef`/`attemptCount`/`originalError`/`errorMessage` all in scope for proposed log. Also reached from 366 (lease-budget guard). |
| Gap2: `codexAccountPool.ts:406-451` `markPoolAccountStatus`/`markPoolAccountCapped` log only via diagnostics, unlike `rotateOnFailure`/`markAccountDead` | VERIFIED | 406–438 / 440–451: only `emitUsageStatusDiagnostic`+`emitActiveRerollDiagnostic`. `rotateOnFailure` logs `[codex-pool]` at 278/298; `markAccountDead` at 590. `previousStatus`/`status`/`reason`/`accountId` in scope. Cites `:277`/`:589` land at 278/590 (in window). |
| Gap3: `codexAccountLeaseManager.ts:214-251` reassign* has no log; early-return at `:221` | VERIFIED | `reassignCodexLeaseToActiveAccount` (214–232) + `reassignCodexLeasesToActiveAccount` (234–251): zero logging. Early-return at 221; rewrite via `.set` at 224. Caller `switch-account.ts:138` confirmed (`reassignCodexLeasesToActiveAccount()` exactly at line 138). |
| Gap3 proposed `truncId` import | NOTE (not a defect) | `truncId` is module-private in `codexAccountPool.ts` (line 1190), not exported. Lease file would need a local `truncId`/`.slice(0,12)` — the plan already says exactly this. |
| Gap4: `codex-fetch-adapter.ts:2696-2707` `getPoolAccountForCurrentLease` `find ?? null`; consumed `:2738-2742` silent fallback to ambient token | VERIFIED | 2696–2707: returns `getActiveAccount()` when no lease, else `find(...) ?? null`. Caller 2738–2742: `poolAcct?.accessToken || accessToken` (2741) → silent ambient fallback. Null fires only on lease-present-account-missing, so proposed log placement is correct. |
| All proposed `[codex-account]` lines on state-transition/failure paths, not hot loops | VERIFIED | throwRetryExhausted (terminal), markPoolAccountStatus (gated on `previousStatus!==status`), reassign (post early-returns), orphan-lease (rare null branch). Per-request/selection logs left debug-gated. No hot-loop logging. |
| No token/secret leak in proposals | VERIFIED | All proposed lines use `truncId()` / `.slice(0,12)` on account IDs + alias/reason/code/attempts. None reference `access_token`/`accessToken`. SAFE to ship. |
| Adequate: per-request `[codex-cache] request account=…` `codex-fetch-adapter.ts:2769` | VERIFIED | At 2770 (`.slice(0,12)`), within window. |

**No DEFECTs.** No double-log: each proposed line sits where today only a (silent)
diagnostic fires; the diagnostic is kept for SDK consumers, the new line un-gates a
production breadcrumb. Gap2's `previousStatus !== status` guard prevents repeat-fire.

**Verdict: implement-as-is.** All four gaps real, all cites accurate, no leak risk.
One housekeeping note (Gap3 needs a local `truncId`) is already acknowledged in the plan.

---

## Plan 3 — Context window, auto-compaction, goal accounting

| Claim / citation | Verdict | Note |
|---|---|---|
| Boundary `compactMetadata` carries `{trigger, preTokens, messagesSummarized}` but NOT post-size/threshold | VERIFIED | `src/utils/messages.ts:4670-4675`: `{trigger, preTokens, userContext, messagesSummarized}`. (Plan omits `userContext` — immaterial.) No post-tokens/threshold. |
| `messages.ts:4655` boundary persisted | DRIFTED (path) | File is **`src/utils/messages.ts`** (not `src/messages.ts`). 4655 = `createCompactBoundaryMessage` factory; `compactMetadata` literal at 4670. Line numbers correct for `src/utils/messages.ts`. |
| `truePostCompactTokenCount` + `autoCompactThreshold` computed in scope, could be added "mirroring `preCompactDiscoveredTools` mutation at `compact.ts:636`" | OVERSTATED | Both values DO exist in the same function and `boundaryMarker` is the same mutable object returned at 775 — so adding the fields IS feasible. BUT `truePostCompactTokenCount` is computed at **compact.ts:671**, 35 lines AFTER the 636 mutation site, and itself consumes `boundaryMarker` (672). The new mutation must go at **~676+, not 636**. The "in scope at the 636 mutation site" framing is wrong for `truePostCompactTokenCount`; `autoCompactThreshold` (`recompactionInfo?.autoCompactThreshold`) is available throughout. Recommendation stands; placement line is off. |
| `compact.ts:626` boundary created, `:671` truePostCompact, `:684` tengu_compact, `:636` preCompactDiscoveredTools mutation | VERIFIED | 626 create; 636 `boundaryMarker.compactMetadata.preCompactDiscoveredTools = […]`; 671 truePostCompactTokenCount; 684 `logEvent('tengu_compact'…)` with `willRetriggerNextTurn` (690). |
| `autoCompact.ts:370` trigger-decision log debug-gated | VERIFIED | `logForDebugging('autocompact: tokens=…threshold=…effectiveWindow=…')` at 370–372; prefix `autocompact:` not in ALWAYS_LOG_PREFIXES → gated. |
| #59 reassembly `query.ts:567-574, 694-700` | VERIFIED | `buildPostCompactMessages` at 567; `messagesForQuery = postCompactMessages` at 573; `buildProviderInstructionAssembly({messages: messagesForQuery…})` inside API while-loop at 694–700. |
| #57 goal accounting `REPL.tsx:1760-1824`, `threadGoal.ts:399-403`, `:378`, `:509` | VERIFIED | `accountCompletedTurnThreadGoal` 1760→~1825; `calculateThreadGoalContextTokenDelta` = `Math.max(0,end-start)` at 399–403; complete-freeze at 378; `formatThreadGoalFooterLabel` at 509. |
| #50 server-shrink `promptCacheBreakDetection.ts:678-707, 808-810, 821-872` | VERIFIED | mode/suspicious at 686–705; `[PROMPT CACHE BREAK]` log 808–810; `recordPromptCacheBreak` 821–866; `pendingCacheWarnings` 871. (Same `:836`→821 drift as Plan 1.) |
| #58 prompt-only `threadGoal.ts:561-611` | VERIFIED | `renderThreadGoalContinuationPrompt` at 561 — model-facing text, no runtime branch. |
| Circuit breaker `autoCompact.ts:494-500` + `notifyAutoCompactCircuitBreaker:499` | VERIFIED | trip at 494–499, notify at 499. |
| Defers #37 to codex-transport reviewer (no double-claim) | VERIFIED | Plan 1 owns #37; Plan 3 explicitly does not re-litigate. No overlap/double-claim. |

**No DEFECTs.** The primary recommendation adds two fields to an already-persisted
JSONL object — zero new log volume, no leak (token counts only), no double-persist.

**Verdict: needs-fixes (minor).** Recommendation is sound and safe, but the proposal's
"in scope at the `compact.ts:636` mutation site" is OVERSTATED — `truePostCompactTokenCount`
isn't available until 671; the field-add must land at ~676+ (after that line). Also relabel
`messages.ts` → `src/utils/messages.ts`. No behavioral or safety concern.

---

## Bottom line

- Plan 1 (transport/cache): **implement-as-is** — fix `setup.ts`→`src/setup.ts` label only.
- Plan 2 (accounts/leasing): **implement-as-is** — all 4 gaps real, cites accurate, no leak.
- Plan 3 (context/compaction): **needs-fixes (minor)** — correct the "636 mutation site"
  scope claim (real site is ~676+) and the `src/utils/messages.ts` path; recommendation itself is sound.
