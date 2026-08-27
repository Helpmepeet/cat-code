# Codex adapter discards assistant text delivered without deltas

Status: loss path CONFIRMED and FIXED 2026-08-28, then reviewed and hardened the
same day. Trigger still UNKNOWN. Impact partially unsettled; see "How the next
occurrence gets recorded" for what will and will not capture it.
Investigated 2026-08-27, corrected 2026-08-28 after an adversarial review by
gpt-5.6-sol that refuted three of the original claims.

## The confirmed defect

The Codex stream adapter surfaces assistant text from exactly one event:
`response.output_text.delta` at
[codex-fetch-adapter.ts:2090](../../src/services/api/codex-fetch-adapter.ts:2090),
and only when the delta is a non-empty string.

`response.output_text.done` has no handler anywhere in the adapter. The
`item?.type === 'message'` branch of the `response.output_item.done` handler at
[codex-fetch-adapter.ts:2250](../../src/services/api/codex-fetch-adapter.ts:2250)
only closes an already-open block, guarded by `if (currentTextBlockStarted)`; it
never reads `item.content`. `response.content_part.done` is likewise ignored.

So when a message item's text arrives only in terminal events, the adapter emits
no text and the assistant message is persisted without it. The turn still
reports `completed: true`. No error, no warning, no log line.

Scope correction from review: this silence is specific to the **streaming** path.
On the non-streaming path `materializeAnthropicMessageFromSse` throws
`Codex non-streaming fallback produced an empty or invalid assistant message`
when the assembled content is empty, so a done-only response failed loudly there
rather than returning a blank turn.

The same file already implements this exact recovery for a different item type:
the `item?.type === 'reasoning'` branch at
[codex-fetch-adapter.ts:2282](../../src/services/api/codex-fetch-adapter.ts:2282)
reads `item.encrypted_content` straight off the done event. Message
canonicalization also extracts `item.content[].text`
([codex-fetch-adapter.ts:895](../../src/services/api/codex-fetch-adapter.ts:895),
with a transport-local fallback at
[codex-websocket-transport.ts:847](../../src/services/api/codex-websocket-transport.ts:847)).
The knowledge exists in the file; it was never applied to `message` items on the
SSE path.

Not a regression. `git log -S"response.output_text.delta"` on the adapter bottoms
out at `86051a8e` (2026-04-30, initial private snapshot). `codex-fetch-adapter.test.ts`
has 22 delta-stream fixtures and zero references to `output_text.done`, so the
delta-less shape has never been exercised.

## What triggers it: UNKNOWN

**A previous version of this report claimed the server delivers such responses in
a single flush, based on 11 of 13 cases having `completed_ms - first_raw_event_ms
<= 2ms` against a control median of ~5.9s. That claim is withdrawn. The timing is
an artifact of our own code.**

`primeCodexEvents` buffers every event until `codexEventBeginsVisibleOutput`
returns true or `response.completed` arrives
([codex-fetch-adapter.ts:3249](../../src/services/api/codex-fetch-adapter.ts:3249)),
then replays the entire buffer synchronously
([:3271](../../src/services/api/codex-fetch-adapter.ts:3271)).
`codexEventBeginsVisibleOutput` does not recognize `response.output_text.done`
([:2882](../../src/services/api/codex-fetch-adapter.ts:2882)). A done-only
response is therefore held to completion and released in one tick, making
`first_raw_event_ms == completed_ms` by construction. The comparison against
delta-bearing responses, which release the buffer at their first delta and then
measure a live stream, is circular.

The debug line `initial_output_ready ... events=8 trigger=response.completed`
records exactly this, and was originally misread as corroboration.

Whether terminal-only delivery is normal server behavior, permitted by the
Responses API contract, or newly introduced, is not answerable from this
repository.

## Prevalence and its limits

Detector: completed responses whose `codex_stream_surface` histogram contains
`response.output_text.done` and no `response.output_text.delta`.

Two sweeps of `~/.cat-code/projects/`, hours apart (the corpus is live and grows):

| | first sweep | review sweep |
|---|---|---|
| completed turns | 19,655 | 19,767 |
| turns with a text item | 4,035 | 4,053 |
| **done-without-delta** | **13** | **13** |
| multi-part (`output_text.done` > 1) | 95 | 97 |
| done-without-delta with tool calls | 0 | 0 |

