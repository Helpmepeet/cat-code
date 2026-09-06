# Cat Code instruction stack: comparative adopt-and-drop report

**Date:** 2026-09-06
**Status:** Analysis only. No prompt edits applied.
**Companion:** [2026-09-06-instruction-stack-subtraction.md](2026-09-06-instruction-stack-subtraction.md)
(commit `169f4e29`), which nominated 15 cut groups on internal evidence alone.
Verified: across that report's entire 165-line recommendations region there are
zero references to any other harness. This pass supplies the outward comparison
it lacked.

**Recommendation:** Revise S4 rather than applying it as written. Proceed with
narrowly bounded example removal and deduplication, but add explicit guidance for
self-contained final answers, scoped persistence, and skill-trigger judgment.
Correct TodoWrite's completion-state wording. Preserve fork-specific authority,
safety, and tool-lifecycle contracts.

**Evidence convention:** **Verified** identifies inspected text or source
behavior. **Suspected** identifies an expected behavioral benefit, an inference,
or an unresolved deployment claim. Recommendations are judgments; no prompt
ablation was performed.

---

## 0. Verification pass (main session, 2026-09-06)

The body below is the comparative pass as delivered. Before recording it, the
main session re-checked its load-bearing claims against source at HEAD. What
follows is what that check established. Sections it changes carry an inline
**CORRECTION** or **CONFIRMED** marker.

### Confirmed verbatim

- **D1.** The Astra template contains "Let each sentence build on what came
  before."
- **D2.** The Astra template contains "The final answer must always be fully
  self-contained: users should never need to read earlier commentary updates,
  since they are collapsed after the final answer is shown to users." The
  opposing Cat Code text is RULE 6 in
  [promptStyles/gpt.ts](../../src/constants/promptStyles/gpt.ts): "Do not repeat
  conclusions or status you have already communicated to the user in this
  conversation." The tension D2 describes is real.
- **D5.** The Astra template contains "Do not use a skill based solely on
  keywords, superficial relevance, or the availability of a potentially
  applicable skill."
- **D10.** The nudge exists and is quoted accurately. It lives in
  `mapToolResultToToolResultBlockParam` in
  [TodoWriteTool.ts](../../src/tools/TodoWriteTool/TodoWriteTool.ts), outside
  every `prompt.ts` file, and reads in part "Before writing your final summary,
  spawn the verification agent". Its gate is `feature('VERIFICATION_AGENT')` and
  `tengu_hive_evidence` and no `context.agentId` and all items complete and at
  least three items and no item matching `/verif/i`. Neither audit's scope
  covered tool-result text, so this surface was previously unexamined.
- **D7 premise.** `call()` sets the stored list to `[]` when every item is
  complete, so no item can be `in_progress` at that moment.

### Corrections

- **CORRECTION to D7, D10 and the T2 disposition — the tool is off in
  interactive sessions.** `TodoWriteTool.isEnabled()` returns
  `!isTodoV2Enabled()`; `isTodoV2Enabled()` in
  [utils/tasks.ts](../../src/utils/tasks.ts) returns
  `!getIsNonInteractiveSession()`; and `getIsNonInteractiveSession()` in
  [bootstrap/state.ts](../../src/bootstrap/state.ts) returns
  `!STATE.isInteractive`. So an interactive session (desktop app, REPL) runs the
  V2 task tools and TodoWrite is disabled; TodoWrite is live only in
  non-interactive `-p` runs. These three items remain worth fixing, because the
  delegation lane uses `-p`, but they are not default-session changes and must
  not head an apply tranche. This is the same dead-surface qualifier the
  companion report applied to coordinator mode and neither pass applied here.
- **CORRECTION to D7 — the contradiction is wider than reported.** Three
  locations conflict with the cleared-on-completion behavior, not one:
  `prompt.ts:161` and `prompt.ts:207` both say "Exactly ONE task must be
  in_progress at any time (not less, not more)", and `prompt.ts:238` says "Make
  sure that at least one task is in_progress at all times."
- **UNRESOLVED — D7's "at most one" attribution.** That phrase does not appear
  in the local Astra template. The report cites it to Codex's Rust plan-tool
  source, which this verification did not read. Treat the comparison as
  unchecked rather than as either confirmed or refuted.

