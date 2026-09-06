# Instruction stack: what we found, and what is open

**Date:** 2026-09-06
**Status:** Nothing applied. All eighteen items open.
**This is the document to read.** Everything else listed in section 8 is either
the implementation text or the evidence behind a claim here.

A2, A5, B4 and D3 were applied in `0b177104` and reverted in `7455159e` on the
operator's instruction, to reopen the set rather than carry a partly-applied plan.
Both files were restored byte-for-byte. **The measurements are unaffected by that
revert:** what was withdrawn is the decision to apply, not the evidence.

---

## 1. The original question, and what survived of it

The premise was that models keep getting stronger, so a harness should need to
tell them less, and ours had grown instead.

**As a historical trend that is false, and it was tested.** Six harnesses were
examined. OpenCode cut its GPT template from 2,176 words to 1,492 in a commit that
says so outright; Goose cut 508 to 222, then 176. But Cline grew 813 to 1,065,
adding parallel-tool-call guidance with examples. Gemini's branch for modern
models still teaches context economics. Claude Code did not shrink, it replaced
enumerated tool instructions with prose. And Codex's own ladder runs 21,544 chars
for `gpt-5.2`, 12,896 for `5.4`, 19,754 for `5.5`, 17,730 for `5.6`, 21,261 for
`gpt-6-astra`. Size tracks model family and role, not recency.

**A narrower version survived.** Between `gpt-5.2` and its current templates
OpenAI deleted "Fix the problem at the root cause", "Avoid unneeded complexity"
and "Do not attempt to fix unrelated bugs or broken tests", and spent the budget on
permission, autonomy and communication instead. **Elementary craft coaching is what
got retired; autonomy and communication grew.**

**Narrowed 2026-09-06, twice, and the second narrowing is the important one.**

An earlier draft said "Codex has none of it". That is too broad as a claim about
the product: the checked-in `models-manager/prompt.md` does carry "Fix the problem
at the root cause", "Avoid unneeded complexity" and "Do not attempt to fix
unrelated bugs". But that file is the **fallback**, used when a model has no
backend `instructions_template`. All eight models in this machine's fetched
catalog have one — `gpt-6-astra`, `gpt-reserve`, `gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4-mini`, `codex-auto-review` — and across all
eight, `surgical precision`, `gold-plating`, `unneeded complexity`,
`minimal and focused`, `root cause` and `unrelated bugs` are **zero**. So the
guidance exists and is not sent to any model this fork runs.

