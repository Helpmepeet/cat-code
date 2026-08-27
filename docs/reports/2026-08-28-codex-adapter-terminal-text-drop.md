# Codex adapter discards assistant text delivered without deltas

Status: loss path CONFIRMED in source. Trigger UNKNOWN. Impact partially unsettled.
Investigated 2026-08-27, corrected 2026-08-28 after an adversarial review by
gpt-5.6-sol that refuted three of the original claims.

## The confirmed defect

The Codex stream adapter surfaces assistant text from exactly one event:
`response.output_text.delta` at
[codex-fetch-adapter.ts:2023](../../src/services/api/codex-fetch-adapter.ts:2023),
and only when the delta is a non-empty string.

`response.output_text.done` has no handler anywhere in the adapter. The
`item?.type === 'message'` branch of the `response.output_item.done` handler at
[codex-fetch-adapter.ts:2190](../../src/services/api/codex-fetch-adapter.ts:2190)
only closes an already-open block, guarded by `if (currentTextBlockStarted)`; it
never reads `item.content`. `response.content_part.done` is likewise ignored.

So when a message item's text arrives only in terminal events, the adapter emits
no text and the assistant message is persisted without it. The turn still
reports `completed: true`. No error, no warning, no log line.

The same file already implements this exact recovery for a different item type:
the `item?.type === 'reasoning'` branch at
[codex-fetch-adapter.ts:2204](../../src/services/api/codex-fetch-adapter.ts:2204)
reads `item.encrypted_content` straight off the done event. Message
canonicalization also extracts `item.content[].text`
([codex-fetch-adapter.ts:884](../../src/services/api/codex-fetch-adapter.ts:884),
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
([codex-fetch-adapter.ts:3155](../../src/services/api/codex-fetch-adapter.ts:3155)),
then replays the entire buffer synchronously
([:3179](../../src/services/api/codex-fetch-adapter.ts:3179)).
`codexEventBeginsVisibleOutput` does not recognize `response.output_text.done`
([:2804](../../src/services/api/codex-fetch-adapter.ts:2804)). A done-only
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
  by the handler at [:2024](../../src/services/api/codex-fetch-adapter.ts:2024)
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
[:2288](../../src/services/api/codex-fetch-adapter.ts:2288) with no content-level
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

## Fix scope

Honest sizing, revised upward from an earlier "~30 lines, one file". Both
transports converge on `processCodexEvents`
([:1645](../../src/services/api/codex-fetch-adapter.ts:1645)), so no separate
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
