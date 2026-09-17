# Interactive Run for command blocks

Date: 2026-09-17
Status: Revised after source-based review. Proposed contracts are concrete;
implementation and runtime verification have not started.

## User-visible behavior

Reuse the existing assistant code block and add a Run icon beside Copy.
Run starts its command in the conversation's project and opens an interactive
terminal immediately below the block. The user can type answers, use arrow
keys, and press Enter through multiple prompts. All admitted terminal output
is automatically shared with the owning agent, including output produced while
a command waits for input. There is no manual sharing step.

Run becomes Stop while active. Ctrl+C interrupts the foreground program; Stop
terminates this run's owned processes. Completion leaves the exit result and
retained output beside Run again. Tab changes and scrolling do not end a run.
The terminal lasts for the selected command, rather than leaving an unrestricted
persistent shell after that command exits.

“All output” does not mean unlimited memory, disk, or model context. There is
no summary/tail-only sharing policy. Explicit resource limits stop a runaway
command with an `output_limit` result and identify the last retained output.
Nothing is silently omitted and presented as a complete successful run.

## Contracts to implement

These three proposed decision records replace the unresolved assumptions in
the first plan. They describe the intended implementation, not existing behavior
or a silently approved change to the current security baseline.

| Contract | Concrete choice |
| --- | --- |
| [Candidates and authorization](../migration/decisions/TERMINAL-RUN-CANDIDATES.md) | Renderer selects an opaque engine-minted candidate; full Bash validation, hooks, permissions, and sandbox path applies |
| [Journal, bounds, and recovery](../migration/decisions/TERMINAL-RUN-JOURNAL.md) | Sidecar-owned durable run journal; host recovery after confirmed owner exit; paginated reattachment; separate resource caps |
| [Passive agent delivery](../migration/decisions/TERMINAL-AGENT-DELIVERY.md) | New non-waking attachment source; ordered ranges; watermark advances only after durable canonical-input acceptance |

Keep the existing Unix-socket transport, one engine per session, raw session
events, two session identities, and application lifetime rules. Document the
bounded interactive-input capability in the security baseline before shipping.
Dependency additions still require the repository's dependency approval.

## Implementation sequence

### 1. Isolated PTY and packaging proof

Prove the proposed terminal backend under the real Bun sidecar runtime, with an
isolated interactive fixture. Cover launch, typed answers, arrows, resize,
Ctrl+C, Stop, actual exit status, and process-group cleanup after sidecar SIGKILL.
Verify loading in development and the packaged app. A parent-liveness mechanism
must clean up children even when JavaScript exit handlers never run.

This proof can proceed independently. Production bridge/UI wiring must follow
the three contracts rather than turn the experiment into a raw `exec` channel.
Select the PTY backend and terminal emulator based on this evidence, then obtain
any required dependency approval before adding them.

### 2. Candidate registry and authorized launch

Extract candidates only from finalized, persisted assistant messages. Persist
the exact source and canonical message/content-block/fence identity. Return
opaque candidate IDs to the renderer. Both ordinary and windowed code blocks
must carry the same stable source identity; matching by command text is invalid.

The start payload contains only `candidateId` and `startRequestId` inside the
session envelope. Persist its run reservation before effects. Retries reuse the
request ID; Run again gets a new one. Keep dedupe tombstones after output expiry;
an uncertain pre-spawn record becomes interrupted and is never auto-reexecuted.

Use `runToolUse` and the real session tool context. Add the PTY backend after
the existing validation/hook/permission steps and before the normal sandboxed
spawn. Give terminal runs their own permission-handler and cancellation scope
so concurrent agent turns cannot overwrite it. Preserve user-terminal provenance.

### 3. Durable runs, bounded output, and recovery

Implement the journal and quota accounting before routing live output. It owns
run metadata, sequences, output, receipts, and retry identity. Main's 16 MiB
replay ring is not a terminal history store.

Initial bounds include 64 MiB of journal per run, 256 MiB per session, 1 GiB
across terminal journals, 2 MiB/10,000-row UI scrollback, 1 MiB transport backlog,
and 4 MiB of unaccepted model text per session. The journal contract also fixes
completed-run retention, paging, active-run limits, and overflow behavior.
These are proposed defaults, not claims about current settings.

Use a single live writer with generation fencing. Main seals unfinished runs
after confirmed sidecar death, under the same session lock. Renderer reload
requests metadata and output pages/checkpoints from the journal. Active runs
prevent parking; passive output survives parking on disk. Close stops owned
processes without deleting unconsumed output. Restore never reruns commands.

### 4. Automatic, non-waking agent context

Introduce the passive `terminal-output` source separately from prompt and task-
notification queues. Those existing queues can start new turns at the boundary.
Output and exit must not wake an idle agent or create an AI turn per chunk.

Sample ordered pending ranges at an eligible existing model-input boundary or
the next user submission. Persist a typed untrusted-output attachment before
provider dispatch and only then advance the accepted watermark. Reconcile
transcript receipts on restart before trusting a stale journal cursor. Test
both provider input paths, including crash windows and compaction.

