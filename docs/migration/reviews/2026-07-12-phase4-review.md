# Phase-4 whole-phase integration review — REPORT

**Date:** 2026-07-12 · **Branch:** `migration` · **Instrument:** orchestrator-driven fan-out
(6 by-layer coverage lanes L1–L6 + 3 cross-cutting sweeps S1–S3 + orchestrator source-verification of
every HIGH and the one inter-lane conflict). Plan: `2026-07-12-phase4-review-plan.md`.

> **Scope caveat (honest):** this review ran BEFORE the pending Phase-4 GUI acceptances
> (P4-5/8b/15/17/18-leftovers/19) were green — its dependency line is not yet met. It therefore
> judges **code / integration / security / parity**, and its GATE call is a *pre-gate* certification:
> it can prove the gate is NOT met, but a MET call would still require the outstanding GUI acceptances.
> Running it now caught two confirmed blockers before any further operator GUI time was spent.

---

## VERDICT — Phase-4 gate NOT MET

The gate is `(~80% realized parity) AND (security baseline intact) AND (every surface real)`. **All three
sub-conditions fail:**

| Sub-condition | Result |
|---|---|
| Security baseline intact | ❌ **1 CONFIRMED HIGH fail-open** — workspace-trust gate is bypassable |
| Every surface real | ❌ **Sessions page (P4-6a) has no working entry point** — nav is inert, confirmed at source |
| ~80% realized parity | ❌ **≈62%** (recomputed; §28-corrected) — well above the stale 36% of record, ~18 pts short of gate |

- **Confirmed blockers: 2** (trust fail-open; Sessions-nav dead). Both are headless-green /
  GUI-invisible and both **contradict a signed-off STATUS claim** — exactly the defect class this
  review exists to catch.
- **Additional HIGH: 1** functional (live-only tool-card auto-expand), source-verified.
- **Parity-ledger honesty cluster: 3 HIGH** — the ledger cannot currently serve as the gate
  instrument until corrected (§28 counts a deleted feature; Part D rollup stale; P4-8 "wired" overclaim).
- **Realized parity: ≈62%** (CI 60–65%), and even that **overstates fidelity** parity per STATUS's own
  honesty banner (low-fidelity composer adaptations count as "built").

**The two code blockers are small, localized fixes. The gate is not far off structurally — it is held
by 2 one-function fixes, a ledger correction + re-measure, and the outstanding GUI acceptances.**

---

## Method note — how conflicts were resolved

The 6 coverage lanes ran first (sonnet), then 3 sweeps (Opus, S1/S2 at the systemic-defect layer).
S1 and S2 doubled as adversarial verifiers of the two biggest HIGHs. **One inter-lane conflict arose
and was settled by the orchestrator reading source directly:**

- **Sessions-nav conflict:** L4 + S2 said the nav is dead (guard omits `'sessions'`); **S3 dissented**,
  reporting `onSelectView(item.id)` as unconditional. **Orchestrator source read (`Sidebar.tsx:462-466,
  514-518`) confirms L4 + S2: the `onClick` guard is `chat||orchestrator||goals||accounts||settings`
  and omits `'sessions'`. S3 misread — it missed the enclosing `if`.** L4+S2 CONFIRMED, S3 dissent rejected.
- The other two functional/security HIGHs (trust fail-open, tool-card auto-expand) were **each
  re-verified at source by the orchestrator** (line-level reads cited below), not accepted on a single
  lane's word.

---

## RANKED FINDINGS

Confidence: **CONFIRMED** = source-verified by orchestrator and/or two independent lanes ·
**PLAUSIBLE** = one lane, concrete mechanism, not yet independently reproduced.

### BLOCKERS (must fix before the gate)

