# CLAUDE.md audit

The repository instructions were rewritten from 541 lines / 4,535 words to
188 lines / 1,443 words, a 68% word reduction. Counts compare the working copy
at the start of this audit, including its existing edits, with the rewrite.
The desktop-production and migration-retirement edits already present were retained.

This is a reduction in instruction burden and a correction of identifiable
defects. It is not evidence of a measured improvement in model task performance.

## What makes a useful CLAUDE.md

Keep information that changes how an agent should work in this repository:
non-obvious commands, durable constraints, local conventions, and consequential
pitfalls. Remove ordinary coding advice, detailed API inventories, repeated rules,
and facts easily recovered from source. This follows Anthropic's
[CLAUDE.md best practices](https://code.claude.com/docs/en/best-practices#write-an-effective-claudemd).

Anthropic recommends aiming below 200 lines and writing specific, concise,
consistent instructions. This is a guideline, not a performance threshold.
Splitting a large file into automatically imported files does not reduce the
startup context. See [instruction memory](https://code.claude.com/docs/en/memory#write-effective-instructions).

Useful guidance lies between vague aspirations and brittle procedural logic.
State enough context to guide judgment while allowing the agent to choose a
method. Anthropic explicitly discusses this balance in
[context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

The chosen mechanism remains a lean repository instruction file with links to
existing references. A new skill, hook, or collection of always-loaded rules
would add machinery without fixing this file's duplicated and overbroad guidance.
No runtime prompt, permission setting, hook, or skill was modified.

## Findings and disposition

| Finding in the starting file | Why it matters | Rewrite |
|---|---|---|
| Verification repeated in §§3, 5, 8, and 9; authorization and reporting repeated elsewhere | Repetition consumes context and makes later edits diverge | One verification section, one authorization section, short reporting guidance |
| Read the workspace map before the first broad search and choose only one focused map | A navigation aid becomes a prescribed investigation strategy, including for cross-cutting work | Start from known owners; use maps when useful |
| Exhaustive stale-reference search for every completion | A copy edit inherits the same ceremony as a contract removal | Follow affected references for renames/removals and update docs made wrong by the change |
| Full desktop battery and hardening required for every app change | Small changes inherit unrelated checks; hardening launches Electron despite a separate GUI authorization gate | Verification scope follows affected behavior; broad changes retain broad checks; Electron launch is explicit |
| Dirty failing file treated as someone else's failure | Shared-tree ownership does not establish causality | Investigate the current diff, establish ownership, then coordinate or report |
| Source always wins, without distinguishing facts from requirements | Existing incorrect behavior could be mistaken for permission to discard a constraint | Source establishes behavior; user requirements and security constraints still govern the intended result |
| Startup migrations assigned to `src/main.tsx` / `runMigrations()` | The instructions route an edit to a former owner | Point to `src/migrations/runEngineMigrations.ts`, verified in source |
| Detailed call chains, provider precedence, tool cost figures, and worktree removal recipes | These are specialized references or volatile implementation details | Retain consequential pitfalls and owner links; remove inventories and cleanup recipes |
| Blanket bans on comment shapes | A useful comment could be rejected despite having no maintenance problem | Explain the maintenance principle and keep durable rationale |
| Single-user scope stated as absolute absence of compatibility needs | The user still has persisted state and concurrent processes | Keep freedom from public rollout obligations alongside saved-state protections |

The comment finding also matches the repository's own earlier
[instruction-stack decision](2026-09-06-instruction-stack-decisions.md): it records
a blanket rule rejecting a comment without the underlying maintenance defect.
That is a concrete example of following the rule's form at the expense of its purpose.

## What stays, and where other information belongs

- **Root instructions:** shared-tree ownership/staging, commit and push preferences,
  live-state authorization, distinct package checks, generated-file cautions,
  architecture/security invariants, and unusual text/style conventions.
- **Existing maps and source:** file-by-file architecture, provider precedence,
  build internals, subsystem test routing, and detailed generated-type procedures.
- **Existing decision/process documents:** security rationale, peer semantics,
  GUI procedures, and amended architectural decisions. These remain conditional
  references, not a mandatory reading chain for every task.
- **Historical records:** incident narratives and migration execution details.
  Removed duplicates were not copied into a new instruction file.
- **Deleted ceremony:** fixed investigation ordering, exhaustive checks regardless
  of scope, repeated escalation wording, rigid comment-shape prohibitions,
  commit-before-every-wait rules, and mandatory reporting choreography.

Sections retain their numbers and broad topics because active tests, source
comments, and migration skills refer to §§3–8. The `11-required-workflow` anchor
also remains. Historical references to old numbered sub-rules are historical;
this audit does not rewrite incident records or unrelated source comments.

## Verification and limits

- `git diff --check`: passed.
- `bun run maps:lint`: passed for 17 maps, with seven recommended-section warnings
  in untouched maps. This linter checks maps; it is not a CLAUDE.md behavior test.
- Build command names checked against root and desktop `package.json` scripts.
- Migration ownership checked against `src/migrations/runEngineMigrations.ts`.
- Electron launch verified by reading `app/scripts/run-hardening-smoke.ts`.
- Local Markdown links and concrete repository paths in the rewrite checked for
  existence; references to CLAUDE.md sections searched in source, skills, and docs.

Static scenario checks considered a docs edit, a renderer copy edit, an engine bug,
a protocol change, an unrelated dirty-file failure, and GUI authorization already
given in the task. The rewrite distinguishes their scope and relevant boundaries.
These are author inspections, not independent model trials.

No model ablation, live account probe, GUI launch, or application build was run
for this documentation change. To establish actual performance impact, compare
the old and new instructions on representative fresh-context tasks, checking task
correctness, unnecessary work, user interruptions, and preserved safety boundaries.
Do not infer performance from file length alone. Other loaded instructions can
still cause over-scaffolding; they were outside this rewrite.
