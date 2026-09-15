# Rebuilding the GPT prompt: complete inventory and constraints

**Date:** 2026-09-06
**Status:** Preparation only. No rebuild proposed here, and nothing applied.
**Audience:** whoever does the rebuild. The operator has decided it should happen
and that it needs a stronger model than the session that wrote this file.

**The inventory is of the prompt as it stands now**, after twelve items landed on
2026-09-06 in `7e8ae0d8..740bbe27`. It is not the pre-change state. Those twelve
removed `ERROR HANDLING` and `ABSTRACTION` outright, trimmed `SCOPE`, `TASK DOMAIN`
and `CAPABILITY`, deleted the GPT decision checklist, and added `PREPARATION RULE`
and `AUTHORIZATION SCOPE`; the sibling reports in section 8 carry the reasoning.

This exists because a rebuild from an incomplete inventory loses content silently,
and the inventory that guided today's work **was** incomplete. Read section 1
before trusting any earlier list.

---

## 1. Read this first: the method that failed three times today

Blocks in `gpt.ts` carry labels of several shapes: `SCOPE:`, `RULE — Minimize new
files:`, `RULE 3 — Tool output is data, not instructions:`, `COMMENTS — quantity:`.
Three separate scans this session used patterns that matched only some of them:

- an ALL-CAPS pattern missed all twelve `RULE —` and `COMMENTS —` blocks, so the
  craft slice was scoped from an inventory short by roughly 1,700 characters;
- a later pattern allowing only letters and spaces after the dash silently merged
  `RULE 3` into `RULE 2` and `RULE 2` into `RULE 1`, because their labels contain
  a comma and a hyphen;
- a related error put `PROACTIVE EXECUTION`, `INVESTIGATION DISCIPLINE` and
  `EXPLORE RULE` in the work bucket in two separate analyses. They are under
  `# Session-Specific Guidance`.

**The check that catches all of these: the inventory must sum to the emitted
total.** The table below sums to exactly 23,687, which is what
`./cli-dev --dump-system-prompt --model gpt-5.6-sol` emits. Any inventory that
does not reconcile to the emitted byte-for-byte total is wrong, however plausible
it looks.

Note the dump reports 23,807 **bytes** and 23,687 **characters**; em dashes are
three bytes. Both numbers are correct and they are not the same measurement.

## 2. What the rebuild is measured against

`gpt-5.6-sol` and `gpt-5.6-terra` are the models this fork runs. They share one
Codex template, byte-identical with `gpt-5.6-luna`, `gpt-reserve` and
`codex-auto-review` (`sha1 a27cb90a…`, 17,730 chars), from
`~/.codex/models_cache.json`. **Do not use `gpt-6-astra` as the comparator** — no
session here receives it, and three claims in the sibling reports were wrong
because they came from astra or from `gpt-5.4` in the installed binary.

| Bucket | Cat Code | Codex 5.6 |
|---|---:|---:|
| How to do the work | 5,556 | 1,922 |
| How to talk to the user | 4,300 | 6,949 |
| Permission and care | 2,753 | 3,974 |

**We are larger in one bucket of three**, and smaller in two. Copying Codex's
volume would grow talk and permission.

Codex 5.6's sections, for structural reference: `# Personality` 864,
`## Writing style` 518, `## Technical communication` 699, `# Working with the user`
1,459, `## Intermediate commentary` 1,345, `## Final answer` 208,
`### Formatting rules` 866, `### Visualizations` 990,
`# Rules for getting work done` 1,103, `## File editing constraints` 819,
`## Autonomy and persistence` 2,693, `# Destructive actions` 1,281,
`# Using skills` 188, `### How to use skills` 4,538.

Each of those sections has one job. Ours does not: `# Doing Tasks` holds fourteen
unrelated blocks, and autonomy lives under `# Session-Specific Guidance`. That
disorder produced two of the three errors in section 1.

## 2a. What the rebuild is and is not

