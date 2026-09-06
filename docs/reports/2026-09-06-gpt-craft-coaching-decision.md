# The GPT craft-coaching slice: one decision, three shapes

> **The decision itself now lives in
> [the instruction-stack decision report](2026-09-06-instruction-stack-decisions.md),
> §5a**, alongside the other open decisions, so there is one place to decide from.
> This file is kept for the detail that does not belong there: every sentence with
> its verdict and character count (§4), the Codex binary segmentation (§3), and the
> worked rewrite behind option C (§2). Where the two differ, the decision report is
> current.

**Date:** 2026-09-06
**Status:** Decision needed. Nothing applied.
**Scope:** `src/constants/promptStyles/gpt.ts` only. No Claude-path file, no tool
description, no `app/` file.

This report exists to be decided from. Everything else here is evidence for the
one table in section 2.

Read [the instruction-stack decision report](2026-09-06-instruction-stack-decisions.md)
first if you have not; this is a follow-on to its section 2, which measured the
category but proposed nothing that meaningfully touched it.

---

## 1. Why this slice exists

The decision report measured our base prompts against two comparators and found a
single clear outlier:

| | Cat Code (GPT) | Codex `gpt-6-astra` | Claude Code |
|---|---:|---:|---:|
| How to do the work | **6,692** | 2,642 | 2,019 |

Two and a half times either comparator. That number was named as the outlier and
then never worked. Nothing that has landed or is planned moves more than roughly
370 characters of it.

**The category is not one thing, and that is why it was never worked.** It holds
two kinds of text with opposite trends:

- **Craft coaching** teaches a model how to write good code: avoid unneeded
  complexity, do not over-abstract, do not add defensive error handling. Both
  vendors have retired this.
- **Autonomy and stopping rules** tell a model when to act without asking and when
  to stop investigating. Both vendors are actively growing this.

Nobody separated the two, so the category was judged as a whole and left alone.
This report covers only the craft half, which is **1,481 characters** across five
labelled sections of `gpt.ts`.

The three largest blocks in the category, `PROACTIVE EXECUTION` (754),
`EXPLORE RULE` (602) and `INVESTIGATION DISCIPLINE` (558), are the autonomy half
and are **out of scope here**. Section 5 explains why cutting them would be a
mistake.

## 2. The decision

| Option | Shape | What it does | Chars | Rests on |
|---|---|---|---:|---|
| **A. Redundancy only** | cut | Removes text that restates its own neighbours, plus one sentence that instructs nothing | **266** | Our own text. No vendor needed |
| **B. Redundancy plus the Codex-aligned craft cuts** | cut | Everything in A, plus the craft sentences current Codex has dropped | **1,099** | Codex's judgment for the GPT path |
| **C. Rewrite the slice tighter** | tweak | Keeps every idea, states each once. Not yet drafted; estimated 500 to 700 | est. | Nothing. No vendor needed |

Option B is 4.5% of the 24,680-character GPT prompt, and about 74% of this slice.

Option A is available whatever you decide about vendors. **Option B is a bet**:
that the vendor who trains the model we run is the right authority on what that
model still needs told, against a vendor who still ships every one of these
sentences.

**Option C, added 2026-09-06, avoids that bet entirely.** The two vendors disagree
about whether these ideas are worth stating. They do not disagree about whether an
idea should be stated twice. A rewrite keeps what Anthropic kept and removes only
the repetition neither would defend, so it needs no ruling about who is right.

Worked example, illustrative and not the proposed final text. `ERROR HANDLING`
today, 411 characters:

> Do not add error handling, fallbacks, or validation for scenarios that cannot
> happen inside internal code paths. Trust internal code and framework guarantees.
> At system boundaries (user input, external APIs, file I/O, network calls) —
> validate and handle errors. These are real failure points. The rule is: no
> defensive code for hypothetical internal failures; yes to error handling at real
> external boundaries.

The same instruction, roughly 160 characters:

> Validate and handle errors at system boundaries: user input, external APIs, file
> I/O, network calls. Inside internal code paths, trust your own code and the
> framework.

Nothing is dropped. The rule is stated once instead of three times, positively
instead of as a prohibition followed by its exception followed by a summary of
both. **Option C's number is an estimate until the other four sections are drafted
the same way**, which is why the table above does not give it a firm figure.

Options A and B keep every sentence in section 4 marked **Keep**. Option C keeps
every idea in the slice, including the ones A and B cut.

## 3. The evidence

### Current Codex has no craft section at all

**Verified-measurement, 2026-09-06.** The installed binary at
`~/.codex/packages/standalone/current/bin/codex` (221 MB, reached through
`~/.local/bin/codex`) carries nine templates, located by their `You are Codex`
openings. Segmenting on those boundaries and searching each span for the legacy
coding-guideline block, `Fix the problem at the root cause`:

| Template opening | Span | Carries the craft guidelines |
|---|---:|---|
| `You are Codex, an OpenAI general-purpose agentic assistant…` | ~955 KB | yes |
| `You are Codex, a coding agent based on GPT-5…` | 16,672 | no |
| `You are Codex, an agent based on GPT-5…` (three templates) | ~21,000 each | no |
| `You are Codex, a coding agent based on GPT-5…` (three more) | 20,492 to 43,259 | one of three |
| final template | ~40,000 | no |

Seven of nine, including every modern `based on GPT-5` coding template, have
dropped it. The block survives in the general-purpose assistant prompt and one
older template.

**Verified-measurement.** Keyword counts inside one current template (bytes
169,294,289 to 169,314,781): `scope` 0, `abstraction` 0, `error handling` 0,
`ambiguous` 0, `root cause` 0, `complexity` 1, `minimal` 1.

**Verified-text.** That template's section headings are
`## Editing constraints`, `## Special user requests`, `## Autonomy and
persistence`, `## Frontend tasks`, `## Formatting rules`, `## Final answer
instructions`, `## Intermediary updates`, `## Values`, `## Tone & User
Experience`, `## Escalation`, `## Interaction Style`. Its execution budget goes to
tool mechanics, autonomy, and communication. Not to craft.

This confirms the decision report's section 1 claim, which had not been checked
against the shipped binary: elementary coaching is what OpenAI retired.

### Claude Code kept all five

**Verified-measurement**, both literal tables, across the 2.1.87 fork-point bundle
and all nineteen builds in `~/.local/share/claude/versions/`: `methodName`,
`snake case`, `highly capable`, `premature abstraction` and the error-handling
sentences are present in every build. Upstream's own wording, current:

> Don't add features, refactor, or introduce abstractions beyond what the task
> requires. A bug fix doesn't need surrounding cleanup; a one-shot operation
> doesn't need a helper. Don't design for hypothetical future requirements. Three
> similar lines is better than a premature abstraction. No half-finished
> implementations either.

**So the two vendors disagree, completely, on all five sections.** That is the
whole difficulty, and section 5 is why it does not have to be resolved.

## 4. The five sections, with verdicts

Character counts are of the exact strings proposed for removal.

### CAPABILITY, 126 chars

> `You are highly capable and can handle ambitious tasks.` **Cut, 55.** It
> instructs nothing; no action changes if it is absent. Neither vendor's structure
> depends on it. This is the one cut in the report that needs no argument at all.

> `Defer to the user's judgment on whether a task is too large to attempt.`
> **Keep.** A real deferral rule.

### TASK DOMAIN, 336 chars

> `You handle software engineering tasks — bugs, new functionality, refactoring,
> explanation, and more.` **Cut, 101** (option B). Tells a coding agent that it
> does coding.

> `When an instruction is ambiguous, interpret it in the context of software
> engineering and the current working directory.` **Keep.** The working-directory
> clause is real disambiguation context.

> `Example: "change methodName to snake case" means find and modify the method in
> code, not just reply "method_name".` **Cut, 115** (option B). Teaches a frontier
> model that editing means editing. Note for the record: the earlier subtraction
> report called this "absent from all three comparators". That is wrong. Claude
> Code ships it verbatim today. Only Codex lacks it.

### ABSTRACTION, 256 chars

> `The right complexity level is exactly what the task requires.` **Cut, 62**
> (option A). `SCOPE` already says to do only what was asked.

> `Do not create helpers, utilities, or abstractions for one-time operations. Do
> not design for hypothetical future requirements. Three similar lines of code is
> better than a premature abstraction.` **Cut, 194** (option B only). This is the
> sharpest vendor split in the report: Codex dropped it, Claude Code keeps it word
> for word, and an earlier review of this plan specifically restored the
> three-lines maxim after arguing it governs a case nothing else covers. Cutting
> it overrules that review as well as Anthropic.

### SCOPE, 352 chars

> `Do not quietly narrow or transform the requested scope.` **Keep.** An obedience
> rule, not craft.

> `Do not add features, refactor, or "improve" beyond what was asked. Bug fixes do
> not need surrounding cleanup. Simple features do not need extra
> configurability.` **Cut, 161** (option B only).

> `Do not add docstrings, comments, or type annotations to code you did not change.
> Add comments only where the logic is not self-evident.` **Keep under both
> options.** This is the one place current Codex explicitly agrees with us. Its
> Editing constraints say: "You add succinct code comments only where the code is
> not self-explanatory… You use that tool sparingly." Do not cut this while citing
> Codex; Codex kept it.

### ERROR HANDLING, 411 chars

> `These are real failure points. The rule is: no defensive code for hypothetical
> internal failures; yes to error handling at real external boundaries.`
> **Cut, 149** (option A). Restates the two sentences immediately before it.

> `Do not add error handling, fallbacks, or validation for scenarios that cannot
> happen inside internal code paths. Trust internal code and framework guarantees.
> At system boundaries (user input, external APIs, file I/O, network calls) —
> validate and handle errors.` **Cut, 262** (option B only). Codex has nothing on
> error handling. Claude Code has a close twin.

