# Appendix B — Finding corpus, taxonomy, and why the review over-fires

Companion to [the main audit](2026-08-22-review-impl-finding-quality-audit.md).

---

## 1. Corpus shape

382 deduped finding rows, 30 sessions, 2026-07-26 → 2026-08-22.

| Verdict as self-labeled | Rows | Share |
|---|---:|---:|
| VALID | 291 | 76.2% |
| FALSE POSITIVE | 36 | 9.4% |
| DEFERRED | 22 | 5.8% |
| Deferred to a new session | 15 | 3.9% |
| Not labeled in the row text | 18 | 4.7% |

201 rows (53%) cite a concrete `file.ts:line`.

Only **19 rows in the entire corpus carry an explicit HIGH / MED / LOW label.** That is not a
reporting oversight in this audit; it is the finding. See Appendix C §1 for why: the severity
column was requested on 2026-08-08, written to a skill mirror instead of the canonical file,
and overwritten ~14 hours later by a `--force` republish. The 19 labeled rows cluster almost
entirely in the two reviews that ran inside that window.

---

## 2. Taxonomy

**Method caveat, stated up front: these buckets are keyword-derived from the row text and are
approximate.** Several rows are visibly misfiled — a row whose text contains "blocking" lands
in Performance even when it describes a correctness bug. Treat the shares as indicative. The
verdict counts in §1, the re-verification table in Appendix A, and the operator-reaction
evidence are exact; these are not.

| Bucket | Rows | Share |
|---|---:|---:|
| Behavior bug — wrong output, lost data, bad state | 196 | 51.3% |
| Doc or comment states something false about the code | 72 | 18.8% |
| False positive | 36 | 9.4% |
| Performance / resource | 24 | 6.3% |
| UI copy, naming, accessibility | 22 | 5.8% |
| Test gap, or a test that cannot fail | 19 | 5.0% |
| Dead or inert code just written | 13 | 3.4% |

Cross-cutting counts over the same corpus, independent of bucket:

| Signal | Rows |
|---|---:|
| Mentions silent loss, dropping, or swallowing | 46 |
| Stale or false doc/comment language | 25 |
| Dead / inert / never-fires | 18 |
| Explicitly about **pre-existing** code, not the session's diff | 18 |
| Agent explicitly attributing the defect to its own work this session | 17 |
| Empirically proven — reproduced, measured, or the real function was run | 23 |
| Test that cannot fail / proves nothing | 5 |

The **18 pre-existing rows out of 382 (~5%)** is the number that reframes the whole question.
`/review-impl` is not auditing a mature codebase. It reviews the diff the session wrote minutes
earlier and has usually never executed. High yield on that material is expected.

---

## 3. Why the ~19% doc-and-comment bucket is not pedantry

This is the bucket that looks most like nitpicking and is not. Three independent lines converge:

1. **Appendix A** found the doc findings were factually right every time they were checked —
   including a zod-semantics claim that was verified by running it, and a "this function is not
   a reader" claim whose four alleged side effects were all present in source.
2. **`docs/migration/reviews/2026-08-03-week-code-review.md`**, a different review path weeks
   earlier, reached a blunter conclusion: *"in this codebase a confident doc comment is
   currently a signal to check, not a reason not to. Four of the five HIGHs sit directly under
   one."*
3. **Appendix C §4** shows this is the single most common recurring shape in the corpus —
   present in at least 14 of 30 sessions — with **no automated prevention whatsoever**, because
   `bun run lint` enables zero rules (all 19 custom rules are `createNoopRule()` stubs).

One case compounds: a commit propagated a pre-existing error into fresh prose with a specific
wrong `file:line`, which then *"misled the next reviewer inside this very review."*

---

## 4. Where the review genuinely over-fires

36 findings were rejected as FALSE POSITIVE. **None of them is a style complaint.** They cluster
into five recognizable causes, all of them context gaps.

### Cause 1 — flags code outside the task-scoped diff (largest class)

> `2d5da6ab` — "No feedback when clicked mid-turn" → *"Agent itself confirms this is
> pre-existing behavior of every mid-turn submit, not introduced here"*

> `3dd55442` — "Role-less row loses trailing slot" → *"pre-existing line I never touched, and
> `AgentTypeChip` returned null for that case too, so no regression"*

