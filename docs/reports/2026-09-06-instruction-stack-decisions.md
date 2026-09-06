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

**A narrower version survived, and was later confirmed against the shipped
binary.** Between `gpt-5.2` and its current templates OpenAI deleted "Fix the
problem at the root cause", "Avoid unneeded complexity" and "Do not attempt to fix
unrelated bugs or broken tests", and spent the budget on permission, autonomy and
communication instead. **Elementary craft coaching is what got retired; autonomy
and communication grew.** Verified 2026-09-06 in the installed Codex binary: of
its nine templates, seven — including every modern `based on GPT-5` coding
template — carry no craft guidelines at all.

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

**Method, reconstructed 2026-09-06** because the table shipped without one.
`./cli-dev --dump-system-prompt --model gpt-6-astra` emits exactly 24,680
characters, and the rows are our own top-level headings grouped: work =
`# Doing Tasks` 5,115 + `# Using Your Tools` 1,577; talk = `# Tone and Style` 936
+ `# Communicating with the User` 3,200; permission = `# Executing Actions with
Care` 2,774.

**Two caveats the table does not carry.** It covers 13,602 of 24,680 characters,
**55%** — `# System Rules`, `# Session-Specific Guidance`, `# Environment`,
`## Reading session transcripts` and the preamble are in no bucket, so no total
may be derived from these rows. And the Codex column is a judgment, not a heading
match: their 2,642 is `## Editing constraints` plus `## Autonomy and persistence`,
so **that first row compares our craft coaching against their tool mechanics.**
The craft finding in §1 survives only because it was checked against the binary
directly rather than inferred from the row.

**Reading the two rows nobody worked.** Permission and care is *not* thin: four
concrete risky-action categories with examples, instruction authority, obstacle
rule. "Lightest relative to our size" is arithmetic, not a demonstrated gap. The
talk row is a **shape** difference: our 4,136 is overwhelmingly prohibitions (no
emojis, no restating, no em dashes, no engagement prompts), while Codex spends
3,121 on `## Final answer instructions` and 2,343 on `## Intermediary updates`,
and we have no equivalent to either. We say what not to say; they say what to say.

**Tool descriptions are the larger surface** and were never compared: 42,328
characters across 27 tools in the default pool, against a 24,680-character system
prompt. A dev-full 30/33-tool pool gives 45,532 and 49,637 — different
configurations, not competing figures. The 153,641 characters across 40 source
files is inventory, not emitted text, and is used as a saving nowhere.

## 3. The eighteen items

Nothing here is applied. **Shape** matters as much as status: the plan's Part A
"deletions" and Part B "additions" offered only two shapes, so five replacements
were filed as one or the other. Cut-versus-add is a size axis, which is how a
programme mostly about correctness came to be scored at "net −344 characters" — a
true number measuring nothing anyone intended.

Six cuts, five tweaks, three adds, two investigations, one rule choice, one
another session's. Seventeen are rows below; C1 is in §5.

