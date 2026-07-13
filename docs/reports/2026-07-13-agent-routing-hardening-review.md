# Agent Control Routing Hardening — 7-Reviewer Audit

**Date:** 2026-07-13
**Branch:** `agent-routing-hardening` (worktree `/Users/pt/cat-code-agent-routing-hardening`, uncommitted)
**Baseline:** `main`
**Plan:** `docs/superpowers/plans/2026-07-12-agent-control-routing-hardening-plan.md`
**Method:** 7 independent read-only review subagents (5 per-task correctness/security + 1 Task-3 protocol audit + 1 whole-plan acceptance audit), each inspecting worktree source directly.
**Focused test evidence (run by Report 7):** 214 pass / 0 fail / 463 expect() across 18 focused files. `git diff --check` clean; no historical doc modified. `bun run build:dev:full` NOT run in this review.

## Verdict: **REVISE BEFORE HUMAN REVIEW**

Two independent Major findings stand; either alone justifies revision. Implementation is coherent, honestly reported, and its central invariants are enforced in reachable code — but the two Majors are concrete, reachable, and have clear fixes. No Blocker, no security-boundary breach, no locked-decision reopening. The disclosed missing two-process probe alone would not force revision.

---

## Major findings (must fix)

### M1 — Task 1: leaked permanent `reserved` allocation on early spawn failure (Report 1)
`AgentTool.tsx:667-687` calls `allocateTeamRecipient` then `spawnTeammate` with **no surrounding try/catch**. Compensation (`terminateFailedRecipient`, `spawnMultiAgent.ts:272-288`) only fires from inside the spawn handlers *after* the `reserved→starting` transition. Any throw before that point — `detectAndGetBackend()` in non-`auto` mode with tmux/iTerm2 absent (`spawnMultiAgent.ts:1078-1085`), or a `TeamFileLockError` on the first transition — leaves the record `reserved` forever. `recoverStartingRecipient` only reclaims `starting`, never `reserved`; keys are never reused, so `conflict:'suffix'` advances (`researcher`, `researcher-2`, …) on every retried spawn. Violates plan Step 7. Reachable via a common spawn-failure path.
**Fix:** wrap allocate+spawn in a try/catch that tombstones from whichever pre-active state, or make `terminateFailedRecipient` tolerate both `reserved` and `starting`.

### M2 — Task 3: pending-control records never reach `consumed` for 4 of 5 response types (Report 3, corroborated by Report 6)
`permission`, `sandbox`, `plan`, and `shutdown_rejected` requests create `PendingControlRecord`s but only `shutdown_approved` runs `claimPendingControl`→`finishPendingControl` (`useInboxPoller.ts:992/1002`, `attachments.ts:3873/3882`). The other four (`useInboxPoller.ts:574-597`, `666-694`, `361-403`, `263`) never claim/finish, so records accumulate unboundedly in the durable team file (`teams/<team>/config.json`). Every control write does `readTeamSnapshot` + two locked full-file rewrites, so latency degrades over a team's lifetime. Functional duplicate-suppression survives only via the callback registry masking the leak. Violates plan Steps 6/10. Report 6 independently reached the identical conclusion (its one security-relevant Partial).
**Fix:** run claim/finish on the four remaining response types (as `shutdown_approved` does), or prune terminal records during a team transaction.

---

## Notable Minor findings

- **Task 3 (Reports 3 + 6): `plan_approval_response` classifier bypass.** The teammate-side plan-mode-exit runs off a raw `isPlanApprovalResponse(msg.text)` sniff (`useInboxPoller.ts:361-404`), bypassing `classifyMailboxMessage`, requiring no matching pending record, not checking recipient allocation/incarnation, re-firing every poll. Bounded (sender-kind check holds; forging a leader response needs the out-of-scope same-user file-edit) but diverges from Steps 9–10. Both Task-3 reviewers found it independently. **Fix:** route through the classifier lane, gate on a claimed pending `plan` record.
- **Task 2 (Report 2): ack-path data-loss risk.** `acknowledgeMailboxMessages` (`teammateMailbox.ts:1083-1088`) reads with lenient `readMailbox` (returns `[]` on malformed JSON) then unconditionally rewrites — can zero a transiently-malformed mailbox, the exact loss the write path guards against with `readMailboxStrict`. **Fix:** strict-read + bail on parse failure in the ack path.
- **Task 2 (Report 2): broadcast sanitized-path collision double-count.** `handleBroadcast` (`SendMessageTool.ts:367-410`) lacks the sanitized-path guard `resolveFreshRosterMember` uses; two names sanitizing to one inbox both report as distinct deliveries.
- **Task 1 (Report 1): `print.ts:2580` calls now-async `removeTeammateFromTeamFile` un-awaited** and logs false success before the write flushes.
- **Task 1 (Report 1): `recoverStartingRecipient` is unwired** (no production caller) — crash-recovery machinery is inert.
- **Task 4 (Report 4): dead `queuePendingMessage` + stale comment**; and a momentarily-untruthful "stopped, use ResumeAgent" reply when a concurrent resume flips the task to running (`SendMessageTool.ts:329-338`) — self-correcting, low impact.
- **Task 5 (Report 5): dead `canSpawnAgent` data** carried on every result; misleading comment at `AgentTool.tsx:882-886`.