> `463ff374` — "Round linecap makes the arc read ~3.7% past its end" → *"pre-existing; removing
> the cap breaks the documented empty-state dot"*

Note the tension with Appendix C: this same instinct, applied one step too aggressively, caused
escape 2 — a defect correctly identified and then discarded as "pre-existing" when the surface
asserting it was new. Scope discipline cuts both ways.

### Cause 2 — unaware a behavior is deliberate parity with the terminal engine

> `6d0ce8ac` — "Abort mid-drain-window can re-deliver" → *"Identical in the terminal —
> `removeFromQueue` is at `:1699` there too. Engine-shared semantics, and the user still sees
> one row. Parity, not a desktop defect."*

> `d595a8ba` — "Stop/Esc fires the queued prompt instead of dropping it" → *"The terminal does
> the same: `useCancelRequest.ts:96-101` cancels the turn and returns, leaving the queue"*

### Cause 3 — reasons about a branch that cannot execute

> `6d0ce8ac` — "Requeue-to-tail inverts order" → *"Arm is unreachable: no await between the
> `parking`/`activeTurn` check and `startTurn`."*

> `55b8f9c3` — "Subagent filter inconsistent with sibling" → *"`QueryEngine.ts:941` stamps
> `parent_tool_use_id: null` on every stream event, so the guard would be inert; adding it
> would read as protection that isn't there"*

> `66f06b65` — "`-0`/`0`, sparse arrays encode alike" → *"No numeric or array-with-holes input
> exists or is constructible via the typed helpers"*

### Cause 4 — objects to a conscious, documented tradeoff

> `66f06b65` — "Over-keys names when only `.length>0` is read" → *"Deliberate. Under-keying
> yields a silently wrong prompt; over-keying costs a Map entry. Safe direction wins."*

> `77a1d024` — "'Loading usage analytics' vs bare 'Loading'" → *"deliberate; the chart
> placeholder is a large empty region that must name itself, the inline ones sit under their
> own headings"*

### Cause 5 — demands a test the harness structurally cannot express

> `64fa9c9e` — "No live click test" → *"This renderer suite is server-render-only and cannot
> dispatch DOM events"*

> `aee64f62` — "Grep pins one spelling" → *"That file's header argues this limitation
> explicitly; a runtime test needs main.ts wiring extracted, disproportionate here"*

This cause is the review colliding with the SSR-only renderer suite — the same structural gap
the week code review named as the reason *"2333 pass does not mean what it looks like it
means."* The reviewer is not wrong that the coverage is absent; it is wrong that this diff can
supply it.

### Cost of over-firing

Low, and worth stating precisely: **every false positive was killed by the main agent's own
Step-3 validation before any code changed.** Over-firing costs turns, not correctness. One
session recorded *"Zero false positives across both reviewers."*

---

## 5. What the operator did with the findings

Across roughly 20 sessions of follow-up, **no finding was ever rejected as bogus.** The
recurring reaction is the opposite — pulling DEFERRED items forward into fix-now:

> "I think we fix it now. Dont defer"
> "you can just fix both open now. no one gonna do it if not you"
> "if what deferred worth the fix then it fine. Just gix it"
> "nah, i think we do it now"
> "you can go with other deffered"

The present concern was voiced once before, in session `3aacc503` on 2026-08-14:

> "what? why so many problem foudn"

The answer given then, which this audit confirms and which was subsequently not acted on:

> "The raw count is misleading — I relayed the agents' itemized list without triaging it."

---

## 6. Reproducing this corpus

The extraction is non-obvious in one respect worth recording. Grepping transcripts for the
string `review-impl` matches almost every session in the history, because the skill name
appears in the available-skills listing injected into every session's context. The invocations
must be matched on the literal command tag instead:

```
grep -rl 'command-name>/review-impl<' ~/.claude/projects/ ~/.cat-code/projects/
```

That yields 41 files, of which 7 are compaction-summary artifacts carrying another session's
text and must be excluded. Findings are then recovered from assistant turns after the
invocation line that contain the Step-3 verdict vocabulary, and deduped — several sessions
print the validation table repeatedly as it fills in.