Tool-call turns are unaffected. Tool calls arrive via `output_item.added`/`done`,
which the adapter does handle, so agentic work never silently breaks. Only prose
answers are exposed.

The detector is a detector for **at-risk responses**, not confirmed loss. Known
limitations, all raised by the review and accepted:

- A `response.output_text.delta` with an empty or non-string `delta` is discarded
  by the handler at [:2091](../../src/services/api/codex-fetch-adapter.ts:2091)
  but still appears in the histogram as a delta, hiding an affected response.
- Multi-part responses can lose one part while another streams. Two current
  candidates have two `output_text.done` events and one delta event:
  `b79860e5-fb16-40f5-86b6-0bf2fcd59256.jsonl` L168 and
  `7c2fe259-0a0e-4cfd-a456-96895128f13e.jsonl` L923.
- A populated `output_item.done` carrying no `output_text.done` would not be
  found at all.
- `had_visible_output: true` does not mean text was visible; reasoning and
  server-side web search also set it.

## Impact: what the evidence does and does not support

The surface records retain event **types and counts only**. No terminal payload
was ever captured. So the repository proves text *could* be discarded on this
path, not that any specific payload was non-empty. Two of the three cases resolve
differently.

**The 11 four-token cases: near-certainly real short replies.** Each has exactly
one output item, one content part, zero reasoning events of any kind, and
`output_tokens: 4`. There is no other output item to attribute those tokens to,
and an empty text part does not cost 4 tokens. The review's "these may all have
been empty" alternative does not hold for these 11. Not proof, but the balance is
strongly against empty.

**The 225-token case: unsettled, and an earlier claim is withdrawn.** In
`8534eb88-5400-44c6-9cc1-228ec9c0ccac.jsonl`, the surface record at L22 shows 225
output tokens, two output items, four kinds of reasoning event, one text part with
`output_text.done` and no deltas; the persisted assistant message at L20 contains
only a 92-character thinking block. **The earlier reading, "approximately 200
tokens of answer destroyed", is withdrawn.** The adapter copies aggregate
`usage.output_tokens` at
[:2371](../../src/services/api/codex-fetch-adapter.ts:2371) with no content-level
attribution, so the total cannot be split between hidden reasoning, the rendered
summary, and terminal text. A large lost answer and a near-empty text part are
both compatible with what was retained.

**The 70-token case.** Two output items, zero reasoning events, no client tool
calls, `had_visible_output: true`. The review attributed both visible-output
records to "reasoning/thinking machinery"; that is wrong here, since this record
has no reasoning events at all. The shape is consistent with a server-side web
search item plus a dropped message item. Token allocation is again unsettled, but
there is no reasoning to absorb the count.

## The downstream effect on conversation history

A dropped reply does not only lose the answer. Because no assistant message is
persisted, the preceding user message remains last in history, so the next prompt
is merged into the same user turn by
[messages.ts:2267](../../src/utils/messages.ts:2267)
(`shouldMergeAdjacentUserMessages` at
[:2542](../../src/utils/messages.ts:2542), `mergeUserMessages` at
[:2502](../../src/utils/messages.ts:2502)). Confirmed in
`13ce69b4-d6fc-4eaf-a901-062d1ab3fb8a`: the debug log shows `messages=142` for
both the 16:35:29 and 16:37:48 requests despite an extra user message existing.

`joinTextAtSeam` retains **both** text blocks
([messages.ts:2597](../../src/utils/messages.ts:2597)), so the earlier text is
still delivered to the model. The turn boundary is erased; the content is not.

This matters for attribution, and an earlier framing here is also withdrawn. In
the observed session the user typed "yeah sure", got no reply, asked what the
reply had been, and was told they had never typed it. **The original conclusion,
that the denial was "consistent with the history it was given", was too
generous.** The literal string was present in the merged user item. Correct
attribution is two separable failures: the harness erased the turn boundary, and
the model then denied text that was plainly in its input.

## What landed

Implemented in `src/services/api/codex-fetch-adapter.ts` on 2026-08-28.

