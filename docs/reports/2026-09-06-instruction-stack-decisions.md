# Instruction stack: what we found and what we would change

**Date:** 2026-09-06
**Status:** Nothing applied, and every item is open. A2, A5, B4 and D3 were
applied in `0b177104` and reverted in `7455159e` on the operator's instruction, to
reopen the whole set rather than carry a partly-applied plan. Both files were
restored byte-for-byte. The measurements below are unaffected: what was withdrawn
is the decision to apply, not the evidence.

**This is the document to read.** It supersedes the working files listed at the
end, which stay as the evidence record. Where they disagree with this file, this
file is current: several of their conclusions were reversed by later work.

---

## 1. The question, and the answer

The premise was that models keep getting stronger, so a harness should need to
tell them less, and ours had grown instead.

**As a historical trend, that is false, and it was tested.** Six harnesses were
examined. OpenCode cut its GPT template from 2,176 to 1,492 words in a commit
that says so outright. Goose cut 508 words to 222, then to 176. But Cline grew
813 to 1,065, and what it added was parallel-tool-call guidance with examples.
Gemini's branch specifically for modern models still teaches context economics
and engineering standards. Claude Code did not shrink; it replaced enumerated
tool instructions with prose sections. And Codex's own ladder runs 21,544 chars
for `gpt-5.2`, 12,896 for `5.4`, 19,754 for `5.5`, 17,730 for `5.6`, and 21,261
for `gpt-6-astra`. Template size tracks model family and role, not recency.

**As a direction, a narrower version survives.** Between its `gpt-5.2` and its
newest templates, OpenAI deleted "Fix the problem at the root cause", "Avoid
unneeded complexity", and "Do not attempt to fix unrelated bugs or broken tests",
halved its execution guidance and its skills mechanics, and spent the budget on
permission, autonomy, and communication instead. Elementary coaching is what got
retired. Product contracts and permission rules grew.

**What this means for us.** No argument in this document rests on making the
prompt smaller. Every change below is justified because our text contradicts our
own code, repeats itself inside one request, or names something that does not
exist. That is a deliberate change of footing: the size argument did not survive,
and the defects do not need it.

## 2. What we measured

Base prompts, product-authored text only, excluding tool schemas and loaded
instruction files:

| | Cat Code (GPT) | Codex `gpt-6-astra` | Claude Code |
|---|---:|---:|---:|
| Total | 24,680 | 21,261 | 11,177 |
| How to do the work | 6,692 | 2,642 | 2,019 |
| How to talk to the user | 4,136 | 10,293 | 1,603 |
| Permission and care | 2,774 | 3,712 | ~600 |

Our one clear outlier is execution coaching: we spend two and a half times what
either comparator spends telling the model how to do the work, and we are the
lightest of the three on permission relative to our size. Claude Code's figure is
one captured configuration from 2026-08-12 and excludes its MCP browser block.

Tool descriptions are the larger surface and were never compared before:
**42,328 characters across 27 tools** in the default preset pool, against a
24,680-character system prompt. A second measurement using the dev-full feature
set and a 30 or 33 tool pool produced 45,532 and 49,637. Neither figure
supersedes the other; they are different configurations. Source files total
153,641 characters, which is inventory, not emitted text, and is not used
anywhere as a saving.

## 3. What we would change

Grouped by reason, because the risk differs. Nothing here is applied.

