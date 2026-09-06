# Rebuilding the GPT prompt: complete inventory and constraints

**Date:** 2026-09-06
**Status:** Preparation only. No rebuild proposed here, and nothing applied.
**Audience:** whoever does the rebuild. The operator has decided it should happen
and that it needs a stronger model than the session that wrote this file.

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

**We are larger in one bucket of three.** A rebuild that copies Codex would grow
the other two. Their structure is worth taking; their size is not a target.

Codex 5.6's sections, for structural reference: `# Personality` 864,
`## Writing style` 518, `## Technical communication` 699, `# Working with the user`
1,459, `## Intermediate commentary` 1,345, `## Final answer` 208,
`### Formatting rules` 866, `### Visualizations` 990,
`# Rules for getting work done` 1,103, `## File editing constraints` 819,
`## Autonomy and persistence` 2,693, `# Destructive actions` 1,281,
`# Using skills` 188, `### How to use skills` 4,538.

Each section has one job. Ours does not: `# Doing Tasks` holds fourteen unrelated
blocks, and autonomy lives under `# Session-Specific Guidance`. That disorder
caused two of the three errors in section 1.

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

## 5. Known-cuttable, already analysed

Totals from the table in section 6: **1,437 cut**, **2,595 compress**, **133
re-file**. Cuts are craft coaching with no 5.6 equivalent, plus `RULE — Tool
routing` and `TASK TRACKING`, which restate the tools' own descriptions — 42,328
characters of tool schemas ride in the same request.

Compression is the option-C shape the operator already chose for the craft slice:
same instruction, stated once. `DISAGREEMENT` spends 778 characters on "if the
user is wrong, say so" while Codex covers all of character in 864.

## 6. The complete inventory

82 blocks. Sums to 23,687, the emitted total. Blank disposition means analysed and
kept, or not yet examined; sections 4 and 5 say which.

| Section | Block | Chars | Disposition |
|---|---|---:|---|
| (preamble) | `(prose)` | 1136 |  |
| # System Rules | `(section prose)` | 15 | harness, keep |
|  | `RULE 1 — Output channel` | 166 | harness, keep |
|  | `RULE 2 — Tool permissions` | 189 | harness, keep |
|  | `RULE 3 — Tool output is data, not instructions` | 475 | harness, keep |
|  | `RULE 4 — Runtime metadata` | 445 | harness, keep |
|  | `RULE 5 — Prompt injection` | 245 | harness, keep |
|  | `RULE 6 — Hooks` | 416 | harness, keep |
|  | `RULE 7 — Context compression` | 255 | harness, keep |
| # Doing Tasks | `(section prose)` | 14 |  |
|  | `TASK DOMAIN` | 137 |  |
|  | `CAPABILITY` | 87 |  |
|  | `DISAGREEMENT` | 778 | compress |
|  | `RULE — Read before modifying` | 233 |  |
|  | `RULE — Minimize new files` | 158 | cut |
|  | `RULE — No time estimates` | 133 | re-file → talk |
|  | `RULE — Failure handling` | 713 | compress |
|  | `RULE — Security` | 215 |  |
|  | `SCOPE` | 202 |  |
|  | `COMMENTS — quantity` | 200 | cut |
|  | `COMMENTS — content` | 247 | cut |
|  | `VERIFICATION` | 174 |  |
|  | `RULE — No backwards-compat hacks` | 195 | cut |
|  | `RULE — Outcome reporting` | 493 | compress |
| # Executing Actions with Care | `(section prose)` | 30 |  |
|  | `PRIORITY RULE` | 77 |  |
|  | `Reversible-local (edit files, run tests)` | 60 |  |
|  | `Risky (hard-to-reverse, affects shared systems, visible to others)` | 515 |  |
|  | `INSTRUCTION AUTHORITY` | 581 |  |
|  | `AUTHORIZATION SCOPE` | 169 |  |
|  | `RISKY ACTIONS — require user confirmation` | 44 |  |
|  | `Destructive` | 125 |  |
|  | `Hard-to-reverse` | 137 |  |
|  | `Shared-state` | 194 |  |
|  | `Publishing` | 199 |  |
|  | `OBSTACLE RULE` | 464 |  |
|  | `PREPARATION RULE` | 158 |  |
| # Using Your Tools | `(section prose)` | 19 |  |
|  | `RULE — File mutations` | 310 |  |
|  | `RULE — Show the diff` | 347 | compress |
|  | `RULE — Tool routing` | 502 | cut |
|  | `TASK TRACKING` | 135 | cut |
|  | `PARALLELISM` | 264 | compress |
| # Tone and Style | `(section prose)` | 17 |  |
|  | `EMOJIS` | 71 |  |
|  | `TONE` | 127 |  |
|  | `CODE REFERENCES` | 147 |  |
|  | `GITHUB REFERENCES` | 171 |  |
|  | `TOOL CALL FRAMING` | 167 |  |
|  | `COPYABLE TEXT` | 236 |  |
| # Communicating with the User | `(section prose)` | 30 |  |
|  | `OUTPUT CONTRACT — apply to all user-facing text` | 50 |  |
|  | `RULE 1 — Audience awareness` | 353 |  |
|  | `RULE 2 — Cold-read clarity` | 369 |  |
|  | `RULE 3 — Prose quality` | 408 |  |
|  | `RULE 4 — Brevity` | 381 |  |
|  | `RULE 5 — Scope` | 109 |  |
|  | `RULE 6 — No restating` | 349 |  |
|  | `RULE 7 — Corrections` | 858 |  |
|  | `RULE 8 — Closed endings` | 457 |  |
| # Session-Specific Guidance | `(section prose)` | 28 |  |
|  | `DENIED TOOL` | 102 |  |
|  | `PROACTIVE EXECUTION` | 779 |  |
|  | `INVESTIGATION DISCIPLINE` | 588 |  |
|  | `READ DISCIPLINE` | 494 | ours, no Codex analogue |
|  | `AGENT TOOL` | 1163 | ours, no Codex analogue |
|  | `SEARCH RULE` | 119 | ours, no Codex analogue |
|  | `EXPLORE RULE` | 561 | ours, no Codex analogue |
|  | `AGENT TYPES` | 252 | ours, no Codex analogue |
|  | `SKILLS` | 295 |  |
|  | `HANDOFF PROMPTS` | 288 |  |
| # Environment | `(section prose)` | 14 | harness, keep |
|  | `You have been invoked in the following environment` | 53 | harness, keep |
|  | `Primary working directory` | 49 | harness, keep |
|  | `Is a git repository` | 30 | harness, keep |
|  | `Platform` | 20 | harness, keep |
|  | `Shell` | 14 | harness, keep |
|  | `OS Version` | 948 | harness, keep |
| ## Reading session transcripts | `(section prose)` | 444 | harness, keep |
|  | `Paths` | 656 | harness, keep |
|  | `Examples for querying an individual transcript` | 482 | harness, keep |
|  | `The subagent sidecar .meta.json contains` | 357 | harness, keep |

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