### Standing note on direction

Five of these decisions (D2, D3, D4, D5, D13) propose **adding** text. Each
addresses a genuine tension found in source, but the operator's original brief was
that instruction should shrink as models improve. Adding is a legitimate outcome
of this comparison and is recorded as such; it is a choice to make knowingly, not
a side effect to absorb. D13 is the only one of the five with measured harm behind
it — a retracted bug report and a lost session — where the other four rest on
inferred tension. That difference is the strongest argument available for adding
anything at all right now.

### Prior-session measurements this pass rests on

Measured in the main session on 2026-09-06 and not re-derived here. Codex ships
three installs on this machine; from the newest (0.153.4), `gpt-6-astra` carries
a 21,261-character instruction template against `gpt-5.6-sol`'s 17,730, and the
ladder across `gpt-5.2` (21,544), `gpt-5.4` (12,896), `gpt-5.5` (19,754),
`gpt-5.6` (17,730) and `gpt-6` (21,261) is not monotonic in recency. Between Sol
and Astra, execution guidance and skills mechanics roughly halved while
permission and autonomy text nearly tripled and communication text grew. Cat
Code's GPT-path prompt is 24,680 characters against Claude Code's 11,177 in the
2026-08-12 capture, and our surplus sits in execution guidance. That measurement
is what moved S4 from recommended to contested, and D1 below settles it.

---

## 1. Evidence and limits

| Comparator | Evidence used | Status |
| --- | --- | --- |
| **Codex** | Extraction of Astra and Sol instruction templates from `/Users/pt/.codex/plugins/.plugin-appserver/codex`; public Rust tool-definition sources | **Verified:** extracted wording. **Suspected:** exact correspondence between the public tool sources and that installed binary |
| **Claude Code** | Repository captures dated August 11 and August 12 | **Verified:** captured wording and stated capture limitations. They are not a fresh capture of the newest binary |
| **OpenClaw** | Public `openclaw/openclaw` source | **Verified:** canonical repository and inspected public text. **Suspected:** correspondence to the locally installed `2026.3.28` |
| **Hermes** | Public `NousResearch/hermes-agent` prompt assembly and tool sources | **Verified:** inspected public text. **Suspected:** correspondence to the local checkout and skill snapshot |

**Verified:** OpenClaw's own website identifies <https://github.com/openclaw/openclaw>
as its source repository. That is the repository used here.

**Verified:** Selected Cat Code sources were checked against commit
`24e086cc407db6dc0ff5c9deb5f74bc119fe8827`. The relevant source files returned no
differences from that commit. Dirty implementation files belonging to other
sessions were not used as authoritative source for recommendations.

**Verified limitation:** This is a content comparison of selected, source-traced
surfaces. It is not an exhaustive emitted-request audit of all 40 tool prompt
modules. Neither Claude capture reproduces its structured tool definitions. No
claim that "none of the four harnesses says X" is justified across their entire
instruction stacks.

**Verified:** Release histories and relative prompt lengths were not used to
justify decisions.

## 2. What actually reaches the model

**Verified:** Cat Code's tool-description path is:

1. [services/api/claude.ts:1372](../../src/services/api/claude.ts:1372) builds schemas for the filtered tool set.
2. [utils/api.ts:138](../../src/utils/api.ts:138) resolves the request provider.
3. That function calls `tool.prompt(...)` with the resolved provider and available tools.
4. The returned text becomes the API schema's `description`; the base schema is cached using a provider-qualified key.

This is distinct from a tool's short `description()` method.

| Surface | Verified model-facing selection | Consequence |
| --- | --- | --- |
| Skill | `SkillTool.ts:344` calls the provider-aware `getPrompt` | Listing-budget code in `prompt.ts` is not itself instruction prose |
| TodoWrite | `TodoWriteTool.ts:39` calls `getPrompt(provider)`; `prompt.ts:231` selects the GPT or Claude variant | The eight Claude examples are not a GPT-path saving |
| Bash | `BashTool.tsx:435` passes provider and available tool names into `getBashPrompt` | Routing and feature-dependent paragraphs must be evaluated in their selected configuration |
| Apply_patch | `FilePatchTool.tsx:59` returns `getFilePatchToolDescription()` | Its grammar, examples, and directory rules are actual description content |
| Agent | `AgentTool/prompt.ts:435` selects fork examples or the prime-function example | Removing one example does not remove every example in every mode |

