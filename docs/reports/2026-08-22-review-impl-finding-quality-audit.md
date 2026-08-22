# Is `/review-impl` finding real problems, or is it just strict?

**Date:** 2026-08-22
**Question asked:** "it always found a problem, my concern is does the code too slop or our
model review too strict."
**Answer:** Neither. The findings are real at a rate that survived adversarial re-checking, the
reviewer is not fussy about style, and if anything the review is **not aggressive enough** —
two user-visible defects escaped a pass that had already written the cause down and filed it
under the wrong heading.

Three things are actually wrong, and none of them is "the code is slop":

1. **The report has no severity**, so an ordinary yield reads as a quality crisis. You already
   asked for this on 2026-08-08. The change was written to a skill *mirror* instead of the
   canonical file and was overwritten ~14 hours later by a `--force` republish. All three
   copies are byte-identical today and contain zero severity references.
2. **Step 3 has no verdict for "real, but rooted outside my diff"**, so findings of exactly
   that shape get dropped rather than escalated. Both hard escapes were of that shape.
3. **Nothing in the skill checks effect.** Every step is static reading, run on the same
   evidence base that let the defect ship.

This report is the evidence. Appendices carry the raw tables.

- [Appendices A–D — consolidated evidence tables](2026-08-22-review-impl-audit-appendices.md)

---

## 1. Corpus and method

Every `/review-impl` invocation was recovered from the session transcripts under
`~/.claude/projects/-Users-pt-cat-code/` and `~/.cat-code/projects/-Users-pt-cat-code/`,
matching the literal command tag rather than the string `review-impl` — the skill name appears
in the available-skills listing of *every* session, so a naive grep matches almost the whole
history and is useless.

| | |
|---|---|
| Transcript files containing an invocation | 41 |
| Of those, compaction artifacts and one forked duplicate (excluded) | 7 |
| **Review runs** | **34** (38 invocations — four sessions ran it twice) |
| Sessions with integer-numbered finding rows scraped | 30 |
| Deduped scraped rows | 382 |
| **Best estimate of distinct findings** | **~375** |
| Date span | 2026-07-26 → 2026-08-22 |
| **Median findings per run** | **10** (IQR 8–13) |

> **Correction, from Appendix D.** The scrape used through most of this report undercounts in
> one direction and overcounts in another, and both need stating. It **silently drops every
> validation table whose `#` column is non-numeric**, which is how four whole reviews
> (`76e10e2b`, `cc9feb6e`, `97b04c6f`, `1ba97aa9` — 46 findings between them) appear as 1, 0, 0
> and 0. It also **double-counts findings restated in a Step-4/5 summary**, inflating by ~10%.
> Row-based figures below are kept as-is so they stay comparable, but the finding column is a
> floor. Appendix D §1 has the full reconciliation.

**One review found nothing at all.** `f6a7c289` (2026-08-09, 121-line diff, one agent) returned
zero findings; its report walks four specific claims and clears each. That is a real zero, not a
scrape gap, and it retires the premise that the skill *always* finds a problem.

### Verdict distribution as self-labeled by the reviewing sessions

| Verdict | Rows | Share |
|---|---:|---:|
| VALID | 291 | 76.2% |
| FALSE POSITIVE | 36 | 9.4% |
| DEFERRED | 22 | 5.8% |
| Deferred to a new session | 15 | 3.9% |
| Not labeled in the row text | 18 | 4.7% |

201 rows (53%) cite a concrete `file.ts:line`.

**These labels are self-assigned by the same model family that produced the findings, so on
their own they prove nothing.** Sections 2, 4, 5 and 5b are **three** independent attempts to
break them: source re-verification, corroboration from an unrelated review path, and escape plus
normalization analysis. Section 3 was originally counted as a fourth and **has been retracted as
corroboration** — see the notice there.

---

## 2. Lane one — do the VALID findings survive contact with source?

A subagent, given no access to any conclusion of this report, re-checked 33 VALID findings
across 24 sessions against the current tree and git history. It was told to be adversarial and
to actively hunt for cases where the finding was wrong.

