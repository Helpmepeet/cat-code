# Desktop task-notification delivery — cold review

**Date:** 2026-08-02  
**Verdict:** **YELLOW — accept the live-process fix with two named follow-ups**

## Contract

The operator-reported defect was that completed local-agent reports were
persisted as queue enqueues but never delivered into an idle desktop parent
turn. The accepted patch contract was:

1. put the automatic wake-up at the desktop sidecar/controller scheduling
   boundary, not inside the shared web runtime;
2. serialize notification turns behind accepted human turns and avoid
   synchronous queue-listener reentrancy;
3. preserve task-notification provenance into the parent transcript and SDK
   event stream;
4. keep terminal task results recoverable while delivery is queued/in flight;
5. prevent parking or untrusted autonomous turns; and
6. add focused regression coverage without changing the renderer/preload/wire
   protocol or running the GUI.

No migration backlog row exists for this ad-hoc cross-cutting repair; the
operator prompt and the pre-implementation diagnosis are the written contract.

## Conformance

| Contract item | Result | Evidence |
|---|---|---|
| Sidecar-owned idle wake-up | Implemented | `app/sidecar/sidecarServer.ts:998-1089` subscribes to the shared queue, schedules a microtask, re-reads, dequeues one parent task notification, and starts a sidecar-owned turn. |
| No hidden shared-web scheduler | Implemented | `src/app-runtime/createRuntimeBackedWebAppSession.ts` remains subscription-free; `SidecarServer` alone owns the queue pump. |
| Human precedence / serialization / reentrancy | Implemented | `sidecarServer.ts:1012-1038,1095-1164,1248-1288`; `activeTurn`, scheduled drain, safe finalizer retry, closed guard, and FIFO tests cover the intended ordering. |
| Structured provenance | Implemented | `src/app-runtime/AppSessionController.ts:21-39,165-169`; `createQueryEngineSessionController.ts:13-17,32-40`; `createQueryEngineAppSession.ts:39-48`; `src/QueryEngine.ts:476-486`; sidecar immediate event uses the existing SDK origin projector. |
| Queue/in-flight task retention | Implemented for the live process | `src/utils/messageQueueManager.ts:114-143` and `src/utils/task/framework.ts:126-130,171-177,236-240` cover eager and lazy eviction paths. |
| Park/trust gates | Implemented | `sidecarServer.ts:1024-1038,1363-1371,1576-1589`; false and null trust are both test-pinned. |
| Renderer/preload/protocol scope | Conformant | No patch-owned renderer, preload, inbound schema, protocol-version, or frame-limit change. Existing raw event forwarding and `secretGuard` path remain in use. |
| Focused regression coverage | Partial at the live-process boundary | Sidecar scheduling, origin, rollback, retention, trust, parking, and close races are covered; the complete production sidecar→runtime→QueryEngine chain is not exercised in one test. |

## Findings

### F1 — Medium — the “durably accepted” acknowledgement precedes the actual local transcript write

`QueryEngine` calls `onInputPersisted` after awaiting `recordTranscript`
(`src/QueryEngine.ts:515-531`), but the production session store enqueues local
message appends with `void this.enqueueWrite(...)`
(`src/utils/sessionStorage.ts:1696`) behind a 100 ms drain timer
(`src/utils/sessionStorage.ts:1000,1051-1064`). The awaited
`recordTranscript` call therefore proves that the write was staged, not that it
reached the file. The focused test replaces `recordTranscript` with an immediate
in-memory capture (`src/QueryEngine.deferred.test.ts:142-191`), so it cannot
detect this distinction.

Failure scenario: after the callback releases the reservation and the task
becomes evictable, a process exit or local append failure before the queued write
drains can leave neither the queue entry nor the notification in the restored
parent transcript. This is inside the patch's claimed “durable transcript
persistence” boundary even though historical queue replay across a later crash
was explicitly out of scope.

**Disposition / owner:** current task-notification follow-up. Before retaining
the word “durable”, await `flushCurrentTranscriptDurably` (ideally checking the
accepted notification UUID) before invoking the acknowledgement. Alternatively,
rename the callback/contract to staged or accepted input and explicitly record
the remaining crash window.

