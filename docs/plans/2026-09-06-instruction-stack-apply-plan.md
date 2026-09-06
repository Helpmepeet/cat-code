# Instruction-stack apply plan

> **Superseded for conclusions.** Read [../reports/2026-09-06-instruction-stack-decisions.md](../reports/2026-09-06-instruction-stack-decisions.md) for where this work landed. This file is kept as the evidence record; some of its conclusions were later reversed.

**Date:** 2026-09-06
**Status:** Partly applied. **A2, A5, B4 and D3 landed in `0b177104`** as one
commit, being the four the provenance scan showed to be fork drift. Everything
else is still proposed and awaiting the operator's approval, per item.
**Inputs:** [subtraction report](../reports/2026-09-06-instruction-stack-subtraction.md)
(`169f4e29`) and [comparative report](../reports/2026-09-06-instruction-stack-comparative-decisions.md)
(`27a9da10`, `59a152e7`).

Every "before" string below was read from source at HEAD on 2026-09-06. All target
files were clean at planning time, so no other session was mid-edit in them; that
must be re-checked immediately before applying.

**How to approve.** The items below are written as Part A (removals), Part B
(additions) and Part C (one `CLAUDE.md` clause), but that split describes the edit,
not the reason. Group by reason instead, because the risk differs:

| Group | Why | Items | What approving it costs you |
| --- | --- | --- | --- |
| **1. The instruction is wrong** | Our text contradicts our own code or policy | A2, A6a, B1, B4, D3 | Nothing. These are defects; they need no thesis about model strength |
| **1b. Live and untested** | An instruction that forces an agent spawn, on the default path, with no coverage | A7 | Investigation only; it gates how A2 is judged |
| **2. Pure simplification** | The same rule, said once instead of twice | A1, A3, A4, A5, A6b | Nothing behavioral is claimed. This is the original brief |
| **3. Adopted from Codex** | Nothing of ours is wrong; we would import their judgment | B2, B3 | The only real bet on the table |
| **4. Already applied, needs reconciling** | The rule landed before this plan; it now bans a comment the repo relies on | C1 | A choice between two rules, not an edit |

One item splits across groups: A6a is the false active-state claim (group 1),
A6b its eight narrated scenarios (group 2). B4 no longer splits. It was an
unfollowable absolute in group 1 plus a Codex-informed replacement in group 3;
the provenance measurement below showed the absolute is inherited and that
upstream has already replaced it, so the whole item is group 1 and its
replacement text is lifted rather than composed.

Groups 1 and 2 stand without the shrink thesis, which is the claim the comparator
work did not support. Group 3 is the only place another vendor's judgment
outranks ours. The groups are independent, and individual items can be dropped
without affecting the others.

**What cannot be promised.** No ablation has been run. Applying this changes the
text and can be shown not to break the build or drop a named contract. It cannot
be shown to improve model behavior. Both source reports say the behavioral benefit
is suspected.

## Provenance: which items are fork drift, and which are ours

Measured 2026-09-06, after the items below were written. None of the three source
passes did this: the comparative pass names Claude Code as a comparator but
mentions it eight times against Codex's eighteen, in three of thirteen sections,
never for the AgentTool item, and never opens a version binary at all.

**Method.** Twenty strings counted in the fork-point bundle
`node_modules/@anthropic-ai/claude-agent-sdk/cli.js` (`VERSION:"2.1.87"`) and in
all nineteen builds in `~/.local/share/claude/versions/`, 2.1.214 to 2.1.239,
across both the UTF-8 and the UTF-16LE literal tables. **Long exact strings
produce false zeros when upstream reworded slightly: A3b and A4k both read as
deleted on the first pass and are not.** Every zero was re-probed with three short
fragments before being recorded as absent. Counts are string presence, not proof
of a selected live branch.

| Item | Cat's text came from | Upstream today | Reading |
|---|---|---|---|
| A2 | inherited | deleted, 0/19 | drift, catching up |
| A5 | inherited | all four examples deleted, prose instead | drift, catching up |
| B4 | inherited | removed after 2.1.215 | drift, catching up |
| D3 | inherited | replaced, 0/19 old and 4/19 new | drift, caught up in Part D |
| A3a | inherited | still shipped, verbatim, 19/19 | not drift |
| A3b | inherited, already shortened here | still shipped, both sentences | not drift |
| A6a | inherited | still shipped, verbatim, both claims | not drift, shared defect |
| A6b | inherited | still shipped, 19/19 | not drift |
| D2 | inherited | still shipped, verbatim | not drift, shared defect |
| A1 | ours | never present | ours to judge |
| A4a | ours | upstream carries the two preceding sentences, never the restatement | ours, and supported |
| A4b | ours | never present | ours to judge |
| B1 | ours | never present | ours to judge |
| D4 | ours | never present | ours to judge |

