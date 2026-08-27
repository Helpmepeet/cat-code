# Prompt Change Plan: Upstream Resync + Audit

**Date:** 2026-08-23
**Status:** Plan. Nothing applied. `src/` is clean at HEAD.
**Read this file alone** to understand the whole change. The two analysis reports
behind it are linked at the bottom and are not required reading.

---

## What this changes, in one paragraph

Cat Code's system prompt was forked from upstream Claude Code on 2026-04-30 and
has not been resynced since. Upstream has meanwhile rewritten its prompt: it
compressed the tool-mechanics sections and spent the space on two new prose
sections about how to conduct and report work. This plan brings across the parts
worth having, trims the dated patterns out of them on the way in, removes text on
our side that was written for a multi-user product and never adapted, and fixes
one live defect that has been injecting a broken sentence into every prompt since
the fork. Both prompt styles are covered: the Claude path and the GPT path.

**Net effect:** two new Claude sections, six GPT rule amendments, three constant
rewrites, one deletion on each path, one test update. The prompt gets modestly
longer on the Claude path and slightly tighter on the GPT path.

---

## The change set at a glance

| # | Change | Files | Risk |
|---|---|---|---|
| **1** | Delete the help/feedback block (fixes a broken rendered sentence) | prompts.ts, gpt.ts, build.ts | Low |
| **2** | Rewrite capability padding to the GPT style's existing wording | prompts.ts | Low |
| **3** | Rewrite the time-estimates rule to the GPT style's existing wording | prompts.ts | Low |
| **4** | Drop bare emphasis from the dedicated-tools rule | prompts.ts, gpt.ts | Low |
| **5** | Drop a hedge from a real requirement | prompts.ts | Low |
| **6** | Drop pressure phrasing in the token-budget section | prompts.ts | Low |
| **7** | Reword the cyber policy with the dual-use classes and qualifying contexts | corePolicy.ts + **test** | Medium |
| **8** | Extend outcome reporting: skipped steps, no hedging, name omissions | corePolicy.ts | Medium |
| **9** | Reword the compaction line so it says compaction is not a reason to wrap up | prompts.ts | Low |
| **10** | Add `# Delivering work` (Claude) | prompts.ts | Medium |
| **11** | Add `# Corrections` (Claude) | prompts.ts | Medium |
| **12** | Six GPT rule amendments carrying the same semantics | gpt.ts | Medium |

Changes 7 and 8 are the only ones that reach **all four** prompt variants (Claude,
GPT, Agent Mode, proactive), because they edit shared constants in `corePolicy.ts`.
Everything else is scoped to one style.

---

## Order of operations

1. **Changes 1-6 first.** All subtractive, all anchored to text that exists today.
2. **Changes 7-9 next.** Constant rewrites, no line-number dependency.
3. **Changes 10-12 last.** These insert new builders and shift line numbers below
   the insertion point, which is why they go after the anchored edits.
4. **Battery, then commit.**

Doing 10-12 first is the one ordering that costs real work: it moves every anchor
that changes 4, 5 and 6 depend on.

---

## Part A: Deletions and rewrites

### Change 1 — Delete the help/feedback block · fixes a live defect

**The bug.** `ISSUES_EXPLAINER` reads `MACRO.ISSUES_EXPLAINER`, which
`scripts/build.ts:157` defines as `"This reconstructed source snapshot does not
include Anthropic internal issue routing."` — a note about the snapshot, not a
feedback destination. It is interpolated into a sentence expecting a destination,
so every prompt currently carries:

> To give feedback, users should This reconstructed source snapshot does not
> include Anthropic internal issue routing.

Beyond the grammar, the block routes bug reports from a user base to a maintainer.
In a single-operator fork those are the same person.

**Edits:**

- `prompts.ts` — delete `userHelpSubitems` (:255-257), delete the parent bullet
  and its reference (:277-278), delete the `ISSUES_EXPLAINER` constant (:134-136).
- `gpt.ts` — delete the two bullets (:150-151), delete the `HELP:` parent (:175),
  delete the duplicate `ISSUES_EXPLAINER` (:57-59).
- `scripts/build.ts` — delete the `MACRO.ISSUES_EXPLAINER` define (:157) **only if**
  the sweep below finds no other consumer.