**The composition machinery already exists**, inherited with the fork.
`gpt.ts` is ten section-builder functions — `getGPTIntroSection`,
`getGPTSystemSection`, `getGPTDoingTasksSection(enabledTools)`,
`getGPTUsingToolsSection(enabledTools)`, `getGPTActionsSection`,
`getGPTToneAndStyleSection`, `getGPTOutputSection`,
`getGPTSessionGuidanceSection`, plus separate agent-mode variants — with 17
conditional insertion points, sections parameterised by the enabled tool set, and
feature flags for fork, skill search and repl mode. Shared core, tool-conditional
policy, mode variants and runtime context all already compose. Verified by reading
the file; no claim is made here about whether it should change.

**What drifted is where the lines sit.** This fork inherited Claude Code's module
boundaries and then poured GPT-specific content into them without redrawing any of
them. `# Doing Tasks` became a junk drawer holding fourteen unrelated blocks, from
`DISAGREEMENT` to `RULE — Security` to both `COMMENTS —` rules. Autonomy —
`PROACTIVE EXECUTION`, `INVESTIGATION DISCIPLINE`, `EXPLORE RULE` — ended up under
`# Session-Specific Guidance`, which is not what that section is for and is why two
analyses in this session put them in the wrong bucket.

**One lead, judge it for yourself:** the errors in section 1 were all
misattributions of a block to the wrong section or the wrong label shape, and every
one of them would have been visible under a layout where each section has a single
job. That is an observation about how this file's own mistakes happened, not a
recommendation about what the new boundaries should be.

## 2b. The model layer, and what is known about it

Our model-specific layer is **0%**. `isGPTPromptStyle` is `provider === 'openai'`
and nothing in prompt assembly keys on a model. Three facts bear on whether to add
one.

**Neither vendor does much of it in the client.** Codex pushes model variation
entirely to the backend catalog — the client receives whatever
`instructions_template` comes down, so its "per-model prompts" are not client
architecture at all. Upstream Claude Code carries `isOpus` six times in 2.1.239 and
nothing comparable for the other families; whether those gate prompt text or
capability was not determined here. Published guidance puts the model-specific
share at 0 to 10 percent, and the evidence suggests the low end.

**There is no observation behind it.** Nobody has seen `gpt-5.6-sol` behave
differently from `-terra` in a way a prompt should fix, and the ablation that could
show it was deliberately skipped.

**Codex differentiates at the generation, not the model.** sol, terra, luna,
`gpt-reserve` and `codex-auto-review` receive the byte-identical template; the
distinct ones are 5.4-mini, 5.5, the 5.6 family, and astra. In this repo luna is
the cheap model for migration test turns, so its difference from sol is cost.

## 2c. OpenAI's published guidance for this family, read fresh

Source: `https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6`,
"GPT-5.6 Sol Prompting Guidance", fetched 2026-09-07. This repo first read it on
2026-07-11 (F3 in `2026-07-11-gpt-instruction-stack-audit.md`) and has quoted it
from that reading ever since without going back. The current page carries two
sections the July note never captured, quoted in full below, and one of them
contradicts the shape of the rebuild.

**The layout it recommends.** Thirteen sections, of which this is the skeleton:

> Role: [the model's function and context]
> Personality: [tone and collaboration style]
> Goal: [user-visible outcome]
> Success criteria: [what must be true before the final answer]
> Constraints: [policy, safety, business, evidence, and side-effect limits]
> Tools: [which tools to use, when, and what not to use]
> Output: [sections, length, format, and tone]
> Stop rules: [when to retry, fallback, abstain, ask, or stop]

with "Add detail only where it changes behavior." Every slot there has one job,
which is the same property section 2 found in Codex 5.6 and found missing in ours.
Two of the eight slots have no counterpart in our prompt at all: we state no
success criteria and no stop rules.

**The migration workflow it recommends, and the conflict.** Five ordered steps:

> 1. Switch the model and preserve the current reasoning effort.
> 2. Run representative evals before changing the prompt.
> 3. Remove obsolete scaffolding, repeated instructions, and irrelevant tools.
> 4. Add only the smallest targeted instruction that fixes a measured regression.
> 5. Re-run evals after each prompt or reasoning change.

It warns against rewriting a whole prompt stack at once, because that makes it
impossible to tell whether "a behavior change came from the model, reasoning
setting, prompt, tool set, or runtime," and prescribes debugging from real traces
followed by surgical edits.

**Steps 2 and 5 are unavailable here.** This repo has no eval harness: no
`src/evals` or `scripts/evals`, and the only script matching `eval` is
`scripts/bridge-claude-subscription.test.ts`, which is unrelated. Section 7
already records that no ablation was ever run. So a rebuild cannot satisfy the
workflow it is citing, and cannot detect a regression it causes. That is not an
argument against rebuilding. It is the reason the rebuild's own claims stay
structural, exactly as section 7 states them, and it puts a floor under how much
confidence any before/after comparison can carry.

**Register.** Absolute language is reserved, not default:

> Use ALWAYS, NEVER, must, and only for true invariants such as safety rules,
> required fields, or actions that should never happen.

> For judgment calls, such as when to search, ask, use a tool, or keep iterating,
> prefer decision rules.

**Contradiction costs more than omission.**

> GPT-5-class models follow prompt contracts closely, so conflicting rules can
> create more instability than missing detail.

Each rule stated once, and specifically: repeating approval instructions "can
cause unnecessary approval requests for safe, expected actions." Our permission
material is stated in more than one place, which is the exact failure named.

**Subtraction has a measured payoff, in their evals not ours.**

> In a sample of internal coding-agent eval runs, configurations with leaner
> system prompts improved evaluation scores by roughly 10–15% while reducing total
> tokens by 41–66%.

Remove: repeated statements, style instructions that do not change behavior,
examples that do not change behavior, process instructions for reliable behaviors,
unrelated tools. Keep: user-visible outcomes, success criteria, stopping
conditions, safety and business constraints, output shape requirements. Avoid
blanket language rules such as "always respond in the user's language," and
"universal defaults, keyword maps, and broad semantic shortcuts."

**Their autonomy policy, which we should compare against ours rather than adopt
blind:**

> For requests to answer, explain, review, diagnose, or plan, inspect the relevant
> materials and report the result. Do not implement changes unless the request also
> asks for them. For requests to change, build, or fix, make the requested in-scope
> local changes and run relevant non-destructive validation without asking first.
> Require confirmation for external writes, destructive actions, purchases, or a
> material expansion of scope.

**Stopping** is framed as a budget with a correctness override: resolve in the
fewest useful tool loops, but never let loop minimization outrank correctness,
required evidence, calculations or citations.

**Preambles.** A short visible preamble before the first tool call, then sparse
outcome-based updates at major phase changes, each stating one concrete outcome
and the next step. Do not ask the model to narrate routine tool calls.

**Verbosity.** 5.6 "tends to be more concise by default than GPT-5.5," so broad
brevity instructions carried over from an older model may now be dead weight;
check each one. Prefer naming what must be preserved and what may be omitted over
a blanket "be concise."

**Reasoning effort.** Before raising it, audit the prompt for missing success
criteria, dependency rules, tool-routing rules or verification loops. High effort
only where evals show a gain; max is not a global recommendation.

## 3. Constraints, all from operator rulings this session

- **The prompt must stand alone.** What a loaded instruction file happens to
  contain must not shape it. `CLAUDE.md` is user configuration that can change,
  move, or be absent. Do not justify keeping or cutting anything by what it says.
- **Follow Codex on execution guidance**, meaning the 5.6 template. Its work
  sections are pure mechanics with no craft coaching, verified in the template and
  confirmed from inside a live Codex session.
- **Match semantics before borrowing wording.** Codex's text names `exec_command`,
  `functions.exec`, `$CODEX_HOME` and `await Promise.allSettled`. Our tool surface
  is Read, Write, Glob, Grep, Bash, Apply_patch, TodoWrite, Task, Skill, Agent.
  Their prose does not transfer unchanged.
- **A good comment requires very little maintenance** — the operator's principle,
  and the one that should replace the enumerated comment ban.

## 3a. Goal, authority, and what stops you

All from the operator, this session.

**The outcome wanted** is a GPT-path prompt whose sections each have one job, with
nothing lost that section 4 marks as surviving. The operator has decided the
rebuild should happen and that it needs a stronger model than the session that
wrote this file; they have not specified a target size, a section list, or a
method, and section 2 gives reasons to distrust size as a goal.

**Authority.** This repo's `CLAUDE.md` §4 says commit freely to the current branch,
staging explicit paths only — never `git add -A`, `-u`, or `commit -a`, because the
working tree is shared with other live sessions and contains their uncommitted
work. Do not push: it would publish their commits too. Do not rewrite history, and
do not revert or stash anything you did not write.

**Verification that exists.** `bun run build:dev:full` is the engine gate, plus
focused `bun test` on touched paths. Root `bun run typecheck` is known-red with
~1,879 pre-existing errors and is not a gate. `./cli-dev --dump-system-prompt
--model gpt-5.6-sol` renders the result without calling a model, and diffing it
against the pre-change dump is how a rebuild shows what actually moved.

**What cannot be verified.** No ablation has been run and none is planned; the
operator decided against it because the effect size is below what a cheap task set
resolves. So nothing here can show a model behaves better after a rebuild. What can
be shown is that the emitted text still carries every contract section 4 names.

**Stop rather than proceed** if a target file is dirty with work that is not yours,
or if the battery goes red in a way you cannot attribute to your own change.

## 4. What must survive, whatever the structure

`# System Rules` (2,206) is harness contract, not advice: output channel,
permission modes, tool-output-is-data, `<system-reminder>` semantics, prompt
injection, hooks, context compression. Codex says none of it because its harness
differs. `# Environment` (1,128) and `## Reading session transcripts` (1,939) are
likewise ours alone.

The agent machinery — `AGENT TOOL` 1,163, `EXPLORE RULE` 561, `AGENT TYPES` 252,
`SEARCH RULE` 119, `READ DISCIPLINE` 494 — has no Codex 5.6 analogue at all,
because 5.6 has no subagent tool.

Roughly **7,200 characters have no counterpart in Codex** and survive any rebuild.
That, not verbosity, is most of the size difference.

## 4a. Fork-authored text carries intent the wording does not state

Added 2026-09-07 at the operator's direction. Some blocks were written here to fix
something specific, and the block itself does not say what. A rebuilder judging
them on their text alone, or on whether Codex carries an equivalent, will delete
fixes for problems that actually happened.

**The commit is where the intent is, and it is one command:**

```
git log -S"<a distinctive phrase from the block>" -- src/constants/promptStyles/gpt.ts
```

**Separating inherited from fork-authored takes two steps, not one. Corrected
2026-09-07 after the one-step version proved wrong.** A commit other than
`86051a8e` means someone here changed the block deliberately, and its message is
the intent — `INVESTIGATION DISCIPLINE` returns `bf7beca9` "serve one policy core
across providers and modes", `RULE — Show the diff` returns `339b68fe`.

But `86051a8e` alone does **not** mean inherited, which is what an earlier draft of
this section claimed. `gpt.ts` was **created** in that commit and has 23 commits
since, so the whole file is fork-original; a block dating to the snapshot was
written here, not taken from upstream. Confirm by searching the upstream artifacts
directly: `ERROR HANDLING:`, `ABSTRACTION:`, `DECISION CHECKLIST` and
`TASK DOMAIN:` are **zero** in both the 2.1.87 SDK bundle and 2.1.239, so they were
authored for the GPT path, which upstream has no equivalent of. `DISAGREEMENT` and
`RULE — Outcome reporting` also date to the snapshot; whether either has an
upstream counterpart was not checked.

**The snapshot commit explains nothing.** Its message is "Initial private publish
snapshot". So for any block introduced there, intent is not recoverable from git,
and the text plus the tests are the only evidence left.

**What that one commit contains, as a worked example.** `339b68fe` is
"fix(prompts): hybrid Apply_patch rule for the GPT path", and its body says the
mutation rule was **modelled on OpenAI's gpt-5.6 text**, that the diff rule was
added alongside it, that it fixed the Bash prompt naming `Edit` on a path where the
registry ships `Apply_patch`, and that it shipped with regression tests for the GPT
wording, the provider-resolved tool name, and no leakage into the Claude branch.

So `RULE — Show the diff` reads, on its face, like a candidate under section 5's
criteria: Codex 5.6 has no equivalent. Its commit says it was written *from* the
5.6 template, to close a named defect, with tests. Those are different facts about
the same block, and only one of them is in the prompt.

**Tests may hold the intent too.** `339b68fe` added regression tests for its
wording. A block whose phrasing is asserted under `src/**/*.test.ts` was
deliberate, and changing it fails loudly rather than silently.

**Applied retroactively to what was already cut, 2026-09-07.** Every block removed
by the craft slice and A1 — `ERROR HANDLING`, `ABSTRACTION`, `DECISION CHECKLIST`,
the snake-case example, the capability sentence — was introduced at `86051a8e`,
never touched by any of the 23 later commits, and **never asserted by any test in
the repository's history**. So none of them carried a recorded intent, and the
applied work destroyed no documented fix. That is a weak provenance rather than a
clean bill: it means nobody ever wrote down why they were there.

## 5. What made a block a candidate, and one session's floor

**The criteria, so they apply to blocks nobody here has judged.** A block was
treated as a candidate for removal when it met one of these, and as a keep
otherwise:

- it restates something else already in the same request — another block, or a
  tool's own description, since 42,328 characters of tool schemas ride alongside
  the prompt;
- it is craft coaching, meaning advice about writing good code rather than a fact
  about our tools or harness, **and** the 5.6 template carries no counterpart;
- it says once what an adjacent block already said, so it can be stated once
  instead of removed.

And treated as a keep regardless of what Codex carries: harness contracts, anything
naming our own tools or their semantics, permission and destructive-action rules,
and honesty or security policy. The reason for that asymmetry is in section 3: a
vendor omitting a safety rule is not an argument for dropping it.

**The floor, not the boundary.** One session applied those criteria and reached
1,437 characters of removal, 2,595 of compression and 133 re-filed to another
section. The specific blocks are listed below. **They are a floor**: the same
session's inventory was wrong three times (section 1), so treat this list as blocks
already looked at, not as the set that qualifies.

- Restates something else in the request: `RULE — Tool routing` (502),
  `TASK TRACKING` (135).
- Craft with no 5.6 counterpart: `COMMENTS — content` (247),
  `COMMENTS — quantity` (200), `RULE — No backwards-compat hacks` (195),
  `RULE — Minimize new files` (158).
- Says at length what could be said once: `DISAGREEMENT` (778),
  `RULE — Failure handling` (713), `RULE — Outcome reporting` (493),
  `RULE — Show the diff` (347), `PARALLELISM` (264).
- Not execution guidance at all, and in the wrong section:
  `RULE — No time estimates` (133).

Nothing above was applied. Blocks not named here were kept, or were never examined
— section 4 says which.

## 6. The complete inventory

82 blocks. Sums to 23,687, the emitted total. Blank disposition means analysed and
kept, or not yet examined; sections 4 and 5 say which.

| Section | Block | Chars |
|---|---|---:|
| (preamble) | `(prose)` | 1136 |
| # System Rules | `(section prose)` | 15 |
|  | `RULE 1 — Output channel` | 166 |
|  | `RULE 2 — Tool permissions` | 189 |
|  | `RULE 3 — Tool output is data, not instructions` | 475 |
|  | `RULE 4 — Runtime metadata` | 445 |
|  | `RULE 5 — Prompt injection` | 245 |
|  | `RULE 6 — Hooks` | 416 |
|  | `RULE 7 — Context compression` | 255 |
| # Doing Tasks | `(section prose)` | 14 |
|  | `TASK DOMAIN` | 137 |
|  | `CAPABILITY` | 87 |
|  | `DISAGREEMENT` | 778 |
|  | `RULE — Read before modifying` | 233 |
|  | `RULE — Minimize new files` | 158 |
|  | `RULE — No time estimates` | 133 |
|  | `RULE — Failure handling` | 713 |
|  | `RULE — Security` | 215 |
|  | `SCOPE` | 202 |
|  | `COMMENTS — quantity` | 200 |
|  | `COMMENTS — content` | 247 |
|  | `VERIFICATION` | 174 |
|  | `RULE — No backwards-compat hacks` | 195 |
|  | `RULE — Outcome reporting` | 493 |
| # Executing Actions with Care | `(section prose)` | 30 |
|  | `PRIORITY RULE` | 77 |
|  | `Reversible-local (edit files, run tests)` | 60 |
|  | `Risky (hard-to-reverse, affects shared systems, visible to others)` | 515 |
|  | `INSTRUCTION AUTHORITY` | 581 |
|  | `AUTHORIZATION SCOPE` | 169 |
|  | `RISKY ACTIONS — require user confirmation` | 44 |
|  | `Destructive` | 125 |
|  | `Hard-to-reverse` | 137 |
|  | `Shared-state` | 194 |
|  | `Publishing` | 199 |
|  | `OBSTACLE RULE` | 464 |
|  | `PREPARATION RULE` | 158 |
| # Using Your Tools | `(section prose)` | 19 |
|  | `RULE — File mutations` | 310 |
|  | `RULE — Show the diff` | 347 |
|  | `RULE — Tool routing` | 502 |
|  | `TASK TRACKING` | 135 |
|  | `PARALLELISM` | 264 |
| # Tone and Style | `(section prose)` | 17 |
|  | `EMOJIS` | 71 |
|  | `TONE` | 127 |
|  | `CODE REFERENCES` | 147 |
|  | `GITHUB REFERENCES` | 171 |
|  | `TOOL CALL FRAMING` | 167 |
|  | `COPYABLE TEXT` | 236 |
| # Communicating with the User | `(section prose)` | 30 |
|  | `OUTPUT CONTRACT — apply to all user-facing text` | 50 |
|  | `RULE 1 — Audience awareness` | 353 |
|  | `RULE 2 — Cold-read clarity` | 369 |
|  | `RULE 3 — Prose quality` | 408 |
|  | `RULE 4 — Brevity` | 381 |
|  | `RULE 5 — Scope` | 109 |
|  | `RULE 6 — No restating` | 349 |
|  | `RULE 7 — Corrections` | 858 |
|  | `RULE 8 — Closed endings` | 457 |
| # Session-Specific Guidance | `(section prose)` | 28 |
|  | `DENIED TOOL` | 102 |
|  | `PROACTIVE EXECUTION` | 779 |
|  | `INVESTIGATION DISCIPLINE` | 588 |
|  | `READ DISCIPLINE` | 494 |
|  | `AGENT TOOL` | 1163 |
|  | `SEARCH RULE` | 119 |
|  | `EXPLORE RULE` | 561 |
|  | `AGENT TYPES` | 252 |
|  | `SKILLS` | 295 |
|  | `HANDOFF PROMPTS` | 288 |
| # Environment | `(section prose)` | 14 |
|  | `You have been invoked in the following environment` | 53 |
|  | `Primary working directory` | 49 |
|  | `Is a git repository` | 30 |
|  | `Platform` | 20 |
|  | `Shell` | 14 |
|  | `OS Version` | 948 |
| ## Reading session transcripts | `(section prose)` | 444 |
|  | `Paths` | 656 |
|  | `Examples for querying an individual transcript` | 482 |
|  | `The subagent sidecar .meta.json contains` | 357 |

## 7. Loose ends the rebuild inherits

- **The comment rules were kept on evidence that does not exist.** `COMMENTS —
  quantity`, `COMMENTS — content` and the comment sentences inside `SCOPE` survive
  because an earlier session claimed Codex agrees with us, quoting the `gpt-5.4`
  template. Neither astra nor 5.6 has any code-comment rule.
- **B2's support was astra-only.** `PREPARATION RULE` was applied because astra
  states it almost verbatim; the 5.6 template returns zero for every phrase in it.
  It is applied and defensible on its own merits, but not on Codex's authority.
- **D4 is unresolved and lives in another session's file.** The Agent tool's result
  tells the parent to end its turn while its description permits continuing. Never
  observed at runtime.
- **No ablation was run**, deliberately. Nothing here shows a model behaves better
  with less text. Every claim is that a sentence contradicts our code, repeats
  itself, restates a tool description, or has no counterpart in the template our
  models receive.

## 8. Related

- [Decision report](2026-09-06-instruction-stack-decisions.md) — what was decided
  and why; the entry point for all of this work.
- [Apply plan](../plans/2026-09-06-instruction-stack-apply-plan.md) — the
  before/after text of the twelve items applied today.
- [Craft-coaching decision](2026-09-06-gpt-craft-coaching-decision.md) — per-
  sentence verdicts for the five sections cut from the work bucket.
- [GPT-5.6 Sol Prompting Guidance](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6)
  — the vendor standard quoted in section 2c; re-read it rather than trusting a
  quote, it has changed since 2026-07-11.