**Three consequences for items as written.**

- **A5 was planned smaller than the evidence supports, and has been widened.** It
  kept the namespaced example because that syntax is product-specific. Upstream
  deleted all four and states the syntax in prose instead: `` `skill`: exact name
  from the listing, no leading slash. Plugin skills use `plugin:skill` ``. A5 now
  removes all four and states the syntax, in both branches.
- **B4 need not invent wording, and no longer does.** Upstream's replacement is
  the relevance test B4 asks for, and is now lifted the way D3's was.
- **A4's review reversal is independently confirmed.** The maxim it restored,
  `Three similar lines is better than a premature abstraction`, is in all
  nineteen upstream builds.

**One caution this adds.** Five items are not drift, and A6a and D2 are defects we
share with upstream rather than defects we introduced. Fixing them puts this fork
ahead of upstream rather than level with it, which is a coherent choice but cannot
borrow upstream's judgment as support. For A6a specifically, "the stated invariant
is impossible" is verified against **our** implementation clearing the list;
upstream's runtime was not executed and its behavior is unknown here.

**Decided 2026-09-06, by the operator:** A5 is widened to upstream's all-four
deletion and B4 lifts upstream's wording.

**Applied 2026-09-06 in `0b177104`:** the four drift items, A2, A5, B4 and D3, as
one commit, on the reasoning that they carry the least of our own judgment and the
most external support. Evidence in that commit message. The remaining items are
untouched, and each now rests on our own argument alone.

**One stale reference this surfaced, reported and not fixed.**
`src/components/agents/generateAgent.ts:61-68` carries the same instruction A2 just
deleted, in the prompt that helps a user author an agent definition: "Context: The
user is creating a test-runner agent that should be called after a logical chunk of
code is written", then "Since a significant piece of code was written, use the
Agent tool to launch the test-runner agent to run the tests". It is a different
surface, reached only through agent creation rather than injected every session, so
it is outside A2 as specified and was left alone.

---

## Part A — deletions and corrections (no new instruction text)

### A1. Delete the GPT decision checklist

**File:** `src/constants/promptStyles/gpt.ts`, end of `getGPTActionsSection()`.

**Remove:**

```
DECISION CHECKLIST before any action:
1. Is this reversible and local? → proceed.
2. Is this risky or destructive? → confirm with user.
3. Does prior authorization cover this exact scope, from a live user instruction or loaded durable instructions? → only then.
4. Am I about to bypass a safety mechanism? → stop, diagnose the root cause instead.
```

**Add:** nothing. The section ends after `OBSTACLE RULE`.

**What still states each of the four decisions, verified in the same section:**
items 1 and 2 by `PRIORITY RULE` and the `RISKY ACTIONS` list; item 3 by
`INSTRUCTION AUTHORITY` plus "unless the user or loaded durable instructions have
authorized that exact scope"; item 4 by `OBSTACLE RULE` ("do not bypass safety
checks").

**Risk:** none identified. This is same-request duplication.

### A2. Delete the AgentTool prime-number example

**File:** `src/tools/AgentTool/prompt.ts`.

**Remove:** the whole `currentExamples` constant — the `test-runner` agent
description, the `isPrime` function, and the commentary line "Since a significant
piece of code was written and the task was completed, now use the test-runner
agent to run the tests".

**Change the append** from `${forkEnabled ? forkExamples : currentExamples}` to
emit `forkExamples` only when `forkEnabled`, and nothing otherwise.

**What stays:** the live agent roster, selection criteria, fresh-context
requirement, asynchronous lifecycle rules, and `forkExamples` on the fork path.

**Why:** it contradicts our own position that having written code is not itself a
reason to delegate, and it invents an agent that does not exist.

