# Log request from the overnight turn-hang investigation, and its disposition

The session that diagnosed the 2026-08-10 overnight turn hang (app `f578320a`
/ engine `ae87a15c`) filed a request against the logging stack as its
consumer. Its own findings are in
`docs/reports/2026-08-10-overnight-turn-hang-investigation.md`; this file is
the **request** and what was done with it.

It exists because the request itself was delivered out of band. Records and
STATUS rows landed citing "the overnight investigation", and a source comment
in `app/sidecar/operationalLogger.ts` carries a figure from it, with nothing
in the repo behind either. This is that source. The figures below are the
requesting session's measurements, reproduced as filed and not independently
re-derived here.

Filed and dispatched 2026-08-10. Every citation in this file was verified
against source on the day it was written.

## A. Records the investigation needed and did not have

| # | Request | Disposition |
|---|---|---|
| A1 | Turn lifecycle from the sidecar: `session.turn.started` / `completed` / `stalled`, the stall firing once after N minutes of an empty tool queue and no engine events, naming the pending post-turn phase. Called "the single highest-value addition". | **Not yet started.** Needs `app/sidecar/sessionController.ts`, which was held by another session's uncommitted work for the whole dispatch window. Deliberately not raced. |
| A2 | Slow-await diagnostics on the post-turn path, log-only, no timeout. | ✅ `3a0b066c` (CC-46) |
| A3 | Provider request START visibility, since `codex_send_path` / `codex_stream_surface` are end-of-stream summaries and a hung request writes nothing. | ✅ `de506a11` (CC-46), as the start marker. The alternative offered — arming `CLAUDE_ENABLE_STREAM_WATCHDOG` — was **declined**: see §D. |
| A4 | Websocket conversation-lock wait telemetry before any send. | ✅ `caddcd90` (CC-46) |
| A5 | `frame.dropped` in the operational log; the sidecar's outbound drop paths log only to inherited stderr. | Dispatched. |
| A6 | Keep the priority of the four already-filed tasks in `docs/reports/2026-08-10-desktop-logging-incident-feedback.md`. | ✅ All four landed: CC-41 through CC-44. |

## B. Changes to existing behavior

| # | Request | Disposition |
|---|---|---|
| B1 | "Absence is evidence" is currently false — make it true. Any operation that can block must log its start or be covered by a watchdog that logs its failure to finish. | ✅ Recorded as `docs/migration/decisions/OBSERVABILITY-MINIMUM.md`, PROPOSED. |
| B2 | Give the darwin park route its own event; `app.shutdown.started` with no `completed` is the designed path but reads as a hung shutdown. Misled the investigation for a full pass. | ✅ `2c63a972`, new `app.parked.windowless`. |
| B3 | An event-type bucket on delivery-trace records, so "was any of the last 6 frames a `result`?" is answerable. | Dispatched. |
| B4 | Priority classes for the lossy FD 3 queue: lifecycle never shed, anomalies shed last, samples shed first. **"The 3,317-record `queue_saturated` shed during the morning restore shows lifecycle records and bulk samples share one fate."** | ✅ `ac7bd1de` (CC-45). This sentence is the provenance for the figure cited in `app/sidecar/operationalLogger.ts`. |
| B5 | Persist sidecar stderr minimally. | **Declined pending an owner decision.** See §D. |

## C. What the investigation said already worked

Reproduced because these are properties to preserve, not achievements to file:

- The closed vocabulary and flat fields made every log trivially and safely
  parseable — no schema guessing, no redaction anxiety.
- The delivery trace conclusively separated "engine stopped producing" from
  "pipeline lost frames", and that distinction carried the whole verdict.
- The 2026-08-09 health-probe additions (`visible`, `heapUsedBytes`) paid off
  within one day: they ruled the renderer out in minutes and killed a wrong
  "it froze while hidden" narrative on the spot.
- Negative evidence kept its diagnostic weight (no `renderer.process.gone`,
  no crash reports, steady worker cadence).

The last point is the one every addition here is in tension with, which is
why OBSERVABILITY-MINIMUM §5 bounds the rule rather than licensing "log more".

## D. Two requests deliberately not implemented as written

**Arming `CLAUDE_ENABLE_STREAM_WATCHDOG` (offered under A3).** A3 presented
this as an alternative to a start marker. It is not one. The watchdog does
not merely observe: its own comment in `src/services/api/claude.ts` says it
"uses setTimeout to actively kill hung streams", aborting at
`STREAM_IDLE_TIMEOUT_MS`. Arming it by default would destroy exactly the hang
state A2 asked to preserve, contradicting A2's own "LOG-ONLY, no timeout"
instruction. It is also on the Claude path, while the gap A3 describes is on
the Codex path, so the two are not substitutes. Arming it is a liveness
decision and needs an owner (OBSERVABILITY-MINIMUM §6).

**Persisting sidecar stderr (B5).** `app/supervisor/supervisor.ts` spawns
with `stdio: ['ignore', 'inherit', 'inherit', 'pipe']` and states in a comment
that stdout/stderr "deliberately stay inherited for development and are never
persisted wholesale". CLAUDE.md's private-desktop-diagnostics rule builds on
that: bounded local JSONL under closed schemas, exported only as an
allowlisted redacted bundle. Wholesale stderr capture is what that design
avoided, so this is an erosion of a documented decision rather than a gap in
it. A5 brings the important subset — the drop reasons — into the closed
vocabulary instead, which the request itself offers as the alternative.

## E. Open

- **A1 remains unbuilt** and is the request's own highest-value item.
- No record added for this request has yet been produced by a **real** stall;
  all verification used injected timers. First live evidence is the next
  occurrence.
- `codex_request_start` writes only to the main owned transcript, so a Codex
  request hanging inside a subagent still leaves no start marker in the
  subagent's own file.
- `app/main/operationalLogSink.ts` sheds under a different mechanism
  (`rate_dedupe`) and was not audited for the B4 problem.
