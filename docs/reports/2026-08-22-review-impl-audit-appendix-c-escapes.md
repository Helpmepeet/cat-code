# Appendix C — Escapes, reverted fixes, and recurring defect shapes

Companion to [the main audit](2026-08-22-review-impl-finding-quality-audit.md).

This lane tested the review from the direction the other lanes could not: **what got through
anyway.** Method — for each of the 30 review sessions, take the reviewed diff and its cited
files, then search later human messages (2,116 across 396 transcripts) and later commits
touching those same files.

---

## 1. The severity column was requested, applied to the wrong file, and overwritten

This is the most actionable finding in the entire audit, because it means the fix recommended
by the main report is not a new idea — it is a restoration.

**2026-08-08 15:49, session `99d05643`:**

> "In review impl skill, i think the table missing the severity. Can you tell the model to add
> it?"

The agent made three edits — the Step 3 table column, plus Agent 1 and Agent 2B reporting
instructions — and wrote them to the **mirror** at `~/.claude/skills/review-impl/SKILL.md`,
never to the canonical `~/.agents/skills/`.

**2026-08-09 05:44, session `9f66db0e`:** a different session edited the canonical file for an
unrelated reason and ran `publish-skill.mjs publish global … --force`. The publish reported:

> `claude-code: replace divergent mirror (/Users/pt/.claude/skills/review-impl)`

That divergent mirror *was* the severity change. It was overwritten roughly 14 hours after it
was written.

**Verified at the time of this audit:** all three copies — canonical `~/.agents/`, and the
`~/.claude/` and `~/.cat-code/` mirrors — are byte-identical (`md5 b0c40d43…`) and contain
**zero** occurrences of "sever".

**The effect is measurable in the finding corpus.** Severity labels appear in 11 of 11 findings
for session `f9b104ec` and throughout `1ba97aa9` — the two reviews that ran during the ~14-hour
window the change was live — and in only 2 of the 15 reviews after the republish.

This is a textbook instance of the failure mode the skill-publisher architecture exists to
prevent: **edit the canonical source, publish, verify — never edit a mirror.**

---

## 2. Escapes — defects that survived a review pass

Two user-visible escapes are firmly established, two more are same-class recurrences in
adjacent code, one is latent but real.

| Complaint | When | Area | Inside a reviewed diff? | Could the review have caught it? |
|---|---|---|---|---|
| "i didnt change anything but now the donut gauge when clicked look like this now" + screenshot showing `Context 71% · 262k / 372k` with only `Skills 2.6k` and `Free 318k` | 2026-08-04 18:54, **3h45m after its own review** | Context breakdown popover; root cause in `analyzeContext.ts:countTokensWithFallback` | Yes for the display contract; **no for the failing callee** | **Yes — and it nearly did.** See below |
| "So i telling you that it not passed" (rejecting GUI acceptance on a screenshot showing `Main thread 0s`) | 2026-08-08 18:17, **22 min after its review table** | `leaseState.ts` / `TasksDialog.tsx`; root cause `synthesizeMainLease` | The asserting surface was; the synthesising function was not | **It did catch it, then discarded it.** See below |
| "the model name, effort, mode, fast mode, selected account, context token is missing when that session is disconnected" | 2026-08-08 18:35 | Transcript run-facts / cached session preview | Adjacent, not inside — a *different writer* than the one reviewed | Partly. Fixed 19 min later by `e2fc6054` |
| (internal) core policy dropped in bare mode | 2026-08-09 | `prompts.ts` `CLAUDE_CODE_SIMPLE` branch | **Same function, different branch** than the one fixed 07-30 | Yes, trivially, by enumerating the mode matrix. `39f34c5e` had to extend the review's own test helper |
| (internal) popover header and legend rows read two different snapshots | 2026-08-09, `7b64f855` | `ComposerActionsBar.tsx` + `contextBreakdownState.ts` | **Yes**, both in the reviewed diff | Yes. The review found an adjacent basis mismatch but not this one |

### Escape 1 — the review wrote down the cause and filed it under the wrong heading

At 15:25:43 the review's own validation text said:

> "Confirmed the sharp edge: `getAnthropicClient` re-derives the provider from the model
> string, so on a `gpt-*` session `countTokens` takes the Codex path, **fails**, and falls
> through to real Haiku sampling."

It filed that as finding #3 under **Performance** — *"~10 count_tokens calls … VALID —
bounded; design decision open"* — and never asked the Correctness question: what does the panel
render when those counts return null? The user hit it 3h45m later. The fix commit `5ad863a0`
opens:

> "Reported: the popover listed only 'Skills 2.6k' and 'Free 318k' beside a header reading
> '71% · 262k / 372k'. Three contradictory numbers."

### Escape 2 — the review found it and waved it off as pre-existing

Review Agent 1, at 17:36:58, in its own *not-a-finding* list:

> "`held` reading `0s` for a synthesised main lease: real, but it comes from the engine
> re-minting `createdAt` at snapshot time (`codexAccountLeaseManager.ts:427-432`) and
> **predates this diff**."

The session's own words at 18:20, after the user rejected the GUI acceptance:

> "I had this finding in review and waved it off as pre-existing; that was wrong, because the
> panel asserting it is new and mine."

### The structural pattern

Both hard escapes sat **one hop outside the diff, on the callee side.** The skill tells Agent 1
to *"Review only the task-scoped diff and the touched files"*, and Agent 2B's blast-radius lens
looks at **callers** of the new code. Nothing looks at whether what the new code **calls**
actually works in this app's runtime configuration.

### Ruled out as escapes

The Accounts usage-analytics complaint (2026-08-15) — that code arrived via `fa3531c4`, never
reviewed. "Agent 'Wilkes' stuck above the composer" (2026-08-08) — `OrchestratorRoster.tsx`,
not in any reviewed diff. The subagent lease-account complaints (2026-08-20/21) — `bd29c3ff`
was never review-impl'd. The renderer OOM line — none of its commits went through this skill.

---

## 3. Reverted or wrong fixes

**Zero review-driven fixes were git-reverted.** Seven distinctive symbols introduced by review
fixes were sampled — `STRANDED_KEY`, `isBreakdownTrustworthy`, `NON_LEASE_SELECTION_KINDS`,
`cacheHasCurrentRunFacts`, `runFactsVersion`, `projectContextBreakdown`, `ProjectableLease` —
and **all survive at HEAD**.

Four cases of rework or wrongness, none of them a revert:

1. **The severity-column loss** — section 1 above.
2. **`30ce2b8f perf(app): make the context breakdown attach-scoped`** was the review's own
   Performance remediation, reworked 39 minutes later by `57dc5fa6` after the agent conceded
   *"That's a real downgrade from what I showed you earlier"* and the user replied *"I dont
   really understand but i just want a real implementation."* The rework also reversed a
   documented design decision recorded in `ca5e8835`.
3. **A fix's blast-radius claim was wrong and changed model behaviour.** `5ad863a0` asserted
   *"countTokensWithFallback is private to that file, so the blast radius is /context and this
   popover."* The session's **second** review pass proved that false — `e1a49e94`:
   *"countTokensWithFallback's null is a load-bearing sentinel: toolSearch.ts:141 reads a 0 as
   'token API unavailable' … Returning an estimate from the shared helper suppressed that
   sentinel and changed when tool search auto-enables, **which is model behaviour, not
   display**."*
4. **Two review-driven fixes shipped dead.** In `3d21ec77`, round 2 found round 1's work
   inert: *"The recall correction never reaches the user … **My fix from last round is dead
   code**"* and *"**The retained FIFO doesn't fix its bug.** One submit produces ≥3 `settled`
   signals — I measured `["settled","settled","settled"]`."* Round 1 also introduced a new
   `TS2305` in an owned file. All caught only because a second round ran.

Also ruled out: `43ca5a19` → `31b468ec` is not review-driven; it was reverted 6 minutes later
because the reported crash was in a different repository.

---

## 4. Recurring defect shapes, and what prevents them

Seven shapes recur across 7 to 14 separate sessions each. **Exactly one has ever received an
automated guard, and that guard is partial.** This half of the analysis needs no counterfactual,
which makes it the more robust half.

