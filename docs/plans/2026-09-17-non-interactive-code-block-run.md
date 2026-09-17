# Non-interactive Run for command blocks

Date: 2026-09-17
Status: Proposed implementation plan. No feature implementation has started.

This replaces the [interactive plan](2026-09-17-interactive-code-block-run.md)
and its three proposed terminal contracts for the first release. Those documents
remain historical proposals, not prerequisites for this smaller scope.

## Product behavior

Reuse the existing assistant code block. Add Run beside Copy. Clicking Run
executes the completed command in the conversation's project, using the existing
engine permissions and sandbox. Show plain-text output immediately below the
block as it arrives. Run becomes Stop; completion leaves output and the result
beside Run again. Copy continues to copy the original code.

There is no input field, terminal emulator, or interactive shell. Multiline
scripts, pipelines, and heredocs are allowed: non-interactive does not mean one
line. No attempt is made to classify arbitrary commands as interactive.

All retained printable output is automatically available to the owning agent
on the next explicit user message. There is no Share button, summary selection,
or automatic agent turn on completion. The agent cannot see output before it
is included in an actual model request.

## Deliberate first-release limits

| Choice | User-visible consequence |
| --- | --- |
| One command or agent turn at a time per session | Run is unavailable while the agent is working. While a run is accepted, awaiting permission, or executing, the composer remains editable but Send waits for completion or Stop. |
| Completed assistant shell fences only | No Run on streaming text, reasoning, nested worker messages, settings previews, or unlabeled code. |
| Session-configured Bash-tool shell | Fence tags identify shell code; they do not choose an executable. Show the resolved shell and project directory. PowerShell and other executors are deferred. |
| Closed standard input and no TTY | A prompt may fail, choose the program's own default, or wait until timeout. Do not automatically add confirmation flags or infer why it failed. |
| Finite foreground execution | No background-task promotion, persistent shell, server attachment, or watch-mode support. |
| Fresh process in the project directory | `cd` works inside a script but does not change the next run's or agent's working directory. Environment comes from the existing engine configuration, not an arbitrary external Terminal window. |
| Completed-result delivery on next user message | No mid-turn output injection or new model request merely to consume output. |
| No execution resumption after a crash | Unfinished runs become interrupted, with output explicitly possibly incomplete. They never restart automatically. |

Serialization is enforced in the sidecar, not only by disabled buttons. Use one
session execution reservation shared by user submissions, queued submissions,
goal/deferred continuations, and Run. Existing activity wins; reject a new Run
as busy instead of creating a hidden execution queue. Autonomous work waits at
the reservation boundary and resumes under its existing scheduling rules.
Run does not turn a pending autonomous task into an eligible output consumer.

## Execution and identity contract

1. Extract candidates from finalized, persisted assistant messages. Use the
   canonical `(engineSessionId, assistantMessageUuid, textContentBlockIndex,
   fenceOrdinal)` identity, counting every fence. Mint opaque candidate IDs and
   retain exact source bytes, language, digest, and parser version. Initially
   accept explicit `bash`, `sh`, `shell`, and `zsh` fences for the configured
   Bash-tool shell. Ordinary and windowed Markdown paths use the same mapping;
   identical neighboring commands must remain separate blocks.
2. The start request contains only `candidateId` and `startRequestId` inside the
   existing session envelope. Reject unknown/foreign/stale candidates, extra
   executable fields, untrusted workspaces, and unavailable tools before effects.
   Resolve command, cwd, shell, and environment in the engine. Rewind invalidates
   removed source candidates; branching gets a distinct run namespace.
3. Persist a run reservation before permissions or spawn. Double-click and
   lost-ack retries reuse the same start request ID; Run again uses a new ID.
   A retry returns the previous attempt, including its terminal state. An ID
   reused for another candidate is rejected. Reload queries existing attempts
   before allowing a retry; losing local UI state never automatically launches.
4. Invoke the real `runToolUse` pipeline and session context: input validation,
   hooks, permission resolution, sandbox selection, execution, and completion/
   failure hooks. Do not reuse CLI bang mode or call `BashTool.call()` directly.
   Route engine-minted permission requests through a run-scoped handler. Stop
   cancels only that run and its pending permissions. Display the effective
   command separately if hooks change it.
5. Add an internal finite-run policy to the existing shell execution path:
   closed stdin, no TTY, fixed project cwd, no cwd propagation, no explicit or
   automatic background promotion, bounded output, and a hard execution timeout.
   Hooks cannot override this policy. Keep normal agent Bash behavior unchanged.
