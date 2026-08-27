# Prompt Audit: Core System Prompt Surface

**Date:** 2026-08-23
**Status:** Audit report and proposed diff. **Nothing applied.** `src/` is clean at HEAD.
**Covers two surfaces:** text already in the repo (findings F1-F9) and the upstream
text the companion resync proposes to import (findings G1-G4).
**Companion:** [2026-08-23-anthropic-prompt-upstream-delta.md](2026-08-23-anthropic-prompt-upstream-delta.md)
(the upstream resync). This audit is the removal half of the same migration: the
resync asks what to bring in, this asks what should have left already.

---

## Step 0: Scope and target model (assumed, not confirmed)

**Scope.** The core system-prompt pipeline, because that is the surface the
in-progress resync touches:

- `src/constants/prompts.ts` (Claude style + assembly)
- `src/constants/promptStyles/gpt.ts` (GPT style)
- `src/constants/corePolicy.ts` (shared policy constants)
- `src/constants/system.ts`, `outputStyles.ts`, `systemPromptSections.ts`
- `src/services/api/claude.ts` (request construction, for Group 4)

**Bounded secondary sweep:** `src/tools/*/prompt.ts` (Group 3) was swept at the
signals level only, with the top offenders inspected. A full tool-description
audit is a separate job; findings F7 and F8 are what the sweep surfaced, and the
rest is explicitly not covered.

**Not in scope:** the ~30 remaining tool prompt files, `src/agent-mode/`,
`src/coordinator/`, output-style prompt bodies, and skill files outside
`CLAUDE.md`.

**Target model.** Two, because this repo ships two prompt styles:

- Anthropic path: the Claude 5 family. Taken from the repo's own pin,
  `LATEST_CLAUDE_MODEL_IDS` (prompts.ts:151): `claude-opus-5`,
  `claude-sonnet-5`, `claude-haiku-4-5-20251001`.
- GPT path: `gpt-5.6-*`, per `resolveRequestProvider` routing and the operator's
  recorded usage note.

**Reference limitation, stated up front:** the audit skill's companion files
(`shared/model-migration.md`, `shared/prompt-caching.md`) were not resolvable on
this machine. Consequently **no finding below claims that a parameter or shape
hard-errors on the target model.** Where the skill would have me cite a
per-target error list, I instead verified the current code shape directly and
report what I observed.

---

## Summary

**The core system-prompt surface is substantially cleaner than the audit's
pattern tables anticipate.** The scans for the classic dated-prompt markers came
back empty: no `STEP n` choreography, no `<scratchpad>` or `<thinking>` tag
instructions, no "think step by step", no "take a deep breath", no retired model
names, no grader vocabulary, no recap markers, no prohibition runs, no numeric
output caps, no fixed interim-update cadence, no `do not hallucinate`.

The request builder is likewise already migrated, not fossilised. Two things
that looked like Group 4 hits are not:

- `budget_tokens` at claude.ts:1819 is the **fallback branch only**. Models that
  support it get `thinking: {type: 'adaptive'}` at claude.ts:1805; the budgeted
  form is reached only for models that do not. This is the migrated shape.
- The `role: 'assistant'` entries at claude.ts:708/721/737 are conversation-history
  serialization inside `AssistantMessage → MessageParam`, not a trailing prefill.
  Per the skill's own carve-out, assistant turns mid-array must stay.

No `stop_sequences`, no JSON-forcing retry loop, no non-default sampling
parameters reaching the request.

**Thirteen findings survive: nine in existing source (F1-F9), four in the text the
resync would import (G1-G4). The four highest-impact:**

1. **F1 — a live defect.** Both prompt styles inject an ungrammatical, contentless
   sentence on every turn, because `MACRO.ISSUES_EXPLAINER` is a note about the
   source snapshot rather than a feedback destination. High confidence, trivial fix.
2. **F5/F6 — the Claude style carries upstream padding the GPT style already
   dropped.** `gpt.ts` has tightened rewrites of the same two rules. The
   replacement text therefore already exists in-repo and needs no invention, and
   applying it makes the two styles agree rather than diverge.
3. **F7 — `TaskStopTool` is under-described**, and the fix is to *add* text, not
   remove it. This matters more here than in a generic repo: the Agent Mode
   orchestrator has to distinguish a killed worker from a failed one, and the
   description does not say what stopping actually does to in-flight output.