**B1 · HIGH · CONFIRMED · Security — workspace-trust gate fails OPEN on a null/failed trust snapshot.**
`app/sidecar/sidecarServer.ts:734` · `app/sidecar/workspaceTrustDomain.ts:152-163` · `app/sidecar/sessionController.ts:410`
Found L2, independently reproduced + root-caused + generalized by S1, and **line-verified by the orchestrator.**
- Producer `readWorkspaceTrustSnapshotOnce` computes `trusted = executor.isTrusted()` **first**, then
  `await getGithubRepo()`; **any throw → `return null`**, discarding the already-computed (possibly
  `false`) trust fact. `getGithubRepo()` (`src/utils/git.ts:504`) has no try/catch and throws on a
  git-spawn failure; `isPathTrusted → getGlobalConfig` can throw on a corrupt `~/.cat-code`.
- Consumer gate `if (this.workspaceTrust?.getSnapshot()?.trusted === false)` — a `null` snapshot yields
  `undefined === false` = **false → gate skipped → `handleSubmit` runs a full turn (tools + HOOKS) at an
  unvetted cwd.** The domain object still exists (the `await` at `sessionController.ts:410` cannot
  rethrow — the read is swallowed), so this is not the "domain absent / probe" path.
- **Double failure:** `sendWorkspaceTrustSnapshot` also skips on a null read, so **no trust prompt is
  ever shown** — this is *silent* untrusted execution, not a visible-but-bypassable prompt. Hooks do not
  self-gate on the non-interactive sidecar path (comment at `sidecarServer.ts:729-733`), so this gate is
  the only chokepoint. A single corrupt config or transient git failure disarms trust for **every** session.
- **Generalization (S1):** this is the *sole* security-consuming instance of the `catch→null→permit`
  class; every other domain's `catch→null` is consumed only by a frame-skip (fail-closed display), and
  every inbound verb fails closed. The rest of the baseline (T5a/T6/T6b/T7, secretGuard-on-send,
  directional frame limits, HC1/HC3, secret-owner, bypassPermissions) is **certified clean**.
- **Failure scenario:** user opens a session in an untrusted cwd whose `.git` is mid-rewrite by another
  process → `getGithubRepo()` throws → snapshot `null` → no trust dialog → first `app.submit` executes
  tools/hooks at the untrusted cwd (the T8 workspace-injection class the gate exists to stop).
- **Fix:** invert the consumer to **fail closed** — when `this.workspaceTrust` is present, require
  `getSnapshot()?.trusted === true` to proceed (null/absent ⇒ untrusted ⇒ deny + emit an untrusted
  snapshot so the renderer shows the prompt); keep the domain-absent probe path permissive. Producer:
  compute `trusted` independently of the cosmetic `detectedRepo` read so a git failure can't null it out.
  **Add the missing `handleSubmit`-under-null-snapshot boundary test** (existing null test covers only the
  display path).

**B2 · HIGH · CONFIRMED · Functional + STATUS-honesty — Sessions page (P4-6a) is unreachable; it never worked from committed source.**
`app/renderer/src/Sidebar.tsx:463, 515` (guards) · `:51` (`enabled:true`) · `App.tsx:1378` (mount) · STATUS.md:269
Found L4, git-traced by S2, **line-verified by the orchestrator; S3's "reachable" dissent is a misread.**
- Both `onClick` guards (`NavItemExpanded:463`, `NavItemRail:515`) wrap `onSelectView(item.id)` in
  `if (item.id === 'chat' || 'orchestrator' || 'goals' || 'accounts' || 'settings')` — **`'sessions'`
  is absent.** The NAV item is `{ id:'sessions', enabled:true }` (`:51`), so it renders as a normal
  **clickable** button (not the disabled variant) — *looks* clickable, silently inert.
- No other path reaches `activeView='sessions'`: the only dynamic `setActiveView` (`App.tsx:1298-1303`)
  forwards whatever the Sidebar passes; every static call is `'chat'`; the ⌘K palette has **no**
  view-switch action (verified L4 + S2).
- **Git determination (S2):** `'sessions'` was in the guard at **no** commit. `f6101d3` (the P4-6a
  "GUI-VERIFIED 2026-07-10" commit) added the enabled item but the guard already omitted it; `3e34ccf`
  (P4-8a) honestly *disabled* it; `5f34fe4` (P4-8a merge, current tip) re-enabled the row while the
  guard still omits it — re-introducing an enabled-looking-but-inert nav row. **So STATUS's "P4-6a ✅
  GUI-VERIFIED 2026-07-10 — 69 sessions" is not reproducible from committed source** (verified against
  an uncommitted patch, or overstated). A shipped ✅ surface with no working entry point.
