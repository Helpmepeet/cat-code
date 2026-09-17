# Terminal Run: journal, limits, and recovery

Date: 2026-09-17
Status: Proposed implementation contract. Values below are initial engineering
defaults, not existing application settings. Not implemented.

Parent: [implementation plan](../../plans/2026-09-17-interactive-code-block-run.md).

## Authority and ownership

Use a versioned journal under application-owned session storage, keyed by the
engine session ID and opaque run ID. Never accept a storage path from the
renderer. Keep metadata, ordered output, model-delivery ranges, and start-request
tombstones. Files use restrictive permissions, no-follow opens, bounded readers,
and the repository's lock plus atomic-write conventions.

The live sidecar is the only run-journal writer. Its supervisor-issued generation
and process identity fence writes. Main can read journal metadata/pages without
waking the engine, but can become a recovery writer only after the supervisor
has confirmed that owning child exited. Socket loss alone is not proof of death.
Recovery acquires the same session lock and rereads current metadata before
sealing unfinished runs as `interrupted`. A replacement sidecar cannot own this
journal until recovery completes. On whole-app restart, recover a generation
only after verifying its original owner is gone; never signal a recycled PID.

PTY process cleanup must survive sidecar SIGKILL. The backend proof must provide
a parent-liveness guard for the PTY process group (a guardian holding a sidecar
liveness pipe is an acceptable implementation). EOF terminates the owned group;
it must not depend on JavaScript exit handlers. Main supervises normal shutdown
through tracked ownership. No process-name sweep or stale-PID-only cleanup.
This helper is not another engine session and does not own model credentials.

## Journal ordering

Reserve the run durably before spawn. Append length-bounded output records with
monotonic sequence numbers and a complete-record checksum. Keep separate raw
terminal-display bytes and normalized agent text, both charged to journal limits.
Never interpret process output as journal metadata.

Persist output batches before advertising their committed sequence to the UI or
model-delivery layer. Flush at most every 100 ms or 64 KiB, whichever comes first.
Normal exit flushes remaining output before a terminal-state record. A crash
recovers the last complete durable record and marks the run interrupted with
`output_may_be_incomplete`; do not promise recovery of unread kernel buffers.

Metadata transitions and delivery watermarks use atomic replacement under the
session lock. Main recovery writes use that same rule. The journal is the source
of truth; React state and Electron replay are caches.

## Explicit bounds

| Resource | Initial bound | Behavior at boundary |
| --- | --- | --- |
| Journal bytes per run, raw plus normalized | 64 MiB | Retain the allowed prefix, stop this run as `output_limit` |
| All run journals per session | 256 MiB | Prune eligible completed output first; otherwise stop the producing run |
| All terminal journals across sessions | 1 GiB | Serialized global quota reservation; prune eligible output, otherwise stop the producing run |
| PTY read/write staging per run | 256 KiB | Pause PTY reads; if backend cannot pause safely, stop as `output_limit` |
| Renderer terminal scrollback | 10,000 rows AND 2 MiB per mounted terminal | Evict oldest displayed rows; retain journal access through paginated output history |
| Terminal transport backlog | 1 MiB per session | Pause live sending; use journal cursors for catch-up, never accumulate more in memory |
| Unaccepted agent text | 4 MiB per session, across all runs | Stop the producing run as `output_limit`; retain its pending prefix for delivery |
| Completed output histories | 20 per block, 100 per session, at most 7 days after completion | Prune only eligible acknowledged output; show `output_expired` metadata |
| Concurrent runs | 4 per session | Refuse new starts with `terminal_capacity` |
| Catalog responses | 100 entries and 64 KiB | Paginate |
| Output page payload | 32 KiB, wire frame at most 96 KiB | Paginate; require valid run and offset |

Use serialized-byte accounting, including frame encoding overhead. Apply row
and byte scrollback bounds together. Credit disk quota before append; a process-
shared quota ledger needs a lock and atomic reservations, not an unlocked sum
of per-sidecar counters. Reconcile reservations after owner death before reuse.

Reserve an additional 8 KiB of control/terminal-state space per retained run so
reaching an output quota cannot suppress its exit or limit reason. Candidate and
dedupe metadata have separate bounded quotas in the candidate contract.

Completed journals with unaccepted agent output are pinned. If pinned histories
fill the retained-run count, refuse another start rather than evict output the
agent has not received. Passive pending output does not keep a sidecar alive;
its journal survives parking. Active interactive runs do prevent parking.

“All output” means all admitted textual output up to an explicit resource
boundary. No summaries, tail-only model sharing, or silent loss. Overflow records
the limiting resource and last retained sequence, stops execution, and is shown
both to the user and the agent. It never masquerades as successful completion.
UI scrollback eviction alone is not command-output loss and does not stop a run.

## Reattachment and retention

On renderer reload, request the catalog and output pages from the journal.
Subscribe to committed sequence changes and dedupe by `(runId, sequence)`.
Fetch missing ranges; never assume the main replay ring contains them. Fetch a
bounded terminal checkpoint plus following deltas to reconstruct cursor/alternate
screen state; cap a checkpoint at 2 MiB, count it in the per-run disk budget, and
replace its previous copy atomically. Paginated text history remains available.

Classify only a small, bounded `terminal.catalog-invalidated` notification as
sticky in `FRAME_RETENTION`. It contains a generation/revision, never output.
Classify request replies and live output/state deltas as ring traffic; eviction
is expected, and the journal supplies gaps. No ever-growing output snapshot is
sticky. Host recovery invalidates the catalog when it seals crashed runs.

Expired output leaves metadata plus the start-request tombstone. Pruning is a
journal-owner operation under the same locks and quota accounting. Closing a
session stops live runs but does not delete unconsumed output or dedupe records.
Intentional session-history deletion removes its namespace under normal deletion
policy. Nothing in recovery re-executes a command.

## Required evidence

Run a high-output fixture past each bound with small injected test limits.
Prove bounded memory/disk/backlog, visible limit state, and retained-prefix
delivery. Test replay-ring eviction, paged reconnect during output, a torn journal
record, lost connection with a still-live sidecar, SIGKILL of the sidecar with
live children, whole-app recovery, generation fencing, simultaneous quota
reservations, pinned-history exhaustion, and output expiry with retry tombstones.

Sources: [replay buffer](../../../app/main/replayBuffer.ts),
[disk output limits](../../../src/utils/task/diskOutput.ts),
[shell lifecycle](../../../src/utils/ShellCommand.ts),
[supervisor](../../../app/supervisor/supervisor.ts),
[registry locking](../../../app/host/registry.ts).
