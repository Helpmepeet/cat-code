# Desktop user-message lifecycle: mid-turn send parity, and edit sent message

**Date:** 2026-08-16
**Area:** terminal engine (`src/`), Electron desktop app (`app/`), transcript persistence
**Status:** Part A is a source-traced findings report, revised after adversarial review. Part B is a proposed implementation plan (absorbed from `docs/migration/specs/2026-08-13-desktop-edit-sent-message-implementation-plan.md`, revised after adversarial review, unbuilt).

Two questions about the same object — a user message the operator has already committed to:

- **Part A. What happens to a message sent while a response is still running?** Traced in current source on both surfaces and compared.
- **Part B. What would it take to edit a message already sent?** The desktop has no engine seam for it; this is the plan.

They are in one document because they operate on the same substrate: the process-global engine command queue and the sidecar's `activeTurn` latch. Section 3 states what that shared substrate does and does not imply — the first draft of this report claimed four couplings between the parts, and adversarial review refuted or downgraded all four. What survives is narrower and is recorded as such.

All claims are anchored to current source. Dated docs are not evidence; where this report and source disagree, source wins. Claims that rest on an exhaustive search finding nothing are labelled **(absence claim)**.

---

# Part A — Sending during a running response

## A1. The delivery mechanism is at parity

Both surfaces place mid-turn text on the **same** process-global engine queue, and the running turn drains it at its next tool round. This is real steering, not a next-turn deferral.

| Step | Terminal (TUI) | Desktop |
|---|---|---|
| Input accepted mid-turn | Never disabled; `focus` ignores `isLoading` (`src/components/PromptInput/PromptInput.tsx:2236`) | `turnPending` keeps the composer editable (`app/renderer/src/composerState.ts:555-564`) |
| On Enter | `enqueue({mode:'prompt'})`, default priority `next` (`src/utils/handlePromptSubmit.ts:414-421`, `src/utils/messageQueueManager.ts:168-172`) | `handleSubmit` sees `activeTurn` and calls `enqueueMidTurnPrompt` → same `enqueue` (`app/sidecar/sidecarServer.ts:1717`, `:1751`, `:1599-1607`) |
| Delivery into the running turn | Drained after a tool round, injected as an attachment (`src/query.ts:1765-1791`, `src/utils/attachments.ts:1057-1093`) | Identical: the sidecar never calls `AppSessionController.submit` on this path, so the engine's own drain owns it |
| Wording the model sees | `The user sent a new message while you were working: …` (`src/utils/messages.ts:5736`) | Same string, same code |
| Turn ends with no further tool round | Boundary drain runs it (`src/hooks/useQueueProcessor.ts:48-60`) | `drainOneQueuedPrompt` starts a turn with `announcePrompt:false` (`app/sidecar/sidecarServer.ts:1286-1338`) |

Two qualifications apply to both:

- The drain sits inside the `needsFollowUp` branch, and `needsFollowUp` is set in exactly one place, gated on the assistant having emitted `tool_use` blocks (`src/query.ts:954`; branch `:1217-1536` returning at `:1535`). A **text-only** response never steers; the message waits for the boundary. "Mid-response" means "at the next tool round of the same turn", never mid-token.
- The desktop qualifies as main thread because `QueryEngine` passes `querySource: 'sdk'` (`src/QueryEngine.ts:473`), which the drain's `isMainThread` test admits (`src/query.ts:1767`).

`turn_already_running` is dead on this path: the synchronous `activeTurn` check precedes every route that could raise it (`app/sidecar/sidecarServer.ts:1717` vs `:1760-1781`).

## A2. Divergences, ranked by user impact

### D1 — The TUI stages the message; the desktop commits it

TUI: the queued message renders as a real user row **above the composer** (`src/components/PromptInput/PromptInputQueuedCommands.tsx:96-131`) and is recallable. `↑` pops every editable queued command back into the composer with pasted images restored (`src/components/PromptInput/PromptInput.tsx:951-956`, `:1275-1297`, `src/utils/messageQueueManager.ts:485-541`), advertised by the placeholder `Press up to edit queued messages` (`src/components/PromptInput/usePromptInputPlaceholder.ts:49-56`). Sending mid-turn is a staged, reversible act.

Desktop: `enqueueMidTurnPrompt` broadcasts the user message **before** enqueueing it (`app/sidecar/sidecarServer.ts:1601` precedes `:1602`; broadcast at `:1565-1583`), producing an ordinary raw `user` event with no distinguishing flag. User rows carry no status field at all — `UserTextRow` / `UserImageRow` hold only `isReplay` (`app/renderer/src/transcriptProjector.ts:280-307`); the three-state `STATE_STYLE` vocabulary in `TranscriptView.tsx` is for tool cards, not user rows. The `Queued` row that does exist is the cold-spawn park, gated on `pendingSubmit?.showQueuedRow`, which only the `hold` branch sets (`app/renderer/src/App.tsx:4754-4763`, `app/renderer/src/composerState.ts:632-638`). There is no dequeue or cancel verb in the sidecar's inbound vocabulary **(absence claim: the dispatch has seven `case` arms — `app.ping`, `app.abort`, `permission.response`, `app.submit`, `model.set`, `effort.set`, `fast.set`; `dequeue` appears only at `:1297` and `:1362`, both internal)**.

**The sidecar's stated reason for broadcasting early is stale.** Its comment says the queue "offers no consumption signal the sidecar can observe without reaching into engine internals" (`app/sidecar/sidecarServer.ts:1592-1596`). Two observable signals exist today:

1. `removeFromQueue` calls `notifySubscribers()` (`src/utils/messageQueueManager.ts:335`), and the sidecar already holds a queue subscription (`app/sidecar/sidecarServer.ts:602`). The prompt's UUID disappearing from the snapshot **is** the consumption signal, keyed by the UUID `enqueueMidTurnPrompt` minted at `:1600`.
2. `src/utils/commandLifecycle.ts:16` is a purpose-built listener; `src/query.ts:1839` fires `'started'` at the exact drain and `:291` fires `'completed'`. (It is a single-slot listener currently claimed on the CLI path, so this option needs multiplexing, not invention.)

So a "sent, not yet delivered" row state needs one **outbound-only** frame and no reach into engine internals. That is a smaller change than the comment implies, and the comment should be corrected wherever this is fixed.

### D2 — Mid-turn image messages are dropped, and evade the depth bound

`buildSubmitPrompt` returns a content-block **array** whenever attachments are present (`app/renderer/src/composerState.ts:167-178`), and the attach control is live mid-turn (`attachDisabled={!composerGate.editable || preparingImage}`, `app/renderer/src/App.tsx:4962`, where `editable` includes `turnPending`). `enqueueMidTurnPrompt` enqueues that array as `value` (`app/sidecar/sidecarServer.ts:1602`). The sidecar's own predicate requires a string:

```ts
function isDeliverableParentPrompt(command: QueuedCommand): boolean {
  return (
    command.mode === 'prompt' &&
    command.agentId === undefined &&
    typeof command.value === 'string'
  )
}
```
`app/sidecar/sidecarServer.ts:3923-3929`

Three consequences, each verified independently:

1. **The T7 depth bound is bypassed.** `countQueuedParentPrompts()` filters on the predicate (`:1246-1248`), so image-bearing prompts are not counted against `MAX_QUEUED_PROMPTS` (`:1722`). That constant is documented as *the* depth bound that replaced the old refusal, precisely so a flooding renderer cannot "pile unbounded prompt text into a queue the next tool round injects into the turn's context wholesale" (`app/shared/limits.ts:57-69`). `MAX_PROMPT_BYTES` **is** enforced on arrays (`Buffer.byteLength(JSON.stringify(prompt))`, `:1657-1661`), so each item is capped — but the accumulation bound the comment claims is currently open, limited only by the arrival-rate caps.
2. **Not rescued at the boundary.** `drainOneQueuedPrompt` dequeues on the same predicate (`:1297`).
3. **Does not hold the park gate.** `hasQueuedParentPrompt` (`:1242-1244`) is consulted by `isParkGateOpen` (`:1864`), so the session can park with such a prompt still queued.

Nothing else rescues it **(absence claim: `getCommandQueueSnapshot`/`dequeue` appear in the sidecar only at `:1235`, `:1243`, `:1247`, `:1297`, `:1362`, all string-gated for prompts; `src/QueryEngine.ts` never touches the command queue; `useQueueProcessor` is REPL-only)**. The engine's own drain does handle arrays end to end (`src/utils/attachments.ts:1074`, `src/utils/messages.ts:3939-3966` splits blocks and re-attaches image blocks), so the message is delivered when a tool round happens and silently lost when the turn ends first — leaving the user looking at a message in their transcript the model never received.

No test covers the mid-turn + image path **(absence claim: the only image-submit test, `app/sidecar/sidecarServer.test.ts:337`, runs on an idle controller; `composerState.test.ts:901` only checks that `planSessionSubmit` returns `send`)**.

### D3 — Slash commands: instant in the terminal, a whole extra turn on the desktop

The **drain filter** is shared and identical: `if (isSlashCommand(cmd)) return false` (`src/query.ts:1772`), so neither surface steers a running turn with a slash command. There is no renderer-side slash pre-processing — even the donut's Compact goes over the wire as text (`app/renderer/src/App.tsx:2809`, `getBridge().submit(sessionId, '/compact')`).

The paths around that filter diverge sharply. In the TUI, an **immediate** local-jsx command (`/status`, `/usage`) dispatched mid-turn executes right away and is never enqueued: the immediate-command block at `src/utils/handlePromptSubmit.ts:274-388` sits **above** the `if (queryGuard.isActive || isExternalLoading)` enqueue branch at `:391` and returns. On the desktop the same text goes to `enqueueMidTurnPrompt` (`app/sidecar/sidecarServer.ts:1751`), is excluded from the mid-turn drain, and is then matched by `isDeliverableParentPrompt` — so `drainOneQueuedPrompt` starts a **whole turn** for it at the boundary.

This is the half of the drain divergence that `docs/reports/2026-08-08-migration-branch-review/X02a-atomic-writes-duplication.md:254` explicitly left untraced. It is now traced.

### D4 — Boundary drain: one turn per message, versus one turn for all

TUI: `processQueueIfReady` dequeues all non-slash commands sharing a mode and passes them as one array (`src/utils/queueProcessor.ts:75-84`); `executeUserInput` accumulates them into `newMessages` and fires a **single** `onQuery` (`src/utils/handlePromptSubmit.ts:552-645`), with `skipAttachments` on all but the first (`:575`).

Desktop: `drainOneQueuedPrompt` dequeues exactly one, and each turn finalizer re-schedules (`app/sidecar/sidecarServer.ts:1286-1338`, `:1477`).

**Corrected 2026-08-16 after a scoping pass:** an earlier draft of this row said three queued messages simply produce three sequential turns on the desktop. That holds only when each drained turn ends **without** a tool round. If drained turn 1 calls a tool, prompts 2..N are folded into it by the engine's own mid-turn drain as attachments rather than as leading user messages — still not parity, but not N turns either. The clean N-turn reproduction therefore needs prompts that yield tool-free answers.

**Scoped and stopped, not implemented.** Terminal parity here is specifically *N distinct user messages, N distinct uuids, one query* (`src/utils/handlePromptSubmit.ts:552-645`, `uuid: cmd.uuid` at `:566`, single `onQuery` at `:637`). Every desktop layer between the drain and the engine is singular: `controller.submit(prompt, {uuid})` (`sidecarServer.ts:1448`), `AppSessionController.submit` (`src/app-runtime/AppSessionController.ts:135-138`), `createQueryEngineSessionController.ts:36-41`, `createQueryEngineAppSession.ts:39-48`, and one `processUserInput` in `src/QueryEngine.ts:462-473`. Merging N prompts into one `ContentBlockParam[]` is not a shortcut: `processUserInputBase` (`src/utils/processUserInput/processUserInput.ts:281-345`) folds an array into ONE user message, so it would produce one uuid where the sidecar already broadcast N, leaving N-1 renderer rows with no engine counterpart. Closing D4 honestly is a plural-prompt change to the app-runtime contract with two consumers (the desktop sidecar and `src/web/AppSessionWebSocketServer.ts:174`), which needs its own session and a decision record.

**Found while scoping, unfixed:** `drainOneQueuedPrompt`'s `onSettled` retry path (`sidecarServer.ts:1329`) re-enqueues by **appending**, so a retried prompt loses its queue position relative to later arrivals. The refusal branch beside it (`:1332-1337`) has the same property and its comment already argues that branch is unreachable; the retry branch is reachable. Harmless while prompts drain one at a time, load-bearing the moment batching lands, since batching makes queue order the thing being preserved.

Already recorded as D2 of `docs/reports/2026-08-08-migration-branch-review/X02a-atomic-writes-duplication.md:193`.

### D5 — The depth-cap rejection arrives after the composer has been emptied

The TUI queue is unbounded **(absence claim: `enqueue` is a bare `commandQueue.push`, `src/utils/messageQueueManager.ts:169`, with no length check anywhere in that module)**. The desktop caps depth at `MAX_QUEUED_PROMPTS = 32` (`app/shared/limits.ts:68`), each ≤ `MAX_PROMPT_BYTES` 96 KiB (`:54`). The cap itself is defensible: the sidecar's writer is a renderer, not necessarily a keyboard.

The loss is on the rejection path. `submitSession` calls `getBridge().submit(...)` synchronously and then `retireDraft` (`app/renderer/src/App.tsx:2326-2328`), long before the async `bad_request` / `Too many messages are already waiting for this response.` frame lands (`app/sidecar/sidecarServer.ts:1723-1730`, pinned by `app/sidecar/sidecarServer.test.ts:1406-1454`). No error path restores the composer; the frame only sets `session.error` (`app/renderer/src/rawMessageLog.ts:133-145`), rendered as the dismissible red line (`App.tsx:4728-4741`).

Text is recoverable through `↑` history, because `retireDraft` pushes it there (`App.tsx:2303-2308`). **Attachments are not**: the same function clears session images (`reduceSessionImagesReplaced(prev, sessionId, [])`, `:2304-2306`) and history stores only `text`. A rejected image-bearing submit loses its images with no recovery path at all.

