# Harness instruction cleanup: clear fixes

Date: 2026-09-12

Implemented the user's approved batch of concrete instruction corrections. This
changes model-facing text in six source files; it does not establish that models
will always follow the revised text or that shorter prompts improve quality.

## Applied changes

| Source | Correction |
|---|---|
| `src/tools/SkillTool/prompt.ts` | Both provider branches distinguish asking to use a skill from discussing, inspecting, revising, removing, or excluding it. A review treats the source as material under review. Explicit requests not to load a skill are respected. Existing applicability and reload rules remain. |
| `src/components/Feedback.tsx` | Issue-title instructions identify a provider only when the report establishes it. Removed the assertion that every model API error is Anthropic's and the example reinforcing it. |
| `src/tools/AgentTool/built-in/statuslineSetup.ts` | Both branches scope shell configuration/PS1 inspection to an explicit shell-prompt import or conversion request. |
| `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts` | Both branches distinguish local Cat Code evidence from upstream Claude Code documentation. Fork-specific claims require local support or an explicit limitation. Corrected the Agent SDK's upstream attribution and removed repeated topic enumeration. |
| `src/utils/messages.ts` | The auto-compaction reminder acknowledges that summaries can omit information and calls for recovering relevant missing context. It no longer promises unlimited context. |
| `src/tools/AgentTool/built-in/planAgent.ts` | Removed the minimum of three examples, the mandatory three-to-five file count, placeholder examples, and a duplicated convention rule. Plans still end with relevant verified file paths; read-only restrictions and planning phases remain. |

This batch leaves permission enforcement, peer authorization, tool schemas,
provider routing, compaction templates, agent/skill generators, and broader
planning/delegation/verification workflows unchanged. `AGENTS.md` remains the
exact pointer to `CLAUDE.md`. Other sessions' working changes were not included.

## Validation

- Focused offline tests: **90 passed, 0 failed**, 19,137 assertions, six files:
  `src/constants/promptAssembly.snapshot.test.ts`,
  `src/constants/prompts.test.ts`,
  `src/constants/systemPromptSections.test.ts`,
  `src/tools/AgentTool/prompt.test.ts`,
  `src/utils/providerPromptRegressions.test.ts`, and
  `src/utils/messages.test.ts`.
- Tests used a disposable `CLAUDE_CONFIG_DIR`, dummy credentials, disabled memory
  and telemetry, and a preload rejecting fetch/HTTP requests. No snapshots changed.
- `bun run build:dev:full`: passed, including map lint, undefined-name lint,
  repository lint, development bundle, and the CLI version smoke check.
  Map lint reported seven existing recommended-section warnings across 17 maps;
  undefined-name lint reported zero undefined names.
- Reviewed the scoped diff, including both provider branches. A source search
  found no remaining occurrences of the five specific obsolete phrases removed
  here (skill-name blocking, Anthropic-only attribution, unlimited context,
  three-example minimum, and three-to-five critical-file list).
- `git diff --check`: passed.

These checks establish build and existing regression compatibility, plus the
intended source wording. They are not live behavioral evaluations of skill
selection, provider attribution, planning, or continuation after compaction.
No live model requests, account operations, GUI startup, or session-log reads
were used.

## Remaining choices for the user

These are proposals, not changes made by this batch.

1. **Worker and planning freedom.** The remaining text prescribes investigation
   phases and restricts delegating understanding. Recommend bounded objectives,
   constraints, and acceptance criteria, allowing workers to choose the method.
   Keep exact procedures where the user or correctness requires them and retain
   all read-only and plan-approval boundaries.
2. **Verification expectations.** Recommend checks selected for plausible
   failures and the requested acceptance criteria, while retaining every
   applicable project-required check. Separate a defect in the change, an
   unrelated baseline failure, and missing evidence. Changing the verification
   agent's verdict semantics requires checking callers as well as text.
3. **Compaction priorities.** Recommend preserving active objectives, exact
   constraints, authorization provenance, decisions, evidence, and unfinished
   work over reproducing every user message and a chronological analysis.
   This needs separate full/partial/provider and continuation checks; the
   reminder correction above does not change what compaction retains.
4. **Generated agents and skills.** Recommend concise applicability, outcomes,
   constraints, and necessary mechanics by default. Include detailed workflows
   when they are deliberately requested or needed for correctness. Preserve
   Skillify's review-before-saving contract. This changes future generated
   instructions, not just existing ones.
5. **Evidence for peer-carried approval.** The user has already allowed peers to
   carry scoped user authorization. The unresolved issue is how the receiver's
   permission classifier can verify that authorization, including after
   compaction. Recommend traceable originating user approval and its scope;
   a peer's assertion alone must not create permission. Do not solve this by
   weakening classifier safeguards or bypassing a denial. Agree on the expected
   handoff behavior before designing the evidence path and its tests.

The earlier September 6 decision report and the external September 12 audit are
historical analyses. This report records only this batch's current implementation;
it does not adopt every proposal in either review.