**Result: 0 of 33 refuted.** Full table in Appendix A.

It weighted the sample toward falsifiable claims, which is what makes the result meaningful:

- An **unreachability** assertion (`alreadyDelivered`/`ok:false` in `sidecarServer.ts`)
- A **probability figure** — the claim of a 69% colour collision at five workers. Recomputed
  exactly: `1 − P(10,5)/10⁵ = 69.76%`.
- A **zod semantics** claim — that `z.object` strips unknown keys rather than rejecting them.
  Reproduced by running it: undeclared key → `success: true`, `data: {"a":"x"}`.
- A **"this function is not a reader"** claim about `loadConversationForResume`. All four
  alleged side effects confirmed in `conversationRecovery.ts`; the transcript backfill worker
  sets `CLAUDE_CODE_SIMPLE=1` specifically to neuter them.
- Two **regex coverage** claims about path linkification. The pre-review regex required a `/`
  in every alternative, so `README.md` structurally could not match.

### 19 of the 33 would have been user-visible

| Defect | Where | Fix |
|---|---|---|
| Line-capped read satisfied the read-before-write gate → silent whole-file overwrite of a file the model saw two thirds of | `FileWriteTool` | `53be676f` |
| `startTurn` called with no rejection handler → queued prompt lost silently | sidecar boundary drain | `7b0164b5` |
| Fast Mode silently demoted Sol → Terra | `fastMode.ts` | `3153a35a` |
| Prompt recall reported clean success, then delivered to the model anyway | `sidecarServer.ts` | corrections path |
| Agent face identity feature entirely inert — `identity.id` always null | `TranscriptView.tsx` | `41dfbac1` |
| A "read-only" context popover ran SessionStart hooks in the live process | `contextBreakdownDomain.ts` | — |
| Dismiss was a dead control on persisted-plane rows, under a toast claiming it had worked | `workerInspection.ts` | `bf30642f` |
| Session reported `idle` while blocked, letting goal continuation fire | `tuiSessionStatus.ts` | `2fa8640d` |

The remaining 14 split 10 internal-only (perf, dead markup, test isolation, `__proto__`
hardening) and 4 prose-only.

### What that lane does *not* establish

Stated plainly, because it matters more than the headline:

- **The sample self-selects.** 30 of the 33 were fixed within minutes by the same session, so
  the VALID label reads closer to "I confirmed this before changing it" than to a blind
  judgment. The hardest cases to sample are VALID findings that were never fixed — those leave
  no diff.
- **It required a `file:line` citation**, which favors findings concrete enough to be right.
  0/33 therefore applies to the concrete cited subset, roughly 152 of the 291 VALID rows.
- **`/review-impl` reviews uncommitted code**, so for about six findings git cannot show a
  "before" state at all; the finding and its fix land in one commit. Those were recovered from
  the session JSONL instead — solid, but a different provenance than a diff.

---

## 3. Lane two — operator disposition of deferred work (NOT evidence of finding quality)

> **Retracted as corroboration, 2026-08-22, at the operator's correction.** An earlier revision
> of this section treated "the operator never rejected a finding, and repeatedly pulled DEFERRED
> items into fix-now" as evidence that the findings were valid and worth acting on. **That
> inference is unsound and the lane no longer supports the report's conclusion.**

The inference the report made was:

```
operator approved fixing it  →  operator judged the finding valid
```

The actual mechanism, per the operator:

```
review says finding is real but deferred
      ↓  operator asks WHY it was deferred
      ↓  reason is size / time / risk only
      ↓  operator says "just fix it"
```

**The operator generally did not inspect the individual findings.** What they were ruling on was
whether to accept the cost or risk that caused an item to be deferred — not whether the finding
was technically correct. Re-reading every operator quote collected for this lane confirms it:
each one decides cost, timing, or ownership, and none asserts that a finding is right.

| Quote | What it actually decides |
|---|---|
| "how hard for these deferred?" · "give me 1-10 score" | cost |
| "what is deffered now? does anything worth it?" | delegates the worth judgment back to the agent |
| "if what deferred worth the fix then it fine. Just gix it" | conditional on the agent's own assessment |
| "you can just fix both open now. no one gonna do it if not you" | ownership |
| "I think we fix it now. Dont defer" · "nah, i think we do it now" | timing |

