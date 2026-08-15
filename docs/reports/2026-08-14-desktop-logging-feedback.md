# Desktop logging feedback from the 2026-08-14 renderer incident

Filed by the session that diagnosed the freeze and crash recorded in
`docs/reports/2026-08-14-renderer-freeze-and-devtools-crash.md`, as a consumer
of the logging stack, following the precedent of
`docs/reports/2026-08-10-desktop-logging-incident-feedback.md` and
`docs/reports/2026-08-10-overnight-hang-log-request.md`.

Every claim here comes from actually reading these logs for a full session.
Where a probe misled me, I say so and name the wrong conclusion I drew from it,
because the failure mode being reported is not "a log was missing" but "a log
was believed".

## Disposition, as of 2026-08-15

Recorded here because this report is a request list, and a request list with no
dispositions ages exactly the way §G warns about. **Verify in source before
acting on any line.**

- **A1** done the same evening (`dd866ad0`), with `rendererWorkingSetKiB`
  (`e7aab83e`) supplying the figure the old field was being read for.
- **A2** done as documentation at the definition, not as a behavior change. The
  field measures correctly; re-sampling it at probe time was considered and
  rejected, because the event loop was genuinely idle during the freeze and
  would have reported the same value. `rendersCommitted` answers the question
  that was actually being asked of it.
- **B** re-diagnosed. The premise is wrong: a rollup lane built for exactly this
  landed on 2026-08-10 (`6bc3aac3`), four days before this incident, and carries
  per-stream per-minute watermarks on files the per-frame lane's rotation cannot
  reach. It was never read. It was also being evicted by its own file cap, which
  is per-launch and therefore rotated on restarts rather than on age; fixed
  2026-08-15. What remains is the owner decision on per-frame stage detail in
  `docs/reports/2026-08-10-delivery-trace-retention-measurement.md`.
- **D1** done 2026-08-15.
- **D2** deferred behind the replay-burst fix in
  `docs/plans/2026-08-14-renderer-freeze-fix-plan.md`. Instrumenting a behavior
  that is about to be removed is the wrong order.
- **E** done the same evening (`b110d99e`). Its secondary request, an
  applied-versus-queued comparison over a window, is a detector rather than a
  record and is carried as an open decision.
- **F** recorded in the playbook in
  `docs/reports/2026-08-15-renderer-incidents-final.md` §7.
- **G** applied to `docs/reports/2026-08-10-overnight-hang-log-request.md`: the
  table now carries an as-of date and row A5 no longer reads "Dispatched" for
  what is an open decision.

## Summary

The structural work done after 2026-08-10 paid off and should be preserved. The
damage this time came from three things the stack does that no one has treated
as defects: **two probes report numbers that do not mean what their names say**,
**the trace deletes the evidence for the incident it is recording**, and **one
record is written before the event it claims to record**.

The single highest-value change is not an addition. It is deleting or renaming
`heapUsedBytes`.

## A. Probes that actively misled, in the order they cost time

### A1. `heapUsedBytes` reports one compartment and is named as though it reports the process

`app/preload/preload.ts:148` reads `performance.memory.usedJSHeapSize`. That is
the V8 JavaScript heap only.

During this incident it reported 102 to 115 MB while the renderer process held
**6.7 GB**. I cited it to the operator as positive evidence that the renderer
was healthy, three separate times, and used it to argue the renderer had been
ruled out. It was the largest single contributor to hours spent looking in the
wrong place.

This is its second offence. `docs/reports/2026-08-09-renderer-sigtrap-root-cause.md`
added the field expressly so that "the next memory incident" would have a growth
curve. The next memory incident arrived five days later, was a 6.7 GB memory
incident, and the field showed a flat 100 MB throughout.

**Requested: remove it, or rename it to something that cannot be read as process
memory (`jsHeapUsedBytes`).** A probe that answers a different question from the
one its name implies is worse than no probe, because a missing number invites
measurement and a wrong number ends the enquiry. Renaming is not cosmetic here;
it is the fix.

