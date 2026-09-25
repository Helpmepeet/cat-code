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

## Fourth batch and broad-run evidence

The retired Accounts analytics range handler left behind one source-inspection test in `App.test.tsx` that required the removed handler text. It failed 87 pass / 1 fail before removal and passed 87/87 afterward. LCOV on the same 200 source files stayed 9,891/43,139 lines (22.93%). The active Accounts view test already asserts that analytics are absent; the deleted source test could no longer guard a live call site.

A broader `bun test src/` exploration with the temporary preload produced 4,277 pass, 2 skip, and 47 fail before this stale test was removed. The `src/` pattern also matched `app/renderer/src/` tests. The run cannot establish full coverage: transcript-lease tests tried to chmod `/Users/pt/.cat-code/transcript-leases` outside the sandbox; server-binding and OAuth tests hit `EPERM`; several integration tests timed out. These failures need isolated routing and a scratch `CLAUDE_CONFIG_DIR` before a comparable full baseline. Current provisional count after the fourth batch: 8,266 declarations, down 78 (0.93%); 100 runtime cases removed. The remaining provisional deletion target is 1,591 declarations.

Isolated reruns confirmed that a scratch `CLAUDE_CONFIG_DIR` fixes the transcript-lease failures (54/54 pass) and local socket permission fixes the OAuth listener (1/1 pass) and cross-process account-refresh probe (5/5 pass). A later desktop group with scratch config and local socket permission ran 5,090 pass, 1 skip, 9 fail, 1 module error. Six failures require an API-key fixture, two involve run-controls expectations, and the module error came from a historical test copy under `tmp/` accidentally matched by the broad `app/` pattern. These exploratory runs are not valid full coverage baselines; final routing must pass explicit tracked test paths in isolated groups.

## Fifth batch

Removed 14 renderer cases from `TranscriptView.test.tsx` and `transcriptProjector.test.ts`: restore-phase replays, source-shape checks, repeated markdown/background/Branch assertions, and fixture or projector wrapper checks already covered at stronger boundaries. The pending-usage assertion moved into the rendered empty-pane test using an account with unrecognized usage; the fixture nonempty assertion moved into the existing projection loop. The generated-image render test remains, without its three source-string assertions. No production code changed.

The seven related suites passed 533/533 cases before and 519/519 after. LCOV on the same 68 source files remained 12,507/17,489 lines (71.51%). App typecheck passed. Current provisional count: 8,252 declarations, down 92 of 8,344 (1.10%); 114 runtime cases removed. The provisional 20% target requires 1,577 further declaration removals, plus final runtime-count and full-coverage verification.

## Sixth batch

Removed two engine cases: a repeated deterministic truncation-helper call already proved at the wire translation boundary, and a websocket turn-state absence check whose fixture never supplied turn state. The remaining websocket case supplies the actual upgrade header. Removed five sidecar cases whose unsupported-value or unknown-task verdicts came entirely from fake domains, whose missing-domain branch was identical across verbs, or whose non-JSON-safe ready-frame check was repeated by the later dropped-frame-record test. The real domain, routing, and record tests remain. No production code changed.

Engine owner suites passed 165/165 before and 163/163 after, with identical LCOV (34,563/272,245 lines on 1,188 files) using the temporary bridge preload. The sidecar cohort had the same two existing run-controls expectation failures before and after: 335 pass / 2 fail before, 330 pass / 2 fail after. Its LCOV was identical at 40,140/284,036 lines on 1,227 files. Current provisional count: 8,245 declarations, down 99 of 8,344 (1.19%); 121 runtime cases removed. A further 1,570 static declarations are needed for the provisional 20% target.

## Seventh batch

Removed three repeated renderer cases. `AskQuestionFlow.dom.test.tsx`'s mount-focus check was contained in the later composer-focus test, which starts with a focused textarea and asserts the card takes focus. Its single Enter case was also contained there; the `defaultPrevented` assertion was transferred to preserve the browser-event contract. `paneAnchorModel.test.ts`'s bottom-lock result repeated the identical metrics, correction, lock flag, and expected adjustment in the following case, which also proves the unlocked result. `SessionPane` owns the question flow, and `markdownScrollCoordinator` calls the anchor selector; both production paths remain. The original cases date to the August keyboard/follow fixes, and the later cases preserve the intended regressions. No production or test-support code was deleted.