4. **G1-G4 — the incoming upstream text carries four of the patterns this audit
   removes**, including an anti-laziness booster ("not just easy parts") and a
   five-clause prohibition run. Porting upstream verbatim would import fresh
   cruft into a surface that is currently clean of it. Trimming on the way in
   makes the two new sections about a fifth shorter.

**Provenance (Step 2):** `git blame` puts F1, F2, F4, F5 and F6 all at
`86051a8e` (2026-04-30) — the initial fork-point import. None was added by this
repo to fix an observed Cat Code failure; all are inherited upstream text written
for the generation upstream targeted at fork (2.1.87), now serving Claude 5 and
gpt-5.6. That is the strongest form of the skill's dating signal.

| Group | Findings in existing source | Findings in the incoming text |
|---|---|---|
| 1a pressure language | F2, F3, F4 | G1, G3 |
| 1c over-specification / padding | F5, F6 | G2, G4 |
| 1d fossils | F1 | none |
| 2 skill files | F9 | n/a |
| 3 tool descriptions | F7, F8 | n/a |
| 4 request config | none | n/a |

**Two surfaces, not one.** F-findings are text already in the repo. **G-findings
are in the upstream prose the resync proposes to import** — audited in their own
section below, because auditing what we keep while waving through what we add
would get this migration backwards. All four G-findings are patterns Cat Code does
not have today and would acquire by porting upstream verbatim.

---

## Findings

### F1 — Broken interpolation in the help/feedback block · **High** · `remove`

| Field | Content |
|---|---|
| **Location** | [prompts.ts:255-257](../../src/constants/prompts.ts), [prompts.ts:277-278](../../src/constants/prompts.ts); [gpt.ts:149-151](../../src/constants/promptStyles/gpt.ts), [gpt.ts:175](../../src/constants/promptStyles/gpt.ts) |
| **Evidence** | Rendered: `To give feedback, users should This reconstructed source snapshot does not include Anthropic internal issue routing.` |
| **Pattern** | Group 1d — fossils / unenforced instructions |
| **Why obsolete** | `ISSUES_EXPLAINER` reads `MACRO.ISSUES_EXPLAINER`, which [scripts/build.ts:157](../../scripts/build.ts) defines as a note *about the snapshot*, not a destination. The sentence expects a destination and gets a disclaimer. Beyond the grammar, the block routes bug reports from a user base to a maintainer; in a single-operator fork those are the same person and there is no flow to name. |
| **Confidence** | **High** — verified by reading the macro value and both call sites; the defect is in the rendered string, not a judgment call. |
| **Action** | `remove` the help/feedback bullets from both styles. `/help` still exists as a command (`src/commands/help`), so nothing dangles. |

Not proposed for removal: the neighbouring `USER_TYPE === 'ant'` escalation
bullets (prompts.ts:272, gpt.ts:170). Equally irrelevant here, but build-time
DCE'd, so they cost zero tokens and carry zero risk.

### F5 — Capability padding on the Claude side only · **Medium** · `rewrite`

| Field | Content |
|---|---|
| **Location** | [prompts.ts:262](../../src/constants/prompts.ts) |
| **Evidence** | `You are highly capable and often allow users to complete ambitious tasks that would otherwise be too complex or take too long. You should defer to user judgement about whether a task is too large to attempt.` |
| **Pattern** | Group 1c — padding (generic virtues); Group 1d — identity stub territory |
| **Why obsolete** | The first sentence is a capability compliment addressed to a user population and prescribes no behavior. Only the second sentence is actionable. Current models treat every sentence as actionable signal, so a non-actionable one is applied somewhere it does not fit, and it inflates adaptive-thinking spend for nothing. |
| **Confidence** | **Medium** — pattern-documented, and corroborated in-repo: the GPT style already made exactly this cut. |
| **Action** | `rewrite` to the GPT style's existing wording at [gpt.ts:160](../../src/constants/promptStyles/gpt.ts): keep the defer-to-judgment clause, drop the compliment. |

### F6 — Multi-user clause in the time-estimates rule · **Medium** · `rewrite`