### A2. `eventLoopLagMs` is a cached value with a floor, presented as a live measurement

`app/preload/preload.ts:88` writes `lastMeasuredEventLoopLagMs` from a nested
`setTimeout(0)` off a five-second interval; the health probe reads that stored
value verbatim at sample time. Its practical floor is around 4 ms.

I quoted "4.5 ms, healthy" repeatedly as though it demonstrated a responsive
renderer. It demonstrates that timers fire. During this incident the renderer
was, by every other measure, not servicing its work at all while reporting
4.2 to 4.7 ms continuously.

**Requested: not necessarily a behaviour change, but the field cannot keep
implying liveness it does not measure.** Either sample it at probe time, or name
and document it as a timer-scheduling check. A consumer cannot be expected to
read the preload source before trusting a field called "event loop lag".

### A3. Together these two produce a confident, false "renderer is healthy" verdict

This is the compound failure worth recording. Independently, each field is a
defensible narrow measurement. Read together in a health sample, they state that
memory is fine and the event loop is responsive, which is precisely the
conclusion that was false, and they state it with the authority of two
independent instruments agreeing. Negative evidence carried real weight on
2026-08-09 and is a genuine strength of this stack (`OBSERVABILITY-MINIMUM.md`
§5); that is exactly why fields whose names overstate their scope corrode it.

## B. The trace destroys the evidence for the incident it is recording

Delivery-trace retention is six files at roughly 20 MB. Under streaming load
that is minutes.

Concretely, this session: files I read at 14:26 to 14:33 were gone by 15:04,
deleted **during the investigation that was reading them**. The consequence is
recorded as an open question in the incident report: the freeze onset is
unknown and unrecoverable, the operator's observed "5m 44s" cannot be reconciled
against any surviving record, and the freeze duration is stated as "at least 124
seconds, possibly around fifteen minutes" because the earlier files no longer
exist.

Two aggravating factors:

- The replay bursts (§D2) write at roughly 25 MB/s, so one pathology's noise
  evicts another pathology's evidence within a couple of minutes.
- The 2026-08-10 request already reported a 3,317-record `queue_saturated` shed
  and its B4 item established that lifecycle and bulk records share one fate.
  That fix (`ac7bd1de`) addressed the in-memory queue. File-level retention has
  the same problem and was not covered.

**Requested: retention that cannot be exhausted by bulk streaming records
within the window an investigation needs.** The specific mechanism is a design
question and I am not prescribing one; the requirement is that a session's first
frames survive long enough to be read after the session ends badly. This is the
second incident in which onset is unrecoverable.

## C. What worked, and should not be traded away

Reproduced because these are properties to preserve, and because §A and §B are
in tension with the temptation to log more.

- **Closed vocabulary and flat fields.** Every log in this incident was parseable
  with a `rg` filter and a five-line Python snippet, with no schema guessing and
  no redaction anxiety. This is the reason a full-day investigation was possible
  at all.
- **`session.turn.started` / `completed` with `durationMs` and `reason` (CC-50).**
  This produced *positive* evidence of engine health rather than an argument from
  silence, and it is what let the engine be excluded in one pass instead of the
  hours the equivalent took on 2026-08-10. Its most valuable single record was a
  turn completing normally two and a half minutes after the renderer had died.
- **The delivery-trace stage chain.** As on 2026-08-10, this separated "the
  engine stopped producing" from "the renderer stopped applying", and that
  distinction carried the entire verdict again. It is the most valuable thing in
  the stack.
- **`messageKind` (`5eb76537`).** This closed the last surviving alternative
  explanation for the central claim. It is exactly the field the previous
  investigation asked for as B3, and it worked as intended one incident later.
- **`renderer.process.gone` with `reason`, `exitCode` and `pid`**, plus
  `renderer.recovery.started` / `succeeded`. The pid tied the operational log to
  the macOS crash report unambiguously, and the recovery pair is the only reason
  the "opening DevTools unfroze it" illusion was caught rather than believed.
- **`app.parked.windowless` (B2).** The darwin park route did not mislead this
  investigation for a single pass. Fix confirmed effective.

