# Live streaming batching implementation

Date: 2026-09-12. Status: **core implemented and independently reviewed; measurements complete; retain immediate delivery because neither fixed delay met the CPU target**.

Plan: [Live streaming batching implementation plan](../migration/specs/2026-09-12-live-streaming-batching-plan.md).

Review: [Implementation and measurement preparation review](2026-09-12-live-streaming-batching-implementation-review.md). Measurement fixtures and commands: [Live streaming measurements](2026-09-12-live-streaming-measurements/README.md).

## Outcome

The subsequent authorized pilot and 72-sample Electron matrix are complete. Neither 8 ms nor 16 ms reached the required 20% CPU reduction in the paced four-session workload, so neither qualifies for global activation. Production remains at `delayMs: 0`. See the [measured results and independent verdict](2026-09-12-live-streaming-batching-results.md).

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

The focused Electron measurements establish lower CPU in several synthetic busy workloads, with the limits documented in the results. They do not establish the plan's full acceptance, smooth visual streaming, whole-application CPU savings or battery-life improvement. Production stays immediate because the fixed CPU bar was not met.

1. **Measurement complete:** 12 valid pilot samples plus a separate 72/72 valid matrix; independent review confirmed the data and the decision to retain immediate delivery. No fixed-delay candidate is selected for activation.
2. Run `bun run --cwd app test:hardening` after per-run authorization and isolation preparation. It launches the actual production main. The existing runner isolates `CLAUDE_CONFIG_DIR` but still inherits the parent environment and Electron profile defaults; isolate those before describing this as a profile-independent run. It was not run in this implementation session.
3. Before any future activation, run the fresh GUI acceptance from the plan with isolated temporary config/workspaces: simultaneous streams, typing and scrolling, permission presentation, stop/completion, tab switching, reload, session close and macOS close/reactivation. The synthetic Electron benchmark did not provide this full acceptance; no provider call occurred.

## Scope flags

- ✅ **Measured selection complete:** retain immediate delivery; the fixed-delay candidates missed the paced four-session CPU target.
- ⬜ **Hardening and GUI acceptance pending:** both require an Electron launch authorized for that run.
- No public protocol/version, security boundary, replay cap, provider behavior, credential or live session data changed.
