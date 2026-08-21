# Subagent account: stamp it into the transcript plane

**Status:** IMPLEMENTED 2026-08-21 (option (a)). This file is the design plus
the record of what shipped; the adversarial review that reshaped it is
`docs/reports/2026-08-21-subagent-account-transcript-stamp-adversarial-review.md`.
**Date:** 2026-08-21.
**Surfaces:** engine (`src/tools/AgentTool/`, `src/tasks/LocalAgentTask/`,
`src/services/api/codexAccountLeaseManager.ts`) + desktop renderer
(`app/renderer/src/transcriptProjector.ts`, `TranscriptView.tsx`).
**Not touched:** `app/shared/protocol.ts`, preload, sidecar inbound surface.

## 1. The defect

The agent card names the Codex account through a LIVE join against the lease
plane:

```ts
const lease = selectLeaseForOwner(leases, row.result?.agentId ?? null)
```
`app/renderer/src/TranscriptView.tsx:2513`

The join has two operands, and they are alive in disjoint windows.

**The lease is deleted, not marked released.**

```ts
export function releaseCodexLease(ownerId: string): void {
  codexLeasesByOwnerId.delete(ownerId)
}
```
`src/services/api/codexAccountLeaseManager.ts:329`

Called at every terminal: `LocalAgentTask.tsx:560` (complete), `:587` (fail),
`:394` (kill), `:823` (`unregisterAgentForeground`). A second, independent
filter finishes the job — the sidecar projects only leases of workers still live
in `AppState.tasks` (`app/sidecar/leaseDomain.ts:205`), and a finished task
carries an `evictAfter`.

**`row.result` only exists once the tool result arrives** — it is
`session.toolResultsByUseId[toolUseId]` (`transcriptProjector.ts:648`).

| path | join key present | lease present | account visible |
|---|---|---|---|
| background | at spawn (`async_launched` ack, `AgentTool.tsx:1311`) | spawn (`:1257`) → finish | only while running |
| foreground | only at finish (`finalizeAgentTool`, `:2002`) | spawn (`:1387`) → `unregisterAgentForeground` (`:1881`) | **never** — the windows do not overlap |

For a foreground subagent the two preconditions are mutually exclusive by
construction, so the account has never once rendered on that card. For a
background subagent it renders during the run and is permanently gone the
instant the worker finishes — which is when a reader goes looking.

"Which account did this worker burn" is a stable historical fact being served
from state that is destroyed at exactly the moment it is asked for. It is also
lost on restore, because the lease map is per-process and in-memory.

## 2. The fix

Stamp the account onto the Agent tool's own structured result, and let the live
join stay as the truth only while it IS live.

This is the route `agentModel` already takes, unchanged: the engine writes a
field on the result object, the renderer narrows it out of `unknown` at read
time (`extractAgentModel`, `transcriptProjector.ts:2084`). Consequences worth
stating up front:

- **No protocol change.** The result rides as `toolUseResult`; no new frame
  kind, no preload channel, no sidecar inbound vocabulary. The security baseline
  is untouched (this is outbound only).
- **No new account material crosses.** `accountId` + the pool's redacted
  `accountAlias` is exactly the pair `leaseDomain.ts:237-238` already projects,
  which is the policy `AccountStatus.id`/`.alias` set.
- **The model never sees it.** Agent's model-facing text is hand-built field by
  field in `mapToolResultToToolResultBlockParam` (`AgentTool.tsx:2101`); struct
  fields do not reach the prompt.
- **It replays from history**, so a restored transcript keeps the account.
  Absent on results persisted before the change — the same caveat `agentModel`
  carries and documents.

### 2.1 Shape

```ts
account?: { accountId: string; accountAlias: string | null }
```

Deliberately structural and identical to what `leaseAccountShortLabel`
(`leaseState.ts:126`) already accepts, so the renderer's existing formatter
takes the stamp with no new label code and no second redaction rule.

Optional, not nullable: only a Codex-path worker ever has one, so absence is the
ordinary case (an Anthropic-path session holds no lease at all).