---

## Cross-task findings (Report 7)

- **F1 — trailer capabilities from the forbidden pool.** `AgentTool.tsx:887` derives `continuationCapabilities` from `toolUseContext.options.tools` — the array plan Step 6 says not to re-derive. For an in-process teammate whose `options.tools` may still contain `ResumeAgent`/`Agent`, the completion trailer can over-advertise continuations the runtime filters out. **This is the one reviewer contradiction (see below).**
- **F2 — `team_permission_update` has no producer** (Task 3 ↔ Task 5). It is in the closed union, direction matrix, consumer, and the Task-5 `tools-permissions.md` map, but nothing emits it (`TeamsDialog.tsx` emits only `mode_set_request`). Report 6 concurs: `main` had no producer either — pre-existing dormant type, plan overstated TeamsDialog's scope. Not a regression, but the map/matrix over-state behavior. **Fix:** wire the producer or explicitly mark it deferred.
- **F3 — TeamsDialog write failures debug-logged only**, not surfaced (contradicts truthful-delivery theme).
- **F4 — suffix allocation not 64-byte-safe** (`teamHelpers.ts:444-453`): a near-max base name throws instead of degrading. (Same as Report 1 finding 8.)
- **Undisclosed test gap:** four Step-9 transaction-concurrency tests are absent and were NOT among the plan's disclosed omissions (which were only the two-process probe + crash-injection matrix). Honesty gap in the self-review's completeness, not a code defect.

No deadlock / check-then-act gap found: team locks are never held across mailbox I/O; the two lock domains are never nested; resume ownership is an in-memory Set.

---

## Reviewer contradiction (unresolved)

**F1 / `AgentTool.tsx:887`:**
- **Report 5 (Task 5 impl): not a bug** — at the `Agent` call site `toolUseContext` is the invoker's own context, so `.options.tools` is correctly resolved; only the comment's wording is wrong. Ruled out prompt-vs-trailer drift as a false positive (tests 592/618/645/723 pass).
- **Report 7 (whole-plan): a real plan violation** — for the **in-process-teammate-invokes-`Agent`** path, `options.tools` can still contain `ResumeAgent`/`Agent`, diverging the trailer from the runtime.

**Resolution:** the two evaluated different execution paths. Report 5 reasoned about top-level/normal-subagent (arrays coincide — confirmed by its tests); Report 7 reasoned about the in-process-teammate path, which **neither found a test for**. Substantive but resolvable: confirm the in-process `options.tools` is already filtered (Report 5's harmless case) or apply Report 7's fix (thread the resolved child array / reuse `capabilities` at line 589). The fix is trivially safe either way and removes the misleading comment both flagged.

---

## Acceptance items NOT to consider satisfied

1. **Two-process probe (exactly one owner, concurrent local+teammate): Not Done** (disclosed; `spawnMultiAgent.probe.test.ts` absent). Cross-process single-owner rests on `proper-lockfile` exercised only within one process.
2. **"Capabilities from exact resolved array": Approximate** — prompt path correct, result-trailer path not (F1).
3. **Crash-injection matrix: Approximate** — recovery logic proven, exhaustive matrix not built (disclosed).
4. **Transaction-concurrency coverage: not built** (undisclosed — 4 tests).
5. **`build:dev:full` gate: unverified here** — must be run before merge.

---

## Recommended before human review

1. Fix M1 (compensating try/catch around allocate+spawn).
2. Fix M2 (claim/finish the four remaining response types, or prune terminal records).
3. Resolve F1 (confirm/correct in-process `options.tools`; delete misleading comment).
4. Wire or explicitly defer `team_permission_update` (F2) so the map stops over-stating.
5. Run `bun run build:dev:full`.
6. Batch or triage remaining Minors (ack-path data-loss, broadcast collision-count, plan-approval bypass, dead code, F3/F4) as fix-or-won't-fix with rationale.