The absence of rejection carries near-zero signal for the same reason: **you cannot reject what
you did not read.**

### Where the operator did judge independently, they rejected

This is the part the original lane obscured. The operator's genuine independent observations
were about *visible outcomes*, not finding lists, and in those cases they were **negative**:

> "So i telling you that it not passed" — rejecting GUI acceptance on `Main thread 0s`
> "This is current. The color is gone."
> "Why i didnt see the change at all?"
> "i didnt change anything but now the donut gauge when clicked look like this now"

Two of those are the escapes in §5. So operator behavior, read correctly, is at best neutral for
the review and at worst mildly adverse — it is the record of what the review *missed*, not of
what it got right.

### What survives

Only one thing, and it is not corroboration: session `3aacc503`, 2026-08-14 —
*"what? why so many problem foudn"* — is the present concern voiced before, and the answer given
then already contained the diagnosis:

> "The raw count is misleading — I relayed the agents' itemized list without triaging it."

That triage was then not applied in later sessions. §6 is about that. Note this quote is
evidence of operator *doubt*, which the earlier revision filed under a heading claiming operator
endorsement.

**Consequence for the report:** the conclusion in §2, §4, §5 and §5b is unaffected — those lanes
are source-verified, independently corroborated, or measured. But the report now rests on
**three** independent attempts to break the self-assigned labels, not four. §1's claim to the
contrary is corrected there.

---

## 4. Lane three — independent corroboration from a different review path

`docs/migration/reviews/2026-08-03-week-code-review.md` is a cold review of one week's work on
this repo. It is not `/review-impl`, it ran weeks earlier, and it reached the same place.

**Yield:** 56 findings — 5 HIGH, 19 MEDIUM, 32 LOW — across 8 lanes, about 7 per lane. That is
the same order as `/review-impl`'s ~12.7 per pass on a much narrower scope. The yield is
ambient defect density in fresh code here, not an artifact of one skill.

**Its header is the single most important sentence in this whole audit:**

> `bun test app/` 2333 pass / 0 fail · app typecheck clean · sidecar wrapper passed ·
> hardening 19/19
> "Every gate is green. **Every HIGH finding below is invisible to all four of them.**"

**Its cross-cutting themes name the same shapes** this audit extracted independently from the
`/review-impl` corpus:

| Week review theme | Corresponding pattern in the `/review-impl` corpus |
|---|---|
| SSR-only renderer suite — React effects never run, so "2333 pass does not mean what it looks like it means" | why behavior bugs routinely survive a green battery |
| Source-text greps counted as tests | the test-gap findings |
| Built, tested, and never called — three times in one week | the dead/inert-code findings |
| Doc comments asserting the opposite of the code | the largest non-behavior category, ~19% |

On that last row the week review is blunter than this audit was prepared to be:

> "in this codebase a confident doc comment is currently a signal to check, not a reason not
> to. **Four of the five HIGHs sit directly under one.**"

This retires the most tempting dismissal of the `/review-impl` corpus. The ~19% of findings
that are "a comment states something false about the code" look like pedantry and are not:
by the other reviewer's count, false comments were the cover for four of five HIGH-severity
bugs.

---

## 5. Lane four — what escaped anyway

Full detail in Appendix C. A subagent searched 2,116 later human messages across 396
transcripts, plus later commits touching each review's files, for defects that survived a pass.

**Two user-visible escapes are firmly established. Both were seen by the review and discarded.**

| Escape | Gap between review and complaint | What the review actually did |
|---|---|---|
| Context donut showing three contradictory numbers — header `71% · 262k / 372k` beside only `Skills 2.6k` and `Free 318k` | **3h45m** | Wrote down the exact cause — *"on a `gpt-*` session `countTokens` takes the Codex path, fails"* — and filed it under **Performance** as "bounded; design decision open". Never asked what the panel renders when the counts come back null |
| Accounts panel reading `Main thread 0s`, rejected by the operator at GUI acceptance | **22 min** | Listed it in Agent 1's *not-a-finding* section as *"real, but … predates this diff"*. The session afterwards: *"I had this finding in review and waved it off as pre-existing; that was wrong, because the panel asserting it is new and mine"* |

