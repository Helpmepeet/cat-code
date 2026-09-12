**Streaming and file-lock follow-up, 12 September 2026**

Completed the three follow-ups recorded in the
[earlier reliability sweep](2026-09-12-reliability-sweep.md). Three subagents ran
on GPT-5.6 Sol with high reasoning effort, one per issue. The parent reviewed
the combined changes, found and fixed one additional retry path, and ran the
final integration checks. All provider tests used synthetic responses and
tokens; no live provider or account was exercised.

**Changes and demonstrated failures**

| Area | Before | After |
|---|---|---|
| General file-mutation locks | Two processes could lock a file through its real path and a symlink independently. A subprocess probe produced `{edits:[2]}` where both updates should survive as `{edits:[1,2]}`. | `canonicalFileMutationPath()` in [atomicFile.ts](/Users/pt/cat-code/src/utils/atomicFile.ts:42) resolves existing files, missing files under linked directories, and dangling final links. Multi-file acquisition canonicalizes before deduplication and ordering. The cross-process probe preserves both updates; a real FileEdit call waits for the target lock. |
| WebSocket incomplete responses | After receiving `response.incomplete`, the event iterator kept waiting for another event. | The [WebSocket terminal branch](/Users/pt/cat-code/src/services/api/codex-websocket-transport.ts:1494) terminates the turn, closes the physical socket, and retains the last completed continuation baseline. Initial priming and shared stream processing return a terminal provider error. Tests prove no HTTP replay, no automatic continuation, preservation of partial text, and no false completion of an incomplete tool call. |
| HTTP SSE framing | The parser accepted only `data: ` and parsed each data line independently. A synthetic provider response with no-space and multiline fields failed as premature EOF. | [httpSseToEvents()](/Users/pt/cat-code/src/services/api/codex-fetch-adapter.ts:1622) assembles event data, accepts optional space after the colon, and handles LF, CR, and CRLF across chunks. Comments and unrelated control fields are ignored. Existing EOF, cancellation, and prompt-completion behavior stays covered. Line-terminated final-event compatibility is retained. |
| Outer streaming fallback | Even after the adapter fixes, a failed or incomplete provider response following an encrypted reasoning carrier dispatched a second, non-streaming request. Both new regressions observed `[true,false]` stream flags. | The [fallback guard](/Users/pt/cat-code/src/services/api/claude.ts:2769) preserves the terminal provider verdict. Both regressions now observe one request and an API error. Ordinary pre-output transport fallback still passes its existing positive test. |

Independent integration review identified the dangling-link case before the
locking slice was finalized. A link can become live between canonicalization
and a caller's later read; it now shares the missing destination's lock from
the beginning. The probe covers a relative link target containing a linked
directory followed by `..`.

**Changed files**

- [atomicFile.ts](/Users/pt/cat-code/src/utils/atomicFile.ts)
- [atomicFile.probe.test.ts](/Users/pt/cat-code/src/utils/atomicFile.probe.test.ts)
- [atomicFile.probe.child.ts](/Users/pt/cat-code/src/utils/atomicFile.probe.child.ts)
- [codex-websocket-transport.ts](/Users/pt/cat-code/src/services/api/codex-websocket-transport.ts)
- [codex-websocket-transport.test.ts](/Users/pt/cat-code/src/services/api/codex-websocket-transport.test.ts)
- [codex-fetch-adapter.ts](/Users/pt/cat-code/src/services/api/codex-fetch-adapter.ts)
- [codex-fetch-adapter.test.ts](/Users/pt/cat-code/src/services/api/codex-fetch-adapter.test.ts)
- [codex-incomplete-response.test.ts](/Users/pt/cat-code/src/services/api/codex-incomplete-response.test.ts)
- [claude.ts](/Users/pt/cat-code/src/services/api/claude.ts)
- [claude-streaming-fallback.test.ts](/Users/pt/cat-code/src/services/api/claude-streaming-fallback.test.ts)
- This report.

**Final parent verification**

Commands ran from `/Users/pt/cat-code`. The five focused groups below contain
377 passing tests across 19 files, with no failures.

| Command | Result |
|---|---|
| `bun test src/services/api/codex-fetch-adapter.test.ts src/services/api/codex-websocket-transport.test.ts src/services/api/codex-incomplete-response.test.ts src/services/api/codexPartialStreamRecovery.e2e.test.ts src/services/api/codex-continuation-e2e.test.ts src/services/api/claude-streaming-fallback.test.ts src/services/api/withRetry.test.ts src/services/api/errorUtils.test.ts` | 186 pass, 0 fail; 591 assertions. |
| `bun test src/utils/atomicFile.probe.test.ts src/tools/FileReadTool/FileReadTool.test.ts src/tools/FileEditTool/FileEditTool.test.ts src/tools/FileWriteTool/FileWriteTool.test.ts src/tools/NotebookEditTool/NotebookEditTool.test.ts src/tools/FilePatchTool/FilePatchTool.test.ts` | 91 pass, 0 fail; 259 assertions. Includes actual subprocess contention and FileEdit execution. |
| `bun test src/tools/FilePatchTool/FilePatchTool.permissions.test.ts src/tools/FilePatchTool/applier.test.ts src/tools/FilePatchTool/parser.test.ts` | 84 pass, 0 fail; 152 assertions. |
| `bun test src/services/extractMemories/extractMemories.test.ts` | 14 pass, 0 fail; 34 assertions. |
| `bun test src/services/teamMemorySync/teamMemorySync.probe.test.ts` | 2 pass, 0 fail; 14 assertions. |
| `bun run build:dev:full` | Passed. Zero undefined names; bundled and executed `cli-dev --version`: `2.1.87-dev.20260912.t090015.shaa375ab57`. Map lint passed with seven existing advisory warnings. |

The memory suites run in separate processes. A worker's combined invocation
hit a timeout caused by Bun module mocks leaking between suites; both passed
when isolated, including the parent's final commands above. No production
change was made to hide that test-isolation issue.

Stale-reference and caller review covered imports, tests, and current maps.
The removed HTTP-only incomplete error and renamed initial-error helper have
no stale production references. All shared mutation-lock callers were checked,
including memory extraction and team-memory synchronization. No dependencies,
persisted schemas, permission rules, telemetry schemas, feature gates, or
desktop protocol boundaries changed. Existing map routes remain valid.

**Implementation checkpoints**

| Commit | Change |
|---|---|
| `168ccfff` | Canonical file-mutation lock identities and subprocess regressions. |
| `4f717374` | WebSocket incomplete termination and continuation-baseline regression. |
| `6146237b` | Preserve terminal provider errors through the outer streaming fallback. |
| `a375ab57` | Combined HTTP framing and shared incomplete-response handling, with regression tests. |

Only explicit owned paths were committed. Other sessions' existing renderer,
map, migration, and scratch changes were preserved. Nothing was pushed.

**Remaining limits**

- File locking coordinates cooperating engine writers. It does not make the
  final filesystem check and rename indivisible against arbitrary external
  programs, nor promise synchronization across hard-link aliases.
- Malformed JSON SSE data is still skipped, preserving prior behavior.
- Live-provider behavior, desktop GUI operation, and Electron hardening were
  not exercised in this engine-only follow-up.
- The pre-existing map advisory warnings and memory-suite mock isolation issue
  remain. No blocker remains for the three requested fixes within the tested
  scope.