| Item | Shape | What it does | Why | Status |
|---|---|---|---|---|
| **A1** | cut | Delete the GPT decision checklist | Its four decisions are stated fifteen lines above | Open. Redundancy verified, but it trims the permission category, our thinnest against both comparators |
| **A2** | cut | Delete AgentTool's prime-number example | Tells the model to delegate because code was written, which our policy contradicts | Open. Inherited; upstream deleted it |
| **A3** | cut | Drop the snake-case example and "You are highly capable" | Ordinary coding-assistant teaching. **"Absent from all three comparators" was wrong:** Claude Code ships both verbatim | Open, re-scoped by the craft decision in §5 |
| **A4** | cut | Remove two restated sentences, GPT path only | "The right complexity level is exactly what the task requires" restates SCOPE | Open, re-scoped by §5 |
| **A5** | tweak | Drop all four Skill invocation examples, state the syntax instead | All four inherited; upstream deleted all four, keeping the syntax as prose | Open. Applied then reverted |
| **A6a** | tweak | Correct TodoWrite's "Exactly ONE in_progress" | The code clears the list on completion, so the stated invariant is impossible | Open. `-p` runs only |
| **A6b** | cut | Drop TodoWrite's eight narrated scenarios | Teaching material. ~5,841 chars, the largest single cut | Open. Claude path only; upstream still ships them |
| **A7** | investigate | Audit the verification-agent nudge | Its premise was wrong: the nudge is gated shut and has never fired | **ANSWERED.** Closed; produced A8 |
| **A8** | cut | Delete the unreachable verification nudge | Inherited, deleted upstream, gated shut here by a hardcoded `return false`, zero tests | Open. The only item that provably cannot change behavior |
| **B1** | add | Let the final answer restate the outcome | RULE 6 forbids the summary a user needs after a long run | Open. The visible tip of the talk-row gap in §2 |
| **B2** | add | Finish authorized preparation before asking approval | We say when to stop, never that work up to the gate should be done first | Open |
| **B3** | add | "Analysis does not authorize implementation" | Guards the opposite failure from A3's removal | Open. Belongs in the Actions section |
| **B4** | tweak | Replace the absolute skill trigger with relevance | "NEVER mention a skill without calling this tool" makes it impossible to say a skill does not fit | Open. Inherited; upstream removed it after 2.1.215 and its replacement is available to lift |
| **D1** | not ours | Write's description names `Edit`, absent from the GPT pool | `getProviderFileEditTool()` returns `FilePatchTool` on the OpenAI path | **Another session fixed it.** Do not touch |
| **D2** | tweak | TaskGet says require an empty `blockedBy` | `TaskListTool` filters completed prerequisites; TaskGet does not, so a finished prerequisite blocks forever | Open. Verified defect |
| **D3** | tweak | Agent says "outputs should generally be trusted" | `CLAUDE.md` says a subagent's output is the parent's to verify | Open. Upstream replaced this sentence; text drafted |
| **D4** | investigate | Agent's result tells the parent to end its turn while its description permits continuing | Text conflict verified; behavior not measured | Open |

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

**Fork drift, measured across the 2.1.87 SDK bundle and all 19 builds in
`~/.local/share/claude/versions/`, both UTF-8 and UTF-16LE literal tables:**

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
- **A1 weakened.** Its checklist sits inside the permission section, so it trims
  the one category where both comparators outspend us, and a checklist closing a
  dense section is a recall device rather than plain repetition. The redundancy
  claim is still verified.
- **A3's stated reason was false.** "Absent from all three comparators" — Claude
  Code ships both the snake-case example and the capability sentence verbatim.
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

**a. The craft-coaching slice, three options.** The 6,692 execution outlier holds
two kinds of text with opposite vendor trends: craft coaching, which both retired,
and autonomy rules, which both are growing. Only the craft half is in play —
1,481 characters across `ERROR HANDLING`, `SCOPE`, `TASK DOMAIN`, `ABSTRACTION`
and `CAPABILITY` in `gpt.ts`.

| Option | Shape | Chars | Rests on |
|---|---|---:|---|
| A. Redundancy and flattery only | cut | 266 | Our own text. No vendor needed |
| B. A, plus the craft sentences Codex dropped | cut | 1,099 | Codex's judgment for the GPT path |
| C. Rewrite the slice tighter, same ideas | tweak | est. 500–700 | Nothing. No vendor needed |

Option B is a bet that OpenAI is right and Anthropic wrong about text both still
ship. **Option C avoids it**: the vendors disagree about whether these ideas are
worth stating, not about whether one should be stated twice. If any option is
adopted it supersedes A3 and A4, which were scoped before this split existed.
Per-sentence verdicts and a worked rewrite are in the craft report (§8).

**b. The comment rule.** `CLAUDE.md` already bans status notes outright, which
forbids `src/constants/prompts.ts:502`, `// @[MODEL LAUNCH]: Remove this section
when we launch numbat.` — accurate, and naming its own retirement event. Either
keep the ban and convert that comment, or soften the rule to permit a note
carrying a named trigger. The reviewer recommends keeping the ban; the claim that
the repository relies on that comment is inference, not evidence.

**c. Whether additions are in scope at all.** B1 through B3 add text against a
brief that was subtraction. Each addresses a real tension, none has measured harm
behind it, and all can be dropped without affecting anything else. B1 is the
strongest, being the tip of the talk-row gap in §2.

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

The measurement that would change this is cheap and undone: run a fixed task set
against the current prompt and against one cut group at a time, on the models
actually in use, and compare scope errors, boundary violations, unnecessary tool
calls, and output quality. It costs model quota, which is why nobody has run it.

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