| Field | Content |
|---|---|
| **Location** | [prompts.ts:266](../../src/constants/prompts.ts) |
| **Evidence** | `Avoid giving time estimates … whether for your own work or **for users planning projects**. Focus on what needs to be done, not how long it might take.` |
| **Pattern** | Group 1c — padding / kitchen-sink scoping |
| **Why obsolete** | The rule is sound; the clause enumerates a second audience that does not exist in a single-operator fork, and the trailing restatement repeats the rule it just gave. |
| **Confidence** | **Medium** — same corroboration as F5: [gpt.ts:164](../../src/constants/promptStyles/gpt.ts) already states the tightened form. |
| **Action** | `rewrite` to the GPT style's wording. |

### F2 — Bare emphasis on the dedicated-tools rule · **Medium** · `rewrite`

| Field | Content |
|---|---|
| **Location** | [prompts.ts:336](../../src/constants/prompts.ts); [gpt.ts:262](../../src/constants/promptStyles/gpt.ts) |
| **Evidence** | Claude: `… Using dedicated tools allows the user to better understand and review your work. **This is CRITICAL to assisting the user:**` · GPT: `… Dedicated tools let the user review your work. **This is CRITICAL.**` |
| **Pattern** | Group 1a — pressure language |
| **Why obsolete** | The rule already carries its reason, which is the part that makes it followable. "This is CRITICAL" adds volume on top of a stated because, and 1a's core claim is that inflated emphasis on current models causes over-application, not better compliance. Note this is the *milder* form of the pattern: the sentence is not naked emphasis, which is why it is Medium and not High. |
| **Confidence** | **Medium** |
| **Action** | `rewrite` — delete the emphasis sentence on both styles, keep the rule and its reason verbatim. |

### F4 — Hedge on a real requirement · **Medium** · `rewrite`

| Field | Content |
|---|---|
| **Location** | [prompts.ts:297](../../src/constants/prompts.ts) |
| **Evidence** | `For instance, **try to** identify root causes and fix underlying issues rather than bypassing safety checks (e.g. --no-verify).` |
| **Pattern** | Group 1a — hedges read literally (`try to` attached to an actual requirement) |
| **Why obsolete** | This is a requirement, not an aspiration: the surrounding paragraph and CLAUDE.md both treat bypassing safety checks as prohibited. Current models read `try to` literally, as permission to under-deliver. |
| **Confidence** | **Medium** |
| **Action** | `rewrite` — `For instance, identify root causes and fix underlying issues rather than bypassing safety checks (e.g. --no-verify).` |

### F3 — Token-budget section: pressure phrasing, plus a rendered counter · **Medium / Low** · `rewrite` + `flag`

| Field | Content |
|---|---|
| **Location** | [prompts.ts:871](../../src/constants/prompts.ts) |
| **Evidence** | `… your output token count will be shown each turn. … **The target is a hard minimum, not a suggestion.** If you stop early, the system will automatically continue you.` |
| **Pattern** | Group 1a (pressure) for the first half; Group 4 (budget countdowns rendered into context) for the second |
| **Why obsolete** | "not a suggestion" is emphasis defending a rule the same sentence already states unambiguously ("hard minimum"), and the following sentence states the enforcement mechanism, which is what actually makes it binding. |
| **Confidence** | **Medium** for the phrasing. |
| **Action** | `rewrite` — drop `, not a suggestion`. |

**Deliberately only flagged, not fixed:** the rendered per-turn output count. The
skill's Group 4 concern is that surfacing *remaining* budget causes premature
wrap-up. This is the inverse design — a minimum to work toward, with automatic
continuation — so the documented harm does not transfer, and I have no evidence
the counter hurts here. Recording it so a future audit does not re-derive the
question from scratch. **Confidence: Low. No diff.**

### F7 — `TaskStopTool` is under-described · **Medium** · `add`

| Field | Content |
|---|---|
| **Location** | [src/tools/TaskStopTool/prompt.ts](../../src/tools/TaskStopTool/prompt.ts) (whole `DESCRIPTION`, 280 bytes) |
| **Evidence** | Four bullets: stops a task by ID, takes `task_id`, returns success/failure, use it to terminate a long-running task. |
| **Pattern** | Group 3 — under-description (the most common tool-description failure) |
| **Why obsolete** | The description states the signature and omits the contract: whether the stop is graceful or immediate, whether partial output survives, what happens to a task that already finished or was never running, and when *not* to call it. This is load-bearing in this repo specifically: the Agent Mode orchestrator has to distinguish `Status: killed` from `Status: failed` and is told the killed Result "may contain its last output, but do not treat it as completion" ([orchestratorPrompt.ts](../../src/agent-mode/orchestratorPrompt.ts)). The tool that *creates* that state does not describe it. |
| **Confidence** | **Medium** — the gap is verifiable by reading the description; the exact replacement text needs the stop semantics confirmed against the implementation, which I did not read. |
| **Action** | `add`. Because the correct text depends on implementation behavior I have not verified, the diff below gives the shape and marks the two claims that must be confirmed before applying. This is the one hunk that must not be applied blind. |