All paths in this table are under `src/tools/`.

**Verified limitation:** These establish description construction and selection.
They do not establish the enabled tool roster in every live session or prove that
a downstream provider adapter leaves every field unchanged. No combined "tool
prompt savings" figure is claimed.

## 3. Decisions

### D1. Retain explicit writing guidance; narrow S4's proposed deletion

**CONFIRMED** by the main session; the quoted Astra sentence is verbatim.

**Verified Cat text:** [gpt.ts:341-345](../../src/constants/promptStyles/gpt.ts:341)
teaches audience calibration, flowing prose, sentence continuity, brevity, and
leading with the action.

**Verified Codex text:** The installed Astra template says "Let each sentence
build on what came before." It also prescribes connected prose, paragraph
organization, purposeful technical detail, and presenting evidence in an order
that makes the conclusion assessable. Sol also teaches audience calibration,
plain language, and outcome-first technical communication.

**Decision: contradicts S4's rationale**, while allowing selective compression.
Do not classify sentence-level communication guidance as obsolete merely because
the model can write. Retain audience and expertise matching, connected
explanations, outcome-first reporting, relevant evidence and material
limitations, and meaningful progress updates. Remove only repetitions that leave
those requirements intact.

**Suspected benefit:** Keeping a coherent editorial standard will better preserve
the operator's preferred output than replacing it with "be clear and concise."
The comparison supports retaining the subject matter; it does not prove every
current sentence is necessary.

### D2. Add an exception to "no restating" for self-contained final answers

**CONFIRMED** by the main session on both sides.

**Verified Cat text:** [gpt.ts:349](../../src/constants/promptStyles/gpt.ts:349)
prohibits repeating conclusions or status already communicated in the
conversation.

**Verified Codex text:** Both supplied templates require a fully self-contained
final answer because earlier commentary may be collapsed.

**Decision: adds to S4.** Preserve the ban on repetitive progress narration, but
explicitly permit the final answer to restate the outcome, verification, and
unresolved limitations. Suggested wording:

> Avoid repeating progress updates. Make the final answer self-contained,
> including the outcome, relevant verification, and anything unresolved, even
> when these appeared earlier.

**Product boundary:** Do not import Codex's exact claim about collapsed
commentary unless Cat Code's active renderer behaves that way. The
self-contained-answer requirement is useful independently.

### D3. Adopt "prepare the concrete result before asking"; retain authorization boundaries

**Verified Cat text:** [gpt.ts:181-204](../../src/constants/promptStyles/gpt.ts:181)
classifies actions and includes a second decision checklist. It already
recognizes scoped authorization from live and durable instructions.

**Verified Codex text:** Installed Astra requires completing authorized
preparation before asking for approval of the final external action. It also
requires explaining what caused a necessary approval request.

**Decision: confirms S1's checklist deletion and adds a positive execution
rule.** Keep the authoritative action policy once. Add:

> Complete authorized preparation before requesting approval for the remaining
> gated action. Explain which action requires approval and why.

**Retain:** Cat Code's explicit authorization scope, denial handling, hook
limits, shared-state protections, and prohibition on bypassing safeguards.
Codex's examples involving worktrees or PRs are not permission to override this
repository's workflow.

### D4. Preserve request intent explicitly, including analysis-only work

**Verified Cat text:** [gpt.ts:149-151](../../src/constants/promptStyles/gpt.ts:149)
contains the snake-case example and capability encouragement.

**Verified Codex text:** Astra still explains that action-shaped requests should
result in action. Sol separately distinguishes answering, reviewing, diagnosing,
changing, and monitoring. Its persistence instruction does not broaden
authorization.

**Decision: partly confirms and partly qualifies S2.** Drop the snake-case
demonstration and capability compliment. Retain concise intent guidance, and add:

> A request to inspect, explain, review, or diagnose does not by itself authorize
> implementation. Persistence means completing the authorized scope.

The comparative evidence does **not** support deleting intent guidance
altogether.

### D5. Use Astra's relevance judgment for unnamed skills

**CONFIRMED** by the main session; the quoted Astra sentence is verbatim.

**Verified Cat text:** [SkillTool/prompt.ts:178-198](../../src/tools/SkillTool/prompt.ts:178)
makes matching skills a blocking requirement before any other response. It also
prohibits mentioning a skill without invoking it.

**Verified Codex text:** Installed Astra distinguishes an explicitly named skill
from an optional skill that would materially help, and says "Do not use a skill
based solely on keywords, superficial relevance, or the availability of a
potentially applicable skill." Installed Sol retains a stricter matching rule.

**Decision: adds to T4.** For the GPT path, prefer Astra's relevance test for
unnamed skills. Keep explicit user invocation binding. Also remove the absolute
prohibition on merely mentioning an uninvoked skill: explaining that a skill is
unavailable should not require invoking it.

Because Sol differs, treat this as a deliberate Cat Code policy choice informed
by Astra, not a unanimous Codex practice.

**Retain:** Skill naming, invocation arguments, built-in-command exclusions, and
the existing rule against reinjecting instructions that remain visible.

### D6. Keep tool guidance conditional on actual availability

**Verified Cat text:** Skill and Bash descriptions already contain
provider/tool-dependent selection. The transcript section also distinguishes a
preferred session-reading tool from raw-event fallback.

**Verified comparator text:** OpenClaw distinguishes tool usage advice from
actual availability. Hermes inserts session-search guidance only when
`session_search` is in the available tool names.

**Decision: confirms T3's configuration-aware approach; adds an assembly
requirement to T4 and S5.** A rule moved into a tool description can replace a
system copy only when that description is available on the affected path. A skill
or instruction file naming a tool does not make it callable.

**Suspected benefit:** Prevents deduplication from creating missing guidance in
custom prompts, restricted sessions, or deferred-tool configurations.

### D7. Correct TodoWrite's completion state; remove pedagogical scenarios

**CORRECTION (main session):** TodoWrite is disabled in interactive sessions and
live only in non-interactive `-p` runs; see section 0. This remains worth fixing
because the delegation lane is `-p`, but it is not a default-session change and
should not head an apply tranche.

**CORRECTION (main session):** the contradiction spans three locations, not one:
`prompt.ts:161`, `prompt.ts:207`, and `prompt.ts:238`.

**Verified Cat text:** The TodoWrite description requires exactly one item to be
`in_progress`, and its tool description line requires at least one at all times.

**Verified implementation:** [TodoWriteTool.ts](../../src/tools/TodoWriteTool/TodoWriteTool.ts)
explicitly handles an all-completed list and clears the stored list. The prompt's
perpetual requirement does not describe that finished state.

**UNRESOLVED (main session):** the report's "at most one" attribution to Codex's
task tool does not appear in the local Astra template and was cited to Rust
source that this verification did not read.

**Decision: confirms T2 and adds a concrete correction.** Replace "exactly one"
with "at most one," with zero active items when complete. Remove the Claude
scenarios and performative motivation. Remove the GPT recap where it merely
repeats activation criteria. Retain Cat's `content`/`activeForm` requirements.

**Product difference:** Do not import Hermes' `cancelled`, nesting, or merge
semantics; those belong to a different tool contract.

### D8. Deduplicate shell instructions, but preserve Cat's directory and waiting semantics

**Verified Cat text:** [BashTool/prompt.ts:319-325](../../src/tools/BashTool/prompt.ts:319)
repeats mutation and routing guidance from the GPT system prompt.

**Verified Codex text:** Installed Sol directs local edits through `apply_patch`,
with exceptions for formatting and mechanical rewrites. Its Rust command tool
separately documents the working directory and continuation session identifier.

**Decision: confirms T3's deduplication; contradicts treating the underlying
instructions as unnecessary.** Keep one complete, reachable owner of each rule.

