# Codex context-cost fixes — implementation plan (2026-07-06)

Source analysis: `docs/reports/2026-07-06-context-growth-pipeline-audit.md`
(read the TL;DR, D1/D2, N1/N2, and Investigation round 3 before starting).
This plan is intentionally light: it fixes scope, constraints, and acceptance;
design decisions belong to the implementing session.

Three items, ordered. Each lands as its own commit with its own verification.
Item 1 is independent of the others; 2 and 3 are independent of each other.

Baseline metrics (from the report, for before/after comparison):
- full-send rate on WS transport: ~46% of turns (drift-forced)
- prewarms per conversation: up to 156 (should be ~1)
- uncached share of gpt input: 10.5%
- warm-bust rate: 3.1% of >30k-ctx same-account <10min calls

## Confidence & decision boundaries (read before implementing)

**Proven (source-verified and/or measured; build on these):**
- The three drift mechanisms and their counts; `normalizeToolInput` mutations
  as a fourth source (source-verified by independent review).
- codex-rs drops `logprobs`/`annotations` from protocol types → server
  tolerates replayed items without them.
- `schedulePrewarm` fires on every streaming request and the real request
  awaits it; `clearWebSocketSession` fires on every error path and erases
  `prewarmDone`. Prewarm re-fire counts and ~82% cold rate (measured).
- Nothing prunes gpt history before autocompact on this build.

**Hypotheses (high-confidence but verify before relying on them):**
- `logprobs` is the exact −14 field. Arithmetic fit only; never dumped a raw
  payload. Item 1's implementer confirms it for free by logging one raw
  output item while building the canonicalizer. If it's a different field,
  the canonicalizer design is unchanged — only the commit message is.
- The 156-prewarm pathology is error-path clearing. Mechanism named from
  source; the pathological logs (9962367c, 3f88d40c) not yet checked for
  *which* clear path fired. Item 3 starts there.
- Running recorded arguments through the normalize pipeline eliminates ALL
  541 `tool_input_drift` cases — "likely a large share" per review, not all.
  Acceptance says ≈0; if a residual class appears, report it, don't force it.
- gpt models recover gracefully from 10k truncation (training-parity
  argument). Watch for re-read churn in Item 2's live check.
- WS reconnect → node-affinity cache loss (4–5× correlation; server
  internals unobservable). Items don't depend on this being exactly right.

