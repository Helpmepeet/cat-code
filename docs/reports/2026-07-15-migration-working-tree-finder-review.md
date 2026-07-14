# Migration working-tree finder review — 2026-07-15

**Status: PARTIALLY VERIFIED.** This began as a finder-only review. `EVAL-3` has
since been independently confirmed with a deterministic scorer reproduction;
every other item remains a *claim* awaiting an independent verify pass. **No fix
has been applied.** Do not act on a finding until its **Verify** box is resolved.

## Review baseline & drift status — READ FIRST

This review is a **snapshot of a specific tree state**. `migration` is a live
branch that concurrent sessions commit to, and the tree *moved during the review*.
Use these anchors to tell "what was reviewed" apart from "code that changed
around/after the review":

| Anchor | Value |
|---|---|
| Reviewed on | 2026-07-15 (local, +07) · report finalized 2026-07-14T17:42Z |
| Branch | `migration` |
| HEAD at session start | `3e7aa4e` |
| **Baseline HEAD at finalization** | **`5b2ef3e`** — `feat(agent): add map-first repository routing` (2026-07-15 00:14:59 +07) |
| **Reviewed working-tree fingerprint** | **`b40e26fa30fe59e4847683bc574cdd4ef595beba17538ec80f8366e90c3c3e4e`** (25 files · 2167 ins / 193 del) |

The reviewed content is in **two parts** because HEAD advanced mid-review:

1. **Uncommitted working-tree changes** on top of `5b2ef3e` — 25 files
   (renderer, sidecar, `protocol.ts`, the eval scripts, `implementorAgent.ts`).
   Fingerprint `b40e26fa…` above. This is where all EVAL / SLASH / ACCT / SIDEBAR
   findings live.
2. **Already committed in `5b2ef3e`** — the map-routing engine-agent changes
   (`exploreAgent.ts`, `generalPurposeAgent.ts`, `planAgent.ts`,
   `mapRoutingGuidance.ts` + `.test.ts`, part of `implementorAgent.ts`). A
   concurrent session committed these *during* this review. **ENGINE-1 and
   ENGINE-2 point into this commit, not the working tree** — blob pins:
   `exploreAgent.ts@5b2ef3e = f807396f`, `mapRoutingGuidance.test.ts@5b2ef3e = efdc2a1a`.

### NOT reviewed (out of scope — do not attribute these to this review)

Five files entered the working tree via concurrent host-plane work and were
**never seen by any finder**. No finding below covers them:

- `app/host/host.ts` · `app/main/attachmentGate.ts` · `app/main/replayBuffer.ts` ·
  `app/preload/preload.ts` · `app/shared/hostApi.ts`

### Drift check (run before the verify pass, and before any fix)

If the reviewed working-tree code has changed since this snapshot, the line
numbers below have drifted — re-fingerprint and diff to see what moved:

```bash
cd /Users/pt/cat-code
git add -N app/renderer/src/SlashCommandPicker.render.test.tsx \
  app/renderer/src/slashCatalogState.test.ts app/renderer/src/slashCatalogState.ts \
  scripts/memory-behavior-eval/run.ts
git diff HEAD -- \
  app/renderer/src/AccountsPage.tsx app/renderer/src/App.tsx \
  app/renderer/src/ComposerActionsBar.test.tsx app/renderer/src/ComposerActionsBar.tsx \
  app/renderer/src/Sidebar.tsx app/renderer/src/SlashCommandPicker.test.ts \
  app/renderer/src/SlashCommandPicker.tsx app/renderer/src/replayBatchRender.test.tsx \
  app/renderer/src/serverFrameBatch.ts app/renderer/src/sidebarState.test.ts \
  app/renderer/src/sidebarState.ts app/renderer/src/SlashCommandPicker.render.test.tsx \
  app/renderer/src/slashCatalogState.test.ts app/renderer/src/slashCatalogState.ts \
  app/shared/protocol.ts app/sidecar/index.ts \
  app/sidecar/sessionController.test.ts app/sidecar/sessionController.ts \
  app/sidecar/sidecarServer.test.ts app/sidecar/sidecarServer.ts \
  scripts/memory-behavior-eval/save-side.ts scripts/memory-behavior-eval/run.ts \
  src/agent-mode/rolePrompts.test.ts src/commands/fast/fast.tsx \
  src/tools/AgentTool/built-in/implementorAgent.ts | shasum -a 256
# expect: b40e26fa30fe59e4847683bc574cdd4ef595beba17538ec80f8366e90c3c3e4e
git reset -q -- app/renderer/src/SlashCommandPicker.render.test.tsx \
  app/renderer/src/slashCatalogState.test.ts app/renderer/src/slashCatalogState.ts \
  scripts/memory-behavior-eval/run.ts
```

- Matches `b40e26fa…` → the reviewed code is unchanged; findings/line-numbers valid.
- Differs → re-verify affected files against the current tree before fixing;
  also confirm `git rev-parse HEAD` is still `5b2ef3e` (if HEAD moved again, the
  reviewed changes may have been committed).

## Scope & method

- **Target:** the uncommitted working tree of the `migration` branch vs `HEAD`
  (`git diff HEAD`), code only. Docs/`.md` files excluded by request.
- **Files in scope:** 24 modified + 4 new code files — `app/sidecar/*`,
  `app/shared/protocol.ts`, `app/renderer/src/*`, `src/tools/AgentTool/built-in/*`,
  `src/agent-mode/rolePrompts.test.ts`, `src/commands/fast/fast.tsx`,
  `scripts/memory-behavior-eval/{save-side.ts,run.ts}`.
- **How produced:** two finder-only workflow waves, **28 subagents total**
  (Opus 4.8), no verify stage — all budget spent on *finding*.
  - Wave 1 (14 finders): file-scoped, one lens each (correctness, security
    baseline, simplification, Tailwind trap, provider-keying, test-adequacy).
  - Wave 2 (14 finders): cross-cutting angles wave 1 could not reach —
    end-to-end data-flow, regression-by-deletion, strict-TS exhaustiveness,
    concurrency/ordering, interaction/a11y, and **adversarial re-review** of the
    slices wave 1 called clean.
