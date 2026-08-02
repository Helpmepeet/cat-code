# Adversarial review: context-gauge accumulator diagnosis

**Date:** 2026-08-02
**Target:** `docs/migration/reviews/2026-08-02-context-gauge-accumulator.md`
**Verdict:** **RED — accept the accumulator diagnosis, rework the fix contract before implementation**

The report proves its central defect: `QueryEngine` retains `totalUsage` for the
conversation, adds the current message at every `message_stop`, and publishes that
lifetime value as `result.usage`. The renderer therefore cannot treat the latest
result as per-turn context. The reported `177,249 / 372,000 = 48%` reconstruction
also matches the evidence transcript, and auto-compact remains independent because
it uses `tokenCountWithEstimation(messages, model)`.

The report is not safe to accept as the fix handoff, however. Its proposed live
source loses input/cache usage for valid Anthropic streams, and both its live and
preview formulas omit output tokens that the engine explicitly includes in full
context. A fix session following the document literally could replace the visible
accumulator with a provider-specific zero/undercount.

## Contract and conformance

| Contract item | Result | Evidence |
|---|---|---|
| Prove the displayed numerator is lifetime usage | **implemented** | `src/QueryEngine.ts:211,228,893-919,1245-1257`; `app/renderer/src/contextUsage.ts:73-98` |
| Reproduce the operator's `48% · 177k / 372k` | **implemented** | Evidence JSONL `codex_send_path.input_tokens` values sum to 177,249 through 10:39:34; denominator 372,000 is in the session's `run_facts` record |
| Bound the runtime blast radius | **implemented** for the live gauge, warning chip, and auto-compact; **partial** for preview accuracy | `app/renderer/src/tokenWarning.ts:60-74`; `src/services/compact/autoCompact.ts:366-385`; F2 below |
| Supply an executable, cross-provider fix design | **partial / unsafe** | F1 and F2 below |
| Define regression proof that fails on the real defect | **partial** | Multi-turn coverage would catch the accumulator, but replaying only the GPT evidence sequence would not catch either finding below |

## Findings

| ID | Severity | Finding | Failure scenario | Owner / disposition |
|---|---|---|---|---|
| **F1** | **High** | The prescribed "newest `message_delta`" source is not a complete per-message usage object on Anthropic streams. | A Claude turn has input usage on `message_start`, then an output-only `message_delta`. Reading the delta alone produces zero input/cache context, so the gauge falls to 0% or a severe undercount after the fix. | **Fix session — react now.** Fold the matching `message_start` usage through the final `message_delta`, mirroring `QueryEngine`'s `currentMessageUsage`, or expose an authoritative engine-owned context snapshot. Add both Anthropic split-usage and GPT full-delta fixtures. |
| **F2** | **Medium** | The report still defines context as only the three input buckets and therefore incorrectly calls the preview path "already correct." | A long model response or post-anchor tool result materially fills the context, but the donut and warning chip omit it. In the evidence transcript the reported preview numerator is 29,838, while that response's full usage is 29,838 input/cache + 123 output = 29,961 before any later-message estimate. Near the warning threshold this can suppress or delay the warning. | **Fix session — react now.** Align the requirement with `getTokenCountFromUsage` / `tokenCountWithEstimation`: include `output_tokens`, and explicitly decide whether the desktop promises last-response full usage or the terminal's estimated current-message-array value. Extend both live and `transcriptRunFacts` tests with non-zero output and post-anchor content. |

### F1 evidence

- The target prescribes the newest raw delta at
  `docs/migration/reviews/2026-08-02-context-gauge-accumulator.md:275-303`.
- A repository-owned realistic Claude sequence puts `input_tokens: 1200` on
  `message_start`, but its final `message_delta` has only `output_tokens: 12`:
  `app/renderer/src/sdkMessageFixtures.ts:1703-1715,1766-1771`.
- `QueryEngine` does not equate the raw delta with per-message usage. It resets and
  seeds `currentMessageUsage` from `message_start`, then merges the delta into that
  accumulator: `src/QueryEngine.ts:893-905`.
- The current recommended test — replaying the GPT evidence session — would stay
  green because the Codex adapter deliberately emits all input/cache buckets on
  `message_delta`: `src/services/api/codex-fetch-adapter.ts:2894-2916`.

### F2 evidence

- The engine's named full-context helper includes output:
  `src/utils/tokens.ts:45-58`.
- The terminal/auto-compact measure anchors on that four-bucket total and estimates
  messages added afterward: `src/utils/tokens.ts:300-307,348-396`.
- Both desktop paths currently sum only input plus the two cache buckets:
  `app/renderer/src/contextUsage.ts:81-84` and
  `app/sidecar/transcriptRunFacts.ts:188-199`.
- The target nevertheless calls the disk path correct at
  `docs/migration/reviews/2026-08-02-context-gauge-accumulator.md:124-132,260-263,275-278`.

## Correctly established claims

- `result.usage` is the lifetime accumulator, not per-turn usage.
- The same long-lived `QueryEngine` handles successive desktop submits.
- The sidecar does not rewrite that usage before the renderer sees it.
- The 372,000 gauge denominator and 352,000 effective compact window serve
  different purposes and are both valid.
- Auto-compact itself is unaffected; the defect reaches display and the derived
  warning chip only.
- Existing context-gauge tests are structurally blind to the accumulator because
  every numerator fixture contains one result.
- No inbound vocabulary, permission boundary, secret handling, or directional
  frame limit is implicated by the current defect.

## Nits

- Label the debug-log block as an excerpt. The source log also contains
  `tokens=27` at 10:38:25 (the subagent) and parent measurements at 10:38:49 and
  10:42:57; "flat throughout" is accurate only after qualifying it as the parent
  context after the initial turn.
- The target's `src/QueryEngine.ts:893-899` citation covers only the
  `message_start` seed. The delta merge is at `:901-905`; both halves are the
  load-bearing reason F1 exists.

## Required acceptance before the fix lands

1. State the numerator contract precisely: last-response full context or the
   terminal's estimated current context. Do not call an input-only value exact
   current context.
2. Exercise at least these live sequences through `selectContextUsage`:
   Anthropic split start/delta usage, GPT full-delta usage, multiple API calls in
   one tool turn, multiple user turns, model switch, and compact-boundary restore.
3. Exercise non-zero output and post-anchor messages in both the live selector and
   `readTranscriptRunFacts`.
4. Keep the existing denominator resolution and prove the warning chip remains
   absent across a long cheap multi-turn sequence.
5. Run the full desktop battery and a two-turn live check. The live check remains
   **UNVERIFIED** in this review; no GUI was driven.

## Verification

```text
VERIFICATION
- bun test app/renderer/src/contextUsage.test.ts app/renderer/src/tokenWarning.test.ts
  -> 23 pass / 0 fail (15 contextUsage cases, 8 tokenWarning cases)
- bun run --cwd app test:hardening
  -> 19/19 passed, production path passed (host-level rerun; sandboxed Electron probe had aborted)
- evidence JSONL jq projection
  -> latest non-zero assistant usage: 29,838 input/cache + 123 output = 29,961 full response context
- source inspection
  -> accumulator, display chain, auto-compact isolation, provider event shapes, and preview formula verified at the anchors above
Stale-reference sweep: N/A — no interface, path, or symbol renamed
Not run: full desktop battery (no implementation changed); live two-turn/GUI proof remains UNVERIFIED
```

Security baseline: **PASS (19/19)**. No protocol or boundary change was made by
this review. STATUS and PARITY-LEDGER were intentionally not edited; review work
is report-only unless the operator asks for bookkeeping changes.