**Verified product difference:** Cat's foreground Bash can change the main
session's directory for later tools; agent-thread `cd` behaves differently. Codex
documents a command working directory defaulting to the turn's directory. These
descriptions are not interchangeable.

**Retain:** Cat's directory persistence, non-persistent shell state, background
notification behavior, and patch-base rules. Removing these mechanics would force
the model to guess.

### D9. Delete the toy delegation example; preserve lifecycle and authorization rules

**Verified Cat text:** [AgentTool/prompt.ts:214-237](../../src/tools/AgentTool/prompt.ts:214)
invents a `test-runner` and delegates after writing a prime-number function.

**Verified Codex text:** Its inspected agent description distinguishes bounded
parallel work from immediate blockers, and separates role-selection guidance from
authorization to spawn.

**Decision: confirms T1 and adds a guard against role descriptions becoming
permission.** Delete the prime-function story. Keep the scope and context
supplied to the worker, parent responsibility for the result, running-versus-
stopped continuation rules, and tool availability and permission constraints.

**Verified product difference:** OpenClaw's spawn schema distinguishes
isolated/forked context and visible/persistent session behavior. Those are not
reasons to collapse Cat's peer/subagent distinction.

### D10. Extend the delegation audit to TodoWrite's conditional result nudge

**CONFIRMED (main session):** the nudge exists and is quoted accurately; its gate
is `feature('VERIFICATION_AGENT')` and `tengu_hive_evidence` and no
`context.agentId` and all items complete and at least three items and no item
matching `/verif/i`. It lives in `mapToolResultToToolResultBlockParam`, outside
every `prompt.ts` file, so no prompt-surface audit would have found it.

**CORRECTION (main session):** it fires only where TodoWrite is enabled, which is
non-interactive `-p` runs only.

**Verified Cat text:** [TodoWriteTool.ts](../../src/tools/TodoWriteTool/TodoWriteTool.ts)
appends a tool-result instruction requiring a verification-agent spawn when a
qualifying list is closed.

**Verified comparison:** Codex's inspected agent description says role guidance
does not itself authorize spawning. Cat's result nudge instead issues a direct
spawn instruction.

**Decision: adds to T1, T2, and T5.** Review this result-producing path alongside
prompt edits. Otherwise removing delegation examples may leave another
instruction that pushes the same behavior. This is not authorization to remove
it: determine whether it represents an intentional workflow requirement or an
obsolete heuristic, and preserve the existing authority boundary.

### D11. Simplify transcript examples; do not import another harness's memory workflow

**Verified Cat text:** [prompts.ts:1250-1303](../../src/constants/prompts.ts:1250)
supplies transcript paths, prefix resolution, example queries, and a metadata
specimen.

**Verified Hermes text:** Hermes gives a relevance trigger for recalling prior
sessions, while its assembly gates that guidance on tool availability. Its memory
guidance separately distinguishes durable facts from task-specific procedures.

**Decision: supports S5's narrower cut.** Retain the paths, unambiguous
resolution, preferred tool, raw-event fallback, and lineage instructions. Remove
generic query demonstrations where the remaining contract is sufficient.

**Product difference:** Do not introduce Hermes' skill-writing or memory-saving
workflow as a replacement. That would change Cat's persistence policy rather than
simplify transcript instructions.

### D12. Preserve evidence requirements while removing universal verification recipes

**Verified Cat text:** [verificationAgent.ts:14-90](../../src/tools/AgentTool/built-in/verificationAgent.ts:14)
combines useful reporting requirements with motivational language, cross-domain
recipes, and a completion gate requiring build, tests, and an adversarial probe.

**Verified Codex text:** Installed Astra requires appropriate checks and required
gates, then discourages repeated or expanded testing without a concrete reason.
Sol scales verification to risk.

**Decision: supports T5, but changes its emphasis.** Remove theatrical persuasion
and universal recipes. State that applicable repository gates and the actual
change determine verification. Retain expected versus observed behavior, exact
commands and relevant output, honest skipped/blocked reporting, restrictions on
project writes, dependency installation and Git mutations, and relevant
failure-oriented probing.

