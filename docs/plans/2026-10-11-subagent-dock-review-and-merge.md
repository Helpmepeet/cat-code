# Subagent dock independent review and local integration

The review covers `codex/subagent-dock` from `a0dfe5a1` through the original
`0930b35b` tip, the approved implementation plan and visual reference, and
integration with current local main. Prior implementation checks were treated
as historical evidence. No GUI, account operation, live model probe, app
installation, publication, or branch/worktree removal was performed.

## Findings and repairs

Five confirmed findings: two high, two medium, one low, all user-visible.
All were repaired in the renderer owners and exercised again. No deferred
findings remain. The existing engine, host, protocol and transcript-card
semantics were preserved.

| Severity | Finding | Repair and fresh evidence |
|---|---|---|
| High | A successful implicit background launch appeared Finished while its worker was running. `AgentTool` can dispatch asynchronously without `input.run_in_background`. | Dock derivation recognizes background evidence from workers, tasks, subagent metadata and remembered state; launch acknowledgements do not imply completion. Regression covers running, missing evidence and actual terminal worker evidence. |
| High | Resuming by a friendly alias created an alias identity separate from the canonical worker, losing its transcript target and completion totals. | Engine tool-use metadata wins; remembered tool-use bindings and unique recorded names retain canonical joins after eviction and restore. Unresolved aliases do not create workers. |
| Medium | An exhausted account failover displayed “moved once” although no replacement account was acquired. | Held-account and successful-move details use active leases; recorded account evidence remains a fallback. |
| Medium | A rejected resume changed terminal run identity and resurrected a cleared Finished entry. | The dock ignores the real ResumeAgent `success:false` result before assigning a new run or transcript target. |
| Low | Collapse made the panel inert before animation selection, skipping every face/name flyer. | Only inert descendants are excluded; the inert closing panel itself does not exclude its live rows. Owner execution now creates two flyers for the tested live face/name on both close and open, excluding undisclosed Finished rows. |

The four initial bug regressions failed on the reviewed implementation for their
intended reasons, then passed after repair. The rejected-resume regression also
failed before its repair and passed afterward. The transcript reveal test was
strengthened: its original assertion could pass when reveal routing was disabled.
It now settles a synthetic distant viewport, requests the real production reveal,
asserts scrolling from 9,000px to 0 and card expansion, and demonstrably fails
when reveal routing is disabled in an isolated source copy. The shared test
mount helper flushes the initial frame through React `act`.

Distinct correctness, integration and execution reviewers examined the scoped
changes. The execution review demonstrated credible failing mutations for 33
new executable cases in isolated source copies. Source/CSS wiring assertions
are static contract evidence, not runtime or visual acceptance. No dependencies,
protocol fields, model prompt text, or test-only production seams were added.
The removed roster/strip tests describe deliberately removed UI; dock owner
and DOM tests cover their replacements.

## Spec and integration

The written renderer requirements are implemented: one pane-local responsive
dock, panel/chip/floating/dialog selection, terminal settling and retention,
Clear across reload, resumed runs, foreground-only activity, lease-derived
details, durable engine identity, offscreen observation, Finished disclosure,
transcript reveal, accessibility attributes/focus and motion/reduced-motion
owners. Actual painted geometry, motion and native accessibility remain pending.

The `App.tsx` conflict retains both main's app-owned workspace-jump turn-start
tracking and the dock's shell observation. The theme-test conflict retains
animation discovery, including main's existing classes and the dock's separate
reduced-motion rule. Main's unpublished commits and unrelated working files
must be retained through the final local merge.

## Fresh verification

Validated runtime contents are at `16c0a7e1`, incorporating main `bbe5e2ed`
(two additional documentation commits beyond the dispatched `b05de039`). The
initial integration/repair commit is `7df183d0`. The final documentation commit
and landed main SHA are reported by the completing session.

| Check | Fresh result |
|---|---|
| `bun test app/` | 5,763 passed, 3 skipped, 1 failed; 5,767 tests across 388 files, 296.78s. The only failure is the relocation timeout discussed below. |
| Focused repaired state, dock DOM and transcript DOM | 60 passed, zero failed, 341 assertions across four files (Bun also selects the adjacent `.tsx` DOM file). |
| `bun run --cwd app typecheck` | Passed on the integrated tip, including Fast Refresh boundaries. |
| `bun run --cwd app typecheck:sidecar` | Passed; wrapper ignored 5,575 existing upstream diagnostics. |
| `bun run --cwd app renderer:build` | Passed; existing large-chunk warning remains. |
| `bun run maps:lint` | Passed, 17 maps, zero warnings. |
| `git diff --check` | Passed. |

The full-suite failure was `empty Chat moves live, parked and closed without
losing its identity or startup artifacts` at `chatRelocation.feasibility.probe.test.ts:598`.
An `ECONNREFUSED`/reopen timeout changed the expected untrusted-project refusal
into the fallback “original Chat could not reopen” error. A clean archived main
snapshot at `b05de039` passes both relocation scenarios (2 passed, 65.29s), and
the exact failed scenario passes alone in the integrated dock worktree (1 passed,
25.03s). The two later main commits change only unrelated research documents;
host, sidecar, shared and engine contents are identical to the tested baseline.
The initial full-suite run also passed both relocation scenarios. This is evidence
of a transient process failure, not a reproduced baseline defect or an all-green
full suite. Its frequency and underlying environmental cause were not established.
No unrelated relocation source or expectations were changed. One earlier baseline
attempt lacked socket permission and is excluded from behavioral evidence.

The five failures introduced by the review regressions were separately reproduced
before their fixes and all pass now. All historical implementation-report UI
failures pass on the current baseline (107 tests across App, GoalMemoryPages and
PermissionRulesEditor); no historical failure list was accepted as current proof.

Evidence logs and isolated mutation copies are under
`/tmp/subagent-dock-review-20261011/`; these temporary files are not fixtures.
The full-suite runtime tree and final integrated runtime tree are identical; the
later integration adds only main's two research documents.

## Operator acceptance still pending

The implementation plan explicitly permits leaving operator steps when GUI
authorization is unavailable. `CLAUDE.md` section 10 requires authorization for
GUI launches/driving. Headless evidence supports local integration; it does not
establish GUI acceptance. Use **Cat Code Dev** and
[GUI-VERIFICATION.md](../migration/process/GUI-VERIFICATION.md) for:

1. Compare a wide pane with the approved mockup; collapse/expand and inspect
   face/name trajectories and focus, including long and unnamed workers.
2. Split two and three panes, then resize to an 852×467 window and a 20% pane.
   Check flat/chip/floating/Workers fallback and pane-isolated contents.
3. Hover and Tab through row/chip details; verify baselines, left/below fallback,
   clamping, scrolling details out of view, and Escape.
4. Inspect existing authorized evidence for running/background/waiting/terminal
   and resumed states, 700ms/1,500ms holds, 1.8s arrival, and active-lease details.
   New model turns or account operations require their own authorization.
5. Click a distant Finished row and verify scrolling to its expanded card.
   Repeat with truncated history and verify earlier-history host delivery.
6. Clear, reload/reopen the same engine session, and inspect offscreen completion
   and a later resumed finish. Confirm one row and retained Clear markers.
7. Repeat geometry and motion in light appearance and reduced motion; record
   live screenshots/labels for each acceptance claim.