### F8 — Description bulk in the three largest tools · **Medium** · `flag`

| Field | Content |
|---|---|
| **Location** | `src/tools/AgentTool/prompt.ts` (28.0 KB), `src/tools/BashTool/prompt.ts` (24.3 KB), `src/tools/TodoWriteTool/prompt.ts` (12.0 KB) |
| **Evidence** | All three carry worked examples or fake dialogue turns; `BashTool` additionally has 16 caps-modal steering hits. |
| **Pattern** | Group 3 — worked examples and embedded protocols in descriptions |
| **Why obsolete** | Tool descriptions ride in every request. The skill is explicit that examples in descriptions constrain the exploration space and cost tokens on every call, and that teaching material belongs in skills or progressive disclosure. |
| **Confidence** | **Medium** that the pattern applies; **Low** that any specific block should move, because I did not separate contract from teaching material in 64 KB of text. |
| **Action** | `flag`. A real fix requires reading all three in full and classifying block by block, which is outside this audit's scope. Recorded with sizes so the next pass has a starting point. **No diff** — proposing cuts to 64 KB I have not read would be exactly the indiscriminate deletion the skill warns against. |

### F9 — `CLAUDE.md` incident archaeology · **Low** · `flag`

| Field | Content |
|---|---|
| **Location** | `CLAUDE.md`, throughout: §4 (`2026-07-12: a git reset HEAD~1 …`, `2026-07-22: 34 spent worktrees, ~7 GB`), §3 (`Cost the first time this happened, undiagnosed: hours (2026-07-28)`, `Added 2026-07-30 after three agents broke this rule in one day`), §8 in full (`Mistakes that have actually happened here`) |
| **Pattern** | Group 2 — history narratives (past tense, dated incidents) |
| **Why obsolete** | The skill's position is that a rule's authority is the behavior it prescribes, not the incident that motivated it. |
| **Confidence** | **Low**, and I am recording the counter-argument as the primary content of this finding. |
| **Action** | `flag` only. **No diff, and I recommend against one.** |

The counter-argument, which I judge stronger than the pattern match: the skill's
own keep-list rule 1 says the *reasons* behind constraints are never cruft, and
in this file the dated incident **is** the reason. "Never `git reset HEAD~1`" with
no history reads as fussiness; with "a reset intended to undo my own commit undid
another session's instead, seconds after they committed" it is obviously correct
and the reader can generalize it to cases the rule does not enumerate. The
Group 2 row targets incident IDs and PR numbers — pointers to archives the reader
cannot access. These are self-contained causal explanations, which is the
opposite. Flagged so the question is on record, with the recommendation to keep.

---

## Proposed diff

One finding per hunk. **Nothing here is applied.** F3's counter-rendering, F8 and
F9 are report-only.

### Hunk 1 — F1, remove the help/feedback block (Claude)

```diff
--- a/src/constants/prompts.ts
+++ b/src/constants/prompts.ts
@@ -253,11 +253,6 @@
-  const userHelpSubitems = [
-    `/help: Get help with using Cat Code`,
-    `To give feedback, users should ${ISSUES_EXPLAINER}`,
-  ]
-
@@ -275,8 +270,6 @@
-    `If the user asks for help or wants to give feedback inform them of the following:`,
-    userHelpSubitems,
```

Also delete the now-unused `ISSUES_EXPLAINER` constant at prompts.ts:134-136.

### Hunk 2 — F1, remove the help/feedback block (GPT)

```diff
--- a/src/constants/promptStyles/gpt.ts
+++ b/src/constants/promptStyles/gpt.ts
@@ -148,4 +148,0 @@
-    `/help: Get help with using Cat Code`,
-    `To give feedback, users should ${ISSUES_EXPLAINER}`,
@@ -175,1 +171,0 @@
-    `HELP: If the user asks for help or wants to give feedback, inform them of the following:`,
```

