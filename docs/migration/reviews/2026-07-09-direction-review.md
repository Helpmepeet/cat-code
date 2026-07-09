# Direction review — 2026-07-09

**Scope:** mid-Phase-4 check of the program's direction and its operational health — not a
per-session code review. Asks two questions: (1) is Phase 4 pointed at the right place with a gate
it can actually clear, and (2) is the machinery *around* the program (process hygiene, rulebooks,
instruments, branch topology) keeping up with its velocity. Reviewed against: `STATUS.md`,
`PARITY-LEDGER.md` (Part D), `backlog/phase4.md` (standing rules), `.claude/rules/migration.md`,
`process/GUI-VERIFICATION.md`, `decisions/SESSION-LIFETIME.md`, the working tree at `migration`
@ `407dafd`, and the **live machine state** (process table, registry file, `/tmp`). Every claim
below was re-verified this session, not read off a doc.

**Verdict:** the architecture layer is sound — no locked decision needs reopening, the security
baseline held every check, and the tree's own battery is green. The problems are one level up:
the Phase-4 gate as stated is arithmetically out of reach and bends toward re-classification;
the build order doesn't serve the daily-drivable goal; and the operational layer (orphaned engine
processes, contradictory GUI rulebooks, un-encoded lessons, a dead `main`) is degrading **now**,
independent of how the remaining sessions go.

**Verification ledger (run this session on `407dafd`):**
- `bun test app/` → **598 pass / 0 fail** (70 files, 9.2s). Matches the P4-22 row's claim.
- `bun run --cwd app test:hardening` → **19/19 passed** (incl. packaged-path no-debug-export).
- Sidecar process census: **41 orphaned** `bun run …/app/sidecar/index.ts` processes (oldest
  ~22h; ~60 MB RSS each ≈ 2.5 GB; 0.0–0.7% CPU each), **43 stale `/tmp/catcode-*` socket dirs**.
  Re-counted before/after the full `bun test app/` run: **identical count** — the test suite is
  NOT the leak; GUI/dev launches are.
- `~/.cat-code/desktop/registry.json`: **32/32 rows** (27 `clean`, 5 `crashed`); cwd mix
  15 × `~/cat-code`, 10 × `~/catcode-gui-scratch`, 7 × `~/cat-code/app` — dev/GUI churn.
- `git merge-base main migration` → `234da9e` (2026-06-30); `git rev-list --count
  migration..main` → **0**. `main` has not moved in 9+ days; all engine work is migration-only.
- `bun test src/utils/permissions/enableAutoModeFlag.test.ts` → **13 pass / 4 fail** on HEAD
  (the "pre-existing unrelated" failures cited in the P3-5a row — still red, unowned).
- Three orphan sidecars belong to **already-deleted** worktrees (`wf_62944c24-b0b-3`,
  `wf_62944c24-b0b-8`, `wf_3cfb55a8-5bc-2`) and five more to two **already-deleted** sibling
  clones (`~/cat-code-p40-fix`, `~/cat-code-p418a-fix`) — structurally unreapable.
- P4-5's stated GUI precondition ("app left running, pid 98864") → **pid dead**.

**Independent verification pass (2026-07-09, cold second model): YELLOW — accepted with errata,
now applied in-place.** Every load-bearing claim re-confirmed (branch state, orphan census,
registry contents, D1/D4/D5/D6/D7, O1–O8); verifier additionally re-ran the full app battery
plus `bun run --cwd app typecheck`, `typecheck:sidecar` (5,548 upstream ignored, 0 owned),
`renderer:build`, and root `bun run build:dev:full` (`./cli-dev --version` →
`2.1.87-dev.20260709.t062944.sha407dafda`) — all green — and confirmed the D4 rider (stale
ResumeStates ledger rows still need ✂️ re-tagging). Errata applied: **D2** narrowed (a generic
`ToolCard` DOES render tool use; the gap is per-family fidelity, 18b); **D3** corrected (inbound
mutation vocabulary exists for permissions C1/C2 and P4-5's account verbs; the unexercised seam
is specifically the settings write); **O4/O7** corrected post-verification (the two fix-clones
are already deleted, their sidecars orphaned — strengthening O1, which now counts 8 orphans from
deleted checkouts).

---

## Part 1 — Direction findings (D1–D7)

### D1. The Phase-4 gate (~80% parity) is arithmetically out of reach as scoped — and the metric rewards re-classification over building

`PARITY-LEDGER.md` Part D: surfaces sit at **34% realized** (507 built+adapted of 1,472
in-scope), with **845 rows deferred**. Reaching 80% means moving ~670 more elements to
built/adapted across the ~13 remaining session-units (~50+ each) — while the sessions landed so
far each *added* to the deferred pile (every domain shipped read-only; verbs/writes/editors
deferred). The metric also improves when a session re-tags ⬜ deferred → ✂️ cut, because cuts
leave the in-scope denominator: **AgentsPage reads 100% realized in Part D while its STATUS row
says "editing intentionally deferred; all definitions report non-editable"** — the editing rows
were tagged cut on a self-authored §0 flag. Nobody is gaming it deliberately, but the pressure
gradient points that way.