| Item | Shape | What it does | Why | Status |
|---|---|---|---|---|
| **A1** | cut | Delete the GPT decision checklist | Its four decisions are stated in the same section, fifteen lines above | Reviewed, ready |
| **A2** | cut | Delete AgentTool's prime-number example | Tells the model to spawn a reviewer because code was written, which our own policy contradicts | Open. Inherited text; upstream deleted it, see §3a. Applied then reverted |
| **A3** | cut | Drop the snake-case example and "You are highly capable" | Teaches ordinary coding-assistant behavior. **"Absent from all three comparators" was wrong:** Claude Code ships both verbatim today, only Codex lacks them | Open, and re-scoped by the craft-coaching report |
| **A4** | cut | Remove two restated sentences, GPT path only | "The right complexity level is exactly what the task requires" restates SCOPE | Narrowed after review, ready |
| **A5** | tweak | Drop all four Skill invocation examples, state the syntax instead | All four are inherited and upstream deleted all four, keeping the namespace syntax as prose | Open. Widened by the provenance scan; applied then reverted |
| **A6a** | tweak | Correct TodoWrite's "Exactly ONE in_progress" | The code clears the list on completion, so the stated invariant is impossible | `-p` runs only |
| **A6b** | cut | Drop TodoWrite's eight narrated scenarios | Teaching material | Claude path only |
| **A7** | investigate | Audit the verification-agent nudge | Live on the default interactive path, forces an agent spawn, has no tests | Investigation only |
| **B1** | add | Let the final answer restate the outcome | RULE 6 as written forbids the summary a user needs after a long run | Reviewed, ready |
| **B2** | add | Finish authorized preparation before asking approval | We say when to stop, never that the work up to the gate should be done first | Reviewed, ready |
| **B3** | add | "Analysis does not authorize implementation" | Guards the opposite failure from A3's removal | Modify: belongs in the Actions section |
| **B4** | tweak | Replace the absolute skill trigger with relevance | "NEVER mention a skill without calling this tool" makes it impossible to say a skill does not fit | Open. Inherited; upstream removed it after 2.1.215, and its replacement wording is available to lift. Applied then reverted |
| **D1** | not ours | Write's description names `Edit`, which the GPT pool does not expose | `getProviderFileEditTool()` returns `FilePatchTool` on the OpenAI path | **Another session is fixing it.** Do not touch |
| **D2** | tweak | TaskGet says require an empty `blockedBy` | `TaskListTool` filters completed prerequisites out of its own `blockedBy`; TaskGet does not, so a finished prerequisite blocks forever | Verified, unplanned |
| **D3** | tweak | Agent says "outputs should generally be trusted" | `CLAUDE.md` says a subagent's output is the parent's to verify | Open. Text drafted in the apply plan, Part D, using upstream's replacement wording. Applied then reverted |
| **D4** | investigate | Agent's result tells the parent to end its turn while its description permits continuing | Text conflict verified; behavior not measured | Investigation only |

### 3a. The upstream measurement, and what it settled

Added 2026-09-06, after the table above was written. A2 and D3 were both argued
from our own text alone. Measuring the fork's ancestor changed the standing of
both, and neither is now a judgment call.

**Both are inherited, and upstream deleted both.** `git blame` puts the
`currentExamples` body and the trust sentence in `86051a8e`, the initial private
publish snapshot, so neither is our work. Counts below are over both the UTF-8 and
the UTF-16LE literal tables, since upstream stores strings in two.

| String | Fork point 2.1.87 | Upstream 2.1.214 to 2.1.239, 19 builds |
|---|---:|---:|
| `isPrime` | 1 | **0 in every build** |
| `greeting-responder` | 5 | **0 in every build** |
| `example_agent_descriptions` | present | **0 in every build** |
| `outputs should generally be trusted` | 1 | **0 in every build** |
| `Trust but verify` | 0 | **4 in every build** |

Upstream removed A2's structure rather than its story, and swapped D3's sentence
for its inverse in the same bullet list, confirmed by a neighbouring bullet both
builds share verbatim. The only `test-runner` string surviving upstream is the
parallel-launch sentence we also carry at `AgentTool/prompt.ts:420`, which A2 does
not touch.

**What this settles.** A2's stated risk was that the non-fork path would be left
with no worked example; upstream's Agent description has had none across all 19
builds, with the mechanics in prose bullets instead. D3's wording question is
settled by adopting upstream's sentence unmodified, which the operator chose over
the audit's own replacement and over a hybrid; the apply plan records the accepted
gap, that upstream's sentence covers code changes and not claimed external actions.

**It also overrides one of our own recommendations.** The 2026-09-05 peer-sessions
audit advised keeping the test-runner example because it "carries the mechanics
alone". That predates this comparison.

**Extended to every item, same day.** The scan was then run across the rest of the
plan; the full table lives in the apply plan under "Provenance". In short: A5 and
B4 are drift too, and both were widened to match upstream, B4 lifting its
replacement wording rather than composing it. A3a, A3b, A6a, A6b and D2 are **not**
drift, because upstream still ships all five unchanged, so A6a and D2 are defects
this fork shares with upstream rather than introduced. A1, A4a, A4b, B1 and D4 are
ours and were never upstream's. A4's review reversal is confirmed: upstream keeps
the maxim it restored. Two long-string searches produced false zeros before every
absence was re-probed with short fragments, which is why the table records
fragments rather than sentences.

