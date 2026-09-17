# Terminal Run: candidates and authorization

Date: 2026-09-17
Status: Proposed implementation contract. Not implemented and not an amendment
to the active security baseline by itself.

Parent: [implementation plan](../../plans/2026-09-17-interactive-code-block-run.md).

## Decision

Run selects an engine-owned command candidate. It does not submit executable
text. Every launch uses the full existing Bash execution pipeline; no separate
mandatory confirmation is added on top of the session's normal permission policy.

## Candidate provenance and identity

- After an assistant message is finalized and persisted, the engine extracts
  closed `bash`, `sh`, `shell`, and `zsh` fences from its canonical text.
- The canonical block key is `(engineSessionId, assistantMessageUuid,
  textContentBlockIndex, fenceOrdinal)`. Count every fenced block in document
  order, including ineligible languages. Identical neighboring fences remain
  different blocks. Nested worker messages are excluded from the first version.
- Persist a random `candidateId` with that key, exact command bytes, language,
  source-content digest, and parser version. A hash alone is not an authority.
  Resolve cwd, interpreter, and environment from trusted session configuration
  at launch. A language tag grants no authority to select an executable.
- Use one pure fence-extraction contract for candidate mapping and both UI
  rendering paths. Carry the canonical key through ordinary `MarkdownCode` and
  windowed Markdown leaves. The sidecar still owns the authoritative parse.
  On a missing candidate or digest mismatch, withhold Run and refresh metadata.
- Candidate lookup rechecks that the source is still in the current canonical
  conversation. Rewind invalidates removed candidates; branch receives a new
  session namespace. Compaction can retain candidates backed by the persisted
  source history. Changing the parser version invalidates stale candidates.

## Start and retry contract

The only executable-selection payload is
`terminal.start { candidateId, startRequestId }`, inside the usual session
envelope. Closed receiving schemas reject command, cwd, interpreter, env, and
other extra keys. An unknown or foreign candidate is rejected before effects.

The renderer creates a random `startRequestId` and records it in its durable
session UI state before sending. Double-click and lost-ack retries reuse it.
Run again creates a new request ID. Clearing that UI state never triggers a
retry: reload first queries the authoritative run list.

Under the journal's session lock, persist `(startRequestId, candidateId, runId,
state=accepted)` durably before permission evaluation or spawn. A matching
retry returns the existing run and state. Reuse with a different candidate is
an error. Only one accepted/running attempt per candidate is allowed; a second
request returns `run_active` and that run's ID.

The pre-spawn record guarantees at-most-once launch across crashes: an uncertain
accepted/starting attempt becomes interrupted on recovery, never respawned.
This deliberately does not promise that every accepted click eventually starts.

Keep compact request tombstones for the session history's lifetime, even after
output retention expires. Cap candidates and start tombstones at 4,096 each
and their serialized registry at 8 MiB per session. At capacity reject new
entries with `terminal_history_limit`; never evict dedupe identities and then
reinterpret an old retry as a fresh launch. Session deletion removes the
namespace, so later retries fail as unknown rather than recreate it.

## Execution ordering

1. Validate session ownership, workspace trust, source candidate, size limits,
   and availability of the shell tool in the real session tool set.
2. Construct an engine-owned invocation and run the existing `runToolUse` path:
   schema/value validation, PreToolUse hooks, hook permission resolution,
   `canUseTool`/engine permission requests, and the tool call. Reuse post-tool
   and failure hooks too. No call straight to `BashTool.call()` or `exec()`.
3. Introduce PTY execution as a trusted backend choice inside the shell tool
   after those gates. Keep sandbox selection/wrapping at its normal pre-spawn
   position. No renderer or command field can disable the sandbox. If the PTY
   backend cannot honor required restrictions, refuse the run.
4. Hook-modified input goes through the pipeline's permission resolution.
   Persist and display the effective executed command separately when it differs
   from the source. Do not claim the original block was executed unchanged.
5. Scope the invocation's permission handler and cancellation to its run. The
   current `currentPermissionHandler` in `createQueryEngineAppSession` is tied
   to a model turn and cannot safely serve a concurrent terminal launch as-is.
   Add a run-owned route to the same engine-minted permission lifecycle; Stop
   resolves only this run's pending requests. Keep the real session context.

Record invocation provenance as `user-terminal`, not a fabricated model turn.
Any internal assistant-shaped adapter needed by `runToolUse` is engine-minted
execution context, not an assistant response added to model conversation history.

Keyboard input is explicit user control of the already-authorized interactive
process, including an interpreter that accepts further commands. This capability
must be documented in the security-baseline amendment before shipping. Input
is accepted only for a live run in the addressed session; it cannot name a new
program. No model tool for sending terminal keystrokes is introduced here.

## Terminal output threat model

Treat PTY output as untrusted bytes. Disable terminal-driven clipboard writes
(OSC 52), clickable OSC hyperlinks, external opening, window/title operations,
downloads, and all automatic input replies, including device/status queries.
Do not forward emulator `onData` wholesale: only explicit keyboard/paste input
can produce `terminal.input`. No links are activated automatically.

Support bounded cursor movement, colors, and alternate-screen rendering inside
the terminal rectangle. Cap escape-sequence parser buffers at 4 KiB and discard
oversized control sequences with an explicit diagnostic. Render no raw HTML;
terminal content cannot change surrounding application chrome. For agent text,
preserve printable output with terminal-output provenance; ANSI removal does
not make printable instructions trustworthy. Do not record raw keystrokes or
non-echoed password input as output.

## Required evidence

Reject forged/foreign IDs and extra executable fields. Prove deny blocks spawn,
hooks and sandboxing occur in order, and concurrent agent/terminal permissions
do not cross. Cover duplicate fences, both renderer paths, rewind, double-click,
lost acknowledgement, and restart between reservation and spawn. Feed hostile
OSC/CSI/DCS/HTML/plain-text injection fixtures through the actual emulator and
assert no clipboard, navigation, DOM, title, or PTY-input side effect.

Sources: [security minimum](SECURITY-MINIMUM.md),
[tool execution](../../../src/services/tools/toolExecution.ts),
[runtime permissions](../../../src/app-runtime/appRuntimeCanUseTool.ts),
[session adapter](../../../src/app-runtime/createQueryEngineAppSession.ts),
[Markdown renderer](../../../app/renderer/src/TranscriptView.tsx).