### 2.2 Engine — as built

**New helper** `snapshotLeaseAccount(ownerId)` beside `getCodexLeaseForOwner` in
`codexAccountLeaseManager.ts`: the account an owner holds, as a value that
outlives the lease. Throw-free (`getPoolStatus` cannot throw).

**Provider gate — `reportableAccount` (`AgentTool.tsx`).** A Codex lease is
registered for EVERY worker (`AgentTool.tsx:1257,1387`), unlike the main
thread's, which `query.ts:370` gates on
`getAPIProvider() === 'openai' && poolManagesCredentials()`. An Anthropic worker
therefore holds a Codex lease it never spends, and reporting it would name an
account in the transcript the run never touched. Every capture is gated on the
engine's own `resolveRequestProvider(model, …)`, so the stamp cannot disagree
with where the request went. (The unconditional registration itself is a
separate pre-existing defect; it is not touched here.)

**Four capture points**, one per shape a worker's card can take:

| path | captured at | semantic |
|---|---|---|
| background spawn | after `registerCodexLease` → the `async_launched` ack | dispatch |
| auto-backgrounded | the transition ack that REPLACES the card's result | dispatch |
| foreground | the value returned BY `unregisterAgentForeground` | terminal |
| background lifecycle | before `completeAgentTask`/`failAgentTask` release, into the stored task result | terminal |

The foreground capture is **structural, not ordering-tested**:
`unregisterAgentForeground` now RETURNS the account it released
(`LocalAgentTask.tsx`), because `releaseCodexLease` deletes the entry and a
separate read ordered before the call would be silently order-dependent. The
value can only be obtained from the release itself, so it cannot be sequenced
wrong. `LocalAgentTask.test.ts` proves it by asserting the returned value and
the deletion together; moving the read after the release fails that test
(verified by mutation).

**Schemas.** BOTH result shapes carry the field: `agentToolResultSchema`
(sync/completed) and the separate `asyncOutputSchema` (`AgentTool.tsx:536`) that
the async acknowledgment is validated against.

**Explicitly NOT covered.** A foreground worker that aborts or fails before any
assistant message rethrows before a structured result exists
(`AgentTool.tsx` `AbortError` / `syncAgentError` rethrow), so those terminals
carry no account. That is existing behaviour for `agentName` and `agentModel`
too, not a new gap.

### 2.3 Renderer

1. `extractAgentAccount(toolUseResult)` beside `extractAgentModel`
   (`transcriptProjector.ts:2084`), gated the same way — requires a string
   `agentId`, then narrows the two fields. Runtime narrowing, zero casts.
2. `agentAccount?: …` on `ToolResultProjection` (~`:232`), populated in
   `toToolResultProjection` (~`:1994`).
3. `agentAccountLabel` (`TranscriptView.tsx:2509`) gains a precedence rule:

   ```
   live lease  →  stamped account  →  null
   ```

   Live wins while the worker runs: it follows a failover, the stamp does not.
   The stamp answers everything after the terminal, and after a restore. Null
   stays silent, exactly as the current doc comment requires.

Note this INVERTS `agentModelOf`'s `settled ?? live` order, and for a stated
reason: a model cannot change mid-run, an account can.

## 3. The one thing this does not fix