Use bounded batches without summarizing or dropping the pending suffix. If no
model context space is available, keep output pending; its explicit pending
quota prevents unbounded accumulation. This cannot change an in-flight request.

### 5. Existing code block plus an embedded terminal

Add optional Run to `CodeBlock`, enabled only where the engine has supplied a
valid candidate. Preserve Copy, source text, and existing styling. Explicit
shell fences are eligible; arbitrary prose and settings previews are not.

Mount the interactive terminal immediately below the block and focus it on the
user's Run click. State belongs outside windowed React components. Input is
accepted only from explicit keyboard/paste actions in the focused terminal.
Disable emulator-generated replies and output-triggered clipboard, navigation,
title, hyperlink, or DOM actions. Terminal escape parsing is bounded too.

### 6. Protocol integration and verification

Add fixed, session-scoped start/input/resize/stop and journal-read actions with
closed schemas at the receiving boundary. Main's read-only history path can
serve a dead session without starting an engine. Mutation always routes to the
owning live sidecar. Neither path accepts arbitrary filesystem paths.

For every new frame and type:

- Review wire compatibility; keep additive changes compatible and bump
  `PROTOCOL_VERSION` for any breaking shape or behavior.
- Update `FRAME_RETENTION` exhaustively. Only bounded catalog invalidation is
  sticky; output and request replies are evictable, with journal gap recovery.
- Update projector/reducer handling and SDK/display fixtures exhaustively.
  Document tolerant no-ops for control-only frames rather than ignoring them
  accidentally. Preserve existing raw `AppSessionEvent` forwarding.
- Regenerate affected engine/SDK snapshots from their owning sources and
  generators. Never hand-edit `app/shared/engine-types.snapshot.d.ts`,
  `app/shared/sdk-types.snapshot.d.ts`, or generated SDK core types.
- Register any persisted-format migration through the existing engine migration
  owner; the journal itself has an explicit schema version.

## Acceptance evidence

| Area | Required checks |
| --- | --- |
| Run identity | Ordinary/windowed/identical adjacent fences, source changes, foreign candidate, double-click, lost ack, Run again, restart before/after spawn |
| Authorization | Real validation/hook/permission/sandbox ordering, denied spawn, hook-modified command, concurrent permission ownership, rejected extra fields |
| Interactive behavior | Multiple prompts, arrow selection, multiline/heredoc command, resize, Ctrl+C, Stop, exit code |
| Output hardening | OSC clipboard/link/title, CSI/DCS queries, oversized escapes, HTML and printable prompt injection; no external side effects or automatic PTY writes |
| Bounds | Flood output with injected small quotas; bounded memory/disk/backlog; explicit limit reason; admitted prefix remains available |
| Reattachment | Replay eviction, paged catch-up during output, checkpoint restore, torn journal tail, generation fencing, expired output with retained dedupe |
| Agent delivery | Idle never wakes; active boundary consumes; turn-end leaves pending; durable acceptance/retry crash windows; both provider inputs and compaction |
| Lifetime | Scroll/tab/reload keeps the same run; active run prevents parking; close and sidecar SIGKILL clean up owned children; no automatic rerun |

Use isolated test state and fake provider transports; do not consume live account
quota. Run affected engine tests and `bun run build:dev:full`, desktop tests,
both desktop typechecks, and the renderer build. Run hardening and Cat Code Dev
GUI checks when authorized for those runs. Record packaged PTY evidence too.
Documentation changes require whitespace, link, and map-lint checks.

## Source owners

- UI: `app/renderer/src/{TranscriptView,SessionPane}.tsx` and
  `app/renderer/src/markdownRenderPlan.ts`, plus terminal component/state files.
- Bridge: `app/shared/protocol.ts`, existing IPC declarations,
  `app/preload/preload.ts`, and `app/main/main.ts`.
- Runtime: `app/sidecar/sidecarServer.ts`, a terminal domain, and a real run-owned
  execution adapter under `src/app-runtime/`.
- Execution: `src/services/tools/toolExecution.ts`, the Bash tool, and shell/
  process helpers. Reuse the real machinery, not a parallel permission model.
- Context: `src/QueryEngine.ts`, `src/query.ts`, attachment/provenance types,
  durable transcript acceptance, and provider normalization.
- Recovery: `app/main/replayBuffer.ts`, host/supervisor lifecycle, and a shared
  Electron-free versioned journal with single-writer/generation rules.

## Review disposition and effort

All seven findings are addressed in the proposed contracts: candidate-only
launch, explicit resource limits, a non-waking source, authoritative recovery,
stable identities, terminal-output hardening, and protocol/generation coverage.
Two earlier assumptions were incorrect: existing queued input can wake the
agent, and replay-buffer retention cannot guarantee terminal history recovery.

The UI remains small. Reliable interactive execution is the larger part.
The previous 1–2 week estimate is provisional until the isolated PTY/packaging
proof; it is not a promise that the reviewed runtime contracts are already built.

Evidence: the initial investigation ran 63 existing tests successfully. This
revision rechecked the cited source paths and updates documents only. Those
63 tests were not rerun for this revision and do not prove the new contracts.
