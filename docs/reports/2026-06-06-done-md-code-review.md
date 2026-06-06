# DONE.md Code Review — 2026-06-06

Verification pass over every DONE.md entry: for each, confirm the described
change actually exists in source as written, and review that code for
correctness bugs. Work was fanned out across nine parallel review subagents,
one per subsystem group. Two review lenses: **verify claims are real** and
**correctness/bugs**.

## Second-pass verification (independent re-review of the findings)

A separate session re-reviewed the four actionable findings against source.
Results:

| Finding | Verdict | Note |
|---|---|---|
| #1 Sandbox guard wrong dir | **Confirmed** | Real deny-list gap, but higher-level Bash/path validation still forces manual approval — not a silent write. |
| #2 Duplicate stale-response-id callback | **Confirmed + sharpened** | Duplicate does overwrite and the warning is unreachable, BUT the surviving callback was never correct for subagents either (maps to `agent:${id}` while tracking uses raw `agentId`). Fix is more than deleting the duplicate. |
| #3 `--add-dir` skills hot-reload | **Confirmed** | — |
| #4 Entry #51 401-retry reverted | **Confirmed** | — |

Refined fixes from the second pass are folded into the per-finding sections below.

## Summary

The work is overwhelmingly real and correct. Of 82 entries, the code matches the
claim and is correctly implemented for the vast majority. Three issues are worth
acting on; one entry's headline fix was reverted (drift); the rest are
documentation drift or design tradeoffs to confirm.

| Severity | Count | Entries |
|---|---|---|
| 🔴 Real bug (fix) | 3 | #74 (×2), #38 |
| 🟠 Drift — claimed fix reverted/absent | 1 | #51 |
| 🟡 Doc drift (behavior correct) | 8 | #41, #38, #39, #11, #70, #76, #43, #74 |
| 🔵 Design tradeoff to confirm | 3 | #44, #79, #76 |
| ✅ Verified clean | rest | — |

## Grouping used for the review

| Group | Scope | Entries |
|---|---|---|
| A | Codex/OpenAI adapter & streaming | 16, 24, 32, 34, 39, 41–44, 46–48, 61, 62, 71, 72, 80 |
| B | Codex prompt cache & WebSocket transport | 16, 21, 31, 33, 35–38, 40, 50 |
| C | Account pool / leases / multi-account | 4, 6, 9–11, 30, 39, 51, 66, 70 |
| D | Auto Mode (classifier-gated approval) | 76, 77, 79 |
| E | Agent Mode / subagents / resume | 26–30, 49, 53–55, 64, 65, 81, 82 |
| F | Prompt architecture / instruction hierarchy | 2, 3, 19, 20, 22, 23, 25, 29, 58 |
| G | Config isolation / skills / branding / models | 5, 13–15, 17, 52, 60, 74, 75 |
| H | Open Design integration | 63, 67, 68 |
| I | Goal mode / autocompact / token accounting | 8, 56, 57, 59 |

---

## 🔴 Real bugs (worth fixing)

### 1. Sandbox guard protects the wrong directory — `src/utils/sandbox/sandbox-adapter.ts:243-254` (entry #74, security-relevant)
The secondary deny-write guard for cd'd directories still targets
`.claude/settings.json`, `.claude/settings.local.json`, and `.claude/skills`.
Real config now lives at `.cat-code/...`, and the primary deny list
(lines 232-235) only covers the *original* cwd — so this secondary guard is
exactly the protection for cd'd directories, and it now guards the wrong folder.
Leaves a `.cat-code/settings.json` / `.cat-code/skills` sandbox-write vector in a
cd'd directory unblocked.

> **Second pass: Confirmed.** Nuance: higher-level Bash/path validation still
> forces manual approval, so this is a deny-list gap, not a silent write.
> **Fix:** add current-cwd `.cat-code/settings.json` and `.cat-code/settings.local.json`
> (and likely `.cat-code/skills`) to `denyWrite` when `cwd !== originalCwd`; keep
> `.claude` for legacy. Add a focused `convertToSandboxRuntimeConfig()` test for
> the `cwd !== originalCwd` case.

### 2. Duplicate stale-response-id callback — `src/services/api/codex-fetch-adapter.ts:502` shadows `:158` (entry #38)
Two top-level `registerStaleResponseIdCallback` calls exist. The setter stores a
single callback, so line 502 (`notifyStaleResponseIdRetry(conversationId)` with a
raw UUID) overwrites the correct line-158 callback (which maps
conversationId→querySource). `notifyStaleResponseIdRetry` keys
`previousStateBySource` by querySource strings, so the UUID never matches and the
"server evicted previous_response_id" cache-break label
(`promptCacheBreakDetection.ts:715`) is unreachable in practice. Diagnostic-only
impact; no test covers this.