A background launch card is an immutable launch record — the projector
deliberately does not fold a worker's completion back into it
(`recordAgentCompletion`, `transcriptProjector.ts:1660-1667`: "Original
background launch cards do not consume them"), and that immutability is the
governing ruling from the 2026-08-14 subagent-surface decisions.

So a background worker that FAILS OVER after spawn will have its card name the
account it started on, not the one it finished on. The stamp is written at
spawn because that is the only write the card will ever read.

Two ways to close it, both needing an operator ruling before implementation:

- **(a) Accept and document it** — the card names the account the work was
  dispatched to. Cheapest, and wrong only in the failover case, which
  `failoverCount` says is rare.
- **(b) Carry the settled account on the completion turn** — measured below.

**(b) is an ADD-ON, not an alternative.** A foreground subagent produces no
task-notification turn at all (`TranscriptView.tsx:2777`), so §2's result stamp
is required either way; (b) buys exactly one case, the background worker that
failed over mid-run.

Its cost, measured:

| layer | files | note |
|---|---|---|
| engine | `types/message.ts:12`, `utils/taskNotification.ts:170`, `LocalAgentTask.tsx:560,587`, `utils/messages/mappers.ts:137` | the last is the governed one |
| SDK types | `coreSchemas.ts:1324`, `coreTypes.generated.ts:308`, 2 snapshot copies | drift auto-caught by `engineTypeDriftCheck.ts` |
| renderer | `InjectedOrigin`, `AgentCompletionProjection`, display | |

Two boundaries §2 does not touch:

1. **The origin narrowing allowlist** (`mappers.ts:137-150`) is a
   SECURITY-MINIMUM §4 enforcement, not a convenience — `taskId`/`outputFile`
   are dropped there because a UI once put both on screen (2026-08-01 leak).
   Widening it needs its own recorded justification plus a `secretGuard.test.ts`
   extension.
2. **Row immutability.** The completion is ALREADY joined by `toolUseId` onto
   every tool-use row; the launch record discards it in one line —
   `const completion = isLaunchRecord ? null : row.agentCompletion`
   (`TranscriptView.tsx:2764`). That line IS the 2026-08-14 ruling in force. (b)
   needs either a narrow exception for this one field or a new slot on the
   completion row (`TaskNotificationBox`, `:964`, renders only status +
   summary today).

Recommendation: (a) for this change, with the failover case left visibly
unclaimed rather than silently wrong. (b) is a clean follow-on that nothing in
§2 forecloses; take it only if `failoverCount > 0` turns out to be common enough
to notice.

## 4. Tests — as built

- `LocalAgentTask.test.ts`: the release hands back the account AND deletes the
  lease (mutation-verified: reading after the release fails it); a worker that
  leased nothing reports nothing.
- `AgentTool.test.ts` (`reportableAccount`): withheld for a `claude-*` worker
  even though a lease exists, reported for a `gpt-*` worker whatever the session
  provider is, absent when no lease was held.
- `transcriptProjector.test.ts`: the account narrows off a real
  `tool_use_result`; a missing alias becomes null; absent and foreign shapes
  degrade to absent rather than half-populating the slot.
- `TranscriptView.test.tsx`: a finished worker names its account with
  `leases={null}` (the state after a terminal, and after a restore); a live
  lease outranks the stamp when they disagree.

## 5. Battery — as run

```bash
bun run build:dev:full
```
green, `2.1.87-dev.20260821.t164355.sha41dfbac1`.

```bash
cd /Users/pt/cat-code && bun test src/tools/AgentTool src/tasks/LocalAgentTask src/services/api/codexAccountLeaseManager.test.ts
```
163 pass / 0 fail across 9 files.

```bash
cd /Users/pt/cat-code && bun test app/ && bun run --cwd app typecheck && bun run --cwd app typecheck:sidecar && bun run --cwd app test:hardening && bun run --cwd app renderer:build
```
3805 pass / 1 fail (the fail is `desktopSystemPrompt.ts` tripping the §7 sweep,
committed by another session in `c3745ab0` and untouched here) · app tsc clean ·
sidecar wrapper green, 5586 upstream ignored · hardening 19/19 · renderer build
clean.

## 6. Open questions

1. **Failover semantics** (§3) — (a) or (b). Blocking for background cards only.
2. **On-disk transcript.** The stamp lands in the session JSONL under
   `~/.cat-code/projects/…`. That is an account alias plus a UUID that already
   lives in this machine's Codex config, so no new secret is written, but it is
   a new class of fact in the transcript file. Confirm that is wanted.
3. **Main thread.** This design covers subagent cards only. The main thread's
   own account is already on the composer rail; no change proposed.