Neither was a coverage gap. Both were **verdict errors**, and the skill's vocabulary caused
them: Step 3 offers only VALID / FALSE POSITIVE / DEFERRED, with *"Everything else should be
VALID."* There is no verdict for *"real, user-visible, asserted by my new surface, but rooted
outside my diff"* — so both got dropped instead of escalated.

The structural pattern: **both sat one hop outside the diff, on the callee side.** Agent 1 reads
only the diff and touched files; Agent 2B's blast-radius lens looks at *callers* of the new
code. Nothing checks whether what the new code *calls* works in this app's runtime
configuration.

### Fixes held up

**Zero review-driven fixes were git-reverted.** Seven distinctive symbols introduced by review
fixes were sampled and all survive at HEAD. The only rework is one Performance remediation
undone 39 minutes later — the same bucket that swallowed the first escape.

Two review fixes did ship **dead**, and were caught only because a second round ran:

> "The recall correction never reaches the user … **My fix from last round is dead code**"
> "**The retained FIFO doesn't fix its bug.** One submit produces ≥3 `settled` signals — I
> measured `["settled","settled","settled"]`."

Four sessions ran two rounds; **three of the four found a defect in round one's own fixes.**
That is the sharpest single argument against "too strict".

### Recurring shapes, and what prevents them

Seven defect shapes recur across 7 to 14 separate sessions each. **Exactly one has ever
received an automated guard, and it is partial.** This is the sturdiest part of the whole audit
because it needs no counterfactual — the full table is in Appendix C §4. The largest is the
false-comment shape (≥14 of 30 sessions, zero prevention, because `bun run lint` enables zero
rules). The most striking is a literal NUL byte written into a TypeScript source, which makes
`rg` skip the file during traversal: it happened three times across 12 days, and each fix added
a test guarding only *its own module*. Verified at audit time — five such per-module tests
exist, there is no repo-wide sweep, and nothing prevents a fourth.

## 5b. Lane five — the denominators

Full detail in Appendix D. Every one of the 34 runs had its task-scoped diff recovered; 25 are
corroborated twice (stated in transcript *and* reproduced from git). **Zero unknowns.**

### The reviewer returns a fixed budget of findings

**Spearman(diff size, findings per 100 lines) = −0.78.** Against *absolute* findings it is only
+0.53. A 4,277-line review produced 33 findings; a 91-line review produced 12. Median findings
by size band: 4.51 per 100 under 300 lines, 1.09 per 100 over 1,600.

**The reviewers return roughly 10 findings — IQR 8 to 13 — almost regardless of how much code
they are given.** That single fact explains the feeling that prompted this audit better than any
other number in the report: to a first approximation the count *is* constant, because it is
partly a property of the reviewer's reporting budget rather than of defect density. It also
means "findings per 100 lines" is not a size-invariant quality metric here — it is largely a
proxy for `1/diff-size`, and the instinct to normalize has to be discounted accordingly.

### The trend is flat

| | Spearman vs date |
|---|---|
| Findings per 100 lines | −0.06 |
| Absolute findings | −0.09 |
| Diff size | −0.04 |

All noise. Neither candidate story survives: diffs did not grow (median 518 → 358 → 501 across
date-thirds) and raw counts did not rise (13 → 10 → 10.5, a mild decline if anything). **Over
four weeks and 34 runs the yield is statistically indistinguishable. The code is not getting
sloppier and the review is not getting stricter.**

### More reviewers does not mean more findings

Within the only size band where both occur (under 250 lines): 1 agent → median 9.5 findings,
2 agents → 9.0. **Same absolute yield.** The second agent adds a *lens*, not volume — visible in
composition, not count. Findings per agent falls monotonically 9.5 → 5.0 → 4.0. The skill's
1-or-2 rule was followed in 27 of 34 runs, and all seven deviations were announced in-transcript.

