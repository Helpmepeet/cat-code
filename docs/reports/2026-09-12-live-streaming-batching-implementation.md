# Live streaming batching implementation

Date: 2026-09-12. Status: **implementation and headless correctness complete; production policy remains immediate pending authorized Electron measurement**.

Plan: [Live streaming batching implementation plan](../migration/specs/2026-09-12-live-streaming-batching-plan.md).

## Outcome

Electron main now has a production-wired, bounded delivery coordinator for ordinary live text and thinking deltas. It preserves the original frames in one cross-session FIFO and supports immediate, 8 ms and 16 ms policies. Production explicitly selects `delayMs: 0`: the candidate policy is not enabled until real Electron CPU and renderer-commit latency evidence meets the plan's fixed bars.

The scheduler uses a monotonic clock, an oldest-frame deadline, 32-frame and 256 KiB UTF-8 JSON accounting limits, and exact array punctuation. A barrier flushes prior deltas before sending permissions, questions, tool/control events, completion, replay/coalescer arrays, host events or unknown shapes. An otherwise legal oversized delta stays immediate. Aggregate counters expose send, queue high-water and wait measurements without retaining content or an unbounded sample list.

The production composition owns attachment and lifecycle ordering. Navigation and a new renderer-ready document identity invalidate old pending delivery copies; same-document StrictMode readiness preserves them. Session close/restart and host removal flush the FIFO prefix before transcript persistence and replay eviction. BrowserWindow close disposes delivery/recovery timers but retains the replay gate until `window-all-closed` finishes shutdown persistence. Final reset occurs afterward.

Synchronous IPC failure enters the existing bounded renderer recovery policy. One in-flight recovery attempt deduplicates a later ambiguous `render-process-gone`; an explicit load failure or a 15-second watchdog advances the bounded attempt count, and first readiness from a new document re-arms recovery before its replay send. Reentrant delivery is serialized so nested calls cannot reverse FIFO order or exceed queue caps.

No renderer, preload, shared protocol, provider or engine shape changed. Frame payloads, trace identities, acknowledgement semantics, replay budgets and permission behavior remain unchanged. `main.ipc.queued` and `main.ipc.sent` are still stamped at the actual send boundary.

## Changed paths and checkpoints

- `app/main/liveFrameBatcher.ts`: scheduler, eligibility and accounting, attachment composition, readiness identity and bounded recovery seam.
- `app/main/liveFrameBatcher.test.ts`: virtual-time, caps, barriers, reentrancy, recovery, attachment, eviction and shutdown ordering.
- `app/main/main.ts`: production delivery, host-event, attachment, recovery and teardown wiring; immediate policy selection.
- `app/main/mainSourceGuards.test.ts`: forwarding choke-point anchor updated for the production composition.

Owned checkpoints: `53355a2a`, `6b564156`, `dd6bb22f`, `d1568ad5`. No push was performed.

## Headless evidence

- Focused scheduler/attachment/main-source/reload suites: **70 pass, 0 fail**, 232 assertions across four files.
- `bun run --cwd app typecheck`: passed, including the Fast Refresh boundary lint.
- `bun run --cwd app typecheck:sidecar`: passed with **5,559 upstream diagnostics ignored** and zero owned diagnostics.
- Escalated credential-free non-probe desktop suite, `bun test app/ --path-ignore-patterns='**/*.probe.test.ts'`: **4,782 pass, 0 fail**, 27,763 assertions across 278 files. Escalation allowed fixture-owned Unix sockets and process cleanup; it did not launch Electron or call a provider.
- Deterministic 250 ms headless functional smoke from the separately owned measurement fixture: all **24 workload/policy combinations** preserved source order and immutability, final transcript/raw-log/permission/connection state, and timer cleanup. This is component correctness, not CPU or React-commit evidence.
- `git diff --check` on owned files: passed; the recurring fsmonitor warning did not produce a diff error.

The required unfiltered `bun test app/` was attempted with an isolated config directory and credential environment variables blank. It was interrupted after environment-gated failures made a clean result impossible: live sidecar probes required Anthropic credentials; Unix-socket probes failed `listen` with `EPERM`; two registry cases could not signal fixture processes in the sandbox; and the blank credential/model environment changed two run-control expectations. A second sandboxed non-probe attempt was interrupted when supervisor socket fixtures hit the same `EPERM`. The successful escalated run above includes the registry and supervisor suites and excludes only `*.probe.test.ts`. Therefore no unfiltered full-suite pass is claimed.

## Open evidence and exact remaining runs

The implementation does **not** claim lower Electron main+renderer CPU, acceptable actual React commit latency, smooth visual streaming or battery-life improvement. Production stays immediate for that reason.

1. Run the prepared isolated Electron benchmark matrix after per-run authorization. Compare immediate, 8 ms and 16 ms for 1/4/8 sessions and record main+renderer CPU, send/dispatch/commit counts, queue age/bytes, clock uncertainty and actual arrival-to-commit p95/p99. Enable a nonzero production delay only if the fixed CPU and latency bars pass.
2. Run `bun run --cwd app test:hardening` after per-run authorization. It launches Electron, so it was prepared but not run in this implementation session.
3. Run the fresh GUI acceptance from the plan with isolated temporary config/workspaces: simultaneous streams, typing and scrolling, permission presentation, stop/completion, tab switching, reload, session close and macOS close/reactivation. No provider or GUI run was performed here.

## Scope flags

- ⬜ **Measured selection deferred:** immediate delivery remains the production policy until the authorized Electron evidence selects 8 ms, 16 ms, or retains immediate.
- ⬜ **Hardening and GUI acceptance pending:** both require an Electron launch authorized for that run.
- No public protocol/version, security boundary, replay cap, provider behavior, credential or live session data changed.
