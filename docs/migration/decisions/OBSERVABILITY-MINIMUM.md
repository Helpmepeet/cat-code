# OBSERVABILITY-MINIMUM — making absence of a record mean something

> **STATUS: OPERATOR-RULED 2026-08-15.** Adopted after the 2026-08-14 renderer
> freeze and crash investigation. Written from two
> consecutive incidents whose consumers filed the same complaint in different
> words: `docs/reports/2026-08-09-renderer-sigtrap-root-cause.md` (via
> `docs/reports/2026-08-10-desktop-logging-incident-feedback.md`) and
> `docs/reports/2026-08-10-overnight-turn-hang-investigation.md`. It states a
> rule the individual fixes already imply; it does not amend
> `SECURITY-MINIMUM.md` or relax any cap in `IPC-RATE-BUDGET.md`.

## 1. The problem

The logging stack records transitions and end-of-operation summaries. That is
the right default, and §5 says why it must stay the default. But it has one
consequence nobody designed for: **a hung operation and an idle system produce
the same log — nothing.**

The 2026-08-10 overnight hang is the clean demonstration. A turn stopped
between its final assistant message and result emission. Every surface that
could have named the stall reports only on completion, so the transcript went
quiet in exactly the way an idle session goes quiet. Diagnosis took hours and
proceeded largely by ruling out explanations for silence.

The same shape appeared twice more in that one incident:

- `codex_send_path` / `codex_stream_surface` are end-of-stream summaries, so a
  request that hangs forever writes nothing at all. Absence cannot distinguish
  "no request was made" from "a request never finished".
- `acquireConversationTurn`
  (`src/services/api/codex-websocket-transport.ts`) can wait unboundedly
  *before* any send, in a window where the stream idle watchdog is not yet
  armed and nothing is logged.

Negative evidence is one of this stack's genuine strengths (no
`renderer.process.gone`, no crash report, steady worker cadence — each carried
real weight on 2026-08-09). The rule below exists to protect that property,
because negative evidence is only worth something where silence has exactly one
meaning.

## 2. The rule

**Any operation that can block indefinitely must either log its start, or be
covered by a watchdog that logs its failure to finish. Summary-only records are
permitted only for operations that cannot hang.**

Checkable form: for each such operation, name which of the two it has. An
operation with neither is a defect, whether or not it has ever hung.

"Can block indefinitely" means an await with no bound the code itself
enforces — a provider request, a lock or gate acquisition, a hook, a stream
body, a cross-process handshake. A bounded wait is not covered by this rule;
its timeout already turns silence into an event.

## 3. A watchdog that logs must not also abort, unless the abort is separately justified

This is the sharp edge and it is easy to get backwards. Killing a hung
operation *destroys the state that explains it*. A watchdog added for
diagnosis must fire a record and let the operation stay hung.

`CLAUDE_ENABLE_STREAM_WATCHDOG` (`src/services/api/claude.ts`) is the worked
example. It is often described as observability, but its own comment is
explicit that it "uses setTimeout to actively kill hung streams" — it aborts
at `STREAM_IDLE_TIMEOUT_MS`. Arming it satisfies liveness, not observability,
and arming it *for* observability would have destroyed the evidence the
overnight investigation was trying to capture. Recovery and diagnosis are
separate goals; a change that serves one should say which.

## 4. A label you cannot observe is worse than no label

Two corollaries, both paid for by real investigations:

**A designed terminal state must be distinguishable from a failure to reach
it.** On macOS, `window-all-closed` used to emit `app.shutdown.started` and
correctly never emit `app.shutdown.completed`, because parking in the dock is
the designed path — in the log, indistinguishable from a shutdown that hung,
and it misled the overnight investigation for a full pass. Fixed in
`2c63a972`: that route now emits `app.parked.windowless` and other platforms
keep `app.shutdown.started`, since `app.quit()` there really does begin a
shutdown. The rule this stands for outlives the instance: pair
started/completed on every route, or give the terminal state its own name.

**Prefer `unknown` to inference.** Where a record carries a phase, cause, or
class, populate it only from state the emitter directly holds. A confidently
wrong label sends the next investigation down a false path, which is strictly
worse than the silence this document is otherwise trying to eliminate.

**A field's name must not claim more than it measures.** Two probes read
correctly and were still the largest single cost of the 2026-08-14 renderer
investigation, because their names were read as answers to a broader question
than either one asks. `heapUsedBytes` reported 102 MB of V8 heap while the
process held 6.7 GB, and was quoted three times as evidence that the renderer
was healthy; it is now `jsHeapUsedBytes`, with `rendererWorkingSetKiB` carrying
the real figure. `eventLoopLagMs` reported 4.5 ms throughout a freeze in which
nothing had rendered for two minutes, because the event loop genuinely was idle
and timer scheduling is all it measures; `rendersCommitted` now answers render
liveness. Two narrow probes read together as a broad verdict is the compound
failure to watch for, since they carry the false authority of independent
instruments agreeing. Where a rename is not wanted, the constraint belongs at
the definition, not in the reader's head.

## 5. What this rule does not license

It is not "log more". Volume is a real cost with a real failure mode here: the
sidecar's FD 3 queue sheds records when saturated by design
(`app/sidecar/operationalLogger.ts`), and a restore on 2026-08-10 shed
thousands in one event. Records added under this rule spend the same budget as
the ones they would help interpret.

So the rule is deliberately narrow:

- It applies only to operations that can block indefinitely, not to operations
  in general. Everything else keeps the transitions-only discipline.
- A start marker is metadata only — mode, a prefix, a count — and must fit the
  closed vocabulary in `app/shared/operationalLog.ts`. Never a payload, never
  free-form text.
- One record per operation start, or one per watchdog firing. A record that
  repeats per frame, per chunk, or per poll of the same pending operation is a
  defect; report a condition once and remember that you reported it. A
  **bounded retry is not a repeat**: each attempt is itself a new operation
  that can hang independently, so it gets its own start marker and pairs with
  its own completion record. The test is whether the count is bounded by the
  work or by the duration of the failure — the latter is the defect.
- Priority classes on the shedding path (lifecycle never shed, anomalies shed
  last, samples shed first) are what keep this rule affordable. A start marker
  is worthless if it is the first thing dropped under load.

## 6. Decision and what is not decided

The operator adopts the rule in §2 and the constraints in §§3-5. Any operation
that can block indefinitely must log its start or have a watchdog that logs its
failure to finish. A diagnostic watchdog must not abort the operation unless
that abort has a separately justified liveness or recovery purpose. The
implementation remains bounded, closed-vocabulary, payload-free, and subject to
the existing shedding priorities and private-diagnostics contract.

The items implementing this decision are tracked as their own cross-cutting
rows in `docs/migration/STATUS.md` rather than by this document.

Explicitly left open:

- Whether to arm `CLAUDE_ENABLE_STREAM_WATCHDOG` in the sidecar. That is a
  liveness decision under §3, not an observability one, and it needs an owner.
- Whether to persist sidecar stderr at all. `app/supervisor/supervisor.ts`
  deliberately inherits stdout/stderr and the private-diagnostics rule in
  `CLAUDE.md` keeps persisted evidence to closed schemas. Bringing specific
  drop reasons into the operational vocabulary is the narrow alternative, and
  is preferred over wholesale capture.