**One live incident, already acted on.** The sibling `greeting-responder` example
in the same block was deleted in `ba285305` after session `13a6bfc5` spawned a
subagent for "Hi" and quoted the example as its reason. So the mechanism by which
this block is read as instruction rather than illustration is demonstrated, not
suspected, even though A2's own effect remains unmeasured.

### 3b. Shape, and why the table above reads as smaller than it is

Added 2026-09-06. The status column above says what state each item is in. It does
not say what **shape** the edit has, and this file's own framing, plus the apply
plan's Part A "deletions" and Part B "additions", offered only two.

Of the sixteen items, five are cuts (A1, A2, A3, A4, A6b), **five are tweaks**
(A5, A6a, B4, D2, D3), three are additions (B1, B2, B3), two are investigations
(A7, D4), one is a rule choice (C1), and one belongs to another session (D1).

The five tweaks are currently filed under deletions or additions because there was
no third slot. That is not only untidy: cut-versus-add is a size axis, so it made
character count the default measure of a programme that was mostly not about size.
When the four applied items were measured, four of their six hunks turned out to
be rewrites. The full classification, the measurement behind it, and the third
option it opens for the craft slice are in the apply plan under "Shape".

### The three defects worth understanding

**A2 and D3 point the same way.** One tells the model to delegate because code
was written; the other tells it to trust what comes back. Together they encourage
spawning a reviewer and then believing it. `CLAUDE.md` says the opposite on both
counts, and so does current upstream, per §3a.

**D1 is a live bug on our main path.** Every GPT session reads "check whether
Edit is the better tool" for a tool that is not in its pool. Another session
found it independently and is mid-fix. One note for whoever owns that change: it
selects the patch tool from an `ordered` flag rather than from the enabled pool,
which is a proxy for the pool rather than the pool. If those diverge, the defect
returns.

**D2 is self-defeating.** Read literally, TaskGet's tip prevents ever starting a
task whose prerequisite has completed, because the completed id stays in the list
it tells you to check. Claude Code carries the same tip, so copying upstream
would have preserved it.

## 4. Open, and needing your decision

**The comment rule.** `CLAUDE.md` already bans status notes outright. That rule
forbids `src/constants/prompts.ts:502`, `// @[MODEL LAUNCH]: Remove this section
when we launch numbat.`, which is accurate and names its own retirement event.
Either keep the ban and convert that comment, or soften the rule to permit a note
carrying a named trigger. The reviewer recommends keeping the ban. The claim that
the repository relies on that comment is inference, not evidence.

**Whether additions are in scope at all.** B1 through B4 add text. The original
brief was subtraction. Each addresses a real tension, and none has measured harm
behind it; they can be dropped without affecting anything else.

## 5. What we deliberately did not pursue

Trimming transcript guidance, learning-mode examples, verifier recipes, and the
planner's example quota all rest on the untested claim that current models no
longer need them. Deduplicating the Bash and system-prompt copies needs
tool-availability work rather than a text edit. The implementor agent's
duplicated paragraph sits in a file another session has dirty. Coordinator-mode
cuts save nothing, because `COORDINATOR_MODE` is not in the build's feature list.

## 6. What nothing here establishes

No ablation was run. Every claim that a model performs better without some text
is suspected, and is labeled that way in the source reports. What can be shown is
that a sentence contradicts our code, repeats itself, or names something absent.
That is the whole basis for acting.

The measurement that would change this is cheap and has not been done: run a
fixed task set against the current prompt and against one cut group at a time, on
the models actually in use, and compare scope errors, boundary violations,
unnecessary tool calls, and output quality. Until then, "the model no longer needs
this" is a hypothesis and the defects are the evidence.

## 7. Where everything is

Start here, go outward only when you want the evidence behind a claim.

### Today's chain, in the order it happened

Each partly corrected the one before it, which is why this file exists. Read them
for provenance, not conclusions.

1. [Subtraction report](2026-09-06-instruction-stack-subtraction.md) — the first
   pass. 15 candidate cut groups, judged purely on our own text with no external
   reference. Its S4 was later reversed and its TodoWrite scope was wrong.
2. [Comparative decisions](2026-09-06-instruction-stack-comparative-decisions.md)
   — the outward pass against Claude Code, Codex, OpenClaw and Hermes. Reversed
   S4, corrected the nudge scope, found the comment rule already applied.