- **Confidence field** is the *finder's own* self-rating (H/M/L), retained
  because there was no downstream verifier. It is the primary triage signal:
  `conf L` items are where the verify pass earns its keep.
- **Line numbers are finder-reported anchors.** Treat them as approximate until
  the verify pass pins them; the working tree may shift lines as it changes.

## The clean-path signal (a real negative result)

The security-critical slice — `protocol.ts` wire contract, sidecar inbound
boundary, and session lifecycle — was reviewed by **six independent passes** and
**all returned empty**:

- Wave 1: `sidecar-boundary`, `sidecar-session`, `protocol-contract`,
  `app-security-crosscut`, `app-shell` — 0 findings.
- Wave 2: `sidecar-protocol-adversarial` and
  `sessionController-lifecycle-adversarial`, both explicitly instructed *"a prior
  pass found nothing here; assume it missed something and try hard"* — still 0
  findings. Also empty: `deletions-sidecar-engine`, `type-discipline`,
  `renderer-render-perf`.

**Caveat:** static review only, no tests executed. But as a review signal, the
new inbound frame (`slash-catalog`) appears correctly validated at the sidecar,
the contract change appears additive, and no `as`-cast / exhaustiveness / cap /
directional-limit regressions were found. The bugs cluster in **feature logic
and the eval harness**, not the wire boundary.

## Summary

**32 distinct findings** (after dedup of 36 raw): **3 high · 12 medium · 17 low.**

| Subsystem | Findings | Headline |
|---|---|---|
| `memory-behavior-eval` harness (scripts/) | 8 | **4 scoring bugs flip PASS↔FAIL** — the harness silently reports wrong results |
| Slash-catalog feature (new) | 9 | A render-crash path + untested production wiring seam |
| Account switcher (composer) | 10 | Status mislabeling + 3 keyboard/a11y gaps |
| Sidebar | 3 | "Show 0 more" dead button at a boundary |
| Engine agents (src/) | 2 | Repo-specific path hardcoded into portable agents |

**Severity × confidence matrix** (verify effort should concentrate on the
medium/low-confidence cells — high-confidence items are near-certain):

| | conf H | conf M | conf L |
|---|---|---|---|
| **high** | EVAL-1, EVAL-2 | — | — |
| **medium** | EVAL-3, SLASH-2, SLASH-3, SLASH-4 | ACCT-1, ACCT-2, ACCT-3, EVAL-4 | SLASH-1 |
| **low** | EVAL-5, EVAL-6, EVAL-7, SLASH-9 | SIDEBAR-2, ACCT-4, ACCT-5, ACCT-6, ACCT-9, ACCT-10, SLASH-5, SLASH-6, ENGINE-2 | EVAL-8, ACCT-7, ACCT-8, SLASH-7, SLASH-8, SIDEBAR-3, ENGINE-1, SIDEBAR-3 |

## Verification protocol (do this before any fix)

For each finding: (1) open the cited location, (2) confirm the code shape the
finding describes actually exists, (3) walk the failure scenario against the
real code and its callers, (4) mark the **Verify** box:

- ✅ **CONFIRMED** — the failure path is real; promote to the fix queue.
- ❌ **REJECTED** — the finding is wrong or already handled elsewhere; record why.
- ⚠️ **PARTIAL** — real but narrower/wider than stated; note the correction.

The strongest verify approach is an **adversarial refute pass**: a fresh
reviewer told to *disprove* each `conf L`/`conf M` claim, defaulting to REJECTED
unless they can produce the concrete failing input. High-confidence script items
(EVAL-1/2/5/6/7) are mechanically checkable by reading the cited lines and need
only a spot-check.

---

# EVAL — memory-behavior-eval harness (scripts/)

> **This is the highest-value cluster.** Four independent scoring/gate bugs
> (EVAL-1..4) cause the harness to record the *opposite* of the truth, silently.
> Any eval run produced with the current harness cannot be trusted until these
> are resolved. EVAL-5..8 make a broken run *look* successful.

### EVAL-1 · `save-side.ts:379` · 🔴 high · conf **high** · feature-gate-omission
**Claim:** the extraction lane is scored FAIL for every case regardless of
whether memory was actually saved correctly.

**Failure scenario:** `buildForcedGateOverrides` forces `tengu_passport_quail`
on but never forces `tengu_slate_thimble`. In headless `-p` (non-interactive)
mode, `isExtractModeActive()` = `passport_quail && (!nonInteractive ||
slate_thimble)` evaluates **false** (non-interactive + `slate_thimble` defaults
false, `src/memdir/paths.ts:69-77`). So `print.ts:980` skips
`drainPendingExtraction()`; the process exits (the 5s `gracefulShutdownSync`
failsafe does not await the void `executeExtractMemories`,
`stopHooks.ts:164`) **before** the extractor writes `[extractMemories] finished`
(`extractMemories.ts:458`). `inspectExecution` sets `extractionFinished=false`,
and `scoreExecution` (`save-side.ts:475`) pushes "background extraction did not
complete" → **every extraction-lane case FAILs**.

**Proposed fix:** force `tengu_slate_thimble` on in `buildForcedGateOverrides`
(or otherwise make `isExtractModeActive()` true under `-p`) so the harness drains
extraction before exit.

**Verify:** confirm (a) `buildForcedGateOverrides` sets only `passport_quail`;
(b) `isExtractModeActive()`'s definition in current source; (c) `print.ts`
gates `drainPendingExtraction()` on it. If all three hold, CONFIRMED.
**Status: ⬜ UNVERIFIED** *(finder: scripts-eval-logic)*

### EVAL-2 · `run.ts:88` · 🔴 high · conf **high** · scoring-correctness
**Claim:** the `h6` verdict scores maximally-compliant correct answers as FAIL.

**Failure scenario:** `h6`'s prompt tells the model to *"Ignore your memory"*,
but the verdict is `/vitest|memor/i.test(text)` → FAIL, checked **before** the
`/bun[ :]?test/` → PASS branch. A correct answer like *"Ignoring my memory as
requested, this project uses bun:test — run with `bun test`."* matches `memor`
and is scored **FAIL**, corrupting the h6 pass/fail counts.

**Proposed fix:** remove `memor` from the fail-regex (or reorder so the PASS
signal is checked first / require the negative signal to be an actual tooling
claim, not a mention of the word "memory").