### The gates catch 1 behavioral defect in 210

Of 416 rows, 210 describe a behavioral defect. **Exactly one would have turned a gate red
without someone first writing a new test** — a test committed red, where the gate existed and
was simply skipped. On the widest defensible reading, three. Root `bun run typecheck`, the
sidecar wrapper's upstream diagnostics, and `bun run lint` were given no credit, per CLAUDE.md §3.

**0.5%.** And ~33 rows — 8% of the corpus — are findings *about the gates themselves being
blind*: inert tripwires, `as unknown as` casts defeating `tsc`, *"3 of 4 new tests do not fail on
revert"*, and one case where deleting a single token kept 1,958 tests green while restoring the
exact starvation the decision exists to prevent.

Once normalized, the apparent `app/` concentration also disappears: `app/` 1.62 findings per 100
lines, `src/` 1.57. Findings track where the code was, not where the bugs were.

---

## 6. The actual defect: an untriaged report

Everything above says the findings are sound. The complaint that prompted this audit is still
legitimate, and it is about presentation.

The skill's Step 3 produces one flat numbered validation table with **no severity column**.
The re-verification subagent, which had never seen this report's argument, arrived at the same
sentence independently:

> "the same table cheerfully marks a stale code comment and a silent whole-file overwrite both
> VALID"

A 33-row table where row 6 is "rename a variable", row 11 is "this comment is off by one in
prose only", and row 1 is "closing a parked tab re-spawns a real billed engine and sends your
message into it" reads as *the code is falling apart*. It is not. It is an ordinary yield,
sorted badly.

Contrast the week code review, which grades every finding H/M/L, opens with a five-row HIGH
table, and closes with a "Suggested triage order". Same repo, same class of code, far more
legible output. `/review-impl` is the outlier in **presentation**, not in strictness.

### This was already asked for, and it was lost

The severity column is not a new recommendation. On **2026-08-08 15:49**, session `99d05643`:

> "In review impl skill, i think the table missing the severity. Can you tell the model to add
> it?"

The agent made three edits — the Step 3 column plus Agent 1 and Agent 2B reporting instructions
— and wrote them to the **mirror** at `~/.claude/skills/review-impl/SKILL.md`, never to the
canonical `~/.agents/skills/`. The next morning at **05:44**, a different session edited the
canonical file for an unrelated reason and ran `publish-skill.mjs publish global … --force`,
which reported:

> `claude-code: replace divergent mirror (/Users/pt/.claude/skills/review-impl)`

That divergent mirror *was* the severity change. It lived about 14 hours.

**Verified during this audit:** all three copies — canonical plus both mirrors — are
byte-identical (`md5 b0c40d43…`) and contain zero occurrences of "sever".

**The effect is visible in the data.** Severity labels appear in 11 of 11 findings for session
`f9b104ec` and throughout `1ba97aa9` — the two reviews that ran inside that window — and in only
2 of the 15 reviews after. Across the full corpus, just **19 of 382 rows** carry an explicit
HIGH/MED/LOW.

This is the exact failure the skill-publisher architecture exists to prevent: edit the canonical
source, publish, verify — never edit a mirror.

### Recommended mechanism

Three edits to the canonical `~/.agents/skills/review-impl/SKILL.md`, then a `skill-publisher`
push to the three runtime mirrors, then verify the mirrors actually carry it:

1. **Restore the Step 3 severity column** — user-visible / internal / prose-only. The reviewer
   already knows this; it is simply not asked for.
2. **Step 5 leads with a triaged headline, not the list.** "3 would have been user-visible, 6
   are internal, 4 are prose-only" before any enumeration.
3. **Add a fourth Step 3 verdict** for *the defect my new surface now asserts, whose mechanism
   lives outside my diff.* Today those findings fall between DEFERRED and FALSE POSITIVE and get
   dropped. That one change would have caught both escapes in §5.

Items 1 and 2 change nothing about how hard the review looks — only what the operator sees
first. Item 3 is the one that changes outcomes.

---

## 7. What is genuinely worth worrying about

