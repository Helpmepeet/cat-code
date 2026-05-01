# Remove visible-thinking dependence

## Summary

There **is** real visible-thinking dependence in this workspace today, and it is not just prompt wording or UI.

The most important finding is that the OpenAI/Codex path currently **adapts GPT reasoning into Anthropic-style `thinking` blocks** in `src/services/api/codex-fetch-adapter.ts`, and the rest of the shared stack then treats those blocks as real conversation state. That creates the exact failure mode this Phase 0 item is trying to remove: GPT reasoning, which should be internal or provider-managed, is surfaced as visible thought text and then preserved, replayed, compacted, token-counted, and treated as continuity state.

By contrast, most of the Anthropic-side visible-thinking handling is legitimate provider-native behavior: Claude thinking blocks are treated as model-visible state because Claude’s tool continuity rules require preserving them.

So the design recommendation is **not** “remove all thinking support.” It is:

- keep Claude-native thinking continuity on Claude-capable providers
- stop synthesizing GPT reasoning into Anthropic `thinking` blocks
- move reasoning continuity behind a provider-aware state contract
- make shared subsystems reason about an abstract continuity policy instead of hard-coding `thinking` blocks as universally meaningful state

## Relevant files

### Required design context
- `docs/reports/2026-04-30-research-provider-differences.md`
- `docs/vision/2026-04-30-GOAL_PLAN.md`

### Provider dispatch and prompt assembly
- `src/utils/model/providers.ts`
- `src/services/api/instructionAssembly.ts`
- `src/services/api/claude.ts`
- `src/services/api/codex-fetch-adapter.ts`

### Actual visible-thinking state handling
- `src/query.ts`
- `src/QueryEngine.ts`
- `src/utils/messages.ts`
- `src/services/compact/apiMicrocompact.ts`
- `src/services/compact/microCompact.ts`
- `src/services/compact/sessionMemoryCompact.ts`
- `src/services/tokenEstimation.ts`

### User-facing/UI-only handling
- `src/components/Messages.tsx`
- `src/components/Message.tsx`
- `src/main.tsx`
- `src/utils/thinking.ts`

## Separation of concerns

### 1. User-facing reasoning guidance

These are about presentation or user controls, not state continuity by themselves:

- `src/main.tsx`
- `src/utils/thinking.ts`
- `src/components/Messages.tsx`
- `src/components/Message.tsx`
- transcript/stream rendering in `src/utils/messages.ts:2963`

Examples:
- thinking enabled/disabled defaults
- UI stream mode switching to `thinking`
- transcript display of completed thinking blocks
- highlighting `ultrathink`

These can stay provider-aware, but they are not the core architectural problem.

### 2. Internal prompt and request rules about thinking

These are internal protocol assumptions and API-shaping logic:

- `src/services/api/claude.ts` builds Claude requests with `thinking` params and parses `thinking` / `thinking_delta` blocks
- `src/query.ts:160` documents “rules of thinking” that assume assistant trajectories may contain preserved thinking blocks
- `src/utils/messages.ts` contains normalization rules to keep assistant messages valid when thinking blocks are present
- `src/services/tokenEstimation.ts` enables thinking in token-count requests when messages contain thinking/redacted thinking blocks

Some of this is valid only for Claude-like providers. The problem is that it currently sits in shared paths and is triggered by the presence of `thinking` blocks regardless of provider origin.

### 3. Actual state continuity assumptions

This is where visible-thinking dependence exists today.

#### A. GPT reasoning is converted into visible `thinking` blocks

`src/services/api/codex-fetch-adapter.ts`

The adapter currently:
- requests OpenAI reasoning summaries/deltas via `reasoning: { effort, summary: 'auto' }`
- listens for `response.reasoning.delta`
- emits Anthropic-format streaming events with `content_block: { type: 'thinking' }`
- emits `thinking_delta` deltas

That means the shared Anthropic-shaped pipeline receives GPT reasoning as if it were Claude thinking.

This is the most direct visible-thinking dependence on the GPT path.

#### B. Shared query logic assumes thinking blocks are continuity state

`src/query.ts:160-163`

The documented rules explicitly state:
- a message with thinking/redacted_thinking must be part of a query with thinking enabled
- thinking blocks must be preserved for the duration of an assistant trajectory

That is a Claude-native rule expressed as a general invariant.

#### C. Session-memory compaction preserves thinking as replayable state

`src/services/compact/sessionMemoryCompact.ts:188-313`

This file explicitly adjusts retained history so that thinking blocks sharing the same `message.id` are preserved and can be merged back by `normalizeMessagesForAPI`. The comments explicitly describe lost thinking blocks as an API invariant violation / continuity problem.