6. Capture numeric exit code and termination reason before tool-result formatting.
   Shell exit code, not semantic interpretations such as grep's no-match handling,
   determines success. Use states `accepted`, `awaiting_permission`, `running`,
   then `succeeded`, `failed`, `denied`, `stopped`, `timed_out`, `output_limit`, or
   `interrupted`. A pre-spawn error is failed with a reason and no fabricated code.

Stop and timeout terminate the owned process group, with bounded graceful then
forced termination. Clean up owned descendants when the foreground shell exits;
shell syntax such as `command &` does not create a supported persistent job.
Do not promise containment of programs deliberately escaping process ownership
beyond the existing sandbox. Closing a view does not stop a run; closing its
session stops it. Active runs prevent sidecar parking.

## Output, storage, and recovery

Use a small versioned run/result store under engine-owned session storage,
with atomic writes and one live sidecar writer. Reuse session locking and
supervisor ownership. Store the accepted attempt before effects and the bounded
completed result before reporting it durably complete. This replaces the earlier
PTY journal, terminal checkpoints, and live chunk delivery ledger.

Proposed initial constants, centralized and adjustable after fixture testing:

| Bound | Behavior |
| --- | --- |
| Execution timeout: 120 seconds after spawn | Stop the run and report timed out; permission waiting is separately cancellable. |
| Combined raw stdout/stderr: 64 KiB per run | Stop at the admitted prefix and report output limit. Count raw bytes even if normalization removes them. |
| Undelivered output: 128 KiB per session | Reserve a full run allowance before launch; reject further runs when insufficient space remains. |
| Output payload: 16 KiB per IPC frame; 64 KiB queued per session | Apply backpressure or skip live previews and refresh from the bounded authoritative snapshot; never grow an unbounded send queue. |
| Completed results: 20 per session | Evict oldest delivered result bodies; never evict pending output. Show expired output honestly. |
| Candidates and retry receipts: 4,096 each; total feature store: 8 MiB/session, 128 MiB/application | Reserve capacity atomically before effects; reclaim only eligible delivered bodies, then reject at capacity. Do not evict retry identities and reinterpret old retries as new launches. |

Raw bytes and normalized output are both bounded; incremental decoding and
escape parsing must have bounded buffers too. Preserve printable text without
summarizing; strip terminal control sequences and render as escaped text, with
no HTML, terminal actions, clipboard operations, or automatic link activation.
Report malformed text conversion or incomplete output explicitly. The model
receives the same normalized text and status that the user can inspect.

The output cap limits capture, not the command's filesystem writes. At a limit,
bytes can still arrive during termination; discard them with the explicit
incomplete-output result. Do not claim the retained prefix is the command's full
output. This is the deliberate resource tradeoff behind automatic sharing.

Live output is an in-memory bounded snapshot; its crash durability is deferred.
Renderer remount/reload queries the same run and current snapshot. Main's replay
ring is a transport convenience, not result storage. Completed results survive
restart. After confirmed owner death, a replacement owner acquires the session
lock and marks unfinished records interrupted, never respawning them. Socket
loss alone is not proof the owner died. Read saved results without launching a
model turn; use the existing host session-history route when the sidecar is gone.

Process cleanup must also survive sidecar death. First verify the existing
supervisor/process-group machinery with an isolated child fixture, including
SIGKILL. If it leaves children alive, add a tracked parent-liveness guard before
shipping. Never recover by signaling an unverified stale PID or sweeping process
names. No full live-terminal recovery system is required.

## Automatic agent output

Keep completed results in a passive pending source, separate from prompt and
task-notification queues. Those queues can start turns. A result alone must not
call submit, wake an idle agent, or create a goal continuation.

At the next explicit user submission, collect pending completed results in run
order. Include command, actual cwd, run ID, status/exit code, and exact normalized
output as typed untrusted command-result attachments. Include failures, empty
results, stopped runs, and incomplete-output markers too. No raw wrapper text
may masquerade as a trusted user instruction.

For this MVP, deliver whole pending results with that submission, not streaming
ranges across tool rounds. Check the actual provider token budget and compact
using the normal engine path if necessary. If the complete pending set still
cannot fit, preserve it and report a context-capacity error before dispatch;
do not silently truncate or mark it delivered. The small pending cap bounds
this case but does not replace token accounting.