A generic "run the suite" instruction must not override this repository's
explicit prohibition on bare root `bun test` or misclassify its known-red
baselines.

### D13. Comments must not create obligations on files they do not live in

**Origin:** an inbound proposal from a separate comment audit of this branch (592
files, roughly 44,000 branch-added comment lines). It reports that redundant
comments are largely absent — "restates the code" produced about 25 findings
across the whole corpus — and that the real defect is comments carrying a
maintenance obligation nobody can discharge: cross-file line citations, restated
constant values, counting claims, and status notes that outlived the work. It
proposes a rule and argues it belongs in the system instruction rather than a
project file.

**CONFIRMED independently (main session, 2026-09-06).** This branch carries 1,129
comment lines with `file.ts:NNN` citations across `src/` and `app/`. A spread
sample of 16 was resolved and the cited line read. Two resolved to the wrong file
through a basename collision in the checking script and were discarded. Of the
remaining 14, roughly half cite a line that says something unrelated:

| Comment claims | Cited line actually reads |
| --- | --- |
| `autoCompact.ts:373-374`, compaction behavior | a comment about `utils/api.js` and MCP client init |
| `sessionStorage.ts:3009` is `saveCustomTitle` | `const parentUuid =` |
| `PromptInput.tsx:1872` sets `evictAfter: 0` | `stopOrDismissAgent(task.id, setAppState)` |
| `agentToolUtils.ts:734` is `AgentToolResult.model` | a comment about logging `input_tokens` |
| `FileReadTool.ts:721` reaches `addLineNumbers` | `} satisfies ToolDef(...)` |

Four were accurate, including `genericProcessUtils.ts:20` landing exactly on
`isProcessRunning`. **Verified:** every wrong citation in the sample points at a
line that exists and reads as plausible code, so no lint can distinguish it from
a correct one. That matches the audit's finding that only 1.8% of citations are
mechanically detectable.

**Verified harm shape:** the audit reports one such comment — a window-size
derivation whose input constant had been replaced by a token — caused a
non-existent layout bug to be reported and retracted, costing a session. The
failure is false confidence rather than confusion: the comments read as precise.

**Decision: adopt, with the third clause revised.** The first two clauses hold as
proposed: never restate a value that exists in code, name the constant; never
cite a line number in another file, name the file and the symbol.

**Revision to the third clause.** "Never write status notes" is too broad, and
this repository supplies the counterexample: `prompts.ts:502` is
`// @[MODEL LAUNCH]: Remove this section when we launch numbat.` That is a status
note, it is accurate, and it is load-bearing, because it tells a reader the
section is conditional and names the event that retires it. The defect is a
status note with no owner and no trigger. Require a named trigger or a decision
reference instead of banning the category.

**Suspected, not established:** that the habit is induced rather than default. One
plausible mechanism is that the harness instruction to reference code as
`file_path:line_number` exists because it renders clickable in a terminal, where
the reader resolves it immediately and can check it on the spot. A comment is the
same syntax with neither property. If that is the leak, the clarification belongs
beside the rule that creates it, distinguishing a citation consumed now from one
that must survive a refactor. This was not tested.

**Placement.** `CLAUDE.md` §7 already governs comments and asks them to state
constraints code cannot show. It does not say a comment must not create an
obligation on a file it does not live in. That is one clause, and it belongs
there whether or not a system-level version happens.

## 4. Disposition of the original 15 groups

