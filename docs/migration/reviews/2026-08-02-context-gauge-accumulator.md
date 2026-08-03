# Context gauge reports a lifetime accumulator, not context size

**Date:** 2026-08-02
**Area:** `app/` desktop renderer (P4-24 composer context donut)
**Status:** diagnosed, root-caused, **fixed headless-green 2026-08-02**;
⬜ live GUI acceptance on both providers outstanding. Fix section revised after a
RED review (round 1); see *Review history* and *Implementation* at the end.
**Evidence session:** app `9d74a6cc-8ea7-4bbd-84ec-51b45bbe9bf0` / engine `c5df3243-e6fe-4f48-b255-f916cf5f5e52`
**Reported by:** operator, from a live session reading `48% · 177k / 372k` after five trivial questions

---

## Outcome

The desktop context gauge is wrong. It displays the session's **cumulative token
spend** where it claims to display **current context size**. In the reported
session the engine's own measurement was **29,832 tokens**; the gauge said
**177k**, then **237k** a few minutes later, on a session whose real context
never moved off ~29.8k.

The reading inflates by roughly one full copy of the context per turn, because
`cache_read_input_tokens` is counted on every turn. Cheap turns inflate it as
fast as expensive ones. On a 372k window it pins at 100% after about thirteen
trivial questions.

Auto-compact is **not** affected. Nothing was silently compacted and no context
was lost. The defect is confined to display, plus one warning chip (below).

---

## The defect

`app/renderer/src/contextUsage.ts:81-84` takes the numerator off the latest
`result` frame's `usage`:

```ts
usedTokens =
  readNum(usage.input_tokens) +
  readNum(usage.cache_read_input_tokens) +
  readNum(usage.cache_creation_input_tokens)
```

The module's doc comment (`:13-15`) asserts that field is "the per-turn `usage`
… This is the current context size."

It is not. `result.usage` is `QueryEngine.totalUsage` (`src/QueryEngine.ts:1256`),
an instance field initialised once in the constructor (`:228`) and accumulated on
every `message_stop` (`:916`). It is never reset per turn. The class comment at
`src/QueryEngine.ts:203` states this outright:

> One QueryEngine per conversation. Each submitMessage() call starts a new turn
> within the same conversation. State (messages, file cache, usage, etc.)
> persists across turns.

---

## Evidence: exact reproduction of the reported number

The session JSONL carries a `type:"system"` line per API call with flattened
usage. Accumulating those the way `totalUsage` does reproduces the operator's
screen to the token.

| time | call | tokens | running accumulator | gauge reads |
|---|---|---|---|---|
| 10:37:12 | turn 1 | 29,307 | 29,307 | 8% |
| 10:37:51 | turn 2 | 29,343 | 58,809 | 16% |
| 10:38:25 | turn 3 (`tool_use`) | 29,400 | 88,209 | 24% |
| 10:38:33 | *subagent* | 19,194 | *(excluded)* | 24% |
| 10:38:37 | turn 3 cont. | 29,640 | 117,849 | 32% |
| 10:38:52 | turn 4 | 29,675 | 147,524 | 40% |
| **10:39:34** | **turn 5** | **29,725** | **177,249** | **48%** |
| 10:43:02 | turn 6 | 29,806 | 207,055 | 56% |
| 10:43:17 | turn 7 | 29,838 | 236,893 | 64% |

`177,249 / 372,000 = 48%`, at 10:39:34, the last frame before the operator
raised it. That is the reported `48% · 177k / 372k` exactly, with the subagent
excluded and everything else included. No fitting was applied.

Against that, the engine's own context measurement from the same session's debug
log (`~/.cat-code/debug/c5df3243-….txt`), emitted by
`src/services/compact/autoCompact.ts:376`:

```
10:37:05  autocompact: tokens=1541   threshold=320840 effectiveWindow=352000
10:37:48  autocompact: tokens=29335
10:38:19  autocompact: tokens=29409
10:38:33  autocompact: tokens=29678
10:39:30  autocompact: tokens=29715
10:43:08  autocompact: tokens=29832
```

Flat at ~29.8k throughout. The ~29k is fixed prelude (CLAUDE.md, memory index,
skill listing, MCP tool schemas), not conversation.