- **Fix:** add `'sessions'` to both guards — or, better, delete the guard entirely (it is now a dead
  allowlist; every NAV item is `enabled:true`, and `App` already forwards faithfully) and call
  `onSelectView(item.id)` for any enabled item. Then **re-run the P4-6a GUI acceptance for real** and
  correct the STATUS row. Also fix the stale `Sidebar.tsx:46-47` comment ("All five are built" — there
  are six nav items and one is inert).

### HIGH (non-blocking to the gate call, but fix before the owning session's ✅)

**B3 · HIGH · CONFIRMED (source-verified) · Functional — errored tool cards never auto-expand on a live turn.**
`app/renderer/src/TranscriptView.tsx:472, 548`
Found L3, **line-verified by the orchestrator.**
- `ToolCardShell` reads `defaultExpanded` **only** in `useState(defaultExpanded ?? false)` (`:472`) —
  there is no syncing effect. `ToolCard` sets `defaultExpanded={row.status === 'error' || isImageDone}`
  (`:548`). Because status is derived at **read-time** on a stable-keyed row (P2-2 pattern — the row is
  never re-created, key = `row.id`), the same `ToolCardShell` instance persists across `pending → error`,
  so the initializer never re-runs and the card **stays collapsed** on a live failure. Every family except
  `bash` (which has a `BashTailPeek` collapsed fallback) shows only a red "failed" header. Same mechanism
  defeats image-gen auto-expand.
- **Headless-invisible:** the existing test (`TranscriptView.test.tsx`) constructs the row already
  `status:'error'` and renders once — it exercises the replay/restore path (frames arrive pre-resolved),
  never the live `pending→error` transition. Only visible on a live turn.
- **Fix:** track prior status in a ref and `setExpanded(true)` via effect on the transition into
  `error` / imagegen-done, instead of relying on the mount-only initializer. Folds into the pending
  P4-18 GUI acceptance.

### Parity-ledger honesty cluster (HIGH — the ledger is not gate-trustworthy until fixed)

**B4 · HIGH · CONFIRMED · §28 ResumeStates counts a DELETED feature as built/adapted (silent parity inflation).**
`docs/migration/PARITY-LEDGER.md §28 (~:1888-1933)`, dup citations `:152, :2070, :2204`; FLOW-7 residue.
Found L6, quantified by S3. ~26 in-scope rows still tagged ✅ built / 🔁 adapted, all citing
`ResumeDialog.tsx:*` / `resumeDialogState.ts:*` — **files deleted by P4-22 (`407dafd`); `rg ResumeDialog
app/` = 0 hits.** Both P4-22's STATUS row and P4-23's prompt asserted the re-tag happened; it never did.
Every §28 evidence cite is a dead `file:line`. **Fix:** re-tag §28 (and FLOW-7 resume rows) → ✂️ cut,
mirroring how P4-23 correctly did its own removal (`PARITY-LEDGER.md:372`); delete the dead citations.

**B5 · HIGH · CONFIRMED · Part D metrics rollup is stale in BOTH directions; the gate metric is currently meaningless.**
`docs/migration/PARITY-LEDGER.md Part D (~:2409-2463)`
Found by S3. Part D was last hand-computed at ledger landing (2026-07-07 = 36%) and never re-derived,
though ~10 sessions since flipped their DETAIL rows. Rollup-vs-detail examples: §14 Pages 0%→68%, §15
AccountLifecycle 0%→100%, §25 SettingsExt 0%→76%, §26 RemoteSettings 13%→100%, §29 Welcome 13%→78%,
§28 100%→0%(cut). **Proof of non-derivation: three different "built" totals coexist — detail rows 595,
per-surface rollup 370, Totals row 312.** The phase gate reads Part D, so it currently reads ~25 points
too low. **Fix:** re-derive Part D from the detail rows (a generator script would prevent recurrence —
there is none today).