### Totals

| Tier | Items | Chars |
|---|---|---:|
| A. Redundancy and flattery | CAPABILITY 55, ABSTRACTION 62, ERROR HANDLING 149 | **266** |
| B. Codex-aligned craft | TASK DOMAIN 115 + 101, SCOPE 161, ABSTRACTION 194, ERROR HANDLING 262 | **833** |
| A + B | | **1,099** |

## 5. Why the vendor disagreement does not have to be resolved

All 1,481 characters live in `src/constants/promptStyles/gpt.ts`, which only GPT
sessions ever read. The Claude path has its own file, `src/constants/prompts.ts`,
untouched by every option here.

So the disagreement resolves by routing rather than by argument: GPT sessions
follow the vendor that trains the model they run, Claude sessions follow theirs.
That is what provider-keyed prompt styles are for, and `gpt.ts` exists precisely
to hold this kind of divergence. This fork runs mostly on Codex models, so the GPT
path is also the one that matters in practice.

**The limit on that reasoning, stated so it is not overrun.** Borrowing Codex's
judgment about what to *omit* is safe because omission carries no API semantics.
Borrowing Codex's *wording* is not automatically safe: the tool-description audit's
standing rule is that its API semantics must match before its text is copied, and
that its authorization policy must not be imported merely because it targets GPT.
Nothing in this report copies Codex text. Every option here only deletes.

**Why the autonomy half stays.** `PROACTIVE EXECUTION`, `INVESTIGATION
DISCIPLINE` and `EXPLORE RULE` look like coaching and are not treated as such by
either vendor. Codex's current template devotes a whole section to
`## Autonomy and persistence`. Claude Code added four fragments of exactly this
kind between 2.1.87 and 2.1.239, present in zero builds at the fork point and four
now: "re-litigate a decision the user has already made", "give a recommendation,
not an exhaustive survey", "When you have enough information to act, act",
"narrate options you will not pursue". A model being stronger does not tell it
when you want it to stop. Cutting this half would be the expensive mistake this
report is meant to prevent.

## 6. What this does not establish

**No ablation was run.** Nothing here shows a model performs better with less of
this text. What is shown is that a sentence restates its neighbour, instructs
nothing, or has been retired by the vendor that trains the model. That is the
whole basis for acting, and it is the same basis the decision report used.

**Vendor omission is not proof of harm.** Codex dropping a sentence is evidence
about OpenAI's judgment, not a measurement of our sessions. Claude Code keeping
the same sentence is equally real evidence pointing the other way. Option B picks
a side; it does not settle the question.

**Counts are string presence.** A literal in a binary is not proof of a selected
live branch, and template segmentation by `You are Codex` openings is inference
from structure, not from OpenAI's build manifest.

**The measurement that would settle it** is the one still undone across all this
work: run a fixed task set against the current prompt and against one cut group at
a time, on the models actually in use, and compare scope errors, unnecessary tool
calls, and output quality. It costs model quota, which is why nobody has run it.

## 7. If you choose one

Either option is a single-file edit with no new text, verified by:

```
bun run build:dev:full
bun test src/constants/prompts.test.ts
```

plus a before-and-after character count of the emitted GPT prompt, recorded as
description rather than as a success measure. Option B should land as its own
commit, separate from option A, so the vendor-dependent half can be reverted
without disturbing the half that needs no vendor.

## 8. Where this sits

- [Instruction-stack decision report](2026-09-06-instruction-stack-decisions.md)
  — the entry point for all of this work, and the source of the table in section 1.
  Read it first.
- [Apply plan](../plans/2026-09-06-instruction-stack-apply-plan.md) — the
  implementable before-and-after text for the rest of the programme, including its
  provenance table showing which items are fork drift. Items A3 and A4 there
  overlap this slice: A3 is the TASK DOMAIN and CAPABILITY cuts, A4 the two
  restatements. **If this report is adopted, it supersedes A3 and A4**, which were
  scoped before the craft-versus-autonomy split existed.
- [Subtraction report](2026-09-06-instruction-stack-subtraction.md) — the first
  pass. Its S5, S6, T5 and T6 nominate execution coaching in the transcript
  cookbook and the agent prompts, which are separate surfaces from this one and
  are not counted in the 6,692.
- [Comparative decisions](2026-09-06-instruction-stack-comparative-decisions.md)
  — the outward pass. It is the pass that should have caught this and did not: it
  names Claude Code as a comparator but cites it in three of thirteen sections and
  never opens a version binary.
- [Tool-description audit](2026-09-06-tool-description-comparative-audit.md) — the
  tool surface, which is larger than the system prompt and is unaffected by
  everything here. Source of the borrow-semantics-not-words rule in section 5.
- [Prompt surfaces router](../prompts/2026-04-30-prompt-surfaces.md) — which file
  owns which prompt. Open it before searching for any prompt text.