Also delete the duplicate `ISSUES_EXPLAINER` at gpt.ts:57-59.

**Completeness check required before applying either hunk** (skill Step 6): grep
for `ISSUES_EXPLAINER` and `MACRO.ISSUES_EXPLAINER` across the repo, including
`scripts/build.ts:157`, and remove the macro define if nothing else consumes it.
Also grep `prompts.test.ts` and `corePolicy.test.ts` for assertions on the help
text.

### Hunk 3 — F5, capability padding

```diff
--- a/src/constants/prompts.ts
+++ b/src/constants/prompts.ts
@@ -262 +262 @@
-    `You are highly capable and often allow users to complete ambitious tasks that would otherwise be too complex or take too long. You should defer to user judgement about whether a task is too large to attempt.`,
+    `You are highly capable and can handle ambitious tasks. Defer to the user's judgement about whether a task is too large to attempt.`,
```

Replacement text is the GPT style's existing wording (gpt.ts:160), so this
converges the two styles rather than forking them.

### Hunk 4 — F6, time-estimates rule

```diff
--- a/src/constants/prompts.ts
+++ b/src/constants/prompts.ts
@@ -266 +266 @@
-    `Avoid giving time estimates or predictions for how long tasks will take, whether for your own work or for users planning projects. Focus on what needs to be done, not how long it might take.`,
+    `Do not give time estimates or predictions for how long tasks will take. Focus on what needs to be done.`,
```

Again the GPT style's existing wording (gpt.ts:164).

### Hunk 5 — F2, emphasis on the dedicated-tools rule (Claude)

```diff
--- a/src/constants/prompts.ts
+++ b/src/constants/prompts.ts
@@ -336 +336 @@
-    `Do NOT use the ${BASH_TOOL_NAME} to run commands when a relevant dedicated tool is provided. Using dedicated tools allows the user to better understand and review your work. This is CRITICAL to assisting the user:`,
+    `Do not use the ${BASH_TOOL_NAME} to run commands when a relevant dedicated tool is provided. Using dedicated tools allows the user to better understand and review your work:`,
```

### Hunk 6 — F2, same rule (GPT)

```diff
--- a/src/constants/promptStyles/gpt.ts
+++ b/src/constants/promptStyles/gpt.ts
@@ -262 +262 @@
-    `RULE — Prefer dedicated tools over ${BASH_TOOL_NAME}: Dedicated tools let the user review your work. This is CRITICAL. Use ${BASH_TOOL_NAME} only when no dedicated tool exists for the operation.`,
+    `RULE — Prefer dedicated tools over ${BASH_TOOL_NAME}: Dedicated tools let the user review your work. Use ${BASH_TOOL_NAME} only when no dedicated tool exists for the operation.`,
```

### Hunk 7 — F4, hedge on a requirement

```diff
--- a/src/constants/prompts.ts
+++ b/src/constants/prompts.ts
@@ -297 +297 @@
-For instance, try to identify root causes and fix underlying issues rather than bypassing safety checks (e.g. --no-verify).
+For instance, identify root causes and fix underlying issues rather than bypassing safety checks (e.g. --no-verify).
```

### Hunk 8 — F3, pressure phrasing in the token-budget section

```diff
--- a/src/constants/prompts.ts
+++ b/src/constants/prompts.ts
@@ -871 +871 @@
-The target is a hard minimum, not a suggestion. If you stop early, the system will automatically continue you.
+The target is a hard minimum. If you stop early, the system will automatically continue you.
```

### Hunk 9 — F7, `TaskStopTool` description · **DO NOT APPLY UNVERIFIED**

Shape only. The two bracketed claims must be confirmed against the TaskStop
implementation and the background-task runner before this is applied; if either
is wrong, the description becomes a false contract, which the skill notes is the
one tool-description failure no prompt text can recover from.

```diff
--- a/src/tools/TaskStopTool/prompt.ts
+++ b/src/tools/TaskStopTool/prompt.ts
@@
 export const DESCRIPTION = `
-- Stops a running background task by its ID
-- Takes a task_id parameter identifying the task to stop
-- Returns a success or failure status
-- Use this tool when you need to terminate a long-running task
+Stops a running background task by its ID.
+
+- `task_id`: the id of the task to stop, as returned when the task was created.
+- Returns a success or failure status. Failure includes the case where the id
+  does not match a running task, which happens when the task already completed
+  or was already stopped.
+- [VERIFY] Stopping is immediate, not graceful: the task does not get to finish
+  its current step.
+- [VERIFY] Output the task produced before it was stopped is still readable, and
+  arrives with status `killed`. Partial output is evidence about what the task
+  was doing; it is not a completed result and must not be treated as one.
+- Use this when a task is no longer needed or is running away. Do not use it to
+  poll or to check whether a task has finished, and do not stop a task merely
+  because it is slow.
 `