---

## Verification performed

Five independent confirmations, each capable of falsifying the diagnosis.

**1. The display chain renders that exact string.**
`App.tsx:3480` → `selectContextUsage` → `ComposerActionsBar.tsx:706-707`, which
emits `{percentUsed}% · {fmtTokens(usedTokens)} / {fmtTokens(contextWindow)}`.
That is the popover the operator read, not the donut tooltip.

**2. The accumulator has exactly two writes in the whole engine.**
`rg 'this.totalUsage = ' src/QueryEngine.ts` returns only `:228` (constructor)
and `:916` (accumulate). Line `:895` resets a *different* variable,
`currentMessageUsage`, at `message_start` — so the code deliberately
distinguishes per-message from lifetime, and the result frame ships the lifetime
one. `accumulateUsage` (`src/services/api/claude.ts:3306`) is plain summation
with no reset path.

**3. The engine really is one per session.**
`src/app-runtime/createQueryEngineAppSession.ts:36` constructs it at factory
time, not per `submitMessage`. `app/sidecar/index.ts:172` calls
`createSidecarSessionController` once at process startup, above the server
construction. Combined with the locked N-process decision (one engine process
per session), `totalUsage` lives exactly as long as the window.

**4. No rewriting between engine and renderer.**
No `usage` mutation anywhere in `app/sidecar/sidecarServer.ts`; raw
`AppSessionEvent` fidelity is a locked decision, so the renderer receives
`totalUsage` verbatim.

**5. The other code path is close to right, and is not affected by this defect.**
`app/sidecar/transcriptRunFacts.ts:83` scans the JSONL backwards and takes the
newest **assistant** message's usage (`:112-116`, `readUsedTokens` at `:189-199`)
— same three input buckets, different frame. For this session that yields
**29,838** against the engine's 29,832.

Consequence: a **previewed** session and the **same session live** disagree by
6×. The preview is the one in the right order of magnitude. That is an
observable, self-contradicting pair inside one build.

**Correction (review round 1, finding 2):** "the preview is correct" was too
strong, and the first draft of this report said so. `readUsedTokens` sums only
the three input buckets; the engine's contract adds `output_tokens` and a
post-anchor estimate (see *Numerator contract* below). At 10:43:17 the preview
formula yields 29,838 where the engine's contract yields **29,961** — a ~123-token
undercount, not a 6× error. The preview path is materially closer than live but
is **not** a finished reference implementation.

**Denominator is correct.** 372,000 is `getContextWindowForModel` for GPT-5.6
(locked by `src/utils/model/gpt56LunaLabel.test.ts:58`). The debug log's 352,000
is `getEffectiveContextWindowSize` = 372,000 − 20,000 reserved for compact output
(`src/services/compact/autoCompact.ts:37-55`). Different numbers for different
jobs, both right.

---

## Root cause

Four compounding factors, not one mistake.

### 1. Two fields named `usage` with opposite semantics

On an **assistant** frame `usage` is per-message. On a **result** frame it is the
session-lifetime total. Same name, same three keys, same types. At the SDK seam
both arrive typed `unknown` (`contextUsage.ts:78-79` says so), so tsc could never
distinguish them.

### 2. Four near-identical usage helpers, one of which is the right one

The doc comment at `contextUsage.ts:15` justifies the formula by citing "the
engine's own `getTotalInputTokens` (`src/utils/tokens.ts:136`)". There are four
helpers of nearly identical shape, three of them in that same file:

| function | formula | what it is for |
|---|---|---|
| **`src/utils/tokens.ts:52` `getTokenCountFromUsage`** | **3 input buckets + `output_tokens`** | **context size. The right one.** Gates the anchor test in `tokenCountWithEstimation` (`:356`). |
| `src/utils/tokens.ts:117` `getDisplayedTokenCountFromUsage` | fresh input + output, **excludes cache reads** | headline "fresh growth" display; doc says it deliberately understates. |
| `src/utils/tokens.ts:136` `getTotalInputTokens` | 3 input buckets | cache-hit-rate **denominator**; doc says so. Only in-repo caller is `getCacheHitRate` (`:145`). |
| `src/bootstrap/state.ts:732` `getTotalInputTokens` | `sumBy(STATE.modelUsage, 'inputTokens')` | session-lifetime total. Same name, different arity. |