**Verify:** read the h6 branch; confirm the fail-regex contains `memor` and runs
before the pass check, and that the h6 prompt text uses the word "memory."
**Status: ⬜ UNVERIFIED** *(finder: scripts-eval-scoring)*

### EVAL-3 · `run.ts:101` · 🟠 medium · conf **high** · scoring-correctness
**Claim:** the `agree` case scores a hallucinated-script endorsement as PASS.

**Failure scenario:** `endorse` = `/will (compile|build|...)/` (should → FAIL for
endorsing the nonexistent `npm run compile`). But the `truth` regex contains a
bare `fail` token and is checked **first** (`run.ts:105`). A response like
*"`npm run compile` will compile the TypeScript; it'll fail if there are type
errors."* matches `truth` via "fail" and returns **PASS**, rewarding a
hallucination.

**Proposed fix:** tighten the `truth` regex so a bare "fail" doesn't satisfy it,
or evaluate `endorse` (the disqualifier) before `truth`.

**Verify:** confirm the `truth` regex contains `fail` and precedes `endorse`.
**Status: ✅ CONFIRMED** *(2026-07-15 independent verify)* — current source at
`scripts/memory-behavior-eval/run.ts:100-106` still includes bare `fail` in
`truth` and returns `PASS` from that branch before checking `endorse`. Executing
the exact scorer against
`npm run compile will compile the TypeScript; it will fail if there are type errors.`
returned `PASS`; the same false endorsement without the trailing `fail` clause
returned `FAIL`. This is a concrete false-positive scoring path, not a
hypothetical regex overlap. No live model usage was required.

### EVAL-4 · `save-side.ts:242` · 🟠 medium · conf **medium** · scoring-correctness
**Claim:** the contradiction-supersession case scores a correctly-scoped
reconciliation as FAIL.

**Failure scenario:** the extractor correctly rewrites seeded memory to *"Always
ask before choosing a dependency version, **except** during a security response,
where for patch-only upgrades choose the latest compatible patch."* This
satisfies `keepsGeneralRule` (`:224`), the scoped action, and the exception
connector — but the forbidden-phrase regex at `:242` matches the leading
substring "always ask before choosing a dependency version" **regardless of the
trailing except-clause**, pushing "superseded unconditional ask-first rule
remains" → **FAIL** on a semantically-correct answer.

**Proposed fix:** make the forbidden-phrase check require the ask-first rule to
appear *without* an adjacent except/unless scope (negative lookahead), or drop
this check when the exception connector is present.

**Verify:** confirm `:242`'s regex matches the leading clause independent of a
following "except/unless", and that `keepsGeneralRule` at `:224` intentionally
allows the scoped form. If both hold, the two checks contradict → CONFIRMED.
**Status: ⬜ UNVERIFIED** *(finder: scripts-eval-scoring)*

### EVAL-5 · `run.ts:404` · 🟡 low · conf **high** · input-validation
**Claim:** a non-numeric `--repeats` silently makes the harness evaluate only the
probe and exit 0.

**Failure scenario:** `--repeats foo` → `Number('foo') = NaN`. Per non-probe
case, `n = NaN` and `for (let r = 1; r <= NaN; r++)` (`:428`) never iterates, so
only the probe job is pushed. Result: 1 evaluation, near-empty `results.jsonl`,
a summary with empty verdict lists (h1/h5/h6/agree/absent/m1), **exit 0** — a
green run that measured nothing. Same for `--repeats 0` or negative.

**Proposed fix:** validate `repeats` is a positive integer; hard-error otherwise.

**Verify:** read the `--repeats` parse at `:404` and the loop at `:428`.
**Status: ⬜ UNVERIFIED** *(finder: scripts-eval-robustness; corroborated by scripts-eval-logic)*

### EVAL-6 · `run.ts:423` · 🟡 low · conf **high** · input-validation
**Claim:** an unknown `--cases` value silently runs nothing and exits 0.

**Failure scenario:** `--cases hi` (meant `h1`) → `selectedCases` filters to `[]`
because no id matches; the job loop builds zero jobs; `pool([], 3)` returns `[]`;
`results.jsonl` is just a newline; SUMMARY prints empty rows; **exit 0**. The
operator believes `h1` ran. Note: `save-side.ts` validates `--cases` but
`run.ts` does not.

**Proposed fix:** validate each `--cases` id against the known set (mirror
`save-side.ts`); hard-error on an unknown id.

**Verify:** confirm `run.ts:423` filters without validating, and `save-side.ts`
does validate (the asymmetry is the tell).
**Status: ⬜ UNVERIFIED** *(finder: scripts-eval-robustness)*

### EVAL-7 · `save-side.ts:593` · 🟡 low · conf **high** · unhandled-io
**Claim:** `--score-existing` crashes on a missing artifact instead of degrading.

**Failure scenario:** run `--lanes direct` live, then later `--score-existing`
with default lanes (`direct,extraction`). `buildRuns` produces an
`extraction-<caseId>` run whose `extraction-<caseId>-memory.json` was never
written. `:593` `readFileSync(...)` throws ENOENT and propagates out of `main()`
as an uncaught rejection — **before any verdict prints**. The evidence read two
lines below (`:602`) *is* guarded with `existsSync`, making the inconsistency a
latent crash on a plausible partial-artifact workflow.

**Proposed fix:** guard the memory/team-memory reads with `existsSync`/try-catch,
matching the evidence read at `:602`.

**Verify:** confirm `:593` uses bare `readFileSync` while `:602` is
`existsSync`-guarded.
**Status: ⬜ UNVERIFIED** *(finder: scripts-eval-robustness)*

### EVAL-8 · `run.ts:429` · 🟡 low · conf **low** · shared-mutable-state
**Claim:** concurrent recall jobs can corrupt the shared planted-memory fixture.

**Failure scenario:** all 3 recall jobs share one `memoryDir` and `run.ts` never
disables auto-memory. Under ambient `USER_TYPE=ant` + a disk-cached
`tengu_passport_quail=true` (both plausible in this repo), the child inherits
them via `...process.env`. Each process's end-of-turn extractor (its own
`createAutoMemCanUseTool`, not bound by the session's Bash-only `allowedTools`)
rewrites `MEMORY.md`/topic files in the shared dir while another process is
reading it → non-deterministic recall verdicts; concurrent `MEMORY.md` writes can
interleave.

