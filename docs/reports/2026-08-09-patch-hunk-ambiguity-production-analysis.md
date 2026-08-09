# "Patch hunk body is ambiguous" — production analysis and fix

Date: 2026-08-09
Scope: the `PATCH_ANCHOR_AMBIGUOUS` failure mode of Apply_patch
(`src/tools/FilePatchTool/applier.ts`), measured over two weeks of real
session transcripts, root-caused, adversarially reviewed, and fixed in commit
`746005f7` (cursor-threading disambiguation for non-first hunks).
Method: transcript mining → git-reconstructed replay through the repo's real
parser/applier → placement ground-truthing against later commits → external
adversarial review (verdict RED on the first proposal; corrections adopted) →
reconciliation → implementation.
Companion: `docs/reports/2026-07-12-apply-patch-tool-review.md` (whole-tool
review; its F4 "no telemetry" finding is why this rate went unnoticed).

## The mechanism

`findHunkPosition` requires every hunk's fingerprint (context+delete lines) to
match exactly one location in the file at some fuzzy tier; multiple matches
that `@@` scope hints cannot reduce throw `PATCH_ANCHOR_AMBIGUOUS`. Each hunk
searched the whole file independently, against the buffer already mutated by
earlier hunks of the same patch.

Canonical Codex apply_patch (verified against `codex-rs/apply-patch`
`seek_sequence.rs` + `lib.rs`, current main) has no ambiguity concept: a
cursor threads across hunks, `@@` context lines advance it, and the first
match at-or-after the cursor wins. GPT models emit patches in that sequential
idiom — an early hunk anchors uniquely (a test header), a later hunk uses a
tiny fingerprint (`})` alone) meaning "the next one". Cat-code's matcher
discarded exactly the positional information those patches carry. The design
docs deliberately adopted whole-file uniqueness and mutated-buffer matching
("root cause 5", `docs/plans/2026-04-30-apply-patch-ux-improvements-plan.md`);
they never discussed the cursor, so the omission was behavioral, not a
recorded decision.

## Production incidence (2026-07-26 → 2026-08-09, this machine)

- 430 unique Apply_patch calls; 48 distinct ambiguity failures ≈ **11%**
  (an early 8% figure divided deduplicated failures by non-deduplicated call
  records; the adversarial review corrected it).
- 38 incidents (a success on the same file closes an incident); 10 needed
  multiple attempts; the longest consecutive ambiguity run was 2, but one
  file drew 5 failures in ~95 s across interleaved attempts.
- Recovery always eventually succeeded, but cost 1–5 retries, and in one case
  changed the committed design: after two failures the session gave up adding
  `canResume: () => true` to six driver configs and restructured the test
  helper instead (`app/main/idleParkDriver.test.ts`, commit `c77cd095`).

## Replay evidence

For each recorded failure, the target file was reconstructed from git history
near the failure timestamp and re-run through the real parser+applier; a
reconstruction only counted if it reproduced the recorded collision signature
exactly (same match count and same collision line numbers).

- 25/48 reproduced; 17 had no matching git state (uncommitted working tree);
  6 targets sat outside the repo. (Caveat: signature-exact, not full-error
  comparison; single-operation replay, not whole-envelope — 12 of the 25 came
  from multi-file patches.)
- Cursor-threading resolved 24/25; restricted to non-first hunks, 21/25.
- Of the 25, 22 failed after a prior anchor hunk and 21 failed on fingerprints
  of ≤2 lines — the sequential idiom dominates the replayable subset.

Placement ground truth against what the model eventually committed:

- 19/21 adjudicable non-first placements matched the committed code exactly,
  including three near-identical `sidecarEnv` probe blocks and two
  near-identical diagnostics allowlist arrays.
- 2 differed: both new-test-block insertions that landed after a different
  test than finally chosen — wrong position, order-independent code.
- Both confirmed *dangerous* wrong placements were first-hunk cases with no
  prior anchor: `phase4.md` (first `─── PASTE ───` at line 198 vs the real
  target at EOF line 4370) and the first `TranscriptView.tsx` clipboard retry
  (first of four identical handlers vs the intended one at ~line 2521).

## The fix (commit `746005f7`, review fixes in `d50bcaae`)

A post-implementation review pass (2 independent reviewers + validation) found
one HIGH defect in the first commit — a scope hint that narrowed the match set
without resolving it to one was discarded, letting the forward pick land
outside the hinted scope — fixed in `d50bcaae` by carrying the hint-satisfying
subset into the cursor rule. The same commit makes disclosure notes report
lines in the coordinates of the file the model read.

- A cursor threads across the hunks of an update. When a **non-first** hunk's
  fingerprint matches multiple locations and scope hints do not resolve it,
  the first match at-or-after the previous hunk's end is applied.
- The choice is never silent: the tool result carries a per-file note —
  "hunk N matched M locations; applied at the first match after the previous
  hunk (line L)" — so the model can immediately verify placement (canonical
  Codex chooses silently; this is strictly more informative).
- **First-hunk ambiguity still errors** (protects both confirmed-dangerous
  cases), now stating the contract: the first hunk must locate itself
  uniquely. A non-first hunk whose matches all sit before the cursor errors
  with reorder guidance.
- Unchanged: scope-hint precedence, pure-insert/BOF, EOF tail-first search,
  changed-on-disk diagnostics, `prompt.ts` (tool-description bytes are
  prompt-cache-sensitive).

Verification: focused suite 64 pass / 0 fail (55 baseline);
`bun run build:dev:full` green; live replay of real corpus cases through the
modified applier — the 204-location case applies at the ground-truth-confirmed
line with its note, the four-allowlist case resolves all hunks at the
committed lines, `phase4.md` still errors.

## Open items

- 23/48 failures were never replayed (no reconstructable state); the static
  shape classification suggests the replayable subset is representative, but
  that part is inference.
- Training-distribution causation is plausible, not proven (no controlled
  comparison across tool semantics).
- F4 telemetry (`[apply-patch]` observability for failure codes and fuzzy-tier
  rescues) is still absent; the new disclosure notes surface placements in
  transcripts, but rates remain unmeasured in production.
