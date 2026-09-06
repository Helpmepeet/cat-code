# GPT prompt rebuild: what moved, what was cut, what was kept

**Date:** 2026-09-07
**Status:** Applied to `src/constants/promptStyles/gpt.ts` on `migration`.
**Input:** [the rebuild inventory](2026-09-06-gpt-prompt-rebuild-inventory.md), whose
82-block table, comparator, survival list and floor this report is measured against.

The composition machinery was left alone: the same builder functions, in the same
assembly order in `prompts.ts`, with the same tool conditions and feature gates. What
changed is where the section lines sit and what each section is for.

## The layout, one job per section

| Section | Job | Builder |
|---|---|---|
| preamble | identity, URL rule, cyber policy | `getGPTIntroSection` |
| `# System Rules` | harness contract | `getGPTSystemSection` |
| `# Getting Work Done` | how to carry the work out and report it | `getGPTDoingTasksSection` |
| `# Acting and Asking` | what may proceed alone, what needs confirmation, what a request authorizes | `getGPTActionsSection` |
| `# Using Your Tools` | which tool does which operation, including subagents | `getGPTUsingToolsSection` |
| `# Tone and Style` | conventions for user-facing text | `getGPTToneAndStyleSection` |
| `# Communicating with the User` | what to say and when | `getGPTOutputSection` |
| `# Session-Specific Guidance` | skills and the interactive affordances of this session | `getGPTSessionGuidanceSection` |
| `# Environment`, `## Reading session transcripts` | unchanged | `prompts.ts` |

Two placements are the load-bearing ones.

**The proceed half and the confirm half of one decision now sit together.** `PRIORITY
RULE` (confirm before risky actions) lived in the actions section; `PROACTIVE EXECUTION`
(proceed without asking on reversible steps) lived four sections later under
session guidance, which Agent Mode and output-style assemblies replace or drop. They
are one rule with a safe/risky split, and the GPT prompting guidance in this repo says
to keep such halves adjacent. They are now `ACT OR ASK` in `# Acting and Asking`, the
one section every assembly (default, Agent Mode, proactive, output-style) includes.

**Tool mechanics are in the tools section.** `READ DISCIPLINE`, `AGENT TOOL`, `SEARCH
RULE`, `EXPLORE RULE` and `AGENT TYPES` were under session guidance because they are
tool-conditional; so is everything in `# Using Your Tools`. They moved there verbatim.
Session guidance keeps what depends on the session rather than on a tool's mechanics:
`DENIED TOOL`, `SHELL COMMANDS`, `SKILLS`, `HANDOFF PROMPTS`, `SKILL DISCOVERY`.

## Disposition of every block the inventory listed

"Was" sizes are the inventory's and "Now" sizes are measured from the after dump, both in characters. "Verbatim" means the emitted text is
byte-identical to the baseline dump.