- `textPartsEmitted`, a per-content-part key (`output_index:content_index`)
  recording which parts have produced text. Per part, not per response, so a
  multi-part message can stream one part and recover another.
- `emitAssistantText`, one helper shared by the delta path and both recovery
  paths, so recovered text merges into an open text block exactly as a
  consecutive delta would and block ordering against reasoning is unchanged.
  The delta handler was rewritten to call it, leaving a single emit path.
- A `response.output_text.done` handler that recovers the part's text when that
  part produced no delta.
- A fallback in the `output_item.done` message branch that walks `item.content`
  and recovers any part still unemitted, covering responses that carry a
  populated message item with no `output_text.done` at all.
- `codexEventBeginsVisibleOutput` now recognizes terminal text, so a done-only
  response no longer buffers to `response.completed`. This also retires the
  artifact that produced the withdrawn timing claim above.
- Both recovery paths log `recovered_terminal_text` at warn level with the source,
  part key, and character count, composed from `RECOVERED_TERMINAL_TEXT_PREFIX`
  (`src/utils/debug.ts`) which is on the always-log allowlist. It was initially a
  plain `[codex-fetch]` line, which `shouldLogDebugMessage` suppresses for
  non-ant users outside debug mode: the log existed but would have been written
  nowhere in an ordinary session.
- Part keys prefer `item_id`, the identity all three event kinds carry for the
  same item, and give absent values sentinels instead of collapsing them to `0`.
  Aliasing "no index" with "index 0" let one part suppress another part's
  recovery, which is the same silent loss this path exists to prevent.
- `outputTextOfPart` narrows on `part.type === 'output_text'`, so a `refusal`
  part is never emitted as assistant prose.

Token accounting was deliberately left alone: `outputTokens` is a delta-counting
fallback that `response.completed` overwrites with real `usage.output_tokens`, so
recovery must not add estimates to it.

Tests added to `codex-fetch-adapter.test.ts`: terminal-only via
`output_text.done`, terminal-only via `output_item.done`, no duplication when
deltas already delivered the part, and a multi-part case where one part streams
and one does not. Three of the four fail with recovery disabled; the
no-duplication test is a guard and passes either way, by design.

Verification: `codex-fetch-adapter` 83 pass, plus `codex-websocket-transport` and
`codex-continuation-e2e` green (129 across the three suites). `bun test
src/services/api/` is 424 pass / 1 fail, and that failure is
`accountRecoveryDiagnostics.test.ts`, which passes 17/17 file-isolated as the
account suites are documented to require. `bun run build:dev:full` green.
Typecheck shows one pre-existing TS2322 in this file at the `stop_sequence`
assignment, in a region no diff hunk touches (HEAD line 2735, now 2789); zero new
diagnostics.

## How the next occurrence gets recorded

Three sinks, in descending durability. The report originally credited only the
third, which was also the weakest.

1. **The persisted assistant message.** Recovered text now lands in the
   transcript as ordinary message content. This is the strongest evidence and it
   is unconditional.
2. **The `codex_stream_surface` record** (`recordCodexStreamSurface`,
   `src/utils/sessionStorage.ts`), written to the transcript unconditionally.
   Its `raw_event_types` histogram is what produced the 13-record corpus above,
   so the at-risk signature stays detectable after the fix.
3. **The `recovered_terminal_text` debug line**, now always-logged, carrying the
   recovered character count. Useful when a debug log exists for the session.

Together 1 and 2 answer the open question the original report could not: a future
sweep can find a done-without-delta response and read whether its assistant
message has text.

Not verified: no occurrence has been observed since the fix, because the trigger
cannot be reproduced on demand.

## Review findings and known deviations

Reviewed 2026-08-28 by four lenses (correctness/lifecycle, contracts, spec, and
an executing effect lens). What it changed, beyond the hardening listed above:

- **The first cut's tests did not cover the primary branch.** Every test supplied
  both a populated `output_item.done` and an `output_text.done`, so the item-level
  fallback covered for the `output_text.done` handler: that handler could be
  deleted outright with all 129 tests green. The first test now carries no
  `output_item.done` at all, and per-branch mutation runs confirm each recovery
  path and the priming change now have a test that fails without them.
