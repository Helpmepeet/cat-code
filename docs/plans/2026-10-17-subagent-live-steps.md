# Live subagent steps for every run

Status: built 2026-10-17, recorded in
`docs/migration/decisions/ORCHESTRATOR-IN-SESSION.md` §12. Revision 2
incorporates a design review. Every point it raised was checked against source
before it was accepted or rejected.

Built differently from this plan in two places. Publication happens inside
`runAgent` at the point each step is recorded, opted into by the Agent and
ResumeAgent tools, instead of three call sites in the tool loops. That makes the
mid-run background handoff a non-issue, because the step is published before
either loop reads it. Sidechains written before run records existed are not
marked as unattributable; they keep every step under their one recorded card,
as before.

## Goal

Every eligible subagent run publishes its supported, completed display steps
(reasoning, prose, tool calls and results) live, under the run that owns them.
Live delivery and restore produce the same frames. Publishing never changes how
the worker executes, and it never changes the state of an unrelated parent turn.
Missing history is never shown as complete.

Eligible means an `Agent` or `ResumeAgent` tool use in this session. Subagents
cannot spawn subagents in this build (`ALL_AGENT_DISALLOWED_TOOLS` in
`src/constants/tools.ts`, with `USER_TYPE` built as `external`), so there is no
grandchild case.

## What is true today

| Path | What reaches the renderer live | Source |
|---|---|---|
| Foreground run | Tool calls and results only | the sync loop in `src/tools/AgentTool/AgentTool.tsx` skips every normalized block that is not `tool_use` or `tool_result` before `onProgress` |
| Background run | Nothing | `runAsyncAgentLifecycle` (`src/tools/AgentTool/agentToolUtils.ts`) only updates AppState and `emitTaskProgress`, which the desktop never drains |
| Moved to background mid-run | Nothing after the move | the backgrounded continuation loop in `AgentTool.tsx` |
| Restored session | Everything, including reasoning | `app/sidecar/subagentHistory.ts` |

The desktop cache is consistent with this: live nested frames held 0 reasoning
blocks, while replayed nested frames held 966. That is supporting evidence, not
a controlled measurement; the source filter is the direct proof.

## Contracts to settle before the callback

### 1. One frame form for live and restore

The two paths disagree today. Live frames go through `normalizeMessages`, which
splits a multi-block message into one frame per block with derived UUIDs.
Restore goes through `projectResumedHistory` → `toSDKMessages`, which keeps the
stored message whole under its stored UUID. The renderer dedupes on UUID, so
the same step arriving both ways is not recognized as the same step.

Decision: the canonical form is the restore form, one frame per stored message
under its stored UUID, stamped with `parent_tool_use_id` and `agent_name`. Move
the per-message conversion that `projectBranchFrames` does into one function in
`src/`, and have both the live publisher and `subagentHistory.ts` call it. Check
it against the metadata that the live path carries today (`tool_result_status`,
`origin`, reasoning display metadata) and keep what the renderer reads.
No saved session is rewritten.

### 2. Each step belongs to one run

One agent can run several times (the original run and each resume). Its
sidechain file holds all of them. Its metadata file holds one
`parentToolUseId`, and `runAgent` overwrites it on every run
(`writeAgentMetadata`). Restore stamps the whole sidechain with that one id, so
after a resume and a restore, the original run's steps move under the latest
ResumeAgent card. This is a restore bug today, and the panel would expose it.

Decision: record where each run starts. First check whether the per-run
`subagent-spawned` record plus the sidechain's `parentUuid` chain already mark
the boundary (resume seeds its chain from the previous tail). If they do not,
add the run's first message UUID to that record. Restore splits the sidechain at
those boundaries. Sidechains written before this change, or with a missing
boundary, keep all steps under the latest run and are marked as not
attributable. The live publisher takes its owner from the run's own tool use id
at launch and never looks it up later.

### 3. Background frames must not count as parent-turn activity

These consumers see every `message` event today and do not check
`parent_tool_use_id`:

- `observeTurnEvent` in `app/sidecar/sidecarServer.ts` resets the stall
  clock on any message. A worker launched in an earlier turn could keep a stuck
  later turn from ever being reported as stalled.
- `attachThreadGoalScheduler` counts `tool_use` and `tool_result` blocks into the
  current goal turn.
- The sidecar subscriber calls `workspaceObserver.conversationContinued()` on
  any `user` frame, which includes a worker's tool results.

`runControls.observeSessionEvent` already skips nested frames.
`noteLidWorkProgress` already routes nested frames to their task, which is the
intended behavior.

Decision: a nested frame counts as parent-turn activity only when its owner is a
foreground run of the current turn. Ownership comes from the run, not from the
arrival time. A foreground subagent's steps still keep its parent turn alive.