### D6 — Stop does not cancel a queued message on either surface, and only the TUI has an escape hatch

Abort leaves the queue intact on both sides: `app.abort` ends at `controller.abort(reason)` (`app/sidecar/sidecarServer.ts:1209-1221`), and the TUI's `onCancel` touches no queue API (`src/screens/REPL.tsx:2335`, `:2370` — the nearby `setPromptQueue([])` at `:2394-2398` is the elicitation dialog's queue, not `commandQueue`). In both cases the queued message then runs as the next turn.

ESC precedence in the terminal is deterministic and does not depend on listener ordering: it is decided inside one handler. `src/hooks/useCancelRequest.ts:95-110` aborts and returns when an abort signal is live (priority 1), and only pops the queue when nothing is running (priority 2). The composer's `↑` recall is a separate history handler and is not bound to Esc at all. So: turn running plus message queued → Esc aborts, queue untouched.

The TUI's escape hatches are therefore `↑` recall (D1) and, at idle, the Esc pop. The often-cited "queue clear" is **not** a queue control: `clearCommandQueue()` (`src/hooks/useCancelRequest.ts:253`) is a side effect inside the `chat:killAgents` double-press handler, one line above `killAllAgentsAndNotify()`, bound to `ctrl+x ctrl+k`. The desktop has none of these.

## A3. Fix order proposed

1. **D2** — the only defect that both loses a user message and breaches a stated security-baseline bound. The fix is to accept content-block values in `isDeliverableParentPrompt`, and it is safe: the predicate has exactly three consumers, all inside `app/sidecar/sidecarServer.ts` (`:1243`, `:1247`, `:1297`), and nothing outside the file imports it. Widening it makes the depth cap and park gate stricter and makes the boundary drain rescue image prompts — all in the safe direction. Nothing downstream depends on string-ness: `startTurn` already takes `AppSessionPrompt` (`:1422`; `string | ContentBlockParam[]`, `src/app-runtime/AppSessionController.ts:30`), and `promptText` already folds arrays (`:3961-3966`), so the retry key and title generation are array-safe. Two riders: do **not** widen the twin `isDeliverableParentTaskNotification` (`:3932-3938`), whose banner text is legitimately string-only; and guard title generation against the empty string an image-only prompt yields. Needs boundary tests for both the delivered and the never-drained case.
2. **D1** — the behavior gap that is actually felt. A true recall needs a new inbound dequeue verb, which is a security-baseline change (schema, boundary test, decision reference). The cheaper interim — a row state meaning "sent, not yet delivered" — needs only an outbound frame, now that the "no consumption signal" premise is known to be false.
3. **D3**, **D4**, **D5** — independent and small. Decide whether a desktop slash command typed mid-turn should run immediately as it does in the terminal; batch the boundary drain; and stop discarding the draft (see below).

D5's fix cannot reuse Part B's draft rule. Part B can say "retain until the matching `operationId` is accepted" because its verb carries a renderer-minted correlation ID echoed on every result. The ordinary submit path has neither: main mints the request ID (`app/main/main.ts:1551`) and the preload sender never returns or receives it (`app/preload/preload.ts:216-220`), and there is no success acknowledgement to retain a draft *until*. D5's fix is therefore optimistic-clear with restore-on-typed-error, including the images.

D6 needs no fix beyond D1.

---

# Part B — Edit sent message (implementation plan, unbuilt)

Absorbed from `docs/migration/specs/2026-08-13-desktop-edit-sent-message-implementation-plan.md` (2026-08-13, proposed, revised after adversarial review). **Nothing in this part is built.**

## B1. Summary

The terminal lets the operator select an earlier user message, rewind the active conversation to immediately before it, restore its content into the prompt input, edit, and submit a replacement. The desktop provides no equivalent.

This is not a missing renderer button. The terminal implementation owns mutable conversation state directly inside `src/screens/REPL.tsx`; the desktop renderer talks to a separate engine sidecar through a closed protocol. Desktop support therefore requires a canonical engine rewind operation, strict sidecar and protocol wiring, renderer projection invalidation, composer edit state, and a user-facing edit control.

The implementation must preserve the locked desktop architecture: one engine process per session; raw `AppSessionEvent` transport; the two-id model; strict sidecar validation of all renderer input; append-only transcript history rather than destructive JSONL rewriting.

### Review decisions that constrain implementation

Current source does not provide several primitives the first draft assumed:

- `QueryEngine.onInputPersisted` follows an enqueued local transcript append. It is not a durable flush-and-fsync barrier.
- `fileHistoryRewind()` is best-effort. It can skip preview failures and continue after per-file apply failures, leaving a partial restore.
- Restored display history may contain an archival prefix no longer in `QueryEngine.mutableMessages` after compaction.
- The renderer does not know the main-minted `app.submit` request ID, and current main and sidecar submit sanitizers strip or reject a `rewind` option.
- Projector state and the bounded raw-message log are not, individually, a complete authoritative source for rebuilding an edited active chain.
- `createFork()` currently linearizes all main-thread JSONL messages instead of following the active parent chain. Edit-and-resend would make that existing bug deterministic by deliberately creating an abandoned suffix.

These are prerequisites, not implementation details to defer. **The feature must introduce engine-owned active-chain, durable-commit, and strict file-restore operations, and then use them from both edit-and-resend and affected sibling flows.**

## B2. Current behavior and source anchors

**Terminal.** Message actions compile in through `MESSAGE_ACTIONS` in `scripts/build.ts`. `Shift+Up` enters message-action mode (`src/keybindings/defaultBindings.ts`); `Enter` invokes `edit` for a selected user message (`src/components/messageActions.tsx`). The edit path in `src/screens/REPL.tsx` locates the raw message, checks whether rewinding would affect files or discard non-synthetic messages, opens a confirmation when consequential, truncates the active in-memory array immediately before the selected message, restores its text/input mode/pasted images into the prompt, and restores the associated permission mode. The terminal behavior is therefore **edit by rewind and resubmit**, not mutation of one historical message while retaining its dependent responses.

**Desktop.** User messages project as `user-text` / `user-image` rows (`app/renderer/src/transcriptProjector.ts`) and render with no edit callback (`app/renderer/src/TranscriptView.tsx`). The session-actions menu exposes `Rewind…` but keeps it disabled because no engine conversation-rewind verb exists (`app/renderer/src/sessionActions.ts`); the closed session-action vocabulary in `app/shared/protocol.ts` holds rename, export, branch, and tag only. `docs/migration/PARITY-LEDGER.md` records this as a deferred parity gap.

## B3. Product semantics

When the operator edits an earlier user message:

1. The application requests an authoritative rewind preview from the sidecar.
2. The original message loads into the composer only after the sidecar confirms it is editable.
3. Nothing is discarded while the operator is editing.
4. Canceling edit mode leaves the conversation unchanged.
5. Sending the edited message atomically: verifies the conversation head has not changed; takes over or fails closed against any deferred continuation; optionally restores files to the selected message's checkpoint; rewinds the active conversation to immediately before the original message; durably appends and fsyncs the amended message; submits it as the new branch tip.
6. The renderer removes the original message and its dependent suffix only after the sidecar accepts the rewind and replacement input.
7. Sessions with transcript persistence disabled do not expose edit-and-resend. The operation fails closed rather than claiming reload-safe atomicity for an in-memory-only branch.