Not the count. Two things:

**The recurring bug shape.** Almost every real finding is second-order: *"I changed what X
means, and followed the consequence one hop."* The `FileWriteTool` overwrite is the canonical
case — the session checked whether the clamped read broke `FileEditTool`'s gate, found it
re-reads from disk, concluded "Edit is safe", and never checked `FileWriteTool`, which uses the
same `readFileState` for a destructive whole-file write. One consumer verified, all consumers
assumed.

**The batteries cannot see this class.** Both this corpus and the week review land on it
independently. A green `bun test app/` is compatible with a feature being entirely inert,
because the renderer suite is SSR-only and React effects never run. Green is not evidence of
behavior here, and the review is currently the only thing standing between that and shipping.

**And the review inherits the same blindness.** Every step of the skill is static reading. From
the session that produced the first escape, in its own words:

> "I shipped this whole path on server-rendered evidence and never once ran it. You asked for a
> real implementation and I gave you one that typechecks and passes 2578 tests without a single
> execution of the actual feature."

The review ran on that same evidence base. A reviewer that only reads cannot catch a defect that
only appears when the code runs — which is why the two escapes reached a human within hours, and
why the second-round reviews in §5 paid off so consistently.

**Seven recurring shapes, one guard.** The prevention table in Appendix C §4 is the most
actionable artifact in this audit. Findings get fixed; the shape that produced them almost never
gets a guard, so the same class returns weeks later in a different file.

### The tightest illustration of the review earning its cost

All three timestamps are from 2026-07-30 and verified against git:

| Time | Event |
|---|---|
| 14:56:59 | `183276f5` removes a literal NUL byte from the section cache key and picks `#` as the replacement separator |
| **14:57:52** | `/review-impl` runs — **53 seconds later** |
| — | It finds that `#` now collides: `('a','ab#z')` and `('a#s4:ab', null)` both encode to `a#s4:ab#z`. A key collision serves a wrong system prompt silently |
| 15:15:00 | `d2783756` fixes it, 18 minutes after the review started |

This is the whole argument in one hour of history. A fix for one real bug introduced a second,
subtler one; no gate could see it (the collision is unreachable with today's section names, so
nothing fails); the review caught it inside a minute; and it cost one line to fix. It is also
finding #1 in Appendix A, independently re-verified by recomputing both encodings by hand.

---

## 8. Uncertainties

- The 0/33 refutation rate covers the **cited, concrete** subset of VALID rows. The vaguer
  findings, which are likelier to be wrong, were structurally excluded by the sampling filter.
- No lane sampled **VALID findings that were never fixed**. Those are the ones a wrong label
  would hide in.
- The taxonomy percentages in Appendix B are **keyword-derived and approximate**. The verdict
  counts, the re-verification table, and the operator-reaction evidence are exact; the bucket
  shares are indicative only and several rows are visibly misfiled by the classifier.
- Severity labels in the corpus are sparse — only 19 rows carry an explicit HIGH/MED/LOW —
  which is itself the finding in section 6, but it means severity distribution across the full
  corpus cannot be stated, only sampled.
- **The finding counts are the weakest numbers in this report set.** The scrape drops
  non-numeric tables (four whole reviews) and double-counts restated rows (~10%). Appendix D
  recovered the four missing reviews but not an estimated further ~28 non-numeric rows scattered
  across sessions already in the table. Denominators are far stronger than numerators here.
- **Three diff denominators are soft.** The worst, `2d5da6ab`, brackets 120 to ~310 lines, so
  its rate is 3.0–7.5 per 100 — elevated but not securely a top-four outlier. Appendix D §8
  names all three and gives the bracket.
- **The 0.5% battery-catchability figure is judgment-laden.** A different reader drawing the
  behavioral/non-behavioral line differently could move the split by ±25. The direction is
  robust — the rate stays under 1% across that whole range — but the specific figure should not
  be quoted without the rubric.
- **No lane measured the counterfactual**: how many defects would have escaped had the pass not
  run. That number is not recoverable from these transcripts, and every claim about the review's
  value is correspondingly bounded.