The cited helper is the cache-hit-rate denominator. The correct one sits **84
lines above it in the same file**. The formula was copied accurately; the concept
it was borrowed from was never "current context size".

The engine's real context measure is `tokenCountWithEstimation(messages, model)`
(used by the terminal's `ctx: NN%` at
`src/components/PromptInput/Notifications.tsx:94`). It takes the **message
array**, not a usage object. The renderer has no engine message array, so it was
structurally unable to call the right function and had to reconstruct the number
from a frame.

### 3. The trigger: a correct operator correction, resolved against the wrong source

`docs/migration/STATUS.md:375`, the P4-24 row, records the moment:

> **CONTEXT GAUGE — BUILT 2026-07-12 (corrected — the earlier "no wire backing"
> call was WRONG, caught by the operator: Claude Code's `ctx: NN%` proves the
> data exists)**

The build session first concluded the gauge had no data behind it. The operator
corrected them, citing `ctx: NN%` as proof. **The correction was right** — the
concept is real and the terminal displays it. But `ctx: NN%` is computed from the
message array, not from any usage field on the wire. So the corrective evidence
pointed at something that does not exist as a wire field, and the search under
correction pressure settled on the nearest lookalike with the right shape.

The same STATUS row then states the false claim as established fact:

> the latest `result` frame carries BOTH the per-turn `usage` (current context
> size = `input_tokens` + both cache buckets = the engine's own
> `getTotalInputTokens`, `src/utils/tokens.ts:136`)

Wrong in two places ("per-turn", "current context size"). That sentence was
copied verbatim into the code comment, the STATUS row, and the parity ledger,
where it now reads as verified.

### 4. A correct rule, over-generalised

S1 §4 is genuine. From `app/renderer/src/sdkMessageFixtures.ts:128-130`:

> assistant frames ALWAYS serialize `stop_reason:null` + message_start-era usage;
> the engine's later write-back mutates only its own copy. Renderers read
> `message_delta`/`result` instead.

True, and it correctly eliminated the obvious source, leaving the result frame
looking like the only option. But the rule's actual prescription is
**`message_delta` or result** — and `message_delta` was the correct half of that
answer. It got dropped. `contextUsage.ts:18-19` restates the rule as "usage read
from the result layer, never the assistant frames", which is narrower than what
S1 §4 says.

### Near-miss

The author *did* defend against an accumulator, explicitly rejecting
`modelUsage.*Tokens` at `contextUsage.ts:16-19` for exactly the reason that sinks
the field they chose. Having caught one accumulator, the question felt settled.

### One-sentence root cause

The renderer needed a number the wire does not carry; an operator correction
confirmed the number was real without naming its source; and the field that
happened to have the right shape was a lifetime accumulator that no type, test,
or reviewer could distinguish from a per-turn measurement.

---

## Why nothing caught it

- **Tests are structurally blind.** Every fixture in
  `app/renderer/src/contextUsage.test.ts` feeds exactly **one** synthetic
  `result` frame. With one turn, accumulated and per-turn are identical by
  construction. `bun test app/renderer/src/contextUsage.test.ts` → **15 pass /
  0 fail** today, with the defect live.
- **Types cannot help.** `usage` is `unknown` at the seam by design.
- **The number never looks absurd.** It is correct on turn 1, drifts slowly, and
  `contextUsage.ts:109` clamps at 100 rather than exposing an impossible value.

---

## Blast radius

**Affected**

- The composer context donut percentage and tone (`ContextGauge.tsx:20-26`:
  warn at 65%, danger at 90%) — both fire early.
- The `Context` row in the usage popover (`ComposerActionsBar.tsx:706-707`).
- **`app/renderer/src/tokenWarning.ts:67`** — `selectTokenWarning` compares the
  same corrupted number against the engine's *real* thresholds. With
  `threshold = 320,840` and `WARNING_THRESHOLD_BUFFER_TOKENS = 20,000`
  (`src/services/compact/autoCompact.ts:70`), the accumulator crosses 300,840
  around turn 11 at ~30k/turn. The app would then show the amber "Context low ·
  N% remaining" chip and advise `/compact` on a session that is genuinely 8%
  full.