**Provenance, measured 2026-09-06. This text is inherited, and upstream has
already deleted it.** `git blame` puts the whole `currentExamples` body in
`86051a8e`, the initial private publish snapshot, so no line of it is our work.
The fork-point bundle `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`
(`VERSION:"2.1.87"`) carries `isPrime` once, `greeting-responder` five times and
`test-runner` fourteen times. Nineteen upstream builds in
`~/.local/share/claude/versions/`, 2.1.214 through 2.1.239, were scanned for both
the UTF-8 and the UTF-16LE literal tables: `isPrime`, `greeting-responder` and the
wrapper tag `example_agent_descriptions` return **zero hits in every one of them**.
Upstream removed the structure, not just the story. The only `test-runner` string
left in its agent description is the parallel-launch sentence, which we also carry
at `AgentTool/prompt.ts:420` and which this item does not touch. Our own
`greeting-responder` half was already deleted in `ba285305` after session
`13a6bfc5` (2026-09-04, `gpt-5.6-luna`) spawned a subagent for "Hi" and quoted the
example as its reason; see the peer-sessions instruction-surface audit, F11.

**Risk, revised down after that measurement.** The stated risk was that the
non-fork path ends up with no worked example at all. Upstream's current Agent
description has no worked example either, and has shipped that way across all
nineteen builds above; its mechanics live in prose bullets under `## Usage notes`.
So this is a return to upstream behavior rather than an untested cut. It remains
the largest behavior-shaped deletion in Part A and is still worth reverting alone
if unnecessary delegation rises.

**This supersedes one recommendation of our own.** The 2026-09-05 peer-sessions
audit deleted the greeting example and advised keeping this one, on the grounds
that "the test-runner example carries the mechanics alone". That was written
before the upstream comparison. Upstream's answer is that the mechanics do not
need an example.

### A3. Remove the snake-case example and the capability compliment

**GPT — `src/constants/promptStyles/gpt.ts`:**

`TASK DOMAIN` — remove the final sentence only:
`Example: "change methodName to snake case" means find and modify the method in code, not just reply "method_name".`

`CAPABILITY` — remove the first sentence only:
`You are highly capable and can handle ambitious tasks.`
Leaving: `Defer to the user's judgment on whether a task is too large to attempt.`