That is real state dependence, not just display logic.

#### D. API microcompact explicitly preserves prior thinking turns

`src/services/compact/apiMicrocompact.ts:77-87`

This code adds native context edits to preserve thinking blocks in prior assistant turns via `clear_thinking_20251015` with `keep: 'all'` or a retained number of thinking turns.

This is provider-native for Claude, but it should not run because GPT reasoning happened to be re-encoded into Anthropic `thinking` blocks.

#### E. Token estimation changes behavior when thinking blocks are present

`src/services/tokenEstimation.ts:36-56`, `148-186`, `255-317`

The token-estimation path detects `thinking` / `redacted_thinking` blocks and changes API parameters and fallback model choice accordingly. Once GPT reasoning has been translated into visible thinking blocks, token counting also starts treating GPT conversations as Claude-thinking conversations.

#### F. Message normalization and replay are built to carry thinking blocks forward

`src/utils/messages.ts` and `src/QueryEngine.ts`

Relevant behaviors include:
- merging assistant fragments that share a `message.id`
- preserving / stripping thinking blocks to maintain API validity
- handling tombstones for partial assistant messages because thinking-block signatures become invalid if replayed incorrectly
- replay-related logic depending on normalized messages that may include thinking blocks

These are not all wrong. They are wrong only when applied to providers that do not use visible thinking as continuity state.

## Current dependence findings

### What is merely shared wording or UX

Not a core dependency:
- thinking toggles and display affordances
- “ultrathink” keyword behavior
- UI rendering of thinking mode
- transcript display of visible thinking

Those may still need cleanup, but they are not what silently breaks GPT.

### What is a true dependence today

There are two separate realities in the code:

1. **Claude-native visible-thinking continuity**
   - legitimate on Anthropic paths
   - preserved in compaction, normalization, token counting, and request assembly

2. **GPT-visible-thinking emulation**
   - not provider-native
   - introduced by `src/services/api/codex-fetch-adapter.ts`
   - then accidentally promoted into shared continuity state by the rest of the pipeline

So the honest answer is:

- **Yes, the workspace depends on visible thinking as state today.**
- The dependence is **partly intentional and correct** for Claude.
- The dependence is **incorrect and dangerous** on the GPT path because the adapter currently manufactures visible thought blocks from GPT reasoning deltas.

## Design recommendation

## Goal

Replace “thinking blocks are state” with:

- **Claude path:** preserve native thinking blocks only where Claude requires them for continuity
- **GPT path:** do not create or replay visible thought text as state; use provider-native continuity mechanisms instead

## What can be deleted entirely

### 1. GPT → Anthropic `thinking` translation in the Codex adapter

Delete the OpenAI-path behavior that converts `response.reasoning.delta` and reasoning items into Anthropic `thinking` blocks.

Specifically in `src/services/api/codex-fetch-adapter.ts`:
- stop emitting `content_block_start` with `type: 'thinking'` for GPT reasoning items
- stop emitting `thinking_delta`
- stop closing synthetic reasoning blocks as if they were assistant-visible content blocks

This should be treated as the primary removal target.

### 2. Any GPT-path reliance on visible-thinking-specific token handling

Once GPT no longer yields synthetic `thinking` blocks, GPT sessions should stop falling into Claude-specific token-estimation and message-normalization behavior merely because reasoning occurred.

That means some current “support GPT by pretending it is Claude thinking” behavior can disappear naturally after the adapter change rather than being replaced one-for-one.

## What needs provider-specific behavior

### A. Request/response reasoning surface

#### Claude provider behavior

In `src/services/api/claude.ts`:
- continue sending Claude-native `thinking` config when enabled
- continue accepting native `thinking` / `redacted_thinking` blocks
- continue preserving those blocks across tool turns where Claude requires continuity

#### GPT provider behavior

In `src/services/api/codex-fetch-adapter.ts` or a new provider-native response adapter layer:
- do **not** surface GPT reasoning as transcript content blocks
- treat GPT reasoning as provider-managed internal state
- if the integration needs inspectable continuity metadata, use a provider-native non-transcript carrier such as:
  - reasoning summaries
  - encrypted reasoning items
  - conversation or response IDs / server-managed continuity objects

Which exact mechanism to use can vary. The important rule is that the GPT path must not emit replayable visible thought text and must not require it downstream.

### B. Continuity policy / dispatch

The dispatch should live at the boundary where provider-native responses enter shared conversation state.