| Group | Comparative disposition | Action |
| --- | --- | --- |
| **S1** Action checklist | Confirms + adds | Delete the duplicate checklist; add concrete preparation before approval |
| **S2** Task/capability coaching | Partly confirms | Remove toy example and compliment; retain intent and scope guidance |
| **S3** Programming maxims | Suspected only | Narrow deduplication remains reasonable; comparator evidence does not establish model independence from these preferences |
| **S4** Communication guidance | Contradicts rationale + adds | Retain editorial guidance; permit necessary final-answer restatement |
| **S5** Transcript cookbook | Supports narrow cut | Keep fork paths and retrieval contracts; trim generic examples |
| **S6** Scratch/Learning examples | Mixed; unresolved | Claude's capture retains scratch examples. Learning-mode example removal remains unvalidated |
| **S7** Instruction wrapper | Supports precise authority framing | Remove overbroad exhortation only while preserving provenance and scoped durable authority |
| **T1** Agent toy example | Confirms + adds | Remove story; inspect other delegation triggers |
| **T2** TodoWrite examples | Confirms + adds, `-p` only | Remove scenarios; correct the active-state wording; inspect conditional result nudge |
| **T3** Shell duplication | Confirms conditionally | One reachable owner; preserve directory, mutation, and waiting contracts |
| **T4** Skill/plan examples | Partial support + adds | Trim redundant skill syntax examples; reconsider unnamed-skill triggers. Plan-mode examples need separate judgment |
| **T5** Verifier recipes | Supports revision | Preserve evidence and safety; use applicable checks rather than universal recipes |
| **T6** Planner phases/quota | Suspected only | No equivalent comparator planning-role evidence establishes that removing the three-example quota preserves quality |
| **T7** Implementor duplication | No new comparative validation | Keep the prior internal case separate; the dirty source was not treated as current evidence |
| **T8** Coordinator stories | No new comparative validation | Remains a latent-path candidate, not an established default-session improvement |

**Verified methodological distinction:** Lack of an equivalent in the inspected
comparator surface is not proof of absence from that harness, and absence would
not prove a model no longer needs the instruction.

## 5. Fork-specific text that should remain

**Verified:** Cat's [corePolicy.ts](../../src/constants/corePolicy.ts) identifies
authority, provenance, security assistance, and truthful reporting as
cross-provider invariants. Its runtime metadata rule explicitly addresses the
distinction between system-attached metadata and identical-looking text inside a
payload.

**Decision:** Retain these semantics. Removing them would change trust and
authorization, not remove elementary coaching.

**Verified:** The repository's `CLAUDE.md` records shared-tree discipline,
live-state protections, locked architectural decisions, and the desktop security
baseline.

**Decision:** Retain those constraints even where comparators omit or contradict
them. A model cannot infer which concurrent edits belong to another session,
which repository actions have durable authorization, which wire shapes and
inbound allowlists are locked, which process or GUI actions affect the operator's
live work, or which renderer-specific file-link format is required.

**Verified:** Codex's freeform patch tool also carries a grammar contract. Its
brief prose description is not evidence that patch syntax is absent from the tool
surface.

**Decision:** Do not cut Cat's patch grammar or contextual examples merely
because another tool's description field looks shorter.

## 6. Recommended apply order and remaining uncertainty

**Recommended first tranche**, reordered by the main session's verification so
that default-session changes come before `-p`-only ones:

1. Remove S1's duplicate checklist and T1's toy example. Both are pure deletions
   justified by Cat Code's own text, independent of any comparator.
2. Preserve S4's editorial requirements while removing literal repetition.
3. Add the self-contained-final exception (D2).
4. Correct TodoWrite's active-state wording and trim T2's Claude scenarios,
   noting that neither reaches an interactive session.

**Recommended second tranche:** Configuration-aware T3 deduplication;
Astra-style unnamed-skill selection; verifier-policy revision; investigation of
the conditional TodoWrite nudge.

**Separate from the prompt-source tranches:** D13 changes `CLAUDE.md` §7, not
`src/constants/`, so it does not interact with any group above and can land on its
own. It is the best-evidenced item in this report.

**Suspected and requiring behavioral evaluation:** Whether removing the remaining
writing examples, Learning examples, planner quotas, or verification recipes
improves outcomes on Astra, Sol, and the actual worker models. Comparator
practice supplies hypotheses, not measured ablation results.

**Verified limitations:**

- No exact tool-rich outbound Cat request was captured.
- Public comparator tool sources were not pinned to the installed binaries.
- Local OpenClaw and Hermes deployment correspondence remains unchecked.
- Claude's current tool-description content remains outside the captures.
- No engine or desktop batteries were run, because no source files changed.

**Apply recommendation:** The comparative evidence supports targeted subtraction
and several additions. It does not support treating stronger models as a reason
to remove instructions that define this fork's permissions, interfaces, or
preferred communication behavior.
