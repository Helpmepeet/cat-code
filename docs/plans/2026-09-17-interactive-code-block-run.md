# Interactive Run for command blocks

Date: 2026-09-17
Status: Implementation plan. The feature is not implemented.

## Agreed behavior

Reuse the existing assistant code block. Add a Run icon beside Copy.
Clicking Run starts the displayed command in the conversation's project and
opens an interactive terminal immediately below that code block. The user can
type answers, use arrow keys, and press Enter through multiple prompts.
All terminal output is automatically shared with the owning agent.

No separate terminal page, output-sharing toggle, or “Ask agent” button.

## User flow

1. A completed shell code block shows Copy and Run. An incomplete streaming
   block cannot run.
2. Run opens the terminal beneath the block and starts the entire command once.
   The working directory is visible. Existing session permission policy applies.
3. The user interacts directly with the running program. Output appears in the
   terminal and enters the agent's session automatically, including output
   produced before the command finishes.
4. Ctrl+C sends the terminal interrupt. Stop terminates this run and its owned
   child processes. Run stays disabled while this run is active.
5. On completion, keep the output and show the exit status. Run again creates a
   fresh run. Keep earlier runs available under the same block.

The terminal is for the selected command's lifetime. Multi-step installers and
interactive CLIs are supported; a persistent general-purpose shell after the
command exits is outside this initial scope.

## Implementation

### 1. Prove interactive process support

Build a small isolated PTY integration fixture before wiring the UI. A PTY is
the process connection needed for terminal input, prompts, cursor movement,
and resizing. The existing pipe-based runner is useful reference code but is
not a substitute for a PTY.

Verify launch, output, typed input, arrow keys, resize, Ctrl+C, exit status, and
cleanup under the real Bun sidecar runtime. Also verify development and packaged
app loading. Select the terminal renderer and PTY backend after this check;
request approval before adding dependencies, as required by `CLAUDE.md`.

Keep ownership in the session sidecar, with an engine runtime entry point for
execution. Reuse the session's actual workspace, environment setup, permission
context, and applicable sandbox behavior. Do not create a renderer-accessible
raw process-spawn API or call CLI bash mode as a permission bypass.

Record the bounded interactive capability in a decision document: initial
launch goes through the engine's gate, and subsequent keyboard input addresses
only that authorized run. The input contract must explicitly cover interactive
programs that themselves accept commands. Preserve the existing architecture
and resolve this against the security baseline before enabling the feature.

### 2. Add session-owned terminal runs and transport

Give every execution its own run ID, owning session ID, source message/block
identity, status, output sequence, and exit result. A repeated start request
must resolve to the same run rather than launch the command twice.

Add fixed bridge actions for start, input, resize, and stop, and outbound events
for output and state. Route them through the existing preload, main, supervisor,
and Unix-socket path. Validate closed schemas, sizes, ownership, and run state
at the sidecar. Resolve cwd and environment there, not from renderer paths.

Batch output into bounded transport chunks without discarding content. Support
reattaching to an existing run after renderer reload without re-executing it.

Likely owners:

- `app/shared/protocol.ts` and the existing IPC-channel declarations.
- `app/preload/preload.ts` and `app/main/main.ts`.
- A new terminal domain beside `app/sidecar/taskControlDomain.ts`.
- A corresponding real engine entry point under `src/app-runtime/`.

### 3. Reuse the existing code-block UI

Extend `CodeBlock` with an optional Run action, supplied only for assistant
shell blocks. Preserve Copy, source text, and existing styling. Cover both
ordinary and windowed code-block rendering paths.

Start with explicit `bash`, `sh`, `shell`, and `zsh` fences. Preserve the command
text; do not strip prompt markers or guess commands from arbitrary prose.
Treat the language label as eligibility metadata and execute with a documented,
compatible session-shell policy.

Mount the terminal directly beneath the source block. Focus it on an explicit
Run click and route keyboard input only while it is focused. Store run state
outside mounted code-block components so scrolling, virtualization, and tab
switches cannot restart or lose a process. Existing session attachment handles
restorable sessions before a start is sent.

Primary files: `app/renderer/src/TranscriptView.tsx`,
`app/renderer/src/markdownRenderPlan.ts`, and `app/renderer/src/SessionPane.tsx`.
Add a terminal component and a separate `.ts` state module.

### 4. Share all output with the agent automatically

Fork each run's output stream to both the terminal view and the owning engine
session. Include the command, cwd, ordered output, and final exit status. Keep
the complete output record; do not add a feature-specific tail-only policy,
summary filter, or manual sharing step.