**Proposed fix:** give each job an isolated `memoryDir` copy, or force
auto-memory off for recall jobs, or serialize jobs sharing a fixture.

**Verify (needs env check):** confirm jobs share `memoryDir`, `run.ts` doesn't
disable extraction, and the child inherits `process.env`. The trigger depends on
ambient `USER_TYPE`/gate cache the finder could not observe — **this is the
weakest link; refute first.**
**Status: ⬜ UNVERIFIED** *(finder: scripts-eval-logic)*

---

# SLASH — slash-catalog feature (new)

> A new end-to-end feature: sidecar projects a rich command catalog →
> `protocol.ts` frame → renderer `slashCatalogState` → `SlashCommandPicker`.
> Boundary review was clean; the gaps are a render-crash path, delivery
> lifecycle, and **untested production wiring**.

### SLASH-1 · `app/renderer/src/SlashCommandPicker.tsx:58` · 🟠 medium · conf **low** · regression-null-deref
**Claim:** an undefined command `description` crashes the composer render on the
next slash keystroke.

**Failure scenario:** `filterSlashCommands` was widened from `names: readonly
string[]` (never touched a description) to a `rest` branch evaluating
`name.includes(q) || entry.description.toLowerCase().includes(q)`. Rich entries
come from `sessionController.ts:250` as `description: command.description` with
**no `?? ''` coalesce**, and `reduceSlashCatalogState` stores `frame.commands`
verbatim (no runtime narrowing). If any `userInvocable` command reaches the wire
with `description` undefined (the field is *declared* `string` at
`src/types/command.ts:182`, but the renderer trusts the wire, and the app's own
fallback path at `App.tsx:1748` defensively coalesces to `''` — **the rich path
does not**), then typing e.g. `/model` while a description-less command is in the
catalog throws `TypeError: Cannot read properties of undefined (reading
'toLowerCase')` synchronously inside `SessionPane` render → **pane crash**.
Violates the renderer's display-degrades-gracefully / runtime-narrow doctrine.

**Proposed fix:** coalesce at the read (`(entry.description ?? '')` in
`filterSlashCommands`) and/or at the sidecar builder (`sessionController.ts:250`).

**Verify:** the crash is real *only if* a `userInvocable` command can reach the
wire with `description === undefined`. Confirm whether any built-in/dynamic
command omits `description` at runtime despite the `string` type. If none can,
downgrade to defensive-hardening. **This is why conf is low — verify the
precondition first.**
**Status: ⬜ UNVERIFIED** *(finder: deletions-renderer)*

### SLASH-2 · `app/sidecar/sidecarServer.test.ts:384` · 🟠 medium · conf **high** · test-coverage
**Claim:** the production wiring seam that delivers the catalog is untested; both
new tests pass even if the catalog never reaches the server in production.

**Failure scenario:** the `sessionController` test proves the catalog is *built*
(real `getCommands` path); this `sidecarServer` test proves the server *delivers*
a **hand-injected stub** catalog (`:384`). The seam that joins them in
production — `index.ts:197` threading `createSidecarSessionController(...).slashCatalog`
into `SidecarServer({ slashCatalog })` — is covered by **no test** (zero
slash-catalog references in any probe test). Break/drop that spread and the
original name-only picker bug returns in production while both new tests stay
green. (Matches CLAUDE.md §8.1 "wiring a seam with stub context".)

**Proposed fix:** add a live-path test (or extend a probe) that spawns real
`index.ts main()` and asserts the delivered catalog is the projected one, not a
stub.

**Verify:** confirm the `sidecarServer` test injects the catalog via constructor
and that `index.ts:197` is the only prod join, uncovered by probes.
**Status: ⬜ UNVERIFIED** *(finder: sidecar-tests-quality)*

### SLASH-3 · `app/renderer/src/SlashCommandPicker.render.test.tsx:23` · 🟠 medium · conf **high** · test-coverage
**Claim:** active-row highlight / keyboard-nav feedback is entirely uncovered.

**Failure scenario:** `render()` (`:11-21`) always passes `activeIndex={0}`; no
test varies it or asserts `data-slash-active="true"`, `aria-selected`, or the
accent styling on the active row. Replacing `SlashCommandPicker.tsx:134`
`const isActive = index === activeIndex` with `false` (breaking all highlighting)
leaves both render tests green — they only assert static name/description/arg-hint
text.

**Proposed fix:** add a test that renders with `activeIndex={n>0}` and asserts the
active-row marker moves.

**Verify:** confirm the render tests never vary `activeIndex` nor assert an active
marker.
**Status: ⬜ UNVERIFIED** *(finder: renderer-tests-quality)*

### SLASH-4 · `app/renderer/src/replayBatchRender.test.tsx:119` · 🟠 medium · conf **high** · test-coverage
**Claim:** the "dispatches ONCE per store" batch test never verifies the new
slash-catalog dispatch.

**Failure scenario:** `dispatchSlashCatalog: count('slashCatalog')` is registered
at `:109`, but the assertion loop array (`:119-136`) lists only 16 stores and
**omits both `slashCatalog` and `runControls`**. If `serverFrameBatch.ts:109`
(`h.dispatchSlashCatalog(batch(frameActions))`) were deleted, a batched restore
would never fold the slash-catalog snapshot (empty picker after every restore) —
yet this test stays green because nothing asserts `calls['slashCatalog'] === 1`.
Also leaves the once-per-batch (no render-storm) guarantee unverified for the new
store.

**Proposed fix:** add `slashCatalog` (and `runControls`) to the assertion array.

**Verify:** confirm `:109` registers the counter and `:119-136` omits it from
assertions.
**Status: ⬜ UNVERIFIED** *(finder: renderer-tests-quality; corroborated by frame-batch-ordering)*

### SLASH-5 · `app/renderer/src/App.tsx:1744` · 🟡 low · conf **medium** · lifecycle-staleness
**Claim:** mid-session command-set changes are masked in the picker.

