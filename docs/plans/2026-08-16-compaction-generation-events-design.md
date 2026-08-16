# Compaction generation events (report §11 step 7)

Date: 2026-08-16
Status: design, unimplemented
Governing report: `docs/reports/2026-08-09-claude-code-compaction-evolution.md`
§10.7, §11 step 7. Steps 1-6 landed 2026-08-12/13.

## 1. What this has to solve

§10.7 asks that every attached client receive, in order: compaction started,
the new boundary and its metadata, the new active transcript generation,
completion or failure, and `/clear` with the new conversation id. It also asks
for a generation value so a reconnect cannot splice a pre-compaction transcript
onto post-compaction status, and it says explicitly not to copy Anthropic's
endpoints, worker epochs, or lease policy.

## 2. Current state, from source

The mechanism is not missing. It exists twice, each half wired to exactly one
consumer, and neither half carries identity.

**Channel A, the progress callback.** `CompactProgressEvent`
(`src/Tool.ts:155-162`) has three variants: `hooks_start`, `compact_start`,
`compact_end`. Six modules emit it (`services/compact/compact.ts`,
`autoCompact.ts`, `reactiveCompact.ts`, `commands/compact/compact.ts`). It is an
optional callback on `ToolUseContext`, and exactly one caller in the repository
sets it: `src/screens/REPL.tsx:2772`, which uses it to drive spinner text and
nothing else. It is never persisted and never leaves the process.

**Channel B, the SDK status.** `setSDKStatus?.('compacting')`
(`compact.ts:440`, `:877`) is likewise optional on `ToolUseContext`, and the
only caller that sets it is `src/cli/print.ts:2303`. The REPL does not; the
desktop app-runtime does not; `forkedAgent.ts:448` sets it to `undefined`
deliberately. `src/remote/sdkMessageAdapter.ts:88` converts a status message
into a display system message, but that path is inbound from a CCR proxy, not
this engine's outbound.

**What actually leaves the engine.** One fact:
`QueryEngine.ts:1074-1081` yields `system/compact_boundary` with
`compact_metadata`. That is the whole of what an SDK, desktop, or remote
consumer learns about compaction.

Consequences that follow directly:

- The desktop consumes the boundary (`app/renderer/src/transcriptProjector.ts:1341`,
  `app/renderer/src/contextUsage.ts:190`) but has no compacting state at all,
  because neither channel reaches the sidecar.
- `/clear` emits nothing. `app/shared/protocol.ts` has no `conversation_reset`
  analogue, so an attached renderer has no signal that the conversation identity
  changed underneath it.
- The bridge has zero compaction awareness. `rg` over `src/bridge/*.ts` finds
  three incidental comments and no handling.
- **Failure is indistinguishable from success.** `compact_end` fires from a
  `finally` block (`compact.ts:818`, inside the `catch`/`finally` at `:807-820`),
  so it is emitted on the throw path too. §10.7 item 4 ("completed or failed")
  cannot be satisfied by the current event set at all.
- No generation or sequence concept exists. `app/shared/protocol.ts`'s only
  `sequence` (`:3149`) is the delivery-trace acknowledgement counter, unrelated.

## 3. Design

### 3.1 The generation counter

A monotonic per-session integer, engine-owned, incremented by every event that
replaces the active context root: full compaction, reactive compaction, partial
compaction (both directions), session-memory compaction, and `/clear`.

Home: `src/bootstrap/state.ts` alongside `sessionId`, so all planes read one
source rather than each deriving its own. Regeneration of the session id resets
it to 0; the reset and the id change must be a single observable step, for the
same reason `sessionId`/`sessionProjectDir` are atomic there.

It must also be written into the boundary's `compactMetadata` and restored on
resume. Without that, a session resumed after three compactions restarts at
generation 0, and a reconnecting client that remembers generation 3 cannot tell
whether it is ahead of or behind the engine.

**This is an ordinal, not an identity.** It does not extend the locked two-id
model (`docs/migration/decisions/`, CLAUDE.md §5): `appSessionId` is still the
address and `engineSessionId` still the transcript key. A future session should
not read this document as reopening that decision.

### 3.2 Event vocabulary

Widen `CompactProgressEvent` and give every variant a `generation`:

```text
{ type: 'compact_start',  generation, trigger }   trigger:
{ type: 'hooks_start',    generation, hookType }    'auto' | 'manual' | 'reactive'
{ type: 'compact_end',    generation }              | 'partial' | 'session_memory'
{ type: 'compact_failed', generation, reason }
```