**Claude — `src/constants/prompts.ts`, `getSimpleDoingTasksSection()`:** the same
two removals against their longer twins ("For example, if the user asks you to
change "methodName" to snake case..." and "You are highly capable and can handle
ambitious tasks.").

**What stays:** the software-engineering domain statement, the working-directory
disambiguation instruction, and the user-authority clause about task size.

### A4. Remove two restated sentences (NARROWED after review)

**Was:** three removals including the three-lines maxim. **Now:** two, GPT path
only. An independent review argued the maxim is a distinct preference rather than
a restatement, and re-reading the rule confirms it.

**File:** `src/constants/promptStyles/gpt.ts`, `codeStyleRules`.

- From `ERROR HANDLING`, remove: `These are real failure points. The rule is: no defensive code for hypothetical internal failures; yes to error handling at real external boundaries.` It restates the two sentences before it.
- From `ABSTRACTION`, remove: `The right complexity level is exactly what the task requires.` `SCOPE` already says to do only what was asked.

**Now kept, reversing the earlier draft:** `Three similar lines of code is better
than a premature abstraction.` The surrounding clauses govern one-time operations
and hypothetical future requirements. The maxim governs the case where repetition
already exists, which is the only moment abstraction is actually tempting and the
one case nothing else in the rule covers. Removing it would leave the tempting
case unaddressed.

**Claude path: nothing to remove.** `prompts.ts` has no twin of the ERROR HANDLING
sentence, and its complexity sentence reads `no speculative abstractions, but no
half-finished implementations either` — a second constraint the GPT wording does
not carry. Cutting it would lose that. The earlier draft treated the two paths as
symmetric; they are not.

### A5. Replace the Skill invocation examples with the syntax statement

**Widened 2026-09-06 by the provenance measurement.** This item was "remove three
of four, keep the namespaced one, because that syntax is product-specific". All
four are inherited and upstream deleted all four; the namespace syntax survives
there as prose, inline, which is what made keeping an example look necessary.
Scope also widens from the GPT branch to both, because both carry the same four
lines and the Claude branch is the closer twin to the description upstream cut.

**File:** `src/tools/SkillTool/prompt.ts`, both branches.

**Remove** all four example invocations: the GPT branch's `2. Example
invocations:` item with its four sub-bullets, and the Claude branch's
`- Examples:` item with its four sub-bullets.

**Add** in place of the GPT branch's removed item:

```
2. Pass the skill name exactly as the listing gives it, with no leading slash. A namespaced skill keeps its prefix, as in `ms-office-suite:pdf`.
```

and the same sentence as a bullet under the Claude branch's `How to invoke:`.

**Why the syntax stays but the examples go:** the namespace form is the one thing
here a model cannot infer from the schema, which is why upstream keeps it too,
stated inline rather than demonstrated. The other three show a parameter shape the
schema already declares.

**What stays:** the invocation order, where the list lives, the no-reinjection
rule, and the built-in-command exclusion.

### A6. Correct TodoWrite's active-state claim and drop the scenarios

**Scope warning, verified:** `TodoWriteTool.isEnabled()` returns
`!isTodoV2Enabled()`, and `isTodoV2Enabled()` returns `!getIsNonInteractiveSession()`.
So this tool is disabled in every interactive session and reaches only
non-interactive `-p` runs. Nothing in A6 changes the desktop app or the REPL.

**Do not generalise that warning.** An earlier draft of this plan used it to
downgrade the verification-agent nudge as `-p`-only. That was wrong:
`TaskUpdateTool.ts` carries the same nudge for V2, which is the interactive path
(see A7). The scope limit applies to this prompt text, not to the nudge. Nor
should A6's "at most one" wording become a general Task-system invariant; V2 has
its own semantics.

**File:** `src/tools/TodoWriteTool/prompt.ts`.

Three statements contradict the implementation, which clears the list when every
item is complete:

- line 161: `Exactly ONE task must be in_progress at any time (not less, not more)`
- line 207: `Exactly ONE task must be \`in_progress\` at a time.`
- line 238 (`DESCRIPTION`): `Make sure that at least one task is in_progress at all times.`

**Change** the first two to "At most one task is `in_progress` at a time, and none
once every task is complete", and drop the `DESCRIPTION` sentence entirely.

**Also remove** the eight narrated use/non-use scenarios and the "demonstrate
thoroughness" / "demonstrates attentiveness" motivation, plus the GPT branch's
closing `DEFAULT BEHAVIOR` recap where it restates the trigger lists.

**What stays:** activation criteria, state transitions, `content` and `activeForm`,
immediate updates, truthful completion.

**Do not claim a GPT saving from the scenario removal:** `prompt.ts:231` already
selects a compact GPT variant, so that block is Claude-path text.

### A7. Audit the verification-agent nudge on both task paths

Not a text edit, and not yet a change: an investigation that must happen before or
alongside the rest, because it is live on the default interactive path.

**Verified:** both `TodoWriteTool.ts` (V1) and `TaskUpdateTool.ts` (V2) append an
instruction into their tool RESULT telling the model to spawn the verification
agent when a main-thread list of three or more tasks closes with no item matching
`/verif/i`, gated on `feature('VERIFICATION_AGENT')` and `tengu_hive_evidence`.
The V2 copy carries a comment stating it covers the interactive CLI, and
`tools.ts` includes `TaskUpdateTool` whenever V2 is enabled, which is whenever the
session is interactive.

**Verified:** no test in either tool's directory references the nudge or its
feature gate. A tool result that forces an agent spawn has no regression coverage
on either path.

**Why it belongs here:** A2 deletes the example that pushes toward delegation. If
this instruction remains, removing the example changes what the model reads while
leaving a stronger directive in place, and the two will be judged together as one
behavior change.

**What to determine, not to change:** whether this is an intentional workflow
requirement or an obsolete heuristic; whether its gates are live in the operator's
sessions; and what coverage it should carry. No edit is authorized by this item.

---

## Part B — additions

These four add instruction text. That runs against the original brief that
instruction should shrink, and each rests on inferred tension rather than measured
harm. They are listed so the choice is explicit; approving Part A alone is
coherent.

### B1. Allow the final answer to be self-contained

**File:** `gpt.ts`, `RULE 6 — No restating`.

**Current:** `Do not repeat conclusions or status you have already communicated to the user in this conversation. Each message should advance the task or add new information.`

**Proposed:** keep that, then add: `The final answer is the exception: make it self-contained, including the outcome, relevant verification, and anything unresolved, even when these appeared earlier.`

**Why:** as written, RULE 6 forbids the summary a user needs after a long tool
run. Codex's newest template requires a self-contained final answer outright.

**Boundary:** do not import Codex's stated reason (earlier commentary is collapsed
by its renderer) unless ours behaves that way.