### Eligibility

Only top-level, operator-authored turns are editable. Not eligible: synthetic or metadata user messages; task-notification messages; tool-result user messages; replay-only messages that do not represent an operator-authored turn; subagent-sidechain messages; command or generated bookkeeping rows without a resubmittable operator prompt.

The engine is authoritative; renderer filtering is presentation only. Eligibility uses one canonical engine predicate requiring an absent or `human` message origin in addition to the existing synthetic, metadata, tool-result, sidechain, and notification exclusions — the terminal selector alone is insufficient, because other engine-authored origins still carry a user role.

Visible operator messages before the latest compact boundary remain in scope, resolved through the persisted active parent chain and canonical resume machinery. Do not render an edit affordance `QueryEngine.mutableMessages` cannot honor.

### Explicit non-goal

Arbitrary deletion of one historical user message while retaining later assistant responses. Those responses causally depend on the removed prompt, so preserving them would create an invalid active chain. A future **Remove from here** may reuse the rewind machinery, but it requires an explicit durable branch-head representation when no replacement message follows. **It is not part of edit-and-resend parity.**

## B4. Architecture

Six layers: (1) canonical persisted active-chain and durable transaction primitives; (2) canonical QueryEngine rewind capability; (3) app-runtime controller operation; (4) strict desktop sidecar and protocol boundary; (5) renderer transcript and composer state; (6) accessible per-user-turn controls and confirmation UI.

The renderer must never author conversation contents other than the replacement prompt it already owns. It may select an engine-minted message UUID and a closed rewind scope. The engine derives target, affected suffix, prior permission mode, file checkpoint, and current head.

## B5. Phase 0 — required engine prerequisites

**Files:** `src/utils/sessionStorage.ts`, `src/utils/sessionRestore.ts`, `src/utils/fileHistory.ts`, `src/services/deferredContinuation.ts`, `src/commands/branch/branch.ts`, and colocated transcript, restore, file-history, deferred-continuation, and Branch tests.

### Canonical active-chain resolver

One engine-owned resolver over the persisted parent topology. It must:

1. Parse edit transaction records before choosing or pruning leaves.
2. Select the latest committed active leaf by valid JSONL append order, not timestamps; ignore transaction-associated replacements without a commit.
3. Resolve a pre-compaction target through persisted display topology, following compact `logicalParentUuid` ancestry.
4. Derive a new retained model chain from that archival path ending immediately before the target — excluding the abandoned compact boundary, summary, and later suffix — then pass it through existing resume normalization and state restoration. Never feed display projection rows directly to the model.
5. Preserve compact-boundary semantics rather than reconnecting summarized history into the ordinary model seed.
6. Return the active target, retained prefix, abandoned suffix, compact seams, reachable content replacements, and current head.
7. Distinguish the engine transcript identity from the desktop app-session address throughout the API.

Use this resolver for edit preview/edited-submit, and fix `createFork()` in `src/commands/branch/branch.ts` to fork only the authoritative active chain. Branch must also require an idle turn and a durable transcript flush before capturing HEAD. **Tests must cover sibling leaves, compact boundaries, an abandoned edit suffix, active-turn refusal, and resume of the resulting fork.**

Make this resolver the common active-leaf owner used by ordinary resume, display loading, edited replay, and Branch. The large-transcript `walkChainBeforeParse()` optimization must become transaction-aware or remain disabled until the committed leaf is known; it must not prune the last committed fallback branch while an incomplete edit transaction exists.

### Durable input commit

An awaited engine-owned edited-input commit primitive. A plain replacement message append is not enough: once written, latest-leaf resume can select it even if the rest of the transaction failed. Introduce an append-only edit transaction record with prepare, abort, and commit states:

1. Closed versioned shapes for prepare, abort, and commit records, plus the replacement message's transaction association.
2. Terminal state determined by the latest valid record for that transaction in JSONL append order, never by timestamp.
3. A durable prepare names the transaction, renderer operation ID, transport request ID, target, expected head, replacement UUID, scope, and engine-owned file rollback checkpoint.
4. The inactive replacement is appended and made durable with the prepare before any file is changed. Active-chain resolution and ordinary resume ignore it until a matching commit exists.
5. A handled failure before commit append begins restores transaction-owned files and appends a durable abort. Abort is never legal after commit append begins.
6. A readable valid commit is irrevocable and makes the replacement the active leaf. **An abort cannot supersede it.**
7. Once commit append begins, append, fsync, verification, or parent-directory sync uncertainty enters an `outcome_ambiguous` state. Do not run pre-commit rollback and do not emit ordinary success or failure. Keep session mutation blocked, reopen and reconcile under the session lock, and retry durability. If immediate reconciliation cannot establish a durable terminal state, report the typed ambiguous outcome and keep the session blocked for startup recovery.
8. Startup resolves an incomplete or ambiguous transaction before accepting another turn. It rolls back files only when they still match the transaction's applied fingerprint; if another process changed them, recovery preserves the newer content and reports a conflict.

The transaction record is additive persistence metadata, not a destructive JSONL rewrite or a renderer-authored branch head. Use the guarantees of `flushCurrentTranscriptDurably()` rather than treating `onInputPersisted` as the commit point.

The existing transcript queues and file-operation chains are process-local. Introduce one engine-owned cross-process mutation lock keyed by engine session ID; every main-thread transcript append, edit transaction/recovery, and Branch HEAD snapshot must participate. The edit transaction holds it from expected-head validation through terminal-state reconciliation. Branch also shares the in-process edit/admission latch and rejects while an edit is open. **Any new workspace-shared recovery state obeys the existing single-writer, lockfile, and atomic-write rules.**

Transcript write APIs accept an owned lock guard so transaction appends reuse the guard instead of reacquiring it. Define and test one lock ordering across the sidecar admission latch, engine-session mutation lock, transcript queue, and workspace fingerprint checks.

Reject the operation when session persistence is disabled. Test enqueue failure, flush failure, fsync failure, UUID verification failure, process restart after acknowledgement, and persistence-disabled mode. Add fault points after prepare, inactive replacement, file apply, commit append, transcript fsync, commit verification, and parent-directory fsync, including a large transcript above the pre-parse pruning threshold with an incomplete transaction and an older committed head.

### Strict file-history transaction

Do not use the current best-effort `fileHistoryRewind()` or its preview helpers as proof that a transaction can commit. Add a strict engine-owned operation that:

1. Fails closed when the target snapshot or any required backup is unavailable.
2. Preflights every target file before writing.
3. Captures enough current state to roll back already-applied writes and deletes.
4. Records preflight and intended-applied fingerprints for every path.
5. Compares the current fingerprint immediately before each apply or rollback; never overwrites a path changed by another process.
6. Applies all transaction-owned changes or restores each still-owned path, preserving concurrent modifications and returning a typed conflict, with the conversation left uncommitted.
7. Returns structured changed paths, conflicts, and failures.