`compact_start` carries the generation being left; `compact_end` and
`compact_failed` carry the generation now in effect (unchanged on failure). The
`finally` at `compact.ts:815-820` must split: emit `compact_failed` from the
`catch` before the rethrow, and `compact_end` only on the success path. The
`finally` keeps the transport resets (`setStreamMode`, `setResponseLength`),
which are correct on both paths.

### 3.3 Two channels, deliberately kept separate

Do not merge channel A into the message stream. Keep:

- **Channel A (callback), unchanged in scope**: fine-grained, high-frequency,
  local UI only. Hook-level phases stay here. Upstream reached the same split
  and filters raw `compact_progress` out of its bridge (report §5.14); there is
  no consumer for hook-grain detail on a remote client, and it is chatty.
- **Channel B (SDK system stream), the durable facts**: forwarded by
  `QueryEngine` next to `compact_boundary`, so every SDK, desktop, and bridge
  consumer gets them with no per-plane wiring:

  | Message | Payload |
  |---|---|
  | `system/compaction_status` | `phase: 'start' \| 'end' \| 'failed'`, `generation`, `trigger`, `reason?` |
  | `system/compact_boundary` (existing) | add `generation` to `compact_metadata` |
  | `system/conversation_reset` | `generation`, new `session_id` |

The reason for the split is ordering, not volume. A callback has no defined
order relative to the message stream, and a reconnecting client needs the facts
*in* the stream, ordered against the boundary it is trying to place.

### 3.4 Ordering contract

The one invariant worth writing into `protocol.ts` as a doc comment:

```text
compaction_status(start, gen=N) → compact_boundary(gen=N+1) → compaction_status(end, gen=N+1)
compaction_status(start, gen=N) → compaction_status(failed, gen=N)      [no boundary]
```

A boundary never arrives without a preceding `start`. A `status` never names a
generation whose boundary has not been delivered. A consumer that sees a
boundary whose generation is not `lastSeen + 1` has missed frames and must
resynchronize rather than append.

### 3.5 Per-plane wiring

**Desktop.** Outbound-only additions, so `app/shared/protocol.ts` grows a
snapshot without a `PROTOCOL_VERSION` bump, per its own header rule. Nothing
enters the inbound allowlist, so the security baseline
(`SECURITY-MINIMUM.md` T4/T5a/T6/T7) is untouched and no new sidecar boundary
test is required. `secretGuard` already runs on outbound frames. Renderer work:
extend the `transcriptProjector.ts:1341` system switch, which has a compile-time
exhaustiveness tripwire, and add the matching entries to
`app/renderer/src/sdkMessageFixtures.ts` (CLAUDE.md §7 requires both sides;
verify by removing one case and seeing tsc fail).

**Remote/bridge.** Forward the same three messages. Reconnect rule: the client
sends its last seen generation; if it does not match the engine's current one,
the engine refuses incremental backfill and sends a full active-context
snapshot. That is §10.7's requirement reimplemented in Cat's own transport, with
no epochs and no lease arbitration.

**Local REPL.** Keeps channel A for the spinner. Gains nothing else, which is
the point: the local plane is already correct.

### 3.6 Tests

- Generation ordering: a fixture session driven through auto, then manual, then
  `/clear`, asserting the contract in §3.4 holds over the emitted stream.
- Failure path: a compaction that throws emits `compact_failed` and no boundary,
  and does not emit `compact_end`. This test fails against today's code, which is
  the point of writing it first.
- Resume: a session resumed after N compactions reports generation N, not 0.
- Both exhaustiveness tripwires still fire when a variant is removed.

## 4. Cost and sequencing

Roughly: engine event/counter work, then QueryEngine forwarding, then desktop
projection, then bridge forwarding and the reconnect rule. The first two are
independently shippable and make the desktop and bridge work purely additive.
Nothing here requires touching the compaction algorithms themselves.

## 5. Open questions

- Does `generation` belong in the transcript's per-record metadata as well as the
  boundary? It would make an archival reader able to bucket records by generation
  without walking boundaries, which the step 8 design
  (`docs/plans/2026-08-16-compaction-hot-cold-history-design.md`) would use.
  Deciding it here is premature; deciding it after step 8's ledger shape is
  settled is not.
- Subagent sidechains compact independently. Whether they share the parent's
  generation counter or hold their own is undecided; `app/sidecar/subagentHistory.ts:100`
  already notes that a subagent's own boundary "has nowhere to carry" its state,
  which suggests a per-sidechain counter, but this was not traced to a conclusion.