**B6 · HIGH · CONFIRMED (triple: L5 + S2 + S3) · P4-8 "two-strikes rider RESOLVED — WIRED" is false; the cited arm is dead.**
`agentIdentity.ts:334` (dead arm) · `orchestratorState.ts:80-83` (duplicate) · STATUS.md:271
STATUS claims `deriveTaskAgentState`'s `blocked→'waiting'` arm "now reachable from the real
`handoffStatus` field." Source: that arm requires `options.blockedOwner==='orchestrator'`, and its only
production caller (`tasksState.ts:137 → TasksDialog.tsx:172`) passes no options — so it is **dead** (only
`agentIdentity.test.ts` exercises it, manufacturing apparent reachability). The live orchestrator roster
renders via a **duplicate** encoding in `orchestratorState.ts` that never calls `deriveTaskAgentState`.
The P4-2 "wire-or-delete" two-strikes rider is thus **neither wired nor deleted** — a parallel impl was
added. This is CLAUDE.md §8 #7 (unwired feature) + #10 (duplicated machinery). **Fix:** route the roster
through `deriveTaskAgentState` **or** delete the dead arm + the dead `AgentStateKey.blocked` vocabulary;
correct STATUS.md:271 to cite `orchestratorWorkerState` as the reachable path.

### MED

**M1 · MED · CONFIRMED · agentMode.active is always false in the desktop app → self-contradicting blocked-worker UI.**
`app/renderer/src/OrchestratorPage.tsx:201-217` · `WorkerFocusView.tsx:119-135` · `agentModeDomain.ts:56`
Found L5. Nothing ever sets `CLAUDE_CODE_AGENT_MODE` in `app/` (only the standalone CLI does), so
`AgentModeSnapshot.active = isAgentMode()` is false for every desktop session. A subagent's
`ask_orchestrator(kind:'blocked')` (not env-gated, `tools.ts:241`) still produces `handoffStatus:'blocked'`.
The WorkerDetail/Focus copy "the orchestrator resolves this… you don't act here" renders **unconditionally**
on `blocked && blockReason`, while the adjacent `active`-gated badge always shows amber "Needs you / → you"
— every blocked worker shows "act now" beside "you don't act here." **Fix:** gate the panel copy on
`active` like the badge (or drop the orchestrator-resolves framing until the desktop app can launch a
session in Agent Mode). Folds into the pending P4-8b GUI acceptance.