**Confirmed from inside a live Codex session**, which is stronger evidence than any
artefact reading: asked what its own instructions contain, it reported *avoid
premature abstraction* **absent**, *prefer duplication over premature abstraction*
**absent**, *avoid unnecessary defensive code* **absent**. It reported *keep
changes minimal*, *avoid unrelated refactors* and *fix only what the task requires*
as approximately present — but carried by scope and authorization rules ("changes
belong to the user unless you know otherwise"), not by craft instruction, and
*avoid unnecessary complexity* only as a rule about **responses**, not code.

**So the retirement is uneven, and that matters for §5a.** Codex has a genuine
analogue to our `SCOPE`, framed as ownership rather than craft. It has no analogue
to `ABSTRACTION` or `ERROR HANDLING` at all. An option that deletes all five treats
those cases as identical when they are not.

**Verified 2026-09-06, on the corrected evidence.** The `gpt-6-astra` template —
the one this report compares against — contains no craft block at all. That is
checked directly in the template, and it is the load-bearing fact.
**An earlier version of this claim did not reproduce and is withdrawn:** it said
"of the installed binary's nine templates, seven carry no craft guidelines",
derived by splitting the binary at `You are Codex` openings. That segmentation
attributes text to the wrong template. Decoding the templates properly puts the
binary's surviving craft blocks in legacy `You are a coding agent. Please keep
going` strings, an older prompt lineage, not in the modern model templates. The
direction is unchanged and better supported; the method behind the old numbers was
not sound.

**What this means here.** No argument in this document rests on making the prompt
smaller. Each item stands because our text contradicts our own code, repeats
itself, names something absent, or is unreachable. That footing is deliberate: the
size argument did not survive, and the defects do not need it.

## 2. What we measured

Base prompts, product-authored text only, excluding tool schemas and loaded
instruction files:

| | Cat Code (GPT) | Codex `gpt-6-astra` | Claude Code |
|---|---:|---:|---:|
| Total | 24,680 | 21,261 | 11,177 |
| How to do the work | 6,692 | 2,642 | 2,019 |
| How to talk to the user | 4,136 | 10,293 | 1,603 |
| Permission and care | 2,774 | 3,712 | ~600 |

Claude Code's figure is one capture from 2026-08-12 and excludes its MCP browser
block, so it is a floor.

**⚠ The Codex column is not bucketed the same way as ours. Corrected 2026-09-06
after external review; read this before using the table.**

Its source is `~/.codex/models_cache.json`, `models[0].instructions_template`,
which is 21,261 characters — a **remote catalog value that changes on refresh**,
not a pinned binary. `gpt-6-astra` appears zero times in the installed Codex
binary, so any claim here "verified against the installed binary" does not cover
this model. The rows decompose as:

| Row | What it actually is in astra | Chars |
|---|---|---:|
| Work | `# Rules for getting work done` alone | 2,642 |
| Permission | `# When to ask the user for permission` 1,976 **+ `# Autonomy and persistence` 1,736** | 3,712 |
| Talk | nine communication sections | 10,293 |

**So Codex's autonomy text is counted as permission, while ours is counted as
work.** Our `PROACTIVE EXECUTION`, `EXPLORE RULE` and `INVESTIGATION DISCIPLINE`
total 1,914 and sit inside our 6,692. Bucketed consistently:

- work: Codex 4,378 against our 6,692 — **a 1.5× gap, not 2.5×**
- permission: Codex 1,976 against our 2,774 — **we outspend Codex**

As a share of each prompt, permission is 11.2% for us, 9.3% for Codex and 5.4% for
Claude Code, so **we are the heaviest of the three, not the lightest.** An earlier
version of this report said the opposite in both places; both statements are
withdrawn, and A1's standing changes with them (§3, §4).

The craft finding in §1 is unaffected: it was checked inside the astra template
itself, not derived from these rows.

**Method, reconstructed 2026-09-06** because the table shipped without one.
`./cli-dev --dump-system-prompt --model gpt-6-astra` emits exactly 24,680
characters, and the rows are our own top-level headings grouped: work =
`# Doing Tasks` 5,115 + `# Using Your Tools` 1,577; talk = `# Tone and Style` 936
+ `# Communicating with the User` 3,200; permission = `# Executing Actions with
Care` 2,774.

**Two caveats the table does not carry.** It covers 13,602 of 24,680 characters,
**55%** — `# System Rules`, `# Session-Specific Guidance`, `# Environment`,
`## Reading session transcripts` and the preamble are in no bucket, so no total
may be derived from these rows. The Codex column's own caveat is the boxed note
above: it is a different bucketing, from a remote catalog value rather than a
pinned artefact.

**Reading the two rows nobody worked.** Permission and care is *not* thin: four
concrete risky-action categories with examples, instruction authority, obstacle
rule. On the corrected bucketing we spend more on it than either comparator, so
there is no deficiency to close here at all. The
talk row is a **shape** difference: our 4,136 is overwhelmingly prohibitions (no
emojis, no restating, no em dashes, no engagement prompts), while astra spends
2,325 on `## Final answer` with its formatting and visualization subsections, 1,097
on `## Intermediate commentary` and 1,890 on `## Writing style`, and we have no
equivalent to any of them. We say what not to say; they say what to say. (Earlier
figures of 3,121 and 2,343 came from a `gpt-5.4` template, not from astra, and are
corrected here.)

**Tool descriptions are the larger surface** and were never compared: 42,328
characters across 27 tools in the default pool, against a 24,680-character system
prompt. A dev-full 30/33-tool pool gives 45,532 and 49,637 — different
configurations, not competing figures. The 153,641 characters across 40 source
files is inventory, not emitted text, and is used as a saving nowhere.

## 3. The eighteen items

Nothing here is applied. **Nothing here is waiting on a decision either**, after
2026-09-06: eight items are settled by the operator or by investigation, eight are
READY on evidence that needs no further judgment, one needs a runtime measurement,
and one belongs to another session. The only thing still genuinely open is
`ERROR HANDLING`'s fate inside §5a. **Shape** matters as much as status: the plan's Part A
"deletions" and Part B "additions" offered only two shapes, so five replacements
were filed as one or the other. Cut-versus-add is a size axis, which is how a
programme mostly about correctness came to be scored at "net −344 characters" — a
true number measuring nothing anyone intended.

Six cuts, five tweaks, three adds, two investigations, one rule choice, one
another session's. Seventeen are rows below; C1 is in §5.

| Item | Shape | What it does | Why | Status |
|---|---|---|---|---|
| **A1** | cut | Delete the GPT decision checklist | Its four decisions are stated sixteen lines above, at `gpt.ts:197` | **READY.** Verified redundancy; the permission-thinness caveat is withdrawn, see §2 |
| **A2** | cut | Delete AgentTool's prime-number example | Tells the model to delegate because code was written, which our policy contradicts | **READY.** Inherited; upstream deleted it; one live incident |
| **A3** | cut | Drop the snake-case example and "You are highly capable" | Ordinary coding-assistant teaching. **"Absent from all three comparators" was wrong**, but so was the correction: Claude Code ships the snake-case example verbatim on the Claude path, while our capability sentence is a fork rewrite that dropped a clause | **SUPERSEDED** by the craft decision, §5a |
| **A4** | cut | Remove two restated sentences, GPT path only | "The right complexity level is exactly what the task requires" restates SCOPE | **SUPERSEDED** by the craft decision, §5a |
| **A5** | tweak | Drop all four Skill invocation examples, state the syntax instead | All four inherited; upstream deleted all four, keeping the syntax as prose | **READY.** Inherited; upstream deleted all four. Applied then reverted |
| **A6a** | tweak | Correct TodoWrite's "Exactly ONE in_progress" | The code clears the list on completion, so the stated invariant is impossible | **READY.** Verified defect. `-p` runs only, so low reach |
| **A6b** | cut | Drop TodoWrite's eight narrated scenarios | Teaching material. ~5,841 chars, the largest single cut | **DECIDED: do it.** Claude path only, and a deliberate divergence: upstream still ships them |
| **A7** | investigate | Audit the verification-agent nudge | Its premise was wrong: the nudge is gated shut and has never fired | **ANSWERED.** Closed; produced A8 |
| **A8** | cut | Delete the unreachable verification nudge | Inherited, deleted upstream, gated shut here by a hardcoded `return false`, zero tests | **READY.** The only item that provably cannot change behavior |
| **B1** | add | Let the final answer restate the outcome | RULE 6 forbids the summary a user needs after a long run | **DECIDED: in.** The visible tip of the talk-row gap in §2 |
| **B2** | add | Finish authorized preparation before asking approval | We say when to stop, never that work up to the gate should be done first | **DECIDED: in**, and no longer unsupported: astra says "You MUST complete the work that is already authorized… before asking the user for permission as a final step" |
| **B3** | add | "Analysis does not authorize implementation" | Guards the opposite failure from A3's removal | **DECIDED: in.** Belongs in the Actions section |
| **B4** | tweak | Replace the absolute skill trigger with relevance | "NEVER mention a skill without calling this tool" makes it impossible to say a skill does not fit | **READY.** Inherited; upstream removed it after 2.1.215, replacement wording available to lift |
| **D1** | not ours | Write's description names `Edit`, absent from the GPT pool | `getProviderFileEditTool()` returns `FilePatchTool` on the OpenAI path | **Fixed only in the working tree**, not in HEAD (last commit `ea085822`). Another session's dirty file: do not touch, and do not assume it is safe |
| **D2** | tweak | TaskGet says require an empty `blockedBy` | `TaskListTool` filters completed prerequisites; TaskGet does not, so a finished prerequisite blocks forever | **READY.** Verified defect, and the only fix is a rewrite |
| **D3** | tweak | Agent says "outputs should generally be trusted" | `CLAUDE.md` says a subagent's output is the parent's to verify | **READY.** Upstream replaced this sentence; text drafted |
| **D4** | investigate | Agent's result tells the parent to end its turn while its description permits continuing | Text conflict verified; behavior not measured | **Needs a measurement**, not a decision: launch a background agent and observe |

### The defects worth understanding

**A2 and D3 point the same way.** One tells the model to delegate because code was
written, the other to trust what comes back. Together: spawn a reviewer, then
believe it. `CLAUDE.md` says the opposite on both counts, and so does current
upstream.

**D2 is self-defeating.** Read literally, TaskGet's tip prevents ever starting a
task whose prerequisite has completed, because the completed id stays in the list
it tells you to check. Claude Code carries the same tip, so copying upstream would
have preserved it.

**D1 is fixed, with one note for its owner.** It selects the patch tool from an
`ordered` flag rather than from the enabled pool — a proxy for the pool rather
than the pool. If those diverge, the defect returns.

## 4. What changed once someone measured

Six items' standing moved when checked against evidence rather than argued from
our own text. This is the session's real output.

**Fork drift, measured across the 2.1.87 SDK bundle and the builds in
`~/.local/share/claude/versions/`, both UTF-8 and UTF-16LE literal tables.** That
directory holds 19 files but **16 distinct versions** — three are `.orig-`
duplicates of a locally patched copy. Counts were identical across all of them, so
no conclusion moves, but "19 builds" overstated the independent evidence:

| String | Fork point | Upstream now |
|---|---:|---:|
| `isPrime` | 1 | **0 in every build** |
| `greeting-responder` | 5 | **0 in every build** |
| `example_agent_descriptions` | present | **0 in every build** |
| `outputs should generally be trusted` | 1 | **0 in every build** |
| `Trust but verify` | 0 | **4 in every build** |

- **A2 and D3 strengthened.** Both are inherited at `86051a8e` and both were
  deleted or replaced upstream. A2's stated risk — that cutting the example leaves
  the non-fork path with no worked example — is what upstream has shipped for 19
  builds. This also overrides our own 2026-09-05 peer-sessions audit, which
  advised keeping the example because it "carries the mechanics alone".
- **A5 and B4 are drift too**, and both widen: upstream deleted all four Skill
  examples and removed B4's absolute after 2.1.215, so B4's replacement can be
  lifted rather than composed. **A3a, A3b, A6a, A6b and D2 are not drift** —
  upstream still ships all five, so A6a and D2 are defects we *share* rather than
  introduced. **A1, A4a, A4b, B1 and D4 are ours.**
- **A1 was weakened, then restored.** It was downgraded on the grounds that its
  checklist trims the permission category, "the one category where both comparators
  outspend us". **That was wrong twice over**: Claude Code spends ~600 against our
  2,774, and once autonomy is bucketed consistently we spend more than Codex too
  (§2). A1 is back to what the first pass said, verified redundancy at
  `gpt.ts:197`, sixteen lines below the `PRIORITY RULE` it restates. The recall-
  device observation stands as a judgment, without a measurement behind it.
- **A3's stated reason was false, and so was the first correction.** "Absent from
  all three comparators" is wrong: Claude Code ships the snake-case example
  verbatim, on the Claude path. But "ships both verbatim" overshot. Our
  `highly capable and can handle ambitious tasks` has **zero** hits in any upstream
  build; upstream's is the longer "often allow users to complete ambitious tasks
  that would otherwise be too complex or take too long". Ours is a fork rewrite
  that dropped a clause, which matters for the craft decision in §5a.
- **A7's premise was overturned.** The nudge cannot fire: `isGrowthBookEnabled()`
  is exactly `is1PEventLoggingEnabled()`, a stub whose whole body is
  `return false`, and both overrides require `USER_TYPE === 'ant'`. Verified by
  executing the gate. So the warning that cutting A2 while the nudge stayed live
  would confound them was wrong — **A2 could have been judged alone throughout.**
- **A4's review reversal was confirmed.** Upstream keeps the three-lines maxim
  that a reviewer restored against the original draft.

**One live incident, not a hypothesis.** The `greeting-responder` sibling of A2's
example was deleted in `ba285305` after session `13a6bfc5` spawned a subagent for
"Hi" and quoted the example as its reason. The mechanism by which that block is
read as instruction rather than illustration is demonstrated. A2's own effect
remains unmeasured.

**Method note.** Two long exact-string searches produced false zeros before every
absence was re-probed with three short fragments. Counts are string presence, not
proof of a selected live branch.

## 5. Open, and needing your decision

**a. The craft-coaching slice — DECIDED 2026-09-06: follow Codex.** The operator's
call. Four of the five sections go; `SCOPE`'s framing question and `ERROR
HANDLING`'s exception are below. Recorded with the reasoning that changed while
deciding, because it makes two of these cuts much stronger than "Codex dropped it".

**A duplicate-with-CLAUDE.md argument was raised and then ruled out.** It was
noted that `~/.claude/CLAUDE.md` already states two of the five — "no speculative
features, no premature abstraction" covering `ABSTRACTION`, and "keep changes
minimal and related to the current request" covering `SCOPE` — so cutting them
would delete a duplicate rather than an instruction.

**The operator rejected that reasoning, and the ruling is broader than this item:
what a loaded instruction file happens to contain must not shape the system
prompt.** The prompt is the product and has to stand on its own; `CLAUDE.md` is
user configuration that can change, move, or be absent. Designing the prompt around
its current contents makes the product silently depend on a file it does not own.

Two consequences. The cuts rest on the Codex argument alone, which is what was
decided anyway. And the option of moving `ERROR HANDLING` into `CLAUDE.md` is
withdrawn, since that is the same dependency in the other direction.

**`ERROR HANDLING` therefore goes too, under the same rule.** Codex has no
equivalent, confirmed absent from inside a live session, so following Codex cuts
it. What that costs, stated plainly rather than buried: no loaded file and no
comparator carries this guidance, so afterwards the product does not say it at all,
to anyone. That is the choice, and it is consistent with the principle above rather
than an oversight.

**Sizes.** `ABSTRACTION` 256, `SCOPE` 352 (of which sentence 1 and the comment
rules are marked Keep in the craft report §4), `TASK DOMAIN` 216 of 336,
`CAPABILITY` 55 of 126. Per-sentence verdicts and exact strings are in the craft
report §4, which remains the implementation detail for this decision.

**b. The comment rule, reframed by the operator 2026-09-06.** The question was
put as "keep the blanket ban on status notes, or soften it". Both options were
wrong, because the category is wrong.

**The operator's principle:** *a good code comment should require very little
maintenance.* That is the goal the rule was invented to serve, after an audit found
a large stock of stale comments across the workspace. "Status note" was a proxy for
it, and a poor one.

Reframing on maintenance cost explains every existing clause instead of listing
them, and gives a test that applies to comment shapes nobody has thought of yet:

| Banned shape | Maintenance it demands |
|---|---|
| cross-file line citation | every edit to the *other* file |
| a restated value | every change to the constant |
| a counting claim | every addition or removal |
| a status note | every change of status |

And it settles the case that broke the old rule. `// @[MODEL LAUNCH]: Remove this
section when we launch numbat.` names the single event that deletes it, so it
demands **no** maintenance until that event, at which point it removes itself. It
is the opposite of the problem, and the blanket ban was catching it by shape rather
than by cost. Under the principle it stands as written.

**Two consequences.** The rule needs rewording around maintenance cost rather than
an enumerated ban, and the operator notes it belongs with the coding conventions
rather than where it sits. Both are edits to `CLAUDE.md`, which is the operating
manual rather than a report, so replacement wording is drafted for approval and not
applied.

**Worth stating plainly, since it is the reason this came up:** the model wrote a
rule that bans four shapes without naming what makes them bad, then applied it to a
comment that does not have the underlying defect. A principle would have caught
that; a list did not.

**c. Whether additions are in scope at all — DECIDED 2026-09-06: all three.** B1,
B2 and B3 are in. The subtraction-only framing of the original brief does not
survive: B1 fixes a rule that forbids the summary a user needs, B2 is stated almost
verbatim in astra, and B3 guards the failure A3's removal opens up. Recorded as the
operator's call; none has measured harm behind it and that remains true.

## 6. Deliberately not pursued

Trimming transcript guidance, learning-mode examples, verifier recipes and the
planner's example quota all rest on the untested claim that current models no
longer need them. Bash and system-prompt deduplication needs tool-availability
work, not a text edit. The implementor agent's duplicated paragraph sits in a file
another session has dirty. Coordinator-mode cuts save nothing, because
`COORDINATOR_MODE` is not in the build's feature list.

## 7. What nothing here establishes

**No ablation was run.** Every claim that a model performs better without some text
is suspected. What can be shown is that a sentence contradicts our code, repeats
itself, names something absent, or is unreachable. That is the whole basis for
acting, and it is why A8 is the only item whose "no risk" is a measurement.

**The ablation is deliberately not being run. Decided 2026-09-06.** The shape it
would take is known: a fixed task set against the current prompt and against one
cut group at a time, on the models actually in use, comparing scope errors,
boundary violations, unnecessary tool calls and output quality.

Two reasons it is skipped, and the second is decisive.

The items that most invite measurement are the ones whose answer does not depend on
it. D2's readiness check is wrong whatever a model does with it, A6a states an
invariant the code makes impossible, A8 is unreachable, and A2, A5, B4 and D3 are
text upstream itself removed.

What remains is the craft slice, roughly 1,100 characters of 24,680. **A 4.5%
change to the prompt is below what a cheap ablation can resolve.** Separating that
from ordinary run-to-run variance needs a large fixed task set and several runs per
arm, and no such task set exists — building it is the cost, not running it. An
underpowered version returns a number that looks like evidence and is not, which is
worse than having none.

**What is worth capturing, and costs nothing:** a prompt-text baseline.
`./cli-dev --dump-system-prompt` on the pre-change tree, diffed against the same
command afterwards, confirms exactly what left the emitted prompt and that nothing
else moved. That is the verification this plan already asks for, it needs no model
quota, and it must be taken **before the first edit** or it is not a baseline. The
figure to match is 24,680 characters.

## 8. Where everything else is

**To implement:** [apply plan](../plans/2026-09-06-instruction-stack-apply-plan.md)
— exact before-and-after text per item, the fork-drift provenance table, the shape
classification, and the A7 determination with the A8 spec.

**For the craft decision's detail:**
[GPT craft-coaching decision](2026-09-06-gpt-craft-coaching-decision.md) — every
sentence with a verdict, and a worked rewrite of `ERROR HANDLING` from 411
characters to about 160. Its decision is summarised in §5a above.

**Where prompts live:** [prompt surfaces router](../prompts/2026-04-30-prompt-surfaces.md).
Open it before searching for any prompt text. `CLAUDE.md` §7 owns the comment rule
in §5b. The [peer-session instruction surface](../prompts/2026-09-05-peer-sessions-instruction-surface-audit.md)
is the desktop-only addendum, out of scope here.

**Evidence, superseded for conclusions.** Read only to check a claim; several of
their conclusions were later disproved, including A3's.

- [Subtraction report](2026-09-06-instruction-stack-subtraction.md) — the first
  pass, judged on our own text with no external reference.
- [Comparative decisions](2026-09-06-instruction-stack-comparative-decisions.md) —
  the outward pass. It is the pass that should have caught the fork drift and did
  not: it names Claude Code as a comparator but cites it in three of thirteen
  sections and never opens a version binary.
- [Tool-description audit](2026-09-06-tool-description-comparative-audit.md) — the
  only pass over the tool surface. Source of D1 through D4.

**Prior prompt work**, historical records rather than current truth; verify against
source before acting on any of them. Both August 23 reports say "nothing applied"
while a later commit applied much of what they proposed.

[2026-09-05 GPT audit](2026-09-05-gpt-instruction-stack-audit.md) ·
[2026-08-23 prompt audit](2026-08-23-prompt-audit.md) ·
[2026-08-23 upstream delta](2026-08-23-anthropic-prompt-upstream-delta.md) ·
[2026-08-20 Codex trend](2026-08-20-codex-cli-harness-prompt-trend.md) ·
[2026-08-12 terminal capture](2026-08-12-upstream-baseline-no-mcp.md), the source
of the 11,177 figure ·
[2026-08-11 desktop capture](2026-08-11-upstream-delivered-system-prompt-capture.md) ·
[2026-08-10 architecture comparison](2026-08-10-system-prompt-architecture-cat-vs-upstream.md) ·
[2026-08-10 divergence ledger](2026-08-10-cat-code-upstream-divergence-ledger.md) ·
[2026-07-30 content review](2026-07-30-system-prompt-content-review.md) and
[pipeline audit](2026-07-30-system-prompt-pipeline-audit.md) ·
[2026-07-11 GPT audit](2026-07-11-gpt-instruction-stack-audit.md) ·
[2026-04-30 prompt bias findings](2026-04-30-research-prompt-bias-findings.md)

**Two reviews with no file of their own.** One found the verification nudge reaches
interactive sessions through `TaskUpdateTool`, correcting a `-p`-only claim — that
correction stands, and A7 later showed the nudge is unreachable on both paths. The
other kept the three-lines-over-abstraction maxim A4 proposed cutting, since it
governs existing repetition, which nothing else in that rule covers.