**Locked decisions (don't relitigate):** canonicalize on both sides and send
exactly what you compare (Item 1 — correctness invariant, not preference);
wire-time truncation, transcript stays full (Item 2); truncation constant
10k ×1.2 (codex parity — changing it later is a cache break).

**Locked-with-escape:** adapter-level truncation hook — switch to the
query.ts:407 fallback only if the adapter hook proves unworkable, honoring
the three traps listed in Item 2.

**Open (implementer's judgment):** head/tail split, marker wording, test
structure, whether prewarm survives anywhere at all (Item 3 rule 1), the
web_search residual.

**Item interactions & landing order:** land 1 → 2 → 3, each measured before
the next. Items 1 and 2 each change wire bytes = one one-time cache break
each on live conversations (unavoidable, note in commits). Item 1 changes
full-send *rate*; Item 2 changes full-send *cost* — measuring Item 2 after
Item 1 keeps the slope numbers clean. Item 3 moves the 3.1% bust baseline,
so it lands last. Correctness-wise the items are disjoint (Item 1 touches
output items, Item 2 touches function_call_output input items, which the
reconciler trusts by length).

**Acceptance tiers:** each item's acceptance below mixes two kinds — treat
grep-able counts, byte-identity dumps, and unit tests as **gates**
(deterministic pass/fail); treat cache-warmth, slope deltas, and bust-rate
trends as **indicators** (directional, server-noise-exposed — record them,
don't block on them).

**Sibling-path audit (all checked):** HTTP fetch transport shares
`translateMessages`/`translateToolResultOutput`, so Items 1–2 cover it by
construction (canonicalization changes its bytes too — part of the one-time
break). Subagent and side-query requests (title gen, summaries) go through
the same adapter — covered automatically, and desirable. `--resume` starts
with no prior response_id → legitimate full send → unaffected; persistence
sweep verified the whole re-entry surface (JSONL round-trip byte-exact for
signatures and Apply_patch input, forks pass live refs, teleport/rewind
byte-stable) and **version skew is safe** — the canonical baseline lives
only in in-memory Maps, so old-build→new-build resume is one full send +
one cache miss, no error loops. Account rotation must DROP continuation
state (Item 3 rule 4) — sessions are keyed by conversation only. Mid-session model switch: gpt→claude sees the full transcript
(Item 2 is wire-only); claude→gpt re-translates fresh — covered. Compact/
snip boundaries surface as "input shorter than canonical baseline" full
sends — listed as legitimate in Item 1 acceptance.

**Must remain unchanged (regression list):** Anthropic-path request bytes
(any change cache-breaks Claude sessions); transcript format and persistence
(resume, /compact, forks read it); Read/Bash/Grep tool behavior and Edit
line-number anchoring; call_id pairing, skipped-tool filtering, and
StructuredOutput stripping in translation; reasoning replay shape
(`summary: []`); ToolSearch results untruncated.

**Known trap:** `codex-fetch-adapter.ts` has TWO `translateToolResultOutput`
definitions — the module-level one at :625 is dead (shadowed); the live one
is the closure at :704 inside `translateMessages`. Hook the live one; delete
the dead one in passing.

**Pre-existing resume divergences (context, not yours to fix):** resume
deserialization drops some messages that were sent live (unresolved
tool_uses, orphaned thinking-only messages, whitespace-only assistants —
`messages.ts:5113-5170, :4997`), so a resumed session may legitimately take
one cache break at the divergence point independent of Items 1–2. Item 2's
byte-identity acceptance is about truncation stability across resume, not
about eliminating these.

---

## Item 1 — Canonicalize the Codex item round-trip (kills drift-forced full sends)

**Problem.** The WS transport only sends an incremental delta when freshly
translated input byte-matches the server-recorded output items
(`src/services/api/codex-websocket-transport.ts` — `reconcileCanonicalDelta`,
`diagnoseMismatch`, `normalizeCompletedOutputItem`). Three systematic drifts
force full sends:

1. `message_content_drift len_delta=-14` (3,648 occurrences): server output
   items carry a `logprobs` field on `output_text` content parts; the replay
   path (`translateMessages` in `src/services/api/codex-fetch-adapter.ts`,
   assistant-text branch) rebuilds parts as `{type, text, annotations: []}`.
2. `type_mismatch custom_tool_call → function_call` (378): Apply_patch replay
   emits `custom_tool_call` only when the stored `tool_use.input` is still a
   string; the transcript stores it parsed.
3. `tool_input_drift` (541): re-serialized `arguments` JSON differs from what
   was originally sent.

**Goal.** One canonical item shape, produced identically at record time and
replay time, so `responseItemsEqual` passes on unchanged history.

**Design decision (do it this way).** One canonicalizer function
(`canonicalizeCodexItem()` or equivalent) in the adapter layer, applied on
BOTH sides: `normalizeCompletedOutputItem` runs it on server output items at
record time, and the replay path runs it on `translateMessages` output. The
request must send exactly the canonical form — never compare one shape and
send another. Canonical shapes:

- `message` → `{type, role, content: [{type: 'output_text', text,
  annotations: []}], status: 'completed'}` — drop `logprobs` and any unknown
  fields (upstream-validated: codex-rs protocol types don't have them and the
  server tolerates their absence).
- `function_call` → `{type, call_id, name, arguments}`. **Caution — naive
  `JSON.stringify(JSON.parse(raw))` is NOT sufficient**, and neither is
  blindly re-running the normalize pipeline. Sweep-verified equivalence: the
  transcript already holds `normalizeToolInput(raw)` (applied ONCE at decode
  time, `messages.ts:2733`), and the send path applies
  `normalizeToolInputForAPI` on top (`messages.ts:2222`). So: **record side
  = compose `normalizeToolInput` then `normalizeToolInputForAPI` on the raw
  server arguments, exactly once, in the same turn as decode** (the pipeline
  is impure — depends on `getCwd()`, provider, plan state, and double-apply
  is unsafe: unanchored `cd`-strip eats legit second `cd`s, and it fires
  telemetry/remote-snapshot side effects — suppress or bypass those on the
  record-side application). **Replay side = deterministic stringify only**,
  no re-normalization on later turns.
- Apply_patch → emit `custom_tool_call` **unconditionally** for that tool
  name. Sweep nuance: the stored input is a union — usually the
  `{input: raw}` wrap from unparseable envelopes (`messages.ts:2706`;
  recover raw from `block.input.input`), but a valid-JSON `{ops: [...]}`
  arm exists (`FilePatchTool/types.ts:126-135`). Define the `{ops}` fallback
  explicitly (keep `function_call` for that arm is acceptable — it's
  self-consistent on both sides as long as record and replay agree).
- `reasoning` → `{type, summary: [], encrypted_content}` (already canonical).

**Constraints.**
- The bytes the client sends must stay stable turn-over-turn (prompt-cache
  prefix stability). Changing the canonical shape is itself a one-time cache
  break for live conversations — acceptable, note it in the commit message.
- Don't alter server-visible semantics (call_ids, text content, ordering).

**Accepted residual.** `web_search_call` output items have no replay branch
in `translateMessages` — a web-search turn forces one full send on the next
turn. Leave it (rare) unless trivially fixable in passing; name it in the
commit message.

**Acceptance.** In a real gpt session (~20 turns with text + Apply_patch +
tool calls): `grep -F '[codex-ws] full send' ~/.cat-code/debug/<session>.txt`
shows full sends only for legitimate reasons (first send, stale response id,
"non-input request fields changed", "input shorter than canonical baseline",
web_search residual); `message_content_drift`, the custom_tool_call
`type_mismatch`, and `tool_input_drift` each ≈ 0. Existing transport tests
pass; add a regression test for the record→replay round-trip of each item
kind, including normalized tool inputs (Bash cd-strip, Grep key-rename).

---

## Item 2 — Record-time truncation of tool results, gpt models only

**Problem.** Report D2 + C1: nothing trims history on the Codex path before
autocompact (~229k). Codex CLI middle-truncates every function/custom tool
output to Tokens(10,000) ×1.2 at record time — gpt models were trained in
that environment. Cat-code re-bills the untrimmed history on every cache miss
(N1/R1: ~3.1% of warm calls).

**Goal.** Tool results entering gpt-model request history are middle-truncated
to ~10k tokens, with the full output preserved on disk and the truncation
notice telling the model how to retrieve more (path + offset/limit re-read),
in the spirit of codex's `truncate_function_output_payload`.

**Design decision (do it this way).** Truncate at **wire time, inside the
Codex translation layer** — the `translateToolResultOutput` path in
`src/services/api/codex-fetch-adapter.ts`, the single choke point both the
fetch and WS transports share. NOT in query.ts, NOT in the transcript.
Rationale: the transcript stays full (mid-session switch back to a Claude
model sees untruncated history; `--resume` is byte-stable by construction),
provider scoping is automatic (only Codex requests pass through), and
determinism is free because truncation is a pure function of content.
Policy mirrors codex: token budget 10,000 ×1.2 serialization allowance,
char-approximated at 4 bytes/token (~48k chars), middle-truncate (keep head
and tail, marker in the middle). The marker must be deterministic — no
timestamps, no counters that change across requests — and must NOT require
persisting anything new (the translation layer is synchronous; review
confirmed disk writes can't happen there). That's fine: Read results already
reference a file the model can re-Read with offset/limit; Bash/Grep can be
re-run narrower — the marker says so.

Fallback if the implementer finds the adapter hook unworkable: the
`applyToolResultBudget` slot at query.ts:407 is also wire-time (review
confirmed it rewrites only `messagesForQuery`; the transcript keeps full
content, only decision *records* persist). If that route is taken instead:
do NOT inherit its `tengu_hawthorn_steeple` gate (default false — the gpt
truncation must be on by default for openai provider), do NOT inherit the
`skipToolNames` exemption (it exempts Read via `maxResultSizeChars:
Infinity` — Read is the main offender), and add a new provider-scoped
record `kind` rather than overloading the existing one.

**Constraints.**
- Scope: `provider === 'openai'` requests only; Anthropic path untouched.
- Exempt: image blocks, results under the cap, and ToolSearch results
  (schema-bearing; truncating them can break deferred tool loading — note
  codex likewise exempts its ToolSearchOutput variant).
- **gpt→claude switch understates context (sweep finding — must handle).**
  `tokenCountWithEstimation` anchors on the last API usage; after running on
  gpt (truncated wire), a mid-session switch to a Claude model sends the
  FULL transcript while the anchor still reflects truncated sizes —
  warnings/autocompact fire late and the first Claude request can 413.
  Handle it: on provider switch away from openai, invalidate the usage
  anchor (force full re-estimation) or equivalent. Claude→gpt is safe.
- Marker wording must explicitly instruct re-reading with offset/limit (Edit
  fails closed — `old_string` matches against disk — but the model must
  know the middle was elided; see sweep finding on readFileState marking
  files fully read regardless of wire truncation).
- Ordering with Item 1: on the WS transport, `reconcileCanonicalDelta`
  trusts the previous-input region by length only, so truncation doesn't
  fight incremental comparison — but the truncated form must be identical
  across turns for full-send prefix stability (pure-function property covers
  this). Changing the budget constant later = one-time cache break; pick the
  constant once.
- Do NOT change Read tool defaults, `cat -n` framing, or Bash/Grep caps.

**Accepted residuals (sweep-verified, don't chase):** the un-anchored tail
of `tokenCountWithEstimation` estimates fresh giant tool_results at FULL
size until the next usage arrives, so autocompact can fire one turn early on
exactly the turns truncation defuses — transient and self-correcting.
`/context`'s per-category breakdown estimates from full content and will
read higher than the meter — cosmetic. Verified SAFE by sweep: /compact
(summarizer goes through the same adapter → sees the same truncated view),
PROMPT_CACHE_BREAK_DETECTION (byte-stable replays; one false warning at
rollout), changed_files/diagnostics attachments (re-read from disk, never
quote stored tool_results).

**Acceptance — gates:** a gpt session that Reads a >100KB file shows the
truncated form with a working retrieval hint in the wire request (debug
dump); across turns and across `--resume`, the wire bytes for old history
are **byte-identical** (debug dump, NOT cache-warmth — warmth is
server-dependent per report R1); headless suite green; unit test for the
truncation function (deterministic, marker stable, exemptions honored).
**Indicators:** next-turn cache-warmth; median Δ/call on a read-heavy
session vs the 0.5–2.4k baseline; watch for re-read churn (model repeatedly
re-fetching truncated content = the failure mode).

---

## Item 3 — Diagnose WS session recreation (then gate prewarm)

**Problem.** R1/R2: a WS connection event between two calls raises bust risk
4–5×, and prewarm re-fires on session recreation — some conversations show
~1 prewarm per turn (9962367c: 156, 3f88d40c: 102; debug files in
`~/.cat-code/debug/`). Each recreation risks a full-context re-bill and each
prewarm bills the prefix again (82% of prewarms land cold; only 61% deliver
a warm first call).

**Root cause (named by source review — verify, then fix).**
`clearWebSocketSession` deletes the session object — the only home of
`prewarmDone` — and it fires on **every error path**: the adapter's
catch-all on any wsError including HTTP-fallback cases
(`codex-fetch-adapter.ts:3011-3012`), `response.failed`, the 90s idle
timeout, `onerror`, and send-throws. Meanwhile `schedulePrewarm` is called
on **every** streaming request (`codex-fetch-adapter.ts:2984`), and the real
request *awaits* the prewarm before sending (transport `:377-379`) — so on
this call path prewarm never warms anything ahead of time; after any
session-clearing event, the next turn pays prewarm + real request
back-to-back. One clear per turn ≡ one prewarm per turn (the 156×
pathology). Exonerated by the same review: `createRequestSignature`
mismatch only resets continuation state on the open connection (does not
recreate sessions or refire prewarm); account-rotation reconnect preserves
`prewarmDone`; the `sessions` map is per-conversation (no contention).
Verify the pathological logs (9962367c, 3f88d40c) show error-path clearing,
then fix.

**Fix shape (decided rules, sweep-hardened).**
1. **Remove the per-request `schedulePrewarm` call** (adapter ~:2984) —
   sweep-verified safe: `prewarmPromise`/`prewarmDone` have no consumers
   outside the transport, the send-path logger skips prewarm turns, and
   upstream codex-rs prewarns **once at session startup**, not per request
   — the per-request scheduling is a local deviation. Only cost: the
   first-turn prefix seed (~22k), which the first real call pays anyway.
   If ahead-of-time warming is wanted later, add it at session startup like
   upstream, gated once.
2. **Keeping session state on transient errors is allowed ONLY with both
   invariants (sweep findings):**
   a. The **physical socket must still be closed/replaced** on error paths —
      `onMessage` has no response-id correlation, so an open socket bleeds
      late events from the aborted turn into the next turn's handler. Keep
      the state, kill the socket; the existing reconnect-preserve path
      (transport `:303-317`) already carries continuation + `prewarmDone`
      across a socket swap — reuse that pattern.
   b. **Baseline reset on ANY chained-request rejection**, not just the
      current `msg.includes('not found')` check (`:920-936`). Today any
      other server rejection of a `previous_response_id` chain becomes a
      generic WS error → 60s sticky HTTP fallback → baseline never reset →
      recurring degrade loop. Reset `lastResponseId`/`lastRequestInput`/
      `lastResponseOutputItems` on every server error event so the next
      send is a full send, never a poisoned incremental.
3. Session teardown remains for genuinely terminal cases (60-min limit,
   `sessionTitle`'s throwaway-conversation cleanup — both verified
   legitimate). `response.failed` clears can convert to state-preserving
   per rule 2 (the baseline only commits on `response.completed` —
   retry-sweep-verified atomic; a failed attempt's output items are
   attempt-local and discarded — so a failed turn leaves the previous
   *good* baseline, valid to chain from).
4. **Account rotation is NOT transient (retry sweep).** On
   `CodexAccountCapError`/`CodexAccountAuthError` failover, drop the
   continuation state: `sessions` is keyed by conversationId only, so a
   preserved baseline makes account B's first request chain account A's
   `previous_response_id` — recovery then gambles on the server's error
   wording matching `'not found'`. Keep clearing (or null the baseline) on
   rotation paths specifically.
5. **The socket invariant extends to aborts (retry sweep).** Esc-abort never
   records state (safe), but no `response.cancel` is sent and the server
   keeps streaming the dead turn on the open socket — under longer-lived
   sockets, an immediate next turn can ingest the dead turn's late
   `response.completed` and poison the baseline (`onMessage` has no
   response-id filter). Fix alongside rule 2a: close/replace the socket
   after aborted turns too, or filter inbound events by response id.
   Retry-sweep also verified: the withRetry stack never reads WS state
   (safe), mid-stream errors set 60s sticky HTTP fallback so the immediate
   retry usually bypasses WS (the bleed window is the post-sticky turn),
   and prewarm removal is retry-invisible (prewarm errors are swallowed,
   never trigger rotation; the lock-region wait becomes a no-op).

**Acceptance.** In a normal multi-hour gpt session: prewarm count per
conversation ≤ 2 (`grep 'startup prewarm complete' debugfile | count`), no
`session cleared`/`connected for` cycles between ordinary turns, and the
warm-bust rate re-measured over a few sessions trends below the 3.1%
baseline (measurement scripts and grep keys are described in the report's
round-3 section).

---

## Test surface (sweep-inventoried; update alongside, don't discover mid-work)

- **Will break mechanically:** `codex-websocket-transport.test.ts` — three
  prewarm tests (:177, :195, :236) pin the current handshake; if
  `schedulePrewarm` is removed, also the import at :11.
  `codex-fetch-adapter.test.ts` — six tests hard-code the prewarm batch as
  `responseBatches[0]` (:1633, :1676, :1713, :1764, :1845, :2125) plus
  send-count asserts (:2149, :2166). These are the de-facto spec of the old
  lifecycle — update them in the Item 3 commit or they pin the bug.
- **Silently goes stale:** `codex-continuation-e2e.test.ts` reimplements the
  canonical contract locally (`simulateCanonicalState` :98, `canonicalDelta`
  :115) instead of importing it. Item 1 must export the real canonicalizer
  and rewrite those helpers to consume it — otherwise the file keeps passing
  while testing nothing.
- **Coverage gap = the bug was untested:** no existing test includes
  `logprobs`-bearing server items, parsed Apply_patch input, or
  unnormalized arguments (all inline fixtures are already canonical; no
  fixture files to regenerate). Item 1's new round-trip tests must add
  exactly those inputs. Pattern source for the normalize pipeline:
  `providerPromptRegressions.test.ts` (:77 Grep round-trip, :169 Apply_patch
  raw-input preservation — keep both as-is, they're correct).
- **Manual:** `scripts/test-codex-stream-tool-call-ids.ts` (standalone, not
  in the headless suite) — re-run after Item 1.
- **No DCE/feature() cliffs** in any touched file (the toolResultStorage:997
  cliff note concerns AgentTool.tsx, not these).

## Explicitly out of scope

- Tool-schema prose trim (D1) — worthwhile, separate effort.
- `<available-deferred-tools>` delta flag, effort-switch guidance, live
  eviction probe — see report action list.
- Any change to Anthropic-path behavior, Read defaults, or pruning flags.