### 4. Worker errors and interruptions stay with the worker

Two renderer branches lose the parent id. A user frame with an interruption
origin becomes a top-level `turn-stopped` row, and an assistant frame with
`error` becomes a top-level provider notice. Forwarded from a worker, either
would look like the parent stopped or failed.

Decision: list the frame variants the publisher sends. Either give these two a
nested projection under the worker, or do not publish them and let the worker's
terminal state show the failure. Internal sentinels and control messages are
never published.

## The fix

1. **Callback.** Add an optional publisher to `ToolUseContext`, typed to accept
   only nested `assistant`/`user` display frames, threaded through
   `QueryEngine` like `setSDKStatus`. The desktop wires it in
   `src/app-runtime/createRuntimeBackedAppSession.ts` to
   `AppSessionController.emitMessage`. The terminal and `print.ts` leave it unset
   and behave exactly as today.
2. **One publisher per step.** When the callback is set, it publishes every
   eligible step for every run type, tool calls included, and the foreground
   loop stops sending nested display frames through `onProgress`. Task progress,
   response-length counting, permission handling and `bash_progress` are
   unchanged. Three thin call sites share the canonical conversion:
   `runAsyncAgentLifecycle` (covers background and resume), the backgrounded
   continuation loop, and the foreground loop. `runAgent` is not the call site,
   because skills, slash commands, teammates and MagicDocs also use it.
3. **Mid-run handoff.** The pending read handed from the foreground loop to the
   continuation loop is published once, in order.
4. **Failure isolation.** `AppSessionController.emit` calls listeners directly,
   so a throwing listener would reach the worker. The publisher catches its own
   errors, logs a bounded diagnostic, and never changes the worker's result.
5. **Renderer.** `canOpenSubagentPanel` accepts a correlated `background` or
   `resumed` run even before its first step, so the panel distinguishes "no
   steps yet" from "steps unavailable". The guard against an old run's reveal
   target stays. Background Agent cards expand to show steps like foreground
   cards, reading the same projected branch. Comments that call a background
   launch childless get corrected.

No new protocol kind, inbound frame or sidecar request. The wire carries the
existing `message` event with existing fields. That stays a preference: if
contract 2 needs a persisted field, that is a transcript record change, not a
wire change. This changes engine code, which the original brief ruled out.

## Delivery limits

`MAX_OUTBOUND_FRAME_BYTES` bounds one frame, not memory, and the sidecar
ignores `socket.write` backpressure for every frame today. This change adds
volume but not a new kind of risk. The plan does not redesign the transport. It
measures queued bytes with several concurrent workers and a slowed consumer, and
relies on restore from disk for recovery. A worker can succeed while its saved
history is incomplete, because `runAgent` logs and continues on a failed
sidechain write. Restore reports what it could read through the existing
`history.availability` metadata and never claims completeness it does not have.

## Out of scope

- Token-by-token reasoning for subagents. A long reasoning block appears when
  its message completes.
- A distinct dock state for a subagent waiting on a permission prompt.
- Transport backpressure.

## Tests

Use the real converters and the real context construction, not hand-built
frames.

- Multi-block message (reasoning, prose, tool call) live, then replayed over it:
  same ids, no duplicate rows, same order.
- Original run plus two resumes, then restore: every step stays under its own
  card. A legacy sidechain without boundaries stays readable and is marked.
- Foreground run moved to background with a read pending: the boundary message
  appears once, in order.
- A worker from turn 1 keeps publishing while turn 2 stalls: the stall is still
  reported, goal tool counts for turn 2 are unchanged, and workspace observation
  does not fire. Use fake clocks.
- Nested frames while the parent streams: parent streaming, completion and the
  composer stay correct.
- Worker error and worker interruption: only the worker shows failed or stopped.
- A throwing listener: the worker's result is unchanged.
- Background and resumed rows open before their first step and follow later
  steps. Foreground shows reasoning arriving live.
- Callback unset: terminal output unchanged. Existing saved sessions replay
  without loss, duplication or reassignment.
- Checks from `CLAUDE.md` §3: `bun run build:dev:full`, the touched engine
  tests, `bun test app/`, both app typechecks and the renderer build. A live Cat
  Code Dev check needs your authorization.

## Build order

1. Canonical conversion and run ownership, with restore using them.
2. Publisher callback, call sites, handoff and failure isolation.
3. Consumer fixes: stall clock, goal scheduler, workspace observer, nested
   error and interruption rows.
4. Renderer opening rules and Agent card expansion, then docs:
   `ORCHESTRATOR-IN-SESSION.md` §11, the panel and dock rows in
   `docs/maps/web-app-runtime.md`, and the DESIGN.md line that says only
   foreground workers show live activity.
