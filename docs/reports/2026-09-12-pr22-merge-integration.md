# PR #22 combined integration verification

Date: 2026-09-12

The user requested merging PR #22 together with the other session's changes. The combined production/test snapshot is `6f8ebe29aad1fd7a60af98e065970841e62ee34d`: reviewed PR head `f7e98b9e` plus local main `36394421`. A later preservation merge, `6f322b87`, changes documentation only relative to that tested snapshot.

## Included work

- The original subsystem remediation and all seven independently verified PR findings, detailed in [the follow-up report](2026-09-12-pr22-review-followup.md).
- Completed local main work: updated agent, tool, retry, verification and progress instructions; desktop-interface and host-timezone context; streaming delivery coordination and its benchmark/results documentation. Production delivery remains immediate at zero milliseconds. This merge does not enable delayed batching.
- The three uncommitted account-label files on main were byte-identical to the account baseline already imported into the PR. They were preserved, together with five existing routing-map updates, in main commit `71213ff9`, then combined into the PR. The account test overlap resolves to the previously tested PR version; both map refresh sets are retained.

Separate worktrees and untracked design mockups were not part of this integration. Their files remain intact.

## Verification

All commands ran from the isolated PR worktree. The test wrapper creates a temporary configuration directory and uses inert credentials, with telemetry and nonessential traffic disabled. No live account or transcript was used, and no GUI was launched during this merge task.

| Command | Result |
|---|---|
| `bun tmp/subsystem-fixes-2026-09-12/run-isolated.ts bun test app/` | 4,853 passed, 0 failed; 28,152 assertions; 297 files; 121.69 seconds. Local sockets and fixture process inspection required sandbox escalation. |
| `bun tmp/pr22-merge-2026-09-12/run-matrix.ts` | 136 passed, 0 failed; 755 assertions; 16 file-isolated suites covering prompts, provider instructions, permissions, MCP identity, worker resume/handoff, queued input, account recovery and stats. |
| Isolated `bun test ./app/main/liveFrameBatcher.test.ts` | 24 passed, 0 failed; 71 assertions, checked by the integration reviewer. |
| Isolated `bun test ./app/renderer/src/leaseState.test.ts --timeout 10000` after overlap resolution | 36 passed, 0 failed; 125 assertions. App.tsx, leaseState.ts and leaseState.test.ts all match the tested snapshot byte-for-byte. |
| Isolated `bun run build:dev:full` | Passed: map lint, undefined-name lint, branch lint, development bundle and version print. Existing app files ignored by root ESLint produced 19 warnings, not errors. |
| Isolated `bun run --cwd app typecheck` | Passed, including Fast Refresh boundary lint. |
| Isolated `bun run --cwd app typecheck:sidecar` | Passed; 5,562 upstream diagnostics ignored by the owned-file wrapper. |
| Isolated `bun run --cwd app renderer:build` | Passed with the existing large-chunk warning. |
| `bun run maps:lint` and `git diff --check` | Passed; 17 maps and 7 existing recommended-section warnings. |

The application test count rose from 4,812 to 4,853 because local main adds 41 tests in four files. The sixteen-suite matrix is recorded in full in its JSON artifact. After the tested merge, only routing documentation and this integration evidence changed.

Two GPT-5.6-Sol workers independently checked prompt/engine compatibility and streaming/replay/close ordering. Neither found a concrete incompatibility. The merge adds no inbound channel, preload export, protocol frame, secret path, frame-limit change or BrowserWindow security policy, so it does not require a fresh security-boundary hardening run under the phase-5 Standing rules.

## Limits and evidence

Visual acceptance and mounted React/IPC-close coverage remain unverified. The prior 19/19 Electron hardening result is historical; this task did not rerun it. The streaming measurements remain the other session's evidence, with nonzero activation and its required acceptance still pending. Host timezone injection has no direct getUserContext test; the provider-context serialization tests and build pass. Known-red root typechecking was not rerun for this combination; the prior equivalent-graph comparison remains described in the follow-up report.

Raw evidence and the original main-state backup are preserved after worktree cleanup under `tmp/pr22-merged-2026-09-12-evidence/pr22-merge-2026-09-12/` in the main checkout. Earlier review and subsystem artifacts are adjacent under the same evidence root. These local fixture artifacts are not published with the PR.
