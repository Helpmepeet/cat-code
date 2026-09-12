# Subsystem review fixes

Implementation of the 24 confirmed findings in [the review](2026-09-12-ten-subsystem-review.md), requested on 2026-09-12.

Worktree: `/Users/pt/cat-code/.worktrees/subsystem-fixes`, branch `codex/subsystem-fixes`, starting commit `a375ab57`. GPT-5.6-Sol workers implement bounded groups; the parent coordinates integration and verification. The original working tree remains separate.

The account UI amendment reviewed as AC3 was still uncommitted in the original working tree. Its three relevant files were imported as a baseline before the account worker began. The exact import is preserved locally at `tmp/subsystem-fixes-2026-09-12/account-ui-baseline.patch`; other uncommitted original-tree changes were not imported.

| Findings | Owner | Status | Evidence |
|---|---|---|---|
| UA1–UA4 | fix_analytics | Fixed | `8c302e35`, `e0381f57`; 134 focused tests passed; subagent-only active-day regression passed |
| AC1–AC3 | fix_accounts | Fixed | `b885d3d2`; recovery 3, pool 85, lease 36, retry 2 and desired probes 3 passed |
| CO1–CO3 | fix_compaction | Fixed | `b78b71e2`; 137 focused tests passed, one intentional feature-off skip |
| RS1–RS3 | fix_analytics | In progress | Pending |
| PE1–PE2 | fix_analytics | Fixed | `7a9d666e`; peer/composer/App suite 245 passed |
| MC1 | fix_analytics | In progress | Pending |
| QU1 | fix_queue_permissions | Implemented; full-flow coverage in progress | `46af30b8`; query race control/interruption tests 4 passed |
| QU2 | fix_analytics | Fixed | `7a9d666e`; out-of-order multi-batch refusal regression passed |
| PR1–PR2 | fix_accounts | Implemented; permanent process coverage in progress | `a56684a6`; real lease race and park probes passed |
| HI1–HI2 | fix_accounts | Implemented; second-read coverage in progress | `a56684a6`; history probes and focused replay/storage/projector suites passed |
| SP1–SP2 | fix_queue_permissions | Implemented; full query handoff coverage in progress | `c4543282`, `46af30b8`; focused authority/settlement tests passed |

## Verification

Workers must demonstrate regressions at the production boundary with isolated fixtures and run existing focused suites. The parent will run the engine build, desktop suite, app and sidecar typechecks, renderer build, and final diff checks after integration. No live accounts, provider usage, or desktop GUI launch is authorized by this implementation request. The Electron hardening smoke launches the desktop and therefore remains a separate per-run authorization gate.

Unverified suggestions in the review are outside the confirmed-finding scope. This report will record actual results and any unresolved limits before completion.
