# Private Desktop Operational Logging Cold Review

**Date:** 2026-08-06
**Commit:** `818a3911756a091b562149965ee4aecb6d112b38`
**Parent:** `7b0164b5fdf02026b22026b9647d93de9eabe474`
**Verdict:** **RED — rework before acceptance**

The commit establishes useful foundations: private `0700`/`0600` JSONL files,
a dedicated sidecar descriptor, an additive delivery envelope, fixed preload
methods, Electron failure hooks, renderer fallback UI, and local export actions.
It does not yet provide trustworthy end-to-end delivery evidence. Several paths
can record a stage that was only inferred, hide a missing earlier event, or
acknowledge state/UI application without proving it. The support-export privacy
pass is also weaker than its contract.

## Contract and conformance

The contract is `docs/reports/2026-08-06-desktop-application-logging-audit.md`
from the source workspace. That report recommends Phase 1 as the first tranche,
then requires independent acceptance for Phases 2-6. This single commit exceeds
that recommended scope by attempting all of those phases plus engine debug-log
hardening.

| Contract lane | Result | Notes |
|---|---|---|
| Phase 1: private structured sink | Partial | Private files, rotation, retention, and a closed event vocabulary exist. Several required failure/limit cases are untested. Legacy host/supervisor strings are classified rather than fully converted. |
| Phase 2: sidecar descriptor and fatal coverage | Partial | FD 3 and fatal handlers exist. Most source diagnostics remain legacy classifications, and trace stages are not persisted at their actual sidecar boundaries. |
| Phase 3: end-to-end delivery trace | Incorrect/partial | Identity and fixed acknowledgements exist, but Findings F1-F5 prevent the trace from proving delivery. Replay/listener lifecycle, exact per-event coverage, and bounded in-memory retention are incomplete. |
| Phase 4: renderer/process failures | Partial | Electron hooks and a React boundary exist. The boundary sits inside providers, and no live failure-path acceptance was run. |
| Phase 5: engine debug hardening | Partial | Newly written files are chmodded and a total cap exists. Cleanup is scheduled once per sidecar rather than once per app/day, and no focused engine regression test was added. |
| Phase 6: diagnostics export | Partial | Fixed local actions and an allowlist parser exist. Export ordering, privacy validation, and the promised derived evidence are incomplete. |
| Phase 7: performance/domain events | Missing | No measured threshold/event tranche was supplied. |

## Findings

### F1 — High — The earliest delivery stages are reconstructed only after main receives the frame

`app/main/main.ts:301-320` writes `engine.produced`, `sidecar.received`,
`sidecar.socket.queued`, and `sidecar.socket.sent` only while handling
`supervisor.socket.received`. `app/sidecar/sidecarServer.ts:3366-3374` merely
adds the envelope before encoding; it does not persist each stage at the stage's
actual time.

If a sidecar produces a frame and then stalls, overflows, fails encoding, or
dies before supervisor receipt, main receives neither the frame nor any of the
supposed earlier records. The trace therefore cannot identify exactly the
failure class it was introduced to diagnose. Even on success, all inferred
sidecar stages reuse one source timestamp, so per-hop latency is fictional.

**Disposition:** implementation owner must persist metadata-only stages at the
real sidecar boundaries (using the dedicated descriptor or another bounded
causal channel), with their actual process clocks, before acceptance.

### F2 — High — Maximum watermarks hide earlier missing acknowledgements

`app/main/deliveryTraceSink.ts:354-383` and
`app/main/diagnosticsBundle.ts:205-230` derive missing stages solely from the
maximum sequence observed at each layer. They do not use contiguous watermarks
or per-sequence stage coverage.

A two-frame probe where sequence 1 stops after `main.ipc.sent` and sequence 2
reaches `renderer.ui.committed` returns `firstMissingStage: null`. The later
maximum masks the missing first frame, so an exported bundle can pronounce a
stuck stream complete.

**Disposition:** implementation owner must track contiguous acknowledgement
watermarks and derive missing stages per sequence/range, with regression tests
for missing, duplicate, reversed, and same-batch delivery.

### F3 — High — Buffered frames omit `host.received` and are misdiagnosed as a host failure

`app/main/main.ts:1180-1183` records either `attachment.buffered` or
`host.received`. A pre-attach frame that is successfully received by main and
stored in the attachment gate records only the buffered stage. Replay later
adds `attachment.replayed`, but never repairs `host.received`.

Normal startup/reload buffering can therefore produce
`socketSent > hostReceived`, and the stuck-session summary names
`host.received` as the first missing stage even though host/main demonstrably
buffered the frame.

**Disposition:** implementation owner must mark `host.received` before the gate,
then independently mark the actual gate outcome.

### F4 — High — Renderer “applied” and “committed” acknowledgements do not prove those claims

`app/renderer/src/App.tsx:600-611` drains every pending acknowledgement from a
generic post-render effect. `app/renderer/src/App.tsx:917-940` queues an applied
ack for every frame and a commit ack for every ready/lifecycle/error frame,
without a store-specific watermark or a check that the terminal state caused
the committed UI. The supporting test at
`app/renderer/src/deliveryAcknowledgements.test.ts:4-24` is a source-string
ordering assertion only.