**M2 · MED · CONFIRMED (L1 + S2 + S3) · P4-6b work sits UNCOMMITTED on the tree while STATUS/ledger record it deferred/0%.**
Untracked: `app/renderer/src/{MetadataInspector,SessionActionsMenu}.tsx`, `{sessionActions,messageMetadata}.ts`
(+ tests) · modified `SessionsPage.tsx`. Genuine P4-6b WIP (in `app/`, not the `src/` memory-audit
workstream). `SessionsPage.tsx:23,27` imports `resolveSessionActions`/`SessionActionsMenu` but **never
renders them** (dead imports that would trip `app`'s strict typecheck if committed as-is). Ledger §17/§18
(0% built) don't reflect the partial build. Given the 2026-07-11 `git reset --hard` that already wiped
uncommitted STATUS edits (STATUS:290-297), this is at real **data-loss risk**. Owner is tracked (P4-6b),
so it isn't lost from *planning* — but reconcile on-disk-vs-record: **commit to a branch / stash-to-branch,
and either finish the SessionsPage wire-in or drop the dead imports.**

**M3 · MED · CONFIRMED · §5/§6 retain 41 ❓ "missing-no-owner" after P4-18 claimed to own+flip them.**
`docs/migration/PARITY-LEDGER.md §5 (17 ❓), §6 (10 ❓)`. The residual rows are legitimately unbuilt
(remark-gfm / syntax-highlighter / word-diff dep-gated deferrals) but P4-18 owns §5/§6 and STATUS says
"§5/§6 ledger rows flipped." They should be **⬜ deferred (owner P4-18)**, not ❓. Immaterial to the 62%
(both count in-scope) but the Part C gate rule requires ❓ empty-or-waived — 41 ❓ would block the gate on
a technicality. **Fix:** reclassify owned ❓ → deferred(P4-18).

**M4 · MED · CONFIRMED · Composer renders structurally ABOVE the transcript (DOM-order inversion vs prototype).**
`app/renderer/src/App.tsx` `SessionPane` (~:1867-2136). DOM order is header → banners → composer `<form>`
→ … → transcript `<section>`; the prototype (`Chat.jsx:1268,1320`) makes the transcript the full-height
`flex:1` region with the composer a bottom-pinned overlay. Present since the walking skeleton, but P4-18c
("scroll fix") and P4-24 ("composer fidelity") both worked this region and left it inverted. `PARITY-LEDGER.md:440`
undersells a full DOM-order inversion as a cosmetic "no gradient/absolute overlay" miss. **Fix:** make the
transcript the full-height flex-1 scroller and float the composer over its bottom; reword the ledger row.
(The specific "transcript `<section>` is the sole flex-1 + overflow-auto scroller" claim from P4-18 *does*
check out — the issue is its position, not its scroll behavior.)

**M5 · MED · UNVERIFIED (lane conflict) · ToolInspector may reimplement engine tool-summaries; GenerateImage drift possibly unreported.**
`app/renderer/src/ToolInspector.tsx:74-102`. L6 reports a pinned drift test at `agentConfigDomain.test.ts:303-311`
("documents current GenerateImage summary drift") whose finding was never surfaced in STATUS/ledger per the
P4-21 contract; **S3 looked in `ToolInspector.test.tsx` and could not substantiate the pin.** The two
looked in different files. **Action:** confirm whether the pin exists at L6's cited location before
treating this as a firm §0 gap; if it does, either wire `describeToolForInspector` to the real
`getToolUseSummary` (kills the whole class) or add `output_path` ahead of `prompt` in `SUMMARY_KEYS`, and
log the drift.

**M6 · LOW-MED · CONFIRMED · tasksState / goalMemoryState skip the lifecycle sessionId guard → unbounded stale-key growth.**
`app/renderer/src/tasksState.ts:39-43` · `goalMemoryState.ts:40-44`. The other 6 read-seam state files
guard the `lifecycle` case with `if (!(frame.sessionId in state.sessions)) return state`; these two spread
`undefined`/`null` unconditionally, materializing one permanent dead key per session that ever emits a
lifecycle frame. Functionally invisible (selectors return null either way) but an unbounded-growth
divergence from the recipe. **Fix:** add the same `in`-check guard.

### LOW (defer / track)

- **L-a · LOW · tasksState.ts:104** — an `as` cast whose adjacent comment claims there is none (safe,
  guarded by a `Set.has` check that doesn't narrow TS). Reword the comment or use a type-predicate.
- **L-b · LOW · WorkspacePanels.tsx:288** — hardcoded `#60a5fa` hex classes duplicate the existing
  `--color-source-project` token (not the interpolation trap — static literals emit fine). Use the token.
- **L-c · LOW · WorkspacePanels.tsx:147** — one inline `style={{flexBasis}}` (pre-existing P3-6). The one
  legitimate exception to the static-map rule (continuous drag width has no enumerable class domain).
- **L-d · LOW · agentIdentity.ts:36,164** — `AgentStateKey.blocked` ("Needs input") is dead vocabulary; its
  comment overclaims a P4-8c "render remap target" that can't exist (no `handoffStatus` on `AgentToolSource`).
  Folds into B6's delete option.
- **L-e · LOW · PlanPanel.tsx:334-353** — `ApproveMenu`'s window keydown listener lacks `stopPropagation`;
  if a second unrelated permission is pending in the same session while the approve menu is open, Enter/1/2
  also fires `App.tsx`'s doc-level permission shortcut and allow-onces it. Narrow (needs two concurrent
  pendings); does NOT reopen the plan bare-Enter fix (that still holds). Add `stopPropagation`/scope the listener.
- **L-f · LOW · app/host/registry.ts:159-198 + registry.test.ts:697-728** — the P4-21 host transcript-path
  codec family can't catch engine `sanitizePath` drift by construction (host must stay engine-free; both the
  impl and its test independently re-derive the regex). Document that it guards internal regressions only, or
  add a manually-synced fixture keyed to `sessionStoragePortable.ts` with a re-verify anchor comment.