Preview must distinguish zero changes from an unavailable or unreadable snapshot. **Tests must cover one valid and one failing file, rollback after a partial apply, conversation-persistence failure after a successful restore, and restart recovery of an incomplete prepared transaction.**

### Human-takeover guard

Route every renderer-authored human submit, including an edited submit, through `prepareHumanPromptAgainstDeferredContinuation()` before starting a turn. Pending or ambiguous continuations are canceled atomically; submitted or running attempts return a typed retryable failure. Engine-authored task notifications do not use this guard.

Because that operation is asynchronous, add a synchronous FIFO human-submit admission latch at sidecar dispatch before the first await. It must serialize ordinary and edited human submissions; preserve arrival order for mid-turn prompts; count pending admissions toward the existing queue-depth bound; block park, Branch, edit, and boundary drains; transfer ownership atomically to `activeTurn`, the bounded command queue, or the edit transaction; and release on typed takeover refusal or validation failure. Continuation cancellation completes before the prompt is announced as accepted.

## B6. Phase 1 — canonical engine rewind capability

**Files:** `src/QueryEngine.ts`, `src/app-runtime/createQueryEngineAppSession.ts`, `src/app-runtime/createQueryEngineSessionController.ts`, `src/app-runtime/AppSessionController.ts`, colocated focused tests.

```ts
previewConversationRewind(targetUuid: string): ConversationRewindPreview
submitEditedConversation({
  targetUuid: string,
  expectedHeadUuid: string,
  scope: ConversationRewindScope,
  replacement: EditablePrompt,
  onEditedInputCommitted: (result: ConversationRewindResult) => void,
}): AsyncIterable<SDKMessage>
```

Do not expose `mutableMessages` or a separately callable destructive apply step through the app-runtime interface. Rewind and replacement remain one operation. The edited operation owns one complete turn: it processes the replacement prompt exactly once, commits that exact user-message UUID, invokes `onEditedInputCommitted` synchronously, then enters the query loop with the already-accepted message. It must not call the ordinary prompt processing/persistence prefix again.

**Preview** resolves the target through the canonical persisted active chain (rehydrating intended ancestry through the existing resume path when it precedes a compact boundary); validates with the canonical operator-authorship predicate; identifies the current active-chain head; returns a revision token based on the current head UUID; returns canonical resubmittable prompt content and associated input metadata (collapsed-paste pills are renderer-local and cannot be reconstructed from the persisted prompt — restore their expanded text rather than inventing placeholder metadata); counts the suffix that will be removed; reports whether that suffix contains non-synthetic messages; and returns the selected message's permission mode when present.

**Edited submit** stages the rewind internally: repeat target eligibility checks against current state; reject if the current head no longer matches `expectedHeadUuid`; rebuild `mutableMessages` as the canonical retained model chain immediately before the selected message (which may require reseeding from persistence for a pre-compaction target); restore permission mode associated with the target through the existing engine-owned app-state path; clear or recompute active-chain-derived state, including permission-denial accumulation, context-collapse or compaction state, context-window calculations **derived from the removed suffix**, prompt suggestions or other continuation state referencing the abandoned branch, `readFileState` (**conservatively or from retained read events**), `loadedNestedMemoryPaths` (**conservatively or from retained context**), and `AppState.fileHistory` rebuilt from snapshots reachable through the retained chain **using the canonical resume helper**; preserve monotonic accounting such as cumulative API usage and incurred cost; and return the retained head and canonical active-chain replay needed by the app-runtime layer.

**Persistence rule.** Do not use `removeTranscriptMessage()` in `src/utils/sessionStorage.ts` — it physically removes an orphaned streaming entry and is not a conversation-rewind primitive. The transcript remains append-only; the amended message starts a new parent chain from the retained branch point, and the abandoned suffix remains historical data that is no longer reconstructed as the active conversation.

**Atomicity.** A failed replacement submission must not leave the active engine conversation truncated while the renderer still shows the old branch. One engine-owned transaction:

1. Acquire a synchronous per-session edit latch before the first await.
2. Validate the target and expected head.
3. When file restoration is selected, strictly preflight every file without changing the workspace.
4. Revalidate target and head after asynchronous preparation.
5. Process the replacement prompt once and stage the retained engine/AppState, exact replacement message, and canonical replay entirely in memory.
6. Append and durably verify prepare plus the inactive replacement before changing any file.
7. Apply the preflighted file transaction with fingerprint checks.
8. Begin commit append. From this point, commit is irrevocable if readable, and uncertainty follows the reconciliation path instead of rollback.
9. Flush, fsync, verify the commit and replacement, and sync the parent directory.
10. Swap in the already-staged engine/AppState with a non-failing state update.
11. Invoke the sidecar's synchronous committed-input callback. It updates the attach-time replay source and queues applied plus canonical replay before the query loop can emit assistant, tool, or permission output.
12. Before commit append begins, restore the prior engine state and every still-owned file on failure, then append abort. After it begins, reconcile without rollback until the terminal outcome is known.

The sidecar must not emit success at `onInputPersisted`; **success follows the new durable commit primitive.** The edit latch must block or fail ordinary submit, park, **queued-prompt drain**, task-notification drain, permission handling, and a second edit while the transaction is open. Edited submit and Branch must also reject when the authoritative task domain reports running or pending work. Revalidate live work before asynchronous preparation, after preparation, and immediately before file application/commit. **The latch prevents new task starts while those checks and the transaction run.**

**Controller guards.** Reject preview and edited submit when a turn is active; a permission request is pending; the target is absent from the current active chain; the target is not an eligible user turn; transcript persistence is disabled; or another edit transaction owns the session latch. Edited submit additionally rejects when the expected head is stale; a deferred continuation is already submitted or running; or a running or pending background task exists. Preview remains read-only and may report while background work exists, but its expected head is only advisory; **edited submit repeats every guard under the mutation lock.**

**The controller should expose narrow preview and atomic edited-submit operations through `QueryEngineSessionLike` and `AppSessionControllerAdapter`.**

## B7. Phase 2 — file-history preview and restoration

Reuse the checkpoint formats and comparison/backup helpers behind `fileHistoryGetDiffStats` and `fileHistoryHasAnyChanges` (`src/utils/fileHistory.ts`), but do not use the result of either best-effort public operation as a strict preview or transaction decision. Extract their low-level comparison and backup helpers into strict engine-owned preflight/apply/rollback behavior beside them. Do not duplicate file-checkpoint logic under `app/`.

```ts
type ConversationRewindFilePreview = {
  available: boolean
  filesChanged: number
  insertions: number
  deletions: number
}

type ConversationRewindScope =
  | 'conversation'
  | 'conversation-and-files'
```

Do not return file contents or renderer-authored paths. For `conversation-and-files`, invoke the strict file-history transaction against the sidecar's real `AppStateStore`. Before commit append begins, preflight, restoration, or replacement-persistence failure aborts the conversation edit and rolls back every still-owned path. A concurrent file modification is preserved and returned as `restoration_conflict`; it is never overwritten to manufacture an all-files rollback claim. After commit append begins, use terminal-state reconciliation and do not roll files back. Invalidate changed paths in `readFileState`.