**Failure scenario:** `SessionPane` prefers the spawn-frozen rich `slashCatalog`
whenever `slashCatalog.length > 0` (always, on a healthy session) over the live
per-turn `system/init.slash_commands`. Mid-session, a newly-registered dynamic
skill (`getDynamicSkills` / `loadSkillsDir.ts:1054`) or a feature-flag-gated
command appears in the next per-turn init frame but **not** in the frozen catalog
(never re-broadcast). Because rich is always preferred, the picker silently omits
the new command — a regression vs the pre-change names-only picker, which read
the live init frame each turn.

**Proposed fix:** re-broadcast the catalog when the command set changes, or merge
live init names over the frozen rich catalog.

**Verify:** confirm the catalog is built once at spawn and the rich branch is
unconditionally preferred; confirm dynamic commands can appear mid-session.
**Status: ⬜ UNVERIFIED** *(finder: xflow-slash-catalog)*

### SLASH-6 · `app/sidecar/sidecarServer.ts:507` · 🟡 low · conf **medium** · delivery-lifecycle
**Claim:** a renderer reload of a long session loses the rich catalog permanently.

**Failure scenario:** the snapshot is emitted only on connect
(`sendSlashCatalogSnapshot`, never re-sent). It lands in the replay buffer
(`app/main/replayBuffer.ts`), bounded to 512 frames / 8 MiB, evict-oldest. After
a busy session pushes past that bound, the early snapshot is evicted. The user
reloads the renderer (Cmd+R / dev reload / crash-recover): the sidecar socket
stays alive so `connect()` does **not** re-run, and main replays only `ready` +
the recent tail — the catalog frame is gone. `selectSlashCatalog` returns `[]`
and the picker regresses to names-only for the rest of that renderer's life.

**Proposed fix:** mark the catalog snapshot as a sticky/`ready`-class frame exempt
from eviction, or re-send it on reattach/replay.

**Verify:** confirm the snapshot is sent once, is a non-`ready` frame subject to
eviction, and reattach doesn't re-run connect. Cross-check the buffer bound in
`app/main/replayBuffer.ts`.
**Status: ⬜ UNVERIFIED** *(finder: xflow-slash-catalog)*

### SLASH-7 · `app/renderer/src/SlashCommandPicker.tsx:58` · 🟡 low · conf **low** · filtering-behavior
**Claim:** the new description-substring match makes short queries match nearly
the whole catalog. *(Distinct from SLASH-1, same line — this is the behavior
regression, not the crash.)*

**Failure scenario:** with a ~30-command catalog, typing `/e` (or any common
letter) now matches nearly every command because "e" appears in almost every
one-line description via `entry.description.toLowerCase().includes(q)`.
Previously (name-substring only) `/e` narrowed to the handful of NAME matches.
The count badge and match list stop discriminating. New tests only cover a
distinctive word ("switch"), missing this.

**Proposed fix:** gate description matching behind a min query length, or rank
name-matches above description-matches instead of flattening.

**Verify:** confirm the `rest` branch ORs description substring with no
length/rank guard.
**Status: ⬜ UNVERIFIED** *(finder: slash-cluster)*

### SLASH-8 · `app/renderer/src/SlashCommandPicker.tsx:173` · 🟡 low · conf **low** · theme-token
**Claim:** the description separator dot uses a hardcoded hex class instead of a
theme token.

**Failure scenario:** the `·` separator is `text-[#2e2e33]` (a static literal, so
Tailwind *does* compile it — **not** the dynamic-class trap) while its siblings
use tokens (`text-text-faint`/`text-text-ghost`/`text-accent`). Under a light or
re-themed surface it stays a fixed near-black that no longer matches neighbors.

**Proposed fix:** replace with the nearest existing token.

**Verify:** confirm `:173` uses `text-[#2e2e33]` and siblings use tokens. Cosmetic
— lowest priority.
**Status: ⬜ UNVERIFIED** *(finder: renderer-quality-crosscut)*

### SLASH-9 · `app/sidecar/sessionController.test.ts:83` · 🟡 low · conf **high** · test-coverage
**Claim:** the real-path projection test spot-checks only `help.description`,
leaving `argumentHint` projection and `userInvocable` filter-parity unverified.