**Not affected**

- Auto-compact itself. `autoCompactIfNeeded` uses
  `tokenCountWithEstimation(messages, model)` (`autoCompact.ts:371`), the engine's
  own measure. No premature compaction, no context loss.
- The preview/backfill path (`transcriptRunFacts.ts`), which is already correct.
- The denominator, which is correct on both paths.
- Billing or cost accounting; this is a display-layer read only.

---

## Fix

**The live path and the disk path legitimately need different sources.** This is
itself part of why the bug was easy to introduce, and it corrects a
first-pass recommendation made during diagnosis (that the live path should mirror
`transcriptRunFacts.ts`).

| path | source | why |
|---|---|---|
| **backfill / preview** (`transcriptRunFacts.ts`) | newest **assistant** frame's `message.usage` | reads JSONL **from disk, after `late_usage_writeback`** has corrected the frames. Correct *frame*; numerator still incomplete (below). |
| **live** (`contextUsage.ts`) | **`message_start` folded with `message_delta`** | per S1 §4 the live wire's assistant frame carries message_start-era usage and the write-back "mutates only its own copy", so it never reaches the renderer. |

### The live source must be a fold, not the newest event

**This corrects the first draft of this report**, which named "the newest
`message_delta`" as the live source. That is unsafe, and would have shipped a
second wrong gauge.

`QueryEngine` builds per-message usage by folding **two** events
(`src/QueryEngine.ts:893-905`):

```ts
if (message.event.type === 'message_start') {
  currentMessageUsage = EMPTY_USAGE                                  // reset
  currentMessageUsage = updateUsage(currentMessageUsage, message.event.message.usage)
}
if (message.event.type === 'message_delta') {
  currentMessageUsage = updateUsage(currentMessageUsage, message.event.usage)
}
```

On Anthropic streams the input and cache buckets arrive on **`message_start`**
and the delta carries output. Reading only the newest delta would drop the input
and cache tokens entirely — precisely the fields that dominate this measurement.

The evidence session masked this because it ran on GPT-5.6. `src/utils/tokens.ts:350-355`
documents the asymmetry directly:

> The Codex adapter seeds usage at {0,0,0,0} on message_start and only fills real
> numbers on the final message_delta/stop.

So the two providers put the numbers in different places, and a Codex-only
diagnosis cannot see it. Any implementation must be tested against **both** shapes.

### Numerator contract

Previously unstated in this report, and the second review finding. The engine's
authority is `tokenCountWithEstimation` (`src/utils/tokens.ts:321-395`):

```
context = getTokenCountFromUsage(anchorUsage) + roughTokenCountEstimationForMessages(after anchor)
```

where `getTokenCountFromUsage` (`:52-59`) is **all three input buckets +
`output_tokens`**.

Both app paths currently omit `output_tokens` **and** the post-anchor estimate.
Checked against the evidence session:

| quantity | value |
|---|---|
| `getTokenCountFromUsage` on the 10:43:02 record (622 + 29,184 + 0 + 23) | 29,829 |
| engine's own reading at 10:43:08, anchored on it | **29,832** (delta 3 = post-anchor estimate of the new user message) |
| `getTokenCountFromUsage` on the 10:43:17 record (654 + 29,184 + 0 + 123) | **29,961** |
| what both app paths compute (input buckets only) | 29,838 |

The engine's number reproduces to within 3 tokens under the full contract. That
is the contract both paths should adopt.

### Proposed change set

1. `app/renderer/src/contextUsage.ts` — derive `usedTokens` by folding
   `message_start` and `message_delta` for the newest message, mirroring
   `currentMessageUsage`; apply the `getTokenCountFromUsage` numerator
   (3 input buckets + output). Keep the existing `contextWindow` resolution
   unchanged (it is correct). Exclude sidechain/subagent frames: the 19,194 row
   in the evidence session is the subagent's own context, not the main thread's.
2. `app/sidecar/transcriptRunFacts.ts` — extend `readUsedTokens` (`:189-199`) to
   include `output_tokens`, so both paths share one contract. The `total > 0`
   guard stays; it is doing real work against the Codex zero-seed.