## B8. Phase 3 — desktop protocol and sidecar boundary

**Files:** `app/shared/protocol.ts`, `app/sidecar/sidecarServer.ts`, `app/sidecar/sessionController.ts`, `app/sidecar/sessionActionsDomain.ts` (or a dedicated adjacent domain if cohesion requires it), `app/main/main.ts`, `app/preload/preload.ts`, plus boundary, source-guard, and hardening tests.

```ts
type ConversationRewindPreviewMessage = {
  type: 'conversation.rewind.preview'
  requestId: string
  operationId: string
  targetMessageUuid: string
}

type ConversationRewindPreviewFrame = {
  kind: 'conversation-rewind.preview'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  requestId: string
  operationId: string
  ok: boolean
  targetMessageUuid: string
  expectedHeadUuid?: string
  prompt?: EditablePrompt
  messagesRemoved?: number
  hasLaterNonSyntheticMessages?: boolean
  permissionMode?: PermissionMode
  fileChanges?: ConversationRewindFilePreview
  message: string
}
```

**The fixed preload preview method accepts the renderer-minted `operationId` and target UUID. Main adds the transport `requestId` before forwarding the request to the sidecar.**

Define a narrower canonical editable-prompt snapshot rather than exposing a broader engine prompt shape: it supports text and images already accepted by the desktop composer, **but no engine-owned objects**. Persisted collapsed paste metadata does not exist; return expanded text and test that no literal paste placeholder is introduced. Define `EditablePrompt` once as the existing bounded text/base64-image submit subset, canonical in the app-runtime contract and consumed by type-only import in the app wire contract; use it in preview result, renderer edit state, dedicated edited submit, and the QueryEngine edit API. Keep strict boundary-local schemas in the web and desktop sidecars, with the same text/image count and byte limits. Reject every other engine content-block variant.

**Edited submit gets its own verb.** Do not extend ordinary `app.submit.options`: main strips unknown options, the sidecar rejects unknown option keys, and the renderer cannot correlate the main-minted submit request ID.

```ts
type ConversationEditSubmitMessage = {
  type: 'conversation.edit.submit'
  requestId: string
  operationId: string
  targetMessageUuid: string
  expectedHeadUuid: string
  scope: ConversationRewindScope
  prompt: EditablePrompt
}
```

The renderer mints the bounded `operationId`; main continues to mint the transport `requestId`. Both are echoed on every success or rejection so late preview, applied, and error frames cannot consume a newer edit state. The dedicated verb must be intercepted as app-local vocabulary **before** the shared browser `app.submit` schema, so that schema is not widened accidentally.

After a valid `operationId` has been parsed, edit-specific rejection uses a bounded result frame carrying both IDs, a closed error code, retryability, and a redacted message. **A generic `ErrorFrame` alone is insufficient because the renderer cannot correlate its main-minted request ID. Malformed input rejected before a bounded operation ID can be established may use the ordinary transport error path.**

Closed edited-submit result codes: `stale_head`, `live_work`, `continuation_running`, `persistence_disabled`, `transaction_busy`, `restoration_conflict`, `durability_ambiguous`, `invalid_target`, `internal_error`. `durability_ambiguous` is neither success nor ordinary rejection: the renderer retains the pending draft, disables another submit for that session, and waits for reconciliation or reconnect.

**Expose a fixed preload method for this verb, not a generic sender. Add the required fixed-channel, sender, source-guard, boundary, and hardening coverage.** The replacement prompt remains the ordinary bounded prompt content inside one engine-side edit transaction.

**Applied result and replay ordering.**

```ts
type ConversationRewindAppliedFrame = {
  kind: 'conversation-rewind.applied'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  requestId: string
  operationId: string
  historyGeneration: number
  targetMessageUuid: string
  replacementMessageUuid: string
}

type TranscriptResetFrame = {
  kind: 'transcript-reset'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  historyGeneration: number
}
```

An edited turn starts with the ordinary optimistic prompt announcement disabled. After durable commit the sidecar emits, **in order**: (1) `conversation-rewind.applied`; (2) a canonical reset-and-replay of the active display chain, including the replacement user message; (3) later assistant, tool, and permission output.

**The applied frame and replay participate in normal sidecar/main buffering. A renderer reload may first receive old buffered frames, but the applied frame must reset them before the canonical replay, so it cannot resurrect the abandoned suffix.**

Build that replay through the same engine-seed plus archival-display pipeline used by `app/sidecar/index.ts`, including compact-boundary alignment and restored subagent history. Do not create a second mapper. Replace the sidecar's attach-time history source with the newly committed replay before assistant generation starts, so a later socket reattachment also receives the edited chain rather than the startup-era branch.

The current attach-time history is immutable and broadcasts are dropped when no connection exists. Make attach-time history mutable, track a monotonic `historyGeneration`, and add an **outbound-only** `transcript-reset` control frame carrying that generation. **Retain the last terminal edit outcome's operation and request correlation in memory and reconstruct it from transaction records on startup.** Every connection attach sends, **in order**: (1) ready and existing snapshots; (2) `transcript-reset` for the current generation; (3) the last matching applied or typed terminal-result frame, when one exists; (4) the current canonical history replay.

Both `transcript-reset` and `conversation-rewind.applied` reset projector and raw-log state unconditionally. Composer edit state clears only when an applied operation ID matches. A reconciled abort or conflict re-emits its typed result so an ambiguous pending draft can unlock without being discarded. This makes commit-with-zero-connections, restart reconciliation, and later reattachment safe.

**Boundary requirements.** Strict Zod schemas and strict-key checks; capped strings and arrays; bounded `operationId` correlated on every response; target validated against the live engine chain; renderer UUIDs treated only as selectors; prompt content, affected counts, permission mode, file snapshot, and head derived from engine state; stale heads rejected; inbound and outbound frame-size distinctions preserved; the existing rate limiter applied; outbound payloads through `secretGuard`; typed, redacted failures that never crash the connection. The protocol change is additive and should not require a version bump unless an existing shape must change incompatibly.

## B9. Phase 4 — renderer state and projection

**Files:** `app/renderer/src/App.tsx`, `app/renderer/src/composerState.ts`, `app/renderer/src/transcriptProjector.ts`, adjacent state and projection tests.

```ts
type MessageEditState = {
  targetMessageUuid: string
  expectedHeadUuid: string
  scope: ConversationRewindScope
  originalComposerDraft: ComposerDraft
  pendingReplacementDraft: ComposerDraft
  previewOperationId: string
  submitOperationId: string | null
}
```

Keyed by desktop session ID; switching tabs must not transfer an edit draft to another session.

Flow: invoke **Edit sent message**; if the row is a cached preview or parked session, restore it to engine-ready first, then request the authoritative sidecar preview (do not wait for a nonexistent replay-complete frame); enter edit mode directly only when the suffix is lossless **and** `fileChanges.available === true` with zero changed files (unavailable preview is not equivalent to zero changes); otherwise show a confirmation dialog offering **Edit conversation**, **Edit and restore files** (when a checkpoint exists), and **Cancel**; populate the composer from the sidecar-returned canonical prompt; display the banner `Editing an earlier message. Sending will discard later conversation.`; provide a visible **Cancel edit** action; on send include the target, expected head, and selected scope; retain the exact pending replacement text and images until the matching `operationId` is accepted; clear edit mode only after the matching applied frame; on stale-head, continuation, durability, or restoration failure retain the draft and show an actionable error; ignore late frames whose operation ID no longer owns the edit state.