> **Second pass: Confirmed, and sharpened.** The duplicate does overwrite and the
> warning is unreachable — but deleting the duplicate alone is **not** a full fix:
> the surviving line-158 callback was never correct for subagents either. It maps
> to `agent:${id}` while tracking keys by raw `agentId`, so the subagent path would
> still miss.
> **Fix:** remove the duplicate at `codex-fetch-adapter.ts:502-504`, AND fix the
> surviving callback to map transport conversation IDs to real prompt-cache keys:
> main → `repl_main_thread`, subagent sessionId/agentId → raw `agentId`. Add
> stale-retry-to-warning tests for both main and subagent.

### 3. `--add-dir` skills don't hot-reload — `src/utils/skills/skillChangeDetector.ts:225` (entry #74)
The `--add-dir` watch path is `<dir>/.claude/skills`, but the loader reads
`<dir>/.cat-code/skills` (`loadSkillsDir.ts:674`). Skills added via `--add-dir`
under `.cat-code/skills` will not hot-reload on change.

> **Second pass: Confirmed.**
> **Fix:** change `skillChangeDetector.ts:225` to `.cat-code/skills`, or better,
> share the path helper with `loadSkillsDir.ts` so they can't drift again. Add a
> watcher unit test asserting added dirs watch `.cat-code/skills`.

---

## 🟠 Drift — claimed fix was reverted

### Entry #51 — headline 401-refresh-and-retry was reverted (Group C)
`fetchAccountUsageResult` (`src/services/api/codexUsage.ts:91-96`) does **not**
refresh the account token on HTTP 401 and retry. Git history (commit `3e38b39`
"Fix account switching drift") shows the entire 401-refresh-and-retry block plus
the `refreshAccountAccessToken` helper were deleted. The `status` return value and
`...Once` naming are now vestigial. A tab holding a stale access_token still shows
"usage unavailable" on 401 — the exact symptom #51 claimed to fix. The proactive
half (`initAccountPool` fires `void touchAll()` at startup,
`codexAccountPool.ts:177-188`) is still present and correct.

**Action:** either restore the retry or update DONE.md #51 to reflect that only
the proactive half remains.

> **Second pass: Confirmed.** `status` from `fetchAccountUsageOnce()` is ignored;
> cross-tab stale token can still surface as "usage unavailable."
> **Fix (if restoring):** restore a 401-only refresh/resync-and-retry-once path for
> vault-backed Codex accounts — without reintroducing `status` mutation or
> active-account movement. Update the current 401 test and add a
> success-after-refresh test.

---

## 🟡 Documentation drift (behavior correct, DONE.md text inaccurate)

- **#41** cites `orchestrator.ts` — no such file exists. The `?? EMPTY_USAGE`
  guard lives in `AgentTool.tsx:1994`, `sideQuery.ts:229`,
  `tokenEstimation.ts:324`. Functionality present; cited filename wrong.
- **#38** `lastInstructionsHash` field does not exist on `WsSession`; the described
  behavior is achieved via `createRequestSignature` including `instructions` as a
  non-input field (continuation reset). Also: prewarm is a one-time **startup**
  prewarm (`schedulePrewarm` early-returns once done), not "before each request."
- **#39** "WS close with zero events = account rejection" overstates — the code
  deliberately classifies a zero-event close as a *recoverable ambiguous transport
  close* (HTTP-fallback eligible) unless an explicit usage-limit event was seen
  (`codex-websocket-transport.ts:969-972`). The implementation is the safer choice.
- **#11** remount key is `${conversationId}:${authVersion}`
  (`src/components/Messages.tsx:681`), stronger than the documented `conversationId`
  alone. No action.
- **#70** "~5–15s exponential backoff per connection-error failover" conflates two
  delays. Per-failover backoff is `getRetryDelay` (~1/2/4s); the 5–10s figure is
  only the one-shot network-outage path. Budget accounting itself is correct.
- **#76** commit title "make it the default" overstates — auto mode ships reachable
  in every build (build flag `TRANSCRIPT_CLASSIFIER`) but is the *session default*
  only via settings `defaultMode: auto` or `--enable-auto-mode`. DONE.md #76's own
  wording ("Turned on in every build") is accurate.
- **#43** crash-prevention via `?? EMPTY_USAGE` is solid, but the "emit diagnostics
  instead of crashing" sub-claim is only weakly supported at the two `claude.ts`
  usage readers (no explicit diagnostic emission found there).