### B2. Prepare before asking for approval

**File:** `gpt.ts`, `getGPTActionsSection()`, after `OBSTACLE RULE`.

**Add:** `Complete authorized preparation before requesting approval for the remaining gated action. Explain which action requires approval and why.`

**Why:** the section says when to stop but never that the work up to the gate
should be finished first, which invites stopping earlier than necessary.

**Retains:** every existing gate. This does not widen authorization.

### B3. Analysis is not authorization

**File:** `gpt.ts`, `getGPTActionsSection()`, not `# Doing Tasks`. A review
noted this is an authorization statement, and authorization is owned by the
Actions section; placing it beside `TASK DOMAIN` would split the scope rules
across two owners.

**Add:** `A request to inspect, explain, review, or diagnose does not by itself authorize implementation. Persistence means completing the authorized scope.`

**Why:** A3 removes the example that pushed toward action; this keeps the
intent-reading guidance from tipping the other way, and closes the opposite
failure of implementing during an analysis-only request.

### B4. Skill relevance instead of an absolute trigger

**Strengthened 2026-09-06: this is drift, and the replacement is upstream's.**
The absolute is inherited. Upstream removed it after 2.1.215 and put a relevance
test in its place, which is what this item was going to compose from scratch. Lift
it, as D3 does, instead of inventing wording. Scope widens to both branches: the
absolute appears in each.

**File:** `src/tools/SkillTool/prompt.ts`, both branches.

**Remove:** `NEVER mention a skill without actually calling this tool.`

**Replace** the blocking-requirement bullet with three, the first two adapted from
upstream's current description, the third carrying the review's discuss-versus-
request distinction that upstream leaves implicit:

```
- A skill the user names or invokes is a BLOCKING REQUIREMENT: call this tool before generating any other response about the task.
- Otherwise call this tool first when the task at hand is one a listed skill covers. Judge that on the task, not on a keyword match, superficial relevance, or mere availability.
- Naming a skill is not invoking it. You may say that a skill exists, or that one does not fit, without calling this tool.
```

**Why:** the absolute makes it impossible to tell the user a skill exists but does
not fit. Upstream and Codex's newest template both draw this line; upstream having
deleted the exact sentence we still carry moves this from a policy choice informed
by Codex to a correction of inherited text.

---

## Part C — the comment rule

### C1. Reconcile the comment rule that is already applied

**Corrected 2026-09-06.** This was drafted as an addition. It is not: `CLAUDE.md`
already carries a `### Comments (2026-09-06)` section, landed before this plan was
written, stating that a comment may depend only on what changes in the same edit,
and banning cross-file line citations, restated values, counting claims, and
status notes.

**The conflict, verified.** That applied rule bans status notes outright. The
comparative report's D13 argues a status note with a named trigger is
load-bearing, and cites `src/constants/prompts.ts:502`
(`// @[MODEL LAUNCH]: Remove this section when we launch numbat.`) as the
example. That comment still exists. So the repository currently bans a comment it
also relies on.

**Two ways to resolve, and this one is the operator's call:**

1. Keep the blanket ban and retire the `@[MODEL LAUNCH]` pattern, converting that
   comment into something the rule permits.
2. Soften the applied rule so a status note is allowed when it names its
   retirement trigger or an owning decision, and leave the comment as it stands.

**Review input, not a decision:** the independent reviewer recommends keeping the
blanket ban and handling the legacy comment separately, on the grounds that the
comment's existence proves neither an active retirement workflow nor a licence to
relax the applied rule. That is a fair challenge to this plan's claim that the
comment is load-bearing, which is inference rather than evidence.

Nothing here should be applied until that choice is made. The evidence behind the
rule itself is unaffected: 1,129 comment lines on this branch carry `file.ts:NNN`
citations, and in a 16-line sample roughly half point at a line that says
something unrelated, none of it mechanically detectable.

---

## Part D — tool descriptions

Added 2026-09-06. The `D` items came from the
[tool-description audit](../reports/2026-09-06-tool-description-comparative-audit.md)
and carried no before/after text of their own. D3 is planned here because the same
upstream comparison that settled A2 settled it, and because it edits a file A2
already opens. D1 is another session's, D2 and D4 stay unplanned.