Recommended location:
- introduce a small provider-aware continuity policy near `src/services/api/claude.ts` + `src/services/api/codex-fetch-adapter.ts`, or a sibling module such as `src/services/api/reasoningContinuity.ts`

Suggested abstraction:
- `getReasoningContinuityPolicy(provider)` returns something like:
  - `mode: 'visible-thinking'` for Claude-capable providers
  - `mode: 'provider-managed'` for OpenAI/GPT
- optional capabilities:
  - `preserveVisibleThinkingInHistory`
  - `preserveAcrossToolTurns`
  - `supportsVisibleThinkingDisplay`
  - `supportsReasoningSummary`
  - `supportsEncryptedReasoningState`

This lets shared code ask “how should continuity work for this provider?” instead of “does this message contain thinking blocks?”

### C. Compaction and session-memory behavior

#### Claude provider behavior

These can remain, but should be explicitly gated by continuity policy rather than raw block presence:
- `src/services/compact/apiMicrocompact.ts` thinking preservation edits
- `src/services/compact/sessionMemoryCompact.ts` logic to keep assistant fragments with shared `message.id` because they contain native thinking blocks
- `src/services/tokenEstimation.ts` enabling thinking for token counts when native Claude thinking blocks are present

#### GPT provider behavior

For GPT:
- no visible-thinking preservation in compaction
- no replay requirements based on thinking blocks
- if long-running continuity is needed, preserve provider-native continuity artifacts separately from transcript content
- compaction should operate over user-visible text, tool calls/results, summaries, and provider-native opaque continuity state if available

That opaque continuity state should **not** be normalized as visible assistant text blocks.

## Where dispatch should live

### Primary dispatch point: provider-native response adaptation

Best place:
- `src/services/api/codex-fetch-adapter.ts`

Reason:
- this is where GPT reasoning is currently converted into Anthropic `thinking`
- removing the conversion here prevents the wrong abstraction from contaminating all downstream shared systems
- this is also the right place to define the GPT continuity contract explicitly, instead of implicitly relying on synthetic visible reasoning

For the GPT path, the implementation should make an explicit choice about continuity carrier. The report does **not** require a specific mechanism, but it should not be left undefined. Candidate carriers include:
- provider-managed conversation/session state already used by the adapter (for example the existing session/conversation headers)
- response-linked continuity such as response IDs if the integration moves in that direction later
- encrypted reasoning items or reasoning summaries where available

The critical requirement is that GPT continuity be represented as a provider-native mechanism, not as transcript-visible `thinking` text.

### Secondary dispatch points: shared systems that currently infer semantics from block types

These should be updated to consult provider policy or a per-message/session continuity flag instead of assuming `thinking` means universally replayable state:

- `src/services/compact/apiMicrocompact.ts`
- `src/services/compact/sessionMemoryCompact.ts`
- `src/services/tokenEstimation.ts`
- `src/query.ts`
- `src/utils/messages.ts`

The minimum viable refactor is:
1. stop creating GPT `thinking` blocks
2. gate Claude-only preservation logic behind provider-aware checks

That may be sufficient for the first implementation slice.

## Shared vs provider-specific behavior

### Can remain shared across providers

These concepts are still shared:
- general conversation history management
- tool call / tool result continuity
- message normalization for user-visible content
- compaction as a concept
- prompt prefix discipline
- user-facing progress updates
- abstract “reasoning effort” controls if mapped per provider

### Must differ by provider

These must no longer be shared blindly:
- whether reasoning is represented as visible transcript content
- whether reasoning text must be replayed for tool continuity
- whether compaction must preserve prior thought blocks
- whether token counting must enable provider thinking mode because transcript contains reasoning blocks
- whether response streaming emits visible reasoning deltas

In short:
- **shared:** orchestration goals
- **provider-specific:** reasoning continuity representation

## Risks

### 1. UI regressions on GPT

If the current UI depends on synthetic `thinking` blocks to show “thinking” activity for GPT, removing them may make GPT feel quieter or less informative.

Mitigation:
- separate “progress/status UI” from transcript reasoning state
- if needed, show provider-native status such as “reasoning” or “working” without storing transcript text
- explicitly verify remote-session and log-tail views, not just the main transcript UI, because parts of the remote session surface currently assume assistant/tool/progress shape derived from normalized messages

### 1b. Missing GPT progress/orchestration semantics

The current investigation focused on visible reasoning text, but GPT long-running workflows also rely on provider-native orchestration cues such as progress/commentary vs final output semantics. If synthetic `thinking` is removed without an alternative progress signal, the product may lose the only visible “working” cue on GPT.

