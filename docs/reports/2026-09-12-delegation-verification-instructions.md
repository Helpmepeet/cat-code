# Delegation and verification instructions

Date: 2026-09-12

Implemented the user's follow-up decisions after the
[clear-fix batch](2026-09-12-harness-clear-instruction-fixes.md): allow capable
workers to choose their method within scope, and select verification for the
change's plausible failures while preserving applicable project-required checks.

## Changes

- `src/tools/AgentTool/prompt.ts`: the parent may delegate investigation,
  synthesis, and implementation to a worker of the same capability tier or
  stronger for the task. Weaker workers receive narrower tasks and more concrete
  guidance as needed. Price is not a capability ranking. Unknown capability does
  not justify inventing a ranking. Both provider styles and normal/coordinator
  tool-description paths carry the boundaries. The handoff supplies known facts,
  constraints, and acceptance criteria without requiring the parent to solve an
  investigation before assigning it.
- `src/tools/AgentTool/built-in/generalPurposeAgent.ts` and
  `src/tools/AgentTool/built-in/implementorAgent.ts`: workers can choose routine
  implementation details when assigned an objective without a prescribed method.
  Explicit implementation constraints remain binding; changes to scope or
  authorization require the caller. The general-purpose worker no longer has to
  start editing exact instructions before inspecting necessary context.
- `src/tools/AgentTool/built-in/verificationAgent.ts`: both providers use one
  verification contract. Required project checks remain required within the
  permitted scope. Additional checks target plausible failures. Source inspection
  supports static claims, while runtime claims require execution evidence.
  Tests count as evidence for what they actually exercise. Removed the universal
  build/test/adversarial itinerary, commands-only reporting, and automatic
  classification of every failing baseline test as a defect in the change.

The verifier still cannot modify project files, install dependencies, or perform
git writes. Its tool restrictions, inherited model, background execution, user
authorization to invoke it, and final `VERDICT: PASS|FAIL|PARTIAL` vocabulary are
preserved. A blocked required check must be reported rather than bypassed.

PASS requires supported acceptance criteria and applicable required checks. FAIL
means an assigned criterion demonstrably fails. PARTIAL now covers missing
required evidence, including unresolved uncertainty, rather than only missing
environment capabilities. Permitted checks should resolve uncertainty where
possible; demonstrated failure takes precedence over missing evidence elsewhere.

Caller inspection found verdict extraction in `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
and presentation in task labels/rows/dialogs. Those consumers use the unchanged
three labels; no consumer of the removed per-check Markdown template was found.

## Verification

Two added prompt-contract regressions failed against the previous source, then
passed after the changes. They exercise both parent provider styles and caller
modes, plus the public verifier prompt for Astra, another GPT model, and Claude.

`bun test --preload /private/tmp/harness-audit-offline.ts` with these explicit files:

- `src/tools/AgentTool/prompt.test.ts`
- `src/tools/AgentTool/agentToolUtils.test.ts`
- `src/components/tasks/AsyncAgentDetailDialog.test.tsx`
- `src/constants/promptAssembly.snapshot.test.ts`
- `src/constants/prompts.test.ts`
- `src/constants/systemPromptSections.test.ts`
- `src/utils/providerPromptRegressions.test.ts`

Result: **116 passed, 0 failed**, 19,202 assertions. Existing worker-tool tests
verify the read-only and provider-specific edit-tool restrictions. Tests used a
disposable configuration directory, dummy credentials, disabled memory/telemetry,
and a preload rejecting fetch/HTTP requests. No snapshots changed.

`bun run build:dev:full` passed: map lint, undefined-name lint, repository lint,
development bundle, and CLI version smoke check. Map lint retained seven existing
recommended-section warnings; undefined-name lint reported zero undefined names.
`git diff --check` passed. The stale-reference sweep found the removed mandates
only in negative regression assertions and historical prompt documents
`docs/prompts/2026-04-30-gpt-execution-discipline-patch.md` and
`docs/prompts/2026-09-06-peer-exchange-register.md`.

These checks establish the emitted instruction contracts and existing regression
compatibility. They do not measure live model compliance, model-tier judgment,
or task-quality improvement. No live model requests or account operations ran.

## Explicit scope decisions

- Compaction keeps its current format. The comparison identified surrounding
  retention/reconstruction mechanisms that make copying another harness's short
  prompt alone unsafe to assume equivalent. Changes need continuation evidence.
- Agent and skill generators are skipped because the user does not use them.
- Peer-approval redesign is dropped as YAGNI. No approval hashes, new evidence
  transport, or permission-classifier changes were added.
- Model selection and ranking mechanisms, planning-mode workflow, skills,
  `AGENTS.md`, and `CLAUDE.md` were not changed in this batch.

Other sessions' working changes were excluded from this commit.