3. [Tool-description audit](2026-09-06-tool-description-comparative-audit.md) —
   the only pass over the tool surface, and the one that found real bugs.
   D1 through D4.
4. [Apply plan](../plans/2026-09-06-instruction-stack-apply-plan.md) — the exact
   before and after text, grouped by reason. Parts A to C are the base prompt;
   Part D, added 2026-09-06, carries D3. Its A2 and D3 entries hold the upstream
   measurement summarised in §3a. This is the file to open when implementing.

### Open, awaiting a decision

- [GPT craft-coaching decision](2026-09-06-gpt-craft-coaching-decision.md) — the
  follow-on to section 2 of this file. It splits the 6,692-character execution
  outlier into craft coaching, which both vendors retired, and autonomy rules,
  which both are growing, then offers two sizes of cut to the craft half: 266
  characters resting on our own redundancy, or 1,099 resting on Codex's judgment
  for the GPT path. Verified against the installed Codex binary and all nineteen
  Claude Code builds. **If adopted it supersedes A3 and A4 above**, which were
  scoped before that split existed.

### Where the prompts actually live

- [Prompt surfaces router](../prompts/2026-04-30-prompt-surfaces.md) — which file
  owns which prompt. Open this before searching for any prompt text. Its
  Start Here section now points back here.
- `CLAUDE.md` §7 — the comment rule that is already applied, and the subject of
  the open decision in section 4 above.
- [Peer-session instruction surface](../prompts/2026-09-05-peer-sessions-instruction-surface-audit.md)
  — the desktop-only addendum, out of scope for everything above.

### Prior prompt work, newest first

Dated files are historical records, not current truth, and several carry status
lines that were true when written and are not now. In particular, both August 23
reports say "nothing applied" while a later commit applied much of what they
proposed. Verify against source before acting on any of them.

- [GPT instruction-stack audit, 2026-09-05](2026-09-05-gpt-instruction-stack-audit.md)
  — the immediate predecessor. Its fixes landed; two findings remain open.
- [Prompt audit, 2026-08-23](2026-08-23-prompt-audit.md) — the removal half:
  what should already have left the core prompt.
- [Upstream delta, 2026-08-23](2026-08-23-anthropic-prompt-upstream-delta.md) —
  the addition half: what upstream text to bring in. Its `Delivering work` and
  `Corrections` imports did land.
- [Codex CLI prompt trend, 2026-08-20](2026-08-20-codex-cli-harness-prompt-trend.md)
  — Codex release-history measurements. Its conclusion that our GPT prompt needs
  no cut was rejected: relative length cannot establish that.
- [Upstream terminal capture, 2026-08-12](2026-08-12-upstream-baseline-no-mcp.md)
  — the verbatim Claude Code prompt behind the 11,177-character figure in
  section 2.
- [Upstream desktop capture, 2026-08-11](2026-08-11-upstream-delivered-system-prompt-capture.md)
  — the same, with MCP servers loaded. Upstream ships no prompt-dump flag, so
  these captures are the only exact evidence of what it sends.
- [Architecture comparison, 2026-08-10](2026-08-10-system-prompt-architecture-cat-vs-upstream.md)
  — the audit those two captures support.
- [Divergence ledger, 2026-08-10](2026-08-10-cat-code-upstream-divergence-ledger.md)
  — how this fork drifted from upstream, and the method used to measure it.
- [System-prompt content review, 2026-07-30](2026-07-30-system-prompt-content-review.md)
  and [pipeline audit, 2026-07-30](2026-07-30-system-prompt-pipeline-audit.md) —
  content versus assembly, reviewed separately.
- [GPT instruction-stack audit, 2026-07-11](2026-07-11-gpt-instruction-stack-audit.md)
  — the first audit of the effective GPT stack.
- [Prompt bias findings, 2026-04-30](2026-04-30-research-prompt-bias-findings.md)
  — the earliest, covering everything sent at inference time.

### Reviews that changed the conclusions above

Two independent reviews, neither written into a file of its own. One found the
verification nudge reaches interactive sessions through `TaskUpdateTool`,
correcting a claim that it was `-p` only. The other kept the
three-lines-over-abstraction maxim that A4 originally proposed cutting, because
it governs existing repetition, which nothing else in that rule covers. Both are
recorded in the documents they corrected.