Use the session's existing input/attachment delivery mechanism for model
context, with explicit terminal-output provenance. If a model request is
already in flight, new output becomes available at its next supported input
boundary. If the agent is idle, retain it for the next turn. Sharing output
does not start a new AI response for every chunk.

Use per-run output sequence numbers to avoid duplicate context after reconnect
or replay. Batch deltas rather than repeatedly appending the full accumulated
log. Preserve textual output while interpreting terminal control sequences for
the agent-facing representation. Terminal control bytes are not instructions.
Existing context limits, compaction, and secret-handling rules still apply;
sharing all output does not imply an unlimited model context window.

Verify delivery through both supported provider paths. The renderer transcript
alone is not proof that the model received the output. This is a dedicated
command-output stream, not diagnostic-log injection.

### 5. Complete lifecycle handling

Keep a run alive across scrolling, tab changes, and renderer reattachment while
its sidecar is alive. Register live runs with the existing live-work/parking
gate so idle parking cannot terminate a waiting interactive command.

Keep command ownership separate from the agent turn: stopping a terminal run
must not abort an unrelated model response, and stopping the agent must not
silently kill a user-controlled terminal. Output joins a busy agent only at
supported input boundaries.

On explicit session close or app shutdown, clean up owned processes. On sidecar
failure, retain available output and mark the run interrupted. Never auto-rerun
a command during restore. Reuse existing process-tree and task lifecycle
helpers wherever they cover the PTY backend correctly.

## Acceptance checks

- A simple command runs once and shows its output and actual exit status.
- A multiline block executes as one script with intact quoting and heredocs.
- An interactive fixture completes multiple question/answer exchanges and an
  arrow-key selection in the same process.
- Output is available to the owning agent while the program is waiting for
  input and after completion, without a sharing click.
- Busy-agent delivery and idle-agent delivery preserve order without creating
  unsolicited turns or duplicate output. Cover both provider paths.
- Stop/Ctrl+C behave correctly and do not affect unrelated sessions or turns.
- Double-click, tab switch, scrolling, and renderer reload do not start another
  process. Sidecar restart does not rerun an old command.
- Large/rapid output is transported in bounded chunks without silent loss;
  exit cannot overtake undelivered output.
- Invalid frames, cross-session run IDs, disallowed launches, and input to
  finished runs are rejected at the receiving boundary.
- Live runs prevent idle parking; closing their session cleans up children.

Use isolated process fixtures for execution tests. Run the affected engine
tests and dev build, desktop tests and both typechecks, and the renderer build.
Run the desktop hardening check and Cat Code Dev GUI verification when
authorized for those runs. Exercise the packaged PTY loading path too.

## Delivery order and effort

1. PTY/backend and packaging proof.
2. One vertical slice: Run → interactive input/output → exit, in an isolated
   session.
3. Automatic agent-context delivery, including delivery during active turns.
4. Reattachment, persistence, lifecycle integration, and verification.

The visible UI change is small. Most work is terminal integration and reliable
session delivery. Budget roughly **1–2 weeks of focused implementation** for
this interactive scope, with the PTY/packaging proof refining the estimate.
The earlier 2–3 day estimate covered a noninteractive command runner and no
longer describes the requested feature.

## Source anchors

- [Repository constraints](../../CLAUDE.md)
- [Desktop runtime map](../maps/web-app-runtime.md)
- [Security minimum](../migration/decisions/SECURITY-MINIMUM.md)
- [Permission boundary](../migration/decisions/PERMISSION-BOUNDARY.md)
- [Code-block rendering](../../app/renderer/src/TranscriptView.tsx)
- [Markdown planning](../../app/renderer/src/markdownRenderPlan.ts)
- [Desktop protocol](../../app/shared/protocol.ts)
- [Sidecar dispatch and lifecycle](../../app/sidecar/sidecarServer.ts)
- [Engine session controller](../../src/app-runtime/AppSessionController.ts)
- [Permission-aware tool execution](../../src/services/tools/toolExecution.ts)
- [Existing shell runner](../../src/utils/Shell.ts)
- [Existing process lifecycle](../../src/utils/ShellCommand.ts)
- [Engine progress conversion](../../src/utils/queryHelpers.ts)

Planning evidence: source inspection plus 63 passing existing tests across
Markdown rendering, output projection, session control, and sidecar boundaries.
These validate existing building blocks, not the proposed interactive feature.