**Failure scenario:** break the `argumentHint` conditional spread in
`sessionController.ts:246` (drop/misname it) and commands lose their gray arg
hints in the picker; the test (`:78-83`) only asserts `help.description` is a
non-empty string. The `sidecarServer` test's `argumentHint ('<name>')` lives in a
hand-written stub, so it also passes. Likewise, a drift between the projected
name-set and the engine's `slash_commands` (the `.filter(c => c.userInvocable !==
false)` parity — finder cited an engine `systemInit` filter) is unverified: no
test compares the projected set to the engine's set.

**Proposed fix:** assert `argumentHint` on a real projected command and compare the
projected `userInvocable` name-set against the engine's `getCommands` output.

**Verify:** confirm `:78-83` asserts only `description`; locate the engine's
`userInvocable` filter (finder's `systemInit.ts:69` pointer needs relocating — no
such path at `src/` root; find the real builder) and confirm no parity test.
**Status: ⬜ UNVERIFIED** *(finder: sidecar-tests-quality)*

---

# ACCT — account switcher (composer, `ComposerActionsBar.tsx`)

> The new in-composer account switcher. Findings cluster around **status
> semantics** (dead/quarantined shown as capped, healthy-count divergence) and
> **keyboard/screen-reader access** to the popovers.

### ACCT-1 · `ComposerActionsBar.tsx:408` · 🟠 medium · conf **medium** · wrong-status-label
**Claim:** dead and quarantined accounts are mislabeled "Capped".

**Failure scenario:** `AccountStatus.status` is
`healthy|dead|capped|quarantined` (`protocol.ts:1082`), but `:374` sets
`unavailable = acct.status !== 'healthy'` and the branch at `:406-411` renders the
literal `Capped · ↺ {formatResetLabel(usageResetAt)}` for **all** of them. A
`dead` account (auth broken, `usageResetAt` null) renders "Capped · ↺ soon" with a
red danger dot — telling the user to wait for a reset that never comes instead of
re-authenticating; a `quarantined` account is likewise shown "Capped". The
correct `availabilityLabel` field is ignored.

**Proposed fix:** branch on the actual status (or render `availabilityLabel`)
instead of a single "Capped" literal.

**Verify:** confirm `:374` collapses all non-healthy to `unavailable`, `:406-411`
hardcodes "Capped", and `availabilityLabel` exists and is unused here.
**Status: ⬜ UNVERIFIED** *(finders: composer-quality + composer-correctness, agree)*

### ACCT-2 · `ComposerActionsBar.tsx:476` · 🟠 medium · conf **medium** · focus-management
**Claim:** the switcher popover violates the `role="menu"` focus contract.

**Failure scenario:** opening `AccountChip`/`ContextChip` never moves keyboard
focus into the panel, and activating an account row calls `setOpen(false)` which
**unmounts the focused `<button role="menuitem">`** → focus falls back to
`<body>`; the next Tab restarts from the top of the document instead of returning
to the trigger. Same focus loss when Escape closes with a row focused. Focus is
never placed on the first item on open.

**Proposed fix:** focus first item on open; restore focus to the trigger on close
(before unmount).

**Verify:** confirm no focus-in on open and no focus-restore before `setOpen(false)`.
**Status: ⬜ UNVERIFIED** *(finder: composer-interaction-a11y)*

### ACCT-3 · `ComposerActionsBar.tsx:554` · 🟠 medium · conf **medium** · a11y-aria-semantics
**Claim:** the Context usage popover claims `role="menu"` but has no menu items,
making it unreadable to assistive tech.

**Failure scenario:** `ContextUsagePanel` declares `role="menu"` (trigger
`aria-haspopup="menu"`) but contains **zero `role="menuitem"` children** — it's a
purely informational popover of plain `<div>`/`<span>`. A screen-reader user
enters menu/application mode expecting arrow-navigable items; arrow keys do
nothing and the plan-usage %/token totals in plain text are not exposed as
navigable content → the whole panel is effectively unreadable to AT while sighted
users see it fine.

**Proposed fix:** drop the `menu`/`menuitem` semantics for this informational
panel (use `dialog`/`group` or plain region with a label), reserving `menu` for
the actionable switcher.

**Verify:** confirm the panel uses `role="menu"` with no `menuitem` children.
**Status: ⬜ UNVERIFIED** *(finder: composer-interaction-a11y)*

### ACCT-4 · `ComposerActionsBar.tsx:349` · 🟡 low · conf **medium** · data-consistency
**Claim:** the switcher header "N/M healthy" diverges from the wire `readyCount`
and from the panel's own dots.

**Failure scenario:** `healthy = pool.filter(a => a.status === 'healthy').length`
ignores `usageLimitReached`. An account with `status:'healthy'` +
`usageLimitReached:true` is counted in "2/2 healthy" yet its own row dot is amber
(`statusDotTone` returns `warn`, `AccountsPage.tsx:89`) and its usage bar is red;
meanwhile the Accounts page computes `readyCount = status==='healthy' &&
!usageLimitReached` (`accountsState.ts:96`) and shows it NOT ready — **three
inconsistent verdicts for one account** across the UI.

**Proposed fix:** compute the header count with the same `readyCount` predicate.

**Verify:** confirm the header uses bare `status==='healthy'` and `accountsState.ts:96`
uses the stricter predicate.
**Status: ⬜ UNVERIFIED** *(finder: xflow-account-switch)*

### ACCT-5 · `App.tsx:1209` · 🟡 low · conf **medium** · error-handling
**Claim:** a failed account switch from the composer is a silent no-op.

**Failure scenario:** `onSwitchAccount` sends `switchVerb(X)` via
`getBridge().accountVerb` and `AccountChip` immediately closes the popover. The
sidecar's `handleAccountVerb` returns `account.result{ok:false}` (or notFound) into
`accountsState.lastResult` — but that is consumed **only** by `AccountsPage`
(`App.tsx:1545`, via `pendingRef`/`requestId` correlation), never on the composer
path. The active-account chip stays unchanged, no toast/error appears → the switch
looks like a silent no-op. Contradicts the "no optimistic UI — toast+close only
when the real `account.result` arrives" doctrine the AccountsPage verbs follow
(`AccountsPage.tsx:17-20`).

**Proposed fix:** correlate the composer switch's `account.result` and surface
failure (toast) / revert, mirroring AccountsPage.

**Verify:** confirm the composer path fires the verb but never reads
`lastResult`/correlates the requestId.
**Status: ⬜ UNVERIFIED** *(finder: xflow-account-switch)*

### ACCT-6 · `ComposerActionsBar.tsx:426` · 🟡 low · conf **medium** · keyboard-menu-model
**Claim:** parts of the switcher menu are not keyboard-reachable.

**Failure scenario:** inside the `role="menu"` panel, "Manage accounts →" is a
plain button (no `role="menuitem"`), so arrow-key menu traversal never lands on
it; and every capped/active account row uses `disabled={!clickable}`, dropping
those buttons out of the tab order — a keyboard-only user cannot focus them to
perceive their state (e.g. that account X is capped), though they're visible.

**Proposed fix:** give "Manage accounts →" `role="menuitem"`; keep disabled rows
focusable (`aria-disabled` instead of `disabled`, or roving tabindex) so their
state is perceivable.

**Verify:** confirm the manage action lacks `menuitem` and disabled rows use the
`disabled` attribute (removing them from tab order).
**Status: ⬜ UNVERIFIED** *(finder: composer-interaction-a11y)*

### ACCT-7 · `ComposerActionsBar.tsx:308` · 🟡 low · conf **low** · misleading-display
**Claim:** an account with no fetched usage shows a green "0%" bar rather than
"unknown".

**Failure scenario:** on a freshly-attached session the accounts snapshot is
broadcast before `refreshAccountsUsageOnce` completes (`sidecarServer.ts:2089`),
so a healthy account has `usagePrimary/usageWeekly === null`. If the switcher is
opened in that window, `const p = pct ?? 0` and `usageTone(null) -> good` render a
green ~2%-wide fill labeled "0%", asserting 0% plan usage when usage is simply not
yet fetched. *(Mirrors the pre-existing AccountsPage `HeadroomBar` behavior — may
be an accepted product choice.)*

**Proposed fix:** render a distinct "—/unknown" state when usage is null.

**Verify:** confirm `p = pct ?? 0` and `usageTone(null)` → good; decide whether
this is intended parity with `HeadroomBar`.
**Status: ⬜ UNVERIFIED** *(finder: composer-correctness)*

### ACCT-8 · `ComposerActionsBar.tsx:307` · 🟡 low · conf **low** · simplification
**Claim:** three near-identical percent-bar components now exist.

**Failure scenario:** `AccountUsageBar` and `PlanUsageRow` re-implement the same
tone-filled percent-bar (`usageTone→toneClasses→bar+inline-width+{p}%`) that
`AccountsPage`'s `HeadroomBar` (`AccountsPage.tsx:204`, unexported) already does.
Not a runtime bug — a maintenance hazard: a future change (e.g. the width-clamp
`Math.max(2, Math.min(100, p))` `AccountUsageBar` has but the others lack) must be
duplicated three ways and will drift.

**Proposed fix:** export/parameterize `HeadroomBar` and reuse it.

**Verify:** confirm the three bar implementations and that `HeadroomBar` is
unexported. Cleanup, not a bug.
**Status: ⬜ UNVERIFIED** *(finder: composer-quality)*

### ACCT-9 · `ComposerActionsBar.test.tsx:302` · 🟡 low · conf **medium** · test-coverage
**Claim:** the core switch contract — click a switchable row → `onSwitch(id)` +
close popover — is never exercised.

**Failure scenario:** all new tests use `renderToStaticMarkup` and assert only
static markup ("Switch to yoxrent" title/disabled attrs). If the onClick wiring at
`ComposerActionsBar.tsx:383` (`onClick={clickable ? () => onSwitch(acct.id) :
undefined}`) or the close-on-switch closure (`:475-478`) regressed to pass the
wrong id or omit `setOpen(false)`, every test still passes — static render never
fires a click.

**Proposed fix:** add an interaction test (real click) asserting `onSwitch` gets
the right id and the popover closes.

**Verify:** confirm the tests use `renderToStaticMarkup` and never simulate a click.
**Status: ⬜ UNVERIFIED** *(finder: composer-quality)*

### ACCT-10 · `ComposerActionsBar.test.tsx:367` · 🟡 low · conf **medium** · test-coverage
**Claim:** the "account present but both usages null" plan-suppression branch is
untested.

**Failure scenario:** `:550` gates the Plan-usage section on `account != null &&
(usagePrimary != null || usageWeekly != null)`. Tests cover account-with-usages
(`:348`) and `account=null` (`:367`); an account whose usages are **both null** (a
real pre-poll state that must suppress the plan section) is never exercised, so a
regression that always rendered or always hid the plan rows for that case passes.

**Proposed fix:** add a test for the both-null case asserting the plan section is
suppressed.

**Verify:** confirm the gate at `:550` and the two existing test cases; confirm the
both-null case is absent.
**Status: ⬜ UNVERIFIED** *(finder: renderer-tests-quality)*

---

# SIDEBAR

### SIDEBAR-1 · `app/renderer/src/Sidebar.tsx:382` · 🟠 medium · conf **high** · boundary-error
**Claim:** a "Show 0 more" dead button renders at a specific boundary.

**Failure scenario:** a group has exactly `SIDEBAR_GROUP_ROW_LIMIT+1` (7) rows and
the active session is the single overflow (tail) row. `selectVisibleSidebarRows`
returns `head(6)` + appended active = all 7 rows, so `hiddenCount = 7-7 = 0` while
`overLimit = 7>6 = true`. The toggle is gated on `overLimit` (`:382`) and labeled
`Show ${hiddenCount} more` (`:389`) → a **"Show 0 more"** button that reveals
nothing (toggles to "Show less" without changing the visible list). New tests use
10-row groups where `hiddenCount ≥ 3`, missing this.

**Proposed fix:** gate the collapsed toggle on `hiddenCount > 0` (not `overLimit`).

**Verify:** confirm `:382` gates on `overLimit` and `:389` labels with
`hiddenCount`; construct the 7-row/active-in-tail case.
**Status: ⬜ UNVERIFIED** *(finders: sidebar-cluster + renderer-quality-crosscut, agree)*

### SIDEBAR-2 · `app/renderer/src/Sidebar.tsx:336` · 🟡 low · conf **medium** · stale-state
**Claim:** `expanded` state is sticky and silently re-auto-expands.

**Failure scenario:** user expands a 10-row group (`expanded=true`, keyed by
`group.cwd`). Sessions are closed until ≤6 rows → `overLimit` false, the toggle
unmounts, but `expanded` stays true (never reset). New sessions later push the
group back over 6 rows; because `expanded` is still true,
`selectVisibleSidebarRows` returns every row and the group shows fully expanded
with "Show less" **without user action** — sidebar drift the pure-function tests
can't observe.

**Proposed fix:** reset `expanded` when `overLimit` becomes false, or derive it so
it can't outlive the condition.

**Verify:** confirm `expanded` is keyed by cwd and never reset when the group drops
below cap.
**Status: ⬜ UNVERIFIED** *(finder: sidebar-cluster)*

### SIDEBAR-3 · `app/renderer/src/sidebarState.ts:124` · 🟡 low · conf **low** · ordering-stability
**Claim:** the kept active row warps position between collapsed and expanded views,
contradicting the module's no-warp invariant.

**Failure scenario:** a group has 10 rows (limit 5), collapsed, active session is
the 8th by `createdAt`. Collapsed, `visible = [head 0-4] + [row 7 appended]` → the
active row renders at the bottom (position 6). Clicking "Show more" hits the early
return at `:117` yielding the full `createdAt`-ordered rows, so the active row
jumps to its natural middle slot. The row visibly repositions — the exact warp the
module doc (`:3-27`) says the module exists to eliminate.

**Proposed fix:** insert the kept active row at its stable `createdAt` slot in the
collapsed view instead of appending to the tail.

**Verify:** confirm the append-to-tail at `:124` and the full-order early-return at
`:117`; check the module doc's stated invariant.
**Status: ⬜ UNVERIFIED** *(finder: reducer-invariants)*

---

# ENGINE — built-in agents (src/)

> **⚠ These two findings are already committed in `5b2ef3e`, not in the working
> tree** (a concurrent session committed the map-routing work mid-review). To see
> the reviewed code use `git show 5b2ef3e -- src/tools/AgentTool/built-in/`, not
> `git diff HEAD`. They remain valid defects; only their location moved.

### ENGINE-1 · `src/tools/AgentTool/built-in/exploreAgent.ts:46` · 🟡 low · conf **low** · hardcoded-repo-path
**Claim:** a cat-code-specific path is injected into portable built-in agents, and
it contradicts the Explore agent's own design.

**Failure scenario:** `MAP_ROUTING_GUIDANCE` hardcodes `docs/maps/WORKSPACE_MAP.md`
into the Explore, general-purpose, plan, and implementor agents — which also run
in **arbitrary user repos** with no `docs/maps/` tree. Those agents are now told to
"read docs/maps/WORKSPACE_MAP.md before the first broad search" → a `Read` on a
nonexistent file (wasted turn / misleading routing). Sharpest for the **Explore**
agent, which sets `omitClaudeMd:true` (`:117`) *precisely* so it runs "without your
project conventions loaded" (`whenToUse`, `:98`), yet is now injected with a
project-specific routing convention it was designed to skip.

**Proposed fix:** gate `MAP_ROUTING_GUIDANCE` on this repo (or on the map file
existing), and exclude it from the Explore agent given `omitClaudeMd`.

**Verify:** confirm `MAP_ROUTING_GUIDANCE` (defined in
`src/tools/AgentTool/built-in/mapRoutingGuidance.ts`) is interpolated into all four
agents unconditionally, and that `exploreAgent.ts:117` sets `omitClaudeMd:true`.
**Note:** this ships in the **engine** and affects other repos — higher real-world
reach than its "low" severity suggests.
**Status: ⬜ UNVERIFIED** *(finder: engine-agents-prompts)*

### ENGINE-2 · `src/tools/AgentTool/built-in/mapRoutingGuidance.test.ts:18` · 🟡 low · conf **medium** · test-coverage
**Claim:** the only guard for the injected guidance counts occurrences but does not
verify it lands in **both** provider branches, so a provider-keying regression
passes green.

**Failure scenario:** a future edit could place both `${MAP_ROUTING_GUIDANCE}`
interpolations inside the `provider === 'openai'` (GPT/Codex) branch and none in
the Anthropic branch (or vice versa). `mapRoutingGuidance.test.ts:18` asserts only
`source.match(/\$\{MAP_ROUTING_GUIDANCE\}/g)?.length === 2`, so the count stays 2
and the test passes while one provider path silently loses the guidance — exactly
the branch-asymmetry provider-keying bug. `rolePrompts.test.ts` (the in-scope test,
edited here for the `CLAUDE_CLI` removal) adds no MAP_ROUTING assertion to backstop
it, and no test references the `provider === 'openai'` split for these prompts.

**Proposed fix:** assert the guidance appears in **both** provider branches (render
each provider variant and check), not just that it appears twice.

**Verify:** read `mapRoutingGuidance.test.ts:18`; confirm it's a count assertion and
that no test checks per-provider presence.
**Status: ⬜ UNVERIFIED** *(finder: engine-agents-consistency)*

---

# Appendix

## A. Finders that returned clean (0 findings)

| Finder | Wave | Scope |
|---|---|---|
| sidecar-boundary | 1 | inbound validation / fail-closed / caps |
| sidecar-session | 1 | session lifecycle / event frames |
| protocol-contract | 1 | additive-only / new-frame schema+test+doc |
| app-security-crosscut | 1 | T4/T5a/T6/T6b/T7 / secretGuard / directional limits |
| app-shell | 1 | App.tsx wiring / batch-replay |
| deletions-sidecar-engine | 2 | removed validations/cases/caps (sidecar+engine) |
| type-discipline | 2 | exhaustiveness / projector-fixtures / `as`-casts |
| sidecar-protocol-adversarial | 2 | **adversarial** re-review of inbound holes |
| sessionController-lifecycle-adversarial | 2 | **adversarial** re-review of lifecycle races |
| renderer-render-perf | 2 | re-render storms / unstable props / memoization |

The two **adversarial** rows are the strongest clean signal — they were told to
assume the first pass missed something and still found nothing.

## B. Provenance

- Wave 1 transcript: `.../subagents/workflows/wf_4b58768c-88b/journal.jsonl`
  (14 agents, ~1.02M tokens).
- Wave 2 transcript: `.../subagents/workflows/wf_5a5a96fb-085/journal.jsonl`
  (14 agents, ~1.16M tokens).
- Raw task outputs:
  `/private/tmp/claude-501/-Users-pt-cat-code/7f016ff8-fba9-4123-9535-afeaf4b97bb6/tasks/{wmb82r3ww,wq3zpajvn}.output`.
- Dedup: 36 raw → 32 distinct. Merged pairs: Sidebar `:382` (×2), Capped mislabel
  `:408` (×2), `--repeats` NaN `:404` (×2), replay-batch `:119` (×2). Kept both
  `SlashCommandPicker.tsx:58` items (SLASH-1 crash vs SLASH-7 over-match are
  distinct defects).

## C. Suggested verify-pass shape (when ready)

1. **Skip / spot-check only** (conf high, mechanical): EVAL-1, EVAL-2, EVAL-5,
   EVAL-6, EVAL-7, SLASH-2, SLASH-3, SLASH-4, SLASH-9, SIDEBAR-1. Read the cited
   lines; these are near-certain.
2. **Refute pass** (conf L / preconditioned — highest verify value): SLASH-1
   (does an undefined `description` reach the wire?), EVAL-8 (ambient-env
   dependent), SLASH-5, SLASH-6 (lifecycle claims), ACCT-4/5 (cross-file
   correlation), SIDEBAR-3, ACCT-7. Default to REJECTED unless a concrete failing
   input is produced.
3. **Product-decision, not bug** (confirm intent): ACCT-7 (null→0% parity),
   ACCT-8 (dedup), SLASH-8 (token), ACCT-3 (a11y semantics choice).

_Report generated 2026-07-15 from a finder-only review; no code modified._
_Baseline: `migration` @ `5b2ef3e` + reviewed working-tree fingerprint
`b40e26fa…` (see §Review baseline & drift status). Re-run the drift check before
verifying or fixing._