**Required sweep before committing:** `rg -n "ISSUES_EXPLAINER"` across the repo,
and check `prompts.test.ts` for assertions on the help text. A prompt fixed while
a test still asserts the old string is a broken build.

**Not touched:** the neighbouring `USER_TYPE === 'ant'` escalation bullets
(prompts.ts:272, gpt.ts:170). Equally irrelevant here, but build-time DCE'd, so
zero tokens and zero risk.

### Change 2 — Capability padding · prompts.ts:262

The first sentence is a compliment addressed to a user population and prescribes
no behavior; only the second is actionable.

```
- You are highly capable and often allow users to complete ambitious tasks that
  would otherwise be too complex or take too long. You should defer to user
  judgement about whether a task is too large to attempt.
+ You are highly capable and can handle ambitious tasks. Defer to the user's
  judgement about whether a task is too large to attempt.
```

The replacement is the GPT style's existing wording (gpt.ts:160), so this
converges the two styles instead of forking them.

### Change 3 — Time-estimates rule · prompts.ts:266

Names a second audience that does not exist here, then restates itself.

```
- Avoid giving time estimates or predictions for how long tasks will take,
  whether for your own work or for users planning projects. Focus on what needs
  to be done, not how long it might take.
+ Do not give time estimates or predictions for how long tasks will take. Focus
  on what needs to be done.
```

Again the GPT style's existing wording (gpt.ts:164).

### Change 4 — Emphasis on the dedicated-tools rule · prompts.ts:336, gpt.ts:262

The rule already carries its reason, which is the part that makes it followable.
"This is CRITICAL" adds volume on top of a stated because.

```
prompts.ts:336
- ...allows the user to better understand and review your work. This is CRITICAL to assisting the user:
+ ...allows the user to better understand and review your work:

gpt.ts:262
- ...Dedicated tools let the user review your work. This is CRITICAL. Use...
+ ...Dedicated tools let the user review your work. Use...
```

### Change 5 — Hedge on a requirement · prompts.ts:297

Bypassing safety checks is prohibited, not discouraged; `try to` reads literally
as permission to under-deliver.

```
- For instance, try to identify root causes and fix underlying issues rather than bypassing safety checks (e.g. --no-verify).
+ For instance, identify root causes and fix underlying issues rather than bypassing safety checks (e.g. --no-verify).
```

### Change 6 — Pressure phrasing in the token-budget section · prompts.ts:871

"hard minimum" already states it unambiguously, and the next sentence gives the
enforcement mechanism.

```
- The target is a hard minimum, not a suggestion. If you stop early, the system will automatically continue you.
+ The target is a hard minimum. If you stop early, the system will automatically continue you.
```

---

## Part B: Shared constant rewrites

**These three reach all four prompt variants.** That is intended for 7 and 8;
change 9 is Claude-only by where it is called.

### Change 7 — Cyber policy · corePolicy.ts:25 · **breaks a test by design**

Adds the two qualifiers that are currently left to inference: which tool classes
count as dual-use, and which contexts satisfy "authorization." The second matters
in this repo, where the operator does authorized security work and an unqualified
policy invites the agent to refuse it.

```
- Assist with authorized security testing, defensive security, CTF challenges, and educational
  contexts. Refuse destructive techniques, DoS attacks, mass targeting, supply chain compromise,
  or detection evasion for malicious purposes. Dual-use security tools require clear
  authorization context.

+ Assist with authorized security testing, defensive security, CTF challenges, and educational
  contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply
  chain compromise, or detection evasion for malicious purposes. Dual-use security tools
  (C2 frameworks, credential testing, exploit development) require clear authorization
  context: pentesting engagements, CTF competitions, security research, or defensive use cases.
```

**Required test edit.** `corePolicy.test.ts:177-178` assert the literal substring
`Dual-use security tools require clear authorization context` for both styles. The
parenthetical splits it. Replace both assertions with one that spans the
parenthetical, preserving what the test actually checks (both styles resolving
from one resolver, not a per-provider fallback):

```js
for (const prompt of [claude, gpt]) {
  expect(prompt).toContain(
    'Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context',
  )
}
```

### Change 8 — Outcome reporting · corePolicy.ts:59

