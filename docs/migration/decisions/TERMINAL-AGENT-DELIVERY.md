# Terminal Run: non-waking agent output

Date: 2026-09-17
Status: Proposed implementation contract. Not implemented.

Parent: [implementation plan](../../plans/2026-09-17-interactive-code-block-run.md).

## Decision

Introduce a dedicated passive attachment source named `terminal-output`.
Do not enqueue it as a prompt or task notification. Those existing queues have
boundary drains that can create a new turn. Terminal output must not call
`controller.submit`, schedule a turn, wake a parked sidecar, or create a goal
continuation. Exit and output-limit records are passive too.

All admitted output is automatically pending for the owning agent. There is no
manual sharing action, summary selection, or tail-only delivery policy.

## Sampling boundary

The engine queries this source when constructing an eligible model request:
the next explicit user submission and subsequent model requests in that active
user-initiated turn. This includes the next tool round while a terminal is
waiting for human input. An in-flight provider request cannot receive new bytes.
If the turn ends first, output stays in the journal for the next user turn.
Automatic turns do not drain this source merely because it is nonempty.

Read committed journal sequences after the accepted watermark. Select contiguous
ranges in session append order, with explicit per-run attribution. Keep each
batch within 64 KiB of text and the actual remaining model-input token budget,
whichever is smaller. More output stays pending and is sampled at later eligible
requests. Use ordinary compaction to make space; do not silently truncate the
pending source or create requests just to drain it.

The pending-source cap is defined in [the journal contract](TERMINAL-RUN-JOURNAL.md).
On reaching it, stop the producing command with `output_limit`. This is how a
bounded model context coexists with automatic sharing without discarding an
arbitrarily selected part of the output.

## Durable acceptance and dedupe

The durable conversation record, not an IPC acknowledgement or iterator yield,
is the authoritative receipt. Each batch has a stable ID derived from session,
run IDs, source ranges, and normalizer version. Its record includes the exact
normalized text and terminal provenance, not only a pointer to an expiring file.

For every eligible request:

1. Reserve pending contiguous ranges in the single engine consumer. The run
   journal still considers them unaccepted.
2. Construct a typed terminal-output attachment with its stable ID and ranges.
3. Add it once to canonical conversation input, persist that input, and await
   the durable transcript barrier before dispatching to the provider.
4. Only then atomically advance the journal's accepted watermark. An acceptance
   callback has the same durability requirement as `onInputPersisted`; add an
   explicit per-batch callback for mid-turn input instead of pretending the
   initial-submit callback or `notifyCommandLifecycle('started')` covers it.
5. On failure before persistence, release the reservation without advancing.
   On provider failure after persistence, reuse the existing conversation record;
   do not append a second attachment.

Recovery reconciles batch IDs/ranges from durable transcript receipts before
reading a possibly stale journal watermark. A crash after transcript persistence
but before cursor update therefore cannot duplicate input. A crash before
persistence leaves the output pending. Never advance a cursor solely because
output was sent to the renderer or put in memory.

This provides effectively-once insertion into canonical input, not a guarantee
that an external provider completed a response or internally processed it once.
Provider retry semantics remain unchanged. Receipt IDs must survive compaction;
transfer them to bounded session receipt metadata before compacted records are
retired. Reuse per-run high watermarks so receipt bookkeeping does not grow once
per output chunk forever.

## Attribution, control sequences, and history changes

Normalize through a stateful bounded terminal parser. Keep printable output and
line/cursor updates in order, representing redraws as output updates rather than
discarding earlier messages or repeatedly injecting a full screen. No LLM summary
step. Terminal rendering and parsing do not grant clipboard/navigation/input
capabilities; see [candidate contract](TERMINAL-RUN-CANDIDATES.md).

Wrap text in the engine's typed attachment representation with command/run/cwd
and source ranges. Output text cannot supply metadata fields or close a trusted
wrapper. Attribute it as untrusted external command output, never an operator
instruction or assistant response. Test literal role delimiters and printable
prompt-injection text, in addition to ANSI/OSC escapes. Existing secret rules
remain in force; if they prevent delivery, report that condition explicitly
rather than advance the cursor over undisclosed output.

On conversation rewind, fence the old pending-delivery generation, reconcile
against the retained prefix, and keep unaccepted output visibly pending for
subsequent explicit user input in the same session. Do not auto-reinsert removed
accepted batches or rerun commands. A branch inherits only attachments already
in its copied conversation prefix; active runs and pending ranges remain with
their original engine session. Source-candidate validity is checked separately.

## Required evidence

- An idle run emits output and exits without any model/API turn starting.
- A busy turn takes available output at its next input boundary.
- A turn ending before that boundary leaves output pending until user input.
- Renderer replay, repeated callbacks, and provider retries do not append a
  second canonical attachment.
- Crash before persist, after persist/before cursor update, and after cursor
  update all recover without loss or duplicate insertion.
- Token-budget exhaustion leaves a contiguous pending suffix; pending-cap
  exhaustion stops the command with the explicit retained boundary.
- Test compaction receipt survival, rewind, branch, parked-session output, and
  attribution/normalization adversarial fixtures.
- Inspect actual outbound model inputs for both supported provider paths using
  isolated fake transports. Seeing text in the renderer is not model-delivery
  evidence, and verification must not consume live account quota.

Sources: [sidecar turn drains](../../../app/sidecar/sidecarServer.ts),
[engine input persistence](../../../src/QueryEngine.ts),
[query attachment handling](../../../src/query.ts),
[command lifecycle signals](../../../src/utils/commandLifecycle.ts).