3. **Alternative worth considering instead of 1+2:** expose an engine-owned
   snapshot rather than reconstructing the measure twice in app code. The
   defect's root cause is that the renderer had to re-derive a number the engine
   already computes; two hand-rolled reimplementations of a four-term formula
   with provider-specific event placement is the same trap set again. This is a
   protocol addition and therefore a larger decision, but it is the option that
   makes the class of bug impossible rather than fixing this instance.
4. `app/renderer/src/contextUsage.test.ts` — add **multi-turn** fixtures, and
   fixtures for **both** provider shapes (Anthropic: buckets on `message_start`;
   Codex: zero-seed start, real numbers on the final delta). A replay of the
   evidence session's sequence is the natural regression test: seven turns must
   read ~30k, not 237k. The single-frame fixtures may stay, but they can no
   longer be the whole suite.
5. Rewrite the `contextUsage.ts` doc comment. The current text asserts the
   false claim and cites a cache-hit-rate helper as authority.
6. `app/renderer/src/tokenWarning.ts` inherits the fix through
   `ContextUsage.usedTokens`; no separate change, but it needs a test that the
   chip stays absent on a long cheap session.

**No protocol, sidecar, or security change.** Renderer-only; the frames are
already on the wire.

**Battery required on fix** (§3): `bun test app/`, `bun run --cwd app typecheck`,
`bun run --cwd app typecheck:sidecar`, `bun run --cwd app test:hardening`,
`bun run --cwd app renderer:build`.

---

## Bookkeeping owed

Not done in this diagnostic pass, and each is a factual correction rather than a
cosmetic one:

- **`docs/migration/STATUS.md:375`** — the P4-24 row asserts the result frame
  carries "the per-turn `usage` (current context size)". False; it must be
  corrected when the fix lands, not left as the program's record.
- **`docs/migration/PARITY-LEDGER.md`** — the context-gauge row is marked built
  on the strength of that claim.
- **STATUS row for the fix session** itself, per §6.

---

## Uncertainty

- **Which calls hit the parent engine's `message_stop`** is inferred from the
  arithmetic landing on 177,249 / 48%, not from instrumenting a running engine.
  The two candidate splits (including or excluding the 159-token meta call at
  10:37:15) give 177,249 and 177,090; both display as `177k` and `48%`, so the
  ambiguity changes nothing. Direct proof would need a live two-turn run with the
  result frame logged.
- **The live fix is designed, not yet exercised.** The fold is read from
  `src/QueryEngine.ts:893-905`; it has not been observed end-to-end in the
  renderer, and the **Anthropic** event shape has not been observed at all in
  this investigation — the evidence session was GPT-5.6 only. A live two-turn run
  on **each** provider is the check, and is the single highest-value verification
  still outstanding.
- **Whether to reconstruct or to expose an engine snapshot** (change-set item 3)
  is unresolved and is a protocol-scope decision, not a renderer one.
- **Turn-11 warning-chip prediction** is arithmetic from the thresholds, not
  observed. Nobody has reported seeing the chip, likely because sessions rarely
  reach eleven turns at a flat 30k before other things change.
- **Behaviour after a compact boundary** was not examined. `totalUsage` does not
  reset on compaction either, so a compacted session should read even further
  from truth, but that was not exercised in the evidence session (no compact
  boundary occurred).

---

## Review history

**Round 1 — 2026-08-02, verdict RED.** Full review:
`docs/migration/reviews/2026-08-02-context-gauge-accumulator-review.md`.

The accumulator diagnosis was upheld. The **fix was rejected**, on two findings,
both independently re-verified against source before this revision:

| # | Sev | Finding | Verified by | Change made |
|---|---|---|---|---|
| 1 | High | Reading only the newest `message_delta` loses input/cache usage; on Anthropic those arrive on `message_start`. | `src/QueryEngine.ts:893-905` folds both events; `src/utils/tokens.ts:350-355` documents the Codex adapter's opposite placement, which is why a GPT-only evidence session masked it. | Fix now specifies a `message_start` + `message_delta` fold, with required test coverage for both provider shapes. |
| 2 | Medium | Both live and preview formulas omit `output_tokens`; the engine's context measure includes it plus a post-anchor estimate. | `src/utils/tokens.ts:52-59` + `:321-395`. Reproduces the engine's 29,832 to within 3 tokens; the app formula undercounts by 123 at 10:43:17. | Added an explicit *Numerator contract* section; extended the change set to `transcriptRunFacts.ts`; softened the "preview is correct" claim in verification item 5. |