| Shape | Sessions | Prevention |
|---|---|---|
| **A comment, docstring, or ledger row asserts something the code does not do** | ≥14 of 30 | **None.** `bun run lint` enables zero rules — all 19 custom rules are `createNoopRule()` stubs. `3d21ec77` recorded the compounding case: a commit propagated a pre-existing error into fresh prose with a wrong `file:line`, which then *"misled the next reviewer inside this very review"* |
| **Shipped code that never runs; a fix that is inert** | 12+ | None. `48a3d62b` found a case where the *guard against this* is itself inert: a `never` tripwire killed by `case undefined:` under `strictNullChecks:false` |
| **A test that cannot fail** | 10+ | None automated — no mutation testing. Examples: *"3 of 4 new tests don't fail on revert"*, *"two tests that can no longer fail"*, *"asserts a test-local array lacks a string the author never wrote"* |
| **A failure silently degraded to a valid-looking value** | 10 | None. CLAUDE.md §7's "inbound fail closed / display degrade gracefully" rule is the convention this violates, unenforced |
| **Two surfaces disagree about one fact** | 7 | None. *"Two contradictory numbers on one screen"*, *"card and finish row disagree"*, *"'2 messages' for one message"* |
| **Raw ids / engineering nouns / a11y gaps on user-visible surfaces (§7)** | 14 | **Partial, and the gap is known.** `userVisibleText.test.ts` enforces the "no engineering notes" half repo-wide, but judges a string's *shape*, not its content; the em-dash half has no check |
| **A literal NUL byte written into a TypeScript source** — makes git treat the file as binary and makes `rg` skip it during traversal | 3 occurrences: `3f359ce` (07-28), `183276f5` (07-30), `f9b104ec` (08-08) | **Module-local, three times.** Each fix added a test that reads *its own module* and asserts no NUL. Verified at audit time: 5 such per-module tests exist and **no repo-wide sweep**. Zero NUL bytes in tracked TS sources today, but nothing prevents the fourth |

The NUL case is worth dwelling on: its first occurrence *"has already produced two wrong 'no
call sites, therefore dead code' conclusions."* It recurred 2 days later, then 9 days after
that, in a different area each time, because every fix guarded one module.

---

## 5. Verdict from this lane

**Not eagerly enough — but the miss is in scoping, not appetite.** The review does not need to
look at more things. It needs to stop discarding what it already found.

- **Volume and precision are healthy.** 291 VALID (76%), 36 FALSE POSITIVE (9.4%). Every false
  positive was killed by the main agent's Step-3 validation before any code changed, so
  over-firing costs turns, not correctness. One session reported *"Zero false positives across
  both reviewers."*
- **Almost nothing had to be undone.** Zero git reverts; all seven sampled fix symbols survive.
- **Both hard escapes were seen by the review and filed away.** Neither was a coverage gap.
  Both were **verdict errors**, and the skill's vocabulary caused them: Step 3 offers only
  VALID / FALSE POSITIVE / DEFERRED, with *"Everything else should be VALID."* There is no
  verdict for *"real, user-visible, asserted by my new surface, but rooted outside my diff"* —
  so both got dropped rather than escalated.
- **Nothing in the skill checks effect.** Every step is static reading. From the `62445105`
  session's own report: *"I shipped this whole path on server-rendered evidence and never once
  ran it. You asked for a real implementation and I gave you one that typechecks and passes
  2578 tests without a single execution of the actual feature."* The review ran on that same
  evidence base and inherited the same blindness.
- **Where a second round ran, it paid immediately.** Four sessions ran two rounds; three of the
  four found a defect in round 1's own fixes. That is the sharpest single argument against
  "too strict."

### Two levers, in order of value

1. **Give Step 3 a fourth verdict** for *the defect my new surface now asserts, whose mechanism
   lives outside my diff.* That one change would have caught both escapes.
2. **Restore the severity column to the canonical `~/.agents/skills/review-impl/SKILL.md` and
   republish** — the only tuning request made in the whole window was applied to a mirror and
   overwritten the next morning.

### Where this lane is thin

30 reviews over four weeks with two user-visible escapes is a small sample, and the
counterfactual is unmeasurable — there is no way to count the defects that did *not* escape
because the pass ran. The recurring-shape data in section 4 is the sturdier half, because it
requires no counterfactual.