- **#74 cosmetic strings:** `Doctor.tsx:169` reports `.claude/agents` (real path
  `.cat-code/agents`); cron prompts (`ScheduleCronTool/CronCreateTool.ts:39`,
  `prompt.ts`) tell the model durable tasks persist to
  `.claude/scheduled_tasks.json` (real path `.cat-code/scheduled_tasks.json`).
  Model-facing/diagnostic text only; no config corruption.

---

## 🔵 Design tradeoffs to confirm (not bugs)

- **#44** a reasoning summary block calls `noteVisibleOutput()`
  (`codex-fetch-adapter.ts:1390`), so if the WS drops *after* reasoning but
  *before* answer text, the turn is treated as "visible output started" and is
  **not** HTTP-replayed (1842-1845) — the user could be left with reasoning and no
  answer. Consistent with #44's stated intent (reasoning is user-visible), but
  worth confirming it's the desired tradeoff.
- **#79** a genuine usage cap on a *non-pooled* account surfaces as a generic
  `Codex API error (429)` and falls back to the gpt-5.4 classifier rather than
  failing closed by name. **Not a bypass** — the action is still classified by
  gpt-5.4 (never auto-approved), and a double-model failure fails closed via the
  iron gate (`tengu_iron_gate_closed` defaults true). The "caps fail closed"
  guarantee holds end-to-end only when the error carries `CodexAccountCapError`
  (pool active) or both classifier models error.
- **Auto Mode (#76) in general:** the deny categories (git push, env dumping,
  `curl|bash`, exfiltration, etc.) and "don't push"-style user boundaries are
  **prompt-only** (LLM classifier in `yolo-classifier-prompts/`), not code-level
  hard gates. Code-level deny rules and bypass-immune path safety checks (configured
  denies, `.git`/dotfile/out-of-workdir path checks) *do* run first and independent
  of the classifier, and `stripDangerousPermissionsForAutoMode` removes broad allow
  rules on entry. Inherent to an LLM-classifier design (fails safe: "when in doubt,
  block"), but these specific categories are not deterministic guarantees.

---

## ✅ Verified clean groups

- **Group I** (goal/autocompact/token accounting — 8, 56, 57, 59): all verified
  with matching regression tests. The two highest-risk items check out: #56 uses a
  single shared `getAutoCompactThreshold()` across both runtime and context
  analysis (no formula-drift risk), and #59's instruction assembly provably runs
  *after* the post-compact message reassignment and feeds both provider paths.
- **Group F** (prompt architecture — 2, 3, 19, 20, 22, 23, 25, 29, 58): all
  verified. #22 GrepTool dash-prefix remap round-trip is symmetric and consistent
  (GrepTool confirmed the only tool with dash-prefixed schema props); #19 gates
  OpenAI out of thinking-token counting (`tokenEstimation.ts:43-45`) and compaction
  context-edits (`apiMicrocompact.ts:83-92`). 12/12 regression tests pass.
- **Group E** (Agent Mode — 26–30, 49, 53–55, 64, 65, 81, 82): no correctness bugs.
  The #81 `ask_orchestrator` name-collision claim (`'AskOrchestrator'` constant vs
  `'ask_orchestrator'` registered name) is fully substantiated by git history and
  correctly fixed (single source re-exported from `prompt.ts`, regression test
  added). #65 ResumeAgent/SendMessage boundary verified: SendMessage rejects
  stopped targets, ResumeAgent rejects running targets.
- **Group H** (Open Design — 63, 67, 68): Cat Code side verified; sanitization holds
  (centralized `buildAccountDiagnosticBody`, allowlisted usage-warning branch,
  synthetic-only `codex#N` refs, explicit anti-leak test assertions — no
  tokens/emails/account-ids reach stdout/stderr). The bulk of each entry (runtime
  adapter, Settings UI, parsing/routing) correctly lives in the separate
  `/Users/pt/open-design` repo.
- **Groups A, B, C, D, G** otherwise: all remaining entries verified in source as
  written, with the exceptions itemized above.

---

## Suggested next steps

1. Fix the three `.claude`→`.cat-code` path bugs as one focused change: sandbox
   guard (#1, security), skill watch path (#3), plus the cosmetic Doctor/cron
   strings — they're all the same class of missed path from entry #74.
2. Remove the stray duplicate stale-response-id callback (#2) as a separate commit
   (unrelated subsystem).
3. Decide on #51: restore the 401-refresh-and-retry, or correct the DONE.md entry.

Keep 1–3 as separate commits since they touch unrelated subsystems.