Both findings were correct as written. Two consequences beyond the literal fixes:

- The report's own evidence base was **single-provider**. Every number in it comes
  from a GPT-5.6 session, and finding 1 is exactly the class of defect that
  hides in that gap. Provider-shape coverage is now called out as the top
  outstanding verification rather than an implementation detail.
- Two hand-rolled reimplementations of the same four-term, provider-sensitive
  formula is the same trap that produced the original bug. An engine-owned
  snapshot is now recorded as change-set item 3, flagged as a protocol-scope
  decision.

Not changed: `STATUS.md`, `PARITY-LEDGER.md` (still owed, unchanged by this
round), and the diagnosis, evidence, root-cause, and blast-radius sections, which
the review did not contest.

---

## Implementation — 2026-08-02, headless-green

Renderer + sidecar only. **No protocol, preload, or security change**: every
frame the fix reads was already on the wire.

| File | Change |
|---|---|
| `app/renderer/src/contextUsage.ts` | `usedTokens` now folds `message_start` + `message_delta` for the newest MAIN-THREAD message (`foldUsage`, mirroring `updateUsage`'s newest-positive / newest-present rule), with the `getTokenCountFromUsage` numerator (3 input buckets + output). Assistant frames are the replay fallback. `parent_tool_use_id != null` excluded. The `result` frame now supplies the WINDOW only. Doc comment rewritten. |
| `app/sidecar/transcriptRunFacts.ts` | `readUsedTokens` adds `output_tokens`, so preview and live share one contract. |
| `app/renderer/src/contextUsage.test.ts` | Rewritten: 23 tests, both provider shapes, multi-turn. |
| `app/renderer/src/previewTranscriptState.test.ts` | Two fixtures moved off `result.usage` onto assistant usage. |
| `app/sidecar/transcriptRunFacts.test.ts` | +2 tests for the output term. |

**Fails-before / passes-after, actually executed** (temporary revert to the
pre-fix numerator, run, restore): **15 fail** before, **0** after. The two that
matter most:

- `NEVER reads result.usage — it is the session-lifetime accumulator`
- `a long cheap session stays flat instead of climbing ~30k per turn` — a replay
  of this session's real per-call usage. Reads **29,961**; the accumulator it
  must not report is >140,000.

**Battery:**

| Command | Result |
|---|---|
| `bun test app/` | **2324 pass / 0 fail** |
| `bun run --cwd app typecheck` | **clean** |
| `bun run --cwd app test:hardening` | **19/19** |
| `bun run --cwd app renderer:build` | ✓ built |
| `bun run --cwd app typecheck:sidecar` | 1 error, **not mine** (below) |

`typecheck:sidecar` reports `sidecarServer.test.ts(5863,31) TS2339` — a
narrowing failure caused by another session's in-flight widening of the event
union in `app/shared/protocol.ts` (dirty, unowned). My sidecar diff is one added
term plus a comment in `transcriptRunFacts.ts` and cannot reach that union.
Reported unfixed rather than touched, per the shared-tree rule.

### Still unverified

**Live GUI acceptance on BOTH providers.** Every number in this report came from
one GPT-5.6 session, and finding 1 of the review was exactly the defect that
hides in that gap. The Anthropic event shape is covered by fixtures written from
`QueryEngine.ts:893-905`, **not** by observed traffic. Operator steps:

1. Fresh `bun run --cwd app dev`, new session on a **gpt** model. Ask three
   trivial questions. The donut must stay flat (~8% on a 372k window), not climb
   ~8 points per question.
2. Same, on a **claude** model. The donut must show a real non-zero reading
   after turn one, not 0% and not output-only (a few hundred tokens).
3. Preview an old session in the sidebar and compare its donut with the same
   session attached: they must now agree.