An ignored/misprojected frame, or a terminal event for a non-rendered session,
can be reported as applied and UI-committed as soon as any render completes.
This is anti-Potemkin evidence: the proof can be produced without the claimed
state/UI consequence.

**Disposition:** implementation owner must add live reducer/React tests and tie
applied acknowledgements to all applicable projector watermarks and commit
acknowledgements to the derived terminal UI state.

### F5 — High — Trace bookkeeping grows without bound for the lifetime of the app

`app/main/deliveryTraceSink.ts:101` retains every stream, while
`app/main/deliveryTraceSink.ts:198-216` creates per-stream maps and
`app/main/deliveryTraceSink.ts:247-273` stores every sequence, frame kind, and
stage forever. Disk files rotate, but these in-memory maps never evict.

An always-on session with streaming frames increases Electron main heap for
every event and every stage until process exit. The implementation contradicts
the contract's bounded ring requirement and can itself become the source of a
long-session failure.

**Disposition:** implementation owner must enforce a measured per-stream/global
record-and-byte cap, retain compact contiguous watermarks outside the ring, and
emit explicit trace-loss/eviction metadata.

### F6 — Medium — The support bundle's second privacy pass accepts path-bearing strings

`app/shared/operationalLog.ts:132-151` recognizes only selected POSIX roots and
keeps URL pathnames. `app/main/diagnosticsBundle.ts:102-165` checks that a trace
stage is a string rather than a member of `DELIVERY_STAGES`, and it does not
bound or sanitize trace identifiers.

Direct probes showed that `/var/db/private.txt` and
`https://example.com/private/customer/alice` survive operational sanitization,
and a delivery record whose `stage` is `/Users/alice/secret` is accepted for
export. A damaged or locally modified private log can therefore become a
path-bearing “redacted” bundle.

**Disposition:** implementation owner must enforce closed enums and bounded
opaque-ID grammars in the export parser, strip every absolute POSIX/Windows path,
and remove URL userinfo/path/query/fragment. Add adversarial second-pass tests.

### F7 — Medium — Debug retention runs once per sidecar, concurrently, rather than once per desktop app/day

`app/sidecar/index.ts:172-177` schedules `cleanupOldDebugLogs()` ten minutes
after every sidecar starts. `src/utils/cleanup.ts:411-452` scans and may unlink
the same shared debug directory without coordination.

Opening many sessions together schedules many full scans of thousands of files
at the same moment, producing redundant I/O and racing deletions. No focused
engine test covers the new total-cap deletion logic or active/latest targets.

**Disposition:** implementation owner should move this to one main-supervised
lightweight worker with a once-per-day marker/lock and add focused cleanup tests.

### F8 — Medium — Bundle admission prefers the oldest evidence

`app/main/diagnosticsBundle.ts:43-67` sorts filenames ascending and reads each
file from its beginning. It stops admitting records once half of the bundle
budget is reached and does not enforce an export age window.

When retained logs exceed the bundle budget, the export contains the oldest
records and can omit the crash/stall immediately preceding the user's export.

**Disposition:** implementation owner must select newest eligible files/records
first, enforce the advertised age and byte windows, and test rotation during
export.

## Nits

- `RendererErrorBoundary` is inside all providers
  (`app/renderer/src/main.tsx:25-40`), so provider failures are not caught by the
  claimed root boundary.
- `flushFatal()` closes the file but does not call `fsyncSync`; the comment in
  `app/main/operationalLogSink.ts:101-106` overstates close as forcing durable
  storage.
- The implementation did not update a migration STATUS row. This review leaves
  STATUS unchanged because review bookkeeping was not requested.

## Verification

```text
VERIFICATION
- bun test app/  -> FAIL; at least eight failures in registry/process/auth probes. The same selected failing files reproduce at parent 7b0164b, so they are pre-existing/environmental rather than attributed to 818a391.
- bun test app/shared/operationalLog.test.ts app/main/operationalLogSink.test.ts app/main/deliveryTraceSink.test.ts app/main/diagnosticsBundle.test.ts app/sidecar/operationalLogger.test.ts app/renderer/src/deliveryAcknowledgements.test.ts app/preload/preloadSource.test.ts  -> 15 pass / 0 fail
- bun run --cwd app typecheck  -> PASS
- bun run --cwd app typecheck:sidecar  -> PASS (5,561 upstream diagnostics ignored)
- bun run --cwd app renderer:build  -> PASS (639 modules; existing >500 kB chunk warning)
- bun run build:dev:full  -> PASS; maps 18/18 with 8 existing warnings; cli-dev version 2.1.87-dev.20260806.t161711.sha818a3911
- git diff --check 7b0164b..818a391  -> CLEAN
Stale-reference sweep: N/A; no rename/removal. New channels were inspected in preload/main source guards.
Not run: bun run --cwd app test:hardening (launches Electron; this review had no per-run GUI authorization).
Not run: live GUI acceptance for the Settings diagnostics actions and renderer fallback; operator verification required.
```

## Surface acceptance

```text
SURFACE ACCEPTANCE
- Engineering:       FAIL (full app battery is red; trace correctness findings remain)
- Security:          PENDING (hardening smoke not run)
- Fidelity artifact: N/A (new operational controls have no prototype acceptance target in the supplied contract)
- Live fidelity:     PENDING
- Overall surface acceptance: FAIL
```
