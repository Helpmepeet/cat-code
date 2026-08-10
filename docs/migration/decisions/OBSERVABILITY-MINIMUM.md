# OBSERVABILITY-MINIMUM — making absence of a record mean something

> **STATUS: PROPOSED 2026-08-10, NOT operator-ruled.** Written from two
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
it.** On macOS, `window-all-closed` emits `app.shutdown.started` and correctly
never emits `app.shutdown.completed`, because parking in the dock is the
designed path. In the log that is indistinguishable from a shutdown that hung,
and it misled the overnight investigation for a full pass. Either pair
started/completed on every route or give the parked route its own event.

**Prefer `unknown` to inference.** Where a record carries a phase, cause, or
class, populate it only from state the emitter directly holds. A confidently
wrong label sends the next investigation down a false path, which is strictly
worse than the silence this document is otherwise trying to eliminate.

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
  repeats per frame, per chunk, or per retry is a defect; report a hole once
  and remember that you reported it.
- Priority classes on the shedding path (lifecycle never shed, anomalies shed
  last, samples shed first) are what keep this rule affordable. A start marker
  is worthless if it is the first thing dropped under load.

## 6. Status and what is not decided

Proposed, not ruled. The items implementing it are tracked as their own
cross-cutting rows in `docs/migration/STATUS.md` rather than by this document.

Explicitly left open:

- Whether to arm `CLAUDE_ENABLE_STREAM_WATCHDOG` in the sidecar. That is a
  liveness decision under §3, not an observability one, and it needs an owner.
- Whether to persist sidecar stderr at all. `app/supervisor/supervisor.ts`
  deliberately inherits stdout/stderr and the private-diagnostics rule in
  `CLAUDE.md` keeps persisted evidence to closed schemas. Bringing specific
  drop reasons into the operational vocabulary is the narrow alternative, and
  is preferred over wholesale capture.
