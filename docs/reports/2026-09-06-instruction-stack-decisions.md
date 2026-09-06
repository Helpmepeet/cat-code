# Instruction stack: what we found and what we would change

**Date:** 2026-09-06
**Status:** Nothing applied. No prompt or tool source has changed.
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

| Item | What it does | Why | Status |
|---|---|---|---|
| **A1** | Delete the GPT decision checklist | Its four decisions are stated in the same section, fifteen lines above | Reviewed, ready |
| **A2** | Delete AgentTool's prime-number example | Tells the model to spawn a reviewer because code was written, which our own policy contradicts | Reviewed, ready. Largest behavior change here |
| **A3** | Drop the snake-case example and "You are highly capable" | Teaches ordinary coding-assistant behavior; absent from all three comparators | Reviewed, ready |
| **A4** | Remove two restated sentences, GPT path only | "The right complexity level is exactly what the task requires" restates SCOPE | Narrowed after review, ready |
| **A5** | Keep one Skill invocation example, drop three | Namespace syntax is product-specific; the bare forms are not | Reviewed, ready |
| **A6a** | Correct TodoWrite's "Exactly ONE in_progress" | The code clears the list on completion, so the stated invariant is impossible | `-p` runs only |
| **A6b** | Drop TodoWrite's eight narrated scenarios | Teaching material | Claude path only |
| **A7** | Audit the verification-agent nudge | Live on the default interactive path, forces an agent spawn, has no tests | Investigation only |
| **B1** | Let the final answer restate the outcome | RULE 6 as written forbids the summary a user needs after a long run | Reviewed, ready |
| **B2** | Finish authorized preparation before asking approval | We say when to stop, never that the work up to the gate should be done first | Reviewed, ready |
| **B3** | "Analysis does not authorize implementation" | Guards the opposite failure from A3's removal | Modify: belongs in the Actions section |
| **B4** | Replace the absolute skill trigger with relevance | "NEVER mention a skill without calling this tool" makes it impossible to say a skill does not fit | Modify: separate discussing a skill from requesting it |
| **D1** | Write's description names `Edit`, which the GPT pool does not expose | `getProviderFileEditTool()` returns `FilePatchTool` on the OpenAI path | **Another session is fixing it.** Do not touch |
| **D2** | TaskGet says require an empty `blockedBy` | `TaskListTool` filters completed prerequisites out of its own `blockedBy`; TaskGet does not, so a finished prerequisite blocks forever | Verified, unplanned |
| **D3** | Agent says "outputs should generally be trusted" | `CLAUDE.md` says a subagent's output is the parent's to verify | Verified, unplanned |
| **D4** | Agent's result tells the parent to end its turn while its description permits continuing | Text conflict verified; behavior not measured | Investigation only |

### The three defects worth understanding

**A2 and D3 point the same way.** One tells the model to delegate because code
was written; the other tells it to trust what comes back. Together they encourage
spawning a reviewer and then believing it. `CLAUDE.md` says the opposite on both
counts.

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
   before and after text for every base-prompt item, grouped by reason.

### Where the prompts actually live

- [Prompt surfaces router](../prompts/2026-04-30-prompt-surfaces.md) — which file
  owns which prompt. Open this before searching for any prompt text.
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
