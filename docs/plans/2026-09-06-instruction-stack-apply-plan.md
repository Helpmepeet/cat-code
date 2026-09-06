# Instruction-stack apply plan

**Date:** 2026-09-06
**Status:** Proposed. Nothing applied. Awaiting the operator's approval, per item.
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
| **1. The instruction is wrong** | Our text contradicts our own code or policy | A2, A6a, B1, B4a | Nothing. These are defects; they need no thesis about model strength |
| **2. Pure simplification** | The same rule, said once instead of twice | A1, A3, A4, A5, A6b | Nothing behavioral is claimed. This is the original brief |
| **3. Adopted from Codex** | Nothing of ours is wrong; we would import their judgment | B2, B3, B4b | The only real bet on the table |
| **4. Measured defect** | Prevents a fault observed in our own output | C1 | One clause; the only item with harm evidence rather than inference |

Two items split across groups. A6a is the false active-state claim (group 1);
A6b is its eight narrated scenarios (group 2). B4a removes an unfollowable
absolute (group 1); B4b adds the relevance test (group 3).

Groups 1 and 2 stand without the shrink thesis, which is the claim the comparator
work did not support. Group 3 is the only place another vendor's judgment
outranks ours. The groups are independent, and individual items can be dropped
without affecting the others.

**What cannot be promised.** No ablation has been run. Applying this changes the
text and can be shown not to break the build or drop a named contract. It cannot
be shown to improve model behavior. Both source reports say the behavioral benefit
is suspected.

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

**Risk:** the non-fork path ends up with no worked example at all. That is the
intent, but it is the largest single behavior-shaped deletion here, so it is worth
watching for a rise in unnecessary delegation and reverting alone if seen.

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

### A4. Remove three restated maxims

**GPT — `gpt.ts`, `codeStyleRules`:**

- From `ERROR HANDLING`, remove: `These are real failure points. The rule is: no defensive code for hypothetical internal failures; yes to error handling at real external boundaries.`
- From `ABSTRACTION`, remove: `The right complexity level is exactly what the task requires.` and `Three similar lines of code is better than a premature abstraction.`

**Claude — `prompts.ts`, `codeStyleSubitems`:** remove the corresponding
`The right amount of complexity is what the task actually requires...` clause and
`Three similar lines of code is better than a premature abstraction.`

**What stays:** validate at real boundaries, do not add defensive code for
impossible internal cases, do not build abstractions for one-time operations, do
not design for hypothetical futures.

**Note:** the surviving sentences carry the operator's actual preferences. Only
the illustrations and restatements go.

### A5. Trim the Skill invocation examples

**File:** `src/tools/SkillTool/prompt.ts`, GPT branch.

**Remove** three of the four example invocations, keeping the namespaced one
because that syntax is product-specific:

```
   - `skill: "pdf"`
   - `skill: "commit", args: "-m 'Fix bug'"`
   - `skill: "review-pr", args: "123"`
```

**What stays:** `skill: "ms-office-suite:pdf"`, the invocation order, where the
list lives, the no-reinjection rule, and the built-in-command exclusion.

### A6. Correct TodoWrite's active-state claim and drop the scenarios

**Scope warning, verified:** `TodoWriteTool.isEnabled()` returns
`!isTodoV2Enabled()`, and `isTodoV2Enabled()` returns `!getIsNonInteractiveSession()`.
So this tool is disabled in every interactive session and reaches only
non-interactive `-p` runs. Nothing in A6 changes the desktop app or the REPL.

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

**File:** `gpt.ts`, `# Doing Tasks`, alongside `TASK DOMAIN`.

**Add:** `A request to inspect, explain, review, or diagnose does not by itself authorize implementation. Persistence means completing the authorized scope.`

**Why:** A3 removes the example that pushed toward action; this keeps the
intent-reading guidance from tipping the other way, and closes the opposite
failure of implementing during an analysis-only request.

### B4. Skill relevance instead of an absolute trigger

**File:** `src/tools/SkillTool/prompt.ts`, GPT branch, `BINDING CONSTRAINTS`.

**Remove:** `NEVER mention a skill without actually calling this tool.`

**Change** the blocking requirement so that an explicitly named or invoked skill
stays binding, while an unnamed one is a judgment call: do not select a skill on
keyword match, superficial relevance, or mere availability alone.

**Why:** the current absolute makes it impossible to tell the user a skill exists
but does not fit. Codex's newest template draws exactly this line; its previous
one does not, so this is our policy choice informed by theirs, not a unanimous
practice.

---

## Part C — the comment rule

### C1. One clause in `CLAUDE.md` §7

**Current, line 511:** `- Comments state constraints code can't show. No narration comments, no comments on untouched code.`

**Proposed:** keep that and add: a comment must not create an obligation on a file
it does not live in. Never restate a value that exists in code, name the constant.
Never cite a line number in another file, name the file and the symbol. A status
note needs a named trigger or a decision reference, since nothing will come back
to delete a bare "deferred".

**Evidence:** 1,129 comment lines on this branch carry `file.ts:NNN` citations;
in a 16-line sample roughly half point at a line that says something unrelated,
and none of that is mechanically detectable because every cited line exists and
reads as plausible code.

**Independent of Parts A and B.** It touches no file any other item touches.

---

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

For Part C, `git diff --check` and `bun run maps:lint` only.

## Rollback

Each part is a separate commit with explicit paths, so any item can be reverted on
its own. A2 is the one most worth watching after the fact.