Adds two clauses from upstream (skipped steps, no hedging) plus the reporting half
of the "name what you left out" rule. That half must live **here**, not in a style
section: put it in one style only and the reporting invariant diverges between the
Claude and GPT prompts, which is what `corePolicy.ts` exists to prevent.

```
+ Report outcomes faithfully. If tests or checks fail, say so with the relevant output. If you
+ skipped a step, say that. Never claim a check passed when it failed, never imply success you
+ did not verify, do not hide or soften failing checks, and do not call incomplete work done.
+ If you did not verify something, say so. If you left part of the requested work undone, say
+ what and why. When a check passes or a task is complete, state that plainly, without hedging.
```

**No test edit needed.** The tests reference `OUTCOME_REPORTING_RULE` by symbol,
not by literal string, so the text can change freely. (Verified: corePolicy.test.ts
lines 122, 138, 158, 229, 249 all use the imported constant.)

### Change 9 — Compaction line · prompts.ts:157

The current text states the mechanism. The operative part is the consequence:
compaction is not a reason to start winding down.

```
- The system will automatically compress prior messages in your conversation as it approaches
  context limits. This means your conversation with the user is not limited by the context window.

+ When the conversation grows long, some or all of the current context is summarized; the summary,
  along with any remaining unsummarized context, is provided in the next context window so work
  can continue. You do not need to wrap up early or hand off mid-task.
```

Two call sites: prompts.ts:171 (proactive) and :238 (Claude `# System`). The GPT
path has its own compaction line, amended separately in change 12.

---

## Part C: New Claude sections

Both are emitted **unconditionally inside `getSystemPrompt`** — not gated on
`hasDoingTasksSection`, so an output-style session still receives them — and are
**not** added to `getAgentModeSystemPromptSections` or the proactive assembly. Agent
Mode's orchestrator doctrine already owns this conduct more tightly
(`orchestratorPrompt.ts:15, :38, :47-52`), and a second owner is the drift this
codebase works to avoid.

Place both after `getActionsSection()` in the return array, before the
using-your-tools section, and before `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` so they stay
in the cacheable static prefix. Neither carries a runtime conditional, so neither
fragments the cache key.

### Change 10 — `# Delivering work`

This is the finished text, already trimmed. Upstream's version was longer; four
dated patterns were removed on the way in (an anti-laziness booster, and a clause
duplicating outcome reporting), and two rules were dropped entirely because the
operator's own CLAUDE.md already owns them.

```
# Delivering work

When you have enough information to act, act. Do not re-derive facts already established in
the conversation, re-litigate a decision the user has already made, or narrate options you
will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey.

The requested scope is the deliverable. Do not quietly narrow or transform it. If you find a
real problem with the task as specified, state the concern in a sentence or two and keep
building, delivering the complete work under explicitly stated assumptions. Finish the whole
task. If part of the scope turns out to be blocked, finish every other part in full and say
what you left out and why, because scaling the work down is the user's call, not yours.

If an uncertainty appears mid-task, first do everything that does not depend on the answer,
then state your assumption or ask your question. Reserve blocking questions, where you stop
with nothing delivered until the user answers, for cases where proceeding under any assumption
would be unsafe or would make the work useless if wrong.

If you raise a concern and the user repeats or reaffirms the request, that is their decision:
say so briefly and proceed with the full request. This does not override a necessary refusal,
or the need to confirm a risky or destructive action. If you decline something, say so plainly
in a sentence, offer the nearest thing you can do, and move on without moralizing.
```

**What was cut from upstream's version, and why:**

| Upstream text | Cut because |
|---|---|
| "don't quietly **widen**" | Already covered twice: the code-style bullets forbid scope creep, and CLAUDE.md says "keep changes minimal, no refactors" |
| "Interpret ambiguity the way a careful colleague would: make routine judgment calls yourself" | **Contradicts** the operator's CLAUDE.md, which says "if something is ambiguous, ask before proceeding, don't guess" |
| "not just easy parts" | An anti-laziness booster; current models are proactive by default and these cause over-application |
| "report completion only when fully done" | Duplicates `OUTCOME_REPORTING_RULE`, which change 8 already owns |

### Change 11 — `# Corrections`