- **L-g · LOW · onComposerKeyDown (App.tsx ~:1756-1864)** has zero DOM-event-level coverage (repo-wide
  no-jsdom constraint). A branch-precedence regression (Enter submitting with the picker open, IME guard
  slipping) passes `bun test app/` and only surfaces live — the same gap that caused the 07-09 P4-0 GUI
  failure. Adding a DOM-test dependency needs operator sign-off. (See systemic pattern #1.)
- **Accepted (pre-existing, unchanged by P4):** `secretGuard` is key-name-only, so a user-*inlined* secret
  in a value string (`directConnect.serverUrl`, verb-result `message`, `AccountStatus.lastError`) rides
  through — already on record in SECURITY-MINIMUM.md's 2026-07-09 scope note as LOW/accepted.

---

## CROSS-LANE SYSTEMIC PATTERNS

**P1 — The headless battery is structurally blind to interaction / transition / live-path defects.**
B1 (untested null-snapshot edge), B2 (no `Sidebar` component-click test), B3 (test uses pre-resolved rows,
never the live pending→error transition), M1 (`active`-flag UI), and L-g (no keydown DOM test) are ALL
headless-green and only manifest live. This is the CC-1 "function-done ≠ feature-complete" lesson recurring
across five findings. **The ✅/headless-GREEN signal is being over-trusted.** The pending GUI acceptances are
load-bearing, not a formality; and a minimal DOM-interaction test harness (composer keydown, nav click,
tool-card status transition) — operator sign-off for the dep — would convert three of these into headless-catchable.

**P2 — STATUS / PARITY-LEDGER claims are running ahead of committed source.**
P4-6a "GUI-VERIFIED" not reproducible (B2), P4-8 two-strikes "WIRED" false (B6), ledger §28 not re-tagged
(B4), Part D rollup stale (B5), dead-vocab "remap target" overclaim (L-d), §5/§6 "flipped" but still ❓ (M3).
**This directly validates and should seed the operator's paused STATUS-truthfulness audit** (STATUS:180) —
these six are its first confirmed entries. The `✅` symbol overloading "merged" vs "parity-complete" (the
07-11 honesty banner) is the same disease.

**P3 — Reuse-not-duplicate slippage in the orchestrator/vocab layer.**
Parallel `deriveTaskAgentState` / `orchestratorWorkerState` encodings (B6); ToolInspector possibly
reimplementing `getToolUseSummary` (M5). Low blast radius today (implementations agree) but no drift guard —
the exact class P4-21 exists to prevent, now appearing inside the orchestrator surfaces P4-21 didn't cover.

---

## THE PARITY NUMBER

**Realized wireable-element parity ≈ 62%** (S3, recomputed from ledger DETAIL rows with §28 corrected to
cut; ≈935 built+adapted ÷ ≈1,501 in-scope; CI 60–65%; surfaces ≈62.5%, flows ≈60%).

- This is **~26 points above the 36% of record** (2026-07-07) — the phase moved a lot; the number of record
  is grossly stale (see B5).
- It is **~18 points below the ~80% gate target.**
- **It still overstates FIDELITY parity** — per STATUS's honesty banner, low-fidelity adaptations (the
  P4-0/P4-24 composer) count as "built." The genuine remaining work to 80% is real build, not just a re-tag:
  the ⬜ deferred rows (P4-6b, P4-20 AskUserQuestion, the dep-gated transcript deferrals, the P4-19 settings
  split-offs).