**Recommendation:** either (a) make the phase-gate review audit the **✂️ cut list** as hard as
Part C's ❓ list, or (b) restate the gate as a concrete daily-drivable checklist ("I can run a
real day's work in the app") and demote the percentage to a dashboard.

### D2. Priority inversion: the core chat surface is still not usable while ancillary read-only panels land

On HEAD: the transcript **is not scrollable** (P4-18c owns it; `App.tsx:1277`'s `overflow-auto`
doesn't engage under the flex chain), only a generic `ToolCard` renders tool use
(`TranscriptView.tsx:159`) — the prototype's rich per-family cards (Bash/diff/Grep/Web/…) are
18b ⬜ — paste shows a raw `[Pasted text #N]` token, and sessions have no titles (P4-6 rider) — while Goals, Memory, and
Agents-config read-only viewers are ✅. The remaining tranche order still queues P4-9/11/13/14
(panels nothing depends on) alongside the surfaces every user minute touches.

**Recommendation:** jump P4-18b/c + the P4-6 title rider ahead of the rest of Tranche C. This
also unblocks D7 (dogfooding can't start on an unusable core loop).

### D3. The write path is back-loaded to the point of maximum schedule pressure

Inbound mutation vocabulary exists where domains decided it (permissions C1/C2 since P2-4;
P4-5's six validated account lifecycle verbs) — but the **settings write** specifically is
back-loaded: the first renderer→engine settings write arrives at P4-19, late in the phase, and
the 845 deferred rows are disproportionately settings-style editors, verbs, and writes. The
settings write-seam recipe exists engine-side (`SettingsUpdater`-under-lock,
`src/utils/settings/settings.ts`, proven after the P3-5a lost-update race) but has **zero
desktop-plane exercise** — no session has yet carried a settings mutation across the boundary.
This defect class has bitten twice (settings race, resume tip-selection), always found late and
live.

**Recommendation:** land one thin end-to-end write early (a single settings toggle through the
full boundary) before mass-producing panels that all need the recipe.

### D4. Prototype-parity-by-default now produces work the operator reverses

P4-16 was drafted, built (`899da0d`), reviewed GREEN, merged — and deleted two days later by
P4-22 because the confirm-modal/hydration-overlay flow is bad UX under one-cwd-per-session. A
full session + review + merge + a removal session, round-tripped. D3/D4/D5 got operator
*architecture* rulings before dispatch; nobody ruled on the *interaction pattern*. Tranche D's
remaining surfaces (P4-15 startup/trust/OAuth, P4-17 Welcome) are exactly the flow-shaped,
modal-heavy surfaces most likely to repeat this. Bookkeeping rider: the P4-22 row itself notes
ResumeStates' ledger rows (currently "100%") still need re-tagging to ✂️.

**Recommendation:** a five-minute operator interaction-level ruling on each remaining
flow-shaped surface *before* dispatch.

### D5. Verification economics are inverted: the expensive pipeline passes what the scarce resource then fails

Every session in the 07-09 batch was headless-GREEN with cold reviews — and 2 of 5 failed live
GUI (P4-18a user turns never rendered on a live submit; P4-0 history recall never fired).
Historically the live pass is what caught `tools:[]` (P1-3), empty permissions (P2-4),
`commands:[]` (P3-7), the resume tip-selection bug (P3-8), and the user-turn drop (P4-18a).
Meanwhile operator/GUI time is the program bottleneck (P4-5 waiting since 07-09 — and its
stated environment has already evaporated, see O8), and ~7 of the remaining sessions are 🖐 GUI.

**Recommendation:** batch GUI acceptance into fewer, denser operator sittings covering several
sessions' checklists; keep expanding the P3-H debug-export harness so more checks become
export-assertable; and see O3/O4 for the rulebook side of this.

### D6. Watch item: the sidecar-synthesized user frame is the mirror-drift pattern P4-21 exists to police

`efa9ab9` (P4-18a fix): on `app.submit` the sidecar mints a turn uuid and broadcasts a
sidecar-authored `user` message event (`app/sidecar/sidecarServer.ts:565-575`) because the
controller emits none on a live turn. It is carefully done (uuid aligned with the persisted turn
so replay dedups), but the sidecar now **authors a frame shape the engine never emits** — the
inverse of the `tools:[]` defect class. As prompts get richer (paste expansion, attachments,
isMeta variants), the live-echoed frame and the engine's persisted/replayed one can diverge:
live transcript ≠ restored transcript.

**Recommendation:** extend `AppSessionController` to emit the user event from the engine's own
turn (the §8-#1/#10 rulebook answer), or at minimum add a P4-21-style parity fixture pinning the
echoed shape to the engine's persisted user-message shape.

### D7. The roadmap never reconnects with the product's stated goal — and the instrument that would schedule it can't start

The product identity is an **always-on** agent system (package.json, README, GOAL_PLAN). The v1
die-with-window lifetime is locked and correctly not reopened here; `SESSION-LIFETIME.md` L4
defers the always-on/server-Mac milestone as **v2 ("deferred, not foreclosed")** and names the
**DR-3 dogfood-gate probe** (`SESSION-LIFETIME.md:179`) as the instrument that prices whether
losing sessions on quit actually hurts. But no phase in PROGRAM-PLAN schedules dogfooding or the
v2 decision point — Phase 5 is packaging/signing — and dogfooding can't begin while the core
loop is unusable (D2). As written, the program ends with a polished die-with-window app and an
unmeasured always-on question.

**Recommendation:** when Phase-5 sessions are generated, include an explicit DR-3 dogfood window
and a named v2 go/no-go decision point. (D2's re-ordering is what makes the window possible.)

---

## Part 2 — Operational findings (O1–O8)

### O1. 41 orphaned engine processes are running right now; the reap design is structurally broken for the actual dev workflow

Census above. Mechanism, not bad luck:

- Sidecars deliberately survive parent death (non-welding evidence, crash-restore); the sidecar
  has **no self-lifetime** — `app/sidecar/index.ts:251-257` handles only SIGTERM/SIGINT. No
  "supervisor gone + no reconnect in N minutes → exit" TTL. `SESSION-LIFETIME.md` itself notes
  "the socket is not parent-bound, so nothing reaps them automatically" and (rejecting partial
  survival) that it "creates invisible running engines" — the residual was accepted on the
  assumption the next launch sweeps.
- The only reap is the registry sweep at next app launch, but `MAX_REGISTRY_SESSIONS = 32`
  (`app/host/registry.ts:58`) evicts oldest terminal rows (`registry.ts:537`) — **an evicted
  row's orphan pid becomes permanently unreachable**. Harness/test-spawned sidecars never
  register at all. Launches happen from many checkouts (main repo, agent worktrees, sibling fix
  clones), churning the one shared registry.
- Eight orphans belong to deleted checkouts (3 `wf_*` worktrees, 2 sibling fix-clones):
  unreapable by anything.

This recreates the June energy investigation's failure mode via the migration's own dev process,
and nobody noticed because the app has **zero process observability**. For a product whose
premise is N engine processes, a process ledger / doctor surface is not Phase-5 polish.

**Recommendation:** one-shot cleanup of the current fleet; an additive idle-TTL in the sidecar
(does not touch the locked lifetime decision — restore re-spawns from the transcript and never
needs the orphan); a `doctor`-style process-vs-registry view. (Spawned as a task chip
2026-07-09.)

### O2. The registry is full of test churn and silently evicts restorable history

32/32 rows, ~⅓ scratch. Until P4-6 lands, this registry is the app's **only** session catalog —
so the desktop app remembers at most 32 sessions minus GUI-testing churn, evicting oldest-first
with no trace (transcripts persist engine-side but become invisible). A dev-era constant is
functioning as a product data-loss policy, and eviction also breaks orphan reaping (O1).

**Recommendation:** treat the bound + eviction policy as a product decision alongside P4-6, not
a leftover constant.

### O3. GUI verification policy is written three contradictory ways — the one serious incident happened in that gap

- `backlog/phase4.md` standing rules: the worker must **never** drive GUI (no cua-driver).
- `.claude/rules/migration.md`: 🖐 prompts must tell the worker to STOP and print operator steps.
- `process/GUI-VERIFICATION.md:3`: "This process is for **agent-driven** GUI rows after P3-H."

Practice follows the third (P3-6/7/8, P4-0 all agent-driven with per-run authorization); the
P4-4 cursor-warp incident that forced a machine restart happened inside this ambiguity.

**Recommendation:** codify the converged policy (agent-driven with per-run authorization;
hover/focus surfaces operator-only, per the GUI-VERIFICATION hover rule) in ONE doc; make the
other two point at it.

### O4. The last batch's hard-won lessons are not in the rulebook the next sessions will follow

The 07-09 lessons — (1) headless GREEN is insufficient, require **live-path** tests (a
synthetic-frame test masked that no live user frame is emitted); (2) isolate concurrent fixes in
worktrees — exist in STATUS notes and operator memory but **not** in `backlog/phase4.md`'s
standing rules, whose verification section is purely headless. The fix batches themselves ran in
ad-hoc sibling clones (`cat-code-p40-fix`, `cat-code-p418a-fix`) — since deleted, with their
sidecars left running (see O1). This is the "access ≠ use" failure the 2026-07-04 map-usage evaluation
documented: lessons archived where workers don't act on them.

**Recommendation:** patch both lessons into the standing rules before the next dispatch.

### O5. Known-red baseline creep is normalizing deviance

Verified red on HEAD: `src/utils/permissions/enableAutoModeFlag.test.ts` (4/17 fail) — cited in
STATUS as "pre-existing unrelated," registered nowhere, owned by no one. The known-red set is
now: root tsc (~1,862), sidecar tsc overlay (5,548), lint (zero rules), and a red engine suite.
Every new red is justified against the baseline, and each careful session pays a clean-HEAD
comparison run to tell new from old. The two-strikes rule covers review findings; nothing plays
that role for red tests.

**Recommendation:** fix the 4 failures or register them in CLAUDE.md §3 with a named owner.

### O6. Instrument sprawl: two mandatory ledgers, a growing pre-read ritual, nothing retired

Standing rules Step 0 still makes `INVENTORY.md` (last verified 2026-06-28, pre-ledger) the
"marching orders" while also mandating the 1,894-row `PARITY-LEDGER.md` Part A read + row
updates, plus prototype files, STATUS, decisions, GUI-VERIFICATION. Each incident added an
instrument; none was consolidated. The predictable failure is skimming — the exact behavior the
instruments exist to prevent.

**Recommendation:** fold INVENTORY's dispositions into the ledger (or formally demote INVENTORY
to historical).

### O7. `migration` is the de-facto trunk; `main` is dead — against the repo's own rules

Merge-base 2026-06-30; `main` 0 commits ahead. Major **engine** work exists only on migration:
the codex perf batch, the account-system rework merge (`d4bce20`), usage reset, the settings
lost-update fix, and the resume tip-selection fix that STATUS itself says "fixes the daily-driver
TUI too." CLAUDE.md §4's branch separation is dead in practice. Risks: anything built from
`main` silently lacks 9+ days of engine fixes; the eventual merge grows monotonically. Litter
rider: 7 stale local branches (`migration-p3-6/7`, 5 `worktree-agent-*`) and 2 sibling clones
(`~/cat-code-p3-6`, `~/cat-code-p3-7`) on disk against the delete-after-merge rule; 2 more
fix-clones were deleted but left running sidecars (O1).

**Recommendation:** either merge migration→main on a cadence or declare migration the trunk and
update CLAUDE.md §4 + the standing rules to match reality.

### O8. Queued GUI-acceptance debt rots silently

P4-5's row: "app left running (pid 98864) for the Section-3 checks" — the pid is dead. The
acceptance environment is gone and the row doesn't say how to recreate it. Evidence for D5's
batching recommendation: operator-GUI debt decays while it waits.

---

## Prioritized actions

1. **O1** — kill the orphan fleet; additive sidecar idle-TTL; process visibility. (Task chip
   spawned 2026-07-09.)
2. **O3 + O4** — unify the GUI policy into one doc; patch the two batch lessons into the
   phase-4 standing rules *before the next dispatch*.
3. **D2** — re-order: P4-18b/c + P4-6 title rider ahead of remaining Tranche C panels.
4. **D1** — restate the Phase-4 gate (cut-list audit at minimum; daily-drivable checklist
   preferred).
5. **O7** — decide the trunk story.
6. **D3** — one thin end-to-end write early, before the panel fan-out.
7. **O2** — registry bound/eviction as a product decision with P4-6.
8. **D4** — operator interaction rulings for P4-15/P4-17 before dispatch.
9. **O5, O6, D6, D7, O8** — as written above.

## Open threads (checked enough to name, not enough to conclude)

- **Renderer memory over multi-day live sessions:** the transcript projector stores rows
  unbounded by design (raw fidelity); only `rawMessageLog` has a 512-frame display cap. Fine for
  v1 sittings; unmeasured for the always-on use case.
- **Replay truncation UX:** restore replays at most 400 frames / 4 MiB
  (`app/shared/limits.ts:67-68`) with a `catcode.history-truncated` boundary — a real long
  session (P3-8's 1096-row example) restores partial history in the renderer. Bound is
  deliberate; the UX above it (pagination? "load more"?) has no owner.
- **Packaged-build path:** unexercised since P0-1's `bun --compile` probe; every GUI run since
  is dev-mode (`bun run …/index.ts`). Phase-5 scope, but the gap has been growing for five
  phases.
- **`web/` runtime:** untouched since 2026-06-12, superseded in spirit by `app/`, still carried
  as a first-class area in CLAUDE.md §1/§3. Retire or freeze formally?
- **Idle sidecar CPU:** individual orphans show 0.0–0.7% CPU at idle; cause unprofiled (the
  June mailbox-poll fixes predate the merge-base, so something else ticks). Only matters × N —
  which O1's fix bounds.