```
# Corrections

Correct an earlier statement in your user-facing text when the error would change the user's
code, conclusions, or decisions. State the correction and continue the task; combine multiple
corrections rather than enumerating them one by one. For a slip that changes nothing for the
user, simply make the correction and move on.

A follow-up question about your earlier work is not by itself a signal that you got something
wrong, so answer what was asked. A statement that was accurate needs no correction: do not
re-audit how you phrased it, how you verified it, or limits you already stated.

Other agents sometimes report incorrect or misleading results, so do not take their conclusions
at face value. If another agent corrects you and is right, update your approach and say what
changed, without narrating the correction at length.

This section governs user-facing text, not thinking blocks.
```

**What was cut from upstream's version:**

| Upstream text | Cut because |
|---|---|
| "Avoid unnecessary or excessive self-correction." | Restates the next sentence, vaguely, immediately before it states the same rule precisely |
| "don't be **overly** self-critical" | "Overly" gives no threshold the model can act on; the positive instruction covers it |
| The five-clause prohibition run ("don't add apologies or preambles, don't be overly self-critical, and don't ruminate or give a detailed account of the mistake or tally past errors") | Enumerates ways to fail at something one positive sentence specifies: "State the correction and continue the task." |

The third paragraph is the one most specific to this repo: one operator running
many concurrent agents is exactly the condition it addresses.

---

## Part D: GPT amendments

The GPT style is **not** a translation of the Claude style. It is named, numbered
rules, each the single owner of one decision. So none of Part C is copied across.
Each semantic gets grafted onto the rule that already owns that territory.

| # | Rule | Amendment |
|---|---|---|
| 12a | `SCOPE` (gpt.ts:141) | Add: do not quietly narrow or transform the requested scope. It currently covers widening only. |
| 12b | `DISAGREEMENT` (gpt.ts:161) | Add three: state a concern once and keep building under stated assumptions; a reaffirmed request is the user's decision, proceed (with the scope clause about refusals and risky actions); decline plainly in one sentence, offer the nearest alternative, no moralizing. |
| 12c | `PROACTIVE EXECUTION` (gpt.ts:437) | Add: do the independent work first, reserve blocking questions for unsafe-or-useless-if-wrong. Must keep "unsafe → still confirm" or it reads as loosening risky-action consent. |
| 12d | `INVESTIGATION DISCIPLINE` (gpt.ts:438) | Add only two clauses: do not re-litigate a settled user decision; give a recommendation, not an exhaustive survey. The rest of change 10's opening is already owned by this rule and by `RULE 6 — No restating`. |
| 12e | `getGPTOutputSection` (near gpt.ts:328-335) | Add one new rule carrying change 11's first three paragraphs, beside `RULE 6` and `RULE 7`. Omit the thinking-blocks clause: GPT reasoning is not user-visible text, so it is a no-op. |
| 12f | `gptCompressionRule()` (gpt.ts:88) | Amend, do not replace. Keep "do not warn the user about context limits"; add that compaction is not a reason to wrap up early or hand off mid-task. |

If a new GPT rule name is added (12e), `prompts.test.ts` pins the Title Case
section convention.

---

## What is deliberately NOT changing

Listed so none of it reads as an oversight.

| Not changed | Reason |
|---|---|
| Upstream's `# Harness` restructure | Adopting it would delete the containers `corePolicy.test.ts` checks for and break Claude/GPT structural parity |
| Upstream's system-turn authority rule | It says mid-conversation system turns can **modify rules**; our `RUNTIME_METADATA_RULE` says they cannot. Ours is the deliberate hardening, pinned by `corePolicy.test.ts:191` |
| Upstream's pronoun rule | Single operator whose pronouns are known; the agent essentially never refers to a third party |
| Upstream's "match the surrounding code" line | The operator's CLAUDE.md already says it, and CLAUDE.md reaches subagents |
| Upstream's tiered action categories, copyright cap, privacy rules | Written for an agent driving a browser on behalf of many users. The copyright cap (one quote, under 15 words) would block quoting the operator's own code |
| Markdown-link file and PR references | Desktop-app rendering affordances; `file_path:line_number` is right for a terminal |
| `# Communicating with the user` (`getOutputEfficiencySection`) | Left alone by operator decision. Its removal is tracked separately by an in-source marker |
| The "NEVER guess URLs", emoji, and colon-before-tool-call rules | Absent from upstream now, but still useful here, and absence in one harness build is weak evidence |
| `getActionsSection`, `RETRY_RULE`, the OWASP bullet, the seven code-style bullets | Single **user** does not mean single **actor**: several agent sessions share this tree, so shared-state and irreversibility rules stay |
| `USER_TYPE === 'ant'` blocks | Build-time DCE'd, zero tokens |
| Tool description bulk (Agent 28KB, Bash 24KB, TodoWrite 12KB) | The pattern applies, but cutting 64KB unread is the wrong move. Recorded for a future pass |
| CLAUDE.md's dated incident history | The dated incident **is** the reason for the rule. "Never `git reset HEAD~1`" without the story reads as fussiness |