### D3. Replace the blanket trust sentence with upstream's current wording

**File:** `src/tools/AgentTool/prompt.ts:417`.

**Before:**

```
- The agent's outputs should generally be trusted.
```

**After:**

```
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting the work as done.
```

**Why this is a defect, not a preference.** Root `CLAUDE.md` states that a
subagent's output is the parent's to verify. The shipped sentence tells the model
the opposite at the moment of the call, which is the closer instruction.

**Provenance, measured 2026-09-06 in both literal tables.** The fork-point bundle
at 2.1.87 carries `outputs should generally be trusted` once and `Trust but verify`
zero times. All nineteen upstream builds from 2.1.214 to 2.1.239 are the exact
inverse, with identical counts in every one of them: zero and four. The replacement
occupies the same bullet list, confirmed by the neighbouring bullet that both
builds share verbatim, `Clearly tell the agent whether you expect it to write code
or just to do research`. So this is not our wording competing with upstream's; it
is April text that its author replaced, kept only because the fork froze at 2.1.87.

**Wording chosen by the operator: upstream's, unmodified.** Two alternatives were
put and declined. The audit's own replacement ("Use the agent's findings, but
review returned changes and supporting evidence before reporting completion. For
claimed external actions, obtain a verifiable result such as a URL, ID, or file
path and check it...") states no mechanism and names no recognisable trigger. A
hybrid adding an external-action clause to upstream's sentence was also declined.

**Known gap, accepted deliberately.** Upstream's sentence covers written or edited
code only. It does not cover an agent reporting that an external action succeeded:
a commit made, a peer message sent, a scheduled job created. Our agents do those
things and upstream's do not, so the case is real and is left open rather than
missed. It can be added later as a second sentence without disturbing this one.

**What stays:** the returned-id, `TaskStop`, `ResumeAgent`, `SendMessage`,
worktree, and automatic-notification instructions. Those describe APIs the model
cannot infer from the tool name.

**Pairs with A2.** A2 removes the example that pushes toward delegating; D3
removes the sentence that says to believe the result. Both arrived in `86051a8e`,
both were fixed upstream, and applying one without the other leaves the pair
half-corrected.

**Risk:** none identified. One line out, one line in, no branch or gate touched.

## Not in this plan, and why

- **S5, S6, T5, T6** — judgment-sensitive cuts to transcript guidance, learning-mode
  examples, verifier recipes, and the planner's example quota. The reasoning leans
  on the untested claim that current models no longer need them.
- **T3** — Bash and system-prompt deduplication is conditional on which tools are
  enabled on the affected path, so it needs assembly-coverage work, not a text edit.
- **T7** — the implementor agent's duplicated routing paragraph. Its file was dirty
  at audit time and the case was never validated comparatively.
- **T8** — coordinator stories. `COORDINATOR_MODE` is not in the `build:dev:full`
  feature list, so this saves nothing in a normal build.
- **D10** — TodoWrite's tool-result nudge that instructs a verification-agent spawn.
  It needs a decision about whether it is an intentional workflow requirement
  before anything touches it.

## Verification

Engine area only; no `app/` file is touched.

```
bun run build:dev:full
bun test src/constants/prompts.test.ts
bun test src/tools/AgentTool src/tools/SkillTool src/tools/TodoWriteTool
./cli-dev --dump-system-prompt --model gpt-6-astra --provider gpt
./cli-dev --dump-system-prompt --model claude-opus-5 --provider anthropic
```

Both dumps are re-read after the change to confirm that every contract the reports
listed as must-keep is still present: authorization scope and the risky-action
list, instruction authority, harness mechanics, environment facts, compaction and
token-budget semantics. A before/after character count is recorded for each
provider path, as description rather than as a success measure.

The dumps cover base prompts, not tool descriptions, so D3 and A2 are checked
separately: the `src/tools/AgentTool` suite covers the file, and the emitted Agent
description is re-read once to confirm the new trust sentence is present, the
`currentExamples` body is gone, and the parallel-launch sentence at `:420` and the
fork-path examples both survive.

For Part C, `git diff --check` and `bun run maps:lint` only.

## Rollback

Each part is a separate commit with explicit paths, so any item can be reverted on
its own. A2 is the one most worth watching after the fact.