The two owner suites passed 53/53 before and 50/50 after. LCOV on the identical seven source files stayed 662/916 lines (72.27%), with zero covered-line status changes. The three reviewed near-duplicate groups in sidecar depth-cap, recall validation, and forged task IDs were retained because each checks a distinct protocol or closed-schema branch. Similar account, token-refresh, and websocket continuation tests were likewise retained for their distinct lease, persistence, or normalization behavior. Current provisional count: 8,242 declarations, down 102 of 8,344 (1.22%); 124 runtime cases removed. A further 1,567 static declarations are needed for the provisional 20% target. Full-suite coverage comparison remains unverified.

## Eighth batch and tracked-file run

Removed six declarations that produce eight runtime cases. Three focused-dialog TUI cases repeated the complete priority or exit fixtures already covered in the same suite. A three-row status/sleep table manually composed two independently tested selectors, without exercising their REPL wiring; the direct status and operational-work tests remain. In `App.test.tsx`, a source-string check required one shared `QueuedRow` implementation even though rendered cold-spawn and queued-row behavior is tested, and an empty worker dock case asserted only the absence of the word `subagents`; empty `TasksStrip`, positive dock wiring, and settled-worker cases remain. `REPL` and `SessionPane` continue to call these production owners. No production or test-support code changed.

The two owner suites passed 256/256 before and 248/248 after with the temporary import preload. LCOV was identical on all 1,378 source files: 40,171/314,365 lines (12.78%) and zero covered-line status changes. Current provisional count: 8,236 declarations, down 108 of 8,344 (1.29%); 132 runtime cases removed. A further 1,561 static declarations are needed for the provisional 20% target.

An attempted complete run supplied all 676 tracked test paths, scratch `CLAUDE_CONFIG_DIR`, and the preload, with parallel file isolation. Bun still matched one ignored historical test copy under `tmp/` because its path contained a supplied pattern. The run reached 8,464 pass, 9 skip, 46 fail, and 1 module error across 677 files. The failures include fixture-dependent auth/model suites, process migration contention, timeouts in QueryEngine force integration, and the two known run-controls failures. This run produced LCOV but is not a clean or reproducible full-suite coverage gate. A corrected route needs explicit `tmp/` exclusion and isolation of tests that compete over global process state.

The identical command after the eighth batch reached 8,457 pass, 9 skip, 45 fail, and 1 module error. Its aggregate LCOV on the same 1,748 source files was 180,149/396,517 lines (45.433%) before and 180,194/396,505 lines (45.446%) after. The denominator changed by 12 instrumented lines in four unchanged source files, and one previous failure passed on rerun, so this is only a provisional signal. All 17 files with failures were rerun individually under scratch configuration with a 10-second timeout; each retained at least one failure. Their failures cannot be attributed to parallelism alone, and a passing full-suite gate requires separate baseline repair.

## Ninth batch

An import graph and direct reference search found `bannerStackModel.ts` had no production caller; its three helper cases in `BannerStack.test.tsx` exercised only that dead state model. The renderer uses `BannerStack` directly, and its rendering, tone, action, and empty-state cases remain. The render fixture now supplies its two banners directly. `AskParentSessionTool/constants.ts` was a two-line re-export used only by a test; that test now imports the production name from `prompt.ts`, and the re-export was deleted. The FilePatch generation grammar looked similar in the graph, but its prompt-byte contract was retained.

The two owner suites passed 41/41 before and 38/38 after, using the temporary import preload. LCOV on 1,181 shared source files was unchanged at 28,564/271,744 lines (10.51%), with zero covered-line status changes; only the two deleted test-only modules disappeared from the source set. The app typecheck and full development build passed. Current provisional count: 8,233 declarations, down 111 of 8,344 (1.33%); 135 runtime cases removed. A further 1,558 static declarations are needed for the provisional 20% target.

## Tenth batch

