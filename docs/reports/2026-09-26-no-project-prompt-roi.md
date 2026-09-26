# No-project prompt composition: feasibility and return

Date: 2026-09-26. Source inspected after design commit `f3156ad3`.
Scope: source investigation and design amendment only. No runtime changes.

## Decision

**Worth doing in v1, with moderate integration effort.** Omit unrequested
project instruction sources and remove product-authored assumptions that the
current directory is an assigned software project. Retain the shared safety,
tool, permission, global-user, and managed-policy instructions.

Reuse the current instruction sources, provider builders, file tools, and
context assembly. A second complete system prompt, automatic topic classifier,
repository activation UI, and history-pruning mechanism have poor return for
this requirement and are outside the proposal.

The original no-project design already requires controlling project discovery.
This amendment makes that omission contract explicit and adds neutral wording
at existing builders; it does not add a separate context-management architecture.

The [revised design](../design/2026-09-26-no-project-chats.md#prompt-composition)
records the product contract. Explicit repository work reads applicable guidance
through existing tools; it does not convert the chat to a project session.

## What already exists

| Source evidence | Reuse / implication |
| --- | --- |
| [`claudemd.ts`](../../src/utils/claudemd.ts), `getMemoryFiles`, `getClaudeMds` | Instruction records already distinguish Managed, User, Project, and Local. `getClaudeMds` accepts a type filter; a feature-gated filter already omits Project/Local at formatting time. This is evidence for a small composition seam, not a complete discovery policy. |
| [`settings/constants.ts`](../../src/utils/settings/constants.ts), `getEnabledSettingSources` | User/project/local source selection exists; flag and policy settings remain included. Reuse source distinctions without switching off global user or managed instructions. |
| [`context.ts`](../../src/context.ts), `getUserContext`, `getSystemContext` | Repository instruction text and Git status enter separately from the default prompt. Both have explicit construction points. |
| [`prompts.ts`](../../src/constants/prompts.ts), [`gpt.ts`](../../src/constants/promptStyles/gpt.ts) | Provider prompts are built from sections. Small conditional wording changes can share the normal safety and tool sections. No need for a copied prompt. |
| [`corePolicy.ts`](../../src/constants/corePolicy.ts) | Shared policy owns safety, provenance, instruction authority, retry, and truthful reporting. Preserve these invariants. |
| [`instructionAssembly.ts`](../../src/services/api/instructionAssembly.ts) | Both providers consume the same context objects, but serialize them differently. OpenAI includes user context in instructions; Claude prepends it to messages. Omission belongs before this split. |

## Work that a one-line flag would miss

1. **Automatic discovery and late injection are separate.**
   [`attachments.ts`](../../src/utils/attachments.ts) loads nested instructions
   after file reads, at-mentions, and IDE context. In `claudemd.ts`, some nested
   rule-processing calls do not use the same settings-source guards as eager
   `CLAUDE.md` discovery. Apply the managed-session policy before those reads and
   instruction-loaded hooks, rather than merely filtering the final string.

2. **Generic rules and repository assumptions share sections.**
   The Claude Doing tasks section includes the assumption that requests are
   primarily software engineering and that ambiguity refers to cwd. The GPT
   task section also uses cwd to interpret scope. Both sections contain rules
   that must survive, including secure edits, verification, retries, and honest
   reporting. GPT tool guidance unconditionally asks for Git diff after some
   mutations. Use neutral scope wording and applicable change inspection;
   retain the tool discipline.

3. **Git text also contains safety.**
   [`BashTool/prompt.ts`](../../src/tools/BashTool/prompt.ts),
   `getCommitAndPRInstructions`, mixes ordinary Git workflow with restrictions
   on destructive commands, hooks, staging, and pushing. The
   [`includeGitInstructions` switch](../../src/utils/gitSettings.ts) is not an
   appropriate blanket token-saving switch when the user asked to keep normal
   safety and tool instructions. Keep those safeguards; omit irrelevant
   repository context and unconditional workflows.

4. **Caches and other agents must inherit the same policy.**
   [`postCompactCleanup.ts`](../../src/services/compact/postCompactCleanup.ts)
   clears instruction caches;
   [`systemPromptSections.ts`](../../src/constants/systemPromptSections.ts)
   manages cached prompt sections; and
   [`runAgent.ts`](../../src/tools/AgentTool/runAgent.ts) has its own context and
   prompt assembly. Its `omitClaudeMd` path can drop the whole instruction
   aggregate for a specialized agent, including global instructions. Source
   filtering for this mode must preserve User/Managed rather than reuse that
   whole-blob omission. A desktop append-only block in
   [`sessionController.ts`](../../app/sidecar/sessionController.ts) cannot enforce
   absence across those paths. Install the stable managed binding before
   context construction and carry it into newly initialized peers.

5. **The external-repository loader is not already solved.**
   `getDirectoriesToProcess` in `attachments.ts` derives nested discovery from
   the original cwd. Adding an external allowed path is not equivalent to
   loading that repository's complete instruction hierarchy. The inspected
   automatic loader handles CLAUDE files and rule directories, not arbitrary
   `AGENTS.md` files. Avoid claiming that one setting restores all of this.

## Smallest useful repository-work path

Keep the base prompt stable. When the user requests work in a named repository,
the agent reads its instruction entry points and relevant nested/reference files
using existing file/search tools before making changes. Apply normal repository
instruction authority within the requested scope. The agent re-reads guidance
when continuing that job after context loss, as it does other task evidence.

This is an agent behavior contract, not a new deterministic classifier that
infers repository activation from prose. Incidental file access and downloaded
instruction-shaped content do not become configuration. Do not automatically
enable repository hooks, plugins, MCP configuration, or broader permissions.
Existing trust and permission requirements remain applicable.

Once explicitly read, guidance can remain in normal history. Do not promise
immediate token recovery when the user changes topics, or mutate the cached
base prompt on every topic shift. A future requirement for automatic,
deterministic repository activation with provenance-aware loading would be a
larger feature and should be assessed separately.

## Expected return and measurement limits

- **Context clarity:** directly removes unrequested project directives and cwd
  assumptions. It does not depend on the model obeying a contradictory addendum.
- **Token savings:** primarily the repository files and state that would
  otherwise load. For scale, this repository's `CLAUDE.md` alone contains 11,015
  characters at inspection time. That is a source-file size, not a measured
  emitted-token saving. An already empty cwd may contribute no such file.
- **Bounded base savings:** neutral wording and omitted repository metadata
  save less than a large loaded guide. Tool schemas, global guidance, and safety
  remain, so this does not make the whole agent prompt small.
- **Cache effects:** fewer input tokens do not imply the same proportional cost
  or latency reduction. Keep composition stable, and compare actual provider
  inputs with matching model, tool pool, and instruction fixtures during
  implementation. Avoid repeated cache invalidation merely to trim text.

No live model request, behavior ablation, emitted-prompt token count, or runtime
test was performed. The assessment establishes concrete implementation seams
and gaps; it does not establish a percentage saving or improved model accuracy.

## Documentation validation

`git diff --check` passed. `bun run maps:lint` passed with seven existing
recommended-section warnings in maps untouched by this task. All 61 local
Markdown links across the revised design, this assessment, and the earlier
review record resolve, including the prompt-composition anchor.
Application builds and runtime verification belong to a separately requested
implementation.