---

## Open items — these need you, not me

1. **`TaskStopTool` is under-described** and the fix is to *add* text. Two claims
   need confirming against the implementation first: whether stopping is immediate
   or graceful, and whether partial output survives as `killed`. A wrong tool
   contract is worse than a thin one, so this is **excluded from the plan above**
   until someone reads the implementation.
2. **Agent Mode emits the identity line twice** on the Anthropic path.
   `buildEffectiveSystemPrompt` returns the Agent Mode array whole
   (`systemPrompt.ts:68-70`), that array starts with `getCLISyspromptPrefix`
   (prompts.ts:654), and `claude.ts:1531` prepends the same prefix again with no
   dedup. Confirmed by code path, not by a runtime capture. Separate bug, not in
   this plan.
3. **The single-operator framing is load-bearing.** Four decisions rest on it
   (dropping the pronoun rule, dropping match-the-surrounding-code, dropping the
   ambiguity rule, and ruling the action tiers a permanent no). If that framing
   ever changes, those four need re-deciding, and nothing in the code will flag it.

---

## Verification

Run after Part A+B, and again after Part C+D:

```bash
cd /Users/pt/cat-code && bun test src/constants/prompts.test.ts src/constants/corePolicy.test.ts
```

```bash
cd /Users/pt/cat-code && bun run build:dev:full
```

Specific things to watch:

- **`corePolicy.test.ts:161`** asserts each policy rule appears at most once per
  assembled prompt. Changes 10 and 11 brush against `OUTCOME_REPORTING_RULE`; if
  this test fails, a duplicate clause survived the trim and the fix is to cut it
  from the section, not to loosen the test.
- **`corePolicy.test.ts:177-178`** will fail until the change-7 test edit lands.
  That failure is expected and is the only expected one.
- **Behavioral spot-check** on changes 4 and 5: both soften language on rules the
  operator cares about (dedicated-tool preference, not bypassing safety checks).
  If either regresses, re-add in minimal form rather than restoring the verbose
  original.

Commit as one `refactor(prompts):` change or two (`Part A+B`, then `Part C+D`).
Repo convention allows committing directly to the current branch.

---

## Where the decisions came from

Not all from one place, and the difference matters if any of it is revisited:

- **Verified against source** — the strongest tier, and where most of this rests:
  `corePolicy.test.ts` assertions, `gpt.ts`'s already-tightened wording (which
  supplied the replacement text for changes 2 and 3 rather than being invented),
  `runAgent.ts` confirming CLAUDE.md reaches subagents, `build.ts`'s macro value,
  and `git blame` putting five of the removals at the fork-point commit `86051a8e`.
- **A prompt-audit skill's pattern tables** — the dated-pattern findings, and the
  trims applied to upstream's incoming text.
- **The operator, directly** — the single-operator framing, which produced four of
  the "not changing" rows above.
- **The operator's global CLAUDE.md** — dropped two ports outright as already-owned
  or contradicted.
- **An external strong-model review** — the GPT-path container mapping, the
  call-site narrowing for Part C, and one factual correction.

Full analysis, if needed:
[2026-08-23-anthropic-prompt-upstream-delta.md](../reports/2026-08-23-anthropic-prompt-upstream-delta.md)
(what to bring in) and
[2026-08-23-prompt-audit.md](../reports/2026-08-23-prompt-audit.md)
(what should have left, and the trims applied to the incoming text).