| Block | Was | Now |
|---|---|---|
| preamble, `# System Rules` (all 7 rules) | | verbatim |
| `TASK DOMAIN` 137, `CAPABILITY` 87 | Doing Tasks | folded into `SCOPE` 319 |
| `DISAGREEMENT` 778 | Doing Tasks | `DISAGREEMENT` 719 in Acting and Asking; adds "lead with evidence rather than deference" from the 5.6 template |
| `RULE — Read before modifying` 233 | Doing Tasks | verbatim, Getting Work Done |
| `RULE — Minimize new files` 158 | Doing Tasks | one clause in `SCOPE` |
| `RULE — No time estimates` 133 | Doing Tasks | last sentence of Brevity, Communicating with the User |
| `RULE — Failure handling` 713 | Doing Tasks | `RETRY_RULE` verbatim; the "Escalate with AskUserQuestion" sentence cut (ACT OR ASK owns when to ask) |
| `RULE — Security` 215, `RULE — No backwards-compat hacks` 195 | Doing Tasks | `CHANGES` 297 |
| `SCOPE` 202 | Doing Tasks | scope sentence into `SCOPE`; comment sentences into `COMMENTS` |
| `COMMENTS — quantity` 200, `COMMENTS — content` 247 | Doing Tasks | `COMMENTS` 427, built on the operator's principle: a good comment needs very little maintenance |
| `VERIFICATION` 174 | Doing Tasks | 183, "in proportion to risk" |
| `RULE — Outcome reporting` 493 | Doing Tasks | verbatim |
| `PRIORITY RULE` + bullets + cost paragraph 652 | Actions | `ACT OR ASK` 1,088 (absorbs `PROACTIVE EXECUTION` 779) |
| `AUTHORIZATION SCOPE` 169 | Actions | `REQUEST SCOPE` 475: inspect vs change request types, terminal instructions do not widen authority, from the 5.6 template |
| `INSTRUCTION AUTHORITY`, `RISKY ACTIONS` list, `OBSTACLE RULE`, `PREPARATION RULE` | Actions | verbatim |
| `RULE — File mutations` 310 | Using Tools | verbatim, with the routing block's reason sentence prepended |
| `RULE — Show the diff` 347 | Using Tools | verbatim |
| `RULE — Tool routing` 502 | Using Tools | cut, except the Apply_patch path fact, now `PATHS` 119 |
| `TASK TRACKING` 135 | Using Tools | verbatim |
| `PARALLELISM` 264 | Using Tools | 161 |
| `# Tone and Style` (6 blocks) | | verbatim |
| `# Communicating with the User` (8 rules) | | verbatim except the Brevity sentence above |
| `DENIED TOOL`, `SKILLS`, `HANDOFF PROMPTS`, `SHELL COMMANDS`, `SKILL DISCOVERY` | Session guidance | verbatim |
| `PROACTIVE EXECUTION` 779 | Session guidance | into `ACT OR ASK` |
| `INVESTIGATION DISCIPLINE` 588 | Session guidance | `INVESTIGATION` 339, Getting Work Done |
| `READ DISCIPLINE` 494, `AGENT TOOL` 1,163 (incl. `AGENT FORK` variant), `SEARCH RULE` 119, `EXPLORE RULE` 561, `AGENT TYPES` 252 | Session guidance | verbatim, Using Your Tools |
| `# Environment`, `## Reading session transcripts` | | untouched |

Emitted total: 23,687 characters before, 22,393 after. Size was not a goal; the
inventory's section 2 says why, and every cut above stands on restatement or on a
sentence now owned by another block.

## Where this differs from the inventory's floor

- `RULE — Minimize new files` and `RULE — No backwards-compat hacks` were on the floor
  as craft with no 5.6 counterpart. Both survive as one clause each. They name two
  specific behaviours a GPT session actually produces (new files where an edit would
  do; `_unused` renames and `// removed` markers), which is a fact about the model, not
  coaching about good code.
- `DISAGREEMENT` was compressed, not merely shortened: it moved to the section that
  owns the proceed/confirm decision, because "keep building under stated assumptions"
  and "a reaffirmed request is the user's decision" are autonomy rules.
- The comment ban was replaced rather than trimmed, per the operator's ruling that
  the enumerated ban should give way to the maintenance principle.
- The `INVESTIGATION DISCIPLINE` self-test sentence ("can you write a precise
  implementation spec…") was folded into its first sentence; the stop condition it
  encoded is still the first thing the block says.

## What was borrowed from the Codex 5.6 template, and how

Semantics only, matched before wording: the request-type split (inspect, explain,
review, diagnose versus change or build), "a terminal instruction demands persistence
but does not widen authority", "verify in proportion to risk", and "lead with concrete
evidence rather than deference". None of the template's tool names or channel names
crossed. Its `# Destructive actions` mechanics (`mktemp -d`, no `$HOME` targets) did not
cross either: our `RISKY ACTIONS` and `OBSTACLE RULE` already state the destructive
contract in our own tool vocabulary.

## Verification

- `bun run build:dev:full` green.
- `bun test src/constants/prompts.test.ts src/constants/corePolicy.test.ts src/utils/providerPromptRegressions.test.ts src/tools/EnterPlanModeTool/prompt.test.ts src/tools/FileReadTool/FileReadTool.test.ts src/constants/systemPromptSections.test.ts`: 110 pass, 0 fail.
- `./cli-dev --dump-system-prompt --model gpt-5.6-sol` captured before the first edit
  and after the last; the diff contains only the moves and rewrites in the table above.
  Every block marked verbatim was confirmed byte-identical between the two dumps, or,
  for the four blocks a dump cannot emit (`SHELL COMMANDS`, the embedded-search
  `READ DISCIPLINE`, `AGENT FORK`, the ant-only `ESCALATION`), against the pre-change
  source.
- New test `GPT section boundaries` in `src/constants/prompts.test.ts` fails against the
  pre-change prompt and passes after.

No ablation was run; nothing here claims a model behaves differently. The claim is
that every contract the inventory's section 4 names is still emitted, under a section
whose name says what it is for.