```

---

## Step 7: Verification the diff needs before it is trusted

Removal is a hypothesis. For this diff specifically:

1. **Hunks 1-2 need the reference sweep**, not a behavioral probe: `ISSUES_EXPLAINER`,
   `MACRO.ISSUES_EXPLAINER`, the `scripts/build.ts` define, and any test asserting
   the help text. A prompt fixed while its test still asserts the old string is a
   broken build, not an audit win.
2. **Hunks 3-8 are single-sentence rewrites** with no code dependency. The battery
   is `bun test src/constants/prompts.test.ts src/constants/corePolicy.test.ts`
   plus `bun run build:dev:full`. `corePolicy.test.ts:161` asserts each policy rule
   appears at most once per assembled prompt; none of these hunks touches a
   `corePolicy` constant, so it should stay green, and if it does not, that is the
   signal to stop.
3. **Hunk 9 needs source reading first**, per its own warning.
4. **Behavioral probes.** F2 and F4 are the two where a cut could plausibly
   regress: both soften language on rules the operator cares about (dedicated-tool
   preference, not bypassing safety checks). If either regresses, the skill's
   instruction is to re-add in minimal form rather than restore the verbose
   original.

---

## Audit of the incoming text (findings G1-G4)

**This section was missing from the first pass and is the more important half.**
The audit above examined text already in the repo. But the resync proposes to
*import* upstream prose, and that prose is the one body of text in this migration
guaranteed to have been written for a different target than ours. Auditing what
we keep while waving through what we add gets the migration exactly backwards.

Run over the upstream text the resync proposes to port, the pattern tables hit
four times. All four are in the incoming text, none is in Cat Code today.

### G1 — "not just easy parts" · **Medium** · `rewrite`

| Field | Content |
|---|---|
| **Location** | Incoming `# Delivering work`, proposed for prompts.ts |
| **Evidence** | `Finish the whole task, not just easy parts, and report completion only when fully done.` |
| **Pattern** | Group 1a — `Be thorough. Do not be lazy. Do not stop early.` |
| **Why obsolete** | 1a's row on this is unambiguous: current models are proactive by default, and anti-laziness boosters are listed as delete-on-sight. "not just easy parts" is the softened form of exactly that instruction. The clause it modifies ("finish the whole task") already carries the requirement. |
| **Action** | `rewrite` on the way in: `Finish the whole task.` The trailing completion clause was already dropped as a duplicate of `OUTCOME_REPORTING_RULE`. |

### G2 — "Avoid unnecessary or excessive self-correction" · **Medium** · `remove`

| Field | Content |
|---|---|
| **Location** | Incoming `# Corrections`, opening sentence |
| **Evidence** | `Avoid unnecessary or excessive self-correction. Only correct an earlier statement in your user-facing text when the error would change the user's code, conclusions, or decisions.` |
| **Pattern** | Group 1c — repetition as reinforcement |
| **Why obsolete** | The second sentence (A3a) states the rule positively and precisely. The first is the same rule stated negatively and vaguely, immediately before it. Saying it twice makes the model reconcile two wordings of one instruction. |
| **Action** | `remove` the opening sentence; port A3a as the section's first line. |

### G3 — "don't be overly self-critical" · **Medium** · `rewrite`

| Field | Content |
|---|---|
| **Location** | Incoming `# Corrections` |
| **Evidence** | `Don't add apologies or preambles, don't be overly self-critical, and don't ruminate...` |
| **Pattern** | Group 1a — `don't be too [adjective]`, an explicit signal row |
| **Why obsolete** | 1a's prescribed fix is to state the desired behavior rather than name a degree of an undesired one. "Overly" gives no threshold the model can act on. |
| **Action** | `rewrite` — fold into G4's replacement. |