Mitigation:
- keep progress/status handling separate from reasoning transcript state
- audit whether GPT needs a provider-native progress/commentary path distinct from both final text and tool calls

### 2. Hidden coupling in normalization or replay

Some shared utilities may implicitly assume that assistant fragments with shared `message.id` should always be preserved together because of thinking.

Mitigation:
- audit uses of `thinking` / `redacted_thinking` in `src/utils/messages.ts`, `src/query.ts`, and compaction modules after the adapter change
- convert Claude-only invariants into provider-gated invariants

### 3. Token/accounting drift after removing synthetic thinking

Removing GPT thinking blocks changes token-estimation paths and may alter compaction thresholds or debug expectations.

Mitigation:
- compare token estimation and compaction triggers before/after on GPT sessions
- ensure GPT path uses provider-native usage accounting rather than transcript-derived thinking assumptions
- verify warning timing, replay-after-resume behavior, and auto-compact thresholds, not just raw token counts

### 4. Telemetry/tracing contract drift

Some telemetry/tracing contracts still carry Claude-shaped concepts such as `thinkingOutput` even when the implementation is currently a noop in OSS.

Mitigation:
- audit tracing/logging contracts so GPT does not emit misleading empty reasoning fields or lose progress observability entirely
- treat progress/status telemetry separately from visible-thinking transcript capture

### 5. Losing useful GPT continuity if no replacement exists

If the system really needs cross-turn reasoning continuity for GPT in some flows, deleting synthetic thinking without introducing a provider-native carrier could reduce performance in long-running tasks.

Mitigation:
- first confirm whether current GPT performance actually depends on replayed synthetic reasoning text
- if continuity is needed, add a provider-native carrier explicitly rather than reusing transcript content

## Suggested next implementation slice

### Slice 1: remove the wrong abstraction at the ingress point

1. Change `src/services/api/codex-fetch-adapter.ts` so GPT reasoning is no longer emitted as Anthropic `thinking` blocks.
2. Keep GPT text output and function-call translation intact.
3. Preserve any provider-native reasoning metadata only in a non-transcript form if needed.

### Slice 2: gate Claude-only continuity logic

Update the following to run thinking-preservation logic only for providers that actually use visible thinking as state:
- `src/services/compact/apiMicrocompact.ts`
- `src/services/compact/sessionMemoryCompact.ts`
- `src/services/tokenEstimation.ts`
- `src/query.ts`
- relevant `src/utils/messages.ts` paths

### Slice 3: restore non-transcript UX for GPT if needed

If users still want a “model is reasoning” signal on GPT:
- add a provider-native status indicator
- optionally store reasoning summaries or opaque continuity artifacts out-of-band
- do not inject them as assistant-visible transcript content blocks

## Verification plan

To verify the system no longer depends on visible thinking as state:

### 1. GPT transcript verification

Run a GPT/Codex session with tool use and confirm that:
- no assistant `thinking` blocks are created from GPT reasoning
- no `thinking_delta` events are emitted on the GPT path
- the visible transcript still contains final text and tool calls/results correctly

### 2. Replay/continuity verification on GPT

Exercise a multi-turn GPT workflow with tools and confirm that:
- follow-up requests do not include replayed visible reasoning text
- tool continuity still works via call IDs / provider-native conversation state
- compaction does not preserve or require visible `thinking` blocks

### 3. Claude regression verification

Run the same style of workflow on Claude and confirm that:
- native thinking blocks still work when enabled
- tool-use continuity is preserved
- compaction still preserves Claude-required thinking state

### 4. Compaction verification

For both providers, trigger compaction and inspect resulting history behavior:
- Claude: thinking-preservation behavior remains intact
- GPT: no synthetic thinking survives or is required after compaction

### 5. Token-estimation verification

Confirm that GPT sessions no longer take Claude-thinking token-count branches merely because reasoning occurred.

### 6. Search-based invariant verification

After implementation, search for:
- GPT/OpenAI paths emitting `type: 'thinking'`
- GPT/OpenAI paths emitting `thinking_delta`
- GPT-specific code paths that rely on `thinking` / `redacted_thinking` presence for replay or compaction decisions

## Bottom line

There is a real visible-thinking dependence today.

The critical issue is **not** that the codebase supports Claude thinking. The critical issue is that the GPT path currently **manufactures Claude-shaped visible thinking** and then lets shared infrastructure treat it as replayable state.

The correct Phase 0 move is to delete that GPT emulation layer, keep Claude-native continuity where it is required, and introduce an explicit provider-aware reasoning continuity policy so the rest of the system no longer assumes that visible thought text is universal state.