**Deferred-split tracking:** P4-6b tracked (see M2 uncommitted-WIP risk) · P4-8b tracked AND built
(GUI-pending) · P4-20 (AskUserQuestion) tracked as a recommendation-not-yet-drafted; its 7 §7 ❓ are
effectively unowned-pending-operator (acceptable per the ledger's own waiver). None silently lost.

---

## FIX / DEFER PLAN

### Must fix before declaring the Phase-4 gate
1. **B1 trust fail-open** — fail-closed consumer inversion + producer decouples `trusted` from the repo read
   + a `handleSubmit`-under-null boundary test. *(Security blocker; small, localized.)*
2. **B2 Sessions-nav** — add `'sessions'` (or delete the dead guard) + re-run P4-6a GUI acceptance for real
   + correct the STATUS P4-6a row and the `Sidebar.tsx:46` comment. *(Functional blocker; one-line fix.)*
3. **B4/B5/M3 parity-ledger correction + re-measure** — §28 → cut, re-derive Part D from detail rows,
   reclassify §5/§6 owned ❓ → deferred(P4-18). Then the gate metric is trustworthy and can be re-read.
   *(The gate cannot be certified against a ledger this stale.)*

### Should fix before / alongside the gate (fold into the owning session's GUI acceptance)
4. **B6** two-strikes: wire-or-delete `deriveTaskAgentState` dead arm + `AgentStateKey.blocked`; fix STATUS:271.
5. **B3** tool-card live auto-expand (`TranscriptView.tsx`) → into P4-18 GUI acceptance.
6. **M1** blocked-worker contradictory copy (gate on `active`) → into P4-8b GUI acceptance.
7. **M2** reconcile P4-6b uncommitted WIP (commit-to-branch) — data-loss prevention, do promptly.

### Safe to defer / track
8. **M4** composer DOM-order inversion (P4-24/P4-18 fidelity rider) · **M5** ToolInspector drift (verify the
   pin at `agentConfigDomain.test.ts:303` first) · **M6** lifecycle guard · all **LOWs** (L-a..L-g) · the
   accepted key-name-only secretGuard scope note.

### Process recommendation
The 62% vs 80% gap is real build, not bookkeeping. Before the next build push, an **operator conversation on
the gate metric itself** is worth having: "~80% of wireable elements" vs "~80% of high-value surfaces/flows"
are materially different targets, and the fidelity-vs-count distinction (honesty banner) means a pure element
count can read "done" while the composer/transcript still feel low-fidelity. Pair any prose/parity claim with
the re-measured number, not the `✅` symbol.

---

## What CERTIFIED CLEAN (so the gate work is scoped, not open-ended)

- **Security baseline apart from B1:** T5a, T6/T6b (echo-only, suggestion-index reattach, no
  prototype-pollution), T7 + directional frame limits (not swapped), secretGuard on every non-error send,
  no token in any renderer-facing frame, HC1/HC3 (fixed channels, cwd only via single-use picker token),
  bypassPermissions rejected pre-parse. (S1)
- **All read-seams** (9 committed `*Domain.ts` + 8 `*State.ts`) conform to the P4-5 recipe: redacted
  projections, no cache-reset-on-attach, sessionId-keyed isolation, graceful degrade. (L1)
- **Inbound write seams** `settings.setValue` (11-key closed allowlist, triple-validated), `workspace.trust`
  ({type,requestId} only, path-forge rejected), `remoteSettings.*` (session-owned cwd) — all fail-closed
  with accept+reject boundary tests. (L2)
- **Composition seams:** P4-19 write ↔ P4-3 read genuine round-trip; Welcome ↔ P4-6 genuine single-merge
  reuse (`selectMergedSessionRows`); Diagnostics ↔ C3 independent, no dup. (S2)
- **Transcript spine:** user-turn echo is real (sidecar-minted, not synthetic); zero `as` casts in projector
  code; **both exhaustiveness tripwires + the fixtures mapped-type mirror fire**; P2 tool-correlation +
  streaming unregressed; P4-23 banner removal kept the P3-7 catalog-capture. (L3)
- **Plan/permission:** bare-Enter plan-approval bypass fix holds; bypassPermissions never offered. (L5)
- **Removals:** P4-22 deletion set fully gone with zero dangling refs. (L6)

---

*Generated by the P4-REVIEW orchestrator fan-out. Not committed. Update the STATUS P4-REVIEW row to reflect
this pre-gate verdict; do NOT flip the Phase-4 gate to met.*
