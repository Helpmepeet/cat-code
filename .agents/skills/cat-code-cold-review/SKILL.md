---
name: cat-code-cold-review
description: "Use when asked to review completed Cat Code work, audit test confidence, or verify STATUS/DONE/report claims. Not for other repositories, pre-implementation plan review, or writing new plans."
---

# Cat Code Cold Review

## Overview

A cold review re-derives the truth from source; it never grades the author's
own summary. Order is fixed: **conformance first, correctness second** — a
beautiful implementation of the wrong thing is a failing review. This is the
house methodology (P2-0 → P4 tranche-A reviews); follow it, don't improvise.

## Execution ownership

"Cold" and "adversarial" describe how YOU review, not who reviews. Do the review
in this thread; spawn an agent only if the user asks for one.

## Step 1 — Establish the contract

Collect what the work was SUPPOSED to do: the plan or backlog prompt, the
STATUS/INVENTORY row, cited decision docs, acceptance criteria. If no written
contract exists, that is itself a finding — say so in the verdict.

## Step 2 — Code-vs-plan (conformance) pass

For every plan item, locate the implementing code and classify
`implemented | partial | missing | exceeded-scope`. Exceeded scope is a
finding too (this repo requires surgical changes). Only after the conformance
verdict do you start correctness review. For multi-commit work, review commit
by commit (`git show <sha>`), not the squashed diff — the house pattern is
per-commit review lanes plus one integration lane.

## Step 3 — Correctness pass, source-verified

- Re-verify EVERY load-bearing claim from source with `file:line` anchors.
  Cited anchors are claims too — anchor drift is a finding.
- Re-run the verification commands the author claims (the
  `verifying-cat-code-changes` battery). Never trust reported pass counts;
  record your own numbers. Known-red baselines (root tsc ~1.9k, sidecar tsc
  ~5.5k upstream) are not findings — a NEW error in owned files is.
- For `app/` work: check the security baseline explicitly (closed inbound
  allowlist at the sidecar, T4/T5a/T6/T6b/T7, directional frame limits,
  `secretGuard`, default-deny preload) even when the change "shouldn't touch
  it" — and check parity: any prototype element silently dropped without a §0
  flag is a finding.
- **Anti-Potemkin rule:** a demonstrated behavior counts only if the proof
  could not be produced by re-rendering stored data. Restore is proven by a
  post-restore answer depending on a pre-quit fact plus the same
  `engineSessionId` transcript appended by a NEW engine PID — not by JSONL
  replay. Apply the same standard to any "it works" claim: ask what would
  fake it, then check that.
- Hunt the recurring local defect classes: stub-context wiring at seams
  (`tools: []` class); unwired feature flags/migrations; silent parity cuts;
  cross-process read-modify-write without lock+fresh-read; tests that assert
  shape but never exercise the live path; docs updated but code not (or vice
  versa); pre-computed state applied under a later lock.

### Test-confidence gate

When tests support a material acceptance claim, verify the proof rather than
grading test style. For each claim, identify:

1. The production entry point exercised. A helper-only test does not prove its
   caller, and a source-string assertion is only a wiring tripwire.
2. The exact pre-fix failure the test would catch. A fixture the public caller
   cannot create, or an “unchanged” assertion against state the operation never
   receives, does not count.
3. A pairwise interaction when two independently valid states can compose
   (model switch + cumulative usage, settlement + authority loss, and similar
   seams), not only one-axis examples.
4. Every unverified GUI, live-client, process, timing, or concurrency layer.
   Missing proof is `UNVERIFIED`, never an implied pass.
5. The correlation matrix for identity/concurrency work: missing, unknown,
   stale, and duplicate identities where applicable; two actors plus
   out-of-order or same-batch delivery for correlated results.

For regex or heuristic evaluators, adversarially check negated, contradictory,
mixed, and paragraph-scoped answers. Ambiguous evidence must route to review,
not pass. Do not demand blanket test rewrites: classify each gap as **react
now**, **named owner or explicit waiver**, or **no action**, based on the
reachable consequence and the confidence the project actually needs.

## Step 4 — Verdict and findings

- Verdict: **GREEN** (accept) · **YELLOW** (accept with named follow-ups) ·
  **RED** (rework before acceptance).
- Findings numbered `F1..Fn`, severity `Critical | High | Medium | Low`. Each
  finding: one-sentence defect · evidence anchor (`file:line` or command
  output) · concrete failure scenario · proposed owner/disposition.
- **Two-strikes rule:** a finding already flagged in a previous review that
  still has no owner is marked **SECOND STRIKE** — it must get a named owner
  session or an explicit recorded waiver in STATUS, never a third silent
  repeat.
- Nits (style, doc wording) go in a separate short list; never inflate their
  severity to make the review look thorough.

## Step 5 — Report

- Verdict + findings table in your chat report, verdict first.
- Migration work: write the review to
  `docs/migration/reviews/YYYY-MM-DD-<scope>-review.md` (reviews are archival
  — dated, never edited after the fact; older files there lack the `-review`
  suffix — do not rename them). Non-migration reviews have gone to
  `docs/reports/YYYY-MM-DD-<scope>.md` in practice; write a file only when
  the review is substantial or the user asked for one.
- Update a STATUS row with the review outcome only if asked; a review is
  report-only by default — do not fix what you find unless the user says to.

## Failure handling

- Cannot verify a claim (needs GUI, credentials, live usage) → mark it
  `UNVERIFIED` with the exact operator step; never let it default to pass.
- Verification fails for reasons unrelated to the work → classify pre-existing
  vs introduced against the base commit, with proof.
- The contract itself is wrong (contradicts locked decisions or source
  reality) → that is a Critical finding against the contract, not a license to
  silently reinterpret it.
