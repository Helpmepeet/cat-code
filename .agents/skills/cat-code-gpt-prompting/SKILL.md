---
name: cat-code-gpt-prompting
description: "Use to author, edit, review, or debug Cat Code GPT backend prompts: system/harness instructions, AGENTS/CLAUDE files, agent instructions, and tool descriptions. Not for other apps, non-GPT backends, or general prompting outside Cat Code."
---

# Cat Code GPT Prompting

## Know your backend

Cat Code runs Claude Code-shaped workflows on a GPT-5.5 backend. Write prompts for GPT behavior, not for Claude muscle memory.

- Reasoning can be off by default. Set effort for hard coding, planning, review, and agentic work.
- GPT follows instructions literally and suffers when rules overlap or contradict each other.
- Forceful language helps GPT when the behavior matters. Use `MUST`, `STOP`, and `do not` for real invariants, not preferences.
- GPT can over-gather context on small tasks and stop early on long tasks. Give both search limits and persistence rules.
- Markdown and verbosity are not safe defaults. Ask for the format and length you need.
- Tool preambles are normal GPT behavior. Prompt their content and cadence instead of assuming silence.
- Subagent behavior is prompt-shaped. State when to delegate and when direct search/editing is cheaper.

## Prompt-writing rules

### Reasoning and planning

Do:
- Set `reasoning_effort` explicitly for Cat Code modes that need judgment.
- Use high or xhigh effort for coding, multi-file edits, code review, prompt review, and agent orchestration.
- Put essential planning instructions in the prompt because reasoning state may not persist across turns.
- Tell the model when to plan briefly versus extensively.

Don't:
- Assume the backend will think deeply because the task is hard.
- Hide critical planning rules in examples only.
- Ask for extensive planning on trivial one-shot answers.

### Language register

Do:
- Use plain language for ordinary preferences: `Prefer focused tests.`
- Use emphatic language for invariants: `You MUST read a file before editing it.`
- Put priority rules near the conflicting rules they govern.

Don't:
- Use `CRITICAL` for every guideline.
- Mix soft and hard versions of the same rule.
- Say `when in doubt, always use X` unless over-triggering is acceptable.

### Contradictions and overlap

Do:
- Make one rule own each decision.
- Add a priority order when rules can conflict.
- Scope every rule: when it applies, when it does not, and what wins.
- Delete duplicate phrasing instead of adding clarifying paragraphs.

Don't:
- Keep both `ask before acting` and `proceed autonomously` without a safe/risky split.
- Put exceptions far from the rule they modify.
- Rely on GPT to infer the intended compromise.

### Tool triggering and context gathering

Do:
- Say which tasks need tools and which should be answered from existing context.
- Add early-stop criteria for searches: stop once enough evidence identifies the file, root cause, or edit.
- Budget small tasks: one or two focused lookups before acting.
- Make risky tools require stronger certainty than read-only tools.

Don't:
- Use `maximize context`, `be exhaustive`, or `search thoroughly` as a blanket instruction.
- Tell GPT to use tools for every uncertainty.
- Let tool descriptions blur read-only, local edit, and shared-state actions.

### Persistence and stop conditions

Do:
- Add explicit persistence for autonomous work: continue until the user request is resolved or blocked by a real constraint.
- Define done: files changed, stale references checked, tests run, failures reported.
- Define when to stop: destructive action needed, contradictory requirements, repeated failed attempts, missing authorization.
- Tell the model to make reasonable assumptions for reversible local work and report them.

Don't:
- Let the model hand work back at first uncertainty.
- Say `ask if unsure` without separating routine ambiguity from risky ambiguity.
- Reward appearing successful over accurate blocker reporting.

### Tool preambles and progress updates

Do:
- Specify the preamble: one sentence before tools saying the immediate action.
- Ask for short milestone updates only when useful: root cause found, direction changed, verification failed.
- Permit tool-call text interleaved with progress prose.

Don't:
- Force status updates after a fixed number of tool calls.
- Require long plans before obvious one-step tool use.
- Assume assistant text means no tool call follows.

### Verbosity, Markdown, and final answers

Do:
- Request GitHub-flavored Markdown when rendered output matters.
- Set concise chat defaults and allow more detail for reports, plans, and debugging evidence.
- State final-answer shape: changed files, checks run, failures, or direct answer.
- Re-state Markdown expectations in long-running prompt surfaces.