- **`codexEventBeginsVisibleOutput` had no coverage either**, and reverting it left
  every suite green. Two priming tests now assert release-before-`response.completed`
  against a stalled source.
- **Behavior change not previously recorded:** recovered text sets
  `emittedVisibleOutput`, which also gates cap/auth classification of a later
  `response.failed`. A `usage_limit_reached` failure arriving after terminal-only
  text now yields `CodexResponseFailedError` (no account rotation, user keeps the
  recovered text) where it previously yielded `CodexAccountCapError` (rotation and
  replay). This matches what the delta path has always done and follows the
  module's rule that a turn is not replayed after visible output, so it is
  intended, but it was undocumented.

Known deviations, stated rather than dropped silently:

- **`response.content_part.done` is still not handled** (spec item 2 named it as a
  third recovery source). It costs nothing on all 13 observed records, every one of
  which also carries `output_text.done`. The residual is a server that sends
  `content_part.done` bearing text with neither of the other two terminal events.
- **No websocket continuation regression test** (spec item 6). The mechanism was
  verified sound by inspection and by the transport and continuation suites running
  green: `completedOutputItems` is fed from the raw `output_item.done` independent
  of what the adapter emits, so recovery cannot perturb it, and for the single-part
  case recovery restores the canonical equality reconciliation wants. Unguarded
  against future regression. Left open deliberately, not overlooked.
- **Multi-part messages still force a websocket full send.** The adapter merges all
  content parts of one message into a single text block while the recorded baseline
  holds N parts. Pre-existing and identical for delta-fed responses; a cache cost,
  not a correctness one. The multi-part test now pins the merged shape.

## Fix scope as originally assessed

Honest sizing, revised upward from an earlier "~30 lines, one file". Both
transports converge on `processCodexEvents`
([:1661](../../src/services/api/codex-fetch-adapter.ts:1661)), so no separate
subagent or compaction handler is implied, but a complete change needs:

- Recovery keyed by output/content part, not one response-wide "saw a delta"
  flag. The multi-part candidates above are why.
- A precedence order among `output_text.done`, `content_part.done`, and
  `output_item.done`. All 13 records carry `content_part.done`, currently ignored.
- No duplication of terminal text when deltas did arrive, and preserved block
  ordering relative to reasoning and tool blocks.
- `codexEventBeginsVisibleOutput` taught about recoverable terminal text.
  Otherwise done-only responses keep buffering to completion and diagnostics stay
  misleading, which is the same root that produced the withdrawn timing claim.
- Regression coverage, currently absent: a delta-less stream fixture, and a
  multi-part fixture where one part streams and one does not.
- A websocket continuation regression case. The transport retains completed
  output items in `lastResponseOutputItems`
  ([codex-websocket-transport.ts:1234](../../src/services/api/codex-websocket-transport.ts:1234))
  and reconciliation expects non-reasoning items to reappear in the next
  translated input
  ([:753](../../src/services/api/codex-websocket-transport.ts:753)). Recovery
  should restore that equality, not perturb ordering.
- Token accounting must keep using response `usage`, not estimates from recovered
  text.

**Add instrumentation as part of the fix.** Log the recovered text length (and
whether recovery fired) when the terminal path is taken. The central reason this
report cannot close its own impact question is that no payload was ever retained.
The next occurrence should be evidence rather than inference.

## Open questions for whoever fixes this

1. Does `response.output_text.done` actually carry a populated `text` field on
   these responses? Never captured. Settled by the instrumentation above.
2. What causes terminal-only delivery? Unknown, and not answerable from this repo.
3. Did the 225-token case lose a substantial answer? Unsettled.
4. Is the server-side behavior new? The adapter vulnerability is old; the age of
   the trigger is unsettled, partly because `codex_stream_surface` instrumentation
   did not always exist.

## Provenance

Original diagnosis by a Claude Opus session, 2026-08-27. Adversarially reviewed by
gpt-5.6-sol via `cat-code -p` on 2026-08-28, which refuted the trigger claim (the
buffering artifact), the 200-token impact claim, and the confabulation framing.
Refutations verified independently against source before being folded in. The
review's own error about the 70-token record is noted above.