Persist exact attachments with the accepted user input before provider dispatch,
using run IDs as durable receipt IDs. Only then mark their results accepted.
Reconcile against canonical receipts on restart so a crash between those writes
does not insert duplicates. Provider retries reuse the persisted input. Ensure
receipt bookkeeping survives compaction; model-visible history may compact
normally after initial delivery. Non-persistent execution modes do not expose Run
until they can honor this contract.

Rewind removes accepted attachments with their conversation suffix and does not
automatically reinsert them; undelivered results remain pending in their original
session. Branches inherit only attachments in the copied conversation prefix,
not live attempts or pending results. There is no automatic execution on restore.

## Implementation sequence and acceptance checks

| Step | Deliverable and evidence |
| --- | --- |
| 1. Finite engine execution | Internal run policy through the real permission pipeline. Isolated fixtures cover stdout/stderr, code 0/nonzero, multiline/heredoc, EOF/default-taking input, a waiting prompt, long-running silent process, timeout, Stop, child cleanup, and output flooding. Verify no auto-background or cwd leakage. |
| 2. Candidate and run domain | Stable candidate mapping, session reservation, durable attempt/result store, quotas, retries, and scoped permissions. Prove foreign IDs/extra fields are rejected, denial prevents spawn, hooks/sandbox remain effective, concurrent start/submit is serialized, and lost acknowledgements never duplicate execution. |
| 3. Passive context delivery | Completed result attachments on explicit user submission. Inspect actual outbound requests with isolated fake transports for both provider paths. Cover no idle wake, no autonomous drain, full output, token exhaustion, persistence crash windows, retries, compaction, rewind, and branch. |
| 4. Bridge and existing code block | Fixed session-scoped candidate lookup, start, stop, status/result reads and bounded output frames. Add opt-in Run only to eligible assistant blocks. Verify ordinary/windowed/identical fences, streaming disabled, Copy, Send gating, Stop, remount/reload, failure, timeout, and expired results. |
| 5. Recovery and integration | Confirm completed results survive restart, unfinished attempts become interrupted without rerun, pending output is retained, active runs prevent parking, close/sidecar death clean up owned processes, and small injected quotas bound memory/disk/transport. |

For protocol work, validate closed inbound schemas at the sidecar receiver,
preserve the Unix-socket transport and app/engine session identities, and update
the fixed preload/IPC allowlist. Review protocol version compatibility, extend
`FRAME_RETENTION` exhaustively, update reducers/projectors and fixtures, and
regenerate affected engine/SDK snapshots from their owning sources. Register
persisted migrations through the existing migration owner if needed. Document
the candidate-only execution action under the existing permission boundary;
this plan does not authorize a raw exec channel or a security-baseline bypass.

Run focused engine tests plus `bun run build:dev:full`, affected desktop tests,
desktop and sidecar typechecks, and renderer build. Run full desktop tests for
the final cross-boundary change. Use isolated state and fake provider transports;
GUI/hardening runs follow repository authorization and Cat Code Dev rules.
Documentation-only changes need whitespace, local-link, and map-lint checks.

## Source owners and remaining uncertainty

- [Transcript UI](../../app/renderer/src/TranscriptView.tsx) and
  [Markdown planning](../../app/renderer/src/markdownRenderPlan.ts): reuse the
  code block; carry canonical identity through both rendering paths.
- [Desktop protocol](../../app/shared/protocol.ts),
  [sidecar](../../app/sidecar/sidecarServer.ts), and
  [runtime adapter](../../src/app-runtime/createQueryEngineAppSession.ts):
  validated actions, session reservation, permission routing, run ownership.
- [Tool execution](../../src/services/tools/toolExecution.ts),
  [Bash tool](../../src/tools/BashTool/BashTool.tsx), and
  [shell process](../../src/utils/ShellCommand.ts): full gates, finite policy,
  actual exit status, capture limits, and cleanup. The current Bash runner can
  background on timeout and its formatted result is not a raw process result.
- [Query engine](../../src/QueryEngine.ts) and
  [query loop](../../src/query.ts): durable attachments and actual provider input.
- [Replay buffer](../../app/main/replayBuffer.ts): bounded delivery only.

The UI is a small change. Overall difficulty is moderate integration work, much
smaller than the interactive plan: no PTY/emulator dependencies, keyboard/resize
protocol, concurrent agent/terminal handling, mid-turn output ranges, or terminal
checkpoint recovery. The first engine fixture should resolve the main uncertainty:
how much existing execution/lifetime code can honor the finite policy unchanged.
Do not assign a firm schedule before that evidence.

Evidence for this document is source inspection, not implemented behavior. The
earlier investigation's 63 passing existing tests do not prove these new contracts.