### F2 — Low — regression tests split the load-bearing production join across fakes

The sidecar FIFO test manually calls `options.onInputPersisted` from a fake
adapter (`app/sidecar/sidecarServer.test.ts:941-1006`), while the QueryEngine
test invokes `QueryEngine.submitMessage` directly
(`src/QueryEngine.deferred.test.ts:142-191`). No single test exercises
`SidecarServer` → `AppSessionController` →
`createQueryEngineSessionController` → `createQueryEngineAppSession` →
`QueryEngine` for an idle queue enqueue. Deleting the forwarding line at
`src/app-runtime/createQueryEngineAppSession.ts:47` would leave the focused
sidecar and QueryEngine tests green while production requeues/parks the
notification as unacknowledged.

Source inspection and typechecks show the join is currently wired correctly,
so this is a confidence gap rather than a present production defect.

**Disposition / owner:** current task-notification test follow-up. Add one
in-process production-composition test with an injected transcript writer, or a
real UDS probe on a host that permits Bun Unix sockets.

## Correctness and security review

- The queue listener never submits synchronously; the microtask and sidecar
  finalizer avoid the controller abort-state and old-finalizer clobber races.
- The pump re-reads the live queue before dequeue, so a notification consumed by
  the existing mid-turn QueryEngine drain is not replayed by stale snapshot.
- Accepted human turns keep `activeTurn`; pending notifications wait and drain
  FIFO afterward.
- Pre-ack failure requeues once and prevents a hot retry loop; closed servers
  cannot consume a later queue entry.
- The task-retention predicate covers queued and reserved task ids in all three
  eviction points.
- Workspace trust remains fail-closed for `false` and `null`; no renderer-authored
  provenance or new inbound vocabulary was introduced.
- The existing T4/T5a/T6/T6b/T7 validation, directional frame limits, raw event
  forwarding, and outbound `secretGuard` remain unchanged. Internal user events
  still pass through `broadcastEvent` → `send` (`sidecarServer.ts:2317-2335,
  2953-2999`).
- There is no renderer/prototype surface change, so fidelity and GUI acceptance
  are N/A.

## Verification rerun

```text
VERIFICATION
- bun test src/utils/task/framework.test.ts src/app-runtime/createQueryEngineSessionController.test.ts src/QueryEngine.deferred.test.ts
  -> 5 pass / 0 fail
- bun test app/sidecar/sidecarServer.test.ts --test-name-pattern 'queued parent task|completion without durable|closing a sidecar'
  -> 4 pass / 0 fail (filtered)
- bun test app/sidecar/sidecarServer.test.ts --test-name-pattern 'queued task notifications fail closed'
  -> 1 pass / 0 fail (filtered)
- bun run --cwd app typecheck
  -> pass
- bun run --cwd app typecheck:sidecar
  -> scoped pass; 5,560 upstream diagnostics ignored, 0 owned diagnostics
- bun run build:dev:full
  -> pass; maps lint passed with 8 existing recommendations; cli-dev version printed
- git diff --check
  -> clean
Stale-reference sweep: no rename/removal; all new option and callback usages were enumerated in source.
Not green / unrelated current-tree evidence:
- Full sidecarServer.test.ts: notification tests pass; 3 account-snapshot assertions fail in untouched account paths.
- bun test app/: real process/UDS probes fail under the review sandbox with EPERM/failed Unix-socket binds and process-identity limitations; the run was stopped after repeated 45 s probe timeouts.
Not run: bun run --cwd app test:hardening (launches Electron; GUI was prohibited); renderer build (no patch-owned renderer input).
```

## Verdict

The original live desktop failure is fixed by source and focused-test evidence:
an idle completion now starts a serialized parent turn, and the stranded queue /
30-second task-eviction sequence is closed. Accept the implementation as
**YELLOW**, with F1 required before claiming crash-resistant durable handoff and
F2 required to raise the process-wiring proof to GREEN.