Removed a sidecar test that monkeypatched `AppSessionController.submit` to throw synchronously. The production method is declared `async`, so real body throws reject its returned promise and are handled by the asynchronous settlement path. The fabricated test was the sole reason for staged-message cleanup inside `startTurn`'s synchronous catch. That unreachable cleanup and its explanatory comment were removed; the catch still resets active-turn observation and schedules the next drain. Existing queue replay and real rejection tests remain.

`sidecarServer.test.ts` passed 299/299 before and 298/298 after with the temporary import preload. LCOV on the same 1,222 source files changed from 39,285/283,343 (13.865%) to 39,282/283,340 (13.864%); the three instrumented lines that the fabricated test alone covered were removed from production. Scoped sidecar typecheck passed. Current provisional count: 8,232 declarations, down 112 of 8,344 (1.34%); 136 runtime cases removed. A further 1,557 static declarations are needed for the provisional 20% target.

## Eleventh batch

Removed seven `getClassifierFallbackModel('gpt-5.6-luna', error)` cases in `enableAutoModeFlag.test.ts`. Every input returned `undefined` at the retired ladder endpoint, so the assertions could not distinguish retryable errors from terminal errors. The `yoloClassifier.test.ts` ladder case now exercises code-based and embedded-status transient errors through an active Sol fallback, plus an embedded 404 rejection; the direct error-classification and live ladder cases remain. Removed one account uncap case whose old-cap/newer-usage fixture and healthy/cappedAt assertions repeat the final phase of the stronger stale/grace-window test in the same file. No production code changed.

With a scratch config, fake API key, feature flags, and temporary bridge preload, the classifier/account suites had 115 pass / 2 fail before and 107 pass / 2 fail after; the failures are unchanged stale default-mode and retired model expectations. The classifier owner suite passed 28/28. Unioning its LCOV with the before cohort and comparing to the three-suite after run gives identical coverage on 1,181 source files: 33,724/271,760 lines (12.409%), with no lost covered lines. Current provisional count: 8,224 declarations, down 120 of 8,344 (1.44%); 144 runtime cases removed. A further 1,549 static declarations are needed for the provisional 20% target.

## Twelfth batch

Removed three no-owner diagnostic cases in `sessionStorage.test.ts` that called wrappers sharing `appendSystemDiagnostic`'s null-owner path. The existing `recordCodexSendPath`/`recordCodexStreamSurface` case protects that path; owned-write and distinct agent-owned cases remain. Removed two direct `getTotalInputTokens` arithmetic replays: zero/missing cache fields are covered by the nonzero missing-fields and cache-rate denominator cases; the Codex adapter fixture remains in the cache-hit-rate test, while the three-bucket sum remains in the native usage test. No production code changed.

The two suites passed 101/101 before and 96/96 after under scratch config with the temporary bridge preload. LCOV on the same 1,178 source files stayed 33,431/270,083 lines (12.378%) with no lost covered lines. Five direct redemption-eligibility cases were retained after checking `codexStatus.ts`, a second production caller beyond the Settings candidate builder. Two rule-inventory assertions were retained because they pin hard/soft rule count and named security categories independently of the vendored inventory equality comparison. Current provisional count: 8,219 declarations, down 125 of 8,344 (1.50%); 149 runtime cases removed. A further 1,544 static declarations are needed for the provisional 20% target.

## Thirteenth batch

Removed 15 renderer cases across eight owner suites. The deleted cases asserted source text or exact CSS classes, compared values with themselves, repeated a model branch or action result already exercised nearby, or used server rendering to claim behavior that requires an interaction. The surviving tests cover markdown window bounds and measurements, welcome usage states and theme rendering, output search limits, worker filtering, session actions, face identity and registry behavior, fast-mode controls, and exact bulk-export messages. No production code changed.

The same eight suites passed 307/307 before and 292/292 after. LCOV on the identical 40 source files stayed 5,177/8,728 lines (59.315%), with no lost covered lines. App typecheck and `git diff --check` passed. Current provisional count: 8,204 declarations, down 140 of 8,344 (1.68%); 164 runtime cases removed. A further 1,529 static declarations are needed for the provisional 20% target. The final repository-wide coverage comparison remains open.