### G4 — Three-clause prohibition run · **Medium** · `rewrite`

| Field | Content |
|---|---|
| **Location** | Incoming `# Corrections`, same sentence as G3 |
| **Evidence** | `Don't add apologies or preambles, don't be overly self-critical, and don't ruminate or give a detailed account of the mistake or tally past errors.` |
| **Pattern** | Group 1c — runs of 3+ `Do not / Never / Avoid`; describing success beats enumerating failure |
| **Why obsolete** | Five prohibitions in one sentence, enumerating ways to fail at a behavior that one positive sentence specifies completely. |
| **Action** | `rewrite` to: `State the correction and continue the task.` Combined with G3, the whole sentence collapses to that. |

### Net effect of G1-G4

The two new sections arrive roughly a fifth shorter than upstream ships them, and
arrive without importing four instances of the exact patterns this audit exists to
remove. This also partly answers the bulk concern below: the resync is still
net-additive, but less so.

**One caveat on all four.** These are judgments about text I read in a live
injected prompt, not about text in a file I can re-read. Section 1's third
limitation applies: upstream's prose varies between sessions. If the wording
differs when the port is actually written, re-run these four pattern checks
against whatever text is in hand rather than assuming G1-G4 still match.

---

## Interaction with the upstream resync

### Findings the two passes share

**F1 was found independently by both.** The delta report reached it through a
single-operator lens (§10); this audit reached it through Group 1d provenance and
`git blame`. Same fix, and the independent agreement raises confidence.

### Merge hazards if both change sets are applied

The diff above is written against **HEAD**, not against post-resync source. Two
consequences:

1. **One duplicate edit.** Deleting the help/feedback block is proposed in both
   places: audit hunks 1-2, and delta §10. **Apply it once.** The audit's version
   is the more complete of the two, because it also removes the now-dead
   `ISSUES_EXPLAINER` constants and names the `scripts/build.ts` macro define that
   must be swept.
2. **Line drift.** The resync inserts `# Delivering work` and `# Corrections` into
   `getSystemPrompt`'s section list and adds two builder functions near
   prompts.ts:284-300. Every audit hunk below that point (`:297` F4, `:336` F2,
   `:871` F3) shifts. The hunks are single-sentence rewrites with unique anchor
   text, so they will still apply by content, but not by the line numbers printed
   here.

**Recommended order: audit first, then resync.** The audit is subtractive and its
anchors exist today; the resync is additive and its insertion points are stable
regardless. Doing it the other way means re-deriving every audit line number
against a moved file. If the resync lands first, re-locate the audit hunks by
their quoted text rather than by line.

### Direction of net change

The resync is additive: two new Claude prose sections plus seven GPT rule
amendments. This audit is the counterweight, and Group 1c is explicit that bulk
inflates adaptive-thinking spend. Landed together, the surface roughly holds
steady rather than growing: the resync adds two sections (each trimmed by G1-G4),
while this pass removes the help/feedback block, the capability padding, and four
instances of emphasis or hedging, on top of the three rev-1 ports the
single-operator pass already dropped (A1, A5, A2b).

---

## What the audit deliberately did not flag

Per the skill's keep-list, and recorded so a future pass does not re-open them:

- **The whole of `getActionsSection`.** Reads as a prohibition cluster, but every
  row encodes an observable constraint on a shared tree with concurrent sessions,
  and the reasons are stated.
- **`RETRY_RULE`.** A prohibition with a documented, reproducing failure mode.
- **The seven code-style sub-bullets.** They encode repository conventions the
  model cannot infer.
- **The duplicated skill-invocation bullet** at prompts.ts:407 and :472. These sit
  in two *different assemblies* (Agent Mode and normal), not twice in one prompt.
  Working redundancy, not duplication.
- **`getUsingYourToolsSection`'s tool-by-tool mapping.** Contract detail, and the
  skill is explicit that tool contract detail stays and often grows.
- **`scratchpad` hits.** A real per-session directory feature, not the
  `<scratchpad>` tag scaffold the signal row targets.
- **The `USER_TYPE === 'ant'` blocks.** Irrelevant to this fork but build-time
  DCE'd, so zero tokens and zero risk.
