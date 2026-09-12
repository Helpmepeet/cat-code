# Retired skill reference notes

On 2026-09-12 the operator retired seven custom skills from active discovery.
Their workflow prescriptions are no longer requirements. This note preserves
useful routes to project knowledge without recreating those workflows.

| Retired skill | Useful information and maintained source |
|---|---|
| `cat-code-gpt-prompting` | Prompt ownership and assembly: [prompt surfaces](../prompts/2026-04-30-prompt-surfaces.md) and [prompt map](../maps/prompt-system.md). The retired GPT-5.5 assumptions and generic effort prescriptions are historical, not current model guidance. |
| `cat-code-cold-review` | Local integration risks: [repository failure classes](../../CLAUDE.md), [security decisions](../migration/decisions/SECURITY-MINIMUM.md), and [GUI verification](../migration/process/GUI-VERIFICATION.md). Its fixed review order, commit-by-commit requirement, and verdict templates are retired. |
| `complex-systems-failure-analysis` | The archived text is optional background on causal evidence and incident analysis. It is not a required investigation method or report format. |
| `checking-cat-code-change-impact` | Actual owners and integration paths: [workspace map](../maps/WORKSPACE_MAP.md). Follow the relevant domain map when a change needs it; the retired checklist and reporting of unaffected surfaces are not required. |
| `verifying-cat-code-changes` | Verification commands remain in [CLAUDE.md §3](../../CLAUDE.md) and test routing in the [build and testing map](../maps/build-release-testing.md). Current dispatched migration requirements live in the relevant backlog. Do not use archived test counts or lint claims as present-day baselines. |
| `writing-cat-code-tests` | CLAUDE.md retains a short regression-coverage guideline. The separate workflow is retired; there is no replacement skill or mandatory evidence template. |
| `codex-subscription-client` | Backend ownership and implementation: [Codex core map](../maps/codex-core.md), including request translation, account resolution, refresh, continuation, and failure handling. Validate protocol details against the current implementation; archived examples are not wire specifications. |

## Project details worth retaining

- Engine and desktop verification have different commands; an engine build
  does not establish desktop correctness. The maintained command list owns
  this distinction rather than a second skill copy.
- GUI state replay and new engine execution are different kinds of evidence.
  A claim about resume or continued execution needs evidence of that behavior.
- Shared-file updates can still lose data when a lock protects a value computed
  before the lock. The repository's shared-state rules and current storage
  implementation own this constraint.
- For Codex integration work, inspect account identity and refresh ownership,
  request/response translation, continuation state, and error classification in
  their actual owners. The retired skill's generic architecture is not a design
  requirement for every application.

## Archives and restoration

All 20 existing copies were preserved byte for byte under
`/Users/pt/Desktop/pt2nd/codex-audit-2026-09-12/disabled-skills/<skill-name>/`.
Each skill has a `restore-manifest.json` recording original paths and file
hashes. The copies may differ; retirement did not reconcile their bodies.

These archives are optional historical references outside active skill roots.
Do not automatically load them or follow references to retired skills in old
reports and completed backlog records. Restore only on an explicit request,
after checking that the original paths have not been reused.