## D. Records that are wrong rather than missing

### D1. `attachment.replayed` is stamped before delivery is decided

`app/main/main.ts:1787` stamps the record inside the `.map()` that builds the
replay; `deliver()` then decides whether to send anything at all and can return
early at `app/main/main.ts:915`.

So the trace can record deliveries that never happened. This produced a false
anomaly in this incident: "1,883 `attachment.replayed` for a session with no
matching `preload.received`" was reported to the operator as evidence of a
delivery pathology. It is at least partly an artefact of the stamp site.

**Requested: stamp what is actually handed to `webContents.send`, or emit an
explicit dropped-stage record.** Small change. It stops the trace manufacturing
mysteries that consume investigation time.

### D2. Replay bursts are invisible as bursts

Roughly 50,000 records in 2.4 seconds, with the renderer spiking to 860 MB, is
observable only by noticing that trace files rotated unusually fast and counting
records by hand. Nothing names the burst, its size, or its trigger. The
underlying behaviour (`deliver()` sending an entire replay as one
`webContents.send`) is its own defect and is filed separately in
`docs/plans/2026-08-14-renderer-freeze-fix-plan.md`; the logging observation is
that a burst of this magnitude should not have to be inferred from file
timestamps.

## E. The gap that mattered most

**Nothing anywhere records whether the renderer committed a render.**

The central question of this incident — did the display redraw or not — is not
answerable by any log the stack keeps. It was ultimately answered by inference
from the absence of `renderer.state.applied` acknowledgements, which required
reading three source files to establish that the acknowledgement is emitted from
a post-commit effect with no dependency array. That inference is sound but it is
an inference, and its scope had to be qualified in the report.

A counter incremented in that same effect and carried in the health payload
would have answered it in one reading, and would distinguish the three candidate
failures that currently look identical in every log.

Related and secondary: `renderer.state.applied` versus `renderer.state.queued`
counts are a working renderer-freeze signal (2,388 against 0 during the freeze,
approximately 1:1 in healthy windows), and nothing computes the comparison. Note
that this must be a count over a window: the incident report establishes why the
watermark path narrowed by `bb7d5964` would have returned nothing here.

## F. Not a logging request: tooling that is absent from every playbook

Recorded because two investigations have now failed to use it.

`vmmap --summary <pid>` and `footprint -p <pid>` against a **live** renderer give
the memory compartment breakdown and a growth curve immediately, with no code
change, no DevTools, and no cooperation from the process. In this session they
identified the memory compartment within an hour after a day of forensics had
failed to, and they produced the healthy baseline that showed the 2026-08-09
report's "32 GB of PartitionAlloc address space" argument to be unsound (32 GB is
the normal fixed reservation).

The corollary, which cost this incident its live evidence: **DevTools is a
mutating probe, not a read-only one.** Opening it sends `Debugger.enable`, which
re-parses every script in the process, and on a loaded renderer that is fatal.

Both facts belong in the incident playbook rather than in a logging change, and
are recorded there.

## G. Process observation, offered because it recurred

Three separate times this session a dated document was trusted over source and
produced a wrong conclusion:

- Row B3 of `docs/reports/2026-08-10-overnight-hang-log-request.md` read
  "Dispatched" for a field that had already landed. I concluded frame
  composition was unknowable and left the central claim resting on a weaker
  argument. Corrected in place.
- `docs/reports/2026-08-09-renderer-sigtrap-root-cause.md` attributes its crash
  to the transcript render path. That attribution is flagged as inferred in the
  report itself, but it was carried forward as established and drove a
  recommendation that had to be withdrawn.
- The same report's 32 GB address-space argument is unsound, as measurement
  against a healthy process now shows.

CLAUDE.md §8.2 already states the rule. The observation worth adding is that
**disposition tables in filed requests age worse than prose**, because a reader
treats a "✅ / Dispatched" column as current state rather than as a record of
what was true on the filing date. If those tables are to be kept, they need a
stated as-of date and an instruction to verify against source.
