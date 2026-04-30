import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { registerBundledSkill } from '../bundledSkills.js'

// Lines-changed threshold above which a second design-vs-plan agent is spawned.
const LARGE_CHANGE_THRESHOLD = 150

const REVIEW_PROMPT = `# Review Implementation

You just finished implementing something from a plan. Now run a focused review.

## Step 1: Define the review scope

First determine the **task-scoped review set**:

- the files you changed for this task
- the hunks you changed for this task
- the plan or acceptance criteria this task was implementing

If the branch is dirty with unrelated changes, **exclude them from review**. Do not review the whole branch diff unless the task truly is the whole branch.

Then measure the size of the **task-scoped diff** (added + removed lines). You can use \`git diff HEAD\` or \`git diff\` to estimate size, but do not hand the whole branch diff to subagents if it includes unrelated work.

## Step 2: Spawn review agents

**If total lines changed < ${LARGE_CHANGE_THRESHOLD}** → spawn **1 agent** covering all four areas below.

**If total lines changed ≥ ${LARGE_CHANGE_THRESHOLD}** → spawn **2 agents** in parallel:
- Agent 1: correctness, quality, and performance
- Agent 2: design vs plan

Launch them all in a single \`${AGENT_TOOL_NAME}\` tool message.

For every agent, pass a compact context packet that includes:
- the exact files changed for this task
- the relevant diff hunks or a saved task-scoped diff file
- the exact plan file path(s), plan excerpt, or acceptance criteria if you have them
- a note if the branch contains unrelated dirty changes that must be ignored

Do **not** tell agents to review the full branch diff by default.

---

### Agent 1 — Correctness, Quality & Performance

Review only the task-scoped diff and the touched files for the following, in order. Do not sweep unrelated branch changes.

#### Correctness
1. Logic errors: off-by-one, wrong operator, inverted condition, unreachable branch
2. Unhandled edge cases: null/undefined, empty collections, zero, negative numbers, concurrent access
3. Error handling gaps: thrown errors that are silently swallowed, missing rollback on failure
4. Data integrity: mutations that bypass validation, state left inconsistent after an exception

#### Code Quality
1. Redundant state that duplicates existing state or can be derived
2. Parameter sprawl: new params added instead of restructuring
3. Copy-paste with slight variation that should be a shared abstraction
4. Leaky abstractions: internal details exposed through the public surface
5. Stringly-typed code where constants, enums, or branded types already exist
6. Unnecessary comments explaining WHAT (well-named identifiers do that); keep only non-obvious WHY

#### Performance
1. Unnecessary work: redundant computation, repeated reads, duplicate API calls, N+1 patterns
2. Missed concurrency: independent operations run sequentially when they could be parallel
3. Hot-path bloat: blocking work added to startup, per-request, or per-render paths
4. Memory: unbounded data structures, missing cleanup, event listener leaks
5. Overly broad operations: reading whole files or loading all rows when a subset suffices

For each finding: state the file + line, the problem, and the fix. Skip false positives — note them briefly and move on.

---

### Agent 2 — Design vs Plan

Your job is to verify that the implementation matches the original design intent.

1. **Use the authoritative plan input first.** If the current task already identified a plan file, plan excerpt, or explicit acceptance criteria, use that as the source of truth.

   Only if no authoritative plan input was provided, do a narrow fallback search for likely plan files: \`PLAN.md\`, \`plan.md\`, \`*_PLAN.md\`, or recently modified markdown directly related to this task. Do not do a broad repository design audit.

2. **Check plan completeness first:** Go through every item the plan lists and verify whether it is implemented in the task-scoped changes. Produce a completion summary:
   - **Done** — fully implemented
   - **Missing** — planned but not present in the diff at all
   - **Partial** — started but incomplete

3. **Then compare each implemented item against intent:**
   - Is anything implemented that the plan explicitly ruled out or deferred?
   - Are the abstractions, boundaries, and naming consistent with what the plan described?
   - Are there any shortcuts that technically work but violate the stated design (e.g., the plan said "no global state" but the implementation uses a global)?

4. **Stop searching once the relevant plan and touched files are clear.** Do not keep exploring the repo after your conclusion is stable.

5. **Report findings as a gap table:**

| Area | Plan said | Code does | Verdict |
|------|-----------|-----------|---------|
| ... | ... | ... | ✓ / ✗ / ⚠ / Missing |

Use ✓ = matches, ✗ = diverges (needs fix), ⚠ = partial or uncertain, Missing = not implemented at all.

If no authoritative plan can be found, say so explicitly and stop the design-vs-plan check. Do not broaden this into a general architecture review of the codebase.

---

## Step 3: Validate findings

Wait for all agents to complete.

For each ✗ or ⚠ finding from either agent, **you** must verify it before touching any code:

1. Read the relevant file and line(s) cited.
2. Apply your own judgment: does the code actually have this problem, or is the subagent wrong?
3. Label each finding one of:
   - **VALID** — confirmed problem, fix it immediately
   - **FALSE POSITIVE** — not actually a problem (explain why in one sentence)
   - **DEFERRED** — real problem but requires reading and changing a subsystem not touched by this diff (e.g., redesigning an interface, extracting a service, migrating a data structure across the codebase). Everything else should be VALID.

Produce a short validation table before writing any fixes:

| # | File:line | Finding | Verdict | Reason (if not VALID) |
|---|-----------|---------|---------|----------------------|
| 1 | ... | ... | VALID / FALSE POSITIVE / DEFERRED | ... |

## Step 4: Fix VALID findings

Fix every **VALID** finding directly — do not just report them.

## Step 5: Report and pause on DEFERRED

After fixing, present all DEFERRED findings to the user. For each one, estimate the fix scope:

- **Large** — requires reading and changing a subsystem not already in context from this review (e.g., redesigning an interface, extracting a service, migrating a data structure across the codebase). Recommend a new session with a focused plan.

Present them like:

| # | File:line | Finding | Recommendation |
|---|-----------|---------|----------------|
| 1 | ... | ... | New session |

Then **stop** and wait for the user to decide which ones to address.
`

export function registerReviewImplSkill(): void {
  registerBundledSkill({
    name: 'review-impl',
    description:
      'After finishing an implementation, spawn 1-2 review agents to check correctness, quality, performance, and design vs plan.',
    whenToUse:
      'Use after completing an implementation from a plan. Spawns 1 agent for small changes, 2 agents for large ones. Covers correctness, code quality, performance, and whether the code matches the original design.',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = REVIEW_PROMPT
      if (args?.trim()) {
        prompt += `\n\n## Additional Context\n\n${args.trim()}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