Don't:
- Assume Markdown, code fences, or tables appear by default.
- Use tables when prose is clearer.
- Let `verbosity: low` make code cryptic; code should favor clarity over code golf.

### Subagents

Do:
- Give delegation criteria: broad search, independent verification, isolated implementation slice, or parallel research.
- Give non-delegation criteria: a specific file, one function, one grep, or a small direct edit.
- Require tight handoffs: exact paths, current state, constraints, done criteria.
- Require the parent agent to synthesize and own the result.

Don't:
- Spawn subagents by default for every investigation.
- Ask a subagent to `figure it out and fix it` without a bounded assignment.
- Let subagent findings replace verification.

### Scope discipline and code edits

Do:
- Prefer deletion, existing patterns, and the smallest diff that satisfies the request.
- Require reading current code before editing.
- Require root-cause fixes, not test-fitting or hard-coded expected outputs.
- Require focused checks for non-trivial branches, loops, parsers, money/security paths, prompts, tools, and settings.

Don't:
- Add abstractions, config, new files, or dependencies for hypothetical future use.
- Add comments explaining obvious code.
- Fix unrelated bugs unless the user authorizes the widened scope.

### Frontend defaults

Do:
- Specify the target visual direction when Cat Code prompts generate UI.
- Name concrete fonts, palette, layout density, and interaction states if appearance matters.
- Keep accessibility basics explicit.

Don't:
- Rely on GPT's default React/Tailwind/shadcn/sans-serif style.
- Use only negative taste rules like `avoid AI slop`.
- Port Claude frontend style bans without deciding the desired GPT output.

## Porting Claude-era prompts to the GPT backend

Watch for these inversions when editing inherited Cat Code prompts:

| Claude-era assumption | GPT-5.5 rewrite |
|---|---|
| Softened `MUST` language prevents over-triggering. | Re-introduce imperatives for true invariants and persistence. |
| The model will reason deeply if the task needs it. | Set reasoning effort and planning instructions explicitly. |
| More tool encouragement fixes under-calling. | Calibrate tools; GPT may already over-search small tasks. |
| Markdown appears naturally. | Prompt for Markdown and final-answer format. |
| Autonomous persistence is mostly native. | Add persistence, done criteria, and stop conditions. |
| Long prompts can tolerate overlap. | Remove contradictions and make priority explicit. |
| Status scaffolding is unnecessary. | Specify concise GPT tool preambles if cadence matters. |
| Subagent tendency is a model default. | State fan-out and non-fan-out criteria directly. |
| Frontend anti-slop rules transfer cleanly. | Pick the desired aesthetic; GPT defaults differ. |

Do not make porting the spine of a new prompt. First write the prompt that Cat Code needs for GPT-5.5 today, then compare inherited Claude text against it.

## Checklist

Before shipping a Cat Code prompt surface:

- [ ] The trigger and negative scope are explicit.
- [ ] Reasoning effort is set or the prompt explains why low/no reasoning is acceptable.
- [ ] Hard rules, preferences, and examples are not contradictory.
- [ ] Tool-use language says when to use tools and when not to.
- [ ] Persistence, completion, and stop conditions are visible.
- [ ] Preambles and progress updates are short and purposeful.
- [ ] Markdown, verbosity, and final-answer format are specified if needed.
- [ ] Subagent criteria include when not to delegate.
- [ ] Code-edit rules require minimal diffs, root-cause fixes, and verification.
- [ ] Frontend prompts specify a concrete target style when UI output matters.

## Quick validation tests

Run the prompt against these small scenarios and inspect behavior:

1. **Trivial answer:** Ask a question answerable from current context. It should not search.
2. **Repo investigation:** Ask for a bug diagnosis requiring files. It should use focused tools and stop searching once it can act.
3. **Multi-step task:** Ask for A, B, then C. It should complete all steps or report the real blocker.
4. **Contradiction stress:** Add one conflicting instruction. The prompt should have a priority rule that resolves it.
5. **Risk boundary:** Ask for a destructive or shared-state action. It should stop for confirmation.
6. **Format check:** Ask for a final answer with code fences or bullets. It should render valid Markdown.
7. **Subagent check:** Give one broad independent search and one single-file lookup. It should delegate only the broad search.
