# Test audit plan

## Target and measurement

- Remove at least 20% of the baseline test cases while preserving the observable contracts identified by the test-audit value bar.
- Use explicit `test`/`it` declarations as the provisional count: 8,344 at baseline commit `6e7666f9`, so the provisional 20% target is at most 6,675. The count was recomputed with the TypeScript AST across every tracked test file; the earlier 8,300 estimate missed 44 declarations. Confirm the runtime count when the full suite can run reproducibly; `test.each` can expand beyond the static count.
- Compare Bun LCOV line coverage on the same source-file set before and after each batch and at the end. The final aggregate may fall by no more than two percentage points.
- Keep the current worktree as the baseline. Existing Sidebar and workspace-map edits belong to another session and are outside this audit.

## Audit sequence

1. Establish reproducible full coverage by routing tests in file-isolated groups where the repository requires it. Record baseline failures separately. The first broad `bun test app/ --coverage` run hit sidecar socket and auth failures; several engine suites cannot import `isReplBridgeActive` from `src/bootstrap/state.ts` in the current checkout. Neither result is a valid full coverage baseline.
2. Audit one owner area at a time. For each candidate, record the exact test, its actual failure signal, the production owner and callers, stronger remaining proof, history, risk, and focused validation command. Retain independent security, protocol, storage, migration, prompt, default, package, and release contracts.
3. Remove high-confidence duplicates, source-shape assertions, and test-only seams in coherent batches. Run the owner and sibling tests, then compare LCOV against the fixed pre-edit file set. Stop a batch if the coverage drop exceeds two points or a distinct contract loses its owner.
4. Once the full baseline is reproducible, rerun the same complete routing after the final batch. Check the case-count target, aggregate LCOV delta, relevant package gates, formatting, and `git diff --check`.

## Completed first batch

| Area | Removed cases | Stronger remaining proof | Focused LCOV before and after |
|---|---:|---|---|
| Worker capability mapper | 5 | Worker prompt and ClaudeCli permission-boundary tests | 224/542 lines in the utility/eval cohort |
| Memory evaluation CLI validation | 1 | Specific unknown-case error assertion | 224/542 lines in the utility/eval cohort |
| Transcript view source and historical-markup assertions | 3 | Mounted Copy/Edit/Branch tests, rendered card/line behavior, and default preference test | 8,622/14,400 lines in the renderer cohort |
| React development performance filter | 1 | Real React commit test plus remaining lifecycle tests | 85/92 lines in the performance cohort |
| Renderer state selectors and submit handling | 7 | Merged-row, recent-route, rail, and batch-reducer tests; `selectSubmitAnswer` is now private | 1,819/2,279 lines in the state cohort |
| Main process literal and liveness replays | 2 | Supervisor cwd behavior and the six-status existence/readiness table | 874/894 lines in the main cohort |
| TUI hint and status replays | 26 runtime cases | Exhaustive independent hint set, direct status/work tests, and three mixed-state cases | 30,289/271,244 lines with a temporary bridge-export preload |
| Codex lease and adapter duplicates | 4 | Identical earlier cases, including a stronger terminal-code assertion | 36,850/269,685 lines with the same preload |
| Mailbox negative control | 1 | Correlated disk-path test and mailbox tests with real pending records | 29,234/271,194 lines with the same preload |

After the first batch, the provisional count was 8,316 declarations, down 28. The edited cohorts ran 50 fewer runtime cases; the difference arises from loops and a table that expand into multiple tests. The preload exists only in `/private/tmp` and supplies the missing export as `false` so unrelated engine suites can import; it does not repair the checkout. These focused coverage results do not establish the repository-wide two-point requirement.

## Second batch

| Area | Removed cases | Production owner and remaining proof | Focused LCOV before and after |
|---|---:|---|---|
| Codex identity reconciliation | 1 | The deleted module had no production caller. Active token-refresh and account-identity tests guard the current explicit-reauthentication behavior. | 30,711/271,199 surviving source lines both times, with the temporary bridge-export preload |
| Retired renderer timing and Accounts analytics | 42 | Usage timing and the Accounts analytics section have no production caller after their page redesigns. The live Usage page, Accounts page, and Transcript view tests remain. `formatModelDisplayName` and four tests remain; `UsageBarsIcon` remains for Sidebar. | 11,030/19,542 (56.44%) to 10,766/19,277 (55.85%) on 95 shared source files |

After the second batch, the provisional count was 8,273 declarations, down 71 of 8,344 (0.85%). The two batches removed 93 runtime cases. The renderer cohort lost 0.59 coverage points on shared files, within the two-point batch gate. The app typecheck and `bun run build:dev:full` passed. A full reproducible repository coverage comparison and the 20% deletion target remain open.

## Third batch

Six test callbacks had identical TypeScript token sequences to earlier tests in the same owner file. This check preserved string literal content, so cases with meaningfully different whitespace inputs were retained. The removed cases were the second zero-event websocket-close classification; three token-estimation ratio replays; the second SendMessageTool enabled check; and a second blocked-local-agent status check. Each earlier test uses the same input and assertion, and the live production seam remains. No production code was changed.

The four owner suites passed 272/272 cases before and 266/266 after, using the temporary bridge-export preload. LCOV was unchanged at 33,852/272,374 lines on the same 1,189 source files. Current tracked static count: 8,267, down 77 declarations (0.92%); 99 runtime cases have been removed. A further 1,592 static declarations must be removed to meet the provisional 20% target. This is a discovery count, not a deletion instruction: the test-audit retention bar still requires evidence for each candidate.