`conversation-rewind.applied` must update the complete session projection and raw-message log, not only visible rows. The applied frame resets the addressed session's projector and raw-log state; the immediately following canonical active-chain replay rebuilds visible and hidden rows, seen frame IDs, message and content-block indexes, tool-use and tool-result correlations, streaming message state, grouped tool-run state, nested subagent joins, and selector caches tied to the old row slice.

Do not rebuild from the existing raw-message log: it is independently capped, retains the abandoned suffix, and ignores non-event control frames. Do not manually slice every derived map. **The sidecar's canonical reset-and-replay is the authoritative rebuild source.**

**Batch tests must prove applied-before-replay ordering in both the raw-log and transcript reducers. Tests must also prove that rewinding across tool calls does not leave completed results attached to removed cards, orphaned pending cards, removed subagent rows, stale streaming state, or duplicate-suppression entries that hide the replacement message. Cover an evicted raw-log target, hidden frames, tool-result-only frames, streams, nested agents, and applied-plus-replacement in one frame batch.**

## B10. Phase 5 — user-turn controls and confirmation UI

**Files:** `app/renderer/src/TranscriptView.tsx`, `app/renderer/src/TranscriptView.test.tsx`, existing modal primitives such as `app/renderer/src/SAModal.tsx`, and **existing theme styles only where required**.

One SDK user message can project into text and image rows: add a read-time user-turn grouping keyed by the engine frame UUID so one sent turn receives one action surface even when it contains multiple content blocks. Do not mutate stored projector rows to add UI state.

Every eligible top-level user turn exposes an edit button visible on hover **and** keyboard focus, an accessible name of **Edit sent message**, keyboard activation, and focus styling consistent with existing desktop controls. The control must not be hover-only: it becomes visible under `focus-within` and remains reachable in normal keyboard order. Image-only user turns must also be editable. Do not render the control on synthetic, task-notification, replay-only, hidden metadata, tool-result, or subagent user rows.

Edit activation on a restorable or parked row first restores the engine to ready. Tests must deliberately use different app-session and engine-session IDs: wire frames remain addressed by the app ID, while persisted-chain resolution and resume use the engine ID.

Do not immediately enable the disabled `Rewind…` item in `app/renderer/src/sessionActions.ts`. After edit-and-resend is complete, either rename it to **Edit earlier message…** and open the same eligible-message picker, or define and implement durable no-resubmit rewind semantics before keeping the `Rewind…` label. **A menu label must not promise standalone rewind while only edit-and-resend exists.** The per-message edit control is a real-added surface; it does not close or relabel the parity ledger's deferred standalone `RewindDialog` and picker rows without a separate operator-approved adaptation.

## B11. Tests

**Engine and app-runtime.** Previewing an eligible user message; rejecting unknown UUIDs; rejecting synthetic, metadata, tool-result, subagent, and task-notification messages; rejecting rewind during an active turn; rejecting rewind with a pending permission request; stale-head rejection; truncating immediately before the selected user message; permission-mode restoration; compact and context-derived state reset; preserving cumulative usage and cost **while resetting branch-derived state**; clearing or rebuilding read-file and nested-memory caches; rebuilding active `AppState.fileHistory` **from the retained chain**; abort or recovery when prepare, inactive replacement, or commit is not durable; durable active-chain reconstruction after resubmission; editing an operator message before a compact boundary; persistence-disabled rejection; deferred-continuation cancellation and running-attempt refusal; strict multi-file restoration rollback; sibling-leaf and edited-session Branch behavior; large-transcript transaction-aware pruning and fallback-head recovery; one replacement UUID in memory and JSONL with prompt processing run once; fault injection at every prepare/replacement/file/commit/fsync boundary.

The persistence regression: user A → assistant A → user B → assistant B → rewind to user B → submit edited B2 → reload from disk → verify the active chain is A, assistant A, B2 and excludes the abandoned B suffix. Repeat with user A before a compact boundary and user B after it, edit A to A2, restart, and verify both the display chain and the model seed follow the edited branch without reconnecting summarized history as live model context.

**Sidecar boundary.** Valid preview and edited submit; correlation by renderer-known operation ID; strict-key rejection; malformed, empty, and overlong UUIDs; stale target and stale head; attempts to target a non-user frame; conversation-only and conversation-and-files scopes; file-restoration failure preventing conversation rewind; outbound secret screening; frame ordering with the applied result before replacement message output; no assistant, tool, or permission frame before applied plus canonical replay; replay behavior after renderer reattachment; commit with zero connections followed by reset and canonical replay on attach; reversed preview-response order and cancel/re-enter ownership; persistence-disabled, deferred-continuation, durability, and transaction-latch failures; FIFO ordinary/edited admission across deferred-continuation awaits; live foreground-agent and background-shell refusal; different app-session and engine-session IDs.

**Renderer.** One edit control per multi-block user turn; no controls on ineligible rows; keyboard accessibility; direct edit for a lossless suffix; confirmation when later messages or files are affected; cancel preserving transcript and prior composer draft; successful application truncating all derived state; stale-head errors retaining the edited draft; every typed edited-submit failure retaining the exact pending replacement; session switching preserving per-session edit state; text and image restoration; expanded-text restoration for an originally collapsed paste; cached-preview and parked-session restore-to-ready behavior; applied-frame reset of both raw-log and transcript state; attach-time generation reset into a renderer that still holds the abandoned branch; durability-ambiguous state retaining the draft and blocking resubmit.

## B12. Delivery sequence

1. **Engine transaction prerequisites** — canonical persisted active-chain resolver; durable edited-input commit; strict file-history preflight/apply/rollback; human-takeover guard for desktop submits; cross-process engine-session mutation lock; transaction-aware resume/display/pruning owner; correct active-chain Branch behavior.
2. **Engine and app-runtime rewind seam** — QueryEngine preview and atomic edited-turn operations; controller guards, per-session transaction latch, and state reconstruction; single-pass edited-turn stream with committed-input callback; focused engine tests.
3. **Desktop sidecar and protocol boundary** — strict preview and dedicated edited-submit vocabulary; fixed preload sender and operation correlation; file-history integration; applied/reset/canonical-replay ordering; mutable generation-tagged attach history; boundary, replay, and two-ID tests.
4. **Renderer projection and composer state** — raw-log and projector reset/replay reducers; per-session edit state; restore-to-ready, late-response, failure, and cancel behavior.
5. **User interface** — user-turn grouping; accessible edit controls; confirmation dialog and edit banner.
6. **Integration and migration bookkeeping** — full engine and desktop batteries; exhaustiveness tripwire check; GUI acceptance; map, parity-ledger, and status updates.

## B13. Acceptance criteria

The feature is complete only when **all** of the following are true:

- An eligible sent user message can be selected from the desktop transcript and loaded into the composer.
- Canceling edit mode changes neither the active conversation nor persisted history.
- Sending an edited message discards the selected message and its dependent suffix from the active branch.
- Success is emitted only after the replacement and commit record pass the awaited flush, fsync, verification, and parent-directory-sync boundary.
- A readable commit encountered during a durability failure is irrevocable and enters typed reconciliation; it is never reported as an ordinary failed edit followed by file rollback.
- A stale conversation head fails closed without losing the edited draft.
- Every typed transaction failure preserves the exact edited draft.
- Optional file restoration reuses engine file-history formats through a strict, rollback-capable operation.
- Concurrent file writes are preserved and reported as typed conflicts; **rollback never overwrites externally changed content**.
- Reloading or resuming reconstructs the edited branch rather than the abandoned suffix.
- Messages before a compact boundary are editable through canonical persisted-chain reconstruction.
- Branching an edited or compacted session follows only the authoritative active chain.
- Renderer projection contains no stale tool, streaming, subagent, hidden-row, or deduplication state after rewind.
- The raw-message log and transcript projector reset from the same canonical replay.
- A reconnect resets stale projection state even if no client was attached when the edit committed.
- The sidecar strictly validates every new inbound shape and the hardening suite passes.
- The edit control is keyboard accessible **and available for** text, mixed-content, and image-only user turns.
- Cached-preview and parked sessions restore to ready before editing, without mixing app-session and engine-session IDs.
- Persistence-disabled sessions reject edit-and-resend explicitly.
- The full engine and desktop verification batteries pass.

---

# Section 3 — What the two parts actually share

The first draft of this report asserted four couplings between Part A and Part B. Adversarial review refuted or downgraded all four; they are recorded here with their refutations, because the temptation to re-assert them is the point.

**The one real shared fact.** Both parts operate on the same process-global command queue and the same `activeTurn` latch. The operational consequence is narrow and does not depend on Part A's findings: **any new turn-starting seam in `app/sidecar/sidecarServer.ts` must enumerate every existing turn-starter** — the queue-subscription drain (`:602`), the boundary drain (`:1286`), the finalizer re-schedule (`:1477`), and ordinary submit (`:1755`) — and state its relationship to each. Part B's admission latch is the mechanism; this is the checklist it must satisfy.

**Refuted 1 — "the edit latch must block the queued-prompt drain, and Part A proves the drain is reachable."** The requirement is right (B6 lists it) but the justification was wrong. `scheduleBoundaryDrain` defers through `queueMicrotask` (`:1262-1274`), and the finalizer sets `activeTurn = false` and schedules in the same synchronous body (`:1469-1478`), so the drain and its `startTurn` complete before any socket frame can be dispatched. A *deliverable* queued prompt also cannot survive into an idle window: the trust gate precedes enqueue, the park gate holds on it, and the finalizer microtask drains it. What **is** reachable during an edit's pre-commit awaits is an ordinary `handleSubmit` → `startTurn` (`:1755`) and the task-notification drain fed by the queue subscription (`:602`) — the queued-prompt drain only second-order, downstream of an unguarded ordinary submit.

**Refuted 2 — "D2 weakens Part B's `live_work` guard."** It does not: `hasQueuedParentPrompt` (`:1242-1244`) has exactly one consumer, `isParkGateOpen` (`:1864`). Part B's `live_work` guard reads the authoritative task domain (`app/sidecar/tasksDomain.ts:41`), which is structurally unrelated to the command queue. The park half of the claim is real and is already stated in D2 consequence 3.

**Downgraded 3 — "D1 and B10 want the same read-time concept."** They share only two pre-existing rules (read-time derivation, no post-hoc row mutation). B10's "about to be discarded" is derived entirely from renderer-local edit state and row order, with no new transport facts. D1's "sent, not yet delivered" is a fact only the sidecar can know and needs an outbound frame. Different problems; design them separately.

**Refuted 4 — "D5 and B9 want the same draft policy."** B9 can say "retain until the matching `operationId` is accepted" only because its verb carries a renderer-minted correlation ID echoed on every result. The ordinary submit path has no renderer-visible correlation and no success acknowledgement at all, so there is nothing to retain *until*. D5's fix is a different policy — optimistic clear with restore on typed error — as stated in A3.

---

# Verification

**What was actually run.** Part A changes no code; the docs battery for this file was:

```bash
git diff --check          # clean
bun run maps:lint         # 18 maps, 7 pre-existing warnings
```

**That battery is a formatting gate, not evidence for Part A.** `scripts/workspaceMapLint.ts:97,113` reads only `docs/maps/`, so the cited-path validation it performs never opens `docs/reports/`. For a document whose value is its `file:line` anchors, the evidence is anchor validity.

**Anchor evidence.** Every anchor in Part A was re-verified against current source after the first draft, through three independent adversarial passes (Part A refutation, Part B merge fidelity, Section 3 argument). That pass corrected six drifted anchors, refuted the four Section 3 couplings, found the stale "no consumption signal" premise, added D3 (slash commands) and the attachment half of D5, and reclassified D2 as a T7 bound bypass rather than only a message loss. Anything still resting on an exhaustive search finding nothing is labelled **(absence claim)** in place.

**Part B remains unbuilt.** Its battery:

```bash
bun test <focused engine and app-runtime test paths>
bun run build:dev:full
bun test app/
bun run --cwd app typecheck
bun run --cwd app typecheck:sidecar
bun run --cwd app test:hardening
bun run --cwd app renderer:build
```

Also: remove the new closed-union projector case temporarily and confirm the TypeScript exhaustiveness tripwire fails; search source, tests, maps, configuration, Markdown, and migration docs for stale claims that desktop rewind has no engine seam; update `docs/maps/web-app-runtime.md` if ownership routes change; update the relevant `docs/migration/PARITY-LEDGER.md` rows; update only the owning migration row in `docs/migration/STATUS.md`; and run operator-driven GUI acceptance for hover, keyboard focus, confirmation, cancellation, edited resend, file restoration, tab switching, and relaunch/resume behavior.

# Open questions

1. **Whether a mid-turn message should be retractable on the desktop at all.** A true retraction needs a new inbound dequeue verb, which is a security-baseline change. The display-only half — marking a row as sent-but-not-yet-delivered — needs only an outbound frame, since the consumption signal exists (D1). The operator call is therefore narrower than "build a recall or do nothing".
2. **Whether a slash command typed mid-turn on the desktop should run immediately, as it does in the terminal** (D3). Running it immediately means executing engine machinery while a turn holds the session; deferring it to a whole extra turn is the current behavior and is at least safe. This is a product decision, not a source question.
3. **How the depth-cap rejection should surface** (D5). Currently a generic error line. A composer-level failure that restores text and images depends on the draft-retention change, which must land first.

Two questions from the first draft are now answered and folded into the body: the **injection timing** relative to streamed output (the drained user message lands after the round's completed assistant text and all its tool results, before the next assistant message — `src/query.ts:1769-1791`, consumed at `:1832-1842`; on the desktop the row was already placed at enqueue time and the projector dedupes by frame ID, so the drain never moves or duplicates it), and **ESC precedence** in the terminal (deterministic inside one handler, D6).
